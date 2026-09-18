# 将任意 Agent 改造成可发送审计日志的 Agent

本文是一份可以直接交给编码 Agent 执行的改造手册。目标不是只增加一个 HTTP 请求，而是让目标 Agent 在真实运行时持续生成符合规范的审计事件，并能在 Audit Logger Dashboard 中看到该 Agent 的日志。

合格的接入必须同时回答三类问题：

- **发生了什么**：Agent 和工具执行了哪些操作，结果如何；
- **为什么发生**：操作对应的任务目标、决策摘要、预期影响和约束是什么；
- **如何关联**：任务、Agent、工具、用户确认、重试和最终结果之间如何形成可还原的因果链。

本文要求记录的是脱敏后的操作意图和决策摘要，不是模型的原始思维链、完整 Prompt、完整用户输入或内部推理过程。

## 1. 用户如何使用本文

1. 将本文交给负责修改目标仓库的编码 Agent。
2. 同时告诉编码 Agent 目标 Agent 的仓库位置；如果目标仓库已经是其当前工作目录，可以省略。
3. 编码 Agent 应自行检查项目结构、配置方式、启动命令、测试体系和工具调用入口，然后直接开始改造。
4. 改造完成后，编码 Agent 必须运行一次真实且无破坏性的 Agent 任务，将验证用 `trace_id`、查询结果和 Dashboard 地址交付给用户。
5. 用户或编码 Agent 必须在 Dashboard 中看到目标 `agent_id`、任务记录和最近活动时间。看不到就不算完成。

正式审计服务地址：

```text
服务基地址：https://audit.madebynight.top
日志接收地址：https://audit.madebynight.top/v1/ingest
批量读取地址：https://audit.madebynight.top/v1/audit-logs
Agent 任务入口：https://audit.madebynight.top/tasks
审计 Dashboard：https://audit.madebynight.top/dashboard
健康检查地址：https://audit.madebynight.top/health
```

生产入口统一使用上述正式 HTTPS 域名，不再使用旧的 `traefik.me` 地址；本地开发可使用 `http://127.0.0.1:9320`。接入前按阶段六检查服务健康状态。

上游 Agent 设置 `AUDIT_INGEST_URL=https://audit.madebynight.top/v1/ingest`；审计服务端在 Dokploy 中设置 `AUDIT_AGENT_DASHBOARD_BASE_URL=https://audit.madebynight.top`。两者分别用于日志上传和 Dashboard 链接生成，不要混用。

如用户提供了其他环境的地址，以用户提供的 `AUDIT_INGEST_URL` 和 Dashboard 基地址为准。

## 2. 编码 Agent 的执行指令

收到本文后，按第 4 节的流程自动完成改造。不要停留在方案说明，也不要让用户逐项指导代码位置。

开始前先读取目标仓库的现有文件、Git 状态、项目说明、配置、启动脚本和测试命令。优先复用现有日志、配置、HTTP 客户端、生命周期钩子和工具执行封装；没有合适实现时再新增独立的 `auditLogger` 模块。

只有以下信息无法从目标仓库或运行环境得到时才询问用户：

- 目标仓库无法访问；
- 不知道应使用哪个稳定的 `agent_id`，且无法从项目名称或部署配置确定；
- 用户要求使用非默认审计服务，但没有提供地址；
- 目标 Agent 必须依赖用户凭证、人工确认或外部环境才能运行真实验收任务。

不得以单元测试通过、日志文件已生成、HTTP 返回 `202`、`/v1/audit-logs` 能查到数据或 Dashboard 出现 Agent 中的任意一项单独作为完成依据。最终必须同时完成 Trace 合规验收和 Dashboard 验收。

## 3. 完成定义

以下条件必须全部满足：

