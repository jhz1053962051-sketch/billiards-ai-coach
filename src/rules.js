// 规则状态机：黑八（8-Ball）与九球（9-Ball）两个玩法。
//
// 条文依据（一手来源，均为 WPA 官方发布）：
//   · WPA《Rules of Play》Effective 2025-09-15，第 3 节 Fouls、第 4 节 8-Ball、第 5 节 9-Ball
//     https://wpapool.com/wp-content/uploads/2026/01/2026.01.02-WPA-Rules.pdf
//     （URL 里的 2026-01-02 是发布日，页眉的生效日是 2025-09-15；引用用后者）
//   · WPA《Regulations》Effective 2025-09-15，Regulation 15/16
//     https://wpapool.com/wp-content/uploads/2025/10/2025.09.15-WPA-Regs-NP.pdf
//
// 已核对的关键条文（原文）：
//   4.3(d)「If no object-ball is pocketed, at least four object-balls must be driven
//           to one or more rails, or the shot results in an illegal break」
//   4.3(e)「Pocketing the 8-ball on a legal break shot is not a foul. If the 8-ball is
//           pocketed, the breaker has the option of: (1) spotting the 8-ball and
//           accepting the balls in position, or (2) re-breaking.」
//   4.3(h)「If the breaker fouls in any manner not listed above, the following player
//           has the option of: (1) accepting the table in position, or (2) taking
//           cue-ball in hand above the Head String.」
//   4.4   「When the table is "open," any object-ball may be struck first except the
//           8-ball. Hitting the 8-ball first when the table is open is a foul unless a
//           group has been completely pocketed.」
//   4.8   「Losing the Rack ... These do not apply to the break shot (see 4.3).」
//
//   5.2   「The object-balls are racked as tightly as possible in a diamond shape, with
//           the 1-ball at the apex of the diamond towards the head of the table and the
//           9-ball in the middle of the diamond and on the Foot Spot.」
//   5.3(b)「if no ball is pocketed, at least four object-balls must be driven to one or
//           more rails, or the shot is a foul」
//   5.3(c)「if no ball is pocketed, three balls must cross the Head String, or the break
//           is considered an "illegal break" (see Regulation 16, Three-Ball Break Rule)」
//   5.5   「If he legally pockets the 9-ball on any shot (except a push out), he wins the Rack.」
//   5.6   「If the 9-ball is pocketed on a foul or push out, or driven off the table, it is
//           spotted (see 1.5 Spotting Balls). No other object-ball is ever spotted.」
//   5.7   「If the shooter commits a standard foul, play passes to his opponent. The
//           cue-ball is in hand, and the incoming player may place it anywhere on the
//           playing surface」(含开球犯规——开球线后只约束开球者本人)
//   3.2   「The first object-ball contacted by the cue-ball on each shot must be the
//           lowest-numbered ball remaining on the table.」
//   3.13  「If a player fouls three times without making an intervening legal shot, it is a
//           serious foul. In games scored by the Rack, such as 9-Ball, the fouls must be in
//           a single Rack. Some games such as 8-Ball do not include this rule. The referee
//           must warn a shooter who is on two fouls ... Otherwise, a possible third foul
//           will be considered to be only the second.」
//   5.8   「For 3.13 Three Consecutive Fouls, the penalty is loss of the current Rack.」
//   Reg.16「(1) On the break shot, a minimum of three object-balls must either be pocketed,
//           or cross the Head String line, or a combination of both. ... (2) If a player
//           fails to meet the requirements in (1), but otherwise makes a legal break, the
//           incoming player has the choice to accept the tables as is, or hand the shot
//           back to his opponent. ... (5) If a player fails to meet the requirements of (1)
//           but otherwise makes a legal break and pockets the 9-ball, the 9-ball is spotted
//           before the next shot is played.」
//
// 两个玩法的差别（这也是为什么不能只改摆球就说是"支持九球"）：
//   · 黑八：分组、台面 open、清完本组才能打 8 号、8 号进袋判胜负、没有三犯、开球线后持球。
//   · 九球：不分组、永远先碰最小号、9 号进袋判胜、犯规进 9 要回位、有正式三犯、
//           犯规一律全场自由球、另有 Regulation 16 的"三球过线"非法开球。
//
// 结构参考：henshmi/Classic-Pool-Game（MIT, 291★）的「事件收集 → 回合结算」两段式，
// 但本文件未复制其任何代码。该项目的 GamePolicy.js 只做「首碰是否本组 + 进黑球判胜」，
// 没有合法开球、无库边接触、连续犯规、8 号重摆、ball-in-hand 分区，规则覆盖不足。
// 本文件把两段式落成两个独立函数：simulateShot（只跑物理、只报事实）与
// resolveShot（只读事实、判规则）。两者都不依赖对方，便于分别测试。
//
// 实现范围（明确不做的事写在这里，避免「看起来完整其实没有」）：
//   · 不实现叫袋（4.6 call shot）：本模拟进任何袋都算，不要求指定袋。九球本来也不指球。
//   · 不实现需要杆头轨迹或人体动作才能判定的犯规：3.4 脚离地、3.6 碰球、
//     3.7 双击/贴球、3.8 推杆、3.9 球未停就击球、3.14 慢打、3.15 摆球模板。
//   · 不实现 2.6「球离台」：2D 物理核不会让球离开台面，settlePockets 会把
//     越界的球夹回台内并记 jaw 事件。
//   · 不实现 4.11 僵局：需要裁判主观判断「没有进展」。
//   · 不实现九球的 5.4 推杆（push out）：规则要求先向裁判声明，模拟里没有裁判，
//     而且声明后 3.2/3.3 要暂停——做成自动判定会改变整个回合结构。
//   · 不合法开球只提供 4.3(d)/Reg.16 的「对手重新摆球开球」或「接手」，不提供推杆。
//   · 开球线后摆球（3.10/3.11）只做提示，不拦人。

