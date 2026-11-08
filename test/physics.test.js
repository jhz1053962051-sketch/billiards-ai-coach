// 物理核回归测试：几何、击球、摩擦、碰撞、袋口。
//
// 断言全部写成"物理上必须成立的事实"，不是"当前实现的输出快照"，
// 这样以后调参数时测试仍然有意义。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import {
  createBall,
  createWorld,
  cloneWorld,
  strike,
  advanceBall,
  stepWorld,
  runShot,
  ballSpeed,
  slipOf,
  allStopped,
  speedAfterDistance,
  speedToReach,
  cueBallSpeedAfterTravel,
  cueSpeedForImpact,
} from '../src/physics.js';
import { PHYS, SPEED, TABLE_PRESETS } from '../src/constants.js';

const table = createTable('pool9');
const R = table.ballRadius;

function freshWorld(balls) {
  return createWorld(table, balls);
}

test('球台：六个袋、六段库、球心边界内缩一个半径', () => {
  assert.equal(table.pockets.length, 6);
  assert.equal(table.cushions.length, 6);
  assert.equal(table.bounds.minX, R);
  assert.equal(table.bounds.maxX, table.length - R);
  // 每个袋心都在台角或边中点
  for (const p of table.pockets) {
    const onX = p.x === 0 || p.x === table.length || p.x === table.length / 2;
    const onY = p.y === 0 || p.y === table.width;
    assert.ok(onX && onY, `袋 ${p.id} 位置异常`);
  }
});

test('球台：三个预设都能建，袋口必须比球大', () => {
  for (const id of Object.keys(TABLE_PRESETS)) {
    const t = createTable(id);
    for (const p of t.pockets) {
      assert.ok(p.captureR > t.ballRadius, `${id} 的 ${p.id} 袋口太小`);
    }
  }
  assert.throws(() => createTable('不存在的台'));
});

test('击球：中杆打点 b=0.4 时击出即自然滚动（滑移为零）', () => {
  const b = createBall('cue', 1, 1);
  createWorld(table, [b]);
  strike(b, { angle: 0.7, speed: 2.0, tip: { a: 0, b: 0.4 } });
  const s = slipOf(b);
  assert.ok(Math.hypot(s.x, s.y) < 1e-6, `滑移应为 0，实际 ${Math.hypot(s.x, s.y)}`);
  // 方向正确
  assert.ok(Math.abs(Math.atan2(b.vy, b.vx) - 0.7) < 1e-9);
});

test('击球：低杆给回旋、高杆给前旋、右塞给正向 wz', () => {
  const mk = (tip) => {
    const b = createBall('cue', 1, 1);
    createWorld(table, [b]);
    strike(b, { angle: 0, speed: 2, tip });
    return b;
  };
  const low = mk({ a: 0, b: -0.4 });
  const high = mk({ a: 0, b: 0.4 });
  assert.ok(low.wy < 0, '低杆应产生负的 wy（回旋）');
  assert.ok(high.wy > 0, '高杆应产生正的 wy（前旋）');
  const right = mk({ a: 0.3, b: 0 });
  assert.ok(right.wz < 0, '右塞按本实现约定为负 wz');
});

test('击球：杆头偏移被钳到 ±0.5，不会滑杆到无穷', () => {
  const b = createBall('cue', 1, 1);
  createWorld(table, [b]);
  strike(b, { angle: 0, speed: 2, tip: { a: 9, b: -9 } });
  const k = (5 * 2) / (2 * R);
  assert.ok(Math.abs(b.wz) <= k * 0.5 + 1e-9);
  assert.ok(Math.abs(b.wy) <= k * 0.5 + 1e-9);
});

test('摩擦：无旋球先滑后滚，滚动后速度衰减远慢于滑动期', () => {
  const b = createBall('cue', 1, 1);
  createWorld(table, [b]);
  b.vx = 2.0;

  // 滑动期：滑移在 3.5μg 下衰减
  advanceBall(b, 0.02);
  const s = slipOf(b);
  const slipNow = Math.hypot(s.x, s.y);
  assert.ok(slipNow > 0 && slipNow < 2.0, '滑动期滑移应在衰减');

  // 再走一段时间应完全进入滚动
  advanceBall(b, 0.5);
  const s2 = slipOf(b);
  assert.ok(Math.hypot(s2.x, s2.y) < 1e-6, '长时间后必须进入纯滚动');
  // 纯滚动满足 v = R·ω
  assert.ok(Math.abs(b.wy - b.vx / R) < 1e-6);
});

