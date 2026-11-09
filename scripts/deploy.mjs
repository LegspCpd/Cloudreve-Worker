#!/usr/bin/env node
/**
 * 一条命令完成部署（CI 友好，专为 Cloudflare Workers Builds 这类
 * 「构建命令 + 部署命令」两格配置的场景设计）：
 *
 *   1. 按 `KV_COUNT` 装配 KV 绑定（scripts/setup-kv.mjs）。>5 直接拒绝构建。
 *      然后逐个 namespace「不存在就创建」，把真实 ID 回填进 wrangler.toml。
 *   2. R2 bucket 不存在就自动创建；创建失败改用无 R2 绑定部署（R2 可选）。
 *   3. 准备官方前端（缺了自动拉源码构建）。
 *   4. `wrangler deploy` 发布；若 CI 环境变量里给了 SITE_URL / FRONTEND_URL，
 *      用 --var 覆盖 wrangler.toml 里的空值，无需改文件。
 *   5. 若 CI 环境变量里给了 DATABASE_URL，部署成功后自动 `wrangler secret put`
 *      写进 Worker 运行时，面板里连 Secret 都不用手动加。
 *      多库容灾的备库连接串（DATABASE_URL_2..5）同样在这里写入。
 *
 * 认证：Cloudflare Workers Builds 会自动注入 API token，本机手工跑则需要
 * 先 `npx wrangler login`。任何一步失败都会带出真实报错并以非零码退出，
 * 让构建日志直接看到原因。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const WORKER_NAME = 'cloudreve-worker';
const R2_BUCKET = 'cloudreve-worker';

/** 占位符前缀：setup-kv.mjs 写进 wrangler.toml 的待填 ID 都含这段。 */
const KV_PLACEHOLDER_MARK = 'REPLACE_WITH_YOUR_KV';

function run(cmd, args, { input } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    shell: process.platform === 'win32',
  });
  return {
    code: r.status ?? 1,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    all: `${r.stdout || ''}${r.stderr || ''}`,
  };
}

function runOrDie(cmd, args, label, opts) {
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    console.error(`\n✘ ${label} 失败（exit ${r.code}）：\n${r.all}`);
    process.exit(r.code);
  }
  return r;
}

/** npx 在 Windows 上需要 shell；CI 是 Linux。 */
function npxArgs(args) {
  return process.platform === 'win32' ? args : ['--yes', 'wrangler', ...args];
}
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';

/**
 * 从 wrangler 输出里提取 JSON 数组。stdout 可能混着警告横幅
 * （如 `[wrangler warn]`，同样在行首），所以逐个行首 `[` 尝试解析，
 * 第一个能完整解析成数组的生效；都没有返回 null，不抛错。
 */
