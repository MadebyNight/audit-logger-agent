const FEISHU_WEBHOOK_MAX_BYTES = 20 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 19 * 1024;
const DEFAULT_FOLD_THRESHOLD_CHARS = 800;
const MAX_DETAIL_SEGMENT_CHARS = 1800;
const MAX_CARD_TAGGED_COMPONENTS = 190;
const BEIJING_TIMEZONE = 'Asia/Shanghai';

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function normalizedLimit(value, fallback, max = FEISHU_WEBHOOK_MAX_BYTES) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1024) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function sanitizeFeishuText(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/</g, '＜')
    .replace(/>/g, '＞')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function splitText(value, maxChars = MAX_DETAIL_SEGMENT_CHARS) {
  const text = sanitizeFeishuText(value);
  if (text.length <= maxChars) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let boundary = remaining.lastIndexOf('\n', maxChars);
    if (boundary < Math.floor(maxChars * 0.5)) boundary = remaining.lastIndexOf('。', maxChars);
    if (boundary < Math.floor(maxChars * 0.5)) boundary = maxChars;
    else boundary += 1;
    parts.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function normalizeSeverity(value) {
  return value === 'critical' ? 'critical' : 'high';
}

function sanitizeBusinessText(value) {
  return sanitizeFeishuText(value)
    .replace(/通过\s*Webhook\s*推送/gi, '通过通知渠道发送')
    .replace(/自定义服务消息/gi, '通知消息')
    .replace(/\bWebhook\b/gi, '通知渠道')
    .replace(/\bJSON\b/gi, '结构化数据')
    .replace(/\bHTTP\b/gi, '网络请求')
    .replace(/\boutbox\b/gi, '消息队列')
    .replace(/\bcanary\b/gi, '连通性检查');
}

function severityRank(value) {
  return value === 'critical' ? 2 : value === 'high' ? 1 : 0;
}

function timestampValue(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function sortedFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => finding?.severity === 'high' || finding?.severity === 'critical')
    .sort((a, b) => (
      severityRank(b.finding.severity) - severityRank(a.finding.severity) ||
      timestampValue(b.finding.observed_at ?? b.finding.observedAt) -
        timestampValue(a.finding.observed_at ?? a.finding.observedAt) ||
      a.index - b.index
    ))
    .map(({ finding }) => finding);
}

function summaryText(value) {
  const sanitized = sanitizeBusinessText(value);
  return sanitized || '暂无影响摘要，请进入 Dashboard 查看详情。';
}

function findingEntries(findings) {
  const entries = [];
  for (const [findingIndex, finding] of findings.entries()) {
    const title = sanitizeBusinessText(finding.title || finding.tool_name || finding.category || '未命名风险');
    const summaryParts = splitText(summaryText(finding.summary));
    summaryParts.forEach((summary, index) => {
      entries.push({
        kind: 'finding',
        findingIndex,
        severity: normalizeSeverity(finding.severity),
        title,
        summary,
        segmentIndex: index,
        segmentCount: summaryParts.length,
      });
    });
  }
  return entries;
}

function toolEntries(tools) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool, index) => ({ tool, index }))
    .sort((a, b) => (
      (Number(b.tool.error_count) || 0) - (Number(a.tool.error_count) || 0) ||
      (Number(b.tool.total) || 0) - (Number(a.tool.total) || 0) ||
      String(a.tool.tool_name || '').localeCompare(String(b.tool.tool_name || ''), 'zh-CN') ||
      a.index - b.index
    ))
    .map(({ tool }) => ({
      kind: 'tool',
      title: sanitizeBusinessText(tool.tool_name || 'unknown'),
      summary: `调用 ${Number(tool.total) || 0} 次，异常 ${Number(tool.error_count) || 0} 次`,
    }));
}

function entryMarkdown(entry, index) {
  const label = entry.severity ? severityLabelMarkdown(entry.severity) : '';
  const segment = entry.segmentCount > 1 ? `（摘要 ${entry.segmentIndex + 1}/${entry.segmentCount}）` : '';
  return `**${index + 1}. ${label}${entry.title}${segment}**\n${entry.summary}`;
}

