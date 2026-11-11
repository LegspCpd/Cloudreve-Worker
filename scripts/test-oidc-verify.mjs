/**
 * OIDC id_token 验签回归（`src/lib/oidcVerify.ts`）。
 *
 * 用本地生成的 RSA 密钥对构造真 JWT，验证：验签通过、篡改 payload / nonce /
 * 过期 / aud / none 算法全部被拒。JWKS 直接注入，不联网、不连库。
 *
 * 跑法：`npm run test:oidc-verify`
 */
import { build } from 'esbuild';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'oidcverifytest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
let verifyIdToken;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const issuer = 'https://idp.example.com';
const clientId = 'cloudreve-client';
const nonce = 'nonce-abc-123';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', use: 'sig', alg: 'RS256' };

function makeToken({ alg = 'RS256', claims = {}, signatureOverride } = {}) {
  const header = b64(JSON.stringify({ alg, typ: 'JWT', kid: 'test-kid' }));
  const payload = b64(JSON.stringify({
    iss: issuer,
    aud: clientId,
    sub: 'user-123',
    iat: now - 10,
    exp: now + 600,
    nonce,
    email: 'alice@example.com',
    email_verified: true,
    ...claims,
  }));
  const data = `${header}.${payload}`;
  const sig = signatureOverride ?? b64(sign('RSA-SHA256', Buffer.from(data), privateKey));
  return `${data}.${sig}`;
}

const base = {
  env: {},
  issuer,
  jwksUri: 'https://idp.example.com/jwks',
  clientId,
  expectedNonce: nonce,
  jwks: [jwk],
};

async function mustReject(label, token, overrides = {}) {
  let rejected = false;
  try {
    await verifyIdToken({ ...base, ...overrides, idToken: token });
  } catch {
    rejected = true;
  }
  check(label, rejected);
}

try {
  const bundlePath = path.join(outDir, 'oidcVerify.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/oidcVerify.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
    // 测试走 jwks 注入，不会碰 kvFor；把 kvRouter 换成桩，避免把
    // db → cloudflare:sockets 整条依赖链拉进来。
    plugins: [{
      name: 'stub-kvrouter',
      setup(b) {
        b.onResolve({ filter: /kvRouter$/ }, () => ({ path: 'kvstub', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const kvFor = () => ({ get: async () => null, put: async () => {} });',
          loader: 'js',
        }));
      },
    }],
  });
  ({ verifyIdToken } = await import(`file://${bundlePath}`));

  console.log('[1] 正常验签');
  const claims = await verifyIdToken({ ...base, idToken: makeToken() });
  check('返回已验签 claims', claims.sub === 'user-123' && claims.email === 'alice@example.com');
  check('email_verified 随已验签 claims 返回', claims.email_verified === true);

  console.log('\n[2] 签名与 claims 校验不能被绕过');
  await mustReject('篡改 payload 被拒', (() => {
    const t = makeToken().split('.');
    t[1] = b64(JSON.stringify({ iss: issuer, aud: clientId, sub: 'admin', exp: now + 600, iat: now, nonce }));
    return t.join('.');
  })());
  await mustReject('伪造签名被拒', makeToken({ signatureOverride: b64(Buffer.alloc(256)) }));
  await mustReject('alg=none 被拒', makeToken({ alg: 'none' }));
  await mustReject('nonce 不符被拒', makeToken(), { expectedNonce: 'other' });
  await mustReject('过期被拒', makeToken({ claims: { exp: now - 1 } }));
  await mustReject('iss 不符被拒', makeToken(), { issuer: 'https://evil.example.com' });
  await mustReject('aud 不符被拒', makeToken(), { clientId: 'another-client' });
  await mustReject('kid 无匹配 JWK 被拒', makeToken(), { jwks: [{ ...jwk, kid: 'other' }] });
  await mustReject('缺 jwks_uri 且未注入 JWKS 被拒', makeToken(), { jwks: undefined, jwksUri: undefined });
} catch (e) {
  failed += 1;
  console.error('  ERROR', e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
