// 零依赖静态服务器：只为了在浏览器里打开 demo/index.html。
//
// 为什么需要它：demo 用 ES modules（<script type="module">），浏览器对 file://
// 下的模块加载会因 CORS 直接拒绝，所以必须走 http。Node 内置 http 模块足够，
// 不引入任何依赖。
//
// 用法：node tools/serve.mjs [端口]
// 默认只监听 127.0.0.1，不对外网开放。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] ?? 4173);

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);

  // 根路径直接跳到 /demo/，而不是把 demo/index.html 的内容挂在 / 上。
  // 后者会让页面里的相对路径 ./app.js 解析成 /app.js，整页 404。
  if (pathname === '/') {
    res.writeHead(302, { location: '/demo/' });
    res.end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  // 浏览器总会来要 favicon，给个 204 免得刷 404 噪音
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 路径穿越防护：解析后必须仍在 ROOT 内
  const filePath = path.resolve(ROOT, '.' + pathname);
  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 越界访问');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 找不到 ' + pathname);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`台球 AI 教练 demo: http://127.0.0.1:${PORT}/`);
  console.log('按 Ctrl+C 停止');
});
