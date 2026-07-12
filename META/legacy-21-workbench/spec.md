# 21-workbench — 本地工作台 app

Pivot 主线的实现 room。产品拍板见 00-project-room specs(intent-002 + decision-016..027)。

**M0 前端 loop 已收官**(PR #744,五屏 demo 全 S1-S5,视觉基准 v8;
UI 长出的类型契约 = workbench/app-demo/src/*-types.ts ×5,后端实现清单)。

M1 已收官(b1-b4 ✅ + treemap spike ✅)。当前阶段:**M2 — Claude Code 集成层**:
hook 清单矩阵 + 微协议 prompt(026)+ 注入队列投递端 + MCP 三组工具。
第一批已出:设计块 A/B/C 落 draft(⛔ 三卡点待 Wayne 逐块过,见
design-claude-code-integration.md)+ 机械块 D 实装(投递端/里程碑启发式)。
代码落 workbench/packages/core+cli(library-first、CLI 零 LLM,decision-project-013/025)。

## Decisions

- [decision-workbench-001] 用户注入的里程碑分档 = 薄 LLM 分类 + 短摘要,CLI 本体保持零 LLM(active;机械兜底已实装 milestone.ts)
- [decision-workbench-002] 冲突解决反馈 + 日/周/月解决统计;裁决后 context 回送两侧 = 后续 prompt engineering 议题(active)
- [decision-workbench-003] 多主体条目统一语言 = subject-first;徽章 = waiting + 冲突对数(active)
- [decision-workbench-004] 队友 branch 映射语义:冲突候选=unmerged∧(无PR∨open)、basic 档 stalled/done、蒸馏前 Uncategorized 单地盘、detectedAt 首检保龄(active,2026-07-12 Wayne 逐条过审)
- [decision-workbench-006] hook 清单矩阵:九事件接线/稳态逐 hook 注入=0/robustness 判决不自建监听器(**draft,⛔ 卡点1**)
- [decision-workbench-007] 微协议文本四组,style-tiles 式 2-3 候选逐条选(**draft,⛔ 卡点2**)
- [decision-workbench-008] MCP 工具面:register_scope/self_report/kb_retrieve/kb_record,description 即行为引导(**draft,⛔ 卡点3**)

## Changes

- [change-2026-07-12-team-visibility-slice] M1 ① 落地:core+cli 诞生,git+gh→SQLite→map 端到端实证(decision-github-003 ② 硬门槛完成)
- [change-2026-07-12-three-domain-schema] M1 ② 落地:三表域 schema 直译(migration 002)+ ActivityStore/GraphStore,DERIVED-NEVER-STORED 贯彻
- [change-2026-07-12-hook-cli-heart] M1 ③ 落地:vibehub hook CLI 心脏 + StateMachine,真 claude -p session 校准通过
- [change-2026-07-12-treemap-spike] Treemap spike:squarified 真布局替手调 demoLayout,蒸馏时算一次缓存(migration 003)
- [change-2026-07-12-demo-live-read] M1 ④ 落地:demo 切真 SQLite 读(vite middleware 现场导出),本地 hook 任务合并,e2e 172 全绿
- [change-2026-07-12-m2-integration-design] M2 第一批:设计块 A/B/C 落 draft(三卡点)+ 机械块 D(注入投递 Stop 唤醒/SessionStart 补送/pause 最严胜出/送达读侧语义;里程碑机械启发式 CJK 加权)

实现期决策以 draft spec 落 specs/,Wayne 晨审 promote。
