// 极小的 Chrome DevTools Protocol 客户端：启动 headless Chrome、开一个后台 tab、
// 执行 JS、收集控制台错误、截图、关闭。
//
// 为什么自己写：本机没有任何 npm 依赖可用，而 Node 24 自带 WebSocket，
// 直连 CDP 只要一百行，不值得引 puppeteer。
//
// 重要：Chrome 多进程要创建命名管道，在 DSH 的 workspace-write 沙箱下必然失败
// （mojo platform_channel.cc 检查失败）。调用本模块的脚本必须用
// sandbox_permissions: "danger-full-access" 运行。

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// 按平台列候选路径。原先只有 Windows 三条，macOS / Linux 上直接报「找不到
// Chrome」，端到端脚本在这两个平台上完全跑不了。CHROME_PATH 优先，方便装在
// 非标准位置的情况。
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9450, width = 1280, height = 900 } = {}) {
  let exe = null;
  for (const c of CHROME_CANDIDATES) {
    try {
      await fs.access(c);
      exe = c;
      break;
    } catch {}
  }
  if (!exe) {
    throw new Error(
      '找不到 Chrome/Edge。用 CHROME_PATH 指定可执行文件路径，' +
        `当前试过：\n  ${CHROME_CANDIDATES.join('\n  ')}`
    );
  }

  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cdp-'));
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let wsUrl = null;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) {
        wsUrl = j.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(200);
  }
  if (!wsUrl) throw new Error('Chrome 调试端口没起来');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const events = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });

  function rpc(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 120000);
    });
  }

  const { targetId } = await rpc('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc('Target.attachToTarget', { targetId, flatten: true });
  const call = (m, p) => rpc(m, p, sessionId);

  await call('Page.enable');
  await call('Runtime.enable');
  await call('Log.enable');

  /** 收集页面错误（未捕获异常 / console.error / 日志级别 error） */
  function pageErrors() {
    const out = [];
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') {
        const d = e.params.exceptionDetails;
        out.push('异常: ' + (d.exception?.description ?? d.text));
      } else if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        out.push('console.error: ' + e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        out.push('log: ' + e.params.entry.text);
      }
    }
    return out;
  }

  async function goto(url) {
    await call('Page.navigate', { url });
    // 等 load 事件，最多 30 s
    const start = Date.now();
    while (Date.now() - start < 30000) {
      const r = await call('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true,
      });
      if (r.result.value === 'complete') return;
      await sleep(150);
    }
  }

  /** 在页面里求值；expr 是表达式字符串，需自己 return（用 IIFE） */
  async function evaluate(expr, { awaitPromise = true } = {}) {
    const r = await call('Runtime.evaluate', {
      expression: expr,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(
        '页面内报错: ' +
          (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
      );
    }
    return r.result.value;
  }

  /** 轮询直到 expr 返回真值 */
  async function waitFor(expr, { timeout = 30000, interval = 200, label = '' } = {}) {
    const start = Date.now();
    let last;
    while (Date.now() - start < timeout) {
      last = await evaluate(expr);
      if (last) return last;
      await sleep(interval);
    }
    throw new Error(`等待超时${label ? '（' + label + '）' : ''}: ${expr} 最后值=${JSON.stringify(last)}`);
  }

  async function screenshot(file) {
    const r = await call('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async function close() {
    try {
      await rpc('Target.closeTarget', { targetId });
    } catch {}
    try {
      ws.close();
    } catch {}
    proc.kill();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  return { call, evaluate, waitFor, goto, screenshot, pageErrors, close, sleep };
}
