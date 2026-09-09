import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const EVENT_SKEW_MS = 5_000;
const EXPECTED_EVENT_COUNT = 6;

const NORMAL_SCENARIOS = Object.freeze([
  {
    name: '商品详情查询',
    toolName: 'catalog.product.get',
    mappedType: 'read',
    entityType: 'product',
    entityLabel: '商品',
    action: '读取商品详情',
  },
  {
    name: '库存余量查询',
    toolName: 'inventory.stock.query',
    mappedType: 'read',
    entityType: 'stock_item',
    entityLabel: '库存项',
    action: '查询库存余量',
  },
  {
    name: '客户资料读取',
    toolName: 'customer.profile.read',
    mappedType: 'read',
    entityType: 'customer_profile',
    entityLabel: '客户资料',
    action: '读取客户资料',
  },
  {
    name: '订单历史列表',
    toolName: 'order.history.list',
    mappedType: 'read',
    entityType: 'order_history',
    entityLabel: '订单历史',
    action: '列出订单历史',
  },
  {
    name: '定价规则获取',
    toolName: 'pricing.rule.fetch',
    mappedType: 'read',
    entityType: 'pricing_rule',
    entityLabel: '定价规则',
    action: '获取定价规则',
  },
]);

const HIGH_RISK_SCENARIOS = Object.freeze([
  {
    name: '商品信息更新',
    toolName: 'catalog.product.update',
    mappedType: 'update',
    entityType: 'product',
    entityLabel: '商品',
    action: '更新商品信息',
  },
  {
    name: '库存数量修改',
    toolName: 'inventory.stock.update',
    mappedType: 'update',
    entityType: 'stock_item',
    entityLabel: '库存项',
    action: '修改库存数量',
  },
  {
    name: '客户资料删除',
    toolName: 'customer.profile.delete',
    mappedType: 'delete',
    entityType: 'customer_profile',
    entityLabel: '客户资料',
    action: '删除客户资料',
  },
  {
    name: '订单记录写入',
    toolName: 'order.record.write',
    mappedType: 'write',
    entityType: 'order_record',
    entityLabel: '订单记录',
    action: '写入订单记录',
  },
  {
    name: '定价规则调整',
    toolName: 'pricing.rule.update',
    mappedType: 'update',
    entityType: 'pricing_rule',
    entityLabel: '定价规则',
    action: '调整定价规则',
  },
]);

function compactId(value) {
  return String(value).replace(/[^a-zA-Z0-9]/g, '').slice(0, 12).toLowerCase();
}

function pickRandom(items, randomIntImpl) {
  const index = Number(randomIntImpl(items.length));
  if (!Number.isInteger(index) || index < 0 || index >= items.length) {
    throw new Error(`随机数生成器返回越界索引：${index}`);
  }
  return items[index];
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`请求超时：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options, runtime) {
  const response = await fetchWithTimeout(url, options, runtime);
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`接口返回非 JSON：${url}，HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`接口请求失败：${url}，HTTP ${response.status}，${body.error ?? text}`);
  }
  return body;
}

async function requestText(url, options, runtime) {
  const response = await fetchWithTimeout(url, options, runtime);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`页面请求失败：${url}，HTTP ${response.status}`);
  }
  return text;
}

function eventTimestamp(baseTimeMs, offsetMs) {
  return new Date(baseTimeMs + offsetMs).toISOString();
}

