// 零依赖最小化构建：产出 dist/，只剥注释与多余空白，不改一行逻辑。
//
// 为什么自己写词法扫描：本项目的定位是「零运行时依赖、零打包器」。构建期引入
// terser/esbuild 也算给仓库加了一条供应链（还要求 node_modules 才能构建），
// 所以这里只用 node: 内置模块，按 ECMAScript 词法把源码走一遍：
//   - 字符串 / 模板字符串 / 正则字面量整段原样抄下来，一个字节都不动
//   - 只压缩它们之间的空白与注释（模板里的缩进是语义的一部分，不能碰）
//   - 不混淆、不改名、不做任何语法树变换
//
// 换行只在「肯定安全」的位置折叠：`;` 与 `{` 之后、`}` 之前、以及 `}` 后接
// else/catch/finally 或 `)` `]` `}` `,` `;` 时。其余换行一律保留——ASI 的坑
// 不值得为几个字节去踩（`return\nx`、`a = {}\n/re/` 这类都靠换行定语义）。
//
// 用法：
//   node tools/build-min.mjs               构建 dist/（先清空再写）
//   node tools/build-min.mjs --check       只检查 dist/ 是否与源码同步（CI 用）
//   node tools/build-min.mjs --serve 4181  起只读静态服务指向 dist/（本地验证用）
//
// 构建产物：
//   dist/demo/*.js  dist/src/**/*.js      最小化后的源码
//   dist/demo/*.html                      原样复制（HTML 里的空白是语义的一部分）
//   dist/vendor/pose/*                    模型资产原样复制（.task/.wasm 不进仓库，见 .gitignore）
//   dist/BUILD.json                       每个文件的源路径、字节数、源文件 SHA256

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

// ── 词法扫描 ─────────────────────────────────────────────────────────────────

/** 标识符/数字字符。非 ASCII 一律按标识符字符处理（本项目源码里没有，但不能假设）。 */
const isWordChar = (ch) => {
  if (ch === undefined) return false;
  const code = ch.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    ch === '_' || ch === '$' ||
    code > 0x7f
  );
};

/** 这些关键字之后允许出现正则字面量（`return /re/`、`case /re/:`）。 */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** 相邻两个字符会拼成另一个 token 的组合：折叠空白时必须留一个空格。 */
const GLUE_PAIRS = new Set([
  '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '==', '!=', '<=', '>=', '<<', '>>', '&&', '||', '??', '?.',
  '=>', '**', '//', '/*', '<!',
]);

const isQuote = (ch) => ch === '"' || ch === "'";

/** 从引号处扫到配对的引号之后；未闭合则停在行尾（交给 node --check 报错）。 */
function scanString(src, i) {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === quote) return j + 1;
    if (c === '\n' || c === '\r') return j;
    j++;
  }
  return j;
}

/** 从 `/` 处扫正则字面量（含 flags）；不是合法正则（换行前没闭合）返回 -1。 */
function scanRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n' || c === '\r') return -1;
    if (c === '[') { inClass = true; j++; continue; }
    if (c === ']') { inClass = false; j++; continue; }
    if (c === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return -1;
}

function skipBlockComment(src, i) {
  let j = i + 2;
  while (j < src.length && !(src[j] === '*' && src[j + 1] === '/')) j++;
  return Math.min(src.length, j + 2);
}

/** 模板里的 ${...}：数花括号深度，内部的字符串/模板/注释/正则都要跳过。 */
function scanTemplateExpr(src, i) {
  let depth = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; if (depth === 0) return i; continue; }
    if (isQuote(c)) { i = scanString(src, i); continue; }
    if (c === '`') { i = scanTemplate(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') { i = skipBlockComment(src, i); continue; }
    if (c === '/') {
      // 只有表达式位置才可能是正则；这里用「前一个词 + 前一个字符」粗判
      let k = i - 1;
      while (k >= 0 && /\s/.test(src[k])) k--;
      let w = k;
      while (w >= 0 && isWordChar(src[w])) w--;
      const word = src.slice(w + 1, k + 1);
      const before = k >= 0 ? src[k] : '';
      // 前面是 `)` `]` `}` 时保守当成除号；关键字后面则一定按正则处理。
      const exprPos = !isWordChar(before) && !')]}'.includes(before);
      const allowed = REGEX_KEYWORDS.has(word) || exprPos;
      if (allowed) {
        const e = scanRegex(src, i);
        if (e > 0) { i = e; continue; }
      }
    }
    i++;
  }
  return i;
}

/** 从模板起始反引号扫到收尾反引号之后；模板内容原样保留。 */
function scanTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '`') return j + 1;
    if (c === '$' && src[j + 1] === '{') { j = scanTemplateExpr(src, j + 2); continue; }
    j++;
  }
  return j;
}

