/**
 * 通用 S3 兼容驱动（SigV4，纯 Web Crypto 实现，无第三方依赖）。
 *
 * 覆盖上游 `pkg/filemanager/driver` 里所有「走 S3 兼容 API」的驱动：
 *   - `s3`    → AWS S3 / 任意 S3 兼容存储（MinIO、Wasabi、R2 公开桶…）
 *   - `oss`   → 阿里云 OSS（`https://oss-cn-*.aliyuncs.com`，兼容层支持 SigV4）
 *   - `cos`   → 腾讯云 COS（`https://cos.ap-*.myqcloud.com`）
 *   - `obs`   → 华为云 OBS（`https://obs.*.myhuaweicloud.com`）
 *   - `qiniu` → 七牛（`https://s3.<region>.qiniucs.com`）
 *   - `ks3`   → 金山 KS3（`https://s3.<region>.ksyun.com`）
 *
 * 与上游驱动共享同一套策略字段（见 inventory/policy.go）：
 *   - 端点 `policy.server`（或 `settings.server_side_endpoint`）
 *   - 桶 `policy.bucket_name`、密钥 `policy.access_key` / `policy.secret_key`
 *   - `settings.region`（SigV4 的 region，按厂商填 `oss-cn-hangzhou` /
 *     `ap-guangzhou` 等）、`settings.s3_path_style`（path 寻址开关）、
 *     `settings.use_cname`（endpoint 是绑定桶的自定义域名，不再拼桶前缀）
 *
 * 上传默认**客户端直传**（与上游 S3 驱动一致）：单块返回预签名 PUT，
 * 多块服务端发起 CreateMultipartUpload 后逐片签 UploadPart URL；
 * `settings.relay=true` 时切中转模式，由 Worker 签名转发分片。
 */
import type { StoragePolicyRow } from '../db/types';
import { attachmentDisposition } from '../lib/disposition';
import { RangeNotSatisfiable } from '../lib/errors';
import {
  resolveChunkSize,
  type DriverCapabilities,
  type GetSourceArgs,
  type ObjectContent,
  type StorageDriver,
  type UploadCredential,
  type UploadRequest,
  type UploadSession,
  type UploadedPart,
} from './types';

// ---------------------------------------------------------------------------
// Web Crypto 基础件
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(data));
  return hex(digest);
}

/** 二进制版（上传分片物化后算真实 payload hash 用）。 */
async function sha256HexBytes(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  return hex(digest);
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key instanceof Uint8Array ? key as unknown as ArrayBuffer : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return new Uint8Array(sig);
}

