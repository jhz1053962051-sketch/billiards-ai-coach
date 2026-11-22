// advanceBall 内联改写的等价性护栏（2026-11 性能改造）。
//
// 改造把 snapToRolling / decaySpin 两个只被 advanceBall 调用的小函数就地展开，
// 把 b.x/b.y/b.vx/b.vy/b.wx/b.wy/b.wz 搬到局部量、末尾一次性写回，并把
// 「打不打滑」的判断从 sqrt(u2) > SLIP_EPS 换成 u2 > SLIP_EPS²（uLen 只在打滑分支
// 里才需要，纯滚动的调用不该白付一次 sqrt）。
//
// 这些改动**只允许去掉调用与属性访问开销**，不许动任何一次浮点运算的次序与结合性。
// 但这一点在代码上无法自证——只要有人把 `vx / R` 写成 `vx * (1 / R)`、把
// `Math.min(remaining, tStop)` 挪个位置、或者顺手换个「更快」的写法，结果就会在末几位
// 分叉，而所有基于容差的测试照样全绿。所以这里钉两层逐位护栏：
//
//   1. 12 个固定 (状态, tau) 黄金矢量，覆盖打滑段、打滑→滚动切换、滚动段、停住那一步、
//      静止塞衰减、tau < 1e-12（循环体一次都不进）、全零退化路径、快球大塞多段；
//      期望值是**改动前的实现**（commit 6d996ef 的 src/physics.js）算出来的双精度原字节。
//   2. 6 个典型局面的整杆轨迹 SHA256（每帧所有球的 x/y/vx/vy/wx/wy/wz/pocketed 原字节
//      + 事件序列），覆盖开球 53 个事件、斯诺克安全球 63 个事件、库边、薄球、组合球。
//
// 两层都必须逐位一致；任何一位不同都说明有人改了浮点顺序，不是「误差范围内」。
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { createBall, advanceBall } from '../src/physics.js';
import { createStandardRack, createSnookerRack } from '../src/rack.js';
import { simulateShot } from '../src/sim.js';
import { SEARCH_DT, SHOT_TIME_LIMITS } from '../src/constants.js';

/** 双精度原字节（大端 hex）：四舍五入的十进制写法证明不了「逐位相同」 */
function bits(v) {
  const buf = Buffer.alloc(8);
  buf.writeDoubleBE(v, 0);
  return buf.toString('hex');
}

// ---------------------------------------------------------------- 第一层：黄金矢量
//
// state = [x, y, vx, vy, wx, wy, wz]；hex = 调用 advanceBall 之后这 7 个字段的原字节。
// 由改动前的实现生成，不是「当前实现的快照」——所以它能抓到浮点顺序被改。
const TABLE = createTable('pool9');
const R = TABLE.ballRadius;

