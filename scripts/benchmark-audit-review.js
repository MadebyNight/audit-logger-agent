#!/usr/bin/env node
// Local, repeatable benchmark for the Audit Logger Agent review pipeline.
// It uses real HTTP routes with isolated temporary SQLite/spool storage and a
// deterministic in-process LLM response. It never calls external services.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { ensureReviewSchema } from '../src/db/reviewSchema.js';
import { createReviewStore } from '../src/auditReview/reviewStore.js';
import { createLockStore } from '../src/auditReview/lockStore.js';
import { createIngestCursorStore } from '../src/auditReview/ingestCursorStore.js';
import { createAuditIngestService } from '../src/auditReview/ingestService.js';
import { createCandidateDetector } from '../src/auditReview/candidateDetector.js';
import { createLlmReviewer } from '../src/auditReview/llmReviewer.js';
import { createToolSemanticMapper } from '../src/auditReview/toolSemanticMapper.js';
import { createReviewNotifier } from '../src/auditReview/notification.js';
import { createVisualization } from '../src/auditReview/visualization.js';
import { createAuditReviewScheduler } from '../src/auditReview/scheduler.js';
import { createHttpApp } from '../src/adapters/http/app.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, 'data', 'tmp', 'benchmark');
const DEFAULT_OPTIONS = Object.freeze({
  rounds: 5,
  warmupRounds: 1,
  eventsPerRound: 100,
  outDir: DEFAULT_OUTPUT_DIR,
});

function positiveInteger(value, name, { min = 1, max = 10000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  }
  return parsed;
}

export function usage() {
  return [
    '用法：node scripts/benchmark-audit-review.js [选项]',
    '',
    '选项：',
    '  --rounds <n>    计入结果的轮数，默认 5',
    '  --warmup <n>    不计入结果的预热轮数，默认 1',
    '  --events <n>    每轮混合审计事件数，默认 100，最小 10',
    '  --out-dir <dir> JSON/CSV 输出目录，默认 data/tmp/benchmark',
    '  --help          显示本说明',
  ].join('\n');
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ...DEFAULT_OPTIONS };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true };
    if (!['--rounds', '--warmup', '--events', '--out-dir'].includes(arg)) {
      throw new Error('Unknown option: ' + arg);
    }

    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error('Missing value for ' + arg);
    }
    index++;

    if (arg === '--rounds') {
      options.rounds = positiveInteger(value, '--rounds', { max: 100 });
    } else if (arg === '--warmup') {
      options.warmupRounds = positiveInteger(value, '--warmup', { min: 0, max: 20 });
    } else if (arg === '--events') {
      options.eventsPerRound = positiveInteger(value, '--events', { min: 10, max: 5000 });
    } else if (arg === '--out-dir') {
      options.outDir = path.resolve(process.cwd(), value);
    }
  }

  return options;
}

function rounded(value, precision = 3) {
  return Number(value.toFixed(precision));
}

function nearestRank(values, percentile) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[Math.min(rank - 1, sorted.length - 1)];
}

function metricSummary(values) {
  const samples = values.filter(Number.isFinite);
  if (samples.length === 0) {
    return { sample_count: 0, min: null, mean: null, p50: null, p95: null, max: null };
  }
  const sum = samples.reduce((total, value) => total + value, 0);
  return {
    sample_count: samples.length,
    min: rounded(Math.min(...samples)),
    mean: rounded(sum / samples.length),
    p50: rounded(nearestRank(samples, 50)),
    p95: rounded(nearestRank(samples, 95)),
    max: rounded(Math.max(...samples)),
  };
}

function formatMs(value) {
  return value == null ? 'n/a' : value.toFixed(3) + ' ms';
}

function durationBetween(startedAt, finishedAt) {
  const start = Date.parse(startedAt ?? '');
  const finish = Date.parse(finishedAt ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, finish - start);
}

function normalizeEntity(entity) {
  if (!entity || typeof entity !== 'object') return null;
  if (typeof entity.type !== 'string' || entity.type === '') return null;
  if (typeof entity.id !== 'string' || entity.id === '') return null;
  return { type: entity.type, id: entity.id };
}

