import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService, readIncrementalChunk } from '../../src/auditReview/ingestService.js';

// scanLogFiles currently resolves `path` from the global scope.
globalThis.path = path;

// Make a minimal valid NDJSON line with overridable fields.
function makeLine(overrides = {}) {
  const base = {
    ts: '2026-07-03T10:00:00.000Z',
    agent_id: 'test-agent',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.start',
    tool_name: 'example.tool',
    status: 'OK',
    result_summary: 'ok',
  };
  return JSON.stringify({ ...base, ...overrides });
}

function makeConfig(logDir, dbPath) {
  const rootDir = path.dirname(dbPath);
  return {
    rootDir,
    dbPath,
    ingest: {
      spoolDir: path.relative(rootDir, path.dirname(logDir)),
    },
  };
}

// Create the audit_events + v1.4 review/cursor schema on an in-memory db.
function makeDb() {
  const db = new Database(':memory:');
  // Reuse the production schema for audit_events:
  openDbSchemaOnly(db);
  // ensureReviewSchema creates audit_ingest_cursors (and the other review tables).
  ensureReviewSchema(db);
  return db;
}

// openDb writes to disk; we only need the schema on an in-memory db, so inline it.
function openDbSchemaOnly(db) {
  db.exec(`
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
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_events(agent_id);
  `);
}

