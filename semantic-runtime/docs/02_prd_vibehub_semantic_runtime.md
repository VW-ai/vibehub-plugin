# PRD — VibeHub Semantic Runtime

**Status:** Proposed / Draft for review
**Version:** 0.1
**Date:** 2026-09-19
**Product thesis:** Ambient semantic infrastructure for agentic development
**Primary concept:** Semantic Runtime + Policy Graph + Semantic Working Graph

---

# 1. Executive Summary

VibeHub 下一阶段不再只把自己定义为一个 Git-native coding-agent plugin，而是一个 **Semantic Runtime**：它持续观察开发活动，将来自 Agent session、Git、Slack、Docs、Issues 等来源的 raw work signals 转换成共享的 semantic state，并在恰当时机把正确的信息带回给正在工作的 Agent 或人。

产品的核心变化是：

```text
Before
User explicitly asks Agent to:
- read context
- remember something
- inspect a room
- compact history
- find a previous decision

After
VibeHub continuously:
- perceives
- classifies
- associates
- retrieves
- injects
- escalates
```

Fast semantic decision models（初始候选为 Jev；架构上必须 model-agnostic）负责大量高频、bounded 的判断；frontier worker model 只处理真正需要 reasoning、synthesis、reconciliation 或 canonicalization 的问题。

这套系统的核心不是“AI memory”。它的核心是：

> **持续把 raw work 编译成 semantic working state，再按当前任务编译成 agent-specific context。**

VibeHub 已经拥有 Goal / Epic / Ticket / Acceptance / Context / Room / Authority / Evidence / Outcome 等开发语义，因此相比通用 memory 工具，它可以用更强的 domain ontology 驱动 Policy Graph。

产品原则：

> **Fast models get attention authority. Canonical truth remains governed by provenance, workers, deterministic checks, and explicit human boundaries.**

---

# 2. Problem Statement

## 2.1 当前 Agent 系统反复“重新理解”同一个世界

长任务中的 coding agent 每个 session 都在重复做大量工作：

- 重新找之前的设计决定；
- 重新发现哪些文件/模块和当前任务相关；
- 重新判断 tool output 哪些有用；
- 重新识别哪些 observation 是 Evidence；
- 重新判断是否出现新 work item；
- 重新恢复 context；
- context 过长后再重新总结一次整个 trajectory。

这些行为的共同问题是：**semantic understanding 被当成 transient cognition，而不是 persistent system state。**

## 2.2 当前 Context 产品要求用户主动“管理记忆”

多数 memory / context 系统依赖显式动作：

- “记住这个”
- “查一下之前的决定”
- “把这段存到 memory”
- “去读这个 room”
- “summarize / compact”

这是一种不完整的 abstraction。用户的目标是开发，不是维护 AI memory。

## 2.3 纯 embedding retrieval 不理解 development lifecycle

Vector search 很适合 candidate generation，但不能独立回答：

- 这是不是一个决定？
- 这是 Evidence 还是 transient output？
- 它是否与某个 Acceptance 冲突？
- 它是否应该进入 canonical Context？
- 是否值得现在 interrupt Agent？
- 是否意味着要创建新的 independently schedulable work？

这些都需要 domain semantics。

## 2.4 长上下文不是无限免费的

即使 context window 很大，长任务仍然面临：

- attention / decode cost；
- repeated prefill；
- poor relevance density；
- compaction information loss；
- prompt/KV reuse 与频繁 rewrite 的冲突。

系统需要一个持续维护 semantic state、但低频改变 worker prompt 的机制。

---

# 3. Why Now

本方向成立依赖三个条件同时出现：

### 3.1 Agent host 越来越开放生命周期入口

Coding agent 生态逐步开放 skills、hooks、MCP、tool interfaces、session events 和 local integrations，使 VibeHub 可以作为 sensor + actuator 嵌入，而不是另造 chat UI。

### 3.2 VibeHub 已经拥有 development ontology

VibeHub 已有结构化世界模型：

- Goals / Epics
- Tickets
- Acceptance / Contract revisions
- Context / Rooms
- Decisions / Constraints
- Authority
- Evidence
- Outcomes
- Dependencies
- Provenance

这使 semantic judge 可以回答非常 bounded 的问题，而不是从零理解世界。

### 3.3 Fast semantic decision models 改变 economics

Jev-like models 使大量低延迟 semantic judgments 有机会从 expensive generation 中分离出来。

因此以前不经济的 pattern：

