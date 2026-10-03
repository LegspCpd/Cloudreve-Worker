#!/usr/bin/env node
/**
 * 确保仓库根目录下有官方前端构建产物（frontend/），供 wrangler.toml 的
 * [assets] 使用。前端源码不入库，按以下顺序获取：
 *
 *   1. frontend/index.html 已存在 → 直接用（上次构建/部署留下的产物）。
 *   2. 本仓库 GitHub Release（tag `frontend-assets`）里的 frontend.tar.gz
 *      → 下载解压，秒级完成。私有仓库或没发过 Release 会 404，自动走 3。
 *   3. 拉取上游 cloudreve/frontend 源码（固定 COMMIT，与上游 .gitmodules
 *      一致），在本机/构建机上 yarn install + vite build。
 *
 * `npm run build` 和 `npm run deploy` 都会先跑本脚本，所以 Cloudflare
 * 面板的两格命令不需要变。任何一步失败都会带出真实报错并以非零码退出。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'frontend');
const TARBALL_PATH = path.join(ROOT, '_frontend.tar.gz');
const SRC_DIR = path.join(ROOT, '_frontend-src');

/** 上游 .gitmodules 固定的前端提交，更新前端版本就改这里。 */
const COMMIT = '19da0fe1ecd40971fafa813983d769fdce41573c';
const UPSTREAM_TARBALL = `https://codeload.github.com/cloudreve/frontend/tar.gz/${COMMIT}`;
const RELEASE_TAG = 'frontend-assets';
const RELEASE_ASSET = `frontend-${COMMIT.slice(0, 7)}.tar.gz`;

/** npx 在 Windows 上需要 shell；CI 是 Linux。 */
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npxArgs = (args) => (process.platform === 'win32' ? args : ['--yes', ...args]);

function run(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: cwd || ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
  return { code: r.status ?? 1, all: `${r.stdout || ''}${r.stderr || ''}` };
}

function runOrDie(cmd, args, label, opts) {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = run(cmd, args, opts);
  if (r.code !== 0) {
    console.error(`\n✘ ${label} 失败（exit ${r.code}）：\n${r.all}`);
    process.exit(r.code);
  }
  return r;
}

function cleanup() {
  rmSync(TARBALL_PATH, { force: true });
  rmSync(SRC_DIR, { recursive: true, force: true });
}

/**
 * 解析 owner/repo，用来拼 Release 预构建包的下载地址。
 *
 * 坑：CI 检出时 `git remote get-url origin` 常常**没有 `.git` 后缀**
 * （GitHub Actions 的 actions/checkout 就是这样），也可能带
 * `x-access-token:` 前缀或 `git@github.com:` 形式。老写法
 * `([^/.]+)\.git` 强制要求 `.git` 结尾，匹配失败就让整个 Release 快路径
 * 被静默跳过，每次都退回源码现构建 —— 白白多花 1~3 分钟。
 *
 * 这里优先用 GitHub Actions 直接给的 GITHUB_REPOSITORY，再退回一个
 * 容忍多种形式的正则（.git 可选、token 前缀无所谓、结尾斜杠无所谓）。
 */
