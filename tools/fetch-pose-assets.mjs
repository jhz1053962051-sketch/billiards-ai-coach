// 下载姿态模型资产到 vendor/pose/，让 demo 可离线运行。
// 只下载，不改动任何项目源码。资产许可证：MediaPipe Apache-2.0。
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = new URL('../vendor/pose/', import.meta.url);
const WASM_DIR = new URL('./wasm/', ROOT);

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';

const FILES = [
  [`${MP}/vision_bundle.mjs`, new URL('./vision_bundle.mjs', ROOT)],
  [`${MP}/wasm/vision_wasm_internal.js`, new URL('./vision_wasm_internal.js', WASM_DIR)],
  [`${MP}/wasm/vision_wasm_internal.wasm`, new URL('./vision_wasm_internal.wasm', WASM_DIR)],
  [`${MP}/vision.d.ts`, new URL('./vision.d.ts', ROOT)],
  [MODEL, new URL('./pose_landmarker_lite.task', ROOT)],
];

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

await fs.mkdir(WASM_DIR, { recursive: true });

for (const [url, dest] of FILES) {
  const name = path.basename(new URL(dest).pathname);
  try {
    const size = await download(url, dest);
    console.log(`ok  ${name.padEnd(32)} ${(size / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const total = (await fs.readdir(ROOT, { recursive: true }))
  .map((f) => path.join(new URL(ROOT).pathname.replace(/^\//, ''), f))
  .length;
console.log(`\nvendor/pose 就绪（${total} 个条目）`);
