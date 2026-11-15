/**
 * 7z 目录解析回归测试。
 *
 * 用真实的 7-Zip（`C:\Program Files\7-Zip\7z.exe`）现场生成各种配置的
 * 归档，再让 `src/lib/sevenzip.ts` 解析，逐项比对文件名/大小/目录位/时间。
 * 只做浏览（文件表）验证，不涉及解压。
 *
 * 覆盖的归档配置：
 *   [1] 默认（LZMA + 压缩头 + solid）
 *   [2] LZMA2
 *   [3] 未压缩头（-mhc=off）
 *   [4] store（-mx=0，copy 编码器）
 *   [5] 非 solid（-ms=off，每个文件一个 folder）
 *   [6] 加密头（-p -mhe=on）→ 必须明确报错
 *   [7] 不是 7z 的文件 → 必须报「不是 7z」
 *
 * 跑法：`npm run test:7z`
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEVEN_ZIP = 'C:/Program Files/7-Zip/7z.exe';
const outDir = path.join(ROOT, 'node_modules', '.cache', 'seventest');
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

// ---------------------------------------------------------------------------
// 准备一棵有代表性的目录树：普通文件、空文件、嵌套目录、空目录、中文名
// ---------------------------------------------------------------------------
const work = path.join(tmpdir(), `cr-7z-${process.pid}`);
const tree = path.join(work, 'tree');
rmSync(work, { recursive: true, force: true });
mkdirSync(path.join(tree, 'sub', 'deep'), { recursive: true });
mkdirSync(path.join(tree, 'emptydir'), { recursive: true });

const files = {
  'a.txt': Buffer.from('hello 7z\n', 'utf8'),
  'empty.txt': Buffer.alloc(0),
  'sub/b.bin': Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 37) & 0xff)),
  'sub/deep/c.txt': Buffer.from('中文内容测试', 'utf8'),
  '中文名.txt': Buffer.from('unicode name', 'utf8'),
};
for (const [rel, data] of Object.entries(files)) {
  writeFileSync(path.join(tree, rel), data);
}

/** 期望的条目集合（名字带 `tree/` 前缀，与 7z 存的一致）。 */
const expected = new Map();
expected.set('tree', { size: 0, isDir: true });
expected.set('tree/emptydir', { size: 0, isDir: true });
expected.set('tree/sub', { size: 0, isDir: true });
expected.set('tree/sub/deep', { size: 0, isDir: true });
for (const [rel, data] of Object.entries(files)) {
  expected.set(`tree/${rel}`, { size: data.length, isDir: false });
}

function makeReader(file) {
  const fd = openSync(file, 'r');
  return {
    read: async (start, end) => {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return new Uint8Array(buf);
    },
    close: () => closeSync(fd),
  };
}

function createArchive(name, extraArgs) {
  const out = path.join(work, name);
  execFileSync(SEVEN_ZIP, ['a', '-t7z', out, 'tree', ...extraArgs], {
    cwd: work,
    stdio: 'pipe',
  });
  return out;
}

