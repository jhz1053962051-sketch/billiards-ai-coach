// 斯诺克规则：计分、按序击球、彩球回位。
//
// 依据 WPBSA《Official Rules of the Games of Snooker and English Billiards》
// （2019 版）第 3 节（The Game）与第 4 节（Scoring）：
//   · 台上有红球时，先打一颗红球（1 分），进袋后可以打任意一颗彩球（2–7 分），
//     彩球进袋后回位，然后又是红球——如此交替。
//   · 红球全部打完后，按分值从小到大打彩球：黄 2、绿 3、咖啡 4、蓝 5、粉 6、黑 7。
//     这一阶段彩球进袋不回位。
//   · 犯规罚分 = max(4, 该打的球的分值, 实际打到/打进的球的分值)，罚给对手。
//
// 这个文件不 import rules.js，只 import rack.js（找空位用）。rules.js 反过来
// import 本文件——单向依赖，不会形成循环。
//
// 已知简化（都在对应位置写了原因）：
//   · 不实现「提名彩球」：打到哪颗彩球就按那颗算。真实比赛里必须口头/手势提名，
//     这是个交互话题，不是物理话题。
//   · 不实现自由球（free ball）与「做斯诺克后失败」的判定。
//   · 不实现「miss rule」（未尽力击球的重摆）。这条依赖裁判主观判断。

import { findFreeSpot } from './rack.js';
import { SNOOKER_SPOTS } from './constants.js';

/** 红球号码：1–15。 */
export const RED_MIN = 1;
export const RED_MAX = 15;

/** 彩球号码。跟着红球往后排，避免和黑八的 1–15 混在一起。 */
export const YELLOW = 16;
export const GREEN = 17;
export const BROWN = 18;
export const BLUE = 19;
export const PINK = 20;
export const BLACK = 21;

/** 彩球按分值从小到大。 */
export const COLOR_ORDER = Object.freeze([YELLOW, GREEN, BROWN, BLUE, PINK, BLACK]);

/** 分值：红球 1，彩球 2–7。 */
export function valueOf(number) {
  if (number >= RED_MIN && number <= RED_MAX) return 1;
  const i = COLOR_ORDER.indexOf(number);
  return i < 0 ? 0 : i + 2;
}

export function isRed(number) {
  return number >= RED_MIN && number <= RED_MAX;
}

export function isColor(number) {
  return COLOR_ORDER.includes(number);
}

/** 中文名：红球说「红球」，彩球说颜色。播报和教练卡都用它。 */
export function ballName(number) {
  if (number === 0) return '母球';
  if (isRed(number)) return '红球';
  const names = { [YELLOW]: '黄球', [GREEN]: '绿球', [BROWN]: '咖啡球', [BLUE]: '蓝球', [PINK]: '粉球', [BLACK]: '黑球' };
  return names[number] ?? `${number} 号球`;
}

/**
 * 台面上的固定点位。
 *
 * 12 尺台的标准值（WPBSA 器材规格，净台面 3569 × 1778 mm）：
 *   · 开球线（baulk line）距开球端库面 737 mm
 *   · 半圆区（the D）半径 292 mm，圆心在开球线中点
 *   · 黄/绿球在 D 与开球线的两个交点上，咖啡球在开球线中点
 *   · 蓝球在台面正中，粉球在蓝球与顶库的中点，黑球距顶库 324 mm
 */
export function snookerSpots(table) {
  const L = table.length;
  const W = table.width;
  const baulkX = SNOOKER_SPOTS.baulkX;
  const dRadius = SNOOKER_SPOTS.dRadius;
  return {
    baulkX,
    dRadius,
    brown: { x: baulkX, y: W / 2 },
    // 从开球端看向远端（x 增大方向），右手边在 -y 一侧，所以黄球在 y 较小的一侧。
    yellow: { x: baulkX, y: W / 2 - dRadius },
    green: { x: baulkX, y: W / 2 + dRadius },
    blue: { x: L / 2, y: W / 2 },
    pink: { x: (L / 2 + L) / 2, y: W / 2 },
    black: { x: L - SNOOKER_SPOTS.blackFromTop, y: W / 2 },
  };
}