import { groupOf, findFreeSpot } from './rack.js';
import { createBall, createWorld, stepWorld, allStopped, strike, createRollTracker } from './physics.js';
import { SEARCH_DT, MAX_SHOT_TIME } from './constants.js';

/** 犯规代码。与 WPA 条文的对应写在每条的文字里。 */
export const FOUL = {
  ILLEGAL_BREAK: 'illegal_break',
  SCRATCH: 'scratch',
  NO_CONTACT: 'no_contact',
  WRONG_BALL_FIRST: 'wrong_ball_first',
  NO_RAIL: 'no_rail',
};

const FOUL_TEXT = {
  [FOUL.ILLEGAL_BREAK]: '开球不合法：没有球进袋，且被驱向库边的目标球不足四颗（WPA 4.3d / 5.3b）',
  [FOUL.SCRATCH]: '母球落袋（WPA 3.1）',
  [FOUL.NO_CONTACT]: '母球没有碰到任何球（WPA 3.2）',
  [FOUL.WRONG_BALL_FIRST]: '母球先碰到的不是合法目标球（WPA 3.2）',
  [FOUL.NO_RAIL]: '碰球之后没有球再碰库、也没有球进袋（WPA 3.3）',
};

/**
 * 九球专属的「非犯规」判定：Regulation 16 的三球过线。
 *
 * 这一条和「四球碰库」性质完全不同——四球碰库不达标是**犯规**（对手全场自由球），
 * 三球过线不达标只是「非法开球」，对手可以选择照打或者让原开球方再打一杆。
 * 两者混成一条会让自由球判错，所以单独一个代码。
 */
export const ILLEGAL_BREAK_NOTICE = 'three_ball_rule';

/** 玩法 id → 中文名与摆球球数。 */
export const GAME_KINDS = Object.freeze({
  eightball: { id: 'eightball', label: '黑八', balls: 15 },
  nineball: { id: 'nineball', label: '九球', balls: 9 },
});

/** 开球线位置：靠近开球端（x = 0）的四分之一线。 */
export function headStringX(table) {
  return table.length / 4;
}

/** 8 号点（脚点）：长边中线、距脚端四分之一处。 */
export function footSpotX(table) {
  return (table.length * 3) / 4;
}

/**
 * 建一局。
 * @param {object} table
 * @param {object[]} balls 至少含一颗 number 0 的母球；可含 8 号球（黑八）或 9 号球（九球）
 * @param {{names?:string[], breaker?:0|1, kind?:'eightball'|'nineball'}} [opts]
 */
export function createGame(table, balls, opts = {}) {
  const names = opts.names ?? ['玩家 1', '玩家 2'];
  const breaker = opts.breaker === 1 ? 1 : 0;
  const kind = opts.kind === 'nineball' ? 'nineball' : 'eightball';
  const cue = balls.find((b) => b.number === 0 || b.id === 'cue');
  if (!cue) throw new Error('建局需要一颗母球（number 0 或 id "cue"）');

  // 统一补齐运动学字段。createStandardRack 只给几何和配色，
  // 少了 vx/vy/pocketed 的话物理核会把它们当 undefined 参与运算：
  // 球不会动、整杆判「没碰到球」，而且不报错——这类静默失败最难查。
  // 在入口补一次，任何来源的球对象都能安全进局。
  const normalized = balls.map((b) =>
    typeof b.vx === 'number' && typeof b.pocketed === 'boolean' ? { ...b } : createBall(b.id, b.x, b.y, b)
  );

  const game = {
    kind,
    table,
    balls: normalized,
    players: [
      // warned：九球三犯必须「先提醒再判」——没提醒的话第 3 次只按第 2 次算（3.13）。
      { name: names[0] ?? '玩家 1', group: null, fouls: 0, warned: false },
      { name: names[1] ?? '玩家 2', group: null, fouls: 0, warned: false },
    ],
    turn: breaker,
    breakShot: true,
    open: true,
    ballInHand: null,
    requiresRerack: false,
    phase: 'playing',
    winner: null,
    shots: 0,
    log: [],
    // 九球 Regulation 16：非法开球后由接手方决定「照打」还是「让原方再打」。
    // 这里用 offer 表达这个待决状态，null 表示没有待决事项。
    pendingChoice: null,
  };
  return game;
}

