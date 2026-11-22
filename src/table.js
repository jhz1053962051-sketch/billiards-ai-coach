// @ts-check
// 球台几何：袋口、库边线段、以及"球心是否已经进袋"的判定。
//
// 设计取舍（对照调研结论）：
//   · pooltool 用完整的 3D 库边组件 + 袋口多边形，精度高但依赖 Panda3D；
//   · tailuge/billiards 用 Three.js 场景里的 PocketGeometry/Knuckle 对象；
//   · 本项目只需要 2D 平面精度，因此把袋口抽象成"圆形捕获区"，库边抽象成
//     "带缺口的轴对齐线段"。这是 ctbot000/three-cushion-billiards 的同款简化，
//     但台球桌有袋，缺口必须与袋口捕获半径对齐，否则会出现球从袋口边缘漏出台面。

import { TABLE_PRESETS } from './constants.js';

/**
 * @typedef {{x:number,y:number}} Vec2
 * @typedef {{id:string,kind:'corner'|'middle',x:number,y:number,captureR:number,captureRSq:number}} Pocket
 * @typedef {{axis:'x'|'y',pos:number,from:number,to:number,normal:Vec2,id:string}} Cushion
 */

/**
 * 建一张球台。
 *
 * 参数不做静默钳制：几何上画不出台面的参数直接抛错。原因见下面校验段的注释。
 *
 * @param {keyof typeof TABLE_PRESETS|object} preset 预设 id 或自定义参数
 */
