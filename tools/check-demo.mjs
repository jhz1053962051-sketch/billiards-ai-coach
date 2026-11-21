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
    const names = match[1]
      .split(',')
      // `import { x as y }` 的别名要剥掉，否则会拿整串「x as y」去模块里找导出，
      // 明明存在也报缺失。
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
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

// 门禁本身也要有人看着：姿态页是独立入口，它没进 npm run verify 的时候，
// CSP 漏一条就能让整页白屏而没人发现。另外 verify-pose 缺素材时会把三条路径
// 全跳过却照样打印「全部通过」——那种假绿比没有门禁更害人。
{
  const allPath = path.join(root, 'tools/verify-all.mjs');
  if (!fs.existsSync(allPath)) {
    problems.push('tools/verify-all.mjs 不存在，一键门禁没了');
  } else {
    const all = fs.readFileSync(allPath, 'utf8');
    checked++;
    if (!/tools\/verify-pose\.mjs/.test(all)) {
      problems.push('tools/verify-all.mjs: 没跑 tools/verify-pose.mjs —— 姿态页就不在门禁里了');
    }
  }

  const posePath = path.join(root, 'tools/verify-pose.mjs');
  if (!fs.existsSync(posePath)) {
    problems.push('tools/verify-pose.mjs 不存在');
  } else {
    const pose = fs.readFileSync(posePath, 'utf8');
    checked++;
    if (!/passed\s*===\s*0/.test(pose)) {
      problems.push('tools/verify-pose.mjs: 少了「一条都没验到就不算通过」的守卫，会假绿');
    }
    checked++;
    if (!/function blankPng\(/.test(pose)) {
      problems.push('tools/verify-pose.mjs: 缺 blankPng，素材缺失时整条链路没验');
    }
  }
}

// ---------------------------------------------------------------- state.js 零 DOM
//
// demo/state.js 的契约是「纯状态层，零 DOM 访问」——它存在的唯一理由就是能在
// Node 里被单测直接加载。上面那些 `await import()` 只兜得住**直接**写 document
// 这种硬错；window.foo / navigator.x / new Image() / performance.now() 里有的在
// Node 22 恰好存在、有的是惰性求值，import 过去一声不响，等到单测真跑到那一行才炸，
// 而在浏览器里又是另一套语义。所以这条契约得静态钉住，而不是留在文件头的注释里。
//
// 选这组词的理由：
//   document / window / globalThis        —— 浏览器全局，也是抓 DOM 的两个入口
//   localStorage / sessionStorage         —— 浏览器存储（本层只允许经由 demo/save.js）
//   navigator                             —— 平台信息，Node 22 里真的存在，最容易漏
//   requestAnimationFrame                 —— 帧循环，属于渲染层
//   HTMLCanvasElement / CanvasRenderingContext2D / Element / Event
//                                         —— 判断「这是不是 DOM 对象」的常见写法
//   addEventListener                      —— 绑事件意味着日后要有人解绑，不是纯状态
//   new Image                             —— 唯一按构造式用的全局；只认 `new Image`，
//                                            免得把 `Image` 这种普通标识符也算进来

// 关键字一律按「整词」匹配：HTMLCanvasElement 不会被 Element 重复计一次，
// documentElement / EventTarget 这种也不会误伤。
const DOM_KEYWORDS = [
  'document',
  'window',
  'globalThis',
  'localStorage',
  'sessionStorage',
  'navigator',
  'requestAnimationFrame',
  'HTMLCanvasElement',
  'CanvasRenderingContext2D',
  'Element',
  'Event',
  'addEventListener',
  'new Image',
];

// 把注释和字符串字面量抹成空格，得到「只剩代码」的等长文本。
// 等长是关键：行号可以直接拿 index 数 \n 算，报错才指得到原始行。
//
// 为什么要真扫一遍而不是几条正则：
//   - 本仓库有 http:// 这种含 // 的字符串（demo/file-guard.js），裸正则会把
//     整行后半截当注释吃掉，把命中藏起来；
//   - 反过来，错误文案里提一句 "window" 不该算违规，所以字符串内容也要抹掉，
//     只留下引号本身（引号留着，避免 doc + 'ument' 拼成一个假关键字）。
// 模板字面量里的 ${...} 是**代码**，要递归扫；字面量部分是内容，抹掉。
// 正则字面量按「前一个有意义字符 / 前一个关键字」判断，抹掉整段：
// 既不让 /\/\// 被当成行注释，也不让 /document/ 变成假命中。
// 已知精度取舍：正则判定用的是经典启发式（上一字符属于 ( , = : [ ! & | ? { } ; 等
// 或紧跟在 return / typeof / case 之后），不是完整的词法分析；极端写法可能判错，
// 但判错的两种后果都只会落在同一行内，不会让别的行假绿。
function stripCommentsAndStrings(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = Math.max(0, from); k < Math.min(to, n); k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  const frames = [{ kind: 'code', depth: 0 }];
  const REGEX_AFTER_WORD = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new',
    'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
  ]);
  let i = 0;
  let prevSig = '';
  let prevWord = '';

  while (i < n) {
    const frame = frames[frames.length - 1];
    const c = src[i];
    const c2 = src[i + 1];

    if (frame.kind === 'template') {
      if (c === '\\') { blank(i, i + 2); i += 2; continue; }
      if (c === '`') { frames.pop(); prevSig = '`'; prevWord = ''; i++; continue; }
      if (c === '$' && c2 === '{') {
        frames.push({ kind: 'code', depth: 0 });
        blank(i, i + 2); i += 2; prevSig = '{'; prevWord = ''; continue;
      }
      blank(i, i + 1); i++; continue;
    }

    if (c === '/' && c2 === '/') {
      const s = i; i += 2;
      while (i < n && src[i] !== '\n') i++;
      blank(s, i); continue;
    }
    if (c === '/' && c2 === '*') {
      const s = i; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blank(s, i); continue;
    }
    const regexLooksRight = prevSig === ''
      || '(),=:[!&|?{};+-*%<>~^'.includes(prevSig)
      || REGEX_AFTER_WORD.has(prevWord);
    if (c === '/' && regexLooksRight) {
      const s = i; i++;
      let inClass = false;
      while (i < n) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') break;
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) { i++; break; }
        i++;
      }
      blank(s, i); prevSig = ')'; prevWord = ''; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; const s = i; i++;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i = Math.min(n, i + 1);
      blank(s + 1, i - 1);
      prevSig = q; prevWord = ''; continue;
    }
    if (c === '`') { frames.push({ kind: 'template' }); prevSig = '`'; prevWord = ''; i++; continue; }
    if (c === '{') { frame.depth += 1; prevSig = '{'; prevWord = ''; i++; continue; }
    if (c === '}') {
      if (frame.depth === 0 && frames.length > 1) frames.pop();
      else frame.depth -= 1;
      prevSig = '}'; prevWord = ''; i++; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      prevWord = /[A-Za-z0-9_$]/.test(prevSig) ? prevWord + c : c;
      prevSig = c; i++; continue;
    }
    if (!/\s/.test(c)) { prevSig = c; prevWord = ''; }
    i++;
  }
  return out.join('');
}