test('ingestSince: initial ingest reads whole file and reports parse errors', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-'));
  try {
    const logDir = path.join(tmpDir, 'incoming', 'test-agent');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');
    const content = [
      makeLine({ trace_id: 't1', span_id: 's1' }),
      makeLine({ trace_id: 't2', span_id: 's2' }),
      '{ this is not valid json',
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, content, 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const config = makeConfig(logDir, dbPath);
    const svc = createAuditIngestService({ db, config, cursorStore });

    const result = svc.ingestSince({ sinceDate: '2026-07-03', reviewId: 'rev-1' });

    assert.equal(result.scannedFiles, 1, 'should scan exactly one file');
    assert.ok(result.inserted >= 2, 'should insert at least 2 events');
    assert.equal(result.parseErrors.length, 1, 'should record 1 parse error');
    assert.equal(result.parseErrors[0].agent_id, 'test-agent');
    assert.equal(result.parseErrors[0].file, 'audit-2026-07-03.jsonl');
    assert.ok(result.cursorUpdates >= 1, 'cursor should be upserted');

    const cursor = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    assert.ok(cursor, 'cursor must exist after ingest');
    assert.equal(cursor.file_size_bytes, Buffer.byteLength(content, 'utf-8'));
    // File ends with '\n' so offset should equal size (all consumed).
    assert.equal(cursor.offset_bytes, cursor.file_size_bytes);
    assert.ok(cursor.last_error, 'cursor should record a parse-error summary');

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestSince: incremental append only reads new complete line, holds back partial', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-inc-'));
  try {
    const logDir = path.join(tmpDir, 'incoming', 'test-agent');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');

    // Initial: two valid lines with trailing newline.
    const initial = [
      makeLine({ trace_id: 't1', span_id: 's1' }),
      makeLine({ trace_id: 't2', span_id: 's2' }),
    ].join('\n') + '\n';
    fs.writeFileSync(logFile, initial, 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const config = makeConfig(logDir, dbPath);
    const svc = createAuditIngestService({ db, config, cursorStore });

    // First pass.
    const r1 = svc.ingestSince({ sinceDate: '2026-07-03', reviewId: 'rev-1' });
    assert.ok(r1.inserted >= 2);
    assert.equal(r1.scannedFiles, 1);
    const cursor1 = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    assert.equal(cursor1.offset_bytes, cursor1.file_size_bytes);

    // Append: one complete line (with newline) + one valid JSON line WITHOUT trailing
    // newline (a "partial line" in the incremental-protocol sense — held back until a
    // newline terminator arrives).
    const appendedComplete = makeLine({ trace_id: 't3', span_id: 's3' }) + '\n';
    const appendedPartial = makeLine({ trace_id: 't4', span_id: 's4' }); // valid JSON, no newline
    fs.appendFileSync(logFile, appendedComplete + appendedPartial, 'utf-8');

    const r2 = svc.ingestSince({ sinceDate: '2026-07-03', reviewId: 'rev-2' });
    assert.ok(
      r2.inserted >= 1,
      `second run should insert the newly appended complete line, got ${r2.inserted}`
    );
    assert.equal(r2.scannedFiles, 1, 'still scanning one file');
    assert.equal(
      r2.parseErrors.length, 0,
      'partial line must not be parsed this round (no parse errors expected)'
    );

    const cursor2 = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    const newTotalSize = cursor2.file_size_bytes;
    // Offset must be strictly less than size: the partial bytes are held back.
    assert.ok(
      cursor2.offset_bytes < newTotalSize,
      `cursor offset ${cursor2.offset_bytes} must be < size ${newTotalSize} (partial line held back)`
    );
    // And specifically, the held-back bytes equal the partial-line length.
    const heldBack = newTotalSize - cursor2.offset_bytes;
    assert.equal(heldBack, Buffer.byteLength(appendedPartial, 'utf-8'));

    // Third round: complete the partial line by appending a newline (no new content).
    fs.appendFileSync(logFile, '\n', 'utf-8');
    const r3 = svc.ingestSince({ sinceDate: '2026-07-03', reviewId: 'rev-3' });
    assert.ok(r3.inserted >= 1, 'now-partial line should be parsed and inserted');
    const cursor3 = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    assert.equal(cursor3.offset_bytes, cursor3.file_size_bytes,
      'after trailing newline, cursor should reach end of file');

    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestSince: events without task fields remain compatible as null values', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-legacy-fields-'));
  try {
    const logDir = path.join(tmpDir, 'incoming', 'test-agent');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');
    fs.writeFileSync(logFile, makeLine({ trace_id: 'legacy-fields', span_id: 's1' }) + '\n', 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const svc = createAuditIngestService({ db, config: makeConfig(logDir, dbPath), cursorStore });

    const result = svc.ingestSince({ sinceDate: '2026-07-03' });
    assert.equal(result.inserted, 1);

    const stored = db.prepare(`
      SELECT requester_id, original_request, agent_result, expected_purpose
      FROM audit_events
      WHERE trace_id = 'legacy-fields'
    `).get();
    assert.equal(stored.requester_id, null);
    assert.equal(stored.original_request, null);
    assert.equal(stored.agent_result, null);
    assert.equal(stored.expected_purpose, null);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test('ingestSince: missing log directory is skipped without throwing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-missing-'));
  try {
    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const config = {
      dbPath,
      ingest: {
        spoolDir: path.join(tmpDir, 'does', 'not', 'exist'),
      },
    };
    const svc = createAuditIngestService({ db, config, cursorStore });
    const r = svc.ingestSince({ sinceDate: '2026-07-03' });
    assert.equal(r.scannedFiles, 0);
    assert.equal(r.inserted, 0);
    assert.equal(r.parseErrors.length, 0);
    assert.equal(r.cursorUpdates, 0);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ingestSince: file truncated/rotated is re-read from offset 0', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-ingest-rot-'));
  try {
    const logDir = path.join(tmpDir, 'incoming', 'test-agent');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'audit-2026-07-03.jsonl');

    const initial = makeLine({ trace_id: 't1', span_id: 's1' }) + '\n'
      + makeLine({ trace_id: 't2', span_id: 's2' }) + '\n';
    fs.writeFileSync(logFile, initial, 'utf-8');

    const dbPath = path.join(tmpDir, 'audit.db');
    const db = makeDb();
    const cursorStore = createIngestCursorStore(db);
    const config = makeConfig(logDir, dbPath);
    const svc = createAuditIngestService({ db, config, cursorStore });

    const r1 = svc.ingestSince({ sinceDate: '2026-07-03' });
    assert.ok(r1.inserted >= 2);

    // Truncate the file to a smaller single-line file.
    const truncated = makeLine({ trace_id: 'tNew', span_id: 'sNew' }) + '\n';
    fs.writeFileSync(logFile, truncated, 'utf-8');

    const r2 = svc.ingestSince({ sinceDate: '2026-07-03' });
    // The truncated file's single line is brand-new content -> at least 1 insert.
    assert.ok(r2.inserted >= 1, `expected >=1 insert after rotation, got ${r2.inserted}`);

    const cursor = cursorStore.get({ agentId: 'test-agent', filePath: logFile });
    assert.equal(cursor.offset_bytes, cursor.file_size_bytes);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('readIncrementalChunk: returns empty chunk when offset >= size', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-chunk-'));
  try {
    const f = path.join(tmpDir, 'audit-2026-07-03.jsonl');
    fs.writeFileSync(f, 'hello\nworld\n', 'utf-8');
    const stat = fs.statSync(f);
    const r = readIncrementalChunk(f, stat.size);
    assert.equal(r.chunk, '');
    assert.equal(r.size, stat.size);
    assert.equal(r.mtimeMs, stat.mtimeMs);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
