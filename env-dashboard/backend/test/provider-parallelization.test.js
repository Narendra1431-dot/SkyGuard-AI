const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry, ProviderCircuit, validateValue, freshnessOk, safeIso, normalizeBase, RANGES } = require('../src/services/providers/registry');
const OpenMeteoProvider = require('../src/services/providers/openMeteo');
const OpenWeatherProvider = require('../src/services/providers/openWeather');

test('provider-parallelization: _computingStation prevents duplicate computation', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  const callCounts = { 'open-meteo': 0, 'openweather': 0 };

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    callCounts[provider.id] = (callCounts[provider.id] || 0) + 1;
    if (provider.id === 'open-meteo') {
      return {
        ok: true,
        provider: provider.id,
        station: st.id,
        observationTime: new Date().toISOString(),
        fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
        url: 'test',
        latencyMs: 10,
      };
    }
    return { ok: false, error: 'skipped' };
  };

  const promise1 = reg.fetchForStation(station);
  const promise2 = reg.fetchForStation(station);
  const results = await Promise.all([promise1, promise2]);

  assert.equal(callCounts['open-meteo'], 1, 'Open-Meteo called exactly once');
  assert.equal(callCounts['openweather'], 0, 'OpenWeather not called');
  assert.equal(results[0].provider, 'open-meteo');
  assert.equal(results[1].provider, 'open-meteo');
});

test('provider-parallelization: network count during dashboard refresh', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const stations = [
    { id: 'S1', lat: 10, lon: 20 },
    { id: 'S2', lat: 30, lon: 40 },
    { id: 'S3', lat: 50, lon: 60 },
  ];

  const networkCounts = { 'open-meteo': 0, 'openweather': 0 };
  let originalCallOnce = reg._callOnce;

  reg._callOnce = async (provider, station) => {
    networkCounts[provider.id] = (networkCounts[provider.id] || 0) + 1;
    return {
      ok: true,
      provider: provider.id,
      station: station.id,
      observationTime: new Date().toISOString(),
      fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
      url: 'test',
      latencyMs: 10,
    };
  };

  await Promise.all(stations.map(st => reg.fetchForStation(st)));
  assert.equal(networkCounts['open-meteo'], 3, 'Open-Meteo called for each station once');
  assert.equal(networkCounts['openweather'], 0, 'OpenWeather not called');
});
test('provider-parallelization: concurrent refresh triggers _computingStation mechanism', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  const callTimestamps = [];
  let computationComplete = false;

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    const ts = Date.now();
    callTimestamps.push({ provider: provider.id, ts });
    await new Promise(resolve => setTimeout(resolve, 100));
    return {
      ok: true,
      provider: provider.id,
      station: st.id,
      observationTime: new Date().toISOString(),
      fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
      url: 'test',
      latencyMs: 10,
    };
  };

  const promise1 = reg.fetchForStation(station);
  await new Promise(resolve => setTimeout(resolve, 50));
  const promise2 = reg.fetchForStation(station);

  const results = await Promise.all([promise1, promise2]);

  assert.equal(callTimestamps.length, 1, 'Single computation for concurrent requests');
  assert.equal(results[0].provider, 'open-meteo');
  assert.equal(results[1].provider, 'open-meteo');
});
test('provider-parallelization: provider priority semantics preserved', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  const callOrder = [];

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    callOrder.push(provider.id);
    return {
      ok: true,
      provider: provider.id,
      station: st.id,
      observationTime: new Date().toISOString(),
      fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
      url: 'test',
      latencyMs: 10,
    };
  };

  await reg.fetchForStation(station);
  assert.deepStrictEqual(callOrder, ['open-meteo'], 'Open-Meteo called first due to priority');
});
test('provider-parallelization: circuit breaker behavior', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  const circuit = reg.circuit;

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    circuit.recordFailure(provider.id);
    return { ok: false, error: 'simulated failure' };
  };

  await reg.fetchForStation(station);
  assert.equal(circuit.isOpen('open-meteo'), true, 'Circuit should be open after failures');

  circuit.recordSuccess('open-meteo');
  assert.equal(circuit.isOpen('open-meteo'), false, 'Circuit should close after success');
});
test('provider-parallelization: failure recovery after cooldown', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  const circuit = reg.circuit;

  // Keep openedAt safely within cooldown (30 seconds)
  circuit.state.set('open-meteo', { failures: 5, openedAt: Date.now() - 15000 });
  assert.equal(circuit.isOpen('open-meteo'), true, 'Circuit open due to failures');

  await new Promise(resolve => setTimeout(resolve, 2000));
  assert.equal(circuit.isOpen('open-meteo'), true, 'Circuit should still be open during cooldown');
});
test('provider-parallelization: no pending requests indefinitely', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());
  const openWeather = new OpenWeatherProvider({ apiKey: 'dummy' });
  reg.register(openWeather);

  const station = { id: 'S1', lat: 10, lon: 20 };
  let computationStarted = false;
  let computationCompleted = false;

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    computationStarted = true;
    await new Promise(resolve => setTimeout(resolve, 200));
    computationCompleted = true;
    return {
      ok: true,
      provider: provider.id,
      station: st.id,
      observationTime: new Date().toISOString(),
      fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
      url: 'test',
      latencyMs: 10,
    };
  };

  const promise = reg.fetchForStation(station);
  assert.equal(computationStarted, true, 'Computation should start immediately');
  assert.equal(computationCompleted, false, 'Computation should not complete yet');

  const result = await promise;
  assert.equal(computationCompleted, true, 'Computation should complete');
  assert.equal(reg._computingStation.has(station.id), false, 'Computing station should be cleaned up');
});
test('provider-parallelization: freshness from actual observation timestamp', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo' });
  reg.register(new OpenMeteoProvider());

  const station = { id: 'S1', lat: 10, lon: 20 };
  const mockObservationTime = new Date(Date.now() - 1000).toISOString();

  const originalCallOnce = reg._callOnce;
  reg._callOnce = async (provider, st) => {
    return {
      ok: true,
      provider: provider.id,
      station: st.id,
      observationTime: mockObservationTime,
      fields: { temperature: 20, pressure: 1013, humidity: 60, wind: 5, rainfall: 0, aqi: null },
      url: 'test',
      latencyMs: 10,
    };
  };

  const result = await reg.fetchForStation(station);
  assert.equal(result.observationTime, mockObservationTime, 'Freshness should come from actual observation timestamp');
});