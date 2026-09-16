import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createHttpApp } from '../../src/adapters/http/app.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';
import { readTraceDetail, readTracePage, traceHealth } from '../../src/auditReview/traceReadService.js';
import { createRetentionService } from '../../src/auditReview/retention.js';

const AT = '2026-09-16T10:00:00.000Z';
function fixture(t) {
  const db = openDb(':memory:');
  ensureReviewSchema(db);
  t.after(() => db.close());
  return db;
}

function seed(db, agent = 'a', trace = 'trace', at = AT, overrides = {}) {
  db.prepare(`INSERT INTO audit_traces (agent_id,trace_id,requester_id,original_request,
    agent_result,context_status,last_event_at,updated_at) VALUES (?,?,'user','request','result','complete',?,?)`).run(agent, trace, at, AT);
  for (const [key, value] of Object.entries(overrides)) {
    db.prepare(`UPDATE audit_traces SET ${key}=? WHERE agent_id=? AND trace_id=?`).run(value, agent, trace);
  }
  db.prepare(`INSERT INTO audit_events (row_hash,ts,agent_id,trace_id,span_id,event,tool_name,status,
    raw_json,ingested_at,redaction_hits) VALUES (?,?,?,?,'span','run.start','shell','OK',?,?,?)`)
    .run(`${agent}:${trace}`, at, agent, trace, JSON.stringify({ full: '原始证据', nested: { keep: true } }), AT, '2');
}

const page = (db, query = '', options) => readTracePage(db, new URLSearchParams(query), options);

test('trace projection preserves complete ordered evidence and composite identity without ingestion metrics', (t) => {
  const db = fixture(t);
  seed(db, 'a', 'same', AT, { review_version: 2, trace_status: 'success', risk_level: 'medium',
    review_input_sampled: 1, omitted_event_count: 100, evidence_event_ids: '[1]' });
  seed(db, 'b', 'same');
  db.prepare('UPDATE audit_events SET llm_intent_json=? WHERE agent_id=?').run('{"input":"核查请求","output":"执行结果"}', 'a');
  db.prepare(`INSERT INTO audit_events (row_hash,ts,agent_id,trace_id,span_id,event,tool_name,status,raw_json)
    VALUES ('extra','2026-09-15T00:00:00.000Z','a','same','s','tool.end','sql','ERROR','{"complete":"yes"}')`).run();
  const result = page(db, 'agent_id=a&trace_id=same&event=tool.end&tool_name=sql&status=ERROR&with_total=true');
  assert.equal(result.total_count, 1);
  assert.equal(result.count, 1);
  assert.equal(result.traces[0].events.length, 2);
  assert.equal(result.traces[0].event_count, 2);
  assert.deepEqual(result.traces[0].events.map((e) => e.event_id), [3, 1]);
  assert.deepEqual(result.traces[0].events[1].raw_json, { full: '原始证据', nested: { keep: true } });
  assert.deepEqual(result.traces[0].events[1].llm_intent, { input: '核查请求', output: '执行结果' });
  assert.equal(result.traces[0].review_input_sampled, true);
  assert.equal(result.traces[0].omitted_event_count, 100);
  assert.equal(result.traces[0].audit_result.risk_level, 'medium');
  assert.deepEqual(result.traces[0].audit_result.evidence_event_ids, [1]);
  assert.equal(JSON.stringify(result).includes('redaction_hits'), false);
  assert.deepEqual(readTraceDetail(db, 'a', 'same'), result.traces[0]);
  assert.equal(readTraceDetail(db, 'b', 'same').audit_result, null);
  assert.equal(readTraceDetail(db, 'missing', 'same'), null);
});

test('cursor pages use trace grain, three tie breakers and remain stable as newer traces arrive', (t) => {
  const db = fixture(t);
  for (const [agent, trace] of [['a', '1'], ['a', '2'], ['b', '1'], ['b', '2']]) seed(db, agent, trace);
  const first = page(db, 'limit=1&with_total=true');
  assert.equal(first.total_count, 4);
  assert.deepEqual(Object.keys(JSON.parse(Buffer.from(first.next_cursor, 'base64url'))).sort(), ['agent_id', 'last_event_at', 'trace_id']);
  seed(db, 'new', 'new', '2026-09-16T11:00:00.000Z');
  const identities = ['a/1'];
  let cursor = first.next_cursor;
  while (cursor) {
    const next = page(db, `limit=1&cursor=${cursor}`);
    assert.equal('total_count' in next, false);
    identities.push(...next.traces.map((row) => `${row.agent_id}/${row.trace_id}`));
    cursor = next.next_cursor;
  }
  assert.deepEqual(identities, ['a/1', 'a/2', 'b/1', 'b/2']);
});