/** 返回 [{ kw, line, text }]：line 是原始文件行号，text 是那一行的原文（去首尾空白）。 */
function findDomRefs(src) {
  const code = stripCommentsAndStrings(src);
  const lines = src.split('\n');
  const hits = [];
  for (const kw of DOM_KEYWORDS) {
    const re = kw.includes(' ')
      ? new RegExp(`\\b${kw.split(/\s+/)[0]}\\s+${kw.split(/\s+/)[1]}\\b`, 'g')
      : new RegExp(`(?<![\\w$])${kw}(?![\\w$])`, 'g');
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length;
      hits.push({ kw, line, text: (lines[line - 1] ?? '').trim() });
    }
  }
  return hits;
}

{
  const rel = 'demo/state.js';
  const statePath = path.join(root, rel);
  checked++;
  if (!fs.existsSync(statePath)) {
    problems.push(`${rel}: 文件不存在——纯状态层被搬走或改名了？`);
  } else {
    const src = fs.readFileSync(statePath, 'utf8');
    const hits = findDomRefs(src);
    for (const kw of DOM_KEYWORDS) checked++;
    // 报错要能直接指到行：只说「有一条失败」等于让人从头翻 270 行。
    for (const h of hits) {
      problems.push(`${rel}:${h.line} 出现 DOM 全局 ${h.kw}，状态层要能在 Node 里裸跑：${h.text}`);
    }

    // 检测器自检：往同一套 findDomRefs 里喂合成样本。
    // 少了这一步，哪天剥注释写坏了（比如把整段抹空、或把代码也当字符串抹掉），
    // 上面 13 项会永远全绿而没有任何东西会说话——和 verify-pose 缺素材仍报
    // 「全部通过」是同一类假绿。
    checked++;
    const canary = findDomRefs('const _x = document.title;\n');
    if (canary.length !== 1 || canary[0].kw !== 'document' || canary[0].line !== 1) {
      problems.push('tools/check-demo.mjs: 零 DOM 检测器自检没命中合成的 document（检测器坏了，上面那条断言是假绿）');
    }
    checked++;
    const decoy = findDomRefs([
      '// document.title 只是注释',
      '/* window.localStorage */',
      "const s = 'window.navigator';",
      'const t = `new Image()`;',
      'const re = /document/;',
      'const _y = document.readyState;',
    ].join('\n') + '\n');
    if (decoy.length !== 1 || decoy[0].line !== 6) {
      problems.push(`tools/check-demo.mjs: 零 DOM 检测器把注释/字符串算成了命中（应只报第 6 行，实际 ${JSON.stringify(decoy.map((h) => h.line))}）`);
    }
  }
}

console.log(`检查 ${checked} 项`);
if (problems.length) {
  console.error('问题:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('全部通过');
