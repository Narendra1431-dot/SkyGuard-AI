'use strict';

const pg = require('./pg');
const { getMap } = require('../services/dataStore');

const RUNTIME_CACHE_LIMIT = 500;

const memStore = new Proxy({}, {
  get(_t, _k) { return getMap('alerts_runtime'); },
});

const alertsArchive = new Proxy({}, {
  get(_t, _k) { return getMap('alerts_archive'); },
});

async function insertAlert(a) {
  const normalized = { ...a, _resolvedAt: a.resolvedAt || null, _resolvedBy: a.resolvedBy || null };
  memStore.alerts.set(a.id, normalized);
  alertsArchive.alerts.set(a.id, normalized);
  const keys = memStore.alerts.keys();
  if (keys.length > RUNTIME_CACHE_LIMIT) {
    const sortedKeys = keys.sort((a, b) => {
      const alertA = memStore.alerts.get(a);
      const alertB = memStore.alerts.get(b);
      const dateA = alertA && alertA.timestamp ? new Date(alertA.timestamp) : new Date(0);
      const dateB = alertB && alertB.timestamp ? new Date(alertB.timestamp) : new Date(0);
      return dateB - dateA;
    });
    const toEvict = sortedKeys.slice(RUNTIME_CACHE_LIMIT);
    for (const k of toEvict) {
      memStore.alerts.delete(k);
    }
  }
  if (pg.isEnabled()) {
    try {
      await pg.query(
        `INSERT INTO alerts (id, station_id, station_name, severity, title, description, recommendation, factors, reading, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id, a.stationId, a.station, a.severity, a.title, a.description,
          a.recommendation, JSON.stringify(a.factors || []), JSON.stringify(a.reading || {}),
          a.timestamp || new Date().toISOString(),
        ]
      );
    } catch (_) { /* ignore */ }
  }
}

function memFilter(list, opts = {}) {
  let out = list;
  if (opts.severity) out = out.filter((a) => a.severity === opts.severity);
  if (opts.stationId) out = out.filter((a) => a.stationId === opts.stationId);
  if (opts.acknowledged !== undefined) out = out.filter((a) => !!a.acknowledged === !!opts.acknowledged);
  if (opts.resolved !== undefined) out = out.filter((a) => !!a.resolved === !!opts.resolved);
  return out;
}

function shape(a) {
  return {
    id: a.id,
    stationId: a.stationId,
    station: a.station,
    severity: a.severity,
    title: a.title,
    description: a.description,
    recommendation: a.recommendation,
    factors: a.factors || [],
    reading: a.reading || {},
    muted: !!a.muted,
    acknowledged: !!a.acknowledged,
    resolved: !!a.resolved,
    resolvedAt: a._resolvedAt || null,
    resolvedBy: a._resolvedBy || null,
    createdAt: a.timestamp || a.createdAt,
    updatedAt: a._updatedAt || a.timestamp || a.createdAt,
  };
}

function getAllFromStore(store) {
  return store.alerts.keys().map((k) => store.alerts.get(k)).filter(Boolean);
}

async function listAlerts(opts = {}) {
  const limit = Math.min(opts.limit || 200, 1000);
  if (pg.isEnabled()) {
    try {
      const conds = [];
      const params = [];
      if (opts.severity) { params.push(opts.severity); conds.push(`severity = $${params.length}`); }
      if (opts.stationId) { params.push(opts.stationId); conds.push(`station_id = $${params.length}`); }
      if (opts.acknowledged !== undefined) { params.push(opts.acknowledged); conds.push(`acknowledged = $${params.length}`); }
      if (opts.resolved !== undefined) { params.push(opts.resolved); conds.push(`resolved = $${params.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      params.push(limit);
      const r = await pg.query(
        `SELECT id, station_id AS "stationId", station_name AS "station", severity, title, description,
                recommendation, factors, reading, acknowledged, resolved,
                resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM alerts ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      if (r.rows.length) return r.rows;
    } catch (_) { /* fall through */ }
  }
  const memKeys = new Set(memStore.alerts.keys());
  const archiveKeys = new Set(alertsArchive.alerts.keys());
  const allKeys = new Set([...memKeys, ...archiveKeys]);
  const merged = [];
  const seen = new Set();
  for (const k of allKeys) {
    const fromMem = memStore.alerts.get(k);
    const fromArchive = alertsArchive.alerts.get(k);
    const alert = fromMem || fromArchive;
    if (alert && !seen.has(k)) {
      seen.add(k);
      merged.push(alert);
    }
  }
  return memFilter(merged.map(shape), opts).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

async function getAlert(id) {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(
        `SELECT id, station_id AS "stationId", station_name AS "station", severity, title, description,
                recommendation, factors, reading, acknowledged, resolved,
                resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM alerts WHERE id = $1`,
        [id]
      );
      if (r.rows[0]) return r.rows[0];
    } catch (_) { /* fall through */ }
  }
  const a = memStore.alerts.get(id) || alertsArchive.alerts.get(id);
  return a ? shape(a) : null;
}

async function acknowledgeAlert(id, user) {
  const a = memStore.alerts.get(id);
  if (!a) {
    const archiveA = alertsArchive.alerts.get(id);
    if (archiveA) {
      archiveA.acknowledged = true;
      archiveA._updatedAt = new Date().toISOString();
      if (user) archiveA._resolvedBy = user;
      alertsArchive.alerts.set(id, archiveA);
    }
  }
  if (!a && pg.isEnabled()) { const existing = await getAlert(id); if (!existing) return null; }
  if (!a && !pg.isEnabled()) return null;
  if (a) { a.acknowledged = true; a._updatedAt = new Date().toISOString(); if (user) a._resolvedBy = user; memStore.alerts.set(id, a); }
  if (pg.isEnabled()) {
    try { await pg.query('UPDATE alerts SET acknowledged = TRUE, updated_at = now(), resolved_by = COALESCE(resolved_by, $2) WHERE id = $1', [id, user || null]); } catch (_) {}
  }
  return { id, acknowledged: true };
}

async function resolveAlert(id, user) {
  const now = new Date().toISOString();
  const a = memStore.alerts.get(id);
  if (!a) {
    const archiveA = alertsArchive.alerts.get(id);
    if (archiveA) {
      archiveA.resolved = true;
      archiveA.acknowledged = true;
      archiveA._resolvedAt = now;
      archiveA._resolvedBy = user || 'system';
      archiveA._updatedAt = now;
      alertsArchive.alerts.set(id, archiveA);
    }
  }
  if (!a && pg.isEnabled()) { const existing = await getAlert(id); if (!existing) return null; }
  if (!a && !pg.isEnabled()) return null;
  if (a) { a.resolved = true; a.acknowledged = true; a._resolvedAt = now; a._resolvedBy = user || 'system'; a._updatedAt = now; memStore.alerts.set(id, a); }
  if (pg.isEnabled()) {
    try { await pg.query('UPDATE alerts SET resolved = TRUE, acknowledged = TRUE, resolved_at = now(), resolved_by = $2, updated_at = now() WHERE id = $1', [id, user || 'system']); } catch (_) {}
  }
  return { id, resolved: true, resolvedAt: now };
}

async function updateAlert(id, patch, user) {
  const a = memStore.alerts.get(id);
  if (!a) {
    const archiveA = alertsArchive.alerts.get(id);
    if (archiveA) { Object.assign(archiveA, patch); archiveA._updatedAt = new Date().toISOString(); if (user) archiveA._resolvedBy = user; alertsArchive.alerts.set(id, archiveA); }
  }
  if (!a && pg.isEnabled()) {
    const existing = await getAlert(id);
    if (!existing) return null;
  } else if (!a) return null;
  if (a) { Object.assign(a, patch); a._updatedAt = new Date().toISOString(); if (user) a._resolvedBy = user; memStore.alerts.set(id, a); }
  if (pg.isEnabled()) {
    const fields = []; const values = []; let i = 1;
    for (const [key, value] of Object.entries(patch)) { fields.push(`${key} = $${i++}`); values.push(value); }
    fields.push(`updated_at = now()`); values.push(id);
    try { await pg.query(`UPDATE alerts SET ${fields.join(', ')} WHERE id = $${i}`, values); } catch (_) {}
  }
  return { id, ...patch };
}

async function alertStats() {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE resolved = FALSE)::int AS open,
          COUNT(*) FILTER (WHERE acknowledged = TRUE AND resolved = FALSE)::int AS acknowledged,
          COUNT(*) FILTER (WHERE resolved = TRUE)::int AS resolved
        FROM alerts`);
      const sev = await pg.query(`
        SELECT severity, COUNT(*)::int AS count FROM alerts
        WHERE resolved = FALSE GROUP BY severity`);
      return { ...r.rows[0], bySeverity: Object.fromEntries(sev.rows.map((s) => [s.severity, s.count])) };
    } catch (_) { /* fall through */ }
  }
  const all = getAllFromStore(memStore).concat(getAllFromStore(alertsArchive).filter(a => !memStore.alerts.get(a.id)));
  const unique = new Map();
  for (const a of all) { if (!unique.has(a.id)) unique.set(a.id, a); }
  const shaped = [...unique.values()].map(shape);
  const stats = { total: shaped.length, open: 0, acknowledged: 0, resolved: 0, bySeverity: {} };
  for (const a of shaped) {
    if (a.resolved) stats.resolved += 1;
    else { stats.open += 1; stats.bySeverity[a.severity] = (stats.bySeverity[a.severity] || 0) + 1; if (a.acknowledged) stats.acknowledged += 1; }
  }
  return stats;
}

module.exports = { insertAlert, listAlerts, getAlert, acknowledgeAlert, resolveAlert, updateAlert, alertStats };