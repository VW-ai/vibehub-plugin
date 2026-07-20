# 03-01-context-cru

## Intent

让 agent 在任务中主动 query、ingest、update 与 review durable context，并在长
会话中通过轻量 checkpoint 防止用户以为“已经记住”而实际没有 persistence。

## Active Specs

- [decision-project-026] 自发 CRU 是默认交互模型
- [decision-workbench-008] MCP 是确定性 capability 与质量闸
- [intent-workbench-003] 周期 checkpoint 只提供 cadence，语义判断仍归 skill

## Checkpoint Layers

1. hooks 自动捕获 mechanical evidence
2. periodic checkpoint 检查尚未沉淀的 durable semantics
3. commit / handoff / task close 提供更强的 semantic closeout 与 provenance
4. retrieval 应由 agent 主动发生；用户 query 是补充入口，不是唯一入口

## Anchors

- `skills/vibehub-query/`
- `skills/vibehub-ingest/`
- `skills/vibehub-update/`
- `skills/vibehub-review/`
- `packages/core/src/knowledge-service.ts`
- `packages/core/src/knowledge-checkpoint.ts`
# Canonical Specs

- [intent-workbench-003] (active) Task-scoped periodic knowledge checkpoint.
- [decision-project-026] (active) Context settlement uses canonical knowledge
  provenance rather than transcript retention.
- [decision-workbench-008] (active) Query/ingest/update/review share one
  governed lifecycle.
- [change-2026-07-18-knowledge-checkpoint] (active) Mechanical cadence,
  deduplication and same-task persistence reset are implemented.
