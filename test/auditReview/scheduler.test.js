import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createReviewStore } from '../../src/auditReview/reviewStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createCandidateDetector } from '../../src/auditReview/candidateDetector.js';
import { createToolSemanticMapper } from '../../src/auditReview/toolSemanticMapper.js';
import { createLlmReviewer } from '../../src/auditReview/llmReviewer.js';
import { createReviewNotifier } from '../../src/auditReview/notification.js';
import { createVisualization } from '../../src/auditReview/visualization.js';
import { createRuntimeAuditLogger } from '../../src/observability/runtimeAudit.js';
import { createAuditReviewScheduler } from '../../src/auditReview/scheduler.js';

const AUDIT_EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  duration_ms INTEGER,
  channel TEXT,
  user_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  llm_intent_json TEXT,
  error_message TEXT,
  tags TEXT,
  raw_json TEXT
);
`;

const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_outbox_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT,
  type TEXT,
  payload_json TEXT,
  delivery_mode TEXT,
  delivery_status TEXT,
  delivery_attempts INTEGER,
  max_attempts INTEGER,
  next_attempt_at TEXT,
  callback_url TEXT,
  last_error TEXT,
  created_at TEXT,
  delivered_at TEXT
);
`;

const RISK_POLICY = {
  version: 'risk-policy-v1',
  repeatWindowMinutes: 10,
  repeatThreshold: 5,
  slowCallDurationMs: 30000,
  highRiskToolPatterns: ['*delete*', '*write*', 'shell.*'],
  agentToolAllowlists: {},
};

const MOJIBAKE_PATTERN = /(?:[涓楂椋闄浣淇鎴鍏椤瀵艰埅鐖璋鐩閾捐矾寤妯鏆棤鍙睍绀鐧诲綍璁块棶浠ょ墝鏇柊堕棿鎬昏澶氶潯佹嵁鏃瑙妫]{2,}|鈥\?|€�)/;

