/**
 * 社交登录绑定表（QQ 互联等 OAuth2 第三方登录）。
 *
 * 与 oidc.ts 的 user_oidc_bindings 平行：社交登录用 (provider, provider_user_id)
 * 唯一标识一个外部身份；QQ 的 unionid 仅作兜底匹配。
 */
import { getSql, type Sql } from './index';
import type { Env } from '../env';

export interface SocialBinding {
  id: number;
  userId: number;
  provider: string;
  providerUserId: string;
  unionId: string | null;
  email: string | null;
  nickname: string | null;
}

export class SocialBindingsRepo {
  private sql: Sql;

  constructor(env: Env) {
    this.sql = getSql(env);
  }

  /** 按 (provider, provider_user_id) 查绑定。 */
  async findByProviderUser(provider: string, providerUserId: string): Promise<SocialBinding | null> {
    const rows = (await this.sql`
      SELECT * FROM user_social_bindings
      WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
        AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    return rows[0] ? normalize(rows[0]) : null;
  }

  /** 按 (provider, union_id) 兜底查绑定（同一 QQ 用户跨应用）。 */
  async findByUnion(provider: string, unionId: string): Promise<SocialBinding | null> {
    const rows = (await this.sql`
      SELECT * FROM user_social_bindings
      WHERE provider = ${provider} AND union_id = ${unionId}
        AND deleted_at IS NULL LIMIT 1
    `) as Array<Record<string, unknown>>;
    return rows[0] ? normalize(rows[0]) : null;
  }

  /** 某用户绑定的全部社交身份（账号设置页展示）。 */
  async listByUser(userId: number): Promise<SocialBinding[]> {
    const rows = (await this.sql`
      SELECT * FROM user_social_bindings
      WHERE user_id = ${userId} AND deleted_at IS NULL
      ORDER BY created_at ASC
    `) as Array<Record<string, unknown>>;
    return rows.map(normalize);
  }

  /** 落绑定（幂等：并发下 ON CONFLICT 收敛到一条）。 */
  async upsert(args: {
    userId: number;
    provider: string;
    providerUserId: string;
    unionId?: string | null;
    email?: string | null;
    nickname?: string | null;
  }): Promise<void> {
    await this.sql`
      INSERT INTO user_social_bindings
        (user_id, provider, provider_user_id, union_id, email, nickname, last_login)
      VALUES
        (${args.userId}, ${args.provider}, ${args.providerUserId},
         ${args.unionId ?? null}, ${args.email ?? null}, ${args.nickname ?? null}, now())
      ON CONFLICT (provider, provider_user_id)
      DO UPDATE SET
        union_id = EXCLUDED.union_id,
        email = EXCLUDED.email,
        nickname = EXCLUDED.nickname,
        last_login = now(),
        updated_at = now(),
        deleted_at = NULL
    `;
  }

  /** 更新最近登录时间。 */
  async touch(provider: string, providerUserId: string): Promise<void> {
    await this.sql`
      UPDATE user_social_bindings SET last_login = now(), updated_at = now()
      WHERE provider = ${provider} AND provider_user_id = ${providerUserId}
    `;
  }
}

function normalize(r: Record<string, unknown>): SocialBinding {
  return {
    id: Number(r.id),
    userId: Number(r.user_id),
    provider: String(r.provider),
    providerUserId: String(r.provider_user_id),
    unionId: r.union_id == null ? null : String(r.union_id),
    email: r.email == null ? null : String(r.email),
    nickname: r.nickname == null ? null : String(r.nickname),
  };
}
