// 校准：用真实照片跑一次 MediaPipe Pose Landmarker，确认坐标约定。
// 用法: node tools/calibrate-pose.mjs <图片相对路径> [页面]
import fs from 'node:fs/promises';
import path from 'node:path';
import { launch } from './cdp.mjs';

const img = process.argv[2] ?? '_research/calib-people.jpg';
const page = process.argv[3] ?? '_research/calib.html';
const BASE = 'http://127.0.0.1:4173';

const imgName = path.basename(img);
const target = path.join('_research', imgName);

// 复制到 _research/ 下，让 calib.html 用相对路径能取到
await fs.copyFile(img, target).catch(() => {});

const browser = await launch({ port: 9451, width: 1200, height: 1000 });
try {
  await browser.goto(`${BASE}/${page}?img=./${imgName}`);
  const res = await browser.waitFor('window.__result || window.__error', {
    timeout: 60000,
    label: '姿态推理',
  });
  const err = await browser.evaluate('window.__error');
  if (err) throw new Error(err);

  const out = await browser.evaluate('window.__result');
  console.log('nPoses =', out.nPoses, ' hasWorld =', out.hasWorld, ' 尺寸 =', out.imgW + 'x' + out.imgH);

  console.log('\n--- worldLandmarks (米) ---');
  console.log('name'.padEnd(16), 'x'.padStart(9), 'y'.padStart(9), 'z'.padStart(9), 'vis'.padStart(7));
  for (const w of out.world) {
    console.log(String(w[0]).padEnd(16), String(w[1]).padStart(9), String(w[2]).padStart(9), String(w[3]).padStart(9), String(w[4] ?? '').padStart(7));
  }

  console.log('\n--- 关键推导 ---');
  const byName = Object.fromEntries(out.world.map((w) => [w[0], w]));
  const hipMidY = (byName.l_hip[2] + byName.r_hip[2]) / 2;
  const ankleMidY = (byName.l_ankle[2] + byName.r_ankle[2]) / 2;
  const noseY = byName.nose[2];
  console.log('髋中点 y =', hipMidY.toFixed(4), ' 踝中点 y =', ankleMidY.toFixed(4), ' 鼻 y =', noseY.toFixed(4));
  console.log('踝 - 髋 =', (ankleMidY - hipMidY).toFixed(4), '→', ankleMidY < hipMidY ? 'y 轴朝上（踝更小）' : 'y 轴朝下（踝更大）');
  console.log('鼻 - 髋 =', (noseY - hipMidY).toFixed(4), '→', noseY < hipMidY ? '头在上方（y 更小）' : '头在下方（y 更大）');

  const iByName = Object.fromEntries(out.image.map((w) => [w[0], w]));
  console.log('\nimage: 鼻 y =', iByName.nose[2].toFixed(4), ' 踝 y =', iByName.l_ankle[2].toFixed(4));

  const outDir = new URL('../_research/', import.meta.url);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(new URL('calibrate-pose.json', outDir), JSON.stringify(out, null, 2));
  console.log('\n已写入 _research/calibrate-pose.json');
} finally {
  await browser.close();
}
