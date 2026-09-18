import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../../src/adapters/http/app.js';

test('removed HTTP APIs are not exposed', async (t) => {
  const app = createHttpApp({ config: {} });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;

  for (const path of [
    '/v1/runs',
    '/v1/runs/example',
    '/query',
    '/report/daily',
    '/report/errors',
    '/report/tools',
    '/v1/audit-reviews',
    '/v1/audit-findings',
    '/dashboard/login',
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, path);
  }
});
