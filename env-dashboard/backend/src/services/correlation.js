'use strict';

/**
 * Alert correlation
 *
 * Groups recent alert activity into correlated environmental events.
 * For example:
 *   Temperature spike + neighbouring stations spike + pressure drop + AQI rise
 *   → one correlated environmental event.
 */

function hashStation(reading) { return `${reading.stationId}|${reading.time}`; }

function correlate(alerts, recentReadings) {
  const groups = [];
  const used = new Set();
  // Use a simple time-bucket approach (5 minute buckets).
  for (const a of alerts) {
    if (used.has(a.id)) continue;
    const bucket = new Date(a.createdAt || a.timestamp);
    bucket.setSeconds(0, 0);
    bucket.setMinutes(Math.floor(bucket.getMinutes() / 5) * 5);
    const bucketKey = bucket.toISOString();
    const cluster = [a];
    const stations = new Set([a.stationId]);
    const factors = new Set();
    for (const b of alerts) {
      if (b.id === a.id || used.has(b.id)) continue;
      const bBucket = new Date(b.createdAt || b.timestamp);
      bBucket.setSeconds(0, 0);
      bBucket.setMinutes(Math.floor(bBucket.getMinutes() / 5) * 5);
      if (bBucket.toISOString() === bucketKey) {
        cluster.push(b);
        stations.add(b.stationId);
        for (const f of (b.factors || [])) factors.add(f.name);
      }
    }
    // Cross-reference spatial anomaly from recent readings
    const sameBucketReadings = recentReadings.filter((r) => {
      const t = new Date(r.time); t.setSeconds(0, 0); t.setMinutes(Math.floor(t.getMinutes() / 5) * 5);
      return t.toISOString() === bucketKey && r.anomaly === 1;
    });
    const spatialStations = new Set(sameBucketReadings.map((r) => r.stationId));
    for (const id of spatialStations) stations.add(id);

    cluster.forEach((c) => used.add(c.id));
    const severity = cluster.some((c) => c.severity === 'critical') ? 'critical'
      : cluster.some((c) => c.severity === 'warning') ? 'warning' : 'info';
    groups.push({
      id: `CORR-${bucketKey}`,
      bucket: bucketKey,
      severity,
      stationCount: stations.size,
      alertIds: cluster.map((c) => c.id),
      stations: [...stations],
      factors: [...factors],
      summary: cluster.length === 1
        ? `Single ${cluster[0].severity} alert: ${cluster[0].title}`
        : `${cluster.length} correlated ${severity} events across ${stations.size} stations`,
      spatialAnomalies: sameBucketReadings.length,
    });
  }
  return groups.sort((a, b) => new Date(b.bucket) - new Date(a.bucket));
}

module.exports = { correlate };