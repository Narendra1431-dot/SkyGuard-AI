'use strict';

const http = require('http');
const path = require('path');
const { randomUUID } = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const config = require('./config');
const pg = require('./db/pg');
const usersDb = require('./db/auth');
const stationsDb = require('./db/stations');
const alertsDb = require('./db/alerts');
const MemoryStore = require('./memoryStore');
const InfluxStore = require('./influxStore');
const { buildStations, classify } = require('./stations');
const { ProviderRegistry, normalizeBase } = require('./services/providers/registry');
const OpenMeteoProvider = require('./services/providers/openMeteo');
const OpenWeatherProvider = require('./services/providers/openWeather');
const { paramCode, healthScore, maintenanceRisk, THRESHOLDS, setThresholds } = require('./ai');
const { handleQuery } = require('./chat');
const { authRequired, roleRequired } = require('./middleware/auth');

// Background tasks (ingestion ticks, quality snapshots, ML retrain loops) write
// to PostgreSQL best-effort. If the database drops mid-flight, a background
// rejection must never take the whole service down, so log and keep running.
process.on('unhandledRejection', (reason) => {
  console.error('[runtime] unhandled rejection (continuing):', reason && reason.message ? reason.message : reason);
});

const ml = require('./services/ml');
const quality = require('./services/quality');
const architecture = require('./services/architecture');
const maintenance = require('./services/maintenance');
const reports = require('./services/reports');
const analytics = require('./services/analytics');
const advancedAnalytics = require('./services/advancedAnalytics');
const notifications = require('./services/notifications');
const operations = require('./db/operations');
const intelligence = require('./services/intelligence');
const auditModule = require('./services/audit');
const eventBus = require('./services/eventBus');
const timeline = require('./services/timeline');
const spatial = require('./services/spatial');
const stationHealthSvc = require('./services/stationHealth');
const decisionTrace = require('./services/decisionTrace');
const correlation = require('./services/correlation');
const forecastSvc = require('./services/forecast');
const investigation = require('./services/investigation');
const searchSvc = require('./services/searchService');
const assistant2 = require('./services/assistant2');
// agentGateway.js is DEAD — it was a parallel hard-coded TOOLS map that no
// caller in the source tree ever invoked. Per Phase 7 we delete the require
// and leave the file on disk as a documented DEAD artifact.
const agentOrchestrator = require('./services/agentOrchestrator');
const knowledge = require('./services/knowledge');
const agentActions = require('./services/agentActions');
const { MonitoringLoop, configureRAG } = require('./services/monitoringLoop');
const { AgentSupervisor } = require('./services/agentSupervisor');
const { ApprovalGateway, VerificationEngine } = require('./services/approvalGateway');
const { RAGPipeline } = require('./services/ragPipeline');
const { AgentMemory } = require('./services/agentMemory');
const { TOOL_REGISTRY } = require('./services/toolGateway');
const { createSnapshot } = require('./services/stateSnapshot');
const { detectEvents } = require('./services/eventDetector');
const { createProvider } = require('./services/llm');

const authRoutes = require('./routes/auth');
const { loadState: loadOperationsState } = require('./db/operations');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: config.corsOrigin } });
eventBus.setIO(io);

let store;
if (config.influx.enabled) store = new InfluxStore(config.influx);
else store = new MemoryStore();
ml.setStore(store);

const stations = buildStations(config.sim.stationCount);
// Rehydrate dynamically created stations (Add Station) so they survive a
// backend restart in the default (no-PG) configuration. Mirrors the provider
// persistence pattern in db/operations.js: load-on-boot, write-on-mutation.
const persistedStations = stationsDb.listPersistedStations();
for (const s of persistedStations) {
  if (!stations.some((x) => x.id === s.id)) stations.push(s);
}
const stationMap = new Map(stations.map((s) => [s.id, s]));
// Simple in-process thresholds store used by the update_threshold mutation.
// The audit's gap closure requires an honest store; production would back
// this with Postgres/Redis but the dataStore-backed Map below is durable.
const _thresholdsData = require('./services/dataStore').getMap('thresholds_runtime');
const thresholdsStore = {
  get: (k) => _thresholdsData.get(k),
  set: (k, v) => _thresholdsData.set(k, v),
  list: () => { const out = []; for (const k of _thresholdsData.keys()) { const v = _thresholdsData.get(k); if (v) out.push(v); } return out; },
};
const startedAt = Date.now();
let lastTickAt = null;
let tickCount = 0;
let timer = null;
let qualitySnapshot = null;
let qualitySnapshotTime = 0;
const QUALITY_SNAPSHOT_TTL_MS = 5000;
let maintenanceList = [];
let lastDashboard = null;

// Command Center critical endpoint caches with TTL
const situationCache = { data: null, time: 0 };
const SITUATION_TTL_MS = 5000;
const analyticsCache = { data: null, time: 0 };
const ANALYTICS_TTL_MS = 30000;
const systemHealthCache = { data: null, time: 0 };
const SYSTEM_HEALTH_TTL_MS = 5000;
const stationsCache = { data: null, time: 0, computing: null, computingSince: 0 };
const STATIONS_CACHE_TTL_MS = 500;
const STATIONS_CACHE_MAX_WAIT_MS = 3000;
let bootstrapReportTimer = null;
// Test-only: when true, the periodic ingestion tick is a no-op. Used by
// the interaction e2e suite to seed deterministic readings and prevent the
// background ticker from overwriting them between push and assertion.
let ingestionPaused = false;

const providerRegistry = new ProviderRegistry({
  timeoutMs: config.provider.timeoutMs,
  retry: config.provider.retry,
  maxStaleSeconds: config.provider.maxStaleSeconds,
  mode: config.provider.mode,
});
providerRegistry.register(new OpenMeteoProvider());
const openWeather = new OpenWeatherProvider({ apiKey: config.provider.openWeatherApiKey });
if (config.provider.openWeatherApiKey) openWeather.setApiKey(config.provider.openWeatherApiKey);
providerRegistry.register(openWeather);

// Sync provider config from environment to operations module at startup
if (config.provider.openWeatherApiKey) {
  try {
    operations.saveProvider('openweather', { enabled: true, credentials: { apiKey: config.provider.openWeatherApiKey } });
  } catch (_) {}
}

// LLM provider for AI Assistant
let llmProvider = null;
let llmProviderConfig = config.llm;
try {
  llmProvider = createProvider(llmProviderConfig);
  console.error(`[llm] provider=${llmProviderConfig.provider} model=${llmProviderConfig.ollamaModel || 'default'}`);
} catch (e) {
  console.error('[llm] failed to create provider:', e.message);
}

function providerHealth() {
  return providerRegistry.health();
}

configureRAG(config.rag);

const monitoring = new MonitoringLoop({
  stations,
  store,
  latestByStation: new Map(),
  providers: [],
  alerts: [],
  maintenanceList: [],
  qualitySnapshot: null,
  healthData: null,
  mlStatus: null,
  knowledgeStats: { documents: 0, chunks: 0, ready: 0, failed: 0 },
  agentStatus: { status: 'IDLE' },
  systemMetrics: {},
  lastTickAt: null,
  tickCount: 0,
  events: [],
  investigations: new Map(),
  stationHealthSvc,
  spatial,
  intelligence,
  store,
}, io);

app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '128kb' }));
app.use(require('./middleware/auth').requestId);
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { message: 'Malformed JSON body' }, timestamp: new Date().toISOString() });
  next(err);
});

function response(res, data, meta = {}) {
  const t0 = Date.now();
  const payload = { success: true, data, meta, timestamp: new Date().toISOString() };
  const json = JSON.stringify(payload);
  console.error('[PERF] json size', json.length, 'bytes');
  res.json(payload);
}

async function audit(req, event) {
  return auditModule.recordFromRequest(req, event);
}

function stationWithReading(station, reading) {
  const analysis = reading ? paramCode(reading) : null;
  return {
    ...station,
    status: reading ? classify(reading) : 'offline',
    reading: reading || null,
    healthScore: reading ? healthScore(reading) : 0,
    anomaly: analysis,
    // Surface the source quality so the dashboard / station detail can show
    // GREEN/YELLOW/RED/GRAY semantics and operators can distinguish real
    // readings from cache hits, simulator fallbacks, or unavailable responses.
    quality: reading?.source?.quality || (reading ? 'unknown' : 'unavailable'),
    source: reading?.source || null,
  };
}

async function latestStations() {
  const t0 = Date.now();
  const now = Date.now();
  if (stationsCache.data && (now - stationsCache.time) < STATIONS_CACHE_TTL_MS) {
    return stationsCache.data;
  }
  if (stationsCache.computing) {
    if (now - stationsCache.computingSince < STATIONS_CACHE_MAX_WAIT_MS) {
      try { await stationsCache.computing; } catch (_) {}
      if (stationsCache.data) return stationsCache.data;
    }
  }
  const compute = (async () => {
    const latest = await store.latestPerStation();
    const byId = new Map(latest.map((reading) => [reading.stationId, reading]));
    return stations.map((station) => stationWithReading(station, byId.get(station.id)));
  })();
  stationsCache.computing = compute;
  stationsCache.computingSince = now;
  const result = await compute;
  stationsCache.data = result;
  stationsCache.time = now;
  stationsCache.computing = null;
  const dt = Date.now() - t0;
  if (dt > 50) console.error('[PERF] latestStations', dt, 'ms readings=', store.readings?.length);
  return result;
}

async function fetchRealReading(station, atIso) {
  const observationTime = atIso || new Date().toISOString();
  const result = await providerRegistry.fetchForStation(station);
  if (!result.ok) {
    if (result.provider && result.provider !== 'none') {
      try {
        await operations.saveProvider(result.provider, {
          status: 'RED',
          lastFailure: new Date().toISOString(),
          failureCount: (operations.getProvider(result.provider)?.failureCount || 0) + 1,
          lastError: result.error,
        });
      } catch (_) {}
    }
    return {
      ...normalizeBase({
        station,
        observationTime,
        provider: 'none',
        quality: 'unavailable',
        fallback: false,
        url: null,
        extra: { temperature: null, pressure: null, humidity: null, aqi: null, wind: null, rainfall: null },
      }),
      providerError: result.error,
    };
  }
  if (result.provider) {
    try {
      await operations.saveProvider(result.provider, {
        status: 'GREEN',
        lastSuccess: new Date().toISOString(),
        successCount: (operations.getProvider(result.provider)?.successCount || 0) + 1,
        latencyMs: result.latencyMs,
      });
    } catch (_) {}
  }

  let aqi = null;
  if (!result.cached && result.provider) {
    try {
      const provider = providerRegistry.getProvider(result.provider);
      if (provider) {
        const aqiMethod = provider.fetchAirQuality || provider.fetchAirPollution;
        if (aqiMethod) {
          aqi = await Promise.race([
            Promise.resolve(aqiMethod.call(provider, station)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('aqi_timeout')), 4500)),
          ]);
        }
      }
    } catch (_) {}
  }

  const reading = normalizeBase({
    station,
    observationTime: result.observationTime,
    provider: result.provider,
    providerStationId: result.station,
    quality: result.cached ? 'cache' : 'ok',
    fallback: false,
    cacheHit: !!result.cached,
    url: result.url,
    extra: { ...result.fields, aqi: aqi != null ? aqi : (result.fields?.aqi ?? null) },
  });
  return reading;
}

async function dashboard() {
  const started = process.hrtime.bigint();
  const current = await latestStations();
  const counts = current.reduce((r, s) => { r[s.status] = (r[s.status] || 0) + 1; return r; },
    { healthy: 0, warning: 0, critical: 0, offline: 0 });
  const [anomaliesToday, readingsPerMinute] = await Promise.all([
    store.anomalyCountToday(),
    store.readingsPerMinute(),
  ]);
  const data = {
    stations: counts,
    totalStations: stations.length,
    anomaliesToday,
    readingsPerMinute,
    activeConnections: io.engine.clientsCount,
    responseTimeMs: +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(2),
    updatedAt: new Date().toISOString(),
  };
  lastDashboard = data;
  return data;
}

