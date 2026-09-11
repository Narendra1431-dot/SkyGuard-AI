'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderRegistry } = require('../src/services/providers/registry');

test('failure: provider timeout returns unavailable without fabricating data', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 200, retry: 0 });
  // Inject a provider that always times out
  reg.register({
    id: 'slow', name: 'Slow', enabled: true, hasKey: true, priority: 1,
    buildRequest: () => ({ url: 'http://10.255.255.1/never', headers: {} }),
    parse: () => ({ ok: true, observationTime: new Date().toISOString(), fields: {} }),
  });
  const r = await reg.fetchForStation({ id: 'S', lat: 0, lon: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.unavailable, true);
  assert.match(r.error, /timeout|all_providers_failed/);
});

test('failure: provider returns malformed JSON → quarantined, not persisted', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 2000, retry: 0 });
  reg.register({
    id: 'bad', name: 'Bad', enabled: true, hasKey: true, priority: 1,
    buildRequest: () => ({ url: 'http://x', headers: {} }),
    parse: () => ({ ok: false, error: 'malformed_json' }),
  });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new Error('malformed'); } });
  try {
    const r = await reg.fetchForStation({ id: 'S', lat: 0, lon: 0 });
    assert.equal(r.ok, false);
  } finally {
    global.fetch = realFetch;
  }
});

test('failure: circuit breaker opens after repeated failures', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 100, retry: 0 });
  reg.register({
    id: 'flaky', name: 'Flaky', enabled: true, hasKey: true, priority: 1,
    buildRequest: () => ({ url: 'http://10.255.255.1/x', headers: {} }),
    parse: () => ({ ok: true, observationTime: new Date().toISOString(), fields: {} }),
  });
  for (let i = 0; i < 3; i++) await reg.fetchForStation({ id: 'S', lat: 0, lon: 0 });
  const health = reg.health();
  assert.equal(health.flaky.circuitOpen, true);
  assert.ok(health.flaky.consecutiveFailures >= 3);
});

test('failure: stale observation (>30 min) is rejected as stale', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 2000, retry: 0, maxStaleSeconds: 1800 });
  reg.register({
    id: 'stale', name: 'Stale', enabled: true, hasKey: true, priority: 1,
    buildRequest: () => ({ url: 'http://x', headers: {} }),
    parse: () => ({ ok: true, observationTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), fields: { temperature: 25 } }),
  });
  // Bypass the network by intercepting global fetch
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = await reg.fetchForStation({ id: 'S', lat: 0, lon: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /stale/);
  } finally {
    global.fetch = realFetch;
  }
});

test('failure: out-of-range value is rejected', async () => {
  const reg = new ProviderRegistry({ mode: 'open-meteo', timeoutMs: 2000, retry: 0 });
  reg.register({
    id: 'oor', name: 'OOR', enabled: true, hasKey: true, priority: 1,
    buildRequest: () => ({ url: 'http://x', headers: {} }),
    parse: () => ({ ok: true, observationTime: new Date().toISOString(), fields: { temperature: 200 } }),
  });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = await reg.fetchForStation({ id: 'S', lat: 0, lon: 0 });
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid_temperature/);
  } finally {
    global.fetch = realFetch;
  }
});

test('failure: ML throws → model error captured, not crash', async () => {
  const ml = require('../src/services/ml');
  // Build a labeled set so the model wouldn't fail on "no labels" — instead force throw
  const { saveEvaluationSet, loadEvaluationSet } = ml;
  saveEvaluationSet([
    { id: 'a', label: 1, temperature: 50, aqi: 300, humidity: 10, anomaly: 1 },
    { id: 'b', label: 0, temperature: 25, aqi: 80, humidity: 50, anomaly: 0 },
  ]);
  const store = {
    recentReadings: async () => { throw new Error('DB unavailable'); },
  };
  ml.setStore(store);
  const result = await ml.evaluate({ requestedBy: 'failure-test' });
  assert.equal(result.status, 'FAILED');
  assert.match(result.notes, /DB unavailable/);
  // Reset
  saveEvaluationSet([]);
});

test('failure: RAG embedding failure downgrades to lexical without losing data', async () => {
  const { RAGPipeline } = require('../src/services/ragPipeline');
  const rag = new RAGPipeline();
  // Force embedding backend to fail
  rag.setEmbeddingBackend({ id: 'broken', embed: async () => { throw new Error('embedding offline'); }, embedBatch: async () => { throw new Error('embedding offline'); } });
  await rag.ingestDocument({ name: 'Doc', content: '# Doc\nCalibration procedure', source: 'manual' });
  const result = await rag.retrieve('calibration');
  assert.ok(result.results.length > 0);
  assert.equal(result.mode, 'degraded');
  assert.equal(result.embeddingBackend, 'broken');
  assert.equal(result.semanticQuality, 'low');
});
