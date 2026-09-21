import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { openDb } from '../../scripts/lib/db.js';
import { ensureReviewSchema } from '../../src/db/reviewSchema.js';
import { createApiTokenService } from '../../src/auditReview/apiTokenService.js';
import { createHttpApp } from '../../src/adapters/http/app.js';
import { createDashboardAuth } from '../../src/auditReview/dashboardAuth.js';
import { renderApiTokenDrawer } from '../../src/auditReview/apiTokenTemplate.js';

test('Agent instructions use the current origin and remain selectable when clipboard access fails', async () => {
  const html = renderApiTokenDrawer({ accounts: [], records: [], returnTo: '/', open: false });
  const encoded = /<textarea[^>]*id="agent-api-instructions"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)[1];
  const field = {
    value: encoded.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'),
    focus() { this.focused = true; },
    select() { this.selected = true; },
  };
  const elements = {
    'api-token-drawer': { querySelectorAll: () => [] },
    'open-api-tokens': {}, 'close-api-tokens': {},
    'agent-api-instructions': field,
    'copy-agent-instructions': {}, 'agent-instructions-result': {},
  };
  let copied;
  const navigator = { clipboard: { async writeText(value) { copied = value; } } };
  runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], {
    document: { getElementById: id => elements[id] },
    location: { origin: 'https://audit.example:9443' }, navigator,
  });
  await elements['copy-agent-instructions'].onclick();
  assert.ok(copied.includes('https://audit.example:9443/v1/audit-logs?agent_id=<实际Agent ID>&trace_id=<实际Trace ID>'));
  assert.ok(copied.includes('https://audit.example:9443/agent-audit-log-integration-guide.md'));
  assert.ok(!copied.includes('__AUDIT_ORIGIN__'));
  assert.match(elements['agent-instructions-result'].textContent, /已复制/);
  navigator.clipboard = undefined;
  await elements['copy-agent-instructions'].onclick();
  assert.equal(field.focused, true);
  assert.equal(field.selected, true);
  assert.match(elements['agent-instructions-result'].textContent, /Ctrl\+C/);
});

test('Dashboard drawer issues independent tokens and logs reads outside the audit pipeline', async t => {
  const db = openDb(':memory:');
  ensureReviewSchema(db);
  const service = createApiTokenService({ db });
  const config = { dbPath: ':memory:' };
  const page = { page: { title: '测试 Dashboard' }, sections: [] };
  const app = createHttpApp({ db, config, apiTokenService: service, scheduler: {}, reviewStore: {}, visualization: { overviewPage: () => page }, dashboardAuth: createDashboardAuth({ config, env: {} }) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.close(resolve)); db.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const dashboard = await (await fetch(`${base}/dashboard`)).text();
  assert.match(dashboard, /<dialog[^>]+api-token-drawer/);
  assert.match(dashboard, /交给 Agent 使用/);
  assert.match(dashboard, /AUDIT_READ_TOKEN/);
  assert.match(dashboard, /复制 Agent 接入指令/);
  const guide = await fetch(`${base}/agent-audit-log-integration-guide.md`);
  assert.equal(guide.status, 200);
  assert.equal(guide.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.match(await guide.text(), /expected_purpose/);
  assert.equal((await fetch(`${base}/dashboard/api-tokens`)).status, 404);
  const issue = await fetch(`${base}/dashboard/api-tokens`, { method: 'POST', body: new URLSearchParams({ name: '审计助手', return_to: '/dashboard' }) });
  assert.equal(issue.headers.get('cache-control'), 'no-store');
  const body = await issue.text();
  const token = /value="(aat_[a-f0-9]+)"/.exec(body)?.[1];
  assert.ok(token);
  assert.equal(issue.redirected, false, 'legacy return path must not lose the one-time token');
  assert.match(body, /交给 Agent 使用/);
  const instructions = /<textarea[^>]*id="agent-api-instructions"[^>]*>([\s\S]*?)<\/textarea>/.exec(body)?.[1];
  assert.ok(instructions);
  assert.ok(!instructions.includes(token), 'copyable instructions should refer to the configured credential');
  const account = service.list()[0];
  assert.equal(account.name, '审计助手');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM api_service_accounts').all()).includes(token));
  assert.ok(!(await (await fetch(`${base}/dashboard`)).text()).includes(token));
  const second = service.create('另一个调用方');
  assert.notEqual(token, second.token);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${base}/v1/audit-logs`, { headers })).status, 200);
  const example = await fetch(`${base}/v1/audit-logs?limit=1`, { headers });
  assert.equal(example.status, 200);
  assert.deepEqual((await example.json()).traces, []);
  assert.equal((await fetch(`${base}/v1/audit-logs?limit=-1`, { headers })).status, 400);
  assert.equal(service.recent()[0].account_id, account.account_id);
  assert.equal(service.recent()[0].status_code, 400);
  assert.ok(db.prepare('SELECT last_used_at FROM api_service_accounts WHERE account_id = ?').get(account.account_id).last_used_at);
  await fetch(`${base}/dashboard/api-tokens/${account.account_id}/revoke`, { method: 'POST', body: new URLSearchParams({ return_to: '/dashboard' }) });
  assert.equal((await fetch(`${base}/v1/audit-logs`, { headers })).status, 401);
  await fetch(`${base}/dashboard/api-tokens/${account.account_id}/restore`, { method: 'POST', body: new URLSearchParams({ return_to: '/dashboard' }) });
  assert.equal((await fetch(`${base}/v1/audit-logs`, { headers })).status, 200);
  await fetch(`${base}/dashboard/api-tokens/${account.account_id}/delete`, { method: 'POST', body: new URLSearchParams({ return_to: '/dashboard' }) });
  assert.equal((await fetch(`${base}/v1/audit-logs`, { headers })).status, 401);
  assert.equal(service.restore(account.account_id), false);
  assert.ok(!service.list().some(a => a.account_id === account.account_id));
  assert.ok(service.recent().some(r => r.account_id === account.account_id && r.name === '审计助手' && r.status_code === 200));
  assert.equal((await fetch(`${base}/v1/audit-logs`, { headers: { authorization: `Bearer ${second.token}` } })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_traces').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_review_runs').get().n, 0);
});

test('legacy token migration is idempotent and never reactivates revoked accounts', () => {
  const db = openDb(':memory:');
  try {
    ensureReviewSchema(db);
    let service = createApiTokenService({ db, legacyToken: 'legacy' });
    service.revoke(service.list()[0].account_id);
    service = createApiTokenService({ db, legacyToken: 'legacy' });
    assert.equal(service.list().length, 1);
    assert.equal(service.authenticate({ headers: { authorization: 'Bearer legacy' } }).ok, false);
    assert.throws(() => service.create(' '), /调用方名称/);
    const id = service.list()[0].account_id;
    service.remove(id);
    service = createApiTokenService({ db, legacyToken: 'legacy' });
    assert.equal(service.list().length, 0);
    assert.equal(service.restore(id), false);
    assert.equal(service.authenticate({ headers: { authorization: 'Bearer legacy' } }).ok, false);
  } finally { db.close(); }
});
