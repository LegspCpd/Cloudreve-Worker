/**
 * WebDAV 协议服务端。对应上游 `pkg/webdav`（golang.org/x/net/webdav 的 fork）+
 * `routers/router.go:1344-1358` 的 `initWebDAV`。
 *
 * 鉴权与上游 `middleware/auth.go:104-176`（WebDAVAuth）一致：
 *   - Basic Auth，用户名 = WebDAV 账号名，密码 = 创建账号时生成的随机串；
 *   - OPTIONS 不需要鉴权；
 *   - 用户组必须开了 WebDAV 权限，否则 403；
 *   - 只读账号禁 DELETE/PUT/MKCOL/COPY/MOVE/LOCK/UNLOCK，403。
 *
 * 路径映射与上游 stripPrefix 一致：URL 里 `/dav/<相对路径>`，接在**账号 URI**
 * （如 `my:///` 或 `my:///docs`）后面。
 *
 * 支持的方法：OPTIONS / PROPFIND / GET / HEAD / PUT / MKCOL / DELETE / MOVE /
 * COPY / PROPPATCH / LOCK / UNLOCK。客户端覆盖 RaiDrive、Windows 映射网络驱动器、
 * rclone（webdav backend）、Cyberduck。
 *
 * 已知取舍（写在明处，别装没看见）：
 *   - `share://` 账号在挂载时按 403 处理：上游要 walk 分享树逐层校验，边缘版
 *     第一版只做 `my://`，有真实需求再补；
 *   - LOCK 实现了 RFC 4918 的写锁：exclusive / shared、Depth 0 / infinity、
 *     Timeout 续期、UNLOCK，并在 PUT / MKCOL / DELETE / COPY / MOVE / PROPPATCH
 *     上校验 If 头里的 lock token（缺 token → 423 Locked）。
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { logAudit } from '../services/audit';
import { AppContext, permissionsOf } from '../services/context';
import { URI } from '../services/uri';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';
import type { FileRow } from '../db/types';
import type { DavAccountRow } from '../db/repo';
import { BooleanSet, GroupPermission, FileType } from '../lib/boolset';
import { parseBasicAuth } from '../lib/basicAuth';
import { RATE_LIMITS, clientIp, hitRateLimit } from '../lib/rateLimit';
import {
  CodeFileNotFound,
  CodeInsufficientCapacity,
  CodeLockConflict,
  CodeObjectExist,
  CodeOwnerOnly,
  CodeParentNotExist,
  CodePolicyNotAllowed,
} from '../lib/errors';
import { kvFor } from '../lib/kvRouter';
import { DAV_PREFIX, davChildHref, davHref, resolveDavTarget, safeDecode } from '../lib/davPath';

export const davRoutes = new Hono<AppBindings>();

/**
 * 给所有 WebDAV 响应（含 401 质询 / 403 / 404）都带上 `DAV` 与 `MS-Author-Via` 头。
 *
 * Windows WebClient(MRxDAV) 的硬要求：它收到 401 后会二次探测这两个头来判定
 * 「这到底是不是 WebDAV 服务器」。缺了就静默报「你输入的文件夹似乎无效」，
 * 而且**永远不弹凭据框** —— 表现就是 Explorer 里死活连不上，但 rclone / Android /
 * 桌面端（直接带凭据、不靠 401 探测）一切正常。上游 `pkg/webdav` 只在 OPTIONS
 * 的 200 上设这两个头，401 不带，所以 Windows 是 Cloudreve 系的通病。
 *
 * 放在鉴权中间件之前：401 由鉴权层提前 return，但头已经在 `c` 上挂好，会随响应发出去
 * （Hono 的 `c.header()` 在 `c.body()` 之前设置会保留，OPTIONS 处理已验证此模式）。
 */
davRoutes.use('*', async (c, next) => {
  c.header('DAV', '1, 2');
  c.header('MS-Author-Via', 'DAV');
  await next();
});

/** URL 前缀。与上游 `pkg/webdav/webdav.go` 的 `davPrefix` 一致。 */

/** 锁的默认时长（秒），客户端没给 Timeout 时用。 */
const LOCK_DEFAULT_TTL = 600;

/** PROPFIND 单目录最多枚举的子项数，超出则截断（防超大目录把响应体撑爆 Worker 内存）。 */
const PROPFIND_MAX = 5000;

/** LOCK 能力声明（RFC 4918 §15.10）：exclusive 与 shared 都支持。 */
const SUPPORTED_LOCK_XML =
  '<D:supportedlock>' +
  '<D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '<D:lockentry><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry>' +
  '</D:supportedlock>';

/** 只读账号禁用的位号（DavAccountReadOnly）。 */
const DAV_OPT_READONLY = 0;

// ---------------------------------------------------------------------------
// 鉴权
// ---------------------------------------------------------------------------

// Basic 凭据解析在 lib/basicAuth.ts（UTF-8 与 scheme 大小写两个坑，见那里的注释）

/**
 * 401 质询头。带上 `charset="UTF-8"`（RFC 7617 §2.1）：中文账号名的客户端
 * 据此知道按 UTF-8 编码载荷，而不是系统默认的 GBK（MT管理器/ES 这类安卓
 * 客户端会看这个参数）。
 */
const DAV_CHALLENGE = 'Basic realm="cloudreve", charset="UTF-8"';

