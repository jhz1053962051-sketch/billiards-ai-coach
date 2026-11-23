// @ts-check
// 指标对照参考区间：把 checks.js 量出来的数字，翻译成「离通行做法有多远、往哪边偏、怎么改」。
//
// 为什么需要这一层：checks.js 只回答「值是多少 / 扣不扣分」。用户看到「前臂倾角 78°」
// 或者「站距 1.45 ×肩宽」并不知道这算好还是坏——没有参照系的数字构不成反馈。
//
// 三条硬约束：
//
//   1. 区间与 THRESHOLDS 同源，不另立一套。ideal 直接取 THRESHOLDS[id].good，
//      tolerance 取 warn 与 good 的差。理由很实际：界面上同一条指标有两个出处时，
//      迟早会出现「检查判合格、对照说偏离」的自相矛盾。要调区间就改 THRESHOLDS 一处。
//
//   2. basis 必须说清「凭什么」。下面的每一条都能落到具体机制（钟摆、骨性支撑、
//      视差、重心线）或公开教练检查表的条目上，**没有任何选手样本统计**。
//      所以文案里不写「职业选手平均」「大多数球员」这类说法——我们手里没有那种数据，
//      写出来就是编。拿不准的地方直接写「教练经验值，未做统计验证」。
//
//   3. unknown 原样传递。缺关键点时 check.value 是 null，这里绝不补一个偏差值；
//      被 applyReliability 判成「测不准」的项（value 有数但 status 是 unknown）同样
//      不算偏差——那正是「差得还没噪声大」的情况，给方向就是给假信息。
//
// 与 checks.js 的 status 不是一回事，别混：
//   checks.js 的 status 来自分数（≥0.85 good / ≥0.45 warn / 其余 bad），
//   这里判的是「值离 ideal 区间多远」（区间内 good / 容差带内 near / 出了容差带 off）。
//   一个刚好出区间 0.05 的值在 checks.js 里可能仍算 good（分数 0.9），在这里是 near。
//   两者分别表达「扣没扣分」和「偏没偏」，界面用两种颜色分别显示，不合并。

import { THRESHOLDS } from './checks.js';

/** 界面上标注这层区间的来源。不许写成「标准动作」——我们没有大样本数据。 */
export const REFERENCE_NOTE = '参考区间（教练经验值）';

/** 随对照结果一起返回的免责说明，界面要把它显示出来，不能只写在注释里。 */
export const REFERENCE_DISCLAIMER =
  '这些区间来自公开教练检查表的条目和生物力学推理，再加上明确的工程余量，' +
  '没有用选手录像做过统计标定。落在区间外只表示「和通行做法不一样」，' +
  '不等于这一杆一定打不进；它给的是方向和优先级，不是判决。';

/**
 * 每个指标两侧偏离的表述名。null = 这一侧在物理上不会出现（例如倾角恒 ≥ 0）。
 * @typedef {{low: string|null, high: string|null}} Direction
 */

/**
 * @typedef {object} Reference
 * @property {string} id
 * @property {[number, number]} ideal 推荐区间（与 THRESHOLDS[id].good 同值）
 * @property {[number, number]} tolerance 区间外还算「接近」的软化量：低侧 / 高侧
 * @property {Direction} direction
 * @property {string} basis 这个区间凭什么
 */

// ---------------------------------------------------------------- 依据
// 每一条都要能落到机制或公开检查表条目上。允许说「工程余量」，
// 不允许说「某选手的平均值」——没有样本支撑那种说法。

