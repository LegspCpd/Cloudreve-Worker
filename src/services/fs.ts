/**
 * 文件系统服务。对应 Cloudreve v4 的 `pkg/filemanager/fs/dbfs/` 一族 navigator，
 * 但把 `my` / `trash` / `share` / `shared_with_me` 四种文件系统合并到一个实现里。
 *
 * 数据模型要点（回源码确认过）：
 *   - 根目录：`name = ''` 且 `file_children IS NULL`
 *   - 回收站项：`file_children IS NULL` 且 `name <> ''`
 *     （删除 = 把父指针置空但保留名字；恢复 = 把父指针指回去）
 *   - 目录内容：`file_children = 父 id`
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { SearchService } from './search';
import { FileSystemType, URI, validateName } from './uri';
import type { ExplorerView, FileRow, MetadataRow, StoragePolicyRow } from '../db/types';
import { BooleanSet, EntityType, FileType, GroupPermission, PolicyType } from '../lib/boolset';
import { isPolicyTypeSupported } from '../storage';

/**
 * 文件系统能力位。位序**严格对齐**上游 `pkg/filemanager/fs/dbfs/navigator.go`
 * 的 iota 顺序（与前端 `api/explorer.ts` 的 NavigatorCapability 枚举一一对应）：
 *   0 create_file, 1 rename_file, 6 upload_file, 7 download_file,
 *   8 update_metadata, 9 list_children, 10 generate_thumb, 14 delete_file,
 *   15 lock_file, 16 soft_delete, 17 restore, 18 share, 19 info,
 *   20 version_control, 23 enter_folder, 24 modify_props。
 *
 * ⚠️ 这是独立于 GroupPermission 的另一套位表 —— 两者位号完全不同，
 * 混用会让前端 `new Boolset(capability).enabled(NavigatorCapability.x)`
 * 查错位（曾因此把「新建文件夹/文件/上传」整组菜单吞掉）。
 */
export const NavigatorCapability = {
  CreateFile: 0,
  RenameFile: 1,
  UploadFile: 6,
  DownloadFile: 7,
  UpdateMetadata: 8,
  ListChildren: 9,
  GenerateThumb: 10,
  DeleteFile: 14,
  LockFile: 15,
  SoftDelete: 16,
  Restore: 17,
  Share: 18,
  Info: 19,
  VersionControl: 20,
  EnterFolder: 23,
  ModifyProps: 24,
} as const;
import {
  AppError,
  CodeAnonymouseAccessDenied,
  CodeEntityNotExist,
  CodeFileCountLimitedReached,
  CodeFileNotFound,
  CodeGroupNotAllowed,
  CodeIllegalObjectName,
  CodeIncorrectPassword,
  CodeNoPermissionErr,
  CodeObjectExist,
  CodeOwnerOnly,
  CodeParentNotExist,
  CodePolicyNotAllowed,
  CodePurchaseRequired,
  CodeRootProtected,
  CodeSaveOwnShare,
  Err,
} from '../lib/errors';
import { whitelist } from '../db/repo';
import {
  MetadataExpectedCollectTime,
  MetadataRestoreUri,
  MetadataSharedRedirect,
  MetadataUploadSessionID,
} from '../lib/sysmeta';
import { isShareInvalid } from './share-rules';
import { publish } from './events';

/**
 * 拼父子路径。父路径是 `/`（根目录）时避免出现 `//name`。
 * 与 `pathOf()` 的输出格式保持一致（都以 `/` 开头）。
 */
function joinPath(parentPath: string, name: string): string {
  if (parentPath === '/' || parentPath === '') return `/${name}`;
  return `${parentPath.replace(/\/+$/, '')}/${name}`;
}

/** 向同 isolate 的 SSE 订阅者广播一条文件事件（失败静默，不影响主流程）。 */
function notifyFsEvent(
  ctx: AppContext,
  file: FileRow,
  type: 'create' | 'modify' | 'rename' | 'delete',
  from: string,
  to: string,
): void {
  try {
    publish(file.file_children ?? 0, {
      type,
      file_id: ctx.codec.encodeFileID(file.id),
      from,
      to,
    });
  } catch {
    // 事件推送失败不影响主流程
  }
}

// ---------------------------------------------------------------------------
// 响应结构。字段与 json tag 取自 `service/explorer/response.go`。
// ---------------------------------------------------------------------------

export interface FileResponse {
  type: number;
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  size: number;
  metadata: Record<string, string>;
  path?: string;
  shared?: boolean;
  capability?: string;
  owned?: boolean;
  primary_entity?: string;
  folder_summary?: FolderSummary;
  extended_info?: ExtendedInfo;
}

export interface FolderSummary {
  size: number;
  files: number;
  folders: number;
  completed: boolean;
  calculated_at: string;
}

export interface DirectLinkInfo {
  id: string;
  url: string;
  downloaded: number;
  created_at: string;
  /** 文件 URI（如 `file:///path/to/file`），前端直链创建接口需要。 */
  file_url?: string;
  /** 直链 URL（前端直链契约字段名是 link，非 url）。 */
  link?: string;
}

export interface StoragePolicyInfo {
  id: string;
  name: string;
  type: string;
  max_size: number;
  relay?: boolean;
  chunk_concurrency?: number;
  encryption?: boolean;
  allowed_suffix?: string[];
  denied_suffix?: string[];
  allowed_name_regexp?: string;
  denied_name_regexp?: string;
}

export interface EntityInfo {
  id: string;
  size: number;
  type: number;
  created_at: string;
  /** 该实体所在的存储策略（原版 `BuildEntity` 恒带此字段）。 */
  storage_policy?: StoragePolicyInfo;
}

export interface ExtendedInfo {
  storage_policy?: StoragePolicyInfo;
  storage_used: number;
  entities?: EntityInfo[];
  view?: ExplorerView;
  direct_links?: DirectLinkInfo[];
}

export interface PaginationResults {
  page: number;
  page_size: number;
  total_items?: number;
  next_token?: string;
  is_cursor?: boolean;
}

export interface NavigatorProps {
  capability: string;
  max_page_size: number;
  order_by_options: string[];
  order_direction_options: string[];
}

export interface ListResponse {
  files: FileResponse[];
  parent?: FileResponse;
  pagination: PaginationResults;
  props: NavigatorProps;
  mixed_type: boolean;
  recursion_limit_reached?: boolean;
  /** 单文件分享视图（上游 ListResponse.SingleFileView，response.go:257）。 */
  single_file_view?: boolean;
  /**
   * 当前目录的「首选」存储策略（上游 `ListResponse.StoragePolicy`，取父目录
   * 属主所在用户组绑定的策略，dbfs.go:669 getPreferredPolicy）。前端上传器
   * 靠它初始化 —— 缺失时点「上传」直接抛 No policy selected，文件选择器
   * 都不会打开。
   */
  storage_policy?: StoragePolicyInfo;
  /**
   * 组绑定的全部可选策略（edge 自建 Pro 功能）。多于一个时下发，
   * 前端文件页切换器据此渲染；上游开源版无此字段。
   */
  storage_policies?: StoragePolicyInfo[];
}