/** 只读账号禁用的方法。与上游 WebDAVAuth:166 的列表一致。 */
const WRITE_METHODS = new Set(['DELETE', 'PUT', 'MKCOL', 'COPY', 'MOVE', 'LOCK', 'UNLOCK']);

davRoutes.use('*', async (c, next) => {
  // 裸 `/dav`（不带尾斜杠）**不做重定向**，直接当根目录处理。
  // Hono 的 `app.route('/dav', …)` 本来就同时匹配 `/dav` 与 `/dav/*`，而
  // `targetUri()` 把 `/dav` 解析成「根」，`hrefFor()` 对目录统一补尾斜杠，
  // 所以客户端拿到的是标准形状。
  // 不能改成 301：多数客户端（curl、部分 Android/Go 客户端）对 301 会按
  // RFC 7231 把非 GET 方法降级成 GET，PROPFIND 收到 301 就变成 GET 首页 —— 
  // 表现正是「连接失败 / 打不开」。
  const method = c.req.method.toUpperCase();

  const auth = parseBasicAuth(c.req.header('Authorization'));
  if (!auth) {
    // OPTIONS 不需要鉴权（上游同款豁免），其余要求 Basic Auth
    if (method === 'OPTIONS') return next();
    c.header('WWW-Authenticate', DAV_CHALLENGE);
    return c.body(null, 401);
  }

  const ctx = ctxOf(c);
  // 用户名 = 登录邮箱（上游 GetActiveByDavAccount 的语义），密码 = 该用户任一
  // WebDAV 账号的密码。前端「连接信息」弹窗里显示的也是邮箱，照填即可。
  const hit = await ctx.davAccounts.byEmailAndPassword(
    auth.name,
    auth.password,
    ctx.settings.secretKey,
  );
  if (!hit) {
    // WebDAV 的 Basic Auth 是**每个请求**都带凭据的，攻击者可以拿它当登录接口
    // 无限试密码 —— 登录接口有邮箱/IP 限速，这条路径原来一条都没有。
    // 只对**失败**计数：正常客户端的大量 PROPFIND 不该被算进去。
    const gate = await hitRateLimit(ctx.env, { ...RATE_LIMITS.davAuthByIp, id: clientIp(c) });
    logAudit(ctx, 'webdav_login_failed', null, { name: auth.name });
    // Windows WebClient 收到没有 WWW-Authenticate 的 401 不会重试凭据
    c.header('WWW-Authenticate', DAV_CHALLENGE);
    if (!gate.ok) {
      c.header('Retry-After', String(gate.retryAfter));
      return c.body(null, 429);
    }
    return c.body(null, 401);
  }

  const full = await ctx.users.byIdWithGroup(hit.account.owner_id);
  if (!full) return c.body(null, 401);
  if (!permissionsOf(full.group).enabled(GroupPermission.WebDAV)) return c.body(null, 403);

  // 只读账号禁写方法
  const opts = new BooleanSet(hit.account.options);
  if (opts.enabled(DAV_OPT_READONLY) && WRITE_METHODS.has(method)) {
    return c.body(null, 403);
  }

  // 用已验证的身份重建请求上下文（后续 handler 里的 requireUser 全部生效）
  c.set('ctx', new AppContext(ctx.env, ctx.settings, ctx.codec, ctx.jwt, full));
  c.set('davAccount', hit.account);
  await next();
});

/** 取当前请求的 WebDAV 账号（鉴权中间件已写入）。 */
function davAccountOf(c: AppRequest): DavAccountRow {
  return c.get('davAccount');
}

// ---------------------------------------------------------------------------
// 路径 → URI
// ---------------------------------------------------------------------------

/** URL pathname + 账号 URI → 目标 URI。账号 URI 只允许 my://（见文件头「已知取舍」）。 */
function targetUri(c: AppRequest): URI | null {
  // 路径解析与穿越防护都在 lib/davPath.ts（可单测），这里只负责取账号与 pathname。
  return resolveDavTarget(davAccountOf(c).uri, new URL(c.req.url).pathname);
}

// ---------------------------------------------------------------------------
// XML 工具
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** RFC 1123（HTTP-date）。 */
function httpDate(d: Date): string {
  return d.toUTCString();
}

