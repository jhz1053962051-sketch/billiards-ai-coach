# 变更记录

按提交日期倒序。每条对应一个**已提交**的 commit（`git log --oneline` 是唯一真源）；工作树里还没落地的改动等提交后再补条目，不提前写进这里。

## 2026-11-23

- feat(demo): 整局复盘图（终局台面 + 比分走势 + 关键杆），复用出图管线（`c0caec1`，2026-11-23）
- feat(pose): 指标对照参考区间（含偏差方向与建议），report 新增 `comparison` 字段，姿态页验证 27 → 80 项（`516ac6f`，2026-11-23）
- perf(physics): `findFirstEvent` 加保守粗筛与外提不变量，A/B ≈ −5%，事件序列与球位逐位一致（`30529b8`，2026-11-23）
- feat(demo): 分享局面图（全台俯视 + 局面要点），与「分享这一杆」共用出图管线（`97e36f2`，2026-11-23）
- chore(types): `physics`/`sim`/`solver`/`constants` 加 `@ts-check`，类型覆盖补全（`c0ed94b`，2026-11-23）
- feat(demo): 分享这一杆导出 1080 宽 PNG（台面俯视图+文字要点）（`b22d0be`，2026-11-23）
- refactor(rules): 八球/九球主函数按开球/进球/犯规/结局拆分，行为零变化（`de93e9b`，2026-11-23）
- fix(pose): 关键点缺失判 unknown，不再抛 TypeError（`426d4db`，2026-11-23）
- chore(types): 开启 `noUnusedParameters`（`safety.shoot` 未用形参改名 `_target`）（`5e0e2ee`，2026-11-23）

## 2026-11-22

