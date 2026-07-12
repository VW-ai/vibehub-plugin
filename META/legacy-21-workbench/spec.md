# 21-workbench — 本地工作台 app

Pivot 主线的实现 room。产品拍板见 00-project-room specs(intent-002 + decision-016..027)。

**M0 前端 loop 已收官**(PR #744,五屏 demo 全 S1-S5,视觉基准 v8;
UI 长出的类型契约 = workbench/app-demo/src/*-types.ts ×5,后端实现清单)。

当前阶段:**backend M1** — 把类型契约实现成真数据路径,四刀 PR 级切片
(b1 团队可见垂直切片 ✅ / b2 三表域 schema / b3 hook CLI 心脏 / b4 demo 切真读)。
代码落 workbench/packages/core+cli(library-first、CLI 零 LLM,decision-project-013/025)。

## Decisions

- [decision-workbench-001] 用户注入的里程碑分档 = 薄 LLM 分类 + 短摘要,CLI 本体保持零 LLM(active)
- [decision-workbench-002] 冲突解决反馈 + 日/周/月解决统计;裁决后 context 回送两侧 = 后续 prompt engineering 议题(active)
- [decision-workbench-003] 多主体条目统一语言 = subject-first;徽章 = waiting + 冲突对数(active)
- [decision-workbench-004] 队友 branch 映射语义:冲突候选=unmerged∧(无PR∨open)、basic 档 stalled/done、蒸馏前 Uncategorized 单地盘、detectedAt 首检保龄(**draft 待晨审**)

## Changes

- [change-2026-07-12-team-visibility-slice] M1 ① 落地:core+cli 诞生,git+gh→SQLite→map 端到端实证(decision-github-003 ② 硬门槛完成)

实现期决策以 draft spec 落 specs/,Wayne 晨审 promote。