/** 生成单条 <D:response>。isCollection 决定 resourcetype。 */
function davResponseXml(args: {
  href: string;
  displayName: string;
  isCollection: boolean;
  size: number;
  modifiedAt: Date;
  contentType?: string;
  /** 已序列化的 <D:lockdiscovery>（RFC 4918 §15.8），没有活动锁时给空元素。 */
  lockDiscovery?: string;
}): string {
  // getetag：Windows 的 WebClient(MRxDAV) 依赖它做资源身份/缓存判定，缺失会导致
  // 文件打不开、列表显示陈旧内容，甚至挂载后无法进入目录。
  const etag = `"${args.size}-${Math.floor(args.modifiedAt.getTime() / 1000)}"`;
  const props = [
    `<D:displayname>${escapeXml(args.displayName)}</D:displayname>`,
    `<D:getlastmodified>${httpDate(args.modifiedAt)}</D:getlastmodified>`,
    `<D:getetag>${etag}</D:getetag>`,
    args.isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    args.isCollection ? '' : `<D:getcontentlength>${args.size}</D:getcontentlength>`,
    args.isCollection
      ? ''
      : `<D:getcontenttype>${escapeXml(args.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
    `<D:creationdate>${args.modifiedAt.toISOString()}</D:creationdate>`,
    SUPPORTED_LOCK_XML,
    args.lockDiscovery ?? '<D:lockdiscovery/>',
  ]
    .filter(Boolean)
    .join('');
  return `<D:response><D:href>${escapeXml(args.href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

// ---------------------------------------------------------------------------
// 文件系统助手
// ---------------------------------------------------------------------------

async function openEntityStream(
  ctx: AppContext,
  file: FileRow,
  range: string | null,
): Promise<{
  body: ReadableStream;
  size: number;
  contentType?: string;
  contentRange?: string | null;
} | null> {
  if (!file.primary_entity) return null;
  const entity = await ctx.entities.byId(file.primary_entity);
  if (!entity) return null;
  const policy = await ctx.policies.byId(entity.storage_policy_entities);
  if (!policy) return null;
  return ctx.driverFor(policy).get(entity.source, range);
}

/** 判断行是否目录。必须用 type 位（file_children 指向父容器，文件/目录都非空）；根行兜底。 */
function isFolderRow(fs: FileSystemService, file: FileRow): boolean {
  return file.type === FileType.Folder || fs.isRootFolder(file);
}

/** `<D:href>`：实现与两条硬要求见 lib/davPath.ts 的 `davHref`。 */
function hrefFor(target: URI, isDir: boolean): string {
  return davHref(target.path, isDir);
}

davRoutes.on('OPTIONS', '*', (c) => {
  c.header('DAV', '1, 2');
  c.header(
    'Allow',
    'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, MKCOL, COPY, MOVE, LOCK, UNLOCK',
  );
  c.header('MS-Author-Via', 'DAV');
  return c.body(null, 200);
});

davRoutes.on('PROPFIND', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const depthHeader = (c.req.header('Depth') ?? '1').trim();
  const depth = depthHeader === '0' ? 0 : 1; // RFC 4918：非法 Depth 按 1 处理（无限深不支持）

  const fs = new FileSystemService(ctx);
  let file: FileRow;
  try {
    file = await fs.mustResolve(uri);
  } catch {
    return c.body(null, 404);
  }

  const responses: string[] = [];
  const isDir = isFolderRow(fs, file);

  // 活动锁一次性取出（锁数量很少），每个资源按「覆盖关系」挂自己的 lockdiscovery：
  // 上级目录的 Depth:infinity 锁也会出现在子项的 lockdiscovery 里（RFC 4918 §6.1）。
  const kv = kvFor(ctx.env, 'upload');
  const activeLocks = await loadLocks(kv);
  const recordCache = new Map<string, DavLock>();
  const lockDiscoveryFor = async (path: string): Promise<string> => {
    const covering = activeLocks.filter((l) => lockCovers(l.path, l.depth, path));
    if (covering.length === 0) return '<D:lockdiscovery/>';
    const records: DavLock[] = [];
    for (const l of covering) {
      let record = recordCache.get(l.token);
      if (!record) {
        const raw = await kv.get(lockKey(l.token));
        if (!raw) continue;
        record = JSON.parse(raw) as DavLock;
        recordCache.set(l.token, record);
      }
      records.push(record);
    }
    return lockDiscoveryXml(records);
  };

  responses.push(
    davResponseXml({
      href: hrefFor(uri, isDir),
      displayName: file.name || '/',
      isCollection: isDir,
      size: Number(file.size ?? 0),
      modifiedAt: file.updated_at ?? new Date(),
      lockDiscovery: await lockDiscoveryFor(decodedPath(uri)),
    }),
  );

  if (isDir && depth === 1) {
    const list = await fs.list(uri, {
      page: 0,
      pageSize: PROPFIND_MAX,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    for (const item of list.files) {
      const childUri = uri.child(item.name);
      const childIsDir = item.type === FileType.Folder;
      responses.push(
        davResponseXml({
          // ⚠️ 不能用 childUri.path：它已经被 encode 过一次，再编码就是双重编码
          // （中文/空格名字的 href 会变成 %25E7%2585… → 客户端 404）
          href: davChildHref(decodedPath(uri), item.name, childIsDir),
          displayName: item.name,
          isCollection: childIsDir,
          size: Number(item.size ?? 0),
          modifiedAt: new Date(item.updated_at ?? Date.now()),
          lockDiscovery: await lockDiscoveryFor(decodedPath(childUri)),
        }),
      );
    }
  }

  const xml = multistatus(responses);
  // Windows WebClient 拒绝分块（Transfer-Encoding: chunked）的 WebDAV 响应，
  // 必须带显式 Content-Length；Workers 对字符串体通常会自动算，这里再显式保底。
  return c.body(xml, 207, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': String(new TextEncoder().encode(xml).length),
  });
});

davRoutes.on(['GET', 'HEAD'], '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const fs = new FileSystemService(ctx);
  let file: FileRow;
  try {
    file = await fs.mustResolve(uri);
  } catch {
    return c.body(null, 404);
  }

  if (isFolderRow(fs, file)) {
    // HEAD 只探存在性/类型：不该为了一个 HTML 列表去查一次目录（边缘→新加坡
    // 一次往返 200~300ms，而响应体最终还会被平台丢掉）。
    if (c.req.method === 'HEAD') {
      c.header('Content-Type', 'text/html; charset=utf-8');
      c.header('Content-Length', '0');
      return c.body(null, 200);
    }
    // 目录：返回简单 HTML 列表（浏览器直接打开时用）
    const list = await fs.list(uri, {
      page: 0,
      pageSize: 1000,
      orderBy: 'name',
      orderDirection: 'asc',
    });
    // href 必须是**站内路径**（/dav/…）。之前直接拼 `uri.path`，出来是
    // `cloudreve://my/…`，浏览器点进去是未知协议，等于列表全是死链。
    const base = uri.path
      .split('/')
      .filter(Boolean)
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const items = list.files
      .map((f) => {
        const isDir = f.type === FileType.Folder;
        const href = `${DAV_PREFIX}/${base ? `${base}/` : ''}${encodeURIComponent(f.name)}${isDir ? '/' : ''}`;
        return `<li><a href="${escapeXml(href)}">${escapeXml(f.name)}${isDir ? '/' : ''}</a></li>`;
      })
      .join('');
    const html = `<!doctype html><meta charset="utf-8"><title>${escapeXml(file.name || '/')}</title><ul>${items}</ul>`;
    return c.html(html);
  }

  const content = await openEntityStream(ctx, file, c.req.header('Range') ?? null);
  if (!content) return c.body(null, 404);

  c.header('Content-Type', content.contentType ?? 'application/octet-stream');
  c.header('Accept-Ranges', 'bytes');
  c.header('Last-Modified', httpDate(file.updated_at ?? new Date()));
  c.header('ETag', `"${Number(file.size ?? 0)}-${Math.floor((file.updated_at ?? new Date()).getTime() / 1000)}"`);

  if (content.contentRange && c.req.header('Range')) {
    // 上游存储按 206 语义应答（content-range 已带），这里同样回 206
    c.header('Content-Range', content.contentRange);
    if (c.req.method === 'HEAD') return c.body(null, 206);
    return c.body(content.body as ReadableStream, 206);
  }

  // HEAD 必须带实体长度，否则部分客户端（Explorer 映射、播放器）拿不到大小
  const length = Number(
    content.contentRange?.match(/\/(\d+)$/)?.[1] ?? content.size ?? file.size ?? 0,
  );
  if (Number.isFinite(length) && length > 0) c.header('Content-Length', String(length));
  if (c.req.method === 'HEAD') return c.body(null, 200);
  return c.body(content.body as ReadableStream, 200);
});

davRoutes.on('PUT', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  if (!uri.elements.length) return c.body(null, 405); // 不能写根目录

  const fs = new FileSystemService(ctx);
  const upload = new UploadService(ctx, fs);
  const lengthHeader = c.req.header('Content-Length');
  const length = lengthHeader === undefined ? NaN : Number(lengthHeader);
  // RFC 9110 §8.6：没有 Content-Length 就无法确定写入长度。驱动的 put 需要
  // 确切字节数（S3  multipart / 哨兵校验都靠它），长度不明时宁可拒掉，
  // 也不能默默写出一个 0 字节文件（客户端会以为传成功了）。
  if (!Number.isFinite(length) || length < 0) {
    return c.body(null, 411);
  }
  const body = c.req.raw.body;
  if (!body) return c.body(null, 400);

  const existing = await fs.resolve(uri);
  // 目标是目录 → 405。判目录必须看 `type` 位：`file_children` 存的是**父目录 id**，
  // 文件和目录都不为 null（只有根/回收站项才是 null）。之前用
  // `file_children !== null` 判「是目录」，等于把每个已存在的文件都当成目录，
  // 于是 PUT 覆盖已有文件恒定 405 —— 新建能成功、保存（覆盖）永远失败，
  // 正是客户端「能打开、改完存不进去」的形态。
  if (existing && isFolderRow(fs, existing)) {
    return c.body(null, 405);
  }

  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;

  try {
    if (!existing) {
      // 先建文件行（父目录不存在会抛 CodeParentNotExist → 409）
      await fs.create(uri, 'file', { errOnConflict: true });
    }
    await upload.overwriteContent(
      uri,
      body,
      length,
      c.req.header('Content-Type') ?? 'application/octet-stream',
      { ignoreMaxEdit: true },
    );
    // RFC 4918 §9.7.1：新建 201，覆盖 204。Windows / rclone 会据此判断
    // 文件是不是刚创建的（覆盖时不该提示「已创建」）。
    return c.body(null, existing ? 204 : 201);
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === CodeParentNotExist) return c.body(null, 409); // 父目录不存在
    if (code === CodeInsufficientCapacity) return c.body(null, 507); // 配额不足
    if (code === CodePolicyNotAllowed) return c.body(null, 403);
    if (code === CodeObjectExist) return c.body(null, 409);
    console.error('webdav put failed', e);
    return c.body(null, 500);
  }
});

davRoutes.on('MKCOL', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  if (!uri.elements.length) return c.body(null, 405);

  const fs = new FileSystemService(ctx);
  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;
  try {
    await fs.create(uri, 'folder', { errOnConflict: true });
    return c.body(null, 201);
  } catch (e) {
    if ((e as { code?: number }).code === CodeObjectExist) return c.body(null, 405);
    return c.body(null, 409); // 父目录不存在等
  }
});

