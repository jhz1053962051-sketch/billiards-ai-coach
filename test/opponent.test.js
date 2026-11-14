// 对手模块测试：对手用的必须是和玩家完全一样的那套求解与物理，
// 所以这里既测"能不能自己走完一局"，也测"不许偷改规则"。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall, createWorld } from '../src/physics.js';
import { createStandardRack, ballStyle } from '../src/rack.js';
import { createGame, numbersOnTable, headStringX, placeCueBall, legalTargetNumbers } from '../src/rules.js';
import { planShot } from '../src/solver.js';
import { takeTurn, pickCueSpot, choosePlan } from '../src/opponent.js';

const table = createTable('pool9');

function newGame(seed = 1) {
  const balls = createStandardRack(table, { seed }).map((b) => createBall(b.id, b.x, b.y, b));
  createWorld(table, balls);
  return createGame(table, balls, { names: ['A', 'B'] });
}

function simpleGame() {
  const balls = [
    createBall('cue', 0.6, 0.6, { number: 0, ...ballStyle(0) }),
    createBall('b1', 1.9, 0.65, { number: 1, ...ballStyle(1) }),
    createBall('b9', 1.2, 1.0, { number: 9, ...ballStyle(9) }),
  ];
  createWorld(table, balls);
  const g = createGame(table, balls);
  g.breakShot = false;
  return g;
}

// ------------------------------------------------------------------ takeTurn

test('对手：能替当前一方走一杆，并给出可读的结算', () => {
  const g = newGame(3);
  const r = takeTurn(table, g, { record: true, dt: 1 / 120 });

  assert.equal(r.ok, true, `应该能出杆，实际 ${r.reason ?? ''}`);
  assert.equal(r.kind, 'break');
  assert.ok(r.plan && Number.isFinite(r.plan.aimAngle));
  assert.ok(r.facts.settled, '这一杆必须停稳');
  assert.ok(Array.isArray(r.facts.frames) && r.facts.frames.length > 1, 'record 打开时要逐帧记录');
  assert.equal(r.next.shots, 1, '杆数要推进');
  assert.equal(r.next.breakShot, false, '开球状态一杆后结束');
  assert.ok(typeof r.report.summary === 'string' && r.report.summary.length > 0);
});

test('对手：不改入参，动画期间旧局面仍然可用', () => {
  const g = newGame(7);
  const before = {
    shots: g.shots,
    turn: g.turn,
    breakShot: g.breakShot,
    logLength: g.log.length,
    balls: g.balls.map((b) => ({ x: b.x, y: b.y, pocketed: b.pocketed })),
  };
  const r = takeTurn(table, g);

  assert.equal(g.shots, before.shots, '原局面杆数不能被改');
  assert.equal(g.turn, before.turn, '原局面轮次不能被改');
  assert.equal(g.breakShot, before.breakShot);
  assert.equal(g.log.length, before.logLength);
  for (const [i, b] of g.balls.entries()) {
    assert.equal(b.x, before.balls[i].x, `${b.id} 位置被改了`);
    assert.equal(b.y, before.balls[i].y, `${b.id} 位置被改了`);
    assert.equal(b.pocketed, before.balls[i].pocketed);
  }
  assert.notEqual(r.next, g, '返回的必须是新对象');
});

test('对手：局已经结束时不给出杆', () => {
  const g = simpleGame();
  g.phase = 'ended';
  const r = takeTurn(table, g);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ended');
  assert.equal(r.facts, null);
});

test('对手：需要重摆时不偷偷开球', () => {
  const g = simpleGame();
  g.requiresRerack = true;
  const r = takeTurn(table, g);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs_rerack');
});

test('对手：持球时自己把母球摆上台面，并清掉持球状态', () => {
  const g = simpleGame();
  g.ballInHand = { zone: 'anywhere' };
  const cue = g.balls.find((b) => b.number === 0);
  cue.pocketed = true;
  cue.pocket = 'c-br';

  const r = takeTurn(table, g);
  assert.equal(r.ok, true, `持球也应该能出杆，实际 ${r.reason ?? ''}`);
  assert.equal(r.cuePlaced, true);
  assert.equal(r.next.ballInHand, null, '摆完之后持球状态要清掉');
  // 摆位要看 cueSpot：next.balls 是打完之后的球位，母球早就被撞走了
  assert.ok(r.cueSpot, '要回报母球实际落点');
  assert.ok(table.insideBounds(r.cueSpot.x, r.cueSpot.y), '母球要落在台内');
});

