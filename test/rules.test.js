// 黑八规则测试。
//
// 这一组测试刻意不依赖物理：simulateShot 只负责"跑物理、报事实"，
// resolveShot 只负责"读事实、判规则"，所以规则可以喂合成事实来测，
// 不用为了测一条犯规去构造一次真实的球路。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { createStandardRack, groupOf } from '../src/rack.js';
import {
  FOUL,
  headStringX,
  footSpotX,
  createGame,
  cloneGame,
  numbersOnTable,
  legalTargetNumbers,
  remainingOfGroup,
  simulateShot,
  resolveShot,
  spotEight,
  rerack,
  placementAllowed,
  placeCueBall,
} from '../src/rules.js';
import { createWorld } from '../src/physics.js';
import { planShot } from '../src/solver.js';

const table = createTable('pool9');
const R = table.ballRadius;

/** 造一副指定号码的球，母球放在开球线后。 */
function makeBalls(numbers, cueAt = { x: table.length * 0.25, y: table.width / 2 }) {
  const cue = createBall('cue', cueAt.x, cueAt.y, { number: 0 });
  const objs = numbers.map((n, i) =>
    createBall('b' + n, table.length * 0.5 + (i % 5) * 0.12, table.width * 0.3 + Math.floor(i / 5) * 0.12, {
      number: n,
    })
  );
  return [cue, ...objs];
}

/** 造一份 simulateShot 形状的事实。默认"干净的一杆，没进球"。 */
function makeFacts(game, spec = {}) {
  const onTableBefore = numbersOnTable(game.balls);
  const pocketed = spec.pocketed ?? [];
  const pocketedNumbers = pocketed.map((p) => p.number);
  const onTableAfter = onTableBefore.filter((n) => !pocketedNumbers.includes(n));
  const ballsAfter = game.balls.map((b) => {
    if (b.number === 0) return { ...b, vx: 0, vy: 0 };
    if (pocketedNumbers.includes(b.number)) {
      return { ...b, pocketed: true, pocket: 'c-br', vx: 0, vy: 0 };
    }
    return { ...b, pocketed: false, pocket: undefined, vx: 0, vy: 0 };
  });
  return {
    firstContact: spec.firstContact === undefined ? onTableBefore[0] : spec.firstContact,
    firstContactId: null,
    pocketed: pocketed.map((p) => ({ id: 'b' + p.number, number: p.number, pocket: p.pocket ?? 'c-br' })),
    cueScratched: spec.cueScratched ?? false,
    railsAfterContact: spec.railsAfterContact ?? ['b1'],
    objectBallsToRail: spec.objectBallsToRail ?? [1, 2, 3, 4],
    onTableBefore,
    onTableAfter,
    settled: spec.settled ?? true,
    elapsed: 1,
    events: [],
    ballsAfter,
  };
}

// ------------------------------------------------------------------ 建局

test('建局：需要一颗母球，缺了要报错', () => {
  assert.throws(() => createGame(table, [createBall('b1', 1, 1, { number: 1 })]), /母球/);
});

test('建局：默认 0 号先开球、开球状态、台面 open', () => {
  const g = createGame(table, makeBalls([1, 2, 3]));
  assert.equal(g.turn, 0);
  assert.equal(g.breakShot, true);
  assert.equal(g.open, true);
  assert.equal(g.phase, 'playing');
  assert.equal(g.players.length, 2);
  assert.equal(g.players[0].group, null);
  assert.equal(g.players[0].fouls, 0);
});

test('建局：可以指定开球方与玩家名', () => {
  const g = createGame(table, makeBalls([1, 2]), { breaker: 1, names: ['甲', '乙'] });
  assert.equal(g.turn, 1);
  assert.equal(g.players[0].name, '甲');
  assert.equal(g.players[1].name, '乙');
});

test('建局：克隆是深拷贝，改克隆不影响原局', () => {
  const g = createGame(table, makeBalls([1, 2]));
  const c = cloneGame(g);
  c.balls[1].x = 99;
  c.players[0].group = 'solid';
  c.log.push('x');
  assert.notEqual(g.balls[1].x, 99);
  assert.equal(g.players[0].group, null);
  assert.equal(g.log.length, 0);
});