davRoutes.on('DELETE', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri || !uri.elements.length) return c.body(null, 403); // 不能删根

  const fs = new FileSystemService(ctx);
  // 删目录时，树内子孙上的锁同样要求携带 token（RFC 4918 §7.5）
  const blocked = await lockedWriteResponse(c, [uri], { includeDescendants: true });
  if (blocked) return blocked;
  try {
    await fs.delete([uri], { skipSoftDelete: true });
    return c.body(null, 204);
  } catch {
    return c.body(null, 404);
  }
});

davRoutes.on(['COPY', 'MOVE'], '*', async (c) => {
  const ctx = ctxOf(c);
  const srcUri = targetUri(c);
  if (!srcUri || !srcUri.elements.length) return c.body(null, 403);

  const destHeader = c.req.header('Destination');
  if (!destHeader) return c.body(null, 400);
  // Destination 是绝对 URL 或绝对路径，取 pathname 部分。
  // 绝对 URL 且主机不是自己时回 502（RFC 4918 §9.8.5）：否则一个指向别人家的
  // Destination 会被我们当成站内路径执行，行为对客户端来说完全不可预期。
  let destUrl: URL;
  try {
    destUrl = new URL(destHeader, c.req.url);
  } catch {
    return c.body(null, 400);
  }
  const selfHost = new URL(c.req.url).host.toLowerCase();
  if (destUrl.host.toLowerCase() !== selfHost) return c.body(null, 502);
  const destPath = destUrl.pathname;
  if (!destPath.startsWith(DAV_PREFIX)) return c.body(null, 502);

  const account = davAccountOf(c);
  const base = URI.tryParse(account.uri);
  if (!base || base.fsType !== 'my') return c.body(null, 403);
  const rel = safeDecode(destPath.slice(DAV_PREFIX.length));
  if (rel === null) return c.body(null, 400);
  const dstUri = base.withPath(
    (base.path.replace(/\/+$/, '') + '/' + rel.replace(/^\/+/, '')).replace(/\/{2,}/g, '/'),
  );
  // 同样校验目标仍在账号根内，防止通过 Destination 头做路径穿越。
  if (base.path !== '/' && dstUri.path !== base.path && !dstUri.path.startsWith(base.path + '/')) {
    return c.body(null, 403);
  }

  const fs = new FileSystemService(ctx);
  const isCopy = c.req.method === 'COPY';
  // Overwrite 只接受 T / F（缺省 T）。其他值按上游 parseOverwrite 回 400，
  // 不能默默当成 T —— 否则客户端写错头会被当成「允许覆盖」，直接毁掉目标文件。
  const overwriteHeader = (c.req.header('Overwrite') ?? 'T').toUpperCase();
  if (overwriteHeader !== 'T' && overwriteHeader !== 'F') return c.body(null, 400);
  const overwrite = overwriteHeader === 'T';

  // MOVE 会改动源，COPY 只读源；目标两者都要写 —— 两侧都过锁校验
  const blocked = await lockedWriteResponse(
    c,
    isCopy ? [dstUri] : [srcUri, dstUri],
    { includeDescendants: !isCopy },
  );
  if (blocked) return blocked;

  try {
    const src = await fs.mustResolve(srcUri);
    const dst = await fs.resolve(dstUri);
    // 目标是否已存在：决定成功时的状态码（已存在 → 204 No Content，新建 → 201
    // Created），与上游 performCopyMove 一致。
    const dstExists = dst !== null;

    // 目标语义（RFC 4918 + 上游 handleCopyMove）：
    //   dst 是目录  → 目标落在 dst/<src.name>
    //   dst 是文件  → Overwrite=T 先删，再落到 dst.parent()/src.name
    //   dst 不存在 → dst.parent() 是落点，最后一段是新名字
    let targetParent: URI;
    let targetName = srcUri.name;
    if (dst && isFolderRow(fs, dst)) {
      targetParent = dstUri;
    } else if (dst) {
      if (!overwrite) return c.body(null, 412);
      await fs.delete([dstUri], { skipSoftDelete: true });
      targetParent = dstUri.parent();
      // 覆盖时落点就是 Destination 自己（不是源文件名）：把 a.txt 覆盖成 b.txt
      // 的结果必须是 b.txt，否则「另存为」会静默变成同目录多出一个 a.txt。
      targetName = dstUri.name;
    } else {
      targetParent = dstUri.parent();
      targetName = dstUri.name;
    }

    // 父目录必须存在且是目录（否则 409）
    const parent = await fs.resolve(targetParent);
    if (!parent || !isFolderRow(fs, parent)) return c.body(null, 409);

    // 同目录 MOVE 改名：走 rename（少几次查询，且它自带同名冲突校验）。
    if (!isCopy && targetParent.path === srcUri.parent().path) {
      await fs.rename(srcUri, targetName);
      // 锁跟着资源走（RFC 4918 §7.5）
      await moveLockRoots(c, decodedPath(srcUri), decodedPath(targetParent.child(targetName)));
      return c.body(null, dstExists ? 204 : 201);
    }

    // `destName` 一步到位。之前是「先按原名落、再 rename 成目标名」，同目录
    // COPY 另存为新名字时前半步会撞到源文件自己（`(parent, name)` 唯一），
    // 直接 412 —— 也就是「复制一份」永远失败。
    await fs.moveOrCopy([srcUri], targetParent, isCopy, targetName);

    if (!isCopy) {
      await moveLockRoots(c, decodedPath(srcUri), decodedPath(targetParent.child(targetName)));
    }
    return c.body(null, dstExists ? 204 : 201);
  } catch (e) {
    const code = (e as { code?: number }).code;
    // 按原因给状态码：客户端（尤其 Windows 与 rclone）只靠它判断该重试还是报错。
    if (code === CodeObjectExist) return c.body(null, 412); // 目标已存在且 Overwrite=F
    if (code === CodeParentNotExist) return c.body(null, 409);
    if (code === CodeInsufficientCapacity) return c.body(null, 507);
    if (code === CodeLockConflict) return c.body(null, 423);
    if (code === CodeOwnerOnly) return c.body(null, 403);
    if (code === CodeFileNotFound) return c.body(null, 404);
    console.error('webdav copy/move failed', e);
    return c.body(null, 409);
  }
});

