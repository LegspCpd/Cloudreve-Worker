/**
 * RFC 6266 规范的 Content-Disposition: attachment 值。
 * 对齐上游 entitysource.go:296-305：纯 ASCII 文件名用简单形式；
 * 含非 ASCII 时同时给 filename*（UTF-8 百分号编码）。
 */

/**
 * 按 RFC 5987 编码 `filename*` 的值。
 *
 * `encodeURIComponent` 会保留 `!'()*~-_.`，其中 `'` `(` `)` `*` **不在**
 * attr-char 允许集里 —— 尤其 `'` 是 `filename*=UTF-8''<value>` 的分隔符，
 * 留在值里会让整段产生歧义（`报告(1).pdf` 这类名字很常见）。额外编码这四个。
 */
function encodeExtValue(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * 内容响应的安全类型归一。
 *
 * 存储后端返回的 Content-Type 来自**上传时客户端声明**（S3/OneDrive 都存这份
 * 元数据），用户可以传一个 `.html` 然后声明 `text/html`，或者直接传 SVG。
 * 本站内容端点是同源直出，浏览器会**渲染并执行**里面的脚本 —— 存储型 XSS，
 * 能读站点 cookie / 调管理接口。
 *
 * 处理：
 *   - HTML / JS / XHTML / XML 一律按纯文本返回，并把 Content-Disposition 设成
 *     attachment（下载而不是在页面里渲染）。
 *   - SVG 保留 image/svg+xml（<img> 预览要靠它），但附 `CSP: sandbox`，
 *     直接导航打开时脚本被隔离，拿不到本站上下文。
 *
 * 返回值里 `forceAttachment` 为真时调用方必须补 Content-Disposition。
 */
export function safeContentType(raw: string | undefined, name: string): {
  contentType: string;
  forceAttachment: boolean;
  extraHeaders: Record<string, string>;
} {
  const ct = (raw ?? 'application/octet-stream').toLowerCase();
  const ext = (name.split('.').pop() ?? '').toLowerCase();

  const executable =
    ct.includes('text/html') ||
    ct.includes('application/xhtml') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ext === 'html' ||
    ext === 'htm' ||
    ext === 'shtml' ||
    ext === 'xhtml' ||
    ext === 'js' ||
    ext === 'mjs';

  if (executable) {
    return {
      contentType: 'text/plain; charset=utf-8',
      forceAttachment: true,
      extraHeaders: { 'X-Content-Type-Options': 'nosniff' },
    };
  }

  if (ct.includes('svg') || ext === 'svg' || ext === 'svgz') {
    return {
      contentType: 'image/svg+xml',
      forceAttachment: false,
      // sandbox 让 SVG 在自己的隔离源里跑：图片照常显示，脚本动不了本站
      extraHeaders: { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" },
    };
  }

  return {
    contentType: raw ?? 'application/octet-stream',
    forceAttachment: false,
    extraHeaders: { 'X-Content-Type-Options': 'nosniff' },
  };
}

export function attachmentDisposition(displayName: string): string {
  // 非可打印 ASCII、引号、反斜杠一律打成 `_`：前几类会破坏头语法
  // （`"` 结束参数值，`\r\n` 能注入额外的头），反斜杠是引号内的转义符。
  const asciiSafe = displayName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  if (asciiSafe === displayName) {
    return `attachment; filename="${asciiSafe}"`;
  }
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeExtValue(displayName)}`;
}