> “每个 meaningful event 都判断一下。”

现在可能成为合理的 runtime primitive。

---

# 4. Product Vision

## 4.1 Vision statement

> **VibeHub is the semantic runtime that sits alongside your agents, continuously understanding work and bringing the right context back exactly when it becomes useful.**

## 4.2 用户最终感知

理想情况下用户不需要知道 Runtime 每秒做了什么。

用户只会感受到：

- Agent 更少忘记约束；
- 不用重复解释过去的项目背景；
- Slack / Docs 中刚发生的关键决定能自然进入工作；
- 正在做的 Ticket 会自动得到相关 Context；
- Evidence 更完整；
- Agent 不再重复搜索已经解决过的问题；
- 长任务 compaction 后状态不容易“失忆”；
- 手机或网页上可以直接查询项目“为什么是这样”。

## 4.3 产品身份

VibeHub 不应成为：

- another chat client；
- generic vector memory；
- another agent framework；
- Jev API wrapper；
- mandatory workflow engine。

VibeHub 应成为：

> **development semantic infrastructure。**

---

# 5. Product Model

整个产品分为五个核心层。

```text
Sources
Agent / Git / Slack / Docs / Issues / Human
                         │
                         ▼
                   Semantic Runtime
                         │
                 ┌───────┴────────┐
                 │  Policy Graph  │
                 └───────┬────────┘
                         │
                Semantic Working Graph
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
      Context          Workers       Audit / UI
      Compiler
          │
          ▼
        Agents
```

### 5.1 Plugin / Host Adapter

角色：**Sensor + Actuator**。

负责：

- capture explicit host events；
- expose query interface；
- deliver context injection；
- surface high-priority conflict / human boundary；
- receive worker result / semantic update。

### 5.2 Semantic Runtime

角色：产品 kernel。

负责：

- event normalization；
- semantic judge invocation；
- Policy Graph execution；
- Semantic Working Graph updates；
- worker scheduling；
- retrieval / context materialization；
- semantic compaction；
- sync / connector coordination。

### 5.3 Semantic Working Graph

介于 raw events 与 canonical truth 之间的概率化工作态。

包含：

- candidate entities；
- candidate relations；
- relevance scores；
- confidence；
- provenance；
- task phase；
- lifecycle state；
- unresolved conflicts；
- semantic pointers。

### 5.4 Canonical Plane

可信 durable state。

初始阶段继续兼容/利用 VibeHub 既有对象：

- Ticket
- Context
- Authority
- Evidence
- Outcome
- Decision / Constraint

是否全部继续 Git-owned 是一个后续产品/架构决策，而非 MVP 前提。

### 5.5 Semantic Cloud

跨 session / device / project 的 persistent semantic plane。

支持：

- cloud sync；
- connector ingestion；
- shared enterprise project graph；
- mobile/web query；
- enterprise policy；
- managed worker execution。

---

# 6. Core Concept: Policy Graph

## 6.1 定义

Policy Graph 是由多个 bounded semantic decisions 组成的有向图。

每个 node 做一件很窄的事情：

- Is this relevant?
- Which project?
- Which semantic type?
- Which Ticket?
- Which Room?
- Is it durable?
- Is it Evidence?
- Does it contradict known state?
- Is immediate injection useful?
- Should a worker be invoked?

Edge 根据：

- confidence；
- policy；
- event type；
- current runtime state；
- enterprise rules；
- user preferences；
- cost / latency budget。

## 6.2 Top-level action space

建议统一成少量 runtime actions：

```text
IGNORE
INGEST
INJECT
DEFER
ESCALATE
```

其中：

### IGNORE
Transient、irrelevant、duplicate，不进入 semantic graph。

### INGEST
进入 candidate semantic state，但不自动成为 canonical truth。

### INJECT
把已有 semantic state 带回当前 consumer。

### DEFER
保留 candidate / job，在 checkpoint、idle、phase transition 时继续处理。

### ESCALATE
交给 worker model 或 human authority。

## 6.3 Ensemble policy

不建议简单重复问同一个问题三次取平均。

更优策略：

- 多个 orthogonal questions；
- uncertainty-band escalation；
- fast judge + deterministic signal；
- high-impact decisions 要求多信号一致。

例如：

```text
score > 0.90 → direct policy
score < 0.10 → direct reject
0.10–0.90   → secondary policy / worker depending on impact
```

具体阈值必须通过 benchmark 学习，不写死为产品真理。

---

# 7. Product Surfaces

