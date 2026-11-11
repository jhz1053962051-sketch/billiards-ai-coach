import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTable } from '../src/table.js';
import { TABLE_PRESETS } from '../src/constants.js';
import { createBall, createRollTracker } from '../src/physics.js';
import { createGame, legalTargetNumbers, numbersOnTable, simulateShot, resolveShot } from '../src/rules.js';
import { createStandardRack, createNineBallRack, createRack } from '../src/rack.js';
import { planShot } from '../src/solver.js';
import { interpolateBallStates, sampleDampedCamera } from '../demo/render.js';
import { SAVE_KEY, sanitize, serialize, writeSave, readSave, readSaveStamp, clearSave, describeSave } from '../demo/save.js';
import {
  PRACTICE_KEY,
  PRACTICE_DRILLS,
  PRACTICE_GOALS,
  PRACTICE_FOCUS_MIN_LABELS,
  PRACTICE_FOCUS_WINDOW,
  PRACTICE_DRILL_VARIATIONS,
  PRACTICE_MISS_REASONS,
  appendPracticeResult,
  clearPracticeLog,
  DEFAULT_PRACTICE_GOAL,
  exportPracticeBackup,
  exportPracticeCsv,
  MAX_BACKUP_BYTES,
  practiceDrillLayout,
  parsePracticeBackup,
  MIN_CALIBRATION_SAMPLES,
  readPracticeLog,
  readPracticeGoal,
  replacePracticeLog,
  sanitizePracticeLog,
  summarizeDrills,
  summarizeMissReasons,
  summarizePracticeFocus,
  summarizePractice,
  summarizePracticeDays,
  summarizeTodayPractice,
  writePracticeGoal,
} from '../demo/practice.js';

const table = createTable('pool9');

/** 一个可以当 localStorage 的假对象：只实现存档用到的三个方法 */
function fakeStore() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

function realGame(kind = 'eightball') {
  const balls = createRack(kind, table, { seed: 1 }).map((b) => createBall(b.id, b.x, b.y, b));
  return createGame(table, balls, { names: ['你', '对手'], kind });
}

// ------------------------------------------------------------------ 玩法选择

test('玩法选择：黑八摆 16 颗三角，九球摆 10 颗菱形', () => {
  const eight = createRack('eightball', table, { seed: 3 });
  const nine = createRack('nineball', table, { seed: 3 });
  assert.equal(eight.length, 16, '黑八 = 1 母球 + 15 目标球');
  assert.equal(nine.length, 10, '九球 = 1 母球 + 9 目标球');
  assert.equal(eight.filter((b) => b.number === 0).length, 1);
  assert.equal(nine.filter((b) => b.number === 0).length, 1);
});

test('玩法选择：createRack 不认识玩法就报错，不静默回退黑八', () => {
  assert.throws(() => createRack('snooker', table, { seed: 3 }), /不认识的玩法：snooker/);
  assert.throws(() => createRack('九球', table, { seed: 3 }), /不认识的玩法/);
  assert.throws(() => createRack('nine-ball', table, { seed: 3 }), /不认识的玩法/);
  // 缺省仍然是黑八，那是正常默认值，不能跟着报错
  assert.equal(createRack(undefined, table, { seed: 3 }).length, 16);
});

test('玩法选择：建局时把玩法记下来，未知值直接报错', () => {
  assert.equal(realGame('nineball').kind, 'nineball');
  assert.equal(realGame('eightball').kind, 'eightball');
  const balls = createStandardRack(table, { seed: 2 }).map((b) => createBall(b.id, b.x, b.y, b));
  assert.throws(() => createGame(table, balls, { kind: 'snooker' }), /不认识的玩法：snooker/);
  assert.equal(createGame(table, balls, {}).kind, 'eightball', '不传玩法时默认黑八');
});

test('玩法选择：九球局里没有分组概念', () => {
  const g = realGame('nineball');
  assert.equal(g.players[0].group, null);
  assert.equal(g.players[1].group, null);
  assert.equal(g.open, true, '九球没有 open 这回事，但这个字段保留为 true');
});

// ------------------------------------------------------------------ 存档

test('存档：存进去读出来，局面完全一样', () => {
  const g = realGame('eightball');
  // 造一个"打了几杆"的局面，免得测的是开局态
  const facts = simulateShot(table, g.balls, { angle: g.breakShot ? 0 : 0, speed: 6.6, tip: { a: 0, b: -0.1 } });
  const { next } = resolveShot(g, facts);

  const store = fakeStore();
  assert.equal(writeSave(next, store), true);
  const back = readSave(store);
  assert.ok(back, '应当能读回来');
  assert.equal(back.kind, next.kind);
  assert.equal(back.shots, next.shots);
  assert.equal(back.turn, next.turn);
  assert.equal(back.balls.length, next.balls.length);
  for (let i = 0; i < next.balls.length; i++) {
    assert.equal(back.balls[i].number, next.balls[i].number);
    assert.ok(Math.abs(back.balls[i].x - next.balls[i].x) < 1e-9, `第 ${i} 颗球 x 要一致`);
    assert.ok(Math.abs(back.balls[i].y - next.balls[i].y) < 1e-9, `第 ${i} 颗球 y 要一致`);
  }
});

