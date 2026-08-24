# Personal Ticket Hub 方案文档

> 状态：Design baseline v0.3
> 更新时间：2026-08-24
> 对应前端：[`docs/demos/personal-ticket-branch-workbench.html`](./demos/personal-ticket-branch-workbench.html)
> 本文是当前 UI 与未来集成方向的设计 baseline，不是执行权威。实现范围始终服从 [Product Room Decision](../.vibehub/rooms/product/decision-personal-ticket-hub-separate-application.yaml)、[approved design](./designs/personal-ticket-hub.md) 和具体 VibeHub Ticket；UI 变化应同步更新本文和末尾 Change log。
>
> 当前下一段可实现的 Web slice 仍是 dogfood 后的**只读 list/detail**。本文出现的浏览器写操作、live Run、Graph 与 handoff 是后续产品方向，不能据此跳过 Ticket refinement 或扩大当前授权。

## 1. 一句话定义

Personal Ticket Hub 是一个优先服务于“我和我的 Agents”的跨项目 Ticket Dashboard；VibeHub 是项目级可选集成，用来补充依赖图、执行 Run、Evidence、Decision 和 Closeout，而不是 Personal Ticket 的前置条件。

## 2. 产品原则

1. **Ticket Dashboard 优先**：首页首先回答“我、Codex、Claude 正在做什么，哪里需要我处理”。
2. **Personal Ticket 永远可用**：没有 Git 仓库、没有 VibeHub、没有 Goal，也可以 capture、assign、review 和完成 Ticket。
3. **VibeHub 按项目启用**：一个项目连接 VibeHub，不代表其他项目自动连接。
4. **检测优先，手动可控**：默认 Auto detect，同时提供 On / Off override。
5. **一份事实一个 owner**：Personal Ticket 由 Personal Hub 管理；VibeHub Ticket 仍由目标仓库管理，Dashboard 只做投影。
6. **Goal 是可选归类**：Goal 可以由人或 AI 创建；Ticket 可以没有 Goal。Goal 不是 VibeHub Ticket schema 的 `parent`。
7. **人类注意力单独聚合**：Inbox 只收需要 Owner Review、批准、选择或修复偏离的事项。

## 3. 核心对象

### 3.1 Personal Ticket

用于个人和 Agent 的轻量任务管理，最小字段：

```yaml
ticket_id: PT-031
title: Write the first pilot onboarding checklist
project_ref: vibehub-personal
goal_ref: G-04 # optional
creator: human
assignee: claude
state: ready
priority: P1
desired_outcome: ...
acceptance: []
revision: 3
```

Personal Ticket 的状态属于 Dashboard，不需要映射成 VibeHub 的 Git-derived state。

### 3.2 Goal

Goal 用来聚合多个 Ticket，可由 Human 或 Agent 创建：

```yaml
goal_id: G-04
creator: human
project_refs:
  - vibehub-personal
ticket_refs:
  - PT-028
  - PT-031
vibehub_handoffs:
  - repo_ref: vibehub-personal
    ticket_refs:
      - repository-foundation
      - data-core
```

Goal lens 在 UI 中使用虚线表达，只代表归类，不生成 `depends_on`。

### 3.3 VibeHub Ticket projection

VibeHub Ticket 来自目标仓库的 `.vibehub/tickets/`：

- Ticket 内容和 `relations: depends_on` 由 Git 仓库负责；
- RUNNING / STALE、Agent、heartbeat 来自 live runtime；
- Evidence、Outcome、Decision、Closeout 仍写入 VibeHub artifacts；
- Dashboard 保存引用和索引，不复制一份可编辑的 canonical Ticket。

## 4. 首页信息架构

### 4.1 默认：Tickets

跨项目队列，显示：

- priority、state、title；
- project、optional Goal；
- owner：You / Codex / Claude；
- source：Personal / VibeHub；
- last activity；
- Open、Implementing、Needs you、Done 过滤。

点击 Ticket 后，右侧 inspector 展示 outcome、assignee、creator、next action、acceptance 和 activity。

#### Dashboard branch lanes

Branch 视觉直接用于 Ticket 展示，而不只存在于单独的 VibeHub Graph：

- 每个 Goal / Project 形成一段垂直主干；
- 蓝色主干节点表示 Owner（You）负责的 Ticket；
- 绿色分支表示 Codex / Claude 等 Agent 的并行工作；
- Agent 工作完成或队列回到 Owner 时，分支在下一节点合回主干；
- 节点中心的小色点表示 Ticket state；
- Ticket 行右侧继续展示 Personal / VibeHub source。

Dashboard branch lanes 表达的是**归类和责任流**，不是依赖关系。只有 VibeHub Graph 中来自 `relations: depends_on` 的实线才是 canonical dependency。UI 必须保留这个语义区分，不能根据 Owner 或排列顺序生成 VibeHub 依赖。

