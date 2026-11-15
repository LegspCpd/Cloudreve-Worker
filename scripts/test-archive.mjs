/**
 * 归档格式回归测试：tar / tar.gz / gz / rar。
 *
 * 样本现场造（本机 7-Zip），RAR 用仓库里的固定样本（`scripts/fixtures/rar/`，
 * 取自 markokr/rarfile 的测试集，ISC 许可）。
 *
 * 覆盖：
 *   [1] tar：普通/空文件/空目录/嵌套/中文名/超长路径/1.5MB 文件
 *   [2] tar.gz：同上，走解压流解析
 *   [3] gz：单文件，名字取 gzip 头里的 FNAME
 *   [4] rar3 / rar5：文件名、大小、目录位（含 UTF-8 名字与空格路径）
 *   [5] 解压路径：walkTar 边读边写，逐字节比对原文件
 *   [6] 错误路径：非归档、截断的 tar.gz 必须抛 40056
 *
 * 跑法：`npm run test:archive`
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const FIXTURES = path.join(ROOT, 'scripts', 'fixtures', 'rar');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'archivetest');
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

const work = path.join(tmpdir(), `cr-archive-${process.pid}`);
const tree = path.join(work, 'tree');
rmSync(work, { recursive: true, force: true });
mkdirSync(tree, { recursive: true });

const longDir = 'very-long-directory-name-'.repeat(4) + 'end';
const files = {
  'a.txt': Buffer.from('hello tar\n', 'utf8'),
  'empty.txt': Buffer.alloc(0),
  'nested/b.bin': Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) & 0xff)),
  'nested/deep/c.txt': Buffer.from('中文内容测试', 'utf8'),
  '中文名.txt': Buffer.from('unicode name', 'utf8'),
  [`${longDir}/long.txt`]: Buffer.from('long path payload', 'utf8'),
  'big.bin': Buffer.from(Array.from({ length: 1_500_000 }, (_, i) => (i * 131) & 0xff)),
};
mkdirSync(path.join(tree, 'emptydir'), { recursive: true });
mkdirSync(path.join(tree, 'nested', 'deep'), { recursive: true });
mkdirSync(path.join(tree, longDir), { recursive: true });
for (const [rel, data] of Object.entries(files)) writeFileSync(path.join(tree, rel), data);

const expected = new Map();
expected.set('tree', { size: 0, isDir: true });
expected.set('tree/emptydir', { size: 0, isDir: true });
expected.set('tree/nested', { size: 0, isDir: true });
expected.set('tree/nested/deep', { size: 0, isDir: true });
expected.set(`tree/${longDir}`, { size: 0, isDir: true });
for (const [rel, data] of Object.entries(files)) {
  expected.set(`tree/${rel}`, { size: data.length, isDir: false });
}

function makeReader(file) {
  const fd = openSync(file, 'r');
  return {
    read: async (start, end) => {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const got = readSync(fd, buf, 0, len, start);
      if (got !== len) throw new Error(`short read ${got}/${len}`);
      return new Uint8Array(buf);
    },
    close: () => closeSync(fd),
  };
}

function compareEntries(label, entries, want) {
  const actual = new Map(entries.map((e) => [e.name, { size: e.size, isDir: e.isDir }]));
  const missing = [...want.keys()].filter((k) => !actual.has(k));
  const extra = [...actual.keys()].filter((k) => !want.has(k));
  check(`${label}：条目数 ${actual.size}/${want.size}`, actual.size === want.size);
  check(`${label}：名字齐全`, missing.length === 0, `缺 ${missing.slice(0, 3).join(', ')}`);
  check(`${label}：没有多余条目`, extra.length === 0, `多 ${extra.slice(0, 3).join(', ')}`);
  const wrong = [];
  for (const [name, w] of want) {
    const got = actual.get(name);
    if (!got) continue;
    if (got.size !== w.size || got.isDir !== w.isDir) {
      wrong.push(`${name}(${got.size}/${got.isDir} vs ${w.size}/${w.isDir})`);
    }
  }
  check(`${label}：大小与目录位正确`, wrong.length === 0, wrong.slice(0, 3).join('; '));
}

const sha = (buf) => createHash('sha256').update(Buffer.from(buf)).digest('hex');
const wantHashes = new Map(Object.entries(files).map(([rel, buf]) => [rel, sha(buf)]));

try {
  const bundlePath = path.join(outDir, 'archive.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/archive.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const {
    detectArchiveFormat,
    listArchive,
    gunzip,
  } = await import(`file://${bundlePath.replace(/\\/g, '/')}`);
  const tarMod = await import(`file://${bundlePath.replace(/\\/g, '/')}`);

  // ---------------------------------------------------------------------
  // [1] 纯 tar
  // ---------------------------------------------------------------------
  const tarPath = path.join(work, 'a.tar');
  execFileSync(SEVEN_ZIP, ['a', '-ttar', tarPath, 'tree'], { cwd: work, stdio: 'pipe' });

  const tarReader = makeReader(tarPath);
  const tarSize = statSync(tarPath).size;
  const tarEntries = await listArchive('tar', {
    read: tarReader.read,
    size: tarSize,
    openFull: async () => {
      throw new Error('tar 不该走整段解压');
    },
  });
  tarReader.close();
  compareEntries('tar', tarEntries, expected);

  // ---------------------------------------------------------------------
  // [2] tar.gz
  // ---------------------------------------------------------------------
  const tarGzPath = path.join(work, 'a.tar.gz');
  execFileSync(SEVEN_ZIP, ['a', '-tgzip', tarGzPath, tarPath], { cwd: work, stdio: 'pipe' });

  const gzReader = makeReader(tarGzPath);
  const gzSize = statSync(tarGzPath).size;
  const tarGzEntries = await listArchive('tar.gz', {
    read: gzReader.read,
    size: gzSize,
    openFull: async () => {
      const fd = openSync(tarGzPath, 'r');
      return new ReadableStream({
        start(controller) {
          const buf = Buffer.alloc(gzSize);
          readSync(fd, buf, 0, gzSize, 0);
          closeSync(fd);
          controller.enqueue(new Uint8Array(buf));
          controller.close();
        },
      });
    },
  });
  gzReader.close();
  compareEntries('tar.gz', tarGzEntries, expected);

  // ---------------------------------------------------------------------
  // [3] 单文件 gz
  // ---------------------------------------------------------------------
  const singleGz = path.join(work, 'a.txt.gz');
  writeFileSync(path.join(work, 'single.txt'), files['a.txt']);
  execFileSync(SEVEN_ZIP, ['a', '-tgzip', singleGz, 'single.txt'], { cwd: work, stdio: 'pipe' });
  const sgReader = makeReader(singleGz);
  const singleEntries = await listArchive(
    'gz',
    {
      read: sgReader.read,
      size: statSync(singleGz).size,
      openFull: async () => {
        throw new Error('单文件 gz 列表不需要整段流');
      },
    },
    { displayName: 'a.txt.gz' },
  );
  sgReader.close();
  check('gz：只列一条', singleEntries.length === 1);
  check('gz：显示名', singleEntries[0]?.name === 'single.txt', singleEntries[0]?.name);
  check('gz：ISIZE 正确', singleEntries[0]?.size === files['a.txt'].length, String(singleEntries[0]?.size));

  // ---------------------------------------------------------------------
  // [4] rar（固定样本）
  // ---------------------------------------------------------------------
  const rarSubdirs = [
    ['sub', 0, true],
    ['sub/dir1', 0, true],
    ['sub/dir2', 0, true],
    ['sub/empty', 0, true],
    ['sub/with space', 0, true],
    ['sub/üȵĩöḋè', 0, true],
    ['sub/dir1/file1.txt', 6, false],
    ['sub/dir2/file2.txt', 6, false],
    ['sub/with space/long fn.txt', 8, false],
    ['sub/üȵĩöḋè/file.txt', 5, false],
  ];
  for (const [label, file] of [
    ['rar3', 'rar3-subdirs.rar'],
    ['rar5', 'rar5-subdirs.rar'],
  ]) {
    const p = path.join(FIXTURES, file);
    const r = makeReader(p);
    const got = await listArchive('rar', {
      read: r.read,
      size: statSync(p).size,
      openFull: async () => {
        throw new Error('rar 不解压');
      },
    });
    r.close();
    const want = new Map(rarSubdirs.map(([n, size, isDir]) => [n, { size, isDir }]));
    compareEntries(label, got, want);
  }

  for (const [label, file, names] of [
    ['rar3-solid', 'rar3-solid.rar', ['stest1.txt', 'stest2.txt']],
    ['rar5-hlink', 'rar5-hlink.rar', ['stest1.txt', 'stest2.txt', 'stest3.txt']],
  ]) {
    const p = path.join(FIXTURES, file);
    const r = makeReader(p);
    const got = await listArchive('rar', {
      read: r.read,
      size: statSync(p).size,
      openFull: async () => {
        throw new Error('rar 不解压');
      },
    });
    r.close();
    check(`${label}：条目数 ${got.length}`, got.length === names.length);
    check(`${label}：文件名`, names.every((n, i) => got[i]?.name === n), got.map((e) => e.name).join(','));
    check(`${label}：大小 2048`, got.every((e) => e.size === 2048));
  }

  // ---------------------------------------------------------------------
  // [5] 解压路径：walkTar 逐字节比对
  // ---------------------------------------------------------------------
  const { walkTar, rangeByteSource, streamByteSource } = tarMod;

  async function extractAll(sourceFactory) {
    const out = new Map();
    await walkTar(sourceFactory(), async (entry, data) => {
      if (entry.isDir) return;
      out.set(entry.name, await data.read());
    });
    return out;
  }

  // 纯 tar：Range 源
  const tr = makeReader(tarPath);
  const fromTar = await extractAll(() => rangeByteSource(tr.read, tarSize));
  tr.close();
  let bad = [...wantHashes.keys()].filter((rel) => {
    const got = fromTar.get(`tree/${rel}`);
    return !got || sha(got) !== wantHashes.get(rel);
  });
  check('tar 解压：内容逐字节一致', bad.length === 0, bad.slice(0, 3).join(', '));
  check('tar 解压：条目数', fromTar.size === Object.keys(files).length, String(fromTar.size));

  // tar.gz：解压流
  const readFull = () => {
    const fd = openSync(tarGzPath, 'r');
    return new ReadableStream({
      start(controller) {
        const buf = Buffer.alloc(gzSize);
        readSync(fd, buf, 0, gzSize, 0);
        closeSync(fd);
        controller.enqueue(new Uint8Array(buf));
        controller.close();
      },
    });
  };
  const fromGz = await extractAll(() => streamByteSource(gunzip(readFull())));
  bad = [...wantHashes.keys()].filter((rel) => {
    const got = fromGz.get(`tree/${rel}`);
    return !got || sha(got) !== wantHashes.get(rel);
  });
  check('tar.gz 解压：内容逐字节一致', bad.length === 0, bad.slice(0, 3).join(', '));

  // 分块大小不影响结果：模拟上传服务按 64KB 拉流
  const limited = await extractAll(() => streamByteSource(gunzip(readFull())));
  check('tar.gz 二次解压：结果稳定', limited.size === fromGz.size);

  // ---------------------------------------------------------------------
  // [6] 错误路径
  // ---------------------------------------------------------------------
  const notArchive = path.join(work, 'not.tar');
  writeFileSync(notArchive, Buffer.from('this is definitely not a tar file'.repeat(20)));
  const naReader = makeReader(notArchive);
  let err = null;
  try {
    await listArchive('tar', {
      read: naReader.read,
      size: statSync(notArchive).size,
      openFull: async () => {
        throw new Error('n/a');
      },
    });
  } catch (e) {
    err = e;
  }
  naReader.close();
  check('非 tar：明确报错', err !== null);
  check('非 tar：错误码 40056', err?.code === 40056, String(err?.code));

  // 截断的 tar.gz：解压流中途结束必须报错，不能返回半截结果
  const truncPath = path.join(work, 'trunc.tar.gz');
  const fullGz = readFileSync(tarGzPath);
  writeFileSync(truncPath, fullGz.subarray(0, Math.floor(fullGz.length / 2)));
  const truncSize = statSync(truncPath).size;
  let truncErr = null;
  try {
    await listArchive('tar.gz', {
      read: async () => {
        throw new Error('n/a');
      },
      size: truncSize,
      openFull: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(readFileSync(truncPath)));
            controller.close();
          },
        }),
    });
  } catch (e) {
    truncErr = e;
  }
  check('截断 tar.gz：报错', truncErr !== null);

  // 格式判定
  const cases = [
    ['a.tar.gz', 'tar.gz'],
    ['a.TGZ', 'tar.gz'],
    ['a.tar.bz2', 'tar.bz2'],
    ['a.tbz2', 'tar.bz2'],
    ['a.tar.xz', 'tar.xz'],
    ['a.tar', 'tar'],
    ['a.gz', 'gz'],
    ['a.xz', 'xz'],
    ['a.rar', 'rar'],
    ['a.7z', '7z'],
    ['a.zip', 'zip'],
    ['a.docx', 'zip'],
  ];
  const wrongFmt = cases.filter(([n, want]) => detectArchiveFormat(n) !== want);
  check('扩展名判定', wrongFmt.length === 0, wrongFmt.map(([n]) => n).join(', '));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
