# 项目约定

本文件是 `billiards-ai-coach` 的项目级指令，补充 `~/.dsh/AGENTS.md` 的全局规则，不放宽全局第 1 条（不熟悉的功能先检索再动手）。

## 注意事项

1. 每次改动完成后，都必须创建一个对应的 Git commit，以便后续追踪和回滚。
2. 每次改动后，都必须编写或更新相关测试，并在交付给用户前，确保所有测试和验证全部通过。

## 怎么执行第 2 条

- 单元测试：`npm test`（`node --test --test-isolation=none "test/*.test.js"`），覆盖击球求解、摆球与规则、物理、对手回合。
- 演示页静态检查：`npm run check:demo`（`tools/check-demo.mjs`），校验 HTML/JS 的结构与文案。
- 演示页端到端验证：`npm run verify:demo`（`tools/verify-demo.mjs`），用真实浏览器跑求解、打杆与整局流程。
- 三项都通过后再提交；提交信息写清改了什么、为什么改。