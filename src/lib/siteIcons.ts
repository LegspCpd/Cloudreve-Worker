/**
 * 站点 PWA 图标的运行时注入。
 *
 * 官方前端的 index.html 是模板：`<link rel="shortcut icon" href="{pwa_small_icon}">`
 * 和首屏遮罩的 `background-image: url("{pwa_medium_icon}")` 由原版 Go 后端在
 * 每次请求时按站点设置替换（middleware/frontend.go）。我们是静态前端，构建期
 * 只能填默认值，导致管理后台改了小/中/大图标后标签页图标一直不变。
 *
 * 这里在三个平台返回 HTML 时做同样的替换，让设置真正生效。manifest.json
 * 本来就由 Worker 动态生成，不需要处理。
 */

export interface SiteIconSettings {
  small: string;
  medium: string;
  large: string;
}

/** 构建期 patchIndexHtml 填进去的默认值；只替换这几个确定位置。 */
const BUILD_SMALL = '/static/img/favicon.ico';
const BUILD_MEDIUM = '/static/img/logo192.png';

/** HTML 属性上下文转义，防止设置里的 URL 带引号闭合标签注入脚本。 */
function attrEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把 HTML 里构建期填死的图标路径替换为运行时设置值。
 * 找不到目标片段时原样返回（幂等，兼容上游改了模板的情况）。
 */
export function applySiteIcons(html: string, icons: SiteIconSettings): string {
  let out = html;
  const small = attrEscape(icons.small || BUILD_SMALL);
  const medium = attrEscape(icons.medium || BUILD_MEDIUM);

  // 标签页 favicon：<link rel="shortcut icon" href="/static/img/favicon.ico" ...>
  out = out.replace(
    new RegExp(`(rel="shortcut icon"\\s+href=")${escapeRegExp(BUILD_SMALL)}(")`),
    `$1${small}$2`,
  );

  // 首屏遮罩 logo：background-image: url("/static/img/logo192.png")
  out = out.replace(
    new RegExp(`(background-image:\\s*url\\(")${escapeRegExp(BUILD_MEDIUM)}("\\))`),
    `$1${medium}$2`,
  );

  // 构建脚本给遮罩 logo 加的 preload 也跟着改，否则会白下载一次默认图
  out = out.replace(
    new RegExp(`(<link[^>]*as="image"[^>]*href=")${escapeRegExp(BUILD_MEDIUM)}(")`),
    `$1${medium}$2`,
  );

  return out;
}
