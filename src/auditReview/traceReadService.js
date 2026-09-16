// Read-only projections shared by the export API and Dashboard.
const TRACE_FILTERS = ['agent_id', 'trace_id', 'requester_id', 'trace_status', 'risk_level', 'context_status'];
const EVENT_FILTERS = ['event', 'tool_name', 'status'];
const ENUMS = {
  trace_status: ['pending', 'success', 'failed', 'interrupted', 'incomplete'],
  risk_level: ['unreviewed', 'none', 'low', 'medium', 'high'],
  context_status: ['complete', 'incomplete_context', 'unknown'],
};

function invalid(code, message) {
  return Object.assign(new Error(message), { code, status: 400 });
}

function parseStoredJson(value) {
  if (value == null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

export function serializeTrace(db, row) {
  const events = db.prepare(`
    SELECT id AS event_id, ts, agent_id, trace_id, span_id, parent_span_id,
      event, tool_name, status, duration_ms, error_message, result_summary,
      requester_id, original_request, expected_purpose, agent_result, llm_intent_json, raw_json
    FROM audit_events WHERE agent_id = ? AND trace_id = ? ORDER BY ts ASC, id ASC
  `).all(row.agent_id, row.trace_id).map(({ llm_intent_json, ...event }) => ({
    ...event, llm_intent: parseStoredJson(llm_intent_json), raw_json: parseStoredJson(event.raw_json),
  }));
  return {
    agent_id: row.agent_id,
    trace_id: row.trace_id,
    requester_id: row.requester_id,
    original_request: row.original_request,
    expected_purpose: row.expected_purpose,
    agent_result: row.agent_result,
    context_status: row.context_status,
    first_event_at: row.first_event_at,
    last_event_at: row.last_event_at,
    sealed_at: row.sealed_at,
    sealed_reason: row.sealed_reason,
    review_input_sampled: Boolean(row.review_input_sampled),
    omitted_event_count: row.omitted_event_count,
    event_count: events.length,
    audit_result: row.review_version > 0 ? {
      trace_status: row.trace_status,
      risk_level: row.risk_level,
      risk_reason: row.risk_reason,
      evidence_event_ids: parseStoredJson(row.evidence_event_ids) ?? [],
      review_version: row.review_version,
      first_reviewed_at: row.first_reviewed_at,
      last_reviewed_at: row.last_reviewed_at,
    } : null,
    events,
  };
}

export function readTraceDetail(db, agentId, traceId) {
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM audit_traces WHERE agent_id = ? AND trace_id = ?').get(agentId, traceId);
    return row ? serializeTrace(db, row) : null;
  })();
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({
    last_event_at: row.last_event_at, agent_id: row.agent_id, trace_id: row.trace_id,
  })).toString('base64url');
}

function decodeCursor(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'agent_id,last_event_at,trace_id'
      || typeof cursor.agent_id !== 'string' || !cursor.agent_id
      || typeof cursor.trace_id !== 'string' || !cursor.trace_id
      || (cursor.last_event_at !== null && (typeof cursor.last_event_at !== 'string'
        || !Number.isFinite(Date.parse(cursor.last_event_at))))) throw new Error();
    return cursor;
  } catch { throw invalid('invalid_cursor', 'Invalid pagination cursor'); }
}

