// 零依赖静态服务器：只为了在浏览器里打开 demo/index.html。
//
// 为什么需要它：demo 用 ES modules（<script type="module">），浏览器对 file://
// 下的模块加载会因 CORS 直接拒绝，所以必须走 http。Node 内置 http 模块足够，
// 不引入任何依赖。
//
// 它是给本机开发用的，不是发布用的服务器。即便如此也不该把整个仓库根目录铺出去：
// ROOT 上有 .git/（完整历史）、_research/（截图与视频素材）、.deepseek-harness/
// （会话记忆），随便一个 GET 就能读到。所以这里按目录白名单放行，只开浏览器真正
// 需要的三个目录。
//
// 用法：node tools/serve.mjs [端口]
// 默认只监听 127.0.0.1，不对外网开放。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] ?? 4173);

// 只放行这三个目录：
//   demo/   —— 页面本身
//   src/    —— 页面 import 的模块
//   vendor/ —— MediaPipe 的姿态模型与 wasm（不能去掉，否则 pose 页 404）
const ALLOWED_DIRS = new Set(['demo', 'src', 'vendor']);

// Host 白名单。不校验 Host 的话，任意网页都能用 DNS rebinding 指到 127.0.0.1
// 再读这些文件；虽然只监听回环地址挡不住这种玩法。
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  // 姿态模型走 vendor/pose/：wasm 必须是 application/wasm，否则
  // WebAssembly.instantiateStreaming 会报 "Incorrect response MIME type"。
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const text = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
};

// ── 响应压缩 ─────────────────────────────────────────────────────────────────
//
// 首屏那批 ES module 是未压缩的纯文本（约 589 KB），传输时压一遍收益极大。
// node:zlib 自带 gzip/brotli，仍然零依赖。

// 小于这个字节数就原样返回：压缩头 + 字典本身的开销会让小文件反而变大。
const MIN_COMPRESS_BYTES = 1024;

// 只压文本类。png/jpg/wasm/mp4/task 已经是压缩格式，再压既浪费时间又会让
// 体积略微变大。
const COMPRESSIBLE_TYPES = new Set([
  'application/javascript',
  'application/json',
  'image/svg+xml',
]);

// 压缩结果缓存上限：条数 64、解压后总量 32 MB，两者任一超限就从最久未用的一端
// 淘汰。按「路径 + mtime + 大小 + 编码」做键，文件一改就自然落不到旧条目上。
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** @type {Map<string, Buffer>} 插入顺序即 LRU 顺序（命中后重新 set 到尾部）。 */
const compressCache = new Map();
let compressCacheBytes = 0;

/** 该 MIME 是否值得压缩。 */
function isCompressible(contentType) {
  const base = contentType.split(';')[0].trim().toLowerCase();
  if (base.startsWith('text/')) return true;
  if (COMPRESSIBLE_TYPES.has(base)) return true;
  // application/*+json、application/*+xml 这类结构化文本同样可压
  return /[+/](json|xml)$/.test(base);
}

/**
 * 按 Accept-Encoding 选编码：br 优先，其次 gzip，都不接受就返回 null（原样返回）。
 * 认 q 值（包括 q=0 表示明确不接受），也认 `*` 通配。
 */
