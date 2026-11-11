// 九球（9-Ball）规则测试。
//
// 与黑八的分工一致：simulateShot 只报事实，resolveShot 只判规则，
// 所以这里喂合成事实就能覆盖全部条文，不用为了一条规则去构造真实球路。
//
// 条文出处见 src/rules.js 顶部注释（WPA《Rules of Play》Effective 2025-09-15 第五节）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall, createWorld } from '../src/physics.js';
import {
  createNineBallRack,
  nineBallSlots,
  rackDiamondLayout,
  NINE_NUMBERS,
  NINE_SLOT_ROWS,
  NINE_ADJACENCY,
  createRack,
} from '../src/rack.js';
import {
  FOUL,
  ILLEGAL_BREAK_NOTICE,
  GAME_KINDS,
  createGame,
  numbersOnTable,
  legalTargetNumbers,
  simulateShot,
  resolveShot,
  acceptTable,
  handBackBreak,
  rerack,
  placeCueBall,
  headStringX,
} from '../src/rules.js';
import { planShot } from '../src/solver.js';

const table = createTable('pool9');
const R = table.ballRadius;

/** 造一副指定号码的球，母球放在开球线后。 */
function makeBalls(numbers, cueAt = { x: table.length * 0.2, y: table.width / 2 }) {
  const cue = createBall('cue', cueAt.x, cueAt.y, { number: 0 });
  const objs = numbers.map((n, i) =>
    createBall('b' + n, table.length * 0.5 + (i % 5) * 0.14, table.width * 0.3 + Math.floor(i / 5) * 0.14, {
      number: n,
    })
  );
  return [cue, ...objs];
}

/** 建一局九球。 */
function makeNine(numbers, opts = {}) {
  const balls = makeBalls(numbers, opts.cueAt);
  createWorld(table, balls);
  const g = createGame(table, balls, { kind: 'nineball', ...opts });
  if (opts.notBreak !== false) g.breakShot = false;
  return g;
}

/** 造一份 simulateShot 形状的事实。默认「干净的一杆，先碰最小号，没进球」。 */
function makeFacts(game, spec = {}) {
  const onTableBefore = numbersOnTable(game.balls);
  const pocketed = spec.pocketed ?? [];
  const pocketedNumbers = pocketed.map((p) => p.number);
  const onTableAfter = onTableBefore.filter((n) => !pocketedNumbers.includes(n));
  const ballsAfter = game.balls.map((b) => {
    if (b.number === 0) return { ...b, vx: 0, vy: 0 };
    if (pocketedNumbers.includes(b.number)) return { ...b, pocketed: true, pocket: 'c-br', vx: 0, vy: 0 };
    return { ...b, pocketed: false, pocket: undefined, vx: 0, vy: 0 };
  });
  return {
    firstContact: spec.firstContact === undefined ? Math.min(...onTableBefore) : spec.firstContact,
    firstContactId: null,
    pocketed: pocketed.map((p) => ({ id: 'b' + p.number, number: p.number, pocket: p.pocket ?? 'c-br' })),
    cueScratched: spec.cueScratched ?? false,
    railsAfterContact: spec.railsAfterContact ?? ['cue'],
    objectBallsToRail: spec.objectBallsToRail ?? [1, 2, 3, 4],
    onTableBefore,
    onTableAfter,
    settled: spec.settled ?? true,
    elapsed: 1,
    events: [],
    ballsAfter: spec.ballsAfter ?? ballsAfter,
  };
}

// ------------------------------------------------------------------ 摆球

test('九球摆球：菱形 1-2-3-2-1，共 9 个槽位', () => {
  const slots = nineBallSlots(table);
  assert.equal(slots.length, 9);
  assert.equal(NINE_SLOT_ROWS.length, 9);
  // 每排的颗数必须是 1/2/3/2/1，这是菱形的定义
  const perRow = [0, 0, 0, 0, 0];
  for (const s of NINE_SLOT_ROWS) perRow[s.row]++;
  assert.deepEqual(perRow, [1, 2, 3, 2, 1], '菱形的每排颗数是 1-2-3-2-1');
});

