// 九球报告的「续杆标志」一致性。
//
// 报告里 `continuing` 与 `next.turn` 说的是同一件事：这一杆之后谁打。
// turn 已经换了人、报告还写「继续」，摘要就会拼出「玩家 1 继续」这种自相矛盾的话。
// Reg.16 的三球过线不达标不判犯规，但球权确实交给了接手方，所以这条也属于
// 「换了人就不能说继续」的范围。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall, createWorld } from '../src/physics.js';
import {
  ILLEGAL_BREAK_NOTICE,
  createGame,
  headStringX,
  numbersOnTable,
  resolveShot,
} from '../src/rules.js';

const table = createTable('pool9');

/** 造一副指定号码的球，母球放在开球线后。 */
function makeBalls(numbers) {
  const cue = createBall('cue', table.length * 0.2, table.width / 2, { number: 0 });
  const objs = numbers.map((n, i) =>
    createBall(
      'b' + n,
      table.length * 0.5 + (i % 5) * 0.14,
      table.width * 0.3 + Math.floor(i / 5) * 0.14,
      { number: n }
    )
  );
  return [cue, ...objs];
}

/** 建一局九球，并且停在「没开球」的状态（breakShot 默认 true，这里按需还原）。 */
function makeNine(numbers, opts = {}) {
  const balls = makeBalls(numbers);
  createWorld(table, balls);
  const g = createGame(table, balls, { kind: 'nineball' });
  if (opts.breakShot !== true) g.breakShot = false;
  return g;
}

/** 造一份 simulateShot 形状的事实。 */
function makeFacts(game, spec = {}) {
  const onTableBefore = numbersOnTable(game.balls);
  const pocketed = spec.pocketed ?? [];
  const pocketedNumbers = pocketed.map((p) => p.number);
  const onTableAfter = onTableBefore.filter((n) => !pocketedNumbers.includes(n));
  let ballsAfter = game.balls.map((b) => {
    if (b.number === 0) return { ...b, vx: 0, vy: 0 };
    if (pocketedNumbers.includes(b.number)) return { ...b, pocketed: true, pocket: 'c-br', vx: 0, vy: 0 };
    return { ...b, pocketed: false, pocket: undefined, vx: 0, vy: 0 };
  });
  if (spec.ballX) {
    // ballX：{ 号码: x } —— 用来把某些球摆到开球线前/后，控制「过线几颗」
    ballsAfter = ballsAfter.map((b) =>
      spec.ballX[b.number] === undefined ? b : { ...b, x: spec.ballX[b.number] }
    );
  }
  return {
    firstContact: spec.firstContact === undefined ? Math.min(...onTableBefore) : spec.firstContact,
    firstContactId: null,
    pocketed: pocketed.map((p) => ({ id: 'b' + p.number, number: p.number, pocket: p.pocket ?? 'c-br' })),
    cueScratched: spec.cueScratched ?? false,
    railsAfterContact: spec.railsAfterContact ?? ['cue'],
    objectBallsToRail: spec.objectBallsToRail ?? [1, 2, 3, 4],
    onTableBefore,
    onTableAfter,
    settled: true,
    elapsed: 1,
    events: [],
    ballsAfter,
  };
}

test('九球开球：三球过线不达标时不能报告「继续」，turn 与 continuing 必须一致', () => {
  const g = makeNine([1, 3, 4, 5, 9], { breakShot: true });
  const line = headStringX(table);
  // 只进了 3 号一颗，其余全部停在开球线之后（x 更大的一侧）→ 合计 1 颗，不达标
  const facts = makeFacts(g, {
    pocketed: [{ number: 3 }],
    objectBallsToRail: [3],
    ballX: { 1: table.length * 0.7, 4: table.length * 0.7, 5: table.length * 0.7, 9: table.length * 0.7 },
  });
  const { next, report } = resolveShot(g, facts);

  assert.equal(report.fouled, false, 'Reg.16 的三球过线不达标不是犯规');
  assert.equal(report.pendingChoice?.kind, ILLEGAL_BREAK_NOTICE);
  assert.equal(report.pendingChoice?.player, 1, '选择权在接手方');
  assert.equal(next.turn, 1, '球权已经交给对手');
  assert.equal(report.continuing, false, '换手了就不能说「继续」');
  assert.ok(!report.summary.includes('继续'), `摘要不许出现「继续」：${report.summary}`);
  assert.match(report.summary, /换 玩家 2/, `摘要要如实说换了人：${report.summary}`);
  assert.ok(line > 0, '开球线位置由 headStringX 给出');
});

test('九球开球：达标且进球时仍然由原开球方继续（continuing 不能一刀切成 false）', () => {
  const g = makeNine([1, 2, 3, 4, 9], { breakShot: true });
  const line = headStringX(table);
  // 进 1 号一颗 + 另外两颗过线 = 3 颗，开球达标
  const facts = makeFacts(g, {
    pocketed: [{ number: 1 }],
    objectBallsToRail: [1, 2, 3, 4],
    ballX: {
      2: line * 0.5,
      3: line * 0.5,
      4: table.length * 0.7,
      9: table.length * 0.7,
    },
  });
  const { next, report } = resolveShot(g, facts);

  assert.equal(report.pendingChoice, null, '达标了就没有选择权这回事');
  assert.equal(report.continuing, true);
  assert.equal(next.turn, 0, '开球方接着打');
  assert.match(report.summary, /继续/);
});

test('九球普通一杆：进球继续、不进球换手，报告与 turn 都不许打架', () => {
  const g = makeNine([1, 2, 4, 9]);
  const potted = resolveShot(g, makeFacts(g, { pocketed: [{ number: 1 }] }));
  assert.equal(potted.report.continuing, true);
  assert.equal(potted.next.turn, 0);

  const dry = resolveShot(g, makeFacts(g, { pocketed: [] }));
  assert.equal(dry.report.continuing, false);
  assert.equal(dry.next.turn, 1);
  assert.ok(!dry.report.summary.includes('继续'), dry.report.summary);
});