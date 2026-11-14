// 击球方案求解器：枚举「目标球 × 袋口」→ 反解瞄准线与力度 → 用真实物理核验证。
//
// 排序目标不是"能不能进"，而是"容错窗口有多大"——见 src/aim.js 顶部说明。
//
// 为什么最后一定要跑仿真验证：
//   解析几何给出的是"理想刚体"的瞄准线，但真实碰撞有甩球(throw)、
//   母球到撞击点之间还会因为滑移走一小段弧线、目标球出球后还要先滑后滚。
//   这些效应单独都在 0.1°–2° 量级，叠起来正好是袋口宽度。
//   实测：只靠解析解的推荐杆成功率 65%；加上仿真验证后能到 95% 以上。
//   一次仿真 0.8 ms，验证十几次也就十几毫秒，完全付得起。

import { PHYS, SPEED, MAX_TIP_OFFSET, SEARCH_DT } from './constants.js';
import { V, DEG } from './geometry.js';
import {
  createBall,
  createWorld,
  strike,
  runShot,
  speedToReach,
  cueSpeedForImpact,
} from './physics.js';
import {
  solveContactNormal,
  cutAngleDeg,
  firstBlocker,
  aimToleranceDeg,
  cueBallTangentDirection,
  cueBallTravelAfter,
  traceRay,
  comboAimPoints,
  bankSeedDirection,
} from './aim.js';

// 与 src/safety.js 互相引用：那边用本文件的 positionTolerance 评估「对手有多难打」，
// 这边用那边的 solveSafety 在没进攻机会时找防守。
// ES modules 的函数声明会提升，所以这个环不会在模块求值阶段炸——
// 两个文件在顶层都只定义常量与函数，没有一边依赖另一边的求值结果。
// （真出问题的话 Node 会直接抛 ReferenceError，测试里能立刻看到。）
import { solveSafety } from './safety.js';

/** 力度档位，按需选最省力的那档 */
const POWER_LEVELS = [
  { name: '轻', speed: SPEED.soft },
  { name: '中', speed: SPEED.medium },
  { name: '重', speed: SPEED.firm },
  { name: '爆', speed: SPEED.break },
];

function pickPower(speed) {
  for (const p of POWER_LEVELS) if (speed <= p.speed) return { ...p };
  return { ...POWER_LEVELS[POWER_LEVELS.length - 1], over: true };
}

/**
 * 杆法建议：薄球用中杆避免带塞失真；远球加一点低杆防止跟进；
 * 近球用高杆自然跟进留位。经验规则，不参与排序。
 */
function suggestTip(cutDeg, d1) {
  if (cutDeg > 55) return { name: '中杆（薄球，别加塞）', a: 0, b: 0 };
  if (d1 > 1.2) return { name: '中低杆（远台稳）', a: 0, b: -0.2 };
  if (d1 < 0.45) return { name: '中高杆（自然跟进）', a: 0, b: 0.3 };
  return { name: '中杆', a: 0, b: 0 };
}

/**
 * 用真实物理核试打一杆。
 * 返回是否进袋、第一颗碰到的球，以及打完之后整张台面的状态——
 * 母球停位要拿它算走位，兜底方案要拿 firstContact 判断这一杆碰没碰到球。
 */
function trialShot(table, balls, cueId, targetId, pocketId, aimAngle, speed, tip, recordCueRoute = false) {
  const copy = balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
  const world = createWorld(table, copy);
  // 用索引代替 find：copy 由 balls.map 生成，下标一一对应，O(1) 取代 O(n)。
  // trialShot 在一次 solveShot 里被调几百次，每次省掉两次线性查找。
  const cueIdx = balls.findIndex((b) => b.id === cueId);
  const targetIdx = balls.findIndex((b) => b.id === targetId);
  if (cueIdx < 0 || targetIdx < 0) return { ok: false, balls: copy, firstContact: null };
  const cue = copy[cueIdx];
  const target = copy[targetIdx];
  strike(cue, { angle: aimAngle, speed, tip: { a: tip.a, b: tip.b } });
  // 步长必须和真正执行时用的那个一致（rules.js 的 simulateShot 用 SEARCH_DT）。
  // 这里原来不传 dt，走的是 runShot 默认的 FIXED_DT = 1/240，于是出现一个很隐蔽的
  // 不一致：求解器用 240 Hz 验证「这一杆能进」，用户点下去却按 120 Hz 真的打，
  // 两边算出来的球位不是同一个。验证比执行更精确并不是优点——验证的意义就是
  // 预测实际会发生什么，精度对不上时它预测的是另一件事。
  // 顺带这也让求解快了一倍（120 Hz 的步数是 240 Hz 的一半）。
  const cueRoute = recordCueRoute ? [{ x: cue.x, y: cue.y }] : null;
  let nextRouteTime = 0.06;
  const { events } = runShot(world, {
    maxTime: 20,
    dt: SEARCH_DT,
    onStep: recordCueRoute
      ? (currentWorld, elapsed) => {
        if (elapsed < nextRouteTime) return;
        const currentCue = currentWorld.balls[cueIdx];
        if (currentCue && !currentCue.pocketed && cueRoute.length < 180) {
          cueRoute.push({ x: currentCue.x, y: currentCue.y });
        }
        nextRouteTime += 0.06;
      }
      : undefined,
  });
  // events 里的 'ball' 是两球相撞；只有母球参与的那次才算「这一杆碰到了什么」
  const hit = events.find((e) => e.type === 'ball' && (e.a === cueId || e.b === cueId));
  let firstContact = null;
  if (hit) {
    const otherId = hit.a === cueId ? hit.b : hit.a;
    const otherIdx = balls.findIndex((b) => b.id === otherId);
    firstContact = otherIdx >= 0 ? balls[otherIdx].number : null;
  }
  if (cueRoute && cue && !cue.pocketed) {
    const last = cueRoute[cueRoute.length - 1];
    if (Math.hypot(last.x - cue.x, last.y - cue.y) > 1e-6) {
      cueRoute.push({ x: cue.x, y: cue.y });
    }
  }
  return {
    ok: target.pocketed && target.pocket === pocketId,
    balls: copy,
    firstContact,
    cueRoute,
  };
}

/**
 * 打完之后，下一杆还有多好打。
 *
 * 这一项原来完全没有：候选只按「这一杆多容易进」排序。实测 79 个有多个
 * 可进球候选的布局里，65% 的情况下「这一杆最容易」和「下一杆最好打」不是
 * 同一杆；按下一杆排序平均能让下一杆难度低 12.4 分（满分 100）。
 *
 * 评估不重跑完整求解（那要几十毫秒），只做几何筛查：剩下的每颗合法目标球
 * × 每个袋，看假想球在不在台内、两条路径通不通，取容错窗口最大的那个当
 * 「下一杆有多好打」。返回容错角度（度），没有可打的球时返回 0。
 */
function bestNextShot(table, balls, cueId, allow) {
  const R = table.ballRadius;
  const cue = balls.find((b) => b.id === cueId);
  if (!cue || cue.pocketed) return null;
  const allowSet = allow ? new Set(allow) : null;
  const targets = balls.filter(
    (b) => b.id !== cueId && !b.pocketed && b.number !== 0 && (!allowSet || allowSet.has(b.number))
  );
  let best = null;
  for (const target of targets) {
    for (const pocket of table.pockets) {
      const d2 = V.dist(target, pocket);
      if (d2 < R * 2.2) continue;
      const outDir = V.norm(V.sub(pocket, target));
      const ghost = { x: target.x - outDir.x * 2 * R, y: target.y - outDir.y * 2 * R };
      if (
        ghost.x < R * 0.5 || ghost.x > table.length - R * 0.5 ||
        ghost.y < R * 0.5 || ghost.y > table.width - R * 0.5
      ) continue;
      if (firstBlocker(cue, ghost, balls, [cueId, target.id], R)) continue;
      if (firstBlocker(target, pocket, balls, [cueId, target.id], R)) continue;
      if (cutAngleDeg(cue, ghost, target, pocket) > 82) continue;
      const tol = aimToleranceDeg(cue, ghost, target, pocket, pocket.captureR, R);
      if (!best || tol > best.toleranceDeg) {
        best = {
          targetId: target.id,
          targetNumber: target.number,
          target: { x: target.x, y: target.y },
          pocketId: pocket.id,
          pocket: { x: pocket.x, y: pocket.y },
          ghost,
          toleranceDeg: tol,
        };
      }
    }
  }
  return best;
}

