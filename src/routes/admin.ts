/**
 * 管理后台路由。对应 Cloudreve v4 `routers/router.go` 的 admin 分组
 * （`router.go:872-1238`）。
 *
 * 本文件负责：概览、设置、用户组、存储策略（含 OneDrive OAuth）、测试发信。
 * 内容类端点（用户 / 文件 / 实体 / 分享 / 任务 / 节点 / OAuth 应用）在
 * `admin-content.ts`，通过 `adminRoutes.route('/', adminContentRoutes)` 挂进来，
 * 共用下面这条管理员中间件。
 *
 * 已实现：
 *   GET    /api/v4/admin/summary                    概览统计
 *   POST   /api/v4/admin/settings                   读取设置
 *   PATCH  /api/v4/admin/settings                   修改设置
 *   POST   /api/v4/admin/group                      用户组列表
 *   GET    /api/v4/admin/group/:id                  单个用户组
 *   PUT    /api/v4/admin/group                      新建用户组
 *   PUT    /api/v4/admin/group/:id                  更新用户组
 *   DELETE /api/v4/admin/group/:id                  删除用户组
 *   POST   /api/v4/admin/policy                     存储策略列表
 *   GET    /api/v4/admin/policy/:id                 存储策略详情
 *   PUT    /api/v4/admin/policy                     新建策略
 *   PUT    /api/v4/admin/policy/:id                 更新策略
 *   DELETE /api/v4/admin/policy/:id                 删除策略
 *   POST   /api/v4/admin/policy/cors                一键建 CORS
 *   POST   /api/v4/admin/policy/oauth/signin        OneDrive 授权链接
 *   GET    /api/v4/admin/policy/oauth/redirect      OAuth 回调地址
 *   GET    /api/v4/admin/policy/oauth/status/:id    授权凭证状态
 *   POST   /api/v4/admin/policy/oauth/callback      处理 OAuth 回调
 *   GET    /api/v4/admin/policy/oauth/root/:id      SharePoint 站点根
 *   POST   /api/v4/admin/tool/mail                  测试发信
 *   DELETE /api/v4/admin/tool/entityUrlCache        清理直链缓存（边缘版无缓存，空操作）
 *
 * 仍未实现（返回「未启用」40019）：缩略图生成器测试（Worker 无法执行本机
 * 可执行文件）；WOPI 探测已实现（/tool/wopi）。
 * 集群节点相关操作同样返回 40019 —— 边缘版是单体 Worker，没有节点可管。
 *
 * 付费/订单/兑换码相关的一切在原版社区版里就不存在，边缘版同样没有。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { permissionsOf } from '../services/context';
import { fail, ok } from '../lib/response';
import { kvFor } from '../lib/kvRouter';
import { UserService } from '../services/user';
import { MailService } from '../services/mail';
import { ShareService } from '../services/share';
import { FileSystemService } from '../services/fs';
import { type ShareReportStatus } from '../db/shareReport';
import { BooleanSet, GroupPermission, PolicyType } from '../lib/boolset';
import {
  AppError,
  CodeFeatureNotEnabled,
  CodeInternalSetting,
  describeError,
  Err,
} from '../lib/errors';
import { invalidateSettings } from '../settings/provider';
import { AuditRepo } from '../db/audit';
import { SUPPORTED_POLICY_TYPES, getStorageDriver, isNodeBoundPolicyType, isPolicyTypeSupported, isSelectablePolicyType } from '../storage';
import { loadNodeById } from '../db/nodes';
import { validateLoadBalanceSettings } from '../storage/loadBalance';
import { BACKEND_VERSION } from './site';
import { adminContentRoutes } from './admin-content';
import { numericId, paginationArgs, paginationOf, unwrapBody } from './shared';
import { toByteaLiteral, type Sql } from '../db';
import type { HashIDCodec } from '../lib/hashid';
import type { GroupRow, StoragePolicyRow } from '../db/types';

export const adminRoutes = new Hono<AppBindings>();

/**
 * 只读的 POST 端点。管理后台的列表查询沿用原版写法：条件多、用 POST 传，不是写操作，
 * 不该要求 Admin.Write。新建/修改走 PUT / PATCH。
 */
const READ_ONLY_POSTS = new Set([
  '/audit/log',
  '/settings',
  '/group',
  '/policy',
  '/user',
  '/file',
  '/entity',
  '/share',
  '/queue',
  '/node',
  '/oauthClient',
]);

/**
 * 所有管理端点统一先做管理员校验，再按方法做 OAuth scope 校验。
 *
 * 对应上游 `routers/router.go` 里管理分组上的 `RequiredScopes(ScopeAdminRead)`
 * 与逐个写路由上的 `ScopeAdminWrite`。少了 scope 这一层，一个只申请了
 * `Files.Read` 的 OAuth 客户端只要绑定在管理员账号上，就能改站点设置、建用户、
 * 删存储策略 —— 这正是上游 4.15~4.19 连续几个安全提交在修的问题。
 * 内置登录签发的 token 没有 scopes，不受限制。
 */
adminRoutes.use('*', async (c, next) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  if (!ctx.isAdmin) return fail(c, Err.adminRequired());
  if (!ctx.hasScopes(['Admin.Read'])) return fail(c, Err.scopeInsufficient('Admin.Read'));

  const method = c.req.method.toUpperCase();
  const path = (c.req.path.replace(/^\/api\/v4\/admin/, '') || '/').replace(/\/+$/, '') || '/';
  const isWrite = method !== 'GET' && method !== 'HEAD' && !READ_ONLY_POSTS.has(path);
  if (isWrite && !ctx.hasScopes(['Admin.Write'])) {
    return fail(c, Err.scopeInsufficient('Admin.Write'));
  }
  await next();
});

// 内容类管理端点（用户 / 文件 / 实体 / 分享 / 任务 / 节点 / OAuth 应用）。
// 挂在同一前缀下，上面那条管理员中间件对挂载进来的路由同样生效。
adminRoutes.route('/', adminContentRoutes);

/**
 * 审计日志列表（管理端「事件」页的查看器，边缘版自建）。
 * 请求体 `{ page, page_size, types?, user_id? }`，page 为 1 基；
 * 响应 `{ audit_logs, pagination }`，pagination.page 回 0 基（见 paginationArgs）。
 */
adminRoutes.post('/audit/log', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { page, pageSize, offset } = paginationArgs(body);

  const rawTypes = body.types;
  const types = Array.isArray(rawTypes)
    ? rawTypes.map((t) => Number(t)).filter((t) => Number.isInteger(t) && t >= 0)
    : undefined;
  const rawUid = body.user_id;
  const userId = rawUid === undefined || rawUid === null || rawUid === '' ? undefined : Number(rawUid);

  const { rows, total } = await new AuditRepo(ctx.env).list({
    types,
    userId: Number.isFinite(userId) ? userId : undefined,
    limit: pageSize,
    offset,
  });

  return ok(c, {
    audit_logs: rows.map((r) => ({
      id: r.id,
      created_at: r.created_at,
      user_id: r.user_id,
      type: r.type,
      meta: r.meta ?? {},
    })),
    pagination: paginationOf(page, pageSize, total),
  });
});

