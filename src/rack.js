// 标准黑八球组与摆球。
//
// 球组依据 WPA《International 8-Ball Rules》v1a（2021-02）第 3 节原文：
//   "fifteen object balls, seven red, seven yellow and a striped eight ball"，
//   对应到本项目（用美式编号而非红黄配色）即 1–7 全色、8 号、9–15 花色。
// 摆球依据同文档第 5 节：「8 号球摆在 8 号点上，顶点球压在摆球线头部标记上」。
//
// 注意：该文档没有规定"后排两底角一全色一花色"，那是 BCA/中式八球赛事的
// 通行摆法而非本条规则的字面要求。本项目采用它，是因为这样摆出的三角阵
// 在开球时两侧受力更对称；代码注释里标注为"赛事惯例"而非"规则要求"。
//
// 摆球几何：三角紧密堆积。同排球心间距 2R，相邻排球心间距 2R·sin60° = √3·R。
// 这一几何关系是等边三角形堆积的直接结果，不涉及任何第三方实现。
//
// 全色/花色怎么排：
//   WPA 2026 §4.2 只说 "The other balls are placed in the triangle without
//   purposeful or intentional pattern"（其余球不作有意排列），随机即可；
//   但中式八球传统摆法（CBSA《中式台球比赛规则》2017 大师赛版）写的是
//   "其它目标球要尽量使花色和全色尽量分开，但必须彼此紧贴"。
//   本项目按后者做——不是为了合规（两者都合规），而是随机摆出来的三角阵
//   经常出现同排三颗全色相连，玩家一眼就看出"这不是标准摆法"。
//
//   下面的 RACK_PATTERN 是穷举搜索的结果（脚本见 _research/rack-optimal.mjs）：
//   在「8 号在第三排正中 + 两底角一全一花」约束下，15 个位置 30 条相贴边中，
//   同组相贴的边数最少是 7 条——这是可证明的最优值，任何摆法都做不到更少。
//   搜索到的 15 个等价模板取其一；镜像（左右翻转）由 seed 决定，具体号码在
//   组内洗牌，所以每次摆出的球不同，但花色分布始终是最优的。

/** 标准球色（1–7 与 9–15 同色系，后者带白条）。 */
const COLORS = {
  1: '#f2c230',
  2: '#1f4fd8',
  3: '#d62b2b',
  4: '#7b2fa8',
  5: '#f07a1a',
  6: '#1a8a44',
  7: '#8e2323',
  8: '#16181c',
};

/** 母球号码约定：0 号，且没有花色。 */
export const CUE_NUMBER = 0;

/**
 * 一颗球的视觉与规则属性。
 * @param {number} number 0 表示母球
 * @returns {{number:number, color:string, stripe:boolean, group:'cue'|'solid'|'eight'|'stripe'}}
 */
export function ballStyle(number) {
  if (number === 0) return { number: 0, color: '#f6f2e8', stripe: false, group: 'cue' };
  if (number === 8) return { number: 8, color: COLORS[8], stripe: false, group: 'eight' };
  const base = number > 8 ? number - 8 : number;
  return {
    number,
    color: COLORS[base] ?? '#8a8f98',
    stripe: number > 8,
    group: number > 8 ? 'stripe' : 'solid',
  };
}

/** 1–7 → solid，9–15 → stripe，8 → eight，0 → cue。 */
export function groupOf(number) {
  return ballStyle(number).group;
}

/** 15 颗目标球的号码。 */
export const RACK_NUMBERS = Array.from({ length: 15 }, (_, i) => i + 1);

/**
 * 全色/花色的最优分布模板（槽位 0..14 按行优先）。
 *
 * 由穷举搜索得到（`_research/rack-optimal.mjs`）：在 8 号居第三排正中、
 * 两底角一全一花的约束下，15 个球位共 30 条相贴边，同组相贴的边数
 * 最少就是 7——不是近似，是穷举完所有合法摆法的下界。
 *
 *   S S
 *   T 8 S        ← 8 号在第三排正中
 *  S S T T
 *  S T T S T
 *
 * 'S' = 全色（1–7），'T' = 花色（9–15），'8' = 八号球。
 */
export const RACK_PATTERN = Object.freeze([
  'S', 'S', 'T', 'T', '8', 'S', 'S', 'S', 'T', 'T', 'S', 'T', 'T', 'S', 'T',
]);

/** 三角阵槽位的行列坐标：第 0 排 1 颗、第 4 排 5 颗，行优先。 */
const SLOT_ROWS = (() => {
  const out = [];
  for (let row = 0; row < 5; row++) for (let j = 0; j <= row; j++) out.push({ row, j });
  return out;
})();

