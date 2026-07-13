# Claude Code 集成层设计 — hook 矩阵 / 微协议文本 / MCP 工具面

> M2 主线设计文档,2026-07-12。三个卡点逐块过:块A(hook 矩阵)→ 块B(微协议文本,style-tiles 式候选)→ 块C(MCP 工具面)。
> 批完后:决策内容 promote 进 decision-workbench-006/007/008,本文档删除(设计文档是 checkpoint 工件,不长驻 META)。
> 事实基线:hooks 能力表全部来自官方文档 code.claude.com/docs/en/hooks(2026-07-12 抓取),非凭记忆。

---

## ⛔ 卡点 1 — 设计块 A:hook 清单矩阵

### A.0 官方能力事实(与设计相关的硬事实)

| 事实 | 设计影响 |
|---|---|
| `additionalContext` 注入面:SessionStart / UserPromptSubmit / PostToolUse / PostToolUseFailure / Stop / SubagentStart / SubagentStop / PostCompact / SessionEnd 等都支持 `hookSpecificOutput.additionalContext` | 注入送达点比 M1 假设的宽 |
| **Stop 的 additionalContext 会让对话继续**(agent 在下一次 model call 看到) | 异步注入可以在 agent 刚停笔时送达并唤醒——fire-and-forget 不用等下一条用户 prompt |
| SessionStart 有 matcher:`startup / resume / clear / compact`;**compact 后 SessionStart 重新触发** | 行为协议在 compaction 丢失后自动有重注入口,无需接 PreCompact/PostCompact |
| PostToolUse 有 tool-name matcher(`Edit\|Write\|MultiEdit\|NotebookEdit\|Read` 等,支持正则) | 足迹采集可以只在碰文件的工具上 spawn,热路径省大半 spawn |
| Notification 的输出只有 `systemMessage`/`terminalSequence`,**不能注入 agent context** | "等你"态只采不注 |
| SessionEnd 的 additionalContext 无意义(session 已死);StopFailure 输出被完全忽略 | 这两个纯采集 |
| exit 0 + stdout JSON = 通用协议;exit 2 = 阻断(我们永不阻断) | `vibehub hook` 恒 exit 0 的既有契约成立 |
| 常见字段全事件都带:`session_id / prompt_id / transcript_path / cwd / permission_mode / agent_id / agent_type` | promptId 回溯(decision-workbench-001)是白送的,hook payload 自带 |
| 每 handler 可配 `timeout`;command hook 默认 600s,UserPromptSubmit 默认 30s | 我们毫秒级短命执行,远在预算内 |

### A.1 矩阵(v1 接线集)

预算单位 = 输出 token 估算;**稳态每 hook 注入 = 0** 是设计目标(026 第一敌人)。

| Hook(matcher) | 触发时机 | 采什么(写 SQLite) | 注什么(触发条件) | 注入预算 |
|---|---|---|---|---|
| **SessionStart**(全 source) | session 新建/resume/clear/compact 后 | session 出生:source、agent_type、task 关联(branch) | ①行为协议(**每 session 一次**,026 认可的三驱动之一;meta/普通角色分流,见块B);②source=resume/compact 时重注协议(context 已丢);③pending 注入顺带送达(离场期间攒的) | 协议 ≤120;队列按内容 |
| **UserPromptSubmit** | 用户提交 prompt、处理前 | launch/user_injection 事件 + `prompt_id` + 里程碑机械分类(块D) | pending 注入送达(**仅队列非空**);无其他注入 | 0 或队列内容+~20 包装 |
| **PostToolUse**(`Edit\|Write\|MultiEdit\|NotebookEdit\|Read`) | 碰文件的工具成功后 | 足迹(path/action) | ①pending 注入送达(仅非空);②scope 越界自报提醒(**仅机械探测到足迹越出当前声明 write scope,且本份声明未提醒过——每份 scope 声明至多一次**;重新 register_scope = 新契约 = 重新获得一次提醒资格;探测持续、提醒去重,twist 显形不受影响。022 硬条款,Wayne 2026-07-12 裁决) | 0 稳态;提醒 ≤50 一次性 |
| **Notification**(`agent_needs_input\|permission_prompt\|idle_prompt`) | agent 停下要人 | question 事件 → waiting 态 | 无(能力上不可注) | 0 |
| **Stop** | agent 一轮说完 | self_report(transcript 尾原话) | pending 注入送达(仅非空)——**送达即唤醒**,异步注入的最速通道(Wayne 2026-07-12 口述认可) | 0 稳态 |
| **SessionEnd**(全 reason) | session 终止 | end reason → done 态 | 无 | 0 |
| **SubagentStart / SubagentStop**(新增,collect-only) | 子 agent 生灭 | agent_id/agent_type 谱系事件(面板"第N个session"与舰队感知的原料) | 无(v1;子 agent 继承主 session 工作,不重复注协议) | 0 |
| **PostToolUseFailure**(新增,collect-only) | 工具失败后 | error_message → 时间线弱事件(stalled 诊断佐证) | 无 | 0 |
| **StopFailure**(新增,collect-only) | API 错误终轮 | error type → statusDetail("rate limited"等,诚实呈现卡住原因) | 无(输出被 CC 忽略,想注也注不了) | 0 |