export function cloneGame(game) {
  return {
    ...game,
    balls: game.balls.map((b) => ({ ...b })),
    players: game.players.map((p) => ({ ...p })),
    ballInHand: game.ballInHand ? { ...game.ballInHand } : null,
    log: game.log.slice(),
    pendingChoice: game.pendingChoice ? { ...game.pendingChoice } : null,
  };
}

/** 台面上还没落袋的球号（不含母球）。 */
export function numbersOnTable(balls) {
  return balls.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number);
}

/**
 * 这一杆允许先碰到的球号。
 * @param {object} game
 * @param {number[]} onTable 台面上还没落袋的目标球号
 */
export function legalTargetNumbers(game, onTable) {
  if (game.breakShot) return onTable.slice();

  // 九球不分组，永远只能先碰台面上号码最小的那颗（WPA 3.2，经 5.7 引入）。
  if (game.kind === 'nineball') {
    const low = Math.min(...onTable);
    return Number.isFinite(low) ? [low] : [];
  }

  const mine = game.players[game.turn].group;
  if (!mine) {
    // 台面 open：除 8 号外都可以先碰；只剩 8 号时只能打 8 号（4.4 的例外）
    const rest = onTable.filter((n) => n !== 8);
    return rest.length ? rest : [8];
  }
  const own = onTable.filter((n) => groupOf(n) === mine);
  return own.length ? own : [8];
}

/** 某个组还剩几颗球在台上。 */
export function remainingOfGroup(onTable, group) {
  return onTable.filter((n) => groupOf(n) === group).length;
}

/**
 * 跑一杆真实物理，把这杆发生的事实抽出来。不判规则、不改入参。
 *
 * @param {object} table
 * @param {object[]} balls
 * @param {{cueId?:string, angle:number, speed:number, tip?:{a:number,b:number}}} shot
 * @param {{dt?:number, maxTime?:number}} [opts]
 * @returns {{
 *   firstContact: number|null, firstContactId: string|null,
 *   pocketed: Array<{id:string, number:number, pocket:string}>,
 *   cueScratched: boolean,
 *   railsAfterContact: string[],
 *   objectBallsToRail: number[],
 *   onTableBefore: number[], onTableAfter: number[],
 *   settled: boolean, elapsed: number, events: object[]
 * }}
 */
