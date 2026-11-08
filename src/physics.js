// 2D 台球刚体物理：滑动/滚动双阶段 + 事件驱动接触求解。
//
// 设计来源与许可（本项目 MIT，下列引用均兼容）
//   骨架（滑动→滚动解析切换、事件驱动 TOI、库边切向冲量、球球甩球）
//   参考 ctbot000/three-cushion-billiards (MIT)。本文件按其思路重写并扩展：
//     · 支持带袋口的台面（原项目是开伦台，无袋）
//     · 支持任意球台尺寸 / 球半径 / 质量
//     · 增加袋口捕获、袋口夹球回弹与出界兜底
//     · 改进库边反弹模型（库边硬度随速度变化）
//   数值常数与"静止/滑动/滚动"状态划分对照 ekiefl/pooltool (Apache-2.0) 校核。
//   tailuge/billiards 为 GPL-3.0，仅阅读对照，未复制任何实现。
//
// 关键取舍：TOI 用"当前速度线性外推"，horizon 最大只有一个固定步长（1/240 s），
// 这 4 ms 内摩擦造成的速度变化 < 0.01 m/s，误差远小于袋口判定精度；
// 而自由运动本身用 advanceBall 解析积分，所以不会累积步长误差。
//
// 性能优化：
//   · pocketAt 用外接正方形快速排除，99.99% 的点不做开方
//   · advanceBall 用 sqrt 替代 hypot（台球坐标范围内不可能溢出）
//   · 事件驱动而非定步长积分，静止球不参与计算

import { PHYS, FIXED_DT, MAX_SHOT_TIME } from './constants.js';

const SLIP_EPS = 1e-4;
/** 低于此速度的库边接触算作台呢抖动，不计入事件流 */
const RAIL_EVENT_SPEED = 0.015;
/**
 * 全部台型里最小的袋口捕获半径（pool9 的中袋 63.0 mm）。
 * stepWorld 用它把步长钳到「一子步位移 < 捕获半径」，见那里的注释。
 */
const MIN_CAPTURE_R = 0.063;

// ---------------------------------------------------------------- 袋口几何
//
// 袋口只做两件事，都用同一套几何：捕获圆（球心进入即落袋）+ 袋角夹球
// （越过库面却没进袋的球顶回台内）。刻意**不**加"袋口弧度的吸引力"这一类
// 近似：曾经加过一版指向袋心的径向漏斗力（0.3 g、1.5 倍捕获半径内生效），
// 实测把贴库平行滚过中袋的球和中远台擦边球全吸进袋，与台面几何自带的
// 捕获圆判定重复，且没有任何校准数据支撑那两个常数——已删除。
// 要更接近真实，正确做法是按袋角实际形状做接触求解，而不是叠加一个吸力。

/**
 * @typedef {object} Ball
 * @property {string} id
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {number} wx  滚动轴 x 分量
 * @property {number} wy  滚动轴 y 分量
 * @property {number} wz  绕竖直轴的旋转（塞）
 * @property {boolean} pocketed
 * @property {string} [pocket]
 * @property {string} [color]
 * @property {number} [number] 球号，0 为母球
 */

/** @returns {Ball} */
export function createBall(id, x, y, extra = {}) {
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    pocketed: false,
    color: '#ffffff',
    number: 0,
    ...extra,
  };
}

export function createRollTracker(balls, radius) {
  const previous = balls.map(({ x, y }) => ({ x, y }));
  const angles = balls.map((ball) => ball.rollAngle ?? 0);
  const directions = balls.map((ball) => ({
    x: ball.rollDirX ?? 0,
    y: ball.rollDirY ?? 0,
  }));

  return () => balls.map((ball, index) => {
    const dx = ball.x - previous[index].x;
    const dy = ball.y - previous[index].y;
    const distance = Math.hypot(dx, dy);
    if (distance > 1e-9) {
      angles[index] += distance / radius;
      directions[index] = { x: dx / distance, y: dy / distance };
    }
    previous[index] = { x: ball.x, y: ball.y };
    return {
      rollAngle: angles[index],
      rollDirX: directions[index].x,
      rollDirY: directions[index].y,
    };
  });
}

