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
  DEFAULT_TABLE_BY_KIND,
  HISTORY_LIMIT,
  autoPauseHint,
  captureBallFrame,
  clamp,
  copyBallsForShot,
  currentAim,
  describeManualShot,
  getPowerTier,
  packHistory,
  practiceHint,
  practiceReady,
  pushHistoryEntry,
  reduceAutoPause,
  restoreGameState,
  restorePositions,
  saveCoord,
  shouldAutoShoot,
  snapshotPositions,
  tableForKind,
  undoLabel,
  unpackHistory,
  utf8Bytes,
} from '../demo/state.js';
import { readSave, sanitize, serialize, writeSave } from '../demo/save.js';

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
  assert.equal(
    practiceHint({ mode: 'practice', solution: solved, practiceRecorded: false }),
    '按实际结果点「进了」或「没进」——记下来才看得出进步。'
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

  // 暂停提示不按回合隐藏：读档时轮到玩家也要说「已暂停」，否则用户下次看到
  // 对手不动时就没有线索去查开关；这条提示会在用户出手或点继续后自己消失。
  assert.equal(autoPauseHint({ game: { ...opponentTurn, turn: 0 }, autoOpponent: true, autoPaused: true }).level, 'paused');
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