function shortenIdentity(value, maxChars = 24) {
  const text = sanitizeFeishuText(value);
  if (!text) return '身份信息缺失';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, 10)}…${text.slice(-8)}`;
}

function displayAgentName(agentName, agentId) {
  return sanitizeFeishuText(agentName) || shortenIdentity(agentId) || '身份信息缺失';
}

function displayTraceName(traceName, traceId) {
  return sanitizeFeishuText(traceName) || shortenIdentity(traceId) || '身份信息缺失';
}

function identityMarkdown({ agentId, traceId, agentName, traceName }) {
  const missing = !sanitizeFeishuText(agentId) || !sanitizeFeishuText(traceId);
  return [
    `Agent：${displayAgentName(agentName, agentId)}（ID：${shortenIdentity(agentId)}）`,
    `业务链路：${displayTraceName(traceName, traceId)}（Trace：${shortenIdentity(traceId)}）`,
    ...(missing ? ['身份状态：身份信息缺失'] : []),
  ].join('\n');
}

function detailElement(entries, { title = '查看明细', itemCount = entries.length, compact = false } = {}) {
  const elements = entries.map((entry, index) => ({
    tag: 'markdown',
    content: entryMarkdown(entry, index),
  }));
  return [{
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: `${title}（${itemCount} 项）` },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'right',
      icon_expanded_angle: -180,
    },
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: compact ? '4px' : '8px',
    padding: '8px',
    elements,
  }];
}

function truncateText(value, maxChars = 44) {
  const text = summaryText(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).trimEnd()}…`;
}

function severityLabelMarkdown(severity) {
  if (severity === 'medium') return '［中风险］';
  if (severity === 'low') return '［低风险］';
  return severity === 'critical'
    ? "<font color='orange'>［严重］</font>"
    : "<font color='yellow'>［高风险］</font>";
}

function primaryRiskElement(finding) {
  const title = sanitizeBusinessText(
    finding?.title || finding?.tool_name || finding?.category || '未命名风险',
  );
  return {
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: { tag: 'plain_text', content: '首要风险' },
      vertical_align: 'center',
    },
    border: { color: 'orange', corner_radius: '5px' },
    vertical_spacing: '4px',
    padding: '8px',
    elements: [{
      tag: 'markdown',
      content: `**${severityLabelMarkdown(finding.severity)}${title}**\n${truncateText(finding.summary)}`,
    }],
  };
}

function metricElement(items) {
  return {
    tag: 'column_set',
    flex_mode: 'flow',
    horizontal_spacing: '8px',
    columns: items.map(({ label, value }) => ({
      tag: 'column',
      width: 'weighted',
      weight: 1,
      elements: [{
        tag: 'markdown',
        content: `**${sanitizeFeishuText(value)}**\n${sanitizeFeishuText(label)}`,
        text_align: 'left',
      }],
    })),
  };
}

function beijingParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: BEIJING_TIMEZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value;
  return { month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

function formatBeijingRange(from, to, { prefix = '北京时间 ' } = {}) {
  const start = beijingParts(from);
  const end = beijingParts(to);
  if (!start || !end) return `${prefix}时间范围未知`;
  const startDate = `${Number(start.month)} 月 ${Number(start.day)} 日`;
  const endDate = `${Number(end.month)} 月 ${Number(end.day)} 日`;
  const startTime = `${start.hour}:${start.minute}`;
  const endTime = `${end.hour}:${end.minute}`;
  return startDate === endDate
    ? `${prefix}${startDate} ${startTime}–${endTime}`
    : `${prefix}${startDate} ${startTime}–${endDate} ${endTime}`;
}

function reviewWindowLabel(from, to) {
  const durationMs = Date.parse(to ?? '') - Date.parse(from ?? '');
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—';
  const minutes = Math.round(durationMs / 60000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function metadataElement(content) {
  return {
    tag: 'div',
    text: {
      tag: 'plain_text',
      content,
      text_size: 'notation',
      text_color: 'grey',
      text_align: 'left',
    },
  };
}

function envelope(card) {
  return { msg_type: 'interactive', card };
}

function baseCard({ title, subtitle, template, preview, elements }) {
  return envelope({
    schema: '2.0',
    config: {
      update_multi: true,
      enable_forward: false,
      width_mode: 'fill',
      summary: { content: preview },
    },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: subtitle },
      template,
      padding: '12px',
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements,
    },
  });
}

function safeHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function taggedComponentCount(value) {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + taggedComponentCount(item), 0);
  }
  return (typeof value.tag === 'string' ? 1 : 0) +
    Object.values(value).reduce((sum, item) => sum + taggedComponentCount(item), 0);
}

