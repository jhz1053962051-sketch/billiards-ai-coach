// 演示页的纯状态逻辑。
//
// 这一层存在的唯一理由：**能在 Node 里跑**。
// demo/app.js 一上来就取 DOM、取完立刻初始化，所以它自己没法被单测——
// 每一行业务判断都只能靠 162 项浏览器端到端兜着，跑一次要一分多钟。
// 把「不碰 DOM 的那部分」搬到这里之后，同一个判断在 Node 里几毫秒就能验一遍。
//
// 准入标准（不要放宽）：函数体里不出现 document / window / localStorage /
// canvas / requestAnimationFrame / DOM 事件对象。需要局面、需要滑块值、
// 需要相机视角的，一律由调用方当参数传进来。
//
// 反过来也要注意：这里的东西**不能**依赖 demo/save.js 之外的浏览器存储；
// 更不要在这里 import 任何会碰 window 的模块——tools/check-demo.mjs 会用
// `await import()` 真的加载这个文件来核对导出，一碰 window 就是整条门禁红。

import { cloneGame, legalTargetNumbers, numbersOnTable } from '../src/rules.js';

// ---------------------------------------------------------------- 数值

/** 夹在 [lo, hi] 之间。越界时返回边界值。 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- 力度档位

/**
 * 经典台球游戏击球力度档位划分 (参考 8 Ball Pool / 腾讯桌球)
 * 0% ~ 29%: 轻力 (细腻走位 / 贴库过渡) - 翡翠绿
 * 30% ~ 59%: 中力 (标准走位 / 常规进球) - 晴空蓝
 * 60% ~ 84%: 发力 (长台推进 / 强力拉杆) - 琥珀金
 * 85% ~ 100%: 爆杆 (强力冲球 / 极限爆裂) - 炽烈红
 *
 * 百分比只是显示刻度，和 SEARCH_DT 那个物理步长没有关系。
 */
export function getPowerTier(speed) {
  const min = 0.55;
  const max = 6.6;
  const clamped = clamp(speed, min, max);
  const ratio = (clamped - min) / (max - min);
  const pct = Math.round(ratio * 100);

  if (pct < 30) {
    return {
      level: '轻力',
      sub: '细腻走位',
      pct,
      ratio,
      color: '#10b981',
      badgeBg: 'linear-gradient(135deg, #059669 0%, #10b981 100%)',
      glow: 'rgba(16, 185, 129, 0.5)',
    };
  } else if (pct < 60) {
    return {
      level: '中力',
      sub: '标准进球',
      pct,
      ratio,
      color: '#0ea5e9',
      badgeBg: 'linear-gradient(135deg, #0284c7 0%, #38bdf8 100%)',
      glow: 'rgba(14, 165, 233, 0.5)',
    };
  } else if (pct < 85) {
    return {
      level: '发力',
      sub: '强拉长台',
      pct,
      ratio,
      color: '#f59e0b',
      badgeBg: 'linear-gradient(135deg, #d97706 0%, #f59e0b 100%)',
      glow: 'rgba(245, 158, 11, 0.5)',
    };
  } else {
    return {
      level: '爆杆',
      sub: '强力冲球',
      pct,
      ratio,
      color: '#ef4444',
      badgeBg: 'linear-gradient(135deg, #dc2626 0%, #f87171 100%)',
      glow: 'rgba(239, 68, 68, 0.65)',
    };
  }
}

// ---------------------------------------------------------------- 球位快照

/**
 * 打杆前把球复制一份：清掉速度和角速度，原对象一个字段都不动。
 * 物理核拿这份副本跑，跑完是进是摔都不影响台面上的球。
 */
export function copyBallsForShot(balls) {
  return balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
}

/**
 * 只留回放完之后要还原的四个字段。
 * 不存 vx/vy：回放结束后它们本来就被物理核留在 0，多存一份反而会出现
 * 「还原了位置却没还原速度」的不一致。
 */
export function snapshotPositions(balls) {
  return balls.map((b) => ({ x: b.x, y: b.y, pocketed: b.pocketed, pocket: b.pocket }));
}