test('存档：写成文件再读回来，过关卡也不走样', () => {
  const g = realGame('nineball');
  const facts = simulateShot(table, g.balls, { angle: 0, speed: 6.6, tip: { a: 0, b: -0.1 } });
  const { next } = resolveShot(g, facts);

  // 导出到文件走的是 JSON 文本，和 localStorage 那条路不同：数字会变成
  // JSON 数字、undefined 会整键消失。这一步要能把局面原样带回来。
  const text = JSON.stringify(serialize(next, 1700000000000), null, 2);
  const back = sanitize(JSON.parse(text));
  assert.ok(back, '导出的文件必须能读回来');
  assert.equal(back.kind, next.kind);
  assert.equal(back.shots, next.shots);
  assert.equal(back.turn, next.turn);
  assert.equal(back.balls.length, next.balls.length);
  for (let i = 0; i < next.balls.length; i++) {
    assert.equal(back.balls[i].number, next.balls[i].number);
    assert.ok(Math.abs(back.balls[i].x - next.balls[i].x) < 1e-9, `第 ${i} 颗球 x 要一致`);
    assert.ok(Math.abs(back.balls[i].y - next.balls[i].y) < 1e-9, `第 ${i} 颗球 y 要一致`);
    assert.equal(back.balls[i].pocketed, next.balls[i].pocketed);
  }
  // 手改文本（有人会这么干）：球位挪出台面就必须整份丢掉，不能装一半。
  const tampered = JSON.parse(text);
  tampered.balls[0].x = 99;
  assert.equal(sanitize(tampered), null);
  // 玩法名写错同理，别悄悄按黑八读进来。
  const wrongKind = JSON.parse(text);
  wrongKind.kind = 'snooker';
  assert.equal(sanitize(wrongKind), null);
});

test('存档：不存 log 与 history（回放和撤销历史不跨会话）', () => {
  const g = realGame('eightball');
  const raw = serialize(g);
  // serialize 返回的是扁平的一层（v / savedAt / table / balls / ...），不是嵌套 game。
  assert.equal('log' in raw, false, 'log 不存');
  assert.equal('history' in raw, false, 'history 不存（它本来也不在 game 上）');
  assert.ok(raw.balls, '球位要存');
  assert.equal(raw.kind, 'eightball', '玩法要存');
});

test('存档：坏数据一律丢掉，不返回半个局面', () => {
  const store = fakeStore();
  const bad = [
    'not json at all',
    '{}',
    JSON.stringify({ v: 999, game: {} }),
    JSON.stringify({ v: 1, game: { table: { id: 'pool9' }, balls: [], players: [] } }),
    // 没有母球
    JSON.stringify({
      v: 1,
      game: {
        table: { id: 'pool9' },
        balls: [{ number: 1, x: 0.5, y: 0.5, pocketed: false }],
        players: [{ name: 'a' }, { name: 'b' }],
      },
    }),
    // 球位是 NaN
    JSON.stringify({
      v: 1,
      game: {
        table: { id: 'pool9' },
        balls: [
          { number: 0, x: NaN, y: 0.5, pocketed: false },
          { number: 1, x: 0.5, y: 0.5, pocketed: false },
        ],
        players: [{ name: 'a' }, { name: 'b' }],
      },
    }),
    // 只有一名玩家
    JSON.stringify({
      v: 1,
      game: {
        table: { id: 'pool9' },
        balls: [
          { number: 0, x: 0.2, y: 0.5, pocketed: false },
          { number: 1, x: 0.5, y: 0.5, pocketed: false },
        ],
        players: [{ name: 'a' }],
      },
    }),
  ];
  for (const [i, text] of bad.entries()) {
    store.setItem(SAVE_KEY, text);
    assert.equal(readSave(store), null, `第 ${i} 条坏数据必须被丢掉`);
  }
});

test('存档：sanitize 直接吃 null / undefined / 数组也不炸', () => {
  assert.equal(sanitize(null), null);
  assert.equal(sanitize(undefined), null);
  assert.equal(sanitize([]), null);
  assert.equal(sanitize('x'), null);
});

