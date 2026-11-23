-- =============================================================================
-- 0021_remove_default_policy.sql —— 移除播种的「R2 Default」存储策略
--
-- 自举不再创建默认策略，也不再给系统组硬绑策略。存量库里那些由旧版
-- provision/seed 插入的 R2 Default（通常 id=1）在这里清掉：
--   1. 解绑 groups / group_storage_policies / nodes；
--   2. 清掉用户 settings 里指向它的 upload_policy_id；
--   3. 软删策略本身（不物理删，避免误伤历史审计/引用）。
--
-- 安全闸按**每条策略**判断：有 files / entities 挂着的策略整组跳过 ——
-- 否则文件会失去策略归属，下载/缩略图直接 40035。没有引用的同名策略照删，
-- 不会因为另一条策略有文件而跟着留在库里。
--
-- 幂等：软删后 target 不再命中，重放为空操作。
-- =============================================================================
WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    -- 用户改名过的播种行：靠「id=1 + 无 AK + relay」这个独有指纹认
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), safe AS (
  SELECT t.id FROM target t
  WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.storage_policy_files = t.id)
    AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.storage_policy_entities = t.id)
)
UPDATE groups g
SET storage_policy_id = NULL, updated_at = now()
FROM safe s
WHERE g.storage_policy_id = s.id;

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), safe AS (
  SELECT t.id FROM target t
  WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.storage_policy_files = t.id)
    AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.storage_policy_entities = t.id)
)
DELETE FROM group_storage_policies gsp
USING safe s
WHERE gsp.policy_id = s.id;

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), safe AS (
  SELECT t.id FROM target t
  WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.storage_policy_files = t.id)
    AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.storage_policy_entities = t.id)
)
UPDATE nodes n
SET storage_policy_nodes = NULL, updated_at = now()
FROM safe s
WHERE n.storage_policy_nodes = s.id;

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), safe AS (
  SELECT t.id FROM target t
  WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.storage_policy_files = t.id)
    AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.storage_policy_entities = t.id)
)
UPDATE users u
SET settings = u.settings - 'upload_policy_id', updated_at = now()
FROM safe s
WHERE u.settings ->> 'upload_policy_id' ~ '^[0-9]+$'
  AND (u.settings ->> 'upload_policy_id')::integer = s.id;

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), safe AS (
  SELECT t.id FROM target t
  WHERE NOT EXISTS (SELECT 1 FROM files f WHERE f.storage_policy_files = t.id)
    AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.storage_policy_entities = t.id)
)
UPDATE storage_policies sp
SET deleted_at = now(), updated_at = now()
FROM safe s
WHERE sp.id = s.id;
