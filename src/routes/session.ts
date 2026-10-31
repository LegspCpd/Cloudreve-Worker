/**
 * 会话路由。对应 Cloudreve v4 `routers/router.go` 的 session 分组。
 *
 *   POST   /api/v4/session/token           登录（开了 2FA 时回 203 + 会话 ID）
 *   POST   /api/v4/session/login           同上（官方桌面端 cloudreve/desktop 走这个路径）
 *   POST   /api/v4/session/token/2fa       用 TOTP 验证码完成登录
 *   POST   /api/v4/session/2fa            同上（官方桌面端走这个路径）
 *   POST   /api/v4/session/token/refresh   刷新
 *   DELETE /api/v4/session/token           注销
 *   GET    /api/v4/session/prepare         登录前置检查
 *   PUT    /api/v4/session/authn           Passkey 登录：生成断言选项
 *   POST   /api/v4/session/authn           Passkey 登录：验证断言、签发 token
 */
import { Hono } from 'hono';
import type { AppBindings, AppRequest } from '../middleware/app';
import { ctxOf } from '../middleware/app';
import { fail, ok, okWithCode } from '../lib/response';
import { UserService } from '../services/user';
import { PasskeyService } from '../services/passkey';
import { OAuthService } from '../services/oauth';
import { buildAuthorizeUrl, handleCallback, publicOidcInfo } from '../services/oidc';
import { AppError, CodeNotFullySuccess, CodeNotFound, CodeRateLimited, Err } from '../lib/errors';
import { verifyCaptcha } from './site';
import { RATE_LIMITS, clearRateLimit, clientIp, hitRateLimit } from '../lib/rateLimit';

export const sessionRoutes = new Hono<AppBindings>();

const handleLogin = async (c: AppRequest) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    captcha?: string;
    ticket?: string;
  };

  if (!body.email || !body.password) {
    return fail(c, Err.param('Email and password are required'));
  }
  if (body.password.length < 4 || body.password.length > 128) {
    return fail(c, Err.param('Password length must be between 4 and 128'));
  }

  // 暴力破解防护：邮箱维度拦「盯着一个账号打」，IP 维度拦「撞库扫一批账号」。
  // 这两个桶原来根本不存在 —— 密码最短 4 位 + 无锁定 + 无限速 = 在线爆破无门槛。
  const ip = clientIp(c);
  const byEmail = { ...RATE_LIMITS.loginByEmail, id: body.email.trim().toLowerCase() };
  const byIp = { ...RATE_LIMITS.loginByIp, id: ip };
  for (const bucket of [byEmail, byIp]) {
    const gate = await hitRateLimit(c.env, bucket);
    if (!gate.ok) {
      c.header('Retry-After', String(gate.retryAfter));
      return fail(c, new AppError(CodeRateLimited, `Too many login attempts, retry in ${gate.retryAfter}s`));
    }
  }

  // 登录验证码（站点开启时才校验）
  if (ctx.settings.loginCaptcha) {
    const passed = await verifyCaptcha(ctx, body.ticket, body.captcha);
    if (!passed) {
      return fail(c, new AppError(40026, 'CAPTCHA verification failed'));
    }
  }

  try {
    const result = await new UserService(ctx).login(body.email, body.password);
    // 开了两步验证：不发 token，回 203 + 会话 ID，让前端转去输验证码。
    // 前端 `SignIn.tsx:222-225` 认的是 `Code.Continue`（203），会话 ID 从 `data` 里取。
    if ('two_fa_session_id' in result) {
      return okWithCode(c, CodeNotFullySuccess, result.two_fa_session_id);
    }
    await clearRateLimit(c.env, byEmail);
    return ok(c, result);
  } catch (e) {
    return fail(c, e);
  }
};

sessionRoutes.post('/token', handleLogin);
// 官方桌面端（cloudreve/desktop）登录走 `/session/login`；加别名保证桌面客户端能登录，
// 否则 404 → 拿不到 token → Windows 资源管理器挂载失败。
sessionRoutes.post('/login', handleLogin);

sessionRoutes.post('/token/refresh', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string };
  if (!body.refresh_token) {
    return fail(c, Err.param('refresh_token is required'));
  }
  try {
    const token = await new UserService(ctx).refresh(body.refresh_token);
    return ok(c, token);
  } catch (e) {
    return fail(c, e);
  }
});

sessionRoutes.delete('/token', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { refresh_token?: string };
  try {
    if (body.refresh_token) {
      await new UserService(ctx).logout(body.refresh_token);
    }
    // 原版注销成功返回空字符串
    return ok(c, '');
  } catch (e) {
    return fail(c, e);
  }
});

