# 部署手册

全程走一键部署，手机浏览器就能弄完，本机不用装任何东西。

## 1. 先弄个 Postgres 数据库

这是唯一需要你手动准备的东西。Neon 最省事，其它 PostgreSQL 也能直接用：

| 供应商 | `DATABASE_URL` 用哪串 | 备注 |
|---|---|---|
| Neon | 控制台首页的 Connection string | 走 HTTP 驱动，不需要连接池 |
| Supabase | Settings → Database → **Transaction pooler**（6543） | 直连 5432 也能用，serverless 下容易耗尽连接 |
| CockroachDB | 集群的 `postgresql://...` | 带 `?sslmode=require` |
| Xata（Postgres） | 数据库的 Postgres 连接串 | — |
| Prisma Postgres | **Pooled** 连接串（`pooled.db.prisma.io`） | 直连串留给迁移 |
| Railway / Render / 自建 | 你自己的 `postgresql://` | — |

Neon 注册用 GitHub 登录，新建项目挑个近的区域，复制 Dashboard 首页那串 `postgresql://...` 就行，免费档够用。其它库大多强制 TLS，把 `sslmode=require` 带上。

**不支持：PlanetScale 的 MySQL 版、Turso（SQLite）、MongoDB Atlas（文档库）。** 现有 schema 和几百条查询全是 PostgreSQL 方言，这三家不是同一个协议/模型，接不了——要用得另做一套数据层。PlanetScale 的 **Postgres** 版属于 PG 协议，填它的连接串、把 `DB_PROVIDER` 设成 `postgres` 即可。

`DB_PROVIDER` 一般不用填：连接串是 `*.neon.tech` 就走 Neon HTTP，其余自动走标准 PG 协议。只有 Neon 配了自定义域名时才需要写 `DB_PROVIDER=neon`。

非 Neon 的库建议在 Cloudflare 控制台建一个 **Hyperdrive**，把绑定加到 `wrangler.toml`（见文件里的注释）。不配也能跑，但每个 isolate 只有 1 条连接、新连接要重做 TCP+TLS+认证，冷启动会慢一些。

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
| `DATABASE_URL_2` | 否 | 日志域：`audit_logs` 一张表运行时单独写这个库，见「多数据库容灾」 |
| `DATABASE_URL_3` | 否 | 元数据域：`metadata` 表同上 |
| `DATABASE_URL_4`、`_5` | 否 | 冷备库，每次构建自动从主库整库同步（只读）；`DB_FAILOVER` 降级时切到第一个 |
| `DB_FAILOVER` | 否 | 填 `1` 打开主库故障切换，降级窗口内读写切到第一个冷备 |
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
| 本机磁盘 | 类型 `local` 或 `remote`，**必须绑一个从节点**，见下面「节点存储」 |
| 负载均衡 | 类型 `load_balance`，在几个策略之间按权重分流 |

加完别忘了去**用户组 → 编辑**把这个策略绑给用户组。组没绑策略，上传会报 `No policy selected`。

### 节点存储（把文件放到自己机器的磁盘上）

Cloudflare 的 Worker 没有硬盘，所以「本地存储」只能由一台有磁盘的机器提供。那台机器叫**从节点**，Worker 当主站，把读写按签名 RPC 发过去。

两种从节点都行：

- **官方 Cloudreve 从机**：`conf.ini` 里 `[System] Mode = slave`、`[Slave] Secret = <密钥>`，正常启动即可。
- **仓库自带的 agent**：`agent/cloudreve-node-agent.mjs`，单文件零依赖，适合不想再装一套 Cloudreve 的场景。

协议是同一套（`/api/v4/slave/*` + HMAC 签名），所以两种可以混用。

#### 1. 在机器上跑起来

```bash
# 官方从机
./cloudreve -c conf.ini

# 或者自带的 agent
node agent/cloudreve-node-agent.mjs --root /data/cloudreve --port 8666 --secret <密钥>
```

