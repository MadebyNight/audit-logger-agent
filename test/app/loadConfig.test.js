import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadAppConfig } from '../../src/app/loadConfig.js';

test('dashboard base URL environment variable overrides container configuration', () => {
  const config = loadAppConfig(process.cwd(), {
    env: {
      AUDIT_AGENT_CONFIG_PATH: 'config.container.json',
      AUDIT_AGENT_DASHBOARD_BASE_URL: '  http://audit.example.test  ',
    },
  });

  assert.equal(
    config.auditReview.visualization.baseUrl,
    'http://audit.example.test',
  );
});

test('blank dashboard base URL environment variable preserves file configuration', () => {
  const config = loadAppConfig(process.cwd(), {
    env: {
      AUDIT_AGENT_CONFIG_PATH: 'config.json',
      AUDIT_AGENT_DASHBOARD_BASE_URL: '   ',
    },
  });

  assert.equal(
    config.auditReview.visualization.baseUrl,
    'http://127.0.0.1:9320',
  );
});

test('ingest mode resolution prefers per-agent config over environment and defaults to compat', () => {
  const config = loadAppConfig(process.cwd(), {
    env: { AUDIT_INGEST_STRICT_MODE: 'strict' },
  });

  assert.equal(config.ingest.defaultMode, 'strict');
  assert.deepEqual(config.agents, {});

  const compatConfig = loadAppConfig(process.cwd(), {
    env: { AUDIT_INGEST_STRICT_MODE: '  compat  ' },
  });
  assert.equal(compatConfig.ingest.defaultMode, 'compat');
  assert.deepEqual(compatConfig.agents, {});
});

test('ingest mode defaults to compat when no mode is configured', () => {
  const config = loadAppConfig(process.cwd(), { env: {} });

  assert.equal(config.ingest.defaultMode, 'compat');
});


test('per-agent ingestMode is preserved independently of environment default', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-config-'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { 'agent-a': { ingestMode: 'strict' } },
    ingest: {},
  }));
  try {
    const config = loadAppConfig(rootDir, {
      env: { AUDIT_INGEST_STRICT_MODE: 'compat' },
    });

    assert.equal(config.ingest.defaultMode, 'compat');
    assert.equal(config.agents['agent-a'].ingestMode, 'strict');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
