/**
 * 主库 → 备库全量同步（"每次构建把数据库同步一遍"）。
 *
 * ## 为什么是全量覆盖，以及它意味着什么
 *
 * 这个模块的语义是：**以主库为唯一事实来源，把备库刷成主库的完整副本。**
 * 每次构建（CI 里跑 `npm run db:sync`）执行一次。
 *
 * 这条语义有一个**必须记住的前提**：备库上任何不在主库里的数据都会消失。
 * 所以备库**绝对不能承接业务写入** —— 用户写到备库的东西会在下次同步时
 * 被静默冲掉。`db/shard.ts` 保证了正常路径下请求只打主库；`DB_FAILOVER=1`
 * 是唯一的例外，开启它就等于接受「故障期间写入的数据会在下次同步后丢失」。
 *
 * ## 为什么用 COPY 而不是逐行 INSERT
 *
 *   - **subrequest 预算**：Workers 免费版单请求 50 个 subrequest。逐行
 *     INSERT 一张 users 表（几百行）就爆了；COPY 整表导出是 **1 个请求**。
 *   - **速度**：COPY 是 Postgres 为批量搬运设计的路径，比 INSERT 快一个
 *     数量级。
 *   - **保真**：COPY 原样搬运 bytea / jsonb / 时间，不用逐个列做类型转换。
 *
 * 分批（`CHUNK_ROWS`）是为了避开单次响应体过大 —— Neon 的 HTTP 端点在
 * 响应体过大时会截断或报错，而一行一个文件的 `files` 表可能很大。
 *
 * ## 顺序
 *
 * 先清空再导入，且**按外键依赖的逆序清空、正序导入**。CN 表之间没有
 * 声明式外键（见 migrations/0001 注释），所以顺序错了不会报错，但会
 * 留下悬空引用；这里仍然按约定顺序做，减少日后的困惑。
 */
import type { Env } from '../env';
import { encodeCopyText } from '../lib/pgCopy';
import { sqlForUrl, withRetry, type Sql } from './index';
import { backupDatabaseUrls, primaryDatabaseUrl } from './index';

/**
 * 需要同步的表，按「被引用 → 引用者」顺序排列。
 *
 * 表名逐一对齐 `migrations/*.sql` 的 `CREATE TABLE` （已用 grep 核对），
 * 加上 `provision.ts` 里动态建的 `group_storage_policies`。**新增表时必须
 * 同步加到这里**，否则新表不会被复制；`verifyTables()` 会在同步前报出
 * 「主库有、备库没有」的表，防止漏加。
 *
 * 注意几个容易看错的：
 *   - `file_entities` 关联 files↔entities（不是 entities 的别名）；
 *   - `user_tasks` / `file_shares` / `user_shares` 都是**列名**不是表名；
 *   - `nodes` 边缘版用不到（NodeSettings 是设置项），但迁移里建了，照搬。
 */
const TABLES = [
  'settings',
  'storage_policies',
  'groups',
  'group_storage_policies',
  'nodes',
  'users',
  'files',
  'entities',
  'file_entities',
  'metadata',
  'shares',
  'share_purchases',
  'direct_links',
  'tasks',
  'dav_accounts',
  'passkeys',
  'oauth_clients',
  'oauth_grants',
  'user_oidc_bindings',
  'orders',
  'gift_codes',
  'audit_logs',
] as const;

/** 每批搬多少行。太大 → 单次响应体过大；太小 → subrequest 数上去了。 */
const CHUNK_ROWS = 500;

export interface SyncTableResult {
  table: string;
  rows: number;
  chunks: number;
  /** 跳过原因（表不存在等）；有值时 `rows` 恒为 0。 */
  skipped?: string;
}

export interface SyncReport {
  primary: string;
  backups: string[];
  startedAt: string;
  finishedAt: string;
  tables: SyncTableResult[];
  ok: boolean;
  error?: string;
}

