// 人体姿态关键点：33 点定义、坐标约定、几何辅助。
//
// 坐标约定（已用真实照片实测，见 _research/calibrate-pose.json）：
//   image：归一化 [0,1]，x 向右、y 向下，z 是相对深度（越小越靠近镜头）
//   world：单位米，原点在髋部中点，**y 向下**（实测踝 y≈+0.72、鼻 y≈-0.59）
//
// 所以「重力方向」是 +y，「上方」是 -y。凡是要算物理角度（前臂是否垂直、
// 躯干前倾多少度）一律用 world 坐标：image 坐标受透视和画面长宽比影响，
// 同一个姿势在不同机位下算出来的角度完全不同，没有可比性。
//
// 反过来，画骨架叠加层要用 image 坐标——那是屏幕像素空间的真值。

/** 33 个关键点的索引，顺序与 MediaPipe Pose Landmarker 一致。 */
export const LM = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
};

/** 索引 → 名字，用于把 MediaPipe 的数组结果转成按名字索引的对象。 */
export const LM_NAMES = [
  'nose',
  'left_eye_inner', 'left_eye', 'left_eye_outer',
  'right_eye_inner', 'right_eye', 'right_eye_outer',
  'left_ear', 'right_ear',
  'mouth_left', 'mouth_right',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_pinky', 'right_pinky',
  'left_index', 'right_index',
  'left_thumb', 'right_thumb',
  'left_hip', 'right_hip',
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

/** 骨架连线，画叠加层用。取自 MediaPipe 官方 POSE_CONNECTIONS。 */
export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [27, 29], [27, 31], [29, 31],
  [24, 26], [26, 28], [28, 30], [28, 32], [30, 32],
];

/** 世界坐标里的「上方」单位向量。y 轴朝下，所以上是 -y。 */
export const UP = { x: 0, y: -1, z: 0 };
/** 世界坐标里的「重力方向」单位向量。 */
export const DOWN = { x: 0, y: 1, z: 0 };

// ---------------------------------------------------------------- 向量运算
// 只用到三维加减小工具，不值得引任何库。

export const vec = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, k) => ({ x: a.x * k, y: a.y * k, z: a.z * k }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  cross: (a, b) => ({
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }),
  len: (a) => Math.hypot(a.x, a.y, a.z),
  dist: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
  mid: (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }),
  norm: (a) => {
    const l = Math.hypot(a.x, a.y, a.z) || 1;
    return { x: a.x / l, y: a.y / l, z: a.z / l };
  },
};

/** 弧度 → 度。 */
export const DEG = 180 / Math.PI;

/**
 * 以 b 为顶点，a-b-c 的夹角（度，0..180）。
 * 三点重合、或任一点缺失时返回 NaN，调用方要当成「测不了」而不是「0 度」。
 */
export function angleAt(a, b, c) {
  if (!a || !b || !c) return NaN;
  const ba = vec.sub(a, b);
  const bc = vec.sub(c, b);
  const la = vec.len(ba);
  const lc = vec.len(bc);
  if (la < 1e-9 || lc < 1e-9) return NaN;
  let cos = vec.dot(ba, bc) / (la * lc);
  cos = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return Math.acos(cos) * DEG;
}

/**
 * 向量与「上方」的夹角（度）。0 = 竖直向上，180 = 竖直向下。
 */
export function angleFromUp(v) {
  if (!v) return NaN;
  const l = vec.len(v);
  if (l < 1e-9) return NaN;
  let cos = vec.dot(v, UP) / l;
  cos = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return Math.acos(cos) * DEG;
}

/**
 * 向量与「重力方向」的夹角（度）。0 = 竖直向下（自然下垂）。
 */
export function angleFromDown(v) {
  if (!v) return NaN;
  const l = vec.len(v);
  if (l < 1e-9) return NaN;
  let cos = vec.dot(v, DOWN) / l;
  cos = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return Math.acos(cos) * DEG;
}

/**
 * 点到无限直线的距离（直线过 a、方向 d）。
 * 用来算「出杆臂离躯干轴线有多远」这类间隙。
 */
export function pointLineDistance(p, a, d) {
  const dn = vec.norm(d);
  const ap = vec.sub(p, a);
  const proj = vec.scale(dn, vec.dot(ap, dn));
  return vec.len(vec.sub(ap, proj));
}

