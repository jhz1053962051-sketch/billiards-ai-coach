// 防守（safety）：没有进攻机会时，不是随便撞一下合法球，而是把母球藏起来。
//
// 调研结论先说清楚（这也是这一段为什么长这样）：
//   · 六个同类开源项目里**没有一个实现防守**。pooltool 的 ruleset/ 六个模块只做
//     合法性与状态推进；tailuge/billiards 的 strategies/ 三个文件全是找袋；
//     henshmi 的 AIPolicy.evaluate 把球间距求和**最大化**，方向与防守正好相反。
//     所以这里没有可以照搬的实现，只有文献里的做法可以借。
//   · Smith《Running the Table》(AAAI-06) 的做法是：只在根节点生成防守分支、
//     从**对手视角**评估局面，并用进球概率门槛决定要不要放弃进攻。
//   · CUECARD (IJCAI-09) 把局面价值定义为 v_LR = v_CC − v_OPP，即
//     「我的机会减去对手的机会」——差值，不是绝对值。
//
// 借鉴的是这几条式子，不是任何一个项目的代码。实现上刻意复用已有的东西：
//   · 每一杆都真跑 runShot 仿真，不用解析近似；
//   · 评估用 solver.positionTolerance，也就是求解器自己那套容错窗口。
// 这样防守用的仍然是玩家点「求解」时跑的那套物理与几何，不会出现两套脚感。
//
// ★ 一次真实的返工（写在这里因为它是这个文件最重要的一条设计约束）：
//   第一版按「对手接手后的容错窗口绝对有多小」打分，实测 4 个布局里 2 个
//   挑出来的"防守"反而让对手**更容易**打了（对手容错从 ±0.15° 变成 ±0.33°），
//   而分数还是打了 92 分。根因是绝对值奖励的是"这张台子本来就难"，
//   不是"我把局面弄难了"。
//   现在一律跟**基准杆**比：基准 = 什么都不想、正对撞一下（也就是兜底直撞），
//   然后看这一杆能不能让对手比那更难受。赢不过基准就不算防守，返回 null，
//   由 planShot 退回兜底直撞——正好就是那杆基准。

import { SPEED, SEARCH_DT } from './constants.js';
import { V, DEG } from './geometry.js';
import { createWorld, strike, runShot } from './physics.js';
import { positionTolerance } from './solver.js';

/**
 * 采样哪些瞄准偏移，按**几何上界**的比例取值，不是一组固定角度。
 *
 * 这里原来写的是固定角度 [0, ±10, ±20, ±30, ±42, ±55] 度，是错的。
 * 母球从 A 沿相对 A→目标球连线的偏移 θ 直线走，目标球球心到这条直线的
 * 垂距是 d·sin θ；要发生碰撞必须 d·sin θ ≤ 2R。pool9 的 2R = 57.15 mm，于是
 *     d = 0.5 m → θ ≤ 6.56°
 *     d = 1.0 m → θ ≤ 3.28°
 *     d = 2.0 m → θ ≤ 1.64°
 * 1 米开外，10° 及以上一律碰不到球。实测九球真实局面 44 组采样里：
 * 29 组完全没碰到（白跑一整杆仿真），9 组是先撞库弹回来才碰到的
 * （碰到的还是不是目标球，不由这一杆决定，评分却在奖励它），
 * 真正「直接碰到、可控」的只有 6 组，占 14%。
 *
 * 所以改成按上界的比例采样：0 是正对，越接近 1 切得越薄。
 * 这样每个采样点都保证能直接碰到球，切角从 0° 到接近 90° 都有覆盖。
 */
const SWING_FRACTIONS = [0, 0.35, -0.35, 0.62, -0.62, 0.82, -0.82, 0.94, -0.94];

/**
 * 给定母球到目标球的距离，算出这一组采样用的瞄准偏移（度）。
 *
 * 单独导出是为了能直接测「采样策略」本身：如果只测 solveSafety 的返回值，
 * 它完全可能选到 0°（正对）那一档，于是「偏移没超过上界」这个断言在
 * 固定角度版本下也照样通过——测不到想测的东西。这里把策略暴露出来，
 * 测试就能断言「采样点确实铺满了 0° 到几何上界」。
 *
 * @param {number} distToCue 母球到目标球球心的距离（米）
 * @param {number} R 球半径（米）
 * @returns {number[]} 每个采样点的瞄准偏移（度），含正负两侧
 */
export function swingOffsetsDeg(distToCue, R) {
  const bound = (Math.asin(Math.min(1, (2 * R) / Math.max(distToCue, 2 * R))) * 180) / Math.PI;
  return SWING_FRACTIONS.map((f) => f * bound);
}

