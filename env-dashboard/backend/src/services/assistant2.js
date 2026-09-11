'use strict';

/**
 * AI Assistant 2.0 — deterministic operational copilot.
 *
 * Uses live backend data to answer operational questions. If no LLM is
 * available, falls back to rule-based reasoning across the runtime state.
 * Never fabricates — every answer is grounded in actual data.
 */

const { dedupe } = require('./intelligence');
const investigation = require('./investigation');

const INTENT_PATTERNS = [
  { id: 'help', test: (q) => /help|commands|what can/i.test(q) },
  { id: 'happening_now', test: (q) => /what is happening|summary|currently|overview|right now|environment|overall situation|situation/i.test(q) && !/aqi|temperature|humidity|rain/i.test(q) },
  { id: 'critical_stations', test: (q) => /critical|severe|worst/i.test(q) && /station/i.test(q) },
  { id: 'deteriorated', test: (q) => /deteriorat|declined|worsen/i.test(q) },
  { id: 'geo_related', test: (q) => /geographic|spatial|cluster|nearby/i.test(q) },
  { id: 'anomalies', test: (q) => /anomal|outlier|irregular/i.test(q) },
  { id: 'alerts', test: (q) => /open alert|current alert|any alert|alerts\b/i.test(q) },
  { id: 'last_hour', test: (q) => /last hour|past hour|recent/i.test(q) && !/aqi|temperature|humidity|rain/i.test(q) },
  { id: 'provider_issues', test: (q) => /provider|fallback|integration|api issue|outage/i.test(q) },
  { id: 'maintenance_risk', test: (q) => /maintenance|repair|service/i.test(q) },
  { id: 'investigate_first', test: (q) => /investigate|first|priority|triage|what should|recommend|attention/i.test(q) },
  { id: 'aqi', test: (q) => /aqi|air quality/i.test(q) },
  { id: 'temperature', test: (q) => /temperature|temp\b/i.test(q) },
  { id: 'humidity', test: (q) => /humidity|humid/i.test(q) },
  { id: 'rain', test: (q) => /rain|rainfall|precip/i.test(q) },
];

function classify(query) {
  for (const p of INTENT_PATTERNS) if (p.test(query)) return p.id;
  return 'help';
}

function buildContext({ stations, latest, alerts, providers, maintenance, quality, correlation, investigations, events }) {
  return {
    stations,
    latestByStation: new Map(latest.map((r) => [r.stationId, r])),
    alerts,
    providers,
    maintenance,
    quality,
    correlation: correlation || [],
    investigations: Array.isArray(investigations) ? investigations : [],
    events: Array.isArray(events) ? events : [],
  };
}

function happeningNow(ctx) {
  const critical = [...ctx.latestByStation.entries()].filter(([, r]) => r.aqi > 250 || r.temperature > 42 || r.humidity < 15);
  const warning = [...ctx.latestByStation.entries()].filter(([, r]) => r.anomaly === 1 && !critical.find(([id]) => id === r.stationId));
  const events = ctx.events.slice(0, 6).map((e) => `• ${e.title}${e.station ? ' — ' + e.station : ''}`);
  return {
    text: [
      `Right now the fleet reports ${critical.length} critical and ${warning.length} warning stations.`,
      ctx.alerts.open ? `${ctx.alerts.open} open alerts.` : 'No open alerts.',
      ctx.maintenance.high ? `${ctx.maintenance.high} stations at HIGH maintenance risk.` : 'No stations at HIGH maintenance risk.',
      ctx.quality ? `Data quality is ${ctx.quality.overallScore?.toFixed?.(1)}% (${ctx.quality.overallScore >= 90 ? 'good' : ctx.quality.overallScore >= 70 ? 'degraded' : 'poor'}).` : '',
      events.length ? 'Recent activity:\n' + events.join('\n') : '',
    ].filter(Boolean).join('\n'),
    evidence: { critical: critical.length, warning: warning.length, alerts: ctx.alerts, maintenance: ctx.maintenance, quality: ctx.quality },
  };
}