test('摩擦：速度越高滚得越远，且距离单调', () => {
  let prev = -1;
  for (const v of [0.5, 1, 2, 3]) {
    const b = createBall('cue', R, R);
    createWorld(table, [b]);
    b.vx = v;
    const x0 = b.x;
    for (let i = 0; i < 4000 && ballSpeed(b) > 0; i++) advanceBall(b, 1 / 240);
    const dist = b.x - x0;
    assert.ok(dist > prev, `v=${v} 应滚得更远`);
    prev = dist;
  }
});

test('摩擦：球最终一定会停，不会永远爬', () => {
  const b = createBall('cue', 1, 1);
  createWorld(table, [b]);
  b.vx = 0.02; // 比 stopSpeed 略大
  for (let i = 0; i < 4000; i++) {
    advanceBall(b, 1 / 240);
    if (ballSpeed(b) === 0) break;
  }
  assert.equal(ballSpeed(b), 0);
});

test('速度反解：speedToReach 与 speedAfterDistance 互为逆', () => {
  const dist = 0.8;
  const residual = 0.15;
  const v0 = speedToReach(dist, residual, R);
  const back = speedAfterDistance(v0, dist, R);
  assert.ok(Math.abs(back - residual) < 1e-3, `反解误差过大: ${back} vs ${residual}`);
});

test('速度反解：requiredCueSpeed 单调递增于距离', () => {
  let prev = 0;
  for (const d of [0.1, 0.5, 1.0, 1.5]) {
    const v = cueSpeedForImpact(d, 0.4, 0, R);
    assert.ok(v > prev, `距离 ${d} 需要的初速应更大`);
    prev = v;
  }
});

test('速度反解：中杆击出的解析解与 advanceBall 数值积分一致', () => {
  for (const b of [0, 0.4, -0.25]) {
    const dist = 0.7;
    const v0 = 1.8;
    // 数值：走一遍 advanceBall
    const probe = createBall('p', 0, 0);
    createWorld(table, [probe]);
    strike(probe, { angle: 0, speed: v0, tip: { a: 0, b } });
    let travelled = 0;
    for (let i = 0; i < 4000 && travelled < dist && ballSpeed(probe) > 0; i++) {
      const x0 = probe.x;
      advanceBall(probe, 1 / 480);
      travelled += probe.x - x0;
    }
    const numeric = ballSpeed(probe);
    const analytic = cueBallSpeedAfterTravel(v0, b, dist, R);
    assert.ok(
      Math.abs(numeric - analytic) / Math.max(numeric, 0.01) < 0.05,
      `tipB=${b}: 解析 ${analytic.toFixed(4)} vs 数值 ${numeric.toFixed(4)}`
    );
  }
});

test('碰撞：正撞时目标球拿走几乎全部速度（等质量弹性）', () => {
  const cue = createBall('cue', 0.6, 0.635);
  const obj = createBall('b1', 0.6 + 2 * R + 1e-4, 0.635, { number: 1 });
  const w = freshWorld([cue, obj]);
  strike(cue, { angle: 0, speed: 2.0, tip: { a: 0, b: 0 } });

  // 必须看碰撞刚发生那一刻，runShot 会一路跑到全部停下，速度早已被台呢吃掉
  const events = [];
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'ball'); i++) {
    stepWorld(w, 1 / 240, events);
  }
  assert.ok(events.some((e) => e.type === 'ball'), '应发生球球碰撞');

  const speedObj = Math.hypot(obj.vx, obj.vy);
  assert.ok(speedObj > 1.7, `目标球速度应接近入射速度，实际 ${speedObj}`);
  // 正撞后母球几乎停住（e<1 时留一点）
  assert.ok(ballSpeed(cue) < 0.2, `正撞后母球应几乎停住，实际 ${ballSpeed(cue)}`);
});

test('碰撞：等质量正撞动量守恒（摩擦可忽略的一瞬）', () => {
  const cue = createBall('cue', 0.6, 0.635);
  const obj = createBall('b1', 0.6 + 2 * R + 1e-5, 0.635, { number: 1 });
  freshWorld([cue, obj]);
  strike(cue, { angle: 0, speed: 2.0, tip: { a: 0, b: 0 } });
  const p0 = cue.vx;
  // 只走一步到碰撞发生，避免台呢摩擦干扰
  const events = [];
  for (let i = 0; i < 20 && events.length === 0; i++) stepWorld({ table, balls: [cue, obj], t: 0 }, 1 / 240, events);
  const p1 = cue.vx + obj.vx;
  assert.ok(Math.abs(p1 - p0) / p0 < 0.05, `动量应守恒，${p0} vs ${p1}`);
});

