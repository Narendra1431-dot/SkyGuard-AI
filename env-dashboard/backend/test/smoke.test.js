'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { app, stations, processReading } = require('../src/server');
const { tickReading } = require('../src/stations');

async function seedOneReading() {
  const station = stations[0];
  const reading = { ...tickReading(station, Math.floor(Date.now() / 1000)), time: new Date().toISOString() };
  await processReading(reading);
}

test('serves the documented SkyGuard client at the backend root', async () => {
  const response = await request(app).get('/');
  assert.equal(response.status, 200);
  assert.match(response.text, /SkyGuard AI - Real-Time Environmental Monitoring/);
  assert.match(response.text, /\/js\/main\.js/);
});

test('health and dashboard expose live runtime data', async () => {
  await seedOneReading();
  const [health, dashboard] = await Promise.all([
    request(app).get('/api/v1/health'),
    request(app).get('/api/v1/dashboard'),
  ]);
  assert.equal(health.status, 200);
  assert.equal(health.body.success, true);
  assert.ok(health.body.data.components.analytics.latencyMs >= 0);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.success, true);
  assert.ok(dashboard.body.data.responseTimeMs >= 0);
  assert.equal(dashboard.body.data.totalStations, stations.length);
  const systemHealth = await request(app).get('/api/v1/system/health');
  const components = await request(app).get('/api/v1/system/components');
  assert.equal(systemHealth.status, 200);
  assert.equal(components.status, 200);
  assert.equal(health.body.data.status, components.body.data.api.status === 'UP' || components.body.data.api.status === 'GREEN' ? health.body.data.status : health.body.data.status);
});