export function readTracePage(db, searchParams, { maxResponseBytes = 4 * 1024 * 1024 } = {}) {
  const allowed = new Set([...TRACE_FILTERS, ...EVENT_FILTERS, 'from', 'to', 'limit', 'cursor', 'with_total']);
  const params = {};
  for (const [key, value] of searchParams) {
    if (key === 'cursor' && (!value.trim() || key in params)) throw invalid('invalid_cursor', 'Invalid pagination cursor');
    if (!allowed.has(key) || key in params || !value.trim()) throw invalid('invalid_filter', `Invalid filter: ${key}`);
    params[key] = value;
  }
  const requestedLimit = params.limit === undefined ? 50 : Number(params.limit);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) throw invalid('invalid_filter', 'limit must be a positive integer');
  const limit = Math.min(requestedLimit, 200);
  if (params.with_total !== undefined && !['true', 'false'].includes(params.with_total)) throw invalid('invalid_filter', 'with_total must be true or false');
  for (const [name, values] of Object.entries(ENUMS)) {
    if (params[name] !== undefined && !values.includes(params[name])) throw invalid('invalid_filter', `Invalid ${name}`);
  }
  for (const name of ['from', 'to']) {
    if (params[name] !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(params[name]) || !Number.isFinite(Date.parse(params[name]))) throw invalid('invalid_filter', `Invalid ${name}`);
      params[name] = new Date(params[name]).toISOString();
    }
  }
  if (params.from && params.to && params.from > params.to) throw invalid('invalid_filter', 'from must not exceed to');
  const cursor = params.cursor === undefined ? null : decodeCursor(params.cursor);
  const predicates = [];
  const bindings = {};
  for (const name of TRACE_FILTERS) {
    if (params[name] !== undefined) { predicates.push(`t.${name} = @${name}`); bindings[name] = params[name]; }
  }
  // Filters select whole traces. Event predicates never trim the returned evidence.
  const eventPredicates = EVENT_FILTERS.filter((name) => params[name] !== undefined).map((name) => {
    bindings[name] = params[name];
    return `e.${name} = @${name}`;
  });
  if (eventPredicates.length) predicates.push(`EXISTS (SELECT 1 FROM audit_events e WHERE e.agent_id=t.agent_id AND e.trace_id=t.trace_id AND ${eventPredicates.join(' AND ')})`);
  if (params.from) { predicates.push('t.last_event_at >= @from'); bindings.from = params.from; }
  if (params.to) { predicates.push('t.last_event_at <= @to'); bindings.to = params.to; }
  const where = predicates.length ? predicates.join(' AND ') : '1=1';

  return db.transaction(() => {
    const total = params.with_total === 'true'
      ? db.prepare(`SELECT COUNT(*) AS count FROM audit_traces t WHERE ${where}`).get(bindings).count : undefined;
    let after = '';
    if (cursor) {
      // Keyset ordering, not a snapshot across HTTP requests: existing traces can move on late ingestion.
      after = ` AND (t.last_event_at < @cursor_time OR (t.last_event_at IS NULL AND @cursor_time IS NOT NULL)
        OR (t.last_event_at IS @cursor_time AND (t.agent_id > @cursor_agent
          OR (t.agent_id = @cursor_agent AND t.trace_id > @cursor_trace))))`;
      Object.assign(bindings, { cursor_time: cursor.last_event_at, cursor_agent: cursor.agent_id, cursor_trace: cursor.trace_id });
    }
    const rows = db.prepare(`SELECT t.* FROM audit_traces t WHERE ${where}${after}
      ORDER BY t.last_event_at DESC, t.agent_id ASC, t.trace_id ASC LIMIT @page_limit`).all({ ...bindings, page_limit: limit + 1 });
    const traces = [];
    const response = (hasMore) => ({
      count: traces.length, traces, next_cursor: hasMore ? encodeCursor(rows[traces.length - 1]) : null,
      has_more: hasMore, limit_applied: limit, ...(total === undefined ? {} : { total_count: total }),
    });
    for (const row of rows.slice(0, limit)) {
      traces.push(serializeTrace(db, row));
      // A single trace is indivisible. Let the first exceed the soft budget so every page advances.
      if (traces.length > 1 && Buffer.byteLength(JSON.stringify(response(rows.length > traces.length))) > maxResponseBytes) {
        traces.pop();
        break;
      }
    }
    return response(rows.length > traces.length);
  })();
}

export function traceHealth(db, { now = new Date(), maxInvalidOutputRetries = 2 } = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_traces'").get()) return null;
  const counts = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(sealed_at IS NOT NULL), 0) AS sealed,
    COALESCE(SUM(sealed_at IS NULL), 0) AS unsealed,
    COALESCE(SUM(review_version > 0), 0) AS reviewed,
    COALESCE(SUM(NOT ((trace_status='pending' AND risk_level='unreviewed')
      OR (trace_status='success' AND risk_level IN ('none','low','medium'))
      OR (trace_status IN ('failed','interrupted') AND risk_level='high')
      OR (trace_status='incomplete' AND risk_level IN ('none','low')))), 0) AS invalid_combinations,
    COALESCE(SUM(sealed_at IS NOT NULL AND review_error=1
      AND review_retry_count >= ?), 0) AS review_retries_exhausted
    FROM audit_traces`).get(maxInvalidOutputRetries);
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const redaction = db.prepare(`SELECT agent_id, SUM(CAST(redaction_hits AS INTEGER)) AS redaction_hits
    FROM audit_events WHERE COALESCE(ingested_at, ts) >= ? AND CAST(redaction_hits AS INTEGER) > 0
    GROUP BY agent_id ORDER BY agent_id`).all(since);
  return { ...counts, redaction_since: since,
    redaction_hits_by_agent: redaction };
}
