#!/usr/bin/env node
/**
 * 构建期「清空 KV → 重新填回去」。
 *
 * ## 需求原文
 *
 * 「每一次进行构建的时候，清空所有 kv 数据库，然后再把要缓存的东西重新
 *   填进去；要缓存的东西有很多，尽量全部都缓存进去；每一个小时自动拉取
 *   一次，保证内容是新的就行。」
 *
 * 本脚本负责前半句（构建时清空 + 重填）；后半句（每小时刷新）由 Worker
 * 的 cron 承担，见 `src/index.ts` 的 `scheduled()`。
 *
 * ## 为什么这个过程必须在构建期做，不能放进 Worker
 *
 * KV 的绑定 API **没有批量删**（`delete(key)` 只收一个键名）。在 Worker 里
 * 清空 = `list` 翻页 + 逐键 `delete`，而每个键的删除都是一个 subrequest，
 * 免费档总共只有 50 个 —— 清 200 个键就把预算烧光，业务响应都发不出去。
 *
 * 而 CLI 走的是 Cloudflare 的 HTTP API，**没有这个限制**：`kv:key list`
 * 一次翻 1000 条，`kv:bulk delete` 一次删最多 **10000** 个键。所以「清空」
 * 放在这里做，既彻底又便宜。
 *
 * ## 为什么要「清空」而不是「让 TTL 自己过期」
 *
 * 因为**旧版本写下的脏数据不是 TTL 能治的**：本项目已经踩过 —— 前端把
 * 站点配置缓存在 localStorage 旧键里，后端返回的脏字符串被永久缓存，
 * 于是每次打开都崩（见 README 的故障记录）。缓存键的**语义契约**会随版本
 * 变化，而 key 名不变，于是「上一版写的值」在新版读出来就是错的。
 * 每次部署从零开始是唯一能保证「不留跨版本脏数据」的做法。
 *
 * ## 安全边界（最重要）
 *
 * **绝不清理 `flag` 角色**。那里面是自举标记 `bootstrap:done:v*`，
 * 清掉会让每次冷启动重放 `provision()` + `ensureSettings()`（两次全表
 * 扫描），免费档 Neon 直接打限流。清理名单来自 `src/lib/cacheRegistry.ts`
 * 的 `purgeableEntries()`（`purge: false` 的条目不参与），本脚本只是
 * 把它翻译成 CLI 命令 —— 名单的唯一真相在代码里，不在这里重复一遍。
 *
 * ## 失败不阻断部署
 *
 * 清缓存失败最多是「这次没清干净」，而**阻断部署**是「站点没更新」，
 * 后者严重得多。所以除了「用法错误」（参数非法）外，这里所有失败都只
 * 打警告、退出码 0。想让它变成硬失败就加 `--strict`。
 *
 * 用法：
 *   node scripts/kv-purge-refill.mjs              # 清空 + 重填（部署流程调用）
 *   node scripts/kv-purge-refill.mjs --purge-only # 只清不填
 *   node scripts/kv-purge-refill.mjs --dry        # 只打印将执行的操作
 *   node scripts/kv-purge-refill.mjs --strict     # 任何失败都非零退出
 *
 * 认证：Cloudflare Workers Builds 自动注入 token；本机手工跑需先
 * `npx wrangler login` 或设 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID。
 */
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const REGISTRY_PATH = path.join(ROOT, 'src', 'lib', 'cacheRegistry.ts');

const STRICT = process.argv.includes('--strict');
const DRY = process.argv.includes('--dry');
const PURGE_ONLY = process.argv.includes('--purge-only');

// ---------------------------------------------------------------------------
// 1. 从 TS 源码里读出「哪些角色能清、各自的前缀是什么」
//
// 为什么不 import 源码：这是构建期脚本，跑在纯 node 里，没有 TS 编译器
// 也没有 Worker 的 KV 类型。把 `cacheRegistry.ts` 的**数据部分**用正则
// 解析出来，既保持了「名单唯一真相在代码里」，又不需要引入构建依赖。
//
// 解析失败时**不猜**：直接按「不清任何东西」处理并打警告 —— 清缓存的
// 收益远小于误清的风险，宁可漏清也不能乱清。
// ---------------------------------------------------------------------------