davRoutes.on('PROPPATCH', '*', async (c) => {
  // 属性修改（如修改时间）不支持但也不阻塞客户端 —— 逐属性标 403。
  // 但被锁的资源仍要先按 RFC 4918 §9.2 校验 token（否则 423）。
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);
  const blocked = await lockedWriteResponse(c, [uri]);
  if (blocked) return blocked;
  const href = `${DAV_PREFIX}${uri.path}`;
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">` +
    `<D:response><D:href>${escapeXml(href)}</D:href>` +
    `<D:propstat><D:prop/><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat>` +
    `</D:response></D:multistatus>`;
  return c.body(xml, 207, { 'Content-Type': 'application/xml; charset=utf-8' });
});

// ---------------------------------------------------------------------------
// RFC 4918 写锁（exclusive / shared，Depth 0 / infinity）
// ---------------------------------------------------------------------------
//
// 存储用 upload 角色的 KV：
//   dav_lock:<token> → DavLock(JSON)，带 expirationTtl，过期自动回收；
//   同时在 KV metadata 里放「覆盖判定」需要的字段 —— 一次 list 就能判断
//   某路径有没有被锁，不必为每个候选锁再 get 一次。
//
// 一致性取舍：KV list 是最终一致的（同一 colo 内基本即时）。WebDAV 客户端
// 都是 LOCK 成功之后才写，同 colo 命中，实测可用；要强一致得把锁表搬进主库，
// 每次写多一次跨区往返 —— 这里选延迟。

