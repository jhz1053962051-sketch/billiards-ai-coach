// 斯诺克规则：摆球、按序击球、计分、彩球回位。
//
// 这里全部用手工构造的 facts 测规则层，不跑物理——物理正确性与规则正确性是
// 两个问题，混在一起测的话，一次碰撞调参就会让一堆规则断言变红，看不出
// 到底是规则错了还是球没打进。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createRack, GAME_KINDS } from '../src/rack.js';
import { createBall } from '../src/physics.js';
import { createGame, resolveShot, legalTargetNumbers, numbersOnTable, placementAllowed } from '../src/rules.js';
import {
  valueOf,
  ballName,
  isRed,
  isColor,
  snookerSpots,
  snookerTargets,
  initialSnooker,
  YELLOW,
  GREEN,
  BROWN,
  BLUE,
  PINK,
  BLACK,
} from '../src/snooker.js';

const table = createTable('snooker');

/** 手工造一杆的事实：只写「谁进了、先碰到谁」，球位沿用击球前的。 */
function factsOf(game, spec = {}) {
  const pottedIds = new Set(spec.pocketed ?? []);
  const pocketed = [];
  for (const id of pottedIds) {
    const b = game.balls.find((x) => x.id === id);
    assert.ok(b, `factsOf：没有这颗球 ${id}`);
    pocketed.push({ id, number: b.number, pocket: 'c-br' });
  }
  const ballsAfter = game.balls.map((b) => {
    if (!pottedIds.has(b.id)) return { id: b.id, x: b.x, y: b.y, pocketed: false };
    // 落袋球停在袋心附近，这在台面 bounds 之外——物理核就是这么给的。
    return { id: b.id, x: 0.02, y: 0.02, pocketed: true, pocket: 'c-br' };
  });
  return {
    firstContact: spec.firstContact ?? null,
    pocketed,
    cueScratched: Boolean(spec.scratch),
    railsAfterContact: spec.rails ?? [],
    objectBallsToRail: [],
    onTableBefore: game.balls.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number),
    onTableAfter: ballsAfter.filter((b) => !b.pocketed).map((b) => game.balls.find((x) => x.id === b.id).number),
    settled: true,
    elapsed: 1,
    events: [],
    ballsAfter,
  };
}