test('存档：球跑出台面、球台或玩法认不出来，都要整份丢掉', () => {
  // 文件头写着「球位越界或重复就整份丢掉」，但代码里原本只判了 isFiniteNumber：
  // 手改一个 x=1e9 照样能读回来，球会被画到台面外。这条测试守的就是那句话。
  const good = serialize(realGame());
  assert.ok(sanitize(good), '基准存档本身必须能读回来，不能误杀正常球位');

  const target = good.balls.find((b) => b.number !== 0 && !b.pocketed);
  assert.ok(target, '基准存档里得有一颗在台上的目标球');
  const withBall = (patch) => ({
    ...good,
    balls: good.balls.map((b) => (b === target ? { ...b, ...patch } : b)),
  });

  assert.equal(sanitize(withBall({ x: 1e9 })), null, 'x 飞出台面必须丢');
  assert.equal(sanitize(withBall({ y: -5 })), null, 'y 落到库外必须丢');
  assert.equal(sanitize({ ...good, table: { id: 'no-such-table' } }), null, '认不出的球台必须丢');
  assert.equal(sanitize({ ...good, kind: 'snooker' }), null, '认不出的玩法必须丢');

  // 落袋的球坐标在袋口，本来就可能落在 bounds 之外，不能因此判坏档
  const potted = good.balls.find((b) => b.pocketed);
  if (potted) {
    const moved = { ...good, balls: good.balls.map((b) => (b === potted ? { ...b, x: 0, y: 0 } : b)) };
    assert.ok(sanitize(moved), '落袋球的坐标不该被台面范围卡掉');
  }
});

test('存档：删掉之后读不到，describeSave 也说没有', () => {
  const store = fakeStore();
  writeSave(realGame('nineball'), store);
  assert.ok(describeSave(store), '存了之后要有描述');
  clearSave(store);
  assert.equal(readSave(store), null);
  assert.equal(describeSave(store), null);
});

test('存档：写入时间戳是可比对的，好让另一个标签页认出「这份我没见过」', () => {
  const g = realGame('eightball');
  const store = fakeStore();

  // 没存过的时候读不到时间戳，页面才不会把「没有存档」误判成「被改过」
  assert.equal(readSaveStamp(store), null);

  assert.equal(writeSave(g, store, { now: 1700000000000 }), true);
  assert.equal(readSaveStamp(store), 1700000000000);
  // 时间戳必须真的留在存档里，只写在 writeSave 的参数上没用
  assert.equal(readSave(store).savedAt, 1700000000000);

  // 再存一次就是新的时间戳
  assert.equal(writeSave(g, store, { now: 1700000001000 }), true);
  assert.equal(readSaveStamp(store), 1700000001000);

  // 手改存档把 savedAt 删掉：当作比任何真实时间戳都旧，但整份不许丢
  const raw = JSON.parse(store.getItem(SAVE_KEY));
  delete raw.savedAt;
  store.setItem(SAVE_KEY, JSON.stringify(raw));
  assert.equal(readSaveStamp(store), 0);
  assert.ok(readSave(store), '少一个时间戳不该让整份存档作废');

  // 承认不了内容的时候也不能抛
  store.setItem(SAVE_KEY, '{');
  assert.equal(readSaveStamp(store), null);
});

test('存档：没有 localStorage 时 writeSave 返回 false，不抛错', () => {
  assert.equal(writeSave(realGame(), null), false, '传 null store 应当安全失败');
  assert.equal(readSave(null), null);
  assert.equal(describeSave(null), null);
  assert.doesNotThrow(() => clearSave(null));
});

test('存档：描述里带够判断信息（杆数、台面颗数、球台、轮到谁）', () => {
  const store = fakeStore();
  const g = realGame('nineball');
  writeSave(g, store);
  const d = describeSave(store);
  assert.equal(typeof d.shots, 'number');
  assert.equal(typeof d.onTable, 'number');
  assert.equal(d.tableId, 'pool9');
  assert.equal(d.turn, g.turn);
  assert.equal(d.ended, false);
});

test('存档：九球局读回来还是九球，不会变回黑八', () => {
  const store = fakeStore();
  writeSave(realGame('nineball'), store);
  const back = readSave(store);
  assert.equal(back.kind, 'nineball');
  assert.equal(back.balls.filter((b) => b.number !== 0 && !b.pocketed).length, 9);
});

// ---------------------------------------------------------- 实战练习记录

function practiceResult(overrides = {}) {
  return {
    timestamp: 1_800_000_000_000,
    made: true,
    toleranceDeg: 0.15,
    difficulty: 42,
    speed: 2.4,
    targetNumber: 3,
    pocketId: 'c-bl',
    tableId: 'pool9',
    ...overrides,
  };
}

test('实战记录：跨刷新持久化，只汇总手动录入的真实结果', () => {
  const store = fakeStore();
  assert.equal(appendPracticeResult(practiceResult(), store), true);
  assert.equal(appendPracticeResult(practiceResult({ timestamp: 1_800_000_000_001, made: false, toleranceDeg: 0.3 }), store), true);

  const records = readPracticeLog(store);
  assert.equal(records.length, 2);
  assert.equal(records[0].made, true);
  assert.equal(records[1].made, false);
  const summary = summarizePractice(records);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.made, 1);
  assert.equal(summary.rate, 0.5);
  assert.equal(summary.recent.attempts, 2);
  assert.equal(summary.tolerance.narrow.attempts, 1);
  assert.equal(summary.tolerance.narrow.rate, 1);
  assert.equal(summary.tolerance.medium.attempts, 1);
  assert.equal(summary.tolerance.medium.rate, 0);
  assert.equal(store.getItem(PRACTICE_KEY) !== null, true);
});