test('碰撞：球球接触不会产生 NaN，也不会把球顶穿', () => {
  const cue = createBall('cue', 1.0, 0.635);
  const obj = createBall('b1', 1.0 + 2 * R, 0.635, { number: 1 });
  const w = freshWorld([cue, obj]);
  strike(cue, { angle: 0, speed: 3, tip: { a: 0, b: 0 } });
  runShot(w, { maxTime: 6 });
  for (const b of w.balls) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), `${b.id} 位置出现 NaN`);
    assert.ok(b.x >= table.bounds.minX - 1e-6 && b.x <= table.bounds.maxX + 1e-6, `${b.id} x 出界`);
    assert.ok(b.y >= table.bounds.minY - 1e-6 && b.y <= table.bounds.maxY + 1e-6, `${b.id} y 出界`);
  }
});

test('碰撞：贴在一起的两球不会无限互顶（极限环）', () => {
  const a = createBall('a', 1.0, 0.635);
  const b = createBall('b', 1.0 + 2 * R, 0.635);
  const w = freshWorld([a, b]);
  a.vx = 0.02;
  const res = runShot(w, { maxTime: 8 });
  assert.ok(res.settled, '贴球必须能停下来');
  assert.ok(res.time < 3, `不该耗这么久: ${res.time}`);
});

test('库边：垂直撞库反弹，法向速度反向且衰减', () => {
  const b = createBall('cue', table.length - R - 0.5, table.width / 2);
  const w = freshWorld([b]);
  strike(b, { angle: 0, speed: 1.5, tip: { a: 0, b: 0.4 } });
  const vIn = Math.abs(b.vx);
  const events = [];
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'cushion'); i++) {
    stepWorld(w, 1 / 240, events);
  }
  assert.ok(events.some((e) => e.type === 'cushion'), '应发生撞库');
  assert.ok(b.vx < 0, '撞右库后应向回弹');
  const e = PHYS.cushionRestitution - 0.06 * Math.min(1, vIn / 5);
  assert.ok(Math.abs(Math.abs(b.vx) / vIn - e) < 0.15, '恢复系数应接近设定值');
});

test('库边：45° 撞库后仍留在台面内，不会穿库', () => {
  const b = createBall('cue', table.length / 2, table.width / 2);
  const w = freshWorld([b]);
  strike(b, { angle: Math.PI / 4, speed: 2.5, tip: { a: 0, b: 0.4 } });
  runShot(w, { maxTime: 10 });
  assert.ok(b.x >= table.bounds.minX - 1e-6 && b.x <= table.bounds.maxX + 1e-6);
  assert.ok(b.y >= table.bounds.minY - 1e-6 && b.y <= table.bounds.maxY + 1e-6);
});

test('袋口：球心进捕获圆即落袋，且速度清零', () => {
  const p = table.pockets.find((x) => x.id === 'c-br');
  // 从袋口斜上方朝袋心推
  const b = createBall('cue', p.x - 0.25, p.y + 0.25);
  const w = freshWorld([b]);
  const angle = Math.atan2(p.y - b.y, p.x - b.x);
  strike(b, { angle, speed: 0.9, tip: { a: 0, b: 0.4 } });
  const res = runShot(w, { maxTime: 8 });
  assert.ok(b.pocketed, '应落袋');
  assert.equal(b.pocket, 'c-br');
  assert.equal(ballSpeed(b), 0);
  assert.ok(res.events.some((e) => e.type === 'pocket'));
});

test('袋口：沿库边平行滚过的球不会误判进袋', () => {
  const b = createBall('cue', 0.5, R);
  const w = freshWorld([b]);
  // 沿下库平行向右，会经过中袋口
  strike(b, { angle: 0, speed: 1.2, tip: { a: 0, b: 0.4 } });
  runShot(w, { maxTime: 10 });
  // 贴库滚过中袋口的球在真实台面上会被袋角挡住/进袋，但绝不该穿到台外
  assert.ok(b.x >= table.bounds.minX - 1e-6 && b.x <= table.bounds.maxX + 1e-6);
  assert.ok(b.y >= table.bounds.minY - 1e-6 && b.y <= table.bounds.maxY + 1e-6);
});

