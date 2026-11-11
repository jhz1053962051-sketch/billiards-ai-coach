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

function handle(req, res) {
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

  fs.readFile(resolved.filePath, (err, data) => {
    if (err) return text(res, 404, '404 找不到 ' + pathname);
    res.writeHead(200, {
      'content-type': MIME[path.extname(resolved.filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      // 只给本机开发用，明确告诉浏览器别把它当同源接口随便 fetch
      'x-content-type-options': 'nosniff',
    });
    res.end(data);
  });
}

/**
 * 建服务器但不监听。测试里 import 它、listen(0) 拿随机端口；
 * 命令行直接跑时由文件末尾那段自己 listen。
 */
export function createStaticServer() {
  return http.createServer((req, res) => {
    // 兜底：任何一处没预料到的同步异常都只影响这一个请求，
    // 不能让一个请求把整个静态服务带走。
    try {
      handle(req, res);
    } catch (err) {
      if (!res.headersSent) text(res, 500, '500 ' + (err?.message ?? '未知错误'));
      else res.end();
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