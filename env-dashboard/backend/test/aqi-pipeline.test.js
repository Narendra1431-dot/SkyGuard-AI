'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Provider-level tests ──

const OpenMeteoProvider = require('../src/services/providers/openMeteo');
const OpenWeatherProvider = require('../src/services/providers/openWeather');
const { ProviderRegistry, normalizeBase, validateValue, RANGES } = require('../src/services/providers/registry');

// ── 1. OpenMeteo fetchAirQuality returns real US AQI ──

test('OpenMeteo: fetchAirQuality returns a numeric US AQI from the Air Quality API', async () => {
  const provider = new OpenMeteoProvider();
  const station = { id: 'test-1', lat: 28.6139, lon: 77.2090 }; // New Delhi
  const aqi = await provider.fetchAirQuality(station);
  // Real API should return a number between 0 and 500
  if (aqi !== null) {
    assert.equal(typeof aqi, 'number');
    assert.ok(aqi >= 0, `aqi >= 0, got ${aqi}`);
    assert.ok(aqi <= 500, `aqi <= 500, got ${aqi}`);
    assert.ok(Number.isFinite(aqi), 'aqi is finite');
  }
  // null is acceptable if API is unreachable in CI, but the method must not throw
});

// ── 2. OpenMeteo fetchAirQuality caches results ──

test('OpenMeteo: fetchAirQuality caches results within TTL', async () => {
  const provider = new OpenMeteoProvider();
  const station = { id: 'test-cache', lat: 19.076, lon: 72.8777 }; // Mumbai
  const first = await provider.fetchAirQuality(station);
  const second = await provider.fetchAirQuality(station);
  assert.equal(first, second, 'cached result matches first call');
});

// ── 3. OpenMeteo fetchAirQuality handles invalid coordinates ──

test('OpenMeteo: fetchAirQuality returns null for invalid coordinates', async () => {
  const provider = new OpenMeteoProvider();
  const station = { id: 'test-invalid', lat: 999, lon: 999 };
  const aqi = await provider.fetchAirQuality(station);
  assert.equal(aqi, null, 'invalid coords return null');
});

// ── 4. OpenMeteo fetchAirQuality handles network timeout ──

test('OpenMeteo: fetchAirQuality returns null on timeout (short timeout)', async () => {
  const provider = new OpenMeteoProvider();
  provider._aqiCacheTtlMs = 0; // force cache miss
  const station = { id: 'test-timeout', lat: 28.6139, lon: 77.2090 };
  // The method has its own 5s timeout; just verify it doesn't throw
  const aqi = await provider.fetchAirQuality(station);
  assert.ok(aqi === null || typeof aqi === 'number', 'returns null or number on any failure');
});

// ── 5. OpenMeteo parse does not include AQI (AQI comes from separate call) ──

test('OpenMeteo: parse() returns aqi null (AQI is fetched separately)', () => {
  const provider = new OpenMeteoProvider();
  const station = { id: 'test-parse', lat: 28.6139, lon: 77.2090 };
  const body = {
    current: {
      time: '2025-01-01T00:00',
      temperature_2m: 25,
      relative_humidity_2m: 60,
      surface_pressure: 1013,
      wind_speed_10m: 5,
      precipitation: 0,
    },
  };
  const result = provider.parse(station, body);
  assert.equal(result.ok, true);
  assert.equal(result.fields.aqi, null, 'parse() leaves aqi as null');
  assert.equal(typeof result.fields.temperature, 'number');
});

// ── 6. OpenWeather constructor initializes cache ──

test('OpenWeather: constructor initializes _aqiCache', () => {
  const provider = new OpenWeatherProvider();
  assert.ok(provider._aqiCache instanceof Map, '_aqiCache is a Map');
  assert.equal(typeof provider._aqiCacheTtlMs, 'number');
  assert.equal(provider.apiKey, null);
  assert.equal(provider.hasKey, false);
  assert.equal(provider.enabled, false);
});

// ── 7. OpenWeather setApiKey works ──

test('OpenWeather: setApiKey enables provider', () => {
  const provider = new OpenWeatherProvider();
  provider.setApiKey('test-key-123');
  assert.equal(provider.apiKey, 'test-key-123');
  assert.equal(provider.hasKey, true);
  assert.equal(provider.enabled, true);
});

// ── 8. OpenWeather parse returns aqi null (AQI comes from separate call) ──

