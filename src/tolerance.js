/**
 * 「打完之后，下一杆还有多好打」的评估。
 *
 * 为什么单独一个文件
 * ------------------
 * 这段只依赖 aim.js / geometry.js / constants.js，本来却住在 solver.js 里，于是
 * safety.js 为了拿 positionTolerance 必须 import solver.js，而 solver.js 又要
 * import safety.js 的 solveSafety——一个纯粹为了一个纯几何函数而存在的循环依赖。
 * 把它搬出来，safety.js 直接从这里取，环就断了；solver.js 继续 re-export
 * positionTolerance，所以 opponent.js 与既有测试不用改一行。
 */
import { MAX_CUT_ATTACK_DEG } from './constants.js';
import { V } from './geometry.js';
import { cutAngleDeg, firstBlocker, aimToleranceDeg } from './aim.js';

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
 *
 * @param {object} table
 * @param {object[]} balls
 * @param {string} cueId
 * @param {number[]|null} [allow]
 * @returns {{targetId:string, targetNumber:number, toleranceDeg:number, [key:string]:any}|null}
 */
export function bestNextShot(table, balls, cueId, allow) {
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
      // 进攻侧切角上限：与 solveShot 用同一条边界（constants.MAX_CUT_ATTACK_DEG = 82）。
      if (cutAngleDeg(cue, ghost, target, pocket) > MAX_CUT_ATTACK_DEG) continue;
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

/** 只要容错角度（度）：没有可打的球时返回 0。 */
export function bestNextTolerance(table, balls, cueId, allow) {
  return bestNextShot(table, balls, cueId, allow)?.toleranceDeg ?? 0;
}

/**
 * 对外入口：打完这一杆之后，下一位（多半是对手）最好打的那颗球有多难。
 * @param {object} table
 * @param {object[]} balls 打完之后的球位
 * @param {{cueId?: string, allow?: number[]|null}} [opts]
 */
export function positionTolerance(table, balls, opts = {}) {
  return bestNextTolerance(table, balls, opts.cueId ?? 'cue', opts.allow ?? null);
}