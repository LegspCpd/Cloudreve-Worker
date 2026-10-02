/**
 * OneDrive 驱动（Microsoft Graph API）。
 *
 * 配置字段的对应关系严格按 Cloudreve v4 的 `onedrive/client.go`：
 *   - `policy.server`        → Graph API 基址（如 https://graph.microsoft.com/v1.0）
 *                              **并且**决定 OAuth 端点：host 为
 *                              `microsoftgraph.chinacloudapi.cn` 时走世纪互联，
 *                              否则走 global。
 *   - `policy.settings.od_driver` → drive 资源段（`me/drive` 或 `sites/<id>/drive`），
 *                              默认 `me/drive`。注意它**不**参与 OAuth 端点选择。
 *   - `policy.bucket_name`   → OAuth client_id
 *   - `policy.secret_key`    → OAuth client_secret
 *   - `policy.access_key`    → **refresh_token**（原版就把 refresh token 存在这个字段）
 *   - `policy.settings.od_redirect` → OAuth redirect_uri
 *
 * 上传走客户端直传：`createUploadSession` 返回的 `uploadUrl` 直接交给客户端，
 * 分片由客户端 PUT 给微软，不经过 Worker。
 */
import type { Env } from '../env';
import { kvFor } from '../lib/kvRouter';
import { getSql } from '../db';
import type { StoragePolicyRow } from '../db/types';
import { bytesToBase64, base64ToBytes } from '../lib/crypto';
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

const OAUTH_GLOBAL = {
  token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
};
const OAUTH_CHINA = {
  token: 'https://login.chinacloudapi.cn/common/oauth2/v2.0/token',
  authorize: 'https://login.chinacloudapi.cn/common/oauth2/v2.0/authorize',
};

const CHINA_GRAPH_HOST = 'microsoftgraph.chinacloudapi.cn';
/** 单次简单上传上限（Graph 要求 ≤ 4MB） */
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;
/** access token 提前刷新余量（原版 AccessTokenExpiryMargin = 600 秒） */
const TOKEN_EXPIRY_MARGIN = 600;
/** $batch 单次最多 20 条请求（原版 BatchDelete 按 20 分组） */
const BATCH_SIZE = 20;

export interface OAuthCredential {
  access_token: string;
  refresh_token: string;
  /** 绝对过期时间（Unix 秒），与原版把相对秒数转绝对值的做法一致 */
  expires_in: number;
  /** 上一次成功换取 token 的绝对时间（Unix 秒），对应原版 `Credential.RefreshedAtUnix` */
  refreshed_at: number;
}

/**
 * L1 凭证缓存（isolate 级）：键与 KV 键一致（cred_od_<policyId>），
 * validUntil = 凭证绝对过期秒。热路径直接命中内存，省掉一次 KV 往返；
 * 条目数以策略数为上界，无需清理。
 */
const l1Credentials = new Map<string, { credential: OAuthCredential; validUntil: number }>();
/** 在途「取凭证」单飞承诺（isolate 级），防止并发刷新风暴。 */
const l1Refresh = new Map<string, Promise<OAuthCredential>>();

/** 管理端改换凭证（换 App ID/Secret、重新授权）后清掉本 isolate 的 L1。 */
export function invalidateOdCredentialCache(policyId: number): void {
  const key = `cred_od_${policyId}`;
  l1Credentials.delete(key);
  l1Refresh.delete(key);
}

/** 逐段编码路径；Cloudreve 的文件名校验已禁止 `:` `/` 等字符，这里主要处理空格与 `#`。 */
function graphPath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

export class OneDriveDriver implements StorageDriver {
  readonly type = 'onedrive';
  readonly chunkSize: number;
  readonly settings;
  private readonly graphBase: string;
  private readonly driveResource: string;
  private readonly oauth: { token: string; authorize: string };
  private readonly capacity = 0;

