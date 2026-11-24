// demo/state.js 的单元测试。
//
// 这一层是从 demo/app.js 里搬出来的「不碰 DOM」的状态逻辑。它以前只有浏览器
// 端到端测试兜着（跑一次要起 Chrome、一分多钟），任何一处判断写错都得靠肉眼
// 在页面上看出来。搬过来之后，同一个判断在这里几毫秒就能验一遍。
//
// 断言尽量落在真实业务结果上：「力度百分比到 30 就该从轻力跳中力」「撤销栈满了
// 丢最旧的那一步且存的是深拷贝」「存档里的回合装回去之后不能变回开局」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { cloneGame, createGame, numbersOnTable, legalTargetNumbers } from '../src/rules.js';
import { createRack } from '../src/rack.js';

import {
  AIM_NOTE_MIN_DEG,
  DEFAULT_TABLE_BY_KIND,
  HISTORY_LIMIT,
  NEXT_SHOT_SLOW_MS,
  autoPauseHint,
  buildMatchSummary,
  buildShareSummary,
  buildTableSummary,
  captureBallFrame,
  clamp,
  computeMatchStats,
  copyBallsForShot,
  currentAim,
  describeManualShot,
  describeNextShot,
  esc,
  findSpot,
  gameKindOrThrow,
  getAimHUDInfo,
  getPowerTier,
  packHistory,
  practiceHint,
  practiceReady,
  pushHistoryEntry,
  reduceAutoPause,
  reduceSaveWrite,
  reportHtml,
  restoreGameState,
  restorePositions,
  saveCoord,
  shouldAutoShoot,
  simulateFrames,
  snapshotPositions,
  summarizeHistory,
  tableForKind,
  undoLabel,
  unpackHistory,
  utf8Bytes,
} from '../demo/state.js';
import { SEARCH_DT } from '../src/constants.js';
import {
  appendMatch,
  clearMatches,
  loadSave,
  readMatches,
  readSave,
  readSaveMeta,
  readSaveStamp,
  sanitize,
  saveFailureKind,
  serialize,
  writeSave,
  MATCH_KEY,
  MATCH_LIMIT,
  SAVE_KEY,
  SAVE_VERSION,
} from '../demo/save.js';

const table = createTable('pool9');

/** 造一组带运动学字段的球：母球 + 指定号码的目标球。 */
function makeBalls(numbers, cueAt = { x: table.length * 0.25, y: table.width / 2 }) {
  const cue = createBall('cue', cueAt.x, cueAt.y, { number: 0 });
  return [cue, ...numbers.map((n, i) =>
    createBall('b' + n, table.length * 0.55 + (i % 5) * 0.3, table.width * 0.35 + Math.floor(i / 5) * 0.3, {
      number: n,
    })
  )];
}

// ---------------------------------------------------------------- clamp

test('clamp：区间内原样返回，越界夹到边界', () => {
  assert.equal(clamp(3, 0, 10), 3);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(11, 0, 10), 10);
  // 等于边界时不该被推走
  assert.equal(clamp(0, 0, 10), 0);
  assert.equal(clamp(10, 0, 10), 10);
});

// ---------------------------------------------------------------- 力度档位

test('getPowerTier：0.55 m/s 是轻力的起点（0%）', () => {
  const tier = getPowerTier(0.55);
  assert.equal(tier.level, '轻力');
  assert.equal(tier.sub, '细腻走位');
  assert.equal(tier.pct, 0);
  assert.equal(tier.ratio, 0);
  assert.equal(tier.color, '#10b981');
});

test('getPowerTier：百分比到 30 / 60 / 85 各自换档，不早也不晚', () => {
  // 区间是 0.55 ~ 6.60，跨度 6.05。
  const at = (ratio) => 0.55 + ratio * 6.05;

  assert.equal(getPowerTier(at(0.29)).level, '轻力');
  assert.equal(getPowerTier(at(0.29)).pct, 29);
  assert.equal(getPowerTier(at(0.3)).level, '中力');
  assert.equal(getPowerTier(at(0.3)).pct, 30);

  assert.equal(getPowerTier(at(0.59)).level, '中力');
  assert.equal(getPowerTier(at(0.59)).pct, 59);
  assert.equal(getPowerTier(at(0.6)).level, '发力');
  assert.equal(getPowerTier(at(0.6)).pct, 60);

  assert.equal(getPowerTier(at(0.84)).level, '发力');
  assert.equal(getPowerTier(at(0.84)).pct, 84);
  assert.equal(getPowerTier(at(0.85)).level, '爆杆');
  assert.equal(getPowerTier(at(0.85)).pct, 85);
});

test('getPowerTier：超出滑块范围的力度按 0.55 / 6.6 计算', () => {
  const low = getPowerTier(-5);
  assert.equal(low.level, '轻力');
  assert.equal(low.pct, 0);

  const high = getPowerTier(99);
  assert.equal(high.level, '爆杆');
  assert.equal(high.pct, 100);
  assert.equal(high.sub, '强力冲球');
  // 满档时 ratio 必须是 1，UI 拿它算出的杆头偏移才不会越界
  assert.equal(high.ratio, 1);
});

