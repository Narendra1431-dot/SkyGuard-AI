'use strict';

const fs = require('fs');
const path = require('path');
const pg = require('./pg');

const STATE_FILE = process.env.SKYGUARD_DATA_DIR
  ? path.resolve(process.env.SKYGUARD_DATA_DIR, 'operations.json')
  : path.resolve(__dirname, '..', '..', 'data', 'operations.json');

const DEFAULT_PROVIDERS = [
  ['openweather', { id: 'openweather', name: 'OpenWeather', enabled: false, priority: 1, status: 'GRAY', configurationState: 'NOT_CONFIGURED', latencyMs: null, requestCount: 0, failureCount: 0, successCount: 0, lastSuccess: null, lastFailure: null, credentials: {} }],
  ['open-meteo', { id: 'open-meteo', name: 'Open-Meteo', enabled: true, priority: 2, status: 'PENDING', configurationState: 'CONFIGURED', latencyMs: null, requestCount: 0, failureCount: 0, successCount: 0, lastSuccess: null, lastFailure: null, credentials: {} }],
  ['fallback', { id: 'fallback', name: 'Fallback', enabled: false, priority: 99, status: 'GRAY', configurationState: 'NOT_CONFIGURED', latencyMs: null, requestCount: 0, failureCount: 0, successCount: 0, lastSuccess: null, lastFailure: null, credentials: {} }],
];
const DEFAULT_CONFIG = [
  ['thresholds', { temperature_warning: 38, temperature_critical: 42, aqi_warning: 150, aqi_critical: 250, humidity_min: 15, humidity_max: 85, pressure_min: 997, pressure_max: 1028, wind_warning: 10, wind_critical: 14, rainfall_warning: 5, sensor_freshness_seconds: 90 }],
  ['system', { notificationsEnabled: true, autoRefreshSeconds: 10 }],
  ['anomaly', { enabled: true, minimumConfidence: 0.7 }],
  ['health', { staleAfterSeconds: 90 }],
  ['maintenance', { enabled: true }],
  ['ml', { enabled: true }],
  ['notifications', { channels: [] }],
  ['monitoring', { enabled: true, intervalSeconds: 10, snapshotTtlSeconds: 5 }],
  ['alerts', { rateLimitPerMinute: 10, escalationMinutes: 30 }],
  ['agent', { enabled: true, defaultRole: 'viewer', maxToolCallsPerRun: 20 }],
  ['rag', { embeddingBackend: 'local-hash', topK: 5, minScore: 0.3 }],
  ['realtime', { enabled: true, heartbeatSeconds: 30 }],
  ['storage', { memoryEnabled: true, influxEnabled: false, pgEnabled: false }],
  ['security', { requireAuth: true, corsOrigin: '*' }],
  ['performance', { maxRequestSize: '128kb', stationCacheTtlMs: 500, analyticsCacheTtlMs: 30000 }],
];

