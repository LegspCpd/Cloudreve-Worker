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
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'frontend');
const TARBALL_PATH = path.join(ROOT, '_frontend.tar.gz');
const SRC_DIR = path.join(ROOT, '_frontend-src');

/** 上游 .gitmodules 固定的前端提交，更新前端版本就改这里。 */
const COMMIT = 'c7b6fa5288ed0490a5589ddff4f56ea1f96a5315';
const UPSTREAM_TARBALL = `https://codeload.github.com/cloudreve/frontend/tar.gz/${COMMIT}`;
const RELEASE_TAG = 'frontend-assets';

/**
 * 预构建包名 = commit + 补丁内容哈希。
 *
 * 只带 commit 是不够的：`frontend-patches/` 改了（比如这次的 PWA 预缓存裁剪），
 * 包的**内容**就变了，但名字没变，CI 与 Cloudflare 会继续命中旧包 —— 改了等于
 * 没改。把补丁内容的指纹并进名字，改补丁自动生成新包。
 */
function patchFingerprint() {
  const dir = path.join(ROOT, 'frontend-patches');
  if (!existsSync(dir)) return 'none';
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(dir, f).replaceAll('\\', '/'));
    // 统一换行再哈希：Windows 工作区是 CRLF、CI 检出是 LF，不统一的话同一份
    // 补丁在两个平台算出不同包名，本机会永远下载不到 CI 发的包。
    h.update(readFileSync(f, 'utf8').replaceAll('\r\n', '\n'));
  }
  return h.digest('hex').slice(0, 8);
}

const RELEASE_ASSET = `frontend-${COMMIT.slice(0, 7)}-${patchFingerprint()}.tar.gz`;

// `node scripts/fetch-frontend.mjs --asset-name`：只打印包名，给 CI 用，
// 避免 CI 里再复刻一遍命名规则（复刻必然漂移）。
if (process.argv.includes('--asset-name')) {
  console.log(RELEASE_ASSET);
  process.exit(0);
}

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
 * 带重试地下载预构建包。CI 出网偶发抖动很常见（DNS、TLS、以及 GitHub
 * Release 会 302 到 objects.githubusercontent.com，半路断流），一次 fetch
 * 拿到非 200 就被判成「没有预构建包」会直接退回源码现构建，白白多花好几分钟。
 * 这里只对 5xx / 网络错误重试（404 / 403 是「真没有 / 没权限」，重试无意义）。
 */
/**
 * 下载预构建包。404 也要重试几次 —— GitHub 刚上传完资产时，下载地址会有
 * 几秒到几十秒的传播延迟（这时文件其实已经存在了，只是边缘还回 404）。
 *
 * 传 token：仓库改私有、或者匿名下载被 GitHub 限流时，带上 `GH_TOKEN` /
 * `GITHUB_TOKEN` 就能继续走快路径（公开仓库匿名也能下，不带也一样）。
 *
 * ⚠️ 要认清一个正常现象：**改动 frontend-patches 的那一次提交，这个包必然不存在**
 * —— 包名里带补丁哈希，而这个包正是由「这次构建」产出的。所以第一次构建走源码
 * 构建是设计如此，不是配置错了；下一次同指纹的构建才会命中。
 */
