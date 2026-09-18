import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Worker } from 'node:worker_threads';

import { openDb, insertEvents } from '../../scripts/lib/db.js';
import { createHttpApp } from '../../src/adapters/http/app.js';

function makeEvent(index) {
  const event = {
    ts: `2026-07-03T10:${String(index % 60).padStart(2, '0')}:00.000Z`,
    agent_id: 'test-agent',
    trace_id: `trace-${index}`,
    span_id: `span-${index}`,
    event: 'tool.end',
    tool_name: 'example.tool',
    status: 'OK',
    result_summary: `ok-${index}`,
  };
  return {
    ts: event.ts,
    agent_id: event.agent_id,
    trace_id: event.trace_id,
    span_id: event.span_id,
    parent_span_id: null,
    event: event.event,
    tool_name: event.tool_name,
    status: event.status,
    result_summary: event.result_summary,
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

function runLockingWorker(dbPath, holdMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const Database = require('better-sqlite3');
      const db = new Database(workerData.dbPath);
      try {
        db.pragma('journal_mode = WAL');
        db.exec('BEGIN IMMEDIATE');
        parentPort.postMessage({ status: 'locked' });
        setTimeout(() => {
          try {
            db.exec('COMMIT');
            db.close();
            parentPort.postMessage({ status: 'released' });
          } catch (error) {
            parentPort.postMessage({ status: 'error', message: error.message });
          }
        }, workerData.holdMs);
      } catch (error) {
        parentPort.postMessage({ status: 'error', message: error.message });
      }
    `, { eval: true, workerData: { dbPath, holdMs } });

    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.status === 'locked') {
        resolve(worker);
      } else if (message.status === 'error') {
        reject(new Error(message.message));
      }
    });
  });
}

function waitForWorkerExit(worker) {
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });
}

test.skip('GET /query clamps huge limit to configured maximum', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-http-query-limit-'));
  let server;
  let db;
  try {
    const dbPath = path.join(tmpDir, 'audit.db');
    db = openDb(dbPath);
    insertEvents(db, Array.from({ length: 1005 }, (_, index) => makeEvent(index)));
    server = createHttpApp({
      db,
      config: {
        dbPath,
        agents: {},
        limits: { maxQueryLimit: 1000 },
      },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/query?limit=99999999`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.count, 1000);
    assert.equal(body.results.length, 1000);
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test.skip('GET /query concurrent requests succeed during a transient SQLite write lock', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-http-query-lock-'));
  let server;
  let db;
  let worker;
  try {
    const dbPath = path.join(tmpDir, 'audit.db');
    db = openDb(dbPath);
    insertEvents(db, Array.from({ length: 25 }, (_, index) => makeEvent(index)));
    server = createHttpApp({
      db,
      config: {
        dbPath,
        agents: {},
        limits: { maxQueryLimit: 1000 },
      },
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    worker = await runLockingWorker(dbPath, 200);

    const { port } = server.address();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`http://127.0.0.1:${port}/query?limit=5`))
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    assert.deepEqual(responses.map((response) => response.status), Array(20).fill(200));
    assert.ok(bodies.every((body) => body.count === 5 && body.results.length === 5));
    await waitForWorkerExit(worker);
    worker = null;
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    db?.close();
    if (worker) await worker.terminate();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
