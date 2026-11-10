/**
 * 公共匿名 GET 接口的边缘缓存（CF Cache API，跨 isolate 共享）。
 *
 * 首屏要打几个 site/config/* 与 ping，它们用户无关、几乎不变，但每个请求
 * 都会落入 appContext → loadSettings 付一次 KV 读。低流量站点 isolate 频繁
 * 轮换，isolate 级内存缓存不生效，等于每个请求都打 KV（~0.5s）。这些接口用
 * CF 边缘缓存后：首次请求回源写缓存，之后同一边缘数据中心的所有 isolate
 * （轮换也没关系，Cache API 是数据中心级、跨 isolate 共享）直接命中，跳过
 * KV 与冷启动。
 *
 * - 前置 cachePublicAnon()：命中即短路返回、跳过 appContext。
 * - 后置 cachePublicAnonStore()：miss 时把 200 响应写回缓存（60s）。
 *
 * 只缓三类「匿名且与人无关」的 GET：ping、site/config/*、匿名分享目录列表。
 * 都要求请求不带 Authorization，所以不存在跨用户串号。TTL 60s。
 * 分享列表额外把「分享版本号」并进缓存键：撤销分享时 bump 一次，旧缓存立刻
 * 失效，不会出现「撤销后 60 秒内还能看到目录并签出直链」。
 */
import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { edgeCacheMatch, edgeCachePutAwait, withHeaders } from '../lib/edgeCache';
import { getShareEpoch } from '../lib/edgeCacheAuth';

type Bindings = { Bindings: Env };

/** 分享目录列表这条路径（`GET /api/v4/file?uri=…@share`）。 */
const SHARE_LIST_PATH = '/api/v4/file';

function isCacheable(c: Context<Bindings>): boolean {
  if (c.req.method !== 'GET') return false;
  const p = c.req.path;
  // 站点配置里含登录态用户的私有信息（email/组权限/容量/个人设置），绝不能
  // 进跨用户的 public 边缘缓存，否则用户 A 的隐私会被用户 B 命中、登录/匿名
  // 态也会互相错乱。只缓存匿名版（未带 Authorization）；登录版由 cacheAuthed
  // 或回源处理。
  if (CONFIG_RE.test(p)) return !c.req.header('Authorization');
  // 匿名访问分享目录：`GET /file?uri=cloudreve://<share>@share/...`。
  // 这是分享页的主请求，内部要 6~7 次跨区数据库往返（边缘在港、库在新加坡），
  // 实测 3.3s；而匿名访客拿到的内容与人无关（属主自己看会带 Authorization，
  // 走 cacheAuthed 那条路），可以安全地按 URL 缓存十几秒。
  if (p === '/api/v4/file') {
    if (c.req.header('Authorization')) return false;
    const uri = c.req.query('uri') ?? '';
    return uri.includes('@share');
  }
  // 其余（ping）仅匿名：带登录态的请求交给 cacheAuthed 处理用户相关端点。
  if (c.req.header('Authorization')) return false;
  return PING_RE.test(p);
}

/**
 * 各类响应的缓存时长（秒）。
 *
 * 分享目录列表 60s：内容只在属主上传/删除时变，属主自己看分享会带
 * Authorization（走另一条路，不吃这份缓存），所以访客看到几十秒前的目录
 * 完全可接受；换成 10s 的话命中率太低，等于白缓存。
 */
function ttlOf(c: Context<Bindings>): number {
  return 60;
}

const CONFIG_RE = /^\/api\/v4\/site\/config\//;
const PING_RE = /^\/api\/v4\/site\/ping$/;

/**
 * 缓存键：路径 + 请求的 Origin。
 *
 * 响应里带着按来源算出来的 `Access-Control-Allow-Origin`，而且我们用
 * 去掉 `Vary` 的方式存（否则 CF 的 match 永远对不上）。把 Origin 并进键里，
 * 不同来源各存一份，避免 A 来源的 ACAO 被 B 来源命中（桌面客户端、
 * 第三方页面都是跨源的）。
 */
function cacheKeyOf(c: Context<Bindings>, shareEpoch: string): string {
  const origin = c.req.header('Origin');
  // 带上 query：分享目录列表靠 uri/page/order 区分，不带就串号了
  const query = new URL(c.req.url).search;
  return `${c.req.path}${query}${origin ? `|o=${origin}` : ''}${shareEpoch !== '0' ? `|s=${shareEpoch}` : ''}`;
}

/**
 * 「分享版本号」只在**分享目录列表**这条路径上读。
 *
 * 站点配置与 ping 跟分享撤销无关，没必要为它们多付一次 KV 读。
 */
async function shareEpochFor(c: Context<Bindings>): Promise<string> {
  if (c.req.path !== SHARE_LIST_PATH) return '0';
  return getShareEpoch(c.env);
}

/** 前置：命中边缘缓存则直接返回，跳过 appContext（省 KV / 冷启动）。 */
export function cachePublicAnon(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    if (!isCacheable(c)) return next();
    const origin = new URL(c.req.url).origin;
    const hit = await edgeCacheMatch(origin, cacheKeyOf(c, await shareEpochFor(c)));
    if (hit) {
      const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
      // 只读头，必须复制后才改
      return withHeaders(hit, { 'X-Correlation-ID': correlationId, 'X-Edge-Cache': 'hit' });
    }
    return next();
  };
}

/** 后置：miss 时把 200 响应写回边缘缓存（60s，尽力而为）。 */
export function cachePublicAnonStore(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200 || !isCacheable(c)) return;
    // 业务错误也是 HTTP 200 + {code:非0}，写进公共缓存会把一次回源故障
    // 广播给所有匿名访客 60 秒（cacheAuthed 已有同样的 code===0 检查）。
    try {
      const j = (await res.clone().json()) as { code?: number };
      if (j.code !== 0) return;
    } catch {
      return;
    }
    const origin = new URL(c.req.url).origin;
    // 这里刻意 await 而不是丢给 waitUntil：写缓存只多 1~3ms，而 waitUntil 一旦
    // 拿不到绑定好的方法就会静默丢写（缓存命中率恒 0，外部毫无迹象）。
    // 结果写进响应头，线上可以直接看出「存了没有、失败在哪一步」。
    const result = await edgeCachePutAwait(
      origin,
      cacheKeyOf(c, await shareEpochFor(c)),
      res,
      ttlOf(c),
    );
    if (res.body && !res.bodyUsed) {
      const headers = new Headers(res.headers);
      headers.set('X-Edge-Cache', result);
      c.res = new Response(res.body, { status: res.status, headers });
    }
  };
}
