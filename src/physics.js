// 2D 台球刚体物理：滑动/滚动双阶段 + 事件驱动接触求解。
//
// 设计来源与许可（本项目 MIT，下列引用均兼容）
//   骨架（滑动→滚动解析切换、事件驱动 TOI、库边切向冲量、球球甩球）
//   参考 ctbot000/three-cushion-billiards (MIT)。本文件按其思路重写并扩展：
//     · 支持带袋口的台面（原项目是开伦台，无袋）
//     · 支持任意球台尺寸 / 球半径 / 质量
//     · 增加袋口捕获、护角反弹与出界兜底
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
/**
 * 侧旋对出库角的影响强度（`resolveCushion` 里的 spinKick 系数）。
 * 0.15 对应侧旋带来的出库角偏移上限约 8-10°，实测值域 7-12°。
 */
const SIDE_SPIN_EFFECT = 0.15;

// ---------------------------------------------------------------- 热路径常量
//
// advanceBall 每杆要跑上万次（stepWorld 每子步、每颗在动的球一次），里面反复出现
// `PHYS.muSlide * PHYS.g`、`3.5 * PHYS.muSlide * PHYS.g`、`5 * PHYS.muSpin * PHYS.g`
// 这几条属性链。PHYS 是冻结的字面量，这些值在进程生命周期里不会变，所以在模块加载时
// 算一次即可。
//
// 等价性：下面每一行的**表达式与原来逐字相同**（包括乘法的先后次序），只是把求值时机
// 从「每次调用」挪到「模块加载」。IEEE-754 的加减乘除是确定性的，同样的操作数、同样的
// 次序，得到的双精度位模式必然相同，因此轨迹逐位不变。
//
// 唯一一处看起来像重排的地方是 advanceBall 里的 `-MU_SLIDE_G * nx`（原来是
// `-PHYS.muSlide * PHYS.g * nx`）。按 IEEE-754，取负只翻符号位、不参与舍入，
// 所以 (-a)*b 与 -(a*b) 的位模式完全一致，两者都等于 ((-(muSlide*g)) * nx)。
const MU_SLIDE_G = PHYS.muSlide * PHYS.g;
/** 滑移衰减率 3.5·μ_slide·g（打滑段 tRoll = |u| / 这个值） */
const SLIDE_DECEL = 3.5 * PHYS.muSlide * PHYS.g;
const MU_ROLL_G = PHYS.muRoll * PHYS.g;
/** 塞的衰减率分子 5·μ_spin·g，实际衰减率还要除以 2R */
const SPIN_RATE_NUM = 5 * PHYS.muSpin * PHYS.g;
/** 判停速度（原来每次循环重读 PHYS.stopSpeed） */
const STOP_SPEED = PHYS.stopSpeed;
/**
 * SLIP_EPS 的平方。advanceBall 用它做「这一子步打不打滑」的判断：`u2 > SLIP_EPS²`
 * 与 `sqrt(u2) > SLIP_EPS` 等价（sqrt 单调且正确舍入），差别只在 sqrt 恰好舍入到
 * SLIP_EPS 的 1 ulp 邻域时会翻——那条带上 tRoll 趋于 0，两支结果一致。
 * 这样纯滚动的调用不必为了一个用不到的 uLen 白付一次 sqrt。
 */
const SLIP_EPS2 = SLIP_EPS * SLIP_EPS;

// ---------------------------------------------------------------- 袋口几何
//
// 袋口只做两件事，都用同一套几何：捕获圆（球心进入即落袋）+ 护角反弹
// （越过库面却没进袋的球，按袋角橡皮的恢复系数弹回台内，方向由入射角决定）。
// 刻意**不**加"袋口弧度的吸引力"这一类近似：曾经加过一版指向袋心的径向漏斗力
// （0.3 g、1.5 倍捕获半径内生效），实测把贴库平行滚过中袋的球和中远台擦边球
// 全吸进袋，与台面几何自带的捕获圆判定重复，且没有任何校准数据支撑那两个常数
// ——已删除。
//
// 护角那一半也返过工：最早是把越过库面的球法向速度直接清零，等于球一碰袋角
// 就死在原地，接着常被当成落袋（实测把被挤进右下袋死角的球判成进袋）。
// 现在复用库边响应，只把恢复系数换成 PHYS.jawRestitution（0.55，库面 0.85）
// 并关掉侧旋增益——护角是粗糙实心橡皮，侧旋在那吃不住力。
// 要更接近真实，正确做法是按护角实际斜面做接触求解，而不是叠加一个吸力。

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
    // 这里**不**给 number 默认值。以前默认 0，于是「漏传 number 的新球」会被
    // 判成母球（0 号就是母球），母球身份因此多了一条谁也想不到的来源。
    // 现在没给 number 就是 undefined，isCueBall 不认它，必须显式写 0 或 id 'cue'。
    ...extra,
  };
}

