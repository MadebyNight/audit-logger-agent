import {
  CANONICAL_STATUS_CODES,
  EVENT_REQUIRED_TASK_FIELDS,
  REQUIRED_FIELDS,
  TASK_FIELDS,
  isCanonicalStatus,
  normalizeEventId,
} from './auditSpec.js';

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

export function countRedactionHits(entry) {
  // One combined pattern prevents a phone-like substring inside an ID being counted twice.
  const pattern = /(?<!\d)(?:\d{17}[\dXx]|1[3-9]\d{9})(?!\d)|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  return Object.keys(TASK_FIELDS).reduce((total, field) => total
    + (typeof entry[field] === 'string' ? [...entry[field].matchAll(pattern)].length : 0), 0);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isBlankOptional(value) {
  return value == null || value === '';
}

export function validateLogEntry(entry, lineNumber) {
  const errors = [];

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`line ${lineNumber}: entry must be an object`];
  }

  for (const field of REQUIRED_FIELDS) {
    if (entry[field] == null || entry[field] === '') {
      errors.push(`line ${lineNumber}: missing required field "${field}"`);
    }
  }

  if (entry.event && typeof entry.event !== 'string') {
    errors.push(`line ${lineNumber}: event must be a string`);
  }

  if (entry.status && !isCanonicalStatus(entry.status)) {
    errors.push(`line ${lineNumber}: invalid status "${entry.status}"; expected one of ${CANONICAL_STATUS_CODES.join(', ')}`);
  }

  if (entry.ts && isNaN(Date.parse(entry.ts))) {
    errors.push(`line ${lineNumber}: invalid ISO 8601 timestamp "${entry.ts}"`);
  }

  if (entry.result_summary && entry.result_summary.length > 200) {
    errors.push(`line ${lineNumber}: result_summary exceeds 200 chars (${entry.result_summary.length})`);
  }

  if (hasOwn(entry, 'product_id')) {
    errors.push(`line ${lineNumber}: product_id is not allowed; use entity.type and entity.id`);
  }

  for (const field of ['span_id', 'parent_span_id']) {
    if (entry[field] != null && (typeof entry[field] !== 'string' || !entry[field].trim())) {
      errors.push(`line ${lineNumber}: ${field} must be a non-empty string when present`);
    }
  }

  if (!isBlankOptional(entry.user_id) && typeof entry.user_id !== 'string') {
    errors.push(`line ${lineNumber}: user_id must be a string when present`);
  }

  if (entry.error && (typeof entry.error !== 'object' || Array.isArray(entry.error))) {
    errors.push(`line ${lineNumber}: error field must be an object`);
  }

  if (entry.error && hasOwn(entry.error, 'code')) {
    errors.push(`line ${lineNumber}: error.code is not allowed; use status for canonical failure code and error.message for details`);
  }

  if (entry.entity != null) {
    if (typeof entry.entity !== 'object' || Array.isArray(entry.entity)) {
      errors.push(`line ${lineNumber}: entity must be an object`);
    } else {
      if (typeof entry.entity.type !== 'string' || entry.entity.type === '') {
        errors.push(`line ${lineNumber}: entity.type must be a non-empty string`);
      }
      if (typeof entry.entity.id !== 'string' || entry.entity.id === '') {
        errors.push(`line ${lineNumber}: entity.id must be a non-empty string`);
      }
    }
  }

  if (entry.llm_intent != null) {
    if (typeof entry.llm_intent !== 'object' || Array.isArray(entry.llm_intent)) {
      errors.push(`line ${lineNumber}: llm_intent must be an object`);
    } else {
      if (typeof entry.llm_intent.input !== 'string') {
        errors.push(`line ${lineNumber}: llm_intent.input must be a string`);
      }
      if (typeof entry.llm_intent.output !== 'string') {
        errors.push(`line ${lineNumber}: llm_intent.output must be a string`);
      }
    }
  }

  const canonicalEvent = normalizeEventId(entry.event);
  for (const [field, rule] of Object.entries(TASK_FIELDS)) {
    const value = entry[field];
    if (isBlankOptional(value)) continue;

    if (typeof value !== rule.type) {
      errors.push({ code: 'invalid_field_type', field, message: `line ${lineNumber}: ${field} must be a string when present` });
      continue;
    }

    if (value.length > rule.maxLength) {
      errors.push({ code: 'field_too_long', field, message: `line ${lineNumber}: ${field} exceeds ${rule.maxLength} chars (${value.length})` });
    }
  }

  if (canonicalEvent) {
    const requiredFields = EVENT_REQUIRED_TASK_FIELDS[canonicalEvent] ?? [];
    for (const field of requiredFields) {
      if (isBlankOptional(entry[field]) || (typeof entry[field] === 'string' && !entry[field].trim())) {
        errors.push({ code: 'missing_required_task_field', field, message: `line ${lineNumber}: missing required field "${field}"` });
      }
    }
  }

  if (entry.tags && !Array.isArray(entry.tags)) {
    errors.push(`line ${lineNumber}: tags must be an array`);
  }

  const redactionHits = countRedactionHits(entry);
  if (redactionHits > 0) {
    console.warn(JSON.stringify({ event: 'audit.ingest.redaction_detected', redaction_hits: redactionHits }));
    errors.push({ code: 'redaction_required', message: `line ${lineNumber}: task fields contain unredacted personal data` });
  }

  return errors;
}

