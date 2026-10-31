/**
 * Cloudreve Edge —— Worker 入口。
 *
 * 路由挂载与原版 `routers/router.go` 对齐：
 *   /api/v4/site/*     站点配置
 *   /api/v4/session/*  登录 / 刷新 / 注销
 *   /api/v4/user/*     用户与个人设置
 *   /api/v4/file/*     文件与上传下载
 *   /api/v4/share/*    分享
 *   /api/v4/admin/*    管理后台
 *   /api/v4/workflow/* 任务流（打包 / 远程下载）
 *   /s/:id             分享短链（302）
 *   /f/:id/:name       文件直链（302）
 *
 * 本 Worker 只提供后端；前端一律用官方前端（见下方「前端」一节）。
 * 所有业务错误都以 HTTP 200 + `{code, msg}` 返回，与原版一致。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import type { Env } from './env';
import { appContext, ctxOf, securityHeaders, type AppBindings } from './middleware/app';
import { cachePublicAnon, cachePublicAnonStore } from './middleware/cachePublic';
import { cacheAuthed } from './middleware/cacheAuthed';
import { fail, ok } from './lib/response';
import { AppError, CodeNotFound, describeError } from './lib/errors';
import { ensureSettings, loadSettings, prefetchSettings } from './settings/provider';
import { provision } from './db/provision';
import { resolveDb } from './db/shard';
import { getSql } from './db';
import { kvFor } from './lib/kvRouter';
import { warmAllCaches } from './services/cacheWarmer';
import { ensureDomainShards, } from './db/domainBootstrap';
import { applyDomainDownFromKv } from './db/shard';
import { warmPolicyCache } from './services/policyCache';
import { ensureEnvAdmin } from './services/envAdmin';
import { HashIDCodec } from './lib/hashid';
import { JWTService } from './lib/jwt';
import { AppContext } from './services/context';
import { siteRoutes } from './routes/site';
import { sessionRoutes } from './routes/session';
import { userRoutes } from './routes/user';
import { fileRoutes } from './routes/file';
import { shareRoutes } from './routes/share';
import { adminRoutes } from './routes/admin';
import { workflowRoutes } from './routes/workflow';
import { callbackRoutes } from './routes/callback';
import { slaveRoutes } from './routes/slave';
import { devicesRoutes } from './routes/devices';
import { davRoutes } from './routes/dav';
import { paymentRoutes, paymentAdminRoutes } from './routes/payment';
import { DownloadService } from './services/download';
import { FileSystemService } from './services/fs';
import { syncNodeTasks } from './services/nodeTasks';
import { sharePreview } from './middleware/sharePreview';
import { ShareService } from './services/share';
import { isSocialMediaBot, renderSharePreview } from './services/share-preview';

/**
 * 自举完成标记。**版本号要随「自举内容变化」递增**：KV 里的旧标记不会
 * 自动失效，改了 provision / 播种逻辑后必须 bump，让存量部署在下一次
 * 冷启动重跑一遍（全部幂等，代价是每 isolate 多跑一次 KV get + 标记命中后跳过）。
 * v3：修正 groups 播种（1<<40 位运算 bug + ON CONFLICT DO UPDATE），并让
 * 半播种的存量库（groups 缺行导致注册报外键错误）自愈。
 * v4：seedSystemData 新增 group_storage_policies 建表 + 旧单绑定迁入
 * （cf12733 漏 bump 导致存量部署查表报 relation does not exist）。
 * v5：新增付费分享迁移 0007（shares.score + share_purchases 表）。
 * v6：新增 OIDC 迁移 0008（user_oidc_bindings 表）。
 * v7：group_storage_policies 建表移入迁移 0009（此前只在 seedSystemData
 *     里建，导致「只按 migrations 建库」的备库缺这张表 → 该表同步不过去）。
 * v8：新增归档迁移 0010（archive_entries 表 + 只增不改触发器）。
 * v9：新增迁移 0011（存量 file_viewers='[]' 行回填内置查看器默认集，
 *     修复前端「打开方式」菜单为空）。⚠️ v9 被一次漏注册迁移的部署烧掉
 *     （迁移文件没进 provision.ts 的 MIGRATIONS 清单，flag 先置位了）。
 * v10：0011 真正注册进 MIGRATIONS 清单后重新触发自举。
 * v11：新增迁移 0012（file_viewers 脏形态兜底回填——存量值非空但解析为
 *     空集且不等于 '[]'，躲过 0011；读取层 parseFileViewers 同步兜底）。
 * v12：新增分域自举 ensureDomainShards（DATABASE_URL_2=审计日志域、
 *     _3=元数据域：建表 + 搬迁存量；未配置的域自动跳过）。
 * v13：分域失败防御补全——建表/搬迁失败落 KV 长 TTL 降级（跨 isolate）、
 *     自举时装回内存、运行时查询失败自动 30s 短降级、搬迁改两阶段
 *     （先复制到空再清主库，杜绝数据劈半）。
 */
