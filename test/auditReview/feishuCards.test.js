import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEISHU_WEBHOOK_MAX_BYTES,
  buildDailyReportPayloads,
  buildHighRiskAlertPayloads,
  buildTraceAlertPayload,
  feishuPayloadBytes,
  groupHighRiskFindings,
  sanitizeFeishuText,
} from '../../src/auditReview/feishuCards.js';

test('groupHighRiskFindings never crosses agent_id or trace_id boundaries', () => {
  const groups = groupHighRiskFindings([
    { severity: 'high', agent_id: 'a1', trace_id: 't1', title: '1', summary: '1' },
    { severity: 'critical', agent_id: 'a1', trace_id: 't1', title: '2', summary: '2' },
    { severity: 'high', agent_id: 'a1', trace_id: 't2', title: '3', summary: '3' },
    { severity: 'high', agent_id: 'a2', trace_id: 't1', title: '4', summary: '4' },
    { severity: 'medium', agent_id: 'a1', trace_id: 't1', title: 'skip', summary: 'skip' },
  ]);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map((group) => [group.agentId, group.traceId, group.findings.length]), [
    ['a1', 't1', 2],
    ['a1', 't2', 1],
    ['a2', 't1', 1],
  ]);
});

test('groupHighRiskFindings isolates findings with incomplete identity', () => {
  const groups = groupHighRiskFindings([
    { finding_id: 'f-null-1', severity: 'high', agent_id: null, trace_id: null, title: '1', summary: '1' },
    { finding_id: 'f-null-2', severity: 'critical', agent_id: null, trace_id: null, title: '2', summary: '2' },
    { finding_id: 'f-partial-1', severity: 'high', agent_id: 'a1', trace_id: null, title: '3', summary: '3' },
    { finding_id: 'f-partial-2', severity: 'high', agent_id: 'a1', trace_id: null, title: '4', summary: '4' },
  ]);

  assert.equal(groups.length, 4);
  assert.ok(groups.every((group) => group.findings.length === 1));
});

test('high-risk card uses JSON 2.0, folds long detail, and excludes raw evidence', () => {
  const payloads = buildHighRiskAlertPayloads({
    reviewId: 'review-1',
    window: { from: '2026-07-17T00:00:00.000Z', to: '2026-07-17T00:30:00.000Z' },
    agentId: 'agent-1',
    traceId: 'trace-1',
    findings: [
      { severity: 'high', title: '危险写入', summary: '摘要 A', evidence: [{ raw_json: 'SECRET' }] },
      { severity: 'critical', title: '权限提升', summary: '摘要 B', evidence: [{ raw_json: 'SECRET' }] },
      { severity: 'high', title: '删除调用', summary: '摘要 C', evidence: [{ raw_json: 'SECRET' }] },
    ],
    foldThresholdChars: 1,
  });

  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  assert.equal(payload.msg_type, 'interactive');
  assert.equal(payload.card.schema, '2.0');
  assert.equal(payload.card.header.template, 'orange');
  assert.equal(payload.card.header.title.content, '严重审计风险');
  assert.ok(payload.card.body.elements.some((element) => element.tag === 'collapsible_panel' && element.expanded === false));
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /总体结论|高风险总数|严重风险数|审查窗口|首要风险|其他重点风险/);
  assert.doesNotMatch(serialized, /"template":"(?:red|carmine)"/);
  assert.doesNotMatch(serialized, /"tag":"note"/);
  assert.match(serialized, /"text_size":"notation"/);
  for (const expected of ['危险写入', '摘要 A', '权限提升', '摘要 B', '删除调用', '摘要 C']) {
    assert.match(serialized, new RegExp(expected));
  }
  assert.doesNotMatch(serialized, /SECRET|raw_json|evidence/);
});