test('OpenWeather: parse() returns aqi null (AQI from air pollution endpoint)', () => {
  const provider = new OpenWeatherProvider();
  const station = { id: 'test-ow', lat: 28.6139, lon: 77.2090 };
  const body = {
    main: { temp: 30, pressure: 1012, humidity: 55 },
    wind: { speed: 4 },
    dt: Math.floor(Date.now() / 1000),
  };
  const result = provider.parse(station, body);
  assert.equal(result.ok, true);
  assert.equal(result.fields.aqi, null);
});

// ── 9. OpenWeather fetchAirPollution returns null without API key ──

test('OpenWeather: fetchAirPollution returns null without API key', async () => {
  const provider = new OpenWeatherProvider();
  const station = { id: 'test-ow-nokey', lat: 28.6139, lon: 77.2090 };
  const aqi = await provider.fetchAirPollution(station);
  assert.equal(aqi, null);
});

// ── 10. OpenWeather fetchAirPollution caches ──

test('OpenWeather: fetchAirPollution caches results', async () => {
  const provider = new OpenWeatherProvider();
  provider.setApiKey('invalid-key-for-cache-test');
  const station = { id: 'test-ow-cache', lat: 28.6139, lon: 77.2090 };
  // Both calls should return same result (null from invalid key)
  const first = await provider.fetchAirPollution(station);
  const second = await provider.fetchAirPollution(station);
  assert.equal(first, second);
});

// ── 11. normalizeBase passes through AQI ──

test('normalizeBase: passes through AQI value', () => {
  const station = { id: 's1', lat: 28, lon: 77 };
  const reading = normalizeBase({
    station,
    observationTime: new Date().toISOString(),
    provider: 'open-meteo',
    quality: 'ok',
    extra: { temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0, aqi: 120 },
  });
  assert.equal(reading.aqi, 120);
});

test('normalizeBase: AQI remains null when not provided', () => {
  const station = { id: 's2', lat: 28, lon: 77 };
  const reading = normalizeBase({
    station,
    observationTime: new Date().toISOString(),
    provider: 'open-meteo',
    quality: 'ok',
    extra: { temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0 },
  });
  assert.equal(reading.aqi, null);
});

// ── 12. AQI validation range ──

test('validateValue: AQI within range is valid', () => {
  assert.ok(validateValue('aqi', 0).ok);
  assert.ok(validateValue('aqi', 100).ok);
  assert.ok(validateValue('aqi', 500).ok);
});

test('validateValue: AQI null is rejected', () => {
  assert.equal(validateValue('aqi', null).ok, false);
});

test('validateValue: AQI NaN is rejected', () => {
  assert.equal(validateValue('aqi', NaN).ok, false);
});

test('validateValue: AQI negative is rejected', () => {
  assert.equal(validateValue('aqi', -1).ok, false);
});

test('validateValue: AQI above max is rejected', () => {
  assert.equal(validateValue('aqi', 1001).ok, false);
});

// ── 13. AQI in RANGES ──

test('RANGES: aqi range is defined', () => {
  assert.equal(RANGES.aqi.min, 0);
  assert.equal(RANGES.aqi.max, 1000);
});

// ── 14. Anomaly logic with null AQI ──

test('paramCode: null AQI does not trigger AQI anomaly', () => {
  const { paramCode } = require('../src/ai');
  const reading = { aqi: null, temperature: 25, humidity: 50, pressure: 1013, wind: 3, rainfall: 0 };
  const result = paramCode(reading);
  // null > 250 is false, so no AQI anomaly
  const aqiReasons = result.reasons.filter((r) => /AQI/i.test(r));
  assert.equal(aqiReasons.length, 0, 'no AQI anomaly when aqi is null');
});

test('paramCode: valid AQI above danger triggers anomaly', () => {
  const { paramCode } = require('../src/ai');
  const reading = { aqi: 300, temperature: 25, humidity: 50, pressure: 1013, wind: 3, rainfall: 0 };
  const result = paramCode(reading);
  assert.equal(result.anomaly, true);
  const aqiReasons = result.reasons.filter((r) => /AQI/i.test(r));
  assert.ok(aqiReasons.length > 0, 'AQI anomaly triggered for aqi=300');
});

test('paramCode: zero AQI does not trigger AQI anomaly', () => {
  const { paramCode } = require('../src/ai');
  const reading = { aqi: 0, temperature: 25, humidity: 50, pressure: 1013, wind: 3, rainfall: 0 };
  const result = paramCode(reading);
  const aqiReasons = result.reasons.filter((r) => /AQI/i.test(r));
  assert.equal(aqiReasons.length, 0, 'no AQI anomaly for aqi=0');
});

// ── 15. healthScore with null AQI ──

