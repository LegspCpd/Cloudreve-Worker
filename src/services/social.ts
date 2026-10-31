/**
 * 社交登录（QQ 互联，Cloudreve 作为 RP / 依赖方）。
 *
 * 对应官方 Pro 的「QQ 互联登录」——开源版把这块做成纯装饰位（前端 checkbox 写死
 * checked={false} 且无 onChange）。边缘版补齐了完整的 OAuth2 授权码流程。
 *
 * QQ 互联与 OIDC 不同：它不是 OIDC，没有 id_token / discovery，返回的不是标准
 * userinfo，而是：
 *   - token 端点返回 access_token（带 fmt=json 时返回 JSON）
 *   - /oauth2.0/me 返回 openid / unionid（带 fmt=json 时返回 JSON）
 *   - /user/get_user_info 返回 nickname / 头像等（无 email）
 *
 * 因为没有 email，本地账号用合成邮箱 `qq_<openid>@<站点域名>` 落库，绑定关系以
 * (provider=qq, provider_user_id=openid) 为准。unionid 仅作兜底匹配（同一 QQ 用户
 * 在不同应用下 openid 不同但 unionid 相同）。
 *
 * 流程：
 *   1. GET  /session/qq/login     → 生成 state 存 KV，302 跳转到 QQ 授权页
 *   2. QQ 认证后回调 GET /session/qq/callback?code&state
 *      → 后端 302 到前端 /session/qq/callback（带上 code&state）
 *   3. 前端调 POST /session/qq/callback {code,state}
 *      → 校验 state → code 换 token → 取 openid → 取 userinfo
 *      → 按 (qq, openid) / unionid 查找绑定 → 命中则登录；
 *        未命中且允许自动注册则建号并绑定；否则报未关联。
 *
 * 安全：state 存 KV 且一次性消费（防 CSRF）；后端走 confidential client（用
 * client_secret 换 token），不需要 PKCE（QQ 互联授权码流程不支持 PKCE）。
 */
import { getSql } from '../db';
import { AppError, CodeOpenIDNotLinked, CodeParamErr } from '../lib/errors';
import { randomString } from '../lib/crypto';
import { logAudit } from './audit';
import { AppContext } from './context';
import type { UserRow } from '../db/types';
import { kvFor } from '../lib/kvRouter';
import { SocialBindingsRepo } from '../db/socialBindings';

/** KV 里一次登录会话的 TTL（秒）。 */
const LOGIN_STATE_TTL = 600;
const STATE_PREFIX = 'qq_state_';

/** QQ 互联各端点（固定，由腾讯提供）。 */
const QQ_AUTHORIZE = 'https://graph.qq.com/oauth2.0/authorize';
const QQ_TOKEN = 'https://graph.qq.com/oauth2.0/token';
const QQ_ME = 'https://graph.qq.com/oauth2.0/me';
const QQ_USERINFO = 'https://graph.qq.com/user/get_user_info';

/** KV 里保存的登录态上下文。 */
interface LoginState {
  redirect_uri: string;
  /** 登录成功后要跳回的前端路径（相对路径）。 */
  return_to: string;
}

export interface QqConfig {
  enabled: boolean;
  name: string;
  appId: string;
  appSecret: string;
  autoRegister: boolean;
  scope: string;
}

/** 构造本站 QQ 回调地址（需填进 QQ 互联后台的回调白名单）。 */
export function qqRedirectUri(ctx: AppContext): string {
  const base = ctx.settings.siteUrl.replace(/\/+$/, '');
  return `${base}/api/v4/session/qq/callback`;
}

/** 读取 QQ 互联配置。 */
export function readQqConfig(ctx: AppContext): QqConfig {
  const s = ctx.settings;
  return {
    enabled: s.getBool('qq_enabled', false),
    name: s.get('qq_name', '') || 'QQ',
    appId: s.get('qq_app_id', '').trim(),
    appSecret: s.get('qq_app_secret', '').trim(),
    autoRegister: s.getBool('qq_auto_register', true),
    scope: s.get('qq_scope', 'get_user_info').trim(),
  };
}

/** 对外暴露给站点配置的公开信息（仅开关与名称，不含 secret）。 */
export function publicQqInfo(ctx: AppContext): { enabled: boolean; name: string } {
  const cfg = readQqConfig(ctx);
  const ok = cfg.enabled && !!cfg.appId && !!cfg.appSecret;
  return { enabled: ok, name: cfg.name };
}

/**
 * 授权码登录：发起跳转。返回要 302 过去的 QQ 授权 URL。
 */
