// 校验每个演示页里 import 的符号，在对应模块里确实存在，且用到的 DOM id
// 都在配套 HTML 里。浏览器里 import 错名字会静默整页白屏，Node 里提前抓出来。
//
// 对应关系：demo/app.js ↔ demo/index.html，demo/pose.js ↔ demo/pose.html。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

const PAGES = [
  { script: 'demo/app.js', html: 'demo/index.html' },
  { script: 'demo/pose.js', html: 'demo/pose.html', needsWasm: true },
];

const IMPORT_RE = /import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g;
const DYNAMIC_ID_RE = /getElementById\('([^']+)'\)/g;
// pose.js 里用 $ = (id) => document.getElementById(id) 包了一层，
// 所有调用点都是 $('xxx') 形式，需要单独抓。
const DOLLAR_ID_RE = /\$\('([^']+)'\)/g;

let checked = 0;
const problems = [];

for (const page of PAGES) {
  const scriptPath = path.join(root, page.script);
  if (!fs.existsSync(scriptPath)) {
    problems.push(`${page.script}: 文件不存在`);
    continue;
  }
  const src = fs.readFileSync(scriptPath, 'utf8');

  for (const match of src.matchAll(IMPORT_RE)) {
    const names = match[1].split(',').map((s) => s.trim()).filter(Boolean);
    const spec = match[2];
    const target = path.resolve(path.join(root, path.dirname(page.script)), spec);
    let mod;
    try {
      mod = await import(pathToFileURL(target).href);
    } catch (err) {
      problems.push(`${page.script}: 无法加载 ${spec} —— ${err.message}`);
      continue;
    }
    for (const n of names) {
      checked++;
      if (!(n in mod)) problems.push(`${page.script}: ${spec} 缺少导出 ${n}`);
    }
  }

  const htmlPath = path.join(root, page.html);
  if (!fs.existsSync(htmlPath)) {
    problems.push(`${page.html}: 文件不存在`);
    continue;
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((x) => x[1]));

  for (const re of [DYNAMIC_ID_RE, DOLLAR_ID_RE]) {
    for (const match of src.matchAll(re)) {
      checked++;
      if (!ids.has(match[1])) problems.push(`${page.html} 缺少 id="${match[1]}"（被 ${page.script} 引用）`);
    }
  }

  // 页面里引用的脚本文件必须存在
  for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
    checked++;
    const p = path.resolve(path.join(root, path.dirname(page.html)), match[1]);
    if (!fs.existsSync(p)) problems.push(`${page.html}: 脚本不存在 ${match[1]}`);
  }

  // file:// 兜底提示必须在场，而且必须排在所有 module 脚本之前。
  // 只断言「标签在」不够，但顺序错了同样白屏——模块被 CORS 拒之后才轮到的普通
  // 脚本，救不回一个已经什么都不显示的页面。
  checked++;
  const guardAt = html.indexOf('src="./file-guard.js"');
  const moduleAt = html.indexOf('<script type="module"');
  if (guardAt < 0) {
    problems.push(`${page.html}: 缺少 ./file-guard.js——file:// 打开会白屏且没有任何提示`);
  } else if (moduleAt >= 0 && guardAt > moduleAt) {
    problems.push(`${page.html}: ./file-guard.js 必须排在 <script type="module"> 之前`);
  }
}

// 步长必须来自 SEARCH_DT，不许在别处写死数字。
// constants.js 里写明「求解器验证和真正执行必须用同一步长，否则验证的是另一件事」。
// 两边各写一个 1/120 只是「此刻恰好相等」，哪天有人只改了一边，不会有任何提示。
const dtFiles = ['src', 'demo']
  .flatMap((dir) => fs.readdirSync(path.join(root, dir))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `${dir}/${f}`))
  .filter((rel) => rel !== 'src/constants.js');
checked++;
const hardDt = [];
for (const rel of dtFiles) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  text.split('\n').forEach((line, i) => {
    if (/1\s*\/\s*120/.test(line)) hardDt.push(`${rel}:${i + 1}`);
  });
}
if (hardDt.length) {
  problems.push(`这些地方把步长写死成 1/120，应 import SEARCH_DT：${hardDt.join('、')}`);
}

