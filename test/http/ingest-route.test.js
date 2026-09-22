import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildDemoTrace } from '../../scripts/send-audit-demo-logs.js';
import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createIngestCursorStore } from '../../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../../src/auditReview/ingestService.js';
import { createRetentionService } from '../../src/auditReview/retention.js';
import { createHttpApp } from '../../src/adapters/http/app.js';
import { resolveSpoolDir } from '../../src/adapters/http/ingestRoute.js';
import { createTraceAggregator } from '../../src/auditReview/traceAggregator.js';
import { createTraceStore } from '../../src/auditReview/traceStore.js';
import { createLockStore } from '../../src/auditReview/lockStore.js';
import { createApiTokenService } from '../../src/auditReview/apiTokenService.js';
import { createVisualization } from '../../src/auditReview/visualization.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';

function makeEvent(overrides = {}) {
  return {
    ts: '2026-07-06T01:02:03.000Z',
    agent_id: 'remote-agent',
    trace_id: 'trace-1',
    span_id: 'span-1',
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'OK',
    result_summary: 'ok',
    entity: { type: 'document', id: 'doc-1' },
    ...overrides,
  };
}

async function withIngestServer(fn, configOverrides = {}, dependencies = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-http-ingest-'));
  const dbPath = path.join(tmpDir, 'audit.db');
  const db = openDb(dbPath);
  ensureReviewSchema(db);
  const config = {
    dbPath,
    agents: {},
    ingest: {
      http: { enabled: true, maxBodyBytes: 1024, maxLineBytes: 512 },
      spoolDir: path.join(tmpDir, 'incoming'),
    },
    ...configOverrides,
  };
  const cursorStore = createIngestCursorStore(db);
  const ingestService = createAuditIngestService({ db, config, cursorStore });
  const resolvedDependencies = typeof dependencies === 'function'
    ? dependencies({ db, config, cursorStore, ingestService })
    : dependencies;
  const server = createHttpApp({ db, config, ...resolvedDependencies });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await fn({
      baseUrl: `http://127.0.0.1:${port}`,
      tmpDir,
      db,
      config,
      ingestService,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function readSpool(config, agentId, date = '2026-07-06') {
  const file = path.join(config.ingest.spoolDir, agentId, `audit-${date}.jsonl`);
  return fs.readFileSync(file, 'utf-8');
}

function insertAuditEvent(db, event) {
  const result = db.prepare(`
    INSERT INTO audit_events (
      row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event,
      tool_name, status, result_summary, duration_ms, channel, user_id,
      entity_type, entity_id, llm_intent_json, error_message, tags, raw_json
    ) VALUES (
      @row_hash, @ts, @agent_id, @trace_id, @span_id, NULL, @event,
      @tool_name, @status, @result_summary, 1, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, @raw_json
    )
  `).run({
    row_hash: `seed-${event.trace_id}`,
    raw_json: JSON.stringify(event),
    ...event,
  });
  return Number(result.lastInsertRowid);
}

test('resolveSpoolDir defaults to the normalized spool layout', () => {
  const rootDir = path.join(os.tmpdir(), 'audit-http-ingest-defaults');
  assert.equal(resolveSpoolDir({ rootDir }), path.join(rootDir, 'data', 'spool', 'incoming'));
});

test('POST /v1/ingest accepts one JSON event, stores it immediately, and ingestSince dedupes it', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ trace_id: 'json-single', span_id: 'span-json-single' })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /json-single/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('json-single').count,
      1
    );
  });
});

test('POST /v1/ingest persists accepted events for internal trace aggregation', async () => {
  await withIngestServer(async ({ baseUrl, config, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ trace_id: 'query-immediate', span_id: 'span-query-immediate' })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /query-immediate/);

    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('query-immediate').count,
      1
    );
  });
});

