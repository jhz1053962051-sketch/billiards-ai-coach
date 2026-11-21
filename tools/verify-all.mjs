// 一键跑完四项门禁：单元测试 → 演示页静态检查 → 浏览器端到端验证 → 姿态页验证。
//
// 为什么需要它：AGENTS.md 写着「交付前所有测试和验证必须全部通过」，而四项分散在
// 四个命令里，靠人记就会漏——漏掉的那次恰好是改坏了东西的那次。这里把顺序、
// 起服务的时机、收尾的清理都固定下来，只输出一句结论和一个退出码。
//
// 姿态页那一项曾经不在门禁里，结果 CSP 漏了 media-src 让整页白屏都没人发现。
//
// 用法：node tools/verify-all.mjs
//       npm run verify
//       SKIP_POSE=1 npm run verify   // 只改了解算或演示页时，跳过最慢的姿态页
//       VERIFY_STRICT=1 npm run verify   // CI / 交付前：任何跳过都算没过
//
// SKIP_POSE=1 仍然退 0——它是 AGENTS.md 里写明的日常用法，跳过并不代表代码坏了。
// 但汇总会写成「三项通过，姿态页验证跳过（SKIP_POSE=1）」，不会再说「四项全过」；
// 想让「跳过」在流水线上阻断，就叠上 VERIFY_STRICT=1。
//
// 注意：端到端与姿态页都要启动 Chrome，必须在不限制命名管道的环境里跑
// （DSH 里是 sandbox_permissions: "danger-full-access"）；沙箱受限时它会失败，
// 但那一步的失败是「环境不允许」而不是「代码坏了」，输出里会原样转述浏览器的报错。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { freePort } from './cdp.mjs';
import { judgeVerifyAll } from './gate.mjs';

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

const skipPose = process.env.SKIP_POSE === '1';
// 严格模式：CI 和交付前跑。任何「跳过」都算没过，日常 SKIP_POSE 那种显式选择
// 不在这个开关里，所以两个开关可以同时用：跳过照旧不阻塞本地开发，交付时另加一道。
const strict = process.env.VERIFY_STRICT === '1';

console.log('=== 1/4 单元测试 ===');
// 走 tools/test.mjs，不把 --test-isolation=none 写死在这：那个开关在 Node 22.8
// 与 23.6 各改过一次名，写死会让同一台机器上的 verify 和 npm test 在小版本上
// 得出不同结论——门禁跟交付用的命令不一致，门禁就没有意义了。
await run('单元测试', ['tools/test.mjs']);

console.log('\n=== 2/4 演示页静态检查 ===');
await run('演示页静态检查', ['tools/check-demo.mjs']);

console.log('\n=== 3/4 浏览器端到端 ===');
let serve = null;
try {
  serve = await startServer();
  console.log(`临时静态服务：${serve.url}`);
  await run('浏览器端到端', ['tools/verify-demo.mjs'], { DEMO_URL: serve.url });

  if (skipPose) {
    console.log('\n=== 4/4 姿态页验证（SKIP_POSE=1，跳过）===');
    // 记 skipped 而不是 code 0 的「通过」：跳过就该按跳过记，汇总才不会把它
    // 算进通过数、更不会打印「四项全过」。退出码仍由 judgeVerifyAll 决定。
    results.push({ name: '姿态页验证', code: 0, ms: 0, note: 'SKIP_POSE=1', skipped: true });
  } else {
    console.log('\n=== 4/4 姿态页验证 ===');
    // 它要下 20 MB 模型、跑 wasm，比前面几项都慢；但这一页是独立入口，
    // 不进这里就等于没人看着。
    await run('姿态页验证', ['tools/verify-pose.mjs'], { POSE_BASE: serve.url });
  }
} catch (err) {
  console.error(err.message);
  results.push({ name: '浏览器端到端', code: 1, ms: 0, note: err.message });
  // 临时服务没起来，姿态页也没跑成；补一条失败，别让汇总比实际少算一项。
  if (!skipPose) {
    results.push({ name: '姿态页验证', code: 1, ms: 0, note: '临时服务没起来，未执行' });
  }
} finally {
  serve?.stop();
}

// 手起过 4173 的话，临时服务是另开的一个端口，两边互不影响。
console.log('\n=== 汇总 ===');
for (const r of results) {
  const status = r.skipped ? '跳过' : r.code === 0 ? '通过' : `失败（退出码 ${r.code}）`;
  console.log(`${status.padEnd(16)} ${r.name}  ${(r.ms / 1000).toFixed(1)}s${r.note ? `  ${r.note}` : ''}`);
}
// 判定全交给纯函数（tools/gate.mjs）：单测直接喂结果数组就能覆盖「跳过」「严格
// 模式」这些分支，不必真的起 Chrome 跑一遍才敢改这里的一行文案。
const gate = judgeVerifyAll({ results, strict });
console.log('');
for (const line of gate.lines) (gate.exitCode === 0 ? console.log : console.error)(line);
if (gate.exitCode !== 0) process.exit(gate.exitCode);