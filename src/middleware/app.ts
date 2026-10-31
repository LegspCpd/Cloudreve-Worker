/**
 * 请求上下文中间件：装配 AppContext、解析当前用户、生成关联 ID。
 *
 * 对应原版的 `middleware.Session` + `middleware.CurrentUser`：
 *   - 从 `Authorization: Bearer <jwt>` 解析用户；
 *   - token 无效/过期时不报错，按未登录处理（由各路由自行要求登录）；
 *   - `Bearer Cr <sign>` 是 HMAC 签名，不走 JWT 解析。
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import type { Env } from '../env';
import { AppContext } from '../services/context';
import { logAudit } from '../services/audit';
import { MailService } from '../services/mail';
import {
  consumePrefetchedSettings,
  ensureSettings,
  loadSettings,
  type SettingsProvider,
} from '../settings/provider';
import { HashIDCodec } from '../lib/hashid';
import { JWTService, TokenHeaderPrefix, TokenHeaderPrefixCr } from '../lib/jwt';
import type { UserWithGroup } from '../db/types';
import { UserRepo } from '../db/repo';
import { resolveDb, type DbHandle } from '../db/shard';
import { kvFor } from '../lib/kvRouter';
import { getCachedUser, invalidateUser, rememberEnv } from '../services/userCache';
import { rememberPolicyEnv } from '../services/policyCache';
import { stageInit, stagesOf } from '../lib/timings';

export interface AppBindings {
  Bindings: Env;
  Variables: {
    ctx: AppContext;
    correlationId: string;
    /** WebDAV Basic Auth 验证通过的账号（仅 /dav 路由使用） */
    davAccount: import('../db/repo').DavAccountRow;
    /** 从节点 RPC：验签通过的节点行（仅 /api/v4/slave 路由使用） */
    slaveNode: import('../db/types').NodeRow;
    /** 从节点 RPC：已读出的原始正文（中间件消费掉 body，这里带下去） */
    slaveBody: string;
  };
}

/** 路由处理函数里收到的 Hono 上下文类型。 */
export type AppRequest = Context<AppBindings>;

/** 带上安全响应头（所有经 Worker 的响应，含缓存写回的那份）。 */
export function securityHeaders(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    // 不把完整 URL（可能含分享密码 / 直链签名）带给第三方站点
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    // 不允许外部页面套 iframe（拖框点击 / 界面伪装），同源内嵌（PDF 预览）照常
    c.header('X-Frame-Options', 'SAMEORIGIN');
    await next();
  };
}

/** 从请求头解析当前用户。settings 由调用方复用，避免重复打 KV/DB。 */
async function resolveUser(
  env: Env,
  header: string | null,
  settings: SettingsProvider,
  db: DbHandle,
): Promise<{ user: UserWithGroup; claims: import('../lib/jwt').Claims | null } | undefined> {
  if (!header) return undefined;
  // HMAC 签名请求不是 JWT，跳过
  if (header.startsWith(TokenHeaderPrefixCr)) return undefined;
  if (!header.startsWith(TokenHeaderPrefix)) return undefined;

  const tokenStr = header.slice(TokenHeaderPrefix.length);
  if (!tokenStr) return undefined;

  const jwt = new JWTService(settings.secretKey);
  const claims = await jwt.verify(tokenStr);
  if (!claims || claims.token_type !== 'access') return undefined;

  const codec = new HashIDCodec(settings.hashIdSalt);
  const uid = codec.decodeUserID(claims.sub);
  if (uid === null) return undefined;

  // 走缓存：首屏会并发 6~8 个请求，每个都查一次 `users JOIN groups`
  // 是免费档 Neon 最烧不起的开销（180~550ms/次，并发高了还回 5xx）。
  // L1 内存命中 0 往返，L2(KV) 命中 1 次 KV get —— 见 services/userCache.ts。
  const user = await getCachedUser(env, db.sql, uid);
  if (!user) return undefined;

  // 把 claims 一并带出去 —— 调用方需要 client_id / scopes，
  // 原实现为此**又验了一遍同一个 JWT**（HMAC 计算白烧一次 CPU）。
  return { user, claims };
}

