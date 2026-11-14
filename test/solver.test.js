// 求解器测试：假想球几何、甩球补偿、容错窗口、端到端"推荐即打进"。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall, createWorld, strike, runShot } from '../src/physics.js';
import { PHYS, SPEED, SEARCH_DT } from '../src/constants.js';
import { V, DEG } from '../src/geometry.js';
import {
  ghostBallPosition,
  cutAngleDeg,
  solveContactNormal,
  objectBallAfterImpact,
  firstBlocker,
  aimToleranceDeg,
} from '../src/aim.js';
import { solveShot, coach, describeCandidate, toleranceText, cueRestText, difficultyLabel, difficultyCaveat, LABEL_SIGMA_DEG, pocketName, solveBreak, solveDirectHit, planShot } from '../src/solver.js';
import { createGame } from '../src/rules.js';
import * as rulesMod from '../src/rules.js';
import { createStandardRack } from '../src/rack.js';

const table = createTable('pool9');
const R = table.ballRadius;

// 求解器的组合球 / 翻袋可以按挂钟预算截断（`opts.budgetMs`，显式传入才生效；
// 默认不截断，工作量由 maxCombos / maxBanks / maxBankTries 框住）。
// 手动传了预算就随时可能 break，所以凡是断言「一定算得出 N 个候选」的用例
// 都必须显式关掉预算——否则在慢机器或 CI 上会算出 0 个，断言失败却与算法无关
// （实测 1 ms 预算时同一翻袋布局返回 0 个）。预算只决定「算多久」，不影响候选的正确性。
const NO_BUDGET = Object.freeze({ budgetMs: Infinity });

test('假想球：位于目标球指向袋心的反方向上，距离恰好一个直径', () => {
  const target = { x: 1.0, y: 0.6 };
  const pocket = { x: 2.54, y: 0 };
  const ghost = ghostBallPosition(target, pocket, R);
  const d = Math.hypot(ghost.x - target.x, ghost.y - target.y);
  assert.ok(Math.abs(d - 2 * R) < 1e-9, `假想球距离应为 2R，实际 ${d}`);
  // 共线：target 在 ghost 与 pocket 之间
  const toGhost = V.norm(V.sub(ghost, target));
  const toPocket = V.norm(V.sub(pocket, target));
  assert.ok(V.dot(toGhost, toPocket) < -0.999, '假想球应在目标球背向袋的一侧');
});

test('切角：正撞 0°，袋在侧向时接近 90°', () => {
  const target = { x: 1.0, y: 0.6 };
  const pocket = { x: 2.54, y: 0 };
  const ghost = ghostBallPosition(target, pocket, R);
  const outDir = V.norm(V.sub(pocket, target));

  // 母球在假想球正后方（沿出球方向的反向）→ 切角 0
  const behind = { x: ghost.x - outDir.x, y: ghost.y - outDir.y };
  assert.ok(cutAngleDeg(behind, ghost, target, pocket) < 1e-6);

  // 母球在假想球正侧方（垂直出球方向）→ 切角 90°
  const side = { x: ghost.x + outDir.y, y: ghost.y - outDir.x };
  assert.ok(Math.abs(cutAngleDeg(side, ghost, target, pocket) - 90) < 1e-6);
});

test('甩球：等质量球斜撞时目标球偏离法线，且方向符合切向冲量符号', () => {
  const n = { x: 1, y: 0 };
  const speed = 2.0;
  // 入射方向与法线成 +30°，切向分量为正
  const vDir = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };
  const res = objectBallAfterImpact(vDir, speed, n, PHYS);
  assert.ok(res, '应有解');
  assert.ok(res.throwDeg > 0, `目标球应朝切向正方向偏，实际 ${res.throwDeg}`);
  assert.ok(res.throwDeg < 5, `甩球角应在几度以内，实际 ${res.throwDeg}`);
});

test('甩球：正撞时无甩球', () => {
  const n = { x: 1, y: 0 };
  const res = objectBallAfterImpact({ x: 1, y: 0 }, 2, n, PHYS);
  assert.ok(Math.abs(res.throwDeg) < 1e-9);
});

test('甩球补偿：反解出的接触法线让目标球实际出球方向对准袋心', () => {
  const cue = { x: 0.635, y: 0.635 };
  const target = { x: 1.905, y: 0.635 };
  const pocket = { x: 2.54, y: 0 };
  const outDir = V.norm(V.sub(pocket, target));

  const sol = solveContactNormal(cue, target, outDir, SPEED.medium, R, PHYS);
  const vDir = V.norm(V.sub(sol.ghost, cue));
  const res = objectBallAfterImpact(vDir, SPEED.medium, sol.normal, PHYS);

  // 出球方向与期望方向的夹角应小于 0.01°
  const err = Math.abs(Math.atan2(V.cross(outDir, res.dir), V.dot(outDir, res.dir)) * DEG);
  assert.ok(err < 0.01, `出球方向误差 ${err}° 过大`);
  // 补偿量本身应当是可见的（1° 量级），否则说明没起作用
  assert.ok(Math.abs(sol.throwDeg) > 0.3, `甩球角 ${sol.throwDeg}° 太小，补偿可能失效`);
});

