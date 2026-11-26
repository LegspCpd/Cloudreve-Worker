// 站点图标运行时同步脚本的单元测试：从 fetch-frontend.mjs 源码里抽出脚本，
// 用最小 DOM/mock 环境执行，验证 favicon / loader logo / preload 都被替换。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(ROOT, 'scripts/fetch-frontend.mjs'), 'utf8');
const m = src.match(/const SITE_ICONS_SYNC_SCRIPT = `([\s\S]*?)`;/);
if (!m) {
  console.error('FAIL: 找不到 SITE_ICONS_SYNC_SCRIPT');
  process.exit(1);
}
const script = m[1];

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log('ok   ' + name);
  } else {
    fail++;
    console.log('FAIL ' + name);
  }
}

// 最小 DOM：一条 favicon link、一条 preload image、一段含 logo 背景的 style、#app-loader。
function makeDom() {
  const favicon = { rel: 'shortcut icon', href: '/static/img/favicon.ico' };
  const preload = { as: 'image', href: '/static/img/logo192.png' };
  const style = {
    textContent: '#app-loader .logo{background-image: url("/static/img/logo192.png");}',
  };
  const logo = { style: { backgroundImage: '' } };
  const loader = { querySelector: (s) => (s === '.logo' ? logo : null) };
  const nodes = [favicon, preload];
  const document = {
    querySelector: (sel) => {
      if (sel.indexOf('rel~="icon"') > -1) return favicon;
      if (sel.indexOf('as="image"') > -1) return preload;
      return null;
    },
    querySelectorAll: (sel) => (sel === 'style' ? [style] : []),
    getElementById: (id) => (id === 'app-loader' ? loader : null),
  };
  return { document, favicon, preload, style, logo };
}

function run(scriptText, dom, manifest, sessionData) {
  const store = { value: sessionData ?? null };
  const fetchMock = () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve(manifest),
    });
  const sandbox = {
    document: dom.document,
    sessionStorage: {
      getItem: () => store.value,
      setItem: (_k, v) => {
        store.value = v;
      },
    },
    window: { fetch: fetchMock },
    fetch: fetchMock,
    JSON,
    String,
    Promise,
    console,
  };
  // 脚本最外层是 IIFE，最后 return，同步 + 异步两部分都会执行
  new Function(...Object.keys(sandbox), scriptText)(...Object.values(sandbox));
  return store;
}

const USER_MANIFEST = {
  icons: [
    { src: 'https://picui.example/6b05.ico', sizes: '64x64' },
    { src: 'https://hub.example/LC-Icon.png', sizes: '192x192' },
  ],
};

// 1) 首次访问（无缓存）：脚本同步部分不改 DOM，异步拉 manifest 后替换三处。
{
  const dom = makeDom();
  const store = run(script, dom, USER_MANIFEST, null);
  await new Promise((r) => setTimeout(r, 0));
  check('favicon 换成用户设置的图标', dom.favicon.href === USER_MANIFEST.icons[0].src);
  check('preload 换成用户设置的图标', dom.preload.href === USER_MANIFEST.icons[1].src);
  check('loader 背景换成用户设置的图标', dom.logo.style.backgroundImage === 'url("' + USER_MANIFEST.icons[1].src + '")');
  check('内联 style 里的默认路径被替换', dom.style.textContent.indexOf('/static/img/logo192.png') === -1);
  const cached = JSON.parse(store.value);
  check('结果写进 sessionStorage', cached.small === USER_MANIFEST.icons[0].src && cached.medium === USER_MANIFEST.icons[1].src);
}

// 2) 二次访问（有缓存）：同步部分立刻应用缓存，不等 fetch。
{
  const dom = makeDom();
  run(script, dom, null, JSON.stringify({ small: USER_MANIFEST.icons[0].src, medium: USER_MANIFEST.icons[1].src }));
  check('缓存命中时同步替换 favicon', dom.favicon.href === USER_MANIFEST.icons[0].src);
  check('缓存命中时同步替换 loader', dom.logo.style.backgroundImage === 'url("' + USER_MANIFEST.icons[1].src + '")');
}

// 3) manifest 是默认值时不写 DOM，也不产生缓存（后台没设图标）。
{
  const dom = makeDom();
  const store = run(script, dom, { icons: [{ src: '/static/img/favicon.ico' }, { src: '/static/img/logo192.png' }] }, null);
  await new Promise((r) => setTimeout(r, 0));
  check('默认图标时保持原样', dom.favicon.href === '/static/img/favicon.ico');
  check('默认图标时不写缓存', store.value === null);
}

// 4) fetch 失败时不抛异常（network error 被 catch）。
{
  const dom = makeDom();
  let threw = false;
  try {
    const sandbox = {
      document: dom.document,
      sessionStorage: { getItem: () => null, setItem: () => {} },
      window: { fetch: () => Promise.reject(new Error('network down')) },
      fetch: () => Promise.reject(new Error('network down')),
      JSON, String, Promise, console,
    };
    new Function(...Object.keys(sandbox), script)(...Object.values(sandbox));
    await new Promise((r) => setTimeout(r, 0));
  } catch (e) {
    threw = true;
  }
  check('manifest 拉失败不抛异常', !threw);
}

// 5) 注入到真实 index.html：脚本在 </head> 前，且只有一份。
{
  const html = readFileSync(path.join(ROOT, 'dist/index.html'), 'utf8');
  const tag = `<script>${script}</script>`;
  const injected = html.replace('</head>', `  ${tag}\n  </head>`);
  check('脚本注入后 </head> 前有一份', (injected.match(/__edge_site_icons/g) || []).length === 1);
  check('注入的脚本能被 JS 解析', (() => { try { new Function(script); return true; } catch { return false; } })());
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
