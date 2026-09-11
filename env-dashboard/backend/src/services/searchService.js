'use strict';

/**
 * Global search service
 *
 * Finds matches across stations, anomalies, alerts, providers,
 * notifications, audit events, reports.
 */

function score(text, query) {
  if (!query) return 0;
  const t = (text || '').toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 50;
  return 0;
}

async function search(query, ctx) {
  if (!query || query.length < 2) return [];
  const results = [];

  // Stations
  for (const s of ctx.stations || []) {
    const sc = Math.max(score(s.id, query), score(s.name, query));
    if (sc) results.push({ type: 'station', id: s.id, title: s.name, subtitle: s.id, href: `#station-detail?${encodeURIComponent(s.id)}`, score: sc });
  }

  // Alerts
  for (const a of ctx.alerts || []) {
    const sc = Math.max(score(a.title, query), score(a.station, query), score(a.id, query));
    if (sc) results.push({ type: 'alert', id: a.id, title: a.title, subtitle: `${a.station} (${a.severity})`, href: `#alerts?focus=${encodeURIComponent(a.id)}`, score: sc + 5 });
  }

  // Anomalies (raw, with station name)
  for (const r of (ctx.anomalies || []).slice(0, 200)) {
    const reason = (r.reasons || []).join(' ');
    const sc = Math.max(score(r.station, query), score(reason, query));
    if (sc) results.push({ type: 'anomaly', id: r.time + ':' + r.stationId, title: reason.split(';')[0] || 'Anomaly', subtitle: `${r.station} • ${new Date(r.time).toLocaleString()}`, href: `#anomalies?station=${encodeURIComponent(r.stationId)}`, score: sc });
  }

  // Providers
  for (const p of ctx.providers || []) {
    const sc = Math.max(score(p.id, query), score(p.name, query));
    if (sc) results.push({ type: 'provider', id: p.id, title: p.name, subtitle: p.id, href: `#providers`, score: sc });
  }

  // Maintenance
  for (const m of ctx.maintenance || []) {
    const sc = Math.max(score(m.stationName || m.stationId, query), score(m.recommendation, query));
    if (sc) results.push({ type: 'maintenance', id: m.id, title: m.recommendation, subtitle: `${m.stationName || m.stationId} • risk ${m.riskScore}`, href: `#maintenance`, score: sc });
  }

  // Reports
  for (const rep of ctx.reports || []) {
    const sc = Math.max(score(rep.title, query), score(rep.id, query), score(rep.category, query));
    if (sc) results.push({ type: 'report', id: rep.id, title: rep.title, subtitle: rep.category, href: `#reports`, score: sc });
  }

  // Audit
  for (const au of (ctx.audits || []).slice(0, 200)) {
    const sc = Math.max(score(au.actor, query), score(au.action, query), score(au.resource, query), score(au.resourceId || '', query));
    if (sc) results.push({ type: 'audit', id: au.id, title: `${au.action} ${au.resource}${au.resourceId ? ' (' + au.resourceId + ')' : ''}`, subtitle: `${au.actor} • ${new Date(au.timestamp).toLocaleString()}`, href: `#audit`, score: sc });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 50);
}

module.exports = { search, score };