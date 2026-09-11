'use strict';

const { randomUUID } = require('crypto');

const SEVERITY_ORDER = { INFO: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 };

function classifyChange(prev, curr, field) {
  if (prev === undefined && curr !== undefined) return 'NEW';
  if (prev !== undefined && curr === undefined) return 'REMOVED';
  if (JSON.stringify(prev) === JSON.stringify(curr)) return 'UNCHANGED';
  if (prev === null && curr !== null) return 'NEW';
  if (prev !== null && curr === null) return 'RECOVERED';
  if (typeof prev === 'number' && typeof curr === 'number') {
    const diff = curr - prev;
    if (Math.abs(diff) < 0.001) return 'UNCHANGED';
    if (diff > 0) return 'DEGRADED';
    return 'IMPROVED';
  }
  if (typeof prev === 'string' && typeof curr === 'string') {
    if (prev === curr) return 'UNCHANGED';
    if (prev === 'GREEN' && curr === 'RED') return 'DEGRADED';
    if (prev === 'RED' && curr === 'GREEN') return 'RECOVERED';
    if (prev === 'GREEN' && curr === 'YELLOW') return 'DEGRADED';
    if (prev === 'YELLOW' && curr === 'GREEN') return 'RECOVERED';
    return 'CHANGED';
  }
  return 'CHANGED';
}

function buildProviderSnapshot(providers) {
  return (providers || []).map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status || 'GRAY',
    configured: p.configurationState === 'CONFIGURED',
    enabled: p.enabled,
    latencyMs: p.latencyMs,
    lastSuccess: p.lastSuccess,
    lastFailure: p.lastFailure,
    requestCount: p.requestCount,
    failureCount: p.failureCount,
    successCount: p.successCount,
  }));
}

function buildIngestionSnapshot(lastTickAt, tickCount) {
  const age = lastTickAt ? (Date.now() - new Date(lastTickAt).getTime()) / 1000 : null;
  return {
    lastTickAt,
    tickCount,
    ageSeconds: age !== null ? +age.toFixed(2) : null,
    freshness: age !== null ? (age < 30 ? 'FRESH' : age < 120 ? 'STALE' : 'OLD') : 'UNKNOWN',
    status: age === null ? 'STARTING' : age < 30 ? 'GREEN' : age < 120 ? 'YELLOW' : 'RED',
  };
}

function buildDataQualitySnapshot(qualitySnapshot) {
  if (!qualitySnapshot) return { status: 'UNKNOWN', overallScore: null };
  const score = qualitySnapshot.overallScore || 0;
  return {
    status: score >= 90 ? 'GREEN' : score >= 70 ? 'YELLOW' : 'RED',
    overallScore: score,
    completeness: qualitySnapshot.completeness,
    validity: qualitySnapshot.validity,
    accuracy: qualitySnapshot.accuracy,
    freshnessSeconds: qualitySnapshot.freshnessSeconds,
    latencyMs: qualitySnapshot.latencyMs,
    ingestionRate: qualitySnapshot.ingestionRate,
    recordsAccepted: qualitySnapshot.recordsAccepted,
    recordsRejected: qualitySnapshot.recordsRejected,
    duplicates: qualitySnapshot.duplicates,
    outOfRange: qualitySnapshot.outOfRange,
    missing: qualitySnapshot.missing,
  };
}

function buildStationSnapshot(stations, latestByStation) {
  const readings = latestByStation instanceof Map
    ? latestByStation
    : new Map(Object.entries(latestByStation || {}));
  return stations.map((station) => {
    const reading = readings.get(station.id) || station.reading || null;
    const r = reading || {};
    return {
      id: station.id,
      name: station.name,
      lat: station.lat,
      lon: station.lon,
      status: reading ? (reading.anomaly === 1 ? 'WARNING' : 'HEALTHY') : 'OFFLINE',
      healthScore: reading ? (r.healthScore || station.healthScore || Math.round(100 - (r.aqi || 0) * 0.25 - Math.max(0, 32 - (r.temperature || 0)) * 3)) : station.healthScore || 0,
      reading: reading ? {
        temperature: r.temperature,
        pressure: r.pressure,
        humidity: r.humidity,
        aqi: r.aqi,
        wind: r.wind,
        rainfall: r.rainfall,
        anomaly: r.anomaly,
        time: r.time,
      } : null,
      heartbeat: reading ? (Date.now() - new Date(r.time).getTime()) : null,
      freshness: reading ? (Date.now() - new Date(r.time).getTime()) / 1000 : null,
    };
  });
}