test('实战校准：每个容错区间至少 20 杆才显示 Wilson 95% 区间', () => {
  const records = Array.from({ length: MIN_CALIBRATION_SAMPLES - 1 }, (_, i) =>
    practiceResult({ timestamp: 1_800_000_000_000 + i, made: i < 10 })
  );
  const beforeThreshold = summarizePractice(records);
  assert.equal(beforeThreshold.tolerance.narrow.confidence95, undefined);
  assert.equal(beforeThreshold.tolerance.medium.confidence95, undefined);

  records.push(
    practiceResult({
      timestamp: 1_800_000_000_100,
      made: false,
      toleranceDeg: 0.15,
    })
  );
  const calibrated = summarizePractice(records);
  const interval = calibrated.tolerance.narrow.confidence95;
  assert.equal(calibrated.tolerance.narrow.attempts, MIN_CALIBRATION_SAMPLES);
  assert.ok(interval, '满 20 杆应显示置信区间');
  assert.ok(interval.low > 0.29 && interval.low < 0.31, `下界应约 30%，实际 ${interval.low}`);
  assert.ok(interval.high > 0.69 && interval.high < 0.71, `上界应约 70%，实际 ${interval.high}`);
  assert.equal(calibrated.tolerance.medium.confidence95, undefined);
});

test('实战趋势：按本地日历汇总最近 7 天，未练习日保留空档', () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  const records = [
    practiceResult({ timestamp: new Date(2026, 9, 28, 12).getTime(), made: true }),
    practiceResult({ timestamp: new Date(2026, 10, 2, 9).getTime(), made: true }),
    practiceResult({ timestamp: new Date(2026, 10, 2, 10).getTime(), made: false }),
    practiceResult({ timestamp: new Date(2026, 10, 3, 8).getTime(), made: false }),
    practiceResult({ timestamp: new Date(2026, 10, 4, 8).getTime(), made: true }),
  ];
  const trend = summarizePracticeDays(records, now);
  assert.equal(trend.days.length, 7);
  assert.deepEqual(trend.days.map((day) => day.label), ['10/28', '10/29', '10/30', '10/31', '11/1', '11/2', '11/3']);
  assert.equal(trend.days[0].rate, 1);
  assert.equal(trend.days[1].rate, null);
  assert.equal(trend.days[5].attempts, 2);
  assert.equal(trend.days[5].rate, 0.5);
  assert.equal(trend.attempts, 4);
  assert.equal(trend.made, 2);
  assert.equal(trend.rate, 0.5);
  assert.equal(trend.activeDays, 3);
  assert.equal(trend.streak, 2);
});

test('实战趋势：连续天数允许今天未练，并忽略未来日期', () => {
  const now = new Date(2026, 10, 3, 12).getTime();
  const recordAt = (year, month, day) => practiceResult({
    timestamp: new Date(year, month, day, 9).getTime(),
  });
  assert.equal(summarizePracticeDays([
    recordAt(2026, 10, 1),
    recordAt(2026, 10, 2),
    recordAt(2026, 10, 4),
  ], now).streak, 2);
  assert.equal(summarizePracticeDays([
    recordAt(2026, 9, 31),
    recordAt(2026, 10, 2),
  ], now).streak, 1);
  assert.equal(summarizePracticeDays([
    recordAt(2026, 10, 4),
  ], now).streak, 0);
});

test('每日目标：本机保存、验证选项并只统计今天的真实练习杆数', () => {
  const store = fakeStore();
  assert.equal(readPracticeGoal(store), DEFAULT_PRACTICE_GOAL);
  assert.equal(writePracticeGoal(5, store), true);
  assert.equal(readPracticeGoal(store), 5);
  assert.equal(writePracticeGoal(7, store), false);
  assert.equal(writePracticeGoal('10', store), false);
  assert.equal(readPracticeGoal(store), 5);
  assert.equal(readPracticeGoal(null), DEFAULT_PRACTICE_GOAL);
  assert.equal(writePracticeGoal(10, null), false);
  assert.deepEqual(PRACTICE_GOALS, [5, 10, 20]);

  const now = new Date(2026, 10, 3, 12).getTime();
  const today = new Date(2026, 10, 3, 9).getTime();
  const records = [
    practiceResult({ timestamp: new Date(2026, 10, 2, 9).getTime() }),
    ...Array.from({ length: 5 }, (_, i) =>
      practiceResult({ timestamp: today + i, made: i < 3 })
    ),
    practiceResult({ timestamp: now + 60_000 }),
  ];
  assert.deepEqual(summarizeTodayPractice(records, 5, now), {
    date: '2026-11-03',
    goal: 5,
    attempts: 5,
    made: 3,
    remaining: 0,
    progress: 1,
    complete: true,
  });
  const defaultGoal = summarizeTodayPractice(records, 7, now);
  assert.equal(defaultGoal.goal, DEFAULT_PRACTICE_GOAL);
  assert.equal(defaultGoal.progress, 0.5);
  assert.equal(defaultGoal.complete, false);
});

