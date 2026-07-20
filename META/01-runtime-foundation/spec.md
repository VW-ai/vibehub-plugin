# 01-runtime-foundation

## Intent

提供所有 host integrations、knowledge workflows 和 App 共用的本地、确定性、
可测试 runtime。核心逻辑只实现一次，CLI 与 MCP 是薄 adapter。

## Responsibilities

- SQLite lifecycle、schema migration 与 repo/worktree identity
- versioned operation contracts、shared dispatcher、typed receipts
- hook/event ingestion、runtime state、injection queue 与 projection/read models
- 无 App、无 daemon、无云服务时仍完整工作

## Non-goals

- 不在 core 内做语义分类或 workflow 方法论
- 不让 App 直接依赖私有 SQLite table shape
- 不在未裁决前切换 Git/YAML source of truth

## Active Specs

- [decision-workbench-011] Headless runtime 是可独立使用的产品
- [decision-project-025] Core/CLI/MCP/App 的服务骨架与职责分离
- [contract-runtime-001] 机器级单 SQLite 通过 canonical repo/worktree
  identity 隔离多个项目与 checkout

## Anchors

- `packages/core/src/`
- `packages/cli/src/`
- `packages/mcp/src/`
- `packages/core/src/db.ts`
- `packages/core/src/workflow-receipt-projectors.ts`
