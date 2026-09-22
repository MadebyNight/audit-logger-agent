import crypto from 'crypto';
import { buildDailyReportPayloads } from './feishuCards.js';

const DEFAULT_HOURS = [10, 17];
const DEFAULT_TIMEZONE_OFFSET_MINUTES = 480;
const DEFAULT_CATCH_UP_WINDOW_MINUTES = 30;
const SLOT_LEASE_MS = 10 * 60 * 1000;
const DAILY_REPORT_PRIORITY = 100;
const SLOT_RETRY_BASE_MS = 2 * 1000;
const SLOT_RETRY_MAX_MS = 5 * 60 * 1000;
const ON_TIME_THRESHOLD_MS = 10 * 1000;
const MANUAL_PROTECTED_WINDOW_MS = 5 * 60 * 1000;

function normalizedHours(value) {
  const hours = (Array.isArray(value) ? value : DEFAULT_HOURS)
    .map(Number)
    .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

function normalizedOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < -1440 || parsed > 1440) {
    return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  }
  return Math.trunc(parsed);
}

function configuredOffset(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEZONE_OFFSET_MINUTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < -1440 || parsed > 1440) {
    throw new Error('Daily report timezone offset must be an integer between -1440 and 1440');
  }
  return parsed;
}

function normalizedCatchUpWindow(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CATCH_UP_WINDOW_MINUTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error('Daily report catch-up window must be a non-negative integer');
  }
  return parsed;
}

function shiftedDate(now, offsetMinutes) {
  return new Date(now.getTime() + offsetMinutes * 60 * 1000);
}

function localParts(now, offsetMinutes) {
  const shifted = shiftedDate(now, offsetMinutes);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    date: shifted.toISOString().slice(0, 10),
  };
}

function localTimeToUtc({ year, month, day, hour }, offsetMinutes) {
  return new Date(Date.UTC(year, month, day, hour, 0, 0, 0) - offsetMinutes * 60 * 1000);
}

function offsetLabel(offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

function localIso(date, offsetMinutes) {
  const shifted = shiftedDate(date, offsetMinutes).toISOString().replace(/Z$/, '');
  return `${shifted}${offsetLabel(offsetMinutes).slice(3)}`;
}

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}

function manualMinuteKey(date, offsetMinutes) {
  return shiftedDate(date, offsetMinutes).toISOString().slice(0, 16).replace('T', ':');
}

export function latestDailyReportSlotAt(now = new Date(), {
  hours = DEFAULT_HOURS,
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
} = {}) {
  const scheduleHours = normalizedHours(hours);
  if (scheduleHours.length === 0) throw new Error('Daily report schedule requires at least one valid hour');
  const offset = normalizedOffset(timezoneOffsetMinutes);
  const local = localParts(now, offset);
  const candidates = scheduleHours
    .map((hour) => ({ hour, scheduledFor: localTimeToUtc({ ...local, hour }, offset) }))
    .filter(({ scheduledFor }) => scheduledFor.getTime() <= now.getTime());
  if (candidates.length > 0) return candidates[candidates.length - 1];

  const yesterday = new Date(Date.UTC(local.year, local.month, local.day - 1));
  const hour = scheduleHours[scheduleHours.length - 1];
  return {
    hour,
    scheduledFor: localTimeToUtc({
      year: yesterday.getUTCFullYear(),
      month: yesterday.getUTCMonth(),
      day: yesterday.getUTCDate(),
      hour,
    }, offset),
  };
}

