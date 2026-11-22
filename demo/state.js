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
import { SEARCH_DT } from '../src/constants.js';
import { createWorld, strike, stepWorld, allStopped, createRollTracker } from '../src/physics.js';
import { cueRestText, pocketName } from '../src/solver.js';

// ---------------------------------------------------------------- 数值

/** 夹在 [lo, hi] 之间。越界时返回边界值。 */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- 文本转义

/**
 * 把要拼进 HTML 的外部字符串转义。
 *
 * 拼进 innerHTML 之前必须过这一道：玩家名、存档里的文本、按钮上的数字，
 * 只要有一个来自页面之外，未转义就是一个注入点。
 * 它不读写任何 DOM——只做字符串替换，所以属于这一层。
 */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

// ---------------------------------------------------------------- 玩法 ↔ 球台

/**
 * 每种玩法默认配哪张台。
 *
 * 斯诺克必须是 12 尺台：彩球点位（开球线 737 mm、黑球距顶库 324 mm）是按
 * 3569 × 1778 mm 定的，搬到 9 尺台上整套点位会挤成一堆。
 * 八球默认 8 尺中式台（constants.js 里自己写的「国内球房最常见」），
 * 九球按惯例用 9 尺美式台——和 demo/app.js 里启动时那张台一致。
 */
export const DEFAULT_TABLE_BY_KIND = Object.freeze({
  eightball: 'pool8',
  nineball: 'pool9',
  snooker: 'snooker',
});

/**
 * 切到某个玩法之后该用哪张台。
 *
 * `manualByKind` 是「玩家在这套玩法下自己用球台下拉选过的台」，形如
 * `{ eightball: 'pool9' }`。显式选择优先于默认台：切走再切回来不能把人家
 * 选的台冲掉；但斯诺克例外，它只能配 12 尺台（理由见上），选了也不认。
 *
 * 返回值是球台 id（`TABLE_PRESETS` 的 key），调用方拿去喂 `createTable`。
 * 玩法不认识时返回 null——这里只回答「该换哪张台」，玩法合法性由
 * createRack / createGame 去抛，不要在这个函数里重复一套校验。
 */