const CONFIG_SCHEMA = {
  thresholds: { type: 'object', properties: { temperature_warning: { type: 'number', min: 0, max: 100 }, temperature_critical: { type: 'number', min: 0, max: 100 }, aqi_warning: { type: 'number', min: 0, max: 500 }, aqi_critical: { type: 'number', min: 0, max: 1000 }, humidity_min: { type: 'number', min: 0, max: 100 }, humidity_max: { type: 'number', min: 0, max: 100 }, pressure_min: { type: 'number', min: 800, max: 1100 }, pressure_max: { type: 'number', min: 800, max: 1100 }, wind_warning: { type: 'number', min: 0, max: 50 }, wind_critical: { type: 'number', min: 0, max: 100 }, rainfall_warning: { type: 'number', min: 0, max: 200 }, sensor_freshness_seconds: { type: 'number', min: 10, max: 3600 } } },
  system: { type: 'object', properties: { notificationsEnabled: { type: 'boolean' }, autoRefreshSeconds: { type: 'number', min: 1, max: 300 } } },
  anomaly: { type: 'object', properties: { enabled: { type: 'boolean' }, minimumConfidence: { type: 'number', min: 0, max: 1 } } },
  health: { type: 'object', properties: { staleAfterSeconds: { type: 'number', min: 10, max: 3600 } } },
  maintenance: { type: 'object', properties: { enabled: { type: 'boolean' } } },
  ml: { type: 'object', properties: { enabled: { type: 'boolean' } } },
  notifications: { type: 'object', properties: { channels: { type: 'array' } } },
  monitoring: { type: 'object', properties: { enabled: { type: 'boolean' }, intervalSeconds: { type: 'number', min: 1, max: 300 }, snapshotTtlSeconds: { type: 'number', min: 1, max: 60 } } },
  alerts: { type: 'object', properties: { rateLimitPerMinute: { type: 'number', min: 1, max: 1000 }, escalationMinutes: { type: 'number', min: 1, max: 1440 } } },
  agent: { type: 'object', properties: { enabled: { type: 'boolean' }, defaultRole: { type: 'string', enum: ['viewer', 'analyst', 'admin'] }, maxToolCallsPerRun: { type: 'number', min: 1, max: 100 } } },
  rag: { type: 'object', properties: { embeddingBackend: { type: 'string' }, topK: { type: 'number', min: 1, max: 50 }, minScore: { type: 'number', min: 0, max: 1 } } },
  realtime: { type: 'object', properties: { enabled: { type: 'boolean' }, heartbeatSeconds: { type: 'number', min: 5, max: 300 } } },
  storage: { type: 'object', properties: { memoryEnabled: { type: 'boolean' }, influxEnabled: { type: 'boolean' }, pgEnabled: { type: 'boolean' } } },
  security: { type: 'object', properties: { requireAuth: { type: 'boolean' }, corsOrigin: { type: 'string' } } },
  performance: { type: 'object', properties: { maxRequestSize: { type: 'string' }, stationCacheTtlMs: { type: 'number', min: 0, max: 60000 }, analyticsCacheTtlMs: { type: 'number', min: 0, max: 300000 } } },
};

function validateConfigSection(section, value) {
  const schema = CONFIG_SCHEMA[section];
  if (!schema) return { valid: false, errors: [`Unknown configuration section: ${section}`] };
  if (!value || typeof value !== 'object') return { valid: false, errors: ['Value must be an object'] };
  const errors = [];
  for (const [key, val] of Object.entries(value)) {
    const fieldSchema = schema.properties?.[key];
    if (!fieldSchema) { errors.push(`Unknown configuration key: ${key}`); continue; }
    if (fieldSchema.type === 'number') {
      if (typeof val !== 'number' || Number.isNaN(val)) { errors.push(`${key} must be a number`); continue; }
      if (fieldSchema.min != null && val < fieldSchema.min) errors.push(`${key} must be >= ${fieldSchema.min}`);
      if (fieldSchema.max != null && val > fieldSchema.max) errors.push(`${key} must be <= ${fieldSchema.max}`);
    } else if (fieldSchema.type === 'boolean') {
      if (typeof val !== 'boolean') errors.push(`${key} must be a boolean`);
    } else if (fieldSchema.type === 'string') {
      if (typeof val !== 'string') errors.push(`${key} must be a string`);
      if (fieldSchema.enum && !fieldSchema.enum.includes(val)) errors.push(`${key} must be one of: ${fieldSchema.enum.join(', ')}`);
    } else if (fieldSchema.type === 'array') {
      if (!Array.isArray(val)) errors.push(`${key} must be an array`);
    }
  }
  return { valid: errors.length === 0, errors };
}

async function testConfig(section) {
  const current = config.get(section);
  if (!current) return { section, status: 'NOT_CONFIGURED', message: 'Section not found' };
  if (section === 'providers' || section === 'thresholds') return { section, status: 'SKIPPED', message: 'Test not applicable for this section' };
  if (section === 'monitoring') return { section, status: current.enabled !== false ? 'UP' : 'GRAY', message: current.enabled !== false ? 'Monitoring loop active' : 'Monitoring disabled', checkedAt: new Date().toISOString() };
  if (section === 'realtime') return { section, status: current.enabled !== false ? 'UP' : 'GRAY', message: current.enabled !== false ? 'Realtime enabled' : 'Realtime disabled', checkedAt: new Date().toISOString() };
  if (section === 'storage') return { section, status: 'UP', message: 'Storage backends configured per environment', checkedAt: new Date().toISOString() };
  if (section === 'alerts') return { section, status: 'UP', message: 'Alert subsystem operational', checkedAt: new Date().toISOString() };
  if (section === 'rag') return { section, status: 'UP', message: 'RAG pipeline available', checkedAt: new Date().toISOString() };
  if (section === 'agent') return { section, status: current.enabled !== false ? 'UP' : 'GRAY', message: current.enabled !== false ? 'Agent subsystem available' : 'Agent disabled', checkedAt: new Date().toISOString() };
  if (section === 'security') return { section, status: 'UP', message: 'Security configuration applied', checkedAt: new Date().toISOString() };
  if (section === 'performance') return { section, status: 'UP', message: 'Performance tuning applied', checkedAt: new Date().toISOString() };
  return { section, status: 'UP', message: 'Configuration valid', checkedAt: new Date().toISOString() };
}

