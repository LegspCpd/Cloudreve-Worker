/**
 * 管理后台「内容」端点。对应上游 `routers/router.go` 的
 * `admin/user`、`admin/file`、`admin/entity`、`admin/share`、`admin/queue`、
 * `admin/node`、`admin/oauthClient` 七个分组（`router.go:1048-1237`）。
 *
 * 这些路由挂载在 `adminRoutes` 的 `/` 下，所以这里写的是**去掉 `/admin` 前缀**
 * 的相对路径；管理员门禁由父路由那条 `use('*')` 中间件统一负责。
 *
 * 契约口径（都回过源码，不是猜的）：
 *   - 列表请求体统一是上游 `AdminListService`：
 *     `{ page, page_size, order_by, order_direction, conditions, searches }`
 *     （`service/admin/list.go:9`）。`conditions` 的键名来自各 service 文件里的
 *     `*Condition = "..."` 常量。
 *   - 列表响应统一是 `{ <实体复数>, pagination }`（`service/admin/response.go`）。
 *   - 详情 / 更新用 `PUT { "user": {...} }` 这种信封（`UpsertUserService`），
 *     路径里的 id 是**数字**（前端 `CommonMixin.id: number`）。
 *   - 批量删除用 `POST .../batch/delete { ids: number[] }`（`BatchIDService`）。
 *
 * SQL 写法遵循本仓库既有约定（`db/repo.ts`）：`sql(字符串, 参数数组)` 加
 * 编号占位符。**不要**用 `${}` 插值拼 SQL —— Neon 的 `neon()` 没有 fragment
 * 辅助函数，`sql.unsafe()` 是「执行查询」而不是「生成片段」，混用会误执行。
 * 只有 ORDER BY 的列名与方向走白名单后直接拼接。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { AppError, CodeFeatureNotEnabled, CodeInvalidActionOnSystemNode, CodeNodeUsedByStoragePolicy, Err } from '../lib/errors';
import { BACKEND_VERSION } from './site';
import { digestPassword, randomString } from '../lib/crypto';
import { logAudit } from '../services/audit';
import { assertSafeRedirectUri } from '../services/oauth';
import { getSql, type Sql } from '../db';
import { invalidateNodeCache } from '../db/nodes';
import { resolveDomainHandle } from '../db/shard';
import type { HashIDCodec } from '../lib/hashid';
import { numericId, paginationArgs, paginationOf, unwrapBody } from './shared';

export const adminContentRoutes = new Hono<AppBindings>();

/** 每个管理员请求共用的东西，省得每处都取一遍。 */
interface Ctx {
  c: Context<AppBindings>;
  sql: Sql;
  codec: HashIDCodec;
  ctx: ReturnType<typeof ctxOf>;
}

