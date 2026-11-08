// 一键启动：起静态服务器（若未在跑）+ 打开浏览器。
//
// 为什么要有这个：demo 用 ES modules，浏览器对 file:// 下的模块加载会因 CORS
// 直接拒绝，所以必须先起 http 服务。之前要两条命令，容易只做一半
// （起了服务器忘了开浏览器，或反过来打开 file:// 看到白屏）。
//
// 幂等：端口已被占用时不会重复起服务，只打开浏览器。这样可以反复执行。
//
// 用法：node tools/start.mjs [端口]
// 默认只监听 127.0.0.1，不对外网开放。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.argv[2] ?? 4173);

// 按平台列候选路径：原先只列了 Windows 的三条，macOS / Linux 上永远走
// 「没找到 Chrome / Edge」分支。CHROME_PATH 优先，方便装在非标准位置。
const BROWSERS = [
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
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

/** 端口上有没有人在听。 */
function isListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(1500, () => done(false));
  });
}

/** 服务器真的能响应，而不只是端口被别的程序占了。 */
async function responds(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/demo/`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

async function waitReady(port, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await responds(port)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

let child = null;
const already = await responds(PORT);

if (already) {
  console.log(`服务已在运行：http://127.0.0.1:${PORT}/`);
} else if (await isListening(PORT)) {
  console.error(
    `端口 ${PORT} 被别的程序占用了，但它不响应 /demo/。\n` +
      `换一个端口：node tools/start.mjs 4174`
  );
  process.exit(1);
} else {
  console.log(`启动静态服务器…`);
  child = spawn(process.execPath, [path.join(__dirname, 'serve.mjs'), String(PORT)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (e) => {
    console.error(`服务器启动失败：${e.message}`);
    process.exit(1);
  });

  if (!(await waitReady(PORT))) {
    console.error(`服务器在 15 秒内没有响应，请检查端口 ${PORT} 是否可用。`);
    child.kill();
    process.exit(1);
  }
  console.log(`服务已就绪：http://127.0.0.1:${PORT}/`);
}

const browser = BROWSERS.find((p) => fs.existsSync(p));
const url = `http://127.0.0.1:${PORT}/demo/`;

if (browser) {
  // detached：浏览器窗口不随本进程退出而关闭
  spawn(browser, ['--new-window', url], { detached: true, stdio: 'ignore' }).unref();
  console.log(`已在浏览器打开：${url}`);
} else {
  console.log(`没找到 Chrome / Edge，请手动打开：${url}`);
}

console.log('');
console.log(`  击球求解  ${url}`);
console.log(`  动作评估  ${url}pose.html`);
console.log('');

if (child) {
  console.log('服务器在本进程内运行，按 Ctrl+C 停止。');
  // 让 node 保持存活，把 Ctrl+C 转给子进程
  const stop = () => {
    child.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  console.log('服务器由其他进程提供，本命令到此结束。');
}
