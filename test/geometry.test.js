// src/geometry.js 的专项测试。
//
// 覆盖该模块现有导出的全部符号：V 的 13 个平面向量工具 + DEG 角度换算常数。
//
// 语义要点（读实现确认过的，测试按真实行为断言）：
//   · V.norm 用 `hypot || 1` 兜底：零向量返回零向量而不是 NaN；NaN 分量也不会被兜底吞掉
//     （NaN 是 falsy，会走 || 1 分支，结果是 NaN/1 = NaN）。
//   · V.len / V.dist 用 Math.hypot，天然带溢出保护（3e200/4e200 不会变 Infinity）。
//   · V.perp 是逆时针 90°，方向性用 cross(v, perp(v)) > 0 验证，而不是照抄分量公式。
//   · V.angle 值域 (-π, π]，零向量返回 0（atan2(0,0)），不抛错。
//   · V.fromAngle(r=0) 把方向乘没了，返回 {0,0}——这是乘法的自然结果，不是 bug。
//
// 历史：这里测不到 pointSegmentDistance —— 它在本模块里全仓库零引用，已按任务删除；
// 现存的那份实现在 aim.js（firstBlocker 在用），不在本文件的覆盖范围。

import test from 'node:test';
import assert from 'node:assert/strict';

import { V, DEG } from '../src/geometry.js';

test('V.add / V.sub / V.mul：分量运算，返回新对象', () => {
  const a = { x: 1.5, y: -2 };
  const b = { x: 0.25, y: 4 };

  assert.deepEqual(V.add(a, b), { x: 1.75, y: 2 });
  assert.deepEqual(V.sub(a, b), { x: 1.25, y: -6 });
  assert.deepEqual(V.mul(a, 2), { x: 3, y: -4 });
  assert.deepEqual(V.mul(a, -1), { x: -1.5, y: 2 });
  assert.deepEqual(V.mul({ x: 1, y: 2 }, 0), { x: 0, y: 0 });
  // IEEE 754 的符号规则：负数乘 0 得 -0（deepEqual 会区分 -0 与 0）
  assert.deepEqual(V.mul({ x: 1, y: -2 }, 0), { x: 0, y: -0 });
  // 自己减自己精确为 0（不是 1e-17 这种浮点尾巴）
  assert.deepEqual(V.sub(a, a), { x: 0, y: 0 });

  // 返回的是新对象，不是入参之一
  const sum = V.add(a, b);
  assert.notEqual(sum, a);
  assert.notEqual(sum, b);
  assert.notEqual(V.mul(a, 1), a);
});

test('V：所有工具函数都不写回入参（冻结对象也跑得通）', () => {
  // ESM 是严格模式：任何对冻结对象的写入都会直接抛 TypeError
  const a = Object.freeze({ x: 1.5, y: -2 });
  const b = Object.freeze({ x: 0.25, y: 4 });
  V.add(a, b);
  V.sub(a, b);
  V.mul(a, 3);
  V.len(a);
  V.dist(a, b);
  V.norm(a);
  V.dot(a, b);
  V.cross(a, b);
  V.perp(a);
  V.angle(a);
  V.fromAngle(1, V.angle(a));
  assert.deepEqual(a, { x: 1.5, y: -2 });
  assert.deepEqual(b, { x: 0.25, y: 4 });
});

