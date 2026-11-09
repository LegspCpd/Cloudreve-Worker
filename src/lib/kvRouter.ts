/**
 * KV 多实例路由。
 *
 * 动机：单个 KV namespace 在突发并发下也会成为热点（KV get 实测 180~560ms，
 * 免费档单 namespace 有写入频率上限）。把多个 namespace 按**键的语义分类**
 * 固定分工，既分散压力，又保证同一类键永远落在同一个 namespace 里
 * —— 后者是关键：如果按 `hash(key) % N` 动态分布，改一次 N 就会让**全部**
 * 缓存失效、并且旧键永远删不掉（delete 只能删算出来的那一个）。
 *
 * 分工（见 `KvRole`）：
 *   - `site`    站点设置缓存。读最频繁，单独一个 namespace。
 *   - `session` 会话类一次性状态：token 吊销名单、2FA 会话、密码重置、
 *               登录验证码、OIDC state、OAuth auth code、passkey 挑战。
 *   - `upload`  上传会话、打包下载会话、WebDAV 锁、WOPI 会话。
 *   - `cred`    OneDrive 凭据缓存、OIDC discovery 文档缓存。
 *   - `flag`    自举/迁移标记（provision MARKER、BOOTSTRAP_FLAG 等）。
 *               必须与业务缓存分开：它决定冷启动行为，混在一起会让
 *               「清缓存」误伤自举标记。
 *
 * **绑定缺失时自动回退到 `KV`**。这是让 N>1 能平滑上线的前提：老部署
 * 只有 `KV` 一个绑定，新代码直接用 `env.KV_1` 会拿到 `undefined` 而在
 * `.get()` 上崩；回退后老部署行为与改动前完全一致，不需要重新部署配置。
 */
import type { Env } from '../env';
import { getSql } from '../db';
import { createDbKv } from '../db/kvStore';

/** KV 的语义角色。见文件头注释的分工表。 */
export type KvRole = 'site' | 'session' | 'upload' | 'cred' | 'flag';

/**
 * 角色 → 绑定名优先级列表。
 *
 * `KV` 永远排在最后作为兜底。中间那些 `KV_n` 由 `wrangler.toml` 声明
 * （`KV_COUNT` 控制声明几个），缺失时自动降到下一个，所以：
 *   - `KV_COUNT=1` → 只有 `KV`，五个角色全部指向它（= 改动前行为）；
 *   - `KV_COUNT=5` → 五个角色各拿一个独立的 namespace。
 */
const ROLE_BINDINGS: Record<KvRole, readonly string[]> = {
  flag: ['KV_5', 'KV'],
  site: ['KV_1', 'KV'],
  session: ['KV_2', 'KV'],
  upload: ['KV_3', 'KV'],
  cred: ['KV_4', 'KV'],
};

/**
 * 按角色取 namespace。
 *
 * 注意：返回的不是原始绑定，而是**带角色前缀代理**的包装。这样同一个
 * namespace 被多个角色共享时（`KV_COUNT=1` 的降级场景），不同角色的键
 * 仍然互不覆盖 —— 否则 `flag` 的 `provision:schema` 可能和业务键撞名。
 */
export function kvFor(env: Env, role: KvRole): KVNamespace {
  const bindings = env as unknown as Record<string, KVNamespace | undefined>;
  for (const name of ROLE_BINDINGS[role]) {
    const ns = bindings[name];
    if (ns) return withPrefixGuard(ns, role, name);
  }

  // 全部绑定缺失（EdgeOne Node 云函数等无 KV 环境）→ 落 DB 表兜底。
  // key_values 表（迁移 0018）由 kvStore 首次使用时自动建，迁移标记本身
  // 也走这条兜底，鸡生蛋问题就此解决。CF 部署有绑定，永远走不到这里。
  const sql = getSql(env);
  return withPrefixGuard(createDbKv(sql) as unknown as KVNamespace, role, 'db-key-values');
}

/** 默认角色：站点设置这类「读多写少、与请求语义无关」的缓存。 */
export function defaultKv(env: Env): KVNamespace {
  return kvFor(env, 'session');
}

/**
 * 一次解析好的全部 KV 角色。
 *
 * 解析一次、挂到 `AppContext` 上，请求内所有服务从 bundle 取 —— 避免
 * 每个调用点各自 `kvFor(env, role)`（每次都要走绑定名查找 + Proxy 记忆化）。
 * 这不只是性能考虑：集中解析让「哪些角色存在」在一个请求内是**一致快照**。
 */
export interface KvBundle {
  /** 站点设置缓存 */
  site: KVNamespace;
  /** 会话类一次性状态（吊销名单 / 2FA / 验证码 / OIDC state / OAuth code / passkey） */
  session: KVNamespace;
  /** 长生命周期业务状态（上传会话 / 打包会话 / WebDAV 锁 / WOPI） */
  upload: KVNamespace;
  /** 外部服务凭据与元数据缓存（OneDrive token / OIDC discovery） */
  cred: KVNamespace;
  /** 自举 / 迁移标记 */
  flag: KVNamespace;
}