sessionRoutes.get('/prepare', async (c) => {
  const ctx = ctxOf(c);
  const email = c.req.query('email');
  if (!email) {
    return fail(c, Err.param('email is required'));
  }
  // 用户不存在时按上游返回 404（login.go:258 "User not found"），
  // 不能吞掉 —— 前端对「查不到」和「无密码」的处理路径完全不同。
  const user = await ctx.users.byEmail(email);
  if (!user) {
    return fail(c, new AppError(CodeNotFound, 'User not found'));
  }
  return ok(c, {
      // 上游语义是「该用户**已注册过** passkey」（login.go:262，
      // len(Passkey) > 0），不是站点设置 authn_enabled —— 搞混了前端
      // 会在有密码的账号上误弹「无密码账号，请选择认证方式」。
      webauthn_enabled: (await ctx.passkeys.listByUser(user.id)).length > 0,
      password_enabled: Boolean(user.password),
    });
});

// ---------------------------------------------------------------------------
// 第三方登录（OIDC）。边缘版自建实现，服务编排见 `services/oidc.ts`。
// 与上面的 OAuth 提供方路径（Cloudreve 让别的 App 登录）方向相反 ——
// 这里是 Cloudreve 作为 RP 登录到外部 IdP。
// ---------------------------------------------------------------------------

/** OIDC 登录：生成 state/PKCE 后 302 跳转到 IdP。 */
sessionRoutes.get('/oidc/login', async (c) => {
  const ctx = ctxOf(c);
  // return_to 会被存进登录态并最终决定登录后跳去哪：必须是同源相对路径。
  // 拒绝 `//host`（协议相对）、绝对 URL 与 `javascript:` 等，防开放重定向。
  const rawRedirect = c.req.query('redirect') ?? '/home';
  const returnTo = rawRedirect.startsWith('/') && !rawRedirect.startsWith('//') ? rawRedirect : '/home';
  try {
    const url = await buildAuthorizeUrl(ctx, returnTo);
    return c.redirect(url, 302);
  } catch (e) {
    return fail(c, e);
  }
});

/** OIDC 回调（IdP → 本站）。JSON 形态：前端拿到 code/state 后调这里换 token。 */
sessionRoutes.post('/oidc/callback', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { code?: string; state?: string };
  if (!body.code || !body.state) {
    return fail(c, Err.param('code and state are required'));
  }
  try {
    const { user } = await handleCallback(ctx, body.code, body.state);
    // 与密码登录一致的返回形状：{ user, token }。审计已在 oidc.ts 写过，这里不重复。
    const result = await new UserService(ctx).completeLogin(user, false);
    return ok(c, result);
  } catch (e) {
    return fail(c, e);
  }
});

/**
 * IdP 直接回调到后端时（若管理员把 redirect_uri 配成后端地址），
 * 302 到前端回调页，由前端页面带着 code/state 调上面的 JSON 端点。
 */
sessionRoutes.get('/oidc/callback', async (c) => {
  const ctx = ctxOf(c);
  const code = c.req.query('code') ?? '';
  const state = c.req.query('state') ?? '';
  const err = c.req.query('error') ?? '';
  const base = ctx.settings.siteUrl.replace(/\/+$/, '');
  const target = new URL(`${base}/session/oidc/callback`);
  if (err) {
    target.searchParams.set('error', err);
  } else {
    target.searchParams.set('code', code);
    target.searchParams.set('state', state);
  }
  return c.redirect(target.toString(), 302);
});

/** 当前站点 OIDC 是否可用（登录页据此决定是否显示第三方登录按钮）。 */
sessionRoutes.get('/oidc/info', (c) => {
  const ctx = ctxOf(c);
  return ok(c, publicOidcInfo(ctx));
});

/**
 * 两步验证登录：用 TOTP 验证码 + 登录会话 ID 换 token。
 *
 * 对应上游 `service/user/login.go` 的 `OtpValidationService`（`routers/router.go`
 * 里挂在 `POST /session/token/2fa`）。会话是登录第一步（密码校验通过）签发的，
 * 校验通过后即失效。
 */
const handleLogin2FA = async (c: AppRequest) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { otp?: string; session_id?: string };
  if (!body.otp || !body.session_id) {
    return fail(c, Err.param('otp and session_id are required'));
  }
  const gate = await hitRateLimit(c.env, { ...RATE_LIMITS.twoFactor, id: body.session_id });
  if (!gate.ok) {
    c.header('Retry-After', String(gate.retryAfter));
    return fail(c, new AppError(CodeRateLimited, `Too many attempts, retry in ${gate.retryAfter}s`));
  }
  try {
    const result = await new UserService(ctx).login2FA(body.otp, body.session_id);
    return ok(c, result);
  } catch (e) {
    return fail(c, e);
  }
};