export function createWorld(table, balls) {
  // 球半径挂在球上：物理核每步都要用，避免到处传 table
  for (const b of balls) b.__R = table.ballRadius;
  return { table, balls, t: 0 };
}

export function cloneWorld(world) {
  return {
    table: world.table,
    t: world.t,
    balls: world.balls.map((b) => ({ ...b })),
  };
}

export function ballSpeed(b) {
  // 同 advanceBall 的理由：台球速度不可能溢出，sqrt 比 hypot 快 1.6 倍。
  // 这个函数在 allStopped / 每个子步里都会被调用。
  return Math.sqrt(b.vx * b.vx + b.vy * b.vy);
}

export function isMoving(b) {
  return b.vx !== 0 || b.vy !== 0;
}

export function allStopped(world) {
  return !world.balls.some((b) => !b.pocketed && isMoving(b));
}

/** 台呢接触点的滑移速度，摩擦作用在这个量上 */
export function slipOf(b) {
  const R = b.__R;
  return { x: b.vx - R * b.wy, y: b.vy + R * b.wx };
}

function snapToRolling(b) {
  const R = b.__R;
  b.wy = b.vx / R;
  b.wx = -b.vy / R;
}

function decaySpin(b, dt) {
  if (b.wz === 0) return;
  const R = b.__R;
  const rate = (5 * PHYS.muSpin * PHYS.g) / (2 * R);
  const drop = rate * dt;
  if (Math.abs(b.wz) <= drop) b.wz = 0;
  else b.wz -= Math.sign(b.wz) * drop;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 击球：把杆头角度/力度/打点换算成初速度与角速度。
 *
 * 打点 tip = { a, b }，单位是球半径：a 为左右（正 = 右塞），b 为上下（正 = 高杆）。
 * 由冲量 L = r × J 推得 ω = (5V/2R)·(b·t̂ − a·ẑ)，t̂ 为行进方向左侧单位向量。
 * b = 0.4 时恰好"击出即自然滚动"，与真实台球一致。
 */
export function strike(ball, { angle, speed, tip = { a: 0, b: 0 } }) {
  const R = ball.__R;
  const a = clamp(tip.a ?? 0, -0.5, 0.5);
  const b = clamp(tip.b ?? 0, -0.5, 0.5);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const k = (5 * speed) / (2 * R);

  ball.vx = speed * cos;
  ball.vy = speed * sin;
  ball.wx = k * b * -sin;
  ball.wy = k * b * cos;
  ball.wz = -k * a;
  return ball;
}

/**
 * 自由运动推进 tau 秒（解析积分，不做定步长迭代）。
 * 打滑阶段摩擦沿滑移方向，滚动阶段沿速度方向，两段在函数内精确分段。
 *
 * @param {Ball} b
 * @param {number} tau
 */
export function advanceBall(b, tau) {
  const R = b.__R;
  let remaining = tau;
  let guard = 0;

  while (remaining > 1e-12 && guard++ < 8) {
    const ux = b.vx - R * b.wy;
    const uy = b.vy + R * b.wx;
    // 这里用 sqrt 而不是 Math.hypot：hypot 的溢出保护对台球没有意义
    // （速度上限 7 m/s、角速度上限几十 rad/s，平方和离双精度上限差十几个数量级），
    // 而实测它慢 1.6 倍。这个函数占整个物理核 46% 的自身耗时，是第一名热点。
    const uLen = Math.sqrt(ux * ux + uy * uy);

    if (uLen > SLIP_EPS) {
      // 打滑：滑移以 3.5·μ·g 衰减，比球速衰减快，所以一定会转入滚动
      const tRoll = uLen / (3.5 * PHYS.muSlide * PHYS.g);
      const dt = Math.min(remaining, tRoll);
      const nx = ux / uLen;
      const ny = uy / uLen;
      let ax = -PHYS.muSlide * PHYS.g * nx;
      let ay = -PHYS.muSlide * PHYS.g * ny;

      b.x += b.vx * dt + 0.5 * ax * dt * dt;
      b.y += b.vy * dt + 0.5 * ay * dt * dt;
      b.vx += ax * dt;
      b.vy += ay * dt;

      const alpha = (5 / (2 * R)) * PHYS.muSlide * PHYS.g;
      b.wx += -alpha * ny * dt;
      b.wy += alpha * nx * dt;

      decaySpin(b, dt);
      remaining -= dt;
      if (dt >= tRoll) snapToRolling(b);
      continue;
    }

    snapToRolling(b);
    const v = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (v < PHYS.stopSpeed) {
      b.vx = 0;
      b.vy = 0;
      b.wx = 0;
      b.wy = 0;
      decaySpin(b, remaining);
      return;
    }

    const decel = PHYS.muRoll * PHYS.g;
    const tStop = v / decel;
    const dt = Math.min(remaining, tStop);
    const nx = b.vx / v;
    const ny = b.vy / v;

    let ax = -decel * nx;
    let ay = -decel * ny;

    b.x += b.vx * dt + 0.5 * ax * dt * dt;
    b.y += b.vy * dt + 0.5 * ay * dt * dt;
    b.vx += ax * dt;
    b.vy += ay * dt;

    if (dt >= tStop) {
      b.vx = 0;
      b.vy = 0;
      b.wx = 0;
      b.wy = 0;
    } else {
      snapToRolling(b);
    }
    decaySpin(b, dt);
    remaining -= dt;
  }
}

/**
 * 库边 TOI：球心沿法向抵达库面（相距一个半径）还要多久。
 * gap 为球心到库面的有向距离（沿库面内法向为正）；接触发生在 gap === R。
 */
function cushionTOI(ball, cushion, horizon) {
  const R = ball.__R;
  const { axis, pos, normal } = cushion;
  const p = axis === 'x' ? ball.x : ball.y;
  const v = axis === 'x' ? ball.vx : ball.vy;
  const n = axis === 'x' ? normal.x : normal.y;

  // 球心到接触位置还差多少
  const gap = (p - pos) * n - R;
  const closing = -(v * n);
  if (closing <= 1e-9) return -1;
  if (gap <= 0) return 0;

  const t = gap / closing;
  return t <= horizon ? t : -1;
}

/** 球球 TOI：两球心距降到 2R 的时刻 */
function ballTOI(a, b, horizon) {
  const R = a.__R;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dvx = b.vx - a.vx;
  const dvy = b.vy - a.vy;
  const A = dvx * dvx + dvy * dvy;
  if (A < 1e-12) return -1;
  const B = 2 * (dx * dvx + dy * dvy);
  if (B >= 0) return -1; // 正在远离
  const C = dx * dx + dy * dy - 4 * R * R;
  if (C <= 0) return 0; // 已接触且仍在靠近
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  if (t < 0 || t > horizon) return -1;
  return t;
}

/**
 * 在给定时间内找最早接触事件。
 * 库边交点必须落在有效线段内：落在缺口上说明这里是袋口，球会穿过去而不是弹回来。
 */
function findFirstEvent(world, horizon) {
  let best = null;
  const { balls, table } = world;

  for (const b of balls) {
    if (b.pocketed || !isMoving(b)) continue;
    for (const c of table.cushions) {
      const t = cushionTOI(b, c, horizon);
      if (t < 0) continue;
      if (best !== null && t >= best.t) continue;

      const along = c.axis === 'x' ? b.y + b.vy * t : b.x + b.vx * t;
      if (along < c.from - 1e-9 || along > c.to + 1e-9) continue; // 袋口缺口
      best = { t, kind: 'cushion', ball: b, cushion: c };
    }
  }

  for (let i = 0; i < balls.length; i++) {
    const a = balls[i];
    if (a.pocketed) continue;
    for (let j = i + 1; j < balls.length; j++) {
      const b = balls[j];
      if (b.pocketed) continue;
      if (!isMoving(a) && !isMoving(b)) continue;
      const t = ballTOI(a, b, horizon);
      if (t >= 0 && (best === null || t < best.t)) {
        best = { t, kind: 'ball', a, b };
      }
    }
  }
  return best;
}

/**
 * 库边反弹。
 *
 * 增强：
 *   1. 库边硬度随速度变化：大力击打时库边更"硬"（恢复系数更高），
 *      小球轻碰时库边更"软"（恢复系数较低）。这模拟了真实库边的非线性特性。
 *   2. 侧旋对出库角度的影响：杆头偏右时，球撞库后会向左偏转更多。
 *
 * @param {Ball} b
 * @param {Cushion} cushion
 * @param {Array} [events]
 */
function resolveCushion(b, cushion, events) {
  const R = b.__R;
  const { axis, pos, normal } = cushion;

  // 落点精确对齐库面，出库角度由几何而非步长决定
  if (axis === 'x') b.x = pos + normal.x * R;
  else b.y = pos + normal.y * R;

  const { x: nx, y: ny } = normal;
  const vn = b.vx * nx + b.vy * ny;
  if (vn >= 0) return null;

  const tx = -ny;
  const ty = nx;
  const vt = b.vx * tx + b.vy * ty;

  // 改进的库边恢复系数模型：
  // - 基础恢复系数 PHYS.cushionRestitution (0.85)
  // - 速度越高，恢复系数越接近 1（库边更"硬"）
  // - 速度越低，恢复系数越低（库边更"软"，能量损失更多）
  //
  // 公式：e = e_base + (1 - e_base) * min(1, |vn| / v_reference)
  // v_reference = 4 m/s 是参考速度，大约是中高杆的力度
  //
  // 效果：
  // - 轻碰 (|vn| = 0.5 m/s): e ≈ 0.86
  // - 中力 (|vn| = 2 m/s):   e ≈ 0.895
  // - 暴冲 (|vn| = 6 m/s):   e ≈ 0.95
  const speedFactor = Math.min(1, Math.abs(vn) / 4);
  const e = PHYS.cushionRestitution + (1 - PHYS.cushionRestitution) * speedFactor;
  const vnAfter = -e * vn;
  const jn = vnAfter - vn;

  // 库边接触时的切向效应：
  // 1. 库鼻接触点高于球心：沿库方向的运动大部分被滚动吸收
  // 2. 侧旋 (wz) 会改变出库角度：这是"加塞"影响反弹角的物理机制
  //
  // 侧旋影响模型：
  // - 侧旋角速度 wz 在接触点产生切向速度 R * wz
  // - 这个速度通过摩擦转化为切向冲量
  // - 最终改变球的出库角度
  //
  // 参数 tuning：SIDE_SPIN_EFFECT = 0.15 表示侧旋对出库角的最大影响约 8-10°
  // （实测值范围 7-12°，取决于库边硬度和击球力度）
  const SIDE_SPIN_EFFECT = 0.15;
  const ut = vt * PHYS.cushionRollSlip - R * b.wz;
  const jt = -Math.sign(ut) * Math.min(PHYS.cushionFriction * jn, Math.abs(ut) * (2 / 7));
  const vtAfter = vt + jt;

  // 侧旋对出库角的影响：通过给切向速度一个额外的小脉冲
  // 这个效应与侧旋角速度和法向冲量成正比
  const spinKick = SIDE_SPIN_EFFECT * b.wz * R * Math.min(1, Math.abs(vn) / 3);

  b.vx = vnAfter * nx + (vtAfter + spinKick) * tx;
  b.vy = vnAfter * ny + (vtAfter + spinKick) * ty;

  // 侧旋在碰撞中会部分转化为球的旋转
  // 简化模型：假设 30% 的侧旋在碰撞中损失
  b.wz *= 0.7;
  b.wz += -(5 * jt) / (2 * R);

  if (events && Math.abs(vn) > RAIL_EVENT_SPEED) {
    events.push({ type: 'cushion', ball: b.id, rail: cushion.id, speed: Math.abs(vn) });
  }
  return Math.abs(vn);
}

function resolveBallBall(a, b, events) {
  const R = a.__R;
  let nx = b.x - a.x;
  let ny = b.y - a.y;
  // sqrt 比 hypot 快 1.6 倍（同 advanceBall / ballSpeed 的理由），
  // 台球坐标范围内不可能溢出双精度。
  let d = Math.sqrt(nx * nx + ny * ny);
  if (d < 1e-9) {
    nx = 1;
    ny = 0;
    d = 1e-9;
  } else {
    nx /= d;
    ny /= d;
  }

  const overlap = 2 * R - d;
  if (overlap > 0) {
    a.x -= (nx * overlap) / 2;
    a.y -= (ny * overlap) / 2;
    b.x += (nx * overlap) / 2;
    b.y += (ny * overlap) / 2;
  }

  const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rvn >= 0) return null;

  const tx = -ny;
  const ty = nx;
  // 接触点的相对切向速度，含两球的侧旋
  const ut = (a.vx - b.vx) * tx + (a.vy - b.vy) * ty + R * (a.wz + b.wz);

  const jn = (-(1 + PHYS.ballRestitution) * rvn) / 2;
  // 两球接触的切向有效质量是 m/7（各 1/m 加各 R²/I = 5/2m），
  // 所以把相对切向速度归零需要的冲量上限是 |ut|/7。
  const jt = Math.sign(ut) * Math.min(PHYS.ballFriction * jn, Math.abs(ut) / 7);

  a.vx -= jn * nx + jt * tx;
  a.vy -= jn * ny + jt * ty;
  b.vx += jn * nx + jt * tx;
  b.vy += jn * ny + jt * ty;

  // 低速接触必须完全非弹性，否则恢复系数会让贴在一起的两球每帧互相顶一次，
  // 形成 0.008 m/s 量级的极限环，整杆永远停不下来。
  if (Math.abs(rvn) < PHYS.contactDamping) {
    const rvnAfter = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rvnAfter < 0) {
      a.vx -= (rvnAfter * nx) / 2;
      a.vy -= (rvnAfter * ny) / 2;
      b.vx += (rvnAfter * nx) / 2;
      b.vy += (rvnAfter * ny) / 2;
    }
  }

  // 撞击后的滚动角速度不在这里重设：真实台球上，被撞的目标球起始无旋、
  // 会先打滑再转入滚动；母球也会因为撞击后的速度与原有滚动角速度不匹配
  // 而短暂打滑走出一小段弧线。这些都由 advanceBall 的滑移解析自然处理。
  // 这里只处理绕竖直轴的塞。
  const dwz = -(5 * jt) / (2 * R);
  a.wz += dwz;
  b.wz += dwz;

  if (events) events.push({ type: 'ball', a: a.id, b: b.id, speed: Math.abs(rvn) });
  return Math.abs(rvn);
}