/**
 * 自举标记。**每次改 migrations/ 或 provision/seed 的内容都必须 bump 这一行**，
 * 否则存量部署里的 `provision()` 整体不会被调用，新表永远不会建出来
 * （踩过：加了 site_state / rate_limits 两张表没 bump，线上一直「表不存在」，
 * 限速静默失效、注册也会挂在 claimFirstAdmin 上）。
 */
const BOOTSTRAP_FLAG = 'bootstrap:done:v17';
/** 自举失败后的冷却键（20 秒 TTL）：期间请求直接快速失败，不再重放自举。 */
const BOOTSTRAP_COOLDOWN = 'bootstrap:cooldown:v1';
/** 同一 isolate 内的并发请求共享一次自举。 */
let bootstrapPromise: Promise<void> | null = null;
/**
 * 自举完成标记的 isolate 级内存缓存。
 *
 * `BOOTSTRAP_FLAG` 是**一次性**的开关：站点起来之后这个键永远是 1。
 * 原实现每个请求都要 `KV.get(BOOTSTRAP_FLAG)` 确认一次 —— 实测单次 KV
 * get 180~560ms，等于给**所有**请求（包括静态资源与 API）永久加了一道
 * 半秒级的税。而 KV 全球最终一致，本来也没人能保证跨 isolate 立刻可见，
 * 所以这里缓存进内存，语义上没有任何损失：
 *   - `false` 表示「本 isolate 还没确认过」，仍走 KV + 自举流程；
 *   - `true` 表示本 isolate 已确认，后续请求直接跳过。
 * 部署新版本会换掉 isolate，标记自然重新读取（这正是需要的时机）。
 */
let bootstrapConfirmed = false;
/** 环境变量管理员检查每个 isolate 只跑一次（KV 标记去重，见 services/envAdmin.ts）。 */
let envAdminPromise: Promise<void> | null = null;

/** 应用 ADMIN_EMAIL / ADMIN_PASSWORD 环境变量（配置了才生效）。失败只记日志，不拦请求。 */
function ensureEnvAdminOnce(env: Env): Promise<void> {
  if (!envAdminPromise) {
    envAdminPromise = ensureEnvAdmin(env).catch((e) => {
      console.error('env admin bootstrap failed', describeError(e));
    });
  }
  return envAdminPromise;
}

const app = new Hono<AppBindings>();

// ---------------------------------------------------------------------------
// 全局中间件
// ---------------------------------------------------------------------------