function severityForCandidate(candidate) {
  if (candidate.min_severity === 'high' || candidate.category === 'high_risk_permission') return 'high';
  if (candidate.min_severity === 'medium' || candidate.category === 'failed_call' || candidate.category === 'trace_integrity') {
    return 'medium';
  }
  return 'low';
}

function createDeterministicLlmClient() {
  return {
    async createStructuredResponse({ input }) {
      const userMessage = input.find((message) => message.role === 'user');
      if (!userMessage) throw new Error('Benchmark reviewer did not receive a user payload');
      const payload = JSON.parse(userMessage.content);
      const severityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
      const findings = (payload.candidates ?? []).map((candidate) => {
        const severity = severityForCandidate(candidate);
        severityCounts[severity]++;
        return {
          category: candidate.category,
          severity,
          agent_id: candidate.agent_id ?? null,
          tool_name: candidate.tool_name ?? null,
          trace_id: candidate.trace_id ?? null,
          entity: normalizeEntity(candidate.entity),
          title: '基准审计发现：' + candidate.category,
          summary: '检测到 ' + candidate.category + ' 候选项，关联工具 ' + (candidate.tool_name ?? 'unknown') + '。',
          recommendation: '请人工确认关联证据与处置范围。',
          evidence_event_ids: [candidate.event_id],
          requires_action: severity === 'high',
        };
      });

      return {
        type: 'audit_review',
        review_id: payload.review_id,
        window: payload.window,
        summary: {
          title: '基准审查完成，共生成 ' + findings.length + ' 条发现。',
          overview: '使用确定性 Mock LLM 生成结构化审查结果，不发起外部模型调用。',
          severity_counts: severityCounts,
        },
        findings,
      };
    },
  };
}

export function buildBenchmarkWorkload(eventCount, now = new Date()) {
  const scenarioCounts = {
    normal: 0,
    failed_call: 0,
    high_risk_delete: 0,
    slow_call: 0,
    repeated_call: 0,
    trace_integrity: 0,
    high_risk_shell: 0,
    high_risk_update: 0,
  };
  const events = [];

  for (let index = 0; index < eventCount; index++) {
    // Keep every event inside the default 30-minute review window while
    // preserving an ordered time series for repeat-call detection.
    const offsetMs = 1_000 + (eventCount - index) * 20;
    const eventId = String(index + 1).padStart(4, '0');
    const base = {
      ts: new Date(now.getTime() - offsetMs).toISOString(),
      agent_id: 'audit-benchmark-agent',
      trace_id: 'benchmark-trace-' + eventId,
      span_id: 'benchmark-span-' + eventId,
      event: 'tool.end',
      tool_name: 'catalog.lookup',
      status: 'OK',
      result_summary: 'benchmark normal tool call',
      duration_ms: 80,
      channel: 'internal',
      user_id: 'benchmark-user',
      entity: { type: 'record', id: 'record-' + eventId },
    };

    switch (index % 10) {
      case 1:
        scenarioCounts.failed_call++;
        events.push({
          ...base,
          event: 'tool.error',
          tool_name: 'catalog.search',
          status: 'UNAVAILABLE',
          result_summary: 'catalog search failed during benchmark',
          error: { message: 'upstream catalog service unavailable' },
        });
        break;
      case 2:
        scenarioCounts.high_risk_delete++;
        events.push({
          ...base,
          tool_name: 'db.delete',
          result_summary: 'deleted benchmark record',
          entity: { type: 'record', id: 'delete-target-' + eventId },
        });
        break;
      case 3:
        scenarioCounts.slow_call++;
        events.push({
          ...base,
          tool_name: 'report.generate',
          duration_ms: 45_000,
          result_summary: 'slow report generation completed',
        });
        break;
      case 4:
      case 8:
        scenarioCounts.repeated_call++;
        events.push({
          ...base,
          tool_name: 'catalog.lookup',
          trace_id: 'benchmark-repeat-trace-' + eventId,
          entity: { type: 'record', id: 'repeat-target' },
          result_summary: 'repeated lookup completed',
        });
        break;
      case 5:
        scenarioCounts.trace_integrity++;
        events.push({
          ...base,
          event: 'tool.start',
          tool_name: 'pricing.fetch',
          result_summary: 'tool started without a matching completion event',
        });
        break;
      case 6:
        scenarioCounts.high_risk_shell++;
        events.push({
          ...base,
          tool_name: 'shell.execute',
          channel: 'external',
          result_summary: 'executed benchmark maintenance command',
        });
        break;
      case 7:
        scenarioCounts.high_risk_update++;
        events.push({
          ...base,
          tool_name: 'profile.update',
          result_summary: 'updated benchmark profile',
        });
        break;
      default:
        scenarioCounts.normal++;
        events.push(base);
        break;
    }
  }

  return { events, scenarioCounts };
}

