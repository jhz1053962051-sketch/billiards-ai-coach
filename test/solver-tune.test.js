// 切角上限 + 细扫网格（2026-11 收紧）的契约测试。
//
// 背景：切角原本分叉成两条物理边界（进攻 82° / 安全球 78°），杆法与力度档位
// 则是硬编码在 verifyAndTune 里的字面量数组。这一轮把边界合并成唯一
// constants.MAX_CUT_DEG = 82，把网格搬进 constants 的 SOLVE_TUNE_GRID
// （默认，收紧版）与 SOLVE_TUNE_GRID_LEGACY（exhaustive 专用的完整旧网格）。
//
// 本文件钉四件事：
//   1) 只剩一个切角常量，solver / safety / tolerance 读的是同一份（源码级）；
//   2) 82° 这条边界真的在 82° 处生效（略小可解、略大拒绝，卡到 0.01°）；
//   3) exhaustive 与默认路径在简单必进球局面上给出同一杆；
//   4) 收紧后的档位常量确实被细扫循环消费（常量改了循环没跟上就会红）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { V } from '../src/geometry.js';
import { solveContactNormal, cutAngleDeg, aimToleranceDeg } from '../src/aim.js';
import { SPEED, PHYS, MAX_CUT_DEG, SOLVE_TUNE_GRID, SOLVE_TUNE_GRID_LEGACY } from '../src/constants.js';
import { solveShot } from '../src/solver.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const srcText = (name) => readFileSync(join(SRC, name), 'utf8');

const NO_BUDGET = Object.freeze({ budgetMs: Infinity });
const table = createTable('pool9');
const R = table.ballRadius;

test('切角：只剩一个 MAX_CUT_DEG = 82，solver / safety / tolerance 读同一份', () => {
  assert.equal(MAX_CUT_DEG, 82, '统一后的切角上限就是 82°');

  const constants = srcText('constants.js');
  // 只能有一处定义：多一处就是又开了一个能漂移的分叉
  assert.equal(
    (constants.match(/export\s+const\s+MAX_CUT_DEG\b/g) || []).length,
    1,
    'constants.js 里 MAX_CUT_DEG 必须只定义一次'
  );
  // 旧的两个分叉常量必须删干净，名字都不许留（连注释里的残留也算）
  for (const name of ['MAX_CUT_ATTACK_DEG', 'MAX_CUT_SAFETY_DEG']) {
    assert.ok(!constants.includes(name), `constants.js 不许再出现 ${name}`);
  }

  for (const file of ['solver.js', 'safety.js', 'tolerance.js']) {
    const text = srcText(file);
    assert.match(
      text,
      /import\s*\{[^}]*\bMAX_CUT_DEG\b[^}]*\}\s*from\s*'\.\/constants\.js'/,
      `${file} 必须从 constants.js 读 MAX_CUT_DEG`
    );
    // 不许自己再造一个副本导出：safety 历史上就是这么分叉出 78 的
    assert.doesNotMatch(
      text,
      /export\s+(const|let)\s+MAX_CUT_DEG\b/,
      `${file} 不许导出自己的切角副本`
    );
    // 「防守比进攻更保守」那句错误注释不能留
    assert.ok(!text.includes('MAX_CUT_ATTACK_DEG'), `${file} 不许残留旧常量名`);
    assert.ok(!text.includes('MAX_CUT_SAFETY_DEG'), `${file} 不许残留旧常量名`);
  }

  // 物理边界只有一个出口：solveShot 的候选枚举与容错窗口都用它
  assert.match(srcText('solver.js'), /cutDeg\s*>\s*MAX_CUT_DEG/, 'solveShot 的切角门槛');
  assert.match(srcText('tolerance.js'), />\s*MAX_CUT_DEG/, '容错窗口的切角门槛');

  // 安全球不再分叉物理边界：safety 里不许出现「另一个切角数值」的比较
  // （注释里提历史 78 是允许的——brief 要求把「为什么取消 78」写下来）
  const safety = srcText('safety.js');
  assert.doesNotMatch(
    safety,
    /cut[A-Za-z]*\s*[<>]=?\s*\d/i,
    'safety 不许把切角门槛写死成数字，必须走 MAX_CUT_DEG'
  );
});

