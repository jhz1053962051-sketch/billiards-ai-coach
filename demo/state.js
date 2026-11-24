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

import {
  GAME_KINDS,
  cloneGame,
  legalTargetNumbers,
  numbersOnTable,
  remainingOfGroup,
} from '../src/rules.js';
import { SEARCH_DT } from '../src/constants.js';
import { createWorld, strike, stepWorld, allStopped, createRollTracker } from '../src/physics.js';
import { ballLabel, cueRestText, pocketName, toleranceText } from '../src/solver.js';

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

/**
 * 把「页面上来的玩法字符串」校验成 GAME_KINDS 里的一个 id，不认识就抛。
 *
 * 这里是**唯一**的兜底闸门：下拉框给什么值、将来接 URL 参数给什么值，都必须先过
 * 这一道。以前写成 `GAME_KINDS[v] ? v : 'eightball'`——加十球 / 中式八球时忘了
 * 补分支，用户选中的新玩法会静默按黑八开一整局，规则全错而日志干干净净。
 * 名单只认 src/rack.js 的 GAME_KINDS，不在这里再抄一份。
 *
 * @param {unknown} value 待校验的玩法 id
 * @returns {string} 原样返回合法的 id
 */
export function gameKindOrThrow(value) {
  if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(GAME_KINDS, value)) {
    return value;
  }
  throw new Error(`不认识的玩法：${String(value)}（支持 ${Object.keys(GAME_KINDS).join(' / ')}）`);
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
  // 文案与按钮同名：面板说「实战打进 / 实战没进」，按钮上写的也是这两个词。
  // 原来写成「进了 / 没进」，用户会去找两个不存在的按钮。
  return '按实际结果点「实战打进」或「实战没进」——记下来才看得出进步。';
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
    const why = state.autoPauseReason === 'undo' ? '撤销之后' : '读档之后';
    // 轮到对手：暂停的是它的自动出杆，说清「点此继续」会让它接着打。
    // 轮到玩家：根本没有对手要暂停，让人误以为对手在等他；这时说的是
    // 「局面停住了，点此继续再求解」——按钮上的灰也是照着这句话给的理由。
    if (g.turn === 1) {
      return {
        level: 'paused',
        canResume: true,
        text: `已暂停对手自动出杆 —— ${why}先让你看清局面，点此继续`,
      };
    }
    return {
      level: 'paused',
      canResume: true,
      text: `${why}局面先停住不动 —— 点此继续，再按「求解」打这一杆`,
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

// ---------------------------------------------------------------- 局内统计
//
// 一局打完要回答的无非是「打了多少杆、进了几个、最长连着进了几杆、犯了几次规」。
// 这些数**只能从 g.log 里读**：log 的每一项是 { shot, shooter, summary, fouls }，
// 而球桌那一刻的球位没人存过。所以解析的正确性完全取决于 summary 的真实文案，
// 下面两条正则是对着 src/rules.js:838-851（黑八 / 九球）与 src/snooker.js:418-431
// （斯诺克）逐句抄下来的，不是猜的：
//
//   `开球 · 进 1、2 号 · 你 继续`            ← 一杆进两颗
//   `没有球进袋 · 犯规：母球落袋（WPA 3.1） · 换 对手`
//   `得 8 分 · 32 : 41 · 该打红球 · 你 继续`  ← 斯诺克，没有球号，只有得分
//
// 两条硬约束：
//   · 边界情况一律退化成 0 / null，**不许抛**——统计面板挂了不该把整页带走；
//   · 「进球」按**杆**数，不按颗数：开球一杆进三颗算一次进球，否则 potRate 会
//     出现 300%，界面上写着「命中率」却超过 100% 是明确的 bug。

/** 一杆的播报里「进 1、2 号」这一段。斯诺克没有球号（红球同号），走另一条。 */
const POTTED_NUMBERS = /进\s*(\d+(?:\s*[、,，]\s*\d+)*)\s*号/;

/** 斯诺克的一杆有得分就说明至少进了一颗（红球 1 分起，彩球 2 分起）。 */
const SNOOKER_POINTS = /得\s*(\d+)\s*分/;

/** 犯规的兜底判据：log 里带 fouls 数组，早期手写记录只有文案。 */
const FOUL_WORD = /犯规/;

/**
 * 一局结束那一杆的播报会被整句换成结束语，进袋信息就没了。
 *
 * 三种玩法都是这个写法（src/rules.js:838-851 的黑八 / 九球、src/snooker.js:430
 * 的斯诺克）：`你 与 对手 的这一局结束：你 获胜。`。所以按键球算完再补一条规则，
 * 见下面 computeMatchStats 里的收尾判定。
 */
const GAME_ENDED = /这一局结束/;

/** 统计面板与跨局战绩都只看最近这么多场。 */
export const MATCH_RECENT_LIMIT = 10;

/**
 * 把 log 里的一条读成「这一杆干了什么」。
 *
 * 只在内部用：形状不对的输入退化成空杆，不抛。
 *
 * @param {unknown} raw
 * @param {string} kind 玩法 id（snooker 时用得分判定进球）
 * @returns {{shot:number|null, shooter:number|null, foul:boolean, potted:boolean, balls:number}}
 */
function readLogEntry(raw, kind) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const summary = typeof e.summary === 'string' ? e.summary : '';
  const fouls = Array.isArray(e.fouls) ? e.fouls.filter((c) => typeof c === 'string' && c) : [];
  const shotNumber = Number(e.shot);
  const shooterNumber = Number(e.shooter);
  let balls = 0;
  const numbers = POTTED_NUMBERS.exec(summary);
  if (numbers) {
    balls = numbers[1].split(/[、,，]/).filter((n) => n.trim()).length;
  } else if (kind === 'snooker') {
    const points = SNOOKER_POINTS.exec(summary);
    if (points && Number(points[1]) > 0) balls = 1;
  }
  const foul = fouls.length > 0 || FOUL_WORD.test(summary);
  return {
    shot: Number.isFinite(shotNumber) && shotNumber > 0 ? Math.floor(shotNumber) : null,
    shooter: shooterNumber === 0 || shooterNumber === 1 ? shooterNumber : null,
    foul,
    // 犯规那一杆即使有球进袋也不算进球：进的是不该进的球，或者母球一起进了。
    potted: balls > 0 && !foul,
    balls,
    // 这一条是不是「本局结束」那句总结。收官那一杆进没进球要看它，见 computeMatchStats。
    end: GAME_ENDED.test(summary),
  };
}