test('开球线与 8 号点：分别是长边的 1/4 与 3/4 处', () => {
  assert.ok(Math.abs(headStringX(table) - table.length / 4) < 1e-9);
  assert.ok(Math.abs(footSpotX(table) - (table.length * 3) / 4) < 1e-9);
});

// ------------------------------------------------------------------ 合法目标

test('合法目标：开球时碰哪颗都行', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  assert.deepEqual(legalTargetNumbers(g, [1, 2, 8]).sort((a, b) => a - b), [1, 2, 8]);
});

test('合法目标：open 台面除 8 号外都能先碰（WPA 4.4）', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  g.breakShot = false;
  assert.deepEqual(legalTargetNumbers(g, [1, 2, 8]).sort((a, b) => a - b), [1, 2]);
});

test('合法目标：open 台面只剩 8 号时只能打 8 号', () => {
  const g = createGame(table, makeBalls([8]));
  g.breakShot = false;
  assert.deepEqual(legalTargetNumbers(g, [8]), [8]);
});

test('合法目标：分组后只能先碰本组，本组清完改打 8 号', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10, 8]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  assert.deepEqual(legalTargetNumbers(g, [1, 2, 9, 10, 8]).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(legalTargetNumbers(g, [9, 10, 8]), [8]);
});

test('合法目标：对手的球不算合法目标', () => {
  const g = createGame(table, makeBalls([1, 9]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'stripe';
  g.players[1].group = 'solid';
  assert.deepEqual(legalTargetNumbers(g, [1, 9]), [9]);
});

test('剩余球数：按组统计台面上的球', () => {
  assert.equal(remainingOfGroup([1, 2, 9, 10, 11, 8], 'solid'), 2);
  assert.equal(remainingOfGroup([1, 2, 9, 10, 11, 8], 'stripe'), 3);
  assert.equal(remainingOfGroup([8], 'solid'), 0);
});

// ------------------------------------------------------------------ 开球

test('开球：进球且不足四颗碰库也不犯规（进球即合法）', () => {
  const g = createGame(table, makeBalls([1, 2, 3, 8]));
  const facts = makeFacts(g, { pocketed: [{ number: 2 }], objectBallsToRail: [] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, false);
  assert.equal(report.continuing, true, '开球进球应续杆');
  assert.equal(next.turn, 0);
});

test('开球：没进球但四颗碰库 → 合法，换人', () => {
  const g = createGame(table, makeBalls([1, 2, 3, 4, 8]));
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3, 4] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, false);
  assert.equal(report.continuing, false);
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand, null);
});

test('开球：没进球且碰库不足四颗 → 不合法开球（WPA 4.3d），对手重摆', () => {
  const g = createGame(table, makeBalls([1, 2, 3, 8]));
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === FOUL.ILLEGAL_BREAK));
  assert.equal(next.turn, 1);
  assert.equal(next.requiresRerack, true);
  assert.equal(next.ballInHand, null, '重摆这一项不给持球');
});

test('开球：母球落袋 → 犯规，对手在开球线后持球', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  const facts = makeFacts(g, { pocketed: [{ number: 0 }], cueScratched: true });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === FOUL.SCRATCH));
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand.zone, 'kitchen');
});

test('开球：打进 8 号球不算输，重摆回 8 号点（WPA 4.3e）', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  const facts = makeFacts(g, { pocketed: [{ number: 8 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.ended, false);
  assert.equal(next.phase, 'playing');
  assert.equal(report.spotted, 8);
  const eight = next.balls.find((b) => b.number === 8);
  assert.equal(eight.pocketed, false, '8 号球应回到台面');
  assert.ok(Math.abs(eight.x - footSpotX(table)) < 1e-6, '应摆在 8 号点');
  assert.ok(Math.abs(eight.y - table.width / 2) < 1e-6);
  assert.equal(report.pocketed.some((p) => p.number === 8), false, '重摆的 8 号不该算进袋');
});

test('开球：进 8 号球本身就算有球进袋，不构成不合法开球（WPA 4.3d）', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  const facts = makeFacts(g, { pocketed: [{ number: 8 }], objectBallsToRail: [] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.spotted, 8);
  assert.equal(report.fouled, false, '8 号球也是目标球，进袋即满足开球合法性');
  assert.equal(next.requiresRerack, false);
  assert.equal(report.ended, false);
});

test('开球：犯规同时进 8 号 → 8 号重摆，对手开球线后持球（WPA 4.3f）', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  const facts = makeFacts(g, { pocketed: [{ number: 8 }, { number: 0 }], cueScratched: true });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.spotted, 8);
  assert.equal(report.ended, false, '开球进 8 号永远不判胜负');
  assert.ok(report.fouls.some((f) => f.code === FOUL.SCRATCH));
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand.zone, 'kitchen');
});