test('九球摆球：9 号压在底点上、1 号在顶点朝头端，其余七颗按洗牌填', () => {
  for (const seed of [1, 2, 3, 7, 42, 99]) {
    const balls = createNineBallRack(table, { seed });
    const objs = balls.filter((b) => b.number !== 0);
    assert.equal(objs.length, 9, 'seed=' + seed + ' 应该有 9 颗目标球');
    assert.deepEqual(
      objs.map((b) => b.number).sort((a, b) => a - b),
      NINE_NUMBERS,
      'seed=' + seed + ' 的号码必须是 1–9 各一颗'
    );

    const one = objs.find((b) => b.number === 1);
    const nine = objs.find((b) => b.number === 9);
    // WPA 5.2 原文："the 9-ball in the middle of the diamond and on the Foot Spot"
    // —— 压在底点上的是 9 号，不是顶点那颗。黑八才是顶点压底点，两个规矩正好相反。
    const footX = table.length * 0.75;
    const rowGap = Math.sqrt(3) * R;
    assert.ok(Math.abs(nine.x - footX) < 1e-9, 'seed=' + seed + ' 的 9 号球要压在底点上');
    assert.ok(Math.abs(nine.y - table.width / 2) < 1e-9, 'seed=' + seed + ' 的 9 号球要在中线上');
    // 1 号在顶点：比底点往头端让两排（菱形正中在第 2 排）
    assert.ok(Math.abs(one.x - (footX - 2 * rowGap)) < 1e-9, 'seed=' + seed + ' 的 1 号球要在顶点');
    assert.ok(Math.abs(one.y - table.width / 2) < 1e-9, 'seed=' + seed + ' 的 1 号球要在中线上');
    // 顶点必须比底点更靠头端，否则菱形就摆反了
    assert.ok(one.x < nine.x, 'seed=' + seed + ' 的 1 号球应该在 9 号球的前面（朝向球台头端）');
  }
});

test('九球摆球：所有球紧密相贴（球心距恰好 2R），不重叠', () => {
  const balls = createNineBallRack(table, { seed: 5 }).filter((b) => b.number !== 0);
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const d = Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y);
      assert.ok(d >= 2 * R - 1e-9, `${balls[i].number} 与 ${balls[j].number} 重叠了（距离 ${d}）`);
    }
  }
  // 相贴边：菱形 16 条（三角阵是 30 条；菱形等于三角阵去掉四个角，少的正是那些角的边）
  let touching = 0;
  for (const [i, j] of NINE_ADJACENCY) {
    const a = balls[i];
    const b = balls[j];
    if (Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 2 * R) < 1e-9) touching++;
  }
  assert.equal(touching, NINE_ADJACENCY.length, '菱形里每一对相邻槽位都该紧紧相贴');
});

test('九球摆球：不同 seed 摆出的球不同，但 1 号和 9 号永远在原位', () => {
  const seen = new Set();
  const footX = table.length * 0.75;
  const rowGap = Math.sqrt(3) * R;
  for (let seed = 1; seed <= 20; seed++) {
    const objs = createNineBallRack(table, { seed }).filter((b) => b.number !== 0);
    const one = objs.find((b) => b.number === 1);
    const nine = objs.find((b) => b.number === 9);
    assert.ok(Math.abs(one.x - (footX - 2 * rowGap)) < 1e-9, '1 号永远在顶点');
    assert.ok(Math.abs(nine.x - footX) < 1e-9, '9 号永远压在底点上');
    seen.add(objs.map((b) => b.number).join(','));
  }
  assert.ok(seen.size >= 6, `20 个 seed 至少该摆出 6 种不同的排列，实际 ${seen.size} 种`);
});

test('createRack：按玩法取对应的一副球', () => {
  assert.equal(createRack('nineball', table, { seed: 1 }).length, 10, '九球 = 9 颗目标球 + 母球');
  assert.equal(createRack('eightball', table, { seed: 1 }).length, 16, '黑八 = 15 颗目标球 + 母球');
  assert.equal(createRack(undefined, table, { seed: 1 }).length, 16, '不传玩法时默认黑八');
});

// ------------------------------------------------------------------ 建局与先碰

test('建局：默认黑八，显式传 nineball 才切成九球', () => {
  const balls = makeBalls([1, 2, 3]);
  assert.equal(createGame(table, balls).kind, 'eightball');
  assert.equal(createGame(table, balls, { kind: 'nineball' }).kind, 'nineball');
  // 原来是「未知玩法悄悄退回黑八」，等于让一局球按另一套规则跑完还不吭声
  assert.throws(() => createGame(table, balls, { kind: '瞎写' }), /不认识的玩法：瞎写/);
  assert.deepEqual(GAME_KINDS.nineball, { id: 'nineball', label: '九球', balls: 9 });
});