/**
 * 这一杆算不算「进球」。
 *
 * 普通一杆直接看 readLogEntry 的 potted；收官那一条的播报被整句换成了
 * 「这一局结束：X 获胜」，进袋信息丢了。但它同时说明了一件事：这一杆的击球者
 * 就是胜者、而且没有犯规——能以一杆结束本局的只有「打进最后的球」（黑八打进
 * 8 号、九球打进 9 号、斯诺克清完最后一颗）；反过来，犯规收场（只剩黑球时犯规）
 * 或提前把 8 号打进导致输局，击球者都不是胜者，或者 fouls 非空，都不会被算成进球。
 *
 * @param {{potted:boolean, end:boolean, foul:boolean, shooter:number|null}} entry
 * @param {number|null} winner
 */
function isPotted(entry, winner) {
  return entry.potted || (entry.end && !entry.foul && winner !== null && entry.shooter === winner);
}

/**
 * 本局统计。
 *
 * @param {{log?:unknown[], balls?:unknown[], kind?:string, winner?:number|null, myself?:number}} [input]
 *   log    对局流水（src/rules.js 的 g.log）
 *   balls  当前球位（这一版还没用到，留着让调用方按真实签名传，将来做「剩几颗」不必改调用点）
 *   kind   玩法 id，斯诺克要靠它换一套解析
 *   winner 胜者下标；没结束时传 null / undefined
 *   myself 自己是哪一方，默认 0
 * @returns {{shots:number, pots:number, potRate:number|null, longestRun:number, fouls:number, result:'win'|'loss'|'undecided'}}
 */
export function computeMatchStats(input) {
  const src = input && typeof input === 'object' ? input : {};
  const log = Array.isArray(src.log) ? src.log : [];
  const kind = typeof src.kind === 'string' ? src.kind : '';

  // 同一条杆号出现两次 = 那不是一杆。开球不达标、接手方选择交回时，规则引擎会
  // 往 log 里补一条「决定」，杆号与刚打完的那一杆相同（src/rules.js:829-834），
  // 它既不增加杆数也不该被当成一杆来算进球。readMatchLog 把这条规则收成一份，
  // 复盘图（buildMatchSummary）用的是同一份，免得两处数出来的杆数不一样。
  const entries = readMatchLog(log, kind);
  let highestShot = 0;
  for (const entry of entries) {
    if (entry.shot !== null && entry.shot > highestShot) highestShot = entry.shot;
  }
  // 杆号是 1..N 连续发的（src/rules.js 用 next.shots 当杆号），所以最大杆号就是
  // 总杆数；整份 log 都没有杆号（手写记录）时退回数条目。
  const shots = highestShot > 0 ? highestShot : entries.length;

  // 胜者先定下来：收官那一杆算不算进球要看它（见下面的 potted 判定）。
  const w = src.winner;
  const winner = w === 0 || w === 1 ? w : w === '0' ? 0 : w === '1' ? 1 : null;
  const me = Number(src.myself) === 1 ? 1 : 0;

  let pots = 0;
  let fouls = 0;
  let run = 0;
  let longestRun = 0;
  let lastShooter = null;
  for (const entry of entries) {
    if (entry.foul) fouls += 1;
    // 收官那一杆算不算进球，见 isPotted()。
    const potted = isPotted(entry, winner);
    if (potted) {
      pots += 1;
      // 连着进球：同一个人、中间没有空杆也没有犯规。换手后从 1 重新数。
      run = lastShooter !== null && entry.shooter === lastShooter ? run + 1 : 1;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
    if (entry.shooter !== null) lastShooter = entry.shooter;
  }

  return {
    shots,
    pots,
    // 0 杆时没有「命中率」可言。返回 null 而不是 0，也不是 NaN：0 会被界面上
    // 写成「0%」，那是「打了但一杆没进」，和「还没打」是两件事。
    potRate: shots > 0 ? pots / shots : null,
    longestRun,
    fouls,
    result: winner === null ? 'undecided' : winner === me ? 'win' : 'loss',
  };
}

/**
 * 跨局汇总。输入是存储里那一串「每场一条」的摘要，形状不对的条目跳过。
 *
 * 总体命中率按杆数加权，不是把每场的百分比求平均：一场 1 杆 100% 和一场
 * 20 杆 50% 平均成 75% 是错的，真实命中率是 (1 + 10) / 21 ≈ 52%。
 *
 * @param {unknown[]} entries
 * @returns {{matches:number, wins:number, losses:number, undecided:number, shots:number, potRate:number|null, longestRun:number, recent:Array<'win'|'loss'|'undecided'>}}
 *   recent 是最近 MATCH_RECENT_LIMIT 场的走势，**旧 → 新**，界面上直接画成一排暖/冷点。
 */
export function summarizeHistory(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let matches = 0;
  let wins = 0;
  let losses = 0;
  let undecided = 0;
  let shots = 0;
  let longestRun = 0;
  let weightedRate = 0;
  let weightedShots = 0;
  const results = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const result = raw.result === 'win' || raw.result === 'loss' ? raw.result : 'undecided';
    const oneShots =
      typeof raw.shots === 'number' && Number.isFinite(raw.shots) && raw.shots > 0
        ? Math.floor(raw.shots)
        : 0;
    const rate =
      typeof raw.potRate === 'number' && Number.isFinite(raw.potRate)
        ? clamp(raw.potRate, 0, 1)
        : null;
    const run =
      typeof raw.longestRun === 'number' && Number.isFinite(raw.longestRun) && raw.longestRun > 0
        ? Math.floor(raw.longestRun)
        : 0;
    matches += 1;
    if (result === 'win') wins += 1;
    else if (result === 'loss') losses += 1;
    else undecided += 1;
    shots += oneShots;
    if (rate !== null && oneShots > 0) {
      weightedRate += rate * oneShots;
      weightedShots += oneShots;
    }
    if (run > longestRun) longestRun = run;
    results.push(result);
  }
  return {
    matches,
    wins,
    losses,
    undecided,
    shots,
    potRate: weightedShots > 0 ? weightedRate / weightedShots : null,
    longestRun,
    recent: results.slice(-MATCH_RECENT_LIMIT),
  };
}

