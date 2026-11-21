// src/table.js 的专项测试。
//
// 这些断言全部绑在**跨模块一致的真实约束**上，不照抄实现：
//   · 台面/球半径/袋口半径必须与 constants.js 的预设逐项对得上；
//   · 袋心必须真的落在台面边界上，捕获半径必须由 cornerJaw / middleJaw 推出；
//   · 库边线段的两个端点必须正好抵到相邻袋口的捕获圆——否则球会从袋口边缘漏出台面
//     （这是 table.js 头注释里写明的设计约束）；
//   · pocketAt / insideBounds / cushionAt 的判定边界一律是「含端点」，差 1e-9 就翻面。
//
// 三处曾「实现与注释错位」的语义，本轮各自定死一边并写进 table.js 的注释，
// 下面的用例逐条锁住（改实现或改注释都会让这里变红）：
//   · pocketAt 闭圆、边界只沿轴向精确（table.js:160）；
//   · insideBounds 只判 bounds 矩形、不查袋口（table.js:181）；
//   · cushionAt 的 pos 用 === 精确比较（table.js:204）；
//   · createTable 拒绝几何上画不出台面的参数，不再静默接受反向库边段（table.js:31）。
//
// 所以任何一处几何量被改动（改半径、改 jaw、改袋位、改库边端点），这里都会立刻红。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { TABLE_PRESETS } from '../src/constants.js';

const PRESET_IDS = Object.keys(TABLE_PRESETS);
const pool9 = createTable('pool9');

/** 库边的两个端点（按 axis/pos/along 还原成平面坐标）。 */
function cushionEnds(c) {
  const a = c.axis === 'x' ? { x: c.pos, y: c.from } : { x: c.from, y: c.pos };
  const b = c.axis === 'x' ? { x: c.pos, y: c.to } : { x: c.to, y: c.pos };
  return [a, b];
}

test('球台：尺寸 / 球半径 / 球质量逐项等于 constants.js 的预设', () => {
  for (const id of PRESET_IDS) {
    const cfg = TABLE_PRESETS[id];
    const t = createTable(id);
    assert.equal(t.preset, cfg.id, `${id}: preset 字段`);
    assert.equal(t.label, cfg.label, `${id}: label`);
    assert.equal(t.length, cfg.length, `${id}: 台长`);
    assert.equal(t.width, cfg.width, `${id}: 台宽`);
    assert.equal(t.ballRadius, cfg.ballRadius, `${id}: 球半径`);
    assert.equal(t.ballMass, cfg.ballMass, `${id}: 球质量`);
    // pool9 / pool8 是标准 2:1 台面，长宽比写死在这里是为了抓「把 L/W 传反」这类错
    if (id === 'pool9' || id === 'pool8') {
      assert.equal(t.length / t.width, 2, `${id}: 台面应为 2:1`);
    }
  }
});

test('球台：bounds 是台面四周各内缩一个球半径（贴库时球心仍在内侧）', () => {
  for (const id of PRESET_IDS) {
    const t = createTable(id);
    const R = t.ballRadius;
    assert.deepEqual(t.bounds, {
      minX: R,
      maxX: t.length - R,
      minY: R,
      maxY: t.width - R,
    });
  }
  // 具体数值锚点（pool9）：R=28.575 mm，bounds 0.028575 .. 2.511425
  assert.equal(pool9.bounds.minX, 0.028575);
  assert.equal(pool9.bounds.maxX, 2.54 - 0.028575);
  assert.equal(pool9.bounds.maxY, 1.27 - 0.028575);
});