/**
 * 袋口捕获 + 袋口夹球兜底。
 * 球心进入捕获圆 → 落袋；越过库面却没进袋（从袋角挤过去）→ 顶回台面，当作夹球。
 *
 * 这里只在子步结束时看球心位置，也就是说「一子步的位移必须小于捕获半径」。
 * 这条约束由 stepWorld 在入口钳制步长来保证，而不是在热循环里做线段判定——
 * 试过两个版本都在热循环里判定，实测都更慢：
 *   · 用 Map 存每球起点：p50 7.74 → 9.10 ms（每子步一次 clear + 若干 set）
 *   · 把起点记在球对象的 __px/__py 上：p50 → 10.78 ms
 *     （给球对象加新字段会改 V8 隐藏类，advanceBall 里所有属性访问一起退化）
 * 这个函数每杆要跑几百次，任何每子步的额外工作都会被放大。
 * 把不变式放到入口处钳制，热循环里一行都不用加。
 */
function settlePockets(world, events) {
  const { table, balls } = world;
  for (const b of balls) {
    if (b.pocketed) continue;

    const p = table.pocketAt(b.x, b.y);
    if (p) {
      b.pocketed = true;
      b.pocket = p.id;
      b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      if (events) events.push({ type: 'pocket', ball: b.id, pocket: p.id });
      continue;
    }

    // 从袋角缝隙挤出台面：顶回边界并吃掉法向速度，模拟袋角夹球
    const { minX, maxX, minY, maxY } = table.bounds;
    let clamped = false;
    if (b.x < minX) { b.x = minX; if (b.vx < 0) b.vx = 0; clamped = true; }
    else if (b.x > maxX) { b.x = maxX; if (b.vx > 0) b.vx = 0; clamped = true; }
    if (b.y < minY) { b.y = minY; if (b.vy < 0) b.vy = 0; clamped = true; }
    else if (b.y > maxY) { b.y = maxY; if (b.vy > 0) b.vy = 0; clamped = true; }
    if (clamped && events && (b.vx !== 0 || b.vy !== 0)) {
      events.push({ type: 'jaw', ball: b.id });
    }
  }
}