export function simulateShot(table, balls, shot, opts = {}) {
  const dt = opts.dt ?? SEARCH_DT;
  const maxTime = opts.maxTime ?? MAX_SHOT_TIME;
  const cueId = shot.cueId ?? 'cue';

  const copy = balls.map((b) =>
    typeof b.vx === 'number' && typeof b.pocketed === 'boolean' ? { ...b } : createBall(b.id, b.x, b.y, b)
  );
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === cueId);
  if (!cue) throw new Error(`找不到母球: ${cueId}`);
  if (cue.pocketed) throw new Error('母球已落袋，不能击球');

  const onTableBefore = copy.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number);

  strike(cue, { angle: shot.angle, speed: shot.speed, tip: shot.tip ?? { a: 0, b: 0 } });

  // 录帧是给演示页回放用的：规则结算只要最终状态，但界面要看到球怎么走的。
  // 默认不录（Node 测试和批量模拟都不需要），只有传了 record 才逐帧存快照。
  const frameEvery = Math.max(1, Math.round(opts.frameEvery ?? 1));
  const trackRoll = opts.record ? createRollTracker(copy, table.ballRadius) : null;
  const snapshot = () => {
    const roll = trackRoll();
    return copy.map((b, i) => ({
      x: b.x,
      y: b.y,
      pocketed: b.pocketed,
      pocket: b.pocket,
      ...roll[i],
    }));
  };
  const frames = opts.record ? [snapshot()] : null;

  const events = [];
  let elapsed = 0;
  let step = 0;
  while (elapsed < maxTime) {
    stepWorld(world, dt, events);
    elapsed += dt;
    step++;
    if (frames && step % frameEvery === 0) frames.push(snapshot());
    if (allStopped(world)) break;
  }
  if (frames && step % frameEvery !== 0) {
    frames.push(snapshot());
  }

  // 首碰：事件流里第一条与母球有关的球球接触
  let contactIndex = -1;
  let firstContactId = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type !== 'ball') continue;
    if (e.a === cueId) { firstContactId = e.b; contactIndex = i; break; }
    if (e.b === cueId) { firstContactId = e.a; contactIndex = i; break; }
  }
  const firstBall = firstContactId ? copy.find((b) => b.id === firstContactId) : null;
  const firstContact = firstBall ? firstBall.number : null;

  // 首碰之后有哪些球碰过库（3.3 只看碰球之后）
  const railsAfterContact = [];
  if (contactIndex >= 0) {
    for (let i = contactIndex + 1; i < events.length; i++) {
      const e = events[i];
      if (e.type === 'cushion' && !railsAfterContact.includes(e.ball)) railsAfterContact.push(e.ball);
    }
  }

  // 开球计分用：整杆里被驱向库边的「目标球」（2.7：进袋也算驱向库边）
  const toRail = new Set();
  for (const e of events) {
    if (e.type !== 'cushion') continue;
    const b = copy.find((x) => x.id === e.ball);
    if (b && b.number !== 0) toRail.add(b.number);
  }

  const pocketed = [];
  for (const e of events) {
    if (e.type !== 'pocket') continue;
    const b = copy.find((x) => x.id === e.ball);
    if (b) pocketed.push({ id: b.id, number: b.number, pocket: e.pocket });
  }
  for (const p of pocketed) if (p.number !== 0) toRail.add(p.number);

  return {
    firstContact,
    firstContactId,
    pocketed,
    cueScratched: pocketed.some((p) => p.number === 0),
    railsAfterContact,
    objectBallsToRail: [...toRail].sort((a, b) => a - b),
    onTableBefore,
    onTableAfter: copy.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number),
    settled: allStopped(world),
    elapsed,
    events,
    frames,
    dt,
    ballsAfter: copy.map((b) => ({ ...b })),
  };
}

/**
 * 把一颗球放回 8 号点；被占则沿长边向脚端找空位，再向头端找（WPA 1.5）。
 *
 * 九球也要用同一套回位点，所以单独导出——两个玩法共用一个实现，
 * 避免"黑八的 8 号球怎么摆"和"九球的 9 号球怎么摆"各写一份、迟早不一致。
 */
export function footSpotPosition(table, balls, excludeNumber) {
  const R = table.ballRadius;
  const cx = footSpotX(table);
  const cy = table.width / 2;
  const free = (x, y) =>
    x >= table.bounds.minX && x <= table.bounds.maxX &&
    balls.every((b) => {
      if (b.pocketed || b.number === excludeNumber) return true;
      return Math.hypot(b.x - x, b.y - y) >= 2 * R + 1e-4;
    });

  if (free(cx, cy)) return { x: cx, y: cy };
  const step = R * 0.5;
  for (let i = 1; i <= 400; i++) {
    const x = cx + i * step;
    if (x > table.bounds.maxX) break;
    if (free(x, cy)) return { x, y: cy };
  }
  for (let i = 1; i <= 400; i++) {
    const x = cx - i * step;
    if (x < table.bounds.minX) break;
    if (free(x, cy)) return { x, y: cy };
  }
  return null;
}

/** 把 8 号球重摆回台面。找不到位置时返回 false（台面塞满的极端情况）。 */
export function spotEight(game) {
  const eight = game.balls.find((b) => b.number === 8);
  if (!eight) return false;
  const pos = footSpotPosition(game.table, game.balls, 8);
  if (!pos) return false;
  eight.x = pos.x;
  eight.y = pos.y;
  eight.pocketed = false;
  eight.pocket = undefined;
  eight.vx = eight.vy = eight.wx = eight.wy = eight.wz = 0;
  return true;
}

/**
 * 回合结算：只读 simulateShot 给的事实，判规则、推进状态。
 *
 * 两个玩法分开实现，共用一个入口——九球的状态推进和黑八差得太多
 * （不分组、永远打最小号、进 9 判胜、犯规进 9 回位），
 * 硬塞进同一个函数会让两边的规则都变成 if/else 迷宫。
 *
 * @param {object} game 不会被修改
 * @param {object} facts simulateShot 的返回值
 * @returns {{next:object, report:object}}
 */
export function resolveShot(game, facts) {
  return game.kind === 'nineball' ? resolveNineBall(game, facts) : resolveEightBall(game, facts);
}