function buildAnomalySnapshot(anomalies) {
  const list = Array.isArray(anomalies) ? anomalies : (anomalies && anomalies.count !== undefined) ? [] : [];
  const criticalCount = Array.isArray(anomalies) ? anomalies.filter((a) => a.severity === 'critical').length : (anomalies && anomalies.critical) || 0;
  const warningCount = Array.isArray(anomalies) ? anomalies.filter((a) => a.severity === 'warning').length : (anomalies && anomalies.warning) || 0;
  const count = Array.isArray(anomalies) ? anomalies.length : (anomalies && anomalies.count) || 0;
  return {
    count,
    critical: criticalCount,
    warning: warningCount,
    byStation: Array.isArray(anomalies) ? anomalies.reduce((acc, a) => { acc[a.stationId] = (acc[a.stationId] || 0) + 1; return acc; }, {}) : {},
  };
}

function buildHealthSnapshot(healthData) {
  if (!healthData) return { status: 'UNKNOWN' };
  const overall = healthData.overall || 0;
  return {
    status: overall >= 80 ? 'GREEN' : overall >= 50 ? 'YELLOW' : 'RED',
    overall,
    trend: healthData.trend || 'STABLE',
    factors: healthData.factors || [],
    criticalAlerts: healthData.criticalAlerts || 0,
  };
}

function buildAlertSnapshot(alerts) {
  if (Array.isArray(alerts)) {
    const open = alerts.filter((a) => !a.resolved);
    const critical = open.filter((a) => a.severity === 'critical');
    const warning = open.filter((a) => a.severity === 'warning');
    return {
      total: alerts.length,
      open: open.length,
      critical: critical.length,
      warning: warning.length,
      status: critical.length > 0 ? 'RED' : warning.length > 0 ? 'YELLOW' : 'GREEN',
    };
  }
  const obj = alerts || {};
  return {
    total: obj.total || 0,
    open: obj.open || 0,
    critical: obj.critical || 0,
    warning: obj.warning || 0,
    status: (obj.critical || 0) > 0 ? 'RED' : (obj.warning || 0) > 0 ? 'YELLOW' : 'GREEN',
  };
}

function buildMaintenanceSnapshot(maintenanceList) {
  const high = (maintenanceList || []).filter((m) => m.riskScore > 70);
  const medium = (maintenanceList || []).filter((m) => m.riskScore > 30);
  return {
    status: high.length > 0 ? 'RED' : medium.length > 0 ? 'YELLOW' : 'GREEN',
    highRiskCount: high.length,
    mediumRiskCount: medium.length,
    items: (maintenanceList || []).map((m) => ({
      stationId: m.stationId,
      stationName: m.stationName,
      riskScore: m.riskScore,
      failureProbability: m.failureProbability,
      recommendation: m.recommendation,
      predictedWindow: m.predictedWindow,
    })),
  };
}

function buildMLSnapshot(mlStatus) {
  if (!mlStatus) return { status: 'GRAY' };
  const health = mlStatus.serviceHealth || require('./ml').deriveHealthFromState(mlStatus);
  return {
    status: health,
    evaluation: mlStatus.evaluationStatus || 'PENDING',
    modelType: mlStatus.modelType,
    metrics: mlStatus.metrics,
    drift: mlStatus.drift,
    latency: mlStatus.latency,
    threshold: mlStatus.threshold,
  };
}

