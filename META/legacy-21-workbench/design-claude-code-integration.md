# Claude Code 适配层 — Redo 蓝图(单一权威文档)

> 2026-07-12 重写(Wayne:"要 redo 就来做 redo,不能跑偏")。此前的分层批注全部收敛进本稿:
> 已定的写成定论,待定的只在 §7 一处列清单。批完后内容 promote 进 decision-workbench-006/007/008/009,本文档删除。
> 事实基线:hooks 能力表抓自官方文档 code.claude.com/docs/en/hooks(2026-07-12),非凭记忆。

---

## §0 北极星(不跑偏锚点)

**交付物是一个 Claude Code plugin,装齐三件套;整个适配层做的唯一一件事:prompt-engineer 用户自己正在跑的 agent,并把它产生的一切机械落进 SQLite。**

**核心价值(Wayne 2026-07-12 再钉)**:context 管理引擎——透出层**永远不是**核心价值;可视化是 commodity(与任何 observability 工具同构),唯一独有格 = 事件 scope。GUI 定位 = 舰队仪表盘 + 快速介入盘,精雕细琢靠 dogfood 迭代;hook/skill/graphstore 半边稳定可预期,GUI 半边才是要雕的。

**产品论题(Wayne 2026-07-12,开源版的赌注)**:用自然语言 skill 替代 codified workflow——ingest/蒸馏这类 pipeline 不写成代码里的 step 1-2-3,写成用户 agent 可执行、用户本人可读可改可 fork 的自然语言;确定性代码收缩到只有必须机械的部分(存储完整性/校验闸/采集)。我们自己 dogfood 这套模式(fr-*/commit-sync 开发 Vibehub 即实验),skill 的每次 change/优化(git 版本史)反哺产品 workflow 设计——块 E 服从率实证是这条反哺回路的第一次正式跑。

| 件 | 职责 | 一句话 |
|---|---|---|
| **hooks** | 触发骨架(**when**) | 在关键时刻点名"该启动哪类行为了";只含运行协议,零语义 workflow |
| **MCP server** | 确定性端点 + 质量闸 | db 的唯一读写门;schema 校验/查重/supersede 链,只返回机械事实;零语义判断 |
| **skill 包** | 唯一 intelligence 层(**how well**) | 完整拥有 ingest、distill、query 的跨步骤方法论、判断与综合策略 |

铁律(全部继承既有拍板,redo 不动):core/CLI/MCP 零 LLM(013)· 稳态逐 hook 注入 = 0(026)· 知识库无 D,只 stale/supersede(026)· hook 进程恒 exit 0且不阻断用户动作(Stop pending 的 decision:block 是“阻止停下并继续”,不是用户门禁)· 用户面无咒语入口,skill 触发者 = hook 微指令 / tool description / agent 自发(026 杀的是咒语,不是 skill 载体)。

数据流一条:**session → hooks → `vibehub hook` CLI(写事件+回查注入队列)→ SQLite ← MCP server(工具端点)← skill(方法论)**;app/demo 只读。

## §1 hooks 触发骨架(已定案)

九事件接线,其余二十余个不接(逐条理由见附表 A)。**稳态每 hook 注入 = 0;无条件注入全系统仅一处。**

| Hook(matcher) | 采(写 SQLite) | 注(条件) |
|---|---|---|
| SessionStart(全 source) | session 出生/source/agent_type | **行为协议**(唯一无条件注入,每 session 一次;resume/compact 重注因 context 已重置)+ pending 补送 |
| UserPromptSubmit | launch/user_injection + prompt_id + 里程碑判定 | pending 送达(仅队列非空) |
| PostToolUse(Edit\|Write\|MultiEdit\|NotebookEdit\|Read) | 足迹 | pending 送达 + **越界提醒**(仅机械探测越出当前声明 write scope,每份声明至多一次,re-register 重置) |
| Notification(needs_input 类) | question → waiting | 无(能力上不可注) |
| Stop | self_report(`last_assistant_message`,旧版才回退 transcript 尾) | pending 送达 — **送达即唤醒**(官方 wire format:顶层 `decision:"block"` + `reason`) |
| SessionEnd | end reason → done | 无 |
| SubagentStart/Stop | 子 agent 谱系 | 无 |
| PostToolUseFailure | error_message(stalled 佐证) | 无 |
| StopFailure | API 错误类型 → statusDetail | 无(CC 忽略输出) |

