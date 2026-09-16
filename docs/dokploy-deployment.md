# 使用 Dokploy 部署 Audit Logger Agent

本文面向部署人员。项目已提供 `compose.dokploy.yaml`、`Dockerfile` 和容器配置 `config.container.json`；Dokploy 从仓库构建镜像并通过反向代理对外提供服务。

## 1. 在 Dokploy 创建 Compose 应用

1. 在 Dokploy 新建 Compose 应用，连接本仓库和要部署的分支。
2. 将 Compose 文件指定为 `compose.dokploy.yaml`。它会使用根目录的 `Dockerfile` 构建服务 `audit-logger-agent`。
3. 不要自行把容器端口 `9320` 发布到主机或公网。Compose 仅 `expose` 该端口，后续由 Dokploy Proxy 转发。
4. 部署后确认容器健康状态为 healthy；Compose 内置健康检查会访问 `http://127.0.0.1:9320/health`。

容器固定读取 `/app/config.container.json`，并监听 `0.0.0.0:9320`。这些值已在 Compose 环境变量中配置，通常不需要在 Dokploy 覆盖。

审查调度会在每个 `/v1/ingest` 成功接收至少一条事件后立即触发一次；该次审查完成后，下一次定时审查会重新按 `auditReview.intervalMinutes`（默认 30 分钟）计时。

## 2. 配置环境变量和 Secret

在 Dokploy 的 Environment/Secret 中设置以下变量，不要把真实值提交到仓库：

| 变量 | 是否必填 | 说明 |
| --- | --- | --- |
| `AUDIT_AGENT_LLM_API_KEY` | 是 | OpenAI-compatible LLM 的 API Key |
| `AUDIT_AGENT_LLM_MODEL` | 是 | 审查与语义映射使用的模型名 |
| `AUDIT_AGENT_LLM_BASE_URL` | 是 | OpenAI-compatible LLM API 地址，例如 `https://api.openai.com/v1` 或实际模型服务地址 |
| `AUDIT_AGENT_LLM_TIMEOUT_MS` | 否 | LLM 请求超时毫秒数；未设置时为 `900000`（15 分钟） |
| `AUDIT_AGENT_LLM_MAX_OUTPUT_TOKENS` | 否 | 单次 Responses API 最大输出 token；未设置时为 `1200` |
| `AUDIT_AGENT_LLM_REASONING_EFFORT` | 否 | Responses API reasoning effort；未设置时为 `low` |
| `AUDIT_AGENT_DASHBOARD_TOKEN` | 否 | `/v1/audit-*` Bearer 鉴权密钥；Dashboard 页面不使用它 |
| `AUDIT_AGENT_DASHBOARD_BASE_URL` | 容器部署是 | 外部可访问的 Dashboard 基地址，例如 `https://<域名>`；覆盖 `auditReview.visualization.baseUrl` |
| `AUDIT_AGENT_FEISHU_MODE` | 否 | `disabled`、`dry-run` 或 `live`，默认 `disabled` |
| `AUDIT_AGENT_FEISHU_WEBHOOK_URL` | live 时是 | 飞书自定义机器人 Webhook；只通过 Dokploy Secret 注入 |
| `AUDIT_AGENT_FEISHU_WEBHOOK_FILE` | 否 | Webhook secret 文件路径；配置后优先于 URL 环境变量 |
| `AUDIT_AGENT_FEISHU_LIVE_CONFIRM` | live 时是 | 必须为 `CONFIRM_FEISHU_LIVE`，用于防止误开启真实发送 |

如需调用 `/v1/audit-*` API，`AUDIT_AGENT_DASHBOARD_TOKEN` 应是独立的高强度随机值。未配置时 Dashboard 仍可访问，但审查 API 的 Bearer 鉴权不会放行请求。

飞书通知默认关闭。建议先使用 `dry-run` 验证卡片构建，再按“本地测试 → 卡片预览审核 → Docker 测试 → 真实客户端验收 → live”的顺序推进。Webhook 不应写入配置文件、Git、日志或命令历史；生产启用前应在飞书侧配置 IP 白名单或关键词安全策略。当前发送器未生成飞书签名字段，如需启用签名校验，应先扩展并验证签名支持。

