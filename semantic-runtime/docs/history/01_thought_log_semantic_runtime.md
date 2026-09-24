# VibeHub Semantic Runtime — 思路演化 Log

**Status:** Draft / Proposed
**Date:** 2026-09-19
**Scope:** VibeHub / YPub 下一代产品与架构方向
**Core terms:** Semantic Runtime · Policy Graph · Persistent Semantic Perception · Semantic Working Graph · Semantic Compiler

---

## 0. 这份 Log 记录什么

这不是 PRD，也不是实现设计。它记录的是：**我们为什么从一个 Git-native、plugin-only 的开发工作流工具，逐步推演到一个 ambient Semantic Runtime。**

最重要的是保留中间的逻辑，而不是只保留最后的结论。当前方向并不意味着过去的设计是错的。相反，过去很多边界在当时是正确的：Git 已经解决 history / branch / diff / rollback / review，重新造数据库、daemon、dispatcher，如果只是为了保存 Context 和 Ticket，会形成第二套 source of truth，带来大量不必要的系统复杂度。

这次改变的前提不是“我们突然更喜欢 server”。改变的是 **workload**：当类似 Jev 的低延迟 semantic decision model 出现以后，“持续感知工作轨迹、不断做大量 bounded semantic decisions”第一次可能成为一个经济上可行的 runtime workload。Git 不擅长做这件事，而一个活着的 semantic engine 擅长。

因此，这次思路变化可以总结为：

> **Git 继续做 development truth substrate；Plugin 继续做嵌入式入口；但产品核心从 workflow specification 升级为 persistent semantic perception + policy execution。**

---

## 1. 原始产品论：Stop managing chats. Manage the work.

当前 VibeHub plugin 的核心非常清楚：它不试图保存聊天本身，而是保存 development cycle。

当前 canonical cycle 是：

```text
Request
  ↓
Ticket / Contract
  ↓
Execution
  ↓
Evidence
  ↓
Independent Closeout
  ↓
Outcome
  ↓
Durable Context
```

产品将 Goal、Epic、Ticket、Acceptance、Constraint、Context、Room、Authority、Evidence、Outcome 等对象变成 Git-native records。Git 提供历史、分支、回滚、review 和协作。Agent 通过 Skills 理解这些对象并执行对应 lifecycle。

当前仓库甚至有意写明架构边界：不要求 database、daemon、MCP server、hook cadence、background capture 或 hidden lifecycle state。这个边界不是保守，而是为了避免两件事：

1. **不要重做 Git 已经擅长的东西。**
2. **不要产生第二套事实系统。**

过去我们曾经尝试过 SQLite / CLI / service-heavy 的版本，最终收缩到 file-based / Git-native，是因为 agent 本来就非常擅长 find / read / edit / diff / commit，文件和 Git 是自然接口。

这套判断直到今天依然有效。

---

## 2. 第一个触发点：Jev 不是“小模型”，而是新的 runtime primitive

一开始对 Jev 的兴趣很容易被描述为：

> “它是一个很快的 classifier，可以帮我们判断一段信息有没有价值。”

但这个描述太小。

真正重要的是：**它把自然语言语义判断从昂贵的 generative reasoning 里拆出来，变成了可以高频执行的 bounded decision primitive。**

以前如果每次消息、tool output、Git diff、Slack message 都问一次 frontier LLM：

- 这重要吗？
- 这是 durable 的吗？
- 它和哪个 Ticket 有关？
- 它是不是 Evidence？
- 它应不应该进入 Context？
- 现在应该 inject 吗？

系统会太慢、太贵，也会给当前 agent 增加大量额外 reasoning burden。

但如果这个判断变成低延迟语义判定，整个 economics 会改变。

所以 Jev 的意义不是“我们有了更便宜的 LLM”。

它的意义是：

> **我们第一次有机会让语义判断本身变成 always-available infrastructure。**

---

## 3. 从 compaction 开始，但很快发现 compaction 只是一个 consumer

最初直觉来自 context compaction。

传统长会话处理方式通常是：

```text
Context 很长
   ↓
再 call 一个大模型
   ↓
重新读一遍
   ↓
总结 / 压缩
```

这里的问题很明显：直到 context 快爆了，系统才第一次认真问“过去到底什么重要”。

Jev-like fast judge 提供了另一个可能：

