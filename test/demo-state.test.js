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
import { createGame, numbersOnTable, legalTargetNumbers } from '../src/rules.js';

import {
  HISTORY_LIMIT,
  captureBallFrame,
  clamp,
  copyBallsForShot,
  currentAim,
  describeManualShot,
  getPowerTier,
  practiceHint,
  practiceReady,
  pushHistoryEntry,
  restoreGameState,
  restorePositions,
  snapshotPositions,
  undoLabel,
} from '../demo/state.js';

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