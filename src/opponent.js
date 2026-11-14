// 对手出杆：给「打一整局」一个真正的对手。
//
// 设计上刻意不引入任何"作弊"路径——对手用的就是玩家点「求解」时跑的同一套
// planShot / simulateShot / resolveShot，参数完全一致，只是把点击换成了自动触发。
// 这样「对手会不会打」和「玩家能不能打」是同一个问题，不存在两套逻辑走偏。
//
// 已知的简化（写在代码里而不是藏起来）：
//   - 只在两颗球都进不了的时候才防守（见 solver.planShot 的 opts.safety 说明）。
//     为什么不"进攻机会一般时也防守"：那需要一个可靠的进球概率估计，
//     而这里的 difficulty 是难度分不是概率，硬套门槛会误判。
//   - 会算两步：在能进的球里，挑一杆打完之后对方最难上手的（见下方 choosePlan）。
//     但它不会为了防守放弃一个能进的球，也不会算第三步。
//   - 持球时只挑"离所有球最远的合法空位"，不做位置优化。
// 所以它是「会打球、会留后手、也会藏一手的对手」，但不是会算很多层的高手。

import {
  cloneGame,
  headStringX,
  legalTargetNumbers,
  numbersOnTable,
  placeCueBall,
  placementAllowed,
  resolveShot,
  simulateShot,
} from './rules.js';
import { SEARCH_DT } from './constants.js';
import { planShot, positionTolerance, toleranceToEase } from './solver.js';

/** 打完这一杆之后，对方还剩多好打，在选杆里占多少权重（0 = 只看这一杆） */
const LOOKAHEAD_WEIGHT = 0.45;
/** 犯规的代价：白送对方一个自由球，比"这一杆难进"严重得多 */
const LOOKAHEAD_PENALTY_FOUL = 45;
/** 没打进的代价：台面原样交出去，对方多半能直接上手 */
const LOOKAHEAD_PENALTY_MISS = 30;

/**
 * 两步选杆：先让求解器按「这一杆的综合价值」排出前几个，再各自真打一遍，
 * 按「我这一杆的把握 + 打完之后对方有多难打」重排。
 *
 * 为什么需要这一步：求解器的 `value` 已经含走位修正，但那个修正是「**我自己**
 * 下一杆好不好打」，用的是我自己的目标球。对局里打完之后换对方上手，
 * 所以要评的是**对方**剩下的那几颗球有多好打。两者不是一回事：
 * 我把球打进、母球停在对方三颗球都能打的位置，对这一杆的评价是满分，
 * 对局面却是最差的一种。
 *
 * 代价：每个候选多一次 simulateShot + 一次 positionTolerance。
 * 默认只看前 3 个候选，实测整杆多花几毫秒（见 README「对手会算两步」）。
 *
 * @returns {{plan:object|null, kind:string, alternatives:object[], scores:object[]}}
 */
export function choosePlan(table, game, opts = {}) {
  const base = planShot(table, game, {
    allow: opts.allow,
    safety: opts.safety === true,
    extras: opts.extras,
  });
  // 开球没有"对方上手"这一步，直接按求解器的方案来
  if (!base.plan || base.kind === 'break') return { ...base, scores: [] };

  const limit = opts.lookahead ?? 3;
  const pool = [base.plan, ...base.alternatives].slice(0, limit);
  const scored = pool.map((candidate, index) => ({
    candidate,
    index,
    ...scoreCandidate(table, game, candidate, opts),
  }));

  // index 参与比较：分数相同时保留求解器原来的顺序，结果才可复现
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const winner = scored[0];
  return {
    plan: winner.candidate,
    kind: base.kind,
    alternatives: scored.slice(1).map((s) => s.candidate),
    scores: scored.map((s) => ({
      targetNumber: s.candidate.targetNumber,
      pocketId: s.candidate.pocketId,
      singleShotValue: s.candidate.value ?? s.candidate.difficulty,
      score: Math.round(s.score * 10) / 10,
      potted: s.potted,
      fouled: s.fouled,
      opponentEase: Math.round(s.humanEase * 10) / 10,
      opponentToleranceDeg: Math.round(s.humanTolerance * 100) / 100,
      ended: s.ended,
    })),
  };
}

function scoreCandidate(table, game, candidate, opts) {
  const work = cloneGame(game);
  const shooter = work.turn;
  const facts = simulateShot(
    table,
    work.balls,
    { angle: candidate.aimAngle, speed: candidate.speed, tip: { a: candidate.tip.a, b: candidate.tip.b } },
    { dt: opts.dt ?? SEARCH_DT }
  );
  const { next, report } = resolveShot(work, facts);
  const potted = report.pocketed.length > 0;

  const cue = next.balls.find((b) => b.number === 0 || b.id === 'cue');
  const opponentAllow = legalTargetNumbers(next, numbersOnTable(next.balls));
  const humanTolerance = positionTolerance(table, next.balls, {
    cueId: cue?.id ?? 'cue',
    allow: opponentAllow,
  });
  const humanEase = toleranceToEase(humanTolerance);

  let score = 100 - (candidate.value ?? candidate.difficulty);
  if (report.fouled) score -= LOOKAHEAD_PENALTY_FOUL;
  if (!potted) score -= LOOKAHEAD_PENALTY_MISS;
  score += LOOKAHEAD_WEIGHT * (100 - humanEase);

  // 直接赢下这一局，前面所有分数都不重要了
  if (report.ended) score += report.winner === shooter ? 1000 : -1000;

  return { score, potted, fouled: report.fouled, humanTolerance, humanEase, ended: report.ended };
}