test('high-risk card sorts critical first and same-severity findings by latest observed_at', () => {
  const payload = buildHighRiskAlertPayloads({
    reviewId: 'review-sort',
    window: { from: '2026-07-17T08:00:00.000Z', to: '2026-07-17T08:30:00.000Z' },
    agentId: 'agent-sort',
    agentName: '财务审计 Agent',
    traceId: 'trace-sort',
    findings: [
      { severity: 'high', title: '较新的高风险', summary: 'H', observed_at: '2026-07-17T08:29:00.000Z' },
      { severity: 'critical', title: '较旧的严重风险', summary: 'C1', observed_at: '2026-07-17T08:10:00.000Z' },
      { severity: 'critical', title: '最新的严重风险', summary: 'C2', observed_at: '2026-07-17T08:20:00.000Z' },
      { severity: 'high', title: '较旧的高风险', summary: 'H2', observed_at: '2026-07-17T08:01:00.000Z' },
    ],
  })[0];

  const serialized = JSON.stringify(payload);
  assert.match(serialized, /财务审计 Agent 的 trace-sort 发现 4 条高风险，其中 2 条严重/);
  assert.match(serialized, /首要风险[^]*最新的严重风险/);
  assert.ok(serialized.indexOf('最新的严重风险') < serialized.indexOf('较旧的严重风险'));
  assert.ok(serialized.indexOf('较旧的严重风险') < serialized.indexOf('较新的高风险'));
  assert.equal((serialized.match(/其他重点风险/g) || []).length, 1);
});

test('high-risk card shows at most three risks before the folded full detail', () => {
  const payload = buildHighRiskAlertPayloads({
    reviewId: 'review-top-three',
    window: { from: '2026-07-17T08:00:00.000Z', to: '2026-07-17T08:30:00.000Z' },
    agentId: 'agent-top',
    traceId: 'trace-top',
    findings: Array.from({ length: 5 }, (_, index) => ({
      severity: 'high',
      title: `风险-${index + 1}`,
      summary: `完整摘要-${index + 1}`,
      observed_at: `2026-07-17T08:0${index}:00.000Z`,
    })),
  })[0];

  const body = payload.card.body.elements;
  const primary = body.find((element) => (
    element.tag === 'collapsible_panel' && element.header?.title?.content === '首要风险'
  ));
  const other = body.find((element) => element.tag === 'markdown' && element.content.includes('其他重点风险'));
  const details = body.find((element) => (
    element.tag === 'collapsible_panel' && element.header?.title?.content.startsWith('全部风险名称与摘要')
  ));
  assert.ok(primary);
  assert.equal(primary.expanded, true);
  assert.equal(primary.border.color, 'orange');
  assert.match(JSON.stringify(primary), /<font color='orange'>［严重］<\/font>|<font color='yellow'>［高风险］<\/font>/);
  assert.equal((other.content.match(/^- /gm) || []).length, 2);
  assert.equal(details.header.title.content, '全部风险名称与摘要（5 项）');
  for (let index = 1; index <= 5; index += 1) {
    assert.match(JSON.stringify(details), new RegExp(`风险-${index}`));
    assert.match(JSON.stringify(details), new RegExp(`完整摘要-${index}`));
  }
});

test('primary summary is bounded and generated severity labels use orange/yellow text hierarchy', () => {
  const payload = buildHighRiskAlertPayloads({
    reviewId: 'review-primary-visual',
    window: { from: '2026-07-17T08:00:00.000Z', to: '2026-07-17T08:30:00.000Z' },
    agentId: 'agent-primary',
    traceId: 'trace-primary',
    findings: [
      { severity: 'high', title: '高风险标签', summary: '高风险摘要' },
      { severity: 'critical', title: '严重标签', summary: '很长的影响摘要'.repeat(30) },
    ],
  })[0];
  const serialized = JSON.stringify(payload);
  const primary = payload.card.body.elements.find((element) => (
    element.tag === 'collapsible_panel' && element.header?.title?.content === '首要风险'
  ));
  const primaryContent = primary.elements[0].content;

  assert.match(serialized, /<font color='orange'>［严重］<\/font>/);
  assert.match(serialized, /<font color='yellow'>［高风险］<\/font>/);
  assert.ok(primaryContent.length < 110, `primary content should be bounded: ${primaryContent.length}`);
  assert.match(primaryContent, /…$/);
});

