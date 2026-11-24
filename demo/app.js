// 浏览器演示：把 src/ 里的物理核、求解器与规则引擎直接跑在页面上。
//
// 这里没有任何构建步骤——浏览器原生 ES modules 直接 import ../src/*.js。
// 这也是选择"零依赖纯 JS"的直接收益：物理核既是 Node 测试的对象，
// 也是页面上跑的同一份代码，不存在"测试用的实现"和"演示用的实现"两份。
//
// 两个模式共用同一套绘制与物理，区别只在"谁来管局面"：
//   练习：随便摆球，求解一杆，看完就复位。
//   球局：由 rules.js 管回合、分组、犯规、胜负，打进就继续，没进就换人。

import { createTable } from '../src/table.js';
import { TABLE_PRESETS, SEARCH_DT } from '../src/constants.js';
import { createBall, createWorld } from '../src/physics.js';
import {
  solveShot,
  coach,
  describeCandidate,
  cueRestText,
  toleranceText,
  difficultyLabel,
  difficultyCaveat,
  LABEL_SIGMA_DEG,
  pocketName,
  planShot,
} from '../src/solver.js';
import { createRenderer, createShareScene, interpolateBallStates, sampleDampedCamera } from './render.js';
import { ballStyle, groupOf, RACK_NUMBERS, createStandardRack, createRack, GAME_KINDS } from '../src/rack.js';
import {
  createGame,
  legalTargetNumbers,
  numbersOnTable,
  remainingOfGroup,
  simulateShot,
  resolveShot,
  rerack,
  placementAllowed,
  placeCueBall,
  acceptTable,
  handBackBreak,
} from '../src/rules.js';
import { takeTurn } from '../src/opponent.js';
import { ballName as snookerBallName } from '../src/snooker.js';
import {
  appendMatch,
  loadSave,
  readMatches,
  writeSave,
  clearSave,
  describeSave,
  readSaveMeta,
  readSaveStamp,
  saveFailureKind,
  serialize,
  sanitize,
  SAVE_KEY,
} from './save.js';
// 不碰 DOM 的那部分状态逻辑住在 ./state.js：它是能在 Node 单测里跑的那一层。
// 这里只留「读什么状态、画什么、什么时候拦下来」。
import {
  autoPauseHint,
  buildMatchSummary,
  buildShareSummary,
  buildTableSummary,
  clamp,
  computeMatchStats,
  currentAim,
  describeManualShot,
  describeNextShot,
  esc,
  findSpot,
  gameKindOrThrow,
  getAimHUDInfo,
  getPowerTier,
  practiceHint,
  practiceReady,
  pushHistoryEntry,
  reduceAutoPause,
  reduceSaveWrite,
  reportHtml,
  restoreGameState,
  restorePositions,
  shouldAutoShoot,
  simulateFrames,
  snapshotPositions,
  summarizeHistory,
  tableForKind,
  undoLabel,
  unpackHistory,
} from './state.js';
import {
  appendPracticeResult,
  clearPracticeLog,
  DEFAULT_PRACTICE_GOAL,
  DRILL_SET_SIZE,
  DRILL_SET_TARGET,
  exportPracticeBackup,
  exportPracticeCsv,
  MAX_BACKUP_BYTES,
  MIN_CALIBRATION_SAMPLES,
  popLastPracticeResult,
  PRACTICE_DRILLS,
  PRACTICE_DRILL_VARIATIONS,
  PRACTICE_GOALS,
  PRACTICE_MISS_REASONS,
  PRACTICE_FOCUS_MIN_LABELS,
  practiceDrillLayout,
  readPracticeLog,
  readPracticeGoal,
  parsePracticeBackup,
  replacePracticeLog,
  summarizeDrills,
  summarizeMissReasons,
  summarizePracticeFocus,
  summarizePracticeDays,
  summarizeTodayPractice,
  summarizePractice,
  writePracticeGoal,
} from './practice.js';

const $ = (id) => document.getElementById(id);

const canvas = $('table');
// 球台可换。不用 const 是因为 render.js 的 toPx/toWorld/fit 全都依赖台面尺寸，
// 换台之后必须把新台交给渲染器（view.setTable）并重新 fit。
let table = createTable('pool9');
let R = table.ballRadius;
const view = createRenderer({ canvas, table });

/**
 * 本标签页的一次性会话串，写进存档，用来分辨「这份档是我自己写的」还是
 * 「另一个标签页写的」。
 *
 * 为什么不用时间戳就够了：新开的标签页还没见过任何存档，它记的 time 是 null，
 * 而旧代码把 null 当放行——于是第二个标签页第一次点存档就静默盖掉别人的档。
 *
 * sessionStorage 按标签页隔离（刷新还在、新开一个是新的），正好是这个语义；
 * 隐私模式下连 sessionStorage 都碰不得，退回内存里的随机串：本标签页内仍然
 * 自洽，只是刷新之后会换一个（那时也确实该重新认一次存档）。
 */
function readTabSession() {
  const made = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const kept = sessionStorage.getItem(SESSION_KEY);
    if (kept) return kept;
    sessionStorage.setItem(SESSION_KEY, made);
    return made;
  } catch {
    return made;
  }
}
const SESSION_KEY = 'pool-ai-coach/tab/v1';
const TAB_SESSION = readTabSession();

const state = {
  mode: 'practice',
  // 练习模式
  balls: [],
  solution: null,
  practiceRecorded: false,
  // 上一次记录成功的时间，用来挡双击（「进了」和「没进」挨着，手抖会记成两杆）
  lastRecordAt: 0,
  activeDrillId: null,
  drillVariation: 0,
  activeDrillVariation: 0,
  // 球局模式
  game: null,
  gSolution: null,
  autoOpponent: true,
  opponentThinking: false,
  // 玩法：'eightball' | 'nineball' | 'snooker'。摆球形状、规则判定、可否分组都由它决定。
  gameKind: 'eightball',
  // 玩家用球台下拉**自己选过**的台，按玩法分开记：{ gameKind: presetId }。
  // 切玩法会按该玩法的默认台换台（八球 pool8 / 九球 pool9 / 斯诺克 snooker），
  // 但玩家显式选过的台不能被冲掉——切走再切回来还得是他选的那张。
  tableManual: {},
  // 没有进攻机会时要不要找防守。默认开——关掉就退回「兜底直撞」，
  // 那个开关存在的理由和 autoOpponent 一样：想让用户能对比两种口径。
  allowSafety: true,
  // 每开一局 +1。回放是异步的，旧局的回调醒来时局面可能已经被换掉了，
  // 靠这个号让它们自己认出来"我算的是上一局"，别再往新局上写。
  generation: 0,
  // 共用
  animating: false,
  placing: false,
  // 存档的写入时间戳。null = 这个页面还没读过也没存过，说什么都算新鲜。
  // 用来分辨「存档还是我见过的那份」和「另一个标签页已经改过了」。
  saveStamp: null,
  // 本页认下的「这档是谁写的」。平时就是本标签页的会话串；读档之后改成存档里
  // 那一个——用户是主动把别人的局面接过来接着打的，之后他再存不算覆盖别人的档。
  saveSession: TAB_SESSION,
  // 已经被提示过一次「存档被别人改过」，再点一次存档就是真要覆盖。
  saveOverwrite: false,
  // 另一个标签页存的那份存档是第几杆；null = 没有待处理的对方存档。
  // 只用来点亮「读入另一个标签页存的」那个按钮，不自动换桌。
  otherSaveShots: null,
  // 撤销用：每一杆结算前的局面快照。只存球局，练习模式的「重置」已经是退路。
  history: [],
  // 每一杆求解时算出来的容错角度：`{shot, targetNumber, pocketId, toleranceDeg}`。
  // 「复盘这一局」的「最大容错杆」只能从这里来——g.log 里只有文字摘要，
  // 角度是求解器的产物，事后解析 summary 是解析不出来的。
  // 只活在内存里：它不影响规则也不影响胜负，没必要塞进存档（读档后这条会缺，图上就不印）。
  shotLog: [],
  // 撤销 / 读档之后先停住自动出杆。真机实测：默认开着「对手自动出杆」时，
  // 撤销或读档后 1–2 秒对手自己又打了一杆，球位立刻变掉，看着像读档失败。
  // 转移规则在 state.js 的 reduceAutoPause 里（纯函数，能单测）。
  autoPaused: false,
  autoPauseReason: null,
  // 读档时杆史没跟着存下来时的一句话说明（球桌上方与「对局记录」共用）。
  historyNote: null,
  // 手动出杆参数。求解会给"建议参数"，但滑块一旦被用户动过就不再被覆盖——
  // 否则每点一次「求解」就把人刚调好的力度冲掉，那是很恼人的。
  manual: { speed: 2.2, aimOffsetDeg: 0, tipB: 0, tipA: 0, touched: false },
};

const GROUP_LABEL = { solid: '全色', stripe: '花色', eight: '8 号', cue: '母球' };

// ---------------------------------------------------------------- 尺寸

function resize() {
  // 可用空间按**内容盒**算。#stage 有 padding（桌面 24、手机 16），
  // getBoundingClientRect() 的 width/height 把 padding 也算进去了；拿它当可用宽，
  // 算出来的画布比内容盒还宽，最后被 canvas{max-width:100%} 按 CSS 挤回去——
  // 画布内部坐标系没跟着缩，整张台子横向压扁（桌面实测 4.0%、手机 5.8%），
  // 点选反算用同一套 scale，于是触摸/拖动也跟着同比例偏。
  // clientWidth/clientHeight 同样含 padding，所以显式减掉两边的 padding。
  // 那 10px 是留给边框和内边距呼吸的余量，和手机端 #stage 高度公式里的 -10px 对应。
  const stage = $('stage');
  const cs = getComputedStyle(stage);
  const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const availW = Math.max(1, stage.clientWidth - padX - 10);
  const availH = Math.max(1, stage.clientHeight - padY - 10);
  view.fit(availW, availH);
  render();
}

// ---------------------------------------------------------------- 练习模式

function resetLayout() {
  // 重摆等于换掉整个练习局面：在途的回放必须作废，否则它会继续往新数组里写帧数据。
  state.generation += 1;
  state.solution = null;
  state.practiceRecorded = false;
  state.activeDrillId = null;
  state.animating = false;
  invalidateShare();
  updateDrillStatus();
  updatePracticeFeedback();
  state.balls = [];

  state.balls.push(
    createBall('cue', table.length * 0.24, table.width * 0.5, { number: 0, ...ballStyle(0) })
  );
  for (const s of [
    { x: 0.62, y: 0.78, n: 1 },
    { x: 0.82, y: 0.34, n: 2 },
    { x: 0.46, y: 0.24, n: 3 },
  ]) {
    state.balls.push(
      createBall('b' + s.n, s.x * table.length, s.y * table.width, {
        number: s.n,
        ...ballStyle(s.n),
      })
    );
  }
  createWorld(table, state.balls);
  refreshBallPicker();
  setAdvice('点「求解最佳方案」开始。', '');
  setAltsEmpty();
  render();
}

function refreshBallPicker() {
  const used = new Set(state.balls.filter((b) => !b.pocketed).map((b) => b.number));
  const sel = $('ballPick');
  const prev = Number(sel.value);
  sel.innerHTML = '';
  const free = RACK_NUMBERS.filter((n) => !used.has(n));
  if (!free.length) {
    const opt = document.createElement('option');
    opt.textContent = '15 颗都在台上了';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    $('addBall').disabled = true;
  } else {
    for (const n of free) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = `${n} 号（${GROUP_LABEL[groupOf(n)]}）`;
      sel.appendChild(opt);
    }
    sel.disabled = false;
    $('addBall').disabled = false;
    if (free.includes(prev)) sel.value = String(prev);
  }
  refreshRemovePicker();
}

/**
 * 「拿掉」的下拉：只列母球和台上现有的目标球。
 * 单独一个选择器而不是复用「加一颗」的那个，是因为两者的候选集正好互补——
 * 加过的号才在台上，而「加一颗」只列还不在台上的号。
 */
