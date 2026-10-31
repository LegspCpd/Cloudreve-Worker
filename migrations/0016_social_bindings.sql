-- ---------------------------------------------------------------------------
-- 社交登录绑定（edge 自建 Pro 功能：QQ 互联等 OAuth2 第三方登录）。
--
-- 与 user_oidc_bindings 平行：OIDC 用 (issuer, subject) 唯一，社交登录用
-- (provider, provider_user_id) 唯一。QQ 互联返回的 openid 是「应用维度」稳定
-- 标识，unionid 是「同一开发者跨应用」稳定标识；两者都存，按 openid 唯一约束，
-- unionid 仅作兜底匹配（同一 QQ 用户在不同 App 下 openid 不同但 unionid 相同）。
--
-- 社交登录不提供邮箱，本地账号用合成邮箱（qq_<openid>@<站点域名>），因此本表
-- 的 email 仅作展示/排查用，不作为账号主键。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_social_bindings (
    id                 SERIAL PRIMARY KEY,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ,
    user_id            INTEGER     NOT NULL,
    provider           VARCHAR(32) NOT NULL,
    provider_user_id   VARCHAR(128) NOT NULL,
    union_id           VARCHAR(128),
    email              VARCHAR(255),
    nickname           VARCHAR(255)
);

-- 同一 provider 下同一 provider_user_id 只能绑定一个本地账号
CREATE UNIQUE INDEX IF NOT EXISTS user_social_bindings_provider_uid
    ON user_social_bindings (provider, provider_user_id);

-- 同一用户绑定的所有社交身份（账号设置页列出用）
CREATE INDEX IF NOT EXISTS user_social_bindings_user
    ON user_social_bindings (user_id, deleted_at);

-- unionid 兜底匹配（同一 QQ 用户跨应用）
CREATE INDEX IF NOT EXISTS user_social_bindings_union
    ON user_social_bindings (provider, union_id) WHERE union_id IS NOT NULL;