| agent 参数 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `--root` | `NODE_ROOT` | `./data` | 文件落盘的根目录 |
| `--port` | `NODE_PORT` | `8666` | 监听端口 |
| `--secret` | `NODE_SECRET` | 必填 | 主→从签名密钥，跟后台填的一致 |
| `--host` | `NODE_HOST` | `0.0.0.0` | 监听地址 |

反代（nginx / Caddy）三件事别忘：走 HTTPS、放开 `PUT` / `DELETE`、`client_max_body_size` 改成 `0` 或者不小于分片大小（默认 25MB，nginx 默认 1MB 会让分片 413）。

#### 2. 后台加节点

管理后台 → 节点 → 新建。类型选 `slave`。

| 字段 | 填什么 |
|---|---|
| 名称 | 随便，自己认得出就行 |
| 地址 | `https://node.example.com`（不带 `/api/v4/slave`，代码自己拼） |
| 密钥 | 跟从机的 `--secret` / `[Slave] Secret` 完全一致 |
| 权重 | 只有任务分派用，存储策略用不到，填 1 |

保存后点**测试**。它会给从机发一次签名 ping，通了才说明密钥对得上。

#### 3. 建策略、绑组

存储策略 → 添加 → 类型选 **`remote`** → 「节点」下拉里选刚才那台 → 保存 → 用户组里绑上。

> `local` 类型也能用（服务端是同一个驱动），但前端的 `local` 向导里没有节点选择框，所以实际请用 `remote`。

#### 4. 跑通了看什么

- 上传一个文件，去从机的 `--root` 目录下应该能看到 `uploads/<uid>/...`
- 下载：返回的是**节点的签名直链**，浏览器直接从节点拉，不走 Worker
- 排错：从机日志会直接打原因 —— `invalid sign` 是密钥不一致，`signature expired` 是两边时间差超过 60 秒，`40001` 之外的多半是反代改了路径或拦了方法

#### 5. 分享链接的社交预览

把分享链接贴到微信 / Telegram / Discord 时，对方看到的卡片有标题、大小、分享者和缩略图 —— 这是给社交媒体爬虫单独渲染的 OG 页面（对应上游 PR #3234），普通浏览器照原样进 SPA。

不需要配置。分享带密码、已过期或不存在时，卡片描述统一显示「Invalid Link」，不泄露具体原因。预览**不增加浏览量**，也不写审计。

#### 6. 让节点接任务（可选）

管理后台 → 节点 → 编辑 → 能力位，勾上「远程下载」。之后用户的离线下载会分派到这台机器上跑：

| | 请求内执行 | 分派到节点 |
|---|---|---|
| 单文件大小 | 上限 200MB | 无上限 |
| Worker CPU | 占满本次请求的预算 | 几乎不占 |
| 完成延迟 | 请求返回即完成 | 最多一分钟（cron 同步状态） |

要点：

- 分派信息写在任务的私有状态里，cron 每分钟拉一次从节点的任务状态写回任务表；前端本来就在轮询任务列表，所以感知延迟最多一分钟。
- 产物是**节点回头调主站**的 `/api/v4/slave/statelessUpload/*` 落库的（文件行、实体、容量记账都在主站做），所以网盘里能正常看到、也能正常下载。
- 「打包」「解压」两个能力位同样认，但目前只对官方 Cloudreve 从机有效 —— 自带的 agent 还没实现这两个。
- 一台节点都没有时，一切照旧走请求内执行，行为与之前完全一致。

### 邮件

管理后台 → 设置 → 邮件，填 SMTP 主机、端口、用户名、密码、加密方式、发件人。

开了「注册需邮件激活」之后，新用户必须收邮件激活才能登——SMTP 没配好会导致所有人都注册不了，想清楚了再开。

### 站点地址

管理后台 → 设置 → 站点，把 siteURL 填成你的站点地址，跟 `SITE_URL` 保持一致。要填多个就用英文逗号分隔，**每一段都得带 `https://`**，只写 `pan.example.com` 会报 `Invalid siteURL`。

### 开 WebDAV

用户组 → 编辑 → 勾上 WebDAV 权限；然后用户在「连接与挂载」里创建 WebDAV 账号，拿到的是专用密码，**不是登录密码**。