1. 目标 Agent 有稳定且统一的 `agent_id`。
2. 每个事件符合第 5 节的字段契约，新改造同时遵守第 5.3 节的条件必填规则。
3. 一次真实请求、消息处理或自治任务使用同一个 `trace_id`；委派给子 Agent 时继续传播该 `trace_id`。
4. 每个任务必须记录 `run.start` 和 `run.final_result`/`run.failed`，不能因为项目原来没有 Run 抽象而省略。
5. Agent 生命周期必须记录 `agent.start` 和 `agent.end`/`agent.error`。
6. 实际工具调用记录 `tool.start` 和 `tool.end`/`tool.error`；若提供 `span_id`，开始和结束复用同一个值。
7. `span_id` 和 `parent_span_id` 均可选，不提供时按 Trace 审计，不生成虚构 Span。提供时使用非空字符串，调用关联应能还原真实关系。
8. `agent.start` 和 `tool.start` 必须记录脱敏后的操作意图；高风险工具还必须记录用户确认或策略授权的关联信息。
9. 等待用户时记录 `run.waiting_user`，恢复时记录 `run.resume`；两个事件必须通过同一决策标识关联。
10. 业务重试若使用 Span，应创建新的 `span_id` 并关联原调用；HTTP 投递重试必须重发完全相同的原始 payload，不能混淆两类重试。
11. 事件先追加到目标 Agent 自己的本地 NDJSON 文件，再异步发送相同 payload 到 `/v1/ingest`。
12. 发送端解析 `accepted`、`rejected` 和 `errors`；没有被服务端确认的事件进入本地重试队列。
13. 审计发送失败不会改变目标 Agent 原有业务结果，也不会长时间阻塞用户请求。
14. 自动化测试覆盖事件构造、链路完整性、意图字段、用户确认、业务重试、成功发送、拒收处理、网络失败和重试回放。
15. 使用真实目标 Agent 完成一次无破坏性的调用，并通过 `/v1/audit-logs?agent_id=...&trace_id=...` 查到完整事件链和意图摘要。
16. 至少使用一个失败、等待确认或重试场景验证非成功链路；不能只验收单工具成功路径。
17. 任务工作台已显示目标 `agent_id`、任务记录和最近活动时间。
18. 编码 Agent 能直接查看 Dashboard 时，由编码 Agent 完成可见性检查；无法查看时，必须把具体网址和验证信息交给用户，并等待用户确认后才能宣称完成。

## 4. 自动改造流程

### 阶段一：审计目标 Agent

检查并记录：

- 稳定的项目或服务标识，用作 `agent_id`；
- HTTP、消息、CLI、定时任务等请求或任务入口；
- Agent 主循环、规划器或任务执行器的开始、成功和异常出口；
- Agent 形成任务目标、计划摘要和下一步动作的位置；
- 所有工具执行的统一封装点，以及绕过统一封装的特殊调用；
- 用户确认、策略授权、暂停、恢复、业务重试和子 Agent 委派的位置；
- 配置加载方式、持久化目录、现有 HTTP 客户端和进程退出钩子；
- 项目已有测试命令和可安全执行的真实验证任务。

优先在统一入口埋点，不要在大量业务函数中重复拼装日志。如果目标 Agent 没有统一工具执行层，先建立最小封装，再让工具调用经过该封装。

阶段产物：一份简短的改造映射，明确以下节点分别位于哪些文件，并指出无法经过统一封装的例外：

```text
请求/任务入口
  → Run 创建
  → Agent 目标与计划摘要
  → 工具调用
  → 用户确认或策略授权
  → 暂停/恢复/业务重试
  → 子 Agent 委派
  → 最终结果或失败出口
```

### 阶段二：实现审计日志模块

新增或统一一个职责集中的 `auditLogger`。名称可以遵循目标项目现有风格，但至少提供以下能力：

| 能力 | 必须行为 |
| --- | --- |
| 配置读取 | 读取 ingest URL、超时、本地日志目录、是否启用重试和单次回放上限 |
| 事件构造 | 生成必填字段，规范化状态码、事件名和可选字段 |
| Trace 上下文 | 生成并传播 `trace_id`、Run/Agent/Tool Span 和父子关系 |
| 意图摘要 | 生成脱敏的任务目标、决策摘要、预期影响和约束，不记录原始思维链 |
| 本地记录 | 追加写入 `audit-YYYY-MM-DD.jsonl`，每行一个完整 JSON 对象 |
| 异步发送 | 将刚落盘的同一 payload 非阻塞地 `POST` 到 `/v1/ingest` |
| 响应确认 | 解析 `accepted`、`rejected`、`errors`，不能把任意 2xx 直接视为全部成功 |
| 失败队列 | 保存网络错误、超时、非 2xx 和服务端拒收的未确认事件 |
| 有限回放 | 每次只处理有限数量，成功后移除，失败时保留原始 payload |
| `flush` | 在任务收尾或进程退出阶段等待已经发起的发送任务，不改变业务结果 |
| 本地合规检查 | 在测试和真实验收时检查必需节点、Span 配对、父子关系和条件必填字段 |

建议配置语义：

| 配置 | 推荐默认值 | 说明 |
| --- | --- | --- |
| `AUDIT_INGEST_URL` | 当前部署的 `/v1/ingest` 地址 | 必须是完整接收地址，不是服务基地址 |
| `AUDIT_INGEST_TIMEOUT_MS` | `1500` | 解析为有限正整数 |
| `AUDIT_RETRY_ENABLED` | `true` | 控制失败队列回放 |
| `AUDIT_RETRY_MAX_BATCH` | `50` | 单次最多回放的事件数 |
| `<AGENT>_AUDIT_LOG_DIR` | Agent 自己的持久目录 | 保存原始 NDJSON 和重试队列 |

已有项目可以保留自己的配置名，但语义必须一致。URL 为空时可以关闭远程发送，本地审计日志仍应保留。

默认按单事件发送，响应归属最清楚。只有目标项目已经有可靠批处理基础设施时才使用批量发送。

