/**
 * 分域库自举：建表 + 把存量数据从主库搬过去。
 *
 * ## 触发时机
 *
 *   1. 冷启动自举（index.ts bootstrap，在 provision/ensureSettings 之后）；
 *   2. 定时任务兜底（cron 每小时跑一次，幂等靠 KV 标记）——自举时域库
 *      恰好不可用的话，一小时后会自动补上。
 *
 * ## 语义
 *
 *   - `DATABASE_URL_2`（日志域）：建 `audit_logs`，搬主库存量行，之后
 *     新写入经 AuditRepo 直打域库；
 *   - `DATABASE_URL_3`（元数据域）：建 `metadata`（含唯一索引），搬存量；
 *   - **没配对应环境变量 → 该域整体跳过**，一行都不会往主库之外的库写；
 *   - 主库上对应表的 schema 永远保留（迁移只搬数据不删表）：域库故障时
 *     resolveDomainHandle 会回退主库（空表 = 功能降级但站点存活）。
 *
 * ## 幂等与并发
 *
 *   - DDL 全部 IF NOT EXISTS，天然幂等；
 *   - 数据搬迁用 KV 标记（`shard:migrated:<domain>`）只做一次；
 *   - 两个 isolate 并发迁移的竞态：metadata 有唯一索引（file_id,name），
 *     用 ON CONFLICT DO NOTHING 吞掉重复；audit_logs 无唯一键，并发窗口
 *     内可能出少量重复行（管理端日志展示层面的瑕疵，无害），KV 最终一致
 *     后窗口关闭。搬迁期间请求被自举闸门串行化，正常部署不会并发。
 */
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import { auditDomainUrl, metadataDomainUrl, primaryRuntimeUrl, sqlForUrl } from './index';
import { clearDomainDown, persistDomainDown } from './shard';
import type { Sql } from './index';

