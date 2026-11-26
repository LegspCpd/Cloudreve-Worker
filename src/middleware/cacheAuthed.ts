/**
 * 登录态只读接口的边缘缓存中间件（CF Cache API，跨 isolate 共享）。
 *
 * 用法：在 `appContext()` **之前**注册。命中即短路返回，跳过整个
 * `appContext`（省 KV + DB 往返）。
 *
 * 覆盖三类请求：
 *  1. 缓存命中（读）：`GET` 且命中允许列表 → 直接返回缓存响应。
 *  2. 缓存写入（读 miss）：`GET` 允许列表且 `code === 0` 的 200 响应 → 写回。
 *  3. 失效（写）：任何**成功**（200 + `code === 0`）的非 GET 登录态请求 →
 *     bump 该用户的 epoch，使旧缓存下一读即失效。
 *
 * 允许列表与 TTL（见 `AUTH_CACHEABLE`）：
 *  - `/api/v4/user/me`      用户资料，30s（资料极少变，写即失效）。
 *  - `/api/v4/file`         列目录，60s（任何成功的写请求都会 bump epoch，
 *                           下一次读立刻失效，所以 TTL 可以给长一点换回退速度）。
 *
 * `/site/config/*` 与 ping 仍由 `cachePublicAnon` 处理（公开、与用户无关），
 * 不在此列，避免重复缓存。
 */
import type { Context, MiddlewareHandler } from 'hono';
import {
  authHash,
  bumpAuthEpoch,
  edgeAuthCacheMatch,
  edgeAuthCachePut,
  getAuthEpoch,
} from '../lib/edgeCacheAuth';
import { withHeaders } from '../lib/edgeCache';


type Bindings = { Bindings: import('../env').Env };

interface CacheRule {
  re: RegExp;
  ttl: number;
}

/** 允许缓存的登录态 GET 接口及各自 TTL（秒）。 */
const AUTH_CACHEABLE: CacheRule[] = [
  { re: /^\/api\/v4\/user\/me$/, ttl: 30 },
  // 站点配置：登录后首屏必打，内容 99% 是站点设置 + 本人组信息，按登录态指纹
  // 分键缓存（与 /me 同一套失效机制）能把首屏的 appContext + 设置查询整段省掉。
  // 管理后台改设置最多 30s 后生效。
  { re: /^\/api\/v4\/site\/config\/(login|explorer|thumb)$/, ttl: 30 },
  { re: /^\/api\/v4\/file$/, ttl: 60 },
  // 单文件元数据：桌面端同步遍历时按文件逐个调（get_file_info），一次遍历能把
  // 同一个 URI 打很多次；60s 足够覆盖一次遍历，写操作照样即时失效。
  { re: /^\/api\/v4\/file\/info$/, ttl: 60 },
  // 缩略图地址：Explorer 打开文件夹时会按图片逐个要缩略图，每个都是一次
  // 「解析文件 → 问驱动要地址」的跨区查询。缓存 60s，命中就零往返。
  { re: /^\/api\/v4\/file\/thumb$/, ttl: 60 },
];

/** 命中允许列表且为 GET 则返回规则，否则 null。 */
function matchCacheable(c: Context<Bindings>): CacheRule | null {
  if (c.req.method !== 'GET') return null;
  const p = c.req.path;
  for (const r of AUTH_CACHEABLE) if (r.re.test(p)) return r;
  return null;
}

/** 读信封的 `code` 字段判断是否真正成功（本 API 错误也走 HTTP 200）。 */
async function envelopeCode(c: Context<Bindings>): Promise<number | null> {
  try {
    const clone = c.res.clone();
    const j = (await clone.json()) as { code?: number };
    return typeof j.code === 'number' ? j.code : null;
  } catch {
    return null;
  }
}

export function cacheAuthed(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    const rule = matchCacheable(c);

    // 前置准备：命中读列表且带登录态时，算 hash/epoch 并尝试命中。
    let pendingHash: string | undefined;
    let pendingEpoch: string | undefined;
    let pendingTtl = 0;

    if (rule) {
      const header = c.req.header('Authorization') ?? null;
      if (header) {
        const hash = await authHash(header);
        // epoch 按 user id 取（与写失效、上传收尾 bump 同一把键）。命中检查里
        // 已经要求解析出 user，这里若 user 为空就当 miss，绝不用 '0' 去回缓存。
        const ctxUser = (c.get('ctx' as never) as { user?: { id?: number } } | undefined)?.user;
        const uid = ctxUser?.id;
        if (uid === undefined) {
          await next();
          return;
        }
        const epoch = await getAuthEpoch(c.env, String(uid));
        const hit = await edgeAuthCacheMatch(c, hash, epoch);
        // 命中前必须确认本次请求真的解析出了用户。封禁/删号/access token 过期时
        // appContext 会把 user 留空，但 Authorization 串没变、缓存键也没变 ——
        // 只看 header 就回缓存，等于封禁要等 TTL 才生效。
        if (hit && (c.get("ctx" as never) as { user?: unknown } | undefined)?.user) {
          const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
          // cache.match 返回的响应头只读，改之前先复制
          return withHeaders(hit, {
            'X-Correlation-ID': correlationId,
            'X-Edge-Cache': 'hit',
            // 浏览器侧 private + SWR：本人机器上即时复用，不进共享代理。
            'Cache-Control': `private, max-age=0, stale-while-revalidate=${rule.ttl}`,
          });
        }
        // miss：记下来，post 阶段写回（复用同一 hash/epoch）。
        pendingHash = hash;
        pendingEpoch = epoch;
        pendingTtl = rule.ttl;
      }
    }

    await next();

    const res = c.res;

    // 1) 读 miss 写回（仅真正成功的 200）。
    if (pendingHash && res.status === 200) {
      const code = await envelopeCode(c);
      if (code === 0) {
        edgeAuthCachePut(c, pendingHash, pendingEpoch!, pendingTtl);
        // 同时让浏览器也能 SWR（覆盖 jsonResponse 强制的 no-store）。
        // 同样要复制响应再改头：c.res 的头在 Hono 里是只读的。
        c.res = withHeaders(res, {
          'Cache-Control': `private, max-age=0, stale-while-revalidate=${pendingTtl}`,
          'X-Edge-Cache': 'miss',
        });
      }
      return;
    }

    // 2) 写操作失效：任何成功的非 GET 登录态请求 bump 该用户的 epoch。
    // S3/OSS 等直传完成回调是 GET 且没有 Authorization，走不到这里 —— 这类
    // 上传由 UploadService.finishUpload 收尾时主动 bump（按 uid，同一把键）。
    if (rule === null && c.req.method !== 'GET' && res.status === 200) {
      const header = c.req.header('Authorization');
      const uid = (c.get('ctx' as never) as { user?: { id?: number } } | undefined)?.user?.id;
      if (header && uid !== undefined) {
        const code = await envelopeCode(c);
        if (code === 0) {
          await bumpAuthEpoch(c.env, String(uid));
        }
      }
    }
  };
}