/** 三角阵里相贴（球心间距恰为 2R）的槽位对，共 30 对。 */
export const RACK_ADJACENCY = (() => {
  const at = new Map(SLOT_ROWS.map((p, i) => [p.row + ':' + p.j, i]));
  const pairs = [];
  for (let i = 0; i < SLOT_ROWS.length; i++) {
    const { row, j } = SLOT_ROWS[i];
    for (const [dr, dj] of [[0, 1], [1, 0], [1, 1]]) {
      const k = at.get(row + dr + ':' + (j + dj));
      if (k !== undefined) pairs.push([i, k]);
    }
  }
  return pairs;
})();

/** 一组组别标记里，同组相贴的边数。用于校验摆法质量。 */
export function sameGroupEdges(groups) {
  let n = 0;
  for (const [i, j] of RACK_ADJACENCY) if (groups[i] === groups[j]) n++;
  return n;
}

/** mulberry32：32 位确定性伪随机，保证同一 seed 摆出同一副球，测试可复现。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 把一组号码排成三角阵。
 *
 * 空位按行填充：第 0 行 1 颗、第 1 行 2 颗 …… 第 4 行 5 颗，共 15 个位置。
 * 只有恰好 15 颗时才套用比赛摆法（顶点在脚点、8 号在第三排正中、后排两底角
 * 一全色一花色、全色与花色按最优模板岔开），不足 15 颗时按洗牌顺序填充
 * ——此时任何"标准"摆法都不成立。
 *
 * @param {object} table
 * @param {number[]} numbers 要摆放的目标球号码（不含母球）
 * @param {{seed?:number, footX?:number}} [opts]
 * @returns {Array<{number:number,x:number,y:number}>}
 */
export function rackLayout(table, numbers = RACK_NUMBERS, opts = {}) {
  const R = table.ballRadius;
  const rand = mulberry32(opts.seed ?? 1);
  const footX = opts.footX ?? table.length * 0.75;
  const cy = table.width / 2;
  const rowGap = Math.sqrt(3) * R;

  /** 15 个位置的行列坐标，按行优先排列 */
  const slots = [];
  for (let row = 0; row < 5; row++) {
    for (let j = 0; j <= row; j++) {
      slots.push({ x: footX + row * rowGap, y: cy + (j - row / 2) * 2 * R });
    }
  }

  let order;
  if (numbers.length === 15) {
    const solids = shuffle(
      numbers.filter((n) => n >= 1 && n <= 7),
      rand
    );
    const stripes = shuffle(
      numbers.filter((n) => n >= 9 && n <= 15),
      rand
    );
    const eight = numbers.find((n) => n === 8);

    // 顶点球传统上放 1 号（赛事惯例，WPA/CBSA 规则都未强制）。
    // 模板顶点是全色，把 1 号提到全色队列最前面即可。
    const oneAt = solids.indexOf(1);
    if (oneAt > 0) {
      solids.splice(oneAt, 1);
      solids.unshift(1);
    }

    // 按 RACK_PATTERN 的组别模板把洗好的号码填进去。
    // 号码在各自组内随机，所以每次摆的球不同；组别分布固定为最优模板。
    // 镜像（左右翻转）也由 seed 决定——模板的左右镜像同样是 7 条同组边的
    // 最优解，随机取一侧避免每次摆球看起来完全一样。
    const mirror = rand() < 0.5;
    const pattern = mirror
      ? RACK_PATTERN.map((_, i) => {
          // 槽位 i 的镜像：同一排内左右互换
          const { row, j } = SLOT_ROWS[i];
          return RACK_PATTERN[SLOT_ROWS.findIndex((p) => p.row === row && p.j === row - j)];
        })
      : RACK_PATTERN;

    let si = 0;
    let ti = 0;
    order = pattern.map((g) => {
      if (g === '8') return eight;
      if (g === 'S') return solids[si++];
      return stripes[ti++];
    });
  } else {
    order = shuffle(numbers, rand);
  }

  return order.slice(0, slots.length).map((number, i) => ({
    number,
    x: slots[i].x,
    y: slots[i].y,
  }));
}

/**
 * 建一副标准黑八：15 颗目标球 + 1 颗母球（母球放在开球线后）。
 * @param {object} table
 * @param {{seed?:number}} [opts]
 */