function makeConfig(overrides = {}) {
  return {
    dbPath: ':memory:',
    agents: {
      'mt-agent': { displayName: 'MT 审计 Agent' },
    },
    auditReview: {
      enabled: true,
      intervalMinutes: 30,
      initialDelaySeconds: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: 500,
      notification: {
        mode: 'callback',
        callbackUrl: 'http://127.0.0.1:9999/audit-review-events',
        minSeverity: 'medium',
        sendEmptyReview: false,
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: [],
      },
      riskPolicy: RISK_POLICY,
      llmReview: {
        promptVersion: 'audit-review-prompt-v1',
        reviewerVersion: 'audit-reviewer-v1',
      },
      visualization: {
        enabled: true,
        baseUrl: 'http://127.0.0.1:9320',
        dashboardPath: '/dashboard',
      },
      ...overrides,
    },
  };
}

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  db.exec(OUTBOX_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function insertEvent(db, n, opts = {}) {
  const o = {
    row_hash: `hash-${n}`,
    ts: opts.ts ?? '2026-07-03T10:00:00.000Z',
    agent_id: opts.agent_id ?? 'mt-agent',
    trace_id: opts.trace_id ?? 'trace-1',
    span_id: opts.span_id ?? `span-${n}`,
    parent_span_id: null,
    event: opts.event ?? 'tool.end',
    tool_name: opts.tool_name ?? 'some.tool',
    status: opts.status ?? 'OK',
    result_summary: opts.result_summary ?? null,
    duration_ms: opts.duration_ms ?? 10,
    channel: opts.channel ?? null,
    user_id: null,
    entity_type: opts.entity?.type ?? opts.entity_type ?? null,
    entity_id: opts.entity?.id ?? opts.entity_id ?? null,
    llm_intent_json: opts.llm_intent_json ?? null,
    error_message: opts.error_message ?? null,
    tags: null,
    raw_json: opts.raw_json ?? '{}',
  };
  db.prepare(`INSERT INTO audit_events
    (row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
     result_summary, duration_ms, channel, user_id, entity_type, entity_id, llm_intent_json, error_message, tags, raw_json)
    VALUES (@row_hash, @ts, @agent_id, @trace_id, @span_id, @parent_span_id, @event, @tool_name, @status,
     @result_summary, @duration_ms, @channel, @user_id, @entity_type, @entity_id, @llm_intent_json, @error_message, @tags, @raw_json)`)
    .run(o);
}

// Inline real outbox store to keep tests self-contained.
import { createOutboxStore } from '../../src/agent/outboxStore.js';

function buildRealDeps(db, { llmClient, configOverrides, feishuMode = 'disabled' } = {}) {
  const config = makeConfig(configOverrides);
  const reviewStore = createReviewStore(db);
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const outboxStore = createOutboxStore(db);
  const ingestService = {
    ingestSince() {
      return { inserted: 0, scannedFiles: 0, parseErrors: [], cursorUpdates: 0 };
    },
  };
  const detector = createCandidateDetector({ db, riskPolicy: RISK_POLICY });
  const llmReviewer = createLlmReviewer({
    llmClient: llmClient ?? { async createStructuredResponse({ input }) { const data = JSON.parse(input[1].content); return { risk_level: 'none', risk_reason: '当前链路没有明确的终止事件，也没有工具失败或者异常中断证据，需要确认任务最终执行结果。', evidence_event_ids: [data.events[0].event_id] }; } },
    model: 'test-model',
  });
  const notifier = createReviewNotifier({ db, outboxStore, config, feishuMode });
  const visualization = createVisualization({ reviewStore, config });
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-logger-agent' });
  return { config, reviewStore, lockStore, cursorStore, outboxStore, ingestService, detector, llmReviewer, notifier, visualization, auditLogger };
}

test('scheduler.runAfterIngest runs an immediate review and resets the scheduled timer', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:29:00.000Z',
    tool_name: 'some.query',
    status: 'INTERNAL',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  let timerId = 0;
  const timeoutCalls = [];
  const clearedTimeouts = [];
  const timerApi = {
    setTimeout(callback, delayMs) {
      const handle = { id: ++timerId, callback, delayMs };
      timeoutCalls.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      if (handle) clearedTimeouts.push(handle);
    },
    setInterval() {
      return { id: ++timerId, interval: true };
    },
    clearInterval() {},
  };
  const scheduler = createAuditReviewScheduler({
    db,
    ...deps,
    now: () => new Date('2026-07-03T10:30:00.000Z'),
    timerApi,
  });

  scheduler.start();
  assert.equal(timeoutCalls.length, 1);
  assert.equal(timeoutCalls[0].delayMs, 30_000);

  const result = await scheduler.runAfterIngest();

  assert.equal(result.status, 'completed');
  const runs = deps.reviewStore.listRuns({ limit: 10 });
  assert.equal(runs[0].trigger_type, 'ingest');
  assert.equal(timeoutCalls.length, 2);
  assert.equal(timeoutCalls[1].delayMs, 30 * 60 * 1000);
  assert.equal(clearedTimeouts[0], timeoutCalls[0]);

  scheduler.stop();
  db.close();
});

test('scheduler concurrency: when lock is held, runOnce returns skipped and creates a skipped run', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'INTERNAL',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  // Manually acquire the lock first to simulate a concurrent run.
  const ownerOther = 'owner-other';
  deps.lockStore.acquire({ ownerId: ownerOther, leaseMinutes: 10 });

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  const result = await scheduler.runOnce({ triggerType: 'scheduled' });

  assert.equal(result.status, 'skipped');
  assert.ok(result.reviewId.startsWith('review_'));

  const run = deps.reviewStore.getRun(result.reviewId);
  assert.ok(run, 'skipped run row should be created');
  assert.equal(run.status, 'skipped');

  // The lock should still be held by the original owner.
  const lock = deps.lockStore.getLock('audit_review_scheduler');
  assert.ok(lock, 'lock should still exist');
  assert.equal(lock.owner_id, ownerOther);

  // Should log review.lock.skipped.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent' AND event = 'review.lock.skipped'`).all();
  assert.ok(auditRows.length > 0, 'should log review.lock.skipped');

  // Clean up
  deps.lockStore.release({ ownerId: ownerOther });
  db.close();
});