/** 一颗红球 + 六颗彩球的简化局面，方便逐条验规则。 */
function simpleGame(opts = {}) {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b1', 1.6, 0.9, { number: 1, color: '#c8281f' }),
    createBall('b' + YELLOW, 0.737, 0.597, { number: YELLOW }),
    createBall('b' + GREEN, 0.737, 1.181, { number: GREEN }),
    createBall('b' + BROWN, 0.737, 0.889, { number: BROWN }),
    createBall('b' + BLUE, 1.784, 0.889, { number: BLUE }),
    createBall('b' + PINK, 2.677, 0.889, { number: PINK }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  if (opts.noCue) balls.shift();
  const g = createGame(table, balls, { kind: 'snooker', names: ['甲', '乙'] });
  if (opts.ballOn) g.snooker.ballOn = opts.ballOn;
  return g;
}

test('斯诺克：玩法登记表里有它，摆出来的球数是 15 红 + 6 彩 + 母球', () => {
  assert.ok(GAME_KINDS.snooker, 'GAME_KINDS 里必须有 snooker');
  const balls = createRack('snooker', table, { seed: 3 });
  assert.equal(balls.length, 22);
  assert.equal(balls.filter((b) => isRed(b.number)).length, 15);
  assert.equal(balls.filter((b) => isColor(b.number)).length, 6);
  assert.equal(balls.filter((b) => b.number === 0).length, 1);
});

test('斯诺克：彩球必须摆在自己的点位上，红球三角阵不许和台上任何球重叠', () => {
  const balls = createRack('snooker', table, { seed: 5 });
  const spots = snookerSpots(table);
  const at = (n) => balls.find((b) => b.number === n);
  for (const [n, key] of [
    [YELLOW, 'yellow'],
    [GREEN, 'green'],
    [BROWN, 'brown'],
    [BLUE, 'blue'],
    [PINK, 'pink'],
    [BLACK, 'black'],
  ]) {
    assert.ok(Math.abs(at(n).x - spots[key].x) < 1e-9, `${ballName(n)} 的 x 不对`);
    assert.ok(Math.abs(at(n).y - spots[key].y) < 1e-9, `${ballName(n)} 的 y 不对`);
  }

  const R = table.ballRadius;
  for (let i = 0; i < balls.length; i++) {
    for (let j = i + 1; j < balls.length; j++) {
      const d = Math.hypot(balls[i].x - balls[j].x, balls[i].y - balls[j].y);
      assert.ok(d >= 2 * R - 1e-9, `${balls[i].id} 与 ${balls[j].id} 初始就重叠（${d.toFixed(4)} < ${(2 * R).toFixed(4)}）`);
    }
  }
  // 红球三角阵的顶点要紧贴粉球后方，不能压上粉球，也不能离太远。
  const apex = balls.filter((b) => isRed(b.number)).sort((a, b) => a.x - b.x)[0];
  const gap = apex.x - (at(PINK).x + 2 * R);
  assert.ok(gap > 0 && gap < 0.01, `顶点红球与粉球的间距应在 0–10 mm，实际 ${(gap * 1000).toFixed(1)} mm`);
});

test('斯诺克：分值表与中文名', () => {
  assert.equal(valueOf(1), 1);
  assert.equal(valueOf(15), 1);
  assert.equal(valueOf(YELLOW), 2);
  assert.equal(valueOf(BROWN), 4);
  assert.equal(valueOf(BLACK), 7);
  assert.equal(ballName(1), '红球');
  assert.equal(ballName(YELLOW), '黄球');
  assert.equal(ballName(BLACK), '黑球');
});

test('斯诺克：开局该打红球，进球不分组也不推进分组状态', () => {
  const g = simpleGame();
  assert.deepEqual(g.snooker, { scores: [0, 0], ballOn: 'red', reds: 1 });
  assert.equal(g.open, true, '斯诺克没有「台面 open」这个概念，但字段不该被乱改');
  const targets = legalTargetNumbers(g, numbersOnTable(g.balls));
  assert.deepEqual(targets, [1], '只剩一颗红球时，合法目标就只有它');
});

test('斯诺克：打进红球得 1 分、继续打彩球', () => {
  const g = simpleGame();
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: 1, pocketed: ['b1'], rails: ['x'] }));
  assert.equal(report.fouled, false);
  assert.equal(next.snooker.scores[0], 1);
  assert.equal(next.snooker.ballOn, 'color');
  assert.equal(next.turn, 0, '进球之后还是同一个人打');
  assert.equal(report.continuing, true);
  assert.deepEqual(legalTargetNumbers(next, numbersOnTable(next.balls)).sort(), [16, 17, 18, 19, 20, 21]);
});

test('斯诺克：打进彩球按分值加分，彩球回位，然后回到红球', () => {
  const g = simpleGame({ ballOn: 'color' });
  const { next } = resolveShot(g, factsOf(g, { firstContact: BLACK, pocketed: ['b' + BLACK], rails: ['x'] }));
  assert.equal(next.snooker.scores[0], 7);
  const black = next.balls.find((b) => b.number === BLACK);
  assert.equal(black.pocketed, false, '台上有红球时，彩球进袋必须回位');
  const spots = snookerSpots(table);
  assert.ok(Math.abs(black.x - spots.black.x) < 1e-9 && Math.abs(black.y - spots.black.y) < 1e-9);
  assert.equal(next.snooker.ballOn, 'red');
});

test('斯诺克：先碰错球判犯规，罚 4 分给对手，并交出球权', () => {
  const g = simpleGame();
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: BLACK, rails: ['x'] }));
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === 'wrong_ball_first'));
  // 先碰到的是黑球，罚分取「实际打到的球」的分值 7，比底线 4 分高。
  assert.deepEqual(next.snooker.scores, [0, 7]);
  assert.equal(next.turn, 1);
  assert.equal(next.snooker.ballOn, 'red', '犯规不改变该打什么球');
});

test('斯诺克：罚分至少 4 分，打黑球犯规按 7 分算', () => {
  const g = simpleGame({ ballOn: 'color' });
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: BLACK, pocketed: ['b' + BLACK] }));
  // 该打彩球、打进黑球本身不犯规（彩球阶段可以打任意彩球），所以这里要造一个真犯规：
  // 先碰红球。
  assert.equal(report.fouled, false, '这一杆本身合法，先确认基线');

  const g2 = simpleGame({ ballOn: 'color' });
  const r2 = resolveShot(g2, factsOf(g2, { firstContact: 1, rails: ['x'] }));
  assert.equal(r2.report.fouled, true);
  assert.deepEqual(r2.next.snooker.scores, [0, 4], '此时涉及的最高分值是红球 1 分，底线仍是 4 分');

  const g3 = simpleGame({ ballOn: BLACK });
  const r3 = resolveShot(g3, factsOf(g3, { firstContact: 1, rails: ['x'] }));
  assert.deepEqual(r3.next.snooker.scores, [0, 7], '该打黑球时犯规，罚 7 分');
});