test('soft byte limit returns one indivisible oversized trace and always advances', (t) => {
  const db = fixture(t);
  for (let i = 0; i < 3; i++) seed(db, 'a', String(i));
  const seen = [];
  let cursor;
  do {
    const result = page(db, `limit=50${cursor ? `&cursor=${cursor}` : ''}`, { maxResponseBytes: 1 });
    assert.equal(result.count, 1);
    assert.equal(result.traces[0].events.length, 1);
    seen.push(result.traces[0].trace_id);
    assert.ok(seen.length <= 3, 'pagination must make forward progress');
    cursor = result.next_cursor;
    assert.equal(result.has_more, Boolean(cursor));
  } while (cursor);
  assert.deepEqual(seen, ['0', '1', '2']);
});

test('budget measures UTF-8 serialized response including metadata; limits clamp at 200', (t) => {
  const db = fixture(t);
  seed(db, 'a', '1'); seed(db, 'a', '2'); seed(db, 'a', '3');
  const one = page(db, 'limit=1');
  const budget = Buffer.byteLength(JSON.stringify(one)) + 10;
  const result = page(db, 'limit=999', { maxResponseBytes: budget });
  assert.equal(result.limit_applied, 200);
  assert.equal(result.count, 1);
  assert.equal(result.has_more, true);
  assert.equal(page(db).limit_applied, 50);
  assert.equal('total_count' in page(db, 'with_total=false'), false);
});

test('filters validate and select complete traces by requester, conclusion and last activity range', (t) => {
  const db = fixture(t);
  seed(db, 'a', '1', AT, { review_version: 1, trace_status: 'failed', risk_level: 'high' });
  seed(db, 'a', '2', '2026-09-15T10:00:00.000Z');
  assert.equal(page(db, 'requester_id=user&risk_level=high&trace_status=failed&context_status=complete&from=2026-09-16&to=2026-09-17').count, 1);
  for (const query of ['limit=0', 'limit=1.2', 'risk_level=critical', 'trace_status=no', 'context_status=no',
    'from=no', 'from=2026-09-17&to=2026-09-16', 'with_total=1', 'include_events=false', 'agent_id=a&agent_id=b']) {
    assert.throws(() => page(db, query), { code: 'invalid_filter' }, query);
  }
  for (const value of ['', '???', Buffer.from('{}').toString('base64url'), Buffer.from(JSON.stringify({ last_event_at: 'bad', agent_id: 'a', trace_id: 'x' })).toString('base64url')]) {
    assert.throws(() => page(db, `cursor=${encodeURIComponent(value)}`), { code: 'invalid_cursor' });
  }
});

test('nullable legacy timestamp and equal timestamp event IDs paginate deterministically', (t) => {
  const db = fixture(t);
  seed(db, 'a', '1'); seed(db, 'a', '2'); seed(db, 'b', '3');
  db.prepare('UPDATE audit_traces SET last_event_at=NULL WHERE trace_id <> ?').run('1');
  const first = page(db, 'limit=1');
  const second = page(db, `limit=1&cursor=${first.next_cursor}`);
  const third = page(db, `limit=1&cursor=${second.next_cursor}`);
  assert.deepEqual([first, second, third].map((p) => p.traces[0].trace_id), ['1', '2', '3']);
  assert.equal(third.next_cursor, null);
});

test('health counts current illegal combinations, exhausted reviews and recent per-agent redaction hits', (t) => {
  const db = fixture(t);
  seed(db, 'a', 'invalid', AT, { trace_status: 'incomplete', risk_level: 'high' });
  seed(db, 'a', 'failed', AT, { sealed_at: AT, review_error: 1, review_retry_count: 2 });
  seed(db, 'b', 'retry', AT, { sealed_at: AT, review_error: 1, review_retry_count: 1 });
  db.prepare("UPDATE audit_events SET ingested_at='2026-09-01T00:00:00.000Z' WHERE agent_id='b'").run();
  const result = traceHealth(db, { now: new Date(AT) });
  assert.equal(result.total, 3);
  assert.equal(result.sealed, 2);
  assert.equal(result.invalid_combinations, 1);
  assert.equal(result.review_retries_exhausted, 1);
  db.prepare("UPDATE audit_traces SET review_version=1 WHERE trace_id='failed'").run();
  assert.equal(traceHealth(db).review_retries_exhausted, 1);
  assert.deepEqual(result.redaction_hits_by_agent, [{ agent_id: 'a', redaction_hits: 4 }]);
  db.prepare("UPDATE audit_traces SET trace_status='failed' WHERE trace_id='invalid'").run();
  assert.equal(traceHealth(db).invalid_combinations, 0);
  assert.equal(JSON.stringify(result).includes('original_request'), false);
});