/**
 * 按快照把球位写回去。就地改，不换数组——调用方持有的是同一个 balls。
 *
 * 长度不一致时这里会读到 undefined 然后抛错，和搬进来之前的循环行为一致：
 * 那是「局面已经被换掉了」的编程错误，静默跳过只会让它更难查。
 */
export function restorePositions(balls, snapshot) {
  for (let i = 0; i < balls.length; i++) {
    balls[i].x = snapshot[i].x;
    balls[i].y = snapshot[i].y;
    balls[i].pocketed = snapshot[i].pocketed;
    balls[i].pocket = snapshot[i].pocket;
  }
}

/**
 * 把一帧的球位压成「回放用的数组」。
 *
 * trackRoll 由 physics.js 的 createRollTracker 提供，它自己有内部状态，
 * 必须按帧顺序调用，所以只能当参数传进来而不是在这里新建。
 */
export function captureBallFrame(balls, trackRoll) {
  const roll = trackRoll();
  return balls.map((ball, index) => ({
    x: ball.x,
    y: ball.y,
    pocketed: ball.pocketed,
    pocket: ball.pocket,
    ...roll[index],
  }));
}

/** 手打一杆之后，用副本的终局算「进了哪几颗 / 母球有没有摔」。 */
export function describeManualShot(balls) {
  const pocketed = balls.filter((b) => b.pocketed && b.number !== 0).map((b) => b.number);
  const cuePocketed = balls.some((b) => b.pocketed && b.number === 0);
  const detail = [];
  if (pocketed.length) detail.push(`进 ${pocketed.join('、')} 号`);
  if (cuePocketed) detail.push('母球落袋');
  if (!pocketed.length && !cuePocketed) detail.push('没有球进袋');
  return { pocketed, cuePocketed, detail };
}

// ---------------------------------------------------------------- 撤销栈

/** 撤销栈上限。台面上任意时刻最多 16 颗球，一局十几到几十杆，20 步够用又不占内存。 */
export const HISTORY_LIMIT = 20;

/**
 * 记一步快照。就地改数组，返回同一个数组。
 *
 * 传进来的 game 必须是**结算前**的局面：resolveShot 不改入参（它返回新的 next），
 * 所以这里拿到的正是撤销要回到的状态。
 */
export function pushHistoryEntry(history, game, limit = HISTORY_LIMIT) {
  history.push(cloneGame(game));
  if (history.length > limit) history.shift();
  return history;
}

/** 撤销按钮上的字。0 步时说人话，有步数时把步数报出来。 */
export function undoLabel(n) {
  return n === 0 ? '撤销上一杆' : `撤销上一杆（${n}）`;
}

// ---------------------------------------------------------------- 练习面板

/**
 * 练习面板的状态行。
 *
 * 不传参时不该把它清空：页面一打开 resetLayout 就会调一次，清成空字符串
 * 等于把首屏那句「先求解一个目标袋方案，再记录真实练习结果」当场抹掉，
 * 球友看到的是一块空白，不知道下一步该干什么。所以按当前状态算一句该说的话。
 */
export function practiceHint(state) {
  if (state.mode !== 'practice') return '';
  if (!state.solution?.found || !state.solution.best?.pocketId) {
    return '先求解一个目标袋方案，再记录真实练习结果。';
  }
  if (state.practiceRecorded) return '这一杆记下了。同一个球位可以接着记，换球位就再求解一次。';
  return '按实际结果点「进了」或「没进」——记下来才看得出进步。';
}

/**
 * 「进了 / 没进」两个按钮能不能点。
 * 记完一杆不再禁用：同一个球位反复练十杆是常态，每杆都得重新求解一次
 * 才能记录，等于逼人重复劳动。这里只要「有解」就给点，记多少次都行。
 */
export function practiceReady(state) {
  return Boolean(
    state.mode === 'practice' &&
    state.solution?.found &&
    state.solution.best?.pocketId
  );
}

// ---------------------------------------------------------------- 瞄准

/**
 * 当前这一杆的基准瞄准方向（弧度）。
 *
 * 优先用求解结果——那是唯一"已经对准某个袋"的方向，滑块在它上面偏移才有意义。
 * 没有解时退化成"直指最近的合法目标球球心"，至少方向不是乱的。
 *
 * @returns {{angle:number, targetId:string|null, from:string}|null}
 */
