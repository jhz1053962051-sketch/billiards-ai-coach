// 单一仿真入口（src/sim.js）的测试。
//
// 这里守住四件事，每一件都是「以前散落三份/四处、改一处漏两处」的具体防线：
//   1. 三处调用方（solver.trialShot / safety.shoot / rules.simulateShot）在同一杆上首碰一致；
//   2. 母球身份只有一种判定（isCueBall），漏传 number 的新球不会被当成母球；
//   3. 切角上限 82（进攻）与 78（防守）各自单源，源码里没有裸字面量；
//   4. 四个 maxTime 各有名字，调用点只写名字、不写字面量。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTable } from '../src/table.js';
import { createBall, isCueBall } from '../src/physics.js';
import { simulateShot as coreSimulate } from '../src/sim.js';
import { createGame, simulateShot as rulesSimulate } from '../src/rules.js';
import { solveShot } from '../src/solver.js';
import { solveSafety } from '../src/safety.js';
import {
  MAX_SHOT_TIME,
  SOLVE_MAX_TIME,
  TUNE_MAX_TIME,
  SHOOT_MAX_TIME,
  SHOT_TIME_LIMITS,
  MAX_CUT_DEG,
} from '../src/constants.js';

const table = createTable('pool9');
const R = table.ballRadius;

// 求解器/防守侧的组合、翻袋会被挂钟预算截断；断言「一定算得出」的用例必须关掉它。
const NO_BUDGET = Object.freeze({ budgetMs: Infinity });

const srcText = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');

/** 母球在左下、1 号在正前方、2 号在母球后侧：既够 1 号直球，也有天然挡球。 */
function threeBall() {
  const balls = [
    createBall('cue', table.length * 0.25, table.width * 0.5, { number: 0 }),
    createBall('b1', table.length * 0.5, table.width * 0.5, { number: 1 }),
    createBall('b2', table.length * 0.2, table.width * 0.2, { number: 2 }),
  ];
  const game = createGame(table, balls, { kind: 'eightball', breaker: 0 });
  game.breakShot = false;
  return game.balls;
}

// 一杆只改杆法与力度，局面固定：直球 / 薄球 / 只碰库 / 打空。
const SHOTS = [
  { angle: 0, speed: 2.2, tip: { a: 0, b: 0 }, note: '正撞 1 号' },
  { angle: 0.03, speed: 2.2, tip: { a: 0, b: 0.3 }, note: '薄球' },
  { angle: Math.PI / 2, speed: 3.6, tip: { a: 0, b: 0 }, note: '只碰库' },
  { angle: -0.4, speed: 4.0, tip: { a: 0.2, b: 0 }, note: '打空' },
];

test('同一杆：sim 核心与 rules 适配层给出同一首碰、同一事件顺序', () => {
  const balls = threeBall();
  for (const shot of SHOTS) {
    const core = coreSimulate(table, balls, shot, { maxTime: SHOOT_MAX_TIME });
    const facts = rulesSimulate(table, balls, shot, { maxTime: SHOOT_MAX_TIME });
    assert.equal(core.ok, true, `${shot.note}：核心应正常跑完`);
    assert.equal(facts.firstContact, core.firstContact, `${shot.note}：首碰球号必须一致`);
    assert.equal(facts.firstContactId, core.firstContactId, `${shot.note}：首碰球 id 必须一致`);
    assert.equal(core.hitNumber, core.firstContact, `${shot.note}：三种返回形状里的同一件事必须写成同一个值`);
    // 事件顺序是「谁先撞谁」的唯一证据：整条事件流逐项相同才算等价。
    assert.deepEqual(facts.events, core.events, `${shot.note}：事件序列必须逐项一致`);
    assert.equal(facts.elapsed, core.elapsed, `${shot.note}：仿真时长必须一致`);
    assert.equal(facts.settled, core.settled, `${shot.note}：收杆判定必须一致`);
  }
});

