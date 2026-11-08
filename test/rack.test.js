// 摆球与球组测试。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import {
  CUE_NUMBER,
  RACK_NUMBERS,
  RACK_PATTERN,
  RACK_ADJACENCY,
  ballStyle,
  groupOf,
  rackLayout,
  createStandardRack,
  findFreeSpot,
  sameGroupEdges,
} from '../src/rack.js';

const table = createTable('pool9');
const R = table.ballRadius;

test('球组：1–7 全色、8 号单独、9–15 花色、0 是母球', () => {
  assert.equal(groupOf(0), 'cue');
  assert.equal(CUE_NUMBER, 0);
  for (let n = 1; n <= 7; n++) assert.equal(groupOf(n), 'solid', `${n} 号应是全色`);
  assert.equal(groupOf(8), 'eight');
  for (let n = 9; n <= 15; n++) assert.equal(groupOf(n), 'stripe', `${n} 号应是花色`);
});

test('球组：9–15 的底色与 1–7 一一对应，且带白条', () => {
  for (let n = 1; n <= 7; n++) {
    const solid = ballStyle(n);
    const stripe = ballStyle(n + 8);
    assert.equal(stripe.color, solid.color, `${n} 与 ${n + 8} 应同色`);
    assert.equal(solid.stripe, false);
    assert.equal(stripe.stripe, true);
    assert.equal(stripe.number, n + 8);
  }
});

test('球组：母球与 8 号球都不是花色', () => {
  assert.equal(ballStyle(0).stripe, false);
  assert.equal(ballStyle(8).stripe, false);
});

test('摆球：15 颗时 8 号球在第三排正中、顶点是 1 号', () => {
  const layout = rackLayout(table, RACK_NUMBERS, { seed: 3 });
  assert.equal(layout.length, 15);
  assert.equal(layout[0].number, 1, '顶点应是 1 号球');
  assert.equal(layout[4].number, 8, '第三排正中应是 8 号球');
});

test('摆球：15 颗时后排两底角一全色一花色', () => {
  for (const seed of [1, 2, 3, 7, 11, 42]) {
    const layout = rackLayout(table, RACK_NUMBERS, { seed });
    const a = groupOf(layout[10].number);
    const b = groupOf(layout[14].number);
    assert.deepEqual(
      [a, b].sort(),
      ['solid', 'stripe'],
      `seed=${seed} 时两底角应是 ${a}/${b}`
    );
  }
});

test('摆球：15 个号码一个不多一个不少', () => {
  const layout = rackLayout(table, RACK_NUMBERS, { seed: 5 });
  const nums = layout.map((p) => p.number).sort((x, y) => x - y);
  assert.deepEqual(nums, RACK_NUMBERS);
});