export function currentAim(state) {
  const inGame = state.mode === 'game';
  const sol = inGame ? state.gSolution : state.solution;
  const balls = inGame ? (state.game?.balls ?? []) : state.balls;
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  if (!cue) return null;

  if (sol?.found && sol.best) {
    return { angle: sol.best.aimAngle, targetId: sol.best.targetId, from: 'solution' };
  }

  // 没有解：找一个最近的合法目标球当方向
  const allow = inGame && state.game
    ? legalTargetNumbers(state.game, numbersOnTable(state.game.balls))
    : null;
  const allowSet = allow ? new Set(allow) : null;
  let target = null;
  let bestD = Infinity;
  for (const b of balls) {
    if (b.pocketed || b.number === 0) continue;
    if (allowSet && !allowSet.has(b.number)) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (d < bestD) {
      bestD = d;
      target = b;
    }
  }
  if (!target) return null;
  return {
    angle: Math.atan2(target.y - cue.y, target.x - cue.x),
    targetId: target.id,
    from: 'direct',
  };
}

// ---------------------------------------------------------------- 存档装载

/**
 * 把一份已经校验过的存档里的**进程态**逐项装回 createGame 给出的新局。
 *
 * createGame 只给开局态（谁开球、0 杆、无持球）；存档里的回合、杆数、
 * 犯规、斯诺克比分都不在它的默认值里，漏一项就是「读回来变回开局」。
 * 球台校验、球位重建、界面刷新都留在 app.js——那些要么碰 DOM，要么要改台。
 *
 * 就地改 game 并返回它，方便调用方串起来用。
 */
export function restoreGameState(game, saved) {
  game.players = saved.players.map((p) => ({ ...p }));
  game.turn = saved.turn;
  game.breakShot = saved.breakShot;
  game.open = saved.open;
  game.ballInHand = saved.ballInHand ? { ...saved.ballInHand } : null;
  game.requiresRerack = saved.requiresRerack;
  game.phase = saved.phase;
  game.winner = saved.winner;
  game.shots = saved.shots;
  // 对局记录也要装回去：createGame 给的是空 log，不装的话读档之后「对局记录」
  // 还是「—」——真机实测里这一条看着就像读档只成功了一半。
  game.log = Array.isArray(saved.log)
    ? saved.log.map((e) => ({ ...e, fouls: Array.isArray(e?.fouls) ? e.fouls.slice() : [] }))
    : [];
  // 斯诺克的比分和「该打什么」不在 createGame 的默认值里，必须单独装回去。
  if (saved.snooker && game.snooker) game.snooker = { ...saved.snooker, scores: saved.snooker.scores.slice() };
  return game;
}

// ---------------------------------------------------------------- 存档里的杆史
//
// 存档要能带上撤销栈，否则刷新页面之后「对局记录」是空的、撤销按钮是灰的，
// 让人以为读档没成功。但不能把 cloneGame 的整份快照原样塞进 localStorage：
// 一步快照里 table 还挂着 bounds / cushions / pockets，log 还挂着到那时为止的
// 全部文案，20 步下来几兆，5 MB 配额说满就满。
//
// 所以这里改成「一步只记变化的东西」：
//   x  —— 球位按球序展平成 [x, y, 袋口码] 三元组。坐标保留 3 位小数（1 mm，
//         撤销看的是球在哪，不是亚微米）；「是否落袋」和「进哪个袋」合并成一个
//         整数，不再各写一个字段。
//   log —— 不逐步复制。log 只追加不重写（rules.js 里全是 push），所以每一步
//         只记一个长度 l，读回来时用「当前这局的 log 前 l 条」还原。20 步
//         在这上面只花 20 个数字。
//
// 数字全部走数组而不是对象，键名只在一步上出现一次。

/** 球位写进存档时保留的小数位：3 位 = 1 mm。 */
export const SAVE_COORD_DECIMALS = 3;