app.use('*', async (c, next) => {
  // 冷启动自举：自动建表、播种系统组与默认策略、补齐设置表。
  // 三件事都幂等，用 KV 标记避免每个请求都打一遍数据库。
  // 失败有 20 秒冷却期：期间的请求直接回 503，避免所有请求同时重放
  // 自举把 Neon 打出限流（那正是「站点配置加载失败 429」的根源）。
  //
  // KV / 数据库不可用时不能让异常逃出去（平台层回 520，用户看不懂也
  // 没法重试）。这里统一转成 503 + 明确文案，前端刷新即可恢复。
  //
  // 已确认过的 isolate 直接短路 —— 这一条是**热路径**上的关键优化，
  // 见 `bootstrapConfirmed` 的注释。
  if (!bootstrapConfirmed) {
    // 冷启动时「读自举标记」与「读设置」互不依赖，先把设置读取挂起来并行跑，
    // 后面 appContext 会 await 同一个 Promise（见 settings/provider.ts）。
    prefetchSettings(c.env, (p) => c.executionCtx.waitUntil(p));
    try {
      // 自举标记与「分域降级」状态并行读出（都在 flag 命名空间，一次并发
      // 往返拿全）。分域降级状态**必须每个 isolate 冷启动都装一遍**：
      // BOOTSTRAP_FLAG 已设置时下面的自举分支整体跳过，而 Workers 会不断
      // 滚动出新的 isolate —— 新 isolate 不装这份状态就会去打已知不可用
      // 的域库，直到一次查询失败才开始 30s 降级，用户侧就是「偶发数据库
      // 操作失败」。放在并行读里，冷启动多花的只是一次并发 KV 往返，
      // 热路径（bootstrapConfirmed=true）完全不受影响。
      const [bootstrapped] = await Promise.all([
        kvFor(c.env, 'flag').get(BOOTSTRAP_FLAG),
        applyDomainDownFromKv(c.env),
      ]);
      if (!bootstrapped) {
        if (await kvFor(c.env, 'flag').get(BOOTSTRAP_COOLDOWN)) {
          return c.json(
            { code: 50006, msg: '站点正在初始化（刚部署或数据库暂时不可用），请几秒后刷新重试' },
            503,
          ) as never;
        }
        if (!bootstrapPromise) {
          bootstrapPromise = (async () => {
            const db = resolveDb(c.env);
            await provision(c.env, db);
            await ensureSettings(c.env, db);
            // 分域自举：配了 DATABASE_URL_2/_3 时在对应库建表并搬迁存量
            // 审计/元数据（幂等，KV 标记短路）；失败不阻断自举，cron 兜底重试。
            // （域降级状态已在上面与自举标记并行装回内存，这里直接用。）
            await ensureDomainShards(c.env);
            await kvFor(c.env, 'flag').put(BOOTSTRAP_FLAG, '1');
          })().catch(async (err) => {
            bootstrapPromise = null;
            try {
              await kvFor(c.env, 'flag').put(BOOTSTRAP_COOLDOWN, '1', { expirationTtl: 20 });
            } catch {
              /* KV 也不可用时只能让下一个请求再试 */
            }
            throw err;
          });
        }
        await bootstrapPromise;
      }
      bootstrapConfirmed = true;
    } catch (e) {
      console.error('bootstrap failed', describeError(e));
      return c.json(
        { code: 50006, msg: '站点正在初始化（数据库暂时不可用），请几秒后刷新重试' },
        503,
      ) as never;
    }
  }
  // 兜底管理员（ADMIN_EMAIL / ADMIN_PASSWORD，可选）——放在自举之外，
  // 后配的环境变量也能在下一个冷启动 isolate 里生效。
  await ensureEnvAdminOnce(c.env);
  await next();
});

/**
 * API 跨域。原版默认**不开**跨域（配置项 AllowOrigins 为 UNSET 时不挂 CORS
 * 中间件，见 `routers/router.go` 的 initCORS），要用得显式配。边缘版沿用同一策略：
 * 只有 `CORS_ALLOW_ORIGINS` 里列出的源才会拿到 ACAO 头，未配置就等于关闭。
 *
 * 官方前端与 Worker 同源部署时不需要开这个。
 */
