-- 分享举报（edge 自建 Pro 功能：分享举报处理）。
-- 用户对被举报分享提交 reason + detail；管理员在后台查看并标记处理状态。
CREATE TABLE IF NOT EXISTS share_reports (
    id          SERIAL PRIMARY KEY,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ,
    share_id    INTEGER NOT NULL,
    reporter_id INTEGER,
    reason      VARCHAR(32) NOT NULL DEFAULT 'other',
    detail      TEXT,
    status      VARCHAR(16) NOT NULL DEFAULT 'pending',
    handled_by  INTEGER,
    handled_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_share_reports_status ON share_reports (status);
CREATE INDEX IF NOT EXISTS idx_share_reports_share ON share_reports (share_id);
CREATE INDEX IF NOT EXISTS idx_share_reports_created ON share_reports (created_at DESC);