test('九球：永远只能先碰台面上号码最小的球（WPA 3.2）', () => {
  const g = makeNine([3, 5, 9]);
  assert.deepEqual(legalTargetNumbers(g, [3, 5, 9]), [3], '最小号是 3，就只能先碰 3');
  assert.deepEqual(legalTargetNumbers(g, [5, 9]), [5], '3 进袋后最小号变成 5');
  assert.deepEqual(legalTargetNumbers(g, [9]), [9], '只剩 9 号时只能打 9 号');
});

test('九球：不分组，所以打到别人的球不算犯规也不会分组', () => {
  const g = makeNine([1, 2, 9]);
  g.players[0].group = null;
  const r = resolveShot(g, makeFacts(g, { firstContact: 1, pocketed: [{ number: 2 }] }));
  assert.equal(r.report.fouled, false, '先碰最小号 1、进了 2，九球里完全合法');
  assert.equal(r.report.groupAssigned, null, '九球没有分组这回事');
  assert.equal(r.next.players[0].group, null, '打完也不能凭空给玩家分组');
  assert.equal(r.report.continuing, true, '进了球就继续');
});

test('九球：开球那一杆不限制先碰哪颗（5.3 是穷举式例外清单）', () => {
  const g = makeNine([1, 2, 9], { notBreak: false });
  assert.equal(g.breakShot, true);
  assert.deepEqual(legalTargetNumbers(g, [1, 2, 9]).sort((a, b) => a - b), [1, 2, 9]);
});

// ------------------------------------------------------------------ 9 号球

test('九球：合法打进 9 号球判胜（WPA 5.5）', () => {
  const g = makeNine([4, 9]);
  const r = resolveShot(g, makeFacts(g, { firstContact: 4, pocketed: [{ number: 9 }] }));
  assert.equal(r.report.ended, true);
  assert.equal(r.report.winner, 0);
  assert.equal(r.next.phase, 'ended');
  assert.equal(r.next.winner, 0);
  assert.match(r.report.summary, /获胜/);
  // 9 号球回位不该发生——它是被合法打进的
  assert.equal(r.report.spotted, null);
});

test('九球：犯规时打进 9 号球要摆回底点，不能算赢（WPA 5.6）', () => {
  const g = makeNine([4, 9]);
  const r = resolveShot(g, makeFacts(g, { firstContact: 4, pocketed: [{ number: 9 }], cueScratched: true }));
  assert.equal(r.report.fouled, true);
  assert.equal(r.report.spotted, 9);
  assert.equal(r.report.ended, false, '犯规进 9 号不能结束这一局');
  const nine = r.next.balls.find((b) => b.number === 9);
  assert.equal(nine.pocketed, false, '9 号球必须回到台面上');
  assert.ok(
    Math.abs(nine.x - table.length * 0.75) < 1e-9 && Math.abs(nine.y - table.width / 2) < 1e-9,
    '摆回底点'
  );
  // 播报里不能出现「进 9 号」——它没留在袋里
  assert.equal(r.report.pocketed.length, 0, '重摆回去的球不算进袋');
  assert.match(r.report.notes.join(''), /9 号球摆回底点/);
});

test('九球：只有 9 号会回位，别的球进了就是进了（5.6 末句）', () => {
  const g = makeNine([1, 2, 9]);
  const r = resolveShot(g, makeFacts(g, { firstContact: 1, pocketed: [{ number: 1 }, { number: 2 }] }));
  assert.equal(r.report.spotted, null);
  assert.deepEqual(r.report.pocketed.map((p) => p.number).sort((a, b) => a - b), [1, 2]);
  assert.equal(r.next.balls.find((b) => b.number === 1).pocketed, true);
  assert.equal(r.next.balls.find((b) => b.number === 2).pocketed, true);
});

// ------------------------------------------------------------------ 开球

test('九球开球：没有球进袋且不足四颗碰库 → 犯规（5.3b），对手全场自由球', () => {
  const g = makeNine([1, 2, 3, 4, 5, 9], { notBreak: false });
  const r = resolveShot(g, makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3] }));
  assert.equal(r.report.fouls.some((f) => f.code === FOUL.ILLEGAL_BREAK), true);
  assert.deepEqual(r.next.ballInHand, { zone: 'anywhere' }, '九球开球犯规是全场自由球，不是开球线后');
  assert.equal(r.next.turn, 1);
  assert.equal(r.next.requiresRerack, false, '九球不走重摆，是给自由球');
});

