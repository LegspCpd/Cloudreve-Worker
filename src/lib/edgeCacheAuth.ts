/**
 * 登录态 GET 接口的边缘缓存（CF Cache API，跨 isolate 共享）。
 *
 * ## 动机
 * 首屏登录后每个请求都要走 `appContext`：`loadSettings` 的 KV 读 →
 * `resolveUser` → 业务查询。`GET /api/v4/file`（列目录）是首屏必调热点，一次
 * 要打 ~5 次数据库往返；`/api/v4/user/me` 也每次必调。这些响应用户相关但
 * 「读多写少」，用边缘缓存后：命中即短路返回、跳过整个 `appContext`
 * （省 KV + DB），同数据中心内 isolate 轮换也共享同一份。
 *
 * ## 与 `cachePublicAnon`（匿名 ping / site/config）的关系
 *  - `cachePublicAnon` 只管**公开、与用户无关**的数据（ping + site/config），
 *    且不接受带 `Authorization` 的请求。本模块管**用户相关**的只读端点。
 *  - 键里带「登录态指纹」=`Authorization` 头的 SHA-256：只有拿到同一份
 *    token 的人才能算出同一把键；攻击者没有别人的 token 就算不出别人的键，
 *    **不会越权读到别人的缓存**。伪造 token（改 `sub`）算出的哈希不同 →
 *    必然 miss → 落到 `appContext` 被验签拒掉，不会命中别人的缓存。
 *
 * ## 正确性：写即失效
 *  每次成功的非 GET 登录态请求都会 bump 该用户的 `epoch`（存在 KV，跨
 *  isolate 可见）。缓存键带 epoch，所以一次写之后，旧缓存下一读就 miss、
 *  重新回源，做到同数据中心近实时失效。最坏情况（KV 跨区传播延迟）由 TTL
 *  兜底。epoch 设了 1h TTL，避免失效 token 的键无限堆积。
 *
 * ## 安全：客户端缓存
 *  响应回给浏览器时改写为 `private` + `stale-while-revalidate`，禁止共享
 *  代理缓存用户数据；`private` 只让浏览器在本人机器上做 SWR 加速。
 */
import type { Context } from 'hono';
import type { Env } from '../env';
import { edgeCacheMatch, edgeCachePut } from './edgeCache';
import { kvFor } from './kvRouter';
import { coloCacheDelete, coloCacheGetJson, coloCachePutJson } from './coloCache';

/** 缓存命名空间版本：响应结构破坏性变更时手动 +1，使所有旧键失效。 */
const EDGE_AUTH_CACHE_VER = 'v1';

