// 台球动作规范性检查：把姿态关键点换算成可判定的指标，再对照阈值给出结论。
//
// 规则来源（不复制任何代码，只采用公开的教练检查表条目）：
//   - Dr. Dave 的 Pool Fundamentals "Best Practices" Check List
//     https://drdavepoolinfo.com/resource_files/fundamentals_check_list.pdf
//     其中与姿态相关的条目：stance（脚位/稳定/头低/球杆水平）、
//     grip（前臂在击球瞬间垂直于球杆）、hand bridge（架桥稳固、手臂伸直）、
//     stroke execution（钟摆出杆不掉肘、头身不晃、送杆完整）
//   - pooltool (Apache-2.0) / ctbot (MIT) 只用于物理，与本节无关
//
// 重要限制（必须对使用者诚实）：
//   1. 单目相机只能看到投影。所有角度都在 MediaPipe 的 world 坐标系里算，
//      它做了人体尺度归一，比直接用量化像素稳定得多，但仍然有噪声。
//   2. 阈值是按上面的检查表推出来的**参考区间**，没有在真实台球视频上做过
//      统计标定。所以每条结论都带 confidence，界面也必须显示这个值。
//   3. 看不到的点（visibility 低）一律判 unknown，绝不猜。

import {
  LM,
  vec,
  DEG,
  angleAt,
  angleFromUp,
  pointLineDistance,
  straightnessError,
  minVisibility,
  frameInset,
} from './landmarks.js';

// ---------------------------------------------------------------- 阈值配置
// 全部集中在这里，方便以后用真实录像重新标定。good 是「推荐区间」，
// warn 是「可接受区间」，超出 warn 判 bad。单边指标用 goodMax / warnMax。

export const THRESHOLDS = {
  // ---- 站姿（单帧即可判定）----
  stance_width: { good: [1.0, 2.2], warn: [0.75, 2.7], unit: '×肩宽' },
  forearm_vertical: { good: [0, 15], warn: [0, 30], unit: '°' },
  bridge_arm_straight: { good: [152, 180], warn: [130, 180], unit: '°' },
  torso_lean: { good: [38, 78], warn: [22, 88], unit: '°' },
  knee_bend: { good: [142, 174], warn: [120, 179], unit: '°' },
  // 头部要低于肩线。用「鼻 − 肩中点」的垂直分量除以躯干长：
  // 负值=头还在肩上（站得太直），0 附近=头与肩同高，正值=头压到肩下。
  head_low: { good: [0.02, 0.55], warn: [-0.18, 0.8], unit: '×躯干长' },
  // 鼻到「架桥手—握杆手」这条球杆线的水平距离，除以肩宽。
  head_over_cue: { good: [0, 0.38], warn: [0, 0.72], unit: '×肩宽' },

  // ---- 出杆（需要视频序列）----
  stroke_straight: { goodMax: 0.02, warnMax: 0.055, unit: '偏差/行程' },
  elbow_drop: { goodMax: 0.075, warnMax: 0.17, unit: '×躯干长' },
  head_still: { goodMax: 0.14, warnMax: 0.3, unit: '×肩宽' },
  // 送杆：触球（速度峰值）之后手还走的距离 / 触球之前的行程。
  // 钟摆在触球瞬间速度最大，之后靠惯性继续走。掐住不送杆 → 接近 0；
  // 完整送杆 → 大约等于击球前的行程。
  follow_through: { good: [0.3, 1.5], warn: [0.1, 2.6], unit: '×击球前行程' },
  tempo: { good: [1.3, 4.2], warn: [0.85, 6.5], unit: '后摆:前摆' },
};

/** 判定这条测量可不可信：参与计算的关键点 visibility 最低值。 */
const VIS_FLOOR = 0.55;

