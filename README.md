# Cloudreve-Worker

把 Cloudreve v4 后端**重写**成跑在 Cloudflare Workers 上的 TypeScript 实现（不是 Go 编译，也不是简单移植）。

- 存储：Cloudflare R2 / S3 / OneDrive / 又拍云 等
- 数据库：Neon Postgres（Serverless）
- 前端：官方 Cloudreve 前端，随 Worker 一起发布

---

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/LegspCpd/Cloudreve-Worker)

| 步骤 | 做什么 |
|---|---|
| 1 | 到 [neon.tech](https://neon.tech) 注册 → 新建项目 → 复制首页 **Connection string**（`postgresql://...`） |
| 2 | 点上面按钮 → 部署页把 `DATABASE_URL` 填成第 1 步那串 → 点 **Deploy** |
| 3 | 打开 Worker 地址，**注册第一个账号**（第一个注册的用户自动是管理员） |

KV、R2 自动创建；建表和初始化在**首次打开站点时自动完成**，不用跑任何命令。

### 部署后收尾（2 件）

1. Workers → 设置 → 变量和机密，加 `SITE_URL` = 你的 Worker 地址（分享链接、下载直链要用）。
2. 管理后台添加**存储策略**（默认没有存储后端，不加不能上传）。

完整配置说明见 [DEPLOY.md](./DEPLOY.md)。

### 不用按钮：面板手动接仓库

Workers & Pages → Create → 选仓库，只填两格：

| 框 | 命令 |
|---|---|
| 构建命令 | `npm install` |
| 部署命令 | `npm run deploy` |

输出目录留空。`npm run deploy` 会自动创建/复用 KV 与 R2 并回填真实 ID，不用改 `wrangler.toml`。

在项目**设置 → 环境变量**里加 `DATABASE_URL`，保存后重新部署（脚本会自动写成运行时 Secret）。

---

## 环境变量

部署页**只要求填 `DATABASE_URL`**，其余全部可选，想要时在 Workers → 设置 → 变量和机密里加。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | Neon 连接串（`postgresql://user:pass@ep-xxx.aws.neon.tech/neondb?sslmode=require`） |
| `SITE_URL` | 建议 | 站点对外地址。不设则回落到后台的 `siteURL` 设置 |
| `JWT_SECRET` | 可选 | 令牌签名密钥。不设会自动生成并入库 |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | 可选 | 兜底管理员：两者都配时，保证该邮箱存在、密码一致、属管理员组。用于找回管理员权限（建议存为 Secret） |
| `FRONTEND_URL` | 可选 | 默认前端已随 Worker 发布；只有把前端单独部署到别处（如 Pages）时才填 |
| `CORS_ALLOW_ORIGINS` | 可选 | 允许跨域的源，逗号分隔。前后端同源时不用配 |
| `R2_PUBLIC_BASE` | 可选 | R2 公共访问域名，配了直链不带签名 |
| `KV_COUNT` | 可选 | 建几个 KV namespace，**1–5**，默认 1。⚠️ 必须配在**构建时**能读到的地方 |
| `DATABASE_URL_2` … `_5` | 可选 | 备库连接串，配了每次构建自动全量同步（冷备） |
| `DB_FAILOVER` | 可选 | 填 `1` 打开主库故障切换。⚠️ 切换期间写入备库的数据会在下次同步时被覆盖，仅应急 |

> ⚠️ **`KV_COUNT` 别填在「Workers → 设置 → 变量和机密」**：那是运行时变量，绑定数量必须在**构建时**确定，构建读不到 → 静默回落成 1，站点不报错但你以为配了 5 个只绑了 1 个。

**不在环境变量里**（都在管理后台）：邮件 SMTP、存储策略、全文检索（Meilisearch + Tika）、用户组权限、WebDAV 账号。

---

## 可选：加 KV / 加数据库

| 资源 | 做法 | 效果 |
|---|---|---|
| KV | 设 `KV_COUNT=2..5`（构建时） | 按角色分工：`KV_1` 站点缓存 / `KV_2` 会话 / `KV_3` 上传 / `KV_4` 凭据 / `KV_5` 自举标记 |
| 数据库 | 加 `DATABASE_URL_2..5` | 备库只读冷备，每次构建从主库全量同步；**非双活** |

---

## 已实现功能

文件管理（上传/下载/移动/复制/重命名/删除/回收站）、分享与直链、WebDAV、多存储策略、用户组与权限、管理后台、离线下载与压缩解压、支付与礼品卡、OIDC 登录、OAuth 授权、审计日志、桌面同步客户端接入。

**未实现**：完整 RFC 4918 锁（WebDAV 锁为简化实现）、部分 Pro 专有接口。

---

## 本地开发

```bash
npm install                      # 装依赖
cp .dev.vars.example .dev.vars   # 填 DATABASE_URL
npm run typecheck                # 类型检查
npm run dev                      # 本地起服务
npm run deploy                   # 部署
```

常用脚本：`db:migrate`、`db:sync`（主备同步）、`kv:setup`、`kv:purge`（清缓存重填）、`smoke`（冒烟）。

---

## 许可

MIT。上游 Cloudreve 为 [cloudreve/Cloudreve](https://github.com/cloudreve/Cloudreve)。