const LOCK_MAX_TTL = 7 * 24 * 3600; // 7 天；Timeout: Infinite 也按它封顶
const LOCK_KEY_PREFIX = 'dav_lock:';

type LockScope = 'exclusive' | 'shared';
type LockDepth = '0' | 'infinity';

interface DavLock {
  token: string;
  /** 锁根：逐段已解码的账号内路径（如 `/docs/a b.txt`） */
  path: string;
  isDir: boolean;
  depth: LockDepth;
  scope: LockScope;
  /** <D:owner> 的内部内容（已是可回写的 XML） */
  owner: string;
  /** 属主用户 id：只有本人能续期 / 解锁 */
  principal: number;
  createdAt: number;
  expiresAt: number;
}

/** KV metadata：覆盖判定只需要这些字段。 */
interface DavLockMeta {
  path: string;
  depth: LockDepth;
  scope: LockScope;
  principal: number;
  expiresAt: number;
}

function lockKey(token: string): string {
  return `${LOCK_KEY_PREFIX}${token}`;
}

/** 逐段解码的规范路径：URI.path 可能是编码过的（child() 会编码），锁比较统一用它。 */
function decodedPath(uri: URI): string {
  return uri.elements.length === 0 ? '/' : `/${uri.elements.join('/')}`;
}

/**
 * href：逐段编码 + 目录补尾斜杠。**直接复用 `davHref`** —— 之前这里复制了一份
 * 同样的实现，两份一起漂移就是双重编码这类 bug 的温床。
 */
function pathHref(path: string, isDir = false): string {
  return davHref(path, isDir);
}

/** `Timeout: Second-3600, Infinite` → 秒数。缺省 10 分钟，封顶 7 天。 */
function parseTimeout(header: string | undefined): number {
  const m = /Second-(\d+)/i.exec(header ?? '');
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return Math.min(n, LOCK_MAX_TTL);
  }
  if (/Infinite/i.test(header ?? '')) return LOCK_MAX_TTL;
  return LOCK_DEFAULT_TTL;
}

/** 解析 <D:lockinfo>；没有 lockinfo 说明是「续期」请求（RFC 4918 §9.10.2）。 */
function parseLockInfo(xml: string): { scope: LockScope; owner: string } | null {
  if (!/<(?:\w+:)?lockinfo\b/i.test(xml)) return null;
  const scope: LockScope = /<(?:\w+:)?shared\b[^>]*>/i.test(xml) ? 'shared' : 'exclusive';
  const owner = /<(?:\w+:)?owner\b[^>]*>([\s\S]*?)<\/(?:\w+:)?owner>/i.exec(xml);
  const rawOwner = owner ? owner[1]!.trim() : '';
  // owner 内部本身是 XML（通常是 <D:href>）就原样回写；纯文本转义后当文本节点
  return { scope, owner: rawOwner.includes('<') ? rawOwner : escapeXml(rawOwner) };
}

function parseLockToken(header: string | undefined): string | null {
  const m = /opaquelocktoken:([^>\s,]+)/i.exec(header ?? '');
  return m ? m[1]! : null;
}

interface IfCondition {
  not: boolean;
  token?: string;
  etag?: string;
}

interface IfList {
  /** Resource-Tag（可缺省） */
  tag?: string;
  conditions: IfCondition[];
}

