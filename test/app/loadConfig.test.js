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
      AUDIT_AGENT_DASHBOARD_BASE_URL: '  https://audit.example.test  ',
    },
  });

  assert.equal(
    config.auditReview.visualization.baseUrl,
    'https://audit.example.test',
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

test('config no longer creates an ingest mode from legacy environment switches', () => {
  for (const value of ['strict', 'compat', '']) {
    const config = loadAppConfig(process.cwd(), { env: { AUDIT_INGEST_STRICT_MODE: value } });
    assert.equal(config.ingest.defaultMode, undefined);
  }
});

test('HTTPS startup guard is explicit and requires a valid environment URL', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-https-config-'));
  try {
    const file = path.join(rootDir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ auditReview: { http: { requireHttpsBaseUrl: true } } }));
    for (const value of ['', 'http://localhost:9320', 'https://', 'not-a-url']) {
      assert.throws(() => loadAppConfig(rootDir, { env: { AUDIT_AGENT_DASHBOARD_BASE_URL: value } }), /valid HTTPS URL/);
    }
    assert.equal(loadAppConfig(rootDir, { env: { AUDIT_AGENT_DASHBOARD_BASE_URL: 'https://audit.example.test' } }).auditReview.visualization.baseUrl, 'https://audit.example.test');
    fs.writeFileSync(file, '{}');
    assert.equal(loadAppConfig(rootDir, { env: { AUDIT_AGENT_DASHBOARD_BASE_URL: 'http://localhost:9320' } }).auditReview.visualization.baseUrl, 'http://localhost:9320');
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