```text
每个 meaningful event
   ↓
快速 semantic scoring
   ↓
持续维护 metadata
   ↓
真正需要 compact 时
   ↓
直接 materialize 已经理解过的状态
```

这时 compaction 从：

> expensive retroactive understanding

变成：

> cheap materialization of already-maintained understanding

但随后我们意识到：如果这些 semantic metadata 已经存在，它绝不会只服务 compaction。

同一份 metadata 可以服务：

- Context retrieval
- Context injection
- Ticket planning
- Evidence mapping
- Model routing
- Tool routing
- Memory / Context admission
- Contradiction detection
- Worker escalation
- Cross-agent handoff
- Long-context compaction

所以 compaction 只是一个 downstream consumer。

真正的 primitive 是 **persistent semantic perception**。

---

## 4. KV Cache 带来的关键约束：Score frequently, mutate rarely

这里出现了一个非常重要的反作用力。

如果我们每得到一个新 semantic score 就立刻重写 worker prompt：删一段、移动一段、重新排序一段，那么即使 semantic decision 本身很便宜，也可能破坏主模型的 prefix/KV reuse。

因此形成了一个核心原则：

> **Score frequently, mutate rarely.**

也就是：

```text
Event arrives
   ↓
score / tag / associate
   ↓
只更新 derived semantic state
   ↓
不立即重写主 context

...持续进行...

到 checkpoint / pressure threshold
   ↓
一次性 context materialization / compaction
```

这让系统同时优化两个目标：

1. semantic awareness 尽量持续；
2. worker prompt 尽量稳定、append-friendly。

因此，Semantic Runtime 不应该把“感知”和“改变 worker context”绑定成同一个动作。

---

## 5. VibeHub 真正的原始资产不是 Context 数据，而是 ontology

越往下推，我们越发现 VibeHub 对 Jev 的 readiness 很高。

原因不是我们已经有很多历史 Context，而是我们已经有一套非常丰富的 **development ontology**：

- Goal
- Epic
- Ticket
- Contract / Acceptance
- Decision
- Constraint
- Context
- Room
- Authority
- Evidence
- Outcome
- Change
- Dependency
- Human boundary
- Agent boundary

这意味着我们不需要让 fast semantic model 回答模糊问题：

> “这段话重要吗？”

我们可以问非常 bounded、非常产品化的问题：

- 这是否是 durable cross-ticket knowledge？
- 这是否支持 Acceptance A-3？
- 这是否与 Decision D-12 冲突？
- 这是否属于 Room `auth/session`？
- 这是否改变了当前 Ticket 的 execution state？
- 这是否构成独立可调度的新工作？
- 这是否应该 interrupt 当前 agent？
- 这是否可以 defer 到 checkpoint 再处理？

也就是说：

> **我们已经知道“development world 是什么”；Jev 让这套 world model 可以低延迟地执行。**

真正的 moat 因而不是“我们集成了 Jev”。

真正的资产是：

> **development ontology + transition semantics + decision surfaces + policies。**

Jev 只是让它们第一次可以成为 hot-path runtime。

---

## 6. 从 classifier 到 Policy Graph

“classifier layer”依然太小。

一个复杂 semantic decision 很少应该由一个 score 一次完成。更合理的结构是多层 bounded decisions：

```text
Event
  ↓
值得处理吗？
  ↓ yes
属于哪个 project？
  ↓
属于哪种 semantic type？
  ↓
和哪些 Ticket / Context / Acceptance 有关？
  ↓
是 transient 还是 durable？
  ↓
需要现在 inject 吗？
  ↓
存在冲突或高不确定性吗？
  ↓ yes
Escalate to Worker
```

这个结构更像一个 **Policy Graph**。

Policy Graph 的关键特征：

- 每个 node 都是一个 bounded semantic decision；
- edge 根据 confidence / state / policy routing；
- fast nodes 可以重复运行、并行运行；
- 高影响但低置信度的 case 才进入 slow path；
- 最终 action space 可以很小：`IGNORE / INGEST / INJECT / DEFER / ESCALATE`；
- policy 是 VibeHub 的资产，judge model 可替换。

因此 Jev 更准确的位置不是“classifier”。

而是：

> **Jev is the policy execution substrate of the Semantic Runtime.**

---

## 7. 两条主循环：Ingress 与 Egress