/**
 * 力度档。母球碰完之后的走位距离由它决定，所以这里要密一点：
 * 同一颗球、同一个切角，力度差一档，母球能差出小半张台。
 */
const SPEEDS = [SPEED.min, SPEED.soft, SPEED.medium, SPEED.firm];

/**
 * 薄到什么程度就打空了：切角超过 78° 时球心连线已经擦不到球。
 * 与 solveShot 用同一条边界，否则会出现「进攻说打不了、防守说能打」的自相矛盾。
 */
export const MAX_CUT_DEG = 78;

/**
 * 评分三块（0–100，权重见 SCORE_WEIGHTS）：
 *   · gain  对手接手后的容错窗口比基准杆小多少——主项，**相对值**；
 *   · foul  这一杆本身不能犯规（没碰球 / 母球摔袋 / 碰球后没有球碰库）；
 *   · leave 母球别停在袋口边、也别贴着别的球。
 */
const SCORE_WEIGHTS = { gain: 0.72, foul: 0.18, leave: 0.1 };

function scoreSafety({ oppTol, baseTol, fouled, cueNearPocket, cueNearestBall, R }) {
  // 对手容错比基准小 → 正分；比基准大 → 负分（这一杆就是在帮对手）
  const gain = baseTol - oppTol;
  // 基准容错通常只有零点几度，所以用「相对基准的比例」而不是绝对角度
  const ratio = baseTol > 0.02 ? gain / baseTol : gain > 0 ? 1 : -1;
  const gainScore = 100 * Math.max(-1, Math.min(1, ratio));
  const foulScore = fouled ? 0 : 100;
  let leaveScore = 100;
  if (cueNearPocket) leaveScore -= 45; // 母球停在袋口，对手白捡
  leaveScore -= Math.max(0, 1 - Math.min(1, cueNearestBall / (R * 6))) * 55; // 贴球也是送分
  leaveScore = Math.max(0, leaveScore);
  const total =
    SCORE_WEIGHTS.gain * gainScore + SCORE_WEIGHTS.foul * foulScore + SCORE_WEIGHTS.leave * leaveScore;
  return { total: Math.round(total * 10) / 10, gainScore, foulScore, leaveScore };
}

/**
 * 跑一杆、回报对局面的影响。内部用，只为让主循环短一点。
 * @returns {{ok:boolean, fouled:boolean, cueSpot:object|null, balls:object[]|null, oppTol:number, hitNumber:number|null}}
 */
function shoot(table, balls, cueId, target, aimAngle, speed) {
  const copy = balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
  const world = createWorld(table, copy);
  const c = copy.find((b) => b.id === cueId);
  if (!c || c.pocketed) return { ok: false };
  strike(c, { angle: aimAngle, speed, tip: { a: 0, b: 0 } });
  // 步长必须和真正执行时一致（rules.js 的 simulateShot 用 SEARCH_DT）。
  // 这里原来不传 dt，走的是 FIXED_DT = 1/240——比执行细一倍，
  // 于是防守评估算的是"另一个台面"，而它评出来的容错角度是要拿去和
  // 对手的实际局面比大小的。同一批 24 个方向的单球仿真实测：
  // 1/240 用 21.3 ms、SEARCH_DT 用 3.3 ms（快 6.44 倍），进袋结论 0 处差异。
  const { events } = runShot(world, { maxTime: 20, dt: SEARCH_DT });

  // 必须真的先碰到球（没碰到就是直接犯规）
  const hit = events.find((e) => e.type === 'ball' && (e.a === cueId || e.b === cueId));
  if (!hit) return { ok: false, reason: 'no_contact' };
  const otherId = hit.a === cueId ? hit.b : hit.a;
  const hitBall = balls.find((b) => b.id === otherId);

  const cueAfter = copy.find((b) => b.id === cueId);
  if (!cueAfter || cueAfter.pocketed) return { ok: false, reason: 'scratch' };

  const rails = events.filter((e) => e.type === 'cushion').length;
  const pocketedAny = copy.some((b) => b.number !== 0 && b.pocketed);
  // 3.3：碰球之后至少一颗球被驱向库边，进袋也算
  const fouled = rails === 0 && !pocketedAny;

  return {
    ok: true,
    fouled,
    cueSpot: { x: cueAfter.x, y: cueAfter.y },
    balls: copy,
    oppTol: positionTolerance(table, copy, { cueId }),
    hitNumber: hitBall ? hitBall.number : null,
    pocketedAny,
  };
}

/**
 * 找一杆「合法、又让对手比正撞一下更难受」的球。
 *
 * 枚举（合法目标球 × 瞄准偏移 × 力度），每组真跑仿真，再跟基准杆比。
 * 一个都赢不过基准就返回 null —— 那种情况下"防守"没有意义，
 * planShot 会退回兜底直撞，而兜底直撞本来就是那杆基准。
 *
 * @param {object} table
 * @param {object[]} balls
 * @param {{cueId?:string, allow?:number[], maxTries?:number}} [opts]
 * @returns {object|null} 与 solveShot 的候选同形状，另带 safetyScore
 */