// ---------------------------------------------------------------- 分享图（导出这一杆）
//
// 「分享这一杆」导出的图分上下两块：上面是台面俯视图，下面是这一节产出的
// 文字。分工写清楚，免得日后又混在一起：
//   **排版**（几行、字号、怎么折行、落在图上哪个坐标）留在 app.js——那是画布的事；
//   **说什么**（标题、字段顺序、每条的值怎么措辞）在这里，于是同一段文案能在
//   Node 里逐字断言，不必起浏览器。
// 所以这里只返回结构化数据，不返回拼好的整块字符串：行距和折行不该由状态层决定。

/** toleranceText 自己带「容错」二字；图上已经是「字段名 + 值」的结构，得去掉重复的那半边。 */
const SHARE_TOL_PREFIX = /^容错\s*/;
/** cueRestText 同理。顺带兼容不带球台时退回的坐标版本（`母球建议停位 (x, y) 米`）。 */
const SHARE_REST_PREFIX = /^母球建议停位[：:]?\s*/;

/**
 * 这一杆要印在图上的文案：一个标题 + 若干「字段 / 值」行。
 *
 * 输入刻意宽容：`shot` 既可以是 coach() 的整张卡（`{ found, best, message }`），
 * 也可以直接是候选对象（`state.solution.best` 那一个）。缺字段、类型不对、整个
 * 传空都不抛——**能导出一张「这一杆没解」的图，比在按钮上炸掉有用**。
 *
 * @param {{shot?:unknown, table?:object, balls?:unknown[]}} [input]
 *   shot  coach() 卡片或单个候选；null / 无解卡片都走「没解」分支
 *   table 有就用来算母球落点相对哪条库边（三个朝向三分法的依据是台长台宽）
 *   balls 有就让「母球已落袋」这种状态显出来
 * @returns {{title:string, lines:Array<{label:string, value:string}>}}
 *   lines 顺序固定：目标球 → 袋口 → 杆法 → 力度 → 切角 → 容错 → 母球落点，
 *   母球有摔袋风险时末尾追加一行「⚠ 注意」
 */
export function buildShareSummary({ shot, table, balls } = {}) {
  const card = shot && typeof shot === 'object' ? shot : {};
  const best = card.best && typeof card.best === 'object' ? card.best : null;
  const candidate = best || (looksLikeCandidate(card) ? card : null);

  if (card.found === false || !candidate) {
    const message = typeof card.message === 'string' ? card.message.trim() : '';
    return {
      title: '这一杆没有可以直接进攻的球',
      lines: [{ label: '说明', value: message || '需要打防守，或先解一杆。' }],
    };
  }

  const c = candidate;
  const ball = shareBallText(c.targetNumber);
  const pocket =
    typeof c.pocketId === 'string' && c.pocketId ? pocketName(c.pocketId) : '';
  const lines = [
    { label: '目标球', value: ball },
    { label: '袋口', value: pocket || '不限（只保证合法碰球）' },
    { label: '杆法', value: shareTipText(c) },
    { label: '力度', value: sharePowerText(c) },
    { label: '切角', value: shareCutText(c) },
    { label: '容错', value: shareToleranceText(c) },
    { label: '母球落点', value: shareCueRestText(table, c, balls) },
  ];
  // 摔袋是「别照着打」的强信号，值得单独一行而不是塞在母球落点里
  if (c.scratchRisk === true || (c.cuePath && c.cuePath.kind === 'pocket')) {
    lines.push({ label: '⚠ 注意', value: '母球有摔袋风险' });
  }

  return {
    title: pocket ? `${ball} → ${pocket}` : `${ball}（不指定袋口）`,
    lines,
  };
}

/** 卡片的 best 缺失时，靠这两个字段判断「传进来的其实就是候选本身」。 */
function looksLikeCandidate(obj) {
  return (
    (typeof obj.targetNumber === 'number' && Number.isFinite(obj.targetNumber)) ||
    (typeof obj.pocketId === 'string' && obj.pocketId.length > 0)
  );
}

function shareBallText(number) {
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return '—';
  // ballLabel 对 1..15 出「7 号球」，对 16+ 出「黑球」——斯诺克彩球天然走到后者
  return ballLabel(number);
}

function shareTipText(c) {
  const name = c.tip && typeof c.tip.name === 'string' ? c.tip.name.trim() : '';
  return name || '—';
}

function sharePowerText(c) {
  const name = c.power && typeof c.power.name === 'string' ? c.power.name.trim() : '';
  const speed = typeof c.speed === 'number' && Number.isFinite(c.speed) ? c.speed : null;
  // 力度光说「中」不够——同一个人隔天看这张图，m/s 才是能复现的那一半
  if (name && speed !== null) return `${name}力（${speed.toFixed(2)} m/s）`;
  if (name) return `${name}力`;
  if (speed !== null) return `${speed.toFixed(2)} m/s`;
  return '—';
}

function shareCutText(c) {
  return typeof c.cutDeg === 'number' && Number.isFinite(c.cutDeg)
    ? `${c.cutDeg.toFixed(0)}°`
    : '—';
}

function shareToleranceText(c) {
  if (typeof c.toleranceDeg !== 'number' || !Number.isFinite(c.toleranceDeg)) return '—';
  // toleranceDeg <= 0 表示「这一杆没有可用的容错窗」，别印成 ±0.00° 让人以为精度极高
  if (c.toleranceDeg <= 0) return '—';
  const text = toleranceText(c).replace(SHARE_TOL_PREFIX, '').trim();
  return text || '—';
}

/**
 * 母球落点。cueRest 有坐标就问 cueRestText 要方位（它会按台长台宽算「台面上右」
 * 这类说法，还带上离最近库边的厘米数）；没有落点就分两种情况说清楚：
 * 母球已经落袋 / 这一杆没要求走位——这俩在图上必须能区分。
 */
