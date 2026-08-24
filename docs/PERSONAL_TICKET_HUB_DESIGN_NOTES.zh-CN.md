# Personal Ticket Hub × VibeHub：Branch Workbench UI 附录

> Canonical 产品与集成方案见 [`PERSONAL_TICKET_HUB_SOLUTION.zh-CN.md`](./PERSONAL_TICKET_HUB_SOLUTION.zh-CN.md)。本文只保留 Branch Graph 的视觉与交互细节，避免 UI 说明反过来定义产品架构。

## 1. 这次重做解决什么

旧稿把页面拆成 Today、Goal 卡片和 Ticket 卡片，但三者只是视觉上并排，没有表达真实关系。因此会出现两个问题：

1. 打开 Goal 看不到它下面的 VibeHub Tickets；
2. 正在执行、等待人工 Review、被依赖阻塞的 Ticket 混在普通列表里。

新版使用“分支工作台”模型：

- **Goal 是树干**：表达“我为什么要做这一组工作”；
- **VibeHub Ticket 是分支节点**：表达可执行、可验证的具体交付；
- **Ticket `depends_on` 是实线**：只表示 VibeHub 的真实依赖；
- **Goal lens 是虚线**：只表示 Personal Hub 的聚合视角，不伪造 VibeHub 的父子字段；
- **Run 是节点上的实时覆盖层**：表示 Agent 当前正在 implement 哪个 Ticket；
- **Inbox 是人的注意力队列**：只收需要你 Review、批准或决策的节点。

## 2. 产品边界

Personal Ticket Hub 和 VibeHub Plugin 是同一个工作流里的两个产品面，但不应该争夺同一份事实所有权。

| 对象 | 权威来源 | Personal Hub 的职责 |
|---|---|---|
| Goal | Personal Hub 数据目录 | 创建、归类、归档，记录由人或 AI 提出 |
| Project | Personal Hub 项目索引 + repo identity | 把 Goal 路由到正确仓库 |
| Executable Ticket | 目标仓库 `.vibehub/tickets/` | 读取并投影，不复制成第二份可编辑 Ticket |
| Ticket dependency | Ticket `relations: depends_on` | 画成实线分支，不重新推断 |
| Run / Implementing | VibeHub live runtime | 叠加 RUNNING、Agent、心跳和 checkout 信息 |
| Evidence / Outcome | 目标仓库中的 VibeHub artifacts | 在 inspector 中展示并链接到原始事实 |
| Review request | Personal Hub Inbox projection | 聚合 `needs-human`、审批、Closeout 等待项 |

关键规则：**Goal 不直接变成 VibeHub Ticket schema 里的 `parent`**。当前 Ticket v2 是扁平依赖图，只有 `depends_on`。新版 UI 用虚线 Goal lens 表达归属，避免把界面分组误写成执行依赖。

## 3. 一个 Goal 为什么现在能看到 Tickets

Goal 需要保存一次 handoff 关系，而不是保存 Ticket 的副本：

```text
Goal G-04
  project_ref: vibehub-personal
  repo_ref: /absolute/path/to/vibehub-personal
  ticket_refs:
    - VH-P-001
    - VH-P-002
    - VH-P-003
```

打开 Goal 时，前端按下面的顺序组成画面：

```text
Personal Goal
    │  Goal lens（虚线，只是分组）
    ▼
VibeHub Ticket graph（来自目标仓库）
    + relations.depends_on（实线）
    + Git-derived state（READY / DONE / BLOCKED / DEVIATED）
    + live Run overlay（RUNNING / STALE / Agent / heartbeat）
    + Evidence / Outcome / Decision
```

如果 Goal 还没有 handoff 到 VibeHub，页面显示一个空树干和“Plan with VibeHub”动作；一旦 `ticket-plan` 生成 Ticket graph，Goal 不需要复制数据，刷新投影即可出现分支。

## 4. 页面结构

### 左侧：Goals

- 按项目查看所有活跃 Goal；
- 明确标记 Human / AI creator；
- 显示这个 Goal 下的 Ticket 数和 live Run 数；
- 新建 Goal 使用行内 composer，不打断上下文。

### 中间：Branch canvas

- 自上到下阅读，符合“先决条件 → 当前实现 → 后续解锁”的因果顺序；
- Goal root 使用深色树干节点；
- Ticket 节点沿分支排列，状态只用少量语义色；
- 点击任意节点切换右侧 inspector；
- Now 只强调 live 和需要注意的路径，All 展示完整图。

### 右侧：Ticket inspector

- Execution：当前 Run、依赖、验收和 Evidence；
- Contract：Ticket outcome、deliveries、constraints、context refs；
- Log：Run、Decision、Evidence、Closeout 时间线；
- 所有可执行事实均标注 VibeHub Plugin 来源。

### Inbox

Inbox 不是第四套状态机，只是一个投影：

- `NEEDS YOU`：等待 Review、批准或选择；
- `FAILED / DEVIATED`：需要人工判断下一步；
- Closeout 无法裁决；
- Agent 请求扩大范围或修改权限。

点击 Inbox 项会直接切到相应 Goal 和 Ticket。

## 5. 推荐的数据接口

第一版 WebView 只做本地 read model，浏览器不直接读写 Git 文件。

```text
GET /api/projects
GET /api/goals?project_id=...
GET /api/goals/:goal_id/graph
GET /api/tickets/:ticket_id
GET /api/inbox
GET /api/runs/live
```

`GET /api/goals/:goal_id/graph` 建议一次返回已经 join 好的投影：

```json
{
  "goal": { "goal_id": "G-04", "creator": "human" },
  "tickets": [],
  "dependency_edges": [],
  "goal_lens_edges": [],
  "live_runs": [],
  "attention_items": []
}
```

写操作仍通过受控命令或 Agent 完成：

- `New Goal` 写 Personal Hub；
- `Plan with VibeHub` 调用 `vibehub-ticket-plan`；
- `Run Ticket` 调用 `vibehub-ticket-run`；
- `Review / Closeout` 调用对应 VibeHub Skill；
- WebView 收到文件或 runtime 事件后刷新 read model。

这样 UI 能和 Claude/Codex、VibeHub Plugin 连接，但不会让浏览器成为新的 Ticket 真相源。

## 6. Demo 范围

[`docs/demos/personal-ticket-branch-workbench.html`](./demos/personal-ticket-branch-workbench.html) 是无外部依赖的交互设计稿，使用合成数据演示：

- 多个 Goal 及 Human / AI creator；
- 每个 Goal 对应不同 VibeHub Ticket graph；
- DONE、READY、RUNNING、BLOCKED、NEEDS YOU；
- Goal 切换、Ticket 切换、Inspector tabs、Inbox 跳转、行内新建 Goal；
- 桌面三栏和移动端滑出式 inspector。

它展示最终交互和集成契约，但尚未连接真实 Personal Hub CLI 或 VibeHub runtime。
