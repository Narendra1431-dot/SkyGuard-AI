'use strict';

/**
 * Advanced analytics V5
 *
 *  - rolling averages per station per field
 *  - baselines (24h mean/std)
 *  - z-score / deviation
 *  - rate-of-change per field per station
 *  - temporal patterns (per hour / per day)
 *  - station clustering (k-means-lite on field means)
 *  - cross-parameter correlation (Pearson)
 *  - spatial deviations
 *  - anomaly density
 */

const FIELDS = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'];

function rollingAverage(points, windowSize) {
  const out = [];
  for (let i = 0; i < points.length; i += 1) {
    const start = Math.max(0, i - windowSize + 1);
    const slice = points.slice(start, i + 1);
    const avg = slice.reduce((s, p) => s + p.v, 0) / slice.length;
    out.push({ t: points[i].t, v: +avg.toFixed(3) });
  }
  return out;
}

function baseline(points) {
  const valid = points.filter((p) => p.v != null && !Number.isNaN(p.v));
  if (!valid.length) return { mean: null, std: null };
  const mean = valid.reduce((s, p) => s + p.v, 0) / valid.length;
  const variance = valid.reduce((s, p) => s + (p.v - mean) ** 2, 0) / valid.length;
  return { mean: +mean.toFixed(3), std: +Math.sqrt(variance).toFixed(3) };
}

function zScore(value, baseline) {
  if (baseline.std == null || baseline.std === 0) return null;
  return +(((value - baseline.mean) / baseline.std)).toFixed(3);
}

function rateOfChange(points, minutes = 5) {
  const out = [];
  for (let i = 1; i < points.length; i += 1) {
    const dt = (new Date(points[i].t).getTime() - new Date(points[i - 1].t).getTime()) / 60000;
    if (dt <= 0) continue;
    const slope = (points[i].v - points[i - 1].v) / dt;
    out.push({ t: points[i].t, v: +slope.toFixed(4) });
  }
  return out;
}

function pearson(a, b) {
  const pairs = [];
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]; const bv = b[i];
    if (av != null && bv != null && !Number.isNaN(av) && !Number.isNaN(bv)) pairs.push([av, bv]);
  }
  if (pairs.length < 3) return 0;
  const n = pairs.length;
  const sa = pairs.reduce((s, [x]) => s + x, 0);
  const sb = pairs.reduce((s, [, y]) => s + y, 0);
  const ma = sa / n; const mb = sb / n;
  let num = 0; let denA = 0; let denB = 0;
  for (const [x, y] of pairs) {
    const dx = x - ma; const dy = y - mb;
    num += dx * dy; denA += dx * dx; denB += dy * dy;
  }
  if (denA === 0 || denB === 0) return 0;
  return +(num / Math.sqrt(denA * denB)).toFixed(3);
}

function crossParameterCorrelation(readings) {
  const series = {};
  for (const f of FIELDS) series[f] = [];
  for (const r of readings) {
    for (const f of FIELDS) series[f].push(r[f]);
  }
  const out = [];
  for (let i = 0; i < FIELDS.length; i += 1) {
    for (let j = i + 1; j < FIELDS.length; j += 1) {
      const a = FIELDS[i]; const b = FIELDS[j];
      const corr = pearson(series[a], series[b]);
      if (Math.abs(corr) >= 0.05) out.push({ a, b, correlation: corr });
    }
  }
  return out.sort((x, y) => Math.abs(y.correlation) - Math.abs(x.correlation)).slice(0, 12);
}

function hourlyPattern(readings) {
  const buckets = Array.from({ length: 24 }, () => ({ total: 0, anomalies: 0 }));
  for (const r of readings) {
    const hour = new Date(r.time).getUTCHours();
    buckets[hour].total += 1;
    if (r.anomaly === 1) buckets[hour].anomalies += 1;
  }
  return buckets.map((b, hour) => ({ hour, rate: b.total ? +(b.anomalies / b.total * 100).toFixed(2) : 0, total: b.total, anomalies: b.anomalies }));
}

