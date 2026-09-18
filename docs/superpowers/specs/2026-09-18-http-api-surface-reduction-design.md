# HTTP API 对外面收敛设计

## 目标

将对外 HTTP 能力收敛为日志写入、Trace 批量读取、Dashboard 人工审计和健康探针四类，移除不属于该产品边界的旧接口。

## 保留路由

- `POST /v1/ingest`：上游 Agent 批量提交审计事件。
- `GET /v1/audit-logs`：审计 Agent 按 Trace 分页读取完整审计证据。
- `GET /health`：容器和运维健康探针。
- `/dashboard...`：Dashboard 页面与表单动作，包括飞书日报的 `GET`、`POST /dashboard/daily-report/send` 和 Finding 人工处置。

## 移除路由

- `/v1/runs*`
- `/query`
- `/report/daily`、`/report/errors`、`/report/tools`
- `/v1/audit-reviews*`
- `/v1/audit-findings*`
- `/dashboard/login`、`/dashboard/logout`

## 影响与处理

Dashboard、飞书通知和审查调度直接调用内部服务，不依赖被移除的 JSON 路由。`npm run query`、`npm run report` 继续直接读取 SQLite。审计基准改为直接调用 scheduler 与 review store，避免依赖已移除的 HTTP 路由。

同步删除对应 HTTP 测试和公开文档条目；保留接口、Dashboard 页面与日报流程须继续通过定向测试和全量测试验证。