const BASIS = {
  stance_width:
    '双脚的横向间距决定侧向支撑面有多宽：上身俯到击球高度后，重力线要从髋落进两脚之间的支撑面里，' +
    '站距越窄这个面越接近一条线，出杆时身体前后左右的晃动就没有落脚点。用肩宽做分母，是因为它随身高和机位缩放，' +
    '比绝对厘米数稳定。下限 1.0 对应公开教练检查表里「双脚至少与肩同宽」这条通行要求；上限 2.2 是工程余量——' +
    '再开下去两腿几乎横分，重心横向转移变慢，前脚还容易挡住出杆通道。',

  forearm_vertical:
    '钟摆出杆时握杆手的小臂绕肘做单摆。击球瞬间小臂越接近竖直，腕部的速度方向就越接近水平（也就是沿瞄准线）：' +
    '小臂与竖直成 θ 角时，腕速里垂直于瞄准线的分量约为 sinθ，15° 就已经有约 26% 的速度走在上下方向，' +
    '杆头会在击球段上下漂。所以上限取 15°，而不是「越直越好」——人手不可能绝对竖直，得留余量。' +
    '这个角由肩—肘—腕三点直接算出，是几何量，不是拟合参数。',

  bridge_arm_straight:
    '架桥臂伸直（肘角接近 180°）时肩到腕的跨度最大，人能在离球足够远的位置趴下来，架桥高度由前臂和手腕的骨性结构承担；' +
    '肘一弯，手就得靠肌肉悬着，出杆一发力就会被压塌，杆头跟着上下走。152° 相当于允许 28° 的自然放松（180−152），' +
    '再弯下去就从「骨架架着」变成「肌肉架着」了。教练检查表把手臂伸直列在 hand bridge 条目下。',

  head_low:
    '视线越低，眼睛离球杆越近，看到的球、杆、目标三点越接近同一条线，视差越小；站直时眼睛比球杆高出一整个躯干长，' +
    '那时靠的是估而不是看。分母取躯干长是为了随身高缩放。0.02 表示头基本压到肩线高度——不压下去就还是站着看球；' +
    '0.55 是上限：再低就得靠低头而不是靠屈髋把视线降下来，脖子和腰会先累。',

  torso_lean:
    '上身越趴，肩（握杆手摆动的悬挂点）就越接近球杆所在的水平面，钟摆的摆动方向才接近水平——' +
    '这是「出杆沿瞄准线」的几何前提。38° 是「明显俯身」的下限，小于它基本还在站着打；78° 接近水平，' +
    '再往前重心会越过前脚、腰背要额外吃力。区间端点就是「肩—髋连线与竖直方向的夹角」，不含拟合参数。',

  knee_bend:
    '屈膝有两个作用：把重心降下来让髋低于肩线，上身才能在不塌腰的前提下趴平；以及给腿一个缓冲，出杆时身体不前后晃。' +
    '142°–174° 相当于膝弯 6°–38°：接近伸直（>174°）时腿没有缓冲、重心偏高，上身只能靠腰背去压；' +
    '蹲太深（<142°）时大腿前侧持续发力，几十秒的准备过程里腿会开始抖。膝角由髋—膝—踝三点算出。',

  head_over_cue:
    '主视眼压在球杆正上方时，球杆在视野里和球的一条线重合，不需要靠经验补角度；头一偏，近端（架桥手）和远端（目标球）' +
    '之间就有视差，偏得越多越靠估。这里量的是鼻到「架桥腕—握杆腕」连线的水平距离（去掉竖直分量，否则头比杆高 20 cm ' +
    '会被算成 20 cm 偏差），再除以肩宽做尺度归一。0.38 个肩宽在成人身上约 15 cm，已经是明显偏头；' +
    '0.72 是「再偏就看不清杆线」的外沿。教练检查表写作 head over the cue / 下巴压杆。',
};

// 每条依据都必须以这句收尾：我们确实没有做过统计标定。
const NO_DATA = '教练经验值，未做统计验证。';

/** 方向名：只在真正能出现的那一侧给名字，另一侧给 null。 */
const DIRECTIONS = {
  stance_width: { low: 'too_narrow', high: 'too_wide' },
  // 倾角是 |180° − 实际角|，永远 ≥ 0，低侧不会出现
  forearm_vertical: { low: null, high: 'too_tilted' },
  // 肘角最大就是 180°，高侧不会出现
  bridge_arm_straight: { low: 'too_bent', high: null },
  head_low: { low: 'too_high', high: 'too_low' },
  torso_lean: { low: 'too_upright', high: 'too_deep' },
  knee_bend: { low: 'too_deep', high: 'too_straight' },
  head_over_cue: { low: null, high: 'off_cue_line' },
};