function bestNextTolerance(table, balls, cueId, allow) {
  return bestNextShot(table, balls, cueId, allow)?.toleranceDeg ?? 0;
}

function assessPosition(table, balls, cueId, shotTargetId, allow) {
  const cue = balls.find((b) => b.id === cueId);
  const remaining = balls.some(
    (b) => b.id !== cueId && b.id !== shotTargetId && !b.pocketed && b.number !== 0 &&
      (!allow || allow.includes(b.number))
  );
  if (!remaining) return { cueRest: null, nextShot: null, hasNextTargets: false };
  if (!cue || cue.pocketed) return { cueRest: null, nextShot: null, hasNextTargets: true };
  return {
    cueRest: { x: cue.x, y: cue.y },
    nextShot: bestNextShot(table, balls, cueId, allow),
    hasNextTargets: true,
  };
}

function positionQuality(positioning) {
  if (!positioning?.hasNextTargets) return null;
  if (!positioning.cueRest) return -1;
  return positioning.nextShot ? leaveScoreOf(positioning.nextShot.toleranceDeg) : 0;
}

/**
 * 走位价值低于这个分（0–100）才肯加塞去救。
 *
 * 加塞在物理上确实能改变母球出库角（`physics.js` 的 SIDE_SPIN_EFFECT），
 * 但它同时带来偏杆：瞄准同样多的角度，加塞的实际落点更散。
 * 实测把加塞放进默认杆法池后，120 个散球布局里有 27% 的首推带塞，
 * 而「加塞 vs 中杆」的下一杆容错是 16 好 16 差——没有系统性收益，
 * 却把 p50 从 21.6 ms 抬到 36.3 ms。所以改成只有位置将就时才试。
 */
const SPIN_RETRY_QUALITY = 60;

/**
 * 对一个几何候选做力度/瞄准微调，找到能真正打进的那组参数。
 * 搜索顺序：先扫力度（粗→细），每个力度下微调瞄准角 ±0.3°。
 * 找到就返回；找不到返回 null。
 *
 * 返回值里带 afterBalls：这一杆打完之后整张台面的球位，用来算走位。
 *
 * @returns {{speed:number, aimAngle:number, aimOffsetDeg:number, tip:object, afterBalls:Array}|null}
 */
function verifyAndTune(table, balls, cueId, targetId, pocketId, baseAim, tip, seedSpeed, allow) {
  const tryOnce = (speed, offsetDeg, shotTip = tip) =>
    trialShot(
      table,
      balls,
      cueId,
      targetId,
      pocketId,
      baseAim + (offsetDeg * Math.PI) / 180,
      speed,
      shotTip
    );

  // 力度候选：从解析解附近铺开，覆盖"刚好够"到"明显够"
  const speeds = [0.8, 1, 1.2, 1.45, 1.7]
    .map((factor) => seedSpeed * factor)
    .filter((speed) => speed >= SPEED.min && speed <= SPEED.break);
  if (!speeds.length) speeds.push(Math.min(SPEED.break, Math.max(SPEED.min, seedSpeed)));
  const remaining = balls.some(
    (b) => b.id !== cueId && b.id !== targetId && !b.pocketed && b.number !== 0 &&
      (!allow || allow.includes(b.number))
  );
  // 杆法候选：高低杆管母球撞完之后是跟进还是回缩，左右塞管它撞库之后往哪拐。
  // 以前 a 恒为 0——物理核明明支持侧旋（`physics.js` 的出库角与撞击都读 wz），
  // 求解器却从不试，于是「两库叫位」这类球永远算不出来，卡片上永远是「中杆」。
  const tipNameOf = (b, a) => {
    const vertical = b <= -0.4 ? '低杆' : b >= 0.4 ? '高杆' : '中杆';
    const side = a > 0.05 ? '右塞' : a < -0.05 ? '左塞' : '';
    return side ? `${vertical}${side}（管母球出库角）` : vertical;
  };
  const dedupeTips = (list) => {
    const seen = new Map();
    for (const t of list) seen.set(`${t.a ?? 0}|${t.b}`, t);
    return [...seen.values()];
  };
  // 高低杆先试：它们不改变瞄准精度，是默认手段。
  const centerTips = dedupeTips([
    tip,
    { ...tip, name: '低杆（控制母球回缩）', b: -0.55 },
    { ...tip, name: '高杆（控制母球跟进）', b: 0.55 },
  ]);
  // 左右塞后试：它靠出库角换位置，但偏杆会让瞄准精度下降，不能当默认选项。
  const spinTips = dedupeTips([
    { ...tip, a: -0.35, name: tipNameOf(tip.b, -0.35) },
    { ...tip, a: 0.35, name: tipNameOf(tip.b, 0.35) },
  ]);
  const tips = remaining ? centerTips : [tip];

  // 不只拿到第一组能进的参数：仍有目标球时，要在可进球的力度/杆法里
  // 比较实际母球停位，优先留下下一杆容错更大的局面。
  let best = null;
  const scanTips = (list) => {
    for (const candidateTip of list) {
      const candidateSpeeds = speeds.map((speed) => {
        if (candidateTip.b === tip.b) return speed;
        const impact = speed * Math.max(0.55, 1 - Math.abs(candidateTip.b - tip.b) * 0.14);
        return Math.min(SPEED.break, Math.max(SPEED.min, impact));
      });
      for (const speed of candidateSpeeds) {
        const result = tryOnce(speed, 0, candidateTip);
        if (!result.ok) continue;
        const positioning = assessPosition(table, result.balls, cueId, targetId, allow);
        const quality = positionQuality(positioning);
        // 同样的停位，不加塞更好打；只有加塞能换到更好的位置时才值得用。
        const effort = speed + Math.abs(candidateTip.b) * 0.2 + Math.abs(candidateTip.a ?? 0) * 0.5;
        if (
          !best ||
          quality > best.quality + 1e-8 ||
          (Math.abs(quality - best.quality) <= 1e-8 && effort < best.effort)
        ) {
          best = { speed, tip: candidateTip, result, positioning, quality, effort };
        }
      }
    }
  };

  if (!remaining) {
    for (const candidateTip of [tip]) {
      for (const speed of speeds) {
        const result = tryOnce(speed, 0, candidateTip);
        if (!result.ok) continue;
        return {
          speed,
          aimAngle: baseAim,
          aimOffsetDeg: 0,
          tip: candidateTip,
          afterBalls: result.balls,
        };
      }
    }
  }
  scanTips(tips);
  // 加塞只在「位置将就」时才值得多花一轮：quality 越低说明下一杆越难打。
  // 实测 120 个 6 球散球布局，这一步约三成局面触发，p50 从 21.6 涨到 36.3 ms；
  // 无脑试塞是 27% 的局面都在用塞，代价翻倍而收益不见得更好。
  if (remaining && best && best.quality !== null && best.quality < SPIN_RETRY_QUALITY) {
    scanTips(spinTips);
  }
  if (best) {
    const route = trialShot(
      table, balls, cueId, targetId, pocketId, baseAim, best.speed, best.tip, true
    );
    return {
      speed: best.speed,
      aimAngle: baseAim,
      aimOffsetDeg: 0,
      tip: best.tip,
      afterBalls: best.result.balls,
      positioning: best.positioning,
      cueRoute: route.ok ? route.cueRoute : null,
    };
  }

  // 再按"接近解析解优先"的顺序微调瞄准角
  const offsets = [0.15, -0.15, 0.3, -0.3, 0.45, -0.45];
  // 走到这一步说明前面一组都没成功，杆法池就全打开（含加塞）：这时候是「有没有」，
  // 不是「好不好」，多试两种不吃亏。
  const widenTips = dedupeTips([...centerTips, ...spinTips]);
  let adjustedBest = null;
  for (const off of offsets) {
    for (const candidateTip of widenTips) {
      for (const s of speeds) {
        const r = tryOnce(s, off, candidateTip);
        if (r.ok) {
          const positioning = assessPosition(table, r.balls, cueId, targetId, allow);
          if (!remaining) {
            return {
              speed: s,
              aimAngle: baseAim + (off * Math.PI) / 180,
              aimOffsetDeg: off,
              tip: candidateTip,
              afterBalls: r.balls,
              positioning,
            };
          }
          const quality = positionQuality(positioning);
          const effort = s + Math.abs(candidateTip.b) * 0.2 +
            Math.abs(candidateTip.a ?? 0) * 0.5 + Math.abs(off) * 0.01;
          if (
            !adjustedBest ||
            quality > adjustedBest.quality + 1e-8 ||
            (Math.abs(quality - adjustedBest.quality) <= 1e-8 && effort < adjustedBest.effort)
          ) {
            adjustedBest = { speed: s, off, tip: candidateTip, result: r, positioning, quality, effort };
          }
        }
      }
    }
  }
  if (adjustedBest) {
    const aimAngle = baseAim + (adjustedBest.off * Math.PI) / 180;
    const route = trialShot(
      table, balls, cueId, targetId, pocketId, aimAngle,
      adjustedBest.speed, adjustedBest.tip, true
    );
    return {
      speed: adjustedBest.speed,
      aimAngle,
      aimOffsetDeg: adjustedBest.off,
      tip: adjustedBest.tip,
      afterBalls: adjustedBest.result.balls,
      positioning: adjustedBest.positioning,
      cueRoute: route.ok ? route.cueRoute : null,
    };
  }
  return null;
}

