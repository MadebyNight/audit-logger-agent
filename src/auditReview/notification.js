// src/auditReview/notification.js
// Build generic audit review delivery payloads and enqueue them into the outbox.
// Payload types `audit_review_summary` / `audit_review_finding` are generic
// delivery payloads: they are platform-agnostic and rely on the outbox flush
// mechanism to deliver them to whatever callback receiver is configured.

import crypto from 'crypto';
import { buildTraceAlertPayload } from './feishuCards.js';
import { agentDisplayName } from './evidence.js';

const SEVERITY_ORDER = ['low', 'medium', 'high', 'critical'];

function severityRank(severity) {
  const idx = SEVERITY_ORDER.indexOf(severity);
  return idx === -1 ? 0 : idx;
}

export function meetsMinSeverity(severity, min) {
  return severityRank(severity) >= severityRank(min);
}

function defaultNotificationConfig(config) {
  return config?.auditReview?.notification ?? {};
}

function pickTopFindings(findings, limit = 5) {
  if (!Array.isArray(findings)) return [];
  return [...findings]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, limit)
    .map((f) => ({
      finding_id: f.finding_id ?? f.id,
      severity: f.severity,
      category: f.category,
      title: f.title,
      agent_id: f.agent_id,
      agent_name: f.agent_name ?? f.evidence?.[0]?.agent_name ?? f.agent_id,
      tool_name: f.tool_name,
      summary: f.summary,
    }));
}

export function buildSummaryPayload({ reviewId, run, review, dashboardUrl }) {
  const severityCounts = review?.summary?.severity_counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const totalFindings = (severityCounts.critical || 0) + (severityCounts.high || 0) +
    (severityCounts.medium || 0) + (severityCounts.low || 0);
  const title = review?.summary?.title ?? `审计审查发现 ${totalFindings} 个问题`;
  const overview = review?.summary?.overview ?? `审查 ${run?.candidate_event_count ?? 0} 条事件，发现 ${totalFindings} 个风险。`;
  const windowFrom = run?.window_from ?? review?.window?.from;
  const windowTo = run?.window_to ?? review?.window?.to;

  return {
    type: 'audit_review_summary',
    review_id: reviewId,
    title,
    summary: overview,
    dashboard_url: dashboardUrl,
    window: { from: windowFrom, to: windowTo },
    severity_counts: severityCounts,
    top_findings: pickTopFindings(review?.findings, 5),
    actions: [
      { id: 'open_dashboard', label: '打开 Dashboard', url: dashboardUrl },
    ],
  };
}

export function buildFindingPayload({ finding, reviewId, run, dashboardUrl }) {
  const windowFrom = run?.window_from;
  const windowTo = run?.window_to;
  return {
    type: 'audit_review_finding',
    review_id: reviewId,
    finding_id: finding.finding_id ?? finding.id,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    summary: finding.summary,
    recommendation: finding.recommendation,
    agent_id: finding.agent_id,
    agent_name: finding.agent_name ?? finding.evidence?.[0]?.agent_name ?? finding.agent_id,
    tool_name: finding.tool_name,
    trace_id: finding.trace_id,
    entity: finding.entity ?? (
      finding.entity_type || finding.entity_id
        ? { type: finding.entity_type ?? null, id: finding.entity_id ?? null }
        : null
    ),
    evidence: Array.isArray(finding.evidence) ? finding.evidence.slice(0, 5) : [],
    dashboard_url: dashboardUrl,
    window: { from: windowFrom, to: windowTo },
    actions: [
      { id: 'open_dashboard', label: '打开 Dashboard', url: dashboardUrl },
    ],
  };
}

