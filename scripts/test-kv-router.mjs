/**
 * 多库 / 多 KV 改动的自检脚本（可在无网络、无数据库的环境下跑）。
 *
 * 覆盖两处「出 bug 会静默损坏数据」的地方：
 *   1. `lib/pgCopy.ts` 的 COPY 文本编解码 —— 转义写错 = 数据静默变形；
 *   2. `lib/kvRouter.ts` 的角色路由与前缀 —— 路由错 = 缓存串台、删不掉。
 *
 * 用法：npm run test:kv-router
 */
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. pgCopy 编解码
// ---------------------------------------------------------------------------
const {
  encodeValue,
  encodeRow,
  encodeCopyText,
  decodeRow,
} = await import('../src/lib/pgCopy.ts').catch(async () => {
  // 无 TS 运行时：用 esbuild 现场编译再导入
  const esbuild = await import('esbuild');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'pgcopy-'));
  const out = path.join(dir, 'pgCopy.mjs');
  const src = path.resolve('src/lib/pgCopy.ts');
  await esbuild.build({ entryPoints: [src], outfile: out, format: 'esm', bundle: true, platform: 'node' });
  return import(`file://${out}`);
});

console.log('── pgCopy 编解码 ──');

// NULL
assert.equal(encodeValue(null), '\\N');
assert.equal(encodeValue(undefined), '\\N');

// 反斜杠必须双写
assert.equal(encodeValue('a\\b'), 'a\\\\b');

// 控制字符转成两字符形式
assert.equal(encodeValue('a\nb'), 'a\\nb');
assert.equal(encodeValue('a\tb'), 'a\\tb');
assert.equal(encodeValue('a\rb'), 'a\\rb');

// 中文 / emoji 原样（文本格式是 UTF-8 直传）
assert.equal(encodeValue('中文😀'), '中文😀');

// bytea：双重转义 → 输出 \\x 开头
const bytes = new Uint8Array([0x01, 0x02, 0xff]);
assert.equal(encodeValue(bytes), '\\\\x0102ff', `bytea 编码错误：${encodeValue(bytes)}`);

// 数字 / 布尔
assert.equal(encodeValue(42), '42');
assert.equal(encodeValue(true), 't');
assert.equal(encodeValue(false), 'f');

// jsonb 对象
const obj = { a: 1, b: 'x\ny' };
const encObj = encodeValue(obj);
assert.equal(decodeRow(encObj)[0], JSON.stringify(obj), 'jsonb 往返不一致');

// 单行往返：每个值编码后解码应还原
const cases = [
  'plain',
  'has\ttab',
  'has\nnewline',
  'has\\backslash',
  '中文 and emoji 🎉',
  '',
  '\\N literal backslash N',
];
for (const c of cases) {
  const enc = encodeValue(c);
  const dec = decodeRow(enc);
  assert.equal(dec.length, 1, `单值应解出 1 列，实际 ${dec.length}（输入 ${JSON.stringify(c)}）`);
  assert.equal(dec[0], c, `往返失败：${JSON.stringify(c)} → ${JSON.stringify(enc)} → ${JSON.stringify(dec[0])}`);
}

// NULL 与空串必须区分开
assert.equal(decodeRow('\\N')[0], null, 'NULL 应还原成 null');
assert.equal(decodeRow('')[0], '', '空串应还原成空串而不是 null');

// 多列
const row = encodeRow(['a', null, 1, bytes]);
const cols = decodeRow(row.replace(/\n$/, ''));
assert.equal(cols.length, 4);
assert.equal(cols[0], 'a');
assert.equal(cols[1], null);
assert.equal(cols[2], '1');
// 导入 Postgres 后 bytea 会被解成 `\x0102ff`（decodeRow 把双重转义还原成单层）。
// 这里断言的是「解码器还原出的字面量」，即单反斜杠形式。
assert.equal(cols[3], '\\x0102ff', `bytea 往返：${JSON.stringify(cols[3])}`);

// 整表：首行是表头
const table = encodeCopyText(['id', 'name'], [[1, 'x'],[2, null]]);
const lines = table.split('\n').filter(Boolean);
assert.equal(lines.length, 3, '表头 + 2 行');
assert.equal(lines[0], 'id\tname');
assert.deepEqual(decodeRow(lines[2]), ['2', null]);

console.log('  ✓ 16 项断言通过');

// ---------------------------------------------------------------------------
// 2. KV 角色路由
// ---------------------------------------------------------------------------
console.log('── kvRouter 角色路由 ──');

let esbuild2;
try {
  esbuild2 = await import('esbuild');
} catch {
  esbuild2 = null;
}
let kvRouter;
if (esbuild2) {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'kvrouter-'));
  const out = path.join(dir, 'kvRouter.mjs');
  // 用 stub 替换 env 类型导入（纯类型，bundle 时会被剥掉）
  await esbuild2.build({
    entryPoints: [path.resolve('src/lib/kvRouter.ts')],
    outfile: out, format: 'esm', bundle: true, platform: 'node',
  });
  kvRouter = await import(`file://${out}`);
} else {
  kvRouter = await import('../src/lib/kvRouter.ts');
}

