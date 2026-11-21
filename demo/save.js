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
// 从 v2 起，「对局记录」（log）与「撤销栈」（history）也一起存：
//   log     —— 进场时压成 [杆号, 谁打的, 文案, 犯规码] 四元组，不写字段名。
//   history —— 交给 state.js 的 packHistory 压成每步一行，坐标只留 3 位小数
//              （1 mm），且带体积预算，超了从最旧的开始丢并记下丢了几步。
// 这两样以前是故意不存的，理由是「重新开一局就该重来」；真机实测发现代价更
// 大——刷新页面读档之后「对局记录」是空的、撤销按钮是灰的，看着像读档失败。
//
// 向后兼容：v1 的老存档没有这两个字段，读到就当空历史（读档时提示一句），
// 不许因为它没有就整份丢掉。

import { createTable } from '../src/table.js';
import { GAME_KINDS } from '../src/rules.js';
import { packHistory } from './state.js';

const KEY = 'pool-ai-coach/game/v1';

/** 允许出现的最大号码：斯诺克彩球到 21（红球 1–15、彩球 16–21）。 */
const MAX_NUMBER = 21;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 战绩流水：存档里是 [杆号, 谁打的, 文案, 犯规码] 四元组（省掉键名）；
 * 也认早期手写/手工编辑的 {shot, shooter, summary, fouls} 对象形状。
 * 单条读不懂就跳过那一条，绝不因为一条流水丢掉整份存档。
 */
function readLog(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (Array.isArray(e)) {
      out.push({
        shot: isFiniteNumber(e[0]) ? e[0] : out.length + 1,
        shooter: e[1] === 1 ? 1 : 0,
        summary: typeof e[2] === 'string' ? e[2] : '',
        fouls: Array.isArray(e[3]) ? e[3].filter((c) => typeof c === 'string') : [],
      });
    } else if (e && typeof e === 'object') {
      out.push({
        shot: isFiniteNumber(e.shot) ? e.shot : out.length + 1,
        shooter: e.shooter === 1 ? 1 : 0,
        summary: typeof e.summary === 'string' ? e.summary : '',
        fouls: Array.isArray(e.fouls) ? e.fouls.filter((c) => typeof c === 'string') : [],
      });
    }
  }
  return out;
}

/**
 * 杆史载荷的轻校验：结构对不上就整块当作没有（当空历史处理）。
 * 这里只保证「装进 state.js 的 unpackHistory 不会炸」，不做数值合理性检查——
 * 那是解码之后按当前局面的球序还原时才可能发现的事，届时丢那一步即可。
 */