## 7.1 Ambient Coding Integration

用户继续使用 Codex / Claude Code / Cursor 等原生界面。

VibeHub 通过 adapter 获取 host 可以暴露的 lifecycle event，并提供：

- on-demand context query；
- soft semantic pointers；
- hard constraint injection；
- worker result callback；
- Ticket / Evidence / Context projection。

原则：**不要求用户迁移聊天界面。**

## 7.2 Semantic Activity / Audit View

不展示 vanity metrics，而展示可审计的 semantic work：

```text
Today
Reviewed            184 events
Ignored              147 transient events
Connected             26 to active work
Updated                7 semantic entities
Injected               3 high-value contexts
Escalated              1 ambiguity
```

每个 item 可展开：

- source；
- reasoning category（不是隐藏 CoT，而是 policy reason）；
- confidence；
- relation；
- consuming agent / task；
- final action；
- canonical promotion status。

## 7.3 Project Semantic Explorer

替代“memory folder”心智。

允许查看：

- active semantic entities；
- project decisions；
- constraints；
- ticket relationships；
- conflicts；
- authority；
- recent semantic changes；
- source provenance。

## 7.4 Context Query

用户或 Agent 可以自然语言提问：

- “为什么 refresh token 不能改 schema？”
- “我们之前在哪里处理过类似 race？”
- “这个 Ticket 的关键决策是什么？”
- “最近一周 auth 相关有哪些新决定？”

由 Context Query Agent 通过 Semantic Graph + source retrieval 回答。

## 7.5 Mobile / Lightweight Access

目标不是移动端 coding，而是：

- project recall；
- decision lookup；
- progress/context briefing；
- human authority decision；
- active semantic change review。

---

# 8. Core User Journeys

## 8.1 Journey A — Coding Session 自动补 Context

1. 用户打开已有 repo，开始修 auth bug。
2. Plugin 识别当前 repo、branch、active work。
3. Runtime 识别当前 task 相关 semantic neighborhood。
4. 默认只提供 silent availability。
5. Agent 准备修改受 Authority 管辖的 schema。
6. Policy Graph 判断 `high relevance × high consequence`。
7. Runtime 注入一条短 Context：禁止更改该 schema，并附 canonical source pointer。
8. Agent 在不需要用户主动“查 Context”的情况下避免错误。

## 8.2 Journey B — Slack 决定自动进入项目语义

1. Slack 中后端团队说：“本周 refresh-token schema 暂不改。”
2. Connector 发送 message event。
3. Policy Graph 判断它可能是 project decision。
4. 关联 auth project / room / active Ticket。
5. 作为 Candidate Decision 进入 Semantic Working Graph。
6. 若与已有计划冲突，升级 worker reconciliation。
7. Worker 验证来源与现有 state，提出 canonical Context 更新。
8. Coding Agent 后续需要时自然收到该决定。

## 8.3 Journey C — Evidence 自动映射

1. Agent 跑测试。
2. Tool result 被识别为 Evidence candidate。
3. Policy Graph 判断它最可能支持 Acceptance A-2。
4. Runtime 记录 candidate mapping。
5. Ticket closeout 时，独立 reviewer 直接拿到 Evidence shortlist 和 raw source。
6. Reviewer 仍独立 adjudicate，不由 fast judge 宣布成功。

## 8.4 Journey D — Long Task Compaction

1. Session 持续增长。
2. Runtime 持续维护 semantic state，但不频繁重写 prompt。
3. Context pressure 或 phase transition 到达 checkpoint。
4. Context Compiler 从 Semantic Working Graph 生成 compact continuation context。
5. 保留 active constraint、decision、unresolved issue、evidence pointer 和 current plan。
6. Agent 继续工作，不重新理解全部历史。

## 8.5 Journey E — Cross-project recall

1. 用户在 Project B 遇到 retry race。
2. Context Query Agent 查询 semantic graph。
3. 找到 Project A 半年前类似的 Decision / Evidence / source commit。
4. Runtime 将其作为 related prior art 而非 canonical project rule 提供。
5. 用户/Agent 决定是否复用。

---

# 9. Functional Requirements

## 9.1 Ingress

### FR-ING-01 Event ingestion
系统必须接收标准化 event：Agent / Git / Connector / Human / System。

### FR-ING-02 Admission
每个 meaningful event 必须能被 fast policy 判定：ignore / candidate / escalate。

### FR-ING-03 Semantic typing
系统必须支持将 candidate 映射到 domain type，至少包括：

