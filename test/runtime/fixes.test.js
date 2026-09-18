import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createOutboxStore } from '../../src/agent/outboxStore.js';
import { createWaitStore } from '../../src/agent/waitStore.js';
import { createEventPublisher } from '../../src/agent/eventPublisher.js';
import { createPlanner } from '../../src/agent/planner.js';
import { createRuntime } from '../../src/agent/runtime.js';
import { createToolRegistry } from '../../src/tools/registry.js';

function dayRange(nowIso) {
  const date = nowIso.slice(0, 10);
  return {
    from: `${date}T00:00:00.000+08:00`,
    to: `${date}T23:59:59.999+08:00`,
  };
}

function stubLlmClient(nowIso) {
  let call = 0;

  return {
    async createStructuredResponse({ input, schema }) {
      call += 1;

      if (schema?.name === 'audit_agent_final_result') {
        const payload = JSON.parse(input[1].content);
        const errorRows = payload.toolResults.find((item) => item.stepName === 'load-errors')?.result ?? [];
        const summaryRows = payload.toolResults.find((item) => item.stepName === 'summarize-errors')?.result ?? [];
        const urgentCount = errorRows.slice(0, 5).length;

        return {
          type: 'final_result',
          status: 'completed',
          title: '异常任务分析已完成',
          summary: `共发现 ${errorRows.length} 条异常，建议优先处理前 ${urgentCount} 条。`,
          details_markdown: summaryRows.length === 0
            ? '未查询到异常记录。'
            : summaryRows.map((row, index) => `${index + 1}. ${row.tool_name} | ${row.result_summary}`).join('\n'),
          actions: [{ id: 'view_trace', label: '查看执行轨迹' }],
        };
      }

      const payload = JSON.parse(input[1].content);
      const range = dayRange(nowIso);
      const selected = payload.metadata?.decisionResponse?.selected_option;

      if (selected === 'today_only' || payload.requestText === '帮我查询今天的异常任务') {
        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'INTERNAL', from: range.from, to: range.to, limit: 100 },
              },
              {
                stepName: 'summarize-errors',
                toolName: 'report.errorSummary',
                input: { from: range.from, to: range.to, agentId: undefined },
              },
            ],
          },
          decision: null,
        };
      }

      if (selected === 'all_errors') {
        return {
          type: 'plan',
          plan: {
            steps: [
              {
                stepName: 'load-errors',
                toolName: 'audit.queryEvents',
                input: { status: 'INTERNAL', limit: 100 },
              },
              {
                stepName: 'summarize-errors',
                toolName: 'report.errorSummary',
                input: { from: '1970-01-01', to: '2099-12-31', agentId: undefined },
              },
            ],
          },
          decision: null,
        };
      }

      if (payload.requestText === '帮我处理异常任务') {
        return {
          type: 'decision_request',
          plan: null,
          decision: {
            title: '需要确认处理范围',
            summary: '当前请求未明确范围，请先选择处理今天的异常，还是处理全部异常。',
            options: [
              { id: 'today_only', label: '只处理今天', description: '优先处理当天问题' },
              { id: 'all_errors', label: '处理全部异常', description: '覆盖全部历史异常' },
            ],
            formSchema: [],
            submitLabel: '继续执行',
          },
        };
      }

      throw new Error(`Unexpected planner input on call ${call}`);
    },
  };
}

function freshRuntime({ registry } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-fixtures-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);
  const outboxStore = createOutboxStore(db, { maxAttempts: 2 });
  const waitStore = createWaitStore(db);
  const eventPublisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send() {} },
  });
  const reg = registry ?? createToolRegistry();
  if (!registry) {
    reg.register({
      name: 'audit.queryEvents',
      async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; },
    });
    reg.register({
      name: 'report.errorSummary',
      async execute() { return [{ tool_name: 'demo.tool', result_summary: 'demo failed' }]; },
    });
  }
  const nowIso = '2026-07-02T09:00:00.000+08:00';
  const runtime = createRuntime({
    runStore, outboxStore, waitStore,
    planner: createPlanner({
      llmClient: stubLlmClient(nowIso),
      model: 'test-model',
      registry: reg,
      now: () => nowIso,
    }),
    registry: reg,
    eventPublisher,
    auditLogger: { async log() {} },
  });
  return { tmpDir, db, runStore, outboxStore, waitStore, eventPublisher, runtime, cleanup: () => { db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); } };
}