function readHistory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = Array.isArray(raw.b) ? raw.b.filter((id) => typeof id === 'string') : null;
  if (!ids || ids.length === 0 || !Array.isArray(raw.s)) return null;
  const num = (v, fallback = 0) => (isFiniteNumber(v) ? v : fallback);
  const pair = (v) => (Array.isArray(v) ? [num(v[0]), num(v[1])] : [0, 0]);
  const steps = [];
  for (const step of raw.s) {
    if (!step || typeof step !== 'object' || !Array.isArray(step.x)) continue;
    const x = step.x;
    if (x.length !== ids.length * 3 || !x.every(isFiniteNumber)) continue;
    const compact = {
      s: num(step.s),
      t: step.t === 1 ? 1 : 0,
      k: step.k ? 1 : 0,
      o: step.o ? 1 : 0,
      h: num(step.h),
      r: step.r ? 1 : 0,
      e: step.e ? 1 : 0,
      w: num(step.w, -1),
      g: pair(step.g),
      f: pair(step.f),
      n: pair(step.n),
      l: num(step.l),
      x: x.slice(),
    };
    if (Array.isArray(step.c)) compact.c = [num(step.c[0]), num(step.c[1]), num(step.c[2]), num(step.c[3])];
    steps.push(compact);
  }
  if (steps.length === 0) return null;
  return { b: ids, s: steps, d: isFiniteNumber(raw.d) ? Math.max(0, Math.floor(raw.d)) : 0 };
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

  // 球台预设必须真的是个预设。只判 typeof string 的话，一个手改成 "abc" 的存档
  // 会被原样接受，读回去建不出球台，界面在更晚的地方炸。
  let table;
  try {
    table = createTable(t.id);
  } catch {
    return null;
  }
  const { minX, maxX, minY, maxY } = table.bounds;

  if (!Array.isArray(raw.balls) || raw.balls.length < 1) return null;
  const seen = new Set();
  const balls = [];
  for (const b of raw.balls) {
    if (!b || typeof b.id !== 'string') return null;
    if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y)) return null;
    if (!isFiniteNumber(b.number) || b.number < 0 || b.number > MAX_NUMBER) return null;
    // 文件头写着「球位越界就整份丢掉」，这里就得真的查。落袋的球坐标在袋口
    // （袋心常在台面边界外），只有还留在台上的球才要求落在 bounds 内。
    if (!b.pocketed && (b.x < minX || b.x > maxX || b.y < minY || b.y > maxY)) return null;
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

  // 玩法同理：认不出来就丢。默认回落到黑八会让一局九球读回来按黑八规则走，
  // 而「先碰哪颗」「进 9 算不算赢」全不一样——这种错比读不出来严重得多。
  const kind = raw.kind === undefined ? 'eightball' : GAME_KINDS[raw.kind] ? raw.kind : null;
  if (!kind) return null;

  const zone =
    raw.ballInHand &&
    (raw.ballInHand.zone === 'kitchen' ||
      raw.ballInHand.zone === 'anywhere' ||
      raw.ballInHand.zone === 'd')
      ? raw.ballInHand.zone
      : null;

  // 斯诺克状态：比分、该打什么球。kind 不是 snooker 就整块丢掉，
  // 免得一份黑八存档带着残留的比分被读进来。
  let snooker = null;
  if (kind === 'snooker') {
    const s = raw.snooker;
    const scores = Array.isArray(s?.scores) && s.scores.length === 2 ? s.scores : null;
    if (!scores || !scores.every((v) => isFiniteNumber(v) && v >= 0)) return null;
    const on = s?.ballOn;
    const ballOn =
      on === 'red' || on === 'color'
        ? on
        : isFiniteNumber(on) && on >= 16 && on <= 21
          ? on
          : null;
    if (ballOn === null) return null;
    snooker = {
      scores: [Math.floor(scores[0]), Math.floor(scores[1])],
      ballOn,
      reds: isFiniteNumber(s?.reds) ? Math.max(0, Math.floor(s.reds)) : 0,
    };
  }

  return {
    table: { id: t.id },
    balls,
    // 玩法必须存：黑八和九球的「先碰哪颗」「进 9 号算不算赢」「能不能分组」
    // 全都不一样，读回时按黑八重建会让一局九球立刻变成非法的黑八局。
    kind,
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
    snooker,
    // 老存档没有这两项：读到的是 [] 与 null，读档流程据此提示「更早的步数未随
    // 存档保存」，而不是把它当坏档。
    log: readLog(raw.log),
    history: readHistory(raw.history),
    // 存下来是为了让别的标签页能判断「这份存档是不是我看过的那个」。
    // 不合法就当 0（比任何真实时间戳都旧），不会因此丢掉整份存档。
    savedAt: isFiniteNumber(raw.savedAt) ? raw.savedAt : 0,
  };
}

/**
 * 把一局压成可存的形状（只留需要的字段，别把 table 对象整个塞进去）。
 *
 * @param {object} game
 * @param {number} [now] 写入时间戳
 * @param {object[]} [history] 撤销栈（app 的 state.history）；空就一个字节都不写
 */
