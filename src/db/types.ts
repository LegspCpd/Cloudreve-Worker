/**
 * 数据库行类型。列名与 `migrations/0001_init.sql` 一一对应。
 *
 * 数值列的声明与 `normalize*()` 的产物一致：Neon HTTP 驱动会把 BIGINT 以
 * **字符串**返回，`normalize*()` 里已统一过 `toNum()`，因此这里直接写 `number`。
 */

export type UserStatus = 'active' | 'inactive' | 'manual_banned' | 'sys_banned';
export type TaskStatus =
  | 'queued'
  | 'processing'
  | 'suspending'
  | 'error'
  | 'canceled'
  | 'completed';

export interface GroupRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  max_storage: number | null;
  speed_limit: number | null;
  permissions: Uint8Array;
  settings: GroupSetting | null;
  storage_policy_id: number | null;
}

export interface UserRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  email: string;
  nick: string;
  password: string | null;
  status: UserStatus;
  storage: number;
  two_factor_secret: string | null;
  avatar: string | null;
  settings: UserSetting | null;
  group_users: number;
}

export interface UserWithGroup extends UserRow {
  group: GroupRow;
}

export interface StoragePolicyRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  type: string;
  server: string | null;
  bucket_name: string | null;
  is_private: boolean | null;
  access_key: string | null;
  secret_key: string | null;
  max_size: number | null;
  dir_name_rule: string | null;
  file_name_rule: string | null;
  settings: PolicySetting | null;
  node_id: number | null;
}

/**
 * 从节点。对应上游 `ent.Node`（`application/migrator/model/node.go`）。
 *
 * `server` 是从节点的访问地址，`slave_key` 是**主→从 RPC 的 HMAC 密钥**
 * （与从节点配置文件里的 `[Slave] Secret` 是同一个值）。策略 `node_id`
 * 指向这里，存储读写就打到这台机器的磁盘上。
 */
export interface NodeRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  /** `master` / `slave` */
  type: string;
  server: string | null;
  slave_key: string | null;
  /** 能力位布尔集（序列化字符串），任务分派用；存储走 policy.node_id，不看它 */
  capabilities: string | null;
  weight: number | null;
  /** `active` / `suspended` */
  status: string;
  settings: Record<string, unknown> | null;
}

export interface FileRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  type: number;
  name: string;
  owner_id: number;
  size: number;
  primary_entity: number | null;
  file_children: number | null;
  is_symbolic: boolean;
  props: FileProps | null;
  storage_policy_files: number | null;
  /** 文件是否启用客户端加密（展示/下载判定用的轻量标志，密钥在 entities.enc_meta）。 */
  encrypted?: boolean;
}

export interface EntityRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  type: number;
  source: string;
  size: number;
  reference_count: number;
  storage_policy_entities: number;
  created_by: number | null;
  upload_session_id: string | null;
  recycle_options: EntityProps | null;
  /** 该实体内容的加密元数据（base64 JSON：algorithm/key_plain_text/iv），密文密钥仅存本库。 */
  enc_meta?: string | null;
}

export interface ShareRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  password: string | null;
  views: number;
  downloads: number;
  expires: Date | null;
  remain_downloads: number | null;
  props: ShareProps | null;
  file_shares: number | null;
  user_shares: number | null;
  /** 付费分享价格（积分）。0 表示免费分享。 */
  score: number;
}

export interface MetadataRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  value: string;
  file_id: number;
  is_public: boolean;
}

export interface DirectLinkRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  downloads: number;
  speed: number;
  file_id: number;
}

export interface SettingRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  name: string;
  value: string | null;
}

export interface TaskRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  type: string;
  status: TaskStatus;
  public_state: TaskPublicState;
  private_state: string | null;
  correlation_id: string | null;
  user_tasks: number | null;
}

// ---------------------------------------------------------------------------
// JSON 列的结构。字段名与 json tag 均取自 `inventory/types/types.go`。
// ---------------------------------------------------------------------------

export interface UserSetting {
  profile_off?: boolean;
  preferred_theme?: string;
  version_retention?: boolean;
  version_retention_ext?: string[];
  version_retention_max?: number;
  pined?: { uri: string; name?: string }[];
  email_language?: string;
  disable_view_sync?: boolean;
  fs_view_map?: Record<string, ExplorerView>;
  share_links_in_profile?: string;
  /** 用户在组策略集里选中的上传策略（edge 自建 Pro 功能），存数字 ID。 */
  upload_policy_id?: number;
  /**
   * 购买的容量包（edge 自建 Pro 功能）。每个元素是一份额外容量；
   * expire_at 为空表示永久。maxStorage = 组上限 + 未过期包之和。
   */
  quota_packs?: { size: number; expire_at?: string | null }[];
  /**
   * 购买用户组（edge 自建 Pro 功能）。生效中记录当前购买组与原组，
   * expire_at 为空表示永久；过期后由请求中间件惰性回退到原组。
   */
  group_pack?: { group_id: number; prev_group_id: number; expire_at?: string | null } | null;
  /** 积分余额（edge 自建 Pro 功能）。 */
  credit?: number;
}

