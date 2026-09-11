'use strict';

const pg = require('../db/pg');

function timeit() {
  const t0 = process.hrtime.bigint();
  return () => Number(process.hrtime.bigint() - t0) / 1e6;
}

function statusFor(s, enabled) {
  if (!enabled) return 'GRAY';
  if (s === 'UP') return 'GREEN';
  if (s === 'DEGRADED') return 'YELLOW';
  if (s === 'DOWN') return 'RED';
  return s;
}

async function checkMemoryStore(store) {
  const t = timeit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const ok = await Promise.race([
      store.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping_timeout')), 4000)),
    ]);
    clearTimeout(timer);
    return { status: ok ? 'UP' : 'DOWN', latencyMs: +t().toFixed(2), error: ok ? null : 'store ping failed', engine: store.constructor.name };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message === 'ping_timeout' ? 'timeout' : e.message, engine: store.constructor.name };
  }
}

async function checkInflux(store) {
  if (!store.cfg || !store.cfg.url || !(store.cfg.enabled ?? true)) {
    return { status: 'DISABLED', latencyMs: 0, error: null, url: store.cfg?.url || null };
  }
  const t = timeit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(`${store.cfg.url}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return { status: r.ok ? 'UP' : 'DEGRADED', latencyMs: +t().toFixed(2), error: r.ok ? null : `status ${r.status}`, url: store.cfg.url };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.name === 'AbortError' ? 'timeout' : e.message, url: store.cfg.url };
  }
}

async function checkPostgres() {
  if (!pg.isConfigured()) {
    return { status: 'DISABLED', latencyMs: 0, error: null, configured: false };
  }
  const t = timeit();
  try {
    const ok = await pg.ping();
    return { status: ok ? 'UP' : 'DOWN', latencyMs: +t().toFixed(2), error: ok ? null : 'pg ping failed', configured: true };
  } catch (e) {
    return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message, configured: true };
  }
}

function checkSqlite() {
  // SkyGuard backend does not depend on SQLite; we surface its true state.
  return { status: 'DISABLED', latencyMs: 0, error: null, configured: false };
}

function checkWebSocket(io) {
  return {
    status: 'UP',
    connections: io.engine.clientsCount,
    latencyMs: null,
    error: null,
  };
}

function checkIngestion(lastTickAt) {
  if (!lastTickAt) return { status: 'STARTING', latencyMs: 0, error: 'no ticks yet' };
  const age = (Date.now() - new Date(lastTickAt).getTime()) / 1000;
  if (age < 30) return { status: 'UP', latencyMs: 0, error: null, lastTickSecondsAgo: +age.toFixed(2) };
  if (age < 120) return { status: 'DEGRADED', latencyMs: 0, error: 'tick delay', lastTickSecondsAgo: +age.toFixed(2) };
  return { status: 'DOWN', latencyMs: 0, error: 'no recent ticks', lastTickSecondsAgo: +age.toFixed(2) };
}

async function checkAnalytics(store) {
  const t = timeit();
  try {
    await store.recentReadings(1);
    return { status: 'UP', latencyMs: +t().toFixed(2), error: null };
  } catch (e) { return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message }; }
}

async function checkAnomalyEngine(store, paramCodeFn) {
  const t = timeit();
  try {
    const latest = (await store.recentReadings(1))[0];
    if (latest) paramCodeFn(latest);
    return { status: 'UP', latencyMs: +t().toFixed(2), error: null };
  } catch (e) { return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message }; }
}

async function checkAssistant() {
  const t = timeit();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const config = require('../config');
    const llmCfg = config.llm || {};
    const hasConfiguredLlm = llmCfg.provider && llmCfg.provider !== 'deterministic-fallback';

    if (hasConfiguredLlm) {
      const { OllamaProvider } = require('./llm');
      if (llmCfg.provider === 'ollama') {
        const ollama = new OllamaProvider({ baseUrl: llmCfg.ollamaBaseUrl || 'http://localhost:11434', model: llmCfg.ollamaModel || 'qwen2.5:7b' });
        const pingResult = await ollama.ping();
        clearTimeout(timer);
        if (pingResult.ok) {
          return {
            status: 'UP',
            latencyMs: +t().toFixed(2),
            error: null,
            mode: 'ollama',
            model: llmCfg.ollamaModel,
            provider: 'ollama',
          };
        } else {
          return {
            status: 'DOWN',
            latencyMs: +t().toFixed(2),
            error: `Ollama unreachable: ${pingResult.error}`,
            mode: 'ollama',
            model: llmCfg.ollamaModel,
            provider: 'ollama',
          };
        }
      }
      if (llmCfg.provider === 'openai' && llmCfg.openaiApiKey) {
        clearTimeout(timer);
        return { status: 'UP', latencyMs: +t().toFixed(2), error: null, mode: 'openai', model: llmCfg.openaiModel, provider: 'openai' };
      }
      if (llmCfg.provider === 'azure-openai' && llmCfg.azureOpenaiKey) {
        clearTimeout(timer);
        return { status: 'UP', latencyMs: +t().toFixed(2), error: null, mode: 'azure-openai', model: llmCfg.azureOpenaiDeployment, provider: 'azure-openai' };
      }
    }

    const assistant2 = require('./assistant2');
    assistant2.handle('What is happening right now?', {
      stations: [], latestByStation: new Map(), alerts: { open: 0, list: [] },
      providers: [], maintenance: { high: 0, list: [] }, quality: null,
      correlation: [], investigations: [], events: [],
    });
    clearTimeout(timer);
    return {
      status: hasConfiguredLlm ? 'DEGRADED' : 'DEGRADED',
      latencyMs: +t().toFixed(2),
      error: hasConfiguredLlm ? 'LLM configured but not reachable' : 'No semantic LLM configured; assistant runs in deterministic (template-based) mode.',
      mode: hasConfiguredLlm ? 'llm_unreachable' : 'deterministic',
    };
  } catch (e) {
    clearTimeout(timer);
    return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.name === 'AbortError' ? 'timeout' : e.message, mode: 'unavailable' };
  }
}

function checkReportService() {
  const t = timeit();
  try {
    require('./reports').CATEGORIES;
    return { status: 'UP', latencyMs: +t().toFixed(2), error: null };
  } catch (e) { return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message }; }
}

function checkMlService(mlSnap = {}) {
  // Use the canonical ML health function: getMlHealth()
  // This ensures the architecture ML node uses the canonical ML health result,
  // and it does NOT independently recalculate: model health, evaluation state, training state.
  // This satisfies Phase 7: THE IMPORTANT FIX.
  const { getMlHealth } = require('./ml');
  
  // Use the canonical ML health result - getMlHealth() uses deriveHealthFromState()
  // and handles all the logic for trained models, evaluation status, etc.
  const mlHealth = getMlHealth();
  
  // Map ML health to architecture service status
  let status;
  if (mlHealth === 'GREEN') status = 'UP';
  else if (mlHealth === 'RED') status = 'DOWN';
  else status = 'DEGRADED'; // YELLOW, GRAY, or unknown -> not fully operational
  
  let error = null;
  if (status === 'DOWN') {
    // For DOWN status, we can provide error info from mlSnap if available
    error = mlSnap.inferenceError || (mlSnap.notes ? `model service: ${mlSnap.notes}` : 'ML service: failed health check');
  } else if (status === 'DEGRADED') {
    // For DEGRADED status, provide relevant degradation info
    if (mlSnap.evaluationStatus === 'UNVERIFIED') {
      error = mlSnap.modelType === 'LOGISTIC_REGRESSION' || mlSnap.trainingState === 'trained'
        ? 'trained model: evaluation unverified (insufficient data)'
        : 'rule-based detector: no labeled evaluation data (metrics unavailable)';
    } else {
      error = `ML service: degraded (${mlHealth})`;
    }
  }
  
  return { status, latencyMs: null, error, modelType: mlSnap.modelType || 'UNKNOWN' };
}

async function checkNotificationService() {
  const t = timeit();
  try {
    const channels = require('./notifications').getChannels();
    return { status: 'UP', latencyMs: +t().toFixed(2), error: null, channels: channels.length, enabled: channels.filter((c) => c.enabled).length };
  } catch (e) { return { status: 'DOWN', latencyMs: +t().toFixed(2), error: e.message }; }
}

function rollup(components) {
  const vals = Object.values(components).map((c) => c.status);
  // Only consider required components for rollup; optional stay informational.
  const required = ['api', 'websocket', 'ingestion'];
  const requiredVals = required.map((k) => components[k]?.status).filter(Boolean);
  if (requiredVals.includes('DOWN')) return 'DOWN';
  if (requiredVals.includes('DEGRADED')) return 'DEGRADED';
  if (requiredVals.includes('STARTING')) return 'STARTING';
  if (vals.includes('DOWN')) return 'DEGRADED';
  return 'UP';
}

async function snapshot({ store, io, lastTickAt, ml, notifications, providers, qualitySnapshot, startedAt, tickCount }) {
  const labels = {
    api:'API', websocket:'WebSocket', memoryStore:'MemoryStore', sqlite:'SQLite',
    influxdb:'InfluxDB', postgres:'PostgreSQL', ingestion:'Ingestion',
    analytics:'Analytics', anomalyEngine:'Anomaly Engine', assistant:'AI Assistant',
    reportService:'Reports', ml:'ML', notifications:'Notifications',
  };
  const t0 = Date.now();
  const [memory, influx, pgCheck] = await Promise.all([
    checkMemoryStore(store),
    checkInflux(store),
    checkPostgres(),
  ]);
  console.error('[PERF] arch checks', Date.now() - t0, 'ms');

  // Add a derived "active storage" indicator
  const activeStorage = { status: memory.status, latencyMs: memory.latencyMs, engine: memory.engine, error: memory.error };

  const mlSnap = ml.snapshot();
  const [analytics, anomalyEngine, notif, assistantStatus] = await Promise.all([
    checkAnalytics(store),
    checkAnomalyEngine(store, require('../ai').paramCode),
    checkNotificationService(),
    checkAssistant(),
  ]);

  // Derive per-provider status from runtime state (live: ACTIVE/STANDBY/FAILED)
    const providerStates = {};
    if (Array.isArray(providers)) {
      for (const p of providers) {
        let st = 'NOT_CONFIGURED';
        if (p.enabled && p.configurationState === 'CONFIGURED' && p.status === 'GREEN') st = 'ACTIVE';
        else if (p.configurationState === 'CONFIGURED' && p.status === 'PENDING') st = 'PENDING';
        else if (p.configurationState === 'CONFIGURED' && !p.enabled) st = 'STANDBY';
        else if (p.configurationState === 'CONFIGURED' && p.status === 'RED') st = 'FAILED';
        else if (p.configurationState === 'CONFIGURED') st = 'STANDBY';
        else if (!p.enabled) st = 'NOT_CONFIGURED';
        providerStates[p.id] = { name: p.name, runtime: st, configured: p.configurationState === 'CONFIGURED', enabled: p.enabled, latencyMs: p.latencyMs, lastSuccess: p.lastSuccess, lastFailure: p.lastFailure };
      }
    }

  const components = {
    api: { status: 'UP', latencyMs: null, error: null },
    websocket: checkWebSocket(io),
    ingestion: checkIngestion(lastTickAt),
    analytics,
    anomalyEngine,
    assistant: assistantStatus,
    reportService: checkReportService(),
    ml: checkMlService(mlSnap),
    notifications: notif,
    storage: {
      activeStorage,
      memoryStore: memory,
      sqlite: checkSqlite(),
      influxdb: influx,
      postgres: pgCheck,
    },
    providers: providerStates,
  };
  const coreKeys = new Set(['api', 'websocket', 'memoryStore', 'ingestion', 'analytics', 'anomalyEngine', 'assistant', 'reportService', 'notifications']);
  const coreComponents = Object.entries(components)
    .filter(([key]) => coreKeys.has(key))
    .map(([key, comp]) => {
      const s = comp.status;
      const color = s === 'UP' || s === 'GREEN' || s === 'CONNECTED' || s === 'ACTIVE' ? 'GREEN'
        : s === 'DEGRADED' || s === 'YELLOW' || s === 'WARNING' || s === 'STARTING' || s === 'STANDBY' ? 'YELLOW'
        : s === 'DOWN' || s === 'RED' || s === 'FAILED' ? 'RED' : 'GRAY';
      return { key, label: labels[key] || key, status: s, color, latencyMs: comp.latencyMs ?? null, error: comp.error ?? null };
    });
  const optionalComponents = [];
  if (components.storage) {
    for (const [k, v] of Object.entries(components.storage)) {
      const s = v.status;
      const color = s === 'UP' || s === 'GREEN' ? 'GREEN' : s === 'DEGRADED' || s === 'YELLOW' ? 'YELLOW' : s === 'DOWN' || s === 'RED' ? 'RED' : 'GRAY';
      optionalComponents.push({ key: k, label: labels[k] || k, status: s, color, latencyMs: v.latencyMs ?? null, error: v.error ?? null });
    }
  }
  if (components.providers) {
    for (const [id, p] of Object.entries(components.providers)) {
      const s = p.runtime || p.status || 'NOT_CONFIGURED';
      const color = s === 'ACTIVE' || s === 'UP' || s === 'GREEN' ? 'GREEN' : s === 'PENDING' || s === 'STANDBY' || s === 'DEGRADED' || s === 'YELLOW' ? 'YELLOW' : s === 'FAILED' || s === 'DOWN' || s === 'RED' ? 'RED' : 'GRAY';
      optionalComponents.push({ key: `providers.${id}`, label: p.name || id, status: s, color, latencyMs: p.latencyMs ?? null, error: p.lastFailure ? `last failure ${new Date(p.lastFailure).toISOString()}` : (p.configured ? null : 'not configured') });
    }
  }

  const flat = [...coreComponents, ...optionalComponents];

  let overall = 'GREEN';
  if (coreComponents.some((f) => f.color === 'RED')) overall = 'RED';
  else if (coreComponents.some((f) => f.color === 'YELLOW')) overall = 'YELLOW';
  else if (flat.some((f) => f.color === 'RED')) overall = 'YELLOW';
  else if (flat.some((f) => f.color === 'YELLOW')) overall = 'YELLOW';

  return {
    status: overall,
    components,
    core: coreComponents,
    optional: optionalComponents,
    metrics: {
      websocketConnections: components.websocket.connections,
      lastTickAt,
      measuredAt: new Date().toISOString(),
    },
    computedAt: new Date().toISOString(),
    uptimeSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
    tickCount: tickCount ?? null,
    lastIngestionAt: lastTickAt,
  };
}

async function dataFlow(providers, store, io, lastTickAt, qualitySnapshot) {
  const providerStates = {};
  if (Array.isArray(providers)) {
    for (const p of providers) {
      let runtime = 'NOT_CONFIGURED';
      if (p.enabled && p.configurationState === 'CONFIGURED' && p.status === 'GREEN') runtime = 'ACTIVE';
      else if (p.configurationState === 'CONFIGURED' && p.status === 'PENDING') runtime = 'PENDING';
      else if (p.configurationState === 'CONFIGURED' && !p.enabled) runtime = 'STANDBY';
      else if (p.configurationState === 'CONFIGURED' && p.status === 'RED') runtime = 'FAILED';
      else if (p.configurationState === 'CONFIGURED') runtime = 'STANDBY';
      else if (!p.enabled) runtime = 'NOT_CONFIGURED';
      providerStates[p.id] = { name: p.name, runtime, configured: p.configurationState === 'CONFIGURED', enabled: p.enabled, latencyMs: p.latencyMs, lastSuccess: p.lastSuccess, lastFailure: p.lastFailure };
    }
  }
  const activeProvider = Object.entries(providerStates).find(([, v]) => v.runtime === 'ACTIVE');
  const fallbackProvider = Object.entries(providerStates).find(([, v]) => v.runtime === 'STANDBY' || v.runtime === 'PENDING');

  const ingestionStatus = checkIngestion(lastTickAt).status;
  const storageEnabled = store?.cfg?.enabled;
  const realtimeConnected = io ? io.engine.clientsCount > 0 : false;

  const [analyticsCheck, anomalyCheck, assistantCheck] = await Promise.all([
    checkAnalytics(store),
    checkAnomalyEngine(store, require('../ai').paramCode),
    checkAssistant(),
  ]);

  const connections = [
    { id: 'env-sources', name: 'Environmental Sources', type: 'source', status: 'UP', description: 'Simulated or real sensor network' },
    { id: 'provider-routing', name: 'Provider Routing', type: 'process', status: activeProvider ? 'UP' : 'DEGRADED', description: 'Routes requests to active provider', source: 'Open-Meteo / OpenWeather', destination: 'Request' },
    { id: 'request', name: 'Request', type: 'process', status: 'UP', description: 'Station-specific weather data fetch', source: 'Provider Routing', destination: 'Response' },
    { id: 'response', name: 'Response', type: 'data', status: activeProvider ? 'UP' : 'DEGRADED', description: 'Normalized provider response', source: 'Weather Provider', destination: 'Validation' },
    { id: 'validation', name: 'Validation', type: 'process', status: 'UP', description: 'Schema + range checks on readings', source: 'Response', destination: 'Normalization' },
    { id: 'normalization', name: 'Normalization + Provenance', type: 'process', status: 'UP', description: 'Units, timezone, source tracking', source: 'Validation', destination: 'Storage' },
    { id: 'storage', name: 'Storage', type: 'storage', status: storageEnabled ? 'UP' : 'GRAY', description: 'MemoryStore / InfluxDB / PostgreSQL', source: 'Normalization', destination: 'Realtime / History' },
    { id: 'realtime', name: 'Realtime / History', type: 'process', status: realtimeConnected ? 'UP' : 'GRAY', description: 'Socket.IO push + historical queries', source: 'Storage', destination: 'Data Quality' },
    { id: 'data-quality', name: 'Data Quality', type: 'process', status: qualitySnapshot ? 'UP' : 'STARTING', description: 'Completeness, validity, accuracy checks', source: 'Realtime / History', destination: 'Analytics' },
    { id: 'analytics', name: 'Analytics', type: 'process', status: analyticsCheck.status, description: 'Aggregation, baselines, correlations', source: 'Data Quality', destination: 'Anomaly Detection' },
    { id: 'anomaly-detection', name: 'Anomaly Detection', type: 'process', status: anomalyCheck.status, description: 'Threshold-based + ML-based detection', source: 'Analytics', destination: 'Alerts' },
    { id: 'alerts', name: 'Alerts', type: 'process', status: 'UP', description: 'Alert generation, escalation, notification', source: 'Anomaly Detection', destination: 'Investigation' },
    { id: 'investigation', name: 'Investigation', type: 'process', status: 'UP', description: 'Workflow tracking, evidence, findings', source: 'Alerts', destination: 'Agent / Decision' },
    { id: 'agent-decision', name: 'Agent / Decision', type: 'process', status: 'DEGRADED', description: 'AI-assisted root cause + action proposals', source: 'Investigation', destination: 'Approval' },
    { id: 'approval', name: 'Approval', type: 'process', status: 'UP', description: 'High-risk action gating', source: 'Agent / Decision', destination: 'Action' },
    { id: 'action', name: 'Action', type: 'process', status: 'UP', description: 'Executed remediation or escalation', source: 'Approval', destination: 'Verification' },
    { id: 'verification', name: 'Verification', type: 'process', status: 'UP', description: 'Independent post-action state check', source: 'Action', destination: 'Audit' },
    { id: 'audit', name: 'Audit', type: 'process', status: 'UP', description: 'Immutable action log', source: 'Verification', destination: 'RAG / Knowledge' },
    { id: 'rag', name: 'RAG / Knowledge', type: 'storage', status: 'UP', description: 'Vector + lexical knowledge index', source: 'Audit', destination: 'AI Assistant' },
    { id: 'assistant', name: 'AI Assistant', type: 'process', status: assistantCheck.status, description: 'Natural language interface', source: 'RAG / Knowledge', destination: 'Dashboard / User' },
    { id: 'dashboard', name: 'Dashboard / User', type: 'output', status: 'UP', description: 'Web UI + API consumers', source: 'AI Assistant', destination: 'Feedback / Learning' },
    { id: 'feedback', name: 'Feedback / Learning', type: 'process', status: 'UP', description: 'Operator corrections + model retraining', source: 'Dashboard / User', destination: 'ML / Analytics' },
  ];
  return {
    connections,
    providerFailover: {
      active: activeProvider ? { id: activeProvider[0], name: activeProvider[1].name, runtime: activeProvider[1].runtime } : null,
      fallback: fallbackProvider ? { id: fallbackProvider[0], name: fallbackProvider[1].name, runtime: fallbackProvider[1].runtime } : null,
    },
    providers: providerStates,
    realtime: { connected: io ? io.engine.clientsCount : 0, lastTickAt },
  };
}

module.exports = { snapshot, dataFlow };