test('袋口：六个编号完整无重复，袋心在台面边界上，捕获半径由 jaw 推出', () => {
  const expectedIds = ['c-bl', 'c-br', 'c-tl', 'c-tr', 'm-b', 'm-t'];
  for (const id of PRESET_IDS) {
    const cfg = TABLE_PRESETS[id];
    const t = createTable(id);
    const ids = t.pockets.map((p) => p.id);

    assert.equal(ids.length, 6, `${id}: 应有 6 个袋`);
    assert.equal(new Set(ids).size, 6, `${id}: 袋口编号有重复`);
    assert.deepEqual([...ids].sort(), expectedIds, `${id}: 袋口编号集合`);

    let corners = 0;
    let middles = 0;
    for (const p of t.pockets) {
      // 袋心必须落在台面矩形的边界上（x 取端点或 y 取端点），不能在台面内部
      const onEdge = p.x === 0 || p.x === t.length || p.y === 0 || p.y === t.width;
      assert.ok(onEdge, `${id}/${p.id}: 袋心 (${p.x}, ${p.y}) 不在台面边界上`);

      // captureRSq 是 captureR² 的预计算值，两者必须同步（物理核直接用 captureRSq 比较）
      assert.equal(p.captureRSq, p.captureR * p.captureR, `${id}/${p.id}: captureRSq 与半径不自洽`);

      if (p.kind === 'corner') {
        corners++;
        assert.equal(p.captureR, cfg.cornerJaw, `${id}/${p.id}: 角袋半径应取 cornerJaw`);
        assert.ok(p.x === 0 || p.x === t.length, `${id}/${p.id}: 角袋必须在短边库面上`);
        assert.ok(p.y === 0 || p.y === t.width, `${id}/${p.id}: 角袋必须在长边库面上`);
      } else {
        middles++;
        assert.equal(p.kind, 'middle', `${id}/${p.id}: kind 只能是 corner|middle`);
        assert.equal(p.captureR, cfg.middleJaw, `${id}/${p.id}: 中袋半径应取 middleJaw`);
        // 中袋在长边中点，不在短边
        assert.equal(p.x, t.length / 2, `${id}/${p.id}: 中袋 x 应在台长中点`);
        assert.ok(p.y === 0 || p.y === t.width, `${id}/${p.id}: 中袋必须在长边库面上`);
      }
    }
    assert.equal(corners, 4, `${id}: 应有 4 个角袋`);
    assert.equal(middles, 2, `${id}: 应有 2 个中袋`);
  }
});

test('袋口：四角精确落在 (0,0)(L,0)(0,W)(L,W)，中袋落在长边中点', () => {
  const t = createTable('pool9');
  const byId = Object.fromEntries(t.pockets.map((p) => [p.id, p]));
  assert.deepEqual([byId['c-bl'].x, byId['c-bl'].y], [0, 0]);
  assert.deepEqual([byId['c-br'].x, byId['c-br'].y], [t.length, 0]);
  assert.deepEqual([byId['c-tl'].x, byId['c-tl'].y], [0, t.width]);
  assert.deepEqual([byId['c-tr'].x, byId['c-tr'].y], [t.length, t.width]);
  assert.deepEqual([byId['m-b'].x, byId['m-b'].y], [t.length / 2, 0]);
  assert.deepEqual([byId['m-t'].x, byId['m-t'].y], [t.length / 2, t.width]);
});

