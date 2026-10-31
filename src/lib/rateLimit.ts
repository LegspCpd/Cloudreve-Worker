/**
 * 限速（登录、2FA、注册、找回密码、分享密码）。
 *
 * 一开始用 Workers KV 计数，**上线实测发现根本不生效**：KV 的读是最终一致的
 * （读可能命中最多 60 秒的旧值），「读-加一-写回」在连续请求里永远读到初始值，
 * 12 次登录尝试一次都没触发限制。一个静默失效的限速比没有更糟 —— 它给人一种
 * 已经被保护的错觉。
 *
 * 所以改成本地数据库里的原子计数：一条
 *   `INSERT ... ON CONFLICT DO UPDATE SET n = CASE WHEN window_start = $2 ...`
 * 由 Postgres 行锁串行化，跨 colo、跨 isolate 都是同一份计数，一次往返。
 * 代价是每次尝试多一次 ~250ms 的跨区往返（登录本来就要 2~3 次，可接受；
 * 分享密码只在**失败**时才计数，正常访客零成本）。
 *
 * 表结构见 `migrations/0014_rate_limits.sql`，窗口外的旧行由每日 cron 顺带清理。
 */
import type { Env } from '../env';
import { getSql } from '../db';

export interface RateLimitOptions {
  /** 限速维度名，例如 `login:email`、`share:pwd` */
  bucket: string;
  /** 具体对象：IP、邮箱、分享 id…… */
  id: string;
  /** 窗口内允许的次数 */
  limit: number;
  /** 窗口长度（秒） */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  /** 还要等多久（秒），ok=true 时为 0 */
  retryAfter: number;
  /** 本窗口内已计次数 */
  count: number;
}

/** 计数后端。默认走数据库；测试可以用内存实现。 */
export interface RateLimitStore {
  /** 记一次并返回本窗口内的累计次数。 */
  bump(key: string, windowStart: number): Promise<number>;
  /** 清掉某个键（登录成功后用）。 */
  reset(key: string): Promise<void>;
}

/** 窗口起点（Unix 秒，按 windowSec 对齐）。 */
export function windowStartOf(windowSec: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % windowSec);
}

/** 键：bucket + id + 窗口长度。id 里可能有冒号/邮箱，直接拼但带上长度更稳。 */
export function rateKeyOf(opts: RateLimitOptions): string {
  return `${opts.bucket}|${opts.windowSec}|${opts.id}`;
}

function sqlStore(env: Env): RateLimitStore {
  return {
    async bump(key, windowStart) {
      const sql = getSql(env);
      const rows = (await sql(
        `INSERT INTO rate_limits (key, window_start, hits)
         VALUES ($1, $2, 1)
         ON CONFLICT (key) DO UPDATE SET
           hits = CASE WHEN rate_limits.window_start = EXCLUDED.window_start
                       THEN rate_limits.hits + 1 ELSE 1 END,
           window_start = EXCLUDED.window_start
         RETURNING hits`,
        [key, windowStart],
      )) as Array<{ hits: number | string }>;
      return Number(rows[0]?.hits ?? 1);
    },
    async reset(key) {
      const sql = getSql(env);
      await sql('DELETE FROM rate_limits WHERE key = $1', [key]);
    },
  };
}

/**
 * 记一次访问。
 *
 * `ok=false` 表示已超限 —— **本次也计入**，否则超限期间免费，窗口一过又能
 * 满速打一轮。
 */
export async function hitRateLimit(
  env: Env,
  opts: RateLimitOptions,
  store: RateLimitStore = sqlStore(env),
): Promise<RateLimitResult> {
  const windowStart = windowStartOf(opts.windowSec);
  try {
    const count = await store.bump(rateKeyOf(opts), windowStart);
    if (count > opts.limit) {
      const now = Math.floor(Date.now() / 1000);
      return { ok: false, retryAfter: Math.max(1, opts.windowSec - (now - windowStart)), count };
    }
    return { ok: true, retryAfter: 0, count };
  } catch {
    // 计数失败**放行**：宁可在数据库出问题时让人登录，也不要因为计数表挂了
    // 把所有人锁在门外。
    return { ok: true, retryAfter: 0, count: 0 };
  }
}

/** 成功之后清掉计数（例如登录成功就别再拦这个人了）。 */
export async function clearRateLimit(
  env: Env,
  opts: RateLimitOptions,
  store: RateLimitStore = sqlStore(env),
): Promise<void> {
  try {
    await store.reset(rateKeyOf(opts));
  } catch {
    /* 尽力而为 */
  }
}

/** 取客户端 IP。Workers 上 `CF-Connecting-IP` 一定有；本地/测试回落到 XFF。 */
export function clientIp(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const cf = c.req.header('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = c.req.header('X-Forwarded-For');
  if (xff) return (xff.split(',')[0] ?? '').trim();
  return 'unknown';
}

/** 常用策略集中放这里，避免各处凭感觉写数字。 */
export const RATE_LIMITS = {
  /** 同一邮箱登录：10 次 / 分钟（正常用户不会打这么快） */
  loginByEmail: { bucket: 'login:email', limit: 10, windowSec: 60 },
  /** 同一 IP 登录：40 次 / 分钟（网吧/公司出口共用 IP 也要留余量） */
  loginByIp: { bucket: 'login:ip', limit: 40, windowSec: 60 },
  /** 同一 2FA 会话：6 次 / 分钟（6 位 TOTP 打满要 100 万年） */
  twoFactor: { bucket: 'login:2fa', limit: 6, windowSec: 60 },
  /** 同一 IP 注册：5 次 / 分钟 */
  registerByIp: { bucket: 'register:ip', limit: 5, windowSec: 60 },
  /** 同一 IP 发找回密码邮件：3 次 / 5 分钟（防被当成邮件轰炸机） */
  resetByIp: { bucket: 'reset:ip', limit: 3, windowSec: 300 },
  /** 同一分享 + IP 猜密码：10 次 / 分钟 */
  sharePassword: { bucket: 'share:pwd', limit: 10, windowSec: 60 },
  /**
   * 同一 IP 的 WebDAV 认证**失败**：30 次 / 分钟。
   * 定得比登录宽：客户端拿到 401 会重试几轮，且多人共用一个出口 IP 很常见；
   * 30 次/分钟已足够把在线爆破压到无意义的速率。
   */
  davAuthByIp: { bucket: 'dav:auth:ip', limit: 30, windowSec: 60 },
  /**
   * 同一 IP 的第三方登录回调：20 次 / 分钟。
   *
   * 每次回调都会拿 code 去 IdP 换 token、再拉一次 userinfo，打满会烧掉
   * 应用配额（QQ 互联、各类 OIDC 提供方都有日调用上限）。正常用户一分钟
   * 只走一次，20 次足够覆盖重试。
   */
  socialCallbackByIp: { bucket: 'social:cb:ip', limit: 20, windowSec: 60 },
} as const;
