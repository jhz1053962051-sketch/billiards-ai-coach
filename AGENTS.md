# 项目约定

本文件是 `billiards-ai-coach` 的项目级指令，补充 `~/.dsh/AGENTS.md` 的全局规则，不放宽全局第 1 条（不熟悉的功能先检索再动手）。

## 注意事项

1. 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
2. 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 怎么执行第 2 条

- 一键跑完三项：`npm run verify`（`tools/verify-all.mjs`，自己起临时服务、跑完收尾，最后只留一句结论和一个退出码）。
- 单元测试：`npm test`（`node --test --test-isolation=none "test/*.test.js"`），覆盖击球求解、摆球与规则、物理、对手回合、模块加载顺序。
- 演示页静态检查：`npm run check:demo`（`tools/check-demo.mjs`），校验每个演示脚本 import 的符号确实存在、用到的 DOM id 都在 HTML 里、`./file-guard.js` 排在所有 module 脚本之前、`src`/`demo` 里没有把物理步长写死成 `1/120`。
- 演示页端到端验证：`npm run verify:demo`（`tools/verify-demo.mjs`），用真实浏览器跑求解、打杆与整局流程。它要启动 Chrome，必须在放得开命名管道的环境里跑。
- 三项都通过后再提交；提交信息写清改了什么、为什么改。