-- =============================================================================
-- 0019_direct_link_slug.sql —— 直链的随机 / 自定义短码
--
-- 原直链是 /f/<hashid>/<文件名>：hashid 本身不可猜，但后面跟真实文件名，
-- 别人一眼能看到文件叫什么。这里给 direct_links 加一个可选 slug，
-- 前端「获取直链」默认生成随机短码，用户也可以自己填。
--
-- 短链走 /d/<slug>，302 到原有的文件直链（复用全部权限校验与限速）。
--
-- 升级兼容：ADD COLUMN IF NOT EXISTS + 唯一索引允许多个 NULL，
-- 存量直链没有 slug 照旧用 /f/ 访问，不受影响。
-- =============================================================================
ALTER TABLE direct_links ADD COLUMN IF NOT EXISTS slug TEXT;

-- 用部分唯一索引：只约束非空 slug，空值不互斥（存量行全是 NULL）
CREATE UNIQUE INDEX IF NOT EXISTS direct_links_slug ON direct_links (slug) WHERE slug IS NOT NULL;
