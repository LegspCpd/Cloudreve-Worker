/**
 * 数据库自动开通：建表 + 播种系统数据。
 *
 * 目标是**部署后零命令** —— 用户在手机上点完「Deploy to Cloudflare」按钮、
 * 打开站点就能用，不经过任何本机步骤。原来的 `npm run db:migrate` /
 * `npm run db:seed` 只剩开发用途。
 *
 * 机制：
 *   - migrations/*.sql 通过 wrangler 的 Text 规则打进包里，作为唯一事实来源；
 *   - 语句全部幂等（CREATE TABLE IF NOT EXISTS / DROP ... IF EXISTS），
 *     冷启动并发时最多互相报「already exists」，逐条容错忽略；
 *   - 用 KV 标记（键含最后一个迁移的文件名）避免每次冷启动都重放全部 DDL。
 *
 * 播种内容与 scripts/seed.mjs 一致：三个系统用户组（id 1/2/3）、默认 R2
 * 存储策略、默认组绑定策略。**管理员账号不在这里建**（密码无从得知）：
 * 第一个注册的用户自动进管理员组，见 services/user.ts 的 register()。
 */
import m0001 from '../../migrations/0001_init.sql';
import m0002 from '../../migrations/0002_admin_content.sql';
import m0003 from '../../migrations/0003_dav_passkey.sql';
import m0004 from '../../migrations/0004_node_settings.sql';
import m0005 from '../../migrations/0005_payment.sql';
import m0006 from '../../migrations/0006_audit_log.sql';
import m0007 from '../../migrations/0007_paid_share.sql';
import m0008 from '../../migrations/0008_oidc.sql';
import m0009 from '../../migrations/0009_group_storage_policies.sql';
import m0010 from '../../migrations/0010_archive.sql';
import m0011 from '../../migrations/0011_file_viewers.sql';
import m0012 from '../../migrations/0012_file_viewers_backfill.sql';
import m0013 from '../../migrations/0013_site_state.sql';
import m0014 from '../../migrations/0014_rate_limits.sql';
import m0015 from '../../migrations/0015_share_report.sql';
import m0016 from '../../migrations/0016_social_bindings.sql';
import { withRetry } from './index';
import { randomString } from '../lib/crypto';
import { splitStatements } from '../lib/sql-split.mjs';
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import { resolveDb, type DbHandle } from './shard';

const MIGRATIONS: ReadonlyArray<readonly [name: string, sqlText: string]> = [
  ['0001_init.sql', m0001],
  ['0002_admin_content.sql', m0002],
  ['0003_dav_passkey.sql', m0003],
  ['0004_node_settings.sql', m0004],
  ['0005_payment.sql', m0005],
  ['0006_audit_log.sql', m0006],
  ['0007_paid_share.sql', m0007],
  ['0008_oidc.sql', m0008],
  ['0009_group_storage_policies.sql', m0009],
  ['0010_archive.sql', m0010],
  // 0011 是数据迁移（UPDATE settings），放最后：先于 ensureSettings 执行，
  // 存量 '[]' 行回填后 ensureSettings 见行已存在即跳过。
  ['0011_file_viewers.sql', m0011],
  // 0012 放宽 WHERE 的兜底回填（0011 已应用、MARKER 指着它，原地改不会重跑）。
  ['0012_file_viewers_backfill.sql', m0012],
  // 0013：站点级一次性状态（首个管理员名额的原子栅栏）
  ['0013_site_state.sql', m0013],
  // 0014：限速计数表（KV 的读最终一致，做不了计数器）
  ['0014_rate_limits.sql', m0014],
  // 0015：分享举报表（edge 自建 Pro 功能）
  ['0015_share_report.sql', m0015],
  // 0016：社交登录绑定表（edge 自建 Pro 功能：QQ 互联等 OAuth2 第三方登录）
  ['0016_social_bindings.sql', m0016],
];

/** KV 标记：值是最后一个已应用的迁移文件名，文件名不变就跳过。 */
const MARKER_KEY = 'provision:schema';

/** 模块级缓存：每个 isolate 只跑一次完整检查（一次 KV get）。 */
let ran = false;