test('袋口：捕获圆两两不重叠（pocketAt 的短路顺序不影响归属）', () => {
  for (const id of PRESET_IDS) {
    const t = createTable(id);
    for (let i = 0; i < t.pockets.length; i++) {
      for (let j = i + 1; j < t.pockets.length; j++) {
        const a = t.pockets[i];
        const b = t.pockets[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(
          d > a.captureR + b.captureR,
          `${id}: ${a.id} 与 ${b.id} 的捕获圆相交（${d} <= ${a.captureR + b.captureR}）`
        );
      }
    }
  }
});

test('库边：六段齐全，法向朝台内，库面就在台面边界上', () => {
  const expectedIds = ['rail-b-l', 'rail-b-r', 'rail-l', 'rail-r', 'rail-t-l', 'rail-t-r'];
  for (const id of PRESET_IDS) {
    const t = createTable(id);
    assert.deepEqual(t.cushions.map((c) => c.id).sort(), expectedIds, `${id}: 库边编号集合`);

    for (const c of t.cushions) {
      assert.ok(Math.abs(Math.hypot(c.normal.x, c.normal.y) - 1) < 1e-15, `${id}/${c.id}: 法向不是单位向量`);
      // 库面必须贴在台面边界上
      if (c.axis === 'x') {
        assert.ok(c.pos === 0 || c.pos === t.length, `${id}/${c.id}: x 库面的 pos 应为 0 或 L`);
        assert.equal(c.normal.y, 0);
        assert.equal(c.normal.x, c.pos === 0 ? 1 : -1, `${id}/${c.id}: 法向应指向台内`);
        assert.ok(c.from > 0 && c.to < t.width && c.from < c.to, `${id}/${c.id}: 线段应落在台面跨度内`);
      } else {
        assert.ok(c.pos === 0 || c.pos === t.width, `${id}/${c.id}: y 库面的 pos 应为 0 或 W`);
        assert.equal(c.normal.x, 0);
        assert.equal(c.normal.y, c.pos === 0 ? 1 : -1, `${id}/${c.id}: 法向应指向台内`);
        assert.ok(c.from > 0 && c.to < t.length && c.from < c.to, `${id}/${c.id}: 线段应落在台面跨度内`);
      }
      // 沿法向往台内挪一个球半径多一点，应当仍在球心可行域内（反过来验证法向没写反）
      const mid = { x: (c.axis === 'x' ? c.pos : c.from), y: (c.axis === 'x' ? c.from : c.pos) };
      const step = t.ballRadius + 1e-3;
      const inward = { x: mid.x + c.normal.x * step, y: mid.y + c.normal.y * step };
      assert.ok(t.insideBounds(inward.x, inward.y), `${id}/${c.id}: 法向往台内挪 1 mm 应仍在台面内`);
    }
  }
});

test('库边：每段端点正好抵到相邻袋口的捕获圆（袋口缺口的对齐约束）', () => {
  for (const id of PRESET_IDS) {
    const t = createTable(id);
    for (const c of t.cushions) {
      for (const end of cushionEnds(c)) {
        const near = t.nearestPocket(end.x, end.y);
        assert.ok(
          Math.abs(near.distance - near.pocket.captureR) < 1e-12,
          `${id}/${c.id}: 端点 (${end.x}, ${end.y}) 距 ${near.pocket.id} ${near.distance}，` +
            `不等于该袋捕获半径 ${near.pocket.captureR}（库边没对准袋口）`
        );
      }
    }
  }
});

test('库边：总长 = 周长 - 8*cornerJaw - 4*middleJaw（缺口宽度对得上）', () => {
  for (const id of PRESET_IDS) {
    const cfg = TABLE_PRESETS[id];
    const t = createTable(id);
    const sum = t.cushions.reduce((s, c) => s + (c.to - c.from), 0);
    const expected =
      2 * t.length + 2 * t.width - 8 * cfg.cornerJaw - 4 * cfg.middleJaw;
    assert.ok(
      Math.abs(sum - expected) < 1e-12,
      `${id}: 库边总长 ${sum} 应为 ${expected}`
    );
  }
});

test('pocketAt：圆心与半径边界都算进袋（<= 含端点），出圆 1e-9 就不算', () => {
  const t = createTable('pool9');
  const corner = t.pockets.find((p) => p.id === 'c-bl');
  const mid = t.pockets.find((p) => p.id === 'm-b');

  // 返回的是 pockets 数组里的同一个对象（physics 直接拿 p.id 记账）
  assert.equal(t.pocketAt(0, 0), corner);
  assert.equal(t.pockets.includes(t.pocketAt(0, 0)), true);

  // 捕获判定是闭圆：恰好等于 captureR 仍算进袋
  assert.equal(t.pocketAt(corner.captureR, 0), corner);
  assert.equal(t.pocketAt(0, corner.captureR), corner);
  // 对角线方向：|dx|=|dy|≈0.7r（圆内），不能被外接正方形预筛误杀。
  // 契约已明确为「闭圆、边界只沿轴向精确」，见 table.js:160：不能取恰好 r/√2，
  // 2*(r/√2)² 可能比 r² 大 1 ulp，那一点的两个浮点坐标真实距离确实略大于 r。
  const diag = corner.captureR * 0.7;
  assert.equal(t.pocketAt(diag, diag), corner);

  // 出圆一点点就不算
  assert.equal(t.pocketAt(corner.captureR + 1e-9, 0), null);
  assert.equal(t.pocketAt(0, corner.captureR + 1e-9), null);

  // 中袋同理
  assert.equal(t.pocketAt(t.length / 2, 0), mid);
  assert.equal(t.pocketAt(t.length / 2, mid.captureR), mid);
  assert.equal(t.pocketAt(t.length / 2 + mid.captureR + 1e-6, 0), null);
});

test('pocketAt：只看球心、不看球半径；台面外的点也能命中（已滚出台面）', () => {
  const t = createTable('pool9');
  const corner = t.pockets.find((p) => p.id === 'c-bl');
  const R = t.ballRadius;

  // 球心贴两库的角点 (R,R) 距袋心 √2·R ≈ 40.4 mm < 74 mm，算进袋
  assert.equal(t.pocketAt(R, R), corner);
  // 台面外、但仍在捕获圆内（球已经越过库面）——pocketAt 不做 insideBounds 检查
  assert.equal(t.pocketAt(-0.01, 0), corner);
  assert.equal(t.pocketAt(0, -0.07), corner);
  // 台面中部一定不在任何袋里
  assert.equal(t.pocketAt(t.length / 2, t.width / 2), null);
  assert.equal(t.pocketAt(t.length / 2, t.width / 2 + 0.1), null);
});

test('insideBounds：四条边与四角都含端点（>= / <=），差 1e-9 就出界', () => {
  const t = createTable('pool9');
  const b = t.bounds;

  // 恰好贴库：true
  assert.equal(t.insideBounds(b.minX, t.width / 2), true);
  assert.equal(t.insideBounds(b.maxX, t.width / 2), true);
  assert.equal(t.insideBounds(t.length / 2, b.minY), true);
  assert.equal(t.insideBounds(t.length / 2, b.maxY), true);
  // 四角恰好贴两库：true
  assert.equal(t.insideBounds(b.minX, b.minY), true);
  assert.equal(t.insideBounds(b.maxX, b.maxY), true);
  assert.equal(t.insideBounds(b.minX, b.maxY), true);
  assert.equal(t.insideBounds(b.maxX, b.minY), true);

  // 越界 1e-9：false（四条边分别验）
  assert.equal(t.insideBounds(b.minX - 1e-9, t.width / 2), false);
  assert.equal(t.insideBounds(b.maxX + 1e-9, t.width / 2), false);
  assert.equal(t.insideBounds(t.length / 2, b.minY - 1e-9), false);
  assert.equal(t.insideBounds(t.length / 2, b.maxY + 1e-9), false);
});

test('insideBounds：tol 正数放宽、负数收缩（solver 用 -R/2 收缩）', () => {
  const t = createTable('pool9');
  const b = t.bounds;

  assert.equal(t.insideBounds(b.minX - 0.01, t.width / 2, 0.01), true);
  assert.equal(t.insideBounds(b.minX - 0.011, t.width / 2, 0.01), false);
  assert.equal(t.insideBounds(b.maxX + 0.01, t.width / 2, 0.01), true);

  assert.equal(t.insideBounds(b.minX, t.width / 2, -1e-9), false);
  assert.equal(t.insideBounds(b.minX + 1e-9, t.width / 2, -1e-9), true);
  assert.equal(t.insideBounds(b.maxX, t.width / 2, -0.01), false);

  // 默认 tol=0 与显式传 0 等价
  assert.equal(t.insideBounds(b.minX, b.minY), t.insideBounds(b.minX, b.minY, 0));
});

test('insideBounds：只判 bounds 矩形、不查袋口（契约已明确，见 table.js:181）', () => {
  const t = createTable('pool9');
  const R = t.ballRadius;
  // 契约：insideBounds 回答的是"球心在矩形可行域内吗"，进袋由 pocketAt 回答。
  // (R,R) 同时落在左下角袋的捕获圆里，两条判定给出不同答案——这是设计如此，不是错位：
  //   · solver.js:818 拿它当组合球假想点的矩形检查（tol=-R/2），加袋口排除会丢候选；
  //   · rules.js:867 拿它当持球摆位合法性，加袋口排除会改规则。
  // 所以这里断言的是"两者答案不同且各自都符合注释"，任何一边被改动都会红。
  assert.equal(t.pocketAt(R, R)?.id, 'c-bl');
  assert.equal(t.insideBounds(R, R), true);

  // 反向锁：台面中部两者都判"在内/不在袋里"，说明差异只在袋口附近
  const midX = t.length / 2;
  const midY = t.width / 2;
  assert.equal(t.pocketAt(midX, midY), null);
  assert.equal(t.insideBounds(midX, midY), true);
  // 出矩形就一定 false，与袋口无关
  assert.equal(t.insideBounds(t.bounds.minX - 1e-6, t.bounds.minY - 1e-6), false);
});

test('nearestPocket：返回最近的袋心与欧氏距离，与逐袋硬算一致', () => {
  const t = createTable('pool9');
  const samples = [
    [0, 0],
    [t.length, 0],
    [0, t.width],
    [t.length, t.width],
    [t.length / 2, 0.2],
    [t.length / 2, t.width / 2 - 0.1],
    [0.3, 0.2],
  ];
  for (const [x, y] of samples) {
    const near = t.nearestPocket(x, y);
    let best = Infinity;
    let which = null;
    for (const p of t.pockets) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < best) {
        best = d;
        which = p;
      }
    }
    assert.equal(near.pocket, which, `(${x}, ${y}) 最近袋应为 ${which.id}`);
    assert.ok(Math.abs(near.distance - best) < 1e-15, `(${x}, ${y}) 距离 ${near.distance} 应为 ${best}`);
  }
  // 角点上距离为 0
  assert.equal(t.nearestPocket(0, 0).distance, 0);
  // 不做范围检查：台面外的点照样返回最近的袋
  assert.equal(t.nearestPocket(-100, -100).pocket.id, 'c-bl');
});

