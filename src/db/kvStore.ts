/**
 * DB 兜底 KV（EdgeOne 等「没有 KV 绑定」的运行环境）。
 *
 * Cloudreve 的会话 / 上传会话锁 / 凭据缓存 / 自举标记全在 Workers KV 里，
 * 但 EdgeOne Node 云函数没有 KV 绑定。kvRouter 检测到角色对应的绑定全部
 * 缺失时，把该角色的键落进 `key_values` 表（迁移 0018），语义对齐
 * Workers KV 的实际用量子集：get（text/json）/ put（expirationTtl +
 * metadata）/ delete / list（prefix + cursor 分页）。
 *
 * ⚠️ 表自动创建：迁移标记本身就走 KV（flag 角色），没有这张表迁移流程
 * 根本跑不起来 —— 所以这里在首次使用时 `CREATE TABLE IF NOT EXISTS`，
 * 与 0018 迁移保持同构（幂等）。
 *
 * 性能预期：比 Workers KV 慢一次 DB 往返（~250ms Neon / ~10ms EdgeOne
 * 就近 PG）。CF 部署有 KV 绑定不会走到这里；EdgeOne 部署没有更快的选项。
 */
import type { Sql } from './index';

/** Workers KV 的用量子集（Cloudreve 全仓只用到了这四个方法）。 */
export interface KvLike {
  get(key: string, type?: 'text' | 'json'): Promise<string | object | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: Array<{ name: string; metadata?: unknown; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

let readyPromise: Promise<void> | null = null;

/** 首次使用时确保表存在（与 0018 迁移同构，幂等）。 */
async function ensureTable(sql: Sql): Promise<void> {
  if (!readyPromise) {
    readyPromise = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS key_values (
            key       TEXT PRIMARY KEY,
            value     TEXT NOT NULL,
            metadata  TEXT,
            expire_at TIMESTAMPTZ
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_key_values_expire ON key_values (expire_at)
      `;
    })().catch((err) => {
      // 失败重置，下次调用重试（DB 暂时不可达时不能永久卡死）
      readyPromise = null;
      throw err;
    });
  }
  await readyPromise;
}

export function createDbKv(sql: Sql): KvLike {
  return {
    async get(key, type = 'text') {
      await ensureTable(sql);
      const rows = (await sql`
        SELECT value FROM key_values
        WHERE key = ${key} AND (expire_at IS NULL OR expire_at > now())
        LIMIT 1
      `) as Array<{ value: string }>;
      const value = rows[0]?.value;
      if (value === undefined || value === null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(value) as object;
        } catch {
          return null;
        }
      }
      return value;
    },

    async put(key, value, opts) {
      await ensureTable(sql);
      const ttl = opts?.expirationTtl;
      const expireAt =
        ttl && ttl > 0
          ? new Date(Date.now() + ttl * 1000).toISOString()
          : null;
      const metadata = opts?.metadata !== undefined ? JSON.stringify(opts.metadata) : null;
      await sql`
        INSERT INTO key_values (key, value, metadata, expire_at)
        VALUES (${key}, ${value}, ${metadata}, ${expireAt})
        ON CONFLICT (key) DO UPDATE SET
          value = EXCLUDED.value,
          metadata = EXCLUDED.metadata,
          expire_at = EXCLUDED.expire_at
      `;
    },

    async delete(key) {
      await ensureTable(sql);
      await sql`DELETE FROM key_values WHERE key = ${key}`;
    },

    async list(opts = {}) {
      await ensureTable(sql);
      const limit = Math.min(1000, Math.max(1, opts.limit ?? 1000));
      // cursor 语义：返回「排在 cursor 之后」的一页（key 升序），与
      // Workers KV 的 cursor 不完全一致，但调用方（dav 锁列举）只依赖
      // 「翻页能取完 + list_complete」这两个行为。
      const cursor = opts.cursor ?? '';
      const prefix = opts.prefix ?? '';
      const rows = (await sql`
        SELECT key, metadata, expire_at FROM key_values
        WHERE key > ${cursor}
          ${prefix ? sql`AND key LIKE ${prefix + '%'}` : sql``}
          AND (expire_at IS NULL OR expire_at > now())
        ORDER BY key ASC
        LIMIT ${limit + 1}
      `) as Array<{ key: string; metadata: string | null; expire_at: string | null }>;

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        keys: page.map((r) => ({
          name: r.key,
          metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
          expiration: r.expire_at
            ? Math.floor(new Date(r.expire_at).getTime() / 1000)
            : undefined,
        })),
        list_complete: !hasMore,
        ...(hasMore ? { cursor: page[page.length - 1]!.key } : {}),
      };
    },
  };
}