**不接线**(每行一句理由):

| Hook | 不接理由 |
|---|---|
| PreToolUse / PermissionRequest / PermissionDenied | 门禁类,我们不做 gating(永不阻断);热路径 spawn 成本白付 |
| PostToolBatch / UserPromptExpansion / MessageDisplay | 批次/斜杠展开/显示层,无感知层信息增量 |
| PreCompact / PostCompact | 协议重注已由 SessionStart(source=compact) 覆盖;compact 记号同源可得 |
| TaskCreated / TaskCompleted / TeammateIdle | Claude Code 自家 task/team 生命周期,与我们的"事"不同构,映射硬造会撒谎 |
| ConfigChange / CwdChanged / FileChanged / InstructionsLoaded | 环境杂音;FileChanged 需 SessionStart 注册 watchPaths,复杂度不换感知增量 |
| Elicitation* / Worktree* / Setup | MCP 表单/worktree 托管/CI 初始化,均非采集面 |

**注入预算总账(单 session 稳态)**:协议 ≤120(一次)+ 越界提醒 ≤50(每份 scope 声明至多一次;不重声明的 session 恒 ≤1 次)+ 队列送达(用户主动行为,不算预算侵蚀)。逐 hook 稳态 = 0,无条件注入只有 SessionStart 协议一处(026 明文认可的驱动①)。

### A.2 Wayne 的 hook robustness 疑虑 — 分析与后备

疑虑(work log 2026-7-12):"内置 hook 会不会 not so robust,要不要自己监听所有 session"。

**失效模式逐条:**

| 失效 | 概率/后果 | 对策 |
|---|---|---|
| settings 被别的工具覆写/用户误删 → hook 静默失联 | 中/整段失明 | `vibehub init` 幂等重接;**失联机械可测**:repo 有新 commit 而 sessions 表零新行 → UI 诚实横幅"hooks 可能没接上"(读侧推导,零 daemon) |
| hook CLI 自身崩 | 低/丢单点事件 | 已有契约:恒 exit 0 + `~/.vibehub/hook.log`;事件追加式,状态机任一后续 hook 自愈 |
| hooks API 版本漂移(字段/事件改名) | 低/局部退化 | payload 宽容解析(未知字段忽略);hooks 是**官方文档化的公开契约**,漂移有 changelog 可追 |
| 只覆盖 Claude Code | 确定/其他 agent 失明 | 这不是 hooks 的 bug,是强档的定义域——弱档见下 |

**"自己监听所有 session"的两条路,判决:**

1. **transcript-watcher**(watch `~/.claude/projects/*.jsonl`):信息与 hooks 等价甚至更全,但 transcript 格式是**私有实现**,churn 风险高于文档化的 hooks API;且与 hooks 双轨采集要去重。→ **记为 Plan B,不建**。
2. **file-watcher + 进程存在性**:这就是 decision-project-021 已拍板的**弱信号档**,本来就是任意 agent 的零集成兜底。→ **降级路径已在架构里,不需要为 robustness 新发明**。

**结论:先用内置 hooks(公开契约、强档精确);失联做机械检测 + 幂等重接;真降级走 021 弱档。不自建 session 监听器。**

---

## ⛔ 卡点 2 — 设计块 B:微协议 prompt 文本(逐条过,style-tiles 式)