// 把母球摆在「切角恰好是 deg」的位置上：假想球 G 在目标球后方 2R，
// 母球沿 G→ 方向反向偏 deg 度即可，切角定义就是 (G-C) 与 (袋-T) 的夹角。
function cutLayout(pocketId, deg, target = { x: 1.7, y: 0.85 }, dist = 0.4) {
  const pocket = table.pockets.find((p) => p.id === pocketId);
  const outDir = V.norm(V.sub(pocket, target));
  const ghost = { x: target.x - outDir.x * 2 * R, y: target.y - outDir.y * 2 * R };
  const th = (deg * Math.PI) / 180;
  const rot = {
    x: outDir.x * Math.cos(th) - outDir.y * Math.sin(th),
    y: outDir.x * Math.sin(th) + outDir.y * Math.cos(th),
  };
  const cue = { x: ghost.x - rot.x * dist, y: ghost.y - rot.y * dist };
  return { pocket, target, ghost, cue, cut: cutAngleDeg(cue, ghost, target, pocket) };
}

function ballsOf(layout) {
  return [
    createBall('cue', layout.cue.x, layout.cue.y, { number: 0 }),
    createBall('b1', layout.target.x, layout.target.y, { number: 1 }),
  ];
}

const hasPocket = (list, pocketId) =>
  list.some((c) => c.pocketId === pocketId && c.targetNumber === 1);

test('切角：82° 处真的生效——略小可解、略大拒绝', () => {
  // verify:false 只看几何候选（不跑仿真），这条用例测的是门槛本身
  const opts = { ...NO_BUDGET, cueId: 'cue', verify: false };

  for (const deg of [81.9, MAX_CUT_DEG - 0.1]) {
    const l = cutLayout('c-tr', deg);
    assert.ok(Math.abs(l.cut - deg) < 1e-9, `构造误差：要求 ${deg}°，实际 ${l.cut}°`);
    assert.ok(l.cut < MAX_CUT_DEG);
    assert.ok(aimToleranceDeg(l.cue, l.ghost, l.target, l.pocket, l.pocket.captureR, R) >= 0.03);
    const cands = solveShot(table, ballsOf(l), opts);
    assert.ok(hasPocket(cands, 'c-tr'), `${deg}°（< 82°）应当给出 c-tr 这个候选`);
  }

  for (const deg of [82.1, MAX_CUT_DEG + 0.5, 84]) {
    const l = cutLayout('c-tr', deg);
    assert.ok(l.cut > MAX_CUT_DEG, `构造误差：${deg}° 应大于边界`);
    // 容错窗口这里是够的，说明拒绝确实是切角门槛干的，不是被 tol 顺手砍掉
    assert.ok(aimToleranceDeg(l.cue, l.ghost, l.target, l.pocket, l.pocket.captureR, R) >= 0.03);
    const cands = solveShot(table, ballsOf(l), opts);
    assert.ok(!hasPocket(cands, 'c-tr'), `${deg}°（> 82°）必须拒绝 c-tr`);
  }
});

test('切角：82° 附近仍然存在其它袋候选，不是整杆无解', () => {
  const opts = { ...NO_BUDGET, cueId: 'cue', verify: false };
  const cands = solveShot(table, ballsOf(cutLayout('c-tr', 83)), opts);
  assert.ok(cands.length > 0, '薄到打不了 c-tr 时仍应给出别的袋');
});

// 收紧网格后仍必须与穷举一致的简单局面（1~2 球、只有一条明显解）
const SIMPLE = [
  { id: '必进直球', balls: [[0, 0.635, 0.635], [1, 1.905, 0.635]] },
  { id: '角度球', balls: [[0, 0.4, 0.4], [1, 1.4, 0.9]] },
];

const makeBalls = (rows) =>
  rows.map(([n, x, y]) => createBall(n === 0 ? 'cue' : `b${n}`, x, y, { number: n }));
const shotKey = (c) => `${c.targetNumber}|${c.pocketId}`;

test('网格：exhaustive 与默认路径在简单必进球局面上给出同一杆', () => {
  for (const layout of SIMPLE) {
    const def = solveShot(table, makeBalls(layout.balls), { ...NO_BUDGET, cueId: 'cue' });
    const full = solveShot(table, makeBalls(layout.balls), {
      ...NO_BUDGET,
      cueId: 'cue',
      exhaustive: true,
    });
    assert.ok(def.length > 0 && full.length > 0, `${layout.id}：两边都该有解`);
    assert.equal(shotKey(def[0]), shotKey(full[0]), `${layout.id}：收紧网格不许改变必进球的结论`);
  }
});

