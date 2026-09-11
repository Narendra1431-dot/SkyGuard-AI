'use strict';

/**
 * Controlled read-only tool gateway for the deterministic assistant.
 * Tools return runtime state from the assistant context; unknown tools are
 * rejected so the reasoning layer cannot invoke arbitrary functions.
 */

const TOOL_PLANS = {
  happening_now: ['get_current_readings', 'get_alerts', 'get_provider_status', 'get_data_quality', 'get_recent_events'],
  critical_stations: ['get_current_readings', 'get_alerts'],
  last_hour: ['get_recent_events', 'get_alerts'],
  provider_issues: ['get_provider_status'],
  geo_related: ['get_current_readings', 'get_recent_events'],
  maintenance_risk: ['get_maintenance_risk'],
  investigate_first: ['get_alerts', 'get_maintenance_risk', 'get_investigations'],
  aqi: ['get_current_readings'],
  temperature: ['get_current_readings'],
  humidity: ['get_current_readings'],
  rain: ['get_current_readings'],
  help: [],
};

function stationRows(ctx) {
  return ctx.stations.map((station) => ({
    stationId: station.id,
    station: station.name,
    reading: ctx.latestByStation.get(station.id) || null,
  }));
}

const TOOLS = {
  get_current_readings: (ctx) => stationRows(ctx),
  get_alerts: (ctx) => ctx.alerts.list || [],
  get_provider_status: (ctx) => ctx.providers || [],
  get_data_quality: (ctx) => ctx.quality || null,
  get_recent_events: (ctx) => ctx.events || [],
  get_maintenance_risk: (ctx) => ctx.maintenance.list || [],
  get_investigations: (ctx) => ctx.investigations || [],
};

function execute(name, ctx) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Tool is not allowlisted: ${name}`);
  const startedAt = Date.now();
  const result = tool(ctx);
  return { name, class: 'read_only', status: 'completed', durationMs: Date.now() - startedAt, result };
}

function collect(intent, ctx) {
  const names = TOOL_PLANS[intent] || TOOL_PLANS.help;
  return names.map((name) => execute(name, ctx));
}

module.exports = { TOOL_PLANS, execute, collect };