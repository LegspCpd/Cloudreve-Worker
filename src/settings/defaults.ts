/**
 * 站点设置默认值。
 *
 * 键名与默认值逐条取自 Cloudreve v4 的 `inventory/setting.go` →
 * `var DefaultSettings = map[string]string{...}`（不是 `pkg/setting/provider.go`，
 * 那里只是读取时的兜底值）。只保留边缘版实际会读取的项。
 *
 * 首次启动时 `ensureSettings()` 会把这些写入 settings 表；之后以数据库里的值为准。
 * 少数几项默认值与上游不同，都单独标注了原因。
 */
import { DEFAULT_MAIL_TEMPLATES } from './mail-templates';
import { DEFAULT_FILE_VIEWERS } from './fileViewers';

export const DEFAULT_SETTINGS: Record<string, string> = {
  // --- 站点基础 ---
  // 上游默认是 http://localhost:5212；边缘版留空，运行时回落到 Worker 变量 SITE_URL
  siteURL: '',
  siteName: 'Cloudreve',
  siteDes: 'Cloudreve',
  siteTitle: 'Cloud storage for everyone',
  siteScript: '',
  siteID: '', // 首次启动生成 UUID
  site_logo: '/static/img/logo.svg',
  site_logo_light: '/static/img/logo_light.svg',
  defaultTheme: '#1976d2',
  theme_options: JSON.stringify({
    '#1976d2': {
      light: {
        palette: {
          primary: { main: '#1976d2', light: '#42a5f5', dark: '#1565c0' },
          secondary: { main: '#9c27b0', light: '#ba68c8', dark: '#7b1fa2' },
        },
      },
      dark: {
        palette: {
          primary: { main: '#90caf9', light: '#e3f2fd', dark: '#42a5f5' },
          secondary: { main: '#ce93d8', light: '#f3e5f5', dark: '#ab47bc' },
        },
      },
    },
    '#3f51b5': {
      light: { palette: { primary: { main: '#3f51b5' }, secondary: { main: '#f50057' } } },
      dark: { palette: { primary: { main: '#9fa8da' }, secondary: { main: '#ff4081' } } },
    },
  }),
  maxEditSize: '52428800',
  custom_nav_items: '[]',
  // 自定义 HTML 注入点，对应 pkg/setting 的 CustomHTML
  headless_footer_html: '',
  headless_bottom_html: '',
  sidebar_bottom_html: '',
  // 法律文档链接，对应 LegalDocuments
  tos_url: '',
  privacy_policy_url: '',
  // PWA 图标（官方「站点信息」设置页会读写这三个键）
  pwa_small_icon: '/static/img/favicon.ico',
  pwa_medium_icon: '/static/img/logo192.png',
  pwa_large_icon: '/static/img/logo512.png',

  // --- 注册与登录 ---
  register_enabled: '1',
  email_active: '0',
  expose_user_email: '1',
  login_captcha: '0',
  reg_captcha: '0',
  forget_captcha: '0',
  // 上游默认是 1。边缘版没有 WebAuthn / Passkey 实现，开着会让前端显示无法使用的
  // 登录方式，因此默认关掉（管理员可在后台打开，但依然会返回「未启用」）。
  authn_enabled: '1',
  default_group: '2',
  // 注册邮箱限制（官方开源版为 Pro 装饰位，边缘版补齐为真实功能）：
  //   filter_email_provider: 0=不启用 1=白名单 2=黑名单
  //   filter_email_provider_rule: 逗号分隔的域名列表
  //   disable_sub_address_email: 1 时禁止含 `+` 的子地址邮箱注册
  filter_email_provider: '0',
  filter_email_provider_rule: '',
  disable_sub_address_email: '0',
  // 第三方登录（OIDC）。通用实现，QQ 互联 / Logto / Keycloak 等标准 OIDC 均可接入。
  oidc_enabled: '0',
  oidc_name: '',
  oidc_issuer: '',
  oidc_client_id: '',
  oidc_client_secret: '',
  oidc_scopes: 'openid profile email',
  oidc_auto_register: '1',
  // 第三方登录（QQ 互联，edge 自建 Pro 功能）：OAuth2 授权码流程，无 email，
  // 本地账号用合成邮箱落库（见 src/services/social.ts）。
  qq_enabled: '0',
  qq_name: '',
  qq_app_id: '',
  qq_app_secret: '',
  qq_auto_register: '1',
  qq_scope: 'get_user_info',
  captcha_type: '',
  // 内置图形验证码的渲染参数（官方「验证码」设置页读写，键名对齐上游 inventory/setting.go:539-555）
  captcha_mode: '3',
  captcha_ComplexOfNoiseText: '0',
  captcha_ComplexOfNoiseDot: '0',
  captcha_IsShowHollowLine: '0',
  captcha_IsShowNoiseDot: '1',
  captcha_IsShowNoiseText: '0',
  captcha_IsShowSlimeLine: '1',
  captcha_IsShowSineLine: '0',
  captcha_CaptchaLen: '6',
  captcha_ReCaptchaKey: '',
  captcha_ReCaptchaSecret: '',
  captcha_turnstile_site_key: '',
  captcha_turnstile_site_secret: '',
  captcha_cap_instance_url: '',
  captcha_cap_site_key: '',
  captcha_cap_secret_key: '',
  captcha_cap_asset_server: 'jsdelivr',

  // --- 密钥 ---
  secret_key: '', // 首次启动生成 256 位随机串
  hash_id_salt: '', // 首次启动生成 64 位随机串

  // --- 上传 ---
  upload_session_timeout: '86400',
  chunk_retries: '5',
  use_temp_chunk_buffer: '1',
  max_parallel_transfer: '4',

  // --- 分页与批量 ---
  max_page_size: '2000',
  max_batched_file: '3000',
  use_cursor_pagination: '1',
  max_recursive_searched_folder: '65535',

  // --- Token ---
  access_token_ttl: '3600',
  refresh_token_ttl: '1209600', // 2 weeks

  // --- 头像 ---
  avatar_size: '4194304',
  avatar_size_l: '200',
  gravatar_server: 'https://www.gravatar.com/',

  // --- 缩略图（边缘版不做服务端生成，这两项只影响 /site/config/explorer 上报的尺寸）---
  thumb_width: '400',
  thumb_height: '300',
  thumb_encode_method: 'png',
  thumb_encode_quality: '95',
  // 官方「媒体处理」设置页读写的完整键集（默认值逐条取自 inventory/setting.go:558-585,
  // 631-644）。边缘版不做本地转码，但这些值会经 /site/config 与策略能力透传给前端，
  // 且管理员需要能正常打开并保存这一页。
  thumb_entity_suffix: '{blob_path}/{blob_name}._thumb',
  thumb_gc_after_gen: '0',
  thumb_builtin_enabled: '1',
  thumb_builtin_max_size: '78643200',
  thumb_vips_max_size: '78643200',
  thumb_vips_enabled: '0',
  thumb_vips_exts:
    '3fr,ari,arw,bay,braw,crw,cr2,cr3,cap,data,dcs,dcr,dng,drf,eip,erf,fff,gpr,iiq,k25,kdc,mdc,mef,mos,mrw,nef,nrw,obm,orf,pef,ptx,pxn,r3d,raf,raw,rwl,rw2,rwz,sr2,srf,srw,tif,x3f,csv,mat,img,hdr,pbm,pgm,ppm,pfm,pnm,svg,svgz,j2k,jp2,jpt,j2c,jpc,gif,png,jpg,jpeg,jpe,webp,tif,tiff,fits,fit,fts,exr,jxl,pdf,heic,heif,avif,svs,vms,vmu,ndpi,scn,mrxs,svslide,bif,raw',
  thumb_vips_path: 'vips',
  thumb_ffmpeg_enabled: '0',
  thumb_ffmpeg_path: 'ffmpeg',
  thumb_ffmpeg_max_size: '10737418240',
  thumb_ffmpeg_exts:
    '3g2,3gp,asf,asx,avi,divx,flv,m2ts,m2v,m4v,mkv,mov,mp4,mpeg,mpg,mts,mxf,ogv,rm,swf,webm,wmv',
  thumb_ffmpeg_seek: '00:00:01.00',
  thumb_ffmpeg_extra_args: '-hwaccel auto',
  thumb_libreoffice_path: 'soffice',
  thumb_libreoffice_max_size: '78643200',
  thumb_libreoffice_enabled: '0',
  thumb_libreoffice_exts:
    'txt,pdf,md,ods,ots,fods,uos,xlsx,xml,xls,xlt,dif,dbf,html,slk,csv,xlsm,docx,dotx,doc,dot,rtf,xlsm,xlst,xls,xlw,xlc,xlt,pptx,ppsx,potx,pomx,ppt,pps,ppm,pot,pom',
  thumb_music_cover_enabled: '1',
  thumb_music_cover_exts: 'mp3,m4a,ogg,flac',
  thumb_music_cover_max_size: '1073741824',
  thumb_libraw_enabled: '0',
  thumb_libraw_path: 'simple_dcraw',
  thumb_libraw_max_size: '78643200',
  thumb_libraw_exts:
    '3fr,ari,arw,bay,braw,crw,cr2,cr3,cap,data,dcs,dcr,dng,drf,eip,erf,fff,gpr,iiq,k25,kdc,mdc,mef,mos,mrw,nef,nrw,obm,orf,pef,ptx,pxn,r3d,raf,raw,rwl,rw2,rwz,sr2,srf,srw,tif,x3f',
  media_meta_exif: '1',
  media_meta_exif_size_local: '1073741824',
  media_meta_exif_size_remote: '104857600',
  media_meta_exif_brute_force: '1',
  media_meta_music: '1',
  media_meta_music_size_local: '1073741824',
  media_exif_music_size_remote: '1073741824',
  media_meta_ffprobe: '0',
  media_meta_ffprobe_path: 'ffprobe',
  media_meta_ffprobe_size_local: '0',
  media_meta_ffprobe_size_remote: '0',
  media_meta_geocoding: '0',
  media_meta_geocoding_mapbox_ak: '',

  // --- 前端展示 ---
  explorer_icons: '[]',
  emojis: '{}',
  custom_props: '[]',
  // 内置文件查看器默认集（上游安装时播种的同一套 13 个查看器）。
  // 这里**必须**给真实默认集而不是 '[]'：SettingsProvider.get 的解析顺序是
  // 缓存/DB → DEFAULT_SETTINGS → 调用方 fallback，defaults 里的值会遮蔽
  // 调用方（site.ts）的 fallback。给 '[]' 的后果是前端「打开方式」菜单
  // 整个为空（4430507 → 本修复踩过）。存量 '[]' 行由 0011 迁移回填。
  file_viewers: DEFAULT_FILE_VIEWERS,
  viewer_default_apps: '{}',
  show_encryption_status: '1',
  map_provider: 'openstreetmap',
  // 取值必须是 `pkg/setting/types.go:166-171` 里的枚举：
  // regular / satellite / terrain —— 不是 Google 地图 API 的 'roadmap'。
  map_google_tile_type: 'regular',
  map_mapbox_ak: '',
  show_app_promotion: '1',
  show_desktop_app_promotion: '1',

  // --- 邮件 ---
  // 发件人。键名照抄上游（含上游 `fromAdress` 的拼写错误，改了就找不到配置项）。
  fromName: 'Cloudreve',
  fromAdress: 'no-reply@cloudreve.org',
  replyTo: 'support@cloudreve.org',
  // SMTP 连接参数。这几项的键名/默认值逐字对齐上游 `inventory/setting.go:501-509`，
  // 因为官方前端管理面板的「邮件」设置页直接读写它们
  // （`frontend/src/component/Admin/Settings/Email/Email.tsx`）。
  //
  // 边缘版真正走的就是 SMTP 协议（`src/services/smtp.ts`），不是 HTTP 发信 API，
  // 所以这几项填了就有用，不需要任何环境变量。
  //
  // 注意默认端口 25 沿用了上游，但 **Cloudflare Workers 禁止连 25 端口**，
  // 所以这是个「未配置」状态。管理员必须改成 465（SSL）或 587（STARTTLS），
  // 发信时的报错会明确说明这一点。
  smtpHost: 'smtp.cloudreve.com',
  smtpPort: '25',
  smtpUser: 'smtp.cloudreve.com',
  smtpPass: '',
  smtpEncryption: '0',
  mail_keepalive: '30',
  // 上游把这两项写成 minified 的巨型 HTML（`inventory/setting.go:356-357`），
  // 这里换成等价占位符语义的简洁模板（见 `src/settings/mail-templates.ts`）。
  // **占位符契约与上游完全一致**，管理员把上游模板原样贴回来也能正常渲染。
  mail_activation_template: JSON.stringify(DEFAULT_MAIL_TEMPLATES.activation),
  mail_reset_template: JSON.stringify(DEFAULT_MAIL_TEMPLATES.reset),
  // 原版 Pro 的两个模板（收据/配额）。边缘版有对应真实业务，出厂即给默认值，
  // 管理员可在「邮件 → 邮件模板」里直接改。
  mail_receipt_template: JSON.stringify(DEFAULT_MAIL_TEMPLATES.receipt),
  mail_exceed_quota_template: JSON.stringify(DEFAULT_MAIL_TEMPLATES.exceedQuota),

  // --- 全文检索 ---
  // 键名与默认值逐条取自 `inventory/setting.go:675-686`。
  // 原版是「Tika 抽正文 + Meilisearch 建索引」的两段式，两者都是 HTTP 服务，
  // Workers 能直接调，所以边缘版**照搬原版方案**，不降级成文件名匹配。
  // 管理员在「管理面板 → 文件系统 → 全文检索」里填 endpoint 即可生效。
  fts_enabled: '0',
  fts_index_type: 'meilisearch',
  fts_extractor_type: 'tika',
  fts_meilisearch_endpoint: '',
  fts_meilisearch_api_key: '',
  fts_meilisearch_page_size: '5',
  fts_meilisearch_embed_enabled: '0',
  fts_meilisearch_embed_config: '{}',
  fts_tika_endpoint: '',
  fts_tika_exts: 'pdf,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,rtf,txt,md,html,htm,epub,csv',
  fts_tika_max_file_size: '26214400',
  fts_chunk_size: '2000',

  // --- 其它 ---
  public_resource_maxage: '86400',
  entity_url_default_ttl: '3600',
  entity_url_cache_margin: '600',
  archive_timeout: '600',
  temp_path: 'temp',
  cron_garbage_collect: '@every 30m',

  // --- 增值服务（键名与官方前端 VAS 面板一致；JSON 类的默认为空集合）---
  shop_nav_enabled: '0',
  credit_enabled: '0',
  currency_code: 'CNY',
  currency_symbol: '¥',
  currency_unit: '100',
  payment: '[]',
  storage_products: '[]',
  group_sell_data: '[]',
  credit_products: '[]',
  // 站点公告（edge 自建 Pro 功能）：顶部横幅展示的纯文本（前端做 HTML 转义，不渲染标签）。
  // 留空表示不显示公告。
  announcement: '',
  // 新用户初始文件夹（edge 自建 Pro 功能，对标官方「新用户初始文件」）：
  // 注册时为新用户在根目录创建的默认文件夹，JSON 字符串数组，元素为文件夹名。
  // 例：'["我的文档","我的图片","我的视频"]'。留空 "[]" 表示不创建。
  initial_files: '[]',
  // 审计日志事件开关（管理端「事件」页）：JSON map 事件名 → bool，缺省视为 true。
  audit_log_events: '{}',
};