/** 从连接串里取出 `user@host/db` 这种可安全打印的标识（抹掉密码）。 */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.username}@${u.host}${u.pathname}`;
  } catch {
    return '(unparsable url)';
  }
}

/** 表在当前库里存不存在。用 `to_regclass` 避免 information_schema 的大小写坑。 */
async function tableExists(sql: Sql, table: string): Promise<boolean> {
  const rows = (await sql`SELECT to_regclass(${`public.${table}`}) AS reg`) as Array<{
    reg: string | null;
  }>;
  return Boolean(rows[0]?.reg);
}

/** 取表的列名（按 attnum 顺序，与 COPY 输出的列序一致）。 */
async function columnsOf(sql: Sql, table: string): Promise<string[]> {
  const rows = (await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY ordinal_position
  `) as Array<{ column_name: string }>;
  return rows.map((r) => r.column_name);
}

/**
 * 把一张表从 `from` 搬到 `to`。
 *
 * 流程：读列 → `to` 上 TRUNCATE → 分批 `COPY ... TO STDOUT` 从源读、
 * `COPY ... FROM STDIN` 往目标写。
 *
 * 关于 `COPY ... TO STDOUT` 的返回值：Neon 的 HTTP 驱动在
 * `SELECT` 语义下把整个 COPY 输出当作**一个字符串**返回（字段名固定为
 * 某种内部名），这里不假设字段名，直接取第一行的第一个值。
 */
async function syncTable(
  from: Sql,
  to: Sql,
  table: string,
): Promise<SyncTableResult> {
  if (!(await tableExists(from, table))) {
    return { table, rows: 0, chunks: 0, skipped: '源库无此表' };
  }
  if (!(await tableExists(to, table))) {
    return { table, rows: 0, chunks: 0, skipped: '目标库无此表（先让它自举一次建表）' };
  }

  const columns = await columnsOf(from, table);
  if (columns.length === 0) {
    return { table, rows: 0, chunks: 0, skipped: '读不到列定义' };
  }

  // 目标表先清空。`CASCADE` 必需：0001_init.sql 里真的建了外键
  // （storage_policies→files/groups、files→metadata/shares/direct_links 等），
  // 不带 CASCADE 的 TRUNCATE 会在第一张被引用的父表上直接报
  // "cannot truncate a table referenced by a foreign key constraint"。反正后面会
  // 重新 COPY 灌入全部表，级联清空子表是安全的。
  await withRetry(() => to(`TRUNCATE TABLE ${ident(table)} CASCADE`));

  const colList = columns.map(ident).join(', ');
  let offset = 0;
  let chunks = 0;
  let total = 0;

  for (;;) {
    // 分批导出：文本格式、显式列序，保证与目标表列序无关（只依赖列名）。
    const copied = (await withRetry(
      () =>
        from(`COPY (SELECT ${colList} FROM ${ident(table)} ORDER BY 1 OFFSET ${offset} LIMIT ${CHUNK_ROWS}) TO STDOUT WITH (FORMAT text)`),
    )) as unknown;

    const text = firstStringValue(copied);
    if (!text) break;

    // ⚠️ `COPY ... TO STDOUT` **不输出表头**（列名走的是协议层的
    // RowDescription 字段，不是数据流）。已用本机 PostgreSQL 16.9
    // 在字节级验证：7 行数据 → 7 行输出，`cat -A` 看不到任何列名行。
    // 所以这里**不能**像 CSV 那样 slice(1)，否则每张表都会静默丢掉第一行。
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) break;

    await withRetry(() =>
      to(
        `COPY ${ident(table)} (${colList}) FROM STDIN WITH (FORMAT text)\n${lines.join('\n')}\n\\.\n`,
      ),
    );

    chunks += 1;
    total += lines.length;

    if (lines.length < CHUNK_ROWS) break;
    offset += CHUNK_ROWS;
  }

  return { table, rows: total, chunks };
}

/**
 * 从驱动返回的随便什么形状里抠出第一个字符串值。
 *
 * `COPY ... TO STDOUT` 的返回值形状在不同驱动版本里不一致：可能是
 * `[{ copy: '...' }]`、`[{ copy_to: '...' }]`，也可能是裸字符串。
 * 与其绑定某个具体字段名（版本一升级就炸），不如遍历取第一个字符串。
 */
function firstStringValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const row of v) {
      if (typeof row === 'string') return row;
      if (row && typeof row === 'object') {
        for (const val of Object.values(row as Record<string, unknown>)) {
          if (typeof val === 'string' && val.length > 0) return val;
        }
      }
    }
  }
  return null;
}

