# 项目工作约定

本文件只维护 audit-logger-agent 的项目事实与局部约定，不复制全局规则。

## 项目与入口

- Node.js 项目，使用 ES modules（`package.json` 中 `type: module`）。依赖与可执行命令以 `package.json` 为准。
- HTTP 路由：`src/adapters/http/app.js`。
- Dashboard 数据视图模型：`src/auditReview/visualization.js`。
- Dashboard HTML、CSS 与页面交互：`src/auditReview/dashboardTemplate.js`。采用服务端直接传入数据的渲染链路，不另建前端框架或浏览器取数链路。
- Trace 聚合、读取与存储：`src/auditReview/traceAggregator.js`、`traceReadService.js`、`traceStore.js`。

## 需求与设计依据

- V1.1 任务审计设计：`docs/superpowers/specs/2026-09-14-v1.1-audit-task-review-design.md`。
- Dashboard 信息架构、交互与视觉参考：上述文档第 12.5 节，以及 `docs/superpowers/specs/assets/v1.1-dashboard/source/` 中的四页 HTML 和 `base.css`。
- 功能一致性检查记录：`docs/superpowers/specs/2026-09-15-v1.1-functional-consistency-review.md`。
- 接入说明：`docs/agent-audit-log-integration-guide.md`。
- 部署说明：`docs/dokploy-deployment.md`。文档不能替代对实际运行环境的核实。

## Dashboard 当前约定

- 主导航保留 `Agent / 风险发现 / 审查批次` 三项，不因首页而隐藏后两项。
- 首页展示 Agent 名称或 ID、发起人数、任务数、最近活动时间和进入详情的链接；不展示风险等级、工具、Finding、Trace 或原始状态码。
- 发起人按 `requester_id` 分组，缺失身份归入“发起人未知”。用户任务列表使用“审查中 / 未审查 / 需要介入 / 待确认 / 已完成”五种行动状态。
- 任务详情顺序为：任务结论 → 任务上下文 → Agent 审计结果 → 证据链 → 原始日志。原始日志默认折叠，需验证实际隐藏效果，而不只检查 `open` 属性。
- 图标使用 Lucide 内联 SVG，不使用表情符号或字符图标替代。720px 及以下的布局规则写入样式表。
- 2026-09-17 用户确认的例外：健康状态点规则另定，当前不展示状态点，也不根据风险或活动间隔自行推导健康状态。
- 本轮仅对齐内容与交互，保留现有主题；主题调整另议。判断配色时应检查最终 CSS 覆盖与浏览器计算样式，不能只看文件开头的令牌。

## 验证

- 全量本地测试：`npm test`（实际入口为 `node scripts/run-tests.js`）。不要使用 `node --test test/` 代替项目入口。
- Dashboard 定向测试：`node --test test/auditReview/dashboardTemplate.test.js test/auditReview/visualization.test.js`。
- 路由相关检查：`node --test test/auditReview/httpIntegration.test.js`。
- UI 改动除必要单元测试外，应使用实际渲染验证关键交互和窄屏布局。样例数据预览不等于生产验证；无法执行浏览器检查时明确说明限制。
- 不为同一最终状态无故重复全量测试；后续改动只重跑受影响的必要检查。

## 变更边界

- 不把本地测试通过或 Git 提交视为已部署，不自行访问生产或触发外部通知。
- 并行修改须划分文件归属；子代理异常退出后先检查遗留 diff，未返回的验证不能记为完成。
- 只在用户授权后提交，提交信息使用中文，仅包含本次相关文件；未经明确授权不推送远端。
