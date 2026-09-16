import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createTraceStore } from '../../src/auditReview/traceStore.js';
import { createTraceAggregator } from '../../src/auditReview/traceAggregator.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';

function setup(reviewTrace) {
  const db = openDb(':memory:');
  ensureReviewSchema(db);
  const store = createTraceStore(db);
  const locks = createLockStore(db);
  const aggregator = createTraceAggregator({ db, config: {}, traceStore: store,
    lockStore: locks, llmReviewer: { reviewTrace }, now: () => new Date('2026-09-16T12:00:00Z') });
  let id = 0;
  function event(name, overrides = {}) {
    id += 1;
    db.prepare(`INSERT INTO audit_events
      (row_hash,agent_id,trace_id,span_id,ts,ingested_at,event,tool_name,status,requester_id,original_request,agent_result)
      VALUES (@hash,'a','t',@span,@ts,@ingested,@event,@tool,@status,'u','request',@result)`)
      .run({ hash: String(id), span: overrides.span ?? String(id),
        ts: `2026-09-16T10:${String(Math.floor(id / 60)).padStart(2,'0')}:${String(id % 60).padStart(2,'0')}.000Z`,
        ingested: `2026-09-16T11:${String(Math.floor(id / 60)).padStart(2,'0')}:${String(id % 60).padStart(2,'0')}.000Z`,
        event: name, tool: overrides.tool ?? 'run', status: overrides.status ?? 'OK',
        result: name === 'run.final_result' ? 'done' : null });
  }
  return { db, store, locks, aggregator, event };
}

test('acceptance: 26 successful distinct tool calls with paired lifecycle logs are not a long loop', async () => {
  const f = setup(() => { throw new Error('LLM not expected'); });
  try {
    f.event('run.start');
    for (let i = 0; i < 26; i += 1) {
      f.event('tool.start', { span: `tool-${i}`, tool: `tool-${i}` });
      f.event('tool.end', { span: `tool-${i}`, tool: `tool-${i}` });
    }
    f.event('run.final_result');
    await f.aggregator.run();
    assert.equal(f.store.getTrace('a','t').risk_level, 'none');
  } finally { f.db.close(); }
});

for (const riskLevel of ['none', 'low', 'medium', 'high']) {
  test(`acceptance: success LLM contract ${riskLevel === 'high' ? 'rejects' : 'accepts'} ${riskLevel}`, async () => {
    const f = setup(async ({ trace }) => ({ ok: true, outcome: {
      risk_level: riskLevel, risk_reason: '模型结合执行证据判断异常程度',
      evidence_event_ids: [trace.events[0].event_id],
    } }));
    try {
      f.event('run.start'); f.event('run.retry'); f.event('run.final_result');
      await f.aggregator.run();
      const result = f.store.getTrace('a', 't');
      // Design 7.2/7.3 allows the model to identify medium-level evidence in
      // the success fallback path; high remains an illegal success outcome.
      if (riskLevel === 'high') {
        assert.equal(result.risk_level, 'unreviewed');
        assert.equal(result.review_version, 0);
        assert.equal(result.review_error, 1);
        assert.equal(result.input_hash, null);
      } else {
        assert.equal(result.trace_status, 'success');
        assert.equal(result.risk_level, riskLevel);
        assert.equal(result.review_version, 1);
        assert.equal(result.review_error, 0);
      }
    } finally { f.db.close(); }
  });
}

test('acceptance: reviewer losing persistent lease cannot publish a conclusion', async () => {
  let resolveReview;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = setup(({ trace }) => new Promise(resolve => {
    resolveReview = () => resolve({ ok: true, outcome: { risk_level: 'none', risk_reason: 'done', evidence_event_ids: [trace.events[0].event_id] } });
    entered();
  }));
  try {
    f.event('run.start');
    const run = f.aggregator.run();
    await started;
    const lockName = 'trace_review:["a","t"]';
    f.db.prepare("UPDATE audit_review_locks SET lease_expires_at='2000-01-01T00:00:00Z' WHERE lock_name=?").run(lockName);
    assert.equal(f.locks.acquire({ lockName, ownerId: 'replacement', leaseMinutes: 5 }).acquired, true);
    resolveReview();
    await run;
    assert.equal(f.store.getTrace('a','t').review_version, 0);
    assert.equal(f.locks.getLock(lockName).owner_id, 'replacement');
  } finally { f.db.close(); }
});

test('acceptance: failed late re-review preserves the published risk explanation and history', async () => {
  let fail = false;
  const f = setup(async ({ trace }) => fail ? { ok: false, error: 'upstream timeout' } : {
    ok: true, outcome: { risk_level: 'low', risk_reason: '用户需确认结果', evidence_event_ids: [trace.events[0].event_id] },
  });
  try {
    f.event('run.start');
    await f.aggregator.run();
    const previous = f.store.getTrace('a','t');
    assert.equal(previous.risk_level, 'low');
    fail = true;
    f.event('run.warn');
    await f.aggregator.run();
    const current = f.store.getTrace('a','t');
    assert.equal(current.review_error, 1);
    assert.equal(current.review_version, previous.review_version);
    assert.equal(current.risk_reason, previous.risk_reason);
  } finally { f.db.close(); }
});

test('acceptance: stale reviewer failure after lease takeover cannot alter retry state', async () => {
  let complete;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = setup(() => new Promise(resolve => {
    complete = () => resolve({ ok: false, error: 'stale request timeout' });
    entered();
  }));
  try {
    f.event('run.start');
    const run = f.aggregator.run();
    await started;
    const lockName = 'trace_review:["a","t"]';
    f.db.prepare("UPDATE audit_review_locks SET lease_expires_at='2000-01-01T00:00:00Z' WHERE lock_name=?").run(lockName);
    f.locks.acquire({ lockName, ownerId: 'replacement', leaseMinutes: 5 });
    complete();
    await run;
    assert.equal(f.store.getTrace('a','t').review_retry_count, 0);
    assert.equal(f.store.getTrace('a','t').review_error, 0);
  } finally { f.db.close(); }
});