export function tableForKind(kind, manualByKind = {}) {
  const fallback = DEFAULT_TABLE_BY_KIND[kind];
  if (!fallback) return null;
  // 斯诺克的点位是按 12 尺台钉死的，玩家选了别的台也不认。
  if (kind === 'snooker') return 'snooker';
  const manual = manualByKind?.[kind];
  return typeof manual === 'string' && manual ? manual : fallback;
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

// ---------------------------------------------------------------- 手打之后：下一杆

/**
 * 终局求解慢到这个毫秒数就不再等它，改口说「点求解看看」。
 *
 * 实测这台机器上「跳过组合球/翻袋」的终局求解：2 球 2–3 ms、满台 15 ms 上下。
 * 50 ms 已经等于三帧（20 fps 的回放），回放结束后再卡这么久，用户会以为页面
 * 死了。这条阈值只负责「别把画面拖住」，不许用它把已有候选藏起来——超时那
 * 一档文案只是改口指向「求解」按钮，不是说没有球可打。
 */
export const NEXT_SHOT_SLOW_MS = 50;

/**
 * 瞄准偏离到多少度才在播报里提一句。
 *
 * 滑块量程 ±8°、步进 0.05°：0.05° 在 1 米外只偏不到 1 毫米，每条播报都挂个
 * 尾巴只会变成噪音。0.2° 在 1 米外约偏 3.5 毫米，已经能明显改变薄球的进球率
 * ——够格让用户知道「这一杆不是你本来该打的方向」。低于它一律不提。
 */
export const AIM_NOTE_MIN_DEG = 0.2;

/**
 * 偏离推荐方向时补的那半句。没调过瞄准（touched 为假）就一个字都不加：
 * 那时偏移量只是面板上的初值，不代表用户做过选择。
 */
function aimOffsetNote(aimFrom, aimOffsetDeg, touched) {
  if (!touched) return '';
  const off = Number(aimOffsetDeg);
  if (!Number.isFinite(off) || Math.abs(off) < AIM_NOTE_MIN_DEG) return '';
  // 直撞局面（from === 'direct'）没有「推荐方向」可言，说成「推荐」就是撒谎
  const label = aimFrom === 'solution' ? '已偏离推荐' : '已偏离直指方向';
  return `${label} ±${Math.abs(off).toFixed(1)}°`;
}

/**
 * 一颗候选球怎么说人话：`3 号→右下底袋，容错 ±0.6°，母球停在台面上右（距上库 35 厘米）`。
 *
 * 袋名和母球停位都用求解器现成的函数，不在这里重写一套坐标系说法。
 * 候选缺字段时退化成能说的那几项，一项都没有就返回空串，由调用方兜底。
 */
function nextCandidateText(candidate, table) {
  const bits = [];
  const number = candidate?.targetNumber;
  const pocket = candidate?.pocketId ? pocketName(candidate.pocketId) : '';
  if (typeof number === 'number' && pocket) bits.push(`${number} 号→${pocket}`);
  const tol = Number(candidate?.toleranceDeg);
  if (Number.isFinite(tol) && tol > 0) bits.push(`容错 ±${tol.toFixed(1)}°`);
  if (candidate?.cueRest) {
    // cueRestText 是同一个求解器里的「母球建议停位：台面上右（距上库 35 厘米）」，
    // 这里只换个动词接在「下一步」后面，位置说法保持完全一致。
    bits.push(cueRestText(table, candidate.cueRest).replace('母球建议停位：', '母球停在'));
  }
  return bits.join('，');
}

/**
 * 「下一步」那一段。分支顺序就是用户脑子里的顺序：
 * 先问这局还打不打，再问有没有球能先碰，最后才谈怎么打进。
 */
function nextStepText({ balls, candidates, table, finished, solveMs }) {
  if (finished) return '本局已结束';

  const list = Array.isArray(balls) ? balls.filter((b) => b && typeof b.number === 'number') : [];
  const live = list.filter((b) => b.number !== 0 && !b.pocketed);
  if (!live.length) return '没有可以合法先碰的球';

  const cue = list.find((b) => b.number === 0);
  // 母球在袋里：从袋里出杆这件事不存在，任何「先碰某颗球」的建议都是假的。
  // 实测这种局面求解也必然返回空（母球停在袋里，假想球全算不出来），
  // 所以直接把话说全：先摆回台面。
  if (cue?.pocketed) return '没有可以合法先碰的球（母球落袋，先把它摆回台面）';

  // 没跑求解（抛错）或者跑得太慢：不假装自己看过局面，把活儿交回给「求解」
  if (!Number.isFinite(solveMs) || solveMs >= NEXT_SHOT_SLOW_MS) return '点「求解」看看';

  const best = Array.isArray(candidates) ? candidates[0] : null;
  const text = best ? nextCandidateText(best, table) : '';
  if (!text) return '没有直接的进球线，点「求解」看组合球或防守';
  return text;
}

/**
 * 手打一杆之后，把「这一杆的结果 + 下一步怎么打」拼成一整段播报。
 *
 * 纯函数：不碰 DOM、不跑物理、不读全局，求解结果由调用方（demo/app.js）算好传进来。
 * 这样同一段文案在 Node 单测里几毫秒能验一遍，不用起 Chrome 等回放。
 *
 * @param {object} input
 * @param {{detail: string[], pocketed: number[], cuePocketed: boolean}} input.outcome
 *        describeManualShot 的结果
 * @param {object[]} input.balls        终局局面（用来判断还有没有球能先碰、母球在不在）
 * @param {object[]|null} input.candidates  solveShot 的结果；null 表示没算出来
 * @param {object} [input.table]        球台，交给 cueRestText 说「距上库 35 厘米」
 * @param {boolean} [input.finished]    这一杆是否打完了这一局（清台 / 黑八结束）
 * @param {'solution'|'direct'} [input.aimFrom]  这一杆的方向来自求解还是直撞
 * @param {number} [input.aimOffsetDeg] 相对推荐方向的偏移（度）
 * @param {boolean} [input.touched]     用户是否动过手打滑块
 * @param {number} [input.speed]        手打力度（m/s）
 * @param {string} [input.tipBLabel]    杆法文字（中杆/高杆…）
 * @param {string} [input.tipALabel]    塞的文字（无塞/左塞…）
 * @param {number|null} [input.solveMs] 终局求解耗时；null / 非有限值表示没算成
 * @returns {string} 例如
 *   `手打结果：进 1 号 · 母球落袋（3.20 m/s · 中杆 · 无塞）｜下一步：3 号→右下底袋，容错 ±0.6°`
 */
export function describeNextShot(input) {
  const {
    outcome,
    balls,
    candidates = null,
    table = null,
    finished = false,
    aimFrom = 'direct',
    aimOffsetDeg = 0,
    touched = false,
    speed,
    tipBLabel = '',
    tipALabel = '',
    solveMs = null,
  } = input ?? {};

  const detail = outcome?.detail?.length ? outcome.detail.join(' · ') : '没有球进袋';

  const params = [];
  const v = Number(speed);
  if (Number.isFinite(v)) params.push(`${v.toFixed(2)} m/s`);
  if (tipBLabel) params.push(tipBLabel);
  if (tipALabel) params.push(tipALabel);
  const note = aimOffsetNote(aimFrom, aimOffsetDeg, touched);
  if (note) params.push(note);

  const head = params.length ? `手打结果：${detail}（${params.join(' · ')}）` : `手打结果：${detail}`;
  const next = nextStepText({ balls, candidates, table, finished, solveMs });
  return `${head}｜下一步：${next}`;
}

// ---------------------------------------------------------------- 空位

/**
 * 在台面上给新球找一个不压到任何球的位置：从台心向外螺旋找，找到就返回。
 *
 * 螺旋是按「环」走的：第 0 环就是台心，之后每环半径加 0.048（约 1.6 个球径），
 * 每环采样点不少于 8 个，并且每往外一环起点多转 0.37 弧度——不转的话所有环的
 * 采样点会落在同一个方向上，看起来就是「总往同一个角堆」。
 *
 * y 方向再乘 0.55：球台是长的，等比铺开会在纵向上浪费掉一半的分辨率。
 *
 * 台面尺度参数一律由调用方传入（table 的 bounds / ballRadius），这里不读全局。
 *
 * @returns {{x:number, y:number}|null} 找不到空位时返回 null，由调用方决定怎么提示。
 */
export function findSpot(balls, table) {
  const R2 = table.ballRadius * 2 + 1e-4;
  const clear = (x, y) =>
    x >= table.bounds.minX && x <= table.bounds.maxX &&
    y >= table.bounds.minY && y <= table.bounds.maxY &&
    !balls.some((b) => !b.pocketed && Math.hypot(b.x - x, b.y - y) < R2);

  for (let ring = 0; ring < 60; ring++) {
    const radius = ring * table.ballRadius * 1.6;
    const count = ring === 0 ? 1 : Math.max(8, ring * 8);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ring * 0.37;
      const x = table.length * 0.5 + Math.cos(a) * radius;
      const y = table.width * 0.5 + Math.sin(a) * radius * 0.55;
      if (clear(x, y)) return { x, y };
    }
  }
  return null;
}

