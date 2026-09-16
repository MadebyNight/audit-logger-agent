// src/auditReview/traceAggregator.js
import crypto from 'crypto';
import { computeInputHash } from './traceStore.js';

const CURSOR_NAME = 'trace_aggregation';
const TERMINAL_EVENTS = new Set(['run.final_result', 'run.failed']);
const HIGH_SIGNAL_EVENTS = new Set([
  'run.start',
  'run.final_result',
  'run.failed',
  'run.waiting_user',
  'run.resume',
]);
const DEFAULTS = {
  idleTimeoutMinutes: 60,
  waitingUserTimeoutMinutes: 1440,
  maxEventsPerTrace: 2000,
  maxInvalidOutputRetries: 2,
};

function nowIso() {
  return new Date().toISOString();
}

function configValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function traceConfig(config) {
  const source = config.auditReview?.traceReview ?? config.traceReview ?? {};
  return {
    idleTimeoutMinutes: configValue(source.idleTimeoutMinutes, DEFAULTS.idleTimeoutMinutes),
    waitingUserTimeoutMinutes: configValue(source.waitingUserTimeoutMinutes, DEFAULTS.waitingUserTimeoutMinutes),
    maxEventsPerTrace: configValue(source.maxEventsPerTrace, DEFAULTS.maxEventsPerTrace),
    maxInvalidOutputRetries: configValue(source.maxInvalidOutputRetries, DEFAULTS.maxInvalidOutputRetries),
  };
}

function contextStatusFor(trace) {
  const required = [trace.requester_id, trace.original_request, trace.agent_result];
  const missing = required.filter((value) => value == null || value === '').length;
  if (missing === 0) return 'complete';
  return missing === required.length ? 'unknown' : 'incomplete_context';
}

function isTimeout(eventAt, minutes, now) {
  return Date.parse(eventAt) < Date.parse(now) - minutes * 60000;
}

function hasFailureEvidence(events) {
  return events.some((event) => {
    const status = String(event.status ?? '').toUpperCase();
    return event.event === 'tool.error' ||
      ['ERROR', 'INTERNAL', 'TIMEOUT', 'CANCELLED'].includes(status) ||
      String(event.tool_name ?? '').toLowerCase().includes('retry');
  });
}

function hasLongLoopEvidence(events) {
  return events.some((event) => {
    const status = String(event.status ?? '').toUpperCase();
    return status === 'TIMEOUT' || String(event.tool_name ?? '').toLowerCase().includes('loop');
  });
}

function sealDecision({ trace, events, now, options }) {
  if (events.some((event) => TERMINAL_EVENTS.has(event.event))) {
    return { sealed: true, reason: 'terminal_event', sealedAt: trace.last_event_at };
  }
  const last = events.at(-1);
  if (last?.event === 'run.waiting_user' && isTimeout(last.ts, options.waitingUserTimeoutMinutes, now)) {
    return { sealed: true, reason: 'waiting_user_timeout', sealedAt: nowIso() };
  }
  if (last?.event !== 'run.waiting_user' && isTimeout(trace.last_event_at, options.idleTimeoutMinutes, now)) {
    return { sealed: true, reason: 'idle_timeout', sealedAt: nowIso() };
  }
  return { sealed: false, reason: null, sealedAt: null };
}

function priorityOf(event, events) {
  if (HIGH_SIGNAL_EVENTS.has(event.event)) return 1;
  if (hasFailureEvidence([event])) return 2;
  const sameSpan = events.filter((candidate) => candidate.span_id === event.span_id);
  if (sameSpan.at(0)?.event_id === event.event_id || sameSpan.at(-1)?.event_id === event.event_id) return 3;
  return 4;
}

function sampleEvents(events, maxEvents) {
  if (events.length <= maxEvents) return { events, sampled: false, omitted: 0 };
  const buckets = [[], [], [], []];
  for (const event of events) buckets[priorityOf(event, events) - 1].push(event);
  const selected = [];
  for (const bucket of buckets) {
    if (selected.length >= maxEvents) break;
    selected.push(...bucket.slice(0, maxEvents - selected.length));
  }
  selected.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.event_id - b.event_id);
  return { events: selected, sampled: true, omitted: events.length - selected.length };
}

