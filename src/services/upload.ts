/**
 * 上传服务。对应 Cloudreve v4 的 `service/explorer/upload.go` +
 * `pkg/filemanager/manager/upload.go`。
 *
 * 会话状态存在 KV（`upload_session:<id>`），与原版把 UploadSession 放进
 * KV 缓存的做法一致（原版用 gob 编码，这里用 JSON，只在本实现内部消费）。
 *
 * 上传流程：
 *   PUT    /api/v4/file/upload            创建会话 → 返回 chunk_size / upload_urls
 *   POST   /api/v4/file/upload/:sid/:idx  上传第 idx 片
 *   DELETE /api/v4/file/upload            取消会话
 * 最后一片到齐时**自动**完成上传（原版没有独立的 complete 端点）。
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { FileSystemService } from './fs';
import { generateSavePath } from './savepath';
import { FileSystemType, URI, validateName } from './uri';
import {
  EncryptionCipher,
  type EncryptMetadata,
  type EntityRow,
  type FileRow,
  type StoragePolicyRow,
  type UserWithGroup,
} from '../db/types';
import { EntityType, FileType, PolicyType } from '../lib/boolset';
import {
  AppError,
  CodeCredentialInvalid,
  CodeFileNotFound,
  CodeFileTooLarge,
  CodeFileTypeNotAllowed,
  CodeIllegalObjectName,
  CodeInvalidChunkIndex,
  CodeInvalidContentLength,
  CodeMetaMismatch,
  CodeObjectExist,
  CodeOwnerOnly,
  CodePolicyNotAllowed,
  CodeRootProtected,
  CodeStaleVersion,
  CodeUploadSessionExpired,
  Err,
} from '../lib/errors';
import { randomString, timingSafeEqual, uuidv4 } from '../lib/crypto';
import { encryptStream, importCtrKey, randomEncryptMetadata } from '../lib/encCrypto';
import { extOf } from './savepath';
import { isRelayEnabled, type UploadedPart, type UploadSession } from '../storage/types';
import { publish } from './events';
import { kvFor } from '../lib/kvRouter';

const SESSION_PREFIX = 'upload_session:';
/** 原版 uploadSentinelCheckMargin = 5 分钟 */
const SENTINEL_MARGIN_MS = 5 * 60 * 1000;

export interface CreateUploadSessionParams {  uri: string;
  size: number;
  lastModified?: number;
  mimeType?: string;
  policyId?: string;
  metadata?: Record<string, string>;
  entityType?: string;
  /** 前端声明的可用加密算法（对应上游 UploadSessionRequest.encryption_supported）。 */
  encryptionSupported?: string[];
}

export interface UploadSessionResponse {
  session_id: string;
  upload_id?: string;
  chunk_size: number;
  expires: number;
  upload_urls?: string[];
  credential?: string;
  ak?: string;
  keyTime?: string;
  completeURL?: string;
  storage_policy?: ReturnType<FileSystemService['buildPolicyInfo']>;
  uri: string;
  callback_secret: string;
  /** 直传型驱动的收尾回调地址（原版 `fs.UploadCredential.Callback`） */
  callback?: string;
  mime_type?: string;
  upload_policy?: string;
  /** 客户端加密：前端据此用 EncryptedBlob 流式加密后再上传（对齐上游 EncryptMetadata）。 */
  encrypt_metadata?: EncryptMetadata;
}

export class UploadService {
  /**
   * 上传彻底收尾后的钩子。路由层用它把「建全文索引」这类
   * 不该阻塞响应、又必须做的工作挂到 `waitUntil` 上。
   * 收尾失败（钩子抛错）不影响上传本身 —— 索引可以重建，文件不能丢。
   */
  onUploadFinished?: (file: FileRow) => void;

  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  // -------------------------------------------------------------------------
  // 创建会话
  // -------------------------------------------------------------------------

  async createSession(params: CreateUploadSessionParams): Promise<UploadSessionResponse> {
    const user = this.ctx.requireUser();

    if (!params.uri) throw Err.param('uri is required');
    if (params.size < 0) throw Err.param('Invalid file size');

    const uri = URI.parse(params.uri);
    if (uri.fsType !== FileSystemType.My) {
      throw new AppError(CodePolicyNotAllowed, 'Upload is only supported in personal file system');
    }

    const name = uri.elements.at(-1);
    if (!name) throw new AppError(CodeRootProtected, 'Cannot upload to root as a file');

    const nameError = validateName(name);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    // 策略：请求指定（必须属于用户组策略集，防越权用任意策略落盘）
    //       > 用户选中/组绑定的默认策略。
    if (params.policyId) {
      const policyId = this.ctx.codec.decodePolicyID(params.policyId);
      if (policyId === null) throw new AppError(40035, 'Storage policy not found');
      const policy = await this.ctx.assertPolicyAllowed(policyId);
      return this.startSession(policy, uri, name, params, user);
    }
    const policy = await this.ctx.preferredPolicy();
    return this.startSession(policy, uri, name, params, user);
  }