/**
 * 解析 If 头（RFC 4918 §10.4）。只关心状态令牌；ETag 条件保留但暂不求值。
 * 顶层 `<...>` 一律视为 Resource-Tag —— 状态令牌只会出现在括号列表内部。
 */
function parseIfHeader(raw: string | undefined): IfList[] {
  if (!raw) return [];
  const lists: IfList[] = [];
  let tag: string | undefined;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '(') {
      const end = raw.indexOf(')', i);
      if (end < 0) break;
      const inner = raw.slice(i + 1, end);
      const conditions: IfCondition[] = [];
      const re = /(Not\s+)?(?:<([^>]*)>|\[([^\]]*)\])/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(inner))) {
        const not = Boolean(m[1]);
        if (m[2] !== undefined) {
          const token = parseLockToken(m[2]);
          if (token) conditions.push({ not, token });
        } else if (m[3] !== undefined) {
          conditions.push({ not, etag: m[3].trim() });
        }
      }
      lists.push({ tag, conditions });
      tag = undefined;
      i = end + 1;
      continue;
    }
    if (ch === '<') {
      const end = raw.indexOf('>', i);
      if (end < 0) break;
      tag = raw.slice(i + 1, end).trim();
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return lists;
}

/** If 头里是否有「肯定断言」该 token（被 Not 否定的不算）。 */
function ifAssertsToken(lists: IfList[], token: string): boolean {
  for (const list of lists) {
    if (list.conditions.some((cond) => cond.not && cond.token === token)) continue;
    if (list.conditions.some((cond) => !cond.not && cond.token === token)) return true;
  }
  return false;
}

/** 读全部活动锁（只读 metadata，不取值）。 */
async function loadLocks(kv: KVNamespace): Promise<Array<DavLockMeta & { token: string }>> {
  const now = Date.now();
  const out: Array<DavLockMeta & { token: string }> = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 10; guard += 1) {
    const page = await kv.list({ prefix: LOCK_KEY_PREFIX, cursor });
    for (const key of page.keys) {
      const meta = key.metadata as DavLockMeta | null;
      if (!meta || typeof meta.path !== 'string') continue;
      if (typeof meta.expiresAt === 'number' && meta.expiresAt <= now) continue;
      out.push({ token: key.name.slice(LOCK_KEY_PREFIX.length), ...meta });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  return out;
}

/** 锁是否覆盖某个路径：同路径，或 Depth:infinity 且目标在其子树内。 */
function lockCovers(lockPath: string, depth: LockDepth, targetPath: string): boolean {
  if (lockPath === targetPath) return true;
  if (depth !== 'infinity') return false;
  const prefix = lockPath === '/' ? '/' : `${lockPath}/`;
  return targetPath.startsWith(prefix);
}

async function putLock(kv: KVNamespace, lock: DavLock, ttlSeconds: number): Promise<void> {
  const metadata: DavLockMeta = {
    path: lock.path,
    depth: lock.depth,
    scope: lock.scope,
    principal: lock.principal,
    expiresAt: lock.expiresAt,
  };
  await kv.put(lockKey(lock.token), JSON.stringify(lock), {
    expirationTtl: Math.max(60, Math.min(ttlSeconds, LOCK_MAX_TTL)),
    metadata,
  });
}

/** 单个 <D:activelock>（RFC 4918 §14.11）。 */
function activelockXml(lock: DavLock): string {
  const remaining = Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000));
  return (
    '<D:activelock>' +
    '<D:locktype><D:write/></D:locktype>' +
    `<D:lockscope><D:${lock.scope}/></D:lockscope>` +
    `<D:depth>${lock.depth === 'infinity' ? 'infinity' : '0'}</D:depth>` +
    (lock.owner ? `<D:owner>${lock.owner}</D:owner>` : '') +
    `<D:timeout>Second-${remaining}</D:timeout>` +
    `<D:locktoken><D:href>opaquelocktoken:${lock.token}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${escapeXml(pathHref(lock.path, lock.isDir))}</D:href></D:lockroot>` +
    '</D:activelock>'
  );
}

function lockDiscoveryXml(locks: DavLock[]): string {
  if (locks.length === 0) return '<D:lockdiscovery/>';
  return `<D:lockdiscovery>${locks.map(activelockXml).join('')}</D:lockdiscovery>`;
}

function lockResponse(c: AppRequest, lock: DavLock, status: 200 | 201): Response {
  const xml =
    '<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:">' +
    lockDiscoveryXml([lock]) +
    '</D:prop>';
  const remaining = Math.max(0, Math.round((lock.expiresAt - Date.now()) / 1000));
  return c.body(xml, status, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Lock-Token': `<opaquelocktoken:${lock.token}>`,
    Timeout: `Second-${remaining}`,
    'Content-Length': String(new TextEncoder().encode(xml).length),
  });
}

/**
 * 写前的锁校验（RFC 4918 §7.2 / §9.10.1）：
 *   - 目标被锁且请求没在 If 头里给出对应 token → 423 Locked；
 *   - `includeDescendants`（DELETE / MOVE）时，树内子孙上的锁同样要求 token。
 *
 * 严格按 RFC：不做「属主放行」—— 锁要防的正是同一个人的两个客户端并发写，
 * 放行等于把锁的意义抹掉。Windows / RaiDrive / Cyberduck 在写完 LOCK 之后
 * 都会在 If 头里带 token；rclone 这类根本不发 LOCK 的客户端不会触发校验。
 */
