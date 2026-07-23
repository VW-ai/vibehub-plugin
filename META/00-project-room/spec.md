# vibehub-plugin — Project Room

## Intent

VibeHub 是运行在 Claude Code、Codex 等宿主 agent 内的 **plugin-first local
context runtime**。它通过 skills 承担语义 intelligence，通过 MCP、CLI、hooks
和 SQLite 提供确定性原语与运行证据；Workbench App 是同一运行时上的可选
observability / intervention surface，而不是使用 VibeHub 的前置条件。

核心产品承诺是：**关键 durable semantics 不漏，并能在后续工作中被正确
retrieve。** VibeHub 不承诺把完整 transcript 当作长期知识；原始事件与过程
证据可以保留在运行层，但只有 intent、decision、constraint、contract、
context、change 等可复用语义进入 durable knowledge lifecycle。

## Current Architecture

- SQLite 仍是当前 canonical source of truth。
- Git/YAML semantic store 是 draft exploration；在无损 round-trip spike 与
  正式评审通过前，不改变现行读写契约。
- Claude Code 与 Codex 使用同一 core、knowledge database、skills、MCP、
  repo/worktree identity 与 typed receipt contract。
- App 通过稳定 projection/read model 消费运行时，不能直接拥有第二套业务逻辑。

## Active Specs

- [intent-project-001] 开源 local-first plugin/runtime 的产品定位
- [decision-project-013] library-first core + 薄 CLI/MCP adapter
- [decision-project-014] 当前 SQLite source of truth
- [decision-project-015] Apache-2.0
- [decision-workbench-016] 跨 workflow presentation protocol
- [change-2026-07-18-presentation-rollout] presentation protocol 已接通
  setup/query/ingest/distill/inject/checkpoint 的真实 surfaces

## Draft Direction

- [intent-project-004] 探索 Git/YAML 作为 durable semantic canonical layer；
  只有正式 supersede `decision-project-014` 后才可切换。
- [decision-brand-logo-001] (draft) A Balanced 三块 territory 方案作为
  VibeHub 正式 Logo 基准，并以本地 SVG 资产展示在 README。

## Repository Rules

- intelligence belongs in skills; hooks answer **when**, deterministic runtime answers
  **what happened / whether it persisted**。
- success feedback 必须来自确定性证据，不能把 attempted、queued、claimed
  或 waiting 描述成 persisted。
- headless runtime 必须在没有 App、云服务和外部 LLM API key 的情况下工作。
- 新的 durable product decision 必须进入对应 Feature Room，而不是只留在聊天。

## Migration

本 META 从 `VW-ai/Vibehub/workbench/` 与原
`META/21-workbench` 提炼。原始 Room 的完整历史保留在
`META/legacy-21-workbench/`；新 Rooms 是独立仓库继续开发的 canonical
结构。
