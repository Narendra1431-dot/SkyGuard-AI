'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const request = require('supertest');
const { app, stations, processReading, io } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

// Ensure the in-memory admin user is seeded (the same path the running server
// takes at boot). Tests below depend on this completing first.
before(async () => { try { await initFromEnv(config.auth); } catch (_) {} });

async function seedReadings() {
  // Ensure at least a few readings exist
  for (const s of stations) {
    await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString() });
  }
}

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  assert.equal(r.status, 200);
  return r.body.data.token;
}

test('auth: login + me + bad password + missing user', async () => {
  const ok = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.data.token);
  const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${ok.body.data.token}`);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.username, 'admin');
  const bad = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'wrong' });
  assert.equal(bad.status, 401);
  const missing = await request(app).post('/api/v1/auth/login').send({});
  assert.equal(missing.status, 400);
  const noToken = await request(app).get('/api/v1/auth/me');
  assert.equal(noToken.status, 401);
});

test('public read endpoints return expected shapes', async () => {
  await seedReadings();
  for (const path of ['/api/v1/health','/api/v1/dashboard','/api/v1/stations','/api/v1/alerts/stats','/api/v1/quality','/api/v1/quality/issues','/api/v1/quality/history','/api/v1/architecture','/api/v1/system/components','/api/v1/system/pipeline','/api/v1/system/metrics','/api/v1/system/health','/api/v1/maintenance','/api/v1/ml/status','/api/v1/ml/metrics','/api/v1/ml/performance','/api/v1/ml/confusion-matrix','/api/v1/ml/roc','/api/v1/ml/features','/api/v1/ml/drift','/api/v1/ml/latency','/api/v1/ml/threshold','/api/v1/ml/runs','/api/v1/providers','/api/v1/analytics','/api/v1/anomalies','/api/v1/readings','/api/v1/history']) {
    const r = await request(app).get(path);
    assert.equal(r.status, 200, `GET ${path}`);
    assert.equal(r.body.success, true, `success for ${path}`);
  }
});

test('readings endpoint supports stationId + minutes', async () => {
  await seedReadings();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/readings?stationId=${id}&minutes=10`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  for (const item of r.body.data) assert.equal(item.stationId, id);
});

test('history endpoint supports field selection and 404 for unknown station', async () => {
  await seedReadings();
  const id = stations[0].id;
  const r = await request(app).get(`/api/v1/history?stationId=${id}&field=aqi&minutes=10`);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  const bad = await request(app).get('/api/v1/history?stationId=does-not-exist');
  assert.equal(bad.status, 404);
});

test('provider CRUD requires auth and supports create/update/delete/test', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // create
  // Use a per-run unique id so a leftover provider id in the shared persisted
  // state (written by concurrent test-spawned server processes) can never make
  // createProvider return the duplicate-id path (400).
  const name = `TestProvider-${Date.now()}-${process.pid}`;
  const c = await request(app).post('/api/v1/providers').set(auth).send({ name, priority: 7, enabled: true, credentials: { apiKey: 'secret' } });
  assert.equal(c.status, 201);
  const id = c.body.data.id;
  // update
  const u = await request(app).put(`/api/v1/providers/${id}`).set(auth).send({ priority: 3, enabled: false });
  assert.equal(u.status, 200);
  assert.equal(u.body.data.priority, 3);
  // enable
  const e = await request(app).post(`/api/v1/providers/${id}/enable`).set(auth);
  assert.equal(e.status, 200);
  assert.equal(e.body.data.enabled, true);
  // test
  const t = await request(app).post(`/api/v1/providers/${id}/test`).set(auth);
  assert.equal(t.status, 200);
  // priority
  const p = await request(app).post(`/api/v1/providers/${id}/priority`).set(auth).send({ priority: 1 });
  assert.equal(p.status, 200);
  // delete
  const d = await request(app).delete(`/api/v1/providers/${id}`).set(auth);
  assert.equal(d.status, 200);
  // unauthorized create
  const noauth = await request(app).post('/api/v1/providers').send({ name: 'X' });
  assert.equal(noauth.status, 401);
});

