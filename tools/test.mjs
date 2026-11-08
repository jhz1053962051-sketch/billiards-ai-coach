// 跑测试，顺便抹平 Node 版本差异。
//
// 为什么需要这个：所有测试都在一个进程里跑（`--test-isolation=none`），因为
// DSH 这类受限沙箱不允许 spawn 子进程，默认的进程隔离会让每个测试文件都
// `spawn EPERM` 直接失败。但这个 flag 改过好几次名：
//
//   Node < 22.8   没有这个 flag，只能跑默认的进程隔离
//   Node 22.8+    `--experimental-test-isolation=none`
//   Node 23.6+    `--test-isolation=none`（去掉 experimental 前缀）
//
// 写死在 package.json 里就只能在某一个版本区间用。这里按运行时的实际版本挑，
// 让 `npm test` 在 Node 22.8 到 26 上都能跑。
//
// 用法：node tools/test.mjs [额外的 node --test 参数...]

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

const [major, minor] = process.versions.node.split('.').map(Number);

/** 选出当前版本支持的进程隔离开关；不支持就返回 null。 */
function isolationFlag() {
  if (major > 23 || (major === 23 && minor >= 6)) return '--test-isolation=none';
  if (major === 22 && minor >= 8) return '--experimental-test-isolation=none';
  return null;
}

// 自己列文件，不把 glob 交给 shell 或 test runner：Windows 下没 shell 展开，
// 而 test runner 的 glob 支持是 Node 22.6 才加的，自己列一遍最省事。
const files = fs
  .readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', f));

if (files.length === 0) {
  console.error(`test/ 下没有 .test.js 文件（${TEST_DIR}）`);
  process.exit(1);
}

const flag = isolationFlag();
const args = ['--test'];

if (flag) {
  args.push(flag);
} else {
  // 说清楚为什么没加：老版本上加了会直接报「未知参数」，整条命令失败。
  console.warn(
    `Node ${process.versions.node} 没有进程隔离开关（需要 22.8+），` +
      `按默认的进程隔离跑。受限沙箱里可能会 spawn EPERM。`
  );
}

args.push(...files, ...process.argv.slice(2));

const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true, cwd: ROOT });
child.on('error', (e) => {
  console.error(`测试进程启动失败：${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
