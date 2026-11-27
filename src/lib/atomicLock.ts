/**
 * 单资源锁的原子 CAS。对应上游「无锁读改写」加固的思路：WOPI 锁原来是
 * `kv.get → 判断 → kv.put/delete`，两个并发 LOCK 都能读到「无锁」再各自
 * put，互斥语义失效。KV（Workers KV 与 DB 兜底）都没有 CAS，所以这里
 * 走 DB 的 `INSERT ... ON CONFLICT ... WHERE`，靠 Postgres 行锁串行化。
 *
 * WOPI 是低频操作（打开/保存文档时一次），多一次 DB 往返可以接受；
 * 与 session 那套 KV 存储分开，用独立的 `wopi_lock:` 键前缀。
 *
 * 语义对齐原来的实现：
 *   - LOCK / REFRESH_LOCK：无锁或锁是自己的才能写；否则回 false → 409
 *   - UNLOCK：锁是自己的才能删；无锁时原来直接 delete（成功），这里也放行
 *   - 30 分钟过期：expire_at = now() + 1800s，读时过滤已过期行
 *
 * key_values 表由 0018 迁移建，EdgeOne 上 kvStore 也会 ensureTable；
 * 这里显式建一次，保证 CF 上没用过 KV 兜底时也能用。
 */
import type { Sql } from '../db';

const LOCK_TTL_SEC = 1800;

let ready: Promise<void> | null = null;
async function ensureTable(sql: Sql): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS key_values (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          metadata TEXT,
          expire_at TIMESTAMPTZ
        )
      `;
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  await ready;
}

/** 读当前锁持有者；已过期的锁视为无锁。 */
export async function readLock(sql: Sql, key: string): Promise<string | null> {
  await ensureTable(sql);
  const rows = (await sql`
    SELECT value FROM key_values
    WHERE key = ${key} AND (expire_at IS NULL OR expire_at > now())
    LIMIT 1
  `) as Array<{ value: string }>;
  return rows[0]?.value ?? null;
}

/**
 * 抢锁 / 续期。仅当无锁、锁已过期、或锁就是自己的时候写入成功。
 * 返回 false 表示别人持有 → 调用方回 409。
 */
export async function acquireLock(sql: Sql, key: string, token: string): Promise<boolean> {
  await ensureTable(sql);
  const rows = (await sql`
    INSERT INTO key_values (key, value, expire_at)
    VALUES (${key}, ${token}, now() + (${LOCK_TTL_SEC} || ' seconds')::interval)
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      expire_at = EXCLUDED.expire_at
    WHERE key_values.value = ${token}
       OR key_values.expire_at IS NULL
       OR key_values.expire_at < now()
    RETURNING value
  `) as Array<{ value: string }>;
  return rows.length > 0;
}

/**
 * 释放锁。仅当锁是自己的时候删成功；无锁也返回 true（对齐原来「无锁时
 * delete 成功」的行为），返回 false 表示别人持有。
 */
export async function releaseLock(sql: Sql, key: string, token: string): Promise<boolean> {
  await ensureTable(sql);
  // 先取当前持有者：无锁 → 放行；别人持有 → false；自己持有 → 删
  const current = await readLock(sql, key);
  if (current === null) return true;
  if (current !== token) return false;
  const rows = (await sql`
    DELETE FROM key_values WHERE key = ${key} AND value = ${token} RETURNING value
  `) as Array<{ value: string }>;
  return rows.length > 0;
}
