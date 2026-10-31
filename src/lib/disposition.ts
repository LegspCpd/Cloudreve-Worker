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

export function attachmentDisposition(displayName: string): string {
  // 非可打印 ASCII、引号、反斜杠一律打成 `_`：前几类会破坏头语法
  // （`"` 结束参数值，`\r\n` 能注入额外的头），反斜杠是引号内的转义符。
  const asciiSafe = displayName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  if (asciiSafe === displayName) {
    return `attachment; filename="${asciiSafe}"`;
  }
  return `attachment; filename="${asciiSafe}"; filename*=UTF-8''${encodeExtValue(displayName)}`;
}
