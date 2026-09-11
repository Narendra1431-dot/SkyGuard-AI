'use strict';

const { randomUUID } = require('crypto');
const { maintenanceRisk, healthScore } = require('../ai');
const { insertRecord, latestPerStation, historyForStation } = require('../db/maintenance');
const alertsDb = require('../db/alerts');

const MODEL_TYPE = 'HEURISTIC BASELINE';

function failureProbability(riskScore) {
  // Sigmoid mapping; risk 0 -> ~5%, risk 100 -> ~95%
  const x = (riskScore - 50) / 15;
  const p = 1 / (1 + Math.exp(-x));
  return +(p * 100).toFixed(2);
}

function factors(reading) {
  const out = [];
  if (!reading) return out;
  if (reading.aqi > 150) out.push({ name: 'High AQI', weight: 0.30 });
  if (reading.temperature > 38) out.push({ name: 'High temperature', weight: 0.25 });
  if (reading.humidity < 35) out.push({ name: 'Low humidity', weight: 0.15 });
  if (reading.wind > 10) out.push({ name: 'High wind', weight: 0.10 });
  if (reading.rainfall > 3) out.push({ name: 'Rainfall surge', weight: 0.10 });
  if (Math.abs(reading.pressure - 1012) > 10) out.push({ name: 'Pressure drift', weight: 0.10 });
  return out;
}

function recommendation(riskScore) {
  if (riskScore > 70) return 'Schedule maintenance within 24 hours. Replace sensor cluster and verify enclosure integrity.';
  if (riskScore > 50) return 'Inspect within 3 days. Recalibrate AQI/temperature modules.';
  if (riskScore > 30) return 'Plan routine maintenance this week.';
  return 'Continue normal operation; next routine check in 30 days.';
}

function predictedWindow(riskScore) {
  if (riskScore > 70) return '0-24 hours';
  if (riskScore > 50) return '1-3 days';
  if (riskScore > 30) return '3-7 days';
  return '> 30 days';
}

function mtbfHours(reading, failureCount) {
  // Crude MTBF approximation: high failure count + bad readings reduce MTBF
  const base = 8760; // 1 year nominal
  const health = reading ? healthScore(reading) : 50;
  const factor = Math.max(0.05, health / 100);
  return +(base * factor - failureCount * 50).toFixed(1);
}

function estimatedCost(riskScore) {
  if (riskScore > 70) return 1200;
  if (riskScore > 50) return 650;
  if (riskScore > 30) return 250;
  return 75;
}

async function buildRecordForStation(station, reading, store) {
  const riskScore = maintenanceRisk(reading || {}, 0);
  const failureProb = failureProbability(riskScore);
  const rec = {
    id: `MR-${Date.now()}-${station.id}-${randomUUID().slice(0, 4)}`,
    stationId: station.id,
    stationName: station.name,
    riskScore,
    failureProbability: failureProb,
    factors: factors(reading),
    recommendation: recommendation(riskScore),
    predictedWindow: predictedWindow(riskScore),
    mtbfHours: mtbfHours(reading, 0),
    estimatedCost: estimatedCost(riskScore),
    downtimeHours: 0,
    failureCount: 0,
    modelType: MODEL_TYPE,
    recordedAt: new Date().toISOString(),
  };
  // count historical failures from alerts DB
  if (alertsDb.listAlerts) {
    try {
      const all = await alertsDb.listAlerts({ stationId: station.id, limit: 1000 });
      rec.failureCount = all.filter((a) => a.severity === 'critical').length;
      rec.downtimeHours = +(rec.failureCount * 0.5).toFixed(2);
    } catch (_) { /* ignore */ }
  }
  return rec;
}

async function computeAndPersistAll(stations, store) {
  const out = [];
  for (const station of stations) {
    const latest = (await store.latestPerStation()).find((r) => r.stationId === station.id) || null;
    const rec = await buildRecordForStation(station, latest, store);
    out.push(rec);
    try { await insertRecord(rec); } catch (_) { /* ignore */ }
  }
  return out;
}

async function getLatest() {
  try { return await latestPerStation(); } catch (_) { return []; }
}

async function getHistory(stationId) {
  try { return await historyForStation(stationId, 50); } catch (_) { return []; }
}

module.exports = { buildRecordForStation, computeAndPersistAll, getLatest, getHistory, MODEL_TYPE };
