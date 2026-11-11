/**
 * 文件客户端加密的对称原语（AES-256-CTR）。
 *
 * 与上游前端 `component/Uploader/core/uploader/encrypt/blob.ts` 的 EncryptedBlob
 * 完全对称：
 *   - 密钥由服务端生成（每文件随机 32 字节），IV 16 字节；
 *   - 加密按“块”推进计数器（每 16 字节 +1），与前端一致；
 *   - 由于 AES-CTR 的密钥流只取决于「counter_base + floor(offset/16)」，
 *     与分片边界无关，所以上传端按分片加密、下载端按任意流块解密都能对齐。
 *
 * 这里只处理「从对象起点」的加解密（offset 0）；Range 请求由调用方先解全量再切片。
 */
import { EncryptionCipher, type EncryptMetadata } from '../db/types';
import { base64ToBytes, bytesToBase64 } from './crypto';

/**
 * 站点级「文件密钥主密钥」。
 *
 * 优先读部署环境变量 ENCRYPTION_MASTER_KEY（不入库）。没配时回落到站点
 * secret_key 派生 —— 至少不再把每文件 AES 密钥明文摊在库里，但要真正
 * 做到「库泄露 ≠ 文件泄露」必须配这个独立变量。
 *
 * ⚠️ 主密钥必须长期固定：换 ENCRYPTION_MASTER_KEY（或依赖的 secret_key）
 * 会让已经 wrap 过的历史文件解不开。轮换前得先用旧密钥批量重加密。
 */
export async function deriveFileMasterKey(
  env: { ENCRYPTION_MASTER_KEY?: string },
  fallbackSecret: string,
): Promise<CryptoKey> {
  const master = env.ENCRYPTION_MASTER_KEY?.trim() || fallbackSecret;
  if (!master) throw new Error('Encryption master key is unavailable');
  // 刻意不用 HKDF：CF Workers / ESA 的 WebCrypto 对 deriveKey(HKDF) 支持
  // 不一致，而 digest(SHA-256) + importKey(AES-GCM) 是所有实现必有的。
  // 加固定域分隔前缀，避免与别的用途派生出同一把密钥。
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode('cloudreve-edge/file-key/v1:' + master),
  );
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** 把明文文件密钥信封加密成可落库的形态。 */
export async function wrapEncryptMetadata(
  meta: EncryptMetadata,
  masterKey: CryptoKey,
): Promise<EncryptMetadata> {
  if (meta.key_wrapped) return meta;
  if (!meta.key_plain_text) throw new Error('Missing file encryption key');
  const wrapIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIv }, masterKey, base64ToBytes(meta.key_plain_text),
  );
  return {
    algorithm: meta.algorithm,
    iv: meta.iv,
    key_wrapped: bytesToBase64(new Uint8Array(wrapped)),
    wrap_iv: bytesToBase64(wrapIv),
    wrap_version: 1,
  };
}

/** 解开信封，还原成含 key_plain_text 的元数据（仅内存中使用）。 */
export async function unwrapEncryptMetadata(
  meta: EncryptMetadata,
  masterKey: CryptoKey,
): Promise<EncryptMetadata> {
  if (!meta.key_wrapped || !meta.wrap_iv) {
    throw new Error('Corrupted wrapped encryption metadata');
  }
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(meta.wrap_iv) },
    masterKey,
    base64ToBytes(meta.key_wrapped),
  );
  return {
    algorithm: meta.algorithm,
    iv: meta.iv,
    key_plain_text: bytesToBase64(new Uint8Array(plain)),
  };
}

/** AES-CTR 计数器按块递增（16 字节大端）。 */
export function incrementCounter(
  counter: Uint8Array<ArrayBuffer>,
  blocks: number,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(counter);
  let carry = blocks;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const sum = out[i] + carry;
    out[i] = sum & 0xff;
    carry = sum >>> 8;
  }
  return out;
}

/** 生成一份随机的每文件加密元数据。 */
export function randomEncryptMetadata(): EncryptMetadata {
  const keyBytes = new Uint8Array(32);
  const ivBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  crypto.getRandomValues(ivBytes);
  return {
    algorithm: EncryptionCipher.Aes256Ctr,
    key_plain_text: bytesToBase64(keyBytes),
    iv: bytesToBase64(ivBytes),
  };
}