function packEntries(entries, makePayload, maxPayloadBytes) {
  const chunks = [];
  let current = [];
  for (const entry of entries) {
    const candidate = [...current, entry];
    const payload = makePayload(candidate, 999, 999);
    const exceedsLimit = utf8Bytes(payload) > maxPayloadBytes ||
      taggedComponentCount(payload.card) > MAX_CARD_TAGGED_COMPONENTS;
    if (current.length > 0 && exceedsLimit) {
      chunks.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(current);
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, index) => {
    const payload = makePayload(chunk, index + 1, chunks.length);
    if (utf8Bytes(payload) > maxPayloadBytes) {
      throw new Error('Feishu card exceeds configured payload byte limit');
    }
    if (taggedComponentCount(payload.card) > MAX_CARD_TAGGED_COMPONENTS) {
      throw new Error('Feishu card exceeds safe component count');
    }
    return payload;
  });
}

export function groupHighRiskFindings(findings) {
  const groups = new Map();
  const eligibleFindings = Array.isArray(findings) ? findings : [];
  for (const [index, finding] of eligibleFindings.entries()) {
    if (finding?.severity !== 'high' && finding?.severity !== 'critical') continue;
    const agentId = finding.agent_id ?? null;
    const traceId = finding.trace_id ?? null;
    const hasCompleteIdentity = agentId !== null && agentId !== '' && traceId !== null && traceId !== '';
    // Missing identity must fail isolated: otherwise unrelated findings with
    // null/empty IDs would collapse into one cross-source notification.
    const key = hasCompleteIdentity
      ? JSON.stringify([agentId, traceId])
      : JSON.stringify(['isolated_missing_identity', finding.finding_id ?? finding.id ?? index, index]);
    const group = groups.get(key) ?? { agentId, traceId, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function buildHighRiskAlertPayloads({
  reviewId,
  window,
  agentId,
  agentName,
  traceId,
  traceName,
  findings,
  dashboardUrl,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
} = {}) {
  const eligible = sortedFindings(findings);
  if (eligible.length === 0) return [];
  const entries = findingEntries(eligible);
  const criticalCount = eligible.filter((finding) => finding.severity === 'critical').length;
  const detailChars = entries.reduce((sum, entry) => sum + entry.title.length + entry.summary.length, 0);
  const compactDetails = detailChars <= Number(foldThresholdChars || DEFAULT_FOLD_THRESHOLD_CHARS);
  const byteLimit = normalizedLimit(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const makePayload = (chunk, part, totalParts) => {
    const partLabel = totalParts > 1 ? `（${part}/${totalParts}）` : '';
    const primaryFinding = eligible[0];
    const agentLabel = displayAgentName(agentName, agentId);
    const traceLabel = displayTraceName(traceName, traceId);
    const conclusion = criticalCount > 0
      ? `${agentLabel} 的 ${traceLabel} 发现 ${eligible.length} 条高风险，其中 ${criticalCount} 条严重，需要查看影响范围。`
      : `${agentLabel} 的 ${traceLabel} 发现 ${eligible.length} 条高风险，建议查看具体影响。`;
    const otherRisks = eligible.slice(1, 3);
    const elements = [
      {
        tag: 'markdown',
        content: `**总体结论**\n${conclusion}`,
      },
      metricElement([
        { label: '高风险总数', value: String(eligible.length) },
        { label: '严重风险数', value: String(criticalCount) },
        { label: '审查窗口', value: reviewWindowLabel(window?.from, window?.to) },
      ]),
      primaryRiskElement(primaryFinding),
      ...(otherRisks.length > 0 ? [{
        tag: 'markdown',
        content: [
          '**其他重点风险**',
          ...otherRisks.map((finding) => (
            `- ${severityLabelMarkdown(finding.severity)}${sanitizeBusinessText(
              finding.title || finding.tool_name || finding.category || '未命名风险',
            )}`
          )),
        ].join('\n'),
      }] : []),
      ...detailElement(chunk, {
        title: '全部风险名称与摘要',
        itemCount: eligible.length,
        compact: compactDetails,
      }),
      metadataElement([
        formatBeijingRange(window?.from, window?.to),
        `批次：${shortenIdentity(reviewId)}`,
        identityMarkdown({ agentId, traceId, agentName, traceName }),
      ].join('\n')),
    ];
    const detailUrl = safeHttpUrl(dashboardUrl);
    if (detailUrl) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: '查看审计详情' },
        type: 'primary',
        width: 'default',
        behaviors: [{ type: 'open_url', default_url: detailUrl }],
      });
    }
    return baseCard({
      title: `${criticalCount > 0 ? '严重审计风险' : '高风险审计告警'}${partLabel}`,
      subtitle: `${agentLabel} · ${traceLabel}`,
      template: 'orange',
      preview: `${criticalCount > 0 ? '严重审计风险' : '高风险审计告警'}：${agentLabel} · ${traceLabel}`,
      elements,
    });
  };
  return packEntries(entries, makePayload, byteLimit);
}