正确顺序：

```text
构造并校验事件
  → 追加写入本地 NDJSON
  → 异步发送同一 payload
  → 解析服务端确认结果
  → 未确认则写入重试队列
```

### 阶段三：接入 Agent 生命周期

一次用户请求、消息处理或自治任务只生成一个 `trace_id`。在整个调用链中显式传递它，不要让每个工具自行生成新的 Trace。委派给子 Agent 时继续传播同一 `trace_id`，若使用 Span，可让子 Agent 的 `agent.start` 指向触发委派的父 Span。

典型完整链路（图中的 Span 为可选关联信息，不是接收必填项）：

```text
run.start                 trace_id=req-100, span_id=run-1, tool_name=agent.run
  agent.start             span_id=agent-1, parent_span_id=run-1, 含目标与计划摘要
    tool.start             span_id=tool-1, parent_span_id=agent-1, 含调用原因与预期影响
    tool.end               span_id=tool-1, parent_span_id=agent-1, 含实际结果与耗时
  agent.end               span_id=agent-1, parent_span_id=run-1
run.final_result          span_id=run-1, 含目标是否达成和未完成项
```

Run 事件使用稳定的运行组件名，例如 `agent.run`；Agent 事件使用稳定的生命周期组件名，例如 `agent.lifecycle`。这些名称用于满足当前服务端统一字段契约，不代表一次真实工具调用。工具语义映射验收只检查 `tool.*` 事件，不要求 Run 和 Agent 生命周期事件映射为工具类型。

提供 Span 时，同一层级的关联规则：

- `run.start` 与 `run.final_result`/`run.failed` 复用 Run Span；
- `agent.start` 与 `agent.end`/`agent.error` 复用 Agent Span；
- `tool.start` 与 `tool.end`/`tool.error` 复用工具 Span；
- 根 Run 不填写 `parent_span_id`；Agent、工具和子 Agent 可填写真实的父 Span；
- 开始事件的 `result_summary` 描述“准备做什么”，终止事件描述“实际发生了什么”；
- 一个 Span 只能有一个终止事件，不能同时出现 `.end` 和 `.error`。

异常路径必须使用 `try/catch/finally` 或目标语言的等价机制补齐结束事件：

- 成功：`tool.start` → `tool.end`，状态为 `OK`；
- 失败：`tool.start` → `tool.error`，状态使用最接近的 canonical code；
- Agent 成功：`agent.start` → `agent.end`；
- Agent 失败：`agent.start` → `agent.error`。

结束事件填写非负的 `duration_ms`。若提供 Span，同一个调用的开始和结束复用同一个 `span_id`。

等待用户确认时：

```text
tool.end: preview         记录预览摘要和 subject_hash
run.waiting_user          记录 decision.id、待确认内容和 subject_hash
run.resume                记录相同 decision.id、用户选择和已脱敏的 actor_id
tool.start: execute       记录 authorization_ref 和相同 subject_hash
tool.end: verify          记录实际结果和验证结论
```

执行前发现待执行对象、参数或 `subject_hash` 已变化时，旧确认立即失效，必须重新生成预览并请求确认。

### 阶段四：接入工具调用

优先修改工具注册器、调度器、执行器或统一 middleware，使所有工具自动获得审计日志。只有无法经过统一层的调用才单独埋点。

工具名必须稳定，并能表达真实操作语义。推荐使用 `domain.resource.action`：

```text
catalog.product.get
order.note.create
rental.price.update
inventory.item.delete
service.deploy
shell.exec
browser.page.click
db.query
file.write
notification.send
llm.responses.create
```

不要使用随机值、自然语言、动态 URL、用户输入或 `run`、`handler`、`process`、`doTask` 之类无法判断行为的名称。

写入、删除、部署、权限、凭证等需要确认或结果核验的操作，应根据目标 Agent 的真实流程拆成稳定步骤，例如：

```text
catalog.update.preview
run.waiting_user
catalog.update.execute
catalog.update.verify
```

以上步骤不是仅用于展示的命名示例。只要真实流程存在预览、确认、执行或验证阶段，就必须分别记录，并通过 `decision.id`、`authorization_ref` 和 `subject_hash` 证明批准内容与实际执行内容一致。

业务重试与投递重试必须区分：

- **业务重试**：工具再次执行；若使用 Span，则使用新的 `span_id`，增加 `attempt.number`，并通过 `attempt.retry_of_span_id` 指向上一尝试；
- **投递重试**：工具没有再次执行，只是重新发送同一审计事件，必须复用完全相同的原始 payload。

不要为了日志而虚构目标 Agent 实际不存在的业务阶段，但不得因为现有代码缺少统一封装而省略真实发生的确认、重试、委派或验证节点。

### 阶段五：补充测试

遵循目标项目现有测试体系，至少验证：

