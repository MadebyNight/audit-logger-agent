# Audit Logger Agent

跨 Agent 的审计日志服务。它接收其他 Agent 主动上报的审计事件，保存原始证据并写入 SQLite，提供查询、报表、周期审查、风险 Finding 和 Dashboard。

服务面向需要追踪 Agent 行为、排查任务链路和查看异常操作的人。它不会扫描其他容器的日志目录；上游 Agent 通过 HTTPS 主动发送事件（本地开发允许 HTTP）。

## 能力

- 接收 JSON 或 NDJSON 审计事件，并保存到 SQLite 与服务端 spool。
- 按 Agent、链路、工具、状态、时间和业务实体查询事件。
- 生成日报、错误报表和工具使用统计。
- 周期审查异常、慢调用、高风险工具和不完整链路，生成 Finding。
- 通过 Dashboard 查看审查批次、Finding 与关联证据。
- 将 high 风险按完整 Trace 发送一次飞书卡片，并在北京时间 10:00、17:00 生成累计日报。

日报调度以 `Asia/Shanghai` 为业务时区。服务器或容器显示的 UTC 时间会比北京时间少 8 小时，这是同一时刻的时区显示差，不是服务器时钟错误；不要给时间戳手工加 8 小时、修改容器时钟或依赖 `TZ` 修正调度。程序直接换算北京时间时段，宿主机只需通过 NTP/chrony 保持系统时钟准确。

10:00、17:00 按独立键持久化日报时段。服务在时点后 30 分钟内启动或恢复时会补发最近一个未执行时段；超过窗口则把最近错过时段记录为 `skipped_late`，不发送已失去时效的日报。若停机跨过多个累计时段，只协调最新时段，因为较晚日报已覆盖当天更早数据，不为更早时段补写记录。时段 claim 和 Outbox 去重共同防止重启或并发触发造成重复入队；日报使用高优先级和原子 Outbox claim，避免普通消息积压长期阻塞规定时点的飞书通知。

## 本地启动

需要 Node.js 20+、可写的项目目录和 OpenAI-compatible LLM 配置。创建未纳入 Git 的 `.config`：

```json
{
  "AUDIT_AGENT_LLM_API_KEY": "<api-key>",
  "AUDIT_AGENT_LLM_MODEL": "<model-name>",
  "AUDIT_AGENT_LLM_TIMEOUT_MS": "900000",
  "AUDIT_AGENT_LLM_MAX_OUTPUT_TOKENS": "1200",
  "AUDIT_AGENT_LLM_REASONING_EFFORT": "low"
}
```

Dashboard 页面可直接访问，不需要登录。`AUDIT_AGENT_DASHBOARD_TOKEN` 只从进程环境变量读取，用于 `/v1/audit-*` API 的 Bearer 鉴权；如需调用这些 API，请使用高熵随机值，不要复用 LLM API Key。

然后执行：

```powershell
npm install
npm run server -- --port 9320
Invoke-RestMethod -Uri 'http://127.0.0.1:9320/health'
```

默认监听 `127.0.0.1:9320`。`/health` 返回正常状态且数据库可写，即表示服务可用。健康状态还可用于核对飞书运行模式、业务时区、10:00/17:00 计划、下一次运行、最近时段状态、`trigger_type`（准点或补发）、对应时段的入队/送达时间和投递延迟；读取调度状态失败时 `status_error` 为 `true`。它不会返回 Webhook、确认口令、Token 或其他 Secret。

## Dokploy 生产入口

生产复用 Dokploy/Traefik 终止 TLS，容器内部保持 HTTP `:9320`。部署后将实际正式域名设置为 `AUDIT_AGENT_DASHBOARD_BASE_URL=https://<正式域名>`；本仓库不声明示例地址已经上线。

| 入口 | 地址 |
| --- | --- |
| Dashboard | `https://<正式域名>/dashboard` |
| 批量读取 | `https://<正式域名>/v1/audit-logs`（Bearer Token） |
| Agent 日志发送 | `https://<受控写入域名>/v1/ingest` |
| 容器健康检查 | `http://127.0.0.1:9320/health` |

默认不公开无认证 ingest 和开发用 `/query`；跨网络写入先配置 Traefik 鉴权或受控内网 HTTPS 路由。容器 `requireHttpsBaseUrl=true`，未设置有效 HTTPS 基地址会拒绝启动。详见[部署说明](docs/dokploy-deployment.md)。

V1.1 以 `(agent_id, trace_id)` 聚合完整任务，Dashboard 按 Agent → 发起用户 → 任务显示；列表状态为“审查中、未审查、需要介入、待确认、已完成”。新接入必填 `requester_id`、`original_request`、`agent_result`（按开始/终止事件条件），`expected_purpose` 可选。历史回填不调用 LLM，保持未审查，不触发告警。