test('getPowerTier：四档都带齐 UI 需要的字段', () => {
  for (const speed of [0.55, 2.365, 4.18, 5.6925]) {
    const tier = getPowerTier(speed);
    for (const key of ['level', 'sub', 'pct', 'ratio', 'color', 'badgeBg', 'glow']) {
      assert.ok(tier[key] !== undefined, `${speed} 缺字段 ${key}`);
    }
    assert.match(tier.color, /^#[0-9a-f]{6}$/);
  }
});

// ---------------------------------------------------------------- 打杆前的复制与还原

test('copyBallsForShot：复制且清空速度，原球一个字段都不动', () => {
  const balls = makeBalls([3, 11]);
  balls[0].vx = 1.5;
  balls[0].vy = -0.5;
  balls[0].wx = 2;
  balls[0].wy = 3;
  balls[0].wz = 4;

  const copy = copyBallsForShot(balls);
  assert.equal(copy.length, balls.length);
  assert.notEqual(copy[0], balls[0], '必须是新对象，物理核会就地改它');

  for (const b of copy) {
    assert.equal(b.vx, 0);
    assert.equal(b.vy, 0);
    assert.equal(b.wx, 0);
    assert.equal(b.wy, 0);
    assert.equal(b.wz, 0);
  }
  // 原对象的速度不能被清掉：那一杆还没打
  assert.equal(balls[0].vx, 1.5);
  assert.equal(balls[0].wz, 4);
  // 位置和号码照抄
  assert.equal(copy[1].x, balls[1].x);
  assert.equal(copy[1].number, balls[1].number);
});

test('copyBallsForShot：空台面返回空数组', () => {
  assert.deepEqual(copyBallsForShot([]), []);
});

test('snapshotPositions：只存 x/y/落袋两个字段，不存速度', () => {
  const balls = makeBalls([3]);
  balls[1].vx = 3.2;
  const snap = snapshotPositions(balls);

  assert.equal(snap.length, 2);
  for (const s of snap) {
    assert.deepEqual(Object.keys(s).sort(), ['pocket', 'pocketed', 'x', 'y']);
  }
  assert.equal(snap[1].x, balls[1].x);
});

test('restorePositions：就地写回，球数组本身不换', () => {
  const balls = makeBalls([3, 11]);
  const snap = snapshotPositions(balls);

  const ref = balls;
  balls[1].x += 1;
  balls[1].y += 1;
  balls[1].pocketed = true;
  balls[1].pocket = 'top-left';

  restorePositions(balls, snap);
  assert.equal(balls, ref, '必须是就地改，调用方持有的是同一个数组');
  assert.equal(balls[1].x, snap[1].x);
  assert.equal(balls[1].y, snap[1].y);
  assert.equal(balls[1].pocketed, false);
  // 这颗球本来没落过袋，createBall 也就不给 pocket 字段：还原之后它该回到「没有」，而不是 null
  assert.equal(balls[1].pocket, undefined);
});

test('restorePositions：快照比球少时直接抛（局面已被换掉是编程错误）', () => {
  const balls = makeBalls([3, 11]);
  const snap = snapshotPositions(balls).slice(0, 1);
  assert.throws(() => restorePositions(balls, snap), TypeError);
});

test('captureBallFrame：把 trackRoll 每颗球的滚动量并进这一帧', () => {
  const balls = makeBalls([3]);
  const roll = [{ rollX: 0.1, rollY: 0.2 }, { rollX: 0.3, rollY: 0.4 }];
  const frame = captureBallFrame(balls, () => roll);

  assert.equal(frame.length, 2);
  assert.equal(frame[0].x, balls[0].x);
  assert.equal(frame[0].rollX, 0.1);
  assert.equal(frame[1].rollY, 0.4);
  // 落袋信息要跟着进帧，回放才不会把已落袋的球画回台上
  assert.equal(frame[0].pocketed, false);
  assert.equal(frame[0].pocket, undefined, '没落袋的球本来就没有 pocket 字段');
});

test('captureBallFrame：每帧都重新问一次 trackRoll（它自己有内部状态）', () => {
  const balls = makeBalls([]);
  let calls = 0;
  const track = () => {
    calls += 1;
    return [{ rollX: calls, rollY: 0 }];
  };
  const a = captureBallFrame(balls, track);
  const b = captureBallFrame(balls, track);
  assert.equal(calls, 2);
  assert.equal(a[0].rollX, 1);
  assert.equal(b[0].rollX, 2);
});

// ---------------------------------------------------------------- 手打结果播报

test('describeManualShot：只报目标球号码，母球单列', () => {
  const balls = makeBalls([3, 11]);
  balls[1].pocketed = true;
  balls[1].pocket = 'top-left';

  const out = describeManualShot(balls);
  assert.deepEqual(out.pocketed, [3]);
  assert.equal(out.cuePocketed, false);
  assert.deepEqual(out.detail, ['进 3 号']);
});

test('describeManualShot：进了两颗就按台面顺序列出来', () => {
  const balls = makeBalls([3, 11]);
  for (const b of balls) {
    if (b.number !== 0) {
      b.pocketed = true;
      b.pocket = 'bottom-right';
    }
  }
  const out = describeManualShot(balls);
  assert.deepEqual(out.pocketed, [3, 11]);
  assert.deepEqual(out.detail, ['进 3、11 号']);
});

test('describeManualShot：母球摔袋时号码列表里不能算它', () => {
  const balls = makeBalls([3]);
  balls[0].pocketed = true;
  balls[0].pocket = 'middle-left';

  const out = describeManualShot(balls);
  assert.deepEqual(out.pocketed, []);
  assert.equal(out.cuePocketed, true);
  assert.deepEqual(out.detail, ['母球落袋']);
});

test('describeManualShot：球和母球一起进，两条都要说', () => {
  const balls = makeBalls([3]);
  balls[0].pocketed = true;
  balls[0].pocket = 'middle-left';
  balls[1].pocketed = true;
  balls[1].pocket = 'top-right';

  assert.deepEqual(describeManualShot(balls).detail, ['进 3 号', '母球落袋']);
});

test('describeManualShot：一颗没进时明确说「没有球进袋」', () => {
  const balls = makeBalls([3, 11]);
  const out = describeManualShot(balls);
  assert.deepEqual(out.pocketed, []);
  assert.equal(out.cuePocketed, false);
  assert.deepEqual(out.detail, ['没有球进袋']);
});

// ---------------------------------------------------------------- 撤销栈

/** 造一个够用的局面对象，只需要 cloneGame 认识的字段。 */
function makeGame(shots = 0) {
  const g = createGame(table, makeBalls([3, 11]), { names: ['你', '对手'] });
  g.shots = shots;
  return g;
}

test('pushHistoryEntry：存的是深拷贝，之后的改动不会污染快照', () => {
  const history = [];
  const game = makeGame(1);
  const same = pushHistoryEntry(history, game);

  assert.equal(same, history, '返回同一个数组，调用方不用重新接引用');
  assert.equal(history.length, 1);
  assert.notEqual(history[0], game);
  assert.notEqual(history[0].balls[0], game.balls[0], '球也必须是副本');

  game.balls[0].x += 1;
  game.turn = 1;
  assert.notEqual(history[0].balls[0].x, game.balls[0].x);
  assert.equal(history[0].turn, 0);
});

test('pushHistoryEntry：超过上限丢最旧的一步', () => {
  const history = [];
  for (let i = 0; i < HISTORY_LIMIT + 3; i++) pushHistoryEntry(history, makeGame(i));

  assert.equal(history.length, HISTORY_LIMIT);
  // 丢的是最前面三步，所以第一步应该是 shots = 3
  assert.equal(history[0].shots, 3);
  assert.equal(history[history.length - 1].shots, HISTORY_LIMIT + 2);
});

test('pushHistoryEntry：上限可以按参数改，边界是「等于上限不丢」', () => {
  const history = [];
  for (let i = 0; i < 3; i++) pushHistoryEntry(history, makeGame(i), 3);
  assert.equal(history.length, 3);
  assert.equal(history[0].shots, 0, '正好满 3 步时不该丢');

  pushHistoryEntry(history, makeGame(3), 3);
  assert.equal(history.length, 3);
  assert.equal(history[0].shots, 1);
});

test('undoLabel：0 步说人话，有步数时报步数', () => {
  assert.equal(undoLabel(0), '撤销上一杆');
  assert.equal(undoLabel(1), '撤销上一杆（1）');
  assert.equal(undoLabel(HISTORY_LIMIT), `撤销上一杆（${HISTORY_LIMIT}）`);
});

// ---------------------------------------------------------------- 练习面板

test('practiceHint：不在练习模式时不说话', () => {
  assert.equal(practiceHint({ mode: 'game', solution: null }), '');
  assert.equal(practiceHint({ mode: 'setup' }), '');
});

test('practiceHint：练习模式但还没解，先让人去求解', () => {
  assert.equal(
    practiceHint({ mode: 'practice', solution: null, practiceRecorded: false }),
    '先求解一个目标袋方案，再记录真实练习结果。'
  );
  // 有解但没算出袋口，同样算「还没解」
  assert.equal(
    practiceHint({ mode: 'practice', solution: { found: true, best: {} }, practiceRecorded: false }),
    '先求解一个目标袋方案，再记录真实练习结果。'
  );
});

test('practiceHint：记完一杆之后换成「可以接着记」', () => {
  const solved = { found: true, best: { pocketId: 'top-left' } };
  // 文案必须和按钮上的字一模一样：面板写「进了 / 没进」而按钮叫「实战打进 /
  // 实战没进」时，用户会去找两个不存在的按钮（真机走查报的）。
  assert.equal(
    practiceHint({ mode: 'practice', solution: solved, practiceRecorded: false }),
    '按实际结果点「实战打进」或「实战没进」——记下来才看得出进步。'
  );
  assert.equal(
    practiceHint({ mode: 'practice', solution: solved, practiceRecorded: true }),
    '这一杆记下了。同一个球位可以接着记，换球位就再求解一次。'
  );
});

test('practiceReady：要练到位必须有解、有袋口、且在练习模式', () => {
  const solved = { found: true, best: { pocketId: 'top-left' } };
  assert.equal(practiceReady({ mode: 'practice', solution: solved }), true);
  assert.equal(practiceReady({ mode: 'game', solution: solved }), false);
  assert.equal(practiceReady({ mode: 'practice', solution: null }), false);
  assert.equal(practiceReady({ mode: 'practice', solution: { found: false, best: { pocketId: 'x' } } }), false);
  assert.equal(practiceReady({ mode: 'practice', solution: { found: true, best: null } }), false);
});

// ---------------------------------------------------------------- 瞄准

test('currentAim：没有母球就没有方向', () => {
  const balls = makeBalls([3]);
  balls[0].pocketed = true;
  assert.equal(currentAim({ mode: 'practice', balls, solution: null }), null);
});

test('currentAim：有解时直接用解的瞄准角', () => {
  const balls = makeBalls([3, 11]);
  const aim = currentAim({
    mode: 'practice',
    balls,
    solution: { found: true, best: { aimAngle: 1.234, targetId: 'b3', pocketId: 'top-left' } },
  });
  assert.deepEqual(aim, { angle: 1.234, targetId: 'b3', from: 'solution' });
});

test('currentAim：没解时直指最近的一颗合法球', () => {
  const cueAt = { x: table.length * 0.2, y: table.width / 2 };
  const near = createBall('b3', cueAt.x + 0.6, cueAt.y, { number: 3 });
  const far = createBall('b11', cueAt.x + 2.0, cueAt.y, { number: 11 });
  const cue = createBall('cue', cueAt.x, cueAt.y, { number: 0 });

  const aim = currentAim({ mode: 'practice', balls: [cue, far, near], solution: null });
  assert.equal(aim.from, 'direct');
  assert.equal(aim.targetId, 'b3');
  // 正右方 = 0 弧度
  assert.ok(Math.abs(aim.angle) < 1e-12);
});

test('currentAim：练习模式不认球局那份解', () => {
  const balls = makeBalls([3]);
  const aim = currentAim({
    mode: 'practice',
    balls,
    solution: null,
    gSolution: { found: true, best: { aimAngle: 2, targetId: 'b3' } },
  });
  assert.equal(aim.from, 'direct');
});

test('currentAim：八球分组后只认自己那组，哪怕对面那颗更近', () => {
  const cueAt = { x: table.length * 0.2, y: table.width / 2 };
  const cue = createBall('cue', cueAt.x, cueAt.y, { number: 0 });
  const nearStripe = createBall('b11', cueAt.x + 0.5, cueAt.y, { number: 11 });
  const farSolid = createBall('b3', cueAt.x + 1.5, cueAt.y, { number: 3 });

  const game = createGame(table, [cue, nearStripe, farSolid], { names: ['你', '对手'] });
  game.breakShot = false;
  game.open = false;
  game.turn = 0;
  game.players[0].group = 'solid';
  game.players[1].group = 'stripe';

  // 先确认规则层给的合法目标就跟这里预期的一致，免得测试自说自话
  assert.deepEqual(legalTargetNumbers(game, numbersOnTable(game.balls)), [3]);

  const aim = currentAim({ mode: 'game', game, gSolution: null });
  assert.equal(aim.targetId, 'b3');
  assert.equal(aim.from, 'direct');
  assert.equal(aim.angle, 0, '目标在正右方，角度就是 0');
});

test('currentAim：台面上只剩不合法球时返回 null', () => {
  const cue = createBall('cue', table.length * 0.2, table.width / 2, { number: 0 });
  const game = createGame(table, [cue], { names: ['你', '对手'] });
  game.breakShot = false;
  game.open = false;
  game.players[0].group = 'solid';
  assert.equal(currentAim({ mode: 'game', game, gSolution: null }), null);
});

// ---------------------------------------------------------------- 存档装载

test('restoreGameState：九个进程态字段逐项装回，不变回开局', () => {
  const game = makeGame(0);
  const saved = {
    players: [{ name: '阿甲', group: 'solid', fouls: 2, warned: true }, { name: '阿乙', group: 'stripe', fouls: 0, warned: false }],
    turn: 1,
    breakShot: false,
    open: false,
    ballInHand: { zone: 'kitchen' },
    requiresRerack: false,
    phase: 'playing',
    winner: null,
    shots: 17,
  };

  const out = restoreGameState(game, saved);
  assert.equal(out, game, '就地改并返回它');
  assert.equal(game.shots, 17);
  assert.equal(game.turn, 1);
  assert.equal(game.breakShot, false);
  assert.equal(game.open, false);
  assert.deepEqual(game.ballInHand, { zone: 'kitchen' });
  assert.equal(game.players[0].name, '阿甲');
  assert.equal(game.players[0].fouls, 2);
  assert.equal(game.players[1].group, 'stripe');
});

test('restoreGameState：选手和持球是副本，改存档不会改到活儿里的局', () => {
  const game = makeGame(0);
  const saved = {
    players: [{ name: '阿甲', group: null, fouls: 0, warned: false }, { name: '阿乙', group: null, fouls: 0, warned: false }],
    turn: 0,
    breakShot: false,
    open: true,
    ballInHand: { zone: 'table' },
    requiresRerack: false,
    phase: 'playing',
    winner: null,
    shots: 3,
  };

  restoreGameState(game, saved);
  assert.notEqual(game.players, saved.players);
  assert.notEqual(game.players[0], saved.players[0]);
  assert.notEqual(game.ballInHand, saved.ballInHand);

  saved.players[0].name = '改过的';
  saved.ballInHand.zone = 'kitchen';
  assert.equal(game.players[0].name, '阿甲');
  assert.equal(game.ballInHand.zone, 'table');
});

test('restoreGameState：没有持球时装回 null', () => {
  const game = makeGame(0);
  game.ballInHand = { zone: 'table' };
  restoreGameState(game, {
    players: [{ name: '你', group: null, fouls: 0, warned: false }, { name: '对手', group: null, fouls: 0, warned: false }],
    turn: 0,
    breakShot: false,
    open: true,
    ballInHand: null,
    requiresRerack: true,
    phase: 'ended',
    winner: 0,
    shots: 9,
  });
  assert.equal(game.ballInHand, null);
  assert.equal(game.requiresRerack, true);
  assert.equal(game.phase, 'ended');
  assert.equal(game.winner, 0);
});

test('restoreGameState：斯诺克比分要连数组一起搬过来，且是副本', () => {
  const balls = makeBalls([3, 11]);
  const game = createGame(table, balls, { names: ['你', '对手'], kind: 'snooker' });
  assert.ok(game.snooker, '前提：斯诺克局自带 snooker 字段');

  const saved = {
    players: [{ name: '你', group: null, fouls: 0, warned: false }, { name: '对手', group: null, fouls: 0, warned: false }],
    turn: 0,
    breakShot: false,
    open: false,
    ballInHand: null,
    requiresRerack: false,
    phase: 'playing',
    winner: null,
    shots: 5,
    snooker: { target: 'red', scores: [24, 11] },
  };

  restoreGameState(game, saved);
  assert.equal(game.snooker.target, 'red');
  assert.deepEqual(game.snooker.scores, [24, 11]);
  assert.notEqual(game.snooker, saved.snooker);
  assert.notEqual(game.snooker.scores, saved.snooker.scores);

  saved.snooker.scores[0] = 99;
  assert.equal(game.snooker.scores[0], 24);
});

test('restoreGameState：存档里没有 snooker 就不动原有的那份', () => {
  const game = createGame(table, makeBalls([3]), { names: ['你', '对手'], kind: 'snooker' });
  const before = game.snooker.scores.slice();
  restoreGameState(game, {
    players: [{ name: '你', group: null, fouls: 0, warned: false }, { name: '对手', group: null, fouls: 0, warned: false }],
    turn: 0,
    breakShot: false,
    open: false,
    ballInHand: null,
    requiresRerack: false,
    phase: 'playing',
    winner: null,
    shots: 1,
  });
  assert.deepEqual(game.snooker.scores, before);
});

// ------------------------------------------------------- 存档里的杆史（v2）

/**
 * 造一段能当撤销栈用的历史：每步存「打这一杆之前」的局面，
 * 再推进出一个「打完之后」的新局面，返回 { history, game: 最新局面 }。
 * 母球坐标故意留到 5 位小数，用来验证存档只对齐到 3 位、而不是逐位相同。
 */
function makeHistory(steps, limit = 100) {
  const history = [];
  let cur = makeGame(0);
  for (let i = 0; i < steps; i += 1) {
    pushHistoryEntry(history, cur, limit);
    const pre = history[history.length - 1];
    assert.equal(pre.shots, i, '撤销栈里存的是「这一杆之前」');

    const next = cloneGame(pre);
    next.shots = i + 1;
    next.turn = (i + 1) % 2;
    next.balls[0].x += 0.03714;
    next.balls[0].y += 0.01111;
    const victim = next.balls[1 + (i % 2)];
    victim.pocketed = true;
    victim.pocket = 'c-bl';
    next.log.push({ shot: i + 1, shooter: i % 2, summary: `第 ${i + 1} 杆 · 没有球进袋`, fouls: [] });
    cur = next;
  }
  return { history, game: cur };
}

/** 内存版 localStorage，够 writeSave / readSave 用。 */
function memoryStore() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

test('packHistory / unpackHistory：往返等价，球位只对齐到 3 位小数', () => {
  const { history, game } = makeHistory(4);
  const packed = packHistory(history);

  assert.equal(packed.d, 0, '没超预算不该丢步');
  assert.equal(packed.s.length, 4);
  assert.deepEqual(packed.b, game.balls.map((b) => b.id), '球顺序按 id 表固定，不用每步重复写');

  // 走一遍真实的序列化/反序列化：数组编码不能中途变成别的东西
  const { entries, dropped } = unpackHistory(JSON.parse(JSON.stringify(packed)), game);
  assert.equal(dropped, 0);
  assert.equal(entries.length, 4);

  for (let i = 0; i < entries.length; i += 1) {
    const want = history[i];
    assert.equal(entries[i].shots, want.shots);
    assert.equal(entries[i].turn, want.turn);
    assert.deepEqual(
      entries[i].players.map((p) => [p.name, p.group, p.fouls]),
      want.players.map((p) => [p.name, p.group, p.fouls]),
      '比分/分组/犯规要跟着杆史一起还原',
    );
    assert.equal(entries[i].log.length, want.log.length);

    for (let j = 0; j < want.balls.length; j += 1) {
      const got = entries[i].balls[j];
      const src = want.balls[j];
      assert.equal(got.id, src.id);
      // 3 位小数：不逐位相同，但误差不超过 0.5mm，且正好落在 saveCoord 上
      assert.ok(Math.abs(got.x - src.x) <= 0.0005 + 1e-9, `x 误差越界：${got.x} vs ${src.x}`);
      assert.ok(Math.abs(got.y - src.y) <= 0.0005 + 1e-9, `y 误差越界：${got.y} vs ${src.y}`);
      assert.equal(got.x, saveCoord(src.x));
      assert.equal(got.y, saveCoord(src.y));
      assert.equal(got.pocketed, src.pocketed);
      assert.equal(got.pocket ?? null, src.pocket ?? null);
    }
  }

  // 最新一步的母球坐标有 5 位小数（夹具故意加的），存进去必须被对齐到 3 位
  const last = history.length - 1;
  assert.notEqual(
    entries[entries.length - 1].balls[0].x,
    history[last].balls[0].x,
    '源坐标有 5 位小数，存进去必须被对齐',
  );
});

test('packHistory：超过体积预算时从最旧的开始丢，并记下丢了几步', () => {
  const { history } = makeHistory(10);
  const full = packHistory(history);
  const tight = packHistory(history, { budget: Math.floor(full.bytes / 2) });

  assert.ok(tight.bytes <= Math.floor(full.bytes / 2), `预算内还有 ${tight.bytes} > ${Math.floor(full.bytes / 2)}`);
  assert.ok(tight.s.length < 10, '预算减半必须真的丢步');
  assert.equal(tight.d, 10 - tight.s.length, '丢的步数要如实上报，读档后才能提示用户');
  assert.equal(tight.b.length, full.b.length, '球 id 表不属于可裁剪部分');

  // 丢的是最旧的：留下的第一步应当是原始历史里的第 d 步
  const { entries } = unpackHistory(tight, history[history.length - 1]);
  assert.equal(entries[0].shots, history[10 - tight.s.length].shots);
  assert.equal(entries[entries.length - 1].shots, history[9].shots, '最新一步必须留着');
});

test('packHistory：只保留最近 HISTORY_LIMIT 步，多出来的算丢掉', () => {
  const { history } = makeHistory(HISTORY_LIMIT + 5);
  assert.equal(history.length, HISTORY_LIMIT + 5, '夹具本身要够长');

  const packed = packHistory(history);
  assert.equal(packed.s.length, HISTORY_LIMIT);
  assert.equal(packed.d, 5);
  const { entries, dropped } = unpackHistory(packed, history[history.length - 1]);
  assert.equal(dropped, 5);
  assert.equal(entries[0].shots, 5, '丢的是最旧五步');
  assert.equal(entries[entries.length - 1].shots, HISTORY_LIMIT + 4);
});

test('packHistory：一步都没有时给空载荷，不写空壳', () => {
  const packed = packHistory([]);
  assert.deepEqual(packed.s, []);
  assert.deepEqual(packed.b, []);
  assert.equal(packed.d, 0);
  assert.ok(packed.bytes >= 0);
});

test('utf8Bytes：按 UTF-8 算字节，中文不是一字符一字节', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('台球'), 6);
  assert.equal(utf8Bytes(''), 0);
});

test('老存档兼容：没有 log / history 字段也要能读，读成空历史而不是报错', () => {
  const base = makeGame(1);

  // 缺字段：直接当作没有
  assert.deepEqual(unpackHistory(null, base), { entries: [], dropped: 0 });
  assert.deepEqual(unpackHistory(undefined, base), { entries: [], dropped: 0 });

  // v1 存档（真的把两个键删掉）走 sanitize 也要活
  const raw = serialize(base, 1700000000000, []);
  assert.equal('history' in raw, false, '空杆史不该写键');
  assert.equal('log' in raw, false, '空流水不该写键');
  const back = sanitize(JSON.parse(JSON.stringify(raw)));
  assert.ok(back, 'v1 老存档必须读得回来');
  assert.equal(back.history, null);
  assert.deepEqual(back.log, []);
  assert.equal(back.balls[0].x, base.balls[0].x, '球位仍是原精度，别顺手把它砍成 3 位');

  // 杆史字段被写坏时只丢杆史，不废整份存档
  const broken = sanitize({ ...raw, history: { b: ['cue'], s: [{ x: [1, 2] }] } });
  assert.ok(broken, '杆史坏了也别把局面一起否掉');
  assert.equal(broken.history, null);
  assert.ok(unpackHistory(broken.history, base).entries.length === 0);
});