// V1.1 uses a single immutable task card. Legacy Finding rendering above is
// retained for historical previews, but is not an enqueue path.
export function buildTraceAlertPayload({ trace, agentName, dashboardUrl,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES } = {}) {
  const limit = Math.min(normalizedLimit(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES), DEFAULT_MAX_PAYLOAD_BYTES);
  const fields = [
    ['发起人', trace.requester_id], ['原始请求', trace.original_request],
    ['预期目的', trace.expected_purpose], ['最终结果或失败原因', trace.agent_result],
    ['风险原因', trace.risk_reason],
  ];
  const clip = (value, size) => {
    const chars = Array.from(sanitizeFeishuText(value) || '未提供');
    return chars.length > size ? chars.slice(0, size - 1).join('') + '…' : chars.join('');
  };
  const detailUrl = safeHttpUrl(dashboardUrl);
  let fieldLimit = 600;
  while (true) {
    const payload = baseCard({
      title: '高风险审计告警',
      subtitle: `${clip(agentName || trace.agent_id, 60)} · ${clip(trace.trace_id, 60)}`,
      template: 'orange', preview: '高风险审计告警：需要人工介入',
      elements: [
        { tag: 'markdown', content: '**任务结论**\n需要人工介入' },
        ...fields.map(([label, value]) => ({ tag: 'markdown',
          content: `**${label}**\n${clip(value, label === '风险原因' ? Math.min(200, fieldLimit) : fieldLimit)}` })),
        ...(trace.review_input_sampled ? [{ tag: 'markdown',
          content: '该 Trace 事件过多，审查结论基于采样证据' }] : []),
        ...(detailUrl ? [{ tag: 'button', text: { tag: 'plain_text', content: '查看任务详情与证据' },
          type: 'primary', width: 'default', behaviors: [{ type: 'open_url', default_url: detailUrl }] }] : []),
      ],
    });
    if (utf8Bytes(payload) <= limit) return payload;
    if (fieldLimit === 1) throw new Error('Feishu trace card exceeds configured payload byte limit');
    fieldLimit = Math.max(1, Math.floor(fieldLimit / 2));
  }
}