test('遮挡：母球路径上有球时能检出，无球时不误报', () => {
  const from = { x: 0.5, y: 0.6 };
  const to = { x: 2.0, y: 0.6 };
  const clear = [{ id: 'a', x: 1.0, y: 1.2, pocketed: false }];
  const blocked = [{ id: 'a', x: 1.0, y: 0.6, pocketed: false }];

  assert.equal(firstBlocker(from, to, clear, [], R), null);
  const hit = firstBlocker(from, to, blocked, [], R);
  assert.ok(hit && hit.id === 'a');
  // 忽略列表生效
  assert.equal(firstBlocker(from, to, blocked, ['a'], R), null);
});

test('容错窗口：袋口越大越宽、距离越远越窄、切角越薄越窄', () => {
  const target = { x: 1.5, y: 0.6 };
  const pocket = { x: 2.54, y: 0 };
  const ghost = ghostBallPosition(target, pocket, R);
  const cue = { x: 0.5, y: 0.6 };

  const wide = aimToleranceDeg(cue, ghost, target, pocket, 0.09, R);
  const narrow = aimToleranceDeg(cue, ghost, target, pocket, 0.05, R);
  assert.ok(wide > narrow, '大袋口容错应更宽');

  const far = aimToleranceDeg({ x: -1, y: 0.6 }, ghost, target, pocket, 0.074, R);
  const near = aimToleranceDeg({ x: 1.0, y: 0.6 }, ghost, target, pocket, 0.074, R);
  assert.ok(near > far, '近球容错应更宽');
});

test('求解器：一个必进球给出候选，且排序按综合价值升序', () => {
  const cue = createBall('cue', 0.635, 0.635, { number: 0 });
  const obj = createBall('b1', 1.905, 0.635, { number: 1 });
  createWorld(table, [cue, obj]);

  const all = solveShot(table, [cue, obj]);
  assert.ok(all.length > 0, '应至少给出一个方案');
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].value >= all[i - 1].value, '必须按综合价值升序');
    // 走位奖励双向生效：走位好扣分、走位差加分，但绝对值不超过 15
    assert.ok(
      Math.abs(all[i].difficulty - all[i].value) <= 22.5 + 1e-9,
      `综合价值与单杆难度最多差 22.5 分，实际 ${all[i].difficulty - all[i].value}`
    );
  }
  for (const c of all) {
    assert.ok(c.toleranceDeg > 0);
    assert.ok(c.speed > 0 && Number.isFinite(c.speed));
    assert.ok(Number.isFinite(c.aimAngle));
  }
});

test('求解器：每个推荐方案真的能把目标球打进它声称的袋', () => {
  const layouts = [
    { cue: { x: 0.635, y: 0.635 }, objs: [{ x: 1.905, y: 0.635 }] },
    { cue: { x: 0.4, y: 0.4 }, objs: [{ x: 1.4, y: 0.9 }] },
    { cue: { x: 2.1, y: 0.3 }, objs: [{ x: 1.1, y: 0.85 }] },
    { cue: { x: 0.9, y: 1.05 }, objs: [{ x: 1.7, y: 0.35 }] },
  ];

  for (const [i, layout] of layouts.entries()) {
    const balls = [createBall('cue', layout.cue.x, layout.cue.y, { number: 0 })];
    layout.objs.forEach((o, k) => balls.push(createBall('b' + (k + 1), o.x, o.y, { number: k + 1 })));
    createWorld(table, balls);

    const all = solveShot(table, balls);
    assert.ok(all.length > 0, `布局 ${i} 应有解`);

    const best = all[0];
    const copy = balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
    const w = createWorld(table, copy);
    const cue = copy.find((b) => b.id === 'cue');
    const target = copy.find((b) => b.id === best.targetId);
    strike(cue, { angle: best.aimAngle, speed: best.speed, tip: { a: best.tip.a, b: best.tip.b } });
    runShot(w, { maxTime: 22 });

    assert.ok(
      target.pocketed && target.pocket === best.pocketId,
      `布局 ${i}: 推荐进 ${best.pocketId}，实际 ${target.pocket ?? '未进袋'}`
    );
  }
});

