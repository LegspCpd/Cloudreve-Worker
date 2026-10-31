/**
 * OAuth2 授权码流程 + OIDC userinfo（用户侧）。
 *
 * 对应上游 `service/oauth/oauth.go` 与 `routers/router.go:321-347`：
 *
 *   GET    /api/v4/session/oauth/app/:app_id   应用信息（含已授权 scope，匿名可查）
 *   POST   /api/v4/session/oauth/consent       用户同意 → 签发授权码（KV，TTL 600）
 *   POST   /api/v4/session/oauth/token         授权码 + PKCE + secret 换 token（表单）
 *   GET    /api/v4/session/oauth/userinfo      OIDC userinfo（按 token scope 出字段）
 *   DELETE /api/v4/session/oauth/grant/:app_id 撤销授权
 *
 * 与上游一致的行为：scope 必须包含 openid 且为应用注册 scope 的子集；
 * redirect_uri 必须精确匹配注册表；授权码一次性；PKCE 只支持 S256。
 */
import type { Env } from '../env';
import { getSql, type Sql } from '../db';
import { AppError, CodeCredentialInvalid, CodeNoPermissionErr, CodeNotFound, CodeParamErr, CodeUserNotFound } from '../lib/errors';
import { validateScopes } from '../lib/jwt';
import { randomString, timingSafeEqual } from '../lib/crypto';
import { AppContext } from './context';
import type { UserRow, UserWithGroup } from '../db/types';
import { kvFor } from '../lib/kvRouter';

// 上游 inventory/types 的 scope 常量
const SCOPE_OPENID = 'openid';
const SCOPE_PROFILE = 'profile';
const SCOPE_EMAIL = 'email';
const SCOPE_OFFLINE_ACCESS = 'offline_access';

const AUTH_CODE_PREFIX = 'oauth_code_';
const AUTH_CODE_TTL = 600; // 秒，上游同款

/**
 * 自动注册门槛：只自动登记长得像 UUID 的 client_id。
 * 桌面端 / 移动端内置的都是 UUID 形态的 GUID；随机的垃圾 ID 大多不是 UUID，
 * 这道闸能把注册表垃圾量压到最低。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 拒绝危险的 redirect_uri：明文 http（非 localhost 回环）、javascript:/data:/file:
 * 等协议、以及 `//host` 协议相对 URL。授权码经 redirect 回传，发到明文 http 会被
 * 中间人截获，发到 javascript: 等则直接执行。
 *
 * 放行：同源相对路径（最安全）、https://、自定义协议（cloudreve:// 等）、localhost 回环。
 * ⚠️ 同源相对路径必须放行 —— 官方桌面/移动端用的就是 `/callback/desktop` 这种相对回调
 * （%2Fcallback%2Fdesktop）。注意 `new URL('/callback/desktop')` 因缺少 base 会抛异常，
 * 若直接拿它做校验会把官方客户端全挡掉（曾导致桌面端报「输入参数有误」）。
 *
 * 该函数只用于无法预登记白名单的 auto_provisioned 客户端（官方闭源端 URI 未知），
 * 作为「接受任意回调」之上的最小安全闸门；管理端登记客户端白名单时也用它兜住
 * 明显危险的 scheme（管理面板被 XSS 时少一条路）。
 */
export function assertSafeRedirectUri(uri: string): void {
  // 同源相对路径：永远跳不出本站，比任何绝对 URL 都安全。
  if (uri.startsWith('/') && !uri.startsWith('//')) return;
  // `//host/path` 协议相对：会跳到别的主机（且可能是明文 http），明确拒绝。
  if (uri.startsWith('//')) {
    throw new AppError(CodeParamErr, 'Protocol-relative redirect URI is not allowed');
  }
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new AppError(CodeParamErr, 'Invalid redirect URI');
  }
  const scheme = u.protocol;
  if (scheme === 'javascript:' || scheme === 'data:' || scheme === 'file:') {
    throw new AppError(CodeParamErr, 'Invalid redirect URI scheme');
  }
  if (scheme === 'http:') {
    const host = u.hostname;
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!isLocal) {
      throw new AppError(CodeParamErr, 'Plaintext http redirect URI is not allowed');
    }
  }
}