export function createStandardRack(table, opts = {}) {
  const layout = rackLayout(table, RACK_NUMBERS, opts);
  const balls = layout.map((p) => {
    const s = ballStyle(p.number);
    return { id: 'b' + p.number, number: p.number, x: p.x, y: p.y, color: s.color, stripe: s.stripe };
  });
  balls.unshift({
    id: 'cue',
    number: 0,
    // 开球线在 length/4。放在 0.24 而不是正好压线，是因为规则写的是
    // "on or behind the head string"（线上也算），但压线摆位在视觉上会被
    // 误认为越线；退后约 2.5 cm 既合规又一眼看得出在开球区内。
    x: table.length * 0.24,
    y: table.width / 2,
    color: ballStyle(0).color,
    stripe: false,
  });
  return balls;
}

// ---------------------------------------------------------------- 九球

/** 九球的 9 颗目标球号码。 */
export const NINE_NUMBERS = Array.from({ length: 9 }, (_, i) => i + 1);

/**
 * 菱形的 9 个槽位（行优先）：第 0 排 1 颗、第 1 排 2 颗、第 2 排 3 颗、
 * 第 3 排 2 颗、第 4 排 1 颗。
 *
 * 为什么是"菱形"而不是"三角阵去掉六颗"：九球摆法是把 15 颗的三角阵
 * 去掉四个角，剩下的是一个旋转 45° 的正方形（行数 1-2-3-2-1）。
 * 顶点压脚点、9 号在正中，这两条是 WPA 5.1 的硬要求。
 */
export const NINE_SLOT_ROWS = Object.freeze([
  { row: 0, j: 0 },
  { row: 1, j: 0 }, { row: 1, j: 1 },
  { row: 2, j: 0 }, { row: 2, j: 1 }, { row: 2, j: 2 },
  { row: 3, j: 0 }, { row: 3, j: 1 },
  { row: 4, j: 0 },
]);

/**
 * 菱形里相贴（球心间距恰为 2R）的槽位对。用于测试校验紧密堆积。
 *
 * 判据不能按「同一排 ±1、下一排原偏移」那一套写——菱形每排居中，
 * 相邻两排是错开的。规整的写法是把槽位换算成「以 2R 为单位的纵向坐标」
 * `yIdx = j − (n_row − 1) / 2`：相邻两排相贴，当且仅当排号差 1、且
 * `|yIdx 差| = 0.5`（纵向差 R、横向差 √3R，合起来正好 2R）。
 *
 * 按这个判据数出来是 16 条，不是三角阵的 30 条：菱形是三角阵去掉四个角，
 * 少掉的正是那些角的相贴边。
 */
export const NINE_ADJACENCY = (() => {
  const countOf = (row) => (row <= 2 ? row + 1 : 4 - row + 1);
  const yIdx = NINE_SLOT_ROWS.map((p) => p.j - (countOf(p.row) - 1) / 2);
  const pairs = [];
  for (let i = 0; i < NINE_SLOT_ROWS.length; i++) {
    for (let k = i + 1; k < NINE_SLOT_ROWS.length; k++) {
      if (Math.abs(NINE_SLOT_ROWS[i].row - NINE_SLOT_ROWS[k].row) !== 1) continue;
      if (Math.abs(Math.abs(yIdx[i] - yIdx[k]) - 0.5) < 1e-9) pairs.push([i, k]);
    }
  }
  return pairs;
})();

/**
 * 菱形摆放的位置坐标。
 *
 * ★ 关键几何（WPA 5.2 原文）："the 1-ball at the apex of the diamond towards the head
 * of the table and **the 9-ball in the middle of the diamond and on the Foot Spot**"。
 * 也就是说**压在脚点上的是 9 号球（菱形正中那颗）**，不是顶点那颗。
 * 所以整副架子要往前挪两排：菱形正中在第 2 排，脚点 = 第 2 排中线，
 * 顶点因此落在 `footX − 2 × rowGap`。
 *
 * 一开始这里写成「顶点压在脚点上」（照抄黑八的摆法），在界面验证里被抓出来：
 * 9 号球落在了脚点后两排的位置。黑八是顶点压脚点，九球不是——两个规矩正好相反。
 *
 * @param {object} table
 * @param {{footX?:number}} [opts]
 */
export function nineBallSlots(table, opts = {}) {
  const R = table.ballRadius;
  const footX = opts.footX ?? table.length * 0.75;
  const cy = table.width / 2;
  const rowGap = Math.sqrt(3) * R;
  // 每排在 y 方向的间距是 2R；第 row 排有 row+1 颗（row>2 之后递减）。
  const countOf = (row) => (row <= 2 ? row + 1 : 4 - row + 1);
  // 菱形正中在第 2 排，所以顶点要比脚点往前让两排
  const apexX = footX - 2 * rowGap;
  const slots = [];
  for (let row = 0; row < 5; row++) {
    const n = countOf(row);
    for (let j = 0; j < n; j++) {
      slots.push({ x: apexX + row * rowGap, y: cy + (j - (n - 1) / 2) * 2 * R });
    }
  }
  return slots;
}