  /** 策略确定后的公共流程：约束校验 → 建会话。 */
  private async startSession(
    policy: StoragePolicyRow,
    uri: URI,
    name: string,
    params: CreateUploadSessionParams,
    user: UserWithGroup,
  ): Promise<UploadSessionResponse> {

    this.assertPolicyConstraints(policy, name, params.size);
    this.ctx.assertCapacity(params.size);

    const parentUri = uri.parent();
    const parent = await this.ctx.files.resolvePath(user.id, parentUri.elements);
    if (!parent) throw new AppError(40016, 'Parent folder does not exist');
    if (parent.type !== FileType.Folder) throw new AppError(40016, 'Parent is not a folder');

    const existing = await this.ctx.files.childByName(parent.id, name);

    // 原版语义：目标已存在且（未指定 entity_type 或已存在的不是文件）→ 报「已存在」
    if (existing) {
      const wantsNewVersion = params.entityType === 'version';
      if (!wantsNewVersion || existing.type !== FileType.File) {
        throw Err.objectExist();
      }
    }

    // 注意：sessionId 会写进 entities.upload_session_id（Postgres UUID 列），
    // 必须是合法 UUID，不能用 randomString —— 与上游 uuid.NewV4() 语义一致
    const sessionId = uuidv4();
    const callbackSecret = randomString(32);

    const savePath = generateSavePath(policy, {
      uid: user.id,
      originName: name,
      originPath: this.dirPathOf(parentUri),
    });

    // 客户端加密：策略开启 encryption 且前端声明支持 AES-256-CTR 时，生成每文件
    // 随机密钥 + IV，回传前端供 EncryptedBlob 流式加密（密文才落存储）；
    // 同一份密钥材料落 entities.enc_meta，下载时据此还原明文。
    // 密钥只存本仓库数据库，与存储后端（OneDrive/S3/R2）分离，存储方读不到明文。
    // ⚠️ 必须与前端触发条件一致：上游 `base.ts` 只在非 relay 策略下才把文件包成
    // EncryptedBlob（relay 走 Worker 中转，不加密）。若这里对 relay 也生成密钥并
    // 标记加密，下载端会把明文当密文解 → 乱码。所以 relay 策略一律不加密。
    const policyRelay =
      policy.settings?.relay === true ||
      policy.type === PolicyType.Upyun ||
      (policy.type === PolicyType.S3 && !policy.access_key);
    let encryptMeta: EncryptMetadata | undefined;
    const wantsEncryption =
      !policyRelay &&
      policy.settings?.encryption === true &&
      Array.isArray(params.encryptionSupported) &&
      params.encryptionSupported.includes(EncryptionCipher.Aes256Ctr);
    if (wantsEncryption) {
      encryptMeta = randomEncryptMetadata();
    }
    const encMetaJson = encryptMeta ? JSON.stringify(encryptMeta) : null;

    // 目标文件行：已存在则复用（新增版本），否则先建占位
    let fileRow: FileRow;
    let newFileCreated: boolean;
    if (existing) {
      fileRow = existing;
      newFileCreated = false;
      // 新版本改用（或去掉）加密时，同步文件的加密标志
      if (Boolean(existing.encrypted) !== Boolean(encryptMeta)) {
        await this.ctx.files.setEncrypted(existing.id, Boolean(encryptMeta));
      }
    } else {
      fileRow = await this.ctx.files.create({
        type: FileType.File,
        name,
        ownerId: user.id,
        parentId: parent.id,
        size: params.size,
        policyId: policy.id,
        encrypted: Boolean(encryptMeta),
      });
      newFileCreated = true;
    }

    // 实体：占位，等上传完成后写入真实大小并清掉 upload_session_id
    const entity = await this.ctx.entities.create({
      type: EntityType.Version,
      source: savePath,
      size: params.size,
      policyId: policy.id,
      createdBy: user.id,
      uploadSessionId: sessionId,
      encMeta: encMetaJson,
    });

    const expireAt = Date.now() + this.ctx.settings.uploadSessionTTL * 1000;

    const session: UploadSession = {
      id: sessionId,
      policy,
      uid: user.id,
      fileId: fileRow.id,
      entityId: entity.id,
      savePath,
      size: params.size,
      chunkSize: 0,
      parts: [],
      chunksReceived: [],
      callbackSecret,
      expireAt,
      newFileCreated,
      mimeType: params.mimeType ?? '',
    };

    const driver = this.ctx.driverFor(policy);
    const credential = await driver.token(session, {
      savePath,
      fileName: name,
      size: params.size,
      mimeType: params.mimeType ?? '',
      overwrite: !newFileCreated,
      metadata: params.metadata,
    });

    // driver 可能在 token 阶段决定分片大小与 uploadId，回写到会话
    session.chunkSize = credential.chunk_size;

    // 加密上传：强制分片大小为 16 的倍数。前端按 chunk_size 切片加密，
    // 只有当每片起点都落在 AES 块边界上时，其效果才等价于单流 AES-CTR；
    // 否则密文无法按单流解密。常规驱动 (5/10 MiB) 本来就对齐，这里只作兜底。
    if (encryptMeta && session.chunkSize > 0 && session.chunkSize % 16 !== 0) {
      session.chunkSize = Math.max(16, Math.floor(session.chunkSize / 16) * 16);
    }

    await this.saveSession(session);

    const response: UploadSessionResponse = {
      session_id: sessionId,
      chunk_size: session.chunkSize,
      expires: credential.expires,
      uri: uri.toString(),
      callback_secret: callbackSecret,
      storage_policy: this.fs.buildPolicyInfo(policy),
    };
    if (credential.uploadID) response.upload_id = credential.uploadID;
    if (credential.upload_urls) response.upload_urls = credential.upload_urls;
    if (credential.completeURL) response.completeURL = credential.completeURL;
    if (credential.ak) response.ak = credential.ak;
    if (credential.keyTime) response.keyTime = credential.keyTime;
    if (credential.credential) response.credential = credential.credential;
    if (params.mimeType) response.mime_type = params.mimeType;
    // 客户端加密：前端拿到后把文件流包成 EncryptedBlob 再分片上传
    if (encryptMeta) response.encrypt_metadata = encryptMeta;

    // OneDrive 直传的收尾回调地址。原版由驱动自己拼（`onedrive.go:167` 调
    // `routes.MasterSlaveCallbackUrl(siteURL, PolicyTypeOd, sessionID, CallbackSecret)`），
    // 路径形状是 `<site>/api/v4/callback/<driver>/<sessionID>/<secret>`。
    // 只有 OneDrive 需此字段，其余驱动不返回 —— 与原版一致。
    if (policy.type === PolicyType.OneDrive) {
      const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
      response.callback = `${base}/api/v4/callback/onedrive/${sessionId}/${callbackSecret}`;
    }

    return response;
  }