/**
 * 杆史序列化后的体积上限（字节）。localStorage 一般 5 MB，但一局存档跟练习
 * 记录、别的页面共用同一个配额，256 KB 足够装 20 步，又不至于把配额吃掉。
 * 超了从最旧的开始丢，并在读档后提示「更早的 X 步未随存档保存」。
 */
export const SAVE_HISTORY_BUDGET = 256 * 1024;

const COORD_SCALE = 10 ** SAVE_COORD_DECIMALS;

/** 存档里的球位精度：四舍五入到 3 位小数。 */
export function saveCoord(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * COORD_SCALE) / COORD_SCALE : 0;
}

/** UTF-8 字节数。配额是按字节算的，按字符数估会把中文低估成三分之一。 */
export function utf8Bytes(text) {
  let n = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return n;
}

/** 袋口码：-1 还在台上，-2 落袋但没记袋口，其余是 table.pockets 的下标。 */
const POCKET_ON_TABLE = -1;
const POCKET_UNKNOWN = -2;

const ZONES = [null, 'kitchen', 'anywhere', 'd'];
const GROUPS = [null, 'solid', 'stripe'];

function zoneCode(ballInHand) {
  const i = ZONES.indexOf(ballInHand?.zone ?? null);
  return i < 0 ? 0 : i;
}

function zoneFromCode(code) {
  const zone = ZONES[code] ?? null;
  return zone ? { zone } : null;
}

function groupCode(group) {
  const i = GROUPS.indexOf(group ?? null);
  return i < 0 ? 0 : i;
}

function groupFromCode(code) {
  return GROUPS[code] ?? null;
}

/** 斯诺克「该打什么」：0 红球、1 任意彩球、16–21 指定彩球。 */
function ballOnCode(ballOn) {
  if (ballOn === 'red') return 0;
  if (ballOn === 'color') return 1;
  return Number.isFinite(ballOn) ? ballOn : 0;
}

function ballOnFromCode(code) {
  if (code === 0) return 'red';
  if (code === 1) return 'color';
  return Number.isFinite(code) && code >= 16 && code <= 21 ? code : 'red';
}

function pocketCode(ball, pocketIds) {
  if (!ball.pocketed) return POCKET_ON_TABLE;
  const i = typeof ball.pocket === 'string' ? pocketIds.indexOf(ball.pocket) : -1;
  return i < 0 ? POCKET_UNKNOWN : i;
}

function ballIdsOf(game) {
  return game.balls.map((b) => b.id);
}