test('实战记录：拒绝非法数据并限制存储上限', () => {
  const store = fakeStore();
  assert.equal(appendPracticeResult(practiceResult({ made: 1 }), store), false);
  assert.equal(appendPracticeResult(practiceResult({ toleranceDeg: Infinity }), store), false);
  assert.equal(appendPracticeResult(practiceResult({ timestamp: Number.MAX_SAFE_INTEGER }), store), false);
  assert.equal(readPracticeLog(store).length, 0);
  assert.equal(sanitizePracticeLog({ v: 1, records: [practiceResult(), { made: true }] }).length, 1);

  for (let i = 0; i < 505; i++) {
    assert.equal(appendPracticeResult(practiceResult({ timestamp: 1_800_000_000_000 + i }), store), true);
  }
  const records = readPracticeLog(store);
  assert.equal(records.length, 500);
  assert.equal(records[0].timestamp, 1_800_000_000_005);
});

test('实战记录：清空与存储不可用时返回明确状态', () => {
  const store = fakeStore();
  appendPracticeResult(practiceResult(), store);
  assert.equal(clearPracticeLog(store), true);
  assert.deepEqual(readPracticeLog(store), []);
  assert.equal(appendPracticeResult(practiceResult(), null), false);
  assert.equal(clearPracticeLog(null), false);
});

test('实战记录备份：完整往返、严格校验，并只在有效时替换', () => {
  const store = fakeStore();
  const records = [
    practiceResult({ timestamp: 1_800_000_000_000, drillId: 'cut', made: false, missReason: 'speed' }),
    practiceResult({ timestamp: 1_800_000_000_100, drillId: 'straight' }),
  ];
  assert.equal(appendPracticeResult(practiceResult({ timestamp: 1_700_000_000_000 }), store), true);

  const backup = exportPracticeBackup(records, 1_800_000_100_000);
  const parsed = parsePracticeBackup(backup);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].missReason, 'speed');
  assert.equal(parsed[0].drillId, 'cut');
  assert.equal(replacePracticeLog(parsed, store), true);
  assert.deepEqual(readPracticeLog(store), parsed);

  const previous = readPracticeLog(store);
  const invalidBackups = [
    '{invalid json',
    JSON.stringify({ v: 2, records }),
    JSON.stringify({ v: 1, records: [records[0], { ...records[1], speed: Infinity }] }),
    JSON.stringify({ v: 1, records: Array(501).fill(records[0]) }),
    ' '.repeat(MAX_BACKUP_BYTES + 1),
  ];
  for (const invalid of invalidBackups) {
    assert.equal(parsePracticeBackup(invalid), null);
    assert.equal(replacePracticeLog(parsePracticeBackup(invalid), store), false);
    assert.deepEqual(readPracticeLog(store), previous);
  }
  assert.deepEqual(parsePracticeBackup(exportPracticeBackup([], 1_800_000_100_000)), []);
  assert.equal(replacePracticeLog([], store), true);
  assert.deepEqual(readPracticeLog(store), []);
});

test('实战记录导出：CSV 包含中文表头、训练类型并正确转义公式与特殊字符', () => {
  const csv = exportPracticeCsv([
    practiceResult({
      timestamp: 1_800_000_000_000,
      drillId: 'cut',
      missReason: 'speed',
      made: false,
      pocketId: 'c,"b',
      tableId: '=sheet',
    }),
  ]);
  assert.ok(csv.startsWith('\uFEFF"时间","结果","未进原因","训练类型"'));
  assert.ok(csv.includes('"切球"'));
  assert.ok(csv.includes('"力度控制"'));
  assert.ok(csv.includes('"c,""b"'));
  assert.ok(csv.includes('"\u0027=sheet"'));
  assert.ok(csv.includes('"未进"'));
  assert.equal(exportPracticeCsv([]), '\uFEFF"时间","结果","未进原因","训练类型","目标球","目标袋","容错角度(度)","难度","建议力度(m/s)","球台"\r\n');
});

test('实战未进原因：旧记录兼容，只统计已标注的未进原因', () => {
  const records = [
    practiceResult({ made: false, missReason: 'aim' }),
    practiceResult({ made: false, missReason: 'speed' }),
    practiceResult({ made: false }),
    practiceResult({ made: true }),
  ];
  assert.equal(sanitizePracticeLog({ v: 1, records }).length, 4);
  assert.equal(sanitizePracticeLog({ v: 1, records: [practiceResult({ made: true, missReason: 'aim' })] }).length, 0);
  assert.equal(sanitizePracticeLog({ v: 1, records: [practiceResult({ made: false, missReason: 'unknown' })] }).length, 0);
  const summary = summarizeMissReasons(records);
  assert.equal(summary.misses, 3);
  assert.equal(summary.labeled, 2);
  assert.equal(summary.unclassified, 1);
  assert.equal(summary.counts.aim, 1);
  assert.equal(summary.counts.speed, 1);
  assert.deepEqual(Object.keys(summary.counts), PRACTICE_MISS_REASONS.map(({ id }) => id));
});

