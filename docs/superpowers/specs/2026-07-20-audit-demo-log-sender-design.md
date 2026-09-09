# 审计日志双场景演示发送脚本设计

日期：2026-07-20

状态：已实施并通过本地测试

## 1. 目标

提供一个零依赖 Node.js 脚本。演示人员只需运行一次命令，即可向日志审计 Agent 依次发送：

1. 一条完整、无风险的只读调用链；
2. 一条完整、可稳定触发 `high` Finding 和飞书即时告警卡片的更新调用链。

脚本必须等待审查完成并验证结果，不能只以 HTTP 请求成功作为演示成功依据。

## 2. 使用方式

默认命令：

```powershell
npm run demo:audit-logs
```

默认连接当前演示环境：

```text
http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me
```

可通过环境变量覆盖：

```powershell
$env:AUDIT_DEMO_BASE_URL = 'http://127.0.0.1:9320'
npm run demo:audit-logs
```

## 3. 两类日志

每类日志使用独立的新 `trace_id`，并生成完整的六事件链：

```text
run.start
  agent.start
    tool.start
    tool.end
  agent.end
run.final_result
```

所有非根 Span 都填写指向同一 Trace 内真实父 Span 的 `parent_span_id`。开始和结束事件复用同一个 Span ID。

每次运行从受控场景池随机选择业务内容，并使用本次 Trace 派生的独立 Agent ID、用户 ID 和实体 ID。随机化只改变演示内容，不改变风险判定约束。

### 3.1 正常日志

- Agent：每个 Trace 独立生成，例如 `audit-demo-normal-<随机标识>`
- 工具：从包含 `get`、`query`、`read`、`list`、`fetch` 的只读工具池随机选择
- 状态：`OK`
- 预期语义映射：`read`
- 预期风险结果：不产生该工具对应的 Finding，不触发飞书即时告警

### 3.2 高风险日志

- Agent：每个 Trace 独立生成，例如 `audit-demo-risk-<随机标识>`
- 工具：从名称中直接包含 `update`、`write` 或 `delete` 的高风险工具池随机选择
- 状态：`OK`
- 预期语义映射：`update`、`write` 或 `delete`
- 预期候选：`high_risk_permission`
- 预期风险结果：至少一个 `high` Finding，并触发飞书即时告警卡片

脚本仅发送审计事件，不调用真实商品接口，不修改业务数据。

为避免随机内容引入额外风险，以下字段保持受控：事件状态固定为 `OK`，工具耗时低于慢调用阈值，Span 链完整，正常批次只使用明确的只读命名，高风险批次只使用明确的写入类命名。

## 4. 时间与审查顺序

事件时间使用发送时刻之前 5 秒，避免审查窗口截止时间早于事件时间的毫秒级竞态。

执行顺序固定：

1. 记录当前最新 Review ID；
2. 发送正常批次；
3. 等待新的 Review 完成；
4. 验证正常 Trace 已入库且工具映射为 `read`；
5. 记录当前最新 Review ID；
6. 发送高风险批次；
7. 等待新的 Review 完成；
8. 验证工具映射为本次随机场景声明的 `update`、`write` 或 `delete`；
9. 验证 Review 页面包含本次随机生成的 Agent、工具和高风险 Finding；
10. 验证飞书模式为 `live`，Outbox 无 pending 和 dead-letter。

两批均使用一次 `{ "events": [...] }` 批量 POST，不做重复投递。

## 5. 验证与输出

脚本成功时输出：

- 正常 Trace ID；
- 正常 Review ID；
- 高风险 Trace ID；
- 高风险 Review ID；
- 对应 Dashboard 地址；
- 本次随机选择的场景、工具、Agent 和实体；
- 飞书模式和 Outbox 状态。

以下任一情况都以非零退出码结束：

- HTTP 请求失败；
- `accepted !== 6` 或 `rejected !== 0`；
- 等待 Review 超时；
- Trace 事件数不是 6；
- 工具映射不符合预期；
- 高风险 Review 没有目标 Agent/工具对应的高风险 Finding；
- 飞书不是 `live`；
- Outbox 出现 dead-letter，或超时后仍有 pending。

## 6. 配置

脚本支持以下环境变量：

- `AUDIT_DEMO_BASE_URL`：审计服务基地址；默认使用当前演示地址。
- `AUDIT_DEMO_TIMEOUT_MS`：单次 HTTP 请求超时；默认 20000。
- `AUDIT_DEMO_REVIEW_TIMEOUT_MS`：等待 Review 完成的总时长；默认 120000。
- `AUDIT_DEMO_POLL_INTERVAL_MS`：轮询间隔；默认 2000。

不读取或输出 Webhook、Dashboard Token 或其他 Secret。

## 7. 代码结构

单文件 `scripts/send-audit-demo-logs.js` 同时提供 CLI 和可测试的导出函数：

- 构造六事件 Trace；
- 发送批次；
- 查询 Trace；
- 轮询健康状态和 Review；
- 解析 Review 页面；
- 执行完整演示流程。

生产入口只在脚本被直接运行时调用。测试导入纯函数和流程函数，通过 mock `fetch` 验证，不访问外部网络。

## 8. 测试与提交边界

本地测试文件为 `test/send-audit-demo-logs.test.js`，覆盖：

- 正常和高风险 payload 的链路结构；
- 父子 Span 与 start/end 配对；
- 事件时间早于发送时间；
- 正常批次先于高风险批次；
- 两批均只 POST 一次；
- 高风险验证失败时返回非零结果。
- 连续构造的日志内容发生变化，但正常批次始终映射为 `read`，高风险批次始终映射为写入类高风险类型。

按用户要求，该测试文件加入 `.gitignore`，保留在本地但不进入 Git 提交。生产脚本、`package.json`、设计文档和对应 `.gitignore` 规则可提交。