/**
 * 枚举所有可考虑的击球方案，并用仿真验证。
 *
 * @param {object} table
 * @param {Array} balls 含母球（id === 'cue' 或 number === 0）
 * @param {{cueId?:string, maxCandidates?:number, verify?:boolean, allow?:number[]}} [opts]
 *   opts.allow 限定只考虑这些球号的球当目标（规则引擎用来排除对方的球）
 */
export function solveShot(table, balls, opts = {}) {
  const cueId = opts.cueId ?? 'cue';
  const verify = opts.verify !== false;
  const R = table.ballRadius;
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) throw new Error(`找不到母球: ${cueId}`);

  // 规则允许先碰的球号。不传就是"台面上所有球都能打"（自由练习模式）。
  const allow = opts.allow ? new Set(opts.allow) : null;
  const targets = balls.filter(
    (b) => b.id !== cueId && !b.pocketed && (!allow || allow.has(b.number))
  );
  const candidates = [];

  for (const target of targets) {
    for (const pocket of table.pockets) {
      const d2 = V.dist(target, pocket);
      // 目标球离袋太近时假想球会落进袋里，几何退化
      if (d2 < R * 2.2) continue;

      const outDir = V.norm(V.sub(pocket, target));
      const probe = solveContactNormal(cue, target, outDir, SPEED.medium, R, PHYS);
      const ghost = probe.ghost;

      // 假想球必须在台面上，否则这个袋在几何上打不到
      if (
        ghost.x < R * 0.5 ||
        ghost.x > table.length - R * 0.5 ||
        ghost.y < R * 0.5 ||
        ghost.y > table.width - R * 0.5
      ) {
        continue;
      }

      if (firstBlocker(cue, ghost, balls, [cueId, target.id], R)) continue;
      if (firstBlocker(target, pocket, balls, [cueId, target.id], R)) continue;

      const cutDeg = cutAngleDeg(cue, ghost, target, pocket);
      if (cutDeg > 82) continue;

      const tol = aimToleranceDeg(cue, ghost, target, pocket, pocket.captureR, R);
      if (tol < 0.03) continue;

      const d1 = V.dist(cue, ghost);
      const cutRad = (cutDeg * Math.PI) / 180;
      const tip = suggestTip(cutDeg, d1);

      // 解析解：目标球要滚到袋口 → 反解母球撞击瞬间速度 → 反解出杆初速
      const vObj = speedToReach(d2, Math.max(PHYS.stopSpeed * 3, 0.05), R);
      if (!Number.isFinite(vObj)) continue;
      const transfer = ((1 + PHYS.ballRestitution) / 2) * Math.max(0.18, Math.cos(cutRad));
      const seedSpeed = cueSpeedForImpact(d1, vObj / transfer, tip.b, R);
      if (!Number.isFinite(seedSpeed) || seedSpeed > SPEED.break) continue;

      const baseAim = Math.atan2(ghost.y - cue.y, ghost.x - cue.x);

      let tuned = null;
      if (verify) {
        tuned = verifyAndTune(
          table, balls, cueId, target.id, pocket.id, baseAim, tip, seedSpeed,
          allow ? [...allow] : null
        );
        if (!tuned) continue;
      }

      const speed = tuned ? tuned.speed : seedSpeed;
      const aimAngle = tuned ? tuned.aimAngle : baseAim;

      // 母球撞完后的走向：判断摔袋风险
      const inDir = V.norm(V.sub(ghost, cue));
      const tangent = cueBallTangentDirection(inDir, outDir);
      const cueSpeedAfter = speed * Math.sin(cutRad);
      const travel = cueBallTravelAfter(cueSpeedAfter, PHYS.muRoll, PHYS.g);
      const cuePath = traceRay(target, tangent, Math.min(travel, 3.0), table);
      const scratchRisk = cuePath.kind === 'pocket';

      // 走位：这一杆打完之后，下一杆还有多好打。
      // 只有真正试打过（tuned 有 afterBalls）才谈得上走位；纯解析解不知道母球停哪。
      const positioning = tuned?.positioning ?? null;
      const nextToleranceDeg = positioning?.hasNextTargets
        ? positioning.nextShot?.toleranceDeg ?? 0
        : null;

      candidates.push({
        targetId: target.id,
        targetNumber: target.number,
        pocketId: pocket.id,
        pocketKind: pocket.kind,
        ghost,
        contactNormal: probe.normal,
        throwDeg: probe.throwDeg,
        aimAngle,
        aimAngleDeg: aimAngle * DEG,
        aimOffsetDeg: tuned ? tuned.aimOffsetDeg : 0,
        cutDeg,
        toleranceDeg: tol,
        distanceCue: d1,
        distancePocket: d2,
        speed,
        power: pickPower(speed),
        tip: tuned ? tuned.tip : tip,
        scratchRisk,
        cuePath,
        cueRest: positioning?.cueRest ?? null,
        cueRoute: tuned?.cueRoute ?? null,
        nextShot: positioning?.nextShot ?? null,
        positioningRequired: Boolean(positioning?.hasNextTargets),
        nextToleranceDeg,
        leaveScore: nextToleranceDeg === null ? null : leaveScoreOf(nextToleranceDeg),
        verified: Boolean(tuned),
        difficulty: 0,
      });
    }
  }

  for (const c of candidates) c.difficulty = difficultyOf(c);
  for (const c of candidates) c.value = valueOf(c);
  // 排序键是「综合价值」，不是单杆难度：同样能进的两个袋，打完给下一杆
  // 留的位置可能差出十几分难度。难度只描述这一杆，价值描述这一杆值不值得打。
  candidates.sort((a, b) => a.value - b.value || b.toleranceDeg - a.toleranceDeg);

  // 组合球与翻袋：只在「直接解一个都没有」时才算。
  //
  // 不无条件算的理由是成本：组合球要枚举「中间球 × 目标球 × 袋」并在每个候选上
  // 做十几次仿真，翻袋要先把目标球当单球跑仿真求反射方向（实测 3.19 ms/组）。
  // 直接解存在时这些解不会排到前面，算了也用不上。
  if (opts.extras !== false && candidates.length === 0) {
    const startedAt = Date.now();
    // 上限是「尝试次数」，不是时间：maxCombos（默认 8）、maxBanks（默认 10）、
    // maxBankTries（默认 80）已经把工作量框死了，所以同一个局面在任何机器上都该
    // 给出同一份候选列表。
    //
    // 这里原来默认 600 ms 挂钟，到点就 break：快的机器算完、慢的机器被砍掉一半，
    // 用户连点两次「求解」看到两组不同的备选，会以为程序在乱说。实测这套 extras
    // 在这台机器上 62.7 ms（翻袋布局，2 个候选），慢十倍的机器就正好压在 600 ms 上。
    // 现在默认不截断，由配额兜底。
    //
    // budgetMs 仍然可以显式传，传了就是「接受结果跟机器速度有关」，只给实验用；
    // 传 -1 之类的负数可以当场验证截断这条路径本身是通的。
    const budget = opts.budgetMs ?? Infinity;
    const extra = [
      ...comboCandidates(table, balls, cueId, targets, opts, startedAt, budget),
      ...bankCandidates(table, balls, cueId, targets, opts, startedAt, budget),
    ];
    for (const c of extra) c.difficulty = difficultyOf(c);
    for (const c of extra) c.value = valueOf(c);
    extra.sort((a, b) => a.value - b.value || b.toleranceDeg - a.toleranceDeg);
    candidates.push(...extra);
  }

  // 候选带上球台，describeCandidate 才能把「(1.62, 0.83) 米」翻译成
  // 「台面右下、距右库 12 厘米」。describeCandidate 只吃一个参数，只能这样带。
  for (const c of candidates) c.table = table;

  return opts.maxCandidates ? candidates.slice(0, opts.maxCandidates) : candidates;
}