/**
 * 母球身份的唯一判定。
 *
 * 以前仓库里有两种写法（`number === 0 || id === 'cue'` 与只判 `number === 0`），
 * 同一颗球在两处可以得到不同答案。统一成这一处：显式 0 号，或者显式 id 'cue'。
 * 注意 `number` 缺省（undefined）**不算**母球——这正是 createBall 不再默认 0 的原因。
 *
 * @param {{ number?: number, id?: string } | null | undefined} ball
 * @returns {boolean}
 */
export function isCueBall(ball) {
  if (!ball) return false;
  return ball.number === 0 || ball.id === 'cue';
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

// 这里曾有 isMoving(b)：曾用于「这颗球这一子步还要不要推进」的判断，返回
// `b.vx !== 0 || b.vy !== 0`。生产代码与测试都零调用，唯一等价表达式已内联在
// stepWorld 里的 `b.vx !== 0 || b.vy !== 0 || b.wz !== 0`（多判了侧旋，判据更全），
// 故删除，不留只有导出、没人走的符号。

export function allStopped(world) {
  // 索引 for 而不是 some + 箭头函数：这个函数每杆要跑几百次（runShot 每步一次），
  // 回调闭包在这里没有收益，只有每步一次的可内联机会。
  const balls = world.balls;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) return false;
  }
  return true;
}

/** 台呢接触点的滑移速度，摩擦作用在这个量上 */
export function slipOf(b) {
  const R = b.__R;
  return { x: b.vx - R * b.wy, y: b.vy + R * b.wx };
}

