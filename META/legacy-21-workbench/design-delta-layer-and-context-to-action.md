# Delta Layer & Context-to-Action Bridge — 前端方向（M2 pivots 之后）

Status: DRAFT — 待 Wayne 晨审（批准内容 promote 进 decision-workbench specs；裁决入口见 DECISIONS-NEEDED.md 末条）
Date: 2026-07-19
Room: 21-workbench
Related: intent-project-002 · decision-project-009/010/013/024/026/027 · decision-workbench-011/013/014/015/016 · intent-workbench-002/003
Mock: `design-spec-drilldown-mock.html`（**variant F 已由 Wayne 2026-07-19 认可为深钻面基准**；A–E 留档为设计考古）· 在线版 https://claude.ai/code/artifact/f03894d7-4e9a-458d-8415-d52a1aa69470

---

## 1. 为什么前端需要再思考（审计结论摘要）

生产事实：`app/src/main.tsx` 只渲染 map（bridge ok）与 bootstrap 错误卡；**InstallScreen 与
MenubarScreen 从未接入生产**（仅存于 test/FixtureApp）。M0 五屏中真正上过战场的三面
（map / task panel / conflict card）已吸收全部 pivot（receipts、介入诚实、v8 权威）；
真正过时的是 install/onboarding 这条线——而它是白纸，重做零回归成本。

v8 定稿后的理念 pivot 与前端错位：

| Pivot | 对前端的错位 |
|---|---|
| agent-first onboarding（015） | install 屏的 App 驱动安装/三行 checklist/connected 终态模型全部失实；缺 Installed→Connected→Activated 阶梯与 waiting-for-handshake 状态 |
| 版本化蒸馏 + 人审 + CAS（012, m2p5c） | "Map this repo" 一次性 claude -p 模型失实；`mapping_runs` 已是死表；App 直接拉 LLM 违反 013/025 |
| Task=outcome（013） | 事=branch=worktree 三连等式被推翻（身份永不由 branch 派生、context-only 无 worktree、024 收窄为 code-write 后默认生命周期）；实现仍是 branch 派生（"永恒 main 卡"坍缩是现症） |
| 双宿主 native adapter（m2p6e Plan B） | Codex session 时间线天生比 Claude 薄（默认包无 Stop/SessionEnd/Notification）；证据分三档需诚实标注 |
| presentation protocol（016, m2p6f） | 已滚入生产三面；新 surface 直接复用 receipt 真相 |

DECISIONS-NEEDED 队列核查：M0 fork 全部已裁（7 项亲裁 + 81 项 batch-accepted），唯 ⑥
（无 fixture 冲突降级卡）无 verdict——已被生产 `evidence_unavailable` 流事实取代，建议正式关闭。
redo 蓝图中"hooks 失联 UI 横幅"（有新 commit 而 sessions 零新行 → 横幅 + `vibehub init` 重接）
设计过但从未建——纯增量小件。

## 2. 命题：两个时间层 + 一座桥

GitHub-like 旧稿（云端血统）的骨头拆解后，与 v8 不是竞争而是互补的时间层：

- **Now 层**（已建 = v8 地图）：舰队现在在哪、占什么地盘、哪里在撞——在场感知 + 介入。
- **Delta 层**（缺失）：相对**蒸馏基线**（不是 branch 对比）什么漂了、什么领先、什么等人裁——
  风险排序的 needs-attention 队列。数据白送：anchor content_hash 漂移、mapping version diff、
  stale/review 计数、update run candidates。
- **桥**：队列项 → 确定性组装的 context 包（room + anchors + 证据，诚实体积）→ 一键交给 agent。
  即 intent-workbench-002 + context-to-action handoff packet 的 App 按钮。**桥硬依赖 task
  身份迁移**（context-to-action open question 7）。

旧稿逐条裁决（吸收 = 换我们的基线与词汇；拒绝 = 撞既有拍板）：

| 旧稿理念 | 裁决 |
|---|---|
| delta 视角（ahead/drift/behind vs base） | 吸收，基线改为蒸馏基线 |
| needs attention · ordered by risk | 吸收，升主 App 一等公民 |
| 语义冲突原因（same claim changed on both branches） | 吸收——"唯一独有格=事件scope"的进一步；prose 原因标签，KB 保持隐身 |
| context prompt ready + 一键发射 | 吸收为旗舰交互（= intent-002） |
| Open GitHub comparison | 吸收（GitHub-first，diff 永不内嵌） |
| touched-by-me 过滤 / avatars / review 压力计 | 小件吸收（压力计只做数字+agent 指针，不做 spec UI） |
| repo-page chrome / tabs / spec 面板 / branch-compare 主框架 / 内嵌 diff | 拒绝（分别撞 010 / intent-002 / 013 / 009） |

