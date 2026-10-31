#!/usr/bin/env node
/**
 * 把 migrations/*.sql 按顺序应用到数据库（Neon HTTP 或任意 PostgreSQL）。
 *
 * 用法：
 *   node scripts/migrate.mjs
 *   DATABASE_URL="postgresql://..." node scripts/migrate.mjs
 *
 * 连接串读取顺序：环境变量 DATABASE_URL → 当前目录的 .dev.vars 文件。
 *
 * 实现说明：Neon 的 HTTP 端点一次只接受一条语句，所以这里先把 SQL 文件
 * 拆成独立语句再逐条执行。切分用的是 src/lib/sql-split.mjs 的词法状态机
 * （识别 $$ dollar-quote / 引号 / 注释）—— 旧版朴素 split(';') 曾把 0010
 * 的 PL/pgSQL 函数体拦腰截断（2026-09-21 生产事故），别再改回去。
 * 新增含 dollar-quote 的迁移时无需改这里，跑 test:db-schema 回归即可。
 *
 * 注意：`neon()` 返回的是**可调用对象**，**没有** `.query()` 方法
 * （@neondatabase/serverless 0.10.x 实测 typeof sql.query === 'undefined'）。
 * 直接以字符串调用即可：`await sql('SELECT 1')`。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@neondatabase/serverless';
import postgres from 'postgres';
import { splitStatements } from '../src/lib/sql-split.mjs';

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

/** 按驱动创建 `exec(text)`：两边都是一次执行一条语句。 */
function makeExec(url, provider) {
  if (provider === 'neon') {
    const sql = neon(url);
    return (text) => sql(text);
  }
  const pg = postgres(url, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
  });
  return (text) => pg.unsafe(text, []);
}


async function main() {
  const databaseUrl = loadDatabaseUrl();
  if (!databaseUrl) {
    console.error(
      'ERROR: DATABASE_URL is not set.\n' +
        'Set it in the environment, or create edge/.dev.vars with:\n' +
        '  DATABASE_URL="postgresql://user:pass@ep-xxx.aws.neon.tech/cloudreve?sslmode=require"',
    );
    process.exit(1);
  }

  const provider = loadProvider(databaseUrl);
  const exec = makeExec(databaseUrl, provider);
  console.log(`  驱动：${provider}`);
  const migrationsDir = join(root, 'migrations');
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.error('No .sql files found in migrations/');
    process.exit(1);
  }

  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), 'utf8');
    const statements = splitStatements(content);
    console.log(`\n>>> ${file} (${statements.length} statements)`);

    let index = 0;
    for (const statement of statements) {
      index += 1;
      const preview = statement.replace(/\s+/g, ' ').slice(0, 70);
      try {
        await exec(statement);
        console.log(`    [${index}/${statements.length}] OK  ${preview}`);
      } catch (err) {
        console.error(`    [${index}/${statements.length}] FAIL ${preview}`);
        console.error(`\n${err.message}\n`);
        process.exit(1);
      }
    }
  }

  console.log('\nMigration completed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
