// 求解器剪枝（src/solver.js 的 rankGeoCandidates + SOLVE_PRUNE_K）：
// 先把几何候选按解析量排序，只对前 K 名跑「杆法 × 力度」细扫，其余整块跳过。
// 这里钉住三件事：剪枝不许改变选球、回退（第 K+1 名）真的会被用上、
// 排序不依赖候选枚举顺序（否则打乱球的数组就能换一个结果）。
//
// 断言的契约在「杆法/力度档位收紧」之后变了一次（2026-11）：
//   旧契约 —— 剪枝后的 top-1 必须与 exhaustive **完全相同**，评分也逐位相同。
//   新契约 —— 默认路径用收紧网格（SOLVE_TUNE_GRID）、exhaustive 用完整旧网格
//   （SOLVE_TUNE_GRID_LEGACY），两套网格给同一几何候选算出的力度/杆法本来就不同，
//   所以「逐位相同」不再是正确断言；改为：默认 top-1 必须落在穷举的 **top-3** 内
//   （48 局面验收线就是 top-3 100%），且默认 top-1 必须等于冻结基准里的 selected。
//   1~2 球的简单必进球局面仍要求与 exhaustive **同一杆**——那种局面上不存在
//   「两个候选势均力敌」，收紧网格不该改变结论。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { SOLVE_PRUNE_K, SOLVE_PRUNE_FALLBACK } from '../src/constants.js';
import { solveShot } from '../src/solver.js';

// 组合球 / 翻袋按挂钟预算截断，只有显式传 budgetMs 才生效；断言「一定算得出」的用例都要关掉。
const NO_BUDGET = Object.freeze({ budgetMs: Infinity });

// [球号, x, y]，球号 0 = 母球。全部是冻结基准 %TEMP%\prune-baseline\truth.json 里的局面
// （48 个局面、155 个候选），selected 是**改造前**穷举搜索选中的那一杆，用来防回归。
const FIXTURES = [
  // 注意 d01 是平局局面：c-br 与 c-tr 都是 70.7，最终排序的 tie-break 落到枚举顺序上
  // （这是改造前就有的行为，与剪枝无关，剪枝时 geos.length=2 根本不排序）
  { id: 'd01-straight', balls: [[0, 0.635, 0.635], [1, 1.905, 0.635]], selected: '1|c-br' },
  { id: 'd02-angle-a', balls: [[0, 0.4, 0.4], [1, 1.4, 0.9]], selected: '1|c-tr' },
  { id: 'd03-angle-b', balls: [[0, 2.1, 0.3], [1, 1.1, 0.85]], selected: '1|c-tl' },
  // 3 球 5 候选：剪枝真正开始起作用的最简局面
  { id: 'd05-three', balls: [[0, 0.45, 0.9], [1, 1.35, 0.55], [2, 2.0, 1.05]], selected: '1|c-tr' },
  { id: 'd06-three-b', balls: [[0, 0.6, 0.62], [3, 1.7, 0.95], [5, 2.0, 0.4]], selected: '3|c-tr' },
  { id: 'd12-four', balls: [[0, 0.3, 0.3], [1, 1.2, 0.9], [2, 1.9, 1.15], [3, 2.3, 0.4]], selected: '1|m-t' },
  // 5 球 6 候选 / 5 球 7 候选：剪枝收益最大的两类
  { id: 'g5-0', balls: [[0, 1.5903, 1.1656], [1, 1.0927, 0.4764], [2, 1.2959, 0.7031], [3, 1.6082, 0.6738], [4, 0.5832, 0.5105]], selected: '2|m-b' },
  { id: 'g5-3', balls: [[0, 0.1714, 0.7203], [1, 0.0753, 0.3728], [2, 1.6911, 0.1799], [3, 2.1318, 0.9108], [4, 1.3437, 0.503]], selected: '1|c-bl' },
  // 回退专用的 4 球局面（坐标见下面「回退」用例的注释）
  { id: 'fb-266', balls: [[0, 1.3050701316452027, 1.2189911949157715], [1, 0.8823370975875855, 0.9772853282165528], [2, 2.090233834037781, 1.172000574798584], [3, 2.120328973808289, 0.8956227159118653]], selected: '2|c-tr' },
];

const table = createTable('pool9');

function makeBalls(layout, reverse = false) {
  const rows = reverse ? [...layout.balls].reverse() : layout.balls;
  return rows.map(([n, x, y]) => createBall(n === 0 ? 'cue' : `b${n}`, x, y, { number: n }));
}

const shotKey = (c) => `${c.targetNumber}|${c.pocketId}`;
const keysOf = (list) => list.map((c) => `${shotKey(c)}|${c.value}`).sort();
const run = (layout, opts = {}, reverse = false) =>
  solveShot(table, makeBalls(layout, reverse), { ...NO_BUDGET, cueId: 'cue', ...opts });