function extractJsonArray(text) {
  for (const m of text.matchAll(/^\[/gm)) {
    const start = m.index;
    const end = text.lastIndexOf(']');
    if (end <= start) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* 换下一个行首 [ 继续 */
    }
  }
  return null;
}

console.log('▶ 1/6 检查 KV namespace…');

// 先按 KV_COUNT 装配绑定（超过 5 直接拒绝构建，见该脚本的说明）。
runOrDie(
  process.execPath,
  [path.join(ROOT, 'scripts', 'setup-kv.mjs')],
  '装配 KV 绑定（setup-kv.mjs）',
);

let toml = readFileSync(TOML_PATH, 'utf8');

/**
 * 找出 toml 里所有待填的 KV 绑定：`binding = "KV"` / `KV_1` / `KV_2` ...
 *
 * 每个绑定要独立创建一个 namespace（不能再像以前那样只处理一个 KV）。
 * 用行首锚定的正则逐块匹配，拿到的顺序就是文件里的顺序。
 */
function kvBindingsIn(text) {
  const out = [];
  const re = /\[\[kv_namespaces\]\]\r?\nbinding = "(KV(?:_\d+)?)"\r?\nid = "([^"]*)"\r?\npreview_id = "([^"]*)"/g;
  for (const m of text.matchAll(re)) {
    out.push({ binding: m[1], id: m[2], previewId: m[3] });
  }
  return out;
}

const bindingsNeedingWork = kvBindingsIn(toml).filter(
  (b) => b.id.includes('REPLACE_WITH_YOUR_KV') || b.previewId.includes('REPLACE_WITH_YOUR_KV'),
);

if (bindingsNeedingWork.length === 0) {
  console.log(`  wrangler.toml 已含真实 KV ID，跳过开通。`);
} else {
  console.log(`  待开通 ${bindingsNeedingWork.length} 个：${bindingsNeedingWork.map((b) => b.binding).join(', ')}`);

  // 一次性列出全部 namespace，避免每个绑定都打一次 CLI。
  const list = run(NPX, npxArgs(['kv', 'namespace', 'list']));
  const existing = list.code === 0 ? extractJsonArray(list.stdout) : null;
  const allNs = Array.isArray(existing) ? existing : [];

  /** 按标题找 namespace：优先 `<worker>-<binding>`，兼容裸标题 / 无 worker 前缀。 */
  const findByTitle = (binding) =>
    allNs.find(
      (n) =>
        typeof n?.title === 'string' &&
        (n.title === `${WORKER_NAME}-${binding}` ||
          n.title === binding ||
          n.title === `${WORKER_NAME}-KV-${binding.replace(/^KV_?/, '')}`),
    );

  for (const b of bindingsNeedingWork) {
    let nsId = findByTitle(b.binding)?.id ?? null;

    if (!nsId) {
      console.log(`  未找到 ${WORKER_NAME}-${b.binding}，创建…`);
      const created = run(NPX, npxArgs(['kv', 'namespace', 'create', b.binding]));
      if (created.code === 0) {
        const m = created.all.match(/id\s*=\s*"([0-9a-f]{32})"/i);
        if (!m) {
          console.error(`\n✘ 无法从 wrangler 输出解析 ${b.binding} 的 ID：\n${created.all}`);
          process.exit(1);
        }
        nsId = m[1];
      } else if (/already exists|10013/i.test(created.all)) {
        // 撞名：回列表里找一遍再复用
        const relist = run(NPX, npxArgs(['kv', 'namespace', 'list']));
        const arr = relist.code === 0 ? extractJsonArray(relist.stdout) : null;
        const hit = Array.isArray(arr)
          ? arr.find(
              (n) =>
                typeof n?.title === 'string' &&
                (n.title === `${WORKER_NAME}-${b.binding}` ||
                  n.title === b.binding ||
                  n.title === `${WORKER_NAME}-KV-${b.binding.replace(/^KV_?/, '')}`),
            )
          : null;
        if (!hit?.id) {
          console.error(`\n✘ ${b.binding} 已存在但列表中找不到：\n${created.all}`);
          process.exit(created.code || 1);
        }
        console.log(`  已存在同名 namespace（${hit.id}），复用。`);
        nsId = hit.id;
      } else {
        console.error(`\n✘ 创建 KV namespace ${b.binding} 失败（exit ${created.code}）：\n${created.all}`);
        process.exit(created.code || 1);
      }
    } else {
      console.log(`  ${b.binding} 已存在（${nsId}），直接复用。`);
    }

    // 精确替换**这一个**绑定的 id / preview_id（按 binding 名定位，不用全局替换，
    // 否则多个绑定的占位符会互相覆盖）。
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    toml = toml.replace(
      new RegExp(
        `(\\[\\[kv_namespaces\\]\\]\\r?\\nbinding = "${esc(b.binding)}"\\r?\\nid = ")[^"]*("\\r?\\npreview_id = ")[^"]*(")`,
      ),
      `$1${nsId}$2${nsId}$3`,
    );
  }

  writeFileSync(TOML_PATH, toml);
  console.log('  已把 KV ID 回填进 wrangler.toml。');
}

console.log('▶ 2/6 检查 R2 bucket…');
{
  const list = run(NPX, npxArgs(['r2', 'bucket', 'list']));
  let exists = false;
  if (list.code === 0) {
    const arr = extractJsonArray(list.stdout);
    exists = Array.isArray(arr) && arr.some((b) => b?.name === R2_BUCKET);
  }
  if (exists) {
    console.log(`  ${R2_BUCKET} 已存在。`);
  } else {
    const created = run(NPX, npxArgs(['r2', 'bucket', 'create', R2_BUCKET]));
    if (created.code !== 0 && !/already exists|10041/i.test(created.all)) {
      // R2 是可选绑定（2026-11 需求：不强制 R2，用户可绑任意 S3 兼容存储）。
      // 创建失败（套餐/权限/区域不支持）不该挡部署：把绑定从 wrangler.toml
      // 摘掉继续发布，代价只是头像功能不可用 + 预置策略需要手填 AK/SK。
      console.error(`  ⚠ 创建 R2 bucket 失败（exit ${created.code}），改用无 R2 绑定部署。`);
      console.error(`    详情：${created.all.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' | ')}`);
      const toml = readFileSync(TOML_PATH, 'utf8');
      const stripped = toml.replace(/\n\[\[r2_buckets\]\][^\[]*(?=\n\[|$)/g, '\n');
      if (stripped === toml) {
        console.error('  ✘ 未能从 wrangler.toml 移除 [[r2_buckets]]，终止部署。');
        process.exit(created.code);
      }
      writeFileSync(TOML_PATH, stripped);
      console.log('  已从 wrangler.toml 移除 [[r2_buckets]]，本次部署不含 R2。');
      console.log('  存储请在管理后台配 S3 兼容策略（COS/OBS/MinIO 均可）；头像功能不可用。');
    } else {
      console.log(`  ${R2_BUCKET} 就绪。`);
    }
  }
}

console.log('▶ 3/6 准备官方前端（frontend/，缺了会自动拉源码构建）…');
runOrDie(process.execPath, [path.join(ROOT, 'scripts', 'fetch-frontend.mjs')], '准备官方前端');

/**
 * 清空 KV 缓存，让新版本从零开始（需求：「每一次构建的时候，清空所有 kv
 * 数据库，然后再把要缓存的东西重新填进去」）。
 *
 * 放在「KV 已就绪」之后、「发布」之前：此时 wrangler.toml 里的 namespace id
 * 都是真实的，脚本才能定位到正确的 namespace。
 *
 * **失败不阻断部署**：清缓存失败最多是「这次没清干净」，而阻断部署是
 * 「站点没更新」—— 后者严重得多。所以这里只警告，不加 runOrDie。
 * 想让它硬失败就加 `--strict`（见该脚本）。
 *
 * 回填不在这一步做：构建脚本没有 Worker 的 env 绑定（拿不到库连接），
 * 让 Worker 部署后自己重建（第一次请求 + 每小时 cron）才是唯一真相源。
 */
{
  const r = run(process.execPath, [path.join(ROOT, 'scripts', 'kv-purge-refill.mjs')]);
  console.log(r.all.trimEnd());
  if (r.code !== 0) {
    console.log('  （清缓存失败不阻断部署 —— 缓存最多脏一轮，下次构建会再清）');
  }
}

console.log('▶ 4/6 发布 Worker…');
{
  const args = ['deploy'];
  for (const key of ['SITE_URL', 'FRONTEND_URL']) {
    const v = process.env[key];
    // wrangler --var 会覆盖 toml 里的 [vars]，只在 CI 环境变量真的给了值时传
    if (v && v.trim()) args.push('--var', `${key}:${v.trim()}`);
  }
  const deployed = runOrDie(NPX, npxArgs(args), 'wrangler deploy');
  console.log(deployed.stdout.trimEnd());
}

{
  // 主库 + 备库连接串。备库是可选的，有多少写多少。
  const secrets = [
    'DATABASE_URL',
    'DATABASE_URL_2',
    'DATABASE_URL_3',
    'DATABASE_URL_4',
    'DATABASE_URL_5',
  ].filter((k) => process.env[k]?.trim());

  if (secrets.length === 0) {
    console.log('▶ 5/6 跳过 Secret（CI 环境变量里没有 DATABASE_URL）。');
    console.log('  记得到 Cloudflare 面板 → 该 Worker → 设置 → 变量和机密，添加 DATABASE_URL。');
  } else {
    console.log(`▶ 5/6 写入 ${secrets.length} 个数据库连接 Secret…`);
    for (const key of secrets) {
      // secret put 非交互时从 stdin 读值；失败不阻断（也许面板里已手动设过）
      const r = run(NPX, npxArgs(['secret', 'put', key]), {
        input: `${process.env[key]}\n`,
      });
      console.log(
        r.code === 0 ? `  ${key} 已写入。` : `  ${key} 写入失败（可忽略，若面板里已设置）：\n${r.all}`,
      );
    }
    if (secrets.length > 1) {
      console.log(`  已配置 ${secrets.length - 1} 个备库。构建日志里会看到全量同步的结果。`);
    }
  }
}

console.log('\n✅ 部署完成。');