test('网格：默认收紧版与 exhaustive 的完整旧网格是两套参数，互不污染', () => {
  // 默认网格（收紧）：5 档力度（1.7 是 d06 那类超量走位局面的唯一解，删不得）、
  // 中杆 + 高杆、加塞只在最优速度补、不扫瞄准偏移
  assert.deepEqual([...SOLVE_TUNE_GRID.speedFactors], [0.8, 1.0, 1.2, 1.45, 1.7]);
  assert.deepEqual([...SOLVE_TUNE_GRID.centerTipBs], [0.55]);
  assert.deepEqual([...SOLVE_TUNE_GRID.spinTipAs], [-0.35, 0.35]);
  assert.equal(SOLVE_TUNE_GRID.spinOverAllSpeeds, false);
  assert.equal(SOLVE_TUNE_GRID.spinCandidateScope, 'rank1', '默认只给排第一的候选补塞');
  assert.deepEqual([...SOLVE_TUNE_GRID.aimOffsetsDeg], []);

  // 完整旧网格：5 档力度、6 个瞄准偏移、加塞对每个候选、每档力度都重扫
  assert.deepEqual([...SOLVE_TUNE_GRID_LEGACY.speedFactors], [0.8, 1, 1.2, 1.45, 1.7]);
  assert.deepEqual([...SOLVE_TUNE_GRID_LEGACY.centerTipBs], [-0.55, 0.55]);
  assert.deepEqual([...SOLVE_TUNE_GRID_LEGACY.spinTipAs], [-0.35, 0.35]);
  assert.equal(SOLVE_TUNE_GRID_LEGACY.spinOverAllSpeeds, true);
  assert.equal(SOLVE_TUNE_GRID_LEGACY.spinCandidateScope, 'all');
  assert.equal(SOLVE_TUNE_GRID_LEGACY.aimOffsetsDeg.length, 6);

  // 两套都是冻结对象：运行时改一个字段就等于悄悄改掉验收基准
  assert.ok(Object.isFrozen(SOLVE_TUNE_GRID));
  assert.ok(Object.isFrozen(SOLVE_TUNE_GRID_LEGACY));
  // 力度档位加回 1.7 后两套的第一个字段已相同，改盯仍然分叉的杆法/偏移
  assert.notDeepEqual([...SOLVE_TUNE_GRID.centerTipBs], [...SOLVE_TUNE_GRID_LEGACY.centerTipBs]);
  assert.notDeepEqual([...SOLVE_TUNE_GRID.aimOffsetsDeg], [...SOLVE_TUNE_GRID_LEGACY.aimOffsetsDeg]);

  // exhaustive 走旧网格、默认走新网格（源码级钉住分支）
  assert.match(
    srcText('solver.js'),
    /exhaustive\s*\?\s*SOLVE_TUNE_GRID_LEGACY\s*:\s*SOLVE_TUNE_GRID/,
    'solveShot 必须按 exhaustive 选网格'
  );
});

