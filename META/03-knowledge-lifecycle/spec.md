# 03-knowledge-lifecycle

## Intent

确保 agent 在真实工作中能主动 retrieve、创建和更新 durable context，并以
可审计 provenance、关系和 review boundary 保持知识质量。

## Core Promise

系统优化目标不是“保存全部对话”，而是让关键 durable semantics 不漏，并在
需要时正确取回。Evidence capture、semantic settlement 与 retrieval 是三层
不同责任。

## Intelligence Boundary

- skills own decomposition, classification, placement, reconciliation and workflow
- hooks only decide when to remind or collect evidence
- CLI/MCP/core validate and execute versioned deterministic operations
- only persisted evidence may produce a success receipt

## Active Specs

- [decision-workbench-010] Intelligence ownership = skill

## Child Rooms

- `03-01-context-cru`: query / ingest / update / review / checkpoint
- `03-02-cold-start-distillation`: existing-code cold-start distillation
