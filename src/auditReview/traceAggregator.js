// src/auditReview/traceAggregator.js
import crypto from 'crypto';
import { computeInputHash } from './traceStore.js';
import { createReviewStore } from './reviewStore.js';
import { estimateTokensForPayload, llmBudgetFromConfig } from './llmBudget.js';
import { traceReviewInput } from './llmReviewer.js';

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
  const required = [trace.requester_id, trace.original_request, trace.expected_purpose, trace.agent_result];
  const missing = required.filter((value) => value == null || value === '').length;
  if (missing === 0) return 'complete';
  return missing === required.length ? 'unknown' : 'incomplete_context';
}

function isTimeout(eventAt, minutes, now) {
  return Date.parse(eventAt) < Date.parse(now) - minutes * 60000;
}

function hasFailureEvidence(events) {
  return events.some((event) => event.event === 'tool.error' ||
    (String(event.event).startsWith('tool.') && ['ERROR', 'INTERNAL', 'TIMEOUT', 'CANCELLED', 'FAILED'].includes(String(event.status).toUpperCase())) ||
    ['run.interrupted', 'agent.error'].includes(event.event));
}

function hasMinorEvidence(events) {
  return events.some((event) => /retry|warn|timeout/i.test(event.event) ||
    ['WARN', 'WARNING', 'RETRY', 'TIMEOUT'].includes(String(event.status).toUpperCase()));
}

function hasLongLoopEvidence(events, policy = {}) {
  // Without a Span, start/end events cannot be paired reliably. Count starts only.
  const tools = events.filter((event) => String(event.event).startsWith('tool.') && (event.span_id || event.event === 'tool.start'));
  const invocations = new Set(tools.map((event) => event.span_id ? JSON.stringify([event.tool_name, event.span_id]) : `event:${event.event_id}`));
  if (invocations.size > (policy.traceToolChainStepThreshold ?? 50)) return true;
  const buckets = new Map();
  for (const event of tools) {
    const key = JSON.stringify([event.tool_name, event.entity_type, event.entity_id]);
    const cutoff = Date.parse(event.ts) - (policy.repeatWindowMinutes ?? 10) * 60000;
    const bucket = (buckets.get(key) ?? []).filter((prior) => Date.parse(prior.ts) >= cutoff && (!event.span_id || prior.span_id !== event.span_id));
    bucket.push(event);
    buckets.set(key, bucket);
    if (bucket.length >= (policy.repeatThreshold ?? 5)) return true;
  }
  return events.some((event) => /(?:^|\.)loop(?:$|\.)/.test(event.event));
}

function sealDecision({ trace, events, now, options }) {
  if (events.some((event) => TERMINAL_EVENTS.has(event.event))) {
    return { sealed: true, reason: 'terminal_event', sealedAt: trace.last_event_at };
  }
  const last = events.at(-1);
  if (last?.event === 'run.waiting_user' && isTimeout(last.ts, options.waitingUserTimeoutMinutes, now)) {
    return { sealed: true, reason: 'waiting_user_timeout', sealedAt: now };
  }
  if (last?.event !== 'run.waiting_user' && isTimeout(trace.last_event_at, options.idleTimeoutMinutes, now)) {
    return { sealed: true, reason: 'idle_timeout', sealedAt: now };
  }
  return { sealed: false, reason: null, sealedAt: null };
}

function sampleEvents(events, maxEvents) {
  maxEvents = Math.max(1, Math.floor(maxEvents));
  if (events.length <= maxEvents) return { events, sampled: false, omitted: 0 };
  const edges = new Map();
  for (const event of events) {
    if (!event.span_id) continue;
    const edge = edges.get(event.span_id) ?? [event.event_id, event.event_id];
    edge[1] = event.event_id;
    edges.set(event.span_id, edge);
  }
  const edgeIds = new Set([...edges.values()].flat());
  const buckets = [[], [], [], []];
  for (const event of events) {
    const priority = HIGH_SIGNAL_EVENTS.has(event.event) ? 0
      : hasFailureEvidence([event]) || hasMinorEvidence([event]) || /loop|fail|error/i.test(event.event) ? 1
      : edgeIds.has(event.event_id) ? 2 : 3;
    buckets[priority].push(event);
  }
  const selected = [];
  // Priority buckets share a strict budget; ties use ts/id order. The last
  // bucket retains both ends so mundane trailing evidence remains visible.
  for (const [index, bucket] of buckets.entries()) {
    const remaining = maxEvents - selected.length;
    if (remaining <= 0) break;
    if (index === 3 && bucket.length > remaining) {
      const head = Math.ceil(remaining / 2);
      selected.push(...bucket.slice(0, head), ...(remaining > head ? bucket.slice(-(remaining - head)) : []));
    } else selected.push(...bucket.slice(0, remaining));
  }
  selected.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a.event_id - b.event_id);
  return { events: selected, sampled: true, omitted: events.length - selected.length };
}

