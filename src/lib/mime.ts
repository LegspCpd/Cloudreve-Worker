/**
 * 扩展名 → Content-Type 的兜底映射。
 *
 * 实体表不存 mime，S3/OneDrive 读回的内容类型来自上传时客户端声明，
 * 没声明就是 application/octet-stream —— Safari 对视频类型敏感，会拒绝播放。
 * 这里按扩展名兜底，覆盖前端查看器注册的所有媒体格式。
 */
const MIME: Record<string, string> = {
  // 视频
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  ts: 'video/mp2t',
  m3u8: 'application/vnd.apple.mpegurl',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  // 音频
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  wma: 'audio/x-ms-wma',
  // 图片
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  ico: 'image/x-icon',
  // 文档
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  xml: 'application/xml',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip',
};

export function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

/**
 * 存储返回的 Content-Type 不可用时按文件名兜底。
 * `application/octet-stream` / 空 都算不可用。
 */
export function mimeByExt(name: string): string | null {
  return MIME[extOf(name)] ?? null;
}

export function isGenericOctet(ct: string | undefined): boolean {
  return !ct || ct.trim() === '' || ct.toLowerCase().startsWith('application/octet-stream');
}