async function fetchWithRetry(url, attempts = 4) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  let status = 0;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers });
      if (res.ok) return res;
      status = res.status;
      // 401/403 是权限问题，重试没用；404 可能是「刚上传、还没传播完」→ 再试
      if (res.status !== 404) return res;
    } catch {
      status = 0;
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 6000 * i));
  }
  console.log(`  （预构建包下载重试 ${attempts} 次仍未成功，最后一次：${status ? `HTTP ${status}` : '网络错误'}）`);
  return { ok: false, status };
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
    .replaceAll('var(--defaultThemeColor)', '#1976d2')
    // 上游模板里 theme-color 是空的 —— 手机浏览器的地址栏/状态栏取不到颜色，
    // 显示成默认灰白。填上同一个主题色，和 PWA manifest 保持一致。
    .replace('<meta name="theme-color" content="" />', '<meta name="theme-color" content="#1976d2" />');

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

  // 预加载正文字体：vite.config.ts 把样式表改成 `media="print" onload` 异步加载
  // （不阻塞首屏），代价是字体文件要等 CSS 下载并应用后才被发现 —— 手机上
  // 正文先渲染成系统字体再跳变，既慢又晃。这里按产物里真实存在的文件名硬预加载
  // Roboto 的 400/500 两个 latin 子集（首屏只有这两档字重）。
  for (const font of findRobotoLatinFonts()) {
    const tag = `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/${font}">`;
    if (finalHtml.includes(tag)) continue;
    finalHtml = finalHtml.replace('</head>', `  ${tag}\n  </head>`);
  }

  // 首屏遮罩里的 logo 是 CSS 背景图，只有等样式生效才开始下载 —— 预加载一下
  // 能让「白屏 → logo 出现」这一步提前，感知上快很多。
  const logoTag = '<link rel="preload" as="image" href="/static/img/logo192.png">';
  if (!finalHtml.includes(logoTag)) {
    finalHtml = finalHtml.replace('</head>', `  ${logoTag}\n  </head>`);
  }

  // 白屏自愈：一旦某一版前端 JS 崩了（2026-10-26 拆 chunk 拆出循环依赖就崩过一次），
  // Service Worker 会把坏版本连同 index.html 一起预缓存下来；而它的新版本要靠页面里
  // 的「有新版本，刷新？」提示来激活 —— 页面都白屏了，提示永远弹不出来，用户就**永久
  // 卡死**，除非手动 Ctrl+F5。
  //
  // 这段内联脚本跑在入口 module 之前（module 是 defer 的），所以即使应用整体崩掉它也在：
  // 6 秒后 #root 还是空的，就把已经在等待的新 SW 直接推上去并重载一次。
  // 有 sessionStorage 兜底，只重载一次，不会循环。
  const selfHealTag = `<script>${SELF_HEAL_SCRIPT}</script>`;
  if (!finalHtml.includes('__edge_self_heal')) {
    finalHtml = finalHtml.replace('</body>', `  ${selfHealTag}\n</body>`);
  }

  if (finalHtml !== html) writeFileSync(file, finalHtml);
}

/**
 * 见 patchIndexHtml 里的说明。刻意保持 ES5（要跑在很老的 WebView 里）与零依赖。
 * 触发条件很窄：6 秒后应用没挂载 + 存在 waiting 的 SW，二者同时成立才动。
 */
const SELF_HEAL_SCRIPT = `/* __edge_self_heal */
(function () {
  var KEY = 'edge:selfheal';

  // 分片加载失败：部署换了前端后，老页面里的入口仍指向已被删除的 chunk；
  // 加上 Assets 的 SPA 回落会把 index.html 当成 JS 返回，动态 import 直接报
  // "Failed to fetch dynamically imported module"。这里注销 Service Worker、
  // 清空 Cache Storage，再整页重载一次，拿到新的 index.html 和当前构建的分片。
  // sessionStorage 兜底，只自愈一次，避免死循环。
  function heal() {
    if (sessionStorage.getItem(KEY) === '1') return;
    sessionStorage.setItem(KEY, '1');
    var reload = function () { location.reload(); };
    var clearCaches = function () {
      if (!('caches' in window)) { reload(); return; }
      caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (k) { return caches.delete(k); }));
      }).then(reload, reload);
    };
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistrations) {
      clearCaches();
      return;
    }
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      return Promise.all(regs.map(function (r) { return r.unregister(); }));
    }).then(clearCaches, clearCaches);
  }

  window.addEventListener('vite:preloadError', function (e) {
    if (e && e.preventDefault) e.preventDefault();
    heal();
  });

  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.getRegistration) return;
  setTimeout(function () {
    var root = document.getElementById('root');
    if (root && root.childElementCount > 0) return; // 应用正常起来了
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (!reg || !reg.waiting) return; // 没有待激活的新版本就不动
      sessionStorage.setItem(KEY, '1');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      // 不用等 controllerchange：sw.js 没开 clientsClaim，现有页面不会立刻换
      // controller，但 reload 之后发起的导航一定走已激活的新版本。
      setTimeout(function () { location.reload(); }, 800);
    }).catch(function () {});
  }, 6000);
})();`;