test('实战训练建议：样本不足或原因分散时不武断，原因集中时推荐对应专项训练', () => {
  const misses = (reason, count) => Array.from({ length: count }, (_, index) =>
    practiceResult({
      timestamp: 1_800_000_000_000 + index,
      made: false,
      missReason: reason,
    })
  );

  const insufficient = summarizePracticeFocus(misses('aim', PRACTICE_FOCUS_MIN_LABELS - 1));
  assert.equal(insufficient.reason, null);
  assert.equal(insufficient.drillId, null);
  assert.equal(insufficient.labeled, PRACTICE_FOCUS_MIN_LABELS - 1);

  const mixed = summarizePracticeFocus([
    ...misses('aim', 1),
    ...misses('speed', 1),
    ...misses('contact', 1),
  ]);
  assert.equal(mixed.reason, null, '原因分散不能硬判一个主要薄弱项');

  const contact = summarizePracticeFocus([
    ...misses('aim', 1),
    ...misses('contact', 2),
  ]);
  assert.equal(contact.reason, 'contact');
  assert.equal(contact.drillId, 'cut');

  const position = summarizePracticeFocus(misses('position', 3));
  assert.equal(position.reason, 'position');
  assert.equal(position.drillId, null, '没有对应的专项摆球时不提供无效的一键训练');

  const recent = summarizePracticeFocus([
    ...misses('contact', PRACTICE_FOCUS_WINDOW),
    ...misses('aim', PRACTICE_FOCUS_WINDOW),
  ]);
  assert.equal(recent.window, PRACTICE_FOCUS_WINDOW);
  assert.equal(recent.reason, 'aim', '分析只应使用最近 20 次未进');
});

test('专项练习：各球台预设均有合法且不重叠的球位', () => {
  for (const preset of Object.keys(TABLE_PRESETS)) {
    const drillTable = createTable(preset);
    for (const drill of PRACTICE_DRILLS) {
      const layouts = Array.from({ length: PRACTICE_DRILL_VARIATIONS }, (_, variation) =>
        practiceDrillLayout(drillTable, drill.id, variation)
      );
      for (const { cue, target } of layouts) {
        assert.equal(drillTable.insideBounds(cue.x, cue.y), true, `${preset}/${drill.id} 母球在台内`);
        assert.equal(drillTable.insideBounds(target.x, target.y), true, `${preset}/${drill.id} 目标球在台内`);
        assert.ok(Math.hypot(cue.x - target.x, cue.y - target.y) > 2 * drillTable.ballRadius);
      }
      assert.equal(
        new Set(layouts.map(({ cue, target }) => `${cue.x.toFixed(3)},${cue.y.toFixed(3)},${target.x.toFixed(3)},${target.y.toFixed(3)}`)).size,
        PRACTICE_DRILL_VARIATIONS,
        `${preset}/${drill.id} 的轮换球位应互不相同`,
      );
      assert.equal(
        new Set(layouts.map(({ pocketId }) => pocketId)).size,
        PRACTICE_DRILL_VARIATIONS,
        `${preset}/${drill.id} 应覆盖六个不同目标袋`,
      );
    }
  }
  assert.equal(practiceDrillLayout(table, 'straight', PRACTICE_DRILL_VARIATIONS).variation, 0);
  assert.equal(practiceDrillLayout(table, 'straight', -1).variation, PRACTICE_DRILL_VARIATIONS - 1);
  assert.throws(() => practiceDrillLayout(table, 'unknown'), /未知专项练习/);
});

test('专项练习：旧记录兼容，5 杆中至少命中 4 杆才算达标', () => {
  const legacy = sanitizePracticeLog({ v: 1, records: [practiceResult()] });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].drillId, null);

  const records = [
    ...Array.from({ length: 5 }, (_, i) =>
      practiceResult({ timestamp: 1_800_000_000_000 + i, drillId: 'straight', made: i < 4 })
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      practiceResult({ timestamp: 1_800_000_000_010 + i, drillId: 'straight', made: i < 2 })
    ),
    practiceResult({ timestamp: 1_800_000_000_020, drillId: 'cut', made: false }),
  ];
  const summary = summarizeDrills(records);
  assert.equal(summary.straight.passedSets, 1);
  assert.equal(summary.straight.currentSetAttempts, 4);
  assert.equal(summary.straight.currentSetMade, 2);
  assert.equal(summary.cut.passedSets, 0);
  assert.equal(summary.cut.currentSetAttempts, 1);
  assert.equal(sanitizePracticeLog({
    v: 1,
    records: [practiceResult({ drillId: 'not-a-drill' })],
  }).length, 0);
});