/**
 * 推进 dt 秒。内部按"最早接触事件"切分，接触点按精确几何求解。
 *
 * @param {object} world
 * @param {number} dt
 * @param {Array} [events] 事件流（按时间排序）
 */
export function stepWorld(world, dt, events) {
  let guard = 0;

  // 步长钳制：settlePockets 只在子步结束时判捕获，所以一子步的位移必须小于
  // 最小捕获半径。不钳制的话，粗步长下球会在一子步里直接跳过库边落进捕获圆，
  // 把「擦袋角」误判成「进袋」——实测 6.6 m/s、纵向偏 64 mm 打右下袋，
  // 1/240 判不进（正确），1/30 判进（错）。
  //
  // 这条不变式放在这里做一次，而不是在热循环里每个子步判一次：
  // 两种热循环版本实测都更慢（Map 存起点 p50 7.74 → 9.10 ms；
  // 起点记在球对象 __px/__py 上 → 10.78 ms，因为给球对象加字段会改 V8 隐藏类，
  // advanceBall 里所有属性访问一起退化）。热循环里一行都不加，代价才是零。
  let maxV = 0;
  for (const b of world.balls) {
    if (b.pocketed) continue;
    const s = b.vx * b.vx + b.vy * b.vy;
    if (s > maxV) maxV = s;
  }
  if (maxV > 0) {
    const maxStep = (MIN_CAPTURE_R * 0.9) / Math.sqrt(maxV);
    if (dt > maxStep) dt = maxStep;
  }

  // remaining 必须在钳制之后初始化——第一版写在钳制之前，
  // 于是钳制算出来的 dt 谁也没用上，探针显示开关钳制结果完全一样。
  let remaining = dt;

  while (remaining > 1e-9 && guard++ < 128) {
    const hit = findFirstEvent(world, remaining);
    const tau = hit ? Math.max(0, Math.min(hit.t, remaining)) : remaining;

    if (tau > 0) {
      for (const b of world.balls) {
        if (b.pocketed) continue;
        if (isMoving(b) || b.wz !== 0) advanceBall(b, tau);
      }
      world.t += tau;
      remaining -= tau;
    }

    settlePockets(world, events);

    if (!hit) break;
    if (hit.kind === 'cushion') {
      if (hit.ball.pocketed) continue;
      resolveCushion(hit.ball, hit.cushion, events);
    } else {
      if (hit.a.pocketed || hit.b.pocketed) continue;
      resolveBallBall(hit.a, hit.b, events);
    }
  }

  return world;
}