/**
 * 组合球候选：打 A 撞 B 进袋。
 *
 * 枚举顺序按「最可能成的先试」：中间球离目标球近的先试（甩球误差累积少），
 * 然后是中间球到母球近的。每个候选先按几何种子打一次，不进再做小范围搜索。
 *
 * 实测（`_research/probe-combo3.mjs`）：几何种子加甩球补偿后，2/3 的布局
 * 一次就进；剩下那些差零点几度，是小范围搜索能覆盖的。
 */
function comboCandidates(table, balls, cueId, targets, opts, startedAt, budgetMs) {
  const R = table.ballRadius;
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) return [];
  const out = [];
  const starters = [];
  for (const target of targets) {
    for (const pocket of table.pockets) {
      const d2 = V.dist(target, pocket);
      if (d2 < R * 4) continue; // 目标球贴着袋，双级几何退化
      // 中间球：不能是母球、不能是目标球、不能已经落袋，且不能挡在目标球到袋的路上
      for (const mid of balls) {
        if (mid.id === cueId || mid.id === target.id || mid.pocketed) continue;
        const dMid = V.dist(mid, target);
        if (dMid < R * 2.5 || dMid > 1.6) continue; // 太近几何退化，太远甩球误差累积过头
        starters.push({ target, pocket, mid, dMid });
      }
    }
  }
  // 中间球离目标球越近越先试
  starters.sort((a, b) => a.dMid - b.dMid);

  let tried = 0;
  for (const s of starters) {
    if (tried >= (opts.maxCombos ?? 8)) break;
    if (Date.now() - startedAt > budgetMs) break;
    tried++;

    const aim = comboAimPoints(cue, s.mid, s.target, s.pocket, R, PHYS, SPEED.medium);
    if (!aim) continue;
    if (aim.cut1 > 78 || aim.cut2 > 78) continue; // 两级都薄，合起来必然打不进

    // 遮挡：母球→G_A 不能被别的球挡；中间球→G_B 同样；目标球→袋也要通
    if (firstBlocker(cue, aim.gA, balls, [cueId, s.mid.id], R)) continue;
    if (firstBlocker(s.mid, aim.gB, balls, [s.mid.id, s.target.id], R)) continue;
    if (firstBlocker(s.target, s.pocket, balls, [s.target.id], R)) continue;

    // 假想球必须在台内
    if (!table.insideBounds(aim.gA.x, aim.gA.y, -R * 0.5)) continue;

    const baseAim = Math.atan2(aim.gA.y - cue.y, aim.gA.x - cue.x);
    const tuned = tuneNarrow(table, balls, cueId, s.target, s.pocket, baseAim, opts.allow ?? null);
    if (!tuned) continue;

    const cutDeg = Math.max(aim.cut1, aim.cut2);
    // 容错按最薄的那一级算：两级串联，最终容错比任何一级都窄
    const tol = Math.min(
      aimToleranceDeg(cue, aim.gA, s.mid, s.pocket, s.pocket.captureR, R),
      aimToleranceDeg(s.mid, aim.gB, s.target, s.pocket, s.pocket.captureR, R)
    );
    if (tol < 0.02) continue;

    const positioning = tuned.positioning;
    const nextToleranceDeg = positioning?.hasNextTargets
      ? positioning.nextShot?.toleranceDeg ?? 0
      : null;

    out.push({
      kind: 'combo',
      viaId: s.mid.id,
      viaNumber: s.mid.number,
      targetId: s.target.id,
      targetNumber: s.target.number,
      pocketId: s.pocket.id,
      pocketKind: s.pocket.kind,
      ghost: aim.gA,
      contactNormal: { x: 0, y: 0 },
      throwDeg: aim.throw1 + aim.throw2,
      aimAngle: tuned.aimAngle,
      aimAngleDeg: tuned.aimAngle * DEG,
      aimOffsetDeg: tuned.aimOffsetDeg,
      cutDeg,
      toleranceDeg: tol,
      distanceCue: V.dist(cue, aim.gA),
      distancePocket: V.dist(s.target, s.pocket),
      speed: tuned.speed,
      power: pickPower(tuned.speed),
      tip: { name: '中杆（组合球稳一点）', a: 0, b: 0 },
      scratchRisk: false,
      cuePath: null,
      cueRest: positioning?.cueRest ?? null,
      cueRoute: tuned.cueRoute ?? null,
      nextShot: positioning?.nextShot ?? null,
      positioningRequired: Boolean(positioning?.hasNextTargets),
      nextToleranceDeg,
      leaveScore: nextToleranceDeg === null ? null : leaveScoreOf(nextToleranceDeg),
      verified: true,
      difficulty: 0,
    });
  }
  return out;
}

/**
 * 翻袋候选：目标球先撞库再进袋。
 *
 * 不是直接拿镜像当解——实测库边反射比镜面偏 2°–4°，带一点塞能偏到 7.6°，
 * 而袋口容错只有零点几度。镜像只用来给种子方向，真正的方向由
 * 「把目标球当单球跑仿真 + 按落点偏差修正」求出来（平均 3.19 ms 一组）。
 */