async function lockedWriteResponse(
  c: AppRequest,
  targets: URI[],
  opts: { includeDescendants?: boolean } = {},
): Promise<Response | null> {
  const ctx = ctxOf(c);
  const kv = kvFor(ctx.env, 'upload');
  const locks = await loadLocks(kv);
  if (locks.length === 0) return null;

  const lists = parseIfHeader(c.req.header('If'));

  for (const target of targets) {
    const path = decodedPath(target);
    const prefix = path === '/' ? '/' : `${path}/`;
    const related = locks.filter(
      (lock) =>
        lockCovers(lock.path, lock.depth, path) ||
        (opts.includeDescendants === true && lock.path.startsWith(prefix)),
    );
    for (const lock of related) {
      if (ifAssertsToken(lists, lock.token)) continue;
      return c.body(null, 423);
    }
  }
  return null;
}

/** MOVE 成功后把源树上的锁根一起挪过去（RFC 4918 §7.5）。 */
async function moveLockRoots(c: AppRequest, fromPath: string, toPath: string): Promise<void> {
  if (fromPath === toPath) return;
  const ctx = ctxOf(c);
  const kv = kvFor(ctx.env, 'upload');
  const locks = await loadLocks(kv);
  const prefix = fromPath === '/' ? '/' : `${fromPath}/`;
  for (const lock of locks) {
    if (lock.path !== fromPath && !lock.path.startsWith(prefix)) continue;
    const raw = await kv.get(lockKey(lock.token));
    if (!raw) continue;
    const record = JSON.parse(raw) as DavLock;
    record.path = `${toPath}${record.path.slice(fromPath.length)}`;
    const remaining = Math.max(60, Math.round((record.expiresAt - Date.now()) / 1000));
    await putLock(kv, record, remaining);
  }
}

davRoutes.on('LOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const kv = kvFor(ctx.env, 'upload');
  const fs = new FileSystemService(ctx);
  const ttl = parseTimeout(c.req.header('Timeout'));
  const bodyText = await c.req.text();
  const info = parseLockInfo(bodyText);

  // —— 续期：无实体，token 在 If 头里 ——
  if (!info) {
    const lists = parseIfHeader(c.req.header('If'));
    const tokens = new Set<string>();
    for (const list of lists) {
      for (const cond of list.conditions) if (!cond.not && cond.token) tokens.add(cond.token);
    }
    const hit = (await loadLocks(kv)).find(
      (lock) => tokens.has(lock.token) && lockCovers(lock.path, lock.depth, decodedPath(uri)),
    );
    if (!hit) return c.body(null, 412);
    if (hit.principal !== ctx.user!.id) return c.body(null, 403);
    const raw = await kv.get(lockKey(hit.token));
    if (!raw) return c.body(null, 412);
    const lock = JSON.parse(raw) as DavLock;
    lock.expiresAt = Date.now() + ttl * 1000;
    await putLock(kv, lock, ttl);
    return lockResponse(c, lock, 200);
  }

  // —— 新建锁 ——
  const depth: LockDepth = (c.req.header('Depth') ?? 'infinity').trim() === '0' ? '0' : 'infinity';

  let file = await fs.resolve(uri);
  let created = false;
  if (!file) {
    // RFC 4918 §7.3：锁一个还不存在的 URL → 先建一个空资源
    try {
      await fs.create(uri, 'file', { errOnConflict: true });
      file = await fs.mustResolve(uri);
      created = true;
    } catch {
      return c.body(null, 409);
    }
  }
  const isDir = isFolderRow(fs, file);

  const path = decodedPath(uri);
  const existingLocks = await loadLocks(kv);
  const overlap = existingLocks.filter(
    (lock) => lockCovers(lock.path, lock.depth, path) || lockCovers(path, depth, lock.path),
  );
  // exclusive 与任何锁冲突；shared 只在撞上 exclusive 时冲突（RFC 4918 §6.1）
  if (overlap.some((lock) => lock.scope === 'exclusive' || info.scope === 'exclusive')) {
    return c.body(null, 423);
  }

  const now = Date.now();
  const lock: DavLock = {
    token: crypto.randomUUID(),
    path,
    isDir,
    depth,
    scope: info.scope,
    owner: info.owner,
    principal: ctx.user!.id,
    createdAt: now,
    expiresAt: now + ttl * 1000,
  };
  await putLock(kv, lock, ttl);
  return lockResponse(c, lock, created ? 201 : 200);
});

davRoutes.on('UNLOCK', '*', async (c) => {
  const ctx = ctxOf(c);
  const uri = targetUri(c);
  if (!uri) return c.body(null, 404);

  const kv = kvFor(ctx.env, 'upload');
  const token = parseLockToken(c.req.header('Lock-Token'));
  if (!token) return c.body(null, 409);
  const raw = await kv.get(lockKey(token));
  if (!raw) return c.body(null, 409);
  const lock = JSON.parse(raw) as DavLock;
  // Lock-Token 必须指向覆盖该资源的锁（RFC 4918 §9.11）
  if (!lockCovers(lock.path, lock.depth, decodedPath(uri))) return c.body(null, 409);
  if (lock.principal !== ctx.user!.id) return c.body(null, 403);
  await kv.delete(lockKey(token));
  return c.body(null, 204);
});