test('求解器：走位分只由「打完之后的台面」决定，且奖励有上限', () => {
  // 造一个明显有两条路的布局：同一颗球可以从两个不同的袋进，
  // 打完母球会停在不同位置，所以两条路的 leaveScore 应该不同。
  const balls = [
    createBall('cue', 0.45, 0.9, { number: 0 }),
    createBall('b1', 1.35, 0.55, { number: 1 }),
    createBall('b2', 2.0, 1.05, { number: 2 }),
  ];
  createWorld(table, balls);
  const all = solveShot(table, balls);
  assert.ok(all.length >= 2, '这个布局应给出多个候选');

  const scored = all.filter((c) => c.leaveScore !== null);
  assert.ok(scored.length >= 1, '至少要有候选能算出走位分');
  const positioned = all.find((c) => c.positioningRequired && c.nextShot);
  assert.ok(positioned, '打完仍有合法目标球时，候选必须提供母球停位和下一杆目标');
  assert.ok(positioned.cueRest, '应返回仿真母球实际停位');
  assert.ok(positioned.cueRoute?.length >= 2, '应返回可显示的母球实际走位轨迹');
  assert.match(describeCandidate(positioned), /母球建议停位.*下一杆打/);
  const replay = balls.map((b) => ({ ...b }));
  const replayWorld = createWorld(table, replay);
  const replayCue = replay.find((b) => b.id === 'cue');
  strike(replayCue, {
    angle: positioned.aimAngle,
    speed: positioned.speed,
    tip: { a: positioned.tip.a, b: positioned.tip.b },
  });
  runShot(replayWorld, { maxTime: 20, dt: SEARCH_DT });
  assert.ok(Math.hypot(replayCue.x - positioned.cueRest.x, replayCue.y - positioned.cueRest.y) < 1e-8);
  assert.equal(replay.find((b) => b.id === positioned.nextShot.targetId).pocketed, false);
  const distinct = new Set(scored.map((c) => Math.round(c.leaveScore)));
  assert.ok(distinct.size >= 2, '不同走位的候选应给出不同的走位分');

  for (const c of all) {
    if (c.leaveScore === null) {
      assert.equal(c.value, c.difficulty, '没有走位数据时价值应等于单杆难度');
    } else {
      assert.ok(c.leaveScore >= 0 && c.leaveScore <= 100);
      const delta = c.difficulty - c.value;
      assert.ok(Math.abs(delta) <= 22.5 + 1e-9, `走位修正 ${delta} 超过 ±22.5 分上限`);
    }
  }
  // 走位好的一定比走位差的更靠前（同等单杆难度下）
  const sorted = [...scored].sort((a, b) => a.value - b.value);
  assert.ok(sorted.at(-1).leaveScore <= sorted[0].leaveScore + 1e-9 || sorted.at(-1).difficulty > sorted[0].difficulty);
});