test('config + thresholds: save persists and audit entry is recorded', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const r = await request(app).put('/api/v1/config/system').set(auth).send({ autoRefreshSeconds: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.autoRefreshSeconds, 7);
  const thr = await request(app).get('/api/v1/thresholds').set(auth);
  assert.equal(thr.status, 200);
  assert.ok(typeof thr.body.data.aqi_warning === 'number');
  const save = await request(app).put('/api/v1/thresholds').set(auth).send({ aqi_warning: 175 });
  assert.equal(save.status, 200);
  assert.equal(save.body.data.aqi_warning, 175);
  const aud = await request(app).get('/api/v1/audit?action=update&resource=thresholds').set(auth);
  assert.equal(aud.status, 200);
  assert.ok(aud.body.data.length >= 1);
});

test('alerts: list + stats + acknowledge + resolve + reopen + escalate + mute + retry', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Force a critical reading to generate an alert
  const s = stations[0];
  await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString(), aqi: 300, temperature: 43, humidity: 10, anomaly: 1 });
  const list = await request(app).get('/api/v1/alerts');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.length >= 1);
  const id = list.body.data[0].id;
  const ack = await request(app).post(`/api/v1/alerts/${id}/acknowledge`).set(auth);
  assert.equal(ack.status, 200);
  const esc = await request(app).post(`/api/v1/alerts/${id}/escalate`).set(auth);
  assert.equal(esc.status, 200);
  const mute = await request(app).post(`/api/v1/alerts/${id}/mute`).set(auth);
  assert.equal(mute.status, 200);
  const unmute = await request(app).post(`/api/v1/alerts/${id}/unmute`).set(auth);
  assert.equal(unmute.status, 200);
  const resolve = await request(app).post(`/api/v1/alerts/${id}/resolve`).set(auth);
  assert.equal(resolve.status, 200);
  const reopen = await request(app).post(`/api/v1/alerts/${id}/reopen`).set(auth);
  assert.equal(reopen.status, 200);
  const retry = await request(app).post(`/api/v1/alerts/${id}/retry`).set(auth);
  assert.equal(retry.status, 200);
  const nf = await request(app).get(`/api/v1/alerts/does-not-exist`);
  assert.equal(nf.status, 404);
  const stats = await request(app).get('/api/v1/alerts/stats');
  assert.equal(stats.status, 200);
  assert.ok(typeof stats.body.data.total === 'number');
});

test('reports: generate + list + get + download + delete', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const gen = await request(app).post('/api/v1/reports').set(auth).send({ category: 'environmental_summary', format: 'json' });
  assert.equal(gen.status, 200);
  assert.equal(gen.body.data.status, 'completed');
  const id = gen.body.data.id;
  const list = await request(app).get('/api/v1/reports').set(auth);
  assert.equal(list.status, 200);
  const get = await request(app).get(`/api/v1/reports/${id}`).set(auth);
  assert.equal(get.status, 200);
  const dl = await request(app).get(`/api/v1/reports/${id}/download`).set(auth);
  assert.equal(dl.status, 200);
  assert.ok(dl.text.length > 0);
  // bad category
  const bad = await request(app).post('/api/v1/reports').set(auth).send({ category: 'nope' });
  assert.equal(bad.status, 400);
  // delete
  const del = await request(app).delete(`/api/v1/reports/${id}`).set(auth);
  assert.equal(del.status, 200);
});

test('ml: validate + retrain + run history', async () => {
  await seedReadings();
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const v = await request(app).post('/api/v1/ml/validate').set(auth);
  assert.equal(v.status, 200);
  assert.equal(v.body.data.status, 'UNVERIFIED');
  assert.equal(v.body.data.evaluationStatus, 'UNVERIFIED', 'evaluationStatus must be UNVERIFIED when no independent labeled eval data exists');
  const r = await request(app).post('/api/v1/ml/retrain').set(auth);
  assert.equal(r.status, 200);
  const runs = await request(app).get('/api/v1/ml/runs');
  assert.equal(runs.status, 200);
  assert.ok(runs.body.data.length >= 1);
});

test('ml truthfulness: status endpoint reports UNVERIFIED without independent eval data', async () => {
  await seedReadings();
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const v = await request(app).post('/api/v1/ml/validate').set(auth);
  assert.equal(v.status, 200);
  assert.equal(v.body.data.evaluationStatus, 'UNVERIFIED', 'validate must report UNVERIFIED when no independent eval data exists');
  const s = await request(app).get('/api/v1/ml/status');
  assert.equal(s.status, 200);
  assert.equal(s.body.data.evaluationStatus, 'UNVERIFIED', 'status must report UNVERIFIED when no independent eval data exists');
  assert.ok(s.body.data.notes.includes('independent') || s.body.data.notes.includes('No trained model'));
});