1. 最小事件包含全部必填字段并通过本地校验。
2. Run、Agent 和工具的事件使用同一 `trace_id`；若提供 Span，开始与终止事件复用对应 `span_id`。
3. 若提供 `parent_span_id`，检查其是否指向真实父调用；未提供时不执行父子关联验收。
4. `agent.start` 和 `tool.start` 包含符合第 5.3 节语义的意图摘要。
5. 一个 Span 只能存在一个终止事件，且终止事件时间不早于开始事件。
6. 成功响应必须满足 `accepted === 1` 且 `rejected === 0`；不能只检查 HTTP 状态。
7. `202` 但 `rejected > 0` 时，事件进入失败队列或隔离区。
8. 网络错误、超时和非 2xx 不影响原业务调用结果。
9. 投递重试使用原始 payload，不重新生成时间和链路 ID。
10. 业务重试与投递重试分开；若使用 Span，业务重试使用新 Span，并关联原调用。
11. 用户批准、拒绝、确认内容变化和恢复执行分别有测试；批准对象变化时不得继续执行。
12. 子 Agent 继续使用父任务的 `trace_id`，且子 Agent Span 能关联到委派 Span。
13. 回放成功后队列记录被移除；重复发送不会在服务端形成重复数据库事件。
14. 目标 Agent 原有测试继续通过。

真实验收前至少准备以下 Golden Trace 中与目标 Agent 能力匹配的场景：

- 单工具成功；
- 工具失败；
- 多工具串行或并行；
- 等待用户后批准或拒绝；
- 业务重试后成功或最终失败；
- 进程重启后恢复；
- 子 Agent 委派；
- 审计服务不可达后回放。

### 阶段六：真实发送、Trace 与 Dashboard 验收

先检查服务：

```powershell
$auditBaseUrl = 'https://audit.madebynight.top'
$agentId = '<目标 Agent 的实际 agent_id>'
$env:AUDIT_INGEST_URL = "$auditBaseUrl/v1/ingest"

Invoke-RestMethod -Uri "$auditBaseUrl/health"
```

然后运行目标 Agent 自己的真实启动或测试入口，执行一次无破坏性的工具调用，例如读取、查询、列表或 dry-run。不得只用手写 HTTP 示例代替目标 Agent 的真实调用。

记录本次调用生成的 `trace_id`，查询完整链路：

```powershell
$traceId = '<真实调用生成的 trace_id>'
# 在 Dashboard 右上角 API Token 侧边栏申请，将 Token 放入当前客户端的 AUDIT_READ_TOKEN 环境变量。
$queryUrl = "$auditBaseUrl/v1/audit-logs?agent_id=$([uri]::EscapeDataString($agentId))&trace_id=$([uri]::EscapeDataString($traceId))"
$result = Invoke-RestMethod -Uri $queryUrl -Headers @{ Authorization = "Bearer $env:AUDIT_READ_TOKEN" }
$result.traces | ForEach-Object { $_.events } | Format-Table ts, agent_id, event, tool_name, status, trace_id, span_id, parent_span_id, duration_ms
```

查询结果必须满足：

- `count` 大于 0；
- 所有记录的 `agent_id` 都是目标 Agent 的稳定 ID；
- 存在 `run.start` 和 `run.final_result`/`run.failed`；
- 存在 `agent.start` 和 `agent.end`/`agent.error`；
- 同一工具存在 `tool.start` 和 `tool.end`/`tool.error`；
- 事件使用相同的 `trace_id`；若提供 Span，则配对事件使用相同的 `span_id`；
- 若提供 `parent_span_id`，它指向真实的父调用；
- `agent.start` 和 `tool.start` 能看到脱敏后的目标、决策摘要或预期影响；
- 同一 Span 没有同时出现 `.end` 和 `.error`；
- 等待/恢复、批准/执行和业务重试场景具有可解析的关联标识；
- 结束事件有合理的 `duration_ms`；
- `event` 不是 `unknown`；
- 对 `tool.*` 事件，等待异步映射完成后 `mapping_status` 不应为 `unknown`；如果为 `unknown`，修改 `tool_name` 后重新验证。

当前服务端已经结构化保存 `llm_intent`，但第 5.3 节的部分链路增强字段在服务端改造完成前只保存在 `raw_json`。验收时必须检查 `raw_json`，不能因为 Dashboard 暂未展示就省略发送。

最后打开 Dashboard：

```text
Agent 任务入口：https://audit.madebynight.top/tasks
目标 Agent 审计视图：https://audit.madebynight.top/tasks?agent_id=<URL 编码后的 agent_id>
```

在 Agent 日志入口确认：

- 页面出现目标 `agent_id`；
- 任务工作台出现该任务，发起人、请求和预期目的与输入一致；
- “最近活动”与刚才的真实调用一致；任务已收到终止事件或超时封存，等待调度审计后检查结果。

