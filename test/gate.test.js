// 门禁判定的单元测试。
//
// 为什么单独给这两个 judge 写测试：这个仓库的门禁以前出过「假绿」——SKIP_POSE=1
// 把姿态页记成 code 0，汇总照旧打印「四项全过」；缺照片时 verify-pose 用空白图
// 过 3 条断言就打印「全部通过（3 项）」。这两处都不是执行失败，而是**判定**写错，
// 而判定原来焊在要起 Chrome 的脚本里，改一行只能靠跑几分钟整链路来验证。
// 现在判定被抽成 tools/gate.mjs 的纯函数，这里直接喂结果数组，把「跳过不等于
// 通过」和「严格模式才退 1」这两个契约钉住。

import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeVerifyAll, judgePose } from '../tools/gate.mjs';

/** 四项全过的结果，各用例在这个基础上改。 */
function allPass() {
  return [
    { name: '单元测试', code: 0 },
    { name: '演示页静态检查', code: 0 },
    { name: '浏览器端到端', code: 0 },
    { name: '姿态页验证', code: 0 },
  ];
}

test('一键门禁：四项全过时退 0，并明说四项全过', () => {
  const gate = judgeVerifyAll({ results: allPass(), strict: false });
  assert.equal(gate.exitCode, 0);
  assert.match(gate.summary, /四项全过/);
});

test('一键门禁：任一失败退 1，且汇总点出是哪一项', () => {
  const results = allPass();
  results[1] = { name: '演示页静态检查', code: 1 };
  const gate = judgeVerifyAll({ results, strict: false });
  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /演示页静态检查/);
  assert.match(gate.summary, /1 项没过，别交付。/);
});

test('一键门禁：SKIP_POSE 退 0，但汇总不许出现「四项全过」', () => {
  const results = allPass();
  results[3] = { name: '姿态页验证', code: 0, note: 'SKIP_POSE=1', skipped: true };
  const gate = judgeVerifyAll({ results, strict: false });

  // 退出码保持 0：SKIP_POSE 是 AGENTS.md 里写明的日常用法，不是失败。
  assert.equal(gate.exitCode, 0);
  assert.doesNotMatch(gate.summary, /四项全过/);
  assert.match(gate.summary, /三项通过/);
  assert.match(gate.summary, /姿态页验证跳过（SKIP_POSE=1）/);
});

test('一键门禁：VERIFY_STRICT=1 时跳过算失败，退 1', () => {
  const results = allPass();
  results[3] = { name: '姿态页验证', code: 0, note: 'SKIP_POSE=1', skipped: true };
  const gate = judgeVerifyAll({ results, strict: true });

  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /VERIFY_STRICT=1/);
  assert.match(gate.summary, /姿态页验证（跳过：SKIP_POSE=1）/);
});

test('一键门禁：普通模式下失败与跳过同时存在时，只数真失败的项', () => {
  const results = allPass();
  results[1] = { name: '演示页静态检查', code: 1 };
  results[3] = { name: '姿态页验证', code: 0, note: 'SKIP_POSE=1', skipped: true };
  const gate = judgeVerifyAll({ results, strict: false });

  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /1 项没过，别交付。/);
  // 跳过的那项不该被算成第 2 项失败，否则「N 项没过」的数字会漂。
  assert.doesNotMatch(gate.summary, /2 项没过/);
});

test('姿态页：一条都没验到就退 1，不许当通过', () => {
  const gate = judgePose({ passed: 0, failed: [], skipped: [] });
  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /一条都没验到/);
});

test('姿态页：通过 3 项但有 2 条缺素材跳过时，汇总要报出跳过数', () => {
  const gate = judgePose({
    passed: 3,
    failed: [],
    skipped: ['照片静图路径（缺素材）', '录像反例路径（缺素材）'],
  });
  // 默认不退 1：缺素材是环境问题，不是代码坏了（POSE_STRICT 才升级成失败）。
  assert.equal(gate.exitCode, 0);
  assert.match(gate.summary, /通过 3 项/);
  assert.match(gate.summary, /跳过 2/);
  assert.match(gate.summary, /缺素材/);
});

test('姿态页：POSE_STRICT=1 时缺素材的跳过视为失败，退 1', () => {
  const gate = judgePose({
    passed: 3,
    failed: [],
    skipped: ['照片静图路径（缺素材）', '录像反例路径（缺素材）'],
    strict: true,
  });
  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /POSE_STRICT=1/);
  assert.match(gate.summary, /照片静图路径/);
});

test('姿态页：素材在但页面失败时，照旧退 1 并列出失败项', () => {
  const gate = judgePose({ passed: 8, failed: ['分数对不上'], skipped: [] });
  assert.equal(gate.exitCode, 1);
  assert.match(gate.summary, /分数对不上/);
});