/**
 * 注册的回调地址与请求的是否匹配（RFC 8252 §7.3）。
 *
 * 原生客户端（CLI / 桌面）用 loopback 回调，监听端口是随机的，注册时只能写
 * `http://127.0.0.1/callback`。所以**只对 IP loopback 的 http 地址放宽端口**，
 * scheme / host / path / query 仍逐字节一致；其他情况一律精确匹配。
 * 对应上游 `service/oauth/redirect.go` 的 `redirectURIMatches`。
 */
function redirectURIMatches(registered: string, requested: string): boolean {
  if (!registered.startsWith('http://')) return registered === requested;
  // 片段会把授权码甩掉，两边带 # 都不认
  if (registered.includes('#') || requested.includes('#')) return false;

  // `http://127.0.0.1:/cb` 解析后与「完全不带端口」同形（host=127.0.0.1、
  // port=''），下面的归一化区分不出来，只能查原文。上游用
  // `strings.HasSuffix(host, ":")` 挡的就是这个：端口放宽只对「注册地址带具体
  // 端口或干脆不带」有意义，带个空冒号必须拒，否则任意端口都能匹配上。
  for (const raw of [registered, requested]) {
    const m = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(raw);
    if (m && m[1]!.endsWith(':')) return false;
  }

  let reg: URL;
  try {
    reg = new URL(registered);
  } catch {
    return false;
  }
  const host = reg.hostname;
  // 只认 IP 回环；localhost 属于「域名」，端口放宽会让劫持面变大，走精确匹配
  if (host !== '127.0.0.1' && host !== '[::1]') return registered === requested;

  let req: URL;
  try {
    req = new URL(requested);
  } catch {
    return false;
  }
  for (const u of [reg, req]) {
    if (u.protocol !== 'http:') return false;
    if (u.username || u.password) return false; // http://user@127.0.0.1/ 这类
  }
  const normalize = (u: URL): string => `${u.protocol}//${u.hostname}${u.pathname}${u.search}`;
  return normalize(reg) === normalize(req);
}

/** 自动注册的新客户端默认放开的 scope（私有部署策略：宽松）。 */
const AUTO_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'UserInfo.Read',
  'UserInfo.Write',
  'UserSecurityInfo.Read',
  'UserSecurityInfo.Write',
  'Workflow.Read',
  'Workflow.Write',
  'Files.Read',
  'Files.Write',
  'Shares.Read',
  'Shares.Write',
  'DavAccount.Read',
  'DavAccount.Write',
  'Finance.Read',
  'Finance.Write',
  'Admin.Read',
  'Admin.Write',
];

/**
 * 官方 Cloudreve CLI 的内置 OAuth 客户端。值必须与上游
 * `inventory/migration.go`（OAuthClientCLI*）逐字一致 —— CLI 把 GUID 和
 * secret 编进了二进制，改了就登不上。回调是 loopback，端口由 CLI 随机选，
 * 所以校验要靠 `redirectURIMatches` 放宽端口。
 */
const CLI_CLIENT_GUID = '6326d2af-2fef-4a99-94da-1ee8ef0ca53f';
const CLI_CLIENT_SECRET = 'yoFiNgbxvSCzK2Nm92T3TNaREh4qBjq4';
const CLI_CLIENT_REDIRECT = 'http://127.0.0.1/callback';
const CLI_CLIENT_SCOPES = [
  'profile',
  'email',
  'openid',
  'offline_access',
  'UserInfo.Write',
  'Workflow.Write',
  'Files.Write',
  'Shares.Write',
];

/** KV 里的授权码内容。 */
interface AuthorizationCode {
  client_id: string;
  user_id: number;
  scopes: string[];
  redirect_uri: string;
  code_challenge: string;
}

export interface AppRegistration {
  id: string;
  name: string;
  homepage_url?: string;
  icon?: string;
  description?: string;
  consented_scopes?: string[];
}