test('V.len / V.dist：欧氏距离，3-4-5 精确，对称，零向量为 0', () => {
  assert.equal(V.len({ x: 3, y: 4 }), 5);
  assert.equal(V.len({ x: -3, y: -4 }), 5);
  assert.equal(V.len({ x: 0, y: 0 }), 0);
  assert.equal(V.len({ x: 7, y: 0 }), 7);

  assert.equal(V.dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(V.dist({ x: 3, y: 4 }, { x: 0, y: 0 }), 5);
  assert.equal(V.dist({ x: 1, y: 1 }, { x: 1, y: 1 }), 0);

  // 是对角线距离，不是曼哈顿距离
  const diag = V.dist({ x: 0, y: 0 }, { x: 1, y: 1 });
  assert.ok(Math.abs(diag - Math.SQRT2) < 1e-15, `斜边应为 √2，实际 ${diag}`);
  assert.ok(diag < 2, '不能被算成 |dx|+|dy|');

  // Math.hypot 的溢出保护：朴素 sqrt(x²+y²) 在这里会溢出成 Infinity
  const big = V.len({ x: 3e200, y: 4e200 });
  assert.equal(Number.isFinite(big), true);
  assert.ok(Math.abs(big / 5e200 - 1) < 1e-12, `3e200/4e200 的模应为 5e200，实际 ${big}`);
});

test('V.norm：单位向量，方向保持；零向量返回零向量而不是 NaN', () => {
  const n = V.norm({ x: 3, y: 4 });
  assert.deepEqual(n, { x: 0.6, y: 0.8 });
  assert.ok(Math.abs(V.len(n) - 1) < 1e-15);
  // 负分量方向不丢
  assert.deepEqual(V.norm({ x: -3, y: 4 }), { x: -0.6, y: 0.8 });
  // 极小向量也能归一（1e-300 是正规数，除法精确）
  assert.deepEqual(V.norm({ x: 1e-300, y: 0 }), { x: 1, y: 0 });

  // 已知行为：实现用 `hypot || 1` 兜底，零向量静默返回零向量（不报错、不 NaN）。
  // 调用方要自己判断退化输入，这一条如实钉住现状。
  assert.deepEqual(V.norm({ x: 0, y: 0 }), { x: 0, y: 0 });
});

test('V.dot / V.cross：垂直为 0，反交换，平行共线为 0', () => {
  assert.equal(V.dot({ x: 1, y: 2 }, { x: 3, y: 4 }), 11);
  assert.equal(V.dot({ x: 1, y: 0 }, { x: 0, y: 1 }), 0);
  assert.equal(V.dot({ x: 2, y: 0 }, { x: -1, y: 0 }), -2, '反向点积为负');

  assert.equal(V.cross({ x: 1, y: 0 }, { x: 0, y: 1 }), 1, '右手系：x 转向 y 为正');
  assert.equal(V.cross({ x: 0, y: 1 }, { x: 1, y: 0 }), -1);
  assert.equal(V.cross({ x: 2, y: 4 }, { x: 1, y: 2 }), 0, '共线叉积为 0');
  assert.equal(V.cross({ x: 3, y: 1 }, { x: 4, y: 2 }), 2);

  // 反交换律在浮点下也是精确的（乘积可交换、减法对称取负）
  const a = { x: 1.7, y: -2.3 };
  const b = { x: -0.4, y: 5.1 };
  assert.equal(V.cross(a, b), -V.cross(b, a));
});

test('V.perp：逆时针旋转 90°，保长、与自身正交', () => {
  // 注意 (1,0) 的旋转结果是 {x:-0, y:1}：-0 与 0 用 === 相等，但 Object.is / deepEqual 区分两者。
  const right = V.perp({ x: 1, y: 0 });
  assert.ok(Object.is(right.x, -0), `perp({x:1,y:0}).x 应为 -0，实际 ${right.x}`);
  assert.equal(right.y, 1);
  assert.deepEqual(V.perp({ x: 0, y: 1 }), { x: -1, y: 0 });

  for (const v of [{ x: 1, y: 0 }, { x: 3, y: 4 }, { x: -2.5, y: 7 }]) {
    const p = V.perp(v);
    assert.equal(V.dot(v, p), 0, `perp 应与原向量正交：${JSON.stringify(v)}`);
    assert.ok(Math.abs(V.len(p) - V.len(v)) < 1e-12, 'perp 不改变长度');
    // 方向性：旋转后仍在原向量的左手侧（逆时针），不是顺时针
    assert.ok(V.cross(v, p) > 0, 'perp 必须是逆时针 90°');
  }
  // 不修改入参
  const v = { x: 3, y: 4 };
  V.perp(v);
  assert.deepEqual(v, { x: 3, y: 4 });
});

test('V.angle：atan2 值域 (-π, π]，零向量返回 0', () => {
  assert.equal(V.angle({ x: 1, y: 0 }), 0);
  assert.equal(V.angle({ x: 0, y: 1 }), Math.PI / 2);
  assert.equal(V.angle({ x: -1, y: 0 }), Math.PI);
  assert.equal(V.angle({ x: 0, y: -1 }), -Math.PI / 2);
  // 第四象限为负角
  assert.ok(V.angle({ x: 3, y: -4 }) < 0);
  // 零向量：atan2(0,0) === 0，不抛错也不 NaN
  assert.equal(V.angle({ x: 0, y: 0 }), 0);
});

test('V.fromAngle：半径与角度的极坐标还原，与 V.angle 互逆', () => {
  assert.deepEqual(V.fromAngle(2, 0), { x: 2, y: 0 });
  const p90 = V.fromAngle(2, Math.PI / 2);
  assert.ok(Math.abs(p90.x) < 1e-15, 'cos(π/2) 是 6.1e-17，不是 0');
  assert.equal(p90.y, 2);

  for (const [r, a] of [[1, 0.7], [3, -2.1], [0.5, Math.PI], [1.25, 2.9]]) {
    const v = V.fromAngle(r, a);
    assert.ok(Math.abs(V.len(v) - r) < 1e-12, `模应为 ${r}`);
    assert.ok(Math.abs(V.angle(v) - a) < 1e-12, `角度应为 ${a}`);
  }
  // 与 norm 组合：先归一再用 angle/fromAngle 还原，应回到同一个方向
  const u = V.norm({ x: 3, y: -4 });
  const back = V.fromAngle(1, V.angle({ x: 3, y: -4 }));
  assert.ok(V.dist(u, back) < 1e-15);

  // r=0 时方向信息被乘没（乘法自然结果，不是 bug）
  assert.deepEqual(V.fromAngle(0, 0.7), { x: 0, y: 0 });
});

test('DEG：弧度→度的换算常数（π/2 → 90，180° → π）', () => {
  assert.ok(Math.abs(DEG - 180 / Math.PI) < 1e-12);
  assert.ok(Math.abs((Math.PI / 2) * DEG - 90) < 1e-12);
  assert.ok(Math.abs(180 / DEG - Math.PI) < 1e-12);
  // 本项目 aimToleranceDeg 等函数都是「弧度 * DEG → 度」，钉一次具体值
  assert.ok(Math.abs(Math.atan2(1, 1) * DEG - 45) < 1e-12);
});

test('已知缺口：NaN / Infinity 不做防御，如实记录当前传播行为', () => {
  // V.norm：NaN 是 falsy，会走 `|| 1` 兜底，于是 NaN/1 = NaN —— 结果仍是 NaN，
  // 但另一分量被静默归零，调用方拿到的是半 NaN 向量而不是明确的报错。
  const nanNorm = V.norm({ x: NaN, y: 0 });
  assert.equal(Number.isNaN(nanNorm.x), true);
  assert.equal(nanNorm.y, 0);

  // Infinity 输入：hypot = Infinity，Infinity/Infinity = NaN —— 有限输入变 NaN。
  const infNorm = V.norm({ x: Infinity, y: 0 });
  assert.equal(Number.isNaN(infNorm.x), true);
  assert.equal(infNorm.y, 0);

  // 其余函数一律直接传播 NaN，不掩蔽
  assert.equal(Number.isNaN(V.len({ x: NaN, y: 0 })), true);
  assert.equal(Number.isNaN(V.dot({ x: NaN, y: 0 }, { x: 1, y: 1 })), true);
  assert.equal(Number.isNaN(V.perp({ x: NaN, y: 0 }).y), true);
  assert.equal(Number.isNaN(V.angle({ x: NaN, y: 0 })), true);
  // 这些都不是本任务要改的实现（改语义会动到求解路径），只作为已知缺口记录。
});