test('九球开球：三球过线不达标但其余合法 → 不是犯规，接手方有选择权（Reg.16）', () => {
  const g = makeNine([1, 2, 3, 4, 5, 9], { notBreak: false });
  // 四颗碰库（满足 5.3b）、没有进球，但只有 1 颗球停在开球线之前
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3, 4] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    b.number === 1 ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const r = resolveShot(g, facts);

  assert.equal(r.report.fouled, false, 'Reg.16 的三球过线不达标不是犯规');
  assert.equal(r.report.pendingChoice?.kind, ILLEGAL_BREAK_NOTICE);
  assert.equal(r.report.pendingChoice?.player, 1, '选择权在接手方');
  assert.equal(r.next.ballInHand, null, '不是犯规，所以没有自由球');
  assert.equal(r.next.turn, 1, '默认先交给接手方');
  assert.equal(r.next.requiresRerack, false);
  assert.match(r.report.notes.join(''), /Regulation 16/);
});

test('九球开球：三球过线达标时不产生待决事项', () => {
  const g = makeNine([1, 2, 3, 4, 5, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3, 4] });
  // 三颗球停在开球线之前
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    [1, 2, 3].includes(b.number) ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const r = resolveShot(g, facts);
  assert.equal(r.report.fouled, false);
  assert.equal(r.report.pendingChoice, null, '达标了就没有选择权这回事');
  assert.equal(r.next.pendingChoice, null);
});