test('business cards neutralize forbidden implementation wording from titles and summaries', () => {
  const payload = buildHighRiskAlertPayloads({
    reviewId: 'review-business-copy',
    window: { from: '2026-07-17T08:00:00.000Z', to: '2026-07-17T08:30:00.000Z' },
    agentId: 'agent-copy',
    traceId: 'trace-copy',
    findings: [{
      severity: 'high',
      title: '通过 Webhook 推送 JSON',
      summary: 'HTTP outbox canary 自定义服务消息',
    }],
  })[0];
  const serialized = JSON.stringify(payload);

  assert.doesNotMatch(serialized, /Webhook|\bJSON\b|\bHTTP\b|\boutbox\b|\bcanary\b|自定义服务消息/i);
  assert.match(serialized, /通知渠道|结构化数据|网络请求|消息队列|连通性检查|通知消息/);
});

test('high-risk card uses Chinese fallbacks, Beijing time, shortened display IDs, and one valid action', () => {
  const longAgentId = 'agent-1234567890-abcdefghijklmnopqrstuvwxyz';
  const longTraceId = 'trace-1234567890-abcdefghijklmnopqrstuvwxyz';
  const payload = buildHighRiskAlertPayloads({
    reviewId: 'review-fallback',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-16T16:30:00.000Z' },
    agentId: longAgentId,
    traceId: longTraceId,
    findings: [{ severity: 'high', title: '缺少摘要', summary: '' }],
    dashboardUrl: 'https://example.com/dashboard',
  })[0];
  const serialized = JSON.stringify(payload);

  assert.match(serialized, /暂无影响摘要，请进入 Dashboard 查看详情/);
  assert.match(serialized, /北京时间 7 月 17 日 00:00–00:30/);
  assert.match(serialized, /agent-1234…stuvwxyz/);
  assert.match(serialized, /trace-1234…stuvwxyz/);
  assert.doesNotMatch(serialized, new RegExp(longAgentId));
  assert.doesNotMatch(serialized, new RegExp(longTraceId));
  assert.equal(payload.card.body.elements.filter((element) => element.tag === 'button').length, 1);

  const withoutAction = buildHighRiskAlertPayloads({
    reviewId: 'review-no-action',
    window: { from: 'a', to: 'b' },
    findings: [{ severity: 'high', title: '身份缺失', summary: '摘要' }],
    dashboardUrl: 'javascript:alert(1)',
  })[0];
  assert.equal(withoutAction.card.body.elements.filter((element) => element.tag === 'button').length, 0);
  assert.match(JSON.stringify(withoutAction), /身份信息缺失/);
});

test('oversized high-risk content is split within one agent/trace and every payload stays below 20 KiB', () => {
  const findings = Array.from({ length: 30 }, (_, index) => ({
    severity: 'high',
    title: `风险-${index}`,
    summary: `摘要-${index}-` + '长内容'.repeat(350),
  }));
  const payloads = buildHighRiskAlertPayloads({
    reviewId: 'review-large',
    window: { from: 'a', to: 'b' },
    agentId: 'agent-large',
    traceId: 'trace-large',
    findings,
    maxPayloadBytes: 19 * 1024,
    foldThresholdChars: 1,
  });

  assert.ok(payloads.length > 1);
  for (const payload of payloads) {
    assert.ok(feishuPayloadBytes(payload) <= 19 * 1024);
    assert.ok(feishuPayloadBytes(payload) < FEISHU_WEBHOOK_MAX_BYTES);
    assert.match(JSON.stringify(payload), /agent-large/);
    assert.match(JSON.stringify(payload), /trace-large/);
  }
  const all = JSON.stringify(payloads);
  findings.forEach((finding) => assert.match(all, new RegExp(finding.title)));
});