编码 Agent 有浏览器能力时必须自行打开并检查页面。没有浏览器能力时，在交付说明中给出以上两个可点击地址、实际 `agent_id`、验证 `trace_id` 和查询结果摘要，并明确要求用户打开确认。用户尚未确认时，状态应写成“代码改造与接口验证完成，等待 Dashboard 人工确认”，不能写“改造全部完成”。

如果 Dashboard 看不到目标 Agent，依次检查：

1. `AUDIT_INGEST_URL` 是否为完整的 `/v1/ingest` 地址；
2. ingest 响应是否真的满足 `accepted > 0` 且 `rejected === 0`；
3. `/v1/audit-logs?agent_id=...&trace_id=...` 是否能查到事件；
4. 查询结果中的 `agent_id` 是否与预期完全一致；
5. Dashboard 是否打开了同一个审计服务环境；
6. 修复后重新运行真实调用，直到 Dashboard 可见。

## 5. 日志字段契约

### 5.1 最小可接收事件

```json
{
  "ts": "2026-07-17T08:30:00.000Z",
  "agent_id": "catalog-agent",
  "trace_id": "request-8ecb",
  "event": "tool.start",
  "tool_name": "catalog.product.get",
  "status": "OK",
  "result_summary": "准备读取商品摘要",
  "llm_intent": {
    "input": "任务目标：确认商品 761 的当前状态",
    "output": "下一步动作：读取商品状态与库存摘要，不执行写入"
  }
}
```

以下七个字段是服务端必填字段，缺少或为空会拒收该事件：

| 字段 | 规范 | 改造要求 |
| --- | --- | --- |
| `ts` | 可解析的 ISO 8601 时间 | 首次构造后固定；重试不得改写 |
| `agent_id` | 稳定字符串；只使用字母、数字、`.`, `_`, `-` | 不能是 `.`、`..`，不能包含 `..`、斜杠或路径片段 |
| `trace_id` | 非空字符串 | 同一次请求或任务全链路保持一致 |
| `event` | 字符串 | 使用第 5.4 节的 canonical 事件名 |
| `tool_name` | 稳定工具或运行组件名 | 使用能表达语义的点号命名，不包含动态数据 |
| `status` | canonical 状态码 | 必须使用第 5.5 节列出的全大写值 |
| `result_summary` | 不超过 200 字符的短文本 | 开始事件写准备执行的动作，终止事件写实际结果 |

这七个字段是 HTTP ingest 的统一基础字段，因此 Run 和 Agent 生命周期事件也必须填写。生命周期事件使用稳定的运行组件名作为 `tool_name`，例如 `agent.run`、`agent.lifecycle`；不要留空或临时生成。

### 5.2 通用可选字段

```json
{
  "parent_span_id": "agent-5fd2",
  "duration_ms": 86,
  "channel": "http",
  "user_id": "u_123",
  "entity": { "type": "product", "id": "761" },
  "llm_intent": {
    "input": "查询商品 761 的当前状态",
    "output": "返回商品状态与库存摘要"
  },
  "error": {
    "message": "当前用户没有商品编辑权限"
  },
  "tags": ["read", "confirmed"]
}
```

| 字段 | 规范 |
| --- | --- |
| `span_id` | 可选非空字符串；标识一次调用，开始和结束复用，没有时省略或填 null |
| `parent_span_id` | 可选非空字符串；关联真实父调用，没有时省略或填 null |
| `duration_ms` | 非负毫秒数；填写在 `.end` 或 `.error` 事件 |
| `channel` | 来源渠道，例如 `http`、`cli`、`feishu` |
| `user_id` | 稳定且已脱敏的用户标识；自治任务可省略 |
| `entity` | 对象；必须同时包含非空字符串 `type` 和 `id` |
| `llm_intent` | 对象；存在时必须同时包含字符串 `input` 和 `output`，具体语义见第 5.3 节 |
| `error.message` | 失败原因的简短文本；失败类别由 `status` 表示 |
| `tags` | 字符串数组；只使用稳定、可查询的标签 |

### 5.2.1 V1.1 任务级字段

为支持按完整 Trace 审计，事件规范新增以下结构化字段：

| 字段 | 类型与要求 | 事件归属 |
| --- | --- | --- |
| `requester_id` | string，1—128 字符；稳定且不可逆脱敏的用户标识 | `run.start` 必填；同一 Trace 后续事件可继承或重复携带 |
| `original_request` | string，1—2000 字符；脱敏后的用户原始请求摘要或正文 | `run.start` 必填 |
| `expected_purpose` | string，1—1000 字符；Agent 预期目的，不以 original_request 顶替 | `run.start` 必填 |
| `agent_result` | string，1—2000 字符；Agent 最终执行结果或失败摘要 | `run.final_result`、`run.failed` 必填；失败事件填写失败原因 |

当前只有一套严格校验规则，不再提供 compat/strict 模式开关。HTTP 上传与本地 NDJSON 导入使用相同契约；旧的 `AUDIT_INGEST_STRICT_MODE`、`ingest.defaultMode`、`agents[agentId].ingestMode` 均不能降低校验要求。

