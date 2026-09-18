import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb, queryEvents } from '../../scripts/lib/db.js';
import { parseNdjson } from '../../scripts/lib/parser.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRuntimeAuditLogger } from '../../src/observability/runtimeAudit.js';

test('runtime audit logger writes run lifecycle events into audit_events', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-runtime-agent' });

  await auditLogger.log({
    runId: 'run_test',
    traceId: 'trace_test',
    event: 'run.start',
    status: 'OK',
    summary: 'Run created',
    requesterId: 'runtime-user', originalRequest: '查询审计日志', expectedPurpose: '汇总任务审计结果',
  });

  const rows = queryEvents(db, { agent_id: 'audit-runtime-agent' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, 'run.start');
  assert.equal(rows[0].result_summary, 'Run created');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runtime audit events round-trip through ndjson parser', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const auditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-runtime-agent' });

  await auditLogger.log({
    runId: 'run_test',
    traceId: 'trace_test',
    event: 'run.start',
    status: 'OK',
    summary: 'Run created',
    requesterId: 'runtime-user', originalRequest: '查询审计日志', expectedPurpose: '汇总任务审计结果',
  });

  await auditLogger.log({
    runId: 'run_test',
    traceId: 'trace_test',
    event: 'run.failed',
    status: 'INTERNAL',
    summary: 'Run failed',
  });

  const rows = queryEvents(db, { agent_id: 'audit-runtime-agent', limit: 10 });
  const content = rows.map((row) => row.raw_json).join('\n');

  const { entries, errors } = parseNdjson(content);

  assert.deepEqual(errors, []);
  assert.equal(entries.length, 2);
  const start = entries.find(entry => entry.event === 'run.start');
  assert.equal(start.expected_purpose, '汇总任务审计结果');
  assert.equal(start.requester_id, 'runtime-user');
  assert.equal(entries.find(entry => entry.event === 'run.failed').agent_result, 'Run failed');
  assert.deepEqual(
    entries.map((entry) => entry.event).sort(),
    ['run.failed', 'run.start'],
  );

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
