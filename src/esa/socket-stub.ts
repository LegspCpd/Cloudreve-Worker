/**
 * ESA 专用：`cloudflare:sockets` 的占位实现。
 *
 * ESA 运行时没有 TCP socket API（Node APIs 清单里没有 net/tls），
 * SMTP 直连发信在这套部署形态下不可用。构建期把 `cloudflare:sockets`
 * alias 到这里，调用时给明确错误，而不是让 esbuild 在解析阶段就失败。
 */
export function connect(): never {
  throw new Error(
    'SMTP TCP sockets are not available on Alibaba Cloud ESA (no net/tls runtime APIs). ' +
      'Mail delivery is disabled for this deployment.',
  );
}
