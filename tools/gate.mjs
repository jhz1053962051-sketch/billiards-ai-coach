// 门禁判定：把「每项跑到什么结果」变成「退出码 + 汇总文本」的纯函数。
//
// 为什么单独抽出来：判定这几行以前和「跑命令、开浏览器」焊在一起，于是只能靠
// 人肉跑完整条链路来验——而那条链路要起 Chrome、跑几分钟、下 20 MB 模型。
// 偏偏假绿就出在判定这一层（SKIP_POSE 把姿态页记成 code 0，汇总照旧打印
// 「四项全过」），这种错最该被单测钉住，却被执行成本挡在门外。
// 抽成纯函数后，node:test 直接喂结果数组就能断言文案与退出码，CLI 只负责
// 收集结果、调用这里、按返回的 code 退出。
//
// 约定：两个 judge 都返回 { exitCode, lines, summary }。
//   lines   要逐行打印的文本（最后一行是结论）
//   summary lines.join('\n')，方便测试对整段做断言
// 这里不读 process.env、不碰文件系统——开关由调用方读出来当参数传，才能纯。

const CN_NUM = ['零', '一', '两', '三', '四', '五'];

/** 1 → 一、2 → 两……超出表就退回阿拉伯数字，不硬凑。 */
function cn(n) {
  return CN_NUM[n] ?? String(n);
}

/**
 * 一键门禁（verify-all.mjs）的判定。
 *
 * @param {object} input
 * @param {Array<{name:string, code:number, note?:string, skipped?:boolean}>} input.results
 *   每项的执行结果；skipped 为 true 表示「没跑，是显式跳过」而不是「跑过且失败」。
 * @param {boolean} input.strict VERIFY_STRICT=1：任何跳过都算没过。
 * @returns {{exitCode:number, lines:string[], summary:string}}
 */
export function judgeVerifyAll({ results = [], strict = false } = {}) {
  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => r.code !== 0);
  const skipped = results.filter((r) => r.skipped);

  // 为什么不一律把跳过算失败：SKIP_POSE=1 是 AGENTS.md/README 里写明的日常用法
  // （只改了解算或演示页，想快点看结果）。把它改成退 1 会打断既有用法，而且
  // 跳过姿势页并不代表代码有问题。所以默认退 0，但汇总必须说清少验了哪一项，
  // 绝不再出现「四项全过」；CI 与交付前要的「一项都不许省」由 VERIFY_STRICT=1
  // 这个单独开关表达，两者互不干扰。
  if (failed.length || (strict && skipped.length)) {
    const bad = [
      ...failed.map((r) => `${r.name}（退出码 ${r.code}）`),
      ...(strict ? skipped.map((r) => `${r.name}（跳过：${r.note ?? '无说明'}）`) : []),
    ];
    const lines = [];
    if (strict && skipped.length) lines.push('严格模式（VERIFY_STRICT=1）：跳过视同没过。');
    lines.push(`没过的项：${bad.join('、')}`);
    lines.push(`${bad.length} 项没过，别交付。`);
    return { exitCode: 1, lines, summary: lines.join('\n') };
  }

  // 有跳过但没失败：通过数只数真跑过的项，跳过项带着原因单独说，否则「4 项」
  // 会把没验的那项也算进去——这正是原来那句「四项全过」骗人的地方。
  if (skipped.length) {
    const notes = skipped.map((r) => `${r.name}跳过（${r.note ?? '无说明'}）`).join('、');
    const lines = [`${cn(ran.length)}项通过，${notes}。`];
    return { exitCode: 0, lines, summary: lines.join('\n') };
  }

  const lines = [`${cn(ran.length)}项全过。`];
  return { exitCode: 0, lines, summary: lines.join('\n') };
}

/**
 * 姿态页验证（verify-pose.mjs）的判定。
 *
 * @param {object} input
 * @param {number} input.passed 通过的 check 数
 * @param {string[]} input.failed 失败的 check 描述
 * @param {string[]} input.skipped 因缺素材没跑的路径描述（每条自带到原因）
 * @param {boolean} input.strict POSE_STRICT=1：缺素材导致的跳过算失败。
 * @returns {{exitCode:number, lines:string[], summary:string}}
 */
export function judgePose({ passed = 0, failed = [], skipped = [], strict = false } = {}) {
  if (failed.length) {
    const lines = [`失败 ${failed.length} 项：`, ...failed.map((m) => `- ${m}`)];
    return { exitCode: 1, lines, summary: lines.join('\n') };
  }

  // 一条都没验到就退 0，等于「没验的东西都算过」。干净 clone 缺素材时正是这样。
  if (passed === 0) {
    const lines = ['一条都没验到（素材缺失或页面没起来），不能算通过。'];
    return { exitCode: 1, lines, summary: lines.join('\n') };
  }

  // 缺素材不是代码坏了，所以默认仍然退 0，但汇总要把「通过几项、跳过几项」
  // 一起说出来，不能只报通过数。交付前想强制一条不漏时用 POSE_STRICT=1。
  if (strict && skipped.length) {
    const lines = [
      `严格模式（POSE_STRICT=1）：${skipped.length} 项因缺素材被跳过，视同失败。`,
      ...skipped.map((m) => `- ${m}`),
    ];
    return { exitCode: 1, lines, summary: lines.join('\n') };
  }

  const lines = skipped.length
    ? [`通过 ${passed} 项，跳过 ${skipped.length} 项（缺素材）`]
    : [`全部通过（${passed} 项）`];
  return { exitCode: 0, lines, summary: lines.join('\n') };
}