sessionRoutes.post('/token/2fa', handleLogin2FA);
// 桌面端 2FA 完成走 `/session/2fa`（对应上游 v4 的 `/session/token/2fa`）。
sessionRoutes.post('/2fa', handleLogin2FA);
/**
 * Passkey 登录：生成断言选项 / 校验断言并签发 token。
 * 对应上游 `session.Group("authn")`（router.go:349-367），
 * 受站点设置 `authn_enabled` 门控。会话编排见 `services/passkey.ts`。
 */
sessionRoutes.put('/authn', async (c) => {
  const ctx = ctxOf(c);
  const service = new PasskeyService(ctx, c.env, ctx.codec);
  try {
    return ok(c, await service.prepareLogin());
  } catch (e) {
    return fail(c, e);
  }
});

sessionRoutes.post('/authn', async (c) => {
  const ctx = ctxOf(c);
  const body = (await c.req.json().catch(() => ({}))) as { response?: string; session_id?: string };
  if (!body.response || !body.session_id) {
    return fail(c, Err.param('response and session_id are required'));
  }
  const service = new PasskeyService(ctx, c.env, ctx.codec);
  try {
    const user = await service.finishLogin({
      response: body.response,
      sessionID: body.session_id,
    });
    // 上游链路 FinishLoginAuthn → UserIssueToken，返回与密码登录相同的结构
    const result = await new UserService(ctx).issueToken(user);
    return ok(c, {
        user: await new UserService(ctx).buildUserResponse(user, true),
        token: result,
      });
  } catch (e) {
    return fail(c, e);
  }
});

// ---------------------------------------------------------------------------
// OAuth2 授权码流程。对应上游 `session.Group("oauth")`（router.go:321-347）。
// 服务编排见 `services/oauth.ts`。
// ---------------------------------------------------------------------------

/** 应用信息：授权同意页展示用。匿名可查（上游未挂 LoginRequired）。 */
sessionRoutes.get('/oauth/app/:app_id', async (c) => {
  const ctx = ctxOf(c);
  const service = new OAuthService(ctx, c.env);
  try {
    return ok(c, await service.getAppRegistration(c.req.param('app_id'), ctx.user?.id ?? null));
  } catch (e) {
    return fail(c, e);
  }
});

/** 用户同意 → 签发授权码；拒绝（`/deny`）→ 只回 `access_denied`。 */
async function handleConsent(c: AppRequest, deny: boolean): Promise<Response> {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const service = new OAuthService(ctx, c.env);
  try {
    const res = await service.consent(
      ctx.user,
      {
        client_id: String(body.client_id ?? ''),
        response_type: String(body.response_type ?? ''),
        redirect_uri: String(body.redirect_uri ?? ''),
        state: body.state === undefined ? undefined : String(body.state),
        scope: String(body.scope ?? ''),
        code_challenge: body.code_challenge === undefined ? undefined : String(body.code_challenge),
        code_challenge_method:
          body.code_challenge_method === undefined ? undefined : String(body.code_challenge_method),
      },
      { deny },
    );
    return ok(c, res);
  } catch (e) {
    return fail(c, e);
  }
}

sessionRoutes.post('/oauth/consent', (c) => handleConsent(c, false));
sessionRoutes.post('/oauth/consent/deny', (c) => handleConsent(c, true));

/** 授权码换 token。表单编码（OAuth2 规范）。 */
sessionRoutes.post('/oauth/token', async (c) => {
  const ctx = ctxOf(c);
  const service = new OAuthService(ctx, c.env);
  try {
    const form = await c.req.formData();
    const get = (k: string): string => String(form.get(k) ?? '');
    const res = await service.exchangeToken({
      client_id: get('client_id'),
      client_secret: get('client_secret'),
      grant_type: get('grant_type'),
      code: get('code'),
      code_verifier: form.has('code_verifier') ? get('code_verifier') : undefined,
      redirect_uri: form.has('redirect_uri') ? get('redirect_uri') : undefined,
    });
    return c.json(res as never);
  } catch (e) {
    return fail(c, e);
  }
});

/** OIDC userinfo。按 token scopes 决定返回字段。 */
sessionRoutes.get('/oauth/userinfo', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const service = new OAuthService(ctx, c.env);
  try {
    return ok(c, await service.userinfo(ctx.user, ctx.scopes));
  } catch (e) {
    return fail(c, e);
  }
});

/** 撤销对某应用的授权。 */
sessionRoutes.delete('/oauth/grant/:app_id', async (c) => {
  const ctx = ctxOf(c);
  if (!ctx.user) return fail(c, Err.loginRequired());
  const service = new OAuthService(ctx, c.env);
  try {
    await service.deleteGrant(ctx.user, c.req.param('app_id'));
    return ok(c);
  } catch (e) {
    return fail(c, e);
  }
});