export function buildDemoTrace(kind, {
  nowMs = Date.now(),
  idFactory = randomUUID,
  randomIntImpl = randomInt,
} = {}) {
  if (kind !== 'normal' && kind !== 'high-risk') {
    throw new Error(`不支持的演示类型：${kind}`);
  }

  const highRisk = kind === 'high-risk';
  const traceId = idFactory();
  const runSpanId = idFactory();
  const agentSpanId = idFactory();
  const toolSpanId = idFactory();
  const scenario = pickRandom(highRisk ? HIGH_RISK_SCENARIOS : NORMAL_SCENARIOS, randomIntImpl);
  const runToken = compactId(traceId) || compactId(idFactory()) || 'run';
  const toolDurationMs = 15 + Number(randomIntImpl(70));
  const toolName = scenario.toolName;
  const expectedMappedType = scenario.mappedType;
  const agentId = `audit-demo-${highRisk ? 'risk' : 'normal'}-${runToken}`;
  const channel = highRisk ? 'feishu' : 'validation';
  const baseTimeMs = nowMs - EVENT_SKEW_MS;
  const entity = {
    type: scenario.entityType,
    id: `${scenario.entityType}-${runToken}`,
  };
  const base = {
    agent_id: agentId,
    trace_id: traceId,
    channel,
    user_id: `demo_operator_${runToken}`,
    entity,
  };
  const riskTags = highRisk
    ? ['demo', scenario.mappedType, 'high-risk', 'confirmed', runToken]
    : ['demo', 'read', 'normal', scenario.entityType, runToken];

  const events = [
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 0),
      span_id: runSpanId,
      event: 'run.start',
      tool_name: 'agent.run',
      status: 'OK',
      result_summary: highRisk
        ? `开始${scenario.name}高风险审计演示`
        : `开始${scenario.name}正常审计演示`,
      tags: highRisk ? ['demo', 'high-risk', runToken] : ['demo', 'normal', runToken],
    },
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 10),
      span_id: agentSpanId,
      parent_span_id: runSpanId,
      event: 'agent.start',
      tool_name: 'agent.lifecycle',
      status: 'OK',
      result_summary: highRisk
        ? `执行已确认的${scenario.action}演示`
        : `执行只读的${scenario.action}演示`,
      tags: highRisk
        ? ['demo', 'high-risk', 'confirmed', runToken]
        : ['demo', 'normal', scenario.entityType, runToken],
    },
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 20),
      span_id: toolSpanId,
      parent_span_id: agentSpanId,
      event: 'tool.start',
      tool_name: toolName,
      status: 'OK',
      result_summary: highRisk
        ? `已确认，开始执行${scenario.action}审计演示`
        : `开始${scenario.action}，不修改${scenario.entityLabel}数据`,
      tags: riskTags,
      llm_intent: {
        input: highRisk ? `执行已确认的${scenario.action}演示` : `${scenario.action}演示`,
        output: `调用 ${toolName}`,
      },
    },
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 45),
      span_id: toolSpanId,
      parent_span_id: agentSpanId,
      event: 'tool.end',
      tool_name: toolName,
      status: 'OK',
      result_summary: highRisk
        ? `${scenario.action}审计演示完成（仅发送审计事件，无真实业务写入）`
        : `${scenario.action}完成，未发生写入`,
      duration_ms: toolDurationMs,
      tags: riskTags,
    },
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 55),
      span_id: agentSpanId,
      parent_span_id: runSpanId,
      event: 'agent.end',
      tool_name: 'agent.lifecycle',
      status: 'OK',
      result_summary: highRisk
        ? `${scenario.name}高风险审计演示流程完成`
        : `${scenario.name}正常审计演示流程完成`,
      duration_ms: 45,
      tags: highRisk ? ['demo', 'high-risk', runToken] : ['demo', 'normal', runToken],
    },
    {
      ...base,
      ts: eventTimestamp(baseTimeMs, 65),
      span_id: runSpanId,
      event: 'run.final_result',
      tool_name: 'agent.run',
      status: 'OK',
      result_summary: highRisk
        ? `${scenario.name}高风险审计演示完成，未修改真实业务数据`
        : `${scenario.name}正常审计演示完成，无业务数据变更`,
      duration_ms: 65,
      tags: highRisk ? ['demo', 'high-risk', runToken] : ['demo', 'normal', runToken],
    },
  ];

  return {
    kind,
    traceId,
    toolName,
    expectedMappedType,
    agentId,
    scenarioName: scenario.name,
    entity,
    events,
  };
}

async function getHealth(config, runtime) {
  return requestJson(`${config.baseUrl}/health`, { method: 'GET' }, runtime);
}

