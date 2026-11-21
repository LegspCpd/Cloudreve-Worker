/**
 * 验签前读取请求正文，并强制大小上限。
 *
 * 上游 issue #3628：签名中间件在校验 HMAC 之前把整个 body 读进内存，
 * 未认证的大请求也能先把内存吃满。关键是**在验签之前**限住 —— 验签失败的
 * 请求同样会走到读正文这一步，所以「验完再限制」没用。
 *
 * 只看 Content-Length 不够：可以伪造，分块传输也未必带这个头。所以流里
 * 也计数，超限立刻 cancel + 抛错。
 */
import { AppError } from './errors';

export async function readBodyLimited(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) {
    throw new AppError(413, `Request body exceeds ${maxBytes} bytes`);
  }

  const reader = req.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    parts.push(value);
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    buf.set(part, off);
    off += part.length;
  }
  // 调用方拿它算 HMAC，必须和 c.req.text() 的 UTF-8 解码结果一致
  return new TextDecoder().decode(buf);
}
