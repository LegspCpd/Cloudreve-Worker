/**
 * 阿里云 ESA（函数和 Pages）构建脚本。
 *
 * 产物两块：
 *   1. `dist/`            —— 前端静态目录（esa.jsonc 的 assets.directory）。
 *   2. `dist-server/esa.js` —— 函数入口 bundle（esa.jsonc 的 entry）。
 *      ⚠️ 不能放进 dist/：那是静态托管目录，放进去会被当静态文件公开下载。
 *
 * 与 EdgeOne 打包的关键差异（ESA 是 V8 isolate + 部分 Node APIs，不是完整
 * Node 运行时）：
 *   - platform=browser + worker/browser 条件：让 Neon 走 HTTP fetch 版；
 *   - `node:*` 保持 external，交给 ESA 运行时（支持 async_hooks / buffer /
 *     crypto / stream 等，不支持 net / tls）；
 *   - `cloudflare:sockets` → ESA socket-stub（无 TCP socket，SMTP 明确报错）；
 *   - `postgres` → ESA postgres-stub（无线协议驱动，统一 Neon HTTP）；
 *   - `.sql` 以文本内联（迁移文本随 bundle 走）。
 *
 * ESA 函数代码包上限 4MB（官方限制），构建后校验体积。
 * SPA 导航路由由 esa.jsonc 的 notFoundStrategy 处理，不需要内联 index.html。
 */
import esbuild from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BUNDLE_BYTES = 4 * 1024 * 1024; // ESA 官方：每个函数 JS 代码 4MB

// ---- 1. 前端产物 ------------------------------------------------------------
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

// ---- 2. dist/（静态托管目录）------------------------------------------------
console.log('▶ [2/3] 组装 dist/（assets.directory）…');
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

// ---- 3. 函数 bundle ---------------------------------------------------------
console.log('▶ [3/3] 打包 ESA 函数入口…');
const outfile = path.join(ROOT, 'dist-server', 'esa.js');
mkdirSync(path.dirname(outfile), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(ROOT, 'api', 'esa.ts')],
  bundle: true,
  platform: 'browser',
  mainFields: ['browser', 'module', 'main'],
  conditions: ['worker', 'browser'],
  format: 'esm',
  target: 'es2022',
  minify: true,
  outfile,
  loader: { '.sql': 'text' },
  // ⚠️ 用 onResolve 插件而不是 alias：实测 alias 对 `postgres` bare import
  // 没能完全拦住（产物里仍混进了 postgres.js 的 TCP/WebSocket 代码），
  // 交给 onResolve 精确匹配，连子路径一起拦。
  plugins: [
    {
      name: 'esa-runtime-stubs',
      setup(build) {
        build.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({
          path: path.join(ROOT, 'src', 'esa', 'socket-stub.ts'),
        }));
        build.onResolve({ filter: /^postgres(\/.*)?$/ }, () => ({
          path: path.join(ROOT, 'src', 'esa', 'postgres-stub.ts'),
        }));
      },
    },
  ],
  // node: 内置模块由 ESA 运行时提供（仅它支持的那一批会被实际引用）
  external: ['node:*'],
  logLevel: 'silent',
});

const bytes = readFileSync(outfile).length;
console.log(`  ✓ dist-server/esa.js（${(bytes / 1024).toFixed(0)} KiB）`);
if (bytes > MAX_BUNDLE_BYTES) {
  console.error(`✘ bundle 超过 ESA 的 4MB 代码包上限：${bytes} bytes`);
  process.exit(1);
}
console.log('✔ ESA 构建完成');