app.use('/api/*', cors({
  origin: (origin: string, c: Context<AppBindings>) => {
    const allowed = (c.env.CORS_ALLOW_ORIGINS ?? '')
      .split(',')
      .map((o: string) => o.trim())
      .filter(Boolean);
    if (allowed.length === 0) return '';
    // 没有 Origin 头（同源请求 / curl）时不必回 ACAO
    if (!origin) return '';
    return allowed.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Range', 'If-Range', 'X-Correlation-ID'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Disposition', 'ETag'],
  credentials: true,
  maxAge: 86400,
}));

// 安全响应头。放在两个缓存中间件**之前**：写进边缘缓存的那份响应也要带上
// （否则命中缓存的请求没有 nosniff / Referrer-Policy）。
app.use('*', securityHeaders());
// 公共匿名接口（ping / site/config/*）的边缘缓存：命中即短路，跳过 appContext
// 的 KV 读与冷启动。必须在 appContext 之前注册，否则缓存命中也要先跑一通中间件。
app.use('*', cachePublicAnon());
// 登录态只读接口（/me、GET /file 列目录）的边缘缓存：命中即短路，跳过
// appContext 的 KV 读与数据库往返。必须在 appContext 之前注册。
app.use('*', cacheAuthed());
app.use('*', appContext());
// 社交媒体爬虫看分享链接时回 OG 预览页（非爬虫原样放行）。
// 必须放在 appContext 之后 —— 它要读站点设置和分享信息。
app.use('*', sharePreview());
// 后置：miss 时把 200 响应写回 CF 边缘缓存（跨 isolate 共享）。
app.use('*', cachePublicAnonStore());

// ---------------------------------------------------------------------------
// 业务路由
// ---------------------------------------------------------------------------

app.route('/api/v4/site', siteRoutes);
app.route('/api/v4/session', sessionRoutes);
app.route('/api/v4/user', userRoutes);
app.route('/api/v4/file', fileRoutes);
app.route('/api/v4/share', shareRoutes);
app.route('/api/v4/admin', adminRoutes);
app.route('/api/v4/workflow', workflowRoutes);
app.route('/api/v4/payment/admin', paymentAdminRoutes);
app.route('/api/v4/payment', paymentRoutes);

/**
 * 上传回调。原版在 `/api/v4/callback` 下按驱动分成 9 个子路径，边缘版只实现
 * OneDrive 一条 —— 它走客户端直传，没有回调就无法完成「实体转正 + 容量记账」。
 * 其余驱动的回调返回 40019（见 `routes/callback.ts`）。
 *
 * 鉴权靠路径里的 callback secret，不走登录中间件（与原版一致）。
 */
app.route('/api/v4/callback', callbackRoutes);
/**
 * 从节点回调（主站侧 `/api/v4/slave/*`）。鉴权不走登录态，而是
 * `X-Cr-Node-Id` + HMAC 签名（见 routes/slave.ts 文件头）。
 */
app.route('/api/v4/slave', slaveRoutes);
app.route('/api/v4/devices', devicesRoutes);
app.route('/dav', davRoutes);

/**
 * PWA manifest。官方前端的构建产物里**没有**这个文件 —— 原版由 Go 后端
 * 动态生成（`routers/controllers/site.go` 的 Manifest），index.html 里的
 * `<link rel="manifest">` 指向它。字段结构与原版完全一致，值跟随站点设置。
 * 注意 run_worker_first 必须包含 /manifest.json，否则会被静态资源层
 * 按 SPA 回落成 index.html（浏览器报 Manifest syntax error）。
 */