test('击球回放：球位在物理帧之间连续插值，落袋状态不闪回台面', () => {
  const from = [
    { id: 'cue', x: 1, y: 0.5, pocketed: false },
    { id: 'obj', x: 2, y: 0.5, pocketed: false },
  ];
  const to = [
    { id: 'cue', x: 1.2, y: 0.6, pocketed: false },
    { id: 'obj', x: 2.2, y: 0.7, pocketed: false },
  ];
  const middle = interpolateBallStates(from, to, 0.5);
  assert.equal(middle[0].x, 1.1);
  assert.equal(middle[0].y, 0.55);
  assert.equal(middle[1].y, 0.6);
  assert.equal(interpolateBallStates(from, to, -1)[0].x, 1);
  assert.equal(interpolateBallStates(from, to, 2)[0].x, 1.2);

  const pocketed = [{ ...to[0], pocketed: true, pocket: 'c-bl' }, to[1]];
  assert.deepEqual(interpolateBallStates(from, pocketed, 0.9)[0], from[0]);
  assert.deepEqual(interpolateBallStates(pocketed, to, 0.9)[0], pocketed[0]);
});

test('球面标记：运动距离驱动条纹与号码盘滚动，并可跨帧插值', () => {
  const balls = [{ x: 0, y: 0, rollAngle: 0 }];
  const trackRoll = createRollTracker(balls, 0.1);
  assert.equal(trackRoll()[0].rollAngle, 0);

  balls[0].x = 0.2;
  const [pose] = trackRoll();
  assert.ok(Math.abs(pose.rollAngle - 2) < 1e-12);
  assert.equal(pose.rollDirX, 1);
  assert.equal(pose.rollDirY, 0);

  const mid = interpolateBallStates(
    [{ ...balls[0], ...pose }],
    [{ ...balls[0], ...pose, x: 0.3, rollAngle: 3 }],
    0.5
  );
  assert.equal(mid[0].rollAngle, 2.5);
  assert.equal(mid[0].rollDirX, 1);
});

test('相机切换：阻尼运镜保留当前速度并平稳落位', () => {
  const start = sampleDampedCamera(0.35, 1, 0.4, 0);
  assert.equal(start.value, 0.35);
  assert.ok(Math.abs(start.velocity - 0.4) < 1e-12);

  const mid = sampleDampedCamera(0.35, 1, 0.4, 0.2);
  const settled = sampleDampedCamera(0.35, 1, 0.4, 1.5);
  assert.ok(mid.value > 0.35 && mid.value < 1);
  assert.ok(mid.velocity > 0, '切换中应保留相机运动惯性');
  assert.ok(Math.abs(settled.value - 1) < 0.001);
  assert.ok(Math.abs(settled.velocity) < 0.001);
});

test('击球回放：录制帧从出杆前球位开始并以仿真最终状态结束', () => {
  const cue = createBall('cue', 0.6, 0.635, { number: 0 });
  const target = createBall('b1', 1.3, 0.635, { number: 1 });
  const facts = simulateShot(
    table,
    [cue, target],
    { angle: 0, speed: 2.2, tip: { a: 0, b: 0.4 } },
    { record: true, dt: 1 / 120 }
  );
  assert.ok(facts.frames.length > 1);
  assert.deepEqual(
    facts.frames[0].map(({ x, y }) => ({ x, y })),
    [{ x: cue.x, y: cue.y }, { x: target.x, y: target.y }]
  );
  assert.deepEqual(
    facts.frames.at(-1).map(({ x, y, pocketed }) => ({ x, y, pocketed })),
    facts.ballsAfter.map(({ x, y, pocketed }) => ({ x, y, pocketed }))
  );
});

// ------------------------------------------------------------------ 手动出杆（只测能测的部分）

test('手动出杆：力度真的会改变结果，且杆法会被用上', () => {
  // 练习页的手动出杆最终就是「拿用户设的 speed/angle/tip 调 simulateShot」。
  // 这条不测"力度大就滚得远"——母球撞进三角阵之后位移由碰撞决定，
  // 大力反而可能被反弹回来（实测 6.6 m/s 只位移 1.085、1.2 m/s 位移 1.244）。
  // 测的是力度真的进了物理核：同一瞄准角、不同力度，最终局面必须不同。
  const balls = createStandardRack(table, { seed: 7 }).map((b) => createBall(b.id, b.x, b.y, b));
  const gentle = simulateShot(table, balls, { angle: 0, speed: 1.2, tip: { a: 0, b: 0 } });
  const hard = simulateShot(table, balls, { angle: 0, speed: 6.6, tip: { a: 0, b: 0 } });
  assert.equal(gentle.settled, true);
  assert.equal(hard.settled, true);

  const diff = gentle.ballsAfter.reduce((acc, b, i) => {
    const h = hard.ballsAfter[i];
    return acc + Math.hypot(b.x - h.x, b.y - h.y);
  }, 0);
  assert.ok(diff > 0.05, `不同力度打出来的局面必须不同，实际总差 ${diff.toFixed(4)}`);

  // 开球架子上母球必然撞到球堆，两杆都不该判"没碰到球"
  assert.ok(gentle.firstContact !== null, '轻力也要碰到球');
  assert.ok(hard.firstContact !== null, '大力也要碰到球');
});