const GOLDEN = [
  // 纯打滑（无塞无侧旋）：只有滑移衰减与球速线性衰减
  { id: 'slip-straight', tau: 1 / 120, state: [0.5, 0.5, 2, 0, 0, 0, 0],
    hex: ['3fe087f9aa33d3fb', '3fe0000000000000', '3fffbd07c84b5dcc', '0000000000000000',
      '0000000000000000', '3ff6e31b8c6e31ba', '0000000000000000'] },
  // 打滑 + 侧旋（塞在打滑段按 5·μ_spin·g/(2R) 衰减）
  { id: 'slip-side-spin', tau: 1 / 120, state: [0.4, 0.6, 2, 0, 0, 0, 25],
    hex: ['3fdaa98cee014191', '3fe3333333333333', '3fffbd07c84b5dcc', '0000000000000000',
      '0000000000000000', '3ff6e31b8c6e31ba', '4038d7b7f8797b80'] },
  // 打滑 + 高低杆（wx 大，wy 由 uLen 反解）
  { id: 'slip-back-spin', tau: 1 / 120, state: [0.6, 0.5, 1.5, 0.3, 60, 0, -12],
    hex: ['3fe39944467c349f', '3fe0140849fa0f2b', '3ff7d8010a38aa8b', '3fd25c5781a93e26',
      '404d6d2484b0e112', '3feb566a1040d951', 'c027af6ff0f2f6ff'] },
  // 多段：打滑走完 → snapToRolling → 继续滚动（一次调用里跑两段，dt 被切成两截）
  { id: 'slip-to-roll', tau: 0.5, state: [0.4, 0.4, 2.5, -0.7, 0, 0, 8],
    hex: ['3ff6d5b77c13557e', '3fbcc59efb0dbc62', '3ffc631a7ddb6d35', 'bfdfcb27e91eb7bf',
      '4031628b68a05cdc', '404f0b66a88c138a', '0000000000000000'] },
  // 纯滚动（wx/wy 与 v 匹配，uLen 只剩残差）：走滚动分支
  { id: 'rolling', tau: 1 / 120, state: [0.8, 0.4, 1.2, 0.4, -0.4 / R, 1.2 / R, 0],
    hex: ['3fe9eb7e57d8df56', '3fd9d032186e72c2', '3ff33005fa757d22', '3fd9955d4df1fc2e',
      'c02bfa78da4805ad', '4044fbdaa3b60441', '0000000000000000'] },
  // 纯滚动 + 侧旋仍在衰减
  { id: 'rolling-side-spin', tau: 1 / 120, state: [0.7, 0.5, 1.05, -0.55, 0.55 / R, 1.05 / R, 18],
    hex: ['3fe6ae0e26f1f9b1', '3fdfb4eebc619675', '3ff0c9d574a03e27', 'bfe1967e18a7df97',
      '40333bfc59ad0fd8', '40425c2b0fc81ac3', '4031d7b7f8797b80'] },
  // 这一子步里停住：dt 被 tStop 截断后走「清零」而不是 snapToRolling
  { id: 'stop-crossing', tau: 1 / 120, state: [1.1, 0.5, 0.02, 0.01, -0.01 / R, 0.02 / R, 3],
    hex: ['3ff19a452b04093c', '3fe000ab916a6fa2', '3f93bb33aa7bdc1a', '3f83bb33aa7bdc1a',
      'bfd5940fbd5ae25f', '3fe5940fbd5ae25f', '4006bdbfc3cbdbfc'] },
  // 静止分支：速度已判停，只衰减塞（用的是 remaining，不是 dt）
  { id: 'still-spin-decay', tau: 1 / 120, state: [0.9, 0.6, 0, 0, 0, 0, 40],
    hex: ['3feccccccccccccd', '3fe3333333333333', '0000000000000000', '0000000000000000',
      '0000000000000000', '0000000000000000', '4043ebdbfc3cbdc0'] },
  // 静止分支：塞一步衰减到 0（|wz| <= drop 那一支）
  { id: 'still-spin-to-zero', tau: 1, state: [0.9, 0.6, 0, 0, 0, 0, 0.001],
    hex: ['3feccccccccccccd', '3fe3333333333333', '0000000000000000', '0000000000000000',
      '0000000000000000', '0000000000000000', '0000000000000000'] },
  // tau < 1e-12：循环体一次都不进，写回的必须还是原值本身
  { id: 'tau-below-eps', tau: 1e-13, state: [0.5, 0.5, 1.5, 0.2, 0, 0, 20],
    hex: ['3fe0000000000000', '3fe0000000000000', '3ff8000000000000', '3fc999999999999a',
      '0000000000000000', '0000000000000000', '4034000000000000'] },
  // 全零：最容易在「先写回再判断」里被改坏的退化路径
  { id: 'all-zero', tau: 1 / 120, state: [0.5, 0.7, 0, 0, 0, 0, 0],
    hex: ['3fe0000000000000', '3fe6666666666666', '0000000000000000', '0000000000000000',
      '0000000000000000', '0000000000000000', '0000000000000000'] },
  // 快球 + 大塞：打滑 / 滚动 / 塞衰减三段都真的跑到
  { id: 'hard-draw', tau: 1 / 120, state: [0.3, 0.3, 5.5, -1, -80, 40, -30],
    hex: ['3fd6213e00d5212c', '3fd2ab56b843fc4c', '4015f2a20c7cf194', 'bfefaf59a021bc24',
      'c053c8e0080c4eb5', '4044922ee9e0eba8', 'c03dd7b7f8797b80'] },
];

const FIELDS = ['x', 'y', 'vx', 'vy', 'wx', 'wy', 'wz'];

test('advanceBall 逐位等价：12 个固定状态与内联前完全一致', () => {
  for (const c of GOLDEN) {
    const b = createBall('cue', c.state[0], c.state[1], { number: 0 });
    b.__R = R;
    for (let i = 2; i < 7; i++) b[FIELDS[i]] = c.state[i];
    const keysBefore = Object.keys(b).join(',');

    advanceBall(b, c.tau);

    const got = FIELDS.map((f) => bits(b[f]));
    for (let i = 0; i < FIELDS.length; i++) {
      assert.equal(got[i], c.hex[i], `${c.id}: ${FIELDS[i]} 变了（${got[i]} != ${c.hex[i]}）`);
    }
    // 写回只碰已有字段：多一个字段就是隐藏类退化，热循环里所有属性访问一起变慢
    assert.equal(Object.keys(b).join(','), keysBefore, `${c.id}: advanceBall 往球对象上加了字段`);
  }
});