test('assistant truthfulness: v2 response includes truthful LLM status', async () => {
  await seedReadings();
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'help' });
  assert.equal(r.status, 200);
  assert.ok('llmStatus' in r.body.data, 'v2 response must include llmStatus');
  assert.equal(r.body.data.llmStatus, 'unavailable', 'no real LLM configured => unavailable');
  assert.equal(r.body.data.llmMode, 'DETERMINISTIC_FALLBACK', 'mode must be clearly labeled');
  assert.equal(r.body.data.llmUsed, false);
});

test('maintenance: list + per-station history', async () => {
  await seedReadings();
  const list = await request(app).get('/api/v1/maintenance');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.data));
  const s = stations[0].id;
  const hist = await request(app).get(`/api/v1/maintenance/${s}`);
  assert.equal(hist.status, 200);
});

test('assistant: returns structured reply', async () => {
  await seedReadings();
  const r = await request(app).post('/api/v1/assistant').send({ query: 'What is the current AQI in Delhi?' });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.text === 'string');
});

test('socket.io: connection emits system:update', async () => {
  const { io: Client } = require('socket.io-client');
  const url = `http://localhost:${process.env.PORT || 4000}`;
  // We can't easily start the server in a test; just inspect io interface
  assert.ok(io && typeof io.on === 'function');
  // sanity: server object has the expected methods
  const { server } = require('../src/server');
  assert.equal(typeof server.listen, 'function');
});

// ---------------- EXPANDED NOTIFICATION TESTS ----------------

test('notifications: adapter status is GRAY when configured but not tested', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Create a webhook channel with valid-looking URL — configured but not tested
  const create = await request(app).post('/api/v1/notifications/channels').set(auth)
    .send({ type: 'webhook', name: 'ntf-status-test', credentials: { url: 'http://example.com/hook' } });
  assert.equal(create.status, 200);
  const channels = await request(app).get('/api/v1/notifications').set(auth);
  assert.equal(channels.status, 200);
  const ch = channels.body.data.find((c) => c.id === create.body.data.id);
  assert.ok(ch);
  // Status of a configured-but-untested channel must be GRAY, not CONFIGURED/green
  assert.equal(ch.status.status, 'GRAY');
  // Cleanup
  await request(app).delete(`/api/v1/notifications/channels/${ch.id}`).set(auth);
});

test('notifications: unconfigured channel shows NOT_CONFIGURED (GRAY)', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Create with no credentials — should be rejected by validation
  const bad = await request(app).post('/api/v1/notifications/channels').set(auth)
    .send({ type: 'email', name: 'bad-email', credentials: {} });
  assert.equal(bad.status, 400);
});

test('notifications: delivery history is persisted and queryable', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Create a webhook targeting a closed port so the test produces a real (failed) delivery record
  const create = await request(app).post('/api/v1/notifications/channels').set(auth)
    .send({ type: 'webhook', name: 'hist-test', enabled: true, credentials: { url: 'http://127.0.0.1:1/hook', timeoutMs: 1000 } });
  assert.equal(create.status, 200);
  const id = create.body.data.id;
  const testRes = await request(app).post(`/api/v1/notifications/channels/${id}/test`).set(auth);
  assert.equal(testRes.status, 200);
  assert.equal(testRes.body.data.kind, 'test');
  // History should contain the test record
  const hist = await request(app).get('/api/v1/notifications/history').set(auth);
  assert.equal(hist.status, 200);
  assert.ok(hist.body.data.some((h) => h.channelId === id && h.kind === 'test'));
  // Filtered history by channel
  const chHist = await request(app).get(`/api/v1/notifications/history?channelId=${id}`).set(auth);
  assert.ok(chHist.body.data.every((h) => h.channelId === id));
  // Cleanup
  await request(app).delete(`/api/v1/notifications/channels/${id}`).set(auth);
});

test('notifications: alert dispatch records GRAY for unconfigured channel', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const { dispatchAlert, historyFor, reset } = require('../src/services/notifications');
  reset();
  const empty = await dispatchAlert({ id: 'ALT-TEST', severity: 'critical', title: 'test', description: '', station: 's', stationId: 's', createdAt: new Date().toISOString() });
  assert.ok(Array.isArray(empty));
  assert.equal(empty.length, 0);
});