## 3. 教义细化：invisible by default, revealed at the comparison moment

KB 隐身在第一层完整保持（map/队列永不出现 spec）。**深钻/比较时刻**是被批准的唯一显形点，
且受以下规则约束（全部体现在 mock F 中）：

1. 标题永远人话主题；claim 稳定 ID 降级为 footer mono 出身行（audit 用，不是导航用）。
2. **结论层诚实二分**：机械事实区（每条挂机器可证 chip：byte-identical / +N−M / N edits）
   与解读区（agent 原话引用 + "interpretation, not fact" 标注 + run/commit 出身）严格分离，
   系统永不裸嘴下语义判断。
3. **色语言按方向诚实**：对 ACTIVE 比有方向（红删/绿增）；candidate 互比无方向，用蓝色
   "differs"，不预设赢家。
4. candidate 是 branch/worktree 归属的一等事实（per-run candidate set 本就如此）：端点板挂
   branch chip + run/commit 出身；N 候选 → 两两对比端点切换（三栏 merge 视图否决——窄屏与
   长文本下崩）。
5. 行动 agent-first：主按钮 "Review in your agent"（组装本对比为 context 走 `$vibehub-review`），
   App 永不自裁（footer 明示 *decides nothing by itself*）；代码 diff 跳 GitHub。

## 4. 深钻面基准 = variant F（信息图层纪律）

**每个事实只出现一次，归属唯一图层**。四层结构：

| 层 | 唯一职责 |
|---|---|
| header | 我在哪 + 一句机械结论；agent 解读折叠于此 |
| COMPARE 条 | 我在比什么（端点 = 唯一控件） |
| 字段网格 | 全部字段级真相：状态 chip 住标签列；**相同字段单格横贯不重复**；他分支也动了某字段 → 标签旁琥珀小点（悬停解释） |
| footer | 行动 + mono 出身 |

行对齐 side-by-side（字段为横贯行，左右格同 grid row 天然对齐）；chip 收敛为两族
（状态 tag / 出身 chip）；横带 7→4。校准余量：若仍嫌密 → 砍 header 结论句；若过简 →
COMPARE 条右侧加回 field agreement 概览（2026-07-19 现状密度已获认可）。

## 5. 裁决点（晨审逐条批）

1. **Install/activation 重做**：升级 bootstrap 错误卡为图形 setup 入口（消费 `setup status` 的
   `ProjectActivationResultV1`；bridge 加 setup 读方法）——即 delta 层的 setup/状态面。
   保留 iter-14~18 已裁工艺（packing 引擎、无进度分数 chip、失败行内联、canvas 居中、
   install 屏全宽 scrim 例外）。推荐档位 A（完整图形入口）。
2. **蒸馏透出**：只读 run 状态 + "candidate awaiting review" 芯片；review/activate 留 agent 侧。
3. **hooks 失联横幅**：立即小件（判决文本已在 redo 蓝图）。
4. **Panel 宿主证据档位标注**：Codex session 的诚实薄时间线说明——现在做 or 等双宿主 dogfood 定文案。
5. **记账**：`mapping_runs` 死表下个 migration 清除；DECISIONS-NEEDED ⑥ 补关闭行（待确认）。
6. **Task 身份迁移立项**（context-to-action open question 7）：session binding + 显式 token 解析 +
   branch 仅首捕兜底——桥与 rail 卡语义的前置；同时救 checkpoint cadence 与"永恒 main 卡"。
7. **迁移前过渡诚实化**：main/checkout 聚合卡标注 + launch/文案改 outcome 语言（并入 1）。

## 6. 明确不做

Run 层级 UI；App control plane；三栏 merge 视图；spec 浏览 UI；内嵌代码 diff；
branch-compare 作为主框架；为 context-only 事创建 worktree 的任何 UI 暗示。

## 7. 实施排序草案（批后生效）

- **Track 1（立即小件）**：hooks 失联横幅、⑥ 关闭、`mapping_runs` 清理、文案 outcome 化。
- **Track 2（delta 层 v1）**：drift 信号读模型 + needs-attention 队列 + F 深钻面
  （bridge 合约新增 setup/drift 读方法；receipts/v8 语汇复用）。
- **Track 3（桥）**：context 组装 + 一键发射——排在 task 身份迁移（裁决点 6）之后。

每 track 照常走：planner → 实现 → 对抗 review → gates → commit-sync；App 改动服从
decision-workbench-014 v8 权威与本文档第 3 节教义。
