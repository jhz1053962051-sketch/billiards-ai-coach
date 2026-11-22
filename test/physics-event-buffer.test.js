// findFirstEvent 的复用缓冲（2026-11 性能改造）等价性守护。
//
// 改造把「每子步 new 一个 moving 数组 + 命中时 new 一个 best 对象」换成调用方传入的
// 单一复用缓冲，另外加了一条库边剪枝上界（球离四面壁都远过这一子步能走的距离时，
// 跳过 6 次库边 TOI）。这两处都属于「不改语义的纯优化」，但它们的正确性完全依赖
// 两个容易读错的细节：
//   1. 缓冲复用不能残留上一次调用的状态（count 前缀 + 尾部 length 截断）；
//   2. tie-break 不能变：同一时刻库边优先于球球，同样早的库边取先枚举到的那个。
//
// 所以这里对着**旧实现的逐字复刻**做比对：同一 world 状态、同一 horizon，两个实现
// 必须给出同一个结论——空事件，或者同一个 kind / 同一个 t（Object.is，逐位相同）/
// 同一对球或同一条库边。采样点是真实一杆里的每一个子步状态，覆盖打滑段、滚动段、
// 库边反弹后、球球碰撞后这些片段；每个状态还额外用 0.5s 的大 horizon 再比一次，
// 让「多个候选事件竞争」的分支（含库边剪枝的两侧）也被走到。
//
// 旧实现里用到的 cushionTOI / ballTOI 因此从 physics.js 导出了（见那边的注释）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import {
  createBall,
  createWorld,
  strike,
  runShot,
  findFirstEvent,
  cushionTOI,
  ballTOI,
  pruneHitCount,
  resetPruneHitCount,
} from '../src/physics.js';

const table = createTable('pool9');
const DT = 1 / 120;

/** 旧实现的逐字复刻：每子步自己 new 一个移动球数组和一个 best 对象。 */
function findFirstEventLegacy(world, horizon) {
  const balls = world.balls;
  const cushions = world.table.cushions;
  const moving = [];
  for (const b of balls) {
    if (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) moving.push(b);
  }
  if (moving.length === 0) return null;

  const best = { t: Infinity, kind: null, ball: null, cushion: null, a: null, b: null };
  for (const b of moving) {
    for (const c of cushions) {
      const t = cushionTOI(b, c, horizon);
      if (t < 0) continue;
      if (t >= best.t) continue;
      const along = c.axis === 'x' ? b.y + b.vy * t : b.x + b.vx * t;
      if (along < c.from - 1e-9 || along > c.to + 1e-9) continue;
      best.t = t;
      best.kind = 'cushion';
      best.ball = b;
      best.cushion = c;
    }
  }
  for (const a of moving) {
    for (const b of balls) {
      if (b === a || b.pocketed) continue;
      const t = ballTOI(a, b, horizon);
      if (t >= 0 && t < best.t) {
        best.t = t;
        best.kind = 'ball';
        best.a = a;
        best.b = b;
      }
    }
  }
  return best.kind === null ? null : best;
}

/** 把两个实现压成同一个可比较形状，免得比 Object 引用。 */
function signature(ev) {
  if (!ev) return null;
  return ev.kind === 'cushion'
    ? `cushion|${ev.t}|${ev.ball.id}|${ev.cushion.id ?? ev.cushion.axis}`
    : `ball|${ev.t}|${ev.a.id}|${ev.b.id}`;
}

// 与 test/solver-prune.test.js 的冻结局面同一批坐标（那边钉的是选球，这边钉的是物理事件）。
const LAYOUTS = [
  { id: 'd05-three', rows: [[0, 0.45, 0.9], [1, 1.35, 0.55], [2, 2.0, 1.05]] },
  {
    id: 'g5-0',
    rows: [[0, 1.5903, 1.1656], [1, 1.0927, 0.4764], [2, 1.2959, 0.7031], [3, 1.6082, 0.6738], [4, 0.5832, 0.5105]],
  },
];