// ---------------------------------------------------------------- 第二层：整杆轨迹
//
// 每帧把世界内所有球的 x/y/vx/vy/wx/wy/wz/pocketed 按双精度原字节串起来，
// 连同事件序列一起哈希——任何一次浮点顺序变化都会让某个哈希变掉。
const TRAJECTORIES = [
  { id: 'f1-straight', table: 'pool9', frames: 649, events: 4,
    balls: [[0, 0.635, 0.635], [1, 1.905, 0.635]],
    shot: { angle: 0, speed: 2.6, tip: { a: 0, b: 0.2 } },
    hash: '4a9ca61cdb7281c34335e93ea5040d8ca3c129d69a78234d5eda00d7ad208363' },
  { id: 'f2-thin', table: 'pool9', frames: 848, events: 5,
    balls: [[0, 0.6, 0.7], [2, 1.35, 0.66]],
    shot: { angle: Math.atan2(-0.04, 0.75) + (1.7 * Math.PI) / 180, speed: 3.1, tip: { a: 0.15, b: 0.3 } },
    hash: '26d8ffa924ba0fd8d4e403f14b13828494e06851c801462c9ef55763d404c007' },
  { id: 'f3-cushion', table: 'pool9', frames: 716, events: 3,
    balls: [[0, 0.4, 0.5], [7, 1.9, 0.3]],
    shot: { angle: (52 * Math.PI) / 180, speed: 3.4, tip: { a: 0.45, b: 0.15 } },
    hash: 'ae68c760963af1427605612940472275ef828a968d2747a5f6169379811e1c58' },
  { id: 'f4-combo', table: 'pool9', frames: 481, events: 4,
    balls: [[0, 0.45, 0.95], [3, 1.1, 0.62], [5, 1.75, 0.585]],
    shot: { angle: (-18 * Math.PI) / 180, speed: 3.8, tip: { a: -0.2, b: 0.1 } },
    hash: 'fcc4d82250665c5d3b856e5af57c43f4cb24aa1f4de137c56b53c282bb0660f1' },
  { id: 'f5-break', table: 'pool9', frames: 746, events: 53, rack: 'standard',
    shot: { angle: 0, speed: 6.6, tip: { a: 0, b: -0.1 } },
    hash: 'df4de363e1e680a46aa773c9dc818190c6aaba6bbc6ba63cc9dfbbc05a9a4e6f' },
  { id: 'f6-snooker-safety', table: 'snooker', frames: 618, events: 63, rack: 'snooker',
    shot: { angle: (2.5 * Math.PI) / 180, speed: 1.5, tip: { a: -0.35, b: -0.25 } },
    hash: '5b7c1c33fd1f0b6062d27913138ca82ec6766eb6269973524ed47bb03996bb37' },
];

/** 跑一个局面，返回轨迹哈希、帧数与事件数 */
function trajectory(fx) {
  const t = createTable(fx.table);
  const balls = fx.rack === 'standard'
    ? createStandardRack(t)
    : fx.rack === 'snooker'
      ? createSnookerRack(t)
      : fx.balls.map(([n, x, y]) => ({ id: n === 0 ? 'cue' : `b${n}`, number: n, x, y }));
  const nums = [];
  const evs = [];
  let frames = 0;
  simulateShot(t, balls, { ...fx.shot, cueId: 'cue' }, {
    dt: SEARCH_DT,
    maxTime: SHOT_TIME_LIMITS.play,
    onStart: (world) => {
      for (const b of world.balls) nums.push(b.x, b.y, b.vx, b.vy, b.wx, b.wy, b.wz, b.pocketed ? 1 : 0);
      frames++;
    },
    onStep: (world) => {
      const bs = world.balls;
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        nums.push(b.x, b.y, b.vx, b.vy, b.wx, b.wy, b.wz, b.pocketed ? 1 : 0);
      }
      frames++;
    },
    onEvent: (e) => evs.push(e),
  });
  const h = crypto.createHash('sha256');
  h.update(`${fx.id}|${fx.table}|${balls.length}|`);
  h.update(Buffer.from(Float64Array.from(nums).buffer));
  h.update('|');
  h.update(JSON.stringify(evs));
  return { hash: h.digest('hex'), frames, events: evs.length };
}

test('整杆轨迹 SHA256 与内联前逐位一致（6 个典型局面）', () => {
  const overall = [];
  for (const fx of TRAJECTORIES) {
    const got = trajectory(fx);
    assert.equal(got.frames, fx.frames, `${fx.id}: 帧数变了（${got.frames} != ${fx.frames}）`);
    assert.equal(got.events, fx.events, `${fx.id}: 事件数变了（${got.events} != ${fx.events}）`);
    assert.equal(got.hash, fx.hash, `${fx.id}: 轨迹哈希变了——有人改了 advanceBall 的浮点运算顺序`);
    overall.push(`${fx.id}:${got.hash}`);
  }
  // 合并哈希：6 个局面一起看，等价于验收里跑的那份 frames 基线
  assert.equal(
    crypto.createHash('sha256').update(overall.join('\n')).digest('hex'),
    '3c47da1f0dd07f605ff7abdcc7c0597fe6d42bc0e4795697cd353e95ea1b4173',
    '合并轨迹哈希变了',
  );
});