test('教练卡说人话：容错给毫米级对照，停位给台面位置而不是坐标', () => {
  // 产品问题：卡片上写「容错 ±0.57°」，球友读不出这有多难；写
  // 「母球建议停位 (1.62, 0.83) 米」，站在台边的人没法把坐标变成「往哪儿走」。
  const balls = [
    createBall('cue', 0.6, 0.62, { number: 0 }),
    createBall('b3', 1.7, 0.95, { number: 3 }),
    createBall('b5', 2.0, 0.4, { number: 5 }),
  ];
  createWorld(table, balls);
  const all = solveShot(table, balls, { cueId: 'cue' });
  assert.ok(all.length > 0, '这个布局必须有解，否则这条测试什么也没证明');

  for (const c of all) {
    const text = describeCandidate(c);
    // 角度后面必须跟得上「走多远、偏几毫米」，光有度数不算说清
    assert.match(text, /容错 ±[\d.]+°（母球走 [\d.]+ 米，方向偏 [\d.]+ (毫米|厘米)就打不进）/, text);
    if (c.positioningRequired && c.cueRest) {
      assert.match(text, /母球建议停位：台面[^（]*（距[上下左右]库 \d+ 厘米）/, text);
      assert.doesNotMatch(text, /母球建议停位 \(\d/, `停位不该退回坐标：${text}`);
    }
  }

  // 贴球（不到 20 厘米）时不给毫无信息量的「偏 1 毫米」，只留角度
  const near = { toleranceDeg: 0.5, distanceCue: 0.1 };
  assert.equal(toleranceText(near), '容错 ±0.50°');
  // 没带球台的旧调用方退回坐标，不能直接抛
  assert.match(cueRestText(null, { x: 1, y: 0.5 }), /母球建议停位 \(1\.00, 0\.50\) 米/);
});

test('求解器：被完全挡住的球不会出现在候选里', () => {
  const cue = createBall('cue', 0.4, 0.635, { number: 0 });
  const target = createBall('b1', 2.2, 0.635, { number: 1 });
  // 正中间放一颗球挡住整条直线
  const wall = createBall('b2', 1.3, 0.635, { number: 2 });
  createWorld(table, [cue, target, wall]);

  const all = solveShot(table, [cue, target, wall]);
  const bad = all.filter((c) => c.targetId === 'b1' && (c.pocketId === 'c-br' || c.pocketId === 'c-tr'));
  // 这两条线都要穿过挡球，允许存在但必须是被验证过能进的（会有弧线/绕行的情况极少）
  for (const c of bad) {
    const copy = [cue, target, wall].map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
    const w = createWorld(table, copy);
    const cc = copy.find((b) => b.id === 'cue');
    const tt = copy.find((b) => b.id === 'b1');
    strike(cc, { angle: c.aimAngle, speed: c.speed, tip: { a: c.tip.a, b: c.tip.b } });
    runShot(w, { maxTime: 22 });
    assert.ok(tt.pocketed && tt.pocket === c.pocketId, `候选 ${c.pocketId} 验证不通过却被保留`);
  }
});

test('求解器：没有母球时抛错', () => {
  const obj = createBall('b1', 1.0, 0.635, { number: 1 });
  createWorld(table, [obj]);
  assert.throws(() => solveShot(table, [obj]), /找不到母球/);
});

test('教练卡：有解时给出可读句子与难度档，无解时给防守建议', () => {
  const cue = createBall('cue', 0.635, 0.635, { number: 0 });
  const obj = createBall('b1', 1.905, 0.635, { number: 1 });
  createWorld(table, [cue, obj]);

  const card = coach(table, [cue, obj]);
  assert.equal(card.found, true);
  assert.match(card.message, /打 \d+ 号球进/);
  assert.match(card.message, /切角/);
  assert.match(card.message, /容错/);
  assert.ok(card.verdict.length > 0);

  // 文案必须和 describeCandidate 完全一致——UI 切备选时用的是同一个函数
  assert.equal(card.message, describeCandidate(card.best));

  // 只有母球 → 无解
  const lonely = createBall('cue', 0.635, 0.635, { number: 0 });
  createWorld(table, [lonely]);
  const none = coach(table, [lonely]);
  assert.equal(none.found, false);
  assert.match(none.message, /防守/);
});

test('describeCandidate：每个候选都能单独说成一句话，且带上摔袋警告', () => {
  const cue = createBall('cue', 0.635, 0.635, { number: 0 });
  const obj = createBall('b1', 1.905, 0.635, { number: 1 });
  createWorld(table, [cue, obj]);

  const all = solveShot(table, [cue, obj]);
  assert.ok(all.length > 0);
  for (const c of all) {
    const s = describeCandidate(c);
    assert.ok(s.includes(String(c.targetNumber)), s);
    assert.ok(s.includes(pocketName(c.pocketId)), s);
    assert.ok(s.includes(c.toleranceDeg.toFixed(2)), s);
    assert.equal(s.includes('摔袋风险'), c.scratchRisk);
  }
});

test('难度档与袋名：所有分档都有中文标签', () => {
  for (const s of [0, 24, 30, 50, 60, 80, 95]) {
    assert.ok(difficultyLabel(s).length > 0);
  }
  for (const p of table.pockets) {
    assert.ok(pocketName(p.id) !== p.id, `${p.id} 缺少中文名`);
  }
});

test('难度档位必须说出它假设的瞄准精度，不能只说「很容易」', () => {
  // 实测依据（_research/probe-sigma-sweep.mjs）：固定 160 个首推方案，
  // σ=0.20° 时四档全部达标（97/82/63/43%），σ=0.60° 时四档全部不达标（80/46/29/13%）。
  // 也就是说「很容易」这三个字本身有前提，不写出来就是误导。
  assert.ok(LABEL_SIGMA_DEG > 0 && LABEL_SIGMA_DEG <= 0.5, `假设的精度 ${LABEL_SIGMA_DEG}° 不合理`);
  const caveat = difficultyCaveat();
  assert.match(caveat, /瞄准误差/);
  assert.ok(caveat.includes(String(LABEL_SIGMA_DEG)), `说明里要带上 ${LABEL_SIGMA_DEG}°`);

  // coach 的 verdict 里必须同时有档位名和这条前提
  const cue = createBall('cue', 0.635, 0.635, { number: 0 });
  const obj = createBall('b1', 1.905, 0.635, { number: 1 });
  createWorld(table, [cue, obj]);
  const card = coach(table, [cue, obj]);
  assert.equal(card.found, true);
  assert.ok(
    card.verdict.includes(difficultyLabel(card.best.value ?? card.best.difficulty)),
    `verdict 里缺档位名：${card.verdict}`
  );
  assert.ok(card.verdict.includes(caveat), `verdict 里缺精度前提：${card.verdict}`);
});

// ------------------------------------------------------- 开球 / 兜底 / 球局选杆

test('开球方案：瞄的是离母球最近的顶点球，全力，中低杆', () => {
  const balls = createStandardRack(table, { seed: 1 }).map((b) => createBall(b.id, b.x, b.y, b));
  const cue = balls.find((b) => b.number === 0);
  const plan = solveBreak(table, balls);
  assert.ok(plan, '应该给得出开球方案');
  assert.equal(plan.kind, 'break');
  assert.equal(plan.targetNumber, 1, '摆好的三角阵顶点是 1 号球');
  assert.equal(plan.speed, SPEED.break);
  assert.equal(plan.tip.b < 0, true, '开球用低杆压母球');
  // 瞄准角应指向顶点球
  const apex = balls.find((b) => b.number === 1);
  const expect = Math.atan2(apex.y - cue.y, apex.x - cue.x);
  assert.ok(Math.abs(plan.aimAngle - expect) < 1e-9);
});

test('开球方案：台面上只剩母球时返回 null', () => {
  const cue = createBall('cue', 0.635, 0.635, { number: 0 });
  assert.equal(solveBreak(table, [cue]), null);
});

test('开球方案：真打出去能合法开球（四颗目标球被驱向库边）', () => {
  // 这一条把"方案"和"规则"接起来：开球方案不是纸上谈兵，打了必须合法。
  const { simulateShot, createGame, resolveShot, FOUL } = rulesMod;
  const balls = createStandardRack(table, { seed: 3 }).map((b) => createBall(b.id, b.x, b.y, b));
  const game = createGame(table, balls);
  const plan = solveBreak(table, balls);
  const facts = simulateShot(table, game.balls, {
    angle: plan.aimAngle,
    speed: plan.speed,
    tip: plan.tip,
  });
  assert.equal(facts.firstContact, 1, '开球必须先碰到顶点 1 号球');
  assert.ok(facts.objectBallsToRail.length >= 4, `被驱向库边的目标球只有 ${facts.objectBallsToRail.length} 颗`);
  const { report } = resolveShot(game, facts);
  assert.equal(
    report.fouls.some((f) => f.code === FOUL.ILLEGAL_BREAK),
    false,
    '开球不该被判不合法：' + report.summary
  );
});

test('兜底直撞：没有进攻机会时给出一个合法的直撞方案', () => {
  // 把目标球紧贴库边、袋口全被挡住，逼进攻求解失败
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const objs = [
    createBall('b1', table.ballRadius + 1e-3, table.ballRadius + 1e-3, { number: 1 }),
    createBall('b2', table.ballRadius + 1e-3, table.width - table.ballRadius - 1e-3, { number: 2 }),
    createBall('b8', 1.9, table.width / 2, { number: 8 }),
  ];
  const balls = [cue, ...objs];
  createWorld(table, balls);

  const plan = solveDirectHit(table, balls, { allow: [1, 2, 8] });
  assert.ok(plan, '兜底方案不该是 null');
  assert.equal(plan.kind, 'direct');
  assert.ok([1, 2, 8].includes(plan.targetNumber));
  // 直撞瞄的就是球心
  const target = objs.find((b) => b.number === plan.targetNumber);
  const expect = Math.atan2(target.y - cue.y, target.x - cue.x);
  assert.ok(Math.abs(plan.aimAngle - expect) < 1e-9);
});

test('兜底直撞：没有合法目标时返回 null', () => {
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const obj = createBall('b9', 1.8, table.width / 2, { number: 9 });
  createWorld(table, [cue, obj]);
  assert.equal(solveDirectHit(table, [cue, obj], { allow: [1, 2] }), null);
});

test('兜底直撞：真打出去会先碰到合法球，不判未碰球', () => {
  const { simulateShot, createGame, resolveShot, FOUL } = rulesMod;
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const obj = createBall('b1', 1.9, table.width / 2, { number: 1 });
  const balls = [cue, obj];
  const game = createGame(table, balls);
  game.breakShot = false;
  const plan = solveDirectHit(table, balls, { allow: [1] });
  const facts = simulateShot(table, game.balls, {
    angle: plan.aimAngle,
    speed: plan.speed,
    tip: plan.tip,
  });
  assert.equal(facts.firstContact, 1);
  const { report } = resolveShot(game, facts);
  assert.equal(
    report.fouls.some((f) => f.code === FOUL.NO_CONTACT),
    false,
    '不该判未碰球：' + report.summary
  );
});

test('planShot：开球给开球方案，有进攻机会给进攻方案', () => {
  const balls = createStandardRack(table, { seed: 2 }).map((b) => createBall(b.id, b.x, b.y, b));
  const game = createGame(table, balls);
  const r1 = planShot(table, game);
  assert.equal(r1.kind, 'break');
  assert.equal(r1.plan.kind, 'break');

  // 散球局面：母球 + 一颗球正对袋口
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const obj = createBall('b3', 1.8, table.width / 2, { number: 3 });
  const g2 = createGame(table, [cue, obj]);
  g2.breakShot = false;
  const r2 = planShot(table, g2, { allow: [3] });
  assert.equal(r2.kind, 'attack');
  assert.equal(r2.plan.kind, undefined, '进攻方案不带 kind 标记');
  assert.ok(r2.plan.pocketId);
});

test('planShot：没有母球时抛错', () => {
  // createGame 自己就要求有母球，所以这里直接构造一个缺母球的球局对象
  const g = { ...createGame(table, [createBall('b1', 1, 1, { number: 1 }), createBall('cue', 0.6, 0.6, { number: 0 })]) };
  g.balls = g.balls.filter((b) => b.number !== 0);
  assert.throws(() => planShot(table, g), /母球/);
});

test('开球文案：说明是开球、说清全力、不假装有目标袋', () => {
  const balls = createStandardRack(table, { seed: 1 }).map((b) => createBall(b.id, b.x, b.y, b));
  const plan = solveBreak(table, balls);
  const s = describeCandidate(plan);
  assert.match(s, /开球/);
  assert.match(s, /全力/);
  assert.equal(/进.+袋/.test(s), false, '开球不该说进哪个袋');
});

test('兜底文案：说清"没有进球机会"与"保证合法碰球"', () => {
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const obj = createBall('b1', 1.8, table.width / 2, { number: 1 });
  const plan = solveDirectHit(table, [cue, obj], { allow: [1] });
  const s = describeCandidate(plan);
  assert.match(s, /没有进球机会/);
  assert.match(s, /保证合法碰球/);
});

// ---------------------------------------------------------------- 组合球与翻袋

/** 9 号球贴下库、母球在台尾：四个角袋都打不到，只能翻库。 */
function bankLayout() {
  const cue = createBall('cue', table.length * 0.2, table.width * 0.5, { number: 0 });
  const nine = createBall('b9', table.length * 0.5, table.width * 0.045, { number: 9 });
  return [cue, nine];
}

/** 9 号球在中央、1 号球挡在母球与它之间。 */
function comboLayout() {
  const cue = createBall('cue', table.length * 0.1, table.width * 0.5, { number: 0 });
  const mid = createBall('b1', table.length * 0.45, table.width * 0.55, { number: 1 });
  const nine = createBall('b9', table.length * 0.75, table.width * 0.55, { number: 9 });
  return [cue, mid, nine];
}

test('翻袋：打不进直线球时，会给出翻库进袋的候选（不是返回空）', () => {
  const balls = bankLayout();
  const direct = solveShot(table, balls, { cueId: 'cue', allow: [9], extras: false });
  assert.equal(direct.length, 0, '这个布局本来就没有直线解，测试前提要先成立');

  const all = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET });
  const banks = all.filter((c) => c.kind === 'bank');
  assert.ok(banks.length > 0, `应该算出翻袋候选，实际 ${all.length} 个候选里一个都没有`);

  const c = banks[0];
  assert.ok(c.bankRail, '翻袋候选要记下翻的是哪条库');
  assert.ok(['ymin', 'ymax', 'xmin', 'xmax'].includes(c.bankRail));
  assert.ok(c.pocketId, '翻袋候选要带上目标袋');
  assert.equal(c.verified, true, '给出的翻袋候选必须真跑过仿真验证');
  assert.match(describeCandidate(c), /翻袋/);
});

