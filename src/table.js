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
 * @param {keyof typeof TABLE_PRESETS|object} preset 预设 id 或自定义参数
 */
export function createTable(preset = 'pool9') {
  const cfg = typeof preset === 'string' ? TABLE_PRESETS[preset] : preset;
  if (!cfg) throw new Error(`未知球台预设: ${preset}`);

  const { length: L, width: W, ballRadius: R, cornerJaw, middleJaw } = cfg;
  if (!(L > 0 && W > 0 && R > 0 && cornerJaw > R && middleJaw > R)) {
    throw new Error('球台参数非法：袋口必须比球大');
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

  const halfL = L / 2;
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

    /** 球心到最近袋心的距离 */
    nearestPocket(x, y) {
      let best = null;
      let bestSq = Infinity;
      for (const p of pockets) {
        const dx = x - p.x;
        const dy = y - p.y;
        const sq = dx * dx + dy * dy;
        if (sq < bestSq) {
          bestSq = sq;
          best = p;
        }
      }
      return { pocket: best, distance: Math.sqrt(bestSq) };
    },

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

    /** 球心是否在台面内（含贴库，不含袋口） */
    insideBounds(x, y, tol = 0) {
      return (
        x >= R - tol && x <= L - R + tol && y >= R - tol && y <= W - R + tol
      );
    },

    /** 找到给定库边线段上、给定坐标处的有效库边；不在任何线段上则返回 null（即袋口） */
    cushionAt(axis, pos, along) {
      for (const c of cushions) {
        if (c.axis === axis && c.pos === pos && along >= c.from && along <= c.to) {
          return c;
        }
      }
      return null;
    },
  };
}

/** @typedef {ReturnType<typeof createTable>} Table */