// 偏离时的文案：word 接在「指标 值，」后面，fix 是「该怎么改」。
// 语气要对事不对人，并且说清机制——只说「偏了」和没说一样。
const PHRASE = {
  stance_width: {
    too_narrow: {
      word: '比推荐下限窄',
      fix: '双脚几乎踩在一条线上，上身俯下去后侧向没有支撑，出杆时身体会跟着晃。把前脚往外开一点，间距接近一又半个肩宽就够。',
    },
    too_wide: {
      word: '比推荐上限宽',
      fix: '两腿分得太开，重心横向转移变慢，前脚还容易挡住出杆通道。站距收回来一点。',
    },
  },
  forearm_vertical: {
    too_tilted: {
      word: '偏离竖直',
      fix: '小臂不竖直，腕部速度就会分出一部分到上下方向，杆头在击球段会画弧。把肘稍微收回来，让肘落在腕的正上方。',
    },
  },
  bridge_arm_straight: {
    too_bent: {
      word: '比推荐下限小',
      fix: '架桥臂弯着，手是靠肌肉悬着的，出杆发力时会被压塌，架桥高度也稳不住。前臂尽量伸直。',
    },
  },
  head_low: {
    too_high: {
      word: '离推荐下限还差',
      fix: '上身还没压下去，眼睛离球杆太远，只能靠估。用屈髋（而不是只低头）把下巴降到接近球杆。',
    },
    too_low: {
      word: '比推荐上限高',
      fix: '头压到肩线以下太多，脖子和腰会吃力，出杆空间也变小。抬一点，视线够低就行，不必把脸贴到杆上。',
    },
  },
  torso_lean: {
    too_upright: {
      word: '比推荐下限小',
      fix: '上身太直，眼睛离球太远，悬挂点（肩）也离球杆所在的平面太远，钟摆方向不水平。屈髋把上身压下去。',
    },
    too_deep: {
      word: '比推荐上限大',
      fix: '压得过低，重心跑到前脚外面，腰背和脖子会先累，出杆空间也变小。抬一点。',
    },
  },
  knee_bend: {
    too_deep: {
      word: '比推荐下限小',
      fix: '蹲得太深，大腿前侧要持续发力，准备阶段几十秒里腿会开始抖。站高一点。',
    },
    too_straight: {
      word: '比推荐上限大',
      fix: '腿接近伸直，没有缓冲，重心偏高，上身只能靠腰背去压。轻微屈膝让身体更稳。',
    },
  },
  head_over_cue: {
    off_cue_line: {
      word: '偏离球杆',
      fix: '视线不在杆的正上方，看到的角度得自己补，容易看偏。把下巴对到球杆上。',
    },
  },
};

/** 方向名为 null 但确实出了区间时的兜底文案（理论上走不到，走到了也不许静默）。 */
const FALLBACK_PHRASE = {
  word: '偏离推荐区间',
  fix: '这一侧没有单独的形容，按对应指标的常规做法调回去即可。',
};

// ---------------------------------------------------------------- 区间表
// 从 THRESHOLDS 生成，避免两套数字漂移。tolerance 就是 warn 与 good 的间隔：
// 区间外到这个位置仍算「接近」，再远才叫「偏离」。

/** @type {Array<{id:string}>} */
const IDS = [
  { id: 'stance_width' },
  { id: 'forearm_vertical' },
  { id: 'bridge_arm_straight' },
  { id: 'head_low' },
  { id: 'torso_lean' },
  { id: 'knee_bend' },
  { id: 'head_over_cue' },
];

/** @type {readonly Reference[]} */
export const REFERENCE = Object.freeze(
  IDS.map(({ id }) => {
    const t = THRESHOLDS[id];
    const lo = t.good[0];
    const hi = t.good[1];
    return {
      id,
      // 元组在这里要显式标出来：从 THRESHOLDS 推出来的是 number[]，
      // 而 Reference 要的是定长两元组（区间条只认两端）。
      ideal: /** @type {[number, number]} */ ([lo, hi]),
      // 容差是单侧的：低侧 = good 下限 − warn 下限，高侧 = warn 上限 − good 上限。
      // 理论上恒为正；max(0, …) 只是防御，不改变任何现有读数。
      tolerance: /** @type {[number, number]} */ ([
        Math.max(0, lo - t.warn[0]),
        Math.max(0, t.warn[1] - hi),
      ]),
      direction: { ...DIRECTIONS[id] },
      basis: `${BASIS[id]}${NO_DATA}`,
    };
  })
);

