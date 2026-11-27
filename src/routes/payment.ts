/**
 * 支付 / 增值服务路由（edge 自建 Pro 功能）。
 *
 *   GET    /api/v4/payment/shop            商店配置（登录）
 *   POST   /api/v4/payment/order           下单（登录），返回支付跳转 URL
 *   GET    /api/v4/payment/order           我的订单（登录，分页）
 *   GET    /api/v4/payment/order/:no       订单状态（登录，支付回跳后轮询用）
 *   POST   /api/v4/payment/redeem          兑换礼品卡（登录）
 *   GET    /api/v4/payment/notify/epay     易支付异步通知（公开，验签）
 *   POST   /api/v4/payment/notify/epay     同上（POST 形态）
 *   GET    /api/v4/payment/return/epay     易支付同步回跳（公开，验签后 302 商店页）
 *   GET    /api/v4/payment/admin/order     管理端订单列表（管理员）
 *   GET    /api/v4/payment/admin/giftcode  管理端礼品卡列表（管理员）
 *   POST   /api/v4/payment/admin/giftcode  管理端批量生成礼品卡（管理员）
 *   DELETE /api/v4/payment/admin/giftcode/:id（管理员）
 *
 * 通知/回跳端点是给支付网关调的，不能要求登录，安全性由 MD5 验签保证；
 * 两个公开端点必须保持挂在 /api/* 下（run_worker_first 名单已覆盖）。
 */
import { Hono } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { Err } from '../lib/errors';
import { readBodyLimited, readJsonLimited } from '../lib/bodyLimit';
import { PaymentService, orderPublic } from '../services/payment';
import type { VasProductType } from '../db/types';

export const paymentRoutes = new Hono<AppBindings>();
export const paymentAdminRoutes = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// 用户端
// ---------------------------------------------------------------------------

/** 商店配置 + 当前用户积分。 */
paymentRoutes.get('/shop', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const svc = new PaymentService(ctx);
  const cfg = svc.shopConfig();
  // 组商品附带组名，前端展示用
  const groupNames = new Map<number, string>();
  for (const p of cfg.group) {
    if (!groupNames.has(p.group_id)) {
      const g = await ctx.groups.byId(p.group_id);
      if (g) groupNames.set(p.group_id, g.name);
    }
  }
  return ok(c, {
    providers: cfg.providers.map((p) => ({ id: p.id, name: p.name, type: p.type, channel: p.channel })),
    storage_products: cfg.storage,
    group_products: cfg.group.map((p) => ({ ...p, group_name: groupNames.get(p.group_id) ?? '' })),
    credit_products: cfg.credit,
    currency: cfg.currency,
    credit_enabled: cfg.creditEnabled,
    credit: Number(ctx.user.settings?.credit ?? 0),
  }) as never;
});

/** 下单。 */
paymentRoutes.post('/order', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    product_type?: string;
    product_id?: string;
    provider_id?: string;
    channel?: string;
  };
  if (!body.product_type || !body.product_id || !body.provider_id) {
    return fail(c, Err.param('product_type, product_id and provider_id are required'));
  }
  const type = body.product_type as VasProductType;
  if (!['storage', 'group', 'credit'].includes(type)) {
    return fail(c, Err.param('Invalid product_type'));
  }
  try {
    const res = await new PaymentService(ctx).createEpayOrder({
      productType: type,
      productId: body.product_id!,
      providerId: body.provider_id!,
      channel: body.channel,
    });
    return ok(c, res) as never;
  } catch (e) {
    return fail(c, e);
  }
});

/** 我的订单（分页）。 */
paymentRoutes.get('/order', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const pageSize = Math.min(50, Math.max(1, Number(c.req.query('page_size') ?? '10') || 10));
  const { OrderRepo } = await import('../db/payment');
  const repo = new OrderRepo(ctx.env);
  const { items, total } = await repo.listByUser(ctx.user.id, page, pageSize);
  return ok(c, {
    orders: items.map(orderPublic),
    pagination: { page: page - 1, pageSize, total },
  }) as never;
});

/** 订单状态（回跳后轮询）。 */
paymentRoutes.get('/order/:orderNo', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const { OrderRepo } = await import('../db/payment');
  const order = await new OrderRepo(ctx.env).byOrderNo(c.req.param('orderNo'));
  if (!order || order.user_id !== ctx.user.id) return fail(c, Err.userNotFound());
  return ok(c, orderPublic(order)) as never;
});