/** 某颗彩球该回的位。红球没有点位，返回 null。 */
export function spotFor(table, number) {
  const s = snookerSpots(table);
  switch (number) {
    case YELLOW: return s.yellow;
    case GREEN: return s.green;
    case BROWN: return s.brown;
    case BLUE: return s.blue;
    case PINK: return s.pink;
    case BLACK: return s.black;
    default: return null;
  }
}

/** 建局时的斯诺克状态。 */
export function initialSnooker(reds = 15) {
  return { scores: [0, 0], ballOn: 'red', reds };
}

/**
 * 这一杆允许先碰的球号。
 *
 * ballOn 有三种取值：
 *   'red'   —— 台上有红球、且轮到打红球
 *   'color' —— 刚打进红球，可以打任意彩球
 *   数字     —— 彩球阶段，只能打特定那颗
 */
export function snookerTargets(game, onTable) {
  const st = game.snooker;
  if (!st) return onTable.slice();
  if (st.ballOn === 'red') return onTable.filter(isRed);
  if (st.ballOn === 'color') return onTable.filter(isColor);
  return onTable.includes(st.ballOn) ? [st.ballOn] : [];
}

/** 犯规的显示文案。这里自带一份，是为了不 import rules.js（避免循环依赖）。 */
const FOUL_TEXT = {
  scratch: '母球落袋',
  no_contact: '母球没有碰到任何球',
  wrong_ball_first: '母球先碰到的不是该打的球',
  no_rail: '碰球之后没有球碰库、也没有球进袋',
  wrong_ball_potted: '打进了不该进的球',
};

/**
 * 结算一杆斯诺克。
 *
 * @param {object} game
 * @param {object} facts rules.simulateShot 的输出
 * @returns {{next:object, report:object}}
 */