function evidenceIds(events) {
  return events.map((event) => event.event_id);
}

function deterministicOutcome(events, policy = {}) {
  const final = events.find((event) => event.event === 'run.final_result');
  const failed = events.find((event) => event.event === 'run.failed');
  const ended = new Set(events.filter((event) => event.span_id && ['agent.end', 'agent.error'].includes(event.event)).map((event) => event.span_id));
  const unfinishedChildren = events.filter((event) => event.span_id && event.event === 'agent.start' && !ended.has(event.span_id));
  const failureEvidence = hasFailureEvidence(events);
  const longLoop = hasLongLoopEvidence(events, policy);
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
  // Called only after sealing: a parent's success cannot complete a child Span.
  if (unfinishedChildren.length > 0) {
    return { needsLlm: false, outcome: {
      trace_status: 'interrupted', risk_level: 'high',
      risk_reason: 'Trace 已封存，但子 Agent 缺少终止事件，任务链路中断，需要人工介入。',
      evidence_event_ids: evidenceIds(unfinishedChildren),
    } };
  }
  if (final && !failureEvidence && !longLoop && !hasMinorEvidence(events)) {
    return {
      needsLlm: false,
      outcome: {
        trace_status: 'success',
        risk_level: 'none',
        risk_reason: '任务成功完成，未发现工具错误或长循环证据。',
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
        risk_reason: '任务最终完成，但过程存在工具错误或长循环证据。',
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
  return { needsLlm: true, trace_status: final ? 'success' : 'incomplete' };
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
    })),
  };
}