// ------------------------------------------------------------------ 普通杆的犯规

test('犯规：母球先碰到对方的球（WPA 3.2）', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 9 });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === FOUL.WRONG_BALL_FIRST));
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand.zone, 'anywhere');
});

test('犯规：open 台面先碰 8 号球（WPA 4.4）', () => {
  const g = createGame(table, makeBalls([1, 2, 8]));
  g.breakShot = false;
  const facts = makeFacts(g, { firstContact: 8 });
  const { report } = resolveShot(g, facts);
  assert.ok(report.fouls.some((f) => f.code === FOUL.WRONG_BALL_FIRST));
});

test('犯规：母球什么都没碰到（WPA 3.2）', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const facts = makeFacts(g, { firstContact: null, railsAfterContact: [] });
  const { report } = resolveShot(g, facts);
  assert.ok(report.fouls.some((f) => f.code === FOUL.NO_CONTACT));
});

test('犯规：碰球后没有球碰库也没有球进袋（WPA 3.3）', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const facts = makeFacts(g, { railsAfterContact: [], pocketed: [] });
  const { report } = resolveShot(g, facts);
  assert.ok(report.fouls.some((f) => f.code === FOUL.NO_RAIL));
});

test('不犯规：碰球后有球碰库就算合法，哪怕没进球', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const facts = makeFacts(g, { railsAfterContact: ['b1'], pocketed: [] });
  const { report } = resolveShot(g, facts);
  assert.equal(report.fouled, false);
});

test('不犯规：碰球后母球直接进袋——算母球落袋犯规，不是无库边', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const facts = makeFacts(g, { pocketed: [{ number: 0 }], cueScratched: true, railsAfterContact: [] });
  const { report } = resolveShot(g, facts);
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === FOUL.SCRATCH));
  assert.equal(report.fouls.some((f) => f.code === FOUL.NO_RAIL), false, '进袋算驱向库边，不该再判无库边');
});

test('犯规：一次可以同时犯好几条，全部列出', () => {
  const g = createGame(table, makeBalls([1, 9]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 9, railsAfterContact: [], pocketed: [{ number: 0 }], cueScratched: true });
  const { report } = resolveShot(g, facts);
  const codes = report.fouls.map((f) => f.code);
  assert.ok(codes.includes(FOUL.SCRATCH));
  assert.ok(codes.includes(FOUL.WRONG_BALL_FIRST));
});

// ------------------------------------------------------------------ 续杆与分组

test('续杆：打进本组的球继续打', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { pocketed: [{ number: 1 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.continuing, true);
  assert.equal(next.turn, 0);
  assert.equal(next.ballInHand, null);
});

test('续杆：打进对方的球不续杆，但也不算犯规', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { pocketed: [{ number: 9 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.fouled, false);
  assert.equal(report.continuing, false);
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand, null);
});

test('分组：open 台面打进全色球就分到全色，对手拿花色', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  const facts = makeFacts(g, { firstContact: 1, pocketed: [{ number: 1 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.groupAssigned.group, 'solid');
  assert.equal(next.players[0].group, 'solid');
  assert.equal(next.players[1].group, 'stripe');
  assert.equal(next.open, false);
  assert.equal(report.continuing, true);
});

test('分组：一杆进两组时按母球先碰到的那颗算（IEPF 6a）', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  const facts = makeFacts(g, {
    firstContact: 9,
    pocketed: [{ number: 1 }, { number: 9 }],
  });
  const { next } = resolveShot(g, facts);
  assert.equal(next.players[0].group, 'stripe', '先碰到 9 号，应分到花色');
  assert.equal(next.players[1].group, 'solid');
});

test('分组：犯规的一杆即使进球也不分组', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  const facts = makeFacts(g, {
    firstContact: 9,
    pocketed: [{ number: 1 }, { number: 0 }],
    cueScratched: true,
  });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.groupAssigned, null);
  assert.equal(next.open, true);
  assert.equal(next.players[0].group, null);
});

