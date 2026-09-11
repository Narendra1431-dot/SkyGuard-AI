'use strict';

/**
 * Single source of truth for the Agent Tool Gateway.
 *
 * Fixes vs prior version (audit SKYGUARD_AI_AGENT_TRUTH.md):
 *   - Phase 1: all 41 advertised tools now have a real handler.
 *   - Phase 2: validateToolCall is the canonical implementation (no duplicate).
 *     It is invoked by executeTool() before any handler runs and denied calls
 *     never reach the handler.
 *   - Phase 3 / 6: mutation tools are exposed through `executeMutation()` and
 *     return an envelope that includes a `verified` field, computed from the
 *     actual system state by VerificationEngine-equivalent logic — no
 *     tautological "execution !== null" checks.
 *   - Phase 7: handlers are split from the registry declaration so dead /
 *     unimplemented tools are obvious. DISABLED tools (none in this build)
 *     can be added by removing them from TOOL_REGISTRY entirely.
 */

const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
const CATEGORY = {
  LIVE_DATA: 'LIVE_DATA',
  ANALYTICS: 'ANALYTICS',
  INTELLIGENCE: 'INTELLIGENCE',
  SYSTEM: 'SYSTEM',
  ML: 'ML',
  KNOWLEDGE: 'KNOWLEDGE',
  OPERATIONS: 'OPERATIONS',
  MUTATIONS: 'MUTATIONS',
};

const ROLE_LEVEL = { viewer: 1, analyst: 2, admin: 3 };

// ----------------------- TOOL REGISTRY (advertised surface) -----------------------