function shareCueRestText(table, c, balls) {
  const rest = c.cueRest;
  if (rest && typeof rest === 'object' && Number.isFinite(rest.x) && Number.isFinite(rest.y)) {
    const text = cueRestText(table, rest).replace(SHARE_REST_PREFIX, '').trim();
    if (text && text !== '—') return text;
  }
  const cue = cueBallOf(balls);
  if (cue && cue.pocketed === true) return '母球已落袋';
  return '未要求走位';
}

function cueBallOf(balls) {
  if (!Array.isArray(balls)) return null;
  for (const b of balls) {
    if (!b || typeof b !== 'object') continue;
    if (b.number === 0 || b.id === 'cue') return b;
  }
  return null;
}

// ---------------------------------------------------------------- 分享图（导出局面）
//
// 第二种导出：整张台面的俯视图，下半是「这局现在什么情况」。
//
// 和「这一杆」那一份共用同一套出图管线（`buildShareSheet`），所以这里同样只负责
// **说什么**：标题、行序、每行的措辞。区别在于它看的是**局面**而不是某一杆，
// 因此入参是 game + balls，`shot` 只用来回答「下一步怎么打」这一行。
//
// 多给一个 `mark`：图上的圈要圈哪几颗球。它是「当前该打哪一组」的唯一出处——
// 文案里说「你 全色 剩 6」和图上圈住的那六颗必须是同一批号码，所以两者都在这里算，
// 不让绘图层自己再推一遍（推两遍就会有一天对不上）。

/** 组别的中文说法。app.js 的 GROUP_LABEL 多带了 cue/eight，是记分牌在用的，别并过来。 */
const TABLE_GROUP_NAME = { solid: '全色', stripe: '花色' };
const TABLE_KIND_LABEL = { eightball: '八球', nineball: '九球', snooker: '斯诺克' };

/**
 * 局面要点：一个标题 + 若干「字段 / 值」行 + 圈球用的 mark。
 *
 * 与 buildShareSummary 一样刻意宽容：game 缺字段、balls 不是数组、shot 是半截对象
 * 都不抛——**能导出一张「还没开局」的图，比在按钮上炸掉有用**。唯一的例外是
 * game.kind：玩法不认识说明代码少了一路分支（不是数据坏），那时必须响亮地报错，
 * 见 tableMarkLabel。
 *
 * @param {{game?:object|null, balls?:unknown[], table?:object, shot?:unknown}} [input]
 *   game   createGame() 出来的对局；传空就是练习摆球（没有比分可印）
 *   balls  台面上的球；不传就退回 game.balls
 *   table  球台。目前不参与文案（球台名由出图那层的 meta 印），保留这个入参是为了
 *          和 buildShareSummary 的调用形状一致，将来要算落点也不用改调用方
 *   shot   求解结果（coach 卡）：有就给一句「下一步怎么打」，没有就写「还没求解」
 * @returns {{title:string, lines:Array<{label:string, value:string}>,
 *   mark:{numbers:number[], label:string}}}
 *   lines 顺序固定：玩法/轮到 → 比分 → 球组（斯诺克是球局）→ 下一步
 */
export function buildTableSummary(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const g = opts.game && typeof opts.game === 'object' ? opts.game : null;
  const list = tableBallsOf(opts.balls, g);
  const onTable = numbersOnTable(list);
  const cue = cueBallOf(list);
  const next = tableNextShotText(opts.shot);
  if (!g) return practiceTableSummary(onTable, cue, next);
  return matchTableSummary(g, onTable, next);
}

/** 台面上的球：优先用调用方给的，其次用对局里的；非对象一律剔掉。 */
function tableBallsOf(balls, g) {
  const source = Array.isArray(balls)
    ? balls
    : Array.isArray(g && g.balls)
      ? g.balls
      : [];
  return source.filter((b) => b && typeof b === 'object');
}

/** 练习摆球：没有对局，只有「台面还剩几颗」。 */
function practiceTableSummary(onTable, cue, next) {
  const n = onTable.length;
  const title = n ? `练习台面 · 还剩 ${n} 颗球` : '练习台面 · 已经清台';
  return {
    title,
    lines: [
      { label: '玩法', value: '练习摆球（还没开局）' },
      {
        label: '台面',
        value: `${n} 颗目标球 · ${cue ? '母球在台上' : '母球不在台上'}`,
      },
      { label: '下一步', value: next },
    ],
    // 练习模式没有分组，一颗都不圈：圈了反而像在暗示「打这几颗」
    mark: { numbers: [], label: '练习摆球' },
  };
}

