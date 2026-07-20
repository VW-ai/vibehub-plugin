# 02-02-codex

## Intent

让 Codex 原生使用同一套 VibeHub SQLite、repo identity、skills、MCP 与 receipt
contract；能力通过宿主真实 affordance 实现，不伪造 Claude hook parity。

## Current Capability

- SessionStart
- UserPromptSubmit
- PostToolUse for `apply_patch`
- native Codex marketplace, hooks and MCP registration
- shared setup/query/ingest/distill/review/update skills

## Explicit Gaps

Codex 当前没有在本适配层宣称 Stop、SessionEnd、Notification、failure 或完整
tool lifecycle parity。新增能力必须以宿主稳定协议和真实安装验证为依据。

## Active Specs

- [decision-project-027] 双宿主支持按真实能力分档，不为落差发明 hack

## Anchors

- `.codex-plugin/plugin.json`
- `codex/hooks.json`
- `codex/mcp.json`
- `scripts/build-codex-marketplace.mjs`
- `scripts/verify-codex-plugin.mjs`
