// 动作规范性分析的演示页。
//
// 全部在浏览器内完成：模型资产放在 vendor/pose/ 下（MediaPipe Pose Landmarker,
// Apache-2.0），推理走 WASM，文件不离开本机。
//
// 图片 → 只做站姿（7 项）；视频 → 站姿 + 出杆动态（5 项）。
//
// 视频的处理方式：不实时播放抓帧，而是按固定时间间隔 seek 到每个采样点再
// 推理。这样采样密度不受播放帧率影响，结果可复现，用户也能拖动滑杆逐帧看。

import { FilesetResolver, PoseLandmarker } from '../vendor/pose/vision_bundle.mjs';
import { normalizePose, POSE_CONNECTIONS, LM_NAMES } from '../src/pose/landmarks.js';
import { analyzeImage, analyzeSequence } from '../src/pose/analyze.js';
import { THRESHOLDS } from '../src/pose/checks.js';

const WASM_ROOT = '../vendor/pose/wasm';
const MODEL = '../vendor/pose/pose_landmarker_lite.task';

// 视频采样：每 50 ms 取一帧（20 fps）。手机慢动作录像本身帧率高，20 fps
// 足够切出后摆/前摆；再密只会让分析时间线性变长而不改善结论。
const SAMPLE_MS = 50;
// 最长分析时长。超过就只在中间取一段，避免一段 5 分钟视频把人等死。
// 一杆从站定到收杆大约 2 秒，取中间 12 秒足够覆盖好几杆。
const MAX_ANALYZE_MS = 12000;

const $ = (id) => document.getElementById(id);

const canvas = $('view');
const ctx = canvas.getContext('2d');
const video = $('video');
const statusEl = $('status');

let imageMode = null; // 'image' | 'video'
let frames = []; // [{t, poseResult}] —— 视频的逐帧结果
let currentReport = null;
let reportSeq = 0; // 每渲染一次报告加一，端到端测试靠它区分新旧
let lastPose = null; // 最近一次归一化后的姿态，调试用
let currentFrameIdx = 0;
let sourceWidth = 0;
let sourceHeight = 0;
let bitmap = null; // 图片模式下的 ImageBitmap

// ---------------------------------------------------------------- 模型加载

let landmarkerPromise = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

/** 创建一个 PoseLandmarker，GPU 失败时自动退回 CPU。 */
async function createLandmarker(runningMode) {
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL, delegate },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch {
    // 无头环境 / 没有可用的 GPU 后端时 GPU delegate 会抛错，退回 CPU
    return await PoseLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

function loadLandmarker() {
  if (landmarkerPromise) return landmarkerPromise;
  landmarkerPromise = (async () => {
    setStatus('正在加载姿态模型…');
    const lm = await createLandmarker('IMAGE');
    setStatus('模型就绪。', 'ok');
    return lm;
  })().catch((err) => {
    landmarkerPromise = null;
    setStatus(`模型加载失败：${err?.message ?? err}`, 'err');
    throw err;
  });
  return landmarkerPromise;
}

// ---------------------------------------------------------------- 画布

/** 让 canvas 的像素尺寸跟着源素材走，同时限制最大显示尺寸。 */
function fitCanvas(w, h) {
  const stage = $('stage');
  const availW = Math.max(240, stage.clientWidth - 36);
  const availH = Math.max(200, stage.clientHeight - 36);
  const scale = Math.min(availW / w, availH / h, 1);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;
}

/** 把 image 归一化坐标映射到 canvas 像素。 */
function toPx(p) {
  return { x: p.x * canvas.width, y: p.y * canvas.height };
}

function drawSource(source) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
}