通用规则:全部英文(agent-facing,token 效率+通用性);统一 `[Vibehub]` 前缀(agent 可辨识来源,与 hook 注入的 system-reminder 语境相容);**文本改动 = 产品改动**,实装后任何变更留 spec 痕。

预算计法:OpenAI/Anthropic tokenizer 下英文 ≈ 0.75 词/token,下述预算按 token 估。

### B1. SessionStart 行为协议(普通 session)

- **触发**:SessionStart,source ∈ {startup, resume, clear, compact};每 session 恰一次(resume/compact 算新注,因 context 已重置)
- **预算**:候选 A ≈ 110 tok,B ≈ 75 tok,C ≈ 45 tok
- **预期行为**:agent 在动手前调 register_scope;碰陌生区前调 kb_retrieve;做出决策当场 kb_record;方向变化 self_report

**候选 A(命令式全款,教什么时候做什么)**:

```
[Vibehub] This repo runs Vibehub — your team's shared context layer. Protocol:
1. Before your first edit, call register_scope: what you'll touch + one line on what you're doing.
2. Before working in code you haven't touched this session, call kb_retrieve — decisions and constraints may bind it.
3. The moment a design decision is made (by you or your user), call kb_record. Don't batch for later.
4. If your direction changes, say so: self_report, one line.
Skipping these hides your work from your team.
```

**候选 B(讲为什么,提示式)**:

```
[Vibehub] Your teammates see this repo through Vibehub. What they see of THIS session is only what you declare: register_scope before you start, kb_retrieve before entering unfamiliar territory, kb_record when decisions happen, self_report when direction shifts. One line each is enough.
```

**候选 C(极简铁四条)**:

```
[Vibehub] Active. Rules: register_scope before first edit; kb_retrieve before unfamiliar code; kb_record decisions immediately; self_report on direction change.
```

**⛔→✅ B1 已终裁(Wayne 2026-07-12):候选 A(四义务命令式)+ 尾部 manual 指针行。候选 D(两义务混合)出局——裁决理由:token 差价小,协议的另一半作用是开场即让 agent 知道全部 MCP 工具的存在;description 仅在工具被翻到时可见(deferred loading 下不保证),四条全列 = 存在感本身。**

**候选 D(两义务混合版,~75 tok;2026-07-12 顾问 session 建议"四义务砍到两个"后拟)**:

```
[Vibehub] Your teammates see this session only through what you declare. Two duties:
1. Before your first edit: register_scope — what you'll touch + one line on what you're doing.
2. The moment a decision is made (by you or your user): kb_record it. Don't batch for later.
kb_retrieve and self_report exist too — their descriptions say when.
For the full picture, call get_manual — when you need it, not up front.
```

理由:kb_retrieve/self_report 的教学与工具 description 重复(026 驱动②),砍掉减仪式;但**保留末尾存在性提示一行**(~12 tok)——Claude Code 对 MCP 工具有 deferred loading(工具 schema 可能不进 context),"全靠 description 活"在被 defer 的客户端上会失联,这行是兜底。register_scope(时序卡"第一次 edit 前")与 kb_record(反 LLM 默认的"攒着以后说")是 description 承载不了的,留在协议里。
**2026-07-12 Wayne 终裁:D 出局,B1 = A + manual 指针行**(见上);本段保留作候选歧路存档。

**新提案(Wayne 2026-07-12 口述,待卡点 2 一并裁):协议尾部加一行 manual 指针**(约 +18 tok):

```
For the full picture of how Vibehub works (the map, conflicts, what your user sees), call get_manual — when you need it, not before starting work.
```

配套:MCP 面加第五个只读工具 `get_manual`(见块 C4 提案)。设计意图:入口工具就这几个,更深的语境不塞协议里,给 agent 一个"知道去哪看"的把手;"not before starting work" 防止它开工先读文档烧 context。

### B1-meta. Meta session 角色注入(编排席)— **DEFERRED(2026-07-12):消费者在 M3+ 操作舱,现在拍板锁死文本无收益;届时连场景一起过。候选文本保留作参考,不进卡点 2 裁决面。**

