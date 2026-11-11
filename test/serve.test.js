// 静态服务器的边界测试。
//
// 这个服务器是 demo 唯一的运行入口，但之前一个测试都没覆盖它。安全评审用 grep
// 才看出它把整个仓库根目录铺了出去（.git/、_research/、.deepseek-harness/ 全都
// 能 GET 到），另一条是 GET /% 能让进程直接退出。这两条都是「不测就发现不了」的
// 类型，所以这里不只测正常路径，更要测「本来不该给的东西给不给」。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createStaticServer } from '../tools/serve.mjs';

let server;
let port;

before(async () => {
  server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 发一个请求，返回状态码、头与响应体。Host 可以伪造。 */
function request(pathname, { method = 'GET', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: host ? { host } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('静态服务：demo 页面、src 模块、vendor 模型都照常给', async () => {
  const page = await request('/demo/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);

  const mod = await request('/src/solver.js');
  assert.equal(mod.status, 200);
  assert.match(mod.headers['content-type'], /javascript/);

  // wasm 的 MIME 必须对，否则 WebAssembly.instantiateStreaming 会拒绝加载
  const wasm = await request('/vendor/pose/wasm/vision_wasm_internal.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers['content-type'], 'application/wasm');
});

test('静态服务：根路径跳到 /demo/，favicon 回 204 不刷 404', async () => {
  const root = await request('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.location, '/demo/');

  const icon = await request('/favicon.ico');
  assert.equal(icon.status, 204);
});

test('静态服务：.git 里的东西一律读不到', async () => {
  for (const p of ['/.git/config', '/.git/HEAD', '/.git']) {
    const res = await request(p);
    assert.equal(res.status, 403, `${p} 不该开放，实际 ${res.status}`);
  }
});

test('静态服务：素材目录与会话记忆读不到', async () => {
  for (const p of [
    '/_research/cand/s01.png',
    '/.deepseek-harness/memory/2026-11-11.md',
    '/package.json',
    '/README.md',
  ]) {
    const res = await request(p);
    assert.equal(res.status, 403, `${p} 不该开放，实际 ${res.status}`);
  }
});

test('静态服务：编码后的穿越也读不到', async () => {
  // %2e%2e 解码成 ..，必须被段检查拦住，而不是交给 path.resolve 去消解
  const res = await request('/demo/%2e%2e/%2e%2e/etc/passwd');
  assert.equal(res.status, 403);
  assert.doesNotMatch(res.body, /root:/);
});

test('静态服务：畸形编码回 400，且服务不会因此退出', async () => {
  const bad = await request('/%');
  assert.equal(bad.status, 400);

  // 关键：一条畸形请求之后，服务必须还活着
  const ok = await request('/demo/index.html');
  assert.equal(ok.status, 200);
});

test('静态服务：Host 不在白名单就拒绝（挡 DNS rebinding）', async () => {
  const evil = await request('/demo/index.html', { host: 'evil.example.com' });
  assert.equal(evil.status, 421);

  const normal = await request('/demo/index.html', { host: `127.0.0.1:${port}` });
  assert.equal(normal.status, 200);

  const localhost = await request('/demo/index.html', { host: `localhost:${port}` });
  assert.equal(localhost.status, 200);
});

test('静态服务：只接受 GET 与 HEAD', async () => {
  const post = await request('/demo/index.html', { method: 'POST' });
  assert.equal(post.status, 405);

  const head = await request('/demo/index.html', { method: 'HEAD' });
  assert.equal(head.status, 200);
});

test('静态服务：开放目录里不存在的文件回 404，不泄露磁盘路径', async () => {
  const res = await request('/demo/nope.html');
  assert.equal(res.status, 404);
  assert.doesNotMatch(res.body, /D:\\|台球ai教练/);
});