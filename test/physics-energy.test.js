// 库边碰撞的能量账：撞库不许给球凭空加能量。
//
// 背景（修复前实测，pool9，母球 (2.24, 0.635)、angle 0.6、speed 8、tip.a=+0.5）：
//   出库速度 10.719 m/s（入射 8.000，+34%），合动能 8.840 → 9.781 J。
//   a=0 与 a=-0.5 的涨幅恰好 0.000 J，说明不是数值抖动，是模型项。
// 三处账目错位，全部在 resolveCushion 里：
//   1. 恢复系数 e = baseE + (1-baseE)*min(1,|vn|/4)，|vn|>=4 时饱和到 1.0，
//      法向一点都不损失；
//   2. 侧旋增益 spinKick = 0.15*wz*R 直接用碰撞前的 wz 加到切向速度上，
//      而"代价"只是碰撞后 wz *= 0.7——两者量纲都不成对，实测单库 +1.97 J；
//   3. 切向滑移写成 u = 0.25*vt - R*wz，侧旋与切向速度反向时把滑移放大到
//      1.6 倍（8.86 对真实接触点滑移 5.51 m/s），冲量越过"滑移归零"点之后
//      摩擦开始对球做正功，单库再加 0.83 J。
//
// 这里断言的是物理事实，不是当前实现的输出快照：
//   - 一次碰撞（含切向、含自旋）前后总动能不增；
//   - 复现局面的出库合速度不超过入射合速度（带塞时自旋转平动是允许的，见下）；
//   - 大力撞库也不许是完全弹性（e 有上限）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import {
  createBall, createWorld, strike, runShot, ballSpeed, stepWorld,
} from '../src/physics.js';
import { PHYS, FIXED_DT, MAX_SHOT_TIME, TABLE_PRESETS } from '../src/constants.js';

const table = createTable('pool9');
const R = table.ballRadius;
// 球质量挂在台子预设上（pool9/pool8 是 0.17 kg，snooker 是 0.142 kg），
// 不在 PHYS 里。写错过一次 PHYS.ballMass -> undefined，energy() 直接算成 NaN，
// 而 NaN 参与的比较恒为 false，逐子步那条断言会静默变成空断言——所以下面
// 每处取能量都要求是有限正数。
const M = TABLE_PRESETS.pool9.ballMass;

/** 单球合动能（平动 + 绕竖轴自旋），与 fuzz 的判据同口径，单位 J */
function energy(b) {
  const I = 0.4 * M * R * R;
  return 0.5 * M * (b.vx * b.vx + b.vy * b.vy) + 0.5 * I * (b.wx * b.wx + b.wy * b.wy + b.wz * b.wz);
}

/** 合动能必须是有限正数：NaN 会让所有比较恒假，断言静默失效 */
function energyOk(b, tag) {
  const e = energy(b);
  assert.ok(Number.isFinite(e) && e >= 0, `${tag}: 合动能 ${e} 不是有限非负数（质量常数写错了？）`);
  return e;
}

/**
 * 打一杆，逐子步记录合动能与速度峰值。
 * 每次撞库都记下「碰撞前速度（上一子步末）→ 碰撞后速度」这一对。
 *
 * 注意：不能拿「整杆最大速度 <= 入射速度」当判据——带塞的球在台呢上
 * 本来就会把自旋能量转成平动（塞越重、初速越低越明显），那是真实的
 * 物理效应，合动能并没有增加。这里要挡的是**碰撞当场**加速。
 */
function shoot({ x, y, angle, speed, tip }) {
  const b = createBall('cue', x, y);
  const w = createWorld(table, [b]);
  strike(b, { angle, speed, tip });
  const v0 = ballSpeed(b);
  const e0 = energyOk(b, 'strike 之后');
  let maxSpeed = v0;
  let maxRise = 0;
  let prevE = e0;
  let lastSpeed = v0;
  const railHits = [];
  const events = [];

  const res = runShot(w, {
    dt: FIXED_DT,
    maxTime: MAX_SHOT_TIME,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.type === 'cushion') {
        railHits.push({ pre: lastSpeed, post: ballSpeed(b), preE: prevE, postE: energyOk(b, '撞库之后'), vn: ev.speed });
      }
    },
    onStep: (wd) => {
      const ball = wd.balls[0];
      if (ball.pocketed) return;
      const e = energyOk(ball, '子步末');
      if (e - prevE > maxRise) maxRise = e - prevE;
      prevE = e;
      const v = ballSpeed(ball);
      if (v > maxSpeed) maxSpeed = v;
      lastSpeed = v;
    },
  });

  return { ball: b, v0, e0, maxSpeed, maxRise, events, res, railHits };
}

// ---- 1. 单球复现局面 ------------------------------------------------------
test('能量：复现局面（2.24,0.635 / angle 0.6 / speed 8 / tip.a=+0.5）出库不加速', () => {
  const r = shoot({ x: 2.24, y: 0.635, angle: 0.6, speed: 8, tip: { a: 0.5, b: 0 } });
  assert.ok(r.railHits.length > 0, '这一杆必须撞到库');
  const hit = r.railHits[0];
  // 修复前这一杆出库 10.719 m/s（入射 8.000，+34%）
  assert.ok(
    hit.post <= r.v0 + 1e-9,
    `出库速度 ${hit.post.toFixed(3)} 不得超过入射速度 ${r.v0.toFixed(3)}`
  );
  assert.ok(
    hit.post <= hit.pre + 1e-9,
    `碰撞当场不得加速：${hit.pre.toFixed(3)} -> ${hit.post.toFixed(3)}`
  );
  assert.ok(r.maxRise <= 1e-9, `整杆单步合动能涨幅 ${r.maxRise.toExponential(3)} J 应为 0`);
});

