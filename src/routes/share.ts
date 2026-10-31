/**
 * 分享路由。对应 Cloudreve v4 `routers/router.go` 的 share 分组。
 *
 *   PUT    /api/v4/share            创建分享（响应 data 为分享 URL 字符串）
 *   POST   /api/v4/share/:id        编辑分享
 *   GET    /api/v4/share/info/:id   查询分享信息（密码通过 ?password= 传）
 *   GET    /api/v4/share            我的分享列表
 *   DELETE /api/v4/share/:id        删除分享
 *   DELETE /api/v4/share            批量删除（body: {ids: []}）
 *   POST   /api/v4/share/save/:id   转存（边缘版新增，见 README）
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { ShareService } from '../services/share';
import { FileSystemService } from '../services/fs';
import { Err } from '../lib/errors';

export const shareRoutes = new Hono<AppBindings>();

/**
 * OAuth scope 校验（对应上游分享写路由上的 `RequiresScopes(ScopeSharesWrite)`）：
 *   - 建/改/删分享 → `Shares.Write`
 *   - 转存（`/save/:id`）会写文件 → `Files.Write`
 *   - 购买付费分享（`/purchase/:id`）不碰分享本身，放行
 * 内置登录签发的 token 没有 scopes，不受影响。
 */
shareRoutes.use('*', async (c, next) => {
  const method = c.req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return next();
  const path = c.req.path.replace(/^\/api\/v4\/share/, '') || '/';
  if (path.startsWith('/purchase/')) return next();
  const ctx = ctxOf(c);
  // 举报不需要 Shares.Write（举报的是别人的分享）；仅需登录
  if (path.startsWith('/report/')) {
    if (!ctx.user) return fail(c, Err.loginRequired());
    return next();
  }
  if (path.startsWith('/save/')) {
    if (!ctx.hasScopes(['Files.Write'])) return fail(c, Err.scopeInsufficient('Files.Write'));
    return next();
  }
  if (!ctx.hasScopes(['Shares.Write'])) return fail(c, Err.scopeInsufficient('Shares.Write'));
  await next();
});

function buildService(c: AppRequest): ShareService {
  const ctx = ctxOf(c);
  return new ShareService(ctx, new FileSystemService(ctx));
}

/** 创建 */
shareRoutes.put('/', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const url = await buildService(c).create({
      uri: body.uri as string,
      is_private: body.is_private as boolean | undefined,
      password: body.password as string | undefined,
      downloads: body.downloads as number | undefined,
      expire: body.expire as number | undefined,
      share_view: body.share_view as boolean | undefined,
      show_readme: body.show_readme as boolean | undefined,
      score: body.score as number | undefined,
    });
    // 原版创建分享的 data 是字符串
    return ok(c, url);
  } catch (e) {
    return fail(c, e);
  }
});

/** 编辑 */
shareRoutes.post('/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const url = await buildService(c).edit(c.req.param('id'), {
      // 前端编辑分享时会带上源文件路径（createOrUpdateShareLink 的 req.uri），
      // 上游 EditShare 与创建共用校验、按 uri 重新解析源文件（operation.go:311）
      uri: (body.uri as string) ?? '',
      is_private: body.is_private as boolean | undefined,
      password: body.password as string | undefined,
      downloads: body.downloads as number | undefined,
      expire: body.expire as number | undefined,
      share_view: body.share_view as boolean | undefined,
      show_readme: body.show_readme as boolean | undefined,
      score: body.score as number | undefined,
    });
    return ok(c, url);
  } catch (e) {
    return fail(c, e);
  }
});

/** 分享信息（允许匿名；密码走 query） */
shareRoutes.get('/info/:id', async (c) => {
  try {
    const res = await buildService(c).info(c.req.param('id'), {
      password: c.req.query('password'),
      countViews: c.req.query('count_views') === 'true',
      ownerExtended: c.req.query('owner_extended') === 'true',
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

/** 购买付费分享（登录）。 */
shareRoutes.post('/purchase/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  try {
    await buildService(c).purchase(c.req.param('id'));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 我的分享 */
shareRoutes.get('/', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());

  const pageSizeRaw = Number(c.req.query('page_size') ?? 0);
  // 原版的 binding 要求 page_size 在 10~100 之间
  const pageSize = pageSizeRaw >= 10 && pageSizeRaw <= 100 ? pageSizeRaw : 20;

  try {
    const res = await buildService(c).list({
      ownerId: ctx.user.id,
      page: 0,
      pageSize,
      orderBy: c.req.query('order_by') ?? '',
      orderDirection: c.req.query('order_direction') ?? '',
      asOwner: true,
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

/** 批量删除（注意要放在 /:id 之前注册，否则会被参数路由吃掉） */
shareRoutes.delete('/', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { ids?: string[] };
  if (!body.ids?.length) return fail(c, Err.param('ids is required'));
  try {
    await buildService(c).batchDelete(body.ids);
    // 上游 4.16 起显式回一个空对象而不是省略 data（7a43005），前端按对象解构
    return ok(c, {});
  } catch (e) {
    return fail(c, e);
  }
});

/** 删除单个 */
shareRoutes.delete('/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  try {
    await buildService(c).delete(c.req.param('id'));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 转存到自己的网盘（边缘版新增；原版前端用「建符号文件」的方式实现） */
shareRoutes.post('/save/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { password?: string; dst?: string };
  if (!body.dst) return fail(c, Err.param('dst is required'));
  try {
    await buildService(c).saveToMyFiles(c.req.param('id'), body.password ?? '', body.dst);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 举报分享（edge 自建 Pro 功能）。需登录；同一用户对同一分享幂等。 */
shareRoutes.post('/report/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string; detail?: string };
  try {
    const res = await buildService(c).report(c.req.param('id'), body.reason ?? 'other', body.detail, ctx.user.id);
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});