test('分组：开球那一杆永远不分组（WPA 4.3/4.4）', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  const facts = makeFacts(g, { pocketed: [{ number: 1 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.groupAssigned, null);
  assert.equal(next.open, true);
});

// ------------------------------------------------------------------ 8 号球与胜负

test('8 号球：清完本组后合法打进 → 赢下这一局', () => {
  const g = createGame(table, makeBalls([8, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 8, pocketed: [{ number: 8 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.ended, true);
  assert.equal(next.phase, 'ended');
  assert.equal(next.winner, 0);
});

test('8 号球：本组没清完就打进 → 判负（WPA 4.8）', () => {
  const g = createGame(table, makeBalls([1, 8, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 8, pocketed: [{ number: 8 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.ended, true);
  assert.equal(next.winner, 1);
});

test('8 号球：清完本组但同一杆犯规 → 判负（WPA 4.8）', () => {
  const g = createGame(table, makeBalls([8, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 8, pocketed: [{ number: 8 }, { number: 0 }], cueScratched: true });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.ended, true);
  assert.equal(next.winner, 1);
});

test('8 号球：与最后一颗本组球同杆进袋 → 判负（WPA 4.8）', () => {
  const g = createGame(table, makeBalls([1, 8, 9]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const facts = makeFacts(g, { firstContact: 1, pocketed: [{ number: 1 }, { number: 8 }] });
  const { next, report } = resolveShot(g, facts);
  assert.equal(report.ended, true);
  assert.equal(next.winner, 1, '最后一颗本组球同杆进 8 号，判负');
});

test('连续犯规：黑八只记账、不判负（WPA 3.13 原文排除 8-Ball）', () => {
  const g = createGame(table, makeBalls([1, 2, 9]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';

  let cur = g;
  // 0 号玩家连续三杆犯规，中间夹两次换手（对手打干净的、不进球的球把台面交回来）
  const legalNoPocket = (c) => resolveShot(c, makeFacts(c, { pocketed: [] })).next;

  let r = resolveShot(cur, makeFacts(cur, { firstContact: 9 }));
  assert.equal(r.report.fouled, true);
  assert.equal(r.next.players[0].fouls, 1);
  assert.equal(r.report.ended, false);

  cur = legalNoPocket(r.next);
  r = resolveShot(cur, makeFacts(cur, { firstContact: 9 }));
  assert.equal(r.next.players[0].fouls, 2);

  cur = legalNoPocket(r.next);
  r = resolveShot(cur, makeFacts(cur, { firstContact: 9 }));
  assert.equal(r.next.players[0].fouls, 3, '计数照样在涨');
  assert.equal(r.report.ended, false, '黑八不吃三犯这条（3.13 排除 8-Ball）');
  assert.doesNotMatch(r.report.summary, /连续三次犯规/);
});

test('连续犯规：中间打一杆合法的就清零', () => {
  const g = createGame(table, makeBalls([1, 2, 9, 10]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const bad = resolveShot(g, makeFacts(g, { firstContact: 9 }));
  assert.equal(bad.next.players[0].fouls, 1);
  // 换到 1 号玩家，打一杆合法
  const good = resolveShot(bad.next, makeFacts(bad.next, { firstContact: 10, pocketed: [{ number: 10 }] }));
  assert.equal(good.next.players[1].fouls, 0);
  // 回到 0 号玩家，犯规一次后应为 1 而不是 2
  const again = resolveShot(good.next, makeFacts(good.next, { firstContact: 9 }));
  assert.equal(again.next.players[0].fouls, 1, '中间那杆合法应清零');
});

// ------------------------------------------------------------------ 状态推进

test('回合：不续杆就换人，且不持球', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const { next, report } = resolveShot(g, makeFacts(g, { pocketed: [] }));
  assert.equal(report.continuing, false);
  assert.equal(next.turn, 1);
  assert.equal(next.ballInHand, null);
});

test('回合：开球状态在一杆之后必然结束', () => {
  const g = createGame(table, makeBalls([1, 2]));
  assert.equal(g.breakShot, true);
  const { next } = resolveShot(g, makeFacts(g, { pocketed: [{ number: 1 }] }));
  assert.equal(next.breakShot, false);
});

test('回合：局结束后不再换人、不再给持球', () => {
  const g = createGame(table, makeBalls([8]));
  g.breakShot = false;
  g.open = false;
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  const { next } = resolveShot(g, makeFacts(g, { firstContact: 8, pocketed: [{ number: 8 }] }));
  assert.equal(next.phase, 'ended');
  assert.equal(next.turn, 0);
  assert.equal(next.ballInHand, null);
});

test('回合：一杆没停稳时结果里必须标出来，不能装作正常结束', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const ok = resolveShot(g, makeFacts(g, { pocketed: [] }));
  assert.equal(ok.report.unsettled, false, '正常停稳的一杆不该标 unsettled');
  assert.doesNotMatch(ok.report.summary, /停稳/);

  const bad = resolveShot(g, makeFacts(g, { pocketed: [], settled: false }));
  assert.equal(bad.report.unsettled, true, '跑满限时没停稳必须标出来');
  assert.match(bad.report.summary, /停稳/, '播报里要说明结果按超时那一刻的球位算');
  // 规则照常结算，不能因为没停稳就卡住对局
  assert.equal(bad.next.turn, 1);
  assert.equal(bad.next.shots, 1);
});

test('回合：每杆都进日志，日志条数等于杆数', () => {
  let g = createGame(table, makeBalls([1, 2, 9]));
  g.breakShot = false;
  for (let i = 0; i < 3; i++) {
    const r = resolveShot(g, makeFacts(g, { pocketed: [] }));
    g = r.next;
  }
  assert.equal(g.shots, 3);
  assert.equal(g.log.length, 3);
  assert.equal(g.log[0].shot, 1);
});

test('回合：结算不修改传入的 game', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.breakShot = false;
  const before = JSON.stringify(g);
  resolveShot(g, makeFacts(g, { pocketed: [{ number: 1 }] }));
  assert.equal(JSON.stringify(g), before);
});

// ------------------------------------------------------------------ 重摆与持球

test('重摆：换对手开球，分组与犯规计数清零', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.players[0].group = 'solid';
  g.players[1].group = 'stripe';
  g.players[0].fouls = 2;
  g.breakShot = false;
  g.open = false;
  const balls = createStandardRack(table, { seed: 1 }).map((b) => createBall(b.id, b.x, b.y, b));
  rerack(g, balls);
  assert.equal(g.turn, 1);
  assert.equal(g.breakShot, true);
  assert.equal(g.open, true);
  assert.equal(g.players[0].group, null);
  assert.equal(g.players[1].group, null);
  assert.equal(g.players[0].fouls, 0);
  assert.equal(g.balls.length, 16);
});

test('持球：没有持球状态时随便放', () => {
  const g = createGame(table, makeBalls([1, 2]));
  assert.equal(placementAllowed(g, 0.1, 0.1), true);
  assert.equal(placementAllowed(g, 99, 99), true);
});

test('持球：开球线后持球时不能越过开球线', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.ballInHand = { zone: 'kitchen' };
  const hs = headStringX(table);
  assert.equal(placementAllowed(g, hs - 0.01, table.width / 2), true);
  assert.equal(placementAllowed(g, hs + 0.01, table.width / 2), false);
});

test('持球：任意位置持球时仍然不能出台面', () => {
  const g = createGame(table, makeBalls([1, 2]));
  g.ballInHand = { zone: 'anywhere' };
  assert.equal(placementAllowed(g, table.width / 2, table.width / 2), true);
  assert.equal(placementAllowed(g, -1, 0.5), false);
  assert.equal(placementAllowed(g, table.length + 1, 0.5), false);
});

test('摆母球：放在被占的位置会被挪开且不重叠', () => {
  const g = createGame(table, makeBalls([1], { x: 1.0, y: 0.6 }));
  const other = g.balls.find((b) => b.number === 1);
  other.x = 1.0;
  other.y = 0.6;
  assert.equal(placeCueBall(g, 1.0, 0.6), true);
  const cue = g.balls.find((b) => b.number === 0);
  const d = Math.hypot(cue.x - other.x, cue.y - other.y);
  assert.ok(d >= 2 * R - 1e-9, `母球与 1 号球间距 ${d}，应 >= ${2 * R}`);
});

test('摆母球：落袋的母球会被放回台面', () => {
  const g = createGame(table, makeBalls([1]));
  const cue = g.balls.find((b) => b.number === 0);
  cue.pocketed = true;
  cue.pocket = 'c-br';
  assert.equal(placeCueBall(g, 0.5, 0.5), true);
  assert.equal(cue.pocketed, false);
  assert.equal(cue.pocket, undefined);
});

test('重摆 8 号球：8 号点被占时沿长边找空位', () => {
  const g = createGame(table, makeBalls([1, 8]));
  const one = g.balls.find((b) => b.number === 1);
  one.x = footSpotX(table);
  one.y = table.width / 2;
  one.pocketed = false;
  const eight = g.balls.find((b) => b.number === 8);
  eight.pocketed = true;
  assert.equal(spotEight(g), true);
  assert.equal(eight.pocketed, false);
  const d = Math.hypot(eight.x - one.x, eight.y - one.y);
  assert.ok(d >= 2 * R - 1e-9, `重摆位置与 1 号球间距 ${d}`);
});

// ------------------------------------------------------------------ 真实物理

test('仿真：标准摆球开球能跑完、不产生 NaN、球不出界', () => {
  const balls = createStandardRack(table, { seed: 3 }).map((b) => createBall(b.id, b.x, b.y, b));
  const cue = balls.find((b) => b.number === 0);
  const apex = balls.find((b) => b.number === 1);
  const angle = Math.atan2(apex.y - cue.y, apex.x - cue.x);
  const facts = simulateShot(table, balls, { angle, speed: 6.6, tip: { a: 0, b: -0.15 } });

  assert.equal(facts.settled, true, '一杆必须停稳');
  assert.ok(facts.elapsed < 26);
  for (const b of facts.ballsAfter) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), `${b.id} 坐标出现 NaN`);
    if (!b.pocketed) {
      assert.ok(b.x >= -0.1 && b.x <= table.length + 0.1, `${b.id} x 跑出界`);
      assert.ok(b.y >= -0.1 && b.y <= table.width + 0.1, `${b.id} y 跑出界`);
    }
  }
});

test('仿真：开球一定先碰到 1 号球（顶点球）', () => {
  const balls = createStandardRack(table, { seed: 3 }).map((b) => createBall(b.id, b.x, b.y, b));
  const cue = balls.find((b) => b.number === 0);
  const apex = balls.find((b) => b.number === 1);
  const angle = Math.atan2(apex.y - cue.y, apex.x - cue.x);
  const facts = simulateShot(table, balls, { angle, speed: 6.6 });
  assert.equal(facts.firstContact, 1);
});

test('仿真：不改传入的球', () => {
  const balls = makeBalls([1, 2]);
  const before = JSON.stringify(balls);
  const cue = balls.find((b) => b.number === 0);
  const target = balls.find((b) => b.number === 1);
  const angle = Math.atan2(target.y - cue.y, target.x - cue.x);
  simulateShot(table, balls, { angle, speed: 3.6 });
  assert.equal(JSON.stringify(balls), before);
});

test('仿真：母球直接打进袋会被记成 cueScratched', () => {
  const cue = createBall('cue', table.length * 0.5, table.width * 0.5, { number: 0 });
  const balls = [cue];
  const pocket = table.pockets.find((p) => p.id === 'c-br');
  const angle = Math.atan2(pocket.y - cue.y, pocket.x - cue.x);
  const facts = simulateShot(table, balls, { angle, speed: 2.2 });
  assert.equal(facts.cueScratched, true);
  assert.ok(facts.pocketed.some((p) => p.number === 0));
});

test('仿真：母球已落袋时拒绝击球', () => {
  const cue = createBall('cue', 1, 0.6, { number: 0, pocketed: true });
  assert.throws(() => simulateShot(table, [cue], { angle: 0, speed: 2 }), /母球已落袋/);
});

test('仿真：一杆清掉单颗球时 onTableAfter 正确少一颗', () => {
  const cue = createBall('cue', 1.2, table.width / 2, { number: 0 });
  const target = createBall('b1', 1.8, table.width / 2, { number: 1 });
  const pocket = table.pockets.find((p) => p.id === 'c-br');
  // 目标球正对右下底袋
  const dx = pocket.x - target.x;
  const dy = pocket.y - target.y;
  const ghost = { x: target.x - (dx / Math.hypot(dx, dy)) * 2 * R, y: target.y - (dy / Math.hypot(dx, dy)) * 2 * R };
  const angle = Math.atan2(ghost.y - cue.y, ghost.x - cue.x);
  const facts = simulateShot(table, [cue, target], { angle, speed: 2.2 });
  assert.deepEqual(facts.onTableBefore, [1]);
  assert.deepEqual(facts.onTableAfter, []);
  assert.ok(facts.pocketed.some((p) => p.number === 1));
});

test('整局：开球 → 续杆 → 打进 8 号球结束，全程无异常', () => {
  const balls = createStandardRack(table, { seed: 3 }).map((b) => createBall(b.id, b.x, b.y, b));
  let game = createGame(table, balls);
  const cue = () => game.balls.find((b) => b.number === 0);

  // 开球
  const apex = game.balls.find((b) => b.number === 1);
  const angle = Math.atan2(apex.y - cue().y, apex.x - cue().x);
  const breakFacts = simulateShot(table, game.balls, { angle, speed: 6.6, tip: { a: 0, b: -0.15 } });
  let r = resolveShot(game, breakFacts);
  game = r.next;
  assert.equal(game.breakShot, false);
  assert.equal(game.phase, 'playing');

  // 强制进入"我方全色、只剩 8 号"的局面，验证收尾
  game.players[0].group = 'solid';
  game.players[1].group = 'stripe';
  game.open = false;
  game.turn = 0;
  game.balls = game.balls.filter((b) => b.number === 0 || b.number === 8);
  const cueBall = game.balls.find((b) => b.number === 0);
  const eight = game.balls.find((b) => b.number === 8);
  cueBall.x = 1.0;
  cueBall.y = table.width / 2;
  cueBall.pocketed = false;
  eight.x = 1.5;
  eight.y = table.width / 2;
  eight.pocketed = false;
  eight.pocket = undefined;

  const p = table.pockets.find((pk) => pk.id === 'c-br');
  const dx = p.x - eight.x;
  const dy = p.y - eight.y;
  const len = Math.hypot(dx, dy);
  const ghost = { x: eight.x - (dx / len) * 2 * R, y: eight.y - (dy / len) * 2 * R };
  const shotAngle = Math.atan2(ghost.y - cueBall.y, ghost.x - cueBall.x);
  const facts = simulateShot(table, game.balls, { angle: shotAngle, speed: 2.2 });
  r = resolveShot(game, facts);
  // 这一杆必须真的把 8 号球打进——摆位是算好的，打不进说明物理或瞄准有回归，
  // 不能像原来那样写成 if (进了) { 断言 }，否则打不进时这条测试静默通过。
  assert.ok(
    facts.pocketed.some((pk) => pk.number === 8),
    `这一杆应该打进 8 号球，实际进袋：${facts.pocketed.map((p) => p.number).join(',') || '无'}`
  );
  assert.equal(r.next.phase, 'ended');
  assert.equal(r.next.winner, 0);
  assert.match(r.report.summary, /获胜/);
});

test('整局：求解器自己跟自己打，能真的打到分出胜负', () => {
  // 这是唯一一条覆盖"一整局"的测试：从标准摆球开始，每一杆都由 solver 选，
  // 一直打到 phase === 'ended'。它同时钉住三件事——
  //   1. 规则引擎不会卡在某个中间状态（例如持球后永远没人能打）；
  //   2. 求解器在任意残局下都选得出杆（进攻或兜底）；
  //   3. 一局真的会结束，而不是无限对拉。
  // 用固定 seed，所以结果可复现。
  for (const seed of [1, 7, 42]) {
    const balls = createStandardRack(table, { seed }).map((b) => createBall(b.id, b.x, b.y, b));
    createWorld(table, balls);
    let game = createGame(table, balls, { names: ['A', 'B'] });

    let shots = 0;
    while (game.phase !== 'ended' && shots < 300) {
      if (game.ballInHand) {
        const spot =
          game.ballInHand.zone === 'kitchen'
            ? { x: table.length * 0.12, y: table.width / 2 }
            : { x: table.length * 0.5, y: table.width / 2 };
        placeCueBall(game, spot.x, spot.y);
      }
      const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
      const { plan } = planShot(table, game, { allow });
      assert.ok(plan, `seed ${seed} 第 ${shots + 1} 杆选不出方案`);
      const facts = simulateShot(table, game.balls, {
        angle: plan.aimAngle,
        speed: plan.speed,
        tip: plan.tip,
      });
      game = resolveShot(game, facts).next;
      shots += 1;
    }

    assert.equal(game.phase, 'ended', `seed ${seed} 打了 ${shots} 杆还没结束`);
    assert.ok([0, 1].includes(game.winner), `seed ${seed} 赢家应是 0 或 1，实际 ${game.winner}`);
    assert.equal(game.log.length, shots, '日志条数应等于杆数');
    // 结束时台面上除了母球不该还有别的球（8 号已进袋，其余清完或判负提前结束）
    assert.ok(shots >= 5 && shots <= 60, `seed ${seed} 杆数 ${shots} 超出合理范围`);
  }
});

test('整局：撤销一杆能回到完全一样的局面（演示页的撤销靠这个）', () => {
  // 演示页的撤销不是"重放一遍反着算"，而是每杆结算前 cloneGame 存一份快照。
  // 快照能不能真的回到原样，是这个功能成立的前提，所以在这里钉住：
  // 打完一杆 → 存快照 → 结算 → 用快照顶回去 → 局面必须逐字段等于打之前。
  const balls = createStandardRack(table, { seed: 5 }).map((b) => createBall(b.id, b.x, b.y, b));
  createWorld(table, balls);
  let game = createGame(table, balls, { names: ['A', 'B'] });

  // 先打一杆开球，让局面离开初始状态（分组、球位都变了），撤销才有意义
  const allow0 = legalTargetNumbers(game, numbersOnTable(game.balls));
  const { plan: p0 } = planShot(table, game, { allow: allow0 });
  game = resolveShot(game, simulateShot(table, game.balls, { angle: p0.aimAngle, speed: p0.speed, tip: p0.tip })).next;
  assert.ok(game.shots >= 1);

  const snapshot = cloneGame(game);
  const frozen = JSON.stringify(snapshot);

  if (game.ballInHand) placeCueBall(game, table.length * 0.5, table.width / 2);
  const allow1 = legalTargetNumbers(game, numbersOnTable(game.balls));
  const { plan: p1 } = planShot(table, game, { allow: allow1 });
  const after = resolveShot(game, simulateShot(table, game.balls, { angle: p1.aimAngle, speed: p1.speed, tip: p1.tip })).next;
  assert.ok(after.shots > snapshot.shots, '这一杆应该推进一步');

  // 撤销：拿快照顶回去，必须和存快照那一刻一模一样
  assert.equal(JSON.stringify(snapshot), frozen, '存下来的快照被后续结算改动了');
  assert.equal(snapshot.shots, game.shots, '撤销后的杆数应回到打之前');
  assert.notEqual(JSON.stringify(after), frozen, '打进这一杆之后的局面应该和快照不同');
  // 快照是深拷贝：改快照不能改到 after
  snapshot.balls[0].x += 1;
  assert.notEqual(after.balls[0].x, snapshot.balls[0].x, 'cloneGame 必须是深拷贝');
});

test('整局：三种球台预设都能从开球打到第一次换人', () => {
  // demo 的换台下拉把 pool8 / snooker 暴露出来了，这两张台以前从没跑过整局。
  // 这里逐张真打一杆开球 + 一杆普通球，钉住"换台不会把物理或规则跑崩"。
  for (const preset of ['pool9', 'pool8', 'snooker']) {
    const t = createTable(preset);
    const balls = createStandardRack(t, { seed: 11 }).map((b) => createBall(b.id, b.x, b.y, b));
    createWorld(t, balls);
    let game = createGame(t, balls, { names: ['A', 'B'] });

    const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
    const { kind, plan } = planShot(t, game, { allow });
    assert.equal(kind, 'break', `${preset}: 开局第一杆应是开球`);
    const facts = simulateShot(t, game.balls, { angle: plan.aimAngle, speed: plan.speed, tip: plan.tip });
    assert.equal(facts.settled, true, `${preset}: 开球必须停稳`);
    for (const b of facts.ballsAfter) {
      if (b.pocketed) continue;
      assert.ok(t.insideBounds(b.x, b.y, 0.05), `${preset}: ${b.id} 跑出台面`);
    }
    game = resolveShot(game, facts).next;
    assert.equal(game.breakShot, false, `${preset}: 开球状态应已结束`);
    assert.ok(game.ballInHand === null || game.ballInHand.zone, `${preset}: 持球状态非法`);
  }
});

