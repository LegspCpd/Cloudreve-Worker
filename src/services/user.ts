/**
 * 用户与认证服务。对应 Cloudreve v4 的 `service/user/` 目录。
 *
 * 认证契约（回源码核对）：
 *   - 登录响应 `{ user, token }`，token 是 `auth.Token`：
 *     `access_token` / `refresh_token` / `access_expires` / `refresh_expires`
 *     （注意**没有** expires_in，过期时间是 RFC3339 字符串）；
 *   - JWT 为 HS256，claims 里 `sub` 是 hashid 用户 ID；
 *   - 注销把 refresh token 的 `root_token_id` 写进 KV 吊销名单（前缀 `jwt_revoke_`）。
 */
import { AppContext } from './context';
import { logAudit } from './audit';
import { warmUserCache } from './userCache';
import type { GroupRow, UserRow, UserWithGroup } from '../db/types';
import { BooleanSet, FileType, GroupPermission } from '../lib/boolset';
import {
  AppError,
  Code2FACodeErr,
  CodeEmailExisted,
  CodeIncorrectPassword,
  CodeInternalSetting,
  CodeInvalidPassword,
  CodeNotFound,
  CodeNotFullySuccess,
  CodeNotSet,
  CodeParamErr,
  CodeTempLinkExpired,
  CodeUserBaned,
  CodeUserCannotActivate,
  CodeUserNotActivated,
  Err,
} from '../lib/errors';
import { checkPassword, digestPassword } from '../lib/crypto';
import { hashUserState, RevokeTokenPrefix, type Claims } from '../lib/jwt';
import { randomString } from '../lib/crypto';
import { generateTotpSecret, validateTotp } from '../lib/totp';
import { MailService } from './mail';
import { kvFor } from '../lib/kvRouter';

/**
 * 两步验证会话的有效期（秒）。
 *
 * 两处都取自上游：`service/user/login.go:148` 与 `service/user/setting.go:46`
 * 都是 600 秒，改其中一个不改另一个会让「登录到一半过期」变得难以解释。
 */
const TWO_FA_SESSION_TTL = 600;

export interface UserResponse {
  id: string;
  email?: string;
  nickname: string;
  status?: string;
  avatar?: string;
  created_at: string;
  preferred_theme?: string;
  anonymous?: boolean;
  group?: {
    id: string;
    name: string;
    permission?: string;
    direct_link_batch_size?: number;
    trash_retention?: number;
  };
  pined?: { uri: string; name?: string }[];
  language?: string;
  disable_view_sync?: boolean;
  share_links_in_profile?: string;
}

export interface LoginResult {
  user: UserResponse;
  token: {
    access_token: string;
    refresh_token: string;
    access_expires: string;
    refresh_expires: string;
  };
}

/**
 * 登录结果。
 *
 * 开了两步验证的账号，密码校验通过后**不发 token**，而是回一个 2FA 会话 ID
 * （上游 `service/user/login.go:146-150`），客户端再拿 TOTP 验证码 + 这个
 * session_id 调 `POST /session/token/2fa` 换 token。
 */
export type LoginOutcome = LoginResult | { two_fa_session_id: string };

/**
 * 注册结果。三种终态对应上游 `service/user/register.go:33-89` 的三个分支：
 *   - `ok`              → 200 + 用户对象
 *   - `needActivation`  → 203（`CodeNotFullySuccess`），激活邮件已发出
 *   - `resent`          → 400（`CodeEmailSent`），邮箱已存在但未激活，重发了激活邮件
 */
export type RegisterOutcome =
  | { kind: 'ok'; user: UserResponse }
  | { kind: 'needActivation' }
  | { kind: 'resent'; msg: string };

/** 密码重置会话在 KV 里的键前缀。取自上游 `service/user/login.go:79`。 */
export const UserResetPrefix = 'user_reset_';

/** 激活链接有效期 24 小时（上游 `register.go:94`）。 */
const ACTIVATION_TTL_SECONDS = 86400;

/** 重置链接有效期 1 小时（上游 `login.go:100`）。 */
const RESET_TTL_SECONDS = 3600;

export class UserService {
  constructor(private readonly ctx: AppContext) {}

  // -------------------------------------------------------------------------
  // 响应构造
  // -------------------------------------------------------------------------