test('存档往返：杆史与对局记录一起存，撤销一步回到上一杆（球位/杆数/轮次都对）', () => {
  const { history, game } = makeHistory(3);
  const store = memoryStore();

  assert.equal(serialize(game, 1700000000000, history).v, 2, '新存档要带版本号，方便下次再演进');
  assert.equal(writeSave(game, store, { now: 1700000000000, history }), true);
  const saved = readSave(store);
  assert.ok(saved, '存完必须读得回来');
  assert.equal(saved.log.length, game.log.length, '对局记录要跟着存档走');
  assert.ok(saved.history && saved.history.s.length === 3, '杆史要跟着存档走');
  assert.equal(saved.shots, 3);

  // 模拟 app 的读档：按存档重建一局，再把进程态与杆史装回去
  const balls = saved.balls.map((b) => createBall(b.id, b.x, b.y, b));
  const g = createGame(table, balls, { names: saved.players.map((p) => p.name), kind: saved.kind });
  restoreGameState(g, saved);
  assert.equal(g.log.length, game.log.length, '读档后「对局记录」不能显示为 —');

  const { entries, dropped } = unpackHistory(saved.history, g);
  assert.equal(dropped, 0);
  assert.equal(entries.length, 3);

  // 撤销一次拿到的就是栈顶那一步
  const prev = entries[entries.length - 1];
  const before = history[history.length - 1];
  assert.equal(prev.shots, g.shots - 1, '杆数要退回上一杆');
  assert.equal(prev.turn, before.turn);
  assert.notEqual(prev.turn, g.turn, '轮次要跟着换回去');
  for (let i = 0; i < prev.balls.length; i += 1) {
    assert.equal(prev.balls[i].x, saveCoord(before.balls[i].x));
    assert.equal(prev.balls[i].y, saveCoord(before.balls[i].y));
    assert.equal(prev.balls[i].pocketed, before.balls[i].pocketed);
    assert.equal(prev.balls[i].pocket ?? null, before.balls[i].pocket ?? null);
  }
});

// ------------------------------------------------- 杆史里的越界坐标（坏步要丢）
//
// 真机实测抓到的缺陷：把某一步的坐标手改成 9999，读档后一切「正常」、note 为
// null、控制台零报错，甚至点撤销能把母球放到 (9999,9999) 台面之外，求解器还照常
// 给建议。这种「静默读到坏数据」比直接报错更糟，所以单步坐标必须落在台面范围内。

/** 台面 + 袋口容差的允许坐标带（和 state.js 的取值口径一致：max(2R, 最大袋口捕捉半径)）。 */
function coordBand(t) {
  const jaw = t.pockets.reduce((m, p) => Math.max(m, p.captureR), 0);
  const margin = Math.max(2 * t.ballRadius, jaw);
  return {
    minX: t.bounds.minX - margin,
    maxX: t.bounds.maxX + margin,
    minY: t.bounds.minY - margin,
    maxY: t.bounds.maxY + margin,
  };
}

/** 造一份「只有一步」的杆史载荷，母球放在给定坐标上，其余球沿用局面里的球位。 */
function oneStepPayload(base, cueX, cueY) {
  const ids = base.balls.map((b) => b.id);
  const x = [];
  for (let i = 0; i < ids.length; i += 1) {
    x.push(i === 0 ? cueX : base.balls[i].x, i === 0 ? cueY : base.balls[i].y, -1);
  }
  return {
    b: ids,
    s: [{ s: 0, t: 0, k: 0, o: 0, h: 0, r: 0, e: 0, w: -1, g: [0, 0], f: [0, 0], n: [0, 0], l: 0, x }],
    d: 0,
  };
}

test('unpackHistory：某一步坐标越出台面就只丢那一步，并计入 dropped', () => {
  const { history, game } = makeHistory(3);
  const base = history[history.length - 1];
  const packed = JSON.parse(JSON.stringify(packHistory(history)));
  assert.equal(packed.s.length, 3);

  // 中间那一步写成「有限数、但根本不在台面上」——旧版会原样装进撤销栈
  packed.s[1].x[0] = 9999;
  packed.s[1].x[1] = 9999;

  const { entries, dropped } = unpackHistory(packed, game);
  assert.equal(entries.length, 2, '只丢坏的那一步，其余步照常还原');
  assert.equal(dropped, 1, '丢掉的那一步要如实计数，「更早的 N 步」才对得上');
  assert.deepEqual(entries.map((e) => e.shots), [0, 2], '丢的是中间那一步');

  const band = coordBand(table);
  for (const entry of entries) {
    for (const b of entry.balls) {
      assert.ok(b.x >= band.minX && b.x <= band.maxX, `x=${b.x} 不该出现在撤销栈里`);
      assert.ok(b.y >= band.minY && b.y <= band.maxY, `y=${b.y} 不该出现在撤销栈里`);
    }
  }

  // 整段都坏时 entries 为空，dropped 要等于步数（提示会退化成「更早的 N 步」）
  const allBad = JSON.parse(JSON.stringify(packed));
  for (const step of allBad.s) {
    step.x[0] = 1e9;
  }
  const none = unpackHistory(allBad, game);
  assert.equal(none.entries.length, 0);
  assert.equal(none.dropped, 3);
});

test('unpackHistory：边界值不误杀，真越界才丢', () => {
  const base = makeGame(1);
  const band = coordBand(table);
  const accept = (x, y, why) => {
    const { entries, dropped } = unpackHistory(oneStepPayload(base, x, y), base);
    assert.equal(dropped, 0, `${why}（${x}, ${y}）不该被丢`);
    assert.equal(entries.length, 1, `${why}（${x}, ${y}）应当还原成一步`);
  };
  const reject = (x, y, why) => {
    const { entries, dropped } = unpackHistory(oneStepPayload(base, x, y), base);
    assert.equal(entries.length, 0, `${why}（${x}, ${y}）必须丢掉`);
    assert.equal(dropped, 1, `${why}（${x}, ${y}）要计入 dropped`);
  };

  // 台面可行域的四角与贴库线：恰好落在 bounds 上仍然合法
  accept(table.bounds.minX, table.bounds.minY, '球心可行域左下角');
  accept(table.bounds.maxX, table.bounds.maxY, '球心可行域右上角');
  // 0 与 -0：坐标 0 在袋心所在的台面边界上，-0 就是 0，都不该被当成坏数据
  accept(0, 0, '角袋袋心');
  accept(-0, -0, '负零');
  accept(table.length / 2, 0, '中袋袋心');
  // 恰好超出一个球半径：落袋球的球心可以停在台外一个袋口半径处，不许误杀
  accept(table.bounds.maxX + table.ballRadius, table.bounds.maxY + table.ballRadius, '超出一个球半径');
  // 允许带的外沿（闭区间）：正好压在界上仍算合法
  accept(band.minX, band.minY, '允许带下界');
  accept(band.maxX, band.maxY, '允许带上界');

  // 真正越界：台外一米、极大值、负值、NaN
  reject(band.maxX + 0.001, table.width / 2, '越出允许带一毫米');
  reject(table.length + 1, table.width / 2, '台外一米');
  reject(1e9, 1e9, '极大值 1e9');
  reject(-5, table.width / 2, '负值');
  reject(Number.NaN, table.width / 2, 'NaN');

  // 一颗球的坐标坏了就丢整步（不是只把那一颗球挪回 0）
  const twoBad = oneStepPayload(base, table.length / 2, table.width / 2);
  twoBad.s[0].x[3] = table.length + 2;
  assert.equal(unpackHistory(twoBad, base).entries.length, 0, '任一球越界都要丢整步');
});

test('坏档：整档被拒时 loadSave 真的删掉 key，只读的 readSave 不动它', () => {
  const store = memoryStore();
  const raw = serialize(makeGame(0), 1700000000000, []);
  raw.balls[0].x = null; // 顶层球位读不出来 → sanitize 整份否掉
  store.setItem(SAVE_KEY, JSON.stringify(raw));

  assert.equal(readSave(store), null, '只读路径应当读不出局面');
  assert.notEqual(store.getItem(SAVE_KEY), null, 'readSave 只读，不许偷偷删档');

  const got = loadSave(store);
  assert.equal(got.status, 'corrupt');
  assert.equal(got.saved, null);
  assert.equal(got.discarded, true, '删成功要说出来，界面文案才敢写「已删除」');
  assert.equal(store.getItem(SAVE_KEY), null, '「已被丢弃」必须是真的：key 得没了');

  // 删完再读是 empty（不是 corrupt），下次进页面不会再撞上一份坏档
  const again = loadSave(store);
  assert.equal(again.status, 'empty');
  assert.equal(again.discarded, false);
});

test('坏档：版本号比本代码新的存档不删，只报 newer', () => {
  const store = memoryStore();
  const raw = serialize(makeGame(0), 1700000000000, []);
  raw.v = SAVE_VERSION + 1;
  raw.somethingNew = { anything: true };
  // 故意再写坏一处：确认判定顺序是「先看版本、再看内容」，新版本存档一个字节都不动
  raw.balls[0].x = null;
  store.setItem(SAVE_KEY, JSON.stringify(raw));

  const got = loadSave(store);
  assert.equal(got.status, 'newer', '版本差异不是坏数据');
  assert.equal(got.discarded, false);
  assert.notEqual(store.getItem(SAVE_KEY), null, '更新的版本必须留着，换回新版还要能读');
});

test('坏档：不是 JSON 的也应判损坏并删掉，空存储报 empty', () => {
  const store = memoryStore();
  assert.equal(loadSave(store).status, 'empty');

  store.setItem(SAVE_KEY, '{"table":');
  const got = loadSave(store);
  assert.equal(got.status, 'corrupt');
  assert.equal(got.discarded, true);
  assert.equal(store.getItem(SAVE_KEY), null);
});

// --------------------------------------------------- 撤销 / 读档后的自动出杆暂停

test('reduceAutoPause：读档与撤销进暂停，「用户击球」和「点此继续」才恢复', () => {
  const running = { autoPaused: false, autoPauseReason: null };

  const afterUndo = reduceAutoPause(running, 'undo');
  assert.deepEqual(afterUndo, { autoPaused: true, autoPauseReason: 'undo' });
  const afterLoad = reduceAutoPause(running, 'load');
  assert.deepEqual(afterLoad, { autoPaused: true, autoPauseReason: 'load' });

  // 用户自己出手 = 已经接手这一局，暂停到此为止
  assert.deepEqual(reduceAutoPause(afterLoad, 'user-shot'), { autoPaused: false, autoPauseReason: null });
  assert.deepEqual(reduceAutoPause(afterLoad, 'resume'), { autoPaused: false, autoPauseReason: null });
  assert.deepEqual(reduceAutoPause(afterLoad, 'new-game'), { autoPaused: false, autoPauseReason: null });

  // 不认识的动作不许悄悄解开暂停，也不许把原因抹掉
  assert.deepEqual(reduceAutoPause(afterLoad, 'whatever'), afterLoad);
  assert.deepEqual(reduceAutoPause(afterLoad, undefined), afterLoad);

  // 暂停里再读一次档：原因要更新成最新那次，文案才不会说错动作
  assert.deepEqual(reduceAutoPause(afterUndo, 'load'), { autoPaused: true, autoPauseReason: 'load' });
});

test('shouldAutoShoot：暂停、开关、回合、动画几道闸全过才会自己出杆', () => {
  const opponentTurn = { ...makeGame(1), turn: 1 };
  const base = {
    game: opponentTurn,
    autoOpponent: true,
    autoPaused: false,
    animating: false,
    opponentThinking: false,
  };

  assert.equal(shouldAutoShoot(base), true, '默认设置下该轮到对手自己打');
  assert.equal(shouldAutoShoot({ ...base, autoPaused: true }), false, '读档/撤销后的暂停不能自己出杆');
  assert.equal(shouldAutoShoot({ ...base, autoPaused: true, autoPauseReason: 'load' }), false);
  assert.equal(shouldAutoShoot({ ...base, autoOpponent: false }), false);
  assert.equal(shouldAutoShoot({ ...base, animating: true }), false);
  assert.equal(shouldAutoShoot({ ...base, opponentThinking: true }), false, '已经在算这一杆时别再起一杆');
  assert.equal(shouldAutoShoot({ ...base, game: { ...opponentTurn, turn: 0 } }), false);
  assert.equal(shouldAutoShoot({ ...base, game: { ...opponentTurn, phase: 'ended' } }), false);
  assert.equal(shouldAutoShoot({ ...base, game: null }), false);
  assert.equal(shouldAutoShoot(null), false);
});

test('autoPauseHint：暂停时给可点的恢复入口，关掉开关时说清对手为什么不动', () => {
  const opponentTurn = { ...makeGame(1), turn: 1 };

  const paused = autoPauseHint({ game: opponentTurn, autoOpponent: true, autoPaused: true, autoPauseReason: 'load' });
  assert.equal(paused.level, 'paused');
  assert.equal(paused.canResume, true);
  assert.match(paused.text, /已暂停对手自动出杆/);
  assert.match(paused.text, /读档/);

  const undone = autoPauseHint({ game: opponentTurn, autoOpponent: true, autoPaused: true, autoPauseReason: 'undo' });
  assert.match(undone.text, /撤销/);
  assert.notEqual(undone.text, paused.text, '两种原因要给出不同文案，否则用户不知道刚发生了什么');

  // 暂停优先于「开关关掉」：那是用户刚做的动作，先解释它
  const both = autoPauseHint({ game: opponentTurn, autoOpponent: false, autoPaused: true, autoPauseReason: 'undo' });
  assert.equal(both.level, 'paused');

  // 开关关掉且轮到对手：必须说清为什么没人动，但不能给「继续」的假按钮
  const off = autoPauseHint({ game: opponentTurn, autoOpponent: false, autoPaused: false });
  assert.equal(off.level, 'off');
  assert.equal(off.canResume, false);
  assert.match(off.text, /对手自动出杆已关闭/);

  // 暂停提示不按回合隐藏：读档时轮到玩家也要说一句「局面停住了」，否则用户下次
  // 看到对手不动时就没有线索去查开关；这条提示会在用户出手或点继续后自己消失。
  const mine = autoPauseHint({ game: { ...opponentTurn, turn: 0 }, autoOpponent: true, autoPaused: true });
  assert.equal(mine.level, 'paused');
  // 轮到玩家时没有「对手的自动出杆」可以暂停，说成「已暂停对手自动出杆」会让人
  // 以为对手正等他。这一档要说的是「局面停住了，继续之后自己求解」。
  assert.doesNotMatch(mine.text, /已暂停对手自动出杆/);
  assert.match(mine.text, /点此继续/);
  assert.match(mine.text, /求解/);
  // 但「开关关掉」那条只在轮到对手时才有意义
  assert.equal(autoPauseHint({ game: { ...opponentTurn, turn: 0 }, autoOpponent: false, autoPaused: false }), null);
  // 一局结束 / 没开局：不要在台面上压一条常驻提示
  assert.equal(autoPauseHint({ game: { ...opponentTurn, phase: 'ended' }, autoOpponent: false, autoPaused: false }), null);
  assert.equal(autoPauseHint({ game: null, autoOpponent: true, autoPaused: true }), null);
  assert.equal(autoPauseHint(null), null);
});
// ---------------------------------------------------------------- 玩法 ↔ 球台

// 真机实测过的坑：从斯诺克切回八球 / 九球，玩法换了、球台还停在 12 尺斯诺克台上。
// 原因是 demo/app.js 的 #gameKind 监听器只写了「切到斯诺克→换台」这一半，
// 切走那条路没有，于是 kind=eightball 却按 3.569 m 的台面摆 15 颗三角。
// 该用哪张台由 tableForKind 决定，这里把它钉住。

test('tableForKind：八球回 pool8、九球 pool9、斯诺克 snooker（切走也要换回来）', () => {
  // 关键回归：手上有斯诺克的显式选台记录时，切到八球仍然要回 8 尺台
  const manual = { snooker: 'snooker' };
  assert.equal(tableForKind('eightball', manual), 'pool8');
  assert.equal(tableForKind('nineball', manual), 'pool9');
  assert.equal(tableForKind('snooker', manual), 'snooker');

  // 不传第二个参数也要能用（app.js 的 tableManual 初始就是空的）
  assert.equal(tableForKind('eightball'), 'pool8');
  assert.equal(tableForKind('nineball'), 'pool9');
  assert.equal(tableForKind('snooker'), 'snooker');
});