/**
 * 去注释后按分号切分 —— 实现在 src/lib/sql-split.mjs（全仓库唯一一份）。
 *
 * ⚠️ 这里曾经放过一份「单引号都不跟踪、直接 split(';')」的朴素实现：
 * 0010_archive.sql 的 $$ PL/pgSQL 函数体内含分号，被拦腰截断，
 * Postgres 报 unterminated dollar-quoted string，自举失败、全站 503
 * （2026-09-21 生产事故）。现在共用词法状态机版本，且
 * scripts/test-db-schema-sync.mjs 在真实 PostgreSQL 上用**这同一份**
 * 切分器逐条应用全部迁移做回归。
 */

/** 并发冷启动时两条相同 DDL 相撞是正常现象，不算失败。 */
function isBenignError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /already exists|duplicate/i.test(msg);
}

/**
 * 应用全部迁移（幂等）。
 *
 * **每个文件用一次 `sql.transaction()` 整体提交** —— 关键约束：Workers 免费版
 * 单请求只有 50 个 subrequest，而逐条执行 0001 就要 52 个请求，必然爆掉；
 * Neon 免费版还会对突发请求直接回 429。合并后 4 个文件只有 4 个请求。
 * 事务里语句按序执行，失败整体回滚 —— 全部语句幂等，并发冷启动时第二遍重放
 * 即可收敛。
 */
