/**
 * PostgreSQL 访问层（多驱动）。
 *
 * 两套驱动、同一套 SQL 与迁移：
 *   - Neon：`@neondatabase/serverless` 的 HTTP 驱动，一次查询一次 fetch；
 *   - 其它 PostgreSQL（Supabase / CockroachDB / Xata / Prisma Postgres /
 *     Railway / Render / 自建）：postgres.js 的 `workerd` 构建，走线协议。
 *
 * 驱动返回格式有差异，读取路径统一过 `toNum()` / `toBytes()`：
 *   1. BIGINT 可能以 **字符串** 返回（避免 JSON 精度丢失）；
 *   2. BYTEA 可能是十六进制字符串（`\x0102`）或 Uint8Array。
 */
import { neon, neonConfig } from '@neondatabase/serverless';
import { buildPgSql, createPgClient } from './pgSql';
import type { Env } from '../env';

/**
 * 支持的数据库驱动。
 *
 *   - `neon`：`@neondatabase/serverless` 的 HTTP 驱动，一次查询一次 fetch，
 *     无需连接池，是 Neon 上最快的路径（也是本项目原本的行为）。
 *   - `postgres`：postgres.js（有专门的 `workerd` 构建），走标准 PostgreSQL
 *     线协议。Supabase / CockroachDB / Xata（Postgres）/ Prisma Postgres /
 *     Railway / Render / 自建 Postgres 都用它。
 *
 * 两者共用同一套 SQL 与迁移 —— 整个数据层是 PostgreSQL 方言，换驱动不改查询。
 */
export type DbProvider = 'neon' | 'postgres';

/**
 * 单条查询：可 `await`，PG 适配层还额外携带 `text` / `values` 供事务复用。
 *
 * 结构上兼容 Neon 的 `NeonQueryPromise`，所以 repo 里的
 * `await this.sql\`...\`` 与 `sql.transaction([...])` 都不用改。
 */
export interface SqlQuery<T = Record<string, unknown>> extends Promise<T[]> {
  readonly text?: string;
  readonly values?: readonly unknown[];
}

/**
 * 数据库句柄。
 *
 * `db/repo.ts` 不接收 `env` 而是接收它，`assertSameSql()` 靠引用相等
 * 拒绝跨库混用。
 */
export interface Sql {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): SqlQuery<T>;
  <T = Record<string, unknown>>(text: string, values?: readonly unknown[]): SqlQuery<T>;
  transaction<T = Record<string, unknown>>(queries: readonly SqlQuery<T>[]): Promise<T[][]>;
}

// ---------------------------------------------------------------------------
// 驱动选择
// ---------------------------------------------------------------------------

let defaultProvider: DbProvider | null = null;

/** 当前运行环境选定的驱动（由 getSql / resolveDb 设置）。 */
export function setDefaultProvider(provider: DbProvider): void {
  defaultProvider = provider;
}

function providerFromEnv(): DbProvider | null {
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const v = (g.process?.env?.DB_PROVIDER ?? '').trim().toLowerCase();
  if (v === 'neon') return 'neon';
  if (v === 'postgres') return 'postgres';
  return null;
}

/** 按 URL 猜测驱动：Neon 的域名走 HTTP，其余一律走标准 PG 协议。 */
export function providerOfUrl(url: string): DbProvider {
  return (
    defaultProvider ??
    providerFromEnv() ??
    (/neon\.tech|neon\.build/i.test(url) ? 'neon' : 'postgres')
  );
}

/**
 * 解析本次部署该用哪个驱动。
 *
 * 优先级：显式 `DB_PROVIDER` > 绑定了 Hyperdrive（走 postgres）> URL 域名。
 * 现有 Neon 部署不配任何新变量，仍然走 neon，行为完全不变。
 */
export function resolveProvider(env: Env): DbProvider {
  const explicit = (env.DB_PROVIDER ?? '').trim().toLowerCase();
  if (explicit === 'neon') return 'neon';
  if (explicit === 'postgres') return 'postgres';
  if (env.HYPERDRIVE?.connectionString) return 'postgres';
  const url = primaryDatabaseUrl(env) ?? '';
  return /neon\.tech|neon\.build/i.test(url) ? 'neon' : 'postgres';
}

/**
 * 运行时主库连接串：绑了 Hyperdrive 就用它的本地地址（边缘连接池），
 * 否则用 `DATABASE_URL`。迁移/种子脚本仍然读 `DATABASE_URL`。
 */