test('scheduler.recoverStaleRuns: marks stale running run as failed with review_interrupted', () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  const reviewStore = deps.reviewStore;
  const lockStore = deps.lockStore;

  // Insert a "running" run with an old started_at.
  const reviewId = `rev_stale_${crypto.randomUUID()}`;
  reviewStore.createRun({
    reviewId,
    windowFrom: '2026-07-03T09:00:00.000Z',
    windowTo: '2026-07-03T09:30:00.000Z',
    triggerType: 'scheduled',
    intervalMinutes: 30,
    riskPolicyVersion: 'risk-policy-v1',
    reviewerVersion: 'audit-reviewer-v1',
  });
  // Manually set started_at to the past so it's stale.
  db.prepare(`UPDATE audit_review_runs SET started_at = ? WHERE review_id = ?`)
    .run('2026-07-03T09:00:00.000Z', reviewId);

  // Insert an expired lock.
  lockStore.acquire({ ownerId: 'old-owner', leaseMinutes: 0 });
  db.prepare(`
    UPDATE audit_review_locks
    SET lease_expires_at = ?, updated_at = ?
    WHERE lock_name = ?
  `).run('2026-07-03T10:00:00.000Z', '2026-07-03T10:00:00.000Z', 'audit_review_scheduler');

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  scheduler.recoverStaleRuns();

  const recovered = reviewStore.getRun(reviewId);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error_code, 'review_interrupted');

  // Expired lock should be released.
  const lock = lockStore.getLock('audit_review_scheduler');
  assert.equal(lock, null, 'expired lock should be released');

  // Should log review.recovered.
  const auditRows = db.prepare(`SELECT * FROM audit_events WHERE agent_id = 'audit-logger-agent' AND event = 'review.recovered'`).all();
  assert.ok(auditRows.length > 0, 'should log review.recovered');

  db.close();
});

test('scheduler manual trigger 409 path: runOnce returns skipped when lock held', async () => {
  const db = makeDb();
  insertEvent(db, 1, {
    ts: '2026-07-03T10:00:01.000Z',
    tool_name: 'some.query',
    status: 'INTERNAL',
    event: 'tool.end',
  });

  const deps = buildRealDeps(db);
  // Hold the lock.
  deps.lockStore.acquire({ ownerId: 'blocking-owner', leaseMinutes: 10 });

  const scheduler = createAuditReviewScheduler({ db, ...deps, now: () => new Date('2026-07-03T10:30:00.000Z') });
  const result = await scheduler.runOnce({ triggerType: 'manual' });

  // The scheduler returns skipped — the HTTP layer maps this to 409.
  assert.equal(result.status, 'skipped');

  // Verify the skipped run has trigger_type manual.
  const run = deps.reviewStore.getRun(result.reviewId);
  assert.ok(run);
  assert.equal(run.trigger_type, 'manual');
  assert.equal(run.status, 'skipped');

  deps.lockStore.release({ ownerId: 'blocking-owner' });
  db.close();
});

function freshEvent(db, n, options = {}) {
  insertEvent(db, n, options);
  db.prepare('UPDATE audit_events SET ingested_at = ? WHERE row_hash = ?').run(`2026-07-03T10:00:${String(n).padStart(2, '0')}.000Z`, `hash-${n}`);
}
const clock = () => new Date('2026-07-03T12:30:00.000Z');

test('Trace is sole review unit; deterministic successful task never invokes window LLM or Finding alert', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'tool.end', tool_name: 'db.deleteTable' });
  freshEvent(db, 2, { event: 'run.final_result' });
  const deps = buildRealDeps(db, { llmClient: { async createStructuredResponse() { assert.fail('unexpected model call'); } } });
  deps.notifier.enqueueFinding = () => assert.fail('old finding alert');
  deps.notifier.enqueueHighRiskGroups = () => assert.fail('old high-risk alert');
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: clock });
  const result = await scheduler.runOnce();
  assert.equal(result.status, 'completed');
  const trace = db.prepare('SELECT * FROM audit_traces').get();
  assert.equal(trace.risk_level, 'none');
  assert.equal(trace.review_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_llm_usage').get().n, 0);
  db.close();
});

test('scheduler compensates persisted high conclusions and never sends a second outbox alert', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.failed' });
  const deps = buildRealDeps(db, { feishuMode: 'live', configOverrides: { notification: { enabled: true, mode: 'feishu_bot' } } });
  const enqueue = deps.notifier.enqueueTrace;
  let first = true;
  deps.notifier.enqueueTrace = (args) => { if (first) { first = false; throw new Error('temporary outbox error'); } return enqueue(args); };
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: clock });
  await scheduler.runOnce();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_trace_notifications').get().n, 0);
  await scheduler.runOnce();
  await scheduler.runOnce();
  const outbox = db.prepare("SELECT * FROM agent_outbox_events WHERE type = 'audit_trace_high_risk'").all();
  assert.equal(outbox.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_trace_notifications').get().n, 1);
  assert.equal(db.prepare('SELECT review_version FROM audit_traces').get().review_version, 1);
  db.close();
});