function resolveEightBall(game, facts) {
  const next = cloneGame(game);
  const me = next.turn;
  const opp = 1 - me;
  const myName = next.players[me].name;
  const oppName = next.players[opp].name;
  const isBreak = next.breakShot;
  const hasEight = next.balls.some((b) => b.number === 8);

  const fouls = [];
  const notes = [];
  const addFoul = (code) => {
    if (!fouls.includes(code)) fouls.push(code);
  };

  const pocketedObjects = facts.pocketed.filter((p) => p.number !== 0);
  const eightPocketed = pocketedObjects.some((p) => p.number === 8);

  // ---- 开球 ----
  if (isBreak) {
    if (facts.cueScratched) addFoul(FOUL.SCRATCH);
    if (pocketedObjects.length === 0 && facts.objectBallsToRail.length < 4) {
      addFoul(FOUL.ILLEGAL_BREAK);
    }
  } else {
    // ---- 普通一杆 ----
    if (facts.cueScratched) addFoul(FOUL.SCRATCH);
    if (facts.firstContact === null) {
      addFoul(FOUL.NO_CONTACT);
    } else {
      const legal = legalTargetNumbers(next, facts.onTableBefore);
      if (!legal.includes(facts.firstContact)) addFoul(FOUL.WRONG_BALL_FIRST);
    }
    const railOk = facts.railsAfterContact.length > 0 || facts.pocketed.length > 0;
    if (facts.firstContact !== null && !railOk) addFoul(FOUL.NO_RAIL);
  }

  const fouled = fouls.length > 0;

  // ---- 8 号球 ----
  let ended = false;
  let winner = null;
  let spotted = null;

  if (eightPocketed && hasEight) {
    if (isBreak) {
      // 4.3(e)(f)：开球进 8 号不算犯规，重摆回 8 号点；犯规时对手在开球线后持球
      if (spotEight(next)) {
        spotted = 8;
        notes.push('开球进 8 号球：按 4.3(e) 重摆回 8 号点，局面保持。');
      }
      // 8 号球重摆后就不算落袋，也不触发胜负
    } else {
      const myGroup = next.players[me].group;
      const clearedBefore = myGroup
        ? facts.onTableBefore.filter((n) => n !== 8).every((n) => groupOf(n) !== myGroup)
        : false;
      if (clearedBefore && !fouled) {
        ended = true;
        winner = me;
        notes.push(`${myName} 清完本组后合法打进 8 号球，赢下这一局。`);
      } else {
        ended = true;
        winner = opp;
        notes.push(
          clearedBefore
            ? `${myName} 打进 8 号球，但这一杆犯规（WPA 4.8），判负。`
            : `${myName} 本组球还没清完就打进 8 号球（WPA 4.8），判负。`
        );
      }
    }
  }

  // ---- 分组（4.4）----
  let groupAssigned = null;
  if (!isBreak && !fouled && next.open && pocketedObjects.length > 0 && !ended) {
    // 一杆进两组时，按母球先碰到的那颗球的组算（2021 版 IEPF 6a 的明确写法）
    const first = pocketedObjects.find((p) => p.number === facts.firstContact);
    const pick = first ?? pocketedObjects[0];
    const g = groupOf(pick.number);
    if (g === 'solid' || g === 'stripe') {
      next.players[me].group = g;
      next.players[opp].group = g === 'solid' ? 'stripe' : 'solid';
      next.open = false;
      groupAssigned = { player: me, group: g };
      notes.push(`${myName} 打进 ${pick.number} 号球，分到${g === 'solid' ? '全色（1–7）' : '花色（9–15）'}。`);
    }
  }

  // ---- 连续犯规（3.13）----
  // WPA 3.13 原文："Some games such as 8-Ball do not include this rule."
  // 所以黑八**不判负**，只记账；判负的是 9-Ball / 10-Ball 这类按 Rack 计分的。
  // 记着不判是有用的：界面能显示"你已连续两次犯规"，而且换玩法时不用重写计数。
  if (fouled) {
    next.players[me].fouls += 1;
  } else {
    next.players[me].fouls = 0;
  }

  // ---- 续杆判定（4.5）----
  let continuing = false;
  if (!ended && !fouled) {
    if (isBreak) {
      continuing = pocketedObjects.length > 0;
    } else {
      const mine = next.players[me].group;
      if (!mine) {
        continuing = pocketedObjects.length > 0;
      } else {
        continuing = pocketedObjects.some((p) => groupOf(p.number) === mine);
      }
    }
  }

  // ---- 状态推进 ----
  if (!ended) {
    if (fouls.includes(FOUL.ILLEGAL_BREAK)) {
      // 4.3(d)：不合法开球时对手选择重摆。这里实现成「对手重摆并开球」，
      // 不给持球——条文里这一项的选项是重摆，不是 ball in hand。
      next.turn = opp;
      next.requiresRerack = true;
      next.ballInHand = null;
    } else if (fouled) {
      next.turn = opp;
      next.ballInHand = { zone: isBreak ? 'kitchen' : 'anywhere' };
    } else if (!continuing) {
      next.turn = opp;
      next.ballInHand = null;
    } else {
      next.ballInHand = null;
    }
  } else {
    next.phase = 'ended';
    next.winner = winner;
    next.ballInHand = null;
  }

  next.breakShot = false;
  next.shots += 1;

  // 球的位置以物理结果为准（8 号球重摆除外）
  for (const b of next.balls) {
    const after = facts.ballsAfter.find((x) => x.id === b.id);
    if (!after) continue;
    if (b.number === 8 && spotted === 8) continue;
    b.x = after.x;
    b.y = after.y;
    b.pocketed = after.pocketed;
    b.pocket = after.pocket;
    b.vx = b.vy = b.wx = b.wy = b.wz = 0;
  }

  const report = {
    kind: isBreak ? 'break' : 'shot',
    shooter: me,
    fouls: fouls.map((code) => ({ code, text: FOUL_TEXT[code] })),
    fouled,
    // 重摆回去的 8 号球不算"进袋"，否则播报会说「进 8 号」而台上还立着它
    pocketed: pocketedObjects.filter((p) => !(p.number === 8 && spotted === 8)),
    cueScratched: facts.cueScratched,
    firstContact: facts.firstContact,
    railsAfterContact: facts.railsAfterContact,
    objectBallsToRail: facts.objectBallsToRail,
    continuing,
    groupAssigned,
    ballInHand: next.ballInHand ? { player: next.turn, zone: next.ballInHand.zone } : null,
    requiresRerack: next.requiresRerack,
    spotted,
    ended,
    winner,
    notes,
    // 跑满 MAX_SHOT_TIME 还没停稳：物理核放弃了，规则照常结算。
    // 必须显式标出来——不标的话界面会说「这一杆结束了」，而球其实还在动。
    unsettled: facts.settled === false,
    summary: '',
  };
  report.summary = summarizeReport(report, next, myName, oppName);

  next.log.push({ shot: next.shots, shooter: me, summary: report.summary, fouls: report.fouls.map((f) => f.code) });
  return { next, report };
}

