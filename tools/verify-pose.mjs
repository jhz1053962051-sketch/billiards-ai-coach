// 姿态演示页的端到端验证。
//
// 覆盖三条路径，每条都在验证一个**具体的契约**，而不是"能跑起来就行"：
//
//   1. 图片（_research/cand/s01.png，斯诺克站姿教学照，全身可见）
//      → 模型加载、关键点识别、7 项站姿检查、报告渲染、DOM 与内存一致。
//      为什么不用 calib-people.jpg：那是三人合影且裁到膝上，双脚 visibility
//      只有 0.49–0.57，只能测到 2/7 项——那正好是「证据不足」的正确行为，
//      但拿它当"能跑通"的样本会把一个正常的拒绝误判成故障。
//
//   2. 真实录像（_research/vid/41903.mp4，Mixkit 免费素材，真人在球房击球）
//      → 出杆分段真的切出来了、5 条动态检查真的产出、站姿做了多帧平均、
//      逐帧滑杆能拖动。这是唯一能证明"动态分析不是摆设"的样本。
//      素材不进仓库（Mixkit 免费许可允许用在作品里，但不允许当素材转售），
//      缺失时这条路径会明确报「跳过」而不是假装通过。
//
//   3. 静止画面（页面内用 canvas 合成，同一张照片重复 2.2 秒）
//      → 这是**反例契约**：画面里没有人出杆时，必须老实返回 1 条
//      「没识别出出杆」的 unknown，而不是从噪声里硬凑出 5 条结论。
//      假动作比没有结论更有害，这条断言就是为了钉住它。
//
// 必须在 sandbox_permissions: "danger-full-access" 下运行（Chrome 多进程要建命名管道）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = process.env.POSE_BASE ?? 'http://127.0.0.1:4173';
const PHOTO = path.join(ROOT, '_research', 'cand', 's01.png');
const REAL_VIDEO = path.join(ROOT, '_research', 'vid', '41903.mp4');
const SYNTH = path.join(ROOT, '_research', 'still-pose.webm');
const SHOT_IMG = path.join(ROOT, '_research', 'pose-image.png');
const SHOT_VID = path.join(ROOT, '_research', 'pose-video.png');
const SHOT_STILL = path.join(ROOT, '_research', 'pose-still.png');

const fail = [];
const skip = [];
const log = (s) => console.log(s);
const check = (cond, msg) => {
  if (cond) log(`  ✓ ${msg}`);
  else {
    log(`  ✗ ${msg}`);
    fail.push(msg);
  }
};
const skipped = (msg) => {
  log(`  – 跳过：${msg}`);
  skip.push(msg);
};