`run.start` 缺少发起人、原始请求或 Agent 预期目的，以及终止事件缺少最终结果时，HTTP 返回 400 `missing_required_task_field`。必填文本不能是空白。四个任务字段的类型、长度和脱敏校验始终生效，命中未脱敏手机号、邮箱或身份证号模式时返回 400 `redaction_required`。这是检测并拒收，不是自动脱敏。

四个任务字段不要求每条工具事件重复携带。服务端按 `(agent_id, trace_id)` 聚合；未提供的 Span 保存为 NULL，不补造 ID。缺少 Span 时仍可审计任务结果，但不能可靠配对并发调用或推断父子关系，也不会仅因缺少 Span 判定链路中断。工具调用次数以明确的 `tool.start` 为依据，不把其结束事件再次计数。已有历史数据不重新执行接入校验，不猜测补齐字段；重新上传的旧格式事件仍须满足新规则。

成功任务最小生命周期示例（同一任务共享 Trace 和根 Span）：

```json
{
  "events": [
    {
      "ts": "2026-09-16T08:30:00.000Z", "agent_id": "catalog-agent",
      "trace_id": "request-8ecb", "span_id": "run-1", "event": "run.start",
      "tool_name": "agent.run", "status": "OK", "result_summary": "开始查询商品状态",
      "requester_id": "user_7f3a", "original_request": "查询商品 761 的当前状态",
      "expected_purpose": "读取商品状态并整理查询结果，不修改数据"
    },
    {
      "ts": "2026-09-16T08:30:01.000Z", "agent_id": "catalog-agent",
      "trace_id": "request-8ecb", "span_id": "run-1", "event": "run.final_result",
      "tool_name": "agent.run", "status": "OK", "result_summary": "已返回商品状态",
      "agent_result": "商品 761 当前可售；已返回查询结果，未修改业务数据"
    }
  ]
}
```

失败时发送 `run.failed`，并明确失败原因：

```json
{
  "ts": "2026-09-16T08:30:01.000Z", "agent_id": "catalog-agent",
  "trace_id": "request-failed", "span_id": "run-2", "event": "run.failed",
  "tool_name": "agent.run", "status": "UNAVAILABLE", "result_summary": "查询失败",
  "agent_result": "商品服务不可用，未能完成查询，未修改业务数据"
}
```

`result_summary` 仍限 200 字符，不与 `agent_result` 共用长度限制。以上示例只说明任务字段，真实任务仍须发送 Agent 和工具事件。

字段迁移规则：

- 旧 `product_id` 改为 `entity: { "type": "product", "id": "..." }`；服务端会拒收带 `product_id` 的事件。
- 不发送 `error.code`；服务端会拒收。错误类别放在 `status`，详细原因放在 `error.message`。
- 顶层 `error_code` 不属于当前规范。当前服务端未将它列为显式拒收字段，但新改造不得继续使用。
- 不发送 API Key、Cookie、Token、Authorization、密码、完整请求体、完整响应体、HTML、截图原文或未脱敏个人信息。

服务端默认限制单请求最大 1 MiB，单事件或 NDJSON 单行最大 64 KiB。事件过大时应缩短摘要或只保留稳定实体 ID，不能截断 JSON。

### 5.3 条件必填与链路增强字段

HTTP ingest 的七个基础字段只保证“事件可接收”，不能保证“链路可复盘”。新改造还必须按事件类型满足以下条件：

| 事件或场景 | 条件必填内容 |
| --- | --- |
| `run.start` | `requester_id`、`original_request`、`expected_purpose`；缺少任一字段拒收 |
| `agent.start` | 可选 `parent_span_id`；`llm_intent.input` 写目标与约束，`output` 写计划或下一步动作摘要 |
| `tool.start` | 可选 `parent_span_id`；`llm_intent.input` 写触发上下文摘要，`output` 写调用原因和预期影响 |
| `tool.end`/`tool.error` | `duration_ms`；实际结果或失败摘要 |
| `run.final_result` | `agent_result`；任务成功结果摘要 |
| `run.failed` | `agent_result`；任务失败原因摘要 |
| `run.waiting_user` | 决策标识、待确认摘要、确认对象摘要或哈希 |
| `run.resume` | 相同决策标识、用户选择和已脱敏的决定人标识 |
| 高风险执行 | 授权引用和与预览一致的确认对象摘要或哈希 |
| 业务重试 | 记录尝试次数；若使用 Span，提供新 `span_id` 和上一尝试 Span |
| 子 Agent | 传播相同 `trace_id`；若使用 Span，可通过父级关联委派。注意：服务端按 `(agent_id, trace_id)` 分别聚合，不同 Agent 不会合并为一个任务 |

`llm_intent` 的字段语义固定为：