- decision
- constraint
- fact
- evidence
- change
- authority-related
- task/work discovery
- transient observation

### FR-ING-04 Association
系统必须能关联到多个 candidate entities，不限 top-1：

- project
- room
- ticket
- acceptance
- context
- authority
- other semantic entities

### FR-ING-05 Provenance
任何 semantic object 都必须保留 source pointer。

### FR-ING-06 Candidate-first
Fast judge 不能直接覆盖 canonical truth。

---

## 9.2 Egress

### FR-EGR-01 Query-aware retrieval
Retrieval 必须支持当前 task / agent state 作为 query context。

### FR-EGR-02 Multi-stage retrieval
至少支持：

- candidate generation；
- semantic gating/ranking；
- relation expansion；
- source materialization。

### FR-EGR-03 Injection modes
必须至少支持：

1. silent availability；
2. soft pointer；
3. hard context injection。

### FR-EGR-04 Interrupt policy
Hard injection 必须由 impact + relevance policy 控制，避免 context spam。

### FR-EGR-05 Context compilation
输出给 Agent 的 Context 是 Runtime materialization，而不是 semantic database dump。

---

## 9.3 Worker System

### FR-WRK-01 Escalation
Fast path 可将 ambiguous / high-impact case 提交 worker。

### FR-WRK-02 Worker specialization
MVP 至少支持：

- semantic reconciliation worker；
- context query worker；
- canonicalization worker。

### FR-WRK-03 Async callback
Worker result 可以在当前 session 仍运行时回流 Runtime，并由 Policy Graph 判断是否值得 inject。

### FR-WRK-04 No silent authority elevation
Worker 同样不得越过 human authority 或 deterministic canonical rule。

---

## 9.4 Context Compaction

### FR-CMP-01 Continuous scoring
Runtime 可以持续维护 semantic utility，而不持续改变 prompt。

### FR-CMP-02 Checkpoint mutation
Context rewrite 只在明确 checkpoint / pressure condition 执行。

### FR-CMP-03 Compaction materialization
Compaction 必须从 semantic state + provenance 构造，而非仅从 summary 文本构造。

### FR-CMP-04 Recovery
被 compact 的重要 source 必须可通过 provenance retrieve。

---

## 9.5 Policy Graph

### FR-POL-01 Declarative graph
Policy nodes / edges / actions 必须可配置、版本化、回放。

### FR-POL-02 Model abstraction
Policy node 不得硬编码 Jev provider。

### FR-POL-03 Replay
必须支持对历史 trajectory offline replay，比较新旧 policy。

### FR-POL-04 Audit
每次 policy decision 必须记录：

- policy version；
- input refs；
- output；
- confidence；
- action；
- latency；
- model/provider；
- downstream consequence。

---

# 10. Enterprise Requirements

## 10.1 Tenant Isolation

- org / workspace / project 强隔离；
- semantic graph namespace isolation；
- connector credentials tenant-bound；
- no cross-tenant retrieval。

## 10.2 Access Control

至少支持：

- workspace role；
- project membership；
- source-level connector permissions；
- object-level sensitive labels；
- human authority ownership。

## 10.3 Data Security

- encryption in transit；
- encryption at rest；
- secret redaction；
- configurable raw event retention；
- provenance without leaking full source when user lacks permission。

## 10.4 Auditability

企业用户必须能回答：

- 哪条外部信息被系统 ingest？
- 哪个 model 判断的？
- 为什么被 inject？
- 哪个 Agent 消费了？
- 是否升级为 canonical state？
- 谁/什么做了最终 authority decision？

## 10.5 Data Retention

提供分层 retention：

- raw events；
- derived semantic state；
- canonical records；
- model decision logs。

## 10.6 Enterprise Controls

管理员可控制：

- connector enablement；
- model/provider policy；
- cloud vs local processing；
- allowed data regions；
- auto-ingestion thresholds；
- auto-injection policy；
- worker execution policy。

---

# 11. Non-functional Requirements

以下是**产品目标，不是当前承诺**，必须通过 prototype 验证。

## 11.1 Fast-path latency targets

目标：绝大多数 single-node semantic policy 不应成为 coding loop 的主要 latency source。

初始实验目标：

- local deterministic path：< 10 ms typical；
- fast semantic decision：P50 < 150 ms；
- fast policy cascade：尽量 P95 < 500 ms；
- synchronous hard injection 只允许高价值 path。

具体值以 Jev access 和真实 benchmark 为准。