export interface OAuthClientRow {
  id: number;
  guid: string;
  secret: string;
  name: string;
  homepage_url: string;
  redirect_uris: string[];
  scopes: string[];
  props: Record<string, unknown>;
  is_enabled: boolean;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token_expires_in: number;
  refresh_token?: string;
  scope: string;
}

export class OAuthService {
  private sql: Sql;

  constructor(
    private readonly ctx: AppContext,
    env: Env,
  ) {
    this.sql = getSql(env);
  }

  /**
   * 未知客户端自动注册（私有部署策略）。
   *
   * 官方桌面端把内置 client_id 编进闭源二进制里，实例管理员无从预登记；
   * 上游的播种逻辑在闭源部分。边缘版的处理：带合法 UUID 形态 client_id 的
   * 首次连接自动建号（宽松 scope + 空 redirect 白名单 = 接受任意回调，
   * 含 cloudreve:// 自定义协议与 localhost 回环），管理员可随时在后台改/禁。
   */
  private async ensureAutoProvision(guid: string): Promise<void> {
    if (!UUID_RE.test(guid)) return;

    // 官方 Cloudreve CLI 内置了固定的 client_id / secret（上游
    // `inventory/migration.go` 的 migrateOAuthClientCLI），回调是 loopback +
    // 随机端口。这里按同一组值播种，否则 CLI 换 token 时 secret 对不上。
    if (guid === CLI_CLIENT_GUID) {
      await this.sql`
        INSERT INTO oauth_clients (guid, secret, name, homepage_url, redirect_uris, scopes, props, is_enabled)
        VALUES (${CLI_CLIENT_GUID}, ${CLI_CLIENT_SECRET}, ${'Cloudreve CLI'}, '',
                ${JSON.stringify([CLI_CLIENT_REDIRECT])}::jsonb,
                ${JSON.stringify(CLI_CLIENT_SCOPES)}::jsonb,
                ${JSON.stringify({ icon: '/static/img/cloudreve.svg', refresh_token_ttl: 7776000 })}::jsonb,
                true)
        ON CONFLICT (guid) DO NOTHING
      `;
      return;
    }

    await this.sql`
      INSERT INTO oauth_clients (guid, secret, name, homepage_url, redirect_uris, scopes, props, is_enabled)
      VALUES (${guid}, ${randomString(48)}, ${'Client ' + guid.slice(0, 8)}, '', '[]'::jsonb,
              ${JSON.stringify(AUTO_SCOPES)}::jsonb, ${JSON.stringify({ auto_provisioned: true })}::jsonb, true)
      ON CONFLICT (guid) DO NOTHING
    `;
  }

