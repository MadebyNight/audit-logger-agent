import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { normalizeEventId } from '../scripts/lib/auditSpec.js';
import { openDb, insertEvents, queryEvents } from '../scripts/lib/db.js';
import { normalizeEntry, parseNdjson, validateLogEntry } from '../scripts/lib/parser.js';

function validEntry(overrides = {}) {
  return {
    ts: '2026-07-06T01:02:03.000Z',
    agent_id: 'agent-1',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'OK',
    result_summary: 'done',
    entity: { type: 'document', id: 'doc-1' },
    ...overrides,
  };
}

function parseOne(entry, options) {
  return parseNdjson(`${JSON.stringify(entry)}\n`, options);
}

function validationErrors(entry, options) {
  return validateLogEntry(entry, 1, options);
}

function assertErrorCode(errors, code, field) {
  const error = errors.find((item) => item.code === code && item.field === field);
  assert.ok(error, `missing ${code} ${field}: ${JSON.stringify(errors)}`);
}

test('normalizeEventId maps known aliases to canonical event ids only', () => {
  assert.equal(normalizeEventId('tool.end'), 'tool.end');
  assert.equal(normalizeEventId('tool/end'), 'tool.end');
  assert.equal(normalizeEventId('tool_end'), 'tool.end');
  assert.equal(normalizeEventId('tool-end'), 'tool.end');
  assert.equal(normalizeEventId('review-notification-enqueued'), 'review.notification.enqueued');
  assert.equal(normalizeEventId('tool/unknown'), null);
});

test('parser accepts canonical audit event fields and normalizes entity and llm_intent', () => {
  const { entries, errors } = parseOne(validEntry({
    parent_span_id: null,
    user_id: '',
    llm_intent: { input: 'summarize request', output: 'return concise answer' },
    error: { message: 'not used for OK' },
  }));

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);

  const row = normalizeEntry(entries[0]);
  assert.equal(row.status, 'OK');
  assert.equal(row.parent_span_id, null);
  assert.equal(row.user_id, null);
  assert.equal(row.entity_type, 'document');
  assert.equal(row.entity_id, 'doc-1');
  assert.equal(row.error_message, 'not used for OK');
  assert.equal(row.llm_intent_json, JSON.stringify({ input: 'summarize request', output: 'return concise answer' }));
  assert.equal(Object.hasOwn(row, 'product_id'), false);
  assert.equal(Object.hasOwn(row, 'error_code'), false);
});

test('parser accepts alias event ids and stores canonical event while preserving raw event', () => {
  const entry = validEntry({ event: 'tool/end' });
  const { entries, errors } = parseOne(entry);

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'tool/end');

  const row = normalizeEntry(entries[0]);
  assert.equal(row.event, 'tool.end');
  assert.equal(JSON.parse(row.raw_json).event, 'tool/end');
});

test('parser rejects legacy and malformed audit fields', () => {
  const cases = [
    ['legacy product_id', validEntry({ product_id: 'prod-1' }), /product_id/],
    ['legacy error.code', validEntry({ status: 'INTERNAL', error: { code: 'boom', message: 'boom' } }), /error\.code/],
    ['non-string parent_span_id', validEntry({ parent_span_id: 123 }), /parent_span_id/],
    ['non-string user_id', validEntry({ user_id: 123 }), /user_id/],
    ['incomplete entity', validEntry({ entity: { type: 'document' } }), /entity/],
    ['bad llm_intent', validEntry({ llm_intent: { input: 'x', output: 1 } }), /llm_intent/],
    ['non-canonical status', validEntry({ status: 'error' }), /status/],
  ];

  for (const [name, entry, pattern] of cases) {
    const { entries, errors } = parseOne(entry);
    assert.equal(entries.length, 0, name);
    assert.ok(errors.some((error) => pattern.test(error)), `${name}: ${errors.join('; ')}`);
  }
});

test('parser accepts unknown lifecycle events as unknown while preserving raw event', () => {
  const entry = validEntry({ event: 'tool/unknown' });
  const { entries, errors } = parseOne(entry);

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'tool/unknown');

  const row = normalizeEntry(entries[0]);
  assert.equal(row.event, 'unknown');
  assert.equal(JSON.parse(row.raw_json).event, 'tool/unknown');
});

