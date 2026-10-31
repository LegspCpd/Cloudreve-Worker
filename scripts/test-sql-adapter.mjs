/**
 * postgres.js 适配层单测（`src/db/pgSql.ts`）。
 *
 * 不起真库：用一个假客户端记录 `unsafe(text, values)` 与 `begin()` 的调用，
 * 验证三件事：
 *   1. 模板标签 / `(text, params)` 两种调用能生成正确的 `$1..$n` 与参数；
 *   2. 查询是**惰性**的（创建时不能执行，否则事务就没意义）；
 *   3. `transaction([...])` 在同一个 `begin` 里按顺序执行，失败回滚。
 *
 * 跑法：`npm run test:sql-adapter`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'sqladaptertest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

/** 假客户端：记录调用顺序。`begin` 模拟 BEGIN/COMMIT/ROLLBACK。 */
function makeFakeClient() {
  const calls = [];
  let begins = 0;
  const client = {
    unsafe: async (text, values) => {
      calls.push({ kind: 'sql', text, values });
      return [{ ok: calls.length }];
    },
    begin: async (fn) => {
      begins += 1;
      calls.push({ kind: 'tx', text: 'BEGIN' });
      try {
        const out = await fn(client);
        calls.push({ kind: 'tx', text: 'COMMIT' });
        return out;
      } catch (e) {
        calls.push({ kind: 'tx', text: 'ROLLBACK' });
        throw e;
      }
    },
  };
  return { client, calls, begins: () => begins };
}

const sqlOnly = (fake) => fake.calls.filter((c) => c.kind === 'sql');

try {
  const bundlePath = path.join(outDir, 'pgSql.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/db/pgSql.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { buildPgSql } = await import(`file://${bundlePath}`);

  console.log('\n[1] 模板标签生成 $1..$n');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    const rows = await sql`SELECT * FROM users WHERE id = ${1} AND name = ${'alice'}`;
    const call = sqlOnly(fake)[0];
    check('text 占位符正确', call.text === 'SELECT * FROM users WHERE id = $1 AND name = $2', call.text);
    check('values 正确', JSON.stringify(call.values) === '[1,"alice"]', JSON.stringify(call.values));
    check('返回行', Array.isArray(rows) && rows[0].ok === 1);
  }

  console.log('\n[2] (text, params) 形式');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    await sql('SELECT $1::int AS n', [5]);
    const call = sqlOnly(fake)[0];
    check('text 原样保留', call.text === 'SELECT $1::int AS n', call.text);
    check('values 来自第二个参数', JSON.stringify(call.values) === '[5]', JSON.stringify(call.values));
  }

  console.log('\n[3] 无参数调用');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    await sql('SELECT now()');
    check('values 为空数组', sqlOnly(fake)[0].values.length === 0);
  }

  console.log('\n[4] 数组插值作为单个参数');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    await sql`SELECT * FROM t WHERE id = ANY(${[1, 2, 3]})`;
    const call = sqlOnly(fake)[0];
    check('只有一个 $1', call.text === 'SELECT * FROM t WHERE id = ANY($1)', call.text);
    check('参数是数组', Array.isArray(call.values[0]) && call.values[0].length === 3);
  }

  console.log('\n[5] 懒惰执行');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    const pending = sql`SELECT 1`;
    check('创建时不执行', sqlOnly(fake).length === 0);
    await pending;
    check('await 时执行', sqlOnly(fake).length === 1);
  }

  console.log('\n[6] 事务：同一个 begin、按顺序、返回结果');
  {
    const fake = makeFakeClient();
    const sql = buildPgSql(fake.client);
    const out = await sql.transaction([
      sql`INSERT INTO t (a) VALUES (${1})`,
      sql`INSERT INTO t (a) VALUES (${2})`,
    ]);
    const texts = fake.calls.map((c) => c.text);
    check('begin 只调用一次', fake.begins() === 1);
    check(
      '顺序为 BEGIN → SQL → SQL → COMMIT',
      texts[0] === 'BEGIN' &&
        texts[1].startsWith('INSERT') &&
        texts[2].startsWith('INSERT') &&
        texts[3] === 'COMMIT',
      texts.join(' | '),
    );
    check('返回两个结果', Array.isArray(out) && out.length === 2);
  }

  console.log('\n[7] 事务失败回滚');
  {
    const fake = makeFakeClient();
    fake.client.unsafe = async (text, values) => {
      fake.calls.push({ kind: 'sql', text, values });
      if (text.includes('boom')) throw new Error('boom');
      return [];
    };
    const sql = buildPgSql(fake.client);
    let threw = false;
    try {
      await sql.transaction([sql`SELECT 1`, sql`SELECT boom`]);
    } catch {
      threw = true;
    }
    check('异常抛出', threw);
    check('出现 ROLLBACK', fake.calls.some((c) => c.text === 'ROLLBACK'));
    check('没有 COMMIT', !fake.calls.some((c) => c.text === 'COMMIT'));
  }
} catch (e) {
  failed += 1;
  console.error('  ERROR', e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
