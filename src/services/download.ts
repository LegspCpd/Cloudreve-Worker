/**
 * 实体下载与外链服务。对应 Cloudreve v4 的
 * `pkg/filemanager/manager/entitysource/entitysource.go` + `service/explorer/entity.go`。
 *
 * URL 有两种形态：
 *   1. 驱动能给出直链（OneDrive 的 @microsoft.graph.downloadUrl、配了公共域名的 R2）
 *      → 直接返回远端地址，浏览器/客户端拿走即可；
 *   2. 驱动需要代理（未配公共域名的 R2）
 *      → 返回本站签名地址 `/api/v4/file/content/:entityId/:speed/:name?sign=...`，
 *        由 Worker 把对象流式转发出去。
 *
 * 「限速」在 Workers 上无法实现，`speed` 段仅作为协议占位原样透传（见 README）。
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { FileSystemService, type DirectLinkInfo } from './fs';
import { FileSystemType, URI } from './uri';
import type { EntityRow, FileRow } from '../db/types';
import { FileType } from '../lib/boolset';
import {
  AppError,
  CodeFileNotFound,
  CodeEntityNotExist,
  CodeGroupNotAllowed,
  CodeInvalidSign,
  CodeOwnerOnly,
  CodeSignExpired,
  Err,
} from '../lib/errors';
import { GroupPermission } from '../lib/boolset';
import type { ObjectContent } from '../storage/types';
import { kvFor } from '../lib/kvRouter';
import {
  EDGE_CACHE_TTL_S,
  edgeCacheMatch,
  edgeCachePut,
  objectFromCacheResponse,
} from '../lib/edgeCache';

export interface EntityUrl {
  url: string;
  stream_saver_display_name?: string;
}

export interface FileUrlResponse {
  urls: EntityUrl[];
  expires: Date | string | null;
}

export interface GetUrlOptions {
  download?: boolean;
  entity?: string;
  noCache?: boolean;
  /** 直链有效期（秒），默认取站点设置 entity_url_default_ttl */
  ttlSeconds?: number;
}

export interface ServeEntityResult {
  content: ObjectContent;
  /** 直接 302 到远端时的地址 */
  redirectTo?: string;
}

/** 直链 URL 的路径前缀（原版是 /f/:id/:name，签名后可见）。 */
export const DIRECT_LINK_PREFIX = '/f';

export class DownloadService {
  constructor(
    private readonly ctx: AppContext,
    private readonly fs: FileSystemService,
  ) {}

  /**
   * 为一批文件生成下载/预览地址。
   * 与原版一致：`redirect` 只对单个 uri 生效，由路由层处理。
   */
  async getUrls(uris: URI[], options: GetUrlOptions = {}): Promise<FileUrlResponse> {
    const urls: EntityUrl[] = [];
    const now = Math.floor(Date.now() / 1000);
    const ttl = options.ttlSeconds ?? this.ctx.settings.getInt('entity_url_default_ttl', 3600);
    const expiresAt = ttl > 0 ? now + ttl : 0;

    for (const uri of uris) {
      const file = await this.fs.mustResolve(uri);
      if (file.type !== FileType.File) {
        throw new AppError(CodeFileNotFound, 'Cannot generate download URL for a folder');
      }

      // 分享下载计数。原版由 navigator 的 `HookTypeBeforeDownload` 钩子完成
      // （share_navigator.go:302-308 → shareClient.Downloaded：downloads +1，
      //  remain_downloads 有值时再 -1），钩子在 `GetEntityUrls` 里触发，
      // 也就是**生成下载地址时**计数，而不是真正取字节时。
      if (uri.fsType === FileSystemType.Share && uri.id) {
        const shareId = this.ctx.codec.decodeShareID(uri.id);
        if (shareId !== null) await this.ctx.shares.incrementDownloads(shareId);
      }

      const entity = await this.primaryEntityOf(file, options.entity);
      const name = file.name;

      const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
      if (!policy) throw Err.policyNotAllowed();
      const driver = this.ctx.driverFor(policy);
      const caps = driver.capabilities();

      let url: string;
      if (!caps.proxyRequired) {
        // 驱动可直链
        url = await driver.source(entity.source, {
          expire: expiresAt > 0 ? expiresAt * 1000 : undefined,
          isDownload: options.download === true,
          displayName: name,
          speed: 0,
        });
      } else {
        url = await this.buildProxyUrl(
          entity.id,
          name,
          expiresAt,
          options.download === true,
          await this.speedLimitFor(file),
        );
      }

      const item: EntityUrl = { url };
      if (driver.settings?.stream_saver) {
        item.stream_saver_display_name = name;
      }
      urls.push(item);
      logAudit(this.ctx, 'entity_downloaded', this.ctx.user?.id ?? null, { name });
    }

    return { urls, expires: expiresAt > 0 ? new Date(expiresAt * 1000).toISOString() : null };
  }

