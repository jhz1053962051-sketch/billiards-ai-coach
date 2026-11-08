// 球局存档：把一局的状态序列化进 localStorage，刷新页面之后能接着打。
//
// 为什么不用一整套 schema 版本迁移：
//   存的是「局面」本身，不是「玩家档案」。字段就那十几个，且每次读取都要能被
//   规则引擎直接吃下去——所以真正的校验不在版本号，而在"读回来能不能建出一局
//   合法的球"。下面的 sanitize 干的正是这件事：缺字段就补默认值，球位越界或
//   重复就整份丢掉（返回 null），绝不把半截数据塞进界面。
//
// 存的与原样读回的字段：
//   table   —— 球台预设 id（换台之后坐标含义变了，必须一起存）
//   kind    —— 玩法（黑八 / 九球）。不存的话一局九球读回来会按黑八规则走
//   balls   —— 球位、号码、是否落袋
//   players —— 名字、分组、连续犯规、是否已被提醒两犯（三犯判负的前提）
//   turn / breakShot / open / ballInHand / requiresRerack / phase / winner / shots
//
// 不存的：
//   log     —— 战绩流水，重新开一局就该重来；留着反而让"第 N 杆"对不上。
//   history —— 撤销栈。存了会让人以为能一路退到上一局的起点。

const KEY = 'pool-ai-coach/game/v1';

/** 母球之外允许出现的号：黑八 1–15、九球 1–9。读档时按实际出现的号校验即可。 */
const MAX_NUMBER = 15;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验并规整一份存档。任何一项对不上就返回 null——宁可告诉用户"存档坏了"，
 * 也不要把半截局面装进界面让他以为还能打。
 *
 * @param {unknown} raw
 * @returns {object|null}
 */
export function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.table;
  if (!t || typeof t.id !== 'string') return null;

  if (!Array.isArray(raw.balls) || raw.balls.length < 1) return null;
  const seen = new Set();
  const balls = [];
  for (const b of raw.balls) {
    if (!b || typeof b.id !== 'string') return null;
    if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y)) return null;
    if (!isFiniteNumber(b.number) || b.number < 0 || b.number > MAX_NUMBER) return null;
    if (b.number !== 0) {
      if (seen.has(b.number)) return null; // 同一号码出现两次，这份存档不可信
      seen.add(b.number);
    }
    balls.push({
      id: b.id,
      number: b.number,
      x: b.x,
      y: b.y,
      color: typeof b.color === 'string' ? b.color : undefined,
      stripe: Boolean(b.stripe),
      pocketed: Boolean(b.pocketed),
      pocket: b.pocketed && typeof b.pocket === 'string' ? b.pocket : undefined,
    });
  }
  if (!balls.some((b) => b.number === 0 && !b.pocketed)) return null;

  const players = Array.isArray(raw.players) && raw.players.length === 2 ? raw.players : null;
  if (!players) return null;

  const zone = raw.ballInHand && (raw.ballInHand.zone === 'kitchen' || raw.ballInHand.zone === 'anywhere')
    ? raw.ballInHand.zone
    : null;

  return {
    table: { id: t.id },
    balls,
    // 玩法必须存：黑八和九球的「先碰哪颗」「进 9 号算不算赢」「能不能分组」
    // 全都不一样，读回时按黑八重建会让一局九球立刻变成非法的黑八局。
    kind: raw.kind === 'nineball' ? 'nineball' : 'eightball',
    players: players.map((p) => ({
      name: typeof p?.name === 'string' ? p.name : '玩家',
      group: p?.group === 'solid' || p?.group === 'stripe' ? p.group : null,
      fouls: isFiniteNumber(p?.fouls) ? Math.max(0, Math.floor(p.fouls)) : 0,
      // warned 也要存：三犯规则里「裁判提醒过两犯」是判负的前提，
      // 丢掉它会让一局进行到两犯的球局读回来之后第三犯只按第二犯算。
      warned: Boolean(p?.warned),
    })),
    turn: raw.turn === 1 ? 1 : 0,
    breakShot: Boolean(raw.breakShot),
    open: Boolean(raw.open),
    ballInHand: zone ? { zone } : null,
    requiresRerack: Boolean(raw.requiresRerack),
    phase: raw.phase === 'ended' ? 'ended' : 'playing',
    winner: raw.winner === 0 || raw.winner === 1 ? raw.winner : null,
    shots: isFiniteNumber(raw.shots) ? Math.max(0, Math.floor(raw.shots)) : 0,
  };
}

/** 把一局压成可存的形状（只留需要的字段，别把 table 对象整个塞进去）。 */
export function serialize(game) {
  return {
    v: 1,
    savedAt: Date.now(),
    table: { id: game.table.preset },
    balls: game.balls.map((b) => ({
      id: b.id,
      number: b.number,
      x: b.x,
      y: b.y,
      color: b.color,
      stripe: b.stripe,
      pocketed: b.pocketed,
      pocket: b.pocket,
    })),
    players: game.players.map((p) => ({
      name: p.name,
      group: p.group,
      fouls: p.fouls,
      warned: p.warned,
    })),
    kind: game.kind ?? 'eightball',
    turn: game.turn,
    breakShot: game.breakShot,
    open: game.open,
    ballInHand: game.ballInHand ? { zone: game.ballInHand.zone } : null,
    requiresRerack: game.requiresRerack,
    phase: game.phase,
    winner: game.winner,
    shots: game.shots,
  };
}

/**
 * 存储后端。默认 localStorage；测试可以传一个内存实现进来，
 * 这样存档逻辑本身不依赖浏览器环境，Node 里能直接测。
 */
function defaultStore() {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // 隐私模式下访问 localStorage 会抛 SecurityError，当作"没有存储"
  }
  return null;
}

/** 写存档。存储不可用（隐私模式 / 配额满）时返回 false，不抛。 */
export function writeSave(game, store = defaultStore()) {
  if (!store) return false;
  try {
    store.setItem(KEY, JSON.stringify(serialize(game)));
    return true;
  } catch {
    return false;
  }
}

/** 读存档。没有、坏掉、校验不过都返回 null。 */
export function readSave(store = defaultStore()) {
  if (!store) return null;
  let text = null;
  try {
    text = store.getItem(KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return null;
  }
}

export function clearSave(store = defaultStore()) {
  if (!store) return false;
  try {
    store.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** 存档摘要，给界面显示用。没有存档返回 null。 */
export function describeSave(store = defaultStore()) {
  const saved = readSave(store);
  if (!saved) return null;
  const onTable = saved.balls.filter((b) => !b.pocketed && b.number !== 0).length;
  return {
    shots: saved.shots,
    onTable,
    tableId: saved.table.id,
    turn: saved.turn,
    ended: saved.phase === 'ended',
  };
}

export const SAVE_KEY = KEY;
