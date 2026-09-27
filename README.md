# Cloudreve-Worker

Cloudreve v4 的后端，用 TypeScript 照着重写了一遍，跑在 Cloudflare Workers 上。不是拿 Go 编译过去的——Go 在 Workers 上根本跑不了。

存储走 R2 / S3 / OneDrive / 又拍云这些，数据库用 Neon 的 serverless Postgres，前端是官方那套，跟 Worker 一起发布。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

三步就完事：

1. 去 [neon.tech](https://neon.tech) 注册，新建个项目，把首页那串 **Connection string** 拷下来（`postgresql://` 开头那个）。
2. 点上面那个按钮，部署页里把 `DATABASE_URL` 填成刚拷的那串，点 Deploy。
3. 打开 Worker 地址，注册第一个账号——第一个注册的自动进管理员组。

KV 和 R2 会自动建，建表和初始化也是第一次打开站点时自动跑的，一行命令都不用敲。

之后还有两件小事别忘了：把 `SITE_URL` 设成你的 Worker 地址（Workers → 设置 → 变量和机密里加），不然分享短链和下载直链会不对；再去管理后台加个存储策略，默认没配存储后端，不加传不了文件。

不用按钮也行：Workers & Pages → Create → 选你 fork 的仓库，构建命令填 `npm install`，部署命令填 `npm run deploy`，输出目录空着。`npm run deploy` 会自己把 KV 和 R2 处理好（账号里已有同名的直接复用，没有才新建），真实 ID 也会自己写回 `wrangler.toml`。然后到项目设置里加 `DATABASE_URL`，保存后重新部署。

## 环境变量

部署页只让你填 `DATABASE_URL` 一项，其他全是可选的，想加的时候去 Workers → 设置 → 变量和机密里加。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | Neon 连接串，`postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require` 这种 |
| `SITE_URL` | 建议 | 站点对外地址。不设就回落到后台「站点设置」里的 siteURL |
| `JWT_SECRET` | 否 | 令牌签名密钥。不设会自动生成一个存进库里 |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | 否 | 兜底管理员，两个都配才生效：保证这个邮箱存在、密码一致、在管理员组。用来找回管理员权限，建议存成 Secret |
| `FRONTEND_URL` | 否 | 前端默认跟 Worker 一起发布了。只有把前端单独扔到别处（比如 Pages）才填，填了反代优先 |
| `CORS_ALLOW_ORIGINS` | 否 | 允许跨域的源，逗号分隔。前后端同源不用管 |
| `R2_PUBLIC_BASE` | 否 | R2 的公共访问域名，配了生成的直链不带签名 |
| `KV_COUNT` | 否 | 建几个 KV namespace，1–5，默认 1。注意看下头那条 |
| `DATABASE_URL_2` … `_5` | 否 | 备库连接串，配了之后每次构建会把主库整库同步过去 |
| `DB_FAILOVER` | 否 | 填 `1` 打开主库故障切换，主库连不上就自动降级到备库。只当应急用 |

`KV_COUNT` 有个坑：别填在「Workers → 设置 → 变量和机密」里。那是运行时变量，而绑定数量必须在构建时就定下来，构建过程读不到它，结果就是静默回落成 1——你以为配了 5 个，实际只绑了 1 个，站点还不报错。要配就配在 Workers Builds 的环境变量里，或者仓库根目录放个 `KV_COUNT` 文件。

下面这些东西不在环境变量里，都在管理后台配：邮件 SMTP、存储策略、全文检索、用户组权限、WebDAV 账号。

## 加 KV、加数据库

单 KV 在并发高的时候会撞上写入限速，单库会撞 Neon 计算实例的连接上限。两个都能靠加实例摊薄，但机制不一样，别混着理解。

设 `KV_COUNT=2..5`（记得在构建时配）之后，每个 namespace 各管一块：`KV_1` 站点缓存、`KV_2` 会话、`KV_3` 上传、`KV_4` 外部凭据、`KV_5` 自举标记。原来的 `KV` 是兜底绑定，没配 `KV_n` 的时候所有角色都回落到它，所以 count=1 时只留那一个就够。

加 `DATABASE_URL_2..5` 是另一回事：备库只读冷备，每次构建从主库全量同步过去，**不是双活**。主库挂了才临时用 `DB_FAILOVER=1` 切过去，切换期间写进备库的数据下次同步时会被主库内容盖掉。

## 功能

文件管理那一套（上传下载、移动复制、重命名、删除、回收站）、分享和直链、WebDAV、多存储策略、用户组和权限、管理后台、离线下载和压缩解压、支付和礼品卡、OIDC 登录、OAuth 授权、审计日志、Windows 桌面客户端接入。

没做的：完整的 RFC 4918 锁（现在 WebDAV 的锁是简化版），还有一部分 Pro 专有的接口。

## 本地开发

```bash
npm install                      # 装依赖
cp .dev.vars.example .dev.vars   # 里面填 DATABASE_URL
npm run typecheck                # 类型检查
npm run dev                      # 本地起服务
npm run deploy                   # 部署
```

还有几个会用到的：`db:migrate` 建表、`db:sync` 主备同步、`kv:setup` 配 KV、`kv:purge` 清缓存重填、`smoke` 冒烟测试。

## 许可

MIT。上游是 [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve)。