function evidenceIds(events) {
  return events.map((event) => event.event_id);
}

function deterministicOutcome(events, traceStatus = null) {
  const final = events.find((event) => event.event === 'run.final_result');
  const failed = events.find((event) => event.event === 'run.failed');
  const failureEvidence = hasFailureEvidence(events);
  const longLoop = hasLongLoopEvidence(events);
  if (failed || events.some((event) => String(event.status ?? '').toUpperCase() === 'CANCELLED' && TERMINAL_EVENTS.has(event.event))) {
    return {
      needsLlm: false,
      outcome: {
        trace_status: 'failed',
        risk_level: 'high',
        risk_reason: failed ? '任务出现 run.failed 终止事件，判定为高风险。' : '任务被取消，结果未达成，判定为高风险。',
        evidence_event_ids: evidenceIds(failed ? [failed] : events.filter((event) => TERMINAL_EVENTS.has(event.event))),
      },
    };
  }
  if (final && !failureEvidence && !longLoop) {
    return {
      needsLlm: false,
      outcome: {
        trace_status: 'success',
        risk_level: 'none',
        risk_reason: '任务成功完成，未发现工具错误、超时、重试或长循环证据。',
        evidence_event_ids: [final.event_id],
      },
    };
  }
  if (final && (failureEvidence || longLoop)) {
    return {
      needsLlm: false,
      outcome: {
        trace_status: 'success',
        risk_level: 'medium',
        risk_reason: '任务最终完成，但过程存在工具错误、超时、重试或长循环证据。',
        evidence_event_ids: evidenceIds(events.filter((event) =>
          event.event === 'run.final_result' ||
          ['ERROR', 'INTERNAL', 'TIMEOUT', 'CANCELLED'].includes(String(event.status ?? '').toUpperCase()))),
      },
    };
  }
  if (!final && (failureEvidence || longLoop)) {
    return {
      needsLlm: false,
      outcome: {
        trace_status: 'interrupted',
        risk_level: 'high',
        risk_reason: '任务缺少终止事件，且存在调用失败、循环或异常中断证据。',
        evidence_event_ids: evidenceIds(events),
      },
    };
  }
  return { needsLlm: true, trace_status: traceStatus ?? 'incomplete' };
}

