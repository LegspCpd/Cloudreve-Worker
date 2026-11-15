/**
 * 内置「文件查看器」默认定义（单一事实来源）。
 *
 * 与上游 `inventory/setting.go` 的 `defaultFileViewers` 逐字段对齐
 * （JSON snake_case；type 取值 builtin / custom；archive 的
 * required_group_permission=[5] 即 GroupPermissionArchiveTask，与边缘版
 * boolset 位表一致）。前端预览器注册表完全由 explorer 配置的
 * `file_viewers` 构建——没有它「打开方式」菜单整个为空，所有文件只能下载。
 *
 * ★ 消费方有两处，改这里两边同时生效：
 *   1. `settings/defaults.ts` 的 DEFAULT_SETTINGS.file_viewers ——
 *      新部署由 ensureSettings 播种进库；存量部署的 settings 缓存回填也走它。
 *      **不要只在调用方给 fallback**：SettingsProvider.get 的解析顺序是
 *      「缓存/DB → DEFAULT_SETTINGS → 调用方 fallback」，defaults 里的值
 *      （哪怕是 '[]'）会遮蔽调用方 fallback，后者永远轮不到（4430507 踩过）。
 *   2. `routes/site.ts` 的 explorer 配置段 —— 缺键时的最后兜底。
 *
 * 存量部署若已被播种了 '[]'，由 migrations/0011_file_viewers.sql 回填；
 * 管理员在后台「文件系统 → 文件查看器」保存过的自定义配置不会被迁移触碰。
 */
export const DEFAULT_FILE_VIEWERS = JSON.stringify([
  {
    viewers: [
      {
        id: 'music',
        type: 'builtin',
        display_name: 'fileManager.musicPlayer',
        exts: ['mp3', 'ogg', 'wav', 'flac', 'm4a'],
      },
      {
        id: 'epub',
        type: 'builtin',
        display_name: 'fileManager.epubViewer',
        exts: ['epub'],
      },
      {
        id: 'googledocs',
        type: 'custom',
        display_name: 'fileManager.googledocs',
        icon: '/static/img/viewers/gdrive.png',
        url: 'https://docs.google.com/gview?url={$src}&embedded=true',
        exts: [
          'jpeg', 'png', 'gif', 'tiff', 'bmp', 'webm', 'mpeg4', '3gpp', 'mov', 'avi',
          'mpegps', 'wmv', 'flv', 'txt', 'css', 'html', 'php', 'c', 'cpp', 'h', 'hpp',
          'js', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'pages', 'ai',
          'psd', 'tiff', 'dxf', 'svg', 'eps', 'ps', 'ttf', 'xps',
        ],
        max_size: 26214400,
      },
      {
        id: 'm365online',
        type: 'custom',
        display_name: 'fileManager.m365viewer',
        icon: '/static/img/viewers/m365.svg',
        url: 'https://view.officeapps.live.com/op/view.aspx?src={$src}',
        exts: [
          'doc', 'docx', 'docm', 'dotm', 'dotx', 'xlsx', 'xlsb', 'xls', 'xlsm',
          'pptx', 'ppsx', 'ppt', 'pps', 'pptm', 'potm', 'ppam', 'potx', 'ppsm',
        ],
        max_size: 10485760,
      },
      {
        id: 'pdf',
        type: 'builtin',
        display_name: 'fileManager.pdfViewer',
        exts: ['pdf'],
      },
      {
        id: 'video',
        type: 'builtin',
        icon: '/static/img/viewers/artplayer.png',
        display_name: 'Artplayer',
        exts: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm3u8', 'flv'],
      },
      {
        id: 'markdown',
        type: 'builtin',
        display_name: 'fileManager.markdownEditor',
        exts: ['md'],
        templates: [{ ext: 'md', display_name: 'Markdown' }],
      },
      {
        id: 'drawio',
        type: 'builtin',
        icon: '/static/img/viewers/drawio.svg',
        display_name: 'draw.io',
        exts: ['drawio', 'dwb'],
        props: { host: 'https://embed.diagrams.net' },
        templates: [
          { ext: 'drawio', display_name: 'fileManager.diagram' },
          { ext: 'dwb', display_name: 'fileManager.whiteboard' },
        ],
      },
      {
        id: 'image',
        type: 'builtin',
        display_name: 'fileManager.imageViewer',
        exts: ['bmp', 'png', 'gif', 'jpg', 'jpeg', 'svg', 'webp', 'heic', 'heif'],
      },
      {
        id: 'monaco',
        type: 'builtin',
        icon: '/static/img/viewers/monaco.svg',
        display_name: 'fileManager.monacoEditor',
        exts: [
          'md', 'txt', 'json', 'php', 'py', 'bat', 'c', 'h', 'cpp', 'hpp', 'cs',
          'css', 'dockerfile', 'go', 'html', 'htm', 'ini', 'java', 'js', 'jsx',
          'less', 'lua', 'sh', 'sql', 'xml', 'yaml',
        ],
        templates: [{ ext: 'txt', display_name: 'fileManager.text' }],
      },
      {
        id: 'photopea',
        type: 'builtin',
        icon: '/static/img/viewers/photopea.png',
        display_name: 'Photopea',
        exts: [
          'psd', 'ai', 'indd', 'xcf', 'xd', 'fig', 'kri', 'clip', 'pxd', 'pxz',
          'cdr', 'ufo', 'afphoyo', 'svg', 'esp', 'pdf', 'pdn', 'wmf', 'emf', 'png',
          'jpg', 'jpeg', 'gif', 'webp', 'ico', 'icns', 'bmp', 'avif', 'heic', 'jxl',
          'ppm', 'pgm', 'pbm', 'tiff', 'dds', 'iff', 'anim', 'tga', 'dng', 'nef',
          'cr2', 'cr3', 'arw', 'rw2', 'raf', 'orf', 'gpr', '3fr', 'fff',
        ],
      },
      {
        id: 'excalidraw',
        type: 'builtin',
        icon: '/static/img/viewers/excalidraw.svg',
        display_name: 'Excalidraw',
        exts: ['excalidraw'],
        templates: [{ ext: 'excalidraw', display_name: 'Excalidraw' }],
      },
      {
        id: 'archive',
        type: 'builtin',
        display_name: 'fileManager.archivePreview',
        exts: ['zip', '7z', 'rar', 'tar', 'gz', 'tgz'],
        required_group_permission: [5],
      },
    ],
  },
]);

