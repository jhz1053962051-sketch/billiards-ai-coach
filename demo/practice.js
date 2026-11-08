// 用户手动记录的真实球桌练习结果；与演示物理结果分开存储。

const KEY = 'pool-ai-coach/practice/v1';
const GOAL_KEY = 'pool-ai-coach/practice-goal/v1';
const MAX_RECORDS = 500;
export const MAX_BACKUP_BYTES = 1_000_000;
export const MIN_CALIBRATION_SAMPLES = 20;
export const DRILL_SET_SIZE = 5;
export const DRILL_SET_TARGET = 4;
export const PRACTICE_FOCUS_WINDOW = 20;
export const PRACTICE_FOCUS_MIN_LABELS = 3;
export const PRACTICE_DRILL_VARIATIONS = 6;
export const PRACTICE_GOALS = [5, 10, 20];
export const DEFAULT_PRACTICE_GOAL = 10;

export const PRACTICE_MISS_REASONS = [
  { id: 'aim', label: '瞄准偏差' },
  { id: 'speed', label: '力度控制' },
  { id: 'contact', label: '击球厚薄' },
  { id: 'spin', label: '杆法/旋转' },
  { id: 'position', label: '走位/线路' },
  { id: 'other', label: '其他' },
];

const MISS_REASON_BY_ID = new Map(PRACTICE_MISS_REASONS.map((reason) => [reason.id, reason]));

export const PRACTICE_DRILLS = [
  {
    id: 'straight',
    name: '直线球',
    description: '先练稳定击中甜点：正面击球，熟悉瞄准线与轻柔出杆。',
    distance: 0.72,
    cutDeg: 0,
    focus: '瞄准与出杆稳定',
  },
  {
    id: 'cut',
    name: '切球',
    description: '练习约 30° 切角；优先观察目标球路线，不要只盯着母球。',
    distance: 0.95,
    cutDeg: 30,
    focus: '切角与目标球路线',
  },
  {
    id: 'long',
    name: '长台球',
    description: '拉长母球到目标球距离，练习瞄准精度与稳定节奏。',
    distance: 1.5,
    cutDeg: 8,
    focus: '长距离瞄准',
  },
];

const DRILL_BY_ID = new Map(PRACTICE_DRILLS.map((drill) => [drill.id, drill]));

export function practiceDrillLayout(table, drillId, variation = 0) {
  const drill = DRILL_BY_ID.get(drillId);
  if (!drill) throw new Error(`未知专项练习: ${drillId}`);

  const variant = Number.isSafeInteger(variation)
    ? ((variation % PRACTICE_DRILL_VARIATIONS) + PRACTICE_DRILL_VARIATIONS) % PRACTICE_DRILL_VARIATIONS
    : 0;
  const distanceScales = [1, 1.12, 0.9, 1.2, 0.96, 1.06];
  const R = table.ballRadius;
  const layouts = [
    { pocketId: 'c-br', x: table.length - 0.85, y: table.width * 0.28 },
    { pocketId: 'c-bl', x: 0.85, y: table.width * 0.30 },
    { pocketId: 'c-tr', x: table.length - 0.78, y: table.width * 0.74 },
    { pocketId: 'c-tl', x: 0.97, y: table.width * 0.68 },
    { pocketId: 'm-b', x: table.length / 2 + 0.24, y: table.width * 0.28 },
    { pocketId: 'm-t', x: table.length / 2 - 0.24, y: table.width * 0.72 },
  ];
  const targetLayout = layouts[variant];
  const target = { x: targetLayout.x, y: targetLayout.y };
  const pocket = table.pockets.find((item) => item.id === targetLayout.pocketId);
  if (!pocket) throw new Error(`专项练习 ${drillId} 找不到目标袋 ${targetLayout.pocketId}`);
  const outX = pocket.x - target.x;
  const outY = pocket.y - target.y;
  const outLength = Math.hypot(outX, outY);
  const outAngle = Math.atan2(outY, outX);
  const cueAngle = outAngle + (drill.cutDeg * Math.PI) / 180;
  const dirX = Math.cos(cueAngle);
  const dirY = Math.sin(cueAngle);
  const margin = 0.05;
  const maxCueDistance = Math.min(
    dirX > 0
      ? (target.x - table.bounds.minX - margin) / dirX
      : dirX < 0 ? (table.bounds.maxX - target.x - margin) / -dirX : Infinity,
    dirY > 0
      ? (target.y - table.bounds.minY - margin) / dirY
      : dirY < 0 ? (table.bounds.maxY - target.y - margin) / -dirY : Infinity,
  );
  const cueDistance = Math.min(2 * R + drill.distance * distanceScales[variant], maxCueDistance);
  const cue = {
    x: target.x - cueDistance * dirX,
    y: target.y - cueDistance * dirY,
  };
  const layout = { cue, target, pocketId: pocket.id, variation: variant };
  const inside = (p) =>
    p.x >= table.bounds.minX && p.x <= table.bounds.maxX &&
    p.y >= table.bounds.minY && p.y <= table.bounds.maxY;
  if (!inside(cue) || !inside(target) || outLength <= 2 * R || cueDistance <= 2 * R) {
    throw new Error(`专项练习 ${drillId} 在 ${table.preset} 球台上无法摆放`);
  }
  return layout;
}

