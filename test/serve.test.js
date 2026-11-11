// 静态服务器的边界测试。
//
// 这个服务器是 demo 唯一的运行入口，但之前一个测试都没覆盖它。安全评审用 grep
// 才看出它把整个仓库根目录铺了出去（.git/、_research/、.deepseek-harness/ 全都
// 能 GET 到），另一条是 GET /% 能让进程直接退出。这两条都是「不测就发现不了」的
// 类型，所以这里不只测正常路径，更要测「本来不该给的东西给不给」。

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStaticServer } from '../tools/serve.mjs';
import { freePort } from '../tools/cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

  // .mjs 也必须当 JS 给。姿态页 import 的是 vendor/pose/vision_bundle.mjs，
  // 一旦回成 application/octet-stream，浏览器会以「模块 MIME 类型不对」拒绝执行，
  // 表现是姿态页一直转圈、控制台只有一行看不懂的失败。
  const mjs = await request('/vendor/pose/vision_bundle.mjs');
  assert.equal(mjs.status, 200);
  assert.match(mjs.headers['content-type'], /javascript/);
  assert.ok(mjs.body.length > 1000, '模块内容要完整给出');
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

test('一键启动：起服务后 /demo/ 真的能打开，且不弹浏览器', async () => {
  // 产品问题是「用户拿不到」：直接双击 index.html 是白屏，所以必须有一个
  // 傻瓜入口。这条守的是「node tools/start.mjs 起得来、页面真打开」，
  // 而不只是 serve.mjs 自己 listen 成功。NO_BROWSER=1 避免测试时弹窗口。
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/start.mjs'), String(await freePort())], {
    cwd: ROOT,
    env: { ...process.env, NO_BROWSER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`10 秒内没读出端口：${out}`)), 10000);
      child.stdout.on('data', () => {
        const m = out.match(/127\.0\.0\.1:(\d+)/);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`启动就退出了（${code}）：${out}`)); });
    });

    let resp = null;
    for (let i = 0; i < 40 && !resp; i++) {
      try {
        resp = await fetch(`http://127.0.0.1:${port}/demo/`, { signal: AbortSignal.timeout(1000) });
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    assert.ok(resp, `服务起来了但 /demo/ 打不开：${out}`);
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') ?? '', /text\/html/);
    // 那行提示要等 start.mjs 走完 waitReady 才打出来，给它几秒
    for (let i = 0; i < 25 && !/NO_BROWSER=1/.test(out); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(out, /NO_BROWSER=1/, '要说明这次没开浏览器');
  } finally {
    child.kill();
  }
});