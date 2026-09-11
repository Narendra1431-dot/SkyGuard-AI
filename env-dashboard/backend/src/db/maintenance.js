'use strict';

const pg = require('./pg');

const memStore = { byKey: new Map() }; // key = stationId -> latest record

function memInsert(rec) { memStore.byKey.set(rec.stationId, rec); }
function memLatest() { return [...memStore.byKey.values()]; }
function memHistory(stationId, limit = 50) {
  // Without per-station history in memory we just return latest
  return memStore.byKey.has(stationId) ? [memStore.byKey.get(stationId)] : [];
}

async function insertRecord(rec) {
  memInsert(rec);
  if (pg.isEnabled()) {
    try {
      await pg.query(
        `INSERT INTO maintenance_records
          (id, station_id, station_name, risk_score, failure_probability, factors, recommendation, predicted_window, mtbf_hours, estimated_cost, downtime_hours, failure_count, model_type, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          rec.id, rec.stationId, rec.stationName || null, rec.riskScore, rec.failureProbability,
          JSON.stringify(rec.factors || []), rec.recommendation, rec.predictedWindow,
          rec.mtbfHours, rec.estimatedCost, rec.downtimeHours || 0, rec.failureCount || 0,
          rec.modelType || 'HEURISTIC BASELINE', rec.recordedAt || new Date().toISOString(),
        ]
      );
    } catch (_) { /* ignore */ }
  }
}

async function latestPerStation() {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(`
        SELECT DISTINCT ON (station_id) *
        FROM maintenance_records
        ORDER BY station_id, recorded_at DESC
      `);
      if (r.rows.length) return r.rows;
    } catch (_) { /* fall through */ }
  }
  return memLatest();
}

async function historyForStation(stationId, limit = 50) {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(
        `SELECT * FROM maintenance_records WHERE station_id = $1 ORDER BY recorded_at DESC LIMIT $2`,
        [stationId, Math.min(limit, 500)]
      );
      if (r.rows.length) return r.rows;
    } catch (_) { /* fall through */ }
  }
  return memHistory(stationId, limit);
}

module.exports = { insertRecord, latestPerStation, historyForStation };