整个 Context 问题最终可以拆成两个对称问题。

### 7.1 Ingress：世界如何进入系统

```text
Raw work signal
  ↓
Admission
  ↓
Semantic typing
  ↓
Association
  ↓
Candidate semantic graph
  ↓
Worker reconciliation when needed
  ↓
Validated / canonical knowledge
```

Raw work signal 可以来自：

- Agent session
- Tool call / tool result
- Git diff / commit / PR
- Slack
- Docs
- Issue / Ticket system
- Meeting note
- Human decision
- External system event

Jev 负责 fast perception + routing。

Worker 负责 expensive consolidation：dedup、contradiction resolution、deep reasoning、canonical promotion。

### 7.2 Egress：系统里的东西什么时候回来

```text
Current agent state
  ↓
Semantic perception
  ↓
Relevant neighborhood
  ↓
Injection policy
  ↓
Context compiler
  ↓
Agent-specific context
```

Context retrieval 不应该退化为：

```text
query → embedding → topK
```

更完整的结构是：

```text
query / current state
  ↓
semantic route
  ↓
project / room / entity / relation / time / authority scope
  ↓
candidate generation
  ↓
Jev rank / gate
  ↓
graph expansion
  ↓
context materialization
```

Embedding 仍然重要，但它只是 candidate-generation primitive，而不是整个 retrieval strategy。

---

## 8. Semantic Working Graph：进入 reasoning 之前的中间态

一个新的重要对象出现了：**Semantic Working Graph**。

它不是 canonical truth，也不是 raw transcript。

它是：

> 系统对当前工作世界的、可更新的、带概率和 provenance 的中间表示。

例如：

```text
Observation O-9281
   ├─ evidence_for → Acceptance A-3 (.94)
   ├─ relevant_to  → Ticket T-42 (.98)
   ├─ belongs_to   → Room auth/session (.91)
   └─ contradicts  → Context C-17 (.76)
```

这个 graph 允许：

- retrieval 直接从关系出发；
- worker 只处理 ambiguous / high-impact nodes；
- compaction 直接从 active semantic state materialize；
- Agent A 的 observation 可以通过 shared state 被 Agent B 消费；
- raw source 永远通过 provenance 找回。

这一步把系统从“memory”推进到“world model”。

---

## 9. Attention authority，不是 truth authority

这里必须有一个硬边界。

Jev 很快，但它不应该直接拥有 truth authority。

因此状态需要至少四级：

```text
Ephemeral
   ↓
Candidate
   ↓
Validated
   ↓
Canonical
```

Jev 可以决定：

- 什么值得 attention；
- 什么值得进入 candidate graph；
- 什么值得 retrieve；
- 什么值得 inject；
- 什么应该 escalate。

但它不能仅凭一个 fast score 就：

- 覆盖 canonical Decision；
- 宣布 Acceptance 成功；
- 把一个 Slack 传闻升级为 Authority；
- 替人做 human-authority decision。

因此核心原则是：

> **Fast semantic models have attention authority, not truth authority.**

这是整个架构能够既“主动”又“可靠”的关键。

---

## 10. 为什么 daemon / runtime 现在第一次变得合理

过去的判断是：如果 daemon 只是为了保存 Context / Ticket，那么它是在复制 Git。

现在 daemon 的职责完全不同：

```text
observe
judge
classify
associate
maintain semantic state
run policy graph
schedule workers
retrieve
inject
compact
sync
```

Git 不做这些事情，也不应该做。

因此新的职责分工变成：

### Git

- code
- canonical artifacts
- commits
- diffs
- branches / worktrees
- provenance
- review / rollback

### Semantic Runtime

- events
- semantic candidates
- probabilistic relations
- salience
- session state
- policy decisions
- retrieval index
- semantic working graph
- worker jobs

### Plugin

- sensor
- actuator
- host lifecycle integration

### Cloud

- cross-session persistence
- cross-device access
- cross-project semantic graph
- connectors
- enterprise policy / admin
- shared workers

所以新的关键句是：

> **Git remains the development truth substrate, but no longer needs to be the runtime database.**

---

## 11. Plugin 从“产品本体”变成 Sensor + Actuator

过去 VibeHub 很容易被理解为一个 chat / coding-agent plugin。

下一代产品里，Plugin 仍然极其重要，但它的角色改变：

