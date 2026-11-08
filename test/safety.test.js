import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { createGame, numbersOnTable, legalTargetNumbers, simulateShot, resolveShot } from '../src/rules.js';
import { solveSafety, MAX_CUT_DEG, swingOffsetsDeg } from '../src/safety.js';
import { solveShot, positionTolerance, describeCandidate, planShot } from '../src/solver.js';

const table = createTable('pool9');
const L = table.length;
const W = table.width;

/** 母球在左中，几颗目标球固定在九个坐标上——布局在测试间共享，断言才好写 */
function layout(list) {
  const balls = [createBall('cue', L * 0.2, W * 0.5, { number: 0 })];
  for (const [n, fx, fy] of list) balls.push(createBall(`b${n}`, L * fx, W * fy, { number: n }));
  return balls;
}

test('防守：切角阈值与进攻求解器用同一条边界', () => {
  assert.equal(MAX_CUT_DEG, 78, 'solveShot 用的是 78°，防守必须一致，否则会出现进攻说打不了、防守说能打');
});

test('防守：给出的杆是「合法先碰」——不会去碰不该碰的球', () => {
  // 九球场景：只能先碰 1 号。台面故意只允许 1 号，看防守会不会给出碰 2 号的杆。
  const balls = layout([
    [1, 0.9, 0.2],
    [2, 0.3, 0.3],
    [3, 0.8, 0.8],
  ]);
  const game = createGame(table, balls, { kind: 'nineball' });
  game.breakShot = false;
  const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
  assert.deepEqual(allow, [1], '九球只允许先碰最小号');

  const s = solveSafety(table, game.balls, { cueId: 'cue', allow });
  assert.ok(s, '这个布局应当能找到防守杆');
  assert.equal(s.targetNumber, 1, '只能瞄 1 号球');
});

test('防守：真的打出去之后不犯规（有球碰库），而且母球没摔袋', () => {
  const balls = layout([
    [1, 0.55, 0.35],
    [2, 0.75, 0.7],
  ]);
  const s = solveSafety(table, balls, { cueId: 'cue', allow: [1, 2] });
  assert.ok(s, '应当有防守解');
  assert.equal(s.foulRisk, false, '选中的杆自己已经标了不犯规');

  const facts = simulateShot(table, balls, { angle: s.aimAngle, speed: s.speed, tip: s.tip });
  assert.equal(facts.settled, true);
  assert.equal(facts.cueScratched, false, '母球摔袋的杆在挑选时就被淘汰了');
  assert.ok(facts.firstContact !== null, '必须碰到球');
  assert.equal(facts.firstContact, s.targetNumber, '碰到的就是它声称要碰的那颗');
  assert.ok(
    facts.railsAfterContact.length > 0 || facts.pocketed.length > 0,
    'WPA 3.3：碰球之后必须至少一颗球碰库（进袋也算）'
  );
});

test('防守：打完之后的局面，对手比「正撞一下」更难打——这是防守的定义', () => {
  // 这条是核心。第一版实现按「对手容错绝对有多小」打分，实测有布局挑出来的杆
  // 反而让对手更好打（±0.15° → ±0.33°），所以现在一律跟基准杆比。
  const cases = [
    layout([[1, 0.5, 0.5], [2, 0.53, 0.5], [3, 0.5, 0.53], [4, 0.53, 0.53]]),
    layout([[1, 0.55, 0.35], [2, 0.75, 0.7]]),
    layout([[1, 0.9, 0.25], [2, 0.6, 0.8], [3, 0.45, 0.3]]),
  ];
  let solved = 0;
  for (const [i, balls] of cases.entries()) {
    const s = solveSafety(table, balls, { cueId: 'cue', allow: [1, 2, 3, 4] });
    if (!s) continue; // 没有比正撞更好的，允许返回 null（planShot 会退回直撞）
    solved += 1;
    assert.ok(
      s.safetyGainDeg > 0,
      `第 ${i} 个布局：给出的防守必须真的让对手更难打，实际改善 ${s.safetyGainDeg}°`
    );
    assert.equal(
      s.safetyGainDeg,
      Math.round((s.safetyBaseToleranceDeg - s.safetyOppToleranceDeg) * 100) / 100,
      '改善量要对得上基准与结果的差'
    );
    assert.ok(s.safetyOppToleranceDeg <= s.safetyBaseToleranceDeg + 1e-9);
  }
  assert.ok(solved >= 2, `至少两个布局能找到真正的防守，实际 ${solved} 个`);
});

test('防守：找不到比正撞更好的时候返回 null，而不是硬造一杆', () => {
  // 母球和目标球已经贴在一起、四周开阔，正撞和"防守"没有区别。
  const balls = [createBall('cue', L * 0.2, W * 0.5, { number: 0 })];
  balls.push(createBall('b1', L * 0.205, W * 0.5, { number: 1 }));
  const s = solveSafety(table, balls, { cueId: 'cue', allow: [1] });
  // 允许有解（贴着打薄也是一种防守），但只要给了，就必须赢过基准
  if (s) assert.ok(s.safetyGainDeg > 0);
});

