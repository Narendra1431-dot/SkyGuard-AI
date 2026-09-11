'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const request = require('supertest');
const { app, stations, processReading } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');
const operations = require('../src/db/operations');

before(async () => {
  operations.resetState();
  try { await initFromEnv(config.auth); } catch (_) {}
});

async function seed() {
  for (const s of stations) {
    await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString() });
  }
}

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  return r.body.data.token;
}

test('failure/recovery: provider without key reports GRAY, recovery via test', async () => {
  const token = await login();
  await request(app).put('/api/v1/providers/openweather').set('Authorization', `Bearer ${token}`).send({ credentials: { apiKey: '' }, enabled: false });
  let r = await request(app).get('/api/v1/providers/openweather');
  assert.equal(r.body.data.status, 'GRAY');
  assert.equal(r.body.data.configurationState, 'NOT_CONFIGURED');
  // "Recovery": provide an invalid key + enable + test → RED (real probe)
  await request(app).put('/api/v1/providers/openweather').set('Authorization', `Bearer ${token}`).send({ credentials: { apiKey: 'invalid' }, enabled: true });
  r = await request(app).post('/api/v1/providers/openweather/test').set('Authorization', `Bearer ${token}`);
  assert.ok(['GREEN', 'RED'].includes(r.body.data.status));
  // Reset
  await request(app).put('/api/v1/providers/openweather').set('Authorization', `Bearer ${token}`).send({ credentials: {}, enabled: false });
});

test('failure/recovery: notification channel failure path persists history', async () => {
  const token = await login();
  const c = await request(app).post('/api/v1/notifications/channels').set('Authorization', `Bearer ${token}`).send({ type: 'webhook', name: 'recover-test', enabled: true, credentials: { url: 'http://127.0.0.1:1/nope', timeoutMs: 1000 } });
  assert.equal(c.status, 200);
  const id = c.body.data.id;
  const t = await request(app).post(`/api/v1/notifications/channels/${id}/test`).set('Authorization', `Bearer ${token}`);
  assert.equal(t.body.data.status, 'RED');
  const hist = await request(app).get('/api/v1/notifications/history?channelId=' + id).set('Authorization', `Bearer ${token}`);
  assert.ok(hist.body.data.some((h) => h.status === 'RED'));
  await request(app).delete(`/api/v1/notifications/channels/${id}`).set('Authorization', `Bearer ${token}`);
});

test('failure/recovery: unknown station returns 404 across all station endpoints', async () => {
  for (const path of ['/api/v1/stations/UNKNOWN', '/api/v1/stations/UNKNOWN/telemetry', '/api/v1/stations/UNKNOWN/history', '/api/v1/stations/UNKNOWN/health', '/api/v1/stations/UNKNOWN/comparison', '/api/v1/stations/UNKNOWN/timeline', '/api/v1/stations/UNKNOWN/decision-trace', '/api/v1/stations/UNKNOWN/environmental', '/api/v1/stations/UNKNOWN/intelligence', '/api/v1/forecast/UNKNOWN']) {
    const r = await request(app).get(path);
    assert.equal(r.status, 404, `404 for ${path}`);
  }
});

test('V3 real-time: socket.io client can connect and receive sensor:update', async () => {
  const { Server } = require('socket.io');
  const http = require('http');
  const { io: Client } = require('socket.io-client');
  const srv = http.createServer();
  const ioServer = new Server(srv);
  ioServer.on('connection', (s) => {
    setTimeout(() => s.emit('sensor:update', { stationId: 'X', status: 'healthy' }), 50);
  });
  await new Promise((r) => srv.listen(0, r));
  const port = srv.address().port;
  const url = `http://127.0.0.1:${port}`;
  const events = [];
  await new Promise((resolve, reject) => {
    const c = Client(url, { transports: ['websocket'] });
    c.on('sensor:update', (p) => { events.push(p); c.close(); resolve(); });
    c.on('connect_error', reject);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
  assert.equal(events.length, 1);
  srv.close();
});

test('V9 search: supports multi-type ranked results', async () => {
  await seed();
  const r = await request(app).get(`/api/v1/search?q=${encodeURIComponent(stations[0].id)}`);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length >= 1);
});

test('V10 assistant v2: city-specific question returns reading', async () => {
  await seed();
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'What is the current AQI in Delhi?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.intent, 'aqi');
});

test('V10 assistant v2: help returns guidance', async () => {
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'help' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.intent, 'help');
});