test('手动出杆：杆法（高/低杆）真的会改变母球停位', () => {
  // 直接正撞一颗球，高杆跟进 / 低杆退缩的差别是教科书级的，
  // 所以这里可以放心断言"两者停位不同"，不用担心是噪声。
  const balls = [createBall('cue', table.length * 0.5, table.width * 0.5, { number: 0 })];
  balls.push(createBall('b1', table.length * 0.5 + 0.4, table.width * 0.5, { number: 1 }));
  const high = simulateShot(table, balls, { angle: 0, speed: 3, tip: { a: 0, b: 0.45 } });
  const low = simulateShot(table, balls, { angle: 0, speed: 3, tip: { a: 0, b: -0.45 } });
  const cHigh = high.ballsAfter.find((b) => b.number === 0);
  const cLow = low.ballsAfter.find((b) => b.number === 0);
  assert.ok(
    cHigh.x > cLow.x,
    `高杆母球该比低杆更靠前：高杆 x=${cHigh.x.toFixed(3)} vs 低杆 x=${cLow.x.toFixed(3)}`
  );
});

test('手动出杆：左右塞真的会改变母球路线（不是只改文案）', () => {
  const balls = [createBall('cue', table.length * 0.5, table.width * 0.5, { number: 0 })];
  balls.push(createBall('b1', table.length * 0.5 + 0.5, table.width * 0.5 + 0.3, { number: 1 }));
  const plain = simulateShot(table, balls, { angle: 0, speed: 3, tip: { a: 0, b: 0 } });
  const side = simulateShot(table, balls, { angle: 0, speed: 3, tip: { a: 0.4, b: 0 } });
  const p = plain.ballsAfter.find((b) => b.number === 0);
  const s = side.ballsAfter.find((b) => b.number === 0);
  const moved = Math.hypot(p.x - s.x, p.y - s.y);
  assert.ok(moved > 1e-3, `加了 0.4 的塞，母球落点应当不同，实际只差 ${moved}`);
});

// ------------------------------------------------------------------ 键盘（逻辑层）

test('键盘：方向键微调受滑块范围约束，不会跑出 min/max', () => {
  // demo/app.js 的 nudgeManual 逻辑是 clamp(值 + 步长, min, max)。
  // 这里把它按同样的表达式复算一遍，钉住"不会越界"这条性质。
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const min = 0.55;
  const max = 6.6;
  let v = max;
  for (let i = 0; i < 100; i++) v = clamp(v + 0.1, min, max);
  assert.equal(v, max, '一直按 ↑ 最多到上限');
  v = min;
  for (let i = 0; i < 100; i++) v = clamp(v - 0.1, min, max);
  assert.equal(v, min, '一直按 ↓ 最多到下限');
});

test('键盘：瞄准偏移同样被夹在 −8..8 之间', () => {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let v = 0;
  for (let i = 0; i < 500; i++) v = clamp(v - 0.1, -8, 8);
  assert.equal(v, -8);
  for (let i = 0; i < 500; i++) v = clamp(v + 0.1, -8, 8);
  assert.equal(v, 8);
});

// ------------------------------------------------------------------ 九球整局

test('九球整局：九球局能真的打到分出胜负（不卡死）', () => {
  // 这条与 rules.test.js 里黑八那条对应。九球的关键差异是「只能先碰最小号」，
  // 一旦最小号贴库就很容易双方来回打——所以这里必须真的跑到 ended。
  const seeds = [1, 7, 42];
  for (const seed of seeds) {
    const balls = createNineBallRack(table, { seed }).map((b) => createBall(b.id, b.x, b.y, b));
    let game = createGame(table, balls, { kind: 'nineball' });

    for (let i = 0; i < 300 && game.phase !== 'ended'; i++) {
      const allow = legalTargetNumbers(game, numbersOnTable(game.balls));
      if (!allow.length) break;
      if (game.ballInHand) {
        const cue = game.balls.find((b) => b.number === 0);
        const zone = game.ballInHand.zone;
        cue.x = zone === 'kitchen' ? table.length * 0.12 : table.length * 0.5;
        cue.y = table.width * 0.5;
        cue.pocketed = false;
        game.ballInHand = null;
      }
      const { plan } = planShot(table, game, { allow, safety: true });
      if (!plan) break;
      const facts = simulateShot(table, game.balls, {
        angle: plan.aimAngle,
        speed: plan.speed,
        tip: { a: plan.tip.a, b: plan.tip.b },
      });
      game = resolveShot(game, facts).next;
    }
    assert.equal(game.phase, 'ended', `seed=${seed} 的九球局应当打完，实际停在 ${game.shots} 杆`);
    assert.ok(game.winner === 0 || game.winner === 1, '必须有一方获胜');
  }
});
