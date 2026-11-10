/**
 * 阿里云 ESA（函数和 Pages）入口。
 *
 * 协议差异（官方文档「函数变量」）：
 *   ESA:     fetch(request, context, env)   ← env 是第三个参数
 *   Workers: fetch(request, env, ctx)
 * 这里只做参数换位 + env 构造，业务逻辑全部复用 src/index.ts。
 *
 * ESA 运行时的能力边界（官方 Runtime API / 使用限制）：
 *   - 有 process.env（仅 env / nextTick 子接口）、Buffer、Crypto、
 *     AsyncLocalStorage、Streams；**没有 net/tls**
 *   - 因此数据库统一走 Neon HTTP（DB_PROVIDER 强制 neon，postgres.js 被
 *     构建期 alias 成占位模块），SMTP 直连不可用（socket-stub）
 *   - 没有 KV 绑定（EdgeKV 是另一套 API），kvRouter 自动落 DB 兜底
 *     （key_values 表，与 EdgeOne 同一套实现）
 *   - 没有 R2/ASSETS 绑定：静态文件由 esa.jsonc 的 assets.directory 托管，
 *     SPA 导航请求由 notFoundStrategy: singlePageApplication 回 index.html，
 *     **不会进函数** —— 所以这里不需要 SPA 壳兜底逻辑
 *   - 单次执行最多 4 个子请求、网关 10 秒等待：这是平台硬限制，多次
 *     DB 往返的接口在 ESA 上可能触顶，属于部署形态的取舍
 *
 * 环境变量：ESA 控制台「函数变量」。运行时同时支持 process.env 与 fetch
 * 第三个参数 env，这里两者合并（第三个参数优先）。DATABASE_URL 必填，
 * 必须是 Neon 连接串。
 */
import app from '../src/index';
import type { Env } from '../src/env';

interface EsaContext {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export default {
  async fetch(
    request: Request,
    context: EsaContext | undefined,
    envVars: Record<string, string> | undefined,
  ): Promise<Response> {
    const merged = {
      ...(globalThis as { process?: { env?: Record<string, string> } }).process?.env,
      ...(envVars ?? {}),
    } as Record<string, string>;

    // 不进 Hono、不查库的运行时诊断：ESA 上运行出错时先分清「变量没传进来」
    // 和「DB 子请求被平台限额掐断」。只回布尔与脱敏 host，不回任何密钥。
    if (new URL(request.url).pathname === '/__esa_diag') {
      const raw = merged.DATABASE_URL ?? '';
      let host = '';
      try {
        host = raw ? new URL(raw.replace(/^postgres(ql)?:/, 'http:')).hostname : '';
      } catch {
        host = '(unparseable)';
      }
      return Response.json({
        runtime: 'esa',
        hasDatabaseUrl: !!raw,
        databaseHost: host,
        hasJwtSecret: !!merged.JWT_SECRET,
        hasSiteUrl: !!merged.SITE_URL,
        envFromFetchArg: Object.keys(envVars ?? {}).length > 0,
        skipBootstrap: merged.ESA_SKIP_BOOTSTRAP === '1',
      });
    }

    const env = {
      ...merged,
      // ESA 没有 TCP socket：非 Neon 的 PostgreSQL 连不上，显式钉死驱动，
      // 免得 resolveDriverKind 按域名落到 postgres.js 分支（那里只有 stub）。
      DB_PROVIDER: 'neon',
    } as unknown as Env;

    const ctx = {
      waitUntil:
        typeof context?.waitUntil === 'function'
          ? context.waitUntil.bind(context)
          : (p: Promise<unknown>): void => {
              void p;
            },
      passThroughOnException: () => undefined,
    };

    return app.fetch(request, env, ctx as unknown as ExecutionContext);
  },
};