```text
Agent Host
  ├─ observe user intent
  ├─ observe tool / file / session events
  ├─ expose context query
  ├─ receive semantic injection
  └─ receive worker results
```

Plugin 是嵌入 host 生命周期的 **eyes + hands**。

它不再要求用户主动说：

- “查一下 Context”
- “帮我沉淀一下”
- “现在 compact”
- “去这个 Room 看看”

理想体验变成：

> 用户继续工作；系统在旁边持续理解。重要的东西自然留下，需要的东西自然回来，复杂问题在后台由 worker 解决。

---

## 12. 外部世界成为同一个 Runtime 的输入

一旦 Semantic Runtime 独立存在，数据来源自然不再限制于 plugin。

```text
Slack ──────────────┐
Git ────────────────┤
Docs ───────────────┤
Agent Sessions ─────┤
Issues ─────────────┤
Meetings ───────────┤
                    ▼
             Semantic Runtime
```

所有 source 都进入同一个 semantic world model。

这比“做 Slack integration”更重要。

真正的产品抽象是：

> **所有 work signals 都是同一种 semantic ingestion source。**

Runtime 不需要让 Slack Agent 直接给 Coding Agent 发消息，而可以通过 shared semantic state 通信：

```text
Agent / Slack / Human
        ↓
Semantic Runtime
        ↓
Shared semantic state
        ↓
Relevant consumer
```

这是一种更高层次的 agent communication。

---

## 13. Fast Path / Slow Path：System 1 与 System 2

整个 Runtime 逐渐形成三级 cognition：

### L0 — Mechanical

- deterministic parser
- Git state
- schema validation
- exact provenance

### L1 — Semantic fast path

- Jev-like judge
- classification
- relevance
- routing
- gating
- relation scoring
- interrupt decision

### L2 — Reasoning slow path

- worker agent
- contradiction resolution
- semantic consolidation
- canonical write proposal
- planning
- difficult retrieval synthesis

大多数 event 应该在 L0/L1 结束。

只有：

```text
high impact × uncertain
```

或者真正需要 synthesis 的时候，才唤醒 worker。

一句话：

> **Jev makes the Semantic Runtime perceptive enough to operate continuously; workers make it eventually correct.**

---

## 14. Context Compaction 在新体系中的位置

Compaction 变成 Policy Graph 的一个特殊 consumer，而不是 Runtime 的中心。

Runtime 已经持续知道：

- active constraints
- active decisions
- unresolved questions
- successful evidence
- dead exploration
- current task phase
- provenance pointers

因此当 context pressure 上升时：

```text
Semantic Working Graph
  ↓
Context Compiler
  ↓
New compact context
```

而不是重新理解完整 raw trajectory。

同时必须遵守：

> **score frequently, mutate rarely**

只有在 checkpoint / threshold / phase transition 等明确边界上重塑主 context，以保护 worker 的 prefix/KV reuse。

---

## 15. Semantic Compiler：一个越来越准确的比喻

整个系统很像 compiler：

```text
Raw work signals
      ↓
Front-end semantic parsing
      ↓
Semantic IR / Working Graph
      ↓
Optimization / linking / reconciliation
      ↓
Context codegen
      ↓
Agent-specific prompt / action
```

对应关系：

| Compiler | Semantic Runtime |
|---|---|
| Source code | Raw work signals |
| Parser | Admission / semantic typing |
| IR | Semantic Working Graph |
| Optimization passes | Policy Graph + worker reconciliation |
| Code generation | Context Compiler |
| Target architecture | Current Agent / task / model |

这意味着我们不再把 Context 看成“存起来的一段文字”。

Context 是：

> **从长期语义状态按当前消费目标编译出来的运行时产物。**

---

## 16. 新产品边界

旧边界：

```text
VibeHub = Plugin + Git-native workflow
```

Proposed 边界：

```text
                 Semantic Cloud
                       │
                 Semantic Runtime
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
      Codex          Claude         Cursor / others
      Plugin         Plugin         Plugin
        │              │              │
        └──────────────┼──────────────┘
                       │
                      Git
```

新的角色定义：

- **Plugin = distribution + sensor + actuator**
- **Git = development truth substrate**
- **Semantic Runtime = product kernel**
- **Semantic Cloud = persistent shared semantic plane**
- **Workers = on-demand cognition**
- **Policy Graph = semantic decision orchestration**