/** 在构建产物里找出 Roboto latin 的 400/500 字重文件（哈希名，必须运行时找）。 */
function findRobotoLatinFonts() {
  const assetsDir = path.join(TARGET, 'assets');
  if (!existsSync(assetsDir)) return [];
  try {
    return readdirSync(assetsDir)
      .filter((n) => /^roboto-latin-(400|500)-normal.*\.woff2$/.test(n))
      .sort();
  } catch {
    return [];
  }
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
    '# 静态资源的安全响应头（API 侧由 src/middleware/app.ts 的 securityHeaders 负责）',
    '/*',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  X-Frame-Options: SAMEORIGIN',
    '',
    '# 站点图标/占位图：文件名固定、内容极少变，一天缓存换掉首屏那次条件请求',
    '/static/*',
    '  Cache-Control: public, max-age=86400',
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
    const res = await fetchWithRetry(url);
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
        // 占位符填充 / _headers 注入失败**不能**拖累快路径 —— 那只是锦上添花，
        // 抛出去会被外层 catch 捕获、误判成「Release 不可用」而退回源码构建。
        try {
          patchIndexHtml();
          writeHeaders();
        } catch (e) {
          console.log(`  （占位符填充/头注入失败，不影响前端本体，继续：${e?.message || e}）`);
        }
        console.log('✅ 前端就绪（Release 预构建包）。');
        process.exit(0);
      }
      console.log('  Release 包内容异常，回退到源码构建。');
      cleanup();
    } else if (res.status === 404) {
      // 最常见的两种情况，写清楚免得当成故障排查：
      //   1. 这次提交改了 frontend-patches/ → 包名（带补丁指纹）是新算出来的，
      //      而它正由**这次构建**产出 → 第一次必然 404，属正常。
      //   2. 刚由别的流水线发布、CDN 还没传播完（上面已经重试过）。
      console.log(
        `  预构建包尚不存在（${RELEASE_ASSET}）。` +
          '改动过 frontend-patches 的那次提交本来就没有这个包，本次源码构建后会自动发出来。',
      );
    } else {      console.log(
        `  下载失败（HTTP ${res.status}）。私有仓库需要给构建机配 GH_TOKEN；公开仓库多半是网络问题。`,
      );
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
const pinned = applyDependencyPins(src);

console.log('  安装前端依赖（首次约 1-3 分钟）…');
const installStart = Date.now();
// --network-timeout：CF 构建机到 npm registry 偶发抖动时，默认超时会直接
// 失败（曾出现 12 分钟后构建失败）。yarn 1 的时间戳网络错误靠它兜底。
// 有依赖钉死时不能用 --frozen-lockfile：lockfile 与 resolutions 不一致，
// yarn 会直接报「lockfile needs update」并退出。
const installArgs = ['yarn@1.22.22', 'install', '--network-timeout', '600000'];
if (!pinned) installArgs.push('--frozen-lockfile');
runOrDie(NPX, npxArgs(installArgs), 'yarn install', {
  cwd: src,
  env: { HUSKY: '0', NODE_OPTIONS: '--max-old-space-size=6144' },
});
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
  // 补丁目录里的 dep-pins.json 只是给下面的 applyDependencyPins() 读的配置，
  // 不该留进源码树（会被 vite 当成项目文件）。
  rmSync(path.join(srcDir, 'dep-pins.json'), { force: true });
  console.log('✅ 前端补丁已叠加。');
}

/**
 * 依赖版本钉死（安全修复）。
 *
 * `frontend-patches/dep-pins.json` 里列的是「当前上游 lockfile 解析出来的版本
 * 有已知 CVE、而有修复版」的包。写进 package.json 的 `resolutions` 后 yarn 会
 * 强制用钉死的版本，连传递依赖一起换掉 —— 不动上游源码就能把漏洞修掉。
 *
 * 返回 true 表示这次确实改了依赖树：调用方要相应地**放弃** `--frozen-lockfile`
 * （lockfile 与 resolutions 不一致时 yarn 会直接拒绝安装）。
 */
function applyDependencyPins(srcDir) {
  const pinsFile = path.join(ROOT, 'frontend-patches', 'dep-pins.json');
  if (!existsSync(pinsFile)) return false;
  let pins;
  try {
    pins = JSON.parse(readFileSync(pinsFile, 'utf8'));
  } catch (e) {
    console.error(`✘ frontend-patches/dep-pins.json 解析失败：${e?.message || e}`);
    process.exit(1);
  }
  const entries = Object.entries(pins || {});
  if (entries.length === 0) return false;

  const pkgPath = path.join(srcDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.resolutions = { ...(pkg.resolutions || {}), ...pins };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`  钉住 ${entries.length} 个依赖版本：${entries.map(([k, v]) => `${k}@${v}`).join(', ')}`);
  return true;
}
rmSync(TARGET, { recursive: true, force: true });
cpSync(built, TARGET, { recursive: true });
cleanup();
patchIndexHtml();
writeHeaders();

console.log(`✅ 官方前端就绪：${TARGET}`);