function buildLlmInput(trace, events) {
  return {
    agent_id: trace.agent_id,
    trace_id: trace.trace_id,
    requester_id: trace.requester_id,
    original_request: trace.original_request,
    expected_purpose: trace.expected_purpose,
    agent_result: trace.agent_result,
    context_status: trace.context_status,
    sealed_reason: trace.sealed_reason,
    review_input_sampled: Boolean(trace.review_input_sampled),
    omitted_event_count: trace.omitted_event_count ?? 0,
    event_count: trace.event_count,
    events: events.map((event) => ({
      event_id: event.event_id,
      ts: event.ts,
      event: event.event,
      span_id: event.span_id,
      parent_span_id: event.parent_span_id,
      tool_name: event.tool_name,
      status: event.status,
      duration_ms: event.duration_ms,
      error_message: event.error_message,
      result_summary: event.result_summary,
      ...(event.llm_intent_json ? { llm_intent: safeJson(event.llm_intent_json) } : {}),
      requester_id: event.requester_id,
      original_request: event.original_request,
      agent_result: event.agent_result,
      expected_purpose: event.expected_purpose,
    })),
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function createTraceAggregator({ db, config, traceStore, llmReviewer, lockStore, now = () => new Date() }) {
  const options = traceConfig(config);
  const cursorName = CURSOR_NAME;
  const getCursorStmt = db.prepare(`SELECT * FROM audit_trace_scan_cursor WHERE cursor_name = ?`);
  const upsertCursorStmt = db.prepare(`
    INSERT INTO audit_trace_scan_cursor (cursor_name, last_ingested_at, last_event_id, updated_at)
    VALUES (@cursor_name, @last_ingested_at, @last_event_id, @updated_at)
    ON CONFLICT(cursor_name) DO UPDATE SET
      last_ingested_at = excluded.last_ingested_at,
      last_event_id = excluded.last_event_id,
      updated_at = excluded.updated_at
  `);
  const listNewEventsStmt = db.prepare(`
    SELECT id, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
           duration_ms, requester_id, original_request, agent_result, expected_purpose,
           error_message, result_summary, llm_intent_json, ingested_at
    FROM audit_events
    WHERE ingested_at > @ingested_at OR (ingested_at = @ingested_at AND id > @last_event_id)
    ORDER BY ingested_at ASC, id ASC
  `);
  const listTraceEventsStmt = db.prepare(`
    SELECT id, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
           duration_ms, requester_id, original_request, agent_result, expected_purpose,
           error_message, result_summary, llm_intent_json, ingested_at
    FROM audit_events
    WHERE agent_id = @agent_id AND trace_id = @trace_id
    ORDER BY ts ASC, id ASC
  `);
  const listUnsealedStmt = db.prepare(`
    SELECT * FROM audit_traces WHERE sealed_at IS NULL
  `);

  function cursor() {
    return getCursorStmt.get(cursorName) ?? { cursor_name: cursorName, last_ingested_at: null, last_event_id: 0 };
  }

  function firstNonEmpty(events, field) {
    const event = events.find((candidate) => candidate[field] != null && candidate[field] !== '');
    return event ? event[field] : null;
  }

  function aggregateFacts(agentId, traceId, events) {
    const first = events[0];
    const last = events.at(-1);
    const trace = {
      agent_id: agentId,
      trace_id: traceId,
      requester_id: firstNonEmpty(events, 'requester_id'),
      original_request: firstNonEmpty(events, 'original_request'),
      expected_purpose: firstNonEmpty(events, 'expected_purpose'),
      agent_result: firstNonEmpty(events, 'agent_result'),
      first_event_at: first?.ts,
      last_event_at: last?.ts,
      ingested_watermark: events.at(-1)?.ingested_at,
      event_count: events.length,
    };
    trace.context_status = contextStatusFor(trace);
    return trace;
  }

  function processTrace(agentId, traceId) {
    const events = listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id }));
    if (events.length === 0) return null;
    const facts = aggregateFacts(agentId, traceId, events);
    traceStore.upsertPendingTrace(facts);
    const existing = traceStore.getTrace(agentId, traceId);
    const decision = sealDecision({ trace: facts, events, now: now().toISOString(), options });
    if (!existing.sealed_at && decision.sealed) {
      traceStore.sealTrace({ agentId, traceId, sealedAt: decision.sealedAt, sealedReason: decision.reason });
    }
    return traceStore.getTrace(agentId, traceId);
  }

  async function reviewSealedTrace(agentId, traceId) {
    const trace = traceStore.getTrace(agentId, traceId);
    if (!trace || !trace.sealed_at || trace.sealed_reason === 'backfill') return { reviewed: false, reason: 'not_reviewable' };
    const inputHash = computeInputHash({ ...trace, events: listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id })) });
    if (trace.input_hash === inputHash && trace.review_error === 0) return { reviewed: false, reason: 'unchanged' };
    const events = listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id }));
    const sampled = sampleEvents(events, options.maxEventsPerTrace);
    const deterministic = deterministicOutcome(sampled.events);
    if (!deterministic.needsLlm) {
      const updated = traceStore.applySuccessfulReview({
        trace: { agent_id: agentId, trace_id: traceId },
        outcome: deterministic.outcome,
        inputHash,
        model: null,
        promptVersion: null,
        reviewInputSampled: sampled.sampled,
        omittedEventCount: sampled.omitted,
      });
      return { reviewed: true, trace: updated, usedLlm: false };
    }
    const lockName = `trace_review:${agentId}:${traceId}`;
    const ownerId = `trace_${crypto.randomUUID()}`;
    const acquired = lockStore.acquire({ lockName, ownerId, leaseMinutes: 5 });
    if (!acquired.acquired) return { reviewed: false, reason: 'locked' };
    try {
      const llmResult = await awaitLlmReview(trace, sampled.events, deterministic.trace_status);
      if (!llmResult.ok) {
        traceStore.markReviewError({
          agentId,
          traceId,
          riskReason: llmResult.error,
          maxRetries: options.maxInvalidOutputRetries,
        });
        return { reviewed: false, usedLlm: true, error: llmResult.error };
      }
      const updated = traceStore.applySuccessfulReview({
        trace: { agent_id: agentId, trace_id: traceId },
        outcome: llmResult.outcome,
        inputHash,
        model: llmResult.model,
        promptVersion: llmResult.promptVersion,
        reviewInputSampled: sampled.sampled,
        omittedEventCount: sampled.omitted,
      });
      return { reviewed: true, trace: updated, usedLlm: true };
    } finally {
      lockStore.release({ lockName, ownerId });
    }
  }

  function awaitLlmReview(trace, events, traceStatus) {
    // Synchronous scheduler path requires the injected reviewer to return a Promise.
    const input = buildLlmInput({ ...trace, review_input_sampled: events.length < trace.event_count, omitted_event_count: trace.event_count - events.length }, events);
    return Promise.resolve(llmReviewer.reviewTrace({ trace: input, traceStatus })).then((result) => {
      if (!result.ok) return result;
      const evidence = new Set(events.map((event) => event.event_id));
      if (!Array.isArray(result.outcome.evidence_event_ids) ||
          result.outcome.evidence_event_ids.length === 0 ||
          result.outcome.evidence_event_ids.some((id) => !evidence.has(id))) {
        return { ok: false, error: 'invalid evidence_event_ids' };
      }
      const allowed = traceStatus === 'success' ? ['none', 'low', 'medium'] : ['none', 'low'];
      if (!allowed.includes(result.outcome.risk_level)) {
        return { ok: false, error: `invalid risk_level for ${traceStatus}` };
      }
      return {
        ok: true,
        outcome: {
          ...result.outcome,
          trace_status: traceStatus,
          risk_reason: String(result.outcome.risk_reason ?? '').slice(0, 200),
        },
        model: result.model,
        promptVersion: result.promptVersion,
      };
    }).catch((error) => ({ ok: false, error: error.message }));
  }

  return {
    processTrace,
    reviewSealedTrace,
    async run({ nowIso: nowOverride } = {}) {
      const currentCursor = cursor();
      const newEvents = listNewEventsStmt.all({
        ingested_at: currentCursor.last_ingested_at ?? '',
        last_event_id: currentCursor.last_event_id ?? 0,
      });
      const grouped = new Map();
      for (const event of newEvents) {
        const key = `${event.agent_id}|${event.trace_id}`;
        grouped.set(key, grouped.get(key) ?? []);
        grouped.get(key).push(event);
      }
      for (const [key] of grouped) processTrace(key.split('|')[0], key.split('|')[1]);
      for (const trace of listUnsealedStmt.all()) processTrace(trace.agent_id, trace.trace_id);
      const rows = db.prepare(`SELECT agent_id, trace_id, sealed_at, sealed_reason FROM audit_traces WHERE sealed_at IS NOT NULL`).all();
      for (const row of rows) {
        if (row.sealed_reason === 'backfill') continue;
        await reviewSealedTrace(row.agent_id, row.trace_id);
      }
      const lastEvent = newEvents.at(-1);
      if (lastEvent) {
        upsertCursorStmt.run({
          cursor_name: cursorName,
          last_ingested_at: lastEvent.ingested_at,
          last_event_id: lastEvent.id,
          updated_at: nowIso(),
        });
      }
      return { scannedEvents: newEvents.length, updatedTraces: grouped.size, reviewedTraces: rows.filter((row) => row.sealed_reason !== 'backfill').length };
    },
  };
}