test('solver 侧：solveShot 验证过的候选，重放回 rules 得到同一首碰且真的进球', () => {
  const balls = threeBall();
  const candidates = solveShot(table, balls, NO_BUDGET);
  assert.ok(candidates.length > 0, '这个局面应该算得出候选');
  for (const c of candidates.slice(0, 3)) {
    // cueRoute 只有走 sim 的 onStart/onStep 才采得到；为空说明适配层没接上。
    assert.ok(Array.isArray(c.cueRoute) && c.cueRoute.length > 0, `${c.targetNumber} 号：求解侧的母球轨迹应由 sim 采样而来`);
    const facts = rulesSimulate(table, balls, { angle: c.aimAngle, speed: c.speed, tip: c.tip }, { maxTime: SOLVE_MAX_TIME });
    assert.equal(facts.firstContact, c.targetNumber, `${c.targetNumber} 号：求解与真打的首碰必须是同一颗球`);
    assert.ok(
      facts.pocketed.some((p) => p.number === c.targetNumber),
      `${c.targetNumber} 号：求解说能进，重放就必须进`
    );
  }
});

test('safety 侧：solveSafety 的候选重放回 rules，首碰就是它声明的目标球', () => {
  const balls = threeBall();
  const cand = solveSafety(table, balls, { allow: [1, 2] });
  assert.ok(cand, '这个局面应该给得出防守候选');
  const facts = rulesSimulate(table, balls, { angle: cand.aimAngle, speed: cand.speed, tip: cand.tip }, { maxTime: SHOOT_MAX_TIME });
  assert.equal(facts.firstContact, cand.targetNumber, '防守候选的首碰必须与它声明的目标球一致');
});

test('isCueBall：只认 number === 0 或 id === cue', () => {
  assert.equal(isCueBall({ number: 0 }), true, 'number 0 是母球');
  assert.equal(isCueBall({ id: 'cue' }), true, 'id cue 是母球');
  assert.equal(isCueBall({ id: 'cue', number: 0 }), true, '两者都在也还是母球');
  assert.equal(isCueBall({ id: 'b7', number: 7 }), false, '普通球不是母球');
  assert.equal(isCueBall({ id: 'b7' }), false, '缺 number 的球不是母球');
  assert.equal(isCueBall(null), false, '空值不是母球');
  assert.equal(isCueBall(undefined), false, 'undefined 不是母球');
});

test('createBall 不再默认 number 0：漏传的球不会被当成母球', () => {
  const fresh = createBall('x', R * 3, R * 3);
  assert.equal(fresh.number, undefined, 'number 必须由调用方显式给出');
  assert.equal(isCueBall(fresh), false, '漏传 number 的新球不得被当成母球');
  assert.equal(isCueBall(createBall('cue', R * 3, R * 3)), true, 'id 为 cue 的球仍是母球');
  assert.equal(isCueBall(createBall('b9', R * 3, R * 3, { number: 9 })), false, '显式 9 号不是母球');
});

test('切角上限：全项目唯一 MAX_CUT_DEG = 82，进攻与防守读同一个常量', () => {
  // 契约变更（072 统一）：原来进攻 82 / 防守 78 两条边界，现在合并成一条 82°。
  // 取 82 而不是 78：78–82° 之间的球物理上能打，把进攻侧收到 78 会删掉现有能打的球；
  // 把防守侧放宽到 82 只是多几个极薄球选项，不会凭空造出打不进的球。
  assert.equal(MAX_CUT_DEG, 82, '统一后的切角上限就是 82°');

  // 只有一处定义：旧的两个名字必须彻底消失，不允许留下能各自漂移的第二份。
  const constantsText = srcText('constants.js');
  assert.doesNotMatch(constantsText, /MAX_CUT_ATTACK_DEG|MAX_CUT_SAFETY_DEG/, '旧的两个切角常量必须删干净');
  assert.doesNotMatch(srcText('safety.js'), /export (const )?\{? ?MAX_CUT_DEG/, 'safety 不再导出自己的切角副本');

  // 两侧都从同一个常量读：改常量两侧一起变，不会再出现「改一处漏一处」。
  assert.match(srcText('solver.js'), /cutDeg > MAX_CUT_DEG/, 'solveShot 的切角门槛必须读唯一常量');
  assert.doesNotMatch(srcText('solver.js'), /cutDeg > 82/, 'solveShot 里不应再有裸 82');
  assert.match(srcText('tolerance.js'), /> MAX_CUT_DEG/, '容错窗口的切角门槛必须读同一个常量');
  assert.doesNotMatch(srcText('tolerance.js'), /> 82\b/, 'tolerance.js 里不应再有裸 82');
  assert.match(
    srcText('safety.js'),
    /import \{[^}]*\bMAX_CUT_DEG\b[^}]*\} from '\.\/constants\.js'/,
    'safety 必须从 constants 直接 import 这个常量'
  );
});