  /**
   * 构造用户响应。
   * @param self 是否本人视角（本人可见 email 与私有设置）
   * @param group 调用方手里已有的组行（ctx.user / byEmailWithGroup / 刚查过）
   *              —— 传入可免掉这次 groups 查询；/me、/config、登录响应都是
   *              每请求必走的热路径，这一下省的是 ~200-500ms 的串行往返。
   * @param opts.exposeEmail 非本人视角下是否暴露 email —— 只对已登录查看者生效，
   *              且受站点设置 `expose_user_email` 控制（上游 4.17 新增的开关）。
   */
  async buildUserResponse(
    user: UserRow,
    self: boolean,
    group?: GroupRow | null,
    opts: { exposeEmail?: boolean } = {},
  ): Promise<UserResponse> {
    const g = group !== undefined ? group : await this.ctx.groups.byId(user.group_users);
    const settings = user.settings ?? {};

    const res: UserResponse = {
      id: this.ctx.codec.encodeUserID(user.id),
      nickname: user.nick,
      created_at: user.created_at.toISOString(),
    };

    if (self) {
      res.email = user.email;
      res.status = user.status;
      res.preferred_theme = settings.preferred_theme;
      res.pined = settings.pined;
      res.language = settings.email_language;
      res.disable_view_sync = settings.disable_view_sync;
      res.share_links_in_profile = settings.share_links_in_profile;
    } else if (opts.exposeEmail) {
      res.email = user.email;
    }

    if (user.avatar) {
      res.avatar = user.avatar;
    }

    if (g) {
      const perms = g.permissions instanceof Uint8Array
        ? new BooleanSet(g.permissions)
        : BooleanSet.fromBase64(g.permissions as unknown as string);
      res.group = {
        id: this.ctx.codec.encodeGroupID(g.id),
        name: g.name,
        permission: perms.toBase64(),
        // 对应原版 BuildGroup：DirectLinkBatchSize 取 group.Settings.SourceBatchSize，
        // TrashRetention 取 group.Settings.TrashRetention（都是组级配置，不是站点设置）
        direct_link_batch_size: g.settings?.source_batch,
        trash_retention: g.settings?.trash_retention,
      };
    }

    return res;
  }

  /** 匿名用户（未登录访问站点配置时用）。 */
  anonymousUserResponse(): UserResponse {
    return {
      id: '',
      nickname: '',
      created_at: new Date().toISOString(),
      anonymous: true,
    };
  }

  // -------------------------------------------------------------------------
  // 登录
  // -------------------------------------------------------------------------

  async login(email: string, password: string): Promise<LoginOutcome> {
    const user = await this.ctx.users.byEmailWithGroup(email);
    if (!user) {
      logAudit(this.ctx, 'user_login_failed', null, { email });
      throw new AppError(CodeInvalidPassword, 'Incorrect password or email address');
    }
    const pwCheck = await checkPassword(user.password, password);
    if (!pwCheck.ok) {
      logAudit(this.ctx, 'user_login_failed', user.id, { email });
      throw new AppError(CodeInvalidPassword, 'Incorrect password or email address');
    }
    // v2 老密码惰性升级为 v4 安全格式（仅当命中 md5 老格式时附带）。
    // 内存行必须同步新摘要：issueToken 的 state_hash 与下面写入缓存的行都
    // 依赖它，否则「刚升级完就签发的 refresh token」在刷新时会因 state
    // 不匹配而被误判失效。
    if (pwCheck.upgradeToV4) {
      await this.ctx.users.updatePassword(user.id, pwCheck.upgradeToV4);
      user.password = pwCheck.upgradeToV4;
    }
    if (user.status === 'manual_banned' || user.status === 'sys_banned') {
      throw new AppError(CodeUserBaned, 'This account has been blocked');
    }
    if (user.status === 'inactive') {
      throw new AppError(CodeUserNotActivated, 'This account is not activated');
    }

    // 两步验证：密码对了还不算登录成功，先发一个一次性会话，等 TOTP 验证码。
    // 对应上游 `service/user/login.go:146-150`：KV `user_2fa_{uuid}` -> 用户 ID。
    if (user.two_factor_secret) {
      const sessionId = crypto.randomUUID();
      await kvFor(this.ctx.env, 'session').put(`user_2fa_${sessionId}`, String(user.id), {
        expirationTtl: TWO_FA_SESSION_TTL,
      });
      return { two_fa_session_id: sessionId };
    }

    // 确保根目录存在；登录成功即预热 KV 用户缓存 —— 手里已有完整
    // UserWithGroup，只多花一次 KV 写（0 次 DB 查询），用户登录后的首批
    // 请求（/user/me、/file/list…）直接命中缓存，不再回源。两个操作互不
    // 依赖，并行发出。
    await Promise.all([
      this.ctx.files.ensureRoot(user.id),
      warmUserCache(this.ctx.env, user),
    ]);

    logAudit(this.ctx, 'user_login', user.id);
    const token = await this.issueToken(user);
    return {
      user: await this.buildUserResponse(user, true, user.group),
      token,
    };
  }

  // -------------------------------------------------------------------------
  // 两步验证（TOTP，RFC 6238）
  // -------------------------------------------------------------------------

  /**
   * 初始化两步验证：生成 TOTP 密钥并暂存，等用户拿验证码确认后才写进账号。
   *
   * 对应上游 `service/user/setting.go:33-51`：密钥存 KV `2fa_init_{uid}`、
   * TTL 600 秒，返回 `key.Secret()`（base32 无填充）—— 前端直接把它拼进
   * `otpauth://` 生成二维码，所以这里返回的就是密钥原文，不做任何加工。
   */
  async init2FA(): Promise<string> {
    const user = this.ctx.requireUser();
    const secret = generateTotpSecret();
    await kvFor(this.ctx.env, 'session').put(`2fa_init_${user.id}`, secret, {
      expirationTtl: TWO_FA_SESSION_TTL,
    });
    return secret;
  }