export async function buildQqAuthorizeUrl(ctx: AppContext, returnTo: string): Promise<string> {
  const cfg = readQqConfig(ctx);
  if (!cfg.enabled || !cfg.appId || !cfg.appSecret) {
    throw new AppError(CodeParamErr, 'QQ login is not configured');
  }
  const redirectUri = qqRedirectUri(ctx);
  const state = randomString(48);

  const loginState: LoginState = { redirect_uri: redirectUri, return_to: returnTo };
  await kvFor(ctx.env, 'session').put(`${STATE_PREFIX}${state}`, JSON.stringify(loginState), {
    expirationTtl: LOGIN_STATE_TTL,
  });

  const url = new URL(QQ_AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', cfg.scope || 'get_user_info');
  return url.toString();
}

/**
 * 授权码回调：用 code 换 token，取 openid / userinfo，匹配或创建本地账号。
 * 返回 { user, returnTo, isNew }，调用方负责签发本站 token。
 */
export async function handleQqCallback(
  ctx: AppContext,
  code: string,
  state: string,
): Promise<{ user: UserRow; returnTo: string; isNew: boolean }> {
  const cfg = readQqConfig(ctx);
  if (!cfg.enabled) throw new AppError(CodeParamErr, 'QQ login is not enabled');

  const raw = await kvFor(ctx.env, 'session').get(`${STATE_PREFIX}${state}`);
  if (!raw) throw new AppError(CodeParamErr, 'Invalid or expired QQ login state');
  await kvFor(ctx.env, 'session').delete(`${STATE_PREFIX}${state}`); // 一次性
  const loginState = JSON.parse(raw) as LoginState;

  // --- 1. code 换 access_token（带 fmt=json 让 QQ 返回 JSON 而非 querystring）---
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code,
    redirect_uri: loginState.redirect_uri,
    fmt: 'json',
  });
  const tokenRes = await fetch(`${QQ_TOKEN}?${tokenBody.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!tokenRes.ok) {
    throw new AppError(CodeParamErr, `QQ token exchange failed (${tokenRes.status})`);
  }
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
  };
  const accessToken = tokenJson.access_token;
  if (!accessToken) throw new AppError(CodeParamErr, 'QQ token response missing access_token');

  // --- 2. 取 openid / unionid ---
  const meRes = await fetch(`${QQ_ME}?access_token=${encodeURIComponent(accessToken)}&fmt=json`, {
    headers: { Accept: 'application/json' },
  });
  if (!meRes.ok) {
    throw new AppError(CodeParamErr, `QQ openid fetch failed (${meRes.status})`);
  }
  const meJson = (await meRes.json().catch(() => ({}))) as {
    openid?: string;
    unionid?: string;
    client_id?: string;
  };
  const openid = meJson.openid;
  if (!openid) throw new AppError(CodeParamErr, 'QQ openid missing');
  const unionid = meJson.unionid ?? null;

  // --- 3. 取用户资料（nickname / 头像）---
  let nickname = `qq_${openid.slice(0, 8)}`;
  let avatar: string | null = null;
  try {
    const infoRes = await fetch(
      `${QQ_USERINFO}?access_token=${encodeURIComponent(accessToken)}` +
        `&oauth_consumer_key=${encodeURIComponent(cfg.appId)}` +
        `&openid=${encodeURIComponent(openid)}`,
      { headers: { Accept: 'application/json' } },
    );
    if (infoRes.ok) {
      const info = (await infoRes.json().catch(() => ({}))) as {
        ret?: number;
        nickname?: string;
        figureurl_qq_1?: string;
        figureurl_1?: string;
        figureurl?: string;
      };
      if (info.ret === 0 || info.ret === undefined) {
        if (info.nickname) nickname = info.nickname;
        avatar =
          info.figureurl_qq_1 || info.figureurl_1 || info.figureurl || null;
      }
    }
  } catch {
    /* 资料拉取失败不致命：降级到默认昵称，仍可登录 */
  }

  const repo = new SocialBindingsRepo(ctx.env);

  // --- 4. 查绑定（openid 精确 → unionid 兜底）---
  const bound =
    (await repo.findByProviderUser('qq', openid)) ??
    (unionid ? await repo.findByUnion('qq', unionid) : null);
  if (bound) {
    const user = await ctx.users.byId(bound.userId);
    if (!user) throw new AppError(CodeOpenIDNotLinked, 'Bound user not found');
    if (user.status !== 'active') throw new AppError(40084, 'Account is not active');
    await repo.touch('qq', openid);
    await ctx.files.ensureRoot(user.id);
    logAudit(ctx, 'user_login', user.id, { provider: 'qq', openid });
    return { user, returnTo: loginState.return_to, isNew: false };
  }

  // --- 5. 未绑定：全新用户 ---
  if (!cfg.autoRegister) {
    throw new AppError(CodeOpenIDNotLinked, 'No local account is linked to this QQ identity');
  }

  // QQ 不返回 email：用合成邮箱落库（以 openid 保证唯一，domain 取站点域名）。
  const host = hostOf(ctx);
  const syntheticEmail = `qq_${openid}@${host}`;

  const groupId = (await ctx.users.isEmpty()) ? 1 : ctx.settings.defaultGroupId;
  const user = await ctx.users.create({
    email: syntheticEmail,
    nick: nickname,
    passwordDigest: null, // 社交登录用户无本地密码
    groupId,
    status: 'active',
  });
  if (avatar) {
    try {
      await ctx.users.updateProfile(user.id, { avatar });
    } catch {
      /* 头像写入失败不致命 */
    }
  }
  await ctx.files.ensureRoot(user.id);
  await repo.upsert({
    userId: user.id,
    provider: 'qq',
    providerUserId: openid,
    unionId: unionid,
    email: syntheticEmail,
    nickname,
  });
  logAudit(ctx, 'user_login', user.id, { provider: 'qq', openid, created: true });
  return { user, returnTo: loginState.return_to, isNew: true };
}

/** 从站点 URL 解析主机名，作为合成邮箱的域名。 */
function hostOf(ctx: AppContext): string {
  const raw = ctx.settings.siteUrl.replace(/\/+$/, '');
  if (!raw) return 'cloudreve.local';
  try {
    return new URL(raw).host;
  } catch {
    return 'cloudreve.local';
  }
}