test('翻袋：容错按展开路径算，不会比直线球还宽松', () => {
  const balls = bankLayout();
  const banks = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'bank');
  assert.ok(banks.length > 0);

  // 曾经把「目标球到袋口」当成直线距离算容错，翻袋多走一个库边长，容错被算成
  // ±1.95°，比正对直球（±0.12°）还宽松，难度只有 37，排序时会排在正经球前面。
  for (const c of banks) {
    assert.ok(c.toleranceDeg > 0 && c.toleranceDeg < 1.2, `翻袋容错应该在 (0, 1.2) 度内，实际 ${c.toleranceDeg}`);
  }
});

test('翻袋：难度比同等条件的直线球高（固定加数，且有上限 100）', () => {
  const balls = bankLayout();
  const banks = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'bank');
  assert.ok(banks.length > 0);
  for (const c of banks) {
    assert.ok(c.difficulty <= 100, `难度不能超 100，实际 ${c.difficulty}`);
    assert.ok(c.difficulty > 40, `翻袋不该被算成简单球，实际 ${c.difficulty}`);
  }
});

test('翻袋：给出来的候选真打出去，目标球必须真的进那个袋', () => {
  const balls = bankLayout();
  const banks = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'bank');
  assert.ok(banks.length > 0);
  const c = banks[0];

  const copy = balls.map((b) => createBall(b.id, b.x, b.y, b));
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === 'cue');
  const nine = copy.find((b) => b.id === 'b9');
  strike(cue, { angle: c.aimAngle, speed: c.speed, tip: { a: c.tip.a, b: c.tip.b } });
  runShot(world, { maxTime: 20 });

  assert.equal(nine.pocketed, true, `按建议打出去 9 号球应该进袋，实际停在 (${nine.x.toFixed(3)}, ${nine.y.toFixed(3)})`);
  assert.equal(nine.pocket, c.pocketId, `应该进 ${c.pocketId}，实际进的是 ${nine.pocket}`);
});