test('摆球：同一 seed 摆出同一副球，不同 seed 不同', () => {
  const a = rackLayout(table, RACK_NUMBERS, { seed: 9 });
  const b = rackLayout(table, RACK_NUMBERS, { seed: 9 });
  const c = rackLayout(table, RACK_NUMBERS, { seed: 10 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('摆球：三角阵几何——同排间距 2R、相邻排间距 √3·R', () => {
  const layout = rackLayout(table, RACK_NUMBERS, { seed: 1 });
  // 第 0 排 1 颗（索引 0），第 1 排 2 颗（索引 1、2）
  const rowGap = Math.sqrt(3) * R;
  assert.ok(Math.abs(layout[1].x - layout[0].x - rowGap) < 1e-9, '相邻排的 x 差应是 √3·R');
  assert.ok(Math.abs(Math.abs(layout[1].y - layout[2].y) - 2 * R) < 1e-9, '同排的 y 差应是 2R');
});

test('摆球：顶点球在 8 号点（脚点）上', () => {
  const layout = rackLayout(table, RACK_NUMBERS, { seed: 1 });
  assert.ok(Math.abs(layout[0].x - table.length * 0.75) < 1e-9);
  assert.ok(Math.abs(layout[0].y - table.width / 2) < 1e-9);
});

test('摆球：所有球都在台面内且互不重叠', () => {
  const layout = rackLayout(table, RACK_NUMBERS, { seed: 4 });
  for (const p of layout) {
    assert.ok(p.x >= R - 1e-9 && p.x <= table.length - R + 1e-9, `${p.number} 号 x 出界`);
    assert.ok(p.y >= R - 1e-9 && p.y <= table.width - R + 1e-9, `${p.number} 号 y 出界`);
  }
  for (let i = 0; i < layout.length; i++) {
    for (let j = i + 1; j < layout.length; j++) {
      const d = Math.hypot(layout[i].x - layout[j].x, layout[i].y - layout[j].y);
      assert.ok(d >= 2 * R - 1e-9, `${layout[i].number}/${layout[j].number} 重叠，间距 ${d}`);
    }
  }
});

test('摆球：不足 15 颗时只摆给的那些号码', () => {
  const layout = rackLayout(table, [3, 5, 9], { seed: 2 });
  assert.equal(layout.length, 3);
  assert.deepEqual(layout.map((p) => p.number).sort((a, b) => a - b), [3, 5, 9]);
});

test('摆球：1 颗球也摆得出，不崩', () => {
  const layout = rackLayout(table, [7], { seed: 1 });
  assert.equal(layout.length, 1);
  assert.equal(layout[0].number, 7);
});

test('标准摆球：16 颗球，母球在开球端、其余是 1–15', () => {
  const balls = createStandardRack(table, { seed: 1 });
  assert.equal(balls.length, 16);
  const cue = balls.filter((b) => b.number === 0);
  assert.equal(cue.length, 1);
  assert.equal(cue[0].id, 'cue');
  // 开球线在 length/4，母球必须在线后（规则 "on or behind the head string"）
  assert.ok(cue[0].x <= table.length / 4 + 1e-9, `母球应在开球线后，实际 ${cue[0].x}`);
  assert.ok(cue[0].x > 0, '母球不能贴死底库');
  assert.ok(Math.abs(cue[0].y - table.width / 2) < 1e-9);
  const nums = balls.filter((b) => b.number !== 0).map((b) => b.number).sort((a, b) => a - b);
  assert.deepEqual(nums, RACK_NUMBERS);
});

test('标准摆球：每颗球都带上自己的颜色与花色标记', () => {
  const balls = createStandardRack(table, { seed: 1 });
  for (const b of balls) {
    const style = ballStyle(b.number);
    assert.equal(b.color, style.color, `${b.number} 号颜色`);
    assert.equal(b.stripe, style.stripe, `${b.number} 号花色标记`);
  }
});

test('摆球模板：7 全 7 花 1 个八号，8 号在槽 4，两底角一全一花', () => {
  assert.equal(RACK_PATTERN.length, 15);
  assert.equal(RACK_PATTERN.filter((g) => g === 'S').length, 7, '应有 7 个全色');
  assert.equal(RACK_PATTERN.filter((g) => g === 'T').length, 7, '应有 7 个花色');
  assert.equal(RACK_PATTERN.filter((g) => g === '8').length, 1, '应有 1 个八号');
  assert.equal(RACK_PATTERN[4], '8', '8 号应在第三排正中');
  assert.notEqual(RACK_PATTERN[10], RACK_PATTERN[14], '两底角应一全一花');
});

test('摆球模板：三角阵有 30 条相贴边，模板的同组相贴边是最小值 7', () => {
  assert.equal(RACK_ADJACENCY.length, 30, '15 个球位的三角阵应有 30 条相贴边');
  assert.equal(sameGroupEdges(RACK_PATTERN), 7, '模板的同组相贴边应是穷举得到的最小值 7');
  // 每个槽位最多 6 个邻居（第三排正中那颗）
  const degree = new Array(15).fill(0);
  for (const [i, j] of RACK_ADJACENCY) {
    degree[i]++;
    degree[j]++;
  }
  assert.equal(Math.max(...degree), 6);
  assert.equal(degree[4], 6, '第三排正中的 8 号应有 6 个邻居');
  assert.equal(degree[0], 2, '顶点球只有 2 个邻居');
});

test('摆球：任意 seed 下同组相贴都保持最小值 7，不会退化', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const layout = rackLayout(table, RACK_NUMBERS, { seed });
    const groups = layout.map((p) => groupOf(p.number));
    assert.equal(
      sameGroupEdges(groups),
      7,
      `seed=${seed} 的同组相贴边不是 7：${groups.map((g) => (g === 'solid' ? 'S' : g === 'stripe' ? 'T' : '8')).join('')}`
    );
  }
});

test('摆球：号码在各自组内随机，不同 seed 摆出不同的球', () => {
  const rows = [];
  let k = 0;
  for (let row = 0; row < 5; row++) {
    const line = [];
    for (let j = 0; j <= row; j++) line.push(k++);
    rows.push(line);
  }
  const mirrored = new Array(15);
  for (const line of rows) {
    const n = line.length;
    line.forEach((slot, j) => {
      mirrored[line[n - 1 - j]] = RACK_PATTERN[slot];
    });
  }
  const asGroup = (g) => (g === 'solid' ? 'S' : g === 'stripe' ? 'T' : '8');

  const seen = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const layout = rackLayout(table, RACK_NUMBERS, { seed });
    seen.add(layout.map((p) => p.number).join(','));
    const groups = layout.map((p) => asGroup(groupOf(p.number)));
    const seq = groups.join('');
    // seed 会随机取模板或它的左右镜像，两者都是合法最优解
    assert.ok(
      seq === RACK_PATTERN.join('') || seq === mirrored.join(''),
      `seed=${seed} 的组别分布既不是模板也不是镜像：${seq}`
    );
    // 号码与组别必须一致：全色位置只放 1–7，花色位置只放 9–15
    for (let slot = 0; slot < 15; slot++) {
      const num = layout[slot].number;
      const g = groups[slot];
      if (g === '8') assert.equal(num, 8, `槽 ${slot} 应是 8 号`);
      else if (g === 'S') assert.ok(num >= 1 && num <= 7, `槽 ${slot} 应放全色，实际 ${num}`);
      else assert.ok(num >= 9 && num <= 15, `槽 ${slot} 应放花色，实际 ${num}`);
    }
  }
  assert.ok(seen.size >= 6, `12 个 seed 应摆出多种不同排列，实际 ${seen.size} 种`);
});

test('摆球：模板的左右镜像也是合法最优解', () => {
  const rows = [];
  let k = 0;
  for (let row = 0; row < 5; row++) {
    const line = [];
    for (let j = 0; j <= row; j++) line.push(k++);
    rows.push(line);
  }
  const mirrored = new Array(15);
  for (const line of rows) {
    const n = line.length;
    line.forEach((slot, j) => {
      mirrored[line[n - 1 - j]] = RACK_PATTERN[slot];
    });
  }
  assert.equal(sameGroupEdges(mirrored), 7, '镜像也应是 7 条同组边');
  assert.equal(mirrored[4], '8', '镜像后 8 号仍在正中');
  assert.notEqual(mirrored[10], mirrored[14], '镜像后两底角仍一全一花');
});

test('找空位：目标点空着就直接用', () => {
  const spot = findFreeSpot(table, [], R, { x: 1.0, y: 0.6 });
  assert.ok(Math.abs(spot.x - 1.0) < 1e-9 && Math.abs(spot.y - 0.6) < 1e-9);
});

test('找空位：目标点被占时挪开，且不与任何球重叠', () => {
  const balls = [{ x: 1.0, y: 0.6, pocketed: false }];
  const spot = findFreeSpot(table, balls, R, { x: 1.0, y: 0.6 });
  assert.ok(spot, '应能找到空位');
  assert.ok(Math.hypot(spot.x - 1.0, spot.y - 0.6) >= 2 * R - 1e-9, '离被占点至少一个直径');
});

test('找空位：默认从台面中心找，结果在台面内', () => {
  const spot = findFreeSpot(table, [], R);
  assert.ok(spot.x >= R && spot.x <= table.length - R);
  assert.ok(spot.y >= R && spot.y <= table.width - R);
});
