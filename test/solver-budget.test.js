// 求解预算：一次求解最多跑多少次**整杆仿真**。
//
// 为什么需要这条测试
// ------------------
// 求解的速度余量是靠「几何预排序 + 只对前 SOLVE_PRUNE_K 名做细扫」拿到的，代价是
// 每次求解大约 30 次整杆仿真（2 球局面 4~5 次）。这个数字是性能与质量的分界线：
// 谁要是无意把剪枝改回盲扫（`{exhaustive:true}` 那条完整旧网格），次数会跳到一百多次，
// 手机上就再也跑不动；反过来，谁要是「为了快」偷偷少跑几次，选球质量会掉。
// 所以这里用 src/sim.js 的计数器把上限钉死：既有用例保证选球不变，这条保证**代价**不变。
//
// 阈值取「实测基线 + 20%」而不是写死等号：剪枝策略内部的小调整（多回退一个候选之类）
// 允许发生，但不可能翻几倍；而盲扫的 142 次一定会撞线。
//
// 局面坐标与 test/solver-prune.test.js 的冻结基准同一批。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { solveShot } from '../src/solver.js';
import { simRunCount, resetSimRunCount } from '../src/sim.js';

const table = createTable('pool9');

// 组合球 / 翻袋按挂钟预算截断，只有显式传 budgetMs 才生效；这里要的是确定次数。
const NO_BUDGET = Object.freeze({ budgetMs: Infinity });

// baseline = 2026-11 性能改造后的实测整杆仿真次数（计数器口径，不含早退的无效杆）。
// cap = ceil(baseline * 1.2)。
const CASES = [
  { id: 'd01-straight', balls: [[0, 0.635, 0.635], [1, 1.905, 0.635]], baseline: 4, cap: 5 },
  { id: 'd05-three', balls: [[0, 0.45, 0.9], [1, 1.35, 0.55], [2, 2.0, 1.05]], baseline: 33, cap: 40 },
  { id: 'd06-three-b', balls: [[0, 0.6, 0.62], [3, 1.7, 0.95], [5, 2.0, 0.4]], baseline: 33, cap: 40 },
  { id: 'd12-four', balls: [[0, 0.3, 0.3], [1, 1.2, 0.9], [2, 1.9, 1.15], [3, 2.3, 0.4]], baseline: 33, cap: 40 },
  {
    id: 'g5-0',
    balls: [[0, 1.5903, 1.1656], [1, 1.0927, 0.4764], [2, 1.2959, 0.7031], [3, 1.6082, 0.6738], [4, 0.5832, 0.5105]],
    baseline: 33,
    cap: 40,
  },
];

const makeBalls = (rows) =>
  rows.map(([n, x, y]) => createBall(n === 0 ? 'cue' : `b${n}`, x, y, { number: n }));

test('求解预算：整杆仿真次数不超过上限（防止无意改回盲扫）', () => {
  for (const layout of CASES) {
    resetSimRunCount();
    const candidates = solveShot(table, makeBalls(layout.balls), { ...NO_BUDGET, cueId: 'cue' });
    const sims = simRunCount();

    assert.ok(candidates.length > 0, `${layout.id}：这笔局面应该有候选，实际 0 个`);
    assert.ok(
      sims <= layout.cap,
      `${layout.id}：整杆仿真 ${sims} 次，超过上限 ${layout.cap}（基线 ${layout.baseline}）。` +
        `盲扫是 142 次这条量级——如果剪枝被改回去了，先看 rankGeoCandidates。`
    );
    assert.ok(sims >= 1, `${layout.id}：一次整杆仿真都没跑，计数器或求解链路断了`);
  }
});

test('求解预算：exhaustive 仍是完整旧网格，次数明显高于默认路径', () => {
  // 这条不钉具体数值（完整网格随候选数增长），只钉方向：它必须还在、还必须更贵。
  const layout = CASES[1];
  resetSimRunCount();
  const pruned = solveShot(table, makeBalls(layout.balls), { ...NO_BUDGET, cueId: 'cue' });
  const prunedSims = simRunCount();

  resetSimRunCount();
  const full = solveShot(table, makeBalls(layout.balls), { ...NO_BUDGET, cueId: 'cue', exhaustive: true });
  const fullSims = simRunCount();

  assert.ok(full.length > 0, 'exhaustive 不该返回空');
  assert.ok(pruned.length > 0, '默认路径不该返回空');
  assert.ok(
    fullSims > prunedSims * 2,
    `exhaustive 应显著更贵：默认 ${prunedSims} 次、完整网格 ${fullSims} 次`
  );
});