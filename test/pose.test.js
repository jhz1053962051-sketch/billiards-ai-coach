// 姿态评估测试：全部用合成关键点，不依赖模型和网络。
//
// 合成姿势的坐标系（与 MediaPipe world 一致）：
//   y 向下（重力方向），原点在髋部中点
//   击球方向 +x，左右方向 ±z
//
// 做法：先构造一个「教科书站姿」，断言 7 条站姿检查全部 good；
// 然后每次只改一个部位，断言只有对应的那一条掉到 warn/bad。
// 这样既验证了公式，也验证了「每条检查只对它该管的部位敏感」。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LM_NAMES,
  vec,
  angleAt,
  angleFromUp,
  angleFromDown,
  straightnessError,
  normalizePose,
  minVisibility,
  frameInset,
} from '../src/pose/landmarks.js';

import {
  THRESHOLDS,
  bandScore,
  maxScore,
  statusOf,
  horizontalDistanceToLine,
  detectHandedness,
  evaluateSetup,
  measuredScore,
  applyReliability,
  noiseRatio,
  clippedByFrame,
  hasUsableWorld,
  missingLandmarks,
  METRIC_NOISE,
} from '../src/pose/checks.js';

import {
  WEIGHTS,
  segmentStroke,
  evaluateStroke,
  summarize,
  gradeOf,
  analyzeImage,
  analyzeSequence,
  averagePoses,
} from '../src/pose/analyze.js';

import {
  REFERENCE,
  REFERENCE_BY_ID,
  REFERENCE_NOTE,
  compareMetric,
  compareAll,
  describeSummary,
} from '../src/pose/reference.js';

// ---------------------------------------------------------------- 合成姿势

/** 33 点全给的构造器，未指定的点放在原点、visibility 1。 */
function makePose(points, vis = {}) {
  const out = {};
  for (const name of LM_NAMES) {
    const p = points[name] ?? { x: 0, y: 0, z: 0 };
    out[name] = { ...p, visibility: vis[name] ?? 1, presence: 1 };
  }
  return out;
}

/**
 * 教科书站姿。各部位数值都是先按几何关系推出来、再被测试锁定的：
 * 躯干前倾 70°、头比肩线低 0.25 个躯干长、后手前臂竖直、架桥臂肘角 171°、
 * 双脚间距 1.45 个肩宽、膝关节 149°、头偏离球杆 0.27 个肩宽。
 */
function goodStance(overrides = {}) {
  return makePose({
    // 髋：左右各 0.10 米
    left_hip: { x: 0, y: 0, z: 0.10 },
    right_hip: { x: 0, y: 0, z: -0.10 },
    // 肩：前移 0.376、上抬 0.137，躯干长 0.40
    left_shoulder: { x: 0.376, y: -0.137, z: 0.19 },
    right_shoulder: { x: 0.376, y: -0.137, z: -0.19 },
    // 头：比肩线低 0.10（0.25 个躯干长），基本压在球杆上方
    nose: { x: 0.476, y: -0.037, z: 0.02 },
    // 握杆手（右手）：前臂竖直，肘在腕正上方
    right_elbow: { x: 0.40, y: 0.10, z: -0.10 },
    right_wrist: { x: 0.40, y: 0.30, z: -0.10 },
    // 架桥手（左手）：向前伸出去，肘角约 171°
    left_elbow: { x: 0.62, y: 0.10, z: 0.10 },
    left_wrist: { x: 0.90, y: 0.30, z: 0.0 },
    // 腿：膝关节约 149°
    left_knee: { x: 0.10, y: 0.48, z: 0.18 },
    left_ankle: { x: -0.06, y: 0.92, z: 0.26 },
    right_knee: { x: 0.10, y: 0.48, z: -0.18 },
    right_ankle: { x: -0.05, y: 0.92, z: -0.27 },
    // 脚：间距 0.552 米 = 1.45 个肩宽
    left_foot_index: { x: -0.10, y: 0.95, z: 0.28 },
    right_foot_index: { x: -0.05, y: 0.95, z: -0.27 },
    ...overrides,
  });
}

/**
 * 把世界坐标（米，y 朝下）压进 [0,1] 的归一化画面坐标。
 *
 * 这不是为了模拟透视——测试不关心画面长什么样，只是必须给出**合法的**取景坐标，
 * 否则 `clippedByFrame` 会认为所有关键点都在画面外，把每一项都判成 unknown。
 * 世界坐标里 x 大致在 [-0.6, 0.9]、y 在 [-0.6, 0.95]，线性映射即可。
 */
function toImage(world) {
  const out = {};
  for (const [k, p] of Object.entries(world)) {
    out[k] = {
      x: 0.30 + (p.x + 0.6) * 0.4,
      y: 0.18 + (p.y + 0.6) * 0.4,
      z: p.z * 0.1,
      visibility: p.visibility,
      presence: p.presence,
    };
  }
  return out;
}

function poseOf(world, vis) {
  const w = {};
  for (const [k, v] of Object.entries(world)) {
    w[k] = vis?.[k] !== undefined ? { ...v, visibility: vis[k] } : v;
  }
  return { image: toImage(w), world: w, hasWorld: true };
}

function byId(checks, id) {
  const c = checks.find((x) => x.id === id);
  assert.ok(c, `缺少检查项 ${id}`);
  return c;
}

// ---------------------------------------------------------------- 基础几何

test('angleAt：直角、平角、退化', () => {
  const o = { x: 0, y: 0, z: 0 };
  assert.equal(Math.round(angleAt({ x: 1, y: 0, z: 0 }, o, { x: 0, y: 1, z: 0 })), 90);
  assert.equal(Math.round(angleAt({ x: 1, y: 0, z: 0 }, o, { x: -1, y: 0, z: 0 })), 180);
  assert.equal(Math.round(angleAt({ x: 1, y: 0, z: 0 }, o, { x: 1, y: 0, z: 0 })), 0);
  // 点重合必须返回 NaN，让调用方判「测不了」而不是「0 度」
  assert.ok(Number.isNaN(angleAt(o, o, { x: 1, y: 0, z: 0 })));
});

test('angleFromUp / angleFromDown：y 轴朝下的约定', () => {
  // y 朝下，所以「上」是 -y
  assert.equal(Math.round(angleFromUp({ x: 0, y: -1, z: 0 })), 0);
  assert.equal(Math.round(angleFromUp({ x: 0, y: 1, z: 0 })), 180);
  assert.equal(Math.round(angleFromDown({ x: 0, y: 1, z: 0 })), 0);
  assert.equal(Math.round(angleFromDown({ x: 1, y: 0, z: 0 })), 90);
  assert.ok(Number.isNaN(angleFromUp({ x: 0, y: 0, z: 0 })));
});

test('straightnessError：直线为 0，折线明显大于 0，点太少为 NaN', () => {
  const line = [];
  for (let i = 0; i < 10; i++) line.push({ x: i * 0.1, y: 0.2, z: -0.3 });
  assert.ok(straightnessError(line) < 1e-9, '共线点应当零偏差');

  const bent = line.map((p, i) => ({ ...p, y: p.y + Math.sin(i) * 0.02 }));
  assert.ok(straightnessError(bent) > 0.01, '带波动的轨迹应当有可测偏差');

  assert.ok(Number.isNaN(straightnessError([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }])));
});

test('normalizePose：把数组结果转成按名字索引，缺 world 时 hasWorld=false', () => {
  const arr = LM_NAMES.map((_, i) => ({ x: i * 0.01, y: i * 0.02, z: 0, visibility: 0.9 }));
  const p = normalizePose({ landmarks: [arr], worldLandmarks: [arr] });
  assert.equal(p.hasWorld, true);
  assert.equal(p.world.nose.x, 0);
  assert.equal(p.world.right_foot_index.x, 0.32);
  assert.equal(p.world.nose.visibility, 0.9);

  const noWorld = normalizePose({ landmarks: [arr] });
  assert.equal(noWorld.hasWorld, false);
  assert.deepEqual(noWorld.world, {});
});

test('minVisibility：取最小值，缺关键点时返回 0', () => {
  const p = { a: { visibility: 0.9 }, b: { visibility: 0.4 } };
  assert.equal(minVisibility(p, ['a', 'b']), 0.4);
  assert.equal(minVisibility(p, ['a']), 0.9);
  assert.equal(minVisibility(p, ['a', 'zzz']), 0);
});