app.get('/manifest.json', (c) => {
  const s = ctxOf(c).settings;
  c.header('Cache-Control', 'public, no-cache');
  return c.json({
    short_name: s.siteName,
    name: s.siteName,
    icons: [
      {
        src: s.get('pwa_small_icon', '/static/img/favicon.ico'),
        sizes: '64x64 32x32 24x24 16x16',
        type: 'image/x-icon',
      },
      { src: s.get('pwa_medium_icon', '/static/img/logo192.png'), type: 'image/png', sizes: '192x192' },
      { src: s.get('pwa_large_icon', '/static/img/logo512.png'), type: 'image/png', sizes: '512x512' },
    ],
    start_url: '.',
    display: s.get('pwa_display', 'standalone'),
    theme_color: s.get('pwa_theme_color', '#000000'),
    background_color: s.get('pwa_background_color', '#ffffff'),
  }) as never;
});

// ---------------------------------------------------------------------------
// 内容跨域。对应原版 `middleware.ContentCORS()`，只挂在两个「内容」路由组上：
//   - /api/v4/file/content/:id/:speed/:name   实体内容（预览 / 下载）
//   - /f/:id/:name                            文件直链跳转
// 这三个头是给 <video>/<audio> 的 Range 请求用的，**不带凭据**。
// ---------------------------------------------------------------------------

const contentCors = cors({
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'OPTIONS'],
  allowHeaders: ['Range', 'If-Range', 'Authorization', 'Content-Type'],
  exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'Content-Disposition', 'ETag'],
  credentials: false,
});

app.use('/api/v4/file/content/*', contentCors);
app.use('/f/*', contentCors);

// ---------------------------------------------------------------------------
// 短链与直链
// ---------------------------------------------------------------------------

/**
 * 分享短链。原版 `sharesvc.ShortLinkRedirectService` 不查库，直接把
 * `cloudreve://<id>[:password]@share` 拼进前端地址重定向；分享不存在这类情况
 * 交给前端展示「链接失效」。这里保持一致 —— 失败也照常跳，不吞错误码。
 *
 * 例外（上游 PR #3234）：社交媒体爬虫不重定向，直接渲染带 og:* meta 的
 * 预览页，社交平台卡片能展示分享名/大小/属主。
 */
app.get('/s/:id', (c) => {
  const ctx = ctxOf(c);
  const share = new ShareService(ctx, new FileSystemService(ctx));
  const query = new URL(c.req.url).searchParams;
  const target = share.shortLinkRedirect(c.req.param('id'), undefined, query);
  if (isSocialMediaBot(c.req.header('User-Agent'))) {
    return renderSharePreview(c, ctx, c.req.param('id'), undefined, target);
  }
  return c.redirect(target, 302);
});

app.get('/s/:id/:password', (c) => {
  const ctx = ctxOf(c);
  const share = new ShareService(ctx, new FileSystemService(ctx));
  const query = new URL(c.req.url).searchParams;
  const target = share.shortLinkRedirect(c.req.param('id'), c.req.param('password'), query);
  if (isSocialMediaBot(c.req.header('User-Agent'))) {
    return renderSharePreview(c, ctx, c.req.param('id'), c.req.param('password'), target);
  }
  return c.redirect(target, 302);
});

/**
 * 文件直链。原版 `AnonymousPermLink` 会用 `c.Redirect(302, ...)` 跳到存储后端
 * 的真实地址；失败时**不是** 200 信封，而是 `c.JSON(404, envelope)`
 * （见 `routers/controllers/file.go`），这里照做。
 */
app.get('/f/:id/:name', async (c) => {
  const ctx = ctxOf(c);
  const service = new FileSystemService(ctx);
  const download = new DownloadService(ctx, service);
  try {
    const target = await download.visitDirectLink(c.req.param('id'));
    return c.redirect(target, 302);
  } catch (e) {
    return fail(c, e, 404);
  }
});