test('cushionAt：闭区间含两端，中袋缺口与角袋缺口都返回 null', () => {
  const t = createTable('pool9');
  const cfg = TABLE_PRESETS.pool9;
  const halfL = t.length / 2;
  const railBL = t.cushions.find((c) => c.id === 'rail-b-l');

  // from / to 端点都在线段上（闭区间）
  assert.equal(t.cushionAt('y', 0, cfg.cornerJaw), railBL);
  assert.equal(t.cushionAt('y', 0, halfL - cfg.middleJaw), railBL);
  assert.equal(t.cushionAt('y', 0, cfg.cornerJaw / 2), null, '角袋缺口内不应有库边');
  assert.equal(t.cushionAt('y', 0, cfg.cornerJaw - 1e-9), null);
  // 中袋缺口
  assert.equal(t.cushionAt('y', 0, halfL), null);
  assert.equal(t.cushionAt('y', 0, halfL - cfg.middleJaw + 1e-9), null);
  // 越过缺口后落到右段
  assert.equal(t.cushionAt('y', 0, halfL + cfg.middleJaw)?.id, 'rail-b-r');
  assert.equal(t.cushionAt('y', 0, t.length - cfg.cornerJaw)?.id, 'rail-b-r');

  // 两侧短库
  assert.equal(t.cushionAt('x', 0, t.width / 2)?.id, 'rail-l');
  assert.equal(t.cushionAt('x', t.length, t.width / 2)?.id, 'rail-r');
  assert.equal(t.cushionAt('x', 0, cfg.cornerJaw / 2), null);
  assert.equal(t.cushionAt('x', t.length, t.width - cfg.cornerJaw / 2), null);

  // 上库
  assert.equal(t.cushionAt('y', t.width, halfL / 2)?.id, 'rail-t-l');
  assert.equal(t.cushionAt('y', t.width, halfL + 1)?.id, 'rail-t-r');

  // 位置对但轴不对 / 位置不对
  assert.equal(t.cushionAt('x', 0.5, 1), null);
  assert.equal(t.cushionAt('y', 0.5, 1), null);
  // pos 是严格相等比较（契约见 table.js:204）：pos 只取库面所在的台面边界值
  // 0 / t.length / t.width，不是球坐标重算出来的量，所以这里不做容差匹配。
  // 这条用例锁的是"传进去一个算出来近似 0 的值，就该判不在库上"。
  assert.equal(t.cushionAt('y', 0.1 + 0.2 - 0.3, 1), null);
});