---

## 17. 我们不应该过早做出的决定

这轮思考很强，但仍然有若干点应该保持 proposed 状态，而不是直接固化。

### 17.1 Canonical Ticket / Context 是否全部迁出 Git

目前不应一刀切。

更稳妥的初始边界是：

- derived semantic state 明确不进 Git；
- code/artifact/provenance 明确仍由 Git owning；
- Ticket / Decision / Constraint / Evidence / Outcome 的长期 canonical ownership 通过实验决定。

### 17.2 Local daemon 是否必须

产品终局很可能需要 Runtime，但 MVP 可以先做：

- in-process local runtime；
- host-adapter sidecar；
- optional daemon；

先验证 continuous semantic perception 的价值，再决定最终进程形态。

### 17.3 Jev 是否成为依赖

不能。

应该定义：

```text
SemanticJudge interface
```

底层可实现：

- JevJudge
- SmallLLMJudge
- EmbeddingJudge
- HeuristicJudge
- HybridJudge

我们拥有 Policy Graph；不把产品 moat 绑定在一个模型供应商上。

---

## 18. 最小可证伪实验

我们不应该一开始就做完整 Cloud / Slack / Mobile。

第一组实验只验证一个核心假设：

> **持续维护的 semantic state，是否能让 coding agent 在长任务中更准确、更少重复、更少重新读取，同时不显著增加 latency。**

建议选择真实 VibeHub coding trajectories，维护四类 signal：

1. acceptance relevance
2. durable cross-ticket value
3. context relevance
4. independently schedulable work

对比：

- Current VibeHub baseline
- Long-context baseline
- On-demand retrieval
- Jev-like fast semantic policy
- Fast semantic policy + worker reconciliation

测：

- task success
- repeated tool calls
- forgotten constraints
- evidence recall
- context precision / recall
- processed tokens
- wall-clock latency
- prompt/KV reuse proxy
- false injection rate
- false canonicalization rate（必须接近 0）

如果这些指标没有明显提升，Semantic Runtime 不应该因为概念漂亮而继续膨胀。

---

## 19. 当前工作词汇

### Semantic Runtime
持续观察 work signals、维护 semantic working state、执行 policy、调度 worker、向 agent materialize context 的运行时。

### Policy Graph
由多个 bounded semantic decisions 构成的可组合策略图。Node 是判定，Edge 是路由，Action 是 IGNORE / INGEST / INJECT / DEFER / ESCALATE 等。

### Persistent Semantic Perception
不等用户主动触发，而是在工作过程中持续把 raw events 映射成可复用 semantic state。

### Semantic Working Graph
介于 raw events 与 canonical truth 之间的概率化、可更新、带 provenance 的语义图。

### Semantic Compiler
把 raw work signals 编译成 semantic IR，再针对当前 Agent / task 编译成 context 的系统抽象。

### Attention Authority
Fast model 可以决定什么值得被看、被检索、被候选化，但不直接拥有 canonical truth。

### Truth Authority
Canonical Decision / Authority / Outcome 等需要确定性证据、worker reasoning、Agent adjudication 或 human authority 才能更新。

### Score frequently, mutate rarely
持续计算 semantic metadata，但尽量减少对主 Agent context 的结构性重写，以保护 context stability 和 prefix/KV reuse。

---

## 20. 最终母叙事

我们最开始做 VibeHub，是因为聊天不是工作本身。

于是我们把开发过程变成结构化对象：Ticket、Context、Evidence、Outcome。

下一步的自然问题是：

> 如果这些语义已经定义好了，为什么还要让每一个 Agent 在每一次 session 里重新理解一遍？

Jev-like fast semantic models 让我们第一次有机会把这种“理解”从 transient model cognition 中抽出来，变成持续存在的系统能力。

于是产品从：

> **preserve the development cycle**

进一步走向：

> **understand the development cycle continuously.**

最终产品体验应该非常简单：

> **用户继续工作。系统持续理解。重要的东西自然留下；需要的东西自然回来；复杂的东西自动叫更强的 Worker 处理。**

而 VibeHub 的技术身份也随之改变：

> **VibeHub should become the semantic runtime that sits alongside your agents—not another thing you have to ask your agents to use.**