function refreshRemovePicker() {
  const sel = $('ballRemove');
  if (!sel) return;
  const prev = sel.value;
  const onTable = state.balls.filter((b) => !b.pocketed);
  sel.innerHTML = '';
  // 母球不给删：求解、演示、规则全都要求场上有一颗母球，删掉之后整页会哑掉。
  const removable = onTable.filter((b) => b.number !== 0);
  if (!removable.length) {
    const opt = document.createElement('option');
    opt.textContent = '台上没有可拿掉的目标球';
    opt.value = '';
    sel.appendChild(opt);
    sel.disabled = true;
    $('removeBall').disabled = true;
    return;
  }
  for (const b of removable.sort((a, c) => a.number - c.number)) {
    const opt = document.createElement('option');
    opt.value = String(b.number);
    opt.textContent = `${b.number} 号（${GROUP_LABEL[groupOf(b.number)]}）`;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  $('removeBall').disabled = false;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

function removeBall() {
  if (state.animating) return;
  const n = Number($('ballRemove').value);
  if (!n) return;
  const before = state.balls.length;
  state.balls = state.balls.filter((b) => b.number !== n);
  if (state.balls.length === before) return;
  createWorld(table, state.balls);
  clearSolution(`已拿掉 ${n} 号球，重新求解。`);
  refreshBallPicker();
  render();
}

function addBall() {
  if (state.animating) return;
  const n = Number($('ballPick').value);
  if (!n) return;
  if (state.balls.some((b) => b.number === n && !b.pocketed)) return;

  // 找一个空位：从台面中心向外螺旋找，不压到已有的球
  const spot = findSpot(state.balls, table);
  if (!spot) {
    setAdvice('台面上已经放不下更多球了。', '');
    return;
  }
  const ball = createBall('b' + n, spot.x, spot.y, { number: n, ...ballStyle(n) });
  state.balls.push(ball);
  createWorld(table, state.balls);
  clearSolution('已加球，重新求解。');
  refreshBallPicker();
  render();
}

function rackUp() {
  if (state.animating) return;
  state.balls = createStandardRack(table, { seed: Math.floor(Math.random() * 1e6) }).map((b) =>
    createBall(b.id, b.x, b.y, b)
  );
  createWorld(table, state.balls);
  clearSolution('已摆满 15 颗，可以开球了。');
  refreshBallPicker();
  render();
}

function clearSolution(text) {
  state.solution = null;
  state.practiceRecorded = false;
  updatePracticeFeedback();
  if (text) setAdvice(text, '');
  setAltsEmpty();
}

/**
 * 备选卡的空状态。
 *
 * 没有备选时整张卡藏起来，不留一张写着「—」的空卡：手机窄屏下这张卡排在
 * 「AI 击球战术」上面（@media 里 order:-1），首屏第一眼就是一块只有标题和
 * 一个破折号的空白（真机走查报的那条）。有方案时 renderAlts 再把它放回来。
 */
function setAltsEmpty() {
  $('alts').innerHTML = '—';
  $('alts').className = 'empty';
  $('altsCard').classList.add('hidden');
  // 方案没了，「演示按建议力度 X m/s」这句话也就过期了，一起收起来。
  $('shootNote').textContent = '';
  $('shootNote').classList.add('hidden');
}

/** 换球台。换完必须重摆，因为旧台的球坐标对新台尺寸没有意义。 */
function setTablePreset(presetId) {
  const next = createTable(presetId);
  table = next;
  R = next.ballRadius;
  view.setTable(next);
  // 换台等于换掉整个局面：在途的回放与续杆定时器都要作废。
  state.generation += 1;
  state.game = null;
  state.history = [];
  resetLayout();
  resize();
  if (state.mode === 'game') newGame();
  // 下拉要跟着走：读档换台、以及「切玩法顺带换台」都会走到这里，
  // 不回调下拉的话界面上显示的台和实际在用的台就不是同一张了。
  $('tablePreset').value = next.preset;
  $('subtitle').textContent =
    `${next.label}（${next.length} × ${next.width} 米）· 换台后已重摆`;
}

function setAdvice(text, verdict, cls = '') {
  $('advice').textContent = text;
  $('advice').className = /^(点|没有|已|台面)/.test(text) ? 'empty' : '';
  $('verdict').textContent = verdict;
  $('verdict').className = cls;
}

// ---------------------------------------------------------------- 视角与相机

const cameraAnim = {
  active: false,
  startTime: 0,
  fromT: 0,
  fromVelocity: 0,
  toT: 0,
  velocity: 0,
};

function toggleView() {
  const currentT = view.getCamera().t;
  const targetT = cameraAnim.active ? (cameraAnim.toT < 0.5 ? 1 : 0) : (currentT < 0.5 ? 1 : 0);
  startCameraTransition(targetT);
}

function startCameraTransition(targetT) {
  const now = performance.now();
  const wasActive = cameraAnim.active;
  const current = wasActive
    ? sampleDampedCamera(
      cameraAnim.fromT,
      cameraAnim.toT,
      cameraAnim.fromVelocity,
      (now - cameraAnim.startTime) / 1000
    )
    : { value: view.getCamera().t, velocity: 0 };
  const boundedT = Math.max(0, Math.min(1, current.value));

  cameraAnim.active = true;
  cameraAnim.startTime = now;
  cameraAnim.fromT = boundedT;
  cameraAnim.fromVelocity = boundedT === current.value ? current.velocity : 0;
  cameraAnim.velocity = cameraAnim.fromVelocity;
  cameraAnim.toT = targetT;
  updateViewToggleButton(targetT);
  if (!wasActive) requestAnimationFrame(animateCamera);
}

function animateCamera() {
  if (!cameraAnim.active) return;
  const now = performance.now();
  const sample = sampleDampedCamera(
    cameraAnim.fromT,
    cameraAnim.toT,
    cameraAnim.fromVelocity,
    (now - cameraAnim.startTime) / 1000
  );
  const currentT = Math.max(0, Math.min(1, sample.value));
  cameraAnim.velocity = currentT === sample.value ? sample.velocity : 0;

  syncCamera(currentT);
  render();

  if (Math.abs(cameraAnim.toT - currentT) > 0.001 || Math.abs(cameraAnim.velocity) > 0.008) {
    requestAnimationFrame(animateCamera);
  } else {
    cameraAnim.active = false;
    syncCamera(cameraAnim.toT);
    render();
  }
}

function updateViewToggleButton(targetT) {
  const btn = $('viewToggle');
  const txt = $('viewToggleText');
  if (!btn) return;
  const isFPV = targetT > 0.5;
  btn.classList.toggle('fpv', isFPV);
  if (txt) {
    txt.textContent = isFPV ? '视角: 第一人称趴杆' : '视角: 俯视';
  }
  const icon = btn.querySelector('.vt-icon');
  if (icon) icon.textContent = isFPV ? '🎯' : '🎥';
}

function syncCamera(t) {
  const inGame = state.mode === 'game';
  const balls = inGame ? (state.game?.balls ?? []) : state.balls;
  const cue = balls.find((b) => b.number === 0 && !b.pocketed);
  const aim = currentAim(state);
  const aimAngle = aim ? (aim.angle + (state.manual.aimOffsetDeg * Math.PI) / 180) : 0;

  view.setCamera({
    t,
    aimAngle,
    cueBall: cue ? { x: cue.x, y: cue.y } : { x: table.length * 0.25, y: table.width * 0.5 },
  });
}

// 第一人称 HUD 的两行字与鬼球坐标在 state.js 的 getAimHUDInfo（纯计算，能单测）。

// getAimHUDInfo 是纯函数，但它每帧都要重算的话：getPowerTier 造一个七字段对象、
// 两次 toFixed、两段模板串，无解那条路还要 balls.find + 一个 Set。它的输入只有
// 「模式 / 解 / 力度 / 球位」——这些都没变，结果必然一个字节都不差，所以按输入
// 签名缓存。签名用定长 Float64Array 逐项严格比较，不做哈希：浮点哈希会碰撞，
// 而碰撞的代价是 HUD 上留着一句过期的文案。解 / best / 袋口这些对象每次求解都是新的，
// 摊成字段没意义，所以另存一份引用数组，按身份比较。
const HUD_SIG_CAP = 512;
const hudSigCur = new Float64Array(HUD_SIG_CAP);
const hudSigPrev = new Float64Array(HUD_SIG_CAP);
const hudRefsCur = new Array(8);
const hudRefsPrev = new Array(8);
let hudSigLen = -1;
let hudRefsLen = -1;
let hudCache = null;

/**
 * 这一帧 HUD 的输入变了吗？变了就把本次签名记为「上一份」。
 * 球局里没有解时不缓存：这时目标球由分组 / 轮次 / 斯诺克阶段一起决定，
 * 字段太多、又都是手打瞄准的冷路径，每帧重算也不心疼。
 */
function hudInputsChanged() {
  const nums = hudSigCur;
  const refs = hudRefsCur;
  let n = 0;
  let r = 0;
  const inGame = state.mode === 'game';
  const sol = inGame ? state.gSolution : state.solution;
  const best = sol && sol.found ? sol.best : null;

  nums[n++] = inGame ? 1 : 0;
  nums[n++] = state.manual.speed;
  refs[r++] = sol || null;
  refs[r++] = best || null;

  if (best) {
    nums[n++] = best.targetNumber;
    nums[n++] = best.toleranceDeg;
    nums[n++] = best.ghost ? best.ghost.x : 0;
    nums[n++] = best.ghost ? best.ghost.y : 0;
    refs[r++] = best.pocketId ?? null;
  } else if (inGame) {
    return true;
  } else {
    // 无解：HUD 报的是「离母球最近的那颗」，任何一颗球挪动都可能换目标，
    // 所以整张台面的号码 / 坐标 / 是否落袋都要进签名。
    const balls = state.balls;
    if (balls.length * 4 + 2 > HUD_SIG_CAP) return true;
    nums[n++] = balls.length;
    for (const b of balls) {
      nums[n++] = b.number;
      nums[n++] = b.x;
      nums[n++] = b.y;
      nums[n++] = b.pocketed ? 1 : 0;
    }
  }

  let changed = n !== hudSigLen || r !== hudRefsLen;
  if (!changed) {
    for (let i = 0; i < n; i += 1) {
      if (nums[i] !== hudSigPrev[i]) {
        changed = true;
        break;
      }
    }
  }
  if (!changed) {
    for (let i = 0; i < r; i += 1) {
      if (refs[i] !== hudRefsPrev[i]) {
        changed = true;
        break;
      }
    }
  }
  if (changed) {
    hudSigPrev.set(nums.subarray(0, n));
    for (let i = 0; i < r; i += 1) hudRefsPrev[i] = refs[i];
    hudSigLen = n;
    hudRefsLen = r;
  }
  return changed;
}

function aimHUDInfo() {
  if (hudInputsChanged() || !hudCache) hudCache = getAimHUDInfo(state);
  return hudCache;
}

// ---------------------------------------------------------------- 绘制

function render() {
  // getCamera() 每次返回的都是 {...camera} 克隆，一帧取三次等于白拷两次。
  // 取一次往下传就行：syncCamera 只改 t/aimAngle/cueBall，t 传进去还是同一个值。
  const camT = view.getCamera().t;
  view.clear();
  syncCamera(camT);
  view.drawTable();

  if (state.mode === 'practice') {
    drawSolution(camT);
    drawBalls(state.balls, camT);
  } else {
    drawGameOverlay(camT);
    drawBalls(state.game?.balls ?? [], camT);
  }

  // 渲染第一人称球杆与战术瞄准准星 HUD
  if (camT > 0.01) {
    view.drawCueStick(state.manual.strokeOffset || 0);
    view.draw1stPersonHUD(aimHUDInfo());
  }
}

// 每帧复用的可见球缓冲：原先每帧 filter 都要新建一个数组、丢掉上一个。
const visibleBalls = [];
// 深度槽位。用 Symbol 当键：JSON.stringify / Object.keys / {...ball} 都看不见它，
// 球对象照旧能被存档和比对，只是多了一个每帧会被覆盖的临时值。
const BALL_DEPTH = Symbol('ballDepth');

function drawBalls(balls, camT) {
  const visible = visibleBalls;
  visible.length = 0;
  for (const b of balls) {
    if (!b.pocketed) visible.push(b);
  }
  if (camT > 0.01) {
    // 3D 深度排序：远处的球先画，近处的球后画（遮挡在前面）。
    // 排序前先把 depth 算一遍：比较器里再 project 的话，16 颗球要投约 128 次，
    // 实际只需要 16 次。sort 是稳定排序，depth 相同仍按原顺序，绘制顺序不变。
    for (const b of visible) {
      b[BALL_DEPTH] = view.project(b.x, b.y, table.ballRadius).depth;
    }
    visible.sort((a, b) => b[BALL_DEPTH] - a[BALL_DEPTH]);
  }
  for (const b of visible) {
    view.drawBall(b);
  }
}

function drawPositionGuide(candidate) {
  if (!candidate.positioningRequired || !candidate.cueRest || !candidate.cueRoute?.length) return;
  const ctx = view.ctx;
  const path = candidate.cueRoute.map((point) => view.project(point.x, point.y, table.ballRadius));
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.95)';
  ctx.lineWidth = Math.max(2, 2.4 * (path[path.length - 1].scale / view.scale));
  ctx.stroke();
  ctx.setLineDash([]);

  const rest = view.project(candidate.cueRest.x, candidate.cueRest.y, table.ballRadius);
  const radius = Math.max(8, table.ballRadius * rest.scale);
  ctx.beginPath();
  ctx.arc(rest.x, rest.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
  ctx.fill();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  if (candidate.nextShot) {
    const ghost = view.project(candidate.nextShot.ghost.x, candidate.nextShot.ghost.y, table.ballRadius);
    const target = view.project(candidate.nextShot.target.x, candidate.nextShot.target.y, table.ballRadius);
    const pocket = view.project(candidate.nextShot.pocket.x, candidate.nextShot.pocket.y, 0);
    ctx.beginPath();
    ctx.moveTo(rest.x, rest.y);
    ctx.lineTo(ghost.x, ghost.y);
    ctx.lineTo(target.x, target.y);
    ctx.lineTo(pocket.x, pocket.y);
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = 'rgba(192, 132, 252, 0.8)';
    ctx.lineWidth = Math.max(1.5, 1.8 * (rest.scale / view.scale));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.restore();
}

/**
 * 绘制瞄准辅助线（进袋轨迹、假想球、母球轨迹、分离线）。
 * drawSolution 和 drawGameOverlay 共用，避免约 60 行重复代码。
 */
function drawAimGuides(best, cue, target, pocket, camT) {
  const ctx = view.ctx;
  const cuePx = view.project(cue.x, cue.y, table.ballRadius);
  const tgtPx = view.project(target.x, target.y, table.ballRadius);
  const ghostPx = view.project(best.ghost.x, best.ghost.y, table.ballRadius);

  if (pocket) {
    const pocketPx = view.project(pocket.x, pocket.y, 0);

    // 1. 被击球进袋轨迹线（目标球 -> 目标袋口）
    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.90)';
    ctx.lineWidth = Math.max(1.8, 2.4 * (tgtPx.scale / view.scale));
    ctx.beginPath();
    ctx.moveTo(tgtPx.x, tgtPx.y);
    ctx.lineTo(pocketPx.x, pocketPx.y);
    ctx.stroke();

    // 目标袋口高亮光圈
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pocketPx.x, pocketPx.y, Math.max(8, pocket.captureR * pocketPx.scale * 1.15), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.65)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 2. 假想球 (Ghost Ball)
    const gr = Math.max(4, R * ghostPx.scale);
    ctx.beginPath();
    ctx.arc(ghostPx.x, ghostPx.y, gr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
    ctx.fill();

    // 3. 母球碰撞后 90° 切线分离轨迹线
    const dtx = pocket.x - best.ghost.x;
    const dty = pocket.y - best.ghost.y;
    const dtLen = Math.hypot(dtx, dty) || 1;
    const utx = dtx / dtLen;
    const uty = dty / dtLen;
    const dcx = best.ghost.x - cue.x;
    const dcy = best.ghost.y - cue.y;
    const dcLen = Math.hypot(dcx, dcy) || 1;
    const ucx = dcx / dcLen;
    const ucy = dcy / dcLen;
    let sepX = -uty;
    let sepY = utx;
    if (sepX * ucx + sepY * ucy < 0) {
      sepX = uty;
      sepY = -utx;
    }
    const sepDist = 0.38;
    const sepPt = view.project(best.ghost.x + sepX * sepDist, best.ghost.y + sepY * sepDist, table.ballRadius);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.70)';
    ctx.lineWidth = Math.max(1.5, 1.8 * (ghostPx.scale / view.scale));
    ctx.beginPath();
    ctx.moveTo(ghostPx.x, ghostPx.y);
    ctx.lineTo(sepPt.x, sepPt.y);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // 开球/兜底：没有目标袋，只画假想球位置标记
    const gr = Math.max(4, R * ghostPx.scale);
    ctx.beginPath();
    ctx.arc(ghostPx.x, ghostPx.y, gr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.95)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.16)';
    ctx.fill();
  }

  // 4. 母球击球行进轨迹线（母球 -> 假想球）
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(cuePx.x, cuePx.y);
  ctx.lineTo(ghostPx.x, ghostPx.y);
  ctx.strokeStyle = camT > 0.5 ? 'rgba(52, 211, 153, 0.95)' : 'rgba(16, 185, 129, 0.92)';
  ctx.lineWidth = Math.max(2, 2.6 * (cuePx.scale / view.scale));
  ctx.stroke();
}

function drawSolution(camT) {
  const sol = state.solution;
  if (!sol || !sol.found || state.animating) return;
  const best = sol.best;

  const cue = state.balls.find((b) => b.id === 'cue');
  const target = state.balls.find((b) => b.id === best.targetId);
  const pocket = table.pockets.find((p) => p.id === best.pocketId);
  if (!cue || !target || !pocket) return;

  const ctx = view.ctx;
  const cuePx = view.project(cue.x, cue.y, table.ballRadius);
  const ghostPx = view.project(best.ghost.x, best.ghost.y, table.ballRadius);

  if ($('showGhost').checked) {
    drawAimGuides(best, cue, target, pocket, camT);
  }

  // 容错锥（主要在第三人称展示）
  if ($('showCone').checked && camT < 0.6) {
    const dist = Math.hypot(cue.x - best.ghost.x, cue.y - best.ghost.y);
    const VISUAL_GAIN = 20;
    const halfRad = ((best.toleranceDeg * Math.PI) / 180) * VISUAL_GAIN;
    const dirAngle = Math.atan2(ghostPx.y - cuePx.y, ghostPx.x - cuePx.x);
    const reach = dist * cuePx.scale * 1.02;

    ctx.save();
    ctx.globalAlpha = 1 - camT;
    ctx.beginPath();
    ctx.moveTo(cuePx.x, cuePx.y);
    ctx.arc(cuePx.x, cuePx.y, reach, dirAngle - halfRad, dirAngle + halfRad);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74, 222, 128, 0.16)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cuePx.x, cuePx.y);
    ctx.lineTo(cuePx.x + Math.cos(dirAngle) * reach, cuePx.y + Math.sin(dirAngle) * reach);
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.95)';
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  if (best.cuePath && best.cuePath.kind === 'pocket') {
    const p = view.project(best.cuePath.point.x, best.cuePath.point.y, 0);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  drawPositionGuide(best);
}

