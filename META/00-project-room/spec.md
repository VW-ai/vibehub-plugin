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

- Git/YAML 是 durable knowledge 与 Ticket semantics 的 canonical source of
  truth；branch、worktree、commit 与 merge 保持协作语义。
- SQLite 只保存运行协调、hook/event evidence、可重建 projection/cache 与尚未
  切入 Git authority 的 legacy repository state；它不拥有 Ticket meaning。
- Claude Code 与 Codex 使用同一 core、knowledge database、skills、MCP、
  repo/worktree identity 与 typed receipt contract。
- App 通过稳定 projection/read model 消费运行时，不能直接拥有第二套业务逻辑。

## Active Specs

- [intent-project-001] 开源 local-first plugin/runtime 的产品定位
- [decision-project-013] library-first core + 薄 CLI/MCP adapter
- [decision-project-028] per-repository Git semantic authority 与 SQLite
  operational/cache boundary
- [decision-project-015] Apache-2.0
- [decision-workbench-016] 跨 workflow presentation protocol
- [change-2026-07-18-presentation-rollout] presentation protocol 已接通
  setup/query/ingest/distill/inject/checkpoint 的真实 surfaces
- [constraint-project-quiet-intelligence-001] Codex-like quiet intelligence：
  轻、静、克制，但每个细节都能回应

## Active Direction

- [intent-project-004] 已通过 `decision-project-028` 落地为 per-repository
  Git/YAML durable semantic authority。
- [decision-brand-logo-001] (draft) A Balanced 三块 territory 方案作为
  VibeHub 正式 Logo 基准，并以本地 SVG 资产展示在 README。
- [intent-ticket-runtime-001] 把 durable semantic state 编译为严格的 Ticket
  Graph；M4 先达到 MR-ready，真实 Plugin feature dogfood 延后到 M5。

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