function withConflicts(outcome, trace, events) {
  const ids = events.filter((event) => ['requester_id', 'original_request', 'agent_result', 'expected_purpose'].some((field) =>
    event[field] != null && event[field] !== '' && trace[field] != null && event[field] !== trace[field])).map((event) => event.event_id);
  return ids.length ? { ...outcome, risk_reason: `${outcome.risk_reason}；任务字段冲突事件ID：${ids.join(',')}` } : outcome;
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
  const usageStore = createReviewStore(db);
  const budget = llmBudgetFromConfig(config);
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

  function aggregateFacts(agentId, traceId, events) {
    const first = events[0];
    const last = events.at(-1);
    const trace = {
      agent_id: agentId,
      trace_id: traceId,
      requester_id: events.find((event) => event.event === 'run.start')?.requester_id ?? null,
      original_request: events.find((event) => event.event === 'run.start')?.original_request ?? null,
      expected_purpose: events.find((event) => event.event === 'run.start')?.expected_purpose ?? null,
      agent_result: events.filter((event) => TERMINAL_EVENTS.has(event.event)).at(-1)?.agent_result ?? null,
      first_event_at: first?.ts,
      last_event_at: last?.ts,
      ingested_watermark: events.reduce((latest, event) => event.ingested_at > latest ? event.ingested_at : latest, ''),
      event_count: events.length,
    };
    trace.context_status = contextStatusFor(trace);
    if (trace.context_status === 'unknown') trace.context_status = 'incomplete_context';
    return trace;
  }

  function processTrace(agentId, traceId) {
    const events = listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id }));
    if (events.length === 0) return null;
    const facts = aggregateFacts(agentId, traceId, events);
    const previous = traceStore.getTrace(agentId, traceId);
    if (!previous || previous.event_count !== facts.event_count || previous.ingested_watermark !== facts.ingested_watermark) traceStore.upsertPendingTrace(facts);
    const existing = traceStore.getTrace(agentId, traceId);
    const decision = sealDecision({ trace: facts, events, now: now().toISOString(), options });
    if (!existing.sealed_at && decision.sealed) {
      traceStore.sealTrace({ agentId, traceId, sealedAt: decision.sealedAt, sealedReason: decision.reason });
    }
    return traceStore.getTrace(agentId, traceId);
  }

  async function reviewSealedTrace(agentId, traceId) {
    const lockName = `trace_review:${JSON.stringify([agentId, traceId])}`;
    const ownerId = `trace_${crypto.randomUUID()}`;
    const acquired = db.transaction(() => lockStore.acquire({ lockName, ownerId, leaseMinutes: 5 })).immediate();
    if (!acquired.acquired) return { reviewed: false, reason: 'locked' };
    const refresh = setInterval(() => lockStore.refresh({ lockName, ownerId, leaseMinutes: 5 }), 60000);
    refresh.unref?.();
    try {
      const trace = traceStore.getTrace(agentId, traceId);
      if (!trace || !trace.sealed_at || trace.sealed_reason === 'backfill') return { reviewed: false, reason: 'not_reviewable' };
      const events = listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id }));
      const inputHash = computeInputHash({ ...trace, events });
      if (trace.input_hash === inputHash && trace.review_error === 0) return { reviewed: false, reason: 'unchanged' };
      const sampled = sampleEvents(events, options.maxEventsPerTrace);
      const deterministic = deterministicOutcome(events, config.auditReview?.riskPolicy);
      if (!deterministic.needsLlm) {
        const updated = traceStore.applySuccessfulReview({
          trace: { agent_id: agentId, trace_id: traceId },
          outcome: withConflicts(deterministic.outcome, trace, events),
          inputHash,
          model: null,
          promptVersion: null,
          reviewInputSampled: sampled.sampled,
          omittedEventCount: sampled.omitted,
        });
        return { reviewed: true, trace: updated, usedLlm: false };
      }
      if (trace.review_retry_count >= options.maxInvalidOutputRetries) return { reviewed: false, reason: 'retries_exhausted' };
      const payload = traceReviewInput(buildLlmInput(trace, sampled.events));
      const reserved = usageStore.reserveLlmUsage({ day: now().toISOString().slice(0, 10),
        calls: 1, estTokens: estimateTokensForPayload(payload), ...budget });
      if (!reserved.reserved) return { reviewed: false, reason: 'llm_budget_exceeded' };
      const llmResult = await awaitLlmReview(trace, sampled.events, deterministic.trace_status);
      if (!llmResult.ok) {
        const recorded = db.transaction(() => {
          const lease = lockStore.getLock(lockName);
          if (lease?.owner_id !== ownerId || lease.lease_expires_at <= new Date().toISOString()) return false;
          traceStore.markReviewError({
          agentId,
          traceId,
          riskReason: llmResult.error,
          maxRetries: options.maxInvalidOutputRetries,
          });
          return true;
        }).immediate();
        if (!recorded) return { reviewed: false, reason: 'lease_lost' };
        return { reviewed: false, usedLlm: true, error: llmResult.error };
      }
      const updated = db.transaction(() => {
        const currentEvents = listTraceEventsStmt.all({ agent_id: agentId, trace_id: traceId }).map((event) => ({ ...event, event_id: event.id }));
        if (computeInputHash({ ...trace, events: currentEvents }) !== inputHash) return null;
        if (lockStore.getLock(lockName)?.owner_id !== ownerId) return null;
        return traceStore.applySuccessfulReview({
          trace: { agent_id: agentId, trace_id: traceId },
          outcome: withConflicts(llmResult.outcome, trace, events), inputHash,
          model: llmResult.model, promptVersion: llmResult.promptVersion,
          reviewInputSampled: sampled.sampled, omittedEventCount: sampled.omitted,
        });
      }).immediate();
      if (!updated) return { reviewed: false, reason: 'input_changed' };
      return { reviewed: true, trace: updated, usedLlm: true };
    } finally {
      clearInterval(refresh);
      lockStore.release({ lockName, ownerId });
    }
  }

  function awaitLlmReview(trace, events, traceStatus) {
    const input = buildLlmInput({ ...trace, review_input_sampled: events.length < trace.event_count, omitted_event_count: trace.event_count - events.length }, events);
    return Promise.resolve().then(() => llmReviewer.reviewTrace({ trace: input, traceStatus })).then((result) => {
      if (!result.ok) return result;
      const evidence = new Set(events.map((event) => event.event_id));
      if (!Array.isArray(result.outcome.evidence_event_ids) ||
          result.outcome.evidence_event_ids.length === 0 ||
          result.outcome.evidence_event_ids.some((id) => !evidence.has(id))) {
        return { ok: false, error: 'invalid evidence_event_ids' };
      }
      if (trace.risk_level !== 'high' && ({ none: 0, low: 1, medium: 2 }[result.outcome.risk_level] < { none: 0, low: 1, medium: 2 }[trace.risk_level])) return { ok: false, error: 'risk downgrade rejected' };
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
    async run() {
      const currentCursor = cursor();
      const newEvents = listNewEventsStmt.all({
        ingested_at: currentCursor.last_ingested_at ?? '',
        last_event_id: currentCursor.last_event_id ?? 0,
      });
      const grouped = new Map();
      for (const event of newEvents) {
        const key = JSON.stringify([event.agent_id, event.trace_id]);
        grouped.set(key, grouped.get(key) ?? []);
        grouped.get(key).push(event);
      }
      for (const [key] of grouped) processTrace(...JSON.parse(key));
      for (const trace of listUnsealedStmt.all()) processTrace(trace.agent_id, trace.trace_id);
      const rows = db.prepare(`SELECT agent_id, trace_id, sealed_at, sealed_reason FROM audit_traces WHERE sealed_at IS NOT NULL`).all();
      const reviews = [];
      for (const row of rows) {
        if (row.sealed_reason === 'backfill') continue;
        reviews.push(await reviewSealedTrace(row.agent_id, row.trace_id));
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
      return { scannedEvents: newEvents.length, updatedTraces: grouped.size, reviewedTraces: reviews.filter((result) => result.reviewed).length, reviews };
    },
  };
}