test('insertEvents stores canonical event and preserves original raw event for dedupe traceability', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-event-alias-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    const row = normalizeEntry(validEntry({
      trace_id: 'trace-alias',
      event: 'tool_end',
    }));

    assert.equal(row.event, 'tool.end');
    assert.equal(JSON.parse(row.raw_json).event, 'tool_end');
    assert.equal(insertEvents(db, [row]), 1);

    const stored = queryEvents(db, { trace_id: 'trace-alias' });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].event, 'tool.end');
    assert.equal(JSON.parse(stored[0].raw_json).event, 'tool_end');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('insertEvents stores entity and llm_intent columns and queryEvents filters by entity', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-spec-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    const row = normalizeEntry(validEntry({
      trace_id: 'trace-entity',
      llm_intent: { input: 'look up doc', output: 'doc answer' },
    }));

    assert.equal(insertEvents(db, [row]), 1);

    const byEntity = queryEvents(db, { entity_type: 'document', entity_id: 'doc-1' });
    assert.equal(byEntity.length, 1);
    assert.equal(byEntity[0].trace_id, 'trace-entity');
    assert.equal(byEntity[0].entity_type, 'document');
    assert.equal(byEntity[0].entity_id, 'doc-1');
    assert.equal(byEntity[0].llm_intent_json, JSON.stringify({ input: 'look up doc', output: 'doc answer' }));

    const missing = queryEvents(db, { entity_type: 'document', entity_id: 'doc-2' });
    assert.equal(missing.length, 0);

    const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((column) => column.name);
    assert.ok(columns.includes('entity_type'));
    assert.ok(columns.includes('entity_id'));
    assert.ok(columns.includes('llm_intent_json'));
    assert.ok(columns.includes('mapped_tool_type'));
    assert.ok(columns.includes('mapping_status'));
    assert.ok(columns.includes('mapping_reason'));
    assert.ok(columns.includes('mapping_model'));
    assert.ok(columns.includes('mapping_version'));
    assert.ok(columns.includes('mapped_at'));
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('insertEvents stores task-level fields and missing fields remain null', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-task-fields-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    const complete = normalizeEntry(validEntry({
      trace_id: 'trace-task-complete',
      event: 'run.start',
      requester_id: 'user-1',
      original_request: 'summarize report',
      expected_purpose: 'review summary quality',
      agent_result: 'summary delivered',
    }));

    const missing = normalizeEntry(validEntry({
      trace_id: 'trace-task-missing',
      span_id: 'span-task-missing',
    }));

    assert.equal(insertEvents(db, [complete, missing]), 2);

    const stored = queryEvents(db, { trace_id: 'trace-task-complete' })[0];
    assert.equal(stored.requester_id, 'user-1');
    assert.equal(stored.original_request, 'summarize report');
    assert.equal(stored.expected_purpose, 'review summary quality');
    assert.equal(stored.agent_result, 'summary delivered');

    const empty = queryEvents(db, { trace_id: 'trace-task-missing' })[0];
    assert.equal(empty.requester_id, null);
    assert.equal(empty.original_request, null);
    assert.equal(empty.expected_purpose, null);
    assert.equal(empty.agent_result, null);

    const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((column) => column.name);
    for (const column of ['requester_id', 'original_request', 'expected_purpose', 'agent_result']) {
      assert.ok(columns.includes(column), `${column} should exist`);
    }
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test('queryEvents filters by mapped tool type and mapping status', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-mapping-query-db-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));
  try {
    insertEvents(db, [
      {
        ...normalizeEntry(validEntry({ trace_id: 'trace-delete', tool_name: 'db.delete' })),
        mapped_tool_type: 'delete',
        mapping_status: 'mapped',
      },
      {
        ...normalizeEntry(validEntry({ trace_id: 'trace-unknown', tool_name: 'custom.action' })),
        mapped_tool_type: 'unknown',
        mapping_status: 'unknown',
      },
    ]);

    const deletes = queryEvents(db, { mapped_tool_type: 'delete', mapping_status: 'mapped' });
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].trace_id, 'trace-delete');

    const unknown = queryEvents(db, { mapped_tool_type: 'unknown' });
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].trace_id, 'trace-unknown');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('openDb migrates legacy audit_events before creating entity index', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-legacy-db-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  let db = openDb(dbPath);
  try {
    db.exec('DROP INDEX IF EXISTS idx_audit_entity;');
    db.exec('DROP TABLE audit_events;');
    db.exec(`
      CREATE TABLE audit_events (
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
        error_message TEXT,
        tags TEXT,
        raw_json TEXT
      );
    `);
  } finally {
    db.close();
  }

  db = openDb(dbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(audit_events)').all().map((column) => column.name);
    assert.ok(columns.includes('entity_type'));
    assert.ok(columns.includes('entity_id'));
    assert.ok(columns.includes('llm_intent_json'));
    assert.ok(columns.includes('mapped_tool_type'));
    assert.ok(columns.includes('mapping_status'));
    assert.ok(columns.includes('mapping_reason'));
    assert.ok(columns.includes('mapping_model'));
    assert.ok(columns.includes('mapping_version'));
    assert.ok(columns.includes('mapped_at'));
    const index = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name = 'idx_audit_entity'
    `).get();
    assert.equal(index.name, 'idx_audit_entity');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('optional Span migration preserves legacy rows, evidence references, indexes and sequence across reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-span-migration-'));
  const file = path.join(directory, 'audit.db');
  let db = openDb(file);
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_events'").get().sql;
    db.exec('DROP TABLE audit_events');
    db.exec(schema.replace('span_id TEXT,', 'span_id TEXT NOT NULL,'));
    insertEvents(db, [normalizeEntry(validEntry())]);
    db.exec('CREATE INDEX custom_trace_index ON audit_events(trace_id, ts)');
    db.exec('CREATE TABLE evidence_ref(event_id INTEGER REFERENCES audit_events(id))');
    db.exec('INSERT INTO evidence_ref VALUES (1)');
    db.prepare("UPDATE sqlite_sequence SET seq=80 WHERE name='audit_events'").run();
    const original = db.prepare('SELECT * FROM audit_events').get();
    db.close();
    db = openDb(file);
    assert.deepEqual(db.prepare('SELECT * FROM audit_events').get(), original);
    assert.equal(db.prepare('PRAGMA table_info(audit_events)').all().find(c => c.name === 'span_id').notnull, 0);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='custom_trace_index'").get());
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const row = normalizeEntry(validEntry({ trace_id: 'no-span', span_id: undefined }));
    assert.equal(insertEvents(db, [row]), 1);
    assert.equal(db.prepare("SELECT id FROM audit_events WHERE trace_id='no-span'").get().id, 81);
    db.close();
    db = openDb(file);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 2);
    assert.equal(insertEvents(db, [row]), 0);
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('failed optional Span migration rolls back and closes its connection', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-span-rollback-'));
  const file = path.join(directory, 'audit.db');
  let db = openDb(file);
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='audit_events'").get().sql;
    db.exec('DROP TABLE audit_events');
    db.exec(schema.replace('span_id TEXT,', 'span_id TEXT NOT NULL,'));
    insertEvents(db, [normalizeEntry(validEntry())]);
    const original = db.prepare('SELECT * FROM audit_events').get();
    db.pragma('foreign_keys = OFF');
    db.exec('CREATE TABLE evidence_ref(event_id INTEGER REFERENCES audit_events(id))');
    db.exec('INSERT INTO evidence_ref VALUES (999)');
    db.close();
    assert.throws(() => openDb(file), /foreign key validation/);
    db = new Database(file);
    assert.deepEqual(db.prepare('SELECT * FROM audit_events').get(), original);
    assert.equal(db.prepare('PRAGMA table_info(audit_events)').all().find(c => c.name === 'span_id').notnull, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='audit_events_span_migration'").get().n, 0);
    db.exec('UPDATE evidence_ref SET event_id=1');
    db.close();
    db = openDb(file);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('task fields have one strict contract, including purpose on run.start', () => {
  const start = validEntry({ event: 'run.start', requester_id: 'user-1', original_request: 'request', expected_purpose: 'purpose' });
  assert.deepEqual(parseOne(start).errors, []);
  // Semantic quality is reviewed with task evidence, not rejected by string equality.
  assert.deepEqual(parseOne({ ...start, expected_purpose: start.original_request }).errors, []);
  for (const field of ['requester_id', 'original_request', 'expected_purpose']) {
    for (const value of [undefined, null, '', '  ']) {
      assertErrorCode(validationErrors({ ...start, [field]: value }), 'missing_required_task_field', field);
    }
  }
  // Obsolete caller options cannot weaken the contract.
  assertErrorCode(parseOne({ ...start, expected_purpose: undefined }, { mode: 'compat' }).errors, 'missing_required_task_field', 'expected_purpose');
  for (const event of ['run.final_result', 'run.failed']) {
    assertErrorCode(validationErrors(validEntry({ event })), 'missing_required_task_field', 'agent_result');
    assert.deepEqual(validationErrors(validEntry({ event, agent_result: 'done' })), []);
  }
});

test('task fields enforce type and length limits', () => {
  const base = validEntry({ event: 'run.start', requester_id: 'user-1', original_request: 'request', expected_purpose: 'purpose' });
  for (const [field, maxLength] of Object.entries({ requester_id: 128, original_request: 2000, expected_purpose: 1000, agent_result: 2000 })) {
    assert.deepEqual(validationErrors({ ...base, [field]: 'x'.repeat(maxLength) }), []);
    assertErrorCode(validationErrors({ ...base, [field]: 'x'.repeat(maxLength + 1) }), 'field_too_long', field);
    assertErrorCode(validationErrors({ ...base, [field]: {} }), 'invalid_field_type', field);
  }
});

test('Span fields are optional, validated when provided, and not synthesized', () => {
  for (const field of ['span_id', 'parent_span_id']) {
    for (const value of [undefined, null, 'span-valid']) assert.deepEqual(validationErrors(validEntry({ [field]: value })), []);
    for (const value of ['', '  ', 123, {}, []]) assert.ok(validationErrors(validEntry({ [field]: value })).some(error => String(error).includes(field)));
  }
  const event = validEntry({ span_id: undefined, parent_span_id: undefined });
  const row = normalizeEntry(event);
  assert.equal(row.span_id, null);
  assert.equal(row.parent_span_id, null);
  assert.equal(Object.hasOwn(JSON.parse(row.raw_json), 'span_id'), false);
  const db = openDb(':memory:');
  try { assert.equal(insertEvents(db, [row]), 1); assert.equal(queryEvents(db, {})[0].span_id, null); }
  finally { db.close(); }
});