- `input`：触发当前 Agent 或工具动作的任务目标、上下文和约束摘要；
- `output`：Agent 选择的下一步动作、调用原因和预期影响摘要。

禁止在 `llm_intent` 中写入原始思维链、完整 Prompt、完整会话、密钥、Cookie、Token 或未脱敏个人信息。摘要必须让审计人员理解决策目的，但不能泄露模型内部推理或敏感上下文。

为支持确定性关联，新改造还应发送以下增强字段：

```json
{
  "schema_version": 2,
  "producer_event_id": "evt-01J0...",
  "decision": {
    "id": "decision-42",
    "state": "approved",
    "actor_id": "user-7f3a",
    "subject_hash": "sha256:...",
    "summary": "批准将商品 761 状态更新为 active"
  },
  "authorization_ref": "decision-42",
  "attempt": {
    "number": 2,
    "retry_of_span_id": "tool-attempt-1"
  }
}
```

字段规则：

- `schema_version`：新改造固定发送整数 `2`；现有未携带版本的事件按兼容 V1 处理；
- `producer_event_id`：生产者在事件首次构造时生成的稳定唯一 ID，投递重试不得改变；该名称用于避免与服务端数据库整数事件 ID 混淆；
- `decision.id`：一次用户确认或策略决定的稳定 ID；
- `decision.state`：使用 `requested`、`approved`、`rejected`、`expired`；
- `decision.actor_id`：已脱敏的用户、服务或策略标识；
- `decision.subject_hash`：对规范化后的确认对象计算的摘要，用于防止批准后执行内容变化；
- `authorization_ref`：执行事件引用的 `decision.id`；
- `attempt.number`：同一业务动作从 `1` 开始递增；
- `attempt.retry_of_span_id`：业务重试指向上一尝试的 Span。

当前服务端会把上述增强字段保留在 `raw_json`，但尚未全部结构化为独立数据库列或 Dashboard 字段。目标 Agent 仍应发送这些字段；服务端结构化、自动校验和可视化属于后续实施计划。

### 5.4 canonical 事件名

目标 Agent 使用以下事件：

```text
tool.start   tool.end   tool.error
agent.start  agent.end  agent.error
run.start    run.resume run.waiting_user run.final_result run.failed
```

服务端兼容部分使用 `/`、`_`、`-` 分隔的历史别名，但新改造必须发送上面的点号形式。无法识别的事件虽然可能被接收，但数据库中的 `event` 会变成 `unknown`，验收不通过。

### 5.5 canonical 状态码

`status` 必须是以下值之一：

```text
OK CANCELLED UNKNOWN INVALID_ARGUMENT DEADLINE_EXCEEDED NOT_FOUND
ALREADY_EXISTS PERMISSION_DENIED RESOURCE_EXHAUSTED FAILED_PRECONDITION
ABORTED OUT_OF_RANGE UNIMPLEMENTED INTERNAL UNAVAILABLE DATA_LOSS UNAUTHENTICATED
```

常用映射：

| 场景 | 状态 |
| --- | --- |
| 成功完成 | `OK` |
| 用户取消或拒绝确认 | `CANCELLED` |
| 参数错误 | `INVALID_ARGUMENT` |
| 目标不存在 | `NOT_FOUND` |
| 前置条件不成立 | `FAILED_PRECONDITION` |
| 权限不足 | `PERMISSION_DENIED` |
| 远端服务不可达 | `UNAVAILABLE` |
| 调用超时 | `DEADLINE_EXCEEDED` |
| 未分类内部异常 | `INTERNAL` |

不要直接发送 `ok`、`success`、`failed`、`error` 等业务状态。应在事件构造器中统一映射为 canonical code。

### 5.6 `tool_name` 语义要求

审计服务会异步生成 `mapped_tool_type` 和 `mapping_status`。工具名应能稳定映射到以下语义之一：

```text
read write update delete deploy permission credential shell browser
network database file notification llm
```

常用动词：

| 语义 | 推荐词 |
| --- | --- |
| 读取 | `read`、`query`、`search`、`get`、`list`、`fetch` |
| 创建/写入 | `write`、`create`、`insert`、`save`、`append` |
| 更新 | `update`、`patch`、`modify`、`edit`、`set` |
| 删除 | `delete`、`remove`、`destroy`、`drop`、`truncate` |
| 部署 | `deploy`、`release`、`publish`、`rollout` |
| 权限 | `permission`、`role`、`policy`、`grant`、`revoke` |
| 凭证 | `credential`、`secret`、`token`、`api_key`、`password` |

如果 `mapping_status` 最终为 `unknown`，修改 `tool_name` 使其表达真实动作，然后重新运行真实验收。不要通过修改 `result_summary` 规避。

## 6. HTTP 发送与重试契约

### 6.1 请求形式