**Robustness 判决**:内置 hooks(官方文档化公开契约);失联机械可测(有新 commit 而 sessions 表零新行 → UI 横幅 + `vibehub init` 幂等重接);transcript-watcher 记 Plan B 不建;真降级 = 021 弱信号档。不自建 session 监听器。

**里程碑判定(已改向,随卡点 2 确认)**:精准优先二值——仅强信号(多行/代码块/URL/路径/加权长度≥60,CJK×2)升里程碑档,其余留默认档;默认档全量事件本来就在(023 两档 toggle 兜底),漏判可见、误判才灌水。三分类的 ambiguous 桶与薄 LLM 再裁取消;如需,LLM 日后从默认档异步捞升。

## §2 微协议文本(B1 已终裁;B2/B3 推荐待点头)

规则:全英文,`[Vibehub]` 前缀;**文本改动 = 产品改动,实装后变更留 spec 痕**;终裁权在块 E 服从率实证(真 session 数调用率,人逐条读)。

**B1 · SessionStart 行为协议 — ✅ Wayne 终裁:四义务命令式 + manual 指针**(token 便宜;协议兼任"让 agent 知道全部 MCP 工具存在"——description 在 deferred loading 下不保证可见,四条全列 = 存在感本身):

```
[Vibehub] This repo runs Vibehub — your team's shared context layer. Protocol:
1. Before your first edit, call register_scope: what you'll touch + one line on what you're doing.
2. Before working in code you haven't touched this session, use the vibehub-query skill — decisions and constraints may bind it.
3. The moment a design decision is made (by you or your user), call kb_record. Don't batch for later.
4. If your direction changes, say so: self_report, one line.
For the full picture of how Vibehub works, call get_manual — when you need it, not before starting work.
Skipping these hides your work from your team.
```

**B2 · 越界提醒**(触发:edit 足迹越出当前声明,每份声明一次)— 推荐 A(给台阶双分支,"不会再提醒"关掉道歉噪音分支):

```
[Vibehub] Your last edit ({file}) is outside your declared scope. If your plan changed, update it now: self_report one line + register_scope the new area. If this is just a quick touch-up, ignore this — you won't be reminded again for this scope.
```

**B3 · 注入送达包装** — inject 推荐 A(防 agent 把注入当新任务重规划);pause 推荐 A;批量 FIFO 合并、含任一 pause 整块按 pause(最严胜出);**注入现场上下文**:app 端入队时机械附带用户写留言时的 UI locus(冲突卡/事件/文件),包装头部一行,injections 表加可空 context 列,CLI 透传:

```
[Vibehub] Message from your user (written on the conflict card: {locus}):
> {text}
Fold this into what you're doing — no need to restart or re-plan unless it says so.
```
```
[Vibehub] Your user pressed PAUSE and left you this:
> {text}
Stop what you're doing: no new tool calls. Reply to this message, then wait for your user's response before continuing.
```

**B1-meta(编排席)— DEFERRED**:消费者在 M3+ 操作舱,届时连场景一起过;机制先定(app 发射设 `VIBEHUB_SESSION_ROLE=meta`,hook CLI 读环境变量分流)。

## §3 MCP server:端点 + 质量闸(已定案)

五个日常工具 + `kb_apply_distillation` 批量写端点。**description 不是 intelligence 层**:只说能力、输入输出/机械约束,以及轻量路由到对应 skill;跨工具的『怎么查/怎么拆/怎么综合』只住 skill。server 是 db 唯一写门,落库过机械校验(schema/查重预检/supersede 链完整性/anchor 存在性),不合格返回 warning 打回;返回值只可携带机械事实,不得编排后续语义 workflow。