test('对手：持球在开球线后时，摆位不会越过开球线', () => {
  const g = simpleGame();
  g.ballInHand = { zone: 'kitchen' };
  const r = takeTurn(table, g);
  assert.equal(r.ok, true, `应该能出杆，实际 ${r.reason ?? ''}`);
  assert.ok(r.cueSpot, '要回报母球实际落点');
  assert.ok(
    r.cueSpot.x <= headStringX(table) + 1e-9,
    `母球摆在 x=${r.cueSpot.x}，越过了开球线 ${headStringX(table)}`
  );
});

test('开球线后持球摆位：请求点贴着球堆时也不会被挤到线那边', () => {
  // 把一颗球压在开球线正后方、请求点就在它身上，逼 findFreeSpot 螺旋外扩——
  // 外扩一旦不检查 zone 就会跑到线前面去，这正是之前漏掉的那条路径。
  const g = simpleGame();
  g.ballInHand = { zone: 'kitchen' };
  const blocker = g.balls.find((b) => b.number === 9);
  blocker.x = headStringX(table) - 0.01;
  blocker.y = 0.35;
  assert.equal(placeCueBall(g, blocker.x, blocker.y), true, '线后还有大片空地，应该能摆下');
  const cue = g.balls.find((b) => b.number === 0);
  assert.ok(cue.x <= headStringX(table) + 1e-9, `母球被挤到 x=${cue.x}，越线了`);
  assert.ok(table.insideBounds(cue.x, cue.y));
  assert.ok(
    Math.hypot(cue.x - blocker.x, cue.y - blocker.y) >= 2 * table.ballRadius - 1e-6,
    '不能压在别的球上'
  );
});

// ------------------------------------------------------------------ pickCueSpot

test('摆母球：挑的位置不与任何球重叠', () => {
  const g = newGame(5);
  g.ballInHand = { zone: 'anywhere' };
  const spot = pickCueSpot(g);
  assert.ok(spot, '应该能找到空位');
  const R = table.ballRadius;
  for (const b of g.balls) {
    if (b.number === 0 || b.pocketed) continue;
    const d = Math.hypot(b.x - spot.x, b.y - spot.y);
    assert.ok(d >= 2 * R, `离 ${b.number} 号球只有 ${d.toFixed(4)} m，小于直径`);
  }
});

test('摆母球：挑的是离球堆最远的那块空地，不是最近的一块', () => {
  const g = newGame(9);
  g.ballInHand = { zone: 'anywhere' };
  const spot = pickCueSpot(g);
  let clear = Infinity;
  for (const b of g.balls) {
    if (b.number === 0 || b.pocketed) continue;
    clear = Math.min(clear, Math.hypot(b.x - spot.x, b.y - spot.y));
  }
  // 15 颗球挤在脚端三角区，头端必然有一大片空地，最近球距应远超直径
  assert.ok(clear > 4 * table.ballRadius, `离最近球只有 ${clear.toFixed(3)} m，看起来是随手找的空位`);
});

test('摆母球：开球线后持球时只在合法区内找', () => {
  const g = newGame(2);
  g.ballInHand = { zone: 'kitchen' };
  const spot = pickCueSpot(g);
  assert.ok(spot);
  assert.ok(spot.x <= headStringX(table) + 1e-9, `x=${spot.x} 越线`);
  assert.ok(table.insideBounds(spot.x, spot.y));
});

test('摆母球：台面塞满时返回 null 而不是硬塞', () => {
  const g = simpleGame();
  // 用一堆球把整张台面铺满，让网格采样一个都过不了直径检查
  const balls = [createBall('cue', 0.3, 0.3, { number: 0 })];
  const R = table.ballRadius;
  let n = 1;
  for (let x = R; x < table.length; x += 2 * R) {
    for (let y = R; y < table.width; y += 2 * R) {
      balls.push(createBall('f' + n++, x, y, { number: 1 }));
    }
  }
  createWorld(table, balls);
  const full = createGame(table, balls);
  full.ballInHand = { zone: 'anywhere' };
  assert.equal(pickCueSpot(full), null);
});

// ------------------------------------------------------------------ 整局闭环