生产 `live` 必须同时满足：容器配置已启用通知、通知模式为 `feishu_bot`、日报已启用且时段为 10:00/17:00；Dokploy 设置 `AUDIT_AGENT_FEISHU_MODE=live`、有效 Webhook 和精确的 `AUDIT_AGENT_FEISHU_LIVE_CONFIRM=CONFIRM_FEISHU_LIVE`；容器能够解析并通过 HTTPS 访问 `open.feishu.cn:443`；飞书侧的 IP 白名单或关键词策略允许生产请求。使用 `AUDIT_AGENT_FEISHU_WEBHOOK_FILE` 时还必须由 Dokploy 把 Secret 文件实际挂载到该路径，只有路径变量而没有文件不会生效。

## 3. 持久化与健康检查

Compose 已声明命名卷 `audit-logger-data` 并挂载到 `/app/data`。该卷保存 SQLite 数据库、WAL/SHM 文件、接收 spool、captures 和临时运行数据；删除容器不会删除卷内数据，删除该卷才会丢失持久化数据。

保留策略按完整 Trace 执行：`retention.traceDays=30`、`highRiskTraceDays=90`、`maxTracesPerAgent=2000`，年龄按 `last_event_at` 计算。容量安全阀按每 Agent 最近任务排序，超出配额的可清理 Trace 整条删除（包括高风险）；未封存、未审查且仍可重试、迟到事件尚未聚合的 Trace 继续保护，因此上限不是对进行中任务的硬裁剪。事件不会被单独裁成 200 条，旧 `eventsHours`、`maxEventsPerAgent` 已移除。

清理同时删除整条 Trace、事件、审查版本、通知持久回执和对应 Finding/Occurrence/证据快照；跨 Trace 的历史 Finding 只移除失效引用，保留其他任务证据。保留中的 Trace 使用独立 `audit_trace_notifications` 回执去重，不受 Outbox 14 天保留期影响。已落库日报不重算。历史 backfill 已封存且保持 `unreviewed`，按普通保留期清理，不送 LLM。未审查失败记录的持久化 `review_retry_count` 达到 `auditReview.traceReview.maxInvalidOutputRetries=2` 后退出保护；先从 `/health` 观察审查失败待清理计数，再排障。孤儿事件只在超过 30 天且 `ingested_at` 严格早于扫描游标时清理；游标不存在或入库时间为 NULL 时保留。

升级前备份整个数据卷（含 SQLite WAL/SHM）；清理不可逆，不在生产手工运行 prune 做验收。测试仅使用虚构数据或独立测试卷，先 dry-run 再比较实际结果。

在 Dokploy 中保留该 Volume，不要改为容器临时文件系统。部署完成后，通过 Dokploy 健康检查或受控网络请求确认：

```text
GET /health -> 200
```

响应中的 `status` 应为 `ok`，且 `db.writable` 为 `true`。同时核对飞书模式、日报开关、业务时区和 10:00/17:00 时段、下一次 UTC/北京时间、最近时段及其状态、`trigger_type`、`delivery_slot_key`、对应时段的入队/送达时间、投递延迟和 Outbox 统计；`status_error=true` 表示调度健康状态读取失败，需要排障。`/health` 不得返回 Webhook、live 确认口令、Token、请求正文或卡片内容。

## 4. 时间、时段恢复与宿主时钟

日报固定按 `Asia/Shanghai` 每天 10:00、17:00 运行。服务器或容器显示 UTC 时，会比北京时间少 8 小时；例如北京时间 10:00 对应 UTC 02:00，北京时间 17:00 对应 UTC 09:00。这是同一时刻的时区显示差，不是服务器慢了 8 小时。

不要给时间戳手工加 8 小时、修改宿主或容器时钟，或依赖容器 `TZ` 修正调度。调度器直接用绝对 UTC 时间换算北京时间，容器 `TZ` 只影响部分命令和日志的人工显示。Dokploy 宿主必须启用 NTP/chrony；部署验收时应确认系统报告为已同步，并将 `/health.checked_at` 与可信时间源比较，建议漂移不超过 2 秒。

