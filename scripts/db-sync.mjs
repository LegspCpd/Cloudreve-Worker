#!/usr/bin/env node
/**
 * 主库 → 备库全量同步（CI 用）。
 *
 * 这是「每次构建把数据库同步一遍」的落点：在 CI 的构建流程里
 * （`workers-builds` 的 build command）跑 `npm run db:sync`，
 * 部署前把主库整库刷进每一个备库。
 *
 * ## 为什么放在构建期而不是运行期
 *
 *   - 运行期同步要占请求预算（Workers 免费版 50 subrequest/请求），
 *     整库搬运远超这个额度；构建期没有这个限制。
 *   - 构建期是「部署原子点」：新代码 + 新数据一起生效，不会出现
 *     「代码已更新、备库还是旧 schema」的中间态。
 *
 * ## 不会因为同步失败而阻断部署
 *
 * 同步失败只打警告并以 0 退出（除非传 `--strict`）。理由：备库是安全网，
 * 安全网没铺好不该让站点本身的更新停摆。要强制则显式 `--strict`。
 *
 * 用法：
 *   node scripts/db-sync.mjs                 # 同步全部表到全部备库
 *   node scripts/db-sync.mjs --strict        # 失败即非零退出
 *   node scripts/db-sync.mjs --only users,settings
 *   node scripts/db-sync.mjs --skip audit_logs
 *   node scripts/db-sync.mjs --verify-only   # 只做表结构校验，不搬数据
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitStatements } from '../src/lib/sql-split.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 读取 `.dev.vars`（本机）或进程环境（CI）。与 wrangler 的 secret 加载顺序
 * 一致：环境变量优先，其次 .dev.vars。本机调试时把连接串写在 .dev.vars 里
 * 即可，不必 export。
 */
function loadEnvFile() {
  const out = {};
  const p = path.join(ROOT, '.dev.vars');
  if (!existsSync(p)) return out;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i === -1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  }
  return out;
}

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function has(name) {
  return process.argv.includes(name);
}

const fileVars = loadEnvFile();
const envVar = (k) => process.env[k]?.trim() || fileVars[k]?.trim() || '';

const urls = [];
for (const name of ['DATABASE_URL', 'DATABASE_URL_2', 'DATABASE_URL_3', 'DATABASE_URL_4', 'DATABASE_URL_5']) {
  const v = envVar(name);
  if (v && !urls.includes(v)) urls.push(v);
}

if (urls.length < 2) {
  console.log(
    'ℹ 只配置了主库（或没配备库），跳过全量同步。\n' +
      '  要多库容灾：在 CI 环境变量里补 DATABASE_URL_2（更高可选到 _5）。',
  );
  process.exit(0);
}

/** 连接串脱敏，只留 user@host/db 便于在日志里辨认。 */
function describe(url) {
  try {
    const u = new URL(url);
    return `${u.username}@${u.host}${u.pathname}`;
  } catch {
    return '(unparsable)';
  }
}

console.log(`▶ 主库：${describe(urls[0])}`);
console.log(`  备库 ${urls.length - 1} 个：${urls.slice(1).map(describe).join(', ')}`);

// ---------------------------------------------------------------------------
// 建表保障：备库必须先是「已自举」的库，否则表都不存在。
// 这里的做法是明确报错并给出操作指引，而不是偷偷 DDL —— 建表逻辑唯一
// 事实来源是 migrations/*.sql + provision.ts，复制一份到这里必然漂移。
// ---------------------------------------------------------------------------

// 构建期全量同步是 Neon 专用（冷备语义 + Neon HTTP 的 COPY 能力）。非 Neon
// 的 Postgres 用供应商自带的备份/只读副本，别把这套逻辑硬套上去。
{
  const explicit = envVar('DB_PROVIDER').trim().toLowerCase();
  const syncProvider =
    explicit === 'neon' || explicit === 'postgres'
      ? explicit
      : /neon\.tech|neon\.build/i.test(urls[0])
        ? 'neon'
        : 'postgres';
  if (syncProvider !== 'neon') {
    console.log(
      'ℹ 当前不是 Neon 驱动，跳过构建期全量同步。\n' +
        '  冷备/多库同步是 Neon 专用；非 Neon 请用供应商自带的备份或只读副本。',
    );
    process.exit(0);
  }
}