/** 反向找上一个非 license 的 token，用来判断 `/` 是不是正则开头。 */
function lastSignificant(tokens) {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i].type !== 'license') return tokens[i];
  }
  return null;
}

function regexAllowed(tokens) {
  const last = lastSignificant(tokens);
  if (!last) return true;
  if (last.type === 'punct') {
    if (last.text === ')' || last.text === ']' || last.text === '}') return false;
    // `x++ / y`：紧挨着的两个 `+` 是自增，不是两个一元加号
    if ((last.text === '+' || last.text === '-') &&
        !last.gap.any && tokens[tokens.length - 2]?.text === last.text) return false;
    return true;
  }
  if (last.type === 'word') return REGEX_KEYWORDS.has(last.text);
  return false;
}

/**
 * 把源码切成 token 流。每个 token 记录它前面的空白/注释（gap）：
 * `any` 表示有间隙，`nl` 表示间隙里出现过换行（块注释里的换行也算，ASI 认这个）。
 */
function tokenize(src) {
  const tokens = [];
  let gap = { any: false, nl: false };
  let i = 0;
  const push = (type, text, start, end) => {
    tokens.push({ type, text, gap, start, end });
    gap = { any: false, nl: false };
  };

  while (i < src.length) {
    const c = src[i];

    // 空白（含 BOM / 不换行空格）
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' ||
        c === '\v' || c === '\u00a0' || c === '\ufeff') {
      gap.any = true;
      if (c === '\n' || c === '\r') gap.nl = true;
      i++;
      continue;
    }

    // 单行注释
    if (c === '/' && src[i + 1] === '/') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n' && src[j] !== '\r') j++;
      const text = src.slice(i, j);
      if (text[2] === '!') {
        // `//!` 许可注释：原样保留
        push('license', text, i, j);
      } else {
        gap.any = true; // 后面的换行由下一轮空白处理，会置 nl
      }
      i = j;
      continue;
    }

    // 块注释
    if (c === '/' && src[i + 1] === '*') {
      const j = skipBlockComment(src, i);
      const text = src.slice(i, j);
      if (text[2] === '!') {
        push('license', text, i, j);
      } else {
        gap.any = true;
        // 块注释里的换行对 ASI 有效，必须当成换行保留
        if (/[\r\n]/.test(text)) gap.nl = true;
      }
      i = j;
      continue;
    }

    // 字符串
    if (isQuote(c)) {
      const j = scanString(src, i);
      push('string', src.slice(i, j), i, j);
      i = j;
      continue;
    }

    // 模板字符串（整段原样，含 ${...} 里的内容）
    if (c === '`') {
      const j = scanTemplate(src, i);
      push('template', src.slice(i, j), i, j);
      i = j;
      continue;
    }

    // 正则字面量：只有表达式位置才当正则，否则是除号
    if (c === '/') {
      if (regexAllowed(tokens)) {
        const j = scanRegex(src, i);
        if (j > 0) {
          push('regex', src.slice(i, j), i, j);
          i = j;
          continue;
        }
      }
      push('punct', '/', i, i + 1);
      i++;
      continue;
    }

    // 标识符 / 关键字 / 数字（`1.5` 会切成 `1` `.` `5`，但中间没空白，输出不变）
    if (isWordChar(c)) {
      let j = i;
      while (j < src.length && isWordChar(src[j])) j++;
      push('word', src.slice(i, j), i, j);
      i = j;
      continue;
    }

    // 其余都是单字符标点
    push('punct', c, i, i + 1);
    i++;
  }

  return tokens;
}

// ── 空白折叠 ─────────────────────────────────────────────────────────────────

/** 两个 token 直接拼接会不会粘成别的 token。 */
function needsSpace(prev, cur) {
  const a = prev.text.at(-1);
  const b = cur.text[0];
  if (isWordChar(a) && isWordChar(b)) return true;
  if (/[0-9]/.test(a) && b === '.') return true;
  if (a === '.' && /[0-9]/.test(b)) return true;
  return GLUE_PAIRS.has(a + b);
}

/** 这个换行能不能安全地折成空格/直接删掉。 */
function canDropNewline(prev, cur) {
  if (prev.type !== 'punct') return false;
  if (prev.text === ';' || prev.text === '{') return true;
  if (cur.type === 'punct' && cur.text === '}') return true; // `x\n}` → `x}`
  if (prev.text === '}') {
    // `}` 可能是块尾也可能是对象字面量尾，只放行不可能构成「表达式继续」的后续
    if (cur.type === 'punct' && [')', ']', '}', ',', ';'].includes(cur.text)) return true;
    if (cur.type === 'word' && ['else', 'catch', 'finally'].includes(cur.text)) return true;
  }
  return false;
}

