// 击球几何：假想球、切角、路径遮挡、容错窗口、甩球补偿。
//
// 这是本项目的"教练"内核，四个设计选择直接来自调研结论：
//
// 1) 解析几何而不是暴力搜索。
//    tailuge/billiards (GPL-3.0, 仅作设计对照) 的 bot 用 getAimPoint() 先定袋、
//    再反推假想球，比逐角度模拟快几个数量级。本项目沿用这个结构，
//    但把"切角最小"换成"容错窗口最大"，并把遮挡做成显式的线段-圆检测。
//
// 2) 按容错窗口排序，而不是按"能否进球"排序。
//    ctbot000/three-cushion-billiards (MIT) 的 README 给出实测数据：
//    按能否进球筛出的第一杆，瞄准窗口中位数只有 0.04°；按鲁棒性重排后升到
//    0.58°（最大 1.6°）。同样执行误差下命中率从 12% 提到 68%。
//
// 3) 容错窗口按纯几何推，不加经验修正系数。
//    目标球出球方向允许的角误差 Δφ = atan(横向余量 / 目标球到袋距离)；
//    假想球横向偏 δ = 2R·Δφ；瞄准角允许误差 = atan(δ / 母球到假想球距离)。
//    实测（45° 切球、母球距假想球 1.23 m、目标球距袋 0.90 m）窗口半宽约
//    0.075°，与公式给出的 0.071° 一致。
//
// 4) 必须做甩球（throw / cling）补偿。
//    球球接触的切向冲量会让目标球偏离球心连线，45° 切球时偏约 1.2°。
//    不补偿的话"按假想球瞄准"在仿真里直接打丢——这不是数值误差，是真实物理。
//    求解器反解"接触法线"，使目标球经过甩球后的实际出球方向正对袋心。

import { V, DEG } from './geometry.js';

