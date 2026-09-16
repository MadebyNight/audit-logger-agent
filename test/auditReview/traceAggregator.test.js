import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createTraceStore, computeInputHash } from '../../src/auditReview/traceStore.js';
import { createTraceAggregator } from '../../src/auditReview/traceAggregator.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createLlmReviewer } from '../../src/auditReview/llmReviewer.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      span_id TEXT NOT NULL,
      parent_span_id TEXT,
      event TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      requester_id TEXT,
      original_request TEXT,
      agent_result TEXT,
      expected_purpose TEXT,
      error_message TEXT,
      result_summary TEXT,
      llm_intent_json TEXT,
      ingested_at TEXT NOT NULL
    );
  `);
  ensureReviewSchema(db);
  return db;
}

function insertEvent(db, id, event, overrides = {}) {
  db.prepare(`
    INSERT INTO audit_events (
      id, ts, agent_id, trace_id, span_id, event, tool_name, status, duration_ms,
      requester_id, original_request, agent_result, expected_purpose, error_message, result_summary, llm_intent_json, ingested_at
    ) VALUES (
      @id, @ts, @agent_id, @trace_id, @span_id, @event, @tool_name, @status, @duration_ms,
      @requester_id, @original_request, @agent_result, @expected_purpose, @error_message, @result_summary, @llm_intent_json, @ingested_at
    )
  `).run({
    id,
    ts: overrides.ts ?? '2026-09-14T11:00:00.000Z',
    agent_id: 'agent-a',
    trace_id: 'trace-a',
    span_id: `span-${id}`,
    event,
    tool_name: 'tool',
    status: 'OK',
    duration_ms: 1,
    requester_id: id === 1 ? 'user-1' : null,
    original_request: id === 1 ? '用户请求' : null,
    agent_result: overrides.agent_result ?? null,
    expected_purpose: null,
    error_message: null,
    result_summary: null,
    llm_intent_json: null,
    ingested_at: overrides.ingested_at ?? `2026-09-14T11:00:0${id}.000Z`,
    ...overrides,
  });
}

function makeDeps(db, llmClient) {
  const traceStore = createTraceStore(db);
  return {
    traceStore,
    lockStore: createLockStore(db),
    llmReviewer: createLlmReviewer({ llmClient: llmClient ?? { async createStructuredResponse() { throw new Error('unexpected LLM call'); } }, model: 'test-model' }),
  };
}

function makeAggregator(db, deps, config = {}) {
  return createTraceAggregator({
    db,
    config: { auditReview: { traceReview: config } },
    ...deps,
    now: () => NOW,
  });
}

test('terminal trace is sealed and deterministically reviewed without LLM', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.start');
  insertEvent(db, 2, 'run.final_result', { agent_result: '完成', ts: '2026-09-14T11:01:00.000Z' });
  const deps = makeDeps(db);
  const aggregator = makeAggregator(db, deps);
  const result = await aggregator.run();

  assert.equal(result.scannedEvents, 2);
  const trace = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(trace.sealed_reason, 'terminal_event');
  assert.equal(trace.trace_status, 'success');
  assert.equal(trace.risk_level, 'none');
  assert.equal(trace.review_version, 1);
  assert.ok(trace.input_hash);
  db.close();
});

test('failed trace is high without LLM', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.start');
  insertEvent(db, 2, 'run.failed', { agent_result: '失败原因', status: 'INTERNAL' });
  const deps = makeDeps(db);
  await makeAggregator(db, deps).run();
  const trace = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(trace.trace_status, 'failed');
  assert.equal(trace.risk_level, 'high');
  db.close();
});

test('waiting user timeout is pending then incomplete-none after LLM fallback result', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.start', { ts: '2026-09-12T10:00:00.000Z' });
  insertEvent(db, 2, 'run.waiting_user', { ts: '2026-09-12T10:01:00.000Z', ingested_at: '2026-09-14T11:00:02.000Z' });
  const client = {
    async createStructuredResponse() {
      return {
        risk_level: 'none',
        risk_reason: '用户长时间未回复，链路缺少终止事件，当前仅能确认任务未完成，需要人工确认最终结果。',
        evidence_event_ids: [2],
      };
    },
  };
  const deps = makeDeps(db, client);
  await makeAggregator(db, deps).run();
  const trace = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(trace.sealed_reason, 'waiting_user_timeout');
  assert.equal(trace.trace_status, 'incomplete');
  assert.equal(trace.risk_level, 'none');
  assert.notEqual(trace.risk_level, 'high');
  db.close();
});

test('late event unseals and increments review version', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.start');
  insertEvent(db, 2, 'run.final_result', { agent_result: '完成', ingested_at: '2026-09-14T11:00:02.000Z' });
  const deps = makeDeps(db);
  const aggregator = makeAggregator(db, deps);
  await aggregator.run();
  const first = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(first.review_version, 1);

  insertEvent(db, 3, 'run.failed', {
    ts: '2026-09-14T11:00:30.000Z',
    ingested_at: '2026-09-14T11:59:00.000Z',
    agent_result: '补报失败',
    status: 'INTERNAL',
  });
  await aggregator.run();
  const second = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(second.sealed_reason, 'terminal_event');
  assert.equal(second.review_version, 2);
  assert.equal(second.risk_level, 'high');
  assert.equal(second.revision_count, 1);
  db.close();
});

test('LLM failure writes review error without input hash and is retried later', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.start', { ts: '2026-09-14T10:58:00.000Z' });
  insertEvent(db, 2, 'tool.end', { ts: '2026-09-14T10:59:00.000Z', ingested_at: '2026-09-14T11:00:02.000Z' });
  let calls = 0;
  const client = {
    async createStructuredResponse() {
      calls++;
      if (calls === 1) throw new Error('service unavailable');
      return {
        risk_level: 'none',
        risk_reason: '用户长时间未回复，链路缺少终止事件，当前仅能确认任务未完成，需要人工确认最终结果。',
        evidence_event_ids: [2],
      };
    },
  };
  const deps = makeDeps(db, client);
  const aggregator = makeAggregator(db, deps);
  await aggregator.run();
  const failed = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(failed.review_error, 1);
  assert.equal(failed.review_retry_count, 1);
  assert.equal(failed.input_hash, null);

  await aggregator.run();
  const recovered = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(calls, 2);
  assert.equal(recovered.review_error, 0);
  assert.ok(recovered.input_hash);
  db.close();
});

test('failed trace output stays high after a later success event', async () => {
  const db = makeDb();
  insertEvent(db, 1, 'run.failed', { agent_result: '失败', status: 'INTERNAL' });
  const deps = makeDeps(db);
  const aggregator = makeAggregator(db, deps);
  await aggregator.run();
  insertEvent(db, 2, 'run.final_result', { agent_result: '完成', ts: '2026-09-14T11:02:00.000Z', ingested_at: '2026-09-14T11:59:00.000Z' });
  await aggregator.run();
  const trace = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(trace.risk_level, 'high');
  assert.equal(trace.review_version, 2);
  db.close();
});

test('input sampling is deterministic and bounded', async () => {
  const db = makeDb();
  for (let i = 1; i <= 6; i++) insertEvent(db, i, i === 1 ? 'run.start' : 'tool.end', { ts: `2026-09-14T11:00:0${i}.000Z` });
  insertEvent(db, 7, 'run.final_result', { agent_result: '完成', ts: '2026-09-14T11:01:00.000Z' });
  const deps = makeDeps(db);
  const aggregator = makeAggregator(db, deps, { maxEventsPerTrace: 3 });
  await aggregator.run();
  const trace = deps.traceStore.getTrace('agent-a', 'trace-a');
  assert.equal(trace.review_input_sampled, 1);
  assert.equal(trace.omitted_event_count, 4);
  assert.deepEqual(JSON.parse(trace.evidence_event_ids), [7]);
  db.close();
});

test('schema migration adds trace tables, event columns, and backfills unreviewed history', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, agent_id TEXT NOT NULL,
    trace_id TEXT NOT NULL, span_id TEXT NOT NULL, event TEXT NOT NULL, tool_name TEXT NOT NULL,
    status TEXT NOT NULL, ingested_at TEXT NOT NULL
  );`);
  db.prepare(`INSERT INTO audit_events (ts, agent_id, trace_id, span_id, event, tool_name, status, ingested_at)
    VALUES ('2026-09-13T10:00:00.000Z', 'old-agent', 'old-trace', 'span', 'tool.end', 'tool', 'OK', '2026-09-13T10:00:01.000Z')`).run();
  ensureReviewSchema(db);
  const trace = db.prepare(`SELECT * FROM audit_traces WHERE agent_id = 'old-agent' AND trace_id = 'old-trace'`).get();
  assert.equal(trace.sealed_reason, 'backfill');
  assert.equal(trace.risk_level, 'unreviewed');
  assert.equal(trace.trace_status, 'pending');
  assert.equal(trace.review_version, 0);
  const cursor = db.prepare(`SELECT * FROM audit_trace_scan_cursor WHERE cursor_name = 'trace_aggregation'`).get();
  assert.equal(cursor.last_event_id, 1);
  db.close();
});