/** 按 id 查区间。用普通对象字面量，查不到返回 undefined。 */
/** @type {Record<string, Reference>} */
export const REFERENCE_BY_ID = Object.freeze(
  REFERENCE.reduce((acc, r) => {
    acc[r.id] = r;
    return acc;
  }, /** @type {Record<string, Reference>} */ ({}))
);

// ---------------------------------------------------------------- 格式化
// 单位必须和 check.unit 一致（见 checks.js 的 THRESHOLDS[id].unit）：
//   '°'        → 整数 + '°'
//   '×肩宽'     → 两位小数 + ' 个肩宽'
//   '×躯干长'   → 两位小数 + ' 个躯干长'

/** @param {number} v @param {string} unit */
function fmtNum(v, unit) {
  if (!Number.isFinite(v)) return '—';
  return unit === '°' ? String(Math.round(v)) : v.toFixed(2);
}

/** @param {string} unit */
function unitSuffix(unit) {
  if (unit === '°') return '°';
  if (unit === '×肩宽') return ' 个肩宽';
  if (unit === '×躯干长') return ' 个躯干长';
  return unit ? ` ${unit}` : '';
}

/** @param {number} v @param {string} unit */
function fmtWithUnit(v, unit) {
  return `${fmtNum(v, unit)}${unitSuffix(unit)}`;
}

// ---------------------------------------------------------------- 单条对照

/**
 * @typedef {'good'|'near'|'off'|'unknown'} CompareStatus
 */

/**
 * @typedef {object} Comparison
 * @property {CompareStatus} status good=在推荐区间内，near=出了区间但还在容差带，off=出了容差带，unknown=不判
 * @property {number|null} deviation 相对最近理想边界的带符号偏差（区间内 0，高于上限为正）；unknown 恒为 null
 * @property {string|null} direction 偏离方向名（见 DIRECTIONS），区间内与 unknown 均为 null
 * @property {{ideal:[number,number], near:[number,number]}|null} band 画区间条要用的两条边界；无参考区间时为 null
 * @property {string} advice 一句可直接显示的建议
 */

/**
 * 单条指标对照参考区间。
 *
 * 纯函数：不读全局、不写状态、不抛异常。任何异常输入都退化成 unknown。
 *
 * @param {object|null|undefined} check evaluateSetup / evaluateStroke 的一条结果
 * @returns {Comparison}
 */
export function compareMetric(check) {
  const id = check && typeof check.id === 'string' ? check.id : '';
  const unit = check && typeof check.unit === 'string' ? check.unit : '';
  const ref = id ? REFERENCE_BY_ID[id] : undefined;

  // 没有参考区间的项（出杆 5 项、no_world）只报测量值，不做好坏判断。
  if (!ref) {
    return {
      status: 'unknown',
      deviation: null,
      direction: null,
      band: null,
      advice: '这一项没有参考区间，只报测量值，不做好坏判断。',
    };
  }

  const [lo, hi] = ref.ideal;
  const band = {
    ideal: /** @type {[number, number]} */ ([lo, hi]),
    near: /** @type {[number, number]} */ ([lo - ref.tolerance[0], hi + ref.tolerance[1]]),
  };

  const value = check.value;
  // unknown 必须原样传递：
  //   a) 缺关键点 → value 是 null；
  //   b) applyReliability 判成「测不准」→ value 有数但 status 是 unknown，
  //      这时按数算偏差正好会把「差得还没噪声大」说成一个方向，必须挡住。
  if (check.status === 'unknown' || !Number.isFinite(value)) {
    const missing = Array.isArray(check.missing) ? check.missing : [];
    let advice;
    if (missing.length) {
      advice = `缺少关键点 ${missing.join('、')}，这一项这次比不了。`;
    } else if (check.indeterminate) {
      advice = '量到的值离推荐边界还不如单目相机的波动大，这一项不判——先别拿它当结论。';
    } else {
      advice = '这次没量到这个值（被遮挡或不够可信），不做对照。';
    }
    return { status: 'unknown', deviation: null, direction: null, band, advice };
  }

  let side = null;
  if (value > hi) side = 'high';
  else if (value < lo) side = 'low';

  const deviation = side === 'high' ? value - hi : side === 'low' ? value - lo : 0;
  const direction = side ? ref.direction[side] : null;
  const status = side === null
    ? 'good'
    : value >= band.near[0] && value <= band.near[1]
      ? 'near'
      : 'off';

  const label = typeof check.label === 'string' && check.label ? check.label : id;
  const shown = fmtWithUnit(value, unit);
  const range = `${fmtNum(lo, unit)}–${fmtNum(hi, unit)}${unitSuffix(unit)}`;

  if (status === 'good') {
    return {
      status,
      deviation,
      direction,
      band,
      advice: `${label} ${shown}，在参考区间（${range}）内，保持住。`,
    };
  }

  const phrase = (direction && PHRASE[id]?.[direction]) || FALLBACK_PHRASE;
  const gap = fmtWithUnit(Math.abs(deviation), unit);
  const tail = status === 'near' ? '刚出推荐区间，还在容差带里' : '已经出了容差带';
  return {
    status,
    deviation,
    direction,
    band,
    advice: `${label} ${shown}，${phrase.word} ${gap}，${tail}——${phrase.fix}`,
  };
}