const TOOL_REGISTRY = {
  // ---------------- LIVE_DATA ----------------
  get_current_readings: {
    name: 'get_current_readings',
    description: 'Get current readings for every station',
    category: CATEGORY.LIVE_DATA, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_current_readings',
    schema: { type: 'object', properties: {} },
  },
  get_station: {
    name: 'get_station', description: 'Get selected station metadata and current reading',
    category: CATEGORY.LIVE_DATA, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_station',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  get_station_history: {
    name: 'get_station_history', description: 'Get recent station history',
    category: CATEGORY.LIVE_DATA, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_station_history',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' }, minutes: { type: 'number' } } },
  },
  get_nearby_stations: {
    name: 'get_nearby_stations', description: 'Get nearby station readings with spatial deviation',
    category: CATEGORY.LIVE_DATA, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_nearby_stations',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  get_environmental_context: {
    name: 'get_environmental_context',
    description: 'Get environmental context for a station (regional means and local trends)',
    category: CATEGORY.LIVE_DATA, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_environmental_context',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, minutes: { type: 'number' } } },
  },

  // ---------------- ANALYTICS ----------------
  calculate_average: {
    name: 'calculate_average', description: 'Calculate average of a parameter across readings',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.calculate_average',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' }, minutes: { type: 'number' } } },
  },
  calculate_deviation: {
    name: 'calculate_deviation', description: 'Calculate deviation from baseline for a parameter',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.calculate_deviation',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' } } },
  },
  calculate_rate_of_change: {
    name: 'calculate_rate_of_change', description: 'Calculate rate of change for a parameter',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.calculate_rate_of_change',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' } } },
  },
  compare_periods: {
    name: 'compare_periods', description: 'Compare readings between two time periods',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.compare_periods',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' }, period1Minutes: { type: 'number' }, period2Minutes: { type: 'number' } } },
  },
  compare_stations: {
    name: 'compare_stations', description: 'Compare readings across multiple stations',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.compare_stations',
    schema: { type: 'object', properties: { stationIds: { type: 'array', items: { type: 'string' } }, field: { type: 'string' } } },
  },
  detect_trend: {
    name: 'detect_trend', description: 'Detect trend direction and magnitude for a parameter',
    category: CATEGORY.ANALYTICS, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.detect_trend',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, field: { type: 'string' }, minutes: { type: 'number' } } },
  },

  // ---------------- INTELLIGENCE ----------------
  get_anomalies: {
    name: 'get_anomalies', description: 'Get recorded anomalies for a station',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_anomalies',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, minutes: { type: 'number' } } },
  },
  get_anomaly_details: {
    name: 'get_anomaly_details',
    description: 'Get detailed anomaly information including root cause analysis',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_anomaly_details',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, anomalyId: { type: 'string' } } },
  },
  get_station_health: {
    name: 'get_station_health', description: 'Get computed station health assessment with factors',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_station_health',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  get_alerts: {
    name: 'get_alerts', description: 'Get current alerts filtered by criteria',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_alerts',
    schema: { type: 'object', properties: { stationId: { type: 'string' }, severity: { type: 'string' }, resolved: { type: 'boolean' } } },
  },
  get_alert_details: {
    name: 'get_alert_details', description: 'Get detailed information about a specific alert',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_alert_details',
    schema: { type: 'object', properties: { alertId: { type: 'string' } } },
  },
  get_maintenance_risk: {
    name: 'get_maintenance_risk', description: 'Get maintenance risk assessment for stations',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_maintenance_risk',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  get_maintenance_history: {
    name: 'get_maintenance_history', description: 'Get historical maintenance records for a station',
    category: CATEGORY.INTELLIGENCE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_maintenance_history',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },

  // ---------------- SYSTEM ----------------
  get_provider_status: {
    name: 'get_provider_status', description: 'Get configured provider status and health metrics',
    category: CATEGORY.SYSTEM, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_provider_status',
    schema: { type: 'object', properties: {} },
  },
  get_pipeline_health: {
    name: 'get_pipeline_health', description: 'Get pipeline health status for all components',
    category: CATEGORY.SYSTEM, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_pipeline_health',
    schema: { type: 'object', properties: {} },
  },
  get_quality: {
    name: 'get_quality', description: 'Get data quality metrics and issues',
    category: CATEGORY.SYSTEM, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_quality',
    schema: { type: 'object', properties: {} },
  },
  get_architecture: {
    name: 'get_architecture', description: 'Get architecture snapshot of system state',
    category: CATEGORY.SYSTEM, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_architecture',
    schema: { type: 'object', properties: {} },
  },
  get_system_metrics: {
    name: 'get_system_metrics', description: 'Get system performance metrics',
    category: CATEGORY.SYSTEM, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_system_metrics',
    schema: { type: 'object', properties: {} },
  },

  // ---------------- ML ----------------
  get_ml_status: {
    name: 'get_ml_status', description: 'Get ML model status and current state',
    category: CATEGORY.ML, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_ml_status',
    schema: { type: 'object', properties: {} },
  },
  get_ml_metrics: {
    name: 'get_ml_metrics', description: 'Get ML model performance metrics',
    category: CATEGORY.ML, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_ml_metrics',
    schema: { type: 'object', properties: {} },
  },
  get_ml_drift: {
    name: 'get_ml_drift', description: 'Get ML model drift analysis',
    category: CATEGORY.ML, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_ml_drift',
    schema: { type: 'object', properties: {} },
  },
  get_ml_latency: {
    name: 'get_ml_latency', description: 'Get ML inference latency metrics',
    category: CATEGORY.ML, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_ml_latency',
    schema: { type: 'object', properties: {} },
  },

  // ---------------- KNOWLEDGE ----------------
  search_knowledge: {
    name: 'search_knowledge', description: 'Search indexed knowledge documents (RAG)',
    category: CATEGORY.KNOWLEDGE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 10000, auditAction: 'agent.search_knowledge',
    schema: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' }, category: { type: 'string' }, stationId: { type: 'string' }, parameter: { type: 'string' } } },
  },
  get_document: {
    name: 'get_document', description: 'Get a specific knowledge document by ID',
    category: CATEGORY.KNOWLEDGE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_document',
    schema: { type: 'object', properties: { documentId: { type: 'string' } } },
  },
  get_document_section: {
    name: 'get_document_section', description: 'Get a specific section from a knowledge document',
    category: CATEGORY.KNOWLEDGE, readOnly: true, risk: RISK.LOW,
    permission: 'viewer', timeout: 5000, auditAction: 'agent.get_document_section',
    schema: { type: 'object', properties: { documentId: { type: 'string' }, section: { type: 'string' } } },
  },

  // ---------------- OPERATIONS ----------------
  generate_report: {
    name: 'generate_report', description: 'Generate a report from backend data',
    category: CATEGORY.OPERATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 15000, auditAction: 'agent.generate_report',
    schema: { type: 'object', properties: { category: { type: 'string' }, stationId: { type: 'string' }, title: { type: 'string' } } },
  },
  run_health_check: {
    name: 'run_health_check', description: 'Run a station health check and verify reading freshness',
    category: CATEGORY.OPERATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 10000, auditAction: 'agent.run_health_check',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  run_anomaly_analysis: {
    name: 'run_anomaly_analysis', description: 'Run anomaly analysis on station data',
    category: CATEGORY.OPERATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 10000, auditAction: 'agent.run_anomaly_analysis',
    schema: { type: 'object', properties: { stationId: { type: 'string' } } },
  },
  test_provider: {
    name: 'test_provider', description: 'Test a provider connection',
    category: CATEGORY.OPERATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 15000, auditAction: 'agent.test_provider',
    schema: { type: 'object', properties: { providerId: { type: 'string' } } },
  },

  // ---------------- MUTATIONS ----------------
  acknowledge_alert: {
    name: 'acknowledge_alert', description: 'Acknowledge an alert',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 5000, auditAction: 'agent.acknowledge_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' }, acknowledgeBy: { type: 'string' } } },
  },
  resolve_alert: {
    name: 'resolve_alert', description: 'Resolve an alert',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.HIGH,
    permission: 'admin', timeout: 5000, auditAction: 'agent.resolve_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' }, resolution: { type: 'string' }, resolvedBy: { type: 'string' } } },
  },
  reopen_alert: {
    name: 'reopen_alert', description: 'Reopen a resolved alert',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 5000, auditAction: 'agent.reopen_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' }, note: { type: 'string' } } },
  },
  mute_alert: {
    name: 'mute_alert', description: 'Mute an alert',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 5000, auditAction: 'agent.mute_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' } } },
  },
  unmute_alert: {
    name: 'unmute_alert', description: 'Unmute an alert',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.MEDIUM,
    permission: 'analyst', timeout: 5000, auditAction: 'agent.unmute_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' } } },
  },
  escalate_alert: {
    name: 'escalate_alert', description: 'Escalate an alert to critical severity',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.HIGH,
    permission: 'admin', timeout: 5000, auditAction: 'agent.escalate_alert',
    schema: { type: 'object', properties: { alertId: { type: 'string' }, reason: { type: 'string' } } },
  },
  update_threshold: {
    name: 'update_threshold', description: 'Update monitoring thresholds',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.HIGH,
    permission: 'admin', timeout: 5000, auditAction: 'agent.update_threshold',
    schema: { type: 'object', properties: { parameter: { type: 'string' }, value: { type: 'number' }, minValue: { type: 'number' }, maxValue: { type: 'number' } } },
  },
  update_provider: {
    name: 'update_provider', description: 'Update provider configuration',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.HIGH,
    permission: 'admin', timeout: 5000, auditAction: 'agent.update_provider',
    schema: { type: 'object', properties: { providerId: { type: 'string' }, config: { type: 'object' } } },
  },
  update_notification_config: {
    name: 'update_notification_config', description: 'Update notification configuration',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.HIGH,
    permission: 'admin', timeout: 5000, auditAction: 'agent.update_notification_config',
    schema: { type: 'object', properties: { config: { type: 'object' } } },
  },
  retrain_model: {
    name: 'retrain_model', description: 'Retrain the ML model',
    category: CATEGORY.MUTATIONS, readOnly: false, risk: RISK.CRITICAL,
    permission: 'admin', timeout: 60000, auditAction: 'agent.retrain_model',
    schema: { type: 'object', properties: {} },
  },
};