test('POST /v1/ingest does not wait for tool semantic mapping', async () => {
  let releaseMapping;
  const mappingPending = new Promise((resolve) => {
    releaseMapping = resolve;
  });
  let mappingCalls = 0;

  try {
    await withIngestServer(async ({ baseUrl }) => {
      const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 100));
      const response = await Promise.race([
        fetch(`${baseUrl}/v1/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeEvent({ trace_id: 'mapping-async', span_id: 'span-mapping-async' })),
        }),
        timeout,
      ]);

      releaseMapping();
      assert.ok(response, 'ingest response must not wait for semantic mapping');
      assert.equal(response.status, 202);
      assert.equal(mappingCalls, 1);
    }, {}, {
      toolSemanticMapper: {
        mapPendingEvents() {
          mappingCalls += 1;
          return mappingPending;
        },
      },
    });
  } finally {}
});

test('POST /v1/ingest canonicalizes alias events for DB while preserving raw upstream event', async () => {
  await withIngestServer(async ({ baseUrl, config, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({
        trace_id: 'alias-event',
        span_id: 'span-alias-event',
        event: 'tool/end',
      })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });

    const spool = readSpool(config, 'remote-agent');
    assert.match(spool, /"event":"tool\/end"/);
    assert.doesNotMatch(spool, /"event":"tool\.end"/);

    const row = db.prepare('SELECT event, raw_json FROM audit_events WHERE trace_id = ?').get('alias-event');
    assert.equal(row.event, 'tool.end');
    assert.equal(JSON.parse(row.raw_json).event, 'tool/end');
  });
});

test('POST /v1/ingest accepts JSON event batches and stores them immediately', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          makeEvent({ trace_id: 'batch-1', span_id: 'span-batch-1' }),
          makeEvent({ trace_id: 'batch-2', span_id: 'span-batch-2' }),
        ],
      }),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /batch-1/);
    assert.match(readSpool(config, 'remote-agent'), /batch-2/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
  });
});

test('POST /v1/ingest prunes audit events immediately after accepted batches', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    const oldestEventId = insertAuditEvent(db, makeEvent({
      ts: '2026-05-01T01:00:00.000Z',
      trace_id: 'prune-oldest',
      span_id: 'span-prune-oldest',
    }));
    db.prepare(`INSERT INTO audit_traces (
      agent_id, trace_id, last_event_at, sealed_at, sealed_reason, updated_at, event_count
    ) VALUES ('remote-agent', 'prune-oldest', '2026-05-01T01:00:00.000Z',
      '2026-05-01T01:00:00.000Z', 'backfill', '2026-05-01T01:00:00.000Z', 1)`).run();
    insertAuditEvent(db, makeEvent({
      ts: '2026-07-05T01:01:00.000Z',
      trace_id: 'prune-middle',
      span_id: 'span-prune-middle',
    }));
    db.prepare(`
      INSERT INTO audit_review_runs (
        review_id, window_from, window_to, status, trigger_type, finding_count,
        risk_policy_version, reviewer_version, started_at
      ) VALUES (
        'prune-review', '2026-05-01T01:00:00.000Z', '2026-05-01T01:00:00.000Z',
        'completed', 'ingest', 1, 'risk-policy-v1', 'reviewer-v1', '2026-05-01T01:00:00.000Z'
      )
    `).run();
    db.prepare(`
      INSERT INTO audit_review_findings (
        finding_id, review_id, finding_hash, category, severity, title, summary,
        evidence_event_ids_json, evidence_json, status, created_at, last_seen_at,
        risk_policy_version, reviewer_version
      ) VALUES (
        'prune-finding', 'prune-review', 'prune-finding-hash', 'failed_call', 'medium',
        'old finding', 'old finding', @evidence_event_ids_json, @evidence_json, 'open',
        '2026-05-01T01:00:00.000Z', '2026-05-01T01:00:00.000Z',
        'risk-policy-v1', 'reviewer-v1'
      )
    `).run({
      evidence_event_ids_json: JSON.stringify([oldestEventId]),
      evidence_json: JSON.stringify([{ event_id: oldestEventId, raw_json: '{"source":"oldest"}' }]),
    });
    db.prepare(`
      INSERT INTO audit_review_finding_occurrences (
        occurrence_id, finding_id, review_id, severity, title, summary,
        evidence_event_ids_json, evidence_json, observed_at, created_at
      ) VALUES (
        'prune-occurrence', 'prune-finding', 'prune-review', 'medium', 'old finding', 'old finding',
        @evidence_event_ids_json, @evidence_json,
        '2026-05-01T01:00:00.000Z', '2026-05-01T01:00:00.000Z'
      )
    `).run({
      evidence_event_ids_json: JSON.stringify([oldestEventId]),
      evidence_json: JSON.stringify([{ event_id: oldestEventId, raw_json: '{"source":"oldest"}' }]),
    });

    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({
        ts: '2026-07-05T01:02:00.000Z',
        trace_id: 'prune-newest',
        span_id: 'span-prune-newest',
      })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(
      db.prepare(`SELECT trace_id FROM audit_events WHERE agent_id = 'remote-agent' ORDER BY ts ASC`).all().map((row) => row.trace_id),
      ['prune-middle', 'prune-newest'],
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_review_findings`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_review_finding_occurrences`).get().count, 0);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM audit_review_runs`).get().count, 0);
  }, {
    retention: {
      traceDays: 30,
      highRiskTraceDays: 90,
      maxTracesPerAgent: 2000,
    },
  }, ({ db, config, cursorStore }) => ({
    retentionService: createRetentionService({
      db,
      config,
      cursorStore,
      now: () => new Date('2026-07-06T01:03:00.000Z'),
    }),
  }));
});

