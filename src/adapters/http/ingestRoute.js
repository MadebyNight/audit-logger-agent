import fs from 'fs';
import path from 'path';
import { normalizeEntry, validateLogEntry } from '../../../scripts/lib/parser.js';
import { insertEvents } from '../../../scripts/lib/db.js';
import { getRuntimePaths } from '../../app/paths.js';

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

function json(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
}

function contentType(req) {
  return String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function maxBodyBytes(config) {
  return config.ingest?.http?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
}

function maxLineBytes(config) {
  return config.ingest?.http?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
}

export function isHttpIngestEnabled(config = {}) {
  return config.ingest?.http?.enabled !== false;
}

export function resolveSpoolDir(config = {}) {
  return getRuntimePaths(config).spoolDir;
}

function isSafeAgentId(agentId) {
  if (typeof agentId !== 'string') return false;
  if (agentId.length === 0) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(agentId)) return false;
  if (agentId === '.' || agentId === '..') return false;
  if (agentId.includes('..')) return false;
  if (path.posix.basename(agentId) !== agentId) return false;
  if (path.win32.basename(agentId) !== agentId) return false;
  return true;
}

function eventDate(event) {
  return new Date(event.ts).toISOString().slice(0, 10);
}

async function readBody(req, limitBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    const error = new Error('Request body exceeds maxBodyBytes');
    error.code = 'body_too_large';
    throw error;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error('Request body exceeds maxBodyBytes');
      error.code = 'body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function parseJsonBody(raw) {
  const parsed = raw ? JSON.parse(raw) : {};
  if (Array.isArray(parsed?.events)) return parsed.events.map((event, index) => ({ event, index }));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [{ event: parsed, index: 0 }];
  const error = new Error('JSON body must be one event object or { "events": [...] }');
  error.code = 'invalid_body';
  throw error;
}

function parseNdjsonBody(raw, lineLimitBytes) {
  const events = [];
  const errors = [];
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line.trim() === '') continue;
    if (Buffer.byteLength(line, 'utf-8') > lineLimitBytes) {
      errors.push({ index: i, error_code: 'payload_too_large', error: `line exceeds maxLineBytes (${lineLimitBytes})` });
      continue;
    }
    try {
      events.push({ event: JSON.parse(line), index: i });
    } catch (error) {
      errors.push({ index: i, error: `invalid JSON: ${error.message}` });
    }
  }
  return { events, errors };
}

function validateEvent(event, index, lineLimitBytes) {
  const errors = [];
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return {
      errors: [{ index, error: 'event must be a JSON object' }],
      normalizedEvent: null,
    };
  }

  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, 'utf-8') > lineLimitBytes) {
    errors.push({ index, error_code: 'payload_too_large', error: `event exceeds maxLineBytes (${lineLimitBytes})` });
  }

  if (!isSafeAgentId(event.agent_id)) {
    errors.push({ index, error: 'agent_id is invalid' });
  }

  const validationErrors = validateLogEntry(event, index + 1);
  for (const error of validationErrors) {
    errors.push(typeof error === 'string' ? { index, error } : {
      index, error: error.message, error_code: error.code, field: error.field, trace_id: event.trace_id,
    });
  }

  return { errors, normalizedEvent: event };
}

function appendAcceptedEvents(config, events) {
  const spoolDir = resolveSpoolDir(config);
  for (const event of events) {
    const agentDir = path.join(spoolDir, event.agent_id);
    const file = path.join(agentDir, `audit-${eventDate(event)}.jsonl`);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8');
  }
}

export async function handleIngestRoute(req, res, { config = {}, db, toolSemanticMapper, onAcceptedBatch } = {}) {
  const type = contentType(req);
  const limitBytes = maxBodyBytes(config);
  const lineLimitBytes = maxLineBytes(config);

  let raw;
  try {
    raw = await readBody(req, limitBytes);
  } catch (error) {
    if (error.code === 'body_too_large') {
      json(res, 413, { error_code: 'payload_too_large', error: error.message });
      return;
    }
    throw error;
  }

  let events = [];
  let errors = [];
  try {
    if (type === 'application/json') {
      events = parseJsonBody(raw);
    } else if (type === 'application/x-ndjson') {
      const parsed = parseNdjsonBody(raw, lineLimitBytes);
      events = parsed.events;
      errors = parsed.errors;
    } else {
      json(res, 415, { error_code: 'unsupported_media_type', error: 'Content-Type must be application/json or application/x-ndjson' });
      return;
    }
  } catch (error) {
    json(res, 400, { error_code: error.code ?? 'invalid_body', error: error.message });
    return;
  }

  const accepted = [];
  const rejectedIndexes = new Set(errors.map((error) => error.index));
  for (const item of events) {
    const { errors: eventErrors, normalizedEvent } = validateEvent(item.event, item.index, lineLimitBytes);
    if (eventErrors.length > 0) {
      errors.push(...eventErrors);
      rejectedIndexes.add(item.index);
      continue;
    }
    accepted.push({ originalEvent: item.event, normalizedEvent });
  }

  if (accepted.length > 0) {
    appendAcceptedEvents(config, accepted.map((item) => item.originalEvent));
    if (db) {
      insertEvents(db, accepted.map((item) => normalizeEntry(item.normalizedEvent)));
      if (toolSemanticMapper) {
        // Mapping may invoke an LLM. Ingest acknowledgment must not wait for it.
        toolSemanticMapper
          .mapPendingEvents({ limit: Math.max(accepted.length, 1) })
          .catch(() => {});
      }
    }
    if (typeof onAcceptedBatch === 'function') {
      Promise.resolve()
        .then(() => onAcceptedBatch({ accepted: accepted.length }))
        .catch(() => {});
    }
  }

  const codedError = errors.find((error) => error.error_code === 'payload_too_large')
    ?? errors.find((error) => error.error_code);
  json(res, codedError?.error_code === 'payload_too_large' ? 413 : codedError ? 400 : 202, {
    ...(codedError ? { error_code: codedError.error_code, trace_id: codedError.trace_id } : {}),
    accepted: accepted.length,
    rejected: rejectedIndexes.size,
    errors,
  });
}