export function nextDailyReportAt(now = new Date(), {
  hours = DEFAULT_HOURS,
  timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES,
} = {}) {
  const scheduleHours = normalizedHours(hours);
  if (scheduleHours.length === 0) throw new Error('Daily report schedule requires at least one valid hour');
  const offset = normalizedOffset(timezoneOffsetMinutes);
  const local = localParts(now, offset);
  for (const hour of scheduleHours) {
    const candidate = localTimeToUtc({ ...local, hour }, offset);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const tomorrow = new Date(Date.UTC(local.year, local.month, local.day + 1));
  return localTimeToUtc({
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth(),
    day: tomorrow.getUTCDate(),
    hour: scheduleHours[0],
  }, offset);
}

export function dailyReportWindow(now = new Date(), timezoneOffsetMinutes = DEFAULT_TIMEZONE_OFFSET_MINUTES) {
  const offset = normalizedOffset(timezoneOffsetMinutes);
  const local = localParts(now, offset);
  return {
    date: local.date,
    from: localTimeToUtc({ ...local, hour: 0 }, offset).toISOString(),
    to: now.toISOString(),
    slotHour: local.hour,
  };
}

function dailyDashboardUrl(config) {
  const visualization = config?.auditReview?.visualization ?? {};
  const baseUrl = typeof visualization.baseUrl === 'string' ? visualization.baseUrl.trim() : '';
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/$/, '')}/`;
}

function loadDailySummary(db, { from, to }) {
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS event_count,
      SUM(CASE WHEN status <> 'OK' THEN 1 ELSE 0 END) AS error_count,
      COUNT(DISTINCT CASE WHEN agent_id IS NOT NULL AND agent_id <> '' THEN agent_id END) AS agent_count,
      COUNT(DISTINCT tool_name) AS tool_count,
      MIN(ts) AS first_event_at,
      MAX(ts) AS last_event_at
    FROM audit_events
    WHERE ts >= @from AND ts <= @to
  `).get({ from, to });

  const tools = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) AS total,
      SUM(CASE WHEN status <> 'OK' THEN 1 ELSE 0 END) AS error_count
    FROM audit_events
    WHERE ts >= @from AND ts <= @to
    GROUP BY tool_name
    ORDER BY error_count DESC, total DESC, tool_name ASC
    LIMIT 5
  `).all({ from, to });

  // Match the Dashboard's task time axis; each composite Trace key counts once.
  const traces = db.prepare(`
    SELECT COUNT(*) AS trace_count,
      COUNT(DISTINCT agent_id) AS agent_count,
      COUNT(DISTINCT NULLIF(TRIM(requester_id), '')) AS requester_count,
      SUM(CASE WHEN sealed_at IS NOT NULL AND review_version > 0 THEN 1 ELSE 0 END) AS reviewed_trace_count
    FROM audit_traces WHERE last_event_at >= @from AND last_event_at <= @to
  `).get({ from, to });
  const buckets = db.prepare(`
    SELECT trace_status, risk_level, COUNT(*) AS count
    FROM audit_traces
    WHERE last_event_at >= @from AND last_event_at <= @to
      AND sealed_at IS NOT NULL AND review_version > 0
    GROUP BY trace_status, risk_level
  `).all({ from, to });
  const traceStatusCounts = { success: 0, failed: 0, interrupted: 0, incomplete: 0 };
  const riskLevelCounts = { none: 0, low: 0, medium: 0, high: 0 };
  for (const row of buckets) {
    if (Object.hasOwn(traceStatusCounts, row.trace_status)) traceStatusCounts[row.trace_status] += row.count;
    if (Object.hasOwn(riskLevelCounts, row.risk_level)) riskLevelCounts[row.risk_level] += row.count;
  }
  const topRisks = db.prepare(`
    SELECT agent_id, trace_id, requester_id, risk_level, trace_status,
      risk_level AS severity, original_request AS title, risk_reason AS summary,
      last_event_at AS observed_at
    FROM audit_traces
    WHERE last_event_at >= @from AND last_event_at <= @to
      AND sealed_at IS NOT NULL AND review_version > 0 AND risk_level IN ('low', 'medium', 'high')
    ORDER BY CASE risk_level WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
      last_event_at DESC, agent_id, trace_id
    LIMIT 3
  `).all({ from, to });

  const agentSummaries = db.prepare(`
    SELECT agent_id, COUNT(*) AS task_count,
      SUM(CASE WHEN sealed_at IS NOT NULL AND review_version > 0 AND risk_level IN ('low','medium','high') THEN 1 ELSE 0 END) AS risk_count
    FROM audit_traces WHERE last_event_at >= @from AND last_event_at <= @to
    GROUP BY agent_id ORDER BY task_count DESC, agent_id ASC LIMIT 5
  `).all({ from, to });
  const requesterSummaries = db.prepare(`
    SELECT NULLIF(TRIM(requester_id), '') AS requester_id, COUNT(*) AS task_count,
      SUM(CASE WHEN sealed_at IS NOT NULL AND review_version > 0 AND risk_level IN ('low','medium','high') THEN 1 ELSE 0 END) AS risk_count
    FROM audit_traces WHERE last_event_at >= @from AND last_event_at <= @to
    GROUP BY NULLIF(TRIM(requester_id), '') ORDER BY task_count DESC, requester_id ASC LIMIT 5
  `).all({ from, to });

  return {
    scope: 'global',
    event_count: Number(summary?.event_count) || 0,
    error_count: Number(summary?.error_count) || 0,
    agent_count: Number(traces?.agent_count) || 0,
    requester_count: Number(traces?.requester_count) || 0,
    agents: agentSummaries,
    requesters: requesterSummaries,
    trace_count: Number(traces?.trace_count) || 0,
    tool_count: Number(summary?.tool_count) || 0,
    reviewed_trace_count: Number(traces?.reviewed_trace_count) || 0,
    trace_status_counts: traceStatusCounts,
    risk_level_counts: riskLevelCounts,
    high_risk_count: riskLevelCounts.high,
    critical_count: 0, // Deprecated compatibility field; never a Trace risk bucket.
    first_event_at: summary?.first_event_at ?? null,
    last_event_at: summary?.last_event_at ?? null,
    tools,
    top_risks: topRisks,
    findings: topRisks, // Legacy daily-summary consumers.
  };
}

function dedupeKey(values) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
  return `feishu_daily:${digest}`;
}

export function createNotificationDigestScheduler({
  db,
  outboxStore,
  config,
  feishuMode = 'disabled',
  now = () => new Date(),
  ownerId = `digest_${crypto.randomUUID()}`,
  slotLeaseMs = SLOT_LEASE_MS,
  onEnqueued,
  timerApi = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  },
} = {}) {
  if (!db) throw new Error('createNotificationDigestScheduler: db is required');
  if (!outboxStore) throw new Error('createNotificationDigestScheduler: outboxStore is required');
  if (typeof now !== 'function') throw new Error('createNotificationDigestScheduler: now must be a function');
  if (!['disabled', 'dry-run', 'live'].includes(feishuMode)) {
    throw new Error('createNotificationDigestScheduler: invalid Feishu mode');
  }
  if (typeof ownerId !== 'string' || ownerId.length === 0) {
    throw new Error('createNotificationDigestScheduler: ownerId must be a non-empty string');
  }
  if (!Number.isFinite(slotLeaseMs) || slotLeaseMs <= 0) {
    throw new Error('Daily report slot lease must be a positive number');
  }
  if (onEnqueued !== undefined && typeof onEnqueued !== 'function') {
    throw new Error('createNotificationDigestScheduler: onEnqueued must be a function');
  }
  const notification = config?.auditReview?.notification ?? {};
  const daily = notification.dailyReport ?? {};
  const enabled = notification.enabled !== false && notification.mode === 'feishu_bot' && daily.enabled !== false;
  const hours = normalizedHours(daily.hours);
  if (hours.length === 0) throw new Error('Daily report schedule requires at least one valid hour');
  const timezoneOffsetMinutes = configuredOffset(daily.timezoneOffsetMinutes ?? config?.report?.timezoneOffsetMinutes);
  const catchUpWindowMinutes = normalizedCatchUpWindow(daily.catchUpWindowMinutes);
  const cardConfig = notification.card ?? {};
  const maxAttempts = notification.maxAttempts;
  const dashboardUrl = dailyDashboardUrl(config);
  let started = false;
  let timer = null;
  let scheduledWakeAt = null;
  let runChain = Promise.resolve();

  const getSlotStmt = db.prepare(`
    SELECT * FROM audit_notification_digest_slots WHERE slot_key = ?
  `);
  const latestSlotStmt = db.prepare(`
    SELECT
      slot_key, report_date, slot_hour, scheduled_for, timezone_offset_minutes, trigger_type,
      status, attempts, enqueued_count, started_at, completed_at
    FROM audit_notification_digest_slots
    ORDER BY scheduled_for DESC
    LIMIT 1
  `);
  const insertRunningSlotStmt = db.prepare(`
    INSERT OR IGNORE INTO audit_notification_digest_slots (
      slot_key, report_date, slot_hour, scheduled_for, timezone_offset_minutes, trigger_type,
      status, attempts, enqueued_count, owner_id, lease_expires_at,
      started_at, completed_at, last_error
    ) VALUES (
      @slot_key, @report_date, @slot_hour, @scheduled_for, @timezone_offset_minutes, @trigger_type,
      'running', 1, 0, @owner_id, @lease_expires_at,
      @started_at, NULL, NULL
    )
  `);
  const reclaimSlotStmt = db.prepare(`
    UPDATE audit_notification_digest_slots
    SET status = 'running',
        trigger_type = @trigger_type,
        attempts = attempts + 1,
        enqueued_count = 0,
        owner_id = @owner_id,
        lease_expires_at = @lease_expires_at,
        started_at = @started_at,
        completed_at = NULL,
        last_error = NULL
    WHERE slot_key = @slot_key
      AND (
        status = 'failed'
        OR (status = 'running' AND lease_expires_at <= @started_at)
      )
  `);
  const completeSlotStmt = db.prepare(`
    UPDATE audit_notification_digest_slots
    SET status = @status,
        enqueued_count = @enqueued_count,
        owner_id = NULL,
        lease_expires_at = NULL,
        completed_at = @completed_at,
        last_error = @last_error
    WHERE slot_key = @slot_key
      AND status = 'running'
      AND owner_id = @owner_id
  `);
  const insertSkippedSlotStmt = db.prepare(`
    INSERT OR IGNORE INTO audit_notification_digest_slots (
      slot_key, report_date, slot_hour, scheduled_for, timezone_offset_minutes, trigger_type,
      status, attempts, enqueued_count, owner_id, lease_expires_at,
      started_at, completed_at, last_error
    ) VALUES (
      @slot_key, @report_date, @slot_hour, @scheduled_for, @timezone_offset_minutes, @trigger_type,
      'skipped_late', 0, 0, NULL, NULL,
      NULL, @completed_at, NULL
    )
  `);
  const updateSkippedSlotStmt = db.prepare(`
    UPDATE audit_notification_digest_slots
    SET status = 'skipped_late',
        owner_id = NULL,
        lease_expires_at = NULL,
        completed_at = @completed_at,
        last_error = NULL
    WHERE slot_key = @slot_key
      AND (
        status = 'failed'
        OR (status = 'running' AND lease_expires_at <= @completed_at)
      )
  `);

  const claimSlot = db.transaction((slot, claimedAt) => {
    const leaseExpiresAt = new Date(claimedAt.getTime() + slotLeaseMs).toISOString();
    const params = {
      ...slot,
      owner_id: ownerId,
      lease_expires_at: leaseExpiresAt,
      started_at: claimedAt.toISOString(),
    };
    const inserted = insertRunningSlotStmt.run(params);
    if (inserted.changes === 1) return { claimed: true, reason: 'new' };

    const existing = getSlotStmt.get(slot.slot_key);
    if (['enqueued', 'empty', 'skipped_late'].includes(existing?.status)) {
      return { claimed: false, reason: 'completed', slot: existing };
    }
    const reclaimed = reclaimSlotStmt.run(params);
    if (reclaimed.changes === 1) return { claimed: true, reason: 'reclaimed' };
    return { claimed: false, reason: 'leased', slot: existing };
  });

  const recordSkippedSlot = db.transaction((slot, completedAt) => {
    const params = { ...slot, completed_at: completedAt.toISOString() };
    const inserted = insertSkippedSlotStmt.run(params);
    if (inserted.changes === 1) return { recorded: true, reason: 'new' };
    const updated = updateSkippedSlotStmt.run(params);
    if (updated.changes === 1) return { recorded: true, reason: 'updated' };
    return { recorded: false, reason: 'existing', slot: getSlotStmt.get(slot.slot_key) };
  });

  function clearTimer() {
    if (timer) timerApi.clearTimeout(timer);
    timer = null;
    scheduledWakeAt = null;
  }

  function scheduleNext(reconcileResult) {
    clearTimer();
    if (!started || !enabled || feishuMode === 'disabled') return;
    const current = now();
    const next = nextDailyReportAt(current, { hours, timezoneOffsetMinutes });
    const retryAt = reconcileResult?.retry_at ? new Date(reconcileResult.retry_at) : null;
    const target = retryAt && Number.isFinite(retryAt.getTime()) && retryAt.getTime() < next.getTime()
      ? retryAt
      : next;
    scheduledWakeAt = target;
    timer = timerApi.setTimeout(() => {
      timer = null;
      scheduledWakeAt = null;
      runChain = runChain.catch(() => {}).then(() => {
        const actual = now();
        if (actual.getTime() < target.getTime()) {
          return { status: 'early_timer', retry_at: target.toISOString() };
        }
        if (feishuMode === 'live') return reconcileDueSlot({ at: actual });
        const latest = latestDailyReportSlotAt(actual, { hours, timezoneOffsetMinutes });
        return runNow({ scheduledFor: latest.scheduledFor });
      });
      runChain.then(
        (result) => { if (started) scheduleNext(result); },
        () => { if (started) scheduleNext(); },
      );
    }, Math.max(0, target.getTime() - current.getTime()));
  }

  function runNow({ scheduledFor = now() } = {}) {
    if (!enabled) return { enqueued: false, reason: 'disabled', groups: [] };
    if (feishuMode === 'disabled') return { enqueued: false, reason: 'disabled', groups: [] };
    const renderedReport = renderReport(scheduledFor);
    const { window, rendered } = renderedReport;
    if (feishuMode === 'dry-run') {
      return {
        enqueued: false,
        enqueuedCount: 0,
        payloadCount: rendered.reduce((sum, item) => sum + item.payloads.length, 0),
        reason: 'dry_run',
        window,
        groups: rendered,
      };
    }

    let enqueuedCount = 0;
    let payloadCount = 0;
    for (const item of rendered) {
      item.payloads.forEach((payload) => {
        payloadCount += 1;
        const result = outboxStore.enqueue({
          runId: `daily_${window.date}_${window.slotHour}`,
          type: 'audit_daily_trace_report',
          payload,
          deliveryMode: 'feishu_bot',
          priority: DAILY_REPORT_PRIORITY,
          callbackUrl: null,
          maxAttempts,
          dedupeKey: dedupeKey([window.date, window.slotHour]),
        });
        if (result?.enqueued !== false) enqueuedCount += 1;
      });
    }
    return { enqueued: enqueuedCount > 0, enqueuedCount, payloadCount, window, groups: rendered };
  }

  function renderReport(generatedAt) {
    const generated = validDate(generatedAt, 'Daily report generation time');
    const window = dailyReportWindow(generated, timezoneOffsetMinutes);
    const summary = loadDailySummary(db, window);
    const group = {
      ...summary,
      highest_severity: summary.risk_level_counts.high > 0 ? 'high' : summary.risk_level_counts.medium > 0 ? 'medium' : summary.risk_level_counts.low > 0 ? 'low' : 'none',
    };
    const payloads = buildDailyReportPayloads({
      date: window.date,
      generatedAt: generated.toISOString(),
      window: { from: window.from, to: window.to },
      timezoneOffsetMinutes,
      group,
      dashboardUrl,
      maxPayloadBytes: cardConfig.maxPayloadBytes,
      foldThresholdChars: cardConfig.foldThresholdChars,
    });
    if (payloads.length !== 1) {
      throw new Error(`Daily report must render exactly one payload, received ${payloads.length}`);
    }
    const rendered = [{
      group,
      payloads,
    }];
    return { generatedAt: generated, window, rendered };
  }

  function getManualSendStatus({ at = now() } = {}) {
    const current = validDate(at, 'Manual daily report time');
    const window = dailyReportWindow(current, timezoneOffsetMinutes);
    const status = {
      allowed: false,
      reason: 'disabled',
      date: window.date,
      window: { from: window.from, to: window.to },
      localTime: localIso(current, timezoneOffsetMinutes),
      timezone: offsetLabel(timezoneOffsetMinutes),
      timezoneOffsetMinutes,
    };
    if (!enabled || feishuMode === 'disabled') return status;
    if (feishuMode !== 'live') return { ...status, reason: 'dry_run' };

    const local = localParts(current, timezoneOffsetMinutes);
    const protectedWindow = hours.some((hour) => {
      const scheduledFor = localTimeToUtc({ ...local, hour }, timezoneOffsetMinutes);
      return Math.abs(current.getTime() - scheduledFor.getTime()) <= MANUAL_PROTECTED_WINDOW_MS;
    });
    if (protectedWindow) return { ...status, reason: 'protected_window' };
    return { ...status, allowed: true, reason: 'allowed' };
  }

  function runManual({ generatedAt = now() } = {}) {
    const generated = validDate(generatedAt, 'Manual daily report generation time');
    const status = getManualSendStatus({ at: generated });
    const base = {
      ...status,
      eventId: null,
      enqueued: false,
      enqueuedCount: 0,
      payloadCount: 0,
      groups: [],
    };
    if (!status.allowed) return base;

    const { window, rendered } = renderReport(generated);
    const payload = rendered[0].payloads[0];
    const minuteKey = manualMinuteKey(generated, timezoneOffsetMinutes);
    const enqueueResult = outboxStore.enqueue({
      runId: `daily_manual_${minuteKey.replaceAll(':', '_')}`,
      type: 'audit_daily_trace_report',
      payload,
      deliveryMode: 'feishu_bot',
      priority: DAILY_REPORT_PRIORITY,
      callbackUrl: null,
      maxAttempts,
      dedupeKey: `feishu_daily_manual:${minuteKey}`,
    });
    const enqueued = enqueueResult?.enqueued !== false;
    const result = {
      ...status,
      reason: enqueued ? 'enqueued' : 'duplicate',
      eventId: enqueueResult?.eventId ?? null,
      enqueued,
      enqueuedCount: enqueued ? 1 : 0,
      payloadCount: 1,
      window: { from: window.from, to: window.to },
      groups: rendered,
    };
    if (enqueued) notifyEnqueued(result);
    return result;
  }

  function slotDescriptor(scheduledFor, triggerType) {
    const window = dailyReportWindow(scheduledFor, timezoneOffsetMinutes);
    return {
      slot_key: `daily:${window.date}:${window.slotHour}`,
      report_date: window.date,
      slot_hour: window.slotHour,
      scheduled_for: scheduledFor.toISOString(),
      timezone_offset_minutes: timezoneOffsetMinutes,
      trigger_type: triggerType,
    };
  }

  function retryAtForSlot(slot, current, scheduledFor) {
    const deadline = scheduledFor.getTime() + catchUpWindowMinutes * 60 * 1000;
    if (current.getTime() > deadline) return null;
    const attempts = Math.max(1, Number(slot?.attempts) || 1);
    const delayMs = Math.min(SLOT_RETRY_BASE_MS * 2 ** (attempts - 1), SLOT_RETRY_MAX_MS);
    const candidate = current.getTime() + delayMs;
    return new Date(candidate <= deadline ? candidate : deadline + 1);
  }

  function retryAtForLease(slot, current, scheduledFor) {
    const deadline = scheduledFor.getTime() + catchUpWindowMinutes * 60 * 1000;
    if (current.getTime() > deadline) return null;
    const leaseExpiresAt = Date.parse(slot?.lease_expires_at);
    const candidate = Number.isFinite(leaseExpiresAt)
      ? Math.max(current.getTime() + 1, leaseExpiresAt + 1)
      : current.getTime() + SLOT_RETRY_BASE_MS;
    return new Date(candidate <= deadline ? candidate : deadline + 1);
  }

  function completeClaimedSlot(slot, { status, enqueuedCount = 0, error = null, completedAt }) {
    return completeSlotStmt.run({
      slot_key: slot.slot_key,
      owner_id: ownerId,
      status,
      enqueued_count: enqueuedCount,
      completed_at: completedAt.toISOString(),
      last_error: error ? String(error.message ?? error).slice(0, 1000) : null,
    }).changes === 1;
  }

  function notifyEnqueued(result) {
    if (!onEnqueued) return;
    Promise.resolve()
      .then(() => onEnqueued(result))
      .catch(() => {});
  }

  function reconcileDueSlot({ at = now() } = {}) {
    if (!enabled || feishuMode === 'disabled') {
      return { status: 'disabled', processed: false };
    }
    if (feishuMode !== 'live') {
      return { status: 'dry_run', processed: false };
    }
    const current = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(current.getTime())) throw new Error('Daily report reconciliation time is invalid');

    const latest = latestDailyReportSlotAt(current, { hours, timezoneOffsetMinutes });
    const latenessMs = Math.max(0, current.getTime() - latest.scheduledFor.getTime());
    const triggerType = latenessMs <= ON_TIME_THRESHOLD_MS ? 'scheduled' : 'catch_up';
    const slot = slotDescriptor(latest.scheduledFor, triggerType);
    if (latenessMs > catchUpWindowMinutes * 60 * 1000) {
      const recorded = recordSkippedSlot(slot, current);
      return {
        status: recorded.slot?.status ?? 'skipped_late',
        processed: recorded.recorded,
        slot: getSlotStmt.get(slot.slot_key),
        latenessMs,
      };
    }

    const claim = claimSlot(slot, current);
    if (!claim.claimed) {
      const retryAt = claim.reason === 'leased'
        ? retryAtForLease(claim.slot, current, latest.scheduledFor)
        : null;
      return {
        status: claim.slot?.status ?? claim.reason,
        processed: false,
        slot: claim.slot ?? getSlotStmt.get(slot.slot_key),
        latenessMs,
        retry_at: retryAt?.toISOString() ?? null,
      };
    }

    try {
      const result = runNow({ scheduledFor: latest.scheduledFor });
      const status = result.groups.length === 0 ? 'empty' : 'enqueued';
      const completed = completeClaimedSlot(slot, {
        status,
        enqueuedCount: result.enqueuedCount,
        completedAt: now(),
      });
      if (!completed) {
        const currentSlot = getSlotStmt.get(slot.slot_key);
        const retryAt = retryAtForLease(currentSlot, current, latest.scheduledFor);
        return {
          status: 'lost_lease',
          processed: false,
          slot: currentSlot,
          result,
          latenessMs,
          retry_at: retryAt?.toISOString() ?? null,
        };
      }
      const reconciled = {
        status,
        processed: true,
        slot: getSlotStmt.get(slot.slot_key),
        result,
        latenessMs,
      };
      if (status === 'enqueued') notifyEnqueued(reconciled);
      return reconciled;
    } catch (error) {
      const completed = completeClaimedSlot(slot, {
        status: 'failed',
        error,
        completedAt: now(),
      });
      if (!completed) {
        const currentSlot = getSlotStmt.get(slot.slot_key);
        const retryAt = retryAtForLease(currentSlot, current, latest.scheduledFor);
        return {
          status: 'lost_lease',
          processed: false,
          slot: currentSlot,
          error,
          latenessMs,
          retry_at: retryAt?.toISOString() ?? null,
        };
      }
      const failedSlot = getSlotStmt.get(slot.slot_key);
      const retryAt = retryAtForSlot(failedSlot, current, latest.scheduledFor);
      return {
        status: 'failed',
        processed: true,
        slot: failedSlot,
        error,
        latenessMs,
        retry_at: retryAt?.toISOString() ?? null,
      };
    }
  }

  function getHealthStatus() {
    const active = started && enabled && feishuMode === 'live';
    const next = active ? (scheduledWakeAt ?? nextDailyReportAt(now(), { hours, timezoneOffsetMinutes })) : null;
    return {
      feishu_mode: feishuMode,
      configured_enabled: enabled,
      scheduler_started: started,
      active,
      timezone: offsetLabel(timezoneOffsetMinutes),
      timezone_offset_minutes: timezoneOffsetMinutes,
      schedule_hours: [...hours],
      catch_up_window_minutes: catchUpWindowMinutes,
      next_run_at_utc: next?.toISOString() ?? null,
      next_run_at_local: next ? localIso(next, timezoneOffsetMinutes) : null,
      last_slot: latestSlotStmt.get() ?? null,
    };
  }

  function start() {
    if (started) return;
    started = true;
    const result = enabled && feishuMode === 'live' ? reconcileDueSlot({ at: now() }) : null;
    scheduleNext(result);
  }

  function stop() {
    started = false;
    clearTimer();
  }

  return {
    start,
    stop,
    runNow,
    runManual,
    reconcileDueSlot,
    getManualSendStatus,
    getHealthStatus,
    nextRunAt: () => nextDailyReportAt(now(), { hours, timezoneOffsetMinutes }),
  };
}

export {
  DAILY_REPORT_PRIORITY,
  DEFAULT_CATCH_UP_WINDOW_MINUTES,
  loadDailySummary,
};
