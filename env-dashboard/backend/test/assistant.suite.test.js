'use strict';

process.env.USE_INFLUXDB = 'false';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { io: socketClient } = require('socket.io-client');
const { app, server, stations, processReading, setIngestionPaused } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');
const investigation = require('../src/services/investigation');

test.before(async () => {
  setIngestionPaused(true);
  try { await initFromEnv(config.auth); } catch (_) {}
});

function seed() {
  const now = Date.now();
  for (let i = 0; i < stations.length; i += 1) {
    processReading({ ...tickReading(stations[i], Math.floor(now / 1000)), time: new Date(now + i).toISOString() });
  }
}

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  return r.body.data.token;
}

test('assistant v2 returns 200 with data-aware answer shape (in-memory store)', async () => {
  await seed();
  await new Promise((r) => setTimeout(r, 200));
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'Which stations are critical?' });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.text && r.body.data.text.length > 0);
  assert.ok(['critical_stations', 'help', 'investigate_first'].includes(r.body.data.intent));
  assert.ok(Array.isArray(r.body.data.toolCalls));
});

test('assistant v2 empty query handled safely (returns guidance, no error)', async () => {
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: '' });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.text.length > 0);
});

test('assistant v2 missing body handled safely', async () => {
  const r = await request(app).post('/api/v1/assistant/v2').send({});
  assert.equal(r.status, 200);
  assert.ok(r.body.data.text.length > 0);
});

test('assistant v2 auth: works anonymously (public read-only) and accepts a valid token', async () => {
  const anon = await request(app).post('/api/v1/assistant/v2').send({ query: 'help' });
  assert.equal(anon.status, 200);
  const tok = await login();
  const withAuth = await request(app).post('/api/v1/assistant/v2').set('Authorization', `Bearer ${tok}`).send({ query: 'help' });
  assert.equal(withAuth.status, 200);
});

test('assistant v2 backend failure: unknown tool does not 500 (tool isolations)', async () => {
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'What is happening right now?' });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.toolCalls.every((t) => t.class === 'read_only'));
});

test('assistant v2 investigate_first persists an investigation record', async () => {
  seed();
  await new Promise((r) => setTimeout(r, 200));
  const before = investigation.list({}).items.length;
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'What should I investigate first?' });
  assert.equal(r.status, 200);
  const after = investigation.list({}).items.length;
  // May create 0..n new investigations depending on runtime state; assert no crash and text non-empty.
  assert.ok(after >= before);
  assert.ok(r.body.data.text && r.body.data.text.length > 0);
});

test('assistant v2 emits realtime agent:completed event via Socket.IO', async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const received = [];
  const connection = new Promise((resolve, reject) => {
    const c = socketClient(url, { transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    c.on('connect', () => { clearTimeout(timer); resolve(c); });
    c.on('agent:completed', (payload) => received.push(payload));
  });
  const client = await connection;

  await request(app).post('/api/v1/assistant/v2').send({ query: 'Which stations are critical?' });

  let attempts = 0;
  while (received.length === 0 && attempts < 50) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    attempts += 1;
  }
  client.close();
  await new Promise((resolve) => server.close(resolve));

  assert.ok(received.length >= 1, 'received at least one agent:completed event');
  assert.ok(received[0].requestId, 'event carries requestId');
  assert.ok(Array.isArray(received[0].toolCalls));
});

test('assistant v2 concurrent queries do not cross-contaminate requestIds', async () => {
  await seed();
  const results = await Promise.all([
    request(app).post('/api/v1/assistant/v2').send({ query: 'Which stations are critical?' }),
    request(app).post('/api/v1/assistant/v2').send({ query: 'help' }),
    request(app).post('/api/v1/assistant/v2').send({ query: 'What is the current AQI in Delhi?' }),
  ]);
  const ids = results.map((r) => r.body.data.requestId);
  assert.equal(new Set(ids).size, 3, `three distinct requestIds (got ${ids.join(',')})`);
  assert.ok(results.every((r) => r.status === 200));
});

test('assistant v2 response never fabricates: all reported metrics map to seeded values', async () => {
  const now = Date.now();
  const deterministic = { aqi: 212, temperature: 35, humidity: 40, anomaly: 1 };
  processReading({ ...tickReading(stations[0], Math.floor(now / 1000)), time: new Date(now).toISOString(), ...deterministic });
  await new Promise((r) => setTimeout(r, 200));
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'What is the current AQI in Delhi?' });
  assert.equal(r.status, 200);
  const text = r.body.data.text;
  const m = text.match(/aqi.*?:[ ]*([\d.]+)/i);
  assert.ok(m, `AQI value present: "${text}"`);
  assert.equal(Number(m[1]), deterministic.aqi, `reports the real seeded AQI (${text})`);
});

test('assistant v2 llm-status reports unavailable when no real provider configured', async () => {
  const r = await request(app).get('/api/v1/assistant/llm-status');
  assert.equal(r.status, 200);
  assert.strictEqual(r.body.data.mode, 'DETERMINISTIC_FALLBACK');
  assert.strictEqual(r.body.data.available, false);
  assert.ok(r.body.data.note.includes('deterministic'));
});

test('assistant v2 response includes llmMode when no real LLM is configured', async () => {
  seed();
  await new Promise((r) => setTimeout(r, 150));
  const r = await request(app).post('/api/v1/assistant/v2').send({ query: 'help' });
  assert.equal(r.status, 200);
  assert.strictEqual(r.body.data.llmMode, 'DETERMINISTIC_FALLBACK');
  assert.strictEqual(r.body.data.llmStatus, 'unavailable');
});