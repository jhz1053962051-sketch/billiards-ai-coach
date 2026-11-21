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
  // 斯诺克的比分和「该打什么」不在 createGame 的默认值里，必须单独装回去。
  if (saved.snooker && game.snooker) game.snooker = { ...saved.snooker, scores: saved.snooker.scores.slice() };
  return game;
}