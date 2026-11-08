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