function weekdayPattern(readings) {
  const buckets = Array.from({ length: 7 }, () => ({ total: 0, anomalies: 0 }));
  for (const r of readings) {
    const d = (new Date(r.time).getUTCDay() + 6) % 7; // Monday=0
    buckets[d].total += 1;
    if (r.anomaly === 1) buckets[d].anomalies += 1;
  }
  return buckets.map((b, idx) => ({ day: idx, rate: b.total ? +(b.anomalies / b.total * 100).toFixed(2) : 0, total: b.total, anomalies: b.anomalies }));
}

function kmeansLite(stations, k = 3) {
  // 2-D k-means on lat/lon with a couple of field means
  if (stations.length === 0) return [];
  const points = stations.map((s) => [s.lat || 0, s.lon || 0]);
  const centroids = points.slice(0, Math.min(k, points.length)).map((p) => [...p]);
  while (centroids.length < k) centroids.push([Math.random() * 180 - 90, Math.random() * 360 - 180]);
  for (let iter = 0; iter < 8; iter += 1) {
    const assigns = points.map((p) => {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centroids.length; c += 1) {
        const d = (p[0] - centroids[c][0]) ** 2 + (p[1] - centroids[c][1]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    });
    const sums = centroids.map(() => ({ lat: 0, lon: 0, n: 0 }));
    for (let i = 0; i < points.length; i += 1) {
      sums[assigns[i]].lat += points[i][0];
      sums[assigns[i]].lon += points[i][1];
      sums[assigns[i]].n += 1;
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (sums[c].n > 0) centroids[c] = [sums[c].lat / sums[c].n, sums[c].lon / sums[c].n];
    }
  }
  return centroids.map((c, idx) => ({ cluster: idx, lat: +c[0].toFixed(3), lon: +c[1].toFixed(3) }));
}

function anomalyDensity(readings) {
  // By hour and weekday
  const total = readings.length || 1;
  const anoms = readings.filter((r) => r.anomaly === 1).length;
  return {
    rate: +(anoms / total * 100).toFixed(2),
    total,
    anomalies: anoms,
  };
}

function stationBaselines(readings, stations) {
  const out = {};
  for (const s of stations) {
    const subset = readings.filter((r) => r.stationId === s.id);
    const entry = { stationId: s.id, station: s.name, fields: {} };
    for (const f of FIELDS) {
      const points = subset.filter((r) => r[f] != null).map((r) => ({ t: r.time, v: r[f] }));
      entry.fields[f] = { baseline: baseline(points), count: points.length };
    }
    out[s.id] = entry;
  }
  return out;
}

function spatialDeviations(readings, stations) {
  const out = [];
  for (const s of stations) {
    const subset = readings.filter((r) => r.stationId === s.id);
    if (!subset.length) continue;
    const latest = subset[subset.length - 1];
    const fleetAvg = FIELDS.reduce((acc, f) => {
      const vals = readings.filter((r) => r[f] != null).map((r) => r[f]);
      const mean = vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      return { ...acc, [f]: { value: latest[f], fleet: +mean.toFixed(2), deviation: +(latest[f] - mean).toFixed(2) } };
    }, {});
    out.push({ stationId: s.id, station: s.name, fields: fleetAvg });
  }
  return out;
}

function comprehensiveAnalytics(readings, stations) {
  return {
    counts: { total: readings.length, anomalies: readings.filter((r) => r.anomaly === 1).length },
    baselines: stationBaselines(readings, stations),
    crossParameter: crossParameterCorrelation(readings),
    hourly: hourlyPattern(readings),
    weekday: weekdayPattern(readings),
    clusters: kmeansLite(stations, 3),
    spatialDeviations: spatialDeviations(readings, stations),
    anomalyDensity: anomalyDensity(readings),
  };
}

function trendAnalysis(points) {
  const valid = points.filter((p) => p.v != null && !Number.isNaN(p.v));
  if (valid.length < 4) return { classification: 'insufficient_data', sampleCount: valid.length, slope: null, confidence: null };
  const n = valid.length;
  const times = valid.map((p) => new Date(p.t).getTime());
  const values = valid.map((p) => p.v);
  const t0 = times[0];
  const sumT = times.reduce((s, t) => s + (t - t0), 0);
  const sumV = values.reduce((s, v) => s + v, 0);
  const sumTT = times.reduce((s, t) => s + (t - t0) ** 2, 0);
  const sumTV = times.reduce((s, t, i) => s + (t - t0) * values[i], 0);
  const denom = n * sumTT - sumT ** 2;
  if (denom === 0) return { classification: 'stable', sampleCount: n, slope: 0, confidence: 0.5 };
  const slope = (n * sumTV - sumT * sumV) / denom;
  const meanV = sumV / n;
  const ssTot = values.reduce((s, v) => s + (v - meanV) ** 2, 0);
  const ssRes = values.reduce((s, v, i) => { const pred = meanV + slope * (times[i] - t0); return s + (v - pred) ** 2; }, 0);
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const absSlope = Math.abs(slope);
  const relSlope = meanV === 0 ? (absSlope === 0 ? 0 : Infinity) : absSlope / Math.abs(meanV);
  let classification = 'stable';
  if (relSlope > 0.05 && r2 > 0.3) classification = slope > 0 ? 'increasing' : 'decreasing';
  else if (relSlope <= 0.05 && r2 > 0.3) classification = 'stable';
  else classification = 'insufficient_data';
  return { classification, sampleCount: n, slope: +slope.toFixed(6), r2: +r2.toFixed(3), confidence: r2 > 0.6 ? 'high' : r2 > 0.3 ? 'medium' : 'low' };
}

function statisticalSummary(points) {
  const valid = points.filter((p) => p.v != null && !Number.isNaN(p.v)).map((p) => p.v);
  if (!valid.length) return { count: 0, min: null, max: null, mean: null, median: null, std: null, latest: null, available: false };
  const sorted = [...valid].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const sum = sorted.reduce((s, v) => s + v, 0);
  const mean = sum / sorted.length;
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / sorted.length;
  const std = Math.sqrt(variance);
  const latest = valid[valid.length - 1];
  return { count: sorted.length, min: +min.toFixed(3), max: +max.toFixed(3), mean: +mean.toFixed(3), median: +median.toFixed(3), std: +std.toFixed(3), latest: +latest.toFixed(3), available: true };
}

function stationComparisonByField(readings, stationIds, field, stationsList) {
  const validField = FIELDS.includes(field) ? field : 'temperature';
  const out = [];
  for (const id of stationIds) {
    const subset = readings.filter((r) => r.stationId === id && r[validField] != null && !Number.isNaN(r[validField]));
    if (!subset.length) continue;
    const values = subset.map((r) => r[validField]);
    const sum = values.reduce((s, v) => s + v, 0);
    const mean = sum / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    out.push({ stationId: id, station: (stationsList || []).find((s) => s.id === id)?.name || id, count: values.length, min: +min.toFixed(3), max: +max.toFixed(3), mean: +mean.toFixed(3), median: +median.toFixed(3), std: +std.toFixed(3), latest: +values[values.length - 1].toFixed(3) });
  }
  return out;
}

function parameterRanking(readings, stationsList, field) {
  const validField = FIELDS.includes(field) ? field : 'temperature';
  const stationStats = new Map();
  for (const r of readings) {
    if (r[validField] == null || Number.isNaN(r[validField])) continue;
    if (!stationStats.has(r.stationId)) stationStats.set(r.stationId, []);
    stationStats.get(r.stationId).push(r[validField]);
  }
  const out = [];
  for (const [id, values] of stationStats) {
    if (!values.length) continue;
    const sum = values.reduce((s, v) => s + v, 0);
    const mean = sum / values.length;
    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    out.push({ stationId: id, station: (stationsList || []).find((s) => s.id === id)?.name || id, count: values.length, min: +min.toFixed(3), max: +max.toFixed(3), mean: +mean.toFixed(3), median: +median.toFixed(3), std: +std.toFixed(3), latest: +values[values.length - 1].toFixed(3) });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out.map((item, idx) => ({ ...item, rank: idx + 1 }));
}

function environmentalRiskSummary(readings, alerts, qualitySnapshot) {
  const anomalyCount = readings.filter((r) => r.anomaly === 1).length;
  const totalReadings = readings.length || 1;
  const anomalyRate = +(anomalyCount / totalReadings * 100).toFixed(2);
  const openAlerts = (alerts || []).filter((a) => !a.resolved).length;
  const criticalAlerts = (alerts || []).filter((a) => a.severity === 'critical' && !a.resolved).length;
  const qualityScore = qualitySnapshot?.overallScore;
  const factors = [];
  if (anomalyRate > 10) factors.push({ name: 'High anomaly rate', value: `${anomalyRate}%`, severity: 'critical' });
  else if (anomalyRate > 5) factors.push({ name: 'Elevated anomaly rate', value: `${anomalyRate}%`, severity: 'warning' });
  if (criticalAlerts > 0) factors.push({ name: 'Critical alerts open', value: criticalAlerts, severity: 'critical' });
  else if (openAlerts > 0) factors.push({ name: 'Open alerts', value: openAlerts, severity: 'warning' });
  if (qualitySnapshot) {
    if (qualityScore != null && qualityScore < 50) factors.push({ name: 'Data quality degraded', value: `${qualityScore.toFixed(1)}%`, severity: 'critical' });
    else if (qualitySnapshot.outOfRange > 0) factors.push({ name: 'Out-of-range readings', value: qualitySnapshot.outOfRange, severity: 'warning' });
  }
  const recentReadings = readings.slice(-10);
  for (const r of recentReadings) {
    if (r.aqi > 250) factors.push({ name: 'Severe AQI', value: r.aqi, severity: 'critical', stationId: r.stationId });
    else if (r.aqi > 150) factors.push({ name: 'Unhealthy AQI', value: r.aqi, severity: 'warning', stationId: r.stationId });
    if (r.temperature > 42) factors.push({ name: 'Critical temperature', value: `${r.temperature}°C`, severity: 'critical', stationId: r.stationId });
    else if (r.temperature > 38) factors.push({ name: 'High temperature', value: `${r.temperature}°C`, severity: 'warning', stationId: r.stationId });
  }
  const maxSeverity = factors.some((f) => f.severity === 'critical') ? 'critical' : factors.some((f) => f.severity === 'warning') ? 'warning' : 'nominal';
  return { maxSeverity, factors: factors.slice(0, 15), anomalyRate, openAlerts, criticalAlerts, qualityScore: qualityScore != null ? +qualityScore.toFixed(1) : null, totalReadings, anomalyCount };
}

function dataForExport(readings, filters = {}) {
  let out = readings;
  if (filters.stationId) out = out.filter((r) => r.stationId === filters.stationId);
  if (filters.start) { const t = new Date(filters.start).getTime(); out = out.filter((r) => new Date(r.time).getTime() >= t); }
  if (filters.end) { const t = new Date(filters.end).getTime(); out = out.filter((r) => new Date(r.time).getTime() <= t); }
  if (filters.field && FIELDS.includes(filters.field)) out = out.map((r) => ({ time: r.time, stationId: r.stationId, [filters.field]: r[filters.field], anomaly: r.anomaly }));
  return out;
}

function toCSV(data, fields) {
  if (!data.length) return '';
  const cols = fields || Object.keys(data[0]);
  const header = cols.join(',');
  const rows = data.map((row) => cols.map((c) => {
    const v = row[c];
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','));
  return [header, ...rows].join('\n');
}

module.exports = {
  rollingAverage,
  baseline,
  zScore,
  rateOfChange,
  pearson,
  crossParameterCorrelation,
  hourlyPattern,
  weekdayPattern,
  kmeansLite,
  anomalyDensity,
  stationBaselines,
  spatialDeviations,
  comprehensiveAnalytics,
  trendAnalysis,
  statisticalSummary,
  stationComparisonByField,
  parameterRanking,
  environmentalRiskSummary,
  dataForExport,
  toCSV,
  FIELDS,
};