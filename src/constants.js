// 物理与器材常数 —— 全部 SI 单位（米 / 秒 / 千克 / 弧度）
//
// 来源与许可证说明（本项目为 MIT，下列引用均兼容）：
//   · ekiefl/pooltool (Apache-2.0)  —— 球台与球的质量/半径量级、滚动-滑动状态机划分
//   · ctbot000/three-cushion-billiards (MIT) —— 事件驱动求解的步长与停止阈值取法
//   · 台球运动学本身来自公开论文（Coriolis 1835；Marquardt；Han 2005；Mathavan 2010）
// 未采用：tailuge/billiards 为 GPL-3.0，其源码仅作对照阅读，未复制任何实现。

export const G = 9.81;

/** 球台预设：playing surface 指两库面之间的净尺寸。 */
export const TABLE_PRESETS = {
  // 中式八球 / 美式八球常见 9 尺台
  pool9: {
    id: 'pool9',
    label: '9 尺美式台',
    length: 2.54,
    width: 1.27,
    ballRadius: 0.028575, // 57.15 mm 直径
    ballMass: 0.17,
    // 库边在离角袋中心多远处收口（沿库方向），决定袋口宽度
    cornerJaw: 0.074,
    // 中袋口沿库方向的半宽
    middleJaw: 0.063,
  },
  // 中式八球 8 尺台（国内球房最常见）
  pool8: {
    id: 'pool8',
    label: '8 尺中式台',
    length: 2.24,
    width: 1.12,
    ballRadius: 0.028575,
    ballMass: 0.17,
    cornerJaw: 0.072,
    middleJaw: 0.062,
  },
  // 斯诺克 12 尺台
  snooker: {
    id: 'snooker',
    label: '12 尺斯诺克台',
    length: 3.569,
    width: 1.778,
    ballRadius: 0.0261875, // 52.375 mm
    ballMass: 0.142,
    cornerJaw: 0.062,
    middleJaw: 0.053,
  },
};

/**
 * 斯诺克台面的固定点位（WPBSA 器材规格，净台面 3569 × 1778 mm）。
 *
 * 放在这里而不是 rack.js / snooker.js，是因为两边都要用：摆球要知道点位，
 * 规则要知道「彩球该回哪个点」。谁 import 谁都会绕出一个环，所以统一放常量层。
 *
 *   · 开球线（baulk line）距开球端库面 737 mm
 *   · 半圆区（the D）半径 292 mm，圆心在开球线中点
 *   · 黑球距顶库 324 mm
 */
export const SNOOKER_SPOTS = Object.freeze({
  baulkX: 0.737,
  dRadius: 0.2921,
  blackFromTop: 0.324,
});

/** 球与台呢、球与库、球与球的相互作用参数。 */
export const PHYS = {
  /** 重力加速度，物理核内部统一从这里取 */
  g: G,
  /** 滑动摩擦系数：球在台呢上打滑阶段的减速度 = muSlide * g */
  muSlide: 0.2,
  /** 滚动阻力系数：纯滚动阶段减速度 = muRoll * g */
  muRoll: 0.01,
  /** 绕竖直轴的旋转（塞）衰减率 */
  muSpin: 0.022,
  /** 库边法向恢复系数 */
  cushionRestitution: 0.85,
  /** 库边摩擦系数：把侧旋换算成出库角度的偏移 */
  cushionFriction: 0.2,
  /** 库边接触点沿库面方向的滑移折减（低于 1 才不会一库掉一半速度） */
  cushionRollSlip: 0.25,
  /** 袋角（护角橡皮）的恢复系数：比库面软得多，撞上去能量损失明显。
   *  取 0.55 的依据是袋角是实心橡皮衬垫、且入射面还有一段是绒布。
   *  以前这里没有独立的袋角响应：球从袋口缝隙挤出台面时只把法向速度清零，
   *  等于「撞到袋角就停在原地」，贴库薄球因此全都变成死球。 */
  jawRestitution: 0.55,
  /** 球球法向恢复系数，酚醛树脂接近弹性 */
  ballRestitution: 0.95,
  /** 球球切向摩擦：产生"甩球"(throw) 与旋转传递。
   *  取 0.04 时中等力度 45° 切球的甩球角约 2.3°，落在公开实测的 1–3° 区间内。 */
  ballFriction: 0.04,
  /** 速度低于此值判为静止，否则永远在爬 */
  stopSpeed: 0.005,
  /** 自转低于此值判为停转 */
  stopSpin: 0.4,
  /** 球球法向相对速度低于此值时按完全非弹性处理，避免贴球极限环 */
  contactDamping: 0.05,
};