/** 正式对局：玩法 / 轮到谁 → 比分 → 球组或红球 → 下一步。 */
function matchTableSummary(g, onTable, next) {
  const kind = typeof g.kind === 'string' ? g.kind : '';
  const kindLabel = TABLE_KIND_LABEL[kind] || '对局';
  const players = Array.isArray(g.players) ? g.players : [];
  const nameOf = (i) => {
    const p = players[i];
    const name = p && typeof p.name === 'string' ? p.name.trim() : '';
    return name || `玩家 ${i + 1}`;
  };
  const groupOfPlayer = (i) => {
    const p = players[i];
    return p && (p.group === 'solid' || p.group === 'stripe') ? p.group : null;
  };
  const p0 = nameOf(0);
  const p1 = nameOf(1);
  const g0 = groupOfPlayer(0);
  const g1 = groupOfPlayer(1);
  const left0 = g0 ? remainingOfGroup(onTable, g0) : 0;
  const left1 = g1 ? remainingOfGroup(onTable, g1) : 0;
  const ended = g.phase === 'ended';
  const winnerName =
    ended && typeof g.winner === 'number' && players[g.winner] ? nameOf(g.winner) : '';
  const shots = Number.isFinite(g.shots) ? g.shots : 0;
  const turn = g.turn === 1 ? 1 : 0;
  const turnGroup = turn === 0 ? g0 : g1;

  const title = ended
    ? `${kindLabel} · ${winnerName ? `${winnerName} 获胜` : '本局结束'}`
    : `${kindLabel} · ${shots > 0 ? `第 ${shots} 杆` : '开球'}`;

  const lines = [];
  if (ended) {
    lines.push({ label: '状态', value: winnerName ? `本局结束 · ${winnerName} 获胜` : '本局结束' });
  } else {
    // 八球的「轮到谁」得带上他打哪一组，否则光看名字不知道他该打什么
    const who = nameOf(turn);
    lines.push({
      label: '轮到',
      value: kind === 'eightball' ? `${who}（${turnGroup ? TABLE_GROUP_NAME[turnGroup] : '未分组'}）` : who,
    });
  }

  if (kind === 'snooker') {
    const scores = g.snooker && Array.isArray(g.snooker.scores) ? g.snooker.scores : [];
    const s0 = Number.isFinite(scores[0]) ? scores[0] : 0;
    const s1 = Number.isFinite(scores[1]) ? scores[1] : 0;
    lines.push({ label: '比分', value: `${p0} ${s0} : ${s1} ${p1}` });
  } else if (kind === 'nineball') {
    // 九球不记「谁进了几颗」，能对上的只有「台面还剩几颗」与已落袋数；
    // 一颗都不剩（或根本没给 balls）时别倒推出「已进 9 颗」那种假数字
    lines.push({
      label: '比分',
      value: onTable.length
        ? `已进 ${Math.max(0, 9 - onTable.length)} 颗 · 台面剩 ${onTable.length} 颗`
        : '台面已清空',
    });
  } else if (!g0 && !g1) {
    lines.push({ label: '比分', value: `未分球 · 台面剩 ${onTable.length} 颗` });
  } else {
    const potted0 = g0 ? 7 - left0 : 0;
    const potted1 = g1 ? 7 - left1 : 0;
    lines.push({ label: '比分', value: `${p0} ${potted0} : ${potted1} ${p1}` });
  }

  if (kind === 'snooker') {
    lines.push({ label: '球局', value: snookerTableText(g, onTable) });
  } else if (kind === 'nineball') {
    const target = onTable.length ? Math.min(...onTable) : null;
    lines.push({
      label: '球组',
      value: target ? `无分组 · 目标 ${target} 号球 · 台面剩 ${onTable.length} 颗` : '无分组 · 台面已清空',
    });
  } else if (!g0 && !g1) {
    lines.push({ label: '球组', value: `未分球 · 台面剩 ${onTable.length} 颗` });
  } else {
    const left = [
      `${p0} ${g0 ? TABLE_GROUP_NAME[g0] : '未分组'} 剩 ${g0 ? left0 : 0}`,
      `${p1} ${g1 ? TABLE_GROUP_NAME[g1] : '未分组'} 剩 ${g1 ? left1 : 0}`,
    ].join(' · ');
    // 两组都清完只剩黑八，是八球最后那段最需要说清楚的状态
    const onlyEight = onTable.length === 1 && onTable[0] === 8;
    lines.push({ label: '球组', value: onlyEight ? `${left} · 只剩黑八` : left });
  }

  lines.push({ label: '下一步', value: next });

  const targets = safeLegalTargets(g, onTable);
  return {
    title,
    lines,
    mark: { numbers: targets, label: tableMarkLabel(kind, turnGroup, targets) },
  };
}

/** 图例文案：图上圈住的这批球在叫什么。 */
function tableMarkLabel(kind, turnGroup, targets) {
  // 显式穷举，不留 else：以前最后一行是 `return '台面'`，加十球 / 中式八球时
  // 忘了在这里补分支，导出的图上会印一句和玩法无关的「台面」，而且不报错。
  switch (kind) {
    case 'eightball':
      return turnGroup ? TABLE_GROUP_NAME[turnGroup] : '未分组';
    case 'nineball':
      return targets.length ? `目标 ${targets[0]} 号球` : '台面已清空';
    case 'snooker':
      return '当前该打';
    default:
      throw new Error(
        `不认识的玩法：${String(kind)}（图例文案没有对应分支，支持 ${Object.keys(GAME_KINDS).join(' / ')}）`
      );
  }
}

/** 斯诺克那一行：红球还剩几颗 + 这一杆该打什么。 */
function snookerTableText(g, onTable) {
  const redsOnTable = onTable.filter((n) => n >= 1 && n <= 15).length;
  const fromGame = g.snooker && Number.isFinite(g.snooker.reds) ? g.snooker.reds : null;
  // 台面数得到就用台面的；一颗红球都没有时才信对局里记的那个数（比如刚清完红球）
  const reds = redsOnTable || (fromGame === null ? 0 : fromGame);
  const ballOn = g.snooker ? g.snooker.ballOn : 'red';
  return `红球剩 ${reds} 颗 · 该打 ${snookerBallOnText(ballOn)}`;
}

function snookerBallOnText(ballOn) {
  if (ballOn === 'red') return '红球';
  if (ballOn === 'color') return '任意彩球';
  if (typeof ballOn === 'number' && Number.isFinite(ballOn) && ballOn > 0) return ballLabel(ballOn);
  return '红球';
}

/**
 * 这一杆允许先碰的球号。规则函数在局面畸形时会抛（比如 players 缺失、turn 越界），
 * 而导图不该因为一份坏存档炸掉——圈不出来就不圈。
 */
function safeLegalTargets(g, onTable) {
  try {
    const list = legalTargetNumbers(g, onTable);
    return Array.isArray(list)
      ? list.filter((n) => typeof n === 'number' && Number.isFinite(n))
      : [];
  } catch {
    return [];
  }
}

/**
 * 「下一步怎么打」一句话。有解就照 coach 卡说人话（球 → 袋口，杆法 · 力度）；
 * 没解时说清楚是「还没求解」还是「求解过但没球可打」——这两件事对用户完全不同。
 */
