'use strict';

const { paramCode, healthScore } = require('../ai');

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.floor((i + 1) * step);
    const slice = points.slice(start, end);
    if (!slice.length) continue;
    const avg = slice.reduce((s, p) => s + p.v, 0) / slice.length;
    out.push({ t: slice[Math.floor(slice.length / 2)].t, v: +avg.toFixed(2) });
  }
  return out;
}

function filterByParams(readings, params) {
  let out = readings;
  if (params.stationId) out = out.filter((r) => r.stationId === params.stationId);
  if (params.start) { const t = new Date(params.start).getTime(); out = out.filter((r) => new Date(r.time).getTime() >= t); }
  if (params.end) { const t = new Date(params.end).getTime(); out = out.filter((r) => new Date(r.time).getTime() <= t); }
  return out;
}

function anomalyTrend(readings) {
  // Bucketed per hour
  const buckets = new Map();
  for (const r of readings) {
    const t = new Date(r.time);
    const key = `${t.getUTCFullYear()}-${t.getUTCMonth()}-${t.getUTCDate()}-${t.getUTCHours()}`;
    if (!buckets.has(key)) buckets.set(key, { t: t.toISOString(), total: 0, anomalies: 0 });
    const b = buckets.get(key);
    b.total += 1;
    if (r.anomaly === 1) b.anomalies += 1;
  }
  return [...buckets.values()].sort((a, b) => new Date(a.t) - new Date(b.t))
    .map((b) => ({ t: b.t, count: b.anomalies, rate: +(b.anomalies / b.total * 100).toFixed(2) }));
}

function anomalyDistribution(readings) {
  const types = new Map();
  for (const r of readings) {
    if (r.anomaly !== 1) continue;
    const a = paramCode(r);
    for (const f of a.factors || []) {
      types.set(f.name, (types.get(f.name) || 0) + 1);
    }
  }
  return [...types.entries()].map(([type, count]) => ({ type, count }));
}

function severityDistribution(readings) {
  const sev = { critical: 0, warning: 0, info: 0 };
  for (const r of readings) {
    if (r.anomaly !== 1) continue;
    if (r.aqi > 250 || r.temperature > 42 || r.humidity < 15) sev.critical += 1;
    else sev.warning += 1;
  }
  return Object.entries(sev).map(([severity, count]) => ({ severity, count }));
}

function topAnomalies(readings, n = 10) {
  return readings
    .filter((r) => r.anomaly === 1)
    .sort((a, b) => b.aqi - a.aqi)
    .slice(0, n)
    .map((r) => ({ time: r.time, stationId: r.stationId, aqi: r.aqi, temperature: r.temperature, wind: r.wind, rainfall: r.rainfall }));
}

function parameterTrend(readings, field = 'temperature', maxPoints = 200) {
  const sorted = [...readings].sort((a, b) => new Date(a.time) - new Date(b.time));
  return downsample(sorted.map((r) => ({ t: r.time, v: r[field] })), maxPoints);
}

function stationComparison(readings) {
  const map = new Map();
  for (const r of readings) {
    if (!map.has(r.stationId)) map.set(r.stationId, []);
    map.get(r.stationId).push(r);
  }
  return [...map.entries()].map(([stationId, list]) => ({
    stationId,
    avgTemperature: +(list.reduce((s, r) => s + r.temperature, 0) / list.length).toFixed(2),
    avgAqi: +(list.reduce((s, r) => s + r.aqi, 0) / list.length).toFixed(2),
    avgHumidity: +(list.reduce((s, r) => s + r.humidity, 0) / list.length).toFixed(2),
    avgPressure: +(list.reduce((s, r) => s + r.pressure, 0) / list.length).toFixed(2),
    avgWind: +(list.reduce((s, r) => s + r.wind, 0) / list.length).toFixed(2),
    anomalyCount: list.filter((r) => r.anomaly === 1).length,
  }));
}

function heatmap(readings) {
  // 24h x 7 day grid of anomaly counts
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of readings) {
    if (r.anomaly !== 1) continue;
    const t = new Date(r.time);
    const d = (t.getUTCDay() + 6) % 7; // Monday=0
    const h = t.getUTCHours();
    grid[d][h] += 1;
  }
  return grid;
}

function aggregateAll(readings, params) {
  const filtered = filterByParams(readings, params);
  return {
    counts: { total: filtered.length, anomalies: filtered.filter((r) => r.anomaly === 1).length },
    anomalyTrend: anomalyTrend(filtered),
    anomalyDistribution: anomalyDistribution(filtered),
    severityDistribution: severityDistribution(filtered),
    topAnomalies: topAnomalies(filtered, 10),
    parameterTrend: parameterTrend(filtered, params.field || 'temperature'),
    stationComparison: stationComparison(filtered),
    heatmap: heatmap(filtered),
  };
}

module.exports = { aggregateAll, parameterTrend, downsample };