export function primaryRuntimeUrl(env: Env): string | undefined {
  if (resolveProvider(env) === 'postgres') {
    const hyper = env.HYPERDRIVE?.connectionString?.trim();
    if (hyper) return hyper;
  }
  return primaryDatabaseUrl(env);
}

/** 连接串秘密名 → 部署页展示用。下标 1 是主库。 */
const DB_SECRET_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_2',
  'DATABASE_URL_3',
  'DATABASE_URL_4',
  'DATABASE_URL_5',
] as const;

/** 单次请求内允许访问的最大库数（硬上限定为 5，与构建期校验一致）。 */
export const MAX_DATABASES = 5;

/**
 * 每个连接串的客户端缓存。
 *
 * **以连接串为键而不是以 env 为键**：同一个 Worker 进程内会同时持有主库
 * 与备库两个客户端（同步任务），以 env 为键会让它们互相顶掉。
 * `neon()` 每次调用都新建一个查询函数，缓存是为了避免每个请求都重建。
 */
const clients = new Map<string, Sql>();

/** 取指定连接串的客户端（带缓存）。不做任何可用性判断。 */
export function sqlForUrl(url: string, provider?: DbProvider): Sql {
  const p = provider ?? providerOfUrl(url);
  const key = `${p}\u0000${url}`;
  const cached = clients.get(key);
  if (cached) return cached;
  if (!url) throw new Error('数据库连接串为空');

  let sql: Sql;
  if (p === 'neon') {
    installRetryingFetch();
    sql = neon(url) as unknown as Sql;
  } else {
    sql = buildPgSql(createPgClient(url));
  }
  clients.set(key, sql);
  return sql;
}

/**
 * 收集 env 上全部已配置的连接串，主库在前。
 *
 * 主库（`DATABASE_URL`）为必需；备库按 _2.._5 顺序收集，空字符串与
 * 重复项会被剔除（同一连接串配两遍没有意义，还会让同步任务自己覆盖自己）。
 */
