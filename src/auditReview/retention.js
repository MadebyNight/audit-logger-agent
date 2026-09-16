import fs from 'fs';
import path from 'path';

const DEFAULT_BATCH_SIZE = 5000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TERMINAL_RUN_STATUSES_SQL = `'completed', 'failed', 'cancelled'`;

const DEFAULT_RETENTION = {
  enabled: true,
  runAtHour: 4,
  traceDays: 30,
  highRiskTraceDays: 90,
  maxTracesPerAgent: 2000,
  runtimeRunsDays: 30,
  waitingStatesDays: 30,
  llmUsageDays: 90,
  outboxDays: 14,
  logFilesDays: 14,
  tmpFilesDays: 7,
  captureFilesDays: 30,
  vacuum: 'incremental',
};

const OWNED_FILE_TARGETS = [
  { key: 'logFiles', cutoffKey: 'logFiles', configKey: 'logDir', defaultRelativeDir: 'logs' },
  { key: 'tmpFiles', cutoffKey: 'tmpFiles', configKey: 'tmpDir', defaultRelativeDir: path.join('data', 'tmp') },
  { key: 'captureFiles', cutoffKey: 'captureFiles', configKey: 'capturesDir', defaultRelativeDir: path.join('data', 'captures') },
];

function retentionConfig(config) {
  return {
    ...DEFAULT_RETENTION,
    ...(config.retention ?? {}),
  };
}