/** 从 cacheRegistry.ts 里抽出每条 { id, label, role, prefix, purge }。 */
function parseRegistry() {
  if (!existsSync(REGISTRY_PATH)) return null;
  const src = readFileSync(REGISTRY_PATH, 'utf8');

  // 定位 CACHE_ENTRIES 数组字面量
  const start = src.indexOf('export const CACHE_ENTRIES');
  if (start === -1) return null;
  const arrStart = src.indexOf('[', start);
  const arrEnd = src.indexOf('\n];', arrStart);
  if (arrStart === -1 || arrEnd === -1) return null;
  const body = src.slice(arrStart, arrEnd);

  // 逐个对象字面量解析（用 `id:` 作为切分锚点）
  const out = [];
  // 粗略按 `{\n    id: '...'` 切块：每条都以 `id:` 开头
  const chunks = body.split(/\{\s*\n?\s*id:/).slice(1);
  for (const chunk of chunks) {
    const id = /^\s*'([^']+)'/.exec(chunk)?.[1];
    if (!id) continue;
    const role = /role:\s*'([a-z]+)'/.exec(chunk)?.[1];
    // prefix 可能是 'xxx' 或 '' —— 两种都要认
    const prefixQuoted = /prefix:\s*'([^']*)'/.exec(chunk);
    const prefix = prefixQuoted ? prefixQuoted[1] : null;
    const purge = /purge:\s*false/.test(chunk) ? false : true;
    if (!role || prefix === null) continue;
    out.push({ id, role, prefix, purge });
  }
  return out.length ? out : null;
}

/**
 * 角色 → 绑定名。**必须与 `src/lib/kvRouter.ts` 的 ROLE_BINDINGS 一致。**
 * 这里写死是因为它是「键 → namespace」的映射，改动频率极低；一旦两边
 * 不一致，下面的 `assertRoleBindingsMatch` 会在构建时立刻报出来。
 */
const ROLE_BINDINGS = {
  flag: ['KV_5', 'KV'],
  site: ['KV_1', 'KV'],
  session: ['KV_2', 'KV'],
  upload: ['KV_3', 'KV'],
  cred: ['KV_4', 'KV'],
};