test('斯诺克：母球落袋，对手得分且在 D 区内持球', () => {
  const g = simpleGame({ ballOn: 'color' });
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: YELLOW, pocketed: ['cue'], scratch: true }));
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === 'scratch'));
  assert.deepEqual(next.snooker.scores, [0, 4]);
  assert.deepEqual(next.ballInHand, { zone: 'd' });
  assert.equal(next.turn, 1);

  const spots = snookerSpots(table);
  assert.equal(placementAllowed(next, spots.baulkX - 0.05, table.width / 2), true, 'D 里面合法');
  assert.equal(placementAllowed(next, spots.baulkX + 0.05, table.width / 2), false, '开球线另一侧不合法');
  assert.equal(placementAllowed(next, spots.baulkX - 0.05, table.width / 2 + 0.5), false, '出了半圆不合法');
});

test('斯诺克：打红球时把彩球撞进袋，算犯规且彩球回位', () => {
  const g = simpleGame();
  const { next, report } = resolveShot(
    g,
    factsOf(g, { firstContact: 1, pocketed: ['b1', 'b' + BLUE], rails: ['x'] })
  );
  assert.equal(report.fouled, true);
  assert.ok(report.fouls.some((f) => f.code === 'wrong_ball_potted'));
  assert.deepEqual(next.snooker.scores, [0, 5], '蓝球 5 分，罚 5 分');
  const blue = next.balls.find((b) => b.number === BLUE);
  assert.equal(blue.pocketed, false, '犯规打进的彩球必须回位');
  assert.equal(next.snooker.scores[0], 0, '犯规这一杆进的红球也不算分');
});

test('斯诺克：红球全清后按分值从小到大打彩球，进袋不回位', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + YELLOW, 0.737, 0.597, { number: YELLOW }),
    createBall('b' + BROWN, 0.737, 0.889, { number: BROWN }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  assert.equal(g.snooker.reds, 0);
  assert.equal(g.snooker.ballOn, 'red', 'ballOn 的初值不因为没红球就特殊处理');

  g.snooker.ballOn = YELLOW;
  const { next } = resolveShot(g, factsOf(g, { firstContact: YELLOW, pocketed: ['b' + YELLOW], rails: ['x'] }));
  assert.deepEqual(next.snooker.scores, [2, 0]);
  assert.equal(next.balls.find((b) => b.number === YELLOW).pocketed, true, '彩球阶段进袋不回位');
  assert.equal(next.snooker.ballOn, BROWN, '接着该打下一颗分值最低的彩球');
});

test('斯诺克：只剩黑球时犯规，对手直接赢下这一局', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  g.snooker.ballOn = BLACK;
  g.snooker.scores = [30, 20];
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: null, scratch: true }));
  assert.equal(report.ended, true);
  assert.equal(next.phase, 'ended');
  assert.equal(next.winner, 1);
  assert.deepEqual(next.snooker.scores, [30, 27], '该打黑球时犯规罚 7 分，罚分照记，只是这局同时结束了');
});

test('斯诺克：清完最后一颗黑球时比分相同，黑球重摆继续打', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  g.snooker.ballOn = BLACK;
  g.snooker.scores = [33, 40];
  const { next, report } = resolveShot(g, factsOf(g, { firstContact: BLACK, pocketed: ['b' + BLACK], rails: ['x'] }));
  assert.equal(report.ended, false, '33 + 7 = 40，平分，这一局没结束');
  assert.deepEqual(next.snooker.scores, [40, 40]);
  assert.equal(next.snooker.ballOn, BLACK);
  const black = next.balls.find((b) => b.number === BLACK);
  assert.equal(black.pocketed, false, '黑球重摆回黑球点');
  assert.equal(next.turn, 1, '重摆黑球之后换对手开球');
});

