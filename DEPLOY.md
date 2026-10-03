# 部署手册

全程走一键部署，手机浏览器就能弄完，本机不用装任何东西。

## 1. 先弄个 Neon 数据库

这是唯一需要你手动准备的东西。

去 [neon.tech](https://neon.tech) 注册（GitHub 登录就行），新建项目，区域挑个离你近的，然后把 Dashboard 首页那串 **Connection string** 复制下来：

```
postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require
```

免费档够用。这串就是后面要填的 `DATABASE_URL`。

## 2. 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

点按钮，登 Cloudflare，授权完进部署页，把 `DATABASE_URL` 填成第 1 步那串，其他留空，点 Deploy。构建通常一两分钟。

部署脚本在背后帮你干了这些，不用管：

- 建 Cloudflare 的 KV namespace（放缓存和会话）和 R2 bucket（默认存储桶）
- 把真实资源 ID 填回 `wrangler.toml`
- 把 `DATABASE_URL` 写成 Worker 的运行时 Secret
- 备好官方前端（仓库 Release 里有预构建包就直接用，秒级；没有才拉官方源码现构建），跟 Worker 一起发

建表也在里面了——迁移脚本打包进了 Worker，第一次打开站点时自动执行，不用跑任何迁移命令。

## 3. 不想用按钮：面板手动接仓库

Workers & Pages → Create → 选你 fork 的仓库，只填两格：

| 框 | 命令 |
|---|---|
| 构建命令 | `npm install` |
| 部署命令 | `npm run deploy` |

输出目录留空。然后在项目**设置 → 环境变量**里加 `DATABASE_URL`，保存后重新部署。

> 构建命令那格**别填 `npm run build`**。它是给 CI 做 dry-run 检查用的，放构建阶段会白打一遍包、多拉一遍前端，构建时间成倍涨（一两分钟变八九分钟）。

`npm run deploy` 对已经存在的同名 KV / R2 是直接复用，不存在才新建，重跑几次不会多出一堆垃圾资源。

## 4. 第一次打开

打开 Worker 地址（`https://cloudreve-worker.<你的子域>.workers.dev`），注册第一个账号。**第一个注册的用户自动是管理员**，登进去就能进管理后台。

要是管理员权限丢了找不回来，在环境变量里同时配 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`，Worker 会保证这个邮箱存在、密码一致、在管理员组里。用完建议把这两个变量删掉。

## 5. 环境变量

配置位置：Cloudflare → 你的 Worker → 设置 → 变量和机密。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | Neon 连接串，主库，唯一可写的那个 |
| `SITE_URL` | 建议 | 站点对外地址，比如 `https://pan.example.com`。分享短链和下载直链靠它拼；不设就回落到后台的 siteURL |
| `JWT_SECRET` | 否 | 令牌签名密钥，32 位以上随机串。不设会自动生成一个入库 |
| `ADMIN_EMAIL` | 否 | 兜底管理员邮箱，得和 `ADMIN_PASSWORD` 一起配 |
| `ADMIN_PASSWORD` | 否 | 兜底管理员密码，建议存成 Secret |
| `FRONTEND_URL` | 否 | 前端单独部署到别处时才填，填了反代优先于内置资源 |
| `CORS_ALLOW_ORIGINS` | 否 | 允许跨域的源，逗号分隔，比如 `https://a.com,https://b.com`。前后端同源不用配 |
| `R2_PUBLIC_BASE` | 否 | R2 的公共域名，配了生成的直链不带签名 |
| `KV_COUNT` | 否 | 建几个 KV namespace，1–5，默认 1。⚠️ 见下面那条 |
| `DATABASE_URL_2` … `_5` | 否 | 备库连接串，配了每次构建自动从主库整库同步（只读冷备） |
| `DB_FAILOVER` | 否 | 填 `1` 打开主库故障切换，自动降级到第一个能连上的备库 |
| `DB_SYNC_SKIP` | 否 | 全量同步时要跳过的表，逗号分隔。一般不用配 |

`KV_COUNT` 那个坑再说一遍：填在「设置 → 变量和机密」是运行时变量，而绑定数量构建时就得定下来，构建读不到它，结果静默变回 1，站点还不报错。正确位置是 Workers Builds 的环境变量，或者仓库根目录放个 `KV_COUNT` 文件。

邮件、存储策略、全文检索、用户组权限、WebDAV 账号这些都不在环境变量里，全在管理后台配。

## 6. 后台里要配的

### 存储策略（不配传不了文件）

管理后台 → 存储策略 → 添加。

| 类型 | 填什么 |
|---|---|
| **R2** | 类型选 **`s3`**（R2 走 S3 协议），填桶名、Endpoint（`https://<accountid>.r2.cloudflarestorage.com`）、AccessKey / SecretKey，区域填 `auto` |
| S3 / OSS / COS / OBS / KS3 / 七牛 | 选对应类型，填桶名、Endpoint、AK/SK、区域 |
| OneDrive / SharePoint | 类型 `onedrive`，还得在策略页点授权跳微软登录。授权过期了要重新授权 |
| 又拍云 | 类型 `upyun`，填空间名、操作员、密码、加速域名 |
| 本机 | 类型 `local`。Workers 没有持久磁盘，这个只用来调试 |
| 负载均衡 | 类型 `load_balance`，在几个策略之间按权重分流 |

加完别忘了去**用户组 → 编辑**把这个策略绑给用户组。组没绑策略，上传会报 `No policy selected`。

### 邮件

管理后台 → 设置 → 邮件，填 SMTP 主机、端口、用户名、密码、加密方式、发件人。

开了「注册需邮件激活」之后，新用户必须收邮件激活才能登——SMTP 没配好会导致所有人都注册不了，想清楚了再开。

### 站点地址

管理后台 → 设置 → 站点，把 siteURL 填成你的站点地址，跟 `SITE_URL` 保持一致。要填多个就用英文逗号分隔，**每一段都得带 `https://`**，只写 `pan.example.com` 会报 `Invalid siteURL`。

### 开 WebDAV

用户组 → 编辑 → 勾上 WebDAV 权限；然后用户在「连接与挂载」里创建 WebDAV 账号，拿到的是专用密码，**不是登录密码**。

## 7. 多 KV

单 KV 并发一高会撞写入限速。`KV_COUNT` 设成 2 到 5 之后按角色分开：

| 绑定 | 管什么 |
|---|---|
| `KV_1` | 站点设置缓存 |
| `KV_2` | 会话、验证码、2FA |
| `KV_3` | 上传会话、打包、WebDAV 锁 |
| `KV_4` | 外部凭据缓存 |
| `KV_5` | 自举标记 |

`KV` 还是兜底，没配 `KV_n` 的时候所有角色都回落给它，所以 count=1 时留这一个就行。超过 5 会直接拒绝构建。

缓存怎么维护：构建期跑 `npm run kv:purge` 清空重填，运行时靠每小时的 Cron 覆盖写刷新。

## 8. 多数据库容灾

在 Neon 另建 1 到 4 个项目，连接串分别填进 `DATABASE_URL_2` 到 `_5`。每次构建会把主库整库同步过去。

主库挂了就把 `DB_FAILOVER` 设成 `1` 临时切过去。但记住备库是**冷备不是双活**——切换期间写进备库的数据，下次全量同步时会被主库内容盖掉。

## 9. 定时任务

`wrangler.toml` 里已经配了 `crons = ["0 * * * *"]`，每小时整点跑一次，干两件事：刷新缓存、清理回收站到期的文件。不用额外配。

想手动触发一次：Cloudflare → Worker → 触发器 → Cron。

## 10. Windows 桌面客户端

官方客户端走的是 Windows Cloud Files API，不是 WebDAV。

- 客户端登录选「用 Cloudreve 登录」，OAuth 授权完挑一个本地空目录当同步根。
- 绑定时报 `Invalid redirect URI`：服务端得放行相对回调 `/callback/desktop`（已修）。
- 打开同步根报**「云操作不成功」**：服务端文件响应缺 `path` 字段导致目录枚举失败（已修）。
- 添加时报 **Failed to start drive**：这是 Windows 本地的问题，跟服务端没关系。先在客户端里把已有网盘移除，删掉或换一个空目录，重启客户端再添加。

## 11. 更新

Workers Builds 会在仓库有新提交时自动重新部署。你是 fork 的话，在 GitHub 上 Sync fork，或者到 Cloudflare 手动 Retry deployment。

## 12. 排错

| 现象 | 怎么回事 |
|---|---|
| 打开是「后端已就绪」纯文本页 | 前端没构建成功。看构建日志里 fetch-frontend 那步，重新部署一次 |
| 登录完立刻被登出、刷新令牌失败 | 检查 `DATABASE_URL` 通不通；配了多库的话确认没误开 `DB_FAILOVER` |
| 上传报 `No policy selected` | 用户组没绑存储策略 |
| 大文件传不上 | Workers 请求体有上限，大文件得走分片；顺带看下存储策略的分片配置 |
| 报 `Invalid siteURL` | 站点地址每段都要带 `https://` |
| Windows 挂载 WebDAV 说「位置不可用」 | `wrangler.toml` 的 `run_worker_first` 里**必须有 `/dav/*`**，不然静态层对 PROPFIND / PUT 直接回 405 |
| 定时任务没跑 | Cloudflare → Worker → 触发器，看 Cron 在不在，或者手动触发一次 |
| 想清空重来 | 删掉 Neon 项目重建再改 `DATABASE_URL`，或者跑 `npm run kv:purge` 清缓存 |
| 构建从一两分钟变八九分钟 | 前端没走预构建包、退回源码现构建了。先确认构建命令是 `npm install` 不是 `npm run build`，再看构建日志有没有「✅ 前端就绪（Release 预构建包）」这行 |

看运行状态可以开这几个：

- `/api/v4/site/ping` —— 通不通
- `/api/v4/site/db-status` —— 数据库和分域状态
- `/api/v4/site/kv-status` —— KV 绑定状态