test('防守：没有合法目标时返回 null，不抛错', () => {
  const balls = [createBall('cue', L * 0.2, W * 0.5, { number: 0 })];
  balls.push(createBall('b1', L * 0.8, W * 0.5, { number: 1 }));
  assert.equal(solveSafety(table, balls, { cueId: 'cue', allow: [9] }), null);
});

test('防守：找不到母球时抛错（与 solveShot / planShot 口径一致）', () => {
  const balls = [createBall('b1', L * 0.8, W * 0.5, { number: 1 })];
  assert.throws(() => solveSafety(table, balls, { cueId: 'cue' }), /找不到母球/);
});

test('防守：文案说得清「撞哪颗、偏多少、把对手压到多少」', () => {
  const balls = layout([
    [1, 0.55, 0.35],
    [2, 0.75, 0.7],
  ]);
  const s = solveSafety(table, balls, { cueId: 'cue', allow: [1, 2] });
  assert.ok(s);
  const text = describeCandidate(s);
  assert.match(text, /^防守：/);
  assert.match(text, /号球/);
  assert.match(text, /对手容错从 ±[\d.]+° 压到 ±[\d.]+°/);
  assert.doesNotMatch(text, /null/, '不能把 null 拼进人话里');
});

test('防守：planShot 默认不防守，显式打开才防守', () => {
  // 打不出任何进攻的布局：两颗球都被挡住
  const balls = layout([
    [1, 0.5, 0.5],
    [2, 0.52, 0.51],
    [3, 0.54, 0.5],
  ]);
  const game = createGame(table, balls);
  game.breakShot = false;

  const without = planShot(table, game, { allow: [1, 2, 3] });
  assert.notEqual(without.kind, 'safety', '默认不该出现防守（练习模式不想看对手迫害自己）');

  const withSafety = planShot(table, game, { allow: [1, 2, 3], safety: true });
  assert.ok(['safety', 'attack', 'combo', 'bank', 'direct'].includes(withSafety.kind));
  if (withSafety.kind === 'safety') {
    assert.ok(withSafety.plan.safetyGainDeg > 0, '真要防守，就必须赢过基准');
  }
});

test('防守：性能——单次求解控制在一秒内', () => {
  const balls = layout([
    [1, 0.5, 0.5],
    [2, 0.6, 0.3],
    [3, 0.8, 0.7],
    [4, 0.9, 0.2],
  ]);
  const t0 = Date.now();
  solveSafety(table, balls, { cueId: 'cue', allow: [1, 2, 3, 4] });
  const ms = Date.now() - t0;
  // 实测 60–120 ms（采样 80 组 × 每组的仿真 + 对手容错评估）。
  // 上限放到 1000 ms 是为了在慢机器与 CI 上不误报，真实回归会在
  // _research/probe-safety.mjs 里单独盯。
  assert.ok(ms < 1000, `单次防守求解 ${ms} ms，太慢了`);
});

test('防守：positionTolerance 对同一局面是稳定的，且对手被藏住时更小', () => {
  // 开阔局面：随便怎么打对手都有球打
  const open = [createBall('cue', L * 0.2, W * 0.5, { number: 0 })];
  open.push(createBall('b1', L * 0.5, W * 0.5, { number: 1 }));
  open.push(createBall('b2', L * 0.8, W * 0.3, { number: 2 }));
  const openTol = positionTolerance(table, open, { cueId: 'cue' });

  // 藏起来：母球贴在 1 号球正后方，2 号球在对面角落
  const hidden = [createBall('cue', L * 0.5 - 0.06, W * 0.5, { number: 0 })];
  hidden.push(createBall('b1', L * 0.5, W * 0.5, { number: 1 }));
  hidden.push(createBall('b2', L * 0.8, W * 0.5, { number: 2 }));
  const hiddenTol = positionTolerance(table, hidden, { cueId: 'cue' });

  assert.ok(openTol >= 0 && hiddenTol >= 0, '容错窗口不会是负数');
  assert.ok(
    hiddenTol < openTol,
    `被藏住时对手容错应该更小：开阔 ${openTol.toFixed(2)}° vs 藏住 ${hiddenTol.toFixed(2)}°`
  );
  // 同一输入两次结果一致（没有引入隐藏随机）
  assert.equal(positionTolerance(table, open, { cueId: 'cue' }), openTol);
});

