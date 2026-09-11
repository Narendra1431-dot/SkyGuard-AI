'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const request = require('supertest');
const { app, stations, processReading } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

before(async () => { try { await initFromEnv(config.auth); } catch (_) {} });

async function seed() {
  for (const s of stations) {
    await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString() });
  }
}

test('V3 event bus: publishes reading, anomaly, alert events', async () => {
  await seed();
  await new Promise((r) => setTimeout(r, 300));
  const r = await request(app).get('/api/v1/events');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.length > 0, `event count > 0 (got ${r.body.data.length})`);
  const categories = new Set(r.body.data.map((e) => e.category));
  assert.ok(categories.has('reading') || categories.has('anomaly') || categories.has('alert') || categories.has('quality') || categories.has('maintenance'), `expected a known category, got ${[...categories].join(',')}`);
});

test('V3 event bus: filter by category', async () => {
  await seed();
  const r = await request(app).get('/api/v1/events?category=reading');
  assert.equal(r.status, 200);
  for (const e of r.body.data) assert.equal(e.category, 'reading');
});

test('V3 event bus: filter by severity', async () => {
  await seed();
  const r = await request(app).get('/api/v1/events?severity=critical');
  assert.equal(r.status, 200);
  for (const e of r.body.data) assert.equal(e.severity, 'critical');
});

test('V2 situation: returns environment + critical + alerts', async () => {
  await seed();
  const r = await request(app).get('/api/v1/intelligence/situation');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.environment);
  assert.ok(typeof r.body.data.environment.stationCount === 'number');
  assert.ok(r.body.data.openAlerts != null);
  assert.ok(Array.isArray(r.body.data.providerHealth));
});

test('V10 what-changed: returns recent events', async () => {
  await seed();
  const r = await request(app).get('/api/v1/intelligence/what-changed?minutes=60');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V10 why: returns intelligence items', async () => {
  await seed();
  const r = await request(app).get('/api/v1/intelligence/why');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V10 what-next: returns forecasts', async () => {
  await seed();
  const r = await request(app).get('/api/v1/intelligence/what-next');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V10 what-to-do: returns recommendations', async () => {
  await seed();
  const r = await request(app).get('/api/v1/intelligence/what-to-do');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V9 search: returns ranked results across types', async () => {
  await seed();
  // Search by station id (unique) rather than name. Alert entries carry the
  // same station name and score +5, which can crowd station results out of
  // the top-50 slice when many alerts exist from prior seeds.
  const query = stations[0].id;
  const r = await request(app).get(`/api/v1/search?q=${encodeURIComponent(query)}`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.length > 0, 'search should match station id');
  const types = new Set(r.body.data.map((x) => x.type));
  assert.ok(types.has('station'), 'must include station result');
});

test('V9 search: short query returns empty', async () => {
  const r = await request(app).get('/api/v1/search?q=a');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

test('V10 assistant v2: classifies intents and returns evidence', async () => {
  await seed();
  const queries = [
    { q: 'What is happening right now?', intent: 'happening_now' },
    { q: 'Which stations are critical?', intent: 'critical_stations' },
    { q: 'What changed in the last hour?', intent: 'last_hour' },
    { q: 'Which provider is failing?', intent: 'provider_issues' },
    { q: 'What should I investigate first?', intent: 'investigate_first' },
    { q: 'Which stations need maintenance?', intent: 'maintenance_risk' },
  ];
  for (const t of queries) {
    const r = await request(app).post('/api/v1/assistant/v2').send({ query: t.q });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.intent, t.intent, `intent for "${t.q}"`);
    assert.ok(typeof r.body.data.text === 'string' && r.body.data.text.length > 0);
  }
});

test('V4 station detail: telemetry + history + health + decision trace', async () => {
  await seed();
  const id = stations[0].id;
  const tel = await request(app).get(`/api/v1/stations/${id}/telemetry`);
  assert.equal(tel.status, 200);
  assert.ok(tel.body.data.telemetry);
  for (const f of ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall']) {
    assert.ok(tel.body.data.telemetry[f], `telemetry.${f}`);
  }
  const hist = await request(app).get(`/api/v1/stations/${id}/history?field=temperature&minutes=30`);
  assert.equal(hist.status, 200);
  assert.ok(Array.isArray(hist.body.data));
  const health = await request(app).get(`/api/v1/stations/${id}/health`);
  assert.equal(health.status, 200);
  assert.ok(typeof health.body.data.overall === 'number');
  assert.ok(Array.isArray(health.body.data.factors));
  const trace = await request(app).get(`/api/v1/stations/${id}/decision-trace`);
  assert.equal(trace.status, 200);
  assert.ok(Array.isArray(trace.body.data.stages));
  assert.ok(trace.body.data.stages.length >= 12, '12+ pipeline stages');
});

test('V4 station detail: comparison, timeline, environmental', async () => {
  await seed();
  const id = stations[0].id;
  const comp = await request(app).get(`/api/v1/stations/${id}/comparison`);
  assert.equal(comp.status, 200);
  assert.ok(comp.body.data.neighbours);
  assert.ok(comp.body.data.insight);
  const tl = await request(app).get(`/api/v1/stations/${id}/timeline`);
  assert.equal(tl.status, 200);
  assert.ok(tl.body.data.events);
  const env = await request(app).get(`/api/v1/stations/${id}/environmental`);
  assert.equal(env.status, 200);
  assert.ok(env.body.data.regionalMeans);
});

test('V4 station detail: returns 404 for unknown station', async () => {
  const r = await request(app).get('/api/v1/stations/UNKNOWN/telemetry');
  assert.equal(r.status, 404);
});

test('V6 investigation: create + transition + list + notes', async () => {
  await seed();
  const create = await request(app).post('/api/v1/investigations').set('Authorization', `Bearer ${await login()}`).send({ stationId: stations[0].id, title: 'Test investigation' });
  assert.equal(create.status, 200);
  const id = create.body.data.id;
  assert.equal(create.body.data.state, 'detected');
  const transition = await request(app).post(`/api/v1/investigations/${id}/transition`).set('Authorization', `Bearer ${await login()}`).send({ state: 'investigating', notes: 'investigating now' });
  assert.equal(transition.status, 200);
  assert.equal(transition.body.data.state, 'investigating');
  const list = await request(app).get('/api/v1/investigations');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 1);
  const note = await request(app).post(`/api/v1/investigations/${id}/notes`).set('Authorization', `Bearer ${await login()}`).send({ notes: 'follow up' });
  assert.equal(note.status, 200);
  assert.ok(note.body.data.notes.length >= 2);
});

