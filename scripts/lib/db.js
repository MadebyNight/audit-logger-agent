import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  duration_ms INTEGER,
  channel TEXT,
  user_id TEXT,
  requester_id TEXT,
  original_request TEXT,
  agent_result TEXT,
  expected_purpose TEXT,
  entity_type TEXT,
  entity_id TEXT,
  llm_intent_json TEXT,
  error_message TEXT,
  tags TEXT,
  mapped_tool_type TEXT,
  mapping_status TEXT,
  mapping_reason TEXT,
  mapping_model TEXT,
  mapping_version TEXT,
  mapped_at TEXT,
  raw_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_tool ON audit_events(tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_trace ON audit_events(trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_span ON audit_events(span_id);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_events(status);
`;

import crypto from 'crypto';

const DEFAULT_QUERY_LIMIT = 100;
const DEFAULT_MAX_QUERY_LIMIT = 1000;
export const DEFAULT_REPORT_TIMEZONE_OFFSET_MINUTES = 480;

function hashRow(rawJson) {
  return crypto.createHash('sha256').update(rawJson).digest('hex').slice(0, 16);
}

function clampPositiveInteger(value, defaultValue, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  const integer = Math.floor(parsed);
  if (integer < 1) return 1;
  return Math.min(integer, maxValue);
}

function clampOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function configuredMaxQueryLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_QUERY_LIMIT;
  return Math.floor(parsed);
}

export function reportTimezoneOffsetMinutes(value) {
  const raw = typeof value === 'object' && value !== null
    ? value.report?.timezoneOffsetMinutes ?? value.reportTimezoneOffsetMinutes
    : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < -1440 || parsed > 1440) {
    return DEFAULT_REPORT_TIMEZONE_OFFSET_MINUTES;
  }
  return Math.trunc(parsed);
}

export function reportDateForNow(now = new Date(), timezoneOffsetMinutes = DEFAULT_REPORT_TIMEZONE_OFFSET_MINUTES) {
  const offset = reportTimezoneOffsetMinutes(timezoneOffsetMinutes);
  return new Date(now.getTime() + offset * 60 * 1000).toISOString().slice(0, 10);
}

function sqliteTimezoneModifier(timezoneOffsetMinutes) {
  const offset = reportTimezoneOffsetMinutes(timezoneOffsetMinutes);
  const sign = offset >= 0 ? '+' : '-';
  return `${sign}${Math.abs(offset)} minutes`;
}

export function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -8000');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrateAuditEvents(db);
  return db;
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row.name === column);
}

function tableExists(db, table) {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) != null;
}

function addColumnIfMissing(db, table, column, definition) {
  if (!tableExists(db, table)) return;
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function migrateAuditEvents(db) {
  addColumnIfMissing(db, 'audit_events', 'requester_id', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'original_request', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'agent_result', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'expected_purpose', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'entity_type', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'entity_id', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'llm_intent_json', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapped_tool_type', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapping_status', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapping_reason', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapping_model', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapping_version', 'TEXT');
  addColumnIfMissing(db, 'audit_events', 'mapped_at', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_tool_mapping ON audit_events(mapped_tool_type, mapping_status);');
}

export function insertEvents(db, events) {
  const tableColumnNames = new Set(db.prepare('PRAGMA table_info(audit_events)').all().map((row) => row.name));
  const insertColumns = [
    'row_hash',
    'ts',
    'agent_id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'event',
    'tool_name',
    'status',
    'result_summary',
    'duration_ms',
    'channel',
    'user_id',
    'requester_id',
    'original_request',
    'agent_result',
    'expected_purpose',
    'entity_type',
    'entity_id',
    'llm_intent_json',
    'error_message',
    'tags',
    'mapped_tool_type',
    'mapping_status',
    'mapping_reason',
    'mapping_model',
    'mapping_version',
    'mapped_at',
    'raw_json',
  ].filter((column) => tableColumnNames.has(column));
  const placeholders = insertColumns.map((column) => `@${column}`).join(', ');
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO audit_events
      (${insertColumns.join(', ')})
    VALUES
      (${placeholders})
  `);

  const insertMany = db.transaction((rows) => {
    let count = 0;
    for (const row of rows) {
      const rowHash = hashRow(row.raw_json);
      const values = {
        requester_id: null,
        original_request: null,
        agent_result: null,
        expected_purpose: null,
        entity_type: null,
        entity_id: null,
        llm_intent_json: null,
        error_message: null,
        tags: null,
        mapped_tool_type: null,
        mapping_status: null,
        mapping_reason: null,
        mapping_model: null,
        mapping_version: null,
        mapped_at: null,
        ...row,
        row_hash: rowHash,
      };
      const filteredValues = Object.fromEntries(insertColumns.map((column) => [column, values[column]]));
      const info = stmt.run(filteredValues);
      if (info.changes > 0) count++;
    }
    return count;
  });

  return insertMany(events);
}

