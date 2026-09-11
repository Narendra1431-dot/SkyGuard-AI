'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { insertReport, updateReport, listReports, getReport, deleteReport, REPORTS_DIR, ensureDir } = require('../db/reports');
const { paramCode } = require('../ai');

const CATEGORIES = ['environmental_summary', 'anomaly', 'station_health', 'predictive_maintenance', 'historical_analytics', 'data_quality'];

function buildCsv(rows) {
  if (!rows || !rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v == null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => escape(r[h])).join(','));
  return lines.join('\n');
}

function jsonReplacer(k, v) {
  if (v instanceof Date) return v.toISOString();
  return v;
}

async function generate(params, store, stations, stationMap, ctx) {
  ensureDir();
  const id = params.id || `RPT-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const requestedBy = params.requestedBy || null;
  const format = (params.format || 'json').toLowerCase();
  const category = params.category;

  const record = {
    id, category, title: params.title || titleFor(category),
    status: 'running', format, params, requestedBy,
    createdAt: new Date().toISOString(),
  };
  try { await insertReport(record); } catch (_) { /* PG may be disabled */ }

  try {
    const built = await buildPayload(category, params, store, stations, stationMap, ctx);
    const filename = `${id}.${format}`;
    const filePath = path.join(REPORTS_DIR, filename);
    let content;
    if (format === 'csv') content = buildCsv(built.rows || []);
    else content = JSON.stringify({ id, category, generatedAt: new Date().toISOString(), summary: built.summary, rows: built.rows }, jsonReplacer, 2);
    fs.writeFileSync(filePath, content, 'utf8');
    const fileSize = fs.statSync(filePath).size;
    const completedAt = new Date().toISOString();
    const patch = {
      status: 'completed',
      filePath: filename,
      fileSize,
      rowCount: (built.rows || []).length,
      summary: built.summary,
      completedAt,
    };
    try { await updateReport(id, patch); } catch (_) {}
    return { ...record, ...patch, summary: built.summary };
  } catch (e) {
    const patch = { status: 'failed', error: e.message, completedAt: new Date().toISOString() };
    try { await updateReport(id, patch); } catch (_) {}
    return { ...record, ...patch };
  }
}

function titleFor(category) {
  return {
    environmental_summary: 'Environmental Summary',
    anomaly: 'Anomaly Report',
    station_health: 'Station Health Report',
    predictive_maintenance: 'Predictive Maintenance Report',
    historical_analytics: 'Historical Analytics',
    data_quality: 'Data Quality Report',
  }[category] || 'Report';
}

async function buildPayload(category, params, store, stations, stationMap, ctx) {
  switch (category) {
    case 'environmental_summary': return environmentalSummary(store, stations, stationMap);
    case 'anomaly': return anomalyReport(store, stationMap, params);
    case 'station_health': return stationHealthReport(stations, store, ctx);
    case 'predictive_maintenance': return maintenanceReport(ctx);
    case 'historical_analytics': return historicalAnalytics(store, params);
    case 'data_quality': return dataQualityReport(ctx);
    default: throw new Error(`Unknown report category: ${category}`);
  }
}

async function environmentalSummary(store, stations, stationMap) {
  const latest = await store.latestPerStation();
  const byId = new Map(latest.map((r) => [r.stationId, r]));
  const rows = stations.map((s) => {
    const r = byId.get(s.id);
    return {
      station: s.name, id: s.id, lat: s.lat, lon: s.lon,
      temperature: r?.temperature, pressure: r?.pressure, humidity: r?.humidity,
      aqi: r?.aqi, wind: r?.wind, rainfall: r?.rainfall, time: r?.time,
    };
  });
  const avg = (k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v != null);
    return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null;
  };
  return {
    summary: {
      stationCount: stations.length,
      avgTemperature: avg('temperature'),
      avgPressure: avg('pressure'),
      avgHumidity: avg('humidity'),
      avgAqi: avg('aqi'),
    },
    rows,
  };
}

async function anomalyReport(store, stationMap, params = {}) {
  const minutes = Math.min(params.minutes || 24 * 60, 7 * 24 * 60);
  const readings = await store.recentReadings(minutes);
  const filtered = params.stationId ? readings.filter((r) => r.stationId === params.stationId) : readings;
  const rows = filtered.filter((r) => r.anomaly === 1).map((r) => {
    const a = paramCode(r);
    return {
      time: r.time, stationId: r.stationId, station: stationMap.get(r.stationId)?.name || r.stationId,
      aqi: r.aqi, temperature: r.temperature, humidity: r.humidity, wind: r.wind, rainfall: r.rainfall,
      severity: a.anomaly && (r.aqi > 250 || r.temperature > 42) ? 'critical' : 'warning',
      reasons: (a.reasons || []).join('; '),
    };
  });
  return { summary: { total: rows.length, windowMinutes: minutes }, rows };
}

async function stationHealthReport(stations, store, ctx) {
  const { healthScore } = require('../ai');
  const latest = await store.latestPerStation();
  const byId = new Map(latest.map((r) => [r.stationId, r]));
  const rows = stations.map((s) => {
    const r = byId.get(s.id);
    return {
      station: s.name, id: s.id,
      healthScore: r ? healthScore(r) : 0,
      aqi: r?.aqi, temperature: r?.temperature, humidity: r?.humidity, pressure: r?.pressure,
      time: r?.time,
    };
  });
  const avg = rows.reduce((s, r) => s + r.healthScore, 0) / Math.max(1, rows.length);
  return { summary: { average: +avg.toFixed(2), count: rows.length }, rows };
}

async function maintenanceReport(ctx) {
  const list = ctx.maintenance || [];
  return { summary: { count: list.length }, rows: list.map((r) => ({
    station: r.stationName || r.stationId,
    riskScore: r.riskScore,
    failureProbability: r.failureProbability,
    predictedWindow: r.predictedWindow,
    recommendation: r.recommendation,
    mtbfHours: r.mtbfHours,
    estimatedCost: r.estimatedCost,
    modelType: r.modelType,
  })) };
}

async function historicalAnalytics(store, params = {}) {
  const minutes = Math.min(params.minutes || 24 * 60, 7 * 24 * 60);
  const readings = await store.recentReadings(minutes);
  const grouped = new Map();
  for (const r of readings) {
    const key = r.stationId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(r);
  }
  const rows = [];
  for (const [stationId, list] of grouped) {
    if (params.stationId && params.stationId !== stationId) continue;
    const anomalies = list.filter((r) => r.anomaly === 1).length;
    rows.push({
      stationId,
      samples: list.length,
      avgTemperature: +(list.reduce((s, r) => s + r.temperature, 0) / list.length).toFixed(2),
      avgAqi: +(list.reduce((s, r) => s + r.aqi, 0) / list.length).toFixed(2),
      avgHumidity: +(list.reduce((s, r) => s + r.humidity, 0) / list.length).toFixed(2),
      anomalies,
      anomalyRate: +(anomalies / list.length * 100).toFixed(2),
    });
  }
  return { summary: { windowMinutes: minutes, stationCount: rows.length }, rows };
}

async function dataQualityReport(ctx) {
  const snap = ctx.quality;
  if (!snap) return { summary: { error: 'no quality snapshot available' }, rows: [] };
  const per = Object.entries(snap.perParameter || {}).map(([k, v]) => ({ parameter: k, ...v }));
  return {
    summary: {
      computedAt: snap.computedAt,
      completeness: snap.completeness,
      validity: snap.validity,
      accuracy: snap.accuracy,
      overallScore: snap.overallScore,
    },
    rows: per,
  };
}

async function list({ limit, category, status } = {}) {
  try { return await listReports({ limit, category, status }); } catch (_) { return []; }
}
async function get(id) { try { return await getReport(id); } catch (_) { return null; } }
async function remove(id) { try { return await deleteReport(id); } catch (_) { return false; } }

module.exports = { generate, list, get, remove, CATEGORIES, REPORTS_DIR };