test('九球开球：三球过线不达标却打进 9 号 → 9 号回位，不算赢（Reg.16(5)）', () => {
  const g = makeNine([1, 2, 3, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [{ number: 9 }], objectBallsToRail: [1, 2, 3] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    b.number === 1 ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const r = resolveShot(g, facts);
  assert.equal(r.report.ended, false, 'Reg.16(5) 明确要求把 9 号摆回去，不能算赢');
  assert.equal(r.report.spotted, 9);
  assert.match(r.report.notes.join(''), /Regulation 16\(5\)/);
});

test('九球开球：进 9 号同时又满足三球要求，才算合法赢局（5.5 + Reg.16(1)）', () => {
  // Reg.16(1) 的数量是「进袋 + 过线」相加，进 9 号算一颗，还要有两颗过线。
  const g = makeNine([1, 2, 3, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [{ number: 9 }], objectBallsToRail: [1, 2, 3] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    [1, 2].includes(b.number) ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const r = resolveShot(g, facts);
  assert.equal(r.report.ended, true, '进 1 颗 + 过线 2 颗 = 3 颗，开球达标');
  assert.equal(r.report.winner, 0);
  assert.equal(r.report.spotted, null, '合法开球进 9 号不摆回');
});

test('九球开球：三球要求是「进袋 + 过线」相加，不是只看过线（Reg.16(1)）', () => {
  // 只进一颗普通球、零颗过线 → 合计 1 颗，不达标
  const g = makeNine([1, 2, 3, 4, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [{ number: 1 }], objectBallsToRail: [1, 2, 3, 4] });
  facts.ballsAfter = facts.ballsAfter.map((b) => ({ ...b, x: table.length * 0.7 }));
  const r = resolveShot(g, facts);
  assert.equal(r.report.fouled, false, '四球碰库满足了，所以不是犯规');
  assert.equal(r.report.pendingChoice?.kind, ILLEGAL_BREAK_NOTICE, '一颗进袋凑不满三颗');
  assert.match(r.report.notes.join(''), /只做到 1 颗/);
});

test('九球开球：进两颗 + 过线一颗 = 3 颗，达标（Reg.16(1) 的 combination 情形）', () => {
  const g = makeNine([1, 2, 3, 4, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [{ number: 1 }, { number: 2 }], objectBallsToRail: [1, 2, 3] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    b.number === 3 ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const r = resolveShot(g, facts);
  assert.equal(r.report.fouled, false);
  assert.equal(r.report.pendingChoice, null, '2 颗进袋 + 1 颗过线 = 3 颗，达到要求');
});

// ------------------------------------------------------------------ 三犯

test('九球三犯：连续三次犯规判负，且第二次之后必须提醒（WPA 3.13 + 5.8）', () => {
  let g = makeNine([1, 2, 3, 9]);
  // 「连续」指的是自己没打出合法球，中间换手不算清零。
  // 所以每次犯规之后，要让对手打一杆合法但不进球的球把台面交回来。
  const legalNoPocket = (cur) => resolveShot(cur, makeFacts(cur, { pocketed: [] })).next;

  // 第一次犯规
  let r = resolveShot(g, makeFacts(g, { cueScratched: true }));
  assert.equal(r.report.fouled, true);
  assert.equal(r.next.players[0].fouls, 1);
  assert.equal(r.next.players[0].warned, false, '只有一犯，不该提醒');

  // 第二次犯规 → 置提醒
  let cur = legalNoPocket(r.next);
  r = resolveShot(cur, makeFacts(cur, { cueScratched: true }));
  assert.equal(r.next.players[0].fouls, 2, '中间那杆换手合法球不清零，累计到两犯');
  assert.equal(r.next.players[0].warned, true, '到两犯必须提醒（否则第三犯只能按第二犯算）');
  assert.match(r.report.notes.join(''), /再犯一次就输掉这一局/);

  // 第三次犯规 → 判负
  cur = legalNoPocket(r.next);
  const r3 = resolveShot(cur, makeFacts(cur, { cueScratched: true }));
  assert.equal(r3.next.players[0].fouls, 3);
  assert.equal(r3.report.ended, true);
  assert.equal(r3.report.winner, 1, '对手获胜');
  assert.match(r3.report.notes.join(''), /连续三次犯规/);
});

test('九球三犯：对手打一杆合法球不清零本方的计数（3.13 说的是"自己没打合法球"）', () => {
  let g = makeNine([1, 2, 3, 9]);
  let r = resolveShot(g, makeFacts(g, { cueScratched: true }));
  assert.equal(r.next.players[0].fouls, 1);

  // 对手接手打一杆干净球 → 对手自己的计数归零，但自己那一次犯规仍然记着
  r = resolveShot(r.next, makeFacts(r.next, { pocketed: [] }));
  assert.equal(r.next.players[1].fouls, 0);
  assert.equal(r.next.players[0].fouls, 1, '对手的合法杆不算本方的 intervening legal shot');
  assert.equal(r.next.turn, 0, '对手没进球，换回自己');

  // 自己再犯规 → 累计到第二次，并触发提醒
  r = resolveShot(r.next, makeFacts(r.next, { cueScratched: true }));
  assert.equal(r.next.players[0].fouls, 2);
  assert.equal(r.next.players[0].warned, true, '到两犯要提醒');
});

test('九球三犯：自己的合法杆也清零', () => {
  let g = makeNine([1, 2, 3, 9]);
  let r = resolveShot(g, makeFacts(g, { cueScratched: true }));
  assert.equal(r.next.players[0].fouls, 1);
  // 接着自己打（对手犯规交回来）——这里直接构造：让对手犯规
  r = resolveShot(r.next, makeFacts(r.next, { cueScratched: true }));
  r = resolveShot(r.next, makeFacts(r.next, { pocketed: [{ number: 1 }] }));
  assert.equal(r.next.players[0].fouls, 0, '合法进球要把连续犯规清零');
});

test('九球三犯：黑八没有这条规则，同样的三次犯规不会判负', () => {
  const balls = makeBalls([1, 2, 8]);
  createWorld(table, balls);
  let g = createGame(table, balls);
  g.breakShot = false;
  const legalNoPocket = (c) => resolveShot(c, makeFacts(c, { pocketed: [] })).next;
  let r = resolveShot(g, makeFacts(g, { cueScratched: true }));
  for (let i = 0; i < 2; i++) {
    const cur = legalNoPocket(r.next);
    r = resolveShot(cur, makeFacts(cur, { cueScratched: true }));
  }
  assert.equal(r.next.players[0].fouls, 3, '计数照样在涨');
  assert.equal(r.report.ended, false, '黑八不吃三犯这条（3.13 排除 8-Ball）');
});

// ------------------------------------------------------------------ 自由球与选择权

test('九球：普通犯规后是全场自由球（5.7）', () => {
  const g = makeNine([1, 2, 9]);
  const r = resolveShot(g, makeFacts(g, { cueScratched: true }));
  assert.deepEqual(r.next.ballInHand, { zone: 'anywhere' });
  assert.equal(placeCueBall(r.next, table.length * 0.9, table.width * 0.9), true, '台面任意位置都摆得下');
});

test('九球：接手方可以选择照打（Reg.16(2) 的第一个选项）', () => {
  const g = makeNine([1, 2, 3, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3, 4] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    b.number === 1 ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const { next } = resolveShot(g, facts);
  const after = acceptTable(next);
  assert.equal(after.pendingChoice, null);
  assert.equal(after.turn, 1, '照打就是接手方打');
});

test('九球：接手方也可以把这一杆交回原开球方（Reg.16(4)）', () => {
  const g = makeNine([1, 2, 3, 9], { notBreak: false });
  const facts = makeFacts(g, { pocketed: [], objectBallsToRail: [1, 2, 3, 4] });
  facts.ballsAfter = facts.ballsAfter.map((b) =>
    b.number === 1 ? { ...b, x: headStringX(table) * 0.5 } : { ...b, x: table.length * 0.7 }
  );
  const { next } = resolveShot(g, facts);
  const after = handBackBreak(next);
  assert.equal(after.pendingChoice, null);
  assert.equal(after.turn, 0, '交回去就是原开球方打');
  assert.equal(after.ballInHand, null);
});

test('九球：没有待决事项时调用 handBackBreak 不改变任何东西', () => {
  const g = makeNine([1, 2, 9]);
  const before = JSON.stringify(g);
  handBackBreak(g);
  assert.equal(JSON.stringify(g), before, '没有待决事项时不该动局面');
});

// ------------------------------------------------------------------ 一局打完

test('九球：求解器自己跟自己打，能真的打到分出胜负', () => {
  for (const seed of [1, 7, 42]) {
    const balls = createNineBallRack(table, { seed }).map((b) => createBall(b.id, b.x, b.y, b));
    createWorld(table, balls);
    let game = createGame(table, balls, { kind: 'nineball', names: ['A', 'B'] });
    let guard = 0;

    while (game.phase !== 'ended' && guard++ < 400) {
      if (game.requiresRerack) {
        // 九球不走重摆；万一走到这里说明规则写错了
        throw new Error('九球不该出现 requiresRerack');
      }
      if (game.ballInHand) {
        const zone = game.ballInHand.zone;
        const x = zone === 'kitchen' ? table.length * 0.12 : table.length * 0.5;
        placeCueBall(game, x, table.width / 2);
      }
      const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
      const { plan } = planShot(table, game, { allow });
      assert.ok(plan, `seed=${seed} 第 ${game.shots + 1} 杆必须找到方案`);
      const facts = simulateShot(table, game.balls, { angle: plan.aimAngle, speed: plan.speed, tip: plan.tip });
      const r = resolveShot(game, facts);
      game = r.next;
    }

    assert.equal(game.phase, 'ended', `seed=${seed} 应该打完，实际停在 ${game.shots} 杆`);
    assert.ok(game.winner === 0 || game.winner === 1, '必须有赢家');
    assert.ok(game.shots >= 3 && game.shots <= 300, `杆数应在合理区间，实际 ${game.shots}`);
    assert.equal(game.log.length, game.shots, '每一杆都要留记录');
  }
});

test('九球：rerack 会清掉三犯计数与提醒状态', () => {
  const g = makeNine([1, 2, 9]);
  g.players[0].fouls = 2;
  g.players[0].warned = true;
  g.pendingChoice = { player: 1, kind: ILLEGAL_BREAK_NOTICE, breaker: 0 };
  rerack(g, createNineBallRack(table, { seed: 2 }));
  assert.equal(g.players[0].fouls, 0);
  assert.equal(g.players[0].warned, false);
  assert.equal(g.pendingChoice, null, '重开局不能把上一个待决事项带进来');
});

test('九球摆球：不足 9 颗时按洗牌填充，不假装是标准摆法', () => {
  const layout = rackDiamondLayout(table, [1, 2, 9], { seed: 1 });
  assert.equal(layout.length, 3);
  assert.equal(new Set(layout.map((p) => p.number)).size, 3);
  // 位置仍然取自菱形槽位（顶点槽位在底点前两排，不是底点本身）
  const slots = nineBallSlots(table);
  assert.ok(Math.abs(layout[0].x - slots[0].x) < 1e-9);
  assert.ok(Math.abs(layout[0].y - slots[0].y) < 1e-9);
});
