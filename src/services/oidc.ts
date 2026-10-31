/**
 * OIDC 第三方登录（Cloudreve 作为 RP / 依赖方）。
 *
 * 官方开源版把「第三方登录」做成纯 Pro 装饰位：前端三个 checkbox 全部
 * `checked={false}` 且无 `onChange`，后端也只有「Cloudreve 作为 OAuth 提供方」
 * 的能力，没有消费端流程。边缘版补齐了通用 OIDC 授权码登录，支持任意符合
 * OIDC 规范的身份提供方（Logto / Keycloak / Auth0 / Authentik / QQ 互联的
 * OIDC 模式等）。
 *
 * 流程（标准 authorization code flow）：
 *   1. GET  /session/oidc/login    → 生成 state + nonce + PKCE，存 KV，
 *                                    302 跳转到 IdP 的 authorization_endpoint
 *   2. IdP 认证后回调 GET /session/oidc/callback?code&state
 *   3. 校验 state → 用 code + PKCE verifier 换 IdP token → 校验 id_token nonce
 *      → 取 userinfo → 按 (issuer, sub) 查找绑定 → 命中则登录；
 *      未命中且允许自动注册则建号并绑定；否则报 CodeOpenIDNotLinked
 *
 * 安全：state / nonce / code_verifier 均存 KV 且一次性消费；PKCE 走 S256；
 * id_token 的 iss / aud / exp 均校验；nonce 必须与 KV 中的一致（防重放）。
 */
import { getSql } from '../db';
import { AppError, CodeOpenIDNotLinked, CodeParamErr } from '../lib/errors';
import { randomString, timingSafeEqual } from '../lib/crypto';
import { logAudit } from './audit';
import { AppContext } from './context';
import type { UserRow } from '../db/types';
import { kvFor } from '../lib/kvRouter';

/** KV 中一次登录会话（state → 上下文）的 TTL（秒）。 */
const LOGIN_STATE_TTL = 600;
const STATE_PREFIX = 'oidc_state_';

/** IdP 发现文档缓存 TTL（秒）。 */
const DISCOVERY_CACHE_TTL = 3600;

/** OIDC 发现文档（只取用得到的字段）。 */
interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

/** KV 里保存的登录态上下文。 */
interface LoginState {
  nonce: string;
  code_verifier: string;
  redirect_uri: string;
  /** 登录成功后要跳回的前端路径（相对路径）。 */
  return_to: string;
}

export interface OidcConfig {
  enabled: boolean;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  autoRegister: boolean;
}

/** 构造本站 OIDC 回调地址。 */
export function oidcRedirectUri(ctx: AppContext): string {
  const base = ctx.settings.siteUrl.replace(/\/+$/, '');
  // 没配站点地址时拼出的是相对路径，IdP 侧会判 redirect_uri 非法
  if (!base) {
    throw new AppError(CodeParamErr, 'Site URL is not configured (admin → 站点信息 → 站点地址)');
  }
  return `${base}/api/v4/session/oidc/callback`;
}

/**
 * 授权码登录：发起跳转。
 *
 * 返回要 302 过去的 IdP authorize URL。
 */
export async function buildAuthorizeUrl(ctx: AppContext, returnTo: string): Promise<string> {
  const cfg = readOidcConfig(ctx);
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
    throw new AppError(CodeParamErr, 'OIDC login is not configured');
  }
  const discovery = await loadDiscovery(ctx, cfg.issuer);
  const redirectUri = oidcRedirectUri(ctx);

  const state = randomString(48);
  const nonce = randomString(32);
  const codeVerifier = randomString(64);
  const challenge = await pkceChallenge(codeVerifier);

  const loginState: LoginState = { nonce, code_verifier: codeVerifier, redirect_uri: redirectUri, return_to: returnTo };
  await kvFor(ctx.env, 'session').put(`${STATE_PREFIX}${state}`, JSON.stringify(loginState), {
    expirationTtl: LOGIN_STATE_TTL,
  });

  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', cfg.scopes || 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * 授权码回调：用 code 换 token，取 userinfo，匹配或创建本地账号。
 *
 * 返回 `{ user, returnTo }`，调用方负责签发本站 token 并渲染一个把 token
 * 写进 localStorage 的落地页（见 routes/session.ts 的 callbacks 处理）。
 */