  /**
   * 用 TOTP 验证码完成登录。对应上游 `service/user/login.go:219-244`。
   *
   * 上游在校验通过后立刻删掉会话（`login.go:242`），一个 session 只能换一次 token，
   * 验证码输错不消耗会话（会话还在，可以重试）。
   */
  async login2FA(otp: string, sessionId: string): Promise<LoginResult> {
    const raw = await kvFor(this.ctx.env, 'session').get(`user_2fa_${sessionId}`);
    if (!raw) throw new AppError(CodeNotFound, 'Session not found');

    const uid = Number(raw);
    if (!Number.isFinite(uid)) throw new AppError(CodeNotFound, 'Session not found');

    const user = await this.ctx.users.byId(uid);
    if (!user) throw new AppError(CodeNotFound, 'User not found');

    if (user.two_factor_secret && !(await validateTotp(otp, user.two_factor_secret))) {
      logAudit(this.ctx, 'user_login_failed', uid, { reason: '2fa' });
      throw new AppError(Code2FACodeErr, 'Incorrect 2FA code');
    }

    await kvFor(this.ctx.env, 'session').delete(`user_2fa_${sessionId}`);

    return this.completeLogin(user);
  }

  /**
   * 完成登录：确保根目录存在、写审计、签发 token 并构造用户响应。
   *
   * 供 2FA 与 OIDC 登录复用。注意：OIDC 路径已在 `services/oidc.ts` 里写过
   * 一次 user_login 审计，这里的重复写入会造成两条记录，因此由调用方按需
   * 传 `logAudit: false`（OIDC 路径如此处理）。
   */
  async completeLogin(
    user: UserRow,
    logAuditEvent = true,
    /** 调用方手里已有的组行（如 login 走 byEmailWithGroup）——传入可省一次查询。 */
    preloadedGroup?: GroupRow | null,
  ): Promise<LoginResult> {
    // 组查询与 ensureRoot 互不依赖 —— 一次并行拿完（省 1 次串行往返）；
    // 拿到组行顺手预热 KV 用户缓存（登录后首屏直接命中，见 login 内注释）。
    const [group] = await Promise.all([
      preloadedGroup !== undefined
        ? Promise.resolve(preloadedGroup)
        : this.ctx.groups.byId(user.group_users),
      this.ctx.files.ensureRoot(user.id),
    ]);
    if (group) await warmUserCache(this.ctx.env, { ...user, group });
    if (logAuditEvent) logAudit(this.ctx, 'user_login', user.id);
    const token = await this.issueToken(user);
    return { user: await this.buildUserResponse(user, true, group), token };
  }

  /** 写入 / 清除 TOTP 密钥。传 null 表示关闭两步验证。 */
  async setTwoFactorSecret(secret: string | null): Promise<void> {
    const user = this.ctx.requireUser();
    await this.ctx.users.setTwoFactorSecret(user.id, secret);
    logAudit(this.ctx, secret ? 'enable_2fa' : 'disable_2fa', user.id);
  }

  /** 签发 token 对。 */
  async issueToken(user: UserRow, rootTokenId?: string): Promise<LoginResult['token']> {
    const subject = this.ctx.codec.encodeUserID(user.id);
    const stateHash = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    return this.ctx.jwt.issue({
      subject,
      stateHash,
      accessTTLSeconds: this.ctx.settings.accessTokenTTL,
      refreshTTLSeconds: this.ctx.settings.refreshTokenTTL,
      rootTokenId,
    });
  }

  // -------------------------------------------------------------------------
  // 刷新 / 注销
  // -------------------------------------------------------------------------

  async refresh(refreshToken: string): Promise<LoginResult['token']> {
    const claims = await this.ctx.jwt.verify(refreshToken);
    if (!claims || claims.token_type !== 'refresh') {
      throw new AppError(40020, 'Invalid refresh token');
    }
    const uid = this.ctx.codec.decodeUserID(claims.sub);
    if (uid === null) throw Err.userNotFound();

    const user = await this.ctx.users.byId(uid);
    if (!user || user.status !== 'active') throw Err.userNotFound();

    // 密码变更后旧 refresh token 失效
    const expected = await hashUserState(user.email, user.password ?? '', this.ctx.settings.siteId);
    if (!claims.state_hash) throw new AppError(40020, 'Invalid refresh token');
    const { stateHashEquals } = await import('../lib/jwt');
    if (!stateHashEquals(claims, expected)) {
      throw new AppError(40020, 'Invalid refresh token');
    }

    // 会话被吊销
    if (!claims.root_token_id) throw new AppError(40020, 'Invalid refresh token');
    const revoked = await kvFor(this.ctx.env, 'session').get(`${RevokeTokenPrefix}${claims.root_token_id}`);
    if (revoked) throw new AppError(40020, 'Invalid refresh token');

    return this.issueToken(user, claims.root_token_id);
  }