function pickEncoding(header) {
  if (!header) return null;
  const prefs = new Map();
  for (const part of String(header).split(',')) {
    const [rawName, ...params] = part.split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    prefs.set(name, Number.isFinite(q) ? q : 0);
  }
  const score = (name) => (prefs.has(name) ? prefs.get(name) : (prefs.get('*') ?? 0));
  const br = score('br');
  const gzip = score('gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

function compressBody(encoding, body) {
  if (encoding === 'br') {
    return zlib.brotliCompressSync(body, {
      params: {
        // 质量 9 + size hint：比 11 快一个量级、体积只差几个百分点，配合缓存更划算
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return zlib.gzipSync(body, { level: 9 });
}

/**
 * 取（并缓存）压缩结果；压完不比原文件小就返回 null，让调用方走原样返回。
 */
function compressedFor(filePath, stat, encoding, body) {
  const key = `${filePath}\u0000${encoding}\u0000${stat.size}\u0000${stat.mtimeMs}`;
  const hit = compressCache.get(key);
  if (hit) {
    compressCache.delete(key);
    compressCache.set(key, hit);
    return hit;
  }
  const out = compressBody(encoding, body);
  if (out.length >= body.length) return null;
  compressCache.set(key, out);
  compressCacheBytes += out.length;
  while (compressCache.size > CACHE_MAX_ENTRIES || compressCacheBytes > CACHE_MAX_BYTES) {
    const [oldKey, oldValue] = compressCache.entries().next().value;
    compressCache.delete(oldKey);
    compressCacheBytes -= oldValue.length;
  }
  return out;
}

/** Host 头是否在白名单里（允许带端口，也允许 IPv6 方括号写法）。 */
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  try {
    return ALLOWED_HOSTS.has(new URL('http://' + hostHeader).hostname);
  } catch {
    return false;
  }
}

/**
 * 把请求路径解析成磁盘路径；不合法就返回 { code, message }。
 * 只做判断，不碰文件系统。
 */
function resolvePath(pathname) {
  const rel = pathname.replace(/^\/+/, '');
  if (rel === '') return { code: 404, message: '404 没有这个路径' };

  const segs = rel.split('/');
  for (const seg of segs) {
    // 空段、以点开头的段（.git / .. / .deepseek-harness）、反斜杠（Windows 分隔符）、
    // NUL（%00，readFile 会同步抛错把进程带走）一律拒绝。
    if (seg === '' || seg.startsWith('.') || seg.includes('\\') || seg.includes('\0')) {
      return { code: 403, message: '403 这个路径不对外开放' };
    }
  }
  if (!ALLOWED_DIRS.has(segs[0])) {
    return { code: 403, message: '403 只开放 /demo /src /vendor' };
  }

  const filePath = path.resolve(ROOT, ...segs);
  // 双保险：resolve 之后也必须仍在 ROOT 内
  if (!filePath.startsWith(ROOT + path.sep)) {
    return { code: 403, message: '403 越界访问' };
  }
  return { filePath };
}

async function handle(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text(res, 405, '405 只接受 GET / HEAD');
  }

  if (!hostAllowed(req.headers.host)) {
    // 421 Misdirected Request：这个 Host 不是我要服务的那个名字
    return text(res, 421, '421 Host 不在白名单里');
  }

  let url;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return text(res, 400, '400 请求地址解析不了');
  }

  // decodeURIComponent 对 "/%" 这种畸形编码会抛 URIError。不接住的话异常会
  // 从 createServer 的回调里冒出来，整个进程退出——任意网页一个 <img> 就够。
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return text(res, 400, '400 路径编码不合法');
  }

  // 根路径直接跳到 /demo/，而不是把 demo/index.html 的内容挂在 / 上。
  // 后者会让页面里的相对路径 ./app.js 解析成 /app.js，整页 404。
  if (pathname === '/') {
    res.writeHead(302, { location: '/demo/' });
    return res.end();
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // 浏览器总会来要 favicon，给个 204 免得刷 404 噪音。
  // 注意这条要在白名单之前，否则 /favicon.ico 会被当成「不在开放目录里」拒掉。
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }

  const resolved = resolvePath(pathname);
  if (resolved.code) return text(res, resolved.code, resolved.message);

  let stat;
  let body;
  try {
    stat = await fs.promises.stat(resolved.filePath);
    body = await fs.promises.readFile(resolved.filePath);
  } catch {
    return text(res, 404, '404 找不到 ' + pathname);
  }

  const contentType = MIME[path.extname(resolved.filePath)] ?? 'application/octet-stream';
  const headers = {
    'content-type': contentType,
    'cache-control': 'no-cache',
    // 只给本机开发用，明确告诉浏览器别把它当同源接口随便 fetch
    'x-content-type-options': 'nosniff',
  };

  const compressible = isCompressible(contentType);
  if (compressible) {
    // 是否压缩取决于请求头，缓存与代理必须按这个维度分桶
    headers.vary = 'Accept-Encoding';
    if (body.length >= MIN_COMPRESS_BYTES) {
      const encoding = pickEncoding(req.headers['accept-encoding']);
      const encoded = encoding ? compressedFor(resolved.filePath, stat, encoding, body) : null;
      if (encoded) {
        headers['content-encoding'] = encoding;
        headers['content-length'] = String(encoded.length);
        res.writeHead(200, headers);
        // HEAD 请求由 Node 自己丢掉 body，Content-Length 仍是压缩后的真实字节数
        return res.end(encoded);
      }
    }
  }

  headers['content-length'] = String(body.length);
  res.writeHead(200, headers);
  return res.end(body);
}

/**
 * 建服务器但不监听。测试里 import 它、listen(0) 拿随机端口；
 * 命令行直接跑时由文件末尾那段自己 listen。
 */
export function createStaticServer() {
  return http.createServer((req, res) => {
    // 兜底：任何一处没预料到的异常都只影响这一个请求，
    // 不能让一个请求把整个静态服务带走。handle 现在是 async，
    // 同步段之外的拒绝也要接住。
    const fail = (err) => {
      if (!res.headersSent) text(res, 500, '500 ' + (err?.message ?? '未知错误'));
      else res.end();
    };
    try {
      const ret = handle(req, res);
      if (ret && typeof ret.then === 'function') ret.then(undefined, fail);
    } catch (err) {
      fail(err);
    }
  });
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  createStaticServer().listen(PORT, '127.0.0.1', () => {
    console.log(`台球 AI 教练 demo: http://127.0.0.1:${PORT}/`);
    console.log(`只开放 ${[...ALLOWED_DIRS].map((d) => '/' + d).join(' ')}，按 Ctrl+C 停止`);
  });
}