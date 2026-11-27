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
import { readBytesLimited } from '../src/lib/bodyLimit';
import { AppError } from '../src/lib/errors';
import { applySiteIcons } from '../src/lib/siteIcons';
import { loadSettings } from '../src/settings/provider';
import { runCronTasks } from '../src/services/cron';

/** 后端路径前缀：这些请求永远交给 Hono，绝不返回 SPA 壳。 */
const BACKEND_PREFIXES = ['/api/', '/dav', '/s/', '/f/', '/d/', '/manifest.json'];

/** 静态资产请求（有扩展名）。平台未命中才进函数，直接 404 —— 不能回
 * SPA 壳，否则「HTML 当 JS 解析」会让白屏自愈彻底失效（CF 上踩过）。 */
const ASSET_PATTERN = /\.[a-zA-Z0-9]+$/;

export async function onRequest(context: { request: Request; env?: unknown }) {
  const env = {
    ...(globalThis as { process?: { env?: Record<string, string> } }).process?.env,
  } as unknown as Record<string, unknown>;
  void maybeRunCron(env);

  const raw = context.request;
  const url = new URL(raw.url);
  const accept = raw.headers.get('accept') ?? '';
  const isBackendPath = BACKEND_PREFIXES.some(
    (p) => url.pathname === p.replace(/\/$/, '') || url.pathname.startsWith(p),
  );

  // SPA 壳兜底：前端路由（/home、/@manage 等平台静态不存在的路径）由这里
  // 返回内联的 index.html。浏览器导航请求（Accept 含 text/html）才会命中。
  const isHtmlNav =
    (raw.method === 'GET' || raw.method === 'HEAD') &&
    accept.includes('text/html') &&
    !isBackendPath &&
    !ASSET_PATTERN.test(url.pathname);

  if (isHtmlNav) {
    // 官方 index.html 的 favicon / 首屏 logo 是模板占位符，构建期填了默认值。
    // 这里读站点设置运行时替换，管理后台改 PWA 图标才能生效。设置读失败
    // 就用默认壳，绝不让首页因为一次 DB/KV 抖动挂掉。
    let html = INDEX_HTML;
    try {
      const s = await loadSettings(env as unknown as Env);
      html = applySiteIcons(INDEX_HTML, {
        small: s.get('pwa_small_icon'),
        medium: s.get('pwa_medium_icon'),
        large: s.get('pwa_large_icon'),
      });
    } catch {
      // 保留默认 HTML
    }
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
      },
    });
  }

  // ⚠️ EdgeOne 云函数的 Request body 流在连接复用时会偶发读不到：
  // 实测「每个 POST 前插一个 GET」→ POST 交替报 uri/body 缺失；连续 POST
  // 只有第一次失败。平台传进来的 Request 对象不可靠，这里把 body 完整读进
  // 内存、重建一个标准 Request 再交给 Hono。
  // EdgeOne 单请求 body 上限 6MB（官方文档），全量读入没有 OOM 风险；
  // CF Worker 不走这个入口，不受影响。但 6MB 对控制消息仍过大，公开端点
  // 另有各自的 16KB/64KB 限制；这里按平台硬顶再设一道 6MB 的总闸，
  // 超限回真 413，别让异常请求一路读到 Hono 才被发现。
  // EdgeOne 不注入 CF-Connecting-IP，客户端可以自己带这个头，每次换一个
  // 值就能重置按 IP 的限速桶。统一剥掉，让 clientIp() 回落到 XFF 最右段。
  const safeHeaders = new Headers(raw.headers);
  safeHeaders.delete('CF-Connecting-IP');

  let req = raw;
  if (raw.method !== 'GET' && raw.method !== 'HEAD') {
    // 用受限读取替代裸 arrayBuffer：CL 虚报和 chunked 超限都在流里被拦下。
    // 这里在 Hono 之前，走不到统一 fail()，超限自己回真 413。
    let buf: Uint8Array;
    try {
      buf = await readBytesLimited(raw, 6 * 1024 * 1024);
    } catch (e) {
      if (e instanceof AppError && e.code === 413) {
        return new Response(JSON.stringify({ code: 413, msg: e.msg }), {
          status: 413,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }
      throw e;
    }
    req = new Request(raw.url, {
      method: raw.method,
      headers: safeHeaders,
      body: buf.byteLength > 0 ? (buf.buffer as ArrayBuffer) : undefined,
    });
  } else {
    req = new Request(raw.url, { method: raw.method, headers: safeHeaders });
  }

  // EdgeOne Pages 的 onRequest 不提供 ExecutionContext.waitUntil。此前传
  // `(p) => p` 空实现，导致所有后台任务（全文索引、媒体元数据抽取、缩略图
  // 边缘缓存回填）全部不执行 —— EO 上媒体信息一直是空的。
  // 这里改成收集任务并 fire-and-forget：响应不等待它们，尽力让它们在函数
  // 返回前跑完。EdgeOne 可能在响应后冻结环境，但至少不再「确定不执行」。
  const background: Promise<unknown>[] = [];
  const response = await app.fetch(req, env as unknown as Env, {
    waitUntil: (p: Promise<unknown>) => {
      background.push(p.catch((e) => console.error('[EO background task]', e)));
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext);
  if (background.length > 0) {
    // 最多等 3 秒：后台任务不该拖垮前台响应；超时后剩余的由惰性补偿/cron 兜底。
    await Promise.race([
      Promise.allSettled(background),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).catch(() => undefined);
  }
  return response;
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
