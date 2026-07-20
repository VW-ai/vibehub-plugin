# 04-project-activation

## Intent

让用户机器级安装一次 plugin 后，在任意 exact checkout 中通过 agent 对话完成
幂等 setup，并清楚区分 Installed、Connected 与 Activated。

## Active Specs

- [decision-workbench-015] Agent-first onboarding 与 setup skill

## Contract

- setup skill owns workflow intelligence
- core/CLI own inspect/apply/status, identity, managed blocks and receipts
- existing-code repos receive an explicit cold-start distill recommendation
- fresh repos may accumulate context naturally
- App may render the same activation contract but cannot own a separate setup path

## Completion Semantics

- **Installed**: host can discover the machine-level plugin
- **Connected**: exact checkout is bound and host handshake/doctor are healthy
- **Activated**: real work has produced observable query or ingest value

## Anchors

- `skills/vibehub-setup/`
- `packages/core/src/project-activation.ts`
- `packages/core/src/runtime-lifecycle.ts`
- `packages/cli/src/main.ts`
# Canonical Specs

- [decision-workbench-015] (active) Agent-first, worktree-safe onboarding.
- [change-2026-07-18-repo-activation] (active) Managed instructions and typed
  activation primitives are implemented.
- [change-2026-07-18-setup-skill] (active) Prompt-first setup intelligence is
  packaged for both hosts.