function detectRepoSlug() {
  const gh = (process.env.GITHUB_REPOSITORY || '').trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(gh)) return gh;
  const raw = run('git', ['remote', 'get-url', 'origin']).all.trim();
  const m = raw.match(/github\.com[/:]([^/\s]+)\/([^/\s]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

/**
 * 官方前端的 index.html 是个模板：{siteName} / {pwa_small_icon} /
 * var(--defaultThemeColor) 这些占位符在原版里由 Go 后端运行时填充
 * （middleware/frontend.go），静态部署拿不到这一步，浏览器会直接看到
 * "{siteName}" 字面量、favicon 指向不存在的地址。这里按原版
 * inventory/setting.go 的默认值填充（幂等：已填充过的文件不再变动）。
 * 管理后台改站点名后，PWA 名称与站内标题跟随设置 —— manifest.json 由
 * Worker 动态生成，页面标题由前端应用加载配置后自行更新。
 */
function patchIndexHtml() {
  const file = path.join(TARGET, 'index.html');
  if (!existsSync(file)) return;
  const html = readFileSync(file, 'utf8');
  const patched = html
    .replaceAll('{siteName}', 'Cloudreve')
    .replaceAll('{siteDes}', 'Cloudreve')
    .replaceAll('{siteScript}', '')
    .replaceAll('{pwa_small_icon}', '/static/img/favicon.ico')
    .replaceAll('{pwa_medium_icon}', '/static/img/logo192.png')
    .replaceAll('var(--defaultThemeColor)', '#1976d2');

  // 预加载入口脚本：Vite 只 modulepreload 了 common/react 两个分片，
  // 1.5MB 的主包没有预加载，Lighthouse 会报「Preload key requests」。
  // 显式加一条 preload 并给入口标 fetchpriority=high，让主包尽早并行下载。
  // preload 与 module 脚本是同源 URL，浏览器不会重复下载。
  const entryMatch = patched.match(/<script[^>]*\ssrc="(\/assets\/index-[^"]+\.js)"[^>]*>/);
  let finalHtml = patched;
  if (entryMatch) {
    const entrySrc = entryMatch[1];
    const newEntry = entryMatch[0].includes('fetchpriority')
      ? entryMatch[0]
      : entryMatch[0].replace('<script', '<script fetchpriority="high"');
    const preload = `<link rel="preload" as="script" crossorigin href="${entrySrc}">`;
    if (!finalHtml.includes(preload)) {
      finalHtml = finalHtml.replace(entryMatch[0], `${preload}\n  ${newEntry}`);
    }
  }

  if (finalHtml !== html) writeFileSync(file, finalHtml);
}

/**
 * 给静态资源目录注入 _headers：内容哈希命名的 /assets/*（JS/CSS/字体/图片）
 * 设 `immutable` 永久缓存，让重复访问直接命中浏览器缓存、跳过 1.5MB 主包的
 * 重新下载/校验（原 Workers Assets 默认是 max-age=0，每次访问都向 CF 边缘发
 * 条件请求）。HTML 与未哈希资源保持默认 max-age=0，部署后即时更新。
 *
 * 写入位置是 assets 目录根（frontend/_headers），Workers Assets 部署时会解析
 * 它并套用到静态响应。frontend/ 不入库、由本脚本生成，所以在这里注入最稳。
 */
function writeHeaders() {
  const file = path.join(TARGET, '_headers');
  const content = [
    '# Cloudreve edge：内容哈希资源永久缓存，HTML 保持默认 max-age=0 以便即时更新',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
  ].join('\n');
  writeFileSync(file, content);
}

// --- 1. 已有产物 ---
if (existsSync(path.join(TARGET, 'index.html'))) {
  console.log('  frontend/ 已存在，补一遍占位符填充后直接复用。');
  patchIndexHtml();
  writeHeaders();
  process.exit(0);
}
console.log('  未发现 frontend/，开始获取官方前端…');
cleanup();

// --- 2. 同仓库 Release 里的预构建包（公开仓库时走这条，秒级） ---
try {
  const slug = detectRepoSlug();
  if (!slug) {
    console.log('  没能解析出仓库标识（GITHUB_REPOSITORY / git remote 都不可用），跳过预构建包。');
  }
  if (slug && process.env.CLOUDREV_FE_RELEASE !== '0') {
    const url = `https://github.com/${slug}/releases/download/${RELEASE_TAG}/${RELEASE_ASSET}`;
    console.log(`  尝试从 Release 下载预构建包：${url}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (res.ok) {
      writeFileSync(TARBALL_PATH, Buffer.from(await res.arrayBuffer()));
      // tar 的路径参数一律用**相对名 + cwd**：Windows 自带的 bsdtar 会把
      // `F:\path` 里的冒号当成「远程主机 user@host:path」语法（报
      // "Cannot connect to F:"），绝对路径连 `-C` 也会踩。Linux 无此问题。
      runOrDie('tar', ['-xzf', '_frontend.tar.gz'], '解压前端产物', { cwd: ROOT });
      const inner = path.join(SRC_DIR, RELEASE_ASSET.replace('.tar.gz', ''));
      rmSync(TARGET, { recursive: true, force: true });
      cpSync(inner, TARGET, { recursive: true });
      cleanup();
      if (existsSync(path.join(TARGET, 'index.html'))) {
        patchIndexHtml();
        writeHeaders();
        console.log('✅ 前端就绪（Release 预构建包）。');
        process.exit(0);
      }
      console.log('  Release 包内容异常，回退到源码构建。');
      cleanup();
    } else {
      console.log(`  下载失败（HTTP ${res.status}，私有仓库/未发布 Release 时属正常），改从源码构建。`);
    }
  }
} catch (e) {
  console.log(`  Release 路径不可用（${e?.message || e}），改从源码构建。`);
}
cleanup();

// --- 3. 上游源码，本机/构建机构建 ---
console.log(`  下载上游源码（cloudreve/frontend @ ${COMMIT.slice(0, 7)}）…`);
const res = await fetch(UPSTREAM_TARBALL, { redirect: 'follow' });
if (!res.ok) {
  console.error(`✘ 源码下载失败：HTTP ${res.status}（${UPSTREAM_TARBALL}）`);
  process.exit(1);
}
mkdirSync(SRC_DIR, { recursive: true });
// 包放进 SRC_DIR 里再解压，让 tar 的参数是纯文件名（见上面冒号问题的注释）
writeFileSync(path.join(SRC_DIR, '_frontend.tar.gz'), Buffer.from(await res.arrayBuffer()));
runOrDie('tar', ['-xzf', '_frontend.tar.gz'], '解压源码', { cwd: SRC_DIR });
const src = path.join(SRC_DIR, `frontend-${COMMIT}`);
if (!existsSync(src)) {
  console.error(`✘ 解压后找不到源码目录：${src}`);
  process.exit(1);
}
applyFrontendPatches(src);

console.log('  安装前端依赖（首次约 1-3 分钟）…');
const installStart = Date.now();
// --network-timeout：CF 构建机到 npm registry 偶发抖动时，默认超时会直接
// 失败（曾出现 12 分钟后构建失败）。yarn 1 的时间戳网络错误靠它兜底。
runOrDie(
  NPX,
  npxArgs(['yarn@1.22.22', 'install', '--frozen-lockfile', '--network-timeout', '600000']),
  'yarn install',
  { cwd: src, env: { HUSKY: '0', NODE_OPTIONS: '--max-old-space-size=6144' } },
);
console.log(`  yarn install 完成，耗时 ${Math.round((Date.now() - installStart) / 1000)}s`);

console.log('  构建前端（vite build，约 1-4 分钟）…');
const buildStart = Date.now();
runOrDie(NPX, npxArgs(['yarn@1.22.22', 'run', 'build']), 'yarn build', {
  cwd: src,
  env: { HUSKY: '0', NODE_OPTIONS: '--max-old-space-size=6144' },
});
console.log(`  vite build 完成，耗时 ${Math.round((Date.now() - buildStart) / 1000)}s`);

const built = path.join(src, 'build');
if (!existsSync(path.join(built, 'index.html'))) {
  console.error(`✘ 构建产物里没有 index.html：${built}`);
  process.exit(1);
}

/**
 * 本地前端补丁叠加层。仓库里的 frontend-patches/ 保存了我们对官方前端源码的
 * 修改（去除 Pro 标记/弹窗、刷新 localStorage 缓存键等）。因为构建时前端源码是
 * 从上游重新拉取的，这里在拉取解压后把补丁文件覆盖到对应路径，让修改能真正上线。
 * 上游提交固定（见 COMMIT），补丁只需覆盖我们改过的文件，其余沿用上游。
 */
function applyFrontendPatches(srcDir) {
  const patches = path.join(ROOT, 'frontend-patches');
  if (!existsSync(patches)) return;
  console.log('  叠加本地前端补丁（Pro 去除 / 缓存键刷新等）…');
  cpSync(patches, srcDir, { recursive: true, force: true });
  console.log('✅ 前端补丁已叠加。');
}
rmSync(TARGET, { recursive: true, force: true });
cpSync(built, TARGET, { recursive: true });
cleanup();
patchIndexHtml();
writeHeaders();

console.log(`✅ 官方前端就绪：${TARGET}`);