保留默认值为 `retention.traceDays=30`、`highRiskTraceDays=90`、`maxTracesPerAgent=2000`，按整条 Trace 清理全部证据；不再按 48 小时/200 条事件截断。未封存、未审查且仍可重试的任务保护；历史 backfill 和失败重试耗尽记录可以过期清理。`auditReview.traceReview` 默认静默 60 分钟、等待用户 1440 分钟、LLM 输入最多 2000 条、失败计数上限 2。等待用户超时不自动判高风险；API 始终返回完整事件，采样仅用于 LLM。

## 使用入口


| 入口                   | 用途               |
| -------------------- | ---------------- |
| `GET /health`        | 查看服务与数据库健康状态     |
| `GET /query`         | 本地开发排障，公网不发布 |
| `GET /v1/audit-logs` | 按 Trace 分页批量读取完整证据 |
| `GET /report/daily`  | 查看日报             |
| `GET /report/errors` | 查看错误报表           |
| `GET /report/tools`  | 查看工具使用统计         |
| `GET /dashboard`     | 查看 Dashboard     |
| `POST /v1/ingest`    | 接收其他 Agent 的审计事件 |


## 文档

- [Dokploy 部署说明](docs/dokploy-deployment.md)：生产部署、变量、域名、网络边界、Dashboard 和备份恢复。
- [其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)：可直接交给编码 Agent 执行，覆盖仓库审计、日志字段契约、自动改造流程、真实发送和 Dashboard 验收。

## Audit Logger Agent 审计效率

### 已落地的审计自动化环节


| 审计环节      | 原先人工工作                    | Audit Logger Agent 已实现的自动化能力                            |
| --------- | ------------------------- | ------------------------------------------------------- |
| 日志接收与归集   | 收集分散日志、检查格式并落到统一位置        | `POST /v1/ingest` 接收并校验事件，保存到 SQLite 与 spool            |
| 批量初筛      | 逐条查看失败、重复、慢调用和敏感操作        | 候选检测器自动识别失败、重复调用、慢调用、高风险工具和不完整链路                        |
| 风险归类与证据关联 | 手工按 Agent、Trace、工具和时间拼接证据 | 审查调度生成结构化 Finding，并关联证据、Agent、Trace 和工具                 |
| 运行查看与定位   | 导出日志、整理表格、在不同系统间查找        | Dashboard、查询和报表支持按 Agent、Trace、工具、状态和时间下钻               |
| 告警与日报     | 整理高风险清单，再人工发送通知           | 高风险 Trace 发送一次飞书卡片；北京时间 10:00、17:00 可生成累计日报 |


### 效率测算参考


| 场景                                                          | 人工耗时        | Audit Logger Agent 自动化后 | 大概省多少                  |
| ----------------------------------------------------------- | ----------- | ----------------------- | ---------------------- |
| A-01：20 条固定审计日志的规则初筛                                        | 约4 分 15 秒   | 约25 ms                  | 4 分 15.135 秒（99.990%）  |
| 100 条审计事件初筛与链路完整性检查（外推）                                     | 约 21 分 16 秒 | 约 129 ms                | 约 21 分 16 秒（约 99.990%） |
| 1 小时 Agent 运行日志巡检（按 20 条日志/小时外推）                            | 约 4 分 15 秒  | 约 25.765 ms             | 约 4 分 15 秒（约 99.990%）  |
| 20 条异常/失败事件归类与证据归集（按 15 条 Finding 外推）                       | 约 5 分 40 秒  | 约 34.353 ms             | 约 5 分 40 秒（约 99.990%）  |
| 20 条 high/critical Finding 的告警准备与汇总（按 15 条 Finding 外推，不含发送） | 约 5 分 40 秒  | 约 34.353 ms             | 约 5 分 40 秒（约 99.990%）  |


但需要谨慎的是：大量的Agent运行日志，实际很少会做人工检查，绝大部分场景下都是直接检查运行结果。因此日志审计agent最佳的使用方式是配合权限审计agent形成闭环的审计体系。

### 相关文档

- [项目总览](#audit-logger-agent)
- [其他 Agent 接入日志审计服务指南](docs/agent-audit-log-integration-guide.md)
- [飞书 Bot 审计通知方案](docs/feishu-bot-notification-design.md)
- [Dokploy 部署说明](docs/dokploy-deployment.md)

## 运行边界

`/v1/ingest` 当前没有内建认证。生产环境必须仅允许受控上游 Agent 或可信网关访问，不能直接暴露到公网。Dashboard 页面本身不要求登录；部署时必须依赖反向代理、VPN、IP allowlist 或平台访问控制限制可见范围。部署细节见 Dokploy 说明。