- **触发**:SessionStart 且 launcher 标记 meta 角色(机制:app 发射时设 `VIBEHUB_SESSION_ROLE=meta` 环境变量,hook CLI 读取;普通终端 session 无此变量 → 恒普通协议)。M3+ 操作舱(intent-workbench-001)才有真消费者,文本先定
- **预算**:≈ 90 tok
- **预期行为**:meta session 只编排不干活;碰代码文件即 twist 告警(020 空写 scope 机制自守)

**候选 A**:

```
[Vibehub] You are this repo's META session: you orchestrate, you don't code. Your write scope is intentionally empty — editing any file will be flagged. To get work done: create a task and launch a session for it. Your tools: fleet status, task creation, launch, injection, conflict arbitration. Keep answers short; you are a control tower, not a worker.
```

**候选 B(更短)**:

```
[Vibehub] META session: orchestrate only. Never edit files (empty write scope, edits get flagged). Work happens by launching task sessions, not by doing it yourself.
```

### B2. Scope 越界自报提醒

- **触发**:PostToolUse 采到 edit 足迹落在**当前**声明 write scope 之外(机械判定),**且本份声明未发过此提醒** → 注入一次;重新 register_scope 后计数器重置(新契约新资格,Wayne 2026-07-12 裁决)。探测每次照做(twist/地图显形不受限),去重的只是注入动作
- **预算**:候选 A ≈ 55 tok,B ≈ 30 tok
- **预期行为**:方向真变了 → agent 补一句 self_report + 重新 register_scope;只是顺手小改 → agent 忽略,不产生对话噪音

**候选 A(给台阶,两分支都说死)**:

```
[Vibehub] Your last edit ({file}) is outside your declared scope. If your plan changed, update it now: self_report one line + register_scope the new area. If this is just a quick touch-up, ignore this — you won't be reminded again for this scope.
```

**候选 B(极简)**:

```
[Vibehub] Off-scope edit: {file}. If direction changed, self_report + register_scope. Otherwise ignore.
```

**候选 C(问句式,服从率实验对照)**:

```
[Vibehub] You just edited {file}, outside your declared scope — did the plan change? If yes: self_report + register_scope. If no, carry on.
```

*2026-07-12 顾问 session 推荐:B2 选 A——"顺手小改就忽略、不会再提醒"明确关掉 agent 道歉/解释的噪音分支,30 tok 差价值得。本 session 同意;待 Wayne 终裁。*

### B3. 注入队列送达格式

- **触发**:hook 回查队列非空(送达点:UserPromptSubmit / PostToolUse / Stop / SessionStart-resume)
- **预算**:包装 ≈ 25 tok(inject)/ 45 tok(pause)+ 用户文本本身(用户主动行为不计预算侵蚀)
- **预期行为**:inject = 融入当前工作不重启;pause = 停手、回应、等人

**inject 模式,候选 A**:

```
[Vibehub] Message from your user (sent from the workbench while you were working):
> {text}
Fold this into what you're doing — no need to restart or re-plan unless it says so.
```

**inject 模式,候选 B(现 M1 实装格式,最简)**:

```
[Vibehub] Message(s) from your user:
- {text}
```

*2026-07-12 顾问 session 推荐:inject 选 A——极简版有真实风险:agent 把注入当新任务重新规划,"fold this in, no need to restart" 即防此。本 session 同意;待 Wayne 终裁。*

**pause 模式,候选 A**:

```
[Vibehub] Your user pressed PAUSE and left you this:
> {text}
Stop what you're doing: no new tool calls. Reply to this message, then wait for your user's response before continuing.
```

**pause 模式,候选 B(更短)**:

```
[Vibehub] PAUSE from your user:
> {text}
No further tool calls. Answer, then wait.
```

**多条 pending 批量**:同一送达点多条按 FIFO 合并为一个块,`>` 引用逐条列出;有任一 pause 则整块按 pause 包装(最严语义胜出)。

**新提案(Wayne 2026-07-12 口述,待卡点 2 一并裁):注入现场上下文(injection locus)。** Wayne 的观察:用户在 app 里写留言时看着的是某张卡(冲突卡/时间线某事件/某文件),光传原话,"这个先别动"的"这个"就丢了。方向修正:缺的不是 agent 的现场(同 session,它自己有),是**用户写留言时的现场**。方案:app 端入队时机械附带 UI locus(conflict id / event id / file path),送达包装头部多一行,如:

```
[Vibehub] Message from your user (written on the conflict card: refactor-auth × fix-login, shared file src/auth/session.ts):
> {text}
```

零 LLM,injections 表加可空 `context` 列(app 组装人话短语,CLI 只透传)。用户没从卡上发(全局留言)则无此行。

### B4. 角色区分总表(B1/B1-meta 的分流规则)

| session 出生地 | 角色判定 | 注入 |
|---|---|---|
| 用户终端随手开 | 无 VIBEHUB_SESSION_ROLE | B1 普通协议 |
| app 发射的 task session | ROLE=task(预留,注入同 B1;发射词已带 task 上下文) | B1 |
| app 发射的 meta session(M3+) | ROLE=meta | B1-meta |

---

## ⛔ 卡点 3 — 设计块 C:MCP 三组工具面

description 即行为引导(026 驱动②):**何时调、为什么调,全部写进 description**,不依赖 skill 正文。参数走 JSON Schema。沉淀无 D:只 supersede/stale。

**GitHub 为什么做不到(009 必答)**:GitHub 没有"运行中 session"概念——scope registry 是活 session 的实时声明,注入是往正在跑的 agent 推消息,决策图谱是本地 SQLite 语义层;PR/issue/commit 全是事后工件,无一能承载"正在发生"。故三组全部自研,不与 GitHub 重叠。

### C1. `register_scope`

**description(逐字)**:

```
Declare what this session is working on. Call this ONCE near the start of any coding task, BEFORE your first edit — and call it again whenever your work moves into an area you didn't declare. Give (a) one plain-language line on what you're doing (your user reads this on a map), and (b) the areas you'll write to and read from, as repo-relative path globs. Declaring wide is allowed and never penalized; not declaring makes your work invisible to your team and triggers off-scope warnings. This is also how you update your status line — re-calling replaces your previous declaration.
```

**已知张力(2026-07-12 顾问 session 指出,记档不改 v1)**:"Declaring wide is allowed and never penalized" 降低声明门槛,但 wide 声明(如 `**/*`)会同时废掉越界提醒(永不触发)与冲突预警精度。v1 接受(先要有声明,再谈声明质量);若日后满屏 wide 声明,这里是根因不是 bug,届时的杠杆是 description 措辞或 UI 对 wide 声明的可视弱化。

**schema**:

```json
{
  "type": "object",
  "required": ["status", "write"],
  "properties": {
    "status": { "type": "string", "maxLength": 200, "description": "One plain-language line: what you are doing right now." },
    "write":  { "type": "array", "items": { "type": "object", "required": ["glob"], "properties": {
                  "glob":  { "type": "string", "description": "Repo-relative path glob you will edit, e.g. packages/core/src/**" },
                  "label": { "type": "string", "description": "Optional human name for the area, e.g. 'injection queue'" } } } },
    "read":   { "type": "array", "items": { "$ref": "#/properties/write/items" }, "description": "Areas you'll read but not edit. Optional." }
  }
}
```

### C2. `self_report`

**description(逐字)**:

```
One-line narrative update: what you're doing now, or what just changed. Call when your plan shifts, when you finish a major step, or right after Vibehub reminds you about an off-scope edit. Your user sees this line on the task card — a stale line means they're watching yesterday's story. If your working area ALSO changed, call register_scope instead (it updates both). Keep it to one sentence; this is a status line, not a report.
```

**schema**:

```json
{
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "type": "string", "maxLength": 200, "description": "One sentence, present tense: what you are doing / what changed." },
    "done":   { "type": "string", "maxLength": 200, "description": "Optional: one sentence on what you just completed." }
  }
}
```

### C3. 沉淀-retrieve 组:`kb_retrieve` + `kb_record`

**`kb_retrieve` description(逐字)**:

```
Query this repo's decision/constraint graph — the reasons behind how the code is shaped. Call BEFORE editing code you haven't touched this session, before making an architectural choice, and when the user asks "why is it like this". Query by topic words or by file path; you get back decisions, constraints and intents that bind that territory, most-relevant first. Cheap and local — when in doubt, call it. Not calling it risks re-litigating settled decisions.
```

**schema**:

```json
{
  "type": "object",
  "properties": {
    "query": { "type": "string", "description": "Topic words, e.g. 'injection queue delivery semantics'" },
    "paths": { "type": "array", "items": { "type": "string" }, "description": "Repo-relative files/globs — returns specs anchored to them" },
    "limit": { "type": "integer", "default": 8 }
  },
  "anyOf": [ { "required": ["query"] }, { "required": ["paths"] } ]
}
```

**`kb_record` description(逐字)**:

```
Record a decision, constraint or intent into the team graph THE MOMENT it happens — when your user rules something ("let's always X", "never Y", "we'll do A instead of B"), or when you make a design choice that future sessions must respect. Don't batch for later; don't wait to be asked. One entry = one fact. There is no delete: to correct an earlier entry, pass supersedes with its id; to mark one obsolete without replacement, pass marks_stale. Recording is how your team stops re-deciding the same thing.
```

**schema**:

```json
{
  "type": "object",
  "required": ["type", "summary"],
  "properties": {
    "type":        { "type": "string", "enum": ["decision", "constraint", "intent"] },
    "summary":     { "type": "string", "maxLength": 300, "description": "One-line statement of the fact." },
    "detail":      { "type": "string", "description": "Context: why, alternatives rejected, who ruled." },
    "anchors":     { "type": "array", "items": { "type": "string" }, "description": "Repo-relative files this binds." },
    "supersedes":  { "type": "string", "description": "spec_id this entry replaces (old one is version-chained, not deleted)." },
    "marks_stale": { "type": "string", "description": "spec_id to mark stale without replacement." }
  }
}
```

**边界**:kb_record 落 draft 态(人晨审 promote,现行 fr 纪律不变);retrieve 的排序/裁剪策略后续吃 Victor plugin 蒸馏的三档拉取表(026 已判可复用)。

### C4. `get_manual`(新提案,Wayne 2026-07-12 口述,待卡点 3 裁)

只读零参(或一个 `topic` 可选参),返回 Vibehub 的 agent-facing manual:系统是什么、用户在地图上看到什么、四个工具的深层语义、好公民行为准则。**description(草)**:

```
The full picture of how Vibehub works: what your user sees on their map, how your scope/reports/records surface to your team, and how to be a good citizen of a shared repo. Call when you're unsure why a Vibehub reminder appeared, or before heavy multi-session work. Reference material — don't read it up front for routine tasks.
```

定位:B1 协议保持极短,深语境外置到这个把手;与 MCP server 连接时自述(server instructions)互补——instructions 是被动喂,manual 是主动取。

---

## 块 D(已实现,不等卡点)与块 E(全卡点后)

- D:注入送达端补全(Stop/SessionStart 送达点、pause/inject 分包装、送达=claimed_at、超时读侧推导)+ 里程碑机械启发式(workbench-001 兜底档)。见 PR 代码。
- **D 修正提案(Wayne 2026-07-12 口述 + 调研,待卡点 2 裁)**:三分类(routine/milestone/ambiguous)改为**精准优先的二值判定**——只有强信号(结构 payload / 加权长度 / 显式指令形)升里程碑档,其余一律留默认档(全量档里用户 prompt 本来就都在,023 两档 toggle 已有兜底,漏判可见、误判才灌水)。调研佐证:文本 backchannel/acknowledgement 是 NLP 成熟问题(dialogue act classification,SwDA 语料),文本域 ack 接近封闭类、词表可覆盖,但**三分类的模糊中段没有现成轻量方案**——精准优先绕开整个模糊区,ambiguous 桶与薄 LLM 再裁可能都不再需要(如需,LLM 从默认档异步"捞升"而非裁模糊)。
- E:hooks wiring 进 `.claude/settings` + `vibehub init` 更新 + MCP server 实装 + 真 session 端到端实证(本 repo)。**Wayne 2026-07-12:「我们需要自己先用起来」——dogfood 是块 E 的第一目标,优先级前置。**
- **E 实证一等指标:微协议服从率**(2026-07-12 顾问 session 建议,Wayne 评估路线一致:数字降为诊断,裁决=人逐条读)。跑 N 个真实 session,逐个数 register_scope / kb_record / kb_retrieve / self_report 的调用次数与时机,人读后终裁 B 组文本候选——纸面不争完美,文本裁决权交给真 session 数据;选错候选的成本只是换文本重跑。