async function sendBatch(batch, config, runtime) {
  const result = await requestJson(`${config.baseUrl}/v1/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: batch.events }),
  }, runtime);
  if (result.accepted !== EXPECTED_EVENT_COUNT || result.rejected !== 0) {
    throw new Error(
      `${batch.kind} 批次接收异常：accepted=${result.accepted}，rejected=${result.rejected}`,
    );
  }
  return result;
}

async function queryTrace(traceId, config, runtime) {
  const url = `${config.baseUrl}/query?trace_id=${encodeURIComponent(traceId)}&limit=100`;
  return requestJson(url, { method: 'GET' }, runtime);
}

function traceMappingReady(result, batch) {
  if (result.count !== EXPECTED_EVENT_COUNT || !Array.isArray(result.results)) return false;
  const traceIds = new Set(result.results.map((event) => event.trace_id));
  if (traceIds.size !== 1 || !traceIds.has(batch.traceId)) return false;
  const toolEvents = result.results.filter((event) => event.event?.startsWith('tool.'));
  return toolEvents.length === 2 && toolEvents.every((event) => (
    event.tool_name === batch.toolName
    && event.mapping_status === 'mapped'
    && event.mapped_tool_type === batch.expectedMappedType
  ));
}

async function waitForTraceMapping(batch, config, runtime) {
  const attempts = Math.max(1, Math.ceil(config.reviewTimeoutMs / config.pollIntervalMs));
  let lastResult = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResult = await queryTrace(batch.traceId, config, runtime);
    if (traceMappingReady(lastResult, batch)) return lastResult;
    await runtime.sleepImpl(config.pollIntervalMs);
  }
  throw new Error(
    `${batch.kind} Trace 映射等待超时：trace=${batch.traceId}，count=${lastResult?.count ?? 'unknown'}`,
  );
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function parseReviewPage(html) {
  const text = decodeHtml(String(html))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const numberOf = (pattern) => {
    const match = text.match(pattern);
    return match ? Number(match[1]) : null;
  };
  const windowMatch = text.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s*~\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/,
  );
  return {
    text,
    findingCount: numberOf(/已完成\s+(\d+)\s+个发现/),
    criticalCount: numberOf(/(\d+)\s+严重/),
    highCount: numberOf(/(\d+)\s+高风险/),
    candidateCount: numberOf(/候选事件数\s+(\d+)/),
    windowFrom: windowMatch?.[1] ?? null,
    windowTo: windowMatch?.[2] ?? null,
  };
}

function reviewCoversBatch(review, batch) {
  const from = Date.parse(review.windowFrom);
  const to = Date.parse(review.windowTo);
  const first = Date.parse(batch.events[0].ts);
  const last = Date.parse(batch.events[batch.events.length - 1].ts);
  return [from, to, first, last].every(Number.isFinite) && from <= first && to >= last;
}

async function waitForReview(batch, previousReviewId, config, runtime) {
  const attempts = Math.max(1, Math.ceil(config.reviewTimeoutMs / config.pollIntervalMs));
  const inspected = new Set();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await getHealth(config, runtime);
    const current = health.latest_review;
    const terminal = current?.status === 'completed' || current?.status === 'completed_degraded';
    if (current?.review_id && current.review_id !== previousReviewId && terminal && !inspected.has(current.review_id)) {
      inspected.add(current.review_id);
      const dashboardUrl = `${config.baseUrl}/dashboard/audit-reviews/${encodeURIComponent(current.review_id)}`;
      const html = await requestText(dashboardUrl, { method: 'GET' }, runtime);
      const review = parseReviewPage(html);
      if (reviewCoversBatch(review, batch)) {
        return { reviewId: current.review_id, dashboardUrl, health, review };
      }
    }
    if (current?.review_id && current.review_id !== previousReviewId && current.status === 'failed') {
      throw new Error(`${batch.kind} 审查失败：${current.review_id}`);
    }
    await runtime.sleepImpl(config.pollIntervalMs);
  }
  throw new Error(`${batch.kind} 等待覆盖目标 Trace 的审查超时：${batch.traceId}`);
}

export function validateBatchReview(batch, review) {
  const identifiesTarget = review.text.includes(batch.agentId) && review.text.includes(batch.toolName);
  if (batch.kind === 'normal') {
    if (identifiesTarget) {
      throw new Error(`正常工具被生成风险 Finding：${batch.toolName}`);
    }
    return;
  }
  if (!identifiesTarget) {
    throw new Error(`高风险 Review 未包含目标 Agent/工具：${batch.agentId}/${batch.toolName}`);
  }
  if ((review.highCount ?? 0) < 1 || (review.findingCount ?? 0) < 1 || (review.candidateCount ?? 0) < 1) {
    throw new Error(
      `高风险 Review 未达到预期：findings=${review.findingCount}，high=${review.highCount}，candidates=${review.candidateCount}`,
    );
  }
}

async function waitForOutbox(config, runtime) {
  const attempts = Math.max(1, Math.ceil(config.reviewTimeoutMs / config.pollIntervalMs));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const health = await getHealth(config, runtime);
    const mode = health.notification_digest?.feishu_mode;
    const pending = Number(health.outbox?.pending ?? 0);
    const deadLetter = Number(health.outbox?.dead_letter ?? 0);
    if (mode !== 'live') throw new Error(`飞书模式不是 live：${mode ?? 'unknown'}`);
    if (deadLetter > 0) throw new Error(`Outbox 出现死信：${deadLetter}`);
    if (pending === 0) return health;
    await runtime.sleepImpl(config.pollIntervalMs);
  }
  throw new Error('等待飞书 Outbox 清空超时');
}

function readConfig(env) {
  return {
    baseUrl: normalizeBaseUrl(env.AUDIT_DEMO_BASE_URL),
    timeoutMs: positiveInteger(env.AUDIT_DEMO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    reviewTimeoutMs: positiveInteger(env.AUDIT_DEMO_REVIEW_TIMEOUT_MS, DEFAULT_REVIEW_TIMEOUT_MS),
    pollIntervalMs: positiveInteger(env.AUDIT_DEMO_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
  };
}

export async function runAuditDemo({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  idFactory = randomUUID,
  randomIntImpl = randomInt,
  nowImpl = Date.now,
  log = console.log,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前 Node.js 环境不支持 fetch，需要 Node.js 18+');
  const config = readConfig(env);
  const runtime = { fetchImpl, sleepImpl, timeoutMs: config.timeoutMs };

  log(`审计服务：${config.baseUrl}`);
  log('本次演示会写入两条新 Trace，并触发一次真实飞书高风险告警。');

  const initialHealth = await getHealth(config, runtime);
  if (initialHealth.status !== 'ok' || initialHealth.db?.writable !== true) {
    throw new Error('审计服务健康检查未通过或数据库不可写');
  }
  if (initialHealth.notification_digest?.feishu_mode !== 'live') {
    throw new Error(`飞书模式不是 live：${initialHealth.notification_digest?.feishu_mode ?? 'unknown'}`);
  }

  const normal = buildDemoTrace('normal', { nowMs: nowImpl(), idFactory, randomIntImpl });
  log(`发送正常批次：${normal.traceId}｜${normal.scenarioName}｜${normal.toolName}`);
  await sendBatch(normal, config, runtime);
  await waitForTraceMapping(normal, config, runtime);
  const normalReview = await waitForReview(normal, initialHealth.latest_review?.review_id, config, runtime);
  validateBatchReview(normal, normalReview.review);
  log(`正常批次验证通过：${normalReview.reviewId}`);

  const highRisk = buildDemoTrace('high-risk', { nowMs: nowImpl(), idFactory, randomIntImpl });
  log(`发送高风险批次：${highRisk.traceId}｜${highRisk.scenarioName}｜${highRisk.toolName}`);
  await sendBatch(highRisk, config, runtime);
  await waitForTraceMapping(highRisk, config, runtime);
  const highRiskReview = await waitForReview(highRisk, normalReview.reviewId, config, runtime);
  validateBatchReview(highRisk, highRiskReview.review);
  const finalHealth = await waitForOutbox(config, runtime);
  log(`高风险批次验证通过：${highRiskReview.reviewId}`);

  return {
    baseUrl: config.baseUrl,
    normal: {
      traceId: normal.traceId,
      reviewId: normalReview.reviewId,
      dashboardUrl: normalReview.dashboardUrl,
      agentId: normal.agentId,
      toolName: normal.toolName,
      scenarioName: normal.scenarioName,
      entity: normal.entity,
    },
    highRisk: {
      traceId: highRisk.traceId,
      reviewId: highRiskReview.reviewId,
      dashboardUrl: highRiskReview.dashboardUrl,
      agentId: highRisk.agentId,
      toolName: highRisk.toolName,
      scenarioName: highRisk.scenarioName,
      entity: highRisk.entity,
    },
    feishuMode: finalHealth.notification_digest?.feishu_mode,
    outbox: finalHealth.outbox,
  };
}

function printHelp() {
  console.log(`用法：npm run demo:audit-logs

发送一批正常审计日志和一批高风险审计日志，等待审查完成并验证飞书告警链路。

环境变量：
  AUDIT_DEMO_BASE_URL          审计服务基地址
  AUDIT_DEMO_TIMEOUT_MS        单次 HTTP 请求超时，默认 ${DEFAULT_TIMEOUT_MS}
  AUDIT_DEMO_REVIEW_TIMEOUT_MS Review 等待超时，默认 ${DEFAULT_REVIEW_TIMEOUT_MS}
  AUDIT_DEMO_POLL_INTERVAL_MS  轮询间隔，默认 ${DEFAULT_POLL_INTERVAL_MS}
`);
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }
  const result = await runAuditDemo();
  console.log('');
  console.log('演示完成');
  console.log(`正常场景：${result.normal.scenarioName}｜${result.normal.toolName}｜${result.normal.agentId}`);
  console.log(`正常 Trace：${result.normal.traceId}`);
  console.log(`正常 Review：${result.normal.reviewId}`);
  console.log(`正常 Dashboard：${result.normal.dashboardUrl}`);
  console.log(`高风险场景：${result.highRisk.scenarioName}｜${result.highRisk.toolName}｜${result.highRisk.agentId}`);
  console.log(`高风险 Trace：${result.highRisk.traceId}`);
  console.log(`高风险 Review：${result.highRisk.reviewId}`);
  console.log(`高风险 Dashboard：${result.highRisk.dashboardUrl}`);
  console.log(`飞书模式：${result.feishuMode}`);
  console.log(`Outbox：pending=${result.outbox?.pending ?? 0}，dead_letter=${result.outbox?.dead_letter ?? 0}`);
}

const directEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directEntry) {
  main().catch((error) => {
    console.error(`演示失败：${error.message}`);
    process.exitCode = 1;
  });
}