test('斯诺克：最后一颗红球之后打进彩球，这颗彩球仍然要回位（WPBSA 3.4）', () => {
  // 红球清空、刚打完最后一颗红球，这一杆是「自由彩球」。
  // 彩球阶段要等这颗自由彩球也打完才开始，所以它进袋必须回位——
  // 不回位的话清彩阶段少一颗球，少的是这 5 分，甚至可能提前结束。
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + YELLOW, 0.737, 0.597, { number: YELLOW }),
    createBall('b' + BLUE, 1.784, 0.889, { number: BLUE }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  g.snooker.reds = 0;
  g.snooker.ballOn = 'color';

  const { next, report } = resolveShot(
    g,
    factsOf(g, { firstContact: BLUE, pocketed: ['b' + BLUE], rails: ['x'] })
  );

  assert.equal(report.fouled, false);
  assert.equal(report.snooker.gained, 5, '自由彩球的分照记');
  assert.deepEqual(report.snooker.respotted, [BLUE], '最后一红之后的彩球必须回位');
  const blue = next.balls.find((b) => b.number === BLUE);
  assert.equal(blue.pocketed, false, '蓝球回到台上');
  const spot = snookerSpots(table).blue;
  assert.ok(
    Math.hypot(blue.x - spot.x, blue.y - spot.y) < 1e-9,
    `蓝球回到蓝球点，实际在 (${blue.x.toFixed(3)}, ${blue.y.toFixed(3)})`
  );
  assert.equal(next.snooker.ballOn, YELLOW, '红球已清空，接下来按分值顺序打黄球');
  assert.equal(next.snooker.ballOn, 16, '黄球的球号是 16');
});

test('斯诺克：平分重摆黑球时黑球点被占，黑球让位且不与任何球重叠', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  const R = table.ballRadius;
  const spot = snookerSpots(table).black;
  const cue = g.balls.find((b) => b.number === 0);
  // 母球打进黑球之后停在离黑球点 1.5R 的地方——直接摆回去就是一颗球压另一颗。
  cue.x = spot.x - 1.5 * R;
  cue.y = spot.y;
  g.snooker.ballOn = BLACK;
  g.snooker.scores = [33, 40];

  const { next, report } = resolveShot(
    g,
    factsOf(g, { firstContact: BLACK, pocketed: ['b' + BLACK], rails: ['x'] })
  );

  assert.equal(report.ended, false, '33 + 7 = 40，平分，重摆黑球继续');
  assert.deepEqual(next.snooker.scores, [40, 40]);
  assert.equal(next.turn, 1, '重摆黑球之后由对手先打');

  const black = next.balls.find((b) => b.number === BLACK);
  const cueAfter = next.balls.find((b) => b.number === 0);
  assert.equal(black.pocketed, false);
  const gap = Math.hypot(black.x - cueAfter.x, black.y - cueAfter.y);
  assert.ok(gap >= 2 * R, `黑球与母球至少隔 2R，实际 ${gap.toFixed(6)} < ${(2 * R).toFixed(6)}`);
  assert.ok(black.x > spot.x, '沿中线朝顶库方向让位，不是往开球端退');
  assert.ok(table.insideBounds(black.x, black.y), '让位之后球心仍要落在台面内');

  const nearest = Math.min(
    ...next.balls
      .filter((b) => !b.pocketed && b.number !== BLACK)
      .map((b) => Math.hypot(b.x - black.x, b.y - black.y))
  );
  assert.ok(nearest >= 2 * R, `与台上任何球都不许重叠，最近 ${nearest.toFixed(6)}`);
  assert.match(report.notes.join('|'), /黑球点被占/, '让位要留下说明');
});

test('斯诺克：黑球点没被占时，平分重摆仍然摆回黑球点', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  g.snooker.ballOn = BLACK;
  g.snooker.scores = [33, 40];
  const { next } = resolveShot(
    g,
    factsOf(g, { firstContact: BLACK, pocketed: ['b' + BLACK], rails: ['x'] })
  );
  const black = next.balls.find((b) => b.number === BLACK);
  const spot = snookerSpots(table).black;
  assert.ok(Math.hypot(black.x - spot.x, black.y - spot.y) < 1e-9, '点位空着就不许乱挪');
});