  private async clientByGUID(guid: string, autoProvision = false): Promise<OAuthClientRow | null> {
    if (autoProvision) await this.ensureAutoProvision(guid);
    const rows = (await this.sql`
      SELECT * FROM oauth_clients WHERE guid = ${guid} AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: Number(r.id),
      guid: String(r.guid),
      secret: String(r.secret ?? ''),
      name: String(r.name ?? ''),
      homepage_url: String(r.homepage_url ?? ''),
      redirect_uris: (r.redirect_uris as string[]) ?? [],
      scopes: (r.scopes as string[]) ?? [],
      props: (r.props as Record<string, unknown>) ?? {},
      is_enabled: r.is_enabled !== false,
    };
  }

  private async grantScopes(userId: number, clientId: number): Promise<string[] | null> {
    const rows = (await this.sql`
      SELECT scopes FROM oauth_grants
      WHERE user_id = ${userId} AND client_id = ${clientId} AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    return rows[0] ? ((rows[0].scopes as string[]) ?? []) : null;
  }

  /** 应用信息（授权同意页展示用）。未知客户端先走自动注册。 */
  async getAppRegistration(appGUID: string, userId: number | null): Promise<AppRegistration> {
    const app = await this.clientByGUID(appGUID, true);
    if (!app || !app.is_enabled) throw new AppError(CodeNotFound, 'App not found');
    const out: AppRegistration = {
      id: app.guid,
      name: app.name,
      ...(app.homepage_url ? { homepage_url: app.homepage_url } : {}),
      ...(typeof app.props.description === 'string' ? { description: app.props.description } : {}),
      ...(typeof app.props.icon === 'string' ? { icon: app.props.icon } : {}),
    };
    if (userId !== null) {
      const scopes = await this.grantScopes(userId, app.id);
      if (scopes) out.consented_scopes = scopes;
    }
    return out;
  }

  /** 用户同意：校验后落 grant、发授权码；拒绝时只回 error，不落 grant。 */
  async consent(
    user: UserWithGroup,
    args: {
      client_id: string;
      response_type: string;
      redirect_uri: string;
      state?: string;
      scope: string;
      code_challenge?: string;
      code_challenge_method?: string;
    },
    opts: { deny?: boolean } = {},
  ): Promise<{ code?: string; error?: string; state: string }> {
    if (args.response_type !== 'code') {
      throw new AppError(CodeParamErr, 'response_type must be "code"');
    }
    const app = await this.clientByGUID(args.client_id, true);
    if (!app || !app.is_enabled) throw new AppError(CodeNotFound, 'App not found');

    // 强制 PKCE（RFC 7636）：所有授权码流程必须携带 S256 挑战，否则授权码一旦在
    // redirect 链路泄露即可被冒用。Cloudreve v4 官方客户端（web / 桌面端）均发送
    // code_challenge，故此强制不破坏现有登录；旧的 / 非标准客户端若不发 PKCE 将被拒绝。
    if (!args.code_challenge) {
      throw new AppError(CodeParamErr, 'code_challenge is required (PKCE)');
    }
    const method = args.code_challenge_method || 'S256';
    if (method !== 'S256') {
      throw new AppError(CodeParamErr, 'Only S256 code_challenge_method is supported');
    }

    // redirect_uri 校验：
    // - 已登记白名单的客户端必须精确匹配（仅 IP loopback 放宽端口）；
    // - auto_provisioned 客户端（官方闭源端，URI 无法预登记）接受任意，但必须
    //   是安全 scheme（拒绝明文 http 非 localhost、javascript:/data: 等）；
    // - **白名单为空的手动客户端直接拒绝**：原来这里「保持原语义：不校验」，
    //   等于接受任意 redirect_uri —— 授权码会被发到攻击者站点（RFC 6749
    //   §3.1.2.2 要求 redirect_uri 必须预先注册）。
    if (app.redirect_uris.length > 0) {
      // 精确匹配，仅对 IP loopback 放宽端口（CLI/原生客户端回调端口随机）
      if (!app.redirect_uris.some((uri) => redirectURIMatches(uri, args.redirect_uri))) {
        throw new AppError(CodeParamErr, 'Invalid redirect URI');
      }
    } else if (app.props.auto_provisioned) {
      assertSafeRedirectUri(args.redirect_uri);
    } else {
      throw new AppError(
        CodeParamErr,
        'This client has no registered redirect URI; register one before authorizing',
      );
    }

    // 用户点了「拒绝」：按 OAuth2 §4.1.2.1 回 access_denied，
    // 不落 grant、不发码（对应上游 `POST /session/oauth/consent/deny`）。
    if (opts.deny) {
      return { error: 'access_denied', state: args.state ?? '' };
    }

    const requestedScopes = args.scope.split(' ').filter(Boolean);
    // 自动注册的客户端不做 scope 子集校验（桌面端请求的 scope 组合由闭源端定死）
    if (!app.props.auto_provisioned && !validateScopes(requestedScopes, app.scopes)) {
      throw new AppError(CodeParamErr, 'Invalid scope requested');
    }
    if (!requestedScopes.includes(SCOPE_OPENID)) {
      throw new AppError(CodeParamErr, 'openid scope required');
    }

    // Upsert grant：已授权则扩充 scope
    const existing = await this.grantScopes(user.id, app.id);
    const merged = Array.from(new Set([...(existing ?? []), ...requestedScopes]));
    if (existing) {
      await this.sql`
        UPDATE oauth_grants SET scopes = ${JSON.stringify(merged)}::jsonb, updated_at = now()
        WHERE user_id = ${user.id} AND client_id = ${app.id}
      `;
    } else {
      await this.sql`
        INSERT INTO oauth_grants (user_id, client_id, scopes)
        VALUES (${user.id}, ${app.id}, ${JSON.stringify(requestedScopes)}::jsonb)
      `;
    }

    const code = randomString(128);
    const authCode: AuthorizationCode = {
      client_id: args.client_id,
      user_id: user.id,
      scopes: requestedScopes,
      redirect_uri: args.redirect_uri,
      code_challenge: args.code_challenge ?? '',
    };
    await kvFor(this.ctx.env, 'session').put(`${AUTH_CODE_PREFIX}${code}`, JSON.stringify(authCode), {
      expirationTtl: AUTH_CODE_TTL,
    });

    return { code, state: args.state ?? '' };
  }

  /** 授权码换 token。表单编码请求。 */
  async exchangeToken(args: {
    client_id: string;
    client_secret: string;
    grant_type: string;
    code: string;
    code_verifier?: string;
    redirect_uri?: string;
  }): Promise<TokenResponse> {
    if (args.grant_type !== 'authorization_code') {
      throw new AppError(CodeParamErr, 'grant_type must be authorization_code');
    }

    const raw = await kvFor(this.ctx.env, 'session').get(`${AUTH_CODE_PREFIX}${args.code}`);
    if (!raw) throw new AppError(CodeCredentialInvalid, 'Invalid or expired authorization code');
    await kvFor(this.ctx.env, 'session').delete(`${AUTH_CODE_PREFIX}${args.code}`);
    const authCode = JSON.parse(raw) as AuthorizationCode;

    if (authCode.client_id !== args.client_id) {
      throw new AppError(CodeCredentialInvalid, 'Client ID mismatch');
    }

    // RFC 6749 §4.1.3：授权请求带过 redirect_uri，换 token 时也带就必须一致。
    // 不带则跳过（老客户端兼容），上游 9f1e0b8 同样只在传了时校验。
    if (args.redirect_uri !== undefined && args.redirect_uri !== authCode.redirect_uri) {
      throw new AppError(CodeCredentialInvalid, 'Redirect URI mismatch');
    }

    // PKCE（S256）：授权码必须带挑战，且 verifier 必须匹配（consent 已强制挑战，
    // 此处再兜底，杜绝任何未经 PKCE 保护的授权码被换走 token）。
    if (!authCode.code_challenge) {
      throw new AppError(CodeCredentialInvalid, 'Missing code challenge');
    }
    if (!args.code_verifier) {
      throw new AppError(CodeCredentialInvalid, 'Missing code verifier');
    }
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(args.code_verifier),
    );
    const expected = b64url(new Uint8Array(digest));
    if (!timingSafeEqual(expected, authCode.code_challenge)) {
      throw new AppError(CodeCredentialInvalid, 'Invalid code verifier');
    }

    const app = await this.clientByGUID(args.client_id);
    if (!app) throw new AppError(CodeNotFound, 'App not found');
    // 自动注册的客户端：secret 由闭源端定死无法预知，跳过校验；
    // 有 PKCE 挑战时仍强制验 verifier，安全性由 PKCE 保证。
    if (!app.props.auto_provisioned && !timingSafeEqual(app.secret, args.client_secret)) {
      throw new AppError(CodeCredentialInvalid, 'Invalid client secret');
    }
    if (!app.props.auto_provisioned && !validateScopes(authCode.scopes, app.scopes)) {
      throw new AppError(CodeParamErr, 'Invalid scope');
    }

    const user = await this.ctx.users.byId(authCode.user_id);
    if (!user || user.status !== 'active') throw new AppError(CodeUserNotFound, 'User not found');

    // 签发 token。refresh TTL 可被应用 props.refresh_token_ttl 覆盖
    const subject = this.ctx.codec.encodeUserID(user.id);
    const { hashUserState } = await import('../lib/jwt');
    const stateHash = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    const refreshTTLOverride = Number(app.props.refresh_token_ttl ?? 0);
    const token = await this.ctx.jwt.issue({
      subject,
      stateHash,
      accessTTLSeconds: this.ctx.settings.accessTokenTTL,
      refreshTTLSeconds:
        refreshTTLOverride > 0 ? refreshTTLOverride : this.ctx.settings.refreshTokenTTL,
      scopes: authCode.scopes,
      clientId: args.client_id,
    });

    await this.sql`
      UPDATE oauth_grants SET last_used_at = now(), updated_at = now()
      WHERE user_id = ${user.id} AND client_id = ${app.id}
    `;

    const expiresIn = Math.max(
      0,
      Math.floor((new Date(token.access_expires).getTime() - Date.now()) / 1000),
    );
    const refreshExpiresIn = Math.max(
      0,
      Math.floor((new Date(token.refresh_expires).getTime() - Date.now()) / 1000),
    );

    return {
      access_token: token.access_token,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token_expires_in: refreshExpiresIn,
      ...(authCode.scopes.includes(SCOPE_OFFLINE_ACCESS) ? { refresh_token: token.refresh_token } : {}),
      scope: authCode.scopes.join(' '),
    };
  }