/** 击球力度上下限（母球初速度，m/s）。 */
export const SPEED = {
  min: 0.55,
  /** 普通业余中等力度约 2.2 m/s，暴冲约 6.6 m/s */
  soft: 1.2,
  medium: 2.2,
  firm: 3.6,
  break: 6.6,
};

/** 杆头偏移上限（以球半径为单位）：超过 0.5 在现实中会滑杆。 */
export const MAX_TIP_OFFSET = 0.5;

/** 仿真步长。
 *
 *  这两个值不是随手取的，它们由「一子步内球会不会整个跳过袋口」决定：
 *  settlePockets 只在子步结束时检查球心是否落在袋口捕获圆内，
 *  所以一子步的位移必须小于最小的捕获半径，否则球会从袋口飞过去而不算进袋。
 *
 *  实测（pool9 台）：最小捕获半径 = middleJaw = 63.0 mm；
 *  最高球速 = SPEED.break = 6.6 m/s。于是
 *    1/240 → 一子步 27.5 mm，安全余量 2.3 倍
 *    1/120 → 一子步 55.0 mm，安全余量 1.15 倍，是能用的最粗步长
 *    1/60  → 一子步 110.0 mm，超过捕获半径，实测出现「1/240 判进袋、1/60 判没进」
 *
 *  SEARCH_DT 就是按这条边界定的：它同时用于求解器验证（solver.js 的 trialShot）
 *  和真正执行击球（rules.js 的 simulateShot），两边必须一致——
 *  验证的意义是预测实际会发生什么，步长不同就预测的是另一件事。
 */
export const FIXED_DT = 1 / 240;
export const SEARCH_DT = 1 / 120;

/** 单杆最长仿真时间，防止卡死。真实击球（rules 的 simulateShot）和对手打分仿真走这个值。 */
export const MAX_SHOT_TIME = 26;

/**
 * 一次求解里三种试探仿真的时间上限。
 *
 * 以前这四个时限是四个散落的字面量（solver 20 / solver 16 / safety 20 / 默认 26），
 * 改一处漏两处就会让「验证时算出来的」和「真打时发生的事」不是同一件事。
 * 收拢成具名常量时**数值一个都没动**，只是让来源可查、diff 可读：
 *  - SOLVE_MAX_TIME 20：solver.js 的 trialShot，每次候选验证都跑它
 *  - TUNE_MAX_TIME 16：solver.js 的 solveBankDirection，翻袋方向迭代（单球、更短）
 *  - SHOOT_MAX_TIME 20：safety.js 的 shoot，防守候选验证
 *  - 真实击球不另设值，继续用 MAX_SHOT_TIME=26（要给球留足停下来的时间）
 */
export const SOLVE_MAX_TIME = 20;
export const TUNE_MAX_TIME = 16;
export const SHOOT_MAX_TIME = 20;

/** 时限登记表：sim.js 的调用方按用途取值，测试用它核对「常量表与实际调用一致」。 */
export const SHOT_TIME_LIMITS = Object.freeze({
  solve: SOLVE_MAX_TIME,
  tune: TUNE_MAX_TIME,
  safety: SHOOT_MAX_TIME,
  play: MAX_SHOT_TIME,
});

/**
 * 切角上限（度）：切角超过它就不认这一杆。
 *
 * 进攻判定（solver 的 solveShot / bestNextShot）用 82°，安全球判定（safety 的
 * solveSafety）用 78°——**这不是同一条边界**，78 更保守，所以同一杆完全可能出现
 * 「进攻说能打、防守说打不了」。安全球一侧那句「与 solveShot 同一条边界」是错的注释，
 * 已按实情改写。
 *
 * 本次只做「常量具名 + 注释纠错」，两个数值都保持原样：把它们并成一个会让 78–82°
 * 之间原本判为可打的球变成「打不了」，那是产品决策，不是重构。
 */
export const MAX_CUT_ATTACK_DEG = 82;
export const MAX_CUT_SAFETY_DEG = 78;

/**
 * 候选剪枝：一级按解析量排序后，只对前 K 名做「杆法 × 力度」仿真细扫。
 *
 * 为什么 K=3、为什么回退最多 1 个，以及 48 局面的命中率实测，都写在
 * solver.js 的 rankGeoCandidates 注释里（取舍与已知风险要能就地读到）。
 * 想跑旧的全量路径做对照：solveShot(table, balls, { exhaustive: true })
 * 或环境变量 SOLVE_EXHAUSTIVE=1。
 */
export const SOLVE_PRUNE_K = 3;
export const SOLVE_PRUNE_FALLBACK = 1;
