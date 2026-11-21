# 项目约定

本文件是 `billiards-ai-coach` 的项目级指令，补充 `~/.dsh/AGENTS.md` 的全局规则，不放宽全局第 1 条（不熟悉的功能先检索再动手）。

## 注意事项

1. 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
2. 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 怎么执行第 2 条

- 一键跑完四项：`npm run verify`（`tools/verify-all.mjs`，自己起临时服务、按顺序跑完、收尾只留一句结论和一个退出码）。只改了解算或演示页、想快点看结果时用 `SKIP_POSE=1 npm run verify` 跳过最慢的姿态页（PowerShell 里先设 `$env:SKIP_POSE=1` 再跑）。跳过只记成「跳过」，汇总不会再打印「四项全过」，这一项也不算通过；要一条都不省，叠上 `VERIFY_STRICT=1`（PowerShell 里同样先设 `$env:VERIFY_STRICT=1`）。
- 单元测试：`npm test`（`node tools/test.mjs`），覆盖击球求解、摆球与规则、物理、对手回合、模块加载顺序、存档校验、vendor 资产哈希。优先用这两条，不要手写 `node --test` 参数：进程隔离开关的名字随 Node 小版本变过（22.8 起是 `--experimental-test-isolation=none`，23.6 起改成 `--test-isolation=none`），`tools/test.mjs` 会按运行版本挑对应的那个，写死就会在别的版本上报未知参数、整条命令失败。
- 演示页静态检查：`npm run check:demo`（`tools/check-demo.mjs`），校验每个演示脚本 import 的符号确实存在、用到的 DOM id 都在 HTML 里、`./file-guard.js` 排在所有 module 脚本之前、`src`/`demo` 里没有把物理步长写死成 `1/120`、CSP 与实际用法匹配、姿态页确实在门禁里并且缺素材时不会假绿。
- 演示页端到端验证：`npm run verify:demo`（`tools/verify-demo.mjs`），用真实浏览器跑求解、打杆与整局流程（需要先起静态服务，或用 `DEMO_URL` 指过去；它同样要启动 Chrome，得在放得开命名管道的环境里跑）。
- 姿态页验证：`node tools/verify-pose.mjs`（也可以 `npm run verify:pose`；需要先起静态服务，或用 `POSE_BASE` 指过去），验模型加载、图片/录像/反例三条路径。它要启动 Chrome，必须在放得开命名管道的环境里跑；缺素材的路径记「跳过」，要按失败算就加 `POSE_STRICT=1`（PowerShell 里先设 `$env:POSE_STRICT=1`）。
- 四项都通过后再提交（跳过不算通过）；提交信息写清改了什么、为什么改。