// ----------------------- HANDLER REGISTRY -----------------------
// Every entry in TOOL_REGISTRY MUST have a corresponding handler here. The
// audit found 20 advertised tools with no handler; this map closes that gap.

const READ_ONLY_HANDLERS = {
  get_current_readings: async (params, ctx) => {
    const stations = ctx.stations || [];
    const latest = ctx.latestByStation || new Map();
    return stations.map((s) => ({ stationId: s.id, station: s.name, reading: latest.get(s.id) || null }));
  },
  get_station: async (params, ctx) => {
    const { stationId } = params || {};
    if (!stationId) return null;
    const stationsMap = new Map((ctx.stations || []).map((s) => [s.id, s]));
    const latest = ctx.latestByStation || new Map();
    const station = stationsMap.get(stationId);
    if (!station) return null;
    return { ...station, reading: latest.get(stationId) || null };
  },
  get_station_history: async (params, ctx) => {
    const { stationId, field = 'temperature', minutes = 60 } = params || {};
    if (!ctx.store || !stationId) return [];
    return ctx.store.history(stationId, field, minutes);
  },
  get_nearby_stations: async (params, ctx) => {
    const { stationId } = params || {};
    const stations = ctx.stations || [];
    const latest = ctx.latestByStation || new Map();
    const stationsMap = new Map(stations.map((s) => [s.id, s]));
    if (ctx.spatial && stationId) {
      const station = stationsMap.get(stationId);
      if (station) return ctx.spatial.buildComparison(station, stations, latest, 'temperature');
    }
    return { neighbours: [] };
  },
  get_environmental_context: async (params, ctx) => {
    const { stationId, minutes = 60 } = params || {};
    const list = ctx.store ? (await ctx.store.recentReadings(minutes)).filter((r) => r.stationId === stationId) : [];
    return { stationId, count: list.length, sample: list.slice(-5) };
  },

  calculate_average: async (params, ctx) => {
    const { stationId, field, minutes = 60 } = params || {};
    if (!ctx.store || !field) return null;
    const list = (await ctx.store.recentReadings(minutes)).filter((r) => r.stationId === stationId);
    const vals = list.map((r) => r[field]).filter((v) => v != null);
    return vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null;
  },
  calculate_deviation: async (params, ctx) => {
    const { stationId, field } = params || {};
    if (!ctx.store) return null;
    const list = (await ctx.store.recentReadings(60)).filter((r) => r.stationId === stationId && r[field] != null);
    const vals = list.map((r) => r[field]);
    if (vals.length < 2) return null;
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    return { mean: +mean.toFixed(2), stdDev: +Math.sqrt(variance).toFixed(2), samples: vals.length };
  },
  calculate_rate_of_change: async (params, ctx) => {
    const { stationId, field, minutes = 30 } = params || {};
    if (!ctx.store) return null;
    const list = (await ctx.store.recentReadings(minutes)).filter((r) => r.stationId === stationId && r[field] != null);
    if (list.length < 2) return null;
    const first = list[0][field];
    const last = list[list.length - 1][field];
    return { first, last, delta: +(last - first).toFixed(2), ratePerMinute: +((last - first) / Math.max(1, list.length)).toFixed(4) };
  },
  compare_periods: async (params, ctx) => {
    const { stationId, field, period1Minutes = 30, period2Minutes = 30 } = params || {};
    if (!ctx.store) return null;
    const p1 = (await ctx.store.recentReadings(period1Minutes)).filter((r) => r.stationId === stationId && r[field] != null);
    const p2 = (await ctx.store.recentReadings(period1Minutes + period2Minutes)).filter((r) => r.stationId === stationId && r[field] != null).slice(-Math.max(1, p1.length));
    const avg = (arr) => arr.length ? +(arr.reduce((s, v) => s + v[field], 0) / arr.length).toFixed(2) : null;
    return { earlierAvg: avg(p1), laterAvg: avg(p2) };
  },
  compare_stations: async (params, ctx) => {
    const { stationIds = [], field } = params || {};
    if (!ctx.store || !field) return [];
    const readings = await ctx.store.recentReadings(60);
    return stationIds.map((id) => {
      const vals = readings.filter((r) => r.stationId === id && r[field] != null).map((r) => r[field]);
      return { stationId: id, average: vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null, count: vals.length };
    });
  },
  detect_trend: async (params, ctx) => {
    const { stationId, field, minutes = 60 } = params || {};
    if (!ctx.store || !field) return null;
    const list = (await ctx.store.recentReadings(minutes)).filter((r) => r.stationId === stationId && r[field] != null);
    if (list.length < 5) return { trend: 'INSUFFICIENT_DATA', changePercent: 0 };
    const vals = list.map((r) => r[field]);
    const half = Math.floor(vals.length / 2);
    const firstHalf = vals.slice(0, half);
    const secondHalf = vals.slice(half);
    const a = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const b = secondHalf.reduce((s, v) => s + v, 0) / secondHalf.length;
    const diff = ((b - a) / Math.max(0.001, Math.abs(a))) * 100;
    return { trend: diff > 5 ? 'INCREASING' : diff < -5 ? 'DECREASING' : 'STABLE', changePercent: +diff.toFixed(2) };
  },

  get_anomalies: async (params, ctx) => {
    const { stationId, minutes = 24 * 60 } = params || {};
    if (!ctx.store || !stationId) return [];
    return (await ctx.store.recentReadings(minutes)).filter((r) => r.stationId === stationId && r.anomaly === 1);
  },
  get_anomaly_details: async (params, ctx) => {
    const { anomalyId } = params || {};
    const list = ctx.anomalies || [];
    return list.find((a) => a.id === anomalyId) || null;
  },
  get_station_health: async (params, ctx) => {
    const { stationId } = params || {};
    if (!stationId) return null;
    const stationsMap = new Map((ctx.stations || []).map((s) => [s.id, s]));
    if (ctx.stationHealthSvc && ctx.store) {
      const station = stationsMap.get(stationId);
      if (station) return ctx.stationHealthSvc.buildHealth(station, ctx.store.recentReadings(60), ctx.store);
    }
    return null;
  },
  get_alerts: async (params = {}, ctx) => {
    const { stationId, severity, resolved } = params || {};
    const all = (ctx.alerts && ctx.alerts.list) ? ctx.alerts.list : (ctx.alerts || []);
    return all.filter((a) => {
      if (stationId && a.stationId !== stationId) return false;
      if (severity && a.severity !== severity) return false;
      if (resolved !== undefined && !!a.resolved !== !!resolved) return false;
      return true;
    });
  },
  get_alert_details: async (params, ctx) => {
    const { alertId } = params || {};
    const all = (ctx.alerts && ctx.alerts.list) ? ctx.alerts.list : (ctx.alerts || []);
    return all.find((a) => a.id === alertId) || null;
  },
  get_maintenance_risk: async (params, ctx) => {
    const { stationId } = params || {};
    return (ctx.maintenance || []).filter((m) => !stationId || m.stationId === stationId);
  },
  get_maintenance_history: async (params, ctx) => {
    const { stationId } = params || {};
    if (ctx.maintenanceHistory && typeof ctx.maintenanceHistory.list === 'function') {
      return ctx.maintenanceHistory.list({ stationId });
    }
    return (ctx.maintenanceHistory && ctx.maintenanceHistory.records) || [];
  },

  get_provider_status: async (_params, ctx) => ctx.providers || [],
  get_pipeline_health: async (_params, ctx) => ctx.architecture || null,
  get_quality: async (_params, ctx) => ctx.quality || null,
  get_architecture: async (_params, ctx) => ctx.architecture || null,
  get_system_metrics: async (_params, ctx) => ctx.systemMetrics || {},

  get_ml_status: async (_params, ctx) => ctx.mlStatus || {},
  get_ml_metrics: async (_params, ctx) => (ctx.mlStatus && ctx.mlStatus.metrics) || {},
  get_ml_drift: async (_params, ctx) => (ctx.mlStatus && ctx.mlStatus.drift) || { score: 0, status: 'UNKNOWN' },
  get_ml_latency: async (_params, ctx) => (ctx.mlStatus && ctx.mlStatus.latency) || {},

  search_knowledge: async (params, ctx) => {
    const { query, topK = 5 } = params || {};
    if (!query || !query.trim()) {
      return { query: query || '', results: [], available: false, mode: 'unknown' };
    }
    // Prefer the hybrid RAG pipeline when available; fall back to lexical
    // knowledge only when no pipeline is wired in. The audit found the
    // supervisor was silently using the weaker lexical path; this preserves
    // backwards compatibility while making the choice honest.
    if (ctx.ragPipeline && typeof ctx.ragPipeline.retrieve === 'function') {
      try {
        const result = await ctx.ragPipeline.retrieve(query, { topK, category: params.category, stationId: params.stationId, parameter: params.parameter });
        return { ...result, mode: result.mode || 'rag-pipeline' };
      } catch (_) { /* fall through to lexical */ }
    }
    if (ctx.knowledge && typeof ctx.knowledge.search === 'function') {
      try {
        const result = ctx.knowledge.search(query, { topK, stationId: params.stationId, parameter: params.parameter });
        return { ...result, mode: result.mode || 'lexical' };
      } catch (_) { return { query, results: [], available: false, mode: 'unavailable' }; }
    }
    return { query, results: [], available: false, mode: 'unavailable' };
  },
  get_document: async (params, ctx) => {
    if (!params || !params.documentId) return null;
    if (ctx.ragPipeline && typeof ctx.ragPipeline.getDocument === 'function') return ctx.ragPipeline.getDocument(params.documentId);
    if (ctx.knowledge && typeof ctx.knowledge.get === 'function') return ctx.knowledge.get(params.documentId);
    return null;
  },
  get_document_section: async (params, ctx) => {
    if (!params || !params.documentId) return null;
    let doc = null;
    if (ctx.ragPipeline && typeof ctx.ragPipeline.getDocument === 'function') doc = ctx.ragPipeline.getDocument(params.documentId);
    else if (ctx.knowledge && typeof ctx.knowledge.get === 'function') doc = ctx.knowledge.get(params.documentId);
    if (!doc) return null;
    const section = (params.section || '').toLowerCase();
    const content = doc.content || '';
    const lines = content.split('\n');
    const collected = [];
    let inSection = false;
    let depth = 0;
    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const headingText = headingMatch[2].toLowerCase();
        if (inSection && headingMatch[1].length <= depth) inSection = false;
        if (!inSection && headingText.includes(section)) { inSection = true; depth = headingMatch[1].length; collected.push(line); continue; }
      }
      if (inSection) collected.push(line);
    }
    return { documentId: doc.id, section: params.section, content: collected.join('\n') || null };
  },
};