  /** 注销：把 root token 加入吊销名单。 */
  async logout(refreshToken: string): Promise<void> {
    const claims: Claims | null = await this.ctx.jwt.verify(refreshToken);
    if (!claims?.root_token_id) return;

    // TTL 覆盖 refresh token 的剩余有效期即可
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, (claims.exp ?? now + 3600) - now);
    await kvFor(this.ctx.env, 'session').put(`${RevokeTokenPrefix}${claims.root_token_id}`, '1', {
      expirationTtl: ttl,
    });
  }

  // -------------------------------------------------------------------------
  // 注册
  // -------------------------------------------------------------------------

  /** 邮件服务。 */
  get mail(): MailService {
    return new MailService(this.ctx);
  }

  /**
   * 注册邮箱策略校验（官方 Pro 功能，边缘版补齐）。
   *
   * - `disable_sub_address_email`：开启后拒绝含 `+` 的子地址邮箱，
   *   避免 `a@x.com` 与 `a+1@x.com` 被当成两个账号刷注册。
   * - `filter_email_provider`：0=不启用；1=白名单（仅允许列表内域名）；
   *   2=黑名单（拒绝列表内域名）。规则为逗号分隔的域名，忽略大小写。
   */
  private assertEmailPolicy(email: string): void {
    const s = this.ctx.settings;
    if (s.getBool('disable_sub_address_email', false)) {
      const local = email.split('@')[0] ?? '';
      if (local.includes('+')) {
        throw new AppError(CodeParamErr, 'Sub-address email is not allowed');
      }
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
    if (mode === 1 && !matched) {
      throw new AppError(CodeParamErr, 'Email provider is not allowed');
    }
    if (mode === 2 && matched) {
      throw new AppError(CodeParamErr, 'Email provider is not allowed');
    }
  }

  /**
   * 注册。对应上游 `service/user/register.go:33 Register`。
   *
   * 上游把「邮箱已存在」拆成两种情况（`inventory/user.go:367-374`）：
   *   - 已存在的账号**处于未激活状态** → `ErrInactiveUserExisted`，重发激活邮件，
   *     返回 `CodeEmailSent`（40033）。用户没收到第一封邮件时只能靠这条路自救，
   *     所以不能简单当成「邮箱已被占用」拒掉。
   *   - 其余 → `CodeEmailExisted`（40032）。
   */
  async register(email: string, password: string, language?: string): Promise<RegisterOutcome> {
    if (!this.ctx.settings.registerEnabled) {
      throw new AppError(40019, 'Registration is not enabled');
    }

    // 上游 `register.go:39` 把邮箱统一转小写后再落库
    const normalized = email.trim().toLowerCase();

    // 注册邮箱策略（官方 Pro 功能，边缘版补齐）：
    //   1) 禁用子地址邮箱：拒绝 `user+tag@example.com` 形态，防同一邮箱无限注册。
    //   2) 邮箱域过滤：按白名单 / 黑名单校验域名。
    this.assertEmailPolicy(normalized);

    const needActivation = this.ctx.settings.emailActive;

    // 「邮箱已占用」与「站点是否还没有用户」两条只读查询互不依赖 ——
    // 并行发出（注册新号时两条都会用到；撞已有邮箱时后者浪费一次，可接受）。
    const [existing, siteEmpty] = await Promise.all([
      this.ctx.users.byEmail(normalized),
      this.ctx.users.isEmpty(),
    ]);
    if (existing) {
      if (existing.status === 'inactive') {
        await this.sendActivationEmail(existing);
        return { kind: 'resent', msg: 'User is not activated, activation email has been resent' };
      }
      throw new AppError(CodeEmailExisted, 'This email has already been used');
    }

    const digest = await digestPassword(password);

    // 第一个注册的用户进管理员组。原版靠 CLI seed 建管理员账号；边缘版的
    // 部署路径是「云端一键部署、不碰本机」，没有机会预设密码，所以采用
    // 「先到先得」。
    //
    // ⚠️ 不能直接 `groupId = siteEmpty ? 1 : default`：`isEmpty()` 与 `create()`
    // 之间没有原子性，两个并发注册都会看到「站点为空」，结果**产生两个管理员**
    // （越权面的直接来源）。改成：一律按默认组建号，然后用 site_state 的主键
    // 做栅栏原子抢占名额，抢到再提升。抢不到就永远是普通用户。
    // Admin 组 id = 1（seed 与上游 application/migrator 的约定一致）。
    const groupId = this.ctx.settings.defaultGroupId;

    const user = await this.ctx.users.create({
      email: normalized,
      nick: normalized.split('@')[0] ?? normalized,
      passwordDigest: digest,
      groupId,
      status: needActivation ? 'inactive' : 'active',
      language,
    });

    // 站点为空只是快路径：非空时连这条 INSERT 都不发。抢到名额才提升为管理员。
    let effectiveGroupId = groupId;
    if (siteEmpty) {
      let claimed = false;
      try {
        claimed = await this.ctx.users.claimFirstAdmin(normalized);
      } catch (e) {
        // 栅栏表还没建出来（自举标记没跟上）时，不能让注册整个挂掉。
        // 退回旧行为：站点为空就够了 —— 有极小概率出两个管理员，可接受；
        // 总比「新部署第一次注册直接 500」要好。
        console.error('claimFirstAdmin failed, falling back to siteEmpty', e);
        claimed = true;
      }
      if (claimed) {
        await this.ctx.users.updateGroup(user.id, 1);
        user.group_users = 1;
        effectiveGroupId = 1;
      }
    }

    // 根目录与组行互不依赖 —— 并行一次往返拿完。组行用于构造响应，也用于
    // 把新用户的完整数据预热进 KV：注册一完成，用户登录后的首批请求
    // （/user/me、容量、文件列表）就直接命中缓存，不必回源 users JOIN groups。
    const [, group] = await Promise.all([
      this.ctx.files.ensureRoot(user.id),
      this.ctx.groups.byId(effectiveGroupId),
    ]);

    // 新用户初始文件夹（官方 Pro「新用户初始文件」的文件夹部分）：注册后在
    // 根目录建一批默认文件夹。失败不阻断注册 —— 最坏情况是新用户少了默认文件夹。
    await this.seedInitialFolders(user.id);

    logAudit(this.ctx, 'user_signup', user.id, { email: normalized });
    if (needActivation) {
      // 上游 `register.go:82-85`：发信失败时返回 `CodeNotSet` + 空 msg
      // （用户行已经落库了，所以再注册一次会走到上面的「重发」分支）
      await this.sendActivationEmail(user);
      return { kind: 'needActivation' };
    }
    if (group) await warmUserCache(this.ctx.env, { ...user, group });
    return { kind: 'ok', user: await this.buildUserResponse(user, true, group) };
  }

  /**
   * 新用户初始文件夹（官方 Pro「新用户初始文件」的文件夹部分）。
   *
   * 注册成功后，在用户根目录创建 `initial_files` 配置里的默认文件夹
   * （JSON 字符串数组，元素为文件夹名）。重名自动跳过；任一创建失败只记日志、
   * 不抛出，避免影响注册主流程。
   */
  private async seedInitialFolders(userId: number): Promise<void> {
    const names = this.ctx.settings.getJson<string[]>('initial_files', []);
    if (!Array.isArray(names) || names.length === 0) return;
    try {
      const root = await this.ctx.files.ensureRoot(userId);
      for (const raw of names) {
        const name = String(raw ?? '').trim();
        if (!name) continue;
        const dup = await this.ctx.files.childByName(root.id, name);
        if (dup) continue;
        await this.ctx.files.create({
          type: FileType.Folder,
          name,
          ownerId: userId,
          parentId: root.id,
        });
      }
    } catch (e) {
      console.error('seedInitialFolders failed', e);
    }
  }

  // -------------------------------------------------------------------------
  // 激活
  // -------------------------------------------------------------------------

  /**
   * 构造前端的激活地址。
   *
   * 上游分两步（`register.go:91-108`）：先对着**API 路径**签名，
   * 再把 id / sign 拼到前端路由 `/session/activate` 上。签名正文只有路径
   * （见 `pkg/auth/auth.go:212 getUrlSignContent`），所以前端页面地址和签名
   * 路径可以不同 —— 校验时仍是拿 API 请求的路径去比对。
   */
  async buildActivationUrl(user: UserRow): Promise<string> {
    const uid = this.ctx.codec.encodeUserID(user.id);
    const apiPath = `/api/v4/user/activate/${uid}`;
    const expires = Math.floor(Date.now() / 1000) + ACTIVATION_TTL_SECONDS;
    const sign = await this.ctx.signer.sign(apiPath, expires);
    return this.frontendLink('/session/activate', { id: uid, sign });
  }

  /** 发送激活邮件。 */
  async sendActivationEmail(user: UserRow): Promise<void> {
    const url = await this.buildActivationUrl(user);
    try {
      await this.mail.sendActivationEmail(user, url);
    } catch (e) {
      // 上游把发信失败包成 CodeNotSet + 空 msg（`register.go:68 / 83`）
      throw new AppError(CodeNotSet, '', e);
    }
  }

  /**
   * 激活账号。对应上游 `service/user/register.go:124 ActivateUser`。
   *
   * 注意错误码与文案都是照抄的，包括上游那句拼错的 "User not fount" ——
   * 前端不解析它，但「逐字一致」是硬要求（见项目约定）。
   */
  async activate(userHashId: string, sign: string, path: string): Promise<UserResponse> {
    // 原版由 `middleware.SignRequired` 在进 handler 之前校验，失败一律包成
    // CodeCredentialInvalid（`middleware/auth.go:38-41`）。注意 msg 用的是
    // 底层错误的文案：签名缺失时 `Signer.check('')` 会走到「有效期段为空」
    // 这一支，得到 "expire timestamp is missing"（上游 `auth.go:22`）。
    try {
      await this.ctx.signer.check(path, sign);
    } catch (e) {
      throw new AppError(40020, e instanceof Error ? e.message : 'invalid sign');
    }

    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw new AppError(40021, 'User not fount');

    const inactiveUser = await this.ctx.users.byId(uid);
    if (!inactiveUser) throw new AppError(40021, 'User not fount');

    if (inactiveUser.status !== 'inactive') {
      throw new AppError(CodeUserCannotActivate, 'This user cannot be activated');
    }

    await this.ctx.users.updateStatus(uid, 'active');
    await this.ctx.files.ensureRoot(uid);
    logAudit(this.ctx, 'user_activated', uid);
    // withGroup：拿到组行就能预热缓存（激活是注册-激活流程的收尾，与
    // register 同一套预热），也不再让 buildUserResponse 重复查一次组。
    const activeUser = await this.ctx.users.byIdWithGroup(uid);
    if (activeUser) {
      await warmUserCache(this.ctx.env, activeUser);
      return this.buildUserResponse(activeUser, true, activeUser.group);
    }
    return this.buildUserResponse(inactiveUser, true);
  }

  // -------------------------------------------------------------------------
  // 密码重置
  // -------------------------------------------------------------------------

  /** 构造前端的重置地址（`/session/reset?id=&secret=`）。 */
  buildResetUrl(user: UserRow, secret: string): string {
    const uid = this.ctx.codec.encodeUserID(user.id);
    return this.frontendLink('/session/reset', { id: uid, secret });
  }

  /**
   * 发送密码重置邮件。对应上游 `service/user/login.go:82 UserResetEmailService.Reset`。
   *
   * 三种拒绝理由各自有独立的错误码，别合并成一句「用户不存在」：
   * 被封禁的账号来重置密码，前端要能区分出来。
   */
  async sendResetEmail(email: string): Promise<void> {
    const user = await this.ctx.users.byEmail(email.trim().toLowerCase());
    if (!user) throw new AppError(40021, 'User not found');

    if (user.status === 'manual_banned' || user.status === 'sys_banned') {
      throw new AppError(CodeUserBaned, 'This user is banned');
    }
    if (user.status === 'inactive') {
      throw new AppError(CodeUserNotActivated, 'This user is not activated');
    }

    const secret = randomString(32);
    await kvFor(this.ctx.env, 'session').put(`${UserResetPrefix}${user.id}`, secret, {
      expirationTtl: RESET_TTL_SECONDS,
    });

    await this.mail.sendResetEmail(user, this.buildResetUrl(user, secret));
  }

  /**
   * 用令牌重置密码。对应上游 `service/user/login.go:41 UserResetService.Reset`。
   *
   * 判定顺序照抄上游：**先比令牌再看用户**。所以令牌不对时不管 id 是否存在，
   * 一律是「链接失效」—— 这样也顺带避免了用这个接口探测用户是否存在。
   */
  async resetPassword(userHashId: string, secret: string, newPassword: string): Promise<UserResponse> {
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw new AppError(CodeTempLinkExpired, 'Link is expired');

    const stored = await kvFor(this.ctx.env, 'session').get(`${UserResetPrefix}${uid}`);
    if (!stored || stored !== secret) {
      throw new AppError(CodeTempLinkExpired, 'Link is expired');
    }

    // 一次性令牌：校验通过立刻销毁，重放无效
    await kvFor(this.ctx.env, 'session').delete(`${UserResetPrefix}${uid}`);

    // 对应上游 `GetActiveByID`：只有正常状态的账号能重置
    const user = await this.ctx.users.byId(uid);
    if (!user || user.status !== 'active') throw new AppError(40021, 'User not found');

    if (newPassword.length < 6 || newPassword.length > 128) {
      throw new AppError(CodeParamErr, 'Password must be between 6 and 128 characters');
    }
    await this.ctx.users.updatePassword(uid, await digestPassword(newPassword));
    logAudit(this.ctx, 'change_password', uid, { via: 'reset' });

    const updated = await this.ctx.users.byId(uid);
    return this.buildUserResponse(updated!, true);
  }

  /**
   * 手工生成一条重置链接。
   *
   * 上游没有这个入口 —— 它是边缘版的兜底：没配邮件服务（或 SMTP/Resend 挂了）
   * 时，管理员仍能把链接直接交给用户。用的是同一个 KV 键，所以和邮件那条路
   * 完全等价，不会出现「两套令牌互不认识」。
   */
  async createResetUrl(email: string): Promise<{ url: string; expiresIn: number }> {
    const user = await this.ctx.users.byEmail(email.trim().toLowerCase());
    if (!user) throw Err.userNotFound();
    const secret = randomString(32);
    await kvFor(this.ctx.env, 'session').put(`${UserResetPrefix}${user.id}`, secret, {
      expirationTtl: RESET_TTL_SECONDS,
    });
    return { url: this.buildResetUrl(user, secret), expiresIn: RESET_TTL_SECONDS };
  }

  /** 站点地址 + 前端路由 + 查询参数。站点地址没配时退化成相对路径。 */
  private frontendLink(path: string, query: Record<string, string>): string {
    const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
    const qs = new URLSearchParams(query).toString();
    return `${base}${path}?${qs}`;
  }

  // -------------------------------------------------------------------------
  // 个人资料
  // -------------------------------------------------------------------------

  async capacity(): Promise<{ total: number; used: number }> {
    const user = this.ctx.requireUser();
    const max = this.ctx.maxStorage;
    return {
      // 不限量时原版返回一个很大的数；这里沿用该约定
      total: max === null || max <= 0 ? Number.MAX_SAFE_INTEGER : max,
      used: Number(user.storage),
    };
  }

  async updateSettings(patch: {
    nick?: string;
    language?: string;
    preferred_theme?: string;
    version_retention?: boolean;
    version_retention_ext?: string[];
    version_retention_max?: number;
    current_password?: string;
    new_password?: string;
    disable_view_sync?: boolean;
    share_links_in_profile?: string;
    upload_policy_id?: number | string;
    two_fa_enabled?: boolean;
    two_fa_code?: string;
  }): Promise<UserResponse> {
    const user = this.ctx.requireUser();

    // 两步验证的开关走独立分支：开启要用「待确认密钥」验码，关闭要用「已存密钥」验码。
    // 对应上游 `service/user/setting.go:298-328`。
    if (patch.two_fa_enabled !== undefined) {
      const code = patch.two_fa_code ?? '';
      if (patch.two_fa_enabled) {
        const pending = await kvFor(this.ctx.env, 'session').get(`2fa_init_${user.id}`);
        if (!pending) {
          throw new AppError(CodeInternalSetting, 'You have not initiated 2FA session');
        }
        if (!(await validateTotp(code, pending))) {
          throw new AppError(Code2FACodeErr, 'Incorrect 2FA code');
        }
        await this.ctx.users.setTwoFactorSecret(user.id, pending);
        await kvFor(this.ctx.env, 'session').delete(`2fa_init_${user.id}`);
        logAudit(this.ctx, 'enable_2fa', user.id);
      } else {
        if (!user.two_factor_secret || !(await validateTotp(code, user.two_factor_secret))) {
          throw new AppError(Code2FACodeErr, 'Incorrect 2FA code');
        }
        await this.ctx.users.setTwoFactorSecret(user.id, null);
        logAudit(this.ctx, 'disable_2fa', user.id);
      }
    }

    if (patch.new_password) {
      if (patch.new_password.length < 6 || patch.new_password.length > 128) {
        throw new AppError(CodeParamErr, 'Password must be between 6 and 128 characters');
      }
      const pwCheck = await checkPassword(user.password, patch.current_password ?? '');
      if (!pwCheck.ok) throw new AppError(CodeIncorrectPassword, 'Incorrect password');
      if (pwCheck.upgradeToV4) {
        await this.ctx.users.updatePassword(user.id, pwCheck.upgradeToV4);
      }
      const digest = await digestPassword(patch.new_password);
      await this.ctx.users.updatePassword(user.id, digest);
      logAudit(this.ctx, 'change_password', user.id);
    }

    if (patch.nick !== undefined) {
      await this.ctx.users.updateProfile(user.id, { nick: patch.nick });
      logAudit(this.ctx, 'change_nick', user.id, { nick: patch.nick });
    }

    const settings = { ...(user.settings ?? {}) };
    if (patch.language !== undefined) settings.email_language = patch.language;
    if (patch.preferred_theme !== undefined) settings.preferred_theme = patch.preferred_theme;
    if (patch.version_retention !== undefined) settings.version_retention = patch.version_retention;
    if (patch.version_retention_ext !== undefined) settings.version_retention_ext = patch.version_retention_ext;
    if (patch.version_retention_max !== undefined) settings.version_retention_max = patch.version_retention_max;
    if (patch.disable_view_sync !== undefined) settings.disable_view_sync = patch.disable_view_sync;
    if (patch.share_links_in_profile !== undefined) {
      settings.share_links_in_profile = patch.share_links_in_profile;
    }
    // 上传策略偏好（自建多策略功能）：hashid 字符串（前端 PolicySwitcher）或
    // 数字均可；空串 = 清除偏好回落组默认。非法 hashid 显式报 40001（不再
    // 静默吞掉），越权/不存在的策略由 assertPolicyAllowed 抛 40035。
    if (patch.upload_policy_id !== undefined) {
      const raw = patch.upload_policy_id;
      if (raw === null || raw === '') {
        delete settings.upload_policy_id;
      } else {
        const pid =
          typeof raw === 'number' && Number.isFinite(raw)
            ? raw
            : this.ctx.codec.decodePolicyID(String(raw));
        if (pid === null || !Number.isFinite(Number(pid))) {
          throw Err.param('Invalid upload_policy_id');
        }
        await this.ctx.assertPolicyAllowed(Number(pid));
        settings.upload_policy_id = Number(pid);
      }
    }
    await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);

    const updated = await this.ctx.users.byId(user.id);
    // 组行不受本次资料修改影响，直接复用请求里已解析的行，省一次查询
    return this.buildUserResponse(updated!, true, user.group);
  }

  /** 固定 / 取消固定侧栏文件。 */
  async pin(uri: string, name: string | undefined, pinned: boolean): Promise<void> {
    const user = this.ctx.requireUser();
    const settings = { ...(user.settings ?? {}) };
    const list = settings.pined ?? [];

    if (pinned) {
      if (list.some((p) => p.uri === uri)) return;
      list.push({ uri, name });
    } else {
      settings.pined = list.filter((p) => p.uri !== uri);
      await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);
      return;
    }

    settings.pined = list;
    await this.ctx.users.updateSettings(user.id, settings as Record<string, unknown>);
  }

  /** 头像地址。原版支持 gravatar 与本地头像两种。 */
  buildAvatarUrl(user: UserRow): string {
    if (user.avatar) {
      const base = this.ctx.settings.siteUrl.replace(/\/+$/, '');
      return `${base}/api/v4/user/avatar/${this.ctx.codec.encodeUserID(user.id)}`;
    }
    const server = this.ctx.settings.get('gravatar_server', 'https://www.gravatar.com/');
    // 与原版一致：用邮箱的 MD5 取头像，这里退化为邮箱本身（不引 MD5 依赖）
    return `${server.replace(/\/+$/, '')}/avatar/${encodeURIComponent(user.email)}?d=mp`;
  }

  /** 上传头像到 R2。 */
  async uploadAvatar(body: ArrayBuffer, contentType: string): Promise<void> {
    const user = this.ctx.requireUser();
    const maxSize = this.ctx.settings.getInt('avatar_size', 4194304);
    if (body.byteLength > maxSize) {
      throw new AppError(40049, `Avatar size exceeds ${maxSize} bytes`);
    }
    const key = `avatar/${user.id}`;
    await this.ctx.env.R2.put(key, body, { httpMetadata: { contentType } });
    await this.ctx.users.updateProfile(user.id, { avatar: `r2://${key}` });
    logAudit(this.ctx, 'change_avatar', user.id);
  }

  async getAvatar(userHashId: string): Promise<{ body: ReadableStream; contentType: string } | null> {
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) return null;
    const user = await this.ctx.users.byId(uid);
    if (!user?.avatar?.startsWith('r2://')) return null;
    const key = user.avatar.slice('r2://'.length);
    const obj = await this.ctx.env.R2.get(key);
    if (!obj) return null;
    return {
      body: obj.body,
      contentType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
    };
  }

  // -------------------------------------------------------------------------
  // 管理：用户列表
  // -------------------------------------------------------------------------

  async listUsers(params: {
    page: number;
    pageSize: number;
    orderBy?: string;
    orderDirection?: string;
    keyword?: string;
    groupId?: string;
    status?: string;
  }): Promise<{ users: UserResponse[]; pagination: { page: number; page_size: number; total_items: number } }> {
    this.ctx.requireAdmin();

    let groupId: number | undefined;
    if (params.groupId) {
      const decoded = this.ctx.codec.decodeGroupID(params.groupId);
      groupId = decoded ?? undefined;
    }

    const { users, total } = await this.ctx.users.list({
      page: params.page,
      pageSize: params.pageSize,
      orderBy: params.orderBy,
      orderDirection: params.orderDirection,
      keyword: params.keyword,
      groupId,
      status: params.status,
    });

    const out: UserResponse[] = [];
    for (const u of users) {
      out.push(await this.buildUserResponse(u, true));
    }

    return {
      users: out,
      pagination: { page: params.page, page_size: params.pageSize, total_items: total },
    };
  }

  async adminUpdateUser(
    userHashId: string,
    patch: { groupId?: string; status?: string; nick?: string; email?: string },
  ): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    const user = await this.ctx.users.byId(uid);
    if (!user) throw Err.userNotFound();

    if (patch.groupId) {
      const gid = this.ctx.codec.decodeGroupID(patch.groupId);
      if (gid === null) throw new AppError(40039, 'Group not found');
      const group = await this.ctx.groups.byId(gid);
      if (!group) throw new AppError(40039, 'Group not found');
      await this.ctx.users.updateGroup(uid, gid);
    }
    if (patch.status) {
      if (!['active', 'inactive', 'manual_banned', 'sys_banned'].includes(patch.status)) {
        throw Err.param('Invalid status');
      }
      await this.ctx.users.updateStatus(uid, patch.status);
    }
    if (patch.nick !== undefined) {
      await this.ctx.users.updateProfile(uid, { nick: patch.nick });
    }
    if (patch.email !== undefined) {
      // 上游 UpsertUserService.validateEmail（#3563 修复）：管理员改邮箱必须
      // 过格式校验，否则存进去一个登录不了的黑户。规则与注册一致：要求
      // 域名带点（admin@test / user@localhost 这类都会被拒）。
      const normalized = patch.email.trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) {
        throw Err.param('Email format error');
      }
      const existing = await this.ctx.users.byEmail(normalized);
      if (existing && existing.id !== uid) {
        throw new AppError(CodeEmailExisted, 'This email has already been used');
      }
      if (existing?.id !== uid) {
        await this.ctx.users.updateEmail(uid, normalized);
      }
    }
    logAudit(this.ctx, 'user_changed', uid, { by: 'admin', fields: Object.keys(patch) });
  }

  async resetUserPassword(userHashId: string, newPassword: string): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    const digest = await digestPassword(newPassword);
    await this.ctx.users.updatePassword(uid, digest);
  }

  async deleteUser(userHashId: string): Promise<void> {
    this.ctx.requireAdmin();
    const uid = this.ctx.codec.decodeUserID(userHashId);
    if (uid === null) throw Err.userNotFound();
    // 原版把 id=1 视为初始用户，禁止操作
    if (uid === 1) throw new AppError(40043, 'Cannot perform this action on the default user');
    await this.ctx.users.updateStatus(uid, 'sys_banned');
  }

  /** 站内用户搜索（分享页展示所有者等场景）。 */
  async search(keyword: string, limit = 20): Promise<UserResponse[]> {
    const { users } = await this.ctx.users.list({ page: 0, pageSize: limit, keyword });
    // 已登录查看者才可能看到 email，且要站点开关 `expose_user_email` 打开
    const exposeEmail = this.ctx.settings.getBool('expose_user_email', true);
    const out: UserResponse[] = [];
    for (const u of users) out.push(await this.buildUserResponse(u, false, undefined, { exposeEmail }));
    return out;
  }

  /** 判断是否管理员（供路由与前端菜单使用）。 */
  isAdmin(user: UserWithGroup): boolean {
    const perms = user.group.permissions instanceof Uint8Array
      ? new BooleanSet(user.group.permissions)
      : BooleanSet.fromBase64(user.group.permissions as unknown as string);
    return perms.enabled(GroupPermission.IsAdmin);
  }
}

export { CodeNotFullySuccess };
