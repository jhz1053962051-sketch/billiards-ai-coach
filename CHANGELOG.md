# 变更记录

按提交日期倒序。每条对应一个**已提交**的 commit；工作树里还没落地的改动单独列在最后一节，等提交后补日期与前缀（`git log --oneline` 是唯一真源）。

## 2026-11-22

- perf(physics): 内联 `advanceBall` 里的 `snapToRolling` / `decaySpin` 与重复属性读取、把单次调用的小函数与常量就地展开，3 球同进程交替 A/B 的 p50 比值约 −9%（单侧 5.13 → 4.44、5.55 → 4.07 ms 两轮，p95 8.03 → 6.49 ms）、`advanceBall` 自耗 45.04% → 38.11%、仿真次数不变（33 次）；6 个局面整杆轨迹 SHA256 逐位一致、48 个局面选球零变化（`7958e31`，2026-11-22）
- perf(physics): 消除每子步分配与冗余 `snapToRolling`，3 球 p50 7.52 → 6.10 ms、仿真次数不变（33 次）、48 个局面选球零变化（`08250b1`，2026-11-22）

## 2026-11-21

- fix(save): 杆史单步做坐标范围校验——容差取 `max(2R, 最大袋口 captureR)`，越界的那一步丢掉并计入 `dropped`，不否掉整段杆史；台面尺寸从存档里那一局的球台现取，`state.js` 不写死球台尺寸（2026-11-21）
- fix(save): 坏档真的会删——`inspectSave` 先分「版本比本代码新」（`newer`，原样保留）与「`sanitize` 建不出一局」（`corrupt`，由 `loadSave` 执行 `removeItem`）；删失败时界面改说「本地存储删不掉，它还会在」，不再谎称已丢弃（2026-11-21）
- fix(demo): v1 老存档没有 `log` 时，对局记录区显示「—」占位，而不是只剩一行提示（2026-11-21）

- fix(demo): 切回八球/九球时把球台换回该玩法默认台并重新摆球，修掉「`kind` 变了、台面还是上一张」那一半漏掉的逻辑（2026-11-21）
- fix(demo): 存档升到 v2，带上对局日志与紧凑杆史（坐标 3 位小数、球序只写一次、上限 20 步、256 KB 预算）；撤销与读档后暂停对手自动出杆，台面上方给出「点此继续」提示条；窄屏力度条移出台面；练习候选进首屏（2026-11-21）
- perf(solver): 恢复 1.7 力度档，`d06` 质量损失从 5.47% 收到 1.63%（3 球 41 枪、p50 8.3 ms）（2026-11-21）
- refactor(solver): 加塞覆盖拆成 `spinCandidateScope` 常量，默认只给 rank-1 且只补最优那一档速度（2026-11-21）
- feat(solver): 切角统一为单一 `MAX_CUT_DEG = 82`，杆法/力度档位收紧到 35 次仿真（p50 7.6 ms）（2026-11-21）
- fix(ci): `verify-demo` 启动 Chrome 时补 `--disable-dev-shm-usage`，避免 /dev/shm 过小导致偶发崩溃（2026-11-21）
- ci: 重跑 verify（v5 首跑 node24 的 E2E 失败、代码未变，排查 runner 偶发）（2026-11-21）
- ci: `actions/checkout` 与 `setup-node` 升到 v5，消掉 node20 runtime 弃用告警（2026-11-21）
- ci: 加 GitHub Actions，node 22/24 矩阵跑单测、`check:demo`、`verify:demo`（姿态页不在 CI，素材在 gitignored 的 `_research/`）（2026-11-21）
- chore(check-demo): 钉住 `demo/state.js` 的零 DOM 契约（13 个 DOM 全局 + 检测器自检，362 → 378 项）（2026-11-21）
- fix(table): `createTable` 增加几何自洽性校验——未知预设、参数非正、袋口比球小、台面装不下球、库边段反向、袋口捕获圆相交都直接抛错（2026-11-21）
- refactor(demo): 抽出 `demo/state.js`，把不碰 DOM 的状态逻辑搬出 `app.js` 并补 36 项单测（2026-11-21）
- test(table,geometry): 台面与几何工具专项测试，删除 `geometry` 的死导出 `pointSegmentDistance`（2026-11-21）
- perf(solver): 候选用解析量预排序，只对 top-3 做杆法 × 力度细扫（仿真 116 → 68 次）（2026-11-21）
- refactor(sim): 三处一杆仿真收成 `src/sim.js` 的单一入口，时限/切角/母球判定都成了具名单源，行为不变（2026-11-21）
- fix(gate): 门禁跳过如实记账，新增 `VERIFY_STRICT` / `POSE_STRICT` 与可单测的纯函数判定（`tools/gate.mjs`）（2026-11-21）

## 2026-11-15

- perf: 走位分到顶就不再试更贵的速度档，并把这一层的天花板写进文档（2026-11-15）
- perf: 物理核两个热循环不再空转，求解快三成（2026-11-15）
- feat: 对手再往下想一层——算「他回完我之后我多难打」（2026-11-15）
- fix: 静止画面里的毫米级噪声不再被当成一次出杆（2026-11-15）

## 待提交（工作树）

- fix(demo): 手机端台面高度按 canvas 实际高度收紧——`#stage` 从固定 `48vh` 改成 `min(calc((100vw - 10px) * 0.552 + 32px), 48vh)` 并把 `min-height` 归零；390×844 实测台面区 405 → 242 px、台面与力度条之间空白 197 → 34 px，canvas 尺寸不变，桌面端不受影响
- chore(table): 删掉 `nearestPocket` / `cushionAt` 两个死 API（生产代码零调用、仅测试在用），连同 2 条专项用例一起删除（`test/table.test.js` 18 → 16），并补上文件末尾缺失的换行
- docs: 修正三处过期注释——CI 里「verify-demo 未带 `--disable-dev-shm-usage`」已作废（`06635c7` 起就带上了）、`check-demo` 不再写死 `state.js` 行数、`test/imports.test.js` 的描述从「循环依赖」改为「加载顺序契约」（环已断，由 `test/sim-core.test.js` 断言）