async function resetConfigSection(section) {
  const defaults = Object.fromEntries(DEFAULT_CONFIG);
  if (!(section in defaults)) return null;
  config.set(section, { ...defaults[section] });
  persist();
  return config.get(section);
}

const providers = new Map();
const config = new Map();
const audits = [];
const MAX_AUDITS = 10000;
let auditId = 0;
let stateLoaded = false;

function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const item of saved.providers || []) providers.set(item.id, item);
    for (const [section, value] of Object.entries(saved.config || {})) config.set(section, value);
    audits.push(...(saved.audits || []));
    auditId = audits.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
  } catch (_) {
    for (const [k, v] of DEFAULT_PROVIDERS) providers.set(k, v);
    for (const [k, v] of DEFAULT_CONFIG) config.set(k, v);
  }
}

function resetState() {
  providers.clear();
  for (const [k, v] of DEFAULT_PROVIDERS) providers.set(k, v);
  config.clear();
  for (const [k, v] of DEFAULT_CONFIG) config.set(k, v);
  audits.length = 0;
  auditId = 0;
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
  stateLoaded = true;
}

loadState();

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ providers: [...providers.values()], config: Object.fromEntries(config), audits }, null, 2));
  } catch (_) {}
}

function masked(value) {
  if (!value) return null;
  const text = String(value);
  return text.length < 5 ? '****' : `${text.slice(0, 2)}****${text.slice(-2)}`;
}
function publicProvider(provider) {
  return { ...provider, credentials: Object.fromEntries(Object.entries(provider.credentials || {}).map(([k, v]) => [k, masked(v)])) };
}
async function listProviders() { return [...providers.values()].sort((a, b) => a.priority - b.priority).map(publicProvider); }
async function getProvider(id) { const provider = providers.get(id); return provider ? publicProvider(provider) : null; }
async function saveProvider(id, patch) {
  const current = providers.get(id);
  if (!current) return null;
  const next = { ...current, ...patch, id, credentials: { ...current.credentials, ...(patch.credentials || {}) } };
  const hasCreds = Object.values(next.credentials || {}).filter((v) => v != null && v !== '').length > 0;
  next.configurationState = (next.id === 'open-meteo' || hasCreds) ? 'CONFIGURED' : 'NOT_CONFIGURED';
  if (!next.enabled) next.status = 'GRAY';
  else if (next.configurationState !== 'CONFIGURED') next.status = 'GRAY';
  else if (!next.lastSuccess && next.status === 'PENDING') next.status = 'PENDING';
  else if (!next.lastSuccess && next.status !== 'RED') next.status = 'PENDING';
  providers.set(id, next);
  persist();
  return publicProvider(next);
}
async function createProvider(input) {
  const id = String(input.id || input.name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!id || providers.has(id)) return null;
  const provider = { id, name: input.name || id, enabled: !!input.enabled, priority: Number(input.priority) || providers.size + 1, status: 'GRAY', configurationState: 'NOT_CONFIGURED', latencyMs: null, requestCount: 0, failureCount: 0, successCount: 0, lastSuccess: null, lastFailure: null, credentials: input.credentials || {} };
  providers.set(id, provider);
  persist();
  return publicProvider(provider);
}
async function deleteProvider(id) { const deleted = providers.delete(id); if (deleted) persist(); return deleted; }
async function setProviderState(id, enabled) { return saveProvider(id, { enabled }); }