/** 校验并导入 AES-CTR 密钥。 */
export async function importCtrKey(
  meta: EncryptMetadata,
  usage: 'encrypt' | 'decrypt',
  masterKey?: CryptoKey,
): Promise<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer> }> {
  if (meta.algorithm !== EncryptionCipher.Aes256Ctr) {
    throw new Error(`Unsupported encryption algorithm: ${meta.algorithm}`);
  }
  // 历史记录是 key_plain_text；新记录落库前已信封加密，读时解封。
  // 解封需要主密钥，缺了就明确报错，绝不退回「拿密文当密钥」。
  let effective = meta;
  if (meta.key_wrapped) {
    if (!masterKey) throw new Error('Wrapped file key requires the encryption master key');
    effective = await unwrapEncryptMetadata(meta, masterKey);
  }
  const keyBytes = base64ToBytes(effective.key_plain_text ?? '');
  const iv = base64ToBytes(meta.iv);
  if (keyBytes.byteLength !== 32 || iv.byteLength !== 16) {
    throw new Error('Corrupted encryption metadata');
  }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CTR' }, false, [usage]);
  return { key, iv };
}

/** 拼接两段字节（保证结果有独立 ArrayBuffer，可直接交给 Web Crypto）。 */
function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

/**
 * AES-CTR 的密钥流按 16 字节块推进，**每次 crypto.subtle 调用都必须从块边界开始**，
 * 否则块内偏移会错位（上游 EncryptedBlob 的 partial-block 处理就是为此存在）。
 * 上传时前端按 chunk_size（恒为 16 的倍数）切片，密文等价于单流 AES-CTR；
 * 下载时 HTTP 流的块边界任意，所以这里把不足 16 字节的尾巴缓冲到下一次，
 * 保证每次调用的起点都是块边界。尾部不足一块时由 Web Crypto 按部分块处理。
 */
function transformBlocks(
  body: ReadableStream<Uint8Array>,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
  mode: 'encrypt' | 'decrypt',
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let counter: Uint8Array<ArrayBuffer> = new Uint8Array(iv);
  let carry: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  const run = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
    const algorithm = { name: 'AES-CTR', counter, length: 128 } as const;
    const out =
      mode === 'encrypt'
        ? await crypto.subtle.encrypt(algorithm, key, data)
        : await crypto.subtle.decrypt(algorithm, key, data);
    return new Uint8Array(out);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          if (carry.byteLength > 0) {
            // 最后一段不足 16 字节：Web Crypto 会按部分块产出对应字节
            controller.enqueue(await run(carry));
            carry = new Uint8Array(0);
          }
          controller.close();
          return;
        }
        const src = value instanceof Uint8Array ? value : new Uint8Array(value);
        const data = concatBytes(carry, src);
        const aligned = data.byteLength - (data.byteLength % 16);
        if (aligned === 0) {
          // 还凑不满一个块，继续读
          carry = data;
          continue;
        }
        const blocks = data.slice(0, aligned);
        controller.enqueue(await run(blocks));
        counter = incrementCounter(counter, aligned / 16);
        carry = data.slice(aligned);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** 把明文流加密成密文流（从对象起点，counter 从 IV 开始）。 */
export function encryptStream(
  body: ReadableStream<Uint8Array>,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array> {
  return transformBlocks(body, key, iv, 'encrypt');
}

/** 把密文流解密成明文流（从对象起点，counter 从 IV 开始）。 */
export function decryptStream(
  body: ReadableStream<Uint8Array>,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
): ReadableStream<Uint8Array> {
  return transformBlocks(body, key, iv, 'decrypt');
}

/** 把整段密文一次性解密（Range 请求用）。 */
export async function decryptFull(
  body: ReadableStream<Uint8Array>,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const buf = await new Response(body).arrayBuffer();
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: new Uint8Array(iv), length: 128 },
    key,
    buf,
  );
  return new Uint8Array(plain);
}
