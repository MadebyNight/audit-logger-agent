import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createCandidateDetector, matchGlob } from '../../src/auditReview/candidateDetector.js';
import { normalizeEntry } from '../../scripts/lib/parser.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  row_hash TEXT UNIQUE NOT NULL,
  ts TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  span_id TEXT,
  parent_span_id TEXT,
  event TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  result_summary TEXT,
  duration_ms INTEGER,
  channel TEXT,
  user_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  llm_intent_json TEXT,
  error_message TEXT,
  tags TEXT,
  mapped_tool_type TEXT,
  mapping_status TEXT,
  mapping_reason TEXT,
  raw_json TEXT
);
`;

function mk(db, n, opts) {
  const o = {
    row_hash: `hash-${n}`,
    ts: opts.ts ?? '2026-07-03T10:00:00.000Z',
    agent_id: opts.agent_id ?? 'mt-agent',
    trace_id: opts.trace_id ?? 'trace-1',
    span_id: Object.hasOwn(opts, 'span_id') ? opts.span_id : `span-${n}`,
    parent_span_id: null,
    event: opts.event ?? 'tool.end',
    tool_name: opts.tool_name ?? 'some.tool',
    status: opts.status ?? 'OK',
    result_summary: opts.result_summary ?? null,
    duration_ms: opts.duration_ms ?? 10,
    channel: opts.channel ?? null,
    user_id: null,
    entity_type: opts.entity_type ?? null,
    entity_id: opts.entity_id ?? null,
    llm_intent_json: opts.llm_intent_json ?? null,
    error_message: opts.error_message ?? null,
    tags: null,
    mapped_tool_type: opts.mapped_tool_type ?? null,
    mapping_status: opts.mapping_status ?? null,
    mapping_reason: opts.mapping_reason ?? null,
    raw_json: opts.raw_json ?? `{}`,
  };
  db.prepare(`INSERT INTO audit_events
    (row_hash, ts, agent_id, trace_id, span_id, parent_span_id, event, tool_name, status,
     result_summary, duration_ms, channel, user_id, entity_type, entity_id, llm_intent_json, error_message, tags,
     mapped_tool_type, mapping_status, mapping_reason, raw_json)
    VALUES (@row_hash, @ts, @agent_id, @trace_id, @span_id, @parent_span_id, @event, @tool_name, @status,
     @result_summary, @duration_ms, @channel, @user_id, @entity_type, @entity_id, @llm_intent_json, @error_message, @tags,
     @mapped_tool_type, @mapping_status, @mapping_reason, @raw_json)`)
    .run(o);
}

function makeDb() {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}

test('spanless lifecycle rows count starts once and do not imply missing child endings', () => {
  const db = makeDb();
  try {
    for (let i = 0; i < 26; i++) {
      mk(db, i * 2, { span_id: null, event: 'tool.start', tool_name: `read-${i}` });
      mk(db, i * 2 + 1, { span_id: null, event: 'tool.end', tool_name: `read-${i}` });
    }
    const detector = createCandidateDetector({ db, riskPolicy: { repeatThreshold: 5, traceToolChainStepThreshold: 50 } });
    const read = () => detector.detect({ windowFrom: '2026-07-03T10:00:00.000Z', windowTo: '2026-07-03T10:30:00.000Z', maxEventsPerReview: 500 }).candidates;
    assert.ok(read().every(c => !['trace_integrity', 'repeated_call'].includes(c.category) && !c.reason.includes('tool-chain steps')));
    for (let i = 0; i < 5; i++) {
      mk(db, 100 + i * 2, { span_id: null, event: 'tool.start', tool_name: 'repeat' });
      mk(db, 101 + i * 2, { span_id: null, event: 'tool.end', tool_name: 'repeat' });
    }
    const repeated = read().filter(c => c.category === 'repeated_call');
    assert.equal(repeated.length, 1);
    assert.match(repeated[0].reason, /5 calls/);
  } finally { db.close(); }
});

function mkNormalized(db, n, opts) {
  const normalized = normalizeEntry({
    ts: opts.ts ?? '2026-07-03T10:00:00.000Z',
    agent_id: opts.agent_id ?? 'mt-agent',
    trace_id: opts.trace_id ?? 'trace-1',
    span_id: opts.span_id ?? `span-${n}`,
    parent_span_id: opts.parent_span_id ?? null,
    event: opts.event ?? 'tool.end',
    tool_name: opts.tool_name ?? 'some.tool',
    status: opts.status ?? 'OK',
    result_summary: opts.result_summary ?? 'ok',
    duration_ms: opts.duration_ms ?? 10,
    channel: opts.channel ?? null,
    user_id: opts.user_id ?? null,
    entity: opts.entity ?? null,
    llm_intent: opts.llm_intent ?? null,
    error: opts.error ?? null,
    tags: opts.tags ?? null,
  });

  mk(db, n, {
    ...normalized,
    raw_json: normalized.raw_json,
  });
}

test('matchGlob supports * wildcards case-insensitively', () => {
  assert.equal(matchGlob('foo.deleteBar', '*delete*'), true);
  assert.equal(matchGlob('foo.DeleteBar', '*delete*'), true);
  assert.equal(matchGlob('shell.exec', 'shell.*'), true);
  assert.equal(matchGlob('browser.runScript', 'browser.runScript'), true);
  assert.equal(matchGlob('browser.runScript', 'browser.run*'), true);
  assert.equal(matchGlob('read.only', '*write*'), false);
});

test('detect emits failed_call, repeated_call, high_risk_permission, anomalous_call candidates', () => {
  const db = makeDb();

  // one error event
  mk(db, 1, { ts: '2026-07-03T10:00:01.000Z', tool_name: 'some.query', status: 'INTERNAL', event: 'tool.end' });

  // 6 repeats of same tool within 10 minutes
  for (let i = 0; i < 6; i++) {
    mk(db, 100 + i, {
      ts: `2026-07-03T10:0${i}:00.000Z`,
      tool_name: 'publicTraffic.runReport',
      status: 'OK',
      entity_type: 'product',
      entity_id: 'prod-1',
      span_id: `span-r-${i}`,
      event: 'tool.end',
      duration_ms: 100,
    });
  }

  // high-risk delete tool
  mk(db, 200, { ts: '2026-07-03T10:05:00.000Z', tool_name: 'db.deleteTable', status: 'OK', event: 'tool.end', duration_ms: 5 });

  // slow call
  mk(db, 201, { ts: '2026-07-03T10:06:00.000Z', tool_name: 'slow.tool', status: 'OK', event: 'tool.end', duration_ms: 31000 });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: ['*delete*'],
      agentToolAllowlists: {},
    },
  });

  const { candidates, totalEvents, trimmed } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  assert.equal(totalEvents, 9);
  assert.equal(trimmed, false);

  const categories = candidates.map((c) => c.category).sort();
  assert.ok(categories.includes('failed_call'), 'should have failed_call');
  assert.ok(categories.includes('repeated_call'), 'should have repeated_call');
  assert.ok(categories.includes('high_risk_permission'), 'should have high_risk_permission');
  assert.ok(categories.includes('anomalous_call'), 'should have anomalous_call (slow)');
  const highRisk = candidates.find((c) => c.category === 'high_risk_permission');
  assert.equal(highRisk.min_severity, 'high');

  // repeated_call should be emitted exactly once with count >= 5
  const repeated = candidates.filter((c) => c.category === 'repeated_call');
  assert.equal(repeated.length, 1);
  // Anchored to the latest event that still satisfies the sliding-window threshold.
  assert.match(repeated[0].reason, /6 calls/);
  assert.equal(repeated[0].entity_type, 'product');
  assert.equal(repeated[0].entity_id, 'prod-1');
  assert.equal(Object.hasOwn(repeated[0], 'product_id'), false);
});

test('detect admits mapped update tools as high-risk when raw tool name does not match', () => {
  const db = makeDb();
  mk(db, 1, {
    tool_name: 'rental.priceApply',
    mapped_tool_type: 'update',
    mapping_status: 'mapped',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      highRiskToolPatterns: ['*delete*'],
      highRiskMappedToolTypes: ['update'],
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
  });

  const highRisk = candidates.filter((candidate) => candidate.category === 'high_risk_permission');
  assert.equal(highRisk.length, 1);
  assert.equal(highRisk[0].tool_name, 'rental.priceApply');
  assert.equal(highRisk[0].mapped_tool_type, 'update');
  assert.equal(highRisk[0].mapping_status, 'mapped');
});

test('detect does not admit mapped read tools as high-risk without a raw tool-name match', () => {
  const db = makeDb();
  mk(db, 1, {
    tool_name: 'rental.priceApply',
    mapped_tool_type: 'read',
    mapping_status: 'mapped',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      highRiskToolPatterns: ['*delete*'],
      highRiskMappedToolTypes: ['update'],
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
  });

  assert.equal(candidates.some((candidate) => candidate.category === 'high_risk_permission'), false);
});

test('detect does not trust mapped tool type when mapping status is unknown', () => {
  const db = makeDb();
  mk(db, 1, {
    tool_name: 'rental.priceApply',
    mapped_tool_type: 'update',
    mapping_status: 'unknown',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      highRiskToolPatterns: ['*delete*'],
      highRiskMappedToolTypes: ['update'],
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
  });

  assert.equal(candidates.some((candidate) => candidate.category === 'high_risk_permission'), false);
});

test('detect preserves raw tool-name high-risk matches when mapped tool type is read', () => {
  const db = makeDb();
  mk(db, 1, {
    tool_name: 'db.deleteTable',
    mapped_tool_type: 'read',
    mapping_status: 'mapped',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      highRiskToolPatterns: ['*delete*'],
      highRiskMappedToolTypes: ['update'],
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
  });

  const highRisk = candidates.filter((candidate) => candidate.category === 'high_risk_permission');
  assert.equal(highRisk.length, 1);
  assert.equal(highRisk[0].tool_name, 'db.deleteTable');
  assert.equal(highRisk[0].mapped_tool_type, 'read');
});

test('detect prioritizes high-risk candidates before applying the candidate cap', () => {
  const db = makeDb();
  mk(db, 1, { tool_name: 'first.failure', status: 'INTERNAL' });
  mk(db, 2, {
    ts: '2026-07-03T10:00:02.000Z',
    tool_name: 'rental.priceApply',
    mapped_tool_type: 'update',
    mapping_status: 'mapped',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      highRiskToolPatterns: [],
      highRiskMappedToolTypes: ['update'],
    },
  });

  const { candidates, trimmed } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 1,
  });

  assert.equal(trimmed, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'high_risk_permission');
  assert.equal(candidates[0].tool_name, 'rental.priceApply');
});

test('detect uses entity_type and entity_id in repeated-call keys', () => {
  const db = makeDb();
  for (let i = 0; i < 3; i++) {
    mk(db, 10 + i, {
      ts: `2026-07-03T10:0${i}:00.000Z`,
      tool_name: 'same.tool',
      status: 'OK',
      entity_type: 'document',
      entity_id: 'doc-a',
    });
    mk(db, 20 + i, {
      ts: `2026-07-03T10:0${i}:10.000Z`,
      tool_name: 'same.tool',
      status: 'OK',
      entity_type: 'document',
      entity_id: 'doc-b',
    });
  }

  const detector = createCandidateDetector({
    db,
    riskPolicy: { repeatWindowMinutes: 10, repeatThreshold: 5 },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  assert.equal(candidates.filter((c) => c.category === 'repeated_call').length, 0);
});

test('detect flags trace_integrity when tool.start has no matching end/error', () => {
  const db = makeDb();
  mk(db, 1, { ts: '2026-07-03T10:00:00.000Z', tool_name: 'a.tool', status: 'OK', event: 'tool.start', span_id: 'span-orphan' });
  mk(db, 2, { ts: '2026-07-03T10:00:01.000Z', tool_name: 'b.tool', status: 'OK', event: 'tool.end', span_id: 'span-closed' });
  mk(db, 3, { ts: '2026-07-03T10:00:02.000Z', tool_name: 'a.tool', status: 'OK', event: 'tool.end', span_id: 'span-closed' });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: [],
      agentToolAllowlists: {},
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  const traceCandidates = candidates.filter((c) => c.category === 'trace_integrity');
  assert.equal(traceCandidates.length, 1);
  assert.equal(traceCandidates[0].span_id, 'span-orphan');
});

test('detect flags anomalous_call for unknown tool not in agent allowlist', () => {
  const db = makeDb();
  mk(db, 1, { ts: '2026-07-03T10:00:00.000Z', tool_name: 'unknown.tool', status: 'OK', event: 'tool.end', agent_id: 'restricted-agent' });
  mk(db, 2, { ts: '2026-07-03T10:00:01.000Z', tool_name: 'allowed.tool', status: 'OK', event: 'tool.end', agent_id: 'restricted-agent' });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: [],
      agentToolAllowlists: { 'restricted-agent': ['allowed.tool'] },
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  const anomalous = candidates.filter((c) => c.category === 'anomalous_call');
  assert.ok(anomalous.some((c) => c.event_id === 1), 'unknown tool should be anomalous_call');
});

test('detect flags traces with more than 50 tool-chain steps as anomalous', () => {
  const db = makeDb();
  for (let i = 1; i <= 51; i++) {
    mk(db, i, {
      ts: `2026-07-03T10:00:${String(i).padStart(2, '0')}.000Z`,
      trace_id: 'trace-too-long',
      span_id: `span-long-${i}`,
      tool_name: `tool.${i}`,
      status: 'OK',
      event: 'tool.end',
    });
  }
  mk(db, 100, {
    ts: '2026-07-03T10:02:00.000Z',
    trace_id: 'trace-at-limit',
    span_id: 'span-limit',
    tool_name: 'tool.limit',
    status: 'OK',
    event: 'tool.end',
  });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: [],
      agentToolAllowlists: {},
      traceToolChainStepThreshold: 50,
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  const anomalous = candidates.filter((c) => c.category === 'anomalous_call');
  assert.ok(anomalous.some((c) => (
    c.trace_id === 'trace-too-long'
      && /51 tool-chain steps/.test(c.reason)
      && /exceeds 50/.test(c.reason)
      && c.min_severity === 'medium'
  )));
  assert.equal(anomalous.some((c) => c.trace_id === 'trace-at-limit'), false);
});

test('detect sees canonical event after upstream alias is normalized before insert', () => {
  const db = makeDb();
  mkNormalized(db, 1, {
    ts: '2026-07-03T10:05:00.000Z',
    trace_id: 'trace-alias',
    span_id: 'span-alias',
    event: 'tool_end',
    tool_name: 'db.deleteTable',
    status: 'OK',
    result_summary: 'deleted 1 table',
  });

  const stored = db.prepare('SELECT event, raw_json FROM audit_events WHERE trace_id = ?').get('trace-alias');
  assert.equal(stored.event, 'tool.end');
  assert.equal(JSON.parse(stored.raw_json).event, 'tool_end');

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: ['*delete*'],
      agentToolAllowlists: {},
    },
  });

  const { candidates } = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 500,
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].category, 'high_risk_permission');
  assert.equal(candidates[0].event, 'tool.end');
});

test('detect trims and caps candidates when totalEvents exceeds maxEventsPerReview', () => {
  const db = makeDb();
  // Insert 20 normal events + 1 error.
  for (let i = 0; i < 20; i++) {
    mk(db, i + 1, { ts: `2026-07-03T10:00:${String(i).padStart(2, '0')}.000Z`, tool_name: 'normal.tool', status: 'OK', event: 'tool.end' });
  }
  mk(db, 99, { ts: '2026-07-03T10:00:30.000Z', tool_name: 'fail.tool', status: 'INTERNAL', event: 'tool.end' });

  const detector = createCandidateDetector({
    db,
    riskPolicy: {
      version: 'risk-policy-v1',
      repeatWindowMinutes: 10,
      repeatThreshold: 5,
      slowCallDurationMs: 30000,
      highRiskToolPatterns: [],
      agentToolAllowlists: {},
    },
  });

  const result = detector.detect({
    windowFrom: '2026-07-03T10:00:00.000Z',
    windowTo: '2026-07-03T10:30:00.000Z',
    maxEventsPerReview: 5,
  });

  assert.equal(result.totalEvents, 21);
  assert.equal(result.trimmed, true);
  assert.ok(result.candidates.length <= 5, 'candidates capped at maxEventsPerReview');
  // The error candidate should be retained since failures are kept.
  assert.ok(result.candidates.some((c) => c.category === 'failed_call'));
});
