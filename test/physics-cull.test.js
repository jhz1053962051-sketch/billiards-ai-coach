// 球球粗筛的边界守护：精确上界剪枝不许漏掉任何真实接触。
//
// findFirstEvent 在解二次方程之前先用一条保守上界把球对剪掉：
//   |dx| ≤ 2R + (|vax| + |vbx|)·h + 2·slack ，
// 其中 slack = ½·μ_slide·g·h² + 1e-9 是「自由飞行段在 h 内可能多走的距离」的上界
// （打滑段加速度最大 μg，滚动段更小）。剪枝的正确性完全依赖于「上界只往大了算」：
// 只要球对真能在 h 内接触，它就一定落在上界之内，绝不能被剪掉。
//
// 所以这里不去断言「剪枝触发了多少次」（那只是性能），而是断言**结论**：
// 在一串刻意贴着上界摆放的局面里，findFirstEvent 的结论必须与导出参考解 ballTOI
// 逐位一致——参考解说「t 时刻接触」，就必须拿到同一个 kind/t/同一对球；参考解说
// 「h 内不接触」，就必须拿到 null。
// 采样点跨过三条边界：球心距 = 2R（起手就贴住）、= 2R + 相对速度·h（接触恰好落在
// horizon 上）、= 粗筛上界本身（剪枝刚好开/关的那一档）。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { PHYS } from '../src/constants.js';
import { createBall, createWorld, ballTOI, findFirstEvent } from '../src/physics.js';

const table = createTable('pool9');
const R = table.ballRadius;
const H = 1 / 120;

/** 与 findFirstEvent 内部同式的剪枝上界（2R + 两球相对位移上界）。 */
function cullBound(vax, vbx, horizon) {
  const slack = 0.5 * PHYS.muSlide * PHYS.g * horizon * horizon + 1e-9;
  return 2 * R + (Math.abs(vax) + Math.abs(vbx)) * horizon + 2 * slack;
}

/**
 * 两颗球、给定初速的独立世界。摆在台心附近，h 内谁都够不到库边，
 * 于是 findFirstEvent 的结论只可能来自球球这一条路。
 */
function twoBallWorld(ax, ay, avx, avy, bx, by, bvx, bvy) {
  const a = createBall('a', ax, ay, { vx: avx, vy: avy });
  const b = createBall('b', bx, by, { vx: bvx, vy: bvy });
  return createWorld(table, [a, b]);
}

/**
 * 断言：这个局面下 findFirstEvent 与参考解 ballTOI 的结论逐位一致。
 * @returns {{t:number|null, kind:string|null}} 记录本次结论，供调用方汇总
 */
function assertMatchesReference(world, horizon) {
  const [a, b] = world.balls;
  const refT = ballTOI(a, b, horizon);
  const got = findFirstEvent(world, horizon);
  if (refT < 0) {
    assert.equal(got, null, `参考解说 h 内无接触，粗筛却报了事件 t=${got && got.t}`);
    return { t: null, kind: null };
  }
  assert.notEqual(got, null, `参考解 t=${refT} 的接触被粗筛剪掉了`);
  assert.equal(got.kind, 'ball');
  assert.equal(got.a, a);
  assert.equal(got.b, b);
  assert.ok(Object.is(got.t, refT), `t 不是逐位相同：参考 ${refT}，实际 ${got.t}`);
  return { t: got.t, kind: got.kind };
}

// 一维对撞（沿 x）：位移上界与相对速度都只作用在一个轴上，是最容易写出「刚好差一点」的形状。
test('粗筛边界：静止球被正面撞击时，上界内外两侧的结论与参考解一致', () => {
  const v = 1.4; // m/s，h 内走 11.7 mm，离库边足够远
  const bound = cullBound(v, 0, H); // = 2R + v·h + 2·slack
  const contactEdge = 2 * R + v * H; // 接触时刻恰好等于 horizon 的球心距
  const deltas = [
    -1e-3, -1e-6, -1e-9, -Number.EPSILON, 0, Number.EPSILON, 1e-9, 1e-6, 1e-3,
    bound - contactEdge - 1e-9, bound - contactEdge, bound - contactEdge + 1e-9, bound - contactEdge + 2e-3,
  ];
  let seenEvent = 0;
  for (const d of deltas) {
    const gap = contactEdge + d;
    const world = twoBallWorld(1.0, 0.635, v, 0, 1.0 + gap, 0.635, 0, 0);
    const got = assertMatchesReference(world, H);
    if (got.t !== null) seenEvent++;
  }
  // 边界两侧都必须被真的走到：否则这条测试只是在验证同一侧的空转
  assert.ok(seenEvent > 0 && seenEvent < deltas.length, `边界没有跨过去：events=${seenEvent}/${deltas.length}`);
});

// 两侧都在动：上界里的 |vbx| 项这时才不是 0，剪枝最容易在这里被低估。
test('粗筛边界：两球相向运动时上界不被低估', () => {
  const va = 1.1;
  const vb = -0.6;
  const close = va - vb; // 相对接近速度
  const contactEdge = 2 * R + close * H;
  const bound = cullBound(va, vb, H);
  const deltas = [-1e-6, -1e-9, 0, 1e-9, bound - contactEdge - 1e-9, bound - contactEdge, bound - contactEdge + 1e-9];
  for (const d of deltas) {
    const gap = contactEdge + d;
    const world = twoBallWorld(1.0, 0.635, va, 0, 1.0 + gap, 0.635, vb, 0);
    assertMatchesReference(world, H);
  }
});

// 斜撞：两个轴同时接近上界，球心距大而 |dx|/|dy| 各自都还在界内。
test('粗筛边界：斜向接近时两轴分别判定，结论与参考解一致', () => {
  const v = 1.2;
  const angle = 0.42;
  const avx = v * Math.cos(angle);
  const avy = v * Math.sin(angle);
  // 沿速度方向摆放，球心距从「贴住」扫到「h 内刚好够不到」
  const reach = v * H;
  for (const d of [-2 * R, 0, reach * 0.5, reach, reach + 2e-9, reach + 1e-6, reach * 1.5]) {
    const dist = 2 * R + d;
    const world = twoBallWorld(1.0, 0.635, avx, avy, 1.0 + dist * Math.cos(angle), 0.635 + dist * Math.sin(angle), 0, 0);
    assertMatchesReference(world, H);
  }
});

// 起手就贴住（C ≤ 0）：参考解给 0，剪枝必须也给出 0，而不是「距离太近所以剪掉」。
test('粗筛边界：起手已接触时给出 t=0，且与参考解逐位相同', () => {
  for (const overlap of [0, 1e-12, 1e-6, R * 0.5]) {
    const gap = 2 * R - overlap;
    const world = twoBallWorld(1.0, 0.635, 0.8, 0, 1.0 + gap, 0.635, 0, 0);
    assertMatchesReference(world, H);
  }
});

// 静止球对：两个都不动的时候不许报事件（粗筛前后的老快路径）。
test('粗筛边界：两颗球都静止时不产生事件', () => {
  const world = twoBallWorld(1.0, 0.635, 0, 0, 1.0 + 2.2 * R, 0.635, 0, 0);
  assert.equal(findFirstEvent(world, H), null);
});