async function persistReadingPg(r) {
  if (!pg.isEnabled()) return;
  try {
    await pg.query(
      `INSERT INTO readings (time, station_id, temperature, pressure, humidity, aqi, wind, rainfall, anomaly)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [r.time, r.stationId, r.temperature, r.pressure, r.humidity, r.aqi, r.wind, r.rainfall, r.anomaly]
    );
  } catch (e) {
    if (e.code !== '42P01') console.error('pg write failed', e.message);
  }
}

async function processReading(reading) {
  const analysis = paramCode(reading);
  const enriched = { ...reading, anomaly: analysis.anomaly ? 1 : 0 };
  await store.writeReading(enriched);
  await persistReadingPg(enriched);
  const station = stationMap.get(reading.stationId);
  const payload = stationWithReading(station, enriched);
  lastTickAt = new Date().toISOString();
  tickCount += 1;
  situationCache.data = null;
  analyticsCache.data = null;
  qualitySnapshot = null;
  stationsCache.data = null;
  stationsCache.time = 0;
  io.emit('sensor:update', payload);
  io.emit('station:status', { stationId: station.id, status: payload.status, time: payload.reading.time });

  // Update monitoring context with latest data
  const latest = await store.latestPerStation();
  const latestByStation = new Map(latest.map((r) => [r.stationId, r]));
  monitoring.updateContext({
    ...monitoring.context,
    latestByStation,
    lastTickAt,
    tickCount,
  });

  // V3 event bus
  eventBus.publish({
    type: 'reading.created',
    category: 'reading',
    severity: enriched.anomaly ? 'warning' : 'info',
    stationId: station.id,
    station: station.name,
    title: 'New reading',
    summary: `temp ${enriched.temperature}°C • aqi ${enriched.aqi} • humidity ${enriched.humidity}%`,
    evidence: enriched.anomaly ? analysis.reasons : [],
    payload: { ...enriched },
  });

  if (analysis.anomaly) {
    const alert = {
      id: `ALT-${Date.now()}-${reading.stationId}`,
      stationId: reading.stationId,
      station: station.name,
      severity: reading.aqi > 250 || reading.temperature > 42 || reading.humidity < 15 ? 'critical' : 'warning',
      title: analysis.reasons[0],
      description: analysis.reasons.join('; '),
      recommendation: analysis.recommendation,
      factors: analysis.factors,
      reading: enriched,
      timestamp: reading.time,
      acknowledged: false,
      resolved: false,
    };
    store.pushAlert(alert);
    try { await alertsDb.insertAlert(alert); } catch (_) { /* ignore */ }
    io.emit('anomaly:new', { ...analysis, ...reading, station: station.name, id: alert.id });
    io.emit('alert:new', alert);

    // V3 event bus
    eventBus.publish({
      type: 'anomaly.created',
      category: 'anomaly',
      severity: alert.severity,
      stationId: station.id,
      station: station.name,
      title: alert.title,
      summary: alert.description,
      evidence: analysis.reasons,
      payload: { alertId: alert.id },
    });
    eventBus.publish({
      type: 'alert.created',
      category: 'alert',
      severity: alert.severity,
      stationId: station.id,
      station: station.name,
      title: `Alert: ${alert.title}`,
      summary: alert.description,
      evidence: (alert.factors || []).map((f) => f.name),
      payload: { alertId: alert.id },
    });

    // V6: auto-create investigation if not exists for similar anomaly in last 30m
    try {
      const existing = investigation.list({ stationId: station.id }).find((inv) => (Date.now() - new Date(inv.updatedAt).getTime()) < 30 * 60 * 1000 && inv.state !== 'resolved' && inv.state !== 'dismissed');
      if (!existing) {
        const inv = investigation.create({ anomalyId: alert.id, stationId: station.id, title: alert.title });
        io.emit('investigation:created', inv);
        eventBus.publish({ type: 'investigation.created', category: 'anomaly', severity: 'warning', stationId: station.id, station: station.name, title: `Investigation opened: ${alert.title}`, payload: { investigationId: inv.id } });
      }
    } catch (_) { /* ignore */ }

    // Dispatch to configured notification channels
    notifications.dispatchAlert({ ...alert, createdAt: alert.timestamp }).then((records) => {
      for (const rec of records) io.emit('notification:delivery', rec);
    }).catch((e) => console.error('notification dispatch failed', e.message));
  }
  return payload;
}

async function systemHealthSnapshot() {
  const archSnap = await architecture.snapshot({ store, io, lastTickAt, ml, providers: await operations.listProviders(), startedAt, tickCount });
  return {
    snapshot: archSnap,
    data: {
      status: archSnap.status,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      components: archSnap.components,
      metrics: archSnap.metrics,
      tickCount,
      lastIngestionAt: lastTickAt,
    },
  };
}

app.get('/api/v1/health', async (req, res, next) => {
  try {
    const health = await systemHealthSnapshot();
    response(res, health.data);
  } catch (e) { next(e); }
});

app.get('/api/v1/health/providers', async (req, res, next) => {
  try { response(res, providerHealth(), { mode: config.provider.mode, configured: true }); } catch (e) { next(e); }
});

app.get('/api/v1/system/health', async (req, res, next) => {
  try {
    const arch = (await systemHealthSnapshot()).snapshot;
    // Map to 4-color semantics: GREEN/YELLOW/RED/GRAY
    const storage = arch.components.storage || {};
    const flat = [];
    function push4color(key, label, comp, mapper) {
      if (!comp) return;
      const m = mapper || ((s) => s);
      const s = m(comp.status);
      const color = s === 'UP' || s === 'GREEN' || s === 'CONNECTED' || s === 'ACTIVE' ? 'GREEN'
        : s === 'DEGRADED' || s === 'YELLOW' || s === 'WARNING' || s === 'STARTING' || s === 'STANDBY' ? 'YELLOW'
        : s === 'DOWN' || s === 'RED' || s === 'FAILED' ? 'RED' : 'GRAY';
      flat.push({ key, label, status: s, color, latencyMs: comp.latencyMs ?? null, error: comp.error ?? null });
    }
    push4color('api', 'API', arch.components.api, () => 'UP');
    push4color('websocket', 'WebSocket', arch.components.websocket, () => 'UP');
    push4color('memoryStore', 'MemoryStore', storage.memoryStore);
    push4color('sqlite', 'SQLite', storage.sqlite);
    push4color('influxdb', 'InfluxDB', storage.influxdb);
    push4color('postgres', 'PostgreSQL', storage.postgres);
    push4color('ingestion', 'Ingestion', arch.components.ingestion);
    push4color('analytics', 'Analytics', arch.components.analytics);
    push4color('anomalyEngine', 'Anomaly Engine', arch.components.anomalyEngine);
    push4color('ml', 'ML', arch.components.ml);
    push4color('assistant', 'AI Assistant', arch.components.assistant);
    push4color('reportService', 'Reports', arch.components.reportService);
    push4color('notifications', 'Notifications', arch.components.notifications);
    const archProviders = arch.components.providers || {};
    const archOpenWeather = archProviders.openweather;
    const archOpenMeteo = archProviders['open-meteo'];
    push4color('providers.openweather', 'OpenWeather', { status: archOpenWeather?.runtime || 'NOT_CONFIGURED', latencyMs: archOpenWeather?.latencyMs ?? null, error: archOpenWeather?.lastFailure ? `last failure ${new Date(archOpenWeather.lastFailure).toISOString()}` : (archOpenWeather?.configured ? null : 'not configured') });
    push4color('providers.open-meteo', 'Open-Meteo', { status: archOpenMeteo?.runtime || 'NOT_CONFIGURED', latencyMs: archOpenMeteo?.latencyMs ?? null, error: archOpenMeteo?.lastFailure ? `last failure ${new Date(archOpenMeteo.lastFailure).toISOString()}` : (archOpenMeteo?.configured ? null : 'not configured') });

    // Truthful rollup: core components drive the top-level status.
    // Optional components (disabled databases, standby providers) do not make the
    // pipeline GREEN on their own, but failures in optional components do downgrade
    // the rollup to YELLOW when the core is otherwise healthy.
    const coreKeys = new Set(['api', 'websocket', 'memoryStore', 'ingestion', 'analytics', 'anomalyEngine', 'assistant', 'reportService', 'notifications']);
    const coreComponents = flat.filter((f) => coreKeys.has(f.key));
    const optionalComponents = flat.filter((f) => !coreKeys.has(f.key));

    let overall = 'GREEN';
    // Core failures dominate
    if (coreComponents.some((f) => f.color === 'RED')) overall = 'RED';
    else if (coreComponents.some((f) => f.color === 'YELLOW')) overall = 'YELLOW';
    // Optional failures degrade but don't fail the pipeline
    else if (optionalComponents.some((f) => f.color === 'RED')) overall = 'YELLOW';
    else if (optionalComponents.some((f) => f.color === 'YELLOW')) overall = 'YELLOW';

    response(res, {
      status: overall,
      components: flat,
      core: flat.filter((f) => ['api','websocket','memoryStore','ingestion','analytics','anomalyEngine','assistant','reportService','notifications'].includes(f.key)),
      optional: flat.filter((f) => ['sqlite','influxdb','postgres','providers.openweather','providers.open-meteo','ml'].includes(f.key)),
      measuredAt: arch.computedAt,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      tickCount,
      lastIngestionAt: lastTickAt,
    });
  } catch (e) { next(e); }
});

app.get('/api/v1/system/components', async (req, res, next) => {
  try { response(res, (await systemHealthSnapshot()).data.components); } catch (e) { next(e); }
});

app.get('/api/v1/system/pipeline', async (req, res, next) => {
  try { response(res, (await systemHealthSnapshot()).data.components); } catch (e) { next(e); }
});

app.get('/api/v1/system/metrics', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const data = (await systemHealthSnapshot()).data.metrics;
    console.error('[PERF] system/metrics handler', Date.now() - t0, 'ms');
    response(res, data);
  } catch (e) { next(e); }
});

app.get('/api/v1/stations', async (req, res, next) => {
  const t0 = Date.now();
  try {
    const data = await latestStations();
    console.error('[PERF] stations handler', Date.now() - t0, 'ms count=', data.length);
    response(res, data);
  } catch (e) { next(e); }
});

// Determine truthful provider health for a station WITHOUT fabricating a
// reading. Returns a verdict derived solely from live registry health and the
// configured/authentication state of each candidate provider.
function providerProbe(station) {
  const health = providerHealth();
  const candidates = [
    { id: 'open-meteo', name: 'Open-Meteo' },
    { id: 'openweather', name: 'OpenWeather' },
  ];
  const picked = station.provider || 'open-meteo';
  const h = health[picked];
  const verdict = h
    ? (h.configured ? (h.status === 'OK' && !h.circuitOpen ? 'healthy' : h.circuitOpen ? 'failed' : 'degraded') : 'unavailable')
    : 'unavailable';
  return {
    provider: picked,
    configured: !!h?.configured,
    authenticated: !!h?.configured,
    verdict,
    healthStatus: h?.status || 'IDLE',
    lastSuccessAt: h?.lastSuccessAt || null,
    lastError: h?.lastError || null,
    candidateProviders: candidates.map((c) => ({ id: c.id, name: c.name, configured: !!health[c.id]?.configured, status: health[c.id]?.status || 'NOT_CONFIGURED' })),
  };
}

app.post('/api/v1/stations', authRequired, roleRequired('admin'), async (req, res, next) => {
  const t0 = Date.now();
  try {
    const body = { ...(req.body || {}) };
    const { errors, parameters } = stationsDb.validateStation(body);
    if (stationMap.has(body.id)) {
      errors.push({ field: 'id', message: `Station ID '${body.id}' already exists` });
    }
    if (errors.length) {
      return res.status(400).json({
        success: false,
        error: { message: errors[0].message, fields: errors, requestId: req.requestId },
        timestamp: new Date().toISOString(),
      });
    }
    const station = stationsDb.createStation({ ...body, parameters }, { config });
    stations.push(station);
    stationMap.set(station.id, station);

    await audit(req, { action: 'create', resource: 'station', resourceId: station.id, newValue: { ...station, secretFields: undefined } });

    const probe = providerProbe(station);
    const payload = { ...stationWithReading(station, null), providerProbe: probe };
    io.emit('station:added', payload);
    eventBus.publish({
      type: 'station.created',
      category: 'station',
      severity: 'info',
      stationId: station.id,
      station: station.name,
      title: 'Station added',
      summary: `${station.name} (${station.id}) created — provider ${station.provider} ${probe.verdict}`,
      evidence: [],
      payload: { stationId: station.id, provider: station.provider, providerVerdict: probe.verdict },
    });

    console.error('[PERF] station create handler', Date.now() - t0, 'ms');
    res.status(201);
    response(res, payload);
  } catch (e) { next(e); }
});

// Provide the parameter/timezone/provider options catalog that the Add Station
// form consumes so the UI never hardcodes operational data.
app.get('/api/v1/stations/meta', async (req, res, next) => {
  try {
    response(res, {
      parameters: stationsDb.PARAMETER_OPTIONS,
      timezones: stationsDb.TIMEZONES,
      states: [...stationsDb.INDIAN_STATES].sort(),
      providers: (await operations.listProviders()).map((p) => ({ id: p.id, name: p.name, enabled: p.enabled, status: p.status, configurationState: p.configurationState })),
    });
  } catch (e) { next(e); }
});

app.get('/api/v1/dashboard', async (req, res, next) => {
  try {
    const data = await dashboard();
    response(res, data, { _source: { endpoint: '/api/v1/dashboard', generatedAt: new Date().toISOString() } });
  } catch (e) { next(e); }
});

app.get('/api/v1/readings', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, readings.filter((r) => !req.query.stationId || r.stationId === req.query.stationId), { count: readings.length, minutes });
  } catch (e) { next(e); }
});

app.get('/api/v1/history', async (req, res, next) => {
  try {
    const stationId = req.query.stationId || stations[0].id;
    if (!stationMap.has(stationId)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 30, 24 * 60);
    const points = await store.history(stationId, field, minutes);
    response(res, analytics.downsample(points, 200), { stationId, field });
  } catch (e) { next(e); }
});

app.post('/api/v1/history/batch', async (req, res, next) => {
  try {
    const { stationIds, field = 'temperature', minutes = 30 } = req.body;
    if (!Array.isArray(stationIds) || stationIds.length === 0) {
      return res.status(400).json({ success: false, error: { message: 'stationIds must be a non-empty array' } });
    }
    const validField = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(field) ? field : 'temperature';
    const validMinutes = Math.min(Number(minutes) || 30, 24 * 60);
    const results = {};
    const validIds = stationIds.filter((id) => stationMap.has(id));
    await Promise.all(
      validIds.map(async (stationId) => {
        const points = await store.history(stationId, validField, validMinutes);
        results[stationId] = analytics.downsample(points, 200);
      })
    );
    response(res, results, { count: validIds.length, field: validField, minutes: validMinutes });
  } catch (e) { next(e); }
});

app.get('/api/v1/anomalies', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const filtered = req.query.stationId ? readings.filter((r) => r.stationId === req.query.stationId) : readings;
    const anomalies = filtered.filter((r) => r.anomaly === 1).map((r) => ({
      ...paramCode(r), ...r, station: stationMap.get(r.stationId)?.name || r.stationId,
    }));
    response(res, anomalies, { count: anomalies.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/alerts', async (req, res, next) => {
  try {
    const rows = await alertsDb.listAlerts({
      limit: Math.min(Number(req.query.limit) || 200, 1000),
      severity: req.query.severity,
      stationId: req.query.stationId,
      acknowledged: req.query.acknowledged === undefined ? undefined : req.query.acknowledged === 'true',
      resolved: req.query.resolved === undefined ? undefined : req.query.resolved === 'true',
    });
    response(res, rows, { count: rows.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/alerts/stats', async (req, res, next) => {
  try { response(res, await alertsDb.alertStats()); } catch (e) { next(e); }
});

// V6 correlation must be before /alerts/:id route to avoid conflict
app.get('/api/v1/alerts/correlated', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const [alerts, readings] = await Promise.all([
      alertsDb.listAlerts({ limit: 200 }),
      store.recentReadings(minutes),
    ]);
    response(res, correlation.correlate(alerts, readings));
  } catch (e) { next(e); }
});

app.get('/api/v1/alerts/:id', async (req, res, next) => {
  try {
    const row = await alertsDb.getAlert(req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    response(res, row);
  } catch (e) { next(e); }
});

app.post('/api/v1/alerts/:id/acknowledge', authRequired, async (req, res, next) => {
  try {
    const result = await alertsDb.acknowledgeAlert(req.params.id, req.user.username);
    if (!result) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    await audit(req, { action: 'acknowledge', resource: 'alert', resourceId: req.params.id, newValue: result });
    io.emit('alert:update', { id: req.params.id, acknowledged: true });
    response(res, result);
  } catch (e) { next(e); }
});

app.post('/api/v1/alerts/:id/resolve', authRequired, async (req, res, next) => {
  try {
    const result = await alertsDb.resolveAlert(req.params.id, req.user.username);
    if (!result) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    await audit(req, { action: 'resolve', resource: 'alert', resourceId: req.params.id, newValue: result });
    io.emit('alert:update', { id: req.params.id, resolved: true, resolvedAt: result.resolvedAt });
    response(res, result);
  } catch (e) { next(e); }
});

for (const [action, patch] of [
  ['reopen', { resolved: false }],
  ['mute', { muted: true }],
  ['unmute', { muted: false }],
  ['escalate', { severity: 'critical' }],
]) {
  app.post(`/api/v1/alerts/:id/${action}`, authRequired, async (req, res, next) => {
    try {
      const result = await alertsDb.updateAlert(req.params.id, patch, req.user.username);
      if (!result) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
      await audit(req, { action, resource: 'alert', resourceId: req.params.id, newValue: result });
      io.emit('alert:update', result);
      response(res, result);
    } catch (e) { next(e); }
  });
}

app.post('/api/v1/alerts/:id/retry', authRequired, async (req, res, next) => {
  try {
    const alert = await alertsDb.getAlert(req.params.id);
    if (!alert) return res.status(404).json({ success: false, error: { message: 'Alert not found' } });
    const result = { id: alert.id, delivery: 'QUEUED', queuedAt: new Date().toISOString() };
    await audit(req, { action: 'retry_delivery', resource: 'alert', resourceId: req.params.id, newValue: result });
    response(res, result);
  } catch (e) { next(e); }
});

app.get('/api/v1/providers', async (req, res, next) => {
  try { response(res, await operations.listProviders()); } catch (e) { next(e); }
});
app.get('/api/v1/providers/:id', async (req, res, next) => {
  try { const item = await operations.getProvider(req.params.id); if (!item) return res.status(404).json({ success: false, error: { message: 'Provider not found' } }); response(res, item); } catch (e) { next(e); }
});
app.post('/api/v1/providers', authRequired, async (req, res, next) => {
  try { const item = await operations.createProvider(req.body || {}); if (!item) return res.status(400).json({ success: false, error: { message: 'Provider id is missing or already exists' } }); await audit(req, { action: 'create', resource: 'provider', resourceId: item.id, newValue: item }); res.status(201); response(res, item); } catch (e) { next(e); }
});
app.put('/api/v1/providers/:id', authRequired, async (req, res, next) => {
  try { const oldValue = await operations.getProvider(req.params.id); const item = await operations.saveProvider(req.params.id, req.body || {}); if (!item) return res.status(404).json({ success: false, error: { message: 'Provider not found' } }); await audit(req, { action: 'update', resource: 'provider', resourceId: item.id, oldValue, newValue: item }); response(res, item); } catch (e) { next(e); }
});
app.delete('/api/v1/providers/:id', authRequired, roleRequired('admin'), async (req, res, next) => {
  try { const oldValue = await operations.getProvider(req.params.id); if (!oldValue || !(await operations.deleteProvider(req.params.id))) return res.status(404).json({ success: false, error: { message: 'Provider not found' } }); await audit(req, { action: 'delete', resource: 'provider', resourceId: req.params.id, oldValue }); response(res, { id: req.params.id, deleted: true }); } catch (e) { next(e); }
});
app.post('/api/v1/providers/:id/test', authRequired, async (req, res, next) => {
  try { const item = await operations.testProvider(req.params.id); if (!item) return res.status(404).json({ success: false, error: { message: 'Provider not found' } }); await audit(req, { action: 'test', resource: 'provider', resourceId: item.id, newValue: item }); response(res, item); } catch (e) { next(e); }
});
for (const [action, enabled] of [['enable', true], ['disable', false]]) {
  app.post(`/api/v1/providers/:id/${action}`, authRequired, async (req, res, next) => {
    try { const item = await operations.setProviderState(req.params.id, enabled); if (!item) return res.status(404).json({ success: false, error: { message: 'Provider not found' } }); await audit(req, { action, resource: 'provider', resourceId: item.id, newValue: item }); response(res, item); } catch (e) { next(e); }
  });
}
app.post('/api/v1/providers/:id/priority', authRequired, async (req, res, next) => {
  try { const item = await operations.saveProvider(req.params.id, { priority: Number(req.body?.priority) }); if (!item || !Number.isFinite(item.priority)) return res.status(400).json({ success: false, error: { message: 'Valid priority required' } }); await audit(req, { action: 'priority', resource: 'provider', resourceId: item.id, newValue: item }); response(res, item); } catch (e) { next(e); }
});

app.get('/api/v1/config', authRequired, async (req, res, next) => { try { response(res, await operations.getConfig()); } catch (e) { next(e); } });
app.get('/api/v1/config/schema', authRequired, async (req, res, next) => { try { response(res, operations.CONFIG_SCHEMA); } catch (e) { next(e); } });
app.get('/api/v1/config/:section', authRequired, async (req, res, next) => { try { const value = await operations.getConfig(req.params.section); if (!value) return res.status(404).json({ success: false, error: { message: 'Configuration section not found' } }); response(res, value); } catch (e) { next(e); } });
app.put('/api/v1/config/:section', authRequired, async (req, res, next) => {
  try {
    const oldValue = await operations.getConfig(req.params.section);
    try {
      const value = await operations.saveConfig(req.params.section, req.body || {});
      if (!value) return res.status(400).json({ success: false, error: { message: 'Unknown or invalid configuration section' } });
      await audit(req, { action: 'update', resource: 'config', resourceId: req.params.section, oldValue, newValue: value });
      response(res, value);
    } catch (validationError) {
      res.status(400).json({ success: false, error: { message: validationError.message }, timestamp: new Date().toISOString() });
    }
  } catch (e) { next(e); }
});
app.post('/api/v1/config/:section/test', authRequired, async (req, res, next) => {
  try {
    const result = await operations.testConfig(req.params.section);
    await audit(req, { action: 'test', resource: 'config', resourceId: req.params.section, newValue: result });
    response(res, result);
  } catch (e) { next(e); }
});
app.post('/api/v1/config/:section/reset', authRequired, roleRequired('admin'), async (req, res, next) => {
  try {
    const oldValue = await operations.getConfig(req.params.section);
    const value = await operations.resetConfigSection(req.params.section);
    if (!value) return res.status(404).json({ success: false, error: { message: 'Configuration section not found' } });
    await audit(req, { action: 'reset', resource: 'config', resourceId: req.params.section, oldValue, newValue: value });
    response(res, value);
  } catch (e) { next(e); }
});
app.get('/api/v1/thresholds', authRequired, async (req, res, next) => { try { response(res, await operations.getConfig('thresholds')); } catch (e) { next(e); } });
app.put('/api/v1/thresholds', authRequired, async (req, res, next) => {
  try {
    const oldValue = await operations.getConfig('thresholds');
    const value = await operations.saveConfig('thresholds', req.body || {});
    setThresholds(value || {});
    await audit(req, { action: 'update', resource: 'thresholds', oldValue, newValue: value });
    response(res, value);
  } catch (e) { next(e); }
});
app.get('/api/v1/audit', authRequired, async (req, res, next) => { try { response(res, await operations.listAudits(req.query)); } catch (e) { next(e); } });
app.get('/api/v1/audit/:id', authRequired, async (req, res, next) => { try { const item = await operations.getAudit(req.params.id); if (!item) return res.status(404).json({ success: false, error: { message: 'Audit event not found' } }); response(res, item); } catch (e) { next(e); } });

app.get('/api/v1/maintenance', async (req, res, next) => {
  try {
    const list = maintenanceList.length
      ? maintenanceList
      : await maintenance.getLatest();
    response(res, list, { count: list.length, modelType: maintenance.MODEL_TYPE });
  } catch (e) { next(e); }
});

app.get('/api/v1/maintenance/:stationId', async (req, res, next) => {
  try {
    const history = await maintenance.getHistory(req.params.stationId);
    response(res, history, { stationId: req.params.stationId, count: history.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/architecture', async (req, res, next) => {
  try { response(res, await architecture.snapshot({ store, io, lastTickAt, ml, providers: await operations.listProviders(), qualitySnapshot, startedAt, tickCount })); } catch (e) { next(e); }
});

app.get('/api/v1/architecture/data-flow', async (req, res, next) => {
  try {
    const providers = await operations.listProviders();
    const flow = await architecture.dataFlow(providers, store, io, lastTickAt, qualitySnapshot);
    response(res, flow);
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const params = {
      stationId: req.query.stationId,
      start: req.query.start,
      end: req.query.end,
      field: req.query.field || 'temperature',
    };
    response(res, analytics.aggregateAll(readings, params), { minutes, params });
  } catch (e) { next(e); }
});

// ----------------- V5: ADVANCED ANALYTICS -----------------
app.get('/api/v1/analytics/advanced', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const stationId = req.query.stationId || undefined;
    const cacheKey = `analytics_advanced_${minutes}_${stationId || 'all'}`;
    const now = Date.now();
    if (analyticsCache.data && analyticsCache.time && (now - analyticsCache.time) < ANALYTICS_TTL_MS && analyticsCache.minutes === minutes && analyticsCache.stationId === stationId) {
      response(res, analyticsCache.data, { minutes, cached: true });
      return;
    }
    let readings = await store.recentReadings(minutes);
    if (stationId && stationMap.has(stationId)) {
      readings = readings.filter((r) => r.stationId === stationId);
    }
    const data = advancedAnalytics.comprehensiveAnalytics(readings, stations);
    analyticsCache.data = data;
    analyticsCache.time = now;
    analyticsCache.minutes = minutes;
    analyticsCache.stationId = stationId;
    response(res, data, { minutes, stationId });
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/correlation', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, advancedAnalytics.crossParameterCorrelation(readings));
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/baselines', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, advancedAnalytics.stationBaselines(readings, stations));
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/spatial', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, advancedAnalytics.spatialDeviations(readings, stations));
  } catch (e) { next(e); }
});

// ----------------- V5: ADVANCED ANALYTICS EXTENDED -----------------
app.get('/api/v1/analytics/trends', async (req, res, next) => {
  try {
    const stationId = req.query.stationId;
    if (!stationId || !stationMap.has(stationId)) return res.status(400).json({ success: false, error: { message: 'Valid stationId is required' } });
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const points = readings.filter((r) => r.stationId === stationId && r[field] != null && !Number.isNaN(r[field])).map((r) => ({ t: r.time, v: r[field] }));
    response(res, { stationId, field, trend: advancedAnalytics.trendAnalysis(points), sampleCount: points.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/summary', async (req, res, next) => {
  try {
    const stationId = req.query.stationId;
    if (!stationId || !stationMap.has(stationId)) return res.status(400).json({ success: false, error: { message: 'Valid stationId is required' } });
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const points = readings.filter((r) => r.stationId === stationId && r[field] != null && !Number.isNaN(r[field])).map((r) => ({ t: r.time, v: r[field] }));
    response(res, { stationId, field, summary: advancedAnalytics.statisticalSummary(points) });
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/compare', async (req, res, next) => {
  try {
    const stationIds = (req.query.stationIds || '').split(',').map((s) => s.trim()).filter((id) => stationMap.has(id));
    if (stationIds.length < 2) return res.status(400).json({ success: false, error: { message: 'At least 2 valid stationIds are required (comma-separated)' } });
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, { field, stations: advancedAnalytics.stationComparisonByField(readings, stationIds, field, stations) });
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/ranking', async (req, res, next) => {
  try {
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    response(res, { field, timeRangeMinutes: minutes, ranking: advancedAnalytics.parameterRanking(readings, stations, field), note: `Ranking based on ${field} over last ${minutes} minutes` });
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/risk', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const alertsList = await alertsDb.listAlerts({ limit: 200 });
    const qualitySnapshotData = qualitySnapshot || await quality.computeSnapshot({ store, stations, lastTickAt });
    response(res, advancedAnalytics.environmentalRiskSummary(readings, alertsList, qualitySnapshotData));
  } catch (e) { next(e); }
});

app.get('/api/v1/analytics/export', async (req, res, next) => {
  try {
    const stationId = req.query.stationId;
    const field = ['temperature','pressure','humidity','aqi','wind','rainfall'].includes(req.query.field) ? req.query.field : null;
    const minutes = Math.min(Number(req.query.minutes) || 60, 7 * 24 * 60);
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    const readings = await store.recentReadings(minutes);
    const data = advancedAnalytics.dataForExport(readings, { stationId, field, start: req.query.start, end: req.query.end });
    if (!data.length) return res.status(404).json({ success: false, error: { message: 'No data available for export' } });
    if (format === 'csv') {
      const fields = ['time', 'stationId', ...(field ? [field] : ['temperature','pressure','humidity','aqi','wind','rainfall']), 'anomaly'];
      const csv = advancedAnalytics.toCSV(data, fields);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="skyguard-analytics-${Date.now()}.csv"`);
      res.send(csv);
    } else {
      response(res, { format: 'json', exportedAt: new Date().toISOString(), count: data.length, data });
    }
  } catch (e) { next(e); }
});

