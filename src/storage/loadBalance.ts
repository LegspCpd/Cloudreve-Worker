/**
 * 负载均衡虚拟策略。
 *
 * 上游开源版没有 load_balance 的服务端实现（前端枚举与「Pro」标是给
 * 闭源 Pro 用的）。边缘版语义：
 *   - load_balance 策略**没有自己的驱动**，`settings.slave_policy_ids`
 *     指向一组真实存储策略，`settings.load_balance_mode` 决定选路算法；
 *   - 在策略解析层（context.resolvePolicy / groupPolicies）把它展开：
 *     上传时选中一个 slave，文件/实体落库记录的是 slave 的 id ——
 *     所以下载、直链、缩略图、预览全部走 slave 的真实驱动，天然工作；
 *   - 它永不下发给用户侧策略列表（groupPolicies 展开为 slave 并集），
 *     用户上传器看到的永远是具体策略，无感知。
 *
 * 选路算法：
 *   - `random`（默认）：每次上传随机挑一个；
 *   - `round_robin`：isolate 内轮询计数。跨 isolate 不保证严格轮流
 *     （KV 计数要给每次上传加一次往返，不值得），但分布足够均匀。
 */
import type { StoragePolicyRow } from '../db/types';
import { AppError } from '../lib/errors';
import { PolicyType } from '../lib/boolset';
import type { AppContext } from '../services/context';
import { isPolicyTypeSupported } from './index';

export type LoadBalanceMode = 'random' | 'round_robin';

/** isolate 内的轮询计数器（键 = load_balance 策略 id）。 */
const roundRobinCounters = new Map<number, number>();

/** 读出配置的 slave id 列表（容错：非法 JSON / 错误类型一律空数组）。 */
export function slavePolicyIds(policy: StoragePolicyRow): number[] {
  const raw = policy.settings?.slave_policy_ids;
  if (!Array.isArray(raw)) return [];
  return raw
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}

export function loadBalanceMode(policy: StoragePolicyRow): LoadBalanceMode {
  return policy.settings?.load_balance_mode === 'round_robin' ? 'round_robin' : 'random';
}

/**
 * 子策略权重（对齐官方 Pro 文档：权重越大被选概率越高，0 不参与选路）。
 * 键为 slave 策略 id 的字符串形式；未配置权重的 slave 默认权重 1。
 */
export function slaveWeights(policy: StoragePolicyRow): Record<number, number> {
  const raw = policy.settings?.slave_policy_weights;
  const out: Record<number, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const id = Number(k);
      const w = Number(v);
      if (Number.isInteger(id) && id > 0 && Number.isFinite(w) && w >= 0) out[id] = w;
    }
  }
  return out;
}

export function isLoadBalancePolicy(policy: StoragePolicyRow): boolean {
  return policy.type === PolicyType.LoadBalance;
}

/**
 * 展开 load_balance 为「可用的 slave 集合」（去重、按 id 排序、
 * 过滤已删除 / 类型无驱动的；slave 若嵌套 load_balance 一并忽略）。
 * 空集抛带策略名的明确错误 —— 上传时会直接展示给管理员看。
 */
export async function expandLoadBalance(
  ctx: Pick<AppContext, 'policies'>,
  policy: StoragePolicyRow,
): Promise<StoragePolicyRow[]> {
  const ids = slavePolicyIds(policy);
  if (ids.length === 0) {
    throw new AppError(40006, `负载均衡策略「${policy.name}」没有配置任何存储策略`);
  }
  const rows = await ctx.policies.byIds(ids);
  const usable = rows.filter((p) => isPolicyTypeSupported(p.type)).sort((a, b) => a.id - b.id);
  if (usable.length === 0) {
    throw new AppError(40006, `负载均衡策略「${policy.name}」配置的存储策略均不可用`);
  }
  return usable;
}

/** 展开 + 按权重/算法挑出一个实际 slave 策略（上传/解析策略时的主入口）。 */
export async function pickSlavePolicy(
  ctx: Pick<AppContext, 'policies'>,
  policy: StoragePolicyRow,
): Promise<StoragePolicyRow> {
  const slaves = await expandLoadBalance(ctx, policy);
  if (slaves.length === 1) return slaves[0]!;

  // 官方权重语义：权重越大被选概率越高，权重 0 不参与；全部为 0（配置
  // 错误）时兜底等概率，避免上传直接失败。
  const weights = slaveWeights(policy);
  const candidates = slaves.filter((s) => (weights[s.id] ?? 1) > 0);
  const pool = candidates.length > 0 ? candidates : slaves;

  if (loadBalanceMode(policy) === 'round_robin' && candidates.length === pool.length) {
    // 轮询只在「未被权重过滤」时有明确语义
    const next = (roundRobinCounters.get(policy.id) ?? Math.floor(Math.random() * pool.length)) % pool.length;
    roundRobinCounters.set(policy.id, next + 1);
    return pool[next]!;
  }
  // 加权随机
  const total = pool.reduce((sum, s) => sum + (weights[s.id] ?? 1), 0);
  // 全部权重为 0 时 total 也是 0：此时 `r < 0` 永不成立，会一路落到
  // 「最后一个」，跟大家都是 0 权重（配置错误）时的等概率兜底不符。
  if (total <= 0) return pool[Math.floor(Math.random() * pool.length)]!;
  let r = Math.random() * total;
  for (const s of pool) {
    r -= weights[s.id] ?? 1;
    if (r < 0) return s;
  }
  return pool[pool.length - 1]!;
}

/**
 * 管理端创建/更新 load_balance 策略时校验 settings：
 * slave 列表非空、全部真实存在、类型有驱动、不嵌套负载均衡、算法合法。
 */
export async function validateLoadBalanceSettings(
  policiesRepo: Pick<AppContext, 'policies'>['policies'],
  settings: Record<string, unknown> | undefined,
): Promise<void> {
  const raw = settings?.slave_policy_ids;
  const ids = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (ids.length === 0) {
    throw new AppError(40006, '负载均衡策略至少需要选择一个存储策略');
  }
  const unique = Array.from(new Set(ids));
  const rows = await policiesRepo.byIds(unique);
  if (rows.length !== unique.length) {
    throw new AppError(40006, '负载均衡配置中包含不存在的存储策略');
  }
  for (const row of rows) {
    if (isLoadBalancePolicy(row)) {
      throw new AppError(40006, '负载均衡策略不支持嵌套负载均衡');
    }
    if (!isPolicyTypeSupported(row.type)) {
      throw new AppError(40006, `存储策略「${row.name}」的类型在此部署不可用`);
    }
  }
  const mode = settings?.load_balance_mode;
  if (mode !== undefined && mode !== 'random' && mode !== 'round_robin') {
    throw new AppError(40006, 'load_balance_mode 仅支持 random / round_robin');
  }
  const rawWeights = settings?.slave_policy_weights;
  if (rawWeights !== undefined) {
    if (rawWeights === null || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
      throw new AppError(40006, 'slave_policy_weights 必须是 {策略id: 权重} 对象');
    }
    for (const [, v] of Object.entries(rawWeights as Record<string, unknown>)) {
      const w = Number(v);
      if (!Number.isFinite(w) || w < 0 || w > 10000) {
        throw new AppError(40006, '权重必须是 0-10000 之间的数字');
      }
    }
  }
}
