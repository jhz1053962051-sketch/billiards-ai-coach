// 对手出杆：给「打一整局」一个真正的对手。
//
// 设计上刻意不引入任何"作弊"路径——对手用的就是玩家点「求解」时跑的同一套
// planShot / simulateShot / resolveShot，参数完全一致，只是把点击换成了自动触发。
// 这样「对手会不会打」和「玩家能不能打」是同一个问题，不存在两套逻辑走偏。
//
// 已知的简化（写在代码里而不是藏起来）：
//   - 只在一颗球都进不了的时候才防守（见 solver.planShot 的 opts.safety 说明）。
//     为什么不"进攻机会一般时也防守"：那需要一个可靠的进球概率估计，
//     而这里的 difficulty 是难度分不是概率，硬套门槛会误判。
//   - 不为了走位放弃进球。不过 planShot 已按综合价值排序，走位是被考虑过的。
//   - 持球时只挑"离所有球最远的合法空位"，不做位置优化。
// 所以它是「会打球、也会藏一手的对手」，但不是会算很多层的高手。

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
import { planShot } from './solver.js';

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
  const { plan, kind, alternatives } = planShot(table, work, {
    allow,
    safety: opts.safety === true,
  });
  if (!plan) {
    return { ok: false, reason: 'no_plan', plan: null, facts: null, next: work, report: null };
  }

  const facts = simulateShot(
    table,
    work.balls,
    { angle: plan.aimAngle, speed: plan.speed, tip: { a: plan.tip.a, b: plan.tip.b } },
    { record: opts.record === true, dt: opts.dt ?? 1 / 120 }
  );
  const { next, report } = resolveShot(work, facts);
  return { ok: true, plan, kind, alternatives, facts, next, report, cuePlaced, cueSpot };
}