test('POST /v1/ingest accepts NDJSON bodies and stores them immediately', async () => {
  await withIngestServer(async ({ baseUrl, config, ingestService, db }) => {
    const body = [
      JSON.stringify(makeEvent({ trace_id: 'ndjson-1', span_id: 'span-ndjson-1' })),
      JSON.stringify(makeEvent({ trace_id: 'ndjson-2', span_id: 'span-ndjson-2' })),
    ].join('\n') + '\n';

    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body,
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 2, rejected: 0, errors: [] });
    assert.match(readSpool(config, 'remote-agent'), /ndjson-1/);
    assert.match(readSpool(config, 'remote-agent'), /ndjson-2/);

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 2);
  });
});

test('POST /v1/ingest accepts entity and llm_intent fields and stores them immediately', async () => {
  await withIngestServer(async ({ baseUrl, ingestService, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({
        trace_id: 'entity-intent',
        span_id: 'span-entity-intent',
        entity: { type: 'database', id: 'db-1' },
        llm_intent: { input: 'inspect table', output: 'summarize schema' },
      })),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 0);
    const row = db.prepare('SELECT entity_type, entity_id, llm_intent_json FROM audit_events WHERE trace_id = ?').get('entity-intent');
    assert.equal(row.entity_type, 'database');
    assert.equal(row.entity_id, 'db-1');
    assert.equal(row.llm_intent_json, JSON.stringify({ input: 'inspect table', output: 'summarize schema' }));
  });
});

test('POST /v1/ingest rejects legacy audit fields', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({
        trace_id: 'legacy-product',
        product_id: 'prod-1',
        error: { code: 'old_code', message: 'old code' },
      })),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.ok(body.errors.some((error) => /product_id|error\.code/.test(error.error)));
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  });
});

test('POST /v1/ingest accepts unknown lifecycle events as unknown without dropping logs', async () => {
  await withIngestServer(async ({ baseUrl, config, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({
        trace_id: 'unknown-alias',
        span_id: 'span-unknown-alias',
        event: 'tool/not-a-stage',
      })),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 0);
    assert.deepEqual(body.errors, []);
    const row = db.prepare('SELECT event, raw_json FROM audit_events WHERE trace_id = ?').get('unknown-alias');
    assert.equal(row.event, 'unknown');
    assert.equal(JSON.parse(row.raw_json).event, 'tool/not-a-stage');
    const spooled = fs.readFileSync(
      path.join(config.ingest.spoolDir, 'remote-agent', 'audit-2026-07-06.jsonl'),
      'utf-8',
    );
    assert.ok(spooled.includes('unknown-alias'));
  });
});