test('斯诺克：snookerTargets 能按「红球 / 任意彩球 / 指定彩球」三种状态给目标', () => {
  const g = simpleGame();
  assert.deepEqual(snookerTargets(g, [1, 16, 21]), [1]);
  g.snooker.ballOn = 'color';
  assert.deepEqual(snookerTargets(g, [1, 16, 21]), [16, 21]);
  g.snooker.ballOn = BLACK;
  assert.deepEqual(snookerTargets(g, [1, 16, 21]), [21]);
  assert.deepEqual(snookerTargets(g, [1, 16]), [], '该打的球不在台上就返回空，不能骗求解器去打别的');
  assert.deepEqual(initialSnooker(15), { scores: [0, 0], ballOn: 'red', reds: 15 });
});

/**
 * 造一杆的事实，但**保留**其它球原有的进袋状态。
 *
 * factsOf 会把没列进 pocketed 的球一律当成「还在台上」，连续打两杆时那等于把
 * 上一杆打掉的红球又搬回来——测「红球数一杆一杆减少」时必须用这个版本。
 */
function potFacts(game, ids, spec = {}) {
  const potted = new Set(ids);
  const pocketed = [];
  for (const id of potted) {
    const b = game.balls.find((x) => x.id === id);
    assert.ok(b, `potFacts：没有这颗球 ${id}`);
    pocketed.push({ id, number: b.number, pocket: 'c-br' });
  }
  const ballsAfter = game.balls.map((b) =>
    potted.has(b.id)
      ? { id: b.id, x: 0.02, y: 0.02, pocketed: true, pocket: 'c-br' }
      : { id: b.id, x: b.x, y: b.y, pocketed: Boolean(b.pocketed), pocket: b.pocket }
  );
  return {
    ...factsOf(game, spec),
    pocketed,
    ballsAfter,
    onTableBefore: game.balls.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number),
    onTableAfter: ballsAfter
      .filter((b) => !b.pocketed)
      .map((b) => game.balls.find((x) => x.id === b.id).number),
  };
}

test('斯诺克：reds 字段跟着台面红球数走，打进 N 颗红球后是 15 - N', () => {
  let g = createGame(table, createRack('snooker', table, { seed: 5 }), { kind: 'snooker' });
  const redsOnTable = () => g.balls.filter((b) => isRed(b.number) && !b.pocketed).length;
  assert.equal(g.snooker.reds, 15, '开局的 15 颗红球');

  // 红球 1 → 自由彩球（蓝）→ 红球 2 → 红球 3：真实节奏，彩球回位不占红球数。
  let expect = 15;
  for (const n of [1, 2, 3]) {
    const id = g.balls.find((b) => b.number === n).id;
    g = resolveShot(g, potFacts(g, [id], { firstContact: n, rails: ['x'] })).next;
    expect -= 1;
    assert.equal(g.snooker.reds, expect, `打进 ${n} 号红球后 reds 必须是 ${expect}`);
    assert.equal(g.snooker.reds, redsOnTable(), 'reds 与台面实数必须一致（存档按这个字段写）');

    // 打进一颗自由彩球：它回位，红球数不变。
    const blue = g.balls.find((b) => b.number === BLUE).id;
    g = resolveShot(g, potFacts(g, [blue], { firstContact: BLUE, rails: ['x'] })).next;
    assert.equal(g.snooker.reds, expect, '彩球进袋回位，红球数不受影响');
    assert.equal(g.balls.find((b) => b.number === BLUE).pocketed, false);
  }
});

test('斯诺克：最后一颗红球打完后 reds 归零，ballOn 停在「该打彩球」', () => {
  const balls = [
    createBall('cue', 0.6, 0.9, { number: 0 }),
    createBall('b1', 1.6, 0.9, { number: 1, color: '#c8281f' }),
    createBall('b' + YELLOW, 0.737, 0.597, { number: YELLOW }),
    createBall('b' + BROWN, 0.737, 0.889, { number: BROWN }),
    createBall('b' + BLACK, 3.245, 0.889, { number: BLACK }),
  ];
  const g = createGame(table, balls, { kind: 'snooker' });
  assert.equal(g.snooker.reds, 1, '台面上只有一颗红球');
  const { next, report } = resolveShot(
    g,
    potFacts(g, ['b1'], { firstContact: 1, rails: ['x'] })
  );
  assert.equal(next.snooker.reds, 0, '最后一颗红球打完后红球数为 0');
  assert.equal(next.snooker.ballOn, 'color', '红球清空后还有一次自由选彩球的机会');
  assert.equal(report.continuing, true);
});