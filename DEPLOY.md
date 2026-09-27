# 部署手册

全程走**一键部署**，手机浏览器就能完成，不需要本机装任何工具。

---

## 1. 准备 Neon 数据库（唯一要手动准备的）

1. 打开 [neon.tech](https://neon.tech) 注册（可用 GitHub 登录）。
2. 新建项目（区域选离你近的）。
3. 复制 Dashboard 首页的 **Connection string**，形如：
   ```
   postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
   ```

免费档够用。这串就是后面要填的 `DATABASE_URL`。

---

## 2. 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

| 步骤 | 操作 |
|---|---|
| 1 | 点上面按钮，登录 Cloudflare，授权后进入部署页 |
| 2 | 在 `DATABASE_URL` 一栏粘贴第 1 步的连接串，其余留空 |
| 3 | 点 **Deploy**，等构建完成（约 5 分钟） |

部署脚本自动完成的事，不用你管：

- 创建 Cloudflare **KV namespace**（缓存/会话）和 **R2 bucket**（默认存储桶）
- 把真实资源 ID 回填进 `wrangler.toml`
- 把 `DATABASE_URL` 写成 Worker 的运行时 Secret
- 拉取并构建**官方前端**，随 Worker 一起发布

**建表和初始化数据在首次打开站点时自动执行**（迁移脚本已打包进 Worker），不用跑任何迁移命令。

---

## 3. 备选：面板手动接仓库

不用按钮时：Workers & Pages → Create → 选你 fork 的仓库，只填两格：

| 框 | 命令 |
|---|---|
| 构建命令 | `npm install` |
| 部署命令 | `npm run deploy` |

输出目录留空。然后在项目**设置 → 环境变量**加 `DATABASE_URL`，保存后重新部署。

> `npm run deploy` 对已存在的同名 KV/R2 会**直接复用**，不存在才新建。

---

## 4. 首次访问与管理员

1. 打开 Worker 地址（`https://cloudreve-worker.<子域>.workers.dev`）。
2. 注册第一个账号 —— **第一个注册的用户自动进入管理员组**。
3. 用该账号登录，即可进入管理后台。

**找回管理员权限**：在环境变量里同时配 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，Worker 会保证该邮箱存在、密码一致、属于管理员组。用完建议删掉这两个变量。

---

## 5. 环境变量

配置位置：Cloudflare → 你的 Worker → **设置 → 变量和机密**。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串（主库，唯一可写） |
| `SITE_URL` | 建议 | 站点对外地址，如 `https://pan.example.com`。分享短链、下载直链依赖它；不设则回落到后台「站点设置」的 `siteURL` |
| `JWT_SECRET` | 可选 | 令牌签名密钥（32 位以上随机串）。不设会自动生成并存入数据库 |
| `ADMIN_EMAIL` | 可选 | 兜底管理员邮箱（须与 `ADMIN_PASSWORD` 同时配） |
| `ADMIN_PASSWORD` | 可选 | 兜底管理员密码。建议存为 **Secret** |
| `FRONTEND_URL` | 可选 | 前端单独部署到别处（如 Pages）时才填；填了反代优先于内置资源 |
| `CORS_ALLOW_ORIGINS` | 可选 | 允许跨域的源，逗号分隔，如 `https://a.com,https://b.com`。前后端同源不用配 |
| `R2_PUBLIC_BASE` | 可选 | R2 公共访问域名，配了生成的直链不带签名 |
| `KV_COUNT` | 可选 | KV namespace 个数，**1–5**，默认 1。⚠️ 见下方警告 |
| `DATABASE_URL_2` … `_5` | 可选 | 备库连接串，配了每次构建自动从主库全量同步（只读冷备） |
| `DB_FAILOVER` | 可选 | 填 `1` 打开主库故障切换，自动降级到第一个可用备库。仅应急 |
| `DB_SYNC_SKIP` | 可选 | 全量同步时跳过的表（逗号分隔），一般不用配 |

> ⚠️ **`KV_COUNT` 必须配在构建时读得到的地方**（Workers Builds 的环境变量、或仓库根目录 `KV_COUNT` 文件）。
> 填在「设置 → 变量和机密」是**运行时**变量，构建读不到 → 静默回落成 1，站点不报错但你以为配了 5 个只绑了 1 个。

**以下配置不在环境变量里，全部在管理后台**：邮件 SMTP、存储策略、全文检索、用户组权限、WebDAV 账号、站点设置。

---

## 6. 后台必做配置

### 6.1 添加存储策略（不添加不能上传）

管理后台 → **存储策略** → 添加。

| 类型 | 关键填写项 |
|---|---|
| **R2**（推荐） | 类型选 **`s3`**（R2 兼容 S3 协议）；填桶名、Endpoint（`https://<accountid>.r2.cloudflarestorage.com`）、AccessKey / SecretKey、区域填 `auto` |
| S3 / OSS / COS / OBS / KS3 / 七牛 | 对应类型，填桶名、Endpoint、AK/SK、区域 |
| OneDrive / SharePoint | 类型选 `onedrive`，需在策略页**点授权**跳转微软登录；授权失效时需重新授权 |
| 又拍云 | 类型选 `upyun`，填空间名、操作员、密码、加速域名 |
| 本机 | 类型选 `local` —— Workers 环境**没有持久磁盘**，仅用于调试 |
| 负载均衡 | 类型选 `load_balance`，在多个策略间按权重分流 |

添加后到**用户组 → 编辑**，把该策略绑定给对应用户组。组没绑策略，上传会提示 `No policy selected`。

### 6.2 邮件（可选）

管理后台 → **设置 → 邮件**，填 SMTP：主机、端口、用户名、密码、加密方式、发件人。

开「注册需邮件激活」后，新用户必须收邮件激活才能登录 —— 没配好 SMTP 会导致所有人都注册不了。

### 6.3 站点地址

管理后台 → **设置 → 站点**，把 `siteURL` 填成你的站点地址（与 `SITE_URL` 一致）。带多个地址用英文逗号分隔，**每段都要带 `https://`**（写成 `pan.example.com` 会报 `Invalid siteURL`）。

### 6.4 开启 WebDAV（可选）

1. 用户组 → 编辑 → 勾选 **WebDAV** 权限。
2. 用户侧 → 「连接与挂载」→ 创建 WebDAV 账号，得到专用密码（**不是登录密码**）。

---

## 7. 可选：多 KV（`KV_COUNT`）

单 KV 在并发高时会撞写入限速。设 `KV_COUNT=2..5` 按角色分摊：

| 绑定 | 角色 |
|---|---|
| `KV_1` | 站点设置缓存 |
| `KV_2` | 会话 / 验证码 / 2FA |
| `KV_3` | 上传会话 / 打包 / WebDAV 锁 |
| `KV_4` | 外部凭据缓存 |
| `KV_5` | 自举标记 |

`KV` 是兜底绑定，未配置 `KV_n` 时所有角色回落到它，所以 `KV_COUNT=1` 只需一个 namespace。

超过 5 会直接拒绝构建。

**缓存维护**：构建期 `npm run kv:purge` 清空重填；运行时由每小时 Cron 覆盖写刷新。

---

## 8. 可选：多数据库容灾

1. 在 Neon 另建 1–4 个项目，把连接串分别配到 `DATABASE_URL_2` … `_5`。
2. 每次构建自动把主库**整库全量同步**到全部备库。
3. 主库挂了：临时把 `DB_FAILOVER` 设为 `1`，自动切到第一个可用备库。

⚠️ 备库是**冷备不是双活**：切换期间写入备库的数据，会在下次全量同步时被主库内容覆盖。

---

## 9. 定时任务

`wrangler.toml` 已配置 `crons = ["0 * * * *"]`（每小时整点），做两件事：

- 刷新缓存（覆盖写，开销恒定）
- 清理回收站到期文件

不用额外配置。想手动触发：Cloudflare → Worker → 触发器 → Cron，手动执行。

---

## 10. 桌面同步客户端（Windows）

官方客户端走 **Windows Cloud Files API**（不是 WebDAV）：

1. 客户端登录时选「用 Cloudreve 登录」→ OAuth 授权 → 选本地空目录作为同步根。
2. 绑定报 `Invalid redirect URI`：服务端需放行相对回调 `/callback/desktop`（已修复）。
3. 打开同步根报 **「云操作不成功」**：服务端文件响应缺 `path` 字段会导致目录枚举失败（已修复）。
4. 添加网盘报 **Failed to start drive**：这是 **Windows 本地问题**，与服务端无关 —— 先在客户端移除已有网盘，删掉/换一个**空目录**，重启客户端后再添加。

---

## 11. 更新版本

Workers Builds 会在仓库有新提交时自动重新部署。
若你是 fork：在 GitHub 上 `Sync fork`，或到 Cloudflare 手动 Retry deployment。

---

## 12. 排错

| 现象 | 原因 / 处理 |
|---|---|
| 打开站点是「后端已就绪」纯文本页 | 前端没构建成功。看构建日志里 `fetch-frontend` 是否失败；重新部署一次 |
| 登录后立刻被登出、刷新令牌失败 | 检查 `DATABASE_URL` 是否可达；多库时确认没误开 `DB_FAILOVER` |
| 上传提示 `No policy selected` | 用户组没绑定存储策略（见 6.1） |
| 上传大文件失败 | Workers 请求体上限 + 存储策略的分片配置；大文件走分片上传 |
| 提示 `Invalid siteURL` | 站点地址每段都要带 `https://`（见 6.3） |
| Windows 挂载 WebDAV「位置不可用」 | `wrangler.toml` 的 `run_worker_first` **必须含 `/dav/*`**，否则静态层对 PROPFIND/PUT 回 405 |
| 定时任务没跑 | Cloudflare → Worker → 触发器，确认 Cron 存在；或手动触发一次 |
| 想清空重来 | 删 Neon 项目重建 + 改 `DATABASE_URL`，或执行 `npm run kv:purge` 清缓存 |

查看运行状态：

- `/api/v4/site/ping` —— 连通性
- `/api/v4/site/db-status` —— 数据库 / 分域状态
- `/api/v4/site/kv-status` —— KV 绑定状态