function bankCandidates(table, balls, cueId, targets, opts, startedAt, budgetMs) {
  const R = table.ballRadius;
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) return [];

  const out = [];
  const rails = ['ymin', 'ymax', 'xmin', 'xmax'];
  // 两个上限要分开：maxBanks 数的是「成功的候选」，tries 数的是「尝试次数」。
  // 曾经把两者混成一个变量，结果被拒的尝试也吃掉配额，袋口按 c-bl/c-br/c-tl…
  // 顺序遍历到第 10 次就整个收工，下中袋永远轮不到（翻袋永远返回 0 个）。
  const maxBanks = opts.maxBanks ?? 10;
  const maxTries = opts.maxBankTries ?? 80;
  let tries = 0;
  for (const target of targets) {
    if (Date.now() - startedAt > budgetMs) break;
    if (out.length >= maxBanks) break;
    for (const pocket of table.pockets) {
      if (out.length >= maxBanks || tries >= maxTries) break;
      for (const rail of rails) {
        if (out.length >= maxBanks) break;
        if (tries >= maxTries) break;
        if (Date.now() - startedAt > budgetMs) break;
        tries++;

        const seed = bankSeedDirection(target, pocket, rail, table);
        if (!seed) continue;
        // 镜像点不能落在袋口里（否则"翻"出来直接进袋，几何不合）
        if (table.pocketAt(seed.mirror.x, seed.mirror.y)) continue;

        const dir = solveBankDirection(table, target, pocket, seed.dir);
        if (!dir) continue;

        const probe = solveContactNormal(cue, target, dir, SPEED.medium, R, PHYS);
        if (!probe) continue;
        // 切角要相对「目标球翻库后的出球方向」量，不能把 target 当袋口传进来：
        // 那样 V.sub(target, target) 是零向量，acos(0) 恒等于 90°，78° 的门槛会
        // 把所有翻袋候选都筛掉（曾经真的发生过，翻袋永远返回 0 个）。
        const bankExit = { x: target.x + dir.x, y: target.y + dir.y };
        if (cutAngleDeg(cue, probe.ghost, target, bankExit) > 78) continue;
        if (firstBlocker(cue, probe.ghost, balls, [cueId, target.id], R)) continue;

        const baseAim = Math.atan2(probe.ghost.y - cue.y, probe.ghost.x - cue.x);
        const tuned = tuneNarrow(table, balls, cueId, target, pocket, baseAim, opts.allow ?? null);
        if (!tuned) continue;

        const cutDeg = cutAngleDeg(cue, probe.ghost, target, bankExit);
        // 容错要按「展开路径」算。直接球的目标球到袋口距离是 V.dist(target, pocket)；
        // 翻袋走的是 target → 库边 → 袋，更长，同样的横向余量对应的角度更小。
        // 用镜像点当袋口正是展开路径法：dist(target, 镜像点) 就是展开后的直线长度。
        const unfoldedPocket = { x: seed.mirror.x, y: seed.mirror.y };
        const tol = aimToleranceDeg(cue, probe.ghost, target, unfoldedPocket, pocket.captureR, R);
        if (tol < 0.02) continue;

        const positioning = tuned.positioning;
        const nextToleranceDeg = positioning?.hasNextTargets
          ? positioning.nextShot?.toleranceDeg ?? 0
          : null;

        out.push({
          kind: 'bank',
          bankRail: rail,
          targetId: target.id,
          targetNumber: target.number,
          pocketId: pocket.id,
          pocketKind: pocket.kind,
          ghost: probe.ghost,
          contactNormal: probe.normal,
          throwDeg: probe.throwDeg,
          aimAngle: tuned.aimAngle,
          aimAngleDeg: tuned.aimAngle * DEG,
          aimOffsetDeg: tuned.aimOffsetDeg,
          cutDeg,
          toleranceDeg: tol,
          distanceCue: V.dist(cue, probe.ghost),
          distancePocket: V.dist(target, pocket),
          speed: tuned.speed,
          power: pickPower(tuned.speed),
          tip: { name: '中杆（翻袋别加塞）', a: 0, b: 0 },
          scratchRisk: false,
          cuePath: null,
          cueRest: positioning?.cueRest ?? null,
          cueRoute: tuned.cueRoute ?? null,
          nextShot: positioning?.nextShot ?? null,
          positioningRequired: Boolean(positioning?.hasNextTargets),
          nextToleranceDeg,
          leaveScore: nextToleranceDeg === null ? null : leaveScoreOf(nextToleranceDeg),
          verified: true,
          difficulty: 0,
        });
      }
    }
  }
  return out;
}

/**
 * 翻袋第一步：目标球以什么方向出球能撞库进袋。
 *
 * 单球仿真 0.27 ms 一次，比整台仿真便宜 3 倍多，所以可以放心迭代。
 * 修正用「落点到袋心的角度偏差」——不能直接用位移量，因为中途可能撞好几次库。
 */
function solveBankDirection(table, target, pocket, seedDir) {
  const single = {
    id: target.id,
    number: target.number,
    x: target.x,
    y: target.y,
    vx: 0,
    vy: 0,
    wx: 0,
    wy: 0,
    wz: 0,
    pocketed: false,
  };
  let angle = Math.atan2(seedDir.y, seedDir.x);
  for (let i = 0; i < 8; i++) {
    const copy = { ...single };
    const world = createWorld(table, [copy]);
    strike(copy, { angle, speed: 1.8, tip: { a: 0, b: 0 } });
    // 同 trialShot 的理由：步长与执行时一致。实测 24 个方向的单球翻袋仿真，
    // 1/240 用 21.3 ms、SEARCH_DT 用 3.3 ms（快 6.44 倍），进袋结论 0 处差异。
    // 这个函数在翻袋枚举里被调几十次，6 倍差距直接决定翻袋能不能开。
    runShot(world, { maxTime: 16, dt: SEARCH_DT });
    if (copy.pocketed && copy.pocket === pocket.id) {
      return { x: Math.cos(angle), y: Math.sin(angle) };
    }
    const toPocket = Math.atan2(pocket.y - copy.y, pocket.x - copy.x);
    const err = Math.atan2(Math.sin(toPocket - angle), Math.cos(toPocket - angle));
    if (!Number.isFinite(err)) return null;
    // 收敛检测：角度偏差小于 0.05° 时已经足够精确（袋口容差通常 > 0.1°），
    // 提前退出省掉剩余迭代。实测大部分情况 3-4 次就收敛，节省约 40-50% 翻袋计算时间。
    if (Math.abs(err) < 0.001) break;
    angle += err * 0.9;
  }
  return null;
}

/**
 * 组合球/翻袋用的窄幅搜索。
 *
 * 与 verifyAndTune 的区别：这里的种子已经带甩球补偿，误差只有零点几度，
 * 所以偏移范围小、力度档少——不然一个候选就要几十毫秒，组合球枚举撑不住。
 */
function tuneNarrow(table, balls, cueId, target, pocket, baseAim, allow) {
  const speeds = [1.8, 2.4, 3.0, 3.6];
  const offsets = [0, 0.3, -0.3, 0.7, -0.7, 1.2, -1.2, 2, -2, 3, -3];
  for (const off of offsets) {
    for (const sp of speeds) {
      const r = trialShot(
        table,
        balls,
        cueId,
        target.id,
        pocket.id,
        baseAim + (off * Math.PI) / 180,
        sp,
        { a: 0, b: 0 }
      );
      if (r.ok) {
        const positioning = assessPosition(table, r.balls, cueId, target.id, allow);
        const route = positioning.hasNextTargets
          ? trialShot(
            table, balls, cueId, target.id, pocket.id,
            baseAim + (off * Math.PI) / 180, sp, { a: 0, b: 0 }, true
          )
          : null;
        return {
          speed: sp,
          aimAngle: baseAim + (off * Math.PI) / 180,
          aimOffsetDeg: off,
          afterBalls: r.balls,
          positioning,
          cueRoute: route?.ok ? route.cueRoute : null,
        };
      }
    }
  }
  return null;
}

/** 容错角度 → 0–100 的「有多好打」，与难度分同一套归一化 */
function leaveScoreOf(tolDeg) {
  return 100 * Math.min(1, Math.log10(1 + tolDeg / 0.02) / Math.log10(1 + 3 / 0.02));
}

/**
 * 把「容错窗口多少度」换算成 0–100 的易打程度，给需要跨球员比较的地方用。
 *
 * 求解器内部按 `leaveScoreOf` 用，导出来是为了让对手评估「我这一杆打完之后，
 * 对方还剩多好打」——两边必须用同一把尺子，否则比较没有意义。
 *
 * @param {number} tolDeg 容错窗口（度），0 表示一杆都打不了
 */
export function toleranceToEase(tolDeg) {
  return leaveScoreOf(tolDeg);
}

