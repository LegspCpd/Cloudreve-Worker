#!/usr/bin/env node
/**
 * 初始化基础数据：三个系统用户组、一个默认存储策略、一个管理员账号。
 *
 * 用法：
 *   node scripts/seed.mjs
 *   ADMIN_EMAIL=me@example.com ADMIN_PASSWORD='strong-password' node scripts/seed.mjs
 *
 * 组 ID 与原版约定一致（由 application/migrator/group.go 证实）：
 *   1 = 管理员组（IsAdmin）
 *   2 = 默认用户组（站点设置 default_group = 2）
 *   3 = 匿名组（IsAnonymous，游客访问分享时使用）
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

/** 读取 .dev.vars（本机）→ KEY=VALUE 映射；环境变量优先。 */
function loadDevVars() {
  const out = {};
  const devVars = join(root, '.dev.vars');
  if (!existsSync(devVars)) return out;
  for (const line of readFileSync(devVars, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDatabaseUrl() {
  return process.env.DATABASE_URL || loadDevVars().DATABASE_URL || null;
}

/** 与 Worker 同一套规则：显式 DB_PROVIDER > 连接串域名。 */
function loadProvider(url) {
  const explicit = (process.env.DB_PROVIDER || loadDevVars().DB_PROVIDER || '')
    .trim()
    .toLowerCase();
  if (explicit === 'neon' || explicit === 'postgres') return explicit;
  return /neon\.tech|neon\.build/i.test(url) ? 'neon' : 'postgres';
}

/**
 * 按驱动返回一个「模板标签 + (text, params)」都可用的 sql 函数。
 * seed 只用标签模板与字符串调用，不需要事务，所以这里不做惰性封装。
 */
function makeSql(url, provider) {
  if (provider === 'neon') return neon(url);
  const pg = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
  });
  return (strings, ...values) => {
    if (typeof strings === 'string') {
      const params = Array.isArray(values[0]) ? values[0] : values;
      return pg.unsafe(strings, params);
    }
    let text = '';
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `$${i + 1}`;
    }
    return pg.unsafe(text, values);
  };
}

/**
 * 把权限位号数组编码成 bytea 字面量。
 * 位序与原版 boolset.BooleanSet 一致：第 n 位在字节 n>>3 的第 n&7 位（LSB-first）。
 */
