/**
 * 文件路由。对应 Cloudreve v4 `routers/router.go` 的 file 分组。
 *
 * 已实现的端点（路径与请求/响应字段对齐原版）：
 *   GET    /api/v4/file                      列目录 / 回收站 / 搜索
 *   GET    /api/v4/file/info                 单文件详情
 *   POST   /api/v4/file/create               新建文件夹/文件
 *   POST   /api/v4/file/rename               重命名
 *   POST   /api/v4/file/move                 移动 / 复制
 *   POST   /api/v4/file/url                  取下载/预览地址
 *   GET    /api/v4/file/thumb                缩略图地址
 *   GET    /api/v4/file/content/:id/:speed/:name   实体内容（代理下载，需签名）
 *   PUT    /api/v4/file/content              覆盖文件内容
 *   DELETE /api/v4/file                      删除（进回收站）
 *   POST   /api/v4/file/restore              从回收站恢复
 *   DELETE /api/v4/file/trash                清空回收站
 *   PATCH  /api/v4/file/metadata             修改元数据
 *   PATCH  /api/v4/file/view                 保存目录视图
 *   PUT    /api/v4/file/upload               创建上传会话
 *   POST   /api/v4/file/upload/:sid/:index   上传分片
 *   DELETE /api/v4/file/upload               取消上传
 *   PUT|DELETE /api/v4/file/pin              固定 / 取消固定
 *   PUT    /api/v4/file/source               创建直链
 *   DELETE /api/v4/file/source/:id           删除直链
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { kvFor } from '../lib/kvRouter';
import { edgeCacheMatch, edgeCachePut } from '../lib/edgeCache';
import type { AppContext } from '../services/context';
import type { FileRow } from '../db/types';
import { AppContext as AppContextClass } from '../services/context';
import { FileSystemService } from '../services/fs';
import { parseFileViewers } from '../settings/fileViewers';
import { SearchService } from '../services/search';
import { UploadService } from '../services/upload';
import { DownloadService } from '../services/download';
import { UserService } from '../services/user';
import { subscribe, type FsEvent } from '../services/events';
import { WorkflowService } from '../services/workflow';
import { readCentralDirectory, type RangeReader } from '../lib/zipread';
import { createZipStream } from '../lib/zip';
import { ZipError } from '../lib/zipread';
import { drain, nameDecoder } from '../services/workflow';
import { URI } from '../services/uri';
import { FileType } from '../lib/boolset';
import { AppError, CodeFeatureNotEnabled, CodeNotFound, Err } from '../lib/errors';
import { attachmentDisposition } from '../lib/disposition';
import { throttleStream } from '../lib/throttle';

export const fileRoutes = new Hono<AppBindings>();

/** 统一的「需要登录」守卫 */
function guard(c: AppRequest): boolean {
  return Boolean(ctxOf(c).user);
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

fileRoutes.get('/', async (c) => {
  const ctx = ctxOf(c);

  const rawUri = c.req.query('uri');
  if (!rawUri) return fail(c, Err.param('uri is required'));

  let uri: URI;
  try {
    uri = URI.parse(rawUri);
  } catch {
    return fail(c, Err.param('Invalid uri'));
  }

  // 这里**不能**一刀切要求登录：匿名访问分享目录是合法路径（原版靠匿名用户组放行，
  // share navigator 自己会校验密码与 ShareDownload 权限）。
  // my / trash 的登录要求由 resolveMy / resolveTrash 内部抛 401。

  const page = Math.max(0, Number(c.req.query('page') ?? 0) || 0);
  const pageSize = Number(c.req.query('page_size') ?? 0) || 0;
  const orderBy = c.req.query('order_by') ?? '';
  const orderDirection = c.req.query('order_direction') ?? '';
  const typeRaw = c.req.query('type');

  let typeFilter: number | null = null;
  if (typeRaw === 'file') typeFilter = FileType.File;
  else if (typeRaw === 'folder') typeFilter = FileType.Folder;

  try {
    const service = new FileSystemService(ctx);
    const res = await service.list(uri, { page, pageSize, orderBy, orderDirection, typeFilter });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.get('/info', async (c) => {
  const ctx = ctxOf(c);

  const rawUri = c.req.query('uri');
  const idHash = c.req.query('id');
  const extended = c.req.query('extended') === 'true';
  const wantSummary = c.req.query('folder_summary') === 'true';

  const service = new FileSystemService(ctx);
  try {
    let file;
    if (rawUri) {
      // 走 navigator：分享要过密码与权限，my 要求是本人
      file = await service.mustResolve(URI.parse(rawUri));
    } else if (idHash) {
      const id = ctx.codec.decodeFileID(idHash);
      if (id === null) throw Err.fileNotFound();
      const target = await ctx.files.byId(id);
      if (!target) throw Err.fileNotFound();
      // 与原版 `GetFileInfoService.Get` 一致：id 先还原成 URI（`m.TraverseFile`），
      // 再交给 navigator 做权限校验 —— 否则就是凭 hashid 越权读元数据。
      const backUri = service.isInTrash(target)
        ? URI.trash(target.name)
        : URI.my(await service.pathOf(target));
      file = await service.mustResolve(backUri);
    } else {
      return fail(c, Err.param('uri or id is required'));
    }
    return ok(c, await service.buildFileResponse(file, { extended, folderSummary: wantSummary }));
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 创建 / 重命名 / 移动
// ---------------------------------------------------------------------------

fileRoutes.post('/create', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    type?: string;
    metadata?: Record<string, string>;
    err_on_conflict?: boolean;
  };
  if (!body.uri || !body.type) return fail(c, Err.param('uri and type are required'));
  if (body.type !== 'file' && body.type !== 'folder') {
    return fail(c, Err.param('type must be "file" or "folder"'));
  }
  try {
    const res = await new FileSystemService(ctx).create(URI.parse(body.uri), body.type, {
      metadata: body.metadata,
      errOnConflict: body.err_on_conflict,
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.post('/rename', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; new_name?: string };
  if (!body.uri || !body.new_name) {
    return fail(c, Err.param('uri and new_name are required'));
  }
  try {
    const res = await new FileSystemService(ctx).rename(URI.parse(body.uri), body.new_name);
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.post('/move', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    dst?: string;
    copy?: boolean;
  };
  if (!body.uris?.length || !body.dst) {
    return fail(c, Err.param('uris and dst are required'));
  }
  if (body.uris.length > ctx.settings.maxBatchedFile) {
    return fail(c, new AppError(40074, 'Too many uris'));
  }
  try {
    const service = new FileSystemService(ctx);
    await service.moveOrCopy(
      body.uris.map((u) => URI.parse(u)),
      URI.parse(body.dst),
      body.copy === true,
    );
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 下载地址
// ---------------------------------------------------------------------------

fileRoutes.post('/url', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    download?: boolean;
    redirect?: boolean;
    entity?: string;
    no_cache?: boolean;
    archive?: boolean;
  };
  if (!body.uris?.length) return fail(c, Err.param('uris is required'));

  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);

    // 打包下载：返回一个签名过的 archive.zip 临时地址（上游 GetArchiveDownloadSession）
    if (body.archive) {
      return ok(c, await download.archiveDownload(body.uris.map((u) => URI.parse(u))));
    }

    const res = await download.getUrls(
      body.uris.map((u) => URI.parse(u)),
      { download: body.download, entity: body.entity, noCache: body.no_cache },
    );

    // 单个 uri 且要求 redirect 时直接 302（原版行为）
    if (body.redirect && body.uris.length === 1 && res.urls[0]) {
      return c.redirect(res.urls[0].url, 302);
    }
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.get('/thumb', async (c) => {
  const ctx = ctxOf(c);
  const rawUri = c.req.query('uri');
  if (!rawUri) return fail(c, Err.param('uri is required'));
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    return ok(c, await download.thumb(URI.parse(rawUri)));
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 缩略图实际成像端点（GET）。由 `download.thumb()` 生成带签名 `src` 的 URL，
 * 浏览器以 `<img src>` 拉取。这里取出 `src`（已 HMAC 签名防篡改），用
 * Cloudflare Image Resizing 实时缩放后返回。
 *
 * 需要站点所在 zone 启用 Image Resizing 付费附加项；未启用（或缩放失败）时
 * 回退为原图（浏览器按 CSS 缩放），缩略图依然可用。
 */
fileRoutes.get('/thumbimg', async (c) => {
  const ctx = ctxOf(c);
  const src = c.req.query('src');
  const sign = c.req.query('sign');
  const w = Number.parseInt(c.req.query('w') ?? '0', 10);
  const h = Number.parseInt(c.req.query('h') ?? '0', 10);
  if (!src || !sign) return fail(c, Err.param('missing src or sign'));
  try {
    await ctx.signer.check(src, sign);
  } catch {
    return fail(c, Err.noPermission());
  }

  // 缩略图边缘缓存：列表页一次拉几十张，全部走 Worker 实时缩放是最重的
  // 回源热点。键规范化为「去 sign 后的稳定 URL」，签名轮换不影响命中。
  const u = new URL(c.req.url);
  const cacheKey = `/__edge_cache__/thumbimg?src=${encodeURIComponent(src)}&w=${w}&h=${h}`;
  const hit = await edgeCacheMatch(u.origin, cacheKey);
  if (hit) return hit;

  const opts: RequestInit & { cf?: { image?: Record<string, unknown> } } = { method: 'GET' };
  if (w > 0 && h > 0) opts.cf = { image: { width: w, height: h, fit: 'cover' } };

  let res = await fetch(src, opts);
  if (!res.ok && opts.cf) {
    // Image Resizing 不可用 / 失败 → 回退原图
    res = await fetch(src);
  }
  if (!res.ok) {
    return fail(c, new AppError(res.status, 'image source unavailable'));
  }

  const headers = new Headers();
  const ct = res.headers.get('content-type');
  if (ct) headers.set('content-type', ct);
  headers.set('cache-control', 'public, max-age=86400');
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers.set('content-disposition', disposition);
  // 先 clone 再拆流：res.body 一旦交给 out 就被锁定，届时再 clone 会抛错
  edgeCachePut(
    ctx.waitUntil,
    u.origin,
    cacheKey,
    new Response(res.clone().body, { status: 200, headers }),
    86400,
  );
  return new Response(res.body, { status: 200, headers });
});

/**
 * 实体内容分发（代理下载）。
 * 需要 URL 签名；支持 Range，便于视频拖动。
 */
const serveContent = async (c: AppRequest) => {
  const ctx = ctxOf(c);
  const entityHash = c.req.param('id') ?? '';
  const name = c.req.param('name') ?? '';

  // 校验签名：路径参与签名，query 里的 sign 本身不参与
  const url = new URL(c.req.url);
  const sign = url.searchParams.get('sign');
  if (!sign) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer Cr ')) {
      return fail(c, new AppError(403, 'authorization header is missing'));
    }
    try {
      await ctx.signer.check(url.pathname, authHeader.slice('Bearer Cr '.length));
    } catch (e) {
      return fail(c, e);
    }
  } else {
    try {
      await ctx.signer.check(url.pathname, sign);
    } catch (e) {
      return fail(c, e);
    }
  }

  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    // 边缘 CDN 缓存：策略开关在 serveEntity 内判定（policy.settings.edge_cache）；
    // HEAD 请求无响应体，不参与缓存。
    const edgeCache =
      c.req.method === 'HEAD'
        ? undefined
        : { origin: url.origin, waitUntil: ctx.waitUntil };
    const content = await download.serveEntity(
      entityHash,
      name,
      c.req.header('Range') ?? null,
      edgeCache,
    );

    const headers = new Headers();
    headers.set('Content-Type', content.contentType ?? 'application/octet-stream');
    headers.set('Accept-Ranges', 'bytes');
    if (content.contentRange) {
      headers.set('Content-Range', content.contentRange);
      headers.set('Content-Length', String(content.size));
    } else {
      headers.set('Content-Length', String(content.size));
    }
    // 与原版一致：内容接口允许跨域
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Disposition');

    // 强制下载（上游 IsDownloadQuery="download"，非空即真 → attachment 头）。
    // 没有它，JSON/文本等浏览器可渲染的类型会在新标签页直接打开而非下载。
    if (url.searchParams.get('download')) {
      headers.set('Content-Disposition', attachmentDisposition(name));
    }

    if (c.req.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    // 限速：代理 URL 的 :speed 段（铸造时编入属主组限速，字节/秒），0 = 不限
    const speed = Number(c.req.param('speed')) || 0;
    const body = speed > 0 ? throttleStream(content.body, speed) : content.body;
    return new Response(body, {
      status: content.contentRange ? 206 : 200,
      headers,
    });
  } catch (e) {
    return fail(c, e);
  }
};

fileRoutes.get('/content/:id/:speed/:name', serveContent);
fileRoutes.on('HEAD', '/content/:id/:speed/:name', serveContent);

/** CORS 预检 */
fileRoutes.options('/content/*', (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
});

/** 覆盖文件内容（PUT 原始字节流） */
fileRoutes.put('/content', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const rawUri = c.req.query('uri');
  if (!rawUri) return fail(c, Err.param('uri is required'));

  const body = c.req.raw.body;
  if (!body) return fail(c, Err.param('Request body is required'));

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    upload.onUploadFinished = (file) => hookFtsIndex(c, ctx, file);
    await upload.overwriteContent(URI.parse(rawUri), body, Number(c.req.header('Content-Length') ?? 0), c.req.header('Content-Type') ?? '', {
      previous: c.req.query('previous') ?? undefined,
    });
    // 前端 sendUpdateFile 期望拿到保存后的文件对象（FileResponse）：
    // savedFile.primary_entity 驱动编辑器版本号与列表刷新，返回空体会让
    // 「已保存」提示与版本更新全部失效（上游 UpdateContent 返回文件）。
    // 注意 mustResolve 重取一次 —— 上面刚换过 primary_entity，旧行是脏的。
    const fresh = await service.mustResolve(URI.parse(rawUri));
    return ok(c, await service.buildFileResponse(fresh));
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 删除 / 恢复 / 清空
// ---------------------------------------------------------------------------

fileRoutes.delete('/', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    unlink?: boolean;
    skip_soft_delete?: boolean;
  };
  if (!body.uris?.length) return fail(c, Err.param('uris is required'));
  if (body.uris.length > ctx.settings.maxBatchedFile) {
    return fail(c, new AppError(40074, 'Too many uris'));
  }
  try {
    await new FileSystemService(ctx).delete(
      body.uris.map((u) => URI.parse(u)),
      { unlinkOnly: body.unlink, skipSoftDelete: body.skip_soft_delete },
    );
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.post('/restore', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uris?: string[] };
  if (!body.uris?.length) return fail(c, Err.param('uris is required'));
  try {
    await new FileSystemService(ctx).restore(body.uris.map((u) => URI.parse(u)));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.delete('/trash', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  try {
    await new FileSystemService(ctx).emptyTrash();
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 强制解锁（边缘版没有文件锁，直接成功） */
fileRoutes.delete('/lock', async (c) => ok(c));

// ---------------------------------------------------------------------------
// 元数据与视图
// ---------------------------------------------------------------------------

fileRoutes.patch('/metadata', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uris?: string[];
    patches?: { key: string; value?: string; private?: boolean; remove?: boolean }[];
  };
  if (!body.uris?.length || !body.patches?.length) {
    return fail(c, Err.param('uris and patches are required'));
  }
  try {
    const service = new FileSystemService(ctx);
    for (const raw of body.uris) {
      const file = await service.mustResolve(URI.parse(raw));
      for (const patch of body.patches) {
        if (patch.remove) {
          await ctx.metadata.remove(file.id, patch.key);
        } else {
          // 原版要求元数据必须是 public（private=true 会被 binding 拒绝）
          await ctx.metadata.upsert(file.id, patch.key, patch.value ?? '', !patch.private);
        }
      }
    }
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.patch('/view', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    view?: Record<string, unknown>;
  };
  if (!body.uri) return fail(c, Err.param('uri is required'));
  try {
    const service = new FileSystemService(ctx);
    const file = await service.mustResolve(URI.parse(body.uri));
    const props = { ...(file.props ?? {}) };
    if (body.view) props.view = body.view as never;
    await ctx.files.patchProps(file.id, props as Record<string, unknown>);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

fileRoutes.put('/upload', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    size?: number;
    last_modified?: number;
    mime_type?: string;
    policy_id?: string;
    metadata?: Record<string, string>;
    entity_type?: string;
  };
  if (!body.uri) return fail(c, Err.param('uri is required'));

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    const res = await upload.createSession({
      uri: body.uri,
      size: Number(body.size ?? 0),
      lastModified: body.last_modified,
      mimeType: body.mime_type,
      policyId: body.policy_id,
      metadata: body.metadata,
      entityType: body.entity_type,
    });
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.post('/upload/:sessionId/:index', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());

  const sessionId = c.req.param('sessionId');
  const index = Number(c.req.param('index'));
  const contentLength = Number(c.req.header('Content-Length') ?? 0);

  if (!Number.isInteger(index) || index < 0) {
    return fail(c, new AppError(40012, 'Invalid chunk index'));
  }
  const body = c.req.raw.body;
  if (!body) return fail(c, Err.param('Request body is required'));

  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    upload.onUploadFinished = (file) => hookFtsIndex(c, ctx, file);
    await upload.uploadChunk(sessionId, index, body, contentLength);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.delete('/upload', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { id?: string; uri?: string };
  if (!body.id) return fail(c, Err.param('id is required'));
  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    await upload.deleteSession(body.id, body.uri);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 固定
// ---------------------------------------------------------------------------

fileRoutes.put('/pin', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; name?: string };
  if (!body.uri) return fail(c, Err.param('uri is required'));
  try {
    await new UserService(ctx).pin(body.uri, body.name, true);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.delete('/pin', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string };
  if (!body.uri) return fail(c, Err.param('uri is required'));
  try {
    await new UserService(ctx).pin(body.uri, undefined, false);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 直链
// ---------------------------------------------------------------------------

fileRoutes.put('/source', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uris?: string[] };
  if (!body.uris?.length) return fail(c, Err.param('uris is required'));
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    const uris = body.uris.map((u) => URI.parse(u));
    const links = await download.createDirectLink(uris);
    return ok(c, links);
  } catch (e) {
    return fail(c, e);
  }
});

fileRoutes.delete('/source/:id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  try {
    const service = new FileSystemService(ctx);
    const download = new DownloadService(ctx, service);
    await download.deleteDirectLink(c.req.param('id'));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 版本管理
//
// 历史版本列表不在这里 —— 它由 `GET /file/info?extended=true` 的
// `extended_info.entities` 下发（对齐 `service/explorer/response.go:280-287`），
// 这两个端点只负责「切当前版本」和「删某个版本」。
// ---------------------------------------------------------------------------

/** 把文件的当前版本切换成指定历史版本。 */
fileRoutes.post('/version/current', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; version?: string };
  if (!body.uri || !body.version) {
    return fail(c, Err.param('uri and version are required'));
  }

  const versionId = ctx.codec.decodeEntityID(body.version);
  if (versionId === null) {
    return fail(c, Err.param('unknown version id'));
  }

  try {
    await new FileSystemService(ctx).setCurrentVersion(URI.parse(body.uri), versionId);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 删除文件的某个历史版本。 */
fileRoutes.delete('/version', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as { uri?: string; version?: string };
  if (!body.uri || !body.version) {
    return fail(c, Err.param('uri and version are required'));
  }

  const versionId = ctx.codec.decodeEntityID(body.version);
  if (versionId === null) {
    return fail(c, Err.param('unknown version id'));
  }

  try {
    await new FileSystemService(ctx).deleteVersion(URI.parse(body.uri), versionId);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 上传收尾钩子：全文索引
// ---------------------------------------------------------------------------

/**
 * 上传完成后把文件送进全文索引。
 *
 * 用 `waitUntil` 挂在请求生命周期上：响应不等它，但 Workers 会保证它跑完，
 * 不出现「上传成功响应已回、索引却因请求结束被掐断」的半途状态。
 * 索引失败只记日志 —— 上传本身已经成功，不该因此报错。
 */
function hookFtsIndex(
  c: Context<AppBindings>,
  ctx: AppContext,
  file: FileRow,
): void {
  const search = new SearchService(ctx);
  if (!search.available) return;
  c.executionCtx.waitUntil(
    search.indexFile(file).catch((e) => console.error('FTS index after upload failed', e)),
  );
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/**
 * 搜索文件。对应上游 `service/explorer/file.go` → `manager.SearchFullText`。
 *
 * 与原版**同构**：配了 Meilisearch + Tika 就走真正的全文检索（正文片段带高亮），
 * 没配则回落到文件名匹配 —— 保证「开了能用，没开也能搜」，不会突然搜不到。
 *
 * 响应结构 `{ hits: [{ file, content }], total }` 两种路径完全一致。
 */
fileRoutes.get('/search', async (c) => {
  const ctx = ctxOf(c);
  if (!guard(c)) return fail(c, Err.loginRequired());

  const query = (c.req.query('query') ?? '').trim();
  if (!query) return ok(c, { hits: [], total: 0 });

  const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
  const limit = 50;
  const service = new FileSystemService(ctx);
  const search = new SearchService(ctx);

  if (search.available) {
    try {
      const found = await search.search(query, offset);
      const hits = [];
      for (const hit of found.hits) {
        const file = await ctx.files.byId(hit.fileId);
        // 索引里可能残留已删除 / 已进回收站的文件，这里按原版规则过滤
        if (!file || file.owner_id !== ctx.user!.id) continue;
        if (service.isInTrash(file)) continue;
        hits.push({ file: await service.buildFileResponse(file), content: hit.text });
      }
      return ok(c, { hits, total: found.total });
    } catch (e) {
      // 索引服务挂了不该让整个搜索不可用，静默回落到文件名匹配
      console.error('full text search failed, falling back to name match', e);
    }
  }

  try {
    const { files, total } = await ctx.files.searchByName({
      ownerId: ctx.user!.id,
      keyword: query,
      offset,
      limit,
    });
    const hits = [];
    for (const file of files) {
      hits.push({
        file: await service.buildFileResponse(file),
        content: '',
      });
    }
    return ok(c, { hits, total });
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 压缩包浏览（ZIP）
// ---------------------------------------------------------------------------

fileRoutes.get('/archive', async (c) => {
  const ctx = ctxOf(c);
  if (!guard(c)) return fail(c, Err.loginRequired());

  const rawUri = c.req.query('uri');
  if (!rawUri) return fail(c, Err.param('uri is required'));

  try {
    const uri = URI.parse(rawUri);
    const service = new FileSystemService(ctx);
    const file = await service.mustResolve(uri);
    if (file.type === FileType.Folder) return fail(c, Err.param('Target is a folder'));
    if (!file.primary_entity) throw new AppError(CodeFeatureNotEnabled, 'File has no entity');

    const entity = await ctx.entities.byId(file.primary_entity);
    if (!entity) throw new AppError(CodeFeatureNotEnabled, 'Entity is missing');
    const policy = await ctx.policies.byId(entity.storage_policy_entities);
    if (!policy) throw Err.policyNotAllowed();
    const driver = ctx.driverFor(policy);

    const read: RangeReader = async (start, end) => {
      const content = await driver.get(entity.source, `bytes=${start}-${end}`);
      if (!content) throw new ZipError(`Failed to read range ${start}-${end}`);
      return drain(content.body as ReadableStream<Uint8Array>);
    };

    const entries = await readCentralDirectory(
      read,
      entity.size,
      nameDecoder(c.req.query('text_encoding') ?? undefined),
    );

    return ok(c, {
      files: entries.map((e) => ({
        name: e.name,
        size: e.size,
        updated_at: e.mtime.toISOString(),
        is_directory: e.isDir,
      })),
    });
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 事件推送（SSE）
// ---------------------------------------------------------------------------

fileRoutes.get('/events', async (c) => {
  const ctx = ctxOf(c);
  if (!guard(c)) return fail(c, Err.loginRequired());

  const rawUri = c.req.query('uri');
  if (!rawUri) return fail(c, Err.param('uri is required'));
  const clientId = c.req.header('X-Client-Id') ?? c.req.query('client_id') ?? '';
  if (!clientId) return fail(c, Err.param('client id is required'));

  try {
    const uri = URI.parse(rawUri);
    const service = new FileSystemService(ctx);
    const folder = await service.mustResolve(uri);
    if (folder.type !== FileType.Folder) {
      return fail(c, Err.param('Events can only be subscribed on a folder'));
    }
    const ownerId = ctx.requireUser().id;
    const folderId = folder.id;

    // 目录快照：DB diff 轮询用。内存事件总线只在同 isolate 内有效，
    // 而上传请求与 SSE 请求常常落在不同 isolate，所以必须以快照对比
    // 兜底，否则前端永远收不到事件。
    const snapshot = new Map<string, { name: string; size: number; updatedAt: string }>();
    const loadSnapshot = async (): Promise<void> => {
      const { files } = await ctx.files.list({
        parentId: folderId,
        ownerId,
        page: 0,
        pageSize: 1000,
        orderBy: 'name',
        orderDirection: 'asc',
      });
      const next = new Map<string, { name: string; size: number; updatedAt: string }>();
      for (const f of files) {
        next.set(ctx.codec.encodeFileID(f.id), {
          name: f.name,
          size: f.size,
          updatedAt: f.updated_at.toISOString(),
        });
      }
      snapshot.clear();
      for (const [k, v] of next) snapshot.set(k, v);
    };
    await loadSnapshot();

    /** 对比快照的逻辑在 poll() 内实现；snapshot 初始即为当前目录内容。 */
    const encoder = new TextEncoder();
    const pending: FsEvent[] = [];
    let closed = false;
    let send: (event: string, data: unknown) => void = () => {};

    const poll = async (): Promise<void> => {
      try {
        const { files } = await ctx.files.list({
          parentId: folderId,
          ownerId,
          page: 0,
          pageSize: 1000,
          orderBy: 'name',
          orderDirection: 'asc',
        });
        const next = new Map<string, { name: string; size: number; updatedAt: string }>();
        for (const f of files) {
          next.set(ctx.codec.encodeFileID(f.id), {
            name: f.name,
            size: f.size,
            updatedAt: f.updated_at.toISOString(),
          });
        }
        // 新增 / 变更
        for (const [id, v] of next) {
          const prev = snapshot.get(id);
          if (!prev) {
            pending.push({ type: 'create', file_id: id, from: '', to: v.name });
          } else if (prev.name !== v.name) {
            pending.push({ type: 'rename', file_id: id, from: prev.name, to: v.name });
          } else if (prev.size !== v.size || prev.updatedAt !== v.updatedAt) {
            pending.push({ type: 'modify', file_id: id, from: '', to: v.name });
          }
        }
        // 删除
        for (const [id, v] of snapshot) {
          if (!next.has(id)) {
            pending.push({ type: 'delete', file_id: id, from: v.name, to: '' });
          }
        }
        snapshot.clear();
        for (const [k, v] of next) snapshot.set(k, v);
      } catch {
        // 轮询失败静默，下一轮再试
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        send = (event: string, data: unknown) => {
          if (closed) return;
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data ?? '')}\n\n`),
          );
        };
        send('subscribed', null);

        // 即时通道：同 isolate 内的发布直接推送
        const unsubscribe = subscribe(folderId, clientId, (event) => send('event', event));

        // 兜底通道：DB 快照 diff 轮询（跨 isolate 可靠）
        const POLL_MS = 4000;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async (): Promise<void> => {
          if (closed) return;
          await poll();
          while (pending.length) {
            send('event', pending.shift());
          }
          if (!closed) timer = setTimeout(tick, POLL_MS);
        };
        timer = setTimeout(tick, POLL_MS);

        const keepAlive = setInterval(() => send('keep-alive', null), 25_000);
        const cleanup = () => {
          if (closed) return;
          closed = true;
          if (timer) clearTimeout(timer);
          clearInterval(keepAlive);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        c.req.raw.signal.addEventListener('abort', cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// 在线查看器会话 + WOPI host
// ---------------------------------------------------------------------------

/** WOPI 会话缓存键前缀与 TTL（秒）。 */
const WOPI_SESSION_PREFIX = 'wopi_session:';
const WOPI_SESSION_TTL = 3600;

interface WopiSessionCache {
  uid: number;
  fileId: number;
  fileUri: string;
  viewerId: string;
  action: string;
  token: string;
}

interface ViewerDef {
  id: string;
  type: string;
  display_name?: string;
  disabled?: boolean;
  wopi_actions?: Record<string, Record<string, string>>;
}

function fileExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

/** 按 WOPI discovery 的 action URL 模板拼出最终 iframe 地址。 */
function buildWopiSrc(template: string, fileSrc: string): string {
  let srcReplaced = false;
  let url: URL;
  try {
    url = new URL(template.replace(/[<>]/g, ''));
  } catch {
    return '';
  }
  const query = url.searchParams;
  const replaced = new URLSearchParams();
  for (const [k, v] of query.entries()) {
    if (v === 'WOPI_SOURCE') {
      replaced.set(k, fileSrc);
      srcReplaced = true;
    } else if (k.toLowerCase() === 'wopisrc') {
      replaced.set(k, fileSrc);
      srcReplaced = true;
    } else {
      replaced.set(k, v);
    }
  }
  if (!srcReplaced) replaced.set('WOPISrc', fileSrc);
  replaced.set('lang', 'lng');
  url.search = replaced.toString();
  return url.toString();
}

fileRoutes.post('/viewerSession', async (c) => {
  const ctx = ctxOf(c);
  if (!guard(c)) return fail(c, Err.loginRequired());

  const body = (await c.req.json().catch(() => ({}))) as {
    uri?: string;
    viewer_id?: string;
    preferred_action?: string;
    version?: string;
  };
  if (!body.uri || !body.viewer_id || !body.preferred_action) {
    return fail(c, Err.param('uri, viewer_id and preferred_action are required'));
  }

  try {
    const uri = URI.parse(body.uri);
    const service = new FileSystemService(ctx);
    const file = await service.mustResolve(uri);
    if (file.type === FileType.Folder) return fail(c, Err.param('Target is a folder'));

    // 找 viewer（file_viewers 设置：ViewerGroup[]；空集/坏值回落内置默认集，
    // 与 site.ts 的 explorer 配置同一套解析，别在这里裸 JSON.parse）
    const groups = parseFileViewers(ctx.settings.get('file_viewers')) as ViewerDef[][];
    let viewer: ViewerDef | undefined;
    for (const group of groups) {
      const list = Array.isArray(group) ? group : (group as unknown as { viewers?: ViewerDef[] }).viewers ?? [];
      viewer = list.find((v) => v.id === body.viewer_id && !v.disabled);
      if (viewer) break;
    }
    if (!viewer) return fail(c, Err.param('unknown viewer id'));

    let wopiSrc: string | undefined;
    if (viewer.type === 'wopi') {
      const actions = viewer.wopi_actions?.[fileExt(file.name)] ?? {};
      const template = actions[body.preferred_action] ?? actions.view ?? actions.edit;
      if (!template) {
        return fail(
          c,
          new AppError(CodeFeatureNotEnabled, 'Action not supported by current wopi endpoint'),
        );
      }
      const base = ctx.settings.siteUrl.replace(/\/+$/, '');
      const fileSrc = `${base}/api/v4/file/wopi/${ctx.codec.encodeFileID(file.id)}`;
      wopiSrc = buildWopiSrc(template, fileSrc);
    }

    const sessionId = crypto.randomUUID();
    const token = `${sessionId}.${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
    const session: WopiSessionCache = {
      uid: ctx.requireUser().id,
      fileId: file.id,
      fileUri: uri.toString(),
      viewerId: viewer.id,
      action: body.preferred_action,
      token,
    };
    await kvFor(ctx.env, 'upload').put(WOPI_SESSION_PREFIX + sessionId, JSON.stringify(session), {
      expirationTtl: WOPI_SESSION_TTL,
    });

    return ok(c, {
      session: {
        id: sessionId,
        access_token: token,
        expires: Date.now() + WOPI_SESSION_TTL * 1000,
      },
      ...(wopiSrc ? { wopi_src: wopiSrc } : {}),
    });
  } catch (e) {
    return fail(c, e);
  }
});

/** WOPI 会话校验。合法时返回会话与文件行；否则 null。 */
async function wopiSessionOf(
  ctx: AppContext,
  fileIdRaw: string,
  accessToken: string | undefined,
): Promise<{ session: WopiSessionCache; file: FileRow } | null> {
  if (!accessToken || !accessToken.includes('.')) return null;
  const sessionId = accessToken.slice(0, accessToken.indexOf('.'));
  const raw = await kvFor(ctx.env, 'upload').get(WOPI_SESSION_PREFIX + sessionId);
  if (!raw) return null;
  let session: WopiSessionCache;
  try {
    session = JSON.parse(raw) as WopiSessionCache;
  } catch {
    return null;
  }
  if (session.token !== accessToken) return null;
  const fileId = ctx.codec.decodeFileID(fileIdRaw);
  if (fileId === null || fileId !== session.fileId) return null;
  const file = await ctx.files.byId(fileId);
  if (!file) return null;
  return { session, file };
}

function wopiVersionHeader(ctx: AppContext, file: FileRow): Record<string, string> {
  return file.primary_entity
    ? { 'X-WOPI-ItemVersion': ctx.codec.encodeEntityID(file.primary_entity) }
    : {};
}

fileRoutes.get('/wopi/:id', async (c) => {
  const ctx = ctxOf(c);
  const found = await wopiSessionOf(ctx, c.req.param('id') ?? '', c.req.query('access_token'));
  if (!found) return c.text('invalid access token', 401);
  const { session, file } = found;

  const user = await ctx.users.byId(session.uid);
  const canEdit =
    file.owner_id === session.uid &&
    (c.req.query('preferred_action') ?? 'view') !== 'view' &&
    Boolean(file.primary_entity);

  return c.json({
    BaseFileName: file.name,
    Version: ctx.codec.encodeEntityID(file.primary_entity ?? file.id),
    Size: file.size,
    UserId: ctx.codec.encodeUserID(session.uid),
    UserFriendlyName: user?.nick ?? '',
    IsAnonymousUser: false,
    ReadOnly: !canEdit,
    UserCanWrite: canEdit,
    UserCanReview: canEdit,
    UserCanNotWriteRelative: true,
    SupportsRename: true,
    SupportsReviewing: true,
    SupportsLocks: true,
    SupportsUpdate: canEdit,
    SupportsGetLock: true,
    FileSharingPostMessage: file.owner_id === session.uid,
    EnableShare: file.owner_id === session.uid,
    FileVersionPostMessage: true,
    ClosePostMessage: true,
    PostMessageOrigin: '*',
    FileNameMaxLength: 255,
    LastModifiedTime: file.updated_at.toISOString(),
    BreadcrumbBrandName: ctx.settings.get('siteName', 'Cloudreve'),
    BreadcrumbBrandUrl: ctx.settings.siteUrl,
    BreadcrumbFolderName: '',
    BreadcrumbFolderUrl: ctx.settings.siteUrl,
  });
});

fileRoutes.get('/wopi/:id/contents', async (c) => {
  const ctx = ctxOf(c);
  const found = await wopiSessionOf(ctx, c.req.param('id') ?? '', c.req.query('access_token'));
  if (!found) return c.text('invalid access token', 401);
  const { file } = found;
  if (!file.primary_entity) return c.text('file has no entity', 404);

  const entity = await ctx.entities.byId(file.primary_entity);
  if (!entity) return c.text('entity is missing', 404);
  const policy = await ctx.policies.byId(entity.storage_policy_entities);
  if (!policy) return c.text('policy not allowed', 400);
  const driver = ctx.driverFor(policy);

  const content = await driver.get(entity.source, c.req.header('Range') ?? null);
  if (!content) return c.text('object not found', 404);

  return new Response(content.body, {
    status: content.contentRange ? 206 : 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(content.size),
      ...(content.contentRange ? { 'Content-Range': content.contentRange } : {}),
      ...wopiVersionHeader(ctx, file),
    },
  });
});

fileRoutes.post('/wopi/:id/contents', async (c) => {
  const ctx = ctxOf(c);
  const found = await wopiSessionOf(ctx, c.req.param('id') ?? '', c.req.query('access_token'));
  if (!found) return c.text('invalid access token', 401);
  const { session, file } = found;
  if (file.owner_id !== session.uid) return c.text('not allowed', 403);
  if (!file.primary_entity) return c.text('file has no entity', 404);

  const length = Number(c.req.header('Content-Length') ?? 0);
  if (!Number.isFinite(length) || length <= 0) {
    return c.text('content-length is required', 400);
  }
  if (!c.req.raw.body) return c.text('missing body', 400);

  // 以会话属主身份走正规覆盖写链路（容量、实体转正与手动上传一致）
  const owner = await ctx.users.byIdWithGroup(session.uid);
  if (!owner) return c.text('owner not found', 404);
  const ownerCtx = new AppContextClass(ctx.env, ctx.settings, ctx.codec, ctx.jwt, owner);
  try {
    await new UploadService(ownerCtx, new FileSystemService(ownerCtx)).overwriteContent(
      URI.parse(session.fileUri),
      c.req.raw.body,
      length,
      'application/octet-stream',
      { ignoreMaxEdit: true },
    );
    const fresh = await ctx.files.byId(file.id);
    return new Response(null, {
      status: 200,
      headers: wopiVersionHeader(ctx, fresh ?? file),
    });
  } catch (e) {
    return c.text((e as Error).message || 'failed to save', 500);
  }
});

/** LOCK / UNLOCK / REFRESH_LOCK / GET_LOCK。锁状态存 KV，30 分钟自动过期。 */
fileRoutes.post('/wopi/:id', async (c) => {
  const ctx = ctxOf(c);
  const found = await wopiSessionOf(ctx, c.req.param('id') ?? '', c.req.query('access_token'));
  if (!found) return c.text('invalid access token', 401);
  const { file } = found;

  const override = c.req.header('X-WOPI-Override') ?? '';
  const lockToken = c.req.header('X-WOPI-Lock') ?? '';
  const lockKey = `wopi_lock:${file.id}`;
  const version = wopiVersionHeader(ctx, file);

  const locked = await kvFor(ctx.env, 'upload').get(lockKey);
  switch (override) {
    case 'GET_LOCK':
      return new Response(null, {
        status: 200,
        headers: { ...(locked ? { 'X-WOPI-Lock': locked } : {}), ...version },
      });
    case 'LOCK':
    case 'REFRESH_LOCK': {
      if (locked && locked !== lockToken) {
        return new Response(null, {
          status: 409,
          headers: { 'X-WOPI-Lock': locked, 'X-WOPI-LockFailureReason': 'Locked by another session' },
        });
      }
      await kvFor(ctx.env, 'upload').put(lockKey, lockToken, { expirationTtl: 1800 });
      return new Response(null, { status: 200, headers: version });
    }
    case 'UNLOCK': {
      if (locked && locked !== lockToken) {
        return new Response(null, {
          status: 409,
          headers: { 'X-WOPI-Lock': locked, 'X-WOPI-LockFailureReason': 'Locked by another session' },
        });
      }
      await kvFor(ctx.env, 'upload').delete(lockKey);
      return new Response(null, { status: 200, headers: version });
    }
    default:
      return new Response(null, {
        status: 501,
        headers: { 'X-WOPI-LockFailureReason': `Override "${override}" is not supported` },
      });
  }
});

/**
 * 流式打包下载。
 *
 * 对应上游 `ArchiveService.DownloadArchived`（service/explorer/file.go:57）：
 * `/file/url` 带 `archive:true` 时在 KV 里铸造 `archive_<uuid>` 会话并签名本
 * 路径；这里校验签名后恢复会话里的请求者身份，把 URI 递归展开成 zip 条目，
 * 用 store 模式 zip 流式吐给浏览器（不占内存、不经磁盘）。
 */
fileRoutes.get('/archive/:sessionID/archive.zip', async (c) => {
  const ctx = ctxOf(c);

  // 与实体内容分发同一套签名校验：签名只覆盖 pathname
  const url = new URL(c.req.url);
  const sign = url.searchParams.get('sign');
  if (!sign) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer Cr ')) {
      return fail(c, new AppError(403, 'authorization header is missing'));
    }
    try {
      await ctx.signer.check(url.pathname, authHeader.slice('Bearer Cr '.length));
    } catch (e) {
      return fail(c, e);
    }
  } else {
    try {
      await ctx.signer.check(url.pathname, sign);
    } catch (e) {
      return fail(c, e);
    }
  }

  try {
    const sessionID = c.req.param('sessionID') ?? '';
    const raw = await kvFor(ctx.env, 'upload').get(`archive_${sessionID}`);
    if (!raw) {
      return fail(c, new AppError(CodeNotFound, 'Archive session not exist'));
    }
    const session = JSON.parse(raw) as { uris?: string[]; requester_id?: number };
    if (!session.uris?.length || !session.requester_id) {
      return fail(c, new AppError(CodeNotFound, 'Archive session not exist'));
    }

    // 恢复请求者身份（collect/权限校验都依赖 ctx.user）
    const requester = await ctx.users.byIdWithGroup(session.requester_id);
    if (!requester) return fail(c, new AppError(CodeNotFound, 'Archive session not exist'));
    const userCtx = ctx.withUser(requester);

    const wf = new WorkflowService(userCtx, new FileSystemService(userCtx));
    const entries = await wf.archiveEntries(session.uris);
    const stream = createZipStream(entries);

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': attachmentDisposition('archive.zip'),
      },
    });
  } catch (e) {
    return fail(c, e);
  }
});

export { guard };