function render(tokens) {
  let out = '';
  let prev = null;
  for (const tok of tokens) {
    const gap = tok.gap;
    let sep = '';
    if (prev) {
      if (gap.nl) {
        sep = canDropNewline(prev, tok) ? (needsSpace(prev, tok) ? ' ' : '') : '\n';
      } else if (gap.any) {
        sep = needsSpace(prev, tok) ? ' ' : '';
      }
    }
    out += sep + tok.text;
    prev = tok;
  }
  return out;
}

/** 最小化一个 JS 源文件。 */
export function minify(src) {
  const tokens = tokenize(src);
  const out = render(tokens);
  return out.endsWith('\n') ? out : out + '\n';
}

/** 源与输出的 token 流是否逐项相同（注释与空白之外一个 token 都不许变）。 */
export function sameTokens(a, b) {
  const ta = tokenize(a).filter((t) => t.type !== 'license');
  const tb = tokenize(b).filter((t) => t.type !== 'license');
  if (ta.length !== tb.length) return { ok: false, reason: `token 数 ${ta.length} → ${tb.length}` };
  for (let i = 0; i < ta.length; i++) {
    if (ta[i].type !== tb[i].type || ta[i].text !== tb[i].text) {
      return { ok: false, reason: `第 ${i + 1} 个 token 不同：${JSON.stringify(ta[i].text)} → ${JSON.stringify(tb[i].text)}` };
    }
  }
  return { ok: true, count: ta.length };
}

// ── 构建清单 ─────────────────────────────────────────────────────────────────

function walk(rel) {
  const abs = path.join(ROOT, rel);
  const out = [];
  const rec = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  rec(abs);
  return out;
}