### 4.2 Goals

Goals 与 Tickets 是同等级的工作视图，不只是左侧筛选器。Goal 视图需要直接展示 Goal 状态、完成度、当前 owner、下一步，以及归属于该 Goal 的 Ticket branch：

- 选择 Goal 后，可在同一视图展开或聚焦其 Tickets，而不必跳回 Tickets 首页才能理解进度；
- Goal branch 沿用 Dashboard branch lanes：蓝色主干是 Owner 责任流，绿色分支是 Agent 并行工作；
- Goal 行必须暴露 active / blocked / needs you / done、完成度和最近活动；
- Goal 可包含 Personal Tickets 和 VibeHub Ticket refs；
- Goal 本身不拥有 VibeHub 依赖关系。

具体信息架构正在比较五个方向：Linear Branch Rail、Jira Goal Hierarchy、Focus Goal、Command Branch Queue、Roadmap Branch Strips。选择依据记录在 [`GOAL_UI_VARIANTS.zh-CN.md`](./GOAL_UI_VARIANTS.zh-CN.md)，可运行对比稿是 [`personal-ticket-goal-directions.html`](./demos/personal-ticket-goal-directions.html)。在用户选定 A / B / C / D / E 之前，主 Demo 暂不替换现有布局。

### 4.3 VibeHub graph

只有当前项目成功连接 VibeHub 时可用：

- 虚线：Personal Goal lens；
- 实线：VibeHub `relations: depends_on`；
- 节点状态：Git-derived state；
- 节点上的 Agent / heartbeat：live Run overlay；
- Inspector：Contract、Evidence、Outcome、Decision、Closeout。

### 4.4 Inbox

Inbox 是 Ticket 和 Run 的注意力投影，不建立新状态机：

- assigned to You 且 ready for review；
- protected decision；
- Agent 请求权限、范围或产品选择；
- Run failed / Ticket deviated；
- Closeout 不能独立裁决。

## 5. VibeHub 检测与 Toggle

每个项目保存独立模式：

```yaml
vibehub_mode: auto # auto | on | off
```

### 5.1 Auto（默认）

Auto 使用确定性检测，不根据对话内容猜测。建议检查：

1. 项目有明确的本地 `repo_path`；
2. 存在 `.vibehub/version.yaml`；
3. 使用当前 VibeHub CLI 执行 `project compatibility`，结果为 `CURRENT`；
4. `project validate` 通过，且 `.vibehub/tickets/` 可读；
5. 如需 live Run，再单独检测 VibeHub runtime 连接。

结果：

- 全部通过：`Auto · Detected`，开放 Graph 和 VibeHub Ticket projection；
- 未检测到：`Auto · Not detected`，只显示 Personal Tickets；
- 项目格式不兼容或数据损坏：显示 Diagnostics，不静默降级成有效连接。

### 5.2 On

On 表达用户明确希望这个项目使用 VibeHub，但不能伪造连接成功：

- 检测成功：`On · Connected`；
- 尚未 setup：`On · Setup required`，提供 VibeHub setup 动作；
- 项目格式或校验无效：`On · Diagnostics`，Graph 保持不可用。

### 5.3 Off

Off 的行为：

- Dashboard 不读取该项目的 VibeHub Ticket、Run 或 Inbox projection；
- Graph 不可用；
- Personal Ticket 继续正常工作；
- **不删除、不移动、不修改**仓库中的 `.vibehub` 文件。

### 5.4 “Detect again”

手动重新检测只刷新项目 integration receipt：

```yaml
project_id: sample-onboarding
mode: auto
detected: false
checked_at: 2026-08-23T21:00:00Z
checks:
  repo_path: ok
  project_format_marker: ok
  compatibility: current
  project_validation: failed
  ticket_directory: skipped
  runtime: not_checked
```

UI 必须展示最近一次确定性结果，不能只显示一个没有证据的绿色开关。

## 6. 数据所有权

| 数据 | Owner | Dashboard 权限 |
|---|---|---|
| Personal Ticket | Personal Hub | read / write |
| Goal | Personal Hub | read / write |
| Agent assignment | Personal Hub | read / write |
| VibeHub Ticket contract | target repository | read projection |
| `depends_on` | target repository | read projection |
| Run presence | VibeHub runtime | read projection |
| Evidence / Outcome / Decision | target repository | read; mutations通过 VibeHub workflow |
| Integration mode / receipt | Personal Hub project config | read / write |

## 7. Future target 接口草图

以下是 post-M2 的产品方向，用来保持对象与数据所有权一致；它不是当前 Web Ticket 的可执行接口合同。