test('POST /v1/ingest rejects path-traversal agent_id and writes nothing outside spool', async () => {
  await withIngestServer(async ({ baseUrl, config, tmpDir }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ agent_id: '../evil', trace_id: 'evil' })),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.match(body.errors[0].error, /agent_id/);
    assert.equal(fs.existsSync(path.join(config.ingest.spoolDir, 'evil')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'evil')), false);
  });
});

test('POST /v1/ingest rejects path-special agent_id values without writing spool files', async () => {
  const cases = ['', '.', '/', '\\', '..', '../evil'];

  for (const agentId of cases) {
    await withIngestServer(async ({ baseUrl, config, tmpDir }) => {
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeEvent({ agent_id: agentId, trace_id: `invalid-${agentId}` })),
      });

      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.accepted, 0);
      assert.equal(body.rejected, 1);
      assert.ok(body.errors.some((error) => /agent_id|required field "agent_id"/.test(error.error)));
      assert.equal(fs.existsSync(path.join(config.ingest.spoolDir, 'audit-2026-07-06.jsonl')), false);
      assert.equal(fs.existsSync(path.join(config.ingest.spoolDir, agentId, 'audit-2026-07-06.jsonl')), false);
      assert.equal(fs.existsSync(path.join(tmpDir, 'evil', 'audit-2026-07-06.jsonl')), false);
    });
  }
});


test('POST /v1/ingest requires task context for every Agent despite obsolete mode settings', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    for (const agent_id of ['remote-agent', 'legacy-agent']) {
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeEvent({ agent_id, event: 'run.start' })),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.deepEqual(body.errors.map(e => e.field), ['requester_id', 'original_request', 'expected_purpose']);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
  }, { agents: { 'legacy-agent': { ingestMode: 'compat' } }, ingest: { defaultMode: 'compat' } });
});