test('Trace failures report degraded runs and release scheduler locks', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.start' });
  const deps = buildRealDeps(db, { llmClient: { async createStructuredResponse() { throw new Error('offline'); } } });
  const result = await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.equal(result.status, 'completed_degraded');
  assert.equal(db.prepare('SELECT review_retry_count FROM audit_traces').get().review_retry_count, 1);
  assert.equal(deps.lockStore.getLock('audit_review_scheduler'), null);
  db.close();
});

test('exhausted daily budget defers Trace LLM and leaves retry count unchanged', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.start' });
  const deps = buildRealDeps(db, { llmClient: { async createStructuredResponse() { assert.fail('over-budget call'); } } });
  deps.reviewStore.recordLlmUsage({ day: '2026-07-03', calls: 500, estTokens: 0 });
  const result = await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.equal(result.status, 'completed_degraded');
  assert.equal(db.prepare('SELECT review_retry_count FROM audit_traces').get().review_retry_count, 0);
  db.close();
});

test('coalesced ingest reviews preserve one trailing run; manual run and stop drain the chain', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const traceAggregator = { async run() {
    calls++;
    if (calls === 1) { entered(); await new Promise((resolve) => { release = resolve; }); }
    return { scannedEvents: 0, updatedTraces: 0, reviewedTraces: 0 };
  } };
  const scheduler = createAuditReviewScheduler({ db, ...deps, traceAggregator, now: clock });
  const first = scheduler.runAfterIngest();
  const burst = scheduler.runAfterIngest();
  await ready;
  const trailing = Array.from({ length: 8 }, () => scheduler.runAfterIngest());
  const manual = scheduler.runManual();
  release();
  await Promise.all([first, burst, manual, ...trailing]);
  await scheduler.stop();
  assert.equal(calls, 3);
  assert.equal(deps.reviewStore.listRuns({ limit: 10 }).filter((run) => run.status === 'skipped').length, 0);
  db.close();
});

test('stop waits for in-flight review before caller can close SQLite', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const traceAggregator = { async run() { entered(); await new Promise((resolve) => { release = resolve; }); return {}; } };
  const scheduler = createAuditReviewScheduler({ db, ...deps, traceAggregator, now: clock });
  const run = scheduler.runManual();
  await ready;
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal((await run).status, 'completed');
  db.close();
});

test('trace aggregation failure marks run failed instead of pretending success', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: clock, traceAggregator: { async run() { throw new Error('broken'); } } });
  assert.equal((await scheduler.runOnce()).status, 'failed');
  assert.equal(deps.lockStore.getLock('audit_review_scheduler'), null);
  db.close();
});

test('Finding evidence dual-write preserves raw snapshot and maps new critical to high', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.final_result', raw_json: '{"evidence":"retained"}' });
  const deps = buildRealDeps(db);
  deps.detector = { detect() { return { totalEvents: 1, candidates: [{ event_id: 1, category: 'high_risk_permission', agent_id: 'mt-agent', trace_id: 'trace-1', tool_name: 'shell', min_severity: 'critical', reason: '权限证据' }] }; } };
  const result = await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.equal(result.status, 'completed');
  const finding = db.prepare('SELECT * FROM audit_review_findings').get();
  assert.equal(finding.severity, 'high');
  assert.match(finding.evidence_json, /retained/);
  db.close();
});