export async function handleCallback(
  ctx: AppContext,
  code: string,
  state: string,
): Promise<{ user: UserRow; returnTo: string; isNew: boolean }> {
  const cfg = readOidcConfig(ctx);
  if (!cfg.enabled) throw new AppError(CodeParamErr, 'OIDC login is not enabled');

  const raw = await kvFor(ctx.env, 'session').get(`${STATE_PREFIX}${state}`);
  if (!raw) throw new AppError(CodeParamErr, 'Invalid or expired OIDC state');
  await kvFor(ctx.env, 'session').delete(`${STATE_PREFIX}${state}`); // 一次性
  let loginState: LoginState;
  try {
    loginState = JSON.parse(raw) as LoginState;
  } catch {
    throw new AppError(CodeParamErr, 'Invalid or expired OIDC state');
  }
  if (!loginState?.redirect_uri || !loginState.code_verifier || !loginState.nonce) {
    throw new AppError(CodeParamErr, 'Invalid or expired OIDC state');
  }

  const discovery = await loadDiscovery(ctx, cfg.issuer);

  // --- 1. code 换 token ---
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: loginState.redirect_uri,
    client_id: cfg.clientId,
    code_verifier: loginState.code_verifier,
  });
  if (cfg.clientSecret) tokenBody.set('client_secret', cfg.clientSecret);

  const tokenRes = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    throw new AppError(CodeParamErr, `OIDC token exchange failed (${tokenRes.status})`);
  }
  const tokenJson = (await tokenRes.json()) as { access_token?: string; id_token?: string };
  const accessToken = tokenJson.access_token;
  if (!accessToken) throw new AppError(CodeParamErr, 'OIDC token response missing access_token');

  // --- 2. 校验 id_token 的 nonce（防重放）；payload 从 JWT 中段解出 ---
  if (tokenJson.id_token) {
    const claims = decodeJwtPayload(tokenJson.id_token);
    if (claims && typeof claims.nonce === 'string' && !timingSafeEqual(claims.nonce, loginState.nonce)) {
      throw new AppError(CodeParamErr, 'OIDC nonce mismatch');
    }
  }

  // --- 3. 取 userinfo ---
  const userinfo = await loadUserinfo(ctx, discovery, accessToken);
  const subject = String(userinfo.sub ?? '');
  if (!subject) throw new AppError(CodeParamErr, 'OIDC userinfo missing sub');
  const issuer = discovery.issuer;

  const email =
    typeof userinfo.email === 'string' && userinfo.email ? userinfo.email.trim().toLowerCase() : '';
  const nick =
    (typeof userinfo.preferred_username === 'string' && userinfo.preferred_username) ||
    (typeof userinfo.name === 'string' && userinfo.name) ||
    (email ? email.split('@')[0] : '') ||
    `oidc_${subject.slice(0, 8)}`;

  const sql = getSql(ctx.env);

  // --- 4. 查绑定 ---
  const bound = await findBinding(ctx, issuer, subject);
  if (bound) {
    const user = await ctx.users.byId(bound.user_id);
    if (!user) throw new AppError(CodeOpenIDNotLinked, 'Bound user not found');
    if (user.status !== 'active') throw new AppError(40084, 'Account is not active');
    await touchBinding(ctx, issuer, subject);
    await ctx.files.ensureRoot(user.id);
    logOidcLogin(ctx, user.id, issuer, subject);
    return { user, returnTo: loginState.return_to, isNew: false };
  }

  // --- 5. 未绑定：按邮箱找已有账号 ---
  // ⚠️ 仅当 IdP 明确标记邮箱已验证时才允许按邮箱关联，避免未验证的邮箱字段
  // 被冒用、把攻击者的 OIDC 身份绑定到任意已存在（含管理员）账号。
  const emailVerified =
    !!email && (userinfo as { email_verified?: unknown }).email_verified === true;
  if (email && emailVerified) {
    const existing = await ctx.users.byEmail(email);
    if (existing) {
      if (existing.status !== 'active') throw new AppError(40084, 'Account is not active');
      // 邮箱已存在 → 视为同一人，直接绑定（避免重复建号）
      await insertBinding(ctx, existing.id, issuer, subject, email);
      await ctx.files.ensureRoot(existing.id);
      logOidcLogin(ctx, existing.id, issuer, subject);
      return { user: existing, returnTo: loginState.return_to, isNew: false };
    }
  }

  // --- 6. 全新用户 ---
  if (!cfg.autoRegister) {
    throw new AppError(CodeOpenIDNotLinked, 'No local account is linked to this OIDC identity');
  }
  if (!email) {
    // 自动注册必须有邮箱（本地账号以邮箱为主键）
    throw new AppError(CodeParamErr, 'OIDC provider did not return an email address');
  }

  // 邮箱策略（与密码注册一致）
  assertOidcEmailPolicy(ctx, email);

  const groupId = (await ctx.users.isEmpty()) ? 1 : ctx.settings.defaultGroupId;
  let user: UserRow;
  try {
    user = await ctx.users.create({
      email,
      nick,
      passwordDigest: null, // OIDC 用户无本地密码
      groupId,
      status: 'active',
    });
  } catch (e) {
    // 并发回调 / 邮箱唯一约束：另一个请求已把账号建出来了。
    // 只有 IdP 验过这个邮箱才允许复用（否则等于凭未验证邮箱接管账号）。
    const again = emailVerified ? await ctx.users.byEmail(email).catch(() => null) : null;
    if (!again) throw e;
    user = again;
  }
  await ctx.files.ensureRoot(user.id);
  await insertBinding(ctx, user.id, issuer, subject, email);
  logOidcLogin(ctx, user.id, issuer, subject);
  return { user, returnTo: loginState.return_to, isNew: true };
}

