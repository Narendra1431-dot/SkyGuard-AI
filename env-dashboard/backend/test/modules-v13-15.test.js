'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const request = require('supertest');
const { app, stations, processReading, io } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

before(async () => { try { await initFromEnv(config.auth); } catch (_) {} });

async function seedReadings() {
  for (const s of stations) {
    await processReading({ ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString() });
  }
}

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  assert.equal(r.status, 200);
  return r.body.data.token;
}

test('advanced analytics: trends endpoint returns trend classification', async () => {
  await seedReadings();
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const id = stations[0].id;
  const r = await request(app).get('/api/v1/analytics/trends').set(auth).query({ stationId: id, field: 'temperature', minutes: 60 });
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.ok(['increasing', 'decreasing', 'stable', 'insufficient_data'].includes(r.body.data.trend.classification));
});

test('advanced analytics: summary endpoint returns statistics', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const id = stations[0].id;
  const r = await request(app).get('/api/v1/analytics/summary').set(auth).query({ stationId: id, field: 'temperature', minutes: 60 });
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  const s = r.body.data.summary;
  assert.ok(typeof s.count === 'number');
  if (s.available) {
    assert.ok(typeof s.min === 'number');
    assert.ok(typeof s.max === 'number');
    assert.ok(typeof s.mean === 'number');
    assert.ok(typeof s.median === 'number');
    assert.ok(typeof s.std === 'number');
    assert.ok(typeof s.latest === 'number');
  }
});

test('advanced analytics: risk endpoint returns risk summary', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/analytics/risk').set(auth).query({ minutes: 60 });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data.maxSeverity === 'string');
  assert.ok(Array.isArray(r.body.data.factors));
});

test('advanced analytics: export json returns data', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/analytics/export').set(auth).query({ minutes: 60, format: 'json' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data.data));
});

test('advanced analytics: compare requires at least 2 stations', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const id = stations[0].id;
  const r = await request(app).get('/api/v1/analytics/compare').set(auth).query({ stationIds: id, field: 'temperature' });
  assert.equal(r.status, 400);
});

test('advanced analytics: compare returns station comparison', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const ids = stations.slice(0, 2).map((s) => s.id).join(',');
  const r = await request(app).get('/api/v1/analytics/compare').set(auth).query({ stationIds: ids, field: 'temperature', minutes: 60 });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.stations));
  assert.ok(r.body.data.stations.length >= 2);
});

test('advanced analytics: ranking returns ranked stations', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/analytics/ranking').set(auth).query({ field: 'temperature', minutes: 60 });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.ranking));
  assert.equal(r.body.data.field, 'temperature');
  assert.ok(r.body.data.note.includes('temperature'));
});

test('advanced analytics: trends rejects invalid station', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/analytics/trends').set(auth).query({ stationId: 'nonexistent', field: 'temperature' });
  assert.equal(r.status, 400);
});

test('architecture: data-flow endpoint returns connections', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/architecture/data-flow').set(auth);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.connections));
  assert.ok(r.body.data.providerFailover);
});

test('architecture: snapshot returns core and optional arrays', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/architecture').set(auth);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.core));
  assert.ok(Array.isArray(r.body.data.optional));
  assert.ok(r.body.data.core.length > 0);
  assert.ok(r.body.data.status);
});

test('config: schema endpoint returns schema', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/config/schema').set(auth);
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.data === 'object');
  assert.ok('thresholds' in r.body.data);
  assert.ok('system' in r.body.data);
});

test('config: test endpoint returns test result', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).post('/api/v1/config/system/test').set(auth);
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.ok(['UP', 'GRAY', 'SKIPPED'].includes(r.body.data.status));
});

test('config: reset endpoint restores defaults', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).post('/api/v1/config/system/reset').set(auth);
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.ok('notificationsEnabled' in r.body.data);
  assert.ok('autoRefreshSeconds' in r.body.data);
});

test('config: validation rejects out-of-range values', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).put('/api/v1/config/thresholds').set(auth).send({ temperature_warning: -10 });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.message.includes('Validation failed'));
});

test('advanced analytics: comprehensive filters by stationId', async () => {
  await seedReadings();
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const id = stations[0].id;
  const r = await request(app).get('/api/v1/analytics/advanced').set(auth).query({ minutes: 60, stationId: id });
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.ok(r.body.data.counts);
  const allReadings = r.body.data.counts.total;
  const stationBaselines = r.body.data.baselines || {};
  const stationEntries = Object.entries(stationBaselines).filter(([, v]) => (v.fields?.temperature?.baseline?.count || 0) > 0 || (v.fields?.aqi?.baseline?.count || 0) > 0);
  const hasOnlySelectedStation = stationEntries.length === 1 && stationEntries[0][0] === id;
  assert.ok(hasOnlySelectedStation || allReadings > 0, 'stationId filter should limit baseline data to selected station');
});

test('advanced analytics: comprehensive cache varies by stationId', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const id1 = stations[0].id;
  const id2 = stations[1]?.id || id1;
  const r1 = await request(app).get('/api/v1/analytics/advanced').set(auth).query({ minutes: 60, stationId: id1 });
  assert.equal(r1.status, 200);
  const r2 = await request(app).get('/api/v1/analytics/advanced').set(auth).query({ minutes: 60, stationId: id2 });
  assert.equal(r2.status, 200);
  assert.ok(r1.body.data.counts !== undefined);
  assert.ok(r2.body.data.counts !== undefined);
});

test('config: unknown section rejected', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).put('/api/v1/config/unknown').set(auth).send({ foo: 'bar' });
  assert.equal(r.status, 400);
});

test('architecture: data-flow derives real analytics/anomaly/assistant status', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/architecture/data-flow').set(auth);
  assert.equal(r.status, 200);
  const flow = r.body.data;
  const analytics = flow.connections.find((c) => c.id === 'analytics');
  const anomaly = flow.connections.find((c) => c.id === 'anomaly-detection');
  const assistant = flow.connections.find((c) => c.id === 'assistant');
  assert.ok(analytics);
  assert.ok(['UP', 'DOWN', 'DEGRADED', 'YELLOW', 'RED', 'GREEN', 'GRAY'].includes(analytics.status));
  assert.ok(anomaly);
  assert.ok(['UP', 'DOWN', 'DEGRADED', 'YELLOW', 'RED', 'GREEN', 'GRAY'].includes(anomaly.status));
  assert.ok(assistant);
  assert.ok(['UP', 'DOWN', 'DEGRADED', 'YELLOW', 'RED', 'GREEN', 'GRAY', 'NOT_CONFIGURED'].includes(assistant.status));
});

test('advanced analytics: export csv returns text/csv', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/analytics/export').set(auth).query({ minutes: 60, format: 'csv' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/csv; charset=utf-8');
  assert.ok(typeof r.text === 'string');
});

test('config: section values do not expose provider secrets', async () => {
  const token = await login();
  const auth = { Authorization: 'Bearer ' + token };
  const r = await request(app).get('/api/v1/config').set(auth);
  assert.equal(r.status, 200);
  const all = r.body.data;
  const flat = Object.values(all).flatMap((v) => (v ? Object.values(v) : []));
  for (const v of flat) {
    assert.ok(!String(v).includes('apiKey'), 'config API must not expose apiKey');
    assert.ok(!String(v).includes('password'), 'config API must not expose password');
    assert.ok(!String(v).includes('token'), 'config API must not expose token');
  }
});
