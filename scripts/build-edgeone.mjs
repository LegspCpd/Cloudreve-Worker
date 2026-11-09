/**
 * EdgeOne Pages（Makers）构建脚本。
 *
 * 产物两块：
 *   1. `dist/` —— 前端静态托管目录（edgeone.json 的 outputDirectory），
 *      fetch-frontend 拉取/构建的前端产物原样拷入。
 *   2. `cloud-functions/[[default]].js` —— catch-all Node 云函数，处理
 *      全部后端路径（/api/*、/dav、/s/:id 分享页、/f/:id 直链、manifest）。
 *
 * ⚠️ 函数内要做 SPA 壳兜底（api/makers.ts 的 isHtmlNav 分支）：前端路由
 *   （/home 等）在静态层不存在，会落到 catch-all 函数，没有壳兜底就是
 *   404 JSON，前端路由全打不开。缺失的 /assets/*.js 则必须 404 —— 回壳
 *   会造成「HTML 当 JS」的白屏（CF 的 not_found_handling 踩过同样的坑）。
 *
 * 其他平台行为：
 *   - `cloudflare:sockets` 被 alias 到 src/edgeone/socket-shim.ts
 *     （node:net 实现），CF 的 wrangler 构建不受影响；
 *   - 每小时 cron 由 edgeone.json 的 schedules 触发
 *     POST /api/v4/site/cron/tick（端点自带 10 分钟节流）；
 *   - 国际站（pages.edgeone.ai）与中国站（edgeone.cloud.tencent.com）的
 *     edgeone.json 完全通用，两个控制台各建一个项目绑同一仓库即可。
 */
import esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- 1. 前端产物 ------------------------------------------------------------
// 复用 CF 部署同款的 fetch-frontend.mjs：优先下载 Release 预构建包，
// 失败回落源码构建。产物目录 frontend/ 与 wrangler [assets] 共用一份。
console.log('▶ [1/3] 准备前端产物（frontend/）…');
{
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fetch-frontend.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('✘ 前端产物准备失败');
    process.exit(r.status ?? 1);
  }
}

// ---- 2. dist/（outputDirectory）--------------------------------------------
console.log('▶ [2/3] 组装 dist/（outputDirectory）…');
{
  const src = path.join(ROOT, 'frontend');
  const out = path.join(ROOT, 'dist');
  if (!existsSync(path.join(src, 'index.html'))) {
    console.error(`✘ ${src}/index.html 不存在，前端产物不完整`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(src, out, { recursive: true });
  console.log(`  已拷贝 ${src} → ${out}`);
}

// ---- 3. Node 云函数（catch-all bundle）--------------------------------------
// ⚠️ 产物必须提交进仓库：EdgeOne 的函数路由在构建前从仓库读取，构建期
// 新建的 cloud-functions/ 不一定被注册（本项目实测：函数没入库时 /api/*
// 全被 SPA fallback 回成 index.html，前端报 themes undefined）。
// `--check` 模式供 CI 用：重新打包后与已提交产物逐字节比对，防止改了
// src/ 忘了重新生成产物。
const CHECK = process.argv.includes('--check');
const ARTIFACT = path.join(ROOT, 'cloud-functions', '[[default]].js');
const OUTFILE = CHECK
  ? path.join(ROOT, 'node_modules', '.cache', 'edgeone-artifact-check.mjs')
  : ARTIFACT;

console.log(CHECK ? '▶ [3/3] 校验云函数产物是否最新…' : '▶ [3/3] 打包 Node 云函数…');
if (CHECK) mkdirSync(path.dirname(OUTFILE), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(ROOT, 'api', 'makers.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  outfile: OUTFILE,
  // SPA 壳内联：dist/index.html 以文本形式打进 bundle（构建顺序保证
  // 这一步跑在「组装 dist/」之后）。
  loader: { '.html': 'text', '.sql': 'text' },
  // cloudflare:sockets 换成 node:net shim（src/edgeone/socket-shim.ts）；
  // CF 的 wrangler 构建走平台原生实现，不受本 alias 影响。
  alias: {
    'cloudflare:sockets': path.join(ROOT, 'src', 'edgeone', 'socket-shim.ts'),
  },
  logLevel: 'silent',
});

if (CHECK) {
  const { readFileSync, rmSync } = await import('node:fs');
  const expected = readFileSync(OUTFILE);
  rmSync(OUTFILE, { force: true });
  if (!existsSync(ARTIFACT)) {
    console.error('✘ cloud-functions/[[default]].js 未提交');
    process.exit(1);
  }
  const actual = readFileSync(ARTIFACT);
  if (!expected.equals(actual)) {
    console.error(
      '✘ 云函数产物已过期：改了 api/ 或 src/ 之后要跑\n' +
        '    node scripts/build-edgeone.mjs\n' +
        '  并把 cloud-functions/[[default]].js 一起提交。',
    );
    process.exit(1);
  }
  console.log('  ✓ 云函数产物与源码一致');
} else {
  console.log('  ✓ cloud-functions/[[default]].js');
}

console.log('✔ EdgeOne 构建完成');
