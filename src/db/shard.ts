/**
 * 请求级数据库解析（"分片"，但只有一个可写主库）。
 *
 * ## 模型
 *
 * 这是**单写多读**结构，不是分库：
 *
 *   - **主库**（`DATABASE_URL`）：唯一可写。所有业务读写都打它。
 *   - **备库**（`DATABASE_URL_2..5`）：冷备。请求**永远不打**，只在
 *     「构建期全量同步」（`scripts/db-sync.mjs` → `db/replicate.ts`）
 *     时作为复制目标，以及主库彻底不可用且 `DB_FAILOVER=1` 时被提升。
 *
 * 为什么不做真正的分库（按 user.id 取模把数据切开）：那会立刻引入
 * 跨库事务不存在、`users.email` 全局唯一性失效、管理后台只能看到一片
 * 用户等语义问题。而它的收益（分摊单库压力）在**单写主库**下根本拿不到
 * —— 分库的写压力是分摊的，不是冗余的。你要的是冗余，所以这里只做冗余。
 *
 * ## 为什么「请求只打主库」这条要在代码里显式表达
 *
 * 因为「备库接流量」和「构建期从主库全量覆盖」是**互斥**的：
 * 一旦请求能写备库，那些写入会在下次全量同步时被主库内容冲掉，
 * 静默丢数据。把这个约束写成一个小模块，比散落在 60 个调用点里
 * 靠自觉遵守要可靠得多。
 */
import type { Env } from '../env';
import {
  backupDatabaseUrls,
  failoverEnabled,
  getSql,
  primaryDatabaseUrl,
  resolveProvider,
  setDefaultProvider,
  sqlForUrl,
  type Sql,
} from './index';

/** 解析结果：客户端 + 本次请求实际绑定到哪个库。 */
export interface DbHandle {
  sql: Sql;
  /**
   * 库索引：`0` = 主库，`1+` = 备库（`DATABASE_URL_{index+1}`）。
   * 会写进日志和响应头，方便排查「这次请求到底落在哪」。
   */
  index: number;
  /** 从哪个 env 变量来的（`DATABASE_URL` / `DATABASE_URL_2` ...），仅用于诊断。 */
  source: string;
  /** 是否已降级到备库（主库不可用且开了 DB_FAILOVER）。 */
  degraded: boolean;
}

const SOURCE_NAMES = [
  'DATABASE_URL',
  'DATABASE_URL_2',
  'DATABASE_URL_3',
  'DATABASE_URL_4',
  'DATABASE_URL_5',
] as const;

/**
 * 主库健康状态的 isolate 级缓存。
 *
 * 存在的意义：`resolveDb()` 是**每个请求**都要走的热路径。如果每次都先
 * 探一次主库可用性，等于给所有请求加一次额外的 DB 往返（~300ms）。
 * 所以这里只在**主库已经失败过**的情况下才记住状态，并带一个短 TTL：
 *
 *   - 正常情况下 `healthy = true`，零额外开销（不探测，直接用）。
 *   - 主库失败后记 `downUntil`，TTL 内直接走备库，不再白等主库超时
 *     （主库超时实测最长 122 秒，逐请求重试会让站点整体卡死）。
 *   - TTL 到了再放一次请求去试主库，成功即恢复。
 *
 * 一个 isolate 的内存状态，不跨 isolate 共享 —— 这是刻意的：不同 isolate
 * 各自探测，能最快收敛到真实状态，而共享状态（比如写 KV）反而会引入
 * 「一个 isolate 误判、全体降级」的风险。
 */
const HEALTH_TTL_MS = 30_000;
let primaryDownUntil = 0;

/** 测试 / 手动恢复用：清掉主库降级状态。 */
export function resetPrimaryHealth(): void {
  primaryDownUntil = 0;
}

/**
 * 解析出本次请求使用的数据库客户端。
 *
 * 正常路径（主库健康）：一次 `primaryDatabaseUrl()` + Map 查缓存，无 IO。
 * 降级路径（主库刚失败过）：TTL 内直接返回备库，不做探测。
 */