  constructor(
    private readonly env: Env,
    readonly policy: StoragePolicyRow,
  ) {
    this.settings = policy.settings ?? {};
    // Graph 基址去掉尾部斜杠
    this.graphBase = (policy.server ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, '');
    this.driveResource = (this.settings.od_driver || 'me/drive').replace(/^\/+|\/+$/g, '');
    this.chunkSize = resolveChunkSize(policy.settings, 50 << 20); // 原版默认 50MB

    let host = '';
    try {
      host = new URL(this.graphBase).host;
    } catch {
      host = '';
    }
    this.oauth = host === CHINA_GRAPH_HOST ? OAUTH_CHINA : OAUTH_GLOBAL;
  }

  capabilities(): DriverCapabilities {
    return {
      // 下载走 @microsoft.graph.downloadUrl，需要 Worker 先换取一次直链
      proxyRequired: this.settings.internal_proxy === true,
      uploadSentinelRequired: true,
      // 原版未设置 MaxSourceExpire，此处同样为 0（不限制）
      maxSourceExpire: 0,
      thumbSupportedExts: this.settings.thumb_exts ?? [],
      thumbSupportAllExts: this.settings.thumb_support_all_exts === true,
      thumbMaxSize: this.settings.thumb_max_size ?? 0,
      // 下载地址是 @microsoft.graph.downloadUrl，文件名由微软按存储对象名下发，
      // 无法覆盖 —— 强制下载要改走站点代理（见 DownloadService.getUrls）。
      directUrlFilename: false,
    };
  }

  // -------------------------------------------------------------------------
  // OAuth
  // -------------------------------------------------------------------------

  private get credentialKey(): string {
    return `cred_od_${this.policy.id}`;
  }

