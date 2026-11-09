/**
 * 定时任务主体。CF 的 `scheduled`（wrangler.toml crons）与 EdgeOne 的
 * HTTP cron 端点（`POST /api/v4/site/cron/tick`，见 routes/site.ts）共用。
 *
 * 做三件事，任何一件失败都不影响后面的：
 *   1. 缓存刷新：站点设置等缓存回源重写，防止「某条写路径漏了失效」长期陈旧。
 *   2. 回收站到期清理（原版队列任务 trash_collector）。
 *   3. 过期限速计数清理 + 从节点任务状态同步。
 *
 * ⚠️ 刻意不做「清空 KV」：逐键删会烧光免费档 50 subrequests 预算；
 * 「清空再重填」在构建期由 scripts/kv-purge-refill.mjs 完成。这里只负责刷新。
 */
import type { Env } from '../env';
import { AppContext } from './context';
import { kvFor } from '../lib/kvRouter';
import { getSql } from '../db';
import { loadSettings } from '../settings/provider';
import { HashIDCodec } from '../lib/hashid';
import { JWTService } from '../lib/jwt';
import { describeError } from '../lib/errors';
import { warmAllCaches } from './cacheWarmer';
import { applyDomainDownFromKv } from '../db/shard';
import { ensureDomainShards } from '../db/domainBootstrap';
import { warmPolicyCache } from './policyCache';
import { FileSystemService } from './fs';
import { syncNodeTasks } from './nodeTasks';
import { BOOTSTRAP_FLAG } from '../db/provision';

/** EdgeOne HTTP cron 的节流窗口：这个端点是公开的，别让它被当 DoS 放大器。 */
export const CRON_TICK_THROTTLE_MS = 10 * 60 * 1000;

export async function runCronTasks(env: Env): Promise<void> {
  // 自举没完成（刚部署、还没人访问过）时 settings 表可能还不存在，
  // 定时任务直接跳过 —— 第一次网页请求会完成自举。
  try {
    if (!(await kvFor(env, 'flag').get(BOOTSTRAP_FLAG))) {
      console.log('cron: skipped (bootstrap not finished yet)');
      return;
    }
  } catch {
    // KV 都不可用就没什么可刷新的，等下一轮
    return;
  }

  // 1. 缓存刷新。独立 try —— 刷新失败不能影响下面的回收站清理。
  try {
    const warmed = await warmAllCaches(env);
    const failed = warmed.filter((w) => !w.ok).map((w) => w.id);
    console.log(
      failed.length === 0
        ? `cron: cache refreshed (${warmed.length} entries)`
        : `cron: cache refresh partial, failed=[${failed.join(',')}]`,
    );
  } catch (e) {
    console.error('cron: cache refresh failed', describeError(e));
  }

  // 1.5 分域自举兜底（幂等，自举时域库恰好不可用的话这里补上）
  //     + 策略行预热进 L1/KV（读极多的热数据，空闲后首个请求直接命中缓存）。
  try {
    await applyDomainDownFromKv(env);
    await ensureDomainShards(env);
  } catch (e) {
    console.error('cron: domain shard bootstrap failed', describeError(e));
  }
  try {
    const n = await warmPolicyCache(env);
    console.log(`cron: policy cache warmed (${n} rows)`);
  } catch (e) {
    console.error('cron: policy cache warm failed', describeError(e));
  }

  // 2. 回收站到期清理。
  try {
    const settings = await loadSettings(env);
    const appCtx = new AppContext(
      env,
      settings,
      new HashIDCodec(settings.hashIdSalt),
      new JWTService(settings.secretKey),
    );
    const removed = await new FileSystemService(appCtx).purgeExpiredTrash();
    if (removed > 0) {
      console.log(`trash collector: purged ${removed} expired item(s)`);
    }
  } catch (e) {
    // 定时任务不该因为一次失败就中断后续调度；这里只记日志，不向上抛。
    // 部分错误对象（跨序列化边界）会丢 message，把全部字段 dump 出来
    // 才能在日志里看到真实原因，而不是只剩一行堆栈帧。
    console.error('trash collector failed', describeError(e));
  }

  // 3. 清掉过期的限速计数（窗口外的行已经没用，留着只会越长越大）。
  try {
    const sql = getSql(env);
    await sql('DELETE FROM rate_limits WHERE window_start < EXTRACT(EPOCH FROM now())::bigint - 3600');
  } catch (e) {
    console.error('rate limit cleanup failed', describeError(e));
  }

  // 4. 从节点任务状态同步。没有从节点的部署这一步是零查询（LIKE 匹配为空）。
  try {
    const synced = await syncNodeTasks(env);
    if (synced.checked > 0) {
      console.log(`node task sync: checked=${synced.checked} updated=${synced.updated}`);
    }
  } catch (e) {
    console.error('node task sync failed', describeError(e));
  }
}
