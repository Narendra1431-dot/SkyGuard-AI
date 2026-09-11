'use strict';

const { recentIssues, insertSnapshot, insertIssue, listSnapshots } = require('../db/quality');
const pg = require('../db/pg');

const RANGES = {
  temperature: { min: -20, max: 60 },
  pressure: { min: 870, max: 1085 },
  humidity: { min: 0, max: 100 },
  aqi: { min: 0, max: 1000 },
  wind: { min: 0, max: 80 },
  rainfall: { min: 0, max: 500 },
};

function assessReading(reading) {
  const issues = [];
  for (const [k, r] of Object.entries(RANGES)) {
    const v = reading[k];
    if (v == null || Number.isNaN(v)) {
      issues.push({ parameter: k, issueType: 'missing', severity: 'warning', detail: `${k} is missing/NaN` });
    } else if (v < r.min || v > r.max) {
      issues.push({ parameter: k, issueType: 'out_of_range', severity: 'critical', detail: `${k}=${v} outside [${r.min}, ${r.max}]` });
    }
  }
  return issues;
}

function detectDuplicates(readings) {
  // duplicates = same (stationId, rounded values) within 1s
  const seen = new Map();
  let count = 0;
  const rounded = (value, digits) => value == null || Number.isNaN(value) ? 'null' : Number(value).toFixed(digits);
  for (const r of readings) {
    const key = `${r.stationId}|${rounded(r.temperature, 1)}|${rounded(r.pressure, 1)}|${rounded(r.humidity, 1)}|${r.aqi == null ? 'null' : r.aqi}|${rounded(r.wind, 1)}|${rounded(r.rainfall, 2)}`;
    const ts = new Date(r.time).getTime();
    if (seen.has(key) && Math.abs(seen.get(key) - ts) < 1500) count += 1;
    else seen.set(key, ts);
  }
  return count;
}

function perParameterQuality(readings) {
  const out = {};
  for (const k of Object.keys(RANGES)) {
    let total = 0, valid = 0, inRange = 0, missing = 0;
    for (const r of readings) {
      total += 1;
      const v = r[k];
      if (v == null || Number.isNaN(v)) { missing += 1; continue; }
      valid += 1;
      if (v >= RANGES[k].min && v <= RANGES[k].max) inRange += 1;
    }
    out[k] = {
      total,
      valid,
      missing,
      inRange,
      validity: total ? +(valid / total * 100).toFixed(2) : 0,
      rangeCompliance: valid ? +(inRange / valid * 100).toFixed(2) : 0,
    };
  }
  return out;
}

async function computeSnapshot({ store, stations, lastTickAt }) {
  const readings = await store.recentReadings(60);
  const total = readings.length;
  const validReadings = readings.filter((r) => !Number.isNaN(r.temperature) && !Number.isNaN(r.aqi));
  const missing = total - validReadings.length;
  const dups = detectDuplicates(readings);
  let outOfRange = 0;
  const issues = [];
  for (const r of readings) {
    const iss = assessReading(r);
    for (const i of iss) {
      if (i.issueType === 'out_of_range') outOfRange += 1;
      issues.push({ ...i, stationId: r.stationId, detectedAt: r.time });
    }
  }
  if (issues.length && pg.isEnabled()) {
    // Persist up to 50 most recent issues
    for (const issue of issues.slice(-50)) {
      try { await insertIssue(issue); } catch (_) { /* ignore */ }
    }
  }
  const per = perParameterQuality(readings);
  // ingest rate per minute (last 5m)
  const recent5 = await store.recentReadings(5);
  const ingestionRate = +(recent5.length / 5).toFixed(2);
  // latency: avg time between consecutive readings per station
  const byStation = new Map();
  for (const r of [...readings].reverse()) {
    if (!byStation.has(r.stationId)) byStation.set(r.stationId, []);
    byStation.get(r.stationId).push(new Date(r.time).getTime());
  }
  let latSum = 0, latCount = 0;
  for (const arr of byStation.values()) {
    arr.sort((a, b) => a - b);
    for (let i = 1; i < arr.length; i += 1) { const d = arr[i] - arr[i - 1]; if (d > 0) { latSum += d; latCount += 1; } }
  }
  const latencyMs = latCount ? +(latSum / latCount).toFixed(2) : 0;
  // freshness: seconds since last reading
  const lastTime = lastTickAt ? new Date(lastTickAt).getTime() : (readings[0] ? new Date(readings[0].time).getTime() : Date.now());
  const freshnessSeconds = +((Date.now() - lastTime) / 1000).toFixed(2);
  const completeness = total ? +(validReadings.length / total * 100).toFixed(2) : 0;
  const validity = total ? +((validReadings.length - outOfRange) / total * 100).toFixed(2) : 0;
  // Accuracy approximated as range compliance of valid readings.
  const accuracy = validReadings.length
    ? +((validReadings.length - outOfRange) / validReadings.length * 100).toFixed(2)
    : 0;
  const overall = +((completeness * 0.4 + validity * 0.4 + accuracy * 0.2)).toFixed(2);

  const snap = {
    ingestionRate,
    recordsAccepted: validReadings.length,
    recordsRejected: missing,
    duplicates: dups,
    outOfRange,
    missing,
    latencyMs,
    freshnessSeconds,
    completeness,
    validity,
    accuracy,
    overallScore: overall,
    perParameter: per,
    issuesCount: issues.length,
    issues,
    computedAt: new Date().toISOString(),
  };
  if (pg.isEnabled()) {
    try { await insertSnapshot(snap); } catch (_) { /* ignore */ }
  }
  return snap;
}

async function history() {
  return listSnapshots(200);
}

async function issues() {
  return recentIssues(200);
}

module.exports = { computeSnapshot, history, issues };