test('tableForKind：默认台全是真预设，createTable 不会抛「球台参数非法」', () => {
  // src/table.js 最近加了几何自洽校验：非法参数会直接抛错。切台路径必须过得了这一关。
  const tables = {
    pool8: createTable(DEFAULT_TABLE_BY_KIND.eightball),
    pool9: createTable(DEFAULT_TABLE_BY_KIND.nineball),
    snooker: createTable(DEFAULT_TABLE_BY_KIND.snooker),
  };
  assert.equal(tables.pool8.length, 2.24, '八球默认 8 尺中式台');
  assert.equal(tables.pool9.length, 2.54, '九球默认 9 尺美式台');
  assert.equal(tables.snooker.length, 3.569, '斯诺克 12 尺台');
  // 预设 id 要和游戏里一致，否则存档里的 table.id 对不上
  assert.equal(tables.pool8.preset, 'pool8');
  assert.equal(tables.pool9.preset, 'pool9');
  assert.equal(tables.snooker.preset, 'snooker');
});

test('tableForKind：玩家显式选过的台优先，且不串到别的玩法上', () => {
  // 在八球下手选 9 尺台：切九球再切回八球，还得是他选的那张
  assert.equal(tableForKind('eightball', { eightball: 'pool9' }), 'pool9');
  assert.equal(tableForKind('nineball', { nineball: 'pool8' }), 'pool8');
  // 八球名下的选择不能影响九球
  assert.equal(tableForKind('nineball', { eightball: 'pool8' }), 'pool9');
  // 空串 / 非字符串当成「没选过」，退回默认台，别把空 id 喂给 createTable
  assert.equal(tableForKind('eightball', { eightball: '' }), 'pool8');
  assert.equal(tableForKind('eightball', { eightball: null }), 'pool8');
  assert.equal(tableForKind('nineball', null), 'pool9', '第二参数是 null 也不能炸');
});

test('tableForKind：斯诺克不吃显式选台（彩球点位按 12 尺台钉死）', () => {
  assert.equal(tableForKind('snooker', { snooker: 'pool9' }), 'snooker');
  assert.equal(tableForKind('snooker', { snooker: 'pool8' }), 'snooker');
});

test('tableForKind：不认识的玩法返回 null，让调用方保持现状而不是乱换台', () => {
  for (const bad of ['', 'eight-ball', '9ball', undefined, null]) {
    assert.equal(tableForKind(bad), null);
  }
  // 手动记录里就算有同名 key 也不能给一个假台出来
  assert.equal(tableForKind('bogus', { bogus: 'pool8' }), null);
});

test('切玩法后的球台能直接摆球：斯诺克 → 八球是 16 颗、九球 10 颗，全在台内', () => {
  const racks = {
    eightball: createRack('eightball', createTable(tableForKind('eightball', {})), { seed: 7 }),
    nineball: createRack('nineball', createTable(tableForKind('nineball', {})), { seed: 7 }),
  };

  assert.equal(racks.eightball.length, 16, '母球 + 15 颗');
  assert.equal(racks.nineball.length, 10, '母球 + 1~9 号');

  for (const [kind, rack] of Object.entries(racks)) {
    const t = createTable(tableForKind(kind, {}));
    for (const b of rack) {
      assert.ok(b.x > 0 && b.x < t.length, `${kind}: ${b.id} 的 x 出界了（${b.x}）`);
      assert.ok(b.y > 0 && b.y < t.width, `${kind}: ${b.id} 的 y 出界了（${b.y}）`);
    }
  }
  // 8 号 / 9 号必须各有且只有一颗，换个 kind 摆球时最容易漏的就是这两颗
  assert.equal(racks.eightball.filter((b) => b.id === 'b8').length, 1);
  assert.equal(racks.nineball.filter((b) => b.id === 'b9').length, 1);
});

test('切台后存档的 table.id 与实际台一致，读档能还原成同一张台', () => {
  const presetId = tableForKind('eightball', { eightball: 'pool9' });
  const t = createTable(presetId);
  const balls = createRack('eightball', t, { seed: 7 }).map((b) => createBall(b.id, b.x, b.y, b));
  const game = createGame(t, balls, { names: ['你', '对手'], kind: 'eightball' });

  const store = memoryStore();
  assert.equal(writeSave(game, store, { now: 1700000000000 }), true);
  const saved = readSave(store);
  assert.ok(saved, '存完必须读得回来');
  assert.equal(saved.table.id, 'pool9', '存档里记的必须是玩家选的那张台');
  assert.equal(saved.kind, 'eightball');

  // 读档路径（app.js 的 applyLoadedGame）就是按 table.id 再 createTable 一次
  const reloaded = createTable(saved.table.id);
  assert.equal(reloaded.preset, t.preset);
  assert.equal(reloaded.length, t.length);
});

// ---------------------------------------------------------------- esc

test('esc：尖括号与引号都转义，玩家名塞不进标签', () => {
  // 存档存在 localStorage 里，任何人改一下就能往计分板的 innerHTML 里塞标签
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc(`"你" & '对手'`), '&quot;你&quot; &amp; &#39;对手&#39;');
  assert.equal(esc('张&李'), '张&amp;李');
});

test('esc：null / undefined 是空串，0 和 false 要原样留下', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  // 计分板上 0 分是很常见的情况，被当成"没有"就会显示成空
  assert.equal(esc(0), '0');
  assert.equal(esc(false), 'false');
});

test('esc：只扫一遍，已经转义过的实体不会被放过', () => {
  // 正因为只扫一遍，'&amp;' 里的 & 还会再被判一次——这是有意的：
  // 输入本来就是一串原文，二次转义的代价远小于漏判。
  assert.equal(esc('&amp;'), '&amp;amp;');
});

// ---------------------------------------------------------------- findSpot

test('findSpot：空台面直接给台心', () => {
  assert.deepEqual(findSpot([], table), { x: table.length * 0.5, y: table.width * 0.5 });
});

test('findSpot：台心被占就挪开，且不压到任何一颗球、也不出台', () => {
  const balls = [createBall('cue', table.length * 0.5, table.width * 0.5, { number: 0 })];
  const spot = findSpot(balls, table);
  assert.notDeepEqual(spot, { x: table.length * 0.5, y: table.width * 0.5 }, '台心有人，不能还摆在台心');
  for (const b of balls) {
    assert.ok(
      Math.hypot(b.x - spot.x, b.y - spot.y) >= table.ballRadius * 2,
      `新球压到了 ${b.id}`
    );
  }
  assert.ok(spot.x >= table.bounds.minX && spot.x <= table.bounds.maxX);
  assert.ok(spot.y >= table.bounds.minY && spot.y <= table.bounds.maxY);
});

test('findSpot：已经落袋的球不占地方（它的旧坐标是空的）', () => {
  const dead = createBall('b1', table.length * 0.5, table.width * 0.5, { number: 1 });
  dead.pocketed = true;
  assert.deepEqual(findSpot([dead], table), { x: table.length * 0.5, y: table.width * 0.5 });
});

test('findSpot：台面真的没地方了返回 null，不抛也不硬塞', () => {
  // 用一张 0.3 米的迷你台把螺旋采样全堵死（真台要铺几千颗球，没必要）。
  // 网格间距 = 一个球径，任何一点到最近网格点都小于 2R，所以一个空位都没有。
  const R = table.ballRadius;
  const tiny = {
    length: 0.3,
    width: 0.3,
    ballRadius: R,
    bounds: { minX: R, maxX: 0.3 - R, minY: R, maxY: 0.3 - R },
  };
  const balls = [];
  let n = 0;
  for (let x = tiny.bounds.minX; x <= tiny.bounds.maxX; x += R) {
    for (let y = tiny.bounds.minY; y <= tiny.bounds.maxY; y += R) {
      balls.push(createBall('b' + n, x, y, { number: (n++ % 9) + 1 }));
    }
  }
  assert.ok(balls.length > 40, '网格要真的铺满');
  assert.equal(findSpot(balls, tiny), null);
});

// ---------------------------------------------------------------- getAimHUDInfo

/** 造一份 HUD 只读的那几个字段，其余一律不提供（它不该读别的东西）。 */
function hudState(over = {}) {
  return {
    mode: 'practice',
    solution: null,
    gSolution: null,
    balls: [],
    game: null,
    manual: { speed: 2.2, aimOffsetDeg: 0, tipA: 0, tipB: 0, touched: false },
    ...over,
  };
}

test('getAimHUDInfo：有解时报袋口名、容错角与力度档，鬼球取解给的坐标', () => {
  const info = getAimHUDInfo(hudState({
    balls: [createBall('cue', 0.5, 0.5, { number: 0 }), createBall('b1', 1.2, 0.5, { number: 1 })],
    manual: { speed: 3.0 },
    solution: {
      found: true,
      best: { targetNumber: 1, targetId: 'b1', pocketId: 'c-br', toleranceDeg: 1.2345, ghost: { x: 1.1, y: 0.42 }, aimAngle: 0, speed: 3.0 },
    },
  }));
  assert.equal(info.title, '第一人称瞄准');
  assert.match(info.detail, /1 号球 → 右下底袋/);
  assert.match(info.detail, /±1\.23°/);
  assert.match(info.detail, /中力 3\.00 m\/s/);
  assert.deepEqual(info.ghost, { x: 1.1, y: 0.42 }, '鬼球必须用解给的坐标，不能自己再算一遍');
});

test('getAimHUDInfo：没解时退成手打瞄准，鬼球落在目标球球心', () => {
  const info = getAimHUDInfo(hudState({
    balls: [createBall('cue', 0.3, 0.5, { number: 0 }), createBall('b2', 1.0, 0.5, { number: 2 })],
    manual: { speed: 2.2 },
  }));
  assert.equal(info.title, '第一人称手打瞄准');
  assert.match(info.detail, /2 号球 · 力度 2\.20 m\/s \(轻力 27%\)/);
  assert.deepEqual(info.ghost, { x: 1.0, y: 0.5 });
});

test('getAimHUDInfo：连目标球都没有时只报力度，鬼球为 null', () => {
  const info = getAimHUDInfo(hudState({ balls: [createBall('cue', 0.3, 0.5, { number: 0 })] }));
  assert.match(info.detail, /按 V 切换俯视/);
  assert.equal(info.ghost, null);
});

test('getAimHUDInfo：球局模式只看球局的解与球局的球，不串到练习局面', () => {
  const gameBalls = [
    createBall('cue', 1.5, 0.6, { number: 0 }),
    createBall('b5', 2.0, 0.6, { number: 5 }),
  ];
  const game = createGame(table, gameBalls, { names: ['你', '对手'], kind: 'eightball' });
  const info = getAimHUDInfo(hudState({
    mode: 'game',
    // 练习模式留着一个"有解"的局面，球局模式必须无视它
    balls: [createBall('cue', 0.3, 0.5, { number: 0 }), createBall('b1', 1.0, 0.5, { number: 1 })],
    solution: { found: true, best: { targetNumber: 1, pocketId: 'c-br', toleranceDeg: 9, ghost: { x: 9, y: 9 } } },
    game,
  }));
  assert.equal(info.title, '第一人称手打瞄准');
  assert.match(info.detail, /5 号球/);
  assert.deepEqual(info.ghost, { x: 2.0, y: 0.6 });
});

// ---------------------------------------------------------------- simulateFrames

/** 母球与 1 号球同在 x=1.27 的中线上，直推下中袋。 */
function straightBalls() {
  return [
    createBall('cue', 1.27, 0.62, { number: 0 }),
    createBall('b1', 1.27, 0.40, { number: 1 }),
  ];
}

const straightShot = { angle: -Math.PI / 2, speed: 3.0, tip: { a: 0, b: 0 } };

test('simulateFrames：首帧是击球前的静止局面，末帧里目标球已经落进下中袋', () => {
  const sim = simulateFrames(straightBalls(), table, straightShot, SEARCH_DT);
  assert.ok(sim, '正常局面不该返回 null');
  assert.equal(sim.dt, SEARCH_DT);
  assert.ok(sim.frames.length > 150, `帧数太少：${sim.frames.length}`);
  assert.ok(sim.frames.length <= 2401, '步数上限是 2400 步，帧数最多 2401');

  // 首帧：strike 只给速度不改坐标，所以第一帧还原封不动
  assert.deepEqual(
    sim.frames[0].map((r) => [r.x, r.y, r.pocketed]),
    [[1.27, 0.62, false], [1.27, 0.40, false]]
  );

  const last = sim.frames[sim.frames.length - 1];
  assert.equal(last[1].pocketed, true, '这一杆本来就该进');
  assert.equal(last[1].pocket, 'm-b');
  assert.equal(last[0].pocketed, false, '母球没摔');
  // 母球推进了却仍在中线上（直线球不该有横向漂移）
  assert.ok(Math.abs(last[0].x - 1.27) < 1e-9);
  assert.ok(last[0].y < 0.62, '母球要往前走了');
});

test('simulateFrames：全停判定在录帧之后，所以末两帧完全一样（停下那一刻没漏也没多录）', () => {
  const sim = simulateFrames(straightBalls(), table, straightShot, SEARCH_DT);
  const n = sim.frames.length;
  assert.deepEqual(sim.frames[n - 1], sim.frames[n - 2]);
  assert.notDeepEqual(sim.frames[n - 2], sim.frames[n - 3], '上一帧还在动，末帧才是真的停了');
});

test('simulateFrames：每帧每颗球都带渲染层要读的字段（x/y/袋口/滚动量）', () => {
  const sim = simulateFrames(straightBalls(), table, straightShot, SEARCH_DT);
  for (const frame of sim.frames) {
    assert.equal(frame.length, 2);
    for (const row of frame) {
      for (const k of ['x', 'y', 'rollAngle', 'rollDirX', 'rollDirY']) {
        assert.ok(Number.isFinite(row[k]), `${k} 必须是有限数，实际 ${row[k]}`);
      }
      assert.equal(typeof row.pocketed, 'boolean');
    }
  }
});

test('simulateFrames：同一输入两次调用逐字段相同（确定性），且都不改原数组', () => {
  const balls = straightBalls();
  const a = simulateFrames(balls, table, straightShot, SEARCH_DT);
  const b = simulateFrames(balls, table, straightShot, SEARCH_DT);
  assert.equal(JSON.stringify(a.frames), JSON.stringify(b.frames));
  assert.notEqual(a.frames, b.frames, '不能返回同一个数组，回放会就地改它');
  // 模拟跑的是副本：原局面必须一颗不动，否则回放结束后「复位」就复不回去了
  assert.deepEqual(balls.map((x) => [x.x, x.y, x.pocketed]), [[1.27, 0.62, false], [1.27, 0.40, false]]);
});

test('simulateFrames：返回的 balls 是模拟那份副本的终局，手打结果就读它', () => {
  const sim = simulateFrames(straightBalls(), table, straightShot, SEARCH_DT);
  assert.equal(describeManualShot(sim.balls).detail.join(' · '), '进 1 号');
  assert.equal(sim.balls.find((b) => b.number === 1).pocket, 'm-b');
});

