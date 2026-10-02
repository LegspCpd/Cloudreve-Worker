/**
 * 存储驱动接口。对应 Cloudreve v4 的 `pkg/filemanager/driver/handler.go`，
 * 按 Workers 的运行时能力做了裁剪：
 *
 *   - 去掉了 `Open` / `LocalPath`（Workers 没有本地文件系统）；
 *   - 去掉了 `List` / `MediaMeta`（边缘版不做远程目录扫描与媒体元数据解析）；
 *   - 新增 `get`，用于服务端代理下载时把对象以流的形式取回。
 */
import type { StoragePolicyRow, PolicySetting } from '../db/types';

/** 上传请求：一次上传会话需要知道的全部信息。 */
export interface UploadRequest {
  /** 存储后端里的对象键 */
  savePath: string;
  /** 显示用文件名 */
  fileName: string;
  size: number;
  mimeType: string;
  /** 覆盖已存在对象 */
  overwrite: boolean;
  metadata?: Record<string, string>;
}

/** 已上传的分片记录，用于最终 complete。 */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** 上传会话（服务端侧）。 */
export interface UploadSession {
  id: string;
  policy: StoragePolicyRow;
  uid: number;
  fileId: number;
  entityId: number;
  savePath: string;
  size: number;
  chunkSize: number;
  /** 远程 multipart 上传 id（R2 用） */
  uploadId?: string;
  /** 已成功上传的分片，收尾时要用 */
  parts?: UploadedPart[];
  /** 已收到的分片序号集合，用于判断是否全部到齐 */
  chunksReceived?: number[];
  callbackSecret: string;
  expireAt: number;
  /** 创建会话时目标文件是否已存在（决定收尾时是新建还是新版本） */
  newFileCreated: boolean;
  mimeType: string;
}

/** 返回给客户端的上传凭证。字段名与原版 `fs.UploadCredential` 一致。 */
export interface UploadCredential {
  session_id?: string;
  chunk_size: number;
  /** Unix 秒 */
  expires: number;
  upload_urls?: string[];
  credential?: string;
  uploadID?: string;
  callback?: string;
  uri?: string;
  ak?: string;
  keyTime?: string;
  completeURL?: string;
  callback_secret?: string;
  mime_type?: string;
}

export interface GetSourceArgs {
  /** 过期时间（毫秒时间戳） */
  expire?: number;
  isDownload: boolean;
  displayName: string;
  speed: number;
}

/** 读到的对象内容。 */
export interface ObjectContent {
  body: ReadableStream;
  size: number;
  contentType?: string;
  /** 服务端返回的 Content-Range（若请求带 Range） */
  contentRange?: string | null;
}

export interface DriverCapabilities {
  /** 必须经站点代理才能拿到内容（R2 未配置公共域名时即如此） */
  proxyRequired: boolean;
  /** 上传需要服务端做哨兵校验（会话过期后清理占位对象） */
  uploadSentinelRequired: boolean;
  /** 直链默认有效期上限（秒） */
  maxSourceExpire: number;
  /** 支持缩略图的扩展名 */
  thumbSupportedExts: string[];
  thumbSupportAllExts: boolean;
  thumbMaxSize: number;
  /**
   * 直链（`source()` 返回的远端地址）能否带上我们指定的文件名。
   *
   * S3 兼容驱动靠预签名参数 `response-content-disposition` 做到，为 true；
   * OneDrive 的 `@microsoft.graph.downloadUrl` 是微软按存储对象名下发
   * Content-Disposition，而对象名又是 `{uuid}_{originname}` 这类命名规则生成的，
   * 改不了 —— 为 false。这类驱动在强制下载时必须改走站点代理，由 Worker 下发
   * attachment 头，否则浏览器会把「随机前缀_真名」存下来。
   *
   * 不声明时按 true 处理。
   */
  directUrlFilename?: boolean;
}

export interface StorageDriver {
  readonly policy: StoragePolicyRow;
  readonly settings: PolicySetting;
  readonly type: string;
  /** 从策略设置里解析出的分片大小（字节） */
  readonly chunkSize: number;

  capabilities(): DriverCapabilities;

  /**
   * 创建上传凭证。
   * 返回 `upload_urls` 表示客户端直传（不经过 Worker）；
   * 不返回则表示走中转模式，客户端分片打到 `/api/v4/file/upload/:sessionId/:index`。
   */
  token(session: UploadSession, file: UploadRequest): Promise<UploadCredential>;

  /** 服务端中转上传：把请求体直接写入存储。 */
  put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void>;

  /**
   * 写入一个分片（中转模式）。返回该分片在远端产生的标识（multipart 需要 partNumber+etag）。
   * @param index 分片序号，从 0 开始
   */
  writeChunk(
    session: UploadSession,
    index: number,
    body: ReadableStream,
    length: number,
  ): Promise<UploadedPart | null>;

  /** 所有分片到齐后收尾。 */
  completeUpload(session: UploadSession): Promise<void>;

  /** 取消上传，清理已写入的部分。 */
  cancelToken(session: UploadSession): Promise<void>;

  /** 删除对象，返回删除失败的键。 */
  delete(sources: string[]): Promise<string[]>;

  /**
   * 读取对象内容，用于服务端代理下载。
   * @param range HTTP Range 头原样值，如 `bytes=0-1023`
   */
  get(source: string, range?: string | null): Promise<ObjectContent | null>;

  /** 对象元信息，不存在返回 null。 */
  meta(source: string): Promise<{ size: number } | null>;

  /** 生成下载/预览地址。 */
  source(source: string, args: GetSourceArgs): Promise<string>;

  /** 生成缩略图地址，不支持时返回 null。 */
  thumb(source: string, size: string): Promise<string | null>;

  /**
   * 分页列举对象（导入任务用）。S3 兼容与 OneDrive 驱动实现；其他驱动不支持。
   */
  list?(
    prefix: string,
    options?: { continuation?: string; afterKey?: string; limit?: number },
  ): Promise<{
    keys: { key: string; size: number; lastModified: Date }[];
    continuation: string | null;
  }>;

  /**
   * 一键写入桶级 CORS 规则（对应上游 `StorageDriver.CORS()`）。
   * 只有 S3 兼容驱动实现；直传模式下浏览器会跨域 PUT 分片，桶上没有
   * CORS 规则时预检直接失败，前端只能看到 `Network Error`。
   */
  setCors?(): Promise<void>;
}

/** 解析策略设置里的分片大小；为 0 时用驱动默认值。 */
export function resolveChunkSize(settings: PolicySetting | null, fallback: number): number {
  const configured = settings?.chunk_size ?? 0;
  return configured > 0 ? configured : fallback;
}

/** 策略是否开启了「中转上传」（relay=true 时由服务端转发）。 */
export function isRelayEnabled(settings: PolicySetting | null): boolean {
  // 原版语义：Relay 为 true 表示客户端上传经由服务端中转。
  // 这里的默认值与核心一致——R2 与 OneDrive 均可直传，默认不中转。
  return settings?.relay === true;
}
