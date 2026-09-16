import { randomInt, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://auditloggeragent-auditloggeragent-mue8ko-342fc3-18-141-240-9.traefik.me';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const EVENT_SKEW_MS = 5_000;

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

function eventTimestamp(baseTimeMs, offsetMs) {
  return new Date(baseTimeMs + offsetMs).toISOString();
}

export function buildDemoTrace(kind, {
  nowMs = Date.now(),
  idFactory = randomUUID,
  randomIntImpl = randomInt,
} = {}) {
  if (!['normal', 'medium-risk', 'high-risk'].includes(kind)) {
    throw new Error(`不支持的演示类型：${kind}`);
  }

  const highRisk = kind === 'high-risk';
  const mediumRisk = kind === 'medium-risk';
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
      requester_id: 'demo_operator',
      original_request: `请演示${scenario.action}，仅发送审计事件，不修改真实业务数据`,
      expected_purpose: `生成${scenario.name}的完整审计链路以验证日志接入`,
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
      agent_result: `${scenario.name}演示事件已生成，未修改真实业务数据`,
      tool_name: 'agent.run',
      status: 'OK',
      result_summary: highRisk
        ? `${scenario.name}高风险审计演示完成，未修改真实业务数据`
        : `${scenario.name}正常审计演示完成，无业务数据变更`,
      duration_ms: 65,
      tags: highRisk ? ['demo', 'high-risk', runToken] : ['demo', 'normal', runToken],
    },
  ];

  if (highRisk) {
    events[3].event = 'tool.error';
    events[3].status = 'UNAVAILABLE';
    events[3].result_summary = `${scenario.action}失败：服务不可用，重试未恢复`;
    events[3].error = { message: '服务不可用，任务无法完成' };
    events[4].event = 'agent.error';
    events[4].status = 'UNAVAILABLE';
    events[4].result_summary = '工具失败未恢复，任务失败，需要人工介入';
    events[5].event = 'run.failed';
    events[5].status = 'UNAVAILABLE';
    events[5].agent_result = `${scenario.action}失败，未完成用户请求，需要人工介入；仅模拟事件，无真实业务写入`;
    events[5].result_summary = '任务失败，需要人工介入';
  } else if (mediumRisk) {
    const retrySpanId = idFactory();
    const toolEnd = { ...events[3], span_id: retrySpanId };
    events[3] = { ...events[3], event: 'tool.error', status: 'UNAVAILABLE',
      result_summary: '首次查询失败，准备重试', error: { message: '临时服务不可用' } };
    events.splice(4, 0,
      { ...events[2], span_id: retrySpanId, ts: eventTimestamp(baseTimeMs, 46),
        result_summary: '重试查询', attempt: { number: 2, retry_of_span_id: toolSpanId } },
      { ...toolEnd, ts: eventTimestamp(baseTimeMs, 50), result_summary: '重试成功，已取得完整结果' });
    events.at(-1).agent_result = '首次工具调用失败，重试成功，已完成用户请求';
  }

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
  if (result.accepted !== batch.events.length || result.rejected !== 0) {
    throw new Error(
      `${batch.kind} 批次接收异常：accepted=${result.accepted}，rejected=${result.rejected}`,
    );
  }
  return result;
}

export function validateBatchReview(batch, trace) {
  if (trace.agent_id !== batch.agentId || trace.trace_id !== batch.traceId) {
    throw new Error('Trace 复合标识不匹配');
  }
  const result = trace.audit_result;
  const expectedRisk = batch.kind === 'high-risk' ? 'high' : batch.kind === 'medium-risk' ? 'medium' : 'none';
  const expectedStatus = batch.kind === 'high-risk' ? 'failed' : 'success';
  if (!result || result.review_version < 1 || result.trace_status !== expectedStatus
    || result.risk_level !== expectedRisk) {
    throw new Error(`${batch.kind} Trace 结论不符合预期：${result?.trace_status}/${result?.risk_level}`);
  }
  if (trace.events?.length !== batch.events.length) throw new Error('Trace 事件不完整');
}

async function waitForReview(batch, config, runtime) {
  const attempts = Math.max(1, Math.ceil(config.reviewTimeoutMs / config.pollIntervalMs));
  const query = new URLSearchParams({ agent_id: batch.agentId, trace_id: batch.traceId });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await requestJson(`${config.baseUrl}/v1/audit-logs?${query}`, {
      method: 'GET', headers: { authorization: `Bearer ${config.token}` },
    }, runtime);
    const trace = response.traces?.find(row => row.agent_id === batch.agentId && row.trace_id === batch.traceId);
    if (trace?.audit_result?.review_version > 0) {
      validateBatchReview(batch, trace);
      return trace;
    }
    await runtime.sleepImpl(config.pollIntervalMs);
  }
  throw new Error(`${batch.kind} 等待 Trace 审查超时：${batch.traceId}`);
}

function readConfig(env) {
  return {
    baseUrl: normalizeBaseUrl(env.AUDIT_DEMO_BASE_URL),
    token: env.AUDIT_AGENT_DASHBOARD_TOKEN,
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

  if (!config.token) throw new Error('需要 AUDIT_AGENT_DASHBOARD_TOKEN 读取 Trace 审查结果');
  log(`审计服务：${config.baseUrl}`);
  log('发送正常、工具失败后恢复、任务失败三条模拟 Trace；通知由服务端配置决定。');
  const health = await getHealth(config, runtime);
  if (health.status !== 'ok' || health.db?.writable !== true) {
    throw new Error('审计服务健康检查未通过或数据库不可写');
  }
  const result = { baseUrl: config.baseUrl };
  for (const [key, kind] of [['normal', 'normal'], ['mediumRisk', 'medium-risk'], ['highRisk', 'high-risk']]) {
    const batch = buildDemoTrace(kind, { nowMs: nowImpl(), idFactory, randomIntImpl });
    await sendBatch(batch, config, runtime);
    const trace = await waitForReview(batch, config, runtime);
    result[key] = {
      traceId: batch.traceId, agentId: batch.agentId, scenarioName: batch.scenarioName,
      toolName: batch.toolName, entity: batch.entity, auditResult: trace.audit_result,
      dashboardUrl: `${config.baseUrl}/dashboard/agents/${encodeURIComponent(batch.agentId)}/traces/${encodeURIComponent(batch.traceId)}`,
    };
    log(`${kind} 验证通过：${trace.audit_result.trace_status}/${trace.audit_result.risk_level}`);
  }
  return result;
}

function printHelp() {
  console.log(`用法：npm run demo:audit-logs

发送正常、失败后恢复、任务失败三类日志，通过 Trace API 验证 none/medium/high 结论。
通知行为由服务端 live/sink/dry-run 配置决定，本脚本不将全局 Outbox 清空视为投递成功。

环境变量：
  AUDIT_DEMO_BASE_URL          审计服务基地址（本地验证请指定本地 sink/dry-run 服务）
  AUDIT_AGENT_DASHBOARD_TOKEN  Trace 读取 API 的 Bearer token
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
  for (const key of ['normal', 'mediumRisk', 'highRisk']) {
    console.log(`${key}：${result[key].auditResult.risk_level}｜${result[key].dashboardUrl}`);
  }
}

const directEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (directEntry) {
  main().catch((error) => {
    console.error(`演示失败：${error.message}`);
    process.exitCode = 1;
  });
}
