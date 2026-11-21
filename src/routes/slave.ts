/**
 * 主站侧接收从节点调用的接口（`/api/v4/slave/*`）。
 *
 * 对应上游 `routers/router.go` 里 `v4.Group("slave")` + `middleware.SlaveRPCSignRequired()`
 * 那一组。方向与 `lib/nodeRpc.ts` 相反：**从节点打进来**，主站验签后以
 * `user_id`（节点声明的用户）的身份执行文件操作。
 *
 * 信任模型：能签对的只有持有该节点 `slave_key` 的一方，所以验签通过就等于
 * 「这台被管理员登记过的机器」——它声明的 user_id 也就被采信。这与上游一致
 * （上游同样用 HMAC 而不是用户 token 来认证从机）。
 *
 * 实现了四个无状态上传端点（`service/node/rpc.go`）：
 *   PUT  statelessUpload/prepare   建上传会话（建文件行 + 实体行）
 *   POST statelessUpload/complete  收尾：实体转正 + 容量记账
 *   POST statelessUpload/failed    放弃：删会话 + 删占位实体
 *   POST statelessUpload/create    只建一个空文件/目录
 *
 * 为什么需要它们：从节点跑任务（远程下载、打包）时，产物落在**节点自己的
 * 磁盘上，但文件行在主站的库里**。节点必须回头让主站建这些行，否则用户在
 * 网盘里看不到任何东西。
 *
 * 没实现：`GET slave/credential/:id`（OneDrive 的 access token，边缘版的凭证
 * 存在 KV 里，语义不同）和 `initSlaveFileRouter` 那一组（主站当从节点的存储
 * 提供方，边缘版不扮演这个角色）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppBindings } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { AppError, Err } from '../lib/errors';
import { verifyNodeSignature } from '../lib/nodeRpc';
import { readBodyLimited } from '../lib/bodyLimit';
import { loadNodeById } from '../db/nodes';
import { loadSettings } from '../settings/provider';
import { HashIDCodec } from '../lib/hashid';
import { JWTService } from '../lib/jwt';
import { AppContext } from '../services/context';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';
import { URI } from '../services/uri';

export const slaveRoutes = new Hono<AppBindings>();

/**
 * 验签前能读的正文上限。四个端点只传 JSON 控制消息（prepare / complete /
 * failed / create），1 MiB 足够。限制必须在验签之前 —— 上游 issue #3628。
 */
const MAX_SLAVE_BODY = 1024 * 1024;

// ---------------------------------------------------------------------------
// 验签中间件
// ---------------------------------------------------------------------------

slaveRoutes.use('*', async (c, next) => {
  const nodeId = Number(c.req.header('X-Cr-Node-Id') ?? 0);
  if (!nodeId) return fail(c, Err.param('Unknown node ID'));

  const node = await loadNodeById(c.env, nodeId);
  if (!node || node.type !== 'slave') return fail(c, Err.param('Unknown node ID'));
  if (node.status !== 'active') return fail(c, Err.param(`Node "${node.name}" is suspended`));

  // 正文在这里一次性读走（验签要原文），处理函数从 c.var.slaveBody 取。
  // 上限校验在验签之前，未认证的大请求不能先吃内存（issue #3628）。
  const raw = await readBodyLimited(c.req.raw, MAX_SLAVE_BODY);
  const check = await verifyNodeSignature({
    slaveKey: node.slave_key ?? '',
    method: c.req.method,
    url: c.req.url,
    headers: c.req.raw.headers,
    body: raw,
  });
  if (!check.ok) {
    return fail(c, new AppError(40001, `Node signature check failed: ${check.reason}`));
  }

  c.set('slaveNode', node);
  c.set('slaveBody', raw);
  await next();
});

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

function bodyOf<T = Record<string, unknown>>(c: Context<AppBindings>): T {
  const raw = c.get('slaveBody') ?? '{}';
  return JSON.parse(raw) as T;
}

/**
 * 以「节点声明的用户」的身份建一个 AppContext。
 *
 * 用户不存在 / 被软删时抛参数错误 —— 节点拿一个不存在的 user_id 来建文件，
 * 只会造出孤儿行。
 */
async function ctxForNode(c: Context<AppBindings>, userId: number): Promise<AppContext> {
  const settings = await loadSettings(c.env);
  const base = new AppContext(
    c.env,
    settings,
    new HashIDCodec(settings.hashIdSalt),
    new JWTService(settings.secretKey),
  );
  const user = await base.users.byIdWithGroup(userId);
  if (!user) throw Err.param(`User ${userId} not found`);
  return new AppContext(
    c.env,
    settings,
    base.codec,
    base.jwt,
    user,
    undefined,
    base.db,
    base.kv,
  );
}

/** 从请求体里取用户 id；缺省按参数错误处理。 */
function requireUserId(body: Record<string, unknown>): number {
  const id = Number(body.user_id ?? 0);
  if (!Number.isInteger(id) || id <= 0) throw Err.param('user_id is required');
  return id;
}

/**
 * 目标 URI。上游 `UploadRequest.Props.Uri` 是 `*URI`（内部包 `*url.URL`），
 * 序列化出来是个对象；`StatelessCreateFileService.Path` 则是字符串。
 * 两种都接，取到字符串即可。
 */
function uriStringOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const inner = obj.U;
    if (typeof inner === 'string') return inner;
    if (inner && typeof inner === 'object') {
      const u = inner as Record<string, unknown>;
      if (typeof u.Scheme === 'string' && typeof u.Path === 'string') {
        return `${u.Scheme}://${String(u.Host ?? '')}${u.Path}`;
      }
    }
    if (typeof obj.path === 'string') return obj.path;
  }
  throw Err.param('uri is required');
}

// ---------------------------------------------------------------------------
// 无状态上传
// ---------------------------------------------------------------------------

/**
 * 建上传会话。对应 `node.StatelessPrepareUpload`。
 *
 * 请求体（上游 `fs.StatelessPrepareUploadService`）：
 *   { upload_request: { props: { uri, size, mime_type, save_path } }, user_id }
 *
 * 响应：上传会话（Go 字段名，节点按同样形状回传 complete）。
 */
slaveRoutes.put('/statelessUpload/prepare', async (c) => {
  try {
    const body = bodyOf<{ upload_request?: Record<string, unknown>; user_id?: number }>(c);
    const userId = requireUserId(body as Record<string, unknown>);
    const req = body.upload_request ?? {};
    const props = (req.props as Record<string, unknown>) ?? {};
    const uri = uriStringOf(props.uri ?? req.uri);
    const size = Number(props.size ?? req.size ?? 0);

    const ctx = await ctxForNode(c, userId);
    const upload = new UploadService(ctx, new FileSystemService(ctx));
    const session = await upload.prepareStatelessUpload({
      uri,
      size,
      ...(props.mime_type !== undefined ? { mimeType: String(props.mime_type) } : {}),
      ...(props.last_modified !== undefined ? { lastModified: Number(props.last_modified) } : {}),
      ...(props.policy_id !== undefined ? { policyId: String(props.policy_id) } : {}),
    });

    // 回给节点的形状与我们从主站发给从节点的一致（Go 字段名），节点照抄回传即可。
    // `Props.SavePath` 是关键：节点要把字节写到自己磁盘的这个位置。
    return ok(c, {
      UID: session.uid,
      FileID: session.fileId,
      EntityID: session.entityId,
      CallbackSecret: session.callbackSecret,
      ChunkSize: session.chunkSize,
      NewFileCreated: session.newFileCreated,
      Props: {
        Uri: uri,
        Size: session.size,
        UploadSessionID: session.id,
        SavePath: session.savePath,
        MimeType: session.mimeType,
        ExpireAt: new Date(session.expireAt).toISOString(),
        ClientSideEncrypted: false,
      },
    });
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * 收尾。对应 `node.StatelessCompleteUpload`：节点把字节写完后调这个，
 * 主站做实体转正 + 容量记账。
 */
slaveRoutes.post('/statelessUpload/complete', async (c) => {
  try {
    const body = bodyOf<{ upload_session?: Record<string, unknown>; user_id?: number }>(c);
    const userId = requireUserId(body as Record<string, unknown>);
    const raw = body.upload_session ?? {};
    const sessionId = String((raw.Props as Record<string, unknown> | undefined)?.UploadSessionID ?? '');
    if (!sessionId) throw Err.param('upload_session is required');

    const ctx = await ctxForNode(c, userId);
    const upload = new UploadService(ctx, new FileSystemService(ctx));
    const session = await upload.loadSession(sessionId);
    if (!session) throw Err.param('Upload session not found or expired');
    if (session.uid !== userId) throw Err.noPermission();

    await upload.completeStatelessSession(session);
    return ok(c, { id: session.fileId });
  } catch (e) {
    return fail(c, e);
  }
});

/** 放弃上传。对应 `node.StatelessOnUploadFailed`。 */
slaveRoutes.post('/statelessUpload/failed', async (c) => {
  try {
    const body = bodyOf<{ upload_session?: Record<string, unknown>; user_id?: number }>(c);
    const userId = requireUserId(body as Record<string, unknown>);
    const raw = body.upload_session ?? {};
    const sessionId = String((raw.Props as Record<string, unknown> | undefined)?.UploadSessionID ?? '');
    if (!sessionId) throw Err.param('upload_session is required');

    const ctx = await ctxForNode(c, userId);
    const upload = new UploadService(ctx, new FileSystemService(ctx));
    const session = await upload.loadSession(sessionId);
    if (!session) return ok(c);
    if (session.uid !== userId) throw Err.noPermission();
    await upload.discardSession(session);
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});

/** 只建一个空文件/目录。对应 `node.StatelessCreateFile`。 */
slaveRoutes.post('/statelessUpload/create', async (c) => {
  try {
    const body = bodyOf<{ path?: string; type?: number; user_id?: number }>(c);
    const userId = requireUserId(body as Record<string, unknown>);
    const path = String(body.path ?? '');
    if (!path) throw Err.param('path is required');

    const ctx = await ctxForNode(c, userId);
    const fs = new FileSystemService(ctx);
    await fs.create(URI.parse(path), body.type === 1 ? 'folder' : 'file');
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});