function criticalStations(ctx) {
  const critical = [...ctx.latestByStation.entries()]
    .filter(([, r]) => r.aqi > 250 || r.temperature > 42 || r.humidity < 15)
    .map(([id, r]) => ({ id, r, s: ctx.stations.find((x) => x.id === id) }))
    .filter((x) => x.s);
  if (!critical.length) return { text: 'No stations are currently in critical state.', evidence: { count: 0 } };
  const text = critical.map(({ s, r }) => `• ${s.name} (${s.id}) — AQI ${r.aqi}, Temp ${r.temperature}°C, Humidity ${r.humidity}%`).join('\n');
  return { text: `Critical stations:\n${text}\nRecommendation: dispatch field teams and review the decision trace.`, evidence: { stations: critical.map((c) => c.s) } };
}

function providerIssues(ctx) {
  const bad = ctx.providers.filter((p) => p.status === 'RED' || (p.configurationState !== 'CONFIGURED' && p.enabled));
  if (!bad.length) return { text: 'All configured providers are operational.', evidence: { providers: ctx.providers } };
  return {
    text: `Provider issues detected:\n${bad.map((p) => `• ${p.name} (${p.id}) — ${p.status} (${p.lastError || 'no error recorded'})`).join('\n')}\nRecommendation: validate credentials or fall back to the secondary provider.`,
    evidence: { providers: bad },
  };
}

function geoRelated(ctx) {
  const correlated = (ctx.correlation || []).filter((c) => c.stationCount >= 2);
  if (!correlated.length) return { text: 'No geographically-correlated anomaly clusters detected in the last 24 hours.', evidence: { clusters: correlated } };
  return {
    text: `Detected ${correlated.length} correlated environmental events:\n${correlated.slice(0, 5).map((c) => `• ${c.bucket} — ${c.summary}`).join('\n')}`,
    evidence: { clusters: correlated },
  };
}

function maintenanceRisk(ctx) {
  const high = ctx.maintenance.list.filter((m) => m.riskScore > 70);
  const medium = ctx.maintenance.list.filter((m) => m.riskScore > 30 && m.riskScore <= 70);
  return {
    text: `${high.length} stations at HIGH risk, ${medium.length} at MEDIUM.\nHigh:\n${high.map((m) => `• ${m.stationName || m.stationId} — risk ${m.riskScore}, predicted window ${m.predictedWindow}`).join('\n') || '—'}\nRecommendation: schedule maintenance within 24h for HIGH stations.`,
    evidence: { high, medium },
  };
}