## 11.2 Reliability

- Runtime 不可用时，Agent 必须继续工作；
- semantic enrichment 是 graceful degradation；
- canonical Git / source state 不应因 runtime outage 损坏；
- connector outage 不能阻塞 coding session。

## 11.3 Recomputability

Derived semantic state 应尽量可重建。

## 11.4 Explainability

不暴露模型私有 CoT，但必须提供可审计的 policy reason，例如：

```text
Injected because:
- governed path matched AUTH-17
- current ticket touches src/auth/session.ts
- consequence level: high
- confidence: 0.96
```

---

# 12. Product Principles

## P1. Ambient, not intrusive

系统应主动，但默认安静。

## P2. Attention authority ≠ truth authority

Fast model 可以决定“值得看”，不能直接决定“事实成立”。

## P3. Score frequently, mutate rarely

高频更新 semantic metadata；低频改变 worker context。

## P4. Context is compiled, not dumped

Agent 不应该看到完整 semantic database。

## P5. Provenance everywhere

任何重要 semantic object 都必须能回到 raw source / Git / Slack / Doc / event。

## P6. Git remains first-class

Git 仍然是代码、diff、commit、artifact provenance 的核心 substrate。

## P7. Plugin is an interface, not a boundary

Host plugin 是产品的一部分，但不能限制 Runtime 的输入来源和消费端。

## P8. Model-agnostic runtime

Jev 是 catalyst，不是产品 identity。

## P9. Worker only when needed

不要把所有 semantic work 都升级成 expensive agent call。

## P10. User can inspect and override

Ambient 系统必须可见、可审计、可纠正。

---

# 13. Success Metrics

## 13.1 Primary product metrics

### Context Precision
被 inject 的 Context 有多少真正影响当前任务。

### Context Recall
关键 constraint / decision 在需要时是否成功出现。

### Repeated Work Reduction
重复 grep / search / re-read / rediscovery 是否下降。

### Long-task Success
相同 benchmark 下，长任务成功率是否提高。

### Forgotten Constraint Rate
Agent 是否更少违反已有 constraint / authority。

### Evidence Recall
closeout 能否更完整找到真实 Evidence。

## 13.2 Efficiency metrics

- processed tokens；
- context size；
- worker escalations / task；
- fast semantic calls / task；
- semantic latency added；
- compaction frequency；
- prefix reuse proxy；
- cost / successful task。

## 13.3 Trust metrics

- false hard-injection rate；
- incorrect association rate；
- canonical promotion correction rate；
- user dismissal rate；
- untraceable semantic object count（目标为 0）。

---

# 14. MVP Proposal

## Phase 0 — Offline Semantic Replay

目标：先证明 semantic perception 本身有价值。

输入：20–50 条真实 VibeHub coding trajectories。

仅做四类 fast signals：

1. acceptance relevance；
2. durable cross-ticket value；
3. context relevance；
4. independently schedulable work。

不改用户体验，不自动写 canonical state。

输出 benchmark。

**Gate:** 相比 baseline，在 task success / repeated work / context precision 上出现可重复提升。

---

## Phase 1 — Local Semantic Sidecar

目标：把 semantic perception 放到真实 coding loop，但保持低风险。

能力：

- local event adapter；
- fast policy graph；
- candidate semantic store；
- query API；
- Evidence candidate mapping；
- soft context pointers；
- audit view。

禁止：

- automatic canonical writes；
- Slack ingestion；
- cloud mandatory dependency；
- aggressive hard injection。

---

## Phase 2 — Context Compiler + Worker Escalation

加入：

- semantic context materialization；
- long-task checkpoint compaction；
- semantic reconciliation worker；
- context query worker；
- controlled hard injection；
- candidate → validated promotion flow。

---

## Phase 3 — Semantic Cloud

加入：

- cross-session persistence；
- cross-device query；
- workspace semantic graph；
- shared project state；
- enterprise RBAC / audit；
- managed worker execution。

---

## Phase 4 — External Work Signals

优先 connector：

- Slack；
- GitHub Issues / PR；
- Docs / Drive-like sources；
- meetings / notes（later）。

目标：证明 Runtime 不再依赖 chat session 才能理解项目。

---

# 15. Benchmark Plan

## 15.1 Controlled variants

对同一 worker / 同任务 / 同 budget：

1. current VibeHub / no semantic runtime；
2. long-context only；
3. embedding retrieval；
4. fast semantic Policy Graph；
5. Policy Graph + worker reconciliation；
6. Policy Graph + semantic compaction。