```text
GET  /api/dashboard/tickets?project=&goal=&owner=&state=
POST /api/tickets
PATCH /api/tickets/:ticket_id

GET  /api/goals
POST /api/goals
PATCH /api/goals/:goal_id

GET  /api/projects/:project_id/integration
PUT  /api/projects/:project_id/integration/mode
POST /api/projects/:project_id/integration/detect

GET  /api/projects/:project_id/vibehub/graph
GET  /api/projects/:project_id/vibehub/runs
GET  /api/inbox
```

浏览器不直接读写 repo 文件。Local service 负责检测路径、调用当前 VibeHub CLI 检查 compatibility / validation、读取 Git snapshot，并在未来经过独立授权后连接 runtime。

当前 Milestone 2 只允许实现只读的 Inbox、Projects、filters 和 Ticket detail。上面的 `POST` / `PATCH` / `PUT`、Graph、Run 和 handoff endpoints 是 post-M2 的目标接口草图，不是当前 Ticket contract。

## 8. Agent 工作方式

### 普通 Personal Ticket

```text
用户或 Agent capture Ticket
→ 指派给 You / Codex / Claude
→ Agent 完成并提交结果链接
→ 需要人工时进入 Inbox
→ Owner 标记完成
```

### 需要 VibeHub 的复杂交付

```text
Personal Ticket / Goal
→ 选择已连接项目
→ handoff to ticket-plan
→ 保存 VibeHub Ticket refs
→ ticket-run / Evidence / independent closeout
→ Outcome 回到 Dashboard
```

是否 handoff 由用户或明确规则决定，不能因为项目安装了 VibeHub 就让每个小问题自动生成 VibeHub Ticket。

## 9. 前端状态要求

必须维护以下状态：

- Loading：Ticket rows skeleton；
- Empty：没有 Ticket 时仍可创建 Personal Ticket；
- VibeHub not detected：Personal Ticket 正常，Graph disabled；
- Setup required：明确下一步，不显示假数据；
- Diagnostics：项目格式不兼容或 `project validate` 失败；
- Runtime offline：Graph 和 Git Tickets 仍可读，只隐藏 live Run；
- Stale Run：显示最后 heartbeat，不把它写成 Ticket state；
- Permission denied：保留只读 Dashboard，并说明受限字段。

## 10. 实施顺序

1. 继续 dogfood 已完成的 CLI 与双宿主 capture，收集 projection 稳定性证据；
2. refine `ticket-personal-hub-local-web`，明确短期 capability、Host / Origin 校验、DNS rebinding 测试、响应式与可访问性 acceptance；
3. 只实现 read-only Inbox、Projects、filters 和 Ticket detail，并由完整 validated rescan 驱动；
4. 经过独立 Ticket 后再评估 Personal Ticket 写操作；
5. 经过 handoff Ticket 后再投影 VibeHub Graph、Run、Evidence / Outcome；
6. 文件监听只触发重新校验，不成为数据正确性权威。

## 11. 非目标

- 不把 Personal Hub 变成第二个 VibeHub Ticket store；
- 不在 UI 中编辑 VibeHub canonical dependencies；
- 不因为项目 detected 就自动把所有小问题升级成 VibeHub Ticket；
- 不让一个全局 Toggle 覆盖全部项目；
- 不从 Agent 对话中猜测“VibeHub 已连接”。

## 12. Change log

### Goal exploration · 2026-08-24

- 将 Goals 从“左侧筛选器”升级为与 Tickets 同等级的工作视图；
- 要求 Goal 视图直接显示 Ticket branch、owner、进度、next action 与 needs-you 状态；
- 生成五个 Jira / Linear 启发的可切换 HTML 方向，具体布局等待用户选择；
- 保持 branch 责任流与 VibeHub canonical `depends_on` 的语义隔离。

### v0.3 · 2026-08-24

- 将 Branch 视觉从独立 Graph 扩展到默认 Ticket Dashboard；
- Goal / Project 作为 Ticket 主干，You 作为 owner lane，Codex / Claude 作为并行 Agent branch；
- Ticket state 进入 branch node 内核，Personal / VibeHub 保留独立 source 标记；
- 明确 Dashboard branch 表达责任流，不等同于 VibeHub `depends_on`。

### v0.2 · 2026-08-23

- 将默认产品表面从 Branch Graph 改为 Personal Ticket Dashboard；
- 明确 Ticket 可由 Human / Codex / Claude 创建和承担；
- VibeHub 改为 per-project Auto / On / Off optional integration；
- 增加 deterministic detection receipt；
- Graph 只在成功检测后开放；
- 明确安装 VibeHub 不等于所有小问题都生成 VibeHub Ticket。

### v0.1 · 2026-08-23

- 建立 Goal lens、VibeHub `depends_on`、Run overlay 和 Inbox 的 branch-first 视觉模型。
