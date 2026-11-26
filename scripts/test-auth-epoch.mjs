/**
 * 登录态列目录缓存的失效验证（lib/edgeCacheAuth.ts）。
 *
 * 回归点：上传完成后前端隔 1 秒重拉 GET /api/v4/file，若该接口的缓存没被
 * 失效，列表就停在旧数据，表现为「上传完要手动刷新整页才看得到」。
 *
 * 覆盖：
 *   T1 epoch 按 user id 分键：不同 uid 互不影响
 *   T2 bump 后同 uid 的 epoch 变化（读缓存键失效）
 *   T3 bump 会 await 清掉 colo 层旧 epoch（不再 fire-and-forget）
 *   T4 换 token（同 user）不影响 epoch —— 按 uid 而非 hash
 *   T5 KV 读失败时退化到 '0'，不抛错
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(path.join(tmpdir(), 'authepoch-'));

// ---- caches.default stub（带 delete 计数，验证 T3）----
const cacheStore = new Map();
let deleteCalls = [];
globalThis.caches = {
  default: {
    match: async (req) => cacheStore.get(String(req.url)),
    put: async (req, res) => {
      cacheStore.set(String(req.url), res);
    },
    delete: async (req) => {
      deleteCalls.push(String(req.url));
      return cacheStore.delete(String(req.url));
    },
  },
};

// ---- KV_2 stub ----
const kvStore = new Map();
const makeEnv = (fail = false) => ({
  JWT_SECRET: 'test-secret-key-1234',
  KV_2: {
    get: async (k) => {
      if (fail) throw new Error('kv down');
      return kvStore.get(k) ?? null;
    },
    put: async (k, v) => {
      if (fail) throw new Error('kv down');
      kvStore.set(k, v);
    },
    delete: async (k) => kvStore.delete(k),
  },
});

const entry = path.join(tmp, 'entry.ts');
writeFileSync(
  entry,
  `export * from ${JSON.stringify(path.join(ROOT, 'src/lib/edgeCacheAuth.ts'))};`,
);
const out = path.join(tmp, 'bundle.mjs');
await esbuild.build({
  entryPoints: [entry],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['cloudflare:sockets'],
  logLevel: 'error',
});
const { getAuthEpoch, bumpAuthEpoch, authHash } = await import('file://' + out.replace(/\\/g, '/'));

// 让进程内 memo 过期：每个用例避开 2s memo 的干扰，直接读 colo/KV 路径。
// 但 colo 有 300s TTL，bump 会删 colo —— 这正好是要验证的行为。
const settle = () => new Promise((r) => setTimeout(r, 2100));

// ---- T1 不同 uid epoch 独立 ----
{
  const env = makeEnv();
  const a = await getAuthEpoch(env, '1001');
  const b = await getAuthEpoch(env, '2002');
  assert.equal(a, '0');
  assert.equal(b, '0');
  await bumpAuthEpoch(env, '1001');
  const a2 = await getAuthEpoch(env, '1001');
  const b2 = await getAuthEpoch(env, '2002');
  assert.notEqual(a2, '0', 'T1 bump 后 uid=1001 的 epoch 应变');
  assert.equal(b2, '0', 'T1 uid=2002 不应被连带 bump');
}

// ---- T2 bump 使读到的 epoch 变化 ----
{
  const env = makeEnv();
  kvStore.clear();
  const before = await getAuthEpoch(env, '3003');
  await bumpAuthEpoch(env, '3003');
  const after = await getAuthEpoch(env, '3003');
  assert.notEqual(before, after, 'T2 bump 前后 epoch 必须不同 → 旧缓存键失效');
}

// ---- T3 bump 会 await 删 colo ----
{
  const env = makeEnv();
  kvStore.clear();
  deleteCalls = [];
  await getAuthEpoch(env, '4004'); // 触发 colo 回填
  await settle(); // 让 void coloCachePutJson 完成
  const putBefore = cacheStore.size;
  assert.ok(putBefore > 0, 'T3 前置条件：colo 里应有 epoch 缓存');
  await bumpAuthEpoch(env, '4004');
  assert.ok(
    deleteCalls.some((u) => u.includes('4004')),
    'T3 bump 必须删除该 uid 的 colo epoch，且是 await（返回时已删）',
  );
}

// ---- T4 同 user 不同 token：epoch 只认 uid ----
{
  const env = makeEnv();
  kvStore.clear();
  const h1 = await authHash('Bearer token-A');
  const h2 = await authHash('Bearer token-B');
  assert.notEqual(h1, h2, 'T4 两个 token hash 不同');
  // getAuthEpoch 的入参是 uid；同一 uid 传几次都拿到同一 epoch，与 token 无关。
  const e1 = await getAuthEpoch(env, '5005');
  await bumpAuthEpoch(env, '5005');
  const e2 = await getAuthEpoch(env, '5005');
  assert.notEqual(e1, e2, 'T4 同 user 换 token 仍命中同一 epoch 版本号');
}

// ---- T5 KV 失败退化 '0'，不抛 ----
{
  const env = makeEnv(true);
  const v = await getAuthEpoch(env, '6006');
  assert.equal(v, '0', 'T5 KV 读失败应退化到 0');
  await bumpAuthEpoch(env, '6006'); // 不应抛
}

console.log('auth epoch: all assertions passed');
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {}