test('时限常量表：四个用途各一个名字，调用点只写名字不写字面量', () => {
  assert.deepEqual(
    SHOT_TIME_LIMITS,
    { solve: 20, tune: 16, safety: 20, play: 26 },
    '四个用途的时限就是原来散落在四处的那四个数，一个都没改'
  );
  assert.equal(MAX_SHOT_TIME, 26, '没有显式时限时仍然走 MAX_SHOT_TIME');
  assert.equal(SHOT_TIME_LIMITS.play, MAX_SHOT_TIME, '真打用的就是默认时限');

  assert.match(srcText('solver.js'), /maxTime: SOLVE_MAX_TIME/, 'trialShot 必须用 SOLVE_MAX_TIME');
  assert.match(srcText('solver.js'), /maxTime: TUNE_MAX_TIME/, 'solveBankDirection 必须用 TUNE_MAX_TIME');
  assert.match(srcText('safety.js'), /maxTime: SHOOT_MAX_TIME/, 'shoot 必须用 SHOOT_MAX_TIME');
  assert.match(srcText('physics.js'), /maxTime \?\? MAX_SHOT_TIME/, 'runShot 的默认值必须仍是 MAX_SHOT_TIME');

  for (const name of ['solver.js', 'safety.js', 'rules.js', 'sim.js']) {
    assert.doesNotMatch(srcText(name), /maxTime:\s*\d/, `${name} 里不应再有写死的 maxTime 字面量`);
  }
});

test('单一入口尊重调用方传的 maxTime，并如实报收杆状态', () => {
  const balls = threeBall();
  const short = coreSimulate(table, balls, SHOTS[0], { maxTime: 0.05, dt: 1 / 120 });
  // runShot 是「先走一步、再看有没有超时」，所以最多会超出一个 dt，这属于原有语义。
  const oneStep = 1 / 120 + 1e-9;
  assert.ok(short.elapsed <= 0.05 + oneStep, `时限 0.05 时最多超一个 dt，实际 ${short.elapsed}`);
  assert.ok(short.elapsed < 0.1, `时限 0.05 的杆不该跑到 0.1s 以上，实际 ${short.elapsed}`);
  assert.equal(short.settled, false, '50ms 内球不可能停稳');
  const full = coreSimulate(table, balls, SHOTS[0], { maxTime: SHOOT_MAX_TIME });
  assert.ok(full.elapsed > 0.05, '给足时限就应该跑得更久');
});

test('solver 与 safety 之间不再互相 import（循环依赖已断开）', () => {
  const safetySrc = srcText('safety.js');
  assert.doesNotMatch(safetySrc, /from '\.\/solver\.js'/, 'safety 不应再回头 import solver');
  assert.match(safetySrc, /from '\.\/tolerance\.js'/, 'safety 的容错窗口应改从 tolerance.js 取');
  assert.match(srcText('solver.js'), /from '\.\/tolerance\.js'/, 'solver 也应从 tolerance.js 取容错窗口');
});