// DDL 逐条执行（Neon HTTP 单请求不保证多语句，provision 的教训）
const AUDIT_DDL = [
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id         BIGSERIAL   PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id    INTEGER,
    type       INTEGER     NOT NULL,
    meta       JSONB       NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE INDEX IF NOT EXISTS audit_logs_created_at ON audit_logs (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_type ON audit_logs (type)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_user_id ON audit_logs (user_id)`,
];

const METADATA_DDL = [
  `CREATE TABLE IF NOT EXISTS metadata (
    id         SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    name       TEXT    NOT NULL,
    value      TEXT    NOT NULL,
    file_id    INTEGER NOT NULL,
    is_public  BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS metadata_file_id_name ON metadata (file_id, name)`,
];

const BATCH = 500;

async function ensureDomainDdl(env: Env, domain: 'audit' | 'metadata', url: string): Promise<void> {
  const flag = `shard:ddl:${domain}`;
  const kv = kvFor(env, 'flag');
  if (await kv.get(flag)) return;
  const sql = sqlForUrl(url);
  for (const stmt of domain === 'audit' ? AUDIT_DDL : METADATA_DDL) {
    await sql(stmt);
  }
  await kv.put(flag, '1');
}

/**
 * 把主库一张表复制到域库（幂等，可断点续跑），全部复制完成后才清空主库侧。
 *
 * 两阶段的原因（v1 的教训）：「插一批删一批」中途失败会把数据劈成两半，
 * 任何一侧都不完整。改成「先复制到空、再统一清空」：复制用显式 id +
 * ON CONFLICT 幂等，失败重跑自动续；清空只在复制完成（SELECT 已为空）后
 * 执行。清空后又有新写入主库（降级窗口内的请求）也没关系——下次重跑
 * 会把这些行补搬过去。
 */
async function copyAndPurge(
  primary: Sql,
  domain: Sql,
  table: 'audit_logs' | 'metadata',
  insertRows: (rows: Record<string, unknown>[]) => Promise<void>,
): Promise<void> {
  // phase 1：复制。按 id 游标推进；失败重跑从主库剩余行继续（幂等）。
  let lastId = 0;
  for (let round = 0; round < 10000; round++) {
    const rows =
      table === 'audit_logs'
        ? ((await primary`SELECT id, created_at, user_id, type, meta FROM audit_logs WHERE id > ${lastId} ORDER BY id LIMIT ${BATCH}`) as Record<string, unknown>[])
        : ((await primary`SELECT id, created_at, updated_at, deleted_at, name, value, file_id, is_public FROM metadata WHERE id > ${lastId} ORDER BY id LIMIT ${BATCH}`) as Record<string, unknown>[]);
    if (rows.length === 0) break;
    await insertRows(rows);
    lastId = Math.max(...rows.map((r) => Number(r.id)));
  }

  // phase 2：主库已无剩余行（或本品牌上轮已复制完）→ 清空主库侧并校准序列。
  if (table === 'audit_logs') {
    await primary`DELETE FROM audit_logs`;
    await domain`SELECT setval(pg_get_serial_sequence('audit_logs','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM audit_logs), 1))`;
  } else {
    await primary`DELETE FROM metadata`;
    await domain`SELECT setval(pg_get_serial_sequence('metadata','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM metadata), 1))`;
  }
}

/** 单域自举：DDL + 数据搬迁（KV 标记幂等）。 */
async function ensureDomain(
  env: Env,
  domain: 'audit' | 'metadata',
  url: string,
): Promise<void> {
  const kv = kvFor(env, 'flag');
  const migratedFlag = `shard:migrated:${domain}`;
  if (await kv.get(migratedFlag)) {
    await clearDomainDown(env, domain);
    return;
  }

  try {
    await ensureDomainDdl(env, domain, url);
    const domainSql = sqlForUrl(url);

    // 主库句柄：域迁移只读/删主库侧的这两张表
    const primary = sqlForUrl(primaryUrlOf(env));

    if (domain === 'audit') {
      await copyAndPurge(primary, domainSql, 'audit_logs', async (rows) => {
        for (const r of rows) {
          await domainSql`
            INSERT INTO audit_logs (id, created_at, user_id, type, meta)
            VALUES (${Number(r.id)}, ${r.created_at}, ${r.user_id}, ${Number(r.type)}, ${JSON.stringify(r.meta ?? {})}::jsonb)
            ON CONFLICT (id) DO NOTHING
          `;
        }
      });
    } else {
      await copyAndPurge(primary, domainSql, 'metadata', async (rows) => {
        for (const r of rows) {
          await domainSql`
            INSERT INTO metadata (id, created_at, updated_at, deleted_at, name, value, file_id, is_public)
            VALUES (${Number(r.id)}, ${r.created_at}, ${r.updated_at}, ${r.deleted_at}, ${r.name}, ${r.value},
                    ${Number(r.file_id)}, ${r.is_public === true})
            ON CONFLICT (file_id, name) DO NOTHING
          `;
        }
      });
    }

    await kv.put(migratedFlag, '1');
    await clearDomainDown(env, domain);
  } catch (e) {
    // 建表/搬迁失败：该域长 TTL 降级回主库（主库表 schema 永远在，搬迁
    // 语义保证主库侧数据完整直到全部复制成功），cron 每小时重试。
    await persistDomainDown(env, domain, 60 * 60);
    throw e;
  }
}

function primaryUrlOf(env: Env): string {
  // 绑了 Hyperdrive 时运行时主库是它的本地地址；分域迁移也要落在同一个库上。
  const url = primaryRuntimeUrl(env);
  if (!url) throw new Error('DATABASE_URL is not configured');
  return url;
}

/**
 * 分域自举入口：有配置的域逐个建表 + 搬迁，失败只记日志（cron 会重试）。
 * 单库部署（没填 _2/_3）直接返回，零开销。
 */
export async function ensureDomainShards(env: Env): Promise<void> {
  const jobs: Array<[string, 'audit' | 'metadata', string]> = [];
  const auditUrl = auditDomainUrl(env);
  if (auditUrl) jobs.push(['audit', 'audit', auditUrl]);
  const metadataUrl = metadataDomainUrl(env);
  if (metadataUrl) jobs.push(['metadata', 'metadata', metadataUrl]);
  if (jobs.length === 0) return;

  for (const [name, domain, url] of jobs) {
    try {
      await ensureDomain(env, domain, url);
      console.log(`domain shard ready: ${name} (own database)`);
    } catch (e) {
      // 失败已在 ensureDomain 内做了长 TTL 降级（该域回退主库），cron 每小时重试
      console.error(`domain shard bootstrap failed for ${name}:`, e instanceof Error ? e.message : String(e));
    }
  }
}
