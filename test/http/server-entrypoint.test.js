import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as serverEntrypoint from '../../src/adapters/http/serverListen.js';
import { resolveServerBindHost, listenHttpServer } from '../../src/adapters/http/serverListen.js';
import { loadAppConfig } from '../../src/app/loadConfig.js';
import { getRuntimePaths, migrateLegacyRuntimeArtifacts } from '../../src/app/paths.js';

test('server entrypoint resolves configured auditReview.http.bindHost', () => {
  assert.equal(
    resolveServerBindHost(
      { auditReview: { http: { bindHost: '0.0.0.0' } } },
      { args: [], env: {} },
    ),
    '0.0.0.0',
  );
  assert.equal(resolveServerBindHost({ auditReview: { http: {} } }, { args: [], env: {} }), '127.0.0.1');
});

test('server entrypoint prioritizes --bind, environment, config, then loopback', () => {
  const config = { auditReview: { http: { bindHost: '127.0.0.8' } } };

  assert.equal(
    resolveServerBindHost(config, {
      args: ['node', 'scripts/server.js', '--bind', '0.0.0.0'],
      env: { AUDIT_AGENT_BIND_HOST: '127.0.0.7' },
    }),
    '0.0.0.0',
  );
  assert.equal(
    resolveServerBindHost(config, { args: [], env: { AUDIT_AGENT_BIND_HOST: '127.0.0.7' } }),
    '127.0.0.7',
  );
  assert.equal(resolveServerBindHost(config, { args: [], env: {} }), '127.0.0.8');
  assert.equal(resolveServerBindHost({}, { args: [], env: {} }), '127.0.0.1');
});

test('loadAppConfig resolves AUDIT_AGENT_CONFIG_PATH from the project root', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-config-env-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({ marker: 'default' }), 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'deploy', 'config.json'), JSON.stringify({ marker: 'custom' }), 'utf-8');

    const config = loadAppConfig(tmpDir, { env: { AUDIT_AGENT_CONFIG_PATH: '  deploy/config.json  ' } });

    assert.equal(config.marker, 'custom');
    assert.equal(config.rootDir, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('graceful shutdown releases resources once and exits despite cleanup errors', async () => {
  assert.equal(typeof serverEntrypoint.createGracefulShutdown, 'function');

  const calls = [];
  const errors = [];
  const shutdown = serverEntrypoint.createGracefulShutdown({
    scheduler: { stop: () => calls.push('scheduler.stop') },
    retentionScheduler: { stop: () => { calls.push('retention.stop'); throw new Error('retention failed'); } },
    notificationDigestScheduler: { stop: () => calls.push('notification.stop') },
    flushInterval: 'timer',
    clearIntervalFn: (timer) => calls.push(`clear:${timer}`),
    eventPublisher: { flushPending: async (limit) => calls.push(`flush:${limit}`) },
    server: { close: (done) => { calls.push('server.close'); done(); } },
    db: { close: () => calls.push('db.close') },
    logError: (message) => errors.push(message),
    exit: (code) => calls.push(`exit:${code}`),
  });

  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

  assert.deepEqual(calls, [
    'scheduler.stop',
    'retention.stop',
    'notification.stop',
    'clear:timer',
    'flush:20',
    'server.close',
    'db.close',
    'exit:0',
  ]);
  assert.equal(errors.length, 1);
});

test('graceful shutdown continues when error reporting itself fails', async () => {
  const calls = [];
  const shutdown = serverEntrypoint.createGracefulShutdown({
    scheduler: { stop: () => { throw new Error('scheduler failed'); } },
    logError: () => { throw new Error('logger failed'); },
    exit: (code) => calls.push(`exit:${code}`),
  });

  await shutdown('SIGTERM');

  assert.deepEqual(calls, ['exit:0']);
});

test('graceful shutdown continues after flush, HTTP close, and SQLite close failures', async () => {
  const calls = [];
  const errors = [];
  const shutdown = serverEntrypoint.createGracefulShutdown({
    eventPublisher: { flushPending: async () => { throw new Error('flush failed'); } },
    server: { close: (done) => done(new Error('close failed')) },
    db: { close: () => { throw new Error('db failed'); } },
    logError: (message) => errors.push(message),
    exit: (code) => calls.push(`exit:${code}`),
  });

  await shutdown('SIGTERM');

  assert.deepEqual(calls, ['exit:0']);
  assert.deepEqual(errors, [
    'Graceful shutdown event publisher flush failed: flush failed',
    'Graceful shutdown HTTP server close failed: close failed',
    'Graceful shutdown SQLite close failed: db failed',
  ]);
});

test('graceful shutdown times out hung flush and HTTP close before closing SQLite', async () => {
  const calls = [];
  const errors = [];
  const immediateTimeout = (callback) => {
    callback();
    return 'timeout';
  };
  const shutdown = serverEntrypoint.createGracefulShutdown({
    eventPublisher: { flushPending: () => { calls.push('flush'); return new Promise(() => {}); } },
    server: { close: () => { calls.push('server.close'); } },
    db: { close: () => calls.push('db.close') },
    setTimeoutFn: immediateTimeout,
    clearTimeoutFn: (timer) => calls.push(`clearTimeout:${timer}`),
    shutdownTimeoutMs: 1,
    logError: (message) => errors.push(message),
    exit: (code) => calls.push(`exit:${code}`),
  });

  const result = await Promise.race([
    shutdown('SIGTERM').then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 50)),
  ]);

  assert.equal(result, 'completed');
  assert.deepEqual(calls, [
    'flush',
    'clearTimeout:timeout',
    'server.close',
    'clearTimeout:timeout',
    'db.close',
    'exit:0',
  ]);
  assert.deepEqual(errors, [
    'Graceful shutdown event publisher flush timed out after 1ms',
    'Graceful shutdown HTTP server close timed out after 1ms',
  ]);
});

