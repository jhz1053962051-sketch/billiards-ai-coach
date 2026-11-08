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
  { script: 'demo/pose.js', html: 'demo/pose.html' },
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
}

console.log(`检查 ${checked} 项`);
if (problems.length) {
  console.error('问题:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('全部通过');
