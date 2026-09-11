'use strict';

/**
 * Spatial comparison and station clustering
 *
 * Compares a station against neighbours (haversine distance) using
 * recent readings. Computes deviation, % deviation, and anomaly correlation.
 */

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function nearestNeighbours(targetStation, allStations, limit = 5) {
  return allStations
    .filter((s) => s.id !== targetStation.id && s.lat != null && s.lon != null)
    .map((s) => ({ station: s, distanceKm: haversineKm(targetStation, s) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

function deviationPercent(target, neighbour, field) {
  if (target == null || neighbour == null) return null;
  const denom = Math.abs(target) + 1e-6;
  return +(((target - neighbour) / denom) * 100).toFixed(2);
}

function buildComparison(targetStation, allStations, latestByStation, field = 'temperature') {
  const target = latestByStation.get(targetStation.id);
  const targetValue = target ? target[field] : null;
  const neighbours = nearestNeighbours(targetStation, allStations, 5).map(({ station, distanceKm }) => {
    const reading = latestByStation.get(station.id);
    const neighbourValue = reading ? reading[field] : null;
    const dev = (targetValue != null && neighbourValue != null) ? +(targetValue - neighbourValue).toFixed(3) : null;
    const devPct = deviationPercent(targetValue, neighbourValue);
    const correlatedAnomaly = target?.anomaly === 1 && reading?.anomaly === 1;
    return {
      stationId: station.id,
      station: station.name,
      distanceKm: +distanceKm.toFixed(2),
      value: neighbourValue,
      deviation: dev,
      deviationPercent: devPct,
      anomaly: reading?.anomaly === 1,
      correlatedAnomaly,
    };
  });
  // Generate evidence-based insight (deterministic).
  let insight = 'No anomalies detected across the neighbourhood — readings are spatially consistent.';
  if (targetValue != null && neighbours.length) {
    const worst = neighbours.reduce((acc, n) => (acc == null || Math.abs(n.deviation || 0) > Math.abs(acc.deviation || 0)) ? n : acc, null);
    if (worst && Math.abs(worst.deviation || 0) > (worst.value || 1) * 0.05) {
      insight = `${targetStation.name} deviates from nearest station ${worst.station} by ${worst.deviation?.toFixed?.(2)} (${worst.deviationPercent?.toFixed?.(1)}%) — investigate local factors.`;
    }
  }
  return {
    field,
    targetStation: { id: targetStation.id, name: targetStation.name, value: targetValue },
    neighbours,
    insight,
  };
}

module.exports = { buildComparison, nearestNeighbours, haversineKm, deviationPercent };