test('scheduler retains runtime audit lifecycle events and parse-error evidence', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  deps.ingestService.ingestSince = () => ({ inserted: 0, scannedFiles: 1, cursorUpdates: 0,
    parseErrors: [{ agent_id: 'mt-agent', file: 'audit.jsonl', line: 1, error: '日志格式错误' }] });
  const result = await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.equal(result.status, 'completed');
  const events = new Set(db.prepare("SELECT event FROM audit_events WHERE agent_id = 'audit-logger-agent'").all().map((row) => row.event));
  for (const event of ['review.start', 'review.ingest.completed', 'review.trace_aggregation.completed', 'review.detector.completed', 'review.completed']) assert.ok(events.has(event), event);
  const finding = db.prepare("SELECT * FROM audit_review_findings WHERE category = 'ingest_parse_error'").get();
  assert.match(finding.title, /日志解析失败/);
  assert.match(finding.evidence_json, /audit.jsonl/);
  assert.equal(deps.lockStore.getLock('audit_review_scheduler'), null);
  db.close();
});

test('repeated Finding identities merge with raw evidence snapshots and occurrences retained', async () => {
  const db = makeDb();
  freshEvent(db, 1, { raw_json: '{"id":1}' });
  freshEvent(db, 2, { raw_json: '{"id":2}' });
  const deps = buildRealDeps(db);
  deps.detector = { detect() { return { totalEvents: 2, candidates: [1, 2].map((id) => ({ event_id: id,
    category: 'high_risk_permission', agent_id: 'mt-agent', trace_id: 'trace-1', tool_name: 'shell', min_severity: 'high', reason: '权限证据' })) }; } };
  const scheduler = createAuditReviewScheduler({ db, ...deps, now: clock });
  await scheduler.runOnce();
  await scheduler.runOnce();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_review_findings').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_review_finding_occurrences').get().n, 2);
  const evidence = JSON.parse(db.prepare('SELECT evidence_json FROM audit_review_findings').get().evidence_json);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((row) => JSON.parse(row.raw_json).id).sort(), [1, 2]);
  db.close();
});

test('semantic mapping still precedes Finding detector and failure does not leak lease', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  let mapped = false;
  const toolSemanticMapper = { async mapPendingEvents() { mapped = true; } };
  deps.detector = { detect() { assert.equal(mapped, true); return { totalEvents: 0, candidates: [] }; } };
  const scheduler = createAuditReviewScheduler({ db, ...deps, toolSemanticMapper, now: clock });
  assert.equal((await scheduler.runOnce()).status, 'completed');
  deps.ingestService.ingestSince = () => { throw new Error('ingest failed'); };
  assert.equal((await scheduler.runOnce()).status, 'failed');
  assert.equal(deps.lockStore.getLock('audit_review_scheduler'), null);
  db.close();
});


test('legacy summary callback stays available without individual Finding notifications', async () => {
  const db = makeDb();
  const deps = buildRealDeps(db);
  deps.ingestService.ingestSince = () => ({ inserted: 0, scannedFiles: 1, cursorUpdates: 0,
    parseErrors: [{ agent_id: 'mt-agent', file: 'audit.jsonl', line: 1, error: 'invalid JSON' }] });
  const result = await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.equal(result.status, 'completed');
  const rows = db.prepare('SELECT type, payload_json FROM agent_outbox_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'audit_review_summary');
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.severity_counts.medium, 1);
  assert.equal(payload.severity_counts.critical, 0);
  assert.equal(payload.top_findings.length, 1);
  assert.ok(payload.top_findings[0].finding_id);
  db.close();
});

test('summary callback failure does not prevent high Trace notification', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.failed' });
  const deps = buildRealDeps(db);
  deps.notifier.enqueue = () => { throw new Error('callback unavailable'); };
  let alerted = false;
  deps.notifier.enqueueTrace = ({ trace }) => { alerted = trace.risk_level === 'high'; };
  assert.equal((await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce()).status, 'completed');
  assert.equal(alerted, true);
  assert.equal(deps.lockStore.getLock('audit_review_scheduler'), null);
  db.close();
});


test('one failed Trace enqueue does not block later high Trace alerts', async () => {
  const db = makeDb();
  freshEvent(db, 1, { event: 'run.failed', trace_id: 'first' });
  freshEvent(db, 2, { event: 'run.failed', trace_id: 'second' });
  const deps = buildRealDeps(db);
  const attempted = [];
  deps.notifier.enqueueTrace = ({ trace }) => {
    attempted.push(trace.trace_id);
    if (attempted.length === 1) throw new Error('first enqueue fails');
  };
  await createAuditReviewScheduler({ db, ...deps, now: clock }).runOnce();
  assert.deepEqual(attempted.sort(), ['first', 'second']);
  db.close();
});