/**
 * 九球回合结算。
 *
 * 与黑八共用的部分：犯规代码、开球四球碰库、母球摔袋、无碰库接触、跑满超时标记。
 * 完全不同的部分（这些才是"支持九球"的实质）：
 *   · 不分组：任何一杆都只能先碰台面上号码最小的球（3.2）
 *   · 9 号进袋判胜（5.5），但犯规进的 9 号要回位（5.6）
 *   · 犯规一律全场自由球，包括开球犯规（5.7 + 1.6）
 *   · 三犯判负（3.13 + 5.8），且必须"先提醒再判"
 *   · 另有 Regulation 16 的三球过线：不达标**不是犯规**，接手方有选择权
 */
function resolveNineBall(game, facts) {
  const next = cloneGame(game);
  const me = next.turn;
  const opp = 1 - me;
  const myName = next.players[me].name;
  const oppName = next.players[opp].name;
  const isBreak = next.breakShot;

  const fouls = [];
  const notes = [];
  const addFoul = (code) => {
    if (!fouls.includes(code)) fouls.push(code);
  };

  const pocketedObjects = facts.pocketed.filter((p) => p.number !== 0);
  const ninePocketed = pocketedObjects.some((p) => p.number === 9);

  // ---- 开球：两条门槛，性质不同 ----
  let threeBallFailed = false;
  if (isBreak) {
    if (facts.cueScratched) addFoul(FOUL.SCRATCH);
    if (pocketedObjects.length === 0 && facts.objectBallsToRail.length < 4) {
      // 5.3(b)：不进球且不足四颗目标球碰库 → 犯规
      addFoul(FOUL.ILLEGAL_BREAK);
    }
    // 5.3(c) + Reg.16(1)：至少三颗目标球「进袋或过开球线」，两者可以相加。
    // Reg.16(1) 原文："a minimum of three object-balls must either be pocketed,
    // or cross the Head String line, or a combination of both"——注意这里有
    // "a combination of both"，所以**不能**只在「一颗都没进」时才检查，
    // 也不能只数过线的球。5.3(c) 那句 "if no ball is pocketed" 是 Reg.16(1)
    // 的一个特例，Reg.16 才是可操作的判定口径。
    // 另外「cross the Head String line」被 Reg.16 定义为
    // "the center (or resting point) of the object-ball must go beyond the line"，
    // 所以用停下来的位置判定是符合条文的，不需要逐帧追踪。
    {
      const line = headStringX(next.table);
      const crossed = facts.ballsAfter.filter(
        (b) => b.number !== 0 && !b.pocketed && b.x < line
      ).length;
      const threeBallCount = pocketedObjects.length + crossed;
      if (threeBallCount < 3) {
        threeBallFailed = true;
        notes.push(
          `开球只做到 ${threeBallCount} 颗目标球「进袋或越过开球线」` +
            `（进 ${pocketedObjects.length} 颗、过线 ${crossed} 颗，要求 3 颗）——` +
            '按 Regulation 16 属于「非法开球」，不是犯规；接手方可以选择照打或让原开球方再打一杆。'
        );
      }
    }
  } else {
    // ---- 普通一杆 ----
    if (facts.cueScratched) addFoul(FOUL.SCRATCH);
    if (facts.firstContact === null) {
      addFoul(FOUL.NO_CONTACT);
    } else {
      const legal = legalTargetNumbers(next, facts.onTableBefore);
      if (!legal.includes(facts.firstContact)) addFoul(FOUL.WRONG_BALL_FIRST);
    }
    const railOk = facts.railsAfterContact.length > 0 || facts.pocketed.length > 0;
    if (facts.firstContact !== null && !railOk) addFoul(FOUL.NO_RAIL);
  }

  const fouled = fouls.length > 0;

  // ---- 9 号球 ----
  let ended = false;
  let winner = null;
  let spotted = null;

  if (ninePocketed) {
    if (fouled) {
      // 5.6：犯规进的 9 号要回位，不回位就等于"犯规赢局"，那是错的
      if (spotBall(next, 9)) {
        spotted = 9;
        notes.push('犯规时打进了 9 号球：按 WPA 5.6 把 9 号球摆回底点，局面继续。');
      }
    } else if (threeBallFailed) {
      // Reg.16(5)：三球过线没达标但其余合法且进了 9 号 → 9 号回位，不算赢
      if (spotBall(next, 9)) {
        spotted = 9;
        notes.push('开球没达到三球过线的要求却打进了 9 号球：按 Regulation 16(5) 摆回底点，不算赢局。');
      }
    } else {
      ended = true;
      winner = me;
      notes.push(`${myName} 合法打进 9 号球，赢下这一局（WPA 5.5）。`);
    }
  }

  // ---- 三犯判负（3.13 + 5.8）----
  // "没有中间的合法击球"→ 只要打出一杆合法球就清零；必须同一局内。
  // "裁判未提醒的话第 3 次只按第 2 次算"→ 计数到 2 时置 warned，第 3 次才判。
  if (!ended) {
    if (fouled) {
      next.players[me].fouls += 1;
      if (next.players[me].fouls === 2) {
        next.players[me].warned = true;
        notes.push(`${myName} 已经连续两次犯规——再犯一次就输掉这一局（WPA 3.13）。`);
      }
      if (next.players[me].fouls >= 3 && next.players[me].warned) {
        ended = true;
        winner = opp;
        notes.push(`${myName} 连续三次犯规，判负（WPA 3.13 + 5.8）。`);
      }
    } else {
      next.players[me].fouls = 0;
      next.players[me].warned = false;
    }
  }

  // ---- 续杆 ----
  let continuing = false;
  if (!ended && !fouled) continuing = pocketedObjects.length > 0;

  // ---- 状态推进 ----
  let pendingChoice = null;
  if (!ended) {
    if (fouled) {
      next.turn = opp;
      // 5.7 + 1.6：九球的犯规一律全场自由球，开球犯规也不例外
      next.ballInHand = { zone: 'anywhere' };
    } else {
      // 注意顺序：Reg.16 的"非法开球"不是犯规，所以不能先被下面的分支吃掉。
      if (threeBallFailed) {
        next.turn = opp;
        next.ballInHand = null;
        pendingChoice = { player: opp, kind: ILLEGAL_BREAK_NOTICE, breaker: me };
      } else if (!continuing) {
        next.turn = opp;
        next.ballInHand = null;
      } else {
        next.ballInHand = null;
      }
    }
  } else {
    next.phase = 'ended';
    next.winner = winner;
    next.ballInHand = null;
  }
  next.pendingChoice = pendingChoice;

  next.breakShot = false;
  next.shots += 1;

  for (const b of next.balls) {
    const after = facts.ballsAfter.find((x) => x.id === b.id);
    if (!after) continue;
    if (spotted !== null && b.number === spotted) continue;
    b.x = after.x;
    b.y = after.y;
    b.pocketed = after.pocketed;
    b.pocket = after.pocket;
    b.vx = b.vy = b.wx = b.wy = b.wz = 0;
  }

  const report = {
    kind: isBreak ? 'break' : 'shot',
    shooter: me,
    fouls: fouls.map((code) => ({ code, text: FOUL_TEXT[code] })),
    fouled,
    pocketed: pocketedObjects.filter((p) => !(spotted !== null && p.number === spotted)),
    cueScratched: facts.cueScratched,
    firstContact: facts.firstContact,
    railsAfterContact: facts.railsAfterContact,
    objectBallsToRail: facts.objectBallsToRail,
    continuing,
    groupAssigned: null,
    ballInHand: next.ballInHand ? { player: next.turn, zone: next.ballInHand.zone } : null,
    requiresRerack: next.requiresRerack,
    spotted,
    pendingChoice,
    ended,
    winner,
    notes,
    unsettled: facts.settled === false,
    summary: '',
  };
  report.summary = summarizeReport(report, next, myName, oppName);

  next.log.push({ shot: next.shots, shooter: me, summary: report.summary, fouls: report.fouls.map((f) => f.code) });
  return { next, report };
}