/** 解析全部角色。绑定缺失时逐角色回落到 `KV`。 */
export function defaultKvBundle(env: Env): KvBundle {
  return {
    site: kvFor(env, 'site'),
    session: kvFor(env, 'session'),
    upload: kvFor(env, 'upload'),
    cred: kvFor(env, 'cred'),
    flag: kvFor(env, 'flag'),
  };
}

/**
 * 已经带过前缀的 namespace 缓存。
 *
 * 按 `(namespace 对象, 角色)` 记忆化：同一个 isolate 内重复取同一角色
 * 不会反复创建包装层（`Proxy` 创建成本低，但每次 `get` 都要判前缀，
 * 攒起来也可观）。用 `WeakMap` 以 namespace 为键，避免拖住绑定对象。
 */
const wrapped = new WeakMap<KVNamespace, Map<KvRole, KVNamespace>>();

/**
 * 给 namespace 加一层「角色前缀」。
 *
 * 只包装 `get` / `put` / `delete` / `list` 四个热方法，其余（`getWithMetadata`）
 * 通过原型转发 —— `KVNamespace` 是个接口，`Proxy` 的 get 陷阱天然支持转发。
 *
 * 前缀规则：`<role>:` 开头。`list({prefix})` 会把这个前缀叠在调用方
 * 传进来的 prefix 之前，所以 `list({prefix: 'upload_'})` 实际列出的是
 * `<role>:upload_` 开头的键 —— 调用方无需感知。
 */
function withPrefixGuard(ns: KVNamespace, role: KvRole, bindingName: string): KVNamespace {
  let byRole = wrapped.get(ns);
  if (!byRole) {
    byRole = new Map();
    wrapped.set(ns, byRole);
  }
  const hit = byRole.get(role);
  if (hit) return hit;

  const prefix = `${role}:`;
  const p = (key: string) => `${prefix}${key}`;
  /**
   * 幂等加前缀。
   *
   * ## 为什么必须有这个（真实踩过的坑）
   *
   * `list()` 返回的键名是**已经带过角色前缀的完整键**（底层 namespace
   * 不知道「角色」这回事，它只认识完整键名）。于是「list 出来的键名」
   * 直接回传给同一层代理的 `delete`，就会**被再叠一次前缀**：
   *
   *     list({prefix:'settings:'}) → 返回 'site:settings:all:v1'
   *     delete('site:settings:all:v1') → 实际删 'site:site:settings:all:v1'
   *
   * 结果：**一个键都没删掉，而且不报任何错** —— 静默失效。
   * 「清空缓存」这类运维动作如果静默失效，你会以为清干净了，实际
   * 每一版脏数据都留在原地，正是本项目踩过的那类最难查的问题
   * （见 README 的 siteConfigSlice 缓存事故）。
   *
   * 所以：已经带前缀的键**原样返回**，只给没带的加。
   * 注意这里只判断「以本角色前缀开头」而不是「含任意角色前缀」——
   * 因为同一个 namespace 可能被多个角色共享（KV_COUNT 小时回退到
   * 兜底 KV），此时 `session:...` 这类键必须能原样删掉，不能再叠
   * 一层 `site:`（那样会删错键）。判断本角色前缀即可覆盖 list 往返。
   */
  const pIdem = (key: string) => (key.startsWith(prefix) ? key : `${prefix}${key}`);

  const proxy = new Proxy(ns, {
    get(target, prop, receiver) {
      switch (prop) {
        case '__kvRole':
          return role;
        case '__kvBinding':
          return bindingName;
        case 'get':
          return (key: string, ...rest: unknown[]) =>
            (target.get as (...a: unknown[]) => unknown)(pIdem(key), ...rest);
        case 'put':
          return (key: string, ...rest: unknown[]) =>
            (target.put as (...a: unknown[]) => unknown)(pIdem(key), ...rest);
        case 'delete':
          // KV 的绑定 API 只接受**单个键名**（`delete(key: Key): Promise<void>`，
          // 见 workers-types；与 Durable Object 的 `delete(keys[])` 不同，
          // KV **没有**批量删）。
          // 这里仍然显式拒绝数组：`prefix + array` 会走 Array.toString()
          // 拼成 "role:a,b" 这种根本不存在的键，删不掉任何东西且不报错 ——
          // 静默失效是最糟的形态，宁可让它当场炸出来。
          return (key: string) => {
            if (Array.isArray(key)) {
              throw new TypeError(
                'kvFor(...).delete() 不接受数组：KV 绑定没有批量删。逐键删，或改用 wrangler CLI 的 bulk delete。',
              );
            }
            return target.delete(pIdem(key));
          };
        case 'list': {
          return (opts?: { prefix?: string }) => {
            const next = { ...(opts ?? {}) };
            next.prefix = p(next.prefix ?? '');
            return target.list(next);
          };
        }
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  }) as KVNamespace;

  byRole.set(role, proxy);
  return proxy;
}

/**
 * 供诊断用：列出当前 env 上实际存在的 KV 绑定名。
 * 只读，不改任何状态。
 */
export function listKvBindings(env: Env): string[] {
  const bindings = env as unknown as Record<string, unknown>;
  return Object.keys(bindings)
    .filter((k) => /^KV(_\d+)?$/.test(k))
    .sort();
}
