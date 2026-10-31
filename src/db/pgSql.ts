/**
 * postgres.js 适配层（Neon 之外的 PostgreSQL 供应商）。
 *
 * Supabase / CockroachDB / Xata（Postgres）/ Prisma Postgres / Railway /
 * Render / 自建 Postgres 都讲标准 PostgreSQL 线协议，用 postgres.js 连接；
 * 它有专门的 `workerd` 构建，能在 Workers 里跑，且没有原生依赖。
 *
 * 与 Neon HTTP 驱动的差异只在**传输层**：SQL 方言、schema、迁移完全一致。
 */
import postgres from 'postgres';
import type { Sql, SqlQuery } from './index';

export type PgClient = ReturnType<typeof postgres>;

/**
 * 惰性查询。
 *
 * 必须是惰性的：`sql.transaction([...])` 会把多条查询放进同一个事务，
 * 如果 `sql\`...\`` 在创建时就已经开始执行，事务就只是「事后包一层」，
 * 起不到原子性作用。Neon 的驱动同样是惰性的，语义一致。
 */
class PgQuery<T = Record<string, unknown>> implements SqlQuery<T> {
  constructor(
    private readonly client: PgClient,
    readonly text: string,
    readonly values: readonly unknown[],
  ) {}

  private run(): Promise<T[]> {
    return this.client
      .unsafe(this.text, this.values as never[])
      .then((rows) => rows as unknown as T[]);
  }

  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<T[] | TResult> {
    return this.run().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T[]> {
    return this.run().finally(onfinally);
  }

  get [Symbol.toStringTag](): string {
    return 'Promise';
  }
}

/** 把「模板标签」与「(text, params)」两种调用形式统一成 text + values。 */
function pendingQuery<T>(
  client: PgClient,
  first: TemplateStringsArray | string,
  rest: unknown[],
): PgQuery<T> {
  if (typeof first === 'string') {
    const values = Array.isArray(rest[0]) ? (rest[0] as unknown[]) : rest;
    return new PgQuery<T>(client, first, values);
  }
  let text = '';
  for (let i = 0; i < first.length; i++) {
    text += first[i];
    if (i < rest.length) text += `$${i + 1}`;
  }
  return new PgQuery<T>(client, text, rest);
}

/** 用给定客户端构造 `Sql`（导出给单测用；业务代码走 `sqlForUrl`）。 */
export function buildPgSql(client: PgClient): Sql {
  const sql = ((first: TemplateStringsArray | string, ...rest: unknown[]) =>
    pendingQuery(client, first, rest)) as unknown as Sql;

  sql.transaction = async <T = Record<string, unknown>>(queries: readonly SqlQuery<T>[]) => {
    return (await client.begin(async (tx) => {
      const out: T[][] = [];
      for (const q of queries) {
        if (q instanceof PgQuery) {
          const rows = await tx.unsafe(q.text, q.values as never[]);
          out.push(rows as unknown as T[]);
        } else {
          // 不是本驱动创建的查询：在这里 `await` 会落到事务**之外**执行，
          // 静默丢掉原子性。宁可报错，也不要一个假装成功的回滚。
          throw new Error('sql.transaction() only accepts queries created by the same driver');
        }
      }
      return out;
    })) as T[][];
  };

  return sql;
}

export function createPgClient(url: string): PgClient {
  return postgres(url, {
    // Workers 里连接不能跨请求共享；每个 isolate 保留 1 条连接，空闲 20s 关闭。
    // 高并发/低延迟场景建议在 Cloudflare 控制台配 Hyperdrive，把连接池交给边缘。
    max: 1,
    idle_timeout: 20,
    connect_timeout: 15,
    // Supabase 事务池化（6543）、Prisma pooled 等 PgBouncer 形态不支持
    // 命名预处理语句，必须关掉。
    prepare: false,
    onnotice: () => {},
  });
}