// 官方「队列」设置页读写的 6 队列 × 6 项（键名/默认值逐条取自
// inventory/setting.go:598-627）。边缘版无常驻 worker，队列参数不参与调度，
// 但设置页需要能读到并保存这些键。
const QUEUE_TYPES = ['media_meta', 'thumb', 'recycle', 'io_intense', 'remote_download'] as const;
const QUEUE_DEFAULTS: Record<string, Record<string, string>> = {
  media_meta: { worker_num: '30', max_execution: '3600', backoff_factor: '2', backoff_max_duration: '60', max_retry: '1', retry_delay: '0' },
  thumb: { worker_num: '15', max_execution: '300', backoff_factor: '2', backoff_max_duration: '60', max_retry: '0', retry_delay: '0' },
  recycle: { worker_num: '5', max_execution: '900', backoff_factor: '2', backoff_max_duration: '60', max_retry: '0', retry_delay: '0' },
  io_intense: { worker_num: '30', max_execution: '2592000', backoff_factor: '2', backoff_max_duration: '600', max_retry: '5', retry_delay: '0' },
  remote_download: { worker_num: '5', max_execution: '864000', backoff_factor: '2', backoff_max_duration: '600', max_retry: '5', retry_delay: '0' },
};
for (const t of QUEUE_TYPES) {
  for (const [k, v] of Object.entries(QUEUE_DEFAULTS[t])) {
    DEFAULT_SETTINGS[`queue_${t}_${k}`] = v;
  }
}

/** 需要随机初始化、且一旦写库就不应再变的键。 */
export const GENERATED_SETTINGS = ['siteID', 'secret_key', 'hash_id_salt'] as const;
