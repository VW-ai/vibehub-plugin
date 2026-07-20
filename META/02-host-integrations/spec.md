# 02-host-integrations

## Intent

把 Claude Code、Codex 等宿主的原生生命周期信号适配到同一 VibeHub runtime，
同时诚实表达宿主能力差异，不为“看起来对齐”制造脆弱 hack。

## Architecture

- hooks = mechanical lifecycle evidence and delivery boundaries
- MCP = deterministic, discoverable capabilities
- skills = workflow intelligence and progressive context loading
- manifests/adapters remain thin; host-neutral semantics live below them

## Active Specs

- [decision-workbench-009] Plugin 三件套的职责分层

## Child Rooms

- `02-01-claude-code`: 完整 lifecycle 与 marketplace
- `02-02-codex`: 原生可用 subset 与同 runtime 激活