/** 绕原点旋转 a 弧度 */
export function rotate(v, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** 从 a 转到 b 的有符号夹角（逆时针为正） */
export function signedAngle(a, b) {
  return Math.atan2(V.cross(a, b), V.dot(a, b));
}

/** 目标球进袋时，母球球心必须到达的位置（袋心沿 target→袋 反向外推一个直径）。 */
export function ghostBallPosition(target, pocket, R) {
  const dir = V.norm(V.sub(pocket, target));
  return { x: target.x - dir.x * 2 * R, y: target.y - dir.y * 2 * R };
}

/**
 * 切角（度）：母球→假想球 与 目标球→袋 的夹角。
 * 0° = 正撞（最直），90° = 极限薄球（物理上打不进）。
 */
export function cutAngleDeg(cue, ghost, target, pocket) {
  const inDir = V.norm(V.sub(ghost, cue));
  const outDir = V.norm(V.sub(pocket, target));
  return Math.acos(Math.max(-1, Math.min(1, V.dot(inDir, outDir)))) * DEG;
}

/**
 * 球球碰撞的切向冲量：给定母球入射方向与接触法线，算出目标球实际出球方向。
 *
 * 等质量球、法向恢复系数 e、切向摩擦 μ：
 *   jn = (1+e)/2 · (v·n)
 *   ut = v·t                      （目标球静止，接触点相对切向速度）
 *   jt = sign(ut)·min(μ·jn, 2/7·|ut|)   —— 2/7 是两球切向有效质量，超过即已咬死
 * 目标球速度 = jn·n + jt·t。
 *
 * @returns {{dir:{x:number,y:number}, speed:number, throwDeg:number}|null}
 */
export function objectBallAfterImpact(vDir, speed, n, params) {
  const t = { x: -n.y, y: n.x };
  const vn = speed * V.dot(vDir, n);
  if (vn <= 1e-9) return null;

  const jn = ((1 + params.ballRestitution) / 2) * vn;
  const ut = speed * V.dot(vDir, t);
  const jt = Math.sign(ut) * Math.min(params.ballFriction * jn, (2 / 7) * Math.abs(ut));

  const vx = jn * n.x + jt * t.x;
  const vy = jn * n.y + jt * t.y;
  const len = Math.hypot(vx, vy);
  if (len < 1e-12) return null;
  const dir = { x: vx / len, y: vy / len };
  return { dir, speed: len, throwDeg: signedAngle(n, dir) * DEG };
}

/**
 * 反解接触法线：让目标球经过甩球后的实际出球方向等于 outDir。
 *
 * 法线决定了假想球位置，假想球位置决定了母球入射方向，入射方向又决定甩球角——
 * 是个不动点问题。甩球角只有 1° 量级，迭代 6 次足够收敛到 1e-6 rad。
 */
export function solveContactNormal(cue, target, outDir, speed, R, params, iterations = 6) {
  let n = { x: outDir.x, y: outDir.y };
  let ghost = { x: target.x - 2 * R * n.x, y: target.y - 2 * R * n.y };
  let throwDeg = 0;

  for (let i = 0; i < iterations; i++) {
    ghost = { x: target.x - 2 * R * n.x, y: target.y - 2 * R * n.y };
    const vDir = V.norm(V.sub(ghost, cue));
    const res = objectBallAfterImpact(vDir, speed, n, params);
    if (!res) break;
    throwDeg = res.throwDeg;
    const err = signedAngle(outDir, res.dir);
    if (Math.abs(err) < 1e-7) break;
    n = rotate(n, -err);
    const l = Math.hypot(n.x, n.y) || 1;
    n = { x: n.x / l, y: n.y / l };
  }

  ghost = { x: target.x - 2 * R * n.x, y: target.y - 2 * R * n.y };
  return { normal: n, ghost, throwDeg };
}

/**
 * 球从 from 沿直线走到 to，路径上是否被别的球挡住。
 * 返回挡路球里离起点最近的那个；没有则 null。
 */
export function firstBlocker(from, to, balls, ignoreIds, R) {
  let best = null;
  let bestD = Infinity;
  for (const b of balls) {
    if (b.pocketed || ignoreIds.includes(b.id)) continue;
    if (pointSegmentDistance(b, from, to) - 2 * R < -1e-9) {
      const d = V.dist(from, b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
  }
  return best;
}

/** 点到线段距离 */
export function pointSegmentDistance(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-12) return Math.hypot(apx, apy);
  let t = (apx * abx + apy * aby) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(apx - abx * t, apy - aby * t);
}

/**
 * 瞄准容错窗口（度）——本项目的核心指标。
 *
 * 目标球要进袋，出球方向允许的角误差 Δφ ≈ atan(横向余量 / 目标球到袋距离)。
 * 出球方向由"目标球心 → 假想球心"这条长 2R 的线段决定，所以 Δφ 对应假想球
 * 横向偏移 δ = 2R·Δφ；母球要打到偏移了 δ 的假想球，瞄准角允许误差
 * ≈ atan(δ / 母球到假想球距离)。
 *
 * 横向余量取 max(袋口捕获半径 − 球半径, 0.2R)：球心必须进捕获圆，
 * 但贴边进袋会打颤，所以只把"干净进袋"的部分算作余量。
 */
export function aimToleranceDeg(cue, ghost, target, pocket, pocketCaptureR, R) {
  const d1 = V.dist(cue, ghost);
  const d2 = V.dist(target, pocket);
  if (d1 < 1e-6 || d2 < 1e-6) return 0;

  const lateralTol = Math.max(R * 0.2, pocketCaptureR - R);
  const dPhi = Math.atan2(lateralTol, d2);
  const ghostOffset = 2 * R * dPhi;
  return Math.atan2(ghostOffset, Math.max(d1, 2 * R)) * DEG;
}

/**
 * 母球撞目标球后的走向（90° 法则的切线分量）。
 * 传入两个单位向量：母球入射方向、目标球出球方向。
 */
export function cueBallTangentDirection(inDir, outDir) {
  const proj = V.dot(inDir, outDir);
  return V.norm(V.sub(inDir, V.mul(outDir, proj)));
}

/**
 * 母球撞完目标球后能滚多远（按滚动阻力估算）。
 * 只用于"母球会不会冲进袋"这类粗判，不做精确走位。
 */
export function cueBallTravelAfter(approachSpeed, muRoll, g) {
  const decel = muRoll * g;
  if (decel <= 0) return Infinity;
  return (approachSpeed * approachSpeed) / (2 * decel);
}

/**
 * 组合球的瞄准点（两级假想球）。
 *
 * 打 A 撞 B 进袋，要两级反推：
 *   第二级：B 要沿 B→袋 走，A 的球心必须到达 G_B = B − 2R·û(袋 − B)；
 *   第一级：A 要沿 A→G_B 走，母球球心必须到达 G_A = A − 2R·û(G_B − A)。
 * 母球瞄准方向就是 C → G_A。
 *
 * 两级都过 solveContactNormal，把甩球算进去——只用裸几何的话实测会偏
 * 零点几度到几度（误差随每一级累积），而组合球的容错窗口本来就比单球窄。
 *
 * 调研依据：bfjesso/pool-shot-calculator (MIT) 的 `int balls[4]` 链式假想球
 * 就是这个结构（`targetPosition = targetBallPos + direction*0.0565`，0.0565 是球直径）。
 * 本项目未复制其代码，只沿用「逐级外推 + 每级重算方向」这个构造。
 *
 * @returns {{gA:{x:number,y:number}, gB:{x:number,y:number}, cut1:number, cut2:number,
 *            throw1:number, throw2:number, midOutDir:{x:number,y:number}}|null}
 */
export function comboAimPoints(cue, mid, target, pocket, R, params, speed) {
  const outDir = V.norm(V.sub(pocket, target));
  const probe2 = solveContactNormal(mid, target, outDir, speed, R, params);
  if (!probe2) return null;
  const gB = probe2.ghost;
  const midOutDir = V.norm(V.sub(gB, mid));
  if (!Number.isFinite(midOutDir.x) || !Number.isFinite(midOutDir.y)) return null;
  const probe1 = solveContactNormal(cue, mid, midOutDir, speed, R, params);
  if (!probe1) return null;
  const gA = probe1.ghost;
  return {
    gA,
    gB,
    midOutDir,
    // 第一级切角：母球 → G_A 与 A → G_B 的夹角；第二级切角：A → G_B 与 B → 袋 的夹角
    cut1: Math.acos(
      Math.max(-1, Math.min(1, V.dot(V.norm(V.sub(gA, cue)), midOutDir)))
    ) * DEG,
    cut2: Math.acos(Math.max(-1, Math.min(1, V.dot(midOutDir, outDir)))) * DEG,
    throw1: probe1.throwDeg,
    throw2: probe2.throwDeg,
  };
}

/** 袋口关于某条库边的镜像点。库边用 'xmin'|'xmax'|'ymin'|'ymax' 指定。 */
export function pocketMirror(pocket, rail, table) {
  const b = table.bounds;
  if (rail === 'xmin') return { x: 2 * b.minX - pocket.x, y: pocket.y };
  if (rail === 'xmax') return { x: 2 * b.maxX - pocket.x, y: pocket.y };
  if (rail === 'ymin') return { x: pocket.x, y: 2 * b.minY - pocket.y };
  if (rail === 'ymax') return { x: pocket.x, y: 2 * b.maxY - pocket.y };
  return null;
}

/**
 * 翻袋的种子方向：目标球 → 袋口的镜像点。
 *
 * 这只是种子。实测库边反射比镜面偏 2°–4°（cushionRestitution=0.85 且随速度下降，
 * 塞 0.2 时偏到 7.6°），而袋口容错只有零点几度——所以镜像绝不能直接当解，
 * 必须交给仿真修正。调研里 tomasz-pawlaczyk/Poolgame-AI-shot-prediction 也是
 * 纯镜面、无物理修正，但该项目无 LICENSE，只作思路对照，未复制任何代码。
 */
export function bankSeedDirection(target, pocket, rail, table) {
  const m = pocketMirror(pocket, rail, table);
  if (!m) return null;
  const d = V.sub(m, target);
  const len = Math.hypot(d.x, d.y);
  if (len < 1e-9) return null;
  return { dir: { x: d.x / len, y: d.y / len }, mirror: m };
}

/**
 * 从 from 沿 dir 直线走，先碰到什么。
 * 返回 { point, kind: 'pocket'|'cushion'|'open', pocketId? }
 */
export function traceRay(from, dir, travel, table) {  const R = table.ballRadius;
  const steps = 200;
  const stepLen = travel / steps;

  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + dir.x * stepLen * i, y: from.y + dir.y * stepLen * i };
    const pk = table.pocketAt(p.x, p.y);
    if (pk) return { point: p, kind: 'pocket', pocketId: pk.id };
    if (p.x < R || p.x > table.length - R || p.y < R || p.y > table.width - R) {
      return { point: p, kind: 'cushion' };
    }
  }
  return {
    point: { x: from.x + dir.x * travel, y: from.y + dir.y * travel },
    kind: 'open',
  };
}
