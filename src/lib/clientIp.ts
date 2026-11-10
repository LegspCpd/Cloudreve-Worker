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

/**
 * 限速桶 id 的 IP 归一化。
 *
 * 非 CF 平台（线上实测 ESA）每次请求的出口 IP 会在同一运营商网段内轮换
 * （IPv6 形如 2404:2280:208:0:3::b / 2404:2280:2fb:0:3::9），用完整 IP
 * 当 key 会让计数永远分散成 hits=1 的新桶，限速形同虚设。
 * IPv4 归到 /24、IPv6 归到 /32；邮箱、分享 id、会话 id 等非 IP 原样返回。
 *
 * 归一后桶更粗，所以 RATE_LIMITS 里按 IP 的阈值同步放大，避免同一出口
 * 下的正常用户互相误伤；目标维度的桶（如 loginByEmail）保持不变。
 */
export function normalizeRateLimitId(id: string): string {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(id)) {
    return `${id.split('.').slice(0, 3).join('.')}.0/24`;
  }
  // 只认纯 hex + 冒号的 IPv6 字面量。分享密码的 id 是 `${shareId}:${ip}`
  // （含点和十进制），不能被误判成 IPv6 而把不同分享混进同一个桶。
  if (/^[0-9a-fA-F:]+$/.test(id) && (id.match(/:/g) ?? []).length >= 2) {
    const parts = id.split(':');
    return `${parts.slice(0, 2).join(':')}::/32`;
  }
  return id;
}
