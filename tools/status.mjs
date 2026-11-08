// 运行状态体检：确认服务在跑、两个页面都能真加载、控制台无报错、核心功能可用。
// 用法：node tools/status.mjs [端口]
//
// 和 verify-demo.mjs 的区别：那个是"逐项验收"（88 项断言），这个是"开机自检"——
// 只回答一个问题：现在这一刻，系统能不能用。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT_WEB = Number(process.argv[2] ?? 4173);
const PORT_CDP = 9334;
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 服务检查
async function checkServer() {
  const base = `http://127.0.0.1:${PORT_WEB}`;
  const routes = ['/demo/', '/demo/app.js', '/demo/pose.html', '/src/solver.js', '/demo/save.js'];
  const out = [];
  for (const r of routes) {
    try {
      const res = await fetch(base + r, { signal: AbortSignal.timeout(5000) });
      out.push({ route: r, status: res.status, type: res.headers.get('content-type'), ok: res.ok });
    } catch (e) {
      out.push({ route: r, status: 0, error: e.message, ok: false });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 浏览器检查
const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-status-'));

let chrome = null;
async function startChrome() {
  if (!chromePath) return false;
  chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${PORT_CDP}`,
      `--user-data-dir=${userDataDir}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`);
      const list = await r.json();
      if (list.length) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  return false;
}

let nextId = 1;
const pending = new Map();
let ws = null;
const consoleErrors = [];
const pageErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }
    }, 30000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? '页面执行失败');
  }
  return r.result.value;
}

async function openPage(url) {
  await send('Page.navigate', { url });
  await sleep(1500);
}

// ---------------------------------------------------------------- 主流程
const report = { server: [], browser: {}, demo: {}, pose: {} };

console.log(`== 服务 http://127.0.0.1:${PORT_WEB}`);
report.server = await checkServer();
for (const r of report.server) {
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.route}  ${r.status || r.error}  ${r.type ?? ''}`);
}

const allOk = report.server.every((r) => r.ok);
if (!allOk) {
  console.log('\n服务没起来。先跑：node tools/serve.mjs 4173');
  process.exit(1);
}

if (!chromePath) {
  console.log('\n没找到 Chrome / Edge，浏览器部分跳过。');
  process.exit(0);
}

const started = await startChrome();
if (!started) {
  console.log('\nChrome 调试端口没起来。');
  process.exit(1);
}

const list = await (await fetch(`http://127.0.0.1:${PORT_CDP}/json/list`)).json();
const pageTarget = list.find((t) => t.type === 'page') ?? list[0];
ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true });
});

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    consoleErrors.push(m.params.entry.text + ' @ ' + (m.params.entry.url ?? ''));
  }
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');

// ---- 主页面
console.log('\n== 击球求解页');
await openPage(`http://127.0.0.1:${PORT_WEB}/demo/`);
await sleep(1500);

report.demo = JSON.parse(
  await evaluate(`(() => {
    const app = window.__app;
    if (!app) return JSON.stringify({ loaded: false });
    app.setMode('practice');
    app.resetLayout();
    app.runSolve();
    const sol = app.state.solution;
    return JSON.stringify({
      loaded: true,
      mode: app.state.mode,
      table: app.table.preset,
      balls: app.state.balls.length,
      found: Boolean(sol && sol.found),
      advice: document.getElementById('advice').textContent,
      canvasW: document.getElementById('table').width,
    });
  })()`)
);
console.log(`  页面加载 ${report.demo.loaded ? '✓' : '✗'}`);
if (report.demo.loaded) {
  console.log(`  球台 ${report.demo.table} · 台上 ${report.demo.balls} 颗 · 画布 ${report.demo.canvasW}px`);
  console.log(`  求解 ${report.demo.found ? '✓' : '✗'}  ${report.demo.advice}`);
}

// ---- 动作评估页
console.log('\n== 动作评估页');
await openPage(`http://127.0.0.1:${PORT_WEB}/demo/pose.html`);
await sleep(3000);
report.pose = JSON.parse(
  await evaluate(`(() => JSON.stringify({
    loaded: Boolean(window.__pose),
    hasVideo: Boolean(document.getElementById('video')),
    hasPick: Boolean(document.getElementById('pickImage')),
    frames: window.__pose ? window.__pose.frames : null,
  }))()`)
);
console.log(`  页面加载 ${report.pose.loaded ? '✓' : '✗'}`);
console.log(`  视频元素 ${report.pose.hasVideo ? '✓' : '✗'} · 选文件入口 ${report.pose.hasPick ? '✓' : '✗'}`);

console.log('\n== 控制台');
console.log(`  报错 ${consoleErrors.length} 条${consoleErrors.length ? '：' + consoleErrors.join(' | ') : ''}`);
console.log(`  异常 ${pageErrors.length} 条${pageErrors.length ? '：' + pageErrors.join(' | ') : ''}`);

ws.close();
chrome.kill();
await sleep(500);
try {
  fs.rmSync(userDataDir, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

const bad = !report.demo.loaded || !report.demo.found || consoleErrors.length || pageErrors.length;
console.log(`\n${bad ? '✗ 有问题' : '✓ 系统在跑，功能可用'}`);
if (bad) process.exitCode = 1;
