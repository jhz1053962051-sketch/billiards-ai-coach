// 八球 / 九球共享实现的回归护栏。
//
// 这两条路径的前奏与收尾现在共用 beginShot / settleShot，差异只由 7 个参数表达。
// 危险点在于：以后谁只改一边（比如给八球加一条犯规、改一下交轮条件），
// 逻辑上"看起来只影响八球"，实际改的却是两条玩法共用的那段代码。
//
// 所以这里的断言不是"某条规则对不对"（那由 rules.test.js / nineball.test.js 负责），
// 而是：**同一份输入喂给两条路径，除了明确允许不同的字段，其余必须逐字段完全相同**。
// 把某个字段加进 allow 之前，先想清楚两种玩法在这件事上是否真的应该不同。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall } from '../src/physics.js';
import { numbersOnTable, createGame, resolveShot } from '../src/rules.js';

const table = createTable('pool9');

/** 造一副指定号码的球：母球在开球线后，目标球都摆在开球线前方。 */
function makeBalls(numbers) {
  const cue = createBall('cue', table.length * 0.25, table.width / 2, { number: 0 });
  const objs = numbers.map((n, i) =>
    createBall('b' + n, table.length * 0.5 + (i % 5) * 0.12, table.width * 0.3 + Math.floor(i / 5) * 0.12, {
      number: n,
    })
  );
  return [cue, ...objs];
}

/** 造一份 simulateShot 形状的事实。默认"干净的一杆，没进球、有碰库"。 */
function makeFacts(game, spec = {}) {
  const onTableBefore = numbersOnTable(game.balls);
  const pocketed = spec.pocketed ?? [];
  const pocketedNumbers = pocketed.map((p) => p.number);
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
    onTableAfter: onTableBefore.filter((n) => !pocketedNumbers.includes(n)),
    settled: spec.settled ?? true,
    elapsed: 1,
    events: [],
    ballsAfter,
  };
}

/**
 * 同一份输入走两条路径。球号一一对应（八球 8 号 ↔ 九球 9 号），几何完全相同。
 * spec 可以是对象，也可以是 (numbers) => 对象——后者用来让同一句"先碰最高号球"
 * 在八球里是 8 号、在九球里是 9 号。
 */
function playBoth(eightNumbers, nineNumbers, spec, opts = {}) {
  const eight = createGame(table, makeBalls(eightNumbers), { kind: 'eightball' });
  const nine = createGame(table, makeBalls(nineNumbers), { kind: 'nineball' });
  for (const g of [eight, nine]) {
    if (opts.turn !== undefined) g.turn = opts.turn;
    if (opts.breakShot === false) g.breakShot = false;
  }
  const spec8 = typeof spec === 'function' ? spec(eightNumbers) : spec;
  const spec9 = typeof spec === 'function' ? spec(nineNumbers) : spec;
  return [resolveShot(eight, makeFacts(eight, spec8)), resolveShot(nine, makeFacts(nine, spec9))];
}

// 默认允许不同的字段：都是"两种玩法本来就不同、且已经由参数显式表达"的字段。
//   pendingChoice 九球 report 才有这个通道（extraReport 参数）
//   spotted       重摆回去的球，八球只可能是 8、九球只可能是 9
//   notes/summary 文案里带玩法名与球号，本来就不该逐字一致
const BASE_ALLOW = ['pendingChoice', 'spotted', 'notes', 'summary'];

const NEXT_FIELDS = [
  'turn',
  'ballInHand',
  'requiresRerack',
  'phase',
  'winner',
  'shots',
  'breakShot',
  'open',
  'pendingChoice',
  'players',
];

// 台面球号一一对应：八球的 8 号球在九球里就是 9 号，比较前统一成一个占位符。
const LAST = 'LAST';
function normalizeNumbers(list, lastNumber) {
  return list.map((n) => (n === lastNumber ? LAST : n)).sort((x, y) => (x === LAST ? 1 : y === LAST ? -1 : x - y));
}

function assertSame(name, [a, b], allow = []) {
  const skip = [...BASE_ALLOW, ...allow];
  for (const f of NEXT_FIELDS) {
    if (skip.includes(f)) continue;
    assert.deepEqual(a.next[f], b.next[f], `${name}: next.${f} 两条玩法不一致`);
  }
  const ra = { ...a.report };
  const rb = { ...b.report };
  for (const f of skip) {
    delete ra[f];
    delete rb[f];
  }
  assert.deepEqual(ra, rb, `${name}: report 除允许字段外必须完全一致`);
  assert.deepEqual(
    normalizeNumbers(numbersOnTable(a.next.balls), 8),
    normalizeNumbers(numbersOnTable(b.next.balls), 9),
    `${name}: 台面剩余球不一致`
  );
  assert.equal(a.next.log.length, b.next.log.length, `${name}: 日志条数不一致`);
}

