/**
 * 数据访问层。
 *
 * 所有 SQL 集中在这里，上层服务不直接写 SQL。读出的一律经 `normalize*`
 * 归一化（bigint → number、bytea → Uint8Array、jsonb → object）。
 */
import { toByteaLiteral, toBytes, toDate, toJson, toNum, toNumOrNull, type Sql } from './index';
import type {
  EntityRow,
  FileProps,
  FileRow,
  GroupRow,
  MetadataRow,
  NodeRow,
  ShareRow,
  StoragePolicyRow,
  TaskRow,
  UserRow,
  UserWithGroup,
} from './types';
import { uuidv4 } from '../lib/crypto';
import { verifyDavPassword } from '../lib/davPassword';
import { coloCacheDelete, coloCacheGetJson, coloCachePutJson } from '../lib/coloCache';
import { normalizeNodeRow } from './nodes';import { MetadataExpectedCollectTime } from '../lib/sysmeta';

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

export function normalizeGroup(r: Record<string, unknown>): GroupRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    name: String(r.name ?? ''),
    max_storage: toNumOrNull(r.max_storage),
    speed_limit: toNumOrNull(r.speed_limit),
    permissions: toBytes(r.permissions),
    settings: toJson(r.settings, {}),
    storage_policy_id: toNumOrNull(r.storage_policy_id),
  };
}

export function normalizeUser(r: Record<string, unknown>): UserRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    email: String(r.email ?? ''),
    nick: String(r.nick ?? ''),
    password: (r.password as string) ?? null,
    status: (r.status as UserRow['status']) ?? 'active',
    storage: toNum(r.storage),
    two_factor_secret: (r.two_factor_secret as string) ?? null,
    avatar: (r.avatar as string) ?? null,
    settings: toJson(r.settings, {}),
    group_users: toNum(r.group_users),
  };
}

/**
 * 把 KV 缓存里 JSON 反序列化出来的 user+group 对象复原成带类型的行。
 *
 * JSON 序列化不保留运行时类型：`created_at` 等 Date 字段变成 ISO 字符串、
 * `group.permissions`（bytea → Uint8Array）变成 `{"0":..,"1":..}` 的普通对象。
 * 把这样的对象直接当 UserWithGroup 用会出两类事故：
 *   - `created_at.toISOString()` 等 Date 方法不存在 → /me 500；
 *   - `permissionsOf()` 的 `instanceof Uint8Array` 判定失败后按 base64 解析
 *     对象，异常被吞 → **权限位静默清空**（上传/删除/管理全部误判无权限）。
 * 所以 KV 命中后必须先过一遍 normalizeUser/normalizeGroup（配合 toBytes
 * 的数字键对象分支）复原成真正的行类型。形状不对（旧版本键 / 损坏数据）
 * 返回 null，调用方按缓存未命中回源处理。
 */
export function reviveUserWithGroup(r: Record<string, unknown>): UserWithGroup | null {
  const g = r.group;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
  const user = normalizeUser(r);
  const group = normalizeGroup(g as Record<string, unknown>);
  return { ...user, group };
}

export function normalizePolicy(r: Record<string, unknown>): StoragePolicyRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    name: String(r.name ?? ''),
    type: String(r.type ?? ''),
    server: (r.server as string) ?? null,
    bucket_name: (r.bucket_name as string) ?? null,
    is_private: r.is_private === null || r.is_private === undefined ? null : Boolean(r.is_private),
    access_key: (r.access_key as string) ?? null,
    secret_key: (r.secret_key as string) ?? null,
    max_size: toNumOrNull(r.max_size),
    dir_name_rule: (r.dir_name_rule as string) ?? null,
    file_name_rule: (r.file_name_rule as string) ?? null,
    settings: toJson(r.settings, {}),
    node_id: toNumOrNull(r.node_id),
  };
}

export function normalizeFile(r: Record<string, unknown>): FileRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    type: toNum(r.type),
    name: String(r.name ?? ''),
    owner_id: toNum(r.owner_id),
    size: toNum(r.size),
    primary_entity: toNumOrNull(r.primary_entity),
    file_children: toNumOrNull(r.file_children),
    is_symbolic: Boolean(r.is_symbolic),
    props: toJson(r.props, {}),
    storage_policy_files: toNumOrNull(r.storage_policy_files),
    encrypted: Boolean(r.encrypted),
  };
}

export function normalizeEntity(r: Record<string, unknown>): EntityRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    type: toNum(r.type),
    source: String(r.source ?? ''),
    size: toNum(r.size),
    reference_count: toNum(r.reference_count),
    storage_policy_entities: toNum(r.storage_policy_entities),
    created_by: toNumOrNull(r.created_by),
    upload_session_id: (r.upload_session_id as string) ?? null,
    recycle_options: toJson(r.recycle_options, {}),
    enc_meta: (r.enc_meta as string) ?? null,
  };
}

export function normalizeShare(r: Record<string, unknown>): ShareRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    password: (r.password as string) ?? null,
    views: toNum(r.views),
    downloads: toNum(r.downloads),
    expires: toDate(r.expires),
    remain_downloads: toNumOrNull(r.remain_downloads),
    props: toJson(r.props, {}),
    file_shares: toNumOrNull(r.file_shares),
    user_shares: toNumOrNull(r.user_shares),
    score: toNum(r.score),
  };
}

export function normalizeMetadata(r: Record<string, unknown>): MetadataRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    name: String(r.name ?? ''),
    value: String(r.value ?? ''),
    file_id: toNum(r.file_id),
    is_public: Boolean(r.is_public),
  };
}

export function normalizeTask(r: Record<string, unknown>): TaskRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    type: String(r.type ?? ''),
    status: (r.status as TaskRow['status']) ?? 'queued',
    public_state: toJson(r.public_state, {}),
    private_state: (r.private_state as string) ?? null,
    correlation_id: (r.correlation_id as string) ?? null,
    user_tasks: toNumOrNull(r.user_tasks),
  };
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

