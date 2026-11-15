/**
 * 用户 / 用户组的跨请求缓存。
 *
 * ## 为什么需要它
 *
 * `appContext` 中间件在**每一个** API 请求上都会 `byIdWithGroup(uid)` ——
 * 一条 `users JOIN groups` 查询。首屏会并发 6~8 个请求，于是同一个用户
 * 在几百毫秒内被查了 6~8 次。Neon 免费档单次查询 180~550ms，并发超过
 * 6 路还会回 5xx 触发重试，用户感知就是「一直在转圈、存储空间出不来」。
 *
 * 而 `users` / `groups` 是典型的**读极多写极少**数据（改昵称、改容量、
 * 改权限时才写），非常适合缓存。缓存后中间件这一步从 1 次 DB 往返
 * 降到 0 次（L1 命中）或 1 次 KV get（L2 命中）。
 *
 * ## 两级缓存
 *
 *   L1  isolate 内存（Map）：命中即返回，0 网络往返。TTL 很短，因为
 *       isolate 之间不共享，它的作用是吸收「同一 isolate 内的突发并发」
 *       —— 首屏那 6~8 个请求通常落在同一个 isolate 上。
 *   L2  KV：跨 isolate 共享，TTL 较长。L1 未命中时读它，miss 才回源 DB。
 *
 * ## 失效（正确性关键）
 *
 * 缓存用户数据最怕「改了不生效」。三道防线：
 *   1. 写路径显式调 `invalidateUser(id)` / `invalidateGroup(id)`；
 *   2. L1 / L2 都有 TTL，跨 isolate 的改动最多晚 TTL 看到；
 *   3. 缓存的是**完整的 UserWithGroup 行**，但 KV 里不写敏感字段以外的
 *      额外信息 —— 见下方 `sanitizeForKv` 的说明。
 */
import type { Env } from '../env';
import type { UserWithGroup } from '../db/types';
import { kvFor } from '../lib/kvRouter';
import { coloCacheDelete, coloCacheGetJson, coloCachePutJson } from '../lib/coloCache';
import { UserRepo, reviveUserWithGroup } from '../db/repo';
import type { Sql } from '../db';

/** L1 内存存活时间。短 TTL：只吸收同一 isolate 内的突发并发。 */
const L1_TTL_MS = 3_000;
/**
 * L1.5（colo Cache API）新鲜期。低流量站点几乎每请求都是新 isolate，L1 的
 * 3s 内存窗口基本不命中 → 每请求都打一次远端 KV（180~560ms）。这一层与
 * 站点设置同款（见 settings/provider.ts）：同 colo 跨 isolate 共享，命中
 * 1~3ms，把「新 isolate 的第一个访客」从一次 KV 往返降到内存级。
 * 写路径失效时同步删本 colo 的键，跨 colo 靠 TTL 兜底。
 *
 * 取 5 分钟：这是「用户行」而不是设置，封禁/改组这类改动要尽快跨 colo 生效，
 * 不能像设置那样放到半小时。本 colo 的失效是即时的。
 */
const COLO_TTL_S = 300;
/** L2（KV）存活时间。改动最晚这么多秒后自动可见。 */
const L2_TTL_S = 1800;
/** L1 条数上限，防止长驻 isolate 内存无界增长（Workers 有 128MB 限制）。 */
const L1_MAX = 200;

/** colo 缓存键。与 KV 键分开命名空间，避免两层的副本互相污染。 */
const COLO_KEY = (id: number) => `user:v2:${id}`;

const USER_KEY = (id: number) => `user:v2:${id}`;

/**
 * 写入 L2(KV) 前剥离密码哈希等敏感字段。L1 内存缓存保留完整对象（仅用于本请求
 * 鉴权），但 KV 是跨 isolate 共享、可能被导出/日志/分析管道捕获，绝不能把密码哈希
 * 持久化进去，否则一旦泄露可被离线爆破。
 */
function sanitizeUserForKv(u: UserWithGroup): UserWithGroup {
  const { password, ...safe } = u as UserWithGroup & { password?: unknown };
  void password;
  return safe as UserWithGroup;
}

/** L1 条目。 */
const l1 = new Map<number, { at: number; user: UserWithGroup }>();

function l1Get(id: number): UserWithGroup | null {
  const hit = l1.get(id);
  if (!hit) return null;
  if (Date.now() - hit.at > L1_TTL_MS) {
    l1.delete(id);
    return null;
  }
  return hit.user;
}

function l1Set(id: number, user: UserWithGroup): void {
  // 超过上限时删最早插入的（Map 保序 = 插入顺序，够用）。
  if (l1.size >= L1_MAX && !l1.has(id)) {
    const oldest = l1.keys().next();
    if (!oldest.done) l1.delete(oldest.value);
  }
  l1.set(id, { at: Date.now(), user });
}

/**
 * 取用户（带组），优先 L1 → L2 → DB。
 *
 * `db` 是本次请求解析出的 Sql 句柄，回源时用它，保证多库模型下
 * 读写落在同一个库上（见 `db/shard.ts`）。
 */