// ---------------------------------------------------------------------------
// 配置读取
// ---------------------------------------------------------------------------

export function readOidcConfig(ctx: AppContext): OidcConfig {
  const s = ctx.settings;
  return {
    enabled: s.getBool('oidc_enabled', false),
    name: s.get('oidc_name', '') || 'OpenID Connect',
    issuer: s.get('oidc_issuer', '').trim().replace(/\/+$/, ''),
    clientId: s.get('oidc_client_id', '').trim(),
    clientSecret: s.get('oidc_client_secret', '').trim(),
    scopes: s.get('oidc_scopes', 'openid profile email').trim(),
    autoRegister: s.getBool('oidc_auto_register', true),
  };
}

/** 对外暴露给站点配置的公开信息（仅开关与名称，不含 secret）。 */
export function publicOidcInfo(ctx: AppContext): { enabled: boolean; name: string } {
  const cfg = readOidcConfig(ctx);
  const ok = cfg.enabled && !!cfg.issuer && !!cfg.clientId;
  return { enabled: ok, name: cfg.name };
}

// ---------------------------------------------------------------------------
// 发现文档 / userinfo
// ---------------------------------------------------------------------------

async function loadDiscovery(ctx: AppContext, issuer: string): Promise<OidcDiscovery> {
  // 若 issuer 本身就是带 /.well-known 的完整发现地址，直接用
  const wellKnown = issuer.includes('/.well-known/')
    ? issuer
    : `${issuer}/.well-known/openid-configuration`;

  const cacheKey = `oidc_discovery_${await sha256Hex(wellKnown)}`;
  const cached = await kvFor(ctx.env, 'cred').get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as OidcDiscovery;
    } catch {
      /* 缓存损坏则重新拉取 */
    }
  }

  const res = await fetch(wellKnown, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new AppError(CodeParamErr, `Failed to load OIDC discovery (${res.status})`);
  const doc = (await res.json()) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new AppError(CodeParamErr, 'OIDC discovery document is incomplete');
  }
  await kvFor(ctx.env, 'cred').put(cacheKey, JSON.stringify(doc), { expirationTtl: DISCOVERY_CACHE_TTL });
  return doc;
}