/** AWS SigV4 要求的 RFC3986 严格编码（`!*'()` 也要编码，`~` 保留）。 */
function awsUriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9]/.test(ch) || ch === '-' || ch === '.' || ch === '_' || ch === '~') {
      out += ch;
    } else if (ch === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      const bytes = encoder.encode(ch);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

function amzDates(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString();
  const dateStamp = iso.slice(0, 10).replace(/-/g, '');
  const amzDate = iso.slice(0, 19).replace(/[-:]/g, '') + 'Z';
  return { amzDate, dateStamp };
}

/** searchParams 已是解码值；再解码失败（值含字面 '%'）时保留原样。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// 驱动本体
// ---------------------------------------------------------------------------

export class S3CompatibleDriver implements StorageDriver {
  readonly type: string;
  readonly chunkSize: number;
  readonly settings;

  private readonly endpoint: URL;
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKey: string;
  private readonly secretKey: string;
  private readonly pathStyle: boolean;
  private readonly cname: boolean;
  private readonly deleteBatchSize: number;

  constructor(
    readonly policy: StoragePolicyRow,
    /** 对外呈现的驱动类型名（= 策略类型），仅用于日志/调试。 */
    typeOverride?: string,
  ) {
    this.type = typeOverride ?? policy.type;
    this.settings = policy.settings ?? {};
    this.chunkSize = Math.max(5 * 1024 * 1024, resolveChunkSize(this.settings, 25 << 20));
    this.pathStyle = this.settings.s3_path_style === true;
    this.cname = this.settings.use_cname === true;
    this.deleteBatchSize = Math.min(
      1000,
      Math.max(1, this.settings.s3_delete_batch_size ?? 1000),
    );

    const endpointRaw = (this.settings.server_side_endpoint || policy.server || '').trim();
    if (!endpointRaw) {
      throw new Error('Storage policy is missing the S3 endpoint (server field)');
    }
    this.endpoint = new URL(endpointRaw.includes('://') ? endpointRaw : `https://${endpointRaw}`);

    this.bucket = (policy.bucket_name ?? '').trim();
    if (!this.bucket && !this.cname) {
      throw new Error('Storage policy is missing the bucket name');
    }
    this.region = (this.settings.region || 'us-east-1').trim();
    this.accessKey = (policy.access_key ?? '').trim();
    this.secretKey = (policy.secret_key ?? '').trim();
    if (!this.accessKey || !this.secretKey) {
      throw new Error('Storage policy is missing S3 access key / secret key');
    }
  }

  capabilities(): DriverCapabilities {
    return {
      // 预签名 URL 直出，不需要 Worker 代理
      proxyRequired: false,
      uploadSentinelRequired: true,
      maxSourceExpire: 604800,
      thumbSupportedExts: this.settings.thumb_exts ?? [],
      thumbSupportAllExts: this.settings.thumb_support_all_exts === true,
      thumbMaxSize: this.settings.thumb_max_size ?? 0,
    };
  }

  // -------------------------------------------------------------------------
  // URL 与签名
  // -------------------------------------------------------------------------

  /** 对象地址。query 里的键值会被正确编码；`''` 值保留裸键（如 `?uploads`）。 */
  private objectUrl(key: string, query?: Array<[string, string]>): URL {
    const u = new URL(this.endpoint.toString());
    const encodedKey = key.split('/').map((seg) => awsUriEncode(seg, false)).join('/');

    if (this.cname || !this.bucket) {
      u.pathname = `/${encodedKey}`;
    } else if (this.pathStyle) {
      u.pathname = `/${awsUriEncode(this.bucket, false)}/${encodedKey}`;
    } else {
      u.hostname = `${this.bucket}.${u.hostname}`;
      u.pathname = `/${encodedKey}`;
    }

    if (query && query.length > 0) {
      const pairs = query.map(([k, v]) =>
        v === '' ? [awsUriEncode(k)] : [awsUriEncode(k), awsUriEncode(v)],
      );
      pairs.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
      u.search = pairs.map((p) => p.join('=')).join('&');
    }
    return u;
  }

  /**
   * Header 签名（AWS4-HMAC-SHA256）。
   * `extra` 里的 range / content-type 等会一并纳入签名（官方 GET Object
   * 示例即签了 range）；host 与 x-amz-* 始终参与。
   */
  private async signedHeaders(
    method: string,
    url: URL,
    payloadHash: string,
    extra: Record<string, string> = {},
    now = new Date(),
  ): Promise<Record<string, string>> {
    const { amzDate, dateStamp } = amzDates(now);

    const signable: Array<[string, string]> = [
      ['host', url.host.toLowerCase()],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
    ];
    for (const [k, v] of Object.entries(extra)) {
      const name = k.toLowerCase();
      if (name === 'host' || name.startsWith('x-amz-')) continue;
      if (v === undefined || v === null || v === '') continue;
      signable.push([name, String(v)]);
    }
    signable.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

    const signedHeaderNames = signable.map(([k]) => k).join(';');
    // 每行自带结尾换行；与下一元素的 join('\n') 共同构成空行分隔（官方格式）
    const canonicalHeaders = signable.map(([k, v]) => `${k}:${v.trim()}\n`).join('');

    // S3 规则：path 不二次编码，query 键值 RFC3986 编码后按字典序排。
    // searchParams 已解码过一次，这里防御性解码（值本身含 '%' 时保留原样）。
    const canonicalQuery = [...url.searchParams.entries()]
      .map(([k, v]) => [safeDecode(k), safeDecode(v)])
      .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)])
      .map((p) => p.join('='))
      .sort()
      .join('&');

    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      canonicalHeaders,
      signedHeaderNames,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmac(encoder.encode(`AWS4${this.secretKey}`), dateStamp);
    const kRegion = await hmac(kDate, this.region);
    const kService = await hmac(kRegion, 's3');
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = hex(await hmac(kSigning, stringToSign));

    const out: Record<string, string> = {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    };
    for (const [k, v] of Object.entries(extra)) {
      if (out[k.toLowerCase()] === undefined) out[k] = v;
    }
    return out;
  }

  /** Query 签名（预签名 URL），payload 固定 UNSIGNED-PAYLOAD。 */
  private async presign(
    method: string,
    url: URL,
    expiresSeconds: number,
    now = new Date(),
    extraParams: Record<string, string> = {},
  ): Promise<string> {
    const { amzDate, dateStamp } = amzDates(now);
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;

    // 预签名 URL 必须保留目标 URL 上已有的业务参数（partNumber / uploadId /
    // response-content-disposition 等），否则签名虽对、语义已丢
    const params = new Map<string, string>([
      ...url.searchParams.entries(),
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Credential', `${this.accessKey}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(Math.max(1, Math.min(604800, expiresSeconds)))],
      ['X-Amz-SignedHeaders', 'host'],
      ...Object.entries(extraParams),
    ]);
    const canonicalQuery = [...params.entries()]
      .map(([k, v]) => [awsUriEncode(k), awsUriEncode(v)])
      .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0))
      .map((p) => p.join('='))
      .join('&');

    const canonicalRequest = [
      method,
      url.pathname,
      canonicalQuery,
      `host:${url.host.toLowerCase()}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    const kDate = await hmac(encoder.encode(`AWS4${this.secretKey}`), dateStamp);
    const kRegion = await hmac(kDate, this.region);
    const kService = await hmac(kRegion, 's3');
    const kSigning = await hmac(kService, 'aws4_request');
    const signature = hex(await hmac(kSigning, stringToSign));

    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /** 发起签名请求。流式 body 先物化成字节（见下方说明），哈希精确计算。 */
  private async signedFetch(
    method: string,
    url: URL,
    opts: { body?: ReadableStream | string; headers?: Record<string, string>; raw?: boolean } = {},
  ): Promise<Response> {
    let bodyData: Uint8Array | string | undefined;
    let payloadHash: string;
    if (typeof opts.body === 'string') {
      bodyData = opts.body;
      payloadHash = await sha256Hex(opts.body);
    } else if (opts.body) {
      // 把分片物化成 Uint8Array：① 拿到精确 Content-Length，避免传输层
      // 退化成 chunked —— 阿里云官方《使用 AWS SDK 访问 OSS》明确 OSS 的
      // SigV4 兼容层**不支持 chunked 传输编码**（AWS S3 默认分块传输）；
      // ② 精确计算 payload hash 参与签名。分片 ≤ chunkSize（默认 25MB），
      // 物化在内存里是可接受的。
      const buf = new Uint8Array(await new Response(opts.body).arrayBuffer());
      bodyData = buf;
      payloadHash = await sha256HexBytes(buf);
    } else {
      payloadHash = await sha256Hex('');
    }

    const signable: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const name = k.toLowerCase();
      if (name === 'range' || name === 'content-type') signable[name] = String(v);
    }
    const headers: Record<string, string> = {
      ...(await this.signedHeaders(method, url, payloadHash, signable)),
      ...opts.headers,
    };
    // 阿里云 OSS 的 SigV4 兼容层额外要求带 x-oss-content-sha256 头（官方
    // 文档原文要求值为 UNSIGNED-PAYLOAD 或真实哈希）。这是厂商自定义头，
    // 不进 AWS 签名（SigV4 只签 x-amz-*），对其他厂商是普通可忽略头。
    if (this.type === 'oss') {
      headers['x-oss-content-sha256'] = payloadHash;
    }
    if (bodyData instanceof Uint8Array) {
      headers['content-length'] = String(bodyData.length);
    }

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: bodyData as BodyInit | undefined,
    });
    if (!res.ok && !opts.raw) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `S3 request failed (${res.status} ${method} ${url.pathname}): ${text.slice(0, 500)}`,
      );
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // 上传
  // -------------------------------------------------------------------------

  private chunkCountOf(size: number): number {
    return size <= 0 ? 1 : Math.ceil(size / this.chunkSize);
  }

  async token(session: UploadSession, file: UploadRequest): Promise<UploadCredential> {
    const expires = Math.floor(session.expireAt / 1000);
    const chunks = this.chunkCountOf(file.size);
    const contentType = file.mimeType || 'application/octet-stream';

    // 对齐上游 s3.go Token()：一律开 multipart（含单块文件），前端直传
    // 流程固定为 upload_urls 直传 → completeURL 合并 → /callback/s3 转正。
    // 前端 afterUpload 无条件调用 s3LikeFinishUpload(session.completeURL)，
    // 缺了 completeURL 整个上传必失败。
    const res = await this.signedFetch('POST', this.objectUrl(file.savePath, [['uploads', '']]), {
      headers: { 'content-type': contentType },
    });
    const xml = await res.text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1];
    if (!uploadId) throw new Error(`CreateMultipartUpload returned no UploadId: ${xml.slice(0, 300)}`);
    session.uploadId = uploadId;

    const uploadUrls: string[] = [];
    for (let i = 1; i <= chunks; i++) {
      uploadUrls.push(
        await this.presign(
          'PUT',
          this.objectUrl(file.savePath, [
            ['partNumber', String(i)],
            ['uploadId', uploadId],
          ]),
          expires,
        ),
      );
    }

    // 预签名 CompleteMultipartUpload：前端把 parts XML 直接 POST 到这里，
    // 不经 Worker（s3LikeFinishUpload，POST + status==200）
    const completeURL = await this.presign(
      'POST',
      this.objectUrl(file.savePath, [['uploadId', uploadId]]),
      expires,
    );

    return {
      session_id: session.id,
      chunk_size: this.chunkSize,
      expires,
      uploadID: uploadId,
      upload_urls: uploadUrls,
      completeURL,
    };
  }

  async put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void> {
    if (!file.overwrite) {
      const existing = await this.meta(file.savePath);
      if (existing) throw new Error('Object existed');
    }
    await this.signedFetch('PUT', this.objectUrl(file.savePath), {
      body,
      headers: {
        'content-length': String(contentLength),
        ...(file.mimeType ? { 'content-type': file.mimeType } : {}),
      },
    });
  }

  async writeChunk(
    session: UploadSession,
    index: number,
    body: ReadableStream,
    length: number,
  ): Promise<UploadedPart | null> {
    if (!session.uploadId) {
      // 中转单块路径
      await this.signedFetch('PUT', this.objectUrl(session.savePath), {
        body,
        headers: {
          'content-length': String(length),
          ...(session.mimeType ? { 'content-type': session.mimeType } : {}),
        },
      });
      return null;
    }

    const res = await this.signedFetch(
      'PUT',
      this.objectUrl(session.savePath, [
        ['partNumber', String(index + 1)],
        ['uploadId', session.uploadId],
      ]),
      { body, headers: { 'content-length': String(length) } },
    );
    const etag = (res.headers.get('etag') ?? res.headers.get('ETag') ?? '').replace(/"/g, '');
    return { partNumber: index + 1, etag };
  }

  async completeUpload(session: UploadSession): Promise<void> {
    if (!session.uploadId) return; // 单次写入已完成
    const parts = [...(session.parts ?? [])].sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length === 0) return;

    const xml =
      '<CompleteMultipartUpload>' +
      parts
        .map(
          (p) =>
            `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag.replace(/"/g, '')}"</ETag></Part>`,
        )
        .join('') +
      '</CompleteMultipartUpload>';

    const res = await this.signedFetch(
      'POST',
      this.objectUrl(session.savePath, [['uploadId', session.uploadId]]),
      { body: xml, raw: true },
    );
    const body = await res.text();
    // 任一厂商收尾失败都会在 200 响应里嵌 <Error>（AWS 语义）
    if (body.includes('<Error>') || body.includes('<Code>')) {
      throw new Error(`CompleteMultipartUpload failed: ${body.slice(0, 500)}`);
    }
  }

  async cancelToken(session: UploadSession): Promise<void> {
    if (session.uploadId) {
      try {
        await this.signedFetch(
          'DELETE',
          this.objectUrl(session.savePath, [['uploadId', session.uploadId]]),
          { raw: true },
        );
      } catch {
        // 会话可能已过期，忽略
      }
    }
    // 无论是不是覆盖上传，savePath 都是本次会话新生成的占位对象键，取消时必须清掉。
    try {
      await this.signedFetch('DELETE', this.objectUrl(session.savePath), { raw: true });
    } catch {
      // ignore
    }
  }

  // -------------------------------------------------------------------------
  // 删除 / 读取 / 元信息 / 直链
  // -------------------------------------------------------------------------

  async delete(sources: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < sources.length; i += this.deleteBatchSize) {
      const batch = sources.slice(i, i + this.deleteBatchSize);
      const xml =
        '<Delete>' +
        batch
          .map(
            (k) =>
              `<Object><Key>${k.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</Key></Object>`,
          )
          .join('') +
        '<Quiet>true</Quiet></Delete>';
      try {
        await this.signedFetch('POST', this.objectUrl('', [['delete', '']]), { body: xml });
      } catch {
        failed.push(...batch);
      }
    }
    return failed;
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const headers: Record<string, string> = {};
    if (range) headers.range = range;
    const res = await this.signedFetch('GET', this.objectUrl(source), { headers, raw: true });
    if (res.status === 404) return null;
    // Range 越界必须在 !res.ok 之前判：否则抛普通 Error → /content 的 fail()
    // 变成「HTTP 200 + 业务 JSON」，播放器把 JSON 当媒体数据，拖动后卡死。
    if (res.status === 416) {
      await res.body?.cancel().catch(() => {});
      const cr = res.headers.get('content-range');
      const total = cr ? Number(cr.split('/')[1]) : Number.NaN;
      throw new RangeNotSatisfiable(Number.isFinite(total) ? total : 0);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`S3 GET failed (${res.status}) for ${source}`);
    }

    let size = Number(res.headers.get('content-length') ?? 0);
    let contentRange: string | null = null;
    const cr = res.headers.get('content-range');
    if (cr) {
      contentRange = cr;
      const total = Number(cr.split('/')[1]);
      if (Number.isFinite(total)) size = total;
    }
    return {
      body: res.body!,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const res = await this.signedFetch('HEAD', this.objectUrl(source), { raw: true });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD failed (${res.status}) for ${source}`);
    await res.body?.cancel().catch(() => {});
    // 缺 Content-Length 不能当成 0 字节：上传哨兵校验会「校验通过」，之后
    // 文件大小对不上的问题极难定位（对应上游 9792a5c）。
    const raw = res.headers.get('content-length');
    const size = raw === null || raw === '' ? Number.NaN : Number(raw);
    if (!Number.isFinite(size)) {
      throw new Error(`S3 HEAD returned no usable Content-Length for ${source}`);
    }
    return { size };
  }

  /**
   * ListObjectsV2 分页列举（导入任务用）。
   * @param prefix 键前缀（对应导入的「外部路径」）
   * @param continuation 上一批返回的 continuationToken
   * @param afterKey 只返回键 > afterKey 的对象（断点续跑）
   */
  async list(
    prefix: string,
    options: { continuation?: string; afterKey?: string; limit?: number } = {},
  ): Promise<{ keys: { key: string; size: number; lastModified: Date }[]; continuation: string | null }> {
    const limit = Math.min(1000, Math.max(1, options.limit ?? 1000));
    const q: Array<[string, string]> = [
      ['list-type', '2'],
      ['max-keys', String(limit)],
    ];
    if (prefix) q.push(['prefix', prefix]);
    if (options.continuation) q.push(['continuation-token', options.continuation]);

    const res = await this.signedFetch('GET', this.objectUrl('', q));
    const text = await res.text();
    if (!res.ok) throw new Error(`S3 ListObjectsV2 failed (${res.status}): ${text.slice(0, 300)}`);

    const decodeEntities = (s: string): string =>
      s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');

    const pick = (block: string, tag: string): string =>
      decodeEntities(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? '');

    const keys: { key: string; size: number; lastModified: Date }[] = [];
    const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let m: RegExpExecArray | null;
    while ((m = contentsRe.exec(text)) !== null) {
      const block = m[1]!;
      const key = pick(block, 'Key');
      const size = Number(pick(block, 'Size') || 0);
      const lastModified = new Date(pick(block, 'LastModified') || 0);
      if (!key) continue;
      if (options.afterKey && key <= options.afterKey) continue;
      keys.push({ key, size, lastModified });
    }
    const nextToken = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(text)?.[1];
    return {
      keys,
      continuation: nextToken ? decodeEntities(nextToken) : null,
    };
  }

  /**
   * 为桶写入跨域规则。对应上游 `driver/s3/s3.go:442` 的 `CORS()`。
   *
   * 直传（`relay=false`）时浏览器要直接把分片 PUT 到对象存储端点，PREFLIGHT
   * 与响应都必须带 CORS 头，否则浏览器侧只会看到 `Network Error`（没有
   * HTTP 响应）。PutBucketCors 是 S3 标准子资源，R2 / MinIO / OSS / COS
   * 等兼容实现都认，所以这里用统一的 S3 签名请求发出。
   *
   * 规则与上游逐字段对齐：AllowedMethods 五种全开、Origin/Header 均为 `*`、
   * ExposeHeaders 只放 ETag（分片上传要读回它做 Complete）、MaxAge 3600。
   */
  async setCors(): Promise<void> {
    const xml =
      '<CORSConfiguration>' +
      '<CORSRule>' +
      ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'].map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join('') +
      '<AllowedOrigin>*</AllowedOrigin>' +
      '<AllowedHeader>*</AllowedHeader>' +
      '<ExposeHeader>ETag</ExposeHeader>' +
      '<MaxAgeSeconds>3600</MaxAgeSeconds>' +
      '</CORSRule>' +
      '</CORSConfiguration>';

    // `?cors` 是子资源，必须进签名（signedFetch → signedHeaders 会带上 query）
    await this.signedFetch('PUT', this.objectUrl('', [['cors', '']]), {
      body: xml,
      headers: { 'content-type': 'application/xml' },
    });
  }

  async source(source: string, args: GetSourceArgs): Promise<string> {
    const expires =
      args.expire && args.expire > 0
        ? Math.max(60, Math.floor((args.expire - Date.now()) / 1000))
        : 3600;
    // 强制下载时让对象存储代发 attachment 头（S3 标准响应头覆盖参数）
    const extraParams: Record<string, string> = args.isDownload
      ? {
          'response-content-disposition': attachmentDisposition(args.displayName),
        }
      : {};
    return this.presign('GET', this.objectUrl(source), expires, new Date(), extraParams);
  }

  async thumb(): Promise<string | null> {
    return null;
  }
}
