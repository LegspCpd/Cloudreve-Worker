/**
 * 验签/限速前读取请求正文，并强制大小上限。
 *
 * 上游 issue #3628 与 c5cd939d：签名中间件在校验 HMAC 之前把整个 body 读进
 * 内存，未认证的大请求也能先把内存吃满。关键是**在验签之前**限住 —— 验签
 * 失败的请求同样会走到读正文这一步，所以「验完再限制」没用。
 *
 * 只看 Content-Length 不够：可以伪造，分块传输也未必带这个头。所以流里
 * 也计数，超限立刻 cancel + 抛错。
 *
 * CF Workers 单 isolate 128MB，域名层允许 100MB 请求体 —— 平台硬顶挡不住
 * 大 JSON 把 isolate 打爆。登录/注册/支付通知这些匿名端点尤其要在限速、
 * 验签之前限住，否则限速形同虚设。
 */
import { AppError } from './errors';

function tooLarge(maxBytes: number): AppError {
  return new AppError(413, `Request body exceeds ${maxBytes} bytes`);
}

/** 读正文字节，流内计数，超限即 cancel。所有受限封装共用这一层。 */
export async function readBytesLimited(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) throw tooLarge(maxBytes);

  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    parts.push(value);
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    buf.set(part, off);
    off += part.length;
  }
  return buf;
}

/** 读受限正文为字符串。HMAC 场景要和 c.req.text() 的 UTF-8 解码一致。 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBytesLimited(req, maxBytes));
}

/**
 * 受限读 JSON。解析失败按空对象处理，和 `c.req.json().catch(() => ({}))`
 * 的行为保持一致，调用方不需要改参数校验逻辑。
 */
export async function readJsonLimited<T = Record<string, unknown>>(
  req: Request,
  maxBytes: number,
): Promise<T> {
  const text = await readBodyLimited(req, maxBytes);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

/**
 * 受限读表单。用受限字节重建 Request 再交给 formData()，这样
 * urlencoded 和 multipart 都支持，也不会无上限物化。OAuth token 端点
 * 走这条，参数量很小，16KB 足够。
 */
export async function readFormLimited(req: Request, maxBytes: number): Promise<FormData> {
  const buf = await readBytesLimited(req, maxBytes);
  const headers = new Headers();
  const ct = req.headers.get('Content-Type');
  if (ct) headers.set('Content-Type', ct);
  return new Request('http://localhost/', {
    method: 'POST',
    headers,
    body: buf.buffer as ArrayBuffer,
  }).formData();
}
