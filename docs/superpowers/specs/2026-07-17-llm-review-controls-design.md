# LLM 审查控制与语义映射串行化设计

## 目标

将提交 `426ad47` 和 `22aeb45` 相对 `master` 的领先行为适配到当前主分支，同时保留现有 Dashboard、部署和 Agent 接入文档结构。

## 行为范围

### LLM 配置与请求

- `AUDIT_AGENT_LLM_TIMEOUT_MS` 默认值改为 `900000`。
- 新增 `AUDIT_AGENT_LLM_MAX_OUTPUT_TOKENS`，默认值为 `1200`。
- 新增 `AUDIT_AGENT_LLM_REASONING_EFFORT`，默认值为 `low`。
- OpenAI Responses 请求携带 `max_output_tokens` 和 `reasoning.effort`。
- 配置继续支持环境变量、项目 `.config` 和现有 planner 配置来源。

### 审查调度

- 新增 `auditReview.llmReview.maxCandidatesPerCall`，默认值为 `12`。
- LLM 和 Token 预算只使用截断后的候选集合。
- 规则检测、降级 Finding 和审查批次候选计数继续覆盖完整候选集合。
- 新增 `scheduler.runManual()`，手动审查通过现有 `reviewChain` 排队，不再直接与运行中的审查争抢锁。
- HTTP 手动审查入口优先调用 `runManual()`，保留旧 Scheduler 的兼容回退。

### 工具语义映射

- `mapPendingEvents()` 的多次调用通过进程内 Promise 队列串行执行。
- 单批内部仍逐条映射。
- 前一批失败不能阻断后续批次。
- 该机制只保证单进程串行，不声称提供多实例分布式锁。

## 文件范围

- `compose.dokploy.yaml`
- `config.json`
- `config.container.json`
- `README.md`
- `docs/dokploy-deployment.md`
- `scripts/server.js`
- `src/adapters/http/app.js`
- `src/auditReview/scheduler.js`
- `src/auditReview/toolSemanticMapper.js`
- `src/llm/openaiConfig.js`
- `src/llm/openaiResponsesClient.js`
- 对应的 Scheduler、Mapper、OpenAI 配置和 Responses Client 测试

不修改已经重写的 `agent-audit-log-integration-guide.md`，因为该文档面向上游 Agent 接入，不负责审计服务自身的 LLM 运行配置。

## 验证

1. 配置测试验证三个默认值及环境变量覆盖。
2. Responses Client 测试验证请求参数和并发门控保持有效。
3. Scheduler 测试验证手动审查排队、候选截断和完整规则兜底。
4. Mapper 测试验证并发调用最大活跃批次数为 1，且两批事件均完成映射。
5. 运行全部项目测试。
6. 提交前确认差异仅覆盖上述文件和行为。

## 影响与回滚

- LLM 请求最长可等待 15 分钟，可能延长串行审查队列占用时间。
- Responses API 默认携带 reasoning 参数，要求实际 OpenAI-compatible 服务支持该字段。
- 单次 LLM 输入最多包含 12 个候选，其余候选依靠规则 Finding 保留覆盖。
- 回滚时对最终实现提交执行 `git revert`，不需要数据库迁移。