export interface BuildFileOptions {
  /** 附带扩展信息（存储策略、实体、直链等），仅单个文件详情时用 */
  extended?: boolean;
  /** 附带文件夹摘要（会做一次递归统计，列表接口不要开） */
  folderSummary?: boolean;
  /** 是否已被分享 */
  shared?: boolean;
  /** 当前访问者是否拥有该文件 */
  owned?: boolean;
  /**
   * 该文件在**调用方视角**下的 URI，用于填充响应里的 `path`。
   * 分享 / 指定所有者的 my 空间必须传，否则会退化成 `cloudreve://my/...`，
   * 前端后续请求就会打到自己的空间里去。
   */
  uri?: URI;
  /**
   * 覆盖响应里的 `name`。只有回收站场景会用到：那里的 `files.name` 是随机串，
   * 显示名要取 `sys:restore_uri` 的最后一段（原版 `File.DisplayName()`）。
   */
  displayName?: string;
  /**
   * 预先算好的「用户视角路径」。列表接口里同目录所有条目共享一条祖先链，
   * 由调用方算一次后传入，避免每个文件各走一次 `pathOf()`（深度 × 条目的
   * 串行数据库查询 —— 实测这是列目录最贵的一块）。
   * 不传时回退到旧的逐文件 `pathOf()`。
   */
  precomputedPath?: string;
}

const ORDER_BY_OPTIONS = ['name', 'size', 'updated_at', 'created_at'];
const ORDER_DIRECTION_OPTIONS = ['asc', 'desc'];

// ---------------------------------------------------------------------------
// 系统元数据键（回收站的 restore_uri 等）统一放在 lib/sysmeta.ts，
// 这里既本地引用、也重新导出，方便调用方就近取。
// ---------------------------------------------------------------------------

