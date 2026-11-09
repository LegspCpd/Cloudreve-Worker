/**
 * EdgeOne Pages（Makers）Node 云函数入口。
 *
 * 打包：`npm run build:edgeone`（scripts/build-edgeone.mjs）→
 * `cloud-functions/[[default]].js`（catch-all，文件即路由）。
 * EdgeOne Pages 的路由顺序：先静态文件（edgeone.json 的 outputDirectory），
 * 未命中才进云函数 —— 所以 /assets/* 的正常请求到不了这里。
 *
 * ⚠️ 函数内要做 SPA 壳兜底（下面的 isHtmlNav 分支）：前端路由（/home 等）
 * 在静态层不存在，会落到 catch-all 函数，没有壳兜底就是 404 JSON，
 * 前端路由全打不开。缺失的 /assets/*.js 则必须 404 —— 回壳会造成
 * 「HTML 当 JS」的白屏（CF 的 not_found_handling 踩过一模一样的坑）。
 *
 * env 构造：EdgeOne 没有绑定概念，环境变量全在 process.env。透传后
 * KV（全部角色）/ R2 / ASSETS / HYPERDRIVE 均为 undefined，各自走降级：
 *   - KV 全缺失 → kvRouter 落 DB 表（key_values，迁移 0018）
 *   - R2 未绑   → 头像不可用、S3 策略要求填 AK/SK（R2 去强制化）
 *   - `cloudflare:sockets` → 打包 alias 到 src/edgeone/socket-shim.ts
 *
 * 环境变量：DATABASE_URL（必填，Neon 或任意 PostgreSQL）、JWT_SECRET、
 * SITE_URL。存储在管理后台配策略（COS / OneDrive / S3 兼容均可）。
 */
import app from '../src/index';
// SPA 壳：构建期内联 dist/index.html（build-edgeone.mjs 的 .html text loader）。
// EdgeOne Node 云函数没有 ASSETS 绑定，读不到静态目录，只能打进 bundle。
import INDEX_HTML from '../dist/index.html';
import type { Env } from '../src/env';
import { kvFor } from '../src/lib/kvRouter';
import { runCronTasks } from '../src/services/cron';

/** 后端路径前缀：这些请求永远交给 Hono，绝不返回 SPA 壳。 */
const BACKEND_PREFIXES = ['/api/', '/dav', '/s/', '/f/', '/manifest.json'];

/** 静态资产请求（有扩展名）。平台未命中才进函数，直接 404 —— 不能回
 * SPA 壳，否则「HTML 当 JS 解析」会让白屏自愈彻底失效（CF 上踩过）。 */
const ASSET_PATTERN = /\.[a-zA-Z0-9]+$/;

export async function onRequest(context: { request: Request; env?: unknown }) {
  const env = {
    ...(globalThis as { process?: { env?: Record<string, string> } }).process?.env,
  } as unknown as Record<string, unknown>;
  void maybeRunCron(env);

  const req = context.request;
  const url = new URL(req.url);
  const accept = req.headers.get('accept') ?? '';
  const isBackendPath = BACKEND_PREFIXES.some(
    (p) => url.pathname === p.replace(/\/$/, '') || url.pathname.startsWith(p),
  );

  // SPA 壳兜底：前端路由（/home、/@manage 等平台静态不存在的路径）由这里
  // 返回内联的 index.html。浏览器导航请求（Accept 含 text/html）才会命中。
  const isHtmlNav =
    (req.method === 'GET' || req.method === 'HEAD') &&
    accept.includes('text/html') &&
    !isBackendPath &&
    !ASSET_PATTERN.test(url.pathname);

  if (isHtmlNav) {
    return new Response(INDEX_HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  }

  return app.fetch(req, env as unknown as Env, {
    waitUntil: (p: Promise<unknown>) => p,
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
}

export default onRequest;

/**
 * 惰性 cron 补偿（EdgeOne 免费版 schedules 最小间隔 1 天）。
 *
 * schedules 每天触发一次 /api/v4/site/cron/tick；这里在有流量的部署上
 * 把「缓存刷新 + 回收站清理」补到小时级：每实例每分钟最多查一次
 * flag KV 的 cron:last-run，超过 1 小时就后台跑一次。任务全幂等，
 * 且实例被回收导致后台任务没跑完也无所谓 —— 每天的平台 cron 保底。
 */
let lastCronCheck = 0;
const HOUR_MS = 60 * 60 * 1000;

async function maybeRunCron(env: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  if (now - lastCronCheck < 60_000) return;
  lastCronCheck = now;
  try {
    const kv = kvFor(env as unknown as Env, 'flag');
    const last = Number((await kv.get('cron:last-run')) ?? 0);
    if (now - last < HOUR_MS) return;
    await kv.put('cron:last-run', String(now), { expirationTtl: 86400 });
    void runCronTasks(env as unknown as Env);
  } catch {
    // 惰性任务失败绝不影响正常请求
  }
}