// 一杆只能覆盖一种走位，所以按「角度 × 力度 × 杆法」铺几枪：有的先撞球、有的先撞库、
// 有的直接钻进袋口缺口（那种局面下两个实现都该返回 null，也是要比的）。
const SHOTS = [
  { angle: -0.37, speed: 2.2, tip: { a: 0, b: 0 } },
  { angle: 0.4, speed: 1.6, tip: { a: 0.35, b: 0.12 } },
  { angle: 1.9, speed: 2.8, tip: { a: 0.3, b: 0.2 } },
  { angle: 2.9, speed: 1.1, tip: { a: -0.2, b: 0 } },
  { angle: 4.2, speed: 3.0, tip: { a: -0.4, b: 0.35 } },
];

function makeBalls(rows) {
  return rows.map(([n, x, y]) => createBall(n === 0 ? 'cue' : `b${n}`, x, y, { number: n }));
}

/**
 * 跑若干杆，在每个子步结束后用同一个 world 状态比对两个实现。
 * 返回各类命中的计数，用来断言测试没有退化成「永远是 null」。
 */
function compareOverShots(rows, shots) {
  const stats = { shots: 0, steps: 0, atDt: 0, atLong: 0, cushions: 0, balls: 0 };

  const check = (world, horizon) => {
    const legacy = findFirstEventLegacy(world, horizon);
    // 复用默认的模块级缓冲：连续调用之间没有任何清理机会，正好检验不残留。
    const reused = findFirstEvent(world, horizon);
    assert.equal(
      signature(reused),
      signature(legacy),
      `horizon=${horizon} 时复用缓冲与旧实现不一致`
    );
    return legacy;
  };

  for (const shot of shots) {
    const world = createWorld(table, makeBalls(rows));
    const cue = world.balls.find((b) => b.id === 'cue');
    strike(cue, shot);
    stats.shots++;

    runShot(world, {
      dt: DT,
      onStep: (w) => {
        assert.equal(w, world);
        stats.steps++;
        check(world, DT);
        const legacy = check(world, 0.5);
        if (legacy) {
          stats.atLong++;
          if (legacy.kind === 'cushion') stats.cushions++;
          else stats.balls++;
        }
        if (findFirstEventLegacy(world, DT)) stats.atDt++;
      },
    });
  }

  return stats;
}

for (const layout of LAYOUTS) {
  test(`findFirstEvent：复用缓冲与逐子步新建的旧实现逐位等价（${layout.id}）`, () => {
    const stats = compareOverShots(layout.rows, SHOTS);

    // 采样密度：几杆加起来至少上千个子步；两类事件都要真的出现过，否则这个比对等于没比。
    assert.ok(stats.steps > 1000, `${layout.id}：子步数太少（${stats.steps}），采样不成立`);
    assert.ok(stats.atLong > 0, `${layout.id}：0.5s horizon 下没有任何事件，比对退化`);
    assert.ok(stats.cushions > 0, `${layout.id}：一次库边事件都没比到`);
    assert.ok(stats.balls > 0, `${layout.id}：一次球球事件都没比到`);
    assert.ok(stats.atDt > 0, `${layout.id}：1/120 子步内一次事件都没比到`);
  });
}

test('findFirstEvent：缓冲复用不残留上一次调用的命中（连续调用交替清空）', () => {
  // 先用一个真会命中的状态把缓冲填满，再立刻用「全部静止」的状态去问。
  // 旧写法每次 new，天然干净；复用缓冲若忘了重置 hasBest，这里就会把上一杆的事件交出来。
  const world = createWorld(table, makeBalls([[0, 0.635, 0.635], [1, 1.905, 0.635]]));
  const cue = world.balls.find((b) => b.id === 'cue');
  strike(cue, { angle: -Math.PI / 2, speed: 2, tip: { a: 0, b: 0 } });

  const hit = findFirstEvent(world, 1);
  assert.ok(hit, '垂直朝下打在 1s 内必然撞到底库');
  assert.equal(hit.kind, 'cushion');

  for (const b of world.balls) {
    b.vx = 0;
    b.vy = 0;
  }
  assert.equal(findFirstEvent(world, 1), null, '全部静止时必须返回 null');
  assert.equal(findFirstEvent(world, 1), null, '连问两次也必须都是 null');
});

