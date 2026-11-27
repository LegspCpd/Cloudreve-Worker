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

  const limitBundle = path.join(outDir, 'bodyLimit.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/bodyLimit.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: limitBundle,
    logLevel: 'silent',
  });
  const { readBodyLimited, readJsonLimited, readFormLimited, readBytesLimited } = await import(
    `file://${limitBundle}`
  );

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

  console.log('\n[9] readBodyLimited（签名前限正文，issue #3628）');
  const mkReq = (body, headers = {}) =>
    new Request('https://example.com/api/v4/slave/prepare', {
      method: 'POST',
      body,
      headers,
    });
  check('正常正文原样返回', (await readBodyLimited(mkReq('{"a":1}'), 1024)) === '{"a":1}');
  check(
    'UTF-8 正文不串字节',
    (await readBodyLimited(mkReq('{"name":"中文"}'), 1024)) === '{"name":"中文"}',
  );
  let tooLarge = null;
  try {
    await readBodyLimited(mkReq('x'.repeat(2000)), 1024);
  } catch (e) {
    tooLarge = e;
  }
  check('超过上限被拒', tooLarge !== null);
  check('错误码 413', tooLarge?.code === 413, String(tooLarge?.code));
  let fakeLength = null;
  try {
    await readBodyLimited(mkReq('tiny', { 'Content-Length': '99999' }), 1024);
  } catch (e) {
    fakeLength = e;
  }
  check('伪造的 Content-Length 也被拦', fakeLength !== null);
  check(
    'GET 无正文返回空串',
    (await readBodyLimited(new Request('https://example.com/'), 1024)) === '',
  );

  console.log('\n[9b] readJsonLimited / readFormLimited / readBytesLimited（匿名端点 body 上限）');
  const jsonReq = (body) =>
    new Request('https://example.com/api/v4/session/token', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json' },
    });
  check('正常 JSON 解析', (await readJsonLimited(jsonReq('{"email":"a@b.c","password":"123456"}'), 1024)).email === 'a@b.c');
  let badJson = null;
  try {
    await readJsonLimited(jsonReq('{"a":' + 'x'.repeat(2000)), 1024);
  } catch (e) {
    badJson = e;
  }
  check('超大 JSON 在解析前被拒（413）', badJson?.code === 413, String(badJson?.code));
  check(
    '畸形 JSON 回落空对象，与 c.req.json().catch 一致',
    JSON.stringify(await readJsonLimited(jsonReq('{bad'), 1024)) === '{}',
  );
  const formReq = (body) =>
    new Request('https://example.com/api/v4/session/oauth/token', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  const form = await readFormLimited(formReq('grant_type=authorization_code&code=abc'), 1024);
  check('urlencoded 表单解析', form.get('code') === 'abc');
  let bigForm = null;
  try {
    await readFormLimited(formReq('code=' + 'x'.repeat(2000)), 1024);
  } catch (e) {
    bigForm = e;
  }
  check('超大表单被拒', bigForm?.code === 413);
  check(
    'readBytesLimited 返回精确字节数',
    (await readBytesLimited(jsonReq('中文abc'), 1024)).byteLength === new TextEncoder().encode('中文abc').byteLength,
  );

  console.log('\n[10] safeEntryPath sanitize（discussion #2483：归档非法文件名不能整任务失败）');
  const zipBundle = path.join(outDir, 'zipread.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/zipread.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: zipBundle,
    logLevel: 'silent',
  });
  const { safeEntryPath } = await import(`file://${zipBundle}`);
  check('默认保留原字符（由 validateName 决定合法性）', JSON.stringify(safeEntryPath('file:a.txt')) === '["file:a.txt"]');
  check(
    'sanitize 把非法字符换成下划线',
    JSON.stringify(safeEntryPath('file:a.txt', true)) === '["file_a.txt"]',
  );
  check(
    'sanitize 保留目录层级',
    JSON.stringify(safeEntryPath('dir/a?b/c*d.txt', true)) === '["dir","a_b","c_d.txt"]',
  );
  check('sanitize 仍拒绝路径穿越', safeEntryPath('../evil.txt', true) === null);
  check('sanitize 仍拒绝绝对路径', safeEntryPath('/etc/passwd', true) === null);
  check('sanitize 保留正常名字', JSON.stringify(safeEntryPath('普通/文件.txt', true)) === '["普通","文件.txt"]');
  check('NUL 字节被拒（Postgres text 会拒，且是脏数据）', safeEntryPath('file\0.txt', true) === null);
  check('路径段中含 NUL 也被拒', safeEntryPath('dir/a\0b/c.txt', true) === null);
  check('中间穿越 a/../../evil 被拒', safeEntryPath('a/../../evil.txt', true) === null);
  check('Windows 盘符被拒', safeEntryPath('C:/evil.txt', true) === null);
  check('反斜杠穿越被拒', safeEntryPath('..\\evil.txt', true) === null);

  console.log('\n[10b] joinUnder（归档落盘的二级根内断言）');
  const uriBundle = path.join(outDir, 'uri.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/services/uri.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: uriBundle,
    logLevel: 'silent',
  });
  const { URI, joinUnder, validateName } = await import(`file://${uriBundle}`);
  const base = URI.parse('cloudreve://my/extract');
  check('正常段拼在 base 内', joinUnder(base, ['a', 'b.txt'])?.toString() === 'cloudreve://my/extract/a/b.txt');
  // 即便调用方漏了 safeEntryPath，normalizePath 的 .. pop 也不能逃到兄弟路径
  check('穿越段被拒（不返回兄弟路径）', joinUnder(base, ['..', 'evil.txt']) === null);
  check('多段穿越被拒', joinUnder(base, ['a', '..', '..', 'evil.txt']) === null);
  check('空段返回 null', joinUnder(base, []) === null);
  check('validateName 拒 NUL', validateName('file\0.txt') !== null);
  check('validateName 拒 ..', validateName('..') !== null);
  check('validateName 放行正常名', validateName('文件.txt') === null);

  console.log('\n[10c] emoji 预设白名单（上游 customize:emoji 校验）');
  const emojiBundle = path.join(outDir, 'emojiPresets.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/emojiPresets.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: emojiBundle,
    logLevel: 'silent',
  });
  const { parseEmojiPresets, checkEmojiPatch } = await import(`file://${emojiBundle}`);
  const emojis = JSON.stringify({ animals: ['🐱', '🐶'], food: ['🍎'] });
  check('预设展平', parseEmojiPresets(emojis).has('🐱') && parseEmojiPresets(emojis).has('🍎'));
  check('预设里的 emoji 放行', checkEmojiPatch(emojis, '🐱', false) === null);
  check('非预设 emoji 被拒', checkEmojiPatch(emojis, '💣', false) === 'unsupported emoji');
  check('remove 总放行', checkEmojiPatch(emojis, undefined, true) === null);
  check('损坏的设置不当任意值白名单', checkEmojiPatch('{bad', '💣', false) === 'unsupported emoji');
  check('每次解析返回新集合（无可变共享状态）', parseEmojiPresets(emojis) !== parseEmojiPresets(emojis));

  console.log('\n[11] safeContentType（上传类型不可信，防存储型 XSS）');
  const dispBundle = path.join(outDir, 'disposition2.mjs');
  await build({
    entryPoints: [path.join(ROOT, 'src/lib/disposition.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: dispBundle,
    logLevel: 'silent',
  });
  const { safeContentType } = await import(`file://${dispBundle}`);
  const html = safeContentType('text/html', 'a.html');
  check('HTML 降级为纯文本', html.contentType === 'text/plain; charset=utf-8');
  check('HTML 强制附件下载', html.forceAttachment === true);
  check('HTML 带 nosniff', html.extraHeaders['X-Content-Type-Options'] === 'nosniff');
  const js = safeContentType('application/javascript', 'x.bin');
  check('JS 也降级', js.contentType === 'text/plain; charset=utf-8' && js.forceAttachment);
  const svg = safeContentType('image/svg+xml', 'a.svg');
  check('SVG 保留图片类型', svg.contentType === 'image/svg+xml');
  check(
    'SVG 加 CSP sandbox（直接打开时脚本被隔离）',
    String(svg.extraHeaders['Content-Security-Policy'] ?? '').includes('sandbox'),
  );
  const png = safeContentType('image/png', 'a.png');
  check('普通图片不受影响', png.contentType === 'image/png' && !png.forceAttachment);
} catch (e) {
  failed += 1;
  console.error('\n  ERROR', e instanceof Error ? e.message : e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
