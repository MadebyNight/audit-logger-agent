import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

test('config.json exposes retention defaults for runtime data and owned files', () => {
  const config = JSON.parse(readText('config.json'));
  const container = JSON.parse(readText('config.container.json'));
  for (const current of [config, container]) {
    assert.equal('eventsHours' in current.retention, false);
    assert.equal('maxEventsPerAgent' in current.retention, false);
    assert.equal(current.retention.traceDays, 30);
    assert.equal(current.retention.highRiskTraceDays, 90);
    assert.equal(current.retention.maxTracesPerAgent, 2000);
  }
  assert.equal(config.auditReview.http.requireHttpsBaseUrl, false);
  assert.equal(container.auditReview.http.requireHttpsBaseUrl, true);

  assert.equal(config.tmpDir, 'data/tmp');
  assert.equal(config.capturesDir, 'data/captures');
  assert.equal(config.logDir, 'logs');
  assert.deepEqual(
    {
      runtimeRunsDays: config.retention.runtimeRunsDays,
      traceDays: config.retention.traceDays,
      highRiskTraceDays: config.retention.highRiskTraceDays,
      maxTracesPerAgent: config.retention.maxTracesPerAgent,
      waitingStatesDays: config.retention.waitingStatesDays,
      llmUsageDays: config.retention.llmUsageDays,
      logFilesDays: config.retention.logFilesDays,
      tmpFilesDays: config.retention.tmpFilesDays,
      captureFilesDays: config.retention.captureFilesDays,
    },
    {
      runtimeRunsDays: 30,
      traceDays: 30,
      highRiskTraceDays: 90,
      maxTracesPerAgent: 2000,
      waitingStatesDays: 30,
      llmUsageDays: 90,
      logFilesDays: 14,
      tmpFilesDays: 7,
      captureFilesDays: 30,
    },
  );
});

test('README links human users to deployment and Agent integration guides', () => {
  const readme = readText('README.md');

  for (const required of [
    'docs/dokploy-deployment.md',
    '(agent-audit-log-integration-guide.md)',
    '/dashboard',
  ]) {
    assert.ok(readme.includes(required), `README should include ${required}`);
  }
  assert.ok(readme.includes('Dashboard 页面可直接访问'));
  const integrationGuide = readText('agent-audit-log-integration-guide.md');
  for (const document of [readme, integrationGuide]) {
    assert.ok(document.includes('https://audit.madebynight.top/v1/ingest'));
    assert.ok(document.includes('https://audit.madebynight.top/v1/audit-logs'));
    assert.ok(document.includes('AUDIT_AGENT_DASHBOARD_BASE_URL=https://audit.madebynight.top'));
    assert.doesNotMatch(document, /https:\/\/[^\s]*traefik\.me/);
    assert.doesNotMatch(document, /docs\/agent-audit-log-integration-guide\.md/);
  }
  assert.doesNotMatch(readme, /"AUDIT_AGENT_DASHBOARD_TOKEN"\s*:/);
});

test('Dokploy deployment guide covers required deployment, security, and recovery steps', () => {
  const guide = readText('docs/dokploy-deployment.md');

  for (const required of [
    'AUDIT_AGENT_LLM_API_KEY',
    'AUDIT_AGENT_LLM_MODEL',
    'AUDIT_AGENT_LLM_BASE_URL',
    'AUDIT_AGENT_LLM_TIMEOUT_MS',
    'AUDIT_AGENT_DASHBOARD_TOKEN',
    'AUDIT_AGENT_DASHBOARD_BASE_URL',
    'compose.dokploy.yaml',
    'Dockerfile',
    '/app/data',
    '/health',
    'TLS',
    '/v1/ingest',
    'https://<域名>/dashboard',
    'auditReview.visualization.baseUrl',
    'callback',
    '备份',
    '恢复',
  ]) {
    assert.ok(guide.includes(required), `deployment guide should include ${required}`);
  }

  assert.match(guide, /公网只发布 HTTPS/);
  assert.match(guide, /不发布公网写入 router/);
  assert.match(guide, /requireHttpsBaseUrl=true/);
  assert.match(guide, /公网只发布 HTTPS/);
  assert.match(guide, /http:\/\/127\.0\.0\.1:9320\/health/);
});

test('Dokploy compose passes the dashboard base URL environment variable into the container', () => {
  const compose = readText('compose.dokploy.yaml');

  assert.match(
    compose,
    /AUDIT_AGENT_DASHBOARD_BASE_URL:\s*\$\{AUDIT_AGENT_DASHBOARD_BASE_URL:-\}/,
  );
});
