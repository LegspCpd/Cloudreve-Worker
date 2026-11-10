/**
 * 组装 EdgeOne 自包含部署目录（edgeone-publish/）。
 *
 * 用途：
 *   - CI 的 edgeone-build job 跑完构建后调用，产物上传 artifact 留存；
 *   - 也可手动 `npx edgeone makers deploy ./edgeone-publish -n <项目> -t <token>`。
 *
 * 目录结构（对齐官方 CLI 的「手动构建」要求：静态 + Functions + 配置）：
 *   edgeone-publish/index.html, assets/, static/...   ← dist/ 的静态产物
 *   edgeone-publish/cloud-functions/[[default]].js    ← Node 云函数 bundle
 *   edgeone-publish/edgeone.json                     ← 平台配置（去掉构建字段）
 *   edgeone-publish/package.json                     ← 最小清单（bundle 无外部依赖）
 *
 * ⚠️ 去掉 buildCommand / installCommand / nodeVersion：这是已构建好的产物，
 *    留着会让 CLI 在产物目录里再跑一次构建（那里没有 scripts/ 和依赖，必失败）。
 *    rewrites / headers / cloudFunctions / schedules 这些平台配置必须保留。
 *    _headers 是 CF assets 的静态头约定，EdgeOne 用 edgeone.json 的 headers，
 *    不拷过去以免被当静态文件公开。
 */
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const FUNCTIONS = path.join(ROOT, 'cloud-functions');
const OUT = path.join(ROOT, 'edgeone-publish');

const required = [
  [path.join(DIST, 'index.html'), '前端 index.html'],
  [path.join(FUNCTIONS, '[[default]].js'), '云函数 bundle'],
  [path.join(ROOT, 'edgeone.json'), 'edgeone.json'],
];
for (const [p, label] of required) {
  if (!existsSync(p)) {
    console.error(`✘ 缺少${label}：${p}\n  先跑 node scripts/build-edgeone.mjs`);
    process.exit(1);
  }
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 1. 静态产物（排除 CF 专用的 _headers）
for (const entry of (await import('node:fs')).readdirSync(DIST)) {
  if (entry === '_headers') continue;
  cpSync(path.join(DIST, entry), path.join(OUT, entry), { recursive: true });
}

// 2. 云函数
cpSync(FUNCTIONS, path.join(OUT, 'cloud-functions'), { recursive: true });

// 3. 平台配置（去掉构建期字段）
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'edgeone.json'), 'utf8'));
delete cfg.buildCommand;
delete cfg.installCommand;
delete cfg.nodeVersion;
delete cfg.outputDirectory; // 手动构建目录下静态就在根，交给 CLI 默认
writeFileSync(path.join(OUT, 'edgeone.json'), JSON.stringify(cfg, null, 2) + '\n');

// 4. 最小 package.json（bundle 已内联全部依赖）
writeFileSync(
  path.join(OUT, 'package.json'),
  JSON.stringify({ name: 'cloudreve-edge', private: true, type: 'module' }, null, 2) + '\n',
);

const bundleBytes = readFileSync(path.join(OUT, 'cloud-functions', '[[default]].js')).length;
console.log(`✔ edgeone-publish/ 就绪（云函数 ${(bundleBytes / 1024).toFixed(0)} KiB）`);
console.log('  静态：', (await import('node:fs')).readdirSync(OUT).join(', '));