export function parseNdjson(content, options = {}) {
  const maxLineBytes = Number.isFinite(Number(options.maxLineBytes)) && Number(options.maxLineBytes) > 0
    ? Math.floor(Number(options.maxLineBytes))
    : DEFAULT_MAX_LINE_BYTES;
  const lines = content.split('\n').filter(line => line.trim() !== '');
  const entries = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
    const lineNumber = i + 1;
    if (Buffer.byteLength(line, 'utf-8') > maxLineBytes) {
      errors.push(`line ${lineNumber}: exceeds maxLineBytes (${maxLineBytes})`);
      continue;
    }
    try {
      const entry = JSON.parse(line);
      const validationErrors = validateLogEntry(entry, lineNumber);
      if (validationErrors.length > 0) {
        errors.push(...validationErrors);
        continue;
      }
      entries.push(entry);
    } catch (e) {
      errors.push(`line ${i + 1}: invalid JSON — ${e.message}`);
    }
  }

  return { entries, errors };
}

export function normalizeEntry(entry) {
  const error = entry.error || null;
  const entity = entry.entity || null;
  const canonicalEvent = normalizeEventId(entry.event);
  return {
    ts: entry.ts,
    agent_id: entry.agent_id,
    trace_id: entry.trace_id,
    span_id: entry.span_id ?? null,
    parent_span_id: entry.parent_span_id === '' ? null : (entry.parent_span_id ?? null),
    event: canonicalEvent ?? 'unknown',
    tool_name: entry.tool_name,
    status: entry.status,
    result_summary: entry.result_summary,
    duration_ms: entry.duration_ms ?? null,
    channel: entry.channel || null,
    user_id: entry.user_id === '' ? null : (entry.user_id ?? null),
    requester_id: entry.requester_id === '' ? null : (entry.requester_id ?? null),
    original_request: entry.original_request === '' ? null : (entry.original_request ?? null),
    agent_result: entry.agent_result === '' ? null : (entry.agent_result ?? null),
    expected_purpose: entry.expected_purpose === '' ? null : (entry.expected_purpose ?? null),
    redaction_hits: countRedactionHits(entry),
    entity_type: entity?.type ?? null,
    entity_id: entity?.id ?? null,
    llm_intent_json: entry.llm_intent ? JSON.stringify(entry.llm_intent) : null,
    error_message: error?.message || null,
    tags: entry.tags ? JSON.stringify(entry.tags) : null,
    raw_json: JSON.stringify(entry),
  };
}