test('createTable：未知预设 / null / 袋口不大于球 / 尺寸非正 都抛错', () => {
  assert.throws(() => createTable('不存在的台'), /未知球台预设/);
  assert.throws(() => createTable(null), /未知球台预设/);

  const valid = {
    id: 'custom',
    label: '自定义台',
    length: 1,
    width: 0.5,
    ballRadius: 0.02,
    ballMass: 0.1,
    cornerJaw: 0.03,
    middleJaw: 0.025,
  };

  // 袋口必须**严格大于**球半径：相等也不行
  assert.throws(() => createTable({ ...valid, cornerJaw: valid.ballRadius }), /袋口必须比球大/);
  assert.throws(() => createTable({ ...valid, middleJaw: valid.ballRadius }), /袋口必须比球大/);
  assert.throws(() => createTable({ ...valid, cornerJaw: valid.ballRadius / 2 }), /袋口必须比球大/);

  assert.throws(() => createTable({ ...valid, length: 0 }), /球台参数非法/);
  assert.throws(() => createTable({ ...valid, width: -1 }), /球台参数非法/);
  assert.throws(() => createTable({ ...valid, ballRadius: 0 }), /球台参数非法/);
  assert.throws(() => createTable({ ...valid, ballRadius: -0.02 }), /球台参数非法/);
  assert.throws(() => createTable({ ...valid, length: NaN }), /球台参数非法/);

  // 合法自定义台：字段与几何全部来自传入对象
  const custom = createTable(valid);
  assert.equal(custom.preset, 'custom');
  assert.equal(custom.length, 1);
  assert.equal(custom.bounds.maxX, 1 - 0.02);
  assert.equal(custom.pockets.find((p) => p.id === 'c-tr').captureR, valid.cornerJaw);
  assert.equal(custom.pockets.find((p) => p.id === 'm-t').captureR, valid.middleJaw);
  assert.equal(custom.cushions.length, 6);
});

