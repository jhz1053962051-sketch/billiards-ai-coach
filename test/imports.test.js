// 加载顺序的守护测试。
//
// 循环依赖在本文件写下时确实存在过：`src/solver.js` 与 `src/safety.js` 互相 import——
// solver 用 safety 的 solveSafety 找防守方案，safety 用 solver 的 positionTolerance
// 给局面打分。ES module 允许这样，但前提是「被循环引用的那个绑定只在调用时读」；
// 谁在模块顶层真的用了它，就会撞上 TDZ（Cannot access 'X' before initialization），
// 而且是加载即崩。那个环现在已断开：positionTolerance 搬到 `src/tolerance.js`，
// safety 只单向依赖它；「两边不再互相 import」由 `test/sim-core.test.js` 直接断言。
//
// 所以下面两条用例钉的不是循环依赖，而是**加载顺序**这条隐式契约：两个模块仍共享
// 间接依赖，平时所有测试都在同一个进程里按固定顺序加载，恰好不会暴露加载期的问题；
// 换个入口（比如别人直接 import safety.js）仍可能崩。于是这里开两个子进程，分别按
// 两种顺序加载，并且真的调用一次，把这个变量固定住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// 用求解器测试里那杆「必进球」当探针：母球与 1 号球同在 y=0.635 的中线上，
// 到下中袋是一条直线。这个布局一定有候选，所以 count 为 0 只能说明求解链路断了。
const PRELUDE = `
const { createTable } = await import('./src/table.js');
const { createBall, createWorld } = await import('./src/physics.js');
const table = createTable('pool9');
const cue = createBall('cue', 0.635, 0.635, { number: 0 });
const obj = createBall('b1', 1.905, 0.635, { number: 1 });
createWorld(table, [cue, obj]);
`;

const MEASURE = `
const safetyOut = safety.solveSafety(table, [cue, obj], { cueId: 'cue' });
const candidates = solver.solveShot(table, [cue, obj], { cueId: 'cue' });
console.log(JSON.stringify({
  safetyKind: safetyOut === null ? 'null' : typeof safetyOut,
  solverIsArray: Array.isArray(candidates),
  count: Array.isArray(candidates) ? candidates.length : -1,
}));
`;

function runOrder(first) {
  const other = first === 'safety' ? 'solver' : 'safety';
  const code = `${PRELUDE}
const a = await import('./src/${first}.js');
const b = await import('./src/${other}.js');
const safety = ${first === 'safety' ? 'a' : 'b'};
const solver = ${first === 'safety' ? 'b' : 'a'};
${MEASURE}`;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    cwd: root,
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

function check(r, order) {
  assert.ok(['null', 'object'].includes(r.safetyKind), `${order}：solveSafety 应返回方案或 null`);
  assert.equal(r.solverIsArray, true, `${order}：solveShot 应返回候选数组`);
  assert.ok(r.count > 0, `${order}：必进球应至少求出一个候选，实际 ${r.count}`);
}

test('循环 import：先加载 safety 再加载 solver，两边都真的能用', () => {
  check(runOrder('safety'), '先 safety');
});

test('循环 import：先加载 solver 再加载 safety，结果一致', () => {
  check(runOrder('solver'), '先 solver');
});