function sameIds(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 一步快照 → 一行紧凑数据。球序必须与 base 一致（调用方已核过）。 */
function encodeStep(entry, pocketIds) {
  const x = [];
  for (const b of entry.balls) x.push(saveCoord(b.x), saveCoord(b.y), pocketCode(b, pocketIds));
  const step = {
    s: Number.isFinite(entry.shots) ? entry.shots : 0,
    t: entry.turn === 1 ? 1 : 0,
    k: entry.breakShot ? 1 : 0,
    o: entry.open ? 1 : 0,
    h: zoneCode(entry.ballInHand),
    r: entry.requiresRerack ? 1 : 0,
    e: entry.phase === 'ended' ? 1 : 0,
    w: entry.winner === 0 || entry.winner === 1 ? entry.winner : -1,
    g: entry.players.map((p) => groupCode(p.group)),
    f: entry.players.map((p) => (Number.isFinite(p.fouls) ? Math.max(0, Math.floor(p.fouls)) : 0)),
    n: entry.players.map((p) => (p.warned ? 1 : 0)),
    l: Array.isArray(entry.log) ? entry.log.length : 0,
    x,
  };
  if (entry.snooker) {
    step.c = [
      entry.snooker.scores[0],
      entry.snooker.scores[1],
      ballOnCode(entry.snooker.ballOn),
      entry.snooker.reds,
    ];
  }
  return step;
}

/**
 * 撤销栈 → 存档里的杆史载荷。
 *
 * 保留最近 `limit` 步（和内存里的撤销栈同一个上限），再按 `budget` 从最旧的
 * 开始丢。返回 { b: 球序 id、s: 各步、d: 丢了几步（含超限与超预算）、bytes }。
 * 空输入返回空载荷，调用方据此决定写不写 history 字段。
 */
export function packHistory(history, { limit = HISTORY_LIMIT, budget = SAVE_HISTORY_BUDGET } = {}) {
  const list = Array.isArray(history) ? history : [];
  const src = list.slice(Math.max(0, list.length - limit));
  const steps = [];
  const newest = src[src.length - 1];
  const ids = newest ? ballIdsOf(newest) : [];
  const pocketIds = newest ? newest.table.pockets.map((p) => p.id) : [];
  let dropped = list.length - src.length;
  for (let i = src.length - 1; i >= 0; i -= 1) {
    const entry = src[i];
    // 球序变了（重摆过、或换了一局）就没法按同一套下标还原，更早的一律不要。
    if (!sameIds(ballIdsOf(entry), ids)) {
      dropped += i + 1;
      break;
    }
    const trial = [encodeStep(entry, pocketIds), ...steps];
    if (steps.length > 0 && utf8Bytes(JSON.stringify({ b: ids, s: trial })) > budget) {
      dropped += i + 1;
      break;
    }
    steps.unshift(trial[0]);
  }
  const payload = { b: ids, s: steps, d: dropped };
  payload.bytes = utf8Bytes(JSON.stringify(payload));
  return payload;
}

/** 一行紧凑数据 → 完整的一局快照（就地建新局，base 不动）。 */
function decodeStep(step, baseGame, slots, pocketIds) {
  const entry = cloneGame(baseGame);
  // 待决事项（九球非法开球后的「照打 / 交回」）是瞬时的界面提示，存档本身
  // 也不带它；这里明确清掉，免得旧状态挂到还原出来的局面上。
  entry.pendingChoice = null;
  entry.shots = Number.isFinite(step.s) ? Math.max(0, Math.floor(step.s)) : 0;
  entry.turn = step.t === 1 ? 1 : 0;
  entry.breakShot = Boolean(step.k);
  entry.open = Boolean(step.o);
  entry.ballInHand = zoneFromCode(step.h);
  entry.requiresRerack = Boolean(step.r);
  entry.phase = step.e ? 'ended' : 'playing';
  entry.winner = step.w === 0 || step.w === 1 ? step.w : null;

  const groups = Array.isArray(step.g) ? step.g : [];
  const fouls = Array.isArray(step.f) ? step.f : [];
  const warned = Array.isArray(step.n) ? step.n : [];
  entry.players = baseGame.players.map((p, i) => ({
    name: p.name,
    group: groupFromCode(groups[i]),
    fouls: Number.isFinite(fouls[i]) ? Math.max(0, Math.floor(fouls[i])) : 0,
    warned: Boolean(warned[i]),
  }));

  const logLen = Number.isFinite(step.l) ? clamp(Math.floor(step.l), 0, baseGame.log.length) : 0;
  entry.log = baseGame.log.slice(0, logLen);

  if (entry.snooker && Array.isArray(step.c)) {
    entry.snooker = {
      scores: [
        Number.isFinite(step.c[0]) ? Math.max(0, Math.floor(step.c[0])) : 0,
        Number.isFinite(step.c[1]) ? Math.max(0, Math.floor(step.c[1])) : 0,
      ],
      ballOn: ballOnFromCode(step.c[2]),
      reds: Number.isFinite(step.c[3]) ? Math.max(0, Math.floor(step.c[3])) : 0,
    };
  }

  for (let i = 0; i < slots.length; i += 1) {
    const ball = entry.balls[slots[i]];
    if (!ball) continue;
    ball.x = saveCoord(step.x[i * 3]);
    ball.y = saveCoord(step.x[i * 3 + 1]);
    const code = step.x[i * 3 + 2];
    if (code === POCKET_ON_TABLE) {
      ball.pocketed = false;
      ball.pocket = null;
    } else if (code === POCKET_UNKNOWN) {
      ball.pocketed = true;
      ball.pocket = null;
    } else {
      ball.pocketed = true;
      ball.pocket = pocketIds[code] ?? null;
    }
  }
  return entry;
}

/**
 * 存档里的杆史 → 撤销栈（旧的在前，和 pushHistoryEntry 的顺序一致）。
 *
 * baseGame 必须是「已经按存档装好进程态」的当前局面：球序、球台袋口、以及
 * 当前这局的 log 都从它上面取。载荷缺失（老存档没有这个字段）时返回空历史，
 * 由调用方决定怎么提示——绝不能因为老存档就直接报错。
 */
export function unpackHistory(packed, baseGame) {
  const empty = { entries: [], dropped: 0 };
  if (!packed || !baseGame || !Array.isArray(packed.s) || packed.s.length === 0) return empty;
  const ids = Array.isArray(packed.b) ? packed.b : [];
  const slots = ids.map((id) => baseGame.balls.findIndex((b) => b.id === id));
  if (ids.length === 0 || slots.some((i) => i < 0)) return empty;
  const pocketIds = baseGame.table.pockets.map((p) => p.id);
  const entries = [];
  for (const step of packed.s) {
    if (!step || !Array.isArray(step.x) || step.x.length !== ids.length * 3) continue;
    entries.push(decodeStep(step, baseGame, slots, pocketIds));
  }
  const declared = Number.isFinite(packed.d) ? Math.max(0, Math.floor(packed.d)) : 0;
  return { entries, dropped: declared + (packed.s.length - entries.length) };
}

// ---------------------------------------------------------------- 自动出杆的暂停
//
// 撤销 / 读档之后先停住自动出杆。真机实测里这是最容易被误判成「系统坏了」的
// 一条：默认开着「对手自动出杆」，撤销或读档之后 1–2 秒内对手自己又打一杆，
// 球位和比分立刻变掉，用户看到的是「我刚读回来的局面被人改了」。
//
// 转移写成纯函数放这里，是因为 app.js 一碰 DOM 就没法单测；而这条状态机写错
// 的表现恰好又是「局面自己动了」，最难靠肉眼发现。
//
// 允许的转移（其余动作一律不改状态）：
//   undo / load          → 暂停，并记住原因（提示条文案不同）
//   user-shot            → 恢复：用户亲手打了一杆，等于他已经接手这一局
//   resume               → 恢复：点了提示条上的「点此继续」
//   new-game             → 恢复：新的一局不该带着上一局的暂停
export function reduceAutoPause(prev, action) {
  switch (action) {
    case 'undo':
      return { autoPaused: true, autoPauseReason: 'undo' };
    case 'load':
      return { autoPaused: true, autoPauseReason: 'load' };
    case 'user-shot':
    case 'resume':
    case 'new-game':
      return { autoPaused: false, autoPauseReason: null };
    default:
      return {
        autoPaused: Boolean(prev?.autoPaused),
        autoPauseReason: prev?.autoPauseReason ?? null,
      };
  }
}

/** 这一帧能不能让对手自己打——所有守卫集中在这里，app.js 只负责调用。 */
export function shouldAutoShoot(state) {
  const g = state?.game;
  if (!g || g.phase === 'ended') return false;
  if (!state.autoOpponent || state.autoPaused) return false;
  if (g.turn !== 1) return false;
  if (state.animating || state.opponentThinking) return false;
  return true;
}

/**
 * 球桌上方那条提示的内容。null = 不显示。
 *
 * 「对手自动出杆」关掉时也要说话：轮到对手却没人动，最容易被当成卡死。
 * 这个提示只在轮到对手时出现，不会长期压在台面上。
 */
export function autoPauseHint(state) {
  const g = state?.game;
  if (!g || g.phase === 'ended') return null;
  if (state.autoPaused) {
    return {
      level: 'paused',
      canResume: true,
      text:
        state.autoPauseReason === 'undo'
          ? '已暂停对手自动出杆 —— 撤销之后先让你看清局面，点此继续'
          : '已暂停对手自动出杆 —— 读档之后先让你看清局面，点此继续',
    };
  }
  if (!state.autoOpponent && g.turn === 1) {
    return {
      level: 'off',
      canResume: false,
      text: '对手自动出杆已关闭 —— 轮到对手，点「求解」自己打这一杆',
    };
  }
  return null;
}