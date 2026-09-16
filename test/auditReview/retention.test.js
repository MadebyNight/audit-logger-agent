import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createRetentionService } from '../../src/auditReview/retention.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

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

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function makeFileDb(rootDir) {
  const dbPath = path.join(rootDir, 'data', 'audit.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = OFF');
  db.exec(AUDIT_EVENTS_SCHEMA);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);
  return db;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'audit-retention-'));
}

function makeConfig(rootDir, overrides = {}) {
  return {
    rootDir,
    dbPath: path.join(rootDir, 'data', 'audit.db'),
    agents: {},
    ingest: {
      spoolDir: 'data/spool/incoming',
    },
    capturesDir: 'data/captures',
    tmpDir: 'data/tmp',
    logDir: 'logs',
    retention: {
      enabled: true,
      runAtHour: 4,
      traceDays: 30,
      highRiskTraceDays: 90,
      maxTracesPerAgent: 2000,
      runtimeRunsDays: 30,
      waitingStatesDays: 30,
      llmUsageDays: 90,
      outboxDays: 14,
      logFilesDays: 14,
      tmpFilesDays: 7,
      captureFilesDays: 30,
      vacuum: 'incremental',
      ...overrides.retention,
    },
    ...overrides,
  };
}

function writeFileWithMtime(filePath, contents, isoTime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  const fileTime = new Date(isoTime);
  fs.utimesSync(filePath, fileTime, fileTime);
}

function insertEvent(db, id, ts, agentId = 'agent') {
  const suffix = `${agentId}-${id}`;
  const result = db.prepare(`
    INSERT INTO audit_events (
      row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event,
      tool_name, status, result_summary, duration_ms, channel, user_id,
      entity_type, entity_id, llm_intent_json, error_message, tags, raw_json
    ) VALUES (
      @row_hash, @ts, @agent_id, 'trace', @span_id, NULL, 'tool.end',
      'tool.name', 'OK', NULL, 1, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, '{}'
    )
  `).run({
    row_hash: agentId === 'agent' ? `hash-${id}` : `hash-${suffix}`,
    ts,
    agent_id: agentId,
    span_id: `span-${suffix}`,
  });
  db.prepare('UPDATE audit_events SET ingested_at = ts WHERE id = ?').run(result.lastInsertRowid);
  db.prepare(`INSERT OR REPLACE INTO audit_trace_scan_cursor VALUES ('trace_aggregation', '2026-07-06T12:00:00.000Z', 99999, '2026-07-06T12:00:00.000Z')`).run();
  return Number(result.lastInsertRowid);
}

function insertReviewRun(db, id, startedAt, { findingCount = 0 } = {}) {
  db.prepare(`
    INSERT INTO audit_review_runs (
      review_id, window_from, window_to, status, trigger_type,
      finding_count, risk_policy_version, reviewer_version, started_at
    ) VALUES (
      @review_id, @started_at, @started_at, 'completed', 'scheduled',
      @finding_count, 'risk-policy-v1', 'reviewer-v1', @started_at
    )
  `).run({ review_id: id, finding_count: findingCount, started_at: startedAt });
}

function insertFinding(db, id, {
  status,
  createdAt,
  lastSeenAt = createdAt,
  resolvedAt = null,
  acknowledgedAt = null,
  reviewId = 'review-1',
  evidenceEventIds = [],
  evidenceJson = null,
}) {
  db.prepare(`
    INSERT INTO audit_review_findings (
      finding_id, review_id, finding_hash, category, severity, title, summary,
      evidence_event_ids_json, evidence_json, status, created_at, last_seen_at, resolved_at,
      acknowledged_at, risk_policy_version, reviewer_version
    ) VALUES (
      @finding_id, @review_id, @finding_hash, 'failed_call', 'medium', 'title', 'summary',
      @evidence_event_ids_json, @evidence_json, @status, @created_at, @last_seen_at, @resolved_at,
      @acknowledged_at, 'risk-policy-v1', 'reviewer-v1'
    )
  `).run({
    finding_id: id,
    review_id: reviewId,
    finding_hash: `hash-${id}`,
    evidence_event_ids_json: JSON.stringify(evidenceEventIds),
    evidence_json: evidenceJson,
    status,
    created_at: createdAt,
    last_seen_at: lastSeenAt,
    resolved_at: resolvedAt,
    acknowledged_at: acknowledgedAt,
  });
}

function insertOccurrence(db, id, {
  findingId,
  reviewId,
  observedAt,
  evidenceEventIds = [],
  evidenceJson = '[]',
  severity = 'medium',
}) {
  db.prepare(`
    INSERT INTO audit_review_finding_occurrences (
      occurrence_id, finding_id, review_id, severity, title, summary,
      recommendation, evidence_event_ids_json, evidence_json, observed_at,
      is_new, severity_escalated, reopened, created_at
    ) VALUES (
      @occurrence_id, @finding_id, @review_id, @severity, 'title', 'summary',
      NULL, @evidence_event_ids_json, @evidence_json, @observed_at,
      1, 0, 0, @observed_at
    )
  `).run({
    occurrence_id: id,
    finding_id: findingId,
    review_id: reviewId,
    severity,
    evidence_event_ids_json: JSON.stringify(evidenceEventIds),
    observed_at: observedAt,
    evidence_json: evidenceJson,
  });
}

function insertFindingAction(db, id, { findingId, createdAt }) {
  db.prepare(`
    INSERT INTO audit_finding_actions (
      action_id, finding_id, action_type, from_status, to_status,
      actor, note, snoozed_until, created_at
    ) VALUES (
      @action_id, @finding_id, 'resolve', 'open', 'resolved',
      'operator', 'fixed', NULL, @created_at
    )
  `).run({ action_id: id, finding_id: findingId, created_at: createdAt });
}

