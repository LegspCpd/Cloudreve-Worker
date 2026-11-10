/**
 * 纯函数 / 小工具的回归测试。
 *
 * 覆盖 `lib/disposition.ts`（Content-Disposition 生成）与 `lib/paths.ts`
 * （路径解码）等纯函数。
 *
 * 跑法：`npm run test:lib`
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(ROOT, 'node_modules', '.cache', 'libtest');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`);
  }
}

try {
  const bundlePath = path.join(outDir, 'disposition.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/disposition.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  const { attachmentDisposition } = await import(`file://${bundlePath}`);

  console.log('\n[1] 纯 ASCII 文件名');
  check(
    '简单形式',
    attachmentDisposition('report.pdf') === 'attachment; filename="report.pdf"',
    attachmentDisposition('report.pdf'),
  );

  console.log('\n[2] 非 ASCII 走 filename*');
  const zh = attachmentDisposition('报告.pdf');
  check('带 filename*', zh.includes("filename*=UTF-8''"), zh);
  check('中文被百分号编码', zh.includes('%E6%8A%A5%E5%91%8A'), zh);

  console.log('\n[3] RFC 5987 attr-char 之外的字符必须编码');
  // `(` `)` `'` `*` 不在 attr-char 里，encodeURIComponent 却会保留它们
  const paren = attachmentDisposition('报告(1).pdf');
  const star = paren.split("filename*=UTF-8''")[1] ?? '';
  check('filename* 里没有裸括号', !/[()]/.test(star), star);
  check('括号被编码成 %28/%29', star.includes('%28') && star.includes('%29'), star);
  const quote = attachmentDisposition("报告'1.pdf");
  const quoteVal = quote.split("filename*=UTF-8''")[1] ?? '';
  check('filename* 里没有裸单引号', !quoteVal.includes("'"), quoteVal);
  check('单引号被编码成 %27', quoteVal.includes('%27'), quoteVal);

  console.log('\n[4] 头注入');
  const injected = attachmentDisposition('a"\r\nX-Injected: evil\r\n\r\n.txt');
  check('不产生换行', !/[\r\n]/.test(injected), JSON.stringify(injected));
  check('引号被打成下划线', !injected.includes('a"'), injected);
  // 注入串留在引号内只是文件名的一部分，真正危险的是控制字符
  check('不含任何控制字符', !/[\x00-\x1F\x7F]/.test(injected), JSON.stringify(injected));

  console.log('\n[5] 反斜杠与空值');
  const back = attachmentDisposition('a\\b.txt');
  check('反斜杠被打成下划线', !back.includes('\\'), back);
  const empty = attachmentDisposition('');
  check('空文件名不产生非法头', empty === 'attachment; filename=""', empty);

  // ---------------------------------------------------------------------
  // [6] safeDecodePath（lib/paths.ts）
  // ---------------------------------------------------------------------
  const pathsBundle = path.join(outDir, 'paths.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/paths.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: pathsBundle,
    logLevel: 'silent',
  });
  const { safeDecodePath } = await import(`file://${pathsBundle}`);

  console.log('\n[6] safeDecodePath');
  check(
    '编码目录还原真名',
    safeDecodePath('music/Windows%20XP%20OOBE%20Welcome%20Music') ===
      'music/Windows XP OOBE Welcome Music',
    safeDecodePath('music/Windows%20XP%20OOBE%20Welcome%20Music'),
  );
  check('中文段解码', safeDecodePath('%E9%9F%B3%E4%B9%90') === '音乐');
  check('真名含 % 的正确编码形式', safeDecodePath('50%25off/keep') === '50%off/keep');
  check('裸百分号保留原样', safeDecodePath('50%off/keep') === '50%off/keep');
  check('无 % 的路径原样返回', safeDecodePath('plain/path/file.mp3') === 'plain/path/file.mp3');
  check('空串安全', safeDecodePath('') === '');
  check('不全解码（只解 % 段）', safeDecodePath('a%20b/plain') === 'a b/plain');

  console.log('\n[7] clientIpFromHeaders（限速桶 key 不能被客户端伪造）');
  const ipBundle = path.join(outDir, 'clientIp.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/clientIp.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: ipBundle,
    logLevel: 'silent',
  });
  const { clientIpFromHeaders, normalizeRateLimitId } = await import(`file://${ipBundle}`);
  const headers = (o) => (name) => o[name];
  check(
    'CF 平台注入的头优先（平台会覆盖客户端伪造值）',
    clientIpFromHeaders(headers({ 'CF-Connecting-IP': '1.2.3.4' })) === '1.2.3.4',
  );
  check(
    'XFF 取最右一段（可信反代追加的）',
    clientIpFromHeaders(headers({ 'X-Forwarded-For': '1.1.1.1, 2.2.2.2, 3.3.3.3' })) === '3.3.3.3',
  );
  check(
    '客户端伪造的 XFF 首段不生效',
    clientIpFromHeaders(headers({ 'X-Forwarded-For': '9.9.9.9, 8.8.8.8' })) === '8.8.8.8',
  );
  check('XFF 单段', clientIpFromHeaders(headers({ 'X-Forwarded-For': ' 5.6.7.8 ' })) === '5.6.7.8');
  check('全空回落 unknown', clientIpFromHeaders(headers({})) === 'unknown');
  check('空段不干扰', clientIpFromHeaders(headers({ 'X-Forwarded-For': ' , , 7.7.7.7 , ' })) === '7.7.7.7');

  console.log('\n[8] normalizeRateLimitId（边缘出口 IP 轮换时计数不能散）');
  check('IPv4 归 /24', normalizeRateLimitId('43.109.171.7') === '43.109.171.0/24');
  check('同 /24 两 IP 同桶', normalizeRateLimitId('43.109.171.7') === normalizeRateLimitId('43.109.171.9'));
  check('IPv6 归 /32', normalizeRateLimitId('2404:2280:208:0:3::b') === '2404:2280::/32');
  check('同运营商不同 /48 同桶', normalizeRateLimitId('2404:2280:208:0:3::b') === normalizeRateLimitId('2404:2280:2fb:0:3::9'));
  check('邮箱不受影响', normalizeRateLimitId('user@example.com') === 'user@example.com');
  check('分享复合 id 不受影响', normalizeRateLimitId('12:1.2.3.4') === '12:1.2.3.4');
} catch (e) {
  failed += 1;
  console.error('\n  ERROR', e instanceof Error ? e.message : e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
