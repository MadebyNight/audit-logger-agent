import {
  estimateTokensForPayload,
  llmBudgetFromConfig,
  llmUsageDayKey,
  usageWouldExceedBudget,
} from './llmBudget.js';
import { readTraceDetail } from './traceReadService.js';

// src/auditReview/visualization.js
// Build direct-data view models for the dashboard pages.
// The template receives fully-populated sections (rows/items/links) - no browser-side fetch.

const SEVERITY_LABELS = { critical: '高风险', high: '高风险', medium: '中风险', low: '低风险' };

// Compatibility applies only to legacy Finding projections, never Trace conclusions.
function findingSeverity(value) { return value === 'critical' ? 'high' : value; }

function projectFinding(row) {
  return row ? {
    ...row,
    raw_severity: row.raw_severity ?? row.severity,
    severity: findingSeverity(row.severity),
    max_severity: findingSeverity(row.max_severity),
  } : row;
}
const STATUS_LABELS = {
  open: '待处理',
  acknowledged: '已确认',
  snoozed: '已暂缓',
  resolved: '已解决',
  completed: '已完成',
  completed_degraded: '降级完成',
  failed: '失败',
  running: '运行中',
  skipped: '已跳过',
  OK: '正常',
  INTERNAL: '内部错误',
};
const CATEGORY_LABELS = {
  high_risk_permission: '高风险权限',
  anomalous_call: '异常调用',
  repeated_call: '重复调用',
  failed_call: '失败调用',
  trace_integrity: '链路完整性',
  ingest_parse_error: '日志解析错误',
};
const ACTION_LABELS = {
  acknowledge: '确认',
  snooze: '暂缓',
  resolve: '解决',
  reopen: '重新打开',
  recurrence: '复发重开',
  snooze_expired: '暂缓到期',
};
const TRACE_DISPLAY_STEP_LIMIT = 20;
const TRACE_ANALYSIS_STEP_LIMIT = 20;
const TRACE_ABNORMAL_STEP_THRESHOLD = 50;
const AGENT_LOG_PAGE_SIZE = 100;

const OVERVIEW_FINDINGS_COLUMNS = [
  { key: 'title', label: '风险标题 / 类别', priority: 'primary' },
  { key: 'agent_tool', label: 'Agent / Tool', priority: 'primary' },
  { key: 'severity_label', label: '严重级别', priority: 'primary' },
  { key: 'last_seen_at', label: '最近出现', priority: 'secondary' },
  { key: 'status', label: '状态', priority: 'primary' },
  { key: 'details', label: '详情', priority: 'secondary' },
];

const REVIEW_FINDINGS_COLUMNS = [
  { key: 'title', label: '风险标题 / 类别', priority: 'primary' },
  { key: 'agent_tool', label: 'Agent / Tool', priority: 'primary' },
  { key: 'severity_label', label: '严重级别', priority: 'primary' },
  { key: 'status', label: '状态', priority: 'primary' },
  { key: 'occurrence_flags', label: '本次出现', priority: 'secondary' },
  { key: 'evidence_count', label: '证据', priority: 'metadata' },
  { key: 'details', label: '详情', priority: 'secondary' },
];

const REVIEWS_TABLE_COLUMNS = [
  { key: 'review_id', label: '审查批次', priority: 'primary' },
  { key: 'status_label', label: '状态', priority: 'primary' },
  { key: 'time_window', label: '时间窗口', priority: 'secondary' },
  { key: 'finding_count', label: '发现数', priority: 'primary' },
  { key: 'trigger_type', label: '触发方式', priority: 'metadata' },
  { key: 'finished_at', label: '完成时间', priority: 'metadata' },
];

const AGENT_INDEX_COLUMNS = [
  { key: 'agent_id', label: 'Agent ID', priority: 'primary' },
  { key: 'event_count', label: '接收日志数', priority: 'secondary' },
  { key: 'open_finding_count', label: '待处理发现', priority: 'primary' },
  { key: 'finding_count', label: '累计发现', priority: 'metadata' },
  { key: 'last_event_at', label: '最新日志时间', priority: 'secondary' },
];

const AGENT_LOG_COLUMNS = [
  { key: 'timestamp', label: '时间', priority: 'primary' },
  { key: 'event', label: '事件', priority: 'primary' },
  { key: 'tool_name', label: '工具', priority: 'primary' },
  { key: 'status', label: '状态', priority: 'primary' },
  { key: 'severity', label: '严重级别', priority: 'primary' },
  { key: 'duration_ms', label: '耗时', priority: 'secondary' },
  { key: 'trace_id', label: 'Trace ID', priority: 'secondary' },
  { key: 'span_id', label: 'Span ID', priority: 'metadata' },
  { key: 'summary', label: '摘要', priority: 'secondary' },
  { key: 'error_message', label: '错误', priority: 'metadata' },
];

const FILTER_QUERY_KEYS = [
  ['agentId', 'agent_id'],
  ['severity', 'severity'],
  ['category', 'category'],
  ['status', 'status'],
  ['reviewId', 'review_id'],
  ['sort', 'sort'],
  ['logPage', 'log_page'],
  ['logEvent', 'log_event'],
  ['logToolName', 'log_tool_name'],
  ['logTraceId', 'log_trace_id'],
  ['logStatus', 'log_status'],
];

const TRACE_ANALYSIS_SYSTEM_PROMPT = [
  'You analyze audit-log tool call traces for a Chinese audit dashboard.',
  'Return ONLY a JSON object matching the schema. No markdown, no prose outside JSON.',
  'Explain the likely purpose of the tool calls, the call order, and risks visible in the trace.',
  'All narrative fields MUST be written in Simplified Chinese. Keep tool names, IDs, trace IDs, and error codes verbatim.',
  'Do not invent events or outcomes that are not present in the provided trace.',
].join('\n');

function traceAnalysisJsonSchema() {
  return {
    type: 'json_schema',
    name: 'audit_trace_analysis',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purpose: { type: 'string', maxLength: 300 },
        chain_summary: { type: 'string', maxLength: 500 },
        risk_points: {
          type: 'array',
          items: { type: 'string', maxLength: 220 },
          maxItems: 5,
        },
        next_actions: {
          type: 'array',
          items: { type: 'string', maxLength: 220 },
          maxItems: 5,
        },
      },
      required: ['purpose', 'chain_summary', 'risk_points', 'next_actions'],
    },
  };
}
function defaultVisualizationConfig(config) {
  return config?.auditReview?.visualization ?? {};
}

function nowIso() {
  return new Date().toISOString();
}

function validTimezoneOffset(value, fallback = 480) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= -1440 && parsed <= 1440 ? parsed : fallback;
}