function withCtx(c: Context<AppBindings>): Ctx {
  const ctx = ctxOf(c);
  return { c, sql: getSql(ctx.env), codec: ctx.codec, ctx };
}

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const num = (v: unknown, fallback = 0): number => {
  if (v === null || v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const jsonArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** 一组编号去重、丢掉非法值。 */
function idList(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const out = new Set<number>();
  for (const v of input) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return [...out];
}

/** 逐条执行一条带 `$1` 占位符的语句，用于批量删除（本仓库不用数组参数）。 */
async function forEachId(sql: Sql, template: (index: number) => string, ids: number[]) {
  for (let i = 0; i < ids.length; i += 1) {
    await sql(template(i), [ids[i]]);
  }
}

/** 条件字典里的字符串。 */
function condStr(conditions: Record<string, string> | undefined, key: string): string {
  return conditions?.[key] ?? '';
}

/** 条件字典里的数字 id，空/非法一律 null。 */
function condNum(conditions: Record<string, string> | undefined, key: string): number | null {
  const raw = conditions?.[key];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 条件字典里的布尔，对应上游 `setting.IsTrueValue`。 */
function condBool(conditions: Record<string, string> | undefined, key: string): boolean {
  const raw = conditions?.[key];
  if (!raw) return false;
  return ['true', '1', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** ORDER BY 的列名白名单。 */
function orderColumn(raw: unknown, allowed: readonly string[], fallback = 'id'): string {
  const v = typeof raw === 'string' ? raw : '';
  return allowed.includes(v) ? v : fallback;
}

/** 排序方向只认 desc，其余按 asc（与上游 `getOrderTerm` 一致）。 */
function orderDirection(raw: unknown): 'ASC' | 'DESC' {
  return typeof raw === 'string' && raw.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
}

/** 解析请求体。 */
async function readBody(c: Context<AppBindings>): Promise<Record<string, unknown>> {
  return (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

/** 用户对外形态，对齐前端 `User`（`api/dashboard.ts:249`）。 */
function userToResponse(
  codec: HashIDCodec,
  user: Record<string, unknown>,
  group: Record<string, unknown> | null,
  policy: { id: number; name: string; type: string } | null,
) {
  const id = num(user.id);
  const settings = (user.settings as Record<string, unknown> | undefined) ?? {};
  const pack = settings.group_pack as
    | { group_id?: unknown; prev_group_id?: unknown; expire_at?: unknown }
    | undefined;
  return {
    id,
    hash_id: codec.encodeUserID(id),
    created_at: iso(user.created_at),
    updated_at: iso(user.updated_at),
    deleted_at: iso(user.deleted_at),
    email: String(user.email ?? ''),
    nick: String(user.nick ?? ''),
    status: String(user.status ?? 'active'),
    storage: num(user.storage),
    avatar: (user.avatar as string) ?? '',
    group_users: num(user.group_users),
    settings,
    // 前端 `UserRow` 靠它决定是否显示「已开启两步验证」角标
    two_fa_enabled: Boolean(user.two_factor_secret),
    // 积分（edge 自建 Pro 功能）：前端用户编辑弹窗的「积分」字段读它。
    // 官方开源版这里是写死 value={0} 的装饰位，edge 改为展示真实值。
    credit: num(settings.credit),
    // 用户组套餐（edge 自建，payment.ts 写在 settings.group_pack）：
    //   { group_id, prev_group_id, expire_at }。官方开源版此字段是 Pro 装饰位。
    group_expires: pack ? iso(pack.expire_at) : null,
    previous_group: pack ? num(pack.prev_group_id) : 0,
    edges: {
      group: group
        ? {
            id: num(group.id),
            hash_id: codec.encodeGroupID(num(group.id)),
            name: String(group.name ?? ''),
            max_storage: num(group.max_storage),
            speed_limit: num(group.speed_limit),
          }
        : undefined,
      storage_policy: policy ?? undefined,
      openid: [],
      passkey: [],
    },
  };
}

/** 取用户详情要用到的组与策略，顺手拼成 edges 里的形状。 */
async function userEdges(ctx: ReturnType<typeof ctxOf>, groupId: number) {
  const group = groupId ? await ctx.groups.byId(groupId) : null;
  const policyId = group?.storage_policy_id ?? null;
  const policy = policyId ? await ctx.policies.byId(policyId) : null;
  return {
    group: (group as unknown as Record<string, unknown> | null) ?? null,
    policy: policy ? { id: policy.id, name: policy.name, type: policy.type } : null,
  };
}

/** `POST /admin/user` —— 用户列表。条件键 `user_email` / `user_nick` / `user_group` / `user_status`。 */
adminContentRoutes.post('/user', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const email = condStr(conditions, 'user_email');
  const nick = condStr(conditions, 'user_nick');
  const status = condStr(conditions, 'user_status');
  const groupId = condNum(conditions, 'user_group');
  const orderCol = orderColumn(
    body.order_by,
    ['id', 'email', 'nick', 'created_at', 'updated_at', 'storage', 'group_users', 'status'],
  );
  const orderDir = orderDirection(body.order_direction);

  const where = `deleted_at IS NULL
      AND ($1::text = '' OR email ILIKE '%' || $1 || '%')
      AND ($2::text = '' OR nick  ILIKE '%' || $2 || '%')
      AND ($3::text = '' OR status = $3)
      AND ($4::int IS NULL OR group_users = $4)`;
  const params = [email, nick, status, groupId];

  const rows = (await sql(
    `SELECT * FROM users WHERE ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $5 OFFSET $6`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM users WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];

  const out = [];
  for (const u of rows) {
    const edges = await userEdges(ctx, num(u.group_users));
    out.push(userToResponse(codec, u, edges.group, edges.policy));
  }

  return ok(c, { users: out, pagination: paginationOf(page, pageSize, num(countRows[0]?.total)) });
});

/** `GET /admin/user/:id` —— 用户详情。 */
adminContentRoutes.get('/user/:id', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeUserID(v));
  if (id === null) return fail(c, Err.userNotFound());

  const rows = (await sql('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [
    id,
  ])) as Record<string, unknown>[];
  if (!rows[0]) return fail(c, Err.userNotFound());

  const user = rows[0];
  const edges = await userEdges(ctx, num(user.group_users));
  return ok(c, {
      ...userToResponse(codec, user, edges.group, edges.policy),
      capacity: { total: num(edges.group?.max_storage), used: num(user.storage) },
    });
});

/**
 * `PUT /admin/user` 与 `PUT /admin/user/:id` —— 创建 / 更新用户。
 * 请求体是 `{ user: {...}, password?, two_fa? }`（`UpsertUserService`）。
 *
 * 两个细节：
 *   - 前端把新密码放在 `user.password` 里，也放在顶层 `password`，两处都认；
 *   - `two_fa: "clear"` 是「重置两步验证」的表达（`UserDialog.tsx:95`），
 *     即清空 TOTP 密钥。
 */
/**
 * 管理员创建/修改用户时的凭证校验（对应上游 `adminUserEmailValidation`：
 * `binding:"required,email"`，密码 `omitempty,min=6,max=128`）。
 *
 * 之前只在创建时检查「非空 + 长度 >= 6」，改用户时连格式都不校验 —— 能把
 * 邮箱改成一个不存在的串，之后密码重置、激活邮件全部失效。
 */
function assertEmail(value: string): string {
  const email = value.trim();
  // 口径接近 go-playground 的 email：单个 @，域名至少有一个点，长度 <= 254。
  if (email.length > 254 || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
    throw Err.param('Email format error');
  }
  return email;
}

function assertPassword(value: string): void {
  if (value.length < 6 || value.length > 128) {
    throw Err.param('Password should be between 6 and 128 characters');
  }
}

async function upsertUser(c: Context<AppBindings>, id: number | null) {
  const { sql, codec, ctx } = withCtx(c);
  const raw = await readBody(c);
  const body = unwrapBody<Record<string, unknown>>(raw, 'user');
  const password = String(body.password ?? raw.password ?? '');

  if (id === null) {
    const email = assertEmail(String(body.email ?? ''));
    if (!password) throw Err.param('Password is required');
    assertPassword(password);

    const exists = (await sql(
      'SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1',
      [email],
    )) as Record<string, unknown>[];
    if (exists[0]) throw new AppError(40032, 'This email is already used');

    const gid = num(body.group_users, 2) || 2;
    if (!(await ctx.groups.byId(gid))) throw new AppError(40039, 'Group not found');

    const digest = await digestPassword(password);
    const rows = (await sql(
      `INSERT INTO users (email, nick, password, status, storage, group_users, settings)
       VALUES ($1, $2, $3, $4, 0, $5, '{}'::jsonb) RETURNING *`,
      [email, String(body.nick ?? email.split('@')[0]), digest, String(body.status ?? 'active'), gid],
    )) as Record<string, unknown>[];
    const edges = await userEdges(ctx, gid);
    return userToResponse(codec, rows[0]!, edges.group, edges.policy);
  }

  const rows = (await sql('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [
    id,
  ])) as Record<string, unknown>[];
  if (!rows[0]) throw Err.userNotFound();

  if (body.email !== undefined) {
    await sql('UPDATE users SET email = $2, updated_at = now() WHERE id = $1', [
      id,
      assertEmail(String(body.email)),
    ]);
  }
  if (body.nick !== undefined) {
    await sql('UPDATE users SET nick = $2, updated_at = now() WHERE id = $1', [id, String(body.nick)]);
  }
  if (body.status !== undefined) {
    const status = String(body.status);
    if (!['active', 'inactive', 'manual_banned', 'sys_banned'].includes(status)) {
      throw Err.param('Invalid status');
    }
    await sql('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }
  if (body.group_users !== undefined) {
    const gid = num(body.group_users);
    if (id === 1 && gid !== 1) {
      throw new AppError(40042, 'Cannot change the group of the default user');
    }
    if (gid > 0) {
      if (!(await ctx.groups.byId(gid))) throw new AppError(40039, 'Group not found');
      await ctx.users.updateGroup(id, gid);
    }
  }
  if (password) {
    assertPassword(password);
    await ctx.users.updatePassword(id, await digestPassword(password));
  }
  // 积分调整（edge 自建）：管理员在用户编辑弹窗里直接改积分余额。
  if (body.credit !== undefined) {
    const credit = num(body.credit);
    if (credit < 0) throw Err.param('Credit cannot be negative');
    // 只改 credit 这一个键：原来的「读整份 settings 再整行写回」会抹掉
    // 同一时刻用户自己买的容量包/购买组记录。
    await ctx.users.setCredit(id, credit);
    logAudit(ctx, 'points_change', id, { credit, reason: 'admin_adjust' });
  }
  if (raw.two_fa === 'clear') {
    await ctx.users.setTwoFactorSecret(id, null);
  }

  const after = (await sql('SELECT * FROM users WHERE id = $1 LIMIT 1', [id])) as Record<
    string,
    unknown
  >[];
  const edges = await userEdges(ctx, num(after[0]?.group_users));
  return userToResponse(codec, after[0]!, edges.group, edges.policy);
}

adminContentRoutes.put('/user', async (c) => {
  try {
    return ok(c, await upsertUser(c, null));
  } catch (e) {
    return fail(c, e);
  }
});

adminContentRoutes.put('/user/:id', async (c) => {
  const { codec } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeUserID(v));
  if (id === null) return fail(c, Err.userNotFound());
  try {
    return ok(c, await upsertUser(c, id));
  } catch (e) {
    return fail(c, e);
  }
});

/** `POST /admin/user/batch/delete` —— 批量封禁（软删除）。对应 `AdminDeleteUser`。 */
adminContentRoutes.post('/user/batch/delete', async (c) => {
  const { sql } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No user selected'));
  // 初始用户禁止操作，与原版一致
  for (const id of ids) {
    if (id === 1) throw new AppError(40043, 'Cannot perform this action on the default user');
  }
  await forEachId(
    sql,
    () => `UPDATE users SET status = 'sys_banned', deleted_at = now(), updated_at = now() WHERE id = $1`,
    ids,
  );
  // 上游 PR #3355：删除用户连带吊销其 OAuth 授权，防止已签发的 refresh token
  // 继续访问第三方应用（边缘版用户只软封禁，授权行同样软删）。
  await sql`UPDATE oauth_grants SET deleted_at = now(), updated_at = now()
            WHERE user_id = ANY(${ids}::int[]) AND deleted_at IS NULL`;
  return ok(c);
});

/** `POST /admin/user/:id/calibrate` —— 重算已用容量。对应 `AdminCalibrateStorage`。 */
adminContentRoutes.post('/user/:id/calibrate', async (c) => {
  const { codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeUserID(v));
  if (id === null) return fail(c, Err.userNotFound());
  try {
    await ctx.users.recalcStorage(id);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

/** 文件对外形态，对齐前端 `File`。`user_hash_id` / `file_hash_id` 是行内头像要用的。 */
async function fileToResponse(
  codec: HashIDCodec,
  ctx: ReturnType<typeof ctxOf>,
  f: Record<string, unknown>,
) {
  const id = num(f.id);
  const ownerId = num(f.owner_id);
  const owner = ownerId ? await ctx.users.byId(ownerId) : null;
  return {
    id,
    created_at: iso(f.created_at),
    updated_at: iso(f.updated_at),
    deleted_at: iso(f.deleted_at),
    type: num(f.type),
    name: String(f.name ?? ''),
    owner_id: ownerId,
    size: num(f.size),
    primary_entity: num(f.primary_entity),
    file_children: num(f.file_children),
    is_symbolic: Boolean(f.is_symbolic),
    storage_policy_files: num(f.storage_policy_files),
    props: f.props ?? {},
    user_hash_id: codec.encodeUserID(ownerId),
    file_hash_id: codec.encodeFileID(id),
    edges: {
      owner: owner ? { id: ownerId, nick: owner.nick, email: owner.email } : undefined,
    },
  };
}

/**
 * `POST /admin/file` —— 全站文件（扁平）列表。对应 `AdminListService.Files`
 * （`service/admin/file.go:162`）。
 *
 * 只列**真实文件**（`type = 0`，不含目录）且不含回收站；条件键：
 * `file_name` / `file_user` / `file_policy` / `file_metadata` /
 * `file_shared` / `file_direct_link`。
 */
adminContentRoutes.post('/file', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const name = condStr(conditions, 'file_name');
  const userId = condNum(conditions, 'file_user');
  const policyId = condNum(conditions, 'file_policy');
  const metadata = condStr(conditions, 'file_metadata');
  const shared = condBool(conditions, 'file_shared');
  const hasDirectLink = condBool(conditions, 'file_direct_link');
  const orderCol = orderColumn(body.order_by, ['id', 'name', 'size', 'created_at', 'updated_at']);
  const orderDir = orderDirection(body.order_direction);

  // 「按元数据筛选」：metadata 在分域库（DATABASE_URL_3）时不能跨库
  // EXISTS 子查询 —— 先在元数据域里解析出命中的 file_id 集合，再以
  // `f.id = ANY(...)` 参与主库查询。域不可用/未启用时该条件按空集处理。
  let metadataFileIds: number[] | null = null;
  if (metadata !== '') {
    try {
      const metaSql = resolveDomainHandle(c.env, 'metadata').sql;
      const hits = (await metaSql`SELECT file_id FROM metadata WHERE deleted_at IS NULL AND name = ${metadata} LIMIT 10000`) as Array<{ file_id: number }>;
      metadataFileIds = hits.map((h) => Number(h.file_id));
      if (metadataFileIds.length === 0) {
        // 无命中：直接返回空页，避免下面 ANY(空数组) 语义歧义
        return ok(c, { files: [], pagination: paginationOf(page, pageSize, 0) });
      }
    } catch {
      // 元数据域不可用：筛选条件按「无命中」处理，不让整个列表接口挂掉
      return ok(c, { files: [], pagination: paginationOf(page, pageSize, 0) });
    }
  }

  // files 表没有 deleted_at 列（回收站按 entities 软删，见 migrations/0001 注释）
  const where = `f.type = 0
      AND ($1::text = '' OR f.name ILIKE '%' || $1 || '%')
      AND ($2::int IS NULL OR f.owner_id = $2)
      AND ($3::int IS NULL OR f.storage_policy_files = $3)
      AND ($4 = false OR EXISTS (
            SELECT 1 FROM shares s WHERE s.file_shares = f.id AND s.deleted_at IS NULL))
      AND ($5 = false OR EXISTS (
            SELECT 1 FROM direct_links d WHERE d.file_id = f.id AND d.deleted_at IS NULL))
      AND ($6::int[] IS NULL OR f.id = ANY($6::int[]))`;
  const params = [name, userId, policyId, shared, hasDirectLink, metadataFileIds];

  const rows = (await sql(
    `SELECT f.* FROM files f WHERE ${where}
     ORDER BY f.${orderCol} ${orderDir} LIMIT $7 OFFSET $8`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM files f WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];

  const out = [];
  for (const f of rows) out.push(await fileToResponse(codec, ctx, f));
  return ok(c, { files: out, pagination: paginationOf(page, pageSize, num(countRows[0]?.total)) });
});

/** `GET /admin/file/:id` —— 文件详情（含元数据、实体、直链、分享）。 */
adminContentRoutes.get('/file/:id', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeFileID(v));
  if (id === null) return fail(c, Err.fileNotFound());

  const rows = (await sql('SELECT * FROM files WHERE id = $1 LIMIT 1', [
    id,
  ])) as Record<string, unknown>[];
  if (!rows[0]) return fail(c, Err.fileNotFound());

  // metadata 分域后不在主库：走 ctx.metadata（分域感知 + 失败自动降级）
  const meta = (await ctx.metadata.listByFile(id, true)).map((m) => ({
    id: m.id,
    name: m.name,
    value: m.value,
    is_public: m.is_public,
  }));
  const entities = (await sql(
    `SELECT e.* FROM entities e
     JOIN file_entities fe ON fe.entity_id = e.id
     WHERE fe.file_id = $1 AND e.deleted_at IS NULL ORDER BY e.id ASC`,
    [id],
  )) as Record<string, unknown>[];
  const links = (await sql(
    'SELECT * FROM direct_links WHERE file_id = $1 AND deleted_at IS NULL ORDER BY id ASC',
    [id],
  )) as Record<string, unknown>[];
  const shares = (await sql(
    'SELECT * FROM shares WHERE file_shares = $1 AND deleted_at IS NULL ORDER BY id ASC',
    [id],
  )) as Record<string, unknown>[];

  const base = await fileToResponse(codec, ctx, rows[0]);
  return ok(c, {
      ...base,
      edges: {
        ...base.edges,
        metadata: meta.map((m) => ({
          id: num(m.id),
          name: String(m.name ?? ''),
          value: String(m.value ?? ''),
          is_public: Boolean(m.is_public),
        })),
        entities: entities.map((e) => entityToResponse(codec, e)),
        direct_links: links.map((l) => ({
          id: num(l.id),
          name: String(l.name ?? ''),
          downloads: num(l.downloads),
          speed: num(l.speed),
        })),
        shares: shares.map((s) => ({ id: num(s.id), downloads: num(s.downloads) })),
      },
    });
});

/** `PUT /admin/file/:id` —— 改文件名。对应 `UpsertFileService`。 */
adminContentRoutes.put('/file/:id', async (c) => {
  const { codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeFileID(v));
  if (id === null) return fail(c, Err.fileNotFound());
  const raw = await readBody(c);
  const body = unwrapBody<Record<string, unknown>>(raw, 'file');
  try {
    if (body.name !== undefined) {
      const name = String(body.name);
      if (!name) throw Err.illegalName('File name cannot be empty');
      await ctx.files.rename(id, name);
    }
    // 存储策略归属（edge 自建）：前端 FileForm 的 SinglePolicySelectionInput 送原始数字 id。
    if (body.storage_policy_files !== undefined) {
      const raw = body.storage_policy_files;
      // 允许 0 表示「不指定」（与前端 emptyValue 语义对齐）。
      const pid = raw === null || raw === '' ? 0 : Number(raw);
      if (!Number.isFinite(pid) || pid < 0) throw Err.param('Invalid storage policy');
      if (pid > 0 && !(await ctx.policies.byId(pid))) {
        throw new AppError(40040, 'Storage policy not found');
      }
      await ctx.files.updateStoragePolicy(id, pid > 0 ? pid : null);
    }
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * `GET /admin/file/url/:id` —— 取文件的下载直链。
 * 对应 `AdminGetFileUrl`：有直链就用直链，否则给出官方内容接口地址。
 */
adminContentRoutes.get('/file/url/:id', async (c) => {
  const { codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeFileID(v));
  if (id === null) return fail(c, Err.fileNotFound());

  const base = ctx.settings.siteUrl.replace(/\/+$/, '');
  const links = await ctx.directLinks.listByFile(id);
  if (links.length === 0) {
    return ok(c, `${base}/api/v4/file/${codec.encodeFileID(id)}/content`);
  }
  return ok(c, `${base}/s/${codec.encodeSourceLinkID(num(links[0]!.id))}`);
});

/** `POST /admin/file/batch/delete` —— 批量删除文件（真删，不进回收站）。 */
adminContentRoutes.post('/file/batch/delete', async (c) => {
  const { ctx } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No file selected'));
  try {
    // 连子目录一起删，避免留下孤儿行
    const descendants = await ctx.files.collectDescendants(ids);
    const all = [...new Set([...ids, ...descendants])];
    await ctx.entities.release(all);
    await ctx.files.deleteMany(all);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 实体（物理对象）
// ---------------------------------------------------------------------------

/** 实体对外形态，对齐前端 `Entity`。 */
function entityToResponse(codec: HashIDCodec, e: Record<string, unknown>) {
  const id = num(e.id);
  const createdBy = num(e.created_by);
  return {
    id,
    created_at: iso(e.created_at),
    updated_at: iso(e.updated_at),
    deleted_at: iso(e.deleted_at),
    type: num(e.type),
    source: String(e.source ?? ''),
    size: num(e.size),
    reference_count: num(e.reference_count),
    storage_policy_entities: num(e.storage_policy_entities),
    upload_session_id: (e.upload_session_id as string) ?? null,
    created_by: createdBy,
    props: e.recycle_options ?? {},
    user_hash_id: createdBy ? codec.encodeUserID(createdBy) : undefined,
    edges: {},
  };
}

/** `POST /admin/entity` —— 实体列表。条件键 `entity_policy` / `entity_user` / `entity_type`。 */
adminContentRoutes.post('/entity', async (c) => {
  const { sql, codec } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const userId = condNum(conditions, 'entity_user');
  const policyId = condNum(conditions, 'entity_policy');
  const typeId = condNum(conditions, 'entity_type');
  const orderCol = orderColumn(body.order_by, ['id', 'size', 'updated_at', 'reference_count']);
  const orderDir = orderDirection(body.order_direction);

  const where = `deleted_at IS NULL
      AND ($1::int IS NULL OR created_by = $1)
      AND ($2::int IS NULL OR storage_policy_entities = $2)
      AND ($3::int IS NULL OR type = $3)`;
  const params = [userId, policyId, typeId];

  const rows = (await sql(
    `SELECT * FROM entities WHERE ${where}
     ORDER BY ${orderCol} ${orderDir} LIMIT $4 OFFSET $5`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM entities WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];

  return ok(c, {
      entities: rows.map((e) => entityToResponse(codec, e)),
      pagination: paginationOf(page, pageSize, num(countRows[0]?.total)),
    });
});

/** `GET /admin/entity/:id` —— 实体详情，带上引用了它的文件。 */
adminContentRoutes.get('/entity/:id', async (c) => {
  const { sql, codec } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeEntityID(v));
  if (id === null) return fail(c, new AppError(40077, 'Entity not found'));

  const rows = (await sql('SELECT * FROM entities WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [
    id,
  ])) as Record<string, unknown>[];
  if (!rows[0]) return fail(c, new AppError(40077, 'Entity not found'));

  const files = (await sql(
    `SELECT f.* FROM files f
     JOIN file_entities fe ON fe.file_id = f.id
     WHERE fe.entity_id = $1 ORDER BY f.id ASC`,
    [id],
  )) as Record<string, unknown>[];

  // 前端 `EntityFileList` 用这张表把每个文件的归属者渲染成头像
  const map: Record<number, string> = {};
  for (const f of files) {
    const owner = num(f.owner_id);
    if (owner && !map[owner]) map[owner] = codec.encodeUserID(owner);
  }

  return ok(c, {
      ...entityToResponse(codec, rows[0]),
      user_hash_id_map: map,
      edges: {
        file: files.map((f) => ({
          id: num(f.id),
          name: String(f.name ?? ''),
          size: num(f.size),
          owner_id: num(f.owner_id),
          user_hash_id: codec.encodeUserID(num(f.owner_id)),
        })),
      },
    });
});

/**
 * `GET /admin/entity/url/:id` —— 取实体的存储直链。
 * 对应 `AdminGetEntityUrl`：调驱动 `source()` 拿真实地址（与 `download.ts:101` 同一套参数）。
 */
adminContentRoutes.get('/entity/url/:id', async (c) => {
  const { codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeEntityID(v));
  if (id === null) return fail(c, new AppError(40077, 'Entity not found'));

  const entity = await ctx.entities.byId(id);
  if (!entity || entity.deleted_at) {
    return fail(c, new AppError(40077, 'Entity not found'));
  }
  // 客户端加密的实体：存储里是密文，直接给直链等于给用户一个打不开的文件。
  // 这种实体只能经站点代理（/file/content）下载，那里会解密。
  if (entity.enc_meta) {
    return fail(
      c,
      new AppError(40035, 'Entity is client-side encrypted; download it through the site instead'),
    );
  }
  try {
    const policy = await ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw new AppError(40035, 'Storage policy not found');
    const driver = ctx.driverFor(policy);
    const url = await driver.source(entity.source, {
      // 后台取直链不设过期，与原版 `GetEntityUrl` 的口径一致
      expire: 0,
      isDownload: true,
      displayName: '',
      speed: 0,
    });
    return ok(c, url);
  } catch (e) {
    return fail(c, e);
  }
});

/** `POST /admin/entity/batch/delete` —— 批量删除实体。 */
adminContentRoutes.post('/entity/batch/delete', async (c) => {
  const { ctx } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No entity selected'));
  try {
    await ctx.entities.hardDelete(ids);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 分享
// ---------------------------------------------------------------------------

/** 分享对外形态，对齐前端 `Share`（含 `share_link`、`user_hash_id`）。 */
function shareToResponse(codec: HashIDCodec, siteUrl: string, s: Record<string, unknown>) {
  const id = num(s.id);
  const userId = num(s.user_shares);
  return {
    id,
    created_at: iso(s.created_at),
    updated_at: iso(s.updated_at),
    deleted_at: iso(s.deleted_at),
    password: String(s.password ?? ''),
    views: num(s.views),
    downloads: num(s.downloads),
    expires: iso(s.expires),
    remain_downloads: num(s.remain_downloads),
    props: s.props ?? {},
    user_shares: userId,
    file_shares: num(s.file_shares),
    user_hash_id: userId ? codec.encodeUserID(userId) : undefined,
    share_link: `${siteUrl.replace(/\/+$/, '')}/s/${codec.encodeShareID(id)}`,
    edges: {},
  };
}

/** `POST /admin/share` —— 分享列表。条件键 `share_user_id` / `share_file_id` / `share_id`。 */
adminContentRoutes.post('/share', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const userId = condNum(conditions, 'share_user_id');
  const fileId = condNum(conditions, 'share_file_id');
  const shareIds = condStr(conditions, 'share_id')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const orderCol = orderColumn(body.order_by, ['id', 'created_at', 'updated_at', 'views', 'downloads']);
  const orderDir = orderDirection(body.order_direction);

  const where = `deleted_at IS NULL
      AND ($1::int IS NULL OR user_shares = $1)
      AND ($2::int IS NULL OR file_shares = $2)
      AND ($3::int[] IS NULL OR id = ANY($3::int[]))`;
  // share_id 是逗号分隔的 id 列表；为空时传 null 让这个条件整体失效
  const params = [userId, fileId, shareIds.length ? shareIds : null];

  const rows = (await sql(
    `SELECT * FROM shares WHERE ${where}
     ORDER BY ${orderCol} ${orderDir} LIMIT $4 OFFSET $5`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM shares WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];

  return ok(c, {
      shares: rows.map((s) => shareToResponse(codec, ctx.settings.siteUrl, s)),
      pagination: paginationOf(page, pageSize, num(countRows[0]?.total)),
    });
});

/** `GET /admin/share/:id` —— 分享详情。 */
adminContentRoutes.get('/share/:id', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeShareID(v));
  if (id === null) return fail(c, Err.shareNotFound());

  const rows = (await sql('SELECT * FROM shares WHERE id = $1 AND deleted_at IS NULL LIMIT 1', [
    id,
  ])) as Record<string, unknown>[];
  if (!rows[0]) return fail(c, Err.shareNotFound());

  const fileId = num(rows[0].file_shares);
  const fileRows = fileId
    ? ((await sql('SELECT * FROM files WHERE id = $1 LIMIT 1', [fileId])) as Record<
        string,
        unknown
      >[])
    : [];

  return ok(c, {
      ...shareToResponse(codec, ctx.settings.siteUrl, rows[0]),
      edges: { file: fileRows[0] ? await fileToResponse(codec, ctx, fileRows[0]) : undefined },
    });
});

/** `POST /admin/share/batch/delete` —— 批量删分享。 */
adminContentRoutes.post('/share/batch/delete', async (c) => {
  const { sql } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No share selected'));
  await forEachId(sql, () => 'UPDATE shares SET deleted_at = now(), updated_at = now() WHERE id = $1', ids);
  return ok(c);
});

// ---------------------------------------------------------------------------
// 任务队列
// ---------------------------------------------------------------------------

/** 任务对外形态，对齐前端 `Task`（`api/dashboard.ts`）。 */
function taskToResponse(
  codec: HashIDCodec,
  t: Record<string, unknown>,
  user?: Record<string, unknown> | null,
) {
  const id = num(t.id);
  const userId = num(t.user_tasks);
  const publicState = (t.public_state ?? {}) as Record<string, unknown>;
  return {
    id,
    created_at: iso(t.created_at),
    updated_at: iso(t.updated_at),
    deleted_at: iso(t.deleted_at),
    type: String(t.type ?? ''),
    status: String(t.status ?? 'queued'),
    public_state: publicState,
    private_state: t.private_state ?? '',
    correlation_id: t.correlation_id ?? null,
    user_tasks: userId,
    user_hash_id: userId ? codec.encodeUserID(userId) : undefined,
    task_hash_id: codec.encodeTaskID(id),
    // 前端 TaskRow 读取的三个字段：summary 来自 public_state.summary，
    // 边缘版没有从属节点（node 恒空，前端有 `task?.node?.name` 守卫），
    // edges.user 供行内用户徽章 / 用户详情跳转使用。
    // summary 绝不能是 null：TaskContent 会做 `{...task.summary}` 展开，
    // 空对象（truthy 但无 props）会让 TaskSummaryTitle 的
    // `summary?.props.download` 在 `.props` 处崩掉（渲染失败 `:(`）。
    // 上游 Go 是值类型 struct，序列化后永远带 props，这里对齐回退空 props。
    summary: (publicState.summary as Record<string, unknown> | undefined) ?? { props: {} },
    node: null,
    edges: user
      ? {
          user: {
            id: num(user.id),
            nick: String(user.nick ?? ''),
            created_at: iso(user.created_at),
          },
        }
      : {},
  };
}

/** 批量取任务归属用户（nick / created_at），供 `edges.user` 联查。 */
async function taskUsersMap(
  sql: Sql,
  rows: Record<string, unknown>[],
): Promise<Map<number, Record<string, unknown>>> {
  const ids = [...new Set(rows.map((t) => num(t.user_tasks)).filter((v) => v > 0))];
  const map = new Map<number, Record<string, unknown>>();
  if (ids.length === 0) return map;
  const users = (await sql`
    SELECT id, nick, created_at FROM users WHERE id = ANY(${ids}::int[])
  `) as Record<string, unknown>[];
  for (const u of users) map.set(num(u.id), u);
  return map;
}

/**
 * `GET /admin/queue/metrics` —— 各队列任务计数。对应上游 `AdminGetQueueMetrics`
 * （`service/admin/task.go:21`），它返回 **数组** `[]QueueMetric`，每个标准队列
 * 一条（media_meta / recycle / io_intense / remote_download / thumb）。
 *
 * 之前这里错误地回了一个扁平对象 `{by_status, busy_workers, ...}`，前端
 * `Queue.tsx` 拿到后直接 `setMetrics(res)` 再 `metrics.map(...)`，于是
 * `metrics.map is not a function` 把整个「离线下载队列」设置页打崩。
 *
 * 边缘版没有常驻 worker（任务在请求内联执行），`busy_workers` 恒为 0；其余计数
 * 从 `tasks` 表按 type+status 分组后归类到 5 个队列。
 */
adminContentRoutes.get('/queue/metrics', async (c) => {
  const { ctx } = withCtx(c);
  const byTypeStatus = await ctx.tasks.countByTypeStatus();

  // 任务类型 → 队列的归属，对齐上游 5 个标准队列。
  const QUEUE_TYPES: Record<string, string[]> = {
    media_meta: ['media_meta'],
    recycle: ['entity_recycle_routine', 'explicit_entity_recycle'],
    io_intense: [
      'create_archive',
      'extract_archive',
      'import',
      'upload_sentinel_check',
      'full_text_index',
      'full_text_copy',
      'full_text_change_owner',
      'full_text_delete',
      'full_text_rebuild',
    ],
    remote_download: ['remote_download'],
    thumb: ['thumb'],
  };

  const agg: Record<string, { submitted: number; success: number; failure: number; suspending: number }> = {
    media_meta: { submitted: 0, success: 0, failure: 0, suspending: 0 },
    recycle: { submitted: 0, success: 0, failure: 0, suspending: 0 },
    io_intense: { submitted: 0, success: 0, failure: 0, suspending: 0 },
    remote_download: { submitted: 0, success: 0, failure: 0, suspending: 0 },
    thumb: { submitted: 0, success: 0, failure: 0, suspending: 0 },
  };

  for (const row of byTypeStatus) {
    const queue = Object.keys(QUEUE_TYPES).find((q) => QUEUE_TYPES[q].includes(row.type));
    if (!queue) continue;
    agg[queue].submitted += row.total;
    if (row.status === 'completed') agg[queue].success += row.total;
    else if (row.status === 'error') agg[queue].failure += row.total;
    else if (row.status === 'suspending') agg[queue].suspending += row.total;
  }

  const metrics = Object.keys(QUEUE_TYPES).map((name) => ({
    name,
    busy_workers: 0,
    success_tasks: agg[name].success,
    failure_tasks: agg[name].failure,
    submitted_tasks: agg[name].submitted,
    suspending_tasks: agg[name].suspending,
  }));

  return ok(c, metrics);
});

/**
 * `POST /admin/queue` —— 任务列表。
 * 条件键 `task_type` / `task_status` / `task_user_id` / `task_correlation_id`。
 */
adminContentRoutes.post('/queue', async (c) => {
  const { sql, codec } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const type = condStr(conditions, 'task_type');
  const status = condStr(conditions, 'task_status');
  const userId = condNum(conditions, 'task_user_id');
  const correlationId = condStr(conditions, 'task_correlation_id');
  const orderCol = orderColumn(body.order_by, ['id', 'created_at', 'updated_at', 'status']);
  const orderDir = orderDirection(body.order_direction);

  const where = `deleted_at IS NULL
      AND ($1::text = '' OR type = $1)
      AND ($2::text = '' OR status = $2)
      AND ($3::int IS NULL OR user_tasks = $3)
      AND ($4::text = '' OR correlation_id = $4::uuid)`;
  const params = [type, status, userId, correlationId];

  const rows = (await sql(
    `SELECT * FROM tasks WHERE ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $5 OFFSET $6`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM tasks WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];

  const userMap = await taskUsersMap(sql, rows);

  return ok(c, {
      tasks: rows.map((t) => taskToResponse(codec, t, userMap.get(num(t.user_tasks)))),
      pagination: paginationOf(page, pageSize, num(countRows[0]?.total)),
    });
});

/** `GET /admin/queue/:id` —— 任务详情。 */
adminContentRoutes.get('/queue/:id', async (c) => {
  const { sql, codec, ctx } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeTaskID(v));
  if (id === null) return fail(c, Err.notFound('Task not found'));
  const task = await ctx.tasks.byId(id);
  if (!task) return fail(c, Err.notFound('Task not found'));
  const t = task as unknown as Record<string, unknown>;
  const userMap = await taskUsersMap(sql, [t]);
  return ok(c, taskToResponse(codec, t, userMap.get(num(t.user_tasks))));
});

/** `POST /admin/queue/batch/delete` —— 批量删任务。 */
adminContentRoutes.post('/queue/batch/delete', async (c) => {
  const { ctx } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No task selected'));
  await ctx.tasks.softDeleteMany(ids);
  return ok(c);
});

/**
 * `POST /admin/queue/cleanup` —— 清理历史任务。
 * 对应 `CleanupTaskService`：删掉 `not_after` 之前、且状态/类型命中的任务。
 */
adminContentRoutes.post('/queue/cleanup', async (c) => {
  const { sql } = withCtx(c);
  const body = (await readBody(c)) as {
    not_after?: string;
    types?: string[];
    status?: string[];
  };
  const notAfter = body.not_after ? new Date(body.not_after) : null;
  if (!notAfter || Number.isNaN(notAfter.getTime())) {
    return fail(c, Err.param('Invalid not_after'));
  }
  const statuses = jsonArray(body.status).map(String);
  const types = jsonArray(body.types).map(String);

  await sql(
    `UPDATE tasks SET deleted_at = now(), updated_at = now()
     WHERE deleted_at IS NULL
       AND created_at < $1::timestamptz
       AND ($2::text[] IS NULL OR status = ANY($2::text[]))
       AND ($3::text[] IS NULL OR type = ANY($3::text[]))`,
    [notAfter.toISOString(), statuses.length ? statuses : null, types.length ? types : null],
  );
  return ok(c);
});

// ---------------------------------------------------------------------------
// 节点
// ---------------------------------------------------------------------------

/**
 * 节点。对应上游 `service/admin/node.go`。
 *
 * 边缘版是单体 Worker：节点**可以正常建、改、删、测**（与真实上游从节点
 * /aria2 的连通性测试是真 HTTP 请求 + 同款 HMAC 签名，能测通就能配对），
 * 但打包 / 远程下载等任务不会分派到节点 —— 任务都在请求内同步跑完，
 * 节点配置仅对未来扩展生效。
 */
function nodeToResponse(n: Record<string, unknown>, boundPolicyIds: number[] = []) {
  return {
    id: num(n.id),
    created_at: iso(n.created_at),
    updated_at: iso(n.updated_at),
    name: String(n.name ?? ''),
    type: String(n.type ?? 'slave'),
    server: (n.server as string) ?? '',
    slave_key: (n.slave_key as string) ?? '',
    status: String(n.status ?? 'active'),
    weight: num(n.weight),
    capabilities: (n.capabilities as string) ?? '',
    settings: (n.settings as Record<string, unknown>) ?? {},
    // 前端只用 id：节点被策略占用时，能力位那几个开关会被禁掉
    // （`CapabilitiesSection.tsx` 判 `edges.storage_policy.length > 0`）
    edges: { storage_policy: boundPolicyIds.map((id) => ({ id })) },
  };
}

/** 节点 id → 绑定到它的策略 id 列表。 */
async function policiesByNode(sql: Sql, nodeId?: number): Promise<Map<number, number[]>> {
  const rows = (await sql(
    nodeId === undefined
      ? 'SELECT id, node_id FROM storage_policies WHERE deleted_at IS NULL AND node_id IS NOT NULL'
      : 'SELECT id, node_id FROM storage_policies WHERE deleted_at IS NULL AND node_id = $1',
    nodeId === undefined ? [] : [nodeId],
  )) as Record<string, unknown>[];
  const map = new Map<number, number[]>();
  for (const row of rows) {
    const key = num(row.node_id);
    const list = map.get(key) ?? [];
    list.push(num(row.id));
    map.set(key, list);
  }
  return map;
}

async function loadNode(sql: Sql, id: number): Promise<Record<string, unknown> | null> {
  const rows = (await sql(
    'SELECT * FROM nodes WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )) as Record<string, unknown>[];
  return rows[0] ?? null;
}

adminContentRoutes.post('/node', async (c) => {
  const { sql } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  // 策略新建向导的节点下拉只想要启用中的节点（`conditions.node_status`）
  const conditions = (body.conditions as Record<string, unknown> | undefined) ?? {};
  const statusFilter = String(conditions.node_status ?? body.status ?? '').trim();
  const where = statusFilter ? 'deleted_at IS NULL AND status = $1' : 'deleted_at IS NULL';
  const params: unknown[] = statusFilter ? [statusFilter] : [];
  const rows = (await sql(
    `SELECT * FROM nodes WHERE ${where} ORDER BY id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM nodes WHERE ${where}`,
    params,
  )) as Record<string, unknown>[];
  const bound = await policiesByNode(sql);
  return ok(c, {
      nodes: rows.map((row) => nodeToResponse(row, bound.get(num(row.id)) ?? [])),
      pagination: paginationOf(page, pageSize, num(countRows[0]?.total)),
    });
});

adminContentRoutes.get('/node/:id', async (c) => {
  const { sql } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => c.get('ctx').codec.decodeEntityID(v));
  if (id === null) return fail(c, Err.notFound('Node not found'));
  const node = await loadNode(sql, id);
  if (!node) return fail(c, Err.notFound('Node not found'));
  const bound = await policiesByNode(sql, id);
  return ok(c, { node: nodeToResponse(node, bound.get(id) ?? []) });
});

/** 创建 / 更新节点的公共逻辑（`UpsertNodeService`）。 */
async function upsertNode(c: Context<AppBindings>, id: number | null, requireExistingId: boolean) {
  const { sql } = withCtx(c);
  const raw = await readBody(c);
  const body = unwrapBody<Record<string, unknown>>(raw, 'node');

  if (requireExistingId && !(num(body.id) > 0)) {
    throw Err.param('ID is required');
  }
  const name = String(body.name ?? '').trim();
  if (!name) throw Err.param('Name is required');
  const type = String(body.type ?? 'slave');
  if (type !== 'master' && type !== 'slave') throw Err.param('Invalid node type');
  const status = String(body.status ?? 'active');
  if (status !== 'active' && status !== 'suspended') throw Err.param('Invalid node status');

  const settings = JSON.stringify((body.settings as Record<string, unknown>) ?? {});

  if (id === null) {
    const rows = (await sql(
      `INSERT INTO nodes (name, type, server, slave_key, status, weight, capabilities, settings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
      [
        name,
        type,
        String(body.server ?? ''),
        String(body.slave_key ?? ''),
        status,
        num(body.weight),
        String(body.capabilities ?? ''),
        settings,
      ],
    )) as Record<string, unknown>[];
    invalidateNodeCache(Number(rows[0]!.id));
    return nodeToResponse(rows[0]!);
  }

  const existing = await loadNode(sql, id);
  if (!existing) throw Err.notFound('Node not found');
  await sql(
    `UPDATE nodes SET name = $2, type = $3, server = $4, slave_key = $5, status = $6,
                        weight = $7, capabilities = $8, settings = $9::jsonb, updated_at = now()
     WHERE id = $1`,
    [
      id,
      name,
      type,
      String(body.server ?? ''),
      String(body.slave_key ?? ''),
      status,
      num(body.weight),
      String(body.capabilities ?? ''),
      settings,
    ],
  );
  const updated = await loadNode(sql, id);
  invalidateNodeCache(id);
  const bound = await policiesByNode(sql, id);
  return nodeToResponse(updated!, bound.get(id) ?? []);
}

adminContentRoutes.put('/node', async (c) => {
  try {
    return ok(c, { node: await upsertNode(c, null, false) });
  } catch (e) {
    return fail(c, e);
  }
});

adminContentRoutes.put('/node/:id', async (c) => {
  try {
    const id = numericId(c.req.param('id'), (v) => c.get('ctx').codec.decodeEntityID(v));
    if (id === null) throw Err.notFound('Node not found');
    return ok(c, { node: await upsertNode(c, id, true) });
  } catch (e) {
    return fail(c, e);
  }
});

adminContentRoutes.delete('/node/:id', async (c) => {
  const { sql } = withCtx(c);
  try {
    const id = numericId(c.req.param('id'), (v) => c.get('ctx').codec.decodeEntityID(v));
    if (id === null) throw Err.notFound('Node not found');
    const node = await loadNode(sql, id);
    if (!node) throw Err.notFound('Node not found');

    // 主节点是系统节点，不可删（上游 CodeInvalidActionOnSystemNode）
    if (String(node.type) === 'master') {
      throw new AppError(CodeInvalidActionOnSystemNode, 'Cannot delete master node');
    }

    // 被存储策略引用时拒绝，消息里带上策略名（上游同款）
    const policyRows = (await sql(
      'SELECT name FROM storage_policies WHERE node_id = $1 AND deleted_at IS NULL',
      [id],
    )) as Record<string, unknown>[];
    if (policyRows.length > 0) {
      throw new AppError(
        CodeNodeUsedByStoragePolicy,
        `Used by policies: ${policyRows.map((r) => String(r.name)).join(', ')}`,
      );
    }

    await sql('UPDATE nodes SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
    invalidateNodeCache(id);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 连通性测试：向从节点 `POST /api/v4/slave/ping` 发真请求。
 *
 * 签名与上游 master 完全同款（`pkg/auth`）：待签串是
 * `{"Path":..,"Header":"<排序后的 X-Cr-* 头>","Body":..}` 的 JSON，
 * HMAC-SHA256(slave_key) 后附 `:<expires>`，放 `Authorization: Bearer Cr ` 头。
 * 测通意味着这台真实的上游 Cloudreve 从节点可以接入。
 */
adminContentRoutes.post('/node/test', async (c) => {
  const { ctx } = withCtx(c);
  try {
    const raw = await readBody(c);
    const body = unwrapBody<Record<string, unknown>>(raw, 'node');
    const server = String(body.server ?? '').replace(/\/+$/, '');
    const slaveKey = String(body.slave_key ?? '');
    if (!server) throw Err.param('server is required');

    const callback = ctx.settings.siteUrl;
    const payload = JSON.stringify({ callback });
    const expires = Math.floor(Date.now() / 1000) + ctx.settings.getInt('slave_api_timeout', 60);

    // X-Cr-* 头按字母序参与签名（上游 getSignContent）
    const headers: Record<string, string> = {
      'X-Cr-Site-Id': ctx.settings.siteId,
      'X-Cr-Site-Url': callback,
      'X-Cr-Version': BACKEND_VERSION,
    };
    const nodeId = num(body.id);
    if (nodeId > 0) headers['X-Cr-Node-Id'] = String(nodeId);
    const signedHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}=${headers[k]}`)
      .join('&');
    const signString = JSON.stringify({ Path: '/api/v4/slave/ping', Header: signedHeaders, Body: payload });
    const sign = await ctx.signer.sign(signString, expires);

    let res: Response;
    try {
      res = await fetch(`${server}/api/v4/slave/ping`, {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `Bearer Cr ${sign}`,
          'Content-Type': 'application/json;charset=utf-8',
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw Err.param(`Failed to connect to node: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw Err.param(`Failed to connect to node: HTTP ${res.status}`);
    }
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
    if ((json.code ?? 0) !== 0) {
      throw Err.param(`Successfully connected to slave node, but slave returns: ${json.msg ?? 'unknown'}`);
    }
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 下载器测试。
 *
 *   - master / aria2：向 aria2 RPC 发 `aria2.getVersion`（JSON-RPC over HTTP）；
 *   - slave：向上游从节点 `POST /api/v4/slave/download/test` 发同款签名请求。
 *
 * 返回下载器版本字符串（上游同款）。
 */
adminContentRoutes.post('/node/test/downloader', async (c) => {
  const { ctx } = withCtx(c);
  try {
    const raw = await readBody(c);
    const body = unwrapBody<Record<string, unknown>>(raw, 'node');
    const nodeType = String(body.type ?? 'slave');
    const settings = (body.settings as Record<string, unknown>) ?? {};
    const provider = String(settings.provider ?? 'aria2');

    if (nodeType === 'master' || provider === 'aria2') {
      // aria2 JSON-RPC：POST {server}/jsonrpc
      const aria2 = (settings.aria2 ?? {}) as Record<string, unknown>;
      const rpc = String(aria2.url ?? '');
      if (!rpc) throw Err.param('aria2 url is required');
      const params: unknown[] = [];
      const token = String(aria2.token ?? '');
      if (token) params.push(`token:${token}`);
      let res: Response;
      try {
        res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'cr_edge_test', method: 'aria2.getVersion', params }),
          signal: AbortSignal.timeout(10000),
        });
      } catch (err) {
        throw Err.param(`Failed to test downloader: ${(err as Error).message}`);
      }
      const json = (await res.json().catch(() => ({}))) as {
        result?: { version?: string };
        error?: { message?: string };
      };
      if (json.error) {
        throw Err.param(`Failed to test downloader: ${json.error.message ?? 'aria2 error'}`);
      }
      return ok(c, json.result?.version ?? '');
    }

    // slave 下载器：同款 HMAC 签名请求
    const server = String(body.server ?? '').replace(/\/+$/, '');
    const slaveKey = String(body.slave_key ?? '');
    if (!server) throw Err.param('server is required');
    const callback = ctx.settings.siteUrl;
    const payload = JSON.stringify({ node_setting: settings, node_setting_hash: '' });
    const expires = Math.floor(Date.now() / 1000) + ctx.settings.getInt('slave_api_timeout', 60);
    const headers: Record<string, string> = {
      'X-Cr-Site-Id': ctx.settings.siteId,
      'X-Cr-Site-Url': callback,
      'X-Cr-Version': BACKEND_VERSION,
    };
    const nodeId = num(body.id);
    if (nodeId > 0) headers['X-Cr-Node-Id'] = String(nodeId);
    const signedHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}=${headers[k]}`)
      .join('&');
    const signString = JSON.stringify({
      Path: '/api/v4/slave/download/test',
      Header: signedHeaders,
      Body: payload,
    });
    const sign = await ctx.signer.sign(signString, expires);
    let res: Response;
    try {
      res = await fetch(`${server}/api/v4/slave/download/test`, {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `Bearer Cr ${sign}`,
          'Content-Type': 'application/json;charset=utf-8',
        },
        body: payload,
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw Err.param(`Failed to test downloader: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { code?: number; msg?: string; data?: string };
    if ((json.code ?? 0) !== 0) {
      throw Err.param(`Failed to test downloader: ${json.msg ?? 'unknown'}`);
    }
    return ok(c, json.data ?? '');
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// OAuth 应用
// ---------------------------------------------------------------------------

/** 对齐前端 `GetOAuthClientResponse`。 */
function oauthClientToResponse(row: Record<string, unknown>, totalGrants: number) {
  return {
    id: num(row.id),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    deleted_at: iso(row.deleted_at),
    guid: String(row.guid ?? ''),
    secret: String(row.secret ?? ''),
    name: String(row.name ?? ''),
    homepage_url: (row.homepage_url as string) ?? '',
    redirect_uris: jsonArray(row.redirect_uris),
    scopes: jsonArray(row.scopes),
    props: row.props ?? {},
    is_enabled: row.is_enabled !== false,
    is_system: false,
    total_grants: totalGrants,
  };
}

/** `POST /admin/oauthClient` —— OAuth 应用列表。条件键 `is_enabled`。 */
adminContentRoutes.post('/oauthClient', async (c) => {
  const { sql } = withCtx(c);
  const body = await readBody(c);
  const { page, pageSize, offset } = paginationArgs(body);
  const conditions = (body.conditions ?? {}) as Record<string, string>;

  const enabledRaw = condStr(conditions, 'is_enabled');
  const enabled = enabledRaw === '' ? null : condBool(conditions, 'is_enabled');
  const orderCol = orderColumn(body.order_by, ['id', 'name', 'created_at', 'updated_at']);
  const orderDir = orderDirection(body.order_direction);

  const where = `deleted_at IS NULL AND ($1::bool IS NULL OR is_enabled = $1)`;
  const rows = (await sql(
    `SELECT * FROM oauth_clients WHERE ${where} ORDER BY ${orderCol} ${orderDir} LIMIT $2 OFFSET $3`,
    [enabled, pageSize, offset],
  )) as Record<string, unknown>[];
  const countRows = (await sql(
    `SELECT COUNT(*)::int AS total FROM oauth_clients WHERE ${where}`,
    [enabled],
  )) as Record<string, unknown>[];

  const out = [];
  for (const r of rows) {
    const grantRows = (await sql(
      'SELECT COUNT(*)::int AS total FROM oauth_grants WHERE client_id = $1 AND deleted_at IS NULL',
      [num(r.id)],
    )) as Record<string, unknown>[];
    out.push(oauthClientToResponse(r, num(grantRows[0]?.total)));
  }

  return ok(c, { clients: out, pagination: paginationOf(page, pageSize, num(countRows[0]?.total)) });
});

/** `GET /admin/oauthClient/:id` —— OAuth 应用详情。 */
adminContentRoutes.get('/oauthClient/:id', async (c) => {
  const { sql, codec } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeEntityID(v));
  if (id === null) return fail(c, Err.notFound('OAuth client not found'));

  const rows = (await sql(
    'SELECT * FROM oauth_clients WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )) as Record<string, unknown>[];
  if (!rows[0]) return fail(c, Err.notFound('OAuth client not found'));

  const grantRows = (await sql(
    'SELECT COUNT(*)::int AS total FROM oauth_grants WHERE client_id = $1 AND deleted_at IS NULL',
    [id],
  )) as Record<string, unknown>[];
  return ok(c, oauthClientToResponse(rows[0], num(grantRows[0]?.total)));
});

/**
 * `PUT /admin/oauthClient` 与 `PUT /admin/oauthClient/:id` —— 创建 / 更新。
 * 请求体 `{ client: {...} }`；`guid` 是客户端 ID，不传自动生成。
 */
async function upsertOAuthClient(c: Context<AppBindings>, id: number | null) {
  const { sql } = withCtx(c);
  const raw = await readBody(c);
  const body = unwrapBody<Record<string, unknown>>(raw, 'client');

  const name = String(body.name ?? '').trim();
  if (!name) throw Err.param('Name is required');
  const redirectUris = jsonArray(body.redirect_uris).map(String);
  // 登记白名单时就把危险 scheme 挡掉（javascript:/data:/明文 http 等）。
  // 授权时虽然只做精确匹配，但白名单本身可以是任意字符串 —— 这里不校验，
  // 管理面板一旦被 XSS 就能登记一个恶意回调。
  for (const uri of redirectUris) assertSafeRedirectUri(uri);
  const scopes = jsonArray(body.scopes).map(String);
  const props = (body.props as Record<string, unknown>) ?? {};
  const isEnabled = body.is_enabled !== false;

  if (id === null) {
    const guid = String(body.guid ?? '') || randomString(32);
    const secret = String(body.secret ?? '') || randomString(48);
    const rows = (await sql(
      `INSERT INTO oauth_clients (guid, secret, name, homepage_url, redirect_uris, scopes, props, is_enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8) RETURNING *`,
      [
        guid,
        secret,
        name,
        String(body.homepage_url ?? ''),
        JSON.stringify(redirectUris),
        JSON.stringify(scopes),
        JSON.stringify(props),
        isEnabled,
      ],
    )) as Record<string, unknown>[];
    return oauthClientToResponse(rows[0]!, 0);
  }

  const existing = (await sql(
    'SELECT * FROM oauth_clients WHERE id = $1 AND deleted_at IS NULL LIMIT 1',
    [id],
  )) as Record<string, unknown>[];
  if (!existing[0]) throw Err.notFound('OAuth client not found');

  // secret 留空表示不改动（前端表单不会回填已存的 secret）
  const secret = String(body.secret ?? '') || String(existing[0].secret ?? '');
  await sql(
    `UPDATE oauth_clients SET
       guid = $2, secret = $3, name = $4, homepage_url = $5,
       redirect_uris = $6::jsonb, scopes = $7::jsonb, props = $8::jsonb,
       is_enabled = $9, updated_at = now()
     WHERE id = $1`,
    [
      id,
      String(body.guid ?? '') || String(existing[0].guid ?? ''),
      secret,
      name,
      String(body.homepage_url ?? ''),
      JSON.stringify(redirectUris),
      JSON.stringify(scopes),
      JSON.stringify(props),
      isEnabled,
    ],
  );
  const rows = (await sql('SELECT * FROM oauth_clients WHERE id = $1 LIMIT 1', [id])) as Record<
    string,
    unknown
  >[];
  return oauthClientToResponse(rows[0]!, 0);
}

adminContentRoutes.put('/oauthClient', async (c) => {
  try {
    return ok(c, await upsertOAuthClient(c, null));
  } catch (e) {
    return fail(c, e);
  }
});

adminContentRoutes.put('/oauthClient/:id', async (c) => {
  const { codec } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeEntityID(v));
  if (id === null) return fail(c, Err.notFound('OAuth client not found'));
  try {
    return ok(c, await upsertOAuthClient(c, id));
  } catch (e) {
    return fail(c, e);
  }
});

/** `DELETE /admin/oauthClient/:id` —— 删单个应用（连带撤销授权）。 */
adminContentRoutes.delete('/oauthClient/:id', async (c) => {
  const { sql, codec } = withCtx(c);
  const id = numericId(c.req.param('id'), (v) => codec.decodeEntityID(v));
  if (id === null) return fail(c, Err.notFound('OAuth client not found'));
  await sql('UPDATE oauth_grants SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL', [id]);
  await sql('UPDATE oauth_clients SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
  return ok(c);
});

/** `POST /admin/oauthClient/batch/delete` —— 批量删应用。 */
adminContentRoutes.post('/oauthClient/batch/delete', async (c) => {
  const { sql } = withCtx(c);
  const body = await readBody(c);
  const ids = idList(body.ids);
  if (ids.length === 0) return fail(c, Err.param('No client selected'));
  await forEachId(
    sql,
    () => 'UPDATE oauth_grants SET deleted_at = now() WHERE client_id = $1 AND deleted_at IS NULL',
    ids,
  );
  await forEachId(
    sql,
    () => 'UPDATE oauth_clients SET deleted_at = now(), updated_at = now() WHERE id = $1',
    ids,
  );
  return ok(c);
});