10:00、17:00 使用独立时段键。服务在时点后 30 分钟内启动或恢复时补发最近一个未执行时段；超过窗口则把最近错过时段记录为 `skipped_late`，不发送陈旧日报。若停机跨过多个累计时段，只协调最新时段，较早时段不会补写状态。时段使用原子 claim 和唯一键防止重复执行，Outbox 再通过 `dedupe_key` 防止重复入队。30 分钟内补发是故障恢复，不算准点发送成功，健康状态以 `trigger_type=catch_up` 标识。

## 5. 域名、TLS 与网络边界

在 Dokploy 为该应用绑定正式域名，并由 Dokploy Proxy 终止 TLS、将 HTTPS 请求转发到容器端口 `9320`。生产访问应始终使用 `https://<域名>`。

严禁绕过 Dokploy Proxy 直接暴露服务端口、Docker host port 或容器 IP 到公网。这样会绕过 TLS、Dashboard Cookie 的代理 HTTPS 标识及网关访问控制。

部署默认选择：公网只发布 HTTPS 的 Dashboard 与 `/v1/audit-*` 读取路径；`/query` 是无鉴权的本地开发排障接口，公网 router 不发布它，也不公开 `/report/*`。`/v1/ingest` 没有内建认证，默认仅内网可达，不发布公网写入 router。跨网络 Agent 写入必须使用 HTTPS；需要公网接入时，先在 Traefik 为独立 ingest 路由配置并验证鉴权中间件，再开放，不能用 Dashboard Token 代替 ingest 认证。

通过 Dokploy Domains 选择现有服务 `audit-logger-agent`、容器端口 `9320`，启用 HTTPS 和有效证书，复用现有 Traefik，不在应用容器运行第二套 TLS。建议采用 Traefik 已配置的 ACME resolver 签发续期；正式域名和 resolver 名称由部署环境确认，不假定仓库自带证书。Dokploy 会生成路由配置，但默认整域名路由不等于路径隔离：上线前核对实际生成规则，避免宽泛 Host router 绕过上述路径限制。

容器配置 `auditReview.http.requireHttpsBaseUrl=true`，启动时要求显式 `AUDIT_AGENT_DASHBOARD_BASE_URL=https://<正式域名>`；本地配置为 `false`，允许 `http://127.0.0.1:9320`。绝对链接使用这个固定基地址，不根据客户端 `X-Forwarded-Host` 拼接。代理头仅来自受控 Traefik 网络；不启用任意来源代理信任。

本交付选择不发布公网 HTTP 应用 router。若部署另行选择 HTTP 跳转，应验证返回 308 且保留方法、路径；不要把 Traefik 的永久跳转配置直接等同于 308。HTTP 不得直接接收 ingest，HTTPS 是唯一公网写入通道，内部 healthcheck 仍是 HTTP。