  /** 取文件的主实体；`entityHashId` 指定时校验归属。 */
  private async primaryEntityOf(file: FileRow, entityHashId?: string): Promise<EntityRow> {
    if (entityHashId) {
      const id = this.ctx.codec.decodeEntityID(entityHashId);
      if (id === null) throw new AppError(CodeEntityNotExist, 'Entity not found');
      const entity = await this.ctx.entities.byId(id);
      if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');
      return entity;
    }
    if (!file.primary_entity) {
      throw new AppError(CodeEntityNotExist, 'File has no content entity');
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');
    return entity;
  }

  /** 构造本站代理下载地址并签名。`download` 为真时响应带 attachment 头。 */
  private async buildProxyUrl(
    entityId: number,
    name: string,
    expiresAt: number,
    download: boolean,
    speed = 0,
  ): Promise<string> {
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const entityHash = this.ctx.codec.encodeEntityID(entityId);
    const path = `/api/v4/file/content/${entityHash}/${speed}/${encodeURIComponent(name)}`;
    const sign = await this.ctx.signer.sign(path, expiresAt);
    // 上游语义（pkg/cluster/routes/routes.go:15）：query 里 `download` 非空
    // 即表示强制下载；签名只覆盖 pathname，query 参数不参与签名
    const suffix = download ? '?download=true&sign=' : '?sign=';
    return `${base}${path}${suffix}${encodeURIComponent(sign)}`;
  }

  /**
   * 文件属主的组下载限速（字节/秒，0 = 不限）。
   * 编进代理 URL 的 `:speed` 段，由内容分发端点执行 —— 代理地址是
   * 签名给匿名用的，执行时拿不到用户上下文，所以限速必须在铸造时带上。
   */
  private async speedLimitFor(file: FileRow): Promise<number> {
    const user = this.ctx.user;
    if (user && user.id === file.owner_id) return user.group?.speed_limit ?? 0;
    if (!file.owner_id) return 0;
    const owner = await this.ctx.users.byId(file.owner_id);
    if (!owner) return 0;
    const group = await this.ctx.groups.byId(owner.group_users);
    return group?.speed_limit ?? 0;
  }

  /**
   * 代理下载：把实体内容以流的形式返回。
   * 支持 Range 透传，便于视频拖动与断点续传。
   *
   * **边缘 CDN 缓存**（`policy.settings.edge_cache === true` 且非 Range 请求时）：
   * 先查 Cloudflare 边缘缓存（规范化键不含签名 query），未命中回源后经
   * waitUntil 把完整响应写入缓存。同文件重复下载直接边缘命中，
   * 不再回源存储。Range（206）与限速不参与缓存 —— 限速在路由层施加，
   * 缓存里始终是未限速的原始流。
   */
  async serveEntity(
    entityHashId: string,
    name: string,
    range?: string | null,
    edgeCache?: { origin: string; waitUntil?: (p: Promise<unknown>) => void },
  ): Promise<ObjectContent> {
    const entityId = this.ctx.codec.decodeEntityID(entityHashId);
    if (entityId === null) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const entity = await this.ctx.entities.byId(entityId);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const driver = this.ctx.driverFor(policy);

    const cacheable =
      !!edgeCache && !range && policy.settings?.edge_cache === true;
    const cacheKey = `/__edge_cache__/content/${entityHashId}/${encodeURIComponent(name)}`;

    if (cacheable) {
      const hit = await edgeCacheMatch(edgeCache!.origin, cacheKey);
      if (hit) return objectFromCacheResponse(hit, entity.size ?? 0);
    }

    const content = await driver.get(entity.source, range ?? null);
    if (!content) throw new AppError(CodeFileNotFound, 'Object not found in storage backend');
    void name;

    // 回源成功且是完整 200 内容 → 后台写入边缘缓存（tee 出一路流，不影响本次响应）
    if (cacheable && !content.contentRange && content.body) {
      const [toClient, toCache] = (content.body as ReadableStream).tee();
      const headers = new Headers();
      headers.set('Content-Type', content.contentType ?? 'application/octet-stream');
      headers.set('Content-Length', String(content.size));
      const cacheRes = new Response(toCache, { status: 200, headers });
      edgeCachePut(edgeCache!.waitUntil, edgeCache!.origin, cacheKey, cacheRes, EDGE_CACHE_TTL_S);
      return { ...content, body: toClient };
    }

    return content;
  }

  /**
   * 缩略图地址。
   *
   * 优先用驱动自带的原生缩略图（OneDrive 等）；R2/S3 等无原生缩略图的驱动，
   * 对图片走 Cloudflare Image Resizing 实时缩放——把原始对象签名地址交给新增的
   * `/api/v4/file/thumbimg` 端点，由 Worker 在取图时实时缩放后回传。视频/Office
   * 文档缩略图仍依赖驱动原生能力（OneDrive 可用）。
   */
  async thumb(uri: URI): Promise<{ url: string; expires: string | null }> {
    const file = await this.fs.mustResolve(uri);
    if (file.type !== FileType.File || !file.primary_entity) {
      return { url: '', expires: null };
    }
    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) return { url: '', expires: null };

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) return { url: '', expires: null };
    const driver = this.ctx.driverFor(policy);