const { neon } = await import('@neondatabase/serverless');

const primary = neon(urls[0]);
const backups = urls.slice(1).map((u) => ({ url: u, sql: neon(u) }));

const SYNC_TABLES = [
  'settings', 'storage_policies', 'groups', 'group_storage_policies', 'nodes',
  'users', 'files', 'entities', 'file_entities', 'metadata', 'shares',
  'share_purchases', 'direct_links', 'tasks', 'dav_accounts', 'passkeys',
  'oauth_clients', 'oauth_grants', 'user_oidc_bindings', 'orders',
  'gift_codes', 'audit_logs', 'archive_entries',
];

const only = argOf('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const skipArgs = argOf('--skip')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const skipEnv = envVar('DB_SYNC_SKIP').split(',').map((s) => s.trim()).filter(Boolean);
const skip = new Set([...skipArgs, ...skipEnv]);

const CHUNK_ROWS = 500;

function ident(n) {
  return `"${n.replace(/"/g, '""')}"`;
}

async function tableExists(sql, t) {
  const r = await sql`SELECT to_regclass(${`public.${t}`}) AS reg`;
  return Boolean(r[0]?.reg);
}

async function columnsOf(sql, t) {
  const r = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${t}
    ORDER BY ordinal_position`;
  return r.map((x) => x.column_name);
}

/**
 * 备库建表（**自动**）。
 *
 * 备库是新开的 Neon 项目，里面什么都没有 —— 表都不存在的话全量同步
 * 无从下手。以前这里只打印一段「请把备库连接串临时配成 DATABASE_URL
 * 部署一次」的操作指引，结果是：**同步默默跳过、构建照常成功、备库
 * 永远是空的**，用户以为自己配了 5 个库，实际只有 1 个在跑。
 *
 * 现在直接把 migrations/*.sql 灌进去。**唯一事实来源仍是那些 .sql 文件**
 * （和 Worker 自举用的是同一批），这里不复制任何 DDL，避免漂移。
 * 语句全部幂等（CREATE TABLE IF NOT EXISTS 等），重复跑无害。
 */
async function ensureSchema(sql, label) {
  const missing = [];
  for (const t of SYNC_TABLES) {
    if (!(await tableExists(sql, t))) missing.push(t);
  }
  if (!missing.length) return true;

  console.log(`  备库缺 ${missing.length} 张表，应用迁移建表…`);
  let applied = 0;
  for (const file of MIGRATION_FILES) {
    const text = readFileSync(path.join(ROOT, 'migrations', file), 'utf8');
    const statements = splitStatements(text);
    try {
      // 一个文件一次事务：与 Worker 自举同策略，避免逐条打爆请求预算。
      await sql.transaction(statements.map((s) => sql(s)));
      applied += statements.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 并发/重复执行时「已存在」是正常的，不算失败。
      if (!/already exists|duplicate/i.test(msg)) {
        console.error(`  ✘ 应用 ${file} 失败：${msg}`);
        return false;
      }
    }
  }
  console.log(`  ✓ 已应用 ${applied} 条建表语句（来源：migrations/*.sql）`);

  const still = [];
  for (const t of SYNC_TABLES) {
    if (!(await tableExists(sql, t))) still.push(t);
  }
  if (still.length) {
    console.error(`  ✘ 建表后仍缺表：${still.join(', ')}`);
    return false;
  }
  return true;
}

/** 迁移文件名清单（按序）。与 src/db/provision.ts 的 MIGRATIONS 对应。 */
const MIGRATION_FILES = [
  '0001_init.sql',
  '0002_admin_content.sql',
  '0003_dav_passkey.sql',
  '0004_node_settings.sql',
  '0005_payment.sql',
  '0006_audit_log.sql',
  '0007_paid_share.sql',
  '0008_oidc.sql',
  '0009_group_storage_policies.sql',
  '0010_archive.sql',
];

// 切分器使用 src/lib/sql-split.mjs（全仓库唯一实现，顶部已导入）。
// 曾经这里有份本地朴素版（split(';')），把 0010 的 $$ 函数体拦腰截断 ——
// 该事故同时炸了 Worker 自举与本脚本的备库建表，所以必须同源。

/** 从驱动返回值里抠出 COPY 的文本输出（字段名跨版本会变，不绑死）。 */
function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const row of v) {
      if (typeof row === 'string') return row;
      if (row && typeof row === 'object') {
        for (const val of Object.values(row)) {
          if (typeof val === 'string' && val.length > 0) return val;
        }
      }
    }
  }
  return null;
}