/**
 * 点到一组点的最佳拟合直线的最大垂直偏差，归一化到轨迹长度。
 * 出杆直不直就靠这个数。
 *
 * 用主成分方向：先算质心，再取协方差矩阵最大特征值对应的方向。
 * 三维下用幂迭代 20 次即可（轨迹近似直线，收敛很快）。
 */
export function straightnessError(points) {
  const n = points.length;
  if (n < 3) return NaN;

  const c = { x: 0, y: 0, z: 0 };
  for (const p of points) {
    c.x += p.x / n;
    c.y += p.y / n;
    c.z += p.z / n;
  }

  // 协方差矩阵（对称 3x3）
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const dx = p.x - c.x, dy = p.y - c.y, dz = p.z - c.z;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }

  // 幂迭代找主方向，初值取首尾方向，避免收敛到噪声方向
  let dir = vec.norm(vec.sub(points[n - 1], points[0]));
  if (vec.len(dir) < 1e-9) dir = { x: 1, y: 0, z: 0 };
  for (let i = 0; i < 24; i++) {
    const nx = xx * dir.x + xy * dir.y + xz * dir.z;
    const ny = xy * dir.x + yy * dir.y + yz * dir.z;
    const nz = xz * dir.x + yz * dir.y + zz * dir.z;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) break;
    dir = { x: nx / l, y: ny / l, z: nz / l };
  }

  // 轨迹总长（沿主方向的投影跨度）
  let tMin = Infinity;
  let tMax = -Infinity;
  const ts = [];
  for (const p of points) {
    const t = vec.dot(vec.sub(p, c), dir);
    ts.push(t);
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const span = tMax - tMin;
  if (span < 1e-9) return NaN;

  // 最大垂直偏差
  let maxDev = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const t = ts[i];
    const onLine = vec.add(c, vec.scale(dir, t));
    const d = vec.dist(p, onLine);
    if (d > maxDev) maxDev = d;
  }

  return maxDev / span; // 无量纲：偏差占轨迹长度的比例
}

/**
 * 把 MediaPipe 的 PoseLandmarkerResult 转成按名字索引的姿势对象。
 *
 * @param {object} result MediaPipe 原始结果（landmarks / worldLandmarks）
 * @returns {{image: object, world: object, hasWorld: boolean}}
 *   image[name] / world[name] 都是 {x,y,z,visibility}
 */
export function normalizePose(result) {
  const toMap = (arr) => {
    const m = {};
    if (!arr) return m;
    for (let i = 0; i < arr.length && i < LM_NAMES.length; i++) {
      const p = arr[i];
      m[LM_NAMES[i]] = {
        x: p.x, y: p.y, z: p.z,
        visibility: p.visibility ?? 1,
        presence: p.presence ?? 1,
      };
    }
    return m;
  };
  const worldArr = result?.worldLandmarks?.[0] ?? null;
  return {
    image: toMap(result?.landmarks?.[0] ?? null),
    world: toMap(worldArr),
    hasWorld: !!worldArr,
  };
}

/** 一组点的最小 visibility，用来判断这次测量可不可信。 */
export function minVisibility(pose, names) {
  let v = 1;
  for (const n of names) {
    const p = pose[n];
    if (!p) return 0;
    v = Math.min(v, p.visibility ?? 1);
  }
  return v;
}

/**
 * 一组点离画面边界的最小距离（归一化坐标，0 = 刚好在边上，负值 = 在画面外）。
 *
 * 为什么要单独查这个：MediaPipe 的关键点是「回归」出来的，不是检出来的。
 * 肢体被画面裁掉时它照样会给出坐标，只是坐标落在 [0,1] 之外。这种外推值
 * 的误差没有上限——实测一张脚被裁掉的照片，模型把两只脚摆到了相距 1.3 米
 * （4.2 倍肩宽）的位置，看起来像「站姿过宽」，其实人根本没被拍全。
 * visibility 也拦不住：那张照片里脚的 visibility 是 0.99。
 */
export function frameInset(pose, names) {
  let m = Infinity;
  for (const n of names) {
    const p = pose[n];
    if (!p) return -1;
    m = Math.min(m, p.x, 1 - p.x, p.y, 1 - p.y);
  }
  return Number.isFinite(m) ? m : -1;
}