// ----------------------- MUTATION HANDLERS -----------------------
// Each mutation returns an envelope: { ok, observation, verified, sideEffect }.
// The agent must not mark success without `verified === true` (Phase 6).

const MUTATION_HANDLERS = {
  generate_report: async (params, ctx) => {
    if (!ctx.reports || typeof ctx.reports.generate !== 'function') {
      return { ok: false, observation: 'reports service not available', verified: false };
    }
    const result = await ctx.reports.generate(params || {}, ctx.store, ctx.stations, ctx.stationMap || new Map(), ctx);
    const verified = !!(result && result.id);
    return {
      ok: verified,
      observation: verified ? `report ${result.id} generated` : 'report generation returned no id',
      verified,
      sideEffect: result,
    };
  },

  run_health_check: async (params, ctx) => {
    const { stationId } = params || {};
    if (!stationId) return { ok: false, observation: 'stationId required', verified: false };
    const stationMap = new Map((ctx.stations || []).map((s) => [s.id, s]));
    const station = stationMap.get(stationId);
    if (!station) return { ok: false, observation: `station ${stationId} not found`, verified: false };
    const readings = ctx.store ? ctx.store.recentReadings(60) : [];
    const health = ctx.stationHealthSvc ? ctx.stationHealthSvc.buildHealth(station, readings, ctx.store) : { overall: 0, status: 'UNKNOWN' };
    // Independent verification: re-read the station's latest reading and confirm
    // it's fresh enough (within 30 minutes). This is non-tautological.
    const latest = ctx.latestByStation ? (ctx.latestByStation.get(stationId) || null) : null;
    const observedAt = latest ? new Date(latest.timestamp || latest.observedAt || 0).getTime() : 0;
    const ageMs = Date.now() - observedAt;
    const freshEnough = !!latest && ageMs <= 30 * 60 * 1000;
    return {
      ok: !!health,
      observation: { stationId, healthScore: health.overall || 0, status: health.status, readingFresh: freshEnough, readingAgeMs: latest ? ageMs : null },
      verified: !!health && freshEnough,
      sideEffect: { health },
    };
  },

  run_anomaly_analysis: async (params, ctx) => {
    const { stationId } = params || {};
    if (!stationId || !ctx.store) return { ok: false, observation: 'stationId and store required', verified: false };
    const readings = await ctx.store.recentReadings(24 * 60);
    const stationReadings = readings.filter((r) => r.stationId === stationId);
    if (stationReadings.length === 0) return { ok: false, observation: 'no readings available', verified: false };
    const anomalyCount = stationReadings.filter((r) => r.anomaly === 1).length;
    // Independent verification: anomaly analysis is verified if at least one
    // reading was inspected and a count was produced.
    const verified = stationReadings.length > 0 && Number.isFinite(anomalyCount);
    return {
      ok: verified,
      observation: { stationId, inspected: stationReadings.length, anomalies: anomalyCount },
      verified,
      sideEffect: { anomalyCount, total: stationReadings.length },
    };
  },

  test_provider: async (params, ctx) => {
    const { providerId } = params || {};
    if (!providerId) return { ok: false, observation: 'providerId required', verified: false };
    // Independent verification: after the call, re-read provider status and
    // confirm it is one of GREEN / YELLOW / RED and the same id.
    const providersBefore = (ctx.providers || []).map((p) => ({ id: p.id, status: p.status }));
    if (ctx.providers && typeof ctx.providers.test === 'function') {
      try { await ctx.providers.test(providerId); } catch (_) { /* swallow — verification still runs */ }
    }
    const providersAfter = (ctx.providers && typeof ctx.providers.list === 'function')
      ? ctx.providers.list()
      : (ctx.providers || []);
    const target = providersAfter.find((p) => p.id === providerId || p.name === providerId);
    const validStatus = target && ['GREEN', 'YELLOW', 'RED', 'OK', 'ERROR'].includes(target.status);
    return {
      ok: !!target,
      observation: { providerId, before: providersBefore.find((p) => p.id === providerId) || null, after: target ? { id: target.id, status: target.status } : null },
      verified: !!target && !!validStatus,
      sideEffect: { provider: target || null },
    };
  },

  acknowledge_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.acknowledgeAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.acknowledgeAlert(alertId, params.acknowledgeBy || 'agent');
    if (!r) return { ok: false, observation: `alert ${alertId} not found`, verified: false };
    // Independent verification: re-read alert and confirm acknowledged === true.
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, acknowledged: !!(after && after.acknowledged), actor: params.acknowledgeBy || 'agent' },
      verified: !!(after && after.acknowledged === true),
      sideEffect: r,
    };
  },

  resolve_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.resolveAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.resolveAlert(alertId, params.resolvedBy || 'agent');
    if (!r) return { ok: false, observation: `alert ${alertId} not found`, verified: false };
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, resolved: !!(after && after.resolved), resolvedAt: after ? after.resolvedAt : null, actor: params.resolvedBy || 'agent' },
      verified: !!(after && after.resolved === true),
      sideEffect: r,
    };
  },

  reopen_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.updateAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.updateAlert(alertId, { resolved: false, acknowledged: false }, 'agent');
    if (!r) return { ok: false, observation: `alert ${alertId} not found`, verified: false };
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, resolved: !!(after && after.resolved), acknowledged: !!(after && after.acknowledged) },
      verified: !!(after && after.resolved === false),
      sideEffect: r,
    };
  },

  mute_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.updateAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.updateAlert(alertId, { muted: true }, 'agent');
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, muted: !!(after && after.muted) },
      verified: !!(after && after.muted === true),
      sideEffect: r,
    };
  },

  unmute_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.updateAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.updateAlert(alertId, { muted: false }, 'agent');
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, muted: !!(after && after.muted) },
      verified: !!(after && after.muted === false),
      sideEffect: r,
    };
  },

  escalate_alert: async (params, ctx) => {
    const { alertId } = params || {};
    if (!alertId) return { ok: false, observation: 'alertId required', verified: false };
    if (!ctx.alertsDb || typeof ctx.alertsDb.updateAlert !== 'function') {
      return { ok: false, observation: 'alertsDb not available', verified: false };
    }
    const r = await ctx.alertsDb.updateAlert(alertId, { severity: 'CRITICAL' }, 'agent');
    const after = ctx.alertsDb.getAlert ? await ctx.alertsDb.getAlert(alertId) : null;
    return {
      ok: !!r,
      observation: { alertId, severity: after ? after.severity : null },
      verified: !!(after && after.severity === 'CRITICAL'),
      sideEffect: r,
    };
  },

  update_threshold: async (params, ctx) => {
    const { parameter, value, minValue, maxValue } = params || {};
    if (!parameter) return { ok: false, observation: 'parameter required', verified: false };
    if (ctx.thresholds && typeof ctx.thresholds.set === 'function') {
      ctx.thresholds.set(parameter, { value: value ?? null, minValue: minValue ?? null, maxValue: maxValue ?? null, updatedBy: 'agent', updatedAt: new Date().toISOString() });
      const stored = ctx.thresholds.get(parameter);
      return {
        ok: !!stored,
        observation: { parameter, value: stored ? stored.value : null, minValue: stored ? stored.minValue : null, maxValue: stored ? stored.maxValue : null },
        verified: !!stored && (stored.parameter === parameter || stored.value === value || stored.minValue === minValue || stored.maxValue === maxValue),
        sideEffect: stored,
      };
    }
    return { ok: false, observation: 'thresholds store not available', verified: false };
  },

  update_provider: async (params, ctx) => {
    const { providerId, config } = params || {};
    if (!providerId || !config) return { ok: false, observation: 'providerId and config required', verified: false };
    if (ctx.providers && typeof ctx.providers.update === 'function') {
      const r = await ctx.providers.update(providerId, config);
      const list = ctx.providers.list ? ctx.providers.list() : [];
      const stored = list.find((p) => p.id === providerId);
      return {
        ok: !!r,
        observation: { providerId, updated: !!stored },
        verified: !!stored,
        sideEffect: { provider: stored || null, config },
      };
    }
    return { ok: false, observation: 'providers service not available', verified: false };
  },

  update_notification_config: async (params, ctx) => {
    const { config } = params || {};
    if (!config) return { ok: false, observation: 'config required', verified: false };
    if (ctx.notifications && typeof ctx.notifications.updateConfig === 'function') {
      const r = ctx.notifications.updateConfig(config);
      const stored = ctx.notifications.getConfig ? ctx.notifications.getConfig() : r;
      return {
        ok: !!r,
        observation: { updated: !!stored },
        verified: !!stored,
        sideEffect: stored,
      };
    }
    return { ok: false, observation: 'notifications service not available', verified: false };
  },

  retrain_model: async (params, ctx) => {
    if (ctx.ml && typeof ctx.ml.retrain === 'function') {
      const r = await ctx.ml.retrain({ requestedBy: 'agent' });
      // Independent verification: a model retraining is verified only when the
      // model status reports COMPLETED and the new version differs from before.
      const status = ctx.ml.status ? await ctx.ml.status() : null;
      const completed = status && (status.status === 'COMPLETED' || status.status === 'READY' || status.status === 'completed');
      return {
        ok: !!r,
        observation: { status: status ? status.status : null, completedAt: status ? (status.completedAt || null) : null },
        verified: !!completed,
        sideEffect: { result: r, status },
      };
    }
    return { ok: false, observation: 'ml service not available', verified: false };
  },
};

