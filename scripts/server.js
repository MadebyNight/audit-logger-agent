// scripts/server.js
import fs from 'fs';
import path from 'path';
import util from 'util';
import { fileURLToPath } from 'url';
import { openDb } from './lib/db.js';
import { ensureRuntimeSchema } from '../src/db/runtimeSchema.js';
import { createRunStore } from '../src/agent/runStore.js';
import { createWaitStore } from '../src/agent/waitStore.js';
import { createOutboxStore } from '../src/agent/outboxStore.js';
import { createPlanner } from '../src/agent/planner.js';
import { createRuntime } from '../src/agent/runtime.js';
import { createToolRegistry } from '../src/tools/registry.js';
import { buildAuditQueryTool } from '../src/tools/auditQueryTool.js';
import { buildReportTool } from '../src/tools/reportTool.js';
import { createCallbackClient } from '../src/adapters/delivery/callbackClient.js';
import { createFeishuBotClient } from '../src/adapters/delivery/feishuBotClient.js';
import { createEventPublisher } from '../src/agent/eventPublisher.js';
import { createRuntimeAuditLogger } from '../src/observability/runtimeAudit.js';
import { createHttpApp } from '../src/adapters/http/app.js';
import { recoverInflightRuns } from '../src/agent/recovery.js';
import { loadAppConfig } from '../src/app/loadConfig.js';
import { ensureRuntimeLayout, migrateLegacyRuntimeArtifacts } from '../src/app/paths.js';
import { loadOpenAIConfig } from '../src/llm/openaiConfig.js';
import { createOpenAIResponsesClient } from '../src/llm/openaiResponsesClient.js';
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
import { createDashboardAuth } from '../src/auditReview/dashboardAuth.js';
import { createApiTokenService } from '../src/auditReview/apiTokenService.js';
import { createAuditReviewScheduler } from '../src/auditReview/scheduler.js';
import { loadFeishuRuntimeConfig } from '../src/auditReview/feishuConfig.js';
import { createNotificationDigestScheduler } from '../src/auditReview/notificationDigestScheduler.js';
import { createRetentionScheduler, createRetentionService } from '../src/auditReview/retention.js';
import { createFindingLifecycleService } from '../src/auditReview/findingLifecycleService.js';
import { createGracefulShutdown, listenHttpServer, resolveServerBindHost } from '../src/adapters/http/serverListen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function isoAtOffset(date, offsetMinutes) {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${new Date(date.getTime() + offsetMinutes * 60 * 1000).toISOString().replace(/Z$/, '')}${offset}`;
}

function installProcessFileLogging(paths) {
  const writeTargets = {
    log: paths.serverLogPath,
    info: paths.serverLogPath,
    warn: paths.serverErrLogPath,
    error: paths.serverErrLogPath,
  };
  const originals = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function append(filePath, args) {
    const line = `${new Date().toISOString()} ${util.format(...args)}\n`;
    try {
      fs.appendFileSync(filePath, line, 'utf-8');
    } catch (error) {
      process.stderr.write(`[audit-logger-agent] failed to write ${filePath}: ${error.message}\n`);
    }
  }

  console.log = (...args) => {
    append(writeTargets.log, args);
    originals.log(...args);
  };
  console.info = (...args) => {
    append(writeTargets.info, args);
    originals.info(...args);
  };
  console.warn = (...args) => {
    append(writeTargets.warn, args);
    originals.warn(...args);
  };
  console.error = (...args) => {
    append(writeTargets.error, args);
    originals.error(...args);
  };
}

const config = loadAppConfig(rootDir);
const paths = ensureRuntimeLayout(config);
const migration = migrateLegacyRuntimeArtifacts(paths);
installProcessFileLogging(paths);
if (migration.moved.length > 0) {
  console.log(`Migrated ${migration.moved.length} legacy runtime artifact(s) to normalized paths.`);
  for (const item of migration.moved) {
    console.log(`  ${path.relative(rootDir, item.from)} -> ${path.relative(rootDir, item.to)}`);
  }
}
if (migration.skipped.length > 0) {
  console.warn(`Skipped ${migration.skipped.length} legacy runtime artifact(s) during migration.`);
  for (const item of migration.skipped) {
    console.warn(`  ${path.relative(rootDir, item.from)} -> ${path.relative(rootDir, item.to)} (${item.error})`);
  }
}

