<div align="center">

<a href="https://cloudreve.org/"><img src="https://raw.githubusercontent.com/cloudreve/frontend/master/public/static/img/logo192.png" width="120" alt="Cloudreve"></a>

# Cloudreve-Worker

**跑在 Cloudflare Workers 上的 Cloudreve v4 前端/后端 —— 用 TypeScript 重写。**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

![License](https://img.shields.io/badge/license-GPL--3.0-blue)
![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)
![Language](https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript&logoColor=white)
![Database](https://img.shields.io/badge/database-Neon%20Postgres-00E599)
![Upstream](https://img.shields.io/badge/aligned%20with-Cloudreve%204.19.1-lightgrey)

[上游主页](https://cloudreve.org) • [上游演示站](https://demo.cloudreve.org) • [上游文档](https://docs.cloudreve.org) • [上游仓库](https://github.com/cloudreve/Cloudreve)

<br>

<img src="https://raw.githubusercontent.com/cloudreve/docs/master/images/homepage.png" width="860" alt="Cloudreve 界面截图">

<sub>Logo 与截图来自上游 Cloudreve 项目。本项目使用官方前端，界面与上游一致。</sub>

</div>

> [!NOTE]
> **本项目基于 AI 辅助开发。** 代码的编写、重构和移植过程中大量使用了 AI 模型。
> 如果你不愿意使用 AI 参与产出的代码，**可以不用本项目**，完全没问题 —— 详见 [AI 辅助开发声明](#ai-辅助开发声明)。

---

## 目录

- [这是什么](#这是什么)
- [特性](#特性)
- [架构](#架构)
- [部署](#部署)
- [环境变量](#环境变量)
- [加 KV、加数据库](#加-kv加数据库)
- [功能](#功能)
- [与上游的差异](#与上游的差异)
- [本地开发](#本地开发)
- [常见问题](#常见问题)
- [AI 辅助开发声明](#ai-辅助开发声明)
- [许可](#许可)

## 这是什么

Cloudreve v4 的后端，用 TypeScript 照着重写了一遍，跑在 Cloudflare Workers 上。不是拿 Go 编译过去的 —— Go 在 Workers 上根本跑不了。

存储走 R2 / S3 / OneDrive / 又拍云这些，数据库用 Neon 的 serverless Postgres，前端是官方那套，跟 Worker 一起发布。

没有服务器要维护，没有磁盘要挂，一个 Cloudflare 账号 + 一个 Neon 账号就能跑起来。

## 特性

- **零运维部署**：点按钮、填一个 `DATABASE_URL`，KV 和 R2 自动建，建表和初始化首次访问时自动跑。
- **行为对齐上游 `4.19.1`**：4.15 ~ 4.19 的修复都并进来了（WebDAV 覆盖语义、容量原子预占、OAuth scope 强制校验、属主邮箱开关、S3 元数据校验等），前端也跟到上游最新（含 Cloudreve CLI 的授权登录）。
- **存储后端丰富**：R2 / S3 / OSS / COS / OBS / KS3 / 七牛 / OneDrive / 又拍云，以及**节点存储**。
- **从节点可接任务**：离线下载可以分派给从节点跑，不占 Worker 的 CPU 预算。
- **完整的 WebDAV**，含 RFC 4918 写锁。
- **可选主备库**：构建时自动同步到备库，主库故障时可手动切换应急。
- **可拆分 KV**：最多 5 个 namespace，按角色分摊写入压力。

## 架构

```mermaid
flowchart LR
    C["浏览器 / WebDAV / 桌面客户端"] --> W["Cloudflare Worker<br/>API + 前端"]
    W --> DB[("Neon Postgres<br/>DATABASE_URL")]
    W --> KV[("Workers KV<br/>缓存 / 会话 / 上传 ...")]
    W --> S["存储后端<br/>R2 / S3 / OSS / COS / OneDrive ..."]
    W --> N["从节点（可选）<br/>本地磁盘 / 离线下载"]
    DB -. "构建时全量同步" .-> B[("备库（可选）<br/>DATABASE_URL_2 ~ _5")]
```

## 部署

### 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

三步就完事：

1. 去 [neon.tech](https://neon.tech) 注册，新建个项目，把首页那串 **Connection string** 拷下来（`postgresql://` 开头那个）。
2. 点上面那个按钮，部署页里把 `DATABASE_URL` 填成刚拷的那串，点 Deploy。
3. 打开 Worker 地址，注册第一个账号 —— 第一个注册的自动进管理员组。

KV 和 R2 会自动建，建表和初始化也是第一次打开站点时自动跑的，一行命令都不用敲。

### 部署后检查清单

- [ ] 注册了第一个账号（自动成为管理员）
- [ ] 把 `SITE_URL` 设成你的 Worker 地址（Workers → 设置 → 变量和机密里加），不然分享短链和下载直链会不对
- [ ] 在管理后台添加了**存储策略** —— 默认没配存储后端，不加传不了文件
- [ ] （按需）在管理后台配置邮件 SMTP、用户组权限等

### 手动部署（不用按钮）

Workers & Pages → Create → 选你 fork 的仓库：

| 配置项 | 填写 |
|---|---|
| 构建命令 | `npm install` |
| 部署命令 | `npm run deploy` |
| 输出目录 | 留空 |

`npm run deploy` 会自己把 KV 和 R2 处理好（账号里已有同名的直接复用，没有才新建），真实 ID 也会自己写回 `wrangler.toml`。然后到项目设置里加 `DATABASE_URL`，保存后重新部署。

> [!WARNING]
> 构建命令别改成 `npm run build` —— 那是给 CI 做 dry-run 检查的，放构建阶段会多打一遍包，构建时间成倍涨。

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
| `KV_COUNT` | 否 | 建几个 KV namespace，1–5，默认 1。**注意看下面那条** |
| `DATABASE_URL_2` … `_5` | 否 | 备库连接串，配了之后每次构建会把主库整库同步过去 |
| `DB_FAILOVER` | 否 | 填 `1` 打开主库故障切换，主库连不上就自动降级到备库。只当应急用 |

> [!IMPORTANT]
> **`KV_COUNT` 有个坑：别填在「Workers → 设置 → 变量和机密」里。**
> 那是运行时变量，而绑定数量必须在构建时就定下来，构建过程读不到它，结果就是**静默回落成 1** —— 你以为配了 5 个，实际只绑了 1 个，站点还不报错。
> 要配就配在 **Workers Builds 的环境变量**里，或者仓库根目录放个 `KV_COUNT` 文件。

下面这些东西不在环境变量里，都在**管理后台**配：邮件 SMTP、存储策略、全文检索、用户组权限、WebDAV 账号。

## 加 KV、加数据库

单 KV 在并发高的时候会撞上写入限速，单库会撞 Neon 计算实例的连接上限。两个都能靠加实例摊薄，但机制不一样，别混着理解。

### 多 KV

设 `KV_COUNT=2..5`（记得在构建时配）之后，每个 namespace 各管一块：

| 绑定 | 负责 |
|---|---|
| `KV_1` | 站点缓存 |
| `KV_2` | 会话 |
| `KV_3` | 上传 |
| `KV_4` | 外部凭据 |
| `KV_5` | 自举标记 |
| `KV` | 兜底绑定：没配 `KV_n` 的时候所有角色都回落到它，所以 count=1 时只留这一个就够 |

### 备库

加 `DATABASE_URL_2..5` 是另一回事：备库是**只读冷备**，每次构建从主库全量同步过去，**不是双活**。

主库挂了才临时用 `DB_FAILOVER=1` 切过去。

> [!CAUTION]
> 切换期间写进备库的数据，下次同步时会被主库内容盖掉。

## 功能

文件管理那一套（上传下载、移动复制、重命名、删除、回收站）、分享和直链、WebDAV（含完整的 RFC 4918 写锁）、多存储策略、用户组和权限、管理后台、离线下载和压缩解压、支付和礼品卡、OIDC 登录、OAuth 授权、审计日志、Windows 桌面客户端接入。

### 存储后端

| 类型 | 支持 |
|---|---|
| 对象存储 | R2 / S3 / OSS / COS / OBS / KS3 / 七牛 |
| 网盘 / 云服务 | OneDrive / 又拍云 |
| 节点存储 | 官方 Cloudreve 从机，或仓库里的 `agent/cloudreve-node-agent.mjs` |

### 节点存储

把一台有磁盘的机器加成从节点，策略绑上去，文件就落在它的本地磁盘上。Worker 本身没有硬盘，所以这是「本地文件系统存储」在云函数里的唯一形态。

### 从节点接任务

节点详情里勾上「远程下载」能力后，离线下载就分派给它跑 —— 没有 200MB 的体积闸门，也不占 Worker 的 CPU 预算。

| 能力位 | 官方 Cloudreve 从机 | 自带 agent |
|---|---|---|
| 远程下载 | ✅ | ✅ |
| 打包 / 解压 | ✅ | ❌ 还没实现 |

### 没做的

一部分 Pro 专有的接口。

## 与上游的差异

| | 上游 Cloudreve | Cloudreve-Worker |
|---|---|---|
| 语言 | Go | TypeScript |
| 运行环境 | 自己的服务器 / 容器 | Cloudflare Workers |
| 数据库 | 常见为 SQLite / MySQL / Postgres | Neon serverless Postgres |
| 本地磁盘存储 | 直接支持 | 通过「节点存储」间接实现 |
| 前端 | 官方 | 官方（跟 Worker 一起发布） |
| Pro 专有接口 | 有 | 部分未实现 |
| 行为对齐 | — | 对齐上游 `4.19.1` |

## 本地开发

```bash
npm install                      # 装依赖
cp .dev.vars.example .dev.vars   # 里面填 DATABASE_URL
npm run typecheck                # 类型检查
npm run dev                      # 本地起服务
npm run deploy                   # 部署
```

其他会用到的脚本：

| 命令 | 作用 |
|---|---|
| `npm run db:migrate` | 建表 |
| `npm run db:sync` | 主备库同步 |
| `npm run kv:setup` | 配 KV |
| `npm run kv:purge` | 清缓存重填 |
| `npm run smoke` | 冒烟测试 |
| `npm run test:node` | 从节点端到端测试（存储 + 任务分派 + 能力位） |
| `npm run test:share-og` | 分享社交预览测试 |
| `npm run build` | CI 的 dry-run 检查，**不要**放进 Workers 构建命令 |

## 常见问题

<details>
<summary><b>为什么不能直接把 Go 版本编译到 Workers 上？</b></summary>

Go 的运行时依赖在 Workers 环境里跑不了，所以这个项目是用 TypeScript 照着上游行为重写的，而不是编译移植。

</details>

<details>
<summary><b>部署好了，但传不了文件？</b></summary>

默认没有配存储后端。去管理后台添加一个**存储策略**（R2 / S3 / OneDrive / 节点存储等）。

</details>

<details>
<summary><b>分享短链、下载直链的域名不对？</b></summary>

把环境变量 `SITE_URL` 设成你的 Worker 对外地址（或你绑定的自定义域名）。不设的话会回落到后台「站点设置」里的 siteURL。

</details>

<details>
<summary><b>我配了 <code>KV_COUNT=5</code>，但好像只绑了 1 个 KV？</b></summary>

大概率是配在了「变量和机密」里。绑定数量要在**构建时**确定，运行时变量构建过程读不到，会静默回落成 1。改到 Workers Builds 的环境变量里，或在仓库根目录放一个 `KV_COUNT` 文件。

</details>

<details>
<summary><b>忘了管理员密码 / 管理员权限丢了怎么办？</b></summary>

同时配置 `ADMIN_EMAIL` 和 `ADMIN_PASSWORD`（建议存成 Secret）。生效后会保证这个邮箱存在、密码一致、且在管理员组里。找回后可以把它们删掉。

</details>

<details>
<summary><b>备库是双活吗？可以当读写分离用吗？</b></summary>

不是。备库是每次构建从主库全量同步的只读冷备，只用于主库故障时的应急切换（`DB_FAILOVER=1`）。切换期间写入备库的数据会在下次同步时被主库覆盖。

</details>

<details>
<summary><b>前端可以单独部署到 Pages 吗？</b></summary>

可以。设置 `FRONTEND_URL` 指向前端地址，必要时再配 `CORS_ALLOW_ORIGINS`。默认情况下前端和 Worker 一起发布，不用管这两项。

</details>

<details>
<summary><b>离线下载有大小限制吗？</b></summary>

Worker 自身跑离线下载有 200MB 的体积闸门，并且受 CPU 预算约束。要下载大文件，请接一个从节点并勾上「远程下载」能力，任务会分派给从节点执行。

</details>

## AI 辅助开发声明

本项目在开发过程中**大量使用了 AI 模型**：作者主要通过 API 调用 AI 模型，在本地完成代码的编写、重构和移植。也就是说，仓库里相当一部分代码有 AI 参与产出。

之所以这么做，是因为把一个体量不小的 Go 后端移植到 Workers 上，用 AI 辅助能大幅提高效率。为了让结果尽量可靠，项目对齐上游 `4.19.1` 的行为，并附带了冒烟测试和从节点端到端测试（`npm run smoke`、`npm run test:node`）。但 AI 产出的代码依然可能存在疏漏，**上生产环境前请自行评估，重要数据请做好备份**。

**不愿意使用 / 不接受 AI 产出的代码，完全可以不使用本项目。** 这是个人选择，没有任何问题。如果你更倾向于纯人工编写的实现，可以直接自建官方的 [Cloudreve](https://github.com/cloudreve/Cloudreve)。

发现问题欢迎提 Issue，附上复现步骤和日志会很有帮助。

## 许可

GPL-3.0。本项目是 [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve)（GPL-3.0）的移植，所以沿用同一许可，见 `LICENSE`。

## 致谢

- [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve) —— 上游项目，本项目的行为参照与前端均来自于它
- [Cloudflare Workers](https://workers.cloudflare.com/) 与 [Neon](https://neon.tech) —— 让这套架构成为可能
- AI 模型 —— 参与了本项目的代码编写与重构：
  - Claude Opus 5.5
  - ChatGPT 5.6 Sol
  - DeepSeek 4.1 Flash