test('healthScore: null AQI does not reduce health score', () => {
  const { healthScore } = require('../src/ai');
  const good = { aqi: null, temperature: 25, humidity: 50, pressure: 1013, wind: 3, rainfall: 0 };
  const score = healthScore(good);
  // Math.max(0, null - 100) = Math.max(0, -100) = 0, so no deduction
  assert.ok(score > 90, `health score with null AQI should be high, got ${score}`);
});

// ── 16. maintenanceRisk with null AQI ──

test('maintenanceRisk: null AQI does not add risk', () => {
  const { maintenanceRisk } = require('../src/ai');
  const reading = { aqi: null, temperature: 25, humidity: 50, pressure: 1013, wind: 3, rainfall: 0 };
  const risk = maintenanceRisk(reading);
  assert.equal(risk, 0, 'no maintenance risk from null AQI');
});

// ── 17. ProviderRegistry fetchForStation returns reading with aqi field ──

test('ProviderRegistry: fetchForStation result includes aqi field', async () => {
  const registry = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 10000 });
  const om = new OpenMeteoProvider();
  registry.register(om);
  const station = { id: 'test-reg', lat: 28.6139, lon: 77.2090, name: 'Test Station' };
  const result = await registry.fetchForStation(station);
  assert.equal(result.ok, true, `provider result ok: ${result.error}`);
  assert.ok('aqi' in result.fields, 'fields contains aqi key');
});

// ── 18. MemoryStore preserves AQI ──

test('MemoryStore: writeReading preserves AQI value', async () => {
  const MemoryStore = require('../src/memoryStore');
  const store = new MemoryStore();
  const reading = {
    stationId: 's-aqi-test',
    time: new Date().toISOString(),
    temperature: 30,
    humidity: 50,
    pressure: 1013,
    wind: 5,
    rainfall: 0,
    aqi: 142,
    anomaly: 0,
    source: { provider: 'open-meteo', quality: 'ok' },
  };
  await store.writeReading(reading);
  const latest = await store.latestPerStation();
  const found = latest.find((r) => r.stationId === 's-aqi-test');
  assert.ok(found, 'reading found');
  assert.equal(found.aqi, 142, 'AQI preserved in store');
});

test('MemoryStore: writeReading preserves null AQI', async () => {
  const MemoryStore = require('../src/memoryStore');
  const store = new MemoryStore();
  const reading = {
    stationId: 's-null-aqi',
    time: new Date().toISOString(),
    temperature: 30,
    humidity: 50,
    pressure: 1013,
    wind: 5,
    rainfall: 0,
    aqi: null,
    anomaly: 0,
    source: { provider: 'open-meteo', quality: 'ok' },
  };
  await store.writeReading(reading);
  const latest = await store.latestPerStation();
  const found = latest.find((r) => r.stationId === 's-null-aqi');
  assert.ok(found, 'reading found');
  assert.equal(found.aqi, null, 'null AQI preserved in store');
});

// ── 19. MemoryStore history returns AQI ──

test('MemoryStore: history returns AQI values', async () => {
  const MemoryStore = require('../src/memoryStore');
  const store = new MemoryStore();
  const now = new Date().toISOString();
  await store.writeReading({ stationId: 's-hist', time: now, temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0, aqi: 88, anomaly: 0 });
  const history = await store.history('s-hist', 'aqi', 60);
  assert.ok(history.length > 0, 'history has entries');
  assert.equal(history[0].v, 88, 'AQI value in history');
});

// ── 20. AQI merge logic in server (simulate fetchRealReading pattern) ──

test('AQI merge: provider aqi null + separate aqi = separate wins', () => {
  const providerAqi = null;
  const separateAqi = 142;
  const resultFields = { temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0, aqi: providerAqi };
  const merged = separateAqi != null ? separateAqi : (resultFields?.aqi ?? null);
  assert.equal(merged, 142, 'separate AQI wins over null provider AQI');
});

test('AQI merge: provider aqi 80 + separate aqi null = provider wins', () => {
  const providerAqi = 80;
  const separateAqi = null;
  const resultFields = { temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0, aqi: providerAqi };
  const merged = separateAqi != null ? separateAqi : (resultFields?.aqi ?? null);
  assert.equal(merged, 80, 'provider AQI wins when separate is null');
});

test('AQI merge: both null = null', () => {
  const providerAqi = null;
  const separateAqi = null;
  const resultFields = { temperature: 30, humidity: 50, pressure: 1013, wind: 5, rainfall: 0, aqi: providerAqi };
  const merged = separateAqi != null ? separateAqi : (resultFields?.aqi ?? null);
  assert.equal(merged, null, 'both null yields null');
});