function cutoffIso(now, days) {
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

function cutoffDay(now, days) {
  return cutoffIso(now, days).slice(0, 10);
}

function safePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeLimit(value) {
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_BATCH_SIZE;
}

function safePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function countRows(db, sql, params) {
  return db.prepare(sql).get(params).count;
}

function deleteBatched(db, { countSql, deleteSql, params, batchSize, dryRun }) {
  const total = countRows(db, countSql, params);
  if (dryRun || total === 0) {
    return { deleted: total, batches: [] };
  }

  const stmt = db.prepare(deleteSql);
  const batches = [];
  while (true) {
    const info = stmt.run({ ...params, limit: batchSize });
    if (info.changes === 0) break;
    batches.push(info.changes);
    if (info.changes < batchSize) break;
  }
  return { deleted: batches.reduce((sum, n) => sum + n, 0), batches };
}

function safeEvidenceArraySql(column) {
  return `CASE
    WHEN json_valid(${column}) THEN
      CASE WHEN json_type(${column}) = 'array' THEN ${column} ELSE '[]' END
    ELSE '[]'
  END`;
}

// Shared selection keeps dry-run and real cleanup identical. Pending traces are
// protected from both age and capacity pruning so their evidence stays complete.
function survivingAuditEventsCte() {
  return `WITH ranked_traces AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY agent_id ORDER BY last_event_at DESC, trace_id ASC
    ) AS retained_rank FROM audit_traces
  ), expired_traces AS (
    SELECT agent_id, trace_id FROM ranked_traces
    WHERE sealed_at IS NOT NULL
      AND (review_version > 0 OR sealed_reason = 'backfill'
        OR (review_error = 1 AND review_retry_count >= @maxRetries))
      AND (last_event_at < CASE WHEN risk_level = 'high' THEN @highRiskCutoff ELSE @auditCutoff END
        OR retained_rank > @maxPerAgent)
      AND (SELECT COUNT(*) FROM audit_events e
        WHERE e.agent_id = ranked_traces.agent_id AND e.trace_id = ranked_traces.trace_id
      ) <= ranked_traces.event_count
      AND NOT EXISTS (
        SELECT 1 FROM audit_events e
        WHERE e.agent_id = ranked_traces.agent_id AND e.trace_id = ranked_traces.trace_id
          AND e.ingested_at > COALESCE(ranked_traces.ingested_watermark, ranked_traces.updated_at)
      )
  ), expired_events AS (
    SELECT e.id FROM audit_events e WHERE EXISTS (
      SELECT 1 FROM expired_traces t WHERE t.agent_id = e.agent_id AND t.trace_id = e.trace_id
    ) OR (
      e.ts < @auditCutoff
      AND NOT EXISTS (SELECT 1 FROM audit_traces t WHERE t.agent_id = e.agent_id AND t.trace_id = e.trace_id)
      AND e.ingested_at < (SELECT last_ingested_at FROM audit_trace_scan_cursor WHERE cursor_name = 'trace_aggregation')
    )
  ), surviving_events AS (
    SELECT id FROM audit_events WHERE id NOT IN (SELECT id FROM expired_events)
  )`;
}

function hasEvidenceIdsSql(column) {
  return `json_array_length(${safeEvidenceArraySql(column)}) > 0`;
}

function hasSurvivingEvidenceSql(column) {
  return `EXISTS (
    SELECT 1
    FROM json_each(${safeEvidenceArraySql(column)}) evidence
    INNER JOIN surviving_events events ON events.id = CAST(evidence.value AS INTEGER)
  )`;
}

function staleOccurrenceSql(alias = 'occurrences') {
  return `(EXISTS (SELECT 1 FROM audit_review_findings f JOIN expired_traces t ON t.agent_id = f.agent_id AND t.trace_id = f.trace_id WHERE f.finding_id = ${alias}.finding_id) OR (
    (${alias}.observed_at < @auditCutoff AND NOT ${hasSurvivingEvidenceSql(`${alias}.evidence_event_ids_json`)})
    OR (
      ${hasEvidenceIdsSql(`${alias}.evidence_event_ids_json`)}
      AND NOT ${hasSurvivingEvidenceSql(`${alias}.evidence_event_ids_json`)}
    )
  ) AND NOT EXISTS (SELECT 1 FROM audit_review_findings f JOIN audit_traces t
    ON t.agent_id = f.agent_id AND t.trace_id = f.trace_id
    WHERE f.finding_id = ${alias}.finding_id AND NOT EXISTS
      (SELECT 1 FROM expired_traces x WHERE x.agent_id = t.agent_id AND x.trace_id = t.trace_id)))`;
}

function staleFindingSql(alias = 'findings') {
  return `(
    (${alias}.last_seen_at < @auditCutoff AND NOT ${hasSurvivingEvidenceSql(`${alias}.evidence_event_ids_json`)}
      AND NOT EXISTS (SELECT 1 FROM audit_traces t WHERE t.agent_id = ${alias}.agent_id AND t.trace_id = ${alias}.trace_id
        AND NOT EXISTS (SELECT 1 FROM expired_traces x WHERE x.agent_id = t.agent_id AND x.trace_id = t.trace_id)))
    OR EXISTS (SELECT 1 FROM expired_traces t WHERE t.agent_id = ${alias}.agent_id AND t.trace_id = ${alias}.trace_id)
    OR (
      ${hasEvidenceIdsSql(`${alias}.evidence_event_ids_json`)}
      AND NOT ${hasSurvivingEvidenceSql(`${alias}.evidence_event_ids_json`)}
    )
  )`;
}

function deleteFindingRows(db, findingIds) {
  const deleteActions = db.prepare(`DELETE FROM audit_finding_actions WHERE finding_id = ?`);
  const deleteOccurrences = db.prepare(`DELETE FROM audit_review_finding_occurrences WHERE finding_id = ?`);
  const deleteFinding = db.prepare(`DELETE FROM audit_review_findings WHERE finding_id = ?`);
  const deleteBatch = db.transaction((findingIds) => {
    let deleted = 0;
    for (const findingId of findingIds) {
      deleteActions.run(findingId);
      deleteOccurrences.run(findingId);
      deleted += deleteFinding.run(findingId).changes;
    }
    return deleted;
  });
  return deleteBatch(findingIds);
}

function maxSeverityOf(occurrences) {
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  return occurrences.reduce((highest, occurrence) => (
    (rank[occurrence.severity] ?? 0) > (rank[highest] ?? 0) ? occurrence.severity : highest
  ), occurrences[0]?.severity ?? null);
}

function rebaseFindingsFromOccurrences(db, findingIds) {
  if (findingIds.size === 0) return;

  const listOccurrences = db.prepare(`
    SELECT *
    FROM audit_review_finding_occurrences
    WHERE finding_id = ?
    ORDER BY observed_at ASC, occurrence_id ASC
  `);
  const updateFinding = db.prepare(`
    UPDATE audit_review_findings
    SET review_id = @first_review_id,
        first_review_id = @first_review_id,
        last_review_id = @last_review_id,
        severity = @severity,
        max_severity = @max_severity,
        title = @title,
        summary = @summary,
        recommendation = @recommendation,
        evidence_event_ids_json = @evidence_event_ids_json,
        evidence_json = @evidence_json,
        occurrence_count = @occurrence_count,
        created_at = @created_at,
        last_seen_at = @last_seen_at
    WHERE finding_id = @finding_id
  `);
  const rebase = db.transaction((ids) => {
    for (const findingId of ids) {
      const occurrences = listOccurrences.all(findingId);
      if (occurrences.length === 0) continue;
      const first = occurrences[0];
      const last = occurrences[occurrences.length - 1];
      updateFinding.run({
        finding_id: findingId,
        first_review_id: first.review_id,
        last_review_id: last.review_id,
        severity: last.severity,
        max_severity: maxSeverityOf(occurrences),
        title: last.title,
        summary: last.summary,
        recommendation: last.recommendation ?? null,
        evidence_event_ids_json: last.evidence_event_ids_json,
        evidence_json: last.evidence_json ?? null,
        occurrence_count: occurrences.length,
        created_at: first.created_at,
        last_seen_at: last.observed_at,
      });
    }
  });
  rebase([...findingIds]);
}

function deleteExpiredFindingOccurrences(db, {
  auditCutoff,
  highRiskCutoff,
  maxRetries,
  maxPerAgent,
  batchSize,
  dryRun,
}) {
  const params = { auditCutoff, highRiskCutoff, maxRetries, maxPerAgent };
  const cte = survivingAuditEventsCte();
  const predicate = staleOccurrenceSql();
  const total = countRows(db, `
    ${cte}
    SELECT COUNT(*) AS count
    FROM audit_review_finding_occurrences occurrences
    WHERE ${predicate}
  `, params);
  if (dryRun || total === 0) return { deleted: total, batches: [] };

  const selectRows = db.prepare(`
    ${cte}
    SELECT occurrences.occurrence_id, occurrences.finding_id
    FROM audit_review_finding_occurrences occurrences
    WHERE ${predicate}
    ORDER BY occurrences.observed_at ASC, occurrences.occurrence_id ASC
    LIMIT @limit
  `);
  const deleteOccurrence = db.prepare(`DELETE FROM audit_review_finding_occurrences WHERE occurrence_id = ?`);
  const deleteBatch = db.transaction((rows) => {
    let deleted = 0;
    for (const row of rows) deleted += deleteOccurrence.run(row.occurrence_id).changes;
    return deleted;
  });

  const affectedFindingIds = new Set();
  const batches = [];
  while (true) {
    const rows = selectRows.all({ ...params, limit: batchSize });
    if (rows.length === 0) break;
    for (const row of rows) affectedFindingIds.add(row.finding_id);
    const deleted = deleteBatch(rows);
    if (deleted === 0) break;
    batches.push(deleted);
    if (deleted < batchSize) break;
  }
  rebaseFindingsFromOccurrences(db, affectedFindingIds);
  return { deleted: batches.reduce((sum, n) => sum + n, 0), batches };
}

function deleteExpiredFindings(db, {
  auditCutoff,
  highRiskCutoff,
  maxRetries,
  maxPerAgent,
  batchSize,
  dryRun,
}) {
  const params = { auditCutoff, highRiskCutoff, maxRetries, maxPerAgent };
  const cte = survivingAuditEventsCte();
  const predicate = staleFindingSql();
  const total = countRows(db, `
    ${cte}
    SELECT COUNT(*) AS count
    FROM audit_review_findings findings
    WHERE ${predicate}
  `, params);
  if (dryRun || total === 0) return { deleted: total, batches: [] };

  const selectIds = db.prepare(`
    ${cte}
    SELECT findings.finding_id
    FROM audit_review_findings findings
    WHERE ${predicate}
    ORDER BY findings.last_seen_at ASC, findings.finding_id ASC
    LIMIT @limit
  `);

  const batches = [];
  while (true) {
    const findingIds = selectIds.all({ ...params, limit: batchSize }).map((row) => row.finding_id);
    if (findingIds.length === 0) break;
    const deleted = deleteFindingRows(db, findingIds);
    if (deleted === 0) break;
    batches.push(deleted);
    if (deleted < batchSize) break;
  }
  return { deleted: batches.reduce((sum, n) => sum + n, 0), batches };
}

function deleteExpiredReviewRuns(db, {
  auditCutoff,
  highRiskCutoff,
  maxRetries,
  maxPerAgent,
  batchSize,
  dryRun,
}) {
  const cte = survivingAuditEventsCte();
  const occurrenceIsStale = staleOccurrenceSql('occurrences');
  const findingIsStale = staleFindingSql('findings');
  return deleteBatched(db, {
    countSql: `
      ${cte}
      SELECT COUNT(*) AS count
      FROM audit_review_runs runs
      WHERE (runs.started_at < @auditCutoff OR runs.finding_count > 0)
        AND NOT EXISTS (
          SELECT 1
          FROM audit_review_finding_occurrences occurrences
          WHERE occurrences.review_id = runs.review_id
            AND NOT ${occurrenceIsStale}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM audit_review_findings findings
          WHERE (
              findings.review_id = runs.review_id
              OR findings.first_review_id = runs.review_id
              OR findings.last_review_id = runs.review_id
            )
            AND NOT ${findingIsStale}
        )
    `,
    deleteSql: `
      ${cte}
      DELETE FROM audit_review_runs
      WHERE rowid IN (
        SELECT runs.rowid
        FROM audit_review_runs runs
        WHERE (runs.started_at < @auditCutoff OR runs.finding_count > 0)
          AND NOT EXISTS (
            SELECT 1
            FROM audit_review_finding_occurrences occurrences
            WHERE occurrences.review_id = runs.review_id
              AND NOT ${occurrenceIsStale}
          )
          AND NOT EXISTS (
            SELECT 1
            FROM audit_review_findings findings
            WHERE (
                findings.review_id = runs.review_id
                OR findings.first_review_id = runs.review_id
                OR findings.last_review_id = runs.review_id
              )
              AND NOT ${findingIsStale}
          )
        ORDER BY runs.started_at ASC, runs.review_id ASC
        LIMIT @limit
      )
    `,
    params: { auditCutoff, highRiskCutoff, maxRetries, maxPerAgent },
    batchSize,
    dryRun,
  });
}

function resolveMaybeRelative(baseDir, value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolveRootDir(config) {
  return path.resolve(config.rootDir ?? process.cwd());
}

function isWithinDir(parentDir, childPath) {
  const relative = path.relative(parentDir, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveSpoolDir(config) {
  const spoolDir = config.ingest?.spoolDir;
  if (!spoolDir) return null;
  return resolveMaybeRelative(resolveRootDir(config), spoolDir);
}

function resolveOwnedSubdir(config, relativeDir) {
  const rootDir = resolveRootDir(config);
  const absoluteDir = path.resolve(rootDir, relativeDir);
  return isWithinDir(rootDir, absoluteDir) ? absoluteDir : null;
}

function resolveConfiguredOwnedSubdir(config, configKey, defaultRelativeDir) {
  const configuredValue = config?.[configKey] ?? defaultRelativeDir;
  const rootDir = resolveRootDir(config);
  const absoluteDir = resolveMaybeRelative(rootDir, configuredValue);
  return absoluteDir && isWithinDir(rootDir, absoluteDir) ? absoluteDir : null;
}

function isSafeSpoolAgentDir(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('..')
    && !name.includes('/')
    && !name.includes('\\')
    && /^[A-Za-z0-9._-]+$/.test(name);
}

function isAuditSpoolFile(name) {
  return /^audit-.*\.jsonl$/i.test(name);
}

function cursorByPath(db) {
  const rows = db.prepare(`SELECT agent_id, file_path, file_size_bytes, offset_bytes FROM audit_ingest_cursors`).all();
  const byPath = new Map();
  for (const row of rows) {
    byPath.set(row.file_path, row);
  }
  return byPath;
}

function listSafeExpiredSpoolFiles({ db, config, cutoffMs }) {
  const spoolDir = resolveSpoolDir(config);
  if (!spoolDir || !fs.existsSync(spoolDir)) return [];

  const cursors = cursorByPath(db);
  const files = [];
  for (const dirent of fs.readdirSync(spoolDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !isSafeSpoolAgentDir(dirent.name)) continue;
    const agentDir = path.join(spoolDir, dirent.name);
    for (const fileDirent of fs.readdirSync(agentDir, { withFileTypes: true })) {
      if (!fileDirent.isFile() || !isAuditSpoolFile(fileDirent.name)) continue;
      const filePath = path.join(agentDir, fileDirent.name);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs >= cutoffMs) continue;

      const cursor = cursors.get(filePath);
      const cursorComplete = cursor
        && cursor.file_size_bytes === stat.size
        && cursor.offset_bytes >= stat.size;
      if (cursorComplete) {
        files.push(filePath);
      }
    }
  }
  return files;
}

function configuredSpoolFiles(config) {
  const keep = new Set();
  const spoolDir = resolveSpoolDir(config);
  if (spoolDir && fs.existsSync(spoolDir)) {
    for (const dirent of fs.readdirSync(spoolDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !isSafeSpoolAgentDir(dirent.name)) continue;
      const agentDir = path.join(spoolDir, dirent.name);
      for (const fileDirent of fs.readdirSync(agentDir, { withFileTypes: true })) {
        if (fileDirent.isFile() && isAuditSpoolFile(fileDirent.name)) {
          keep.add(`${dirent.name}|${path.join(agentDir, fileDirent.name)}`);
        }
      }
    }
  }

  return keep;
}

function countOrphanCursors(db, keep, plannedDeletedFiles = new Set()) {
  const rows = db.prepare(`SELECT agent_id, file_path FROM audit_ingest_cursors`).all();
  return rows.filter((row) => plannedDeletedFiles.has(row.file_path) || !keep.has(`${row.agent_id}|${row.file_path}`)).length;
}

function listOwnedFiles(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];

  const files = [];
  const dirs = [rootDir];
  while (dirs.length > 0) {
    const currentDir = dirs.pop();
    for (const dirent of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, dirent.name);
      if (!isWithinDir(rootDir, entryPath) || dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        dirs.push(entryPath);
        continue;
      }
      if (dirent.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function listExpiredOwnedFiles({ config, targetDir, cutoffMs, excludeDir = null }) {
  if (!targetDir) return [];

  return listOwnedFiles(targetDir).filter((filePath) => {
    if (excludeDir && isWithinDir(excludeDir, filePath)) return false;
    return fs.statSync(filePath).mtimeMs < cutoffMs;
  });
}

function pruneEmptyDirectories(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return;

  for (const dirent of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue;
    const childDir = path.join(rootDir, dirent.name);
    if (!isWithinDir(rootDir, childDir)) continue;
    pruneEmptyDirectories(childDir);
    if (fs.readdirSync(childDir).length === 0) {
      fs.rmdirSync(childDir);
    }
  }
}

function runMaintenance(db, vacuum) {
  const maintenance = {
    walCheckpoint: null,
    incrementalVacuum: false,
    errors: [],
  };

  try {
    maintenance.walCheckpoint = db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (error) {
    maintenance.errors.push(`wal_checkpoint: ${error.message}`);
  }

  if (vacuum === 'incremental') {
    try {
      const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }));
      if (autoVacuum === 2) {
        db.pragma('incremental_vacuum');
        maintenance.incrementalVacuum = true;
      }
    } catch (error) {
      maintenance.errors.push(`incremental_vacuum: ${error.message}`);
    }
  }

  return maintenance;
}

export function createRetentionService({ db, config, cursorStore = null, now = () => new Date() } = {}) {
  if (!db) throw new Error('createRetentionService: db is required');
  if (!config) throw new Error('createRetentionService: config is required');

  function auditEventRetentionParams(cfg, nowDate) {
    return {
      auditCutoff: cutoffIso(nowDate, safePositiveNumber(cfg.traceDays, 30)),
      highRiskCutoff: cutoffIso(nowDate, safePositiveNumber(cfg.highRiskTraceDays, 90)),
      maxPerAgent: safePositiveInteger(cfg.maxTracesPerAgent, 2000),
      maxRetries: safePositiveInteger(config.auditReview?.traceReview?.maxInvalidOutputRetries, 2),
    };
  }

  function countFailedTracesPendingCleanup() {
    const params = auditEventRetentionParams(retentionConfig(config), now());
    return countRows(db, `${survivingAuditEventsCte()}
      SELECT COUNT(*) AS count FROM audit_traces t
      JOIN expired_traces x ON x.agent_id = t.agent_id AND x.trace_id = t.trace_id
      WHERE t.review_error = 1 AND t.review_retry_count >= @maxRetries`, params);
  }

  function pruneAuditData({ cfg, nowDate, batchSize, dryRun }) {
    const params = auditEventRetentionParams(cfg, nowDate);
    const options = { ...params, batchSize, dryRun };
    // One transaction preserves the selection until evidence and its parent traces
    // have both been deleted; rollback never leaves partially pruned tasks.
    return db.transaction(() => {
      const findingOccurrences = deleteExpiredFindingOccurrences(db, options);
      const findings = deleteExpiredFindings(db, options);
      const reviewRuns = deleteExpiredReviewRuns(db, options);
      const traceChildren = {};
      for (const [key, table] of [['traceReviews', 'audit_trace_reviews'], ['traceNotifications', 'audit_trace_notifications']]) {
        traceChildren[key] = deleteBatched(db, {
          countSql: `${survivingAuditEventsCte()} SELECT COUNT(*) AS count FROM ${table} WHERE (agent_id, trace_id) IN (SELECT agent_id, trace_id FROM expired_traces)`,
          deleteSql: `${survivingAuditEventsCte()} DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE (agent_id, trace_id) IN (SELECT agent_id, trace_id FROM expired_traces) LIMIT @limit)`,
          params, batchSize, dryRun,
        });
      }
      if (!dryRun) {
        // Mixed legacy findings can reference several traces. Remove only deleted
        // IDs and their snapshots, preserving evidence of the surviving tasks.
        for (const table of ['audit_review_findings', 'audit_review_finding_occurrences']) {
          db.prepare(`${survivingAuditEventsCte()} UPDATE ${table} SET
            evidence_event_ids_json = (SELECT json_group_array(value) FROM json_each(${safeEvidenceArraySql('evidence_event_ids_json')}) WHERE CAST(value AS INTEGER) NOT IN (SELECT id FROM expired_events)),
            evidence_json = CASE WHEN json_valid(evidence_json) AND json_type(evidence_json) = 'array'
              THEN (SELECT json_group_array(json(value)) FROM json_each(evidence_json) WHERE COALESCE(json_extract(value, '$.event_id'), json_extract(value, '$.id'), -1) NOT IN (SELECT id FROM expired_events))
              ELSE evidence_json END
            WHERE EXISTS (SELECT 1 FROM json_each(${safeEvidenceArraySql('evidence_event_ids_json')}) WHERE CAST(value AS INTEGER) IN (SELECT id FROM expired_events))`).run(params);
        }
      }
      const auditEvents = deleteBatched(db, {
        countSql: `${survivingAuditEventsCte()} SELECT COUNT(*) AS count FROM expired_events`,
        deleteSql: `${survivingAuditEventsCte()} DELETE FROM audit_events WHERE id IN (SELECT id FROM expired_events LIMIT @limit)`,
        params, batchSize, dryRun,
      });
      const auditTraces = deleteBatched(db, {
        countSql: `${survivingAuditEventsCte()} SELECT COUNT(*) AS count FROM expired_traces`,
        deleteSql: `${survivingAuditEventsCte()} DELETE FROM audit_traces WHERE (agent_id, trace_id) IN (SELECT agent_id, trace_id FROM expired_traces LIMIT @limit)`,
        params, batchSize, dryRun,
      });
      return {
        cutoff: params.auditCutoff,
        highRiskCutoff: params.highRiskCutoff,
        maxPerAgent: params.maxPerAgent,
        deletions: { auditEvents, auditTraces, ...traceChildren, findingOccurrences, findings, reviewRuns },
      };
    })();
  }

  function pruneAuditEvents({ dryRun = false, batchSize = DEFAULT_BATCH_SIZE } = {}) {
    const cfg = retentionConfig(config);
    const size = safeLimit(batchSize);
    const pruned = pruneAuditData({ cfg, nowDate: now(), batchSize: size, dryRun });
    return {
      dryRun,
      cutoff: pruned.cutoff,
      maxTracesPerAgent: pruned.maxPerAgent,
      deleted: Object.fromEntries(
        Object.entries(pruned.deletions).map(([key, value]) => [key, value.deleted]),
      ),
      batches: Object.fromEntries(
        Object.entries(pruned.deletions).map(([key, value]) => [key, value.batches]),
      ),
    };
  }

  function run({ dryRun = false, batchSize = DEFAULT_BATCH_SIZE } = {}) {
    const cfg = retentionConfig(config);
    const size = safeLimit(batchSize);
    const nowDate = now();
    const auditDataPruned = pruneAuditData({ cfg, nowDate, batchSize: size, dryRun });
    const result = {
      dryRun,
      cutoffs: {
        auditEvents: auditDataPruned.cutoff,
        findingOccurrences: auditDataPruned.cutoff,
        findings: auditDataPruned.cutoff,
        reviewRuns: auditDataPruned.cutoff,
        agentRuns: cutoffIso(nowDate, cfg.runtimeRunsDays),
        agentRunSteps: cutoffIso(nowDate, cfg.runtimeRunsDays),
        agentWaitingStates: cutoffIso(nowDate, cfg.waitingStatesDays),
        auditLlmUsage: cutoffDay(nowDate, cfg.llmUsageDays),
        outboxEvents: cutoffIso(nowDate, cfg.outboxDays),
        logFiles: cutoffIso(nowDate, cfg.logFilesDays),
        tmpFiles: cutoffIso(nowDate, cfg.tmpFilesDays),
        captureFiles: cutoffIso(nowDate, cfg.captureFilesDays),
      },
      deleted: {
        auditEvents: 0,
        findingOccurrences: 0,
        findings: 0,
        agentRuns: 0,
        agentRunSteps: 0,
        agentWaitingStates: 0,
        reviewRuns: 0,
        auditLlmUsage: 0,
        outboxEvents: 0,
        ingestCursors: 0,
        spoolFiles: 0,
        logFiles: 0,
        tmpFiles: 0,
        captureFiles: 0,
      },
      batches: {
        auditEvents: [],
        findingOccurrences: [],
        findings: [],
        agentRuns: [],
        agentRunSteps: [],
        agentWaitingStates: [],
        reviewRuns: [],
        auditLlmUsage: [],
        outboxEvents: [],
      },
      maintenance: null,
    };

    const deletions = {
      ...auditDataPruned.deletions,
      agentRunSteps: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM agent_run_steps steps
          INNER JOIN agent_runs runs ON runs.run_id = steps.run_id
          WHERE runs.status IN (${TERMINAL_RUN_STATUSES_SQL})
            AND COALESCE(runs.updated_at, runs.created_at) < @cutoff
        `,
        deleteSql: `
          DELETE FROM agent_run_steps
          WHERE rowid IN (
            SELECT steps.rowid
            FROM agent_run_steps steps
            INNER JOIN agent_runs runs ON runs.run_id = steps.run_id
            WHERE runs.status IN (${TERMINAL_RUN_STATUSES_SQL})
              AND COALESCE(runs.updated_at, runs.created_at) < @cutoff
            ORDER BY COALESCE(steps.finished_at, steps.started_at) ASC, steps.id ASC
            LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.agentRunSteps },
        batchSize: size,
        dryRun,
      }),
      agentWaitingStates: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM agent_waiting_states states
          WHERE (states.resolved_at IS NOT NULL AND states.resolved_at < @resolvedCutoff)
             OR EXISTS (
               SELECT 1
               FROM agent_runs runs
               WHERE runs.run_id = states.run_id
                 AND runs.status IN (${TERMINAL_RUN_STATUSES_SQL})
                 AND COALESCE(runs.updated_at, runs.created_at) < @runCutoff
             )
        `,
        deleteSql: `
          DELETE FROM agent_waiting_states
          WHERE rowid IN (
            SELECT states.rowid
            FROM agent_waiting_states states
            WHERE (states.resolved_at IS NOT NULL AND states.resolved_at < @resolvedCutoff)
               OR EXISTS (
                 SELECT 1
                 FROM agent_runs runs
                 WHERE runs.run_id = states.run_id
                   AND runs.status IN (${TERMINAL_RUN_STATUSES_SQL})
                   AND COALESCE(runs.updated_at, runs.created_at) < @runCutoff
               )
            ORDER BY COALESCE(states.resolved_at, states.created_at) ASC, states.decision_id ASC
            LIMIT @limit
          )
        `,
        params: {
          resolvedCutoff: result.cutoffs.agentWaitingStates,
          runCutoff: result.cutoffs.agentRuns,
        },
        batchSize: size,
        dryRun,
      }),
      agentRuns: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM agent_runs
          WHERE status IN (${TERMINAL_RUN_STATUSES_SQL})
            AND COALESCE(updated_at, created_at) < @cutoff
        `,
        deleteSql: `
          DELETE FROM agent_runs
          WHERE rowid IN (
            SELECT rowid
            FROM agent_runs
            WHERE status IN (${TERMINAL_RUN_STATUSES_SQL})
              AND COALESCE(updated_at, created_at) < @cutoff
            ORDER BY COALESCE(updated_at, created_at) ASC, run_id ASC
            LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.agentRuns },
        batchSize: size,
        dryRun,
      }),
      auditLlmUsage: deleteBatched(db, {
        countSql: `SELECT COUNT(*) AS count FROM audit_llm_usage WHERE day < @cutoffDay`,
        deleteSql: `
          DELETE FROM audit_llm_usage
          WHERE rowid IN (
            SELECT rowid
            FROM audit_llm_usage
            WHERE day < @cutoffDay
            ORDER BY day ASC
            LIMIT @limit
          )
        `,
        params: { cutoffDay: result.cutoffs.auditLlmUsage },
        batchSize: size,
        dryRun,
      }),
      outboxEvents: deleteBatched(db, {
        countSql: `
          SELECT COUNT(*) AS count
          FROM agent_outbox_events
          WHERE delivery_status IN ('delivered', 'dead_letter') AND created_at < @cutoff
        `,
        deleteSql: `
          DELETE FROM agent_outbox_events
          WHERE rowid IN (
            SELECT rowid
            FROM agent_outbox_events
            WHERE delivery_status IN ('delivered', 'dead_letter') AND created_at < @cutoff
            ORDER BY created_at ASC
            LIMIT @limit
          )
        `,
        params: { cutoff: result.cutoffs.outboxEvents },
        batchSize: size,
        dryRun,
      }),
    };

    for (const [key, value] of Object.entries(deletions)) {
      result.deleted[key] = value.deleted;
      result.batches[key] = value.batches;
    }

    const expiredSpoolFiles = listSafeExpiredSpoolFiles({
      db,
      config,
      cutoffMs: Date.parse(result.cutoffs.auditEvents),
    });
    result.deleted.spoolFiles = expiredSpoolFiles.length;
    if (!dryRun) {
      for (const filePath of expiredSpoolFiles) {
        fs.rmSync(filePath, { force: true });
      }
    }

    const spoolDir = resolveSpoolDir(config);
    for (const target of OWNED_FILE_TARGETS) {
      const targetDir = resolveConfiguredOwnedSubdir(config, target.configKey, target.defaultRelativeDir);
      const expiredFiles = listExpiredOwnedFiles({
        config,
        targetDir,
        cutoffMs: Date.parse(result.cutoffs[target.cutoffKey]),
        excludeDir: spoolDir,
      });
      result.deleted[target.key] = expiredFiles.length;
      if (!dryRun) {
        for (const filePath of expiredFiles) {
          fs.rmSync(filePath, { force: true });
        }
        pruneEmptyDirectories(targetDir);
      }
    }

    if (cursorStore && typeof cursorStore.cleanupOrphans === 'function') {
      const keep = configuredSpoolFiles(config);
      if (dryRun) {
        result.deleted.ingestCursors = countOrphanCursors(db, keep, new Set(expiredSpoolFiles));
      } else {
        result.deleted.ingestCursors = cursorStore.cleanupOrphans({ existingFilePathsByAgent: keep }).removed;
      }
    }

    if (!dryRun) {
      result.maintenance = runMaintenance(db, cfg.vacuum);
    }

    return result;
  }

  return { run, pruneAuditEvents, countFailedTracesPendingCleanup };
}

function nextRunDelayMs(now, runAtHour) {
  const next = new Date(now.getTime());
  next.setHours(runAtHour, 0, 0, 0);
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

export function createRetentionScheduler({
  retentionService,
  config,
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onRun = () => {},
  onError = () => {},
} = {}) {
  if (!retentionService) throw new Error('createRetentionScheduler: retentionService is required');
  if (!config) throw new Error('createRetentionScheduler: config is required');

  const cfg = retentionConfig(config);
  let timer = null;

  function scheduleNext() {
    const delayMs = nextRunDelayMs(now(), cfg.runAtHour);
    timer = setTimeoutFn(() => {
      try {
        onRun(retentionService.run());
      } catch (error) {
        onError(error);
      } finally {
        scheduleNext();
      }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    start() {
      if (timer || cfg.enabled === false) return;
      scheduleNext();
    },

    stop() {
      if (timer) {
        clearTimeoutFn(timer);
        timer = null;
      }
    },

    runNow({ dryRun = false, batchSize } = {}) {
      return retentionService.run({ dryRun, batchSize });
    },
  };
}
