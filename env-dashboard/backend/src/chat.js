'use strict';

function handleQuery(q, ctx) {
  const text = (q || '').trim();
  const lower = text.toLowerCase();

  if (!text) return reply('Ask me something like "What is the current AQI in Hyderabad?"', []);

  if (/help|what can|commands/.test(lower)) {
    return reply(
      'Try one of these:\\n' +
      '\\u00b7 What is the current AQI in Hyderabad?\\n' +
      '\\u00b7 Show anomalies today\\n' +
      '\\u00b7 Which station is critical?\\n' +
      '\\u00b7 Compare temperature across stations\\n' +
      '\\u00b7 Health score trend\\n' +
      '\\u00b7 Top 3 stations by rainfall',
      []
    );
  }

  // AQI by city
  if (/aqi|air quality/.test(lower)) {
    const city = matchCity(lower) || 'Delhi Central';
    const r = ctx.latestByCity[city];
    if (!r) return reply(`No data available for ${city} yet.`, []);
    const cat = r.aqi > 200 ? 'unhealthy' : r.aqi > 100 ? 'moderate' : 'good';
    return reply(`Current AQI in ${city} is **${r.aqi}** (${cat}). Last reading at ${new Date(r.time).toLocaleTimeString()}.`, [{
      type: 'kpi',
      value: r.aqi,
      label: `${city} AQI`,
    }]);
  }

  // Temperature
  if (/temperature|temp\\b/.test(lower)) {
    const city = matchCity(lower) || 'Delhi Central';
    const r = ctx.latestByCity[city];
    if (!r) return reply(`No data for ${city}.`, []);
    return reply(`Temperature at ${city} is **${r.temperature.toFixed(1)} \\u00b0C**.`, []);
  }

  // Humidity
  if (/humidity|humid/.test(lower)) {
    const city = matchCity(lower) || 'Delhi Central';
    const r = ctx.latestByCity[city];
    if (!r) return reply(`No data for ${city}.`, []);
    return reply(`Humidity at ${city} is **${r.humidity.toFixed(1)} %**.`, []);
  }

  // Anomalies today
  if (/anomal/.test(lower)) {
    const n = ctx.anomaliesToday;
    return reply(`${n} anomalies have been detected in the last 24 hours. Most recent critical: ${ctx.recentCriticalName || 'none'}.`, []);
  }

  // Critical station
  if (/critical/.test(lower)) {
    if (!ctx.criticalStations.length) return reply('No stations are currently in critical state.', []);
    return reply(
      'Stations currently flagged as **critical**:\\n' +
      ctx.criticalStations.map((s) => `\\u00b7 ${s.name} (${s.reason})`).join('\\n'),
      []
    );
  }

  // Compare stations
  if (/compare/.test(lower)) {
    return reply('Comparison chart will load in the Spatial Comparison panel.', []);
  }

  // Rainfall
  if (/rain/.test(lower)) {
    const sorted = [...ctx.latestByCityEntries].sort((a, b) => b[1].rainfall - a[1].rainfall);
    const top = sorted.slice(0, 3).map(([name, r]) => `\\u00b7 ${name}: ${r.rainfall.toFixed(2)} mm`).join('\\n');
    return reply(`Top rainfall right now:\\n${top}`, []);
  }

  // Health score
  if (/health|trend/.test(lower)) {
    return reply(`Average health score: **${ctx.avgHealth.toFixed(1)} / 100**. See Health Monitor for the full trend.`, []);
  }

  // Default fallback
  return reply(
    `I don't have a specific answer for "${text}". Try asking about AQI, temperature, anomalies, critical stations, or rainfall.`,
    []
  );
}

function reply(text, extras) { return { text, extras }; }

function matchCity(s) {
  const cities = ['delhi','mumbai','hyderabad','chennai','bengaluru','kolkata','pune','jaipur'];
  for (const c of cities) if (s.includes(c)) return capitalize(c) + ' ' + suffixFor(c);
  return null;
}
function suffixFor(c) {
  return ({
    delhi:'Central', mumbai:'Coast', hyderabad:'Tech Park', chennai:'Port',
    bengaluru:'Whitefield', kolkata:'Riverside', pune:'Hilltop', jaipur:'Heritage',
  })[c];
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { handleQuery };