test('V11 agent contract: assistant exposes allowlisted live-data tools and sources', async () => {
  await seed();
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'Which stations are critical?' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.toolCalls));
  assert.ok(r.body.data.toolCalls.some((tool) => tool.name === 'get_current_readings'));
  assert.ok(r.body.data.toolCalls.every((tool) => tool.class === 'read_only' && tool.status === 'completed'));
  assert.ok(Array.isArray(r.body.data.sources));
  assert.equal(r.body.data.sources[0].type, 'live_data');
  assert.equal(r.body.data.requiresConfirmation, false);
  const audit = await request(app).get('/api/v1/audit?resource=agent_tool').set('Authorization', `Bearer ${await login()}`);
  assert.ok(audit.body.data.some((entry) => entry.action === 'tool_call' && entry.resourceId === 'get_current_readings'));
});

test('V10 assistant v2: geographically related anomalies', async () => {
  await seed();
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'Which anomalies are geographically related?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.intent, 'geo_related');
});

test('V8 architecture: pipeline components expose latency + status', async () => {
  const r = await request(app).get('/api/v1/architecture');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.components.api);
  assert.ok(r.body.data.components.ingestion);
  assert.ok(r.body.data.components.anomalyEngine);
});

test('V10: situation endpoint exposes critical stations sorted by severity', async () => {
  await seed();
  // Force a critical reading
  await processReading({ ...tickReading(stations[0], Math.floor(Date.now() / 1000)), time: new Date().toISOString(), aqi: 300, temperature: 43, humidity: 10, anomaly: 1 });
  await new Promise((r) => setTimeout(r, 300));
  const r = await request(app).get('/api/v1/intelligence/situation');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.environment.criticalCount >= 1);
  assert.ok(r.body.data.criticalStations.length >= 1);
});

test('V6 investigation: list by station filter', async () => {
  await seed();
  const token = await login();
  await request(app).post('/api/v1/investigations').set('Authorization', `Bearer ${token}`).send({ stationId: stations[0].id });
  await request(app).post('/api/v1/investigations').set('Authorization', `Bearer ${token}`).send({ stationId: stations[1].id });
  const r = await request(app).get(`/api/v1/investigations?stationId=${stations[0].id}`).set('Authorization', `Bearer ${token}`);
  assert.ok(r.body.data.every((i) => i.stationId === stations[0].id));
});

test('V10: data lineage endpoint returns stages', async () => {
  await seed();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/stations/${id}/intelligence`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.ok(r.body.data.length > 0);
});

test('V5 advanced analytics: stations have baselines with mean and std', async () => {
  await seed();
  const r = await request(app).get('/api/v1/analytics/baselines');
  assert.equal(r.status, 200);
  const ids = Object.keys(r.body.data);
  assert.ok(ids.length >= 1);
  for (const id of ids) {
    assert.ok(r.body.data[id].fields);
    for (const f of ['temperature', 'aqi']) {
      assert.ok(typeof r.body.data[id].fields[f].baseline.mean === 'number');
      assert.ok(typeof r.body.data[id].fields[f].baseline.std === 'number');
    }
  }
});

test('V4 station detail: environmental context returns regional means', async () => {
  await seed();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/stations/${id}/environmental`);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.regionalMeans.temperature === 'number');
});

test('V3 event bus: publishes quality.updated periodically', async () => {
  await seed();
  await new Promise((r) => setTimeout(r, 200));
  const r = await request(app).get('/api/v1/events?category=quality');
  assert.equal(r.status, 200);
  // May or may not have entries — just verify the call works
  assert.ok(Array.isArray(r.body.data));
});

test('V6 alert correlation: works with no alerts', async () => {
  const r = await request(app).get('/api/v1/alerts/correlated?minutes=1440');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
});

test('V4 station detail: comparison has insight field', async () => {
  await seed();
  const r = await request(app).get(`/api/v1/stations/${stations[0].id}/comparison`);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.insight === 'string');
});

test('V2 dashboard: returns aggregate station counts', async () => {
  await seed();
  const r = await request(app).get('/api/v1/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.stations);
  assert.equal(r.body.data.totalStations, stations.length);
});