'use strict';

const pg = require('./pg');

const memStore = { runs: [] };

async function insertRun(run) {
  const existing = memStore.runs.find((r) => r.id === run.id);
  if (existing) Object.assign(existing, run);
  else memStore.runs.unshift({ ...run });
  if (memStore.runs.length > 50) memStore.runs.length = 50;
  if (pg.isEnabled()) {
    try {
      await pg.query(
        `INSERT INTO ml_runs (id, model_type, status, started_at, completed_at, metrics, confusion_matrix, roc, feature_importance, drift, latency_ms, threshold, notes, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, completed_at=EXCLUDED.completed_at,
           metrics=EXCLUDED.metrics, confusion_matrix=EXCLUDED.confusion_matrix, roc=EXCLUDED.roc,
           feature_importance=EXCLUDED.feature_importance, drift=EXCLUDED.drift,
           latency_ms=EXCLUDED.latency_ms, threshold=EXCLUDED.threshold, notes=EXCLUDED.notes`,
        [
          run.id, run.modelType || 'HEURISTIC BASELINE', run.status,
          run.startedAt, run.completedAt || null,
          JSON.stringify(run.metrics || {}), JSON.stringify(run.confusionMatrix || {}),
          JSON.stringify(run.roc || {}), JSON.stringify(run.featureImportance || []),
          JSON.stringify(run.drift || {}), JSON.stringify(run.latency || {}),
          JSON.stringify(run.threshold || {}), run.notes || null,
          run.requestedBy || null,
        ]
      );
    } catch (_) { /* ignore */ }
  }
}

async function latestRun() {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(`SELECT * FROM ml_runs ORDER BY started_at DESC LIMIT 1`);
      if (r.rows[0]) return r.rows[0];
    } catch (_) { /* fall through */ }
  }
  return memStore.runs[0] || null;
}

async function listRuns(limit = 20) {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(`SELECT id, model_type AS "modelType", status, started_at AS "startedAt",
        completed_at AS "completedAt", metrics, requested_by AS "requestedBy"
        FROM ml_runs ORDER BY started_at DESC LIMIT $1`, [Math.min(limit, 200)]);
      if (r.rows.length) return r.rows;
    } catch (_) { /* fall through */ }
  }
  return memStore.runs.slice(0, limit).map((r) => ({
    id: r.id, modelType: r.modelType, status: r.status,
    startedAt: r.startedAt, completedAt: r.completedAt, metrics: r.metrics, requestedBy: r.requestedBy,
  }));
}

module.exports = { insertRun, latestRun, listRuns };
