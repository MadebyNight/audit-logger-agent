import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDemoTrace, runAuditDemo, validateBatchReview } from '../scripts/send-audit-demo-logs.js';
import { validateLogEntry } from '../scripts/lib/parser.js';

for (const kind of ['normal', 'medium-risk', 'high-risk']) {
  test(`${kind} emits strict-compatible evidence and paired spans`, () => {
    const batch = buildDemoTrace(kind);
    for (const event of batch.events) assert.deepEqual(validateLogEntry(event, 1, { mode: 'strict' }), []);
    assert.equal(batch.events.at(-1).event, kind === 'high-risk' ? 'run.failed' : 'run.final_result');
    assert.equal(batch.events.at(-1).span_id, batch.events[0].span_id);
    for (const start of batch.events.filter(e => e.event === 'tool.start')) {
      assert.equal(batch.events.filter(e => e.span_id === start.span_id && ['tool.end', 'tool.error'].includes(e.event)).length, 1);
    }
    if (kind === 'medium-risk') {
      assert.ok(batch.events.some(e => e.event === 'tool.error'));
      assert.ok(batch.events.some(e => e.event === 'tool.end'));
      assert.notEqual(batch.events[2].span_id, batch.events[4].span_id);
    }
  });
}

test('scenario selection rejects unsupported kinds and invalid random indices', () => {
  assert.throws(() => buildDemoTrace('invalid'), /不支持/);
  assert.throws(() => buildDemoTrace('normal', { randomIntImpl: () => -1 }), /越界/);
});

test('Trace validation rejects wrong identity, incomplete evidence and wrong risk', () => {
  const batch = buildDemoTrace('high-risk');
  const trace = { agent_id: batch.agentId, trace_id: batch.traceId, events: batch.events,
    audit_result: { review_version: 1, trace_status: 'failed', risk_level: 'high' } };
  assert.doesNotThrow(() => validateBatchReview(batch, trace));
  assert.throws(() => validateBatchReview(batch, { ...trace, agent_id: 'other' }), /复合标识/);
  assert.throws(() => validateBatchReview(batch, { ...trace, events: [] }), /不完整/);
  assert.throws(() => validateBatchReview(batch, { ...trace, audit_result: { ...trace.audit_result, risk_level: 'medium' } }), /不符合/);
});

test('dry-run transport exercises all traces without network, Finding or notification requests', async () => {
  const batches = [];
  const polls = new Map();
  const result = await runAuditDemo({ env: {
    AUDIT_DEMO_BASE_URL: 'http://127.0.0.1:9320', AUDIT_AGENT_DASHBOARD_TOKEN: 'local-test',
    AUDIT_DEMO_REVIEW_TIMEOUT_MS: '10', AUDIT_DEMO_POLL_INTERVAL_MS: '1',
  }, sleepImpl: async () => {}, log: () => {}, fetchImpl: async (address, options) => {
    const url = new URL(address);
    assert.equal(url.hostname, '127.0.0.1');
    let body;
    if (url.pathname === '/health') {
      body = { status: 'ok', db: { writable: true }, notification_digest: { feishu_mode: 'dry-run' } };
    } else if (url.pathname === '/v1/ingest') {
      const { events } = JSON.parse(options.body);
      for (const event of events) assert.deepEqual(validateLogEntry(event, 1, { mode: 'strict' }), []);
      batches.push(events);
      body = { accepted: events.length, rejected: 0 };
    } else {
      assert.equal(url.pathname, '/v1/audit-logs');
      assert.equal(options.headers.authorization, 'Bearer local-test');
      const events = batches.find(events => events[0].agent_id === url.searchParams.get('agent_id') && events[0].trace_id === url.searchParams.get('trace_id'));
      assert.ok(events);
      const count = polls.get(events) ?? 0;
      polls.set(events, count + 1);
      body = { traces: [{ agent_id: events[0].agent_id, trace_id: events[0].trace_id, events,
        audit_result: count === 0 ? null : { review_version: 1,
          trace_status: events.at(-1).event === 'run.failed' ? 'failed' : 'success',
          risk_level: events.at(-1).event === 'run.failed' ? 'high' : events.some(e => e.event === 'tool.error') ? 'medium' : 'none' } }] };
    }
    return new Response(JSON.stringify(body));
  } });
  assert.equal(result.normal.auditResult.risk_level, 'none');
  assert.equal(result.mediumRisk.auditResult.risk_level, 'medium');
  assert.equal(result.highRisk.auditResult.risk_level, 'high');
  assert.deepEqual(batches.map(events => events.length), [6, 8, 6]);
  assert.ok(result.highRisk.dashboardUrl.includes('/dashboard/agents/'));
});

test('missing token fails before network access', async () => {
  await assert.rejects(runAuditDemo({ env: {}, fetchImpl: () => { throw new Error('network forbidden'); } }), /TOKEN/);
});