  /** 对象键模板里的 `{path}`：文件所在的网盘目录，以 `/` 结尾。 */
  private dirPathOf(dirUri: URI): string {
    if (dirUri.isRoot) return '';
    return `${dirUri.path.replace(/\/+$/, '')}/`;
  }

  /** 策略级限制：单文件大小上限、扩展名黑白名单、名称正则。 */
  private assertPolicyConstraints(policy: StoragePolicyRow, name: string, size: number): void {
    const maxSize = Number(policy.max_size ?? 0);
    if (maxSize > 0 && size > maxSize) {
      throw new AppError(CodeFileTooLarge, `File size exceeds the policy limit of ${maxSize} bytes`);
    }

    const settings = policy.settings ?? {};
    const ext = extOf(name).replace(/^\./, '').toLowerCase();

    if (settings.file_type && settings.file_type.length > 0) {
      const listed = settings.file_type.map((e) => e.replace(/^\./, '').toLowerCase());
      const inList = listed.includes(ext);
      const isDenyList = settings.is_file_type_deny_list === true;
      if (isDenyList ? inList : !inList) {
        throw new AppError(CodeFileTypeNotAllowed, `File type "${ext}" is not allowed by this policy`);
      }
    }

    if (settings.file_regexp) {
      let re: RegExp;
      try {
        re = new RegExp(settings.file_regexp);
      } catch {
        re = /^$/;
      }
      const matches = re.test(name);
      if (settings.is_name_regexp_deny_list ? matches : !matches) {
        throw new AppError(CodeFileTypeNotAllowed, 'File name is not allowed by this policy');
      }
    }
  }

  // -------------------------------------------------------------------------
  // 分片上传
  // -------------------------------------------------------------------------

  async uploadChunk(
    sessionId: string,
    index: number,
    body: ReadableStream,
    contentLength: number,
  ): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new AppError(CodeUploadSessionExpired, 'Upload session expired');
    if (session.uid !== this.ctx.requireUser().id) throw Err.noPermission();