function tableNextShotText(shot) {
  const card = shot && typeof shot === 'object' ? shot : null;
  if (!card) return '还没求解';
  const best = card.best && typeof card.best === 'object' ? card.best : null;
  const cand = best || (looksLikeCandidate(card) ? card : null);
  if (!cand) {
    const message = typeof card.message === 'string' ? card.message.trim() : '';
    if (message) return message;
    if (card.found === false) return '求解过：没有可直接进攻的球，先防守或解一杆。';
    return '还没求解';
  }
  const ball = shareBallText(cand.targetNumber);
  const pocket = typeof cand.pocketId === 'string' && cand.pocketId ? pocketName(cand.pocketId) : '';
  const tip = cand.tip && typeof cand.tip.name === 'string' ? cand.tip.name.trim() : '';
  const power = cand.power && typeof cand.power.name === 'string' ? cand.power.name.trim() : '';
  const how = [tip, power ? `${power}力` : ''].filter(Boolean).join(' · ');
  const main = pocket ? `${ball} → ${pocket}` : `${ball}（不指定袋口）`;
  return how ? `${main}，${how}` : main;
}

// ---------------------------------------------------------------- 整局复盘图
//
// 第三种导出：终局台面 + 比分走势 + 关键杆与统计。它和另外两张**共用同一条管线**：
//   state.js 只决定「说什么」（标题、字段顺序、每个值的措辞、折线给哪些点），
//   app.js 的 buildShareSheet 决定「怎么排」，render.js 只画台面。
// 所以这里没有一行 DOM / canvas：chart 是纯数据，连颜色都不给——那是绘图层的事。
//
// 未结束的局返回 null。**绝不**编一份「0:0 的复盘」：一张看起来像复盘、实际
// 什么也没发生的图，比没有图更误导人。调用方拿到 null 就把按钮禁掉并说清原因。

/** 折线最多这么多点；再长就按等间距抽点，否则 100 杆的局会糊成一条实心带。 */
const MATCH_CHART_LIMIT = 60;
/** 关键杆最多印这么多条，多了会和下面的统计块抢注意力。 */
const MATCH_KEY_LIMIT = 3;

/** 犯规代码的人话。src/rules.js 与 src/snooker.js 用的是同一套 id。 */
const FOUL_CODE_TEXT = {
  illegal_break: '开球不合法',
  scratch: '母球落袋',
  no_contact: '母球没碰到球',
  wrong_ball_first: '先碰错球',
  no_rail: '无球碰库',
  wrong_ball_potted: '打进不该进的球',
};

/**
 * 把 log 读成去重后的杆列表（同一杆号只算一次，开球不达标那条「决定」不算一杆）。
 *
 * 从 computeMatchStats 里抽出来的，两处共用同一份解析与去重规则——统计面板和
 * 复盘图如果各解析一遍，迟早会出现「页面说 12 杆、图上画 13 杆」。
 *
 * @param {unknown[]} log
 * @param {string} kind
 * @returns {Array<ReturnType<typeof readLogEntry> & {raw:unknown}>}
 */
function readMatchLog(log, kind) {
  const entries = [];
  const seen = new Set();
  for (const raw of log) {
    const entry = readLogEntry(raw, kind);
    if (entry.shot !== null) {
      if (seen.has(entry.shot)) continue;
      seen.add(entry.shot);
    }
    entries.push({ ...entry, raw });
  }
  return entries;
}

/** 胜者下标；没结束、或者存档里是脏值都给 null。 */
function matchWinnerOf(game) {
  const w = game.winner;
  if (w === 0 || w === 1) return w;
  if (w === '0') return 0;
  if (w === '1') return 1;
  return null;
}

/** 玩家名；缺字段时退回「你 / 对手」，和 newGame 的默认名一致。 */
function matchPlayerName(game, i) {
  const players = Array.isArray(game.players) ? game.players : [];
  const p = players[i];
  const name = p && typeof p.name === 'string' ? p.name.trim() : '';
  return name || (i === 0 ? '你' : '对手');
}

/**
 * 按杆累计的进球曲线：`[{x, y1, y2}]`，x 是杆号，y1 是「我」的累计进球，
 * y2 是对手的。第一个点是 (0, 0, 0)，折线从坐标原点起步，不会凭空从中间开始。
 *
 * @param {Array<{shot:number|null, shooter:number|null}>} entries
 * @param {number|null} winner
 * @returns {{series:Array<{x:number, y1:number, y2:number}>, pots:[number, number]}}
 */
function matchSeriesOf(entries, winner) {
  const series = [{ x: 0, y1: 0, y2: 0 }];
  const pots = [0, 0];
  let y1 = 0;
  let y2 = 0;
  let lastX = 0;
  for (const entry of entries) {
    // 杆号本来就该递增；手写记录缺号时按顺序补一个，免得两条点落在同一 x 上。
    const x = entry.shot !== null && entry.shot > lastX ? entry.shot : lastX + 1;
    lastX = x;
    if (isPotted(entry, winner)) {
      if (entry.shooter === 0) {
        pots[0] += 1;
        y1 += 1;
      } else if (entry.shooter === 1) {
        pots[1] += 1;
        y2 += 1;
      }
    }
    series.push({ x, y1, y2 });
  }
  return { series, pots };
}

/**
 * 等间距抽点，首尾必留。返回的数组长度不超过 limit，x 严格递增。
 *
 * @param {Array<{x:number}>} points
 * @param {number} limit
 */
function sampleMatchSeries(points, limit) {
  if (points.length <= limit) return points;
  const out = [];
  const last = points.length - 1;
  for (let i = 0; i < limit; i += 1) {
    const p = points[Math.round((i * last) / (limit - 1))];
    if (!out.length || out[out.length - 1].x !== p.x) out.push(p);
  }
  // 取整可能把最后一点挤掉（虽然这里不会），补一次保证折线收在终局。
  if (out[out.length - 1].x !== points[last].x) out.push(points[last]);
  return out;
}

/** 最长连击的区间（连续进球、同一人、中间没有空杆/犯规）。 */
function longestRunRange(entries, winner) {
  let best = { len: 0, from: null, to: null };
  let run = 0;
  let from = null;
  let lastShooter = null;
  for (const entry of entries) {
    if (!isPotted(entry, winner)) {
      run = 0;
      lastShooter = null;
      continue;
    }
    const same = lastShooter !== null && entry.shooter === lastShooter;
    run = same ? run + 1 : 1;
    if (!same) from = entry.shot;
    lastShooter = entry.shooter;
    if (run > best.len) best = { len: run, from, to: entry.shot };
  }
  return best;
}