/**
 * 九球摆球：菱形，1 号在顶点（朝头端），9 号在菱形正中、压在脚点上，其余七颗随机。
 *
 * 规则出处（WPA《Rules of Play》Effective 2025-09-15，9-Ball 5.2）：
 * "The object-balls are racked as tightly as possible in a diamond shape, with the
 * 1-ball at the apex of the diamond towards the head of the table and the 9-ball in
 * the middle of the diamond and on the Foot Spot."
 * 其余球不作要求，这里洗牌即可——与黑八不同，九球不分组，没有"岔开"这回事。
 *
 * @param {object} table
 * @param {number[]} numbers 必须是 1–9 的 9 颗；不足 9 颗时按洗牌填充
 * @param {{seed?:number, footX?:number}} [opts]
 */
export function rackDiamondLayout(table, numbers = NINE_NUMBERS, opts = {}) {
  const rand = mulberry32(opts.seed ?? 1);
  const slots = nineBallSlots(table, opts);

  let order;
  if (numbers.length === 9 && numbers.includes(1) && numbers.includes(9)) {
    // 除 1 号和 9 号之外的七颗，洗牌后依次填进剩下的七个位置
    const rest = shuffle(numbers.filter((n) => n !== 1 && n !== 9), rand);
    // 顶点 = 槽位 0；正中 = 第 2 排中间那颗 = 槽位 4（0 + 1 + 2 的前三排里排 2 的中位）
    const CENTER_SLOT = 4;
    order = [];
    let k = 0;
    for (let i = 0; i < slots.length; i++) {
      if (i === 0) order.push(1);
      else if (i === CENTER_SLOT) order.push(9);
      else order.push(rest[k++]);
    }
  } else {
    order = shuffle(numbers, rand);
  }

  return order.slice(0, slots.length).map((number, i) => ({ number, x: slots[i].x, y: slots[i].y }));
}

/** 建一副九球：9 颗目标球 + 母球（母球放在开球线后）。 */
export function createNineBallRack(table, opts = {}) {
  const layout = rackDiamondLayout(table, NINE_NUMBERS, opts);
  const balls = layout.map((p) => {
    const s = ballStyle(p.number);
    return { id: 'b' + p.number, number: p.number, x: p.x, y: p.y, color: s.color, stripe: s.stripe };
  });
  balls.unshift({
    id: 'cue',
    number: 0,
    x: table.length * 0.24,
    y: table.width / 2,
    color: ballStyle(0).color,
    stripe: false,
  });
  return balls;
}

/** 按玩法取对应的一副球。 */
export function createRack(kind, table, opts = {}) {
  return kind === 'nineball' ? createNineBallRack(table, opts) : createStandardRack(table, opts);
}


/**
 * 在台面上找一个不与现有球重叠的落点。
 * 从给定点开始按阿基米德螺线向外找，找到即返回；找不到返回 null。
 *
 * @param {Function} [accept] 额外的位置约束，返回 false 的点一律不算空位。
 *   持球摆位要用它把「开球线后」这类区域限制传进来——螺线外扩会跑出限制区，
 *   只检查台内与否是不够的。
 */
export function findFreeSpot(table, balls, R, from = null, accept = null) {
  const start = from ?? { x: table.length * 0.5, y: table.width * 0.5 };
  const minX = table.bounds.minX;
  const maxX = table.bounds.maxX;
  const minY = table.bounds.minY;
  const maxY = table.bounds.maxY;
  const clear = (x, y) =>
    x >= minX && x <= maxX && y >= minY && y <= maxY &&
    (accept === null || accept(x, y)) &&
    !balls.some((b) => !b.pocketed && Math.hypot(b.x - x, b.y - y) < 2 * R + 1e-4);

  if (clear(start.x, start.y)) return { x: start.x, y: start.y };

  const step = R * 0.7;
  for (let ring = 1; ring <= 40; ring++) {
    const radius = ring * step;
    const samples = Math.max(8, Math.round(radius / step) * 6);
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2;
      const x = start.x + Math.cos(a) * radius;
      const y = start.y + Math.sin(a) * radius;
      if (clear(x, y)) return { x, y };
    }
  }
  return null;
}
