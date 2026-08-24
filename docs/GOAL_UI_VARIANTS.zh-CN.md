# Personal Ticket Hub · Goal UI 五方案

> 状态：Design exploration，等待选择 A / B / C / D / E
> 日期：2026-08-24
> 对比页：[`personal-ticket-goal-directions.html`](./demos/personal-ticket-goal-directions.html)

## 1. 设计目标

Goals 不能只是 Ticket 的文件夹或筛选器。它需要像 Tickets 一样成为可操作的工作视图，让用户在一屏内回答：

- 当前有哪些 Goal 正在推进；
- 每个 Goal 下有哪些 Ticket；
- 哪些 Ticket 由自己负责，哪些正在由 Agent implement；
- 哪个 Goal 卡住、接下来需要谁处理；
- 哪些 Ticket 来自 Personal Hub，哪些只是 VibeHub 的只读 projection。

本轮参考 Jira 的层级、状态和完成度表达，以及 Linear 的紧凑密度、快速切换和弱装饰风格，但继续使用 Personal Ticket Hub 已确定的 branch 语义。

## 2. 五个方向

| 方案 | 核心模型 | 优点 | 风险 | 最适合 |
|---|---|---|---|---|
| A · Linear Branch Rail | Goal 列表与 Ticket branch 合并成紧凑纵向 rail | 扫描最快；与现有 Tickets 视觉最一致；迁移成本低 | 大型 Goal 的多层级表达有限 | 默认 Dashboard、日常高频使用 |
| B · Jira Goal Hierarchy | Goal → milestone / epic → Ticket 的可展开层级 | 层级和完成度最明确；适合复杂项目 | 密度偏高；容易重新变成传统项目管理器 | 有多层里程碑的长期 Goal |
| C · Focus Goal | 一次聚焦一个 Goal，Ticket branch 成为主画布 | 阅读和决策最安静；上下文最完整 | 跨 Goal 扫描较慢 | 深度 review、planning、复盘 |
| D · Command Branch Queue | 深色、键盘优先的 Goal/Ticket 队列 | Agent power user 切换最快；状态最直接 | 学习成本和视觉强度更高 | 高频多 Agent 调度 |
| E · Roadmap Branch Strips | 每个 Goal 是横向时间带，Ticket 是阶段节点 | 时间和先后关系最直观 | 小 Ticket 多时横向空间压力大 | 有明确时间阶段的 Goal portfolio |

## 3. 共同语义，不随方案变化

1. Goal 与 Ticket 都是可操作对象；Goal 视图不是静态报表。
2. 蓝色主干表示 Owner（You）责任流，绿色 branch 表示 Codex / Claude 等 Agent 的并行工作。
3. branch 表达责任与工作流，不等于 VibeHub `relations: depends_on`。
4. VibeHub 依赖只在成功检测的项目 Graph 中作为 canonical relation 展示。
5. Goal 可以没有 VibeHub；Goal 也可以同时包含 Personal Tickets 与 VibeHub Ticket refs。
6. 每个 Ticket 持续展示 source、owner、state 和 next action，不能只剩图形节点。
7. 需要用户 review、批准或选择的内容仍汇总到 Inbox，而不是只藏在某个 Goal 里。

## 4. 选择标准

建议按以下顺序判断：

1. **5 秒扫描**：能否快速看到哪个 Goal active、哪个 Ticket 正在 implement、哪里 needs you；
2. **Tickets 一致性**：Goal branch 与现有 Ticket branch 是否像同一套产品语言；
3. **规模适配**：同时有 5–20 个 Goal、每个 3–30 个 Ticket 时是否仍可用；
4. **移动端**：窄屏是否仍保留 Goal、进度和当前责任人；
5. **实现成本**：能否复用现有 Ticket read model、filters、inspector 与 branch renderer。

## 5. 当前建议

首选 **A · Linear Branch Rail**：它最符合“Goals 要像 Tickets 一样”的要求，也能最大程度复用当前 Ticket Dashboard 的 branch renderer、row component 与 inspector。

如果产品确定需要 Goal → milestone → Ticket 的多层组织，再选 **B · Jira Goal Hierarchy**；如果主要用户是同时驱动多个 Agent 的 power user，可以把 **D · Command Branch Queue** 保留为后续可选密度模式，而不是默认主题。

## 6. 实施边界

本轮 HTML 是交互设计比较稿，不读真实项目数据，也不会修改 Personal Hub 或 VibeHub 文件。选定方向后再将对应布局迁移到主 Demo，并为 Goal list、Goal detail、Ticket branch、Inbox projection 和 VibeHub source badge 接入同一份 read model。