async function server(t, db, { token = 'test-token', http = {} } = {}) {
  const config = { dbPath: ':memory:', auditReview: { http } };
  const retentionService = createRetentionService({ db, config, now: () => new Date(AT) });
  const app = createHttpApp({ db, config, retentionService, dashboardAuth: createDashboardAuth({ config, env: { AUDIT_AGENT_DASHBOARD_TOKEN: token } }), now: () => new Date(AT) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  return { app, url: `http://127.0.0.1:${app.address().port}` };
}
const headers = { authorization: 'Bearer test-token' };

test('HTTP export requires configured Bearer authentication without affecting /query', async (t) => {
  const db = fixture(t);
  seed(db);
  const { url } = await server(t, db, { token: '' });
  const response = await fetch(`${url}/v1/audit-logs`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error_code, 'auth_not_configured');
  assert.equal((await fetch(`${url}/query`)).status, 200);
});

test('HTTP export normalizes auth/filter/cursor codes and never triggers review or ingestion', async (t) => {
  const db = fixture(t);
  seed(db);
  const before = db.prepare('SELECT total_changes() AS count').get().count;
  const { url } = await server(t, db);
  for (const authorization of ['', 'Bearer wrong']) {
    const response = await fetch(`${url}/v1/audit-logs`, { headers: { authorization } });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error_code, 'unauthorized');
  }
  for (const [query, code] of [['limit=-1', 'invalid_filter'], ['cursor=bad', 'invalid_cursor']]) {
    const response = await fetch(`${url}/v1/audit-logs?${query}`, { headers });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, code);
  }
  const response = await fetch(`${url}/v1/audit-logs`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).traces[0].events.length, 1);
  assert.equal(db.prepare('SELECT total_changes() AS count').get().count, before);
});

test('export GET and preflight use only configured CORS allowlist', async (t) => {
  const db = fixture(t);
  const { url } = await server(t, db, { http: { allowedOrigins: ['https://allowed.example'] } });
  for (const method of ['GET', 'OPTIONS']) {
    for (const origin of ['https://allowed.example', 'https://other.example']) {
      const response = await fetch(`${url}/v1/audit-logs`, { method, headers: { ...headers, origin } });
      assert.equal(response.headers.get('access-control-allow-origin'), origin.includes('allowed') ? origin : null);
    }
  }
});

test('independent concurrent export cap returns 429 and frees slots after completion', async (t) => {
  const db = fixture(t);
  seed(db);
  const { app, url } = await server(t, db, { http: { maxConcurrentTraceExports: 1 } });
  // Pipelining dispatches two HTTP requests before the first deferred DB read begins.
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect(app.address().port, '127.0.0.1');
    let data = '';
    socket.on('error', reject);
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('connect', () => socket.write(
      'GET /v1/audit-logs HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-token\r\n\r\n'
      + 'GET /v1/audit-logs HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-token\r\nConnection: close\r\n\r\n'));
  });
  assert.match(raw, /HTTP\/1\.1 200/);
  assert.match(raw, /HTTP\/1\.1 429/);
  assert.match(raw, /rate_limited/);
  assert.equal((await fetch(`${url}/v1/audit-logs`, { headers })).status, 200);
});

test('HTTP health includes trace and redaction metrics', async (t) => {
  const db = fixture(t);
  seed(db);
  const { url } = await server(t, db);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.traces.total, 1);
  assert.equal(body.traces.review_failed_pending_cleanup, 0);
  assert.deepEqual(body.traces.redaction_hits_by_agent, [{ agent_id: 'a', redaction_hits: 2 }]);
  db.prepare(`UPDATE audit_traces SET sealed_at=?, last_event_at='2026-07-01T00:00:00.000Z',
    ingested_watermark=?, review_error=1, review_retry_count=2`).run(AT, AT);
  const failed = await (await fetch(`${url}/health`)).json();
  assert.equal(failed.traces.review_failed_pending_cleanup, 1, 'health must use the actual retention selection');
});

test('Dashboard routes decode composite keys and pass group/user controls, including unknown requester', async (t) => {
  const calls = [];
  const model = { page: { title: 'Task' }, sections: [], filters: [], summary_metrics: [] };
  const visualization = Object.fromEntries(['agentPage', 'requesterTasksPage', 'traceDetailPage'].map((name) => [name, (...args) => {
    calls.push([name, ...args]);
    return args[1] === 'missing' ? null : model;
  }]));
  const app = createHttpApp({ db: {}, config: {}, scheduler: {}, reviewStore: {}, visualization,
    dashboardAuth: createDashboardAuth({ config: {}, env: {} }) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = `http://127.0.0.1:${app.address().port}`;
  assert.equal((await fetch(`${url}/dashboard/agents/a%2Fb/traces/t%2F1`)).status, 200);
  assert.equal((await fetch(`${url}/dashboard/agents/a%2Fb/requesters/u%2F1?page=2`)).status, 200);
  assert.equal((await fetch(`${url}/dashboard/agents/a%2Fb?q=find&groups=40&requester_id=&page=3&expand=all`)).status, 200);
  assert.deepEqual(calls, [
    ['traceDetailPage', 'a/b', 't/1'],
    ['requesterTasksPage', 'a/b', 'u/1', { page: '2' }],
    ['agentPage', 'a/b', { search: 'find', groups: '40', expand: 'all', requesterId: '', page: '3' }],
  ]);
  assert.equal((await fetch(`${url}/dashboard/agents/a/traces/missing`)).status, 404);
  assert.equal((await fetch(`${url}/dashboard/agents/%ZZ/traces/t`)).status, 400);
});