/**
 * 分享举报列表（边缘版自建 Pro 功能）。按状态过滤（pending/resolved/ignored）；
 * 不传 status 返回全部。page 为 1 基。
 */
adminRoutes.get('/share/report', async (c) => {
  const ctx = ctxOf(c);
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('page_size') ?? '20') || 20));
  const rawStatus = c.req.query('status');
  const status = rawStatus === 'pending' || rawStatus === 'resolved' || rawStatus === 'ignored'
    ? (rawStatus as ShareReportStatus)
    : undefined;
  const res = await new ShareService(ctx, new FileSystemService(ctx)).listReports(page, pageSize, status);
  return ok(c, res);
});

/**
 * 处理分享举报（边缘版自建 Pro 功能）。body: { status: 'resolved' | 'ignored' }。
 * 其它值一律按忽略处理。
 */
adminRoutes.post('/share/report/:id', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  const status: ShareReportStatus = body.status === 'resolved' ? 'resolved' : 'ignored';
  try {
    await new ShareService(ctx, new FileSystemService(ctx)).resolveReport(
      Number(c.req.param('id')),
      status,
      ctx.user!.id,
    );
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 概览（管理面板首页）。对齐上游 `service/admin/site.go` 的 `SiteGetSummary`：
 * 返回 `HomepageSummary` —— `site_urls` / `version{version,pro,commit}` /
 * `metrics_summary`（近 12 天文件/用户/分享新增 + 总量）。
 *
 * 前端 `Home.tsx` 第 80 行对 `site_urls` 调 `.find`，第 136 行用 `metrics_summary`
 * 画趋势图；缺任何一个都会崩或让「计算」功能失效，所以必须按上游契约返回，
 * 不能像以前那样回一套自定义字段。
 *
 * `?generate=true` 才计算趋势（按钮触发）；否则只回 `site_urls` + `version`，
 * 前端会显示「计算」按钮让用户主动触发，避免每次进首页都打一堆统计查询。
 */
const SUMMARY_RANGE_DAYS = 12;

adminRoutes.get('/summary', async (c) => {
  const ctx = ctxOf(c);
  const generate = c.req.query('generate') === 'true' || c.req.query('generate') === '1';

  const version = { version: BACKEND_VERSION, pro: false, commit: 'edge' };
  // siteURL 设置值是**逗号分隔的 URL 列表**（前端 SiteUrlWarning 用
  // urls.join(",") 提交、上游 siteUrlPreProcessor 按逗号切分），逐段拆开。
  const siteUrls = ctx.settings.siteUrl
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  if (!generate) {
    return ok(c, { site_urls: siteUrls, version } as never);
  }

  let metrics_summary: Record<string, unknown> | null = null;
  try {
    metrics_summary = await computeMetrics(ctx);
  } catch (e) {
    // 统计失败不该让整个概览 500；缺趋势数据前端会显示「计算」按钮重试
    console.error('computeMetrics failed', e);
  }

  return ok(c, { site_urls: siteUrls, version, metrics_summary } as never);
});

/** 近 SUMMARY_RANGE_DAYS 天的每日新增统计。对齐上游 `CountByTimeRange` 语义。 */
async function computeMetrics(ctx: ReturnType<typeof ctxOf>): Promise<Record<string, unknown>> {
  const sql = (await import('../db')).getSql(ctx.env);
  const now = new Date();
  // 以 UTC 零点为边界，避免本地时区导致 SQL 与前端日期序列错位
  const windowStart = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - (SUMMARY_RANGE_DAYS - 1),
  );

  const dates: string[] = [];
  for (let d = 0; d < SUMMARY_RANGE_DAYS; d++) {
    dates.push(new Date(windowStart + d * 86400000).toISOString());
  }

  const [files, users, shares] = await Promise.all([
    dailyCounts(sql, 'files', windowStart),
    dailyCounts(sql, 'users', windowStart),
    dailyCounts(sql, 'shares', windowStart),
  ]);
  const [file_total, user_total, share_total, entities_total] = await Promise.all([
    countAll(sql, 'files'),
    countAll(sql, 'users'),
    countAll(sql, 'shares'),
    countAll(sql, 'entities'),
  ]);

  return {
    dates,
    files,
    users,
    shares,
    file_total,
    user_total,
    share_total,
    entities_total,
    generated_at: new Date().toISOString(),
  };
}

/** 单指标近 12 天逐日新增：用 generate_series 生成日期序列后 LEFT JOIN，一次查询搞定。
 *  `files` 表没有 `deleted_at`（见 migrations/0001_init.sql 注释），所以按表名跳过软删除过滤。 */
async function dailyCounts(sql: Sql, table: string, windowStart: number): Promise<number[]> {
  const startISO = new Date(windowStart).toISOString();
  const softDelete = table !== 'files';
  const rows = (await sql(
    `SELECT d.d AS day, COUNT(t.created_at)::bigint AS c
       FROM generate_series($1::timestamptz, $1::timestamptz + interval '${SUMMARY_RANGE_DAYS - 1} day', interval '1 day') AS d(d)
       LEFT JOIN ${table} t
         ON t.created_at >= d.d AND t.created_at < d.d + interval '1 day'
         ${softDelete ? 'AND t.deleted_at IS NULL' : ''}
       GROUP BY d.d ORDER BY d.d`,
    [startISO],
  )) as { c: unknown }[];
  return rows.map((r) => Number(r.c ?? 0));
}

/** 全量计数（不限时间）。`files` 表无 `deleted_at`，跳过软删除过滤。 */
async function countAll(sql: Sql, table: string): Promise<number> {
  const softDelete = table !== 'files';
  const rows = (await sql(
    `SELECT COUNT(*)::bigint AS c FROM ${table}${softDelete ? ' WHERE deleted_at IS NULL' : ''}`,
    [],
  )) as { c: unknown }[];
  return Number(rows[0]?.c ?? 0);
}

/** 读取设置。对库里不存在的键回落到默认值（官方设置页请求的键集很大，
 *  未写过的键也必须返回初始值，否则表单显示为空，保存后的 diff 也不对）。 */
adminRoutes.post('/settings', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { keys?: string[] };
  const sql = (await import('../db')).getSql(ctx.env);
  const rows = (await sql`
    SELECT name, value FROM settings WHERE deleted_at IS NULL ORDER BY name ASC
  `) as { name: string; value: string | null }[];

  const { DEFAULT_SETTINGS } = await import('../settings/defaults');
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (body.keys?.length && !body.keys.includes(r.name)) continue;
    out[r.name] = r.value ?? '';
  }
  // 库里没有的键补默认值（只补请求的键，避免无谓地暴露全表）
  if (body.keys?.length) {
    for (const k of body.keys) {
      if (!(k in out) && k in DEFAULT_SETTINGS) out[k] = DEFAULT_SETTINGS[k] ?? '';
    }
  }
  return ok(c, out);
});

