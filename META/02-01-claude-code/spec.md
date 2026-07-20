# 02-01-claude-code

## Intent

提供 VibeHub 的 Claude Code 完整宿主适配：自然挂接 lifecycle hooks、MCP 与
skills，同时让插件安装物自包含、可验证、可恢复。

## Active Specs

- [decision-workbench-006] Hook 矩阵、稳态零重复注入与 Stop 唤醒
- [decision-workbench-007] 宿主微协议与 injection delivery contract

## Current Capability

- SessionStart、UserPromptSubmit、tool lifecycle、Notification、Stop、
  SessionEnd、sub-agent 与 failure evidence
- self-contained local marketplace build and isolated installed-artifact verification
- same SQLite/MCP/skills/receipts as Codex

## Anchors

- `.claude-plugin/plugin.json`
- `hooks/hooks.json`
- `scripts/build-claude-marketplace.mjs`
- `scripts/verify-plugin-artifact.mjs`