/**
 * 挑「最大容错杆」：容错角最大的一杆，也就是这一局里最不该打丢的一杆。
 *
 * 数据来自求解结果的候选（src/solver.js 的 `{shot, targetNumber, pocketId,
 * toleranceDeg}`）。只认有限正数，没有就返回 null，不编一个 ±0.00°。
 */
function bestToleranceShot(input) {
  const lists = [input && input.shots, input && input.attempts];
  let best = null;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const deg = Number(c.toleranceDeg);
      if (!Number.isFinite(deg) || deg <= 0) continue;
      const shot = Number(c.shot);
      const target = Number(c.targetNumber);
      const item = {
        shot: Number.isFinite(shot) && shot > 0 ? Math.floor(shot) : null,
        targetNumber: Number.isFinite(target) && target > 0 ? target : null,
        pocketId: typeof c.pocketId === 'string' ? c.pocketId : '',
        toleranceDeg: deg,
      };
      if (!best || item.toleranceDeg > best.toleranceDeg) best = item;
    }
  }
  return best;
}

/** 犯规那句的括号：按代码计数，最多列两类，多了收成「等 N 类」。 */
function foulBreakdownText(entries, total) {
  const tally = new Map();
  for (const entry of entries) {
    if (!entry.foul) continue;
    const codes = entry.raw && Array.isArray(entry.raw.fouls) ? entry.raw.fouls : [];
    for (const code of codes) {
      if (typeof code !== 'string' || !code) continue;
      tally.set(code, (tally.get(code) || 0) + 1);
    }
  }
  const all = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  if (!all.length) return `${total} 次`;
  const parts = all
    .slice(0, 2)
    .map(([code, n]) => `${FOUL_CODE_TEXT[code] || code} ×${n}`);
  const more = all.length > 2 ? ` 等 ${all.length} 类` : '';
  return `${total} 次（${parts.join('、')}${more}）`;
}

/**
 * 关键杆：最多 3 条，顺序固定——最长连击 → 最大容错杆 → 犯规 → 收官一杆
 * （前三条占满就丢掉收官，宁可少说一句也不把图排成流水账）。
 */
function matchKeyLines({ entries, stats, winner, winnerName, shots }) {
  const lines = [];
  const run = longestRunRange(entries, winner);
  if (run.len >= 2) {
    const where = run.from === run.to ? `第 ${run.from} 杆` : `第 ${run.from}–${run.to} 杆`;
    lines.push(`最长连击 ${run.len} 杆（${where}）`);
  }
  const tol = bestToleranceShot(shots);
  if (tol) {
    const ball = tol.targetNumber ? shareBallText(tol.targetNumber) : '';
    const pocket = tol.pocketId ? pocketName(tol.pocketId) : '';
    const where = ball && pocket ? `${ball} → ${pocket}` : ball || pocket || `第 ${tol.shot} 杆`;
    lines.push(`最大容错杆 ${where} ±${tol.toleranceDeg.toFixed(2)}°`);
  }
  if (stats.fouls > 0) lines.push(`犯规 ${foulBreakdownText(entries, stats.fouls)}`);
  if (lines.length < MATCH_KEY_LIMIT) {
    const end = entries.filter((e) => e.end).pop();
    if (end) lines.push(`收官一杆 第 ${end.shot} 杆 · ${winnerName} 赢下这一局`);
  }
  if (!lines.length) lines.push('这一局没有可复盘的关键杆');
  return lines.slice(0, MATCH_KEY_LIMIT).map((value, i) => ({
    label: `关键杆 ${i + 1}`,
    value,
  }));
}

/**
 * 整局复盘要印在图上的文案 + 折线数据。
 *
 * 输入宽容：`game` 缺字段、`log` 不是数组、`stats` / `shots` 是半截对象都不抛。
 * 但**只要这局还没结束（或结束时连胜者都不知道），或者一条可用的流水都没有，
 * 就返回 null**——调用方据此把「复盘这一局」按钮禁掉。绝不退化成一份 0:0 的图。
 *
 * @param {{game?:object|null, log?:unknown[], stats?:object|null, table?:object,
 *   shots?:unknown[], attempts?:unknown[]}} [input]
 *   game    createGame() 出来的对局；phase 不是 ended 就直接 null
 *   log     对局流水，缺省取 game.log
 *   stats   computeMatchStats 的结果；只在字段缺失时兜底，数字仍以 log 为准
 *   table   球台，目前不参与文案（台面由 render.js 画）
 *   shots   本局每一杆的求解候选（`{shot, targetNumber, pocketId, toleranceDeg}`），
 *           用来挑「最大容错杆」；没有就不印这一条
 * @returns {{title:string, lines:Array<{label:string, value:string}>,
 *   chart:Array<{x:number, y1:number, y2:number}>}|null}
 *   chart 是纯数据：x = 杆号，y1 = 我的累计进球，y2 = 对手的累计进球。
 *   点最多 MATCH_CHART_LIMIT 个，超了等间距抽点并在 lines 里说明。
 */