export function serialize(game, now = Date.now(), history = []) {
  const log = Array.isArray(game.log) ? game.log : [];
  const packed = packHistory(history);
  const out = {
    v: SAVE_VERSION,
    savedAt: now,
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
    // 斯诺克才有；其它玩法是 null，写进 JSON 也不占地方。
    snooker: game.snooker
      ? { scores: game.snooker.scores.slice(), ballOn: game.snooker.ballOn, reds: game.snooker.reds }
      : null,
  };
  // 空的两个键一个都不写：开局第一次存档的体积要尽量小，而且「没有历史」
  // 这件事本身就该能从键的缺席上看出来。
  if (log.length > 0) out.log = log.map((e) => [e.shot, e.shooter, e.summary, e.fouls ?? []]);
  if (packed.s.length > 0) out.history = packed;
  return out;
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
export function writeSave(game, store = defaultStore(), { now = Date.now(), history = [] } = {}) {
  if (!store) return false;
  try {
    store.setItem(KEY, JSON.stringify(serialize(game, now, history)));
    return true;
  } catch {
    return false;
  }
}

/**
 * 存档的写入时间戳，给「另一个标签页是不是改过」用。没有存档返回 null。
 * 注意这里读的是原始 JSON 而不是 sanitize 之后的对象：存档坏掉时也要能把
 * 「它存在过」这件事说出来，哪怕内容已经不能用了。
 */
export function readSaveStamp(store = defaultStore()) {
  if (!store) return null;
  let text = null;
  try {
    text = store.getItem(KEY);
  } catch {
    return null;
  }
  if (!text) return null;
  try {
    const raw = JSON.parse(text);
    return typeof raw?.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0;
  } catch {
    return null;
  }
}

/** 当前存档格式版本。v1 是「没有 log / history 两个键」的老格式。 */
export const SAVE_VERSION = 2;

/**
 * 读存档并判断「为什么读不出来」——只读，不动存储。
 *
 * status 的取值和用途：
 *   ok          读到一份能用的局面（saved 是 sanitize 之后的对象）
 *   empty       压根没有存档
 *   unavailable 存储读不了（隐私模式下 getItem 就抛）
 *   newer       JSON 是对象、版本号比本代码新：那是版本差异，不是坏数据，
 *               不许删——把它留着，换回新版本来还能读
 *   corrupt     确认是坏数据（不是 JSON、或者 sanitize 判它建不出一局）
 */
function inspectSave(store) {
  if (!store) return { status: 'unavailable', saved: null };
  let text = null;
  try {
    text = store.getItem(KEY);
  } catch {
    return { status: 'unavailable', saved: null };
  }
  if (!text) return { status: 'empty', saved: null };
  let raw = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: 'corrupt', saved: null };
  }
  // 版本号先于 sanitize 判断：未来的存档多半会多出字段，sanitize 可能因此判它
  // 不合法。降级打开时把人家新版本的存档删掉，是比读不出来严重得多的错。
  if (raw && typeof raw === 'object' && isFiniteNumber(raw.v) && raw.v > SAVE_VERSION) {
    return { status: 'newer', saved: null };
  }
  const saved = sanitize(raw);
  return saved ? { status: 'ok', saved } : { status: 'corrupt', saved: null };
}

/**
 * 读档 + 清理坏档。整档校验不过就把它真的从存储里删掉，并如实报告删没删成。
 *
 * 为什么必须真有这一步：界面上写着「存档已损坏，已被丢弃」，但坏档一直躺在
 * localStorage 里，下次进页面照样被读出来，那句提示就是假的。
 *
 * @returns {{status:'ok'|'empty'|'unavailable'|'newer'|'corrupt', saved:object|null, discarded:boolean}}
 */
export function loadSave(store = defaultStore()) {
  const { status, saved } = inspectSave(store);
  if (status !== 'corrupt') return { status, saved, discarded: false };
  let discarded = false;
  try {
    store.removeItem(KEY);
    discarded = true;
  } catch {
    discarded = false;
  }
  return { status, saved: null, discarded };
}

/** 读存档。没有、坏掉、校验不过都返回 null。（只读，不删坏档——删档走 loadSave） */
export function readSave(store = defaultStore()) {
  return inspectSave(store).saved;
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