/** 登录态指纹：Authorization 头的 SHA-256（永不存储原始 token）。 */
export async function authHash(header: string): Promise<string> {
  const data = new TextEncoder().encode(header);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

const EPOCH_MEMO = new Map<string, { v: string; t: number }>();
const EPOCH_MEMO_TTL_MS = 2000;
/**
 * epoch 的 colo 层：与用户缓存同理，低流量站点每请求都是新 isolate，2s 的
 * 进程内 memo 几乎不命中 → 每个首页 GET 都打一次远端 KV。这里加一层同 colo
 * 跨 isolate 的 Cache API，命中 1~3ms。写操作 bump 时同步删本 colo 的键，
 * 保证同 colo 下一次读立刻失效；跨 colo 靠 KV 传播 + TTL 兜底。
 *
 * TTL 可以放长：epoch 只是「缓存键的一部分」，即使别的 colo 拿着旧 epoch，
 * 它缓存的那条响应本身也有 max-age（`/me` 30s、`GET /file` 8s），
 * 所以真正的陈旧上限由那两处决定，跟这里的 TTL 无关。
 */
const EPOCH_COLO_TTL_S = 300;

function deployKey(env: Env): string {
  // 用 JWT 密钥前缀区分不同部署，避免跨部署串缓存。
  return (env.JWT_SECRET ?? '').slice(0, 8) || 'dev';
}

/**
 * epoch 的键用 user id，不用 token hash。
 *
 * 读缓存的键仍按 token hash 隔离（不同 token 不串），但「失效版本号」必须按
 * 用户：S3/OSS/COS 等直传的完成回调是 GET、且没有用户 Authorization，拿不到
 * token hash；只有 user id 能在上传收尾里确定地 bump。一个用户换 token 后，
 * 按 user id 的 epoch 也能让旧 token 的缓存一起失效。
 */
function epochColoKey(env: Env, uid: string): string {
  return `epoch:${deployKey(env)}:u:${uid}`;
}

export async function getAuthEpoch(env: Env, uid: string): Promise<string> {
  const memoKey = `${deployKey(env)}:u:${uid}`;
  const now = Date.now();
  const cached = EPOCH_MEMO.get(memoKey);
  if (cached && now - cached.t < EPOCH_MEMO_TTL_MS) return cached.v;

  const coloHit = await coloCacheGetJson<string>(epochColoKey(env, uid), EPOCH_COLO_TTL_S);
  if (coloHit) {
    EPOCH_MEMO.set(memoKey, { v: coloHit, t: now });
    return coloHit;
  }

  let v = '0';
  try {
    const kv = kvFor(env, 'session');
    if (kv) {
      const got = await kv.get(`edge:ep:u:${uid}`);
      if (got) v = got;
    }
  } catch {
    /* KV 不可用时退化为不失效（靠 TTL 兜底） */
  }
  EPOCH_MEMO.set(memoKey, { v, t: now });
  void coloCachePutJson(epochColoKey(env, uid), v, EPOCH_COLO_TTL_S);
  return v;
}

/**
 * 写操作后调用：bump 该用户的 epoch，使旧缓存下一读即失效。
 *
 * 先写 KV 再清本地缓存（顺序关键）：反过来时，写 KV 前的一声读会拿旧值
 * 回填 colo/memo，随后再没人清它 → 旧 epoch 赖满一整个 TTL。
 *
 * colo 删除必须 await：上传完成后前端隔 1 秒就重拉列表，若这里 fire-and-forget，
 * 下一次读可能撞上还没删掉的旧 colo epoch → 命中旧列表 → 表现为「上传完要手动
 * 刷新才看得到」。这是确定性时序，不能靠 TTL 兜。
 */
export async function bumpAuthEpoch(env: Env, uid: string): Promise<void> {
  try {
    const kv = kvFor(env, 'session');
    // 不能只写 Date.now()：同毫秒的两次 bump 会得到同一个值，若中间夹了
    // 一次读缓存回填，第二次 bump 就等于没 bump。加随机后缀保证每次都变。
    // 这里只要「值不同」就够（epoch 进缓存键），不要求单调。
    if (kv) {
      await kv.put(
        `edge:ep:u:${uid}`,
        `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        { expirationTtl: 3600 },
      );
    }
  } catch {
    /* 失效是尽力而为，失败不影响正确性（TTL 兜底） */
  }
  EPOCH_MEMO.delete(`${deployKey(env)}:u:${uid}`);
  await coloCacheDelete(epochColoKey(env, uid));
}

function originOf(c: Context): string {
  return new URL(c.req.url).origin.replace(/\/+$/, '');
}

/** 归一化 query：按 key 排序，避免参数顺序不同产生不同键。 */
function normalizedQuery(c: Context): string {
  const url = new URL(c.req.url);
  const keys = [...url.searchParams.keys()].sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${url.searchParams.get(k)}`).join('&');
}

/**
 * 计算边缘缓存键路径。合成 URL（以 `/__edge_auth__/` 前缀），不含真实的
 * `?`，避免被 Cache API 当成查询串而错位匹配。
 */
function cacheKeyPath(c: Context, hash: string, epoch: string): string {
  const seg = [
    EDGE_AUTH_CACHE_VER,
    hash,
    epoch,
    encodeURIComponent(c.req.path),
    encodeURIComponent(normalizedQuery(c)),
    // Origin 也要进键：存的时候去掉了 Vary，但响应里的 Access-Control-Allow-Origin
    // 是按来源算的，不区分来源会把 A 的 ACAO 发给 B（桌面客户端/第三方页面跨源）。
    encodeURIComponent(c.req.header('Origin') ?? ''),
  ].join('/');
  return `/__edge_auth__/${seg}`;
}

/** 查登录态边缘缓存（命中返回响应，未命中/不可用返回 null）。 */
export async function edgeAuthCacheMatch(
  c: Context,
  hash: string,
  epoch: string,
): Promise<Response | null> {
  const origin = originOf(c);
  const key = cacheKeyPath(c, hash, epoch);
  return edgeCacheMatch(origin, key);
}

/** 把登录态 GET 的 200 响应写回边缘缓存（尽力而为）。 */
export function edgeAuthCachePut(
  c: Context,
  hash: string,
  epoch: string,
  ttlS: number,
): void {
  const origin = originOf(c);
  const key = cacheKeyPath(c, hash, epoch);
  // 闭包包裹，别传裸的 c.executionCtx.waitUntil（未绑定调用会抛 Illegal invocation，
  // 被 edgeCachePut 的 try/catch 吞掉 → 缓存永远写不进去）
  edgeCachePut((p) => c.executionCtx.waitUntil(p), origin, key, c.res, ttlS);
}

/** 全局「分享版本号」的 KV 键。分享被创建/编辑/删除时递增。 */
const SHARE_EPOCH_KEY = 'edge:ep:share';

/**
 * 取分享版本号。
 *
 * 用途：匿名分享目录列表有 60s 边缘缓存（`cachePublic`），但**分享被撤销后**
 * 缓存里的旧响应还会继续发出去 —— 与 GHSA-vx2m-jpxr-xv7w（撤销的分享仍能
 * 通过缓存签发直链）是同一类问题。把版本号并进缓存键，撤销时 bump 一下，
 * 旧键立刻失效。
 *
 * 代价是每次匿名分享请求多一次 KV 读（同 colo，十几毫秒），换来撤销即时生效；
 * 相比它替掉的一整串跨区数据库往返（1.5s+）仍然划算。**不要**给它加 isolate
 * 缓存 —— 加了撤销又会延迟到缓存过期。
 */
export async function getShareEpoch(env: Env): Promise<string> {
  try {
    const kv = kvFor(env, 'session');
    if (!kv) return '0';
    return (await kv.get(SHARE_EPOCH_KEY)) ?? '0';
  } catch {
    return '0';
  }
}

/** 分享发生写操作时调用；失败不影响正确性（最坏是缓存多活 60 秒）。 */
export async function bumpShareEpoch(env: Env): Promise<void> {
  try {
    const kv = kvFor(env, 'session');
    if (!kv) return;
    await kv.put(SHARE_EPOCH_KEY, String(Date.now()));
  } catch {
    /* 尽力而为 */
  }
}