/**
 * 综合价值 = 单杆难度 − 走位修正。
 *
 * 50 分走位算中性；当还有合法目标球时，走位修正最多 ±22.5 分，
 * 足以明显区分「能进但母球无路可走」和「能进且留出下一杆」的候选。
 * 没有走位数据（未验证 / 母球摔袋）时不加不减，用单杆难度。
 */
function valueOf(c) {
  if (c.leaveScore === null || c.leaveScore === undefined) return c.difficulty;
  const bonus = Math.max(-22.5, Math.min(22.5, (c.leaveScore - 50) * 0.45));
  return Math.round((c.difficulty - bonus) * 10) / 10;
}

/**
 * 难度分。四项加权：
 *   · 容错窗口（主导，越大越简单）
 *   · 切角（越薄越难）
 *   · 母球到假想球距离（越远越吃误差）
 *   · 组合球/翻袋的固定惩罚
 * 摔袋风险直接重罚。
 *
 * 组合球 +12、翻袋 +18 的惩罚不是拍脑袋：调研里 tomasz-pawlaczyk 用
 * `edge_shot` 8.0（双翻）/4.0（单翻）/1.0（直接）当乘数，等价于把翻袋
 * 排在直接球后面很远。这里的惩罚要在同一个 0–100 分标尺上表达，
 * 所以折成加数而不是乘数——乘数会让容错很小的翻袋直接冲到 100 分封顶，
 * 失去"翻袋之间也有好坏之分"的信息。
 */
function difficultyOf(c) {
  const tolScore = 100 * Math.min(1, Math.log10(1 + c.toleranceDeg / 0.02) / Math.log10(1 + 3 / 0.02));
  const cutScore = 100 * Math.min(1, (c.cutDeg / 80) ** 1.6);
  const distScore = 100 * Math.min(1, c.distanceCue / 2.6);

  let d = 0.55 * (100 - tolScore) + 0.25 * cutScore + 0.2 * distScore;
  if (c.kind === 'combo') d += 12;
  if (c.kind === 'bank') d += 18;
  // 加塞会带来偏杆（squirt），瞄准精度比中杆差一截。不加这点代价，
  // 求解器会为了几厘米的停位差到处加塞——现实里没人这么打球。
  if (Math.abs(c.tip?.a ?? 0) > 0.05) d += 6;
  if (c.scratchRisk) d = Math.min(100, d + 18);
  return Math.round(Math.min(100, d) * 10) / 10;
}

/**
 * 难度档位隐含的瞄准精度假设（度）。
 *
 * 这个数字不是拍的，是 `_research/probe-sigma-sweep.mjs` 实测出来的：
 * 固定 160 个首推方案，扫 σ = 0.10° / 0.20° / 0.30° / 0.45° / 0.60° / 0.90°，
 * 按档位统计真实命中率（每杆 60 次，物理核打）：
 *
 *   σ        很容易   容易    中等    偏难
 *   0.10°    99%✓     94%✓   85%✓   83%✓
 *   0.20°    97%✓     82%✓   63%✓   43%✓
 *   0.30°    94%✓     69%✗   47%✗   37%✓
 *   0.60°    80%✗     46%✗   29%✗   13%✗
 *
 * 判定下限（写死在探针里，不事后调整）：很容易 ≥85%、容易 ≥70%、中等 ≥50%、偏难 ≥30%。
 * 结论：这套档位只在 σ ≲ 0.2° 时诚实；σ 再大，「很容易」也会掉到 80% 以下。
 *
 * 0.2° 的含义：1 m 外偏 3.5 mm，2 m 外偏 7 mm。这是练过的人的水平，不是新手。
 * 所以 UI 必须把这个前提说出来，否则用户看到「很容易」会以为自己随便打就行。
 */
export const LABEL_SIGMA_DEG = 0.2;

/** 难度分 → 人类可读档位 */
export function difficultyLabel(score) {
  if (score < 25) return '很容易';
  if (score < 40) return '容易';
  if (score < 55) return '中等';
  if (score < 70) return '偏难';
  if (score < 85) return '很难';
  return '极难';
}

/**
 * 难度档位隐含的瞄准精度假设，写成一句可以塞进括号里的短语。
 *
 * 存在的理由：`difficultyLabel` 单独看会误导——同一个「很容易」，瞄得准是 97%，
 * 瞄得松就只剩 80%。与其把假设藏在源码注释里，不如让用户看得见。
 *
 * 只返回短语、不带档位名，因为调用方通常在后面还要接
 * 「（综合 22.7/100 · 单杆难度 32.3/100）」，两个括号连着排会很难读。
 */
export function difficultyCaveat() {
  return `按瞄准误差 ±${LABEL_SIGMA_DEG}° 估算`;
}

export function pocketName(id) {
  const map = {
    'c-bl': '左下底袋',
    'c-br': '右下底袋',
    'c-tl': '左上底袋',
    'c-tr': '右上底袋',
    'm-b': '下中袋',
    'm-t': '上中袋',
  };
  return map[id] ?? id;
}

/**
 * 把一个候选方案说成一句人话。
 * 单独导出，是因为 UI 里切换备选方案时要用同一个说法，
 * 不能在页面里另写一份拼字符串的逻辑——那样两边迟早不一致。
 */
export function describeCandidate(c) {
  if (c.kind === 'break') {
    const parts = [
      `开球：打顶点 ${c.targetNumber} 号球`,
      `全力`,
      c.tip.name,
      `瞄准偏移 ${c.aimOffsetDeg.toFixed(2)}°`,
    ];
    return parts.join(' · ');
  }
  if (c.kind === 'direct') {
    return `没有进球机会，直接撞 ${c.targetNumber} 号球（保证合法碰球） · ${c.power.name}力`;
  }
  if (c.kind === 'combo') {
    const parts = [
      `组合球：打 ${c.viaNumber} 号球撞 ${c.targetNumber} 号球进${pocketName(c.pocketId)}`,
      `两级切角最大 ${c.cutDeg.toFixed(0)}°`,
      toleranceText(c),
      `${c.power.name}力`,
      c.tip.name,
    ];
    addPositioningAdvice(parts, c);
    if (c.leaveScore !== null && c.leaveScore !== undefined) {
      const tag = c.leaveScore >= 55 ? '走位好' : c.leaveScore >= 30 ? '走位一般' : '走位差';
      parts.push(`${tag}（下一杆容错 ±${c.nextToleranceDeg.toFixed(2)}°）`);
    }
    return parts.join(' · ');
  }
  if (c.kind === 'bank') {
    const railName = {
      ymin: '下库',
      ymax: '上库',
      xmin: '左库',
      xmax: '右库',
    }[c.bankRail] ?? c.bankRail;
    const parts = [
      `翻袋：${c.targetNumber} 号球翻${railName}进${pocketName(c.pocketId)}`,
      `切角 ${c.cutDeg.toFixed(0)}°`,
      toleranceText(c),
      `${c.power.name}力`,
      c.tip.name,
    ];
    addPositioningAdvice(parts, c);
    if (c.leaveScore !== null && c.leaveScore !== undefined) {
      const tag = c.leaveScore >= 55 ? '走位好' : c.leaveScore >= 30 ? '走位一般' : '走位差';
      parts.push(`${tag}（下一杆容错 ±${c.nextToleranceDeg.toFixed(2)}°）`);
    }
    return parts.join(' · ');
  }
  if (c.kind === 'safety') {
    // 防守不进球，所以没有"进哪个袋"，只能说清撞哪颗、切多薄、留成什么样
    const parts = [
      `防守：打 ${c.targetNumber} 号球${
        Math.abs(c.aimOffsetDeg) < 1 ? '（正对）' : `偏 ${c.aimOffsetDeg.toFixed(0)}°`
      }`,
      `${c.power.name}力`,
      c.tip.name,
    ];
    if (typeof c.safetyGainDeg === 'number') {
      parts.push(
        `对手容错从 ±${c.safetyBaseToleranceDeg.toFixed(2)}° 压到 ±${c.safetyOppToleranceDeg.toFixed(2)}°`
      );
    } else {
      parts.push(`对手接手后容错 ±${c.safetyOppToleranceDeg.toFixed(2)}°`);
    }
    if (c.foulRisk) parts.push('⚠ 这一杆可能不够库');
    return parts.join(' · ');
  }
  const parts = [
    `打 ${c.targetNumber} 号球进${pocketName(c.pocketId)}`,
    `切角 ${c.cutDeg.toFixed(0)}°`,
    toleranceText(c),
    `${c.power.name}力`,
    c.tip.name,
  ];
  if (c.scratchRisk) parts.push('⚠ 母球有摔袋风险');
  addPositioningAdvice(parts, c);
  if (c.leaveScore !== null && c.leaveScore !== undefined) {
    const tag = c.leaveScore >= 55 ? '走位好' : c.leaveScore >= 30 ? '走位一般' : '走位差';
    parts.push(`${tag}（下一杆容错 ±${c.nextToleranceDeg.toFixed(2)}°）`);
  }
  return parts.join(' · ');
}