// CSP 必须在场，而且不许写 'unsafe-eval'。
// 这个页面只加载同源的模块、不联网，没有理由放开 eval；pose.html 另外需要
// 'wasm-unsafe-eval'（只放开 wasm 编译，不等于放开 eval），也必须写在里面。
// 少了这条断言，哪天有人为了「先跑通」把 CSP 整行删掉，没有任何东西会提醒。
checked++;
for (const page of PAGES) {
  const htmlPath = path.join(root, page.html);
  if (!fs.existsSync(htmlPath)) continue;
  const text = fs.readFileSync(htmlPath, 'utf8');
  const cspMeta = text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
  if (!cspMeta) {
    problems.push(`${page.html}: 缺少 Content-Security-Policy，页面会接受任意外链脚本`);
    continue;
  }
  const csp = cspMeta[1];
  if (!/script-src\s+'self'/.test(csp)) {
    problems.push(`${page.html}: CSP 的 script-src 应只允许 'self'`);
  }
  if (/'unsafe-eval'/.test(csp)) {
    problems.push(`${page.html}: CSP 里出现了 'unsafe-eval'，这不是必要项`);
  }
  if (page.needsWasm && !/wasm-unsafe-eval/.test(csp)) {
    problems.push(`${page.html}: wasm 页面必须在 CSP 里写 'wasm-unsafe-eval'，否则模型加载失败`);
  }
}

// 姿态页的窄屏适配：它在 390 宽下曾经把主画面压成 0 宽（aside 固定 390 + main flex）。
// 端到端那边量的是真实宽度，这里再钉一次「别再退回桌面专用布局」，
// 免得有人删掉媒体查询却因为端到端没跑到那一页而漏过。
checked++;
{
  const poseHtml = fs.readFileSync(path.join(root, 'demo/pose.html'), 'utf8');
  if (!/@media[^{]*max-width:\s*900px/.test(poseHtml)) {
    problems.push('demo/pose.html: 缺少 max-width: 900px 的媒体查询，手机上主画面会被侧栏压成 0 宽');
  }
  const block = poseHtml.match(/@media[^{]*max-width:\s*900px[^{]*\{([\s\S]*?)\n  \}/);
  if (!block || !/main\s*\{[^}]*flex-direction:\s*column/.test(block[1])) {
    problems.push('demo/pose.html: 窄屏媒体查询里要把 main 改成竖向排列，否则侧栏仍会挤掉画面');
  }
  if (!/aside\s*\{[^}]*width:\s*auto/.test(block?.[1] ?? '')) {
    problems.push('demo/pose.html: 窄屏媒体查询里 aside 的宽度要改成 auto，否则它自己就占满一行');
  }
}

// 文件选择器不许写 image/* 这种通配：iPhone 的 HEIC 能被选进来，然后在
// createImageBitmap 里抛一句看不懂的错。accept 与 pose.js 的白名单必须都在。
checked++;
{
  const poseHtml = fs.readFileSync(path.join(root, 'demo/pose.html'), 'utf8');
  const poseJs = fs.readFileSync(path.join(root, 'demo/pose.js'), 'utf8');
  if (/accept="image\/\*"/.test(poseHtml)) {
    problems.push('demo/pose.html: 图片选择器别写 accept="image/*"，HEIC 会被放进来再报一句看不懂的错');
  }
  if (!/accept="image\/png,image\/jpeg,image\/webp"/.test(poseHtml)) {
    problems.push('demo/pose.html: 图片选择器要收 image/png,image/jpeg,image/webp');
  }
  if (!/IMAGE_TYPES\s*=\s*new Set\(/.test(poseJs) || !/typeRejected\(/.test(poseJs)) {
    problems.push('demo/pose.js: 要有 IMAGE_TYPES 白名单与 typeRejected 兜底，别只靠输入框拦');
  }
}

console.log(`检查 ${checked} 项`);
if (problems.length) {
  console.error('问题:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('全部通过');
