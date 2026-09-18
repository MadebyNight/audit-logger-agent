// src/observability/runtimeAudit.js
import crypto from 'crypto';
import { insertEvents } from '../../scripts/lib/db.js';
import { normalizeCanonicalStatus } from '../../scripts/lib/auditSpec.js';
import { normalizeEntry } from '../../scripts/lib/parser.js';

export function createRuntimeAuditLogger(db, { agentId = 'audit-runtime-agent', channel = 'system' } = {}) {
  return {
    async log({ runId, traceId = null, event, status, summary, toolName = 'agent.runtime',
      requesterId, originalRequest, expectedPurpose }) {
      const entry = {
        ts: new Date().toISOString(),
        agent_id: agentId,
        trace_id: traceId ?? `trace_${runId}`,
        span_id: crypto.randomUUID(),
        event,
        tool_name: toolName,
        status: normalizeCanonicalStatus(status),
        result_summary: String(summary ?? '').slice(0, 200),
        channel,
        tags: ['agent-runtime'],
        ...(event === 'run.start' ? {
          requester_id: requesterId, original_request: originalRequest, expected_purpose: expectedPurpose,
        } : {}),
        ...(['run.final_result', 'run.failed'].includes(event) ? { agent_result: summary } : {}),
      };
      // Internal scheduler diagnostics also use event names outside the public lifecycle vocabulary.
      insertEvents(db, [{ ...normalizeEntry(entry), event }]);
    },
  };
}