## 15.2 Suggested workloads

优先：

- long-horizon coding trajectories；
- multi-session feature implementation；
- debugging with repeated exploration；
- tasks with explicit constraints；
- tasks with cross-source decisions；
- tasks requiring independent closeout / Evidence。

## 15.3 Evaluation philosophy

Compaction / Context quality 不只评 text similarity。

最终评价必须回到 downstream behavior：

- agent 是否重复探索；
- 是否忘记 constraint；
- 是否作出错误 change；
- 是否需要额外 retrieval；
- 是否成功完成任务。

---

# 16. Risks and Mitigations

## R1. Semantic spam

**Risk:** Runtime 太主动，Agent context 被不停打断。
**Mitigation:** three-level injection；impact × relevance gating；default silent availability。

## R2. Fast judge hallucination / misclassification

**Risk:** 错误 semantic link 污染系统。
**Mitigation:** candidate-first；provenance；uncertainty escalation；no truth authority。

## R3. Runtime complexity recreates old mistakes

**Risk:** 重新长成 daemon/database-heavy 第二个世界。
**Mitigation:** 明确职责：Runtime 只拥有 derived semantic work；不复制 Git 的 branch/history/review。

## R4. Vendor dependency

**Risk:** Jev access / pricing / API 变化。
**Mitigation:** SemanticJudge abstraction；policy-level benchmarks；fallback providers。

## R5. Enterprise privacy

**Risk:** Slack / source code / private docs 被错误送到外部 model。
**Mitigation:** source-level policy；local-only mode；redaction；provider routing；tenant isolation。

## R6. Context compression hurts KV reuse

**Risk:** semantic optimization反而破坏 prefix cache。
**Mitigation:** score frequently, mutate rarely；checkpoint compaction；stable-prefix policy。

## R7. False cross-project contamination

**Risk:** Project A 的 Context 被当成 Project B 的 rule。
**Mitigation:** provenance + scope type；related-prior-art 与 governing-context 分开。

## R8. Invisible automation erodes trust

**Risk:** 用户不知道系统背后做了什么。
**Mitigation:** semantic audit view；policy reason；undo / dismiss / mark wrong。

---

# 17. Non-goals

MVP 不做：

- 自建通用 frontier model；
- 替代 Git；
- 替代 Codex / Claude Code / Cursor UI；
- 自动通过 human-authority acceptance；
- 完整 enterprise knowledge management suite；
- 把每个聊天 turn 永久保存；
- 所有信息自动 canonicalize；
- agent swarm orchestration 作为产品核心；
- 用一个巨大 graph ontology 预先建模所有软件开发行为。

---

# 18. Open Product Decisions

1. Ticket / Context / Evidence / Outcome 最终 canonical owner 是 Git、Cloud，还是 hybrid？
2. Local Runtime 是 daemon、embedded service，还是 host-specific sidecar？
3. 什么 event 值得进入 fast path？
4. 哪些 Policy Graph 节点 synchronous，哪些 async？
5. Hard injection 的默认阈值是什么？
6. Semantic Working Graph 的 retention 多久？
7. 用户如何纠正错误 semantic relationship？
8. 企业用户是否允许 raw source 离开本机？
9. Cross-project context 默认是否关闭？
10. Worker callback 如何在不同 Agent host 上安全、稳定地注入？

---

# 19. Launch / Rollout Gates

## Gate A — Semantic value

必须证明：fast semantic state 比普通 embedding / no-runtime 有可观测收益。

## Gate B — Latency

不能显著拖慢 coding hot path。

## Gate C — Trust

误 hard-injection、误 canonicalization 必须极低。

## Gate D — Reliability

Runtime outage 不得阻塞普通 Agent 工作。

## Gate E — Enterprise controls

在连接 Slack / private docs 之前，必须先有 tenant isolation、source policy、audit 和 retention。

---

# 20. Product Narrative

VibeHub 第一代解决的问题是：

> Chats disappear; work should survive.

所以我们把工作变成 Ticket、Context、Evidence 和 Outcome。

下一代解决的问题是：

> Agents repeatedly rediscover what the work means.

所以我们让这种理解本身变成 persistent system state。

产品最终不是一个 memory app，也不是一个 chat plugin。

它是：

> **A semantic runtime for work — continuously perceiving what matters, maintaining a shared model of the development cycle, and compiling the right context back into every agent that needs it.**

用户不用管理 Context。

用户只需要继续工作。