function dedupeIdentity(prefix, values) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 24);
  return `${prefix}:${digest}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function highRiskGroupDedupeKey({ group }) {
  return dedupeIdentity('feishu_trace_alert', [group.agentId, group.traceId]);
}

export function createReviewNotifier({ db, outboxStore, config, feishuMode = 'disabled' }) {
  const notifyConfig = defaultNotificationConfig(config);
  const notificationsEnabled = notifyConfig.enabled !== false;
  const sendEmptyReview = notifyConfig.sendEmptyReview ?? false;
  const callbackUrl = notifyConfig.callbackUrl;
  const deliveryMode = notifyConfig.mode ?? 'callback';
  const maxAttempts = notifyConfig.maxAttempts;
  const cardConfig = notifyConfig.card ?? {};
  const agentsConfig = config?.agents
    ? config
    : (config?.auditReview?.agents ? { agents: config.auditReview.agents } : config);

  function enqueue({ reviewId, run, review, dashboardUrl }) {
    if (!notificationsEnabled) {
      return { enqueued: false, reason: 'disabled' };
    }
    const findings = review?.findings ?? [];
    if (findings.length === 0 && !sendEmptyReview) {
      return { enqueued: false, reason: 'empty' };
    }
    if (deliveryMode === 'feishu_bot') {
      return { enqueued: false, reason: 'feishu_high_risk_group_only' };
    }

    const payload = buildSummaryPayload({ reviewId, run, review, dashboardUrl });
    outboxStore.enqueue({
      runId: reviewId,
      type: 'audit_review_summary',
      payload,
      deliveryMode,
      callbackUrl,
      maxAttempts,
    });
    return { enqueued: true, payload };
  }

  function enqueueFinding() {
    return { enqueued: false, reason: notificationsEnabled ? 'trace_conclusion_required' : 'disabled' };
  }

  function enqueueHighRiskGroups() {
    return { ...enqueueFinding(), groups: [] };
  }

  function enqueueTrace({ trace, dashboardUrl }) {
    if (!notificationsEnabled || deliveryMode !== 'feishu_bot' || feishuMode === 'disabled') {
      return { enqueued: false, reason: 'disabled' };
    }
    if (!trace?.sealed_at || !(trace.review_version > 0)) {
      return { enqueued: false, reason: 'unreviewed' };
    }
    if (trace.risk_level !== 'high') return { enqueued: false, reason: 'below_high' };
    if (!nonEmptyString(trace.agent_id) || !nonEmptyString(trace.trace_id)) {
      return { enqueued: false, reason: 'missing_identity' };
    }
    const payload = buildTraceAlertPayload({
      trace,
      agentName: agentDisplayName(trace.agent_id, agentsConfig),
      dashboardUrl,
      maxPayloadBytes: cardConfig.maxPayloadBytes,
    });
    if (feishuMode === 'dry-run') return { enqueued: false, reason: 'dry_run', payload };
    if (!db) throw new Error('enqueueTrace requires the outbox SQLite connection');
    const dedupeKey = highRiskGroupDedupeKey({ group: { agentId: trace.agent_id, traceId: trace.trace_id } });
    // The receipt outlives outbox retention. A failed enqueue rolls it back,
    // while retries/dead letters continue to use the original outbox record.
    return db.transaction(() => {
      const receipt = db.prepare(`
        INSERT OR IGNORE INTO audit_trace_notifications (agent_id, trace_id, enqueued_at)
        VALUES (?, ?, ?)
      `).run(trace.agent_id, trace.trace_id, new Date().toISOString());
      if (!receipt.changes) return { enqueued: false, reason: 'duplicate' };
      const result = outboxStore.enqueue({
        runId: dedupeKey,
        type: 'audit_trace_high_risk',
        payload,
        deliveryMode: 'feishu_bot',
        callbackUrl: null,
        maxAttempts,
        dedupeKey,
      });
      return { ...result, enqueued: result?.enqueued !== false, payload };
    }).immediate();
  }

  return {
    enqueue,
    enqueueFinding,
    enqueueHighRiskGroups,
    enqueueTrace,
    buildSummaryPayload,
    buildFindingPayload,
    meetsMinSeverity,
  };
}

export { SEVERITY_ORDER };