配置依据（2026-09-16 核对官方文档）：[Dokploy Compose Domains](https://docs.dokploy.com/docs/core/docker-compose/domains)、[Dokploy Domains](https://docs.dokploy.com/docs/core/domains)、[Traefik HTTP TLS](https://doc.traefik.io/traefik/reference/routing-configuration/http/tls/overview/)。这些是待部署执行的方案，本次没有改变线上路由或验证线上证书。

## 6. Dashboard 访问

部署和域名生效后，使用：

```text
https://<域名>/dashboard
```

Dashboard 页面不要求登录，能访问该域名和路径的用户可以直接查看审计数据。生产环境应在 Dokploy Proxy、上游网关、VPN 或 IP allowlist 中限制访问范围。审查 API `/v1/audit-*` 不接受 Dashboard 页面访问权限，只接受 `AUDIT_AGENT_DASHBOARD_TOKEN` 对应的 Bearer 请求。

## 7. 飞书通知

容器配置使用 `auditReview.notification.enabled=true` 和 `mode=feishu_bot`，但 `AUDIT_AGENT_FEISHU_MODE` 默认是 `disabled`，因此新部署不会真实发送。不要通过 `callbackUrl` 配置飞书 Webhook；发送器只在进程内从 Secret 环境变量或 secret 文件读取它，避免写入 outbox 数据库。

卡片面向管理层和业务负责人：即时告警标题栏始终为橙色，日报标题栏始终为蓝色，不使用红色或 `carmine` 标题。首屏先展示结论、关键数字和最多 Top 3 风险；完整风险名称与摘要放入风险折叠区，日报的风险明细与工具统计使用两个独立折叠区。用户可见时间使用北京时间，Agent/Trace 优先展示可读名称，技术 ID 缩短后作为辅助信息；完整 ID 仍用于分组、去重和 Dashboard 查询。

上线顺序应为：

1. 保持 `disabled`，完成定向测试和本地全量非 external 测试。
2. 使用 `dry-run` 和完全虚构的数据生成卡片预览，覆盖单条 high Trace、迟到重审去重、超长字段截断、有风险日报、无风险日报；一条 Trace 一张卡片，不分片。
3. 在执行任何 Docker 构建或测试前，把卡片截图或渲染图提交给用户审核；未获得明确通过时不得继续 Docker 测试。
4. 审核通过后，使用最新工作树执行断网 Docker 测试和生产入口健康检查；保持同一命名卷重启容器，确认时段状态继续存在、下一次 UTC/北京时间正确且不会重复入队。检查镜像、环境、日志及文件中不存在真实 Webhook；测试结束后清理临时镜像、容器和卷。
5. 向私有非生产测试 Bot 发送虚构数据，保留飞书桌面端和移动端、折叠和展开状态、单 Trace 单卡及有风险/无风险日报截图或录屏。
6. 真实客户端视觉验收通过后，才可配置 `AUDIT_AGENT_FEISHU_MODE=live` 和 `AUDIT_AGENT_FEISHU_LIVE_CONFIRM=CONFIRM_FEISHU_LIVE`。

Docker 前提交的本地截图或渲染图只是设计审核门，不是飞书真实客户端验收。不得用 JSON、源码、单元测试、本地 HTML 或模拟渲染结果替代桌面端和移动端的真实截图或录屏。

即时消息只发送 `risk_level=high` 的 Trace，按 `(agent_id, trace_id)` 一次去重，迟到重审不重复发送；历史 Finding 的 `critical` 仅在读取层映射为 `high`，不物理改写；日报按北京时间 10:00、17:00 发送。Outbox 在投递前原子 claim 到期消息，日报优先于普通 callback，同一优先级内按创建时间处理。发送器将持续速率限制在低于 100 次/分钟，同时满足 5 次/秒限制。

Dashboard 顶部的“飞书通知正常”状态标识同时作为即时日报入口。知道入口的管理人员点击后会进入服务端确认页，确认后发送北京时间当天 00:00 至当前时刻的全局单卡日报。卡片与自动日报完全复用标题和样式，不标记手动来源。该操作使用独立的分钟级去重键，不占用 10:00、17:00 定时 slot；同一分钟重复提交不会新增消息。北京时间 09:55—10:05、16:55—17:05 会拒绝即时发送，避免与自动日报相邻重复。

该入口不增加密码，视觉隐藏也不是鉴权。生产仍应沿用本文件第 6 节的 Dashboard 网络访问范围；任何能访问 Dashboard 并发现确认页的用户都可能执行发送。确认页的 GET 不产生副作用，页面通过 POST 表单入队；服务端不新增 Origin 或 CSRF 强制校验。

发送验收以日报在规定时点进入高优先级 Outbox 为主 SLA。在服务正常、无既有高优先级积压且飞书可用时，首张卡目标为 10 秒内送达；全部卡片的最短发送时间受 650ms 串行间隔约束，应按卡片数量计算。时点前应检查 pending 积压；从 `disabled` 或 `dry-run` 恢复 `live` 会继续投递已有 pending 飞书消息，避免上线时意外集中发送历史卡片。

从 `live` 切换到 `dry-run` 或 `disabled` 时，已有 pending 飞书消息会保留原状态，不发送、不增加尝试次数；恢复 `live` 后继续投递。

外部通知中的 Dashboard 链接由 `AUDIT_AGENT_DASHBOARD_BASE_URL`（优先）或 `auditReview.visualization.baseUrl` 与 `auditReview.visualization.dashboardPath` 生成。Dokploy 应将 `AUDIT_AGENT_DASHBOARD_BASE_URL` 设置为实际的 `https://<域名>`；变量为空时才回退到配置文件，否则飞书卡片会隐藏 Dashboard 操作。

## 8. 升级、备份与恢复

升级前先确认当前服务健康、部署变量仍存在，再触发 Dokploy 拉取新提交并重建。`/app/data` 挂载的 `audit-logger-data` 必须复用，不能在升级时新建空卷。重建后通过 `/health` 核对最近时段状态和下一次 UTC/北京时间；若重启发生在时点后 30 分钟内，应看到补发结果且只入队一次，超过窗口则应看到明确的错过状态。

备份步骤：

1. 在 Dokploy 停止应用，确保 SQLite 不再写入。
2. 备份整个 `audit-logger-data` Volume（包括数据库、`-wal` 和 `-shm` 文件以及 spool），而不是只复制 `audit.db`。
3. 将备份保存到受控、加密的位置，并记录对应部署版本与时间。

恢复步骤：

1. 停止应用。
2. 使用备份恢复 `audit-logger-data` Volume 到 `/app/data`，保留目录结构和文件权限。
3. 启动应用，检查 `/health` 的 `db.writable`，再通过 Dashboard 或 `/query` 抽查数据。

恢复或迁移时不要同时运行两个挂载同一 SQLite Volume 的应用实例。


## 9. V1.1 配置与迁移验收

| 配置路径 | 默认值 | 含义 |
| --- | --- | --- |
| `retention.traceDays` | 30 | 普通已封存任务保留天数 |
| `retention.highRiskTraceDays` | 90 | 高风险任务保留天数 |
| `retention.maxTracesPerAgent` | 2000 | 每 Agent 容量安全阀 |
| `auditReview.traceReview.idleTimeoutMinutes` | 60 | 非等待用户任务静默封存 |
| `auditReview.traceReview.waitingUserTimeoutMinutes` | 1440 | 等待用户超时封存，不自动判高风险 |
| `auditReview.traceReview.maxEventsPerTrace` | 2000 | 仅限制 LLM 输入采样，不裁剪存储或 API |
| `auditReview.traceReview.maxInvalidOutputRetries` | 2 | 持久化失败计数达到该值后停止重试 |
| `auditReview.http.requireHttpsBaseUrl` | 容器 true / 本地 false | 校验显式 HTTPS 基地址 |

迁移按顺序执行：备份 → compat 接收新字段 → guarded schema 升级和历史 backfill → Trace 聚合审查并保留 Finding → 切换 Trace 通知/日报 → 切换 Dashboard/API → 按 Agent 开启 `agents[agentId].ingestMode=strict`。旧数据不猜测 requester/result 字段，历史 Trace 保持未审查；旧 Finding URL 和 `/query` 保持兼容。`GET /v1/audit-logs` 使用 Bearer Token，按 Trace 分页返回完整事件和 raw_json，客户端原样回传服务端游标。

验收检查 HTTPS 证书和续期、读取鉴权、HTTP 不能写入、旧链接可用、回填不发告警、每日 10:00/17:00 日报与手动日报持续工作。更新上游 `AUDIT_INGEST_URL`、coding agent API 基地址和 Dashboard 基地址，确认飞书链接直达包含 Agent 与 Trace 的任务页。

回滚时保留事件、新列、Trace、审查版本、通知去重记录和 Outbox，不恢复旧事件级清理规则。接入可回退 compat（同时取消各 Agent 显式 strict），不放宽类型/长度校验；展示可恢复旧 Finding 入口。HTTPS 路由回退前先协调客户端地址，不同时开放 HTTP/HTTPS 双写；公网仍保持 HTTPS 或停止开放入口。日报已落库统计、时段和 Outbox 不回滚、不重算。