| 形式 | `Content-Type` | 请求体 |
| --- | --- | --- |
| 单事件 | `application/json` | 一个事件对象 |
| 批量事件 | `application/json` | `{ "events": [ ... ] }` |
| NDJSON | `application/x-ndjson` | 每行一个事件对象 |

### 6.2 响应处理

成功接收单事件的响应：

```json
{
  "accepted": 1,
  "rejected": 0,
  "errors": []
}
```

`202` 只表示请求已处理，不表示批次全部成功：

1. 网络错误或超时导致没有可解析响应时，本次事件未确认，进入重试队列。
2. 单事件只有 `accepted === 1` 且 `rejected === 0` 才算确认。
3. 批次可能部分接收；即使返回 400 或 413，只要响应含 `accepted`、`rejected` 和 `errors[].index`，也要保留拒收行、移除已确认行，不重发整批。
4. `400` 包括 JSON 格式、字段类型、长度、任务必填字段缺失或脱敏命中；`413 payload_too_large` 包括请求超过 1 MiB 或单行超过 64 KiB；`415` 表示 Content-Type 错误。修复后再发送，不能无限快速重试。
5. 请求体整体超限会在解析前拒绝整批；单行超限会继续检查其他行，返回完整拒收索引。

### 6.3 回放与去重

- 投递重试必须使用首次生成并保存的原始 payload，不重新生成 `producer_event_id`、`ts`、`trace_id`、`span_id` 或业务字段。
- 每轮最多回放配置的 `AUDIT_RETRY_MAX_BATCH` 条。
- 服务端按原始事件 JSON 的哈希去重。相同 payload 重发不会重复入库；重试时改变字段会被视为新事件。
- 本地 `audit-YYYY-MM-DD.jsonl` 是原始审计记录，失败队列只保存尚未确认的待发送事件。

### 6.4 发送器边界和信任说明

目标 Agent 的发送器必须使用有界资源：限制后台发送并发、单次回放数量和退出时 `flush` 的最长等待时间。失败队列达到目标 Agent 设定的容量或磁盘阈值时，必须产生可观察的告警，不能静默删除旧事件或无限占用磁盘。

当前默认 `/v1/ingest` 地址没有内建生产者认证。未经过受控网络、网关认证、签名或等价来源校验时，Dashboard 中的 `agent_id` 和意图只能视为生产者声明，不能作为不可抵赖的安全证据。生产环境在声明“可信审计”前必须补齐生产者身份校验；该服务端改造不要求目标 Agent 在业务调用点自行发明认证头。

## 7. Trace 合规验收

编码 Agent 必须提供自动化或可重复执行的本地 Trace 合规检查。检查器输入一组事件或一个 `trace_id`，至少输出：

- Run、Agent、工具和最终结果节点是否齐全；
- Span 是否正确配对，是否存在重复或冲突终止事件；
- 非根 Span 的父 Span 是否存在；
- 开始事件是否包含规定的操作意图；
- 等待与恢复、批准与执行、业务重试是否能通过稳定 ID 关联；
- 结束事件是否包含合理耗时和结果；
- 是否存在未知事件、未知状态或工具语义映射失败；
- 是否存在疑似敏感信息、过长摘要或原始思维链内容。

合规结果必须明确输出 `PASS` 或 `FAIL` 和具体缺失项。只检查事件数量、HTTP `202`、Dashboard 可见性或某一对 `tool.start/tool.end`，都不能替代 Trace 合规验收。

当前服务端尚未提供统一合规端点时，可以在目标 Agent 的测试代码或验证脚本中实现该检查；后续服务端计划会提供统一校验和 Dashboard 展示。

## 8. 编码 Agent 的交付报告

完成后按以下格式交付：

```text
改造文件：<实际文件列表>
agent_id：<实际稳定 ID>
ingest URL：<实际地址>
本地日志目录：<实际目录>
埋点范围：<Run、Agent、工具、确认、重试、子 Agent 和结束出口>
测试命令与结果：<命令、通过数量或失败说明>
真实验证任务：<执行了什么无破坏性调用>
验证 trace_id：<实际 trace_id>
查询结果：<事件数量、完整的 Run/Agent/Tool/结果链路和意图摘要>
Trace 合规结果：<PASS / FAIL、检查器命令、缺失项>
确认与重试验证：<不适用 / 已验证的场景和关联 ID>
Agent 日志入口：<可点击 URL>
目标 Agent Dashboard：<带 agent_id 的可点击 URL>
Dashboard 结果：<已由编码 Agent 确认 / 等待用户确认>
信任边界：<受控网络 / 网关认证 / 签名 / 当前仅为生产者声明>
未完成项：<没有则写“无”>
```

只有 `Trace 合规结果` 为 `PASS`、`Dashboard 结果` 已确认且“未完成项”为“无”时，才能声明目标 Agent 已完成日志接入改造。未完成生产者认证时，可以声明“日志接入与链路验收完成”，不能声明日志具备不可抵赖性。
