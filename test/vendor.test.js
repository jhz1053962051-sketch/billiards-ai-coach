// vendor/pose 是随仓库分发的第三方资产，总共 20 MB，全是二进制或压缩过的产物。
// 它们不在 npm 依赖里、不走 lockfile，git diff 也看不出被换过——所以要钉住哈希。
//
// 这条测试保护的是两件事：
//   1. 模型/wasm 被误换（手动替换、下载脚本换了个版本、或者某次"顺手更新一下"）
//   2. 文件在传输中坏掉（部分下载、Git LFS 指针没真拉下来）
//
// 它跑得很快（读 20 MB 算 sha256，几百毫秒），放在 npm test 里不拖后腿。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'pose');
const MANIFEST = path.join(VENDOR, 'manifest.json');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('vendor/pose：每个文件的哈希都要和 manifest 对上', () => {
  assert.ok(fs.existsSync(MANIFEST), '缺 vendor/pose/manifest.json');

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entries = Object.entries(manifest.files ?? {});
  assert.ok(entries.length > 0, 'manifest 里没有列出任何文件');

  for (const [rel, want] of entries) {
    const file = path.join(VENDOR, rel);
    assert.ok(fs.existsSync(file), `缺文件 vendor/pose/${rel}`);
    assert.match(want, /^[0-9a-f]{64}$/, `manifest 里 ${rel} 的哈希不是 64 位小写十六进制`);
    assert.equal(sha256(file), want, `vendor/pose/${rel} 的哈希和 manifest 对不上（文件被换过或没下载完整）`);
  }
});

test('vendor/pose：目录里不该多出 manifest 没登记的文件', () => {
  // 只查顶层与 wasm/ 两层：这两层是下载脚本的产出范围。
  // 多出来的文件意味着有人在仓库里塞了个没人校验过的东西。
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const listed = new Set(Object.keys(manifest.files ?? {}));
  // manifest.json 自己、以及两份法务文本都不是资产，不该要求登记哈希
  const NOT_ASSETS = new Set(['manifest.json', 'LICENSE', 'NOTICE']);

  const found = [];
  for (const name of fs.readdirSync(VENDOR)) {
    if (NOT_ASSETS.has(name)) continue;
    const full = path.join(VENDOR, name);
    if (fs.statSync(full).isDirectory()) {
      for (const sub of fs.readdirSync(full)) found.push(`${name}/${sub}`);
    } else {
      found.push(name);
    }
  }

  const extra = found.filter((f) => !listed.has(f));
  assert.deepEqual(extra, [], `vendor/pose 里多出未登记的文件：${extra.join(', ')}`);
});