// ---------------------------------------------------------------- 测量精度
// 下面的数字不是估的，是实测的：把 _research/cand/ 里 17 张真实台球照片做
// 水平镜像后重跑模型，比较同一个物理量两次的读数，取 |Δ| 的中位数。
//
// 为什么镜像是个有效的对照：这 7 项全是关节角、比值、平面距离，对「整体左右
// 反射」严格不变。人的姿态没变，读数变了就只能是模型噪声。
// 复现脚本：_research/flip-stability.mjs（原始数据 _research/flip-stability.json）
//
// 结论（|Δ| 中位数）：
//   stance_width 0.223 个肩宽 / forearm_vertical 19.5° / bridge_arm_straight 13.9°
//   head_low 0.032 个躯干长 / torso_lean 5.2° / knee_bend 10.0° / head_over_cue 0.186 个肩宽
//
// 也就是说：单张照片量出来的「前臂偏 20°」很可能只是模型抖动。所以下面
// 每一项判定都要先跨过 2 倍噪声的死区，否则只能回答「测不准」。
export const METRIC_NOISE = {
  stance_width: 0.223,
  forearm_vertical: 19.48,
  bridge_arm_straight: 13.894,
  head_low: 0.032,
  torso_lean: 5.179,
  knee_bend: 10.002,
  head_over_cue: 0.186,
};

/** 判定区间（good）的宽度。噪声必须明显小于它，结论才有意义。 */
export function bandWidth(t) {
  if (t.good) return t.good[1] - t.good[0];
  return t.warnMax - t.goodMax;
}

/** 噪声 / 判定区间宽度。>0.5 表示噪声和判定区间同量级。 */
export function noiseRatio(id) {
  const t = THRESHOLDS[id];
  const n = METRIC_NOISE[id];
  if (!t || n === undefined) return 0;
  const w = bandWidth(t);
  return w > 0 ? n / w : Infinity;
}

// ---------------------------------------------------------------- 打分工具

/**
 * 区间打分：good 内 1 分，warn 边界 0 分，之间线性。
 * @returns {number|null} 无法测量时返回 null
 */
export function bandScore(value, good, warn) {
  if (!Number.isFinite(value)) return null;
  if (value >= good[0] && value <= good[1]) return 1;
  if (value < good[0]) {
    const span = good[0] - warn[0];
    if (span <= 1e-9) return value <= warn[0] ? 0 : 1;
    if (value <= warn[0]) return 0;
    return (value - warn[0]) / span;
  }
  const span = warn[1] - good[1];
  if (span <= 1e-9) return value >= warn[1] ? 0 : 1;
  if (value >= warn[1]) return 0;
  return (warn[1] - value) / span;
}

/**
 * 带测量死区的打分。
 *
 * 落在 good 区间里 → 1 分（合格这件事不怕噪声：噪声只会把合格的人推出区间，
 * 不会把不合格的人推进来，所以「在区间内」是保守结论）。
 * 落在区间外 → 必须离边界超过 k 倍实测噪声才认，否则返回 indeterminate，
 * 由调用方判成「测不准」，而不是「不合格」。
 *
 * @param {number} value
 * @param {string} id THRESHOLDS 的键，用来查噪声
 * @param {{k?:number, noiseScale?:number}} [opts]
 *   k = 几倍噪声（默认 2）；noiseScale 用来表达「多帧平均把噪声压小了多少」，
 *   取 1/√n（n 帧独立观测）。
 * @returns {{score:number|null, indeterminate:boolean, gap:number, need:number}}
 */
export function measuredScore(value, id, opts = {}) {
  const t = THRESHOLDS[id];
  const k = opts.k ?? 2;
  const noise = (METRIC_NOISE[id] ?? 0) * (opts.noiseScale ?? 1);
  const need = k * noise;

  const score = t.good
    ? bandScore(value, t.good, t.warn)
    : maxScore(value, t.goodMax, t.warnMax);
  if (score === null) return { score: null, indeterminate: false, gap: NaN, need };
  if (score === 1) return { score, indeterminate: false, gap: 0, need };

  const gap = t.good
    ? (value < t.good[0] ? t.good[0] - value : value - t.good[1])
    : value - t.goodMax;
  if (gap < need) return { score: null, indeterminate: true, gap, need };
  return { score, indeterminate: false, gap, need };
}