function createBenchmarkConfig({ tempDir, dbPath, eventsPerRound }) {
  return {
    rootDir: tempDir,
    dbPath,
    agents: {},
    ingest: {
      http: {
        enabled: true,
        maxBodyBytes: 4 * 1024 * 1024,
        maxLineBytes: 64 * 1024,
      },
      spoolDir: path.join(tempDir, 'incoming'),
    },
    limits: {
      maxLineBytes: 64 * 1024,
      maxChunkBytes: 16 * 1024 * 1024,
      maxQueryLimit: 1_000,
      maxBodyBytes: 4 * 1024 * 1024,
    },
    planner: { model: 'benchmark-mock' },
    auditReview: {
      intervalMinutes: 30,
      lookbackOverlapMinutes: 5,
      maxEventsPerReview: Math.max(eventsPerRound * 4, 100),
      riskPolicy: {
        version: 'benchmark-risk-policy-v1',
        highRiskToolPatterns: ['*delete*', '*update*', 'shell.*'],
        highRiskMappedToolTypes: ['delete', 'update', 'shell'],
        repeatWindowMinutes: 10,
        repeatThreshold: 2,
        slowCallDurationMs: 30_000,
        trustedChannels: ['internal'],
        agentToolAllowlists: {},
      },
      llmReview: {
        promptVersion: 'benchmark-mock-prompt-v1',
        reviewerVersion: 'benchmark-mock-reviewer-v1',
        model: 'benchmark-mock',
        maxCandidatesPerCall: Math.max(eventsPerRound * 4, 100),
      },
      notification: { enabled: false },
      visualization: {
        baseUrl: 'http://127.0.0.1',
        dashboardPath: '/dashboard',
      },
      http: {
        bindHost: '127.0.0.1',
        requireDashboardToken: false,
        allowedOrigins: [],
      },
    },
  };
}

async function listenOnLoopback(server) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Benchmark server did not expose a TCP port');
  return 'http://127.0.0.1:' + address.port;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(response, endpoint) {
  try {
    return await response.json();
  } catch (error) {
    throw new Error(endpoint + ' returned invalid JSON: ' + error.message);
  }
}

