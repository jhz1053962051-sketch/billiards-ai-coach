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
import { createBall, createWorld, strike, stepWorld, allStopped, createRollTracker } from '../src/physics.js';
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
import { createRenderer, interpolateBallStates, sampleDampedCamera } from './render.js';
import { ballStyle, groupOf, RACK_NUMBERS, createStandardRack, createRack } from '../src/rack.js';
import {
  createGame,
  cloneGame,
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
import { readSave, writeSave, clearSave, describeSave, readSaveStamp, SAVE_KEY } from './save.js';
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
  // 玩法：'eightball' | 'nineball'。摆球形状、规则判定、可否分组都由它决定。
  gameKind: 'eightball',
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
  // 已经被提示过一次「存档被别人改过」，再点一次存档就是真要覆盖。
  saveOverwrite: false,
  // 撤销用：每一杆结算前的局面快照。只存球局，练习模式的「重置」已经是退路。
  history: [],
  // 手动出杆参数。求解会给"建议参数"，但滑块一旦被用户动过就不再被覆盖——
  // 否则每点一次「求解」就把人刚调好的力度冲掉，那是很恼人的。
  manual: { speed: 2.2, aimOffsetDeg: 0, tipB: 0, tipA: 0, touched: false },
};

const GROUP_LABEL = { solid: '全色', stripe: '花色', eight: '8 号', cue: '母球' };

/**
 * 拼进 innerHTML 之前必须过这一道。
 *
 * 现在玩家名只有「你」「对手」两个常量，所以还炸不出来；但存档是存在
 * localStorage 里的，任何人手改一下（或者以后加了改名、分享存档）就能把
 * `<img src=x onerror=...>` 塞进去，而计分板正是用 innerHTML 拼名字的。
 * 与其等到那天再补，不如把所有外部字符串统一转义。
 */
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ESC_MAP[ch]);
}

// ---------------------------------------------------------------- 尺寸