    if (!Number.isInteger(index) || index < 0) {
      throw new AppError(CodeInvalidChunkIndex, 'Invalid chunk index');
    }

    const expected = this.expectedChunkLength(session, index);
    if (expected !== null && contentLength !== expected) {
      throw new AppError(
        CodeInvalidContentLength,
        `Invalid content length: expected ${expected}, got ${contentLength}`,
      );
    }

    const driver = this.ctx.driverFor(session.policy);
    const part = await driver.writeChunk(session, index, body, contentLength);

    if (part) {
      session.parts = [...(session.parts ?? []).filter((p) => p.partNumber !== part.partNumber), part];
    }
    session.chunksReceived = Array.from(new Set([...(session.chunksReceived ?? []), index]));

    if (this.isUploadComplete(session)) {
      await this.finishUpload(session);
      // 上传成功后**只清 KV 会话**，绝不能走 `discardSession` ——
      // 那会把刚转正的实体和文件行一起删掉（见该方法注释）。
      await this.deleteSessionRecord(sessionId);
      return;
    }

    await this.saveSession(session);
  }

  /**
   * OneDrive 直传完成后的回调。对应原版
   * `routers/router.go:497-505` 的 `POST /api/v4/callback/onedrive/:sessionID/:key`
   * → `middleware.UseUploadSession(types.PolicyTypeOd)` → `callback.ProcessCallback`
   * → `manager.CompleteUpload`。
   *
   * 直传模式下字节不经过 Worker，`uploadChunk` 永远收不到最后一片，所以
   * 「实体转正 + 容量记账」只能由客户端打完最后一字节后回调这个端点触发。
   * 授权凭据就是 URL 里的 `key`（等于会话的 `callbackSecret`），
   * 与原版一样做常量时间比较（`middleware/auth.go:208-213`）。
   */
  async completeByCallback(sessionId: string, key: string): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (!session) {
      throw new AppError(CodeUploadSessionExpired, 'Upload session does not exist or expired');
    }
    if (!key || !timingSafeEqual(session.callbackSecret, key)) {
      throw new AppError(CodeCredentialInvalid, 'Invalid callback secret');
    }
    // 原版 `middleware/auth.go:216-218`：策略类型不符报 CodePolicyNotAllowed。
    // S3 系直传（s3/oss/cos/obs/qiniu/ks3）与 OneDrive 一样需要客户端回调转正：
    // 字节不经过 Worker，CompleteMultipartUpload 由前端用预签名 completeURL 完成。
    const S3_FAMILY: string[] = [PolicyType.S3, PolicyType.Oss, PolicyType.Cos, PolicyType.Obs, PolicyType.Qiniu, PolicyType.Ks3];
    if (session.policy.type !== PolicyType.OneDrive && !S3_FAMILY.includes(session.policy.type)) {
      throw new AppError(CodePolicyNotAllowed, 'Policy type mismatch');
    }

    await this.finishUpload(session);
    await this.deleteSessionRecord(sessionId);
  }

  /**
   * 期望的分片长度。
   * chunkSize 为 0 表示整文件单次上传，此时只有 index 0 合法，长度等于文件大小。
   */
  private expectedChunkLength(session: UploadSession, index: number): number | null {
    if (session.chunkSize <= 0) {
      if (index !== 0) {
        throw new AppError(CodeInvalidChunkIndex, 'Chunk index cannot be greater than 0');
      }
      return session.size;
    }
    const totalChunks = Math.max(1, Math.ceil(session.size / session.chunkSize));
    if (index >= totalChunks) {
      throw new AppError(CodeInvalidChunkIndex, 'Invalid chunk index');
    }
    const isLast = index === totalChunks - 1;
    return isLast ? session.size - index * session.chunkSize : session.chunkSize;
  }

  private isUploadComplete(session: UploadSession): boolean {
    const totalChunks = session.chunkSize <= 0 ? 1 : Math.max(1, Math.ceil(session.size / session.chunkSize));
    const received = new Set(session.chunksReceived ?? []);
    for (let i = 0; i < totalChunks; i++) {
      if (!received.has(i)) return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------

  private async finishUpload(session: UploadSession): Promise<void> {
    // 快速重试拦截：已完成过的会话直接跳过（省掉一次远端 completeUpload）。
    // 注意 KV 写是弱一致、且这里是 check-then-set，单独靠它挡不住真并发 ——
    // 防重复容量记账由下面「记账前的 DB 原子抢占」兜底。
    const doneKey = `upload:done:${session.id}`;
    const uploadKv = kvFor(this.ctx.env, 'upload');
    try {
      if (await uploadKv.get(doneKey)) return;
    } catch {
      // 标记读不到就当没完成，照常收尾（不阻断上传）
    }

    const driver = this.ctx.driverFor(session.policy);

    // 覆盖前的文件快照：既用于事件类型判定（create vs modify），
    // 也用于容量预占失败时把「转正」回滚回去。
    const prev = session.fileId ? await this.ctx.files.byId(session.fileId) : null;
    const hadContent = prev?.primary_entity != null;

    await driver.completeUpload(session);

    // 哨兵式校验：远端大小必须与声明一致（原版 CodeMetaMismatch）
    try {
      const meta = await driver.meta(session.savePath);
      if (meta && session.size > 0 && meta.size !== session.size) {
        // OneDrive 对 SharePoint 有 1MB 容忍，这里统一给 1MB
        if (Math.abs(meta.size - session.size) > 1024 * 1024) {
          throw new AppError(
            CodeMetaMismatch,
            `File size mismatch: expected ${session.size}, got ${meta.size}`,
          );
        }
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      // 校验本身失败（网络问题等）不阻断上传
    }

    // 实体转正：补全大小并挂到文件上。
    // 注意别在这里提前调用 clearUploadSession —— 它会无条件把 upload_session_id
    // 清零，导致下面「记账前的原子抢占」永远抢不到（条件就是它仍等于本会话），
    // 结果是容量永远不记账。清零由 claimUploadSession 一并完成。
    await this.ctx.entities.updateSize(session.entityId, session.size);
    await this.ctx.entities.linkFile(session.fileId, session.entityId);
    await this.ctx.files.updatePrimaryEntity(session.fileId, session.entityId);
    await this.ctx.files.updateSize(session.fileId, session.size);

    // 容量记账必须且只能记一次 —— 重复记账等于白扣用户空间，是最危险的一步。
    // KV 标记是弱一致 + check-then-set，并发下两者都会通过检查；这里用 DB 行锁做
    // 原子抢占：只有第一个请求能把 entities.upload_session_id 清零并继续记账。
    // 放在记账前而不是函数开头，是为了保留「收尾中途失败后可重试」的能力。
    const claimed = await this.ctx.entities.claimUploadSession(session.entityId, session.id);
    if (!claimed) return; // 已被并发/重试的另一次收尾记账（其上的转正操作都是幂等的）

    // 容量记账：走数据库原子预占，而不是「读快照 → 判断 → 自增」。
    // 先查后记在并发下会让多个上传同时通过检查、最后一起超配额；预占把判定和
    // 自增压进同一条 UPDATE，由行锁串行化（对应上游 UsersRepo.ReserveStorage）。
    // 预占失败必须把上面三步「转正」回滚：容量没记上，内容就不能留在文件上。
    const reserved = await this.ctx.users.reserveStorage(
      session.uid,
      session.size,
      this.ctx.maxStorage,
    );
    if (!reserved) {
      await this.ctx.entities.unlinkFile(session.fileId, session.entityId);
      await this.ctx.files.updatePrimaryEntity(session.fileId, prev?.primary_entity ?? null);
      await this.ctx.files.updateSize(session.fileId, prev?.size ?? 0);
      this.ctx.throwCapacity();
    }

    // 清理同一文件下其它未完成会话遗留的占位实体
    const entities = await this.ctx.entities.listByFile(session.fileId);
    for (const e of entities) {
      if (e.id !== session.entityId && e.upload_session_id !== null) {
        await this.ctx.entities.unlinkFile(session.fileId, e.id);
      }
    }

    // 按版本保留策略裁剪历史版本（原版 `dbfs/upload.go:305-351` 的 CapEntities）
    const target = await this.ctx.files.byId(session.fileId);
    await this.capVersionEntities(session.fileId, session.uid, target?.name ?? null);

    logAudit(this.ctx, 'entity_uploaded', session.uid, {
      name: target?.name,
      size: session.size,
    });

    if (target && this.onUploadFinished) {
      // 钩子抛错不影响上传结果（收尾已经完成，这里只是附加工作）
      try {
        this.onUploadFinished(target);
      } catch (e) {
        console.error('onUploadFinished hook failed', e);
      }
    }

    // 通知同 isolate 内的 SSE 订阅者（前端文件列表实时刷新）
    if (target) {
      try {
        publish(target.file_children ?? 0, {
          type: hadContent ? 'modify' : 'create',
          file_id: this.ctx.codec.encodeFileID(target.id),
          from: '',
          to: target.name,
        });
      } catch {
        // 事件推送失败不影响上传结果
      }
    }

    // 收尾成功，打上完成标记（后续重复请求可快速跳过）。TTL 10 分钟足够覆盖一次上传的并发窗口。
    try {
      await uploadKv.put(doneKey, '1', { expirationTtl: 600 });
    } catch {
      // 标记写失败不阻断上传
    }
  }

  /**
   * 裁剪文件的历史版本实体。对应原版 `inventory/file.go:856-883` 的 `CapEntities`：
   * 只看 `type = Version` 的实体，按 ID 倒序保留前 `max` 个，其余解除引用。
   * 引用归零的实体同时删除物理对象并回冲用户容量。
   *
   * `max` 的取值照抄原版 `dbfs/upload.go:308-318`：
   *   - 默认 1；
   *   - 用户打开了 `version_retention`、且（`version_retention_ext` 为空或当前文件
   *     扩展名在名单里）时，取 `version_retention_max`，为 0 表示不限制。
   *   注意这两个开关在**用户**的 `settings` 上，不在用户组上。
   */
  private async capVersionEntities(
    fileId: number,
    ownerId: number,
    fileName: string | null,
  ): Promise<void> {
    const owner = await this.ctx.users.byId(ownerId);
    const userSetting = owner?.settings ?? null;

    let max = 1;
    if (userSetting?.version_retention) {
      const extList = userSetting.version_retention_ext ?? [];
      const ext = fileName ? extOf(fileName).slice(1).toLowerCase() : '';
      if (extList.length === 0 || (ext && extList.includes(ext))) {
        const configured = userSetting.version_retention_max ?? 0;
        max = configured === 0 ? Number.MAX_SAFE_INTEGER : configured;
      }
    }

    const versions = (await this.ctx.entities.listByFile(fileId))
      .filter((e) => e.type === EntityType.Version)
      .sort((a, b) => b.id - a.id);

    if (versions.length <= max) return;
    const toCap = versions.slice(max);
    if (toCap.length === 0) return;

    for (const e of toCap) await this.ctx.entities.unlinkFile(fileId, e.id);

    const garbage = await this.ctx.entities.release(toCap.map((e) => e.id));
    for (const entity of garbage) {
      try {
        const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
        if (policy) await this.ctx.driverFor(policy).delete([entity.source]);
      } catch {
        // 物理删除失败不回滚数据库（与原版一致，留待人工清理）
      }
      if (entity.created_by) {
        await this.ctx.users.addStorage(entity.created_by, -Number(entity.size));
      }
    }
    await this.ctx.entities.hardDelete(garbage.map((e) => e.id));
  }

  // -------------------------------------------------------------------------
  // 覆盖内容（PUT /api/v4/file/content）
  // -------------------------------------------------------------------------

  /**
   * 覆盖已有文件的内容。对应原版 `FileUpdateService.PutContent` → `manager.Update`。
   *
   * 原版的语义是**新增一个版本实体**，而不是就地改写：
   *   - 先按 `maxEditSize`（默认 50MB）挡掉超大请求；
   *   - 容量按**新文件全量**预留（旧实体作为历史版本继续占空间）；
   *   - 之后由 `CapEntities` 按用户的版本保留策略裁剪旧版本（见 `capVersionEntities`）。
   *   - 新实体写到**全新的对象键**（`generateSavePath`），旧对象原地不动 ——
   *     否则旧版本行会指向被覆盖后的内容，历史版本就失真了。
   */
  async overwriteContent(
    uri: URI,
    body: ReadableStream,
    length: number,
    mimeType: string,
    options: { ignoreMaxEdit?: boolean; previous?: string } = {},
  ): Promise<void> {
    const user = this.ctx.requireUser();
    const file = await this.fs.mustResolve(uri);
    if (file.type !== FileType.File) {
      throw new AppError(CodeFileNotFound, 'Target is not a file');
    }
    if (file.owner_id !== user.id && !this.ctx.isAdmin) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }

    // 乐观锁（原版 UpdateContent 的 previous 参数）：编辑器保存时带上打开时的
    // 实体 hashid，与当前 primary_entity 不一致说明文件已被别人/别的窗口改过
    // → StaleVersion(40076)，前端据此弹「文件已被修改」冲突对话框。
    // 没有这一步，两处同时编辑会静默互相覆盖（后保存者赢）。
    if (options.previous) {
      const prevId = this.ctx.codec.decodeEntityID(options.previous);
      if (prevId === null || prevId !== file.primary_entity) {
        throw new AppError(CodeStaleVersion, 'File has been modified by others');
      }
    }

    // WebDAV 的 PUT 也是覆盖写，但它不该受「在线编辑」的体积限制（上游 WebDAV
    // 直接走 fm.Upload，同样没有 maxEditSize 一说）
    if (!options.ignoreMaxEdit) {
      const maxEdit = this.ctx.settings.getInt('maxEditSize', 52428800);
      if (maxEdit > 0 && length > maxEdit) {
        throw new AppError(
          CodeFileTooLarge,
          `File size exceeds the online edit limit of ${maxEdit} bytes`,
        );
      }
    }

    const policy = await this.ctx.resolvePolicy(file.storage_policy_files);
    const driver = this.ctx.driverFor(policy);

    // 原版 `Update` 走 `ModeOverwrite`：建**新**实体，旧实体留作历史版本。
    // 容量按新文件全量记账，历史版本的去留交给 `maxEditSize` 之后的 CapEntities。
    this.ctx.assertCapacity(length);

    const savePath = generateSavePath(policy, {
      uid: user.id,
      originName: file.name,
      originPath: this.dirPathOf(uri.parent()),
    });

    // 覆盖写要保持加密，两种情形都要覆盖到：
    //   1. 原文件已是加密实体（prevEntity.enc_meta）—— 不能编辑一次就降级成明文；
    //   2. 策略开启了 encryption（但非 relay）—— 在加密策略上新建的空文件
    //      （POST /file/create 无实体）首次保存时也要加密。
    // 做法：为本次新版本生成新密钥，把编辑器 / WebDAV 送来的明文流在 Worker 内
    // 加密后再落存储，密钥记到新实体上。
    const prevEntity = file.primary_entity
      ? await this.ctx.entities.byId(file.primary_entity)
      : null;
    const editPolicyRelay =
      policy.settings?.relay === true ||
      policy.type === PolicyType.Upyun ||
      (policy.type === PolicyType.S3 && !policy.access_key);
    const shouldEncrypt =
      !!prevEntity?.enc_meta || (policy.settings?.encryption === true && !editPolicyRelay);
    let encMetaJson: string | null = null;
    let putBody = body;
    if (shouldEncrypt) {
      const meta = randomEncryptMetadata();
      encMetaJson = JSON.stringify(meta);
      const { key, iv } = await importCtrKey(meta, 'encrypt');
      putBody = encryptStream(body, key, iv);
    }

    const entity = await this.ctx.entities.create({
      type: EntityType.Version,
      source: savePath,
      size: length,
      policyId: policy.id,
      createdBy: user.id,
      encMeta: encMetaJson,
    });

    await driver.put(
      { savePath, fileName: file.name, size: length, mimeType, overwrite: false },
      putBody,
      length,
    );

    await this.ctx.entities.linkFile(file.id, entity.id);
    await this.ctx.files.updatePrimaryEntity(file.id, entity.id);
    await this.ctx.files.updateSize(file.id, length);
    if (Boolean(file.encrypted) !== Boolean(encMetaJson)) {
      await this.ctx.files.setEncrypted(file.id, Boolean(encMetaJson));
    }

    // 容量记账同样走原子预占（并发保存不会一起突破配额）。
    // 失败要回滚上面三步：没记上容量就不能把新内容当成主版本。
    const reserved = await this.ctx.users.reserveStorage(user.id, length, this.ctx.maxStorage);
    if (!reserved) {
      await this.ctx.entities.unlinkFile(file.id, entity.id);
      await this.ctx.files.updatePrimaryEntity(file.id, file.primary_entity);
      await this.ctx.files.updateSize(file.id, Number(file.size));
      this.ctx.throwCapacity();
    }

    // 新旧实体同在一张 file_entities 里，按版本保留策略裁剪（与上传提交同一条路径）
    await this.capVersionEntities(file.id, file.owner_id, file.name);
  }

  // -------------------------------------------------------------------------
  // 取消
  // -------------------------------------------------------------------------

  /**
   * 用户主动取消上传（`DELETE /api/v4/file/upload`，对应原版 `DeleteUploadSession`）。
   *
   * ⚠️ 这个方法会**销毁**会话关联的实体，必要时连文件行一起删 —— 只适用于
   * 「上传没成功、要把半成品清掉」的场景。上传成功后**必须**改用
   * `deleteSessionRecord`，否则会把刚上传好的文件删掉。
   */
  async deleteSession(sessionId: string, uriHint?: string): Promise<void> {
    const session = await this.loadSession(sessionId);
    if (session) {
      // 会话属主校验：与 uploadChunk 同款（原版 UseUploadSession 中间件
      // 对会话 UID 与请求者做一致性检查，防登录用户互删上传会话）
      if (session.uid !== this.ctx.requireUser().id) throw Err.noPermission();
      await this.discardSession(session);
      return;
    }

    // 会话已过期：如果带了 uri，尝试按 uri 找到残留的占位文件清理掉
    if (uriHint) {
      try {
        const uri = URI.parse(uriHint);
        const file = await this.ctx.files.resolvePath(this.ctx.requireUser().id, uri.elements);
        if (file && file.type === FileType.File && !file.primary_entity) {
          await this.ctx.files.deleteMany([file.id]);
        }
      } catch {
        // 尽力而为
      }
    }
    throw new AppError(CodeUploadSessionExpired, 'Upload session expired');
  }

  /**
   * 丢弃一个上传会话：撤销远端会话、回收占位实体（必要时连文件行）。
   * 公开给从节点回调（`/api/v4/slave/statelessUpload/failed`）用。
   */
  async discardSession(session: UploadSession): Promise<void> {
    const driver = this.ctx.driverFor(session.policy);
    try {
      await driver.cancelToken(session);
    } catch {
      // 忽略远端清理失败
    }
    // 占位实体与占位文件一并回收
    await this.ctx.entities.unlinkFile(session.fileId, session.entityId);
    await this.ctx.entities.hardDelete([session.entityId]);
    if (session.newFileCreated) {
      await this.ctx.files.deleteMany([session.fileId]);
    }
    await this.deleteSessionRecord(session.id);
  }

  /** 当前用户的上传会话数量（用于后台/调试）。 */
  async listOwnSessionIds(userId: number): Promise<string[]> {
    const list = await kvFor(this.ctx.env, 'upload').list({ prefix: SESSION_PREFIX, limit: 1000 });
    const out: string[] = [];
    for (const key of list.keys) {
      const session = (await kvFor(this.ctx.env, 'upload').get(key.name, 'json')) as UploadSession | null;
      if (session?.uid === userId) out.push(session.id);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // KV 存取
  // -------------------------------------------------------------------------

  private async saveSession(session: UploadSession): Promise<void> {
    const ttl = Math.max(60, Math.floor((session.expireAt - Date.now()) / 1000) + SENTINEL_MARGIN_MS / 1000);
    await kvFor(this.ctx.env, 'upload').put(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session), {
      expirationTtl: ttl,
    });
  }

  /**
   * 给从节点建上传会话：走与客户端完全相同的约束校验（策略、配额、命名），
   * 但返回**完整会话**而不是客户端响应 —— 节点需要 `save_path`（它要把字节
   * 写到自己磁盘的这个位置）、`chunk_size` 和 `entity_id`。
   */
  async prepareStatelessUpload(params: CreateUploadSessionParams): Promise<UploadSession> {
    const res = await this.createSession(params);
    const session = await this.loadSession(res.session_id);
    if (!session) {
      throw new AppError(CodeUploadSessionExpired, 'Upload session was not persisted');
    }
    return session;
  }

  /**
   * 取上传会话。公开是因为从节点回调（`/api/v4/slave/statelessUpload/complete`）
   * 也要按 id 读会话 —— 那条路的「用户」由节点在 user_id 里声明，鉴权靠节点的
   * HMAC 密钥，所以不能再走 requireUser 的属主校验。
   */
  async loadSession(sessionId: string): Promise<UploadSession | null> {
    const raw = await kvFor(this.ctx.env, 'upload').get(`${SESSION_PREFIX}${sessionId}`, 'json');
    return (raw as UploadSession | null) ?? null;
  }

  /**
   * 从节点回调用的收尾（`POST /api/v4/slave/statelessUpload/complete`）。
   *
   * 与客户端分片上传的收尾是同一条路：实体转正、容量原子预占、清理遗留占位。
   * 区别只在于「字节是谁写的」—— 从节点把文件写在自己的磁盘上，所以这里
   * 不再有分片进度可校验，由调用方保证内容已就位（哨兵校验仍会跑一次
   * `driver.meta` 比对大小）。
   */
  async completeStatelessSession(session: UploadSession): Promise<void> {
    await this.finishUpload(session);
  }

  private async deleteSessionRecord(sessionId: string): Promise<void> {
    await kvFor(this.ctx.env, 'upload').delete(`${SESSION_PREFIX}${sessionId}`);
  }
}

export { SESSION_PREFIX as UPLOAD_SESSION_PREFIX };

/** 「中转上传」判定：策略开了 relay，或驱动不支持直传。 */
export function shouldRelayByPolicy(policy: StoragePolicyRow): boolean {
  return isRelayEnabled(policy.settings);
}

export type { EntityRow, FileRow };
export type { UploadedPart };
