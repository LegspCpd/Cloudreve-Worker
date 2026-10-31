/**
 * 支付 / 增值服务（edge 自建 Pro 功能）。
 *
 * 商品与支付提供商配置都存在 settings 表的 JSON 键里（管理面板「增值服务」
 * 标签页编辑），由官方前端 SettingsWrapper 的通用保存链路落库：
 *
 *   payment          JSON  支付提供商列表 [{id,name,type,enabled,epay_url,pid,key,channel}]
 *   storage_products JSON  容量商品 [{id,name,price,unit,size,duration}]
 *   group_sell_data  JSON  用户组商品 [{id,name,price,unit,group_id,duration}]
 *   credit_products  JSON  积分商品 [{id,name,price,unit,credit}]
 *
 * 支付协议实现：易支付（Epay）——国内聚合支付事实标准，MD5 签名 +
 * 浏览器跳转 submit + 服务端异步 notify。签名规则（与 Epay 官方文档一致）：
 * 参数按名 ASCII 升序、排除 sign/sign_type/空值，拼 k1=v1&k2=v2，直接
 * 后接商户密钥（无 &），取 MD5 hex 小写。
 */
import type { AppContext } from './context';
import type { OrderRow, VasProductType } from '../db/types';
import { GiftCodeRepo, OrderRepo } from '../db/payment';
import { AppError, Err } from '../lib/errors';
import { md5 } from '../lib/md5';
import { randomString } from '../lib/crypto';
import { MailService } from './mail';
import { logAudit } from './audit';
import { walDone, walFail, walStart } from './wal';

// ---------------------------------------------------------------------------
// 配置（settings JSON 键）
// ---------------------------------------------------------------------------

export interface PaymentProviderConfig {
  id: string;
  name: string;
  type: 'epay';
  enabled: boolean;
  /** 易支付网关根地址，如 https://pay.example.com */
  epay_url: string;
  pid: string;
  key: string;
  /** 支付渠道：alipay / wxpay / qqpay */
  channel: string;
}

export interface StorageProduct {
  id: string;
  name: string;
  /** 单价，单位元（展示/下单货币由 currency_* 设置决定，金额统一存分） */
  price: number;
  /** 容量字节数 */
  size: number;
  /** 有效期天数，0 = 永久 */
  duration: number;
}

export interface GroupProduct {
  id: string;
  name: string;
  price: number;
  /** 目标用户组 ID（groups.id 数字） */
  group_id: number;
  duration: number;
}

export interface CreditProduct {
  id: string;
  name: string;
  price: number;
  credit: number;
}

