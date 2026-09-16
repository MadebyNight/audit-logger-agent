// src/auditReview/scheduler.js
//
// Audit review orchestration scheduler for v1.4.
// See v1.4 PERIODIC_LLM_AUDIT_REVIEW_DESIGN.md sections 4, 9.5, 12.5, 14.
//
// Responsibilities:
//   - Periodically run a full audit review cycle (ingest -> detect -> LLM -> persist -> notify).
//   - Use a database lease (audit_review_locks) to prevent concurrent runs, even across processes.
//   - Recover stale "running" review runs on startup.
//   - Provide a manual runNow() entry point for the HTTP API.
//   - Emit runtime audit events for every lifecycle step (agent_id='audit-logger-agent').

import crypto from 'crypto';
import { createTraceStore } from './traceStore.js';
import { createTraceAggregator } from './traceAggregator.js';
import { agentDisplayName, buildEvidenceDetail, buildEvidenceIndex, evidenceForEventIds } from './evidence.js';
import { estimateTokensForPayload, llmBudgetFromConfig, usageWouldExceedBudget } from './llmBudget.js';

const LOCK_NAME = 'audit_review_scheduler';
const LEASE_MINUTES = 10;

function nowIso() {
  return new Date().toISOString();
}

function estimateTokensForReview({ reviewId, window, candidates }) {
  return estimateTokensForPayload({ review_id: reviewId, window, candidates: candidates ?? [] });
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function reviewIdFor(now) {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `review_${ts}_${crypto.randomUUID().slice(0, 8)}`;
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

function entityTypeOf(value) {
  return value?.entity?.type ?? value?.entity_type ?? null;
}

function entityIdOf(value) {
  return value?.entity?.id ?? value?.entity_id ?? null;
}

function maxSeverity(...severities) {
  return severities
    .filter(Boolean)
    .reduce((max, severity) =>
      (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[max] ?? 0) ? severity : max,
    'low');
}

function filterEvidenceEventIds(eventIds, evidenceIndex) {
  const seen = new Set();
  const filtered = [];
  for (const id of Array.isArray(eventIds) ? eventIds : []) {
    if (!Number.isInteger(id) || !evidenceIndex.has(id) || seen.has(id)) continue;
    seen.add(id);
    filtered.push(id);
  }
  return filtered;
}

function buildCandidatesByEventId(candidates) {
  const byEventId = new Map();
  for (const candidate of candidates) {
    const bucket = byEventId.get(candidate.event_id) ?? [];
    bucket.push(candidate);
    byEventId.set(candidate.event_id, bucket);
  }
  return byEventId;
}

function ruleCandidateKey(candidate) {
  return [
    candidate.event_id,
    candidate.category ?? '',
    candidate.agent_id ?? '',
    candidate.tool_name ?? '',
    candidate.trace_id ?? '',
    entityTypeOf(candidate) ?? '',
    entityIdOf(candidate) ?? '',
  ].join('|');
}

function ruleCandidatesForEvidenceIds(evidenceIds, candidatesByEventId) {
  return evidenceIds
    .flatMap((id) => candidatesByEventId.get(id) ?? [])
    .filter((candidate) => candidate?.min_severity);
}

function ruleMinimumSeverityForCandidates(candidates) {
  let floor = null;
  for (const candidate of candidates) {
    floor = maxSeverity(floor, candidate.min_severity);
  }
  return floor;
}

function sameNullable(a, b) {
  return (a ?? null) === (b ?? null);
}

function findingMatchesCandidateIdentity(finding, candidate) {
  return candidate.category === finding.category &&
    sameNullable(candidate.agent_id, finding.agent_id) &&
    sameNullable(candidate.tool_name, finding.tool_name) &&
    sameNullable(candidate.trace_id, finding.trace_id) &&
    sameNullable(entityTypeOf(candidate), entityTypeOf(finding)) &&
    sameNullable(entityIdOf(candidate), entityIdOf(finding));
}

/**
 * Find the window_to of the most recent successful (completed|completed_degraded) run.
 * Returns null if none exists.
 */
function lastSuccessfulWindowTo(reviewStore) {
  const runs = reviewStore.listRuns({ limit: 50 });
  for (const run of runs) {
    if (run.status === 'completed' || run.status === 'completed_degraded') {
      return run.window_to;
    }
  }
  return null;
}

/**
 * Build a minimal finding from a candidate (used in degraded mode when LLM fails).
 */
function findingFromCandidate(candidate, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig) {
  const evidence = [buildEvidenceDetail(candidate, agentsConfig)];
  return {
    finding_id: `finding_${crypto.randomUUID()}`,
    review_id: reviewId,
    category: candidate.category,
    severity: maxSeverity('medium', candidate.min_severity),
    agent_id: candidate.agent_id,
    tool_name: candidate.tool_name,
    trace_id: candidate.trace_id,
    entity: entityTypeOf(candidate) || entityIdOf(candidate)
      ? { type: entityTypeOf(candidate), id: entityIdOf(candidate) }
      : null,
    entity_type: entityTypeOf(candidate),
    entity_id: entityIdOf(candidate),
    title: candidate.reason ?? candidate.category,
    summary: candidate.reason ?? candidate.category,
    recommendation: '',
    requires_action: 0,
    evidence_event_ids: [candidate.event_id],
    evidence_event_ids_json: JSON.stringify([candidate.event_id]),
    evidence_json: JSON.stringify(evidence),
    normalized_error_code: null,
    risk_policy_version: riskPolicyVersion,
    prompt_version: promptVersion,
    reviewer_version: reviewerVersion,
  };
}
/**
 * Build a degraded-mode review object from candidates, mirroring the LLM output contract
 * (design 6.7) just enough for the notifier to build a summary payload.
 */
function degradedReview({ reviewId, window, candidates }) {
  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const c of candidates) {
    const sev = maxSeverity('medium', c.min_severity);
    severityCounts[sev] = (severityCounts[sev] || 0) + 1;
  }
  return {
    type: 'audit_review',
    review_id: reviewId,
    window,
    summary: {
      title: 'LLM review unavailable; rule-based findings only',
      overview: `LLM review unavailable; generated rule-based findings from ${candidates.length} candidate event(s).`,
      severity_counts: severityCounts,
    },
    findings: candidates.map((c) => ({
      category: c.category,
      severity: maxSeverity('medium', c.min_severity),
      agent_id: c.agent_id,
      tool_name: c.tool_name,
      trace_id: c.trace_id,
      entity: entityTypeOf(c) || entityIdOf(c)
        ? { type: entityTypeOf(c), id: entityIdOf(c) }
        : null,
      title: c.reason ?? c.category,
      summary: c.reason ?? c.category,
      recommendation: '',
      evidence_event_ids: [c.event_id],
      requires_action: false,
    })),
  };
}

/**
 * Build findings from ingest parse errors (design 5.3).
 */
function parseErrorFindings(parseErrors, reviewId, riskPolicyVersion, reviewerVersion, agentsConfig) {
  if (!parseErrors || parseErrors.length === 0) return [];
  // Group by agent_id
  const byAgent = new Map();
  for (const e of parseErrors) {
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []);
    byAgent.get(e.agent_id).push(e);
  }
  const findings = [];
  for (const [agentId, errors] of byAgent) {
    const uniqueFiles = new Set(errors.map((e) => e.file));
    const severity = uniqueFiles.size >= 3 ? 'high' : 'medium';
    const samples = errors.slice(0, 3).map((e) => `${e.file}:${e.line} ${e.error}`);
    const errorEvidence = errors.slice(0, 3).map((errorRow) => ({
      event_id: null,
      agent_id: agentId,
      agent_name: agentDisplayName(agentId, agentsConfig),
      tool_name: 'audit.ingest',
      trace_id: null,
      span_id: null,
      log_detail: {
        file: errorRow.file,
        line: errorRow.line,
        error: errorRow.error,
      },
    }));
    findings.push({
      finding_id: `finding_${crypto.randomUUID()}`,
      review_id: reviewId,
      category: 'ingest_parse_error',
      severity,
      agent_id: agentId,
      tool_name: 'audit.ingest',
      trace_id: null,
      entity: null,
      entity_type: null,
      entity_id: null,
      title: '日志解析失败',
      summary: `${errors.length} 条解析错误，涉及 ${uniqueFiles.size} 个文件。样例：${samples.join('; ')}`,
      recommendation: '检查日志格式是否符合 agent-audit-log v1.0 规范',
      requires_action: 0,
      evidence_event_ids: [],
      evidence_event_ids_json: '[]',
      evidence_json: JSON.stringify(errorEvidence),
      risk_policy_version: riskPolicyVersion,
      prompt_version: null,
      reviewer_version: reviewerVersion,
    });
  }
  return findings;
}