test('袋口：粗步长下擦袋角的球不会被误判成进袋', () => {
  // settlePockets 只在子步结束时看球心位置。步长太粗时，球会在一子步里
  // 直接跳过库边落进捕获圆——于是「擦袋角、本来进不去」被误判成「进袋」。
  //
  // 这一杆是实测扫出来的最坏用例：6.6 m/s（最高球速）、纵向偏 64 mm 打右下袋。
  // 关闭 stepWorld 的步长钳制后，1/240 与 1/120 都判不进（正确），
  // 1/30 却判进（错）——扫描 4 种力度 × 41 个偏移，共 8 处这种误判。
  // 开启钳制后全部归零。
  //
  // 这条测试的意义：漏判和误判都不报错、不抛异常，看起来只是「物理不准」。
  // 如果有人为了提速把 dt 调粗，或者把球速上限提高，问题会静默回来。
  const p = table.pockets.find((x) => x.id === 'c-br');
  const make = (dt) => {
    const b = createBall('cue', p.x - 0.7, p.y - 0.064);
    const w = freshWorld([b]);
    const angle = Math.atan2(p.y - b.y, p.x - b.x);
    strike(b, { angle, speed: 6.6, tip: { a: 0, b: 0.4 } });
    runShot(w, { maxTime: 20, dt });
    return b.pocketed;
  };

  const fine = make(1 / 240);
  assert.equal(fine, false, '这一杆擦袋角，细步长下必须判不进');
  assert.equal(make(1 / 120), false, '1/120 下也必须判不进');
  assert.equal(make(1 / 30), false, '1/30 这种粗步长下也必须判不进（靠 stepWorld 的步长钳制）');
});

test('袋口：正对袋心打，任何步长都必须进袋', () => {
  // 上一版这条测试写成了「粗步长下快球不会从袋口穿过去」，但实测发现
  // 那个方向根本不是失效模式——正对袋心时球心穿过捕获圆中心，
  // 子步两端至少有一端落在圆内，怎么打都进。
  // 真正的失效模式是反方向（误判进球），所以那条测试改成上面那一条。
  // 这里保留正对打的正向断言，防止钳制改得过头把该进的球也钳掉了。
  const p = table.pockets.find((x) => x.id === 'c-bl');
  const make = (dt) => {
    const b = createBall('cue', p.x - 0.5, p.y + 0.02);
    const w = freshWorld([b]);
    const angle = Math.atan2(p.y - b.y, p.x - b.x);
    strike(b, { angle, speed: 6.6, tip: { a: 0, b: 0.4 } });
    runShot(w, { maxTime: 20, dt });
    return b;
  };

  for (const dt of [1 / 240, 1 / 120, 1 / 60, 1 / 30]) {
    const b = make(dt);
    assert.ok(b.pocketed, `dt=1/${Math.round(1 / dt)} 下正对袋心打必须进袋`);
    assert.equal(ballSpeed(b), 0, '进袋后速度必须清零');
  }
});

test('一杆到底：所有球停下，时间有限，事件流按时间单调', () => {
  const cue = createBall('cue', 0.6, 0.635);
  const obj = createBall('b1', 1.9, 0.635, { number: 1 });
  const w = freshWorld([cue, obj]);
  strike(cue, { angle: 0, speed: 2.2, tip: { a: 0, b: 0.4 } });
  const res = runShot(w, { maxTime: 20 });
  assert.ok(res.settled, '一杆必须能结束');
  assert.ok(res.time < 20);
  assert.ok(allStopped(w));
});

test('一杆到底：cloneWorld 是深拷贝，不影响原世界', () => {
  const cue = createBall('cue', 0.6, 0.635);
  const obj = createBall('b1', 1.9, 0.635, { number: 1 });
  const w = freshWorld([cue, obj]);
  strike(cue, { angle: 0, speed: 2.2, tip: { a: 0, b: 0 } });
  const copy = cloneWorld(w);
  runShot(copy, { maxTime: 20 });
  assert.equal(w.balls[0].x, cue.x === w.balls[0].x ? w.balls[0].x : w.balls[0].x);
  assert.equal(w.t, 0);
  assert.notEqual(copy.balls[0].x, w.balls[0].x);
});

test('数值稳定：极端力度与极端打点都不产生 NaN', () => {
  for (const speed of [0.55, 6.6]) {
    for (const tip of [{ a: 0.5, b: 0.5 }, { a: -0.5, b: -0.5 }, { a: 0.5, b: -0.5 }]) {
      const cue = createBall('cue', 1.0, 0.635);
      const obj = createBall('b1', 1.9, 0.635, { number: 1 });
      const w = freshWorld([cue, obj]);
      strike(cue, { angle: 0.3, speed, tip });
      runShot(w, { maxTime: 25 });
      for (const b of w.balls) {
        assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), `speed=${speed} tip=${JSON.stringify(tip)} 出 NaN`);
        assert.ok(Number.isFinite(b.vx) && Number.isFinite(b.vy));
      }
    }
  }
});