/**
 * 给一批已打分的检查项套上测量死区。
 *
 * 为什么必须单独做这一步：`bandScore` 只知道「值离参考区间多远」，不知道
 * 「这个值本身有多不可靠」。实测单张照片的噪声能到判定区间宽度的一半以上
 * （见 METRIC_NOISE），不套死区就会把模型抖动说成动作缺陷。
 *
 * 已经判成 unknown 的项（visibility 不足等）原样保留，不覆盖它的原因。
 *
 * @param {Array<object>} checks evaluateSetup 的返回
 * @param {number} [noiseScale] 1 = 单帧；1/√n = n 帧平均
 */
export function applyReliability(checks, noiseScale = 1) {
  return checks.map((c) => {
    if (c.score === null || c.score === undefined) return c;
    if (!THRESHOLDS[c.id]) return c;
    const m = measuredScore(c.value, c.id, { noiseScale });
    if (!m.indeterminate) return { ...c, gapToBand: m.gap, deadZone: m.need };
    return {
      ...c,
      score: null,
      status: 'unknown',
      indeterminate: true,
      gapToBand: m.gap,
      deadZone: m.need,
      detail:
        `量到 ${formatValue(c)}，离参考区间只差 ${m.gap.toFixed(2)}${c.unit === '°' ? '°' : ''}，` +
        `而这一项在单目相机下的实测波动有 ±${(m.need / 2).toFixed(2)}。` +
        `差得还没噪声大，这一项不判。`,
    };
  });
}

/** 把测量值格式化成 detail 文案里能直接用的样子。 */
function formatValue(c) {
  if (!Number.isFinite(c.value)) return '—';
  const digits = c.unit === '°' ? 0 : 2;
  return `${c.value.toFixed(digits)}${c.unit === '°' ? '°' : ''}`;
}

/** 单边打分：value ≤ goodMax 得 1 分，≥ warnMax 得 0 分。 */
export function maxScore(value, goodMax, warnMax) {
  if (!Number.isFinite(value)) return null;
  if (value <= goodMax) return 1;
  if (value >= warnMax) return 0;
  return (warnMax - value) / (warnMax - goodMax);
}

/** 分数 → 状态。 */
export function statusOf(score) {
  if (score === null || score === undefined) return 'unknown';
  if (score >= 0.85) return 'good';
  if (score >= 0.45) return 'warn';
  return 'bad';
}

// ---------------------------------------------------------------- 取景检查

/**
 * 关键点贴边 / 出画时，模型给的是外推值，不能当测量值用。
 *
 * 0.005 = 半个百分点的画面宽度。贴到这个程度说明肢体正好卡在画框上，
 * 模型已经开始编了。
 */
export const FRAME_EDGE_MARGIN = 0.005;

/**
 * 这批点里有没有被画面裁掉的。
 * @returns {boolean} true = 有贴边或出画的点，这次测量必须作废
 */
export function clippedByFrame(pose, names) {
  return frameInset(pose, names) < FRAME_EDGE_MARGIN;
}

/** 给 detail 用的提示语。 */
const CLIPPED_HINT = '有肢体被画面裁掉了，模型只能靠外推补坐标，这一项不判。把全身（含双脚）拍进画面再试。';

// ---------------------------------------------------------------- 几何辅助

/**
 * 水平面内的点到直线距离。y 是竖直方向，所以水平面就是 (x, z)。
 * 「头在球杆正上方」这种判断必须去掉竖直分量，否则头比杆高 20cm
 * 会被算成 20cm 的偏差。
 */
export function horizontalDistanceToLine(p, a, b) {
  const ax = a.x, az = a.z;
  const bx = b.x - ax, bz = b.z - az;
  const denom = bx * bx + bz * bz;
  if (denom < 1e-12) return Math.hypot(p.x - ax, p.z - az);
  let t = ((p.x - ax) * bx + (p.z - az) * bz) / denom;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (ax + bx * t), p.z - (az + bz * t));
}