    // 驱动自带的原生缩略图（OneDrive 等）优先
    const native = await driver.thumb(entity.source, 'large').catch(() => null);
    if (native) return { url: native, expires: null };

    // R2/S3 等无原生缩略图：对图片走 Cloudflare Image Resizing 实时缩放
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff'].includes(
      ext,
    );
    if (!isImage) return { url: '', expires: null };

    const ttl = this.ctx.settings.getInt('entity_url_default_ttl', 3600);
    const src = await driver
      .source(entity.source, {
        expire: Date.now() + ttl * 1000,
        isDownload: false,
        displayName: file.name,
        speed: 0,
      })
      .catch(() => null);
    if (!src) return { url: '', expires: null };

    const w = this.ctx.settings.getInt('thumb_width', 512);
    const h = this.ctx.settings.getInt('thumb_height', 512);
    const sign = await this.ctx.signer.sign(src);
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const url = `${base}/api/v4/file/thumbimg?src=${encodeURIComponent(src)}&w=${w}&h=${h}&sign=${encodeURIComponent(sign)}`;
    return { url, expires: null };
  }

  // -------------------------------------------------------------------------
  // 外链（直链）
  // -------------------------------------------------------------------------

  async createDirectLink(uris: URI[], speed = 0): Promise<DirectLinkInfo[]> {
    const user = this.ctx.requireUser();
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const results: DirectLinkInfo[] = [];
    for (const uri of uris) {
      const file = await this.fs.mustResolve(uri);
      if (file.owner_id !== user.id && !this.ctx.isAdmin) {
        throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
      }
      const link = await this.ctx.directLinks.create(file.id, file.name, speed);
      logAudit(this.ctx, 'get_direct_link', user.id, { name: file.name });
      const id = this.ctx.codec.encodeSourceLinkID(link.id);
      results.push({
        id,
        // 字段名对齐前端直链契约：link = 直链 URL，file_url = 文件 URI
        link: `${base}${DIRECT_LINK_PREFIX}/${id}/${encodeURIComponent(file.name)}`,
        url: `${base}${DIRECT_LINK_PREFIX}/${id}/${encodeURIComponent(file.name)}`,
        downloaded: link.downloads,
        created_at: link.created_at.toISOString(),
        file_url: uri.toString(),
      });
    }
    return results;
  }

  async deleteDirectLink(linkHashId: string): Promise<void> {
    const id = this.ctx.codec.decodeSourceLinkID(linkHashId);
    if (id === null) throw new AppError(404, 'Direct link not found');
    const link = await this.ctx.directLinks.byId(id);
    if (!link) throw new AppError(404, 'Direct link not found');
    const user = this.ctx.requireUser();
    const file = await this.ctx.files.byId(link.file_id);
    if (!file || (file.owner_id !== user.id && !this.ctx.isAdmin)) {
      throw new AppError(CodeOwnerOnly, 'Only owner or administrator can perform this action');
    }
    await this.ctx.directLinks.softDelete(id);
    logAudit(this.ctx, 'delete_direct_link', user.id, { name: file.name });
  }

  /** 访问直链：返回远端地址（由路由层 302）。 */
  async visitDirectLink(linkHashId: string): Promise<string> {
    const id = this.ctx.codec.decodeSourceLinkID(linkHashId);
    if (id === null) throw new AppError(404, 'Direct link not found');
    const link = await this.ctx.directLinks.byId(id);
    if (!link) throw new AppError(404, 'Direct link not found');

    const file = await this.ctx.files.byId(link.file_id);
    if (!file || !file.primary_entity) throw Err.fileNotFound();

    // 上游 PR #3524（GetFileFromDirectLink）：属主被封禁/删除，或其当前
    // 所在组已无源流能力（source_batch <= 0）时，直链立即失效。
    const owner = file.owner_id ? await this.ctx.users.byId(file.owner_id) : null;
    if (!owner || owner.status !== 'active') {
      throw new AppError(404, 'Direct link not found');
    }
    const ownerGroup = owner.group_users ? await this.ctx.groups.byId(owner.group_users) : null;
    if (!ownerGroup || !ownerGroup.settings || (ownerGroup.settings.source_batch ?? 0) <= 0) {
      throw new AppError(404, 'Direct link not found');
    }

    const entity = await this.ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeEntityNotExist, 'Entity not found');

    const policy = await this.ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const driver = this.ctx.driverFor(policy);
    const caps = driver.capabilities();

    await this.ctx.directLinks.incrementDownloads(id);

    if (!caps.proxyRequired) {
      return driver.source(entity.source, {
        isDownload: true,
        displayName: file.name,
        speed: link.speed,
      });
    }

    // 需要代理时返回本站签名地址（带上属主组限速）
    const expiresAt = Math.floor(Date.now() / 1000) + this.ctx.settings.getInt('entity_url_default_ttl', 3600);
    return this.buildProxyUrl(entity.id, file.name, expiresAt, true, await this.speedLimitFor(file));
  }

  /**
   * 打包下载：创建一个带签名的临时归档会话，返回 archive.zip 直链。
   *
   * 对应上游 `FileURLService.GetArchiveDownloadSession`（service/explorer/file.go:387）：
   * KV 里存 `{uris, requester_id}`（键前缀 `archive_`，TTL 取站点设置
   * `archive_timeout`），随后对 `/api/v4/file/archive/:sessionID/archive.zip`
   * 签名。取包端点（routes/file.ts）按签名放行，并恢复请求者身份跑打包。
   */
  async archiveDownload(uris: URI[]): Promise<FileUrlResponse> {
    this.ctx.requireGroupPermission(
      GroupPermission.ArchiveDownload,
      'Archive download is not allowed for your group',
    );
    const user = this.ctx.requireUser();
    const sessionId = crypto.randomUUID();
    // 上游默认 20 秒（archive_timeout）；边缘版默认放宽到 600，下限 60（KV 最低 TTL）
    const ttl = Math.max(60, this.ctx.settings.getInt('archive_timeout', 600));
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttl;

    await kvFor(this.ctx.env, 'upload').put(
      `archive_${sessionId}`,
      JSON.stringify({ uris: uris.map((u) => u.toString()), requester_id: user.id }),
      { expirationTtl: ttl },
    );

    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const path = `/api/v4/file/archive/${sessionId}/archive.zip`;
    const sign = await this.ctx.signer.sign(path, expiresAt);
    return {
      urls: [{ url: `${base}${path}?sign=${encodeURIComponent(sign)}` }],
      expires: new Date(expiresAt * 1000).toISOString(),
    };
  }
}

export { CodeInvalidSign, CodeSignExpired, FileSystemType };