// ---------------------------------------------------------------------------
// 前端
//
// 本 Worker 只是后端，**不内置任何自研前端**。官方前端（Cloudreve/Frontend
// 的 v4 构建产物）有两种接法，见 README「接入官方前端」：
//
//   A. 推荐：在 wrangler.toml 里配 `[assets]`，把官方前端构建产物目录指过去。
//      静态资源与 SPA 回落由平台的资源层处理，本函数不会被调用。
//   B. 官方前端单独部署（Cloudflare Pages 等），把 FRONTEND_URL 指过去，
//      这里做一次原样反代，保证同源、Cookie 与 /api 路径都不出问题。
// ---------------------------------------------------------------------------

/** 非 /api 请求的兜底：优先反代到 FRONTEND_URL，其次交给静态资源绑定。 */
async function serveFrontend(c: Context<AppBindings>): Promise<Response> {
  const frontendUrl = c.env.FRONTEND_URL?.replace(/\/+$/, '');
  if (frontendUrl) {
    const incoming = new URL(c.req.url);
    const target = `${frontendUrl}${incoming.pathname}${incoming.search}`;
    const proxied = new Request(target, c.req.raw);
    // 让官方前端自己判断协议/主机，避免把 Worker 的 Host 传下去导致回跳错地址
    proxied.headers.delete('host');
    return fetch(proxied);
  }

  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }

  return c.text(
    'Cloudreve Edge 后端已就绪，但没有配置前端。\n' +
      '请二选一：配置 wrangler.toml 的 [assets] 指向官方前端构建产物，' +
      '或设置 FRONTEND_URL 指向已部署的官方前端。\n' +
      'API 入口：/api/v4/site/ping\n',
    404,
  );
}

// ---------------------------------------------------------------------------
// 错误处理
// ---------------------------------------------------------------------------

app.notFound(async (c) => {
  // API 路径保持信封格式；其它路径交给官方前端（前端路由由前端自己处理）
  if (c.req.path.startsWith('/api/')) {
    return fail(c, new AppError(CodeNotFound, 'API endpoint not found'));
  }
  return serveFrontend(c);
});

app.onError((err, c) => {
  // 未预期的异常统一转成标准信封，避免把堆栈暴露给客户端
  const wrapped = err instanceof AppError ? err : new AppError(50005, 'Internal server error', err);
  return fail(c, wrapped);
});

/**
 * 最外层兜底包装。
 *
 * Hono 的 `#handleError` 只在 `err instanceof Error` 时才走 `onError`，
 * **其余一律原样 re-throw**（hono-base.js:273-278）。跨序列化边界传回来的
 * 错误对象（Workers 的 binding/DOMException、Neon 的瞬态失败、子请求超时）
 * 丢掉原型链后就不再 `instanceof Error`，会被直接抛出到平台层 ——
 * Cloudflare 拿到未捕获异常就回 **HTTP 520**，且**不经过 `app.onError`**，
 * 用户只看到「内部错误 (HTTP status 520)」。
 *
 * 这里再包一层 try/catch 并归一化错误形态，保证任何抛出物都变成
 * 标准 JSON 信封（HTTP 200 + code），彻底消除 520。
 */