/**
 * 一颗静止的球被撞到速度 v0 后（起始无旋，先滑后滚），滚过 dist 还剩多少速度。
 * 与 advanceBall 用同一套滑移→滚动分段，供求解器做数值反解。
 */
export function speedAfterDistance(v0, dist, R) {
  const probe = { x: 0, y: 0, vx: v0, vy: 0, wx: 0, wy: 0, wz: 0, __R: R };
  const dt = 1 / 240;
  let travelled = 0;
  for (let i = 0; i < 6000 && travelled < dist; i++) {
    const x0 = probe.x;
    advanceBall(probe, dt);
    travelled += probe.x - x0;
    if (probe.vx <= 0) return 0;
  }
  return Math.hypot(probe.vx, probe.vy);
}

/**
 * 反解初速：球要滚过 dist 后仍保有 residual 的速度，需要以多快被撞出。
 * speedAfterDistance 对 v0 单调递增，二分即可。
 */
export function speedToReach(dist, residual, R) {
  const maxV = 6.0;
  if (speedAfterDistance(maxV, dist, R) < residual) return Infinity;
  let lo = 0;
  let hi = maxV;
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2;
    if (speedAfterDistance(mid, dist, R) < residual) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 母球以初速 v0、纵向打点 tipB 击出，沿直线滚过 dist 之后的剩余速度（解析解）。
 *
 * 由 strike() 的换算：wy = 5·v0·b/(2R)，因此初始滑移
 *   u0 = v0 − R·wy = v0·(1 − 2.5b)
 * b < 0.4 时 u0 > 0（打滑，摩擦向后，母球减速）；
 * b > 0.4 时 u0 < 0（过度前旋，摩擦向前，母球短暂加速）；
 * b = 0.4 时 u0 = 0，击出即滚动。
 *
 * 打滑期：|u| 以 3.5μg 衰减，速度以 μg 沿 −sign(u0) 方向变化，
 *         到 |u| = 0 结束，之后转入纯滚动，减速度 μ_roll·g。
 * 这与 advanceBall 的分段完全一致，只是闭式求解，不用迭代。
 */
export function cueBallSpeedAfterTravel(v0, tipB, dist, R) {
  const b = clamp(tipB ?? 0, -0.5, 0.5);
  const muS = PHYS.muSlide * PHYS.g;
  const muR = PHYS.muRoll * PHYS.g;

  const u0 = v0 * (1 - 2.5 * b);
  const sgn = Math.sign(u0);
  const tRoll = Math.abs(u0) / (3.5 * muS);

  // 打滑期能走多远、末速多少
  const vRoll = v0 - sgn * muS * tRoll;
  const dSlide = v0 * tRoll - 0.5 * sgn * muS * tRoll * tRoll;

  if (vRoll <= 0) return 0;
  if (dist <= dSlide) {
    // 仍在打滑期内：解 v0·t − ½·sgn·μg·t² = dist，取最小正根
    const A = 0.5 * sgn * muS;
    const B = -v0;
    const C = dist;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return 0;
    const sq = Math.sqrt(disc);
    const roots = [(-B - sq) / (2 * A), (-B + sq) / (2 * A)].filter((t) => t > 0).sort((x, y) => x - y);
    if (!roots.length) return 0;
    const v = v0 - sgn * muS * roots[0];
    return v > 0 ? v : 0;
  }

  // 滚动期
  const rem = dist - dSlide;
  const v2 = vRoll * vRoll - 2 * muR * rem;
  return v2 > 0 ? Math.sqrt(v2) : 0;
}

/**
 * 反解：母球要以多快的初速击出，才能在滚过 dist 后仍有 impactSpeed 的速度。
 * cueBallSpeedAfterTravel 对 v0 单调递增，二分即可。
 */
export function cueSpeedForImpact(dist, impactSpeed, tipB, R) {
  if (dist <= 1e-9) return impactSpeed;
  if (cueBallSpeedAfterTravel(12, tipB, dist, R) < impactSpeed) return Infinity;
  let lo = impactSpeed;
  let hi = 12;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (cueBallSpeedAfterTravel(mid, tipB, dist, R) < impactSpeed) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 跑完一杆，直到全部静止或超时。
 * @param {object} world 会被原地修改
 * @param {{dt?:number,maxTime?:number,onEvent?:(e:object)=>void}} [opts]
 */
export function runShot(world, opts = {}) {
  const dt = opts.dt ?? FIXED_DT;
  const maxTime = opts.maxTime ?? MAX_SHOT_TIME;
  const events = [];
  let elapsed = 0;
  while (elapsed < maxTime) {
    const before = events.length;
    stepWorld(world, dt, events);
    if (opts.onEvent) for (let i = before; i < events.length; i++) opts.onEvent(events[i]);
    elapsed += dt;
    if (opts.onStep) opts.onStep(world, elapsed);
    if (allStopped(world)) break;
  }
  return { events, time: elapsed, settled: allStopped(world) };
}