  /** 撤销授权。 */
  async deleteGrant(user: UserRow, appGUID: string): Promise<void> {
    const app = await this.clientByGUID(appGUID);
    if (!app) throw new AppError(CodeNotFound, 'OAuth grant not found');
    const rows = (await this.sql`
      UPDATE oauth_grants SET deleted_at = now(), updated_at = now()
      WHERE user_id = ${user.id} AND client_id = ${app.id} AND deleted_at IS NULL
      RETURNING id
    `) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new AppError(CodeNotFound, 'OAuth grant not found');
  }

  /**
   * 当前用户已授权的应用列表（GET /user/setting 的 oauth_grants）。
   * 形状对齐上游 BuildOauthGrant（service/user/response.go:189）。
   */
  async listGrants(
    userId: number,
  ): Promise<
    Array<{ client_id: string; client_name: string; client_logo: string; scopes: string[]; last_used_at: string | null }>
  > {
    const rows = (await this.sql`
      SELECT c.guid, c.name, c.props, g.scopes, g.last_used_at
      FROM oauth_grants g
      JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.user_id = ${userId} AND g.deleted_at IS NULL AND c.deleted_at IS NULL
      ORDER BY g.last_used_at DESC NULLS LAST, g.created_at DESC
    `) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const props = (r.props as Record<string, unknown>) ?? {};
      const lastUsed = r.last_used_at ?? null;
      return {
        client_id: String(r.guid ?? ''),
        client_name: String(r.name ?? ''),
        client_logo: typeof props.icon === 'string' ? props.icon : '',
        scopes: (r.scopes as string[]) ?? [],
        last_used_at: lastUsed instanceof Date ? lastUsed.toISOString() : (lastUsed as string | null),
      };
    });
  }

  /**
   * OIDC userinfo。scopes 来自 token claims（appContext 中间件已解析）；
   * 内置登录 token 无 scopes 时视为全量放行（上游同款）。
   */
  async userinfo(user: UserRow, tokenScopes: string[] | undefined): Promise<Record<string, unknown>> {
    let scopes = tokenScopes;
    if (scopes) {
      if (!scopes.includes(SCOPE_OPENID)) {
        throw new AppError(CodeNoPermissionErr, 'openid scope required');
      }
    } else {
      scopes = [SCOPE_OPENID, SCOPE_PROFILE, SCOPE_EMAIL];
    }

    const sub = this.ctx.codec.encodeUserID(user.id);
    const out: Record<string, unknown> = { sub };
    for (const scope of scopes) {
      if (scope === SCOPE_PROFILE) {
        out.name = user.nick;
        out.preferred_username = user.nick;
        out.picture = `${this.ctx.settings.siteUrl.replace(/\/+$/, '')}/api/v4/user/avatar/${sub}`;
        out.updated_at = Math.floor(user.updated_at.getTime() / 1000);
      } else if (scope === SCOPE_EMAIL) {
        out.email = user.email;
        out.email_verified = true;
      }
    }
    return out;
  }
}

/** URL-safe base64 无填充。 */
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
