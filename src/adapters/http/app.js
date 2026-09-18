// src/adapters/http/app.js
import http from 'http';
import fs from 'fs';
import { renderDashboard } from '../../auditReview/dashboardTemplate.js';
import { handleIngestRoute, isHttpIngestEnabled } from './ingestRoute.js';
import { readTracePage, traceHealth } from '../../auditReview/traceReadService.js';
import { renderApiTokenDrawer, renderApiTokenLauncher } from '../../auditReview/apiTokenTemplate.js';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function positiveInteger(value, defaultValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
  return Math.floor(parsed);
}

function maxBodyBytes(config = {}) {
  return positiveInteger(config.limits?.maxBodyBytes, DEFAULT_MAX_BODY_BYTES);
}


function dbWritableProbe(db) {
  try {
    db.exec('BEGIN IMMEDIATE; ROLLBACK;');
    return { writable: true };
  } catch (error) {
    return { writable: false, error: error.message };
  }
}

function isMissingTableError(error) {
  return /no such table/i.test(error?.message ?? '');
}

function latestReview(db) {
  try {
    return db.prepare(`
      SELECT review_id, status, started_at, finished_at
      FROM audit_review_runs
      ORDER BY COALESCE(finished_at, started_at) DESC
      LIMIT 1
    `).get() ?? null;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    return { error: error.message };
  }
}

function traceHealthStatus(db, config, at, retentionService) {
  try {
    const metrics = traceHealth(db, { now: at, maxInvalidOutputRetries: config.auditReview?.traceReview?.maxInvalidOutputRetries ?? 2 });
    return metrics ? { ...metrics, review_failed_pending_cleanup:
      retentionService?.countFailedTracesPendingCleanup?.() ?? null } : null;
  } catch (error) {
    return { error: error.message };
  }
}

