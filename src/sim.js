/**
 * 三处调用方的单一仿真入口：solver.trialShot / safety.shoot / rules.simulateShot。
 *
 * 为什么要有这个文件
 * ------------------
 * 「复制球 → strike → runShot → 从事件流里取首碰」这段逻辑以前抄了三份，每份都带着
 * 自己的 maxTime（20 / 20 / 26）、自己的返回值形状（firstContact / hitNumber / facts），
 * 改一份漏两份就会让「求解器验证的」和「真打发生的」不是同一件事。物理步进本身
 * （physics.js 的 stepWorld）没有重写，这里只是把**调用序列**收成一处。
 *
 * 返回值是三种形状的并集，各方按需取自己那一份，各自再做一层薄适配：
 *   - firstContact / firstContactId：solver 与 rules 用的形状
 *   - hitNumber：safety 用的形状（等于 firstContact）
 *   - events / elapsed / settled / balls：rules 拿去做规则结算
 *
 * 取向：行为完全不变优先于「更漂亮」。所以 copy 的两种既有语义都留着（见 opts.normalize），
 * maxTime 由调用方按用途传入（见 constants.js 的 SHOT_TIME_LIMITS），一个数值都没改。
 */
import { SEARCH_DT, MAX_SHOT_TIME } from './constants.js';
import { createBall, createWorld, strike, runShot } from './physics.js';

/** 求解/防守侧的快照：清掉速度与旋转，保留 pocketed（“现在球已经落袋”这个事实不能丢）。 */
const resetMotion = (b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 });

/** 规则侧的快照：动学字段齐全就浅拷贝，不齐（例如刚摆好的球）就用 createBall 补齐。 */
function snapshotBall(b) {
  return typeof b.vx === 'number' && typeof b.pocketed === 'boolean'
    ? { ...b }
    : createBall(b.id, b.x, b.y, b);
}

/**
 * 整杆仿真计数器：只统计**真正跑起来**的整杆仿真（strike 之后被 runShot 跑完的），
 * no_cue / cue_pocketed / no_target 这些连仿真都没跑的早退不计。
 *
 * 用途是给「不许靠减少仿真次数换速度」这条约束装一个抓手：
 * test/solver-budget.test.js 用固定局面钉住「一次求解最多跑多少次整杆仿真」，
 * 谁要是无意把剪枝改回盲扫、或者反过来偷偷少跑几次，测试都会变红。
 */
let simRuns = 0;

/** @returns {number} 自上次 resetSimRunCount 以来真正执行过的整杆仿真次数 */
export function simRunCount() {
  return simRuns;
}

/** 清零计数器（测试用） */
export function resetSimRunCount() {
  simRuns = 0;
}

const NO_SHOT = {
  ok: false,
  cue: null,
  balls: [],
  events: [],
  elapsed: 0,
  settled: false,
  firstContact: null,
  firstContactId: null,
  hitNumber: null,
  hitBall: null,
};

/**
 * 跑一杆仿真。世界是本地副本，调用方的 balls 不会被改。
 *
 * @param {object} table
 * @param {object[]} balls 击球前的球（不会被修改）
 * @param {{ angle: number, speed: number, tip?: { a: number, b: number }, cueId?: string }} shot
 * @param {object} [opts]
 * @param {number} [opts.maxTime] 仿真时限，必须由调用方按用途传（见 SHOT_TIME_LIMITS）
 * @param {number} [opts.dt] 步长，默认 SEARCH_DT（求解与真打必须同一步长）
 * @param {boolean} [opts.normalize] true 时用规则侧补球策略，false 时清速度
 * @param {string} [opts.cueId] shot.cueId 的补充写法
 * @param {string} [opts.targetId] 给了就先确认这颗球在台面上，缺了直接返回 no_target
 * @param {boolean} [opts.rejectPocketedCue] 母球已落袋就拒绝（只有防守侧原来这么判）
 * @param {(world: object) => void} [opts.onStart] strike 之后、第一步之前触发一次
 * @param {(e: object) => void} [opts.onEvent]
 * @param {(world: object, elapsed: number) => void} [opts.onStep]
 */
export function simulateShot(table, balls, shot, opts = {}) {
  const cueId = shot.cueId ?? opts.cueId ?? 'cue';
  const dt = opts.dt ?? SEARCH_DT;
  const maxTime = opts.maxTime ?? MAX_SHOT_TIME;

  const copy = balls.map(opts.normalize ? snapshotBall : resetMotion);
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === cueId);

  if (!cue) return { ...NO_SHOT, cue: null, balls: copy, reason: 'no_cue' };
  if (opts.rejectPocketedCue && cue.pocketed) return { ...NO_SHOT, cue, balls: copy, reason: 'cue_pocketed' };
  // 求解侧的老行为：目标球不在台面上就当作「这一杆没意义」，连仿真都不跑。
  if (opts.targetId && !copy.some((b) => b.id === opts.targetId)) {
    return { ...NO_SHOT, cue, balls: copy, reason: 'no_target' };
  }

  simRuns++;
  strike(cue, { angle: shot.angle, speed: shot.speed, tip: shot.tip ?? { a: 0, b: 0 } });
  // onStart 在 strike 之后、第一步之前触发：规则侧要在这里拿到副本、建滚动追踪、
  // 存第 0 帧快照（回放需要「击球前」那一帧）。放在 strike 之后是为了与原来的时序一致。
  if (opts.onStart) opts.onStart(world);

  const run = runShot(world, { dt, maxTime, onEvent: opts.onEvent, onStep: opts.onStep });

  // 首碰：事件流里第一条牵涉母球的球球接触（与三处原实现逐字一致）
  let firstContactId = null;
  let contactIndex = -1;
  for (let i = 0; i < run.events.length; i++) {
    const e = run.events[i];
    if (e.type !== 'ball') continue;
    if (e.a === cueId) { firstContactId = e.b; contactIndex = i; break; }
    if (e.b === cueId) { firstContactId = e.a; contactIndex = i; break; }
  }
  const hitBall = firstContactId ? copy.find((b) => b.id === firstContactId) ?? null : null;
  const firstContact = hitBall ? hitBall.number : null;

  return {
    ok: true,
    cue,
    balls: copy,
    events: run.events,
    elapsed: run.time,
    settled: run.settled,
    firstContact,
    firstContactId,
    contactIndex,
    hitNumber: firstContact,
    hitBall,
  };
}