// ── 剪枝「真的被触发」断言 ─────────────────────────────────────────────
//
// 上面那批等价性用例只能证明「剪枝没有改变结果」，证明不了「剪枝真的发生了」：
// 剪枝失效时 findFirstEvent 退化成逐条扫 6 条库边的旧实现，结果逐位相同，所有等价性
// 断言照样全绿——于是这个优化可以在没人发现的情况下一路失效，直到某天有人去量耗时。
// 这里用 physics.js 的 pruneHitCount / resetPruneHitCount（模块级整数，剪枝分支每跳过
// 一条球的一次库边扫描就 +1）把「剪枝发生过」变成可断言的量，并配一个反向用例，
// 防止有人为了让正向用例更「稳定」而把条件放宽成无脑跳过库边扫描。

test('库边剪枝：球离四壁都很远时，剪枝真的跳过了这一子步的库边 TOI', () => {
  const R = table.ballRadius;
  // 台面正中，朝右下走：到四面壁都还有一个半径以上的余量。
  const world = createWorld(table, [
    createBall('cue', table.length / 2, table.width / 2, { number: 0 }),
  ]);
  const b = world.balls[0];
  b.vx = 2;
  b.vy = 1;

  // 先把「这一子步到不了任何一面壁」写成断言：台面尺寸或步长一变，前提会在这里先红，
  // 而不是等到下面那句剪枝断言给出一个看不懂的失败。
  const dx = Math.abs(b.vx) * DT;
  const dy = Math.abs(b.vy) * DT;
  assert.ok(b.x - R > dx && table.length - R - b.x > dx, '前提不成立：球沿 x 方向并不远离两壁');
  assert.ok(b.y - R > dy && table.width - R - b.y > dy, '前提不成立：球沿 y 方向并不远离两壁');

  resetPruneHitCount();
  assert.equal(findFirstEvent(world, DT), null, '离四壁都很远，这一子步不该有任何事件');
  assert.equal(pruneHitCount(), 1, '剪枝必须触发：这一子步 6 次库边 TOI 应当被整段跳过');
});

test('库边剪枝：球贴着库边时不得剪枝（不是无脑跳过）', () => {
  const R = table.ballRadius;
  const y = table.width / 2; // 避开左库两端角袋与中袋缺口的中间位置

  // 情形一：球心贴库一个极小间隙，朝库走 —— 这一子步内必然撞库。
  const near = createWorld(table, [createBall('cue', R + 1e-3, y, { number: 0 })]);
  const b1 = near.balls[0];
  b1.vx = -0.5;

  resetPruneHitCount();
  const hit = findFirstEvent(near, DT);
  assert.equal(pruneHitCount(), 0, '球离库只有 1 mm 时剪枝不该触发');
  assert.ok(hit, '贴库朝库走的球在 1/120 s 内必然撞库');
  assert.equal(hit.kind, 'cushion');
  assert.equal(hit.cushion.id, 'rail-l');

  // 情形二：球心正好压在接触位置上（gap === 0，TOI 直接是 0）—— 同样不许剪。
  const touching = createWorld(table, [createBall('cue', R, y, { number: 0 })]);
  const b2 = touching.balls[0];
  b2.vx = -0.5;

  resetPruneHitCount();
  const hit2 = findFirstEvent(touching, DT);
  assert.equal(pruneHitCount(), 0, '球心压在库面上（TOI=0）时剪枝不该触发');
  assert.ok(hit2, '已经接触库面且仍在靠近时必须有库边事件');
  assert.equal(hit2.kind, 'cushion');
  assert.equal(hit2.t, 0, '已接触且仍靠近，TOI 应当是 0');
});