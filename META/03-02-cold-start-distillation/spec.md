# 03-02-cold-start-distillation

## Intent

为已有代码仓库提供显式、模型驱动、可 review 的 cold-start distillation，使
代码语义进入与日常 CRU 相同的 knowledge database，而不是生成一套平行文件。

## Active Specs

- [decision-workbench-012] DB-native skill intelligence 与 guarded promotion

## Workflow Contract

- inventory and scope before synthesis
- unresolved ambiguity remains explicit
- machine validate/finalize creates immutable candidate
- human review decides activation through CAS boundary
- setup may recommend distillation but must never hide it inside deterministic init

## Anchors

- `skills/vibehub-distill/`
- `skills/scripts/inventory.mjs`
- `skills/scripts/vh-distill.mjs`
- `packages/core/src/distillation-service.ts`
