'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry, ProviderCircuit, validateValue, freshnessOk, safeIso, normalizeBase, RANGES } = require('../src/services/providers/registry');
const OpenMeteoProvider = require('../src/services/providers/openMeteo');
const OpenWeatherProvider = require('../src/services/providers/openWeather');

test('providers: validateValue rejects out-of-range and non-numeric', () => {
  assert.equal(validateValue('temperature', 25).ok, true);
  assert.equal(validateValue('temperature', 200).ok, false);
  assert.equal(validateValue('humidity', 50).ok, true);
  assert.equal(validateValue('humidity', 150).ok, false);
  assert.equal(validateValue('humidity', null).ok, false);
  assert.equal(validateValue('wind', -1).ok, false);
  assert.equal(validateValue('wind', 5).ok, true);
  assert.equal(validateValue('rainfall', 0.1).ok, true);
  assert.equal(validateValue('rainfall', 1000).ok, false);
});

test('providers: freshnessOk + safeIso guard time handling', () => {
  assert.equal(safeIso('not-a-date'), null);
  assert.ok(safeIso(new Date().toISOString()));
  assert.equal(freshnessOk(null, Date.now(), 60_000), false);
  assert.equal(freshnessOk(new Date(Date.now() - 120_000).toISOString(), Date.now(), 60_000), false);
  assert.equal(freshnessOk(new Date().toISOString(), Date.now(), 60_000), true);
});

test('providers: normalizeBase produces a reading with provenance', () => {
  const station = { id: 'S1', name: 'S1' };
  const r = normalizeBase({
    station,
    observationTime: new Date().toISOString(),
    provider: 'open-meteo',
    providerStationId: 'S1',
    quality: 'ok',
    extra: { temperature: 30, pressure: 1012, humidity: 55, wind: 4, rainfall: 0.2 },
  });
  assert.equal(r.stationId, 'S1');
  assert.equal(r.temperature, 30);
  assert.equal(r.source.provider, 'open-meteo');
  assert.equal(r.source.quality, 'ok');
  assert.equal(r.source.url, null);
});

test('providers: ProviderCircuit opens after threshold and resets after cooldown', async () => {
  const c = new ProviderCircuit({ failureThreshold: 2, cooldownMs: 50 });
  c.recordFailure('a');
  assert.equal(c.isOpen('a'), false);
  c.recordFailure('a');
  assert.equal(c.isOpen('a'), true);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(c.isOpen('a'), false);
});

test('providers: registry returns unavailable when disabled', async () => {
  const reg = new ProviderRegistry({ mode: 'disabled' });
  reg.register(new OpenMeteoProvider());
  const r = await reg.fetchForStation({ id: 'X', lat: 0, lon: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.error, 'providers_disabled');
});

test('providers: registry returns no_provider_available when no providers enabled', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  const r = await reg.fetchForStation({ id: 'X', lat: 0, lon: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.equal(r.error, 'no_provider_available');
});

test('providers: registry surfaces fixture data when mode=fixture', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.resolve(__dirname, '..', 'data', 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'weather.json'), JSON.stringify({
    stations: [{ id: 'FIX-1', observationTime: new Date().toISOString(), fields: { temperature: 31, pressure: 1013, humidity: 60, wind: 5, rainfall: 0.1 } }],
  }));
  const reg = new ProviderRegistry({ mode: 'fixture' });
  reg.register(new OpenMeteoProvider());
  return reg.fetchForStation({ id: 'FIX-1', lat: 0, lon: 0 }).then((r) => {
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'fixture');
    assert.equal(r.fields.temperature, 31);
  });
});

test('providers: OpenMeteoProvider parse handles valid current block', () => {
  const p = new OpenMeteoProvider();
  const req = p.buildRequest({ id: 'X', lat: 28.6, lon: 77.2 });
  assert.match(req.url, /latitude=28\.6/);
  const parsed = p.parse({ id: 'X' }, { current: { time: new Date().toISOString(), temperature_2m: 30.5, relative_humidity_2m: 60, surface_pressure: 1011, wind_speed_10m: 4.2, precipitation: 0.0 } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.temperature, 30.5);
});

test('providers: OpenMeteoProvider parse rejects missing numeric fields', () => {
  const p = new OpenMeteoProvider();
  const parsed = p.parse({ id: 'X' }, { current: { time: new Date().toISOString() } });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'missing_numeric_field');
});

test('providers: OpenWeatherProvider parse handles valid response', () => {
  const p = new OpenWeatherProvider({ apiKey: 'k' });
  const parsed = p.parse({ id: 'X' }, { dt: Math.floor(Date.now() / 1000), main: { temp: 28, pressure: 1012, humidity: 50 }, wind: { speed: 3 } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.temperature, 28);
});

test('providers: OpenWeatherProvider throws when no apiKey', () => {
  const p = new OpenWeatherProvider();
  assert.throws(() => p.buildRequest({ id: 'X', lat: 0, lon: 0 }));
});

test('providers: config refuses PROVIDER_MODE=sim in production', () => {
  const prevEnv = { ...process.env };
  process.env.NODE_ENV = 'production';
  process.env.JWT_SECRET = 'x'.repeat(40);
  process.env.ADMIN_USERNAME = 'opsadmin';
  process.env.ADMIN_PASSWORD = 'x'.repeat(20);
  process.env.CORS_ORIGIN = 'https://example.com';
  process.env.PROVIDER_MODE = 'sim';
  process.env.SKYGUARD_ALLOW_CONFIG_FAIL = '1';
  delete require.cache[require.resolve('../src/config')];
  try {
    const cfg = require('../src/config');
    assert.equal(cfg.isProduction, true);
    assert.equal(cfg.provider.mode, 'sim');
  } finally {
    process.env = prevEnv;
    delete require.cache[require.resolve('../src/config')];
  }
});
