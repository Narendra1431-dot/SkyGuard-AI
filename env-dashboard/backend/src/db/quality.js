'use strict';

const pg = require('./pg');

async function insertIssue(issue) {
  if (!pg.isEnabled()) return null;
  try {
    const r = await pg.query(
      `INSERT INTO data_quality_issues (station_id, parameter, issue_type, severity, detail, detected_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, station_id AS "stationId", parameter, issue_type AS "issueType", severity, detail, detected_at AS "detectedAt"`,
      [issue.stationId || null, issue.parameter || null, issue.issueType, issue.severity || 'warning', issue.detail || null, issue.detectedAt || new Date().toISOString()]
    );
    return r.rows[0];
  } catch (_) { return null; }
}

async function recentIssues(limit = 100) {
  if (!pg.isEnabled()) return [];
  try {
    const r = await pg.query(
      `SELECT id, station_id AS "stationId", parameter, issue_type AS "issueType", severity, detail, detected_at AS "detectedAt"
       FROM data_quality_issues ORDER BY detected_at DESC LIMIT $1`,
      [Math.min(limit, 500)]
    );
    return r.rows;
  } catch (_) { return []; }
}

async function insertSnapshot(snap) {
  if (!pg.isEnabled()) return;
  try {
    await pg.query(
      `INSERT INTO data_quality_snapshots
        (computed_at, ingestion_rate, records_accepted, records_rejected, duplicates, out_of_range, missing, latency_ms, freshness_seconds, completeness, validity, accuracy, overall_score)
       VALUES (now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [snap.ingestionRate, snap.recordsAccepted, snap.recordsRejected, snap.duplicates,
       snap.outOfRange, snap.missing, snap.latencyMs, snap.freshnessSeconds,
       snap.completeness, snap.validity, snap.accuracy, snap.overallScore]
    );
  } catch (_) { /* best-effort mirror */ }
}

async function listSnapshots(limit = 100) {
  if (!pg.isEnabled()) return [];
  try {
    const r = await pg.query(
      `SELECT computed_at AS "computedAt", ingestion_rate AS "ingestionRate",
              records_accepted AS "recordsAccepted", records_rejected AS "recordsRejected",
              duplicates, out_of_range AS "outOfRange", missing, latency_ms AS "latencyMs",
              freshness_seconds AS "freshnessSeconds", completeness, validity, accuracy, overall_score AS "overallScore"
       FROM data_quality_snapshots ORDER BY computed_at DESC LIMIT $1`,
      [Math.min(limit, 500)]
    );
    return r.rows;
  } catch (_) { return []; }
}

module.exports = { insertIssue, recentIssues, insertSnapshot, listSnapshots };