test('simulateFrames：步数按 120×20 封顶，dt 再小也不会多跑一帧', () => {
  // dt 小到永远停不下来：帧数就是上限 2400 步 + 首帧
  assert.equal(simulateFrames(straightBalls(), table, straightShot, 1e-9).frames.length, 2401);
  // 不传 dt 时默认用求解同一个步长
  assert.equal(simulateFrames(straightBalls(), table, straightShot).dt, SEARCH_DT);
});

test('simulateFrames：场上没有母球时返回 null，让调用方早退而不是抛 TypeError', () => {
  assert.equal(
    simulateFrames([createBall('b1', 1.0, 0.5, { number: 1 })], table, straightShot, SEARCH_DT),
    null
  );
});

// ---------------------------------------------------------------- 存档要不要先问一句
//
// 真机实测丢档的那条路：A 标签页存档 → 新开 B → B 第一次点存档，没有任何提示就
// 盖掉了 A。原因是旧判定只比时间戳，而新开的页面记的时间戳是 null，一律放行。
// 下面这些断言钉的就是「null 不再等于放行」这件事。

test('reduceSaveWrite：同一会话反复存档不打扰（E2E 与正常用法都是这条）', () => {
  const stored = { stamp: 1700000000000, session: 'tab-a' };
  const verdict = reduceSaveWrite(stored, { stamp: 1700000000000, session: 'tab-a', overwrite: false });
  assert.deepEqual(verdict, { write: true, reason: 'same' });
});

test('reduceSaveWrite：存档是另一个会话写的就先问一句，不许直接盖', () => {
  // B 标签页刚打开：它谁也没见过（stamp 是 null），但存档里写着别人的会话串
  const stored = { stamp: 1700000000000, session: 'tab-a' };
  const verdict = reduceSaveWrite(stored, { stamp: null, session: 'tab-b', overwrite: false });
  assert.deepEqual(verdict, { write: false, reason: 'other-tab' });
});

test('reduceSaveWrite：没有已有存档时直接写（第一次存档不该问）', () => {
  assert.deepEqual(reduceSaveWrite(null, { stamp: null, session: 'tab-b', overwrite: false }), {
    write: true,
    reason: 'empty',
  });
});

test('reduceSaveWrite：存档坏到读不出写入方时不误拦', () => {
  // 坏档在 readSaveMeta 眼里就是「没有存档」：内容已经不可用，覆盖它不算丢东西
  const broken = memoryStore();
  broken.setItem(SAVE_KEY, '{"v":2,"savedAt":17,'); // 截断的 JSON
  assert.equal(readSaveMeta(broken), null);
  assert.equal(readSaveStamp(broken), null, '时间戳接口的语义不能变');
  assert.deepEqual(reduceSaveWrite(readSaveMeta(broken), { stamp: null, session: 'tab-b' }), {
    write: true,
    reason: 'empty',
  });
});

test('reduceSaveWrite：确认过一次之后才真覆盖', () => {
  const stored = { stamp: 1700000000001, session: 'tab-a' };
  assert.deepEqual(reduceSaveWrite(stored, { stamp: null, session: 'tab-b', overwrite: true }), {
    write: true,
    reason: 'confirmed',
  });
});

test('reduceSaveWrite：同一会话里存档被改过（时间戳对不上）也要先问', () => {
  const stored = { stamp: 1700000900000, session: 'tab-a' };
  assert.deepEqual(reduceSaveWrite(stored, { stamp: 1700000000000, session: 'tab-a', overwrite: false }), {
    write: false,
    reason: 'changed',
  });
});

test('reduceSaveWrite：老存档没有会话串，不能因此被当成「别人的档」拦下来', () => {
  const stored = { stamp: 1700000000000, session: null };
  assert.deepEqual(reduceSaveWrite(stored, { stamp: 1700000000000, session: 'tab-b', overwrite: false }), {
    write: true,
    reason: 'same',
  });
});

test('writeSave / readSaveMeta：写入方和内容一起进存档，导出的序列化里不带它', () => {
  const store = memoryStore();
  assert.equal(writeSave(makeGame(1), store, { now: 1700000000000, session: 'tab-a' }), true);
  assert.deepEqual(readSaveMeta(store), { stamp: 1700000000000, session: 'tab-a' });
  assert.equal(readSaveStamp(store), 1700000000000);
  // 导出文件里不该出现本机的一次性会话串
  assert.equal(serialize(makeGame(1), 1700000000000, []).session, undefined);
});

test('saveFailureKind：存储打不开（隐私模式）与配额满分开报，用户的下一步不一样', () => {
  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('SecurityError');
    },
  };
  assert.equal(saveFailureKind(blocked), 'blocked');
  assert.equal(saveFailureKind(null), 'blocked', '连存储对象都没有也是「打不开」');

  const full = {
    getItem: () => null,
    setItem() {
      const err = new Error('The quota has been exceeded.');
      err.name = 'QuotaExceededError';
      throw err;
    },
    removeItem() {},
  };
  assert.equal(saveFailureKind(full), 'quota');
});

// ---------------------------------------------------------------- 手打之后：下一杆
//
// 手打一杆之后，光说「进/没进」等于什么都没说——用户真正要看的是下一杆怎么打。
// 这里钉的就是那段拼接：求解结果怎么说成人话、无球可碰与局已结束怎麼区分、
// 瞄准偏了要不要提一句。求解本身在 demo/app.js 里调，函数只吃现成的结果。

const nextTable = createTable('pool8');

/** 造一颗球的最小形状（describeNextShot 只读 number / pocketed）。 */
function ball(number, pocketed = false) {
  return { number, pocketed };
}

/** 造一条求解候选（字段名与 src/solver.js 的候选一致）。 */
function candidate(overrides = {}) {
  return {
    targetNumber: 2,
    pocketId: 'c-br',
    toleranceDeg: 0.57,
    cueRest: { x: nextTable.length * 0.85, y: nextTable.width * 0.85 },
    ...overrides,
  };
}

test('describeNextShot：有可打目标时说清球号、袋口、容错和母球停哪儿', () => {
  const text = describeNextShot({
    outcome: { detail: ['进 1 号'], pocketed: [1], cuePocketed: false },
    balls: [ball(0), ball(2), ball(3)],
    candidates: [candidate()],
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 3,
  });

  assert.equal(
    text,
    '手打结果：进 1 号（1.20 m/s · 中杆 · 无塞）｜下一步：2 号→右下底袋，容错 ±0.6°，母球停在台面上右（距上库 17 厘米）'
  );
  // 候选缺失的字段不能变成 undefined / null 混进文案
  assert.ok(!/undefined|null|NaN/.test(text), text);
});

test('describeNextShot：候选里没有母球停位时就只报球号与容错，不硬编一句定位', () => {
  const text = describeNextShot({
    outcome: { detail: ['没有球进袋'], pocketed: [], cuePocketed: false },
    balls: [ball(0), ball(3)],
    candidates: [candidate({ cueRest: null, targetNumber: 3, pocketId: 'm-t', toleranceDeg: 0.21 })],
    table: nextTable,
    speed: 2,
    tipBLabel: '高杆',
    tipALabel: '左塞',
    solveMs: 1,
  });
  assert.ok(text.includes('｜下一步：3 号→上中袋，容错 ±0.2°'), text);
  assert.ok(!text.includes('母球停在'), text);
});

test('describeNextShot：台面上没有活着的号码球时说「没有可以合法先碰的球」', () => {
  const text = describeNextShot({
    outcome: { detail: ['进 3 号'], pocketed: [3], cuePocketed: false },
    balls: [ball(0), ball(3, true)],
    candidates: [],
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 2,
  });
  assert.ok(text.endsWith('｜下一步：没有可以合法先碰的球'), text);
});

test('describeNextShot：母球落袋时说清「先把它摆回台面」，不是干巴巴一句没球可打', () => {
  const text = describeNextShot({
    outcome: { detail: ['进 1 号', '母球落袋'], pocketed: [1], cuePocketed: true },
    balls: [ball(0, true), ball(2), ball(3)],
    candidates: [], // 母球在袋里，求解必然返回空
    table: nextTable,
    speed: 3.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 0.4,
  });
  assert.ok(text.includes('｜下一步：没有可以合法先碰的球（母球落袋，先把它摆回台面）'), text);
});

test('describeNextShot：这一杆把台面清完了就说「本局已结束」', () => {
  const text = describeNextShot({
    outcome: { detail: ['进 5 号'], pocketed: [5], cuePocketed: false },
    balls: [ball(0), ball(5, true)],
    finished: true,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 1,
  });
  assert.ok(text.endsWith('｜下一步：本局已结束'), text);
});

test('describeNextShot：偏离推荐方向超过 0.2° 才提那一句', () => {
  const base = {
    outcome: { detail: ['进 1 号'], pocketed: [1], cuePocketed: false },
    balls: [ball(0), ball(2)],
    candidates: [candidate()],
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 3,
    touched: true,
    aimFrom: 'solution',
  };

  const far = describeNextShot({ ...base, aimOffsetDeg: -3 });
  assert.ok(far.includes('（1.20 m/s · 中杆 · 无塞 · 已偏离推荐 ±3.0°）'), far);

  // 阈值以下不提：滑块步进 0.05°，0.15° 在 1 米外偏不到 3 毫米，提了只是噪音
  const near = describeNextShot({ ...base, aimOffsetDeg: AIM_NOTE_MIN_DEG * 0.75 });
  assert.ok(!near.includes('已偏离'), near);

  // 没动过滑块（touched 为假）时偏移量只是面板初值，不代表用户做过选择
  const untouched = describeNextShot({ ...base, aimOffsetDeg: 3, touched: false });
  assert.ok(!untouched.includes('已偏离'), untouched);
});

test('describeNextShot：没有推荐方向（直撞局面）时不能说成「偏离推荐」', () => {
  const text = describeNextShot({
    outcome: { detail: ['没有球进袋'], pocketed: [], cuePocketed: false },
    balls: [ball(0), ball(2)],
    candidates: [],
    table: nextTable,
    speed: 2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 2,
    touched: true,
    aimFrom: 'direct',
    aimOffsetDeg: 2.5,
  });
  assert.ok(text.includes('已偏离直指方向 ±2.5°'), text);
  assert.ok(!text.includes('已偏离推荐'), text);
});

test('describeNextShot：求解太慢或干脆没算成都只指向「求解」按钮，不留一句编出来的建议', () => {
  const slow = describeNextShot({
    outcome: { detail: ['进 1 号'], pocketed: [1], cuePocketed: false },
    balls: [ball(0), ball(2)],
    candidates: [candidate()],
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: NEXT_SHOT_SLOW_MS + 1,
  });
  assert.ok(slow.endsWith('｜下一步：点「求解」看看'), slow);

  const failed = describeNextShot({
    outcome: { detail: ['进 1 号'], pocketed: [1], cuePocketed: false },
    balls: [ball(0), ball(2)],
    candidates: null, // 求解抛错
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: null,
  });
  assert.ok(failed.endsWith('｜下一步：点「求解」看看'), failed);
});

test('describeNextShot：求解很快但一条候选都没有时说「没有直接的进球线」，不假装看得见球', () => {
  const text = describeNextShot({
    outcome: { detail: ['没有球进袋'], pocketed: [], cuePocketed: false },
    balls: [ball(0), ball(2), ball(3)],
    candidates: [],
    table: nextTable,
    speed: 1.2,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 4,
  });
  assert.ok(text.includes('｜下一步：没有直接的进球线，点「求解」看组合球或防守'), text);
});