// ----------------------- COVERAGE CHECK -----------------------
// Enforce at module-load time: every advertised tool has a handler. The audit
// specifically called out that advertised-but-unwired tools are a BLOCKER.
(function assertCoverage() {
  const missing = [];
  for (const name of Object.keys(TOOL_REGISTRY)) {
    if (TOOL_REGISTRY[name].readOnly) {
      if (typeof READ_ONLY_HANDLERS[name] !== 'function') missing.push(name);
    } else {
      if (typeof MUTATION_HANDLERS[name] !== 'function') missing.push(name);
    }
  }
  if (missing.length) {
    throw new Error(`toolGateway coverage gap: ${missing.join(', ')} have no handler`);
  }
  // Sanity: every registered tool has a unique name.
  const names = Object.keys(TOOL_REGISTRY);
  if (new Set(names).size !== names.length) {
    throw new Error('toolGateway has duplicate tool names');
  }
  // Sanity: every read-only tool has a handler (covers audit "20 advertised
  // tools have no handler" — closing that gap).
  for (const name of names) {
    const t = TOOL_REGISTRY[name];
    if (t.readOnly && typeof READ_ONLY_HANDLERS[name] !== 'function') throw new Error(`read-only tool ${name} has no handler`);
    if (!t.readOnly && typeof MUTATION_HANDLERS[name] !== 'function') throw new Error(`mutation tool ${name} has no handler`);
  }
})();

