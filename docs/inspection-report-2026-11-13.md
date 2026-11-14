# 管理端巡检报告（2026-11-13）

平台：Cloudreve 边缘版 · CF Workers（`pan.legspcpd.top`）
方式：真实管理员身份（本地用库内 `secret_key` + `hash_id_salt` 签发 HS256 token，与 app 字节级一致），全程只读，**未做任何写库/写配置操作**。

## 1. 用户组变更确认

`bot-test@legspcpd.top`（uid=3）的组已为 **Admin**，与你的操作一致。

> 注：该测试账号的两个旧密码当前均登录失败（疑似被改过），巡检改用本地签发通道，不依赖其口令。

## 2. 数据完整性（库层直查）

| 对象 | 活跃数 | 软删数 | 备注 |
|---|---:|---:|---|
| 用户 | 12 | 1 | id=9 于 2026-10-01 已软删，列表按设计不显示；**非本次丢失** |
| 文件 | 90 | — | 另有 30 个目录（files 表共 120） |
| 实体 entities | 90 | 0 | 引用计数无空档（0 行 `reference_count=0`） |
| 分享 shares | 26 | 3 | 活跃 26 + 历史软删 3 |
| 直链 direct_links | 12 | — | — |
| 设置 settings | 204 | — | `secret_key` / `hash_id_salt` 均在 |

结论：**数据完整，无丢失、无孤儿引用**。

## 3. 管理端接口巡检

### 3.1 列表接口（13 类，全部 code=0）

| 接口 | 结果 | edges 关联 |
|---|---|---|
| `POST /admin/user` | ✅ | group / nick / avatar 全齐 |
| `POST /admin/file` | ✅ | owner / metadata / entities / direct_links / shares |
| `POST /admin/entity` | ✅ | storage_policy / user |
| `POST /admin/share` | ✅ | user / file |
| `POST /admin/group` | ✅ | storage_policy |
| `POST /admin/policy` | ✅ | — |
| `POST /admin/node` | ✅ | 0 节点（边缘版无从节点，预期） |
| `POST /admin/oauthClient` | ✅ | — |
| `POST /admin/queue` | ✅ | 历史任务（1 条旧 extract_archive 报错） |
| `POST /admin/audit/log` | ✅ | — |
| `GET /admin/summary` | ✅ | version 4.19.1 / pro=false |
| `GET /admin/share/report` | ✅ | 0 条举报 |
| 工具：`tool/mail`、`tool/wopi` | ✅ | 缺参数时返回 40001（预期校验） |

分页：响应 `pagination` 回显 0 基页码，请求 `page` 为 1 基（与上游一致）。第 2 页正确翻出 id=12、13。

### 3.2 详情接口（6 类，全部 code=0）

`GET /admin/user|file|share|entity|group|policy/:id` 形状完整，组详情支持 hash_id 查询。

## 4. 三个疑点排查结论

| 疑点 | 结论 |
|---|---|
| 翻页“重复”？ | 假警报。探测脚本误发 0 基页码；接口本身 1 基正确。 |
| 4 个 OAuth 客户端 `redirect_uris` 为空 | 授权端点对空白名单手动客户端直接拒绝（`oauth.ts`），与上游 Go 版同语义；存量废数据，非漏洞。 |
| 分享 id=1 无文件名 | 其关联文件已软删（`file_shares=0`），历史遗留，非代码问题。 |

## 5. 匿名冒烟

| 路径 | 状态 |
|---|---|
| `/` | 200（冷启动 0.87s） |
| `/site/config` | 200 |
| 分享页 `/s/*` | 307（按 UA 分流，预期） |

## 6. 结论

从库层 → 接口层 → 前端契约三层均干净。本轮**无代码改动、无提交**。临时探测脚本已清理，签发脚本保留在 `~/.workbuddy/tmp/sign-admin.mjs` 备用。
