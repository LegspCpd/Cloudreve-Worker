/**
 * 纯函数 / 小工具的回归测试。
 *
 * 目前覆盖 `lib/disposition.ts`（Content-Disposition 生成）—— 文件名是用户
 * 可控字符串，它直接拼进 HTTP 头，写错就是头注入或下载文件名乱码。
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
} catch (e) {
  failed += 1;
  console.error('\n  ERROR', e instanceof Error ? e.message : e);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