/** 与 DEFAULT_FILE_VIEWERS 同源的数组形态（兜底时直接返回，免重复 stringify+parse）。 */
const DEFAULT_FILE_VIEWERS_ARRAY: unknown[] = JSON.parse(DEFAULT_FILE_VIEWERS);

/**
 * 「压缩包浏览」实际支持的扩展名。
 *
 * 前端按 `fileExtension(name)`（最后一个点之后）匹配查看器，所以 `.tar.gz`
 * 命中的是 `gz`，不需要也不可能列出 `tar.gz`。
 *
 * 存量部署的 `settings.file_viewers` 是播种时写进库的旧值（只有 zip/7z），
 * 改默认值不会影响它们，而管理员自定义的配置又不该被迁移覆盖 —— 因此在
 * 读取层做并集：内置 archive 查看器的扩展名永远包含这一组。代价是管理员
 * 无法「去掉某一种归档的预览入口」，对内置查看器来说可以接受。
 */
const ARCHIVE_VIEWER_EXTS = ['zip', '7z', 'rar', 'tar', 'gz', 'tgz'];

function withArchiveExts(groups: unknown[]): unknown[] {
  for (const g of groups) {
    if (g === null || typeof g !== 'object') continue;
    const viewers = (g as { viewers?: unknown }).viewers;
    if (!Array.isArray(viewers)) continue;
    for (const v of viewers) {
      if (v === null || typeof v !== 'object') continue;
      const viewer = v as { id?: unknown; type?: unknown; exts?: unknown };
      if (viewer.id !== 'archive' || viewer.type !== 'builtin') continue;
      const exts = Array.isArray(viewer.exts) ? viewer.exts.filter((e) => typeof e === 'string') : [];
      viewer.exts = [...new Set([...exts, ...ARCHIVE_VIEWER_EXTS])];
    }
  }
  return groups;
}

/**
 * 解析 settings 里存的 file_viewers 值，返回 ViewerGroup[]。
 *
 * ★ 空集 / 坏值一律回落到内置默认集——不要相信「存了值就是有效配置」：
 * 实测存量库里的脏值（`[ ]` / `null` 等非空但解析为空的形态）既躲过了
 * 0011 迁移的 `WHERE value='[]'`，也压住了 defaults 层，线上「打开方式」
 * 持续为空（248e20d 之后的最终修法，读取层 + 数据层双保险）。
 * 语义代价：管理员「故意清空全部查看器」会被视为未配置而回落默认集；
 * 管理员保存任何非空配置都原样生效。
 */
export function parseFileViewers(raw: string | null | undefined): unknown[] {
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const hasViewers = Array.isArray(parsed) &&
        parsed.some(
          (g) =>
            g !== null &&
            typeof g === 'object' &&
            Array.isArray((g as { viewers?: unknown }).viewers) &&
            (g as { viewers: unknown[] }).viewers.length > 0,
        );
      if (hasViewers) return withArchiveExts(parsed as unknown[]);
    } catch {
      /* 坏 JSON → 走默认集 */
    }
  }
  return withArchiveExts(DEFAULT_FILE_VIEWERS_ARRAY);
}
