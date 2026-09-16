// src/app/loadConfig.js
import fs from 'fs';
import path from 'path';
import { normalizeAppConfig } from './paths.js';

export function loadAppConfig(rootDir, { env = process.env } = {}) {
  const configuredPath = typeof env.AUDIT_AGENT_CONFIG_PATH === 'string'
    ? env.AUDIT_AGENT_CONFIG_PATH.trim()
    : '';
  const configPath = configuredPath && configuredPath.trim() !== ''
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.resolve(rootDir, configuredPath))
    : path.join(rootDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid JSON in config file ${configPath}: ${error.message}`);
  }

  const strictMode = typeof env.AUDIT_INGEST_STRICT_MODE === 'string'
    ? env.AUDIT_INGEST_STRICT_MODE.trim().toLowerCase()
    : '';
  if (strictMode || !config.ingest?.defaultMode) {
    config.ingest = {
      ...(config.ingest ?? {}),
      defaultMode: strictMode === 'strict' ? 'strict' : 'compat',
    };
  }

  const dashboardBaseUrl = typeof env.AUDIT_AGENT_DASHBOARD_BASE_URL === 'string'
    ? env.AUDIT_AGENT_DASHBOARD_BASE_URL.trim()
    : '';
  if (config.auditReview?.http?.requireHttpsBaseUrl === true) {
    let validHttpsUrl = false;
    try {
      const url = new URL(dashboardBaseUrl);
      validHttpsUrl = url.protocol === 'https:' && Boolean(url.hostname);
    } catch {}
    if (!validHttpsUrl) {
      throw new Error('AUDIT_AGENT_DASHBOARD_BASE_URL must be a valid HTTPS URL when auditReview.http.requireHttpsBaseUrl is enabled');
    }
  }
  if (dashboardBaseUrl) {
    config.auditReview = {
      ...(config.auditReview ?? {}),
      visualization: {
        ...(config.auditReview?.visualization ?? {}),
        baseUrl: dashboardBaseUrl,
      },
    };
  }

  return normalizeAppConfig(config, rootDir);
}