export function resolveDb(env: Env): DbHandle {
  const primary = primaryDatabaseUrl(env);
  // 绑了 Hyperdrive 时运行时可以只靠 HYPERDRIVE.connectionString，不配
  // DATABASE_URL 也能跑（DATABASE_URL 仍留给迁移/种子脚本）。
  if (!primary && !env.HYPERDRIVE?.connectionString) {
    throw new Error('DATABASE_URL is not configured');
  }

  const provider = resolveProvider(env);
  setDefaultProvider(provider);

  const backups = backupDatabaseUrls(env);
  const now = Date.now();

  // 主库健康，或没有备库可切 → 直接用主库
  if (!backups.length || now >= primaryDownUntil) {
    return { sql: getSql(env), index: 0, source: SOURCE_NAMES[0], degraded: false };
  }

  // 已在降级窗口内
  if (!failoverEnabled(env)) {
    // 没开故障切换：仍然用主库。让真实错误抛出去（错误文案已在
    // lib/response.ts 里转成可读提示），而不是静默写到备库。
    return { sql: getSql(env), index: 0, source: SOURCE_NAMES[0], degraded: false };
  }

  const backupIndex = 0; // 备库按配置顺序取第一个
  return {
    sql: sqlForUrl(backups[backupIndex]!.url, provider),
    index: backupIndex + 1,
    source: backups[backupIndex]!.name,
    degraded: true,
  };
}

/**
 * 记录一次数据库失败。
 *
 * 只有**主库**的失败才触发降级窗口；备库失败不影响（备库本来就只在
 * 降级期间使用，它再失败就让请求按原样报错）。
 */
export function noteDbFailure(index: number): void {
  if (index !== 0) return;
  primaryDownUntil = Date.now() + HEALTH_TTL_MS;
}

/** 记录一次数据库成功：主库恢复 → 立刻取消降级窗口。 */
export function noteDbSuccess(index: number): void {
  if (index !== 0) return;
  primaryDownUntil = 0;
}

/** 当前是否处于降级状态（诊断 / 健康检查端点用）。 */
export function isDegraded(): boolean {
  return Date.now() < primaryDownUntil;
}

// ---------------------------------------------------------------------------
// 分域库（多库分摊：_2=日志域，_3=元数据域）
// ---------------------------------------------------------------------------

/**
 * 「分域」与上面 failover 的关系：
 *
 *   - `DATABASE_URL_2` / `DATABASE_URL_3` 是**干活域**：分别承载
 *     `audit_logs`（写极多的审计日志）与 `metadata`（列表热路径的文件
 *     元数据），把这两类与核心表（users/files/entities/shares…）天然
 *     无 JOIN、无同库事务的数据从主库分走 —— 主库往返减少，单库限流
 *     压力直接下降。
 *   - `DATABASE_URL_4` / `_5` 维持**冷备**语义（构建期全量同步 + 主库
 *     故障切换），不参与分域。
 *   - 域库独立于主库的 failover：主库挂了切备库，但审计/元数据继续打
 *     各自的域库（数据都在那边），互不影响。
 *   - **只配主库时域解析回退主库**，绝不往不存在的库写一行。
 *
 * 健康降级：域库失败过（cron 探活 or 查询报错）后，30s 内该域回退主库
 * —— 主库上对应表的 schema 永远保留（迁移只搬数据不删表），回退可用。
 */
const DOMAIN_DOWN_TTL_MS = 30_000;
const domainDownUntil = new Map<string, number>();

export type DomainName = 'audit' | 'metadata';

const DOMAIN_SOURCE: Record<DomainName, string> = {
  audit: 'DATABASE_URL_2',
  metadata: 'DATABASE_URL_3',
};

/**
 * 记录某分域库一次失败：TTL 内该域回退主库。
 * 运行时查询失败用短 TTL（30s，自愈快）；建表/搬迁失败用长 TTL
 * （persistDomainDown 落 KV，1h，等 cron 修好）。
 */
export function noteDomainFailure(domain: DomainName, ttlMs = DOMAIN_DOWN_TTL_MS): void {
  domainDownUntil.set(domain, Date.now() + ttlMs);
}

/** 某分域库恢复成功：取消降级窗口。 */
export function noteDomainSuccess(domain: DomainName): void {
  domainDownUntil.delete(domain);
}

/**
 * 把「域不可用」持久化到 KV（TTL 秒）——跨 isolate 生效。
 * 冷启动/自举时用 `applyDomainDownFromKv` 装回内存。
 */