function manualReportPreview(generatedAt, timezoneOffsetMinutes) {
  const parsed = new Date(generatedAt);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const shifted = new Date(date.getTime() + timezoneOffsetMinutes * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return {
    date: `${year}-${month}-${day}`,
    cutoff: `${hour}:${minute}`,
  };
}

function previewLocalTime(value, fallback) {
  const match = String(value ?? '').match(/(?:^|[T\s])(\d{2}):(\d{2})(?::\d{2})?/);
  return match ? `${match[1]}:${match[2]}` : fallback;
}

function labelOf(map, value) {
  if (value === null || value === undefined) return '';
  return map[value] ?? String(value);
}

function isPresent(value) {
  return value !== '' && value !== null && value !== undefined;
}

function formatTime(iso) {
  return iso ? String(iso) : '';
}

function severityRank(severity) {
  switch (severity) {
    case 'critical': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'low': return 1;
    default: return 0;
  }
}

function severityTone(severity) {
  severity = findingSeverity(severity);
  return ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'neutral';
}

function statusTone(status) {
  switch (status) {
    case 'completed':
    case 'resolved':
    case 'OK':
      return 'success';
    case 'completed_degraded':
      return 'medium';
    case 'failed':
    case 'INTERNAL':
      return 'critical';
    case 'open':
      return 'high';
    case 'snoozed':
      return 'low';
    case 'acknowledged':
    case 'running':
    case 'skipped':
    default:
      return 'neutral';
  }
}

function triggerLabel(triggerType) {
  if (triggerType === 'scheduled') return '定时审查';
  if (triggerType === 'manual') return '手动触发';
  if (triggerType === 'ingest') return '接收日志';
  return triggerType ?? '-';
}

function compareByIsoDesc(left, right) {
  const a = left ? Date.parse(left) : Number.NEGATIVE_INFINITY;
  const b = right ? Date.parse(right) : Number.NEGATIVE_INFINITY;
  return b - a;
}

function compareTraceEventsAsc(left, right) {
  const a = left?.ts ? Date.parse(left.ts) : Number.POSITIVE_INFINITY;
  const b = right?.ts ? Date.parse(right.ts) : Number.POSITIVE_INFINITY;
  if (a !== b) return a - b;
  const leftId = Number(left?.id ?? left?.event_id ?? 0);
  const rightId = Number(right?.id ?? right?.event_id ?? 0);
  return leftId - rightId;
}

function orderedTraceEvents(events) {
  return Array.isArray(events) ? events.slice().sort(compareTraceEventsAsc) : [];
}

function compareFindings(left, right) {
  const severityDelta = severityRank(right?.severity) - severityRank(left?.severity);
  if (severityDelta !== 0) return severityDelta;
  const leftOpen = left?.status === 'open' ? 1 : 0;
  const rightOpen = right?.status === 'open' ? 1 : 0;
  if (rightOpen !== leftOpen) return rightOpen - leftOpen;
  return compareByIsoDesc(lastSeenAtOf(left), lastSeenAtOf(right));
}

function compareFindingsByTime(left, right) {
  const timeDelta = compareByIsoDesc(lastSeenAtOf(left), lastSeenAtOf(right));
  if (timeDelta !== 0) return timeDelta;
  return severityRank(right?.severity) - severityRank(left?.severity);
}

function formatWindow(run) {
  const from = formatTime(run?.window_from);
  const to = formatTime(run?.window_to);
  if (from && to) return `${from} ~ ${to}`;
  return from || to || '-';
}

function evidenceTimestamp(ev) {
  return ev?.log_detail?.ts ?? ev?.ts ?? '';
}

function evidenceEventIdsOf(finding) {
  if (Array.isArray(finding?.evidence_event_ids) && finding.evidence_event_ids.length > 0) {
    return finding.evidence_event_ids;
  }
  if (!Array.isArray(finding?.evidence)) return [];
  return finding.evidence.map((ev) => ev?.event_id).filter((eventId) => eventId !== null && eventId !== undefined);
}

function lastSeenAtOf(finding) {
  if (finding?.last_seen_at) return finding.last_seen_at;
  if (!Array.isArray(finding?.evidence)) return '';
  return finding.evidence
    .map((ev) => evidenceTimestamp(ev))
    .filter(Boolean)
    .sort((a, b) => compareByIsoDesc(a, b))[0] ?? '';
}

function traceSequenceSteps(events) {
  return orderedTraceEvents(events).slice(0, TRACE_DISPLAY_STEP_LIMIT).map((event, index) => ({
    order: index + 1,
    timestamp: formatTime(event.ts),
    event: event.event ?? '',
    status: {
      text: labelOf(STATUS_LABELS, event.status),
      tone: statusTone(event.status),
    },
    tool_name: event.tool_name ?? '',
    span_id: event.span_id ?? '',
    parent_span_id: event.parent_span_id ?? '',
    duration_ms: isPresent(event.duration_ms) ? `${event.duration_ms} ms` : '',
    summary: event.result_summary ?? '',
    error_message: event.error_message ?? '',
  }));
}

function compactTraceEventForLlm(event, index) {
  return {
    order: index + 1,
    event_id: event.id ?? event.event_id ?? null,
    ts: event.ts ?? null,
    event: event.event ?? null,
    status: event.status ?? null,
    tool_name: event.tool_name ?? null,
    trace_id: event.trace_id ?? null,
    span_id: event.span_id ?? null,
    parent_span_id: event.parent_span_id ?? null,
    duration_ms: event.duration_ms ?? null,
    result_summary: event.result_summary ?? null,
    error_message: event.error_message ?? null,
  };
}

function buildTraceAnalysisInput({ finding, traceEvents }) {
  const orderedEvents = orderedTraceEvents(traceEvents);
  const analysisEvents = orderedEvents.slice(0, TRACE_ANALYSIS_STEP_LIMIT);
  const payload = {
    finding: {
      finding_id: finding.finding_id ?? null,
      title: finding.title ?? null,
      severity: finding.severity ?? null,
      category: finding.category ?? null,
      summary: finding.summary ?? null,
      recommendation: finding.recommendation ?? null,
      agent_id: finding.agent_id ?? null,
      agent_name: finding.agent_name ?? null,
      tool_name: finding.tool_name ?? null,
      trace_id: finding.trace_id ?? null,
      entity: finding.entity ?? (
        finding.entity_type || finding.entity_id
          ? { type: finding.entity_type ?? null, id: finding.entity_id ?? null }
          : null
      ),
    },
    trace_event_count: orderedEvents.length,
    analyzed_trace_event_count: analysisEvents.length,
    trace_events_truncated: orderedEvents.length > analysisEvents.length,
    trace_events: analysisEvents.map(compactTraceEventForLlm),
  };

  return [
    { role: 'system', content: TRACE_ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

function boundedText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function boundedTextList(value, { maxItems, maxLength }) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => boundedText(item, maxLength))
    .filter(isPresent)
    .slice(0, maxItems);
}

function localTraceChainSummary(traceEvents) {
  const orderedEvents = orderedTraceEvents(traceEvents);
  if (orderedEvents.length === 0) return '';
  const chain = orderedEvents.map((event, index) => {
    const toolName = event.tool_name ?? '未知工具';
    const eventName = event.event ?? '未知事件';
    const status = labelOf(STATUS_LABELS, event.status) || event.status || '未知状态';
    return `${index + 1}. ${toolName} ${eventName}: ${status}`;
  }).join(' -> ');
  const errors = orderedEvents.map((event) => event.error_message).filter(isPresent);
  const lastError = errors[errors.length - 1];
  return lastError ? `调用链路：${chain}。最后错误：${lastError}` : `调用链路：${chain}`;
}

function normalizeTraceAnalysis(raw, traceEvents = []) {
  if (!raw || typeof raw !== 'object') throw new Error('LLM 链路分析结果不是对象');
  const analysis = {
    purpose: boundedText(raw.purpose, 300),
    chain_summary: boundedText(raw.chain_summary, 500) || localTraceChainSummary(traceEvents),
    risk_points: boundedTextList(raw.risk_points, { maxItems: 5, maxLength: 220 }),
    next_actions: boundedTextList(raw.next_actions, { maxItems: 5, maxLength: 220 }),
  };
  if (!isPresent(analysis.purpose) && !isPresent(analysis.chain_summary)) {
    throw new Error('LLM 链路分析缺少 purpose 或 chain_summary');
  }
  return analysis;
}

function isFreshAnalysisCache(finding) {
  if (!finding?.llm_analysis || typeof finding.llm_analysis !== 'object') return false;
  if (!isPresent(finding.analysis_generated_at)) return false;
  if (!isPresent(finding.last_seen_at)) return true;
  const generatedAt = Date.parse(finding.analysis_generated_at);
  const lastSeenAt = Date.parse(finding.last_seen_at);
  if (!Number.isFinite(generatedAt)) return false;
  if (!Number.isFinite(lastSeenAt)) return true;
  return generatedAt >= lastSeenAt;
}

function traceAnalysisSection({ analysis, model }) {
  return {
    id: 'trace_llm_analysis',
    title: 'LLM 链路分析',
    type: 'trace_analysis',
    model,
    ...analysis,
  };
}

function traceAnalysisUnavailableSection(message) {
  return {
    id: 'trace_llm_analysis',
    title: 'LLM 分析不可用',
    type: 'callout',
    body: message,
  };
}

function traceAbnormalSection(totalSteps) {
  return {
    id: 'trace_sequence_abnormal',
    title: '异常情况',
    type: 'callout',
    body: `该 Trace 工具链共 ${totalSteps} 步，超过 ${TRACE_ABNORMAL_STEP_THRESHOLD} 步阈值。Dashboard 仅展示前 ${TRACE_DISPLAY_STEP_LIMIT} 步，LLM 链路分析不会继续调用。`,
  };
}

function traceSequenceTitle(totalSteps, visibleSteps) {
  if (totalSteps > visibleSteps) {
    return `工具调用顺序（显示前 ${visibleSteps} 步，共 ${totalSteps} 步）`;
  }
  return `工具调用顺序（共 ${visibleSteps} 步）`;
}

function insertSectionBefore(sections, anchorId, section) {
  const anchorIndex = sections.findIndex((item) => item?.id === anchorId);
  const insertIndex = anchorIndex >= 0 ? anchorIndex : sections.length;
  sections.splice(insertIndex, 0, section);
}

function parseJsonValue(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function evidenceOfOccurrence(occurrence) {
  if (Array.isArray(occurrence?.evidence)) return occurrence.evidence;
  const snapshot = parseJsonValue(occurrence?.evidence_json, null);
  if (Array.isArray(snapshot)) return snapshot;
  if (Array.isArray(snapshot?.evidence)) return snapshot.evidence;
  if (Array.isArray(snapshot?.events)) return snapshot.events;
  if (Array.isArray(snapshot?.details)) return snapshot.details;
  return snapshot && typeof snapshot === 'object' ? [snapshot] : [];
}

function occurrenceFlags(occurrence) {
  const labels = [];
  if (occurrence?.is_new === true || occurrence?.is_new === 1) labels.push('首次发现');
  else labels.push('重复出现');
  if (occurrence?.severity_escalated === true || occurrence?.severity_escalated === 1) labels.push('严重级别上升');
  if (occurrence?.reopened === true || occurrence?.reopened === 1) labels.push('已解决后复发');
  return labels.join(' · ');
}

function rawSnapshotSnippets(occurrences) {
  const snippets = [];
  for (const occurrence of occurrences) {
    const occurrenceId = occurrence?.occurrence_id ?? '历史记录';
    for (const [index, evidence] of evidenceOfOccurrence(occurrence).entries()) {
      const body = evidence?.raw_json ?? evidence?.log_detail?.raw_json;
      if (!isPresent(body)) continue;
      const eventId = evidence?.event_id ?? evidence?.id;
      snippets.push({
        label: `${occurrenceId}${isPresent(eventId) ? ` / 日志 ID ${eventId}` : ` / 证据 ${index + 1}`}`,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    }
  }
  return snippets;
}

function occurrenceMatchesFilters(row, filters = {}) {
  if (filters.agentId && row.agent_id !== filters.agentId) return false;
  if (filters.severity === 'critical' && row.raw_severity !== 'critical') return false;
  if (filters.severity && filters.severity !== 'critical' && findingSeverity(row.severity) !== findingSeverity(filters.severity)) return false;
  if (filters.category && row.category !== filters.category) return false;
  if (filters.status && row.status !== filters.status) return false;
  return true;
}

function actionNotice(notice, action) {
  if (!notice) return [];
  if (notice === 'action_success') {
    return [{ tone: 'success', title: '操作已完成', body: `${ACTION_LABELS[action] ?? '状态操作'}已保存，Finding 状态和操作历史已更新。` }];
  }
  const messages = {
    finding_version_conflict: 'Finding 已被其他操作更新，请核对当前状态后重试。',
    finding_state_conflict: '当前状态不允许执行该操作，请核对最新状态。',
    invalid_finding_action: '提交的动作参数无效，请补全必填信息后重试。',
    finding_not_found: 'Finding 不存在或已被清理。',
    finding_lifecycle_unavailable: 'Finding 生命周期服务当前不可用。',
  };
  return [{ tone: 'critical', title: '操作未完成', body: messages[notice] ?? '处理操作时发生内部错误，请稍后重试。' }];
}

export function createVisualization({ reviewStore, traceStore, db, config, llmClient, model } = {}) {
  const vizConfig = defaultVisualizationConfig(config);
  const baseUrl = vizConfig.baseUrl ?? 'http://127.0.0.1:9320';
  const dashboardPath = vizConfig.dashboardPath ?? '/dashboard';
  const dailyReportPath = `${dashboardPath.replace(/\/$/, '')}/daily-report/send`;
  const timezoneOffsetMinutes = validTimezoneOffset(
    config?.auditReview?.notification?.dailyReport?.timezoneOffsetMinutes
      ?? config?.report?.timezoneOffsetMinutes,
  );
  const traceAnalysisModel = model ?? config?.auditReview?.llmReview?.model ?? config?.planner?.model ?? null;
  const cacheDetailAnalysis = config?.auditReview?.llmBudget?.cacheDetailAnalysis !== false;
  const llmBudget = llmBudgetFromConfig(config);

  function dashboardUrlFor(agentOrReviewId, traceId) {
    if (agentOrReviewId && typeof agentOrReviewId === 'object') {
      return `${baseUrl.replace(/\/$/, '')}${traceUrl(agentOrReviewId.agent_id, agentOrReviewId.trace_id)}`;
    }
    if (traceId !== undefined) return `${baseUrl.replace(/\/$/, '')}${traceUrl(agentOrReviewId, traceId)}`;
    return `${baseUrl}${dashboardPath}/audit-reviews/${encodeURIComponent(agentOrReviewId)}`;
  }

  function findingUrlFor(findingId) {
    return `${baseUrl}${dashboardPath}/audit-findings/${encodeURIComponent(findingId)}`;
  }

  function reviewUrl(reviewId) {
    return `${dashboardPath}/audit-reviews/${encodeURIComponent(reviewId)}`;
  }

  function findingUrl(findingId) {
    return `${dashboardPath}/audit-findings/${encodeURIComponent(findingId)}`;
  }

  function urlWithFilters(path, filters = {}, anchor) {
    const params = new URLSearchParams();
    for (const [property, queryKey] of FILTER_QUERY_KEYS) {
      if (isPresent(filters[property])) params.set(queryKey, filters[property]);
    }
    const query = params.toString();
    return `${path}${query ? `?${query}` : ''}${anchor ? `#${anchor}` : ''}`;
  }

  function dashboardFilterUrl(filters = {}, anchor = 'pending_findings') {
    return urlWithFilters(dashboardPath, filters, anchor);
  }

  function reviewFilterUrl(reviewId, filters = {}, anchor = 'review_findings') {
    return urlWithFilters(reviewUrl(reviewId), filters, anchor);
  }

  function replaceFilter(filters, key, value) {
    return { ...filters, [key]: isPresent(value) ? value : undefined };
  }

  function filterOptions({ values, currentValue, filters, key, hrefFor, allLabel, includeAll = true }) {
    return [
      ...(includeAll ? [{
        value: '',
        label: allLabel,
        href: hrefFor(replaceFilter(filters, key, undefined)),
        active: !isPresent(currentValue),
      }] : []),
      ...values.map(([value, label]) => ({
        value,
        label,
        href: hrefFor(replaceFilter(filters, key, value)),
        active: currentValue === value,
      })),
    ];
  }

  function findingFiltersViewModel({ filters, hrefFor, includeSort = false, agentLogMode = false }) {
    const definitions = [
      {
        id: 'severity',
        label: agentLogMode ? '日志风险等级' : '严重级别',
        values: Object.entries(SEVERITY_LABELS).filter(([value]) => value !== 'critical'),
        allLabel: '全部严重级别',
      },
      {
        id: 'category',
        label: agentLogMode ? '关联风险类别' : '类别',
        values: Object.entries(CATEGORY_LABELS),
        allLabel: '全部类别',
      },
      {
        id: 'status',
        label: agentLogMode ? '关联风险状态' : '状态',
        values: ['open', 'acknowledged', 'snoozed', 'resolved'].map((status) => [status, STATUS_LABELS[status]]),
        allLabel: '全部状态',
      },
    ];
    if (includeSort) {
      definitions.push({
        id: 'sort',
        label: '日志排序',
        values: [
          ['time_desc', '按时间排序'],
          ['severity_desc', '按严重级别排序'],
        ],
        allLabel: '按时间排序',
        includeAll: false,
      });
    }

    return definitions.map((definition) => {
      const currentValue = definition.id === 'sort'
        ? (filters.sort ?? 'time_desc')
        : filters[definition.id];
      const labelMap = definition.id === 'severity'
        ? SEVERITY_LABELS
        : definition.id === 'category'
          ? CATEGORY_LABELS
          : STATUS_LABELS;
      return {
        id: definition.id,
        label: definition.label,
        value: currentValue ?? '',
        active_label: isPresent(currentValue)
          ? (definition.values.find(([value]) => value === currentValue)?.[1] ?? labelOf(labelMap, currentValue))
          : definition.allLabel,
        clear_href: definition.id === 'sort'
          ? undefined
          : hrefFor(replaceFilter(filters, definition.id, undefined), definition.id),
        options: filterOptions({
          values: definition.values,
          currentValue,
          filters,
          key: definition.id,
          hrefFor: (nextFilters) => hrefFor(nextFilters, definition.id),
          allLabel: definition.allLabel,
          includeAll: definition.includeAll,
        }),
      };
    });
  }

  function agentDashboardUrl(agentId) {
    return `${dashboardPath.replace(/\/$/, '')}/agents/${encodeURIComponent(agentId)}`;
  }

  function manualDailyReportPage({ status } = {}) {
    const statusOffset = validTimezoneOffset(
      status?.timezoneOffsetMinutes ?? status?.timezone_offset_minutes,
      timezoneOffsetMinutes,
    );
    const generatedAt = status?.window?.to ?? nowIso();
    const preview = manualReportPreview(generatedAt, statusOffset);
    const reportDate = isPresent(status?.date) ? String(status.date) : preview.date;
    const cutoff = previewLocalTime(status?.localTime ?? status?.local_time, preview.cutoff);
    const allowed = status?.allowed !== false;
    const unavailableReason = isPresent(status?.message)
      ? String(status.message)
      : '当前状态暂不可发送日报，请返回 Dashboard 稍后重试。';
    return {
      page: {
        title: '确认发送当前日报',
        subtitle: '核对统计范围后确认操作。',
        updated_at: generatedAt,
        breadcrumbs: [
          { label: '总览', href: dashboardPath },
          { label: '当前日报' },
        ],
        notification_status: status,
      },
      summary_metrics: [],
      filters: [],
      sections: [{
        id: 'manual_daily_report_confirmation',
        type: 'confirmation',
        title: '发送当前日报',
        description: allowed
          ? '确认后将生成截至当前时刻的全局日报，并进入飞书通知流程。'
          : unavailableReason,
        allowed,
        items: [
          { label: '操作', value: '发送当前日报' },
          { label: '统计日期', value: `${reportDate}（北京时间）` },
          { label: '统计范围', value: `00:00 至 ${cutoff}` },
          { label: '覆盖范围', value: '全部 Agent 与业务链路' },
        ],
        form: allowed ? {
          method: 'post',
          action: dailyReportPath,
          submit_label: '确认发送',
          cancel_label: '返回',
          cancel_href: dashboardPath,
        } : {
          cancel_label: '返回',
          cancel_href: dashboardPath,
        },
      }],
    };
  }

  function countOpenFindingsBySeverity(filters = {}) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    try {
      for (const severity of Object.keys(counts)) {
        const rows = reviewStore.listFindings({ limit: 1000, ...filters, severity, status: 'open' });
        counts[findingSeverity(severity)] += Array.isArray(rows) ? rows.length : 0;
      }
    } catch {
      // reviewStore may throw or return a non-array count; keep zero defaults.
    }
    return counts;
  }

  function listAgents(limit = 1000) {
    try {
      return reviewStore.listAgents?.({ limit }) ?? [];
    } catch {
      return [];
    }
  }

  function getDeadLetterCount() {
    try {
      return reviewStore.listDeadLetterCount?.() ?? 0;
    } catch {
      return 0;
    }
  }

  function listRuns(limit = 20) {
    try {
      return reviewStore.listRuns?.({ limit }) ?? [];
    } catch {
      return [];
    }
  }

  function listFindings(limit = 1000, filters = {}) {
    try {
      const rows = reviewStore.listFindings?.({ limit, ...filters }) ?? [];
      const legacy = filters.severity === 'high'
        ? reviewStore.listFindings?.({ limit, ...filters, severity: 'critical' }) ?? [] : [];
      return [...new Map([...rows, ...legacy].map((row) => [row.finding_id, projectFinding(row)])).values()];
    } catch {
      return [];
    }
  }

  function getRun(reviewId) {
    try {
      return reviewStore.getRun?.(reviewId) ?? null;
    } catch {
      return null;
    }
  }

  function getFinding(findingId) {
    try {
      return projectFinding(reviewStore.getFinding?.(findingId)) ?? null;
    } catch {
      return null;
    }
  }

  function listFindingOccurrences(findingId, limit = 1000) {
    if (typeof reviewStore.listFindingOccurrences !== 'function') return null;
    try {
      const rows = reviewStore.listFindingOccurrences({ findingId, limit });
      return Array.isArray(rows) ? rows.map(projectFinding) : [];
    } catch {
      return [];
    }
  }

  function listFindingActions(findingId, limit = 1000) {
    if (typeof reviewStore.listFindingActions !== 'function') return null;
    try {
      const rows = reviewStore.listFindingActions({ findingId, limit });
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function listReviewOccurrences(reviewId, limit = 1000) {
    if (typeof reviewStore.listReviewOccurrences !== 'function') return null;
    try {
      const rows = reviewStore.listReviewOccurrences({ reviewId, limit });
      return Array.isArray(rows) ? rows.map(projectFinding) : [];
    } catch {
      return [];
    }
  }

  function listTraceEvents(traceId, limit = 200) {
    if (!traceId) return [];
    try {
      const rows = reviewStore.listTraceEvents?.({ traceId, limit }) ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function listRawEventsByIds(eventIds, limit = 200) {
    if (!Array.isArray(eventIds) || eventIds.length === 0) return [];
    try {
      const rows = reviewStore.listRawEventsByIds?.({ eventIds, limit }) ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function listAgentEvents(agentId, {
    limit = AGENT_LOG_PAGE_SIZE,
    offset = 0,
    sort = 'time_desc',
    logEvent,
    logToolName,
    logTraceId,
    logStatus,
    severity,
    category,
    status,
  } = {}) {
    if (!agentId) return [];
    try {
      const rows = reviewStore.listAgentEvents?.({
        agentId,
        limit,
        offset,
        sort,
        logEvent,
        logToolName,
        logTraceId,
        logStatus,
        severity,
        category,
        status,
      }) ?? [];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  function countAgentEvents(agentId, {
    logEvent,
    logToolName,
    logTraceId,
    logStatus,
    severity,
    category,
    status,
  } = {}) {
    if (!agentId) return 0;
    try {
      const count = Number(reviewStore.countAgentEvents?.({
        agentId,
        logEvent,
        logToolName,
        logTraceId,
        logStatus,
        severity,
        category,
        status,
      }) ?? 0);
      return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
    } catch {
      return 0;
    }
  }

  function reserveDetailAnalysisBudget({ day, estimatedTokens }) {
    if (typeof reviewStore.reserveLlmUsage === 'function') {
      try {
        const reservation = reviewStore.reserveLlmUsage({
          day,
          calls: 1,
          estTokens: estimatedTokens,
          maxCallsPerDay: llmBudget.maxCallsPerDay,
          maxTokensPerDay: llmBudget.maxTokensPerDay,
        });
        return reservation?.reserved === true;
      } catch {
        return false;
      }
    }

    const usage = reviewStore.getLlmUsage?.(day) ?? { day, calls: 0, est_tokens: 0 };
    if (usageWouldExceedBudget(usage, llmBudget, estimatedTokens)) return false;
    if (typeof reviewStore.recordLlmUsage === 'function') {
      try {
        reviewStore.recordLlmUsage({ day, calls: 1, estTokens: estimatedTokens });
      } catch {
        return false;
      }
    }
    return true;
  }

  function rawLogSnippets(events) {
    return events
      .filter((event) => isPresent(event?.raw_json))
      .map((event) => ({
        label: `日志 ID ${event.id}`,
        body: event.raw_json,
      }));
  }

  function agentIndexPage() {
    const agents = listAgents(1000);
    const updatedAt = nowIso();

    const rows = agents.map((agent) => ({
      agent_id: {
        text: agent.agent_id ?? '',
        href: agent.agent_id ? agentDashboardUrl(agent.agent_id) : undefined,
        mono: false,
      },
      last_event_at: {
        text: formatTime(agent.last_event_at),
        mono: true,
      },
    }));

    const sections = rows.length > 0
      ? [{
          id: 'received_agents',
          title: '已接收日志的 Agent',
          type: 'table',
          columns: AGENT_INDEX_COLUMNS.filter((column) => ['agent_id', 'last_event_at'].includes(column.key)),
          rows,
        }]
      : [{
          id: 'empty_agents',
          title: '暂无 Agent 日志',
          type: 'callout',
          body: '当前数据库还没有接收到任何 Agent 日志。日志写入后，这里会展示对应的 Agent ID。',
        }];

    return {
      page: {
        title: 'Agent 日志入口',
        subtitle: '选择已接收日志的 Agent，进入对应的日志审计结果。',
        updated_at: updatedAt,
        breadcrumbs: [{ label: 'Agent 列表', href: '/' }],
        task_audit: true,
        agent_index: true,
        context_badges: [],
        page_actions: [],
      },
      summary_metrics: [
        { label: 'Agent 数', value: agents.length, tone: 'neutral' },
      ],
      filters: [],
      sections,
    };
  }

  function traceUrl(agentId, traceId) {
    return `${agentDashboardUrl(agentId)}/traces/${encodeURIComponent(traceId)}`;
  }

  function requesterUrl(agentId, requesterId) {
    return requesterId ? `${agentDashboardUrl(agentId)}/requesters/${encodeURIComponent(requesterId)}`
      : `${agentDashboardUrl(agentId)}?requester_id=`;
  }

  function taskState(trace) {
    if (!trace.sealed_at) return { text: '审查中', tone: 'neutral' };
    if (!Number(trace.review_version)) return { text: '未审查', tone: 'neutral' };
    if (trace.risk_level === 'high') return { text: '需要介入', tone: 'high' };
    if (trace.trace_status === 'incomplete') return { text: '待确认', tone: 'medium' };
    return { text: '已完成', tone: 'neutral' };
  }

  function taskRows(traces) {
    return traces.map((trace) => ({
      href: traceUrl(trace.agent_id, trace.trace_id),
      request: trace.original_request || '未提供原始请求',
      trace_id: trace.trace_id,
      time: trace.last_event_at,
      state: taskState(trace),
      incomplete: !trace.requester_id || trace.context_status === 'incomplete_context',
    }));
  }

  function agentTraces(agentId) {
    const traces = db ? db.prepare('SELECT * FROM audit_traces WHERE agent_id = ?').all(agentId)
      : traceStore.listTraces({ agentId });
    return traces.slice().sort((a, b) =>
      String(b.last_event_at ?? '').localeCompare(String(a.last_event_at ?? ''))
      || String(a.trace_id).localeCompare(String(b.trace_id)));
  }

  function taskPage(title, agentId, subtitle = '') {
    return {
      page: { title, subtitle, task_audit: true, updated_at: nowIso(),
        breadcrumbs: [{ label: 'Agent', href: '/' }, { label: agentId, href: agentDashboardUrl(agentId) }] },
      summary_metrics: [], filters: [], sections: [],
    };
  }

  function agentPage(agentId, { search = '', groups = 20, requesterId, page: requestedPage } = {}) {
    if (requesterId !== undefined) return requesterTasksPage(agentId, requesterId, { page: requestedPage });
    const traces = agentTraces(agentId);
    const grouped = new Map();
    for (const trace of traces) {
      const key = trace.requester_id || '';
      if (!grouped.has(key)) grouped.set(key, { requester_id: key,
        name: trace.requester_name || key || '发起人未知', traces: [] });
      grouped.get(key).traces.push(trace);
    }
    const query = String(search).trim().toLocaleLowerCase();
    const matches = [...grouped.values()].filter((group) =>
      `${group.requester_id} ${group.name}`.toLocaleLowerCase().includes(query));
    const visibleCount = Math.max(20, Number.parseInt(groups, 10) || 20);
    const page = taskPage(agentId, agentId, `${grouped.size} 位发起人 · ${traces.length} 个任务`);
    page.sections.push({ id: 'requester_groups', type: 'requester_groups', title: '发起用户',
      search, action: agentDashboardUrl(agentId),
      groups: matches.slice(0, visibleCount).map((group, index) => ({
        ...group, traces: undefined, count: group.traces.length, time: group.traces[0].last_event_at,
        open: index === 0, href: requesterUrl(agentId, group.requester_id),
        tasks: taskRows(group.traces.slice(0, 20)),
        attention: group.traces.filter((trace) => taskState(trace).text === '需要介入').length,
      })),
      moreHref: matches.length > visibleCount
        ? `${agentDashboardUrl(agentId)}?${new URLSearchParams({ q: search, groups: visibleCount + 20 })}` : null,
    });
    return page;
  }

  function requesterTasksPage(agentId, requesterId, { page: requestedPage = 1 } = {}) {
    const traces = agentTraces(agentId).filter((trace) => (trace.requester_id || '') === requesterId);
    const totalPages = Math.max(1, Math.ceil(traces.length / 20));
    const currentPage = Math.min(totalPages, Math.max(1, Number.parseInt(requestedPage, 10) || 1));
    const attention = traces.filter((trace) => taskState(trace).text === '需要介入').length;
    const name = traces[0]?.requester_name || requesterId || '发起人未知';
    const page = taskPage(`${name} 的任务`, agentId, `${traces.length} 个任务 · ${attention} 条需要介入`);
    page.page.breadcrumbs.push({ label: name, href: requesterUrl(agentId, requesterId) });
    page.sections.push({ id: 'requester_tasks', type: 'task_list', title: `${attention} 条需要介入`,
      tasks: taskRows(traces.slice((currentPage - 1) * 20, currentPage * 20)) });
    const url = requesterUrl(agentId, requesterId);
    const pageUrl = (number) => `${url}${url.includes('?') ? '&' : '?'}page=${number}`;
    page.sections.push({ id: 'task_pagination', type: 'pagination', currentPage, totalPages,
      previousHref: currentPage > 1 ? pageUrl(currentPage - 1) : null,
      nextHref: currentPage < totalPages ? pageUrl(currentPage + 1) : null });
    return page;
  }

  function traceDetailPage(agentId, traceId) {
    const stored = db ? readTraceDetail(db, agentId, traceId) : traceStore.getTrace(agentId, traceId);
    if (!stored) return null;
    const trace = stored.audit_result === undefined ? stored : {
      ...stored, trace_status: 'pending', risk_level: 'unreviewed', review_version: 0, ...stored.audit_result,
    };
    const events = orderedTraceEvents(trace.events ?? traceStore.listTraceEvents({ agentId, traceId }));
    const reviewed = Number(trace.review_version) > 0;
    const state = taskState(trace);
    const page = taskPage('任务详情', agentId, traceId);
    page.page.breadcrumbs.push({ label: trace.requester_id || '发起人未知', href: requesterUrl(agentId, trace.requester_id) }, { label: '任务详情' });
    const fields = (id, title, items) => ({ id, title, type: 'definition_list', items: items.map(([label, value]) => ({ label, value: value ?? '未提供' })) });
    page.sections = [
      fields('task_conclusion', '任务结论', [
        ['任务状态', state.text],
        ['链路状态', labelOf({ pending: '尚未判定', success: '成功', failed: '失败', interrupted: '任务中断', incomplete: '链路不完整' }, trace.trace_status)],
        ['风险等级', reviewed ? labelOf({ none: '无风险', low: '低风险', medium: '中风险', high: '高风险' }, trace.risk_level) : '未审查'],
        ['人工介入', reviewed && trace.risk_level === 'high' ? '需要人工介入' : reviewed ? '无需人工介入' : '尚未判定'],
      ]),
      fields('task_context', '任务上下文', [
        ['发起用户', trace.requester_id || '发起人未知'], ['用户原始请求', trace.original_request],
        ['Agent 预期目的', trace.expected_purpose], ['Agent 执行结果', trace.agent_result],
        ['上下文', !trace.requester_id || trace.context_status === 'incomplete_context' ? '上下文不完整' : trace.context_status === 'complete' ? '完整' : '未知'],
      ]),
      fields('task_audit_result', 'Agent 审计结果', [
        ['审计结论', reviewed ? state.text : '未审查'], ['风险原因', trace.risk_reason],
        ['审查批次', trace.review_id || `审查版本 ${trace.review_version || 0}`],
        ['首次审计时间', trace.first_reviewed_at], ['最近审计时间', trace.last_reviewed_at],
        ['证据事件 ID', Array.isArray(trace.evidence_event_ids) ? trace.evidence_event_ids.join('、') : trace.evidence_event_ids],
        ...(trace.review_error ? [['审查提示', '最近审查失败，保留已有结论']] : []),
        ...(trace.review_input_sampled ? [['采样说明', `该 Trace 事件过多，审查结论基于采样证据（省略 ${trace.omitted_event_count || 0} 条）；下方仍展示完整事件`]] : []),
      ]),
      events.length ? { id: 'task_evidence', title: `证据链（${events.length} 条事件）`, type: 'trace_sequence',
        steps: events.map((event, index) => ({ ...traceSequenceSteps([event])[0], order: index + 1 })) }
        : { id: 'task_evidence', title: '证据链', type: 'callout', body: '暂无事件' },
      { id: 'task_raw_logs', title: `原始日志（${events.length} 条事件）`, type: 'raw_log_list', collapsible: true,
        snippets: events.map((event) => ({
          label: `事件 ID ${event.event_id ?? event.id} · ${event.ts} · ${event.event} · ${event.tool_name || '-'} · ${event.status || '-'}`,
          body: typeof event.raw_json === 'string' ? event.raw_json : JSON.stringify(event.raw_json ?? {}, null, 2),
        })) },
    ];
    return page;
  }

  function overviewPage({
    agentId,
    severity,
    category,
    status,
    reviewId,
    sort,
    logPage,
    logEvent,
    logToolName,
    logTraceId,
    logStatus,
  } = {}) {
    const effectiveSort = sort === 'severity_desc' ? 'severity_desc' : 'time_desc';
    const logFilters = {
      logEvent,
      logToolName,
      logTraceId,
      logStatus,
      ...(agentId ? { severity, category, status } : {}),
    };
    const requestedLogPage = Number(logPage);
    const normalizedLogPage = Number.isInteger(requestedLogPage) && requestedLogPage > 0
      ? requestedLogPage
      : 1;
    const totalAgentEvents = agentId ? countAgentEvents(agentId, logFilters) : 0;
    const totalLogPages = Math.max(1, Math.ceil(totalAgentEvents / AGENT_LOG_PAGE_SIZE));
    const currentLogPage = Math.min(normalizedLogPage, totalLogPages);
    const explicitFilters = {
      agentId,
      severity,
      category,
      status,
      reviewId,
      sort,
      logPage: agentId && (isPresent(logPage) || currentLogPage > 1) ? currentLogPage : undefined,
      ...logFilters,
    };
    const queueFilters = agentId
      ? { agentId, reviewId }
      : { agentId, severity, category, status, reviewId };
    const summaryScope = { agentId, category, reviewId };
    const openBySev = countOpenFindingsBySeverity(summaryScope);
    const deadLetters = getDeadLetterCount();
    const runs = listRuns(20);
    const findings = agentId
      ? []
      : listFindings(1000, queueFilters)
          .slice()
          .sort(compareFindingsByTime);
    const agentEvents = agentId
      ? listAgentEvents(agentId, {
          limit: AGENT_LOG_PAGE_SIZE,
          offset: (currentLogPage - 1) * AGENT_LOG_PAGE_SIZE,
          sort: effectiveSort,
          ...logFilters,
        })
      : [];
    const agentAssociatedFindings = agentId ? listFindings(1000, { agentId }) : [];
    const relevantReviewIds = agentId
      ? new Set(agentAssociatedFindings.map((finding) => finding?.review_id).filter(isPresent))
      : null;
    const visibleRuns = relevantReviewIds
      ? runs.filter((run) => relevantReviewIds.has(run?.review_id))
      : runs;
    const updatedAt = nowIso();
    const openFindingTotal = Object.values(openBySev).reduce((sum, count) => sum + count, 0);
    const latestRun = visibleRuns[0] ?? null;
    const severityHref = (nextSeverity) => agentId
      ? dashboardFilterUrl({
          ...explicitFilters,
          severity: nextSeverity,
          logPage: 1,
        }, 'agent_logs')
      : dashboardFilterUrl({
          ...summaryScope,
          severity: nextSeverity,
        });

    const summary_metrics = [
      { label: SEVERITY_LABELS.high, value: openBySev.high, tone: 'high', href: severityHref('high') },
      { label: SEVERITY_LABELS.medium, value: openBySev.medium, tone: 'medium', href: severityHref('medium') },
      { label: SEVERITY_LABELS.low, value: openBySev.low, tone: 'low', href: severityHref('low') },
      { label: '死信消息', value: deadLetters, tone: deadLetters > 0 ? 'critical' : 'neutral', href: `${dashboardPath}#dead_letters` },
    ];

    const context_badges = [];
    if (latestRun) {
      context_badges.push({
        label: `最新审查：${labelOf(STATUS_LABELS, latestRun.status)}`,
        tone: statusTone(latestRun.status),
      });
    }
    context_badges.push({
      label: `${agentId ? '当前 Agent ' : ''}待处理发现：${openFindingTotal}`,
      tone: openFindingTotal > 0 ? 'high' : 'neutral',
    });
    if (agentId) {
      context_badges.unshift({
        label: `Agent：${agentId}`,
        tone: 'neutral',
      });
    }
    if (severity) {
      context_badges.push({
        label: `${agentId ? '日志风险等级' : '严重级别'}：${labelOf(SEVERITY_LABELS, severity)}`,
        tone: severityTone(severity),
      });
    }
    if (category) {
      context_badges.push({
        label: `${agentId ? '关联风险类别' : '类别'}：${labelOf(CATEGORY_LABELS, category)}`,
        tone: 'neutral',
      });
    }
    if (isPresent(status)) {
      context_badges.push({
        label: `${agentId ? '关联风险状态' : '状态'}：${labelOf(STATUS_LABELS, status)}`,
        tone: statusTone(status),
      });
    }
    if (reviewId) {
      context_badges.push({ label: `审查批次：${reviewId}`, tone: 'neutral' });
    }
    if (logEvent) context_badges.push({ label: `日志事件：${logEvent}`, tone: 'neutral' });
    if (logToolName) context_badges.push({ label: `日志工具：${logToolName}`, tone: 'neutral' });
    if (logTraceId) context_badges.push({ label: `Trace：${logTraceId}`, tone: 'neutral' });
    if (logStatus) context_badges.push({ label: `日志状态：${logStatus}`, tone: statusTone(logStatus) });
    if (deadLetters > 0) {
      context_badges.push({
        label: `死信消息：${deadLetters}`,
        tone: 'critical',
      });
    }

    const page_actions = [];
    if (agentId) {
      page_actions.push({
        label: '返回 Agent 列表',
        href: '/',
        kind: 'secondary',
      });
      page_actions.push({
        label: '查看全部审计',
        href: dashboardPath,
        kind: 'secondary',
      });
    }
    let fallbackPrimaryAction = null;
    const latestRunWithFindings = visibleRuns.find((run) => (run?.finding_count ?? 0) > 0 && run?.review_id);
    if (!agentId && latestRunWithFindings) {
      fallbackPrimaryAction = {
        label: '打开最新有发现的审查',
        href: reviewUrl(latestRunWithFindings.review_id),
        kind: 'secondary',
      };
      page_actions.push(fallbackPrimaryAction);
    }
    const actionFindings = agentId ? agentAssociatedFindings : findings;
    const highestSeverityFinding = actionFindings.slice().sort(compareFindings).find((finding) => finding?.finding_id);
    if (highestSeverityFinding) {
      page_actions.push({
        label: '打开最高风险发现',
        href: findingUrl(highestSeverityFinding.finding_id),
        kind: 'primary',
      });
    }
    if (!page_actions.some((action) => action.kind === 'primary') && fallbackPrimaryAction) {
      fallbackPrimaryAction.kind = 'primary';
    }

    const findingRows = findings.map((finding) => ({
      title: {
        text: finding.title ?? '',
        href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
        secondary: labelOf(CATEGORY_LABELS, finding.category),
      },
      agent_tool: {
        text: finding.agent_name ?? finding.agent_id ?? '',
        secondary: finding.tool_name ?? '',
      },
      severity_label: {
        text: labelOf(SEVERITY_LABELS, finding.severity),
        tone: severityTone(finding.severity),
      },
      status: {
        text: labelOf(STATUS_LABELS, finding.status),
        tone: statusTone(finding.status),
      },
      last_seen_at: {
        text: formatTime(lastSeenAtOf(finding)),
        mono: true,
      },
      details: {
        text: '查看详情',
        href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
        secondary: finding.review_id ? `审查 ${finding.review_id}` : undefined,
      },
    }));

    const runsWithFindings = visibleRuns.filter((run) => (run?.finding_count ?? 0) > 0);
    const runsWithoutFindings = visibleRuns.filter((run) => (run?.finding_count ?? 0) === 0);

    const reviewRowsFor = (rows, { includeSecondary }) => rows.map((run) => ({
      review_id: {
        text: run.review_id ?? '',
        href: run.review_id ? reviewUrl(run.review_id) : undefined,
        mono: true,
        secondary: includeSecondary ? `${run.finding_count ?? 0} 个发现` : undefined,
      },
      status_label: {
        text: labelOf(STATUS_LABELS, run.status),
        tone: statusTone(run.status),
      },
      time_window: {
        text: formatWindow(run),
        mono: true,
      },
      finding_count: {
        text: String(run.finding_count ?? 0),
        href: run.review_id ? reviewUrl(run.review_id) : undefined,
      },
      trigger_type: triggerLabel(run.trigger_type),
      finished_at: {
        text: formatTime(run.finished_at),
        mono: true,
      },
    }));

    const agentLogRows = agentEvents.map((event) => ({
      timestamp: {
        text: formatTime(event.ts),
        mono: true,
      },
      event: {
        text: event.event ?? '',
        href: isPresent(event.event)
          ? dashboardFilterUrl({ ...explicitFilters, logEvent: event.event, logPage: 1 }, 'agent_logs')
          : undefined,
        mono: true,
      },
      tool_name: {
        text: event.tool_name ?? '',
        href: isPresent(event.tool_name)
          ? dashboardFilterUrl({ ...explicitFilters, logToolName: event.tool_name, logPage: 1 }, 'agent_logs')
          : undefined,
        mono: true,
      },
      status: {
        text: labelOf(STATUS_LABELS, event.status),
        href: isPresent(event.status)
          ? dashboardFilterUrl({ ...explicitFilters, logStatus: event.status, logPage: 1 }, 'agent_logs')
          : undefined,
        tone: statusTone(event.status),
        secondary: event.status && labelOf(STATUS_LABELS, event.status) !== event.status ? event.status : undefined,
      },
      severity: {
        text: event.severity ? labelOf(SEVERITY_LABELS, event.severity) : '无风险',
        tone: severityTone(event.severity),
      },
      duration_ms: {
        text: isPresent(event.duration_ms) ? `${event.duration_ms} ms` : '',
        mono: true,
      },
      trace_id: {
        text: event.trace_id ?? '',
        href: isPresent(event.trace_id)
          ? dashboardFilterUrl({ ...explicitFilters, logTraceId: event.trace_id, logPage: 1 }, 'agent_logs')
          : undefined,
        mono: true,
      },
      span_id: {
        text: event.span_id ?? '',
        secondary: event.parent_span_id ? `父 Span：${event.parent_span_id}` : undefined,
        mono: true,
      },
      summary: event.result_summary ?? '',
      error_message: {
        text: event.error_message ?? '',
        tone: isPresent(event.error_message) ? 'critical' : 'neutral',
      },
    }));
    const agentRawLogSnippets = agentEvents
      .filter((event) => isPresent(event?.raw_json))
      .map((event) => ({
        label: `日志 ID ${event.id ?? '-'} · ${formatTime(event.ts)} · ${event.event ?? '未知事件'}`,
        body: typeof event.raw_json === 'string' ? event.raw_json : JSON.stringify(event.raw_json),
      }));
    const agentLogPagination = agentId && totalLogPages > 1
      ? {
          currentPage: currentLogPage,
          totalPages: totalLogPages,
          previousHref: currentLogPage > 1
            ? dashboardFilterUrl({
              ...explicitFilters,
              sort: effectiveSort,
              logPage: currentLogPage - 1,
            }, 'agent_logs')
            : undefined,
          nextHref: currentLogPage < totalLogPages
            ? dashboardFilterUrl({
              ...explicitFilters,
              sort: effectiveSort,
              logPage: currentLogPage + 1,
            }, 'agent_logs')
            : undefined,
        }
      : null;

    const queueTitle = isPresent(queueFilters.status)
      ? `风险发现（${labelOf(STATUS_LABELS, queueFilters.status)}）`
      : '风险发现';
    const sections = [];
    if (agentId) {
      if (agentLogRows.length > 0) {
        sections.push({
          id: 'agent_logs',
          title: `Agent 日志（第 ${currentLogPage}/${totalLogPages} 页，共 ${totalAgentEvents} 条）`,
          type: 'table',
          columns: AGENT_LOG_COLUMNS,
          rows: agentLogRows,
        });
      } else {
        sections.push({
          id: 'agent_logs',
          title: 'Agent 日志',
          type: 'callout',
          body: '当前 Agent 没有可显示的日志。',
        });
      }
      if (agentLogPagination) {
        sections.push({
          id: 'agent_log_pagination',
          title: `日志分页（第 ${currentLogPage}/${totalLogPages} 页）`,
          type: 'pagination',
          ...agentLogPagination,
        });
      }
      if (agentRawLogSnippets.length > 0) {
        sections.push({
          id: 'agent_raw_logs',
          title: '当前页原始日志',
          type: 'raw_log_list',
          collapsible: true,
          snippets: agentRawLogSnippets,
        });
      }
    }
    if (!agentId) {
      if (findingRows.length > 0) {
        sections.push({
          id: 'pending_findings',
          title: queueTitle,
          type: 'table',
          columns: OVERVIEW_FINDINGS_COLUMNS,
          rows: findingRows,
        });
      } else {
        sections.push({
          id: 'pending_findings',
          title: queueTitle,
          type: 'callout',
          body: '当前范围没有匹配的风险发现。可调整过滤条件或清除过滤后重试。',
        });
      }
    }
    if (runsWithFindings.length > 0) {
      sections.push({
        id: 'reviews_with_findings',
        title: '最近有发现的审查',
        type: 'table',
        columns: REVIEWS_TABLE_COLUMNS,
        rows: reviewRowsFor(runsWithFindings, { includeSecondary: true }),
      });
    }
    if (runsWithoutFindings.length > 0) {
      sections.push({
        id: 'reviews_without_findings',
        title: '最近无发现的审查',
        type: 'table',
        columns: REVIEWS_TABLE_COLUMNS,
        rows: reviewRowsFor(runsWithoutFindings, { includeSecondary: false }),
      });
    }
    if (deadLetters > 0) {
      sections.push({
        id: 'dead_letters',
        title: '死信消息',
        type: 'callout',
        body: `${deadLetters} 条死信消息需要处理。`,
      });
    }

    return {
      page: {
        title: agentId ? `Agent 日志审计：${agentId}` : '审计审查总览',
        subtitle: agentId ? '查看该 Agent 的全部日志及关联风险标记。' : '查看最近审查、风险发现和关联证据。',
        updated_at: updatedAt,
        breadcrumbs: agentId
          ? [{ label: 'Agent 列表', href: '/' }, { label: 'Agent 审计', href: agentDashboardUrl(agentId) }]
          : [{ label: '总览', href: dashboardPath }],
        context_badges,
        page_actions,
      },
      summary_metrics,
      filters: findingFiltersViewModel({
        filters: explicitFilters,
        hrefFor: (nextFilters, filterId) => {
          const isAgentLogFilter = Boolean(agentId);
          return dashboardFilterUrl(
            isAgentLogFilter ? { ...nextFilters, logPage: 1 } : nextFilters,
            isAgentLogFilter ? 'agent_logs' : 'pending_findings',
          );
        },
        includeSort: Boolean(agentId),
        agentLogMode: Boolean(agentId),
      }),
      clear_filters_href: dashboardFilterUrl({ agentId }, agentId ? 'agent_logs' : 'pending_findings'),
      sections,
    };
  }

  function reviewDetailPage(reviewId, { agentId, severity, category, status } = {}) {
    const run = getRun(reviewId);
    const updatedAt = nowIso();
    const explicitFilters = { agentId, severity, category, status };
    const storedOccurrences = listReviewOccurrences(reviewId, 1000);
    const occurrenceBackedFindings = storedOccurrences === null ? null : storedOccurrences.map((occurrence) => ({
      ...(getFinding(occurrence.finding_id) ?? {}),
      ...occurrence,
      evidence: evidenceOfOccurrence(occurrence),
      occurrence,
    }));
    const allReviewFindings = (occurrenceBackedFindings ?? listFindings(1000, { reviewId })).slice().sort(compareFindings);
    const reviewFindings = (occurrenceBackedFindings === null
      ? listFindings(1000, { reviewId, agentId, severity, category, status })
      : occurrenceBackedFindings.filter((row) => occurrenceMatchesFilters(row, explicitFilters)))
      .slice()
      .sort(compareFindings);
    const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const finding of allReviewFindings) {
      if (severityCounts[finding.severity] != null) severityCounts[finding.severity] += 1;
    }
    const findingCount = allReviewFindings.length || run?.finding_count || 0;
    const severityHref = (nextSeverity) => reviewFilterUrl(reviewId, {
      ...explicitFilters,
      severity: nextSeverity,
    });

    const summary_metrics = [
      { label: SEVERITY_LABELS.high, value: severityCounts.high, tone: 'high', href: severityHref('high') },
      { label: SEVERITY_LABELS.medium, value: severityCounts.medium, tone: 'medium', href: severityHref('medium') },
      { label: SEVERITY_LABELS.low, value: severityCounts.low, tone: 'low', href: severityHref('low') },
      { label: '风险发现', value: findingCount, tone: 'neutral' },
    ];

    const context_badges = [];
    if (run?.status) {
      context_badges.push({
        label: labelOf(STATUS_LABELS, run.status),
        tone: statusTone(run.status),
      });
    }
    context_badges.push({ label: `${findingCount} 个发现`, tone: 'neutral' });
    context_badges.push({ label: triggerLabel(run?.trigger_type), tone: 'neutral' });
    if (severity) context_badges.push({ label: `严重级别：${labelOf(SEVERITY_LABELS, severity)}`, tone: severityTone(severity) });
    if (category) context_badges.push({ label: `类别：${labelOf(CATEGORY_LABELS, category)}`, tone: 'neutral' });
    if (status) context_badges.push({ label: `状态：${labelOf(STATUS_LABELS, status)}`, tone: statusTone(status) });
    if (agentId) context_badges.push({ label: `Agent：${agentId}`, tone: 'neutral' });

    const page_actions = [
      { label: '返回总览', href: dashboardPath, kind: 'secondary' },
    ];
    if (reviewFindings[0]?.finding_id) {
      page_actions.unshift({
        label: '打开最高风险发现',
        href: findingUrl(reviewFindings[0].finding_id),
        kind: 'primary',
      });
    }

    const sections = [];
    if (run?.status === 'completed_degraded') {
      sections.push({
        id: 'degraded_notice',
        title: '降级审查',
        type: 'callout',
        body: '本次审查以降级模式完成。请将发现用于初步排查，并结合证据日志确认。',
      });
    }
    if (run?.error_code) {
      const body = run.error_message ? `${run.error_code}: ${run.error_message}` : String(run.error_code);
      sections.push({
        id: 'run_error',
        title: '运行错误',
        type: 'callout',
        body,
      });
    }
    if (reviewFindings.length > 0) {
      sections.push({
        id: 'review_findings',
        title: '本次审查的风险发现',
        type: 'table',
        columns: REVIEW_FINDINGS_COLUMNS,
        rows: reviewFindings.map((finding) => ({
          title: {
            text: finding.title ?? '',
            href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
            secondary: labelOf(CATEGORY_LABELS, finding.category),
          },
          agent_tool: {
            text: finding.agent_name ?? finding.agent_id ?? '',
            secondary: finding.tool_name ?? '',
          },
          severity_label: {
            text: labelOf(SEVERITY_LABELS, finding.severity),
            tone: severityTone(finding.severity),
          },
          status: {
            text: labelOf(STATUS_LABELS, finding.status),
            tone: statusTone(finding.status),
          },
          occurrence_flags: {
            text: finding.occurrence ? occurrenceFlags(finding.occurrence) : '历史关联',
            secondary: finding.occurrence?.observed_at ? formatTime(finding.occurrence.observed_at) : undefined,
          },
          evidence_count: {
            text: String(Array.isArray(finding.evidence) ? finding.evidence.length : 0),
            mono: true,
            secondary: Array.isArray(finding.evidence) && finding.evidence.length > 1 ? '多条证据' : undefined,
          },
          details: {
            text: '查看详情',
            href: finding.finding_id ? findingUrl(finding.finding_id) : undefined,
          },
        })),
      });
    } else {
      sections.push({
        id: 'review_findings',
        title: '本次审查的风险发现',
        type: 'callout',
        body: '本批次没有匹配当前过滤条件的风险发现。可调整或清除过滤条件。',
      });
    }
    if (run) {
      const metaItems = [
        { label: '审查批次 ID', value: run.review_id ?? '' },
        { label: '状态', value: labelOf(STATUS_LABELS, run.status) },
        { label: '时间窗口', value: formatWindow(run) },
        { label: '发现数', value: run.finding_count ?? 0 },
        { label: '触发方式', value: triggerLabel(run.trigger_type) },
        { label: '完成时间', value: formatTime(run.finished_at) },
        { label: '风险策略版本', value: run.risk_policy_version ?? '' },
        { label: 'Prompt 版本', value: run.prompt_version ?? '' },
        { label: '审查器版本', value: run.reviewer_version ?? '' },
        { label: 'LLM 模型', value: run.llm_model ?? '' },
        { label: '扫描文件数', value: run.scanned_files },
        { label: '候选事件数', value: run.candidate_event_count },
      ].filter((item) => isPresent(item.value));
      if (metaItems.length > 0) {
        sections.push({
          id: 'run_metadata',
          title: '审查元数据',
          type: 'definition_list',
          collapsible: true,
          items: metaItems,
        });
      }
    }

    return {
      page: {
        title: '审查批次',
        subtitle: formatWindow(run) || reviewId,
        updated_at: updatedAt,
        breadcrumbs: [
          { label: '总览', href: dashboardPath },
          { label: '审查批次', href: reviewUrl(reviewId) },
        ],
        context_badges,
        page_actions,
      },
      summary_metrics,
      filters: findingFiltersViewModel({
        filters: explicitFilters,
        hrefFor: (nextFilters) => reviewFilterUrl(reviewId, nextFilters),
      }),
      clear_filters_href: reviewFilterUrl(reviewId),
      sections,
    };
  }

  function findingDetailPage(findingId, { notice, action } = {}) {
    const finding = getFinding(findingId);
    const updatedAt = nowIso();
    if (!finding) {
      return {
        page: {
          title: '未找到风险发现',
          subtitle: `风险发现 ${findingId}`,
          updated_at: updatedAt,
          breadcrumbs: [{ label: '总览', href: dashboardPath }],
          context_badges: [],
          page_actions: [{ label: '返回总览', href: dashboardPath, kind: 'secondary' }],
        },
        summary_metrics: [],
        filters: [],
        sections: [
          { id: 'not_found', type: 'callout', title: '未找到', body: `未找到风险发现 ${findingId}。` },
        ],
      };
    }

    const reviewId = finding.last_review_id ?? finding.review_id;
    const occurrences = listFindingOccurrences(findingId, 1000) ?? [];
    const actions = listFindingActions(findingId, 1000) ?? [];
    const recurrenceCount = occurrences.filter((row) => row?.reopened === true || row?.reopened === 1).length
      || actions.filter((row) => row?.action_type === 'recurrence').length;
    const maxSeverity = finding.max_severity ?? occurrences
      .map((row) => row?.severity)
      .filter(Boolean)
      .sort((left, right) => severityRank(right) - severityRank(left))[0]
      ?? finding.severity;
    const breadcrumbs = [{ label: '总览', href: dashboardPath }];
    if (reviewId) breadcrumbs.push({ label: '审查批次', href: reviewUrl(reviewId) });
    breadcrumbs.push({ label: '风险发现', href: findingUrl(findingId) });

    const context_badges = [
      { label: labelOf(SEVERITY_LABELS, finding.severity), tone: severityTone(finding.severity) },
      { label: labelOf(CATEGORY_LABELS, finding.category), tone: 'neutral' },
      { label: labelOf(STATUS_LABELS, finding.status), tone: statusTone(finding.status) },
      { label: finding.agent_name ?? finding.agent_id ?? '', tone: 'neutral' },
      { label: finding.tool_name ?? '', tone: 'neutral' },
    ].filter((badge) => isPresent(badge.label));

    const page_actions = [{ label: '返回总览', href: dashboardPath, kind: 'secondary' }];
    if (reviewId) {
      page_actions.unshift({ label: '返回审查批次', href: reviewUrl(reviewId), kind: 'primary' });
    }

    const definitionItems = [
      { label: '风险发现 ID', value: finding.finding_id ?? '' },
      { label: '首次审查批次 ID', value: finding.first_review_id ?? finding.review_id ?? '' },
      { label: '最近审查批次 ID', value: finding.last_review_id ?? finding.review_id ?? '' },
      { label: 'Agent 名称', value: finding.agent_name ?? '' },
      { label: 'Agent ID', value: finding.agent_id ?? '' },
      { label: '工具', value: finding.tool_name ?? '' },
      { label: 'Trace ID', value: finding.trace_id ?? '' },
      { label: '实体', value: [finding.entity?.type, finding.entity?.id].filter(Boolean).join('/') },
      { label: '最后出现', value: formatTime(lastSeenAtOf(finding)) },
      { label: '历史最高严重级别', value: labelOf(SEVERITY_LABELS, maxSeverity) },
      { label: '复发次数', value: recurrenceCount },
      { label: '状态版本', value: finding.state_version },
    ].filter((item) => isPresent(item.value));

    const traceEvents = orderedTraceEvents(listTraceEvents(finding.trace_id, 200));
    const traceSteps = traceSequenceSteps(traceEvents);
    const rawEvidenceEvents = listRawEventsByIds(evidenceEventIdsOf(finding), 200);
    const rawEvidenceSnippets = rawLogSnippets(rawEvidenceEvents);
    const historicalEvidenceSnippets = rawSnapshotSnippets(occurrences);

    const linkItems = [];
    if (reviewId) {
      linkItems.push({ href: reviewUrl(reviewId), label: '返回审查批次' });
    }
    linkItems.push({ href: dashboardPath, label: '返回总览' });

    const sections = [];
    if (isPresent(finding.summary)) {
      sections.push({
        id: 'finding_summary',
        title: '发生了什么',
        type: 'callout',
        body: finding.summary,
      });
    }
    if (isPresent(finding.recommendation)) {
      sections.push({
        id: 'recommendation',
        title: '建议动作',
        type: 'callout',
        body: finding.recommendation,
      });
    }
    if (traceSteps.length > 0) {
      sections.push({
        id: 'trace_sequence',
        title: traceSequenceTitle(traceEvents.length, traceSteps.length),
        type: 'trace_sequence',
        steps: traceSteps,
      });
    }
    if (traceEvents.length > TRACE_ABNORMAL_STEP_THRESHOLD) {
      sections.push(traceAbnormalSection(traceEvents.length));
    }
    if (traceSteps.length === 0 && isPresent(finding.trace_id)) {
      sections.push({
        id: 'trace_sequence_empty',
        title: '工具调用顺序',
        type: 'callout',
        body: `Trace ${finding.trace_id} 没有找到完整的工具调用事件。请结合下方原始证据日志排查。`,
      });
    }
    if (definitionItems.length > 0) {
      sections.push({
        id: 'finding_detail',
        title: '关键元数据',
        type: 'definition_list',
        items: definitionItems,
      });
    }
    if (occurrences.length > 0) {
      sections.push({
        id: 'occurrence_history',
        title: `出现历史（${occurrences.length} 次）`,
        type: 'table',
        columns: [
          { key: 'observed_at', label: '观察时间', priority: 'primary' },
          { key: 'review_id', label: '审查批次', priority: 'secondary' },
          { key: 'severity', label: '严重级别', priority: 'primary' },
          { key: 'flags', label: '出现类型', priority: 'primary' },
          { key: 'evidence_count', label: '证据', priority: 'metadata' },
        ],
        rows: occurrences.map((occurrence) => ({
          observed_at: { text: formatTime(occurrence.observed_at ?? occurrence.created_at), mono: true },
          review_id: {
            text: occurrence.review_id ?? '',
            href: occurrence.review_id ? reviewUrl(occurrence.review_id) : undefined,
            mono: true,
          },
          severity: { text: labelOf(SEVERITY_LABELS, occurrence.severity), tone: severityTone(occurrence.severity) },
          flags: occurrenceFlags(occurrence),
          evidence_count: String(evidenceOfOccurrence(occurrence).length),
        })),
      });
    }
    if (actions.length > 0) {
      sections.push({
        id: 'action_history',
        title: `操作历史（${actions.length} 条）`,
        type: 'table',
        columns: [
          { key: 'created_at', label: '操作时间', priority: 'primary' },
          { key: 'action', label: '动作', priority: 'primary' },
          { key: 'transition', label: '状态变化', priority: 'secondary' },
          { key: 'actor', label: '操作者', priority: 'secondary' },
          { key: 'note', label: '说明', priority: 'metadata' },
        ],
        rows: actions.map((row) => ({
          created_at: { text: formatTime(row.created_at), mono: true },
          action: ACTION_LABELS[row.action_type] ?? row.action_type ?? '',
          transition: `${labelOf(STATUS_LABELS, row.from_status)} → ${labelOf(STATUS_LABELS, row.to_status)}`,
          actor: row.actor ?? '',
          note: row.note ?? (row.snoozed_until ? `暂缓至 ${row.snoozed_until}` : ''),
        })),
      });
    }
    if (historicalEvidenceSnippets.length > 0) {
      sections.push({
        id: 'historical_evidence_snapshots',
        title: `历史证据快照（${historicalEvidenceSnippets.length} 条）`,
        type: 'raw_log_list',
        collapsible: true,
        snippets: historicalEvidenceSnippets,
      });
    } else if (occurrences.length > 0) {
      sections.push({
        id: 'historical_evidence_unavailable',
        title: '历史证据快照',
        type: 'callout',
        body: '历史原始证据已清理或快照中没有 raw_json；Occurrence 元数据仍保留。',
      });
    }
    if (rawEvidenceSnippets.length > 0) {
      sections.push({
        id: 'evidence_raw_logs',
        title: rawEvidenceSnippets.length > 1 ? `原始日志片段（${rawEvidenceSnippets.length} 条）` : '原始日志片段',
        type: 'raw_log_list',
        collapsible: true,
        snippets: rawEvidenceSnippets,
      });
    }
    if (linkItems.length > 0) {
      sections.push({
        id: 'linked_navigation',
        title: '相关链接',
        type: 'link_list',
        links: linkItems,
      });
    }

    return {
      page: {
        title: finding.title ?? `Finding ${findingId}`,
        subtitle: '风险发现',
        updated_at: updatedAt,
        breadcrumbs,
        context_badges,
        page_actions,
      },
      summary_metrics: [],
      filters: [],
      notices: actionNotice(notice, action),
      sections,
    };
  }

  async function findingDetailPageWithAnalysis(findingId, options) {
    const page = findingDetailPage(findingId, options);
    const finding = getFinding(findingId);
    if (!finding || !llmClient || !traceAnalysisModel || !Array.isArray(page.sections)) return page;

    const traceEvents = orderedTraceEvents(listTraceEvents(finding.trace_id, 200));
    if (traceEvents.length === 0) return page;
    if (traceEvents.length > TRACE_ABNORMAL_STEP_THRESHOLD) return page;

    if (cacheDetailAnalysis && isFreshAnalysisCache(finding)) {
      insertSectionBefore(page.sections, 'trace_sequence', traceAnalysisSection({
        analysis: finding.llm_analysis,
        model: traceAnalysisModel,
      }));
      return page;
    }

    try {
      const input = buildTraceAnalysisInput({ finding, traceEvents });
      const schema = traceAnalysisJsonSchema();
      const estimatedTokens = estimateTokensForPayload({ model: traceAnalysisModel, input, schema });
      const usageDay = llmUsageDayKey();
      if (!reserveDetailAnalysisBudget({ day: usageDay, estimatedTokens })) {
        insertSectionBefore(page.sections, 'trace_sequence', traceAnalysisUnavailableSection(
          '无法生成链路分析：LLM 预算已用尽。',
        ));
        return page;
      }

      let raw;
      let llmError = null;
      try {
        raw = await llmClient.createStructuredResponse({
          model: traceAnalysisModel,
          input,
          schema,
        });
      } catch (error) {
        llmError = error;
      }
      if (llmError) throw llmError;
      const analysis = normalizeTraceAnalysis(raw, traceEvents.slice(0, TRACE_ANALYSIS_STEP_LIMIT));
      if (cacheDetailAnalysis) {
        try {
          reviewStore.saveFindingAnalysis?.(finding.finding_id, { analysis, generatedAt: nowIso() });
        } catch {
          // Cache write failures must not break the detail page.
        }
      }
      insertSectionBefore(page.sections, 'trace_sequence', {
        id: 'trace_llm_analysis',
        title: 'LLM 链路分析',
        type: 'trace_analysis',
        model: traceAnalysisModel,
        ...analysis,
      });
    } catch (error) {
      insertSectionBefore(page.sections, 'trace_sequence', {
        id: 'trace_llm_analysis',
        title: 'LLM 链路分析不可用',
        type: 'callout',
        body: `无法生成链路分析：${error?.message ?? String(error)}`,
      });
    }

    return page;
  }

  return {
    dashboardUrlFor,
    findingUrlFor,
    agentIndexPage,
    agentPage,
    requesterTasksPage,
    traceDetailPage,
    overviewPage,
    manualDailyReportPage,
    reviewDetailPage,
    findingDetailPage,
    findingDetailPageWithAnalysis,
  };
}