// 这里原有 snapToRolling(b) 与 decaySpin(b, dt) 两个小函数，它们只被 advanceBall
// 调用（各 2 / 3 处），每次进入都要重新读一遍 R 与 PHYS.* 属性链、再走一次不可内联的
// 调用。2026-11 的性能改造把它们就地展开在 advanceBall 的两个分支里：
//   · snapToRolling → `b.wy = b.vx / R; b.wx = -b.vy / R;`（除法按要求原样保留，
//     没有换成乘倒数——换成倒数会在末位引入差异）
//   · decaySpin     → `if (wz !== 0) { rate = SPIN_RATE_NUM / (2*R); drop = rate*dt; ... }`
// 展开后运算顺序、结合性与原来逐字相同，只是省掉调用与重复的属性读取。

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
  // 5/(2R)、μ_slide、g 都只在打滑分支里用得到，已经挪进那条分支（纯滚动时一次都不算）。

  // 球的状态先搬到局部量，末尾一次性写回。
  //
  // 为什么：一次 advanceBall 通常只走 1–2 段，但每段都要把同一批字段读写 4–8 次
  // （vx/vy 各两次、wx/wy 各两次、x/y 各一次）。逐次走 `b.xxx` 时每次都是一次属性
  // 加载，写的时候还是一次装箱写（球对象是混合类型字面量，double 字段是装箱存储）。
  // 这个函数占物理核自身耗时的 45%，是第一名热点。
  //
  // 等价性：局部量的每次运算与原来 `b.xxx += ...` 右侧的表达式**逐字相同**（含
  // 乘法次序与结合性），只是把「读一次、算、写回」挪成「开头读一次、末尾写一次」。
  // advanceBall 是叶子函数，循环体里不调用任何能观察这颗球的代码，所以写回时机
  // 不影响任何被读到的值；循环体从未执行时写回的是原值本身。
  let x = b.x;
  let y = b.y;
  let vx = b.vx;
  let vy = b.vy;
  let wx = b.wx;
  let wy = b.wy;
  let wz = b.wz;
  let remaining = tau;
  let guard = 0;

  while (remaining > 1e-12 && guard++ < 8) {
    const ux = vx - R * wy;
    const uy = vy + R * wx;
    // 先算平方和判分支，只有真的要打滑时才开方。
    // 纯滚动时 ux/uy 是 snapToRolling 之后的残差（量级 1e-17），而 uLen 这个数在
    // 滚动/静止两条分支里都用不到——每次调用白付一次 sqrt。
    // 等价性：下面用的 uLen = Math.sqrt(u2) 与原来 Math.sqrt(ux*ux+uy*uy) 逐位相同
    // （同一个 u2 当参数，只是挪了求值位置）；判断式换成 u2 > SLIP_EPS² 与
    // sqrt(u2) > SLIP_EPS 只在「sqrt(u2) 恰好舍入到 SLIP_EPS 的 1 ulp 邻域」这一条
    // 窄带上可能不同，而那条带上 tRoll 趋于 0、段长趋于 0，两支给出同一状态。
    // 这条窄带在 6 个 fixture（含开球 53 事件、库边、薄球）与 48 局面上都没触发：
    // 轨迹 SHA256 与内联前逐位一致。
    const u2 = ux * ux + uy * uy;

    if (u2 > SLIP_EPS2) {
      const uLen = Math.sqrt(u2);
      // 5/(2R)、μ_slide、g 只在这条分支里用得到：纯滚动的调用不该付这次除法。
      // 表达式与原来逐字相同，只是求值时机从「每次调用」挪到「真的打滑时」。
      const k5 = 5 / (2 * R);
      const muSlide = PHYS.muSlide;
      const grav = PHYS.g;
      // 打滑：滑移以 3.5·μ·g 衰减，比球速衰减快，所以一定会转入滚动
      const tRoll = uLen / SLIDE_DECEL;
      const dt = Math.min(remaining, tRoll);
      const nx = ux / uLen;
      const ny = uy / uLen;
      // 按 IEEE-754，取负只翻符号位、不参与舍入，所以这里与原来的
      // `-PHYS.muSlide * PHYS.g * nx`（即 ((-μ)·g)·nx）逐位相同。
      const ax = -MU_SLIDE_G * nx;
      const ay = -MU_SLIDE_G * ny;

      x += vx * dt + 0.5 * ax * dt * dt;
      y += vy * dt + 0.5 * ay * dt * dt;
      vx += ax * dt;
      vy += ay * dt;

      // 原来是 (5/(2R))·μ·g，结合性保持 ((k5·μ)·g)
      const alpha = k5 * muSlide * grav;
      wx += -alpha * ny * dt;
      wy += alpha * nx * dt;

      // decaySpin(b, dt) 内联：塞按 rate = 5·μ_spin·g/(2R) 线性衰减，到 0 为止
      if (wz !== 0) {
        const drop = (SPIN_RATE_NUM / (2 * R)) * dt;
        if (Math.abs(wz) <= drop) wz = 0;
        else wz -= Math.sign(wz) * drop;
      }

      remaining -= dt;
      if (dt >= tRoll) {
        // snapToRolling(b) 内联：除法原样保留（不换乘倒数，否则末位会变）
        wy = vx / R;
        wx = -vy / R;
      }
      continue;
    }

    // 这里原本还有一次 snapToRolling(b)：它写的 wx/wy 在本轮里没有被读过——
    // v 与 nx/ny 只取 vx/vy，两次分支末尾（清零 / 重算）都会把 wx/wy 覆盖掉，
    // 所以那次调用是纯粹白做的两次除法 + 两次写。删掉它不改变任何被读到的值。
    const v = Math.sqrt(vx * vx + vy * vy);
    if (v < STOP_SPEED) {
      vx = 0;
      vy = 0;
      wx = 0;
      wy = 0;
      // decaySpin(b, remaining) 内联（静止分支用的是剩余时长，不是 dt）
      if (wz !== 0) {
        const drop = (SPIN_RATE_NUM / (2 * R)) * remaining;
        if (Math.abs(wz) <= drop) wz = 0;
        else wz -= Math.sign(wz) * drop;
      }
      break; // 原来是 return：末尾统一写回，效果相同（写回的就是当前值）
    }

    const tStop = v / MU_ROLL_G;
    const dt = Math.min(remaining, tStop);
    const nx = vx / v;
    const ny = vy / v;

    const ax = -MU_ROLL_G * nx;
    const ay = -MU_ROLL_G * ny;

    x += vx * dt + 0.5 * ax * dt * dt;
    y += vy * dt + 0.5 * ay * dt * dt;
    vx += ax * dt;
    vy += ay * dt;

    if (dt >= tStop) {
      vx = 0;
      vy = 0;
      wx = 0;
      wy = 0;
    } else {
      // snapToRolling(b) 内联
      wy = vx / R;
      wx = -vy / R;
    }
    // decaySpin(b, dt) 内联
    if (wz !== 0) {
      const drop = (SPIN_RATE_NUM / (2 * R)) * dt;
      if (Math.abs(wz) <= drop) wz = 0;
      else wz -= Math.sign(wz) * drop;
    }
    remaining -= dt;
  }

  b.x = x;
  b.y = y;
  b.vx = vx;
  b.vy = vy;
  b.wx = wx;
  b.wy = wy;
  b.wz = wz;
}

