'use strict';

/**
 * Station timeline
 *
 * Aggregates the recent operational events for one station into a
 * status timeline (ONLINE / WARNING / CRITICAL / OFFLINE / RECOVERED /
 * MAINTENANCE) using real alerts, anomaly flags, and ingestion freshness.
 */

const alertsDb = require('../db/alerts');

function classifyFromReading(reading) {
  if (!reading) return 'offline';
  const aqi = reading.aqi || 0;
  const temperature = reading.temperature || 0;
  const humidity = reading.humidity || 0;
  const wind = reading.wind || 0;
  if (aqi > 250 || temperature > 42 || humidity < 15) return 'critical';
  if (aqi > 150 || temperature > 38 || wind > 10) return 'warning';
  return 'online';
}

async function buildTimeline(stationId, station, store) {
  const latest = (await store.latestPerStation()).find((r) => r.stationId === stationId) || null;
  const status = classifyFromReading(latest);
  const age = latest ? (Date.now() - new Date(latest.time).getTime()) / 1000 : null;
  const inferred = age != null && age > 120 ? 'offline' : status;

  // Pull alerts for this station — real audit history
  let alerts = [];
  try { alerts = await alertsDb.listAlerts({ stationId, limit: 50 }); } catch { alerts = []; }

  const events = [];
  for (const a of alerts) {
    events.push({
      time: a.createdAt,
      type: 'alert',
      severity: a.severity,
      title: a.title,
      state: a.resolved ? 'recovered' : a.severity === 'critical' ? 'critical' : a.severity === 'warning' ? 'warning' : 'online',
      description: a.description,
    });
  }
  if (latest) {
    events.push({ time: latest.time, type: 'reading', severity: status === 'critical' ? 'critical' : status === 'warning' ? 'warning' : 'info', title: 'Reading received', state: inferred, description: `AQI ${latest.aqi} • Temp ${latest.temperature}°C` });
  }
  events.sort((a, b) => new Date(a.time) - new Date(b.time));
  return {
    currentState: inferred,
    lastReadingAt: latest?.time || null,
    events,
    counts: events.reduce((acc, e) => { acc[e.state] = (acc[e.state] || 0) + 1; return acc; }, {}),
  };
}

module.exports = { buildTimeline, classifyFromReading };