function drawGameOverlay(camT) {
  const g = state.game;
  if (!g) return;
  const ctx = view.ctx;

  // 持球：高亮可摆放区域
  if (g.ballInHand && !state.animating) {
    const zone = g.ballInHand.zone;
    const x0 = 0;
    const x1 = zone === 'kitchen' ? table.length / 4 : table.length;
    const p0 = view.project(x0, 0, 0);
    const p1 = view.project(x1, 0, 0);
    const p2 = view.project(x1, table.width, 0);
    const p3 = view.project(x0, table.width, 0);
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.lineTo(p3.x, p3.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(74, 222, 128, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(74, 222, 128, 0.45)';
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const sol = state.gSolution;
  if (!sol || !sol.found || state.animating) return;
  const best = sol.best;
  const cue = g.balls.find((b) => b.number === 0);
  const target = g.balls.find((b) => b.id === best.targetId);
  if (!cue || !target) return;

  // 开球和兜底直撞没有目标袋，drawAimGuides 内部会处理
  const pocket = best.pocketId ? table.pockets.find((p) => p.id === best.pocketId) : null;
  drawAimGuides(best, cue, target, pocket, camT);
  drawPositionGuide(best);
}

// ---------------------------------------------------------------- 交互：拖球 / 摆母球

let drag = null;

// 画布矩形缓存。getBoundingClientRect() 会强制一次布局同步，而 pointermove 在高刷屏
// 上每秒能来一两百次，量到的永远是同一个盒子。矩形只在「布局 / 滚动 / 缩放」变化时
// 才会变，所以用事件失效、按需重量，而不是每次重新量：
//   - 窗口 resize / 屏幕旋转 / visualViewport 的 resize+scroll（页面缩放、手机地址栏收起）
//   - 任意滚动容器的滚动（scroll 不冒泡，用捕获阶段收；rect 是视口坐标，页一滚就变）
//   - canvas 与根元素的尺寸变化（ResizeObserver：侧栏折展、字体回流等非 resize 的布局变化）
// 另外每次 pointerdown 强制重量一次：一次手势只量一次，拖拽起点用的仍是真坐标。
let canvasRectCache = null;
let canvasRectWatched = false;

function invalidateCanvasRect() {
  canvasRectCache = null;
}

function canvasRect() {
  if (!canvasRectCache) canvasRectCache = canvas.getBoundingClientRect();
  return canvasRectCache;
}

function watchCanvasRect() {
  if (canvasRectWatched) return;
  canvasRectWatched = true;
  window.addEventListener('resize', invalidateCanvasRect);
  window.addEventListener('orientationchange', invalidateCanvasRect);
  window.addEventListener('scroll', invalidateCanvasRect, true);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', invalidateCanvasRect);
    window.visualViewport.addEventListener('scroll', invalidateCanvasRect);
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(invalidateCanvasRect);
    observer.observe(canvas);
    observer.observe(document.documentElement);
  }
}

watchCanvasRect();

function pointerPos(ev) {
  const rect = canvasRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (state.animating) return;
  // 手势起点重量一次：中间万一是 ResizeObserver 还没回调到的布局变化，落点也不会错。
  invalidateCanvasRect();
  const p = pointerPos(ev);
  const w = view.toWorld(p.x, p.y);

  // 球局模式下有持球：点哪儿就把母球放哪儿
  if (state.mode === 'game' && state.game?.ballInHand) {
    // 对手持球时由 takeTurn 自己摆位，玩家不能替它放——除非自动出杆正被暂停
    // （撤销 / 读档之后），那时它就是不会动，拦着只会和提示条自相矛盾。
    if (state.autoOpponent && !state.autoPaused && state.game.turn === 1) {
      setReport('现在是对手持球，它会自己摆母球。');
      return;
    }
    if (!placementAllowed(state.game, w.x, w.y)) {
      setReport('这个位置不能放母球：' + (state.game.ballInHand.zone === 'kitchen' ? '开球线后才是合法区。' : '要放在台面内。'));
      return;
    }
    if (!placeCueBall(state.game, w.x, w.y)) return;
    state.game.ballInHand = null;
    state.gSolution = null;
    setReport('母球已摆好，可以求解了。');
    updateScore();
    render();
    return;
  }

  const balls = state.mode === 'practice' ? state.balls : state.game?.balls ?? [];
  let hit = null;
  let bestD = Infinity;
  for (const b of balls) {
    if (b.pocketed) continue;
    // 球局模式下只有母球能拖（目标球位置由规则决定，不让人随便挪）
    if (state.mode === 'game' && b.number !== 0) continue;
    const d = Math.hypot(b.x - w.x, b.y - w.y);
    if (d < R * 2.5 && d < bestD) {
      bestD = d;
      hit = b;
    }
  }
  if (!hit) return;

  drag = { ball: hit, dx: hit.x - w.x, dy: hit.y - w.y };
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add('dragging');
});

// 拖球节流：pointermove 在高刷屏可达 120Hz+，每帧都 render 浪费。
// 用 rAF 把渲染合并到显示器刷新节拍，位置更新仍然即时（球跟手），只是绘制延迟一帧。
let pendingDragRender = false;

canvas.addEventListener('pointermove', (ev) => {
  if (!drag || state.animating) return;
  const p = pointerPos(ev);
  const w = view.toWorld(p.x, p.y);
  const b = drag.ball;
  const balls = state.mode === 'practice' ? state.balls : state.game.balls;

  let nx = clamp(w.x + drag.dx, table.bounds.minX, table.bounds.maxX);
  let ny = clamp(w.y + drag.dy, table.bounds.minY, table.bounds.maxY);
  for (const other of balls) {
    if (other === b || other.pocketed) continue;
    const d = Math.hypot(other.x - nx, other.y - ny);
    if (d < 2 * R + 1e-4) {
      const push = 2 * R + 1e-4 - d;
      const ux = (nx - other.x) / (d || 1);
      const uy = (ny - other.y) / (d || 1);
      nx += ux * push;
      ny += uy * push;
    }
  }
  b.x = clamp(nx, table.bounds.minX, table.bounds.maxX);
  b.y = clamp(ny, table.bounds.minY, table.bounds.maxY);

  if (state.mode === 'practice') clearSolution('摆位已改动，重新求解。');
  else state.gSolution = null;

  if (!pendingDragRender) {
    pendingDragRender = true;
    requestAnimationFrame(() => { pendingDragRender = false; render(); });
  }
});

function endDrag(ev) {
  if (!drag) return;
  drag = null;
  canvas.classList.remove('dragging');
  try { canvas.releasePointerCapture(ev.pointerId); } catch { /* 忽略 */ }
}

canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---------------------------------------------------------------- 练习：求解与演示

function updatePracticeFeedback(message = null) {
  // 记完一杆不再禁用：同一个球位反复练十杆是常态，每杆都得重新求解一次
  // 才能记录，等于逼人重复劳动。这里只要「有解」就给点，记多少次都行。
  const ready = practiceReady(state);
  $('practiceMade').disabled = !ready || state.animating;
  $('practiceMissed').disabled = !ready || state.animating;
  $('practiceMessage').textContent = message ?? practiceHint(state);
}

function updatePracticeLog() {
  const records = readPracticeLog();
  const summary = summarizePractice(records);
  const weekly = summarizePracticeDays(records);
  const today = summarizeTodayPractice(records, readPracticeGoal());
  const drillSummary = summarizeDrills(records);
  const missSummary = summarizeMissReasons(records);
  const practiceFocus = summarizePracticeFocus(records);
  $('clearPractice').disabled = records.length === 0;
  $('practiceUndo').disabled = records.length === 0;
  $('exportPractice').disabled = records.length === 0;
  $('practiceHistorySummary').textContent = records.length
    ? `查看最近 5 条（共 ${records.length} 条）`
    : '暂无记录明细';
  $('practiceSummary').textContent = summary.attempts
    ? `${summary.made}/${summary.attempts} 杆命中 · 总命中率 ${Math.round(summary.rate * 100)}% · 最近 ${summary.recent.attempts} 杆 ${summary.recent.attempts ? `${Math.round(summary.recent.rate * 100)}%` : '—'}`
    : '还没有实战记录。';
  $('practiceGoal').value = String(today.goal || DEFAULT_PRACTICE_GOAL);
  // 统计折起来了，但「今天练了几杆」得一眼看得见，否则折叠等于藏掉进度
  $('practiceStatsSummary').textContent = today.attempts
    ? `练习统计与今日目标（今天 ${today.attempts}/${today.goal} 杆${today.complete ? '，已达成' : ''}）`
    : '练习统计与今日目标';
  $('practiceGoalSummary').textContent = today.complete
    ? `今日目标达成！已完成 ${today.attempts}/${today.goal} 杆。`
    : `今日已练 ${today.attempts}/${today.goal} 杆 · 还差 ${today.remaining} 杆`;
  $('practiceGoalBar').setAttribute('aria-valuenow', String(Math.min(today.attempts, today.goal)));
  $('practiceGoalBar').setAttribute('aria-valuemax', String(today.goal));
  $('practiceGoalFill').style.width = `${Math.round(today.progress * 100)}%`;
  $('practiceWeekSummary').textContent = weekly.attempts
    ? `近 7 天 ${weekly.attempts} 杆 · 命中率 ${Math.round(weekly.rate * 100)}% · 练习 ${weekly.activeDays} 天 · 连续 ${weekly.streak} 天`
    : `近 7 天还没有实战记录。${weekly.streak ? ` 已连续练习 ${weekly.streak} 天。` : '记录一杆真实练习，开启连续训练。'}`;
  updatePracticeTrend(weekly.days);
  updateDrillStatus(drillSummary);
  updateMissReasonSummary(missSummary);
  updatePracticeFocus(practiceFocus);

  const labels = [
    ['narrow', '窄 <0.20°'],
    ['medium', '中 0.20–0.49°'],
    ['wide', '宽 ≥0.50°'],
  ];
  const buckets = $('practiceBuckets');
  buckets.textContent = '';
  let calibratedBuckets = 0;
  for (const [key, label] of labels) {
    const stats = summary.tolerance[key];
    const item = document.createElement('div');
    item.append(document.createTextNode(label));
    const value = document.createElement('b');
    if (stats.confidence95) {
      calibratedBuckets++;
      value.textContent =
        `${Math.round(stats.rate * 100)}% · ${stats.made}/${stats.attempts}` +
        ` · 95% ${Math.round(stats.confidence95.low * 100)}–${Math.round(stats.confidence95.high * 100)}%`;
    } else {
      value.textContent = `${stats.made}/${stats.attempts} · ${MIN_CALIBRATION_SAMPLES - stats.attempts > 0 ? `再记 ${MIN_CALIBRATION_SAMPLES - stats.attempts} 杆` : '样本少'}`;
    }
    item.appendChild(value);
    buckets.appendChild(item);
  }
  $('practiceCalibration').textContent = calibratedBuckets
    ? `个人实战校准：${calibratedBuckets} 个容错区间达到 ${MIN_CALIBRATION_SAMPLES} 杆。区间为 95% 统计范围；仅作训练参考，不会自动修改 AI 推荐。`
    : `个人校准样本还不够：某个容错区间至少记录 ${MIN_CALIBRATION_SAMPLES} 杆后，才显示该区间命中率及 95% 统计范围。`;

  const history = $('practiceHistory');
  history.textContent = '';
  const recent = records.slice(-5).reverse();
  if (!recent.length) {
    history.textContent = '—';
    history.className = 'log empty';
    return;
  }
  history.className = 'log';
  for (const record of recent) {
    const item = document.createElement('div');
    const time = new Date(record.timestamp).toLocaleString();
    const reason = PRACTICE_MISS_REASONS.find((item) => item.id === record.missReason)?.label;
    item.textContent =
      `${time} · ${record.made ? '命中' : `未进${reason ? `（${reason}）` : ''}`} · ${record.targetNumber} 号 → ${pocketName(record.pocketId)} · 容错 ±${record.toleranceDeg.toFixed(2)}°`;
    history.appendChild(item);
  }
}

function updateMissReasonSummary(summary) {
  const details = PRACTICE_MISS_REASONS
    .filter(({ id }) => summary.counts[id] > 0)
    .map(({ id, label }) => `${label} ${summary.counts[id]} 次`);
  if (summary.unclassified) details.push(`未分类 ${summary.unclassified} 次`);
  $('missReasonSummary').textContent = summary.misses
    ? `未进 ${summary.misses} 杆 · 已标注 ${summary.labeled} 杆：${details.join(' · ')}`
    : '还没有未进记录。';
}

function updatePracticeFocus(summary) {
  const message = $('practiceFocus');
  const action = $('practiceFocusAction');
  action.hidden = true;

  if (summary.labeled < PRACTICE_FOCUS_MIN_LABELS) {
    const remaining = PRACTICE_FOCUS_MIN_LABELS - summary.labeled;
    message.textContent =
      `训练建议：近 ${summary.window} 次未进中已标注 ${summary.labeled} 次原因；再标注 ${remaining} 次后，可根据近期记录推荐练习重点。`;
    return;
  }

  if (!summary.reason) {
    message.textContent = `训练建议：近 ${summary.window} 次未进原因较分散，暂时没有明显的单一薄弱项；保持多类型练习，并继续记录原因。`;
    return;
  }

  const reason = PRACTICE_MISS_REASONS.find(({ id }) => id === summary.reason);
  const count = summary.counts[summary.reason];
  const guidance = {
    aim: '建议先练直线球，稳定瞄准节奏。',
    speed: '建议先练直线球，使用轻力并保持每次力度一致。',
    contact: '建议练切球，观察目标球路线并校准击球厚薄。',
    spin: '建议先练直线球，从中杆开始，再单独比较杆法。',
    position: '多对照母球实际停位与建议路线；当前还没有专门的走位摆球训练。',
    other: '继续记录更具体的未进原因，便于找到可练的方向。',
  }[summary.reason];
  message.textContent =
    `训练建议：近 ${summary.window} 次未进中，“${reason.label}”出现 ${count} 次（已标注 ${summary.labeled} 次）。${guidance}`;

  if (summary.drillId) {
    const drill = PRACTICE_DRILLS.find(({ id }) => id === summary.drillId);
    action.textContent = `开始推荐训练：${drill.name}`;
    action.hidden = false;
  }
}

function updatePracticeTrend(days) {
  const chart = $('practiceTrend');
  chart.textContent = '';
  for (const day of days) {
    const item = document.createElement('div');
    item.className = 'practice-day';
    item.setAttribute(
      'aria-label',
      `${day.label}：${day.attempts ? `${day.made}/${day.attempts} 杆命中，命中率 ${Math.round(day.rate * 100)}%` : '没有记录'}`
    );

    const rate = document.createElement('b');
    rate.className = 'practice-day-rate';
    rate.textContent = day.rate == null ? '—' : `${Math.round(day.rate * 100)}%`;

    const track = document.createElement('div');
    track.className = 'practice-day-track';
    const bar = document.createElement('div');
    bar.className = `practice-day-bar${day.rate == null ? ' no-data' : ''}`;
    bar.style.height = day.rate == null ? '0%' : `${Math.max(4, day.rate * 100)}%`;
    track.appendChild(bar);

    const count = document.createElement('span');
    count.className = 'practice-day-count';
    count.textContent = day.attempts ? `${day.made}/${day.attempts}` : '—';

    const label = document.createElement('span');
    label.className = 'practice-day-label';
    label.textContent = day.label;

    item.append(rate, track, count, label);
    chart.appendChild(item);
  }
}

function updateDrillStatus(summary = summarizeDrills(readPracticeLog())) {
  const selected = PRACTICE_DRILLS.find((drill) => drill.id === $('drillSelect').value);
  if (!selected) return;
  const stats = summary[selected.id];
  $('drillDescription').textContent = `${selected.description} 重点：${selected.focus}。`;
  $('drillProgress').textContent =
    `${state.activeDrillId ? `当前计分：${PRACTICE_DRILLS.find((drill) => drill.id === state.activeDrillId).name} · 轮换球位 ${state.activeDrillVariation + 1}/${PRACTICE_DRILL_VARIATIONS} · ` : '尚未开始训练 · '}` +
    `${stats.passedSets} 组达标 · 累计 ${stats.made}/${stats.attempts} 杆命中` +
    ` · 当前组 ${stats.currentSetAttempts}/${DRILL_SET_SIZE}（命中 ${stats.currentSetMade}）` +
    ` · 目标 ${DRILL_SET_TARGET}/${DRILL_SET_SIZE}`;
}

function startPracticeDrill() {
  const drill = PRACTICE_DRILLS.find((item) => item.id === $('drillSelect').value);
  if (!drill) return;
  const layout = practiceDrillLayout(table, drill.id, state.drillVariation++);
  const { cue, target } = layout;
  // 换题会把球数组从 4 颗换成 2 颗，在途回放必须作废。
  state.generation += 1;
  state.solution = null;
  state.practiceRecorded = false;
  state.activeDrillId = drill.id;
  state.activeDrillVariation = layout.variation;
  state.animating = false;
  updateDrillStatus();
  state.balls = [
    createBall('cue', cue.x, cue.y, { number: 0, ...ballStyle(0) }),
    createBall('b1', target.x, target.y, { number: 1, ...ballStyle(1) }),
  ];
  createWorld(table, state.balls);
  refreshBallPicker();
  updatePracticeFeedback(`已摆好「${drill.name}」专项训练。完成一杆后记录实战结果。`);
  setAdvice('练习球位已就绪。点击「求解最佳方案」查看建议，完成真实击球后记录结果。', '');
  $('alts').textContent = '—';
  $('alts').className = 'empty';
  render();
}

function recordPracticeOutcome(made) {
  if (state.mode !== 'practice' || state.animating) return false;
  // 双击防呆：「进了」和「没进」是挨着的两个按钮，手抖点两下不该记成两杆。
  // 真连着记两杆至少也要换一次手，600 ms 里点两下一定是误触。
  const now = Date.now();
  if (now - state.lastRecordAt < 600) return false;
  const best = state.solution?.found ? state.solution.best : null;
  if (!best?.pocketId) {
    updatePracticeFeedback('请先求解一个有目标袋的方案。');
    return false;
  }
  const saved = appendPracticeResult({
    timestamp: Date.now(),
    made,
    toleranceDeg: best.toleranceDeg,
    difficulty: best.difficulty,
    speed: best.speed,
    targetNumber: best.targetNumber,
    pocketId: best.pocketId,
    tableId: table.preset,
    drillId: state.activeDrillId,
    missReason: made ? null : $('missReason').value || null,
  });
  if (!saved) {
    updatePracticeFeedback('本次记录未能保存；请检查浏览器是否允许本地存储。');
    return false;
  }
  state.practiceRecorded = true;
  state.lastRecordAt = now;
  $('missReason').value = '';
  updatePracticeLog();
  updatePracticeFeedback(`已记录实战结果：${made ? '命中' : '未进'}。同一个球位可以接着记。`);
  return true;
}

/**
 * 把建议力度写进手打滑条。
 *
 * 求解给的 best.speed 是任意浮点（几何解出来的 seedSpeed × 力度系数），滑条只能
 * 停在格子上。滑条 step 改成 0.01、界面上的力度一直按两位小数显示，所以这里也
 * 取到两位：建议值、滑条值、力度标签从此是同一个数，不会出现「求解说轻力、力度
 * 条却在爆杆」。
 *
 * 只动 UI 这一侧：演示这一杆照样拿 best.speed 本身跑仿真，精度没被滑条吃掉。
 */
function syncPowerToSolution(speed) {
  const el = $('power');
  const v = Math.round(clamp(speed, Number(el.min), Number(el.max)) * 100) / 100;
  state.manual.speed = v;
  el.value = v.toFixed(2);
  updateManualLabels();
  return v;
}

/**
 * 结论徽章：只留一个分数和一句人话。
 *
 * coach() 给的 verdict 里塞了两个分数（综合 / 单杆难度）和一个毫秒数：两个分数
 * 读不出区别，毫秒是给我们自己看性能的，对球友没有意义。
 */
function scoreBadge(score, label) {
  return `难度 ${Math.round(score)}/100（${label}）· ${difficultyCaveat()}`;
}

function runSolve() {
  state.practiceRecorded = false;
  // 局面要重新算了，上一次导出的图不再代表这一杆
  invalidateShare();
  const all = solveShot(table, state.balls);
  const card = coach(table, state.balls, { candidates: all });
  state.solution = card;
  updatePracticeFeedback();

  if (!card.found) {
    setAdvice(card.message, '');
    setAltsEmpty();
    render();
    return;
  }

  const cls = card.best.difficulty > 80 ? 'brutal' : card.best.difficulty > 55 ? 'hard' : '';
  // 建议力度同步进手打滑条。不同步的话，求解说「轻力」而力度条还停在爆杆那一档
  // （演示这一杆用的是 best.speed，滑条只喂手打），用户看到的是两句互相打脸的话。
  // 只动 UI：演示仍然用 best.speed 本身跑仿真。
  const speed = syncPowerToSolution(card.best.speed);
  const score = card.best.value ?? card.best.difficulty;
  setAdvice(card.message, scoreBadge(score, difficultyLabel(score)), cls);
  renderAlts(card);
  $('shootNote').textContent = `演示这一杆按建议力度 ${speed.toFixed(2)} m/s 打（左边滑条已同步到同一档）。`;
  $('shootNote').classList.remove('hidden');
  render();
}

function renderAlts(card) {
  $('altsCard').classList.remove('hidden');
  $('alts').className = '';
  $('alts').innerHTML = '';
  const list = [card.best, ...card.alternatives];
  for (const [i, c] of list.entries()) {
    const row = document.createElement('div');
    row.className = 'alt' + (i === 0 ? ' active' : '');
    const title = document.createElement('div');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${i === 0 ? '★ ' : ''}${c.targetNumber} 号 → ${pocketName(c.pocketId)}`;
    title.appendChild(name);
    if (c.positioningRequired && c.cueRest) {
      const position = document.createElement('span');
      position.className = 'position';
      position.textContent = c.nextShot
        ? `${cueRestText(table, c.cueRest)} · 下一杆 ${c.nextShot.targetNumber} 号`
        : cueRestText(table, c.cueRest);
      title.appendChild(position);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `±${c.toleranceDeg.toFixed(2)}° · ${difficultyLabel(c.value ?? c.difficulty)}`;
    // 触屏没有 hover，给一个常驻的箭头，让人知道这一行能点
    const go = document.createElement('span');
    go.className = 'go';
    go.setAttribute('aria-hidden', 'true');
    go.textContent = '›';
    row.append(title, meta, go);
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.title = '点一下换成这个方案';
    row.addEventListener('click', () => {
      if (state.animating) return;
      const v = c.value ?? c.difficulty;
      state.solution = {
        ...card,
        best: c,
        message: describeCandidate(c),
        verdict: scoreBadge(v, difficultyLabel(v)),
      };
      state.practiceRecorded = false;
      updatePracticeFeedback();
      for (const el of $('alts').querySelectorAll('.alt')) el.classList.toggle('active', el === row);
      const dd = c.difficulty;
      setAdvice(state.solution.message, state.solution.verdict, dd > 80 ? 'brutal' : dd > 55 ? 'hard' : '');
      // 换方案等于换力度：滑条和下面那行说明也得跟着换，否则又回到「建议和滑条
      // 各说各话」。
      const speed = syncPowerToSolution(c.speed);
      $('shootNote').textContent = `演示这一杆按建议力度 ${speed.toFixed(2)} m/s 打（左边滑条已同步到同一档）。`;
      render();
    });
    // 标了 role=button + tabIndex，键盘也得能按，否则焦点停在上面按回车没反应
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      row.click();
    });
    $('alts').appendChild(row);
  }
}

/** 按录制帧回放，结束后回调。 */
function replay(frames, dt, onDone) {
  // 这一串帧属于哪个局面。回放期间用户可能切模式、点重置、换训练题或换球台，
  // 那些入口会把球数组整个换成另一个长度；不认代次就会按下标写到 undefined 上。
  const gen = state.generation;
  // 写目标也在开头定死：中途 state.mode 变了，就再也回不到原来那个数组了。
  const targets = state.mode === 'practice' ? state.balls : state.game.balls;
  state.animating = true;
  updatePracticeFeedback();
  // 回放期间撤销按钮要立刻灰掉：pushHistory 是在 replay 之前调用的，那时
  // animating 还是 false，按钮被点亮了；不在这里补一手，整段回放里它都亮着，
  // 点了又被 undoGame 的守卫吞掉——用户只会觉得撤销坏了（真机实测报的这条）。
  updateUndoButton();

  // 中途作废时把球杆复位。不复位的话，停在 -0.012 的球杆会插在母球里，
  // 换到新局面上看着就像穿模。
  const restoreStroke = () => {
    state.manual.strokeOffset = getPowerTier(state.manual.speed).ratio * 0.12;
  };

  const startRolling = () => {
    const t0 = performance.now();
    const tick = () => {
      // 局面已经换掉了，这一串帧作废。
      // 这里绝不能回写 state.animating = false：切换入口自己会置 false，
      // 旧 tick 再写一次会把新回放刚设上的 true 踩掉，新回放就永远不动了。
      if (gen !== state.generation) {
        restoreStroke();
        // 这一串帧作废了，但按钮的灰/亮得跟着当前状态重新算（新回放可能已经开始了）。
        updateUndoButton();
        return;
      }
      const elapsed = (performance.now() - t0) / 1000;
      const frameTime = Math.min(frames.length - 1, elapsed / dt);
      const idx = Math.floor(frameTime);
      const f = interpolateBallStates(frames[idx], frames[Math.min(idx + 1, frames.length - 1)], frameTime - idx);
      const balls = targets;
      for (let i = 0; i < balls.length && i < f.length; i++) {
        balls[i].x = f[i].x;
        balls[i].y = f[i].y;
        balls[i].pocketed = f[i].pocketed;
        balls[i].pocket = f[i].pocket;
        balls[i].rollAngle = f[i].rollAngle;
        balls[i].rollDirX = f[i].rollDirX;
        balls[i].rollDirY = f[i].rollDirY;
      }
      render();
      if (frameTime >= frames.length - 1) {
        state.animating = false;
        updatePracticeFeedback();
        // 回放结束：撤销按钮该亮回来了，否则这一局从此撤不了。
        updateUndoButton();
        // 复位球杆击球位移
        const tier = getPowerTier(state.manual.speed);
        state.manual.strokeOffset = tier.ratio * 0.12;
        onDone();
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // 第一人称视角下播放出杆击球撞击动效（60ms 迅猛前刺撞击母球）
  if (view.getCamera().t > 0.05) {
    const strikeStart = performance.now();
    const strikeDuration = 60;
    const fromOffset = state.manual.strokeOffset || 0.04;
    const strikeTick = () => {
      if (gen !== state.generation) {
        restoreStroke();
        return;
      }
      const elapsed = performance.now() - strikeStart;
      const p = Math.min(1, elapsed / strikeDuration);
      state.manual.strokeOffset = fromOffset * (1 - p) + (-0.012) * p;
      render();
      if (p < 1) {
        requestAnimationFrame(strikeTick);
      } else {
        startRolling();
      }
    };
    requestAnimationFrame(strikeTick);
  } else {
    startRolling();
  }
}

/**
 * 演示一杆之后的结论。
 *
 * 原来点完「演示这一杆」，球散开、动画停住，页面上没有一句话说这一杆成没成：
 * #advice 还停在求解时的建议上，#verdict 还是求解徽章，#report 还写着「点
 * 「新的一局」开始。」——新手只能自己盯着台面猜。这里给一行明确结论，并说清
 * 差多少（落点是仿真里的真实球位，不是估算）。
 */
function practiceConclusion(balls, best) {
  const number = best.targetNumber;
  const wanted = pocketName(best.pocketId);
  const target = balls.find((b) => b.id === best.targetId);
  if (target?.pocketed && target.pocket === best.pocketId) {
    return { ok: true, text: `✓ 进袋：${number} 号进了${wanted}` };
  }
  if (target?.pocketed) {
    return {
      ok: false,
      text: `✗ 没进：建议打${wanted}，${number} 号却落进了${pocketName(target.pocket)}`,
    };
  }
  const pocket = table.pockets.find((p) => p.id === best.pocketId);
  if (target && pocket) {
    const gap = Math.hypot(target.x - pocket.x, target.y - pocket.y) - pocket.captureR;
    return {
      ok: false,
      text: `✗ 没进：${number} 号停在${wanted}外，差 ${Math.max(0, gap * 100).toFixed(1)} 厘米`,
    };
  }
  return { ok: false, text: `✗ 没进：${number} 号没有进${wanted}` };
}

function shootPractice() {
  const sol = state.solution;
  if (!sol || !sol.found) {
    setAdvice('先求解，再演示。', '');
    return;
  }
  const best = sol.best;
  // 整杆模拟本体在 state.js 的 simulateFrames：这里只要「帧 + 步长」两样东西。
  const sim = simulateFrames(
    state.balls,
    table,
    { angle: best.aimAngle, speed: best.speed, tip: { a: best.tip.a, b: best.tip.b } },
    SEARCH_DT
  );
  if (!sim) return;
  const { frames, dt } = sim;

  const original = snapshotPositions(state.balls);
  // replay 内部已经按代次拦住过期帧，这里再挡一次：只要 original 和当前球数组不是同一批球，
  // 按下标恢复就会读到 undefined。宁可什么都不做，也不能把别人的局面改坏。
  const gen = state.generation;
  replay(frames, dt, () => {
    if (gen !== state.generation || state.balls.length !== original.length) return;
    // 结论要在还原球位之前取：restorePositions 会把 pocketed / 落点一起抹掉。
    const conclusion = practiceConclusion(state.balls, best);
    restorePositions(state.balls, original);
    const score = best.value ?? best.difficulty;
    // ✓ / ✗ 打头是 E2E 认的契约（E2E 用 startsWith('✓') 判演示成功）。
    setAdvice(
      `${conclusion.text}。${best.speed.toFixed(2)} m/s · ${sol.message}`,
      `${conclusion.text} · ${scoreBadge(score, difficultyLabel(score))}`,
      conclusion.ok ? '' : 'miss'
    );
    // 播报位也记一条：球局面板的「这一杆播报」原来一直停在「点「新的一局」开始。」，
    // 练完一杆回头看不出刚发生了什么。
    setReport(
      `练习演示：${conclusion.text}（按建议力度 ${best.speed.toFixed(2)} m/s 跑的仿真，不计入实战统计）。`
    );
    render();
  });
}

// ---------------------------------------------------------------- 球局

/**
 * 撤掉「对手方案」标记。
 *
 * 标记的意义是「这张卡里装的是对手的打法」，只在刚给对手算过的那一份方案上有
 * 效。换局面（重开 / 撤销 / 读档 / 自己打了一杆 / 对手自己打完）之后卡片内容不是
 * 那份方案了，标记必须跟着撤——留着就是给错的内容盖了个公章。
 */
function clearOpponentMark() {
  $('gAdviceCard').classList.remove('opponent');
  $('gAdviceTag').classList.add('hidden');
}

function newGame() {
  // 玩法决定摆球：黑八摆三角 15 颗、九球摆菱形 9 颗。
  // 用 createRack 而不是直接调 createStandardRack，是为了让「摆球方式」只有一处判断，
  // 免得以后加十球时得在四个地方各改一遍。
  const kind = state.gameKind;
  const balls = createRack(kind, table, { seed: Math.floor(Math.random() * 1e6) }).map((b) =>
    createBall(b.id, b.x, b.y, b)
  );
  // 换局号要排在装配之前：上一局的回放 / 450 ms 续杆定时器醒来后靠它认出自己过期了。
  state.generation += 1;
  state.game = createGame(table, balls, { names: ['你', '对手'], kind });
  state.gSolution = null;
  state.animating = false;
  state.opponentThinking = false;
  state.history = [];
  // 上一局的容错记录不能留到新局：杆号会从头数，留着就是一份错位的「关键杆」
  state.shotLog = [];
  // 新的一局不该带着上一局留下的暂停：这是用户主动重开，算 'new-game'。
  Object.assign(state, reduceAutoPause(state, 'new-game'));
  state.historyNote = null;
  updateUndoButton();
  setReport(
    kind === 'nineball'
      ? '九球开球。只能先碰台面上号码最小的那颗；合法进 9 号直接赢局。点「求解」看第一杆怎么打。'
      : '开球。点「求解」看第一杆怎么打。'
  );
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  clearOpponentMark();
  $('gRerack').classList.add('hidden');
  $('gChoice').classList.add('hidden');
  updateScore();
  updateLog();
  updateAutoPauseBar();
  render();
}

function setReport(html) {
  $('report').innerHTML = html;
  $('report').className = '';
}

function updateScore() {
  const g = state.game;
  if (!g) return;
  const box = $('score');
  box.innerHTML = '';
  // 斯诺克按分计，没有分组也没有「剩几颗」——直接显示比分和该打什么球。
  if (g.snooker) {
    for (let i = 0; i < 2; i++) {
      const p = g.players[i];
      const div = document.createElement('div');
      div.className = 'who' + (g.turn === i && g.phase === 'playing' ? ' turn' : '');
      div.innerHTML = `<span class="nm">${esc(p.name)}</span>
        <span class="tag2">${g.snooker.scores[i]} 分</span>`;
      box.appendChild(div);
    }
    const on = document.createElement('div');
    on.className = 'who';
    const onText =
      g.phase === 'ended'
        ? `本局结束 · ${esc(g.players[g.winner]?.name ?? '—')} 获胜`
        : g.snooker.ballOn === 'red'
          ? '该打：红球'
          : g.snooker.ballOn === 'color'
            ? '该打：任意彩球'
            : `该打：${snookerBallName(g.snooker.ballOn)}`;
    on.innerHTML = `<span class="nm">${onText}</span>`;
    box.appendChild(on);
    return;
  }
  for (let i = 0; i < 2; i++) {
    const p = g.players[i];
    const div = document.createElement('div');
    div.className = 'who' + (g.turn === i && g.phase === 'playing' ? ' turn' : '');
    const tagCls = p.group ?? '';
    const tagTxt = p.group ? GROUP_LABEL[p.group] : '未分组';
    const left = p.group ? remainingOfGroup(numbersOnTable(g.balls), p.group) : null;
    div.innerHTML = `<span class="nm">${esc(p.name)}</span>
      <span class="tag2 ${tagCls}">${tagTxt}</span>
      ${left !== null ? `<span class="tag2">剩 ${left}</span>` : ''}
      ${p.fouls > 0 ? `<span class="fs">连犯 ${p.fouls}</span>` : ''}`;
    box.appendChild(div);
  }
  if (g.phase === 'ended') {
    const d = document.createElement('div');
    d.className = 'who';
    d.innerHTML = `<span class="nm">本局结束</span><span class="tag2">${esc(g.players[g.winner]?.name ?? '—')} 获胜</span>`;
    box.appendChild(d);
  }
}

function updateLog() {
  const g = state.game;
  // 「对局记录」旁边那块赛后复盘跟着一起刷：它俩读的是同一份 g.log，
  // 分成两处调用迟早会出现「流水变了、统计没变」。
  updateMatchStats();
  const box = $('log');
  // 读档时杆史被体积预算裁过的话，这里留一句话——否则用户只会看到
  // 「对局记录」比记忆里少几杆，又以为读档丢了东西。样式走行内属性，
  // 因为这次不碰 index.html 的 <style>（另一个 worker 正在改布局）。
  let note = null;
  if (state.historyNote) {
    note = document.createElement('div');
    note.setAttribute('data-role', 'history-note');
    note.setAttribute('style', 'color:#f59e0b;margin-bottom:4px;');
    note.textContent = state.historyNote;
  }
  if (!g || !g.log.length) {
    box.innerHTML = '';
    // 提示行和「—」要同时在场：只有一行橙字时，看起来像记录区还在加载或者坏了，
    // 补一个占位才说清「这里没有记录」，上面那行只解释为什么没有。
    if (note) box.appendChild(note);
    box.appendChild(document.createTextNode('—'));
    return;
  }
  box.innerHTML = '';
  if (note) box.appendChild(note);
  for (const entry of g.log.slice(-40).reverse()) {
    const d = document.createElement('div');
    d.textContent = `第 ${entry.shot} 杆 · ${entry.summary}`;
    box.appendChild(d);
  }
  box.scrollTop = 0;
}

// ---------------------------------------------------------------- 赛后复盘与跨局战绩
//
// 「对局记录」给的是流水，这里给的是读完流水之后的几个数：本局多少杆、进了几杆、
// 最长连着进了几杆；下面是跨局战绩。计算全在 state.js 的纯函数里
// （computeMatchStats / summarizeHistory，单测钉着），这里只负责贴到 DOM 上。
//
// 战绩存在 dsh-billiards-matches（demo/save.js），和存档 key 完全分开：读档、
// 清档、导入存档都不该动到历史战绩。
//
// 注意这里是 demo/app.js，是允许碰 localStorage 的那一层（demo/state.js 不行）。

/** 已经记过账的局号。一局只记一条——撤销退回去再打完、读档后重画都不会多记。 */
let matchedGeneration = -1;

const MATCH_RESULT_TEXT = { win: '胜', loss: '负', undecided: '未分胜负' };

function formatRate(rate) {
  return typeof rate === 'number' && Number.isFinite(rate) ? `${Math.round(rate * 100)}%` : '—';
}

function formatMatchWhen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 一局打完时把这场写进战绩。
 *
 * 只在「真的结束了 + 这个局号还没记过」时写：结束后点撤销、再打回来，或者读回
 * 一份已经结束的存档，都不该多出一条。
 */
function recordFinishedMatch(g) {
  if (!g || g.phase !== 'ended') return;
  if (matchedGeneration === state.generation) return;
  matchedGeneration = state.generation;
  const stats = computeMatchStats({ log: g.log, kind: g.kind, winner: g.winner, myself: 0 });
  appendMatch({
    kind: g.kind,
    result: stats.result,
    shots: stats.shots,
    potRate: stats.potRate,
    longestRun: stats.longestRun,
    fouls: stats.fouls,
  });
}

/** 刷「赛后复盘」面板：本局统计 + 最近 5 场 + 汇总 + 走势。 */
function updateMatchStats() {
  const box = $('matchStats');
  if (!box) return;
  const g = state.game;
  recordFinishedMatch(g);
  const stats = computeMatchStats({
    log: g ? g.log : [],
    kind: g ? g.kind : '',
    winner: g && g.phase === 'ended' ? g.winner : null,
    myself: 0,
  });
  const history = readMatches();
  const sum = summarizeHistory(history);

  const parts = [];
  if (g) {
    parts.push(
      '<div class="match-grid">' +
        `<div>杆数<b>${stats.shots}</b></div>` +
        `<div>进球<b>${stats.pots}</b></div>` +
        `<div>命中率<b>${formatRate(stats.potRate)}</b></div>` +
        `<div>最长连击<b>${stats.longestRun}</b></div>` +
        `<div>犯规<b>${stats.fouls}</b></div>` +
        `<div>本局结果<b>${MATCH_RESULT_TEXT[stats.result]}</b></div>` +
        '</div>'
    );
  } else {
    parts.push('<p class="hint">开一局球，打完在这里看复盘。</p>');
  }

  // 这行文案必须跟着「有没有打完的对局」走。原来不管三七二十一都写「还没有打完
  // 的对局」，于是终局时上面一行是「本局结果 负」，下面一行说还没打完——自己跟
  // 自己打架。存不下战绩（浏览器禁了本地存储）是另一件事，也要分开说。
  const ended = Boolean(g && g.phase === 'ended');
  if (!history.length) {
    parts.push(
      ended
        ? '<p class="hint">这一局打完了，但战绩没能存下来（浏览器可能禁用了本地存储）。</p>'
        : '<p class="hint">还没有打完的对局——一局结束会自动记一条。</p>'
    );
  } else {
    parts.push('<div class="match-title">最近 5 场</div><ul class="match-list">');
    for (const m of history.slice(-5).reverse()) {
      const kindLabel = GAME_KINDS[m.kind]?.label ?? m.kind;
      const cls = m.result === 'win' ? 'warm' : m.result === 'loss' ? 'cold' : '';
      parts.push(
        `<li><span>${formatMatchWhen(m.ts)} · ${esc(kindLabel)}</span>` +
          `<span class="${cls}">${MATCH_RESULT_TEXT[m.result]} · ${m.shots} 杆 · ${formatRate(m.potRate)}</span></li>`
      );
    }
    parts.push('</ul>');
    parts.push(
      '<div class="match-title">汇总</div>' +
        `<div class="match-sum">共 ${sum.matches} 场 · ${sum.wins} 胜 ${sum.losses} 负` +
        `${sum.undecided ? ` ${sum.undecided} 未分胜负` : ''} · 总杆数 ${sum.shots} · ` +
        `总体命中率 ${formatRate(sum.potRate)} · 最长连击 ${sum.longestRun}</div>` +
        '<div class="match-form">' +
        sum.recent
          .map((r) => {
            const cls = r === 'win' ? 'warm' : r === 'loss' ? 'cold' : '';
            return `<i class="match-dot ${cls}" title="${MATCH_RESULT_TEXT[r]}"></i>`;
          })
          .join('') +
        '</div>'
    );
    // 刚打完这一局：明确说一句「记上了」，别让人对着历史列表猜这一局到底进没进
    // 战绩（终局那一屏最容易让人不放心）。
    if (ended) {
      parts.push(
        `<p class="hint">战绩已记录（共 ${sum.matches} 场）——刚打完的这一局也在里面。</p>`
      );
    }
  }
  box.innerHTML = parts.join('');
  // 这一局刚打完（或刚被撤销 / 读档）时，「复盘这一局」的可用性要跟着变
  updateShareMatchButton();
}

/**
 * 球桌上方的「自动出杆已暂停 / 已关闭」提示条。
 *
 * 显示什么、要不要给「点此继续」全部由 state.js 的 autoPauseHint 决定，
 * 这里只负责把它贴到 DOM 上——那条判断是要单测的，不能长在 DOM 边上。
 */
function updateAutoPauseBar() {
  const bar = $('autoPauseBar');
  // 提示条出现/消失就是「该按哪个按钮」变了，顺便把按钮的可用性对齐。
  syncGameGates();
  if (!bar) return;
  const hint = state.mode === 'game' ? autoPauseHint(state) : null;
  if (!hint) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const text = $('autoPauseText');
  if (text) text.textContent = hint.text;
  const btn = $('autoPauseResume');
  if (btn) btn.classList.toggle('hidden', !hint.canResume);
}

/** 提示条上的「点此继续」：用户明确要求恢复自动出杆。 */
function resumeAutoOpponent() {
  Object.assign(state, reduceAutoPause(state, 'resume'));
  if (!state.autoOpponent) {
    // 提示条也可能是「开关关着」那一档：点继续等于把开关打开。
    state.autoOpponent = true;
    const box = $('autoOpponent');
    if (box) box.checked = true;
  }
  updateAutoPauseBar();
  setReport('已恢复对手自动出杆。');
  maybeOpponentTurn();
}

function gameSolve() {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  // 对手回合的判断要排在 animating 之前：对手正在出杆动画里时 g.turn 还是 1
  // （runOpponentTurn 是先回放再结算），玩家这时点「求解」应该看到"它自己会打"，
  // 而不是什么都不发生。
  // 暂停态（撤销 / 读档之后）是例外：那时对手不会自己出杆，用户想算这一杆
  // 完全合理，拦下来只会像按钮坏了。
  if (state.autoOpponent && !state.autoPaused && g.turn === 1) {
    $('gAdvice').textContent = '现在是对手回合，不用你算——它会自己打。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    clearOpponentMark();
    return;
  }
  if (state.animating) return;
  if (g.requiresRerack) {
    $('gAdvice').textContent = '上一杆开球不合法，必须先点「重摆开球」——规则里这一杆不算数。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    clearOpponentMark();
    return;
  }
  if (g.ballInHand) {
    $('gAdvice').textContent = '先把母球摆到台面上（在合法区里点一下）。';
    $('gAdvice').className = 'empty';
    clearOpponentMark();
    return;
  }
  const onTable = numbersOnTable(g.balls);
  const allow = legalTargetNumbers(g, onTable);
  // 这次求解是给谁算的：轮到对手（自动出杆关掉或暂停时玩家可以替它算）时，
  // 方案是「它怎么打你」，必须跟自己的建议区分开。
  const asOpponent = g.turn === 1;
  const { plan, kind, alternatives } = planShot(table, g, { allow, safety: state.allowSafety });

  if (!plan) {
    state.gSolution = { found: false };
    $('gAdvice').textContent = '台面上没有可以合法先碰的球。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    clearOpponentMark();
    syncGameGates();
    render();
    return;
  }

  state.gSolution = { found: true, best: plan, all: [plan, ...alternatives], kind };
  $('gAdvice').textContent = describeCandidate(plan);
  $('gAdvice').className = '';

  const kindLabel =
    kind === 'break'
      ? '开球'
      : kind === 'direct'
        ? '没有进攻机会，先保证合法'
        : kind === 'safety'
          ? '防守'
          : difficultyLabel(plan.value ?? plan.difficulty);
  // 一个分数 + 一句人话就够了：原来塞了两个分数和一个毫秒数，「综合 10.7」和
  // 「单杆难度 32.3」读不出区别，14 ms 是给我们自己看的。
  const badgeText =
    kind === 'attack'
      ? scoreBadge(plan.value ?? plan.difficulty, kindLabel)
      : kind === 'safety'
        ? `${kindLabel}（对手容错 ±${plan.safetyOppToleranceDeg.toFixed(2)}° · 从 ±${plan.safetyBaseToleranceDeg.toFixed(2)}° 压下来）`
        : kindLabel;
  $('gVerdict').textContent = badgeText;
  $('gVerdict').className =
    kind === 'attack' && plan.difficulty > 80 ? 'brutal' : kind === 'attack' && plan.difficulty > 55 ? 'hard' : '';
  // 角标 + 换色说清这份方案是给对手的：不然「防守：打 4 号球偏 -5°」会被当成
  // 给自己的建议，照着打等于替对手打了一杆最好的球。
  $('gAdviceCard').classList.toggle('opponent', asOpponent);
  $('gAdviceTag').classList.toggle('hidden', !asOpponent);
  syncGameGates();
  render();
}

function gameShoot() {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  // 同 shootGameWith：暂停态下对手不会自己出杆，玩家可以替它打。
  if (state.autoOpponent && !state.autoPaused && g.turn === 1) return;
  if (state.animating) return;
  if (g.requiresRerack) {
    $('gAdvice').textContent = '上一杆开球不合法，先点「重摆开球」。';
    return;
  }
  if (g.ballInHand) {
    $('gAdvice').textContent = '先把母球摆到台面上。';
    return;
  }
  const sol = state.gSolution;
  if (!sol || !sol.found) {
    $('gAdvice').textContent = '先点「求解」。';
    return;
  }
  const best = sol.best;
  const facts = simulateShot(
    table,
    g.balls,
    { angle: best.aimAngle, speed: best.speed, tip: { a: best.tip.a, b: best.tip.b } },
    { record: true, dt: SEARCH_DT }
  );
  const { next, report } = resolveShot(g, facts);
  pushHistory(g);

  // 记下这一杆属于哪一局：回放期间用户可能点了「新的一局」，那时 next 已经是旧局面，
  // 醒来后不能再往新局上写。见 newGame() 里的 generation++。
  const gen = state.generation;
  replay(facts.frames, facts.dt, () => {
    if (gen !== state.generation) return;
    state.game = next;
    state.gSolution = null;
    recordTolerance(next.shots, best);
    state.placing = Boolean(next.ballInHand);
    canvas.classList.toggle('placing', state.placing);

    // 拼装的唯一实现在 state.js 的 reportHtml：三个调用点原来各抄了一份逐字相同的
    // 代码，改一个字段漏一处就会「有的流程显示、有的流程不显示」。差异走参数。
    setReport(reportHtml(report, { next, spotted: 'only8' }));

    $('gRerack').classList.toggle('hidden', !next.requiresRerack);
    $('gAdvice').textContent = next.phase === 'ended' ? '这一局结束了。' : '—';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    clearOpponentMark();
    updateScore();
    updateLog();
    render();
    // 用户亲手打了这一杆 = 他已经接手这一局，撤销/读档留下的暂停到此为止。
    Object.assign(state, reduceAutoPause(state, 'user-shot'));
    updateAutoPauseBar();
    maybeOpponentTurn();
  });
}

// ---------------------------------------------------------------- 撤销

/**
 * 记一步快照。
 *
 * 必须在「结算前」记：resolveShot 不改入参（它返回新的 next），所以传进来的是
 * 打完这一杆之前的局面，正是撤销要回到的状态。
 */
/**
 * 记下这一杆求解时的容错角度，给「复盘这一局」挑「最大容错杆」用。
 *
 * 数据只来自求解器：`best.toleranceDeg` 是「这一杆能偏多少度还进」，
 * g.log 里的 summary 只有"进了/没进"的文字，解析不出角度。
 *
 * 手打（shootGameWith）与对手出杆都拿不到「按哪个袋算的容错」，那就干脆不记——
 * 宁可图上少一条，也不要拿一个猜出来的角度去冒充实测值。
 *
 * @param {number} shotNumber 这一杆的杆号（结算后 next.shots）
 * @param {object|null} candidate 求解器给的方案（plan / best）
 */
function recordTolerance(shotNumber, candidate) {
  if (!candidate || typeof candidate !== 'object') return;
  const shot = Math.floor(Number(shotNumber));
  const deg = Number(candidate.toleranceDeg);
  if (!Number.isFinite(shot) || shot <= 0) return;
  if (!Number.isFinite(deg) || deg <= 0) return;
  const entry = {
    shot,
    targetNumber: Number.isFinite(Number(candidate.targetNumber)) ? Number(candidate.targetNumber) : null,
    pocketId: typeof candidate.pocketId === 'string' ? candidate.pocketId : '',
    toleranceDeg: deg,
  };
  // 同一杆重复记（重打、回放回调跑两遍）只留最新的一份
  state.shotLog = state.shotLog.filter((e) => e && e.shot !== shot);
  state.shotLog.push(entry);
  // 长局不无限攒：最多留最近 200 杆，挑一条最大的够用了
  if (state.shotLog.length > 200) state.shotLog = state.shotLog.slice(-200);
}

function pushHistory(game) {
  pushHistoryEntry(state.history, game);
  updateUndoButton();
}

/**
 * 「读档 / 撤销之后，就等你点一下继续」这个状态。
 *
 * 这几种局面下自动出杆被暂停、原来那份方案也作废了：能做的只有一件事——点提示
 * 条上的「点此继续」。但界面上同时有「打这一杆」「求解」亮着（点了没反应）和 AI
 * 卡上那句「先点「求解」」，三条指引各说各的，谁也不知道该信哪条。这里把它算成
 * 一个明确的状态，让 syncGameGates 把别的入口关掉。
 */
function pendingResume() {
  const g = state.game;
  if (state.mode !== 'game' || !g || g.phase === 'ended') return false;
  if (!state.autoPaused) return false;
  return state.autoPauseReason === 'load' || state.autoPauseReason === 'undo';
}

/**
 * 「求解 / 打这一杆」两个按钮的可用性（撤销按钮在 updateUndoButton 里）。
 *
 * 只留一个下一步入口：能点的一定是现在该点的那一个，灰掉的都在 title 里说清
 * 为什么灰——用户原来遇到的正是「按钮可点但没反应」。
 */
function syncGameGates() {
  const g = state.game;
  const solve = $('gSolve');
  const shoot = $('gShoot');
  if (!solve || !shoot) return;

  let reason = '';
  if (!g) reason = '先点「新的一局」开一局。';
  else if (g.phase === 'ended') reason = '这一局已经结束了，点「新的一局」再打。';
  else if (state.animating) reason = '这一杆还在回放，演完才能操作。';
  else if (pendingResume()) reason = '先点提示条上的「点此继续」，再操作这一局。';
  else if (g.requiresRerack) reason = '上一杆开球不合法，先点「重摆开球」。';
  else if (g.ballInHand) reason = '先在台面上把母球摆好。';

  solve.disabled = Boolean(reason);
  solve.title = reason;
  // 「打这一杆」多一道门槛：没有方案就没得打（原来点了只会在卡片上写一句
  // 「先点「求解」」，看着像按钮坏了）。
  const shootReason =
    reason ||
    (!state.gSolution?.found ? '先点「求解」，再来打这一杆。' : '');
  shoot.disabled = Boolean(shootReason);
  shoot.title = shootReason;
}

function updateUndoButton() {
  const btn = $('gUndo');
  if (!btn) return;
  const n = state.history.length;
  const pending = pendingResume();
  btn.disabled = n === 0 || state.animating || pending;
  btn.textContent = undoLabel(n);
  // 灰掉的原因要说得出口：回放中（对手出杆也算）、等你点继续、和「没得撤」是
  // 三回事，只说「不能点」会让人以为撤销坏了。
  btn.title = state.animating
    ? '这一杆还在回放，演完才能撤销'
    : pending
      ? '先点提示条上的「点此继续」，再决定要不要撤销。'
      : n === 0
        ? '这一局还没有可以撤销的一杆。'
        : '';
}

function undoGame() {
  if (state.animating) {
    // 不许静默：回放还在往球数组里写帧，此刻撤销会被下一帧盖回去，
    // 用户看到的是「点了没反应」。说清楚什么时候能撤。
    setReport('这一杆还在回放（对手出杆也算），演完才能撤销——现在撤，下一秒的球位又会盖回来。');
    return;
  }
  const prev = state.history.pop();
  if (!prev) {
    setReport('已经退到这一局的起点了，没有更早的局面可退。');
    return;
  }
  state.game = prev;
  // 撤销 = 退回到第 prev.shots 杆的局面，比它更晚的容错记录已经不存在了
  if (Array.isArray(state.shotLog)) {
    const keep = Number(prev.shots) || 0;
    state.shotLog = state.shotLog.filter((e) => e && e.shot <= keep);
  }
  // 撤销是把局面整个换掉，和换局一样要让在途的回放/续杆定时器作废。
  state.generation += 1;
  state.gSolution = null;
  state.placing = Boolean(prev.ballInHand);
  canvas.classList.toggle('placing', state.placing);
  $('gRerack').classList.toggle('hidden', !prev.requiresRerack);
  setReport(`已撤销一步，回到第 ${prev.shots} 杆之后的局面。`);
  $('gAdvice').textContent = prev.phase === 'ended' ? '这一局结束了。' : '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '撤销后要重新「求解」，原来那份方案对应的是旧局面。';
  clearOpponentMark();
  updateScore();
  updateLog();
  updateUndoButton();
  render();
  // 撤销之后暂停自动出杆：用户刚退回来是要看清局面，1–2 秒后对手自己出杆
  // 会把刚恢复的球位又改掉——真机实测里这条最容易被当成「撤销没生效」。
  // 恢复只有三条路：自己打一杆、点提示条上的「点此继续」、重开一局。
  state.opponentThinking = false;
  Object.assign(state, reduceAutoPause(state, 'undo'));
  updateAutoPauseBar();
}

// ---------------------------------------------------------------- 对手回合

/**
 * 轮到对手时自动出杆。
 *
 * 用的是 src/opponent.js 的 takeTurn——和玩家点「求解 + 打这一杆」跑的是同一套
 * planShot / simulateShot / resolveShot，没有另一套"AI 简化版"。区别只在于
 * 它自己挑杆、自己摆母球，并且换完人之后不用等玩家点按钮。
 *
 * 连打要靠自己递归：对手打进就会继续是它的回合，所以 maybeOpponentTurn 在
 * 每杆结束后都会再问一次"还是对手吗"。
 */
function maybeOpponentTurn() {
  const g = state.game;
  // 「这一帧能不能让对手自己打」整条判断在 state.js 的 shouldAutoShoot 里：
  // 暂停态（撤销 / 读档之后）、开关、回合、动画都在那一条判完，好让单测能钉住
  // 「读档之后不许自己出杆」这种最容易被改坏的地方。
  if (!shouldAutoShoot(state)) return;
  if (g.requiresRerack) {
    setReport('对手开球不合法，需要重摆——点「重摆开球」继续。');
    $('gRerack').classList.remove('hidden');
    return;
  }
  state.opponentThinking = true;
  $('gAdvice').textContent = '对手在算这一杆……';
  $('gAdvice').className = 'empty';
  // 让出一帧，先把这个提示画上去，再开始算（求解是同步的，会卡住渲染）。
  // 这一帧里局面可能被换掉（新的一局、换台、撤销），所以带上一局的号。
  const gen = state.generation;
  requestAnimationFrame(() => {
    if (gen !== state.generation) return;
    runOpponentTurn(gen);
  });
}

function runOpponentTurn(gen = state.generation) {
  const g = state.game;
  if (!g || g.phase === 'ended' || state.animating) {
    state.opponentThinking = false;
    return;
  }
  const r = takeTurn(table, g, { record: true, dt: SEARCH_DT, safety: state.allowSafety });
  if (!r.ok) {
    state.opponentThinking = false;
    if (r.reason === 'needs_rerack') {
      setReport('对手开球不合法，需要重摆——点「重摆开球」继续。');
      $('gRerack').classList.remove('hidden');
      return;
    }
    setReport(`对手这一杆打不出来（${r.reason}）。`);
    $('gAdvice').textContent = '—';
    $('gAdvice').className = 'empty';
    return;
  }

  const placedNote = r.cuePlaced ? '（持球，自己摆了母球）' : '';
  const shotNote =
    r.kind === 'break'
      ? '开球'
      : r.kind === 'direct'
        ? '没有进攻机会，直接撞球'
        : r.kind === 'safety'
          ? '打防守'
          : describeCandidate(r.plan);
  setReport(`<b>对手</b>${placedNote}：${shotNote}<div>正在打……</div>`);
  $('gAdvice').textContent = '对手出杆中……';
  $('gAdvice').className = 'empty';
  // 对手自己出杆了：卡片上那份「对手方案」已经过期（而且它正按那份方案打）。
  clearOpponentMark();
  pushHistory(g);

  replay(r.facts.frames, r.facts.dt, () => {
    if (gen !== state.generation) return;
    state.game = r.next;
    recordTolerance(r.next.shots, r.plan);
    state.opponentThinking = false;
    state.placing = Boolean(r.next.ballInHand) && r.next.turn === 0;
    canvas.classList.toggle('placing', state.placing);

    // 三步选杆：让玩家看得见对手在想什么，而不是"它好像随便打了一杆"
    const chosen = r.scores?.[0];
    const tail = [];
    if (chosen) {
      // 算过第三层就用「对手回完我之后」剩下的容错，那才是真实的难度
      const tol = chosen.myToleranceDeg ?? chosen.opponentToleranceDeg;
      // 「容错 ±0.00°」对读者没有信息量，看上去像是数据坏了：那其实是「这杆留得
      // 几乎是必进球」，用一句人话说掉。
      const behind =
        Number.isFinite(tol) && tol < 0.005
          ? '打完留给你最好打的一杆：几乎必进（容错 <0.01°）'
          : `打完留给你最好打的一杆容错 ±${Number(tol).toFixed(2)}°`;
      tail.push(r.scores.length > 1 ? `在 ${r.scores.length} 个能进的方案里挑的：${behind}` : behind);
    }
    // 对手这一杆：前缀 + 只在轮到玩家时才写持球 + 末尾接选杆说明（见 reportHtml 的注释）
    setReport(
      reportHtml(r.report, {
        next: r.next,
        prefix: '<b>对手</b> · ',
        spotted: 'only8',
        ballInHandForPlayerOnly: true,
        tail,
      })
    );

    $('gRerack').classList.toggle('hidden', !r.next.requiresRerack);
    $('gVerdict').textContent = '';
    updateScore();
    updateLog();
    render();
    updateAutoPauseBar();

    if (r.next.phase === 'ended') {
      $('gAdvice').textContent = '这一局结束了。';
      $('gAdvice').className = 'empty';
      return;
    }
    if (r.next.turn === 1) {
      // 对手打进续杆：隔一下再出下一杆，否则看起来像瞬移。
      // 这 450 ms 里用户可能撤销、开新局、换台，所以醒来先认局号。
      $('gAdvice').textContent = '对手继续……';
      $('gAdvice').className = 'empty';
      setTimeout(() => {
        if (gen !== state.generation) return;
        maybeOpponentTurn();
      }, 450);
      return;
    }
    $('gAdvice').textContent = '轮到你了。点「求解」看怎么打。';
    $('gAdvice').className = 'empty';
  });
}

function doRerack() {
  const g = state.game;
  if (!g) return;
  const balls = createRack(g.kind ?? 'eightball', table, {
    seed: Math.floor(Math.random() * 1e6),
  }).map((b) => createBall(b.id, b.x, b.y, b));
  rerack(g, balls);
  state.gSolution = null;
  state.placing = false;
  canvas.classList.remove('placing');
  $('gRerack').classList.add('hidden');
  setReport(`已重摆，${esc(g.players[g.turn].name)}开球。`);
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  updateScore();
  updateLog();
  render();
  // 点「重摆开球」是用户主动接手，和手动出杆一样结束暂停。
  Object.assign(state, reduceAutoPause(state, 'resume'));
  updateAutoPauseBar();
  maybeOpponentTurn();
}

// ---------------------------------------------------------------- 手动出杆

/** 把滑块的值读进 state.manual。 */
function readManualControls() {
  const m = state.manual;
  m.speed = Number($('power').value);
  m.aimOffsetDeg = Number($('aimOffset').value);
  m.tipB = Number($('tipB').value);
  m.tipA = Number($('tipA').value);
  updateManualLabels();
}

function updateCueBallPad() {
  const dot = $('cueBallDot');
  if (!dot) return;
  const x = 50 + (state.manual.tipA / 0.5) * 38;
  const y = 50 - (state.manual.tipB / 0.5) * 38;
  dot.style.left = `${x}%`;
  dot.style.top = `${y}%`;
}

function updatePowerMeterUI(tier, speed) {
  const levelEl = $('powerMeterLevel');
  const pctEl = $('powerMeterPct');
  const speedEl = $('powerMeterSpeed');
  const fillEl = $('powerMeterFill');
  const handleEl = $('powerMeterHandle');

  if (levelEl) {
    levelEl.textContent = tier.level;
    levelEl.style.background = tier.badgeBg;
    levelEl.style.boxShadow = `0 2px 10px ${tier.glow}`;
  }
  if (pctEl) {
    pctEl.textContent = `${tier.pct}%`;
    pctEl.style.color = tier.color;
  }
  if (speedEl) {
    speedEl.textContent = `${speed.toFixed(2)} m/s`;
  }
  if (fillEl) {
    fillEl.style.height = `${tier.pct}%`;
    fillEl.style.boxShadow = `0 0 14px ${tier.glow}`;
  }
  if (handleEl) {
    handleEl.style.bottom = `${tier.pct}%`;
  }

  // 标亮当前档位芯片
  const chips = document.querySelectorAll('.power-chip, .power-meter-chip');
  chips.forEach((chip) => {
    const s = Number(chip.getAttribute('data-speed'));
    if (Math.abs(s - speed) < 0.25) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });
}

function updateManualLabels() {
  const m = state.manual;
  const tier = getPowerTier(m.speed);
  $('powerVal').textContent = `${m.speed.toFixed(2)} m/s · ${tier.level} ${tier.pct}%`;
  $('aimOffsetVal').textContent = `${m.aimOffsetDeg >= 0 ? '' : ''}${m.aimOffsetDeg.toFixed(2)}°`;
  $('tipBVal').textContent =
    Math.abs(m.tipB) < 0.03
      ? '中杆'
      : m.tipB > 0
        ? `高杆 +${m.tipB.toFixed(2)}`
        : `低杆 ${m.tipB.toFixed(2)}`;
  $('tipAVal').textContent =
    Math.abs(m.tipA) < 0.03
      ? '无塞'
      : m.tipA > 0
        ? `右塞 +${m.tipA.toFixed(2)}`
        : `左塞 ${m.tipA.toFixed(2)}`;
  updateCueBallPad();
  updatePowerMeterUI(tier, m.speed);
  state.manual.strokeOffset = tier.ratio * 0.12;
}

/** 把求解出的参数写进滑块。用户点「套用求解参数」时才调，不自动覆盖。 */
function applySolutionToManual() {
  const inGame = state.mode === 'game';
  const sol = inGame ? state.gSolution : state.solution;
  if (!sol?.found || !sol.best) {
    setAdvice('先求解，才有参数可以套用。', '');
    return;
  }
  const b = sol.best;
  // 滑条 step 是 0.01，这里也取两位：对齐格子，别让「套用」之后的数和建议值差一截。
  state.manual.speed = Math.round(clamp(b.speed, Number($('power').min), Number($('power').max)) * 100) / 100;
  state.manual.aimOffsetDeg = 0;
  state.manual.tipB = b.tip.b ?? 0;
  state.manual.tipA = b.tip.a ?? 0;
  state.manual.touched = true;
  $('power').value = state.manual.speed.toFixed(2);
  $('aimOffset').value = '0';
  $('tipB').value = String(state.manual.tipB);
  $('tipA').value = String(state.manual.tipA);
  updateManualLabels();
  if (inGame) {
    $('gAdvice').textContent = `已套用求解参数：${state.manual.speed.toFixed(2)} m/s · ${b.tip.name}。用滑块微调后再打。`;
    $('gAdvice').className = '';
  } else {
    setAdvice(`已套用求解参数：${state.manual.speed.toFixed(2)} m/s · ${b.tip.name}。用滑块微调后再打。`, '');
  }
}

/**
 * 用当前滑块参数打一杆（练习与球局共用）。
 *
 * 和「打这一杆」的区别只有一个：方向/力度/杆法来自滑块而不是求解结果。
 * 一旦这里改了参数，就没有"验证过一定进"的保证了——这正是手打的意义。
 */
function shootManual() {
  if (state.animating) return;
  readManualControls();
  const aim = currentAim(state);
  if (!aim) {
    if (state.mode === 'game') $('gAdvice').textContent = '台面上没有可以打的球。';
    else setAdvice('台面上没有可以打的球。', '');
    return;
  }
  const angle = aim.angle + (state.manual.aimOffsetDeg * Math.PI) / 180;
  const shot = {
    angle,
    speed: state.manual.speed,
    tip: { a: state.manual.tipA, b: state.manual.tipB },
  };

  if (state.mode === 'practice') shootPracticeWith(shot, aim);
  else shootGameWith(shot, aim);
}

/**
 * 拿这一杆的终局算一次「下一杆」，顺带记下花了多久。
 *
 * 两处刻意的地方：
 * 1. `extras: false` —— 组合球/翻袋那条路实测能吃到 60 ms 以上（求解器注释里写着），
 *    而这里只是回放结束的一句话，不值得为它多等。真需要组合球时文案会指向「求解」，
 *    那个按钮走的还是完整求解。
 * 2. 抛错不往外冒 —— 找不到母球之类的问题不该让一杆球的播报整个消失。
 */
function solveNextShot(balls) {
  const t0 = performance.now();
  try {
    return { candidates: solveShot(table, balls, { extras: false }), ms: performance.now() - t0 };
  } catch {
    return { candidates: null, ms: performance.now() - t0 };
  }
}

/** 练习模式：按给定的杆打，打完复位到原局面。 */
function shootPracticeWith(shot, aim) {
  const sim = simulateFrames(state.balls, table, shot, SEARCH_DT);
  if (!sim) return;
  // balls 是模拟那份副本的终局：手打结果描述要读它，和改动前读的是同一个数组。
  const { frames, dt, balls: copy } = sim;
  // 求解放在回放开始之前：它是同步的，等动画跑完再算，卡顿就正好落在文案该出现的
  // 那一刻。提前算完，慢也只是点下去那一下多一点延迟，回放本身不受影响。
  const next = solveNextShot(copy);
  const original = snapshotPositions(state.balls);
  replay(frames, dt, () => {
    const outcome = describeManualShot(copy);
    setAdvice(
      describeNextShot({
        outcome,
        balls: copy,
        candidates: next.candidates,
        table,
        // 练习局就三颗球，一杆清完就没什么可打的下文了：说「本局已结束」，
        // 别让用户以为台面深处还有球等着他。
        finished: numbersOnTable(copy).length === 0,
        aimFrom: aim.from,
        aimOffsetDeg: state.manual.aimOffsetDeg,
        touched: state.manual.touched,
        speed: state.manual.speed,
        tipBLabel: $('tipBVal').textContent,
        tipALabel: $('tipAVal').textContent,
        solveMs: next.ms,
      }),
      aim.from === 'solution' ? '方向取自求解结果 + 你调的偏移' : '方向直指最近的球（没有求解）'
    );
    restorePositions(state.balls, original);
    render();
  });
}

/** 球局模式：按给定的杆打，正常走规则结算。 */
function shootGameWith(shot, aim) {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  // 暂停态（撤销 / 读档之后）下允许玩家替对手打这一杆：那时对手不会自己动，
  // 拦下来只会像「按钮坏了」。
  if (state.autoOpponent && !state.autoPaused && g.turn === 1) return;
  if (g.requiresRerack) {
    $('gAdvice').textContent = '上一杆开球不合法，先点「重摆开球」。';
    return;
  }
  if (g.ballInHand) {
    $('gAdvice').textContent = '先把母球摆到台面上。';
    return;
  }
  const facts = simulateShot(table, g.balls, shot, { record: true, dt: SEARCH_DT });
  const { next, report } = resolveShot(g, facts);
  pushHistory(g);

  const gen = state.generation;
  replay(facts.frames, facts.dt, () => {
    if (gen !== state.generation) return;
    finishGameShot(next, report, gen);
  });
  void aim;
}

/** 一杆打完之后的界面收尾。玩家手打和求解打共这一份。 */
function finishGameShot(next, report, gen) {
  state.game = next;
  state.gSolution = null;
  state.placing = Boolean(next.ballInHand);
  canvas.classList.toggle('placing', state.placing);

  // 收尾这一杆：重摆提示按实际号码写「N 号球已重摆回底点」，并补一句待决事项
  setReport(reportHtml(report, { next, spotted: 'any', pendingChoiceHint: true }));

  $('gRerack').classList.toggle('hidden', !next.requiresRerack);
  // 待决事项只有轮到玩家时才让玩家选；轮到对手那它自己选（acceptTable，照打）。
  updateChoicePanel(next);
  $('gAdvice').textContent = next.phase === 'ended' ? '这一局结束了。' : '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  clearOpponentMark();
  updateScore();
  updateLog();
  updateUndoButton();
  render();
  // 玩家亲手打了一杆（手打或求解打）= 他已接手，撤销/读档留下的暂停到此为止。
  Object.assign(state, reduceAutoPause(state, 'user-shot'));
  updateAutoPauseBar();
  if (gen === state.generation) maybeOpponentTurn();
}

// ---------------------------------------------------------------- 存档

/**
 * Reg.16 的待决事项面板。
 *
 * 只有轮到玩家时才把选择权交给他；轮到对手时它自己选——按 WPA Reg.16(2)
 * 的第一选项「接受现状照打」，这是最不折腾的选择，也符合"对手不做复杂判断"的定位。
 * 自动选放在这里而不是 maybeOpponentTurn 里，是因为选择权在**接手方**，
 * 而面板渲染发生在每个结算之后，两处都能覆盖到。
 */
function updateChoicePanel(g) {
  const pending = g?.pendingChoice ?? null;
  if (!pending) {
    $('gChoice').classList.add('hidden');
    return;
  }
  if (pending.player === 1) {
    // 对手接手：直接照打，不留面板
    $('gChoice').classList.add('hidden');
    const next = acceptTable(g);
    state.game = next;
    setReport(`${esc(next.players[1].name)}选择照这样打。`);
    return;
  }
  $('gChoice').classList.remove('hidden');
}

/** 把当前球局写进 localStorage。 */
function saveGame() {
  const g = state.game;
  if (!g) {
    setReport('还没有开局，没有可存的。');
    return;
  }
  // 两个标签页各开一局的时候，后点的那个会把先存的静默盖掉——谁存的、
  // 存的是哪一局，全都没有痕迹。所以先看一眼存档还是不是自己认识的那份：
  // 不是的话先不写，把对方的进度说出来，让人自己决定要不要覆盖。
  //
  // 判定在 state.js 的 reduceSaveWrite（纯函数，单测钉着）：它比的是「写入方」
  // 而不是只看时间戳——新开的标签页从没见过任何存档，时间戳是 null，
  // 只比时间戳的话它第一次点存档就会被放行，正是线上丢档的那条路。
  const stored = readSaveMeta();
  const verdict = reduceSaveWrite(stored, {
    stamp: state.saveStamp,
    session: state.saveSession,
    overwrite: state.saveOverwrite,
  });
  if (!verdict.write) {
    const theirs = describeSave();
    state.saveOverwrite = true;
    setReport(
      (verdict.reason === 'other-tab'
        ? '这份存档是另一个标签页写的'
        : '存档已经被另一个标签页改过了') +
        `（那边存的是第 ${theirs?.shots ?? '?'} 杆），这一局没有覆盖它。` +
        '确认要覆盖的话，再点一次「存这一局」。'
    );
    refreshSaveInfo();
    return;
  }
  // 撤销栈一起存：不带它的话刷新页面之后「对局记录」和撤销按钮都是空的。
  const ok = writeSave(g, undefined, { history: state.history, session: state.saveSession });
  state.saveOverwrite = false;
  if (ok) {
    // 这份存档已经是「我见过的那个」了，按钮上没有待处理的东西。
    state.otherSaveShots = null;
    state.saveStamp = readSaveStamp();
    setReport(`已存档：第 ${g.shots} 杆，${g.balls.filter((b) => !b.pocketed && b.number !== 0).length} 颗目标球在台上。刷新页面后点「读取存档」能接着打。`);
    refreshSaveInfo();
  } else {
    // 「存储打不开」和「写得进但满了」得分开说：前者换窗口才有用，后者删旧档就有地方。
    setReport(
      saveFailureKind() === 'quota'
        ? '存不了——本地存储的配额满了，这一局没有写进去。点下面「删除存档」清掉旧的那份腾出空间，再存一次。'
        : '存不了——浏览器禁用了本地存储（隐私模式、或站点被设成不保存数据）。换个普通窗口打开这一页再存。'
    );
  }
}

/** 从 localStorage 读回一局。 */
function loadGame() {
  // 读档走 loadSave 而不是 readSave：整档被判损坏时它会真的把那份坏档删掉，
  // 下面的文案才配得上说「已删除」。只读的 readSave 留给 describeSave 之类。
  const { status, saved, discarded } = loadSave();
  if (!saved) {
    if (status === 'corrupt') {
      // 删档失败（隐私模式 / 存储只读）时不许说「已删除」：文案必须和实际发生的事一致。
      setReport(
        discarded
          ? '存档已损坏（读不出合法局面），已从本地存储删除。'
          : '存档已损坏（读不出合法局面），本次没有加载；本地存储删不掉，它还会在。',
      );
      // 坏档留着的另一个后果：界面上的「存档：…」摘要也得跟着消失/保持诚实。
      refreshSaveInfo();
      return;
    }
    if (status === 'newer') {
      setReport('存档来自更新的版本，这个版本读不了；没有动它，换回新版页面还能接着打。');
      refreshSaveInfo();
      return;
    }
    setReport('没有可用的存档。');
    refreshSaveInfo();
    return;
  }
  applyLoadedGame(saved);
  // 这一档是用户亲手接过来接着打的：认下它的写入方。之后再点存档属于「存自己
  // 手里这局」，不该因为「档是别的标签页写的」再问一遍。
  state.saveSession = readSaveMeta()?.session ?? TAB_SESSION;
}

/**
 * 把一份已经校验过的存档装进当前局面。localStorage 读回来的和从文件导入的
 * 都走这里，免得两条路各自演变、其中一条慢慢坏掉。
 */
function applyLoadedGame(saved) {
  if (saved.table.id !== table.preset) {
    // 存档的坐标是按那张台算的，换台之后直接装进来会全部越界。
    const okTable = TABLE_PRESETS[saved.table.id];
    if (!okTable) {
      setReport(`存档用的球台（${saved.table.id}）这个版本不认识，读不了。`);
      return;
    }
    setTablePreset(saved.table.id);
  }
  const balls = saved.balls.map((b) => createBall(b.id, b.x, b.y, b));
  // 玩法要一起装回去：存档里是九球就必须按九球重建，否则 createGame 会给
  // 一份黑八规则（能分组、先碰哪颗都行），一局九球立刻变成非法局面。
  const g = createGame(table, balls, { names: saved.players.map((p) => p.name), kind: saved.kind });
  state.gameKind = g.kind;
  $('gameKind').value = g.kind;
  // createGame 给的是开局态，把存档里的进程态逐项装回去（字段清单在 state.js，
  // 那边能在 Node 里单测「漏装哪一项就变回开局」）。
  restoreGameState(g, saved);

  state.generation += 1;
  state.game = g;
  // 读回来的是一份「已经结束」的存档时，这一局早就记过账了：把局号记成已记账，
  // 免得下面 updateLog 又往战绩里补一条重复的。
  matchedGeneration = state.generation;
  state.gSolution = null;
  state.animating = false;
  state.opponentThinking = false;
  state.placing = Boolean(g.ballInHand);
  canvas.classList.toggle('placing', state.placing);
  // 杆史（撤销栈）一起读回来：不进内存的话读档后「对局记录」是空的、撤销按钮
  // 是灰的，看着就像读档只成功了一半（真机实测报的就是这条）。
  // 老存档没有 history 字段：unpackHistory 返回空，走下面的 missing 分支给提示。
  const decoded = unpackHistory(saved.history, g);
  state.history = decoded.entries;
  // 容错角度不随存档走（见 state.shotLog 的注释）：读档后杆号是别人的历史，
  // 留着上一份记录只会让「第 N 杆」指向另一杆，直接清空。
  state.shotLog = [];
  // 存档只带最近几步，更早的是真丢了：d 是存档自己记的（超预算裁掉的），
  // shots - 读到的步数 补上「存档里压根没装」的那部分，两个取大。
  const missing = Math.max(decoded.dropped, saved.shots - decoded.entries.length);
  state.historyNote = missing > 0 ? `更早的 ${missing} 步未随存档保存` : null;
  state.saveStamp = saved.savedAt;
  state.saveOverwrite = false;
  // 读档之后先停住自动出杆：1–2 秒后对手自己又打一杆会把刚恢复的球位改掉，
  // 用户只会看到「读档没成功」。恢复要他自己出手或点提示条。
  Object.assign(state, reduceAutoPause(state, 'load'));
  updateUndoButton();
  $('gRerack').classList.toggle('hidden', !g.requiresRerack);
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  clearOpponentMark();
  setReport(`已读取存档：第 ${g.shots} 杆，轮到「${esc(g.players[g.turn].name)}」。`);
  if (state.mode !== 'game') setMode('game');
  updateScore();
  updateLog();
  render();
  updateAutoPauseBar();
  maybeOpponentTurn();
}

function removeSave() {
  const ok = clearSave();
  state.saveStamp = null;
  state.saveSession = TAB_SESSION;
  state.saveOverwrite = false;
  setReport(ok ? '存档已删除。' : '删不了——浏览器禁用了本地存储。');
  refreshSaveInfo();
}

/**
 * 把当前这一局压成文件内容。导出按钮与端到端脚本走同一条路。
 * 没有局面时返回 null。
 */
function exportGameText(now = Date.now()) {
  const g = state.game;
  if (!g) return null;
  return JSON.stringify(serialize(g, now, state.history), null, 2);
}

/**
 * 从文件文本恢复一局。校验全部交给 save.js 的 sanitize：球台认不出、球位
 * 越界、玩法不认识的都整份丢掉，不会把半份脏数据装到台面上。
 * 返回 { ok, reason }，界面据此说人话。
 */
function importGameText(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: '这个文件不是 JSON，可能选错了。' };
  }
  const saved = sanitize(raw);
  if (!saved) {
    return {
      ok: false,
      reason: '这份存档用不了：球台或玩法认不出来，或者球位跑出台了面。为了不把台面弄乱，整份丢掉了。',
    };
  }
  applyLoadedGame(saved);
  return { ok: true, reason: '' };
}

function downloadText(filename, text, mime = 'application/json') {
  let url;
  try {
    url = URL.createObjectURL(new Blob([text], { type: mime }));
  } catch {
    return false;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// ---------------------------------------------------------------- 分享这一杆
//
// 把当前这一杆画成一张手机能看清的 PNG：上半是台面俯视图（球位 + 目标球到袋口
// 的线 + 母球预计落点），下半是这次解法的文字。
//
// 走 canvas.toBlob + URL.createObjectURL，**不转 data: URL**：1080 宽的 PNG 常在
// 几百 KB 量级，base64 再撑三分之一纯属白给；而 index.html 的 CSP 里
// img-src 本来就写了 blob:，一条 CSP 都不用改。
//
// 出图不直接下载，先摆进 <img> 预览：人要的是「发给别人」，手机上长按预览图就能
// 存相册；桌面端右下角再给一条带 download 的链接。一次点击把两条路都铺好，
// 比「点完静默下载、用户去下载栏里找」强。

const SHARE_WIDTH = 1080; // 成品图固定 1080 宽：手机缩到 370 也清楚
const SHARE_PAD = 48;
const SHARE_FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const SHARE_TITLE_FONT = `700 46px ${SHARE_FONT}`;
const SHARE_META_FONT = `500 26px ${SHARE_FONT}`;
const SHARE_LABEL_FONT = `600 30px ${SHARE_FONT}`;
const SHARE_VALUE_FONT = `500 30px ${SHARE_FONT}`;
const SHARE_FOOT_FONT = `500 22px ${SHARE_FONT}`;
const SHARE_TITLE_H = 58;
const SHARE_META_H = 34;
const SHARE_LINE_H = 44; // 一行值的高度（30px 字 + 行距）
const SHARE_ROW_GAP = 24; // 行与行之间的空白
const SHARE_LABEL_COL = 156; // 「字段名」那一列的宽度
const SHARE_BG = '#0b1219';
const SHARE_TEXT = '#e8f0f7';
const SHARE_MUTED = '#93a4b5';

// 整局复盘图里那条比分走势。和台面图一样，只在这里定尺寸与颜色：
// state.js 的 buildMatchSummary 给的是 `[{x, y1, y2}]` 纯数据，连颜色都不知道。
const SHARE_CHART_H = 300;
const SHARE_CHART_GAP = 34;
const SHARE_CHART_BG = 'rgba(148, 163, 184, 0.08)';
const SHARE_CHART_GRID = 'rgba(147, 164, 181, 0.28)';
const SHARE_CHART_FONT = `500 24px ${SHARE_FONT}`;
const SHARE_CHART_TICK_FONT = `500 22px ${SHARE_FONT}`;
const SHARE_CHART_SERIES = [
  { key: 'y1', label: '我', color: '#38bdf8' },
  { key: 'y2', label: '对手', color: '#f59e0b' },
];

/** 已经生成过的那张图：blob URL 得自己撤销，否则连点几次会一直占着内存。 */
const shareState = { url: '', filename: '' };

/**
 * 分享图的文件名：`billiards-shot-…` / `billiards-table-…`。
 * 两种导出各用一个前缀，下载到同一个文件夹里不会互相盖掉。
 */
function shareFileName(prefix = 'shot') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `billiards-${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
}

/** 这一杆换了（重新求解 / 重置），旧图就不再代表当前局面，收起来别再骗人。 */
function invalidateShare() {
  if (shareState.url) {
    URL.revokeObjectURL(shareState.url);
    shareState.url = '';
  }
  shareState.filename = '';
  const out = $('shareOut');
  if (out) out.classList.add('hidden');
  const img = $('shareImage');
  if (img) img.removeAttribute('src');
  const hint = $('shareHint');
  if (hint) hint.textContent = '生成一张图，发给练球的人。';
}

/**
 * 按字符折行。中文没有词边界，逐字量宽度是最稳的一种；数字和英文会被拆开，
 * 但这些字段里最长的是「容错」那句中文，拆不拆无所谓。
 */
function wrapShareText(ctx, text, maxWidth) {
  const chars = Array.from(String(text ?? ''));
  if (!chars.length) return [''];
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const next = line + ch;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = ch;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * 画比分走势：两条累计进球折线，横轴杆号、纵轴进球数。
 *
 * 数据是 buildMatchSummary 给的 `[{x, y1, y2}]`，这里只负责坐标与颜色。
 * 背景与网格用低对比度，别把台面图和下面的文字压住。
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<{x:number, y1:number, y2:number}>} chart 至少两个点
 * @param {number} x 左上角
 * @param {number} y 左上角
 * @param {number} width
 * @param {number} height
 */
function drawShareChart(ctx, chart, x, y, width, height) {
  ctx.save();
  ctx.textBaseline = 'top';

  ctx.fillStyle = SHARE_CHART_BG;
  ctx.fillRect(x, y, width, height);

  // 标题 + 图例（右对齐，从右往左排）
  ctx.font = SHARE_CHART_FONT;
  ctx.fillStyle = SHARE_MUTED;
  ctx.textAlign = 'left';
  ctx.fillText('比分走势（累计进球）', x + 24, y + 18);
  let legendRight = x + width - 24;
  for (const s of [...SHARE_CHART_SERIES].reverse()) {
    ctx.textAlign = 'right';
    ctx.fillStyle = SHARE_MUTED;
    ctx.fillText(s.label, legendRight, y + 19);
    const labelW = ctx.measureText(s.label).width;
    ctx.fillStyle = s.color;
    ctx.fillRect(legendRight - labelW - 22, y + 23, 14, 14);
    legendRight -= labelW + 44;
  }

  const plotX = x + 64;
  const plotY = y + 64;
  const plotW = width - 64 - 28;
  const plotH = height - 64 - 42;
  let maxY = 1;
  for (const p of chart) maxY = Math.max(maxY, p.y1, p.y2);
  maxY = Math.ceil(maxY);
  const minX = chart[0].x;
  const maxX = chart[chart.length - 1].x;
  const spanX = Math.max(1, maxX - minX);
  const px = (v) => plotX + ((v - minX) / spanX) * plotW;
  const py = (v) => plotY + plotH - (v / maxY) * plotH;

  // 横向网格：小比分时每分一条（0/1/2…），大比分时只留 0 / 中点 / 满格。
  // 一律标整数——之前用 maxY/2 取整，1 分的局会印出「1、1、0」两条一样的刻度。
  ctx.font = SHARE_CHART_TICK_FONT;
  ctx.strokeStyle = SHARE_CHART_GRID;
  ctx.lineWidth = 1;
  const ticks = maxY <= 4 ? Array.from({ length: maxY + 1 }, (_, i) => i) : [0, Math.round(maxY / 2), maxY];
  for (const t of ticks) {
    const ty = Math.round(py(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(plotX, ty);
    ctx.lineTo(plotX + plotW, ty);
    ctx.stroke();
    ctx.fillStyle = SHARE_MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(String(t), plotX - 14, ty - 12);
  }

  // 横轴：只标首尾两个杆号，中间留白（60 个点全标会糊）
  ctx.textAlign = 'left';
  ctx.fillStyle = SHARE_MUTED;
  ctx.fillText(`第 ${minX} 杆`, plotX, plotY + plotH + 12);
  ctx.textAlign = 'right';
  ctx.fillText(`第 ${maxX} 杆`, plotX + plotW, plotY + plotH + 12);

  // 两条折线
  for (const s of SHARE_CHART_SERIES) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    chart.forEach((p, i) => {
      const cx = px(p.x);
      const cy = py(p[s.key]);
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    });
    ctx.stroke();
    // 点少的时候补圆点，读得出「哪一杆进的」
    if (chart.length <= 20) {
      ctx.fillStyle = s.color;
      for (const p of chart) {
        ctx.beginPath();
        ctx.arc(px(p.x), py(p[s.key]), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.restore();
}

/**
 * 合成成品图：标题 + 小字 + 台面图 + 若干「字段 / 值」行 + 页脚。
 *
 * 「分享这一杆」和「分享局面」**只共用这一份排版**：两者只有 summary 的来源不同，
 * 图的宽度、字号、行距、贴图位置必须一模一样，否则同一批图发出去像两个产品。
 * 高度由文案行数决定——先量后画，两遍用的是同一套字体常量，
 * 所以量出来的结论和画出来的位置一致。
 *
 * 第三个使用者是「复盘这一局」：它多带一个 chart（纯数据），这里多画一块折线。
 * 三段仍然共用同一份排版，不许另起一套。
 *
 * @param {{scene:object|null, summary:{title:string, lines:Array<{label:string, value:string}>, chart?:Array<{x:number,y1:number,y2:number}>}, meta:string}} input
 *   scene    createShareScene() 的结果；null 就只出文案（不留白）
 *   summary  文案：标题 + 若干行（行数、长短都不限）；chart 有就多画一块走势
 *   meta     标题下面那行小字：球台 + 时间
 * @returns {HTMLCanvasElement} 1080 宽、高度自适应的成品 canvas
 */
function buildShareSheet({ scene, summary, meta }) {
  const measure = document.createElement('canvas').getContext('2d');
  const bodyWidth = SHARE_WIDTH - SHARE_PAD * 2 - SHARE_LABEL_COL;
  const rows = summary.lines.map((row) => {
    measure.font = SHARE_VALUE_FONT;
    return { label: row.label, chunks: wrapShareText(measure, row.value, bodyWidth) };
  });
  const rowsH = rows.reduce((sum, r) => sum + r.chunks.length * SHARE_LINE_H + SHARE_ROW_GAP, 0);
  const sceneH = scene ? scene.height : 0;
  const chart = Array.isArray(summary.chart)
    ? summary.chart.filter((p) => p && typeof p === 'object')
    : [];
  const chartH = chart.length >= 2 ? SHARE_CHART_H : 0;
  const height = Math.round(
    SHARE_PAD +
      SHARE_TITLE_H +
      SHARE_META_H +
      18 +
      sceneH +
      (scene ? 34 : 0) +
      chartH +
      (chartH ? SHARE_CHART_GAP : 0) +
      rowsH +
      40 +
      SHARE_PAD,
  );

  const out = document.createElement('canvas');
  out.width = SHARE_WIDTH;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.fillStyle = SHARE_BG;
  ctx.fillRect(0, 0, out.width, out.height);

  let y = SHARE_PAD;
  ctx.fillStyle = SHARE_TEXT;
  ctx.font = SHARE_TITLE_FONT;
  ctx.fillText(summary.title, SHARE_PAD, y);
  y += SHARE_TITLE_H;

  ctx.fillStyle = SHARE_MUTED;
  ctx.font = SHARE_META_FONT;
  ctx.fillText(meta, SHARE_PAD, y);
  y += SHARE_META_H + 18;

  if (scene) {
    // 台面图自带木框与袋口，直接贴上去；边角是透明的，不会盖住深色底
    ctx.drawImage(
      scene.canvas,
      0,
      0,
      scene.canvas.width,
      scene.canvas.height,
      SHARE_PAD,
      y,
      scene.width,
      sceneH,
    );
    y += sceneH + 34;
  }

  if (chartH) {
    drawShareChart(ctx, chart, SHARE_PAD, y, SHARE_WIDTH - SHARE_PAD * 2, chartH);
    y += chartH + SHARE_CHART_GAP;
  }

  for (const row of rows) {
    ctx.fillStyle = SHARE_MUTED;
    ctx.font = SHARE_LABEL_FONT;
    ctx.fillText(row.label, SHARE_PAD, y + 2);
    ctx.fillStyle = SHARE_TEXT;
    ctx.font = SHARE_VALUE_FONT;
    row.chunks.forEach((chunk, i) => {
      ctx.fillText(chunk, SHARE_PAD + SHARE_LABEL_COL, y + i * SHARE_LINE_H);
    });
    y += row.chunks.length * SHARE_LINE_H + SHARE_ROW_GAP;
  }

  ctx.fillStyle = SHARE_MUTED;
  ctx.font = SHARE_FOOT_FONT;
  ctx.fillText('AI 台球教练 · 长按图片可保存', SHARE_PAD, y + 6);

  return out;
}

/** 图里那行小字：球台 + 生成时间。两种导出共用。 */
function shareMetaText() {
  const board = TABLE_PRESETS[table.preset]?.label ?? '台面';
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${board} · ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「分享这一杆」那张图：台面带这一杆的辅助线，下面是这一杆怎么打。 */
function buildShotSheet() {
  const card = state.solution;
  if (!card) return null;
  const summary = buildShareSummary({ shot: card, table, balls: state.balls });
  const scene = createShareScene({
    table,
    balls: state.balls,
    shot: card.found ? card.best : null,
    maxWidth: SHARE_WIDTH - SHARE_PAD * 2,
  });
  return {
    canvas: buildShareSheet({ scene, summary, meta: shareMetaText() }),
    title: summary.title,
    alt: `这一杆：${summary.title}`,
    prefix: 'shot',
  };
}

/**
 * 「分享局面」那张图：整台俯视图（所有球 + 球号 + 母球标记 + 当前该打的球圈起来），
 * 下面是玩法 / 轮到谁 / 比分 / 各组剩几颗 / 下一步怎么打。
 *
 * 局面来自哪里只看当前模式：对局模式印比分，练习模式印「练习台面剩几颗」。
 * 两者走的是同一个 buildTableSummary，所以图上和界面上不会各说各话。
 */
function buildTableSheet() {
  const game = state.mode === 'game' ? state.game : null;
  const balls = game ? game.balls : state.balls;
  const list = Array.isArray(balls) ? balls.filter((b) => b && typeof b === 'object') : [];
  if (!list.length) return null;
  const summary = buildTableSummary({
    game,
    balls: list,
    table,
    shot: game ? state.gSolution : state.solution,
  });
  // 局面图不画某一杆的辅助线（那是「这一杆」的活），只圈出当前该打的那一组
  const scene = createShareScene({
    table,
    balls: list,
    mark: summary.mark,
    maxWidth: SHARE_WIDTH - SHARE_PAD * 2,
  });
  return {
    canvas: buildShareSheet({ scene, summary, meta: shareMetaText() }),
    title: summary.title,
    alt: `局面：${summary.title}`,
    prefix: 'table',
  };
}

/**
 * 「复盘这一局」那张图：终局台面 + 比分走势 + 关键杆与统计。
 *
 * 管线一步都没另起：台面图还是 createShareScene，排版还是 buildShareSheet，
 * 出图收尾还是 publishShare / exportShare。和另外两张唯一的不同是 summary 里
 * 多一个 `chart`（纯数据，`[{x, y1, y2}]`），由 buildShareSheet 多画一块折线。
 *
 * 局没结束（buildMatchSummary 返回 null）就返回 null，按钮那边会提前禁用，
 * 不会出现一张「0 : 0 的复盘」。
 */
function buildMatchSheet() {
  const game = state.mode === 'game' ? state.game : null;
  if (!game) return null;
  const summary = currentMatchSummary();
  if (!summary) return null;
  const list = Array.isArray(game.balls) ? game.balls.filter((b) => b && typeof b === 'object') : [];
  if (!list.length) return null;
  const scene = createShareScene({ table, balls: list, maxWidth: SHARE_WIDTH - SHARE_PAD * 2 });
  return {
    canvas: buildShareSheet({ scene, summary, meta: shareMetaText() }),
    title: summary.title,
    alt: `复盘：${summary.title}`,
    prefix: 'match',
  };
}

/**
 * 两种导出共用的收尾：canvas → blob → 预览图 / 下载链接 / 新标签打开。
 *
 * 预览只留一份（#shareOut），所以生成新图前必须先撤掉上一张的 blob URL：
 * 不撤就连点几次一直占着内存，而且旧 URL 还挂在下载链接上。
 *
 * @returns {Promise<{url:string, filename:string, bytes:number, width:number, height:number}|null>}
 *   null 表示浏览器没能把 canvas 转成 PNG
 */
async function publishShare({ canvas, alt, prefix }) {
  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
  if (!blob) return null;
  if (shareState.url) URL.revokeObjectURL(shareState.url);
  const url = URL.createObjectURL(blob);
  const filename = shareFileName(prefix);
  shareState.url = url;
  shareState.filename = filename;

  const img = $('shareImage');
  img.alt = alt;
  img.src = url;
  $('sharePreview').href = url;
  $('shareOpen').href = url;
  const download = $('shareDownload');
  download.href = url;
  download.download = filename;
  $('shareOut').classList.remove('hidden');

  // 等解码完再返回：调用方（和 E2E）拿到结果时 naturalWidth 已经是真值
  try {
    await img.decode();
  } catch {
    // 解码失败就让 <img> 自己显示破图，提示照常给
  }
  return { url, filename, bytes: blob.size, width: canvas.width, height: canvas.height };
}

/**
 * 两个分享按钮共用的外壳：出图 → 收尾 → 回报结果。
 *
 * 返回结构化结果而不是只改 DOM，是为了让 E2E 能直接问「图有多大、多少字节」，
 * 不必去猜界面上的文案。任何一步失败都只写提示，不抛——按钮上炸掉比没有图更糟。
 *
 * @param {{buttonId:string, blockedReason:string, blockedHint:string,
 *          build:()=>{canvas:HTMLCanvasElement, title:string, alt:string, prefix:string}|null}} opts
 *   build 返回 null 表示「现在没东西可导」，此时只改提示、不碰预览区
 */
async function exportShare({ buttonId, blockedReason, blockedHint, build }) {
  const button = $(buttonId);
  const hint = $('shareHint');
  let job = null;
  try {
    job = build();
  } catch {
    job = null;
  }
  if (!job) {
    if (hint) hint.textContent = blockedHint;
    return { ok: false, reason: blockedReason };
  }
  if (button) button.disabled = true;
  if (hint) hint.textContent = '正在生成…';
  try {
    const out = await publishShare(job);
    if (!out) {
      if (hint) hint.textContent = '这张图没生成出来，换个浏览器或重试一次。';
      return { ok: false, reason: 'no-blob' };
    }
    if (hint) hint.textContent = `${out.width}×${out.height} PNG · ${Math.round(out.bytes / 1024)} KB`;
    return {
      ok: true,
      width: out.width,
      height: out.height,
      bytes: out.bytes,
      url: out.url,
      filename: out.filename,
      title: job.title,
    };
  } catch (err) {
    if (hint) hint.textContent = '生成失败：这个浏览器画不出导出图。';
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (button) button.disabled = false;
  }
}

/** 「分享这一杆」：先有解，再出图。没有解就只提示，别让人对着空图猜。 */
async function shareShot() {
  return exportShare({
    buttonId: 'shareShot',
    blockedReason: 'no-solution',
    blockedHint: '先点「求解最佳方案」，再把这一杆分享出去。',
    build: buildShotSheet,
  });
}

/** 「分享局面」：不需要求解也能导——局面本身就有内容可看。 */
async function shareTable() {
  return exportShare({
    buttonId: 'shareTable',
    blockedReason: 'no-table',
    blockedHint: '台面上还没有球，先摆球或开一局。',
    build: buildTableSheet,
  });
}

/**
 * 「复盘这一局」：只在局已结束、且 buildMatchSummary 真能给出复盘时可用。
 *
 * 禁用理由要写在按钮 title 上，别只把按钮灰掉——灰按钮不解释，用户会以为功能坏了。
 */
function currentMatchSummary() {
  const game = state.mode === 'game' ? state.game : null;
  if (!game) return null;
  const log = Array.isArray(game.log) ? game.log : [];
  return buildMatchSummary({
    game,
    log,
    // 和页面上那块复盘面板吃同一份统计，图上与界面上不会各说各话
    stats: computeMatchStats({
      log,
      kind: game.kind,
      winner: game.phase === 'ended' ? game.winner : null,
      myself: 0,
    }),
    table,
    // 每杆求解时记下的容错角度（只在内存里），没有就不印「最大容错杆」
    shots: state.shotLog,
  });
}

function matchShareBlockedReason() {
  const game = state.mode === 'game' ? state.game : null;
  if (!game) return '先开一局球，打完才能复盘。';
  if (game.phase !== 'ended') return '本局还没结束，打完这一局才能导出复盘。';
  return '';
}

/** 按钮可用性跟着局面走：每次结算、换局、换模式、读档之后都刷一遍。 */
function updateShareMatchButton() {
  const btn = $('shareMatch');
  if (!btn) return;
  // 能不能出图由纯函数说了算，按钮不自己另判一遍：否则「按钮亮着、点了没图」迟早发生。
  const why = matchShareBlockedReason() || (currentMatchSummary() ? '' : '这一局没有可复盘的内容。');
  btn.disabled = Boolean(why);
  btn.title = why || '把这一局的终局台面、比分走势和关键杆导成一张图';
}

async function shareMatch() {
  return exportShare({
    buttonId: 'shareMatch',
    blockedReason: 'no-match',
    blockedHint: matchShareBlockedReason() || '这一局还没有可以复盘的内容。',
    build: buildMatchSheet,
  }).finally(updateShareMatchButton);
}

function exportGameSave() {
  const text = exportGameText();
  if (!text) {
    setReport('还没有开局，没有可导出的。');
    return;
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `billiards-game-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  if (!downloadText(name, text)) {
    setReport('导出失败：浏览器没法创建下载文件。');
    return;
  }
  setReport(`已导出 ${name}（第 ${state.game.shots} 杆）。换设备后用「从文件读取」能接着打。`);
}

function importGameSaveFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const result = importGameText(String(reader.result ?? ''));
    if (result.ok) {
      setReport(`已从文件读入：第 ${state.game.shots} 杆，轮到「${esc(state.game.players[state.game.turn].name)}」。`);
    } else {
      setReport(result.reason);
    }
  };
  reader.onerror = () => setReport('读取文件失败，可能没有权限或文件已被移动。');
  reader.readAsText(file);
}

/**
 * 撤销刚才那一条实战记录。
 *
 * 点错「打进 / 没进」不必清空整本记录，也不必导出 JSON 手改。
 * 撤销后把 practiceRecorded 放回 false，状态行重新提示「可以直接记下一杆」。
 */
function undoLastPracticeRecord() {
  const before = readPracticeLog().length;
  if (!popLastPracticeResult()) {
    updatePracticeFeedback('没有可撤销的记录。');
    return false;
  }
  state.practiceRecorded = false;
  updatePracticeLog();
  updatePracticeFeedback(`已撤销刚才那条记录（${before} → ${before - 1} 条）。`);
  return true;
}

function removePracticeLog() {
  if (!window.confirm('确定清空本机保存的实战练习记录吗？')) return;
  const ok = clearPracticeLog();
  if (ok) {
    updatePracticeLog();
    updatePracticeFeedback('实战记录已清空。');
  } else {
    updatePracticeFeedback('记录未能清空；请检查浏览器是否允许本地存储。');
  }
}

function exportPracticeRecords() {
  const records = readPracticeLog();
  if (!records.length) {
    updatePracticeFeedback('暂无可导出的实战练习记录。');
    return;
  }

  let downloadUrl;
  try {
    const blob = new Blob([exportPracticeCsv(records)], { type: 'text/csv;charset=utf-8' });
    downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    link.download = `台球练习记录-${date}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    updatePracticeFeedback(`已导出 ${records.length} 条练习记录。`);
  } catch (error) {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    updatePracticeFeedback(`导出失败：${error.message || '浏览器无法创建下载文件。'}`);
  }
}

function downloadPracticeBackup() {
  const records = readPracticeLog();
  let downloadUrl;
  try {
    const blob = new Blob(
      [exportPracticeBackup(records)],
      { type: 'application/json;charset=utf-8' }
    );
    downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    link.href = downloadUrl;
    link.download = `台球练习备份-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    updatePracticeFeedback(`已备份 ${records.length} 条练习记录。`);
  } catch (error) {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    updatePracticeFeedback(`备份失败：${error.message || '浏览器无法创建下载文件。'}`);
  }
}

async function restorePracticeBackup(file) {
  if (!file) return;
  if (file.size > MAX_BACKUP_BYTES) {
    updatePracticeFeedback('备份文件超过 1 MB，已拒绝导入。');
    return;
  }
  try {
    const records = parsePracticeBackup(await file.text());
    if (!records) {
      updatePracticeFeedback('备份文件无效或包含不支持的数据；现有记录未更改。');
      return;
    }
    if (!window.confirm(`将用备份中的 ${records.length} 条记录替换当前记录，是否继续？`)) {
      updatePracticeFeedback('已取消恢复，现有记录未更改。');
      return;
    }
    if (!replacePracticeLog(records)) {
      updatePracticeFeedback('恢复失败；浏览器未能保存备份，现有记录未更改。');
      return;
    }
    updatePracticeLog();
    updatePracticeFeedback(`已恢复 ${records.length} 条练习记录。`);
  } catch (error) {
    updatePracticeFeedback(`读取备份失败：${error.message || '无法读取所选文件。'}`);
  }
}

function refreshSaveInfo() {
  const info = describeSave();
  const box = $('saveInfo');
  if (!box) return;
  if (!info) {
    box.textContent = '还没有存档。存的是局面本身（球位、分组、杆数、轮到谁），刷新页面之后还能接着打。';
    return;
  }
  const who = info.turn === 0 ? '你' : '对手';
  const takeBtn = $('takeOtherSave');
  if (takeBtn) {
    const pending = state.otherSaveShots;
    takeBtn.classList.toggle('hidden', pending === null);
    takeBtn.textContent = pending === null ? '读入另一个标签页存的' : `读入另一个标签页存的（第 ${pending} 杆）`;
  }
  box.textContent = info.ended
    ? `存档：${info.tableId} · 第 ${info.shots} 杆 · 这一局已经结束（${who}赢）`
    : `存档：${info.tableId} · 第 ${info.shots} 杆 · ${info.onTable} 颗目标球在台上 · 轮到${who}`;
}

// ---------------------------------------------------------------- 模式切换

function setMode(mode) {
  // 切模式下面的 animating = false 会立刻放行「求解 / 打这一杆」按钮，
  // 所以在途回放的 tick 必须靠代次自己认出来过期，否则会和新的动画抢同一个球数组。
  state.generation += 1;
  state.mode = mode;
  state.solution = null;
  state.gSolution = null;
  state.animating = false;
  updatePracticeFeedback();
  $('tabPractice').classList.toggle('on', mode === 'practice');
  $('tabGame').classList.toggle('on', mode === 'game');
  $('practicePanel').classList.toggle('hidden', mode !== 'practice');
  $('gamePanel').classList.toggle('hidden', mode !== 'game');
  $('subtitle').textContent =
    mode === 'practice'
      ? '拖动任意球改摆位 · 求解后给出瞄准线、容错窗口与力度'
      : '标准黑八 15 颗 + 母球 · 按 WPA 规则判分组、犯规与胜负';
  if (mode === 'game' && !state.game) newGame();
  // 复盘按钮的可用性跟模式走：练习模式里没有「这一局」，必须先灰掉
  updateShareMatchButton();
  render();
  updateAutoPauseBar();
  if (mode === 'game') maybeOpponentTurn();
}

$('tabPractice').addEventListener('click', () => setMode('practice'));
$('tabGame').addEventListener('click', () => setMode('game'));

$('solve').addEventListener('click', () => { if (!state.animating) runSolve(); });
$('shoot').addEventListener('click', () => { if (!state.animating) shootPractice(); });
$('reset').addEventListener('click', resetLayout);
// 出图要等解码，所以这里不 await：按钮自己会在 finally 里解禁
$('shareShot').addEventListener('click', () => { if (!state.animating) shareShot(); });
$('shareTable').addEventListener('click', () => { if (!state.animating) shareTable(); });
$('shareMatch').addEventListener('click', () => { if (!state.animating) shareMatch(); });
$('addBall').addEventListener('click', addBall);
$('rackUp').addEventListener('click', rackUp);
$('newGame').addEventListener('click', newGame);
$('gSolve').addEventListener('click', gameSolve);
$('gShoot').addEventListener('click', gameShoot);
$('gUndo').addEventListener('click', undoGame);
$('gRerack').addEventListener('click', doRerack);
$('removeBall').addEventListener('click', removeBall);
// 玩家显式换台：记在当前玩法名下，之后切走再切回来（以及切玩法时）都保留。
$('tablePreset').addEventListener('change', (ev) => {
  state.tableManual[state.gameKind] = ev.target.value;
  setTablePreset(ev.target.value);
});
$('viewToggle').addEventListener('click', toggleView);

$('showCone').addEventListener('change', render);
$('showGhost').addEventListener('change', render);
$('autoOpponent').addEventListener('change', (ev) => {
  state.autoOpponent = ev.target.checked;
  // 手动把开关打开 = 用户明确要对手自己打，暂停到此为止（'resume'）。
  // 注意反过来「关掉开关」不改暂停态：关掉本来就不会自动出杆。
  if (state.autoOpponent) Object.assign(state, reduceAutoPause(state, 'resume'));
  updateAutoPauseBar();
  if (state.autoOpponent) maybeOpponentTurn();
});

$('autoPauseResume').addEventListener('click', resumeAutoOpponent);

$('gameKind').addEventListener('change', (ev) => {
  const v = ev.target.value;
  // 下拉框给的值必须真的是一种玩法：以前写成 `GAME_KINDS[v] ? v : 'eightball'`，
  // 将来加十球时忘了改这里，用户选中的新玩法会静默按黑八开一整局——规则全错、
  // 日志里什么都没有。未知值直接抛（见 state.js 的 gameKindOrThrow）。
  state.gameKind = gameKindOrThrow(v);
  // 换玩法等于换一套规则（能否分组、先碰哪颗、9 号进袋算不算赢），
  // 旧局不能就地续上，所以直接开新的一局。
  // 球台也得跟着换：斯诺克的彩球点位（开球线 737 mm、黑球距顶库 324 mm）
  // 是按 12 尺台算的，摆在 9 尺台上点位会挤在一起；八球 / 九球则回各自的默认台。
  // 以前这里只写了「切到斯诺克就换台」这一半，切走那条路没有——实测从斯诺克切回
  // 八球，kind 已经变成 eightball，台面还是 3.569 m 的斯诺克台，15 颗球按错误
  // 尺寸摆出来。哪张台由 state.js 的 tableForKind 决定（纯函数，可单测）：
  // 玩家自己选过的台优先，斯诺克除外。
  const target = tableForKind(state.gameKind, state.tableManual);
  if (target && target !== table.preset) {
    // setTablePreset 会重新摆球（旧台坐标对新台没有意义），球局模式下还会直接
    // 开新的一局，所以这里不再重复 newGame()。
    setTablePreset(target);
    // 练习模式下它不开局，但 state.game 可能还停在旧玩法的局上；对着新玩法
    // 重开一局，免得之后切到球局时拿旧 kind 的局面直接用。
    if (state.mode !== 'game') newGame();
    return;
  }
  newGame();
});

$('allowSafety').addEventListener('change', (ev) => {
  state.allowSafety = ev.target.checked;
});

// Reg.16 的待决事项：接手方选「照这样打」还是「交回给开球方」。
$('gAccept').addEventListener('click', () => {
  const g = state.game;
  if (!g?.pendingChoice) return;
  const next = acceptTable(g);
  state.generation += 1;
  state.game = next;
  state.gSolution = null;
  $('gChoice').classList.add('hidden');
  setReport('你选择照这样打。');
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  updateScore();
  updateLog();
  render();
  maybeOpponentTurn();
});

$('gHandBack').addEventListener('click', () => {
  const g = state.game;
  if (!g?.pendingChoice) return;
  const next = handBackBreak(g);
  state.generation += 1;
  state.game = next;
  state.gSolution = null;
  $('gChoice').classList.add('hidden');
  setReport(`已把台面交回给 ${esc(next.players[next.turn].name)}。`);
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  updateScore();
  updateLog();
  render();
  maybeOpponentTurn();
});

// 手动出杆的四个滑块。拖动时只更新标签，不触发重绘——
// 滑块只在真正出杆时被读一次，拖动过程中台面不需要跟着变。
// 第一人称模式下需要重绘球杆位置，用 rAF 节流避免高频重绘。
let pendingSliderRender = false;
for (const id of ['power', 'aimOffset', 'tipB', 'tipA']) {
  $(id).addEventListener('input', () => {
    readManualControls();
    state.manual.touched = true;
    if (view.getCamera().t > 0.01 && !pendingSliderRender) {
      pendingSliderRender = true;
      requestAnimationFrame(() => { pendingSliderRender = false; render(); });
    }
  });
}

// 击球点 2D 靶盘交互：支持在球面上直观拖动或点选
const cuePad = $('cueBallPad');
if (cuePad) {
  let draggingPad = false;
  const setFromPad = (ev) => {
    const rect = cuePad.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = (ev.clientX - cx) / (rect.width / 2);
    let dy = (ev.clientY - cy) / (rect.height / 2);
    const dist = Math.hypot(dx, dy);
    if (dist > 1) {
      dx /= dist;
      dy /= dist;
    }
    const tipA = Math.round(clamp(dx * 0.5, -0.5, 0.5) * 20) / 20;
    const tipB = Math.round(clamp(-dy * 0.5, -0.5, 0.5) * 20) / 20;
    $('tipA').value = String(tipA);
    $('tipB').value = String(tipB);
    readManualControls();
    state.manual.touched = true;
  };
  cuePad.addEventListener('pointerdown', (ev) => {
    draggingPad = true;
    cuePad.setPointerCapture?.(ev.pointerId);
    setFromPad(ev);
  });
  cuePad.addEventListener('pointermove', (ev) => {
    if (draggingPad) setFromPad(ev);
  });
  const endPadDrag = () => { draggingPad = false; };
  cuePad.addEventListener('pointerup', endPadDrag);
  cuePad.addEventListener('pointercancel', endPadDrag);
}
$('useSolution').addEventListener('click', applySolutionToManual);
$('shootManual').addEventListener('click', shootManual);
$('practiceMade').addEventListener('click', () => recordPracticeOutcome(true));
$('practiceMissed').addEventListener('click', () => recordPracticeOutcome(false));
$('clearPractice').addEventListener('click', removePracticeLog);
$('practiceUndo').addEventListener('click', undoLastPracticeRecord);
$('exportPractice').addEventListener('click', exportPracticeRecords);
$('backupPractice').addEventListener('click', downloadPracticeBackup);
$('restorePractice').addEventListener('click', () => $('practiceBackupFile').click());
$('practiceBackupFile').addEventListener('change', (event) => {
  restorePracticeBackup(event.target.files?.[0]).finally(() => {
    event.target.value = '';
  });
});
$('practiceGoal').addEventListener('change', (event) => {
  const goal = Number(event.target.value);
  if (!PRACTICE_GOALS.includes(goal) || !writePracticeGoal(goal)) {
    $('practiceGoal').value = String(readPracticeGoal());
    updatePracticeFeedback('目标设置未能保存；请检查浏览器是否允许本地存储。');
    return;
  }
  updatePracticeLog();
  updatePracticeFeedback(`今日目标已更新为 ${goal} 杆。`);
});
$('drillSelect').addEventListener('change', () => updateDrillStatus());
$('startDrill').addEventListener('click', startPracticeDrill);
$('practiceFocusAction').addEventListener('click', () => {
  const focus = summarizePracticeFocus(readPracticeLog());
  if (!focus.drillId) return;
  $('drillSelect').value = focus.drillId;
  startPracticeDrill();
});

$('saveGame').addEventListener('click', saveGame);
$('loadGame').addEventListener('click', loadGame);
$('clearSave').addEventListener('click', removeSave);
// 导出 / 导入到文件：存档原本只在本机 localStorage 里，换设备就没了
$('exportGameSave').addEventListener('click', exportGameSave);
$('importGameSave').addEventListener('click', () => $('gameSaveFile').click());
$('gameSaveFile').addEventListener('change', (e) => {
  importGameSaveFromFile(e.target.files?.[0] ?? null);
  e.target.value = '';
});
// 另一个标签页存了新档时，这个按钮才出现。按了才读——不自动换桌，
// 但也不能只提示不给路，否则「多开一个标签页」就等于半残。
$('takeOtherSave').addEventListener('click', () => {
  const shots = state.otherSaveShots;
  state.otherSaveShots = null;
  loadGame();
  // loadGame 不碰存档卡的状态栏，所以按钮要自己收起来——它已经兑现过一次了。
  refreshSaveInfo();
  setReport(`读入另一个标签页存的存档（第 ${shots ?? '?'} 杆）。这一边原来的局面被替换掉了。`);
});

// 另一个标签页动了存档。storage 事件只在**别的**标签页写入时触发（自己写不会
// 回调自己），正好用来把「这份存档我见过的那版已经过期了」标出来。
// 不自动读进来：这边可能正打到关键一杆，突然换桌比丢一份存档更糟。
window.addEventListener('storage', (e) => {
  if (e.key !== SAVE_KEY) return;
  state.saveOverwrite = false;
  if (e.newValue === null) {
    state.saveStamp = null;
    state.otherSaveShots = null;
    setReport('另一个标签页把存档删掉了。这边不受影响。');
  } else {
    const theirs = describeSave();
    state.otherSaveShots = theirs?.shots ?? 0;
    setReport(
      `另一个标签页刚存了一份新的（第 ${theirs?.shots ?? '?'} 杆）。` +
        '这边接着打没问题；想接着那边打，点「读入另一个标签页存的」。' +
        '点「存这一局」时也会先问一句，免得把它盖掉。'
    );
  }
  refreshSaveInfo();
});

// ---------------------------------------------------------------- 键盘

/**
 * 键盘快捷键。设计原则：**不抢输入焦点**。
 * 焦点在滑块上时按左右键，浏览器自己会调滑块，这里再用方向键微调就是双重响应。
 *
 * 键位（与 demo/index.html 的「键盘」卡片逐条对应，改一处必须改另一处）：
 *   S          —— 求解
 *   Enter 空格 —— 按求解参数打这一杆
 *   Z          —— 撤销一杆（只在球局有效）
 *   N          —— 新的一局 / 重置练习
 *   1 / 2      —— 切练习 / 切球局
 *   ← →        —— 瞄准偏移 ∓0.1°
 *   ↑ ↓        —— 力度 ±0.1 m/s
 * 都带 preventDefault，避免空格滚动页面、回车触发焦点按钮。
 */

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

function nudgeManual(kind, delta) {
  const id = kind === 'aim' ? 'aimOffset' : 'power';
  const el = $(id);
  const min = Number(el.min);
  const max = Number(el.max);
  el.value = String(clamp(Number(el.value) + delta, min, max));
  readManualControls();
  state.manual.touched = true;
}

function onKeyDown(ev) {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (isTypingTarget(ev.target)) return;
  // 回放中（对手出杆也算）不让别的键动手，但面对 Z 不能装没看见：按钮这时是灰的，
  // 键盘是唯一还能「点」到撤销的路，静默返回等于让人以为撤销坏了。
  if (state.animating) {
    if ((ev.key === 'z' || ev.key === 'Z') && state.mode === 'game') {
      ev.preventDefault();
      undoGame();
    }
    return;
  }

  const inGame = state.mode === 'game';
  switch (ev.key) {
    case 'v':
    case 'V':
      ev.preventDefault();
      toggleView();
      break;
    case 's':
    case 'S':
      ev.preventDefault();
      if (inGame) gameSolve();
      else runSolve();
      break;
    case 'Enter':
    case ' ':
      ev.preventDefault();
      if (inGame) gameShoot();
      else shootPractice();
      break;
    case 'z':
    case 'Z':
      if (!inGame) return;
      ev.preventDefault();
      undoGame();
      break;
    case 'n':
    case 'N':
      ev.preventDefault();
      if (inGame) newGame();
      else resetLayout();
      break;
    case '1':
      ev.preventDefault();
      setMode('practice');
      break;
    case '2':
      ev.preventDefault();
      setMode('game');
      break;
    case 'ArrowLeft':
      ev.preventDefault();
      nudgeManual('aim', -0.1);
      break;
    case 'ArrowRight':
      ev.preventDefault();
      nudgeManual('aim', 0.1);
      break;
    case 'ArrowUp':
      ev.preventDefault();
      nudgeManual('power', 0.1);
      break;
    case 'ArrowDown':
      ev.preventDefault();
      nudgeManual('power', -0.1);
      break;
    default:
      break;
  }
}

document.addEventListener('keydown', onKeyDown);

window.addEventListener('resize', resize);

resetLayout();
resize();
updatePracticeLog();
// 战绩是跨局的，刷新之后必须还在：这里先按存储里的内容画一遍，
// 不等开球（否则用户会以为历史战绩随刷新丢了）。
updateMatchStats();

// 换台下拉按预设自动填，不写死在 HTML 里——预设表只有一份在 src/constants.js。
for (const preset of Object.values(TABLE_PRESETS)) {
  const opt = document.createElement('option');
  opt.value = preset.id;
  opt.textContent = preset.label;
  $('tablePreset').appendChild(opt);
}
$('tablePreset').value = table.preset;

// 经典垂直拉杆能量槽交互绑定 (参考 8 Ball Pool / 腾讯桌球)
function initPowerMeterEvents() {
  const track = $('powerMeterTrack');
  const handle = $('powerMeterHandle');
  if (!track) return;

  let dragging = false;

  const setPowerFromPointer = (ev, throttled = false) => {
    const rect = track.getBoundingClientRect();
    const ratio = clamp(1 - (ev.clientY - rect.top) / rect.height, 0, 1);
    const min = Number($('power').min) || 0.55;
    const max = Number($('power').max) || 6.60;
    const speed = Math.round((min + ratio * (max - min)) * 20) / 20;

    $('power').value = String(speed);
    state.manual.speed = speed;
    state.manual.touched = true;
    updateManualLabels();
    if (view.getCamera().t > 0.01) {
      if (throttled && !pendingSliderRender) {
        pendingSliderRender = true;
        requestAnimationFrame(() => { pendingSliderRender = false; render(); });
      } else if (!throttled) {
        render();
      }
    }
  };

  track.addEventListener('pointerdown', (ev) => {
    dragging = true;
    handle?.classList.add('dragging');
    track.setPointerCapture?.(ev.pointerId);
    setPowerFromPointer(ev, false); // 按下时立即渲染
  });

  track.addEventListener('pointermove', (ev) => {
    if (dragging) setPowerFromPointer(ev, true); // 拖动时节流
  });

  const stopDrag = () => {
    if (dragging) {
      dragging = false;
      handle?.classList.remove('dragging');
    }
  };
  track.addEventListener('pointerup', stopDrag);
  track.addEventListener('pointercancel', stopDrag);

  // 快捷档位预设按钮点击绑定 (能量槽与侧边栏两套按钮实时同步)
  document.querySelectorAll('.power-meter-chip, .power-chip').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const targetSpeed = Number(btn.getAttribute('data-speed'));
      if (!Number.isFinite(targetSpeed)) return;
      $('power').value = String(targetSpeed);
      state.manual.speed = targetSpeed;
      state.manual.touched = true;
      updateManualLabels();
      if (view.getCamera().t > 0.01) render();
    });
  });
}

initPowerMeterEvents();
updateManualLabels();
refreshSaveInfo();

// 难度档位的精度前提。写在 JS 里而不是 HTML 里，是为了让 LABEL_SIGMA_DEG
// 只有一个来源：改了常量，文案自动跟着变，不会两边不一致。
$('verdictNote').textContent =
  `难度档位按「瞄准误差 ±${LABEL_SIGMA_DEG}°」估算` +
  `（1 米外偏 ${(Math.tan((LABEL_SIGMA_DEG * Math.PI) / 180) * 1000).toFixed(1)} 毫米，` +
  `2 米外偏 ${(Math.tan((LABEL_SIGMA_DEG * Math.PI) / 180) * 2000).toFixed(1)} 毫米）。` +
  `瞄得比这松，实际命中率会低于档位名；瞄得比这准，会高于档位名。`;

// 端到端测试用：把状态挂到 window 上，省得靠读 DOM 猜内部状态
window.__app = {
  state,
  get table() { return table; },
  view,
  get mode() { return state.mode; },
  setMode,
  // 回放本身也暴露出来：端到端脚本要能构造一串长帧，在动画进行中去点重置 / 切模式，
  // 否则「回放被打断」这条路只能靠运气在真实击球里重现。
  replay,
  runSolve,
  gameSolve,
  gameShoot,
  undoGame,
  maybeOpponentTurn,
  newGame,
  rackUp,
  addBall,
  removeBall,
  setTablePreset,
  resetLayout,
  // 手动出杆 / 存档：端到端脚本直接调，不必去模拟拖滑块
  shootManual,
  recordPracticeOutcome,
  undoLastPracticeRecord,
  updatePracticeLog,
  // 端到端脚本要能数「记了几杆」，不用去解析 localStorage
  practiceCount: () => readPracticeLog().length,
  applySolutionToManual,
  // 端到端脚本按零参调，所以这里包一层把 state 喂进去（签名在 state.js 里）
  currentAim: () => currentAim(state),
  saveGame,
  loadGame,
  removeSave,
  // 撤销 / 读档之后自动出杆是暂停的：端到端脚本要能点「继续」恢复它，
  // 不然「暂停」看起来就像「对手卡住了」。
  resumeAutoOpponent,
  // 导出/导入到文件：端到端脚本直接喂文本，不必去模拟文件选择器与下载
  exportGameText,
  importGameText,
  // 分享这一杆：端到端脚本要能拿到图真的多大、多少字节，而不是只看到按钮
  shareShot,
  // 分享局面：同上，另外要能拿它的返回值跟页面上的比分/剩余球数对一遍
  shareTable,
  // 复盘这一局：E2E 要核「图上的比分/命中率」与页面统计面板是不是同一份
  shareMatch,
  buildMatchSummary,
  // 端到端脚本要用同一份文案去核「图上说的」和「记分牌上说的」是不是一回事
  buildTableSummary,
  refreshSaveInfo,
  onKeyDown,
  toggleView,
  getCamera: () => view.getCamera(),
  setCameraT: (t) => { syncCamera(t); render(); },
};
