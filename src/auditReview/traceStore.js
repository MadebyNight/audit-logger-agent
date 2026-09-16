// src/auditReview/traceStore.js
import crypto from 'crypto';

const RISK_RANK = { unreviewed: 0, none: 1, low: 2, medium: 3, high: 4 };
const ALLOWED_COMBINATIONS = {
  pending: ['unreviewed'],
  success: ['none', 'low', 'medium'],
  failed: ['high'],
  interrupted: ['high'],
  incomplete: ['none', 'low'],
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeEvidenceIds(eventIds) {
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(eventIds) ? eventIds : []) {
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function finalOutcome(existing, outcome) {
  if (existing.risk_level === 'high') {
    if (outcome.risk_level !== 'high') {
      return {
        ...outcome,
        risk_level: 'high',
        trace_status: ['failed', 'interrupted'].includes(existing.trace_status) ? existing.trace_status : outcome.trace_status,
      };
    }
    return outcome;
  }
  if (RISK_RANK[outcome.risk_level] < RISK_RANK[existing.risk_level]) {
    return { ...outcome, risk_level: existing.risk_level };
  }
  return outcome;
}

export function computeInputHash(trace) {
  const canonical = JSON.stringify({
    agent_id: trace.agent_id,
    trace_id: trace.trace_id,
    events: (trace.events ?? []).map((event) => ({
      event_id: event.event_id,
      ts: event.ts,
      event: event.event,
      status: event.status,
      tool_name: event.tool_name,
      error_message: event.error_message,
      result_summary: event.result_summary,
      requester_id: event.requester_id,
      original_request: event.original_request,
      agent_result: event.agent_result,
      expected_purpose: event.expected_purpose,
    })),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function createTraceStore(db) {
  const getTraceStmt = db.prepare(`
    SELECT * FROM audit_traces WHERE agent_id = @agent_id AND trace_id = @trace_id
  `);
  const upsertPendingStmt = db.prepare(`
    INSERT INTO audit_traces (
      agent_id, trace_id, requester_id, original_request, expected_purpose, agent_result,
      context_status, trace_status, risk_level, first_event_at, last_event_at,
      ingested_watermark, event_count, updated_at
    ) VALUES (
      @agent_id, @trace_id, @requester_id, @original_request, @expected_purpose, @agent_result,
      @context_status, 'pending', 'unreviewed', @first_event_at, @last_event_at,
      @ingested_watermark, @event_count, @updated_at
    )
    ON CONFLICT(agent_id, trace_id) DO UPDATE SET
      requester_id = excluded.requester_id,
      original_request = excluded.original_request,
      expected_purpose = excluded.expected_purpose,
      agent_result = excluded.agent_result,
      context_status = excluded.context_status,
      first_event_at = excluded.first_event_at,
      last_event_at = excluded.last_event_at,
      ingested_watermark = excluded.ingested_watermark,
      event_count = excluded.event_count,
      sealed_at = CASE WHEN audit_traces.sealed_reason = 'backfill' THEN audit_traces.sealed_at ELSE NULL END,
      sealed_reason = CASE WHEN audit_traces.sealed_reason = 'backfill' THEN audit_traces.sealed_reason ELSE NULL END,
      updated_at = excluded.updated_at
  `);
  const sealStmt = db.prepare(`
    UPDATE audit_traces
    SET sealed_at = @sealed_at, sealed_reason = @sealed_reason, updated_at = @updated_at
    WHERE agent_id = @agent_id AND trace_id = @trace_id
  `);
  const markReviewErrorStmt = db.prepare(`
    UPDATE audit_traces
    SET review_error = 1,
        review_retry_count = review_retry_count + 1,
        risk_reason = @risk_reason,
        updated_at = @updated_at
    WHERE agent_id = @agent_id AND trace_id = @trace_id
  `);
  const applySuccessStmt = db.prepare(`
    UPDATE audit_traces
    SET trace_status = @trace_status,
        risk_level = @risk_level,
        risk_reason = @risk_reason,
        evidence_event_ids = @evidence_event_ids,
        review_version = review_version + 1,
        first_reviewed_at = COALESCE(first_reviewed_at, @updated_at),
        last_reviewed_at = @updated_at,
        revised_at = CASE WHEN review_version > 0 THEN @updated_at ELSE revised_at END,
        revision_count = CASE WHEN review_version > 0 THEN revision_count + 1 ELSE revision_count END,
        review_error = 0,
        review_retry_count = 0,
        model = @model,
        prompt_version = @prompt_version,
        input_hash = @input_hash,
        review_input_sampled = @review_input_sampled,
        omitted_event_count = @omitted_event_count,
        updated_at = @updated_at
    WHERE agent_id = @agent_id AND trace_id = @trace_id
  `);

  function getTrace(agentId, traceId) {
    return getTraceStmt.get({ agent_id: agentId, trace_id: traceId }) ?? null;
  }

  function applySuccessfulReview({
    trace,
    outcome,
    inputHash,
    model,
    promptVersion,
    reviewInputSampled = false,
    omittedEventCount = 0,
  }) {
    const existing = getTrace(trace.agent_id, trace.trace_id);
    if (!existing) throw new Error('applySuccessfulReview: trace not found');
    if (!(ALLOWED_COMBINATIONS[outcome.trace_status] ?? []).includes(outcome.risk_level)) {
      throw new Error(`invalid trace outcome: ${outcome.trace_status} + ${outcome.risk_level}`);
    }
    if (existing.review_error !== 1 && existing.input_hash === inputHash) return existing;
    const final = finalOutcome(existing, outcome);
    applySuccessStmt.run({
      agent_id: trace.agent_id,
      trace_id: trace.trace_id,
      trace_status: final.trace_status,
      risk_level: final.risk_level,
      risk_reason: String(outcome.risk_reason ?? '').slice(0, 200),
      evidence_event_ids: JSON.stringify(normalizeEvidenceIds(outcome.evidence_event_ids)),
      input_hash: inputHash,
      model,
      prompt_version: promptVersion,
      review_input_sampled: reviewInputSampled ? 1 : 0,
      omitted_event_count: omittedEventCount,
      updated_at: nowIso(),
    });
    return getTrace(trace.agent_id, trace.trace_id);
  }

  return {
    getTrace,
    upsertPendingTrace(trace) {
      upsertPendingStmt.run({ ...trace, updated_at: nowIso() });
      return getTrace(trace.agent_id, trace.trace_id);
    },
    sealTrace({ agentId, traceId, sealedAt, sealedReason }) {
      sealStmt.run({
        agent_id: agentId,
        trace_id: traceId,
        sealed_at: sealedAt,
        sealed_reason: sealedReason,
        updated_at: nowIso(),
      });
      return getTrace(agentId, traceId);
    },
    markReviewError({ agentId, traceId, riskReason, maxRetries }) {
      const reason = String(riskReason ?? '').slice(0, 200);
      markReviewErrorStmt.run({
        agent_id: agentId,
        trace_id: traceId,
        risk_reason: reason,
        updated_at: nowIso(),
      });
      if (Number.isFinite(maxRetries)) {
        db.prepare(`
          UPDATE audit_traces
          SET risk_reason = @maxed_reason
          WHERE agent_id = @agent_id AND trace_id = @trace_id AND review_retry_count >= @max_retries
        `).run({
          agent_id: agentId,
          trace_id: traceId,
          maxed_reason: `审查未完成：${reason}`.slice(0, 200),
          max_retries: maxRetries,
        });
      }
      return getTrace(agentId, traceId);
    },
    applySuccessfulReview,
  };
}