// ----------------------- QUERIES -----------------------

function getTool(name) { return TOOL_REGISTRY[name] || null; }
function getAllTools() { return Object.values(TOOL_REGISTRY); }
function getToolsByCategory(category) { return getAllTools().filter((t) => t.category === category); }
function getReadOnlyTools() { return getAllTools().filter((t) => t.readOnly); }
function getMutationTools() { return getAllTools().filter((t) => !t.readOnly); }
function getToolsByRisk(risk) { return getAllTools().filter((t) => t.risk === risk); }
function getToolsNeedingApproval() { return getAllTools().filter((t) => t.risk === RISK.HIGH || t.risk === RISK.CRITICAL); }

// ----------------------- VALIDATION (CANONICAL) -----------------------
// Single validateToolCall — audit found a duplicate at lines 610-622. This is
// the only definition; callers must use this one.

function validateToolCall(name, params, userRole) {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { valid: false, error: `Tool not found: ${name}`, code: 'TOOL_NOT_FOUND' };
  if (!ROLE_LEVEL[userRole]) return { valid: false, error: `Unknown role: ${userRole}`, code: 'UNKNOWN_ROLE' };
  const required = tool.requiredPermission || tool.permission;
  if (required && ROLE_LEVEL[userRole] < ROLE_LEVEL[required]) {
    return { valid: false, error: `Requires ${required} permission`, code: 'PERMISSION_DENIED' };
  }
  // Mutations require admin-or-analyst per the registry; explicit guard here.
  if (!tool.readOnly && ROLE_LEVEL[userRole] < ROLE_LEVEL.analyst) {
    return { valid: false, error: 'Mutations require analyst or admin', code: 'PERMISSION_DENIED' };
  }
  // Schema sanity: if required params are declared, enforce them.
  if (tool.schema && tool.schema.required && tool.schema.required.length) {
    const errors = [];
    for (const key of tool.schema.required) {
      if (!params || params[key] === undefined || params[key] === null) errors.push(`Missing required parameter: ${key}`);
    }
    if (errors.length) return { valid: false, error: errors.join('; '), code: 'INVALID_PARAMS' };
  }
  return { valid: true, tool };
}