/** 造一个假的 KVNamespace，记录所有调用，以便断言「键有没有带对前缀」。 */
function fakeKv(tag) {
  const log = [];
  const store = new Map();
  const ns = {
    tag,
    log,
    async get(key, opts) {
      log.push(['get', key]);
      const v = store.get(key);
      if (v === undefined) return null;
      return opts === 'json' ? JSON.parse(v) : v;
    },
    async put(key, val, opts) {
      log.push(['put', key, opts]);
      store.set(key, val);
    },
    async delete(key) {
      log.push(['delete', key]);
      store.delete(key);
    },
    async list(opts) {
      log.push(['list', opts]);
      const prefix = opts?.prefix ?? '';
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true, cacheStatus: null };
    },
  };
  ns.__store = store;
  return ns;
}

// 场景 A：只有 KV 一个绑定（老部署）→ 五个角色全部回落到它，但键带各自前缀
{
  const kv = fakeKv('only');
  const env = { KV: kv };
  const bundle = kvRouter.defaultKvBundle(env);
  await bundle.site.put('settings:all:v1', 'x');
  await bundle.session.put('revoke:abc', '1');
  await bundle.flag.put('provision:schema', 'y');
  const keys = [...kv.__store.keys()].sort();
  assert.deepEqual(keys, ['flag:provision:schema', 'session:revoke:abc', 'site:settings:all:v1'],
    `单绑定时应按角色加前缀，实际 ${JSON.stringify(keys)}`);
  // 读要能读回来
  assert.equal(await bundle.site.get('settings:all:v1'), 'x');
  console.log('  ✓ 单绑定降级：三角色共用 KV，键互不覆盖');
}

// 场景 B：KV_1..KV_5 齐全 → 各角色落到独立 namespace
{
  const tags = {};
  const env = {};
  for (let i = 1; i <= 5; i++) {
    const kv = fakeKv(`KV_${i}`);
    tags[`KV_${i}`] = kv;
    env[`KV_${i}`] = kv;
  }
  env.KV = fakeKv('KV');
  const bundle = kvRouter.defaultKvBundle(env);
  await bundle.site.put('k', '1');
  await bundle.session.put('k', '1');
  await bundle.upload.put('k', '1');
  await bundle.cred.put('k', '1');
  await bundle.flag.put('k', '1');

  const expect = { site: 'KV_1', session: 'KV_2', upload: 'KV_3', cred: 'KV_4', flag: 'KV_5' };
  for (const [role, bindName] of Object.entries(expect)) {
    const kv = tags[bindName];
    assert.equal(kv.log.filter((e) => e[0] === 'put').length, 1,
      `角色 ${role} 应该只在 ${bindName} 上写一次，实际落在 ${JSON.stringify(kv.log)}`);
  }
  assert.equal(env.KV.log.length, 0, '有 KV_1..5 时不应回落到裸 KV');
  console.log('  ✓ 五绑定：五个角色各落独立 namespace，裸 KV 未被触碰');
}

// 场景 C：绑定缺失 → 逐角色回落到下一个候选
{
  const env = { KV_1: fakeKv('KV_1'), KV: fakeKv('KV') }; // 只有 KV_1
  const bundle = kvRouter.defaultKvBundle(env);
  await bundle.site.put('k', '1');
  await bundle.session.put('k', '1');
  assert.equal(env.KV_1.log.filter((e) => e[0] === 'put').length, 1, 'site 应落 KV_1');
  assert.equal(env.KV.log.filter((e) => e[0] === 'put').length, 1, 'session 应回落到 KV');
  console.log('  ✓ 部分绑定：缺的角色逐级回落，不抛错');
}

// 场景 D：list 的前缀要叠在调用方前缀之前
{
  const kv = fakeKv('KV_3');
  const env = { KV_3: kv };
  const upload = kvRouter.kvFor(env, 'upload');
  await upload.put('upload_abc', '1');
  await upload.put('other', '2');
  const r = await upload.list({ prefix: 'upload_' });
  const names = r.keys.map((k) => k.name).sort();
  assert.deepEqual(names, ['upload:upload_abc'],
    `list 前缀叠加错误，实际 ${JSON.stringify(names)}`);
  console.log('  ✓ list 前缀正确叠加（角色前缀在前，调用方前缀在后）');
}

// 场景 E：完全没有 KV 绑定 → 落 DB 兜底（EdgeOne Node 云函数等无 KV 环境）
{
  // ① 连 DATABASE_URL 都没有：兜底路径拿不到库，抛明确错误（不是静默 undefined）
  let threw = false;
  try {
    kvRouter.kvFor({}, 'site');
  } catch (e) {
    threw = true;
    assert.match(String(e.message), /DATABASE_URL/);
  }
  assert.ok(threw, '无绑定且无数据库连接串时应抛错而不是静默返回 undefined');
  console.log('  ✓ 无绑定 + 无 DATABASE_URL：抛明确错误');

  // ② 有连接串：返回 DB 兜底 KV（key_values 表，迁移 0018）
  const kv = kvRouter.kvFor({ DATABASE_URL: 'postgresql://u:p@ep-one.aws.neon.tech/db?sslmode=require' }, 'site');
  assert.ok(kv, '有连接串时应返回 DB 兜底 KV 而不是抛错');
  assert.equal(typeof kv.get, 'function', '兜底 KV 应实现 get');
  assert.equal(typeof kv.put, 'function', '兜底 KV 应实现 put');
  console.log('  ✓ 无 KV 绑定 + 有连接串：落到 DB 兜底 KV（EdgeOne 场景）');
}

console.log('\n✅ 全部自检通过');
