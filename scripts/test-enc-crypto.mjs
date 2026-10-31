/**
 * 文件加密原语的单元测试（`src/lib/encCrypto.ts`）。
 *
 * 重点验证与上游前端 `EncryptedBlob` 的兼容性：
 *   1. 服务端生成的元数据可被 AES-256-CTR 正确使用；
 *   2. 前端按 chunk_size（16 的倍数）分片加密，等价于单流 AES-CTR；
 *   3. 后端按任意块边界流式解密（不足 16 字节缓冲）能还原明文；
 *   4. Range 路径的整段解密（decryptFull）能还原。
 *
 * 跑法：`npm run test:enc`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'enccryptotest');
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

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function inc(counter, blocks) {
  const out = new Uint8Array(counter);
  let carry = blocks;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const s = out[i] + carry;
    out[i] = s & 0xff;
    carry = s >>> 8;
  }
  return out;
}

/** 把字节按指定块大小序列转成 ReadableStream（模拟 HTTP 流的任意分块）。 */
function streamOf(bytes, sizes) {
  let off = 0;
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (off >= bytes.byteLength) {
        controller.close();
        return;
      }
      const size = sizes[i % sizes.length];
      const end = Math.min(off + size, bytes.byteLength);
      controller.enqueue(bytes.slice(off, end));
      off = end;
      i += 1;
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts.reduce((acc, p) => concat(acc, p), new Uint8Array(0));
}

const plainBytes = new Uint8Array(100003);
for (let i = 0; i < plainBytes.byteLength; i += 1) plainBytes[i] = (i * 31 + 7) & 0xff;

try {
  const bundlePath = path.join(outDir, 'encCrypto.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/encCrypto.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const {
    randomEncryptMetadata,
    importCtrKey,
    encryptStream,
    decryptStream,
    decryptFull,
  } = await import(`file://${bundlePath}`);

  console.log('\n[1] 元数据形态');
  const meta = randomEncryptMetadata();
  check('算法为 aes-256-ctr', meta.algorithm === 'aes-256-ctr', meta.algorithm);
  check('key 为 32 字节 base64', atob(meta.key_plain_text).length === 32, String(atob(meta.key_plain_text).length));
  check('iv 为 16 字节 base64', atob(meta.iv).length === 16, String(atob(meta.iv).length));

  console.log('\n[2] 前端块对齐分片加密 == 单流 AES-CTR');
  const { key: encKey, iv: encIv } = await importCtrKey(meta, 'encrypt');
  // 单流加密
  const single = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-CTR', counter: encIv, length: 128 }, encKey, plainBytes),
  );
  // 按 16 倍数分片加密（chunk_size=4096）
  let off = 0;
  let counter = new Uint8Array(encIv);
  const aligned = [];
  while (off < plainBytes.byteLength) {
    const end = Math.min(off + 4096, plainBytes.byteLength);
    const c = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-CTR', counter, length: 128 },
        encKey,
        plainBytes.slice(off, end),
      ),
    );
    aligned.push(c);
    counter = inc(counter, Math.ceil((end - off) / 16));
    off = end;
  }
  const alignedBytes = aligned.reduce((acc, p) => concat(acc, p), new Uint8Array(0));
  check('两者字节一致', Buffer.from(single).equals(Buffer.from(alignedBytes)));

  console.log('\n[3] 任意块边界流式解密还原');
  const { key: decKey, iv: decIv } = await importCtrKey(meta, 'decrypt');
  const weirdSizes = [1, 7, 15, 16, 17, 1000, 333, 4095, 2, 8191];
  const dec1 = await collect(decryptStream(streamOf(single, weirdSizes), decKey, decIv));
  check('单流密文 → 明文', Buffer.from(dec1).equals(Buffer.from(plainBytes)));
  const dec2 = await collect(decryptStream(streamOf(alignedBytes, weirdSizes), decKey, decIv));
  check('分片密文 → 明文', Buffer.from(dec2).equals(Buffer.from(plainBytes)));

  console.log('\n[4] encryptStream 与 decryptStream 互逆');
  const encKey2 = await importCtrKey(meta, 'encrypt');
  const cipher2 = await collect(encryptStream(streamOf(plainBytes, [3, 500, 17, 4096]), encKey2.key, encKey2.iv));
  const decKey2 = await importCtrKey(meta, 'decrypt');
  const dec3 = await collect(decryptStream(streamOf(cipher2, [9, 1024, 5]), decKey2.key, decKey2.iv));
  check('往返一致', Buffer.from(dec3).equals(Buffer.from(plainBytes)));
  check('密文长度不变（CTR 不扩展）', cipher2.byteLength === plainBytes.byteLength);

  console.log('\n[5] Range 路径整段解密（decryptFull）');
  const decKey3 = await importCtrKey(meta, 'decrypt');
  const full = await decryptFull(streamOf(single, [777, 4096, 31]), decKey3.key, decKey3.iv);
  check('decryptFull 还原', Buffer.from(full).equals(Buffer.from(plainBytes)));

  console.log('\n[6] 损坏的元数据被拒绝');
  let rejected = false;
  try {
    await importCtrKey({ ...meta, key_plain_text: btoa('short') }, 'decrypt');
  } catch {
    rejected = true;
  }
  check('短密钥被拒绝', rejected);
} catch (e) {
  failed += 1;
  console.error('  ERROR', e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