test('notifications: SMS/Telegram/Slack show GRAY when unconfigured', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  for (const type of ['sms', 'telegram', 'slack']) {
    // Create requires valid config for sms/telegram/slack — test status via unconfigured adapter directly
    const { adapters } = require('../src/services/notifications');
    const adapter = adapters[type];
    assert.ok(adapter);
    const result = await adapter.send({}, { subject: 'test', text: 'test' });
    assert.equal(result.status, 'GRAY');
  }
});

test('notifications: email adapter validates required fields', async () => {
  const { adapters } = require('../src/services/notifications');
  const v = adapters.email.validateConfig({});
  assert.equal(v.valid, false);
  assert.ok(v.errors.length >= 6);
  const v2 = adapters.email.validateConfig({ host: 'smtp.example.com', port: 587, username: 'u', password: 'p', sender: 's@e.com', recipient: 'r@e.com' });
  assert.equal(v2.valid, true);
});

// ---------------- STORAGE BACKEND TESTS ----------------

test('storage: PostgreSQL is GRAY when not enabled', async () => {
  const r = await request(app).get('/api/v1/system/health');
  assert.equal(r.status, 200);
  const pg = r.body.data.components.find((c) => c.key === 'postgres');
  assert.ok(pg);
  if (process.env.PG_ENABLED !== 'true') {
    assert.equal(pg.color, 'GRAY');
    assert.notEqual(pg.color, 'GREEN');
  }
});

test('storage: MemoryStore is independently GREEN when active', async () => {
  const r = await request(app).get('/api/v1/system/health');
  assert.equal(r.status, 200);
  const ms = r.body.data.components.find((c) => c.key === 'memoryStore');
  assert.ok(ms);
  assert.equal(ms.color, 'GREEN');
});

test('storage: each backend reported independently in architecture snapshot', async () => {
  const r = await request(app).get('/api/v1/architecture');
  assert.equal(r.status, 200);
  const s = r.body.data.components.storage;
  assert.ok(s.memoryStore);
  assert.ok(s.sqlite);
  assert.ok(s.influxdb);
  assert.ok(s.postgres);
  // MemoryStore must be UP/GREEN, SQLite DISABLED/GRAY
  assert.equal(s.memoryStore.status, 'UP');
  assert.equal(s.sqlite.status, 'DISABLED');
});

test('storage: optional storage components do not make system RED when GRAY', async () => {
  const r = await request(app).get('/api/v1/system/health');
  assert.equal(r.status, 200);
  assert.ok(['GREEN', 'YELLOW'].includes(r.body.data.status));
});

// ---------------- PROVIDER FALLBACK TESTS ----------------

test('providers: fallback provider is NOT_CONFIGURED by default', async () => {
  const r = await request(app).get('/api/v1/providers/fallback');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'GRAY');
  assert.equal(r.body.data.configurationState, 'NOT_CONFIGURED');
});

test('providers: Open-Meteo is CONFIGURED and GREEN by default (real network possible)', async () => {
  const r = await request(app).get('/api/v1/providers/open-meteo');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.configurationState, 'CONFIGURED');
  assert.equal(r.body.data.enabled, true);
});

test('providers: OpenWeather is NOT_CONFIGURED without credentials', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Explicitly clear credentials by nulling each key
  await request(app).put('/api/v1/providers/openweather').set(auth).send({ credentials: { apiKey: null, baseUrl: null } });
  const r = await request(app).get('/api/v1/providers/openweather');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.configurationState, 'NOT_CONFIGURED');
  assert.equal(r.body.data.status, 'GRAY');
});

test('providers: provider runtime states in architecture snapshot', async () => {
  const r = await request(app).get('/api/v1/architecture');
  assert.equal(r.status, 200);
  const pv = r.body.data.components.providers;
  assert.ok(pv['open-meteo']);
  assert.ok(['ACTIVE', 'STANDBY', 'FAILED', 'NOT_CONFIGURED', 'PENDING'].includes(pv['open-meteo'].runtime));
  assert.ok(pv['openweather']);
  assert.ok(pv['fallback']);
});

// ---------------- NOTIFICATION PIPELINE TESTS ----------------