function insertOutbox(db, id, { status, createdAt }) {
  db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode, delivery_status,
      delivery_attempts, max_attempts, created_at
    ) VALUES (
      @event_id, 'run-1', 'run.completed', '{}', 'callback', @delivery_status,
      0, 8, @created_at
    )
  `).run({ event_id: id, delivery_status: status, created_at: createdAt });
}

function insertRun(db, runId, { status, createdAt, updatedAt = createdAt }) {
  db.prepare(`
    INSERT INTO agent_runs (
      run_id, channel, conversation_id, user_open_id, status,
      request_text, delivery_mode, current_step_index, created_at, updated_at
    ) VALUES (
      @run_id, 'test', 'conv-1', 'user-1', @status,
      'request', 'callback', 0, @created_at, @updated_at
    )
  `).run({
    run_id: runId,
    status,
    created_at: createdAt,
    updated_at: updatedAt,
  });
}

function insertRunStep(db, { runId, stepIndex, startedAt, finishedAt = startedAt }) {
  db.prepare(`
    INSERT INTO agent_run_steps (
      run_id, step_index, step_name, status, tool_name,
      input_json, output_json, started_at, finished_at
    ) VALUES (
      @run_id, @step_index, 'step', 'completed', 'tool.name',
      NULL, NULL, @started_at, @finished_at
    )
  `).run({
    run_id: runId,
    step_index: stepIndex,
    started_at: startedAt,
    finished_at: finishedAt,
  });
}

function insertWaitingState(db, decisionId, {
  runId,
  status,
  createdAt,
  resolvedAt = null,
}) {
  db.prepare(`
    INSERT INTO agent_waiting_states (
      decision_id, run_id, schema_json, context_json,
      requested_by_step, status, created_at, resolved_at
    ) VALUES (
      @decision_id, @run_id, '{}', '{}',
      0, @status, @created_at, @resolved_at
    )
  `).run({
    decision_id: decisionId,
    run_id: runId,
    status,
    created_at: createdAt,
    resolved_at: resolvedAt,
  });
}

function insertLlmUsage(db, day, { calls = 1, estTokens = 100, updatedAt = `${day}T12:00:00.000Z` } = {}) {
  db.prepare(`
    INSERT INTO audit_llm_usage (day, calls, est_tokens, updated_at)
    VALUES (@day, @calls, @est_tokens, @updated_at)
  `).run({
    day,
    calls,
    est_tokens: estTokens,
    updated_at: updatedAt,
  });
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

test('retention dry-run reports expired dashboard rows without deleting data', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  const freshEventId = insertEvent(db, 2, '2026-07-05T00:00:00.000Z');
  insertReviewRun(db, 'old-run', '2026-04-01T00:00:00.000Z');
  insertReviewRun(db, 'new-run', '2026-07-05T00:00:00.000Z');
  insertFinding(db, 'resolved-old', {
    status: 'resolved',
    createdAt: '2026-04-01T00:00:00.000Z',
    resolvedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-old', {
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
  });
  insertFinding(db, 'acked-old', {
    status: 'acknowledged',
    createdAt: '2026-04-01T00:00:00.000Z',
    acknowledgedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-fresh', {
    status: 'open',
    createdAt: '2026-07-05T00:00:00.000Z',
    evidenceEventIds: [freshEventId],
  });
  insertOutbox(db, 'delivered-old', { status: 'delivered', createdAt: '2026-06-01T00:00:00.000Z' });
  insertOutbox(db, 'dead-old', { status: 'dead_letter', createdAt: '2026-06-01T00:00:00.000Z' });
  insertOutbox(db, 'pending-old', { status: 'pending', createdAt: '2026-06-01T00:00:00.000Z' });

  const result = service.run({ dryRun: true });

  assert.equal(result.dryRun, true);
  assert.deepEqual(result.deleted, {
    auditEvents: 1,
    auditTraces: 0,
    traceReviews: 0,
    traceNotifications: 0,
    agentRuns: 0,
    agentRunSteps: 0,
    agentWaitingStates: 0,
    reviewRuns: 1,
    findingOccurrences: 0,
    findings: 3,
    auditLlmUsage: 0,
    outboxEvents: 2,
    ingestCursors: 0,
    spoolFiles: 0,
    logFiles: 0,
    tmpFiles: 0,
    captureFiles: 0,
  });
  assert.equal(count(db, 'audit_events'), 2);
  assert.equal(count(db, 'audit_review_runs'), 2);
  assert.equal(count(db, 'audit_review_findings'), 4);
  assert.equal(count(db, 'agent_outbox_events'), 3);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention deletes expired runtime rows and llm usage while keeping active waiting state', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        runtimeRunsDays: 30,
        waitingStatesDays: 30,
        llmUsageDays: 60,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  insertRun(db, 'run-old-completed', {
    status: 'completed',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-old-failed', {
    status: 'failed',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-waiting-user', {
    status: 'waiting_user',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertRun(db, 'run-fresh-completed', {
    status: 'completed',
    createdAt: '2026-07-01T00:00:00.000Z',
  });

  insertRunStep(db, {
    runId: 'run-old-completed',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-old-failed',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-waiting-user',
    stepIndex: 0,
    startedAt: '2026-05-01T00:00:00.000Z',
  });
  insertRunStep(db, {
    runId: 'run-fresh-completed',
    stepIndex: 0,
    startedAt: '2026-07-01T00:00:00.000Z',
  });

  insertWaitingState(db, 'wait-resolved-old', {
    runId: 'run-old-completed',
    status: 'resolved',
    createdAt: '2026-05-01T00:00:00.000Z',
    resolvedAt: '2026-05-02T00:00:00.000Z',
  });
  insertWaitingState(db, 'wait-pending-terminal', {
    runId: 'run-old-failed',
    status: 'pending',
    createdAt: '2026-05-01T00:00:00.000Z',
  });
  insertWaitingState(db, 'wait-pending-active', {
    runId: 'run-waiting-user',
    status: 'pending',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  insertLlmUsage(db, '2026-04-01', { calls: 2, estTokens: 500 });
  insertLlmUsage(db, '2026-06-15', { calls: 1, estTokens: 120 });

  const result = service.run({ batchSize: 1 });

  assert.equal(result.deleted.agentRuns, 2);
  assert.equal(result.deleted.agentRunSteps, 2);
  assert.equal(result.deleted.agentWaitingStates, 2);
  assert.equal(result.deleted.auditLlmUsage, 1);
  assert.ok(result.batches.agentRuns.every((n) => n <= 1), 'agent_runs delete batches should respect batchSize');
  assert.ok(result.batches.agentWaitingStates.every((n) => n <= 1), 'agent_waiting_states delete batches should respect batchSize');
  assert.deepEqual(
    db.prepare(`SELECT run_id FROM agent_runs ORDER BY run_id`).all().map((row) => row.run_id),
    ['run-fresh-completed', 'run-waiting-user'],
  );
  assert.deepEqual(
    db.prepare(`SELECT run_id FROM agent_run_steps ORDER BY run_id`).all().map((row) => row.run_id),
    ['run-fresh-completed', 'run-waiting-user'],
  );
  assert.deepEqual(
    db.prepare(`SELECT decision_id FROM agent_waiting_states ORDER BY decision_id`).all().map((row) => row.decision_id),
    ['wait-pending-active'],
  );
  assert.deepEqual(
    db.prepare(`SELECT day FROM audit_llm_usage ORDER BY day`).all().map((row) => row.day),
    ['2026-06-15'],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention deletes expired findings regardless of workflow status in batches', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  for (let i = 1; i <= 5; i++) {
    insertEvent(db, i, `2026-03-0${i}T00:00:00.000Z`);
  }
  const freshEventId = insertEvent(db, 99, '2026-07-05T00:00:00.000Z');
  insertFinding(db, 'resolved-old', {
    status: 'resolved',
    createdAt: '2026-04-01T00:00:00.000Z',
    resolvedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-old', {
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
  });
  insertFinding(db, 'acked-old', {
    status: 'acknowledged',
    createdAt: '2026-04-01T00:00:00.000Z',
    acknowledgedAt: '2026-05-01T00:00:00.000Z',
  });
  insertFinding(db, 'open-fresh', {
    status: 'open',
    createdAt: '2026-07-05T00:00:00.000Z',
    evidenceEventIds: [freshEventId],
  });

  const result = service.run({ batchSize: 2 });

  assert.equal(result.deleted.auditEvents, 5);
  assert.equal(result.deleted.findings, 3);
  assert.ok(result.batches.auditEvents.every((n) => n <= 2), 'each audit_events delete batch should respect batchSize');
  assert.ok(result.batches.findings.every((n) => n <= 2), 'each finding delete batch should respect batchSize');
  assert.deepEqual(
    db.prepare(`SELECT row_hash FROM audit_events ORDER BY row_hash`).all().map((row) => row.row_hash),
    ['hash-99'],
  );
  assert.deepEqual(
    db.prepare(`SELECT finding_id FROM audit_review_findings ORDER BY finding_id`).all().map((row) => row.finding_id),
    ['open-fresh'],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes expired findings, evidence snapshots, actions, and review runs together', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  insertReviewRun(db, 'active-old-review', '2026-04-01T00:00:00.000Z', { findingCount: 1 });
  insertReviewRun(db, 'resolved-old-review', '2026-04-02T00:00:00.000Z', { findingCount: 1 });
  const sourceEventId = insertEvent(db, 'snapshot-source', '2026-04-01T00:00:00.000Z');
  insertFinding(db, 'active-finding', {
    status: 'open',
    createdAt: '2026-04-01T00:00:00.000Z',
    reviewId: 'active-old-review',
    evidenceEventIds: [sourceEventId],
  });
  insertFinding(db, 'expired-resolved-finding', {
    status: 'resolved',
    createdAt: '2026-04-02T00:00:00.000Z',
    resolvedAt: '2026-05-01T00:00:00.000Z',
    reviewId: 'resolved-old-review',
  });
  insertOccurrence(db, 'occ-active', {
    findingId: 'active-finding',
    reviewId: 'active-old-review',
    observedAt: '2026-04-01T00:00:00.000Z',
    evidenceEventIds: [sourceEventId],
    evidenceJson: '[{"event_id":1,"raw_json":"{\\"source\\":\\"retained-snapshot\\"}"}]',
  });
  insertOccurrence(db, 'occ-resolved', {
    findingId: 'expired-resolved-finding',
    reviewId: 'resolved-old-review',
    observedAt: '2026-04-02T00:00:00.000Z',
  });
  insertFindingAction(db, 'act-resolved', {
    findingId: 'expired-resolved-finding',
    createdAt: '2026-05-01T00:00:00.000Z',
  });

  const result = service.run({ batchSize: 1 });

  assert.equal(result.deleted.auditEvents, 1);
  assert.equal(result.deleted.findingOccurrences, 2);
  assert.equal(result.deleted.findings, 2);
  assert.equal(result.deleted.reviewRuns, 2);
  assert.equal(count(db, 'audit_events'), 0);
  assert.equal(count(db, 'audit_review_runs'), 0);
  assert.equal(count(db, 'audit_review_findings'), 0);
  assert.equal(count(db, 'audit_review_finding_occurrences'), 0);
  assert.equal(count(db, 'audit_finding_actions'), 0);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes old occurrences while rebasing a finding onto retained evidence', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const oldEventId = insertEvent(db, 'old-source', '2026-05-03T00:00:00.000Z');
  const freshEventId = insertEvent(db, 'fresh-source', '2026-07-05T00:00:00.000Z');
  insertReviewRun(db, 'old-review', '2026-05-03T00:00:00.000Z', { findingCount: 1 });
  insertReviewRun(db, 'fresh-review', '2026-07-05T00:00:00.000Z', { findingCount: 1 });
  insertFinding(db, 'recurring-finding', {
    status: 'open',
    createdAt: '2026-05-03T00:00:00.000Z',
    lastSeenAt: '2026-07-05T00:00:00.000Z',
    reviewId: 'old-review',
    evidenceEventIds: [freshEventId],
    evidenceJson: JSON.stringify([{ event_id: freshEventId, raw_json: '{"source":"fresh"}' }]),
  });
  insertOccurrence(db, 'old-occurrence', {
    findingId: 'recurring-finding',
    reviewId: 'old-review',
    observedAt: '2026-05-03T00:00:00.000Z',
    evidenceEventIds: [oldEventId],
    evidenceJson: JSON.stringify([{ event_id: oldEventId, raw_json: '{"source":"old"}' }]),
    severity: 'medium',
  });
  insertOccurrence(db, 'fresh-occurrence', {
    findingId: 'recurring-finding',
    reviewId: 'fresh-review',
    observedAt: '2026-07-05T00:00:00.000Z',
    evidenceEventIds: [freshEventId],
    evidenceJson: JSON.stringify([{ event_id: freshEventId, raw_json: '{"source":"fresh"}' }]),
    severity: 'high',
  });

  const result = service.run({ batchSize: 1 });

  assert.equal(result.deleted.auditEvents, 1);
  assert.equal(result.deleted.findingOccurrences, 1);
  assert.equal(result.deleted.findings, 0);
  assert.equal(result.deleted.reviewRuns, 1);
  assert.deepEqual(
    db.prepare(`SELECT occurrence_id FROM audit_review_finding_occurrences`).all().map((row) => row.occurrence_id),
    ['fresh-occurrence'],
  );
  assert.deepEqual(
    db.prepare(`SELECT review_id FROM audit_review_runs`).all().map((row) => row.review_id),
    ['fresh-review'],
  );
  const finding = db.prepare(`
    SELECT review_id, first_review_id, last_review_id, severity, max_severity,
           occurrence_count, created_at, last_seen_at, evidence_json
    FROM audit_review_findings
    WHERE finding_id = 'recurring-finding'
  `).get();
  assert.deepEqual({
    review_id: finding.review_id,
    first_review_id: finding.first_review_id,
    last_review_id: finding.last_review_id,
    severity: finding.severity,
    max_severity: finding.max_severity,
    occurrence_count: finding.occurrence_count,
    created_at: finding.created_at,
    last_seen_at: finding.last_seen_at,
  }, {
    review_id: 'fresh-review',
    first_review_id: 'fresh-review',
    last_review_id: 'fresh-review',
    severity: 'high',
    max_severity: 'high',
    occurrence_count: 1,
    created_at: '2026-07-05T00:00:00.000Z',
    last_seen_at: '2026-07-05T00:00:00.000Z',
  });
  assert.equal(JSON.parse(finding.evidence_json)[0].raw_json, '{"source":"fresh"}');

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention preserves all events from the current Beijing report day before the 10:00/17:00 digests', () => {
  const rootDir = tmpDir();
  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, { report: { timezoneOffsetMinutes: 480 } }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T08:00:00.000Z'),
  });

  const currentDayStart = Date.parse('2026-07-05T16:00:00.000Z');
  for (let i = 1; i <= 205; i++) {
    insertEvent(db, i, new Date(currentDayStart + i * 60 * 1000).toISOString(), 'agent-current');
  }

  const result = service.run({ batchSize: 10 });

  assert.equal(result.deleted.auditEvents, 0);
  assert.equal(
    db.prepare(`SELECT COUNT(*) AS count FROM audit_events WHERE agent_id = 'agent-current'`).get().count,
    205,
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes safe expired spool files and orphan cursors', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldComplete = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  const oldPartial = path.join(spoolAgentDir, 'audit-2026-03-02.jsonl');
  const fresh = path.join(spoolAgentDir, 'audit-2026-07-01.jsonl');
  fs.writeFileSync(oldComplete, '{"ok":true}\n');
  fs.writeFileSync(oldPartial, '{"partial":');
  fs.writeFileSync(fresh, '{"ok":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  const freshTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(oldComplete, oldTime, oldTime);
  fs.utimesSync(oldPartial, oldTime, oldTime);
  fs.utimesSync(fresh, freshTime, freshTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldComplete,
    fileMtimeMs: fs.statSync(oldComplete).mtimeMs,
    fileSizeBytes: fs.statSync(oldComplete).size,
    offsetBytes: fs.statSync(oldComplete).size,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldPartial,
    fileMtimeMs: fs.statSync(oldPartial).mtimeMs,
    fileSizeBytes: fs.statSync(oldPartial).size,
    offsetBytes: 0,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: path.join(spoolAgentDir, 'missing.jsonl'),
    fileMtimeMs: 1,
    fileSizeBytes: 1,
    offsetBytes: 1,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.spoolFiles, 1);
  assert.equal(result.deleted.ingestCursors, 2);
  assert.equal(fs.existsSync(oldComplete), false);
  assert.equal(fs.existsSync(oldPartial), true);
  assert.equal(fs.existsSync(fresh), true);
  assert.deepEqual(
    db.prepare(`SELECT file_path FROM audit_ingest_cursors ORDER BY file_path`).all().map((row) => row.file_path),
    [oldPartial],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention dry-run counts expired app-owned files without deleting them', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';

  const oldLog = path.join(rootDir, 'logs', 'server', 'old.log');
  const oldTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'old.tmp');
  const oldCapture = path.join(rootDir, 'data', 'captures', 'screens', 'old.png');
  writeFileWithMtime(oldLog, 'old log', oldTime);
  writeFileWithMtime(oldTmp, 'old tmp', oldTime);
  writeFileWithMtime(oldCapture, 'old capture', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run({ dryRun: true });

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(oldLog), true);
  assert.equal(fs.existsSync(oldTmp), true);
  assert.equal(fs.existsSync(oldCapture), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes expired app-owned files and ignores non-app workspace directories', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';
  const freshTime = '2026-07-05T00:00:00.000Z';

  const oldLog = path.join(rootDir, 'logs', 'server', 'old.log');
  const freshLog = path.join(rootDir, 'logs', 'server', 'fresh.log');
  const oldTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'old.tmp');
  const freshTmp = path.join(rootDir, 'data', 'tmp', 'jobs', 'fresh.tmp');
  const oldCapture = path.join(rootDir, 'data', 'captures', 'screens', 'old.png');
  const freshCapture = path.join(rootDir, 'data', 'captures', 'screens', 'fresh.png');
  const oldAgentsLog = path.join(rootDir, '.agents', 'old.log');
  const oldClaudeLog = path.join(rootDir, '.claude', 'old.log');
  const oldSuperpowersLog = path.join(rootDir, '.superpowers', 'old.log');
  const recordFile = path.join(rootDir, 'record.json');
  const typoraLog = path.join(rootDir, 'Typora_Hook_Log.txt');

  writeFileWithMtime(oldLog, 'old log', oldTime);
  writeFileWithMtime(freshLog, 'fresh log', freshTime);
  writeFileWithMtime(oldTmp, 'old tmp', oldTime);
  writeFileWithMtime(freshTmp, 'fresh tmp', freshTime);
  writeFileWithMtime(oldCapture, 'old capture', oldTime);
  writeFileWithMtime(freshCapture, 'fresh capture', freshTime);
  writeFileWithMtime(oldAgentsLog, 'keep agents', oldTime);
  writeFileWithMtime(oldClaudeLog, 'keep claude', oldTime);
  writeFileWithMtime(oldSuperpowersLog, 'keep superpowers', oldTime);
  writeFileWithMtime(recordFile, '{"keep":true}', oldTime);
  writeFileWithMtime(typoraLog, 'keep typora', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(oldLog), false);
  assert.equal(fs.existsSync(freshLog), true);
  assert.equal(fs.existsSync(oldTmp), false);
  assert.equal(fs.existsSync(freshTmp), true);
  assert.equal(fs.existsSync(oldCapture), false);
  assert.equal(fs.existsSync(freshCapture), true);
  assert.equal(fs.existsSync(oldAgentsLog), true);
  assert.equal(fs.existsSync(oldClaudeLog), true);
  assert.equal(fs.existsSync(oldSuperpowersLog), true);
  assert.equal(fs.existsSync(recordFile), true);
  assert.equal(fs.existsSync(typoraLog), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention uses configured app-owned directories instead of hard-coded defaults', () => {
  const rootDir = tmpDir();
  const oldTime = '2026-06-01T00:00:00.000Z';

  const configuredLog = path.join(rootDir, 'runtime', 'logs', 'old.log');
  const configuredTmp = path.join(rootDir, 'runtime', 'tmp', 'old.tmp');
  const configuredCapture = path.join(rootDir, 'runtime', 'captures', 'old.png');
  const defaultLog = path.join(rootDir, 'logs', 'keep.log');
  const defaultTmp = path.join(rootDir, 'data', 'tmp', 'keep.tmp');
  const defaultCapture = path.join(rootDir, 'data', 'captures', 'keep.png');

  writeFileWithMtime(configuredLog, 'configured log', oldTime);
  writeFileWithMtime(configuredTmp, 'configured tmp', oldTime);
  writeFileWithMtime(configuredCapture, 'configured capture', oldTime);
  writeFileWithMtime(defaultLog, 'default log', oldTime);
  writeFileWithMtime(defaultTmp, 'default tmp', oldTime);
  writeFileWithMtime(defaultCapture, 'default capture', oldTime);

  const db = makeDb();
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir, {
      logDir: 'runtime/logs',
      tmpDir: 'runtime/tmp',
      capturesDir: 'runtime/captures',
      retention: {
        logFilesDays: 14,
        tmpFilesDays: 7,
        captureFilesDays: 30,
      },
    }),
    cursorStore: createIngestCursorStore(db),
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.logFiles, 1);
  assert.equal(result.deleted.tmpFiles, 1);
  assert.equal(result.deleted.captureFiles, 1);
  assert.equal(fs.existsSync(configuredLog), false);
  assert.equal(fs.existsSync(configuredTmp), false);
  assert.equal(fs.existsSync(configuredCapture), false);
  assert.equal(fs.existsSync(defaultLog), true);
  assert.equal(fs.existsSync(defaultTmp), true);
  assert.equal(fs.existsSync(defaultCapture), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention keeps expired newline-complete spool files without completed cursor proof', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldCompleteWithoutCursor = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  fs.writeFileSync(oldCompleteWithoutCursor, '{"accepted":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  fs.utimesSync(oldCompleteWithoutCursor, oldTime, oldTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.spoolFiles, 0);
  assert.equal(fs.existsSync(oldCompleteWithoutCursor), true);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention dry-run counts cursors that would become orphaned by spool cleanup', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  const oldComplete = path.join(spoolAgentDir, 'audit-2026-03-01.jsonl');
  fs.writeFileSync(oldComplete, '{"ok":true}\n');
  const oldTime = new Date('2026-03-01T00:00:00.000Z');
  fs.utimesSync(oldComplete, oldTime, oldTime);

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: oldComplete,
    fileMtimeMs: fs.statSync(oldComplete).mtimeMs,
    fileSizeBytes: fs.statSync(oldComplete).size,
    offsetBytes: fs.statSync(oldComplete).size,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run({ dryRun: true });

  assert.equal(result.deleted.spoolFiles, 1);
  assert.equal(result.deleted.ingestCursors, 1);
  assert.equal(fs.existsSync(oldComplete), true);
  assert.equal(count(db, 'audit_ingest_cursors'), 1);

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('retention removes cursors for external log files not present in spool', () => {
  const rootDir = tmpDir();
  const spoolAgentDir = path.join(rootDir, 'data', 'spool', 'incoming', 'agent-a');
  const externalDir = path.join(rootDir, 'external-logs');
  fs.mkdirSync(spoolAgentDir, { recursive: true });
  fs.mkdirSync(externalDir, { recursive: true });

  const spoolFile = path.join(spoolAgentDir, 'audit-2026-07-01.jsonl');
  const externalFile = path.join(externalDir, 'audit-2026-07-01.jsonl');
  fs.writeFileSync(spoolFile, '{"ok":true}\n');
  fs.writeFileSync(externalFile, '{"external":true}\n');

  const db = makeDb();
  const cursorStore = createIngestCursorStore(db);
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: spoolFile,
    fileMtimeMs: fs.statSync(spoolFile).mtimeMs,
    fileSizeBytes: fs.statSync(spoolFile).size,
    offsetBytes: fs.statSync(spoolFile).size,
  });
  cursorStore.upsert({
    agentId: 'agent-a',
    filePath: externalFile,
    fileMtimeMs: fs.statSync(externalFile).mtimeMs,
    fileSizeBytes: fs.statSync(externalFile).size,
    offsetBytes: fs.statSync(externalFile).size,
  });

  const service = createRetentionService({
    db,
    config: makeConfig(rootDir),
    cursorStore,
    now: () => new Date('2026-07-06T12:00:00.000Z'),
  });

  const result = service.run();

  assert.equal(result.deleted.ingestCursors, 1);
  assert.deepEqual(
    db.prepare(`SELECT file_path FROM audit_ingest_cursors ORDER BY file_path`).all().map((row) => row.file_path),
    [spoolFile],
  );

  db.close();
  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI supports dry-run', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"dryRun": true/);
  assert.match(result.stdout, /"auditEvents": 0/);
  assert.match(result.stdout, /"agentRuns": 0/);
  assert.match(result.stdout, /"agentRunSteps": 0/);
  assert.match(result.stdout, /"agentWaitingStates": 0/);
  assert.match(result.stdout, /"auditLlmUsage": 0/);
  assert.match(result.stdout, /"logFiles": 0/);
  assert.match(result.stdout, /"tmpFiles": 0/);
  assert.match(result.stdout, /"captureFiles": 0/);

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI rejects missing batch size before cleanup', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const db = makeFileDb(rootDir);
  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--batch-size', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--batch-size requires a positive integer/i);

  const verifyDb = new Database(path.join(rootDir, 'data', 'audit.db'));
  assert.equal(count(verifyDb, 'audit_events'), 1);
  verifyDb.close();

  fs.rmSync(rootDir, { recursive: true, force: true });
});

test('prune CLI rejects invalid batch size before cleanup', () => {
  const rootDir = tmpDir();
  fs.writeFileSync(path.join(rootDir, 'config.json'), JSON.stringify(makeConfig(rootDir), null, 2));

  const db = makeFileDb(rootDir);
  insertEvent(db, 1, '2026-03-01T00:00:00.000Z');
  db.close();

  const result = spawnSync(process.execPath, ['scripts/prune.js', '--batch-size', 'nope', '--dry-run'], {
    cwd: repoRoot,
    env: { ...process.env, AUDIT_LOGGER_ROOT: rootDir },
    encoding: 'utf-8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--batch-size requires a positive integer/i);

  const verifyDb = new Database(path.join(rootDir, 'data', 'audit.db'));
  assert.equal(count(verifyDb, 'audit_events'), 1);
  verifyDb.close();

  fs.rmSync(rootDir, { recursive: true, force: true });
});
function insertTrace(db, traceId, lastEventAt, overrides = {}) {
  const row = {
    agent_id: 'agent', trace_id: traceId, last_event_at: lastEventAt,
    updated_at: lastEventAt, ingested_watermark: lastEventAt,
    sealed_at: lastEventAt, sealed_reason: 'terminal_event', review_version: 1,
    risk_level: 'none', review_error: 0, review_retry_count: 0, event_count: 1, ...overrides,
  };
  const keys = Object.keys(row);
  db.prepare(`INSERT INTO audit_traces (${keys.join(',')}) VALUES (${keys.map(k => `@${k}`).join(',')})`).run(row);
  const id = insertEvent(db, traceId, lastEventAt, row.agent_id);
  db.prepare('UPDATE audit_events SET trace_id = ? WHERE id = ?').run(traceId, id);
  return id;
}

function traceService(db, retention = {}, traceReview = {}) {
  return createRetentionService({ db, config: { retention, auditReview: { traceReview } }, now: () => new Date('2026-07-06T12:00:00.000Z') });
}

test('Trace retention preserves complete recent and high-risk evidence and removes whole expired traces', t => {
  const db = makeDb(); t.after(() => db.close());
  insertTrace(db, 'expired', '2026-06-01T00:00:00.000Z');
  const retained = insertTrace(db, 'recent', '2026-07-05T00:00:00.000Z');
  const oldEvidence = insertEvent(db, 'old-evidence', '2026-01-01T00:00:00.000Z');
  db.prepare("UPDATE audit_events SET trace_id = 'recent' WHERE id = ?").run(oldEvidence);
  db.prepare("UPDATE audit_traces SET event_count = 2 WHERE trace_id = 'recent'").run();
  insertTrace(db, 'high', '2026-05-01T00:00:00.000Z', { risk_level: 'high' });
  insertTrace(db, 'expired-high', '2026-03-01T00:00:00.000Z', { risk_level: 'high' });
  insertTrace(db, 'boundary', '2026-06-06T12:00:00.000Z');
  insertFinding(db, 'high-evidence', { status: 'open', createdAt: '2026-05-01T00:00:00.000Z', evidenceEventIds: [retained, oldEvidence] });
  const svc = traceService(db);
  const preview = svc.pruneAuditEvents({ dryRun: true, batchSize: 1 });
  assert.equal(count(db, 'audit_traces'), 5);
  const actual = svc.pruneAuditEvents({ batchSize: 1 });
  assert.deepEqual(actual.deleted, preview.deleted);
  assert.equal(actual.deleted.auditTraces, 2);
  assert.equal(actual.deleted.auditEvents, 2);
  assert.equal(count(db, 'audit_events'), 4);
  assert.equal(count(db, 'audit_review_findings'), 1);
});

test('unsealed, unreviewed and retrying traces are protected; backfill and exhausted failures expire', t => {
  const db = makeDb(); t.after(() => db.close());
  const old = '2026-01-01T00:00:00.000Z';
  insertTrace(db, 'active', old, { sealed_at: null });
  insertTrace(db, 'queued', old, { review_version: 0 });
  insertTrace(db, 'retrying', old, { review_version: 0, review_error: 1, review_retry_count: 1 });
  insertTrace(db, 'exhausted', old, { review_version: 0, review_error: 1, review_retry_count: 2 });
  insertTrace(db, 'history', old, { review_version: 0, sealed_reason: 'backfill', risk_level: 'unreviewed' });
  let svc = traceService(db);
  assert.equal(svc.countFailedTracesPendingCleanup(), 1);
  svc = traceService(db); // A new service must use persisted retries, not memory.
  const result = svc.pruneAuditEvents();
  assert.equal(result.deleted.auditTraces, 2);
  assert.equal(count(db, 'audit_events'), 3);
  assert.equal(svc.countFailedTracesPendingCleanup(), 0);
});

test('orphan sweep requires a cursor and strictly earlier ingest time; NULL and unscanned events survive', t => {
  const db = makeDb(); t.after(() => db.close());
  const ids = ['before', 'equal', 'after', 'null'].map(id => insertEvent(db, id, '2026-01-01T00:00:00.000Z'));
  const ingest = ['2026-06-01T00:00:00.000Z', '2026-06-02T00:00:00.000Z', '2026-06-03T00:00:00.000Z', null];
  ids.forEach((id, i) => db.prepare('UPDATE audit_events SET ingested_at = ? WHERE id = ?').run(ingest[i], id));
  db.prepare('DELETE FROM audit_trace_scan_cursor').run();
  const svc = traceService(db);
  assert.equal(svc.pruneAuditEvents().deleted.auditEvents, 0);
  db.prepare("INSERT INTO audit_trace_scan_cursor VALUES ('trace_aggregation', ?, 999, ?)").run(ingest[1], ingest[1]);
  assert.equal(svc.pruneAuditEvents().deleted.auditEvents, 1);
  assert.equal(count(db, 'audit_events'), 3);
});

test('capacity prunes whole oldest eligible traces per agent, never slices a large trace', t => {
  const db = makeDb(); t.after(() => db.close());
  for (const agent of ['a', 'b']) {
    for (let i = 1; i <= 3; i++) insertTrace(db, `task${i}`, `2026-07-0${i}T00:00:00.000Z`, { agent_id: agent });
  }
  for (let i = 0; i < 210; i++) {
    const id = insertEvent(db, `large${i}`, '2026-07-03T00:00:00.000Z', 'a');
    db.prepare("UPDATE audit_events SET trace_id = 'task3' WHERE id = ?").run(id);
  }
  const svc = traceService(db, { maxTracesPerAgent: 2 });
  db.prepare("UPDATE audit_traces SET event_count = 211 WHERE agent_id = 'a' AND trace_id = 'task3'").run();
  assert.equal(svc.pruneAuditEvents({ batchSize: 1 }).deleted.auditTraces, 2);
  assert.equal(count(db, 'audit_events'), 214);
});

test('late unaggregated evidence protects an otherwise expired trace', t => {
  const db = makeDb(); t.after(() => db.close());
  const id = insertTrace(db, 'late', '2026-01-01T00:00:00.000Z');
  db.prepare("UPDATE audit_events SET ingested_at = '2026-07-06T00:00:00.000Z' WHERE id = ?").run(id);
  assert.equal(traceService(db).pruneAuditEvents().deleted.auditTraces, 0);
});

test('partial legacy evidence is pruned without losing surviving snapshots', t => {
  const db = makeDb(); t.after(() => db.close());
  const expired = insertTrace(db, 'expired', '2026-01-01T00:00:00.000Z');
  const recent = insertTrace(db, 'recent', '2026-07-05T00:00:00.000Z');
  insertFinding(db, 'mixed', { status: 'open', createdAt: '2026-07-05T00:00:00.000Z', evidenceEventIds: [expired, recent], evidenceJson: JSON.stringify([{ event_id: expired }, { event_id: recent }]) });
  traceService(db).pruneAuditEvents();
  const row = db.prepare("SELECT * FROM audit_review_findings WHERE finding_id = 'mixed'").get();
  assert.deepEqual(JSON.parse(row.evidence_event_ids_json), [recent]);
  assert.deepEqual(JSON.parse(row.evidence_json), [{ event_id: recent }]);
});
test('Trace cleanup removes review history and notification receipts but preserves stored digest slots', t => {
  const db = makeDb(); t.after(() => db.close());
  insertTrace(db, 'expired', '2026-01-01T00:00:00.000Z');
  insertTrace(db, 'retained', '2026-07-05T00:00:00.000Z');
  for (const trace of ['expired', 'retained']) {
    db.prepare(`INSERT INTO audit_trace_reviews (agent_id, trace_id, review_version, trace_status, risk_level, reviewed_at) VALUES ('agent', ?, 1, 'success', 'none', '2026-01-01')`).run(trace);
    db.prepare(`INSERT INTO audit_trace_notifications VALUES ('agent', ?, '2026-01-01')`).run(trace);
  }
  db.prepare(`INSERT INTO audit_notification_digest_slots (slot_key, report_date, slot_hour, scheduled_for, trigger_type, status) VALUES ('old-digest', '2026-01-01', 10, '2026-01-01T02:00:00Z', 'scheduled', 'completed')`).run();
  const digest = db.prepare('SELECT * FROM audit_notification_digest_slots').all();
  const service = traceService(db);
  const preview = service.pruneAuditEvents({ dryRun: true });
  const actual = service.pruneAuditEvents();
  assert.deepEqual(actual.deleted, preview.deleted);
  assert.equal(actual.deleted.traceReviews, 1);
  assert.equal(actual.deleted.traceNotifications, 1);
  assert.equal(count(db, 'audit_trace_notifications'), 1);
  assert.deepEqual(db.prepare('SELECT * FROM audit_notification_digest_slots').all(), digest);
});

test('failed Trace deletion rolls back evidence, review history and notification receipts', t => {
  const db = makeDb(); t.after(() => db.close());
  insertTrace(db, 'expired', '2026-01-01T00:00:00.000Z');
  db.prepare(`INSERT INTO audit_trace_notifications VALUES ('agent', 'expired', '2026-01-01')`).run();
  db.exec(`CREATE TRIGGER block_trace_delete BEFORE DELETE ON audit_traces BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
  assert.throws(() => traceService(db).pruneAuditEvents(), /test rollback/);
  assert.equal(count(db, 'audit_events'), 1);
  assert.equal(count(db, 'audit_traces'), 1);
  assert.equal(count(db, 'audit_trace_notifications'), 1);
});