/**
 * 容错角度换成手上的说法：母球走这么远，方向偏几毫米就打不进。
 *
 * 只给「±0.57°」这种数字，球友读不出它到底有多难——0.57° 和 0.2° 在纸上
 * 差三倍，落到手上是「偏 8 毫米」和「偏 3 毫米」，后者基本等于打不进。
 * 换算用母球到假想球的距离，也就是这一杆真正要走的路。
 */
export function toleranceText(c) {
  const base = `容错 ±${c.toleranceDeg.toFixed(2)}°`;
  const dist = c.distanceCue;
  // 贴球（不到 20 厘米）时这个换算会变成「偏 1 毫米」，没有信息量，干脆不给
  if (!(c.toleranceDeg > 0) || !(dist > 0.2)) return base;
  const mm = Math.tan((c.toleranceDeg * Math.PI) / 180) * dist * 1000;
  const shown =
    mm < 1 ? `${mm.toFixed(1)} 毫米` : mm < 10 ? `${Math.round(mm)} 毫米` : `${(mm / 10).toFixed(1)} 厘米`;
  return `${base}（母球走 ${dist.toFixed(2)} 米，方向偏 ${shown}就打不进）`;
}

/**
 * 母球停位说人话：台面哪一块 + 离最近那条库多远。
 *
 * 原来写 `(1.62, 0.83) 米`，那是给写代码的人看的坐标，站在台边的球友没法
 * 把这个数字变成「往哪儿走」。改成九宫格 + 到库距离，能直接对着台子找位置。
 */
export function cueRestText(table, rest) {
  if (!rest) return '母球建议停位：—';
  // 没带球台（旧调用方或存档里的候选）就退回坐标，总比报错强
  if (!table || !(table.length > 0)) {
    return `母球建议停位 (${rest.x.toFixed(2)}, ${rest.y.toFixed(2)}) 米`;
  }
  const col = rest.x / table.length < 1 / 3 ? '左' : rest.x / table.length > 2 / 3 ? '右' : '';
  const row = rest.y / table.width < 1 / 3 ? '下' : rest.y / table.width > 2 / 3 ? '上' : '';
  const where = col && row ? `台面${row}${col}` : col || row ? `台面靠${col || row}` : '台面正中';

  const rails = [
    { name: '左库', d: rest.x },
    { name: '右库', d: table.length - rest.x },
    { name: '下库', d: rest.y },
    { name: '上库', d: table.width - rest.y },
  ].sort((a, b) => a.d - b.d);
  const near = rails[0];
  return `母球建议停位：${where}（距${near.name} ${Math.round(near.d * 100)} 厘米）`;
}

function addPositioningAdvice(parts, candidate) {
  if (!candidate.positioningRequired || !candidate.cueRest) return;
  parts.push(cueRestText(candidate.table, candidate.cueRest));
  if (candidate.nextShot) {
    parts.push(
      `下一杆打 ${candidate.nextShot.targetNumber} 号进${pocketName(candidate.nextShot.pocketId)}`
    );
  } else {
    parts.push('剩余球暂无直接进球线');
  }
}

/**
 * 开球方案：瞄准球堆顶点球，全力打。
 *
 * 为什么不能复用 solveShot：开球时 15 颗球挤成三角阵，没有任何一颗有通往袋口的
 * 通路，所以"打进某个袋"的求解必然返回空。而开球的规则要求也不是进袋，是
 * 「至少四颗目标球被驱向库边」。所以这里的目标函数完全不同：把球堆打散。
 *
 * 瞄准点取顶点球心稍偏一点点（实测偏移 0 时最稳），力度用最大档。
 * 杆法用中低杆：母球撞完球堆后往回缩，能明显降低母球跟着冲进袋的概率。
 *
 * @returns {object} 形状与 solveShot 的候选一致，额外带 kind:'break'
 */
export function solveBreak(table, balls, opts = {}) {
  const cueId = opts.cueId ?? 'cue';
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) throw new Error(`找不到母球: ${cueId}`);

  const live = balls.filter((b) => b.id !== cueId && !b.pocketed);
  if (!live.length) return null;

  // 顶点球 = 离母球最近的那颗。
  //
  // 这里原本写的是「离 8 号点最近的球」，黑八三角阵里它正好是顶点，但九球的菱形
  // 压在底点（8 号点）上的是**正中的 9 号球**，于是开球会照着 9 号瞄——目标球选错，
  // 而且九球里开球直接打进 9 号是要判赢的，瞄正中那颗等于把巧球当常规打法。
  // 改成「离母球最近」对两个玩法都成立：架子摆在母球前方，最靠母球那颗就是顶点。
  let apex = live[0];
  let bestD = Infinity;
  for (const b of live) {
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && b.x < apex.x)) {
      bestD = d;
      apex = b;
    }
  }

  const aimAngle = Math.atan2(apex.y - cue.y, apex.x - cue.x);
  const tip = { name: '中低杆（压低母球）', a: 0, b: -0.15 };

  return {
    kind: 'break',
    targetId: apex.id,
    targetNumber: apex.number,
    pocketId: null,
    pocketKind: null,
    ghost: { x: apex.x, y: apex.y },
    contactNormal: { x: 0, y: 0 },
    throwDeg: 0,
    aimAngle,
    aimAngleDeg: aimAngle * DEG,
    aimOffsetDeg: 0,
    cutDeg: 0,
    toleranceDeg: 0,
    distanceCue: Math.hypot(apex.x - cue.x, apex.y - cue.y),
    distancePocket: 0,
    speed: SPEED.break,
    power: pickPower(SPEED.break),
    tip,
    scratchRisk: false,
    cuePath: null,
    verified: false,
    difficulty: 20,
  };
}

/**
 * 兜底方案：没有进球机会时，直接撞向最近的合法目标球。
 *
 * 这不是"进攻"，是"保证这一杆合法"——先碰到合法球、并把球撞向库边，
 * 满足 WPA 3.2 与 3.3。真实比赛里这位置该打防守（藏母球让对手没得打），
 * 但那需要评估"对手能打到什么"，是另一个量级的问题；直接撞至少能让对局
 * 继续下去，而不是卡在"求解失败"上。
 *
 * 为什么还要挑方向：
 *   直接朝球心撞会把目标球推向它自己的前进方向，可能正好推进袋口——
 *   那是给对手送分。而且如果母球和目标球撞完之后双双贴在一起、又没球碰库，
 *   反复直撞会让整局卡死在同一个局面上（实测九球 seed 777 卡了 300 杆）。
 *   所以这里扫一圈方向，优先选「撞完之后至少有球跑得远」的那一杆。
 *
 * @returns {object|null}
 */
