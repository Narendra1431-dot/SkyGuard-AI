'use strict';

const fs = require('fs');
const path = require('path');
const pg = require('./pg');
const { REPORTS_DIR, ensureDir } = require('./reportsPg');

// In-memory store fallback when PG is disabled
const memStore = { reports: new Map() };

function inMemoryInsert(rec) { memStore.reports.set(rec.id, { ...rec }); }
function inMemoryUpdate(id, patch) {
  const cur = memStore.reports.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  memStore.reports.set(id, next);
  return next;
}
function inMemoryList({ limit = 100, category, status } = {}) {
  let arr = [...memStore.reports.values()];
  if (category) arr = arr.filter((r) => r.category === category);
  if (status) arr = arr.filter((r) => r.status === status);
  arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return arr.slice(0, limit);
}
function inMemoryGet(id) { return memStore.reports.get(id) || null; }
function inMemoryDelete(id) { return memStore.reports.delete(id); }

async function insertReport(rec) {
  ensureDir();
  if (pg.isEnabled()) {
    try {
      await pg.query(
        `INSERT INTO reports (id, category, title, status, format, params, requested_by, file_path, file_size, row_count, summary, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          rec.id, rec.category, rec.title, rec.status || 'pending', rec.format || 'json',
          JSON.stringify(rec.params || {}), rec.requestedBy || null,
          rec.filePath || null, rec.fileSize || null, rec.rowCount || null,
          JSON.stringify(rec.summary || {}), rec.createdAt || new Date().toISOString(),
          rec.completedAt || null,
        ]
      );
    } catch (_) { /* fall through to in-memory */ }
  }
  inMemoryInsert(rec);
}

async function updateReport(id, patch) {
  if (pg.isEnabled()) {
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      params.push(k === 'summary' || k === 'params' ? JSON.stringify(v) : v);
      sets.push(`${k === 'filePath' ? 'file_path' : k === 'fileSize' ? 'file_size' : k === 'rowCount' ? 'row_count' : k === 'requestedBy' ? 'requested_by' : k === 'completedAt' ? 'completed_at' : k} = $${params.length}`);
    }
    if (sets.length) {
      params.push(id);
      try { await pg.query(`UPDATE reports SET ${sets.join(', ')} WHERE id = $${params.length}`, params); } catch (_) { /* ignore */ }
    }
  }
  return inMemoryUpdate(id, patch);
}

async function listReports({ limit = 100, category, status } = {}) {
  const mem = inMemoryList({ limit, category, status });
  if (pg.isEnabled()) {
    try {
      const conds = [];
      const params = [];
      if (category) { params.push(category); conds.push(`category = $${params.length}`); }
      if (status) { params.push(status); conds.push(`status = $${params.length}`); }
      const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
      params.push(Math.min(limit, 500));
      const r = await pg.query(
        `SELECT id, category, title, status, format, params, requested_by AS "requestedBy",
                file_path AS "filePath", file_size AS "fileSize", row_count AS "rowCount",
                summary, error, created_at AS "createdAt", completed_at AS "completedAt"
         FROM reports ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      );
      // Prefer PG but fall back to memory if empty
      return r.rows.length ? r.rows : mem;
    } catch (_) { return mem; }
  }
  return mem;
}

async function getReport(id) {
  if (pg.isEnabled()) {
    try {
      const r = await pg.query(
        `SELECT id, category, title, status, format, params, requested_by AS "requestedBy",
                file_path AS "filePath", file_size AS "fileSize", row_count AS "rowCount",
                summary, error, created_at AS "createdAt", completed_at AS "completedAt"
         FROM reports WHERE id = $1`,
        [id]
      );
      if (r.rows[0]) return r.rows[0];
    } catch (_) { /* fall through */ }
  }
  return inMemoryGet(id);
}

async function deleteReport(id) {
  ensureDir();
  const rec = inMemoryGet(id);
  if (rec && rec.filePath) {
    const fp = path.resolve(REPORTS_DIR, rec.filePath);
    if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (_) {} }
  }
  if (pg.isEnabled()) {
    try { await pg.query('DELETE FROM reports WHERE id = $1', [id]); } catch (_) {}
  }
  return inMemoryDelete(id);
}

module.exports = { insertReport, updateReport, listReports, getReport, deleteReport, REPORTS_DIR, ensureDir };