const runtimeConfig = {
  ...config,
  rootDir,
  dbPath: paths.dbPath,
  ingest: {
    ...(config.ingest ?? {}),
    http: { ...(config.ingest?.http ?? {}) },
    spoolDir: paths.spoolDir,
  },
  capturesDir: paths.capturesDir,
  tmpDir: paths.tmpDir,
  logDir: paths.logDir,
  paths,
};
const db = openDb(paths.dbPath);
ensureRuntimeSchema(db);
ensureReviewSchema(db);

const runStore = createRunStore(db);
const waitStore = createWaitStore(db);
const outboxStore = createOutboxStore(db);
const registry = createToolRegistry();
registry.register(buildAuditQueryTool({ db }));
registry.register(buildReportTool({ db }));

const openAIConfig = loadOpenAIConfig({ env: process.env, appConfig: runtimeConfig, projectRoot: rootDir });
const llmClient = createOpenAIResponsesClient({
  apiKey: openAIConfig.apiKey,
  baseURL: openAIConfig.baseURL,
  timeoutMs: openAIConfig.timeoutMs,
  maxConcurrency: openAIConfig.maxConcurrency,
  maxOutputTokens: openAIConfig.maxOutputTokens,
  reasoningEffort: openAIConfig.reasoningEffort,
});

const planner = createPlanner({
  llmClient,
  model: openAIConfig.model,
  registry,
});

const auditLogger = createRuntimeAuditLogger(db);
const reviewAuditLogger = createRuntimeAuditLogger(db, { agentId: 'audit-logger-agent' });
const feishuRuntimeConfig = loadFeishuRuntimeConfig({ env: process.env, appConfig: runtimeConfig });
const feishuBotClient = createFeishuBotClient(feishuRuntimeConfig);

const eventPublisher = createEventPublisher({
  outboxStore,
  callbackClient: createCallbackClient({ fetchImpl: fetch }),
  feishuBotClient,
});

const runtime = createRuntime({
  runStore,
  outboxStore,
  waitStore,
  planner,
  registry,
  eventPublisher,
  auditLogger,
  executor: (task) => setImmediate(task),
});

// P3-04: recover runs orphaned by a process restart before serving traffic.
try {
  const recovered = recoverInflightRuns({ runStore, eventPublisher, auditLogger });
  if (recovered.length > 0) {
    console.log(`Recovered ${recovered.length} orphaned run(s) marked as failed.`);
  }
} catch (error) {
  console.error(`Run recovery failed: ${error.message}`);
}

// v1.4: audit review scheduler — construct all review-system dependencies.
const reviewStore = createReviewStore(db);
const lockStore = createLockStore(db);
const cursorStore = createIngestCursorStore(db);
const ingestService = createAuditIngestService({ db, config: runtimeConfig, cursorStore, now: () => new Date() });
const detector = createCandidateDetector({ db, riskPolicy: runtimeConfig.auditReview?.riskPolicy ?? {} });
const toolSemanticMapper = createToolSemanticMapper({
  db,
  llmClient,
  model: openAIConfig.model,
  taxonomy: runtimeConfig.auditReview?.toolMapping?.taxonomy,
  mappingVersion: runtimeConfig.auditReview?.toolMapping?.version,
});
const llmReviewer = createLlmReviewer({
  llmClient,
  model: openAIConfig.model,
  promptVersion: runtimeConfig.auditReview?.llmReview?.promptVersion,
  reviewerVersion: runtimeConfig.auditReview?.llmReview?.reviewerVersion,
});
const reviewNotifier = createReviewNotifier({
  db,
  outboxStore,
  config: runtimeConfig,
  feishuMode: feishuRuntimeConfig.mode,
});
const reviewVisualization = createVisualization({ db, reviewStore, config: runtimeConfig, llmClient, model: openAIConfig.model });
const findingLifecycleService = createFindingLifecycleService({ reviewStore, now: () => new Date() });
const dashboardAuth = createDashboardAuth({ config: runtimeConfig, env: process.env });
const apiTokenService = createApiTokenService({ db, legacyToken: dashboardAuth.token() });
const scheduler = createAuditReviewScheduler({
  db,
  config: runtimeConfig,
  reviewStore,
  lockStore,
  ingestService,
  cursorStore,
  detector,
  llmReviewer,
  toolSemanticMapper,
  notifier: reviewNotifier,
  visualization: reviewVisualization,
  auditLogger: reviewAuditLogger,
  llmModel: openAIConfig.model,
  now: () => new Date(),
});
const retentionService = createRetentionService({ db, config: runtimeConfig, cursorStore, now: () => new Date() });
const retentionScheduler = createRetentionScheduler({
  retentionService,
  config: runtimeConfig,
  onRun: (result) => {
    console.log(`Retention cleanup completed: ${JSON.stringify(result.deleted)}`);
  },
  onError: (error) => {
    console.error(`Retention cleanup failed: ${error.message}`);
  },
});
const notificationDigestScheduler = createNotificationDigestScheduler({
  db,
  outboxStore,
  config: runtimeConfig,
  feishuMode: feishuRuntimeConfig.mode,
  now: () => new Date(),
  onEnqueued: () => eventPublisher.flushPending(20),
});