/**
 * 库边 TOI：球心沿法向抵达库面（相距一个半径）还要多久。
 * gap 为球心到库面的有向距离（沿库面内法向为正）；接触发生在 gap === R。
 *
 * 与下面的 ballTOI 一起导出，只为让 test/physics-event-buffer.test.js 能逐字复刻
 * findFirstEvent 的旧实现做等价性比对（旧实现的骨架留在那个测试里）。物理核内部
 * 只经 findFirstEvent 使用它们，不构成对外的稳定 API。
 */
export function cushionTOI(ball, cushion, horizon) {
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
export function ballTOI(a, b, horizon) {
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
 * findFirstEvent 的复用缓冲。
 *
 * 旧写法每子步 new 一个 moving 数组、命中时再 new 一个 best 对象；单杆 500+ 子步、
 * 单次求解几十杆，一次求解就是两万次以上分配（profile 里 GC 稳定占 5% 上下）。
 * 这里换成调用方复用的单一缓冲：所有字段在字面量里一次初始化，形状固定不再增删，
 * 因此隐藏类唯一。注意这是**独立缓冲对象**，不是往球对象上加字段——
 * 给球对象动态加字段会让隐藏类退化，advanceBall 里的属性访问会一起变慢。
 *
 * 无重入风险：findFirstEvent 只被 stepWorld 调用，返回值在同一个子步内就地消费完，
 * 消费过程中不会再调一次 findFirstEvent；执行模型是单线程、那一段里没有回调。
 */
const EVENT_SCRATCH = { moving: [], t: 0, kind: '', ball: null, cushion: null, a: null, b: null };

/**
 * 库边剪枝的命中计数（仅测试用，对应 test/physics-event-buffer.test.js 的触发断言）。
 *
 * 剪枝是纯上界优化：被剪掉的那些子步在原实现里本来也只是白扫一遍 6 条库边、然后不填
 * best，结果逐位相同，所以**等价性断言抓不到剪枝失效**——它悄悄退化成完全等于旧实现，
 * 性能却回到剪枝之前。这里放一个模块级整数，剪枝分支每跳过一次库边扫描就 +1，让
 * 「剪枝真的发生了」变成可观测的事实。
 *
 * 开销约束：只是热循环里的一次整数自增，不分配对象、不调函数、不打日志，
 * 也不改变任何返回值（读它只在测试里）。
 */
let pruneHits = 0;

/** @returns {number} 自上次 resetPruneHitCount 以来，被剪枝跳过的「球 × 子步」数 */
export function pruneHitCount() {
  return pruneHits;
}

/** 清零剪枝计数（测试用） */
export function resetPruneHitCount() {
  pruneHits = 0;
}

/**
 * 在给定时间内找最早接触事件。
 * 库边交点必须落在有效线段内：落在缺口上说明这里是袋口，球会穿过去而不是弹回来。
 *
 * 命中时把结果写进调用方传入的 buffer 并返回它（同一对象会被下一次子步覆盖，
 * 只在同一个子步内有效）；没有事件返回 null。
 *
 * @param {object} world
 * @param {number} horizon
 * @param {{moving:Array, t:number, kind:string, ball:any, cushion:any, a:any, b:any}} [buffer]
 */
export function findFirstEvent(world, horizon, buffer = EVENT_SCRATCH) {
  const balls = world.balls;
  const cushions = world.table.cushions;
  const moving = buffer.moving;
  let count = 0;

  // 每子步都要跑一遍，是全流程最热的地方（CPU profile 里占 15%~20%）。
  // 旧写法对每一对球都算一次 TOI：15 颗球就是 105 对，而大多数时刻只有一颗在动。
  // 这里先挑出「在动」的那几颗，只让运动球去和别的球求交——静止球之间永远不会相撞。
  // 代价是一次 O(n) 的筛选，换掉 O(n²) 的求交。
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (!b.pocketed && (b.vx !== 0 || b.vy !== 0)) moving[count++] = b;
  }
  if (count === 0) return null;

  let hasBest = false;
  let bestT = 0;

  // 库边剪枝上界：自由飞行段最大的加速度来自打滑摩擦（μg，滚动段只有 0.01g），所以
  //   |Δx| ≤ |vx|·h + ½·μg·h²，|Δy| 同理。
  // 台面四面壁承载了全部库边（角袋与中袋的护角也是壁上的线段），于是
  // 「球面到最近一面壁的距离 > 该方向位移上界」时这一子步内不可能碰到任何库边，
  // 那 6 次库边 TOI 可以整段跳过。这是纯上界剪枝：跳过的前提是「确实没有库边事件」，
  // 而原实现在这种情况下本来也只是白扫一遍后不填 best，所以结果逐位相同。
  // 1e-9 是防止浮点舍入把上界拉低到真实位移之下（只往安全方向放大）。
  const accelBound = PHYS.muSlide * PHYS.g;
  const slack = 0.5 * accelBound * horizon * horizon + 1e-9;
  const tableLength = world.table.length;
  const tableWidth = world.table.width;

  // 库边先扫：同 t 时库边优先，与原实现的比较顺序（先库边、后球球）保持一致。
  for (let mi = 0; mi < count; mi++) {
    const b = moving[mi];
    const R = b.__R;
    const dxMax = Math.abs(b.vx) * horizon + slack;
    const dyMax = Math.abs(b.vy) * horizon + slack;
    if (
      b.x - R > dxMax &&
      tableLength - R - b.x > dxMax &&
      b.y - R > dyMax &&
      tableWidth - R - b.y > dyMax
    ) {
      pruneHits++; // 仅测试可观测的整数自增，见顶部 pruneHits 的注释
      continue; // 离四面壁都远过这一子步能走的距离
    }
    for (let ci = 0; ci < cushions.length; ci++) {
      const c = cushions[ci];
      const t = cushionTOI(b, c, horizon);
      if (t < 0) continue;
      if (hasBest && t >= bestT) continue;

      const along = c.axis === 'x' ? b.y + b.vy * t : b.x + b.vx * t;
      if (along < c.from - 1e-9 || along > c.to + 1e-9) continue; // 袋口缺口
      hasBest = true;
      bestT = t;
      buffer.t = t;
      buffer.kind = 'cushion';
      buffer.ball = b;
      buffer.cushion = c;
    }
  }

  // 两颗都在动时这一对会被看两遍（a→b 一次、b→a 一次），取最小值的结果不变；
  // 换来的是不必再为「谁是第几号」做一次查表。
  for (let mi = 0; mi < count; mi++) {
    const a = moving[mi];
    for (let j = 0; j < balls.length; j++) {
      const b = balls[j];
      if (b === a || b.pocketed) continue;
      const t = ballTOI(a, b, horizon);
      if (t >= 0 && (!hasBest || t < bestT)) {
        hasBest = true;
        bestT = t;
        buffer.t = t;
        buffer.kind = 'ball';
        buffer.a = a;
        buffer.b = b;
      }
    }
  }

  // 清掉尾部残留的球引用，免得复用缓冲把上一局的球一直按在内存里。
  if (moving.length > count) moving.length = count;
  return hasBest ? buffer : null;
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
function resolveCushion(b, cushion, events, opts = {}) {
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
  // - 基础恢复系数 PHYS.cushionRestitution (0.85)，袋角用 PHYS.jawRestitution (0.55)
  // - 速度越高，恢复系数越接近上限（库边更"硬"）
  // - 速度越低，恢复系数越低（库边更"软"，能量损失更多）
  //
  // 公式：e = e_base + (e_max - e_base) * min(1, |vn| / cushionSpeedRef)
  // cushionSpeedRef = 4 m/s 是参考速度，大约是中高杆的力度
  //
  // e_max 必须严格小于 1（PHYS.cushionRestitutionMax = 0.95）。以前这里写的
  // 是 e_base + (1 - e_base) * factor，|vn| >= 4 m/s 时 e 饱和到 1.0，也就是
  // 大力撞库完全不损失法向能量。完全弹性库边在真台球上不存在，而且这一项
  // 恰恰是下面切向那部分唯一可以合法动用的能量来源——e 一旦等于 1，
  // 加塞项凭空多出来的切向速度就一分钱都不用付，原样带进出库速度。
  //
  // 效果：
  // - 轻碰 (|vn| = 0.5 m/s): e ≈ 0.863
  // - 中力 (|vn| = 2 m/s):   e ≈ 0.90
  // - 暴冲 (|vn| = 6 m/s):   e = 0.95（不再到 1.0）
  const baseE = opts.restitution ?? PHYS.cushionRestitution;
  const maxE = opts.maxRestitution ?? PHYS.cushionRestitutionMax;
  const speedFactor = Math.min(1, Math.abs(vn) / PHYS.cushionSpeedRef);
  const e = baseE + (maxE - baseE) * speedFactor;
  const vnAfter = -e * vn;
  const jn = vnAfter - vn;

  // 库边接触时的切向效应：
  // 1. 库鼻接触点高于球心：沿库方向的运动大部分被滚动吸收
  // 2. 侧旋 (wz) 会改变出库角度：这是"加塞"影响反弹角的物理机制
  //
  // 切向冲量 jt 与它引起的角冲量 -(5*jt)/(2R) 是一对力偶，配对结算后
  //   ΔE = jt * (vt - R*wz) + (7/4) * jt²
  // 只要 |jt| <= |vt - R*wz| / (7/2)，这一对就只减不增。
  //
  // 以前滑移写成 u = vt * cushionRollSlip - R*wz，侧旋与切向速度反向时
  // 把滑移夸大到 1.6 倍（实测 8.86 对真实接触点滑移 5.51 m/s），冲量
  // 越过「把滑移归零」那个点之后，摩擦就开始对球做正功，单库给母球加 0.8 J。
  // 修法不是改滑移（u 还是那个唯象的等效滑移，wz = 0 时与以前逐位相同），
  // 而是给冲量加一条上界：不许超过「让真实接触点滑移归零」所需的冲量。
  // 有了这条上界 |jt| <= |vt - R*wz| / (7/2)，上面那对力偶的 ΔE 恒 <= 0。
  const ut = vt * PHYS.cushionRollSlip - R * b.wz;
  const jtCap = Math.abs(vt - R * b.wz) * (2 / 7);
  const jt = -Math.sign(ut) *
    Math.min(PHYS.cushionFriction * jn, Math.abs(ut) * (2 / 7), jtCap);
  const vtAfter = vt + jt;

  // 侧旋在碰撞中会部分转化为球的旋转
  // 简化模型：假设 30% 的侧旋在碰撞中损失，再叠加切向冲量的角冲量
  b.wz = b.wz * 0.7 - (5 * jt) / (2 * R);

  // 侧旋对出库角的最大影响约 8-10°（实测值范围 7-12°，取决于库边硬度和击球力度）。
  // 袋角连带 opts.spinKick === false 关掉这一项：护角是粗糙的实心橡皮，
  // 侧旋在那里基本吃不住，再套库边的侧旋模型只会凭空造出角度。
  //
  // 这一项是唯象项（不是从冲量积分推出来的），所以它只能花「这次碰撞已经
  // 放掉的能量」：法向损失 (1 - e²)vn² 是唯一预算，出库合速度不得超过入射
  // 合速度。以前 kick 用碰撞前的 wz，代价只是「wz 乘 0.7」——两者量纲都不
  // 成对（kick 直接改速度，0.7 只削自旋能量），而且那 0.7 早就被 jt 的角
  // 冲量占用了一次。实测 a=+0.5 时每撞一次库净赚 1.07 J。现在 kick 用碰撞
  // 之后的 wz，并把切向速度夹进上面那个预算里。
  const spinKick = opts.spinKick === false
    ? 0
    : SIDE_SPIN_EFFECT * b.wz * R * Math.min(1, Math.abs(vn) / 3);
  const vtBudget = Math.sqrt(vt * vt + (1 - e * e) * vn * vn);
  const vtOut = clamp(vtAfter + spinKick, -vtBudget, vtBudget);

  b.vx = vnAfter * nx + vtOut * tx;
  b.vy = vnAfter * ny + vtOut * ty;

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
 * 袋口捕获 + 护角反弹。
 * 球心进入捕获圆 → 落袋；越过库面却没进袋（从袋角挤过去）→ 按护角橡皮弹回台面。
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
  const { minX, maxX, minY, maxY } = table.bounds;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
    if (b.pocketed) continue;

    // 静止且已经在台面内的球：既不可能刚滚进袋口，也不可能撞在护角上。
    // 这个函数每子步都要把所有球过一遍，而绝大多数时刻只有一两颗在动——
    // 省掉静止球的那次 pocketAt（6 个袋口各一次距离判断）和越界判断。
    // 唯一的边界情形是「球在某个子步里刚好停在捕获圆内」：那一步它就会被判进袋，
    // 所以下一子步进来时它要么已 pocketed，要么在圆外。
    if (b.vx === 0 && b.vy === 0 && b.x >= minX && b.x <= maxX && b.y >= minY && b.y <= maxY) {
      continue;
    }

    const p = table.pocketAt(b.x, b.y);
    if (p) {
      b.pocketed = true;
      b.pocket = p.id;
      b.vx = b.vy = b.wx = b.wy = b.wz = 0;
      if (events) events.push({ type: 'pocket', ball: b.id, pocket: p.id });
      continue;
    }

    // 从袋口缝隙挤出台面：这不是「掉出台面」，是撞在护角橡皮上。
    // 以前只把法向速度清零，等于球一碰袋角就死在那里；真实的袋角会把球弹回来，
    // 弹回来的方向由入射角决定——贴库薄球到底是被弹回台面还是滚进袋，
    // 差的就是这一下。这里复用库边响应，只换恢复系数（袋角软得多）并关掉侧旋增益
    // （护角是粗糙实心橡皮，侧旋在那吃不住力）。
    const rails = [];
    if (b.x < minX) rails.push({ axis: 'x', pos: 0, normal: { x: 1, y: 0 } });
    else if (b.x > maxX) rails.push({ axis: 'x', pos: table.length, normal: { x: -1, y: 0 } });
    if (b.y < minY) rails.push({ axis: 'y', pos: 0, normal: { x: 0, y: 1 } });
    else if (b.y > maxY) rails.push({ axis: 'y', pos: table.width, normal: { x: 0, y: -1 } });

    for (let r = 0; r < rails.length; r++) {
      const rail = rails[r];
      const vn = b.vx * rail.normal.x + b.vy * rail.normal.y;
      const speedBefore = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      resolveCushion(
        b,
        { id: 'jaw', ...rail },
        null,
        // 护角同样是橡皮，恢复系数也不许饱和到 1.0；上限沿用库边那个 0.95。
        // 0.55 → 0.95 的曲线在袋角常见入射速度（0.2-1.5 m/s）下与旧曲线差不到 2%，
        // 只有暴冲级别的护角碰撞才从「完全弹性」降到 0.95。
        {
          restitution: PHYS.jawRestitution,
          maxRestitution: PHYS.cushionRestitutionMax,
          spinKick: false,
        }
      );
      if (events && vn < 0 && speedBefore > RAIL_EVENT_SPEED) {
        events.push({ type: 'jaw', ball: b.id, speed: speedBefore });
      }
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
  const balls = world.balls;
  for (let i = 0; i < balls.length; i++) {
    const b = balls[i];
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
    const hit = findFirstEvent(world, remaining, EVENT_SCRATCH);
    const tau = hit ? Math.max(0, Math.min(hit.t, remaining)) : remaining;

    if (tau > 0) {
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.pocketed) continue;
        if (b.vx !== 0 || b.vy !== 0 || b.wz !== 0) advanceBall(b, tau);
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