地址填 `https://你的域名/dav`（带不带结尾斜杠都行）。Windows 映射网络驱动器、
MT管理器、Alist / OpenList、rclone、Cyberduck 都验证过，账号密码就是上面那个专用密码。

**单文件上传上限 100 MB**（Cloudflare 套餐层限制，不是代码限制）：Free / Pro 是
100 MB，Business 200 MB，Enterprise 可以在 zone 的 Network → Maximum Upload Size
自助调到 5 GB。超过的话请求在到达 Worker 之前就被 CF 挡回 413，代码里无法拦截或
提示。大文件请用网页端上传（走存储的直传/分片，不经过 Worker），或者把策略绑到
从节点后用网页端写入节点磁盘。

挂载失败先看这三条：

| 现象 | 原因 |
|---|---|
| 提示「找不到网络路径」/ 直接连不上 | 地址少了 `/dav`，或者用了 `http://`（Windows 只对 HTTPS 自动发 Basic 凭据） |
| 能进目录但文件打不开 | 看响应里 `X-Correlation-ID` 对应日志；中文名问题已修（href 双重编码） |
| 上传大文件报 413 | 上面那条 100 MB 限制 |

### 开文件加密

存储策略 → 编辑 → 文件加密 → 打开开关。之后往这个策略上传的新文件会在浏览器里加密再上传，存储后端只看到密文；下载时 Worker 自动解密，用户无感。已有文件保持原样，重新上传或在线编辑一次才会转成密文。

几个要注意的：

| 情况 | 行为 |
|---|---|
| 中转（relay）策略 | 不加密。前端对 relay 本来就不加密，硬标会让下载时把明文当密文解成乱码 |
| 缩略图 | 加密文件不生成缩略图（存储里的密文没法解码） |
| 直链 | 强制走本站代理，不会给出存储直链（直链拿到的是密文） |
| WOPI / OnlyOffice | 打开时解密后交给 OnlyOffice，保存时重新加密，可以正常编辑 |
| 加密的压缩包 | 浏览目录、在线解压上限 32MB（要先整段解密到内存，Worker 是 128MB） |
| 界面标识 | 文件列表不显示锁标，前端没有消费 `encrypted_with` 的地方 |
| 密钥 | 存在数据库里，与存储后端分开。存储方读不到明文，但 Worker 自己能解密 |
| 关闭加密 | 只影响之后的上传；已经加密的文件不会自动解密 |

网页端上传由浏览器加密，WebDAV 上传由服务端加密，两条都会落成密文。服务端自己生成的写入——压缩到网盘、离线下载落盘、从节点存储——目前不加密。

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

`DATABASE_URL_2` 到 `_5` 不是一排等价的备库，各有分工（都必须和主库不同的库）：

| 变量 | 用途 | 说明 |
|---|---|---|
| `DATABASE_URL_2` | 日志域 | `audit_logs` 一张表运行时写这个库。配了之后首次启动自动建表、把主库存量搬过去、主库侧清空（表结构保留） |
| `DATABASE_URL_3` | 元数据域 | `metadata` 表同上。这张表在列表热路径上，量大时拆出去能明显提速 |
| `DATABASE_URL_4`、`_5` | 冷备 | 每次构建自动从主库整库同步（只读，别接流量） |

分域库挂了会自动回退主库（功能降级、站点正常），不用管。

⚠️ **`_2`/`_3` 不要当备库用。** 同步是「主库 → 备库」整表覆盖，分域建好后主库上这两张表是空壳，同步一次就把分域库里的真实数据清掉了。代码已把分域库从同步和故障切换的备库列表里排除，但配置请按上面的分工来——要冷备就从 `_4` 开始配。

`DB_FAILOVER=1` 是应急开关：主库连续报错进入降级窗口后，读写切到第一个冷备（`DATABASE_URL_4`）。冷备不是双活——切换期间写进备库的数据，主库恢复后会再跑一次构建同步，被主库内容盖掉。

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