try {
  const bundlePath = path.join(outDir, 'sevenzip.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/sevenzip.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { readSevenZipDirectory } = await import(`file://${bundlePath.replace(/\\/g, '/')}`);

  const cases = [
    ['默认 LZMA + 压缩头 + solid', 'default.7z', []],
    ['LZMA2', 'lzma2.7z', ['-m0=LZMA2']],
    ['未压缩头', 'hcoff.7z', ['-mhc=off']],
    ['store（copy）', 'store.7z', ['-mx=0']],
    ['非 solid', 'nonsolid.7z', ['-ms=off']],
  ];

  for (const [label, name, args] of cases) {
    const archive = createArchive(name, args);
    const reader = makeReader(archive);
    let entries;
    let err = null;
    try {
      entries = await readSevenZipDirectory(reader.read, statSync(archive).size);
    } catch (e) {
      err = e;
    }
    reader.close();
    check(`${label}：解析不抛错`, err === null, err ? String(err.message ?? err) : '');
    if (err) continue;

    const actual = new Map(entries.map((e) => [e.name, { size: e.size, isDir: e.isDir }]));
    const missing = [...expected.keys()].filter((k) => !actual.has(k));
    const extra = [...actual.keys()].filter((k) => !expected.has(k));
    check(`${label}：条目数 ${actual.size}`, actual.size === expected.size, `期望 ${expected.size}`);
    check(`${label}：名字齐全`, missing.length === 0, `缺 ${missing.join(', ')}`);
    check(`${label}：没有多余条目`, extra.length === 0, `多 ${extra.join(', ')}`);

    const bad = [];
    for (const [name2, want] of expected) {
      const got = actual.get(name2);
      if (!got) continue;
      if (got.size !== want.size || got.isDir !== want.isDir) {
        bad.push(`${name2}: got ${got.isDir ? 'dir' : got.size + 'B'} want ${want.isDir ? 'dir' : want.size + 'B'}`);
      }
    }
    check(`${label}：大小与目录位正确`, bad.length === 0, bad.slice(0, 3).join(' | '));

    // 修改时间：a.txt 取文件系统的 mtime
    const aEntry = entries.find((e) => e.name === 'tree/a.txt');
    const wantMs = statSync(path.join(tree, 'a.txt')).mtimeMs;
    check(
      `${label}：mtime 还原`,
      aEntry != null && Math.abs(aEntry.mtime.getTime() - wantMs) < 3000,
      aEntry ? `${aEntry.mtime.toISOString()} vs ${new Date(wantMs).toISOString()}` : 'missing',
    );
  }

  // 加密头：文件名也被加密，无法解析 → 必须报错而不是静默返回空
  {
    const enc = createArchive('enc.7z', ['-pSECRET123', '-mhe=on']);
    const reader = makeReader(enc);
    let err = null;
    try {
      await readSevenZipDirectory(reader.read, statSync(enc).size);
    } catch (e) {
      err = e;
    }
    reader.close();
    check('加密 7z：明确报错', err !== null, '没有抛错');
    check('加密 7z：错误码是 40056', err && err.code === 40056, err ? String(err.code) : '');
  }

  // 不是 7z：喂一个 zip 进去
  {
    const zipPath = path.join(work, 'fake.7z');
    writeFileSync(zipPath, Buffer.from('PK\x03\x04 this is not a 7z archive', 'binary'));
    const reader = makeReader(zipPath);
    let err = null;
    try {
      await readSevenZipDirectory(reader.read, statSync(zipPath).size);
    } catch (e) {
      err = e;
    }
    reader.close();
    check('非 7z：明确报错', err !== null, '没有抛错');
    check('非 7z：错误码是 40056', err && err.code === 40056, err ? String(err.code) : '');
  }

  // 大文件表：300 个长名字文件，压缩后的文件表更大，能压到 LZMA 的长匹配/距离分支
  {
    const manyRoot = path.join(work, 'many');
    mkdirSync(manyRoot, { recursive: true });
    const manyExpected = new Map();
    manyExpected.set('many', { size: 0, isDir: true });
    for (let i = 0; i < 300; i += 1) {
      const rel = `dir-${String(i).padStart(3, '0')}/文件-${String(i).padStart(4, '0')}-long-name-sample.bin`;
      mkdirSync(path.join(manyRoot, path.dirname(rel)), { recursive: true });
      const size = (i * 97) % 5000;
      writeFileSync(path.join(manyRoot, rel), Buffer.alloc(size, i & 0xff));
      manyExpected.set(`many/${path.dirname(rel)}`, { size: 0, isDir: true });
      manyExpected.set(`many/${rel}`, { size, isDir: false });
    }
    const archive = path.join(work, 'many.7z');
    execFileSync(SEVEN_ZIP, ['a', '-t7z', archive, 'many'], { cwd: work, stdio: 'pipe' });
    const reader = makeReader(archive);
    let entries = null;
    let err = null;
    try {
      entries = await readSevenZipDirectory(reader.read, statSync(archive).size);
    } catch (e) {
      err = e;
    }
    reader.close();
    check('300 文件：解析不抛错', err === null, err ? String(err.message ?? err) : '');
    if (entries) {
      const actual = new Map(entries.map((e) => [e.name, { size: e.size, isDir: e.isDir }]));
      check('300 文件：条目数一致', actual.size === manyExpected.size, `期望 ${manyExpected.size}，得 ${actual.size}`);
      const bad = [];
      for (const [name2, want] of manyExpected) {
        const got = actual.get(name2);
        if (!got || got.size !== want.size || got.isDir !== want.isDir) bad.push(name2);
      }
      check('300 文件：全部大小/目录位正确', bad.length === 0, `${bad.length} 项不符，如 ${bad[0] ?? ''}`);
    }
  }

  // 截断：把正常归档砍掉一半，必须报错而不是返回残缺列表
  {
    const full = createArchive('trunc-src.7z', []);
    const buf = readFileSync(full);
    const cut = path.join(work, 'trunc.7z');
    writeFileSync(cut, buf.subarray(0, Math.floor(buf.length / 2)));
    const reader = makeReader(cut);
    let err = null;
    try {
      await readSevenZipDirectory(reader.read, statSync(cut).size);
    } catch (e) {
      err = e;
    }
    reader.close();
    check('截断文件：明确报错', err !== null, '静默返回了结果');
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