function resize() {
  const rect = $('stage').getBoundingClientRect();
  view.fit(rect.width - 10, rect.height - 10);
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
  $('alts').innerHTML = '—';
  $('alts').className = 'empty';
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
  const spot = findSpot();
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

function findSpot() {
  const R2 = R * 2 + 1e-4;
  const clear = (x, y) =>
    x >= table.bounds.minX && x <= table.bounds.maxX &&
    y >= table.bounds.minY && y <= table.bounds.maxY &&
    !state.balls.some((b) => !b.pocketed && Math.hypot(b.x - x, b.y - y) < R2);

  for (let ring = 0; ring < 60; ring++) {
    const radius = ring * R * 1.6;
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
  $('alts').innerHTML = '—';
  $('alts').className = 'empty';
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
  const aim = currentAim();
  const aimAngle = aim ? (aim.angle + (state.manual.aimOffsetDeg * Math.PI) / 180) : 0;

  view.setCamera({
    t,
    aimAngle,
    cueBall: cue ? { x: cue.x, y: cue.y } : { x: table.length * 0.25, y: table.width * 0.5 },
  });
}

function getAimHUDInfo() {
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
  const aim = currentAim();
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

// ---------------------------------------------------------------- 绘制

function render() {
  view.clear();
  syncCamera(view.getCamera().t);
  view.drawTable();

  if (state.mode === 'practice') {
    drawSolution();
    drawBalls(state.balls);
  } else {
    drawGameOverlay();
    drawBalls(state.game?.balls ?? []);
  }

  // 渲染第一人称球杆与战术瞄准准星 HUD
  if (view.getCamera().t > 0.01) {
    view.drawCueStick(state.manual.strokeOffset || 0);
    view.draw1stPersonHUD(getAimHUDInfo());
  }
}

function drawBalls(balls) {
  const visible = balls.filter((b) => !b.pocketed);
  if (view.getCamera().t > 0.01) {
    // 3D 深度排序：远处的球先画，近处的球后画（遮挡在前面）
    visible.sort((a, b) => {
      const pa = view.project(a.x, a.y, table.ballRadius);
      const pb = view.project(b.x, b.y, table.ballRadius);
      return pb.depth - pa.depth;
    });
  }
  for (const b of visible) {
    view.drawBall(b);
  }
}

function captureBallFrame(balls, trackRoll) {
  const roll = trackRoll();
  return balls.map((ball, index) => ({
    x: ball.x,
    y: ball.y,
    pocketed: ball.pocketed,
    pocket: ball.pocket,
    ...roll[index],
  }));
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

function drawSolution() {
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
  const camT = view.getCamera().t;

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

function drawGameOverlay() {
  const g = state.game;
  if (!g) return;
  const ctx = view.ctx;
  const camT = view.getCamera().t;

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

function pointerPos(ev) {
  const rect = canvas.getBoundingClientRect();
  return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (ev) => {
  if (state.animating) return;
  const p = pointerPos(ev);
  const w = view.toWorld(p.x, p.y);

  // 球局模式下有持球：点哪儿就把母球放哪儿
  if (state.mode === 'game' && state.game?.ballInHand) {
    // 对手持球时由 takeTurn 自己摆位，玩家不能替它放
    if (state.autoOpponent && state.game.turn === 1) {
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

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------- 练习：求解与演示

/**
 * 练习面板的状态行。
 *
 * 不传参时不该把它清空：页面一打开 resetLayout 就会调一次，清成空字符串
 * 等于把首屏那句「先求解一个目标袋方案，再记录真实练习结果」当场抹掉，
 * 球友看到的是一块空白，不知道下一步该干什么。所以不传参就按当前状态
 * 算一句该说的话。
 */
function practiceHint() {
  if (state.mode !== 'practice') return '';
  if (!state.solution?.found || !state.solution.best?.pocketId) {
    return '先求解一个目标袋方案，再记录真实练习结果。';
  }
  if (state.practiceRecorded) return '这一杆记下了。同一个球位可以接着记，换球位就再求解一次。';
  return '按实际结果点「进了」或「没进」——记下来才看得出进步。';
}

function updatePracticeFeedback(message = null) {
  // 记完一杆不再禁用：同一个球位反复练十杆是常态，每杆都得重新求解一次
  // 才能记录，等于逼人重复劳动。这里只要「有解」就给点，记多少次都行。
  const ready = Boolean(
    state.mode === 'practice' &&
    state.solution?.found &&
    state.solution.best?.pocketId
  );
  $('practiceMade').disabled = !ready || state.animating;
  $('practiceMissed').disabled = !ready || state.animating;
  $('practiceMessage').textContent = message ?? practiceHint();
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
  $('exportPractice').disabled = records.length === 0;
  $('practiceHistorySummary').textContent = records.length
    ? `查看最近 5 条（共 ${records.length} 条）`
    : '暂无记录明细';
  $('practiceSummary').textContent = summary.attempts
    ? `${summary.made}/${summary.attempts} 杆命中 · 总命中率 ${Math.round(summary.rate * 100)}% · 最近 ${summary.recent.attempts} 杆 ${summary.recent.attempts ? `${Math.round(summary.recent.rate * 100)}%` : '—'}`
    : '还没有实战记录。';
  $('practiceGoal').value = String(today.goal || DEFAULT_PRACTICE_GOAL);
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

function runSolve() {
  state.practiceRecorded = false;
  const t0 = performance.now();
  const all = solveShot(table, state.balls);
  const ms = performance.now() - t0;
  const card = coach(table, state.balls, { candidates: all });
  state.solution = card;
  updatePracticeFeedback();

  if (!card.found) {
    setAdvice(card.message, '');
    $('alts').innerHTML = '—';
    $('alts').className = 'empty';
    render();
    return;
  }

  const cls = card.best.difficulty > 80 ? 'brutal' : card.best.difficulty > 55 ? 'hard' : '';
  setAdvice(card.message, `${card.verdict} · 求解 ${ms.toFixed(0)} ms`, cls);
  renderAlts(card, ms);
  render();
}

function renderAlts(card, ms) {
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
    row.append(title, meta);
    row.addEventListener('click', () => {
      if (state.animating) return;
      const v = c.value ?? c.difficulty;
      state.solution = {
        ...card,
        best: c,
        message: describeCandidate(c),
        verdict: `${difficultyLabel(v)}（综合 ${v}/100 · 单杆难度 ${c.difficulty}/100 · ${difficultyCaveat()}）`,
      };
      state.practiceRecorded = false;
      updatePracticeFeedback();
      for (const el of $('alts').querySelectorAll('.alt')) el.classList.toggle('active', el === row);
      const dd = c.difficulty;
      setAdvice(
        state.solution.message,
        state.solution.verdict + (ms ? ` · 求解 ${ms.toFixed(0)} ms` : ''),
        dd > 80 ? 'brutal' : dd > 55 ? 'hard' : ''
      );
      render();
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

function shootPractice() {
  const sol = state.solution;
  if (!sol || !sol.found) {
    setAdvice('先求解，再演示。', '');
    return;
  }
  const best = sol.best;
  const copy = state.balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === 'cue');
  strike(cue, { angle: best.aimAngle, speed: best.speed, tip: { a: best.tip.a, b: best.tip.b } });

  const dt = SEARCH_DT;
  const trackRoll = createRollTracker(copy, table.ballRadius);
  const frames = [captureBallFrame(copy, trackRoll)];
  for (let i = 0; i < 120 * 20; i++) {
    stepWorld(world, dt);
    frames.push(captureBallFrame(copy, trackRoll));
    if (allStopped(world)) break;
  }

  const original = state.balls.map((b) => ({ x: b.x, y: b.y, pocketed: b.pocketed, pocket: b.pocket }));
  // replay 内部已经按代次拦住过期帧，这里再挡一次：只要 original 和当前球数组不是同一批球，
  // 按下标恢复就会读到 undefined。宁可什么都不做，也不能把别人的局面改坏。
  const gen = state.generation;
  replay(frames, dt, () => {
    if (gen !== state.generation || state.balls.length !== original.length) return;
    const target = state.balls.find((b) => b.id === best.targetId);
    const ok = Boolean(target && target.pocketed && target.pocket === best.pocketId);
    setAdvice((ok ? '✓ 进球。' : '✗ 这一杆没进（袋口或力度需要微调）。') + ' ' + sol.message, sol.verdict);
    for (let i = 0; i < state.balls.length; i++) {
      state.balls[i].x = original[i].x;
      state.balls[i].y = original[i].y;
      state.balls[i].pocketed = original[i].pocketed;
      state.balls[i].pocket = original[i].pocket;
    }
    render();
  });
}

// ---------------------------------------------------------------- 球局

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
  updateUndoButton();
  setReport(
    kind === 'nineball'
      ? '九球开球。只能先碰台面上号码最小的那颗；合法进 9 号直接赢局。点「求解」看第一杆怎么打。'
      : '开球。点「求解」看第一杆怎么打。'
  );
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  $('gRerack').classList.add('hidden');
  $('gChoice').classList.add('hidden');
  updateScore();
  updateLog();
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
  const box = $('log');
  if (!g || !g.log.length) {
    box.textContent = '—';
    return;
  }
  box.innerHTML = '';
  for (const entry of g.log.slice(-40).reverse()) {
    const d = document.createElement('div');
    d.textContent = `第 ${entry.shot} 杆 · ${entry.summary}`;
    box.appendChild(d);
  }
  box.scrollTop = 0;
}

function gameSolve() {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  // 对手回合的判断要排在 animating 之前：对手正在出杆动画里时 g.turn 还是 1
  // （runOpponentTurn 是先回放再结算），玩家这时点「求解」应该看到"它自己会打"，
  // 而不是什么都不发生。
  if (state.autoOpponent && g.turn === 1) {
    $('gAdvice').textContent = '现在是对手回合，不用你算——它会自己打。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    return;
  }
  if (state.animating) return;
  if (g.requiresRerack) {
    $('gAdvice').textContent = '上一杆开球不合法，必须先点「重摆开球」——规则里这一杆不算数。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    return;
  }
  if (g.ballInHand) {
    $('gAdvice').textContent = '先把母球摆到台面上（在合法区里点一下）。';
    $('gAdvice').className = 'empty';
    return;
  }
  const onTable = numbersOnTable(g.balls);
  const allow = legalTargetNumbers(g, onTable);
  const t0 = performance.now();
  const { plan, kind, alternatives } = planShot(table, g, { allow, safety: state.allowSafety });
  const ms = performance.now() - t0;

  if (!plan) {
    state.gSolution = { found: false };
    $('gAdvice').textContent = '台面上没有可以合法先碰的球。';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
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
  const diffTxt =
    kind === 'attack'
      ? `（综合 ${plan.value ?? plan.difficulty}/100 · 单杆难度 ${plan.difficulty}/100 · ${difficultyCaveat()}）`
      : kind === 'safety'
        ? `（对手容错 ±${plan.safetyOppToleranceDeg.toFixed(2)}° · 从 ±${plan.safetyBaseToleranceDeg.toFixed(2)}° 压下来）`
        : '';
  $('gVerdict').textContent = `${kindLabel}${diffTxt} · 求解 ${ms.toFixed(0)} ms`;
  $('gVerdict').className =
    kind === 'attack' && plan.difficulty > 80 ? 'brutal' : kind === 'attack' && plan.difficulty > 55 ? 'hard' : '';
  render();
}

function gameShoot() {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  if (state.autoOpponent && g.turn === 1) return;
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
    state.placing = Boolean(next.ballInHand);
    canvas.classList.toggle('placing', state.placing);

    const foulHtml = report.fouls.length
      ? `<div class="foul">犯规：${report.fouls.map((f) => f.text).join('；')}</div>`
      : '';
    const extra = [];
    if (report.groupAssigned) extra.push(`分组：${report.groupAssigned.player === 0 ? '你' : '对手'}拿到${GROUP_LABEL[report.groupAssigned.group]}`);
    if (report.spotted === 8) extra.push('8 号球已重摆回 8 号点');
    if (report.requiresRerack) extra.push('开球不合法，需要重摆');
    if (next.ballInHand) extra.push(`持球：${next.ballInHand.zone === 'kitchen' ? '在开球线后点一下放母球' : '在台面上点一下放母球'}`);
    setReport(`${report.summary}${foulHtml}${extra.length ? '<div>' + extra.join(' · ') + '</div>' : ''}`);

    $('gRerack').classList.toggle('hidden', !next.requiresRerack);
    $('gAdvice').textContent = next.phase === 'ended' ? '这一局结束了。' : '—';
    $('gAdvice').className = 'empty';
    $('gVerdict').textContent = '';
    updateScore();
    updateLog();
    render();
    maybeOpponentTurn();
  });
}

// ---------------------------------------------------------------- 撤销

/** 撤销栈上限。台面上任意时刻最多 16 颗球，一局十几到几十杆，20 步够用又不占内存。 */
const HISTORY_LIMIT = 20;

/**
 * 记一步快照。
 *
 * 必须在「结算前」记：resolveShot 不改入参（它返回新的 next），所以传进来的是
 * 打完这一杆之前的局面，正是撤销要回到的状态。
 */
function pushHistory(game) {
  state.history.push(cloneGame(game));
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  updateUndoButton();
}

function updateUndoButton() {
  const btn = $('gUndo');
  if (!btn) return;
  const n = state.history.length;
  btn.disabled = n === 0 || state.animating;
  btn.textContent = n === 0 ? '撤销上一杆' : `撤销上一杆（${n}）`;
}

function undoGame() {
  if (state.animating) return;
  const prev = state.history.pop();
  if (!prev) {
    setReport('已经退到这一局的起点了，没有更早的局面可退。');
    return;
  }
  state.game = prev;
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
  updateScore();
  updateLog();
  updateUndoButton();
  render();
  // 撤销到对手回合时不要自动接着打——用户刚退回来看局面，立刻又被打乱了。
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
  if (!g || g.phase === 'ended' || state.animating) return;
  if (!state.autoOpponent || g.turn !== 1) return;
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
  pushHistory(g);

  replay(r.facts.frames, r.facts.dt, () => {
    if (gen !== state.generation) return;
    state.game = r.next;
    state.opponentThinking = false;
    state.placing = Boolean(r.next.ballInHand) && r.next.turn === 0;
    canvas.classList.toggle('placing', state.placing);

    const report = r.report;
    const foulHtml = report.fouls.length
      ? `<div class="foul">犯规：${report.fouls.map((f) => f.text).join('；')}</div>`
      : '';
    const extra = [];
    if (report.groupAssigned) extra.push(`分组：${report.groupAssigned.player === 0 ? '你' : '对手'}拿到${GROUP_LABEL[report.groupAssigned.group]}`);
    if (report.spotted === 8) extra.push('8 号球已重摆回 8 号点');
    if (report.requiresRerack) extra.push('开球不合法，需要重摆');
    if (r.next.ballInHand && r.next.turn === 0) {
      extra.push(`持球：${r.next.ballInHand.zone === 'kitchen' ? '在开球线后点一下放母球' : '在台面上点一下放母球'}`);
    }
    setReport(`<b>对手</b> · ${report.summary}${foulHtml}${extra.length ? '<div>' + extra.join(' · ') + '</div>' : ''}`);

    $('gRerack').classList.toggle('hidden', !r.next.requiresRerack);
    $('gVerdict').textContent = '';
    updateScore();
    updateLog();
    render();

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
  maybeOpponentTurn();
}

// ---------------------------------------------------------------- 手动出杆

/**
 * 当前这一杆的基准瞄准方向（弧度）。
 *
 * 优先用求解结果——那是唯一"已经对准某个袋"的方向，滑块在它上面偏移才有意义。
 * 没有解时退化成"直指最近的合法目标球球心"，至少方向不是乱的。
 *
 * @returns {{angle:number, targetId:string|null, from:string}|null}
 */
function currentAim() {
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

/**
 * 经典台球游戏击球力度档位划分 (参考 8 Ball Pool / 腾讯桌球)
 * 0% ~ 29%: 轻力 (细腻走位 / 贴库过渡) - 翡翠绿
 * 30% ~ 59%: 中力 (标准走位 / 常规进球) - 晴空蓝
 * 60% ~ 84%: 发力 (长台推进 / 强力拉杆) - 琥珀金
 * 85% ~ 100%: 爆杆 (强力冲球 / 极限爆裂) - 炽烈红
 */
function getPowerTier(speed) {
  const min = 0.55;
  const max = 6.60;
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
  state.manual.speed = Math.round(clamp(b.speed, Number($('power').min), Number($('power').max)) * 20) / 20;
  state.manual.aimOffsetDeg = 0;
  state.manual.tipB = b.tip.b ?? 0;
  state.manual.tipA = b.tip.a ?? 0;
  state.manual.touched = true;
  $('power').value = String(state.manual.speed);
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
  const aim = currentAim();
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

/** 练习模式：按给定的杆打，打完复位到原局面。 */
function shootPracticeWith(shot, aim) {
  const copy = state.balls.map((b) => ({ ...b, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0 }));
  const world = createWorld(table, copy);
  const cue = copy.find((b) => b.id === 'cue');
  if (!cue) return;
  strike(cue, shot);

  const dt = SEARCH_DT;
  const trackRoll = createRollTracker(copy, table.ballRadius);
  const frames = [captureBallFrame(copy, trackRoll)];
  for (let i = 0; i < 120 * 20; i++) {
    stepWorld(world, dt);
    frames.push(captureBallFrame(copy, trackRoll));
    if (allStopped(world)) break;
  }
  const original = state.balls.map((b) => ({ x: b.x, y: b.y, pocketed: b.pocketed, pocket: b.pocket }));
  replay(frames, dt, () => {
    const pocketed = copy.filter((b) => b.pocketed && b.number !== 0).map((b) => b.number);
    const cuePocketed = copy.some((b) => b.pocketed && b.number === 0);
    const detail = [];
    if (pocketed.length) detail.push(`进 ${pocketed.join('、')} 号`);
    if (cuePocketed) detail.push('母球落袋');
    if (!pocketed.length && !cuePocketed) detail.push('没有球进袋');
    setAdvice(
      `手打结果：${detail.join(' · ')}（${state.manual.speed.toFixed(2)} m/s · ${$('tipBVal').textContent} · ${$('tipAVal').textContent}）`,
      aim.from === 'solution' ? '方向取自求解结果 + 你调的偏移' : '方向直指最近的球（没有求解）'
    );
    for (let i = 0; i < state.balls.length; i++) {
      state.balls[i].x = original[i].x;
      state.balls[i].y = original[i].y;
      state.balls[i].pocketed = original[i].pocketed;
      state.balls[i].pocket = original[i].pocket;
    }
    render();
  });
}

/** 球局模式：按给定的杆打，正常走规则结算。 */
function shootGameWith(shot, aim) {
  const g = state.game;
  if (!g || g.phase === 'ended') return;
  if (state.autoOpponent && g.turn === 1) return;
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

  const foulHtml = report.fouls.length
    ? `<div class="foul">犯规：${report.fouls.map((f) => f.text).join('；')}</div>`
    : '';
  const extra = [];
  if (report.groupAssigned) extra.push(`分组：${report.groupAssigned.player === 0 ? '你' : '对手'}拿到${GROUP_LABEL[report.groupAssigned.group]}`);
  if (report.spotted) extra.push(`${report.spotted} 号球已重摆回底点`);
  if (report.requiresRerack) extra.push('开球不合法，需要重摆');
  if (report.pendingChoice) extra.push('开球不达标，你可以在下面选照打还是交回去');
  if (next.ballInHand) extra.push(`持球：${next.ballInHand.zone === 'kitchen' ? '在开球线后点一下放母球' : '在台面上点一下放母球'}`);
  setReport(`${report.summary}${foulHtml}${extra.length ? '<div>' + extra.join(' · ') + '</div>' : ''}`);

  $('gRerack').classList.toggle('hidden', !next.requiresRerack);
  // 待决事项只有轮到玩家时才让玩家选；轮到对手那它自己选（acceptTable，照打）。
  updateChoicePanel(next);
  $('gAdvice').textContent = next.phase === 'ended' ? '这一局结束了。' : '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  updateScore();
  updateLog();
  updateUndoButton();
  render();
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
  const storedStamp = readSaveStamp();
  const stale =
    storedStamp !== null && state.saveStamp !== null && storedStamp !== state.saveStamp;
  if (stale && !state.saveOverwrite) {
    const theirs = describeSave();
    state.saveOverwrite = true;
    setReport(
      `存档已经被另一个标签页改过了（那边存的是第 ${theirs?.shots ?? '?'} 杆），这一局没有覆盖它。` +
        '确认要覆盖的话，再点一次「存这一局」。'
    );
    refreshSaveInfo();
    return;
  }
  const ok = writeSave(g);
  state.saveOverwrite = false;
  if (ok) {
    state.saveStamp = readSaveStamp();
    setReport(`已存档：第 ${g.shots} 杆，${g.balls.filter((b) => !b.pocketed && b.number !== 0).length} 颗目标球在台上。刷新页面后点「读取存档」能接着打。`);
    refreshSaveInfo();
  } else {
    setReport('存不了——浏览器禁用了本地存储（隐私模式常见），或者配额满了。');
  }
}

/** 从 localStorage 读回一局。 */
function loadGame() {
  const saved = readSave();
  if (!saved) {
    setReport('没有可用的存档（或者存档已损坏，已被丢弃）。');
    refreshSaveInfo();
    return;
  }
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
  // createGame 给的是开局态，把存档里的进程态逐项装回去。
  g.players = saved.players.map((p) => ({ ...p }));
  g.turn = saved.turn;
  g.breakShot = saved.breakShot;
  g.open = saved.open;
  g.ballInHand = saved.ballInHand ? { ...saved.ballInHand } : null;
  g.requiresRerack = saved.requiresRerack;
  g.phase = saved.phase;
  g.winner = saved.winner;
  g.shots = saved.shots;

  state.generation += 1;
  state.game = g;
  state.gSolution = null;
  state.animating = false;
  state.opponentThinking = false;
  state.placing = Boolean(g.ballInHand);
  canvas.classList.toggle('placing', state.placing);
  state.history = [];
  state.saveStamp = saved.savedAt;
  state.saveOverwrite = false;
  updateUndoButton();
  $('gRerack').classList.toggle('hidden', !g.requiresRerack);
  $('gAdvice').textContent = '—';
  $('gAdvice').className = 'empty';
  $('gVerdict').textContent = '';
  setReport(`已读取存档：第 ${g.shots} 杆，轮到「${esc(g.players[g.turn].name)}」。`);
  if (state.mode !== 'game') setMode('game');
  updateScore();
  updateLog();
  render();
  maybeOpponentTurn();
}

function removeSave() {
  const ok = clearSave();
  state.saveStamp = null;
  state.saveOverwrite = false;
  setReport(ok ? '存档已删除。' : '删不了——浏览器禁用了本地存储。');
  refreshSaveInfo();
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
  render();
  if (mode === 'game') maybeOpponentTurn();
}

$('tabPractice').addEventListener('click', () => setMode('practice'));
$('tabGame').addEventListener('click', () => setMode('game'));

$('solve').addEventListener('click', () => { if (!state.animating) runSolve(); });
$('shoot').addEventListener('click', () => { if (!state.animating) shootPractice(); });
$('reset').addEventListener('click', resetLayout);
$('addBall').addEventListener('click', addBall);
$('rackUp').addEventListener('click', rackUp);
$('newGame').addEventListener('click', newGame);
$('gSolve').addEventListener('click', gameSolve);
$('gShoot').addEventListener('click', gameShoot);
$('gUndo').addEventListener('click', undoGame);
$('gRerack').addEventListener('click', doRerack);
$('removeBall').addEventListener('click', removeBall);
$('tablePreset').addEventListener('change', (ev) => setTablePreset(ev.target.value));
$('viewToggle').addEventListener('click', toggleView);

$('showCone').addEventListener('change', render);
$('showGhost').addEventListener('change', render);
$('autoOpponent').addEventListener('change', (ev) => {
  state.autoOpponent = ev.target.checked;
  if (state.autoOpponent) maybeOpponentTurn();
});

$('gameKind').addEventListener('change', (ev) => {
  state.gameKind = ev.target.value === 'nineball' ? 'nineball' : 'eightball';
  // 换玩法等于换一套规则（能否分组、先碰哪颗、9 号进袋算不算赢），
  // 旧局不能就地续上，所以直接开新的一局。
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

// 另一个标签页动了存档。storage 事件只在**别的**标签页写入时触发（自己写不会
// 回调自己），正好用来把「这份存档我见过的那版已经过期了」标出来。
// 不自动读进来：这边可能正打到关键一杆，突然换桌比丢一份存档更糟。
window.addEventListener('storage', (e) => {
  if (e.key !== SAVE_KEY) return;
  state.saveOverwrite = false;
  if (e.newValue === null) {
    state.saveStamp = null;
    setReport('另一个标签页把存档删掉了。这边不受影响。');
  } else {
    const theirs = describeSave();
    setReport(
      `另一个标签页刚存了一份新的（第 ${theirs?.shots ?? '?'} 杆）。` +
        '这边接着打没问题，但点「存这一局」时会被先问一句，免得把它盖掉。'
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
  if (state.animating) return;

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
  updatePracticeLog,
  // 端到端脚本要能数「记了几杆」，不用去解析 localStorage
  practiceCount: () => readPracticeLog().length,
  applySolutionToManual,
  currentAim,
  saveGame,
  loadGame,
  removeSave,
  refreshSaveInfo,
  onKeyDown,
  toggleView,
  getCamera: () => view.getCamera(),
  setCameraT: (t) => { syncCamera(t); render(); },
};