/** 首屏 JS：从 demo/app.js 与 demo/file-guard.js 沿 import 走过的图。 */
function firstScreenFiles() {
  const seen = new Set();
  const queue = ['demo/app.js', 'demo/file-guard.js'];
  const RE = /(?:^|[^.\w$])(?:import|export)\s+(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
  while (queue.length) {
    const rel = queue.pop();
    if (seen.has(rel) || !rel.endsWith('.js')) continue;
    seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue;
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
  return [...seen].sort();
}

const MINIFY_TARGETS = [
  ...walk('demo').filter((f) => f.endsWith('.js')),
  ...walk('src').filter((f) => f.endsWith('.js')),
];

const COPY_TARGETS = [
  ...walk('demo').filter((f) => f.endsWith('.html')),
  // 第三方已压缩产物：原样复制。自己再压一遍风险大于收益（156 KB 只占首屏之外）。
  'vendor/pose/vision_bundle.mjs',
  'vendor/pose/manifest.json',
  'vendor/pose/LICENSE',
  'vendor/pose/NOTICE',
  ...walk('vendor/pose/wasm'),
  'vendor/pose/pose_landmarker_lite.task',
];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const kb = (n) => (n / 1024).toFixed(1);

function compute() {
  const records = [];
  const outputs = new Map();

  for (const rel of MINIFY_TARGETS) {
    const raw = fs.readFileSync(path.join(ROOT, rel));
    const src = raw.toString('utf8');
    const out = minify(src);
    outputs.set(rel, { buf: Buffer.from(out, 'utf8'), text: out, src });
    records.push({
      path: rel,
      src: rel,
      mode: 'minify',
      srcBytes: raw.length,
      outBytes: Buffer.byteLength(out),
      sha256: sha256(raw),
    });
  }

  for (const rel of COPY_TARGETS) {
    const raw = fs.readFileSync(path.join(ROOT, rel));
    outputs.set(rel, { buf: raw, text: null, src: null });
    records.push({
      path: rel,
      src: rel,
      mode: 'copy',
      srcBytes: raw.length,
      outBytes: raw.length,
      sha256: sha256(raw),
    });
  }

  records.sort((a, b) => a.path.localeCompare(b.path));

  const first = firstScreenFiles();
  const byPath = new Map(records.map((r) => [r.path, r]));
  const sum = (list) => list.reduce((n, rel) => n + (byPath.get(rel)?.srcBytes ?? 0), 0);
  const sumOut = (list) => list.reduce((n, rel) => n + (byPath.get(rel)?.outBytes ?? 0), 0);

  const build = {
    generator: 'tools/build-min.mjs',
    format: 1,
    note: '删注释与空白；sha256 是源码字节的哈希，重建后逐项对比即可判断 dist 是否过期',
    files: records,
    totals: {
      files: records.length,
      srcBytes: records.reduce((n, r) => n + r.srcBytes, 0),
      outBytes: records.reduce((n, r) => n + r.outBytes, 0),
    },
    firstScreen: {
      files: first,
      count: first.length,
      srcBytes: sum(first),
      outBytes: sumOut(first),
    },
  };

  outputs.set('BUILD.json', {
    buf: Buffer.from(JSON.stringify(build, null, 2) + '\n', 'utf8'),
    text: null,
    src: null,
  });

  return { records, outputs, build };
}

function report(build) {
  const { totals, firstScreen } = build;
  const jss = build.files.filter((f) => f.mode === 'minify');
  const jsIn = jss.reduce((n, f) => n + f.srcBytes, 0);
  const jsOut = jss.reduce((n, f) => n + f.outBytes, 0);
  console.log(`dist：${totals.files} 个文件，${kb(totals.srcBytes)} KB → ${kb(totals.outBytes)} KB`);
  console.log(`最小化 JS ${jss.length} 个：${kb(jsIn)} KB → ${kb(jsOut)} KB（省 ${(100 - (jsOut / jsIn) * 100).toFixed(1)}%）`);
  console.log(
    `首屏 ${firstScreen.count} 个 JS：${kb(firstScreen.srcBytes)} KB → ${kb(firstScreen.outBytes)} KB` +
    `（省 ${(100 - (firstScreen.outBytes / firstScreen.srcBytes) * 100).toFixed(1)}%）`,
  );

  const picked = build.files.filter((f) => firstScreen.files.includes(f.path) && f.mode === 'minify');
  const rate = (f) => (f.srcBytes - f.outBytes) / f.srcBytes;
  const top = [...picked].sort((a, b) => rate(b) - rate(a)).slice(0, 5);
  const low = [...picked].sort((a, b) => rate(a) - rate(b)).slice(0, 5);
  const row = (f) => `${f.path} ${kb(f.srcBytes)}→${kb(f.outBytes)} KB（-${(rate(f) * 100).toFixed(1)}%）`;
  console.log('压缩率最高 5 个：\n  ' + top.map(row).join('\n  '));
  console.log('压缩率最低 5 个：\n  ' + low.map(row).join('\n  '));
}

function writeOutputs(outputs) {
  fs.rmSync(DIST, { recursive: true, force: true });
  for (const [rel, { buf }] of outputs) {
    const dst = path.join(DIST, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
  }
}

function check() {
  const { outputs, build } = compute();
  const problems = [];

  for (const [rel, { buf, text, src }] of outputs) {
    const abs = path.join(DIST, rel);
    if (!fs.existsSync(abs)) { problems.push(`缺文件：${rel}`); continue; }
    const disk = fs.readFileSync(abs);
    if (!disk.equals(buf)) { problems.push(`内容过期：${rel}`); continue; }
    if (text !== null) {
      const eq = sameTokens(src, text);
      if (!eq.ok) problems.push(`token 不一致：${rel}（${eq.reason}）`);
    }
  }

  const jsonPath = path.join(DIST, 'BUILD.json');
  if (fs.existsSync(jsonPath)) {
    const onDisk = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (JSON.stringify(onDisk) !== JSON.stringify(build)) problems.push('BUILD.json 与当前源码不一致');
  }

  if (problems.length) {
    console.error('dist 不是最新的：');
    for (const p of problems) console.error('  - ' + p);
    process.exitCode = 1;
    return;
  }
  console.log(`dist 与源码一致（${build.files.length} 个文件，首屏 ${kb(build.firstScreen.outBytes)} KB）`);
}

// ── 本地验证用的只读静态服务 ─────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

function serve(port) {
  if (!fs.existsSync(path.join(DIST, 'demo', 'index.html'))) {
    console.error('dist/ 还不存在，先跑 node tools/build-min.mjs');
    process.exitCode = 1;
    return;
  }
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400).end('bad path');
      return;
    }
    if (pathname === '/') { res.writeHead(302, { location: '/demo/' }).end(); return; }
    // 浏览器总会来要 favicon；给 204，免得 E2E 把它记成一条控制台错误（tools/serve.mjs 同款处理）。
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const abs = path.resolve(DIST, '.' + pathname);
    if (!abs.startsWith(DIST + path.sep)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(abs, (err, body) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`dist 预览：http://127.0.0.1:${port}/demo/`);
    console.log(`姿态页：http://127.0.0.1:${port}/demo/pose.html`);
  });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

const arg = process.argv[2];

if (arg === '--serve') {
  serve(Number(process.argv[3] ?? 4181));
} else if (arg === '--check') {
  check();
} else if (arg === '--help' || arg === '-h') {
  console.log('用法：node tools/build-min.mjs [--check | --serve 端口]');
} else {
  const { outputs, build } = compute();
  writeOutputs(outputs);
  report(build);
  console.log('BUILD.json 已写入（含每个源文件的 SHA256，可用 --check 验过期）');
}