test('翻袋：袋口顺序不会把后面的袋饿死（尝试次数与成功数分开计）', () => {
  // 曾经把「被拒的尝试」也算进 maxBanks 配额，遍历到第 10 次就收工，
  // 下中袋永远轮不到，翻袋永远返回 0 个。
  const balls = bankLayout();
  const all = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET });
  assert.ok(all.length > 0, '默认配额下应该至少能算出候选');
  // 把配额放开，结果只能是「一样多或更多」，不能更少
  const more = solveShot(table, balls, { cueId: 'cue', allow: [9], maxBanks: 20, maxBankTries: 200, ...NO_BUDGET });
  assert.ok(more.length >= all.length, `放宽配额不该变少：默认 ${all.length} 个，放宽 ${more.length} 个`);
});

test('组合球：目标球被挡住时，会给出「打 A 撞 B 进袋」的候选', () => {
  const balls = comboLayout();
  const all = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET });
  const combos = all.filter((c) => c.kind === 'combo');
  assert.ok(combos.length > 0, `应该算出组合球候选，实际 kinds=${all.map((c) => c.kind).join(',')}`);

  const c = combos[0];
  assert.ok(c.viaId, '组合球候选要记下中间球');
  assert.ok(c.viaNumber >= 1 && c.viaNumber <= 15);
  assert.notEqual(c.viaNumber, c.targetNumber, '中间球不能就是目标球');
  assert.equal(c.targetNumber, 9);
  assert.equal(c.verified, true, '给出的组合球候选必须真跑过仿真验证');
  const s = describeCandidate(c);
  assert.match(s, /组合球/);
  assert.match(s, new RegExp(`${c.viaNumber} 号球`));
});