/** 元 → 分（字符串金额容错解析）。 */
function yuanToFen(price: unknown): number {
  const n = Number(price ?? 0);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

export interface ShopConfig {
  providers: PaymentProviderConfig[];
  storage: StorageProduct[];
  group: GroupProduct[];
  credit: CreditProduct[];
  currency: { code: string; symbol: string; unit: number };
  creditEnabled: boolean;
}

function parseJsonArray<T>(raw: string | undefined | null): T[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class PaymentService {
  private readonly orders: OrderRepo;
  private readonly giftCodes: GiftCodeRepo;

  constructor(private readonly ctx: AppContext) {
    this.orders = new OrderRepo(ctx.env);
    this.giftCodes = new GiftCodeRepo(ctx.env);
  }

  /** 商店配置汇总（商店页与下单共用）。 */
  shopConfig(): ShopConfig {
    const s = this.ctx.settings;
    const providers = parseJsonArray<PaymentProviderConfig>(s.get('payment', '{}'))
      .filter((p) => p && p.enabled && p.type === 'epay' && p.epay_url && p.pid && p.key)
      .map((p) => ({ ...p, epay_url: p.epay_url.replace(/\/+$/, '') }));
    return {
      providers,
      storage: parseJsonArray<StorageProduct>(s.get('storage_products', '[]')),
      group: parseJsonArray<GroupProduct>(s.get('group_sell_data', '[]')),
      credit: parseJsonArray<CreditProduct>(s.get('credit_products', '[]')),
      currency: {
        code: s.get('currency_code', 'CNY'),
        symbol: s.get('currency_symbol', '¥'),
        unit: s.getInt('currency_unit', 100),
      },
      creditEnabled: s.getBool('credit_enabled', false),
    };
  }

  // -------------------------------------------------------------------------
  // 下单（易支付）
  // -------------------------------------------------------------------------

  /**
   * 创建订单并返回易支付跳转 URL。
   * 浏览器 302 到 payUrl 完成支付；异步通知与同步回跳都会触发履行（幂等）。
   */
  async createEpayOrder(args: {
    productType: VasProductType;
    productId: string;
    providerId: string;
    channel?: string;
  }): Promise<{ order_no: string; pay_url: string }> {
    const user = this.ctx.requireUser();
    const cfg = this.shopConfig();

    const provider = cfg.providers.find((p) => p.id === args.providerId);
    if (!provider) throw Err.param('Payment provider not found or not enabled');

    // 找商品并做快照
    let snapshot: Record<string, unknown>;
    let name: string;
    let priceFen: number;
    if (args.productType === 'storage') {
      const p = cfg.storage.find((x) => x.id === args.productId);
      if (!p) throw Err.param('Storage product not found');
      name = `容量包 - ${p.name}`;
      priceFen = yuanToFen(p.price);
      snapshot = { product_id: p.id, name: p.name, size: Number(p.size), duration: Number(p.duration) };
    } else if (args.productType === 'group') {
      const p = cfg.group.find((x) => x.id === args.productId);
      if (!p) throw Err.param('Group product not found');
      name = `用户组 - ${p.name}`;
      priceFen = yuanToFen(p.price);
      snapshot = { product_id: p.id, name: p.name, group_id: Number(p.group_id), duration: Number(p.duration) };
    } else {
      if (!cfg.creditEnabled) throw Err.param('Credit system is not enabled');
      const p = cfg.credit.find((x) => x.id === args.productId);
      if (!p) throw Err.param('Credit product not found');
      name = `积分 - ${p.name}`;
      priceFen = yuanToFen(p.price);
      snapshot = { product_id: p.id, name: p.name, credit: Number(p.credit) };
    }

    if (priceFen <= 0) throw Err.param('Invalid product price');

    const orderNo = `E${Date.now().toString(36).toUpperCase()}${randomString(6).toUpperCase()}`;
    await this.orders.create({
      user_id: user.id,
      order_no: orderNo,
      product_type: args.productType,
      product_snapshot: snapshot,
      amount: priceFen,
      provider: provider.id,
    });
    logAudit(this.ctx, 'payment_created', user.id, { order_no: orderNo, name, amount: priceFen });

    // 易支付 submit 参数（签名按名 ASCII 升序）
    const siteUrl = this.ctx.settings.siteUrl;
    const params: Record<string, string> = {
      pid: provider.pid,
      type: args.channel || provider.channel || 'alipay',
      out_trade_no: orderNo,
      notify_url: `${siteUrl}/api/v4/payment/notify/epay`,
      return_url: `${siteUrl}/shop?order_no=${orderNo}`,
      name,
      money: (priceFen / 100).toFixed(2),
    };
    const sign = epaySign(params, provider.key);
    const query = new URLSearchParams({ ...params, sign, sign_type: 'MD5' });
    return { order_no: orderNo, pay_url: `${provider.epay_url}/submit.php?${query.toString()}` };
  }

  /**
   * 易支付异步通知（notify_url，服务端 POST/GET）与同步回跳（return_url）
   * 共用的验证 + 履行入口。验证失败抛错；验证通过时幂等履行。
   * 返回是否成功处理（调用方决定响应 "success" 还是重定向）。
   */
  async handleEpayCallback(params: Record<string, string>): Promise<OrderRowPublic | null> {
    const cfg = this.shopConfig();
    // 用 pid 匹配提供商（一次易支付网关可能配多个站点）
    const provider = cfg.providers.find((p) => p.pid === params.pid) ??
      cfg.providers.find((p) => p.type === 'epay');
    if (!provider) throw new AppError(40019, 'No epay provider configured');

    // 验签
    const expected = epaySign(params, provider.key);
    const got = params.sign ?? '';
    if (!got || expected.toLowerCase() !== got.toLowerCase()) {
      throw new AppError(40019, 'Invalid payment signature');
    }

    const orderNo = params.out_trade_no ?? '';
    const order = await this.orders.byOrderNo(orderNo);
    if (!order) throw Err.userNotFound();

    // 已履行过的直接返回（return 与 notify 双通道幂等）
    if (order.status === 'fulfilled' || order.status === 'paid') return orderPublic(order);

    if ((params.trade_status ?? '') !== 'TRADE_SUCCESS') {
      return orderPublic(order); // 未支付成功（如退款/关闭），保持 pending
    }

    // 实付金额必须与订单金额一致。签名虽然覆盖了 money，但这里防的是
    // 「网关侧改价 / 订单与回调串号」这类不一致 —— 钱对不上就不该发货。
    if (params.money !== undefined && params.money !== '') {
      const paidFen = Math.round(Number(params.money) * 100);
      if (!Number.isFinite(paidFen) || paidFen !== Number(order.amount)) {
        logAudit(this.ctx, 'payment_fulfill_failed', order.user_id, {
          order_no: order.order_no,
          error: `amount mismatch: order ${order.amount} fen, paid ${params.money} yuan`,
        });
        throw new AppError(
          40019,
          `Paid amount mismatch: order ${order.amount} fen, callback ${params.money} yuan`,
        );
      }
    }

    // 原子抢占 pending → paid；抢不到说明另一个回调正在履行
    const claimed = await this.orders.markPaid(order.order_no, params.trade_no ?? null);
    if (!claimed) {
      const latest = await this.orders.byOrderNo(order.order_no);
      return orderPublic(latest ?? order);
    }

    // WAL：记下「开始履行这笔订单」。若下面中途失败或进程被杀，这条
    // pending 记录会留在独立于业务库的 KV 上，事后可查「哪笔没走完」。
    // 这是本函数最脆弱的一段 —— 钱已经收了，履行却可能只做了一半。
    const wal = await walStart(this.ctx.env, 'payment.fulfill', claimed.order_no, {
      userId: claimed.user_id,
      productType: claimed.product_type,
    });

    try {
      await this.fulfill(claimed.user_id, claimed.product_type, claimed.product_snapshot ?? {});
      await this.orders.markFulfilled(claimed.id);
      logAudit(this.ctx, 'payment_paid', claimed.user_id, { order_no: claimed.order_no });
      logAudit(this.ctx, 'payment_fulfilled', claimed.user_id, { order_no: claimed.order_no });
      // 履行成功 → 撤掉 WAL（只留没走完的，成功的留着会淹没真正要关注的）
      await walDone(this.ctx.env, wal);
      // 支付收据邮件（原版 Pro 的 mail_receipt_template）：履行成功后发送，
      // 失败不影响订单状态。走 waitUntil，不阻塞回调响应。
      this.sendReceiptMail(claimed);
    } catch (e) {
      // 履行失败：订单留在 paid 态（钱已收），错误信息入库供管理员排查
      const msg = e instanceof Error ? e.message : String(e);
      await this.orders.markFailed(claimed.id, `fulfill failed after paid: ${msg}`);
      await walFail(this.ctx.env, wal, 'payment.fulfill', claimed.order_no, e);
      logAudit(this.ctx, 'payment_fulfill_failed', claimed.user_id, {
        order_no: claimed.order_no,
        error: msg,
      });
      throw e;
    }
    const done = await this.orders.byOrderNo(order.order_no);
    return orderPublic(done ?? order);
  }

  // -------------------------------------------------------------------------
  // 履行（订单与礼品卡共用）
  // -------------------------------------------------------------------------

  /**
   * 发送支付收据邮件（`mail_receipt_template`）。fire-and-forget：
   * 邮件失败只记不抛 —— 钱已收、货已发，收据发不出去不该让回调报错。
   */
  private sendReceiptMail(order: OrderRow): void {
    const deliver = (async () => {
      const mail = new MailService(this.ctx);
      if (!mail.available) return;
      const user = await this.ctx.users.byId(order.user_id);
      if (!user) return;
      await mail.sendReceiptEmail(user, {
        orderNo: order.order_no,
        productName: String(order.product_snapshot?.name ?? order.product_type),
        productType: order.product_type,
        amountFen: Number(order.amount ?? 0),
        tradeNo: order.provider_trade_no,
        paidAt: order.paid_at,
      });
    })();
    const run = deliver.catch(() => undefined);
    if (this.ctx.waitUntil) this.ctx.waitUntil(run);
  }

  /**
   * 把商品落到用户身上。全部写 users.settings JSONB，读侧惰性判过期：
   *   storage → settings.quota_packs 追加 {size, expire_at}
   *   group   → settings.group_pack = {group_id, prev_group_id, expire_at}
   *   credit  → settings.credit += credit
   */
  async fulfill(userId: number, productType: VasProductType, snapshot: Record<string, unknown>): Promise<void> {
    const users = this.ctx.users;
    const user = await users.byId(userId);
    if (!user) throw Err.userNotFound();
    const now = Date.now();

    if (productType === 'storage') {
      const size = Math.max(0, Number(snapshot.size ?? 0));
      if (!size) throw Err.param('Invalid storage size');
      const duration = Number(snapshot.duration ?? 0);
      const expireAt = duration > 0 ? new Date(now + duration * 86400000).toISOString() : null;
      // 原子追加：并发兑换两张礼品卡时，旧的「读整份 settings → 改 → 整行覆盖写」
      // 会让第二笔覆盖第一笔，用户付了钱却丢包。这里走 JSONB 数组追加，天然幂等。
      await this.ctx.users.addQuotaPack(userId, { size, expire_at: expireAt });
      logAudit(this.ctx, 'storage_added', userId, { size });
      return;
    }

    if (productType === 'group') {
      const groupId = Number(snapshot.group_id ?? 0);
      if (!groupId) throw Err.param('Invalid group id');
      const group = await this.ctx.groups.byId(groupId);
      if (!group) throw Err.param('Target group not found');
      const duration = Number(snapshot.duration ?? 0);
      const expireAt = duration > 0 ? new Date(now + duration * 86400000).toISOString() : null;
      // 一条语句同时写 settings.group_pack 与 group_users：既不会抹掉并发的
      // 容量包/积分（原来整行覆盖 settings 会），也不会出现「记了组却没切组」。
      // prev_group_id 由 SQL 从旧值里取，续费不丢最初组。
      await users.applyGroupPack(userId, groupId, expireAt);
      logAudit(this.ctx, 'group_changed', userId, { group_id: groupId });
      return;
    }

    // credit：同样必须原子累加（见上 storage 分支的并发覆盖说明）
    const credit = Math.max(0, Number(snapshot.credit ?? 0));
    if (!credit) throw Err.param('Invalid credit amount');
    await this.ctx.users.adjustCredit(userId, credit);
    logAudit(this.ctx, 'points_change', userId, { credit, reason: 'purchase' });
  }

  // -------------------------------------------------------------------------
  // 礼品卡
  // -------------------------------------------------------------------------

  /** 用户兑换礼品卡。成功返回商品摘要。 */
  async redeemGiftCode(code: string): Promise<{ product_type: VasProductType; name: string }> {
    const user = this.ctx.requireUser();
    const clean = code.trim().toUpperCase();
    if (!clean) throw Err.param('Gift code is required');

    // 先原子占卡，再履行；履行失败则把卡退回（未使用），保证不吞卡
    const claimed = await this.giftCodes.redeem(clean, user.id);
    if (!claimed) throw new AppError(40056, 'Gift code not found or already used');
    logAudit(this.ctx, 'redeem_gift_code', user.id, { code: clean, product_type: claimed.product_type });

    try {
      await this.fulfill(user.id, claimed.product_type, claimed.product_payload ?? {});
    } catch (e) {
      // 履行失败把卡退回可用状态（清 used_by）。原来走 remove + create：
      // remove 只删未使用的卡（此刻已标记使用，删不掉），create 会撞 code
      // 唯一索引，两步都静默失败 → 用户的卡被吞掉。
      await this.giftCodes.revert(claimed.id).catch(() => undefined);
      throw e;
    }
    return {
      product_type: claimed.product_type,
      name: String((claimed.product_payload ?? {}).name ?? claimed.product_type),
    };
  }

  /** 管理员批量生成礼品卡。 */
  async generateGiftCodes(args: {
    count: number;
    product_type: VasProductType;
    payload: Record<string, unknown>;
  }): Promise<string[]> {
    const count = Math.min(Math.max(1, args.count), 200);
    const batch = `B${Date.now().toString(36).toUpperCase()}`;
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = `GC${randomString(16).toUpperCase()}`;
      await this.giftCodes.create({
        code,
        product_type: args.product_type,
        product_payload: args.payload,
        batch,
      });
      codes.push(code);
    }
    return codes;
  }
}

/** 路由层返回给前端的订单形状。 */
export interface OrderRowPublic {
  id: number;
  order_no: string;
  product_type: VasProductType;
  product_name: string;
  amount: number;
  status: string;
  created_at: string;
  paid_at: string | null;
}

export function orderPublic(o: {
  id: number;
  order_no: string;
  product_type: VasProductType;
  product_snapshot: Record<string, unknown> | null;
  amount: number;
  status: string;
  created_at: Date;
  paid_at: Date | null;
}): OrderRowPublic {
  return {
    id: o.id,
    order_no: o.order_no,
    product_type: o.product_type,
    product_name: String(o.product_snapshot?.name ?? ''),
    amount: o.amount,
    status: o.status,
    created_at: o.created_at.toISOString(),
    paid_at: o.paid_at ? o.paid_at.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// 易支付签名
// ---------------------------------------------------------------------------

/**
 * 易支付 MD5 签名：参数按名 ASCII 升序、排除 sign/sign_type/空值，
 * 拼 `k1=v1&k2=v2` 后直接接商户密钥（无 &），MD5 hex 小写。
 */
export function epaySign(params: Record<string, string>, key: string): string {
  const sorted = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined)
    .sort();
  const query = sorted.map((k) => `${k}=${params[k]}`).join('&');
  return md5(query + key);
}