test('sanitization neutralizes Feishu mention and link markup from untrusted logs', () => {
  const sanitized = sanitizeFeishuText('<at id=all></at> [click](https://example.com)');
  assert.doesNotMatch(sanitized, /<at|\[click\]/);
  assert.match(sanitized, /＜at id=all＞/);
});

function countTaggedComponents(value) {
  if (!value || typeof value !== 'object') return 0;
  const current = typeof value.tag === 'string' ? 1 : 0;
  if (Array.isArray(value)) {
    return current + value.reduce((sum, item) => sum + countTaggedComponents(item), 0);
  }
  return current + Object.values(value)
    .reduce((sum, item) => sum + countTaggedComponents(item), 0);
}

test('daily report produces one global management overview across agents and traces', () => {
  const payloads = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T02:00:00.000Z',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T02:00:00.000Z' },
    dashboardUrl: 'https://example.com/dashboard',
    group: {
      scope: 'global',
      event_count: 42,
      error_count: 3,
      tool_count: 7,
      agent_count: 3,
      trace_count: 5,
      tools: [
        { tool_name: 'db.read', total: 18, error_count: 0 },
        { tool_name: 'db.write', total: 8, error_count: 2 },
        { tool_name: 'shell.exec', total: 7, error_count: 1 },
        { tool_name: 'file.read', total: 5, error_count: 0 },
        { tool_name: 'cache.get', total: 3, error_count: 0 },
        { tool_name: 'ignored.sixth', total: 1, error_count: 0 },
      ],
      findings: [
        { severity: 'high', title: '写入异常', summary: '连续失败' },
        { severity: 'critical', title: '权限异常', summary: '越权调用' },
        { severity: 'high', title: '外发异常', summary: '目标未知' },
        { severity: 'high', title: 'ignored-fourth', summary: '不进入管理层总览' },
      ],
    },
  });

  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  const serialized = JSON.stringify(payload);
  assert.equal(payload.card.header.template, 'blue');
  assert.match(serialized, /覆盖 3 个 Agent · 5 条 Trace/);
  assert.match(serialized, /\*\*42\*\*\\n事件数/);
  assert.match(serialized, /\*\*3\*\*\\n异常事件数/);
  assert.match(serialized, /\*\*4\*\*\\n高风险 Trace 数/);
  for (const expected of ['权限异常', '写入异常', '外发异常']) assert.match(serialized, new RegExp(expected));
  assert.doesNotMatch(serialized, /ignored-fourth/);
  for (const expected of ['db.write', 'shell.exec', 'db.read', 'file.read', 'cache.get']) {
    assert.match(serialized, new RegExp(expected.replaceAll('.', '\\.')));
  }
  assert.doesNotMatch(serialized, /ignored\.sixth/);
  assert.doesNotMatch(serialized, /agent_id|trace_id|agent-daily|trace-daily/);
  assert.doesNotMatch(serialized, /高风险名称与摘要|工具调用统计/);
  assert.doesNotMatch(serialized, /"tag":"note"/);
  assert.equal(payload.card.body.elements.filter((element) => element.tag === 'button').length, 1);
  assert.match(serialized, /查看完整日报/);
});

test('daily report still sends one blue overview when no risk is found', () => {
  const payloads = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T09:00:00.000Z',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
    group: {
      scope: 'global',
      agent_count: 4,
      trace_count: 9,
      event_count: 28,
      error_count: 0,
      tool_count: 1,
      tools: [{ tool_name: 'db.read', total: 28, error_count: 0 }],
      findings: [],
    },
  });

  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  const serialized = JSON.stringify(payload);
  assert.equal(payload.card.header.template, 'blue');
  assert.match(serialized, /今日未发现异常或高风险，整体运行正常/);
  assert.match(serialized, /覆盖 4 个 Agent · 9 条 Trace/);
  assert.doesNotMatch(serialized, /Top 风险|高风险名称与摘要/);
});