test('剪枝：简单局面（1~2 球必进球）与 exhaustive 选出同一杆', () => {
  // d06-three-b 不在这个名单里：那一局两个候选的评分只差 1.8 分（且收紧网格的
  // 3|c-tr 反而更高），新契约只要求 top-1 落在穷举 top-3 内——见下一个用例。
  const simple = FIXTURES.filter(
    (f) => f.balls.length <= 2 || f.id === 'd05-three'
  );
  for (const layout of simple) {
    const pruned = run(layout);
    const full = run(layout, { exhaustive: true });
    assert.ok(pruned.length > 0, `${layout.id}：剪枝后不该一个候选都没有`);
    assert.equal(shotKey(pruned[0]), shotKey(full[0]), `${layout.id}：剪枝与穷举的 top-1 必须一致`);
    assert.equal(shotKey(pruned[0]), layout.selected, `${layout.id}：与冻结基准选中的那一杆必须一致`);
  }
});

test('剪枝：多候局面 top-1 落在穷举 top-3 内，且没有候选被判成打不了', () => {
  for (const layout of FIXTURES) {
    const pruned = run(layout);
    const full = run(layout, { exhaustive: true });
    assert.ok(pruned.length > 0, `${layout.id}：剪枝后不该一个候选都没有`);
    const top3 = full.slice(0, 3).map(shotKey);
    assert.ok(
      top3.includes(shotKey(pruned[0])),
      `${layout.id}：默认 top-1 必须落在穷举 top-3 内，实际 ${shotKey(pruned[0])} / 穷举 ${top3.join(',')}`
    );
    assert.equal(shotKey(pruned[0]), layout.selected, `${layout.id}：与冻结基准一致`);
    for (const c of pruned) assert.equal(c.verified, true, `${layout.id}：返回的候选都必须过仿真验证`);
  }
});

test('剪枝：exhaustive 开关与 SOLVE_EXHAUSTIVE=1 等价，默认路径不是穷举', () => {
  const layout = FIXTURES.find((f) => f.id === 'g5-3');
  const pruned = run(layout);
  const full = run(layout, { exhaustive: true });
  assert.ok(pruned.length < full.length, '剪枝后返回的候选数应少于穷举（否则开关没生效）');
  const envRun = (() => {
    process.env.SOLVE_EXHAUSTIVE = '1';
    try {
      return run(layout);
    } finally {
      delete process.env.SOLVE_EXHAUSTIVE;
    }
  })();
  assert.deepEqual(keysOf(envRun), keysOf(full), 'SOLVE_EXHAUSTIVE=1 应与 opts.exhaustive 完全等价');
});

test('回退：top-K 有候选全部力度都打不进时，会去扫第 K+1 名', () => {
  // 局面来源：%TEMP%\prune-baseline\sweep.mjs 扫了 400 个随机局面，第 266 个是唯一
  // 「前 K 名里有 1 个候选细扫后零解、真正的 top-1 恰好排在第 K+1 名」的样本。
  // 实测：把 SOLVE_PRUNE_FALLBACK 临时改成 0，该局面返回 3|c-br（value 38），
  // 而穷举的真解是 2|c-tr（value 23.3）——即少了这次回退就会漏掉真实最优解。
  assert.ok(SOLVE_PRUNE_FALLBACK >= 1, '回退名额至少要有 1 个，否则上面这个局面会漏解');
  const layout = FIXTURES.find((f) => f.id === 'fb-266');
  const pruned = run(layout);
  const full = run(layout, { exhaustive: true });
  assert.equal(shotKey(pruned[0]), '2|c-tr', '回退后应选中排在第 4 名的真解');
  assert.equal(shotKey(pruned[0]), shotKey(full[0]), '回退后的结果必须与穷举一致');
});

test('排序稳定：打乱球的数组顺序不改变选球（不依赖枚举顺序的偶然性）', () => {
  assert.ok(SOLVE_PRUNE_K >= 1);
  for (const layout of FIXTURES) {
    const a = run(layout);
    const b = run(layout, {}, true); // 倒序：候选枚举顺序整体反转
    assert.deepEqual(keysOf(b), keysOf(a), `${layout.id}：候选集合与评分不应随数组顺序变化`);
    // 平局（前两名的 value 相同）时谁排第一本来就由最终排序的稳定序决定，不归剪枝管；
    // 非平局局面必须逐位相同。
    if (!a[1] || a[1].value !== a[0].value) {
      assert.equal(shotKey(b[0]), shotKey(a[0]), `${layout.id}：top-1 不应随数组顺序变化`);
    }
  }
});

test('排序稳定：同一输入连跑两次逐位相同', () => {
  const layout = FIXTURES.find((f) => f.id === 'g5-0');
  const once = run(layout);
  const twice = run(layout);
  assert.deepEqual(keysOf(twice), keysOf(once));
  assert.equal(twice.length, once.length);
});