/** 画骨架。image 坐标是归一化的，直接乘画布尺寸。 */
function drawSkeleton(pose) {
  if (!pose) return;
  const line = (a, b) => {
    if (!a || !b) return;
    const pa = toPx(a);
    const pb = toPx(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  };

  ctx.lineWidth = Math.max(2, canvas.width / 320);
  ctx.strokeStyle = 'rgba(74, 222, 128, 0.85)';
  ctx.lineCap = 'round';
  for (const [i, j] of POSE_CONNECTIONS) {
    line(pose[LM_NAMES[i]], pose[LM_NAMES[j]]);
  }

  // 关键点：可见度低的画灰，提醒用户这些点不可信
  for (const name of LM_NAMES) {
    const p = pose[name];
    if (!p) continue;
    const q = toPx(p);
    const vis = p.visibility ?? 1;
    const r = Math.max(2.5, canvas.width / 220);
    ctx.beginPath();
    ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    ctx.fillStyle = vis >= 0.55 ? '#4ade80' : 'rgba(139, 152, 169, 0.5)';
    ctx.fill();
  }
}

// ---------------------------------------------------------------- 报告渲染

function scoreClass(report) {
  if (report.score === null) return 'none';
  if (report.score >= 88) return 'good';
  if (report.score >= 74) return 'warn';
  if (report.score >= 58) return 'warn';
  return 'bad';
}

function fmtValue(c) {
  if (c.value === null || c.value === undefined) return '—';
  const v = c.value;
  switch (c.unit) {
    case '°':
      return `${v.toFixed(0)}°`;
    case '×肩宽':
    case '×躯干长':
    case '×击球前行程':
    case '×后摆':
      return `${v.toFixed(2)}${c.unit.slice(1)}`;
    case '偏差/行程':
      return `${(v * 100).toFixed(1)}%`;
    default:
      return v.toFixed(2);
  }
}

const CATEGORY_LABEL = { setup: '站姿', stroke: '出杆' };

// 单目相机天生测不准的指标（噪声与判定区间同量级）。界面上必须标出来，
// 否则用户会以为「这一项没判」是自己的问题。
const WEAK_LABEL = {
  stance_width: '站姿宽度',
  forearm_vertical: '后手前臂垂直',
  bridge_arm_straight: '架桥臂伸展',
  head_low: '头部高度',
  torso_lean: '躯干前倾',
  knee_bend: '屈膝程度',
  head_over_cue: '头在球杆上方',
};

function renderChecks(report) {
  const groups = { setup: report.setup, stroke: report.stroke };
  const weak = new Set(report.weakMetrics ?? []);
  const html = [];
  for (const key of ['setup', 'stroke']) {
    const list = groups[key];
    if (!list || !list.length) continue;
    const good = list.filter((c) => c.status === 'good').length;
    const measurable = list.filter((c) => c.status !== 'unknown').length;
    html.push(
      `<div class="grp"><div class="gt"><span>${CATEGORY_LABEL[key]}</span><span>${measurable ? `${good}/${measurable} 项规范` : '无法测量'}</span></div>`
    );
    for (const c of list) {
      const tag = c.indeterminate
        ? '<span class="tag">测不准</span>'
        : weak.has(c.id)
          ? '<span class="tag">单目易失真</span>'
          : '';
      html.push(
        `<div class="chk ${c.status}">` +
          `<span class="dot"></span>` +
          `<span class="n">${c.label}${tag}</span>` +
          `<span class="v">${fmtValue(c)}</span>` +
          `<span class="d">${c.detail}</span>` +
        `</div>`
      );
    }
    html.push('</div>');
  }
  $('checks').className = '';
  $('checks').innerHTML = html.join('');
}

function renderIssues(report) {
  if (!report.issues.length) {
    $('issues').className = 'empty';
    $('issues').textContent = report.score === null
      ? (report.enough === false
          ? `只测到 ${(report.coverage * 100).toFixed(0)}% 的项目，证据不足，不给总分。换一张能看清全身的照片。`
          : '没有可测量的项，无法给出结论。')
      : '所有能测的项目都在规范区间内。';
    return;
  }
  $('issues').className = '';
  $('issues').innerHTML = report.issues
    .slice(0, 5)
    .map(
      (c) =>
        `<div class="issue ${c.status}"><div class="t">${c.label} · ${fmtValue(c)}</div>` +
        `<div class="d">${c.detail}</div></div>`
    )
    .join('');
}

function renderReport(report) {
  currentReport = report;
  reportSeq++;
  const cls = scoreClass(report);
  $('score').className = `s-${cls}`;
  $('grade').className = `s-${cls}`;
  $('score').textContent = report.score === null ? '—' : String(report.score);
  $('grade').textContent = report.grade;

  const measured = report.checks.filter((c) => c.status !== 'unknown').length;
  const parts = [`共 ${report.checks.length} 项，测到 ${measured} 项`];
  parts.push(`证据覆盖 ${(report.coverage * 100).toFixed(0)}%`);
  parts.push(`置信度 ${(report.confidence * 100).toFixed(0)}%`);
  if (report.mode === 'video') {
    parts.push(`${report.frameCount} 帧`);
    if (report.averagedFrames > 1) parts.push(`站姿取 ${report.averagedFrames} 帧平均`);
  }
  $('conf').textContent = parts.join(' · ');

  renderIssues(report);
  renderChecks(report);
}

// ---------------------------------------------------------------- 图片流程

// 只收这三种：浏览器的 createImageBitmap 认它们，MediaPipe 也吃它们。
// 之前 accept 写的是 image/*，iPhone 拍的 HEIC 能被选进来，然后在
// createImageBitmap 里抛一句看不懂的错——用户只会觉得「这工具坏了」。
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm', 'video/quicktime']);

/** 把 <input type=file> 的 accept 与这段判断绑在一起，别只靠输入框拦。 */
function typeRejected(file, allowed, hint) {
  const type = (file.type || '').toLowerCase();
  if (allowed.has(type)) return null;
  const kind = type ? type.replace(/^image\/|^video\//, '').toUpperCase() : '没有扩展名信息';
  return `这个格式（${kind}）读不了。${hint}`;
}

async function handleImage(file) {
  const rejected = typeRejected(
    file,
    IMAGE_TYPES,
    '请用 PNG / JPEG / WebP；iPhone 的 HEIC 要先在相册里「导出」或截图成 JPEG。'
  );
  if (rejected) {
    setStatus(rejected, 'err');
    return;
  }
  imageMode = 'image';
  frames = [];
  $('scrubCard').hidden = true;
  $('empty').hidden = true;

  const lm = await loadLandmarker();
  setStatus('正在读取图片…');

  bitmap = await createImageBitmap(file);
  sourceWidth = bitmap.width;
  sourceHeight = bitmap.height;
  fitCanvas(sourceWidth, sourceHeight);
  drawSource(bitmap);

  setStatus('正在识别姿态…');
  // IMAGE 模式：单帧
  const result = lm.detect(bitmap);
  const pose = normalizePose(result);

  if (!result.landmarks?.length) {
    setStatus('图片里没有检测到人。换一张能看到全身的正面/侧面照片。', 'err');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  drawSkeleton(pose.image);
  lastPose = pose;
  const report = analyzeImage(result, { normalize: normalizePose });
  renderReport(report);
  setStatus('分析完成。', 'ok');
}

// ---------------------------------------------------------------- 视频流程

function seekTo(t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    const dur = video.duration;
    // 有些 webm（例如浏览器录屏、ffmpeg 直出）没有写时长元数据，
    // duration 会是 Infinity/NaN，这时不能拿它做上界。
    const cap = Number.isFinite(dur) ? Math.max(0, dur - 0.001) : t;
    video.currentTime = Math.min(t, cap);
    // 极端情况下 seeked 不触发（解码器卡住），别让整页永远等下去
    setTimeout(finish, 3000);
  });
}

async function handleVideo(file) {
  const rejected = typeRejected(
    file,
    VIDEO_TYPES,
    '请用 MP4 / WebM / MOV；手机录的原片一般可以直接用，转码后再试也行。'
  );
  if (rejected) {
    setStatus(rejected, 'err');
    return;
  }
  imageMode = 'video';
  frames = [];
  bitmap = null;
  $('empty').hidden = true;

  // VIDEO 模式需要单独的实例（runningMode 在创建时固定）
  setStatus('正在准备视频…');
  const videoLm = await createLandmarker('VIDEO');

  video.src = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('视频无法解码'));
  });

  // MediaRecorder 产出的 webm 不写时长元数据，duration 会一直是 Infinity。
  // 跳到极大时间点可以逼解码器算一遍时长，之后 duration 就是真实值。
  if (!Number.isFinite(video.duration)) {
    await new Promise((resolve) => {
      const done = () => {
        video.removeEventListener('durationchange', done);
        resolve();
      };
      video.addEventListener('durationchange', done);
      video.currentTime = 1e101;
      setTimeout(done, 2000);
    });
    video.currentTime = 0;
  }

  sourceWidth = video.videoWidth;
  sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) {
    setStatus('这个视频没有可用的画面（可能是纯音频或编码不支持）。', 'err');
    return;
  }
  fitCanvas(sourceWidth, sourceHeight);

  // 只在中间取一段，避免超长视频把分析时间拖到不可接受。
  // duration 可能是 Infinity（没写元数据的 webm），那就从头取一段。
  const dur = video.duration;
  const usable = Number.isFinite(dur) ? dur : MAX_ANALYZE_MS / 1000;
  const analyzeSpan = Math.min(usable, MAX_ANALYZE_MS / 1000);
  const startAt = Number.isFinite(dur) ? Math.max(0, (dur - analyzeSpan) / 2) : 0;
  const count = Math.max(2, Math.floor((analyzeSpan * 1000) / SAMPLE_MS));

  for (let i = 0; i < count; i++) {
    const t = startAt + (i * analyzeSpan) / count;
    await seekTo(t);
    // VIDEO 模式要求时间戳单调递增，用毫秒整数
    const ts = Math.round(i * SAMPLE_MS);
    const result = videoLm.detectForVideo(video, ts);
    frames.push({ t, poseResult: result });
    if (i % 5 === 0 || i === count - 1) {
      setStatus(`正在逐帧分析… ${i + 1}/${count}`);
      // 每 5 帧刷一次画面，让用户看到进度
      drawSource(video);
      const p = normalizePose(result);
      if (result.landmarks?.length) drawSkeleton(p.image);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const detected = frames.filter((f) => f.poseResult.landmarks?.length).length;
  if (detected === 0) {
    setStatus('整段视频里都没检测到人。请确认画面里有完整的人，且光线足够。', 'err');
    return;
  }

  const report = analyzeSequence(frames, { normalize: normalizePose });
  renderReport(report);

  // 逐帧滑杆
  $('scrubCard').hidden = false;
  $('scrub').max = String(frames.length - 1);
  $('scrub').value = '0';
  currentFrameIdx = 0;
  showFrame(0);

  setStatus(`分析完成：${frames.length} 帧中 ${detected} 帧检测到人。`, 'ok');
}

/** 把某一帧画到画布上，并刷新滑杆说明。 */
function showFrame(idx) {
  const f = frames[idx];
  if (!f) return;
  currentFrameIdx = idx;
  const pose = normalizePose(f.poseResult);
  drawSource(video);
  if (f.poseResult.landmarks?.length) drawSkeleton(pose.image);
  $('scrubInfo').textContent = `第 ${idx + 1} / ${frames.length} 帧 · t = ${f.t.toFixed(2)} s` +
    (f.poseResult.landmarks?.length ? '' : ' · 这一帧没有检测到人');
}

// ---------------------------------------------------------------- 事件

$('pickImage').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  handleImage(f).catch((err) => setStatus(`分析失败：${err?.message ?? err}`, 'err'));
  e.target.value = '';
});

$('pickVideo').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  handleVideo(f).catch((err) => setStatus(`分析失败：${err?.message ?? err}`, 'err'));
  e.target.value = '';
});

$('scrub').addEventListener('input', (e) => {
  showFrame(Number(e.target.value));
});

window.addEventListener('resize', () => {
  if (!sourceWidth) return;
  fitCanvas(sourceWidth, sourceHeight);
  if (imageMode === 'image' && bitmap) {
    drawSource(bitmap);
    if (currentReport) {
      // 重画骨架需要原始姿态，这里从报告里拿不到，直接重新识别一次太重。
      // 缩放后骨架消失是可接受的降级——用户可以重新选图。
    }
  } else if (imageMode === 'video' && frames.length) {
    showFrame(currentFrameIdx);
  }
});

// 供端到端测试用：把关键状态挂到 window 上
window.__pose = {
  get report() { return currentReport; },
  get seq() { return reportSeq; },
  get frames() { return frames.length; },
  get mode() { return imageMode; },
  get lastPose() { return lastPose; },
  thresholds: THRESHOLDS,
};
