import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  createNotificationDigestScheduler,
  latestDailyReportSlotAt,
  loadDailySummary,
  nextDailyReportAt,
} from '../../src/auditReview/notificationDigestScheduler.js';

function makeDb(databasePath = ':memory:') {
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_traces (
      agent_id TEXT NOT NULL, trace_id TEXT NOT NULL, last_event_at TEXT,
      sealed_at TEXT, review_version INTEGER DEFAULT 0, trace_status TEXT DEFAULT 'pending',
      risk_level TEXT DEFAULT 'unreviewed', original_request TEXT, risk_reason TEXT, requester_id TEXT,
      PRIMARY KEY(agent_id, trace_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY,
      ts TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_review_findings (
      finding_id TEXT PRIMARY KEY,
      agent_id TEXT,
      trace_id TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_review_finding_occurrences (
      occurrence_id TEXT PRIMARY KEY,
      finding_id TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_notification_digest_slots (
      slot_key TEXT PRIMARY KEY,
      report_date TEXT NOT NULL,
      slot_hour INTEGER NOT NULL,
      scheduled_for TEXT NOT NULL,
      timezone_offset_minutes INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      enqueued_count INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      last_error TEXT
    );
  `);
  return db;
}

function insertSamples(db) {
  db.exec(`INSERT INTO audit_traces
    (agent_id, trace_id, last_event_at, sealed_at, review_version, trace_status, risk_level, original_request, risk_reason)
    VALUES ('a1','t1','2026-07-17T01:10:00.000Z','2026-07-17T01:10:00.000Z',1,'failed','high','高风险写入','写入摘要'),
      ('a1','t2','2026-07-17T01:20:00.000Z','2026-07-17T01:20:00.000Z',1,'success','none','正常任务',NULL),
      ('a2','t1','2026-07-17T01:30:00.000Z','2026-07-17T01:30:00.000Z',2,'interrupted','high','部署风险','部署风险摘要')`);
  const insertEvent = db.prepare(`
    INSERT INTO audit_events (id, ts, agent_id, trace_id, tool_name, status)
    VALUES (@id, @ts, @agent_id, @trace_id, @tool_name, @status)
  `);
  insertEvent.run({ id: 1, ts: '2026-07-17T01:00:00.000Z', agent_id: 'a1', trace_id: 't1', tool_name: 'read', status: 'OK' });
  insertEvent.run({ id: 2, ts: '2026-07-17T01:10:00.000Z', agent_id: 'a1', trace_id: 't1', tool_name: 'write', status: 'INTERNAL' });
  insertEvent.run({ id: 3, ts: '2026-07-17T01:20:00.000Z', agent_id: 'a1', trace_id: 't2', tool_name: 'read', status: 'OK' });
  insertEvent.run({ id: 4, ts: '2026-07-17T01:30:00.000Z', agent_id: 'a2', trace_id: 't1', tool_name: 'deploy', status: 'OK' });
  db.prepare('INSERT INTO audit_review_findings (finding_id, agent_id, trace_id) VALUES (?, ?, ?)').run('f1', 'a1', 't1');
  db.prepare('INSERT INTO audit_review_findings (finding_id, agent_id, trace_id) VALUES (?, ?, ?)').run('f2', 'a2', 't1');
  db.prepare(`
    INSERT INTO audit_review_finding_occurrences
      (occurrence_id, finding_id, severity, title, summary, observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('o1', 'f1', 'high', '高风险写入', '写入摘要', '2026-07-17T01:15:00.000Z');
  db.prepare(`
    INSERT INTO audit_review_finding_occurrences
      (occurrence_id, finding_id, severity, title, summary, observed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('o2', 'f2', 'critical', '严重部署风险', '部署风险摘要', '2026-07-17T01:25:00.000Z');
}

function config() {
  return {
    agents: {
      a1: { displayName: '审计 Agent A1' },
    },
    report: { timezoneOffsetMinutes: 480 },
    auditReview: {
      visualization: {
        baseUrl: 'https://audit.example.com',
        dashboardPath: '/dashboard',
      },
      notification: {
        enabled: true,
        mode: 'feishu_bot',
        dailyReport: {
          enabled: true,
          hours: [10, 17],
          timezoneOffsetMinutes: 480,
          catchUpWindowMinutes: 30,
        },
        card: { foldThresholdChars: 1 },
      },
    },
  };
}

function dedupingOutbox() {
  const attempts = [];
  const inserted = [];
  const eventIds = new Map();
  return {
    attempts,
    inserted,
    enqueue(event) {
      attempts.push(event);
      const existing = eventIds.get(event.dedupeKey);
      if (existing) return { eventId: existing, enqueued: false };
      const eventId = `evt-${eventIds.size + 1}`;
      eventIds.set(event.dedupeKey, eventId);
      inserted.push(event);
      return { eventId, enqueued: true };
    },
  };
}

test('nextDailyReportAt uses Beijing 10:00 and 17:00 independent of host timezone', () => {
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T01:59:00.000Z')).toISOString(),
    '2026-07-17T02:00:00.000Z',
  );
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T02:00:00.000Z')).toISOString(),
    '2026-07-17T09:00:00.000Z',
  );
  assert.equal(
    nextDailyReportAt(new Date('2026-07-17T09:00:00.000Z')).toISOString(),
    '2026-07-18T02:00:00.000Z',
  );
});

test('latestDailyReportSlotAt includes an exact schedule boundary', () => {
  assert.deepEqual(
    latestDailyReportSlotAt(new Date('2026-07-17T02:00:00.000Z')),
    { hour: 10, scheduledFor: new Date('2026-07-17T02:00:00.000Z') },
  );
  assert.deepEqual(
    latestDailyReportSlotAt(new Date('2026-07-17T09:10:00.000Z')),
    { hour: 17, scheduledFor: new Date('2026-07-17T09:00:00.000Z') },
  );
});

test('scheduler rejects invalid runtime schedule configuration', () => {
  const db = makeDb();
  const base = {
    db,
    outboxStore: { enqueue() {} },
    config: config(),
    ownerId: 'owner-validation',
  };
  assert.throws(
    () => createNotificationDigestScheduler({ ...base, feishuMode: 'unexpected' }),
    /invalid Feishu mode/,
  );
  const badOffset = config();
  badOffset.auditReview.notification.dailyReport.timezoneOffsetMinutes = 480.5;
  assert.throws(
    () => createNotificationDigestScheduler({ ...base, config: badOffset, feishuMode: 'live' }),
    /timezone offset/,
  );
  const badCatchUp = config();
  badCatchUp.auditReview.notification.dailyReport.catchUpWindowMinutes = -1;
  assert.throws(
    () => createNotificationDigestScheduler({ ...base, config: badCatchUp, feishuMode: 'live' }),
    /catch-up window/,
  );
  db.close();
});

test('dry-run renders one global daily card across agents and traces without outbox writes', () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue: (event) => calls.push(event) },
    config: config(),
    feishuMode: 'dry-run',
  });

  const result = scheduler.runNow({ scheduledFor: new Date('2026-07-17T02:00:00.000Z') });

  assert.equal(result.reason, 'dry_run');
  assert.equal(result.groups.length, 1);
  assert.equal(result.payloadCount, 1);
  assert.equal(calls.length, 0);
  const [{ group, payloads }] = result.groups;
  assert.equal(group.scope, 'global');
  assert.equal(group.event_count, 4);
  assert.equal(group.error_count, 1);
  assert.equal(group.tool_count, 3);
  assert.equal(group.agent_count, 2);
  assert.equal(group.trace_count, 3);
  assert.equal(group.high_risk_count, 2);
  assert.equal(group.critical_count, 0);
  assert.equal(group.highest_severity, 'high');
  assert.equal(group.findings.length, 2);
  assert.deepEqual(group.tools.map((tool) => tool.tool_name), ['write', 'read', 'deploy']);
  assert.equal(payloads.length, 1);
  const serialized = JSON.stringify(payloads);
  assert.match(serialized, /统计范围/);
  assert.match(serialized, /北京时间/);
  assert.match(serialized, /"default_url":"https:\/\/audit\.example\.com\/"/);
  assert.doesNotMatch(serialized, /audit\.example\.com\/dashboard/);
  db.close();
});

test('live daily run enqueues feishu_bot payloads with no callback URL and stable dedupe keys', () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue(event) {
        calls.push(event);
        return { enqueued: true };
      },
    },
    config: config(),
    feishuMode: 'live',
  });

  const result = scheduler.runNow({ scheduledFor: new Date('2026-07-17T09:00:00.000Z') });

  assert.equal(result.enqueued, true);
  assert.equal(result.enqueuedCount, 1);
  assert.equal(result.payloadCount, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => call.deliveryMode === 'feishu_bot'));
  assert.ok(calls.every((call) => call.callbackUrl === null));
  const firstKey = calls[0].dedupeKey;

  const renamedCalls = [];
  const renamedConfig = config();
  renamedConfig.agents.a1.displayName = '重命名后的 Agent A1';
  createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue(event) {
        renamedCalls.push(event);
        return { enqueued: true };
      },
    },
    config: renamedConfig,
    feishuMode: 'live',
  }).runNow({ scheduledFor: new Date('2026-07-17T09:00:00.000Z') });
  assert.equal(renamedCalls.length, 1);
  assert.equal(renamedCalls[0].dedupeKey, firstKey);

  const morningCalls = [];
  createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue(event) {
        morningCalls.push(event);
        return { enqueued: true };
      },
    },
    config: config(),
    feishuMode: 'live',
  }).runNow({ scheduledFor: new Date('2026-07-17T02:00:00.000Z') });
  assert.equal(morningCalls.length, 1);
  assert.notEqual(morningCalls[0].dedupeKey, firstKey);
  db.close();
});

test('manual send status returns Beijing window and enforces inclusive protected windows', () => {
  const db = makeDb();
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue() { throw new Error('must not enqueue'); } },
    config: config(),
    feishuMode: 'live',
  });

  const allowed = scheduler.getManualSendStatus({ at: new Date('2026-07-17T06:35:42.000Z') });
  assert.deepEqual(allowed, {
    allowed: true,
    reason: 'allowed',
    date: '2026-07-17',
    window: {
      from: '2026-07-16T16:00:00.000Z',
      to: '2026-07-17T06:35:42.000Z',
    },
    localTime: '2026-07-17T14:35:42.000+08:00',
    timezone: 'UTC+08:00',
    timezoneOffsetMinutes: 480,
  });

  for (const at of [
    '2026-07-17T01:55:00.000Z',
    '2026-07-17T02:05:00.000Z',
    '2026-07-17T08:55:00.000Z',
    '2026-07-17T09:05:00.000Z',
  ]) {
    const protectedStatus = scheduler.getManualSendStatus({ at: new Date(at) });
    assert.equal(protectedStatus.allowed, false);
    assert.equal(protectedStatus.reason, 'protected_window');
  }
  assert.equal(
    scheduler.getManualSendStatus({ at: new Date('2026-07-17T01:54:59.999Z') }).allowed,
    true,
  );
  assert.equal(
    scheduler.getManualSendStatus({ at: new Date('2026-07-17T02:05:00.001Z') }).allowed,
    true,
  );
  const rejected = scheduler.runManual({ generatedAt: new Date('2026-07-17T02:00:00.000Z') });
  assert.equal(rejected.reason, 'protected_window');
  assert.equal(rejected.enqueuedCount, 0);
  assert.equal(rejected.payloadCount, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_notification_digest_slots').get().count, 0);
  db.close();
});

test('manual send is rejected when notifications are disabled or not live', () => {
  for (const mode of ['disabled', 'dry-run']) {
    const db = makeDb();
    const calls = [];
    const scheduler = createNotificationDigestScheduler({
      db,
      outboxStore: { enqueue(event) { calls.push(event); } },
      config: config(),
      feishuMode: mode,
    });
    const result = scheduler.runManual({ generatedAt: new Date('2026-07-17T06:35:00.000Z') });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, mode === 'dry-run' ? 'dry_run' : 'disabled');
    assert.equal(result.eventId, null);
    assert.equal(result.enqueuedCount, 0);
    assert.equal(calls.length, 0);
    db.close();
  }

  const db = makeDb();
  const disabledConfig = config();
  disabledConfig.auditReview.notification.enabled = false;
  const result = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue() { throw new Error('must not enqueue'); } },
    config: disabledConfig,
    feishuMode: 'live',
  }).runManual({ generatedAt: new Date('2026-07-17T06:35:00.000Z') });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'disabled');
  db.close();
});

test('manual send deduplicates within one Beijing minute and allows the next minute', async () => {
  const db = makeDb();
  insertSamples(db);
  const outboxStore = dedupingOutbox();
  const flushes = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore,
    config: config(),
    feishuMode: 'live',
    onEnqueued(result) { flushes.push(result.reason); },
  });

  const first = scheduler.runManual({ generatedAt: new Date('2026-07-17T06:35:10.000Z') });
  const duplicate = scheduler.runManual({ generatedAt: new Date('2026-07-17T06:35:59.999Z') });
  const nextMinute = scheduler.runManual({ generatedAt: new Date('2026-07-17T06:36:00.000Z') });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first.reason, 'enqueued');
  assert.equal(first.eventId, 'evt-1');
  assert.equal(first.enqueuedCount, 1);
  assert.equal(first.payloadCount, 1);
  assert.equal(first.window.from, '2026-07-16T16:00:00.000Z');
  assert.equal(first.window.to, '2026-07-17T06:35:10.000Z');
  assert.equal(duplicate.reason, 'duplicate');
  assert.equal(duplicate.eventId, first.eventId);
  assert.equal(duplicate.enqueuedCount, 0);
  assert.equal(nextMinute.reason, 'enqueued');
  assert.equal(nextMinute.eventId, 'evt-2');
  assert.deepEqual(
    outboxStore.attempts.map((event) => event.dedupeKey),
    [
      'feishu_daily_manual:2026-07-17:14:35',
      'feishu_daily_manual:2026-07-17:14:35',
      'feishu_daily_manual:2026-07-17:14:36',
    ],
  );
  assert.equal(outboxStore.inserted.length, 2);
  assert.deepEqual(flushes, ['enqueued', 'enqueued']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_notification_digest_slots').get().count, 0);
  const serialized = JSON.stringify(first.groups[0].payloads[0]);
  assert.match(serialized, /审计信息日报/);
  assert.match(serialized, /全局汇总 · 14:35/);
  assert.doesNotMatch(serialized, /手动|人工触发/);
  db.close();
});

test('manual send uses an isolated dedupe namespace and does not block the scheduled slot', async () => {
  const db = makeDb();
  insertSamples(db);
  const outboxStore = dedupingOutbox();
  const flushes = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore,
    config: config(),
    feishuMode: 'live',
    now: () => new Date('2026-07-17T02:00:00.000Z'),
    ownerId: 'owner-manual-then-scheduled',
    onEnqueued(result) { flushes.push(result.reason ?? result.status); },
  });

  const manual = scheduler.runManual({ generatedAt: new Date('2026-07-17T01:00:00.000Z') });
  const scheduled = scheduler.reconcileDueSlot({ at: new Date('2026-07-17T02:00:00.000Z') });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manual.reason, 'enqueued');
  assert.equal(scheduled.status, 'enqueued');
  assert.equal(outboxStore.inserted.length, 2);
  assert.equal(outboxStore.inserted[0].dedupeKey, 'feishu_daily_manual:2026-07-17:09:00');
  assert.match(outboxStore.inserted[1].dedupeKey, /^feishu_daily:/);
  assert.notEqual(outboxStore.inserted[0].dedupeKey, outboxStore.inserted[1].dedupeKey);
  const slots = db.prepare('SELECT * FROM audit_notification_digest_slots').all();
  assert.equal(slots.length, 1);
  assert.equal(slots[0].slot_key, 'daily:2026-07-17:10');
  assert.deepEqual(flushes, ['enqueued', 'enqueued']);
  db.close();
});

test('scheduler start installs the next calendar timer and stop clears it', () => {
  const db = makeDb();
  const timers = [];
  const cleared = [];
  const now = () => new Date('2026-07-17T01:59:00.000Z');
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue() {} },
    config: config(),
    feishuMode: 'dry-run',
    now,
    timerApi: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) { cleared.push(timer); },
    },
  });

  scheduler.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 60_000);
  scheduler.stop();
  assert.deepEqual(cleared, [timers[0]]);
  db.close();
});

test('scheduler start executes the exact 10:00 live slot and immediately requests a flush', async () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const flushes = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue(event) { calls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-exact',
    now: () => new Date('2026-07-17T02:00:00.000Z'),
    onEnqueued(result) { flushes.push(result.status); },
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  });

  scheduler.start();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.deepEqual(flushes, ['enqueued']);
  assert.ok(calls.every((call) => call.runId === 'daily_2026-07-17_10'));
  assert.ok(calls.every((call) => call.priority === 100));
  const slot = db.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(slot.slot_key, 'daily:2026-07-17:10');
  assert.equal(slot.status, 'enqueued');
  assert.equal(slot.trigger_type, 'scheduled');
  db.close();
});

test('scheduler reclaims an expired slot lease and sends one zero-data overview only once', () => {
  const staleDb = makeDb();
  insertSamples(staleDb);
  staleDb.prepare(`
    INSERT INTO audit_notification_digest_slots (
      slot_key, report_date, slot_hour, scheduled_for, timezone_offset_minutes,
      trigger_type, status, attempts, enqueued_count, owner_id, lease_expires_at, started_at
    ) VALUES (
      'daily:2026-07-17:10', '2026-07-17', 10, '2026-07-17T02:00:00.000Z', 480,
      'catch_up', 'running', 1, 0, 'owner-stale', '2026-07-17T02:00:30.000Z', '2026-07-17T02:00:00.000Z'
    )
  `).run();
  const recoveredCalls = [];
  createNotificationDigestScheduler({
    db: staleDb,
    outboxStore: { enqueue(event) { recoveredCalls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-recovered',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  }).start();
  assert.equal(recoveredCalls.length, 1);
  const recoveredSlot = staleDb.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(recoveredSlot.status, 'enqueued');
  assert.equal(recoveredSlot.attempts, 2);
  staleDb.close();

  const emptyDb = makeDb();
  const emptyCalls = [];
  const emptyOptions = {
    db: emptyDb,
    outboxStore: { enqueue(event) { emptyCalls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    now: () => new Date('2026-07-17T02:00:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  };
  const emptyResult = createNotificationDigestScheduler({
    ...emptyOptions,
    ownerId: 'owner-empty-1',
  }).reconcileDueSlot();
  createNotificationDigestScheduler({ ...emptyOptions, ownerId: 'owner-empty-2' }).start();
  assert.equal(emptyResult.status, 'enqueued');
  assert.equal(emptyResult.result.groups.length, 1);
  assert.equal(emptyResult.result.enqueuedCount, 1);
  assert.equal(emptyResult.result.payloadCount, 1);
  assert.deepEqual(
    {
      event_count: emptyResult.result.groups[0].group.event_count,
      error_count: emptyResult.result.groups[0].group.error_count,
      agent_count: emptyResult.result.groups[0].group.agent_count,
      trace_count: emptyResult.result.groups[0].group.trace_count,
      tool_count: emptyResult.result.groups[0].group.tool_count,
      high_risk_count: emptyResult.result.groups[0].group.high_risk_count,
    },
    {
      event_count: 0,
      error_count: 0,
      agent_count: 0,
      trace_count: 0,
      tool_count: 0,
      high_risk_count: 0,
    },
  );
  assert.equal(emptyCalls.length, 1);
  assert.equal(emptyCalls[0].runId, 'daily_2026-07-17_10');
  assert.match(JSON.stringify(emptyCalls[0].payload), /0/);
  const emptySlot = emptyDb.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(emptySlot.status, 'enqueued');
  assert.equal(emptySlot.enqueued_count, 1);
  assert.equal(emptySlot.attempts, 1);
  emptyDb.close();
});

test('scheduler catches up at 10:01 but records skipped_late after the 30-minute window', () => {
  const catchUpDb = makeDb();
  insertSamples(catchUpDb);
  const catchUpCalls = [];
  const catchUp = createNotificationDigestScheduler({
    db: catchUpDb,
    outboxStore: { enqueue(event) { catchUpCalls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-catch-up',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  });
  catchUp.start();
  assert.equal(catchUpCalls.length, 1);
  const catchUpSlot = catchUpDb.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(catchUpSlot.status, 'enqueued');
  assert.equal(catchUpSlot.trigger_type, 'catch_up');
  catchUpDb.close();

  const lateDb = makeDb();
  insertSamples(lateDb);
  const lateCalls = [];
  const late = createNotificationDigestScheduler({
    db: lateDb,
    outboxStore: { enqueue(event) { lateCalls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-late',
    now: () => new Date('2026-07-17T02:31:00.001Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  });
  late.start();
  assert.equal(lateCalls.length, 0);
  assert.equal(lateDb.prepare('SELECT status FROM audit_notification_digest_slots').get().status, 'skipped_late');
  lateDb.close();
});

test('scheduler retries a failed slot inside the catch-up window without a restart', async () => {
  const db = makeDb();
  insertSamples(db);
  let current = new Date('2026-07-17T02:00:00.000Z');
  let shouldFail = true;
  const calls = [];
  const timers = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue(event) {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('transient sqlite failure');
        }
        calls.push(event);
        return { enqueued: true };
      },
    },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-retry',
    now: () => current,
    timerApi: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout() {},
    },
  });

  scheduler.start();
  assert.equal(db.prepare('SELECT status FROM audit_notification_digest_slots').get().status, 'failed');
  assert.equal(timers[0].delayMs, 2_000);

  current = new Date('2026-07-17T02:00:02.000Z');
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  const slot = db.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(slot.status, 'enqueued');
  assert.equal(slot.attempts, 2);
  assert.equal(calls.length, 1);
  db.close();
});

test('scheduler retries when a previous process slot lease expires inside the catch-up window', async () => {
  const db = makeDb();
  insertSamples(db);
  db.prepare(`
    INSERT INTO audit_notification_digest_slots (
      slot_key, report_date, slot_hour, scheduled_for, timezone_offset_minutes,
      trigger_type, status, attempts, enqueued_count, owner_id, lease_expires_at, started_at
    ) VALUES (
      'daily:2026-07-17:10', '2026-07-17', 10, '2026-07-17T02:00:00.000Z', 480,
      'scheduled', 'running', 1, 0, 'owner-crashed', '2026-07-17T02:05:00.000Z', '2026-07-17T02:00:00.000Z'
    )
  `).run();
  let current = new Date('2026-07-17T02:01:00.000Z');
  const timers = [];
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue(event) { calls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-after-crash',
    now: () => current,
    timerApi: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout() {},
    },
  });

  scheduler.start();
  assert.equal(calls.length, 0);
  assert.equal(timers[0].delayMs, 240_001);

  current = new Date('2026-07-17T02:05:00.001Z');
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  const slot = db.prepare('SELECT * FROM audit_notification_digest_slots').get();
  assert.equal(slot.status, 'enqueued');
  assert.equal(slot.attempts, 2);
  assert.equal(slot.trigger_type, 'catch_up');
  assert.equal(calls.length, 1);
  db.close();
});

test('two live schedulers sharing a database execute one slot only', () => {
  const db = makeDb();
  insertSamples(db);
  const calls = [];
  const options = {
    db,
    outboxStore: { enqueue(event) { calls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  };
  const first = createNotificationDigestScheduler({ ...options, ownerId: 'owner-1' });
  const second = createNotificationDigestScheduler({ ...options, ownerId: 'owner-2' });

  first.start();
  second.start();

  assert.equal(calls.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_notification_digest_slots').get().count, 1);
  assert.equal(db.prepare('SELECT attempts FROM audit_notification_digest_slots').get().attempts, 1);
  db.close();
});

test('two live schedulers on independent SQLite connections execute one slot only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-digest-claim-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const firstDb = makeDb(dbPath);
  const secondDb = makeDb(dbPath);
  insertSamples(firstDb);
  const calls = [];
  const options = {
    outboxStore: { enqueue(event) { calls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  };

  try {
    createNotificationDigestScheduler({ ...options, db: firstDb, ownerId: 'owner-connection-1' }).start();
    createNotificationDigestScheduler({ ...options, db: secondDb, ownerId: 'owner-connection-2' }).start();

    assert.equal(calls.length, 1);
    assert.equal(secondDb.prepare('SELECT COUNT(*) AS count FROM audit_notification_digest_slots').get().count, 1);
    assert.equal(secondDb.prepare('SELECT attempts FROM audit_notification_digest_slots').get().attempts, 1);
  } finally {
    secondDb.close();
    firstDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scheduler does not report or flush success after losing the slot lease', () => {
  const db = makeDb();
  insertSamples(db);
  const flushes = [];
  let stolen = false;
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue() {
        if (!stolen) {
          stolen = true;
          db.prepare(`
            UPDATE audit_notification_digest_slots
            SET owner_id = 'owner-replacement', lease_expires_at = '2026-07-17T02:20:00.000Z'
            WHERE slot_key = 'daily:2026-07-17:10'
          `).run();
        }
        return { enqueued: true };
      },
    },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-original',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
    onEnqueued(result) { flushes.push(result); },
  });

  const result = scheduler.reconcileDueSlot();

  assert.equal(result.status, 'lost_lease');
  assert.equal(result.processed, false);
  assert.equal(flushes.length, 0);
  assert.equal(db.prepare('SELECT status FROM audit_notification_digest_slots').get().status, 'running');
  assert.equal(db.prepare('SELECT owner_id FROM audit_notification_digest_slots').get().owner_id, 'owner-replacement');
  db.close();
});

test('scheduler reports lost lease when failure recording no longer owns the slot', () => {
  const db = makeDb();
  insertSamples(db);
  let stolen = false;
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: {
      enqueue() {
        if (!stolen) {
          stolen = true;
          db.prepare(`
            UPDATE audit_notification_digest_slots
            SET owner_id = 'owner-replacement', lease_expires_at = '2026-07-17T02:20:00.000Z'
            WHERE slot_key = 'daily:2026-07-17:10'
          `).run();
        }
        throw new Error('simulated enqueue failure');
      },
    },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-original',
    now: () => new Date('2026-07-17T02:01:00.000Z'),
  });

  const result = scheduler.reconcileDueSlot();

  assert.equal(result.status, 'lost_lease');
  assert.equal(result.processed, false);
  assert.match(result.error.message, /simulated enqueue failure/);
  assert.equal(db.prepare('SELECT status FROM audit_notification_digest_slots').get().status, 'running');
  assert.equal(db.prepare('SELECT owner_id FROM audit_notification_digest_slots').get().owner_id, 'owner-replacement');
  db.close();
});

test('a delayed timer reconciles the latest 17:00 cumulative slot', async () => {
  const db = makeDb();
  insertSamples(db);
  db.prepare(`
    INSERT INTO audit_events (id, ts, agent_id, trace_id, tool_name, status)
    VALUES (5, '2026-07-17T08:30:00.000Z', 'a1', 't1', 'read', 'OK')
  `).run();
  let current = new Date('2026-07-17T01:59:00.000Z');
  const timers = [];
  const calls = [];
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue(event) { calls.push(event); return { enqueued: true }; } },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-delayed',
    now: () => current,
    timerApi: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs };
        timers.push(timer);
        return timer;
      },
      clearTimeout() {},
    },
  });

  scheduler.start();
  calls.length = 0;
  current = new Date('2026-07-17T09:10:00.000Z');
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.length, 1);
  assert.ok(calls.every((call) => call.runId === 'daily_2026-07-17_17'));
  assert.equal(
    db.prepare(`SELECT status FROM audit_notification_digest_slots WHERE slot_key = 'daily:2026-07-17:17'`).get().status,
    'enqueued',
  );
  db.close();
});

test('health status exposes safe scheduling state and no next run when inactive', () => {
  const db = makeDb();
  const scheduler = createNotificationDigestScheduler({
    db,
    outboxStore: { enqueue() {} },
    config: config(),
    feishuMode: 'live',
    ownerId: 'owner-health',
    now: () => new Date('2026-07-17T01:59:00.000Z'),
    timerApi: { setTimeout() { return { id: 1 }; }, clearTimeout() {} },
  });

  assert.equal(scheduler.getHealthStatus().active, false);
  assert.equal(scheduler.getHealthStatus().next_run_at_utc, null);
  scheduler.start();
  const health = scheduler.getHealthStatus();
  assert.equal(health.active, true);
  assert.equal(health.timezone, 'UTC+08:00');
  assert.deepEqual(health.schedule_hours, [10, 17]);
  assert.equal(health.catch_up_window_minutes, 30);
  assert.equal(health.next_run_at_utc, '2026-07-17T02:00:00.000Z');
  assert.equal(health.next_run_at_local, '2026-07-17T10:00:00.000+08:00');
  db.close();
});


test('daily buckets use reviewed sealed Traces, never Finding occurrences or unreviewed risk', () => {
  const db = makeDb();
  try {
    insertSamples(db);
    const insert = db.prepare(`INSERT INTO audit_traces
      (agent_id,trace_id,last_event_at,sealed_at,review_version,trace_status,risk_level)
      VALUES ('a3',?,'2026-07-17T01:40:00.000Z',?,?,?,?)`);
    insert.run('medium', 'sealed', 1, 'success', 'medium');
    insert.run('low', 'sealed', 1, 'incomplete', 'low');
    insert.run('backfill', 'sealed', 0, 'pending', 'unreviewed');
    insert.run('reopened', null, 2, 'failed', 'high');
    const summary = loadDailySummary(db, { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T02:00:00.000Z' });
    assert.equal(summary.trace_count, 7);
    assert.equal(summary.reviewed_trace_count, 5);
    assert.equal(summary.event_count, 4);
    assert.deepEqual(summary.trace_status_counts, { success: 2, failed: 1, interrupted: 1, incomplete: 1 });
    assert.deepEqual(summary.risk_level_counts, { none: 1, low: 1, medium: 1, high: 2 });
    assert.equal(summary.critical_count, 0);
    assert.deepEqual(summary.top_risks.map(row => row.risk_level), ['high', 'high', 'medium']);
  } finally { db.close(); }
});

test('daily Agent and requester summaries count tasks across agents and keep unknown identities together', () => {
  const db = makeDb();
  try {
    insertSamples(db);
    db.exec("UPDATE audit_traces SET requester_id='user-shared' WHERE trace_id='t1'");
    db.exec(`INSERT INTO audit_traces
      (agent_id,trace_id,last_event_at,requester_id,sealed_at,review_version,risk_level)
      VALUES ('a3','pending','2026-07-17T01:40:00.000Z',' ',NULL,2,'high'),
      ('a3','old','2026-07-15T01:40:00.000Z','excluded','sealed',1,'high')`);
    const summary = loadDailySummary(db, { from: '2026-07-16T16:00:00.000Z', to: '2026-07-17T02:00:00.000Z' });
    assert.equal(summary.agent_count, 3, 'include tasks even when they have no events in this window');
    assert.equal(summary.requester_count, 1, 'same requester across two agents is one person');
    assert.deepEqual(summary.agents, [
      { agent_id: 'a1', task_count: 2, risk_count: 1 },
      { agent_id: 'a2', task_count: 1, risk_count: 1 },
      { agent_id: 'a3', task_count: 1, risk_count: 0 },
    ]);
    assert.deepEqual(summary.requesters, [
      { requester_id: null, task_count: 2, risk_count: 0 },
      { requester_id: 'user-shared', task_count: 2, risk_count: 2 },
    ]);
    assert.ok(summary.top_risks.every(row => row.requester_id === 'user-shared'));
  } finally { db.close(); }
});