function investigateFirst(ctx) {
  // Rank: critical alerts first, then high maintenance risk, then anomalies
  const items = [];
  const seen = new Set();
  for (const a of (ctx.alerts.list || []).filter((x) => !x.resolved && x.stationId)) {
    const key = `${a.stationId}:${a.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ type: 'alert', priority: a.severity === 'critical' ? 1 : 2, ref: a });
  }
  for (const m of ctx.maintenance.list.filter((m) => m.riskScore > 50)) {
    items.push({ type: 'maintenance', priority: 2, ref: m });
  }
  for (const inv of (Array.isArray(ctx.investigations) ? ctx.investigations : []).filter((i) => i.state === 'detected' || i.state === 'triaged')) {
    items.push({ type: 'investigation', priority: 1, ref: inv });
  }
  items.sort((a, b) => a.priority - b.priority);
  if (!items.length) return { text: 'No outstanding items require immediate investigation.', evidence: { count: 0 } };
  const text = items.slice(0, 5).map((it) => {
    const ref = it.ref;
    const location = ref.station || ref.stationName || ref.stationId || (ref.title || '');
    const state = ref.state || ref.severity || 'open';
    return `• [${it.type}] ${location} — ${ref.title || ref.anomalyId || ''} (state: ${state})`;
  }).join('\n');
  return { text: `Investigate first:\n${text}`, evidence: { items: items.slice(0, 5) } };
}

function matchCity(text) {
  const cities = ['delhi', 'mumbai', 'hyderabad', 'chennai', 'bengaluru', 'kolkata', 'pune', 'jaipur'];
  for (const c of cities) if (text.toLowerCase().includes(c)) return c;
  return null;
}

function cityQuestion(ctx, query, field) {
  const city = matchCity(query);
  if (!city) return { text: `Please mention a city (e.g., Delhi, Mumbai, Hyderabad).`, evidence: { supported: 'delhi, mumbai, hyderabad, chennai, bengaluru, kolkata, pune, jaipur' } };
  const station = ctx.stations.find((s) => s.name.toLowerCase().includes(city));
  if (!station) return { text: `No station found for ${city}.`, evidence: { city } };
  const reading = ctx.latestByStation.get(station.id);
  if (!reading) return { text: `No reading yet for ${station.name}.`, evidence: { station: station.id } };
  return { text: `${field.toUpperCase()} at ${station.name}: ${reading[field]}.`, evidence: { station: station.id, value: reading[field] } };
}

function alarmsOpen(ctx) {
  const open = (ctx.alerts?.list || []).filter((a) => !a.resolved);
  if (!open.length) return { text: 'No open alerts.', evidence: { open: 0 } };
  const text = open.slice(0, 8).map((a) => `• [${a.severity}] ${a.title} — ${a.station || a.stationName || a.stationId} (${a.resolved ? 'resolved' : 'open'})`).join('\n');
  return { text: `${open.length} open alert(s):\n${text}`, evidence: { open: open.length, alerts: open.slice(0, 8) } };
}

function anomaliesDetected(ctx) {
  const anomalies = (ctx.events || []).filter((e) => /anomal|irregular|outlier/i.test(e.type || ''));
  if (!anomalies.length) return { text: 'No anomalies detected in the current window.', evidence: { count: 0 } };
  const text = anomalies.slice(0, 8).map((e) => `• ${e.title}${e.station ? ' — ' + e.station : ''}`).join('\n');
  return { text: `${anomalies.length} anomaly event(s) in the current window:\n${text}`, evidence: { count: anomalies.length, events: anomalies.slice(0, 8) } };
}

function handle(query, ctx) {
  const intent = classify(query || '');
  let reply;
  switch (intent) {
    case 'happening_now': reply = happeningNow(ctx); break;
    case 'critical_stations': reply = criticalStations(ctx); break;
    case 'deteriorated': {
      const items = dedupe(ctx.events.filter((e) => /degrad|recover|anomaly|alert/i.test(e.type)));
      reply = { text: items.length ? `Recent meaningful changes:\n${items.slice(0, 6).map((e) => `• ${e.title}${e.station ? ' — ' + e.station : ''}`).join('\n')}` : 'No degradations detected in the last hour.', evidence: { events: items } };
      break;
    }
    case 'anomalies': reply = anomaliesDetected(ctx); break;
    case 'alerts': reply = alarmsOpen(ctx); break;
    case 'last_hour': {
      const cutoff = Date.now() - 3600_000;
      const items = ctx.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
      reply = { text: items.length ? `In the last hour: ${items.length} events.\n${items.slice(0, 5).map((e) => `• ${e.title}`).join('\n')}` : 'No events in the last hour.', evidence: { count: items.length } };
      break;
    }
    case 'provider_issues': reply = providerIssues(ctx); break;
    case 'geo_related': reply = geoRelated(ctx); break;
    case 'maintenance_risk': reply = maintenanceRisk(ctx); break;
    case 'investigate_first': reply = investigateFirst(ctx); break;
    case 'aqi': reply = cityQuestion(ctx, query, 'aqi'); break;
    case 'temperature': reply = cityQuestion(ctx, query, 'temperature'); break;
    case 'humidity': reply = cityQuestion(ctx, query, 'humidity'); break;
    case 'rain': {
      const sorted = [...ctx.latestByStation.entries()].sort((a, b) => (b[1].rainfall || 0) - (a[1].rainfall || 0));
      reply = { text: `Top rainfall:\n${sorted.slice(0, 3).map(([id, r]) => `• ${ctx.stations.find((s) => s.id === id)?.name || id} — ${r.rainfall?.toFixed?.(2)} mm`).join('\n')}`, evidence: { sorted } };
      break;
    }
    default: reply = { text: 'Try one of: "What is happening right now?", "Which stations are critical?", "What changed in the last hour?", "Which provider is failing?", "Which stations need maintenance?", "What should I investigate first?"', evidence: null };
  }
  return { text: reply.text, evidence: reply.evidence, intent };
}

module.exports = { handle, classify, buildContext };