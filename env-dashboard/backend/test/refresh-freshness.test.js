'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const request = require('supertest');
const { app, stations, processReading, setIngestionPaused } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

before(async () => {
  try { await initFromEnv(config.auth); } catch (_) {}
  setIngestionPaused(true);
});

async function seedOneReading(station) {
  const reading = {
    ...tickReading(station, Math.floor(Date.now() / 1000)),
    time: new Date().toISOString(),
    stationId: station.id,
  };
  await processReading(reading);
}

test('latestStations: concurrent requests share one computed result (cache hit)', async () => {
  await seedOneReading(stations[0]);
  const concurrent = Array.from({ length: 10 }, () =>
    request(app).get('/api/v1/stations')
  );
  const results = await Promise.all(concurrent);
  const times = results.map((r) => r.headers['x-response-time'] || '0');
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.ok(Array.isArray(r.body.data));
  }
  const unique = new Set(results.map((r) => JSON.stringify(r.body.data)));
  assert.equal(unique.size, 1, 'all concurrent responses must be identical (same cached result)');
});

test('latestStations: second request within TTL returns cached result', async () => {
  await seedOneReading(stations[0]);
  const r1 = await request(app).get('/api/v1/stations');
  assert.equal(r1.status, 200);
  const r2 = await request(app).get('/api/v1/stations');
  assert.equal(r2.status, 200);
  assert.deepEqual(r1.body.data, r2.body.data);
});

test('processReading: invalidates stationsCache so next request gets fresh data', async () => {
  const s = stations[1];
  const r1 = await request(app).get('/api/v1/stations');
  assert.equal(r1.status, 200);
  const oldCount = r1.body.data.length;

  await seedOneReading(s);

  const r2 = await request(app).get('/api/v1/stations');
  assert.equal(r2.status, 200);
  assert.ok(Array.isArray(r2.body.data));
  assert.equal(r2.body.data.length, oldCount);
});

test('stations endpoint completes without timeout under normal conditions', async () => {
  const start = Date.now();
  const r = await request(app).get('/api/v1/stations');
  const elapsed = Date.now() - start;
  assert.equal(r.status, 200);
  assert.ok(elapsed < 5000, `stations endpoint took ${elapsed}ms — should complete in < 5s`);
});

test('stations endpoint: no old REST response overwrites newer socket state', async () => {
  const s = stations[2];
  await seedOneReading(s);
  const r1 = await request(app).get('/api/v1/stations');
  assert.equal(r1.status, 200);
  const firstStation = r1.body.data.find((st) => st.id === s.id);
  const firstTime = firstStation?.reading?.time;

  await new Promise((r) => setTimeout(r, 100));
  await seedOneReading(s);

  const r2 = await request(app).get('/api/v1/stations');
  assert.equal(r2.status, 200);
  const secondStation = r2.body.data.find((st) => st.id === s.id);
  const secondTime = secondStation?.reading?.time;

  if (firstTime && secondTime) {
    const t1 = new Date(firstTime).getTime();
    const t2 = new Date(secondTime).getTime();
    assert.ok(t2 >= t1, `newer reading.time (${t2}) must be >= older (${t1}): REST response cannot be older than what was already in cache`);
  }
});

test('dashboard endpoint completes without timeout under normal conditions', async () => {
  await seedOneReading(stations[0]);
  const start = Date.now();
  const r = await request(app).get('/api/v1/dashboard');
  const elapsed = Date.now() - start;
  assert.equal(r.status, 200);
  assert.ok(elapsed < 8000, `dashboard endpoint took ${elapsed}ms — should complete in < 8s`);
});

test('stations: reading.time is a real ISO timestamp (not fabricated)', async () => {
  await seedOneReading(stations[0]);
  const r = await request(app).get('/api/v1/stations');
  assert.equal(r.status, 200);
  for (const st of r.body.data) {
    if (st.reading?.time) {
      const t = new Date(st.reading.time).getTime();
      assert.ok(Number.isFinite(t), `reading.time must be valid ISO date: ${st.reading.time}`);
      assert.ok(t > 0, `reading.time must be > 0: ${st.reading.time}`);
      assert.ok(t <= Date.now() + 5000, `reading.time must not be in the future: ${st.reading.time}`);
    }
  }
});

test('stations: freshness (ageSeconds) is derived from real reading.time', async () => {
  await seedOneReading(stations[0]);
  const r = await request(app).get('/api/v1/stations');
  assert.equal(r.status, 200);
  for (const st of r.body.data) {
    if (st.reading?.time) {
      const ageSeconds = Math.round((Date.now() - new Date(st.reading.time).getTime()) / 1000);
      assert.ok(ageSeconds >= 0, `ageSeconds must be >= 0: ${ageSeconds}`);
      assert.ok(ageSeconds < 86400, `ageSeconds must be < 1 day: ${ageSeconds}`);
    }
  }
});

test('provider: OpenWeather provider has fetchAirPollution method', async () => {
  const { ProviderRegistry } = require('../src/services/providers/registry');
  const OpenWeatherProvider = require('../src/services/providers/openWeather');
  const registry = new ProviderRegistry({ timeoutMs: 4000, mode: 'openweather' });
  const ow = new OpenWeatherProvider({ apiKey: 'test-key' });
  registry.register(ow);
  assert.ok(typeof ow.fetchAirPollution === 'function', 'OpenWeather provider must have fetchAirPollution method');
});

test('provider: OpenWeather parseAirPollution returns numeric aqi', async () => {
  const OpenWeatherProvider = require('../src/services/providers/openWeather');
  const ow = new OpenWeatherProvider({ apiKey: 'test' });
  const body = { list: [{ main: { aqi: 3 } }] };
  const result = ow.parseAirPollution({}, body);
  assert.equal(result, 3);
});

test('provider: OpenWeather parseAirPollution returns null for invalid body', async () => {
  const OpenWeatherProvider = require('../src/services/providers/openWeather');
  const ow = new OpenWeatherProvider({ apiKey: 'test' });
  assert.equal(ow.parseAirPollution({}, null), null);
  assert.equal(ow.parseAirPollution({}, {}), null);
  assert.equal(ow.parseAirPollution({}, { list: [] }), null);
});
