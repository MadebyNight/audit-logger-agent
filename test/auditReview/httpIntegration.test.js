// test/auditReview/httpIntegration.test.js
//
// Integration smoke test for v1.4 audit-review HTTP routes.
// Exercises createHttpApp end-to-end with a real in-memory SQLite DB,
// real dependency graph (reviewStore, lockStore, scheduler, etc.),
// and fake LLM + outbox. No source files are modified.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { normalizeEntry } from '../../scripts/lib/parser.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createReviewStore } from '../../src/auditReview/reviewStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../../src/auditReview/ingestService.js';
import { createCandidateDetector } from '../../src/auditReview/candidateDetector.js';
import { createLlmReviewer } from '../../src/auditReview/llmReviewer.js';
import { createReviewNotifier } from '../../src/auditReview/notification.js';
import { createVisualization } from '../../src/auditReview/visualization.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';
import { createAuditReviewScheduler } from '../../src/auditReview/scheduler.js';
import { createFindingLifecycleService } from '../../src/auditReview/findingLifecycleService.js';
import { createToolSemanticMapper } from '../../src/auditReview/toolSemanticMapper.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

test('dashboard routes pass normalized finding filters to visualization', async () => {
  const calls = [];
  const page = {
    page: { title: '过滤参数测试' },
    summary_metrics: [],
    filters: [],
    sections: [],
  };
  const visualization = {
    agentIndexPage() {
      return page;
    },
    overviewPage(filters) {
      calls.push({ route: 'overview', filters });
      return page;
    },
    reviewDetailPage(reviewId, filters) {
      calls.push({ route: 'review', reviewId, filters });
      return page;
    },
  };
  const dashboardAuth = createDashboardAuth({
    config: { auditReview: { http: { allowedOrigins: [] } } },
    env: {},
  });
  const app = createHttpApp({
    db: {},
    config: {},
    scheduler: {},
    reviewStore: {
      getRun(reviewId) {
        return reviewId === 'review-1' ? { review_id: reviewId } : null;
      },
    },
    visualization,
    dashboardAuth,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const overview = await fetch(
      `${baseUrl}/dashboard?agent_id=agent%2Fone&severity=high&category=failed_call&status=resolved&review_id=review-1&sort=severity_desc&log_page=3&log_event=tool.end&log_tool_name=db.delete&log_trace_id=trace-1&log_status=INTERNAL`,
    );
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.shift(), {
      route: 'overview',
      filters: {
        agentId: 'agent/one',
        severity: 'high',
        category: 'failed_call',
        status: 'resolved',
        reviewId: 'review-1',
        sort: 'severity_desc',
        logPage: 3,
        logEvent: 'tool.end',
        logToolName: 'db.delete',
        logTraceId: 'trace-1',
        logStatus: 'INTERNAL',
      },
    });

    const empty = await fetch(
      `${baseUrl}/dashboard?agent_id=&severity=&category=&status=&review_id=&sort=invalid&log_page=0`,
    );
    assert.equal(empty.status, 200);
    assert.deepEqual(calls.shift(), {
      route: 'overview',
      filters: {
        agentId: undefined,
        severity: undefined,
        category: undefined,
        status: undefined,
        reviewId: undefined,
        sort: undefined,
        logPage: undefined,
        logEvent: undefined,
        logToolName: undefined,
        logTraceId: undefined,
        logStatus: undefined,
      },
    });

    const review = await fetch(
      `${baseUrl}/dashboard/audit-reviews/review-1?agent_id=agent-two&severity=medium&category=repeated_call&status=open`,
    );
    assert.equal(review.status, 200);
    assert.equal(review.headers.get('cache-control'), 'no-store');
    assert.deepEqual(calls.shift(), {
      route: 'review',
      reviewId: 'review-1',
      filters: {
        agentId: 'agent-two',
        severity: 'medium',
        category: 'repeated_call',
        status: 'open',
      },
    });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('dashboard manual daily report confirmation and POST map delivery outcomes without GET side effects', async () => {
  const db = openDb(':memory:');
  ensureRuntimeSchema(db);
  let scenario = 'enqueued';
  let flushMode = 'delivered';
  let eventSequence = 0;
  let flushCalls = 0;
  let runCalls = 0;
  const manualStatuses = [];
  const insertOutbox = db.prepare(`
    INSERT INTO agent_outbox_events (
      event_id, run_id, type, payload_json, delivery_mode, delivery_status,
      delivery_attempts, max_attempts, callback_url, created_at
    ) VALUES (?, ?, 'audit_daily_trace_report', '{}', 'feishu_bot', 'pending', 0, 8, NULL, ?)
  `);
  const notificationDigestScheduler = {
    getManualSendStatus() {
      return {
        allowed: scenario !== 'disabled' && scenario !== 'dry_run',
        reason: scenario === 'disabled' || scenario === 'dry_run' ? scenario : 'allowed',
        date: '2026-07-20',
        window: { from: '2026-07-19T16:00:00.000Z', to: '2026-07-20T06:35:00.000Z' },
        localTime: '2026-07-20T14:35:00+08:00',
        timezone: 'UTC+08:00',
        timezoneOffsetMinutes: 480,
      };
    },
    runManual() {
      runCalls += 1;
      if (scenario === 'duplicate') {
        return { reason: 'duplicate', eventId: 'evt-existing', enqueuedCount: 0, payloadCount: 1 };
      }
      if (scenario === 'protected_window') {
        return { reason: 'protected_window', eventId: null, enqueuedCount: 0, payloadCount: 0 };
      }
      if (scenario === 'disabled' || scenario === 'dry_run') {
        return { reason: scenario, eventId: null, enqueuedCount: 0, payloadCount: 0 };
      }
      if (scenario === 'failed') throw new Error('internal manual report failure');
      const eventId = `evt-manual-${++eventSequence}`;
      insertOutbox.run(eventId, `manual-${eventSequence}`, new Date().toISOString());
      return { reason: 'enqueued', eventId, enqueuedCount: 1, payloadCount: 1 };
    },
  };
  const visualization = {
    overviewPage() {
      return { page: { title: '日报入口测试' }, summary_metrics: [], filters: [], sections: [] };
    },
    manualDailyReportPage({ status }) {
      manualStatuses.push(status);
      return {
        page: { title: '确认发送当前日报', notification_status: status },
        summary_metrics: [],
        filters: [],
        sections: [{
          id: 'manual_daily_report_confirmation',
          type: 'confirmation',
          title: '发送当前日报',
          description: status.message,
          allowed: status.allowed,
          items: [{ label: '统计日期', value: status.date }],
          form: status.allowed ? {
            method: 'post',
            action: '/dashboard/daily-report/send',
            submit_label: '确认发送',
            cancel_label: '返回',
            cancel_href: '/dashboard',
          } : {
            cancel_label: '返回',
            cancel_href: '/dashboard',
          },
        }],
      };
    },
  };
  const dashboardAuth = {
    authorizeDashboard(req) {
      return req.headers['x-deny'] === '1'
        ? { ok: false, status: 403, code: 'forbidden' }
        : { ok: true };
    },
    corsHeaders() { return {}; },
    clearSessionCookie() { return ''; },
  };
  const app = createHttpApp({
    db,
    config: {},
    scheduler: {},
    reviewStore: {},
    visualization,
    dashboardAuth,
    notificationDigestScheduler,
    now: () => new Date('2026-07-20T06:35:00.000Z'),
    async flushNotifications() {
      flushCalls += 1;
      const eventId = `evt-manual-${eventSequence}`;
      if (flushMode === 'delivered') {
        db.prepare(`
          UPDATE agent_outbox_events
          SET delivery_status = 'delivered', delivered_at = ?
          WHERE event_id = ?
        `).run(new Date().toISOString(), eventId);
        return;
      }
      if (flushMode === 'failed') throw new Error('flush failed');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const post = () => fetch(`${baseUrl}/dashboard/daily-report/send`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });

  try {
    const beforeGet = db.prepare('SELECT COUNT(*) AS count FROM agent_outbox_events').get().count;
    const confirmation = await fetch(`${baseUrl}/dashboard/daily-report/send`);
    assert.equal(confirmation.status, 200);
    const confirmationHtml = await confirmation.text();
    assert.match(confirmationHtml, /确认发送当前日报|发送当前日报/);
    assert.match(confirmationHtml, /method="post" action="\/dashboard\/daily-report\/send"/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_outbox_events').get().count, beforeGet);
    assert.equal(runCalls, 0);
    assert.equal(manualStatuses[0].label, '飞书通知正常');
    assert.equal(manualStatuses[0].date, '2026-07-20');

    const dashboard = await fetch(`${baseUrl}/dashboard`);
    const dashboardHtml = await dashboard.text();
    assert.match(dashboardHtml, /飞书通知正常/);
    assert.match(dashboardHtml, /href="\/dashboard\/daily-report\/send"/);
    assert.doesNotMatch(dashboardHtml, /立即发送日报/);

    scenario = 'enqueued';
    flushMode = 'delivered';
    const sent = await post();
    assert.equal(sent.status, 303);
    assert.equal(sent.headers.get('location'), '/dashboard?notice=daily_report_sent');
    assert.equal(flushCalls, 1);
    assert.equal(db.prepare("SELECT delivery_status FROM agent_outbox_events WHERE event_id = 'evt-manual-1'").get().delivery_status, 'delivered');
    const sentNotice = await (await fetch(`${baseUrl}${sent.headers.get('location')}`)).text();
    assert.match(sentNotice, /日报已发送/);

    scenario = 'duplicate';
    const duplicate = await post();
    assert.equal(duplicate.headers.get('location'), '/dashboard?notice=daily_report_duplicate');
    assert.equal(flushCalls, 1);

    scenario = 'protected_window';
    const protectedResponse = await post();
    assert.equal(protectedResponse.headers.get('location'), '/dashboard?notice=daily_report_protected');
    assert.equal(flushCalls, 1);

    scenario = 'dry_run';
    const unavailableConfirmation = await fetch(`${baseUrl}/dashboard/daily-report/send`);
    const unavailableConfirmationHtml = await unavailableConfirmation.text();
    assert.match(unavailableConfirmationHtml, /当前为飞书演练模式，不能发送真实日报/);
    assert.doesNotMatch(unavailableConfirmationHtml, /<form method="post" action="\/dashboard\/daily-report\/send"/);
    const unavailable = await post();
    assert.equal(unavailable.headers.get('location'), '/dashboard?notice=daily_report_unavailable');
    assert.equal(flushCalls, 1);

    scenario = 'enqueued';
    flushMode = 'failed';
    const queued = await post();
    assert.equal(queued.headers.get('location'), '/dashboard?notice=daily_report_queued');
    assert.equal(flushCalls, 2);
    assert.equal(db.prepare("SELECT delivery_status FROM agent_outbox_events WHERE event_id = 'evt-manual-2'").get().delivery_status, 'pending');

    scenario = 'failed';
    const failed = await post();
    assert.equal(failed.headers.get('location'), '/dashboard?notice=daily_report_failed');

    const deniedGet = await fetch(`${baseUrl}/dashboard/daily-report/send`, { headers: { 'x-deny': '1' } });
    assert.equal(deniedGet.status, 403);
    const callsBeforeDeniedPost = runCalls;
    const deniedPost = await fetch(`${baseUrl}/dashboard/daily-report/send`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'x-deny': '1', 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(deniedPost.status, 403);
    assert.equal(runCalls, callsBeforeDeniedPost);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    db.close();
  }
});

test('finding lifecycle HTTP routes expose history, map conflicts, and use dashboard POST + 303', async () => {
  const calls = [];
  const finding = { finding_id: 'finding/1', status: 'open', state_version: 3 };
  const reviewStore = {
    getFinding(findingId) {
      return findingId === 'finding/1' ? finding : null;
    },
    getRun(reviewId) {
      return reviewId === 'review-1' ? { review_id: reviewId } : null;
    },
    listFindingActions({ findingId, limit, offset }) {
      assert.equal(findingId, 'finding/1');
      return [{ action_id: 'act-1', limit, offset }];
    },
    listFindingOccurrences({ findingId, limit, offset }) {
      assert.equal(findingId, 'finding/1');
      return [{ occurrence_id: 'occ-1', limit, offset }];
    },
    listReviewOccurrences({ reviewId, limit, offset }) {
      assert.equal(reviewId, 'review-1');
      return [{ occurrence_id: 'occ-review-1', limit, offset }];
    },
  };
  const findingLifecycleService = {
    performAction(input) {
      calls.push(input);
      if (input.action === 'conflict') {
        const error = new Error('version changed');
        error.code = 'finding_version_conflict';
        throw error;
      }
      if (input.action === 'invalid') {
        const error = new Error('invalid action');
        error.code = 'invalid_finding_action';
        throw error;
      }
      return { finding: { ...finding, status: 'resolved', state_version: 4 }, action: { action_type: input.action } };
    },
  };
  const visualization = {
    overviewPage() { return { page: { title: '总览' }, sections: [] }; },
    reviewDetailPage() { return { page: { title: '审查' }, sections: [] }; },
    findingDetailPage(findingId, options) {
      return {
        page: { title: findingId },
        notices: options?.notice ? [{ tone: options.notice === 'action_success' ? 'success' : 'critical', title: options.notice }] : [],
        sections: [],
      };
    },
  };
  const dashboardAuth = createDashboardAuth({
    config: { auditReview: { http: { allowedOrigins: [] } } },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'lifecycle-test-token' },
  });
  const app = createHttpApp({
    db: {},
    config: { limits: { maxQueryLimit: 50 } },
    scheduler: {},
    reviewStore,
    visualization,
    dashboardAuth,
    findingLifecycleService,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const apiHeaders = { Authorization: 'Bearer lifecycle-test-token' };

  try {
    for (const [route, expectedId] of [
      ['/v1/audit-findings/finding%2F1/actions?limit=500&offset=2', 'act-1'],
      ['/v1/audit-findings/finding%2F1/occurrences?limit=20&offset=3', 'occ-1'],
      ['/v1/audit-reviews/review-1/occurrences?limit=10&offset=4', 'occ-review-1'],
    ]) {
      const response = await fetch(`${baseUrl}${route}`, { headers: apiHeaders });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.count, 1);
      assert.equal(body.results[0].action_id ?? body.results[0].occurrence_id, expectedId);
    }

    const success = await fetch(`${baseUrl}/v1/audit-findings/finding%2F1/actions`, {
      method: 'POST',
      headers: { ...apiHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'resolve',
        actor: 'operator-1',
        note: '已修复',
        expected_state_version: 3,
      }),
    });
    assert.equal(success.status, 200);
    assert.deepEqual(calls.at(-1), {
      findingId: 'finding/1',
      action: 'resolve',
      actor: 'operator-1',
      note: '已修复',
      snoozedUntil: undefined,
      expectedStateVersion: 3,
    });

    const conflict = await fetch(`${baseUrl}/v1/audit-findings/finding%2F1/actions`, {
      method: 'POST',
      headers: { ...apiHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'conflict', actor: 'operator-1', expected_state_version: 3 }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error_code, 'finding_version_conflict');

    const invalid = await fetch(`${baseUrl}/v1/audit-findings/finding%2F1/actions`, {
      method: 'POST',
      headers: { ...apiHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'invalid' }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error_code, 'invalid_finding_action');

    const malformed = await fetch(`${baseUrl}/v1/audit-findings/finding%2F1/actions`, {
      method: 'POST',
      headers: { ...apiHeaders, 'content-type': 'application/json' },
      body: '{not-json',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error_code, 'invalid_finding_action');

    const dashboardAction = await fetch(`${baseUrl}/dashboard/audit-findings/finding%2F1/actions`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'resolve', actor: 'operator-2', note: '完成', expected_state_version: '3' }),
    });
    assert.equal(dashboardAction.status, 303);
    assert.equal(
      dashboardAction.headers.get('location'),
      '/dashboard/audit-findings/finding%2F1?notice=action_success&action=resolve',
    );
    assert.equal(calls.at(-1).expectedStateVersion, 3);

    const noticePage = await fetch(`${baseUrl}${dashboardAction.headers.get('location')}`);
    assert.equal(noticePage.status, 200);
    assert.ok((await noticePage.text()).includes('action_success'));
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

function makeUpstreamEvent(overrides = {}) {
  return {
    ts: '2026-07-06T07:33:08.200Z',
    agent_id: 'agent-test',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'search',
    status: 'OK',
    result_summary: 'search ok',
    duration_ms: 50,
    channel: 'http',
    user_id: 'user-1',
    entity: { type: 'product', id: 'product-1' },
    ...overrides,
  };
}

async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

const MOJIBAKE_PATTERN = /(?:[涓楂椋闄浣淇鎴鍏椤瀵艰埅鐖璋鐩閾捐矾寤妯鏆棤鍙睍绀鐧诲綍璁块棶浠ょ墝鏇柊堕棿鎬昏澶氶潯佹嵁鏃瑙妫]{2,}|鈥\?|€�)/;

test('audit review HTTP integration smoke test', async () => {
  // ------------------------------------------------------------------
  // 1. Build a real DB with runtime + review schema and seed audit_events
  // ------------------------------------------------------------------
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-http-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const now = Date.now();
  const entries = [
    {
      // Error event -> failed_call candidate
      ts: new Date(now - 2 * 60 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-err-1',
      span_id: 'span-err-1',
      event: 'tool.error',
      tool_name: 'search',
      status: 'INTERNAL',
      result_summary: 'search failed',
      duration_ms: 500,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
      error: { code: 'E_SEARCH', message: 'search engine down' },
    },
    {
      // High-risk delete tool -> high_risk_permission candidate
      ts: new Date(now - 60 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-del-1',
      span_id: 'span-del-1',
      event: 'tool.end',
      tool_name: 'db.delete',
      status: 'OK',
      result_summary: 'deleted 5 rows',
      duration_ms: 100,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
    },
    {
      // Normal OK event -> not a candidate
      ts: new Date(now - 30 * 1000).toISOString(),
      agent_id: 'agent-test',
      trace_id: 'trace-ok-1',
      span_id: 'span-ok-1',
      event: 'tool.end',
      tool_name: 'search',
      status: 'OK',
      result_summary: 'search ok',
      duration_ms: 50,
      channel: 'feishu',
      user_id: 'user-1',
      entity: { type: 'product', id: 'product-1' },
    },
  ];
  insertEvents(db, entries.map(normalizeEntry));

  // ------------------------------------------------------------------
  // 2. Construct the dependency graph (mirrors scripts/server.js)
  // ------------------------------------------------------------------
  const config = {
    dbPath,
    agents: {},
    auditReview: {
      intervalMinutes: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: 500,
      riskPolicy: {
        version: 'risk-test-v1',
        highRiskToolPatterns: ['*delete*'],
        repeatWindowMinutes: 10,
        repeatThreshold: 5,
        slowCallDurationMs: 30000,
        agentToolAllowlists: {},
      },
      llmReview: {
        promptVersion: 'prompt-test-v1',
        reviewerVersion: 'reviewer-test-v1',
        model: 'test-model',
      },
      visualization: {
        baseUrl: 'http://127.0.0.1:9320',
        dashboardPath: '/dashboard',
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: ['http://127.0.0.1:9320'],
      },
    },
    planner: { model: 'test-model' },
  };

  const reviewStore = createReviewStore(db);
  const findingLifecycleService = createFindingLifecycleService({ reviewStore });
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const detector = createCandidateDetector({ db, riskPolicy: config.auditReview.riskPolicy });

  // Fake LLM client: returns a valid review with 1 finding referencing a candidate event id.
  const fakeLlmClient = {
    async createStructuredResponse({ input }) {
      const userMsg = input.find((m) => m.role === 'user');
      const payload = JSON.parse(userMsg.content);
      const eventId = payload.candidates?.find((candidate) => candidate.tool_name === 'db.delete')?.event_id
        ?? payload.candidates?.[0]?.event_id
        ?? 1;
      return {
        type: 'audit_review',
        review_id: payload.review_id,
        window: payload.window,
        summary: {
          title: '测试审查发现 1 个风险',
          overview: '基于候选事件发现 1 个高风险操作。',
          severity_counts: { critical: 0, high: 1, medium: 0, low: 0 },
        },
        findings: [
          {
            category: 'high_risk_permission',
            severity: 'high',
            agent_id: 'agent-test',
            tool_name: 'db.delete',
            trace_id: 'trace-del-1',
            entity: null,
            title: '高危删除操作',
            summary: '检测到删除工具调用，需要审查。',
            recommendation: '确认删除操作已授权。',
            evidence_event_ids: [eventId],
            requires_action: true,
          },
        ],
      };
    },
  };

  const llmReviewer = createLlmReviewer({
    llmClient: fakeLlmClient,
    model: 'test-model',
    promptVersion: 'prompt-test-v1',
    reviewerVersion: 'reviewer-test-v1',
  });

  // Fake outbox store: captures enqueued notifications in-memory.
  const enqueued = [];
  const fakeOutboxStore = {
    enqueue(item) {
      enqueued.push(item);
      return { event_id: 'fake_evt_' + enqueued.length };
    },
  };

  const notifier = createReviewNotifier({ outboxStore: fakeOutboxStore, config });

  const visualization = createVisualization({
    reviewStore,
    config: {
      auditReview: {
        visualization: {
          baseUrl: 'http://127.0.0.1:9320',
          dashboardPath: '/dashboard',
        },
      },
    },
  });

  const dashboardAuth = createDashboardAuth({
    config: {
      auditReview: {
        http: {
          bindHost: '127.0.0.1',
          requireDashboardToken: false,
          allowedOrigins: ['http://127.0.0.1:9320'],
        },
      },
    },
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'test-token-123' },
  });

  // ------------------------------------------------------------------
  // 3. Build the scheduler with all deps + a fake audit logger
  // ------------------------------------------------------------------
  const scheduler = createAuditReviewScheduler({
    db,
    config,
    reviewStore,
    lockStore,
    ingestService,
    cursorStore,
    detector,
    llmReviewer,
    notifier,
    visualization,
    auditLogger: { log: async () => {} },
  });

  // ------------------------------------------------------------------
  // 4. createHttpApp + listen on ephemeral port
  // ------------------------------------------------------------------
  const app = createHttpApp({
    db,
    config: { dbPath },
    scheduler,
    reviewStore,
    visualization,
    dashboardAuth,
    findingLifecycleService,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const bearerHeaders = { Authorization: 'Bearer test-token-123' };

  try {
    // Dashboard HTML is public; legacy login routes redirect back to the dashboard
    // and must not expose the shared API token.
    {
      const loginPage = await fetch(`${baseUrl}/dashboard/login?token=test-token-123`);
      assert.equal(loginPage.status, 200);
      assert.equal(loginPage.url, `${baseUrl}/dashboard`);
      const login = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=wrong-token',
      });
      assert.equal(login.status, 303);
      assert.equal(login.headers.get('location'), '/dashboard');
    }

    {
      const root = await fetch(`${baseUrl}/`);
      assert.equal(root.status, 200, 'GET / should render the agent index page');
      assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(root.headers.get('cache-control'), 'no-store');
      const rootHtml = await root.text();
      assert.ok(rootHtml.includes('Agent 日志入口'), 'root page should contain the agent index title');
      assert.ok(rootHtml.includes('agent-test'), 'root page should list received agent id');
      assert.ok(rootHtml.includes('/dashboard/agents/agent-test'), 'root page should link to requester-grouped agent dashboard');
      assert.doesNotMatch(rootHtml, MOJIBAKE_PATTERN);

      const dashboard = await fetch(`${baseUrl}/dashboard`);
      assert.equal(dashboard.status, 200);
      assert.equal(dashboard.headers.get('cache-control'), 'no-store');
      const dashboardHtml = await dashboard.text();
      assert.equal(dashboardHtml.includes('test-token-123'), false);
      assert.doesNotMatch(dashboardHtml, MOJIBAKE_PATTERN);
      const dashboardWithSlash = await fetch(`${baseUrl}/dashboard/`);
      assert.equal(dashboardWithSlash.status, 200);
      assert.equal(dashboardWithSlash.headers.get('cache-control'), 'no-store');
      const agentDashboard = await fetch(`${baseUrl}/dashboard?agent_id=agent-test`);
      assert.equal(agentDashboard.status, 200);
      const agentDashboardHtml = await agentDashboard.text();
      assert.ok(agentDashboardHtml.includes('Agent 日志审计：agent-test'));
      assert.ok(agentDashboardHtml.includes('href="/" class="page-action'));
      assert.doesNotMatch(agentDashboardHtml, MOJIBAKE_PATTERN);
      const apiWithBearer = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
      assert.equal(apiWithBearer.status, 200);
    }

    {
      const logout = await fetch(`${baseUrl}/dashboard/logout`, {
        method: 'POST',
        redirect: 'manual',
      });
      assert.equal(logout.status, 303);
      assert.equal(logout.headers.get('location'), '/dashboard');
      assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    }

    // ------------------------------------------------------------------
    // Case 1: GET /v1/audit-reviews before any run -> 200 with Bearer auth
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET /v1/audit-reviews should be 200');
      const body = await res.json();
      assert.equal(body.count, 0, 'should have zero runs');
      assert.equal(body.results.length, 0, 'results array should be empty');
    }

    // ------------------------------------------------------------------
    // Case 2a: POST /v1/audit-reviews/run WITHOUT auth -> 401
    // (loopback write requires token even when requireDashboardToken=false)
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, { method: 'POST' });
      assert.equal(res.status, 401, 'POST without auth should be 401');
      const body = await res.json();
      assert.equal(body.error_code, 'missing_token', 'should be missing_token');
    }

    // ------------------------------------------------------------------
    // Case 2b: POST with WRONG bearer token -> 403
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      assert.equal(res.status, 403, 'POST with wrong token should be 403');
      const body = await res.json();
      assert.equal(body.error_code, 'invalid_token', 'should be invalid_token');
    }

    // ------------------------------------------------------------------
    // Case 2c: POST with CORRECT token -> 202 with review_id
    // ------------------------------------------------------------------
    let reviewId;
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token-123' },
      });
      assert.equal(res.status, 202, 'POST with correct token should be 202');
      const body = await res.json();
      assert.ok(body.review_id, 'response should include review_id');
      assert.ok(body.status, 'response should include status');
      reviewId = body.review_id;
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews -> new run listed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, { headers: bearerHeaders });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.count >= 1, 'should list at least 1 run');
      const found = body.results.find((r) => r.review_id === reviewId);
      assert.ok(found, 'new run should appear in the list');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews/:reviewId -> 200
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/${reviewId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET review by id should be 200');
      const body = await res.json();
      assert.equal(body.review_id, reviewId, 'review_id should match');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings -> >= 1 finding
    // ------------------------------------------------------------------
    let findingId;
    let findingRecord;
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings`, { headers: bearerHeaders });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.count >= 1, 'should have at least 1 finding');
      findingRecord = body.results.find((finding) => finding.status === 'open');
      assert.ok(findingRecord, 'should have at least 1 open finding for dashboard filtering');
      findingId = findingRecord.finding_id;
      assert.ok(findingId, 'finding should have finding_id');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings/:findingId -> 200
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings/${findingId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET finding by id should be 200');
      const body = await res.json();
      assert.equal(body.finding_id, findingId, 'finding_id should match');
    }

    // ------------------------------------------------------------------
    // Case: Concurrency 409 — acquire lock manually, then POST
    // ------------------------------------------------------------------
    {
      const acquired = lockStore.acquire({ ownerId: 'holder' });
      assert.ok(acquired.acquired, 'manual lock acquire should succeed');

      const res = await fetch(`${baseUrl}/v1/audit-reviews/run`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-token-123' },
      });
      assert.equal(res.status, 409, 'POST while lock held should be 409');
      const body = await res.json();
      assert.equal(body.error_code, 'review_already_running', 'should be review_already_running');

      lockStore.release({ lockName: 'audit_review_scheduler', ownerId: 'holder' });
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard -> 200 text/html with 审计 or Severity
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET /dashboard should be 200');
      assert.equal(
        res.headers.get('content-type'),
        'text/html; charset=utf-8',
        'dashboard content-type should be text/html',
      );
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'dashboard html should contain <html');
      assert.ok(html.includes('审计审查总览'), 'dashboard should contain Chinese overview title');
      assert.ok(html.includes('严重级别'), 'dashboard should contain Chinese severity label');
      assert.equal(html.includes('Audit Review Overview'), false, 'dashboard should not contain English overview title');
      assert.equal(html.includes('Severity'), false, 'dashboard should not contain English Severity');
      assert.equal(html.includes('Confidence'), false, 'dashboard should not contain English Confidence');
      assert.equal(html.includes('Data source'), false, 'dashboard should not contain Data source');
      assert.ok(html.includes(findingRecord.title), 'dashboard should include the default open finding');
      assert.ok(html.includes('/dashboard/audit-findings/'), 'dashboard should link to finding detail evidence');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);

      const filtered = await fetch(`${baseUrl}/dashboard?agent_id=agent-test`, { headers: bearerHeaders });
      assert.equal(filtered.status, 200, 'GET filtered agent dashboard should be 200');
      const filteredHtml = await filtered.text();
      assert.ok(filteredHtml.includes('Agent 日志审计：agent-test'), 'filtered dashboard should include agent title');
      const filteredApi = await fetch(`${baseUrl}/v1/audit-findings?agent_id=agent-test`, { headers: bearerHeaders });
      assert.equal(filteredApi.status, 200);
      const filteredBody = await filteredApi.json();
      assert.ok(filteredBody.count >= 1, 'filtered API should contain the agent finding');
      assert.ok(filteredHtml.includes('风险发现'), 'filtered dashboard should render the findings section');
      assert.ok(filteredHtml.includes('Agent 日志（第 1/1 页，共 3 条）'), 'agent dashboard should render all agent logs');
      assert.ok(filteredHtml.includes('trace-ok-1'), 'agent dashboard should render the latest trace id');
      assert.ok(filteredHtml.includes('span-ok-1'), 'agent dashboard should render the latest span id');
      assert.ok(filteredHtml.includes('search ok'), 'agent dashboard should render normal non-finding logs');
      assert.ok(filteredHtml.includes('当前页原始日志'), 'agent dashboard should expose current-page raw logs');
      assert.ok(filteredHtml.includes('全部状态'), 'agent dashboard should default the status filter to all states');
      assert.equal(filteredHtml.includes('打开最新降级审查'), false, 'dashboard should not render the degraded review shortcut');
      assert.ok(filteredHtml.includes('agent-test'), 'filtered dashboard should contain the agent id');
      assert.ok(filteredHtml.includes('db.delete'), 'filtered dashboard should contain the agent finding tool');
      assert.doesNotMatch(filteredHtml, MOJIBAKE_PATTERN);

      const matchingFilters = new URLSearchParams({
        agent_id: findingRecord.agent_id,
        severity: findingRecord.severity,
        category: findingRecord.category,
        status: 'open',
        review_id: findingRecord.review_id,
      });
      const matching = await fetch(`${baseUrl}/dashboard?${matchingFilters}`, { headers: bearerHeaders });
      assert.equal(matching.status, 200, 'GET dashboard with matching filters should be 200');
      assert.equal(matching.headers.get('cache-control'), 'no-store');
      const matchingHtml = await matching.text();
      assert.ok(matchingHtml.includes(findingRecord.trace_id), 'matching filters should retain associated Agent logs');
      assert.equal(matchingHtml.includes('id="pending_findings"'), false, 'Agent dashboard should not render duplicate findings');
      assert.equal(matchingHtml.includes('test-token-123'), false, 'filtered dashboard must not expose the API token');

      for (const [filterName, filterValue] of [
        ['agent_id', 'other-agent'],
        ['severity', 'critical'],
        ['category', findingRecord.category === 'failed_call' ? 'high_risk_permission' : 'failed_call'],
        ['status', 'resolved'],
      ]) {
        const params = new URLSearchParams({
          agent_id: findingRecord.agent_id,
          severity: findingRecord.severity,
          category: findingRecord.category,
          status: 'open',
          review_id: findingRecord.review_id,
        });
        params.set(filterName, filterValue);
        const excluded = await fetch(`${baseUrl}/dashboard?${params}`, { headers: bearerHeaders });
        assert.equal(excluded.status, 200, `GET dashboard with non-matching ${filterName} should be 200`);
        const excludedHtml = await excluded.text();
        assert.equal(
          excludedHtml.includes(findingRecord.trace_id),
          false,
          `non-matching ${filterName} should exclude associated Agent logs`,
        );
        assert.doesNotMatch(excludedHtml, MOJIBAKE_PATTERN);
      }
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-reviews/:reviewId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-reviews/${reviewId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET dashboard review detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'review detail html should contain <html');
      assert.ok(html.includes('审查批次'), 'review detail should contain Chinese review title');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);

      const matching = await fetch(
        `${baseUrl}/dashboard/audit-reviews/${findingRecord.review_id}?agent_id=${encodeURIComponent(findingRecord.agent_id)}&severity=${encodeURIComponent(findingRecord.severity)}&category=${encodeURIComponent(findingRecord.category)}&status=open`,
        { headers: bearerHeaders },
      );
      assert.equal(matching.status, 200, 'GET filtered review detail should be 200');
      assert.equal(matching.headers.get('cache-control'), 'no-store');
      const matchingHtml = await matching.text();
      assert.ok(matchingHtml.includes(findingRecord.title), 'matching review filters should retain the finding');
      assert.equal(matchingHtml.includes('test-token-123'), false, 'filtered review must not expose the API token');

      const excluded = await fetch(
        `${baseUrl}/dashboard/audit-reviews/${findingRecord.review_id}?severity=critical`,
        { headers: bearerHeaders },
      );
      assert.equal(excluded.status, 200, 'GET review detail with non-matching severity should be 200');
      const excludedHtml = await excluded.text();
      assert.equal(excludedHtml.includes(findingRecord.title), false, 'non-matching review filter should exclude the finding');
      assert.doesNotMatch(excludedHtml, MOJIBAKE_PATTERN);
    }

    // ------------------------------------------------------------------
    // Case: GET /dashboard/audit-findings/:findingId -> 200 html
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/dashboard/audit-findings/${findingId}`, { headers: bearerHeaders });
      assert.equal(res.status, 200, 'GET dashboard finding detail should be 200');
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
      const html = await res.text();
      assert.ok(html.includes('<html'), 'finding detail html should contain <html');
      assert.ok(html.includes('id="trace_sequence"'), 'finding detail should render trace sequence anchor');
      assert.ok(html.includes('工具调用顺序'), 'finding detail should contain Chinese trace sequence section');
      assert.equal(html.includes('id="trace_timeline"'), false, 'finding detail should not render old trace timeline table');
      assert.equal(html.includes('id="evidence_events"'), false, 'finding detail should not render old evidence table');
      assert.ok(html.includes('trace-del-1'), 'finding detail should contain the finding trace id');
      assert.ok(html.includes('db.delete'), 'finding detail should contain the trace tool call');
      assert.ok(html.includes('deleted 5 rows'), 'finding detail should contain the trace event summary');
      assert.ok(html.includes('原始日志片段'), 'finding detail should contain Chinese raw evidence log snippets');
      assert.ok(html.includes('raw-log-pre'), 'finding detail should render raw snippets in preformatted blocks');
      assert.ok(html.includes('&quot;tool_name&quot;:&quot;db.delete&quot;'), 'raw snippet should preserve the original compact JSON field');
      assert.equal(html.includes('Tool call sequence'), false, 'finding detail should not contain English trace sequence section');
      assert.equal(html.includes('Raw log snippet'), false, 'finding detail should not contain English raw evidence label');
      assert.doesNotMatch(html, MOJIBAKE_PATTERN);
      assert.equal(html.includes('置信度'), false, 'finding detail should not contain 置信度');
    }

    // ------------------------------------------------------------------
    // Case: real occurrence/action history and lifecycle Dashboard flow
    // ------------------------------------------------------------------
    {
      const findingOccurrences = await fetch(
        `${baseUrl}/v1/audit-findings/${findingId}/occurrences`,
        { headers: bearerHeaders },
      );
      assert.equal(findingOccurrences.status, 200);
      const occurrenceBody = await findingOccurrences.json();
      assert.ok(occurrenceBody.count >= 1, 'finding should retain at least one occurrence snapshot');
      assert.ok(Array.isArray(occurrenceBody.results[0].evidence));

      const reviewOccurrences = await fetch(
        `${baseUrl}/v1/audit-reviews/${findingRecord.review_id}/occurrences`,
        { headers: bearerHeaders },
      );
      assert.equal(reviewOccurrences.status, 200);
      assert.ok((await reviewOccurrences.json()).count >= 1);

      const acknowledge = await fetch(`${baseUrl}/v1/audit-findings/${findingId}/actions`, {
        method: 'POST',
        headers: { ...bearerHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'acknowledge',
          actor: 'integration-operator',
          expected_state_version: findingRecord.state_version,
        }),
      });
      assert.equal(acknowledge.status, 200);
      const acknowledgeBody = await acknowledge.json();
      assert.equal(acknowledgeBody.finding.status, 'acknowledged');

      const resolve = await fetch(`${baseUrl}/dashboard/audit-findings/${findingId}/actions`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'resolve',
          actor: 'integration-operator',
          note: '集成测试已验证',
          expected_state_version: String(acknowledgeBody.finding.state_version),
        }),
      });
      assert.equal(resolve.status, 303);
      assert.match(resolve.headers.get('location'), /notice=action_success/);

      const resolvedPage = await fetch(`${baseUrl}${resolve.headers.get('location')}`);
      assert.equal(resolvedPage.status, 200);
      const resolvedHtml = await resolvedPage.text();
      assert.ok(resolvedHtml.includes('操作已完成'));
      assert.ok(resolvedHtml.includes('出现历史'));
      assert.ok(resolvedHtml.includes('操作历史'));
      assert.ok(resolvedHtml.includes('历史证据快照'));

      const actionHistory = await fetch(
        `${baseUrl}/v1/audit-findings/${findingId}/actions`,
        { headers: bearerHeaders },
      );
      assert.equal(actionHistory.status, 200);
      assert.equal((await actionHistory.json()).count, 2);
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-reviews/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews/nonexistent`, { headers: bearerHeaders });
      assert.equal(res.status, 404, 'GET nonexistent review should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'review_not_found', 'should be review_not_found');
    }

    // ------------------------------------------------------------------
    // Case: GET /v1/audit-findings/nonexistent -> 404
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-findings/nonexistent`, { headers: bearerHeaders });
      assert.equal(res.status, 404, 'GET nonexistent finding should be 404');
      const body = await res.json();
      assert.equal(body.error_code, 'finding_not_found', 'should be finding_not_found');
    }

    // ------------------------------------------------------------------
    // Case: CORS — non-allowed origin should NOT be echoed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, {
        headers: { ...bearerHeaders, Origin: 'http://evil.test' },
      });
      assert.equal(res.status, 200);
      assert.notEqual(
        res.headers.get('access-control-allow-origin'),
        'http://evil.test',
        'evil origin should NOT be echoed in ACAO',
      );
    }

    // ------------------------------------------------------------------
    // Case: CORS — allowed origin should be echoed
    // ------------------------------------------------------------------
    {
      const res = await fetch(`${baseUrl}/v1/audit-reviews`, {
        headers: { ...bearerHeaders, Origin: 'http://127.0.0.1:9320' },
      });
      assert.equal(res.status, 200);
      assert.equal(
        res.headers.get('access-control-allow-origin'),
        'http://127.0.0.1:9320',
        'allowed origin should be echoed in ACAO',
      );
    }

    // ------------------------------------------------------------------
    // Sanity: the fake outbox should have captured at least 1 enqueue
    // (the summary notification for the successful run).
    // ------------------------------------------------------------------
    assert.equal(enqueued.length, 0, 'unsealed traces and legacy Findings must not trigger Trace notifications');
    // v1.5 regression: captured payloads must be generic delivery payloads
    // and must NOT carry Feishu/Bot-specific required fields. The generic
    // delivery target is the callback receiver; no bot-specific field is
    // required in the payload shape.
    for (const item of enqueued) {
      assert.ok(item.type === 'audit_review_summary' || item.type === 'audit_review_finding',
        `outbox item type should be a generic review payload, got ${item.type}`);
      assert.equal(
        Object.prototype.hasOwnProperty.call(item, 'callback_url'),
        false,
        'outbox item must not carry callback_url as a bot-specific required field',
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(item.payload, 'confidence'),
        false,
        'outbox payload must not carry confidence (removed in v1.5)',
      );
    }
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('audit review ingests all events and reviews canonical or unknown tool lifecycle events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-alias-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const capturedPayloads = [];
  let schedulerNow = new Date('2026-07-08T10:00:00.000Z');
  const aliasEventTs = '2026-07-08T09:59:00.000Z';
  const unknownEventTs = '2026-07-08T09:59:30.000Z';
  const config = {
    dbPath,
    agents: {},
    ingest: {
      http: {
        enabled: true,
        maxBodyBytes: 1024 * 1024,
        maxLineBytes: 64 * 1024,
      },
      spoolDir: path.join(tmpDir, 'incoming'),
    },
    auditReview: {
      notification: { enabled: true, mode: 'feishu_bot' },
      intervalMinutes: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: 500,
      riskPolicy: {
        version: 'risk-test-v1',
        highRiskToolPatterns: ['*delete*'],
        repeatWindowMinutes: 10,
        repeatThreshold: 5,
        slowCallDurationMs: 30000,
        agentToolAllowlists: {},
      },
      llmReview: {
        promptVersion: 'prompt-test-v1',
        reviewerVersion: 'reviewer-test-v1',
        model: 'test-model',
      },
      visualization: {
        baseUrl: 'http://127.0.0.1:9321',
        dashboardPath: '/dashboard',
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: ['http://127.0.0.1:9321'],
      },
    },
    planner: { model: 'test-model' },
  };

  const reviewStore = createReviewStore(db);
  const lockStore = createLockStore(db);
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const detector = createCandidateDetector({ db, riskPolicy: config.auditReview.riskPolicy });
  const fakeLlmClient = {
    async createStructuredResponse({ input }) {
      const userMsg = input.find((message) => message.role === 'user');
      const payload = JSON.parse(userMsg.content);
      capturedPayloads.push(payload);
      assert.equal(payload.candidates, undefined, 'LLM receives one full Trace, not window candidates');
      return {
        risk_level: 'low',
        risk_reason: '任务仅记录了工具调用，缺少明确终止事件，现有完整证据不能确认用户目标已达成，因此保留低风险待确认结论。',
        evidence_event_ids: [payload.events[0].event_id],
      };
    },
  };
  const llmReviewer = createLlmReviewer({
    llmClient: fakeLlmClient,
    model: 'test-model',
    promptVersion: 'prompt-test-v1',
    reviewerVersion: 'reviewer-test-v1',
  });
  const toolSemanticMapper = createToolSemanticMapper({
    db,
    llmClient: fakeLlmClient,
    model: 'test-model',
  });
  const enqueued = [];
  const notifier = createReviewNotifier({
    db,
    feishuMode: 'live',
    outboxStore: {
      enqueue(item) {
        enqueued.push(item);
        return { event_id: `fake_evt_${item.type}` };
      },
    },
    config,
  });
  const visualization = createVisualization({
    db,
    reviewStore,
    config: {
      auditReview: {
        visualization: config.auditReview.visualization,
      },
    },
  });
  const dashboardAuth = createDashboardAuth({
    config,
    env: { AUDIT_AGENT_DASHBOARD_TOKEN: 'test-token-123' },
  });
  const scheduler = createAuditReviewScheduler({
    db,
    config,
    reviewStore,
    lockStore,
    ingestService,
    cursorStore,
    detector,
    llmReviewer,
    toolSemanticMapper,
    notifier,
    visualization,
    auditLogger: { log: async () => {} },
    now: () => schedulerNow,
  });
  const app = createHttpApp({
    db,
    config,
    scheduler,
    reviewStore,
    visualization,
    dashboardAuth,
    toolSemanticMapper,
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const aliasTraceId = 'trace-alias-tool-end';
  const unknownTraceId = 'trace-unknown-tool-finish';

  try {
    const aliasResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: aliasEventTs,
        trace_id: aliasTraceId,
        span_id: 'span-alias-tool-end',
        event: 'tool_end',
        tool_name: 'db.delete',
        result_summary: 'deleted 2 rows',
      })),
    });
    assert.equal(aliasResponse.status, 202);
    assert.deepEqual(await aliasResponse.json(), { accepted: 1, rejected: 0, errors: [] });

    const unknownResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: unknownEventTs,
        trace_id: unknownTraceId,
        span_id: 'span-unknown-tool-finish',
        event: 'tool.finish',
        tool_name: 'db.delete',
        result_summary: 'unknown lifecycle event should be accepted',
      })),
    });
    assert.equal(unknownResponse.status, 202);
    const unknownBody = await unknownResponse.json();
    assert.equal(unknownBody.accepted, 1);
    assert.equal(unknownBody.rejected, 0);
    assert.deepEqual(unknownBody.errors, []);

    const storedAlias = db.prepare('SELECT event, mapped_tool_type, mapping_status, raw_json FROM audit_events WHERE trace_id = ?').get(aliasTraceId);
    assert.equal(storedAlias.event, 'tool.end');
    assert.equal(storedAlias.mapped_tool_type, 'delete');
    assert.equal(storedAlias.mapping_status, 'mapped');
    assert.equal(JSON.parse(storedAlias.raw_json).event, 'tool_end');
    const storedUnknown = db.prepare('SELECT event, mapped_tool_type, mapping_status, raw_json FROM audit_events WHERE trace_id = ?').get(unknownTraceId);
    assert.equal(storedUnknown.event, 'unknown');
    assert.equal(storedUnknown.mapped_tool_type, 'delete');
    assert.equal(storedUnknown.mapping_status, 'mapped');
    assert.equal(JSON.parse(storedUnknown.raw_json).event, 'tool.finish');

    const spooled = fs.readFileSync(
      path.join(config.ingest.spoolDir, 'agent-test', `audit-${aliasEventTs.slice(0, 10)}.jsonl`),
      'utf-8',
    );
    assert.ok(spooled.includes(aliasTraceId));
    assert.ok(spooled.includes('"event":"tool_end"'));
    assert.ok(spooled.includes(unknownTraceId));

    const aggregated = await waitFor(() => db.prepare('SELECT COUNT(*) AS n FROM audit_traces').get().n === 2);
    assert.equal(aggregated, true, 'HTTP ingest must automatically schedule Trace aggregation');
    assert.equal(capturedPayloads.length, 0, 'unsealed tasks are not sent to LLM');
    const auth = { Authorization: 'Bearer test-token-123' };
    const getTrace = async (traceId) => {
      const response = await fetch(`${baseUrl}/v1/audit-logs?agent_id=agent-test&trace_id=${traceId}`, { headers: auth });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.count, 1);
      return result.traces[0];
    };
    assert.equal((await getTrace(aliasTraceId)).audit_result, null);

    // Advance the scheduler clock, then exercise the authenticated HTTP entry point.
    schedulerNow = new Date('2026-07-08T12:00:00.000Z');
    const manual = await fetch(`${baseUrl}/v1/audit-reviews/run`, { method: 'POST', headers: auth });
    assert.equal(manual.status, 202);
    assert.equal((await manual.json()).status, 'completed');
    assert.equal(capturedPayloads.length, 2, 'each sealed Trace receives its own LLM request');
    assert.deepEqual(capturedPayloads.map((p) => p.trace_id).sort(), [aliasTraceId, unknownTraceId].sort());
    for (const payload of capturedPayloads) {
      assert.equal(payload.agent_id, 'agent-test');
      assert.equal(payload.events.length, 1);
      assert.equal(payload.events[0].tool_name, 'db.delete');
    }
    assert.equal(capturedPayloads.find((p) => p.trace_id === aliasTraceId).events[0].event, 'tool.end');
    assert.equal(capturedPayloads.find((p) => p.trace_id === unknownTraceId).events[0].event, 'unknown');
    const findings = await fetch(`${baseUrl}/v1/audit-findings?agent_id=agent-test`, { headers: auth });
    assert.equal(findings.status, 200);
    assert.ok((await findings.json()).results.some((finding) => finding.trace_id === aliasTraceId),
      'deterministic Finding evidence remains available alongside Trace conclusions');
    for (const traceId of [aliasTraceId, unknownTraceId]) {
      const trace = await getTrace(traceId);
      assert.ok(trace.audit_result, JSON.stringify(db.prepare('SELECT risk_reason, review_error FROM audit_traces WHERE trace_id=?').get(traceId)));
      assert.equal(trace.audit_result.trace_status, 'incomplete');
      assert.equal(trace.audit_result.risk_level, 'low');
      assert.equal(trace.audit_result.review_version, 1);
      assert.equal(trace.events.length, 1);
      assert.deepEqual(trace.audit_result.evidence_event_ids, [trace.events[0].event_id]);
      assert.equal(trace.events[0].raw_json.event, traceId === aliasTraceId ? 'tool_end' : 'tool.finish');
      const dashboard = await fetch(`${baseUrl}/dashboard/agents/agent-test/traces/${traceId}`);
      assert.equal(dashboard.status, 200);
      const html = await dashboard.text();
      assert.ok(html.includes('待确认'));
      assert.ok(html.includes(trace.events[0].raw_json.event));
      assert.ok(html.includes(`事件 ID ${trace.events[0].event_id}`));
    }
    assert.equal(enqueued.length, 0, 'low-risk traces do not notify');

    // A real late terminal event must reopen, re-review and become visible everywhere.
    const failed = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({ ts: '2026-07-08T10:01:00.000Z',
        trace_id: aliasTraceId, event: 'run.failed', status: 'INTERNAL',
        span_id: 'terminal', agent_result: '最终执行失败', result_summary: 'terminal failure' })),
    });
    assert.equal(failed.status, 202);
    assert.equal((await failed.json()).accepted, 1);
    assert.equal(await waitFor(() => db.prepare('SELECT review_version FROM audit_traces WHERE trace_id=?').get(aliasTraceId)?.review_version === 2), true);
    const revised = await getTrace(aliasTraceId);
    assert.equal(revised.audit_result.risk_level, 'high');
    assert.equal(revised.audit_result.trace_status, 'failed');
    assert.equal(revised.agent_result, '最终执行失败');
    assert.equal(revised.events.length, 2, 'late revision retains original evidence');
    assert.equal(await waitFor(() => enqueued.length === 1), true);
    assert.equal(enqueued[0].type, 'audit_trace_high_risk');
    assert.ok(JSON.stringify(enqueued[0].payload).includes(`/dashboard/agents/agent-test/traces/${aliasTraceId}`));
    const detail = await fetch(`${baseUrl}/dashboard/agents/agent-test/traces/${aliasTraceId}`);
    assert.equal(detail.status, 200);
    assert.ok((await detail.text()).includes('需要介入'));
    const callsBefore = capturedPayloads.length;
    const repeat = await fetch(`${baseUrl}/v1/audit-reviews/run`, { method: 'POST', headers: auth });
    assert.equal(repeat.status, 202);
    assert.equal(capturedPayloads.length, callsBefore, 'unchanged Trace is not reviewed twice');
    assert.equal(enqueued.length, 1, 'repeated scheduling must not enqueue another high-risk notification');
  } finally {
    scheduler.stop();
    await new Promise((resolve) => app.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /v1/ingest triggers an audit review only when a batch is accepted', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-ingest-trigger-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = openDb(dbPath);
  ensureRuntimeSchema(db);
  ensureReviewSchema(db);

  const triggerCalls = [];
  const app = createHttpApp({
    db,
    config: {
      dbPath,
      ingest: {
        http: {
          enabled: true,
          maxBodyBytes: 1024 * 1024,
          maxLineBytes: 64 * 1024,
        },
        spoolDir: path.join(tmpDir, 'incoming'),
      },
    },
    scheduler: {
      runAfterIngest() {
        triggerCalls.push(Date.now());
        return Promise.resolve({ status: 'completed' });
      },
    },
  });

  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const { port } = app.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const acceptedResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeUpstreamEvent({
        ts: '2026-07-10T08:15:38.000Z',
        trace_id: 'trace-trigger-review',
      })),
    });
    assert.equal(acceptedResponse.status, 202);
    assert.deepEqual(await acceptedResponse.json(), { accepted: 1, rejected: 0, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(triggerCalls.length, 1);

    const rejectedResponse = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ts: '2026-07-10T08:15:39.000Z',
        agent_id: 'agent-test',
        trace_id: 'trace-rejected',
      }),
    });
    assert.equal(rejectedResponse.status, 202);
    const rejectedBody = await rejectedResponse.json();
    assert.equal(rejectedBody.accepted, 0);
    assert.equal(rejectedBody.rejected, 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(triggerCalls.length, 1);
  } finally {
    app.close();
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