export function summarizeDrills(records) {
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
  return Object.fromEntries(PRACTICE_DRILLS.map((drill) => {
    const attempts = valid.filter((record) => record.drillId === drill.id);
    const sets = [];
    for (let i = 0; i + DRILL_SET_SIZE <= attempts.length; i += DRILL_SET_SIZE) {
      sets.push(attempts.slice(i, i + DRILL_SET_SIZE));
    }
    return [
      drill.id,
      {
        attempts: attempts.length,
        made: attempts.filter((record) => record.made).length,
        passedSets: sets.filter((set) => set.filter((record) => record.made).length >= DRILL_SET_TARGET).length,
        currentSetAttempts: attempts.length % DRILL_SET_SIZE,
        currentSetMade: attempts.length % DRILL_SET_SIZE
          ? attempts.slice(-(attempts.length % DRILL_SET_SIZE)).filter((record) => record.made).length
          : 0,
      },
    ];
  }));
}

function defaultStore() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // 隐私模式下访问 localStorage 可能抛 SecurityError。
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sanitizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isSafeInteger(raw.timestamp) || raw.timestamp < 0 || raw.timestamp > 8_640_000_000_000_000) return null;
  if (typeof raw.made !== 'boolean') return null;
  if (!isFiniteNumber(raw.toleranceDeg) || raw.toleranceDeg <= 0 || raw.toleranceDeg > 90) return null;
  if (!isFiniteNumber(raw.difficulty) || raw.difficulty < 0 || raw.difficulty > 100) return null;
  if (!isFiniteNumber(raw.speed) || raw.speed <= 0 || raw.speed > 20) return null;
  if (!Number.isInteger(raw.targetNumber) || raw.targetNumber < 1 || raw.targetNumber > 15) return null;
  if (typeof raw.pocketId !== 'string' || raw.pocketId.length > 32) return null;
  if (typeof raw.tableId !== 'string' || raw.tableId.length > 40) return null;
  if (raw.drillId != null && !DRILL_BY_ID.has(raw.drillId)) return null;
  if (raw.missReason != null && (raw.made || !MISS_REASON_BY_ID.has(raw.missReason))) return null;

  return {
    timestamp: raw.timestamp,
    made: raw.made,
    toleranceDeg: raw.toleranceDeg,
    difficulty: raw.difficulty,
    speed: raw.speed,
    targetNumber: raw.targetNumber,
    pocketId: raw.pocketId,
    tableId: raw.tableId,
    drillId: raw.drillId ?? null,
    missReason: raw.missReason ?? null,
  };
}

export function sanitizePracticeLog(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.records)) return [];
  return raw.records.map(sanitizeRecord).filter(Boolean).slice(-MAX_RECORDS);
}

export function readPracticeLog(store = defaultStore()) {
  if (!store) return [];
  try {
    const text = store.getItem(KEY);
    return text ? sanitizePracticeLog(JSON.parse(text)) : [];
  } catch {
    return [];
  }
}

