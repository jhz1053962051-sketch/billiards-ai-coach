// 下载姿态模型资产到 vendor/pose/，让 demo 可离线运行。
// 只下载，不改动任何项目源码。资产许可证：MediaPipe Apache-2.0。
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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

// 下载完必须和 manifest 里登记的哈希对上。
// CDN 换版本、中间人替换、或者下载被截断，都会在这里停下来——
// 这 20 MB 是二进制，光看文件大小根本分辨不出内容有没有变。
const MANIFEST = new URL('./manifest.json', ROOT);
let expected = {};
try {
  expected = JSON.parse(await fs.readFile(MANIFEST, 'utf8')).files ?? {};
} catch {
  console.warn('没有 vendor/pose/manifest.json，跳过哈希校验（下载后请自己核对）');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

await fs.mkdir(WASM_DIR, { recursive: true });

for (const [url, dest] of FILES) {
  const name = path.basename(new URL(dest).pathname);
  // manifest 用的是相对 vendor/pose 的路径，wasm/ 下的要带上目录
  const rel = name.match(/^vision_wasm_internal/) ? `wasm/${name}` : name;
  try {
    const size = await download(url, dest);
    const got = sha256(await fs.readFile(dest));
    const want = expected[rel];
    if (want && got !== want) {
      throw new Error(`哈希对不上：manifest 记的是 ${want.slice(0, 16)}…，下下来的是 ${got.slice(0, 16)}…`);
    }
    console.log(`ok  ${name.padEnd(32)} ${(size / 1024).toFixed(0)} KB${want ? '  ✓ 哈希一致' : ''}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const total = (await fs.readdir(ROOT, { recursive: true }))
  .map((f) => path.join(new URL(ROOT).pathname.replace(/^\//, ''), f))
  .length;
console.log(`\nvendor/pose 就绪（${total} 个条目）`);