- feat(stats): 局内统计与跨局战绩（最近 50 场），独立存储 `dsh-billiards-matches`，与存档互不覆盖（`58146a0`，2026-11-22）
- docs: 性能数字改为区间（4.4–6.1 ms），注明不同局面集不可相减（`6474d2d`，2026-11-22）
- chore: 删掉死函数 `isMoving`，为库边剪枝补上「真的被触发」的断言（`6d996ef`，2026-11-22）
- docs: 单球仿真耗时注释从 0.27 ms 改为实测 0.067 / 0.12 ms，性能数字标注局面集差异（`1b5db52`，2026-11-22）
- feat(practice): 手打一杆之后给「下一步」——回放结束后对终局再求解一次，把「某号球→某袋口、容错 ±X°、母球停哪」接在播报后面；偏离推荐超过 `AIM_NOTE_MIN_DEG = 0.2°`（滑块步进 0.05° 属噪音，0.2° 约 3.5 mm 已能改薄球成败）时补「已偏离推荐 ±X°」，直撞局面改说「已偏离直指方向」；求解走 `extras: false` 并在回放前同步算完，10 个真实终局实测 min 0.40 / p50 2.50 / max 14.10 ms，超过 `NEXT_SHOT_SLOW_MS = 50` ms 降级成「点『求解』看看」；文案全在 `demo/state.js` 的纯函数 `describeNextShot(input)` 里（`f172f6b`，2026-11-22）
- chore(typecheck): 清掉未使用符号并打开 `noUnusedLocals`——`pose/checks.js` 的 `pointLineDistance` / `straightnessError`、`rules.js` 里只在 import 行出现的 `ballName as snookerBallName`、解构后零读取的 `opp`、`constants.js` 零引用的 `MAX_TIP_OFFSET` 全部删除；`safety.js` 的 `MAX_CUT_DEG` 是「保留」而非删除（两条测试硬性要求它直接从 constants import），改用 `@typedef {typeof MAX_CUT_DEG}` 做类型引用；`noUnusedParameters` 试开只红 `shoot()` 的 `target`，未硬清（`4c4bd5b`，2026-11-22）
- refactor(pose): `evaluateSetup` 从 262 行拆成 28 行编排 + 7 个 `checkXxx(ctx)` 纯函数（`checkStanceWidth` / `checkForearmVertical` / `checkBridgeArmStraight` / `checkHeadLow` / `checkTorsoLean` / `checkKneeBend` / `checkHeadOverCue`），`report.checks` 逐字段一致、顺序不变，阈值与文案不动（`ea1115e`，2026-11-22）
- chore: 删掉 `demo/pose.js` 的 `WEAK_LABEL` 与 `solver.js` 里残留的 `MAX_TIP_OFFSET` import，顺手修正斯诺克平分重摆的播报文案（`fe2b494`，2026-11-22）
- fix(demo): canvas 可用宽改用 `stage.clientWidth − padding − 10`（rect 已含 padding，旧写法等于多减一遍）——桌面 1440×900 宽度差 38 → 0 px、纵横比 1.7635 → 1.8301、点选偏差 87.9 → 0.5 mm；手机 390×844 差 22 → 0 px、偏差 139.9 → 0.9 mm。同提交让存档 meta 记下写入方会话（`sessionStorage`），别的标签页写的档要先确认，「读入另一个标签页存的」按钮按了才读、不自动换桌（`ee136e2`，2026-11-22）
- refactor(rules): 抽出八球/九球共享的前奏 `beginShot(game, facts)` 与收尾 `settleShot(ctx, opts)`，差异收进 7 个参数（`endedFirst` / `foulCounter` / `groupLogic` / `ballInHandZone` / `illegalBreak` / `continuing` / `extraReport`），行为零变化；新增 `test/rules-shared.test.js` 四条护栏，把两条路径并排跑、逐字段比对（`f9fe403`，2026-11-22）
- fix(snooker): 彩球阶段的判据改成 `ballOn` 的类型（`typeof ballOn === 'number'`）而不是「台面上还剩几颗红球」——最后一颗红球之后的自由彩球也要回位；平分重摆时黑球点被占沿中线按 `R * 0.25` 让位（`blackRespotPosition`，判据 `2R + 1e-4`），让位量进摘要；九球开球三球不达标时 `continuing` 置 `false`（不达标不是犯规，但球权已交出，否则摘要与 `turn` 打架）（`285d018`，2026-11-22）
- fix(physics): 库边碰撞按能量预算记账，带塞出库不再凭空加速——恢复系数加上限（`cushionRestitutionMax = 0.95`、参考速度 `cushionSpeedRef = 4`，旧式 `|vn| ≥ 4 m/s` 时饱和到 1.0）、切向冲量以「让真实接触点滑移归零」所需的上界、`spinKick` 改用碰撞后的 `wz` 并夹进 `√(vt² + (1 − e²)vn²)` 预算。复现局面（pool9、母球 (2.24, 0.635)、angle 0.6、speed 8、`tip.a = +0.5`）实测出库 8.000 → 10.719 m/s（**+34%**）、合动能 8.840 → 9.781 J；修完出库不超过入射、逐子步合动能涨幅 0（提交信息里写作「+35% → −0.2%」「动能单步 +10.76J → 0」，以 `test/physics-energy.test.js` 的实测断言为准）。新增 `test/physics-energy.test.js` 四条（`1d71c37`，2026-11-22）
- fix(snooker): `snooker.reds` 每杆按台面实数回写（`st.reds = redsLeft`），存档与撤销栈不再把红球数重置为 15；新增 `test/snooker-save-reds.test.js`（`b0856a5`，2026-11-22）
- fix(snooker): 平分重摆之后交轮（`continuing = false`）、置 D 区持球（`ballInHand = { zone: 'd' }`）、重摆的黑球不计入 `report.pocketed` 而进 `report.spotted`——三件事少一件就会播报出「继续 + 换人」或「进了 21 号」这种自相矛盾的句子（`09f4700`，2026-11-22）
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
- fix(demo): 手机端台面高度按 canvas 实际高度收紧——`#stage` 从固定 `48vh` 改成 `min(calc((100vw - 10px) * 0.552 + 32px), 48vh)` 并把 `min-height` 归零；390×844 实测台面区 405 → 242 px、台面与力度条之间空白 197 → 34 px，canvas 尺寸不变，桌面端不受影响；同提交删掉 `nearestPocket` / `cushionAt` 两个死 API（生产代码零调用、仅测试在用，连 2 条专项用例一起删，`test/table.test.js` 18 → 16）并补上文件末尾缺失的换行（`5d2745b`，2026-11-21）
- docs: 修正三处过期注释——CI 里「verify-demo 未带 `--disable-dev-shm-usage`」已作废（`06635c7` 起就带上了）、`check-demo` 不再写死 `state.js` 行数、`test/imports.test.js` 的描述从「循环依赖」改为「加载顺序契约」（环已断，由 `test/sim-core.test.js` 断言）（`c6156ca`，2026-11-21）

## 2026-11-15

- perf: 走位分到顶就不再试更贵的速度档，并把这一层的天花板写进文档（2026-11-15）
- perf: 物理核两个热循环不再空转，求解快三成（2026-11-15）
- feat: 对手再往下想一层——算「他回完我之后我多难打」（2026-11-15）
- fix: 静止画面里的毫米级噪声不再被当成一次出杆（2026-11-15）