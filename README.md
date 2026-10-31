<div align="center">

<a href="https://cloudreve.org/"><img src="https://raw.githubusercontent.com/cloudreve/frontend/master/public/static/img/logo192.png" width="120" alt="Cloudreve"></a>

# Cloudreve-Worker

**跑在 Cloudflare Workers 上的 Cloudreve v4 前端/后端 —— 用 TypeScript 重写。**

![License](https://img.shields.io/badge/license-GPL--3.0-blue)
![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Language](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Database](https://img.shields.io/badge/database-PostgreSQL-336791)
![Upstream](https://img.shields.io/badge/aligned%20with-Cloudreve%204.19.1-lightgrey)

[上游主页](https://cloudreve.org) • [上游演示站](https://demo.cloudreve.org) • [上游文档](https://docs.cloudreve.org) • [上游仓库](https://github.com/cloudreve/Cloudreve)

<br>

<img src="https://raw.githubusercontent.com/cloudreve/docs/master/images/homepage.png" width="860" alt="Cloudreve 界面截图">

<sub>Logo 与截图来自上游 Cloudreve 项目。本项目使用官方前端，界面与上游一致。</sub>

</div>

> [!IMPORTANT]
> **本项目不是 Cloudreve 官方项目**，是基于 Cloudreve 的第三方移植，与官方无隶属关系。Cloudreve 的名称、Logo 和前端归上游作者所有。使用中遇到问题请在本仓库提 Issue，不要打扰上游。

> [!NOTE]
> **本项目基于 AI 辅助开发。** 不愿意使用 AI 产出代码的，可以不用本项目，详见 [AI 辅助开发声明](#ai-辅助开发声明)。

---

## 简介

Cloudreve v4 的后端，用 TypeScript 照着重写，跑在 Cloudflare Workers 上。不是拿 Go 编译过去的 —— Go 在 Workers 上跑不了。

存储走 R2 / S3 / OneDrive / 又拍云等，数据库用任意 PostgreSQL（Neon 走 HTTP 驱动，Supabase / CockroachDB / Xata / Prisma Postgres / Railway / Render / 自建走标准协议），前端是官方那套，跟 Worker 一起发布。

## 部署

> [!TIP]
> **推荐手动部署**：Fork 本仓库后接入 Cloudflare，之后 Sync fork 就能拿到本项目的更新。一键部署生成的是独立副本，不会跟随更新。

1. 去 [neon.tech](https://neon.tech) 新建项目，复制 **Connection string**（`postgresql://` 开头）。
2. 在 GitHub 上 **Fork** 本仓库。
3. Cloudflare → Workers & Pages → Create → 选你 fork 的仓库，构建命令填 `npm install`，部署命令填 `npm run deploy`，输出目录留空。
4. 项目设置 → 环境变量里加 `DATABASE_URL`，保存后重新部署。
5. 打开 Worker 地址，注册第一个账号，**自动成为管理员**。

`npm run deploy` 会自动创建 KV 和 R2（已有同名则复用）并写回 `wrangler.toml`，建表在首次打开站点时自动执行。

> [!WARNING]
> 构建命令别改成 `npm run build`，那是 CI 的 dry-run 检查，放构建阶段会让构建时间成倍涨。

**部署后必做：**

- 把 `SITE_URL` 设成你的 Worker 地址，否则分享短链和下载直链不对
- 管理后台添加**存储策略**并绑给用户组，默认没有存储后端，传不了文件

**更新：** 在你 fork 的页面点 Sync fork，Workers Builds 会自动重新部署。

<details>
<summary>一键部署（不推荐，不跟随更新）</summary>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

部署页把 `DATABASE_URL` 填成 PostgreSQL 连接串，点 Deploy 即可。

</details>

完整步骤、存储策略、节点存储、WebDAV、排错见 [DEPLOY.md](DEPLOY.md)。

## 环境变量

只有 `DATABASE_URL` 必填，其余都是可选的。位置：Workers → 设置 → 变量和机密。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | 是 | PostgreSQL 连接串（Neon / Supabase / CockroachDB / Xata / Prisma Postgres / 自建） |
| `DB_PROVIDER` | 否 | `neon` 或 `postgres`；留空按连接串域名自动判断 |
| `HYPERDRIVE` | 否 | Cloudflare 绑定，不是变量。非 Neon 的 Postgres 建议配，边缘连接池 |
| `SITE_URL` | 建议 | 站点对外地址；不设回落到后台 siteURL |
| `JWT_SECRET` | 否 | 令牌签名密钥；不设自动生成入库 |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | 否 | 兜底管理员，两个都配才生效，用于找回管理员权限，建议存成 Secret |
| `FRONTEND_URL` | 否 | 前端单独部署到别处才填，反代优先 |
| `CORS_ALLOW_ORIGINS` | 否 | 允许跨域的源，逗号分隔；同源不用配 |
| `R2_PUBLIC_BASE` | 否 | R2 公共域名，配了直链不带签名 |
| `KV_COUNT` | 否 | KV namespace 数量，1–5，默认 1 |
| `DATABASE_URL_2` … `_5` | 否 | 备库连接串，仅 Neon 的构建期全量同步使用 |
| `DB_FAILOVER` | 否 | 填 `1` 开启主库故障切换，仅作应急 |

> [!IMPORTANT]
> `KV_COUNT` 不能填在「变量和机密」里，那是运行时变量，绑定数量构建时就要定，读不到会**静默回落成 1**。请配在 **Workers Builds 的环境变量**，或在仓库根目录放个 `KV_COUNT` 文件。

邮件 SMTP、存储策略、全文检索、用户组权限、WebDAV 账号都在管理后台配。

**多 KV：** `KV_COUNT=2..5` 后按角色拆分（站点缓存 / 会话 / 上传 / 外部凭据 / 自举标记），缓解并发写入限速。

**备库：** 只读冷备，**不是双活**。切到备库期间写入的数据，下次同步会被主库覆盖。

## 功能

文件管理（上传下载、移动复制、重命名、删除、回收站）、分享和直链、WebDAV（含 RFC 4918 写锁）、多存储策略、用户组和权限、管理后台、离线下载和压缩解压、支付和礼品卡、OIDC / QQ 登录、OAuth 授权、审计日志、文件加密、Windows 桌面客户端接入。

**存储后端：** R2 / S3 / OSS / COS / OBS / KS3 / 七牛 / OneDrive / 又拍云，以及**节点存储**。

**节点存储：** 把一台有磁盘的机器加成从节点（官方 Cloudreve 从机，或仓库里的 `agent/cloudreve-node-agent.mjs`），文件就落在它的本地磁盘上。Worker 没有硬盘，这是「本地文件系统存储」在云函数里的唯一形态。从节点还能接离线下载任务，没有 200MB 体积闸门，也不占 Worker 的 CPU 预算。

**文件加密：** 存储策略里打开「文件加密」后，新上传的文件在浏览器内用 AES-256-CTR 加密再上传，存储后端（OneDrive/S3/R2）只见到密文；下载时由 Worker 还原明文，用户侧无感。密钥存数据库、与存储后端分离，存储方读不到明文——但 Worker 自己能解密，不是口令式零知识。中转（relay）策略不加密（与官方前端一致），加密文件不生成缩略图。

**对齐上游 `4.19.1`**：4.15 ~ 4.19 的修复都已并入，前端跟到上游最新（含 Cloudreve CLI 的授权登录）。

**和官方的差异：** Pro 功能已全部对齐。主从多机集群用「负载均衡虚拟策略」近似，Office 协作委托外部 OnlyOffice（本站当 WOPI host），视频转码未做——边缘没有常驻转码进程。

## 本地开发

```bash
npm install                      # 装依赖
cp .dev.vars.example .dev.vars   # 填 DATABASE_URL
npm run typecheck                # 类型检查
npm run dev                      # 本地起服务
npm run deploy                   # 部署
```

其他脚本：`db:migrate` 建表、`db:sync` 主备同步、`kv:setup` 配 KV、`kv:purge` 清缓存重填、`smoke` 冒烟测试、`test:node` 从节点端到端测试、`test:share-og` 分享社交预览测试。

## AI 辅助开发声明

本项目大量使用 AI 模型辅助开发（作者主要通过 API 在本地编码），仓库里相当一部分代码有 AI 参与产出。附带冒烟测试和从节点端到端测试（`npm run smoke`、`npm run test:node`），但仍可能有疏漏，上生产前请自行评估，重要数据做好备份。

**不愿意使用 / 不接受 AI 产出代码的，可以不用本项目**，可直接自建官方 [Cloudreve](https://github.com/cloudreve/Cloudreve)。

## 许可

GPL-3.0。本项目是 [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve)（GPL-3.0）的移植，沿用同一许可，见 `LICENSE`。

## 致谢

- [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve) —— 上游项目，行为参照与前端均来自它
- [Cloudflare Workers](https://workers.cloudflare.com/) 与 [Neon](https://neon.tech) —— 让这套架构成为可能
- AI 模型 —— 参与了本项目的代码编写与重构：
  - Claude Opus 5.5
  - ChatGPT 5.6 Sol
  - DeepSeek 4.1 Flash