async function fetchWithFallback(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    return await app.fetch(request, env, ctx);
  } catch (e) {
    // 连 Correlation ID 都拿不到时也要能回一个合规响应
    const id = request.headers.get('X-Correlation-ID') ?? crypto.randomUUID();
    console.error('unhandled error escaped Hono', describeError(e));
    return new Response(
      JSON.stringify({
        code: 50005,
        msg: 'Internal server error',
        correlation_id: id,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Correlation-ID': id },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export default {
  fetch: fetchWithFallback,
  /**
   * 定时任务（在 wrangler.toml 的 `[triggers] crons` 里配置，当前是每小时整点）。
   *
   * 做三件事，按「重要性从高到低」排列，任何一件失败都不影响后面的：
   *   1. **缓存刷新**：把站点设置这类缓存回源重写一遍，保证内容不会因为
   *      「某条写路径漏了失效」而长期陈旧（需求：每小时自动拉取一次）。
   *      只做覆盖写，不 list/delete —— 开销恒定，不受缓存键数影响。
   *   2. 清掉回收站里已到期的项 —— 对应原版的队列任务 `trash_collector`，
   *      判定依据是软删除时写入的 `sys:expected_collect_time`。
   *   3. （隐含）KV 里的上传会话 / 验证码靠 TTL 自动过期，不需要在这里处理。
   *
   * ⚠️ **这里刻意不做「清空 KV」**：KV 绑定没有批量删，逐键删会把
   * 免费档 50 subrequests 的预算烧光（见 `services/cacheWarmer.ts` 的说明）。
   * 「清空再重填」在**构建期**由 `scripts/kv-purge-refill.mjs` 完成 ——
   * 走 CLI 的批量接口，没有预算限制。这里只负责「刷新」。
   */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    // 自举没完成（刚部署、还没人访问过）时 settings 表可能还不存在，
    // 定时任务直接跳过 —— 第一次网页请求会完成自举。
    try {
      if (!(await kvFor(env, 'flag').get(BOOTSTRAP_FLAG))) {
        console.log('cron: skipped (bootstrap not finished yet)');
        return;
      }
    } catch {
      // KV 都不可用就没什么可刷新的，等下一轮
      return;
    }

    // 1. 缓存刷新。独立 try —— 刷新失败不能影响下面的回收站清理。
    try {
      const warmed = await warmAllCaches(env);
      const failed = warmed.filter((w) => !w.ok).map((w) => w.id);
      console.log(
        failed.length === 0
          ? `cron: cache refreshed (${warmed.length} entries)`
          : `cron: cache refresh partial, failed=[${failed.join(',')}]`,
      );
    } catch (e) {
      console.error('cron: cache refresh failed', describeError(e));
    }

    // 1.5 分域自举兜底（幂等，自举时域库恰好不可用的话这里补上）
    //     + 策略行预热进 L1/KV（读极多的热数据，空闲后首个请求直接命中缓存）。
    try {
      await applyDomainDownFromKv(env);
      await ensureDomainShards(env);
    } catch (e) {
      console.error('cron: domain shard bootstrap failed', describeError(e));
    }
    try {
      const n = await warmPolicyCache(env);
      console.log(`cron: policy cache warmed (${n} rows)`);
    } catch (e) {
      console.error('cron: policy cache warm failed', describeError(e));
    }

    // 2. 回收站到期清理。
    try {
      const settings = await loadSettings(env);
      const appCtx = new AppContext(
        env,
        settings,
        new HashIDCodec(settings.hashIdSalt),
        new JWTService(settings.secretKey),
      );
      const removed = await new FileSystemService(appCtx).purgeExpiredTrash();
      if (removed > 0) {
        console.log(`trash collector: purged ${removed} expired item(s)`);
      }
    } catch (e) {
      // 定时任务不该因为一次失败就中断后续调度；这里只记日志，不向上抛。
      // 部分错误对象（跨序列化边界）会丢 message，把全部字段 dump 出来
      // 才能在日志里看到真实原因，而不是只剩一行堆栈帧。
      console.error('trash collector failed', describeError(e));
    }

    // 3. 清掉过期的限速计数（窗口外的行已经没用，留着只会越长越大）。
    try {
      const sql = getSql(env);
      await sql("DELETE FROM rate_limits WHERE window_start < EXTRACT(EPOCH FROM now())::bigint - 3600");
    } catch (e) {
      console.error('rate limit cleanup failed', describeError(e));
    }

    // 4. 从节点任务状态同步。没有从节点的部署这一步是零查询（LIKE 匹配为空）。
    try {
      const synced = await syncNodeTasks(env);
      if (synced.checked > 0) {
        console.log(`node task sync: checked=${synced.checked} updated=${synced.updated}`);
      }
    } catch (e) {
      console.error('node task sync failed', describeError(e));
    }
  },
};