/** 从 kvRouter.ts 读 ROLE_BINDINGS，核对上面写死的映射没有漂移。 */
function assertRoleBindingsMatch() {
  const p = path.join(ROOT, 'src', 'lib', 'kvRouter.ts');
  if (!existsSync(p)) return true;
  const src = readFileSync(p, 'utf8');
  for (const [role, names] of Object.entries(ROLE_BINDINGS)) {
    const re = new RegExp(`${role}:\\s*\\[([^\\]]+)\\]`);
    const m = re.exec(src);
    if (!m) continue;
    const actual = m[1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean);
    if (actual.join(',') !== names.join(',')) {
      console.warn(
        `  ⚠ kvRouter.ts 里角色 "${role}" 的绑定顺序是 [${actual}]，` +
          `本脚本写死的是 [${names}] —— 清理可能落错 namespace，已跳过清理。`,
      );
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// 2. 从 wrangler.toml 里读出每个绑定对应的真实 namespace id
// ---------------------------------------------------------------------------

/** 解析 wrangler.toml 里所有 KV 绑定 → { KV_1: 'abcd...', KV: 'ef01...' } */
function readKvIds() {
  const toml = readFileSync(TOML_PATH, 'utf8');
  const out = {};
  const re = /\[\[kv_namespaces\]\]\r?\nbinding = "(KV(?:_\d+)?)"\r?\nid = "([^"]*)"/g;
  for (const m of toml.matchAll(re)) {
    // 占位符不算真实 id（还没部署过）
    if (!m[2] || m[2].includes('REPLACE_WITH_YOUR_KV')) continue;
    out[m[1]] = m[2];
  }
  return out;
}

/** 角色 → 真实 namespace id（按 ROLE_BINDINGS 优先级取第一个存在的）。 */
function resolveRoleId(role, kvIds) {
  for (const name of ROLE_BINDINGS[role] ?? []) {
    if (kvIds[name]) return { id: kvIds[name], binding: name };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. wrangler CLI 封装
// ---------------------------------------------------------------------------

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function wrangler(args, { input } = {}) {
  const full = process.platform === 'win32' ? args : ['--yes', 'wrangler', ...args];
  const r = spawnSync(NPX, full, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    timeout: 300_000,
    shell: process.platform === 'win32',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}` };
}

/** 列出某 namespace 下前缀匹配的所有键名。翻页直到取完。 */
function listKeys(nsId, prefix) {
  const keys = [];
  let cursor = null;
  // 硬上限：防止某个前缀下键异常多时无限循环（正常量级远小于此）。
  for (let page = 0; page < 50; page++) {
    const args = ['kv', 'key', 'list', `--namespace-id=${nsId}`, '--limit=1000'];
    if (prefix) args.push(`--prefix=${prefix}`);
    if (cursor) args.push(`--cursor=${cursor}`);
    const r = wrangler(args);
    if (r.code !== 0) {
      // 失败输出尾部常是空行/日志路径提示，直接 slice(-3) 会取到空串，
      // 真实错误（权限不足 / 限流）反而被吞。过滤空行后取最后两行。
      const lines = r.out.trim().split('\n').filter((l) => l.trim());
      return { keys, error: lines.slice(-2).join(' | ') || `wrangler 退出码 ${r.code}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(r.out.slice(r.out.indexOf('[')));
    } catch {
      return { keys, error: '无法解析 kv key list 的 JSON 输出' };
    }
    if (!Array.isArray(parsed)) return { keys, error: 'kv key list 输出不是数组' };
    for (const k of parsed) if (k?.name) keys.push(k.name);
    if (parsed.length < 1000) break;
    cursor = null; // wrangler kv key list 不返回 cursor；用「满页则再拉一次」兜底
  }
  return { keys };
}

/**
 * 批量删除键。
 *
 * `wrangler kv bulk delete --files <path>` 一次最多删 **10000** 个键 ——
 * 这正是 CLI 相对 Worker 绑定的优势（没有 subrequest 预算）。
 * 传 `--force` 跳过交互确认（CI 环境必须）。
 */
function bulkDelete(nsId, keys) {
  if (keys.length === 0) return { code: 0, out: '（无键可删）' };
  const dir = mkdtempSync(path.join(tmpdir(), 'kv-purge-'));
  const file = path.join(dir, 'keys.json');
  // bulk delete 的输入格式是 JSON 字符串数组
  writeFileSync(file, JSON.stringify(keys));
  const r = wrangler(['kv', 'bulk', 'delete', `--namespace-id=${nsId}`, `--files=${file}`, '--force']);
  return r;
}

// ---------------------------------------------------------------------------
// 4. 主流程
// ---------------------------------------------------------------------------

console.log('▶ KV 清空 + 重填（构建期）');

const registry = parseRegistry();
if (!registry) {
  console.warn('  ⚠ 无法从 src/lib/cacheRegistry.ts 解析缓存清单，跳过清理（不猜、不乱清）。');
  process.exit(0);
}
console.log(`  缓存清单：${registry.length} 类（可清理 ${registry.filter((e) => e.purge).length} 类）`);

if (!assertRoleBindingsMatch()) {
  console.warn('  ⚠ 角色映射校验失败，跳过清理（宁可漏清，不可乱清）。');
  process.exit(0);
}

const kvIds = readKvIds();
if (Object.keys(kvIds).length === 0) {
  console.log('  wrangler.toml 里还没有真实 KV id（首次部署或未开通），跳过清理。');
  process.exit(0);
}

// 按**角色**聚合：同一个 namespace 可能被多个角色共享（KV_COUNT 小时回退
// 到兜底 KV），必须合并成一次操作，否则会重复删同一个键。
const byNamespace = new Map(); // nsId -> { role, bindings:Set, prefixes:Set }
let skipped = 0;

for (const entry of registry) {
  if (!entry.purge) {
    skipped++;
    continue;
  }
  const resolved = resolveRoleId(entry.role, kvIds);
  if (!resolved) continue; // 角色未绑定，跳过
  const cur = byNamespace.get(resolved.id) ?? {
    role: entry.role,
    bindings: new Set(),
    prefixes: new Set(),
  };
  cur.bindings.add(resolved.binding);
  cur.prefixes.add(entry.prefix);
  byNamespace.set(resolved.id, cur);
}

console.log(
  `  待清理 namespace：${byNamespace.size} 个（跳过 ${skipped} 类不可清理的，含自举标记）`,
);

let totalDeleted = 0;
let failures = 0;

for (const [nsId, info] of byNamespace) {
  const short = `${nsId.slice(0, 8)}…`;
  const prefixes = [...info.prefixes];

  if (DRY) {
    console.log(`  [dry] namespace ${short}（${info.role}）将清理前缀：${prefixes.map((p) => `"${p}"`).join(', ') || '（全部）'}`);
    continue;
  }

  // 收集该类下所有键。prefix='' 表示「整个 namespace 都是缓存」（cred 角色），
  // 此时 listKeys 不带 --prefix，列出全部。
  const names = new Set();
  let listError = null;
  for (const prefix of prefixes) {
    // 用角色前缀拼上业务前缀：kvRouter 的代理在真实键名前加了 `角色:`。
    // ⚠️ 这是清理能否命中的关键 —— 漏了角色前缀就会「一个键都列不到」
    // 而脚本静默成功（最阴的失败形态）。所以下面会核对列出条数。
    const fullPrefix = `${info.role}:${prefix}`;
    const res = listKeys(nsId, fullPrefix);
    if (res.error) listError = res.error;
    for (const k of res.keys) names.add(k);
  }

  if (listError && names.size === 0) {
    console.warn(`  ⚠ namespace ${short}（${info.role}）列举失败：${listError}`);
    failures++;
    continue;
  }

  if (names.size === 0) {
    console.log(`  namespace ${short}（${info.role}）本就是空的，无需清理。`);
    continue;
  }

  const r = bulkDelete(nsId, [...names]);
  if (r.code === 0) {
    totalDeleted += names.size;
    console.log(`  namespace ${short}（${info.role}）已清空 ${names.size} 个键。`);
  } else {
    failures++;
    console.warn(
      `  ⚠ namespace ${short}（${info.role}）删除 ${names.size} 个键失败：\n` +
        `     ${r.out.trim().split('\n').slice(-3).join('\n     ')}`,
    );
  }
}

if (DRY) {
  console.log('\n[dry] 未实际执行。去掉 --dry 才会真的清理。');
  process.exit(0);
}

console.log(`\n✔ 清理完成：删除 ${totalDeleted} 个键，失败 ${failures} 个 namespace。`);

// ---------------------------------------------------------------------------
// 5. 「重新填回去」
//
// 缓存的回填有两个来源，都不在构建期做：
//   a) **站点设置**：Worker 冷启动 / 每小时 cron 会 `refreshSettingsCache`
//      回源并写回（见 src/settings/provider.ts）。部署后第一次请求就填好了。
//   b) **用户行 / 一次性令牌**：按需填充（谁用就缓存谁）。
//
// 为什么不在这里预填：构建期脚本没有 Worker 的 env 绑定（拿不到数据库
// 连接、也没有 KV 绑定对象），只能用 CLI 写 KV —— 而 CLI 写 KV 需要
// 把 settings 表整表 dump 出来再逐键 put，既慢又会和 Worker 的键格式
// 产生第二份实现（格式一漂移就读不出来）。让 Worker 自己填是唯一的真相源。
// ---------------------------------------------------------------------------

if (PURGE_ONLY) {
  console.log('  （--purge-only：不触发回填）');
} else {
  console.log(
    '  回填交由 Worker 完成：部署后第一次请求会重建站点设置缓存，\n' +
      '  其余按需填充；每小时 cron 会再刷新一轮（见 src/index.ts scheduled）。',
  );
}

if (failures > 0 && STRICT) {
  console.error(`\n✘ --strict：有 ${failures} 个 namespace 清理失败。`);
  process.exit(1);
}