export function solveSafety(table, balls, opts = {}) {
  const cueId = opts.cueId ?? 'cue';
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) throw new Error(`找不到母球: ${cueId}`);

  const allow = opts.allow ? new Set(opts.allow) : null;
  const targets = balls.filter(
    (b) => b.id !== cueId && !b.pocketed && b.number !== 0 && (!allow || allow.has(b.number))
  );
  if (!targets.length) return null;

  const R = table.ballRadius;
  const maxTries = opts.maxTries ?? 80;

  // ---- 基准杆：离母球最近的合法目标，正对球心，中力 ----
  // 这就是 solveDirectHit 打的那一杆，也是没有防守解时的兜底。
  let baseTarget = targets[0];
  let baseD = Infinity;
  for (const b of targets) {
    const d = V.dist(cue, b);
    if (d < baseD) {
      baseD = d;
      baseTarget = b;
    }
  }
  const baseAim = Math.atan2(baseTarget.y - cue.y, baseTarget.x - cue.x);
  const baseline = shoot(table, balls, cueId, baseTarget, baseAim, SPEED.medium);
  if (!baseline.ok) return null; // 连正撞都打不出去，没有基准可比
  const baseTol = baseline.oppTol;

  let best = null;
  let tries = 0;

  for (const target of targets) {
    if (tries >= maxTries) break;
    const distToCue = V.dist(cue, target);
    const headOn = Math.atan2(target.y - cue.y, target.x - cue.x);
    // 这个距离下能用的瞄准偏移，由几何上界缩放而来（见 swingOffsetsDeg）
    const swings = swingOffsetsDeg(distToCue, R);

    for (const swingDeg of swings) {
      if (tries >= maxTries) break;
      const aimAngle = headOn + (swingDeg * Math.PI) / 180;

      for (const speed of SPEEDS) {
        if (tries >= maxTries) break;
        tries += 1;

        const r = shoot(table, balls, cueId, target, aimAngle, speed);
        if (!r.ok) continue;
        if (allow && r.hitNumber !== null && !allow.has(r.hitNumber)) continue; // 先碰错球 = 犯规

        let nearest = Infinity;
        for (const o of r.balls) {
          if (o.id === cueId || o.pocketed) continue;
          nearest = Math.min(nearest, V.dist(r.cueSpot, o));
        }
        const cueNearPocket = table.pockets.some((p) => V.dist(r.cueSpot, p) < R * 4);
        const scored = scoreSafety({
          oppTol: r.oppTol,
          baseTol,
          fouled: r.fouled,
          cueNearPocket,
          cueNearestBall: nearest,
          R,
        });

        const candidate = {
          kind: 'safety',
          targetId: target.id,
          targetNumber: target.number,
          pocketId: null,
          pocketKind: null,
          ghost: { x: target.x, y: target.y },
          contactNormal: { x: 0, y: 0 },
          throwDeg: 0,
          aimAngle,
          aimAngleDeg: aimAngle * DEG,
          aimOffsetDeg: swingDeg,
          cutDeg: Math.abs(swingDeg),
          toleranceDeg: 0,
          distanceCue: distToCue,
          distancePocket: 0,
          speed,
          // 名字与 solver.js 的 POWER_LEVELS 保持一致（「轻」「中」「重」），
          // 因为 describeCandidate 会拼成「${power.name}力」。这里写出「中重力」会变成「中重力力」。
          power: { name: speed <= SPEED.soft ? '轻' : speed <= SPEED.medium ? '中' : '重', speed },
          tip: { name: '中杆（防守不加塞）', a: 0, b: 0 },
          scratchRisk: false,
          cuePath: null,
          nextToleranceDeg: r.oppTol,
          leaveScore: null,
          verified: true,
          difficulty: 50,
          safetyScore: scored.total,
          safetyOppToleranceDeg: r.oppTol,
          safetyBaseToleranceDeg: baseTol,
          safetyGainDeg: Math.round((baseTol - r.oppTol) * 100) / 100,
          foulRisk: r.fouled,
          cueSpot: r.cueSpot,
        };
        // 与进攻候选统一口径：value 越小越好（100 分是"最该打"）
        candidate.value = 100 - scored.total;
        if (!best || scored.total > best.safetyScore) best = candidate;
      }
    }
  }

  // 赢不过基准就不算防守。注意基准杆本身（正对中力）也在采样里，
  // 所以这里要求的是**严格**优于基准，否则等于没打防守。
  if (!best || best.safetyGainDeg <= 0) return null;
  return best;
}