/** 标识符加引号，防注入也防保留字。表名/列名都是代码内常量，不来自用户输入。 */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * 同步前的一致性检查：主库里有、备库里没有的表。
 *
 * 漏表会导致「主库有数据、备库查询报 relation does not exist」——
 * 在故障切换时是致命的（切过去站点直接 500）。所以宁可在这里报出来。
 */
export async function verifyTables(
  primary: Sql,
  backup: Sql,
): Promise<{ missingInBackup: string[] }> {
  const missingInBackup: string[] = [];
  for (const t of TABLES) {
    if ((await tableExists(primary, t)) && !(await tableExists(backup, t))) {
      missingInBackup.push(t);
    }
  }
  return { missingInBackup };
}

export interface SyncOptions {
  /** 只同步这些表（缺省全部）。 */
  only?: string[];
  /** 跳过这些表。 */
  skip?: string[];
  /** 是否在写入前后做表结构校验（缺省 true）。 */
  verify?: boolean;
  /** 进度回调（CI 里打日志用）。 */
  onProgress?: (msg: string) => void;
}

/**
 * 执行一次全量同步：主库 → 全部备库。
 *
 * `env.DB_SYNC_SKIP` 环境变量里的表名会被跳过（逗号分隔），
 * 与 `options.skip` 合并。
 */
export async function syncDatabases(env: Env, options: SyncOptions = {}): Promise<SyncReport> {
  const startedAt = new Date().toISOString();
  const primaryUrl = primaryDatabaseUrl(env);
  const backupUrls = backupDatabaseUrls(env);
  const log = options.onProgress ?? (() => {});

  const skipSet = new Set(
    [...(options.skip ?? []), ...(env.DB_SYNC_SKIP ?? '').split(',')]
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const onlySet = options.only?.length ? new Set(options.only) : null;

  const report: SyncReport = {
    primary: primaryUrl ? describeUrl(primaryUrl) : '(未配置)',
    backups: backupUrls.map((b) => `${b.name}(${describeUrl(b.url)})`),
    startedAt,
    finishedAt: startedAt,
    tables: [],
    ok: false,
  };

  if (!primaryUrl) throw new Error('DATABASE_URL 未配置，无法同步');
  if (backupUrls.length === 0) throw new Error('没有配置任何备库（DATABASE_URL_2..5），无需同步');

  const primary = sqlForUrl(primaryUrl);

  for (const [i, backup] of backupUrls.entries()) {
    log(`→ 同步到备库 ${i + 1}/${backupUrls.length}（${backup.name}）：${describeUrl(backup.url)}`);
    const backupSql = sqlForUrl(backup.url);

    if (options.verify !== false) {
      const { missingInBackup } = await verifyTables(primary, backupSql);
      if (missingInBackup.length > 0) {
        throw new Error(
          `备库缺少这些表：${missingInBackup.join(', ')}。` +
            `让备库先自举一次（把它的连接串临时配成 DATABASE_URL 部署一次），或手工建表。`,
        );
      }
    }

    for (const table of TABLES) {
      if (onlySet && !onlySet.has(table)) continue;
      if (skipSet.has(table)) {
        log(`  - ${table}：按配置跳过`);
        continue;
      }
      const r = await syncTable(primary, backupSql, table);
      report.tables.push(r);
      if (r.skipped) {
        log(`  - ${table}：跳过（${r.skipped}）`);
      } else {
        log(`  - ${table}：${r.rows} 行 / ${r.chunks} 批`);
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  report.ok = true;
  return report;
}

/**
 * 只把这些表从主库拷进**当前库**（用于备库提升后补齐自身缺失的数据）。
 *
 * 与 `syncDatabases` 的方向不同：这里是「往我自己这个库写」，
 * 供备库自举时使用。
 */
export async function pullFromPrimary(
  env: Env,
  target: Sql,
  tables: readonly string[] = TABLES,
): Promise<SyncTableResult[]> {
  const primaryUrl = primaryDatabaseUrl(env);
  if (!primaryUrl) throw new Error('DATABASE_URL 未配置');
  const primary = sqlForUrl(primaryUrl);
  const out: SyncTableResult[] = [];
  for (const t of tables) out.push(await syncTable(primary, target, t));
  return out;
}

export { TABLES as SYNC_TABLES, encodeCopyText };