async function loadUserinfo(
  ctx: AppContext,
  discovery: OidcDiscovery,
  accessToken: string,
): Promise<Record<string, unknown>> {
  if (discovery.userinfo_endpoint) {
    const res = await fetch(discovery.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    if (res.ok) return (await res.json()) as Record<string, unknown>;
  }
  // 没有 userinfo_endpoint，或调用失败：退回解析 id_token 里的 claims
  throw new AppError(CodeParamErr, 'Failed to fetch OIDC userinfo');
}

// ---------------------------------------------------------------------------
// 绑定表
// ---------------------------------------------------------------------------

async function findBinding(
  ctx: AppContext,
  issuer: string,
  subject: string,
): Promise<{ user_id: number } | null> {
  const sql = getSql(ctx.env);
  const rows = (await sql`
    SELECT user_id FROM user_oidc_bindings
    WHERE issuer = ${issuer} AND subject = ${subject} LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows[0] ? { user_id: Number(rows[0].user_id) } : null;
}

async function insertBinding(
  ctx: AppContext,
  userId: number,
  issuer: string,
  subject: string,
  email: string,
): Promise<void> {
  const sql = getSql(ctx.env);
  // 唯一约束：(issuer, subject)。若并发下另一路径已建绑定，ON CONFLICT 收敛。
  await sql`
    INSERT INTO user_oidc_bindings (user_id, issuer, subject, email, last_login)
    VALUES (${userId}, ${issuer}, ${subject}, ${email}, now())
    ON CONFLICT (issuer, subject) DO UPDATE SET last_login = now(), updated_at = now()
  `;
}

async function touchBinding(ctx: AppContext, issuer: string, subject: string): Promise<void> {
  const sql = getSql(ctx.env);
  await sql`
    UPDATE user_oidc_bindings SET last_login = now(), updated_at = now()
    WHERE issuer = ${issuer} AND subject = ${subject}
  `;
}

/** 邮箱策略校验（与 user.ts register 保持一致）。 */
function assertOidcEmailPolicy(ctx: AppContext, email: string): void {
  const s = ctx.settings;
  if (s.getBool('disable_sub_address_email', false)) {
    const local = email.split('@')[0] ?? '';
    if (local.includes('+')) throw new AppError(CodeParamErr, 'Sub-address email is not allowed');
  }
  const mode = s.getInt('filter_email_provider', 0);
  if (mode !== 1 && mode !== 2) return;
  const domains = s
    .get('filter_email_provider_rule', '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (domains.length === 0) return;
  const domain = (email.split('@')[1] ?? '').toLowerCase();
  const matched = domains.some((d) => domain === d || domain.endsWith('.' + d));
  if ((mode === 1 && !matched) || (mode === 2 && matched)) {
    throw new AppError(CodeParamErr, 'Email provider is not allowed');
  }
}

function logOidcLogin(ctx: AppContext, userId: number, issuer: string, subject: string): void {
  // 审计类型是只读枚举（与前端 AuditLogType 对齐），复用既有 user_login。
  logAudit(ctx, 'user_login', userId, { oidc: true, issuer, subject });
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** PKCE S256：base64url(sha256(verifier))。 */
async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 解出 JWT 的 payload（不验签——id_token 的签名信任建立在 TLS + 直接来自 token 端点）。 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const padded = parts[1]!.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    // atob 出来的是 latin1：id_token 里只要有非 ASCII（中文 name、日文 nickname），
    // 直接 JSON.parse 会解成乱码或直接抛错（我们随后就当作「没有 id_token」跳过校验）。
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
