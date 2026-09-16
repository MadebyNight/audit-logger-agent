// src/db/reviewSchema.js
export const REVIEW_TABLES = `
CREATE TABLE IF NOT EXISTS audit_traces (
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  requester_id TEXT,
  original_request TEXT,
  expected_purpose TEXT,
  agent_result TEXT,
  context_status TEXT NOT NULL DEFAULT 'unknown',
  trace_status TEXT NOT NULL DEFAULT 'pending',
  risk_level TEXT NOT NULL DEFAULT 'unreviewed',
  risk_reason TEXT,
  evidence_event_ids TEXT,
  first_event_at TEXT,
  last_event_at TEXT,
  ingested_watermark TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  review_input_sampled INTEGER NOT NULL DEFAULT 0,
  omitted_event_count INTEGER NOT NULL DEFAULT 0,
  sealed_at TEXT,
  sealed_reason TEXT,
  review_version INTEGER NOT NULL DEFAULT 0,
  first_reviewed_at TEXT,
  last_reviewed_at TEXT,
  revised_at TEXT,
  revision_count INTEGER NOT NULL DEFAULT 0,
  review_error INTEGER NOT NULL DEFAULT 0,
  review_retry_count INTEGER NOT NULL DEFAULT 0,
  model TEXT,
  prompt_version TEXT,
  input_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, trace_id)
);

CREATE TABLE IF NOT EXISTS audit_trace_scan_cursor (
  cursor_name TEXT PRIMARY KEY,
  last_ingested_at TEXT,
  last_event_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_review_runs (
  review_id TEXT PRIMARY KEY,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  interval_minutes INTEGER,
  scanned_files INTEGER NOT NULL DEFAULT 0,
  inserted_events INTEGER NOT NULL DEFAULT 0,
  parse_error_count INTEGER NOT NULL DEFAULT 0,
  candidate_event_count INTEGER NOT NULL DEFAULT 0,
  finding_count INTEGER NOT NULL DEFAULT 0,
  llm_model TEXT,
  risk_policy_version TEXT NOT NULL,
  prompt_version TEXT,
  reviewer_version TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_review_findings (
  finding_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL,
  finding_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  agent_id TEXT,
  tool_name TEXT,
  trace_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  requires_action INTEGER NOT NULL DEFAULT 0,
  evidence_event_ids_json TEXT NOT NULL,
  evidence_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_notified_at TEXT,
  resolved_at TEXT,
  snoozed_until TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  llm_analysis_json TEXT,
  analysis_generated_at TEXT,
  risk_policy_version TEXT NOT NULL,
  prompt_version TEXT,
  reviewer_version TEXT NOT NULL,
  first_review_id TEXT,
  last_review_id TEXT,
  max_severity TEXT,
  state_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS audit_review_finding_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  recommendation TEXT,
  evidence_event_ids_json TEXT NOT NULL,
  evidence_json TEXT,
  observed_at TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  severity_escalated INTEGER NOT NULL DEFAULT 0,
  reopened INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (finding_id) REFERENCES audit_review_findings(finding_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_finding_actions (
  action_id TEXT PRIMARY KEY,
  finding_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  snoozed_until TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (finding_id) REFERENCES audit_review_findings(finding_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_llm_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_review_locks (
  lock_name TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_ingest_cursors (
  agent_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_mtime_ms INTEGER NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  last_ingested_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (agent_id, file_path)
);

CREATE TABLE IF NOT EXISTS audit_notification_digest_slots (
  slot_key TEXT PRIMARY KEY,
  report_date TEXT NOT NULL,
  slot_hour INTEGER NOT NULL,
  scheduled_for TEXT NOT NULL,
  timezone_offset_minutes INTEGER NOT NULL DEFAULT 0,
  trigger_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  enqueued_count INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  last_error TEXT
);
`;