export function buildDailyReportPayloads({
  date,
  generatedAt,
  window,
  timezoneOffsetMinutes = 480,
  group,
  dashboardUrl,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  foldThresholdChars: _foldThresholdChars = DEFAULT_FOLD_THRESHOLD_CHARS,
} = {}) {
  if (!group) return [];
  const findings = group.top_risks ?? sortedFindings(group.findings).map((finding) => ({ ...finding, severity: 'high' }));
  const byteLimit = normalizedLimit(maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES);
  const highRiskCount = group.top_risks ? Number(group.high_risk_count) || 0 : Math.max(Number(group.high_risk_count) || 0, findings.length);
  const eventCount = Number(group.event_count) || 0;
  const errorCount = Number(group.error_count) || 0;
  const agentCount = Number(group.agent_count) || 0;
  const traceCount = Number(group.trace_count) || 0;
  const toolCount = Number(group.tool_count) || 0;
  const topFindings = findings.slice(0, 3);
  const riskCount = group.risk_level_counts ? group.risk_level_counts.low + group.risk_level_counts.medium + group.risk_level_counts.high : highRiskCount;
  const topTools = toolEntries(group.tools).slice(0, 5);
  const conclusion = highRiskCount > 0
      ? `存在 ${highRiskCount} 条高风险，建议关注相关业务链路。`
      : group.risk_level_counts && riskCount > 0
        ? `存在 ${group.risk_level_counts.medium} 条中风险、${group.risk_level_counts.low} 条低风险 Trace，请查看审计结论。`
      : group.reviewed_trace_count !== undefined && traceCount > Number(group.reviewed_trace_count)
        ? `当前 ${traceCount} 条 Trace 中有 ${traceCount - Number(group.reviewed_trace_count)} 条尚未形成收敛结论。`
      : errorCount > 0
        ? `存在 ${errorCount} 条异常事件，暂未形成高风险发现，建议查看详情。`
        : eventCount > 0
          ? '今日未发现异常或高风险，整体运行正常。'
          : '统计窗口内暂无审计事件。';
  const generated = beijingParts(window?.to ?? generatedAt);
  const slotLabel = generated ? `${generated.hour}:${generated.minute}` : '定时时段';
  const elements = [
    {
      tag: 'markdown',
      content: `**总体判断**\n${conclusion}`,
    },
    metricElement([
      { label: '事件数', value: String(eventCount) },
      { label: '异常事件数', value: String(errorCount) },
      { label: '高风险 Trace 数', value: String(highRiskCount) },
    ]),
    metricElement(['success', 'failed', 'interrupted', 'incomplete'].map((key, index) => ({
      label: ['成功', '失败', '中断', '不完整'][index], value: String(group.trace_status_counts?.[key] ?? 0),
    }))),
    metricElement(['none', 'low', 'medium', 'high'].map((key, index) => ({
      label: ['无风险', '低风险', '中风险', '高风险'][index], value: String(group.risk_level_counts?.[key] ?? 0),
    }))),
    {
      tag: 'markdown',
      content: `**覆盖范围**\n覆盖 ${agentCount} 个 Agent · ${traceCount} 条 Trace · ${toolCount} 类工具`,
    },
    ...(topFindings.length > 0 ? [{
      tag: 'markdown',
      content: [
        `**Top 风险（展示 ${topFindings.length}/${riskCount}）**`,
        ...topFindings.map((finding, index) => {
          const title = sanitizeBusinessText(
            finding.title || finding.tool_name || finding.category || '未命名风险',
          );
          return [
            `${index + 1}. ${severityLabelMarkdown(finding.severity)}${truncateText(title, 72)}`,
            `Agent：${shortenIdentity(finding.agent_id)} · Trace：${shortenIdentity(finding.trace_id)}`,
            truncateText(finding.summary, 100),
          ].join('\n');
        }),
      ].join('\n\n'),
    }] : []),
    ...(topTools.length > 0 ? [{
      tag: 'markdown',
      content: [
        `**Top 工具（展示 ${topTools.length}/${toolCount}）**`,
        ...topTools.map((tool, index) => `${index + 1}. ${truncateText(tool.title, 72)}：${tool.summary}`),
      ].join('\n'),
    }] : []),
    metadataElement([
      `统计范围：${formatBeijingRange(window?.from, window?.to ?? generatedAt, { prefix: '' })} · 北京时间`,
      `统计日期：${sanitizeFeishuText(date || '未知')}`,
      '报告范围：全部 Agent 与业务链路',
    ].join('\n')),
  ];
  const detailUrl = safeHttpUrl(dashboardUrl);
  if (detailUrl) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '查看完整日报' },
      type: 'primary',
      width: 'default',
      behaviors: [{ type: 'open_url', default_url: detailUrl }],
    });
  }
  const payload = baseCard({
    title: '审计信息日报',
    subtitle: `全局汇总 · ${slotLabel}`,
    template: 'blue',
    preview: '审计日报：全局汇总',
    elements,
  });
  if (utf8Bytes(payload) > byteLimit) {
    throw new Error('Feishu daily report exceeds configured payload byte limit');
  }
  if (taggedComponentCount(payload.card) > MAX_CARD_TAGGED_COMPONENTS) {
    throw new Error('Feishu daily report exceeds safe component count');
  }
  return [payload];
}

export function feishuPayloadBytes(payload) {
  return utf8Bytes(payload);
}

export { DEFAULT_MAX_PAYLOAD_BYTES, FEISHU_WEBHOOK_MAX_BYTES };