/** 装配请求上下文。每个请求一次。 */
export function appContext(): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const startedAt = performance.now();
    const env = c.env;
    const correlationId = c.req.header('X-Correlation-ID') ?? crypto.randomUUID();
    c.set('correlationId', correlationId);

    // 记下本 isolate 的 env，供仓储层写用户后清缓存用（见 userCache.ts）。
    rememberEnv(env);
    // 策略缓存同样需要 env 做 KV 回填/失效（见 policyCache.ts）。
    rememberPolicyEnv(env);

    // 数据库句柄：本请求**唯一**的库引用。整个请求生命周期内不再重解析，
    // 保证 11 个 repo 与所有裸 SQL 都落在同一个库上（多库模型的硬约束，
    // 见 db/shard.ts）。
    const db = resolveDb(env);

    // 设置读取：入口处已经预取过就直接用那份 Promise（与自举标记并行），
    // 否则现读（内存 / colo 缓存 / KV / 数据库，见 settings/provider.ts）。
    const prefetchedSettings = consumePrefetchedSettings();
    // waitUntil 必须包一层箭头函数：直接传 `c.executionCtx.waitUntil` 这种
    // 未绑定原方法会抛 Illegal invocation（踩过，缓存写入静默丢失）。
    const waitUntil = (p: Promise<unknown>) => c.executionCtx.waitUntil(p);
    let settings: SettingsProvider;
    if (prefetchedSettings) {
      try {
        settings = await prefetchedSettings;
      } catch {
        settings = await loadSettings(env, db, waitUntil);
      }
    } else {
      settings = await loadSettings(env, db, waitUntil);
    }
    const settingsMs = performance.now() - startedAt;

    // 生成型设置被清空时自愈（只多做两次 Map 命中，没有额外网络开销）：
    //   - `secret_key` 空 → JWT 用空密钥签，任何人都能伪造管理员 token；
    //   - `hash_id_salt` 空 → hashid 退化成无盐混淆，ID 可被离线枚举。
    // 自举只在首次部署跑一次，之后被手工清空就没人管；这里发现就异步补一份
    // 随机值。本次请求仍会因 `secretKey` 抛错而失败（宁可 500 也不能不安全），
    // 但下一个请求就恢复正常。
    if (!settings.get('secret_key') || !settings.get('hash_id_salt')) {
      waitUntil(ensureSettings(env, db).catch(() => undefined));
    }

    const codec = new HashIDCodec(settings.hashIdSalt);
    const jwt = new JWTService(settings.secretKey);

    let scopes: string[] | undefined;
    const header = c.req.header('Authorization') ?? null;
    const resolved = await resolveUser(env, header, settings, db);
    const user = resolved?.user;
    const authMs = performance.now() - startedAt;

    // 只有 OAuth 客户端签发的 token 才带 scope，内置登录不受 scope 限制。
    // 复用 resolveUser 已经验过的 claims，不再重复验签。
    if (user && resolved?.claims?.client_id) {
      scopes = resolved.claims.scopes;
    }

    // 购买用户组到期惰性回退（edge 自建 Pro 功能）：没有后台定时任务，
    // 就在解析出用户后检查一次；过期则回退到购买前的组并清掉记录。
    // 失败静默吞掉——这里出错不该让整个请求挂掉。
    if (user?.settings?.group_pack) {
      const pack = user.settings.group_pack;
      const expired = pack.expire_at && new Date(pack.expire_at).getTime() <= Date.now();
      if (expired) {
        try {
          const repo = new UserRepo(db.sql);
          // 一条语句清 group_pack + 回退组：不整行覆盖 settings，
          // 否则会把并发的容量包/积分一起抹掉（这里是每个请求都可能走到的路径）。
          await repo.clearGroupPack(user.id, pack.prev_group_id);
          user.group_users = pack.prev_group_id;
          user.settings = { ...(user.settings ?? {}), group_pack: null };
          const g = await repo.byIdWithGroup(user.id);
          if (g) {
            user.group = g.group;
          }
          // 组变了 → 缓存必须失效，否则其他请求还会拿到「已过期但仍是高级组」
          // 的用户，等于购买到期后权限没收回。
          await invalidateUser(env, user.id);
        } catch {
          // 回退失败保持现状，下个请求再试
        }
      }
    }

    const appCtx = new AppContext(env, settings, codec, jwt, user, scopes, db);
    stageInit(appCtx);
    // 客户端 IP 只有这一层拿得到（服务层没有 Request）。分享密码的失败限速要用。
    appCtx.clientIp =
      c.req.header('CF-Connecting-IP')?.trim() ||
      (c.req.header('X-Forwarded-For') ?? '').split(',')[0]?.trim() ||
      'unknown';
    // 后台任务挂钩：把「发信」这类不能阻塞响应、又不该丢的工作挂到
    // Workers 的 waitUntil 上（对应原版的常驻队列发信）。
    appCtx.setBackgroundHooks({
      waitUntil: (p) => c.executionCtx.waitUntil(p),
      onQuotaExceeded: (u) => {
        // 原版 Pro 的 mail_exceed_quota_template：配额超出时发通知邮件。
        // KV 限频 24h/用户，否则一次批量上传能把邮箱塞爆。
        const kv = kvFor(env, 'session');
        if (!kv) return;
        c.executionCtx.waitUntil(
          (async () => {
            const key = `mail_exceed_quota_sent_${u.id}`;
            try {
              if (await kv.get(key)) return;
              await kv.put(key, '1', { expirationTtl: 86_400 });
              const mail = new MailService(appCtx);
              if (mail.available) await mail.sendExceedQuotaEmail(u);
              logAudit(appCtx, 'user_exceed_quota_notified', u.id);
            } catch {
              // 通知是尽力而为，任何失败都吞掉
            }
          })(),
        );
      },
    });
    c.set('ctx', appCtx);
    c.header('X-Correlation-ID', correlationId);

    await next();

    // 服务端各阶段耗时。外面测到的 TTFB 混了链路与代理抖动，这个头才是
    // 「Worker 自己花了多少」：settings=读设置（KV 命中就很小）、auth=解析登录态、
    // total=整个请求。慢的时候先看这三段谁大。
    const totalMs = performance.now() - startedAt;
    try {
      // 服务层打的分段（resolve/list/meta/…），有才拼 —— 诊断「一段查询占了
      // 大头」用，平时是空串不影响。
      const extra = (stagesOf(appCtx) ?? [])
        .map((s) => `, ${s.name};dur=${s.ms.toFixed(1)}`)
        .join('');
      c.header(
        'Server-Timing',
        `settings;dur=${settingsMs.toFixed(1)}, auth;dur=${authMs.toFixed(1)}, total;dur=${totalMs.toFixed(1)}${extra}`,
      );
    } catch {
      // 响应头已定稿（例如上游直接返回了不可变的 Response）就放弃这个诊断头
    }
  };
}

/** 取当前请求上下文。 */
export function ctxOf(c: Context<AppBindings>): AppContext {
  return c.get('ctx');
}

/** 取当前用户，未登录抛 401（由全局错误处理转成标准响应）。 */
export function requireUser(c: Context<AppBindings>): UserWithGroup {
  return ctxOf(c).requireUser();
}

export { TokenHeaderPrefix, TokenHeaderPrefixCr };
export type { Next };