export function readPracticeGoal(store = defaultStore()) {
  if (!store) return DEFAULT_PRACTICE_GOAL;
  try {
    const goal = Number(store.getItem(GOAL_KEY));
    return PRACTICE_GOALS.includes(goal) ? goal : DEFAULT_PRACTICE_GOAL;
  } catch {
    return DEFAULT_PRACTICE_GOAL;
  }
}

export function writePracticeGoal(goal, store = defaultStore()) {
  if (!store || !PRACTICE_GOALS.includes(goal)) return false;
  try {
    store.setItem(GOAL_KEY, String(goal));
    return true;
  } catch {
    return false;
  }
}

export function appendPracticeResult(entry, store = defaultStore()) {
  if (!store) return false;
  const record = sanitizeRecord(entry);
  if (!record) return false;
  const records = [...readPracticeLog(store), record].slice(-MAX_RECORDS);
  try {
    store.setItem(KEY, JSON.stringify({ v: 1, records }));
    return true;
  } catch {
    return false;
  }
}

export function clearPracticeLog(store = defaultStore()) {
  if (!store) return false;
  try {
    store.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

export function exportPracticeBackup(records, exportedAt = Date.now()) {
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean).slice(-MAX_RECORDS) : [];
  return JSON.stringify({ v: 1, exportedAt, records: valid }, null, 2);
}

export function parsePracticeBackup(text) {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_BYTES) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    raw.v !== 1 ||
    !Array.isArray(raw.records) ||
    raw.records.length > MAX_RECORDS ||
    (raw.exportedAt != null && (!Number.isSafeInteger(raw.exportedAt) || raw.exportedAt < 0))
  ) return null;
  const records = raw.records.map(sanitizeRecord);
  return records.every(Boolean) ? records : null;
}

export function replacePracticeLog(records, store = defaultStore()) {
  if (!store || !Array.isArray(records) || records.length > MAX_RECORDS) return false;
  const normalized = records.map(sanitizeRecord);
  if (!normalized.every(Boolean)) return false;
  try {
    store.setItem(KEY, JSON.stringify({ v: 1, records: normalized }));
    return true;
  } catch {
    return false;
  }
}