export function createTable(preset = 'pool9') {
  const cfg = typeof preset === 'string' ? TABLE_PRESETS[preset] : preset;
  if (!cfg) throw new Error(`未知球台预设: ${preset}`);

  const { length: L, width: W, ballRadius: R, cornerJaw, middleJaw } = cfg;

  // ── 参数自洽性校验 ──────────────────────────────────────────────────
  // 必须在建台时抛错，而不是建出一张"看着正常、几何已经坏了"的台：极端参数不会让
  // 任何一行代码报错，只会让库边段 from > to 反向；线段反向之后那一段库就永远
  // 命不中（任何按 from..to 查库边的代码都会落空），等于整段消失，球会从缺口
  // 直接滚出台面，而没有任何一处提示。
  //
  // 下面每条都只拒绝"几何上画不出台面"的参数。现有全部调用点（三个预设、
  // demo/app.js 的换台、demo/save.js 的读档、测试里的自定义台）都满足，
  // 所以这些校验拒绝的是坏数据，不是任何现有玩法。
  const dims = [
    ['length', L],
    ['width', W],
    ['ballRadius', R],
    ['cornerJaw', cornerJaw],
    ['middleJaw', middleJaw],
  ];
  for (const [name, v] of dims) {
    // 有限性先判：NaN/Infinity 参与下面的比较恒为 false，会落到别的检查上给出误导性的报错
    if (!Number.isFinite(v) || v <= 0) {
      throw new Error(`球台参数非法：${name} 必须是正的有限数（收到 ${String(v)}）`);
    }
  }
  if (!(cornerJaw > R && middleJaw > R)) {
    throw new Error('球台参数非法：袋口必须比球大');
  }

  const halfL = L / 2;

  // 球心可行域 bounds 必须非空：minX=R < maxX=L-R
  if (!(L > 2 * R && W > 2 * R)) {
    throw new Error(`球台参数非法：台面 ${L}×${W} 装不下直径 ${2 * R} 的球`);
  }
  // 短库（rail-l / rail-r）跨度 = W - 2*cornerJaw，必须为正
  if (!(cornerJaw < W / 2)) {
    throw new Error(
      `球台参数非法：cornerJaw ${cornerJaw} 不小于台宽的一半 ${W / 2}，短库边段会反向`
    );
  }
  // 长库左段 = [cornerJaw, halfL - middleJaw]，必须为正。
  // 这条与"角袋与中袋的捕获圆不相交"是同一个不等式（两袋心距 halfL）。
  if (!(halfL - middleJaw > cornerJaw)) {
    throw new Error(
      `球台参数非法：halfL - middleJaw (${halfL - middleJaw}) 必须大于 cornerJaw (${cornerJaw})，` +
        '否则长库左段反向、角袋与中袋捕获圆相交'
    );
  }
  // 上下两个中袋的捕获圆（袋心距 W）不能相交
  if (!(W > 2 * middleJaw)) {
    throw new Error(
      `球台参数非法：middleJaw ${middleJaw} 不小于台宽的一半 ${W / 2}，上下中袋捕获圆相交`
    );
  }

  /** @type {Pocket[]} */
  const pockets = [
    { id: 'c-bl', kind: 'corner', x: 0, y: 0, captureR: cornerJaw, captureRSq: cornerJaw * cornerJaw },
    { id: 'c-br', kind: 'corner', x: L, y: 0, captureR: cornerJaw, captureRSq: cornerJaw * cornerJaw },
    { id: 'c-tl', kind: 'corner', x: 0, y: W, captureR: cornerJaw, captureRSq: cornerJaw * cornerJaw },
    { id: 'c-tr', kind: 'corner', x: L, y: W, captureR: cornerJaw, captureRSq: cornerJaw * cornerJaw },
    { id: 'm-b', kind: 'middle', x: L / 2, y: 0, captureR: middleJaw, captureRSq: middleJaw * middleJaw },
    { id: 'm-t', kind: 'middle', x: L / 2, y: W, captureR: middleJaw, captureRSq: middleJaw * middleJaw },
  ];

  /** @type {Cushion[]} */
  const cushions = [
    // 下库 y = 0，被中袋缺口切成两段
    { id: 'rail-b-l', axis: 'y', pos: 0, from: cornerJaw, to: halfL - middleJaw, normal: { x: 0, y: 1 } },
    { id: 'rail-b-r', axis: 'y', pos: 0, from: halfL + middleJaw, to: L - cornerJaw, normal: { x: 0, y: 1 } },
    // 上库 y = W
    { id: 'rail-t-l', axis: 'y', pos: W, from: cornerJaw, to: halfL - middleJaw, normal: { x: 0, y: -1 } },
    { id: 'rail-t-r', axis: 'y', pos: W, from: halfL + middleJaw, to: L - cornerJaw, normal: { x: 0, y: -1 } },
    // 左库 x = 0
    { id: 'rail-l', axis: 'x', pos: 0, from: cornerJaw, to: W - cornerJaw, normal: { x: 1, y: 0 } },
    // 右库 x = L
    { id: 'rail-r', axis: 'x', pos: L, from: cornerJaw, to: W - cornerJaw, normal: { x: -1, y: 0 } },
  ];

  return {
    preset: cfg.id,
    label: cfg.label,
    length: L,
    width: W,
    ballRadius: R,
    ballMass: cfg.ballMass,
    pockets,
    cushions,
    /** 球心允许活动的矩形范围（贴库时球心仍在内侧一个半径处） */
    bounds: { minX: R, maxX: L - R, minY: R, maxY: W - R },

    // 这里曾有 nearestPocket(x, y)：返回最近袋心与欧氏距离。生产代码零调用
    // （physics.js 走 pocketAt 的外接正方形预筛，从不问"最近的袋是哪个"），
    // 只有 test/table.test.js 在用：一条是它自己的专项用例，另一条只是拿它当
    // 工具去验「库边端点必须抵到袋口捕获圆」。后一条约束有价值，已改成在测试
    // 里直接用 pockets 算最近袋；API 与其专项用例一并删除，避免留下只有测试
    // 才走的分支。

    /**
     * 球心是否已经落在某个袋的捕获区内。
     *
     * 这是整个物理核里调用最频繁的函数：单次 solveShot 会调用它 16.7 万次，
     * 其中命中的只有 18 次（0.011%）。也就是说 99.99% 的计算都在回答"不在袋里"，
     * 那这个判定就必须按"最便宜的先算"来排：
     *
     *   1. 轴对齐矩形排除——捕获圆的外接正方形，只要点不在里面就一定不在圆里。
     *      两次减法两次比较就能排掉台面中部的绝大多数位置（球绝大多数时间在中部），
     *      一次开方都不用做；
     *   2. 平方距离——过了矩形筛查的点才值得算距离，而且只比 dx²+dy² ≤ r²，
     *      不需要开方。Math.hypot 有溢出保护，实测比 sqrt(dx²+dy²) 慢 1.6 倍，
     *      比直接比平方慢 1.8 倍，在这里完全没必要；
     *   3. 只有当某颗球真的落在矩形里、又要判断具体是哪个袋时，才走到 sqrt——
     *      而这条路径在整局里只发生十几次。
     *
     * 正确性：袋口捕获判定本来就是"≤ r"的圆形包含关系，换成平方比较是恒等变换，
     * 不是近似。台球坐标范围（< 4 m）内 dx²+dy² 不可能溢出双精度，
     * 也不存在 Math.hypot 那套溢出保护要解决的场景。
     *
     * 边界（契约已明确，见 test/table.test.js 的对应用例）：判定是**闭圆**，
     * 恰好等于 r 仍算进袋，而且这条只沿轴向精确——45° 方向取 (r/√2, r/√2) 时
     * 2·(r/√2)² 可能比 r² 大 1 ulp，于是该点落在圆外。那不是判定错误：这两个浮点
     * 坐标的真实距离确实略大于 r。物理核按 27.5 mm/子步推进，不可能依赖"恰好压线"
     * 这一测度零集合，所以这里不加容差去放大捕获区（加了反而是没有依据的放宽）。
     */
    pocketAt(x, y) {
      for (let i = 0; i < pockets.length; i++) {
        const p = pockets[i];
        const dx = x - p.x;
        const dy = y - p.y;
        // 外接正方形快速排除：不在框里的点，开方都不用算
        if (dx > p.captureR || dx < -p.captureR || dy > p.captureR || dy < -p.captureR) continue;
        if (dx * dx + dy * dy <= p.captureRSq) return p;
      }
      return null;
    },

    /**
     * 球心是否在 bounds 矩形内（含贴库，**不查袋口**）。
     *
     * "不含袋口"是刻意契约，不是漏检查：这里的语义是"球心落在矩形可行域内"，
     * 进袋是另一件事，由 pocketAt 判（physics.js 的 settlePockets 每子步用它）。
     * 两个生产调用点都依赖这条纯矩形语义，改成"再排除袋口"会改变玩法：
     *
     *   · solver.js:818 组合球的假想点检查（tol = -R/2）——假想点落在袋口捕获圆
     *     附近是正常的进攻几何，加袋口排除会把袋口附近的组合球候选整条丢掉，
     *     求解结果随之改变；
     *   · rules.js:867 placementAllowed 的持球摆位合法性——加袋口排除就收窄了
     *     可摆位范围，那是规则变化，不是纠错。
     *
     * 所以袋口附近的球"算不算出台"不在这里回答；能否落下由物理核判。
     *
     * @param {number} tol 正数放宽、负数收缩（solver 传 -R/2）
     */
    insideBounds(x, y, tol = 0) {
      return (
        x >= R - tol && x <= L - R + tol && y >= R - tol && y <= W - R + tol
      );
    },

    // 这里曾有 cushionAt(axis, pos, along)：按 axis/pos/along 查库边线段。
    // 生产代码从未调用（physics.js 的库边碰撞按自己的 axis/pos 判定，不进这里），
    // 只有 test/table.test.js 的专项用例在用它，用例随 API 一并删除。库边几何
    // 仍由两条更强的用例锁住：每段端点正好抵到相邻袋口的捕获圆、库边总长
    // = 周长 - 8*cornerJaw - 4*middleJaw。若将来要把库边查询接进物理核，
    // pos 必须回读 `c.pos` 之类的原值（0 / 台长 / 台宽），不要用球坐标重算。
  };
}

/** @typedef {ReturnType<typeof createTable>} Table */