export {
  MetadataSysPrefix,
  MetadataRestoreUri,
  MetadataExpectedCollectTime,
} from '../lib/sysmeta';

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export class FileSystemService {
  constructor(private readonly ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // 定位
  // -------------------------------------------------------------------------

  /**
   * 把 URI 解析成文件行。
   * 根目录返回根目录行；路径不存在返回 null。
   */
  async resolve(uri: URI): Promise<FileRow | null> {
    switch (uri.fsType) {
      case FileSystemType.My:
        return this.resolveMy(uri);
      case FileSystemType.Trash:
        return this.resolveTrash(uri);
      case FileSystemType.Share:
        return this.resolveShare(uri);
      case FileSystemType.SharedWithMe:
        return this.resolveSharedWithMe(uri);
      default:
        throw new AppError(CodeFileNotFound, `Unsupported file system: ${uri.fsType}`);
    }
  }

  /** 解析失败即抛 40044。 */
  async mustResolve(uri: URI): Promise<FileRow> {
    const file = await this.resolve(uri);
    if (!file) throw Err.fileNotFound();
    return file;
  }

  private async resolveMy(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    // 支持 `cloudreve://<userHashid>@my/...` 指定所有者，但**只允许自己**。
    // 原版 my_navigator.go:85 —— `if fsUid != n.user.ID { return ErrPermissionDenied }`，
    // 管理员也没有后门，这里保持一致。
    let ownerId = user.id;
    if (uri.id) {
      const decoded = this.ctx.codec.decodeUserID(uri.id);
      if (decoded === null) throw Err.fileNotFound();
      if (decoded !== user.id) {
        throw new AppError(CodeNoPermissionErr, 'Permission denied');
      }
      ownerId = decoded;
    }
    const root = await this.ctx.files.ensureRoot(ownerId);
    return this.walk(root, uri.elements);
  }

  private async resolveTrash(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    const elements = uri.elements;
    if (elements.length === 0) return null; // 回收站没有根节点
    if (elements.length > 1) {
      throw new AppError(CodeFileNotFound, `Invalid path ${uri.path}`);
    }
    const name = elements[0]!;
    const rows = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      trash: true,
      page: 0,
      pageSize: 1000,
      orderBy: 'name',
      orderDirection: 'asc',
      nameKeyword: name,
    });
    return rows.files.find((f) => f.name === name) ?? null;
  }

  /**
   * 分享空间的定位。校验顺序严格照抄原版 `share_navigator.go` 的 `Root()`：
   *   1. 解 hashid 取分享，取不到 → shareNotFound；
   *   2. `IsValidShare`：过期 / 分享者非 active / 源文件已删（回收站或根）→ shareNotFound；
   *   3. 密码：`share.password != "" && share.password != uri.password` 且非本人 → 40069；
   *   4. 非本人访问需要 `GroupPermissionShareDownload`，匿名则报 40088。
   */
  private async resolveShare(uri: URI): Promise<FileRow | null> {
    if (!uri.id) throw Err.shareNotFound();
    const shareId = this.ctx.codec.decodeShareID(uri.id);
    if (shareId === null) throw Err.shareNotFound();
    const share = await this.ctx.shares.byId(shareId);
    if (!share) throw Err.shareNotFound();

    const owner = share.user_shares ? await this.ctx.users.byId(share.user_shares) : null;
    const root = share.file_shares ? await this.ctx.files.byId(share.file_shares) : null;
    // 上游 PR #3524：属主当前所属组失去 Share 权限位时分享失效
    const ownerGroup = owner?.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (isShareInvalid(share, root, owner, ownerGroup)) throw Err.shareNotFound();

    const viewer = this.ctx.user;
    const isOwner = viewer !== undefined && viewer.id === share.user_shares;

    // 密码校验：所有者不受限（原版 share_navigator.go:130-132）
    if (share.password && !isOwner && (uri.password || '') !== share.password) {
      throw new AppError(CodeIncorrectPassword, 'Incorrect share password');
    }

    // 非本人访问需要「分享下载」权限（原版 share_navigator.go:159-173）
    if (!isOwner) {
      const perms = await this.ctx.viewerPermissions();
      if (!perms.enabled(GroupPermission.ShareDownload)) {
        if (this.ctx.isAnonymous) {
          throw new AppError(
            CodeAnonymouseAccessDenied,
            "You don't have permission to access share links",
          );
        }
        throw new AppError(
          CodeNoPermissionErr,
          "You don't have permission to access share links",
        );
      }
    }

    // 付费分享下载闸门：owner 免购；匿名必须先登录再购买；已登录但未购买则拒绝。
    // 注意 share.ts:info() 走独立路径（不被此处拦截），以便分享页正常展示价格与购买按钮。
    // 匿名与未购都返回 40083（而非 401），避免前端全局 401 处理把访客强制登出/跳转。
    if (share.score > 0 && !isOwner) {
      if (this.ctx.isAnonymous || !this.ctx.user) {
        throw new AppError(CodePurchaseRequired, 'Login required to purchase this share');
      }
      const purchased = await this.ctx.shares.hasPurchased(share.id, this.ctx.user.id);
      if (!purchased) {
        throw new AppError(
          CodePurchaseRequired,
          'Purchase required to access this share',
        );
      }
    }

    // 单文件分享的路径语义（原版 To()，share_navigator.go:194-206）：
    // 根 URI 返回文件本身；唯一一段路径 == 文件名时也返回文件（前端拿
    // `cloudreve://<hash>[@:pwd]@share/<文件名>` 请求文件信息/下载/预览），
    // 其余子路径一律不存在。
    if (root!.type === FileType.File) {
      if (uri.elements.length === 0) return root!;
      if (uri.elements.length === 1 && uri.elements[0] === root!.name) return root!;
      return null;
    }
    return this.walk(root!, uri.elements);
  }

  /**
   * 「分享给我」。原版 `sharewithme_navigator.go:58-86`：
   *   - 匿名 → 401；
   *   - **只允许访问根**（`cloudreve://shared_with_me`），任何子路径都报路径不存在 ——
   *     它是一棵扁平树，子项的 URI 只是给前端展示用的（`newSharedWithMeUri(fileHashid)`）。
   */
  private async resolveSharedWithMe(uri: URI): Promise<FileRow | null> {
    const user = this.ctx.requireUser();
    if (uri.elements.length > 0) {
      throw new AppError(CodeFileNotFound, `Invalid path ${uri.path}`);
    }
    return this.ctx.files.ensureRoot(user.id);
  }

  /**
   * 沿路径分段逐级向下。
   *
   * 进入下一级之前先看当前节点是不是符号目录 —— 是就直接 403
   * （原版 `baseNavigator.walkNext` 的 `root.IsSymbolic()` 检查，navigator.go:179-183）。
   * 注意检查点在**取子节点之前**：`cloudreve://my/sym` 这种「目标自身就是符号目录」
   * 的解析是允许的，只有继续往下钻才被拒。
   */
  private async walk(start: FileRow, elements: string[]): Promise<FileRow | null> {
    let current = start;
    for (const el of elements) {
      if (current.is_symbolic) throw Err.symbolicFolder();
      const next = await this.ctx.files.childByName(current.id, el);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  /** 取文件在「用户视角」下的完整路径。 */
  async pathOf(file: FileRow): Promise<string> {
    const segments: string[] = [];
    let current: FileRow | null = file;
    let guard = 0;
    while (current && guard++ < 256) {
      if (current.file_children === null) break; // 根目录或回收站项
      segments.unshift(current.name);
      current = await this.ctx.files.byId(current.file_children);
    }
    return segments.length === 0 ? '/' : `/${segments.join('/')}`;
  }

  /**
   * 取**同目录兄弟节点**共用的路径前缀。
   *
   * 原实现是「每个文件各调一次 `pathOf()`」，而 `pathOf()` 每上一级都要打一次
   * 数据库。列一个 7 项的根目录就等于 7 次**串行**查询；目录层级越深越糟
   * （深度 × 条目数）。但同一目录下的所有条目共享**同一条祖先链**，
   * 所以这里只走一遍，把父路径算出来复用。
   *
   * 返回父路径（形如 `/a/b`，根目录为 `/`）；调用方自行拼上 `file.name`。
   * ⚠️ 只对「条目都是同一目录直接子节点」的文件系统有效（my / share）。
   * trash 与 sharedWithMe 是扁平列表，调用方须传 null 走逐项 pathOf。
   */
  private parentPathOf(dir: FileRow | null): Promise<string> {
    if (!dir || this.isRootFolder(dir)) return Promise.resolve('/');
    return this.pathOf(dir);
  }

  /** 判断是否根目录。 */
  isRootFolder(file: FileRow): boolean {
    return file.file_children === null && file.name === '';
  }

  /** 判断是否在回收站里。 */
  isInTrash(file: FileRow): boolean {
    return file.file_children === null && file.name !== '';
  }

  /**
   * 显示名。对应原版 `dbfs.File.DisplayName()`：回收站项的 `files.name` 已被改成
   * 随机串，真实名字取自 `sys:restore_uri` 元数据的最后一段；缺这条元数据时退回
   * `files.name`（原版同样如此）。
   */
  displayNameOf(file: FileRow, meta?: MetadataRow[]): string {
    const mark = meta?.find((m) => m.name === MetadataRestoreUri);
    if (!mark) return file.name;
    const uri = URI.tryParse(mark.value);
    return uri?.name || file.name;
  }

  /** 文件的父目录行。根目录返回 null。 */
  async parentOf(file: FileRow): Promise<FileRow | null> {
    if (file.file_children === null) return null;
    return this.ctx.files.byId(file.file_children);
  }

  // -------------------------------------------------------------------------
  // 响应构造
  // -------------------------------------------------------------------------

  async buildFileResponse(file: FileRow, options: BuildFileOptions = {}): Promise<FileResponse> {
    const user = this.ctx.user;
    const path = options.precomputedPath ?? (await this.pathOf(file));
    // 用户视角的 URI：
    //   - 回收站项固定是 `cloudreve://trash/<随机名>`（原版 trash_navigator.go:94-95）；
    //   - 其余情况以调用方给的 `options.uri` 为准 —— 分享空间下它是
    //     `cloudreve://<shareHashid>[:<pwd>]@share/<path>`（原版 share_navigator.go:148
    //     把 root 的 pathIndexUser 设成请求 URI 的 Root()，子节点在此基础上 Join）；
    //   - 没给 uri 时回落到 `cloudreve://my/<path>`。
    const userViewUri = this.isInTrash(file)
      ? URI.trash(file.name)
      : options.uri ?? URI.my(path);

    const res: FileResponse = {
      type: file.type,
      id: this.ctx.codec.encodeFileID(file.id),
      name: options.displayName ?? file.name,
      created_at: file.created_at.toISOString(),
      updated_at: file.updated_at.toISOString(),
      size: Number(file.size),
      metadata: {},
    };

    if (!this.isRootFolder(file)) {
      res.path = userViewUri.toString();
    }

    // 能力位：上游 BuildListResponse 对**每个文件和 parent** 都下发
    // navigator 能力（service/explorer/response.go:388,401），前端「新建」菜单、
    // 右键菜单、版本管理等全部依赖 `file.capability` 判位。按文件所属
    // 文件系统自动推导（子文件继承父目录能力的语义等价，上游 dbfs/file.go:345）。
    res.capability = this.navigatorCapability(userViewUri).toBase64();

    if (options.owned !== undefined) {
      res.owned = options.owned;
    } else {
      res.owned = user !== undefined && file.owner_id === user.id;
    }

    if (options.shared) {
      res.shared = true;
    }

    if (file.primary_entity && file.type === FileType.File) {
      res.primary_entity = this.ctx.codec.encodeEntityID(file.primary_entity);
    }

    // 目录自定义视图（`props.view`）只在 `extended_info` 里下发，与列表响应一致；
    // 列表接口不额外带，避免每条记录都塞一份。

    if (options.folderSummary && file.type === FileType.Folder) {
      const summary = await this.ctx.files.folderSummary(file.id);
      res.folder_summary = {
        size: summary.size,
        files: summary.files,
        folders: summary.folders,
        completed: true,
        calculated_at: new Date().toISOString(),
      };
    }

    if (options.extended) {
      res.extended_info = await this.buildExtendedInfo(file);
    }

    return res;
  }

  /**
   * 构造 `extended_info`。字段与可见性对齐原版 `dbfs/dbfs.go:413-437` 的
   * `LoadFileExtendedInfo` 分支：
   *   - `storage_used` = 该文件**所有实体**的大小之和（`File.SizeUsed()`）；
   *   - `direct_links` **仅属主**可见（原版 `if f.user.ID == target.OwnerID()`）；
   *   - `view` 属主或管理员可见，取自 `files.props.view`；
   *   - 每个实体附带它所在的存储策略。
   */
  private async buildExtendedInfo(file: FileRow): Promise<ExtendedInfo> {
    const requester = this.ctx.user;
    const isOwner = requester !== undefined && file.owner_id === requester.id;
    const canSeeOwnerOnly = isOwner || this.ctx.isAdmin;

    const info: ExtendedInfo = { storage_used: 0 };

    const policyId = file.storage_policy_files;
    if (policyId) {
      const policy = await this.ctx.policies.byId(policyId);
      if (policy) {
        info.storage_policy = this.buildPolicyInfo(policy);
      }
    }

    if (file.type === FileType.File) {
      const entities = await this.ctx.entities.listByFile(file.id);
      info.storage_used = entities.reduce((sum, e) => sum + Number(e.size), 0);

      const entityInfos: EntityInfo[] = [];
      for (const e of entities) {
        const entityInfo: EntityInfo = {
          id: this.ctx.codec.encodeEntityID(e.id),
          size: Number(e.size),
          type: e.type,
          created_at: e.created_at.toISOString(),
        };
        const entityPolicy = await this.ctx.policies.byId(e.storage_policy_entities);
        if (entityPolicy) entityInfo.storage_policy = this.buildPolicyInfo(entityPolicy);
        entityInfos.push(entityInfo);
      }
      info.entities = entityInfos;
    }

    if (canSeeOwnerOnly && file.props?.view) {
      info.view = file.props.view;
    }

    if (isOwner) {
      const links = await this.ctx.directLinks.listByFile(file.id);
      if (links.length > 0) {
        const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
        info.direct_links = links.map((l) => ({
          id: this.ctx.codec.encodeSourceLinkID(l.id),
          url: `${base}/f/${this.ctx.codec.encodeSourceLinkID(l.id)}/${encodeURIComponent(l.name)}`,
          downloaded: l.downloads,
          created_at: l.created_at.toISOString(),
        }));
      }
    }

    return info;
  }

  buildPolicyInfo(policy: StoragePolicyRow): StoragePolicyInfo {
    const res: StoragePolicyInfo = {
      id: this.ctx.codec.encodePolicyID(policy.id),
      name: policy.name,
      type: policy.type,
      max_size: Number(policy.max_size ?? 0),
      // R2 绑定策略（type=s3 且无 AK/SK）走 R2Driver 中转模式，不返回
      // upload_urls —— 前端上传器 factory（core/index.ts:107）只有看到
      // policy.relay 才会切到 Local 中转上传器，否则按 S3 直传流程读
      // `session.upload_urls[0]` 直接崩。这里做动态兜底，避免旧数据
      // settings 里没有 relay 标志时上传必炸。
      relay:
        policy.settings?.relay === true ||
        // 又拍云驱动无直传能力（自有 REST 协议），恒走中转
        policy.type === PolicyType.Upyun ||
        (policy.type === PolicyType.S3 && !policy.access_key),
      chunk_concurrency: policy.settings?.chunk_concurrency,
      encryption: policy.settings?.encryption,
    };
    // 后缀与文件名正则约束（对齐上游 BuildStoragePolicy，response.go:508），
    // 上传器用它设置文件选择器的 accept 属性与前端校验
    const s = policy.settings;
    if (s?.file_type && s.file_type.length > 0) {
      if (s.is_file_type_deny_list) res.denied_suffix = s.file_type;
      else res.allowed_suffix = s.file_type;
    }
    if (s?.file_regexp) {
      if (s.is_name_regexp_deny_list) res.denied_name_regexp = s.file_regexp;
      else res.allowed_name_regexp = s.file_regexp;
    }
    return res;
  }

  /** 批量读取元数据，避免逐个文件查询。 */
  private async loadMetadata(files: FileRow[], includePrivate: boolean): Promise<Map<number, MetadataRow[]>> {
    const ids = files.map((f) => f.id);
    const rows = await this.ctx.metadata.listByFiles(ids, includePrivate);
    const map = new Map<number, MetadataRow[]>();
    for (const r of rows) {
      const list = map.get(r.file_id) ?? [];
      list.push(r);
      map.set(r.file_id, list);
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  async list(
    uri: URI,
    params: {
      page: number;
      pageSize: number;
      orderBy: string;
      orderDirection: string;
      typeFilter?: number | null;
    },
  ): Promise<ListResponse> {
    // 这里**不能**直接用 requireUser()：匿名访问分享是合法路径（原版靠匿名用户组放行）。
    // my / trash 的登录要求由 resolveMy / resolveTrash 内部保证。
    const viewer = this.ctx.user;
    const dir = await this.resolve(uri);

    const isTrashRoot = uri.fsType === FileSystemType.Trash && uri.elements.length === 0;
    // 目录不存在时，如果目标是根目录就按空目录处理（首次登录还没建根）
    if (!dir && !(uri.fsType === FileSystemType.My && uri.isRoot) && !isTrashRoot) {
      throw Err.fileNotFound();
    }

    // 符号目录的内容在另一个文件系统里，不允许直接列（原版 navigator.go:241-243）
    if (dir?.is_symbolic) throw Err.symbolicFolder();

    const pageSize = Math.min(
      params.pageSize > 0 ? params.pageSize : 100,
      this.ctx.settings.maxPageSize,
    );

    // 单文件分享：源是文件时，上游 `share_navigator.go:229-244` 的 Children
    // 无论 parent 是什么都返回「[那个文件] + SingleFileView=true」，前端
    // Explorer（Explorer.tsx:78）据此渲染单文件分享页。此前把文件行当目录
    // 列子节点 → 恒为空列表，分享页永远显示「什么都没有找到」。
    if (uri.fsType === FileSystemType.Share && dir?.type === FileType.File) {
      const res = await this.buildFileResponse(dir, {
        shared: true,
        owned: viewer !== undefined && dir.owner_id === viewer.id,
        uri: this.childUri(uri, dir),
      });
      for (const m of await this.ctx.metadata.listByFile(dir.id, true)) {
        res.metadata[m.name] = m.value;
      }
      return {
        files: [res],
        pagination: { page: params.page, page_size: pageSize, total_items: 1 },
        props: {
          capability: this.navigatorCapability(uri).toBase64(),
          max_page_size: this.ctx.settings.maxPageSize,
          order_by_options: ORDER_BY_OPTIONS,
          order_direction_options: ORDER_DIRECTION_OPTIONS,
        },
        mixed_type: true,
        single_file_view: true,
      };
    }

    const ownerId =
      uri.fsType === FileSystemType.My || uri.fsType === FileSystemType.Trash
        ? this.ctx.requireUser().id
        : dir
          ? dir.owner_id
          : null;

    const { files, total } = await this.ctx.files.list({
      parentId: dir ? dir.id : null,
      ownerId,
      trash: isTrashRoot,
      // 「分享给我」是一棵扁平树，不走 parentId 过滤
      sharedWithMe: uri.fsType === FileSystemType.SharedWithMe,
      page: params.page,
      pageSize,
      orderBy: whitelist(params.orderBy, ORDER_BY_OPTIONS, 'name'),
      orderDirection: whitelist(params.orderDirection, ORDER_DIRECTION_OPTIONS, 'asc'),
      typeFilter: params.typeFilter ?? null,
    });

    // 这两个查询都依赖上面的 files，彼此独立 —— 并行发出，省掉一次串行等待
    // （Neon HTTP 驱动每次查询是一次 fetch，串行会线性叠加延迟）。
    //
    // 关于 `parentPath`：只有当所有条目**确实是同一个目录的直接子节点**时，
    // 才能把祖先链算一次复用。两种文件系统不满足这个前提，必须逐个算：
    //   - trash：`pathOf()` 对回收站项恒返回 '/'（file_children 为 null），
    //     且显示名来自 sys:restore_uri，路径本身没有意义 —— 直接不算；
    //   - sharedWithMe：是一条**扁平**列表（原版 childFileQuery 不带 parentId），
    //     条目散落在不同目录，没有公共祖先。
    // 其余情况（my / share）都是标准的父子层级，可安全复用。
    const flatList =
      isTrashRoot || uri.fsType === FileSystemType.SharedWithMe;

    const [metadataMap, sharedIds] = await Promise.all([
      this.loadMetadata(files, uri.fsType === FileSystemType.My),
      this.ctx.shares.sharedFileIds(files.map((f) => f.id)),
    ]);

    const parentPath = flatList ? null : await this.parentPathOf(dir);

    // 逐项构造响应。这里可以并行：buildFileResponse 在传了 precomputedPath
    // 之后不再打数据库（除非开了 extended/folderSummary，列表接口都不开）。
    const fileResponses: FileResponse[] = await Promise.all(
      files.map(async (f) => {
        const meta = metadataMap.get(f.id);
        const res = await this.buildFileResponse(f, {
          shared: sharedIds.has(f.id),
          owned: viewer !== undefined && f.owner_id === viewer.id,
          // 子节点在调用方视角下的 URI —— 分享空间下要带上 share hashid 与密码
          uri: this.childUri(uri, f),
          // 回收站里的 name 是随机串，显示名要回落到 sys:restore_uri 的最后一段
          displayName: isTrashRoot ? this.displayNameOf(f, meta) : undefined,
          // 有公共父路径时直接拼；否则交给 pathOf 逐项算（trash / sharedWithMe）
          precomputedPath: parentPath === null ? undefined : joinPath(parentPath, f.name),
        });
        if (meta) {
          for (const m of meta) res.metadata[m.name] = m.value;
        }
        return res;
      }),
    );

    const response: ListResponse = {
      files: fileResponses,
      pagination: {
        page: params.page,
        page_size: pageSize,
        total_items: total,
      },
      props: {
        capability: this.navigatorCapability(uri).toBase64(),
        max_page_size: this.ctx.settings.maxPageSize,
        order_by_options: ORDER_BY_OPTIONS,
        order_direction_options: ORDER_DIRECTION_OPTIONS,
      },
      mixed_type: params.typeFilter === null || params.typeFilter === undefined,
    };

    if (dir) {
      response.parent = await this.buildFileResponse(dir, {
        owned: viewer !== undefined && dir.owner_id === viewer.id,
        uri,
      });
    }

    // 上游 getPreferredPolicy（dbfs.go:669-682）：取**目录属主**所在用户组
    // 绑定的存储策略下发给前端上传器。注意不能放进 `if (dir)` 里 ——
    // My 根目录（首次登录还没建根 / 根即当前路径）时 dir 为 null，而上游
    // 根目录的 parent 就是根文件夹、照常解析（dbfs.go:206）。缺失时前端
    // 点「上传」直接抛 No policy selected 且文件选择器不打开。获取失败
    // 仅降级为缺字段，不影响列表本身（上游也只 Warning 不阻断）。
    const policyOwnerId =
      dir?.owner_id ?? (uri.fsType === FileSystemType.My ? viewer?.id : undefined);
    if (policyOwnerId != null) {
      try {
        // my / trash 的属主就是当前用户 —— 上下文里已经有完整行了，省一次查询。
        const owner =
          viewer && viewer.id === policyOwnerId
            ? viewer
            : await this.ctx.users.byId(policyOwnerId);
        if (owner) {
          // edge 自建 Pro 功能：组多策略。取属主所在组的全部可用策略，
          // 选中的（属主偏好 upload_policy_id，未选取第一个）作为
          // storage_policy 下发给上传器；全部可选集放 storage_policies
          // 供前端切换器渲染。只有一个策略时与上游行为完全一致。
          const all = await this.ctx.groupPolicies(owner);
          if (all.length > 0) {
            // 用已取到的 all 直接挑，不再调 preferredPolicy() —— 后者会
            // 把 groupPolicies 再查一遍（列表接口每请求都要走这里）。
            const preferred = this.ctx.pickPreferredPolicy(all, owner.settings);
            response.storage_policy = this.buildPolicyInfo(preferred);
            if (all.length > 1) {
              response.storage_policies = all.map((p) => this.buildPolicyInfo(p));
            }
          }
        }
      } catch {
        // 降级：无策略时前端上传器保持 No policy selected 行为
      }
    }

    return response;
  }

  /**
   * 子节点在**调用方视角**下的 URI。各文件系统的规则不一样（对照原版各家 navigator）：
   *   - my / share：父 URI 直接 Join 文件名（`share_navigator.go:148` 把 root 的
   *     user-view 设为请求 URI 的 Root()，子项在其上 Join）；
   *   - trash：`cloudreve://trash/<随机名>`（`trash_navigator.go:112`）；
   *   - shared_with_me：`cloudreve://shared_with_me/<fileHashid>`
   *     （`sharewithme_navigator.go:97`）—— 注意这只是展示用，该路径本身不可访问。
   */
  private childUri(uri: URI, file: FileRow): URI | undefined {
    switch (uri.fsType) {
      case FileSystemType.My:
      case FileSystemType.Share:
        return uri.child(file.name);
      case FileSystemType.Trash:
        return undefined; // buildFileResponse 内部走 URI.trash(file.name)
      case FileSystemType.SharedWithMe:
        return URI.sharedWithMeFile(this.ctx.codec.encodeFileID(file.id));
      default:
        return uri.child(file.name);
    }
  }

  /**
   * 各文件系统暴露的能力位集。**静态对齐上游 `dbfs/navigator.go` 的 init()**：
   *   - my：            全量（含 create/upload/rename/delete/soft_delete…）；
   *   - share：         只读浏览 + 下载 + 缩略图 + 信息；
   *   - trash：         列出 + 删除 + 还原；
   *   - shared_with_me：列出 + 下载 + 进入。
   * 上游不按用户组权限裁剪这份上报（组权限由前端 GroupPermission 位和
   * 服务端操作时校验把关），这里保持一致 —— 自行裁剪会让前端菜单/按钮
   * 与原版行为不一致。
   */
  private navigatorCapability(uri: URI): BooleanSet {
    const NC = NavigatorCapability;
    switch (uri.fsType) {
      case FileSystemType.My:
        return BooleanSet.fromFlags(
          NC.CreateFile,
          NC.RenameFile,
          NC.UploadFile,
          NC.DownloadFile,
          NC.UpdateMetadata,
          NC.ListChildren,
          NC.GenerateThumb,
          NC.DeleteFile,
          NC.LockFile,
          NC.SoftDelete,
          NC.Share,
          NC.Info,
          NC.VersionControl,
          NC.EnterFolder,
          NC.ModifyProps,
        );
      case FileSystemType.Share:
        return BooleanSet.fromFlags(
          NC.DownloadFile,
          NC.ListChildren,
          NC.GenerateThumb,
          NC.LockFile,
          NC.Info,
          NC.VersionControl,
          NC.EnterFolder,
          NC.ModifyProps,
        );
      case FileSystemType.Trash:
        return BooleanSet.fromFlags(
          NC.ListChildren,
          NC.DeleteFile,
          NC.LockFile,
          NC.Restore,
          NC.Info,
        );
      case FileSystemType.SharedWithMe:
        return BooleanSet.fromFlags(NC.ListChildren, NC.DownloadFile, NC.EnterFolder);
      default:
        return new BooleanSet();
    }
  }

  // -------------------------------------------------------------------------
  // 创建
  // -------------------------------------------------------------------------

  async create(
    uri: URI,
    type: 'file' | 'folder',
    options: { metadata?: Record<string, string>; errOnConflict?: boolean } = {},
  ): Promise<FileResponse> {
    const user = this.ctx.requireUser();
    if (uri.fsType !== FileSystemType.My) {
      throw new AppError(CodePolicyNotAllowed, 'Only personal file system supports creation');
    }

    const name = uri.elements.at(-1);
    if (!name) throw new AppError(CodeRootProtected, 'Cannot create at root');

    const nameError = validateName(name);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    const existing = await this.ctx.files.resolvePath(user.id, uri.elements);
    if (existing) {
      if (options.errOnConflict) throw Err.objectExist();
      return this.buildFileResponse(existing, { owned: true });
    }

    const parentUri = uri.parent();
    const parent = await this.ctx.files.resolvePath(user.id, parentUri.elements);
    if (!parent) throw new AppError(40016, 'Parent folder does not exist');
    if (parent.type !== FileType.Folder) {
      throw new AppError(40016, 'Parent is not a folder');
    }

    const policy = await this.ctx.resolvePolicy(null);

    // 「保存到我的网盘」的落点：前端用 `POST /file/create` 建一个目录，并在 metadata 里
    // 带 `sys:shared_redirect` 指向分享 URI；服务端据此把它标成**符号目录**
    // （原版 `manager.Create` 的 operation.go:116-135 → `dbfs.WithSymbolicLink()`）。
    // 符号目录本身不可遍历，前端读 metadata 里的那个键自己跳转到分享。
    const isSymbolic = Boolean(
      options.metadata && Object.prototype.hasOwnProperty.call(options.metadata, MetadataSharedRedirect),
    );

    const file = await this.ctx.files.create({
      type: type === 'folder' ? FileType.Folder : FileType.File,
      name,
      ownerId: user.id,
      parentId: parent.id,
      size: 0,
      policyId: policy.id,
      isSymbolic,
    });

    if (options.metadata) {
      for (const [k, v] of Object.entries(options.metadata)) {
        // 元数据键有长度上限（原版 MaxMetadataLen = 65535）
        if (k.length > 1024) continue;
        await this.ctx.metadata.upsert(file.id, k, v, false);
      }
    }

    notifyFsEvent(this.ctx, file, 'create', '', file.name);
    logAudit(this.ctx, 'file_create', user.id, {
      name: file.name,
      kind: file.type === FileType.Folder ? 'folder' : 'file',
    });
    return this.buildFileResponse(file, { owned: true });
  }

  // -------------------------------------------------------------------------
  // 重命名
  // -------------------------------------------------------------------------

  async rename(uri: URI, newName: string): Promise<FileResponse> {
    const user = this.ctx.requireUser();
    const file = await this.mustResolve(uri);
    if (this.isRootFolder(file)) throw new AppError(CodeRootProtected, 'Cannot rename root folder');
    this.assertOwner(file, user.id);

    const nameError = validateName(newName);
    if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

    // 目标目录下不能已有同名节点
    const sibling = await this.ctx.files.childByName(file.file_children, newName);
    if (sibling && sibling.id !== file.id) throw Err.objectExist();

    await this.ctx.files.rename(file.id, newName);
    const updated = await this.ctx.files.byId(file.id);

    // 同步全文索引里的文件名（失败不影响改名本身）
    if (updated && updated.primary_entity) {
      await new SearchService(this.ctx).rename(
        updated.id,
        updated.primary_entity,
        updated.name,
      );
    }
    notifyFsEvent(this.ctx, updated ?? file, 'rename', file.name, updated?.name ?? newName);
    logAudit(this.ctx, 'file_rename', user.id, { from: file.name, to: updated?.name ?? newName });
    return this.buildFileResponse(updated!, { owned: true });
  }

  // -------------------------------------------------------------------------
  // 移动 / 复制
  // -------------------------------------------------------------------------

  async moveOrCopy(uris: URI[], dstUri: URI, copy: boolean): Promise<void> {
    const user = this.ctx.requireUser();

    // 原版的约束（dbfs.canMoveOrCopyTo）：
    //   copy=true  仅允许 my → my
    //   copy=false 允许 my → my / my → trash / trash → my
    const dstFs = dstUri.fsType;
    if (copy) {
      if (dstFs !== FileSystemType.My) {
        throw new AppError(CodeGroupNotAllowed, 'Copy is only allowed within personal file system');
      }
    } else {
      const allowed =
        (dstFs === FileSystemType.My || dstFs === FileSystemType.Trash);
      if (!allowed) {
        throw new AppError(CodeGroupNotAllowed, 'Move is not allowed to this location');
      }
    }

    const dstFolder = dstFs === FileSystemType.Trash ? null : await this.mustResolve(dstUri);
    if (dstFolder && dstFolder.type !== FileType.Folder) {
      throw new AppError(CodeObjectExist, 'Destination is not a folder');
    }

    for (const uri of uris) {
      const src = await this.mustResolve(uri);
      if (this.isRootFolder(src)) throw new AppError(CodeRootProtected, 'Cannot move root folder');
      this.assertOwner(src, user.id);

      const nameError = validateName(src.name);
      if (nameError) throw new AppError(CodeIllegalObjectName, nameError);

      if (copy) {
        // files 表有 (file_children, name) 唯一索引，不预检同名会把原始
        // DB 冲突裸抛成 500（move 分支同样道理，见下方 conflict 检查）
        const conflict = await this.ctx.files.childByName(dstFolder!.id, src.name);
        if (conflict) throw Err.objectExist();
        await this.copyRecursive(src, dstFolder!.id, user.id);
        logAudit(this.ctx, 'copy_from', user.id, { name: src.name });
        logAudit(this.ctx, 'copy_to', user.id, { name: src.name, dst: dstFolder!.name });
      } else if (dstFs === FileSystemType.Trash) {
        await this.softDeleteFile(src);
        logAudit(this.ctx, 'move_to_trash', user.id, { name: src.name });
      } else {
        // 防止把目录移动到自己内部
        if (dstFolder && (await this.isDescendant(dstFolder.id, src.id))) {
          throw new AppError(CodeGroupNotAllowed, 'Cannot move a folder into itself');
        }
        const conflict = await this.ctx.files.childByName(dstFolder!.id, src.name);
        if (conflict) throw Err.objectExist();
        await this.ctx.files.updateParent(src.id, dstFolder!.id);
        logAudit(this.ctx, 'move_to', user.id, { name: src.name, dst: dstFolder!.name });
      }
    }
  }

  /** 目标是否是源的后代。 */
  private async isDescendant(candidateId: number, ancestorId: number): Promise<boolean> {
    let current: FileRow | null = await this.ctx.files.byId(candidateId);
    let guard = 0;
    while (current && current.file_children !== null && guard++ < 256) {
      if (current.file_children === ancestorId) return true;
      current = await this.ctx.files.byId(current.file_children);
    }
    return false;
  }

  /**
   * 递归复制。文件共享实体（引用计数 +1），目录递归下去。
   * 这与原版的行为一致：复制不产生新的物理对象，只增加实体引用。
   */
  private async copyRecursive(src: FileRow, dstParentId: number, ownerId: number): Promise<FileRow> {
    const policy = await this.ctx.resolvePolicy(src.storage_policy_files);
    const created = await this.ctx.files.create({
      type: src.type,
      name: src.name,
      ownerId,
      parentId: dstParentId,
      size: src.size,
      policyId: policy.id,
      primaryEntity: null,
      props: src.props ?? {},
    });

    if (src.type === FileType.File && src.primary_entity) {
      const entities = await this.ctx.entities.listByFile(src.id);
      for (const e of entities) {
        await this.ctx.entities.retain([e.id]);
        await this.ctx.entities.linkFile(created.id, e.id);
      }
      await this.ctx.files.updatePrimaryEntity(created.id, src.primary_entity);
    }

    if (src.type === FileType.Folder) {
      const children = await this.ctx.files.list({
        parentId: src.id,
        ownerId: null,
        page: 0,
        pageSize: 10000,
        orderBy: 'name',
        orderDirection: 'asc',
      });
      for (const child of children.files) {
        await this.copyRecursive(child, created.id, ownerId);
      }
    }

    return created;
  }

  // -------------------------------------------------------------------------
  // 删除 / 恢复 / 清空
  // -------------------------------------------------------------------------

  async delete(uris: URI[], options: { unlinkOnly?: boolean; skipSoftDelete?: boolean } = {}): Promise<void> {
    const user = this.ctx.requireUser();

    if (options.unlinkOnly) {
      this.ctx.requireGroupPermission(GroupPermission.AdvanceDelete, 'Advanced delete is not allowed');
    }

    const errors: string[] = [];

    for (const uri of uris) {
      try {
        const file = await this.mustResolve(uri);
        if (this.isRootFolder(file)) throw new AppError(CodeRootProtected, 'Cannot delete root folder');
        this.assertOwner(file, user.id);

        if (this.isInTrash(file)) {
          // 已在回收站中的再删一次 = 彻底删除
          await this.purge(file);
          logAudit(this.ctx, 'delete_file', user.id, { name: file.name, purge: true });
          continue;
        }

        if (options.skipSoftDelete) {
          await this.purge(file);
          logAudit(this.ctx, 'delete_file', user.id, { name: file.name, purge: true });
        } else {
          await this.softDeleteFile(file);
          logAudit(this.ctx, 'move_to_trash', user.id, { name: file.name });
        }
        notifyFsEvent(this.ctx, file, 'delete', file.name, '');
      } catch (e) {
        errors.push(uri.toString());
        if (uris.length === 1) throw e;
      }
    }

    if (errors.length > 0 && errors.length === uris.length) {
      throw new AppError(40081, 'One or more operation failed');
    }
  }

  /**
   * 软删除到回收站。对应原版 `dbfs.SoftDelete`：
   *   1. 先把**当前完整路径**（含文件名）算出来，写进 `sys:restore_uri` 元数据；
   *      回收站列表里的显示名取自它的最后一段（`File.DisplayName()`），
   *      恢复时也靠它定位原目录。
   *   2. 按属主用户组的 `trash_retention`（秒）写 `sys:expected_collect_time`，
   *      供定时任务自动清理；未配置（0）则不写。
   *   3. 最后才改名并清空父指针 —— 顺序反了路径就算不出来了。
   *
   * 两个键都是**公开**元数据：原版 `UpsertMetadata` 的 privateMask 传 nil，
   * 于是 `is_public = true`，列表接口（只带公开元数据）才能读到。
   */
  private async softDeleteFile(file: FileRow): Promise<void> {
    const path = await this.pathOf(file);
    const restoreUri = URI.my(path).toString();

    await this.ctx.files.moveToTrash([file.id]);

    // 进回收站的文件不该再被搜到：从全文索引剔除，恢复时重建
    await new SearchService(this.ctx).deleteByFileIds([file.id]);

    await this.ctx.metadata.upsert(file.id, MetadataRestoreUri, restoreUri, true);

    const retention = this.ctx.user?.group.settings?.trash_retention ?? 0;
    if (retention > 0) {
      const collectAt = Math.floor(Date.now() / 1000) + retention;
      await this.ctx.metadata.upsert(
        file.id,
        MetadataExpectedCollectTime,
        String(collectAt),
        true,
      );
    }
  }

  /** 彻底删除：解除实体引用，引用归零的实体连同物理对象一起删掉。 */
  private async purge(file: FileRow): Promise<void> {
    const ids = await this.ctx.files.collectDescendants([file.id]);
    const entitiesToRelease: number[] = [];

    for (const id of ids) {
      const entities = await this.ctx.entities.listByFile(id);
      for (const e of entities) entitiesToRelease.push(e.id);
      await this.ctx.metadata.removeAllForFile(id);
    }

    const garbage = await this.ctx.entities.release(entitiesToRelease);

    // 删除物理对象，并按大小回冲用户容量
    for (const entity of garbage) {
      try {
        const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
        if (policy) {
          const driver = this.ctx.driverFor(policy);
          await driver.delete([entity.source]);
        }
      } catch {
        // 物理删除失败不回滚数据库，留待人工清理（原版同样容忍）
      }
      if (entity.created_by) {
        await this.ctx.users.addStorage(entity.created_by, -Number(entity.size));
      }
    }
    await this.ctx.entities.hardDelete(garbage.map((e) => e.id));
    // 先删直链（外键约束：direct_links.file_id → files.id）
    await this.ctx.directLinks.deleteByFileIds(ids);
    await this.ctx.files.deleteMany(ids);

    // 彻底删除的文件从全文索引剔除
    await new SearchService(this.ctx).deleteByFileIds(ids);
  }

  // -------------------------------------------------------------------------
  // 版本管理。对应原版 `DBFS.VersionControl`（`dbfs/manage.go:415-478`），
  // 两个服务分别以 `delete=false` / `delete=true` 调用同一段逻辑。
  // -------------------------------------------------------------------------

  /**
   * 把文件的当前版本切换成指定的历史版本。
   * 对齐 `dbfs/manage.go:785-821` 的 `setCurrentVersion`。
   */
  async setCurrentVersion(uri: URI, versionId: number): Promise<void> {
    const file = await this.resolveVersionTarget(uri);
    if (file.primary_entity === versionId) return;

    // 原版要求：实体存在、类型为 version、且不是未完成上传的占位实体
    // （`upload_session_id == nil`），否则报 `fs.ErrEntityNotExist`。
    const entities = await this.ctx.entities.listByFile(file.id);
    const target = entities.find(
      (e) => e.id === versionId && e.type === EntityType.Version && e.upload_session_id === null,
    );
    if (!target) throw new AppError(CodeEntityNotExist, 'Entity not exist');

    await this.ctx.files.updatePrimaryEntity(file.id, versionId);
  }

  /**
   * 删除文件的某个历史版本。
   * 对齐 `dbfs/manage.go:757-783` 的 `deleteEntity`。原版这里只按 ID 找实体、
   * **不校验类型**，所以缩略图实体也能从这条路径删掉 —— 保持一致。
   */
  async deleteVersion(uri: URI, versionId: number): Promise<void> {
    const file = await this.resolveVersionTarget(uri);

    // 原版不允许删当前版本，报 `fs.ErrNotSupportedAction`（403 Not supported action）
    if (file.primary_entity === versionId) {
      throw new AppError(CodeNoPermissionErr, 'Not supported action');
    }

    const entities = await this.ctx.entities.listByFile(file.id);
    const target = entities.find((e) => e.id === versionId);
    if (!target) throw new AppError(CodeEntityNotExist, 'Entity not exist');

    await this.ctx.entities.unlinkFile(file.id, target.id);
    // 原版在实体仍是「未完成上传」状态时，会顺带清掉文件上的上传会话标记
    if (target.upload_session_id !== null) {
      await this.ctx.metadata.remove(file.id, MetadataUploadSessionID);
    }

    const garbage = await this.ctx.entities.release([target.id]);
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

  /**
   * 版本管理的目标解析与前置校验，对齐 `dbfs/manage.go:415-439`。
   *
   * 顺序与原版一致：**先查属主、再查类型**。属主判定放在这里（而不是复用
   * `assertOwner`）是因为原版此处没有管理员后门 —— `ByPassOwnerCheckCtxKey`
   * 只在内部调用链里注入，HTTP 路径永远拿不到它。
   */
  private async resolveVersionTarget(uri: URI): Promise<FileRow> {
    const user = this.ctx.requireUser();
    const file = await this.mustResolve(uri);

    if (file.owner_id !== user.id) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }
    if (file.type !== FileType.File) {
      throw new AppError(CodeNoPermissionErr, 'Not supported action');
    }
    return file;
  }

  async restore(uris: URI[]): Promise<void> {
    const user = this.ctx.requireUser();
    for (const uri of uris) {
      const file = await this.mustResolve(uri);
      if (!this.isInTrash(file)) {
        throw new AppError(CodeFileNotFound, 'File is not in trash bin');
      }
      this.assertOwner(file, user.id);

      // 原版要求必须带 sys:restore_uri 标记，否则拒绝恢复 —— 没有它就不知道该还原到哪
      const marks = await this.ctx.metadata.listByFile(file.id, false);
      const mark = marks.find((m) => m.name === MetadataRestoreUri);
      const original = mark ? URI.tryParse(mark.value) : null;
      if (!original) {
        throw new AppError(CodeNoPermissionErr, 'Not supported action');
      }

      // 目标目录 = 原路径的父目录。原目录也已被删的话，这里会解析不到。
      const dstDir = await this.resolve(original.parent());
      if (!dstDir) {
        throw new AppError(CodeParentNotExist, 'Path not exist');
      }

      // 回收站里 name 是随机串，恢复时还原成原始文件名
      const originalName = original.name;
      const conflict = await this.ctx.files.childByName(dstDir.id, originalName);
      if (conflict && conflict.id !== file.id) throw Err.objectExist();

      await this.ctx.files.rename(file.id, originalName);
      await this.ctx.files.updateParent(file.id, dstDir.id);
      await this.ctx.metadata.remove(file.id, MetadataRestoreUri);
      await this.ctx.metadata.remove(file.id, MetadataExpectedCollectTime);

      // 恢复后重建全文索引（软删时剔除过）
      const restored = await this.ctx.files.byId(file.id);
      if (restored) {
        await new SearchService(this.ctx).indexFile(restored).catch(() => undefined);
      }
    }
  }

  /** 清空回收站。 */
  async emptyTrash(): Promise<void> {
    const user = this.ctx.requireUser();
    const { files } = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      trash: true,
      page: 0,
      pageSize: 100000,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    for (const file of files) {
      await this.purge(file);
    }
  }

  /**
   * 回收站到期清理。原版由队列任务 `trash_collector` 定期跑；边缘版挂在
   * Worker 的 `scheduled()` 上。只处理 `sys:expected_collect_time` 已到的项，
   * 每轮上限 200 条，返回实际清理的数量。
   */
  async purgeExpiredTrash(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const expired = await this.ctx.files.listExpiredTrash(now);
    for (const file of expired) {
      await this.purge(file);
    }
    return expired.length;
  }

  /** 文件数上限校验（原版对单目录文件数有限制，这里按用户总量限制）。 */
  async assertFileCount(additional: number): Promise<void> {
    const limit = this.ctx.settings.getInt('max_file_count', 0);
    if (limit <= 0) return;
    const user = this.ctx.requireUser();
    const { total } = await this.ctx.files.list({
      parentId: null,
      ownerId: user.id,
      page: 0,
      pageSize: 1,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    if (total + additional > limit) {
      throw new AppError(CodeFileCountLimitedReached, 'File count limit reached');
    }
  }

  /** 容量校验。 */
  assertCapacity(size: number): void {
    this.ctx.assertCapacity(size);
  }

  /** 所有权校验：非本人所有则需要管理员/忽略归属权限。 */
  private assertOwner(file: FileRow, userId: number): void {
    if (file.owner_id === userId) return;
    if (this.ctx.isAdmin) return;
    if (this.ctx.groupPermissions.enabled(GroupPermission.IgnoreFileOwnership)) return;
    throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
  }

  /** 复制到自己的空间时禁止转存自己的分享（原版 CodeSaveOwnShare）。 */
  assertNotOwnShare(sourceOwnerId: number, userId: number): void {
    if (sourceOwnerId === userId) {
      throw new AppError(CodeSaveOwnShare, 'Cannot save your own share');
    }
  }
}

export { FileType, EntityType };
