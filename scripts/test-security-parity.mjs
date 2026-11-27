/**
 * 上游安全修复对齐验证（11 个提交中 edge 补齐的 3 项）。
 *
 *   T1-T2  WebDAV 只读账号方法白名单（3216a8cb）：读方法放行，其余 default-deny
 *   T3-T6  激活链接绑定注册凭证（0d0a54b1）：同一 uid 换密码/邮箱后旧签名失效
 *   T7-T8  OAuth consent 一方 token 判定（361dd432）：scopes undefined = 一方
 *
 * 跑法：`npm run test:security-parity`
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = mkdtempSync(path.join(os.tmpdir(), 'secparity-'));
let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${label}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${label}\n        ${e.message}`);
  }
}

// 全局 crypto：Signer 用 WebCrypto
if (!globalThis.crypto?.subtle) {
  globalThis.crypto = (await import('node:crypto')).webcrypto;
}

try {
  const davSrc = readFileSync(path.join(ROOT, 'src/routes/dav.ts'), 'utf8');
  const userSrc = readFileSync(path.join(ROOT, 'src/services/user.ts'), 'utf8');
  const sessionSrc = readFileSync(path.join(ROOT, 'src/routes/session.ts'), 'utf8');
  const appSrc = readFileSync(path.join(ROOT, 'src/middleware/app.ts'), 'utf8');

  // ---- WebDAV 白名单 ----
  const readMatch = davSrc.match(/const READ_METHODS = new Set\(\[([^\]]+)\]\)/);
  check('T1 白名单已定义且为 READ_METHODS，不再用 WRITE_METHODS 黑名单', () => {
    assert.ok(readMatch, '未找到 READ_METHODS 定义');
    assert.ok(!/const WRITE_METHODS/.test(davSrc), '仍在用 WRITE_METHODS 黑名单');
  });
  check('T2 白名单覆盖读方法、default-deny 已生效', () => {
    const methods = readMatch[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
    for (const m of ['GET', 'HEAD', 'POST', 'OPTIONS', 'PROPFIND']) {
      assert.ok(methods.includes(m), `读方法 ${m} 缺失`);
    }
    assert.ok(!methods.includes('DELETE'), 'DELETE 不能被当读方法');
    assert.ok(!methods.includes('PUT'), 'PUT 不能被当读方法');
    assert.ok(!methods.includes('PROPPATCH'), 'PROPPATCH 不能被当读方法');
    assert.match(davSrc, /groupReadonly\)\s*&&\s*!READ_METHODS\.has\(method\)/, '未使用 default-deny');
  });

  // ---- 激活签名正文 ----
  const signPath = path.join(outDir, 'sign.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/lib/sign.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: signPath,
    logLevel: 'silent',
  });
  const { Signer } = await import(`file://${signPath}`);
  const signer = new Signer('parity-test-secret-key');

  check('T3 激活签名正文绑定 id/email/password', () => {
    assert.match(userSrc, /user-activation-v2:\$\{user\.id\}/, '签名正文未含 id');
    assert.match(userSrc, /JSON\.stringify\(user\.email\)/, '签名正文未含 email');
    assert.match(userSrc, /JSON\.stringify\(user\.password\)/, '签名正文未含密码摘要');
  });
  check('T4 激活时按库里当前凭证重建正文，不再签 API 路径', () => {
    assert.match(userSrc, /signer\.check\(activationSignContent\(inactiveUser\), sign\)/, '未用当前凭证验签');
    assert.match(userSrc, /activateIfCredentialMatches\(/, '未做条件激活');
  });

  await checkAsync('T5 改密码后旧签名失效、新签名有效', async () => {
    const user = { id: 42, email: 'a@b.com', password: 'digest-v1' };
    const content = (u) => `user-activation-v2:${u.id}:${JSON.stringify(u.email)}:${JSON.stringify(u.password)}`;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const oldSign = await signer.sign(content(user), exp);
    const changed = { ...user, password: 'digest-v2' };
    await assert.rejects(() => signer.check(content(changed), oldSign), '旧签名不该通过');
    const newSign = await signer.sign(content(changed), exp);
    await signer.check(content(changed), newSign); // 不抛 = 通过
  });
  await checkAsync('T6 改邮箱后旧签名失效', async () => {
    const user = { id: 7, email: 'old@b.com', password: 'digest' };
    const content = (u) => `user-activation-v2:${u.id}:${JSON.stringify(u.email)}:${JSON.stringify(u.password)}`;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const oldSign = await signer.sign(content(user), exp);
    await assert.rejects(() => signer.check(content({ ...user, email: 'new@b.com' }), oldSign));
  });

  // ---- OAuth consent 一方 token ----
  check('T7 consent 端点拒绝 OAuth client token（scopes 非 undefined）', () => {
    assert.match(sessionSrc, /if \(ctx\.scopes !== undefined\) return fail\(c, Err\.noPermission\(\)\)/, 'consent 未校验一方 token');
  });
  check('T8 scopes 只在 JWT 带 client_id 时写入（判定依据成立）', () => {
    assert.match(appSrc, /if \(user && resolved\?\.claims\?\.client_id\)[\s\S]{0,80}scopes = resolved\.claims\.scopes/, 'scopes 判定依据不成立');
  });
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
