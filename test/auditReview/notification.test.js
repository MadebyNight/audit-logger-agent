import test from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import assert from 'node:assert/strict';
import { createReviewNotifier, meetsMinSeverity } from '../../src/auditReview/notification.js';

function makeFakeOutboxStore() {
  const calls = [];
  return {
    calls,
    enqueue(event) {
      calls.push(event);
    },
  };
}

function makeRun() {
  return {
    review_id: 'review_test_1',
    window_from: '2026-07-03T10:00:00.000Z',
    window_to: '2026-07-03T10:30:00.000Z',
    status: 'completed',
    candidate_event_count: 128,
    finding_count: 2,
  };
}

function makeReview() {
  return {
    review_id: 'review_test_1',
    window: { from: '2026-07-03T10:00:00.000Z', to: '2026-07-03T10:30:00.000Z' },
    summary: {
      title: 'Audit review found 2 high risk findings',
      overview: 'Reviewed 128 events and found 2 high risk findings.',
      severity_counts: { critical: 0, high: 2, medium: 0, low: 0 },
    },
    findings: [
      {
        finding_id: 'f1',
        category: 'failed_call',
        severity: 'high',
        agent_id: 'mt-agent',
        tool_name: 'publicTraffic.runReport',
        trace_id: 'trace_1',
        title: 'publicTraffic.runReport failed repeatedly',
        summary: 'Failed 5 times in 10 minutes.',
        recommendation: 'Check upstream availability.',
        requires_action: true,
        evidence: [
          {
            event_id: 1,
            agent_id: 'mt-agent',
            agent_name: 'MT Audit Agent',
            tool_name: 'publicTraffic.runReport',
            trace_id: 'trace_1',
            span_id: 'span-1',
            log_detail: {
              ts: '2026-07-03T10:00:00.000Z',
              event: 'tool.end',
              status: 'INTERNAL',
              duration_ms: 120,
              entity: { type: 'product', id: 'product-1' },
              result_summary: 'failed',
              error_message: 'down',
              reason: 'repeated failure',
            },
          },
        ],
      },
      {
        finding_id: 'f2',
        category: 'high_risk_permission',
        severity: 'high',
        agent_id: 'rental-agent',
        tool_name: 'permission.grant',
        trace_id: 'trace_2',
        title: 'Permission grant call',
        summary: 'Unexpected permission.grant call.',
        recommendation: 'Confirm authorization.',
        requires_action: true,
        evidence: [
          {
            event_id: 2,
            agent_id: 'rental-agent',
            agent_name: 'Rental Agent',
            tool_name: 'permission.grant',
            trace_id: 'trace_2',
            span_id: 'span-2',
            log_detail: {
              ts: '2026-07-03T10:01:00.000Z',
              event: 'tool.end',
              status: 'OK',
              duration_ms: 50,
              entity: null,
              result_summary: 'granted',
              error_message: null,
              reason: 'high-risk permission',
            },
          },
        ],
      },
    ],
  };
}

test('enqueue emits audit_review_summary with dashboard_url and top_findings', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: {
      auditReview: {
        notification: {
          mode: 'callback',
          callbackUrl: 'http://127.0.0.1:9999/audit-review-events',
          minSeverity: 'medium',
          sendEmptyReview: false,
        },
      },
    },
  });
  const result = notifier.enqueue({
    reviewId: 'review_test_1',
    run: makeRun(),
    review: makeReview(),
    dashboardUrl: 'http://127.0.0.1:9320/dashboard/audit-reviews/review_test_1',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
  const call = outbox.calls[0];
  assert.equal(call.type, 'audit_review_summary');
  assert.equal(call.runId, 'review_test_1');
  assert.equal(call.deliveryMode, 'callback');
  assert.equal(call.callbackUrl, 'http://127.0.0.1:9999/audit-review-events');
  const payload = call.payload;
  assert.equal(payload.type, 'audit_review_summary');
  assert.equal(payload.review_id, 'review_test_1');
  assert.equal(payload.title, 'Audit review found 2 high risk findings');
  assert.equal(payload.dashboard_url, 'http://127.0.0.1:9320/dashboard/audit-reviews/review_test_1');
  assert.deepEqual(payload.severity_counts, { critical: 0, high: 2, medium: 0, low: 0 });
  assert.equal(payload.top_findings.length, 2);
  assert.equal(payload.top_findings[0].finding_id, 'f1');
  assert.equal(Object.hasOwn(payload.top_findings[0], 'confidence'), false);
  assert.equal(payload.top_findings[0].agent_name, 'MT Audit Agent');
  assert.equal(payload.actions[0].id, 'open_dashboard');
  assert.equal(payload.actions[0].url, payload.dashboard_url);
});

test('sendEmptyReview=false skips empty review', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { sendEmptyReview: false, callbackUrl: 'http://x' } } },
  });
  const emptyReview = {
    summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: '', overview: '' },
    findings: [],
  };
  const result = notifier.enqueue({
    reviewId: 'r_empty',
    run: { window_from: 'a', window_to: 'b' },
    review: emptyReview,
    dashboardUrl: 'http://x/dash/r_empty',
  });
  assert.equal(result.enqueued, false);
  assert.equal(result.reason, 'empty');
  assert.equal(outbox.calls.length, 0);
});