export function listEventsNeedingToolMapping(db, { limit = 500, from, to } = {}) {
  const conditions = ['(mapped_tool_type IS NULL OR mapping_status IS NULL)'];
  const params = { limit: clampPositiveInteger(limit, DEFAULT_QUERY_LIMIT, 5000) };
  if (from) {
    conditions.push('ts >= @from');
    params.from = from;
  }
  if (to) {
    conditions.push('ts <= @to');
    params.to = to;
  }
  return db.prepare(`
    SELECT id, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name,
           status, result_summary, duration_ms, channel, user_id, entity_type,
           entity_id, llm_intent_json, error_message, tags, raw_json
    FROM audit_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY ts ASC
    LIMIT @limit
  `).all(params);
}

export function updateEventToolMapping(db, eventId, mapping) {
  return db.prepare(`
    UPDATE audit_events
    SET mapped_tool_type = @mapped_tool_type,
        mapping_status = @mapping_status,
        mapping_reason = @mapping_reason,
        mapping_model = @mapping_model,
        mapping_version = @mapping_version,
        mapped_at = @mapped_at
    WHERE id = @event_id
  `).run({
    event_id: eventId,
    mapped_tool_type: mapping.mapped_tool_type,
    mapping_status: mapping.mapping_status,
    mapping_reason: mapping.mapping_reason ?? null,
    mapping_model: mapping.mapping_model ?? null,
    mapping_version: mapping.mapping_version ?? null,
    mapped_at: mapping.mapped_at,
  });
}

export function queryEvents(db, filters = {}, options = {}) {
  const conditions = [];
  const params = {};

  if (filters.agent_id) {
    conditions.push('agent_id = @agent_id');
    params.agent_id = filters.agent_id;
  }
  if (filters.tool_name) {
    if (filters.tool_name.includes('%')) {
      conditions.push('tool_name LIKE @tool_name');
    } else {
      conditions.push('tool_name = @tool_name');
    }
    params.tool_name = filters.tool_name;
  }
  if (filters.status) {
    conditions.push('status = @status');
    params.status = filters.status;
  }
  if (filters.event) {
    conditions.push('event = @event');
    params.event = filters.event;
  }
  if (filters.from) {
    conditions.push('ts >= @from');
    params.from = filters.from;
  }
  if (filters.to) {
    conditions.push('ts <= @to');
    params.to = filters.to;
  }
  if (filters.trace_id) {
    conditions.push('trace_id = @trace_id');
    params.trace_id = filters.trace_id;
  }
  if (filters.entity_type) {
    conditions.push('entity_type = @entity_type');
    params.entity_type = filters.entity_type;
  }
  if (filters.entity_id) {
    conditions.push('entity_id = @entity_id');
    params.entity_id = filters.entity_id;
  }
  if (filters.channel) {
    conditions.push('channel = @channel');
    params.channel = filters.channel;
  }
  if (filters.mapped_tool_type) {
    conditions.push('mapped_tool_type = @mapped_tool_type');
    params.mapped_tool_type = filters.mapped_tool_type;
  }
  if (filters.mapping_status) {
    conditions.push('mapping_status = @mapping_status');
    params.mapping_status = filters.mapping_status;
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const maxQueryLimit = configuredMaxQueryLimit(options.maxQueryLimit);
  const limit = filters.limit == null
    ? DEFAULT_QUERY_LIMIT
    : clampPositiveInteger(filters.limit, DEFAULT_QUERY_LIMIT, maxQueryLimit);
  const offset = clampOffset(filters.offset);

  const sql = `SELECT * FROM audit_events ${where} ORDER BY ts DESC LIMIT @limit OFFSET @offset`;
  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params);
}

export function dailySummary(db, date, agentId, options = {}) {
  const timezoneOffsetMinutes = reportTimezoneOffsetMinutes(options.timezoneOffsetMinutes);
  const where = ['date(ts, @timezoneModifier) = @date'];
  const params = { date, timezoneModifier: sqliteTimezoneModifier(timezoneOffsetMinutes) };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT agent_id, tool_name, status, COUNT(*) as count
    FROM audit_events
    WHERE ${where.join(' AND ')}
    GROUP BY agent_id, tool_name, status
    ORDER BY agent_id, tool_name, status
  `).all(params);
}

export function errorReport(db, from, to, agentId) {
  const where = ['status <> \'OK\'', 'ts >= @from', 'ts <= @to'];
  const params = { from, to };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT ts, agent_id, tool_name, status, error_message, result_summary, trace_id, entity_type, entity_id
    FROM audit_events
    WHERE ${where.join(' AND ')}
    ORDER BY ts DESC
  `).all(params);
}

export function toolUsageStats(db, from, to, agentId) {
  const where = ['event IN (\'tool.end\', \'tool.error\')', 'ts >= @from', 'ts <= @to'];
  const params = { from, to };
  if (agentId) { where.push('agent_id = @agentId'); params.agentId = agentId; }
  return db.prepare(`
    SELECT
      agent_id,
      tool_name,
      COUNT(*) as total,
      SUM(CASE WHEN status = 'OK' THEN 1 ELSE 0 END) as ok_count,
      SUM(CASE WHEN status <> 'OK' THEN 1 ELSE 0 END) as error_count,
      ROUND(AVG(duration_ms), 0) as avg_duration_ms,
      MAX(duration_ms) as max_duration_ms
    FROM audit_events
    WHERE ${where.join(' AND ')}
    GROUP BY agent_id, tool_name
    ORDER BY total DESC
  `).all(params);
}