/** 修改设置。请求体契约对齐上游 `SetSettingService`（service/admin/site.go:207）：
 *  `{ settings: { <key>: <value> } }` —— 值嵌在 `settings` 键下，不是顶层。
 *  之前直接遍历顶层键，前端 SiteUrlWarning 点「设为主要站点」发的
 *  `{settings: {siteURL: ...}}` 会被当成一个名为 "settings" 的设置存进库，
 *  siteURL 本身永远写不进去，确认弹窗因此每次刷新都重现。
 *
 *  返回值对齐上游 `SetSetting`（site.go:334）：**返回保存后的键值对本身**。
 *  官方前端会把响应合并回表单 state（SettingWrapper.submit 的 then 分支），
 *  如果返回别的形状（如 {updated:[...]}）会污染前端 state，表现为保存异常。 */
adminRoutes.patch('/settings', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  // 兼容两种形态：上游标准 `{settings: {...}}` 与历史误用的平铺键值
  const raw = (body && typeof body.settings === 'object' && body.settings !== null ? body.settings : body) as Record<
    string,
    unknown
  >;
  if (!raw || typeof raw !== 'object') {
    return fail(c, Err.param('No settings provided'));
  }

  // 生成类键不允许通过接口改写：secret_key 是 JWT 签名密钥，被改掉会导致
  // 全部会话失效；siteID / hash_id_salt 与存量 hashid/直链绑定。上游对
  // secret_key 的做法是强制随机重写，这里直接忽略前端传入的值。
  const PROTECTED_KEYS = new Set(['secret_key', 'siteID', 'hash_id_salt']);

  const sql = (await import('../db')).getSql(ctx.env);

  // 先读旧值用于归档 —— 归档要的是「被覆盖前是什么」，必须在 UPDATE 之前读。
  const keys = Object.keys(raw).filter((k) => !PROTECTED_KEYS.has(k));
  const oldRows = keys.length
    ? ((await sql`SELECT name, value FROM settings WHERE name = ANY(${keys})`) as {
        name: string;
        value: string | null;
      }[])
    : [];
  const oldValues = new Map(oldRows.map((r) => [r.name, r.value ?? '']));

  const saved: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (PROTECTED_KEYS.has(key)) continue;
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);

    // siteURL 预处理对齐上游 siteUrlPreProcessor：逗号分隔 URL 列表逐个规范化
    if (key === 'siteURL') {
      try {
        const urls = strValue
          .split(',')
          .map((u) => new URL(u.trim()).toString().replace(/\/+$/, ''))
          .filter(Boolean);
        if (urls.length === 0) throw new Error('empty');
        saved[key] = urls.join(',');
      } catch {
        return fail(c, Err.param(`Invalid siteURL value: ${strValue}`));
      }
    } else {
      saved[key] = strValue;
    }

    await sql`
      INSERT INTO settings (name, value) VALUES (${key}, ${saved[key]})
      ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }
  await invalidateSettings(ctx.env);

  // 归档被覆盖的旧值 —— 只记录**真的变了**的键（没变的不产生噪声）。
  // 归档是增强能力：失败不影响保存结果，所以整体 try/catch 且不 await
  // 太久（用 ctx 的 waitUntil 更好，但这些值很小、KV put 很快）。
  try {
    const changed = Object.entries(saved).filter(([k, v]) => oldValues.get(k) !== v);
    if (changed.length) {
      const { archivePut } = await import('../services/archive');
      for (const [key, newValue] of changed) {
        await archivePut(
          ctx.env,
          'settings',
          key,
          { name: key, value: oldValues.get(key) ?? '' },
          { actor: ctx.user?.id, note: `updated to ${String(newValue).slice(0, 120)}` },
        );
      }
    }
  } catch {
    // 归档失败绝不影响设置保存本身
  }

  return ok(c, saved);
});

// ---------------------------------------------------------------------------
// 用户组
// ---------------------------------------------------------------------------

/**
 * 用户组的对外形态。
 *
 * 字段名照抄前端 `GroupEnt`（`api/dashboard.ts:43`）与上游 `ent.Group`：
 *   - `id` 是**数字**（`CommonMixin.id: number`），hashid 另存 `hash_id`；
 *   - 权限位集叫 `permissions`（复数），不是 `permission`；
 *   - 绑定的策略走 `edges.storage_policies`，前端从 `?.id` 取数字，
 *     列表里的 `storage_policy_id` 它也读；
 *   - `total_users` 与 `pagination` 由 ListGroup 一并返回。
 */
function groupToResponse(
  codec: HashIDCodec,
  group: GroupRow,
  extras: { policies?: StoragePolicyRow[]; totalUsers?: number } = {},
) {
  const out: Record<string, unknown> = {
    id: group.id,
    hash_id: codec.encodeGroupID(group.id),
    created_at: group.created_at.toISOString(),
    updated_at: group.updated_at.toISOString(),
    deleted_at: group.deleted_at ? group.deleted_at.toISOString() : null,
    name: group.name,
    max_storage:
      group.max_storage === null || group.max_storage === undefined
        ? 0
        : Number(group.max_storage),
    speed_limit: group.speed_limit ?? 0,
    permissions: permissionsOf(group).toBase64(),
    settings: group.settings ?? {},
    storage_policy_id: group.storage_policy_id ?? 0,
    edges: {
      // 组多策略（edge 自建 Pro 功能）：edges.storage_policies 为数组。
      // 上游开源版这里是单对象 —— 前端已用补丁同步改为数组消费。
      storage_policies: (extras.policies ?? []).map((p) => policyToResponse(codec, p)),
    },
  };
  if (extras.totalUsers !== undefined) out.total_users = extras.totalUsers;
  return out;
}

/** 组响应里附带的策略边：取组绑定的全部策略（多对多）。 */
async function groupExtras(ctx: ReturnType<typeof ctxOf>, group: GroupRow) {
  const ids = await ctx.groups.listPolicyIds(group.id);
  const policies: StoragePolicyRow[] = [];
  for (const id of ids) {
    const p = await ctx.policies.byId(id);
    if (p) policies.push(p);
  }
  return { policies, totalUsers: await ctx.groups.countUsers(group.id) };
}

adminRoutes.post('/group', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    page?: number;
    page_size?: number;
  };
  const groups = await ctx.groups.list();
  const out = [];
  for (const g of groups) {
    out.push(groupToResponse(ctx.codec, g, await groupExtras(ctx, g)));
  }
  return ok(c, {
      groups: out,
      pagination: {
        page: Number(body.page ?? 0) || 0,
        page_size: Number(body.page_size ?? 20) || 20,
        total_items: groups.length,
      },
    });
});

adminRoutes.get('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodeGroupID(v));
  if (id === null) return fail(c, new AppError(40039, 'Group not found'));
  const group = await ctx.groups.byId(id);
  if (!group) return fail(c, new AppError(40039, 'Group not found'));
  return ok(c, groupToResponse(ctx.codec, group, await groupExtras(ctx, group)));
});


/** 从请求体解析权限位集：接受 base64 字符串（前端 Boolset）或权限位号数组。 */
function parsePermission(input: unknown, fallback: BooleanSet): BooleanSet {
  if (Array.isArray(input)) {
    const bs = new BooleanSet();
    for (const bit of input) {
      if (typeof bit === 'number' && bit >= 0 && bit <= 64) bs.set(bit, true);
    }
    return bs;
  }
  if (typeof input === 'string') return BooleanSet.fromBase64(input);
  return fallback;
}

/**
 * 从组请求体里取绑定的策略 ID 集（edge 自建 Pro：组多策略）。
 *
 * 接受 `edges.storage_policies` 为数组（`[{id}, ...]`，id 为数字或 hashid）
 * 或单对象（上游开源版旧形态，兼容）；也兼容顶层 `storage_policy_id`。
 * 返回 `undefined` 表示请求未提供（不改动），`[]` 表示显式清空全部绑定。
 */
function policyIdsFromGroupBody(
  body: Record<string, unknown>,
  codec: HashIDCodec,
): number[] | undefined {
  const decodeOne = (v: unknown): number | null => {
    if (typeof v === 'number') return v > 0 ? v : null;
    if (typeof v === 'string' && v) return numericId(v, (h) => codec.decodePolicyID(h));
    return null;
  };

  const edges = body.edges as { storage_policies?: unknown } | undefined;
  const sp = edges?.storage_policies;
  if (sp !== undefined) {
    const items = Array.isArray(sp) ? sp : [sp];
    const ids = items
      .map((item) =>
        item && typeof item === 'object' ? decodeOne((item as { id?: unknown }).id) : decodeOne(item),
      )
      .filter((n): n is number => n !== null);
    return [...new Set(ids)];
  }

  const raw = body.storage_policy_id;
  if (raw !== undefined) {
    const one = decodeOne(raw);
    return one === null ? [] : [one];
  }
  return undefined;
}

adminRoutes.put('/group', async (c) => {
  const ctx = ctxOf(c);
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = unwrapBody<Record<string, unknown>>(raw, 'group');
  if (!body.name) return fail(c, Err.param('name is required'));

  const perms = parsePermission(body.permissions, new BooleanSet());

  try {
    const group = await ctx.groups.create({
      name: String(body.name),
      maxStorage: body.max_storage !== undefined ? Number(body.max_storage) : null,
      speedLimit: body.speed_limit !== undefined ? Number(body.speed_limit) : null,
      permissions: perms.toBytes(),
      settings: (body.settings as Record<string, unknown>) ?? {},
      storagePolicyId: null,
    });
    const policyIds = policyIdsFromGroupBody(body, ctx.codec);
    if (policyIds !== undefined) {
      await ctx.groups.setPolicyIds(group.id, policyIds);
    }
    const fresh = await ctx.groups.byId(group.id);
    return ok(c, groupToResponse(ctx.codec, fresh ?? group, await groupExtras(ctx, fresh ?? group)));
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.put('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodeGroupID(v));
  if (id === null) return fail(c, new AppError(40039, 'Group not found'));
  const group = await ctx.groups.byId(id);
  if (!group) return fail(c, new AppError(40039, 'Group not found'));

  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = unwrapBody<Record<string, unknown>>(raw, 'group');
  const patch: Parameters<typeof ctx.groups.patch>[1] = {};

  if (body.name !== undefined) patch.name = String(body.name);

  // max_storage = -1 在原版表示「不限量」，这里映射为 NULL
  if (body.max_storage !== undefined) {
    const v = Number(body.max_storage);
    patch.maxStorage = v < 0 ? null : v;
  }
  if (body.speed_limit !== undefined) patch.speedLimit = Number(body.speed_limit);
  if (body.permissions !== undefined) {
    patch.permissions = parsePermission(body.permissions, new BooleanSet()).toBytes();
  }
  if (body.settings !== undefined) patch.settings = body.settings as Record<string, unknown>;
  const policyIds = policyIdsFromGroupBody(body, ctx.codec);

  try {
    await ctx.groups.patch(id, patch);
    if (policyIds !== undefined) {
      await ctx.groups.setPolicyIds(id, policyIds);
    }
    const updated = await ctx.groups.byId(id);
    return ok(c, groupToResponse(ctx.codec, updated!, await groupExtras(ctx, updated!)));
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.delete('/group/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodeGroupID(v));
  if (id === null) return fail(c, new AppError(40039, 'Group not found'));

  // 系统内置组（1=管理员 2=默认用户 3=匿名）禁止删除，与原版一致
  if ([1, 2, 3].includes(id)) {
    return fail(c, new AppError(40040, 'Cannot perform this action on system group'));
  }
  const used = await ctx.groups.countUsers(id);
  if (used > 0) {
    return fail(c, new AppError(40041, 'This group is being used by users'));
  }
  await ctx.groups.softDelete(id);
  return ok(c);
});

// ---------------------------------------------------------------------------
// 用户
// ---------------------------------------------------------------------------

adminRoutes.post('/user', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const pageSize = Math.min(Number(body.page_size ?? 20) || 20, 100);

  try {
    const res = await new UserService(ctx).listUsers({
      page: Number(body.page ?? 0) || 0,
      pageSize,
      orderBy: body.order_by as string | undefined,
      orderDirection: body.order_direction as string | undefined,
      keyword: body.keyword as string | undefined,
      groupId: body.group_id as string | undefined,
      status: body.status as string | undefined,
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.patch('/user/:id', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const service = new UserService(ctx);
    await service.adminUpdateUser(c.req.param('id'), {
      groupId: body.group_id as string | undefined,
      status: body.status as string | undefined,
      nick: body.nick as string | undefined,
      email: body.email as string | undefined,
    });
    if (body.new_password) {
      await service.resetUserPassword(c.req.param('id'), String(body.new_password));
    }
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.delete('/user/:id', async (c) => {
  const ctx = ctxOf(c);
  try {
    await new UserService(ctx).deleteUser(c.req.param('id'));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 生成一条密码重置链接并直接返回。**边缘版新增，上游没有这个端点。**
 *
 * 存在的理由：邮件是外部依赖（Resend / 收件方），一旦发不出去，
 * Workers 上既没有 shell 也没有能翻的本地数据库文件，管理员就彻底没法帮用户
 * 重置密码。返回的链接走的是同一套 KV 令牌（`user_reset_<uid>`），
 * 和邮件里那条完全等价，可以手工转交。
 */
adminRoutes.post('/user/:id/reset-link', async (c) => {
  const ctx = ctxOf(c);
  const uid = ctx.codec.decodeUserID(c.req.param('id'));
  if (uid === null) return fail(c, Err.userNotFound());

  const user = await ctx.users.byId(uid);
  if (!user) return fail(c, Err.userNotFound());

  try {
    // 复用邮箱那条路：同样拒绝被封禁 / 未激活的账号
    const res = await new UserService(ctx).createResetUrl(user.email);
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 存储策略
// ---------------------------------------------------------------------------

/**
 * 存储策略的对外形态。字段照抄上游 `ent.StoragePolicy` + `GetStoragePolicyResponse`：
 *
 *   - `id` 是**数字**（上游 `ID int`，前端 `CommonMixin.id: number`），
 *     路径参数也一样是数字；hashid 另存 `hash_id`（上游不下发，这里补上便于分享）；
 *   - `access_key` / `secret_key` **原样返回**。上游 `GetPolicyByID` 直接吐
 *     ent 实体，没有脱敏，而且前端要靠 `access_key` 判断 OneDrive 是否已授权
 *     （`OdSignInStatus.tsx:25`），靠 `secret_key` 回填 App Secret。
 *     这条端点有管理员门禁，与上游的暴露面一致；
 *   - `edges.groups` 是「哪些用户组绑了这条策略」，前端用它决定是否提示
 *     「没有组绑定此策略」（`StoragePolicyForm.tsx:21`）；
 *   - `countEntity` 查询参数带上时才回 `entities_count` / `entities_size`。
 */
/**
 * 上游前端 PolicyType 枚举的 11 个合法值（api/explorer.ts）。存储策略页用
 * `PolicyPropsMap[policy.type].img` 渲染卡片 —— 库里出现枚举外的 type 会让
 * 整页崩（'r2' 就这么炸过一次，见 provision.ts 的数据迁移）。响应层统一
 * 归一兜底：未知 type 按边缘版唯一的 S3 兼容实现呈现。
 */
const KNOWN_POLICY_TYPES: ReadonlySet<string> = new Set([
  'local',
  'remote',
  'oss',
  'qiniu',
  'onedrive',
  'cos',
  'upyun',
  's3',
  'ks3',
  'obs',
  'load_balance',
]);

function normalizePolicyType(type: string): string {
  return KNOWN_POLICY_TYPES.has(type) ? type : PolicyType.S3;
}

function policyToResponse(
  codec: HashIDCodec,
  policy: StoragePolicyRow,
  extras: {
    entitiesCount?: number;
    entitiesSize?: number;
    groups?: { id: number; name: string }[];
  } = {},
) {
  const out: Record<string, unknown> = {
    id: policy.id,
    hash_id: codec.encodePolicyID(policy.id),
    created_at: policy.created_at.toISOString(),
    updated_at: policy.updated_at.toISOString(),
    deleted_at: policy.deleted_at ? policy.deleted_at.toISOString() : null,
    name: policy.name,
    type: normalizePolicyType(policy.type),
    server: policy.server ?? '',
    bucket_name: policy.bucket_name ?? '',
    is_private: policy.is_private === true,
    access_key: policy.access_key ?? '',
    secret_key: policy.secret_key ?? '',
    max_size: Number(policy.max_size ?? 0),
    dir_name_rule: policy.dir_name_rule ?? '',
    file_name_rule: policy.file_name_rule ?? '',
    settings: policy.settings ?? {},
    node_id: policy.node_id ?? 0,
    // 可选类型（有驱动 + 负载均衡虚拟策略）：否则管理页卡片会被标成
    // 「不支持」，负载均衡行显示异常
    supported: isSelectablePolicyType(normalizePolicyType(policy.type)),
    edges: {
      groups: extras.groups ?? [],
      users: [],
      files: [],
      entities: [],
      node: null,
    },
  };
  if (extras.entitiesCount !== undefined) out.entities_count = extras.entitiesCount;
  if (extras.entitiesSize !== undefined) out.entities_size = extras.entitiesSize;
  return out;
}

/** 绑定了该策略的用户组（上游靠 `LoadStoragePolicyGroup{}` 预加载 `edges.groups`）。 */
async function policyGroups(
  ctx: ReturnType<typeof ctxOf>,
  policyId: number,
): Promise<{ id: number; name: string }[]> {
  const sql = (await import('../db')).getSql(ctx.env);
  const rows = (await sql`
    SELECT id, name FROM groups WHERE storage_policy_id = ${policyId} AND deleted_at IS NULL ORDER BY id ASC
  `) as { id: unknown; name: string }[];
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

/** 策略下的实体总数与总大小，对应上游 `CountEntityByStoragePolicyID`。 */
async function policyEntityStats(
  ctx: ReturnType<typeof ctxOf>,
  policyId: number,
): Promise<{ count: number; size: number }> {
  const sql = (await import('../db')).getSql(ctx.env);
  const rows = (await sql`
    SELECT COUNT(*)::int AS total, COALESCE(SUM(size), 0) AS total_size
    FROM entities WHERE storage_policy_entities = ${policyId} AND deleted_at IS NULL
  `) as Record<string, unknown>[];
  return {
    count: Number(rows[0]?.total ?? 0),
    size: Number(rows[0]?.total_size ?? 0),
  };
}

adminRoutes.post('/policy', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { page?: number; page_size?: number };
  const policies = await ctx.policies.list();
  return ok(c, {
      policies: policies.map((p) => policyToResponse(ctx.codec, p)),
      // 前端 `ListStoragePolicyResponse` 要求 pagination 存在
      pagination: {
        page: Number(body.page ?? 0) || 0,
        page_size: Number(body.page_size ?? 20) || 20,
        total_items: policies.length,
      },
      supported_types: SUPPORTED_POLICY_TYPES,
    });
});

/** 策略详情。对应上游 `SingleStoragePolicyService.Get`（`service/admin/policy.go:229`）。 */
adminRoutes.get('/policy/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));

  const policy = await ctx.policies.byId(id);
  if (!policy) return fail(c, new AppError(40035, 'Policy not found'));

  const extras: Parameters<typeof policyToResponse>[2] = {
    groups: await policyGroups(ctx, id),
  };
  // 只有带上 countEntity 才统计，与上游一致
  if (c.req.query('countEntity') !== undefined) {
    const stats = await policyEntityStats(ctx, id);
    extras.entitiesCount = stats.count;
    extras.entitiesSize = stats.size;
  }

  return ok(c, policyToResponse(ctx.codec, policy, extras));
});

/**
 * 把策略请求体（`{policy: {...}}`，前端一定包一层）映射成仓储层的创建参数。
 * 字段名与上游 `ent.StoragePolicy` 一致。
 */
function policyCreateArgs(body: Record<string, unknown>, type: string) {
  return {
    name: String(body.name),
    type,
    server: (body.server as string) || null,
    bucketName: (body.bucket_name as string) || null,
    isPrivate: body.is_private === undefined ? null : Boolean(body.is_private),
    accessKey: (body.access_key as string) || null,
    secretKey: (body.secret_key as string) || null,
    maxSize: body.max_size !== undefined ? Number(body.max_size) : null,
    dirNameRule: (body.dir_name_rule as string) || null,
    fileNameRule: (body.file_name_rule as string) || null,
    settings: (body.settings as Record<string, unknown>) ?? {},
    nodeId: body.node_id === undefined || body.node_id === null ? null : Number(body.node_id) || null,
  };
}

/**
 * `local` / `remote` 把文件写到从节点的磁盘上，必须绑定一个可用的从节点。
 *
 * 边缘版没有「主站本地磁盘」这种东西，所以 `local` 在云函数里也只能由节点提供
 * （前端的新建向导里 `local` 没有节点选择框，实际请用 `remote` 类型 + 节点，
 * 两者在服务端是同一份驱动）。
 */
async function assertPolicyNode(
  c: Context<AppBindings>,
  type: string,
  rawNodeId: unknown,
): Promise<void> {
  if (!isNodeBoundPolicyType(type)) return;
  const nodeId = Number(rawNodeId ?? 0) || 0;
  if (!nodeId) {
    throw Err.param(
      '这一类型把文件写到从节点磁盘上，必须选一个节点。云函数没有本地磁盘，' +
        '「本地文件系统存储」请用「节点中转」类型并绑定节点。',
    );
  }
  const node = await loadNodeById(c.env, nodeId);
  if (!node) throw Err.param('Node not found');
  if (node.type !== 'slave') throw Err.param('Only slave nodes can hold storage policies');
  if (node.status !== 'active') throw Err.param(`Node "${node.name}" is suspended`);
}

adminRoutes.put('/policy', async (c) => {
  const ctx = ctxOf(c);
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = unwrapBody<Record<string, unknown>>(raw, 'policy');
  if (!body.name || !body.type) {
    return fail(c, Err.param('name and type are required'));
  }
  const type = String(body.type);
  if (!isSelectablePolicyType(type)) {
    return fail(c, new AppError(40006, `Policy type "${type}" is not supported by the edge build`));
  }
  if (type === PolicyType.LoadBalance) {
    await validateLoadBalanceSettings(ctx.policies, body.settings as Record<string, unknown> | undefined);
  }
  try {
    await assertPolicyNode(c, type, body.node_id);
    const policy = await ctx.policies.create(policyCreateArgs(body, type));
    return ok(c, policyToResponse(ctx.codec, policy));
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.put('/policy/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));
  const policy = await ctx.policies.byId(id);
  if (!policy) return fail(c, new AppError(40035, 'Policy not found'));

  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = unwrapBody<Record<string, unknown>>(raw, 'policy');
  if (body.type !== undefined && !isSelectablePolicyType(String(body.type))) {
    return fail(c, new AppError(40006, `Policy type "${body.type}" is not supported`));
  }
  if (
    (String(body.type) === PolicyType.LoadBalance ||
      (body.type === undefined && policy.type === PolicyType.LoadBalance)) &&
    body.settings !== undefined
  ) {
    await validateLoadBalanceSettings(ctx.policies, body.settings as Record<string, unknown>);
  }

  try {
    await assertPolicyNode(
      c,
      String(body.type ?? policy.type),
      body.node_id !== undefined ? body.node_id : policy.node_id,
    );
    await ctx.policies.update(
      id,
      {
        ...(body.name !== undefined ? { name: String(body.name) } : {}),
        ...(body.type !== undefined ? { type: String(body.type) } : {}),
        ...(body.server !== undefined ? { server: (body.server as string) || null } : {}),
        ...(body.bucket_name !== undefined ? { bucket_name: (body.bucket_name as string) || null } : {}),
        ...(body.is_private !== undefined ? { is_private: body.is_private as boolean } : {}),
        ...(body.max_size !== undefined ? { max_size: Number(body.max_size) } : {}),
        ...(body.dir_name_rule !== undefined ? { dir_name_rule: body.dir_name_rule as string } : {}),
        ...(body.file_name_rule !== undefined ? { file_name_rule: body.file_name_rule as string } : {}),
        ...(body.settings !== undefined ? { settings: body.settings } : {}),
        ...(body.node_id !== undefined
          ? { node_id: body.node_id === null ? null : Number(body.node_id) || null }
          : {}),
      },
      {
        // 空值表示「不改动」——前端会把读到的值原样回填，这里防的是空串把密钥冲掉
        ...(body.access_key !== undefined && body.access_key !== null
          ? { accessKey: String(body.access_key) }
          : {}),
        ...(body.secret_key !== undefined && body.secret_key !== null
          ? { secretKey: String(body.secret_key) }
          : {}),
      },
    );
    // 策略改动后，指向该策略的 OneDrive 凭证缓存需要失效（KV + isolate 内存两级）
    await kvFor(ctx.env, 'cred').delete(`cred_od_${id}`);
    const { invalidateOdCredentialCache } = await import('../storage/onedrive');
    invalidateOdCredentialCache(id);

    // 上游 Update 之后紧接着调 Get，这里照做：返回带 edges 的详情
    const updated = await ctx.policies.byId(id);
    return ok(c, policyToResponse(ctx.codec, updated!, { groups: await policyGroups(ctx, id) }));
  } catch (e) {
    return fail(c, e);
  }
});

adminRoutes.delete('/policy/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));

  // 默认策略（id=1）禁止删除，与上游 `SingleStoragePolicyService.Delete` 一致
  if (id === 1) {
    return fail(c, new AppError(40036, 'Cannot delete the default storage policy'));
  }

  const fileCount = await ctx.policies.countFiles(id);
  if (fileCount > 0) {
    return fail(c, new AppError(40037, 'This policy still has files'));
  }
  const groupCount = await ctx.policies.countGroups(id);
  if (groupCount > 0) {
    return fail(c, new AppError(40038, 'This policy is bound to user groups'));
  }
  await ctx.policies.softDelete(id);
  return ok(c);
});

// ---------------------------------------------------------------------------
// 存储策略 · CORS 与 OneDrive OAuth
// ---------------------------------------------------------------------------

/** 回调地址：站点根 + `/admin/policy/oauth`，强制 https。对应上游 `MasterPolicyOAuthCallback`。 */
function oauthCallbackUrlFor(siteUrl: string): string {
  let base: URL;
  try {
    base = new URL(siteUrl);
  } catch {
    base = new URL('https://localhost');
  }
  base.protocol = 'https:';
  return new URL('/admin/policy/oauth', base).toString();
}

/**
 * 一键建 CORS。对应上游 `PostCreateStoragePolicyCors`（router.go:1009）
 * → `service/admin/policy.go:325` `CreateStoragePolicyCorsService.Create`：
 * oss / cos / s3 / ks3 / obs 五种类型各取驱动后调 `driver.CORS()`，
 * 其余类型按上游 `default` 分支返回参数错误。
 *
 * 边缘版这五种类型底层共用 `S3CompatibleDriver`（PutBucketCors 是 S3 标准
 * 子资源，R2 / MinIO / 阿里 / 腾讯 / 华为 / 金山都实现），所以只需一次调用。
 * 内建「R2 Default」策略走 Worker 的 R2 绑定、本身没有桶 CORS 的概念，
 * 与 OneDrive 一样归入不支持的分支。
 *
 * **请求体里的策略对象就是权威来源**（与上游一致）：新建流程中调用发生在
 * 「保存策略」之前，库里的 id 还是 0，凭据只存在于表单。此时用表单里的
 * AK/SK 现取驱动。若请求体里没有凭据（编辑已有策略时前端回填的是掩码），
 * 才回落到按 id 读库，避免拿掩码去签名。
 */
adminRoutes.post('/policy/cors', async (c) => {
  const ctx = ctxOf(c);
  const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const body = unwrapBody<Record<string, unknown>>(raw, 'policy');

  const type = String(body.type ?? '');
  if (!type) return fail(c, Err.param('policy type is required'));
  if (!isPolicyTypeSupported(type)) {
    return fail(c, Err.param(`CORS setup is not available for policy type "${type}"`));
  }

  // 1) 优先用请求体里的完整策略（新建向导场景：还没落库，凭据只在这儿）
  const inlineKey = typeof body.access_key === 'string' ? body.access_key : '';
  const inlineSecret = typeof body.secret_key === 'string' ? body.secret_key : '';
  const hasInlineCreds = inlineKey !== '' && inlineSecret !== '' && !inlineKey.includes('*');

  let policy: StoragePolicyRow | undefined;
  if (hasInlineCreds) {
    policy = {
      ...(body as unknown as StoragePolicyRow),
      id: Number(body.id ?? 0) || 0,
      type,
      settings: (body.settings as Record<string, unknown>) ?? {},
    } as StoragePolicyRow;
  } else {
    // 2) 回落：按 id 读库（编辑已有策略，前端只回填掩码）
    const id = numericId(String(body.id ?? ''), (v) => ctx.codec.decodePolicyID(v));
    if (id === null) return fail(c, Err.param('policy id is required'));
    const stored = await ctx.policies.byId(id);
    if (!stored) return fail(c, new AppError(40035, 'Policy not found'));
    policy = stored;
  }

  try {
    const driver = getStorageDriver(c.env, policy);
    if (typeof driver.setCors !== 'function') {
      return fail(c, Err.param(`CORS setup is not available for policy type "${policy.type}"`));
    }
    await driver.setCors();
    return ok(c);
  } catch (e) {
    return fail(c, new AppError(CodeInternalSetting, `Failed to create CORS: ${describeError(e)}`));
  }
});

/** 获取 OAuth 回调地址。对应 `AdminGetPolicyOAuthCallbackURL`。 */
adminRoutes.get('/policy/oauth/redirect', async (c) => {
  const ctx = ctxOf(c);
  return ok(c, oauthCallbackUrlFor(ctx.settings.siteUrl));
});

/**
 * 取 OneDrive 授权页 URL。对应上游 `GetOauthRedirectService.GetOAuth`。
 *
 * 上游在这里**顺手把表单上的 App ID / Secret 存进库里**，并把 `od_redirect`
 * 刷成当前站点地址（用户可能刚改过域名）。授权页是拿新参数生成的，
 * 所以这一步不能省——否则回调会因为 redirect_uri 对不上被微软拒绝。
 */
adminRoutes.post('/policy/oauth/signin', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    id?: unknown;
    secret?: unknown;
    app_id?: unknown;
  };

  const id = Number(body.id);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(c, Err.param('Invalid policy ID'));
  }

  const policy = await ctx.policies.byId(id);
  if (!policy || policy.type !== 'onedrive') {
    return fail(c, new AppError(40035, 'Policy not found'));
  }

  const redirect = oauthCallbackUrlFor(ctx.settings.siteUrl);
  const settings = { ...(policy.settings ?? {}), od_redirect: redirect };

  try {
    await ctx.policies.update(
      id,
      { settings, bucket_name: String(body.app_id ?? '') },
      { secretKey: String(body.secret ?? '') },
    );
    await kvFor(ctx.env, 'cred').delete(`cred_od_${id}`);
    const { invalidateOdCredentialCache } = await import('../storage/onedrive');
    invalidateOdCredentialCache(id);

    const updated = await ctx.policies.byId(id);
    const { OneDriveDriver } = await import('../storage/onedrive');
    const driver = new OneDriveDriver(ctx.env, updated!);
    // scope 与上游一致
    return ok(c, driver.authorizeUrl(['offline_access', 'files.readwrite.all']));
  } catch (e) {
    return fail(c, e);
  }
});

/** 查看授权凭证是否有效。对应 `GetOauthCredentialStatus`。 */
adminRoutes.get('/policy/oauth/status/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));

  const policy = await ctx.policies.byId(id);
  if (!policy || policy.type !== 'onedrive') {
    return fail(c, new AppError(40035, 'Policy not found'));
  }

  try {
    const { OneDriveDriver } = await import('../storage/onedrive');
    const status = await new OneDriveDriver(ctx.env, policy).credentialStatus();
    return ok(c, status);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 处理微软回调。对应 `FinishOauthCallbackService`。
 *
 * `state` 就是策略 ID（授权 URL 里写进去的）。换到 token 后要把 refresh_token
 * **写回 `policy.access_key`**——上游在 `Credential.Refresh()` 里同样这么干
 * （`onedrive/oauth.go:122 UpdateAccessKey`）。不写回的话 Worker 重启、
 * KV 过期之后就再也刷不出新 token 了。
 */
adminRoutes.post('/policy/oauth/callback', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { code?: unknown; state?: unknown };
  if (!body.code || !body.state) {
    return fail(c, Err.param('code and state are required'));
  }

  const id = Number(body.state);
  if (!Number.isFinite(id) || id <= 0) {
    return fail(c, Err.param('Invalid state'));
  }

  const policy = await ctx.policies.byId(id);
  if (!policy) return fail(c, new AppError(40035, 'Policy not found'));
  if (policy.type !== 'onedrive') {
    return fail(c, Err.param('Invalid policy type'));
  }

  try {
    const { OneDriveDriver } = await import('../storage/onedrive');
    const credential = await new OneDriveDriver(ctx.env, policy).exchangeCode(String(body.code));
    await ctx.policies.update(id, {}, { accessKey: credential.refresh_token });
    return ok(c);
  } catch (e) {
    return fail(c, Err.param(e instanceof Error ? e.message : String(e)));
  }
});

/**
 * SharePoint 站点 URL → 驱动根（`<siteId>/drive`）。对应 `GetSharePointDriverRoot`。
 * 结果会被前端塞进 `settings.od_driver`。
 */
adminRoutes.get('/policy/oauth/root/:id', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));

  const policy = await ctx.policies.byId(id);
  if (!policy) return fail(c, new AppError(40035, 'Policy not found'));
  if (policy.type !== 'onedrive') {
    return fail(c, Err.param('Invalid policy type'));
  }

  const url = c.req.query('url');
  if (!url) return fail(c, Err.param('url is required'));

  try {
    const { OneDriveDriver } = await import('../storage/onedrive');
    const root = await new OneDriveDriver(ctx.env, policy).getSiteIdByUrl(url);
    return ok(c, root);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 生成 OneDrive 授权链接。**边缘版保留的旧端点，上游没有。**
 * 与 `POST /policy/oauth/signin` 等价，只是不接收 App ID / Secret，
 * 直接用库里已存的凭据。留着是为了不破坏已有的运维脚本。
 */
adminRoutes.get('/policy/:id/oauth', async (c) => {
  const ctx = ctxOf(c);
  const id = numericId(c.req.param('id'), (v) => ctx.codec.decodePolicyID(v));
  if (id === null) return fail(c, new AppError(40035, 'Policy not found'));
  const policy = await ctx.policies.byId(id);
  if (!policy) return fail(c, new AppError(40035, 'Policy not found'));
  if (policy.type !== 'onedrive') {
    return fail(c, Err.param('Policy is not an OneDrive policy'));
  }

  const { OneDriveDriver } = await import('../storage/onedrive');
  const driver = new OneDriveDriver(ctx.env, policy);
  return ok(c, driver.authorizeUrl(['offline_access', 'files.readwrite.all']));
});


/**
 * 测试发信。对应上游 `routers/router.go:939 tool.POST("mail")` →
 * `service/admin/tools.go:137 TestSMTPService.Test`。
 *
 * 请求体：`{ settings: {...}, to: "someone@example.com" }`。
 * `settings` 是**表单里当前的值**（未保存也生效）—— 这是「测试」的全部意义：
 * 验证你刚填的那套参数能不能发出去。所以整份 settings 都要透传给服务层，
 * 而不是只挑几个发件人字段。
 *
 * 端口非法报 40001，其余失败报 50005（都对齐上游）。
 */
adminRoutes.post('/tool/mail', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    settings?: Record<string, string>;
    to?: string;
  };

  if (!body.to) return fail(c, Err.param('Recipient is required'));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.to)) {
    return fail(c, Err.param('Invalid email address'));
  }

  try {
    await new MailService(ctx).sendTestEmail(body.to, body.settings ?? {});
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 实体直链缓存清理。对应上游 `AdminClearEntityUrlCache`。
 *
 * 上游把带签名的直链缓存进 KV，所以这个按钮有意义。边缘版**不缓存直链**
 * （每次现算，见 `services/download.ts`），因此这里确实是无事可做 ——
 * 返回成功是如实回答，不是假装。
 */
// ---------------------------------------------------------------------------
// 工具端点
// ---------------------------------------------------------------------------

/**
 * WOPI discovery 探测。对应上游 `routers/router.go` `tool.GET("wopi")`：
 * 请求 `?endpoint=<WOPI 服务地址>`，服务端取 `{endpoint}/hosting/discovery`，
 * 解析 XML 成 `ViewerGroup`（对齐 `pkg/wopi/discovery.go` 的
 * `DiscoveryXmlToViewerGroup`：`embedview`/`view` → view 动作，`edit` → edit，
 * 无 ext 的 action 跳过，无有效 action 的 app 丢弃）。前端「文件预览」设置页
 * 保存 WOPI 配置前靠它验证服务可用。
 */
adminRoutes.get('/tool/wopi', async (c) => {
  const endpoint = c.req.query('endpoint')?.trim();
  if (!endpoint) return fail(c, Err.param('endpoint is required'));

  let discoveryUrl: URL;
  try {
    discoveryUrl = new URL('hosting/discovery', endpoint);
  } catch {
    return fail(c, Err.param('Invalid WOPI endpoint URL'));
  }

  let res: Response;
  try {
    res = await fetch(discoveryUrl, { signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return fail(c, Err.param(`Failed to reach WOPI discovery: ${(e as Error).message}`));
  }
  if (!res.ok) {
    return fail(c, Err.param(`WOPI discovery endpoint returned HTTP ${res.status}`));
  }
  const xml = await res.text();

  const attr = (tag: string, name: string): string =>
    new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? '';

  const viewers: Record<string, unknown>[] = [];
  const appRe = /<app\b([^>]*?)(?:\/>|>([\s\S]*?)<\/app>)/g;
  let m: RegExpExecArray | null;
  while ((m = appRe.exec(xml)) !== null) {
    const appTag = m[1];
    const inner = m[2] ?? '';
    const actions: Record<string, Record<string, string>> = {};
    const actionRe = /<action\b([^>]*?)\/>/g;
    let a: RegExpExecArray | null;
    while ((a = actionRe.exec(inner)) !== null) {
      const ext = attr(a[1], 'ext');
      if (!ext) continue;
      const name = attr(a[1], 'name');
      const urlsrc = attr(a[1], 'urlsrc');
      if (name === 'embedview' || name === 'view') {
        (actions[ext] ??= {}).view = urlsrc;
      } else if (name === 'edit') {
        (actions[ext] ??= {}).edit = urlsrc;
      }
    }
    const exts = Object.keys(actions);
    if (exts.length === 0) continue;
    viewers.push({
      id: crypto.randomUUID(),
      type: 'wopi',
      display_name: attr(appTag, 'name'),
      exts,
      icon: attr(appTag, 'favIconUrl'),
      wopi_actions: actions,
    });
  }

  return ok(c, { viewers });
});

adminRoutes.delete('/tool/entityUrlCache', async (c) => ok(c));

// ---------------------------------------------------------------------------
// 未实现的工具端点
// ---------------------------------------------------------------------------

const NOT_IMPLEMENTED_ADMIN: Record<string, string> = {
  '/tool/thumbExecutable':
    'Edge 版缩略图由 Cloudflare Image Resizing 实时生成（需 zone 启用 Image Resizing），无本地可执行文件需检测。',
};

for (const [path, message] of Object.entries(NOT_IMPLEMENTED_ADMIN)) {
  adminRoutes.all(path, (c) =>
    fail(c, new AppError(CodeFeatureNotEnabled, message)),
  );
}

export { toByteaLiteral, GroupPermission };
