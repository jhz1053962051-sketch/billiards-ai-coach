// 存档往返与 snooker.reds：以前 resolveSnooker 从不更新这个字段，
// 存档里恒写 15，中盘读档之后「还剩几颗红球」直接错成开局值。
// 这里走真实的 demo/save.js（serialize → JSON → sanitize），不模拟字段。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createRack } from '../src/rack.js';
import { createGame, resolveShot } from '../src/rules.js';
import { isRed, BLUE } from '../src/snooker.js';
import { serialize, sanitize } from '../demo/save.js';

const table = createTable('snooker');

/** 造一杆的事实：列出的球进袋，其余球保持原有进袋状态（可以连着打多杆）。 */
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
    firstContact: spec.firstContact ?? null,
    pocketed,
    cueScratched: Boolean(spec.scratch),
    railsAfterContact: spec.rails ?? [],
    objectBallsToRail: [],
    onTableBefore: game.balls.filter((b) => !b.pocketed && b.number !== 0).map((b) => b.number),
    onTableAfter: ballsAfter
      .filter((b) => !b.pocketed)
      .map((b) => game.balls.find((x) => x.id === b.id).number),
    settled: true,
    elapsed: 1,
    events: [],
    ballsAfter,
  };
}

function freshGame() {
  return createGame(table, createRack('snooker', table, { seed: 5 }), { kind: 'snooker' });
}

const redsOnTable = (g) => g.balls.filter((b) => isRed(b.number) && !b.pocketed).length;

test('斯诺克存档：打进 2 颗红球后存档往返，reds 仍是 13（不是 15）', () => {
  let g = freshGame();
  for (const n of [1, 2]) {
    const id = g.balls.find((b) => b.number === n).id;
    g = resolveShot(g, potFacts(g, [id], { firstContact: n, rails: ['x'] })).next;
    // 每杆后面补一颗自由彩球，让 ballOn 回到「该打红球」，避免下一杆是犯规球。
    const blue = g.balls.find((b) => b.number === BLUE).id;
    g = resolveShot(g, potFacts(g, [blue], { firstContact: BLUE, rails: ['x'] })).next;
  }
  assert.equal(g.snooker.reds, 13, '存档前字段就该是 13');
  assert.equal(redsOnTable(g), 13);

  // 真存档是「序列化成字符串再读回来」，中间不能靠对象引用蒙混。
  const text = JSON.stringify(serialize(g, 111));
  const saved = sanitize(JSON.parse(text));
  assert.ok(saved, '这份存档必须能通过校验');
  assert.equal(saved.snooker.reds, 13, '存档里写的红球数');
  assert.equal(saved.snooker.reds, redsOnTable(g), '存档里的红球数必须等于台面实数');
  assert.equal(saved.snooker.ballOn, 'red', 'ballOn 一起存、一起还原');
  assert.deepEqual(saved.snooker.scores, g.snooker.scores);
});

test('斯诺克存档：老存档（reds 被写成 15）读回来之后，下一杆就纠正成台面实数', () => {
  let g = freshGame();
  const ids = [1, 2, 3].map((n) => g.balls.find((b) => b.number === n).id);
  for (const id of ids) {
    g = resolveShot(g, potFacts(g, [id], { firstContact: 1, rails: ['x'] })).next;
  }
  const real = redsOnTable(g);
  assert.equal(real, 12);

  // 模拟修复之前写下的存档：字段还停在开局值。
  g.snooker.reds = 15;
  const id = g.balls.find((b) => b.number === 4).id;
  const { next } = resolveShot(g, potFacts(g, [id], { firstContact: 4, rails: ['x'] }));
  assert.equal(next.snooker.reds, redsOnTable(next), '红球数按台面重算，不会带着旧的 15 往下走');
  assert.equal(next.snooker.reds, 11);
});

test('斯诺克存档：最后一颗红球打完后 reds === 0，ballOn 是「该打彩球」', () => {
  let g = freshGame();
  // 把 2–15 号红球先收掉，只留 1 号（相当于中盘局面）。
  g.balls = g.balls.map((b) =>
    isRed(b.number) && b.number !== 1
      ? { ...b, pocketed: true, pocket: 'c-br' }
      : { ...b, pocketed: Boolean(b.pocketed) }
  );
  g.snooker.reds = redsOnTable(g);
  assert.equal(g.snooker.reds, 1);

  const { next } = resolveShot(
    g,
    potFacts(g, [g.balls.find((b) => b.number === 1).id], { firstContact: 1, rails: ['x'] })
  );
  assert.equal(next.snooker.reds, 0);
  assert.equal(next.snooker.ballOn, 'color');

  const saved = sanitize(JSON.parse(JSON.stringify(serialize(next, 222))));
  assert.ok(saved);
  assert.equal(saved.snooker.reds, 0, '存档里也是 0，读档不会退回「红球还有很多」');
  assert.equal(saved.snooker.ballOn, 'color');
});