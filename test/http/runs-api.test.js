import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../scripts/lib/db.js';
import { ensureRuntimeSchema } from '../../src/db/runtimeSchema.js';
import { createRunStore } from '../../src/agent/runStore.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

test.skip('POST /v1/runs creates a run and GET /v1/runs/:id returns it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const server = createHttpApp({
    db,
    config: { dbPath: path.join(tmpDir, 'runtime.db'), agents: {} },
    runStore,
    runtime: {
      async startRun(input) {
        return runStore.createRun(input);
      },
      async getRun(runId) {
        return runStore.getRun(runId);
      },
    },
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const createResponse = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: {
        type: 'manual',
        session_id: 'session_test',
        message_id: 'msg_test',
        requester_id: 'user_test',
      },
      request: { text: '帮我查询今天的异常任务并给出处理建议' },
      delivery: { mode: 'callback', target_url: 'http://127.0.0.1:9999/agent-events' },
      metadata: { tenant_key: 'tenant_test' },
    }),
  });

  assert.equal(createResponse.status, 202);
  const created = await createResponse.json();
  assert.equal(created.status, 'created');
  assert.ok(created.run_id.startsWith('run_'));

  const readResponse = await fetch(`${baseUrl}/v1/runs/${created.run_id}`);
  assert.equal(readResponse.status, 200);
  const run = await readResponse.json();
  assert.equal(run.run_id, created.run_id);
  assert.equal(run.request_text, '帮我查询今天的异常任务并给出处理建议');
  assert.equal(run.channel, 'manual');
  assert.equal(run.conversation_id, 'session_test');
  assert.equal(run.user_open_id, 'user_test');

  server.close();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test.skip('POST /v1/runs returns 413 when JSON body exceeds maxBodyBytes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-limit-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);

  const server = createHttpApp({
    db,
    config: {
      dbPath: path.join(tmpDir, 'runtime.db'),
      agents: {},
      limits: { maxBodyBytes: 128 },
    },
    runStore,
    runtime: {
      async startRun(input) {
        return runStore.createRun(input);
      },
      async getRun(runId) {
        return runStore.getRun(runId);
      },
    },
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: {
          type: 'manual',
          session_id: 'session_test',
          requester_id: 'user_test',
        },
        request: { text: 'x'.repeat(512) },
        delivery: { mode: 'callback', target_url: 'http://127.0.0.1:9999/agent-events' },
      }),
    });

    assert.equal(response.status, 413);
    assert.equal((await response.json()).error_code, 'payload_too_large');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get().count, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test.skip('non-callback delivery rejects target_url and the store never persists it', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-http-delivery-secret-'));
  const db = openDb(path.join(tmpDir, 'runtime.db'));
  ensureRuntimeSchema(db);
  const runStore = createRunStore(db);
  const server = createHttpApp({
    db,
    config: { dbPath: path.join(tmpDir, 'runtime.db'), agents: {} },
    runStore,
    runtime: {
      async startRun(input) { return runStore.createRun(input); },
      async getRun(runId) { return runStore.getRun(runId); },
    },
  });

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: { type: 'manual', session_id: 'session_secret', requester_id: 'user_secret' },
        request: { text: '安全边界测试' },
        delivery: { mode: 'feishu_bot', target_url: 'https://secret.invalid/webhook' },
      }),
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.ok(body.details.some((detail) => detail.field === 'delivery.target_url'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get().count, 0);

    const direct = runStore.createRun({
      sourceType: 'manual',
      sessionId: 'direct_session',
      requesterId: 'direct_user',
      requestText: '存储层防御测试',
      deliveryMode: 'feishu_bot',
      deliveryTargetUrl: 'https://secret.invalid/webhook',
    });
    assert.equal(direct.delivery_callback_url, null);
    assert.equal(
      db.prepare('SELECT delivery_callback_url FROM agent_runs WHERE run_id = ?').get(direct.run_id).delivery_callback_url,
      null,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