// ----------------- V3: EVENT BUS / TIMELINE -----------------
app.get('/api/v1/events', async (req, res, next) => {
  try {
    const since = req.query.since ? Number(req.query.since) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sort = ['asc', 'desc'].includes(String(req.query.sort || '').toLowerCase()) ? String(req.query.sort).toLowerCase() : 'desc';
    const result = eventBus.list({
      limit,
      offset,
      category: req.query.category,
      severity: req.query.severity,
      stationId: req.query.stationId,
      type: req.query.type,
      since: Number.isFinite(since) ? since : undefined,
      search: req.query.search || undefined,
      after: req.query.after || undefined,
      before: req.query.before || undefined,
      sort,
    });
    response(res, result.items, {
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      sort,
      latestSeq: eventBus.latestSeq(),
      since: Number.isFinite(since) ? since : null,
    });
  } catch (e) { next(e); }
});

app.get('/api/v1/events/meta', (req, res, next) => {
  try {
    response(res, {
      categories: eventBus.categories(),
      types: eventBus.types(),
      stationIds: eventBus.stationIds(),
      total: eventBus.count(),
    });
  } catch (e) { next(e); }
});

app.get('/api/v1/events/:id', authRequired, (req, res, next) => {
  try {
    const ev = eventBus.get(req.params.id);
    if (!ev) return res.status(404).json({ success: false, error: { message: 'Event not found' }, timestamp: new Date().toISOString() });
    response(res, ev);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION WORKFLOW -----------------
app.get('/api/v1/investigations', async (req, res, next) => {
  try {
    const result = investigation.list({
      stationId: req.query.stationId,
      state: req.query.state,
      search: req.query.search,
      severity: req.query.severity,
      startTime: req.query.startTime,
      endTime: req.query.endTime,
      sort: req.query.sort || 'updatedAt',
      order: req.query.order || 'desc',
      limit: req.query.limit ? Math.min(Number(req.query.limit), 200) : undefined,
      offset: req.query.offset ? Math.max(Number(req.query.offset), 0) : undefined,
    });
    response(res, result.items, { total: result.total, offset: result.offset, limit: result.limit });
  } catch (e) { next(e); }
});

app.get('/api/v1/investigations/:id', async (req, res, next) => {
  try {
    const rec = investigation.get(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.create(req.body || {});
    await (async () => {
      try { await operations.addAudit({ actor: req.user.username, action: 'create', resource: 'investigation', resourceId: rec.id, newValue: rec }); } catch (_) {}
    })();
    response(res, rec, { status: 201 });
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/transition', authRequired, async (req, res, next) => {
  try {
    const nextState = req.body?.state;
    const notes = req.body?.notes || '';
    const rec = investigation.transition(req.params.id, nextState, req.user.username, notes);
    if (!rec) return res.status(400).json({ success: false, error: { message: 'Invalid transition or investigation not found' } });
    await operations.addAudit({ actor: req.user.username, action: 'transition', resource: 'investigation', resourceId: rec.id, newValue: { state: nextState, notes } });
    io.emit('investigation:updated', rec);
    eventBus.publish({ type: 'investigation.updated', category: 'anomaly', severity: 'info', stationId: rec.stationId, title: `Investigation → ${nextState}`, payload: { id: rec.id } });
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/notes', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.addNote(req.params.id, req.user.username, req.body?.notes || '');
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/step', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.transition(req.params.id, req.body?.state || 'investigating', req.user.username, req.body?.notes || '');
    if (!rec) return res.status(400).json({ success: false, error: { message: 'Invalid transition or investigation not found' } });
    const stageName = String(req.body?.stage || req.body?.state || 'INVESTIGATING').toUpperCase();
    rec.timeline.push({ stage: stageName, at: new Date().toISOString(), status: 'completed' });
    await audit(req, { action: 'investigation.step', resource: 'investigation', resourceId: rec.id, newValue: { state: rec.state, stage: stageName } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/resolve', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.transition(req.params.id, 'resolved', req.user.username, req.body?.resolution || 'Resolved by operator');
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    rec.resolution = req.body?.resolution || 'Resolved by operator';
    rec.timeline.push({ stage: 'RESOLVED', at: new Date().toISOString(), status: 'completed' });
    await audit(req, { action: 'investigation.resolve', resource: 'investigation', resourceId: rec.id, newValue: { resolution: rec.resolution } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/start', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.start(req.params.id, req.user.username, req.body?.notes || 'Investigation started');
    if (!rec) return res.status(400).json({ success: false, error: { message: 'Investigation not found or invalid transition' } });
    rec.timeline.push({ stage: 'STARTED', at: new Date().toISOString(), status: 'completed' });
    await audit(req, { action: 'investigation.start', resource: 'investigation', resourceId: rec.id, newValue: { state: rec.state } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/close', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.close(req.params.id, req.user.username, req.body?.notes || 'Investigation closed');
    if (!rec) return res.status(400).json({ success: false, error: { message: 'Investigation not found or invalid transition' } });
    rec.timeline.push({ stage: 'CLOSED', at: new Date().toISOString(), status: 'completed' });
    await audit(req, { action: 'investigation.close', resource: 'investigation', resourceId: rec.id, newValue: { state: rec.state } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/reopen', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.reopen(req.params.id, req.user.username, req.body?.notes || 'Investigation reopened');
    if (!rec) return res.status(400).json({ success: false, error: { message: 'Investigation not found or cannot be reopened' } });
    rec.timeline.push({ stage: 'REOPENED', at: new Date().toISOString(), status: 'completed' });
    await audit(req, { action: 'investigation.reopen', resource: 'investigation', resourceId: rec.id, newValue: { state: rec.state } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION EVIDENCE COLLECTION -----------------

app.get('/api/v1/investigations/:id/evidence/sources', async (req, res, next) => {
  try {
    const sources = investigation.getEvidenceSources(req.params.id);
    if (!sources.available && sources.reason === 'Investigation not found') {
      return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    }
    response(res, sources);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/evidence', authRequired, async (req, res, next) => {
  try {
    const { source, sourceId, data, type = 'OBSERVED', relatedAlertId, relatedAnomalyId } = req.body || {};
    if (!source) return res.status(400).json({ success: false, error: { message: 'source is required' } });

    const rec = investigation.addEvidence(req.params.id, {
      source,
      sourceId,
      stationId: req.body.stationId,
      timestamp: req.body.timestamp,
      data,
      type,
      relatedAlertId,
      relatedAnomalyId,
    });

    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    await audit(req, { action: 'investigation.evidence.added', resource: 'investigation', resourceId: rec.id, newValue: { source, sourceId } });
    io.emit('investigation:updated', rec);
    io.emit('investigation:evidence', { investigationId: rec.id, source, evidenceId: rec.evidence[rec.evidence.length - 1]?.id });
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION FINDINGS -----------------

app.post('/api/v1/investigations/:id/findings', authRequired, async (req, res, next) => {
  try {
    const { type, cause, confidence, evidenceRefs, notes } = req.body || {};
    if (!type || !cause) return res.status(400).json({ success: false, error: { message: 'type and cause are required' } });

    const rec = investigation.addFinding(req.params.id, { type, cause, confidence, evidenceRefs: evidenceRefs || [], notes });
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    rec.timeline.push({ stage: 'ANALYSIS', at: new Date().toISOString(), status: 'completed', detail: { type } });
    investigation.advanceStage(req.params.id, 'analysis', req.user.username, { type });

    await audit(req, { action: 'investigation.finding.added', resource: 'investigation', resourceId: rec.id, newValue: { type, cause } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION RAG SOURCES -----------------

app.post('/api/v1/investigations/:id/sources', authRequired, async (req, res, next) => {
  try {
    const { sources } = req.body || {};
    if (!sources || !Array.isArray(sources)) return res.status(400).json({ success: false, error: { message: 'sources array is required' } });

    const rec = investigation.setSources(req.params.id, sources);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    await audit(req, { action: 'investigation.sources.set', resource: 'investigation', resourceId: rec.id, newValue: { count: sources.length } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION ACTIONS (with ApprovalGateway) -----------------

app.post('/api/v1/investigations/:id/actions', authRequired, async (req, res, next) => {
  try {
    const { action, targetId, reason, requiresApproval } = req.body || {};
    if (!action) return res.status(400).json({ success: false, error: { message: 'action is required' } });

    const rec = investigation.addAction(req.params.id, {
      action,
      targetId,
      reason: reason || '',
      requiresApproval: !!requiresApproval,
      status: requiresApproval ? 'PENDING_APPROVAL' : 'PROPOSED',
    });

    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    const addedAction = rec.actions[rec.actions.length - 1];

    if (requiresApproval) {
      const approvalGateway = monitoring.getApprovalGateway();
      if (approvalGateway) {
        try {
          const proposal = approvalGateway.propose({
            action,
            targetId,
            reason: reason || `Investigation ${req.params.id}: ${action}`,
            evidence: [{ investigationId: req.params.id, actionId: addedAction.id }],
            proposedBy: req.user.username,
          });
          addedAction.approvalProposalId = proposal.id;
          investigation.updateAction(req.params.id, addedAction.id, { approvalProposalId: proposal.id });
        } catch (e) {
          console.error('Failed to create approval proposal:', e.message);
        }
      }
    } else {
      addedAction.status = 'APPROVED';
      investigation.updateAction(req.params.id, addedAction.id, { status: 'APPROVED' });
    }

    await audit(req, { action: 'investigation.action.proposed', resource: 'investigation', resourceId: rec.id, newValue: { action, targetId, requiresApproval } });
    io.emit('investigation:updated', rec);
    io.emit('investigation:action', { investigationId: rec.id, actionId: addedAction.id, action, status: addedAction.status });
    response(res, rec);
  } catch (e) { next(e); }
});

app.get('/api/v1/investigations/:id/actions/:actionId', async (req, res, next) => {
  try {
    const rec = investigation.get(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });
    const action = rec.actions.find((a) => a.id === req.params.actionId);
    if (!action) return res.status(404).json({ success: false, error: { message: 'Action not found' } });

    if (action.approvalProposalId) {
      const approvalGateway = monitoring.getApprovalGateway();
      if (approvalGateway) {
        const proposal = approvalGateway.getProposal(action.approvalProposalId);
        if (proposal) {
          action.approvalStatus = proposal.status;
          action.approvalResult = proposal.status === 'COMPLETED' ? proposal.result : null;
          action.verification = proposal.verification;
        }
      }
    }

    response(res, action);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION RECOMMENDATIONS & CONFIDENCE -----------------

app.post('/api/v1/investigations/:id/recommendations', authRequired, async (req, res, next) => {
  try {
    const { recommendations } = req.body || {};
    if (!recommendations || !Array.isArray(recommendations)) {
      return res.status(400).json({ success: false, error: { message: 'recommendations array is required' } });
    }

    const rec = investigation.setRecommendations(req.params.id, recommendations);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    investigation.advanceStage(req.params.id, 'recommendation', req.user.username, { count: recommendations.length });

    await audit(req, { action: 'investigation.recommendations.set', resource: 'investigation', resourceId: rec.id, newValue: { count: recommendations.length } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

app.post('/api/v1/investigations/:id/confidence', authRequired, async (req, res, next) => {
  try {
    const { value, label, basis } = req.body || {};
    const rec = investigation.setConfidence(req.params.id, { value, label, basis });
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION VERIFICATION -----------------

app.post('/api/v1/investigations/:id/verify', authRequired, async (req, res, next) => {
  try {
    const rec = investigation.get(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    const verificationEngine = monitoring.getVerificationEngine();
    if (!verificationEngine) {
      return res.status(503).json({ success: false, error: { message: 'Verification engine not available' } });
    }

    const ctx = monitoring.context || {};
    verificationEngine.updateContext({
      ...ctx,
      alertsDb,
      providers: providerRegistry,
      ml,
      thresholds: thresholdsStore,
      notifications,
      reports,
    });

    const verifications = [];
    for (const action of (rec.actions || [])) {
      if (action.status === 'EXECUTED' || action.status === 'COMPLETED') {
        const result = await verificationEngine.verifyAction(action.action, action.targetId, action.result);
        verifications.push({
          actionId: action.id,
          action: action.action,
          targetId: action.targetId,
          verification: result,
        });
      }
    }

    const overallSuccess = verifications.length === 0 || verifications.every((v) => v.verification?.success);

    const verificationResult = {
      success: overallSuccess,
      verifiedAt: new Date().toISOString(),
      verifiedBy: req.user.username,
      actionVerifications: verifications,
      investigationState: rec.state,
    };

    investigation.setVerification(req.params.id, verificationResult);
    investigation.advanceStage(req.params.id, 'verification', req.user.username, { success: overallSuccess });

    await audit(req, { action: 'investigation.verified', resource: 'investigation', resourceId: rec.id, newValue: verificationResult });
    io.emit('investigation:updated', rec);
    response(res, verificationResult);
  } catch (e) { next(e); }
});

// ----------------- V6: INVESTIGATION STAGE ADVANCEMENT -----------------

app.post('/api/v1/investigations/:id/stage', authRequired, async (req, res, next) => {
  try {
    const { stage, detail } = req.body || {};
    if (!stage) return res.status(400).json({ success: false, error: { message: 'stage is required' } });

    const rec = investigation.advanceStage(req.params.id, stage, req.user.username, detail || {});
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Investigation not found' } });

    await audit(req, { action: 'investigation.stage', resource: 'investigation', resourceId: rec.id, newValue: { stage } });
    io.emit('investigation:updated', rec);
    response(res, rec);
  } catch (e) { next(e); }
});

// ----------------- V6: ALERT CORRELATION (registered earlier to avoid /:id conflict) -----------------

// ----------------- V7: FORECAST -----------------
app.get('/api/v1/forecast/:stationId', async (req, res, next) => {
  try {
    const id = req.params.stationId;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);
    const horizon = Math.min(Number(req.query.horizon) || 30, 240);
    const readings = (await store.recentReadings(minutes)).filter((r) => r.stationId === id);
    const fc = forecastSvc.forecastAll(readings, horizon);
    response(res, { stationId: id, horizonMinutes: horizon, forecasts: fc });
  } catch (e) { next(e); }
});

// ----------------- V4: STATION DETAIL 2.0 -----------------
app.get('/api/v1/stations/:id', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const station = stationMap.get(id);
    const latest = (await store.latestPerStation()).find((r) => r.stationId === id) || null;
    const data = {
      ...station,
      latest,
      status: latest ? require('./stations').classify(latest) : 'offline',
      providerProbe: providerProbe(station),
      quality: latest?.source?.quality || (latest ? 'unknown' : 'unavailable'),
    };
    response(res, data, { _source: { endpoint: `/api/v1/stations/${id}`, stationId: id, generatedAt: new Date().toISOString(), source: latest ? (latest.source?.provider || 'unknown') : 'no_reading' } });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/telemetry', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const latest = (await store.latestPerStation()).find((r) => r.stationId === id) || null;
    const all = (await store.recentReadings(60)).filter((r) => r.stationId === id).sort((a, b) => new Date(a.time) - new Date(b.time));
    const fields = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'];
    const trends = {};
    for (const f of fields) {
      const points = all.map((r) => ({ t: r.time, v: r[f] }));
      const last = points[points.length - 1];
      const prev = points[points.length - 6] || points[0];
      trends[f] = {
        current: last ? last.v : null,
        delta: (last && prev) ? +(((last.v - prev.v) / Math.max(0.1, Math.abs(prev.v))) * 100).toFixed(2) : 0,
        points: analytics.downsample(points, 60),
      };
    }
    response(res, { stationId: id, fields, telemetry: trends, lastReading: latest, threshold: await operations.getConfig('thresholds') }, { _source: { endpoint: `/api/v1/stations/${id}/telemetry`, stationId: id, generatedAt: new Date().toISOString(), source: latest ? (latest.source?.provider || 'unknown') : 'no_reading' } });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/history', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const field = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const minutes = Math.min(Number(req.query.minutes) || 30, 7 * 24 * 60);
    const points = await store.history(id, field, minutes);
    response(res, analytics.downsample(points, Math.min(400, Math.max(50, points.length))), { stationId: id, field, minutes });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/health', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const station = stationMap.get(id);
    const readings = await store.recentReadings(60);
    const health = await stationHealthSvc.buildHealth(station, readings, store);
    response(res, health);
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/anomalies', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const minutes = Math.min(Number(req.query.minutes) || 24 * 60, 7 * 24 * 60);
    const readings = await store.recentReadings(minutes);
    const anomalies = readings.filter((r) => r.stationId === id && r.anomaly === 1).map((r) => ({
      ...paramCode(r), ...r, station: stationMap.get(r.stationId)?.name || r.stationId,
    }));
    response(res, anomalies, { count: anomalies.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/alerts', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const rows = await alertsDb.listAlerts({ stationId: id, limit: Math.min(Number(req.query.limit) || 50, 200) });
    response(res, rows, { count: rows.length });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/maintenance', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const history = await maintenance.getHistory(id);
    const list = maintenanceList.length ? maintenanceList.filter((m) => m.stationId === id) : [];
    const current = list[0] || null;
    response(res, { current, history, modelType: maintenance.MODEL_TYPE });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/comparison', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const field = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'].includes(req.query.field) ? req.query.field : 'temperature';
    const station = stationMap.get(id);
    const allStations = [...stationMap.values()];
    const latest = await store.latestPerStation();
    const latestByStation = new Map(latest.map((r) => [r.stationId, r]));
    const comparison = spatial.buildComparison(station, allStations, latestByStation, field);
    response(res, comparison);
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/timeline', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const station = stationMap.get(id);
    const result = await timeline.buildTimeline(id, station, store);
    response(res, result);
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/decision-trace', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const station = stationMap.get(id);
    const latest = (await store.latestPerStation()).find((r) => r.stationId === id) || null;
    const allStations = [...stationMap.values()];
    const latestByStation = new Map((await store.latestPerStation()).map((r) => [r.stationId, r]));
    const comparison = latest ? spatial.buildComparison(station, allStations, latestByStation, 'temperature') : { neighbours: [] };
    const readings = await store.recentReadings(60);
    const health = await stationHealthSvc.buildHealth(station, readings, store);
    let alert = null;
    try {
      const list = await alertsDb.listAlerts({ stationId: id, limit: 5 });
      alert = list.find((a) => !a.resolved) || list[0] || null;
    } catch (_) { alert = null; }
    const trace = decisionTrace.buildTrace(latest, station, comparison, health, alert);
    response(res, trace);
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/environmental', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);
    const station = stationMap.get(id);
    const allStations = [...stationMap.values()];
    const readings = (await store.recentReadings(minutes)).filter((r) => r.stationId === id);
    const fleet = await store.recentReadings(minutes);
    const mean = (field) => {
      const vals = fleet.filter((r) => r[field] != null).map((r) => r[field]);
      return vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null;
    };
    const localTrend = readings.length > 4 ? advancedAnalytics.crossParameterCorrelation(readings) : [];
    response(res, {
      station: { id, name: station.name, lat: station.lat, lon: station.lon },
      regionalMeans: {
        temperature: mean('temperature'),
        aqi: mean('aqi'),
        humidity: mean('humidity'),
        pressure: mean('pressure'),
        wind: mean('wind'),
        rainfall: mean('rainfall'),
      },
      localTrends: localTrend.slice(0, 6),
      stationCount: allStations.length,
      dominantCondition: readings.length ? (readings[readings.length - 1].anomaly ? 'anomalous' : 'nominal') : 'unknown',
    });
  } catch (e) { next(e); }
});

app.get('/api/v1/stations/:id/intelligence', async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
    const station = stationMap.get(id);
    const latest = (await store.latestPerStation()).find((r) => r.stationId === id) || null;
    const items = [];
    if (latest) items.push(intelligence.fromReading(latest, station));
    const m = maintenanceList.find((x) => x.stationId === id);
    if (m) items.push(intelligence.fromMaintenance(m));
    response(res, intelligence.dedupe(items.filter(Boolean)));
  } catch (e) { next(e); }
});

// ----------------- V10: INTELLIGENCE COMMAND CENTER -----------------
app.get('/api/v1/intelligence/situation', async (req, res, next) => {
  try {
    const now = Date.now();
    if (situationCache.data && (now - situationCache.time) < SITUATION_TTL_MS) {
      response(res, situationCache.data);
      return;
    }
    const [latest, alertsResult, providers, healthResult] = await Promise.all([
      latestStations(),
      alertsDb.alertStats(),
      operations.listProviders(),
      systemHealthSnapshot(),
    ]);
    const stationCount = latest.length;
    const critical = latest.filter((s) => s.status === 'critical').map((s) => ({ id: s.id, name: s.name, status: s.status, reasons: s.anomaly?.reasons || [] }));
    const warning = latest.filter((s) => s.status === 'warning');
    const offline = latest.filter((s) => s.status === 'offline');
    const result = {
      when: new Date().toISOString(),
      environment: {
        stationCount,
        criticalCount: critical.length,
        warningCount: warning.length,
        offlineCount: offline.length,
      },
      criticalStations: critical,
      activeAnomalies: latest.filter((s) => s.anomaly?.anomaly).slice(0, 8).map((s) => ({ station: s.name, stationId: s.id, reasons: s.anomaly?.reasons || [] })),
      openAlerts: alertsResult.open || 0,
      providerHealth: providers.map((p) => ({ id: p.id, name: p.name, status: p.status, configured: p.configurationState === 'CONFIGURED' })),
      systemHealth: healthResult.data.status,
    };
    situationCache.data = result;
    situationCache.time = now;
    response(res, result);
  } catch (e) { next(e); }
});

app.get('/api/v1/intelligence/what-changed', async (req, res, next) => {
  try {
    const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);
    const cutoff = Date.now() - minutes * 60_000;
    const items = eventBus.list({ limit: 200 }).filter((e) => new Date(e.timestamp).getTime() >= cutoff);
    response(res, items.slice(0, 60));
  } catch (e) { next(e); }
});

app.get('/api/v1/intelligence/why', async (req, res, next) => {
  try {
    const id = req.query.stationId;
    if (id) {
      if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
      const station = stationMap.get(id);
      const latest = (await store.latestPerStation()).find((r) => r.stationId === id) || null;
      const items = [];
      if (latest) items.push(intelligence.fromReading(latest, station));
      const m = maintenanceList.find((x) => x.stationId === id);
      if (m) items.push(intelligence.fromMaintenance(m));
      const recentAlerts = (await alertsDb.listAlerts({ stationId: id, limit: 5 })).slice(0, 3);
      for (const a of recentAlerts) items.push(intelligence.fromAlert(a));
      response(res, intelligence.dedupe(items.filter(Boolean)));
      return;
    }
    // Else: fleet-wide top root causes
    const latest = await latestStations();
    const items = latest.map((s) => intelligence.fromReading(s.reading, s)).filter(Boolean);
    response(res, intelligence.dedupe(items).slice(0, 25));
  } catch (e) { next(e); }
});

app.get('/api/v1/intelligence/what-next', async (req, res, next) => {
  try {
    const id = req.query.stationId;
    if (id) {
      if (!stationMap.has(id)) return res.status(404).json({ success: false, error: { message: 'Station not found' } });
      const minutes = Math.min(Number(req.query.minutes) || 60, 24 * 60);
      const horizon = Math.min(Number(req.query.horizon) || 30, 240);
      const readings = (await store.recentReadings(minutes)).filter((r) => r.stationId === id);
      const fc = forecastSvc.forecastAll(readings, horizon);
      const m = maintenanceList.find((x) => x.stationId === id);
      response(res, { stationId: id, forecasts: fc, maintenance: m });
      return;
    }
    // Fleet-wide: top stations at risk and predicted threshold crossings
    const out = [];
    for (const s of stations) {
      const readings = (await store.recentReadings(60)).filter((r) => r.stationId === s.id);
      const fc = forecastSvc.forecastAll(readings, 30);
      const crossings = Object.entries(fc).filter(([, v]) => v && v.thresholdCrossing).map(([k, v]) => ({ field: k, at: v.thresholdCrossing.at, threshold: v.thresholdCrossing.threshold }));
      if (crossings.length) out.push({ stationId: s.id, station: s.name, crossings });
    }
    response(res, out);
  } catch (e) { next(e); }
});

app.get('/api/v1/intelligence/what-to-do', async (req, res, next) => {
  try {
    const recommendations = [];
    const maintHigh = maintenanceList.filter((m) => m.riskScore > 70);
    for (const m of maintHigh.slice(0, 5)) recommendations.push({ priority: 'HIGH', action: m.recommendation, station: m.stationName || m.stationId, reason: `Risk score ${m.riskScore}` });
    const openAlerts = await alertsDb.listAlerts({ resolved: false, limit: 10 });
    for (const a of openAlerts) recommendations.push({ priority: a.severity === 'critical' ? 'HIGH' : 'MEDIUM', action: a.recommendation || 'Investigate', station: a.station, reason: a.title, alertId: a.id });
    const failedProviders = (await operations.listProviders()).filter((p) => p.status === 'RED');
    for (const p of failedProviders) recommendations.push({ priority: 'MEDIUM', action: `Update credentials for ${p.name}`, station: null, reason: p.lastError || 'Provider failing' });
    response(res, recommendations);
  } catch (e) { next(e); }
});

// ----------------- V9: GLOBAL SEARCH -----------------
app.get('/api/v1/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return response(res, []);
    const [alerts, anomalies, providers, audits, reportsList] = await Promise.all([
      alertsDb.listAlerts({ limit: 100 }),
      store.recentReadings(24 * 60),
      operations.listProviders(),
      operations.listAudits({ limit: 200 }),
      reports.list({ limit: 100 }),
    ]);
    const stationsLatest = await latestStations();
    const results = await searchSvc.search(q, {
      stations,
      alerts,
      anomalies: anomalies.filter((r) => r.anomaly === 1).map((r) => ({ ...paramCode(r), ...r, station: stationMap.get(r.stationId)?.name })),
      providers,
      maintenance: maintenanceList,
      reports: reportsList,
      audits,
      stationsLatest,
    });
    response(res, results);
  } catch (e) { next(e); }
});

// ----------------- V10: AI ASSISTANT 2.0 -----------------
app.post('/api/v1/assistant/v2', async (req, res, next) => {
  try {
    const query = (req.body?.query || '').trim();
    const queryLower = query.toLowerCase();
    const stationId = stations.find((station) => queryLower.includes(station.id.toLowerCase()) || queryLower.includes(station.name.toLowerCase()))?.id || null;
    const latest = await store.latestPerStation();
    const latestByStation = new Map(latest.map((reading) => [reading.stationId, reading]));
    const tools = {
      get_current_readings: async () => stations.map((station) => ({ stationId: station.id, station: station.name, reading: latestByStation.get(station.id) || null })),
      get_station: async ({ stationId }) => { const station = stationMap.get(stationId); return station ? { ...station, reading: latestByStation.get(stationId) || null } : null; },
      get_station_health: async ({ stationId }) => stationId && stationMap.has(stationId) ? stationHealthSvc.buildHealth(stationMap.get(stationId), (await store.recentReadings(60)), store) : null,
      get_station_history: async ({ stationId }) => stationId ? store.history(stationId, 'temperature', 24 * 60) : [],
      get_anomalies: async ({ stationId }) => stationId ? (await store.recentReadings(24 * 60)).filter((reading) => reading.stationId === stationId && reading.anomaly === 1) : [],
      get_nearby_stations: async ({ stationId }) => stationId ? spatial.buildComparison(stationMap.get(stationId), stations, latestByStation, 'temperature') : { neighbours: [] },
      get_provider_status: async () => operations.listProviders(),
      get_maintenance_risk: async ({ stationId }) => maintenanceList.filter((item) => !stationId || item.stationId === stationId),
      search_knowledge: async (params) => knowledge.search(params?.query || '', { topK: params?.topK || 5, stationId: params?.stationId || stationId }),
    };
    const result = await agentOrchestrator.run({ query, userId: req.user?.id, context: { stations, tools } });

    // Produce a genuinely useful, data-aware answer from live runtime state.
    // The orchestrator's answer is a thin template; assistant2.handle() renders
    // a rich, factual summary from the same evidence used by the orchestrator.
    // We keep the orchestrator's intent/evidence/sources for audit + realtime
    // and surface the richer text to the caller.
    const [alertsForAssist, allReadings] = await Promise.all([
      alertsDb.listAlerts({ limit: 200 }),
      store.recentReadings(24 * 60),
    ]);
    const assistCtx = assistant2.buildContext({
      stations,
      latest,
      alerts: {
        open: alertsForAssist.filter((a) => !a.resolved).length,
        list: alertsForAssist,
      },
      providers: await operations.listProviders(),
      maintenance: {
        high: maintenanceList.filter((m) => m.riskScore > 70).length,
        list: maintenanceList,
      },
      quality: qualitySnapshot,
      correlation: correlation.correlate(alertsForAssist, allReadings),
      investigations: investigation.list({}),
      events: allReadings
        .filter((r) => r.anomaly === 1)
        .slice(0, 8)
        .map((r) => ({ type: 'anomaly', title: `Anomaly at ${stationMap.get(r.stationId)?.name || r.stationId}`, station: stationMap.get(r.stationId)?.name || r.stationId, timestamp: r.time })),
    });
    const richReply = assistant2.handle(query, assistCtx);

    // Use LLM if available for a more natural response
    let llmUsed = false;
    let llmError = null;
    let llmStatus = 'unavailable';
    let llmMode = 'DETERMINISTIC_FALLBACK';
    if (llmProvider && llmProvider.id !== 'deterministic-fallback') {
      llmStatus = 'configured';
      llmMode = 'REAL_LLM';
      try {
        const systemPrompt = `You are SkyGuard AI Assistant, an expert environmental monitoring system.
Current fleet status:
- ${stations.length} stations monitored
- ${assistCtx.alerts.open} open alerts
- ${assistCtx.maintenance.high} stations at HIGH maintenance risk
${assistCtx.quality ? `- Data quality: ${assistCtx.quality.overallScore?.toFixed?.(1) || 'unknown'}%` : ''}

Provide a concise, helpful response based on the data provided. Format answers clearly.`;
        const userPrompt = `Question: ${query}

Evidence:
${richReply.text}

${result.knowledgeSources.length ? `Retrieved knowledge:\n${result.knowledgeSources.map((s) => `- ${s.section}: ${s.content?.slice(0, 200)}...`).join('\n')}` : ''}

Provide a natural, helpful answer.`;

        const llmResult = await llmProvider.chat({
          system: systemPrompt,
          user: userPrompt,
          maxTokens: llmProviderConfig.maxTokensPerCall,
        });

        if (llmResult.ok && llmResult.content) {
          result.answer = llmResult.content;
          llmUsed = true;
          llmStatus = 'real_llm';
          result.llmProvider = llmProvider.id;
          result.llmModel = llmResult.model || llmProvider.model;
        } else {
          llmError = llmResult.error || 'unknown error';
          llmStatus = 'llm_error';
          llmMode = 'DETERMINISTIC_FALLBACK';
          result.answer = richReply.text;
        }
      } catch (e) {
        llmError = e.message;
        llmStatus = 'llm_error';
        llmMode = 'DETERMINISTIC_FALLBACK';
        result.answer = richReply.text;
      }
    } else {
      result.answer = richReply.text;
      llmStatus = 'unavailable';
      llmMode = 'DETERMINISTIC_FALLBACK';
    }

    await operations.addAudit({ actor: req.user?.username || 'assistant', action: 'agent.run', resource: 'agent_run', resourceId: result.requestId, newValue: { intent: result.intent, status: result.plan.status, llmUsed, llmError: llmError || null } });
    for (const toolCall of result.toolCalls) {
      const auditEvent = { actor: req.user?.username || 'assistant', action: 'agent.tool', resource: 'agent_tool', resourceId: toolCall.tool, newValue: { requestId: result.requestId, status: toolCall.status, latency: toolCall.latency }, result: toolCall.status === 'completed' ? 'SUCCESS' : 'FAILED' };
      await operations.addAudit(auditEvent);
      await operations.addAudit({ ...auditEvent, action: 'tool_call' });
    }
    if (result.knowledgeSources.length) await operations.addAudit({ actor: req.user?.username || 'assistant', action: 'agent.rag', resource: 'knowledge', resourceId: result.requestId, newValue: { count: result.knowledgeSources.length } });
    io.emit('agent:completed', { requestId: result.requestId, intent: result.intent, toolCalls: result.toolCalls.map((call) => ({ tool: call.tool, status: call.status })) });
    if (result.intent === 'investigate_first' && stationId) {
      const rec = investigation.create({ stationId, title: `Investigation: ${query}`, evidence: result.liveEvidence, sources: result.knowledgeSources, recommendations: result.recommendations, confidence: result.confidence, agent: 'supervisor' });
      await operations.addAudit({ actor: req.user?.username || 'assistant', action: 'agent.investigation.created', resource: 'investigation', resourceId: rec.id, newValue: rec });
      io.emit('agent:investigation.created', { requestId: result.requestId, investigation: rec });
      result.investigation = rec;
    }
    response(res, { ...result, text: result.answer, evidence: result.liveEvidence, sources: result.knowledgeSources.length ? result.knowledgeSources : result.toolCalls.map((call) => ({ type: 'live_data', tool: call.tool, status: call.status })), actionsAvailable: [], requiresConfirmation: result.approvalRequired, toolCalls: result.toolCalls.map((call) => ({ name: call.tool, class: call.tool === 'search_knowledge' ? 'read_only' : 'read_only', status: call.status, durationMs: call.latency })), llmStatus, llmMode, llmUsed, llmProvider: llmUsed ? result.llmProvider : null, llmModel: llmUsed ? result.llmModel : null, llmError: llmError || null });
  } catch (e) { next(e); }
});

app.get('/api/v1/assistant/llm-status', async (req, res) => {
  try {
    const configured = llmProvider && llmProvider.id !== 'deterministic-fallback';
    const status = {
      configured,
      provider: llmProvider ? llmProvider.id : 'none',
      mode: configured ? 'REAL_LLM' : 'DETERMINISTIC_FALLBACK',
      available: configured,
      note: configured ? 'Real LLM provider is configured and will be used for queries.' : 'No real LLM provider configured. Assistant operates in deterministic fallback mode for live data queries. Configure OPENAI_API_KEY, AZURE_OPENAI_*, or OLLAMA_* to enable real LLM inference.',
    };
    response(res, status);
  } catch (e) { next(e); }
});

app.get('/api/v1/agent/tools', (req, res) => response(res, Object.values(TOOL_REGISTRY)));
app.get('/api/v1/knowledge/documents', (req, res) => response(res, knowledge.list(), knowledge.stats()));
app.get('/api/v1/knowledge/search', (req, res) => response(res, knowledge.search(req.query.q || '', { topK: req.query.topK, category: req.query.category, stationId: req.query.stationId, parameter: req.query.parameter })));
app.post('/api/v1/knowledge/documents', authRequired, async (req, res, next) => {
  try { const doc = knowledge.ingest(req.body || {}); await audit(req, { action: 'knowledge.ingest', resource: 'knowledge_document', resourceId: doc.id, newValue: doc }); response(res, doc); } catch (e) { next(e); }
});
app.get('/api/v1/agent/actions', authRequired, (req, res) => response(res, agentActions.list()));
app.post('/api/v1/agent/actions', authRequired, async (req, res, next) => {
  try {
    if (!['analyst', 'admin'].includes(req.user.role)) return res.status(403).json({ success: false, error: { message: 'Forbidden: action permission required' } });
    const proposal = agentActions.propose(req.body || {});
    await audit(req, { action: 'agent.action.proposed', resource: 'agent_action', resourceId: proposal.id, newValue: proposal });
    io.emit('agent:action.proposed', proposal);
    response(res, proposal);
  } catch (e) { res.status(400).json({ success: false, error: { message: e.message } }); }
});
app.post('/api/v1/agent/actions/:id/reject', authRequired, async (req, res, next) => {
  try {
    if (!['analyst', 'admin'].includes(req.user.role)) return res.status(403).json({ success: false, error: { message: 'Forbidden: action permission required' } });
    const proposal = agentActions.reject(req.params.id, req.user.username);
    if (!proposal) return res.status(404).json({ success: false, error: { message: 'Pending action not found' } });
    await audit(req, { action: 'agent.action.rejected', resource: 'agent_action', resourceId: proposal.id, newValue: proposal });
    io.emit('agent:action.rejected', proposal);
    response(res, proposal);
  } catch (e) { next(e); }
});
app.post('/api/v1/agent/actions/:id/approve', authRequired, async (req, res, next) => {
  try {
    if (!['analyst', 'admin'].includes(req.user.role)) return res.status(403).json({ success: false, error: { message: 'Forbidden: action permission required' } });
    const proposal = await agentActions.approve(req.params.id, req.user.username, {
      acknowledge_alert: (id, actor) => alertsDb.acknowledgeAlert(id, actor),
      resolve_alert: (id, actor) => alertsDb.resolveAlert(id, actor),
      verify: async (action, id) => {
        const alert = await alertsDb.getAlert(id);
        return { success: !!alert && (action === 'acknowledge_alert' ? !!alert.acknowledged : !!alert.resolved), observed: alert };
      },
    });
    if (!proposal) return res.status(404).json({ success: false, error: { message: 'Pending action not found' } });
    await audit(req, { action: 'agent.action.approved', resource: 'agent_action', resourceId: proposal.id, newValue: { status: proposal.status, verification: proposal.verification } });
    io.emit(proposal.status === 'COMPLETED' ? 'agent:action.completed' : 'agent:action.failed', proposal);
    response(res, proposal);
  } catch (e) { next(e); }
});

app.get('/api/v1/quality', async (req, res, next) => {
  try {
    const now = Date.now();
    if (qualitySnapshot && (now - qualitySnapshotTime) < QUALITY_SNAPSHOT_TTL_MS) {
      response(res, qualitySnapshot);
      return;
    }
    qualitySnapshot = await quality.computeSnapshot({ store, stations, lastTickAt });
    qualitySnapshotTime = now;
    response(res, qualitySnapshot);
  } catch (e) { next(e); }
});

app.get('/api/v1/quality/issues', async (req, res, next) => {
  try { response(res, await quality.issues()); } catch (e) { next(e); }
});

app.get('/api/v1/quality/history', async (req, res, next) => {
  try { response(res, await quality.history()); } catch (e) { next(e); }
});

app.get('/api/v1/ml/status', async (req, res, next) => {
  try {
    const s = await ml.status();
    response(res, s);
  } catch (e) { next(e); }
});

app.get('/api/v1/ml/metrics', async (req, res, next) => {
  try {
    const s = await ml.status();
    response(res, { metrics: s.metrics, modelType: s.modelType, lastRunAt: s.completedAt, status: s.status });
  } catch (e) { next(e); }
});

app.get('/api/v1/ml/performance', async (req, res, next) => {
  try {
    const s = await ml.status();
    response(res, { metrics: s.metrics, threshold: s.threshold, latency: s.latency, modelType: s.modelType, status: s.status, notes: s.notes });
  } catch (e) { next(e); }
});

app.get('/api/v1/ml/confusion-matrix', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.confusionMatrix || { matrix: [[0,0],[0,0]] }); } catch (e) { next(e); }
});
app.get('/api/v1/ml/roc', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.roc || { points: [], auc: 0 }); } catch (e) { next(e); }
});
app.get('/api/v1/ml/features', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.featureImportance || []); } catch (e) { next(e); }
});
app.get('/api/v1/ml/drift', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.drift || { score: 0, perField: {} }); } catch (e) { next(e); }
});
app.get('/api/v1/ml/latency', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.latency || {}); } catch (e) { next(e); }
});
app.get('/api/v1/ml/threshold', async (req, res, next) => {
  try { const s = await ml.status(); response(res, s.threshold || { state: 'UNKNOWN' }); } catch (e) { next(e); }
});
app.get('/api/v1/ml/runs', async (req, res, next) => {
  try { response(res, await ml.historyRuns()); } catch (e) { next(e); }
});
app.post('/api/v1/ml/validate', authRequired, async (req, res, next) => {
  try { const result = await ml.validate({ requestedBy: req.user.username }); await audit(req, { action: 'ml.validate', resource: 'ml_model', resourceId: 'current', newValue: { status: result.status, notes: result.notes } }); response(res, result); } catch (e) { next(e); }
});
app.post('/api/v1/ml/retrain', authRequired, roleRequired('admin'), async (req, res, next) => {
  try { const result = await ml.retrain({ requestedBy: req.user.username }); await audit(req, { action: 'ml.retrain', resource: 'ml_model', resourceId: 'current', newValue: { status: result.status, notes: result.notes, lastRunId: result.lastRunId } }); response(res, result); } catch (e) { next(e); }
});

app.get('/api/v1/reports', authRequired, async (req, res, next) => {
  try {
    const list = await reports.list({
      limit: Number(req.query.limit) || 100,
      category: req.query.category,
      status: req.query.status,
    });
    response(res, list, { count: list.length, categories: reports.CATEGORIES });
  } catch (e) { next(e); }
});

app.post('/api/v1/reports', authRequired, async (req, res, next) => {
  try {
    const params = { ...req.body, requestedBy: req.user.username };
    if (!params.category || !reports.CATEGORIES.includes(params.category)) {
      return res.status(400).json({ success: false, error: { message: `Invalid category. Allowed: ${reports.CATEGORIES.join(', ')}` } });
    }
    const result = await reports.generate(params, store, stations, stationMap, {
      maintenance: maintenanceList,
      quality: qualitySnapshot,
    });
    await audit(req, { action: 'generate', resource: 'report', resourceId: result.id, newValue: { category: result.category, status: result.status } });
    io.emit('report:new', { id: result.id, status: result.status, category: result.category });
    response(res, result);
  } catch (e) { next(e); }
});

app.get('/api/v1/reports/:id', authRequired, async (req, res, next) => {
  try {
    const rec = await reports.get(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Report not found' } });
    response(res, rec);
  } catch (e) { next(e); }
});

app.get('/api/v1/reports/:id/download', authRequired, async (req, res, next) => {
  try {
    const rec = await reports.get(req.params.id);
    if (!rec || !rec.filePath) return res.status(404).json({ success: false, error: { message: 'Report file not available' } });
    const filePath = path.join(reports.REPORTS_DIR, rec.filePath);
    const fs = require('fs');
    if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: { message: 'Report file missing on disk' } });
    const mime = rec.format === 'csv' ? 'text/csv' : 'application/json';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${rec.filePath}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { next(e); }
});

app.delete('/api/v1/reports/:id', authRequired, roleRequired('admin'), async (req, res, next) => {
  try {
    const oldValue = await reports.get(req.params.id);
    const ok = await reports.remove(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: { message: 'Report not found' } });
    await audit(req, { action: 'delete', resource: 'report', resourceId: req.params.id, oldValue });
    response(res, { id: req.params.id, deleted: true });
  } catch (e) { next(e); }
});

app.post('/api/v1/assistant', async (req, res, next) => {
  try {
    const current = await latestStations();
    const byCity = Object.fromEntries(current.map((item) => [item.name, item.reading]));
    const criticalStations = current.filter((item) => item.status === 'critical').map((item) => ({ name: item.name, reason: item.anomaly?.reasons?.[0] || 'threshold breach' }));
    const avgHealth = current.reduce((sum, item) => sum + item.healthScore, 0) / Math.max(1, current.length);
    response(res, handleQuery(req.body?.query, {
      latestByCity: byCity,
      latestByCityEntries: Object.entries(byCity),
      anomaliesToday: await store.anomalyCountToday(),
      recentCriticalName: criticalStations[0]?.name,
      criticalStations,
      avgHealth,
      quality: qualitySnapshot,
      maintenance: maintenanceList,
    }));
  } catch (e) { next(e); }
});

app.use('/api/v1/auth', authRoutes);

// ---- Notifications ----
app.get('/api/v1/notifications/channels', async (req, res, next) => {
  try { response(res, { types: notifications.listChannels(), channels: notifications.getChannels() }); }
  catch (e) { next(e); }
});
app.post('/api/v1/notifications/channels', authRequired, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.type) return res.status(400).json({ success: false, error: { message: 'type is required' } });
    const adapter = notifications.adapters[body.type];
    if (!adapter) return res.status(400).json({ success: false, error: { message: `Unsupported type: ${body.type}` } });
    const validation = adapter.validateConfig(body.credentials || {});
    if (!validation.valid) return res.status(400).json({ success: false, error: { message: `Invalid config: ${validation.errors.join(', ')}` } });
    const channel = notifications.upsertChannel(body);
    await audit(req, { action: 'upsert', resource: 'notification_channel', resourceId: channel.id, newValue: { ...channel, credentials: '***' } });
    response(res, channel);
  } catch (e) { next(e); }
});
app.put('/api/v1/notifications/channels/:id', authRequired, async (req, res, next) => {
  try {
    const existing = notifications.getChannelRaw(req.params.id);
    if (!existing) return res.status(404).json({ success: false, error: { message: 'Channel not found' } });
    const body = { ...existing, ...req.body, id: existing.id };
    const adapter = notifications.adapters[body.type];
    if (!adapter) return res.status(400).json({ success: false, error: { message: `Unsupported type: ${body.type}` } });
    const merged = { ...existing, credentials: { ...(existing.credentials || {}) } };
    if (req.body?.credentials && typeof req.body.credentials === 'object') {
      for (const [k, v] of Object.entries(req.body.credentials)) {
        if (v !== null && v !== '' && !String(v).includes('*')) merged.credentials[k] = v;
      }
    }
    const validation = adapter.validateConfig(merged.credentials || {});
    if (!validation.valid) return res.status(400).json({ success: false, error: { message: `Invalid config: ${validation.errors.join(', ')}` } });
    const channel = notifications.upsertChannel({ ...body, credentials: merged.credentials });
    await audit(req, { action: 'update', resource: 'notification_channel', resourceId: channel.id });
    response(res, channel);
  } catch (e) { next(e); }
});
app.delete('/api/v1/notifications/channels/:id', authRequired, roleRequired('admin'), async (req, res, next) => {
  try {
    const ok = notifications.deleteChannel(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: { message: 'Channel not found' } });
    await audit(req, { action: 'delete', resource: 'notification_channel', resourceId: req.params.id });
    response(res, { id: req.params.id, deleted: true });
  } catch (e) { next(e); }
});
app.post('/api/v1/notifications/channels/:id/test', authRequired, async (req, res, next) => {
  try {
    const rec = await notifications.testChannel(req.params.id);
    if (!rec) return res.status(404).json({ success: false, error: { message: 'Channel not found' } });
    await audit(req, { action: 'test', resource: 'notification_channel', resourceId: req.params.id, newValue: rec });
    response(res, rec);
  } catch (e) { next(e); }
});
app.post('/api/v1/notifications/channels/:id/enable', authRequired, async (req, res, next) => {
  try {
    const c = notifications.setChannelEnabled(req.params.id, true);
    if (!c) return res.status(404).json({ success: false, error: { message: 'Channel not found' } });
    response(res, c);
  } catch (e) { next(e); }
});
app.post('/api/v1/notifications/channels/:id/disable', authRequired, async (req, res, next) => {
  try {
    const c = notifications.setChannelEnabled(req.params.id, false);
    if (!c) return res.status(404).json({ success: false, error: { message: 'Channel not found' } });
    response(res, c);
  } catch (e) { next(e); }
});
app.get('/api/v1/notifications', authRequired, async (req, res, next) => {
  try { response(res, notifications.getChannels()); } catch (e) { next(e); }
});
app.get('/api/v1/notifications/history', authRequired, async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const items = notifications.historyFor({ channelId: req.query.channelId, alertId: req.query.alertId, limit });
    response(res, items, { count: items.length });
  } catch (e) { next(e); }
});
app.post('/api/v1/notifications/alerts/:alertId/retry', authRequired, async (req, res, next) => {
  try { response(res, await notifications.retryAlert(req.params.alertId)); } catch (e) { next(e); }
});
app.get('/api/v1/notifications/dead-letter', authRequired, async (req, res, next) => {
  try { response(res, await notifications.deadLetter()); } catch (e) { next(e); }
});

// Serve the new modular frontend from /frontend, fall back to the legacy
// Html.html if requested explicitly.
const frontendDir = path.join(__dirname, '..', '..', 'frontend');
const legacyFile = path.join(__dirname, '..', '..', '..', 'Html.html');
app.get('/', (req, res) => {
  const fs = require('fs');
  let html = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
  // Inject the correct API base URL based on the request origin
  // This allows the frontend to work when backend runs on any port
  const apiBase = `${req.protocol}://${req.get('host')}`;
  html = html.replace(
    "window.SKYGUARD_API_BASE = 'http://localhost:4000';",
    `window.SKYGUARD_API_BASE = '${apiBase}';`
  );
  res.type('html').set('Content-Length', Buffer.byteLength(html)).end(html);
});
app.use(express.static(frontendDir));
app.get('/legacy.html', (req, res) => res.sendFile(legacyFile));

io.on('connection', (socket) => {
  const since = Number(socket.handshake.query && socket.handshake.query.since) || 0;
  socket.emit('system:update', { status: 'CONNECTED', time: new Date().toISOString(), server: 'skyguard', since });
  // Replay missed events from eventBus (durable on disk via dataStore)
  try {
    const replay = eventBus.list({ since, limit: 200 });
    for (const e of replay.items) socket.emit('event:replay', e);
  } catch (_) {}
  for (const evt of ['reading.created','anomaly.created','alert.created','quality.updated','maintenance.updated','provider.updated','investigation.created','investigation.updated']) {
    socket.on(evt, () => {});
  }
  socket.on('disconnect', () => {});
  socket.on('client:hello', (payload) => {
    try {
      const sinceAck = Number(payload && payload.since) || 0;
      const replay = eventBus.list({ since: sinceAck, limit: 200 });
      for (const e of replay.items) socket.emit('event:replay', e);
    } catch (_) {}
  });
});

app.use((error, req, res, next) => {
  console.error('request failed', error);
  res.status(500).json({ success: false, error: { message: error.message || 'Internal server error' }, timestamp: new Date().toISOString() });
});

// ----------------- V11: MONITORING LOOP -----------------
app.get('/api/v1/monitoring/status', (req, res) => {
  try {
    const status = monitoring.getStatus();
    response(res, status);
  } catch (e) {
    console.error('monitoring/status error:', e.message);
    response(res, { running: false, error: e.message, cycleCount: 0, lastCycleAt: null });
  }
});

app.get('/api/v1/monitoring/snapshot', (req, res) => {
  try {
    const snap = monitoring.getSnapshot();
    if (snap) {
      response(res, snap);
    } else {
      response(res, createSnapshot({ providers: [], ingestion: {}, dataQuality: {}, stations: [], anomalies: [], health: {}, alerts: [], maintenance: [], architecture: null, ml: null, rag: null, agent: null, latestByStation: new Map() }));
    }
  } catch (e) {
    console.error('monitoring/snapshot error:', e.message);
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

app.get('/api/v1/monitoring/snapshot-history', (req, res) => {
  const history = monitoring.getSnapshotHistory();
  const limit = Math.min(Number(req.query.limit) || 10, history.length);
  response(res, history.slice(-limit));
});

app.get('/api/v1/monitoring/events', (req, res) => {
  const events = monitoring.getEvents({ limit: Number(req.query.limit) || 100, category: req.query.category, severity: req.query.severity });
  response(res, events);
});

// ----------------- V11: AGENT SUPERVISOR -----------------
app.get('/api/v1/agent/supervisor', (req, res) => {
  try {
    const supervisor = monitoring.getAgentSupervisor();
    const status = supervisor.getAgentStatus();
    response(res, status);
  } catch (e) {
    console.error('agent/supervisor error:', e.message);
    response(res, { status: 'ERROR', error: e.message });
  }
});

app.get('/api/v1/agent/tasks', (req, res) => {
  try {
    const supervisor = monitoring.getAgentSupervisor();
    const active = supervisor.getActiveTasks();
    const completed = supervisor.getCompletedTasks();
    response(res, { active, completed });
  } catch (e) {
    console.error('agent/tasks error:', e.message);
    response(res, { active: [], completed: [], error: e.message });
  }
});

app.get('/api/v1/agent/tasks/:id', (req, res) => {
  const task = monitoring.getAgentSupervisor().getTask(req.params.id);
  if (!task) return res.status(404).json({ success: false, error: { message: 'Task not found' } });
  response(res, task);
});

// ----------------- V11: TOOL GATEWAY -----------------
app.get('/api/v1/agent/tools', (req, res) => {
  response(res, TOOL_REGISTRY);
});

app.get('/api/v1/agent/tools/:category', (req, res) => {
  const { category } = req.params;
  const tools = Object.values(TOOL_REGISTRY).filter((t) => t.category === category);
  response(res, tools);
});

// ----------------- V11: RAG PIPELINE -----------------
app.get('/api/v1/rag/documents', (req, res) => {
  response(res, monitoring.getRAGPipeline().getAllDocuments(), monitoring.getRAGPipeline().getStats());
});

app.get('/api/v1/rag/stats', (req, res) => {
  response(res, monitoring.getRAGPipeline().getStats());
});

app.post('/api/v1/rag/documents', authRequired, async (req, res, next) => {
  try {
    const doc = await monitoring.getRAGPipeline().ingestDocument(req.body || {});
    await operations.addAudit({ actor: req.user.username, action: 'rag.ingest', resource: 'rag_document', resourceId: doc.id, newValue: doc });
    io.emit('rag:document.ingested', doc);
    response(res, doc, { status: 201 });
  } catch (e) { next(e); }
});

app.get('/api/v1/rag/search', async (req, res) => {
  try {
    const result = await monitoring.getRAGPipeline().retrieve(req.query.q || '', { topK: Number(req.query.topK) || 5, category: req.query.category, stationId: req.query.stationId });
    response(res, result);
  } catch (e) { next(e); }
});

app.post('/api/v1/rag/reindex', authRequired, async (req, res, next) => {
  try {
    const stats = await monitoring.getRAGPipeline().reindex();
    await operations.addAudit({ actor: req.user.username, action: 'rag.reindex', resource: 'rag_index' });
    response(res, stats);
  } catch (e) { next(e); }
});

// ----------------- V11: APPROVAL GATEWAY -----------------
app.get('/api/v1/approval/proposals', (req, res) => {
  try {
    const proposals = monitoring.getApprovalGateway().listProposals();
    response(res, proposals);
  } catch (e) {
    console.error('approval/proposals error:', e.message);
    response(res, [], { error: e.message });
  }
});

app.get('/api/v1/approval/proposals/:id', (req, res) => {
  const proposal = monitoring.getApprovalGateway().getProposal(req.params.id);
  if (!proposal) return res.status(404).json({ success: false, error: { message: 'Proposal not found' } });
  response(res, proposal);
});

// Phase 3: PROPOSE endpoint — the symmetric counterpart to approve/reject.
// Without this, no caller could persist a proposal via HTTP and the audit
// flagged it as a BLOCKER.
app.post('/api/v1/approval/proposals', authRequired, async (req, res, next) => {
  try {
    const role = req.user && req.user.role;
    const requiredRole = monitoring.getApprovalGateway().getRequiredRole(req.body && req.body.action);
    const rank = { viewer: 1, analyst: 2, admin: 3 };
    if (!role || rank[role] < rank[requiredRole]) {
      return res.status(403).json({ success: false, error: { message: `Forbidden: ${requiredRole} required for ${req.body?.action}` } });
    }
    const proposal = monitoring.getApprovalGateway().propose({
      action: req.body?.action,
      targetId: req.body?.targetId || null,
      reason: req.body?.reason,
      evidence: req.body?.evidence || [],
      expectedImpact: req.body?.expectedImpact || '',
      proposedBy: req.user.username || 'api',
    });
    await audit(req, { action: 'approval.proposed', resource: 'approval', resourceId: proposal.id, newValue: proposal });
    io.emit('approval:proposed', proposal);
    response(res, proposal);
  } catch (e) { res.status(400).json({ success: false, error: { message: e.message } }); }
});

app.post('/api/v1/approval/proposals/:id/approve', authRequired, async (req, res, next) => {
  try {
    const proposal = await monitoring.getApprovalGateway().approve(req.params.id, req.user.username, {
      verify: (action, targetId, execution) => monitoring.getVerificationEngine().verifyAction(action, targetId, execution),
    });
    if (!proposal) return res.status(404).json({ success: false, error: { message: 'Proposal not found' } });
    await operations.addAudit({ actor: req.user.username, action: 'approval.approved', resource: 'approval', resourceId: proposal.id, newValue: proposal });
    io.emit('approval:approved', proposal);
    response(res, proposal);
  } catch (e) { next(e); }
});

app.post('/api/v1/approval/proposals/:id/reject', authRequired, async (req, res, next) => {
  try {
    const proposal = monitoring.getApprovalGateway().reject(req.params.id, req.user.username, req.body?.reason || '');
    if (!proposal) return res.status(404).json({ success: false, error: { message: 'Proposal not found' } });
    await operations.addAudit({ actor: req.user.username, action: 'approval.rejected', resource: 'approval', resourceId: proposal.id, newValue: proposal });
    io.emit('approval:rejected', proposal);
    response(res, proposal);
  } catch (e) { next(e); }
});

// ----------------- V11: VERIFICATION -----------------
app.get('/api/v1/verification/last', (req, res) => {
  const ve = monitoring.getVerificationEngine();
  const last = (ve && ve.lastVerification) || monitoring.getApprovalGateway().getLastVerification() || null;
  response(res, last || { success: false });
});

// ----------------- V11: AGENT MEMORY -----------------
app.get('/api/v1/agent/memory', (req, res) => {
  response(res, monitoring.getAgentMemory().getSessionStats());
});

app.get('/api/v1/agent/memory/investigations', (req, res) => {
  const out = [];
  monitoring.getAgentMemory().investigations.forEach((i) => out.push({ ...i }));
  response(res, out);
});

// ----------------- V11: GLOBAL INTELLIGENCE BRIEF -----------------
app.get('/api/v1/intelligence/brief', async (req, res, next) => {
  try {
    response(res, monitoring.buildBrief());
  } catch (e) { next(e); }
});

app.get('/api/v1/monitoring/brief', async (req, res, next) => {
  try {
    const brief = monitoring.buildBrief();
    response(res, brief);
  } catch (e) {
    console.error('monitoring/brief error:', e.message);
    res.status(500).json({ success: false, error: { message: e.message } });
  }
});

app.get('/api/v1/monitoring/events/stream', async (req, res, next) => {
  try {
    response(res, monitoring.getEvents({ limit: Number(req.query.limit) || 50, category: req.query.category, severity: req.query.severity }));
  } catch (e) { next(e); }
});

app.get('/api/v1/agent/timeline/:taskId', (req, res) => {
  const task = monitoring.getAgentSupervisor().getTask(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: { message: 'Task not found' } });
  response(res, { taskId: task.id, timeline: task.timeline || [], state: task.state });
});

app.get('/api/v1/agent/task-summary/:taskId', (req, res) => {
  const task = monitoring.getAgentSupervisor().getTask(req.params.taskId);
  if (!task) return res.status(404).json({ success: false, error: { message: 'Task not found' } });
  response(res, {
    taskId: task.id,
    eventType: task.eventType,
    severity: task.severity,
    stationId: task.stationId,
    state: task.state,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    evidenceCount: task.evidence.length,
    sourceCount: task.sources.length,
    rootCause: task.rootCause,
    confidence: task.confidence,
    recommendations: task.recommendations,
    actionProposals: task.actionProposals,
    verification: task.verification,
  });
});

app.post('/api/v1/monitoring/investigate', async (req, res, next) => {
  try {
    const { stationId, category, severity, title, summary } = req.body || {};
    const event = {
      id: `EVT-MANUAL-${Date.now()}-${randomUUID().slice(0, 6)}`,
      type: 'MANUAL.INVESTIGATE',
      category: category || 'station',
      severity: severity || 'HIGH',
      stationId: stationId || null,
      title: title || `Investigate ${stationId || 'system'}`,
      summary: summary || 'Manual investigation requested',
      evidence: { manual: true },
      timestamp: new Date().toISOString(),
      snapshotId: monitoring.getSnapshot()?.id || null,
    };
    const task = monitoring.getAgentSupervisor().triggerInvestigation(event, { stationId });
    io.emit('agent:investigation:created', { taskId: task.id, eventId: event.id, severity: event.severity, stationId });
    response(res, task);
  } catch (e) { next(e); }
});

// seedAndStart: initialise ingestion + monitoring. Called once at boot (or from tests).
async function seedAndStart() {
  try { setThresholds(await operations.getConfig('thresholds') || {}); } catch (_) {}
  if (config.pg.enabled) {
    try { await stationsDb.upsertStations(stations); } catch (e) { console.error('station seed failed', e.message); }
  }
  const { tickReading } = require('./stations');
  const allowSimulatorFallback = process.env.NODE_ENV !== 'production';
  if (!store.readings || store.readings.length === 0) {
    // The simulator is only an allowed first-paint fallback in non-production.
    // In production the system must NOT emit synthetic telemetry. Real provider
    // failure in production is surfaced as `provider: 'none'`, quality:
    // 'unavailable', so the dashboard reports YELLOW/RED rather than GREEN with
    // fabricated data.
    for (let offset = 10; offset >= 0; offset -= 1) {
      for (const station of stations) {
        const t = new Date(Date.now() - offset * 30_000).toISOString();
        let reading = null;
        try {
          reading = await Promise.race([
            fetchRealReading(station, t),
            new Promise((_, rej) => setTimeout(() => rej(new Error('seed_timeout')), 2500)),
          ]);
        } catch (e) {
          if (allowSimulatorFallback) reading = { ...tickReading(station, Math.floor(Date.now() / 1000)), time: t };
        }
        if ((!reading || reading.source?.provider === 'none' || reading.temperature == null) && allowSimulatorFallback) {
          reading = { ...tickReading(station, Math.floor(Date.now() / 1000)), time: t };
        }
        if (reading) await processReading(reading);
      }
    }
  }
  timer = setInterval(async () => {
    // Test-only escape hatch: when a test has paused ingestion we must not
    // overwrite the deterministic readings it has just pushed. This is a
    // synchronous early-return so no promise is created.
    if (ingestionPaused) return;
    try {
      for (const station of stations) {
        let reading = null;
        try {
          reading = await Promise.race([
            fetchRealReading(station),
            new Promise((_, rej) => setTimeout(() => rej(new Error('tick_timeout')), 3000)),
          ]);
        } catch (e) {
          reading = await fetchRealReading(station);
          if ((!reading || reading.source?.provider === 'none' || reading.temperature == null) && allowSimulatorFallback) {
            reading = { ...tickReading(station, Math.floor(Date.now() / 1000)), time: new Date().toISOString() };
          }
        }
        if ((!reading || reading.source?.provider === 'none' || reading.temperature == null) && allowSimulatorFallback) {
          reading = { ...tickReading(station, Math.floor(Date.now() / 1000)), time: new Date().toISOString() };
        }
        await processReading(reading);
      }
    } catch (e) { console.error('ingestion tick failed', e.message); }
  }, config.sim.tickMs);

  setInterval(async () => {
    try { qualitySnapshot = await quality.computeSnapshot({ store, stations, lastTickAt }); } catch (e) { console.error('quality snapshot failed', e.message); }
    try { maintenanceList = await maintenance.computeAndPersistAll(stations, store); } catch (e) { console.error('maintenance compute failed', e.message); }
    const dash = await dashboard();
    io.emit('dashboard:update', dash);
    io.emit('quality:update', qualitySnapshot);
    io.emit('maintenance:update', maintenanceList);
    try {
      const mlResult = await ml.evaluate({ requestedBy: 'system-bootstrap' });
      monitoring.updateContext({ ...monitoring.context, mlStatus: mlResult });
    } catch (_) {}
    try {
      const ragStats = monitoring.getRAGPipeline().getStats();
      monitoring.updateContext({ ...monitoring.context, knowledgeStats: ragStats });
    } catch (_) {}
    try {
      const providers = await operations.listProviders();
      monitoring.updateContext({ ...monitoring.context, providers });
    } catch (_) {}
    try {
      const arch = await architecture.snapshot({ store, io, lastTickAt, ml, providers: await operations.listProviders(), startedAt, tickCount });
      monitoring.updateContext({ ...monitoring.context, architecture: arch });
    } catch (_) {}
    try {
      const invList = investigation.list();
      monitoring.updateContext({ ...monitoring.context, investigations: new Map(invList.map((i) => [i.id, i])) });
    } catch (_) {}
  }, 10_000);

  setTimeout(async () => {
    try { qualitySnapshot = await quality.computeSnapshot({ store, stations, lastTickAt }); } catch (e) { console.error('quality bootstrap failed', e.message); }
    try { maintenanceList = await maintenance.computeAndPersistAll(stations, store); } catch (e) { console.error('maintenance bootstrap failed', e.message); }
    try { await ml.evaluate({ requestedBy: 'system-bootstrap' }); } catch (e) { console.error('ml bootstrap failed', e.message); }
  }, 2000);

  // Start the monitoring loop
  monitoring.updateContext({ ...monitoring.context, io });
  const supervisor = monitoring.getAgentSupervisor();
  const approvalGateway = monitoring.getApprovalGateway();
  const verificationEngine = monitoring.getVerificationEngine();
  const ragPipeline = monitoring.getRAGPipeline();

  const fs = require('fs');
  const path = require('path');
  const knowledge = require('./services/knowledge');
  async function loadKnowledgeIntoRAG() {
    try {
      const docs = knowledge.list();
      let ingested = 0;
      let skipped = 0;
      for (const doc of docs) {
        if (ragPipeline.getDocument(doc.id)) { skipped++; continue; }
        const filePath = path.join(knowledge.DOCS_DIR, doc.fileName);
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content.trim()) continue;
        try {
          await ragPipeline.ingestDocument({
            name: doc.name,
            content,
            source: doc.source || 'bundled_project_documentation',
            version: doc.version,
            date: doc.date,
            category: doc.category || 'SYSTEM',
          });
          ingested++;
        } catch (e) { console.error(`[rag] ingest failed for ${doc.name}: ${e.message}`); }
      }
      if (ingested > 0 || skipped > 0) console.error(`[rag] startup: ${ingested} ingested, ${skipped} already present`);
    } catch (e) { console.error('[rag] startup loader error:', e.message); }
  }
  await loadKnowledgeIntoRAG();

  supervisor.setIO(io);
  supervisor.setEventBus(eventBus);
  supervisor.setAudit(auditModule);
  supervisor.setApprovalGateway(approvalGateway);
  supervisor.setVerificationEngine(verificationEngine);
  supervisor.setRAGPipeline(ragPipeline);
  // Default role for tool calls driven by the supervisor: viewer (read-only
  // tools). Mutation proposals are routed through ApprovalGateway so the
  // mutation's executor runs as the approving user, not as the supervisor.
  supervisor.setDefaultRole('viewer');
  verificationEngine.updateContext({ ...monitoring.context, alertsDb, providers: providerRegistry, ml, thresholds: thresholdsStore, notifications, reports });
  verificationEngine._gateway = approvalGateway;

  // Register executors on the ApprovalGateway. Each executor calls into the
  // toolGateway mutation handlers so the path is the same as for direct
  // agent tool calls (Phase 1). Verification is delegated to the
  // VerificationEngine, which independently re-reads system state (Phase 6).
  const executorCtx = {
    ...monitoring.context,
    alertsDb,
    providers: providerRegistry,
    ml,
    thresholds: thresholdsStore,
    notifications,
    reports,
    store,
    stations,
    stationMap,
    stationHealthSvc,
    ragPipeline,
    maintenanceHistory: { list: ({ stationId } = {}) => (maintenanceList || []).filter((m) => !stationId || m.stationId === stationId) },
  };
  const { executeTool } = require('./services/toolGateway');
  const mutationActions = [
    'acknowledge_alert', 'resolve_alert', 'reopen_alert', 'mute_alert', 'unmute_alert', 'escalate_alert',
    'run_health_check', 'run_anomaly_analysis', 'generate_report', 'test_provider',
    'update_threshold', 'update_provider', 'update_notification_config', 'retrain_model',
  ];
  for (const action of mutationActions) {
    approvalGateway.registerExecutor(action, async (targetId, actor, proposal) => {
      const params = { ...(proposal && proposal.params ? proposal.params : {}) };
      if (targetId !== undefined && params.alertId === undefined && params.stationId === undefined && params.providerId === undefined) {
        if (['acknowledge_alert', 'resolve_alert', 'reopen_alert', 'mute_alert', 'unmute_alert', 'escalate_alert'].includes(action)) params.alertId = targetId;
        else if (['run_health_check', 'run_anomaly_analysis'].includes(action)) params.stationId = targetId;
        else if (action === 'test_provider' || action === 'update_provider') params.providerId = targetId;
        else if (action === 'update_threshold') params.parameter = targetId;
      }
      if (actor && !params.resolvedBy && !params.acknowledgeBy && !params.requestedBy) {
        if (action === 'acknowledge_alert') params.acknowledgeBy = actor;
        else if (action === 'resolve_alert') params.resolvedBy = actor;
      }
      const env = await executeTool(action, params, executorCtx, 'admin', { timeoutMs: 30000 });
      return {
        ok: env.status === 'completed',
        observation: env.observation || env.result || null,
        verified: env.verified === true && env.status === 'completed',
        sideEffect: env.result || null,
      };
    });
  }
  monitoring.start();

  setInterval(() => {
    try { io.emit('intelligence:brief', monitoring.buildBrief()); } catch (e) { console.error('brief emit failed', e.message); }
  }, 5000);

  console.log('[MonitoringLoop] started');
}

async function bootstrap() {
  if (config.pg.enabled) {
    pg.init(config.pg);
    const up = await pg.ping();
    if (up) {
      console.log('[pg] connected');
      try {
        await adoptPostgres();
      } catch (e) { console.error('[pg] init failed', e.message); }
    } else {
      // Stay configured (RED in the architecture view) instead of silently
      // disabling PostgreSQL on a transient boot-time outage. The in-memory
      // admin is seeded so auth still works, and the pool re-adopts
      // PostgreSQL automatically once it recovers.
      console.warn('[pg] not reachable at boot; PostgreSQL stays configured and will re-adopt on recovery');
      await usersDb.initFromEnv(config.auth);
      pg.onRecovered(() => {
        adoptPostgres()
          .then(() => console.log('[pg] recovered; schema/admin/stations re-adopted'))
          .catch((e) => console.error('[pg] recovery re-adoption failed', e.message));
      });
    }
  } else {
    await usersDb.initFromEnv(config.auth);
  }
}

// Adopt PostgreSQL as the relational store: apply the schema, seed the admin
// account and stations. Idempotent (schema uses IF NOT EXISTS), so it is safe
// to re-run after a recovery.
async function adoptPostgres() {
  const { ensureSchema } = require('./db/schema');
  await ensureSchema(pg);
  await usersDb.initFromEnv(config.auth);
  try { await stationsDb.upsertStations(stations); } catch (e) { console.error('[pg] station seed failed', e.message); }
}

if (require.main === module) {
  // Start listening immediately so health endpoints respond while seeding
  // happens in the background. This avoids blocking the readiness probe on
  // slow provider calls (each station × offset can take up to the provider
  // timeout, so listen-first guarantees /api/v1/health becomes available
  // within milliseconds instead of after the entire seed loop completes).
  bootstrap()
    .then(() => {
      return new Promise((resolve) => {
        server.listen(config.port, () => {
          console.log(`SkyGuard backend listening on http://localhost:${config.port}`);
          resolve();
        });
      });
    })
    .then(() => {
      // Fire-and-forget: do not await seedAndStart() so the listening socket
      // remains healthy even if a slow provider chain is in the middle of
      // timing out. Errors are still surfaced via the tick interval.
      seedAndStart().catch((e) => console.error('seedAndStart failed', e?.message || e));
    })
    .catch((e) => { console.error('startup failed', e); process.exitCode = 1; });
}

module.exports = {
  app,
  server,
  io,
  store,
  stations,
  stationMap,
  processReading,
  seedAndStart,
  monitoring,
  setIngestionPaused: (v) => { ingestionPaused = !!v; },
};