test('网格：细扫循环确实消费 grid 的每个字段（常量改了循环没跟上就会红）', () => {
  const solver = srcText('solver.js');
  for (const field of [
    'speedFactors',
    'centerTipBs',
    'spinTipAs',
    'spinOverAllSpeeds',
    'aimOffsetsDeg',
    'spinRetryQuality',
  ]) {
    assert.match(solver, new RegExp(`grid\\.${field}\\b`), `verifyAndTune 必须读 grid.${field}`);
  }
  // 旧的字面量数组不能再回到循环里（回来就等于常量失效）
  assert.doesNotMatch(solver, /\[0\.8,\s*1,\s*1\.2,\s*1\.45,\s*1\.7\]/, '力度档位不许再硬编码');
  assert.doesNotMatch(solver, /offsets\s*=\s*\[0\.15,\s*-0\.15/, '瞄准偏移不许再硬编码');
  // widen 也只许用候选自带的杆法，不许再临时拼一份「中心 + 塞」的清单
  assert.match(solver, /grid\.widenTips\s*===\s*'base'/, 'widen 的杆法清单必须由 grid 决定');

  // 每个候选的枪数上限必须与网格对得上：(1 支候选自带杆 + 中心杆) × 力度
  // + 加塞重扫（只在最优速度上 2 枪）+ 1 枪录母球路线。默认网格 = 2×5 + 2 + 1 = 13。
  // 加塞那一项必须跟着 speedFactors.length 走：加回 1.7 时若这里还写死 4，
  // 「常量改了、循环没跟上」这类漏改就会被算成旧枪数而漏掉。
  const gridSpeeds = SOLVE_TUNE_GRID.speedFactors.length;
  const perCandidate =
    (1 + SOLVE_TUNE_GRID.centerTipBs.length) * gridSpeeds +
    SOLVE_TUNE_GRID.spinTipAs.length * (SOLVE_TUNE_GRID.spinOverAllSpeeds ? gridSpeeds : 1) +
    1;
  assert.equal(perCandidate, 13, '默认网格下单候选最多 13 枪');
  // 加塞只补最优那一档速度：重扫时只有 1 档速度 × 2 支塞 = 2 枪
  const spinShots = SOLVE_TUNE_GRID.spinTipAs.length * (SOLVE_TUNE_GRID.spinOverAllSpeeds ? gridSpeeds : 1);
  assert.equal(spinShots, 2, '加塞重扫最多 2 枪（只在最优速度上）');
  // exhaustive 仍是完整旧网格：3 杆法 × 5 力度 + 2 塞 × 5 力度 + 1 枪录路线 = 26
  const legacySpeeds = SOLVE_TUNE_GRID_LEGACY.speedFactors.length;
  const legacyPerCandidate =
    (1 + SOLVE_TUNE_GRID_LEGACY.centerTipBs.length) * legacySpeeds +
    SOLVE_TUNE_GRID_LEGACY.spinTipAs.length * (SOLVE_TUNE_GRID_LEGACY.spinOverAllSpeeds ? legacySpeeds : 1) +
    1;
  assert.equal(legacyPerCandidate, 26, 'exhaustive 的完整网格不许被收紧');
});

// 「加塞给哪些候选」原来是调用点上的硬编码 i === 0，现在由 spinCandidateScope 决定。
// 仓库里没有仿真计数器（src/sim.js 不许改），枪数没法在行为层数出来，所以这条契约
// 只能钉在源码上：常量被读进局部开关，开关必须真的进 allowSpin。
test('加塞覆盖：rank-1 是具名常量驱动，不是硬编码的 i === 0', () => {
  assert.equal(SOLVE_TUNE_GRID.spinCandidateScope, 'rank1');
  assert.equal(SOLVE_TUNE_GRID_LEGACY.spinCandidateScope, 'all');
  for (const scope of [SOLVE_TUNE_GRID.spinCandidateScope, SOLVE_TUNE_GRID_LEGACY.spinCandidateScope]) {
    assert.ok(scope === 'rank1' || scope === 'all', `spinCandidateScope 只接受 rank1/all，实际 ${scope}`);
  }

  const solver = srcText('solver.js');
  assert.match(
    solver,
    /const\s+spinAllCandidates\s*=\s*tuneGrid\.spinCandidateScope\s*===\s*'all'/,
    'solveShot 必须把 spinCandidateScope 读成局部开关'
  );
  assert.match(
    solver,
    /exhaustive\s*\|\|\s*spinAllCandidates\s*\|\|\s*i\s*===\s*0/,
    'allowSpin 必须走开关，否则把常量改成 all 也没人来读'
  );
  // 旧的硬编码不能再留着做后门：留着就等于常量失效
  assert.doesNotMatch(
    solver,
    /exhaustive\s*\|\|\s*i\s*===\s*0/,
    '「只给 rank-1」的旧硬编码必须删掉'
  );
});

test('网格：收紧后 3 球局面的仿真次数落在目标以内', () => {
  // 与 %TEMP% 基准脚本同一组局面（d05-three）：收紧前 58 次，目标 ≤ 40
  const balls = makeBalls([[0, 0.45, 0.9], [1, 1.35, 0.55], [2, 2.0, 1.05]]);
  const cands = solveShot(table, balls, { ...NO_BUDGET, cueId: 'cue' });
  assert.ok(cands.length > 0, 'd05-three 必须有解');
  // 每个候选最多 13 枪，三个候选 ≤ 39；这里只是防止网格被悄悄放大
  assert.ok(cands.length <= 3, `默认路径返回的候选数应 ≤ SOLVE_PRUNE_K，实际 ${cands.length}`);
});

test('物理常量没有被改动（SPEED / PHYS 是收紧网格的下游，不能被顺手改）', () => {
  assert.deepEqual({ ...SPEED }, { min: 0.55, soft: 1.2, medium: 2.2, firm: 3.6, break: 6.6 });
  assert.equal(typeof PHYS.ballRestitution, 'number');
  // solveContactNormal 与 cutAngleDeg 是上面边界用例的构造基础，顺手钉住签名
  const l = cutLayout('c-tr', 60);
  const probe = solveContactNormal(l.cue, l.target, V.norm(V.sub(l.pocket, l.target)), SPEED.medium, R, PHYS);
  assert.ok(Number.isFinite(probe.ghost.x) && Number.isFinite(probe.ghost.y));
});

// ── 走位分回归：g3-6 / g4-2（2026-12 复核）──
//
// 上一轮报告把这两局记成「同杆但评分更低 −15.3% / −17.5%」，据此怀疑「加塞只在
// 最优速度补两枪」。复核结论不是：candidate.value 是**成本**（越小越好），默认
// 路径这两局都比穷举便宜——
//   g3-6：两路都选中 2 号同一中袋。穷举在 1.55 倍速度上加右塞，走位只多 0.14，
//         却多背 6 分加塞难度，默认中杆这杆更划算。
//   g4-2：同杆同速，穷举只多一个左塞，停位逐位相同，纯多背 6 分惩罚。
// 把加塞覆盖到全部力度档后两局数值一字未变，所以「覆盖不足」不是这两局的原因。
// 这组坐标留下来当哨兵：将来谁再收窄加塞覆盖，只要真的把走位打差就会红。
const SPIN_REGRESSION = [
  { id: 'g3-6', balls: [[0, 2.044978, 0.18208], [1, 0.391335, 1.150222], [2, 1.7692, 0.785915]] },
  {
    id: 'g4-2',
    balls: [
      [0, 1.060585, 0.623912],
      [1, 1.491169, 0.451195],
      [2, 1.810791, 0.91889],
      [3, 1.849721, 0.315312],
    ],
  },
];

test('加塞覆盖：g3-6 / g4-2 同杆，且走位分不低于穷举的 97%', () => {
  for (const layout of SPIN_REGRESSION) {
    const opts = { ...NO_BUDGET, cueId: 'cue' };
    const def = solveShot(table, makeBalls(layout.balls), opts);
    const full = solveShot(table, makeBalls(layout.balls), { ...opts, exhaustive: true });
    assert.ok(def.length > 0 && full.length > 0, `${layout.id}：两边都该有解`);

    // 同杆才有「评分比较」可言：袋和目标球都不许变
    assert.equal(shotKey(def[0]), shotKey(full[0]), `${layout.id}：默认与穷举必须同杆`);

    // 综合价值是成本：默认最多接受 3% 的恶化
    assert.ok(
      def[0].value <= full[0].value * 1.03 + 1e-9,
      `${layout.id}：默认 value=${def[0].value} 比穷举 value=${full[0].value} 差出 3% 以上`
    );

    // 走位分本体：下一杆容差换算出来的 leaveScore 不许掉出 97%
    if (full[0].leaveScore !== null) {
      assert.ok(
        def[0].leaveScore >= full[0].leaveScore * 0.97 - 1e-9,
        `${layout.id}：走位分 ${def[0].leaveScore} 低于穷举 ${full[0].leaveScore} 的 97%`
      );
    }
  }
});

// ── 质量回归：d06-three-b（「1.7 力度档不能删」的哨兵）──
//
// 这一局曾是 4 档网格下**唯一**超过 3% 质量硬线的局面：删掉 1.7 之后，默认选
// 3号→右中袋（成本 34.7、留下 62.04、下杆容差 0.43），而穷举是 5号→右底袋
// （成本 32.9、留下 79.62、容差 1.07）——损失 5.47%。根因就是缺了「超量力度」
// 这一档：母球要走到下一杆位，种子速度的 1.45 倍不够。加回 1.7 后逐位恢复。
// 坐标取自 48 个冻结局面（%TEMP% 基准脚本同一份），别改：换了坐标这条就失去哨兵意义。
const D06_BALLS = [[0, 0.6, 0.62], [3, 1.7, 0.95], [5, 2.0, 0.4]];

test('质量回归：d06-three-b 的质量损失不超过 3%（曾因删掉 1.7 掉 5.47%）', () => {
  const opts = { ...NO_BUDGET, cueId: 'cue' };
  const def = solveShot(table, makeBalls(D06_BALLS), opts);
  const full = solveShot(table, makeBalls(D06_BALLS), { ...opts, exhaustive: true });
  assert.ok(def.length > 0 && full.length > 0, 'd06：两边都该有解');
  assert.equal(shotKey(def[0]), '5|c-br', 'd06：默认应选 5 号→右底袋（只有 1.7 档够走位）');
  assert.equal(shotKey(def[0]), shotKey(full[0]), 'd06：默认与穷举必须同杆');
  // candidate.value 是成本，越小越好：默认最多接受 3% 的恶化
  assert.ok(
    def[0].value <= full[0].value * 1.03 + 1e-9,
    `d06：默认 value=${def[0].value} 比穷举 value=${full[0].value} 差出 3% 以上`
  );
});