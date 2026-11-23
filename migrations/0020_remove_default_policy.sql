-- =============================================================================
-- 0020_remove_default_policy.sql —— 移除播种的「R2 Default」存储策略
--
-- 自举不再创建默认策略，也不再给系统组硬绑策略。存量库里那条由旧版
-- provision/seed 插入的 R2 Default（通常是 id=1）在这里清掉：
--   1. 解绑 groups / group_storage_policies / nodes；
--   2. 清掉用户 settings 里指向它的 upload_policy_id；
--   3. 软删策略本身（不物理删，避免误伤历史审计/引用）。
--
-- 安全闸：若已有 files / entities 挂在这条策略上，整组操作跳过 —— 否则
-- 文件会失去策略归属，下载/缩略图直接 40035。等管理员把文件迁走后再跑
-- 一次同样的迁移（或手动删除）即可。
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
), blocked AS (
  SELECT 1
  WHERE EXISTS (
    SELECT 1 FROM files f JOIN target t ON f.storage_policy_files = t.id
  ) OR EXISTS (
    SELECT 1 FROM entities e JOIN target t ON e.storage_policy_entities = t.id
  )
)
UPDATE groups g
SET storage_policy_id = NULL, updated_at = now()
FROM target t
WHERE g.storage_policy_id = t.id
  AND NOT EXISTS (SELECT 1 FROM blocked);

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    -- 用户改名过的播种行：靠「id=1 + 无 AK + relay」这个独有指纹认
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), blocked AS (
  SELECT 1
  WHERE EXISTS (
    SELECT 1 FROM files f JOIN target t ON f.storage_policy_files = t.id
  ) OR EXISTS (
    SELECT 1 FROM entities e JOIN target t ON e.storage_policy_entities = t.id
  )
)
DELETE FROM group_storage_policies gsp
USING target t
WHERE gsp.policy_id = t.id
  AND NOT EXISTS (SELECT 1 FROM blocked);

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    -- 用户改名过的播种行：靠「id=1 + 无 AK + relay」这个独有指纹认
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), blocked AS (
  SELECT 1
  WHERE EXISTS (
    SELECT 1 FROM files f JOIN target t ON f.storage_policy_files = t.id
  ) OR EXISTS (
    SELECT 1 FROM entities e JOIN target t ON e.storage_policy_entities = t.id
  )
)
UPDATE nodes n
SET storage_policy_nodes = NULL, updated_at = now()
FROM target t
WHERE n.storage_policy_nodes = t.id
  AND NOT EXISTS (SELECT 1 FROM blocked);

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    -- 用户改名过的播种行：靠「id=1 + 无 AK + relay」这个独有指纹认
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), blocked AS (
  SELECT 1
  WHERE EXISTS (
    SELECT 1 FROM files f JOIN target t ON f.storage_policy_files = t.id
  ) OR EXISTS (
    SELECT 1 FROM entities e JOIN target t ON e.storage_policy_entities = t.id
  )
)
UPDATE users u
SET settings = u.settings - 'upload_policy_id', updated_at = now()
FROM target t
WHERE u.settings ->> 'upload_policy_id' ~ '^[0-9]+$'
  AND (u.settings ->> 'upload_policy_id')::integer = t.id
  AND NOT EXISTS (SELECT 1 FROM blocked);

WITH target AS (
  SELECT id FROM storage_policies
  WHERE deleted_at IS NULL AND (
    name = 'R2 Default'
    -- 用户改名过的播种行：靠「id=1 + 无 AK + relay」这个独有指纹认
    OR (id = 1 AND COALESCE(settings->>'relay', 'false') = 'true'
                AND (access_key IS NULL OR access_key = ''))
  )
), blocked AS (
  SELECT 1
  WHERE EXISTS (
    SELECT 1 FROM files f JOIN target t ON f.storage_policy_files = t.id
  ) OR EXISTS (
    SELECT 1 FROM entities e JOIN target t ON e.storage_policy_entities = t.id
  )
)
UPDATE storage_policies sp
SET deleted_at = now(), updated_at = now()
FROM target t
WHERE sp.id = t.id
  AND NOT EXISTS (SELECT 1 FROM blocked);
