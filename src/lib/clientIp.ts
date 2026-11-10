/**
 * 客户端 IP 的唯一实现。限速桶的 key 直接由它决定，不能让客户端伪造。
 *
 * - CF Workers 会把客户端传来的 `CF-Connecting-IP` 覆盖成真实值，可以直接信。
 * - 非 CF 平台（EdgeOne / ESA）**不注入**这个头，所以入口层会把它剥掉
 *   （`api/makers.ts` / `api/esa.ts`），这里回落到 `X-Forwarded-For`。
 * - XFF 取**最右一段**：那是离服务端最近的可信反代追加的；取首段等于让
 *   客户端自己决定限速桶的 key（每次换一个 IP 就能重置计数）。
 *
 * 曾线上实测：在 EdgeOne / ESA 上每次请求带不同的 `CF-Connecting-IP`，
 * 登录/找回密码/WebDAV 的按 IP 限速全部失效。
 */
export function clientIpFromHeaders(
  header: (name: string) => string | undefined,
): string {
  const cf = header('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = header('X-Forwarded-For');
  if (xff) {
    const parts = xff
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return 'unknown';
}