test('daily report explicitly reports an empty audit window and still sends one card', () => {
  const payloads = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T09:00:00.000Z',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
    group: {
      scope: 'global',
      agent_count: 0,
      trace_count: 0,
      event_count: 0,
      error_count: 0,
      tool_count: 0,
      tools: [],
      findings: [],
    },
  });

  assert.equal(payloads.length, 1);
  const serialized = JSON.stringify(payloads[0]);
  assert.match(serialized, /统计窗口内暂无审计事件/);
  assert.match(serialized, /覆盖 0 个 Agent · 0 条 Trace/);
  assert.doesNotMatch(serialized, /Top 风险|Top 工具|高风险名称与摘要|工具调用统计/);
});

test('daily report with non-risk errors recommends detail review', () => {
  const payload = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T09:00:00.000Z',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
    dashboardUrl: 'https://example.com/dashboard',
    group: {
      scope: 'global',
      agent_count: 1,
      trace_count: 1,
      event_count: 4,
      error_count: 2,
      tool_count: 0,
      tools: [],
      findings: [],
    },
  })[0];
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /存在 2 条异常事件，暂未形成高风险发现，建议查看详情/);
  assert.match(serialized, /统计范围：7 月 17 日 00:00–17:00 · 北京时间/);
  assert.doesNotMatch(serialized, /Top 风险|Top 工具|高风险名称与摘要|工具调用统计/);
  assert.equal(payload.card.body.elements.filter((element) => element.tag === 'button').length, 1);
  assert.match(serialized, /查看完整日报/);
});

test('many tiny findings split before the JSON 2.0 component ceiling', () => {
  const findings = Array.from({ length: 260 }, (_, index) => ({
    severity: 'high',
    title: `R${index}`,
    summary: 'S',
  }));
  const payloads = buildHighRiskAlertPayloads({
    reviewId: 'review-components',
    window: { from: '2026-07-17T08:00:00.000Z', to: '2026-07-17T08:30:00.000Z' },
    agentId: 'agent-components',
    traceId: 'trace-components',
    findings,
  });
  assert.ok(payloads.length > 1);
  assert.match(payloads[0].card.header.title.content, /（1\/\d+）/);
  const serialized = JSON.stringify(payloads);
  findings.forEach((finding) => assert.match(serialized, new RegExp(`\\b${finding.title}\\b`)));
});