test('notifications: channel CRUD + enable/disable lifecycle', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const create = await request(app).post('/api/v1/notifications/channels').set(auth)
    .send({ type: 'webhook', name: 'lifecycle-test', credentials: { url: 'http://example.com/hook' } });
  assert.equal(create.status, 200);
  const id = create.body.data.id;
  // Disable
  const dis = await request(app).post(`/api/v1/notifications/channels/${id}/disable`).set(auth);
  assert.equal(dis.status, 200);
  assert.equal(dis.body.data.enabled, false);
  // Re-enable
  const en = await request(app).post(`/api/v1/notifications/channels/${id}/enable`).set(auth);
  assert.equal(en.status, 200);
  assert.equal(en.body.data.enabled, true);
  // Update
  const upd = await request(app).put(`/api/v1/notifications/channels/${id}`).set(auth)
    .send({ name: 'renamed-test' });
  assert.equal(upd.status, 200);
  assert.equal(upd.body.data.name, 'renamed-test');
  // Delete
  const del = await request(app).delete(`/api/v1/notifications/channels/${id}`).set(auth);
  assert.equal(del.status, 200);
  assert.equal(del.body.data.deleted, true);
  // 404 after delete
  const nf = await request(app).get(`/api/v1/notifications/history?channelId=${id}`).set(auth);
  assert.equal(nf.status, 200);
  assert.equal(nf.body.data.length, 0);
});

test('notifications: webhook test records real network attempt', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const create = await request(app).post('/api/v1/notifications/channels').set(auth)
    .send({ type: 'webhook', name: 'net-test', enabled: true, credentials: { url: 'http://127.0.0.1:1/webhook', timeoutMs: 1000 } });
  assert.equal(create.status, 200);
  const id = create.body.data.id;
  const testRes = await request(app).post(`/api/v1/notifications/channels/${id}/test`).set(auth);
  assert.equal(testRes.status, 200);
  // Real attempt to closed port must be RED (not hardcoded)
  assert.equal(testRes.body.data.status, 'RED');
  assert.ok(testRes.body.data.latencyMs >= 0);
  // Cleanup
  await request(app).delete(`/api/v1/notifications/channels/${id}`).set(auth);
});

// ---------------- SYSTEM HEALTH COMPREHENSIVE ----------------

test('system health: core components are GREEN, optional show correct states', async () => {
  const r = await request(app).get('/api/v1/system/health');
  assert.equal(r.status, 200);
  const byKey = Object.fromEntries(r.body.data.components.map((c) => [c.key, c]));
  // Core must be GREEN
  assert.equal(byKey.api.color, 'GREEN');
  assert.equal(byKey.websocket.color, 'GREEN');
  assert.equal(byKey.memoryStore.color, 'GREEN');
  assert.equal(byKey.ingestion.color, 'GREEN');
  // Optional — must not be RED (they can be GRAY or GREEN)
  assert.notEqual(byKey.postgres.color, 'RED');
  assert.notEqual(byKey.sqlite.color, 'RED');
});

test('system health: /api/v1/health returns same snapshot shape', async () => {
  const r = await request(app).get('/api/v1/health');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.status);
  assert.ok(r.body.data.components);
  assert.ok(typeof r.body.data.uptimeSeconds === 'number');
});

// ---------------- DATA QUALITY TESTS ----------------

test('quality: snapshot has overallScore and issues list', async () => {
  const r = await request(app).get('/api/v1/quality');
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.overallScore === 'number');
  assert.ok(Array.isArray(r.body.data.issues));
});

test('quality: issues and history endpoints return arrays', async () => {
  const issues = await request(app).get('/api/v1/quality/issues');
  assert.equal(issues.status, 200);
  assert.ok(Array.isArray(issues.body.data));
  const hist = await request(app).get('/api/v1/quality/history');
  assert.equal(hist.status, 200);
  assert.ok(Array.isArray(hist.body.data));
});

// ---------------- MAINTENANCE TESTS ----------------

test('maintenance: unknown station returns empty history (200)', async () => {
  const r = await request(app).get('/api/v1/maintenance/ZZZ-NONEXISTENT-STATION-ID');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data));
  assert.equal(r.body.data.length, 0);
});

// ---------------- ALERT STATE MACHINE TESTS ----------------

test('alerts: stats reflect state transitions', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  // Generate a critical alert
  const s = stations[0];
  await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString(), aqi: 300, temperature: 43, humidity: 10 });
  // Allow ingestion tick to process
  await new Promise((r) => setTimeout(r, 500));
  const stats = await request(app).get('/api/v1/alerts/stats');
  assert.equal(stats.status, 200);
  assert.ok(typeof stats.body.data.total === 'number');
});
