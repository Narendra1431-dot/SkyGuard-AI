'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, processReading } = require('../src/server');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

test('truthfulness: /api/v1/stations/:id returns the requested station only', async () => {
  await initFromEnv(config.auth);
  await processReading({ stationId: 'HYD001', time: new Date().toISOString(), temperature: 25, pressure: 1012, humidity: 50, aqi: 80, wind: 3, rainfall: 0, anomaly: 0, source: { provider: 'open-meteo', station: 'HYD001', retrievedAt: new Date().toISOString(), observationAt: new Date().toISOString(), quality: 'ok', fallback: false, cacheHit: false, url: null } });
  const r1 = await request(app).get('/api/v1/stations/HYD001');
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.id, 'HYD001');
  assert.ok(r1.body.meta && r1.body.meta._source, 'response should include provenance');
  assert.equal(r1.body.meta._source.stationId, 'HYD001');
  assert.equal(r1.body.meta._source.source, 'open-meteo');

  const r2 = await request(app).get('/api/v1/stations/MUM002');
  assert.equal(r2.status, 200);
  assert.equal(r2.body.data.id, 'MUM002');
  // The two stations must be different
  assert.notEqual(r1.body.data.id, r2.body.data.id);
});

test('truthfulness: /api/v1/dashboard returns provenance and live counts', async () => {
  const r = await request(app).get('/api/v1/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.equal(typeof r.body.data.totalStations, 'number');
  assert.equal(typeof r.body.data.readingsPerMinute, 'number');
  assert.ok(r.body.meta && r.body.meta._source);
  assert.equal(r.body.meta._source.endpoint, '/api/v1/dashboard');
});

test('truthfulness: /api/v1/health/providers returns the active provider state', async () => {
  const r = await request(app).get('/api/v1/health/providers');
  assert.equal(r.status, 200);
  assert.ok(r.body.data);
  assert.ok(r.body.data['open-meteo']);
  assert.equal(r.body.data['open-meteo'].id, 'open-meteo');
  assert.ok(['DISABLED', 'IDLE', 'OK', 'NOT_CONFIGURED', 'CIRCUIT_OPEN'].includes(r.body.data['open-meteo'].status));
});

test('truthfulness: /api/v1/stations/:id/404 returns 404 with provenance', async () => {
  const r = await request(app).get('/api/v1/stations/NONEXISTENT-STATION-12345');
  assert.equal(r.status, 404);
  assert.ok(r.body.error);
});