export async function getCachedUser(
  env: Env,
  sql: Sql,
  id: number,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<UserWithGroup | null> {
  const hit = l1Get(id);
  if (hit) return hit;

  // L1.5：同 colo 跨 isolate 的 Cache API。缓存的是 sanitize 后的副本（无
  // 密码哈希），与 KV 同样经 reviveUserWithGroup 复原 Date / 权限位。
  const coloHit = await coloCacheGetJson<Record<string, unknown>>(COLO_KEY(id), COLO_TTL_S);
  if (coloHit) {
    const user = reviveUserWithGroup(coloHit);
    if (user) {
      l1Set(id, user);
      return user;
    }
    // 形状不对（旧版本键）：按未命中处理，走下面回源覆盖
  }

  // L2：KV。失败不致命 —— 退化成直接查库即可。
  let kv: KVNamespace | null = null;
  try {
    kv = kvFor(env, 'session');
  } catch {
    kv = null;
  }

  if (kv) {
    try {
      const cached = await kv.get(USER_KEY(id), 'json');
      if (cached && typeof cached === 'object') {
        // JSON 反序列化丢了运行时类型（Date→字符串、Uint8Array→普通对象），
        // 必须经 reviveUserWithGroup 复原，否则下游 Date 方法崩、权限位清空。
        const user = reviveUserWithGroup(cached as Record<string, unknown>);
        if (user) {
          l1Set(id, user);
          return user;
        }
        // 形状不对（旧版本键 / 损坏数据）：按未命中处理，走下面的回源
      }
    } catch {
      // KV 抖动时静默退到 DB，不能让缓存问题变成请求失败
    }
  }

  const user = await new UserRepo(sql).byIdWithGroup(id);
  if (!user) return null;

  const safe = sanitizeUserForKv(user);
  // 回填 colo（本地几毫秒）与 KV（远端）。KV 写不阻塞响应：与 settings 的
  // refill 同款，能拿到 waitUntil 就挂后台；拿不到（测试/无 executionCtx）
  // 才 await，保证写入不会因请求结束被取消。
  void coloCachePutJson(COLO_KEY(id), safe, COLO_TTL_S);
  if (kv) {
    try {
      const put = kv
        .put(USER_KEY(id), JSON.stringify(safe), { expirationTtl: L2_TTL_S })
        .catch(() => undefined);
      if (waitUntil) waitUntil(put);
      else await put;
    } catch {
      // KV 绑定异常时静默跳过
    }
  }
  l1Set(id, user);
  return user;
}

/**
 * 主动失效某个用户的缓存（L1 + L2）。
 *
 * 所有改动用户行 / 用户组关联的写路径都应该调用它，否则用户在 TTL 内
 * 看到的还是旧数据（例如改了容量但界面不更新）。
 *
 * 注意：`UserRepo` 的写方法内部已经自动调 `evictUserCache`，所以业务
 * 代码一般**不需要**手动调这个。它留给那些「直接执行裸 SQL 改用户行」
 * 的少数场景使用。
 */
export async function invalidateUser(env: Env, id: number): Promise<void> {
  rememberEnv(env);
  await evictUserCache(id);
}

/**
 * 主动预热某个用户的缓存（L1 + L2）。
 *
 * 注册 / 登录 / 激活成功时调用：这些路径手里已经拿到完整的 UserWithGroup，
 * 顺手写一次 KV（1 次写、0 次 DB 查询），用户随后的第一批请求
 * （/user/me、/file/list…）就能直接命中 L2，省一次 ~200-500ms 的
 * users JOIN groups 回源 —— 这正是「登录后首屏慢」的主要构成之一。
 */
export async function warmUserCache(env: Env, user: UserWithGroup): Promise<void> {
  if (!user || !user.id) return;
  l1Set(user.id, user);
  const safe = sanitizeUserForKv(user);
  void coloCachePutJson(COLO_KEY(user.id), safe, COLO_TTL_S);
  try {
    await kvFor(env, 'session').put(USER_KEY(user.id), JSON.stringify(safe), {
      expirationTtl: L2_TTL_S,
    });
  } catch {
    // 预热是尽力而为，失败不影响业务
  }
}

/** 测试用：清空 L1。 */
export function clearUserCacheMemory(): void {
  l1.clear();
}

/** 测试用：当前 L1 条数。 */
export function userCacheSize(): number {
  return l1.size;
}

/**
 * repo 层用的失效入口。
 *
 * `UserRepo` 只持有 `Sql`，没有 `env`，所以没法直接删 KV 键。这里在
 * 每个请求装配上下文时记下当前 isolate 的 `env`（`rememberEnv`），
 * repo 写完后借它清 L2。
 *
 * 为什么不让 repo 带上 env：那要改 11 个仓储的构造签名和所有调用点，
 * 收益只是省一个模块级变量 —— 而 `env` 在同一个 isolate 内对所有请求
 * 都是同一个对象，记一份完全等价。
 *
 * 记不到 env 时（例如在请求外调用 repo）只清 L1，L2 靠 TTL 兜底 ——
 * 这不会导致数据错误，最坏是晚 `L2_TTL_S` 秒生效。
 */
let currentEnv: Env | null = null;

/** 请求装配时调用，记下本 isolate 的 env 供 repo 层失效使用。 */
export function rememberEnv(env: Env): void {
  currentEnv = env;
}

/** 清掉某用户的 L1 + L2 缓存。repo 写方法内部调用。 */
export async function evictUserCache(id: number): Promise<void> {
  l1.delete(id);
  // 本 colo 的副本必须同步删，否则改了容量/权限后同节点后续请求还能从
  // colo 读到旧用户（最长 COLO_TTL_S）。其它 colo 靠 TTL 与 KV 传播兜底。
  void coloCacheDelete(COLO_KEY(id));
  const env = currentEnv;
  if (!env) return;
  try {
    await kvFor(env, 'session').delete(USER_KEY(id));
  } catch {
    // 删不掉就靠 TTL 兜底
  }
}