export function exportPracticeCsv(records) {
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
  const headers = ['时间', '结果', '未进原因', '训练类型', '目标球', '目标袋', '容错角度(度)', '难度', '建议力度(m/s)', '球台'];
  const rows = valid.map((record) => [
    new Date(record.timestamp).toISOString(),
    record.made ? '命中' : '未进',
    MISS_REASON_BY_ID.get(record.missReason)?.label ?? '',
    PRACTICE_DRILLS.find((drill) => drill.id === record.drillId)?.name ?? '自由练习',
    `${record.targetNumber}号`,
    record.pocketId,
    record.toleranceDeg.toFixed(2),
    String(record.difficulty),
    record.speed.toFixed(2),
    record.tableId,
  ]);
  const csvCell = (value) => {
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function summarizeMissReasons(records) {
  const counts = Object.fromEntries(PRACTICE_MISS_REASONS.map(({ id }) => [id, 0]));
  let misses = 0;
  let unclassified = 0;
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
  for (const record of valid) {
    if (record.made) continue;
    misses++;
    if (record.missReason) counts[record.missReason]++;
    else unclassified++;
  }
  return {
    misses,
    unclassified,
    labeled: misses - unclassified,
    counts,
  };
}

export function summarizePracticeFocus(records) {
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
  const misses = valid.filter((record) => !record.made).slice(-PRACTICE_FOCUS_WINDOW);
  const counts = Object.fromEntries(PRACTICE_MISS_REASONS.map(({ id }) => [id, 0]));
  let labeled = 0;
  for (const record of misses) {
    if (!record.missReason) continue;
    counts[record.missReason]++;
    labeled++;
  }

  const highestCount = Math.max(...Object.values(counts));
  const leaders = PRACTICE_MISS_REASONS.filter(({ id }) => counts[id] === highestCount && highestCount > 0);
  const reason = labeled >= PRACTICE_FOCUS_MIN_LABELS && highestCount >= 2 && leaders.length === 1
    ? leaders[0].id
    : null;
  const drillId = reason === 'contact' ? 'cut'
    : ['aim', 'speed', 'spin'].includes(reason) ? 'straight'
    : null;

  return { window: misses.length, labeled, counts, reason, drillId };
}

function emptyStats() {
  return { attempts: 0, made: 0, rate: null };
}

function addResult(stats, record) {
  stats.attempts++;
  if (record.made) stats.made++;
  stats.rate = stats.made / stats.attempts;
}

function addConfidenceInterval(stats) {
  if (stats.attempts < MIN_CALIBRATION_SAMPLES) return;
  const n = stats.attempts;
  const z = 1.96;
  const zSq = z * z;
  const denominator = 1 + zSq / n;
  const center = (stats.rate + zSq / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((stats.rate * (1 - stats.rate)) / n + zSq / (4 * n * n))) / denominator;
  stats.confidence95 = {
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
  };
}

export function summarizePractice(records) {
  const summary = {
    ...emptyStats(),
    recent: emptyStats(),
    tolerance: {
      narrow: emptyStats(),
      medium: emptyStats(),
      wide: emptyStats(),
    },
  };
  const valid = Array.isArray(records) ? records.map(sanitizeRecord).filter(Boolean) : [];
  const recent = valid.slice(-10);

  for (const record of valid) {
    addResult(summary, record);
    const bucket =
      record.toleranceDeg < 0.2 ? 'narrow' : record.toleranceDeg < 0.5 ? 'medium' : 'wide';
    addResult(summary.tolerance[bucket], record);
  }
  for (const record of recent) addResult(summary.recent, record);
  for (const stats of Object.values(summary.tolerance)) addConfidenceInterval(stats);
  return summary;
}

export function summarizePracticeDays(records, now = Date.now()) {
  const today = new Date(now);
  const dateKey = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6 + index);
    return {
      date: dateKey(date),
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      attempts: 0,
      made: 0,
      rate: null,
    };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  const activeDates = new Set();

  if (Array.isArray(records)) {
    for (const record of records.map(sanitizeRecord).filter(Boolean)) {
      const date = new Date(record.timestamp);
      if (date > today) continue;
      const key = dateKey(date);
      activeDates.add(key);
      const day = byDate.get(key);
      if (!day) continue;
      day.attempts++;
      if (record.made) day.made++;
    }
  }

  let attempts = 0;
  let made = 0;
  for (const day of days) {
    attempts += day.attempts;
    made += day.made;
    if (day.attempts) day.rate = day.made / day.attempts;
  }
  const streakEnd = activeDates.has(dateKey(today))
    ? today
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  let streak = 0;
  for (let offset = 0; ; offset++) {
    const date = new Date(streakEnd.getFullYear(), streakEnd.getMonth(), streakEnd.getDate() - offset);
    if (!activeDates.has(dateKey(date))) break;
    streak++;
  }
  return {
    days,
    attempts,
    made,
    rate: attempts ? made / attempts : null,
    activeDays: days.filter((day) => day.attempts > 0).length,
    streak,
  };
}

export function summarizeTodayPractice(records, goal = DEFAULT_PRACTICE_GOAL, now = Date.now()) {
  const validGoal = PRACTICE_GOALS.includes(goal) ? goal : DEFAULT_PRACTICE_GOAL;
  const today = new Date(now);
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const date = `${year}-${month}-${day}`;
  let attempts = 0;
  let made = 0;
  if (Array.isArray(records)) {
    for (const record of records.map(sanitizeRecord).filter(Boolean)) {
      if (record.timestamp > now) continue;
      const timestamp = new Date(record.timestamp);
      if (timestamp.getFullYear() !== today.getFullYear() ||
          timestamp.getMonth() !== today.getMonth() ||
          timestamp.getDate() !== today.getDate()) continue;
      attempts++;
      if (record.made) made++;
    }
  }
  return {
    date,
    goal: validGoal,
    attempts,
    made,
    remaining: Math.max(0, validGoal - attempts),
    progress: Math.min(1, attempts / validGoal),
    complete: attempts >= validGoal,
  };
}

export const PRACTICE_KEY = KEY;