/**
 * 判断哪只手是「架桥手」、哪只是「握杆手」。
 *
 * 主判据是**肩到腕的距离**：架桥手整条手臂向前伸出去，肩腕距接近臂长；
 * 握杆手的小臂是垂下来的，肩腕距明显更短。这个量对机位不敏感，也不会
 * 因为选手站得高一点低一点就翻转。
 *
 * 如果两条手臂一样长（差值 <5%），退回用肘角：架桥手更直（角度更大）。
 * 两种判据都拿不到时按右手球员处理，但会标 method:'default'，
 * 界面应当让用户手动指定，不要偷偷替用户决定。
 *
 * @returns {{bridge:'left'|'right', grip:'left'|'right', method:'span'|'angle'|'default', margin:number}}
 */
export function detectHandedness(pose) {
  const spanL = distOr(pose.left_shoulder, pose.left_wrist);
  const spanR = distOr(pose.right_shoulder, pose.right_wrist);

  if (Number.isFinite(spanL) && Number.isFinite(spanR) && spanL > 1e-6 && spanR > 1e-6) {
    const margin = Math.abs(spanL - spanR) / Math.max(spanL, spanR);
    if (margin >= 0.05) {
      const leftIsBridge = spanL > spanR;
      return {
        bridge: leftIsBridge ? 'left' : 'right',
        grip: leftIsBridge ? 'right' : 'left',
        method: 'span',
        margin,
      };
    }
  }

  const elbowL = angleAt(pose.left_shoulder, pose.left_elbow, pose.left_wrist);
  const elbowR = angleAt(pose.right_shoulder, pose.right_elbow, pose.right_wrist);
  if (Number.isFinite(elbowL) && Number.isFinite(elbowR) && Math.abs(elbowL - elbowR) > 4) {
    const leftIsBridge = elbowL > elbowR;
    return {
      bridge: leftIsBridge ? 'left' : 'right',
      grip: leftIsBridge ? 'right' : 'left',
      method: 'angle',
      margin: Math.abs(elbowL - elbowR),
    };
  }

  return { bridge: 'left', grip: 'right', method: 'default', margin: 0 };
}

function distOr(a, b) {
  if (!a || !b) return NaN;
  return vec.dist(a, b);
}

/** 取某一侧的关键点，side = 'left' | 'right'。 */
function sideOf(pose, side) {
  return {
    shoulder: pose[`${side}_shoulder`],
    elbow: pose[`${side}_elbow`],
    wrist: pose[`${side}_wrist`],
    hip: pose[`${side}_hip`],
    knee: pose[`${side}_knee`],
    ankle: pose[`${side}_ankle`],
    heel: pose[`${side}_heel`],
    foot: pose[`${side}_foot_index`],
  };
}

/** 一条检查结果的构造器，统一字段。 */
function makeResult(id, label, category, opts) {
  const { value, score, unit, detail, confidence, needs } = opts;
  return {
    id,
    label,
    category,
    value: Number.isFinite(value) ? value : null,
    unit,
    score,
    status: statusOf(score),
    detail,
    confidence,
    needs,
  };
}

// ---------------------------------------------------------------- 站姿检查

/**
 * 对单个姿势做站姿规范性检查。
 *
 * @param {{image:object, world:object, hasWorld:boolean}} pose normalizePose 的输出
 * @param {{handedness?:'auto'|'left'|'right'}} [opts]
 * @returns {Array<object>} 每条检查的结果
 */
