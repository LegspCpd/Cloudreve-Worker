/**
 * Worker 环境绑定与运行时上下文类型。
 */

export interface Env {
  // --- 机密（wrangler secret put） ---
  /**
   * 主库连接串，形如 postgresql://user:pass@ep-xxx.aws.neon.tech/cloudreve?sslmode=require
   *
   * 多库模式下它仍是**唯一可写的主库**。其余连接串放 `DATABASE_URL_2..5`。
   */
  DATABASE_URL: string;
  /**
   * 备库连接串（可选，你自己在 Neon 建好后填）。取值形如
   * `postgresql://...:...@ep-yyy.aws.neon.tech/cloudreve?sslmode=require`。
   *
   * 语义见 `db/replicate.ts`：
   *   - 请求**只打主库**，备库绝不承接业务流量；
   *   - 「每次构建全量同步」= CI 里的 `npm run db:sync` 逐表
   *     `COPY TO/FROM STDOUT`，把主库整库灌进全部备库；
   *   - 主库不可用时（可用 `DB_FAILOVER=1` 打开）自动切到第一个能连上的备库。
   *
   * ⚠️ **不要**把备库配成可写并同时打开故障切换：切换期间写到备库的数据
   * 会在下次全量同步时被主库内容覆盖掉。备库是**冷备**，不是双活。
   */
  DATABASE_URL_2?: string;
  DATABASE_URL_3?: string;
  DATABASE_URL_4?: string;
  DATABASE_URL_5?: string;
  /**
   * 故障切换闸门：`1` / `true` 时，主库连不上会自动降级到第一个可用的
   * 备库（只读语义，仍然允许写 —— 否则站点直接不可用；风险见上）。
   * 缺省关闭：默认行为是「主库挂了就报错」，不做隐式切换。
   */
  DB_FAILOVER?: string;
  /**
   * 数据库驱动：`neon`（Neon HTTP）或 `postgres`（标准 PostgreSQL 线协议）。
   *
   * 不配时按连接串域名自动判断：`*.neon.tech` 走 neon，其余一律走 postgres。
   * `postgres` 覆盖 Supabase / CockroachDB / Xata（Postgres）/ Prisma Postgres /
   * Railway / Render / 自建 Postgres —— 它们都讲同一套 PG 协议，SQL 与迁移不用改。
   * 用 Neon 的自定义域名时才需要显式写 `neon`。
   */
  DB_PROVIDER?: string;
  /**
   * Cloudflare Hyperdrive 绑定（可选）。
   *
   * 绑了之后运行时用 `connectionString` 连它（边缘连接池），否则每个 isolate
   * 自己维持 1 条到数据库的连接。非 Neon 的 Postgres 建议配 Hyperdrive：
   * Workers 的连接不能跨请求共享，直连时每条新连接都要付一次 TCP+TLS+认证。
   */
  HYPERDRIVE?: { connectionString: string };
  /**
   * 全量同步时是否跳过这些表（逗号分隔）。缺省用 `replicate.ts` 的内置
   * 默认值。一般不需要配。
   */
  DB_SYNC_SKIP?: string;
  /**
   * JWT 签名密钥。留空时回退到数据库 settings 表里的 `secret_key`。
   * 生产环境建议显式设置，避免依赖数据库可读性。
   */
  JWT_SECRET?: string;

  // 邮件（SMTP）配置**不在环境变量里**。它在数据库的 settings 表里，由管理后台的
  // 「邮件」设置页维护 —— 键名是 smtpHost / smtpPort / smtpUser / smtpPass /
  // smtpEncryption / fromName / fromAdress / replyTo（见
  // `src/settings/provider.ts` 的 `smtp` getter），协议实现在 `src/services/smtp.ts`。
  // 之所以这样安排：官方前端的面板只有这组 SMTP 字段，配置若放环境变量，
  // 管理员在面板里改了什么都不会生效，面板就成了摆设。

  // --- 变量（可选，wrangler.toml 故意不声明 [vars]，见该文件注释） ---
  /** 本站对外地址，用于拼分享链接 / 下载直链；缺省回落到设置里的 siteURL */
  SITE_URL?: string;
  /**
   * 官方前端的地址。两种用法二选一：
   *   - 配了 `[assets]`（推荐）：官方前端构建产物随 Worker 一起发布，此变量留空；
   *   - 没配 `[assets]`：填写官方前端的独立部署地址（如 Cloudflare Pages），
   *     非 /api 的请求会原样反代过去。
   */
  FRONTEND_URL?: string;
  ENVIRONMENT?: string;
  /**
   * 允许跨域访问 API 的源，逗号分隔（如 `https://a.com,https://b.com`）。
   * 留空 = 关闭跨域，与原版配置项 AllowOrigins 为 UNSET 时的行为一致。
   * 前端与 Worker 同源部署时不需要配置。
   */
  CORS_ALLOW_ORIGINS?: string;
  /** 可选的 R2 公共域名，配置后 R2 直链不带签名 */
  R2_PUBLIC_BASE?: string;
  /**
   * 兜底管理员（两者都配了才生效）：保证这个邮箱存在、密码一致、属于
   * 管理员组。用于找回管理员权限 —— 手机部署没有本机 CLI，没处跑
   * 原版的 `cloudreve --reset-admin-password`。见 `services/envAdmin.ts`。
   */
  ADMIN_EMAIL?: string;
  ADMIN_PASSWORD?: string;

  // --- 绑定 ---
  /**
   * KV：会话吊销名单、上传会话状态、验证码、实体 URL 缓存、OneDrive token 缓存。
   *
   * 多 KV 模式下它仍然是**兜底绑定**：`lib/kvRouter.ts` 按角色优先取
   * `KV_1..KV_5`，拿不到就回落到这里。所以 N=1 的部署只需这一个绑定。
   */
  KV: KVNamespace;
  /** 分角色 KV（可选，由 wrangler.toml 的 [[kv_namespaces]] 声明，KV_COUNT 控制数量）。 */
  KV_1?: KVNamespace;
  KV_2?: KVNamespace;
  KV_3?: KVNamespace;
  KV_4?: KVNamespace;
  KV_5?: KVNamespace;
  /**
   * 归档区 KV（**可选**）。独立于 KV_1..KV_5，用来留「被覆盖前的旧值」。
   *
   * 为什么不复用上面某个角色：归档是**只增不减**的历史，而业务 KV 是
   * 可被整体清理的缓存区。混在一起的话清一次业务缓存就把历史清了。
   * 未绑定时归档功能整体降级为 no-op（见 `services/archive.ts`）。
   */
  ARCHIVE_KV?: KVNamespace;
  /** R2：内置对象存储后端 */
  R2: R2Bucket;
  /**
   * 官方前端的静态资源绑定。仅当 wrangler.toml 里配置了 `[assets]` 时存在，
   * 此时静态文件与 SPA 回落由平台的资源层直接处理，Worker 只在兜底路径上用它。
   */
  ASSETS?: Fetcher;
}