export function resolveSnooker(game, facts) {
  const next = {
    ...game,
    balls: game.balls.map((b) => ({ ...b })),
    players: game.players.map((p) => ({ ...p })),
    log: game.log.slice(),
    snooker: {
      ...game.snooker,
      scores: game.snooker.scores.slice(),
    },
  };
  const st = next.snooker;
  const me = next.turn;
  const opp = 1 - me;
  const myName = next.players[me].name;
  const oppName = next.players[opp].name;
  const ballOn = st.ballOn;

  const fouls = [];
  const notes = [];
  const addFoul = (code) => {
    if (!fouls.includes(code)) fouls.push(code);
  };

  const potted = facts.pocketed.filter((p) => p.number !== 0);
  const pottedReds = potted.filter((p) => isRed(p.number));
  const pottedColors = potted.filter((p) => isColor(p.number));

  // ---- 先碰到的球 ----
  if (facts.cueScratched) addFoul('scratch');
  if (facts.firstContact === null) {
    addFoul('no_contact');
  } else {
    const ok =
      ballOn === 'red'
        ? isRed(facts.firstContact)
        : ballOn === 'color'
          ? isColor(facts.firstContact)
          : facts.firstContact === ballOn;
    if (!ok) addFoul('wrong_ball_first');
  }
  const railOk = facts.railsAfterContact.length > 0 || facts.pocketed.length > 0;
  if (facts.firstContact !== null && !railOk) addFoul('no_rail');

  // ---- 打进了不该打的球 ----
  if (ballOn === 'red') {
    if (pottedColors.length) addFoul('wrong_ball_potted');
  } else if (ballOn === 'color') {
    if (pottedReds.length) addFoul('wrong_ball_potted');
    if (pottedColors.length > 1) addFoul('wrong_ball_potted');
  } else if (potted.some((p) => p.number !== ballOn)) {
    addFoul('wrong_ball_potted');
  }

  const fouled = fouls.length > 0;

  // ---- 罚分 ----
  // 规则是「该打的球的分值」和「实际打到/打进的球的分值」取大，再和 4 比。
  // 不提名彩球，所以「该打的分值」在 ballOn === 'color' 时取实际那颗的值。
  let penalty = 0;
  if (fouled) {
    const candidates = [4];
    if (ballOn === 'red') candidates.push(1);
    else if (typeof ballOn === 'number') candidates.push(valueOf(ballOn));
    for (const p of potted) candidates.push(valueOf(p.number));
    if (facts.firstContact !== null) candidates.push(valueOf(facts.firstContact));
    penalty = Math.max(...candidates);
  }

  // ---- 计分 ----
  let continuing = false;
  let gained = 0;
  if (fouled) {
    st.scores[opp] += penalty;
    next.players[me].fouls += 1;
    notes.push(`${myName} 犯规，罚 ${penalty} 分给 ${oppName}。`);
  } else {
    next.players[me].fouls = 0;
    gained = potted.reduce((sum, p) => sum + valueOf(p.number), 0);
    st.scores[me] += gained;
    continuing = potted.length > 0;
    if (gained > 0) notes.push(`${myName} 得 ${gained} 分。`);
  }

  // ---- 球位以物理结果为准 ----
  for (const b of next.balls) {
    const after = facts.ballsAfter.find((x) => x.id === b.id);
    if (!after) continue;
    b.x = after.x;
    b.y = after.y;
    b.pocketed = after.pocketed;
    b.pocket = after.pocket;
    b.vx = b.vy = b.wx = b.wy = b.wz = 0;
  }

  // ---- 彩球回位 ----
  // 台上有红球时，彩球进袋一律回位；彩球阶段合法打进的不回位。
  // 犯规打进的彩球，两个阶段都要回位。
  const redsLeft = next.balls.filter((b) => isRed(b.number) && !b.pocketed).length;
  const respotted = [];
  for (const p of pottedColors) {
    if (!(redsLeft > 0 || fouled)) continue;
    const ball = next.balls.find((b) => b.id === p.id);
    if (!ball) continue;
    const spot = spotFor(next.table, ball.number);
    if (!spot) continue;
    const R = next.table.ballRadius;
    const occupied = (x, y) =>
      next.balls.some(
        (o) => o !== ball && !o.pocketed && Math.hypot(o.x - x, o.y - y) < 2 * R - 1e-9
      );
    let pos = { ...spot };
    if (occupied(pos.x, pos.y)) {
      // 点位被占：按规则找最高分值的空点，这里退化成最近空位（简化，见文件头）。
      const free = findFreeSpot(next.table, next.balls.filter((o) => o !== ball), R, spot);
      if (free) pos = free;
    }
    ball.pocketed = false;
    ball.pocket = undefined;
    ball.x = pos.x;
    ball.y = pos.y;
    respotted.push(ball.number);
    notes.push(`${ballName(ball.number)}回位。`);
  }

  // ---- 下一杆该打什么 ----
  const colorsLeft = COLOR_ORDER.filter((n) =>
    next.balls.some((b) => b.number === n && !b.pocketed)
  );
  let ballOnNext;
  if (continuing && pottedReds.length > 0) {
    // 刚打进红球（包括最后一颗红球）：接着可以打任意一颗彩球。
    // 这一步不能因为「红球已经没了」就直接跳到黄球——规则里最后一颗红球之后
    // 仍然是一次自由选彩球的机会，之后才按分值顺序走。
    ballOnNext = 'color';
  } else if (redsLeft > 0) {
    ballOnNext = 'red';
  } else {
    ballOnNext = colorsLeft.length ? colorsLeft[0] : null;
  }

  // ---- 结束判定 ----
  let ended = false;
  let winner = null;
  // 平分重摆黑球：这一杆本来是「继续」的，但重摆之后由对手先打。
  let respotTie = false;
  const onlyBlackBefore =
    facts.onTableBefore.every((n) => n === BLACK) && facts.onTableBefore.includes(BLACK);
  if (fouled && redsLeft === 0 && onlyBlackBefore) {
    // 只剩黑球时犯规，这一局就直接结束，对手赢（4.1 的最后一段）。
    ended = true;
    winner = opp;
    notes.push('只剩黑球时犯规，这一局结束。');
  } else if (redsLeft === 0 && colorsLeft.length === 0) {
    ended = true;
    if (st.scores[0] === st.scores[1]) {
      // 平分：黑球重摆，由对手从 D 内开球（规则原文是重摆黑球继续）。
      const black = next.balls.find((b) => b.number === BLACK);
      if (black) {
        const spot = spotFor(next.table, BLACK);
        black.pocketed = false;
        black.pocket = undefined;
        black.x = spot.x;
        black.y = spot.y;
      }
      ended = false;
      winner = null;
      ballOnNext = BLACK;
      respotTie = true;
      notes.push('比分相同：黑球重摆，继续打。');
    } else {
      winner = st.scores[0] > st.scores[1] ? 0 : 1;
    }
  }

  // ---- 状态推进 ----
  if (!ended) {
    if (fouled || !continuing) next.turn = opp;
    next.ballInHand = fouled && fouls.includes('scratch') ? { zone: 'd' } : null;
    next.phase = 'playing';
    next.winner = null;
  } else {
    next.phase = 'ended';
    next.winner = winner;
    next.ballInHand = null;
  }
  if (respotTie) next.turn = opp;
  st.ballOn = ballOnNext;
  next.breakShot = false;
  next.shots += 1;

  const parts = [];
  if (fouled) parts.push(`犯规：${fouls.map((c) => FOUL_TEXT[c]).join('；')}，罚 ${penalty} 分`);
  else if (gained > 0) parts.push(`得 ${gained} 分`);
  else parts.push('没有球进袋');
  if (respotted.length) parts.push(`回位：${respotted.map(ballName).join('、')}`);
  parts.push(`${st.scores[0]} : ${st.scores[1]}`);
  if (!ended) {
    parts.push(ballOnNext === 'red' ? '该打红球' : ballOnNext === 'color' ? '该打彩球' : `该打${ballName(ballOnNext)}`);
    parts.push(continuing ? `${myName} 继续` : `换 ${oppName}`);
  }
  const summary = ended
    ? `${myName} 与 ${oppName} 的这一局结束：${next.players[winner]?.name ?? '—'} 获胜（${st.scores[0]} : ${st.scores[1]}）。`
    : parts.join(' · ');

  const report = {
    kind: next.shots === 1 ? 'break' : 'shot',
    shooter: me,
    fouls: fouls.map((code) => ({ code, text: FOUL_TEXT[code] })),
    fouled,
    pocketed: potted.filter((p) => !respotted.includes(p.number)),
    cueScratched: facts.cueScratched,
    firstContact: facts.firstContact,
    railsAfterContact: facts.railsAfterContact,
    objectBallsToRail: facts.objectBallsToRail,
    continuing,
    ballInHand: next.ballInHand ? { player: next.turn, zone: next.ballInHand.zone } : null,
    requiresRerack: false,
    spotted: null,
    ended,
    winner,
    notes,
    unsettled: facts.settled === false,
    // 斯诺克专属：界面上要显示比分和「该打什么」，不能只显示分组。
    snooker: {
      gained,
      penalty,
      scores: st.scores.slice(),
      ballOn: ballOnNext,
      respotted: respotted.slice(),
    },
    summary,
  };
  if (report.unsettled) report.summary += '（这一杆没在限时内停稳，结果是按超时那一刻的球位算的）';

  next.log.push({
    shot: next.shots,
    shooter: me,
    summary,
    fouls: report.fouls.map((f) => f.code),
  });
  return { next, report };
}