/** 把指定号码的球摆回底点（九球只摆 9 号）。 */
function spotBall(game, number) {
  const ball = game.balls.find((b) => b.number === number);
  if (!ball) return false;
  const pos = footSpotPosition(game.table, game.balls, number);
  if (!pos) return false;
  ball.x = pos.x;
  ball.y = pos.y;
  ball.pocketed = false;
  ball.pocket = undefined;
  ball.vx = ball.vy = ball.wx = ball.wy = ball.wz = 0;
  return true;
}

/**
 * Regulation 16(2) 的两个选择。
 *
 * 原文给接手方两个选项：「accept the tables as is」或「hand the shot back to his opponent」。
 * 本模拟没有裁判也没有交互延迟，默认走"照打"（accept），
 * 需要让原开球方再打一杆时调用 handBackBreak。
 */
export function acceptTable(game) {
  game.pendingChoice = null;
  return game;
}

/** 把开球权交回原开球方（Reg.16(4)：此时他可以打 push-out，本项目不实现 push-out）。 */
export function handBackBreak(game) {
  const c = game.pendingChoice;
  if (!c || c.kind !== ILLEGAL_BREAK_NOTICE) return game;
  game.turn = c.breaker;
  game.ballInHand = null;
  game.pendingChoice = null;
  game.log.push({
    shot: game.shots,
    shooter: c.player,
    summary: `接手方选择把这一杆交回给原开球方再打一杆（WPA Regulation 16(4)）。`,
    fouls: [],
  });
  return game;
}