let failed = false;
/**
 * 「结构性失败」= 备库连不上 / 建不出表 / 缺表。
 *
 * 这与「某张表搬数据时报错」不同：前者意味着**这个备库根本没有被用上**
 * ——用户看到「配了 5 个库」，实际同步一个都没铺成。这种情况必须让 CI
 * 步骤红掉，否则它会永远静默地保持空库状态。
 * （数据搬运的偶发错误仍按原设计只警告，不阻断部署。）
 */
let structuralFailure = false;

for (const [i, b] of backups.entries()) {
  console.log(`\n── 备库 ${i + 1}/${backups.length}：${describe(b.url)}`);

  // 备库是新开的 Neon 项目、通常是空的 —— 先自动把 schema 建起来。
  // 以前这里只打印操作指引，于是同步被跳过、构建照样成功、备库永远空着。
  if (!(await ensureSchema(b.sql, `备库 ${i + 1}`))) {
    failed = true;
    structuralFailure = true;
    continue;
  }

  const missing = [];
  for (const t of SYNC_TABLES) {
    if ((await tableExists(primary, t)) && !(await tableExists(b.sql, t))) missing.push(t);
  }
  if (missing.length) {
    failed = true;
    structuralFailure = true;
    console.error(
      `✘ 备库缺表：${missing.join(', ')}\n` +
        `  主库有这些表但备库建表后仍不存在，说明迁移文件与主库 schema 已漂移。\n` +
        `  检查 migrations/*.sql 是否缺了对应的 CREATE TABLE。`,
    );
    continue;
  }

  if (has('--verify-only')) {
    console.log('  ✓ schema 校验通过（--verify-only，未搬数据）');
    continue;
  }

  for (const t of SYNC_TABLES) {
    if (only?.length && !only.includes(t)) continue;
    if (skip.has(t)) {
      console.log(`  - ${t}：跳过`);
      continue;
    }
    try {
      const cols = await columnsOf(primary, t);
      if (!cols.length) {
        console.log(`  - ${t}：源库无列定义，跳过`);
        continue;
      }
      const colList = cols.map(ident).join(', ');
      await b.sql(`TRUNCATE TABLE ${ident(t)} CASCADE`);

      let offset = 0;
      let total = 0;
      for (;;) {
        const copied = await primary(
          `COPY (SELECT ${colList} FROM ${ident(t)} ORDER BY 1 OFFSET ${offset} LIMIT ${CHUNK_ROWS}) TO STDOUT WITH (FORMAT text)`,
        );
        const text = firstString(copied);
        if (!text) break;
        // COPY TO STDOUT 不含表头（列名在协议层，不在数据流里）。
        // 别 slice(1) —— 那会静默丢掉每张表的第一行。
        const lines = text.split('\n').filter((l) => l.length > 0);
        if (!lines.length) break;
        await b.sql(
          `COPY ${ident(t)} (${colList}) FROM STDIN WITH (FORMAT text)\n${lines.join('\n')}\n\\.\n`,
        );
        total += lines.length;
        if (lines.length < CHUNK_ROWS) break;
        offset += CHUNK_ROWS;
      }
      console.log(`  - ${t}：${total} 行`);
    } catch (err) {
      failed = true;
      console.error(`  ✘ ${t}：${err instanceof Error ? err.message : String(err)}`);
      if (has('--strict')) process.exit(1);
    }
  }
}

if (structuralFailure) {
  console.error(
    '\n✘ 备库未能铺好（结构性问题：连不上 / 建表失败 / 缺表）。\n' +
      '  这不只是「这次同步没成功」——而是这个备库根本没有被用上，\n' +
      '  现在退出非零，让 CI 步骤变红而不是静默通过。',
  );
  process.exit(1);
}

if (failed) {
  console.error('\n⚠ 同步存在错误（构建继续；要中断请用 --strict）。');
} else {
  console.log('\n✅ 全量同步完成。');
}