test('createTable：反向库边段必须抛错（原「已知缺口」已封，契约见 table.js:31）', () => {
  const base = {
    id: 'tiny',
    label: '退化台',
    length: 0.3,
    width: 0.2,
    ballRadius: 0.02,
    ballMass: 0.1,
    cornerJaw: 0.12,
    middleJaw: 0.12,
  };
  // 上一轮这张台是"能建出来、但 rail-b-l 的 from > to"的：极端参数下库边段反向，
  // cushionAt 永远命不中，等于这一段库整段消失，球从缺口直接滚出台面。
  // 现在建台时就抛错，不再静默接受。
  assert.throws(() => createTable(base), /球台参数非法/);

  // 只违反长库条件（halfL - middleJaw <= cornerJaw），短库仍然合法——隔离出这一条校验
  assert.throws(
    () => createTable({ ...base, length: 0.3, width: 0.3, cornerJaw: 0.1, middleJaw: 0.1 }),
    /halfL - middleJaw .* 必须大于 cornerJaw/
  );
  // 恰好相等 = 零长库边段，同样非法
  assert.throws(
    () => createTable({ ...base, length: 0.3, width: 1, cornerJaw: 0.05, middleJaw: 0.1 }),
    /halfL - middleJaw/
  );
  // 只违反短库条件（cornerJaw >= W/2）
  assert.throws(
    () => createTable({ ...base, length: 1, width: 0.2, cornerJaw: 0.1, middleJaw: 0.03 }),
    /短库边段会反向/
  );
});

test('createTable：袋口重叠 / 装不下球 也抛错，三个预设全部通过新校验', () => {
  const base = {
    id: 'custom',
    label: '自定义台',
    length: 1,
    width: 0.5,
    ballRadius: 0.02,
    ballMass: 0.1,
    cornerJaw: 0.03,
    middleJaw: 0.025,
  };
  // 基线合法：否则下面每条都可能被别的原因挡下，测试就抓不到对应的回归
  assert.doesNotThrow(() => createTable(base));

  // 上下中袋捕获圆相交：W <= 2*middleJaw（此处恰好相等）
  assert.throws(() => createTable({ ...base, width: 0.4, middleJaw: 0.2 }), /上下中袋捕获圆相交/);
  // 球心可行域为空：L <= 2R
  assert.throws(() => createTable({ ...base, length: 0.04 }), /装不下直径/);
  assert.throws(() => createTable({ ...base, width: 0.04 }), /装不下直径/);

  // 非有限 / 非正：有限性单独成一条，避免 NaN 落到别的比较上给出误导性信息
  assert.throws(() => createTable({ ...base, length: Infinity }), /length 必须是正的有限数/);
  assert.throws(() => createTable({ ...base, width: NaN }), /width 必须是正的有限数/);
  assert.throws(() => createTable({ ...base, cornerJaw: NaN }), /cornerJaw 必须是正的有限数/);
  assert.throws(() => createTable({ ...base, middleJaw: -0.01 }), /middleJaw 必须是正的有限数/);
  assert.throws(() => createTable({ ...base, ballRadius: -0.02 }), /ballRadius 必须是正的有限数/);

  // 真实预设 + 合法自定义台：每段库边都必须正向且落在台面跨度内
  for (const t of [...PRESET_IDS.map((id) => createTable(id)), createTable(base)]) {
    for (const c of t.cushions) {
      assert.ok(c.from < c.to, `${t.preset}/${c.id}: 库边段反向（${c.from} >= ${c.to}）`);
      assert.ok(c.to <= (c.axis === 'x' ? t.width : t.length), `${t.preset}/${c.id}: 线段越出台面`);
    }
  }
});