// v1.4: validate dashboard auth boot config (throws if non-loopback without token).
const bindHost = resolveServerBindHost(runtimeConfig);
dashboardAuth.validateBoot({ bindHost });

// v1.4: recover stale review runs on startup.
try {
  scheduler.recoverStaleRuns();
} catch (error) {
  console.error(`Review recovery failed: ${error.message}`);
}

// v1.4: start the periodic scheduler if enabled.
if (runtimeConfig.auditReview?.enabled !== false) {
  scheduler.start();
  console.log('Audit review scheduler started.');
}

if (runtimeConfig.retention?.enabled !== false) {
  retentionScheduler.start();
  console.log(`Retention scheduler started for hour ${runtimeConfig.retention?.runAtHour ?? 4}.`);
}

notificationDigestScheduler.start();
if (runtimeConfig.auditReview?.notification?.mode === 'feishu_bot') {
  const loggedAt = new Date();
  const digestHealth = notificationDigestScheduler.getHealthStatus();
  console.log(`Feishu notification digest scheduler: ${JSON.stringify({
    current_time_utc: loggedAt.toISOString(),
    current_time_local: isoAtOffset(loggedAt, digestHealth.timezone_offset_minutes),
    mode: digestHealth.feishu_mode,
    active: digestHealth.active,
    timezone: digestHealth.timezone,
    schedule_hours: digestHealth.schedule_hours,
    catch_up_window_minutes: digestHealth.catch_up_window_minutes,
    next_run_at_utc: digestHealth.next_run_at_utc,
    next_run_at_local: digestHealth.next_run_at_local,
    startup_slot_status: digestHealth.last_slot?.status ?? null,
  })}`);
}

const app = createHttpApp({
  apiTokenService,
  db,
  config: runtimeConfig,
  runStore,
  runtime,
  scheduler,
  reviewStore,
  visualization: reviewVisualization,
  dashboardAuth,
  findingLifecycleService,
  toolSemanticMapper,
  retentionService,
  notificationDigestScheduler,
  flushNotifications: () => eventPublisher.flushPending(20),
});
const portIndex = process.argv.indexOf('--port');
const portArg = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 9320;
const port = Number.isFinite(portArg) ? portArg : 9320;

const flushInterval = setInterval(async () => {
  try {
    await eventPublisher.flushPending(20);
  } catch (error) {
    console.error(error.message);
  }
}, 1000);

const server = listenHttpServer(app, {
  port,
  bindHost,
  onListening: (url) => {
    console.log(`Agent API on ${url}`);
  },
});

const shutdown = createGracefulShutdown({
  scheduler,
  retentionScheduler,
  notificationDigestScheduler,
  flushInterval,
  eventPublisher,
  server,
  db,
  logError: (message) => console.error(message),
});
const handleShutdown = (signal) => {
  void shutdown(signal);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