/**
 * 给持球的对手挑一个合法、不压球、离所有目标球尽量远的母球位置。
 *
 * 用网格采样而不是 findFreeSpot：findFreeSpot 从给定点向外螺旋找，
 * 遇到第一块空地就停，很容易把母球塞在球堆边上。这里要的是"远离球堆"，
 * 所以先撒点、再按最近球距离取最大。
 *
 * @returns {{x:number,y:number}|null} 找不到返回 null
 */
export function pickCueSpot(game, opts = {}) {
  const table = game.table;
  const R = table.ballRadius;
  const zone = game.ballInHand?.zone ?? 'anywhere';
  const xMax = zone === 'kitchen' ? headStringX(table) : table.bounds.maxX;
  const cols = opts.cols ?? 12;
  const rows = opts.rows ?? 8;

  let best = null;
  let bestClear = -1;
  for (let i = 1; i < cols; i++) {
    for (let j = 1; j < rows; j++) {
      const x = table.bounds.minX + ((table.bounds.maxX - table.bounds.minX) * i) / cols;
      const y = table.bounds.minY + ((table.bounds.maxY - table.bounds.minY) * j) / rows;
      if (x > xMax + 1e-9) continue;
      if (!placementAllowed(game, x, y)) continue;

      let clear = Infinity;
      for (const b of game.balls) {
        if (b.number === 0 || b.pocketed) continue;
        clear = Math.min(clear, Math.hypot(b.x - x, b.y - y));
      }
      // 必须留出直径再加一点余量，否则 placeCueBall 会把它推开、位置就不受控了
      if (clear < 2 * R + 1e-3) continue;
      if (clear > bestClear) {
        bestClear = clear;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * 替当前轮到的一方走一杆，返回这一杆的全部中间结果。
 *
 * 不改入参：内部先 cloneGame，所有摆球与结算都发生在副本上。
 * 这样调用方可以先播动画、播完再把 next 装回界面——动画期间局面仍然是旧的。
 *
 * @param {object} table
 * @param {object} game  rules.createGame 的返回值
 * @param {object} [opts]
 * @param {boolean} [opts.record=false] 是否逐帧记录（演示回放用；测试关掉省内存）
 * @param {number}  [opts.dt] 回放步长
 * @param {boolean} [opts.safety=false] 没有进攻机会时是否找防守（默认关，见文件头）
 * @returns {{ok:true, plan:object, kind:string, alternatives:object[], facts:object,
 *            next:object, report:object, cuePlaced:boolean}
 *          |{ok:false, reason:string, plan:null, facts:null, next:object, report:null}}
 */
export function takeTurn(table, game, opts = {}) {
  const work = cloneGame(game);

  if (work.phase === 'ended') {
    return { ok: false, reason: 'ended', plan: null, facts: null, next: work, report: null };
  }
  if (work.requiresRerack) {
    return { ok: false, reason: 'needs_rerack', plan: null, facts: null, next: work, report: null };
  }

  let cuePlaced = false;
  let cueSpot = null;
  if (work.ballInHand) {
    const spot = pickCueSpot(work, opts);
    if (!spot || !placeCueBall(work, spot.x, spot.y)) {
      return { ok: false, reason: 'no_spot', plan: null, facts: null, next: work, report: null };
    }
    work.ballInHand = null;
    cuePlaced = true;
    // placeCueBall 可能把球推开一点，所以回报的是它实际落点，不是请求点
    const placed = work.balls.find((b) => b.number === 0 || b.id === 'cue');
    cueSpot = placed ? { x: placed.x, y: placed.y } : spot;
  }

  const allow = legalTargetNumbers(work, numbersOnTable(work.balls));
  const { plan, kind, alternatives, scores } = choosePlan(table, work, {
    allow,
    safety: opts.safety === true,
    dt: opts.dt,
    lookahead: opts.lookahead,
  });
  if (!plan) {
    return { ok: false, reason: 'no_plan', plan: null, facts: null, next: work, report: null };
  }

  const facts = simulateShot(
    table,
    work.balls,
    { angle: plan.aimAngle, speed: plan.speed, tip: { a: plan.tip.a, b: plan.tip.b } },
    { record: opts.record === true, dt: opts.dt ?? SEARCH_DT }
  );
  const { next, report } = resolveShot(work, facts);
  return { ok: true, plan, kind, alternatives, scores, facts, next, report, cuePlaced, cueSpot };
}