// ---------------------------------------------------------------- 整杆模拟

/**
 * 一次整杆模拟最多走的物理步数。
 *
 * 这是**步数**上限，不是时间上限：原来这两处循环都写 `120 * 20`
 * （20 秒 × 每秒 120 步）。抽出来之后照旧按步数封顶，帧数与改动前逐字节一致；
 * 真按 dt 换算成时间会在 dt 换档时悄悄改变帧数。
 */
const MAX_FRAME_STEPS = 2400;

/**
 * 打一杆，把整杆的逐帧球位录下来给回放用。
 *
 * 这是原来 demo/app.js 里重复了两遍的那段循环（练习「演示这一杆」与练习「手打」），
 * 本体现在只此一份。它不碰 DOM、不看时钟：dt 由调用方传（真页面上是 SEARCH_DT），
 * 帧里只有球位、袋口与滚动量，播放节奏留给渲染层。
 *
 * 物理步长、步数上限、事件先后都不改：`strike` → 每步 `stepWorld` → 立刻录一帧 →
 * 全停就 break。注意 break 是在录帧**之后**判的，所以「停下那一刻」也会留一帧，
 * 回放的末帧不会停在上一步。
 *
 * 母球不在场上时返回 null（正常路径进不来：求解与手打都要求台上有母球），
 * 调用方原样早退即可，不要在这里抛。
 *
 * @param {Array} balls   当前局面的球（原数组不会被改动）
 * @param {object} table  球台，取自 src/table.js 的 createTable
 * @param {{angle:number, speed:number, tip:{a:number, b:number}}} shot 杆法
 * @param {number} dt     物理步长
 * @returns {{frames:Array, balls:Array, dt:number}|null}
 *   frames —— 每帧是「每颗球一行」的数组，结构同 captureBallFrame
 *   balls  —— 模拟用的那份副本的终局（手打结果描述要读它）
 */