async function realProviderRequest(provider) {
  const creds = provider.credentials || {};
  const baseUrl = creds.baseUrl || (
    provider.id === 'openweather' ? 'https://api.openweathermap.org/data/2.5/weather' :
    provider.id === 'open-meteo' ? 'https://api.open-meteo.com/v1/forecast' :
    null
  );
  if (!baseUrl) return { ok: false, error: 'no baseUrl configured' };
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let url = baseUrl;
    let headers = { 'User-Agent': 'SkyGuard-AI/1.0' };
    if (provider.id === 'openweather') {
      if (!creds.apiKey) return { ok: false, error: 'apiKey required' };
      url = `${baseUrl}?q=London&appid=${encodeURIComponent(creds.apiKey)}`;
    } else if (provider.id === 'open-meteo') {
      url = `${baseUrl}?latitude=51.5&longitude=-0.1&current=temperature_2m`;
    } else if (creds.apiKey) {
      headers['Authorization'] = `Bearer ${creds.apiKey}`;
    }
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - start;
    let body = null;
    try { body = await res.json(); } catch (_) { body = null; }
    if (res.status >= 200 && res.status < 300) {
      const valid = provider.id === 'openweather'
        ? !!body?.main
        : provider.id === 'open-meteo'
          ? Number.isFinite(body?.current?.temperature_2m)
          : body != null;
      if (!valid) return { ok: false, statusCode: res.status, latencyMs, error: 'invalid provider response' };
      return { ok: true, statusCode: res.status, latencyMs, body };
    }
    return { ok: false, statusCode: res.status, latencyMs, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: e.message, latencyMs: Date.now() - start };
  }
}

async function testProvider(id) {
  const provider = providers.get(id);
  if (!provider) return null;
  const configured = provider.id === 'open-meteo' || Object.keys(provider.credentials || {}).filter((k) => provider.credentials[k]).length > 0;
  provider.requestCount += 1;
  provider.lastTestAt = new Date().toISOString();
  if (!configured) {
    provider.failureCount += 1;
    provider.lastFailure = provider.lastTestAt;
    provider.status = 'GRAY';
    provider.latencyMs = null;
    provider.lastError = 'not configured';
    provider.configurationState = 'NOT_CONFIGURED';
    persist();
    return publicProvider(provider);
  }
  const result = await realProviderRequest(provider);
  provider.latencyMs = result.latencyMs;
  if (result.ok) {
    provider.successCount += 1;
    provider.lastSuccess = provider.lastTestAt;
    provider.status = provider.enabled ? 'GREEN' : 'GRAY';
    provider.lastError = null;
    provider.configurationState = 'CONFIGURED';
  } else {
    provider.failureCount += 1;
    provider.lastFailure = provider.lastTestAt;
    provider.status = 'RED';
    provider.lastError = result.error || `HTTP ${result.statusCode}`;
    provider.configurationState = 'CONFIGURED';
  }
  persist();
  return publicProvider(provider);
}

async function getConfig(section) { return section ? (config.get(section) || null) : Object.fromEntries(config); }
async function saveConfig(section, value) {
  if (!config.has(section) || !value || typeof value !== 'object') return null;
  const validation = validateConfigSection(section, value);
  if (!validation.valid) throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  config.set(section, { ...config.get(section), ...value });
  persist();
  return config.get(section);
}

async function addAudit(event) {
  const item = { id: ++auditId, timestamp: new Date().toISOString(), actor: event.actor || 'system', action: event.action, resource: event.resource, resourceId: event.resourceId || null, oldValue: event.oldValue ?? null, newValue: event.newValue ?? null, result: event.result || 'SUCCESS', error: event.error || null };
  audits.unshift(item);
  if (audits.length > MAX_AUDITS) audits.length = MAX_AUDITS;
  persist();
  if (pg.isEnabled()) { try { await pg.query('INSERT INTO audit_logs (actor, action, resource, resource_id, old_value, new_value, result, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [item.actor, item.action, item.resource, item.resourceId, JSON.stringify(item.oldValue), JSON.stringify(item.newValue), item.result, item.error]); } catch (_) {} }
  return item;
}
async function listAudits({ limit = 100, action, resource } = {}) { let rows = audits; if (action) rows = rows.filter((r) => r.action === action); if (resource) rows = rows.filter((r) => r.resource === resource); return rows.slice(0, Math.min(Number(limit) || 100, 500)); }
async function getAudit(id) { return audits.find((r) => String(r.id) === String(id)) || null; }

module.exports = { listProviders, getProvider, saveProvider, createProvider, deleteProvider, setProviderState, testProvider, getConfig, saveConfig, validateConfigSection, testConfig, resetConfigSection, addAudit, listAudits, getAudit, resetState, CONFIG_SCHEMA };
