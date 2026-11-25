/**
 * 上传回调路由。对应 Cloudreve v4 `routers/router.go:472-546` 的 callback 分组。
 *
 * 边缘版只实现 **OneDrive** 一条：它的上传是客户端直传微软，字节不经过 Worker，
 * 所以「实体转正 + 容量记账」必须由客户端打完最后一字节后回调这里触发
 * （原版同样如此，见 `service/callback/upload.go:44-60` 的 `ProcessCallback`）。
 *
 * 其余驱动（remote / oss / upyun / cos / s3 / ks3 / obs / qiniu）边缘版不实现，
 * 统一返回 `CodeFeatureNotEnabled`，避免前端拿到 404 后误判。
 *
 * 鉴权：URL 里的 `:key` 必须等于上传会话的 `callbackSecret`。原版在
 * `middleware/auth.go:194-219` 做常量时间比较，不匹配报 `CodeCredentialInvalid`；
 * 会话不存在或过期报 `CodeUploadSessionExpired`。这三条都在服务层实现。
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok } from '../lib/response';
import { AppError, CodeFeatureNotEnabled } from '../lib/errors';
import { FileSystemService } from '../services/fs';
import { UploadService } from '../services/upload';
import { SearchService } from '../services/search';
import { hookMediaMeta } from '../services/media/indexer';

export const callbackRoutes = new Hono<AppBindings>();

/** OneDrive 直传完成回调（POST）。 */
callbackRoutes.post('/onedrive/:sessionID/:key', handleCallback);

/**
 * S3 系直传完成回调（GET，前端 sendS3LikeCompleteUpload）。
 * 对齐上游 routers/router.go：`/api/v4/callback/:driver/:sessionID/:key`，
 * driver ∈ s3/oss/cos/obs/qiniu/ks3。客户端已自行用 completeURL 完成
 * CompleteMultipartUpload，这里只负责实体转正 + 容量记账。
 */
for (const driver of ['s3', 'oss', 'cos', 'obs', 'qiniu', 'ks3'] as const) {
  callbackRoutes.get(`/${driver}/:sessionID/:key`, handleCallback);
}

async function handleCallback(c: AppRequest) {
  const ctx = ctxOf(c);
  try {
    const service = new FileSystemService(ctx);
    const upload = new UploadService(ctx, service);
    // 直传收尾后送全文索引 + 媒体元数据（waitUntil 不阻塞回调响应）
    const search = new SearchService(ctx);
    upload.onUploadFinished = (file) => {
      if (search.available) {
        c.executionCtx.waitUntil(
          search.indexFile(file).catch((e) => console.error('FTS index after upload failed', e)),
        );
      }
      hookMediaMeta(ctx, file);
    };
    await upload.completeByCallback(c.req.param('sessionID') ?? '', c.req.param('key') ?? '');
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
}

callbackRoutes.all('/*', (c) =>
  fail(
      c,
      new AppError(
        CodeFeatureNotEnabled,
        'Only the OneDrive upload callback is implemented in the edge build',
      ),
    ),
);