test('sendEmptyReview=true enqueues even when findings empty', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { sendEmptyReview: true, callbackUrl: 'http://x', minSeverity: 'low' } } },
  });
  const result = notifier.enqueue({
    reviewId: 'r_empty',
    run: { window_from: 'a', window_to: 'b' },
    review: {
      summary: { severity_counts: { critical: 0, high: 0, medium: 0, low: 0 }, title: 'No risk', overview: 'OK' },
      findings: [],
    },
    dashboardUrl: 'http://x/dash/r_empty',
  });
  assert.equal(result.enqueued, true);
  assert.equal(outbox.calls.length, 1);
});

test('notification enabled=false prevents review and finding delivery from entering the outbox', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({
    outboxStore: outbox,
    config: { auditReview: { notification: { enabled: false, callbackUrl: 'http://127.0.0.1:9999' } } },
  });

  const summaryResult = notifier.enqueue({
    reviewId: 'r_disabled',
    run: makeRun(),
    review: makeReview(),
    dashboardUrl: '/dashboard/audit-reviews/r_disabled',
  });
  const findingResult = notifier.enqueueFinding({
    finding: makeReview().findings[0],
    reviewId: 'r_disabled',
    run: makeRun(),
    dashboardUrl: '/dashboard/audit-reviews/r_disabled',
  });

  assert.deepEqual(summaryResult, { enqueued: false, reason: 'disabled' });
  assert.deepEqual(findingResult, { enqueued: false, reason: 'disabled' });
  assert.equal(outbox.calls.length, 0);
});

test('callback Findings cannot decide instantaneous alerts at any severity', () => {
  const outbox = makeFakeOutboxStore();
  const notifier = createReviewNotifier({ outboxStore: outbox,
    config: { auditReview: { notification: { mode: 'callback', callbackUrl: 'http://x' } } } });
  for (const severity of ['low', 'medium', 'high', 'critical']) {
    const finding = { severity, agent_id: 'a', trace_id: 't' };
    assert.equal(notifier.enqueueFinding({ finding }).reason, 'trace_conclusion_required');
    assert.equal(notifier.enqueueHighRiskGroups({ findings: [finding] }).enqueued, false);
  }
  assert.equal(outbox.calls.length, 0);
});

test('meetsMinSeverity compares by index', () => {
  assert.equal(meetsMinSeverity('critical', 'low'), true);
  assert.equal(meetsMinSeverity('high', 'high'), true);
  assert.equal(meetsMinSeverity('medium', 'high'), false);
  assert.equal(meetsMinSeverity('low', 'medium'), false);
  assert.equal(meetsMinSeverity('critical', 'critical'), true);
});


function trace(overrides = {}) {
  return { agent_id: 'a', trace_id: 't', sealed_at: '2026-09-16T01:00:00Z',
    review_version: 1, risk_level: 'high', trace_status: 'failed', requester_id: 'user',
    original_request: '生成报告', agent_result: '数据库不可用', risk_reason: '任务失败', ...overrides };
}

function traceNotifier(db, options = {}) {
  return createReviewNotifier({ db, outboxStore: createOutboxStore(db), feishuMode: 'live',
    config: { auditReview: { notification: { enabled: true, mode: 'feishu_bot' } } }, ...options });
}
function notificationDb(filename = ':memory:') {
  const db = new Database(filename);
  ensureRuntimeSchema(db);
  db.exec(`CREATE TABLE audit_trace_notifications (agent_id TEXT NOT NULL, trace_id TEXT NOT NULL,
    enqueued_at TEXT NOT NULL, PRIMARY KEY(agent_id,trace_id))`);
  return db;
}

test('Trace conclusion reaches real outbox once, including late upgrade and recreated notifier', () => {
  const db = notificationDb();
  try {
    const notifier = traceNotifier(db);
    assert.equal(notifier.enqueueTrace({ trace: trace({ risk_level: 'low' }) }).enqueued, false);
    const first = notifier.enqueueTrace({ trace: trace({ review_version: 2 }), dashboardUrl: 'https://audit.example/dashboard/agents/a/traces/t' });
    assert.equal(first.enqueued, true);
    const again = traceNotifier(db).enqueueTrace({ trace: trace({ review_version: 3, risk_reason: '新增证据' }) });
    assert.equal(again.enqueued, false);
    const rows = db.prepare('SELECT * FROM agent_outbox_events').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].callback_url, null);
    assert.match(rows[0].dedupe_key, /^feishu_trace_alert:[a-f0-9]{24}$/);
    assert.match(rows[0].payload_json, /数据库不可用/);
    assert.doesNotMatch(rows[0].payload_json, /新增证据/);
  } finally { db.close(); }
});

