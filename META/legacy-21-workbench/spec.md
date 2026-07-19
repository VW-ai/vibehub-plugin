# 21-workbench — 本地工作台 app

Pivot 主线的实现 room。产品拍板见 00-project-room specs(intent-002 + decision-016..027)。

**M0 前端 loop 已收官**(PR #744,五屏 demo 全 S1-S5,视觉基准 v8;
UI 长出的类型契约 = workbench/app-demo/src/*-types.ts ×5,后端实现清单)。

M1 已收官(b1-b4 ✅ + treemap spike ✅)。当前阶段:**M2 — Claude Code 集成层**:
Claude plugin(hooks + MCP + skill pack)+ 注入队列投递端 + 本地 context engine。
006–014 已裁;headless runtime、DB-native intelligence、production App controller、
v8 视觉权威与可代表发布物的 local/isolated gates 均已通过。下一 gate 是经明确
外发授权后的真实 Claude dogfood 闭环。015/016/intent-003 已进入 activation
实施序列:typed receipt → repo activation → setup skill/Claude → periodic
checkpoint → Codex parity → presentation rollout；Tauri/downloadable packaging
不作为前置条件。
代码落 workbench/packages/core+cli(library-first、CLI 零 LLM,decision-project-013/025)。

## Decisions

- [decision-workbench-001] 用户注入的里程碑分档 = 薄 LLM 分类 + 短摘要,CLI 本体保持零 LLM(active;机械兜底已实装 milestone.ts)
- [decision-workbench-002] 冲突解决反馈 + 日/周/月解决统计;裁决后 context 回送两侧 = 后续 prompt engineering 议题(active)
- [decision-workbench-003] 多主体条目统一语言 = subject-first;徽章 = waiting + 冲突对数(active)
- [decision-workbench-004] 队友 branch 映射语义:冲突候选=unmerged∧(无PR∨open)、basic 档 stalled/done、蒸馏前 Uncategorized 单地盘、detectedAt 首检保龄(active,2026-07-12 Wayne 逐条过审)
- [decision-workbench-006] hook 清单矩阵:九事件接线/稳态逐 hook 注入=0/Stop decision:block 唤醒/robustness 不自建监听器(active,2026-07-12 Wayne 批准)
- [decision-workbench-007] 微协议终稿:B1 四义务+manual 指针/B2 双分支/B3 locus 包装;Stop 使用官方 block wire format(active,2026-07-12 Wayne 批准)
- [decision-workbench-008] MCP capability = 确定性端点+质量闸;v0.2 诚实面为 register_scope/self_report/kb_retrieve/kb_operation/distill_operation/get_manual,legacy kb_record/kb_apply_distillation 已移除;description 只留机械契约与轻量 skill 路由(active,2026-07-13 integrity clarification)
- [decision-workbench-009] Claude plugin 三件套:hooks=when,MCP=deterministic capabilities,skills=how well;自然语言 skill 替代 codified workflow 是产品论题(active,2026-07-12 Wayne 批准)
- [decision-workbench-010] **Intelligence ownership = skill**:hooks 只管 when,MCP/core 只管确定性原语+质量闸;首批至少 ingest/distill/query 三 skill;description 不得拼成分布式 workflow;engine dogfood 先于 Tauri 打包(active,2026-07-12 Wayne 开工确认)
- [decision-workbench-011] **Headless runtime 是独立产品**:plugin+hooks+skills+MCP+CLI/core 自带 SQLite init 与完整 context 自循环;App 是可选 reader/intervention client;filesystem 仅 export;先保持 workbench subtree-ready,真实 dogfood 后再物理拆 repo(active,2026-07-12 Wayne 裁决)
- [decision-workbench-012] **DB-native skill intelligence**:skills 管语义与渐进 workflow,hooks=when,MCP/CLI/core 经版本化 contracts+共享 dispatcher 管确定性 integrity;canonical promotion guarded/reviewed,distillation 机器 validate/finalize immutable candidate 后再 human review→CAS activation;unresolved 诚实保留,App/Tauri 非 engine gate(active,2026-07-13 forward-test 收口)
- [decision-workbench-013] **Context-to-action workflow authority**:VibeHub 是 Claude Code/Codex 内的 context-to-action layer,不是开发中台;Task=独立 outcome,Run 承载 context/code authority,context-only 无 worktree、code-write Task 才 claim writer worktree;mechanical Run 可 append evidence/log/finding 但不可重定义 semantic truth;skill 判断 transition,hooks/MCP/core 触发并机械执行(active,2026-07-13 Wayne 批准;完整设计见 design-context-to-action-workflow.md)
- [decision-workbench-014] **Workbench design authority = v8 spatial-workbench**:`workbench/app/**` 保留紧凑 cool-neutral/system-type/territory-map 语言;根 DESIGN.md 的 editorial/Fraunces/warm-cream/forest-only 方向不适用于该边界;accessibility、reduced-motion、production coverage 与诚实 affordance/copy 仍为硬约束(active,2026-07-14 Wayne 视觉对照后裁决)
- [decision-workbench-015] **Agent-first onboarding**:plugin 机器级安装一次,项目内由独立 vibehub-setup skill 编排 init/instructions/doctor/activation;Installed→Connected→Activated;fresh repo 自然积累 context,existing repo 显式推荐 cold-start distill;App 只做同机制图形入口(active,2026-07-18 Wayne 批准)
- [decision-workbench-016] **Interaction & Presentation Protocol**:所有 VibeHub workflow 共用结构化 receipt 语义;Claude/Codex 使用宿主 affordance+标准文本,App 富渲染;silent/brief/expanded 控噪,成功反馈必须有确定性证据,不追求不可控自定义 TUI widget(active,2026-07-18 Wayne 批准)

## Future intents

- [intent-workbench-001] M3+ 操作舱前瞻:同一 PTY+xterm wrapper 的 Meta session 编排席 + Task session 接管席(draft,现在不做)
- [intent-workbench-002] context → action 前瞻:基于 feature room 生成强 action prompt 并发射 agent(draft,现在不做)
- [intent-workbench-003] 周期性 knowledge checkpoint:每隔若干 user turns 要求 agent 复查未沉淀的 durable context;hook 只管 cadence,模型+ingest skill 管语义与写入(active,2026-07-18 Wayne 批准进入实施)

## Changes

- [change-2026-07-12-team-visibility-slice] M1 ① 落地:core+cli 诞生,git+gh→SQLite→map 端到端实证(decision-github-003 ② 硬门槛完成)
- [change-2026-07-12-three-domain-schema] M1 ② 落地:三表域 schema 直译(migration 002)+ ActivityStore/GraphStore,DERIVED-NEVER-STORED 贯彻
- [change-2026-07-12-hook-cli-heart] M1 ③ 落地:vibehub hook CLI 心脏 + StateMachine,真 claude -p session 校准通过
- [change-2026-07-12-treemap-spike] Treemap spike:squarified 真布局替手调 demoLayout,蒸馏时算一次缓存(migration 003)
- [change-2026-07-12-demo-live-read] M1 ④ 落地:demo 切真 SQLite 读(vite middleware 现场导出),本地 hook 任务合并,e2e 172 全绿
- [change-2026-07-12-m2-integration-design] M2 第一批:设计块 A/B/C 落 draft(三卡点)+ 机械块 D(注入投递 Stop 唤醒/SessionStart 补送/pause 最严胜出/送达读侧语义;里程碑机械启发式 CJK 加权)
- [change-2026-07-12-m2-skill-intelligence-spine] M2 redo checkpoint:Claude plugin/hooks + MCP deterministic capability surface + ingest/distill/query skills + scope/commit/timeline/graph 读写骨架,本地 engine 链路验证通过;2026-07-13 v0.2 移除两个必失败 legacy mutation 名,改走 canonical operation adapters
- [change-2026-07-13-context-to-action-workflow] 产品协议补全:Task=outcome、Run=authority、code-write 才 claim workspace;机械执行 append evidence 不改 semantic truth;skill 判断 workflow transition;现有 audit B1-B6 与后续 durable Task/Run implementation 分界
- [change-2026-07-14-m2-audit-fix-closure] M2 productionization 审计 B1–B6 收口:repo-safe task identity、原子 hook 投递、正确 scope read、production App controller/receipts、v8 UX truth、representative artifact/isolated gates;B7 全矩阵验证通过
- [change-2026-07-18-workflow-receipt-contract] activation ⑥A:跨 workflow typed receipt contract + deterministic projectors 落地；修复 intervention replay outcome laundering；browser-safe contract 与 core runtime projection 分层，独立 review APPROVED
- [change-2026-07-18-repo-activation] activation ⑥B:setup inspect/apply/status + repo/worktree-safe managed instruction blocks；Installed→Connected→Activated 由 release、checkout-bound host handshake、post-handshake context value 的严格因果证据投影，独立 review APPROVED
- [change-2026-07-18-setup-skill] activation ⑥C implementation checkpoint:vibehub-setup skill + progressive onboarding/Claude/recovery intelligence；packaged artifact 用 installed CLI 验证幂等 setup 与 pre-handshake waiting，里程碑等待真实 Claude dogfood 外发 gate
- [change-2026-07-18-knowledge-checkpoint] activation ⑥D:task-scoped periodic knowledge checkpoint 落地——UserPromptSubmit 机械 cadence（prompt-id 去重、缺失不计数）、kb_provenance_events 高水位重置（failed/replay/未归属写入不重置）、pause/injection 严格优先、brief checkpoint receipt；提醒内嵌 task id 闭合 CLI 写入归属回路，独立 review APPROVED
- [change-2026-07-18-codex-activation-parity] activation ⑥E Plan B native adapter checkpoint：Claude/Codex 共用 SQLite/repo identity/skills/MCP/receipts；host-neutral hook ingestion + Codex 原生插件已接入 SessionStart/UserPromptSubmit/PostToolUse(apply_patch)，真实隔离 plugin install、installed hook 与 MCP smoke 通过；Stop/SessionEnd 等保持诚实缺席；独立复审与 fresh interactive Codex task dogfood 仍 pending
- [change-2026-07-18-presentation-rollout] activation ⑥F:presentation protocol 全面 rollout——receipt 投影入 browser-safe contract 层供 App/Node 共用、CLI init/doctor/inject 人类面渲染五段文本、reporting.md 成为五段+三档可见性 canonical、六 skill 挂接同一合约、App 单点投影+弱证据永不升级（强 queued evidence 才允许成功反馈与清空草稿）；两轮对抗 review 修复 P1×1+P2×7 后 APPROVED

实现期决策以 draft spec 落 specs/,Wayne 晨审 promote。
