'use strict';

/**
 * Global Intelligence Layer
 *
 * Returns structured intelligence items that are used by:
 *  - anomalies
 *  - alerts
 *  - station health
 *  - maintenance risk
 *  - AI assistant
 *  - command center
 *  - event timeline
 *
 * Shape:
 *   {
 *     type, severity, station, stationId, timestamp, evidence[], confidence,
 *     rootCause, recommendation, status
 *   }
 */

const { paramCode, THRESHOLDS } = require('../ai');

function classifySeverity(reading) {
  if (!reading) return 'info';
  if (reading.aqi > 250 || reading.temperature > 42 || reading.humidity < 15) return 'critical';
  if (reading.aqi > 150 || reading.temperature > 38 || reading.wind > 10) return 'warning';
  return 'info';
}

function confidenceFor(reasons) {
  if (!reasons || !reasons.length) return 0.5;
  return Math.min(0.99, 0.6 + reasons.length * 0.08);
}

function rootCauseFromReasons(reasons) {
  if (!reasons || !reasons.length) return 'Within nominal thresholds; no anomaly detected.';
  return reasons[0];
}

function recommendationFor(reasons) {
  if (!reasons || !reasons.length) return 'Continue normal operations.';
  if (reasons.some((r) => /AQI/i.test(r))) return 'Deploy mobile air-quality unit; advise vulnerable groups.';
  if (reasons.some((r) => /Temperature/i.test(r))) return 'Activate heat-stress protocol; check coolant at station.';
  if (reasons.some((r) => /Humidity/i.test(r))) return 'Reduce humidity-controlled loads; inspect dehumidifier.';
  if (reasons.some((r) => /Wind/i.test(r))) return 'Inspect mast/anchors; pause outdoor calibration.';
  if (reasons.some((r) => /Rainfall/i.test(r))) return 'Verify enclosure sealing and drainage.';
  return 'Investigate sensor drift; run calibration sweep.';
}

function fromReading(reading, station) {
  if (!reading) return null;
  const analysis = paramCode(reading);
  const severity = classifySeverity(reading);
  return {
    type: analysis.anomaly ? 'anomaly' : 'reading',
    severity,
    stationId: reading.stationId,
    station: station?.name || reading.stationId,
    timestamp: reading.time,
    evidence: analysis.reasons || [],
    confidence: analysis.confidence ?? confidenceFor(analysis.reasons),
    rootCause: rootCauseFromReasons(analysis.reasons),
    recommendation: analysis.recommendation || recommendationFor(analysis.reasons),
    status: analysis.anomaly ? 'detected' : 'nominal',
    factors: analysis.factors || [],
    reading: { ...reading },
  };
}

function fromMaintenance(rec) {
  if (!rec) return null;
  const sev = rec.riskScore > 70 ? 'critical' : rec.riskScore > 30 ? 'warning' : 'info';
  return {
    type: 'maintenance',
    severity: sev,
    stationId: rec.stationId,
    station: rec.stationName || rec.stationId,
    timestamp: rec.recordedAt,
    evidence: (rec.factors || []).map((f) => f.name),
    confidence: Math.min(0.99, 0.5 + (rec.riskScore || 0) / 200),
    rootCause: `Risk score ${rec.riskScore}; failure probability ${rec.failureProbability}%`,
    recommendation: rec.recommendation,
    status: rec.riskScore > 70 ? 'high_risk' : rec.riskScore > 30 ? 'elevated' : 'nominal',
    meta: { riskScore: rec.riskScore, failureProbability: rec.failureProbability, predictedWindow: rec.predictedWindow },
  };
}

function fromProvider(p) {
  if (!p) return null;
  const sev = p.status === 'GREEN' ? 'info' : p.status === 'YELLOW' ? 'warning' : p.status === 'RED' ? 'critical' : 'info';
  return {
    type: 'provider',
    severity: sev,
    station: p.name,
    stationId: p.id,
    timestamp: p.lastTestAt || new Date().toISOString(),
    evidence: [p.lastError ? `Last error: ${p.lastError}` : `Latency ${p.latencyMs ?? '—'} ms`, `Success ${p.successCount || 0} / Failure ${p.failureCount || 0}`],
    confidence: p.status === 'GREEN' ? 0.9 : 0.6,
    rootCause: p.status === 'RED' ? `Provider ${p.name} failing` : `Provider ${p.name} ${p.status.toLowerCase()}`,
    recommendation: p.status === 'RED' ? 'Update credentials or contact provider support' : 'Monitor',
    status: p.status === 'RED' ? 'failed' : p.status === 'GREEN' ? 'active' : 'standby',
    meta: { providerId: p.id, latencyMs: p.latencyMs },
  };
}

function fromQuality(quality) {
  if (!quality) return null;
  return {
    type: 'quality',
    severity: quality.overallScore < 70 ? 'warning' : quality.overallScore < 50 ? 'critical' : 'info',
    station: 'fleet',
    stationId: null,
    timestamp: quality.computedAt,
    evidence: [
      `Completeness ${quality.completeness}%`,
      `Validity ${quality.validity}%`,
      `Accuracy ${quality.accuracy}%`,
      `Out-of-range ${quality.outOfRange}`,
    ],
    confidence: 0.9,
    rootCause: quality.overallScore < 70 ? 'Data quality degraded' : 'Data quality within nominal range',
    recommendation: 'Inspect parameter-level validity and freshness issues.',
    status: quality.overallScore < 70 ? 'degraded' : 'nominal',
    meta: { overallScore: quality.overallScore, duplicates: quality.duplicates, missing: quality.missing },
  };
}

function fromAlert(alert) {
  if (!alert) return null;
  return {
    type: 'alert',
    severity: alert.severity,
    station: alert.station,
    stationId: alert.stationId,
    timestamp: alert.createdAt || alert.timestamp,
    evidence: alert.factors ? alert.factors.map((f) => f.name) : [],
    confidence: 0.85,
    rootCause: alert.title,
    recommendation: alert.recommendation,
    status: alert.resolved ? 'resolved' : alert.acknowledged ? 'acknowledged' : 'open',
    meta: { alertId: alert.id, acknowledged: alert.acknowledged, resolved: alert.resolved },
  };
}

function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    const key = `${it.type}|${it.stationId || ''}|${it.timestamp}|${it.rootCause}`;
    if (!seen.has(key)) seen.set(key, it);
  }
  return [...seen.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

module.exports = {
  fromReading,
  fromMaintenance,
  fromProvider,
  fromQuality,
  fromAlert,
  classifySeverity,
  dedupe,
  THRESHOLDS,
};