// ---------------------------------------------------------------- 打分工具

test('bandScore：区间内 1 分、边界 0 分、中间线性', () => {
  assert.equal(bandScore(1.5, [1, 2], [0.5, 3]), 1);
  assert.equal(bandScore(0.5, [1, 2], [0.5, 3]), 0);
  assert.equal(bandScore(3, [1, 2], [0.5, 3]), 0);
  assert.equal(bandScore(0.75, [1, 2], [0.5, 3]), 0.5);
  assert.equal(bandScore(2.5, [1, 2], [0.5, 3]), 0.5);
  // 超出 warn 范围也钳到 0，不能变负分
  assert.equal(bandScore(99, [1, 2], [0.5, 3]), 0);
  assert.equal(bandScore(-99, [1, 2], [0.5, 3]), 0);
  assert.equal(bandScore(NaN, [1, 2], [0.5, 3]), null);
});

test('maxScore：越小越好，超过 warnMax 归零', () => {
  assert.equal(maxScore(0, 0.02, 0.055), 1);
  assert.equal(maxScore(0.02, 0.02, 0.055), 1);
  assert.equal(maxScore(0.055, 0.02, 0.055), 0);
  assert.equal(maxScore(1, 0.02, 0.055), 0);
  assert.ok(Math.abs(maxScore(0.0375, 0.02, 0.055) - 0.5) < 1e-9);
  assert.equal(maxScore(NaN, 0.02, 0.055), null);
});

test('statusOf：0.85 / 0.45 两个分界', () => {
  assert.equal(statusOf(1), 'good');
  assert.equal(statusOf(0.85), 'good');
  assert.equal(statusOf(0.84), 'warn');
  assert.equal(statusOf(0.45), 'warn');
  assert.equal(statusOf(0.44), 'bad');
  assert.equal(statusOf(null), 'unknown');
});