function encodePermissions(bits) {
  const maxBit = bits.length ? Math.max(...bits) : -1;
  const bytes = new Uint8Array(Math.max(1, (maxBit >> 3) + 1));
  for (const bit of bits) {
    bytes[bit >> 3] |= 1 << (bit & 7);
  }
  return `\\x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** 与 Worker 端一致的密码摘要：`<salt>:<sha256hex(password+salt)>` */
function digestPassword(password) {
  const salt = randomBytes(24).toString('hex').slice(0, 32);
  const digest = createHash('sha256').update(password + salt).digest('hex');
  return `${salt}:${digest}`;
}

// 权限位号取自 inventory/types/types.go 的 GroupPermission
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
};

// 容量常量，与 application/constants/size.go 一致
const GB = 1 << 30;
const TB = 1 << 40;

async function main() {
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set (env var or edge/.dev.vars)');
    process.exit(1);
  }

  const provider = loadProvider(databaseUrl);
  const sql = makeSql(databaseUrl, provider);
  console.log(`  驱动：${provider}`);

  // ---- 站点设置：确保 siteID / secret_key / hash_id_salt 有值 -----------------
  // （Worker 首次请求也会做这件事，这里提前做好，便于直接用 CLI 生成 token）
  const existingSettings = await sql`SELECT name FROM settings WHERE deleted_at IS NULL`;
  const haveSettings = new Set(existingSettings.map((r) => r.name));
  const generated = [
    ['siteID', randomUUID()],
    ['secret_key', randomBytes(128).toString('base64url').slice(0, 256)],
    ['hash_id_salt', randomBytes(48).toString('base64url').slice(0, 64)],
  ];
  for (const [name, value] of generated) {
    if (haveSettings.has(name)) continue;
    await sql`INSERT INTO settings (name, value) VALUES (${name}, ${value}) ON CONFLICT (name) DO NOTHING`;
    console.log(`  settings.${name} generated`);
  }

  // ---- 用户组 ---------------------------------------------------------------
  // 三个系统组。名称、权限位、容量、组设置全部照抄
  // `inventory/migration.go` 的 migrateAdminGroup / migrateUserGroup /
  // migrateAnonymousGroup —— 数组下标 0/1/2 对应 group id 1/2/3。
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

  for (const group of groups) {
    const permsLiteral = encodePermissions(group.permissions);
    await sql`
      INSERT INTO groups (id, name, max_storage, speed_limit, permissions, settings, storage_policy_id)
      VALUES (${group.id}, ${group.name}, ${group.maxStorage}, NULL, ${permsLiteral}::bytea,
              ${JSON.stringify(group.settings)}::jsonb, NULL)
      ON CONFLICT (id) DO NOTHING
    `;
    console.log(`  group #${group.id} ${group.name} ready`);
  }

  // 让自增序列跟在手工指定的 id 之后，避免后续插入主键冲突
  await sql`SELECT setval(pg_get_serial_sequence('groups', 'id'), (SELECT MAX(id) FROM groups))`;

  // ---- 默认存储策略 ---------------------------------------------------------
  const policyRows = await sql`SELECT id FROM storage_policies WHERE deleted_at IS NULL ORDER BY id LIMIT 1`;
  let policyId = policyRows[0]?.id;

  if (!policyId) {
    const inserted = await sql`
      INSERT INTO storage_policies
        (name, type, server, bucket_name, is_private, max_size,
         dir_name_rule, file_name_rule, settings)
      VALUES
        ('R2 Default', 's3', '', '', true, 0,
         'uploads/{uid}/{path}', '{uid}_{randomkey8}_{originname}',
         '{"relay": true}'::jsonb)
      RETURNING id
    `;
    policyId = inserted[0].id;
    console.log(`  storage policy #${policyId} (s3, R2 兼容) created`);
  } else {
    console.log(`  storage policy #${policyId} already exists, kept`);
  }

  // 默认用户组绑定到该策略
  await sql`UPDATE groups SET storage_policy_id = ${policyId} WHERE id = 2 AND storage_policy_id IS NULL`;

  // ---- 管理员账号 -----------------------------------------------------------
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || null;

  const existingAdmin = await sql`SELECT id FROM users WHERE lower(email) = lower(${adminEmail}) LIMIT 1`;
  if (existingAdmin.length > 0) {
    console.log(`  admin user ${adminEmail} already exists (id=${existingAdmin[0].id}), kept`);
  } else if (!adminPassword) {
    console.log(
      `  SKIP admin user: ADMIN_PASSWORD is not set.\n` +
        `  Re-run with:  ADMIN_EMAIL=${adminEmail} ADMIN_PASSWORD='<your-password>' node scripts/seed.mjs`,
    );
  } else {
    const digest = digestPassword(adminPassword);
    // 默认设置对齐原版 `inventory/user.go:381`（版本保留：开，最多 10 版）
    const settings = JSON.stringify({ version_retention: true, version_retention_max: 10 });
    const inserted = await sql`
      INSERT INTO users (email, nick, password, group_users, status, storage, settings)
      VALUES (${adminEmail}, 'Admin', ${digest}, 1, 'active', 0, ${settings}::jsonb)
      RETURNING id
    `;
    console.log(`  admin user created: ${adminEmail} (id=${inserted[0].id})`);
  }

  await sql`SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT MAX(id) FROM users))`;

  console.log('\nSeed completed.');
  console.log('提示：用户根目录会在首次登录时自动创建。');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