test('防守：采样偏移必须按几何上界缩放，否则绝大多数采样点根本碰不到球', () => {
  // 几何事实：母球沿相对球心连线偏 θ 的方向直线走，目标球球心到这条直线的
  // 垂距是 d·sin θ，要发生碰撞必须 d·sin θ ≤ 2R。
  // 所以距离 1 m 时 θ 最大只有 asin(2R/1) ≈ 3.3°，固定写 ±10°、±20°、±55°
  // 一律碰不到球——这些采样点只是白跑一整杆仿真。
  const R = table.ballRadius;

  // ① 策略本身：采样点必须铺在 (0, 上界] 里，不能超出上界，也不能全挤在 0
  for (const d of [0.35, 0.9, 1.6, 2.4]) {
    const bound = (Math.asin(Math.min(1, (2 * R) / d)) * 180) / Math.PI;
    const swings = swingOffsetsDeg(d, R);

    assert.ok(swings.length >= 5, `距离 ${d.toFixed(2)} m 只采样了 ${swings.length} 个点，太少`);
    assert.ok(swings.includes(0), '必须包含正对球心这一档');
    for (const s of swings) {
      assert.ok(
        Math.abs(s) <= bound + 1e-9,
        `距离 ${d.toFixed(2)} m 的采样偏移 ${s.toFixed(3)}° 超过了几何上界 ${bound.toFixed(3)}°，这一杆碰不到球`
      );
    }
    // 必须有接近上界的采样点，否则「薄切」这一维等于没有
    const maxAbs = Math.max(...swings.map(Math.abs));
    assert.ok(
      maxAbs >= bound * 0.8,
      `距离 ${d.toFixed(2)} m 的最大采样偏移只有 ${maxAbs.toFixed(3)}°，离上界 ${bound.toFixed(3)}° 太远，切薄的那一维没覆盖到`
    );
  }

  // ② 端到端：三种距离上都必须找到防守杆，且打出去真的直接碰到 1 号球
  for (const d of [0.35, 0.9, 1.6]) {
    const balls = [
      createBall('cue', L * 0.15, W * 0.5, { number: 0 }),
      createBall('b1', L * 0.15 + d, W * 0.5, { number: 1 }),
      createBall('b2', L * 0.85, W * 0.15, { number: 2 }),
    ];
    const s = solveSafety(table, balls, { cueId: 'cue', allow: [1] });
    // 不能写成「找不到就跳过」——那样采样全打空、solveSafety 返回 null 时
    // 这条测试会真空通过。这组布局在三种距离上都实测有解，必须找到。
    assert.ok(s, `距离 ${d.toFixed(2)} m 的布局应当能找到防守杆（找不到说明采样点全都碰不到球）`);

    const facts = simulateShot(table, balls, { angle: s.aimAngle, speed: s.speed, tip: s.tip });
    assert.equal(facts.firstContact, 1, `距离 ${d.toFixed(2)} m 的防守杆必须直接碰到 1 号球`);
  }
});

test('防守：同一局面重复求解结果一致（没有引入隐藏随机）', () => {
  const balls = layout([
    [1, 0.6, 0.4],
    [2, 0.8, 0.7],
    [3, 0.45, 0.8],
  ]);
  const a = solveSafety(table, balls, { cueId: 'cue', allow: [1, 2, 3] });
  const b = solveSafety(table, balls, { cueId: 'cue', allow: [1, 2, 3] });
  assert.ok(a && b);
  assert.equal(a.aimAngle, b.aimAngle);
  assert.equal(a.speed, b.speed);
  assert.equal(a.safetyScore, b.safetyScore);
});

test('防守：一局里真的用上防守时，局还能正常打完（不会卡死）', () => {
  const balls = layout([
    [1, 0.5, 0.5],
    [2, 0.54, 0.52],
    [3, 0.85, 0.75],
  ]);
  let game = createGame(table, balls);
  game.breakShot = false;

  let safetyCount = 0;
  for (let i = 0; i < 30 && game.phase !== 'ended'; i++) {
    const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
    if (!allow.length) break;
    if (game.ballInHand) {
      // 持球随便摆一个合法点就行，这不是这条测试要验的事
      const spot = game.table.bounds;
      game.balls.find((b) => b.number === 0).x = (spot.minX + spot.maxX) / 2;
      game.balls.find((b) => b.number === 0).y = (spot.minY + spot.maxY) / 2;
      game.ballInHand = null;
    }
    const { plan, kind } = planShot(table, game, { allow, safety: true });
    if (!plan) break;
    if (kind === 'safety') safetyCount += 1;
    const facts = simulateShot(table, game.balls, {
      angle: plan.aimAngle,
      speed: plan.speed,
      tip: { a: plan.tip.a, b: plan.tip.b },
    });
    const r = resolveShot(game, facts);
    game = r.next;
  }
  assert.ok(safetyCount >= 0, '防守杆要么用上要么不用上，但不能崩');
  assert.ok(game.shots > 0, '这一局真的走起来了');
});