/** 兑换礼品卡。 */
paymentRoutes.post('/redeem', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  try {
    const res = await new PaymentService(ctx).redeemGiftCode(body.code ?? '');
    return ok(c, res) as never;
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 易支付公开回调（验签保护）
// ---------------------------------------------------------------------------

/**
 * 从 GET query 或 POST form/JSON 里归并参数。
 *
 * 这是公开回调，body 由支付网关（也可能由攻击者）控制，且验签在
 * handleEpayCallback 里、读正文之后 —— 和上游 c5cd939d 的 OSS 回调同一
 * 攻击模型：验签失败的请求同样会先把 body 读完。所以先在受限字节上
 * 解析，64KB 对齐上游 MaxCallbackBodySize，超限在验签前就回 413。
 */
const CALLBACK_BODY_LIMIT = 64 * 1024;

async function collectParams(c: import('hono').Context): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) out[k] = v;
  const ct = c.req.header('Content-Type') ?? '';
  if (ct.includes('application/x-www-form-urlencoded')) {
    const text = await readBodyLimited(c.req.raw, CALLBACK_BODY_LIMIT);
    const form = new URLSearchParams(text);
    for (const [k, v] of form) out[k] = v;
  } else if (ct.includes('application/json')) {
    const json = await readJsonLimited<Record<string, unknown>>(c.req.raw, CALLBACK_BODY_LIMIT);
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

const notifyHandler = async (c: import('hono').Context<AppBindings>) => {
  const ctx = ctxOf(c);
  const params = await collectParams(c);
  try {
    const order = await new PaymentService(ctx).handleEpayCallback(params);
    // 易支付约定：处理成功必须原样响应 "success"（纯文本），否则网关会重试
    return c.text(order ? 'success' : 'fail');
  } catch {
    return c.text('fail');
  }
};

paymentRoutes.get('/notify/epay', notifyHandler as never);
paymentRoutes.post('/notify/epay', notifyHandler as never);

/** 同步回跳：验签并尝试履行（notify 不可达时兜底），然后 302 回商店页。 */
paymentRoutes.get('/return/epay', async (c) => {
  const ctx = ctxOf(c);
  const params = await collectParams(c);
  try {
    await new PaymentService(ctx).handleEpayCallback(params);
  } catch {
    // 验签失败也照常回商店页，商店页会按订单号轮询真实状态
  }
  const orderNo = encodeURIComponent(params.out_trade_no ?? '');
  return c.redirect(`/shop?order_no=${orderNo}`, 302);
});

// ---------------------------------------------------------------------------
// 管理端（ctx.isAdmin 闸门）
// ---------------------------------------------------------------------------

paymentAdminRoutes.use('*', async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  if (!ctx.isAdmin) return fail(c, Err.adminRequired());
  // 与管理端一致：读要 Admin.Read，生成礼品卡这类写操作要 Admin.Write。
  if (!ctx.hasScopes(['Admin.Read'])) return fail(c, Err.scopeInsufficient('Admin.Read'));
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !ctx.hasScopes(['Admin.Write'])) {
    return fail(c, Err.scopeInsufficient('Admin.Write'));
  }
  await next();
});

paymentAdminRoutes.get('/order', async (c) => {
  const ctx = ctxOf(c);
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size') ?? '20') || 20));
  const { OrderRepo } = await import('../db/payment');
  const { items, total } = await new OrderRepo(ctx.env).list(page, pageSize);
  return ok(c, {
    orders: items.map(orderPublic),
    pagination: { page: page - 1, pageSize, total },
  }) as never;
});

paymentAdminRoutes.get('/giftcode', async (c) => {
  const ctx = ctxOf(c);
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size') ?? '20') || 20));
  const { GiftCodeRepo } = await import('../db/payment');
  const { items, total } = await new GiftCodeRepo(ctx.env).list(page, pageSize);
  return ok(c, {
    gift_codes: items,
    pagination: { page: page - 1, pageSize, total },
  }) as never;
});

paymentAdminRoutes.post('/giftcode', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    count?: number;
    product_type?: string;
    size?: number;
    duration?: number;
    group_id?: number;
    credit?: number;
    name?: string;
  };
  const type = body.product_type as VasProductType;
  if (!['storage', 'group', 'credit'].includes(type)) {
    return fail(c, Err.param('Invalid product_type'));
  }
  let payload: Record<string, unknown>;
  if (type === 'storage') {
    if (!Number(body.size)) return fail(c, Err.param('size is required'));
    payload = { name: body.name ?? '礼品卡容量', size: Number(body.size), duration: Number(body.duration ?? 0) };
  } else if (type === 'group') {
    if (!Number(body.group_id)) return fail(c, Err.param('group_id is required'));
    payload = { name: body.name ?? '礼品卡用户组', group_id: Number(body.group_id), duration: Number(body.duration ?? 0) };
  } else {
    if (!Number(body.credit)) return fail(c, Err.param('credit is required'));
    payload = { name: body.name ?? '礼品卡积分', credit: Number(body.credit) };
  }
  try {
    const codes = await new PaymentService(ctx).generateGiftCodes({
      count: Number(body.count ?? 1),
      product_type: type,
      payload,
    });
    return ok(c, { codes }) as never;
  } catch (e) {
    return fail(c, e);
  }
});

paymentAdminRoutes.delete('/giftcode/:id', async (c) => {
  const ctx = ctxOf(c);
  const { GiftCodeRepo } = await import('../db/payment');
  await new GiftCodeRepo(ctx.env).remove(Number(c.req.param('id')));
  return ok(c, {}) as never;
});