function withRawJsonSnapshots(reviewStore, findings) {
  const eventIds = [...new Set(findings.flatMap((finding) =>
    Array.isArray(finding.evidence_event_ids) ? finding.evidence_event_ids : []))];
  const rawById = new Map(
    reviewStore.listRawEventsByIds({ eventIds, limit: eventIds.length })
      .map((row) => [row.id, row.raw_json]),
  );
  return findings.map((finding) => {
    let evidence;
    try {
      evidence = JSON.parse(finding.evidence_json ?? '[]');
    } catch {
      evidence = [];
    }
    return {
      ...finding,
      evidence_json: JSON.stringify(evidence.map((item) => ({
        ...item,
        raw_json: item?.event_id == null ? null : (rawById.get(item.event_id) ?? null),
      }))),
    };
  });
}

export function createAuditReviewScheduler({
  db,
  config,
  reviewStore,
  lockStore,
  ingestService,
  cursorStore,
  detector,
  llmReviewer,
  traceAggregator: traceAggregatorOpt,
  toolSemanticMapper,
  notifier,
  visualization,
  auditLogger,
  llmModel: llmModelOpt,
  now = () => new Date(),
  timerApi = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  },
} = {}) {
  if (!db) throw new Error('createAuditReviewScheduler: db is required');
  if (!config) throw new Error('createAuditReviewScheduler: config is required');
  if (!reviewStore) throw new Error('createAuditReviewScheduler: reviewStore is required');
  if (!lockStore) throw new Error('createAuditReviewScheduler: lockStore is required');
  if (!ingestService) throw new Error('createAuditReviewScheduler: ingestService is required');
  if (!detector) throw new Error('createAuditReviewScheduler: detector is required');
  if (!llmReviewer) throw new Error('createAuditReviewScheduler: llmReviewer is required');
  if (!notifier) throw new Error('createAuditReviewScheduler: notifier is required');
  if (!visualization) throw new Error('createAuditReviewScheduler: visualization is required');
  if (!auditLogger) throw new Error('createAuditReviewScheduler: auditLogger is required');
  const traceStore = createTraceStore(db);
  const traceAggregator = traceAggregatorOpt ?? createTraceAggregator({
    db,
    config,
    traceStore,
    llmReviewer,
    lockStore,
    now,
  });

  const auditConfig = config.auditReview ?? {};
  // Evidence helpers expect a config object with an `agents` map at its top
  // level. Resolve the correct slice so agentDisplayName works regardless of
  // whether agents are declared at the root or under auditReview.
  const agentsConfig = config.agents
    ? config
    : (config.auditReview?.agents ? { agents: config.auditReview.agents } : config);
  const intervalMinutes = auditConfig.intervalMinutes ?? 30;
  const initialDelaySeconds = auditConfig.initialDelaySeconds ?? 30;
  const lookbackOverlapMinutes = auditConfig.lookbackOverlapMinutes ?? 5;
  const maxEventsPerReview = auditConfig.maxEventsPerReview ?? 500;
  const riskPolicyVersion = auditConfig.riskPolicy?.version ?? 'risk-policy-v1';
  const promptVersion = auditConfig.llmReview?.promptVersion ?? 'audit-review-prompt-v1';
  const reviewerVersion = auditConfig.llmReview?.reviewerVersion ?? 'audit-reviewer-v1';
  const maxCandidatesPerLlmReview = positiveInteger(auditConfig.llmReview?.maxCandidatesPerCall, 12);
  const llmModel = llmModelOpt ?? config.planner?.model ?? config.auditReview?.llmReview?.model ?? null;
  const llmBudget = llmBudgetFromConfig(config);

  let scheduledTimer = null;
  let refreshTimer = null;
  let started = false;
  let reviewChain = Promise.resolve();
  let ingestDrainPromise = null;
  let ingestReviewStarted = false;
  let ingestFollowupRequested = false;

  function clearRefreshTimer() {
    if (refreshTimer) {
      timerApi.clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function clearScheduledTimer() {
    if (scheduledTimer) {
      timerApi.clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  }

  function scheduleNextScheduledRun(delayMs = intervalMinutes * 60000) {
    clearScheduledTimer();
    if (!started) return;
    scheduledTimer = timerApi.setTimeout(() => {
      scheduledTimer = null;
      enqueueReview('scheduled', { rescheduleAfterReview: true }).catch(() => {});
    }, delayMs);
  }

  function enqueueReview(triggerType, { rescheduleAfterReview = false, onStart } = {}) {
    reviewChain = reviewChain
      .catch(() => {})
      .then(async () => {
        if (rescheduleAfterReview) clearScheduledTimer();
        try {
          onStart?.();
          return await runOnce({ triggerType });
        } finally {
          if (rescheduleAfterReview && started) {
            scheduleNextScheduledRun();
          }
        }
      });
    return reviewChain;
  }

  async function logAudit(event, status, summary, toolName) {
    try {
      await auditLogger.log({
        runId: null,
        event,
        status,
        summary,
        toolName: toolName ?? 'audit.review',
      });
    } catch {
      // Never let audit logging break the review cycle.
    }
  }

  /**
   * Recover stale "running" review runs and expired locks on startup (design 4.4).
   */
  function recoverStaleRuns() {
    const staleBeforeIso = now().toISOString();
    let recoveredCount = 0;
    try {
      const staleRuns = reviewStore.listStaleRunning({ staleBeforeIso });
      for (const run of staleRuns) {
        try {
          reviewStore.finishRun(run.review_id, {
            status: 'failed',
            errorCode: 'review_interrupted',
          });
          recoveredCount++;
        } catch {
          // ignore individual failures
        }
      }
      // Release expired locks.
      const expiredLocks = lockStore.listExpired({ beforeIso: staleBeforeIso });
      for (const lock of expiredLocks) {
        try {
          lockStore.forceRelease(lock.lock_name);
        } catch {
          // ignore
        }
      }
      logAudit(
        'review.recovered',
        'OK',
        `Recovered ${recoveredCount} stale run(s), released ${expiredLocks.length} expired lock(s).`,
        'audit.review.recovery',
      );
    } catch (error) {
      logAudit(
        'review.recovered',
        'INTERNAL',
        `Recovery failed: ${error.message}`,
        'audit.review.recovery',
      );
    }
  }

  /**
   * The core audit review cycle (design section 4, algorithm in task spec).
   * Returns { reviewId, status }.
   */
  async function runOnce({ triggerType = 'scheduled' } = {}) {
    const ownerId = `owner_${crypto.randomUUID()}`;

    // 1. Acquire lease lock.
    const acquired = lockStore.acquire({ lockName: LOCK_NAME, ownerId, leaseMinutes: LEASE_MINUTES });
    if (!acquired.acquired) {
      // Another run holds the lease - record a skipped run and return.
      const reviewId = reviewIdFor(now());
      reviewStore.createRun({
        reviewId,
        windowFrom: nowIso(),
        windowTo: nowIso(),
        triggerType,
        intervalMinutes,
        riskPolicyVersion,
        promptVersion,
        reviewerVersion,
      });
      reviewStore.markRunStatus(reviewId, 'skipped');
      reviewStore.finishRun(reviewId, { status: 'skipped' });
      logAudit(
        'review.lock.skipped',
        'OK',
        `Skipped review ${reviewId}: lock held by ${acquired.currentOwner ?? 'another owner'}.`,
      );
      return { reviewId, status: 'skipped' };
    }

    const reviewId = reviewIdFor(now());
    const windowTo = now().toISOString();

    // 2. Compute window.
    const lastWindowTo = lastSuccessfulWindowTo(reviewStore);
    const windowFrom = lastWindowTo
      ? new Date(Date.parse(lastWindowTo) - lookbackOverlapMinutes * 60000).toISOString()
      : new Date(Date.parse(windowTo) - intervalMinutes * 60000).toISOString();

    // 3. Create the run row.
    reviewStore.createRun({
      reviewId,
      windowFrom,
      windowTo,
      triggerType,
      intervalMinutes,
      riskPolicyVersion,
      promptVersion,
      reviewerVersion,
    });
    logAudit(
      'review.start',
      'OK',
      `Started review ${reviewId} window=${windowFrom}..${windowTo} trigger=${triggerType}`,
    );

    // 4. Lease refresh timer.
    refreshTimer = timerApi.setInterval(() => {
      try {
        lockStore.refresh({ lockName: LOCK_NAME, ownerId, leaseMinutes: LEASE_MINUTES });
      } catch {
        // ignore refresh failures
      }
    }, (LEASE_MINUTES * 60000) / 2);

    let status = 'completed';
    let errorCode = null;
    let findingCount = 0;
    let ingestResult = { inserted: 0, scannedFiles: 0, parseErrors: [], cursorUpdates: 0 };
    let candidates = { candidates: [], totalEvents: 0, trimmed: false };
    let llmResult = { ok: false, degraded: true, error: 'not_run' };

    try {
      // 5. Ingest.
      const sinceDate = windowFrom.slice(0, 10);
      try {
        ingestResult = ingestService.ingestSince({ sinceDate, reviewId });
        logAudit(
          'review.ingest.completed',
          'OK',
          `Ingest: scanned=${ingestResult.scannedFiles}, inserted=${ingestResult.inserted}, parseErrors=${ingestResult.parseErrors.length}`,
          'audit.ingest',
        );
      } catch (err) {
        logAudit(
          'review.ingest.completed',
          'INTERNAL',
          `Ingest failed: ${err.message}`,
          'audit.ingest',
        );
        reviewStore.finishRun(reviewId, {
          status: 'failed',
          scannedFiles: 0,
          insertedEvents: 0,
          parseErrorCount: 0,
          candidateEventCount: 0,
          findingCount: 0,
          errorCode: 'ingest_error',
          errorMessage: err.message,
        });
        logAudit(
          'review.completed',
          'INTERNAL',
          `Review ${reviewId} failed during ingest: ${err.message}`,
        );
        clearRefreshTimer();
        try { lockStore.release({ lockName: LOCK_NAME, ownerId }); } catch {}
        return { reviewId, status: 'failed' };
      }

      // 5a. Aggregate and review sealed traces.
      try {
        const traceResult = await traceAggregator.run();
        logAudit(
          'review.trace_aggregation.completed',
          'OK',
          `Trace aggregation: scanned=${traceResult.scannedEvents}, updated=${traceResult.updatedTraces}, reviewed=${traceResult.reviewedTraces}.`,
          'audit.trace',
        );
      } catch (err) {
        logAudit(
          'review.trace_aggregation.completed',
          'INTERNAL',
          `Trace aggregation failed: ${err.message}`,
          'audit.trace',
        );
      }

      // 6. Detect candidates.
      try {
        if (toolSemanticMapper) {
          await toolSemanticMapper.mapPendingEvents({
            from: windowFrom,
            to: windowTo,
            limit: maxEventsPerReview,
          });
        }
        candidates = detector.detect({ windowFrom, windowTo, maxEventsPerReview });
        logAudit(
          'review.detector.completed',
          'OK',
          `Detector: ${candidates.candidates.length} candidates from ${candidates.totalEvents} events.`,
          'audit.detector',
        );
      } catch (err) {
        logAudit(
          'review.detector.completed',
          'INTERNAL',
          `Detector failed: ${err.message}`,
          'audit.detector',
        );
        candidates = { candidates: [], totalEvents: 0, trimmed: false };
      }

      // 6a. Build a structured evidence index keyed by event_id for LLM findings.
      const evidenceIndex = buildEvidenceIndex(candidates.candidates, agentsConfig);
      const candidatesByEventId = buildCandidatesByEventId(candidates.candidates);

      // 6b. Persist parse-error findings.
      const parseFindings = parseErrorFindings(
        ingestResult.parseErrors,
        reviewId,
        riskPolicyVersion,
        reviewerVersion,
        agentsConfig,
      );

      // 7. LLM review.
      const llmCandidates = candidates.candidates.slice(0, maxCandidatesPerLlmReview);
      const llmDay = windowTo.slice(0, 10);
      const estimatedTokens = estimateTokensForReview({
        reviewId,
        window: { from: windowFrom, to: windowTo },
        candidates: llmCandidates,
      });
      const llmUsage = reviewStore.getLlmUsage?.(llmDay) ?? { day: llmDay, calls: 0, est_tokens: 0 };
      if (usageWouldExceedBudget(llmUsage, llmBudget, estimatedTokens)) {
        llmResult = { ok: false, degraded: true, error: 'llm_budget_exceeded' };
        logAudit(
          'review.llm.budget_exceeded',
          'INTERNAL',
          `Skipped LLM review: usage calls=${llmUsage.calls}/${llmBudget.maxCallsPerDay}, est_tokens=${llmUsage.est_tokens}/${llmBudget.maxTokensPerDay}, next_est_tokens=${estimatedTokens}.`,
          'audit.llm',
        );
      } else {
        try {
          llmResult = await llmReviewer.review({
            reviewId,
            window: { from: windowFrom, to: windowTo },
            candidates: llmCandidates,
            reviewStore,
          });
          reviewStore.recordLlmUsage?.({ day: llmDay, calls: 1, estTokens: estimatedTokens });
          logAudit(
            'review.llm.completed',
            llmResult.ok ? 'OK' : 'INTERNAL',
            llmResult.ok
              ? `LLM review ok, model=${llmModel}, prompt=${promptVersion}`
              : `LLM review degraded: ${llmResult.error ?? 'unknown error'}`,
            'audit.llm',
          );
        } catch (err) {
          reviewStore.recordLlmUsage?.({ day: llmDay, calls: 1, estTokens: estimatedTokens });
          llmResult = { ok: false, degraded: true, error: err.message };
          logAudit(
            'review.llm.completed',
            'INTERNAL',
            `LLM review threw: ${err.message}`,
            'audit.llm',
          );
        }
      }

      if (!llmResult.ok) {
        status = 'completed_degraded';
        errorCode = llmResult.error === 'llm_budget_exceeded' ? 'llm_budget_exceeded' : 'llm_error';
      }

      // 8. Persist findings.
      let findingsToPersist = [];
      if (llmResult.ok && llmResult.review && Array.isArray(llmResult.review.findings)) {
        const coveredRuleCandidateKeys = new Set();
        findingsToPersist = llmResult.review.findings.flatMap((f) => {
          const evidenceIds = filterEvidenceEventIds(f.evidence_event_ids, evidenceIndex);
          const evidence = evidenceForEventIds(evidenceIds, evidenceIndex);
          const ruleCandidates = ruleCandidatesForEvidenceIds(evidenceIds, candidatesByEventId);
          const matchedRuleCandidates = ruleCandidates.filter((candidate) =>
            findingMatchesCandidateIdentity(f, candidate));
          const minSeverity = ruleMinimumSeverityForCandidates(matchedRuleCandidates);
          for (const candidate of matchedRuleCandidates) {
            coveredRuleCandidateKeys.add(ruleCandidateKey(candidate));
          }
          if (
            f.category === 'high_risk_permission' &&
            (evidenceIds.length === 0 || (ruleCandidates.length > 0 && matchedRuleCandidates.length === 0))
          ) {
            return [];
          }
          return [{
            finding_id: `finding_${crypto.randomUUID()}`,
            review_id: reviewId,
            category: f.category,
            severity: maxSeverity(f.severity, minSeverity),
            agent_id: f.agent_id,
            tool_name: f.tool_name,
            trace_id: f.trace_id,
            entity: f.entity ?? null,
            entity_type: f.entity?.type ?? null,
            entity_id: f.entity?.id ?? null,
            title: f.title,
            summary: f.summary,
            recommendation: f.recommendation,
            requires_action: f.requires_action ? 1 : 0,
            evidence_event_ids: evidenceIds,
            evidence_event_ids_json: JSON.stringify(evidenceIds),
            evidence_json: JSON.stringify(evidence),
            normalized_error_code: null,
            risk_policy_version: riskPolicyVersion,
            prompt_version: promptVersion,
            reviewer_version: reviewerVersion,
          }];
        });
        const uncoveredRuleFindings = candidates.candidates
          .filter((c) => c.min_severity && !coveredRuleCandidateKeys.has(ruleCandidateKey(c)))
          .map((c) => findingFromCandidate(c, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig));
        findingsToPersist.push(...uncoveredRuleFindings);
      } else {
        // Degraded mode: convert each candidate to a basic finding.
        findingsToPersist = candidates.candidates.map((c) =>
          findingFromCandidate(c, reviewId, riskPolicyVersion, promptVersion, reviewerVersion, agentsConfig),
        );
      }

      findingsToPersist.push(...parseFindings);
      findingsToPersist = withRawJsonSnapshots(reviewStore, findingsToPersist);
      const persistedResult = reviewStore.persistReviewResult(reviewId, {
        findings: findingsToPersist,
        observedAt: windowTo,
        status,
        scannedFiles: ingestResult.scannedFiles,
        insertedEvents: ingestResult.inserted,
        parseErrorCount: ingestResult.parseErrors.length,
        candidateEventCount: candidates.candidates.length,
        llmModel,
        errorCode,
      });
      findingCount = persistedResult.findingCount;

      // 9. Notify.
      try {
        const dashboardUrl = visualization.dashboardUrlFor(reviewId);
        const run = reviewStore.getRun(reviewId);
        // persistReviewResult returns every finding/occurrence pair committed
        // for this batch. Using that authoritative result avoids arbitrary
        // list limits and preserves re-observed findings whose first review_id
        // belongs to an earlier batch.
        const persistedEntries = Array.isArray(persistedResult.findings)
          ? persistedResult.findings
          : [];
        const matchPersisted = (f) => persistedEntries.find(({ finding }) =>
          finding?.category === f.category &&
          (finding?.agent_id ?? null) === (f.agent_id ?? null) &&
          (finding?.tool_name ?? null) === (f.tool_name ?? null) &&
          (finding?.trace_id ?? null) === (f.trace_id ?? null) &&
          (finding?.entity_type ?? null) === entityTypeOf(f) &&
          (finding?.entity_id ?? null) === entityIdOf(f));
        const baseReview = llmResult.ok
          ? llmResult.review
          : degradedReview({ reviewId, window: { from: windowFrom, to: windowTo }, candidates: candidates.candidates });
        const reviewForNotify = {
          ...baseReview,
          findings: (baseReview.findings || []).map((f) => {
            if (f.finding_id) return f;
            const persisted = matchPersisted(f)?.finding;
            return persisted ? { ...f, finding_id: persisted.finding_id } : f;
          }),
        };
        notifier.enqueue({ reviewId, run, review: reviewForNotify, dashboardUrl });

        // Enqueue high/critical findings. Feishu delivery groups them by the
        // non-crossable (agent_id, trace_id) boundary; callback delivery keeps
        // the legacy individual payload behavior.
        const persistedFindings = persistedEntries
          .map(({ finding, occurrence }) => {
            if (!finding || !occurrence) return null;
            return {
              ...finding,
              severity: occurrence.severity,
              title: occurrence.title,
              summary: occurrence.summary,
              recommendation: occurrence.recommendation,
              evidence: occurrence.evidence,
              observed_at: occurrence.observed_at,
            };
          })
          .filter((finding) => finding?.severity === 'high' || finding?.severity === 'critical');
        if (typeof notifier.enqueueHighRiskGroups === 'function') {
          notifier.enqueueHighRiskGroups({ findings: persistedFindings, reviewId, run, dashboardUrl });
        } else {
          for (const pf of persistedFindings) {
            notifier.enqueueFinding({ finding: pf, reviewId, run, dashboardUrl });
          }
        }
        logAudit(
          'review.notification.enqueued',
          'OK',
          `Notifications enqueued for review ${reviewId}.`,
          'audit.notify',
        );
      } catch (err) {
        logAudit(
          'review.notification.enqueued',
          'INTERNAL',
          `Notification enqueue failed: ${err.message}`,
          'audit.notify',
        );
      }

      // 10. The run was completed atomically with findings and occurrences.
      logAudit(
        'review.completed',
        status === 'completed' ? 'OK' : 'INTERNAL',
        `Review ${reviewId} finished with status=${status}, findings=${findingCount}.`,
      );
      return { reviewId, status };
    } catch (err) {
      // Any uncaught error: mark failed, release lock.
      status = 'failed';
      errorCode = err.code ?? 'internal_error';
      try {
        reviewStore.finishRun(reviewId, {
          status: 'failed',
          scannedFiles: ingestResult.scannedFiles,
          insertedEvents: ingestResult.inserted,
          parseErrorCount: ingestResult.parseErrors.length,
          candidateEventCount: candidates.candidates.length,
          findingCount,
          llmModel,
          errorCode,
          errorMessage: err.message,
        });
      } catch {
        // best effort
      }
      logAudit(
        'review.completed',
        'INTERNAL',
        `Review ${reviewId} failed unexpectedly: ${err.message}`,
      );
      return { reviewId, status: 'failed' };
    } finally {
      clearRefreshTimer();
      try {
        lockStore.release({ lockName: LOCK_NAME, ownerId });
      } catch {
        // best effort
      }
    }
  }

  function start() {
    if (started) return;
    started = true;
    const delayMs = initialDelaySeconds * 1000;
    scheduleNextScheduledRun(delayMs);
  }

  function runAfterIngest() {
    if (ingestDrainPromise) {
      // Batches arriving before their coalesced review starts are already covered.
      // While it runs, retain only one trailing review for newly accepted events.
      if (ingestReviewStarted) ingestFollowupRequested = true;
      return ingestDrainPromise;
    }

    ingestDrainPromise = (async () => {
      let result;
      do {
        ingestFollowupRequested = false;
        ingestReviewStarted = false;
        result = await enqueueReview('ingest', {
          rescheduleAfterReview: true,
          onStart: () => { ingestReviewStarted = true; },
        });
      } while (ingestFollowupRequested);
      return result;
    })().finally(() => {
      ingestDrainPromise = null;
      ingestReviewStarted = false;
      ingestFollowupRequested = false;
    });

    return ingestDrainPromise;
  }

  function runManual() {
    return enqueueReview('manual');
  }

  function stop() {
    started = false;
    clearRefreshTimer();
    clearScheduledTimer();
  }

  return {
    start,
    stop,
    runOnce,
    runManual,
    runAfterIngest,
    recoverStaleRuns,
  };
}