export function buildMatchSummary(input = {}) {
  const opts = input && typeof input === 'object' ? input : {};
  const game = opts.game && typeof opts.game === 'object' ? opts.game : null;
  if (!game) return null;
  // 只认 phase === 'ended'：winner 有值但 phase 没跟上，说明这局正处在中间态
  // （或者存档写坏了），此时导出的「终局图」根本不对应任何终局。
  if (game.phase !== 'ended') return null;
  const winner = matchWinnerOf(game);
  if (winner === null) return null;

  const kind = typeof game.kind === 'string' ? game.kind : '';
  const log = Array.isArray(opts.log)
    ? opts.log
    : Array.isArray(game.log)
      ? game.log
      : [];
  const entries = readMatchLog(log, kind);
  if (!entries.length) return null;
  // 一条带杆号的记录都没有 = 这不是一份能复盘的流水（null / 数字 / 空对象混进来就是这样）。
  // 此时统计会全 0，照画就是那张「0:0 的复盘」——宁可给 null 让按钮灰着。
  if (!entries.some((e) => e.shot !== null)) return null;

  const derived = computeMatchStats({ log, kind, winner });
  const src = opts.stats && typeof opts.stats === 'object' ? opts.stats : {};
  const pick = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback);
  const stats = {
    shots: Math.floor(pick(src.shots, derived.shots)),
    // potRate 是 0..1 的比例，0 是合法值（打了但一杆没进），不能和「没有」混起来
    potRate:
      typeof src.potRate === 'number' && Number.isFinite(src.potRate)
        ? clamp(src.potRate, 0, 1)
        : derived.potRate,
    longestRun: Math.floor(pick(src.longestRun, derived.longestRun)),
    fouls: Math.floor(pick(src.fouls, derived.fouls)),
  };

  const { series, pots } = matchSeriesOf(entries, winner);
  const oppName = matchPlayerName(game, 1);
  const kindLabel = TABLE_KIND_LABEL[kind] || '对局';
  let mine = pots[0];
  let theirs = pots[1];
  if (kind === 'snooker') {
    const scores = game.snooker && Array.isArray(game.snooker.scores) ? game.snooker.scores : [];
    if (Number.isFinite(scores[0]) && Number.isFinite(scores[1])) {
      mine = scores[0];
      theirs = scores[1];
    }
  }

  const lines = matchKeyLines({
    entries,
    stats,
    winner,
    winnerName: matchPlayerName(game, winner),
    shots: opts,
  });

  let chart = series;
  if (series.length > MATCH_CHART_LIMIT) {
    chart = sampleMatchSeries(series, MATCH_CHART_LIMIT);
    lines.push({
      label: '走势',
      value: `共 ${series.length - 1} 杆，折线降采样到 ${chart.length} 点`,
    });
  }

  lines.push({ label: '杆数', value: `${stats.shots} 杆` });
  lines.push({ label: '命中率', value: stats.potRate === null ? '—' : `${Math.round(stats.potRate * 100)}%` });
  lines.push({ label: '最长连击', value: `${stats.longestRun} 杆` });
  lines.push({ label: '犯规', value: `${stats.fouls} 次` });

  return {
    title: `${kindLabel} · 我 ${mine} : ${theirs} ${oppName}`,
    lines,
    chart,
  };
}

// ---------------------------------------------------------------- 一杆播报（#report）
//
// 一杆结算完，界面要把 rules.js 的 report 拼成一条给玩家看的话：摘要 + 犯规红行 +
// 一行补充（分组 / 重摆 / 持球 / 待决事项）。这段拼装原来在 app.js 里**逐字抄了三份**
// （玩家求解打、玩家手打、对手自动出杆），改一个字段漏一处，就会出现「有些流程显示、
// 有些流程不显示」——最难发现的那种错。
//
// 三个调用点确实有三处**真实的**差异，所以不强行合并成一句话，全部做成参数：
//   1. 对手那一杆前面多一段 `<b>对手</b> · `（prefix）；
//   2. 重摆提示的措辞不同：玩家这杆写「8 号球已重摆回 8 号点」（只在 8 号球时写），
//      收尾那杆按实际号码写「N 号球已重摆回底点」（spotted）；
//   3. 对手那一杆只在轮到玩家时才写持球提示（球权刚交给玩家），玩家自己那一杆
//      和收尾那一杆无条件写（ballInHandForPlayerOnly）；
// 另外收尾那杆多一句待决事项（pendingChoiceHint），对手那一杆末尾多一段选杆说明（tail）。
//
// **拼出来的字符串与改动前逐字节相同**（test/demo-state.test.js 里有钉死的期望值，
// 12 份 report × 三个调用点都在 test/ 里对过）。这里只负责去重，不改任何一句文案。

/**
 * 一杆播报的 HTML。
 *
 * @param {object} report resolveShot 返回的报告
 * @param {object} [options]
 * @param {object|null} [options.next] 结算后的局面，用来读 ballInHand / turn
 * @param {string} [options.prefix] 播报前缀，对手那一杆是 `<b>对手</b> · `
 * @param {'only8'|'any'} [options.spotted] 重摆提示口径，见上
 * @param {boolean} [options.pendingChoiceHint] 是否写「开球不达标…」那句待决提示
 * @param {boolean} [options.ballInHandForPlayerOnly] 只在轮到玩家时才写持球提示
 * @param {string[]} [options.tail] 追加在最后的行（对手的选杆说明）
 * @returns {string}
 */
export function reportHtml(report, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const next = opts.next && typeof opts.next === 'object' ? opts.next : null;
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : '';
  const spottedMode = opts.spotted === 'any' ? 'any' : 'only8';
  const tail = Array.isArray(opts.tail) ? opts.tail : [];

  const fouls = Array.isArray(report.fouls) ? report.fouls : [];
  const foulHtml = fouls.length
    ? `<div class="foul">犯规：${fouls.map((f) => f.text).join('；')}</div>`
    : '';

  const extra = [];
  if (report.groupAssigned) {
    const who = report.groupAssigned.player === 0 ? '你' : '对手';
    extra.push(`分组：${who}拿到${TABLE_GROUP_NAME[report.groupAssigned.group]}`);
  }
  if (spottedMode === 'only8') {
    if (report.spotted === 8) extra.push('8 号球已重摆回 8 号点');
  } else if (report.spotted) {
    extra.push(`${report.spotted} 号球已重摆回底点`);
  }
  if (report.requiresRerack) extra.push('开球不合法，需要重摆');
  if (opts.pendingChoiceHint && report.pendingChoice) {
    extra.push('开球不达标，你可以在下面选照打还是交回去');
  }
  const ballInHand = next && next.ballInHand;
  if (ballInHand && (!opts.ballInHandForPlayerOnly || next.turn === 0)) {
    const where = ballInHand.zone === 'kitchen' ? '在开球线后点一下放母球' : '在台面上点一下放母球';
    extra.push(`持球：${where}`);
  }
  for (const line of tail) extra.push(line);

  const details = extra.length ? '<div>' + extra.join(' · ') + '</div>' : '';
  // summary 一定是字符串（rules.js 每一份 report 都带）；真缺了也别在面板上印一个
  // 「undefined」——那是把内部状态漏给用户看。
  const summary = typeof report.summary === 'string' ? report.summary : String(report.summary ?? '');
  return `${prefix}${summary}${foulHtml}${details}`;
}