test('server script retains the HTTP server and registers both shutdown signals', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'scripts', 'server.js'), 'utf-8');

  assert.match(source, /const server = listenHttpServer\(app,/);
  assert.match(source, /createFindingLifecycleService\(\{ reviewStore,/);
  assert.match(source, /findingLifecycleService,/);
  assert.match(source, /flushNotifications:\s*\(\)\s*=>\s*eventPublisher\.flushPending\(20\)/);
  assert.match(source, /createGracefulShutdown\(\{/);
  assert.match(source, /process\.on\('SIGINT', handleShutdown\)/);
  assert.match(source, /process\.on\('SIGTERM', handleShutdown\)/);
});

test('server entrypoint starts app on the resolved bind host', async () => {
  const listenCalls = [];
  const app = {
    listen(port, host, callback) {
      listenCalls.push({ port, host });
      callback?.();
      return { address: () => ({ port, address: host }) };
    },
  };

  let announced = null;
  listenHttpServer(app, {
    port: 9321,
    bindHost: '0.0.0.0',
    onListening: (url) => { announced = url; },
  });

  assert.deepEqual(listenCalls, [{ port: 9321, host: '0.0.0.0' }]);
  assert.equal(announced, 'http://0.0.0.0:9321');
});

test('loadAppConfig fills the normalized runtime path defaults', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-config-layout-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      agents: {},
      ingest: { http: { enabled: true } },
    }), 'utf-8');

    const config = loadAppConfig(tmpDir);
    assert.equal(config.rootDir, tmpDir);
    assert.equal(config.dbPath, 'data/db/audit.db');
    assert.equal(config.ingest.spoolDir, 'data/spool/incoming');
    assert.equal(config.capturesDir, 'data/captures');
    assert.equal(config.tmpDir, 'data/tmp');
    assert.equal(config.logDir, 'logs');
    assert.equal(config.paths.dbPath, path.join(tmpDir, 'data', 'db', 'audit.db'));
    assert.equal(config.paths.spoolDir, path.join(tmpDir, 'data', 'spool', 'incoming'));
    assert.equal(config.paths.capturesDir, path.join(tmpDir, 'data', 'captures'));
    assert.equal(config.paths.tmpDir, path.join(tmpDir, 'data', 'tmp'));
    assert.equal(config.paths.logDir, path.join(tmpDir, 'logs'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy runtime artifacts migrate into the normalized layout', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-migrate-layout-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify({
      dbPath: 'data/db/audit.db',
      ingest: {
        http: { enabled: true },
        spoolDir: 'data/spool/incoming',
      },
      capturesDir: 'data/captures',
      tmpDir: 'data/tmp',
      logDir: 'logs',
    }), 'utf-8');

    fs.mkdirSync(path.join(tmpDir, 'data', 'incoming', 'legacy-agent'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.server.log'), 'legacy server log\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, '.callback-9999.log'), 'legacy callback log\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'data', 'callback-events.ndjson'), '{"ok":true}\n', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'data', 'audit.db'), 'db', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'data', 'audit.db-wal'), 'wal', 'utf-8');
    fs.writeFileSync(path.join(tmpDir, 'data', 'incoming', 'legacy-agent', 'audit-2026-07-07.jsonl'), '{"trace_id":"legacy"}\n', 'utf-8');

    const config = loadAppConfig(tmpDir);
    const migration = migrateLegacyRuntimeArtifacts(config);

    assert.ok(migration.moved.length >= 5);
    assert.equal(fs.existsSync(path.join(tmpDir, '.server.log')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, '.callback-9999.log')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'callback-events.ndjson')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'audit.db')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'data', 'incoming')), false);
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'logs', 'server.log'), 'utf-8'),
      'legacy server log\n',
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'logs', 'callback-9999.log'), 'utf-8'),
      'legacy callback log\n',
    );
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'data', 'captures', 'callback-events.ndjson'), 'utf-8'),
      '{"ok":true}\n',
    );
    assert.equal(fs.readFileSync(path.join(tmpDir, 'data', 'db', 'audit.db'), 'utf-8'), 'db');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'data', 'db', 'audit.db-wal'), 'utf-8'), 'wal');
    assert.equal(
      fs.readFileSync(path.join(tmpDir, 'data', 'spool', 'incoming', 'legacy-agent', 'audit-2026-07-07.jsonl'), 'utf-8'),
      '{"trace_id":"legacy"}\n',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getRuntimePaths preserves an already-resolved custom layout object', () => {
  const rootDir = path.join(os.tmpdir(), 'audit-runtime-paths-custom');
  const resolvedPaths = {
    rootDir,
    dbPath: path.join(rootDir, 'var', 'db', 'audit.db'),
    dbDir: path.join(rootDir, 'var', 'db'),
    spoolDir: path.join(rootDir, 'var', 'spool', 'incoming'),
    capturesDir: path.join(rootDir, 'var', 'captures'),
    tmpDir: path.join(rootDir, 'var', 'tmp'),
    logDir: path.join(rootDir, 'var', 'logs'),
    serverLogPath: path.join(rootDir, 'var', 'logs', 'server.log'),
    serverErrLogPath: path.join(rootDir, 'var', 'logs', 'server.err.log'),
    callbackReceiverLogPath: path.join(rootDir, 'var', 'logs', 'callback-9999.log'),
    callbackReceiverErrLogPath: path.join(rootDir, 'var', 'logs', 'callback-9999.err.log'),
    callbackCapturePath: path.join(rootDir, 'var', 'captures', 'callback-events.ndjson'),
  };

  assert.equal(getRuntimePaths(resolvedPaths), resolvedPaths);
});

