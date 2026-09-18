import { createHash, randomBytes, randomUUID } from 'node:crypto';

const digest = (token) => createHash('sha256').update(token).digest('hex');
const FILTERS = new Set(['agent_id', 'trace_id', 'requester_id', 'trace_status', 'risk_level', 'context_status', 'event', 'tool_name', 'status', 'from', 'to', 'limit', 'cursor', 'with_total']);

export function createApiTokenService({ db, legacyToken, now = () => new Date() }) {
  const insert = db.prepare(`INSERT INTO api_service_accounts
    (account_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?)`);
  if (legacyToken?.trim()) {
    const hash = digest(legacyToken);
    if (!db.prepare('SELECT 1 FROM api_service_accounts WHERE token_hash = ?').get(hash)) {
      insert.run(randomUUID(), '历史接入账号', hash, '环境变量 Token', now().toISOString());
    }
  }
  return {
    create(name) {
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 80) {
        throw Object.assign(new Error('调用方名称须为 1—80 个字符'), { status: 400 });
      }
      const token = `aat_${randomBytes(32).toString('hex')}`;
      const accountId = randomUUID();
      insert.run(accountId, name.trim(), digest(token), token.slice(0, 12), now().toISOString());
      return { accountId, token };
    },
    authenticate(req) {
      const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
      if (!token) return { ok: false, accountId: null };
      const account = db.prepare('SELECT account_id, revoked_at, deleted_at FROM api_service_accounts WHERE token_hash = ?').get(digest(token));
      return { ok: Boolean(account && !account.revoked_at && !account.deleted_at), accountId: account?.account_id ?? null };
    },
    revoke(id) {
      return db.prepare('UPDATE api_service_accounts SET revoked_at = COALESCE(revoked_at, ?) WHERE account_id = ? AND deleted_at IS NULL').run(now().toISOString(), id).changes > 0;
    },
    restore(id) {
      return db.prepare('UPDATE api_service_accounts SET revoked_at = NULL WHERE account_id = ? AND deleted_at IS NULL').run(id).changes > 0;
    },
    remove(id) {
      return db.prepare('UPDATE api_service_accounts SET deleted_at = ? WHERE account_id = ? AND deleted_at IS NULL').run(now().toISOString(), id).changes > 0;
    },
    list() {
      return db.prepare('SELECT account_id, name, created_at, revoked_at FROM api_service_accounts WHERE deleted_at IS NULL ORDER BY created_at DESC, account_id').all();
    },
    record({ accountId, searchParams, status, count, durationMs }) {
      const at = now().toISOString();
      const filters = [...searchParams].filter(([key]) => FILTERS.has(key));
      db.transaction(() => {
        db.prepare('INSERT INTO api_access_records (account_id, requested_at, filters_json, status_code, trace_count, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
          .run(accountId, at, JSON.stringify(filters), status, count, Math.max(0, Math.round(durationMs)));
        if (accountId && status !== 401) db.prepare('UPDATE api_service_accounts SET last_used_at = ? WHERE account_id = ?').run(at, accountId);
      })();
    },
    recent() {
      return db.prepare(`SELECT r.*, a.name FROM api_access_records r LEFT JOIN api_service_accounts a USING(account_id) ORDER BY r.id DESC LIMIT 100`).all();
    },
  };
}