test('组合球：给出来的候选真打出去，9 号球必须真的进那个袋', () => {
  const balls = comboLayout();
  const combos = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'combo');
  assert.ok(combos.length > 0);
  const c = combos[0];

  const copy = balls.map((b) => createBall(b.id, b.x, b.y, b));
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === 'cue');
  const nine = copy.find((b) => b.id === 'b9');
  strike(cue, { angle: c.aimAngle, speed: c.speed, tip: { a: c.tip.a, b: c.tip.b } });
  runShot(world, { maxTime: 20 });

  assert.equal(nine.pocketed, true, `按建议打出去 9 号球应该进袋，实际停在 (${nine.x.toFixed(3)}, ${nine.y.toFixed(3)})`);
  assert.equal(nine.pocket, c.pocketId);
});

test('组合球：难度有固定加数，不比同样容错的直线球更容易', () => {
  const balls = comboLayout();
  const combos = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'combo');
  assert.ok(combos.length > 0);
  for (const c of combos) {
    assert.ok(c.difficulty <= 100, `难度不能超 100，实际 ${c.difficulty}`);
    assert.ok(c.difficulty > 40, `组合球不该被算成简单球，实际 ${c.difficulty}`);
  }
});

test('组合球与翻袋：直接解存在时不算，省下的时间是真的省了', () => {
  const balls = bankLayout();
  // 用一个有直接解的布局：9 号球在袋口正前方
  const easy = [
    createBall('cue', table.length * 0.3, table.width * 0.5, { number: 0 }),
    createBall('b9', table.length * 0.8, table.width * 0.5, { number: 9 }),
  ];
  const direct = solveShot(table, easy, { cueId: 'cue', allow: [9], extras: false });
  assert.ok(direct.length > 0, '这个布局应该有直线解');
  const full = solveShot(table, easy, { cueId: 'cue', allow: [9], ...NO_BUDGET });
  assert.equal(
    full.some((c) => c.kind === 'combo' || c.kind === 'bank'),
    false,
    '有直接解就不该再算组合球/翻袋'
  );
  assert.ok(balls.length > 0);
});

test('组合球与翻袋：求解结果里这两类都带完整可执行参数', () => {
  const extras = [
    ...solveShot(table, comboLayout(), { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'combo'),
    ...solveShot(table, bankLayout(), { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'bank'),
  ];
  assert.ok(extras.length > 0);
  for (const c of extras) {
    for (const key of ['aimAngle', 'speed', 'tip', 'cutDeg', 'toleranceDeg', 'difficulty', 'value']) {
      assert.ok(c[key] !== undefined && c[key] !== null, `${c.kind} 候选缺少 ${key}`);
    }
    assert.ok(Number.isFinite(c.aimAngle));
    assert.ok(c.speed > 0);
    assert.ok(c.tip.a !== undefined && c.tip.b !== undefined);
    assert.ok(c.tip.name);
  }
});

test('求解结果是确定的：默认设置算两遍，候选必须逐项相同', () => {
  // 产品问题：同一个局面连点两次「求解」，备选方案个数不一样，用户会以为程序在乱说。
  // 根因是默认预算曾经是 600 ms 挂钟 —— 快的机器算完，慢的机器被砍掉一半。
  // 现在默认不截断，工作量由 maxCombos / maxBanks / maxBankTries 这些配额框住。
  const key = (list) => list.map((c) => `${c.kind ?? 'direct'}|${c.pocketId}|${c.value}`).join(',');
  const balls = bankLayout(); // 这个布局没有直接解，两遍都会走组合球/翻袋那条最贵的路

  const first = solveShot(table, balls, { cueId: 'cue', allow: [9] });
  const second = solveShot(table, balls, { cueId: 'cue', allow: [9] });
  assert.ok(first.length > 0, '这个布局必须算得出候选，否则这条测试什么也没证明');
  assert.equal(key(first), key(second), '同一局面两次求解给出了不同的候选');

  // 默认设置不能截断：它跟「显式关掉预算」必须一模一样。
  // 少了这一条，默认值悄悄回到挂钟也照样过 —— 上面的两遍在快机器上仍然相等。
  const unbounded = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET });
  assert.equal(key(first), key(unbounded), '默认设置截断了候选，结果会跟机器速度挂钩');
});