test('horizontalDistanceToLine：忽略竖直分量', () => {
  // 线沿 x 轴（z=0），点在正上方 1 米处 → 水平距离应当为 0
  const d = horizontalDistanceToLine({ x: 0.5, y: -1, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(d < 1e-9, '正上方的点水平距离必须为 0');
  // 侧移 0.2
  const d2 = horizontalDistanceToLine({ x: 0.5, y: 0, z: 0.2 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(d2 - 0.2) < 1e-9);
  // 端点外延：投影被钳到线段端点
  const d3 = horizontalDistanceToLine({ x: 2, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
  assert.ok(Math.abs(d3 - 1) < 1e-9);
});

// ---------------------------------------------------------------- 左右手识别

test('detectHandedness：肩腕距大的是架桥手', () => {
  const p = goodStance();
  const h = detectHandedness(p);
  assert.equal(h.bridge, 'left');
  assert.equal(h.grip, 'right');
  assert.equal(h.method, 'span');
});

test('detectHandedness：镜像站姿判成左手球员', () => {
  const p = makePose({
    left_hip: { x: 0, y: 0, z: -0.10 },
    right_hip: { x: 0, y: 0, z: 0.10 },
    left_shoulder: { x: 0.376, y: -0.137, z: -0.19 },
    right_shoulder: { x: 0.376, y: -0.137, z: 0.19 },
    nose: { x: 0.476, y: -0.037, z: -0.02 },
    // 右手成了架桥手：伸得远
    right_elbow: { x: 0.62, y: 0.10, z: -0.10 },
    right_wrist: { x: 0.90, y: 0.30, z: 0 },
    // 左手成了握杆手：垂在肩下
    left_elbow: { x: 0.40, y: 0.10, z: 0.10 },
    left_wrist: { x: 0.40, y: 0.30, z: 0.10 },
  });
  const h = detectHandedness(p);
  assert.equal(h.bridge, 'right');
  assert.equal(h.grip, 'left');
});

// ---------------------------------------------------------------- 站姿检查

test('evaluateSetup：教科书站姿七项全 good', () => {
  const checks = evaluateSetup(poseOf(goodStance()));
  assert.equal(checks.length, 7);
  const ids = checks.map((c) => c.id);
  assert.deepEqual(ids, [
    'stance_width', 'forearm_vertical', 'bridge_arm_straight',
    'head_low', 'torso_lean', 'knee_bend', 'head_over_cue',
  ]);
  for (const c of checks) {
    assert.equal(c.status, 'good', `${c.id} 应当是 good，实际 ${c.status}（值 ${c.value}）`);
    assert.equal(c.score, 1);
    assert.ok(c.detail.length > 0, `${c.id} 必须有可读的说明文字`);
  }
});

test('evaluateSetup：没有世界坐标时只返回一条 unknown', () => {
  const p = { image: goodStance(), world: {}, hasWorld: false };
  const checks = evaluateSetup(p);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].id, 'no_world');
  assert.equal(checks[0].status, 'unknown');
  assert.equal(checks[0].score, null);
});

test('evaluateSetup：可见性不足一律 unknown，不猜', () => {
  const p = poseOf(goodStance(), { left_foot_index: 0.2, right_foot_index: 0.2 });
  const c = byId(evaluateSetup(p), 'stance_width');
  assert.equal(c.status, 'unknown');
  assert.equal(c.score, null);
  assert.equal(c.confidence, 0.2);
});

test('站姿过窄 → 只有 stance_width 掉档', () => {
  const p = poseOf(goodStance({
    left_foot_index: { x: -0.10, y: 0.95, z: 0.14 },
    right_foot_index: { x: -0.05, y: 0.95, z: -0.13 },
  }));
  const checks = evaluateSetup(p);
  const c = byId(checks, 'stance_width');
  assert.ok(c.value < 1.0, `间距比应当 < 1.0，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
  assert.match(c.detail, /偏窄/);
  // 其它项不受影响
  for (const other of checks) {
    if (other.id === 'stance_width') continue;
    assert.equal(other.status, 'good', `${other.id} 不该被脚位变化影响`);
  }
});

test('后手前臂歪掉 → forearm_vertical 掉档', () => {
  const p = poseOf(goodStance({
    right_elbow: { x: 0.55, y: 0.10, z: -0.10 }, // 肘往前挪 15cm
  }));
  const c = byId(evaluateSetup(p), 'forearm_vertical');
  assert.ok(c.value > 15, `倾角应当 > 15°，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
  assert.match(c.detail, /前臂偏离竖直/);
});

test('架桥臂弯着 → bridge_arm_straight 掉档', () => {
  const p = poseOf(goodStance({
    left_elbow: { x: 0.58, y: 0.02, z: 0.30 }, // 肘抬起来往外撇
  }));
  const c = byId(evaluateSetup(p), 'bridge_arm_straight');
  assert.ok(c.value < 152, `肘角应当 < 152°，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('头没压低 → head_low 掉档', () => {
  const p = poseOf(goodStance({
    nose: { x: 0.52, y: -0.30, z: 0.02 }, // 头抬回肩线上方
  }));
  const c = byId(evaluateSetup(p), 'head_low');
  assert.ok(c.value < 0.02, `头部落差应当 < 0.02，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
  assert.match(c.detail, /上身没压下去|头还在肩线/);
});

test('站得太直 → torso_lean 掉档', () => {
  const p = poseOf(goodStance({
    left_shoulder: { x: 0.05, y: -0.137, z: 0.19 },
    right_shoulder: { x: 0.05, y: -0.137, z: -0.19 },
  }));
  const c = byId(evaluateSetup(p), 'torso_lean');
  assert.ok(c.value < 38, `前倾角应当 < 38°，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('腿伸直 → knee_bend 掉档', () => {
  // 膝关节挪到「髋—踝」连线上，膝角接近 180°
  const p = poseOf(goodStance({
    left_knee: { x: -0.03, y: 0.46, z: 0.18 },
    right_knee: { x: -0.025, y: 0.46, z: -0.18 },
  }));
  const c = byId(evaluateSetup(p), 'knee_bend');
  assert.ok(c.value > 174, `膝角应当 > 174°，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('头歪出球杆线 → head_over_cue 掉档', () => {
  const p = poseOf(goodStance({
    nose: { x: 0.476, y: -0.037, z: 0.35 }, // 头侧偏 33cm
  }));
  const c = byId(evaluateSetup(p), 'head_over_cue');
  assert.ok(c.value > 0.38, `偏离应当 > 0.38 肩宽，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('手动指定左右手时按指定走，method=manual', () => {
  const p = goodStance();
  const checks = evaluateSetup(poseOf(p), { handedness: 'left' });
  // 指定左手为握杆手后，前臂垂直看的是左臂（那是架桥臂，伸得远，不竖直）
  const c = byId(checks, 'forearm_vertical');
  assert.notEqual(c.status, 'good');
});

// ---------------------------------------------------------------- 取景检查
// 这一组防的是「模型外推」：肢体被画面裁掉时 MediaPipe 照样给坐标，
// 而且 visibility 还很高，只有坐标本身跑出了 [0,1] 才露馅。

test('frameInset：画面中央为正，贴边接近 0，出画为负', () => {
  const mk = (x, y) => ({ center: { x, y, z: 0, visibility: 1 } });
  assert.ok(frameInset(mk(0.5, 0.5), ['center']) > 0.4);
  assert.ok(Math.abs(frameInset(mk(0.0, 0.5), ['center'])) < 1e-9, '刚好在左边线上应为 0');
  assert.ok(frameInset(mk(1.07, 0.77), ['center']) < 0, '出画必须为负');
  assert.equal(frameInset(mk(0.5, 0.5), ['missing']), -1, '缺关键点当出画处理');
});

test('clippedByFrame：任一关键点出画就整项作废', () => {
  const mk = (x, y) => ({ a: { x, y, z: 0, visibility: 0.99 }, b: { x: 0.5, y: 0.5, z: 0, visibility: 0.99 } });
  assert.equal(clippedByFrame(mk(0.5, 0.5), ['a', 'b']), false);
  assert.equal(clippedByFrame(mk(1.07, 0.77), ['a', 'b']), true);
  assert.equal(clippedByFrame(mk(0.5, 0.5), ['a', 'nope']), true, '缺关键点也算不可用');
});

test('脚被画面裁掉 → stance_width 判 unknown，不编「站姿过宽」', () => {
  // 复现真实照片 s08 的情况：模型把出画的左脚外推到 x=1.10，
  // 算出来脚距 1.32 米 = 4.2 倍肩宽，看起来像站得太开，其实人没拍全。
  const p = poseOf(goodStance());
  p.image.left_foot_index = { x: 1.10, y: 0.82, z: 0, visibility: 0.99 };
  p.image.left_heel = { x: 1.09, y: 0.76, z: 0, visibility: 0.99 };
  const c = byId(evaluateSetup(p), 'stance_width');
  assert.equal(c.status, 'unknown');
  assert.equal(c.score, null);
  assert.match(c.detail, /裁掉|外推|画面/);
});

test('只有对应的那几项受取景影响，不受影响的项照常判', () => {
  const p = poseOf(goodStance());
  p.image.left_foot_index = { x: 1.10, y: 0.82, z: 0, visibility: 0.99 };
  const checks = evaluateSetup(p);
  assert.equal(byId(checks, 'stance_width').status, 'unknown');
  // 头部高度只看鼻和肩，脚出画与它无关
  assert.equal(byId(checks, 'head_low').status, 'good');
  assert.equal(byId(checks, 'torso_lean').status, 'good');
});

// ---------------------------------------------------------------- 关键点缺失
// 这一组防的是「半截 world」：录像质量差或人半个身子出画时，MediaPipe 可能只
// 给出躯干那几个点。原来的实现只判 world 非空，缺 nose 时 checkHeadLow 直接读
// p.nose.y 会抛 TypeError，整份报告连带白屏。现在要求「缺哪个点就把依赖它的那
// 条判 unknown」，能算的照算。

/** 只保留 names 里的关键点（world 与 image 同步裁掉）。 */
function onlyPoints(world, names) {
  const out = {};
  for (const [k, v] of Object.entries(world)) {
    if (names.includes(k)) out[k] = v;
  }
  return out;
}

/** 只保留躯干四个点：肩 + 髋。这是「半截 world」的最典型形态。 */
const TORSO_POINTS = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'];

test('hasUsableWorld：至少一个认得的点才算有世界坐标', () => {
  assert.equal(hasUsableWorld(poseOf(goodStance())), true);
  assert.equal(hasUsableWorld(poseOf(onlyPoints(goodStance(), TORSO_POINTS))), true);
  // 空 world、没有 hasWorld、只有不认得的键，都按「没有世界坐标」处理
  assert.equal(hasUsableWorld({ image: {}, world: {}, hasWorld: true }), false);
  assert.equal(hasUsableWorld({ image: {}, world: { nose: { x: 0, y: 0, z: 0 } }, hasWorld: false }), false);
  assert.equal(hasUsableWorld({ image: {}, world: { spine: { x: 0, y: 0, z: 0 } }, hasWorld: true }), false);
});

test('missingLandmarks：按点名列出缺失项，齐全时为空数组', () => {
  const w = goodStance();
  assert.deepEqual(missingLandmarks(w, ['nose', 'left_wrist']), []);
  delete w.nose;
  assert.deepEqual(missingLandmarks(w, ['nose', 'left_wrist']), ['nose']);
  assert.deepEqual(missingLandmarks(null, ['nose']), ['nose']);
});

test('evaluateSetup：只有躯干关键点 → 能算的照算，其余 unknown，绝不抛异常', () => {
  const pose = poseOf(onlyPoints(goodStance(), TORSO_POINTS));

  // 关键要求：不抛异常（改动前这里是 TypeError: Cannot read properties of undefined）
  let checks;
  assert.doesNotThrow(() => {
    checks = evaluateSetup(pose);
  }, '半截 world 不能抛异常');
  assert.equal(checks.length, 7, '七条检查都要在，不能整体消失');

  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));
  // 依赖鼻 / 腕 / 脚 / 膝的六项都判 unknown
  for (const id of [
    'stance_width', 'forearm_vertical', 'bridge_arm_straight',
    'head_low', 'knee_bend', 'head_over_cue',
  ]) {
    assert.equal(status[id], 'unknown', `${id} 依赖的点缺失，必须判 unknown`);
    const c = byId(checks, id);
    assert.equal(c.score, null);
    assert.equal(c.value, null, 'unknown 的项不许报一个没判过的数值');
    assert.ok(Array.isArray(c.missing) && c.missing.length > 0, `${id} 必须说明缺什么`);
    assert.match(c.detail, /缺少关键点/, `${id} 的文案要说清缺了什么`);
  }
  // 肩 + 髋齐了，躯干前倾是真能算的——不许被一刀切掉
  assert.equal(status.torso_lean, 'good', '躯干前倾只用肩和髋，必须照常算出来');
  assert.ok(Number.isFinite(byId(checks, 'torso_lean').value));
  assert.equal(byId(checks, 'torso_lean').missing, undefined, '能算的项不该带 missing');

  // 明细对得上：head_low 缺的是鼻，stance_width 缺的是脚
  assert.ok(byId(checks, 'head_low').missing.includes('nose'));
  assert.deepEqual(byId(checks, 'stance_width').missing.sort(), ['left_foot_index', 'right_foot_index']);
});

test('evaluateSetup：缺 nose → 只有 head_low / head_over_cue 变 unknown', () => {
  const world = goodStance();
  delete world.nose;
  const checks = evaluateSetup(poseOf(world));
  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));

  assert.equal(status.head_low, 'unknown');
  assert.equal(status.head_over_cue, 'unknown');
  assert.deepEqual(byId(checks, 'head_low').missing, ['nose']);
  assert.deepEqual(byId(checks, 'head_over_cue').missing, ['nose']);

  // 不依赖鼻的五项仍要算出数值，而不是跟着变 unknown
  for (const id of ['stance_width', 'forearm_vertical', 'bridge_arm_straight', 'torso_lean', 'knee_bend']) {
    assert.notEqual(status[id], 'unknown', `${id} 不依赖鼻，不该被牵连`);
    assert.ok(Number.isFinite(byId(checks, id).value), `${id} 应当仍有数值`);
  }
});

test('evaluateSetup：缺一只手腕 → 只有用到它的项变 unknown', () => {
  const world = goodStance();
  delete world.right_wrist; // 握杆手（右手）的腕
  const checks = evaluateSetup(poseOf(world), { handedness: 'right' });
  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));

  // 前臂垂直要腕；头在球杆上方要两只腕
  assert.equal(status.forearm_vertical, 'unknown');
  assert.equal(status.head_over_cue, 'unknown');
  assert.deepEqual(byId(checks, 'forearm_vertical').missing, ['right_wrist']);
  // 架桥臂只用左手，不受影响
  assert.equal(status.bridge_arm_straight, 'good');
  for (const id of ['stance_width', 'head_low', 'torso_lean', 'knee_bend']) {
    assert.ok(Number.isFinite(byId(checks, id).value), `${id} 不该受右腕缺失影响`);
  }
});

test('evaluateSetup：缺一个膝 → 只有 knee_bend 变 unknown', () => {
  const world = goodStance();
  delete world.left_knee;
  const checks = evaluateSetup(poseOf(world));
  const status = Object.fromEntries(checks.map((c) => [c.id, c.status]));

  assert.equal(status.knee_bend, 'unknown');
  assert.deepEqual(byId(checks, 'knee_bend').missing, ['left_knee']);
  for (const id of ['stance_width', 'forearm_vertical', 'bridge_arm_straight', 'head_low', 'torso_lean', 'head_over_cue']) {
    assert.notEqual(status[id], 'unknown', `${id} 不该因左膝缺失被牵连`);
    assert.ok(Number.isFinite(byId(checks, id).value));
  }
});

test('完整 world：结果字段集合与改动前完全一致（不新增 missing）', () => {
  const checks = evaluateSetup(poseOf(goodStance()));
  for (const c of checks) {
    assert.deepEqual(
      Object.keys(c),
      ['id', 'label', 'category', 'value', 'unit', 'score', 'status', 'detail', 'confidence', 'needs'],
      `${c.id} 的字段集合被改动过`
    );
    assert.equal(c.missing, undefined, '完整输入不许带 missing');
    assert.equal(c.status, 'good');
    assert.equal(c.score, 1);
  }
});

test('analyzeImage / analyzeSequence：半截 world 不抛异常，只报 unknown', () => {
  // 1) 单张图片：26 个点全缺，只剩躯干
  const torso = onlyPoints(goodStance(), TORSO_POINTS);
  const torsoPose = poseOf(torso);
  const imgArr = LM_NAMES.map((n) => {
    const p = torsoPose.image[n];
    return p ? { x: p.x, y: p.y, z: p.z, visibility: 0.95 } : { x: 0.5, y: 0.5, z: 0, visibility: 0 };
  });
  const worldArr = LM_NAMES.map((n) => {
    const p = torso[n];
    return p ? { x: p.x, y: p.y, z: p.z, visibility: 0.95 } : { x: 0, y: 0, z: 0, visibility: 0 };
  });
  let report;
  assert.doesNotThrow(() => {
    report = analyzeImage({ landmarks: [imgArr], worldLandmarks: [worldArr] }, { normalize: normalizePose });
  }, '半截 world 的图片分析不能抛异常');
  assert.equal(report.setup.length, 7);
  assert.equal(report.score, null, '测不到足够项目时必须放弃打分');
  assert.equal(report.grade, '无法评估');
  assert.ok(report.unknown.length >= 6);

  // 2) 视频序列：每一帧都只剩躯干
  const frames = strokeFrames().map((f) => ({
    t: f.t,
    poseResult: {
      pose: {
        image: onlyPoints(f.pose.image, TORSO_POINTS),
        world: onlyPoints(f.pose.world, TORSO_POINTS),
        hasWorld: true,
      },
    },
  }));
  let seq;
  assert.doesNotThrow(() => {
    seq = analyzeSequence(frames, { normalize: fakeNormalize, handedness: 'right' });
  }, '半截 world 的序列分析不能抛异常');
  assert.equal(seq.score, null);
  assert.ok(seq.unknown.length >= 1);
});

// ---------------------------------------------------------------- 出杆分段

/**
 * 合成一条握杆手轨迹：慢速后摆 → 快速前摆 → 减速送杆 → 静止。
 * 返回 [{t, pose}]，pose 是完整的 33 点姿势（其余点固定不动）。
 */
function strokeFrames({
  backDist = 0.25,
  backDur = 0.6,
  fwdDist = 0.55,
  fwdDur = 0.12,
  afterDist = 0.15,
  afterDur = 0.25,
  fps = 60,
  jitter = 0,
  wobble = 0,
  headMove = 0,
  elbowDrop = 0,
} = {}) {
  const frames = [];
  const dt = 1 / fps;
  const base = goodStance();
  let t = 0;
  const push = (gripX, extra = {}) => {
    const wob = wobble * Math.sin(t * 40);
    const world = makePose({
      ...base,
      right_wrist: { x: gripX, y: 0.30 + wob, z: -0.10 + jitter * Math.sin(t * 23) },
      right_elbow: { x: gripX, y: 0.10 + (extra.elbowY ?? 0), z: -0.10 },
      nose: { x: 0.476 + headMove * (t / (backDur + fwdDur + afterDur)), y: -0.037, z: 0.02 },
    });
    frames.push({ t, poseResult: null, pose: { image: toImage(world), world, hasWorld: true } });
  };

  // 静止 0.2 s
  for (let i = 0; i < 12; i++) { push(0); t += dt; }
  // 后摆：0 → -backDist（匀速）
  const backSteps = Math.round(backDur / dt);
  for (let i = 1; i <= backSteps; i++) { push(-backDist * (i / backSteps)); t += dt; }
  // 前摆：-backDist → fwdDist - backDist，加速（k² 缓动，越接近触球越快）
  const fwdSteps = Math.round(fwdDur / dt);
  for (let i = 1; i <= fwdSteps; i++) {
    const k = i / fwdSteps;
    push(-backDist + fwdDist * k * k, { elbowY: elbowDrop * k });
    t += dt;
  }
  // 送杆：继续往前但减速（1-(1-k)² 缓动）
  const afterSteps = Math.round(afterDur / dt);
  for (let i = 1; i <= afterSteps; i++) {
    const k = i / afterSteps;
    push(-backDist + fwdDist + afterDist * (1 - (1 - k) * (1 - k)), { elbowY: elbowDrop });
    t += dt;
  }
  // 收杆静止
  for (let i = 0; i < 12; i++) {
    push(-backDist + fwdDist + afterDist, { elbowY: elbowDrop });
    t += dt;
  }
  return frames;
}

/** 把合成帧的 pose 直接当 normalizePose 的输出用。 */
const fakeNormalize = (r) => r.pose;

test('segmentStroke：能切出后摆 / 前摆 / 送杆', () => {
  const frames = strokeFrames();
  const run = frames.map((f, i) => ({ i, t: f.t, x: f.pose.world.right_wrist.x, y: f.pose.world.right_wrist.y, z: f.pose.world.right_wrist.z }));
  const seg = segmentStroke(run);
  assert.ok(seg, '应当识别出一次出杆');
  assert.ok(seg.iFwdStart < seg.iContact, '前摆起点必须在触球点之前');
  assert.ok(seg.iFwdEnd > seg.iContact, '送杆终点必须在触球点之后');
  assert.ok(seg.iBackStart <= seg.iFwdStart, '后摆起点必须在前摆起点之前或重合');
  // 后摆确实在反方向
  assert.ok(run[seg.iFwdStart].x < run[seg.iBackStart].x + 1e-9);
});

test('segmentStroke：纯匀速平移（没有加速）不算一杆', () => {
  const run = [];
  for (let i = 0; i < 40; i++) run.push({ i, t: i / 60, x: i * 0.01, y: 0.3, z: 0 });
  assert.equal(segmentStroke(run), null);
});

test('segmentStroke：点太少直接放弃', () => {
  assert.equal(segmentStroke([{ i: 0, t: 0, x: 0, y: 0, z: 0 }]), null);
});

test('segmentStroke：静止画面里的毫米级噪声不许被当成出杆', () => {
  // 真实工况：手定住不动，视频压缩与关键点回归让相邻帧差 1–2 毫米。
  // 30 fps 下 2 毫米 ≈ 0.06 m/s 是噪声上限，但抖动形态会凑出「后摆—前摆」。
  // 这里手工造一段振幅 1.2 毫米、周期不规则的小抖动，必须被判成没有出杆。
  const run = [];
  const jitter = [0, 0.0012, -0.0008, 0.0009, -0.0011, 0.0007, -0.0006, 0.001, -0.0009, 0.0005];
  for (let i = 0; i < 40; i++) {
    run.push({ i, t: i / 30, x: 0.5 + jitter[i % jitter.length], y: 0.3, z: 0 });
  }
  assert.equal(segmentStroke(run), null, '毫米级抖动不能算一杆');
});

test('segmentStroke：峰值手速有地板，慢到不可能的一杆不算', () => {
  // 造一段形态完整、但峰值只有 2 cm/s 的「出杆」——真人做不到这么慢还叫出杆，
  // 这种输入应当退回「没识别出出杆」，而不是给一堆分数。
  const run = [];
  for (let i = 0; i < 20; i++) run.push({ i, t: i / 60, x: 0.5, y: 0.3, z: 0 });
  for (let i = 1; i <= 10; i++) run.push({ i: 20 + i, t: (20 + i) / 60, x: 0.5 + 0.0004 * i, y: 0.3, z: 0 });
  assert.equal(segmentStroke(run), null);
});

test('evaluateStroke：合成一杆给出 5 条动态检查', () => {
  const frames = strokeFrames().map((f) => ({ t: f.t, pose: f.pose }));
  const { checks, segmented } = evaluateStroke(frames, { handedness: 'right' });
  assert.equal(segmented, true);
  assert.deepEqual(
    checks.map((c) => c.id),
    ['stroke_straight', 'elbow_drop', 'head_still', 'follow_through', 'tempo']
  );
  const straight = byId(checks, 'stroke_straight');
  assert.equal(straight.status, 'good', `直线出杆应当 good，实际 ${straight.status}（${straight.value}）`);
  assert.ok(straight.value < THRESHOLDS.stroke_straight.goodMax);
});

test('evaluateStroke：轨迹带波动 → 直线度变差', () => {
  const frames = strokeFrames({ wobble: 0.03 }).map((f) => ({ t: f.t, pose: f.pose }));
  const c = byId(evaluateStroke(frames, { handedness: 'right' }).checks, 'stroke_straight');
  assert.ok(c.value > THRESHOLDS.stroke_straight.goodMax, `波动轨迹的偏差应当超阈值，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('evaluateStroke：掉肘被检出', () => {
  const frames = strokeFrames({ elbowDrop: 0.09 }).map((f) => ({ t: f.t, pose: f.pose }));
  const c = byId(evaluateStroke(frames, { handedness: 'right' }).checks, 'elbow_drop');
  assert.ok(c.value > THRESHOLDS.elbow_drop.goodMax, `掉肘量应当超阈值，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
  assert.match(c.detail, /掉肘|肘部下沉/);
});

test('evaluateStroke：头跟着动被检出', () => {
  const frames = strokeFrames({ headMove: 0.12 }).map((f) => ({ t: f.t, pose: f.pose }));
  const c = byId(evaluateStroke(frames, { handedness: 'right' }).checks, 'head_still');
  assert.ok(c.value > THRESHOLDS.head_still.goodMax, `头部位移应当超阈值，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('evaluateStroke：送杆不足被检出', () => {
  const frames = strokeFrames({ afterDist: 0.02 }).map((f) => ({ t: f.t, pose: f.pose }));
  const c = byId(evaluateStroke(frames, { handedness: 'right' }).checks, 'follow_through');
  assert.ok(c.value < THRESHOLDS.follow_through.good[0], `送杆比应当偏小，实际 ${c.value}`);
  assert.notEqual(c.status, 'good');
});

test('evaluateStroke：序列太短给出 unknown 而不是 0 分', () => {
  const { checks, segmented, reason } = evaluateStroke([{ t: 0, pose: poseOf(goodStance()) }]);
  assert.equal(segmented, false);
  assert.equal(reason, 'too_short');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'unknown');
});

// ---------------------------------------------------------------- 汇总

test('summarize：unknown 项从总分里剔除，不当 0 分', () => {
  const setup = evaluateSetup(poseOf(goodStance()));
  const onlyGood = summarize({ setup, mode: 'image' });
  assert.equal(onlyGood.score, 100);

  // 把一条改成 unknown，分数不应掉（权重被一起剔掉）
  const withUnknown = setup.map((c) => (c.id === 'knee_bend' ? { ...c, score: null, status: 'unknown' } : c));
  const r = summarize({ setup: withUnknown, mode: 'image' });
  assert.equal(r.score, 100, 'unknown 项必须整条剔除，不能算 0 分');
  assert.equal(r.unknown.length, 1);
});

test('summarize：有问题时按 严重度×权重 排序', () => {
  const p = poseOf(goodStance({
    left_foot_index: { x: -0.10, y: 0.95, z: 0.14 },
    right_foot_index: { x: -0.05, y: 0.95, z: -0.13 },
    nose: { x: 0.476, y: -0.037, z: 0.45 },
  }));
  const r = summarize({ setup: evaluateSetup(p), mode: 'image' });
  assert.ok(r.issues.length >= 2);
  for (let i = 1; i < r.issues.length; i++) {
    const a = r.issues[i - 1].severity * r.issues[i - 1].weight;
    const b = r.issues[i].severity * r.issues[i].weight;
    assert.ok(a >= b, '问题必须按严重度×权重降序');
  }
  assert.ok(r.score < 100);
});

test('summarize：全部测不了时 score 为 null', () => {
  const r = summarize({ setup: [{ id: 'x', score: null, status: 'unknown' }], mode: 'image' });
  assert.equal(r.score, null);
  assert.equal(r.grade, '无法评估');
});

test('summarize：测到的项目太少时不给总分，而不是拿残缺证据下结论', () => {
  // 真实场景：照片只拍到上半身，7 项站姿只测得出 2 项（头高 + 躯干前倾）。
  // 这两项恰好都不合格，如果直接加权平均会得到 8 分「需要从头改动作」——
  // 这是拿 2 项的证据冒充 7 项的结论。必须判 null。
  const setup = evaluateSetup(poseOf(goodStance()));
  const partial = setup.map((c) =>
    ['head_low', 'torso_lean'].includes(c.id) ? { ...c, score: 0, status: 'bad' } : { ...c, score: null, status: 'unknown' }
  );
  const r = summarize({ setup: partial, mode: 'image' });
  assert.equal(r.score, null, '覆盖率不足时必须放弃打分');
  assert.equal(r.grade, '无法评估');
  assert.ok(r.coverage < 0.45, `覆盖率应低于门槛（实际 ${r.coverage}）`);
  assert.equal(r.enough, false);
  // 但测出来的那两项仍要照实报出来，不能一起藏掉
  assert.equal(r.checks.filter((c) => c.status === 'bad').length, 2);
});

test('summarize：覆盖率够高时正常打分，coverage 如实反映测到多少', () => {
  const setup = evaluateSetup(poseOf(goodStance()));
  const r = summarize({ setup, mode: 'image' });
  assert.equal(r.coverage, 1);
  assert.equal(r.enough, true);
  assert.equal(r.score, 100);
});

test('gradeOf：四档边界', () => {
  assert.equal(gradeOf(88), '很规范');
  assert.equal(gradeOf(87), '基本规范');
  assert.equal(gradeOf(74), '基本规范');
  assert.equal(gradeOf(73), '有明显问题');
  assert.equal(gradeOf(58), '有明显问题');
  assert.equal(gradeOf(57), '需要从头改动作');
  assert.equal(gradeOf(null), '无法评估');
});

test('gradeOf：覆盖率不足时档位必须带限定词', () => {
  // 只测到一半项目却说「很规范」，和「什么都没测到却给 0 分」是同一种不诚实
  assert.equal(gradeOf(95, 0.5), '测到的部分很规范');
  assert.equal(gradeOf(80, 0.5), '测到的部分基本规范');
  assert.equal(gradeOf(95, 0.7), '很规范');
  assert.equal(gradeOf(95, 0.69), '测到的部分很规范');
});

// ---------------------------------------------------------------- 测量可靠性

test('measuredScore：合格区间内直接给 1 分，不套死区', () => {
  // 噪声只会把合格的人推出区间，不会把不合格的人推进来，
  // 所以「落在区间内」是保守结论，不需要死区保护。
  const m = measuredScore(12, 'forearm_vertical'); // good [0,15]，离边界 3°
  assert.equal(m.score, 1);
  assert.equal(m.indeterminate, false);
});

test('measuredScore：区间外但没超过死区 → indeterminate，不给分', () => {
  // forearm_vertical 实测噪声 19.48°，死区 = 2×19.48 ≈ 39°。
  // 量到 20° 只超边界 5°，远小于噪声，必须判「测不准」。
  const m = measuredScore(20, 'forearm_vertical');
  assert.equal(m.score, null);
  assert.equal(m.indeterminate, true);
  assert.ok(m.gap < m.need);
});

test('measuredScore：区间外且超过死区 → 正常给低分', () => {
  const m = measuredScore(85, 'forearm_vertical'); // 超边界 70°，远超 39°
  assert.equal(m.score, 0);
  assert.equal(m.indeterminate, false);
  assert.ok(m.gap > m.need);
});

test('measuredScore：noiseScale 按 1/√n 收窄死区', () => {
  const single = measuredScore(40, 'forearm_vertical');
  const multi = measuredScore(40, 'forearm_vertical', { noiseScale: 1 / Math.sqrt(9) });
  assert.equal(single.indeterminate, true, '单帧下 40° 只超边界 25°，小于 39° 死区');
  assert.equal(multi.indeterminate, false, '9 帧平均后死区降到 13°，25° 已经够判');
  assert.ok(multi.need < single.need);
});

test('applyReliability：把「差一点点」的项改成 unknown 并说明原因', () => {
  const p = poseOf(goodStance({ nose: { x: 0.52, y: -0.20, z: 0.02 } }));
  const raw = evaluateSetup(p);
  const before = byId(raw, 'head_low');
  assert.ok(before.score !== null, '未套死区前应当有分数');

  const after = byId(applyReliability(raw, 1), 'head_low');
  if (after.indeterminate) {
    assert.equal(after.score, null);
    assert.equal(after.status, 'unknown');
    assert.match(after.detail, /噪声|不判/);
  } else {
    // 如果这个合成姿势离边界足够远，就该保留原分数，但必须带死区元数据
    assert.ok(after.deadZone > 0);
  }
});

test('applyReliability：已经 unknown 的项不被覆盖原因', () => {
  const p = poseOf(goodStance(), { left_foot_index: 0.2, right_foot_index: 0.2 });
  const raw = evaluateSetup(p);
  const before = byId(raw, 'stance_width');
  assert.equal(before.status, 'unknown');
  const after = byId(applyReliability(raw, 1), 'stance_width');
  assert.equal(after.status, 'unknown');
  assert.equal(after.detail, before.detail, '原因文字必须原样保留，不能被死区说明覆盖');
  assert.notEqual(after.indeterminate, true);
});

test('noiseRatio：标出噪声与判定区间同量级的指标', () => {
  // 实测：forearm_vertical 噪声 19.5° 而 good 区间只有 15° 宽，比值 >1
  assert.ok(noiseRatio('forearm_vertical') > 0.5);
  // head_low 噪声 0.032 个躯干长，good 区间 0.53 宽，比值很小
  assert.ok(noiseRatio('head_low') < 0.2);
  assert.equal(noiseRatio('不存在的项'), 0);
});

test('averagePoses：多帧平均把随机噪声压小', () => {
  const base = goodStance();
  const poses = [];
  // 给每个点加 ±3cm 的交替抖动，均值应当回到原值附近
  for (let k = 0; k < 8; k++) {
    const jitter = k % 2 ? 0.03 : -0.03;
    const world = {};
    for (const n of LM_NAMES) {
      world[n] = { ...base[n], x: base[n].x + jitter, y: base[n].y, z: base[n].z, visibility: 0.95 };
    }
    poses.push({ image: world, world, hasWorld: true });
  }
  const { pose, n } = averagePoses(poses);
  assert.equal(n, 8);
  assert.ok(Math.abs(pose.world.nose.x - base.nose.x) < 1e-9, '交替抖动平均后应当完全抵消');
});

test('averagePoses：没有可用帧时退回第一帧，不崩', () => {
  const p = { image: {}, world: {}, hasWorld: false };
  const { n } = averagePoses([p]);
  assert.equal(n, 0);
});

test('WEIGHTS：每个检查项都有权重，且都是正数', () => {
  const ids = [
    'stance_width', 'forearm_vertical', 'bridge_arm_straight', 'head_low',
    'torso_lean', 'knee_bend', 'head_over_cue',
    'stroke_straight', 'elbow_drop', 'head_still', 'follow_through', 'tempo',
  ];
  for (const id of ids) {
    assert.ok(WEIGHTS[id] > 0, `${id} 缺少正权重`);
  }
});

// ---------------------------------------------------------------- 端到端

test('analyzeImage：真实形状的 PoseLandmarkerResult 能跑通', () => {
  const world = goodStance();
  // landmarks 是归一化画面坐标，worldLandmarks 是米制世界坐标——两者不能混用。
  // 画面坐标必须是合法的 [0,1]，否则会被取景检查判成「肢体出画」。
  const img = toImage(world);
  const imgArr = LM_NAMES.map((n) => ({ x: img[n].x, y: img[n].y, z: img[n].z, visibility: 0.95 }));
  const worldArr = LM_NAMES.map((n) => ({ x: world[n].x, y: world[n].y, z: world[n].z, visibility: 0.95 }));
  const report = analyzeImage(
    { landmarks: [imgArr], worldLandmarks: [worldArr] },
    { normalize: normalizePose }
  );
  assert.equal(report.mode, 'image');
  assert.equal(report.score, 100);
  assert.equal(report.grade, '很规范');
  assert.equal(report.setup.length, 7);
  assert.equal(report.stroke.length, 0);
  assert.ok(report.confidence > 0.9);
});

test('analyzeSequence：图片帧序列走完站姿+出杆两段', () => {
  const raw = strokeFrames().map((f) => ({ t: f.t, poseResult: { pose: f.pose } }));
  const report = analyzeSequence(raw, { normalize: fakeNormalize, handedness: 'right' });
  assert.equal(report.mode, 'video');
  assert.equal(report.setup.length, 7);
  assert.equal(report.stroke.length, 5);
  assert.ok(report.score > 60, `合成标准动作应当得分不低，实际 ${report.score}`);
  assert.ok(report.frameCount > 40);
});

test('analyzeSequence：完全没检测到人时不崩，只报 unknown', () => {
  const raw = [];
  for (let i = 0; i < 20; i++) raw.push({ t: i / 30, poseResult: { landmarks: [], worldLandmarks: [] } });
  const report = analyzeSequence(raw, { normalize: normalizePose });
  assert.equal(report.score, null);
  assert.equal(report.grade, '无法评估');
  assert.ok(report.unknown.length >= 1);
});

// ---------------------------------------------------------------- 参考区间对照
// 这一层要防两类错误：
//   1. 把「没测到」说成「偏了」——缺关键点时编一个偏差值出来；
//   2. 区间与 checks.js 的阈值各说各话——同一个值，检查判合格，对照说偏离。

const REF_IDS = [
  'stance_width', 'forearm_vertical', 'bridge_arm_straight',
  'head_low', 'torso_lean', 'knee_bend', 'head_over_cue',
];

/** 造一条 check 结果，只给对照层用得到的字段。 */
function mkCheck(id, value, opts = {}) {
  return {
    id,
    label: opts.label ?? id,
    value,
    unit: opts.unit ?? THRESHOLDS[id]?.unit ?? '',
    status: opts.status ?? 'good',
    ...opts.extra,
  };
}

test('REFERENCE：7 条区间与 THRESHOLDS 同源，basis 有据且不含编造的数据来源', () => {
  assert.equal(REFERENCE.length, 7);
  assert.deepEqual(REFERENCE.map((r) => r.id), REF_IDS);

  for (const r of REFERENCE) {
    const t = THRESHOLDS[r.id];
    // ideal 必须就是 good 区间：界面同一条指标只有一套数字
    assert.deepEqual(r.ideal, t.good, `${r.id} 的 ideal 必须与 THRESHOLDS.good 完全一致`);
    // 容差带的外沿必须正好落在 warn 边界上
    assert.ok(
      Math.abs(r.ideal[0] - r.tolerance[0] - t.warn[0]) < 1e-9,
      `${r.id} 低侧容差没有接到 warn 边界`
    );
    assert.ok(
      Math.abs(r.ideal[1] + r.tolerance[1] - t.warn[1]) < 1e-9,
      `${r.id} 高侧容差没有接到 warn 边界`
    );
    assert.ok(r.tolerance[0] >= 0 && r.tolerance[1] >= 0, `${r.id} 容差不能是负数`);
    // 方向名：至少有一侧能命名，且名字是稳定的标识符
    const dirs = [r.direction.low, r.direction.high].filter(Boolean);
    assert.ok(dirs.length >= 1, `${r.id} 至少要有一侧方向名`);
    for (const d of dirs) assert.match(d, /^[a-z_]+$/, `${r.id} 的方向名要稳定可判（实际 ${d}）`);

    // basis 是这一层唯一没法自动验证的东西，只能钉住底线：
    // 写得够长、说明了依据、并且明确承认没做过统计标定。
    assert.ok(r.basis.length > 80, `${r.id} 的 basis 太短（${r.basis.length} 字），等于没写依据`);
    assert.match(r.basis, /教练经验值，未做统计验证/, `${r.id} 的 basis 必须承认没有统计标定`);
    // 我们没有任何选手数据，所以不许出现「职业选手平均」这类说法
    assert.doesNotMatch(r.basis, /职业选手|选手中位|平均值|样本平均|大数据/);
  }

  assert.match(REFERENCE_NOTE, /教练经验值/);
  assert.equal(REFERENCE_BY_ID.head_low.ideal[1], 0.55);
});

test('compareMetric：区间内与两端边界都算 good，偏差为 0', () => {
  const inside = compareMetric(mkCheck('stance_width', 1.45, { label: '站姿宽度' }));
  assert.equal(inside.status, 'good');
  assert.equal(inside.deviation, 0);
  assert.equal(inside.direction, null);
  assert.deepEqual(inside.band.ideal, [1.0, 2.2]);
  assert.deepEqual(inside.band.near, [0.75, 2.7]);
  assert.match(inside.advice, /站姿宽度 1\.45 个肩宽，在参考区间（1\.00–2\.20 个肩宽）内/);

  for (const v of [1.0, 2.2]) {
    const c = compareMetric(mkCheck('stance_width', v));
    assert.equal(c.status, 'good', `边界值 ${v} 必须算在区间内，不能算偏离`);
    assert.equal(c.deviation, 0);
    assert.equal(c.direction, null);
  }
});

test('compareMetric：容差带内判 near，两侧方向各自正确且偏差带符号', () => {
  const wide = compareMetric(mkCheck('stance_width', 2.45, { label: '站姿宽度' }));
  assert.equal(wide.status, 'near');
  assert.equal(wide.direction, 'too_wide');
  assert.ok(Math.abs(wide.deviation - 0.25) < 1e-9, `高侧偏差应为 +0.25，实际 ${wide.deviation}`);
  assert.match(wide.advice, /比推荐上限宽 0\.25 个肩宽/);
  assert.match(wide.advice, /还在容差带里/);

  const narrow = compareMetric(mkCheck('stance_width', 0.9, { label: '站姿宽度' }));
  assert.equal(narrow.status, 'near');
  assert.equal(narrow.direction, 'too_narrow');
  assert.ok(Math.abs(narrow.deviation + 0.1) < 1e-9, `低侧偏差应为 −0.10，实际 ${narrow.deviation}`);
  assert.match(narrow.advice, /比推荐下限窄 0\.10 个肩宽/);
});

test('compareMetric：出了容差带判 off，两侧都验', () => {
  const tooNarrow = compareMetric(mkCheck('stance_width', 0.6, { label: '站姿宽度' }));
  assert.equal(tooNarrow.status, 'off');
  assert.equal(tooNarrow.direction, 'too_narrow');
  assert.ok(tooNarrow.deviation < -0.3);
  assert.match(tooNarrow.advice, /已经出了容差带/);

  const tooWide = compareMetric(mkCheck('stance_width', 2.9, { label: '站姿宽度' }));
  assert.equal(tooWide.status, 'off');
  assert.equal(tooWide.direction, 'too_wide');
  assert.ok(tooWide.deviation > 0.6);
});

test('compareMetric：near 与 off 的分界正好落在容差外沿', () => {
  const edge = compareMetric(mkCheck('stance_width', 2.7)); // near 上限 2.7
  assert.equal(edge.status, 'near', '刚好等于容差外沿仍算接近');
  assert.ok(Math.abs(edge.deviation - 0.5) < 1e-9);

  const just = compareMetric(mkCheck('stance_width', 2.72));
  assert.equal(just.status, 'off', '越过容差外沿就是偏离');
});

test('compareMetric：单侧指标不会凭空造出另一侧的方向', () => {
  // 架桥臂肘角最大就是 180°，高侧没有名字
  const bent = compareMetric(mkCheck('bridge_arm_straight', 100, { label: '架桥臂伸展' }));
  assert.equal(bent.direction, 'too_bent');
  assert.equal(bent.status, 'off');
  assert.equal(REFERENCE_BY_ID.bridge_arm_straight.direction.high, null);

  // 倾角是绝对值，低侧不会出现
  const tilt = compareMetric(mkCheck('forearm_vertical', 40, { label: '后手前臂垂直' }));
  assert.equal(tilt.direction, 'too_tilted');
  assert.equal(REFERENCE_BY_ID.forearm_vertical.direction.low, null);

  // 屈膝两侧都会出现，各自的说法不同
  const deep = compareMetric(mkCheck('knee_bend', 100, { label: '屈膝程度' }));
  const straight = compareMetric(mkCheck('knee_bend', 178, { label: '屈膝程度' }));
  assert.equal(deep.direction, 'too_deep');
  assert.equal(straight.direction, 'too_straight');
  assert.equal(deep.status, 'off');
  assert.equal(straight.status, 'near');
  assert.ok(deep.deviation < 0 && straight.deviation > 0);
});

test('compareMetric：unknown 原样传递，绝不补一个偏差值', () => {
  // 缺关键点：value 是 null，方向与偏差都必须为空
  const missing = compareMetric(
    mkCheck('head_low', null, { label: '头部高度', status: 'unknown', extra: { missing: ['nose'] } })
  );
  assert.equal(missing.status, 'unknown');
  assert.equal(missing.deviation, null);
  assert.equal(missing.direction, null);
  assert.deepEqual(missing.band.ideal, [0.02, 0.55], '没测到也要能画出参考区间');
  assert.match(missing.advice, /缺少关键点 nose/);

  // 「差得还没噪声大」：value 有数但 status 是 unknown，同样不许报偏差
  const indet = compareMetric(
    mkCheck('forearm_vertical', 22, { label: '后手前臂垂直', status: 'unknown', extra: { indeterminate: true } })
  );
  assert.equal(indet.status, 'unknown');
  assert.equal(indet.deviation, null, '测不准的项给偏差就是给假信息');
  assert.equal(indet.direction, null);
  assert.match(indet.advice, /波动/);
});

test('compareMetric：异常输入一律退化，绝不抛异常', () => {
  const weird = [
    null,
    undefined,
    {},
    [],
    { id: 'stance_width' },
    { id: 'stance_width', value: null, status: 'good' },
    { id: 'stance_width', value: NaN, status: 'good' },
    { id: 'stance_width', value: '1.4', status: 'good' },
    { id: 'stance_width', value: Infinity, status: 'good' },
    { id: 123, value: 1, status: 'good' },
    { id: 'no_such_metric', value: 1, status: 'good' },
    { id: 'stroke_straight', value: 0.01, unit: '偏差/行程', status: 'good' },
  ];
  for (const input of weird) {
    let out;
    assert.doesNotThrow(() => {
      out = compareMetric(input);
    }, `${JSON.stringify(input)} 不能让整页挂掉`);
    assert.equal(out.status, 'unknown', `${JSON.stringify(input)} 应当退化成 unknown`);
    assert.equal(out.deviation, null);
    assert.equal(out.direction, null);
    assert.equal(typeof out.advice, 'string');
    assert.ok(out.advice.length > 0);
  }
  // 有 id 的才有 band；没有参考区间的 id（出杆项）band 为 null
  assert.deepEqual(compareMetric({ id: 'stance_width', value: null }).band.ideal, [1.0, 2.2]);
  assert.equal(compareMetric({ id: 'stroke_straight', value: 0.01 }).band, null);
});

test('compareMetric：文案里的单位与 check.unit 一致', () => {
  // 度：整数，带 °
  const deg = compareMetric(mkCheck('torso_lean', 95, { label: '躯干前倾' }));
  assert.match(deg.advice, /躯干前倾 95°，比推荐上限大 17°/);

  // ×肩宽：两位小数，写成「个肩宽」
  const ratio = compareMetric(mkCheck('head_over_cue', 0.6, { label: '头在球杆上方' }));
  assert.match(ratio.advice, /头在球杆上方 0\.60 个肩宽，偏离球杆 0\.22 个肩宽/);

  // ×躯干长
  const torso = compareMetric(mkCheck('head_low', 0.3, { label: '头部高度' }));
  assert.match(torso.advice, /0\.30 个躯干长/);
  assert.match(torso.advice, /在参考区间（0\.02–0\.55 个躯干长）内/);

  // 三个单位都来自 THRESHOLDS，不是这里另写的一套
  assert.equal(THRESHOLDS.torso_lean.unit, '°');
  assert.equal(THRESHOLDS.head_over_cue.unit, '×肩宽');
  assert.equal(THRESHOLDS.head_low.unit, '×躯干长');
});

test('compareAll：混合状态的汇总与逐项一致，顺序不重排', () => {
  const list = [
    mkCheck('stance_width', 1.45, { label: '站姿宽度' }),
    mkCheck('forearm_vertical', 45, { label: '后手前臂垂直', status: 'bad' }),
    mkCheck('bridge_arm_straight', 170, { label: '架桥臂伸展' }),
    mkCheck('head_low', null, { label: '头部高度', status: 'unknown', extra: { missing: ['nose'] } }),
  ];
  const { items, summary } = compareAll(list);

  assert.equal(items.length, 4);
  assert.deepEqual(items.map((i) => i.id), list.map((c) => c.id), '顺序必须与输入一致');
  assert.deepEqual(summary, { good: 2, near: 0, off: 1, unknown: 1 });
  assert.equal(summary.good + summary.near + summary.off + summary.unknown, items.length);

  assert.equal(items[3].value, null, 'unknown 项不许报 0');
  assert.equal(items[3].deviation, null);
  assert.equal(items[3].direction, null);
  assert.ok(items[0].basis.length > 80, '每一项都带着自己的区间依据');
  assert.equal(items[3].basis.length > 80, true);
  assert.match(describeSummary(summary), /3 项里 2 项在参考区间内，1 项偏离。另有 1 项测不到/);
});

test('compareAll：全部 unknown 时汇总只数 unknown，总评不吹「都合格」', () => {
  const list = REF_IDS.map((id) => mkCheck(id, null, { status: 'unknown', extra: { missing: ['nose'] } }));
  const { items, summary } = compareAll(list);
  assert.equal(items.length, 7);
  assert.deepEqual(summary, { good: 0, near: 0, off: 0, unknown: 7 });
  for (const it of items) {
    assert.equal(it.deviation, null);
    assert.equal(it.direction, null);
  }
  // 一项都没测到时不许说「0 项偏离」——那是把缺失当合格
  assert.match(describeSummary(summary), /7 项都没测到/);
  assert.doesNotMatch(describeSummary(summary), /0 项偏离/);
});

test('compareAll：空数组与非数组都退化成空结果', () => {
  const empty = compareAll([]);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.summary, { good: 0, near: 0, off: 0, unknown: 0 });
  assert.equal(describeSummary(empty.summary), '没有可对照的指标。');

  for (const input of [null, undefined, {}, 42, 'nope']) {
    let out;
    assert.doesNotThrow(() => {
      out = compareAll(input);
    }, `${String(input)} 不许抛`);
    assert.deepEqual(out.items, []);
    assert.deepEqual(out.summary, { good: 0, near: 0, off: 0, unknown: 0 });
  }
  assert.equal(describeSummary(null), '没有可对照的指标。');
});

// ---------------------------------------------------------------- 报告形状回归
// 这一层是给「以后的人」看的：report 的既有字段有单测和端到端两边钉着，
// 新字段只能追加在末尾，顺序和键名都不许动。

const OLD_REPORT_KEYS = [
  'mode', 'frameCount', 'score', 'grade', 'coverage', 'enough', 'confidence',
  'averagedFrames', 'weakMetrics', 'setup', 'stroke', 'checks', 'issues', 'unknown',
];

test('report：既有字段的键集合与顺序不变，comparison 只能追加在末尾', () => {
  const setup = evaluateSetup(poseOf(goodStance()));
  const report = summarize({ setup, mode: 'image' });
  const keys = Object.keys(report);

  assert.deepEqual(
    keys.slice(0, OLD_REPORT_KEYS.length),
    OLD_REPORT_KEYS,
    '既有字段的名字或顺序被改动了——界面和端到端都按名字/顺序取'
  );
  assert.deepEqual(keys.slice(OLD_REPORT_KEYS.length), ['comparison'], '新增字段必须是末尾的 comparison');
  assert.equal(keys.length, OLD_REPORT_KEYS.length + 1, '除了 comparison 不许再加别的顶层字段');
});

test('report.comparison：7 项对照齐全，总评与汇总自洽', () => {
  const setup = evaluateSetup(poseOf(goodStance()));
  const cmp = summarize({ setup, mode: 'image' }).comparison;

  assert.equal(cmp.items.length, 7);
  assert.deepEqual(cmp.items.map((i) => i.id), setup.map((c) => c.id), '顺序跟着 setup 走');
  assert.deepEqual(cmp.summary, { good: 7, near: 0, off: 0, unknown: 0 });
  assert.match(cmp.verdict, /7 项里 7 项在参考区间内/);
  assert.equal(cmp.note, REFERENCE_NOTE);
  assert.match(cmp.note, /教练经验值/);
  assert.match(cmp.disclaimer, /没有用选手录像做过统计标定/);
  for (const it of cmp.items) {
    assert.ok(it.advice.length > 8, `${it.id} 必须带一句能直接显示的建议`);
    assert.ok(it.band && it.band.ideal.length === 2, `${it.id} 必须带区间条用的边界`);
  }
});

test('report.comparison：缺关键点的项是 unknown，且不带偏差值', () => {
  const world = goodStance();
  delete world.nose;
  const setup = evaluateSetup(poseOf(world));
  const cmp = summarize({ setup, mode: 'image' }).comparison;

  const heads = cmp.items.filter((i) => i.id === 'head_low' || i.id === 'head_over_cue');
  assert.equal(heads.length, 2);
  for (const it of heads) {
    assert.equal(it.status, 'unknown');
    assert.equal(it.deviation, null);
    assert.equal(it.direction, null);
    assert.equal(it.value, null);
  }
  assert.equal(cmp.summary.unknown, 2);
  assert.equal(cmp.summary.good, 5);
});

test('analyzeImage：端到端报告里带着对照层，既有字段照旧', () => {
  const world = goodStance();
  const img = toImage(world);
  const imgArr = LM_NAMES.map((n) => ({ x: img[n].x, y: img[n].y, z: img[n].z, visibility: 0.95 }));
  const worldArr = LM_NAMES.map((n) => ({ x: world[n].x, y: world[n].y, z: world[n].z, visibility: 0.95 }));
  const report = analyzeImage(
    { landmarks: [imgArr], worldLandmarks: [worldArr] },
    { normalize: normalizePose }
  );

  assert.equal(report.comparison.items.length, 7);
  assert.equal(report.comparison.summary.good, 7);
  assert.match(report.comparison.verdict, /7 项里 7 项在参考区间内/);
  // 既有结论不受影响
  assert.equal(report.score, 100);
  assert.equal(report.grade, '很规范');
  assert.equal(report.setup.length, 7);
});