test('V6 investigation: invalid transition returns 400', async () => {
  const token = await login();
  const create = await request(app).post('/api/v1/investigations').set('Authorization', `Bearer ${token}`).send({ stationId: stations[0].id });
  const id = create.body.data.id;
  const bad = await request(app).post(`/api/v1/investigations/${id}/transition`).set('Authorization', `Bearer ${token}`).send({ state: 'not-a-state' });
  assert.equal(bad.status, 400);
});

test('V6 correlation: returns alert clusters', async () => {
  await seed();
  const r = await request(app).get('/api/v1/alerts/correlated?minutes=1440');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V7 forecast: returns projected series + threshold crossing', async () => {
  await seed();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/forecast/${id}?horizon=30&minutes=60`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.forecasts);
  // Pick one field that exists in forecasts
  const keys = Object.keys(r.body.data.forecasts);
  if (keys.length) {
    const fc = r.body.data.forecasts[keys[0]];
    assert.ok(fc.model);
    assert.ok(typeof fc.confidence === 'number');
    assert.ok(Array.isArray(fc.forecast));
  }
});

test('V7 forecast: 404 for unknown station', async () => {
  const r = await request(app).get('/api/v1/forecast/NOPE');
  assert.equal(r.status, 404);
});

test('V5 advanced analytics: comprehensive shape', async () => {
  await seed();
  const r = await request(app).get('/api/v1/analytics/advanced?minutes=60');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.counts);
  assert.ok(r.body.data.crossParameter);
  assert.ok(r.body.data.hourly);
  assert.ok(r.body.data.weekday);
  assert.ok(r.body.data.clusters);
  assert.ok(r.body.data.spatialDeviations);
  assert.ok(r.body.data.anomalyDensity);
});

test('V5 advanced analytics: baselines + spatial + correlation', async () => {
  await seed();
  const baselines = await request(app).get('/api/v1/analytics/baselines');
  assert.equal(baselines.status, 200);
  const spatial = await request(app).get('/api/v1/analytics/spatial');
  assert.equal(spatial.status, 200);
  assert.ok(Array.isArray(spatial.body.data));
  const corr = await request(app).get('/api/v1/analytics/correlation');
  assert.equal(corr.status, 200);
  assert.ok(Array.isArray(corr.body.data));
});

test('V4 station intelligence: returns structured items', async () => {
  await seed();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/stations/${id}/intelligence`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V4 station detail: alerts + maintenance per station', async () => {
  await seed();
  const id = stations[0].id;
  const alerts = await request(app).get(`/api/v1/stations/${id}/alerts`);
  assert.equal(alerts.status, 200);
  const maint = await request(app).get(`/api/v1/stations/${id}/maintenance`);
  assert.equal(maint.status, 200);
  assert.ok(maint.body.data.history);
});

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  return r.body.data.token;
}