test('组合球与翻袋：预算到点就停，所以断言非空的用例必须显式关掉预算', () => {
  const balls = bankLayout();
  // budgetMs 取负数，循环第一次检查就成立，必定一个候选都算不出来。
  const starved = solveShot(table, balls, { cueId: 'cue', allow: [9], budgetMs: -1 });
  assert.equal(starved.length, 0, '预算为负时不该再返回翻袋候选');

  // 同一个布局，关掉预算就必须算得出来 —— 这条同时证明上面那个 0 确实来自预算，
  // 而不是这个布局本来就无解。少了它，上面那条断言连「布局没有解」都拦不住。
  const full = solveShot(table, balls, { cueId: 'cue', allow: [9], ...NO_BUDGET }).filter((c) => c.kind === 'bank');
  assert.ok(full.length > 0, '关掉预算后同一布局应该算得出翻袋');
});

// 加塞（左右塞）以前根本没进过杆法池：`tip.a` 恒为 0。物理核是支持侧旋的
// （`physics.js` 的出库角按 SIDE_SPIN_EFFECT 读 wz），求解器却从不试，
// 于是「靠出库角换位置」这类球永远算不出来，卡片上永远是「中杆」。
// 下面是 `_research/probe-spin.mjs` 扫 120 个散球布局时，少数几个
// 「位置将就、加塞救得回来」的其中一个（seed 24）；坐标抄成固定值，
// 免得测试依赖随机数。
const spinLayout = () => [
  createBall('cue', 0.8643, 0.2296, { number: 0 }),
  createBall('b1', 0.5534, 0.2089, { number: 1 }),
  createBall('b2', 0.5388, 0.7334, { number: 2 }),
  createBall('b3', 1.4212, 0.655, { number: 3 }),
  createBall('b4', 1.6031, 0.3162, { number: 4 }),
  createBall('b5', 2.0527, 0.9889, { number: 5 }),
];

test('加塞：位置将就时才用，而且候选说清它管什么', () => {
  const list = solveShot(table, spinLayout(), { cueId: 'cue' });
  assert.ok(list.length > 0, '这个布局必须算得出候选，否则这条测试什么也没证明');
  const top = list[0];
  assert.ok(Math.abs(top.tip.a) > 0.05, `位置将就时首推应该带塞，实际 a=${top.tip.a}`);
  assert.match(top.tip.name, /塞/, '杆法名字必须说出用了塞');
  assert.match(top.tip.name, /出库角/, '名字要说清塞是干什么用的，否则用户不知道怎么练');
});

test('加塞：就算被选中，也只能是因为换到了更好的位置', () => {
  // 塞不会让瞄准变准（反而更差），它唯一的价值是改母球出库角。
  // 所以「带塞的方案排在中杆前面」必须伴随更高的走位分，否则就是白加。
  const list = solveShot(table, spinLayout(), { cueId: 'cue' });
  const top = list[0];
  const centerBest = list.find((c) => Math.abs(c.tip.a) <= 0.05);
  if (!centerBest) return; // 这个局面没有纯中杆解，抬塞是唯一选择
  assert.ok(
    (top.leaveScore ?? 0) >= (centerBest.leaveScore ?? 0),
    `加塞排在中杆前面，走位反而更差：塞 ${top.leaveScore} vs 中杆 ${centerBest.leaveScore}`
  );
});

test('加塞：位置本来就好的球不许无端加塞', () => {
  const balls = [
    createBall('cue', 0.5, 0.635, { number: 0 }),
    createBall('b1', 1.0, 0.635, { number: 1 }),
    createBall('b2', 2.4, 1.2, { number: 2 }),
    createBall('b3', 2.3, 0.1, { number: 3 }),
  ];
  const top = solveShot(table, balls, { cueId: 'cue' })[0];
  assert.ok(top, '简单直球必须算得出候选');
  assert.ok(Math.abs(top.tip.a) <= 0.05, `位置很好却加了塞：a=${top.tip.a}`);
});