async function runRound({ round, eventsPerRound }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-review-benchmark-'));
  const dbPath = path.join(tempDir, 'audit.db');
  let db;
  let app;

  try {
    const benchmarkNow = new Date();
    const config = createBenchmarkConfig({ tempDir, dbPath, eventsPerRound });
    const { events, scenarioCounts } = buildBenchmarkWorkload(eventsPerRound, benchmarkNow);

    db = openDb(dbPath);
    ensureRuntimeSchema(db);
    ensureReviewSchema(db);

    const reviewStore = createReviewStore(db);
    const lockStore = createLockStore(db);
    const cursorStore = createIngestCursorStore(db);
    const ingestService = createAuditIngestService({ db, config, cursorStore });
    const detector = createCandidateDetector({ db, riskPolicy: config.auditReview.riskPolicy });
    const toolSemanticMapper = createToolSemanticMapper({ db });
    const llmReviewer = createLlmReviewer({
      llmClient: createDeterministicLlmClient(),
      model: 'benchmark-mock',
      promptVersion: config.auditReview.llmReview.promptVersion,
      reviewerVersion: config.auditReview.llmReview.reviewerVersion,
    });
    const notifier = createReviewNotifier({
      outboxStore: { enqueue: () => ({ event_id: 'benchmark-notification' }) },
      config,
    });
    const visualization = createVisualization({ reviewStore, config });
    const scheduler = createAuditReviewScheduler({
      db,
      config,
      reviewStore,
      lockStore,
      ingestService,
      cursorStore,
      detector,
      llmReviewer,
      toolSemanticMapper,
      notifier,
      visualization,
      auditLogger: { log: async () => {} },
      now: () => new Date(benchmarkNow.getTime()),
    });
    // The production app schedules a review after ingest. The wrapper omits
    // runAfterIngest so the two measured stages do not overlap.
    app = createHttpApp({
      db,
      config,
      toolSemanticMapper,
    });
    const baseUrl = await listenOnLoopback(app);

    const ingestStarted = performance.now();
    const ingestResponse = await fetch(baseUrl + '/v1/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    const ingestMs = performance.now() - ingestStarted;
    const ingestPayload = await readJson(ingestResponse, 'POST /v1/ingest');
    if (ingestResponse.status !== 202) {
      throw new Error('POST /v1/ingest returned ' + ingestResponse.status + ': ' + JSON.stringify(ingestPayload));
    }
    if (ingestPayload.accepted !== events.length || ingestPayload.rejected !== 0) {
      throw new Error('POST /v1/ingest accepted ' + ingestPayload.accepted + '/' + events.length + ' events');
    }

    const reviewStarted = performance.now();
    const reviewResult = await scheduler.runManual();
    const reviewMs = performance.now() - reviewStarted;
    const reviewRun = reviewStore.getRun(reviewResult.reviewId);
    if (!reviewRun) {
      throw new Error('Manual review did not persist a review run');
    }

    const persistedEventCount = db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count;
    return {
      round,
      event_count: events.length,
      workload_mix: scenarioCounts,
      ingest_ms: rounded(ingestMs),
      ingest_status_code: ingestResponse.status,
      ingest_accepted: ingestPayload.accepted,
      ingest_rejected: ingestPayload.rejected,
      ingest_events_per_second: rounded((events.length * 1000) / ingestMs),
      review_ms: rounded(reviewMs),
      review_id: reviewResult.reviewId,
      review_status: reviewRun.status,
      review_service_ms: durationBetween(reviewRun.started_at, reviewRun.finished_at),
      spool_files_scanned: reviewRun.scanned_files,
      spool_inserted_events: reviewRun.inserted_events,
      candidate_event_count: reviewRun.candidate_event_count,
      finding_count: reviewRun.finding_count,
      persisted_event_count: persistedEventCount,
      total_ms: rounded(ingestMs + reviewMs),
    };
  } finally {
    try {
      await closeServer(app);
    } catch {
      // Continue cleanup when a failed startup has already closed the server.
    }
    try {
      db?.close();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function csvEscape(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

function renderCsv(rounds) {
  const headers = [
    'round',
    'event_count',
    'ingest_ms',
    'ingest_status_code',
    'ingest_accepted',
    'ingest_rejected',
    'ingest_events_per_second',
    'review_ms',
    'review_id',
    'review_status',
    'review_service_ms',
    'spool_files_scanned',
    'spool_inserted_events',
    'candidate_event_count',
    'finding_count',
    'persisted_event_count',
    'total_ms',
  ];
  const lines = rounds.map((round) => headers.map((header) => csvEscape(round[header])).join(','));
  return [headers.join(','), ...lines, ''].join('\n');
}

function outputFileStamp(date) {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').replace('.', '').replace('Z', 'Z');
}

export async function runBenchmark({
  rounds = DEFAULT_OPTIONS.rounds,
  warmupRounds = DEFAULT_OPTIONS.warmupRounds,
  eventsPerRound = DEFAULT_OPTIONS.eventsPerRound,
  outDir = DEFAULT_OPTIONS.outDir,
} = {}) {
  const measuredRounds = positiveInteger(rounds, 'rounds', { max: 100 });
  const warmups = positiveInteger(warmupRounds, 'warmupRounds', { min: 0, max: 20 });
  const events = positiveInteger(eventsPerRound, 'eventsPerRound', { min: 10, max: 5000 });
  const resolvedOutDir = path.resolve(outDir);
  const startedAt = new Date();

  for (let index = 0; index < warmups; index++) {
    await runRound({ round: 'warmup-' + (index + 1), eventsPerRound: events });
  }

  const roundResults = [];
  for (let index = 0; index < measuredRounds; index++) {
    roundResults.push(await runRound({ round: index + 1, eventsPerRound: events }));
  }

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: {
      llm: 'mock',
      external_network: 'disabled',
      notifications: 'disabled',
      execution: 'local_loopback_http',
      storage: 'isolated_temporary_sqlite_and_spool',
    },
    methodology: {
      ingest_endpoint: 'POST /v1/ingest',
      review_execution: 'direct scheduler invocation',
      setup_time_included: false,
      warmup_rounds_excluded_from_metrics: warmups,
      percentile_method: 'nearest-rank',
      note: 'Mock LLM removes provider network and model inference variance. This report measures the local audit pipeline, not an external-model SLA or human audit time.',
    },
    workload: {
      scenario: 'mixed-audit-v1',
      measured_rounds: measuredRounds,
      warmup_rounds: warmups,
      events_per_round: events,
    },
    metrics: {
      ingest_latency_ms: metricSummary(roundResults.map((round) => round.ingest_ms)),
      ingest_throughput_events_per_second: metricSummary(roundResults.map((round) => round.ingest_events_per_second)),
      review_latency_ms: metricSummary(roundResults.map((round) => round.review_ms)),
      review_service_latency_ms: metricSummary(roundResults.map((round) => round.review_service_ms)),
      total_latency_ms: metricSummary(roundResults.map((round) => round.total_ms)),
      candidate_event_count: metricSummary(roundResults.map((round) => round.candidate_event_count)),
      finding_count: metricSummary(roundResults.map((round) => round.finding_count)),
    },
    rounds: roundResults,
  };

  fs.mkdirSync(resolvedOutDir, { recursive: true });
  const stamp = outputFileStamp(startedAt) + '-' + process.pid;
  const jsonPath = path.join(resolvedOutDir, 'audit-review-benchmark-' + stamp + '.json');
  const csvPath = path.join(resolvedOutDir, 'audit-review-benchmark-' + stamp + '.csv');
  report.artifacts = { json: jsonPath, csv: csvPath };
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(csvPath, renderCsv(roundResults), 'utf8');

  return report;
}

export function formatReport(report) {
  const metrics = report.metrics;
  return [
    'Audit Logger Agent 本地基准完成（Mock LLM，无外部网络调用）',
    '工作负载：' + report.workload.measured_rounds + ' 个测量轮次，每轮 ' + report.workload.events_per_round + ' 条事件；预热 ' + report.workload.warmup_rounds + ' 轮。',
    '日志接收：P50 ' + formatMs(metrics.ingest_latency_ms.p50) + '，P95 ' + formatMs(metrics.ingest_latency_ms.p95) + '。',
    '审查链路：P50 ' + formatMs(metrics.review_latency_ms.p50) + '，P95 ' + formatMs(metrics.review_latency_ms.p95) + '。',
    '接收吞吐：P50 ' + (metrics.ingest_throughput_events_per_second.p50 ?? 'n/a') + ' events/s。',
    '候选事件：均值 ' + (metrics.candidate_event_count.mean ?? 'n/a') + '；Finding：均值 ' + (metrics.finding_count.mean ?? 'n/a') + '。',
    'JSON：' + report.artifacts.json,
    'CSV：' + report.artifacts.csv,
  ].join('\n');
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  const report = await runBenchmark(options);
  process.stdout.write(formatReport(report) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write('Benchmark failed: ' + (error.stack ?? error.message) + '\n');
    process.exitCode = 1;
  });
}