export async function persistDomainDown(env: Env, domain: DomainName, ttlSeconds: number): Promise<void> {
  domainDownUntil.set(domain, Date.now() + ttlSeconds * 1000);
  try {
    const { kvFor } = await import('../lib/kvRouter');
    await kvFor(env, 'flag').put(`shard:down:${domain}`, '1', { expirationTtl: ttlSeconds });
  } catch {
    // KV 不可用时内存降级仍生效
  }
}

/** 清除 KV 里的持久降级（域库修好后 cron 调用）。 */
export async function clearDomainDown(env: Env, domain: DomainName): Promise<void> {
  domainDownUntil.delete(domain);
  try {
    const { kvFor } = await import('../lib/kvRouter');
    await kvFor(env, 'flag').delete(`shard:down:${domain}`);
  } catch {
    // ignore
  }
}

/**
 * 冷启动时把 KV 里的持久降级装回内存。resolveDomainHandle 是同步热路径
 * （不能每请求读 KV），所以在自举/cron 里调用一次即可覆盖整个 isolate。
 */
export async function applyDomainDownFromKv(env: Env): Promise<void> {
  // 没配分域的部署（绝大多数）根本不会有降级键：直接返回，冷启动**一次 KV
  // 都不读**。原来这里固定串行读两个键，等于给每个新 isolate 的首个请求
  // 白加两跳 KV（各几十到几百毫秒）。
  const configured = (['audit', 'metadata'] as const).filter((domain) => {
    const raw = (env as unknown as Record<string, string | undefined>)[DOMAIN_SOURCE[domain]]?.trim();
    return Boolean(raw);
  });
  if (configured.length === 0) return;

  try {
    const { kvFor } = await import('../lib/kvRouter');
    const kv = kvFor(env, 'flag');
    // 两个键并行读：串行会让冷启动成本翻倍。
    const flags = await Promise.all(
      configured.map((domain) => kv.get(`shard:down:${domain}`).catch(() => null)),
    );
    configured.forEach((domain, i) => {
      if (flags[i]) {
        // 具体剩余 TTL 拿不到，给足一个保守窗口；cron 每小时会重新评估
        domainDownUntil.set(domain, Date.now() + 60 * 60 * 1000);
      }
    });
  } catch {
    // KV 不可用就不装，靠运行时查询失败触发短降级
  }
}

/** 解析分域库句柄：`DATABASE_URL_2`/`_3` 存在且健康 → 域库；否则回退主库。 */
export function resolveDomainHandle(env: Env, domain: DomainName): DbHandle {
  const raw = (env as unknown as Record<string, string | undefined>)[DOMAIN_SOURCE[domain]]?.trim();
  const primary = primaryDatabaseUrl(env);
  const url = raw && raw !== primary ? raw : null;

  if (!url || Date.now() < (domainDownUntil.get(domain) ?? 0)) {
    return { sql: getSql(env), index: 0, source: SOURCE_NAMES[0], degraded: url !== null };
  }

  // 域库客户端创建是同步的：连接串畸形时 neon() 直接抛异常，而本函数在
  // AppContext 构造里 —— 不兜住就是「全站每个请求 500」。抛错即视为该域
  // 短期不可用，回退主库（30s 后重试；连接串修好后自然恢复）。
  try {
    return {
      sql: sqlForUrl(url, resolveProvider(env)),
      index: domain === 'audit' ? 1 : 2,
      source: DOMAIN_SOURCE[domain],
      degraded: false,
    };
  } catch (e) {
    noteDomainFailure(domain);
    console.error(`domain "${domain}" client init failed, falling back to primary:`, e instanceof Error ? e.message : String(e));
    return { sql: getSql(env), index: 0, source: SOURCE_NAMES[0], degraded: true };
  }
}

/**
 * 在指定数据库上执行一段操作，并在成功 / 失败时更新健康状态。
 *
 * 调用方（`AppContext`）用它包一层，这样任何一次业务查询的成败都会
 * 自动反馈到 `primaryDownUntil`，无需业务代码关心。
 */
export async function runWithHealth<T>(handle: DbHandle, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    noteDbSuccess(handle.index);
    return out;
  } catch (err) {
    noteDbFailure(handle.index);
    throw err;
  }
}