| 工具 | 一句话 | description 要点(全文见附表 B) |
|---|---|---|
| `register_scope` | 声明 write/read 地界 + 一句人话状态,同一动作双版本(022) | 开工第一次 edit 前调;漂移再调即替换;声明宽不罚(已知张力:wide 声明废掉越界提醒与冲突精度——v1 接受,记档非 bug) |
| `self_report` | 一句话状态更新 | 计划变/大步完成/收到越界提醒后;区域也变了改调 register_scope |
| `kb_retrieve` | 查决策图 | 碰陌生区前/架构选择前/用户问 why;按 topic 或 path;"cheap and local — when in doubt, call it" |
| `kb_record` | 沉淀落库(唯一写门) | 决策发生当场记;无 delete,改错传 supersedes、废弃传 marks_stale;**实质性 ingest(整段讨论/会议记录)description 指路 ingest skill**;落 draft 态人晨审 promote |
| `get_manual` | agent-facing 手册(被动参考) | 系统全貌/用户看到什么/好公民准则;"don't read it up front for routine tasks" |
| `kb_apply_distillation` | distill manifest 的原子 apply 门 | 批量校验 feature/anchor/relation 引用与 repo-relative path;单事务写入后重算 layout;不做语义拆解 |

**GitHub-why-not(009 必答)**:scope registry / 注入 / 本地语义图全是"正在跑的 session"的事中态;GitHub 无 session 实体,PR/issue/commit 皆事后工件。零重叠。

## §4 Skill 包:方法论(redo 新增件,decision-workbench-009)

**没有 skill 包,蒸馏质量管道不成立**——裸 description 写库,条目质量靠运气。方法论正文从我们的 fr-* skills + Victor plugin(纯 skill 包 9 skill/2106 行,026 判定 C/R/U 领域逻辑约六七成可复用)蒸馏改写,触发者换血(咒语 → hook 指路/description 提示/agent 自发)。初版至少三个:

| Skill | 方法论内容 | 来源复用 | 触发 |
|---|---|---|---|
| `vibehub-ingest` | 把一段讨论拆成 spec objects:七类型判定/查重(先 kb_retrieve)/relations/provenance/置信度,逐条经 kb_record 落库 | random-contexts + fr-ingest | kb_record description 指路;agent 自发 |
| `vibehub-distill` | 冷启动"认识 repo"pipeline:扫描 → 提 feature → 锚定 → 逐步经 MCP 落库(026 唯一用户主动例外) | Room 19 蒸馏方法论 + fr-init | 用户按钮/`vibehub init --distill`(咒语按钮化,005) |
| `vibehub-query` | 将当前任务/路径/why 问题形成查询,按需扩展或收窄,综合冲突、版本链与约束,输出可执行 context | prompt-gen/dev context-pull + Victor plugin 三档拉取 | SessionStart 路由/agent 自发;`kb_retrieve` 只是底层原语 |

**质量管道三层闸**:skill 方法论(语义质量)× server 机械校验(结构质量)× draft 态 + 人晨审 promote(裁决质量)。三层缺一则退化。

## §5 已实装资产盘点(redo 中的去留)

| 资产 | 去留 |
|---|---|
| hook CLI 六事件采集 + 五态 + 注入队列/送达(Stop 唤醒/pause 包装/pendingInjections 读侧超时) | **留**,即 §1 的实现底座;新增三事件在 redo 中补 |
| classifyUserPrompt 三分类 | **改**:随 §1 里程碑改向收敛为二值(改动小) |
| 契约 +promptId/+classification | **留** |
| 送达包装 PROVISIONAL 文本 | **已换**:B2/B3 终稿 + locus;Stop wire format 按官方纠正为 decision:block+reason |

## §6 Redo 实施计划 — 一个交付单元,不碎片化

**单元 = plugin 三件套一次成型,验收 = 我们自己在 Vibehub repo dogfood 跑通**(发射→采集→自报→检索→沉淀→注入送达→里程碑上时间线),PR 转正以 dogfood 为准,不以代码绿为准。顺序:

1. MCP server(五个日常工具+kb_apply_distillation+校验闸,core 补 supersede 链/检索排序/scope matcher)
2. skill 包初版(vibehub-ingest / vibehub-distill / vibehub-query)
3. hooks wiring + `vibehub init`(装三件套)+ `vibehub inject`
4. 微协议文本终稿接线 + 里程碑二值收敛
5. dogfood 实证,**服从率为一等指标**(N 个真 session,数四义务调用率与时机,人读终裁文本)。实证清单必须包含:`VIBEHUB_SESSION_ROLE` 是否由 session 进程传进 hook command env;十分钟 Bash 长跑零 hook 时 stalled 读侧假阳性的已知代价。

## §7 已裁与实证余项

1. 卡点 1/2/3 均由 Wayne 2026-07-12 批准;实现以 010 的 intelligence ownership 为最高约束。
2. 块 E 仍需实证:四义务服从率、`VIBEHUB_SESSION_ROLE` env 继承、Stop decision:block 唤醒、长跑 Bash 的 stalled 假阳性、里程碑二值强信号清单。

---

## 附表 A:不接线事件与理由

| Hook | 不接理由 |
|---|---|
| PreToolUse / PermissionRequest / PermissionDenied | 门禁类,不做 gating;热路径 spawn 白付 |
| PostToolBatch / UserPromptExpansion / MessageDisplay | 批次/斜杠展开/显示层,无感知增量 |
| PreCompact / PostCompact | SessionStart(source=compact) 已覆盖协议重注 |
| TaskCreated / TaskCompleted / TeammateIdle | CC 自家生命周期,与我们的"事"不同构 |
| ConfigChange / CwdChanged / FileChanged / InstructionsLoaded | 环境杂音;watchPaths 复杂度不换增量 |
| Elicitation* / Worktree* / Setup | MCP 表单/worktree 托管/CI,非采集面 |

## 附表 B:工具 description 逐字全文

**register_scope**:
```
Declare what this session is working on. Call this ONCE near the start of any coding task, BEFORE your first edit — and call it again whenever your work moves into an area you didn't declare. Give (a) one plain-language line on what you're doing (your user reads this on a map), and (b) the areas you'll write to and read from, as repo-relative path globs. Declaring wide is allowed and never penalized; not declaring makes your work invisible to your team and triggers off-scope warnings. This is also how you update your status line — re-calling replaces your previous declaration.
```
schema:`{status: string(≤200), write: [{glob, label?}], read?: [...]}`,required: status+write。

**self_report**:
```
One-line narrative update: what you're doing now, or what just changed. Call when your plan shifts, when you finish a major step, or right after Vibehub reminds you about an off-scope edit. Your user sees this line on the task card — a stale line means they're watching yesterday's story. If your working area ALSO changed, call register_scope instead (it updates both). Keep it to one sentence; this is a status line, not a report.
```
schema:`{status: string(≤200), done?: string(≤200)}`。

**kb_retrieve**:
```
Query this repo's decision/constraint graph — the reasons behind how the code is shaped. Call BEFORE editing code you haven't touched this session, before making an architectural choice, and when the user asks "why is it like this". Query by topic words or by file path; you get back decisions, constraints and intents that bind that territory, most-relevant first. Cheap and local — when in doubt, call it. Not calling it risks re-litigating settled decisions.
```
schema:`{query?, paths?: string[], limit?: int=8}`,anyOf query/paths。

**kb_record**:
```
Record a decision, constraint or intent into the team graph THE MOMENT it happens — when your user rules something ("let's always X", "never Y", "we'll do A instead of B"), or when you make a design choice that future sessions must respect. Don't batch for later; don't wait to be asked. One entry = one fact. There is no delete: to correct an earlier entry, pass supersedes with its id; to mark one obsolete without replacement, pass marks_stale. For ingesting a whole discussion or meeting log, use the vibehub-ingest skill — it knows how to decompose. Recording is how your team stops re-deciding the same thing.
```
schema:`{type: decision|constraint|intent, summary(≤300), detail?, anchors?: string[], supersedes?, marks_stale?}`。

**get_manual**:
```
The full picture of how Vibehub works: what your user sees on their map, how your scope/reports/records surface to your team, and how to be a good citizen of a shared repo. Call when you're unsure why a Vibehub reminder appeared, or before heavy multi-session work. Reference material — don't read it up front for routine tasks.
```
schema:`{topic?: string}`。