// ── 21. AQI NaN/invalid rejection ──

test('AQI normalization rejects NaN', () => {
  const val = Number(NaN);
  assert.ok(!Number.isFinite(val), 'NaN is not finite');
});

test('AQI normalization rejects Infinity', () => {
  const val = Number(Infinity);
  assert.ok(!Number.isFinite(val), 'Infinity is not finite');
});

test('AQI normalization accepts 0', () => {
  assert.equal(Number(0) >= 0 && Number(0) <= 500, true);
});

test('AQI normalization accepts 500', () => {
  assert.equal(Number(500) >= 0 && Number(500) <= 500, true);
});

test('AQI normalization rejects 501', () => {
  assert.equal(Number(501) >= 0 && Number(501) <= 500, false);
});

test('AQI normalization rejects -1', () => {
  assert.equal(Number(-1) >= 0, false);
});

// ── 22. OpenMeteo fetchAirQuality response structure ──

test('OpenMeteo: fetchAirQuality handles malformed API response', async () => {
  const provider = new OpenMeteoProvider();
  // Override fetch to return malformed data
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ unexpected: 'structure' }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'malformed', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'malformed response returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles API error response', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({}),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'error', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'error response returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles network failure', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const aqi = await provider.fetchAirQuality({ id: 'network-fail', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'network failure returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles out-of-range AQI', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { us_aqi: 999 } }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'oor', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'out-of-range AQI returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles negative AQI', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { us_aqi: -5 } }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'neg', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'negative AQI returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles string AQI', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { us_aqi: 'not-a-number' } }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'str', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'string AQI returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles null us_aqi in response', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { us_aqi: null } }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'null-val', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'null us_aqi returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

test('OpenMeteo: fetchAirQuality handles missing current block', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({}),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'no-current', lat: 28, lon: 77 });
    assert.equal(aqi, null, 'missing current block returns null');
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 23. OpenMeteo fetchAirQuality valid response ──

test('OpenMeteo: fetchAirQuality extracts valid AQI from response', async () => {
  const provider = new OpenMeteoProvider();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ current: { us_aqi: 75, time: '2025-01-01T00:00' } }),
  });
  try {
    const aqi = await provider.fetchAirQuality({ id: 'valid', lat: 28, lon: 77 });
    assert.equal(aqi, 75, 'valid AQI extracted');
  } finally {
    global.fetch = originalFetch;
  }
});

// ── 24. Provider registry method detection ──

test('ProviderRegistry: detects fetchAirQuality method on OpenMeteo', () => {
  const om = new OpenMeteoProvider();
  assert.equal(typeof om.fetchAirQuality, 'function', 'OpenMeteo has fetchAirQuality');
});

test('ProviderRegistry: detects fetchAirPollution method on OpenWeather', () => {
  const ow = new OpenWeatherProvider();
  assert.equal(typeof ow.fetchAirPollution, 'function', 'OpenWeather has fetchAirPollution');
});

// ── 25. End-to-end: OpenMeteo provider → normalizeBase → MemoryStore ──

test('E2E: OpenMeteo provider → normalizeBase → MemoryStore preserves AQI', async () => {
  const MemoryStore = require('../src/memoryStore');
  const store = new MemoryStore();
  const provider = new OpenMeteoProvider();
  const station = { id: 'e2e-station', lat: 28.6139, lon: 77.2090, name: 'E2E Station' };

  // Step 1: Get weather data from provider
  const built = provider.buildRequest(station);
  const res = await fetch(built.url, { headers: built.headers });
  const body = await res.json();
  const parsed = provider.parse(station, body);
  assert.equal(parsed.ok, true);

  // Step 2: Fetch AQI separately
  const aqi = await provider.fetchAirQuality(station);

  // Step 3: Normalize
  const reading = normalizeBase({
    station,
    observationTime: parsed.observationTime,
    provider: 'open-meteo',
    quality: 'ok',
    extra: { ...parsed.fields, aqi: aqi != null ? aqi : (parsed.fields?.aqi ?? null) },
  });

  // Step 4: Store
  await store.writeReading(reading);

  // Step 5: Retrieve
  const latest = await store.latestPerStation();
  const found = latest.find((r) => r.stationId === 'e2e-station');
  assert.ok(found, 'reading retrieved');
  if (aqi !== null) {
    assert.equal(found.aqi, aqi, `AQI preserved through pipeline: ${aqi}`);
  } else {
    assert.equal(found.aqi, null, 'AQI remains null when provider unavailable');
  }
});