test('POST /v1/ingest rejects missing purpose and accepts valid run.start without either Span', async () => {
  await withIngestServer(async ({ baseUrl, config, db }) => {
    const event = makeEvent({ event: 'run.start', requester_id: 'user-1', original_request: 'Deploy service',
      span_id: undefined, parent_span_id: undefined });
    const send = entry => fetch(`${baseUrl}/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
    const rejected = await send(event);
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).errors[0].field, 'expected_purpose');
    const response = await send({ ...event, expected_purpose: 'Deliver the approved service version' });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    const row = db.prepare('SELECT * FROM audit_events').get();
    assert.equal(row.span_id, null);
    assert.equal(row.parent_span_id, null);
    assert.equal(Object.hasOwn(JSON.parse(row.raw_json), 'span_id'), false);
    assert.match(readSpool(config, 'remote-agent'), /Deliver the approved service version/);
  });
});

test('POST /v1/ingest accepts requester names and preserves them in storage and spool', async () => {
  await withIngestServer(async ({ baseUrl, config, db }) => {
    const event = makeEvent({ event: 'run.start', requester_id: '张三',
      original_request: '查询任务状态', expected_purpose: '确认任务执行情况' });
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0, errors: [] });
    const row = db.prepare('SELECT * FROM audit_events').get();
    assert.equal(row.requester_id, '张三');
    assert.equal(row.redaction_hits, 0);
    assert.equal(JSON.parse(row.raw_json).requester_id, '张三');
    const spooled = readSpool(config, 'remote-agent').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(spooled[0].requester_id, '张三');
  });
});

test('POST /v1/ingest rejects task-field type and length errors regardless of legacy config', async () => {
  const cases = [
    {
      overrides: { requester_id: { user: 'id' } },
      expectedError: 'invalid_field_type',
    },
    {
      overrides: { requester_id: 'x'.repeat(129) },
      expectedError: 'field_too_long',
    },
  ];

  for (const mode of ['compat', 'strict']) {
    for (const item of cases) {
      await withIngestServer(async ({ baseUrl, db }) => {
        const response = await fetch(`${baseUrl}/v1/ingest`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(makeEvent({
            agent_id: `${mode}-agent`,
            event: 'run.start',
            requester_id: 'user-1',
            original_request: 'valid request',
            expected_purpose: 'validate task context',
            ...item.overrides,
          })),
        });

        assert.equal(response.status, 400);
        const body = await response.json();
        assert.equal(body.errors[0].error_code, item.expectedError);
        assert.equal(
          db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('trace-1').count,
          0
        );
      }, {
        agents: { [`${mode}-agent`]: { ingestMode: mode } },
      });
    }
  }
});

test('POST /v1/ingest preserves oversized body 413 response', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ result_summary: 'x'.repeat(600) })),
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error_code, 'payload_too_large');
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  }, {
    ingest: {
      http: { enabled: true, maxBodyBytes: 300, maxLineBytes: 512 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-payload-${Date.now()}`),
    },
  });
});
test('POST /v1/ingest returns 413 for oversized bodies', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ result_summary: 'x'.repeat(600) })),
    });

    assert.equal(response.status, 413);
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  }, {
    ingest: {
      http: { enabled: true, maxBodyBytes: 300, maxLineBytes: 512 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-unused-${Date.now()}`),
    },
  });
});

test('POST /v1/ingest rejects overlong events and does not spool them', async () => {
  await withIngestServer(async ({ baseUrl, config }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent({ result_summary: 'x'.repeat(80) })),
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.match(body.errors[0].error, /maxLineBytes/);
    assert.equal(fs.existsSync(config.ingest.spoolDir), false);
  }, {
    ingest: {
      http: { enabled: true, maxBodyBytes: 1024, maxLineBytes: 120 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-overlong-${Date.now()}`),
    },
  });
});

test('POST /v1/ingest counts one invalid event as one rejected row', async () => {
  await withIngestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_id: 'remote-agent' }),
    });

    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.rejected, 1);
    assert.ok(body.errors.length > 1);
  });
});

test('POST /v1/ingest reposting the same row ingests once through existing dedupe', async () => {
  await withIngestServer(async ({ baseUrl, ingestService, db }) => {
    const event = makeEvent({ trace_id: 'dedupe', span_id: 'span-dedupe' });
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
      });
      assert.equal(response.status, 202);
      assert.equal((await response.json()).accepted, 1);
    }

    const ingestResult = ingestService.ingestSince({ sinceDate: '2026-07-06' });
    assert.equal(ingestResult.inserted, 0);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE trace_id = ?').get('dedupe').count,
      1
    );
  });
});

test('POST /v1/ingest is disabled when ingest.http.enabled is false', async () => {
  await withIngestServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(makeEvent()),
    });

    assert.equal(response.status, 404);
  }, {
    ingest: {
      http: { enabled: false, maxBodyBytes: 1024, maxLineBytes: 512 },
      spoolDir: path.join(os.tmpdir(), `audit-http-ingest-disabled-${Date.now()}`),
    },
  });
});


test('task validation reports every bad row and persists valid batch rows', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [
        makeEvent({ requester_id: {} }),
        makeEvent({ trace_id: 'good', requester_id: 'user-anon' }),
        makeEvent({ requester_id: [] }),
      ] }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 2);
    assert.deepEqual(body.errors.map(e => e.index), [0, 2]);
    assert.equal(db.prepare('SELECT trace_id FROM audit_events').get().trace_id, 'good');
  });
});