  /**
   * 取可用的 access token。
   *
   * 三级：L1 isolate 内存（有效期内零额外往返）→ L2 KV → 用 refresh_token
   * 现换。并发请求通过单飞承诺共享同一次刷新，避免多个请求同时拿同一个
   * refresh_token 去微软换新（轮换令牌并发使用可能被作废，正是
   * 「偶发整页失败、点重新授权才恢复」的来源之一）。
   */
  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const l1 = l1Credentials.get(this.credentialKey);
    if (l1 && l1.validUntil - TOKEN_EXPIRY_MARGIN > now) return l1.credential.access_token;
    const credential = await this.getCredential();
    return credential.access_token;
  }

  /** 单飞入口：同一策略在同一 isolate 内同时只允许一个「取凭证」在途。 */
  private getCredential(): Promise<OAuthCredential> {
    const key = this.credentialKey;
    const inflight = l1Refresh.get(key);
    if (inflight) return inflight;
    const p = this.loadCredential().finally(() => {
      l1Refresh.delete(key);
    });
    l1Refresh.set(key, p);
    return p;
  }

  private async loadCredential(): Promise<OAuthCredential> {
    const now = Math.floor(Date.now() / 1000);
    const cached = await this.readCredential();
    if (cached?.access_token && cached.expires_in - TOKEN_EXPIRY_MARGIN > now) {
      this.l1Set(cached);
      return cached;
    }
    try {
      const credential = await this.refreshToken(cached?.refresh_token ?? this.policy.access_key ?? '');
      this.l1Set(credential);
      return credential;
    } catch (e) {
      // 刷新失败（微软/网络抖动）时降级：缓存的 access token 若仍在
      // 真实有效期内就继续用，别让一次抖动把整页操作打挂。
      // 提前量只有 600 秒，多数情况下该 token 还有实际可用时间。
      if (cached?.access_token && cached.expires_in > now) {
        this.l1Set(cached);
        return cached;
      }
      throw e;
    }
  }

  /** L1 命中优先，其次读 KV。两个层级中的凭证形状一致（纯 JSON）。 */
  private async readCredential(): Promise<OAuthCredential | null> {
    const l1 = l1Credentials.get(this.credentialKey);
    if (l1) return l1.credential;
    return (await kvFor(this.env, 'cred').get(this.credentialKey, 'json')) as OAuthCredential | null;
  }

  private l1Set(credential: OAuthCredential): void {
    l1Credentials.set(this.credentialKey, { credential, validUntil: credential.expires_in });
  }

  /** 忽略余量强制换新（Graph 返回 401 时的自愈路径）。同样走单飞。 */
  private forceRefresh(): Promise<OAuthCredential> {
    const key = this.credentialKey;
    const inflight = l1Refresh.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      l1Credentials.delete(key);
      const cached = await this.readCredential();
      return this.refreshToken(cached?.refresh_token ?? this.policy.access_key ?? '');
    })().finally(() => {
      l1Refresh.delete(key);
    });
    l1Refresh.set(key, p);
    return p;
  }

  private async refreshToken(refreshToken: string): Promise<OAuthCredential> {
    if (!refreshToken) {
      throw new Error('OneDrive policy is missing a refresh token (policy.access_key)');
    }
    const body = new URLSearchParams({
      client_id: this.policy.bucket_name ?? '',
      client_secret: this.policy.secret_key ?? '',
      redirect_uri: this.settings.od_redirect ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const res = await fetch(this.oauth.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to refresh OneDrive token: ${res.status} ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    const credential: OAuthCredential = {
      access_token: json.access_token,
      refresh_token: json.refresh_token || refreshToken,
      expires_in: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
      refreshed_at: Math.floor(Date.now() / 1000),
    };

    // 双写：① KV 缓存（TTL = 距过期还剩 margin 秒，下限 60）；
    // ② **轮换出的新 refresh_token 回写 Neon**。微软的 refresh_token 是
    //    轮换制——每换一次旧的作废。KV 条目到期后，下一次刷新要从数据库
    //    拿最新令牌；不回写的话数据库里永远是初始旧令牌，等 KV 一过期
    //    所有操作都会 invalid_grant，直到管理员重新授权（对应上游
    //    onedrive/oauth.go:122 UpdateAccessKey 每次刷新后写回）。
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, credential.expires_in - TOKEN_EXPIRY_MARGIN - now);
    const rotated =
      !!credential.refresh_token && credential.refresh_token !== (this.policy.access_key ?? '');
    await Promise.all([
      kvFor(this.env, 'cred')
        .put(this.credentialKey, JSON.stringify(credential), { expirationTtl: ttl })
        .catch(() => {
          /* 缓存尽力而为：失败只影响下次命中，不影响本次请求 */
        }),
      rotated
        ? getSql(this.env)`
            UPDATE storage_policies SET access_key = ${credential.refresh_token}, updated_at = now()
            WHERE id = ${this.policy.id}
          `
            .then(async () => {
              // 同步内存快照，同一驱动实例的后续刷新据此判重，避免重复写回
              this.policy.access_key = credential.refresh_token;
              // 这条 UPDATE 绕过了 PolicyRepo（裸 SQL），必须手动失效策略缓存，
              // 否则缓存里的旧 refresh_token 最长滞留 L1/L2 TTL
              try {
                const { evictPolicyCache } = await import('../services/policyCache');
                await evictPolicyCache(this.policy.id);
              } catch {
                // TTL 兜底
              }
            })
            .catch((e) => {
              // 数据库写回失败只告警：KV 里已有新令牌，下一轮刷新会再试
              console.warn('[onedrive] persist rotated refresh_token failed:', e);
            })
        : Promise.resolve(),
    ]);

    return credential;
  }

  /** 生成授权 URL（后台配置策略时用）。 */
  authorizeUrl(scopes: string[]): string {
    const url = new URL(this.oauth.authorize);
    url.searchParams.set('client_id', this.policy.bucket_name ?? '');
    url.searchParams.set('scope', scopes.join(' '));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.settings.od_redirect ?? '');
    url.searchParams.set('state', String(this.policy.id));
    return url.toString();
  }

  /** 用授权码换 token（后台 OAuth 回调时用）。 */
  async exchangeCode(code: string): Promise<OAuthCredential> {
    const body = new URLSearchParams({
      client_id: this.policy.bucket_name ?? '',
      client_secret: this.policy.secret_key ?? '',
      redirect_uri: this.settings.od_redirect ?? '',
      grant_type: 'authorization_code',
      code,
    });
    const res = await fetch(this.oauth.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to exchange OneDrive code: ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    const credential: OAuthCredential = {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600),
      refreshed_at: Math.floor(Date.now() / 1000),
    };
    const ttl = Math.max(60, credential.expires_in - TOKEN_EXPIRY_MARGIN - Math.floor(Date.now() / 1000));
    await kvFor(this.env, 'cred').put(this.credentialKey, JSON.stringify(credential), { expirationTtl: ttl });
    // 新凭证直接进 L1，并清掉可能在途的旧刷新承诺
    this.l1Set(credential);
    l1Refresh.delete(this.credentialKey);
    return credential;
  }

  /**
   * 读取当前凭证状态，对应原版 `OauthCredentialStatus`。
   *
   * 原版从凭据管理器拿 Credential 后取 `RefreshedAt()`；这里读同一份 KV 缓存。
   * 缓存里没有（未授权 / 已过期）或策略本身没存 refresh token 时，都算未授权。
   */
  /**
   * 读取当前凭证状态，对应原版 `OauthCredentialStatus`。
   *
   * **数据库是权威**：`policy.access_key`（refresh token）非空即视为已授权。
   * KV 是缓存且有最终一致性延迟（全球传播可达 30-60 秒）——刚授权完的
   * status 查询若落在未同步的 colo，缓存读空；若据此报「未授权」，用户会
   * 看到「授权成功、返回刷新又掉了」的假象，并被诱导反复重新授权。
   * `last_refresh_time` 优先取缓存里的精确刷新时间；缓存没有时回退到
   * `policy.updated_at`（callback / signin 写 access_key 时都会刷新它）。
   */
  async credentialStatus(): Promise<{ valid: boolean; last_refresh_time: string | null }> {
    if (!this.policy.access_key) return { valid: false, last_refresh_time: null };
    const cached = await this.readCredential();
    const refreshedAt = cached?.refreshed_at
      ? new Date(cached.refreshed_at * 1000).toISOString()
      : this.policy.updated_at
        ? new Date(this.policy.updated_at).toISOString()
        : null;
    return { valid: true, last_refresh_time: refreshedAt };
  }

  /**
   * 通过 SharePoint 站点 URL 反查站点 ID，返回 `<siteId>/drive`。
   *
   * 对应原版 `onedrive/api.go:188 GetSiteIDByURL`：请求
   * `{graphBase}/sites/{hostname}:/{path}`，**不带 drive 资源段**。
   * 前端拿到这个串后会填进策略的 `settings.od_driver`。
   */
  async getSiteIdByUrl(siteUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(siteUrl);
    } catch {
      throw new Error(`Invalid site URL: ${siteUrl}`);
    }
    const relativePath = parsed.pathname.replace(/^\/+|\/+$/g, '');
    const api = `${this.graphBase}/sites/${encodeURIComponent(parsed.hostname)}:/${relativePath}`;

    const res = await this.request('GET', api);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to get site id: ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as { id?: string };
    if (!json.id) throw new Error('Site id is empty in Graph response');
    return `sites/${json.id}/drive`;
  }

  /** 生成授权 URL 时用的 redirect_uri 对应的前端路由（上游 `MasterPolicyOAuthCallback`）。 */
  static oauthCallbackPath = '/admin/policy/oauth';

  // -------------------------------------------------------------------------
  // 请求封装
  // -------------------------------------------------------------------------

  private url(api: string): string {
    return `${this.graphBase}/${this.driveResource}/${api}`;
  }

  /** 带鉴权与 429 重试的 Graph 请求。 */
  private async request(
    method: string,
    url: string,
    init?: { body?: BodyInit; headers?: Record<string, string>; noAuth?: boolean },
    retries = 2,
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(init?.headers ?? {}) };
    if (!init?.noAuth) {
      headers['Authorization'] = `Bearer ${await this.accessToken()}`;
    }
    if (init?.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, { method, headers, body: init?.body });

    // Graph 401：access token 被提前吊销（改密码 / 管理员重新授权等），
    // 强制换新后重试一次（对齐上游 ShouldRefresh → Refresh 的自愈行为）
    if (res.status === 401 && !init?.noAuth && retries > 0) {
      await this.forceRefresh();
      return this.request(method, url, init, retries - 1);
    }

    // 429 / 5xx 退避重试
    if ((res.status === 429 || res.status >= 500) && retries > 0) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(5, Math.max(1, retryAfter)) * 1000));
      return this.request(method, url, init, retries - 1);
    }
    return res;
  }

  // -------------------------------------------------------------------------
  // 存储操作
  // -------------------------------------------------------------------------

  async token(session: UploadSession, file: UploadRequest): Promise<UploadCredential> {
    const expires = Math.floor(session.expireAt / 1000);
    const behavior = file.overwrite ? 'replace' : 'fail';

    // 一律走 createUploadSession。原版 `onedrive/onedrive.go` 的上传流程就是这样：
    // 直接开上传会话把 uploadUrl 交给客户端，没有「小文件先简单 PUT 一次」这一步。
    const res = await this.request('POST', this.url(`root:/${graphPath(file.savePath)}:/createUploadSession`), {
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': behavior } }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to create OneDrive upload session: ${res.status} ${text.slice(0, 300)}`);
    }

    const json = (await res.json()) as { uploadUrl: string };
    session.uploadId = json.uploadUrl;

    return {
      session_id: session.id,
      chunk_size: this.chunkSize,
      expires,
      upload_urls: [json.uploadUrl],
      uploadID: json.uploadUrl,
    };
  }

  /**
   * 中转模式的写入。OneDrive 的正常路径是客户端直传，
   * 只有当客户端拿不到 uploadUrl 时才会走到这里：此时按分片顺序
   * 逐个 PUT 到 uploadUrl。
   */
  async writeChunk(
    session: UploadSession,
    index: number,
    body: ReadableStream,
    length: number,
  ): Promise<UploadedPart | null> {
    if (!session.uploadId) {
      throw new Error('OneDrive upload session is missing an uploadUrl');
    }
    const start = index * session.chunkSize;
    const end = start + length - 1;
    const res = await fetch(session.uploadId, {
      method: 'PUT',
      headers: {
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${session.size}`,
      },
      body,
      // @ts-expect-error Workers 运行时需要 duplex 才能流式发送请求体
      duplex: 'half',
    });
    if (!res.ok && res.status !== 202) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to upload OneDrive chunk: ${res.status} ${text.slice(0, 300)}`);
    }
    return null;
  }

  /** 直接使用 uploadUrl 作为「分片地址」，由服务端顺序推送（备用路径）。 */
  async completeUpload(session: UploadSession): Promise<void> {
    if (!session.uploadId) return;
    // createUploadSession 返回的 URL 本身就是上传入口，
    // 收尾在最后一个分片 PUT 完成时由微软侧自动完成，这里只需清掉状态。
    void session;
  }

  async cancelToken(session: UploadSession): Promise<void> {
    if (!session.uploadId) return;
    try {
      await fetch(session.uploadId, {
        method: 'DELETE',
        // 该 URL 自带凭据，不需要再带 Authorization
      });
    } catch {
      // ignore
    }
  }

  async put(file: UploadRequest, body: ReadableStream, contentLength: number): Promise<void> {
    const behavior = file.overwrite ? 'replace' : 'fail';
    if (contentLength <= SIMPLE_UPLOAD_LIMIT) {
      const res = await this.request(
        'PUT',
        this.url(`root:/${graphPath(file.savePath)}:/content`) +
          `?@microsoft.graph.conflictBehavior=${behavior}`,
        {
          body: body as unknown as BodyInit,
          headers: {
            'Content-Type': file.mimeType || 'application/octet-stream',
            'Content-Length': String(contentLength),
          },
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to upload to OneDrive: ${res.status} ${text.slice(0, 300)}`);
      }
      return;
    }
    // 大文件走上传会话后分片推送
    const sessionRes = await this.request(
      'POST',
      this.url(`root:/${graphPath(file.savePath)}:/createUploadSession`),
      { body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': behavior } }) },
    );
    if (!sessionRes.ok) {
      const text = await sessionRes.text().catch(() => '');
      throw new Error(`Failed to create OneDrive upload session: ${sessionRes.status} ${text.slice(0, 300)}`);
    }
    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl: string };
    const reader = body.getReader();
    let offset = 0;
    try {
      for (;;) {
        const chunk = await readAtMost(reader, this.chunkSize);
        if (chunk === null) break;
        const end = offset + chunk.byteLength - 1;
        const res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${offset}-${end}/${file.size}`,
          },
          body: chunk,
        });
        if (!res.ok && res.status !== 202) {
          const text = await res.text().catch(() => '');
          throw new Error(`Failed to upload OneDrive chunk: ${res.status} ${text.slice(0, 300)}`);
        }
        offset += chunk.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async delete(sources: string[]): Promise<string[]> {
    if (sources.length === 0) return [];
    const failed: string[] = [];

    for (let i = 0; i < sources.length; i += BATCH_SIZE) {
      const batch = sources.slice(i, i + BATCH_SIZE);
      // $batch 的 url 是相对 drive 资源的路径，需要转义
      const requests = batch.map((path, idx) => ({
        id: String(idx),
        method: 'DELETE',
        url: `/${this.driveResource}/root:/${graphPath(path)}`,
      }));

      const res = await this.request('POST', `${this.graphBase}/$batch`, {
        body: JSON.stringify({ requests }),
      });

      if (!res.ok) {
        failed.push(...batch);
        continue;
      }

      const json = (await res.json()) as {
        responses: { id: string; status: number }[];
      };
      for (const r of json.responses ?? []) {
        // 404 视为已删除
        if (r.status !== 204 && r.status !== 404) {
          const original = batch[Number(r.id)];
          if (original) failed.push(original);
        }
      }
    }

    return failed;
  }

  /** 取文件元信息（含 @microsoft.graph.downloadUrl）。 */
  private async fileInfo(path: string): Promise<{
    size: number;
    downloadUrl?: string;
  } | null> {
    const res = await this.request(
      'GET',
      `${this.url(`root:/${graphPath(path)}`)}?expand=thumbnails`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to get OneDrive file info: ${res.status} ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      size: number;
      '@microsoft.graph.downloadUrl'?: string;
    };
    return { size: json.size ?? 0, downloadUrl: json['@microsoft.graph.downloadUrl'] };
  }

  /**
   * 分页列举对象（导入任务用）。
   *
   * Graph 的 children 只按单目录列举，这里做惰性 BFS：把「待展开的子目录
   * 队列 + 当前目录的下一页链接」编进 continuation token（base64 JSON），
   * 调用方反复分页时逐层展开，最终语义与 S3 驱动的递归列举对齐。
   * 键格式与 `get()`/`meta()` 接受的 source 一致（相对路径，不含首尾斜杠）。
   */
  async list(
    prefix: string,
    options: { continuation?: string; afterKey?: string; limit?: number } = {},
  ): Promise<{ keys: { key: string; size: number; lastModified: Date }[]; continuation: string | null }> {
    const limit = Math.min(200, Math.max(1, options.limit ?? 200));
    const baseDir = prefix.replace(/^\/+|\/+$/g, '');

    // 恢复 BFS 状态
    let pending: string[] = [baseDir];
    let nextLink: string | null = null;
    if (options.continuation) {
      try {
        const state = JSON.parse(
          new TextDecoder().decode(base64ToBytes(options.continuation)),
        ) as { pending?: string[]; nextLink?: string | null };
        pending = Array.isArray(state.pending) ? state.pending : [];
        nextLink = state.nextLink ?? null;
      } catch {
        return { keys: [], continuation: null };
      }
      if (!pending.length && !nextLink) return { keys: [], continuation: null };
    }

    const keys: { key: string; size: number; lastModified: Date }[] = [];
    while (pending.length || nextLink) {
      const dir = pending[0] ?? '';
      const children =
        dir === ''
          ? `${this.url('root')}/children?`
          : `${this.url(`root:/${graphPath(dir)}`)}:/children?`;
      const pageUrl =
        nextLink ??
        `${children}$top=${limit}&$select=name,size,folder,lastModifiedDateTime`;

      const res = await this.request('GET', pageUrl);
      if (res.status === 404) {
        // 目录不存在（可能已被删除）：跳过该目录继续
        pending.shift();
        nextLink = null;
        if (!pending.length && !nextLink) break;
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Failed to list OneDrive objects: ${res.status} ${text.slice(0, 300)}`);
      }
      const json = (await res.json()) as {
        value?: { name: string; size?: number; folder?: unknown; lastModifiedDateTime?: string }[];
        '@odata.nextLink'?: string;
      };
      nextLink = json['@odata.nextLink'] ?? null;
      for (const item of json.value ?? []) {
        const key = dir ? `${dir}/${item.name}` : item.name;
        if (item.folder) {
          pending.push(key);
        } else {
          if (options.afterKey && key <= options.afterKey) continue;
          keys.push({
            key,
            size: item.size ?? 0,
            lastModified: item.lastModifiedDateTime ? new Date(item.lastModifiedDateTime) : new Date(),
          });
        }
      }
      if (!nextLink) pending.shift();
      if (keys.length >= limit) break;
    }

    const more = pending.length > 0 || nextLink !== null;
    return {
      keys,
      continuation: more
        ? bytesToBase64(new TextEncoder().encode(JSON.stringify({ pending, nextLink })))
        : null,
    };
  }

  async meta(source: string): Promise<{ size: number } | null> {
    const info = await this.fileInfo(source);
    return info ? { size: info.size } : null;
  }

  async get(source: string, range?: string | null): Promise<ObjectContent | null> {
    const info = await this.fileInfo(source);
    if (!info?.downloadUrl) return null;
    const res = await fetch(info.downloadUrl, {
      headers: range ? { Range: range } : undefined,
    });
    if (!res.ok && res.status !== 206) return null;
    return {
      body: res.body as ReadableStream,
      size: info.size,
      contentType: res.headers.get('Content-Type') ?? undefined,
      contentRange: res.headers.get('Content-Range'),
    };
  }

  async source(source: string, _args: GetSourceArgs): Promise<string> {
    // 原版实现即：取 @microsoft.graph.downloadUrl 直接返回（该链接自带短期凭据）
    const info = await this.fileInfo(source);
    if (!info?.downloadUrl) {
      throw new Error(`OneDrive object not found: ${source}`);
    }
    return info.downloadUrl;
  }

  async thumb(source: string, size: string): Promise<string | null> {
    const res = await this.request(
      'GET',
      this.url(`root:/${graphPath(source)}:/thumbnails/0/${size}`),
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { url?: string; value?: { url?: string }[] };
    return json.url ?? json.value?.[0]?.url ?? null;
  }
}

/**
 * 从 ReadableStream 读取至多 maxBytes，返回 Uint8Array；流已结束返回 null。
 * （避免把整个大文件读进内存）
 */
async function readAtMost(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  if (total === 0) return null;

  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
