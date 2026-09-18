import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, insertEvents, dailySummary } from '../../scripts/lib/db.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

function makeEvent({ ts, traceId, status = 'OK' }) {
  const event = {
    ts,
    agent_id: 'tz-agent',
    trace_id: traceId,
    span_id: `span-${traceId}`,
    event: 'tool.end',
    tool_name: 'tz.tool',
    status,
    result_summary: traceId,
  };
  return {
    ...event,
    parent_span_id: null,
    duration_ms: null,
    channel: null,
    user_id: null,
    entity_type: null,
    entity_id: null,
    llm_intent_json: null,
    error_message: null,
    tags: null,
    raw_json: JSON.stringify(event),
  };
}

async function withReportServer({ db, config, now }, fn) {
  const server = createHttpApp({ db, config, now });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('dailySummary groups events by configured report timezone offset', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-tz-'));
  const db = openDb(path.join(tmpDir, 'audit.db'));

  try {
    insertEvents(db, [
      makeEvent({ ts: '2026-07-06T15:59:59.000Z', traceId: 'utc-day-before-local-day-before', status: 'CANCELLED' }),
      makeEvent({ ts: '2026-07-06T16:00:00.000Z', traceId: 'local-day-start', status: 'OK' }),
      makeEvent({ ts: '2026-07-07T15:59:59.000Z', traceId: 'local-day-end', status: 'INTERNAL' }),
      makeEvent({ ts: '2026-07-07T16:00:00.000Z', traceId: 'local-next-day', status: 'DEADLINE_EXCEEDED' }),
    ]);

    const rows = dailySummary(db, '2026-07-07', undefined, { timezoneOffsetMinutes: 480 });
    const countsByStatus = Object.fromEntries(rows.map((row) => [row.status, row.count]));

    assert.deepEqual(countsByStatus, { INTERNAL: 1, OK: 1 });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test.skip('GET /report/daily defaults date using configured report timezone offset', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-report-http-tz-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);

  try {
    await withReportServer({
      db,
      config: { dbPath, report: { timezoneOffsetMinutes: 480 } },
      now: () => new Date('2026-07-06T16:30:00.000Z'),
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/report/daily`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.date, '2026-07-07');
      assert.equal(body.timezone_offset_minutes, 480);
    });
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