// ---- 2. 带塞 / 不带塞三组对照 -------------------------------------------
test('能量：a=0 / +0.5 / -0.5 三组出库速度都不超过入射速度', () => {
  const out = {};
  for (const a of [0, 0.5, -0.5]) {
    const r = shoot({ x: 2.24, y: 0.635, angle: 0.6, speed: 8, tip: { a, b: 0 } });
    assert.ok(r.railHits.length > 0, `tip.a=${a} 必须撞到库`);
    for (const hit of r.railHits) {
      assert.ok(
        hit.post <= r.v0 + 1e-9,
        `tip.a=${a}: 出库 ${hit.post.toFixed(3)} > 入射 ${r.v0.toFixed(3)}`
      );
    }
    out[String(a)] = r.railHits[0].post;
  }
  // 物理排序：顺塞（+0.5）比反塞（-0.5）出库快，因为反塞的接触点滑移更大、
  // 摩擦吃掉更多切向速度。这里只要方向对，不锁具体数值。
  assert.ok(
    out['0.5'] > out['-0.5'],
    `顺塞出库 ${out['0.5'].toFixed(3)} 应快于反塞 ${out['-0.5'].toFixed(3)}`
  );
});

// ---- 3. 恢复系数不许饱和到完全弹性 --------------------------------------
test('能量：大力垂直撞库仍有法向损失（恢复系数不到 1）', () => {
  assert.ok(PHYS.cushionRestitutionMax < 1, '库面恢复系数上限必须严格小于 1');
  const b = createBall('cue', table.length / 2, table.width / 2);
  const w = createWorld(table, [b]);
  strike(b, { angle: 0, speed: 8, tip: { a: 0, b: 0 } });
  const vIn = Math.abs(b.vx);
  const events = [];
  for (let i = 0; i < 600 && !events.some((e) => e.type === 'cushion'); i++) {
    stepWorld(w, FIXED_DT, events);
  }
  assert.ok(events.some((e) => e.type === 'cushion'), '应发生撞库');
  const ratio = Math.abs(b.vx) / vIn;
  assert.ok(ratio < 0.99, `8 m/s 正撞库的法向比率 ${ratio.toFixed(3)} 不该是 1`);
  assert.ok(ratio > PHYS.cushionRestitution - 0.05, `法向比率 ${ratio.toFixed(3)} 也不该掉到地面`);
});

// ---- 4. 随机化：200 组 angle/speed/tip，每次碰撞后总动能不增 --------------
test('能量：200 组随机击球，逐子步合动能不增（含自旋）', () => {
  // 固定种子：失败可复现。参数复刻 %TEMP%\fuzz\fuzz-physics.mjs 的取法。
  let s = 20260419;
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const range = (lo, hi) => lo + (hi - lo) * rnd();
  const { minX, maxX, minY, maxY } = table.bounds;

  let worstRise = 0;
  let worstCase = null;
  let cushions = 0;

  for (let i = 0; i < 200; i++) {
    const shot = {
      x: range(minX, maxX),
      y: range(minY, maxY),
      angle: range(0, Math.PI * 2),
      speed: range(0.5, 8),
      tip: { a: range(-0.5, 0.5), b: range(-0.5, 0.5) },
    };
    const r = shoot(shot);
    cushions += r.railHits.length;
    if (r.maxRise > worstRise) {
      worstRise = r.maxRise;
      worstCase = shot;
    }
    assert.ok(
      r.maxRise <= 1e-9,
      `第 ${i} 组 ${JSON.stringify(shot)} 单步合动能增加 ${r.maxRise.toExponential(3)} J`
    );
    assert.ok(Number.isFinite(r.ball.x) && Number.isFinite(r.ball.y), `第 ${i} 组坐标非有限`);
    for (const hit of r.railHits) {
      // 判据只能是合动能：一次库边碰撞允许把自旋能量转成平动，出库合速度
      // 因此偶尔会比入射合速度大一点（实测 3.534 → 3.603，合动能仍在降）——
      // 那是真实的塞效应，不是凭空增能。能凭空增能的是合动能，所以这里钉合动能。
      assert.ok(
        hit.postE <= hit.preE + 1e-9,
        `第 ${i} 组 ${JSON.stringify(shot)} 撞库当场给合动能加了 ${(hit.postE - hit.preE).toExponential(3)} J`
      );
      assert.ok(
        hit.post <= hit.pre + 1e-9,
        `第 ${i} 组 ${JSON.stringify(shot)} 撞库当场加速 ${hit.pre.toFixed(3)} -> ${hit.post.toFixed(3)}`
      );
    }
  }

  assert.ok(cushions > 100, `200 组里撞库次数 ${cushions} 太少，用例没覆盖到库边`);
  assert.ok(worstRise <= 1e-9, `最坏一组 ${JSON.stringify(worstCase)} 增能 ${worstRise}`);
});