export function evaluateSetup(pose, opts = {}) {
  const p = pose.world;
  const hasWorld = pose.hasWorld && Object.keys(p).length > 0;
  const out = [];

  // 世界坐标缺失时全部判 unknown——用 image 坐标算角度会因为透视完全失真
  if (!hasWorld) {
    return [
      makeResult('no_world', '姿态坐标', 'setup', {
        value: NaN,
        score: null,
        unit: '',
        detail: '没有拿到世界坐标，无法做角度判定。',
        confidence: 0,
        needs: [],
      }),
    ];
  }

  const shoulderMid = vec.mid(p.left_shoulder, p.right_shoulder);
  const hipMid = vec.mid(p.left_hip, p.right_hip);
  const shoulderWidth = vec.dist(p.left_shoulder, p.right_shoulder);
  const torsoLen = vec.dist(shoulderMid, hipMid);

  // 尺度归一：肩宽、躯干长都必须有效，否则后面所有比值都无意义
  const scaleOk = shoulderWidth > 1e-3 && torsoLen > 1e-3;

  const handed =
    opts.handedness === 'left' || opts.handedness === 'right'
      ? { bridge: opts.handedness === 'right' ? 'left' : 'right', grip: opts.handedness, method: 'manual', margin: 0 }
      : detectHandedness(p);
  const grip = sideOf(p, handed.grip);
  const bridge = sideOf(p, handed.bridge);

  // ---- 1. 站姿宽度：双脚间距 / 肩宽
  {
    const footGap = vec.dist(p.left_foot_index, p.right_foot_index);
    const value = scaleOk ? footGap / shoulderWidth : NaN;
    const needs = ['left_foot_index', 'right_foot_index', 'left_shoulder', 'right_shoulder'];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      conf < VIS_FLOOR || clipped
        ? null
        : bandScore(value, THRESHOLDS.stance_width.good, THRESHOLDS.stance_width.warn);
    out.push(
      makeResult('stance_width', '站姿宽度', 'setup', {
        value, score, unit: THRESHOLDS.stance_width.unit,
        confidence: conf,
        needs: ['left_foot_index', 'right_foot_index'],
        detail: !Number.isFinite(value)
          ? '量不到双脚位置，站姿宽度无法判定。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '双脚关键点被遮挡，这次测量不可信。'
              : value < THRESHOLDS.stance_width.good[0]
                ? `双脚间距只有肩宽的 ${value.toFixed(2)} 倍，站位偏窄，侧向稳定性不足。把前脚再往外开一点。`
                : value > THRESHOLDS.stance_width.good[1]
                  ? `双脚间距是肩宽的 ${value.toFixed(2)} 倍，站得太开，重心转换会变慢。收一点。`
                  : `双脚间距是肩宽的 ${value.toFixed(2)} 倍，站姿宽度合适。`,
      })
    );
  }

  // ---- 2. 后手前臂垂直度：肘→腕 与竖直向下的夹角
  {
    const value = angleFromUp(vec.sub(grip.wrist, grip.elbow));
    // angleFromUp 给的是与「上」的夹角，竖直向下时是 180，所以取补角
    const tilt = Number.isFinite(value) ? Math.abs(180 - value) : NaN;
    const needs = [`${handed.grip}_elbow`, `${handed.grip}_wrist`];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, [...needs, `${handed.grip}_shoulder`]);

    // 钟摆出杆的解剖前提：肩在上、肘居中、腕在下（世界坐标 y 朝下，
    // 所以要求 shoulder.y <= elbow.y <= wrist.y）。这条不成立时，
    // 「前臂偏离竖直多少度」量到的其实是单目深度误差，不是动作问题。
    // 实测 6 张真实照片里有 4 张不满足，其中 2 张是球员站立持杆、
    // 2 张是俯身角度下模型把肘判到了肩上方。这两种情况都必须判 unknown，
    // 否则会把「模型看不清」说成「你的前臂歪了 87°」。
    const ARM_CHAIN_TOL = 0.02; // 2 cm，给关键点噪声留余量
    const chainOk =
      Number.isFinite(grip.shoulder?.y) &&
      grip.shoulder.y <= grip.elbow.y + ARM_CHAIN_TOL &&
      grip.elbow.y <= grip.wrist.y + ARM_CHAIN_TOL;

    const score =
      conf < VIS_FLOOR || !chainOk || clipped
        ? null
        : bandScore(tilt, THRESHOLDS.forearm_vertical.good, THRESHOLDS.forearm_vertical.warn);
    out.push(
      makeResult('forearm_vertical', '后手前臂垂直', 'setup', {
        value: chainOk && !clipped ? tilt : NaN, score, unit: THRESHOLDS.forearm_vertical.unit,
        confidence: conf,
        needs: [`${handed.grip}_shoulder`, `${handed.grip}_elbow`, `${handed.grip}_wrist`],
        detail: !Number.isFinite(tilt)
          ? '量不到握杆手的小臂，无法判定前臂是否垂直。'
          : clipped
            ? CLIPPED_HINT
            : !chainOk
              ? '握杆手的肩—肘—腕不在一条自上而下的链上（常见于单目深度误差，或人根本没俯身击球）。这一项这次不判。'
              : score === null
                ? '握杆手被遮挡，这次测量不可信。'
                : tilt > THRESHOLDS.forearm_vertical.good[1]
                  ? `前臂偏离竖直 ${tilt.toFixed(0)}°。击球瞬间前臂应接近垂直，否则出杆会画弧、杆头不直。调整握杆手的前后位置。`
                  : `前臂偏离竖直 ${tilt.toFixed(0)}°，符合钟摆出杆的要求。`,
      })
    );
  }

  // ---- 3. 架桥臂伸直度：肩-肘-腕夹角
  {
    const value = angleAt(bridge.shoulder, bridge.elbow, bridge.wrist);
    const needs = [`${handed.bridge}_shoulder`, `${handed.bridge}_elbow`, `${handed.bridge}_wrist`];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      conf < VIS_FLOOR || clipped
        ? null
        : bandScore(value, THRESHOLDS.bridge_arm_straight.good, THRESHOLDS.bridge_arm_straight.warn);
    out.push(
      makeResult('bridge_arm_straight', '架桥臂伸展', 'setup', {
        value, score, unit: THRESHOLDS.bridge_arm_straight.unit,
        confidence: conf,
        needs,
        detail: !Number.isFinite(value)
          ? '量不到架桥手的手臂，无法判定伸展度。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '架桥手被遮挡，这次测量不可信。'
              : value < THRESHOLDS.bridge_arm_straight.good[0]
                ? `架桥臂肘角只有 ${value.toFixed(0)}°，明显弯着。前臂要尽量伸直，架桥才稳、才够长。`
                : `架桥臂肘角 ${value.toFixed(0)}°，伸展充分。`,
      })
    );
  }

  // ---- 4. 头部高度：鼻相对肩线的垂直落差 / 躯干长
  {
    const drop = (p.nose.y - shoulderMid.y) / torsoLen;
    const needs = ['nose', 'left_shoulder', 'right_shoulder'];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      scaleOk && conf >= VIS_FLOOR && !clipped
        ? bandScore(drop, THRESHOLDS.head_low.good, THRESHOLDS.head_low.warn)
        : null;
    out.push(
      makeResult('head_low', '头部高度', 'setup', {
        value: drop, score, unit: THRESHOLDS.head_low.unit,
        confidence: conf,
        needs,
        detail: !Number.isFinite(drop)
          ? '量不到头部与肩的相对位置。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '头部或肩部被遮挡，这次测量不可信。'
              : drop < THRESHOLDS.head_low.good[0]
                ? `头还在肩线上方 ${Math.abs(drop).toFixed(2)} 个躯干长，说明上身没压下去。视线越低越容易看准，试着弯腰或屈膝把下巴降到接近球杆。`
                : `头部比肩线低 ${drop.toFixed(2)} 个躯干长，视线高度到位。`,
      })
    );
  }

  // ---- 5. 躯干前倾：髋中点→肩中点 与竖直的夹角
  {
    const value = angleFromUp(vec.sub(shoulderMid, hipMid));
    const needs = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      scaleOk && conf >= VIS_FLOOR && !clipped
        ? bandScore(value, THRESHOLDS.torso_lean.good, THRESHOLDS.torso_lean.warn)
        : null;
    out.push(
      makeResult('torso_lean', '躯干前倾', 'setup', {
        value, score, unit: THRESHOLDS.torso_lean.unit,
        confidence: conf,
        needs,
        detail: !Number.isFinite(value)
          ? '量不到躯干轴线，无法判定前倾角。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '肩或髋被遮挡，这次测量不可信。'
              : value < THRESHOLDS.torso_lean.good[0]
                ? `躯干只前倾 ${value.toFixed(0)}°，站得太直，眼睛离球太远。上身再压下去一些。`
                : value > THRESHOLDS.torso_lean.good[1]
                  ? `躯干前倾 ${value.toFixed(0)}°，压得过低，腰背和脖子会吃力，出杆空间也变小。`
                  : `躯干前倾 ${value.toFixed(0)}°，重心和视线高度平衡得不错。`,
      })
    );
  }

  // ---- 6. 屈膝：左右膝角的均值
  {
    const kneeL = angleAt(p.left_hip, p.left_knee, p.left_ankle);
    const kneeR = angleAt(p.right_hip, p.right_knee, p.right_ankle);
    const value = Number.isFinite(kneeL) && Number.isFinite(kneeR)
      ? (kneeL + kneeR) / 2
      : Number.isFinite(kneeL) ? kneeL : kneeR;
    const needs = ['left_hip', 'left_knee', 'left_ankle', 'right_hip', 'right_knee', 'right_ankle'];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      conf < VIS_FLOOR || clipped
        ? null
        : bandScore(value, THRESHOLDS.knee_bend.good, THRESHOLDS.knee_bend.warn);
    out.push(
      makeResult('knee_bend', '屈膝程度', 'setup', {
        value, score, unit: THRESHOLDS.knee_bend.unit,
        confidence: conf,
        needs: ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'],
        detail: !Number.isFinite(value)
          ? '量不到膝关节，无法判定屈膝。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '下肢关键点被遮挡（常见于只拍到上半身的照片），这次测量不可信。'
              : value > THRESHOLDS.knee_bend.good[1]
                ? `膝关节接近伸直（${value.toFixed(0)}°），腿部没有缓冲，重心偏高。轻微屈膝让身体更稳。`
                : value < THRESHOLDS.knee_bend.good[0]
                  ? `膝关节只有 ${value.toFixed(0)}°，蹲得太深，重心低但不容易保持稳定。`
                  : `膝关节 ${value.toFixed(0)}°，屈膝程度合适。`,
      })
    );
  }

  // ---- 7. 头在球杆上方：鼻到「架桥手—握杆手」连线的水平距离 / 肩宽
  {
    const value = scaleOk
      ? horizontalDistanceToLine(p.nose, bridge.wrist, grip.wrist) / shoulderWidth
      : NaN;
    const needs = ['nose', `${handed.bridge}_wrist`, `${handed.grip}_wrist`, 'left_shoulder', 'right_shoulder'];
    const conf = minVisibility(p, needs);
    const clipped = clippedByFrame(pose.image, needs);
    const score =
      conf < VIS_FLOOR || clipped
        ? null
        : bandScore(value, THRESHOLDS.head_over_cue.good, THRESHOLDS.head_over_cue.warn);
    out.push(
      makeResult('head_over_cue', '头在球杆上方', 'setup', {
        value, score, unit: THRESHOLDS.head_over_cue.unit,
        confidence: conf,
        needs: ['nose', `${handed.bridge}_wrist`, `${handed.grip}_wrist`],
        detail: !Number.isFinite(value)
          ? '量不到双手位置，无法判定头是否在球杆上方。'
          : clipped
            ? CLIPPED_HINT
            : score === null
              ? '手部或头部被遮挡，这次测量不可信。'
              : value > THRESHOLDS.head_over_cue.good[1]
                ? `头部偏离球杆 ${value.toFixed(2)} 个肩宽，视线不在杆的正上方，容易看偏。把下巴对到球杆上。`
                : `头部偏离球杆 ${value.toFixed(2)} 个肩宽，视线基本压在杆上。`,
      })
    );
  }

  return out;
}

// ---------------------------------------------------------------- 出杆检查
// 这一组需要一段时间的序列，输入是每帧的 normalizePose 结果数组。
// 具体分帧、找击球点、算时间都在 analyze.js 里，这里只放纯测量函数。

export { DEG, LM };
