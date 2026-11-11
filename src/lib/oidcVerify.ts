/**
 * OIDC id_token 验签（JWKS），不依赖第三方库。
 *
 * 原来的实现只把 id_token 的 payload 解出来看 nonce，签名完全不验；
 * userinfo 是 HTTPS 上的一个 JSON，email_verified 由 IdP 单方面声明就
 * 被当成事实。这里把信任锚放回「token 端点返回的、用 IdP 公钥签过的
 * id_token」：验签 + iss/aud/exp/iat/nonce，随后由调用方拿它的 claims
 * 去交叉校验 userinfo（sub/email）并决定是否允许关联已有账号。
 *
 * 只支持 RSA 系列（RS256/384/512、PS256/384/512），覆盖主流 IdP
 * （Google / Entra ID / Keycloak / Okta 默认 RS256）。ES256 等 EC 算法
 * 明确报错，避免悄悄降级成「没验签」。
 */
import type { Env } from '../env';
import { kvFor } from './kvRouter';

const JWKS_TTL = 3600;
const JWKS_PREFIX = 'oidc_jwks_';

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
  use?: string;
  kty?: string;
}

export interface VerifyIdTokenArgs {
  env: Env;
  idToken: string;
  /** discovery 文档里的 issuer，必须逐字节等于 id_token 的 iss。 */
  issuer: string;
  jwksUri?: string;
  clientId: string;
  /** 发起登录时写进 KV 的一次性 nonce。 */
  expectedNonce: string;
  /** 测试注入：直接给 JWKS，跳过 KV/网络（生产不传）。 */
  jwks?: Jwk[];
}

function b64urlToBytes(seg: string): Uint8Array<ArrayBuffer> {
  const padded = seg.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeSegment(seg: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(seg))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function cacheKeyOf(uri: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uri));
  return JWKS_PREFIX + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hashOf(alg: string): string {
  if (alg.endsWith('384')) return 'SHA-384';
  if (alg.endsWith('512')) return 'SHA-512';
  return 'SHA-256';
}

async function loadJwks(env: Env, jwksUri: string): Promise<Jwk[]> {
  const key = await cacheKeyOf(jwksUri);
  const kv = kvFor(env, 'cred');
  const cached = await kv.get(key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Jwk[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* 缓存损坏，重新拉 */
    }
  }
  // jwks_uri 来自管理员配置的 IdP（可能是企业内网），不走面向用户 URL 的
  // safeFetch —— 那会把内网 IdP 一并挡掉。
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Failed to load OIDC JWKS (${res.status})`);
  const doc = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(doc.keys) ? doc.keys : [];
  await kv.put(key, JSON.stringify(keys), { expirationTtl: JWKS_TTL });
  return keys;
}

/** 验签并返回已校验过的 claims；任何一步失败都抛 Error（调用方转成 400）。 */
export async function verifyIdToken(args: VerifyIdTokenArgs): Promise<Record<string, unknown>> {
  const parts = args.idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed OIDC id_token');
  const header = decodeSegment(parts[0]!);
  const claims = decodeSegment(parts[1]!);
  if (!header || !claims) throw new Error('Malformed OIDC id_token');

  const alg = String(header.alg ?? '');
  if (!/^(RS|PS)(256|384|512)$/.test(alg)) {
    throw new Error(`Unsupported OIDC id_token algorithm: ${alg || '(none)'}`);
  }
  if (!args.jwksUri) {
    throw new Error('OIDC discovery document has no jwks_uri; cannot verify id_token');
  }

  const keys = args.jwks ?? (await loadJwks(args.env, args.jwksUri));
  const kid = typeof header.kid === 'string' ? header.kid : undefined;
  const candidates = keys.filter(
    (k) => k.kty === 'RSA' && (!kid || k.kid === kid) && (!k.use || k.use === 'sig'),
  );
  if (!candidates.length) throw new Error('No matching signing key in OIDC JWKS');

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = b64urlToBytes(parts[2]!);
  const isPss = alg.startsWith('PS');
  const importAlg = { name: isPss ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5', hash: hashOf(alg) };
  const verifyAlg = isPss
    ? { name: 'RSA-PSS', saltLength: alg.endsWith('512') ? 64 : alg.endsWith('384') ? 48 : 32 }
    : { name: 'RSASSA-PKCS1-v1_5', hash: hashOf(alg) };

  let verified = false;
  for (const jwk of candidates) {
    try {
      const key = await crypto.subtle.importKey('jwk', jwk, importAlg, false, ['verify']);
      if (await crypto.subtle.verify(verifyAlg, key, signature, signed)) {
        verified = true;
        break;
      }
    } catch {
      /* kid 撞了或 JWK 不合法，试下一个 */
    }
  }
  if (!verified) throw new Error('OIDC id_token signature verification failed');

  const now = Math.floor(Date.now() / 1000);
  if (String(claims.iss ?? '') !== args.issuer) throw new Error('OIDC id_token issuer mismatch');
  const aud = Array.isArray(claims.aud)
    ? claims.aud.map(String)
    : [String(claims.aud ?? '')];
  if (!aud.includes(args.clientId)) throw new Error('OIDC id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('OIDC id_token expired');
  if (typeof claims.iat === 'number' && claims.iat > now + 60) {
    throw new Error('OIDC id_token issued in the future');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('OIDC id_token missing sub');
  // 我们每次发起登录都写了 nonce，所以 id_token 必须带且必须匹配。
  if (typeof claims.nonce !== 'string' || claims.nonce !== args.expectedNonce) {
    throw new Error('OIDC id_token nonce mismatch');
  }
  return claims;
}