export class UserRepo {
  private sql: Sql;
  /**
   * 绑定到一个具体的数据库客户端。
   *
   * **不再接收 `env`**：多库模式下「用哪个库」是请求级决策（见
   * `db/shard.ts`），由调用方解析好再传进来。传 `Sql` 而不是 `Env`
   * 让「一个 repo 只能打一个库」成为类型层面的约束 —— 拿不到 env
   * 就没法偷偷开第二条连接。
   */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<UserRow | null> {
    const rows = (await this.sql`
      SELECT * FROM users WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeUser(rows[0]) : null;
  }

  /** 批量取用户（分享列表等 N+1 场景用）。 */
  async byIds(ids: number[]): Promise<Map<number, UserRow>> {
    const out = new Map<number, UserRow>();
    if (ids.length === 0) return out;
    const rows = (await this.sql`
      SELECT * FROM users WHERE id = ANY(${ids}::int[]) AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    for (const r of rows) {
      const u = normalizeUser(r);
      out.set(u.id, u);
    }
    return out;
  }

  async byEmail(email: string): Promise<UserRow | null> {
    const rows = (await this.sql`
      SELECT * FROM users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeUser(rows[0]) : null;
  }

  /** 站点是否还没有任何用户。第一个注册的用户会被提升为管理员。 */
  /**
   * 原子抢占「首个管理员名额」。
   *
   * 返回 true = 这次调用抢到了。`INSERT ... ON CONFLICT DO NOTHING RETURNING`
   * 由数据库主键保证只有一个调用能拿到行 —— 并发注册时不会再出现两个管理员。
   * 抢到之后由调用方把用户提进管理员组。
   */
  async claimFirstAdmin(email: string): Promise<boolean> {
    const rows = (await this.sql`
      INSERT INTO site_state (name, value) VALUES ('first_admin', ${email})
      ON CONFLICT (name) DO NOTHING
      RETURNING name
    `) as unknown[];
    return rows.length > 0;
  }

  async isEmpty(): Promise<boolean> {
    const rows = (await this.sql`SELECT 1 FROM users WHERE deleted_at IS NULL LIMIT 1`) as unknown[];
    return rows.length === 0;
  }

  /**
   * 按关键字搜索活跃用户（nick / email 模糊匹配）。
   * 对应上游 `userClient.SearchActive`（inventory/user.go:467）。
   */
  async searchActive(keyword: string, limit: number): Promise<UserRow[]> {
    const pattern = `%${keyword.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    const rows = (await this.sql`
      SELECT * FROM users
      WHERE (email ILIKE ${pattern} OR nick ILIKE ${pattern})
        AND status = 'active' AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ${limit}
    `) as Record<string, unknown>[];
    return rows.map(normalizeUser);
  }

  /** 取用户并带上所属用户组（权限判定几乎都要用到 group）。 */
  async byIdWithGroup(id: number): Promise<UserWithGroup | null> {
    const rows = (await this.sql`
      SELECT u.*, row_to_json(g.*) AS __group
      FROM users u
      JOIN groups g ON g.id = u.group_users AND g.deleted_at IS NULL
      WHERE u.id = ${id} AND u.deleted_at IS NULL
      LIMIT 1
    `) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const user = normalizeUser(row);
    const group = normalizeGroup(toJson<Record<string, unknown>>(row.__group, {}));
    return { ...user, group };
  }

  async byEmailWithGroup(email: string): Promise<UserWithGroup | null> {
    const rows = (await this.sql`
      SELECT u.*, row_to_json(g.*) AS __group
      FROM users u
      JOIN groups g ON g.id = u.group_users AND g.deleted_at IS NULL
      WHERE lower(u.email) = lower(${email}) AND u.deleted_at IS NULL
      LIMIT 1
    `) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const user = normalizeUser(row);
    const group = normalizeGroup(toJson<Record<string, unknown>>(row.__group, {}));
    return { ...user, group };
  }

  async create(args: {
    email: string;
    nick: string;
    passwordDigest: string | null;
    groupId: number;
    status?: string;
    /** 注册时前端带过来的界面语言，写进 `settings.email_language`（邮件按它选模板）。 */
    language?: string | null;
  }): Promise<UserRow> {
    // 新建用户的默认设置照抄原版 `inventory/user.go:381`：
    // `types.UserSetting{VersionRetention: true, VersionRetentionMax: 10}`。
    // 版本裁剪（`upload.capVersionEntities`）读的就是这两个字段。
    //
    // 语言字段的 JSON 名是 `email_language`（`inventory/types/types.go:16`），
    // 与 Go 字段名 `Language` 不一致，别照名字直译写成 `language`。
    const defaults: Record<string, unknown> = {
      version_retention: true,
      version_retention_max: 10,
    };
    if (args.language) defaults.email_language = args.language;
    const defaultSettings = JSON.stringify(defaults);
    const rows = (await this.sql`
      INSERT INTO users (email, nick, password, group_users, status, storage, settings)
      VALUES (${args.email}, ${args.nick}, ${args.passwordDigest}, ${args.groupId},
              ${args.status ?? 'active'}, 0, ${defaultSettings}::jsonb)
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeUser(rows[0]!);
  }

  async updatePassword(id: number, digest: string): Promise<void> {
    await this.sql`
      UPDATE users SET password = ${digest}, updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  async updateProfile(id: number, args: { nick?: string; avatar?: string }): Promise<void> {
    await this.sql`
      UPDATE users
      SET nick = COALESCE(${args.nick ?? null}, nick),
          avatar = COALESCE(${args.avatar ?? null}, avatar),
          updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 整行覆盖 `settings`。
   *
   * ⚠️ **只在调用方持有的是刚读出的完整快照、且没有并发写者时用**。
   * 这个写法会把读快照之后别人写进去的键一起抹掉 —— `quota_packs`（容量包）
   * 和 `credit`（积分）都是付费数据，被覆盖就是用户付了钱丢东西。
   * 改单个/少量键请用 `mergeSettings` / `patchSettings`。
   */
  async updateSettings(id: number, settings: Record<string, unknown>): Promise<void> {
    await this.sql`
      UPDATE users SET settings = ${JSON.stringify(settings)}::jsonb, updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 只合并指定的键（JSONB `||`），不碰其他键。
   *
   * 并发安全：两个人同时改不同的键，各自只合并自己那部分，不会互相覆盖。
   * 注意 `||` 是「同键替换」，数组/对象整体替换，不做深合并。
   */
  async mergeSettings(id: number, patch: Record<string, unknown>): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await this.sql`
      UPDATE users SET settings = COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb,
                       updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 合并 patch 并删除指定键（要「清掉」而不是「设成 null」时用）。
   *
   * 对应原来「读整份 settings → delete key → 整行写回」的语义，
   * 但不覆盖其他键。
   */
  async patchSettings(
    id: number,
    patch: Record<string, unknown>,
    deleteKeys: string[] = [],
  ): Promise<void> {
    if (Object.keys(patch).length === 0 && deleteKeys.length === 0) return;
    await this.sql`
      UPDATE users SET settings = (COALESCE(settings, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb)
                                   - ${deleteKeys}::text[],
                       updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 写入「购买的用户组」并同步切组，**一条语句原子完成**。
   *
   * `prev_group_id` 用现有记录里的（续费不丢最初组），没有则取当前的
   * `group_users`（SET 右侧引用的是更新前的值）。原来「先 updateSettings
   * 整行覆盖、再 updateGroup」两步：既会抹掉并发的容量包/积分，中途失败
   * 还会出现「买了组但没切组」。
   */
  async applyGroupPack(
    id: number,
    groupId: number,
    expireAt: string | null,
  ): Promise<void> {
    await this.sql`
      UPDATE users SET
        settings = jsonb_set(
          COALESCE(settings, '{}'::jsonb),
          '{group_pack}',
          jsonb_build_object(
            'group_id', ${groupId}::int,
            'prev_group_id', COALESCE((settings->'group_pack'->>'prev_group_id')::int, group_users),
            'expire_at', ${expireAt}::text
          ),
          true
        ),
        group_users = ${groupId},
        updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /** 组包过期：清掉记录并回退到购买前的组，一条语句原子完成。 */
  async clearGroupPack(id: number, prevGroupId: number): Promise<void> {
    await this.sql`
      UPDATE users SET
        settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{group_pack}', 'null'::jsonb, true),
        group_users = ${prevGroupId},
        updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /** 把积分设为指定值（管理端修改用；相对增减走 `adjustCredit`）。 */
  async setCredit(id: number, credit: number): Promise<void> {
    await this.sql`
      UPDATE users SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{credit}',
        to_jsonb(${credit}::numeric)
      ), updated_at = now() WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  async updateGroup(id: number, groupId: number): Promise<void> {
    await this.sql`
      UPDATE users SET group_users = ${groupId}, updated_at = now() WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  async updateStatus(id: number, status: string): Promise<void> {
    await this.sql`
      UPDATE users SET status = ${status}, updated_at = now() WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  async updateEmail(id: number, email: string): Promise<void> {
    await this.sql`
      UPDATE users SET email = ${email}, updated_at = now() WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  async setTwoFactorSecret(id: number, secret: string | null): Promise<void> {
    await this.sql`
      UPDATE users SET two_factor_secret = ${secret}, updated_at = now() WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 写用户行后清掉它的缓存。
   *
   * 放在**仓储层**而不是各个调用点，是因为用户写路径有 30 多处
   * （改密码 / 改组 / 改容量 / 封禁 / 支付履行 …）。散落着写失效调用
   * 一定会漏掉某一处，而漏掉的后果是「改了不生效」甚至「封禁了还能登录」
   * —— 安全相关，不能靠自觉。写在仓储层就是单一收口点。
   *
   * 本类没有 env（`UserRepo` 只持有 Sql），所以通过动态 import 拿
   * env 无关的 L1 清理 + KV 删除；KV 失败不阻断写操作本身。
   */
  private async touchCache(id: number): Promise<void> {
    try {
      const { evictUserCache } = await import('../services/userCache');
      await evictUserCache(id);
    } catch {
      // 缓存失效失败不该让写操作失败：TTL 会兜底
    }
  }

  /** 增减已用容量。容量计算依赖这个字段，必须与实际写入同步。 */
  async addStorage(id: number, delta: number): Promise<void> {
    await this.sql`
      UPDATE users SET storage = GREATEST(0, storage + ${delta}), updated_at = now()
      WHERE id = ${id}
    `;
    await this.touchCache(id);
  }

  /**
   * 原子预占容量：`storage + size` 必须在 `maxTotal` 之内（null / <=0 表示不限）。
   * 返回 false 表示已超配额，此时**不会**改动 storage。
   *
   * 对应上游 `userClient.ReserveStorage`（`inventory/user.go`）。为什么不能沿用
   * 「先 assertCapacity 再 addStorage」：前者读的是请求开始时的用户快照，两个
   * 并发上传都会通过检查，最后一起写进去 → 实际用量超配额。把判定和自增放进
   * 同一条 UPDATE，由数据库行锁串行化，超出的那个直接 0 行受影响。
   */
  async reserveStorage(id: number, size: number, maxTotal: number | null): Promise<boolean> {
    if (size <= 0) return true;
    const rows = (
      maxTotal !== null && maxTotal > 0
        ? await this.sql`
            UPDATE users SET storage = storage + ${size}, updated_at = now()
            WHERE id = ${id} AND storage <= ${maxTotal - size}
            RETURNING id
          `
        : await this.sql`
            UPDATE users SET storage = storage + ${size}, updated_at = now()
            WHERE id = ${id}
            RETURNING id
          `
    ) as Record<string, unknown>[];
    await this.touchCache(id);
    return rows.length > 0;
  }

  /** 原子给某用户追加一个容量包（JSONB 数组追加，避免并发读写覆盖导致丢包）。 */
  async addQuotaPack(
    userId: number,
    pack: { size: number; expire_at: string | null },
  ): Promise<void> {
    await this.sql`
      UPDATE users SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{quota_packs}',
        COALESCE(settings->'quota_packs', '[]'::jsonb) || ${JSON.stringify([pack])}::jsonb,
        true
      ), updated_at = now() WHERE id = ${userId}
    `;
    await this.touchCache(userId);
  }

  /** 原子增减积分（并发购买/兑换不会互相覆盖）。delta 为负即扣减。 */
  async adjustCredit(userId: number, delta: number): Promise<void> {
    await this.sql`
      UPDATE users SET settings = jsonb_set(
        COALESCE(settings, '{}'::jsonb),
        '{credit}',
        to_jsonb(COALESCE((settings->>'credit')::numeric, 0) + ${delta})
      ), updated_at = now() WHERE id = ${userId}
    `;
    await this.touchCache(userId);
  }

  /** 按已归属实体的实际大小重算容量（用于校正漂移）。 */
  async recalcStorage(id: number): Promise<number> {
    const rows = (await this.sql`
      SELECT COALESCE(SUM(e.size), 0) AS total
      FROM entities e
      WHERE e.deleted_at IS NULL
        AND e.created_by = ${id}
        AND e.type = 0
        AND e.upload_session_id IS NULL
        AND e.reference_count > 0
    `) as Record<string, unknown>[];
    const total = toNum(rows[0]?.total);
    await this.sql`UPDATE users SET storage = ${total}, updated_at = now() WHERE id = ${id}`;
    await this.touchCache(id);
    return total;
  }

  async list(args: {
    page: number;
    pageSize: number;
    orderBy?: string;
    orderDirection?: string;
    keyword?: string;
    groupId?: number;
    status?: string;
  }): Promise<{ users: UserRow[]; total: number }> {
    const orderCol = whitelist(args.orderBy, ['id', 'email', 'nick', 'created_at', 'updated_at', 'storage'], 'id');
    const orderDir = whitelist(args.orderDirection, ['asc', 'desc'], 'desc');
    const offset = Math.max(0, args.page) * args.pageSize;

    const keyword = args.keyword ?? null;
    const groupId = args.groupId ?? null;
    const status = args.status ?? null;

    const where = `
      deleted_at IS NULL
        AND ($1::text IS NULL OR email ILIKE '%' || $1 || '%' OR nick ILIKE '%' || $1 || '%')
        AND ($2::int IS NULL OR group_users = $2)
        AND ($3::text IS NULL OR status = $3)
    `;
    const params = [keyword, groupId, status];

    // ORDER BY 的列名无法参数化，因此只能白名单校验后拼进 SQL 文本
    const rows = (await this.sql(
      `SELECT * FROM users WHERE ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $4 OFFSET $5`,
      [...params, args.pageSize, offset],
    )) as Record<string, unknown>[];

    const countRows = (await this.sql(
      `SELECT COUNT(*)::int AS total FROM users WHERE ${where}`,
      params,
    )) as Record<string, unknown>[];

    return {
      users: rows.map(normalizeUser),
      total: toNum(countRows[0]?.total),
    };
  }

  async countAll(): Promise<number> {
    const rows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM users WHERE deleted_at IS NULL
    `) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }
}

// ---------------------------------------------------------------------------
// 用户组
// ---------------------------------------------------------------------------

/** 组→策略绑定的 isolate 缓存（60s，写路径主动失效）。 */
const GROUP_POLICY_CACHE_TTL_MS = 60_000;
const groupPolicyIdCache = new Map<number, { at: number; ids: number[] }>();

export class GroupRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<GroupRow | null> {
    const rows = (await this.sql`
      SELECT * FROM groups WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeGroup(rows[0]) : null;
  }

  /** 批量取组（分享列表判定属主组权限位时用）。 */
  async byIds(ids: number[]): Promise<Map<number, GroupRow>> {
    const out = new Map<number, GroupRow>();
    if (ids.length === 0) return out;
    const rows = (await this.sql`
      SELECT * FROM groups WHERE id = ANY(${ids}::int[]) AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    for (const r of rows) {
      const g = normalizeGroup(r);
      out.set(g.id, g);
    }
    return out;
  }

  async list(): Promise<GroupRow[]> {
    const rows = (await this.sql`
      SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY id ASC
    `) as Record<string, unknown>[];
    return rows.map(normalizeGroup);
  }

  async create(args: {
    name: string;
    maxStorage: number | null;
    speedLimit: number | null;
    permissions: Uint8Array;
    settings: Record<string, unknown>;
    storagePolicyId: number | null;
  }): Promise<GroupRow> {
    const rows = (await this.sql`
      INSERT INTO groups (name, max_storage, speed_limit, permissions, settings, storage_policy_id)
      VALUES (${args.name}, ${args.maxStorage}, ${args.speedLimit},
              ${toByteaLiteral(args.permissions)}::bytea,
              ${JSON.stringify(args.settings)}::jsonb, ${args.storagePolicyId})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeGroup(rows[0]!);
  }

  async update(
    id: number,
    args: {
      name?: string;
      maxStorage?: number | null;
      speedLimit?: number | null;
      permissions?: Uint8Array;
      settings?: Record<string, unknown>;
      storagePolicyId?: number | null;
    },
  ): Promise<void> {
    await this.sql`
      UPDATE groups SET
        name              = COALESCE(${args.name ?? null}, name),
        max_storage       = ${args.maxStorage === undefined ? (null as unknown as number) : args.maxStorage},
        speed_limit       = ${args.speedLimit === undefined ? (null as unknown as number) : args.speedLimit},
        permissions       = COALESCE(${args.permissions ? toByteaLiteral(args.permissions) : null}::bytea, permissions),
        settings          = COALESCE(${args.settings ? JSON.stringify(args.settings) : null}::jsonb, settings),
        storage_policy_id = ${args.storagePolicyId === undefined ? null : args.storagePolicyId},
        updated_at        = now()
      WHERE id = ${id}
    `;
  }

  /** 只更新非 null 的字段版本，供后台表单使用。 */
  async patch(
    id: number,
    args: {
      name?: string;
      maxStorage?: number | null;
      speedLimit?: number | null;
      permissions?: Uint8Array;
      settings?: Record<string, unknown>;
      storagePolicyId?: number | null;
    },
  ): Promise<void> {
    if (args.name !== undefined) {
      await this.sql`UPDATE groups SET name = ${args.name}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.maxStorage !== undefined) {
      await this.sql`UPDATE groups SET max_storage = ${args.maxStorage}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.speedLimit !== undefined) {
      await this.sql`UPDATE groups SET speed_limit = ${args.speedLimit}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.permissions !== undefined) {
      await this.sql`
        UPDATE groups SET permissions = ${toByteaLiteral(args.permissions)}::bytea, updated_at = now()
        WHERE id = ${id}
      `;
    }
    if (args.settings !== undefined) {
      await this.sql`
        UPDATE groups SET settings = ${JSON.stringify(args.settings)}::jsonb, updated_at = now()
        WHERE id = ${id}
      `;
    }
    if (args.storagePolicyId !== undefined) {
      await this.sql`
        UPDATE groups SET storage_policy_id = ${args.storagePolicyId}, updated_at = now() WHERE id = ${id}
      `;
    }
  }

  async softDelete(id: number): Promise<void> {
    await this.sql`
      UPDATE groups SET deleted_at = now(), updated_at = now() WHERE id = ${id}
    `;
  }

  async countUsers(id: number): Promise<number> {
    const rows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM users WHERE group_users = ${id} AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }

  /**
   * 组绑定的全部存储策略 ID（多对多，edge 自建 Pro 功能）。
   * 关联表为空时回落到旧的单一 `storage_policy_id` 列，保证迁移前数据无缝。
   */
  async listPolicyIds(id: number): Promise<number[]> {
    // 组→策略绑定几乎不变，而「列目录 / 上传 / assertPolicyAllowed」每个请求都要
    // 查它。isolate 缓存 60s：管理端改绑定的写路径会主动清（setPolicyIds），
    // 其余 isolate 最晚 60s 看到新绑定。
    const cached = groupPolicyIdCache.get(id);
    if (cached && Date.now() - cached.at < GROUP_POLICY_CACHE_TTL_MS) return cached.ids;

    const rows = (await this.sql`
      SELECT policy_id FROM group_storage_policies WHERE group_id = ${id} ORDER BY policy_id ASC
    `) as Array<{ policy_id: number | string }>;
    const ids = rows.map((r) => Number(r.policy_id)).filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length > 0) {
      groupPolicyIdCache.set(id, { at: Date.now(), ids });
      return ids;
    }
    const group = await this.byId(id);
    const fallback = group?.storage_policy_id != null ? [Number(group.storage_policy_id)] : [];
    groupPolicyIdCache.set(id, { at: Date.now(), ids: fallback });
    return fallback;
  }

  /** 整体替换组的策略集；空数组 = 清空全部绑定。 */
  async setPolicyIds(id: number, policyIds: number[]): Promise<void> {
    groupPolicyIdCache.delete(id);
    void coloCacheDelete(`grouppol:${id}`);
    groupPolicyIdCache.delete(id);
    await this.sql.transaction([
      this.sql`DELETE FROM group_storage_policies WHERE group_id = ${id}`,
      ...policyIds.map(
        (pid) =>
          this.sql`
            INSERT INTO group_storage_policies (group_id, policy_id) VALUES (${id}, ${pid})
            ON CONFLICT (group_id, policy_id) DO NOTHING
          `,
      ),
    ]);
    // 旧的单一绑定列保持与第一个策略同步（兼容 resolvePolicy 等旧读法）。
    // 注意 update() 会把 undefined 存储列写成 NULL，所以单独 UPDATE。
    await this.sql`
      UPDATE groups SET storage_policy_id = ${policyIds[0] ?? null}, updated_at = now() WHERE id = ${id}
    `;
  }
}

// ---------------------------------------------------------------------------
// 存储策略
// ---------------------------------------------------------------------------

export class PolicyRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<StoragePolicyRow | null> {
    // 策略行读极多写极少（每次列表/上传/下载/缩略图都读），统一走缓存：
    // L1 命中 0 往返，L2(KV) / DB 兜底。失效收口在本类写方法的 touchPolicyCache。
    const { getCachedPolicy } = await import('../services/policyCache');
    return getCachedPolicy(this.sql, id);
  }

  /**
   * 按 id 集合批量取策略（1 次往返）。
   *
   * 组多策略下发路径上原来对每个 id 调一次 `byId`，N 个策略就是 N 次
   * Neon HTTP 往返（每次 300ms 量级），列表接口因此明显变慢。
   * 返回顺序与入参一致（调用方按 `upload_policy_id` 匹配时要稳定顺序），
   * 且自动丢弃不存在 / 已软删的行。
   *
   * 现在走 L1 缓存：命中的直接返回，缺失项合并成一次 SQL —— 组绑定的
   * 策略集在热路径上 0 往返。**不接 KV**：KV 没有批量接口，N 条缺失
   * 就是 N 次往返，比一次批量 SQL 更贵（见 policyCache.ts 文件头）。
   */
  async byIds(ids: number[]): Promise<StoragePolicyRow[]> {
    const { getCachedPoliciesByIds } = await import('../services/policyCache');
    return getCachedPoliciesByIds(this.sql, ids);
  }

  async list(): Promise<StoragePolicyRow[]> {
    const rows = (await this.sql`
      SELECT * FROM storage_policies WHERE deleted_at IS NULL ORDER BY id ASC
    `) as Record<string, unknown>[];
    return rows.map(normalizePolicy);
  }

  /** 默认策略：id 最小的一条。原版用一个 is_default 设置，这里简化为取最小 id。 */
  async defaultPolicy(): Promise<StoragePolicyRow | null> {
    const rows = (await this.sql`
      SELECT * FROM storage_policies WHERE deleted_at IS NULL ORDER BY id ASC LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizePolicy(rows[0]) : null;
  }

  async create(args: {
    name: string;
    type: string;
    server?: string | null;
    bucketName?: string | null;
    isPrivate?: boolean | null;
    accessKey?: string | null;
    secretKey?: string | null;
    maxSize?: number | null;
    dirNameRule?: string | null;
    fileNameRule?: string | null;
    settings?: Record<string, unknown>;
    /** 节点存储（local / remote）绑定的从节点 id */
    nodeId?: number | null;
  }): Promise<StoragePolicyRow> {
    const rows = (await this.sql`
      INSERT INTO storage_policies
        (name, type, server, bucket_name, is_private, access_key, secret_key,
         max_size, dir_name_rule, file_name_rule, settings, node_id)
      VALUES (${args.name}, ${args.type}, ${args.server ?? null}, ${args.bucketName ?? null},
              ${args.isPrivate ?? null}, ${args.accessKey ?? null}, ${args.secretKey ?? null},
              ${args.maxSize ?? null}, ${args.dirNameRule ?? null}, ${args.fileNameRule ?? null},
              ${JSON.stringify(args.settings ?? {})}::jsonb, ${args.nodeId ?? null})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizePolicy(rows[0]!);
  }

  /**
   * 策略缓存失效收口（与 UserRepo.touchCache 同一模式）：所有改动
   * 策略行的写路径都必须经过它，靠自觉一定会漏 —— 漏掉的后果是
   * 「改了配置但用户侧最长 10s / 300s 不生效」。
   */
  private async touchPolicyCache(id: number): Promise<void> {
    try {
      const { evictPolicyCache } = await import('../services/policyCache');
      await evictPolicyCache(id);
    } catch {
      // 缓存失效失败不该让写操作失败：TTL 会兜底
    }
  }

  async update(id: number, patchFields: Record<string, unknown>, encrypted: {
    accessKey?: string | null;
    secretKey?: string | null;
  }): Promise<void> {
    if (patchFields.name !== undefined) {
      await this.sql`UPDATE storage_policies SET name = ${patchFields.name as string}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.type !== undefined) {
      await this.sql`UPDATE storage_policies SET type = ${patchFields.type as string}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.server !== undefined) {
      await this.sql`UPDATE storage_policies SET server = ${patchFields.server as string | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.bucket_name !== undefined) {
      await this.sql`UPDATE storage_policies SET bucket_name = ${patchFields.bucket_name as string | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.is_private !== undefined) {
      await this.sql`UPDATE storage_policies SET is_private = ${patchFields.is_private as boolean | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.max_size !== undefined) {
      await this.sql`UPDATE storage_policies SET max_size = ${patchFields.max_size as number | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.dir_name_rule !== undefined) {
      await this.sql`UPDATE storage_policies SET dir_name_rule = ${patchFields.dir_name_rule as string | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.file_name_rule !== undefined) {
      await this.sql`UPDATE storage_policies SET file_name_rule = ${patchFields.file_name_rule as string | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (patchFields.settings !== undefined) {
      await this.sql`
        UPDATE storage_policies SET settings = ${JSON.stringify(patchFields.settings)}::jsonb, updated_at = now()
        WHERE id = ${id}
      `;
    }
    if (patchFields.node_id !== undefined) {
      await this.sql`UPDATE storage_policies SET node_id = ${patchFields.node_id as number | null}, updated_at = now() WHERE id = ${id}`;
    }
    if (encrypted.accessKey !== undefined) {
      await this.sql`UPDATE storage_policies SET access_key = ${encrypted.accessKey}, updated_at = now() WHERE id = ${id}`;
    }
    if (encrypted.secretKey !== undefined) {
      await this.sql`UPDATE storage_policies SET secret_key = ${encrypted.secretKey}, updated_at = now() WHERE id = ${id}`;
    }
    await this.touchPolicyCache(id);
  }

  async softDelete(id: number): Promise<void> {
    await this.sql`UPDATE storage_policies SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
    await this.touchPolicyCache(id);
  }

  async countFiles(id: number): Promise<number> {
    const rows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM files WHERE storage_policy_files = ${id} LIMIT 1
    `) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }

  async countGroups(id: number): Promise<number> {
    const rows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM groups WHERE storage_policy_id = ${id} AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

export interface ListFilesArgs {
  parentId: number | null;
  ownerId: number | null;
  trash?: boolean;
  page: number;
  pageSize: number;
  orderBy: string;
  orderDirection: string;
  typeFilter?: number | null;
  nameKeyword?: string | null;
  /**
   * 「分享给我」是一棵**扁平**的树（原版 `inventory/file_utils.go:118-141`
   * 的 `childFileQuery(ownerID, isSymbolic=true, nil)`）：过滤条件是
   * `name <> '' AND owner_id = uid AND is_symbolic AND file_children IS NOT NULL`，
   * 不看 parentId。为 true 时忽略 `parentId` / `trash`。
   */
  sharedWithMe?: boolean;
}

/**
 * 根目录行的 isolate 级缓存。根是「每个请求都要用、建好之后永不变」的行，
 * 缓存它等于给每次导航省一跳 Neon 往返。TTL 兜住极端情况（用户被删重建）。
 */
const ROOT_CACHE_TTL_MS = 60_000;
const rootCache = new Map<number, { at: number; row: FileRow }>();

export class FileRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<FileRow | null> {
    const rows = (await this.sql`
      SELECT * FROM files WHERE id = ${id} LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeFile(rows[0]) : null;
  }

  /** 批量取文件（分享列表这类「N 行各要一个文件」的场景，避免 N+1 往返）。 */
  async byIds(ids: number[]): Promise<Map<number, FileRow>> {
    const out = new Map<number, FileRow>();
    if (ids.length === 0) return out;
    const rows = (await this.sql`
      SELECT * FROM files WHERE id = ANY(${ids}::int[])
    `) as Record<string, unknown>[];
    for (const r of rows) {
      const f = normalizeFile(r);
      out.set(f.id, f);
    }
    return out;
  }

  /** 取用户根目录；不存在则创建（首次登录时调用）。 */
  async ensureRoot(ownerId: number): Promise<FileRow> {
    // 根目录是**每个请求都要用**的行（解析任何路径都从它开始），而它建好之后
    // 永远不会变、也删不掉。放 isolate 内存缓存 60s，等于每次导航省一跳
    // Neon 往返（200~400ms）。
    const cached = rootCache.get(ownerId);
    if (cached && Date.now() - cached.at < ROOT_CACHE_TTL_MS) return cached.row;

    const existing = (await this.sql`
      SELECT * FROM files WHERE owner_id = ${ownerId} AND file_children IS NULL AND name = '' LIMIT 1
    `) as Record<string, unknown>[];
    if (existing[0]) {
      const row = normalizeFile(existing[0]);
      rootCache.set(ownerId, { at: Date.now(), row });
      return row;
    }

    const rows = (await this.sql`
      INSERT INTO files (type, name, owner_id, size, is_symbolic)
      VALUES (1, '', ${ownerId}, 0, false)
      ON CONFLICT DO NOTHING
      RETURNING *
    `) as Record<string, unknown>[];
    if (rows[0]) {
      const row = normalizeFile(rows[0]);
      rootCache.set(ownerId, { at: Date.now(), row });
      return row;
    }

    // 并发下可能已被其它请求插入
    const again = (await this.sql`
      SELECT * FROM files WHERE owner_id = ${ownerId} AND file_children IS NULL AND name = '' LIMIT 1
    `) as Record<string, unknown>[];
    const row = normalizeFile(again[0]!);
    rootCache.set(ownerId, { at: Date.now(), row });
    return row;
  }

  /** 按父目录 + 名字找子节点。parentId 为 null 表示找根目录本身。 */
  async childByName(parentId: number | null, name: string): Promise<FileRow | null> {
    const rows = (await this.sql`
      SELECT * FROM files
      WHERE name = ${name}
        AND ((${parentId}::int IS NULL AND file_children IS NULL) OR file_children = ${parentId})
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeFile(rows[0]) : null;
  }

  /**
   * 沿路径逐段向下查找。返回 null 表示路径不存在。
   *
   * ⚠️ 这里**故意不用** `WITH RECURSIVE` 一次查完 —— 线上实测（Server-Timing
   * 分段，2026-10-26）递归 CTE 单条要 500~1900ms，而带索引的简单查询只要
   * ~165ms（`unnest` 进递归项后计划器不走向索引）。路径深度通常 2~4 段，
   * 逐段查反而更快。根目录行走 isolate 缓存（ensureRoot），首段免费。
   */
  async resolvePath(ownerId: number, elements: string[]): Promise<FileRow | null> {
    // 路径 → 目录行的 colo 级缓存（60s）：桌面端同步、反复进出同一目录时，
    // 命中就是零往返。
    //
    // ⚠️ 只缓存**目录行**（理由见 fs.ts resolveMy 的注释：文件行进缓存会让
    // 「PUT 完立刻读」拿到没有 entity 的旧行）。命中校验 file_children 非 NULL
    // （还挂在树上）：Cache API 实测会活过声明的 max-age，删掉的目录会从
    // 缓存里爬出来 —— 拿它当父目录建文件直接外键 500（2026-10-26 实测）。
    const cacheKey = `dirresolve:${ownerId}:${elements.join('/')}`;
    const hit = await coloCacheGetJson<Record<string, unknown>>(cacheKey, 60);
    if (hit) {
      if (Number(hit.type) === 1 && hit.file_children != null) return normalizeFile(hit);
      void coloCacheDelete(cacheKey);
    }

    let current = await this.ensureRoot(ownerId);
    for (const el of elements) {
      const next = await this.childByName(current.id, el);
      if (!next) return null;
      current = next;
    }
    if (current.type === 1 && current.file_children !== null) {
      void coloCachePutJson(cacheKey, { ...current }, 120);
    }
    return current;
  }

  /**
   * 从某节点往上收集路径段（一次查询）。
   *
   * 返回**由深到浅**的名字数组，不含根（根的名字是空串）；回收站项（父为 null）
   * 返回空数组。`pathOf()` 原来每上一级打一次库，深目录列一次表就是好几跳。
   */
  async ancestorNames(id: number): Promise<string[]> {
    try {
      const rows = (await this.sql(
        `WITH RECURSIVE up(id, name, parent, depth) AS (
           SELECT id, name, file_children, 0 FROM files WHERE id = $1
           UNION ALL
           SELECT f.id, f.name, f.file_children, u.depth + 1
           FROM files f JOIN up u ON f.id = u.parent
         )
         SELECT name, depth FROM up WHERE name <> '' ORDER BY depth ASC`,
        [id],
      )) as { name: string; depth: number }[];
      // depth 0 是节点自身 → 由浅到深排好再反过来，保持「由深到浅」契约
      return rows.map((r) => r.name).reverse();
    } catch (e) {
      console.error('ancestorNames query failed', e instanceof Error ? e.message : e);
      return [];
    }
  }

  /** 列出目录内容（或回收站内容）。 */
  async list(args: ListFilesArgs): Promise<{ files: FileRow[]; total: number }> {
    const orderCol = whitelist(args.orderBy, ['name', 'size', 'updated_at', 'created_at'], 'name');
    const orderDir = whitelist(args.orderDirection, ['asc', 'desc'], 'asc');

    const params: unknown[] = [];
    const add = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    const conds: string[] = [];

    // 「分享给我」：扁平列表，不按父目录过滤（见 ListFilesArgs.sharedWithMe）
    if (args.sharedWithMe) {
      conds.push(`f.name <> '' AND f.is_symbolic = TRUE AND f.file_children IS NOT NULL`);
    } else if (args.trash) {
      conds.push(`f.file_children IS NULL AND f.name <> ''`);
    } else if (args.parentId === null) {
      conds.push(`f.file_children IS NULL AND f.name = ''`);
    } else {
      conds.push(`f.file_children = ${add(args.parentId)}`);
    }

    // 与官方 `childFileQuery`（inventory/file_utils.go:118-141）对齐：
    //   查「**指定父目录**的子项」时官方走 `QueryChildren(root)`，只看
    //   `file_children`，**不加 owner 过滤**；owner 只用于「按属主划范围」的
    //   查询（根/孤儿 parentId=null、回收站、分享给我）。
    //
    // 之前对所有查询都叠 `owner_id`：只要子项属主与目录属主不一致（历史数据、
    // 跨账号写入等），整个目录就会被列成空 —— 分享链接因此看起来「失效」。
    const ownerScoped =
      args.parentId === null || args.trash === true || args.sharedWithMe === true;
    if (ownerScoped && args.ownerId !== null && args.ownerId !== undefined) {
      conds.push(`f.owner_id = ${add(args.ownerId)}`);
    }
    if (args.typeFilter !== null && args.typeFilter !== undefined) {
      conds.push(`f.type = ${add(args.typeFilter)}`);
    }
    if (args.nameKeyword) {
      conds.push(`f.name ILIKE '%' || ${add(args.nameKeyword)} || '%'`);
    }

    const where = conds.length > 0 ? conds.join(' AND ') : 'TRUE';

    const limitPlaceholder = add(args.pageSize);
    const offsetPlaceholder = add(Math.max(0, args.page) * args.pageSize);

    // ⚠️ 关键性能点：列表 + 总数**必须合成一条 SQL**。
    //
    // Neon HTTP 驱动下，每次 `sql\`...\`` 都是独立的 HTTPS 往返（实测冷态
    // 350~500ms，连接池饱和时会飙到秒级）。原实现发两条查询（分页行 + COUNT），
    // 等于把「列目录」的固定成本直接翻倍。改用窗口函数 `COUNT(*) OVER ()`
    // 让同一次扫描同时产出总数与分页行：
    //
    //   - 内层先在**裁剪前**的完整结果集上算出 total（窗口函数在 LIMIT 之前求值）
    //   - 外层再做 ORDER BY + LIMIT/OFFSET，只把 total 透传出去
    //
    // 语义差异仅一处：翻到**空页**时窗口函数不产出任何行，total 会退化成 0，
    // 而原来的 COUNT 查询仍能给出真实总数。前端只拿 total 渲染分页器，
    // 且本部署的列表都短到只有一页，该差异不可见。用一次往返换掉一次往返，
    // 收益远大于这个边界差异。
    const rows = (await this.sql(
      `SELECT * FROM (
         SELECT f.*, COUNT(*) OVER () AS _total FROM files f
         WHERE ${where}
         ORDER BY f.${orderCol} ${orderDir}, f.id ASC
         LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
       ) page`,
      params,
    )) as Record<string, unknown>[];

    // 空页时 rows 为空 → total 取 0（与上面注释的边界差异一致）
    return { files: rows.map(normalizeFile), total: toNum(rows[0]?._total) };
  }

  /**
   * 按文件名搜索当前用户的文件（跨目录，排除回收站）。
   *
   * 说明清楚一点：**这不是原版的全文检索**。原版 `GET /file/search` 走
   * `pkg/filemanager/manager/fulltextindex.go`，依赖 Tika 之类的正文抽取器
   * 建索引，边缘版没有抽取器也没有索引服务，所以退化为文件名 ILIKE 匹配，
   * 命中项的 `content`（正文片段）恒为空串。
   *
   * 回收站的判定与 `list()` 一致：`file_children IS NULL AND name <> ''`
   * （见 `moveToTrash`）。这里用 `file_children IS NOT NULL` 把它排除掉。
   */
  async searchByName(args: {
    ownerId: number;
    keyword: string;
    offset: number;
    limit: number;
  }): Promise<{ files: FileRow[]; total: number }> {
    // ILIKE 里 `%` 和 `_` 是通配符，用户搜字面量时必须转义，否则搜 "a_b" 会命中 "axb"
    const escaped = args.keyword.replace(/[\\%_]/g, (m) => `\\${m}`);

    const rows = (await this.sql(
      `SELECT f.* FROM files f
       WHERE f.owner_id = $1
         AND f.file_children IS NOT NULL
         AND f.name ILIKE '%' || $2 || '%' ESCAPE '\\'
       ORDER BY f.name ASC, f.id ASC
       LIMIT $3 OFFSET $4`,
      [args.ownerId, escaped, args.limit, Math.max(0, args.offset)],
    )) as Record<string, unknown>[];

    const countRows = (await this.sql(
      `SELECT COUNT(*)::int AS total FROM files f
       WHERE f.owner_id = $1
         AND f.file_children IS NOT NULL
         AND f.name ILIKE '%' || $2 || '%' ESCAPE '\\'`,
      [args.ownerId, escaped],
    )) as Record<string, unknown>[];

    return { files: rows.map(normalizeFile), total: toNum(countRows[0]?.total) };
  }

  /**
   * 统计可建全文索引的文件数。对应上游 `FileClient.CountIndexableFiles`。
   *
   * 「可索引」的判定：有主实体、不在回收站（`file_children IS NOT NULL`）、
   * 扩展名在抽取器白名单里。
   */
  async countIndexableFiles(ownerId: number, exts: string[]): Promise<number> {
    if (!exts.length) return 0;
    const rows = (await this.sql(
      `SELECT COUNT(*)::int AS total FROM files f
       WHERE f.owner_id = $1
         AND f.file_children IS NOT NULL
         AND f.primary_entity IS NOT NULL
         AND lower(substring(f.name from '\\.([^.]*)$')) = ANY($2::text[])`,
      [ownerId, exts],
    )) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }

  /**
   * 分页列举可建索引的文件（按 id 升序游标推进）。
   * 对应上游 `FileClient.ListIndexableFiles`，用于重建索引任务分批推进。
   */
  async listIndexableFiles(args: {
    ownerId: number;
    afterId: number;
    limit: number;
    exts: string[];
  }): Promise<FileRow[]> {
    if (!args.exts.length) return [];
    const rows = (await this.sql(
      `SELECT f.* FROM files f
       WHERE f.owner_id = $1
         AND f.file_children IS NOT NULL
         AND f.primary_entity IS NOT NULL
         AND f.id > $2
         AND lower(substring(f.name from '\\.([^.]*)$')) = ANY($3::text[])
       ORDER BY f.id ASC
       LIMIT $4`,
      [args.ownerId, Math.max(0, args.afterId), args.exts, args.limit],
    )) as Record<string, unknown>[];
    return rows.map(normalizeFile);
  }

  /**
   * 递归统计目录下的文件数与总大小。用于文件夹摘要。
   * 走一次递归 CTE，避免 N+1 查询。
   */
  async folderSummary(folderId: number): Promise<{ size: number; files: number; folders: number }> {
    const rows = (await this.sql`
      WITH RECURSIVE sub AS (
        SELECT id, type, size FROM files WHERE file_children = ${folderId}
        UNION ALL
        SELECT f.id, f.type, f.size FROM files f JOIN sub ON f.file_children = sub.id
      )
      SELECT
        COALESCE(SUM(CASE WHEN type = 0 THEN size ELSE 0 END), 0) AS total_size,
        COUNT(*) FILTER (WHERE type = 0)::int AS file_count,
        COUNT(*) FILTER (WHERE type = 1)::int AS folder_count
      FROM sub
    `) as Record<string, unknown>[];
    const r = rows[0] ?? {};
    return {
      size: toNum(r.total_size),
      files: toNum(r.file_count),
      folders: toNum(r.folder_count),
    };
  }

  async create(args: {
    type: number;
    name: string;
    ownerId: number;
    parentId: number | null;
    size?: number;
    policyId?: number | null;
    primaryEntity?: number | null;
    isSymbolic?: boolean;
    props?: FileProps | Record<string, unknown>;
    encrypted?: boolean;
  }): Promise<FileRow> {
    const rows = (await this.sql`
      INSERT INTO files (type, name, owner_id, file_children, size, storage_policy_files,
                         primary_entity, is_symbolic, props, encrypted)
      VALUES (${args.type}, ${args.name}, ${args.ownerId}, ${args.parentId}, ${args.size ?? 0},
              ${args.policyId ?? null}, ${args.primaryEntity ?? null},
              ${args.isSymbolic ?? false},
              ${JSON.stringify(args.props ?? {})}::jsonb, ${args.encrypted ?? false})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeFile(rows[0]!);
  }

  /**
   * 在指定目录下批量创建文件夹（同名已存在则跳过）。
   *
   * 注册时给新用户铺「初始文件夹」用：一条 `INSERT ... SELECT ... unnest`
   * 搞定，避免每个目录一次 `childByName` + 一次 `create`（边缘单次往返 ~250ms，
   * 三个目录就是 6 次串行）。
   */
  async createFoldersIfAbsent(
    parentId: number,
    ownerId: number,
    names: string[],
  ): Promise<void> {
    if (names.length === 0) return;
    await this.sql`
      INSERT INTO files (type, name, owner_id, file_children, size, props)
      SELECT ${1}::int, n, ${ownerId}, ${parentId}, 0, '{}'::jsonb
      FROM unnest(${names}::text[]) AS n
      WHERE NOT EXISTS (
        SELECT 1 FROM files f WHERE f.file_children = ${parentId} AND f.name = n
      )
    `;
  }

  async rename(id: number, newName: string): Promise<void> {
    await this.sql`UPDATE files SET name = ${newName}, updated_at = now() WHERE id = ${id}`;
  }

  /**
   * 管理端改文件的存储策略。只改 `storage_policy_files` 这一列的「策略归属」，
   * 不搬动任何 blob —— 与原版 `UpsertFileService` 的语义一致（变更后由后续
   * 写入/上传落新策略，已存在的实体仍指向原节点）。
   */
  async updateStoragePolicy(id: number, policyId: number | null): Promise<void> {
    await this.sql`
      UPDATE files SET storage_policy_files = ${policyId}, updated_at = now() WHERE id = ${id}
    `;
  }

  async move(ids: number[], dstParentId: number | null): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) {
      await this.sql`
        UPDATE files SET file_children = ${dstParentId}, updated_at = now() WHERE id = ${id}
      `;
    }
  }

  async updateParent(id: number, parentId: number | null): Promise<void> {
    await this.sql`
      UPDATE files SET file_children = ${parentId}, updated_at = now() WHERE id = ${id}
    `;
  }

  async updateSize(id: number, size: number): Promise<void> {
    await this.sql`UPDATE files SET size = ${size}, updated_at = now() WHERE id = ${id}`;
  }

  /** 更新文件的「是否加密」标志（新版本覆盖时同步，密钥在实体上）。 */
  async setEncrypted(id: number, encrypted: boolean): Promise<void> {
    await this.sql`UPDATE files SET encrypted = ${encrypted}, updated_at = now() WHERE id = ${id}`;
  }

  async updatePrimaryEntity(id: number, entityId: number | null): Promise<void> {
    await this.sql`
      UPDATE files SET primary_entity = ${entityId}, updated_at = now() WHERE id = ${id}
    `;
  }

  async patchProps(id: number, props: Record<string, unknown>): Promise<void> {
    await this.sql`
      UPDATE files SET props = ${JSON.stringify(props)}::jsonb, updated_at = now() WHERE id = ${id}
    `;
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) {
      await this.sql`DELETE FROM files WHERE id = ${id}`;
    }
  }

  /**
   * 把文件放进回收站。与 `inventory.fileClient.SoftDelete` 一致：
   * `files.name` 改成随机 UUID、`file_children` 置空。
   *
   * 回收站里的项就是这样识别的（`file_children IS NULL AND name <> ''`），
   * 原始路径必须由调用方在改名**之前**算出来并写进 `sys:restore_uri` 元数据。
   */
  async moveToTrash(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.sql`
        UPDATE files
        SET name = ${uuidv4()}, file_children = NULL, updated_at = now()
        WHERE id = ${id}
      `;
    }
  }

  /**
   * 回收站里已到期的项。到期时间来自软删除时写入的 `sys:expected_collect_time`
   * 元数据（秒级时间戳），由原版 `MetadataExpectedCollectTime` 对应。
   */
  async listExpiredTrash(nowSeconds: number, limit = 200): Promise<FileRow[]> {
    const rows = (await this.sql(
      `SELECT f.* FROM files f
       JOIN metadata m
         ON m.file_id = f.id
        AND m.name = $2
        AND m.deleted_at IS NULL
       WHERE f.file_children IS NULL
         AND f.name <> ''
         AND m.value ~ '^[0-9]+$'
         AND m.value::bigint <= $1::bigint
       LIMIT $3`,
      [nowSeconds, MetadataExpectedCollectTime, limit],
    )) as Record<string, unknown>[];
    return rows.map(normalizeFile);
  }

  /** 统计某目录下的直接子节点数量。 */
  async countChildren(parentId: number): Promise<number> {
    const rows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM files WHERE file_children = ${parentId}
    `) as Record<string, unknown>[];
    return toNum(rows[0]?.total);
  }

  /** 收集一批文件及其全部后代 id（用于删除、拼装打包下载）。 */
  async collectDescendants(ids: number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const out = new Set<number>(ids);
    let frontier = ids;
    // 逐层展开，避免单条递归 CTE 参数过多
    for (let depth = 0; depth < 64 && frontier.length > 0; depth++) {
      const rows = (await this.sql`
        SELECT id FROM files WHERE file_children = ANY(${frontier}::int[])
      `) as Record<string, unknown>[];
      const next = rows.map((r) => toNum(r.id)).filter((id) => !out.has(id));
      if (next.length === 0) break;
      for (const id of next) out.add(id);
      frontier = next;
    }
    return Array.from(out);
  }
}

// ---------------------------------------------------------------------------
// 实体
// ---------------------------------------------------------------------------

export class EntityRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<EntityRow | null> {
    const rows = (await this.sql`
      SELECT * FROM entities WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeEntity(rows[0]) : null;
  }

  async create(args: {
    type: number;
    source: string;
    size: number;
    policyId: number;
    createdBy: number | null;
    uploadSessionId?: string | null;
    encMeta?: string | null;
  }): Promise<EntityRow> {
    const rows = (await this.sql`
      INSERT INTO entities (type, source, size, reference_count, storage_policy_entities,
                            created_by, upload_session_id, recycle_options, enc_meta)
      VALUES (${args.type}, ${args.source}, ${args.size}, 1, ${args.policyId},
              ${args.createdBy}, ${args.uploadSessionId ?? null}, '{}'::jsonb,
              ${args.encMeta ?? null})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeEntity(rows[0]!);
  }

  async updateSize(id: number, size: number, source?: string): Promise<void> {
    if (source === undefined) {
      await this.sql`UPDATE entities SET size = ${size}, updated_at = now() WHERE id = ${id}`;
    } else {
      await this.sql`
        UPDATE entities SET size = ${size}, source = ${source}, updated_at = now() WHERE id = ${id}
      `;
    }
  }

  /**
   * 策略间转移文件时更新实体的物理键与策略归属（一次更新两列，避免中间态被并发读走）。
   * 仅改实体本身，不搬动 blob —— 调用方负责先把对象从旧后端 `get` 再往新后端 `put`，
   * 成功后再调本方法并删除旧对象。见 `FileSystemService.transferPolicy`。
   */
  async updateSource(id: number, source: string, policyId: number): Promise<void> {
    await this.sql`
      UPDATE entities SET source = ${source}, storage_policy_entities = ${policyId}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async clearUploadSession(id: number): Promise<void> {
    await this.sql`
      UPDATE entities SET upload_session_id = NULL, updated_at = now() WHERE id = ${id}
    `;
  }

  /**
   * 原子抢占上传会话：仅当 entities.upload_session_id 仍等于本次会话时才清零并返回，
   * 否则（已被并发/重试的另一次收尾清零）返回 false。这是收尾防重入的权威锁，
   * 比 KV 完成标记可靠（KV 写是弱一致、存在竞态窗口，check-then-set 会漏）。
   */
  async claimUploadSession(id: number, sessionId: string): Promise<boolean> {
    const rows = (await this.sql`
      UPDATE entities SET upload_session_id = NULL, updated_at = now()
      WHERE id = ${id} AND upload_session_id = ${sessionId}::uuid
      RETURNING id
    `) as { id: number }[];
    return rows.length > 0;
  }

  /** 增加引用计数（多个文件共用同一份内容时）。 */
  async retain(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.sql`
        UPDATE entities SET reference_count = reference_count + 1, updated_at = now() WHERE id = ${id}
      `;
    }
  }

  /** 减少引用计数，返回引用归零、可以真正删除的实体。 */
  async release(ids: number[]): Promise<EntityRow[]> {
    const toDelete: EntityRow[] = [];
    for (const id of ids) {
      const rows = (await this.sql`
        UPDATE entities
        SET reference_count = GREATEST(0, reference_count - 1), updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `) as Record<string, unknown>[];
      const row = rows[0];
      if (row && toNum(row.reference_count) <= 0) {
        toDelete.push(normalizeEntity(row));
      }
    }
    return toDelete;
  }

  /** 硬删除实体记录。 */
  async hardDelete(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.sql`DELETE FROM file_entities WHERE entity_id = ${id}`;
      await this.sql`DELETE FROM entities WHERE id = ${id}`;
    }
  }

  async listByFile(fileId: number): Promise<EntityRow[]> {
    const rows = (await this.sql`
      SELECT e.* FROM entities e
      JOIN file_entities fe ON fe.entity_id = e.id
      WHERE fe.file_id = ${fileId} AND e.deleted_at IS NULL
      ORDER BY e.created_at DESC
    `) as Record<string, unknown>[];
    return rows.map(normalizeEntity);
  }

  async linkFile(fileId: number, entityId: number): Promise<void> {
    await this.sql`
      INSERT INTO file_entities (file_id, entity_id) VALUES (${fileId}, ${entityId})
      ON CONFLICT DO NOTHING
    `;
  }

  async unlinkFile(fileId: number, entityId: number): Promise<void> {
    await this.sql`
      DELETE FROM file_entities WHERE file_id = ${fileId} AND entity_id = ${entityId}
    `;
  }
}

// ---------------------------------------------------------------------------
// 分享
// ---------------------------------------------------------------------------

export class ShareRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<ShareRow | null> {
    const rows = (await this.sql`
      SELECT * FROM shares WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeShare(rows[0]) : null;
  }

  /**
   * 一次查询取齐分享页要用的四张表：分享 / 文件 / 属主 / 属主所在组。
   *
   * 原来是 share → file → owner → group 四条串行查询，`buildShareResponse` 里
   * 又查一遍 owner，共 5 次数据库往返。边缘在香港、库在新加坡，一次往返
   * 200~300ms，分享页光这一个接口就 1.1s。合成一条 JOIN 后只剩 1 次。
   */
  async infoBundle(id: number): Promise<{
    share: ShareRow;
    file: FileRow | null;
    owner: UserRow | null;
    ownerGroup: GroupRow | null;
  } | null> {
    const rows = (await this.sql`
      SELECT row_to_json(s.*) AS __share,
             row_to_json(f.*) AS __file,
             row_to_json(u.*) AS __owner,
             row_to_json(g.*) AS __group
      FROM shares s
      LEFT JOIN files  f ON f.id = s.file_shares
      LEFT JOIN users  u ON u.id = s.user_shares AND u.deleted_at IS NULL
      LEFT JOIN groups g ON g.id = u.group_users AND g.deleted_at IS NULL
      WHERE s.id = ${id} AND s.deleted_at IS NULL
      LIMIT 1
    `) as Record<string, unknown>[];
    const row = rows[0];
    if (!row) return null;
    const shareRaw = toJson<Record<string, unknown> | null>(row.__share, null);
    if (!shareRaw) return null;
    const fileRaw = toJson<Record<string, unknown> | null>(row.__file, null);
    const ownerRaw = toJson<Record<string, unknown> | null>(row.__owner, null);
    const groupRaw = toJson<Record<string, unknown> | null>(row.__group, null);
    return {
      share: normalizeShare(shareRaw),
      file: fileRaw ? normalizeFile(fileRaw) : null,
      owner: ownerRaw ? normalizeUser(ownerRaw) : null,
      ownerGroup: groupRaw ? normalizeGroup(groupRaw) : null,
    };
  }

  async create(args: {
    fileId: number;
    userId: number;
    password: string | null;
    expires: Date | null;
    remainDownloads: number | null;
    score: number;
    props: Record<string, unknown>;
  }): Promise<ShareRow> {
    const rows = (await this.sql`
      INSERT INTO shares (password, views, downloads, expires, remain_downloads, score, props,
                          file_shares, user_shares)
      VALUES (${args.password}, 0, 0, ${args.expires}, ${args.remainDownloads}, ${args.score},
              ${JSON.stringify(args.props)}::jsonb, ${args.fileId}, ${args.userId})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeShare(rows[0]!);
  }

  async update(
    id: number,
    args: {
      password?: string | null;
      expires?: Date | null;
      remainDownloads?: number | null;
      score?: number;
      props?: Record<string, unknown>;
    },
  ): Promise<void> {
    if (args.password !== undefined) {
      await this.sql`UPDATE shares SET password = ${args.password}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.expires !== undefined) {
      await this.sql`UPDATE shares SET expires = ${args.expires}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.remainDownloads !== undefined) {
      await this.sql`
        UPDATE shares SET remain_downloads = ${args.remainDownloads}, updated_at = now() WHERE id = ${id}
      `;
    }
    if (args.score !== undefined) {
      await this.sql`UPDATE shares SET score = ${args.score}, updated_at = now() WHERE id = ${id}`;
    }
    if (args.props !== undefined) {
      await this.sql`
        UPDATE shares SET props = ${JSON.stringify(args.props)}::jsonb, updated_at = now() WHERE id = ${id}
      `;
    }
  }

  /** 用户是否已购买过该分享（用于下载闸门与 UI 展示）。 */
  async hasPurchased(shareId: number, userId: number): Promise<boolean> {
    const rows = (await this.sql`
      SELECT 1 FROM share_purchases WHERE share_id = ${shareId} AND user_id = ${userId} LIMIT 1
    `) as Record<string, unknown>[];
    return rows.length > 0;
  }

  /**
   * 记录一次购买。返回是否真的插入了新行（(share_id,user_id) 唯一约束下，
   * 重复调用返回 false，保证积分只转移一次）。
   */
  async addPurchase(shareId: number, userId: number, amount: number): Promise<boolean> {
    const rows = (await this.sql`
      INSERT INTO share_purchases (share_id, user_id, amount)
      VALUES (${shareId}, ${userId}, ${amount})
      ON CONFLICT (share_id, user_id) DO NOTHING
      RETURNING id
    `) as Record<string, unknown>[];
    return rows.length > 0;
  }

  async incrementViews(id: number): Promise<void> {
    await this.sql`UPDATE shares SET views = views + 1, updated_at = now() WHERE id = ${id}`;
  }

  async incrementDownloads(id: number, delta = 1): Promise<void> {
    await this.sql`
      UPDATE shares
      SET downloads = downloads + ${delta},
          remain_downloads = CASE
            WHEN remain_downloads IS NULL THEN NULL
            ELSE GREATEST(0, remain_downloads - ${delta})
          END,
          updated_at = now()
      WHERE id = ${id}
    `;
  }

  async listByUser(args: {
    userId: number;
    page: number;
    pageSize: number;
    orderBy: string;
    orderDirection: string;
    /** 对应原版 `ListShareArgs.PublicOnly`：只要 password 为 NULL 的分享。 */
    publicOnly?: boolean;
  }): Promise<{ shares: ShareRow[]; total: number }> {
    const orderCol = whitelist(args.orderBy, ['id', 'created_at', 'updated_at', 'views', 'downloads'], 'id');
    const orderDir = whitelist(args.orderDirection, ['asc', 'desc'], 'desc');
    const offset = Math.max(0, args.page) * args.pageSize;
    const publicCond = args.publicOnly ? ' AND password IS NULL' : '';

    const rows = (await this.sql(
      `SELECT * FROM shares
       WHERE user_shares = $1 AND deleted_at IS NULL${publicCond}
       ORDER BY ${orderCol} ${orderDir}
       LIMIT $2 OFFSET $3`,
      [args.userId, args.pageSize, offset],
    )) as Record<string, unknown>[];

    const countRows = (await this.sql(
      `SELECT COUNT(*)::int AS total FROM shares
       WHERE user_shares = $1 AND deleted_at IS NULL${publicCond}`,
      [args.userId],
    )) as Record<string, unknown>[];

    return { shares: rows.map(normalizeShare), total: toNum(countRows[0]?.total) };
  }

  /** 某文件是否已被分享过（用于在文件列表里标记 shared 字段）。 */
  async sharedFileIds(fileIds: number[]): Promise<Set<number>> {
    if (fileIds.length === 0) return new Set();
    const rows = (await this.sql`
      SELECT DISTINCT file_shares FROM shares
      WHERE file_shares = ANY(${fileIds}::int[]) AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    return new Set(rows.map((r) => toNum(r.file_shares)));
  }

  async softDelete(id: number): Promise<void> {
    await this.sql`UPDATE shares SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  }

  async softDeleteMany(ids: number[], userId: number): Promise<void> {
    for (const id of ids) {
      await this.sql`
        UPDATE shares SET deleted_at = now(), updated_at = now()
        WHERE id = ${id} AND user_shares = ${userId}
      `;
    }
  }

  /**
   * 彻底删除文件前，按 `file_shares` 批量软删这些文件关联的分享。
   *
   * `shares.file_shares → files.id` 是 `ON DELETE SET NULL`：删文件只会把
   * 外键置空而**不删除分享行**，留下 `file_shares = NULL` 的孤儿分享 —— 用户在
   * 分享列表点开它会因解析不到文件而 500。`purge()` 必须在 `files.deleteMany`
   * 之前先软删这些分享。
   */
  async softDeleteByFileIds(fileIds: number[]): Promise<void> {
    if (fileIds.length === 0) return;
    await this.sql`
      UPDATE shares SET deleted_at = now(), updated_at = now()
      WHERE file_shares = ANY(${fileIds}::int[]) AND deleted_at IS NULL
    `;
  }
}

// ---------------------------------------------------------------------------
// 元数据
// ---------------------------------------------------------------------------

export class MetadataRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async listByFile(fileId: number, includePrivate: boolean): Promise<MetadataRow[]> {
    const rows = (await this.sql`
      SELECT * FROM metadata
      WHERE file_id = ${fileId} AND deleted_at IS NULL
        AND (${includePrivate}::boolean OR is_public = true)
      ORDER BY name ASC
    `) as Record<string, unknown>[];
    return rows.map(normalizeMetadata);
  }

  async listByFiles(fileIds: number[], includePrivate: boolean): Promise<MetadataRow[]> {
    if (fileIds.length === 0) return [];
    const rows = (await this.sql`
      SELECT * FROM metadata
      WHERE file_id = ANY(${fileIds}::int[]) AND deleted_at IS NULL
        AND (${includePrivate}::boolean OR is_public = true)
      ORDER BY file_id ASC, name ASC
    `) as Record<string, unknown>[];
    return rows.map(normalizeMetadata);
  }

  async upsert(fileId: number, name: string, value: string, isPublic: boolean): Promise<void> {
    await this.sql`
      INSERT INTO metadata (file_id, name, value, is_public)
      VALUES (${fileId}, ${name}, ${value}, ${isPublic})
      ON CONFLICT (file_id, name)
      DO UPDATE SET value = EXCLUDED.value, is_public = EXCLUDED.is_public,
                    deleted_at = NULL, updated_at = now()
    `;
  }

  async remove(fileId: number, name: string): Promise<void> {
    await this.sql`
      DELETE FROM metadata WHERE file_id = ${fileId} AND name = ${name}
    `;
  }

  async removeAllForFile(fileId: number): Promise<void> {
    await this.sql`DELETE FROM metadata WHERE file_id = ${fileId}`;
  }

  /**
   * 列出已到期（sys:expected_collect_time <= now）的回收站文件 id。
   * 落在元数据域（分域部署下 metadata 不在主库），由本仓储按所在域查询，
   * 避免 `files JOIN metadata` 的跨库 JOIN（原 listExpiredTrash 在分域部署下恒为空，
   * 回收站永不自动清理）。
   */
  async listExpiredCollectTime(nowSeconds: number, limit = 200): Promise<number[]> {
    const rows = (await this.sql(
      `SELECT file_id FROM metadata
       WHERE name = $1 AND deleted_at IS NULL
         AND value ~ '^[0-9]+$' AND value::bigint <= $2::bigint
       LIMIT $3`,
      [MetadataExpectedCollectTime, nowSeconds, limit],
    )) as Record<string, unknown>[];
    return rows.map((r) => toNum(r.file_id));
  }
}

// ---------------------------------------------------------------------------
// 直链
// ---------------------------------------------------------------------------

export class DirectLinkRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async listByFile(fileId: number) {
    const rows = (await this.sql`
      SELECT * FROM direct_links WHERE file_id = ${fileId} AND deleted_at IS NULL ORDER BY id ASC
    `) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: toNum(r.id),
      created_at: toDate(r.created_at) ?? new Date(),
      name: String(r.name ?? ''),
      downloads: toNum(r.downloads),
      speed: toNum(r.speed),
      file_id: toNum(r.file_id),
    }));
  }

  async create(fileId: number, name: string, speed: number) {
    const rows = (await this.sql`
      INSERT INTO direct_links (name, downloads, speed, file_id)
      VALUES (${name}, 0, ${speed}, ${fileId})
      RETURNING *
    `) as Record<string, unknown>[];
    const r = rows[0]!;
    return {
      id: toNum(r.id),
      created_at: toDate(r.created_at) ?? new Date(),
      name: String(r.name ?? ''),
      downloads: toNum(r.downloads),
      speed: toNum(r.speed),
      file_id: toNum(r.file_id),
    };
  }

  async byId(id: number) {
    const rows = (await this.sql`
      SELECT * FROM direct_links WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    const r = rows[0];
    if (!r) return null;
    return {
      id: toNum(r.id),
      created_at: toDate(r.created_at) ?? new Date(),
      name: String(r.name ?? ''),
      downloads: toNum(r.downloads),
      speed: toNum(r.speed),
      file_id: toNum(r.file_id),
    };
  }

  async incrementDownloads(id: number): Promise<void> {
    await this.sql`UPDATE direct_links SET downloads = downloads + 1 WHERE id = ${id}`;
  }

  async softDelete(id: number): Promise<void> {
    await this.sql`
      UPDATE direct_links SET deleted_at = now(), updated_at = now() WHERE id = ${id}
    `;
  }

  /**
   * 按文件 ID 批量**硬删**直链（彻底删除文件前调用，解除外键约束）。
   *
   * ⓵ 必须硬删、不能软删：`direct_links_file_id_fkey` 是 `ON DELETE NO ACTION`，
   *    软删只在 `deleted_at` 打标、物理行仍在，删 `files` 时外键照样挡（报
   *    `update or delete on table "files" violates foreign key constraint
   *    "direct_links_file_id_fkey"`）。只有物理删除直链行才能让文件被删掉。
   * ⓶ 本方法只被 `FileSystemService.purge()` 调用（删文件前先清掉它的直链），
   *    文件都要没了，直链无需保留，硬删是正确的语义。
   */
  async deleteByFileIds(fileIds: number[]): Promise<void> {
    if (fileIds.length === 0) return;
    await this.sql`
      DELETE FROM direct_links WHERE file_id = ANY(${fileIds}::int[])
    `;
  }
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------
// 从节点
// ---------------------------------------------------------------------------

/** 从节点行读取 + 分派任务用的小查询。驱动里带 isolate 缓存的版本在 db/nodes.ts。 */
export class NodeRepo {
  private sql: Sql;
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async byId(id: number): Promise<NodeRow | null> {
    const rows = (await this.sql`
      SELECT * FROM nodes WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeNodeRow(rows[0]) : null;
  }
}

// ---------------------------------------------------------------------------

export class TaskRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async create(args: {
    type: string;
    userId: number;
    publicState: Record<string, unknown>;
    privateState?: string | null;
  }) {
    const rows = (await this.sql`
      INSERT INTO tasks (type, status, public_state, private_state, user_tasks)
      VALUES (${args.type}, 'queued', ${JSON.stringify(args.publicState)}::jsonb,
              ${args.privateState ?? null}, ${args.userId})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeTask(rows[0]!);
  }

  async byId(id: number): Promise<TaskRow | null> {
    const rows = (await this.sql`
      SELECT * FROM tasks WHERE id = ${id} AND deleted_at IS NULL LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeTask(rows[0]) : null;
  }

  async listByUser(args: {
    userId: number;
    pageSize: number;
    types?: string[];
  }): Promise<TaskRow[]> {
    const rows = (await this.sql`
      SELECT * FROM tasks
      WHERE user_tasks = ${args.userId} AND deleted_at IS NULL
        AND (${args.types ?? null}::text[] IS NULL OR type = ANY(${args.types ?? []}::text[]))
      ORDER BY id DESC
      LIMIT ${args.pageSize}
    `) as Record<string, unknown>[];
    return rows.map(normalizeTask);
  }

  /**
   * 找一个尚未结束的同类任务（重建索引这类分批作业要靠它接着推进）。
   *
   * Workers 没有后台 goroutine，一次请求只能跑一批，所以「继续」靠前端再点一次
   * 按钮 —— 复用同一个 task 记录，进度才不会每次都从零开始。
   */
  async findActiveByType(type: string, userId: number): Promise<TaskRow | null> {
    const rows = (await this.sql`
      SELECT * FROM tasks
      WHERE type = ${type} AND user_tasks = ${userId} AND deleted_at IS NULL
        AND status IN ('queued', 'processing')
      ORDER BY id DESC
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeTask(rows[0]) : null;
  }

  /** 同时更新状态、公开状态与私有状态（私有状态存分批游标）。 */
  async updateState(
    id: number,
    status: string,
    publicState: Record<string, unknown>,
    privateState: string,
  ): Promise<void> {
    await this.sql`
      UPDATE tasks SET status = ${status}, public_state = ${JSON.stringify(publicState)}::jsonb,
                       private_state = ${privateState}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  async updateStatus(id: number, status: string, publicState?: Record<string, unknown>): Promise<void> {
    if (publicState) {
      await this.sql`
        UPDATE tasks SET status = ${status}, public_state = ${JSON.stringify(publicState)}::jsonb,
                         updated_at = now()
        WHERE id = ${id}
      `;
    } else {
      await this.sql`UPDATE tasks SET status = ${status}, updated_at = now() WHERE id = ${id}`;
    }
  }

  async softDeleteMany(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.sql`UPDATE tasks SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
    }
  }

  async countByStatus(): Promise<Record<string, number>> {
    const rows = (await this.sql`
      SELECT status, COUNT(*)::int AS total FROM tasks WHERE deleted_at IS NULL GROUP BY status
    `) as Record<string, unknown>[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.status)] = toNum(r.total);
    return out;
  }

  /**
   * 按「任务类型 + 状态」分组计数。供 `/admin/queue/metrics` 把任务归类到
   * 5 个标准队列（media_meta / recycle / io_intense / remote_download / thumb）。
   * 边缘版没有常驻 worker，任务是请求内联跑完的，所以队列计数只能从 `tasks`
   * 表反推，而不是读内存里的队列追踪器。
   */
  async countByTypeStatus(): Promise<{ type: string; status: string; total: number }[]> {
    const rows = (await this.sql`
      SELECT type, status, COUNT(*)::int AS total
      FROM tasks WHERE deleted_at IS NULL
      GROUP BY type, status
    `) as Record<string, unknown>[];
    return rows.map((r) => ({
      type: String(r.type),
      status: String(r.status),
      total: toNum(r.total),
    }));
  }

  /**
   * 已分派给从节点、还没结束的任务（cron 同步用）。
   *
   * `private_state` 是 TEXT 而不是 JSONB，所以用 LIKE 判定而不是
   * `->>'node_task_id'` —— 后者遇到非 JSON 内容会直接报错，把整次 cron 打挂。
   */
  async listNodeDispatched(limit = 50): Promise<TaskRow[]> {
    const rows = (await this.sql`
      SELECT * FROM tasks
      WHERE deleted_at IS NULL AND status IN ('queued', 'processing')
        AND private_state LIKE '%"node_task_id"%'
      ORDER BY id ASC
      LIMIT ${limit}
    `) as Record<string, unknown>[];
    return rows.map(normalizeTask);
  }
}

// ---------------------------------------------------------------------------
// WebDAV 账号
// ---------------------------------------------------------------------------

export interface DavAccountRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  uri: string;
  password: string;
  options: Uint8Array;
  owner_id: number;
}

function normalizeDavAccount(r: Record<string, unknown>): DavAccountRow {
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    name: String(r.name ?? ''),
    uri: String(r.uri ?? ''),
    password: String(r.password ?? ''),
    options:
      r.options instanceof Uint8Array
        ? r.options
        : new Uint8Array(Buffer.from(String(r.options ?? ''), 'base64')),
    owner_id: toNum(r.owner_id),
  };
}

export class DavAccountRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async create(args: {
    ownerId: number;
    name: string;
    uri: string;
    password: string;
    options: Uint8Array;
  }): Promise<DavAccountRow> {
    const rows = (await this.sql`
      INSERT INTO dav_accounts (name, uri, password, options, owner_id)
      VALUES (${args.name}, ${args.uri}, ${args.password}, ${args.options}, ${args.ownerId})
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeDavAccount(rows[0]!);
  }

  async list(args: { ownerId: number; page: number; pageSize: number }): Promise<{
    accounts: DavAccountRow[];
    total: number;
  }> {
    const rows = (await this.sql`
      SELECT * FROM dav_accounts
      WHERE owner_id = ${args.ownerId} AND deleted_at IS NULL
      ORDER BY id ASC
      LIMIT ${args.pageSize} OFFSET ${args.page * args.pageSize}
    `) as Record<string, unknown>[];
    const countRows = (await this.sql`
      SELECT COUNT(*)::int AS total FROM dav_accounts
      WHERE owner_id = ${args.ownerId} AND deleted_at IS NULL
    `) as Record<string, unknown>[];
    return { accounts: rows.map(normalizeDavAccount), total: toNum(countRows[0]?.total) };
  }

  async byIdAndUser(id: number, ownerId: number): Promise<DavAccountRow | null> {
    const rows = (await this.sql`
      SELECT * FROM dav_accounts
      WHERE id = ${id} AND owner_id = ${ownerId} AND deleted_at IS NULL
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizeDavAccount(rows[0]) : null;
  }

  async update(
    id: number,
    patch: { name: string; uri: string; options: Uint8Array },
  ): Promise<DavAccountRow> {
    const rows = (await this.sql`
      UPDATE dav_accounts SET name = ${patch.name}, uri = ${patch.uri},
                              options = ${patch.options}, updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizeDavAccount(rows[0]!);
  }

  async remove(id: number): Promise<void> {
    await this.sql`UPDATE dav_accounts SET deleted_at = now(), updated_at = now() WHERE id = ${id}`;
  }

  /**
   * WebDAV 认证：**用户名是用户的邮箱**，密码是该用户名下任一 WebDAV 账号的密码。
   *
   * 这是上游 `inventory/user.go:GetActiveByDavAccount` 的语义 ——
   * `Where(user.EmailEqualFold(email))` + `WithDavAccounts(Password(pwd))`，
   * 也就是「邮箱 + 应用密码」。前端「连接信息」弹窗里显示的正是登录邮箱，
   * 用户照着填。本仓库早期版本按 `dav_accounts.name` 查，于是照界面填永远是
   * 401（2026-10-26 MT管理器连不上的原因之一）。
   *
   * 密码支持三种存储形态（见 lib/davPassword.ts）：加密、早期 sha256、上游明文。
   */
  async byEmailAndPassword(
    email: string,
    password: string,
    secretKey: string,
  ): Promise<{ account: DavAccountRow } | null> {
    if (!email) return null;
    const rows = (await this.sql`
      SELECT d.* FROM dav_accounts d
      JOIN users u ON u.id = d.owner_id
      WHERE lower(u.email) = lower(${email})
        AND u.status = 'active'
        AND d.deleted_at IS NULL
      ORDER BY d.id ASC
    `) as Record<string, unknown>[];
    for (const row of rows) {
      const account = normalizeDavAccount(row);
      if (await verifyDavPassword(secretKey, account.password, password)) {
        return { account };
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Passkey（WebAuthn 凭据）
// ---------------------------------------------------------------------------

export interface PasskeyRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  user_id: number;
  /** base64 标准字母表编码的凭据 ID（对齐上游 CredentialID 存储方式）。 */
  credential_id: string;
  name: string;
  /** webauthn.Credential 的序列化形态：id / publicKey(COSE, b64) / signCount / aaguid。 */
  credential: Record<string, unknown>;
  used_at: Date | null;
}

function normalizePasskey(r: Record<string, unknown>): PasskeyRow {
  const cred = r.credential;
  return {
    id: toNum(r.id),
    created_at: toDate(r.created_at) ?? new Date(),
    updated_at: toDate(r.updated_at) ?? new Date(),
    deleted_at: toDate(r.deleted_at),
    user_id: toNum(r.user_id),
    credential_id: String(r.credential_id ?? ''),
    name: String(r.name ?? ''),
    credential:
      typeof cred === 'string' ? (JSON.parse(cred) as Record<string, unknown>) : (cred ?? {}) as Record<string, unknown>,
    used_at: toDate(r.used_at),
  };
}

export class PasskeyRepo {
  private sql: Sql;
  /** 绑定到一个具体的数据库客户端；库的选择由调用方决定（见 db/shard.ts）。 */
  constructor(sql: Sql) {
    this.sql = sql;
  }

  async create(args: {
    userId: number;
    credentialId: string;
    name: string;
    credential: Record<string, unknown>;
  }): Promise<PasskeyRow> {
    const rows = (await this.sql`
      INSERT INTO passkeys (user_id, credential_id, name, credential)
      VALUES (${args.userId}, ${args.credentialId}, ${args.name}, ${JSON.stringify(args.credential)}::jsonb)
      RETURNING *
    `) as Record<string, unknown>[];
    return normalizePasskey(rows[0]!);
  }

  async listByUser(userId: number): Promise<PasskeyRow[]> {
    const rows = (await this.sql`
      SELECT * FROM passkeys
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY id ASC
    `) as Record<string, unknown>[];
    return rows.map(normalizePasskey);
  }

  async byCredentialId(userId: number, credentialId: string): Promise<PasskeyRow | null> {
    const rows = (await this.sql`
      SELECT * FROM passkeys
      WHERE user_id = ${userId} AND credential_id = ${credentialId} AND deleted_at IS NULL
      LIMIT 1
    `) as Record<string, unknown>[];
    return rows[0] ? normalizePasskey(rows[0]) : null;
  }

  async markUsed(userId: number, credentialId: string): Promise<void> {
    await this.sql`
      UPDATE passkeys SET used_at = now(), updated_at = now()
      WHERE user_id = ${userId} AND credential_id = ${credentialId}
    `;
  }

  async updateCounter(userId: number, credentialId: string, signCount: number): Promise<void> {
    await this.sql`
      UPDATE passkeys
      SET credential = jsonb_set(credential, '{signCount}', ${JSON.stringify(signCount)}::jsonb, true),
          updated_at = now()
      WHERE user_id = ${userId} AND credential_id = ${credentialId}
    `;
  }

  async remove(userId: number, credentialId: string): Promise<void> {
    await this.sql`
      UPDATE passkeys SET deleted_at = now(), updated_at = now()
      WHERE user_id = ${userId} AND credential_id = ${credentialId}
    `;
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/**
 * 把用户提供的排序字段限制在候选集合内。
 * ORDER BY 无法参数化，所以必须走白名单，绝不能直接把用户输入拼进 SQL。
 */
export function whitelist(value: string | undefined | null, allowed: string[], fallback: string): string {
  if (value && allowed.includes(value)) return value;
  return fallback;
}
