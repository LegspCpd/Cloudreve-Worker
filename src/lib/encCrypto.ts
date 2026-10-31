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
): Promise<{ key: CryptoKey; iv: Uint8Array<ArrayBuffer> }> {
  if (meta.algorithm !== EncryptionCipher.Aes256Ctr) {
    throw new Error(`Unsupported encryption algorithm: ${meta.algorithm}`);
  }
  const keyBytes = base64ToBytes(meta.key_plain_text);
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
