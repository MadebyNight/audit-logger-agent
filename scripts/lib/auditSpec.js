export const REQUIRED_FIELDS = [
  'ts',
  'agent_id',
  'trace_id',
  'span_id',
  'event',
  'tool_name',
  'status',
  'result_summary',
];

export const TASK_FIELDS = Object.freeze({
  requester_id: { type: 'string', maxLength: 128 },
  original_request: { type: 'string', maxLength: 2000 },
  expected_purpose: { type: 'string', maxLength: 1000 },
  agent_result: { type: 'string', maxLength: 2000 },
});

export const EVENT_REQUIRED_TASK_FIELDS = Object.freeze({
  'run.start': ['requester_id', 'original_request'],
  'run.final_result': ['agent_result'],
  'run.failed': ['agent_result'],
});

export const EVENT_STAGE_MAP = Object.freeze({
  'tool.start': { process: 'tool', stage: 'start' },
  'tool.end': { process: 'tool', stage: 'end' },
  'tool.error': { process: 'tool', stage: 'error' },
  'agent.start': { process: 'agent', stage: 'start' },
  'agent.end': { process: 'agent', stage: 'end' },
  'agent.error': { process: 'agent', stage: 'error' },
  'run.start': { process: 'run', stage: 'start' },
  'run.resume': { process: 'run', stage: 'resume' },
  'run.waiting_user': { process: 'run', stage: 'waiting_user' },
  'run.final_result': { process: 'run', stage: 'final_result' },
  'run.failed': { process: 'run', stage: 'failed' },
  'review.recovered': { process: 'review', stage: 'recovered' },
  'review.lock.skipped': { process: 'review', stage: 'lock_skipped' },
  'review.start': { process: 'review', stage: 'start' },
  'review.ingest.completed': { process: 'review', stage: 'ingest_completed' },
  'review.detector.completed': { process: 'review', stage: 'detector_completed' },
  'review.llm.budget_exceeded': { process: 'review', stage: 'llm_budget_exceeded' },
  'review.llm.completed': { process: 'review', stage: 'llm_completed' },
  'review.notification.enqueued': { process: 'review', stage: 'notification_enqueued' },
  'review.completed': { process: 'review', stage: 'completed' },
});

export const VALID_EVENTS = Object.freeze(Object.keys(EVENT_STAGE_MAP));

const EVENT_ALIAS_PATTERN = /^[a-z0-9]+([./_-][a-z0-9]+)*$/;

function eventSignature(event) {
  if (typeof event !== 'string' || !EVENT_ALIAS_PATTERN.test(event)) return null;
  return JSON.stringify(event.split(/[./_-]/));
}

const EVENT_SIGNATURE_TO_CANONICAL = Object.freeze((() => {
  const signatureToCanonical = Object.create(null);
  const ambiguousSignatures = new Set();

  for (const canonicalEvent of VALID_EVENTS) {
    const signature = eventSignature(canonicalEvent);
    if (signature == null) continue;

    if (signatureToCanonical[signature] && signatureToCanonical[signature] !== canonicalEvent) {
      ambiguousSignatures.add(signature);
      continue;
    }

    signatureToCanonical[signature] = canonicalEvent;
  }

  for (const signature of ambiguousSignatures) {
    delete signatureToCanonical[signature];
  }

  return signatureToCanonical;
})());

export const CANONICAL_STATUS_CODES = Object.freeze([
  'OK',
  'CANCELLED',
  'UNKNOWN',
  'INVALID_ARGUMENT',
  'DEADLINE_EXCEEDED',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'PERMISSION_DENIED',
  'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION',
  'ABORTED',
  'OUT_OF_RANGE',
  'UNIMPLEMENTED',
  'INTERNAL',
  'UNAVAILABLE',
  'DATA_LOSS',
  'UNAUTHENTICATED',
]);

const LEGACY_STATUS_MAP = Object.freeze({
  ok: 'OK',
  error: 'INTERNAL',
  timeout: 'DEADLINE_EXCEEDED',
  cancelled: 'CANCELLED',
});

export function normalizeEventId(event) {
  if (typeof event !== 'string') return null;
  if (Object.hasOwn(EVENT_STAGE_MAP, event)) return event;

  const signature = eventSignature(event);
  if (signature == null) return null;

  return EVENT_SIGNATURE_TO_CANONICAL[signature] ?? null;
}

export function isValidEvent(event) {
  return normalizeEventId(event) != null;
}

export function isCanonicalStatus(status) {
  return CANONICAL_STATUS_CODES.includes(status);
}

export function normalizeCanonicalStatus(status) {
  if (isCanonicalStatus(status)) return status;
  return LEGACY_STATUS_MAP[status] ?? status;
}

export function stageForEvent(event) {
  const canonicalEvent = normalizeEventId(event);
  return canonicalEvent ? EVENT_STAGE_MAP[canonicalEvent] : null;
}