/** 让 <input type=file> 指向本地文件，并触发 change。 */
async function setFile(page, selector, file) {
  await page.call('DOM.enable');
  const { root } = await page.call('DOM.getDocument', { depth: 0 });
  const { nodeId } = await page.call('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`找不到 ${selector}`);
  await page.call('DOM.setFileInputFiles', { files: [file], nodeId });
}

/** 在页面里合成一段「人体全程静止」的 webm，返回 base64。
 *
 * 坑一：headless Chrome 下 `canvas.captureStream(30)` 录出来是 110 字节的空文件
 * （只有 EBML 头，没有帧）。必须用 `captureStream(0)` 手动 `requestFrame()`
 * 逐帧推流。
 *
 * 坑二：如果每一帧的像素**完全相同**，VP8 会把重复帧全部压掉，录出来只有
 * 2 帧、时长 0.05 s（实测 9460 B）。所以右下角画一个 4×4 的方块循环变色，
 * 逼编码器每帧都出一帧。这个方块离人体极远，MediaPipe 的检测框根本不含它，
 * 关键点与静止时完全一致——人体区域仍然是严格静止的。
 */
const STILL_SCRIPT = `(async () => {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('照片加载失败'));
    i.src = '/_research/cand/s01.png';
  });
  const W = 480;
  const H = Math.round(W * img.height / img.width);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');

  const stream = c.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2000000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start();

  const t0 = performance.now();
  const DUR = 2.2;
  let n = 0;
  await new Promise((resolve) => {
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      cx.drawImage(img, 0, 0, W, H);
      // 角落里 4×4 的色块，只为让编码器每帧都出帧；不落在人体上。
      cx.fillStyle = (n++ % 2) ? '#000000' : '#ffffff';
      cx.fillRect(W - 4, H - 4, 4, 4);
      track.requestFrame();
      if (t < DUR) setTimeout(tick, 33); else resolve();
    };
    tick();
  });
  rec.stop();
  await stopped;
  const buf = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
})()`;

/** 等视频分析结束（用 seq 区分新旧报告，避免读到上一次的结果）。 */
async function runVideo(page, file, timeout) {
  const baseSeq = await page.evaluate('window.__pose.seq');
  await setFile(page, '#pickVideo', file);
  return page.waitFor(
    `window.__pose.seq > ${baseSeq} && window.__pose.mode === "video" && window.__pose.report`,
    { timeout, label: '视频分析完成' }
  );
}

const page = await launch({ port: 9461, width: 1280, height: 900 });
try {
  log(`打开 ${BASE}/demo/pose.html`);
  await page.goto(`${BASE}/demo/pose.html`);
  await page.waitFor('!!window.__pose', { timeout: 15000, label: '模块加载' });

  // ---------------------------------------------------------------- 图片
  log('\n[1/3] 图片路径');
  // 素材放在 _research/（已 gitignore，且是第三方图库的图，不适合随仓库分发）。
  // 缺了就明确报跳过，绝不拿"没跑"冒充"通过"。
  let hasPhoto = true;
  try {
    await fs.access(PHOTO);
  } catch {
    hasPhoto = false;
    skipped(`${path.relative(ROOT, PHOTO)} 不存在，跑 node _research/fetch-snooker.mjs 可下载候选照片`);
  }

  let report = null;
  if (hasPhoto) {
    const t0 = Date.now();
    await setFile(page, '#pickImage', PHOTO);
    report = await page.waitFor('window.__pose.report', {
      timeout: 180000,
      label: '图片分析完成',
    });
    log(`  用时 ${Date.now() - t0} ms`);

    check(report.mode === 'image', `模式是 image（实际 ${report.mode}）`);
    check(typeof report.score === 'number', `总分是数字（${report.score}）`);
    check(report.setup.length === 7, `站姿检查 7 项（实际 ${report.setup.length}）`);
    check(report.stroke.length === 0, '图片模式不做出杆检查');
    check(typeof report.grade === 'string' && report.grade.length > 0, `档位文案存在（${report.grade}）`);
    // 覆盖率门槛才是这个功能的核心契约：能测到的项要够多，否则给分就是编。
    const measured = report.checks.filter((c) => c.status !== 'unknown').length;
    check(report.coverage >= 0.45, `证据覆盖率 ≥ 45%（实际 ${(report.coverage * 100).toFixed(0)}%）`);
    check(measured >= 4, `至少测到 4 项（实际 ${measured}/${report.checks.length}）`);
    check(
      report.checks.every((c) => c.status === 'unknown' || typeof c.value === 'number'),
      '有结论的项都带数值'
    );
    check(
      report.checks.every((c) => c.status !== 'unknown' || c.detail.length > 6),
      '每一条测不了的项都说明了原因'
    );
    log(`  分数 ${report.score} / ${report.grade}，测到 ${measured} 项，覆盖 ${(report.coverage * 100).toFixed(0)}%`);

    // 页面上的文字真的渲染出来了（不是只有内存里的对象）
    const dom = await page.evaluate(`(() => ({
      score: document.getElementById('score').textContent.trim(),
      grade: document.getElementById('grade').textContent.trim(),
      checks: document.querySelectorAll('#checks .chk').length,
      issues: document.getElementById('issues').textContent.trim().length,
      status: document.getElementById('status').textContent.trim(),
    }))()`);
    check(dom.score === String(report.score), `DOM 上的分数一致（${dom.score}）`);
    check(dom.grade === report.grade, `DOM 上的档位一致（${dom.grade}）`);
    check(dom.checks === 7, `DOM 渲染 7 行检查（实际 ${dom.checks}）`);
    check(dom.issues > 0, '结论区有文字');
    log(`  状态行：${dom.status}`);

    await page.screenshot(SHOT_IMG);
    log(`  截图 ${path.relative(ROOT, SHOT_IMG)}`);
  }

  // ---------------------------------------------------------------- 真实录像
  log('\n[2/3] 真实录像路径');
  let hasReal = true;
  try {
    await fs.access(REAL_VIDEO);
  } catch {
    hasReal = false;
    skipped(`${path.relative(ROOT, REAL_VIDEO)} 不存在，跑 node _research/fetch-videos.mjs 可下载`);
  }

  if (hasReal) {
    const t1 = Date.now();
    const vreport = await runVideo(page, REAL_VIDEO, 300000);
    log(`  用时 ${Date.now() - t1} ms`);

    check(vreport.mode === 'video', `模式是 video（实际 ${vreport.mode}）`);
    check(vreport.frameCount >= 20, `采样帧数 >= 20（实际 ${vreport.frameCount}）`);
    check(vreport.setup.length === 7, `站姿 7 项（实际 ${vreport.setup.length}）`);
    // 这条是重点：真录像里必须真的切出一次出杆，否则动态分析就是摆设。
    check(vreport.stroke.length === 5, `出杆 5 项（实际 ${vreport.stroke.length}）`);
    check(vreport.averagedFrames > 1, `站姿做了多帧平均（${vreport.averagedFrames} 帧）`);
    const vmeasured = vreport.checks.filter((c) => c.status !== 'unknown').length;
    check(vmeasured >= 4, `至少测到 4 项（实际 ${vmeasured}/${vreport.checks.length}）`);
    log(
      `  分数 ${vreport.score} / ${vreport.grade}，测到 ${vmeasured} 项，` +
        `${vreport.frameCount} 帧，站姿平均 ${vreport.averagedFrames} 帧，覆盖 ${(vreport.coverage * 100).toFixed(0)}%`
    );
    const bad = vreport.checks.filter((c) => c.status === 'bad').map((c) => c.id);
    if (bad.length) log(`  判为不合格的项：${bad.join(', ')}`);

    const vdom = await page.evaluate(`(() => ({
      scrubVisible: !document.getElementById('scrubCard').hidden,
      scrubMax: Number(document.getElementById('scrub').max),
      scrubInfo: document.getElementById('scrubInfo').textContent.trim(),
      groups: document.querySelectorAll('#checks .grp').length,
    }))()`);
    check(vdom.scrubVisible, '逐帧滑杆已显示');
    check(vdom.scrubMax === vreport.frameCount - 1, `滑杆上限是 ${vdom.scrubMax}`);
    check(vdom.groups === 2, `检查分两组渲染（实际 ${vdom.groups}）`);
    log(`  ${vdom.scrubInfo}`);

    await page.evaluate(`(() => {
      const s = document.getElementById('scrub');
      s.value = String(s.max);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const lastInfo = await page.evaluate(`document.getElementById('scrubInfo').textContent.trim()`);
    check(lastInfo.includes(`${vreport.frameCount}`), `拖到末帧后文案更新（${lastInfo}）`);

    await page.screenshot(SHOT_VID);
    log(`  截图 ${path.relative(ROOT, SHOT_VID)}`);
  }

  // ---------------------------------------------------------------- 反例：静止画面
  log('\n[3/3] 反例：静止画面不该编出结论');
  if (!hasPhoto) {
    skipped('静止反例用的是同一张照片，照片缺失时无法合成');
  } else {
    const b64 = await page.evaluate(STILL_SCRIPT);
    const bytes = Buffer.from(b64, 'base64');
    await fs.writeFile(SYNTH, bytes);
    log(`  合成素材 ${path.relative(ROOT, SYNTH)}（${bytes.length} bytes，人体全程静止）`);

    const t2 = Date.now();
    const sreport = await runVideo(page, SYNTH, 240000);
    log(`  用时 ${Date.now() - t2} ms`);

    check(sreport.frameCount >= 20, `采样帧数 >= 20（实际 ${sreport.frameCount}）`);
    check(sreport.stroke.length === 1, `没有出杆时只给 1 条说明（实际 ${sreport.stroke.length} 条）`);
    check(
      sreport.stroke[0]?.id === 'stroke_straight' && sreport.stroke[0]?.status === 'unknown',
      `那条说明是 unknown（实际 ${sreport.stroke[0]?.id}:${sreport.stroke[0]?.status}）`
    );
    check(
      /没能在握杆手轨迹里识别出一次明显的出杆/.test(sreport.stroke[0]?.detail ?? ''),
      '文案说清了是「没识别出出杆」'
    );
    log(`  分数 ${sreport.score} / ${sreport.grade}，覆盖 ${(sreport.coverage * 100).toFixed(0)}%`);

    await page.screenshot(SHOT_STILL);
    log(`  截图 ${path.relative(ROOT, SHOT_STILL)}`);
  }

  // ---------------------------------------------------------------- 错误
  log('\n[控制台]');
  const errs = page.pageErrors();
  // MediaPipe 在首次推理时会用 console.error 打一行 XNNPACK delegate 的 INFO，
  // 那是正常信息，不是错误。
  const real = errs.filter((e) => !/XNNPACK delegate/i.test(e));
  if (real.length) {
    for (const e of real) log(`  ✗ ${e}`);
    fail.push(`控制台有 ${real.length} 条错误`);
  } else {
    log(`  ✓ 无错误（忽略 ${errs.length - real.length} 条 XNNPACK info）`);
  }
} finally {
  await page.close();
}

console.log('');
if (skip.length) console.log(`跳过 ${skip.length} 条：\n- ${skip.join('\n- ')}`);
if (fail.length) {
  console.error(`失败 ${fail.length} 项：\n- ${fail.join('\n- ')}`);
  process.exit(1);
}
console.log('全部通过');