test('persistent receipt prevents re-enqueue after delivered outbox rows are pruned', () => {
  const db = notificationDb();
  try {
    traceNotifier(db).enqueueTrace({ trace: trace() });
    db.prepare("UPDATE agent_outbox_events SET delivery_status='delivered'").run();
    db.prepare("DELETE FROM agent_outbox_events WHERE delivery_status='delivered'").run();
    assert.equal(traceNotifier(db).enqueueTrace({ trace: trace({ review_version: 8 }) }).reason, 'duplicate');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_outbox_events').get().n, 0);
  } finally { db.close(); }
});

test('failed outbox enqueue rolls back notification receipt and permits retry', () => {
  const db = notificationDb();
  try {
    const notifier = traceNotifier(db, { outboxStore: { enqueue() { throw new Error('disk full'); } } });
    assert.throws(() => notifier.enqueueTrace({ trace: trace() }), /disk full/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_trace_notifications').get().n, 0);
    assert.equal(traceNotifier(db).enqueueTrace({ trace: trace() }).enqueued, true);
  } finally { db.close(); }
});

test('composite keys avoid colon collisions and separate same Trace ID across agents', () => {
  const db = notificationDb();
  try {
    const notifier = traceNotifier(db);
    for (const [agent_id, trace_id] of [['a:b','c'], ['a','b:c'], ['a','same'], ['b','same']]) {
      assert.equal(notifier.enqueueTrace({ trace: trace({ agent_id, trace_id }) }).enqueued, true);
    }
    assert.equal(db.prepare('SELECT COUNT(DISTINCT dedupe_key) AS n FROM agent_outbox_events').get().n, 4);
  } finally { db.close(); }
});

test('non-high, unsealed, backfill, disabled and dry-run never persist a receipt', () => {
  const db = notificationDb();
  try {
    for (const risk_level of ['unreviewed', 'none', 'low', 'medium', 'critical']) {
      assert.equal(traceNotifier(db).enqueueTrace({ trace: trace({ risk_level }) }).enqueued, false);
    }
    for (const overrides of [{ sealed_at: null }, { review_version: 0 }, { agent_id: '' }]) {
      assert.equal(traceNotifier(db).enqueueTrace({ trace: trace(overrides) }).enqueued, false);
    }
    for (const feishuMode of ['disabled', 'dry-run']) {
      assert.equal(traceNotifier(db, { feishuMode }).enqueueTrace({ trace: trace() }).enqueued, false);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_trace_notifications').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_outbox_events').get().n, 0);
  } finally { db.close(); }
});

test('Finding severity cannot bypass Trace-only Feishu notifications', () => {
  const db = notificationDb();
  try {
    const notifier = traceNotifier(db);
    assert.equal(notifier.enqueueHighRiskGroups({ findings: makeReview().findings }).reason, 'trace_conclusion_required');
    assert.equal(notifier.enqueueFinding({ finding: makeReview().findings[0] }).enqueued, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_outbox_events').get().n, 0);
  } finally { db.close(); }
});


test('independent SQLite connections and restart retain the Trace notification receipt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-notification-'));
  const filename = path.join(directory, 'audit.db');
  let first;
  let second;
  let reopened;
  try {
    first = notificationDb(filename);
    second = new Database(filename);
    assert.equal(traceNotifier(first).enqueueTrace({ trace: trace() }).enqueued, true);
    assert.equal(traceNotifier(second).enqueueTrace({ trace: trace() }).reason, 'duplicate');
    first.close();
    second.close();
    reopened = new Database(filename);
    reopened.prepare('DELETE FROM agent_outbox_events').run();
    assert.equal(traceNotifier(reopened).enqueueTrace({ trace: trace({ review_version: 9 }) }).reason, 'duplicate');
    assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM audit_trace_notifications').get().n, 1);
  } finally {
    for (const db of [first, second, reopened]) if (db?.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test('migration keeps old alert keys and historical critical evidence without re-alerting backfill', () => {
  const db = openDb(':memory:');
  try {
    ensureRuntimeSchema(db);
    db.prepare(`INSERT INTO audit_events (row_hash, span_id, agent_id, trace_id, ts, event, tool_name, status, raw_json)
      VALUES ('legacy-hash', 'span', 'legacy-agent', 'legacy-trace', '2026-07-01T00:00:00Z', 'run.failed', 'run', 'INTERNAL', '{}')`).run();
    const outbox = createOutboxStore(db);
    outbox.enqueue({ runId: 'legacy-review', type: 'audit_review_high_risk_group',
      deliveryMode: 'feishu_bot', callbackUrl: null, dedupeKey: 'feishu_alert_v2:legacy-hash',
      payload: { historical_severity: 'critical' } });
    const before = db.prepare('SELECT * FROM agent_outbox_events').get();
    ensureReviewSchema(db);
    ensureReviewSchema(db);
    const historical = db.prepare('SELECT * FROM audit_traces').get();
    assert.equal(historical.sealed_reason, 'backfill');
    assert.equal(historical.review_version, 0);
    assert.equal(historical.risk_level, 'unreviewed');
    assert.equal(traceNotifier(db).enqueueTrace({ trace: historical }).reason, 'unreviewed');
    assert.deepEqual(db.prepare('SELECT * FROM agent_outbox_events').get(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_outbox_events').get().n, 1);
  } finally { db.close(); }
});