export function databaseUrls(env: Env): string[] {
  const raw = env as unknown as Record<string, string | undefined>;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of DB_SECRET_NAMES) {
    const v = raw[name]?.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

export function primaryDatabaseUrl(env: Env): string | undefined {
  return databaseUrls(env)[0];
}

/** 分域库连接串（按环境变量名取，不做压缩对齐——_2 就是日志域，_3 就是元数据域）。 */
function domainUrlByName(env: Env, name: string): string | null {
  const v = (env as unknown as Record<string, string | undefined>)[name]?.trim();
  if (!v) return null;
  // 连接串格式校验：管理后台手填容易带空格/引号/缺协议，坏串不能让它
  // 流进 neon()（构造时同步抛异常会把整个 AppContext 打挂，全站 500）
  try {
    const u = new URL(v.includes('://') ? v : `postgres://${v}`);
    if (!u.hostname) return null;
  } catch {
    return null;
  }
  // 与主库相同连接串 → 不算独立域（避免同库自同步/自引用）
  return v === primaryDatabaseUrl(env) ? null : v;
}

/** 日志域（audit_logs）。配了 `DATABASE_URL_2` 且不同于主库时返回其连接串。 */
export function auditDomainUrl(env: Env): string | null {
  return domainUrlByName(env, 'DATABASE_URL_2');
}

/** 元数据域（metadata）。配了 `DATABASE_URL_3` 且不同于主库时返回其连接串。 */
export function metadataDomainUrl(env: Env): string | null {
  return domainUrlByName(env, 'DATABASE_URL_3');
}

/** 冷备连接串（不含主库）。用于全量同步的写入端与故障切换的候选。 */
export function backupDatabaseUrls(env: Env): string[] {
  return databaseUrls(env).slice(1);
}

/**
 * 故障切换是否开启。`DB_FAILOVER=1` / `true` / `yes` 视为开启。
 * 缺省关闭 —— 主库挂了直接报错，比「静默写到备库、下次同步被覆盖」安全。
 */
export function failoverEnabled(env: Env): boolean {
  return /^(1|true|yes)$/i.test(env.DB_FAILOVER?.trim() ?? '');
}

/**
 * 取当前 env 对应的 SQL 客户端（主库）。
 *
 * 免费档 Neon 在并发突发时会回 5xx（实测并发 6 路 x 24 请求有 14 个失败，
 * 状态码 520 / 522 / 525 混杂，最长一次耗了 122 秒），用户侧表现为
 * 「数据库操作失败 (Server error (HTTP status 520))」。原先只有
 * `provision.ts` / `settings/provider.ts` 手动调 withRetry，**所有业务查询
 * （repo.ts 的 11 个类）完全没有重试**，一次抖动就直接报错。
 *
 * 重试只装一次（`neonConfig.fetchFunction`），在 **fetch 层**做：
 *   - 驱动 `execute()` 里读的是**模块级单例** `pg.defaults.fetchFunction`，
 *     传 `neon(url, {fetchFunction})` 是无效的（实测该选项根本到不了 fetch 调用点），
 *     必须走 `neonConfig` 这个全局入口；
 *   - 装在这一层对驱动完全透明：单条查询、`sql('...', params)`、
 *     `sql.transaction([...])` 全部自动覆盖，不需要逐个改调用点；
 *   - 早于驱动 `throw`，所以不会出现「驱动已把响应体读完、重试却要重放查询」
 *     的错位，也不依赖 `NeonQueryPromise` 的惰性求值语义。
 *
 * **多库**：重试装在配置层，所以对**全部**库（主库 + 备库）统一生效，
 * 不需要按库分别安装。
 */
export function getSql(env: Env): Sql {
  const provider = resolveProvider(env);
  const url = primaryRuntimeUrl(env);
  if (!url) throw new Error('DATABASE_URL is not configured');
  setDefaultProvider(provider);
  return sqlForUrl(url, provider);
}

/**
 * 声明一个 Sql 的来源连接串。
 *
 * 给 repo 用：repo 的构造函数可能收到「已解析好的客户端」（多库同步场景），
 * 也可能只收到 env（主库），两种情况都要能回答「我绑在哪个库上」。
 */
export function assertSameSql(a: Sql, b: Sql): boolean {
  return (a as unknown) === (b as unknown);
}

// ---------------------------------------------------------------------------
// fetch 层重试
// ---------------------------------------------------------------------------

/** 免费档 Neon 的网关在突发时会回这些状态；`429` 是显式限流。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fetchInstalled = false;

/**
 * 把 fetch 层重试装到 Neon 驱动上（幂等，全局只需一次）。
 *
 * 语义要点：**只在拿到可重试状态码时重试，用尽尝试次数后把原始响应交回驱动**，
 * 让驱动照旧抛 `Server error (HTTP status ...)`。这样：
 *   - 不吞错：最终失败的错误信息与不装重试时完全一致；
 *   - 不改契约：400（SQL 语法/约束）与 401（鉴权）立即透传，不浪费重试；
 *   - 请求体可重放：驱动传进来的 `init.body` 是已序列化的字符串，重试时原样复用。
 *
 * ⚠️ Workers 免费版单请求只有 50 个 subrequest，重试会成倍放大这个计数。
 * 之所以取 `ATTEMPTS = 4`（而不是更多）：本部署一个请求内的 DB 往返最多两三位数，
 * 正常路径一次就成（`passthrough`），只有当上游真在抖时才吃重试；4 次是
 * 「足够扛过一秒级的网关抖动」和「不把 subrequest 预算打光」之间的折中。
 * 需要更多次机会时，靠上层的 `withRetry` 再补（它重试的是整条查询）。
 */
function installRetryingFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;

  const realFetch: typeof fetch = neonConfig.fetchFunction ?? globalThis.fetch.bind(globalThis);
  const ATTEMPTS = 4;

  neonConfig.fetchFunction = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let lastRes: Response | undefined;
    let lastErr: unknown;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        lastRes = await realFetch(input as RequestInfo, init);
      } catch (err) {
        // fetch 层自己抛（连接被重置 / TLS 失败 / 上游断开）：也属瞬态
        lastErr = err;
        if (i === ATTEMPTS - 1) throw err;
        await sleep(300 * 2 ** i + Math.floor(Math.random() * 200));
        continue;
      }
      if (!isRetryableStatus(lastRes.status)) return lastRes;
      if (i === ATTEMPTS - 1) return lastRes; // 交回驱动，由它抛原始错误
      // 必须把失败响应体读掉，否则连接不会被释放
      try {
        await lastRes.text();
      } catch {
        /* 读不动就算了，不影响重试 */
      }
      await sleep(300 * 2 ** i + Math.floor(Math.random() * 200));
    }
    if (lastErr) throw lastErr;
    return lastRes!;
  };
}