export function simulateFrames(balls, table, shot, dt = SEARCH_DT) {
  const copy = copyBallsForShot(balls);
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === 'cue');
  if (!cue) return null;
  strike(cue, shot);

  const trackRoll = createRollTracker(copy, table.ballRadius);
  const frames = [captureBallFrame(copy, trackRoll)];
  for (let i = 0; i < MAX_FRAME_STEPS; i++) {
    stepWorld(world, dt);
    frames.push(captureBallFrame(copy, trackRoll));
    if (allStopped(world)) break;
  }
  return { frames, balls: copy, dt };
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

// ---------------------------------------------------------------- 瞄准 HUD

/**
 * 第一人称准星上那两行字，外加要画鬼球的坐标。
 *
 * 纯计算：只读局面、求解结果与力度滑块，产出 `{ title, detail, ghost }`。
 * 谁来画、画在哪里是渲染层的事——这里连 canvas 都不认识。
 *
 * 优先级：有解就用解（带袋口名与容错角），否则退到「手打瞄准」，
 * 连瞄准方向都没有时只报力度。
 *
 * @param {object} state demo/app.js 那份 state
 * @returns {{title:string, detail:string, ghost:{x:number,y:number}|null}}
 */
export function getAimHUDInfo(state) {
  const inGame = state.mode === 'game';
  const sol = inGame ? state.gSolution : state.solution;
  const tier = getPowerTier(state.manual.speed);
  if (sol?.found && sol.best) {
    const b = sol.best;
    return {
      title: '第一人称瞄准',
      detail: `${b.targetNumber} 号球 → ${pocketName(b.pocketId)} · 容错 ±${b.toleranceDeg.toFixed(2)}° · ${tier.level} ${state.manual.speed.toFixed(2)} m/s`,
      ghost: b.ghost,
    };
  }
  const aim = currentAim(state);
  if (aim) {
    const balls = inGame ? (state.game?.balls ?? []) : state.balls;
    const target = balls.find((b) => b.id === aim.targetId);
    return {
      title: '第一人称手打瞄准',
      detail: `${target ? target.number + ' 号球 · ' : ''}力度 ${state.manual.speed.toFixed(2)} m/s (${tier.level} ${tier.pct}%)`,
      ghost: target ? { x: target.x, y: target.y } : null,
    };
  }
  return {
    title: '第一人称瞄准',
    detail: `力度 ${state.manual.speed.toFixed(2)} m/s (${tier.level}) · 按 V 切换俯视`,
    ghost: null,
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
 * 杆史坐标的可行域：球心可行矩形（table.bounds）四周再放一圈「袋口容差」。
 *
 * 为什么不能直接用 bounds：落袋的球，球心在袋心附近，而袋心就落在台面边界上
 * （角袋 (0,0)、中袋 (L/2, 0)），所以一颗**合法**的落袋球完全可能落在 bounds
 * 之外。物理核判进袋用的是「到袋心距离 ≤ captureR」，那么任何一颗真实打出来的
 * 球，球心必然落在 `bounds ∪ 若干袋口捕获圆` 里，其坐标最远也就越出台面
 * 一个捕获半径。所以容差取 `max(2R, 最大 captureR)`：
 *   · 2R —— 题面要求的「一个球半径的量级」，防止把贴库/袋口边缘的球误杀；
 *   · 最大 captureR —— 袋口捕获半径（pool9 角袋 74 mm ≈ 2.6R），比 2R 更大，
 *     取二者最大才不会把「刚被袋口吃进去、坐标还在台外一点」的落袋球误判成坏步。
 *
 * 尺寸一律从调用方传进来的 table 上取，这一层不写死任何球台尺寸：换台（pool8 /
 * pool9 / snooker）之后同一份校验照样成立。
 *
 * 返回 null 表示这张台没给出可用的 bounds（异常夹具），此时不校验——宁可少拦，
 * 也不要让一份没有球台信息的局面把整段杆史全丢掉。
 */
function historyCoordLimit(table) {
  const b = table?.bounds;
  if (!b || ![b.minX, b.maxX, b.minY, b.maxY].every((v) => Number.isFinite(v))) return null;
  const r = Number.isFinite(table.ballRadius) ? table.ballRadius : 0;
  const jaw = Array.isArray(table.pockets)
    ? table.pockets.reduce((m, p) => (Number.isFinite(p?.captureR) ? Math.max(m, p.captureR) : m), 0)
    : 0;
  const margin = Math.max(2 * r, jaw);
  return {
    minX: b.minX - margin,
    maxX: b.maxX + margin,
    minY: b.minY - margin,
    maxY: b.maxY + margin,
  };
}

/**
 * 一步的坐标串是否整步都在可行域内。
 *
 * 写成 `!(v >= lo && v <= hi)` 而不是 `v < lo || v > hi`：NaN 参与任何比较都是
 * false，前一种写法会把它判成越界，后一种会静默放过。存档里出现 NaN 只能算坏数据。
 * 边界取闭区间——恰好落在上下界上仍然接受，只有真的越出去才丢这一步。
 */
function stepInRange(x, limit) {
  if (!limit) return true;
  for (let i = 0; i + 2 < x.length; i += 3) {
    const px = x[i];
    const py = x[i + 1];
    if (!(px >= limit.minX && px <= limit.maxX && py >= limit.minY && py <= limit.maxY)) return false;
  }
  return true;
}

/**
 * 存档里的杆史 → 撤销栈（旧的在前，和 pushHistoryEntry 的顺序一致）。
 *
 * baseGame 必须是「已经按存档装好进程态」的当前局面：球序、球台袋口、以及
 * 当前这局的 log 都从它上面取。载荷缺失（老存档没有这个字段）时返回空历史，
 * 由调用方决定怎么提示——绝不能因为老存档就直接报错。
 *
 * 单步坏掉（长度不对、球序对不上、坐标越出台面太多）只丢那一步并计入 dropped，
 * 不因此否掉整段杆史：整档已经被 save.js 的 sanitize 放行过一次，这里再整段丢
 * 就变成「球局读回来了、撤销栈却全没了」，比少几步更难解释。
 */
export function unpackHistory(packed, baseGame) {
  const empty = { entries: [], dropped: 0 };
  if (!packed || !baseGame || !Array.isArray(packed.s) || packed.s.length === 0) return empty;
  const ids = Array.isArray(packed.b) ? packed.b : [];
  const slots = ids.map((id) => baseGame.balls.findIndex((b) => b.id === id));
  if (ids.length === 0 || slots.some((i) => i < 0)) return empty;
  const pocketIds = baseGame.table.pockets.map((p) => p.id);
  // 越界坐标在旧版里会被原样装进撤销栈：读档看着「正常」，一点撤销母球就落到
  // 台面外，求解器还照着它给建议——「静默读到坏数据」比直接报错更糟。
  const limit = historyCoordLimit(baseGame.table);
  const entries = [];
  for (const step of packed.s) {
    if (!step || !Array.isArray(step.x) || step.x.length !== ids.length * 3) continue;
    if (!stepInRange(step.x, limit)) continue;
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

// ---------------------------------------------------------------- 存档要不要先问一句
//
// 两个标签页各开一局时，后点的那个会把先存的静默盖掉。原实现只比时间戳，
// 而「这个页面还没见过任何存档」（stamp 为 null）时一律放行——新开的标签页
// 正好是这个状态，所以第一次覆盖一定不会拦。
//
// 这里改成比「写入方」（哪个标签页写的，由 app.js 注入的一次性会话串）：
// 同一个会话自己反复存不打扰，发现存档是别的会话写的就先问一句。
// 判断写成纯函数放这里，是因为它最该被单测钉住——写错的表现是「安静地丢档」。

/**
 * 存档该不该先问一句再覆盖。
 *
 * @param {{stamp: number, session: string|null}|null} stored 存档里记的写入方与时间戳；没有存档传 null
 * @param {{stamp: number|null, session: string|null, overwrite?: boolean}} own 本页记着的状态
 * @returns {{write: boolean, reason: 'empty'|'same'|'other-tab'|'changed'|'confirmed'}}
 *   empty     没有已有存档（含存档坏掉读不出写入方）——直接写
 *   same      就是我自己写的那份——直接写
 *   confirmed 已经问过一次、用户再点了存档——这次真覆盖
 *   other-tab 存档是另一个会话（另一个标签页）写的——先问
 *   changed   我见过这份存档，但它被改过了（时间戳对不上）——先问
 */
export function reduceSaveWrite(stored, own) {
  const mine = own ?? {};
  if (!stored) return { write: true, reason: 'empty' };
  if (mine.overwrite) return { write: true, reason: 'confirmed' };
  // 两边都有会话串才比：老存档（这个字段还不存在）不该被当成别人的档拦下来。
  if (stored.session && mine.session && stored.session !== mine.session) {
    return { write: false, reason: 'other-tab' };
  }
  // 时间戳这条要留着：同一页面里改过存档（导入、测试伪造）也算「不是我认识的那份了」。
  if (mine.stamp !== null && mine.stamp !== undefined && stored.stamp !== mine.stamp) {
    return { write: false, reason: 'changed' };
  }
  return { write: true, reason: 'same' };
}