function summarizeReport(report, game, myName, oppName) {
  if (report.ended) {
    return `${myName} 与 ${oppName} 的这一局结束：${game.players[report.winner]?.name ?? '—'} 获胜。`;
  }
  const parts = [];
  if (report.kind === 'break') parts.push('开球');
  if (report.pocketed.length) parts.push(`进 ${report.pocketed.map((p) => p.number).join('、')} 号`);
  else parts.push('没有球进袋');
  if (report.fouls.length) parts.push(`犯规：${report.fouls.map((f) => f.text).join('；')}`);
  if (report.pendingChoice) parts.push('开球不达标，接手方可以选择照打或交回');
  parts.push(report.continuing ? `${myName} 继续` : `换 ${oppName}`);
  if (report.unsettled) parts.push('（这一杆没在限时内停稳，结果是按超时那一刻的球位算的）');
  return parts.join(' · ');
}

/**
 * 重新摆球开球（黑八 4.3(d) / 九球 Regulation 16 的第二个选项：由对手重新摆球并开球）。
 * @param {object} game 会被修改
 * @param {object[]} rackedBalls 新的一副球
 */
export function rerack(game, rackedBalls) {
  game.balls = rackedBalls.map((b) => ({ ...b }));
  game.turn = 1 - game.turn;
  game.players = game.players.map((p) => ({ ...p, group: null, fouls: 0, warned: false }));
  game.breakShot = true;
  game.open = true;
  game.ballInHand = null;
  game.requiresRerack = false;
  game.pendingChoice = null;
  game.phase = 'playing';
  game.winner = null;
  return game;
}

/** 犯规后的持球摆位是否合法。 */
export function placementAllowed(game, x, y) {
  if (!game.ballInHand) return true;
  if (!game.table.insideBounds(x, y)) return false;
  if (game.ballInHand.zone === 'kitchen') return x <= headStringX(game.table) + 1e-9;
  return true;
}

/** 把一个球放到指定位置，并清掉与其它球的重叠（持球摆位用）。 */
export function placeCueBall(game, x, y) {
  const cue = game.balls.find((b) => b.number === 0 || b.id === 'cue');
  if (!cue) return false;
  const R = game.table.ballRadius;
  // findFreeSpot 会螺旋外扩，必须把持球区域约束一起传进去，
  // 否则开球线后持球时可能被推到线那边——那是不合法的摆位，不是"稍微偏一点"。
  const spot = findFreeSpot(game.table, game.balls.filter((b) => b !== cue), R, { x, y }, (px, py) =>
    placementAllowed(game, px, py)
  );
  if (!spot) return false;
  cue.x = spot.x;
  cue.y = spot.y;
  cue.pocketed = false;
  cue.pocket = undefined;
  cue.vx = cue.vy = cue.wx = cue.wy = cue.wz = 0;
  return true;
}