// ---------------------------------------------------------------- 批量对照

/**
 * 一批指标逐条对照。
 *
 * 顺序与输入一致（界面按 setup 的顺序排，不重排）；不做过滤，输入几条就出几条，
 * 这样「7 项里几项偏离」的分母才和界面上看到的行数对得上。
 *
 * @param {Array<object>|null|undefined} checks
 * @returns {{items:Array<object>, summary:{good:number, near:number, off:number, unknown:number}}}
 */
export function compareAll(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const items = list.map((c) => {
    const cmp = compareMetric(c);
    const id = c && typeof c.id === 'string' ? c.id : 'unknown';
    const ref = REFERENCE_BY_ID[id];
    return {
      id,
      label: c && typeof c.label === 'string' ? c.label : '',
      // unknown 的项不报数值：null 才是「没测到」，0 会被读成「量到零」
      value: c && Number.isFinite(c.value) ? c.value : null,
      unit: c && typeof c.unit === 'string' ? c.unit : '',
      // 区间依据跟着数据走：界面上的「每条区间的依据」直接渲染它，不另抄一份文案
      basis: ref ? ref.basis : '',
      ...cmp,
    };
  });

  /** @type {{good:number, near:number, off:number, unknown:number}} */
  const summary = { good: 0, near: 0, off: 0, unknown: 0 };
  for (const it of items) {
    const k = it.status;
    if (k === 'good' || k === 'near' || k === 'off') summary[k] += 1;
    else summary.unknown += 1;
  }
  return { items, summary };
}

/**
 * 总评一句话：几项在区间内、几项接近、几项偏离、几项测不到。
 * 分母用「测到的项」而不是全部项——测不到的项不该被算成「没偏离」。
 *
 * @param {{good?:number, near?:number, off?:number, unknown?:number}|null|undefined} summary
 * @returns {string}
 */
export function describeSummary(summary) {
  const s = summary ?? {};
  const good = Number.isFinite(s.good) ? s.good : 0;
  const near = Number.isFinite(s.near) ? s.near : 0;
  const off = Number.isFinite(s.off) ? s.off : 0;
  const unknown = Number.isFinite(s.unknown) ? s.unknown : 0;
  const measured = good + near + off;

  if (measured + unknown === 0) return '没有可对照的指标。';
  if (measured === 0) return `${unknown} 项都没测到，这次没法和参考区间对照。`;

  const parts = [`${measured} 项里 ${good} 项在参考区间内`];
  if (near) parts.push(`${near} 项接近边界`);
  if (off) parts.push(`${off} 项偏离`);
  let text = `${parts.join('，')}。`;
  if (unknown) text += `另有 ${unknown} 项测不到，没参与对照。`;
  return text;
}