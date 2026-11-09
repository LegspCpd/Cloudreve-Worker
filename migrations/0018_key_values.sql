-- =============================================================================
-- 0018_key_values.sql —— 通用 KV 表（EdgeOne 等无 KV 绑定环境的 KV 兜底）
--
-- 背景：Cloudreve 的会话（session）、上传会话锁（upload）、外部凭据缓存
-- （cred）、自举标记（flag）全放在 Workers KV 里。EdgeOne Node 云函数没有
-- KV 绑定，kvRouter 检测到全绑定缺失时把这些键落到这张表。
--
-- 语义对齐 Workers KV：
--   - get/put/delete/list({prefix}) 四个方法（Cloudreve 的全部用量）
--   - put 支持 expirationTtl（写 expire_at）与 metadata（JSON 存同表）
--   - 读时过滤过期行；过期行由 cron（CF）/ 惰性（EdgeOne）清理
--
-- ⚠️ kvStore 的兜底路径会在表缺失时自动 CREATE TABLE IF NOT EXISTS：
--    迁移标记本身也走 KV（flag 角色），没有这张表迁移流程就跑不起来。
-- =============================================================================
CREATE TABLE IF NOT EXISTS key_values (
    key       TEXT PRIMARY KEY,
    value     TEXT NOT NULL,
    metadata  TEXT,
    expire_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_key_values_expire ON key_values (expire_at);
