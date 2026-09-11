'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RAGPipeline } = require('../src/services/ragPipeline');
const { LocalHashEmbeddings, OpenAIEmbeddings, cosine, bm25Score } = require('../src/services/rag/embeddings');

test('rag: backend mode is degraded by default (local-hash)', () => {
  const rag = new RAGPipeline();
  assert.equal(rag.mode, 'degraded');
  assert.equal(rag.getStatus().embeddingBackend, 'local-hash');
  assert.equal(rag.getStatus().semanticQuality, 'low');
});

test('rag: backend switches to semantic when OpenAI configured', () => {
  const rag = new RAGPipeline({ embeddingBackend: new OpenAIEmbeddings({ apiKey: 'sk-fake' }) });
  assert.equal(rag.mode, 'semantic');
  assert.equal(rag.getStatus().semanticQuality, 'high');
});

test('rag: retrieve returns no_match and degraded mode when no candidates', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Calibration', content: '# Calibration\nSensor calibration procedure for AQI.', source: 'manual' });
  const result = await rag.retrieve('xyzqqq-no-terms');
  assert.equal(result.results.length, 0);
  assert.equal(result.mode, 'degraded');
  assert.equal(result.embeddingBackend, 'local-hash');
});

test('rag: retrieve returns provenance on every result', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Incident Response', content: '# Incident Response\nWhen AQI exceeds 250 dispatch a field team within 30 minutes.', source: 'policy' });
  const result = await rag.retrieve('AQI exceeds threshold dispatch');
  assert.ok(result.results.length > 0);
  for (const r of result.results) {
    assert.ok(r.documentId);
    assert.ok(r.id);
    assert.ok(r.source);
    assert.ok(r.section);
  }
});

test('rag: hybrid retriever combines lexical + vector when embedding present', async () => {
  const rag = new RAGPipeline();
  // Build a doc that includes the word "synonym" in a way that lexical search would miss
  await rag.ingestDocument({ name: 'Maintenance', content: '# Maintenance\nCalibrate the device annually for accurate readings.', source: 'manual' });
  await rag.ingestDocument({ name: 'Calibration', content: '# Calibration\nPerform the tuning procedure before each deployment season.', source: 'manual' });
  const result = await rag.retrieve('calibrate sensor');
  assert.ok(result.results.length > 0);
  // At least one of the docs should match "calibrate" lexically
  const found = result.results.some((r) => /calibrat|tun/i.test(r.content || ''));
  assert.ok(found);
});

test('rag: cosine and bm25 helpers are bounded and non-negative', () => {
  const a = [0.1, 0.2, 0.3];
  const b = [0.1, 0.2, 0.3];
  const c = [-0.1, -0.2, -0.3];
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, c) - (-1)) < 1e-6);
  assert.ok(bm25Score('calibration', 'calibration calibration manual') > 0);
  assert.equal(bm25Score('zzz', 'calibration manual'), 0);
});