test('getRuntimePaths merges partial config.paths overrides with normalized defaults', () => {
  const rootDir = path.join(os.tmpdir(), 'audit-runtime-paths-partial');

  const paths = getRuntimePaths({
    rootDir,
    ingest: {
      spoolDir: 'data/spool/incoming',
    },
    paths: {
      rootDir,
      dbPath: path.join(rootDir, 'runtime', 'db', 'audit.db'),
    },
  });

  assert.equal(paths.dbPath, path.join(rootDir, 'runtime', 'db', 'audit.db'));
  assert.equal(paths.spoolDir, path.join(rootDir, 'data', 'spool', 'incoming'));
  assert.equal(paths.capturesDir, path.join(rootDir, 'data', 'captures'));
  assert.equal(paths.tmpDir, path.join(rootDir, 'data', 'tmp'));
  assert.equal(paths.logDir, path.join(rootDir, 'logs'));
});


test('real server ingests and reviews a Trace, restarts without backfill, and shuts down cleanly', { timeout: 20000 }, async () => {
  const { fork } = await import('node:child_process');
  const { once } = await import('node:events');
  const net = await import('node:net');
  const { default: Database } = await import('better-sqlite3');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-server-lifecycle-'));
  const configPath = path.join(tmp, 'config.json');
  const dbPath = path.join(tmp, 'audit.db');
  const config = {
    dbPath, agents: {}, capturesDir: path.join(tmp, 'captures'), tmpDir: path.join(tmp, 'tmp'), logDir: path.join(tmp, 'logs'),
    ingest: { spoolDir: path.join(tmp, 'spool'), http: { enabled: true } },
    retention: { enabled: false },
    auditReview: { enabled: true, initialDelaySeconds: 3600, intervalMinutes: 30,
      http: { bindHost: '127.0.0.1' }, notification: { enabled: false },
      visualization: { baseUrl: 'http://127.0.0.1:9320' } },
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  let db;
  let child;
  let output = '';
  const boot = async () => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    // IPC signal bridge lets Windows execute the real registered SIGTERM handler.
    const bridge = 'data:text/javascript,process.on("message",m=>{if(m==="shutdown")process.emit("SIGTERM")})';
    child = fork(path.resolve('scripts/server.js'), ['--port', String(port)], {
      execArgv: ['--import', bridge], silent: true,
      env: { ...process.env, AUDIT_AGENT_CONFIG_PATH: configPath,
        AUDIT_AGENT_LLM_API_KEY: 'local-test-only', AUDIT_AGENT_LLM_MODEL: 'test-model',
        AUDIT_AGENT_LLM_BASE_URL: 'http://127.0.0.1:1/v1', AUDIT_AGENT_DASHBOARD_TOKEN: 'test-token',
        AUDIT_AGENT_FEISHU_MODE: 'disabled' },
    });
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) assert.fail(output);
      try { if ((await fetch(`${base}/health`)).ok) return base; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`server did not start: ${output}`);
  };
  const stop = async () => {
    const exited = once(child, 'exit');
    child.send('shutdown');
    const [code] = await exited;
    child = null;
    assert.equal(code, 0, output);
  };
  try {
    let base = await boot();
    const ts = new Date().toISOString();
    const event = { ts, agent_id: 'lifecycle-agent', trace_id: 'lifecycle-trace', span_id: 's',
      tool_name: 'task', status: 'OK', result_summary: 'done', event: 'run.final_result', agent_result: 'done' };
    const response = await fetch(`${base}/v1/ingest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) });
    const accepted = await response.json();
    assert.equal(response.status, 202, JSON.stringify(accepted));
    assert.equal(accepted.accepted, 1, JSON.stringify(accepted));
    const manual = await fetch(`${base}/v1/audit-reviews/run`, { method: 'POST', headers: { authorization: 'Bearer test-token' } });
    assert.equal(manual.status, 202, await manual.text());
    await stop();
    db = new Database(dbPath);
    const first = db.prepare("SELECT * FROM audit_traces WHERE agent_id = 'lifecycle-agent'").get();
    assert.ok(first, JSON.stringify({ events: db.prepare('SELECT agent_id, trace_id, ingested_at FROM audit_events').all(), runs: db.prepare('SELECT * FROM audit_review_runs').all(), output }));
    assert.equal(first.risk_level, 'none');
    assert.equal(first.review_version, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_review_locks').get().n, 0);
    db.close();
    base = await boot();
    assert.equal((await fetch(`${base}/health`)).status, 200);
    await stop();
    db = new Database(dbPath);
    assert.equal(db.prepare("SELECT review_version FROM audit_traces WHERE agent_id = 'lifecycle-agent'").get().review_version, 1);
    db.close();
    assert.doesNotMatch(output, /database connection is not open|Trace aggregation failed|Graceful shutdown .*failed/);
  } finally {
    if (child) { const exited = once(child, 'exit'); child.kill(); await exited; }
    if (db?.open) db.close();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