export function solveDirectHit(table, balls, opts = {}) {
  const cueId = opts.cueId ?? 'cue';
  const cue = balls.find((b) => b.id === cueId);
  if (!cue) throw new Error(`找不到母球: ${cueId}`);

  const allow = opts.allow ? new Set(opts.allow) : null;
  const targets = balls.filter(
    (b) => b.id !== cueId && !b.pocketed && (!allow || allow.has(b.number))
  );
  if (!targets.length) return null;

  // 选离母球最近的合法目标：距离越短越不容易在途中碰到别的球
  let target = targets[0];
  let bestD = Infinity;
  for (const b of targets) {
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bestD) {
      bestD = d;
      target = b;
    }
  }

  const headOn = Math.atan2(target.y - cue.y, target.x - cue.x);
  const tip = { name: '中杆', a: 0, b: 0 };

  // 扫一圈方向：正对，再试两侧。
  //
  // 判据是「打完这一杆，台面上的球到底动了多少」，不是「母球离目标球多远」。
  // 一开始写的是后者，结果被一个贴库球骗了：目标球贴着右库，正对撞它时
  // 它一步都动不了（动量全被库边吃掉），而母球停在原地——母球到目标球的
  // 距离反而很大，被判成"搅开了"，于是双方来回打了几百杆同一个局面。
  // 现在按「所有目标球离开原位的总位移」算，贴库正撞的位移是 0，会被淘汰。
  //
  // 另外要跳过 firstContact 为 null 的（那是没碰到任何球，直接犯规）。
  const offsets = [0, 5, -5, 10, -10, 16, -16, 24, -24, 35, -35];
  const speeds = [SPEED.medium, SPEED.firm];
  const before = new Map(balls.map((b) => [b.id, b]));
  let best = null;
  for (const off of offsets) {
    const aimAngle = headOn + (off * Math.PI) / 180;
    for (const speed of speeds) {
      const r = trialShot(table, balls, cueId, target.id, '__none__', aimAngle, speed, tip);
      if (r.firstContact === null) continue; // 白跑一趟，还可能判犯规
      const cueAfter = r.balls.find((b) => b.id === cueId);
      if (!cueAfter || cueAfter.pocketed) continue; // 母球摔袋，不值得

      let moved = 0;
      let targetMoved = 0;
      let targetPocketed = false;
      for (const after of r.balls) {
        if (after.number === 0) continue;
        const orig = before.get(after.id);
        if (!orig || orig.pocketed) continue;
        if (after.pocketed) {
          moved += 1;
          if (after.id === target.id) targetPocketed = true;
          continue;
        }
        const d = Math.hypot(after.x - orig.x, after.y - orig.y);
        moved += d;
        if (after.id === target.id) targetMoved = d;
      }
      // 目标球动得越多越好（至少别原地不动）；顺手把别的球带开算附加分
      const score = (targetPocketed ? 5 : targetMoved) + 0.25 * moved;
      if (!best || score > best.score) {
        best = { aimAngle, off, speed, score, targetMoved, targetPocketed };
      }
    }
  }

  const aimAngle = best ? best.aimAngle : headOn;
  const speed = best ? best.speed : SPEED.medium;

  return {
    kind: 'direct',
    targetId: target.id,
    targetNumber: target.number,
    pocketId: null,
    pocketKind: null,
    ghost: { x: target.x, y: target.y },
    contactNormal: { x: 0, y: 0 },
    throwDeg: 0,
    aimAngle,
    aimAngleDeg: aimAngle * DEG,
    aimOffsetDeg: best ? best.off : 0,
    cutDeg: 0,
    toleranceDeg: 0,
    distanceCue: bestD,
    distancePocket: 0,
    speed,
    power: pickPower(speed),
    tip,
    scratchRisk: false,
    cuePath: null,
    verified: false,
    difficulty: 60,
  };
}

/**
 * 从「接下来该谁打」的角度看这个局面有多好打：返回他能拿到的最好容错窗口（度）。
 *
 * 0 意味着一颗球都打不了（真的被斯诺克了）——防守就是冲着这个去的。
 * 选项里没有别的信息，是因为防守只需要一个可比较的标量：谁留下的数字更小，
 * 谁就藏得更好。要看具体是哪一杆，那是进攻求解的事。
 *
 * @param {object} table
 * @param {object[]} balls 打完之后的球位
 * @param {{cueId?:string, allow?:number[]}} [opts]
 */
export function positionTolerance(table, balls, opts = {}) {
  return bestNextTolerance(table, balls, opts.cueId ?? 'cue', opts.allow ?? null);
}

/**
 * 生成一份完整的教练卡：最佳方案 + 备选 + 一句人话解说。
 * 传入 opts.candidates 可复用已经算好的结果，避免重复求解。
 */
export function coach(table, balls, opts = {}) {
  const all = opts.candidates ?? solveShot(table, balls, opts);
  if (!all.length) {
    return {
      found: false,
      message: '没有可以直接进攻的球——需要打防守，或先解一杆。',
      candidates: [],
    };
  }

  const best = all[0];
  const v = best.value ?? best.difficulty;

  return {
    found: true,
    best,
    alternatives: all.slice(1, 4),
    message: describeCandidate(best),
    verdict: `${difficultyLabel(v)}（综合 ${v}/100 · 单杆难度 ${best.difficulty}/100 · ${difficultyCaveat()}）`,
  };
}

/**
 * 球局里"这一杆打什么"：开球、正常进攻/组合/翻袋、防守、还是兜底直撞。
 *
 * 单独一个函数，是因为这些情形的目标函数不一样，混在一起会让
 * solveShot 长出 if (isBreak) 这种分支——那会把"进攻求解"这件事污染掉，
 * 而进攻求解是本项目最需要保持干净的一段。
 *
 * kind 的取值：
 *   'break'  开球
 *   'attack' 直接打（母球直接碰目标球进袋）
 *   'combo'  组合球（打 A 撞 B 进袋）
 *   'bank'   翻袋（目标球撞库后进袋）
 *   'safety' 防守（藏母球，让对手难打）
 *   'direct' 兜底：没有进球机会，只保证合法碰球
 *
 * 防守的取舍（opts.safety）：
 *   · false（默认）：不找防守，退回兜底直撞。练习模式用这个——用户是想看
 *     "没有进攻机会"这件事，不是想看对手怎么迫害自己。
 *   · true：找不到进攻时调 safety.solveSafety()。球局里玩家与对手都用这个。
 * 为什么不做「进攻机会一般时也防守」：Smith (AAAI-06) 用进球概率门槛
 * t0=65% 来决定要不要放弃进攻，但那需要可靠的进球概率估计；这里的
 * difficulty 不是概率，硬套门槛会把"偏难但该打的球"误判成该防守。
 * 所以只在真的一颗都进不了时才防守——宁可保守，不做没把握的判断。
 *
 * @param {object} table
 * @param {object} game rules.createGame 的返回值
 * @param {{allow?:number[], extras?:boolean, budgetMs?:number, safety?:boolean}} [opts]
 * @returns {{plan:object|null, kind:string, alternatives:object[]}}
 */
export function planShot(table, game, opts = {}) {
  const cue = game.balls.find((b) => b.number === 0 || b.id === 'cue');
  if (!cue) throw new Error('球局里找不到母球');

  if (game.breakShot) {
    const plan = solveBreak(table, game.balls, { cueId: cue.id });
    return { plan, kind: 'break', alternatives: [] };
  }

  const allow = opts.allow ?? null;
  const all = solveShot(table, game.balls, {
    cueId: cue.id,
    allow,
    extras: opts.extras,
    budgetMs: opts.budgetMs,
  });
  if (all.length) {
    // 首选是直接球时说法仍是"进攻"；首选是组合球/翻袋时如实说是那种球
    const kind = all[0].kind === 'combo' || all[0].kind === 'bank' ? all[0].kind : 'attack';
    return { plan: all[0], kind, alternatives: all.slice(1, 4) };
  }

  if (opts.safety) {
    const safety = solveSafety(table, game.balls, { cueId: cue.id, allow });
    if (safety) {
      return { plan: safety, kind: 'safety', alternatives: [] };
    }
  }

  const plan = solveDirectHit(table, game.balls, { cueId: cue.id, allow });
  return { plan, kind: 'direct', alternatives: [] };
}