export const REVIEW_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_findings_hash
ON audit_review_findings(finding_hash);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_review
ON audit_review_findings(review_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_findings_severity
ON audit_review_findings(severity, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_review_occurrences_review_finding
ON audit_review_finding_occurrences(review_id, finding_id);

CREATE INDEX IF NOT EXISTS idx_audit_review_occurrences_finding_observed
ON audit_review_finding_occurrences(finding_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_review_occurrences_review_severity
ON audit_review_finding_occurrences(review_id, severity);

CREATE INDEX IF NOT EXISTS idx_audit_finding_actions_finding_created
ON audit_finding_actions(finding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_notification_digest_slots_scheduled
ON audit_notification_digest_slots(scheduled_for DESC);

CREATE INDEX IF NOT EXISTS idx_audit_notification_digest_slots_status_lease
ON audit_notification_digest_slots(status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_traces_risk
ON audit_traces(risk_level, last_event_at);

CREATE INDEX IF NOT EXISTS idx_audit_traces_seal
ON audit_traces(sealed_at, last_event_at);

CREATE INDEX IF NOT EXISTS idx_audit_traces_status
ON audit_traces(trace_status, last_event_at);

CREATE INDEX IF NOT EXISTS idx_audit_traces_requester
ON audit_traces(agent_id, requester_id, last_event_at);

CREATE INDEX IF NOT EXISTS idx_audit_traces_agent_recent
ON audit_traces(agent_id, last_event_at DESC, trace_id);
`;

function tableExists(db, tableName) {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName) != null;
}

function tableColumns(db, tableName) {
  return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
}

function addColumnIfMissing(db, tableName, columnName, definition) {
  const columns = tableColumns(db, tableName);
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function addAuditEventColumns(db) {
  if (!tableExists(db, 'audit_events')) return;
  addColumnIfMissing(db, 'audit_events', 'requester_id', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'original_request', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'agent_result', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'expected_purpose', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'redaction_hits', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'ingested_at', "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_events_ingested ON audit_events(ingested_at, id);`);
}

function backfillAuditTraces(db) {
  if (!tableExists(db, 'audit_events')) return;
  db.exec(`
    INSERT OR IGNORE INTO audit_traces (
      agent_id, trace_id, requester_id, original_request, expected_purpose, agent_result,
      context_status, trace_status, risk_level, first_event_at, last_event_at,
      ingested_watermark, event_count, sealed_at, sealed_reason, review_version,
      review_error, review_retry_count, updated_at
    )
    SELECT
      agent_id,
      trace_id,
      MAX(COALESCE(requester_id, NULL)),
      MAX(COALESCE(original_request, NULL)),
      MAX(COALESCE(expected_purpose, NULL)),
      MAX(COALESCE(agent_result, NULL)),
      CASE
        WHEN MAX(CASE WHEN COALESCE(TRIM(requester_id), '') <> '' THEN 1 ELSE 0 END) = 1
         AND MAX(CASE WHEN COALESCE(TRIM(original_request), '') <> '' THEN 1 ELSE 0 END) = 1
         AND MAX(CASE WHEN COALESCE(TRIM(agent_result), '') <> '' THEN 1 ELSE 0 END) = 1 THEN 'complete'
        WHEN MAX(CASE WHEN COALESCE(TRIM(requester_id), '') <> '' THEN 1 ELSE 0 END) = 0
         AND MAX(CASE WHEN COALESCE(TRIM(original_request), '') <> '' THEN 1 ELSE 0 END) = 0
         AND MAX(CASE WHEN COALESCE(TRIM(agent_result), '') <> '' THEN 1 ELSE 0 END) = 0 THEN 'unknown'
        ELSE 'incomplete_context'
      END,
      'pending',
      'unreviewed',
      MIN(ts),
      MAX(ts),
      MAX(ingested_at),
      COUNT(*),
      MAX(ts),
      'backfill',
      0,
      0,
      0,
      MAX(ingested_at)
    FROM audit_events
    GROUP BY agent_id, trace_id;
  `);
  const last = db.prepare(`SELECT ingested_at, id FROM audit_events ORDER BY ingested_at DESC, id DESC LIMIT 1`).get();
  if (last) {
    db.prepare(`
      INSERT INTO audit_trace_scan_cursor (cursor_name, last_ingested_at, last_event_id, updated_at)
      VALUES ('trace_aggregation', ?, ?, datetime('now'))
      ON CONFLICT(cursor_name) DO UPDATE SET
        last_ingested_at = COALESCE(last_ingested_at, excluded.last_ingested_at),
        last_event_id = COALESCE(last_event_id, excluded.last_event_id),
        updated_at = excluded.updated_at
    `).run(last.ingested_at, last.id);
  }
}

export function ensureReviewSchema(db) {
  addAuditEventColumns(db);
  db.exec(REVIEW_TABLES);
  backfillAuditTraces(db);
  addColumnIfMissing(db, 'audit_review_findings', 'entity_type', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'entity_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'llm_analysis_json', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'analysis_generated_at', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'first_review_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'last_review_id', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'max_severity', 'TEXT');
  addColumnIfMissing(db, 'audit_review_findings', 'state_version', 'INTEGER NOT NULL DEFAULT 1');
  db.exec(`
    UPDATE audit_review_findings
    SET first_review_id = COALESCE(first_review_id, review_id),
        last_review_id = COALESCE(last_review_id, review_id),
        max_severity = COALESCE(max_severity, severity),
        state_version = COALESCE(state_version, 1);

    INSERT OR IGNORE INTO audit_review_finding_occurrences (
      occurrence_id, finding_id, review_id, severity, title, summary, recommendation,
      evidence_event_ids_json, evidence_json, observed_at,
      is_new, severity_escalated, reopened, created_at
    )
    SELECT
      'occ_' || finding_id,
      finding_id,
      review_id,
      severity,
      title,
      summary,
      recommendation,
      evidence_event_ids_json,
      evidence_json,
      last_seen_at,
      1,
      0,
      0,
      created_at
    FROM audit_review_findings;
  `);
  db.exec(REVIEW_INDEXES);
  db.pragma('foreign_keys = ON');
}