test('unredacted task fields are rejected before persistence under the single contract', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    const event = makeEvent({ requester_id: 'a@example.test', original_request: '13800138000',
      expected_purpose: '11010519491231002X', agent_result: 'b@example.test' });
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error_code, 'redaction_required');
    assert.equal(db.prepare('SELECT * FROM audit_events').get(), undefined);
  });
});

test('NDJSON reports oversized lines as 413 and continues validating the batch', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/x-ndjson' },
      body: JSON.stringify(makeEvent({ extra: 'x'.repeat(600) })) + '\n' + JSON.stringify(makeEvent({ trace_id: 'good-line' })) + '\n',
    });
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error_code, 'payload_too_large');
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 1);
    assert.equal(db.prepare('SELECT trace_id FROM audit_events').get().trace_id, 'good-line');
  }, { ingest: { http: { maxBodyBytes: 4096, maxLineBytes: 512 } } });
});


test('spanless tasks round-trip through HTTP ingestion, audit, authenticated export and Dashboard', async () => {
  let token;
  await withIngestServer(async ({ baseUrl, db }) => {
    const batch = buildDemoTrace('normal');
    const events = batch.events.map(({ span_id, parent_span_id, ...event }) => event);
    const post = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events }),
    });
    assert.equal(post.status, 202);
    assert.equal((await post.json()).accepted, events.length);
    const aggregator = createTraceAggregator({ db, config: {}, traceStore: createTraceStore(db), lockStore: createLockStore(db),
      llmReviewer: { reviewTrace() { throw new Error('No model call expected'); } } });
    await aggregator.run();
    const response = await fetch(`${baseUrl}/v1/audit-logs?trace_id=${batch.traceId}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const { traces } = await response.json();
    assert.equal(traces.length, 1);
    assert.equal(traces[0].context_status, 'complete');
    assert.equal(traces[0].audit_result.trace_status, 'success');
    assert.equal(traces[0].expected_purpose, events[0].expected_purpose);
    assert.equal(traces[0].events.length, events.length);
    assert.ok(traces[0].events.every(e => e.span_id === null && e.parent_span_id === null && !Object.hasOwn(e.raw_json, 'span_id')));
    const page = await fetch(`${baseUrl}/dashboard/agents/${batch.agentId}/traces/${batch.traceId}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(events[0].expected_purpose));
    assert.ok(html.includes(events[0].original_request));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, events.length);
  }, { ingest: { http: { maxBodyBytes: 1024 * 1024, maxLineBytes: 64 * 1024 } } }, ({ db, config }) => {
    const apiTokenService = createApiTokenService({ db });
    token = apiTokenService.create('测试调用方').token;
    return { apiTokenService, scheduler: {}, reviewStore: {}, dashboardAuth: createDashboardAuth({ config, env: {} }),
      visualization: createVisualization({ db, reviewStore: {}, config }) };
  });
});

test('all demo generators pass strict HTTP ingestion with task context', async () => {
  await withIngestServer(async ({ baseUrl, db }) => {
    for (const kind of ['normal', 'medium-risk', 'high-risk']) {
      const batch = buildDemoTrace(kind);
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events: batch.events }),
      });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: batch.events.length, rejected: 0, errors: [] });
      const start = db.prepare("SELECT * FROM audit_events WHERE trace_id = ? AND event = 'run.start'").get(batch.traceId);
      const terminalEvent = kind === 'high-risk' ? 'run.failed' : 'run.final_result';
      const final = db.prepare('SELECT * FROM audit_events WHERE trace_id = ? AND event = ?').get(batch.traceId, terminalEvent);
      assert.equal(start.requester_id, 'demo_operator');
      assert.ok(start.original_request);
      assert.ok(start.expected_purpose);
      assert.ok(final.agent_result);
      assert.equal(final.status, kind === 'high-risk' ? 'UNAVAILABLE' : 'OK');
      assert.equal(start.redaction_hits, 0);
    }
  }, { ingest: { http: { maxBodyBytes: 1024 * 1024, maxLineBytes: 64 * 1024 } } });
});