// ---------------------------------------------------------------------------
// 业务层重试（withRetry）
//
// 注意：**fetch 层已经有一层重试**（见上方 `installRetryingFetch`），它会拦掉
// 绝大部分 5xx / 429 / 网络抖动。这里的 withRetry 是第二道防线，用途有二：
//   1. 覆盖 fetch 层用尽尝试后仍失败、但错误恰好属于瞬态的情况（多给几次机会）；
//   2. 给 `provision.ts` / `settings/provider.ts` 这类「整批操作」提供事务级重试
//      （一次 transaction = 一个 HTTP 请求，失败就整批重放，代价可控）。
// 驱动抛出的错误消息形如 `Server error (HTTP status 520): ...`，靠状态码识别。
// ---------------------------------------------------------------------------

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b429\b|rate.?limit|too many/i.test(msg);
}

/**
 * Neon HTTP 端点回 5xx 时的错误。驱动源码（`@neondatabase/serverless`
 * `execute`）在非 400 错误分支里抛
 * `new Error(\`Server error (HTTP status ${status}): ${body}\`)`，
 * 所以这里靠消息里的 `HTTP status <code>` 识别。
 *
 * 这些是**上游网关层的瞬态失败**（520 unknown / 522 connection timed out /
 * 503 / 504），不是 SQL 本身的错误 —— 对**只读查询**和**幂等写**重试是安全的。
 * Cloudreve 的写操作绝大多数是 `UPDATE ... WHERE id = ?` 这类幂等形态。
 */
export function isUpstream5xxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /HTTP status (\d{3})/.exec(msg);
  if (m) {
    const status = Number(m[1]);
    return status >= 500 && status <= 599;
  }
  return false;
}

/** fetch 层自己抛出的网络异常（连不上、TLS、连接被重置），也值得重试。 */
function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'TypeError' ||
    /network|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|connection/i.test(err.message)
  );
}

/**
 * 值得重试的瞬态错误：
 *   1. 限流（429）
 *   2. **上游网关 5xx**（520/522/503/504）—— 免费档 Neon 在并发突发时的
 *      典型表现，用户侧表现为「数据库操作失败 (HTTP status 520)」
 *   3. fetch 层网络异常
 *   4. **没有任何 message** 的错误（跨序列化边界丢内容）
 *
 * 正常的数据库错误（缺表、语法、约束冲突）都带明确 message 且非 5xx，
 * 不会被误重试。
 */
function isTransientError(err: unknown): boolean {
  if (isRateLimitError(err)) return true;
  if (isUpstream5xxError(err)) return true;
  if (isNetworkError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.trim().length === 0;
}

/** 带退避的重试：只对瞬态错误生效，其他错误原样抛出。 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts - 1) throw err;
      // 指数退避 + 抖动：并发突发时让重试错开，避免同一波请求同时回打
      await sleep(400 * 2 ** i + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr;
}

/**
 * 把可能以字符串形式返回的 BIGINT / NUMERIC 归一化成 number。
 * 数据库里 size / storage 这类值不可能超过 Number.MAX_SAFE_INTEGER
 * （2^53 字节 ≈ 9 PB），因此直接转换是安全的。
 */
export function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** 同上，但保留 null 语义。 */
export function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return toNum(v);
}

/** 把 bytea 列归一化成 Uint8Array。 */
export function toBytes(v: unknown): Uint8Array {
  if (!v) return new Uint8Array(0);
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    let hex = v;
    if (hex.startsWith('\\x')) hex = hex.slice(2);
    else if (hex.startsWith('0x')) hex = hex.slice(2);
    if (hex.length === 0) return new Uint8Array(0);
    // 容错：奇数长度时左侧补 0
    if (hex.length % 2 !== 0) hex = `0${hex}`;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  // KV 缓存复活：JSON.stringify(Uint8Array) 会把字节序列变成 {"0":1,"1":2} 的
  // 普通对象（数字键）。按数字键序还原字节；其余对象视为空。
  if (typeof v === 'object') {
    const keys = Object.keys(v)
      .filter((k) => /^\d+$/.test(k))
      .map(Number)
      .sort((a, b) => a - b);
    const src = v as Record<string, unknown>;
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      out[i] = Number(src[String(keys[i])]) & 0xff;
    }
    return out;
  }
  return new Uint8Array(0);
}

/** 把 Uint8Array 编码成 Postgres 的 bytea 十六进制字面量。 */
export function toByteaLiteral(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

/** JSON 列：驱动可能返回对象，也可能是字符串，统一解成对象。 */
export function toJson<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
  if (typeof v === 'object') return v as T;
  return fallback;
}

/** 时间列：驱动可能返回 Date 对象，也可能是 ISO 字符串。 */
export function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
}