async function applyMigrations(env: Env, db: DbHandle): Promise<void> {
  const sql = db.sql;
  const done = await kvFor(env, 'flag').get(MARKER_KEY);
  const last = MIGRATIONS[MIGRATIONS.length - 1]![0];
  if (done === last) return;

  for (const [name, sqlText] of MIGRATIONS) {
    const queries = splitStatements(sqlText).map((statement) => sql(statement));
    try {
      await withRetry(() => sql.transaction(queries));
    } catch (err) {
      if (!isBenignError(err)) {
        throw new Error(`migration ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // 不设 TTL：做过的 schema 就算做过了
  await kvFor(env, 'flag').put(MARKER_KEY, last);
}

/**
 * 播种系统数据。字段值逐条对齐 scripts/seed.mjs，而 seed.mjs 对齐的是
 * 上游 `application/migrator` 的 migrateAdminGroup / migrateUserGroup /
 * migrateAnonymousGroup。全部 ON CONFLICT DO NOTHING，重复执行无害。
 */
async function seedSystemData(env: Env, db: DbHandle): Promise<void> {
  const sql = db.sql;

  // 权限位号来自 inventory/types/types.go 的 GroupPermission（LSB-first）
  const PERM = {
    IsAdmin: 0,
    IsAnonymous: 1,
    Share: 2,
    WebDAV: 3,
    ArchiveDownload: 4,
    ArchiveTask: 5,
    WebDAVProxy: 6,
    ShareDownload: 7,
    RemoteDownload: 9,
    RedirectedSource: 11,
    AdvanceDelete: 12,
    IgnoreFileOwnership: 16,
    UniqueRedirectDirectLink: 17,
  } as const;

  const GB = 1024 ** 3;
  const TB = 1024 ** 4;

  const groups = [
    {
      id: 1,
      name: 'Admin',
      maxStorage: 1 * TB,
      permissions: [
        PERM.IsAdmin,
        PERM.Share,
        PERM.WebDAV,
        PERM.WebDAVProxy,
        PERM.ArchiveDownload,
        PERM.ArchiveTask,
        PERM.ShareDownload,
        PERM.RemoteDownload,
        PERM.RedirectedSource,
        PERM.AdvanceDelete,
        PERM.IgnoreFileOwnership,
      ],
      settings: {
        source_batch: 1000,
        aria2_batch: 50,
        max_walked_files: 100000,
        trash_retention: 7 * 24 * 3600,
        redirected_source: true,
      },
    },
    {
      id: 2,
      name: 'User',
      maxStorage: 1 * GB,
      permissions: [PERM.Share, PERM.ShareDownload, PERM.RedirectedSource],
      settings: {
        source_batch: 10,
        aria2_batch: 1,
        max_walked_files: 100000,
        trash_retention: 7 * 24 * 3600,
        redirected_source: true,
      },
    },
    {
      id: 3,
      name: 'Anonymous',
      maxStorage: null,
      permissions: [PERM.IsAnonymous, PERM.ShareDownload],
      settings: {
        max_walked_files: 100000,
        redirected_source: true,
      },
    },
  ];

  // 三个系统组 + 序列校正合并成一个事务（= 1 个 HTTP 请求）
  await withRetry(() =>
    sql.transaction([
      ...groups.map((group) => {
        const maxBit = group.permissions.length ? Math.max(...group.permissions) : -1;
        const bytes = new Uint8Array(Math.max(1, (maxBit >> 3) + 1));
        for (const bit of group.permissions) {
          bytes[bit >> 3] |= 1 << (bit & 7);
        }
        let hex = '';
        for (const b of bytes) hex += b.toString(16).padStart(2, '0');

        return sql`
          INSERT INTO groups (id, name, max_storage, speed_limit, permissions, settings, storage_policy_id)
          VALUES (${group.id}, ${group.name}, ${group.maxStorage}, NULL, ${`\\x${hex}`}::bytea,
                  ${JSON.stringify(group.settings)}::jsonb, NULL)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            max_storage = EXCLUDED.max_storage,
            permissions = EXCLUDED.permissions,
            settings = EXCLUDED.settings
        `;
      }),
      // 让自增序列跟在手工指定的 id 之后，避免后续插入主键冲突
      sql`SELECT setval(pg_get_serial_sequence('groups', 'id'), (SELECT MAX(id) FROM groups))`,
    ]),
  );

  // 默认 R2 存储策略 + 默认组绑定（对齐 seed.mjs）
  const policyRows = (await sql`SELECT id FROM storage_policies WHERE deleted_at IS NULL ORDER BY id LIMIT 1`) as Array<{
    id: number | string;
  }>;
  if (!policyRows[0]) {
    const inserted = (await sql`
      INSERT INTO storage_policies
        (name, type, server, bucket_name, is_private, max_size,
         dir_name_rule, file_name_rule, settings)
      VALUES
        ('R2 Default', 's3', '', '', true, 0,
         'uploads/{uid}/{path}', '{uid}_{randomkey8}_{originname}',
         '{"relay": true}'::jsonb)
      RETURNING id
    `) as Array<{ id: number | string }>;
    const policyId = Number(inserted[0]!.id);
    await sql`UPDATE groups SET storage_policy_id = ${policyId} WHERE id = 2 AND storage_policy_id IS NULL`;
  }

  // 数据修复：早期版本把默认策略 type 播种成了自造值 'r2'，而上游前端
  // PolicyType 枚举没有它，StoragePolicyCard 里 PolicyPropsMap['r2'].img
  // 直接抛 undefined 导致存储策略页崩。R2 兼容 S3 API，统一归一到 's3'。
  // 幂等：无 'r2' 行时为空更新。
  await sql`UPDATE storage_policies SET type = 's3', updated_at = now() WHERE type = 'r2'`;

  // 数据修复：R2 绑定策略（type=s3 且无 AK/SK，由 R2Driver 中转）必须在
  // settings 里带 relay=true，前端上传器才会走 Local 中转流程；缺了它前端
  // 按 S3 直传读 `session.upload_urls[0]` 崩（Cannot read properties of
  // undefined (reading '0')）。给历史行补上该标志。幂等：已为 true 的行不命中。
  await sql`
    UPDATE storage_policies
    SET settings = COALESCE(settings, '{}'::jsonb) || '{"relay": true}'::jsonb,
        updated_at = now()
    WHERE type = 's3'
      AND (access_key IS NULL OR access_key = '')
      AND COALESCE(settings->>'relay', 'false') <> 'true'
  `;

  // 数据修复：组播种原本只给组 2（注册组）绑定存储策略，组 1（站长）/
  // 组 3（游客）恒为 NULL。而上游 getPreferredPolicy（dbfs.go:669 →
  // inventory/policy.go:145 GetByGroup）假定**每个组都绑定了策略** ——
  // 组无策略时列表响应缺 storage_policy，前端上传器点「上传」直接抛
  // No policy selected 且文件选择器不打开。给未绑策略的系统组补绑
  // 第一个可用策略。幂等：无 NULL 行时为空更新。
  await sql`
    UPDATE groups SET storage_policy_id = (
      SELECT id FROM storage_policies WHERE deleted_at IS NULL ORDER BY id LIMIT 1
    ), updated_at = now()
    WHERE id IN (1, 2, 3) AND storage_policy_id IS NULL
  `;

  // 自建 Pro 功能：组 ↔ 存储策略多对多。上游闭源部分才有（前端文案
  // group.availablePolicyDesPro「可多选，用户可在选定范围内自由切换存储
  // 策略」），开源版组只绑单策略。建表 + 把旧的单一绑定迁入关联表。
  // 两条语句都幂等：表 IF NOT EXISTS；INSERT ... ON CONFLICT DO NOTHING
  // 在迁移完成后重放时恒为空插入。
  await sql`
    CREATE TABLE IF NOT EXISTS group_storage_policies (
      group_id INTEGER NOT NULL,
      policy_id INTEGER NOT NULL,
      PRIMARY KEY (group_id, policy_id)
    )
  `;
  await sql`
    INSERT INTO group_storage_policies (group_id, policy_id)
    SELECT id, storage_policy_id FROM groups
    WHERE storage_policy_id IS NOT NULL
    ON CONFLICT (group_id, policy_id) DO NOTHING
  `;

  // 默认 OAuth 客户端。官方版里「Cloudreve Web / Cloudreve Desktop」两个内置
  // 应用由闭源部分播种（开源仓库的 migrator 无此步骤，已核对），边缘版按
  // 前端可用 scope 自建。guid 固定 + ON CONFLICT DO NOTHING 保证幂等；
  // secret 只在首次插入时随机生成，重复播种不会覆盖。
  const defaultClients = [
    {
      guid: 'c54e1b95-4f30-4b57-9e2a-3d9ff1b11c0e',
      name: 'Cloudreve Web',
      scopes: ['openid', 'email', 'profile', 'offline_access'],
    },
    {
      guid: '8a3f9d6c-2b14-4a7e-b6c5-1e0d7f4a92b3',
      name: 'Cloudreve Desktop',
      scopes: [
        'openid',
        'email',
        'profile',
        'offline_access',
        'UserInfo.Read',
        'Files.Read',
        'Files.Write',
        'Shares.Read',
        'DavAccount.Read',
      ],
    },
  ];
  for (const cl of defaultClients) {
    await sql`
      INSERT INTO oauth_clients (guid, secret, name, homepage_url, redirect_uris, scopes, props, is_enabled)
      VALUES (${cl.guid}, ${randomString(48)}, ${cl.name}, 'https://cloudreve.org',
              '[]'::jsonb, ${JSON.stringify(cl.scopes)}::jsonb, '{}'::jsonb, true)
      ON CONFLICT (guid) DO NOTHING
    `;
  }

  // 数据修复：早期 PATCH /admin/settings 没解包 `settings` 键，前端「确认站点
  // URL」弹窗提交的 `{settings: {siteURL: ...}}` 被当成名为 "settings" 的单条
  // 设置存进了库。把这条脏行 JSON 里的键值还原成正经设置，再删掉脏行。
  // 幂等：脏行删除后此查询恒空，不再有副作用。
  const dirty = (await sql`
    SELECT value FROM settings WHERE name = 'settings' AND deleted_at IS NULL LIMIT 1
  `) as Array<{ value: string | null }>;
  if (dirty[0]?.value) {
    try {
      const parsed = JSON.parse(dirty[0].value) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v !== 'string') continue;
          await sql`
            INSERT INTO settings (name, value) VALUES (${k}, ${v})
            ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `;
        }
      }
      await sql`DELETE FROM settings WHERE name = 'settings'`;
    } catch {
      // JSON 解析失败说明不是那次 bug 写入的行，保持不动
    }
  }
}

/** 冷启动入口：建表 + 播种。可安全重复调用（幂等 + KV 标记短路）。 */
export async function provision(env: Env, db: DbHandle = resolveDb(env)): Promise<void> {
  if (ran) return;
  ran = true;
  try {
    await applyMigrations(env, db);
    await seedSystemData(env, db);
  } catch (err) {
    // 失败要复位模块缓存，让下一个请求重试（KV 标记只在成功后写入）
    ran = false;
    throw err;
  }
}