const baseInput = {
  sourceType: 'manual',
  sessionId: 'session_test',
  messageId: 'om_test',
  requesterId: 'user_test',
  requestText: '帮我处理异常任务',
  deliveryMode: 'callback',
  deliveryTargetUrl: 'http://127.0.0.1:9999/agent-events',
  metadata: {},
};

async function waitForTerminal(runStore, runId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.getRun(runId);
    if (run && (run.status === 'completed' || run.status === 'failed' || run.status === 'waiting_user')) return run;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return runStore.getRun(runId);
}

test('P1-01: tool failure transitions run to failed and emits a failed final_result', async () => {
  const failingRegistry = createToolRegistry();
  failingRegistry.register({ name: 'audit.queryEvents', async execute() { throw new Error('tool boom'); } });
  failingRegistry.register({ name: 'report.errorSummary', async execute() { return []; } });
  const ctx = freshRuntime({ registry: failingRegistry });
  const run = await ctx.runtime.startRun({ ...baseInput, requestText: '帮我查询今天的异常任务' });
  await waitForTerminal(ctx.runStore, run.run_id);
  const final = ctx.runStore.getRun(run.run_id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error_code, 'tool_error');
  const failedEvent = ctx.outboxStore.listAll(50).find((e) => e.type === 'final_result');
  assert.ok(failedEvent, 'expected a final_result outbox event');
  assert.equal(failedEvent.payload_json.status, 'failed');
  ctx.cleanup();
});

test('P2-01: startRun returns immediately even when a tool is slow', async () => {
  const slowRegistry = createToolRegistry();
  let resolveSlow;
  slowRegistry.register({ name: 'audit.queryEvents', async execute() { await new Promise((r) => { resolveSlow = r; }); return []; } });
  slowRegistry.register({ name: 'report.errorSummary', async execute() { return []; } });
  const ctx = freshRuntime({ registry: slowRegistry });
  const t0 = Date.now();
  const run = await ctx.runtime.startRun({ ...baseInput, requestText: '帮我查询今天的异常任务' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `startRun should return fast, took ${elapsed}ms`);
  assert.equal(run.status, 'created');
  // Let the background executor start the slow tool so resolveSlow is assigned.
  await new Promise((resolve) => setImmediate(resolve));
  if (typeof resolveSlow === 'function') resolveSlow([]);
  await waitForTerminal(ctx.runStore, run.run_id);
  ctx.cleanup();
});

test('P2-02: resume planner failure leaves waiting state pending and run waiting_user', async () => {
  const ctx = freshRuntime();
  const created = await ctx.runtime.startRun(baseInput);
  await waitForTerminal(ctx.runStore, created.run_id);
  const waiting = ctx.waitStore.findPendingForRun(created.run_id);
  assert.ok(waiting);
  await assert.rejects(
    ctx.runtime.resumeRun(created.run_id, { decision_id: waiting.decision_id, response: { selected_option: 'bogus_option', form_data: {} } }),
    (err) => err.code === 'invalid_decision_response',
  );
  const stillWaiting = ctx.waitStore.getWaitingState(waiting.decision_id);
  assert.equal(stillWaiting.status, 'pending');
  const stillRun = ctx.runStore.getRun(created.run_id);
  assert.equal(stillRun.status, 'waiting_user');
  ctx.cleanup();
});

test('P2-03: resume on non-waiting run returns resume_conflict', async () => {
  const ctx = freshRuntime();
  const created = await ctx.runtime.startRun({ ...baseInput, requestText: '帮我查询今天的异常任务' });
  await waitForTerminal(ctx.runStore, created.run_id);
  const completed = ctx.runStore.getRun(created.run_id);
  assert.notEqual(completed.status, 'waiting_user');
  await assert.rejects(
    ctx.runtime.resumeRun(created.run_id, { decision_id: 'dec_anything', response: { selected_option: 'today_only' } }),
    (err) => err.code === 'resume_conflict',
  );
  ctx.cleanup();
});

test('P2-05: duplicate message_id returns the same run', async () => {
  const ctx = freshRuntime();
  const first = await ctx.runtime.startRun(baseInput);
  await waitForTerminal(ctx.runStore, first.run_id);
  const second = await ctx.runtime.startRun(baseInput);
  assert.equal(first.run_id, second.run_id);
  const total = ctx.db.prepare(`SELECT COUNT(*) AS c FROM agent_runs WHERE channel = ? AND message_id = ?`).get('manual', 'om_test').c;
  assert.equal(total, 1, 'duplicate message_id must not create a second run');
  ctx.cleanup();
});

test('P2-06: tool timeout produces tool_timeout error and fails the run', async () => {
  const timeoutRegistry = createToolRegistry();
  timeoutRegistry.register({
    name: 'audit.queryEvents',
    timeoutMs: 50,
    async execute(input, context) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        context.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); });
      });
      return [];
    },
  });
  timeoutRegistry.register({ name: 'report.errorSummary', async execute() { return []; } });
  const ctx = freshRuntime({ registry: timeoutRegistry });
  const run = await ctx.runtime.startRun({ ...baseInput, requestText: '帮我查询今天的异常任务' });
  await waitForTerminal(ctx.runStore, run.run_id, 5000);
  const final = ctx.runStore.getRun(run.run_id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error_code, 'tool_timeout');
  ctx.cleanup();
});

