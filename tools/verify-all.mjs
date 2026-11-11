// 一键跑完三项门禁：单元测试 → 演示页静态检查 → 浏览器端到端验证。
//
// 为什么需要它：AGENTS.md 写着「交付前所有测试和验证必须全部通过」，而三项分散在
// 三个命令里，靠人记就会漏——漏掉的那次恰好是改坏了东西的那次。这里把顺序、
// 起服务的时机、收尾的清理都固定下来，只输出一句结论和一个退出码。
//
// 用法：node tools/verify-all.mjs
//       npm run verify
//
// 注意：端到端那一步要启动 Chrome，必须在不限制命名管道的环境里跑
// （DSH 里是 sandbox_permissions: "danger-full-access"）；沙箱受限时它会失败，
// 但那一步的失败是「环境不允许」而不是「代码坏了」，输出里会原样转述浏览器的报错。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { freePort } from './cdp.mjs';

const root = path.resolve(import.meta.dirname, '..');
const results = [];

/** 跑一条命令，把输出直接透传（出错时人要看得到原始信息）。 */
function run(name, args, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, ...env },
    });
    child.on('error', (err) => {
      results.push({ name, code: 1, ms: Date.now() - started, note: err.message });
      resolve(1);
    });
    child.on('exit', (code) => {
      results.push({ name, code: code ?? 1, ms: Date.now() - started });
      resolve(code ?? 1);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起临时静态服务，返回 { url, stop }。端口现取，避免撞上手动起的那个。 */
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, ['tools/serve.mjs', String(port)], {
    cwd: root,
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}/demo/`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { url, stop: () => child.kill() };
    } catch {
      /* 还没起来 */
    }
    await sleep(150);
  }
  child.kill();
  throw new Error(`临时静态服务没起来：${url}`);
}

console.log('=== 1/3 单元测试 ===');
const testCode = await run('单元测试', ['--test', '--test-isolation=none', 'test/*.test.js']);

console.log('\n=== 2/3 演示页静态检查 ===');
const checkCode = await run('演示页静态检查', ['tools/check-demo.mjs']);

console.log('\n=== 3/3 浏览器端到端 ===');
let serve = null;
let demoCode = 1;
try {
  serve = await startServer();
  console.log(`临时静态服务：${serve.url}`);
  demoCode = await run('浏览器端到端', ['tools/verify-demo.mjs'], { DEMO_URL: serve.url });
} catch (err) {
  console.error(err.message);
  results.push({ name: '浏览器端到端', code: 1, ms: 0, note: err.message });
} finally {
  serve?.stop();
}

// 手起过 4173 的话，临时服务是另开的一个端口，两边互不影响。
console.log('\n=== 汇总 ===');
for (const r of results) {
  const status = r.code === 0 ? '通过' : `失败（退出码 ${r.code}）`;
  console.log(`${status.padEnd(16)} ${r.name}  ${(r.ms / 1000).toFixed(1)}s${r.note ? `  ${r.note}` : ''}`);
}
const failed = [testCode, checkCode, demoCode].filter((c) => c !== 0).length;
if (failed) {
  console.error(`\n${failed} 项没过，别交付。`);
  process.exit(1);
}
console.log('\n三项全过。');