test('trace store rejects invalid combination and input hash skip', async () => {
  const db = makeDb();
  const store = createTraceStore(db);
  store.upsertPendingTrace({
    agent_id: 'a', trace_id: 't', context_status: 'complete',
    first_event_at: '2026-09-14T11:00:00.000Z', last_event_at: '2026-09-14T11:00:00.000Z',
    ingested_watermark: '2026-09-14T11:00:00.000Z', event_count: 1,
    requester_id: 'u', original_request: 'q', expected_purpose: null, agent_result: 'r',
  });
  const trace = { agent_id: 'a', trace_id: 't', events: [{ event_id: 1, ts: '2026-09-14T11:00:00.000Z', event: 'run.final_result', status: 'OK', tool_name: 'tool' }] };
  const hash = computeInputHash(trace);
  assert.throws(() => store.applySuccessfulReview({
    trace: { agent_id: 'a', trace_id: 't' },
    outcome: { trace_status: 'incomplete', risk_level: 'high', risk_reason: 'x'.repeat(50), evidence_event_ids: [1] },
    inputHash: hash,
  }), /invalid trace outcome/);
  db.close();
});

test('review retry exhaustion marks the trace reason as incomplete', () => {
  const db = makeDb();
  const store = createTraceStore(db);
  store.upsertPendingTrace({
    agent_id: 'a', trace_id: 't', context_status: 'unknown',
    first_event_at: '2026-09-14T11:00:00.000Z', last_event_at: '2026-09-14T11:00:00.000Z',
    ingested_watermark: '2026-09-14T11:00:00.000Z', event_count: 1,
    requester_id: null, original_request: null, expected_purpose: null, agent_result: null,
  });
  store.markReviewError({ agentId: 'a', traceId: 't', riskReason: '模型调用失败', maxRetries: 2 });
  const first = store.getTrace('a', 't');
  assert.equal(first.review_retry_count, 1);
  assert.equal(first.risk_reason, '模型调用失败');
  store.markReviewError({ agentId: 'a', traceId: 't', riskReason: '模型调用失败', maxRetries: 2 });
  const second = store.getTrace('a', 't');
  assert.equal(second.review_retry_count, 2);
  assert.match(second.risk_reason, /^审查未完成：/);
  db.close();
});