test('P2-04: outbox retries with backoff then enters dead_letter after max attempts', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-outbox-dl-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const outboxStore = createOutboxStore(db, { maxAttempts: 2 });
  const publisher = createEventPublisher({
    outboxStore,
    callbackClient: { async send() { throw new Error('callback down'); } },
  });
  publisher.enqueueRunEvent(
    { run_id: 'run_test', delivery_mode: 'callback', delivery_callback_url: 'http://127.0.0.1:1/x' },
    'final_result',
    { type: 'final_result', run_id: 'run_test' },
  );
  await publisher.flushPending(10); // attempt 1 -> still pending, next_attempt set
  const after1 = outboxStore.listAll(1)[0];
  assert.equal(after1.delivery_status, 'pending');
  assert.ok(after1.next_attempt_at, 'expected a backoff next_attempt_at');
  // Not due yet: with "now" far in the past relative to next_attempt_at (which is
  // a few seconds in the future), the event should NOT be selected for retry.
  const notDue = outboxStore.listPending(10, new Date(0).toISOString());
  assert.equal(notDue.length, 0, 'event should not be retried before next_attempt_at');
  // Force the next_attempt into the past so it becomes due, then flush -> attempt 2 -> dead_letter.
  db.prepare(`UPDATE agent_outbox_events SET next_attempt_at = ? WHERE run_id = ?`).run(new Date(0).toISOString(), 'run_test');
  const due = outboxStore.listPending(10, new Date(0).toISOString());
  assert.equal(due.length, 1, 'event becomes due once next_attempt_at passes');
  await publisher.flushPending(10);
  const after2 = outboxStore.listAll(1)[0];
  assert.equal(after2.delivery_status, 'dead_letter');
  assert.equal(after2.delivery_attempts, 2);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.skip('P3-01: /query returns consistent count and results (single query path)', async () => {
  // Behavior-level: create app and verify count equals results.length for an empty filter.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-query-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);
  const { createHttpApp } = await import('../../src/adapters/http/app.js');
  const server = createHttpApp({
    db,
    config: { dbPath: path.join(tmpDir, 'runtime.db') },
    runStore,
    runtime: { async startRun(i) { return runStore.createRun(i); }, async getRun(id) { return runStore.getRun(id); } },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/query`);
  const body = await res.json();
  assert.equal(body.count, body.results.length);
  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('P3-04: recoverInflightRuns marks orphaned running run as failed', async () => {
  const { recoverInflightRuns } = await import('../../src/agent/recovery.js');
  const ctx = freshRuntime();
  // Create a run stuck in 'running' by transitioning manually with a stale updated_at.
  const created = ctx.runStore.createRun(baseInput);
  ctx.runStore.transitionRun(created.run_id, 'planning');
  ctx.runStore.transitionRun(created.run_id, 'running');
  // Backdate updated_at so it is considered stale.
  ctx.db.prepare(`UPDATE agent_runs SET updated_at = ? WHERE run_id = ?`).run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), created.run_id);
  const recovered = recoverInflightRuns({ runStore: ctx.runStore, eventPublisher: ctx.eventPublisher, auditLogger: { async log() {} }, staleThresholdMs: 60 * 1000 });
  assert.deepEqual(recovered, [created.run_id]);
  const final = ctx.runStore.getRun(created.run_id);
  assert.equal(final.status, 'failed');
  assert.equal(final.error_code, 'runtime_interrupted');
  ctx.cleanup();
});