test('护栏：非开球的一杆，两条路径的状态推进逐字段一致', () => {
  // 干净一杆：先碰对球、有碰库、没进球 → 两边都换人、都不给持球
  assertSame('干净一杆', playBoth([1, 2, 8], [1, 2, 9], {}, { breakShot: false }));
  // 母球落袋：两边都是"任何位置自由球"
  assertSame(
    '母球落袋',
    playBoth([1, 2, 8], [1, 2, 9], { pocketed: [{ number: 0 }], cueScratched: true }, { breakShot: false })
  );
  // 空杆：两边都是 NO_CONTACT
  assertSame(
    '空杆',
    playBoth([1, 2, 8], [1, 2, 9], { firstContact: null, railsAfterContact: [] }, { breakShot: false })
  );
  // 先碰最高号球：八球是"先碰 8 号"、九球是"没先碰最小号"，犯规代码必须一样。
  // 输入里那颗球本身的号码就不同（8 vs 9），所以 report.firstContact 必然不同——
  // 但"判成 wrong_ball_first"这件事两边必须一致。
  const wrong = playBoth([1, 2, 8], [1, 2, 9], (nums) => ({ firstContact: nums[nums.length - 1] }), {
    breakShot: false,
  });
  assertSame('先碰错球', wrong, ['firstContact']);
  for (const r of wrong) {
    assert.deepEqual(
      r.report.fouls.map((f) => f.code),
      ['wrong_ball_first']
    );
  }
  // 碰后无库无球：两边都是 NO_RAIL
  assertSame(
    '碰后无库',
    playBoth([1, 2, 8], [1, 2, 9], { firstContact: 1, railsAfterContact: [], pocketed: [] }, { breakShot: false })
  );
  // 进球续杆：八球按组判、九球看有没有进球，这一杆两边都该继续，且都不给持球。
  // 分组、players、open 必然不同（八球这一杆就分组并把台面关掉），允许；
  // turn / continuing / ballInHand 必须一致。
  const pot = playBoth([1, 2, 8], [1, 2, 9], { firstContact: 1, pocketed: [{ number: 1 }] }, { breakShot: false });
  assertSame('进球续杆', pot, ['players', 'groupAssigned', 'open']);
  for (const r of pot) {
    assert.equal(r.report.continuing, true);
    assert.equal(r.next.turn, 0);
    assert.equal(r.next.ballInHand, null);
  }
});

test('护栏：开球一杆，两条路径的犯规判定与球权归属一致', () => {
  // 合法开球（四颗碰库、没进球）→ 都不犯规、都换人、都不给持球、都不重摆
  assertSame('合法开球', playBoth([1, 2, 8], [1, 2, 9], { pocketed: [], objectBallsToRail: [1, 2, 3, 4] }));
});

test('护栏：不合法开球，两边的犯规代码相同，处理方式各自不同（参数化的就是这一处）', () => {
  const [eight, nine] = playBoth([1, 2, 8], [1, 2, 9], { pocketed: [], objectBallsToRail: [1, 2, 3] });
  const codes = (r) => r.report.fouls.map((f) => f.code);
  assert.deepEqual(codes(eight), codes(nine), '不合法开球的犯规代码必须一致');
  assert.ok(codes(eight).includes('illegal_break'));
  // 八球：对手重摆、不给持球（4.3d）
  assert.equal(eight.next.requiresRerack, true);
  assert.equal(eight.next.ballInHand, null);
  assert.equal(eight.next.turn, 1);
  // 九球：与普通犯规同路，给全场自由球；不重摆
  assert.equal(nine.next.requiresRerack, false);
  assert.deepEqual(nine.next.ballInHand, { zone: 'anywhere' });
  assert.equal(nine.next.turn, 1);
});

test('护栏：连续犯规的计数两边一致，只有"判不判负"按玩法不同', () => {
  const eight = createGame(table, makeBalls([1, 2, 8]), { kind: 'eightball' });
  const nine = createGame(table, makeBalls([1, 2, 9]), { kind: 'nineball' });
  eight.breakShot = false;
  nine.breakShot = false;

  // 连续犯规是"按人算"的：犯规会换人，所以要夹一杆对手的合法球才能让同一个人连犯三次。
  const steps = ['foul', 'legal', 'foul', 'legal', 'foul'];
  let cur8 = eight;
  let cur9 = nine;
  for (let i = 0; i < steps.length; i++) {
    const shooter8 = cur8.turn;
    const shooter9 = cur9.turn;
    assert.equal(shooter8, shooter9, `第 ${i + 1} 杆之前两条玩法的击球方不一致`);
    // 先碰 8 / 9 号球 = 犯规；干净一杆则用默认事实（先碰最小号、有碰库、没进球）
    const r8 = resolveShot(cur8, makeFacts(cur8, steps[i] === 'foul' ? { firstContact: 8 } : {}));
    const r9 = resolveShot(cur9, makeFacts(cur9, steps[i] === 'foul' ? { firstContact: 9 } : {}));
    cur8 = r8.next;
    cur9 = r9.next;
    assert.equal(
      cur8.players[shooter8].fouls,
      cur9.players[shooter9].fouls,
      `第 ${i + 1} 杆之后击球方的犯规计数两条玩法不一致`
    );
    assert.equal(r8.report.fouled, r9.report.fouled, `第 ${i + 1} 杆的犯规判定不一致`);
    if (steps[i] === 'foul' && i < steps.length - 1) {
      // 前两次犯规都不判负：八球本来就不判负，九球要等到第三次
      assert.equal(r8.report.ended, false);
      assert.equal(r9.report.ended, false);
    }
  }
  // 第三次：八球只记账、九球判负——这是 foulCounter 参数唯一的实质差异
  assert.equal(cur8.players[0].fouls, 3);
  assert.equal(cur8.phase, 'playing', '八球连犯三次不判负（WPA 3.13 排除 8-Ball）');
  assert.equal(cur9.phase, 'ended', '九球连犯三次判负');
  assert.equal(cur9.winner, 1);
});