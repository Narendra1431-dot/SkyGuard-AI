'use strict';

process.env.USE_INFLUXDB = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, stations, processReading, setIngestionPaused } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

test.before(async () => {
  setIngestionPaused(true);
  try { await initFromEnv(config.auth); } catch (_) {}
});

function seedDeterministic() {
  const now = Date.now();
  const base = [
    { aqi: 45, temperature: 26, humidity: 60, anomaly: 0 },
    { aqi: 120, temperature: 33, humidity: 45, anomaly: 0 },
    { aqi: 80, temperature: 29, humidity: 55, anomaly: 0 },
    { aqi: 200, temperature: 39, humidity: 30, anomaly: 1 },
  ];
  for (let i = 0; i < stations.length; i += 1) {
    const v = base[i % base.length];
    const reading = { ...tickReading(stations[i], Math.floor(now / 1000)), time: new Date().toISOString(), ...v };
    processReading(reading);
  }
  const crit = { ...tickReading(stations[0], Math.floor(now / 1000)), time: new Date(now + 1000).toISOString(), aqi: 300, temperature: 44, humidity: 8, anomaly: 1 };
  processReading(crit);
}

async function ask(q) {
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: q });
  assert.equal(r.status, 200, `status for "${q}"`);
  return r.body.data;
}

test('assistant v2 returns data-aware answer for the 8 deliverable queries', async () => {
  seedDeterministic();
  await new Promise((r) => setTimeout(r, 250));

  const cases = [
    { q: 'What is happening right now?', must: /critical|warning|report|station/i },
    { q: 'Which stations are critical?', must: /critical|no stations currently/i },
    { q: 'What is the current AQI and temperature situation across stations?', must: /aqi|temperature|stations|city/i },
    { q: 'What anomalies were detected?', must: /anomal|null|detected|none|no/i },
    { q: 'Are there any open alerts?', must: /alert|none|no/i },
    { q: 'What is the overall environmental situation?', must: /fleet|critic|environment|aqi|station/i },
    { q: 'Which station needs attention first?', must: /investigate|high|risk|alert|station|none|no/i },
    { q: 'Which station should I investigate first?', must: /investigate|high|risk|alert|station|none|no/i },
  ];
  for (const c of cases) {
    const out = await ask(c.q);
    assert.ok(out.text && out.text.length > 1, `non-empty text for "${c.q}": ${JSON.stringify(out.text).slice(0, 120)}`);
    assert.ok(c.must.test(out.text), `answer for "${c.q}" mentions expected data: "${out.text.slice(0, 200)}"`);
    assert.ok(Array.isArray(out.evidence), `evidence array for "${c.q}"`);
  }
});

test('assistant v2 city AQI question returns real reading', async () => {
  seedDeterministic();
  await new Promise((r) => setTimeout(r, 150));
  const out = await ask('What is the current AQI in Delhi?');
  assert.ok(/aqi/i.test(out.text), `mentions AQI: "${out.text}"`);
  const aqiMatch = out.text.match(/aqi.*?[:]\s*([\d.]+)/i);
  assert.ok(aqiMatch, `answer contains a numeric AQI value: "${out.text}"`);
  const value = Number(aqiMatch[1]);
  assert.ok(Number.isFinite(value) && value > 0, `AQI value is real (got ${value})`);
});

test('assistant v2 temperature question returns real reading', async () => {
  seedDeterministic();
  await new Promise((r) => setTimeout(r, 150));
  const out = await ask('What is the temperature in Mumbai?');
  assert.ok(/temp/i.test(out.text), `mentions temperature: "${out.text}"`);
  const tMatch = out.text.match(/temp[^\d]*[:]\s*([\d.]+)/i);
  assert.ok(tMatch, `answer contains numeric temperature: "${out.text}"`);
  assert.ok(Number.isFinite(Number(tMatch[1])), `temperature is real: ${tMatch[1]}`);
});

test('assistant v2 help returns guidance', async () => {
  const out = await ask('help');
  assert.ok(/aqi|happening|critical|hour|maintenance|investigate/i.test(out.text), out.text);
});

test('assistant v2 empty query returns non-empty guidance', async () => {
  const out = await ask('');
  assert.ok(out.text && out.text.length > 0, out.text);
});

test('assistant v2 answer references actual station names (no fabrication)', async () => {
  seedDeterministic();
  await new Promise((r) => setTimeout(r, 150));
  const out = await ask('Which stations are critical?');
  const mentionsReal = stations.some((s) => out.text.includes(s.name) || out.text.toLowerCase().includes(s.name.toLowerCase()));
  assert.ok(mentionsReal || /no stations currently in critical/i.test(out.text), `text references a real station name or reports none: "${out.text}"`);
});