function outboxCounts(db) {
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN delivery_status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN delivery_status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letter
      FROM agent_outbox_events
    `).get();
    return {
      pending: row?.pending ?? 0,
      dead_letter: row?.dead_letter ?? 0,
    };
  } catch (error) {
    if (isMissingTableError(error)) return { pending: 0, dead_letter: 0 };
    return { pending: null, dead_letter: null, error: error.message };
  }
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    return null;
  }
}

function diskUsageEstimate(dbPath) {
  const dbBytes = safeFileSize(dbPath);
  const walBytes = safeFileSize(`${dbPath}-wal`);
  const shmBytes = safeFileSize(`${dbPath}-shm`);
  const sizes = [dbBytes, walBytes, shmBytes];
  const total = sizes.every((size) => typeof size === 'number')
    ? sizes.reduce((sum, size) => sum + size, 0)
    : null;
  return {
    db_bytes: dbBytes,
    wal_bytes: walBytes,
    shm_bytes: shmBytes,
    total_bytes: total,
  };
}

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

// Response helper for audit-review routes: applies CORS headers from dashboardAuth
// and supports bearer-token authorization. Used by the new /v1/audit-* and /dashboard routes.
function auditJson(res, status, data, corsHeaders) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  Object.assign(headers, corsHeaders ?? {});
  res.writeHead(status, headers);
  res.end(JSON.stringify(data));
}

function sendHtml(res, status, body, corsHeaders) {
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
  };
  Object.assign(headers, corsHeaders ?? {});
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    location,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end();
}

// Map dashboardAuth authorize failures to HTTP status + body.
function mapAuthFailure(authResult) {
  if (authResult.ok) return null;
  const status = authResult.status ?? 401;
  const code = authResult.code ?? 'unauthorized';
  return { status, body: { error_code: code, error: 'Unauthorized' } };
}

function parseUrl(req) {
  return new URL(req.url, 'http://127.0.0.1');
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function safeIso(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function safeScheduleHours(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(Number)
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

function safeTimezoneOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -1440 || parsed > 1440) return null;
  return Math.trunc(parsed);
}

function safeDigestSlot(value) {
  if (!value || typeof value !== 'object') return null;
  const slotHour = Number(value.slot_hour ?? value.slotHour);
  const attempts = Number(value.attempts);
  const enqueuedCount = Number(value.enqueued_count ?? value.enqueuedCount);
  return {
    slot_key: typeof (value.slot_key ?? value.slotKey) === 'string' ? (value.slot_key ?? value.slotKey) : null,
    report_date: typeof (value.report_date ?? value.reportDate) === 'string' ? (value.report_date ?? value.reportDate) : null,
    slot_hour: Number.isInteger(slotHour) ? slotHour : null,
    scheduled_for: safeIso(value.scheduled_for ?? value.scheduledFor),
    timezone_offset_minutes: safeTimezoneOffset(value.timezone_offset_minutes ?? value.timezoneOffsetMinutes),
    trigger_type: ['scheduled', 'catch_up'].includes(value.trigger_type ?? value.triggerType)
      ? (value.trigger_type ?? value.triggerType)
      : null,
    status: typeof value.status === 'string' ? value.status : null,
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : null,
    enqueued_count: Number.isInteger(enqueuedCount) && enqueuedCount >= 0 ? enqueuedCount : null,
    started_at: safeIso(value.started_at ?? value.startedAt),
    completed_at: safeIso(value.completed_at ?? value.completedAt),
  };
}

function latestDailyDigestDelivery(db, timezoneOffsetMinutes, lastSlot) {
  const empty = {
    delivery_slot_key: lastSlot?.slot_key ?? null,
    last_enqueued_at: null,
    last_delivered_at: null,
    delivery_lag_ms: null,
  };
  try {
    let runId = null;
    let scheduledAt = safeIso(lastSlot?.scheduled_for);
    if (lastSlot?.slot_key) {
      if (lastSlot.status !== 'enqueued') return empty;
      if (lastSlot.report_date && Number.isInteger(lastSlot.slot_hour)) {
        runId = `daily_${lastSlot.report_date}_${lastSlot.slot_hour}`;
      }
    } else {
      runId = db.prepare(`
        SELECT run_id
        FROM agent_outbox_events
        WHERE type = 'audit_daily_trace_report'
          AND delivery_mode = 'feishu_bot'
        GROUP BY run_id
        ORDER BY MAX(created_at) DESC
        LIMIT 1
      `).get()?.run_id ?? null;
    }
    if (!runId) return empty;

    const row = db.prepare(`
      SELECT
        events.run_id,
        MAX(events.created_at) AS last_enqueued_at,
        CASE
          WHEN SUM(CASE
            WHEN events.delivery_status = 'delivered' AND events.delivered_at IS NOT NULL THEN 0
            ELSE 1
          END) = 0
          THEN MAX(events.delivered_at)
          ELSE NULL
        END AS last_delivered_at
      FROM agent_outbox_events AS events
      WHERE events.run_id = @run_id
        AND events.type = 'audit_daily_trace_report'
        AND events.delivery_mode = 'feishu_bot'
      GROUP BY events.run_id
    `).get({ run_id: runId });
    if (!row) return empty;

    const lastEnqueuedAt = safeIso(row.last_enqueued_at);
    const lastDeliveredAt = safeIso(row.last_delivered_at);
    const runMatch = /^daily_(\d{4})-(\d{2})-(\d{2})_(\d{1,2})$/.exec(runId);
    let deliveryLagMs = null;
    if (!scheduledAt && runMatch && timezoneOffsetMinutes !== null) {
      const [, year, month, day, hour] = runMatch;
      scheduledAt = new Date(Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
      ) - timezoneOffsetMinutes * 60 * 1000).toISOString();
    }
    if (lastDeliveredAt && scheduledAt) {
      deliveryLagMs = Date.parse(lastDeliveredAt) - Date.parse(scheduledAt);
    }

    return {
      delivery_slot_key: lastSlot?.slot_key ?? runId.replace(/^daily_/, 'daily:').replace(/_(\d{1,2})$/, ':$1'),
      last_enqueued_at: lastEnqueuedAt,
      last_delivered_at: lastDeliveredAt,
      delivery_lag_ms: Number.isFinite(deliveryLagMs) ? deliveryLagMs : null,
    };
  } catch (error) {
    if (isMissingTableError(error)) return empty;
    return empty;
  }
}

function notificationDigestHealth(notificationDigestScheduler, db) {
  if (typeof notificationDigestScheduler?.getHealthStatus !== 'function') return null;

  let source;
  let statusError = false;
  try {
    source = notificationDigestScheduler.getHealthStatus() ?? {};
  } catch {
    source = {};
    statusError = true;
  }

  const timezoneOffsetMinutes = safeTimezoneOffset(firstDefined(
    source.timezone_offset_minutes,
    source.timezoneOffsetMinutes,
  ));
  const lastSlot = safeDigestSlot(firstDefined(source.last_slot, source.lastSlot));
  const schedulerState = {
    status_error: statusError,
    feishu_mode: ['disabled', 'dry-run', 'live'].includes(firstDefined(source.feishu_mode, source.feishuMode, source.mode))
      ? firstDefined(source.feishu_mode, source.feishuMode, source.mode)
      : 'disabled',
    configured_enabled: Boolean(firstDefined(source.configured_enabled, source.configuredEnabled, source.enabled, false)),
    scheduler_started: Boolean(firstDefined(source.scheduler_started, source.schedulerStarted, source.started, false)),
    active: Boolean(source.active),
    timezone: typeof source.timezone === 'string' ? source.timezone : null,
    timezone_offset_minutes: timezoneOffsetMinutes,
    schedule_hours: safeScheduleHours(firstDefined(source.schedule_hours, source.scheduleHours, source.hours)),
    catch_up_window_minutes: Number.isInteger(Number(firstDefined(
      source.catch_up_window_minutes,
      source.catchUpWindowMinutes,
    ))) && Number(firstDefined(source.catch_up_window_minutes, source.catchUpWindowMinutes)) >= 0
      ? Number(firstDefined(source.catch_up_window_minutes, source.catchUpWindowMinutes))
      : null,
    next_run_at_utc: safeIso(firstDefined(source.next_run_at_utc, source.nextRunAtUtc)),
    next_run_at_local: safeIso(firstDefined(source.next_run_at_local, source.nextRunAtLocal)),
    last_slot: lastSlot,
  };

  return {
    ...schedulerState,
    ...latestDailyDigestDelivery(db, timezoneOffsetMinutes, lastSlot),
  };
}

function optionalSearchParam(url, name) {
  return url.searchParams.get(name) || undefined;
}

function taskWorkbenchFilters(url) {
  return Object.fromEntries(['q', 'agent_id', 'requester', 'requester_id', 'state', 'sort', 'page']
    .filter((key) => url.searchParams.has(key))
    .map((key) => [key, url.searchParams.get(key)]));
}

function dashboardSortParam(url) {
  const value = optionalSearchParam(url, 'sort');
  return value === 'time_desc' || value === 'severity_desc' ? value : undefined;
}

function dashboardLogPageParam(url) {
  const value = optionalSearchParam(url, 'log_page');
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const MANUAL_DAILY_REPORT_PATH = '/dashboard/daily-report/send';

const DAILY_REPORT_NOTICES = {
  daily_report_sent: { tone: 'success', title: '日报已发送' },
  daily_report_queued: { tone: 'neutral', title: '日报已进入发送队列' },
  daily_report_duplicate: { tone: 'neutral', title: '本分钟日报已提交，请勿重复操作' },
  daily_report_protected: { tone: 'neutral', title: '临近定时报送时段，请等待自动日报' },
  daily_report_unavailable: { tone: 'critical', title: '飞书通知当前不可用' },
  daily_report_failed: { tone: 'critical', title: '日报发送失败，请稍后重试' },
};

function dailyReportNotice(value) {
  const notice = DAILY_REPORT_NOTICES[value];
  return notice ? [{ ...notice }] : [];
}

function manualSendStatus(notificationDigestScheduler, at) {
  if (typeof notificationDigestScheduler?.getManualSendStatus !== 'function') {
    return { allowed: false, reason: 'unavailable' };
  }
  try {
    return notificationDigestScheduler.getManualSendStatus({ at }) ?? { allowed: false, reason: 'unavailable' };
  } catch {
    return { allowed: false, reason: 'unavailable' };
  }
}

function notificationStatusModel(status = {}) {
  const reason = status.reason;
  if (status.allowed === true || reason === 'allowed' || reason === 'protected_window') {
    return {
      ...status,
      label: '飞书通知正常',
      tone: 'success',
      href: MANUAL_DAILY_REPORT_PATH,
      active: true,
      ...(reason === 'protected_window'
        ? { message: '临近定时报送时段，请等待自动日报。' }
        : {}),
    };
  }
  if (reason === 'dry_run') {
    return {
      ...status,
      label: '飞书通知演练模式',
      tone: 'neutral',
      href: MANUAL_DAILY_REPORT_PATH,
      active: false,
      message: '当前为飞书演练模式，不能发送真实日报。',
    };
  }
  if (reason === 'disabled') {
    return {
      ...status,
      label: '飞书通知未启用',
      tone: 'neutral',
      href: MANUAL_DAILY_REPORT_PATH,
      active: false,
      message: '飞书通知未启用，当前不能发送日报。',
    };
  }
  return {
    ...status,
    label: '飞书通知状态异常',
    tone: 'critical',
    href: MANUAL_DAILY_REPORT_PATH,
    active: false,
    message: '飞书通知状态异常，当前不能发送日报。',
  };
}

function manualDeliveryStatus(db, eventId) {
  if (!eventId) return null;
  try {
    return db.prepare('SELECT delivery_status FROM agent_outbox_events WHERE event_id = ?').get(eventId)?.delivery_status ?? null;
  } catch {
    return null;
  }
}

function noticeForManualResult(result, deliveryStatus) {
  if (result?.reason === 'duplicate') return 'daily_report_duplicate';
  if (result?.reason === 'protected_window') return 'daily_report_protected';
  if (result?.reason === 'disabled' || result?.reason === 'dry_run') return 'daily_report_unavailable';
  if (result?.reason !== 'enqueued' || !result.eventId) return 'daily_report_failed';
  if (deliveryStatus === 'delivered') return 'daily_report_sent';
  if (deliveryStatus === 'pending' || deliveryStatus == null) return 'daily_report_queued';
  return 'daily_report_failed';
}

function decorateOverviewPage(page, { status, notice } = {}) {
  if (!page || typeof page !== 'object') return page;
  const notices = dailyReportNotice(notice);
  return {
    ...page,
    page: {
      ...(page.page && typeof page.page === 'object' ? page.page : {}),
      notification_status: notificationStatusModel(status),
    },
    ...(notices.length > 0 ? { notices } : {}),
  };
}

function dashboardFindingFilters(url, { includeReviewId = false, includeOverviewControls = false } = {}) {
  const filters = {
    agentId: optionalSearchParam(url, 'agent_id'),
    severity: optionalSearchParam(url, 'severity'),
    category: optionalSearchParam(url, 'category'),
    status: optionalSearchParam(url, 'status'),
  };
  if (includeReviewId) filters.reviewId = optionalSearchParam(url, 'review_id');
  if (includeOverviewControls) {
    filters.sort = dashboardSortParam(url);
    filters.logPage = dashboardLogPageParam(url);
    filters.logEvent = optionalSearchParam(url, 'log_event');
    filters.logToolName = optionalSearchParam(url, 'log_tool_name');
    filters.logTraceId = optionalSearchParam(url, 'log_trace_id');
    filters.logStatus = optionalSearchParam(url, 'log_status');
  }
  return filters;
}

function mapRuntimeError(error) {
  const code = error?.code;
  if (code === 'body_too_large') return { status: 413, body: { error_code: 'payload_too_large', error: error.message } };
  return { status: 500, body: { error_code: 'internal_error', error: 'Internal server error' } };
}

function mapFindingActionError(error) {
  const code = error?.code;
  if (error instanceof SyntaxError) return { status: 400, body: { error_code: 'invalid_finding_action', error: 'Request body must be valid JSON' } };
  if (code === 'invalid_finding_action') return { status: 400, body: { error_code: code, error: error.message } };
  if (code === 'finding_not_found') return { status: 404, body: { error_code: code, error: error.message } };
  if (code === 'finding_state_conflict' || code === 'finding_version_conflict') {
    return { status: 409, body: { error_code: code, error: error.message } };
  }
  if (code === 'finding_lifecycle_unavailable') return { status: 503, body: { error_code: code, error: error.message } };
  return { status: 500, body: { error_code: 'internal_error', error: 'Internal server error' } };
}

async function readForm(req, limitBytes = DEFAULT_MAX_BODY_BYTES) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    const error = new Error('Request body exceeds maxBodyBytes');
    error.code = 'body_too_large';
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error('Request body exceeds maxBodyBytes');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf-8')));
}

function findingActionInput(body = {}) {
  const rawVersion = body.expected_state_version ?? body.expectedStateVersion;
  const expectedStateVersion = typeof rawVersion === 'string' && /^\d+$/.test(rawVersion)
    ? Number(rawVersion)
    : rawVersion;
  return {
    action: body.action,
    actor: body.actor,
    note: body.note,
    snoozedUntil: body.snoozed_until ?? body.snoozedUntil,
    expectedStateVersion,
  };
}

async function performFindingAction(findingLifecycleService, findingId, input) {
  const handler = findingLifecycleService?.performAction
    ?? findingLifecycleService?.applyAction
    ?? findingLifecycleService?.executeAction
    ?? findingLifecycleService?.transitionFinding;
  if (typeof handler !== 'function') {
    const error = new Error('Finding lifecycle service is unavailable');
    error.code = 'finding_lifecycle_unavailable';
    throw error;
  }
  return handler.call(findingLifecycleService, { findingId, ...input });
}

export function createHttpApp({ db, config, apiTokenService, scheduler, reviewStore, visualization, dashboardAuth, findingLifecycleService, toolSemanticMapper, retentionService, notificationDigestScheduler, flushNotifications, now = () => new Date() } = {}) {
  let activeTraceExports = 0;
  const exportConcurrency = positiveInteger(config?.auditReview?.http?.maxConcurrentTraceExports, 2);
  const exportMaxBytes = positiveInteger(config?.auditReview?.http?.maxTraceResponseBytes, 4 * 1024 * 1024);
  // Helpers for audit-review routes. These are optional — if not provided
  // (e.g. in the existing runs-api test), the new routes return 503.
  const hasReviewDeps = !!(scheduler && reviewStore && visualization && dashboardAuth);
  function reviewCors(req) {
    if (!dashboardAuth) return {};
    const origin = req.headers.origin;
    return dashboardAuth.corsHeaders(origin);
  }
  return http.createServer(async (req, res) => {
    const url = parseUrl(req);
    let method = req.method;
    let createdToken;
    let tokenError;
    let openTokens = false;
    function html(response, status, body, corsHeaders) {
      if (apiTokenService && status === 200) {
        const drawer = renderApiTokenDrawer({ accounts: apiTokenService.list(), records: apiTokenService.recent(), token: createdToken, error: tokenError, open: openTokens, returnTo: url.pathname + url.search });
        body = body.replace('</header>', renderApiTokenLauncher() + '</header>');
        body = body.includes('</body>') ? body.replace('</body>', drawer + '</body>') : body + drawer;
      }
      sendHtml(response, status, body, corsHeaders);
    }

    if (method === 'OPTIONS') {
      if (url.pathname === '/v1/audit-logs') {
        auditJson(res, 204, {}, reviewCors(req));
        return;
      }
      json(res, 204, {});
      return;
    }

    try {
      if (apiTokenService && method === 'POST' && (url.pathname === '/dashboard/api-tokens' || /^\/dashboard\/api-tokens\/[^/]+\/(revoke|restore|delete)$/.test(url.pathname))) {
        const form = await readForm(req, maxBodyBytes(config));
        try {
          if (url.pathname === '/dashboard/api-tokens') createdToken = apiTokenService.create(form.name).token;
          else {
            const [, , , id, action] = url.pathname.split('/');
            const handler = { revoke: 'revoke', restore: 'restore', delete: 'remove' }[action];
            if (!apiTokenService[handler](id)) tokenError = 'Token 不存在或已删除';
          }
        } catch (error) {
          if (error.status !== 400) throw error;
          tokenError = error.message;
        }
        openTokens = true;
        const returnUrl = new URL(form.return_to || '/dashboard', 'http://127.0.0.1');
        const allowedReturn = returnUrl.origin === 'http://127.0.0.1' && (['/', '/tasks', '/dashboard'].includes(returnUrl.pathname) || /^\/dashboard\/agents\//.test(returnUrl.pathname));
        url.pathname = allowedReturn ? returnUrl.pathname : '/dashboard';
        url.search = allowedReturn ? returnUrl.search : '';
        method = 'GET';
      }
      if (method === 'GET' && url.pathname === '/v1/audit-logs') {
        const cors = reviewCors(req);
        const started = performance.now();
        const auth = apiTokenService ? apiTokenService.authenticate(req) : dashboardAuth?.authorizeApi(req);
        const reply = (status, data) => {
          apiTokenService?.record({ accountId: auth?.accountId ?? null, searchParams: url.searchParams, status, count: data.count ?? 0, durationMs: performance.now() - started });
          auditJson(res, status, data, cors);
        };
        if (!apiTokenService && !dashboardAuth?.token()) {
          auditJson(res, 503, { error_code: 'auth_not_configured', error: 'Audit export authentication is not configured' }, cors);
          return;
        }
        if (!auth?.ok) {
          reply(401, { error_code: 'unauthorized', error: 'Unauthorized' });
          return;
        }
        if (activeTraceExports >= exportConcurrency) {
          reply(429, { error_code: 'rate_limited', error: 'Too many concurrent trace exports' });
          return;
        }
        activeTraceExports += 1;
        let released = false;
        const release = () => { if (!released) { released = true; activeTraceExports -= 1; } };
        res.once('finish', release);
        res.once('close', release);
        try {
          // Yield so simultaneous requests observe the independent export concurrency budget.
          await new Promise((resolve) => setImmediate(resolve));
          reply(200, readTracePage(db, url.searchParams, { maxResponseBytes: exportMaxBytes }));
        } catch (error) {
          reply(error.status ?? 500, { error_code: error.code ?? 'internal_error', error: error.message });
        }
        return;
      }
      // ===================== Dashboard Pages (v1.4) =====================
      const taskDashboardMatch = url.pathname.match(/^\/dashboard\/agents\/([^/]+)(?:\/(traces|requesters)\/([^/]+))?\/?$/);
      if (hasReviewDeps && method === 'GET' && taskDashboardMatch) {
        const cors = reviewCors(req);
        const fail = mapAuthFailure(dashboardAuth.authorizeDashboard(req));
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        let agentId;
        let childId;
        try {
          agentId = decodeURIComponent(taskDashboardMatch[1]);
          childId = taskDashboardMatch[3] === undefined ? undefined : decodeURIComponent(taskDashboardMatch[3]);
        } catch {
          html(res, 400, '<h1>Invalid path encoding</h1>', cors);
          return;
        }
        const kind = taskDashboardMatch[2];
        const method = kind === 'traces' ? 'traceDetailPage' : kind === 'requesters' ? 'requesterTasksPage' : 'agentPage';
        if (typeof visualization[method] !== 'function') {
          html(res, 503, '<h1>Task dashboard unavailable</h1>', cors);
          return;
        }
        const filters = taskWorkbenchFilters(url);
        const page = kind === 'traces' ? visualization.traceDetailPage(agentId, childId, filters)
          : kind === 'requesters' ? visualization.requesterTasksPage(agentId, childId, {
            ...filters,
            page: optionalSearchParam(url, 'page'),
          }) : visualization.agentPage(agentId, {
            ...filters,
            search: url.searchParams.get('q') ?? '',
            groups: optionalSearchParam(url, 'groups'),
            expand: url.searchParams.get('expand') ?? undefined,
            requesterId: url.searchParams.has('requester_id') ? url.searchParams.get('requester_id') : undefined,
            page: optionalSearchParam(url, 'page'),
          });
        if (!page) { html(res, 404, '<h1>Task not found</h1>', cors); return; }
        html(res, 200, renderDashboard(page), cors);
        return;
      }
      if (hasReviewDeps && method === 'GET' && (url.pathname === '/tasks' || url.pathname === '/tasks/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const page = typeof visualization.agentIndexPage === 'function'
          ? visualization.agentIndexPage(taskWorkbenchFilters(url))
          : visualization.overviewPage();
        html(res, 200, renderDashboard(page), cors);
        return;
      }
      if (hasReviewDeps && method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const page = typeof visualization.dataDashboardPage === 'function'
          ? visualization.dataDashboardPage({ range: optionalSearchParam(url, 'range') })
          : visualization.overviewPage();
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && method === 'GET' && url.pathname === MANUAL_DAILY_REPORT_PATH) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        if (typeof visualization.manualDailyReportPage !== 'function') {
          html(res, 503, '<h1>Daily report page unavailable</h1>', cors);
          return;
        }
        const at = now();
        const status = notificationStatusModel(manualSendStatus(notificationDigestScheduler, at));
        const page = visualization.manualDailyReportPage({ status });
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && method === 'POST' && url.pathname === MANUAL_DAILY_REPORT_PATH) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }

        let notice = 'daily_report_failed';
        try {
          await readForm(req, maxBodyBytes(config));
          if (typeof notificationDigestScheduler?.runManual !== 'function') {
            notice = 'daily_report_unavailable';
          } else {
            const result = await notificationDigestScheduler.runManual({ generatedAt: now() });
            if (result?.reason === 'enqueued' && result.eventId) {
              try {
                if (typeof flushNotifications === 'function') await flushNotifications();
              } catch {
                // The Outbox keeps the event pending for the normal retry loop.
              }
            }
            notice = noticeForManualResult(result, manualDeliveryStatus(db, result?.eventId));
          }
        } catch {
          notice = 'daily_report_failed';
        }
        redirect(res, `/dashboard?notice=${encodeURIComponent(notice)}`);
        return;
      }

      if (hasReviewDeps && method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const filters = dashboardFindingFilters(url, {
          includeReviewId: true,
          includeOverviewControls: true,
        });
        const page = decorateOverviewPage(visualization.overviewPage(filters), {
          status: manualSendStatus(notificationDigestScheduler, now()),
          notice: optionalSearchParam(url, 'notice'),
        });
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      const dashboardFindingActionMatch = url.pathname.match(/^\/dashboard\/audit-findings\/([^/]+)\/actions$/);
      if (hasReviewDeps && method === 'POST' && dashboardFindingActionMatch) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const findingId = decodeURIComponent(dashboardFindingActionMatch[1]);
        let notice = 'action_success';
        let action = '';
        try {
          const body = await readForm(req, maxBodyBytes(config));
          action = body.action ?? '';
          await performFindingAction(findingLifecycleService, findingId, findingActionInput(body));
        } catch (error) {
          notice = error?.code ?? 'internal_error';
        }
        const params = new URLSearchParams({ notice });
        if (action) params.set('action', action);
        redirect(res, `/dashboard/audit-findings/${encodeURIComponent(findingId)}?${params}`);
        return;
      }

      if (hasReviewDeps && method === 'GET' && url.pathname.startsWith('/dashboard/audit-reviews/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const reviewId = decodeURIComponent(url.pathname.split('/').pop());
        const run = reviewStore.getRun(reviewId);
        if (!run) { html(res, 404, '<h1>Review not found</h1>', cors); return; }
        const filters = dashboardFindingFilters(url);
        const page = visualization.reviewDetailPage(reviewId, filters);
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (hasReviewDeps && method === 'GET' && url.pathname.startsWith('/dashboard/audit-findings/')) {
        const cors = reviewCors(req);
        const auth = dashboardAuth.authorizeDashboard(req);
        const fail = mapAuthFailure(auth);
        if (fail) { html(res, fail.status, `<h1>${fail.body.error}</h1>`, cors); return; }
        const findingId = decodeURIComponent(url.pathname.split('/').pop());
        const finding = reviewStore.getFinding(findingId);
        if (!finding) { html(res, 404, '<h1>Finding not found</h1>', cors); return; }
        const pageOptions = {
          notice: optionalSearchParam(url, 'notice'),
          action: optionalSearchParam(url, 'action'),
        };
        const page = typeof visualization.findingDetailPageWithAnalysis === 'function'
          ? await visualization.findingDetailPageWithAnalysis(findingId, pageOptions)
          : visualization.findingDetailPage(findingId, pageOptions);
        html(res, 200, renderDashboard(page), cors);
        return;
      }

      if (method === 'GET' && url.pathname === '/health') {
        const dbProbe = dbWritableProbe(db);
        const status = dbProbe.writable ? 'ok' : 'error';
        json(res, dbProbe.writable ? 200 : 503, {
          status,
          checked_at: now().toISOString(),
          dbPath: config.dbPath,
          db: dbProbe,
          latest_review: latestReview(db),
          traces: traceHealthStatus(db, config, now(), retentionService),
          outbox: outboxCounts(db),
          notification_digest: notificationDigestHealth(notificationDigestScheduler, db),
          disk: diskUsageEstimate(config.dbPath),
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/v1/ingest' && isHttpIngestEnabled(config)) {
        await handleIngestRoute(req, res, {
          config,
          db,
          toolSemanticMapper,
          onAcceptedBatch: () => {
            if (typeof retentionService?.pruneAuditEvents === 'function') {
              try {
                retentionService.pruneAuditEvents();
              } catch {
                // Retention failures must not block review scheduling.
              }
            }
            if (typeof scheduler?.runAfterIngest === 'function') {
              return scheduler.runAfterIngest();
            }
            return undefined;
          },
        });
        return;
      }

      json(res, 404, { error_code: 'not_found', error: 'Not found' });
    } catch (error) {
      const mapped = mapRuntimeError(error);
      json(res, mapped.status, mapped.body);
    }
  });
}