test('对手：自己跟自己打完一整局，能分出胜负', () => {
  for (const seed of [1, 7, 42]) {
    let g = newGame(seed);
    let shots = 0;
    while (g.phase !== 'ended' && shots < 200) {
      const r = takeTurn(table, g);
      if (!r.ok) {
        // 唯一允许的中断是需要重摆：按规则重摆后继续
        if (r.reason === 'needs_rerack') {
          const fresh = createStandardRack(table, { seed: seed + 100 }).map((b) =>
            createBall(b.id, b.x, b.y, b)
          );
          createWorld(table, fresh);
          g.balls = fresh;
          g.requiresRerack = false;
          g.turn = 1 - g.turn;
          g.breakShot = true;
          g.open = true;
          continue;
        }
        assert.fail(`seed ${seed} 第 ${shots + 1} 杆无法出杆：${r.reason}`);
      }
      assert.equal(r.facts.settled, true, `seed ${seed} 第 ${shots + 1} 杆没停稳`);
      g = r.next;
      shots += 1;
    }
    assert.equal(g.phase, 'ended', `seed ${seed} 打完 ${shots} 杆仍未结束`);
    assert.ok(g.winner === 0 || g.winner === 1, `seed ${seed} 胜者异常：${g.winner}`);
    assert.equal(g.log.length, shots, '日志条数应等于杆数');
    assert.ok(shots >= 4 && shots <= 60, `seed ${seed} 用了 ${shots} 杆，超出合理区间`);
    // 终局时台面上不该还有本组的球（赢家必须是清完才进 8 号）
    const rest = numbersOnTable(g.balls);
    assert.ok(!rest.includes(8), `seed ${seed} 局结束时 8 号球还在台上`);
  }
});

// ---------------------------------------------------------------- 两步选杆

// 固定布局（探针 seed 3）：求解器首选 5 号进 c-tl（单杆价值 7.2，最简单），
// 但打完对方还剩 76.3 的易打程度；两步选杆改打 2 号进 m-t（价值 11.5，稍难一点），
// 打完之后对方只剩 63.7。两个方案都真的能进——换的是"给对方留什么"，不是"放不放弃进球"。
function lookaheadGame() {
  const spec = [
    { n: 0, x: 0.697, y: 0.687 },
    { n: 1, x: 2.085, y: 0.922 },
    { n: 2, x: 1.016, y: 1.011 },
    { n: 3, x: 1.568, y: 0.52 },
    { n: 4, x: 0.254, y: 0.897 },
    { n: 5, x: 0.524, y: 0.936 },
  ];
  const balls = spec.map((s) =>
    createBall(s.n === 0 ? 'cue' : `b${s.n}`, s.x, s.y, { number: s.n, ...ballStyle(s.n) })
  );
  createWorld(table, balls);
  const g = createGame(table, balls, { kind: 'eightball', names: ['我', '对手'] });
  g.breakShot = false;
  return g;
}

test('两步：为了把对方藏起来，可以换一个"稍难但打完之后更难打"的球', () => {
  const g = lookaheadGame();
  const allow = legalTargetNumbers(g, numbersOnTable(g.balls));
  const base = planShot(table, g, { allow });
  const look = choosePlan(table, g, { allow });

  assert.ok(base.plan && look.plan);
  assert.notEqual(
    `${base.plan.targetNumber}@${base.plan.pocketId}`,
    `${look.plan.targetNumber}@${look.plan.pocketId}`,
    '这个布局就是用来证明两步会改主意的，两个方案一样说明这条测试失效了'
  );

  const easeOf = (scores, plan) =>
    scores.find((s) => s.targetNumber === plan.targetNumber && s.pocketId === plan.pocketId)?.opponentEase;
  const easePlain = easeOf(look.scores, base.plan);
  const easeLook = easeOf(look.scores, look.plan);
  assert.ok(easeLook < easePlain, `换完应该更难打：原 ${easePlain} → 新 ${easeLook}`);

  // 换掉的球必须还进得去：不能靠"这一杆本来就要丢"来换对方难打
  const chosen = look.scores.find(
    (s) => s.targetNumber === look.plan.targetNumber && s.pocketId === look.plan.pocketId
  );
  assert.equal(chosen.potted, true, '被选中的方案必须真的能进');
  assert.equal(chosen.fouled, false, '被选中的方案不许犯规');
});

test('两步：结果可复现，不看运气', () => {
  const g = lookaheadGame();
  const allow = legalTargetNumbers(g, numbersOnTable(g.balls));
  const a = choosePlan(table, g, { allow });
  const b = choosePlan(table, g, { allow });
  assert.deepEqual(a.scores, b.scores, '同一个局面两次选杆的打分必须一致');
  assert.equal(a.plan.targetNumber, b.plan.targetNumber);
  assert.equal(a.plan.pocketId, b.plan.pocketId);
});

test('两步：开球不参与，直接按求解器给的开球方案来', () => {
  const g = newGame(1);
  assert.equal(g.breakShot, true);
  const r = takeTurn(table, g, {});
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'break');
  assert.deepEqual(r.scores, [], '开球没有"对方上手"这一步，不该有多余打分');
});

test('两步：只看前 N 个候选，N 越少越省时间但可能选不到最好的', () => {
  const g = lookaheadGame();
  const allow = legalTargetNumbers(g, numbersOnTable(g.balls));
  const one = choosePlan(table, g, { allow, lookahead: 1 });
  assert.equal(one.scores.length, 1, 'lookahead:1 只评一个候选');
  assert.ok(one.plan, '只评一个候选也得给出方案');
});
