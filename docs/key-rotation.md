# 文件加密主密钥轮换

加密文件密钥在库里用 `ENCRYPTION_MASTER_KEY`（缺省回落 `JWT_SECRET` 或 `settings.secret_key`）做信封加密。换这把密钥会让历史加密文件解不开，必须先把存量 `entities.enc_meta` 重加密到新密钥。

工具：`scripts/rotate-master-key.mjs`（与上游 Go 版 `cmd/masterkey.go` 同义）。

## 目录

- [环境变量](#环境变量)
- [零停机流程（推荐）](#零停机流程推荐)
- [带停机流程](#带停机流程)
- [命令速查](#命令速查)
- [密钥材料取值](#密钥材料取值)
- [排错](#排错)
- [说明](#说明)

## 环境变量

| 变量 | 用途 | 默认值 |
|---|---|---|
| `ENCRYPTION_MASTER_KEY` | 当前主密钥材料（换届后 = 新密钥） | 回落 `JWT_SECRET` → `settings.secret_key` |
| `ENCRYPTION_MASTER_KEY_PREVIOUS` | 过渡期旧密钥，app 端 `importCtrKey` 用它解旧信封 | 空（不启用回退） |
| `DATABASE_URL` | 目标库连接串 | 也可放 `edge/.dev.vars` |
| `DB_PROVIDER` | `neon` / `postgres`，不显式则按域名推断 | 按连接串域名 |

## 零停机流程（推荐）

| 步骤 | 操作 | 环境变量 |
|---|---|---|
| 1 | 部署同时持有新、旧两把密钥 | `ENCRYPTION_MASTER_KEY=新`、`ENCRYPTION_MASTER_KEY_PREVIOUS=旧` |
| 2 | 跑脚本重加密存量记录 | `--old-key 旧 --new-key 新` |
| 3 | 验证全部能用新密钥解封 | `--new-key 新 --verify` |
| 4 | 去掉 `ENCRYPTION_MASTER_KEY_PREVIOUS`，再部署一次 | 只留 `ENCRYPTION_MASTER_KEY=新` |

过渡期 `importCtrKey` 已支持用 `PREVIOUS` 解旧信封，所以第 2 步跑多久都不影响线上读写。

## 带停机流程

停写 → 跑脚本 → 把 `ENCRYPTION_MASTER_KEY` 切到新值并部署 → 恢复。

## 命令速查

```bash
# 先看影响多少行（不写库）
node scripts/rotate-master-key.mjs --old-key "$OLD" --new-key "$NEW" --dry-run

# 正式轮换
node scripts/rotate-master-key.mjs --old-key "$OLD" --new-key "$NEW"

# 旧密钥当初没配 ENCRYPTION_MASTER_KEY、走 secret_key 兜底
node scripts/rotate-master-key.mjs --old-from-db --new-key "$NEW"

# 轮换后验证：所有 enc_meta 都能用新密钥解封（应 100% 通过）
node scripts/rotate-master-key.mjs --new-key "$NEW" --verify

# 等价 npm 脚本
npm run db:rotate-key -- --old-key "$OLD" --new-key "$NEW"
```

完整参数见 `node scripts/rotate-master-key.mjs --help`。

## 密钥材料取值

脚本的 `--old-key` / `--new-key` 必须和线上 `deriveFileMasterKey` 用的材料**完全一致**：

- 部署配了 `ENCRYPTION_MASTER_KEY` → 就是那个变量的值；
- 没配则回落 `JWT_SECRET` 或 `settings.secret_key`：
  - `--old-from-db` 读 `settings.secret_key`；
  - 若实际回落的是 `JWT_SECRET`，需 `--old-key "$JWT_SECRET"`。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `旧密钥派生失败` | `--old-key` 与线上材料不一致；确认回落的是 `secret_key` 还是 `JWT_SECRET` |
| `旧/新密钥都解不开，疑似损坏` | 该记录 `enc_meta` 已损坏，脚本跳过并列出，不影响其余行 |
| `新密钥解封失败`（verify） | 轮换未完全或旧密钥错误，重跑轮换 |
| 轮换后仍有文件打不开 | 确认 `ENCRYPTION_MASTER_KEY_PREVIOUS` 已配置；先别删旧密钥 |

## 说明

- 脚本可重入：已轮换的行会跳过，中断后重跑即可。
- 历史明文密钥记录（无 `key_wrapped`）会顺手用新密钥封好，不再落明文。
- 失败的行不会覆盖，会在结尾列出，修好后重跑。