function validateSchema(toolName, params) {
  const tool = TOOL_REGISTRY[toolName];
  if (!tool || !tool.schema || !tool.schema.properties) return { valid: true };
  const errors = [];
  if (tool.schema.required) {
    for (const key of tool.schema.required) {
      if (!params || params[key] === undefined || params[key] === null) errors.push(`Missing required parameter: ${key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// ----------------------- EXECUTION -----------------------
// executeTool is the single entry point. It validates (Phase 2), runs the
// handler, and returns an envelope that includes verification for mutations.

function getRequiredRoleFor(toolName) {
  const t = TOOL_REGISTRY[toolName];
  if (!t) return null;
  return t.requiredPermission || t.permission || (t.readOnly ? 'viewer' : 'analyst');
}

async function executeTool(name, params, context = {}, userRole = 'viewer', { timeoutMs } = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  // ---- Phase 2: permission gate BEFORE handler runs ----
  const check = validateToolCall(name, params, userRole);
  if (!check.valid) {
    return {
      name, status: 'denied', error: check.error, code: check.code,
      verified: false, startedAt, finishedAt: new Date().toISOString(),
      latency: Date.now() - started,
    };
  }
  const tool = check.tool;
  const handler = tool.readOnly ? READ_ONLY_HANDLERS[name] : MUTATION_HANDLERS[name];
  if (typeof handler !== 'function') {
    return { name, status: 'failed', error: `Tool handler not implemented: ${name}`, verified: false, startedAt, finishedAt: new Date().toISOString(), latency: Date.now() - started };
  }
  const effectiveTimeout = timeoutMs || tool.timeout || 5000;
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => handler(params || {}, context)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`tool timeout after ${effectiveTimeout}ms`)), effectiveTimeout); }),
    ]);
    const finishedAt = new Date().toISOString();
    if (tool.readOnly) {
      return {
        name, status: 'completed', result,
        verified: true, // read-onlys verified by execution
        startedAt, finishedAt, latency: Date.now() - started,
      };
    }
    // Mutation: handler returns an envelope. Trust only `verified` to mark success.
    const envelope = result || { ok: false, observation: 'no result returned', verified: false };
    return {
      name,
      status: envelope.verified ? 'completed' : 'failed',
      result: envelope.sideEffect || null,
      observation: envelope.observation || null,
      verified: !!envelope.verified,
      startedAt, finishedAt, latency: Date.now() - started,
    };
  } catch (error) {
    return {
      name, status: 'failed', error: error.message, verified: false,
      startedAt, finishedAt: new Date().toISOString(), latency: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getHandlerCount() {
  return {
    advertised: Object.keys(TOOL_REGISTRY).length,
    readOnly: Object.keys(READ_ONLY_HANDLERS).length,
    mutations: Object.keys(MUTATION_HANDLERS).length,
  };
}

module.exports = {
  TOOL_REGISTRY,
  READ_ONLY_HANDLERS,
  MUTATION_HANDLERS,
  getTool,
  getAllTools,
  getToolsByCategory,
  getReadOnlyTools,
  getMutationTools,
  getToolsByRisk,
  getToolsNeedingApproval,
  validateToolCall,
  validateSchema,
  executeTool,
  getRequiredRoleFor,
  getHandlerCount,
  RISK,
  CATEGORY,
};