test('describeNextShot：空态与异常输入不抛，也不会拼出 undefined', () => {
  for (const input of [undefined, null, {}, { outcome: null, balls: null, candidates: 'x' }, { balls: 5 }]) {
    const text = describeNextShot(input);
    assert.equal(typeof text, 'string');
    assert.ok(text.startsWith('手打结果：'), text);
    assert.ok(text.includes('｜下一步：'), text);
    assert.ok(!/undefined|null|NaN|\[object/.test(text), text);
  }
  // 候选是个形状不对的东西时退化成「点求解看看」，不能让整段播报消失
  const weird = describeNextShot({
    outcome: { detail: [] },
    balls: [ball(0), ball(2)],
    candidates: [{}],
    table: nextTable,
    speed: 1,
    tipBLabel: '中杆',
    tipALabel: '无塞',
    solveMs: 1,
  });
  assert.ok(weird.includes('｜下一步：没有直接的进球线'), weird);
});

// ---------------------------------------------------------------- 局内统计
//
// 下面每一条 summary 都是逐字抄 src/rules.js:838-851 与 src/snooker.js:418-431
// 拼出来的真实文案。改文案的人不会来看这个文件，所以这里刻意不伪造格式：
// 一旦规则引擎换了播报，这几条会立刻红——那正是想要的。

/** 一条流水。形状与 src/rules.js:657 的 log.push 一致。 */
function entry(shot, shooter, summary, fouls = []) {
  return { shot, shooter, summary, fouls };
}

test('computeMatchStats：一局正常的黑八，杆数 / 进球 / 连击 / 犯规都对得上真实播报', () => {
  // 顺序：开球一杆进两颗 → 续杆再进 → 空杆换手 → 对手进一颗 → 对手犯规 → 进 8 号收官
  const log = [
    entry(1, 0, '开球 · 进 1、2 号 · 你 继续'),
    entry(2, 0, '进 3 号 · 你 继续'),
    entry(3, 0, '没有球进袋 · 换 对手'),
    entry(4, 1, '进 5 号 · 换 对手'),
    entry(5, 1, '没有球进袋 · 犯规：母球落袋（WPA 3.1） · 换 你'),
    entry(6, 0, '进 8 号 · 你 继续'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: 0, myself: 0 });
  assert.equal(stats.shots, 6);
  // 一杆进两颗算一次进球：按颗数算的话命中率会到 5/6，界面上写「命中率」却
  // 把一杆多球重复计了。
  assert.equal(stats.pots, 4);
  assert.equal(stats.potRate, 4 / 6);
  assert.equal(stats.longestRun, 2, '开球 + 续杆连进两杆');
  assert.equal(stats.fouls, 1);
  assert.equal(stats.result, 'win');
});

test('computeMatchStats：零杆局返回 0 与 null，不出现 NaN', () => {
  const stats = computeMatchStats({ log: [], kind: 'eightball', winner: null, myself: 0 });
  assert.equal(stats.shots, 0);
  assert.equal(stats.pots, 0);
  assert.equal(stats.potRate, null, '0 杆时没有命中率；返回 0 会被界面写成「0%」');
  assert.equal(stats.longestRun, 0);
  assert.equal(stats.fouls, 0);
  assert.equal(stats.result, 'undecided');
});

test('computeMatchStats：整局全犯规，进球为 0 但犯规次数照实记', () => {
  const log = [
    entry(1, 0, '开球 · 没有球进袋 · 犯规：开球未过线（WPA 3.2） · 换 对手'),
    entry(2, 1, '没有球进袋 · 犯规：空杆（WPA 6.1） · 换 你'),
    entry(3, 0, '没有球进袋 · 犯规：母球落袋（WPA 3.1） · 换 对手'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: 1, myself: 0 });
  assert.equal(stats.shots, 3);
  assert.equal(stats.pots, 0);
  assert.equal(stats.potRate, 0);
  assert.equal(stats.longestRun, 0);
  assert.equal(stats.fouls, 3);
  assert.equal(stats.result, 'loss');
});

test('computeMatchStats：只有对手进球时进球与连击都记在对手身上，结果是我输', () => {
  const log = [
    entry(1, 0, '开球 · 没有球进袋 · 换 对手'),
    entry(2, 1, '进 2 号 · 对手 继续'),
    entry(3, 1, '进 4 号 · 对手 继续'),
    entry(4, 1, '进 8 号 · 对手 继续'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: 1, myself: 0 });
  assert.equal(stats.pots, 3);
  assert.equal(stats.longestRun, 3, '对手连着三杆进球');
  assert.equal(stats.result, 'loss');
  // 换个视角：自己就是对手那一方
  assert.equal(computeMatchStats({ log, kind: 'eightball', winner: 1, myself: 1 }).result, 'win');
});

test('computeMatchStats：撤销之后的 log（最后几条被裁掉）按剩下的杆号算，不从 1 补', () => {
  // 打完 5 杆，连撤两步，log 只剩 1–3；杆号仍然是 1、2、3
  const log = [
    entry(1, 0, '开球 · 进 1 号 · 你 继续'),
    entry(2, 0, '没有球进袋 · 换 对手'),
    entry(3, 1, '进 2 号 · 换 对手'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: null, myself: 0 });
  assert.equal(stats.shots, 3);
  assert.equal(stats.pots, 2);
  assert.equal(stats.longestRun, 1);
});

test('computeMatchStats：开球不达标后「交回」那条决定不重复计杆，也不当成一杆进球', () => {
  // src/rules.js:829-834：handBackBreak 会往 log 里补一条，杆号与刚打完的那杆相同
  const log = [
    entry(1, 0, '开球 · 没有球进袋 · 开球不达标，接手方可以选择照打或交回 · 换 对手'),
    entry(1, 1, '接手方选择把这一杆交回给原开球方再打一杆（WPA Regulation 16(4)）。'),
    entry(2, 0, '进 3 号 · 你 继续'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: null, myself: 0 });
  assert.equal(stats.shots, 2, '补的那条决定不算一杆');
  assert.equal(stats.pots, 1);
  assert.equal(stats.fouls, 0, '「开球不达标」不是犯规码，别把文案里的字当成犯规');
});

test('computeMatchStats：斯诺克按「得 N 分」判进球，没有球号也能算', () => {
  const log = [
    entry(1, 0, '得 8 分 · 8 : 0 · 该打红球 · 你 继续'),
    entry(2, 0, '没有球进袋 · 犯规：空杆（WPA 6.1），罚 4 分 · 8 : 4 · 该打红球 · 换 对手'),
    entry(3, 1, '得 1 分 · 8 : 5 · 该打彩球 · 换 对手'),
  ];
  const stats = computeMatchStats({ log, kind: 'snooker', winner: 0, myself: 0 });
  assert.equal(stats.shots, 3);
  assert.equal(stats.pots, 2);
  assert.equal(stats.fouls, 1);
  assert.equal(stats.result, 'win');
});

test('computeMatchStats：收官那一杆的播报被换成结束语，进的那颗球也要算上', () => {
  // 真实播报（src/rules.js:838-851 的 ended 分支）：那一杆的 summary 只剩
  // 「你 与 对手 的这一局结束：你 获胜。」，「进 8 号」整段被替换掉了。
  // 击球者正是胜者、也没有犯规 → 这一杆就是把最后一颗打进的那一杆。
  const log = [
    entry(1, 0, '开球 · 进 1、2、3 号 · 你 继续'),
    entry(2, 0, '没有球进袋 · 换 对手'),
    entry(3, 1, '没有球进袋 · 换 你'),
    entry(4, 0, '你 与 对手 的这一局结束：你 获胜。'),
  ];
  const stats = computeMatchStats({ log, kind: 'eightball', winner: 0, myself: 0 });
  assert.equal(stats.shots, 4);
  assert.equal(stats.pots, 2, '开球那一杆 1 次 + 收官这一杆 1 次');
  assert.equal(stats.potRate, 0.5);
  assert.equal(stats.fouls, 0);
  assert.equal(stats.result, 'win');
});

test('computeMatchStats：犯规收场、或把 8 号打进却输局，结束那一杆都不算进球', () => {
  // 斯诺克：只剩黑球时犯规，这一局直接结束、对手赢（src/snooker.js:349-353）
  const foulEnd = [
    entry(1, 0, '进 1 号 · 你 继续'),
    entry(2, 1, '只剩黑球时犯规，这一局结束：你 获胜（47 : 41）。', ['wrong_ball_first']),
  ];
  const a = computeMatchStats({ log: foulEnd, kind: 'snooker', winner: 0, myself: 0 });
  assert.equal(a.pots, 1, '犯规那一杆不算进球');
  assert.equal(a.fouls, 1);

  // 黑八：提前把 8 号打进就是输局，击球者不是胜者，那一杆也不能算成命中
  const earlyEight = [
    entry(1, 0, '进 1 号 · 你 继续'),
    entry(2, 0, '你 与 对手 的这一局结束：对手 获胜。'),
  ];
  const b = computeMatchStats({ log: earlyEight, kind: 'eightball', winner: 1, myself: 0 });
  assert.equal(b.pots, 1, '击球者是输家 → 那不是合规的收官进球');
  assert.equal(b.result, 'loss');
});

test('computeMatchStats：异常输入一律退化，不抛也不出 NaN', () => {
  const inputs = [
    undefined,
    null,
    {},
    { log: null },
    { log: 'x' },
    { log: [null, 5, 'x', {}, { shot: 'a', summary: 42, fouls: 'scratch' }] },
    { log: [entry(1, 0, null, null)] },
    { log: [entry(0, 7, undefined)] },
  ];
  for (const input of inputs) {
    const stats = computeMatchStats(input);
    for (const key of ['shots', 'pots', 'longestRun', 'fouls']) {
      assert.equal(typeof stats[key], 'number', `${key} 必须是数字`);
      assert.ok(Number.isFinite(stats[key]) && stats[key] >= 0, `${key}=${stats[key]}`);
    }
    assert.ok(stats.potRate === null || Number.isFinite(stats.potRate), 'potRate 只能是 null 或数字');
    assert.ok(['win', 'loss', 'undecided'].includes(stats.result));
  }
});

// ---------------------------------------------------------------- 跨局战绩汇总

test('summarizeHistory：空历史不炸，各项归零、命中率 null、走势为空', () => {
  for (const input of [undefined, null, [], 'x', [null, 5]]) {
    const sum = summarizeHistory(input);
    assert.equal(sum.matches, 0);
    assert.equal(sum.wins, 0);
    assert.equal(sum.losses, 0);
    assert.equal(sum.shots, 0);
    assert.equal(sum.potRate, null);
    assert.equal(sum.longestRun, 0);
    assert.deepEqual(sum.recent, []);
  }
});

test('summarizeHistory：单场就是那一场', () => {
  const sum = summarizeHistory([
    { ts: 1, kind: 'nineball', result: 'win', shots: 8, potRate: 0.5, longestRun: 2, fouls: 1 },
  ]);
  assert.equal(sum.matches, 1);
  assert.equal(sum.wins, 1);
  assert.equal(sum.losses, 0);
  assert.equal(sum.shots, 8);
  assert.equal(sum.potRate, 0.5);
  assert.equal(sum.longestRun, 2);
  assert.deepEqual(sum.recent, ['win']);
});

test('summarizeHistory：多场混合胜负，总命中率按杆数加权而不是把百分比求平均', () => {
  const sum = summarizeHistory([
    { ts: 1, kind: 'eightball', result: 'win', shots: 10, potRate: 0.5, longestRun: 3, fouls: 0 },
    { ts: 2, kind: 'snooker', result: 'loss', shots: 2, potRate: 1, longestRun: 1, fouls: 0 },
    { ts: 3, kind: 'nineball', result: 'loss', shots: 8, potRate: 0.25, longestRun: 2, fouls: 4 },
  ]);
  assert.equal(sum.matches, 3);
  assert.equal(sum.wins, 1);
  assert.equal(sum.losses, 2);
  assert.equal(sum.shots, 20);
  // (10×0.5 + 2×1 + 8×0.25) / 20 = 0.45；直接平均是 0.583，那是错的
  assert.ok(Math.abs(sum.potRate - 0.45) < 1e-9, String(sum.potRate));
  assert.equal(sum.longestRun, 3);
  assert.deepEqual(sum.recent, ['win', 'loss', 'loss'], '旧 → 新');
});

test('summarizeHistory：坏条目跳过，走势最多留 10 场', () => {
  const entries = [];
  for (let i = 0; i < 14; i += 1) {
    entries.push({ ts: i, kind: 'eightball', result: i % 2 ? 'win' : 'loss', shots: 4, potRate: 0.5 });
  }
  const sum = summarizeHistory([null, ...entries, 'x', { result: 'win' }]);
  assert.equal(sum.recent.length, 10);
  assert.equal(sum.recent.at(-1), 'win', '最近一场是第 13 场（奇数 → win）');
  assert.equal(sum.matches, 15, '最后那个只有 result 的算一场未分胜负以外的条目也能计');
});

// ---------------------------------------------------------------- 战绩存储
//
// 战绩是**独立**的一份：不进存档 v2 的 log / history，读坏了只丢这一份。

test('appendMatch / readMatches：存进去能读回来，字段被裁剪成白名单', () => {
  const store = memoryStore();
  const out = appendMatch(
    { kind: 'eightball', result: 'win', shots: 9, potRate: 0.4444, longestRun: 3, fouls: 1, junk: 'x' },
    store,
    { now: 1700000000000 }
  );
  assert.equal(out.ok, true);
  assert.equal(out.matches.length, 1);
  const raw = JSON.parse(store.getItem(MATCH_KEY));
  assert.equal(raw.v, 1, '带版本号');
  assert.equal(raw.items[0].ts, 1700000000000);
  assert.equal(raw.items[0].junk, undefined, '白名单之外的字段不落盘');

  const back = readMatches(store);
  assert.equal(back.length, 1);
  assert.equal(back[0].kind, 'eightball');
  assert.equal(back[0].result, 'win');
  assert.equal(back[0].shots, 9);
});

test('appendMatch：只留最近 MATCH_LIMIT 场，最旧的被挤掉', () => {
  const store = memoryStore();
  for (let i = 0; i < MATCH_LIMIT + 7; i += 1) {
    appendMatch({ kind: 'nineball', result: 'win', shots: 3, potRate: 0.5 }, store, { now: i + 1 });
  }
  const back = readMatches(store);
  assert.equal(back.length, MATCH_LIMIT);
  assert.equal(back[0].ts, 8, '前 7 场被挤掉了');
  assert.equal(back.at(-1).ts, MATCH_LIMIT + 7);
});

test('readMatches：整份读坏就丢掉重来，不把坏字符串留在存储里', () => {
  const store = memoryStore();
  store.setItem(MATCH_KEY, '{"v":1,"items":[');
  assert.deepEqual(readMatches(store), []);
  assert.equal(store.getItem(MATCH_KEY), null, '坏档真的被删了，不是只报个错');
});

test('readMatches：单条看不懂只跳过那一条，其余照读；命中率越界收敛到 0–1', () => {
  const store = memoryStore();
  store.setItem(
    MATCH_KEY,
    JSON.stringify({
      v: 1,
      items: [
        { ts: 1, kind: 'eightball', result: 'win', shots: 5, potRate: 2 },
        { ts: 2, kind: '不认识', result: 'win', shots: 5 },
        { ts: 3, kind: 'snooker', result: '乱写', shots: -1, potRate: -0.5 },
        null,
      ],
    })
  );
  const back = readMatches(store);
  assert.equal(back.length, 2, '玩法不认识的那条被丢掉');
  assert.equal(back[0].potRate, 1, '>1 的命中率收敛到 1');
  assert.equal(back[1].potRate, 0, '<0 的收敛到 0');
  assert.equal(back[1].result, 'undecided');
  assert.equal(back[1].shots, 0, '负数杆数归零');
});

test('存储不可用时 appendMatch 返回 ok:false，但仍给出「本该存成什么样」', () => {
  const out = appendMatch({ kind: 'eightball', result: 'loss', shots: 4 }, null, { now: 9 });
  assert.equal(out.ok, false);
  assert.equal(out.matches.length, 1);
  assert.equal(out.matches[0].ts, 9);
  assert.equal(readMatches(null).length, 0);
});

test('clearMatches：清空之后读回来是空的', () => {
  const store = memoryStore();
  appendMatch({ kind: 'eightball', result: 'win', shots: 2 }, store, { now: 1 });
  assert.equal(readMatches(store).length, 1);
  assert.equal(clearMatches(store), true);
  assert.deepEqual(readMatches(store), []);
});

// ---------------------------------------------------------------- 分享这一杆的文案
//
// buildShareSummary 决定「分享图下半部分印什么」。图本身（离屏画布、字号、
// 折行）在 app.js 里，浏览器端到端只能看个大概；文案字段与**顺序**在这里钉死，
// 改断言的成本才不是「起一次 Chrome」。

/** 一条正常的进攻候选，字段含义见 src/solver.js 里候选对象的注释。 */
function shareCandidate(over = {}) {
  return {
    targetId: 'b3',
    targetNumber: 3,
    pocketId: 'c-br',
    cutDeg: 32.4,
    toleranceDeg: 0.57,
    distanceCue: 0.85,
    speed: 2.6,
    power: { name: '中', speed: 2.6 },
    tip: { a: 0, b: 0, name: '中杆' },
    cueRest: { x: 1.62, y: 0.83 },
    ...over,
  };
}

test('buildShareSummary：正常一杆印出七个字段，顺序固定（目标球→袋口→杆法→力度→切角→容错→母球落点）', () => {
  const table = createTable('pool9');
  const out = buildShareSummary({
    shot: { found: true, best: shareCandidate() },
    table,
    balls: [{ number: 0, x: 0.6, y: 0.6, pocketed: false }],
  });

  assert.equal(out.title, '3 号球 → 右下底袋');
  assert.deepEqual(
    out.lines.map((l) => l.label),
    ['目标球', '袋口', '杆法', '力度', '切角', '容错', '母球落点'],
  );
  const value = (label) => out.lines.find((l) => l.label === label).value;
  assert.equal(value('目标球'), '3 号球');
  assert.equal(value('袋口'), '右下底袋');
  assert.equal(value('杆法'), '中杆');
  assert.equal(value('力度'), '中力（2.60 m/s）', '光说「中」复现不了，得带 m/s');
  assert.equal(value('切角'), '32°');
  // 容错那句自带「母球走多远、偏几毫米就打不进」，前半段必须原样
  assert.match(value('容错'), /^±0\.57°（母球走 0\.85 米，方向偏 \d+(\.\d)? 毫米就打不进）$/);
  // 落点用台面方位而不是裸坐标；具体袋名由 solver 决定，这里只钉结构
  assert.match(value('母球落点'), /^台面.+（距.+库 \d+ 厘米）$/);
  assert.equal(out.lines.length, 7, '没有摔袋风险就不该多出那一行');
});

test('buildShareSummary：无解时给一条「说明」，不硬凑七个空字段', () => {
  const table = createTable('pool9');
  const out = buildShareSummary({
    shot: { found: false, message: '没有可以直接进攻的球——需要打防守，或先解一杆。' },
    table,
  });

  assert.equal(out.title, '这一杆没有可以直接进攻的球');
  assert.deepEqual(out.lines, [
    { label: '说明', value: '没有可以直接进攻的球——需要打防守，或先解一杆。' },
  ]);
});

test('buildShareSummary：母球会摔袋时末尾追加「⚠ 注意」，落点写「已落袋」而不是编一个坐标', () => {
  const table = createTable('pool9');
  const out = buildShareSummary({
    shot: {
      found: true,
      best: shareCandidate({ cueRest: null, scratchRisk: true, cuePath: { kind: 'pocket' } }),
    },
    table,
    balls: [{ number: 0, x: 1, y: 0.5, pocketed: true }],
  });

  assert.equal(out.lines.length, 8);
  const last = out.lines[out.lines.length - 1];
  assert.deepEqual(last, { label: '⚠ 注意', value: '母球有摔袋风险' });
  assert.equal(
    out.lines.find((l) => l.label === '母球落点').value,
    '母球已落袋',
    '球都进袋了还说「未要求走位」就是骗人',
  );
});

test('buildShareSummary：斯诺克彩球走球名分支（不是「20 号球」），袋口照样按 id 翻译', () => {
  const table = createTable('snooker');
  const out = buildShareSummary({
    shot: {
      found: true,
      best: shareCandidate({ targetId: 'black', targetNumber: 20, pocketId: 'c-tr' }),
    },
    table,
    balls: [{ number: 0, x: 1, y: 0.9 }],
  });

  const ball = out.lines.find((l) => l.label === '目标球').value;
  assert.notEqual(ball, '20 号球', '16 以上是彩球，不能再按号码念');
  assert.ok(ball.endsWith('球'), `彩球名应形如「黑球」，实际是 ${ball}`);
  assert.equal(out.title, `${ball} → 右上底袋`);
  // 斯诺克台 3.569×1.778，落点方位仍然算得出来，不会退回坐标
  assert.match(out.lines.find((l) => l.label === '母球落点').value, /^台面/);
});

test('buildShareSummary：空值 / 类型不对 / 缺字段都不抛，最差也给一个能导出的说明', () => {
  const cases = [
    undefined,
    {},
    { shot: null },
    { shot: '一串没用的文本', table: null, balls: null },
    { shot: { best: null, message: 42 } },
    { shot: { best: { targetNumber: NaN, pocketId: '' } } },
    { shot: { found: true, best: {} }, table: createTable('pool9'), balls: 'not-an-array' },
  ];
  for (const input of cases) {
    const out = buildShareSummary(input);
    assert.equal(typeof out.title, 'string');
    assert.ok(Array.isArray(out.lines) && out.lines.length >= 1);
    for (const line of out.lines) {
      assert.equal(typeof line.label, 'string');
      assert.equal(typeof line.value, 'string');
    }
  }
});

// ---------------------------------------------------------------- 分享局面的文案
//
// buildTableSummary 决定「分享局面」那张图下半部分印什么。和 buildShareSummary 一样
// 分工：排版在 app.js，说什么在这里，于是文案字段、顺序、措辞都能在 Node 里逐字钉住。
// 它比「这一杆」多一层责任——图上的圈（mark）也从这里出，文案说「你 全色 剩 3」和
// 图上圈住的那三颗必须是同一批号码。

/** 一局八球中盘：台面上只剩指定号码，双方已分球、可指定轮到谁。 */
function eightballGame({ numbers, groups = ['solid', 'stripe'], turn = 0, shots = 6 }) {
  const game = createGame(table, makeBalls(numbers), { names: ['你', '对手'] });
  game.breakShot = false;
  game.open = false;
  game.shots = shots;
  game.turn = turn;
  game.players[0].group = groups[0];
  game.players[1].group = groups[1];
  return game;
}

test('buildTableSummary：八球中盘印轮到谁 / 比分 / 两组剩余 / 下一步，mark 圈本组那几颗', () => {
  const game = eightballGame({ numbers: [3, 4, 5, 9, 10, 11, 8] });
  const out = buildTableSummary({
    game,
    balls: game.balls,
    table,
    shot: { found: true, best: shareCandidate() },
  });

  assert.equal(out.title, '八球 · 第 6 杆');
  assert.deepEqual(
    out.lines.map((l) => l.label),
    ['轮到', '比分', '球组', '下一步'],
    '行序固定：轮到谁 → 比分 → 球组 → 下一步',
  );
  const value = (label) => out.lines.find((l) => l.label === label).value;
  assert.equal(value('轮到'), '你（全色）', '八球光说名字不够，得带他打哪一组');
  assert.equal(value('比分'), '你 4 : 4 对手', '台面上本组剩 3 颗，就是进了 4 颗');
  assert.equal(value('球组'), '你 全色 剩 3 · 对手 花色 剩 3');
  assert.equal(value('下一步'), '3 号球 → 右下底袋，中杆 · 中力');
  assert.deepEqual(out.mark.numbers, [3, 4, 5], '图上圈的必须和文案里「剩 3」对得上');
  assert.equal(out.mark.label, '全色');
});

test('buildTableSummary：九球不分组，只报台面剩几颗与当前该打的最小号', () => {
  const game = createGame(table, makeBalls([1, 2, 3, 4, 5]), {
    names: ['你', '对手'],
    kind: 'nineball',
  });
  game.breakShot = false;
  game.open = false;
  game.shots = 3;
  const out = buildTableSummary({ game, balls: game.balls, shot: { found: false } });
  const value = (label) => out.lines.find((l) => l.label === label).value;

  assert.equal(out.title, '九球 · 第 3 杆');
  assert.equal(value('轮到'), '你', '九球没有「你打哪一组」，别硬加括号');
  assert.equal(value('比分'), '已进 4 颗 · 台面剩 5 颗', '9 颗的玩法，剩 5 颗就是进了 4 颗');
  assert.equal(value('球组'), '无分组 · 目标 1 号球 · 台面剩 5 颗');
  assert.deepEqual(out.mark.numbers, [1], '九球永远只能先碰最小号');
  // 求解过但没球可打，和「还没求解」是两件事，这里必须分开说
  assert.equal(value('下一步'), '求解过：没有可直接进攻的球，先防守或解一杆。');
});

test('buildTableSummary：斯诺克印红球剩余与该打的球，彩球用球名不用号码', () => {
  const game = createGame(table, makeBalls([1, 2, 3, 16, 20]), {
    names: ['你', '对手'],
    kind: 'snooker',
  });
  game.shots = 2;
  const out = buildTableSummary({ game, balls: game.balls });
  // 每次重新算：下面会改 ballOn，抓着第一次的结果读会读到旧文案
  const ballOnLine = () =>
    buildTableSummary({ game, balls: game.balls }).lines.find((l) => l.label === '球局').value;

  assert.equal(out.title, '斯诺克 · 第 2 杆');
  assert.equal(out.lines.find((l) => l.label === '比分').value, '你 0 : 0 对手');
  assert.equal(ballOnLine(), '红球剩 3 颗 · 该打 红球');
  assert.deepEqual(out.mark.numbers, [1, 2, 3], '该打红球时圈的是红球，不是彩球');

  // 刚打进红球 → 任意彩球；红球打完 → 只能打指定的那颗彩球
  game.snooker.ballOn = 'color';
  assert.equal(ballOnLine(), '红球剩 3 颗 · 该打 任意彩球');
  game.snooker.ballOn = 20;
  assert.match(ballOnLine(), /该打 粉球$/, '20 号是粉球，印「20 号球」没人知道那是哪颗');
  assert.deepEqual(
    buildTableSummary({ game, balls: game.balls }).mark.numbers,
    [20],
    '指定彩球时只圈那一颗',
  );
});

test('buildTableSummary：只剩黑八时点明「只剩黑八」，mark 圈 8 号', () => {
  const game = eightballGame({ numbers: [8], shots: 11 });
  const out = buildTableSummary({ game, balls: game.balls });
  const value = (label) => out.lines.find((l) => l.label === label).value;

  assert.equal(value('比分'), '你 7 : 7 对手', '两组都清完，各进 7 颗');
  assert.equal(value('球组'), '你 全色 剩 0 · 对手 花色 剩 0 · 只剩黑八');
  assert.deepEqual(out.mark.numbers, [8], '本组清完之后该打的就是 8 号');
});

test('buildTableSummary：「还没求解」与「求解过没球」分开写，异常入参一律不抛', () => {
  const game = eightballGame({ numbers: [3, 9, 8] });
  const next = (shot) =>
    buildTableSummary({ game, balls: game.balls, shot }).lines.find((l) => l.label === '下一步')
      .value;

  assert.equal(next(undefined), '还没求解');
  assert.equal(next(null), '还没求解');
  assert.equal(next({ found: false }), '求解过：没有可直接进攻的球，先防守或解一杆。');
  assert.equal(
    next({ found: false, message: '台面上没有可以合法先碰的球。' }),
    '台面上没有可以合法先碰的球。',
    '求解器给了说明就照它说，别用通用兜底盖掉',
  );

  const cases = [
    undefined,
    {},
    null,
    { game: '一串没用的文本', balls: 5 },
    { game: { kind: 'eightball', players: null }, balls: null },
    { game: { kind: 'snooker' }, balls: [{ number: 0 }] },
  ];
  for (const input of cases) {
    const out = buildTableSummary(input);
    assert.equal(typeof out.title, 'string');
    assert.ok(Array.isArray(out.lines) && out.lines.length >= 1);
    for (const line of out.lines) {
      assert.equal(typeof line.label, 'string');
      assert.equal(typeof line.value, 'string');
    }
    assert.ok(Array.isArray(out.mark.numbers), 'mark 永远是可用的数组，绘图层不必再判空');
  }
});

test('buildTableSummary：没有对局时按「练习摆球」说，照样给出下一步', () => {
  const out = buildTableSummary({
    balls: makeBalls([5, 6]),
    table,
    shot: { found: true, best: shareCandidate() },
  });

  assert.equal(out.title, '练习台面 · 还剩 2 颗球');
  assert.deepEqual(out.lines.map((l) => l.label), ['玩法', '台面', '下一步']);
  assert.equal(out.lines[0].value, '练习摆球（还没开局）');
  assert.equal(out.lines[1].value, '2 颗目标球 · 母球在台上');
  assert.deepEqual(out.mark.numbers, [], '练习模式不分组，一颗都不圈');
});

// ---------------------------------------------------------------- 整局复盘图
//
// buildMatchSummary 决定「复盘这一局」那张图印什么：标题（比分）、比分走势
// （纯数据折线，绘制在 app.js 里）、最多三条关键杆、统计块。局没结束就返回 null，
// 调用方据此把按钮禁掉——所以「什么算没结束」也要一条条钉住。
//
// 下面每一条 summary 都照 src/rules.js:878-891 与 src/snooker.js:418-431 的真实
// 播报逐字抄；折线期望值全部手算，不从实现里反推。

/** 一局收尾时的对局对象；只带复盘要读的字段。 */
function matchGame(over = {}) {
  return {
    phase: 'ended',
    winner: 0,
    kind: 'eightball',
    players: [{ name: '你' }, { name: '对手' }],
    log: [],
    ...over,
  };
}

test('buildMatchSummary：完整黑八局印比分 / 三条关键杆 / 统计，走势按杆累计', () => {
  // 1 开球进 1、2 号 → 2 续杆进 3 号 → 3 空杆换手 → 4 对手进 5 号 → 5 对手犯规 → 6 收官
  const log = [
    entry(1, 0, '开球 · 进 1、2 号 · 你 继续'),
    entry(2, 0, '进 3 号 · 你 继续'),
    entry(3, 0, '没有球进袋 · 换 对手'),
    entry(4, 1, '进 5 号 · 换 你'),
    entry(5, 1, '没有球进袋 · 犯规：母球落袋（WPA 3.1） · 换 你', ['scratch']),
    entry(6, 0, '你 与 对手 的这一局结束：你 获胜。'),
  ];
  const out = buildMatchSummary({ game: matchGame({ log }) });

  // 手算：我进 1、2 号那一杆算 1 杆；3 号算 1 杆；收官算 1 杆 → 3。对手进 5 号 → 1。
  assert.equal(out.title, '八球 · 我 3 : 1 对手');
  // 手算累计：0 → 我+1 → 我+1 → 不变 → 对手+1 → 不变 → 我+1（收官那杆）
  assert.deepEqual(out.chart, [
    { x: 0, y1: 0, y2: 0 },
    { x: 1, y1: 1, y2: 0 },
    { x: 2, y1: 2, y2: 0 },
    { x: 3, y1: 2, y2: 0 },
    { x: 4, y1: 2, y2: 1 },
    { x: 5, y1: 2, y2: 1 },
    { x: 6, y1: 3, y2: 1 },
  ]);
  assert.deepEqual(
    out.lines.map((l) => l.label),
    ['关键杆 1', '关键杆 2', '关键杆 3', '杆数', '命中率', '最长连击', '犯规'],
  );
  const value = (label) => out.lines.find((l) => l.label === label).value;
  assert.equal(value('关键杆 1'), '最长连击 2 杆（第 1–2 杆）');
  // 没传每一杆的求解候选，就不许编一个角度出来
  assert.equal(value('关键杆 2'), '犯规 1 次（母球落袋 ×1）');
  assert.equal(value('关键杆 3'), '收官一杆 第 6 杆 · 你 赢下这一局');
  // 4 杆进球 / 6 杆 = 66.7% → 67%
  assert.equal(value('杆数'), '6 杆');
  assert.equal(value('命中率'), '67%');
  assert.equal(value('最长连击'), '2 杆');
  assert.equal(value('犯规'), '1 次');
});

test('buildMatchSummary：九球用「进 9 号」判进球，比分记在对手头上', () => {
  const log = [
    entry(1, 0, '开球 · 没有球进袋 · 换 对手'),
    entry(2, 1, '进 9 号 · 对手 继续'),
    entry(3, 1, '你 与 对手 的这一局结束：对手 获胜。'),
  ];
  const out = buildMatchSummary({ game: matchGame({ kind: 'nineball', winner: 1, log }) });

  assert.equal(out.title, '九球 · 我 0 : 2 对手');
  assert.deepEqual(out.chart, [
    { x: 0, y1: 0, y2: 0 },
    { x: 1, y1: 0, y2: 0 },
    { x: 2, y1: 0, y2: 1 },
    { x: 3, y1: 0, y2: 2 },
  ]);
  const value = (label) => out.lines.find((l) => l.label === label).value;
  assert.equal(value('关键杆 1'), '最长连击 2 杆（第 2–3 杆）');
  assert.equal(value('命中率'), '67%', '3 杆里进了 2 杆');
});

test('buildMatchSummary：斯诺克标题用比分而不是进球杆数，走势按「得 N 分」累计', () => {
  const log = [
    entry(1, 0, '得 12 分 · 12 : 0 · 该打彩球 · 你 继续'),
    entry(2, 0, '犯规：母球落袋，罚 4 分 · 12 : 4 · 该打红球 · 换 对手', ['scratch']),
    entry(3, 1, '得 8 分 · 12 : 12 · 该打红球 · 对手 继续'),
    entry(4, 0, '得 7 分 · 19 : 12 · 该打红球 · 你 继续'),
    entry(5, 0, '你 与 对手 的这一局结束：你 获胜（19 : 12）。'),
  ];
  const out = buildMatchSummary({
    game: matchGame({ kind: 'snooker', log, snooker: { scores: [19, 12] } }),
  });

  // 进球杆数是 3:1，但斯诺克看分：标题必须是 19 : 12
  assert.equal(out.title, '斯诺克 · 我 19 : 12 对手');
  assert.deepEqual(out.chart, [
    { x: 0, y1: 0, y2: 0 },
    { x: 1, y1: 1, y2: 0 },
    { x: 2, y1: 1, y2: 0 },
    { x: 3, y1: 1, y2: 1 },
    { x: 4, y1: 2, y2: 1 },
    { x: 5, y1: 3, y2: 1 },
  ]);
  assert.equal(out.lines.find((l) => l.label === '犯规').value, '1 次');
});

test('buildMatchSummary：局没结束一律返回 null，绝不编一份 0:0 的复盘', () => {
  const log = [entry(1, 0, '进 1 号 · 你 继续')];
  const cases = [
    { game: matchGame({ phase: 'playing', log }), why: '还在打' },
    { game: matchGame({ phase: 'ended', winner: null, log }), why: '结束了却不知道谁赢' },
    { game: matchGame({ phase: 'ended', winner: 2, log }), why: '胜者下标是脏值' },
    { game: matchGame({ phase: '', log }), why: 'phase 缺失' },
  ];
  for (const c of cases) {
    assert.equal(buildMatchSummary({ game: c.game }), null, c.why);
  }
});

test('buildMatchSummary：log 为空 / 不是数组 / 一条能用的记录都没有，都返回 null', () => {
  assert.equal(buildMatchSummary({ game: matchGame({ log: [] }) }), null);
  assert.equal(buildMatchSummary({ game: matchGame({ log: 'nope' }) }), null);
  assert.equal(
    buildMatchSummary({ game: matchGame({ log: [null, 3, 'x', {}] }) }),
    null,
    '形状不对的条目退化成空杆，凑不出一条有效流水',
  );
  assert.equal(buildMatchSummary({ game: matchGame({ log: null }) }), null);
});

test('buildMatchSummary：长局按等间距抽点，首尾保留并在文案里说明', () => {
  const log = [];
  for (let shot = 1; shot <= 79; shot += 1) log.push(entry(shot, 0, '进 1 号 · 你 继续'));
  log.push(entry(80, 0, '你 与 对手 的这一局结束：你 获胜。'));
  const out = buildMatchSummary({ game: matchGame({ log }) });

  assert.equal(out.chart.length, 60, '80 杆不能画成 81 个点，会糊成一条带');
  assert.equal(out.chart[0].x, 0);
  assert.equal(out.chart[out.chart.length - 1].x, 80, '折线必须收在终局那一杆');
  assert.equal(out.chart[out.chart.length - 1].y1, 80);
  // 降采样不许把累计值改小：x 递增、y 单调不减
  for (let i = 1; i < out.chart.length; i += 1) {
    assert.ok(out.chart[i].x > out.chart[i - 1].x, `第 ${i} 点的 x 必须严格变大`);
    assert.ok(out.chart[i].y1 >= out.chart[i - 1].y1);
  }
  assert.equal(
    out.lines.find((l) => l.label === '走势').value,
    '共 80 杆，折线降采样到 60 点',
  );
});

test('buildMatchSummary：最大容错杆取整局最大的那个，非法候选直接忽略', () => {
  const log = [
    entry(1, 0, '进 1 号 · 你 继续'),
    entry(2, 1, '没有球进袋 · 换 你'),
    entry(3, 0, '你 与 对手 的这一局结束：你 获胜。'),
  ];
  const shots = [
    { shot: 1, targetNumber: 1, pocketId: 'c-br', toleranceDeg: 0.57 },
    { shot: 1, targetNumber: 1, pocketId: 'c-br', toleranceDeg: 0.4 },
    { shot: 2, targetNumber: 8, pocketId: 'm-b', toleranceDeg: 1.4 },
    { shot: 3, targetNumber: 3, pocketId: 'c-tr', toleranceDeg: 'x' },
    { shot: 4, targetNumber: 4, pocketId: 'c-tl', toleranceDeg: -1 },
  ];
  const out = buildMatchSummary({ game: matchGame({ log }), shots });
  const lines = out.lines.filter((l) => l.label.startsWith('关键杆')).map((l) => l.value);
  assert.equal(lines[0], '最大容错杆 8 号球 → 下中袋 ±1.40°');
  assert.ok(!lines.some((v) => v.includes('NaN')), '非法容错角不许变成 NaN°');

  // 没有候选就一条都不印，而不是印个 ±0.00°
  const bare = buildMatchSummary({ game: matchGame({ log }) });
  assert.ok(!bare.lines.some((l) => l.value.includes('最大容错杆')));
});

test('buildMatchSummary：stats 传进来就用，越界值收敛而不是照抄', () => {
  const log = [
    entry(1, 0, '进 1 号 · 你 继续'),
    entry(2, 0, '你 与 对手 的这一局结束：你 获胜。'),
  ];
  const out = buildMatchSummary({
    game: matchGame({ log }),
    stats: { shots: 12, potRate: -0.5, longestRun: 4, fouls: 0 },
  });
  const value = (label) => out.lines.find((l) => l.label === label).value;
  assert.equal(value('杆数'), '12 杆', '面板统计优先');
  assert.equal(value('命中率'), '0%', '比例越界要夹到 0–1，不能印 -50%');
  assert.equal(value('最长连击'), '4 杆');

  const fallback = buildMatchSummary({
    game: matchGame({ log }),
    stats: { shots: NaN, potRate: 'x', longestRun: -2, fouls: Infinity },
  });
  const v2 = (label) => fallback.lines.find((l) => l.label === label).value;
  assert.equal(v2('杆数'), '2 杆', '坏值退回按 log 算出来的那份');
  assert.equal(v2('最长连击'), '2 杆');
});

test('buildMatchSummary：异常输入一律退化，不抛也不出 undefined', () => {
  const cases = [
    null,
    undefined,
    {},
    { game: null },
    { game: 'x' },
    { game: {} },
    { game: matchGame({ log: [] }), stats: null, shots: null },
    { game: matchGame({ log: [entry(1, 0, '进 1 号 · 你 继续'), entry(2, 0, '你 与 对手 的这一局结束：你 获胜。')] }), shots: 'oops', table: null },
  ];
  for (const input of cases) {
    const out = buildMatchSummary(input);
    if (out === null) continue;
    assert.equal(typeof out.title, 'string');
    assert.ok(out.title.length > 0);
    assert.ok(Array.isArray(out.lines));
    for (const line of out.lines) {
      assert.equal(typeof line.label, 'string');
      assert.equal(typeof line.value, 'string');
      assert.ok(!line.value.includes('undefined') && !line.value.includes('NaN'), line.value);
    }
    assert.ok(Array.isArray(out.chart));
    for (const p of out.chart) {
      for (const k of ['x', 'y1', 'y2']) assert.equal(typeof p[k], 'number');
    }
  }
});

// 回归护栏：新增第三种导出不许动前两种的形状。字段名 / 顺序 / 每行的 label
// 都被这里钉死，buildMatchSummary 的改动只要漏到它们身上就会红。
test('回归护栏：buildShareSummary / buildTableSummary 的字段与顺序不变', () => {
  const shot = buildShareSummary({
    shot: { found: true, best: shareCandidate() },
    table,
    balls: [{ number: 0, x: 0.6, y: 0.6, pocketed: false }],
  });
  assert.deepEqual(Object.keys(shot), ['title', 'lines']);
  assert.deepEqual(
    shot.lines.map((l) => l.label),
    ['目标球', '袋口', '杆法', '力度', '切角', '容错', '母球落点'],
  );

  const game = createGame(table, makeBalls([1, 2, 3]), { names: ['你', '对手'], kind: 'eightball' });
  const tableOut = buildTableSummary({ game, balls: game.balls });
  assert.deepEqual(Object.keys(tableOut), ['title', 'lines', 'mark']);
  assert.deepEqual(Object.keys(tableOut.mark), ['numbers', 'label']);
});

// ---------------------------------------------------------------- 这一杆的播报文案
//
// reportHtml 原先在 app.js 里被逐字抄了三遍（玩家打完一杆 / 对手那一杆 / 结算那一杆）。
// 改一个字段漏一处，就会出现「同样的 report，有的流程显示、有的流程不显示」。
// 现在只有这一份实现，三个调用点各自传选项；这里的断言把那三份输出逐字钉住，
// 谁再把它复制回去、或者顺手改了个标点，测试都会红。

test('reportHtml：普通进球（玩家一杆）就是 summary 加上犯规和附加行', () => {
  assert.equal(reportHtml({ summary: '你打进 3 号球，继续。' }, { next: { turn: 0 } }), '你打进 3 号球，继续。');
  assert.equal(
    reportHtml(
      { summary: '你打进 3 号球，继续。', fouls: [{ text: '击球后没有球碰库' }, { text: '母球先碰到 8 号' }] },
      {}
    ),
    '你打进 3 号球，继续。<div class="foul">犯规：击球后没有球碰库；母球先碰到 8 号</div>',
    '多条犯规用「；」连起来，前缀是「犯规：」'
  );
});

test('reportHtml：分组与持球两行按固定顺序拼在末尾的 div 里', () => {
  const report = { summary: '犯规。', fouls: [{ text: '母球落袋' }], groupAssigned: { player: 1, group: 'stripe' } };
  assert.equal(
    reportHtml(report, { next: { turn: 0, ballInHand: { zone: 'kitchen' } } }),
    '犯规。<div class="foul">犯规：母球落袋</div>' +
      '<div>分组：对手拿到花色 · 持球：在开球线后点一下放母球</div>',
    '犯规块在前，附加行统一折叠成一个 div、用「 · 」分隔'
  );
  assert.equal(
    reportHtml({ ...report, groupAssigned: { player: 0, group: 'solid' } }, {
      next: { turn: 1, ballInHand: {} },
    }),
    '犯规。<div class="foul">犯规：母球落袋</div>' +
      '<div>分组：你拿到全色 · 持球：在台面上点一下放母球</div>',
    'zone 不是 kitchen 就是台面上；持球这行对谁写由 ballInHandForPlayerOnly 决定，默认都写'
  );
});

test('reportHtml：重摆文案有三个调用点的真实差异，靠 spotted 选项区分而不是各写一份', () => {
  // 玩家那一杆 / 对手那一杆：只有 8 号球重摆才说，而且说「回 8 号点」
  assert.equal(
    reportHtml({ summary: '清台。', spotted: 8 }, { next: { turn: 0 }, spotted: 'only8' }),
    '清台。<div>8 号球已重摆回 8 号点</div>'
  );
  assert.equal(
    reportHtml({ summary: '清台。', spotted: 9 }, { next: { turn: 0 }, spotted: 'only8' }),
    '清台。',
    'only8 模式下别的号码重摆不写（那不是 8 号点的事）'
  );
  // 结算那一杆：任何号码都写，但说的是「回底点」
  assert.equal(
    reportHtml({ summary: '清台。', spotted: 9 }, { next: { turn: 0 }, spotted: 'any' }),
    '清台。<div>9 号球已重摆回底点</div>'
  );
  assert.equal(
    reportHtml({ summary: '清台。', spotted: 8 }, { next: { turn: 0 }, spotted: 'any' }),
    '清台。<div>8 号球已重摆回底点</div>'
  );
});

test('reportHtml：对手那一杆的前缀与「只在轮到玩家时才写持球」', () => {
  const report = { summary: '对手打进 5 号球。', fouls: [], spotted: 8 };
  const options = { prefix: '<b>对手</b> · ', spotted: 'only8', ballInHandForPlayerOnly: true, tail: ['挑的这杆留给你 ±1.20°'] };
  assert.equal(
    reportHtml(report, { ...options, next: { turn: 0, ballInHand: {} } }),
    '<b>对手</b> · 对手打进 5 号球。<div>8 号球已重摆回 8 号点 · 持球：在台面上点一下放母球 · 挑的这杆留给你 ±1.20°</div>',
    '轮到玩家、且玩家有持球：写；选杆说明排在最后'
  );
  assert.equal(
    reportHtml(report, { ...options, next: { turn: 1, ballInHand: {} } }),
    '<b>对手</b> · 对手打进 5 号球。<div>8 号球已重摆回 8 号点 · 挑的这杆留给你 ±1.20°</div>',
    '还是对手的回合、持球是给对手的：不写，免得玩家以为该自己放球'
  );
});

test('reportHtml：开球不合法 / 开球不达标两句只在结算那一杆出现', () => {
  const report = { summary: '开球不合法。', requiresRerack: true, pendingChoice: { kind: 'break' } };
  assert.equal(
    reportHtml(report, { next: { turn: 1 }, pendingChoiceHint: true }),
    '开球不合法。<div>开球不合法，需要重摆 · 开球不达标，你可以在下面选照打还是交回去</div>'
  );
  assert.equal(
    reportHtml(report, { next: { turn: 1 } }),
    '开球不合法。<div>开球不合法，需要重摆</div>',
    '没开 pendingChoiceHint 就只写重摆，别替玩家决定'
  );
});

test('reportHtml：空 report 不产出空壳 div，对手那一杆仍保留前缀', () => {
  assert.equal(reportHtml({}, { next: { turn: 0 } }), '');
  assert.equal(reportHtml({ summary: '' }, {}), '', '没有附加行时不许留下一个空的 <div></div>');
  assert.equal(reportHtml({}, { prefix: '<b>对手</b> · ' }), '<b>对手</b> · ');
  assert.equal(reportHtml({}, { tail: [] }), '', 'tail 是空数组不算附加行');
});

// ---------------------------------------------------------------- 未知玩法不许静默兜底

test('gameKindOrThrow：认识的原样返回，不认识的直接抛且带上实际收到的值', () => {
  for (const kind of ['eightball', 'nineball', 'snooker']) {
    assert.equal(gameKindOrThrow(kind), kind, '已知玩法必须原样返回，不能顺手改写成别的');
  }
  const bad = ['tenball', 'chineseeight', 'Eightball', '', 'toString', undefined, null, {}, 0];
  for (const kind of bad) {
    assert.throws(
      () => gameKindOrThrow(kind),
      (err) => {
        assert.match(err.message, /不认识的玩法：/, err.message);
        assert.ok(err.message.includes(String(kind)), `错误信息要带上实际收到的值：${err.message}`);
        assert.match(err.message, /eightball/, `顺便说清支持哪几种：${err.message}`);
        return true;
      },
      `${String(kind)} 必须抛`
    );
  }
});

test('buildTableSummary：未知玩法不再印「台面」，直接抛错', () => {
  const game = createGame(table, makeBalls([1, 2, 8]), { names: ['你', '对手'], kind: 'eightball' });
  game.breakShot = false;
  game.open = false;
  game.shots = 4;
  // 已知玩法照旧
  assert.equal(buildTableSummary({ game, balls: game.balls }).mark.label, '未分组');

  const broken = { ...game, kind: 'tenball' };
  assert.throws(
    () => buildTableSummary({ game: broken, balls: broken.balls }),
    (err) => {
      assert.match(err.message, /不认识的玩法：/);
      assert.ok(err.message.includes('tenball'), `错误信息要带上实际收到的 kind：${err.message}`);
      return true;
    },
    '加十球时忘了补图例分支，必须当场炸，不能印一句「台面」糊过去'
  );
});