function buildRAGSnapshot(knowledgeStats) {
  if (!knowledgeStats) return { status: 'GRAY', documents: 0, chunks: 0, ready: 0, failed: 0 };
  const ready = knowledgeStats.ready || 0;
  const failed = knowledgeStats.failed || 0;
  const documents = knowledgeStats.documents || 0;
  const chunks = knowledgeStats.chunks || 0;
  const mode = knowledgeStats.mode || 'unknown';
  const embeddingBackend = knowledgeStats.embeddingBackend || 'none';
  const semanticQuality = knowledgeStats.semanticQuality || 'unknown';
  let status = knowledgeStats.status || 'GRAY';
  if (typeof status !== 'string' || !['GREEN','YELLOW','RED','GRAY'].includes(status)) {
    if (failed > 0 && ready === 0) status = 'RED';
    else if (ready > 0) status = 'GREEN';
    else if (documents > 0) status = 'YELLOW';
    else status = 'GRAY';
  }
  return { status, documents, chunks, ready, failed, mode, embeddingBackend, semanticQuality };
}

function buildAgentSnapshot(agentStatus) {
  return {
    status: agentStatus || 'GRAY',
    activeInvestigations: 0,
    toolCalls: 0,
    latency: null,
  };
}

function createSnapshot(ctx) {
  const ingestion = typeof ctx.ingestion === 'object' ? ctx.ingestion : { lastTickAt: ctx.lastTickAt, tickCount: ctx.tickCount };
  return {
    id: `SNAP-${Date.now()}-${randomUUID().slice(0, 6)}`,
    timestamp: new Date().toISOString(),
    providers: buildProviderSnapshot(ctx.providers),
    ingestion: buildIngestionSnapshot(ingestion.lastTickAt, ingestion.tickCount),
    dataQuality: buildDataQualitySnapshot(ctx.qualitySnapshot || ctx.dataQuality),
    stations: buildStationSnapshot(ctx.stations, ctx.latestByStation),
    anomalies: buildAnomalySnapshot(ctx.anomalies),
    health: buildHealthSnapshot(ctx.healthData),
    alerts: buildAlertSnapshot(ctx.alerts),
    maintenance: buildMaintenanceSnapshot(ctx.maintenanceList),
    architecture: ctx.architecture || null,
    ml: buildMLSnapshot(ctx.mlStatus || ctx.ml),
    rag: buildRAGSnapshot(ctx.knowledgeStats || ctx.rag),
    agent: buildAgentSnapshot(ctx.agentStatus),
  };
}

function diffSnapshots(prev, curr) {
  if (!prev) return { events: [{ type: 'SNAPSHOT.INITIAL', severity: 'INFO', summary: 'Initial snapshot created' }], changes: [] };
  const changes = [];
  const sections = ['providers', 'ingestion', 'dataQuality', 'stations', 'anomalies', 'health', 'alerts', 'maintenance', 'architecture', 'ml', 'rag', 'agent'];
  for (const section of sections) {
    const prevVal = prev[section];
    const currVal = curr[section];
    const change = classifyChange(prevVal, currVal, section);
    if (change !== 'UNCHANGED') {
      changes.push({ section, change, prev: prevVal, curr: currVal });
    }
  }
  const events = changes.map((c) => {
    let severity = 'INFO';
    if (c.change === 'DEGRADED' || c.change === 'FAILED') severity = 'WARNING';
    if (c.change === 'RECOVERED') severity = 'INFO';
    if (c.section === 'alerts' && c.curr && c.curr.critical > 0) severity = 'CRITICAL';
    if (c.section === 'health' && c.curr && c.curr.status === 'RED') severity = 'CRITICAL';
    if (c.section === 'maintenance' && c.curr && c.curr.status === 'RED') severity = 'HIGH';
    return {
      id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
      type: `SNAPSHOT.${c.section.toUpperCase()}.${c.change.toLowerCase()}`,
      category: c.section,
      severity,
      summary: `${c.section} ${c.change.toLowerCase()}: ${JSON.stringify(c.curr).slice(0, 200)}`,
      timestamp: curr.timestamp,
      change: c.change,
    };
  });
  return { events, changes };
}

module.exports = { createSnapshot, diffSnapshots, classifyChange, buildProviderSnapshot, buildIngestionSnapshot, buildDataQualitySnapshot, buildStationSnapshot, buildAnomalySnapshot, buildHealthSnapshot, buildAlertSnapshot, buildMaintenanceSnapshot, buildMLSnapshot, buildRAGSnapshot, buildAgentSnapshot };