test('same-millisecond unaggregated event survives age and capacity cleanup until event count catches up', t => {
  const db = makeDb(); t.after(() => db.close());
  const old = '2026-01-01T00:00:00.000Z';
  const first = insertTrace(db, 'same-ms', old);
  const late = insertEvent(db, 'late-same-ms', old);
  assert.ok(late > first);
  db.prepare("UPDATE audit_events SET trace_id = 'same-ms' WHERE id = ?").run(late);
  insertTrace(db, 'newer', '2026-07-05T00:00:00.000Z');
  const svc = traceService(db, { maxTracesPerAgent: 1 });
  assert.equal(svc.pruneAuditEvents({ dryRun: true, batchSize: 1 }).deleted.auditTraces, 0);
  assert.equal(svc.pruneAuditEvents({ batchSize: 1 }).deleted.auditEvents, 0);
  assert.equal(count(db, 'audit_events'), 3);
  db.prepare("UPDATE audit_traces SET event_count = 2 WHERE trace_id = 'same-ms'").run();
  const preview = svc.pruneAuditEvents({ dryRun: true, batchSize: 1 });
  const actual = svc.pruneAuditEvents({ batchSize: 1 });
  assert.deepEqual(actual.deleted, preview.deleted);
  assert.equal(actual.deleted.auditTraces, 1);
  assert.equal(actual.deleted.auditEvents, 2);
  assert.deepEqual(actual.batches.auditEvents, [1, 1]);
});

test('pending cleanup health includes exhausted re-reviews with existing conclusions and respects guards', t => {
  const db = makeDb(); t.after(() => db.close());
  const old = '2026-01-01T00:00:00.000Z';
  insertTrace(db, 'reviewed-failed', old, { review_version: 3, review_error: 1, review_retry_count: 2 });
  insertTrace(db, 'reviewed-retrying', old, { review_version: 2, review_error: 1, review_retry_count: 1 });
  insertTrace(db, 'recent-failed', '2026-07-05T00:00:00.000Z', { review_version: 1, review_error: 1, review_retry_count: 2 });
  insertTrace(db, 'unsealed-failed', old, { sealed_at: null, review_version: 1, review_error: 1, review_retry_count: 2 });
  const svc = traceService(db);
  assert.equal(svc.countFailedTracesPendingCleanup(), 1);
  assert.equal(traceService(db).countFailedTracesPendingCleanup(), 1);
  svc.pruneAuditEvents({ batchSize: 1 });
  assert.equal(svc.countFailedTracesPendingCleanup(), 0);
});