export interface GroupSetting {
  compress_size?: number;
  decompress_size?: number;
  remote_download_options?: Record<string, unknown>;
  source_batch?: number;
  aria2_batch?: number;
  max_walked_files?: number;
  trash_retention?: number;
  redirected_source?: boolean;
}

export interface PolicySetting {
  token?: string;
  file_type?: string[];
  is_file_type_deny_list?: boolean;
  file_regexp?: string;
  is_name_regexp_deny_list?: boolean;
  od_redirect?: string;
  custom_proxy?: boolean;
  proxy_server?: string;
  internal_proxy?: boolean;
  /** OneDrive 的 drive 资源段，如 `me/drive` 或 `sites/<id>/drive` */
  od_driver?: string;
  region?: string;
  server_side_endpoint?: string;
  chunk_size?: number;
  tps_limit?: number;
  tps_limit_burst?: number;
  s3_path_style?: boolean;
  thumb_exts?: string[];
  thumb_support_all_exts?: boolean;
  thumb_max_size?: number;
  relay?: boolean;
  pre_allocate?: boolean;
  media_meta_exts?: string[];
  media_meta_generator_proxy?: boolean;
  thumb_generator_proxy?: boolean;
  native_media_processing?: boolean;
  s3_delete_batch_size?: number;
  stream_saver?: boolean;
  use_cname?: boolean;
  source_auth?: boolean;
  qiniu_upload_cdn?: boolean;
  chunk_concurrency?: number;
  encryption?: boolean;
  /** 边缘版专属：中转下载与缩略图缓存到 Cloudflare 边缘 CDN（Cache API） */
  edge_cache?: boolean;
  /** 边缘版专属（load_balance 虚拟策略）：参与负载均衡的 slave 策略 id 列表 */
  slave_policy_ids?: number[];
  /** 边缘版专属（load_balance 虚拟策略）：选路算法，默认 random */
  load_balance_mode?: 'random' | 'round_robin';
  /** 边缘版专属（load_balance 虚拟策略）：子策略权重（键=策略 id 字符串，0 不参与），对齐官方 Pro 权重语义 */
  slave_policy_weights?: Record<string, number>;
}

export interface ExplorerView {
  page_size: number;
  order?: string;
  order_direction?: string;
  view?: string;
  thumbnail?: boolean;
  gallery_width?: number;
  columns?: { type: number; width?: number; props?: Record<string, unknown> }[];
}

export interface FileProps {
  view?: ExplorerView;
}

export interface ShareProps {
  share_view?: boolean;
  show_read_me?: boolean;
}

export interface EntityProps {
  unlink_only?: boolean;
  encrypt_metadata?: {
    algorithm: string;
    key: number[] | string;
    key_plain_text?: number[] | string;
    iv: number[] | string;
  };
}

/** 客户端加密所用算法（对齐上游前端 EncryptionCipher）。 */
export enum EncryptionCipher {
  Aes256Ctr = 'aes-256-ctr',
}

/**
 * 单文件加密元数据。服务端生成后：
 *   - 原样回传前端 `EncryptedBlob` 用于客户端加密上传；
 *   - 落库到 entities.enc_meta（base64 字符串），下载时用来还原明文。
 * key_plain_text / iv 仅存于本仓库数据库，存储后端只看到密文。
 */
export interface EncryptMetadata {
  algorithm: EncryptionCipher;
  key_plain_text: string; // base64
  iv: string; // base64
}

export interface TaskPublicState {
  error?: string;
  error_history?: string[];
  executed_duration?: number;
  retry_count?: number;
  resume_time?: number;
  /**
   * 任务摘要。对应上游 `types.TaskPublicState.Summary`
   * （`inventory/types/types.go`），前端 `TaskSummary` 读的就是这个字段。
   */
  summary?: {
    phase?: string;
    props?: {
      src?: string;
      src_str?: string;
      dst?: string;
      src_multiple?: string[];
      dst_policy_id?: string;
      failed?: number;
      total?: number;
      /** 重建索引任务的进度游标 */
      indexed?: number;
      download?: unknown;
    };
  };
}

// ---------------------------------------------------------------------------
// 支付体系（edge 自建 Pro 功能，migrations/0005_payment.sql）
// ---------------------------------------------------------------------------

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'failed' | 'canceled';
export type VasProductType = 'storage' | 'group' | 'credit';

export interface OrderRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  user_id: number;
  order_no: string;
  product_type: VasProductType;
  product_snapshot: Record<string, unknown> | null;
  amount: number;
  status: OrderStatus;
  provider: string;
  provider_trade_no: string | null;
  paid_at: Date | null;
  fulfilled_at: Date | null;
  error: string | null;
}

export interface GiftCodeRow {
  id: number;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  code: string;
  product_type: VasProductType;
  product_payload: Record<string, unknown> | null;
  batch: string | null;
  used_by: number | null;
  used_at: Date | null;
}

// ---------------------------------------------------------------------------
// 审计日志（edge 自建 Pro 功能，migrations/0006_audit_log.sql）
// ---------------------------------------------------------------------------

export interface AuditLogRow {
  id: number;
  created_at: Date;
  user_id: number | null;
  type: number;
  meta: Record<string, unknown> | null;
}