test('oversized daily input stays one compact card below byte and component limits', () => {
  const findings = Array.from({ length: 14 }, (_, index) => ({
    severity: index % 4 === 0 ? 'critical' : 'high',
    title: `日报风险-${index}`,
    summary: `日报完整摘要-${index}-` + '影响说明'.repeat(600),
    observed_at: `2026-07-17T08:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const tools = Array.from({ length: 80 }, (_, index) => ({
    tool_name: `daily.tool.${index}`,
    total: 100 - index,
    error_count: index % 5,
  }));
  const payloads = buildDailyReportPayloads({
    date: '2026-07-17',
    generatedAt: '2026-07-17T09:00:00.000Z',
    window: { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T09:00:00.000Z' },
    dashboardUrl: 'https://example.com/dashboard',
    maxPayloadBytes: 19 * 1024,
    group: {
      scope: 'global',
      agent_count: 120,
      trace_count: 600,
      event_count: 999,
      error_count: 20,
      tool_count: tools.length,
      tools,
      findings,
    },
  });
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  const serialized = JSON.stringify(payload);
  assert.equal(payload.card.header.template, 'blue');
  assert.doesNotMatch(payload.card.header.title.content, /（\d+\/\d+）/);
  assert.match(serialized, /覆盖 120 个 Agent · 600 条 Trace/);
  assert.ok(feishuPayloadBytes(payload) <= 19 * 1024);
  assert.ok(feishuPayloadBytes(payload) < FEISHU_WEBHOOK_MAX_BYTES);
  assert.ok(countTaggedComponents(payload.card) <= 190);
  for (const title of ['日报风险-12', '日报风险-8', '日报风险-4']) {
    assert.match(serialized, new RegExp(title));
  }
  assert.doesNotMatch(serialized, /日报风险-13|日报风险-0|daily\.tool\.79/);
});


test('Trace card stays single and bounded, preserves task context, sampling and exact detail URL', () => {
  const dashboardUrl = 'https://audit.example/dashboard/agents/a%2Fb/traces/t%3Ac';
  const payload = buildTraceAlertPayload({ dashboardUrl, trace: {
    agent_id: 'a/b', trace_id: 't:c', requester_id: '发起用户',
    original_request: '原始请求内容'.repeat(3000), expected_purpose: '预期目的内容'.repeat(3000),
    agent_result: '失败结果内容'.repeat(3000), risk_reason: '风险原因内容'.repeat(3000),
    review_input_sampled: 1, raw_json: 'SECRET_RAW', findings: Array(300).fill({ title: 'SECRET_FINDING' }),
  } });
  assert.equal(payload.card.header.title.content, '高风险审计告警');
  assert.ok(feishuPayloadBytes(payload) <= 19 * 1024);
  const text = JSON.stringify(payload);
  for (const label of ['发起用户', '原始请求', '预期目的', '失败结果', '风险原因', '审查结论基于采样证据']) {
    assert.ok(text.includes(label));
  }
  assert.doesNotMatch(text, /SECRET_RAW|SECRET_FINDING|严重审计风险/);
  const reason = payload.card.body.elements.find(row => row.content?.startsWith('**风险原因**'));
  assert.ok(Array.from(reason.content.split('\n')[1]).length <= 200);
  const buttons = payload.card.body.elements.filter(row => row.tag === 'button');
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].behaviors[0].default_url, dashboardUrl);
});

test('missing expected purpose is not replaced by user request', () => {
  const payload = buildTraceAlertPayload({ trace: { agent_id: 'a', trace_id: 't', original_request: 'ONLY_REQUEST' } });
  const purpose = payload.card.body.elements.find(row => row.content?.startsWith('**预期目的**'));
  assert.equal(purpose.content, '**预期目的**\n未提供');
});

test('daily card ignores deprecated critical count and shows all Trace status/risk buckets', () => {
  const payload = buildDailyReportPayloads({ group: { event_count: 10, high_risk_count: 1, critical_count: 999,
    trace_status_counts: { success: 1, failed: 2, interrupted: 3, incomplete: 4 },
    risk_level_counts: { none: 1, low: 2, medium: 3, high: 1 },
    top_risks: [{ severity: 'medium', title: '恢复后完成', summary: '工具失败后恢复' }],
  } })[0];
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /999|严重风险数|严重审计风险/);
  for (const label of ['成功', '失败', '中断', '不完整', '低风险', '中风险', '高风险']) assert.ok(text.includes(label));
  assert.match(text, /［中风险］/);
});


test('legacy daily critical Finding renders as high without mutating historical input', () => {
  const group = { high_risk_count: 1, critical_count: 1,
    findings: [{ severity: 'critical', title: '历史风险', summary: '历史证据' }] };
  const original = structuredClone(group);
  const text = JSON.stringify(buildDailyReportPayloads({ group }));
  assert.match(text, /［高风险］/);
  assert.doesNotMatch(text, /［严重］|严重风险数|严重审计风险/);
  assert.deepEqual(group, original);
});


test('daily conclusion does not describe unreviewed or medium-risk Traces as normal', () => {
  for (const group of [
    { event_count: 2, trace_count: 1, reviewed_trace_count: 0, risk_level_counts: { none: 0, low: 0, medium: 0, high: 0 } },
    { event_count: 2, trace_count: 1, reviewed_trace_count: 1, risk_level_counts: { none: 0, low: 0, medium: 1, high: 0 } },
  ]) {
    const payload = buildDailyReportPayloads({ group: { ...group, top_risks: [] } })[0];
    const conclusion = payload.card.body.elements[0].content;
    assert.doesNotMatch(conclusion, /整体运行正常/);
    assert.match(conclusion, /尚未形成收敛结论|中风险/);
  }
});
