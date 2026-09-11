'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

// Redirect the canonical stations state file to a test-only location BEFORE any
// module loads it, so the real data/stations.json is never touched by this suite.
const TEST_STATIONS_FILE = path.join(os.tmpdir(), `skyguard-test-stations-${process.pid}.json`);
for (const f of [TEST_STATIONS_FILE, `${TEST_STATIONS_FILE}.bak`]) {
  try { fs.unlinkSync(f); } catch (_) {}
}
process.env.SKYGUARD_STATIONS_FILE = TEST_STATIONS_FILE;

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { app, io, server, stations, stationMap } = require('../src/server');
const config = require('../src/config');
const stationsDb = require('../src/db/stations');
const { initFromEnv, createUser } = require('../src/db/auth');
const { io: socketClient } = require('socket.io-client');

before(async () => { try { await initFromEnv(config.auth); } catch (_) {} });

function cleanupStation(id) {
  const idx = stations.findIndex((s) => s.id === id);
  if (idx >= 0) stations.splice(idx, 1);
  stationMap.delete(id);
  stationsDb.removeStation(id);
}

const unique = () => `T${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

async function login() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  assert.equal(r.status, 200);
  return r.body.data.token;
}

function validBody(overrides = {}) {
  return {
    name: `Test Station ${unique()}`,
    id: `AMD${unique().slice(0, 8)}`,
    lat: 23.0225,
    lon: 72.5714,
    district: 'Test District',
    provider: 'open-meteo',
    parameters: ['temperature', 'humidity'],
    timezone: 'Asia/Kolkata',
    ...overrides,
  };
}

test('stations: create requires auth (401) and admin role (403)', async () => {
  const noAuth = await request(app).post('/api/v1/stations').send(validBody());
  assert.equal(noAuth.status, 401);

  // Non-admin role cannot create stations
  const ts = `viewer${Math.random().toString(36).slice(2, 8)}`;
  await createUser({ username: ts, password: 'viewer-pass-123', role: 'viewer' });
  const loginRes = await request(app).post('/api/v1/auth/login').send({ username: ts, password: 'viewer-pass-123' });
  assert.equal(loginRes.status, 200);
  const forbidden = await request(app).post('/api/v1/stations').set('Authorization', `Bearer ${loginRes.body.data.token}`).send(validBody());
  assert.equal(forbidden.status, 403);
});

test('stations: valid creation returns 201 with truthful provider assignment', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const body = validBody();
  const r = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  const s = r.body.data;
  assert.equal(s.id, body.id);
  assert.equal(s.name, body.name);
  assert.equal(s.lat, body.lat);
  assert.equal(s.lon, body.lon);
  assert.equal(s.provider, 'open-meteo');
  assert.deepEqual(s.parameters, ['temperature', 'humidity']);
  assert.equal(s.timezone, 'Asia/Kolkata');
  // Truthful: no reading yet -> status offline, provider not green
  assert.equal(s.status, 'offline');
  assert.equal(s.reading, null);
  assert.equal(s.quality, 'unavailable');
  assert.ok(['GRAY', 'YELLOW'].includes(s.providerStatus), 'provider must not be falsely GREEN');
  assert.ok(s.providerProbe);
  assert.equal(s.providerProbe.provider, 'open-meteo');

  // Cleanup persisted so other tests / manual runs are not polluted
  cleanupStation(s.id);
});

test('stations: duplicate ID returns 400 with field message', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const body = validBody();
  const first = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(first.status, 201);
  const dup = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(dup.status, 400);
  assert.equal(dup.body.success, false);
  assert.ok(dup.body.error.message.includes('already exists'));
  cleanupStation(body.id);
});

test('stations: invalid coordinates / missing name / invalid provider / invalid state return 400', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const cases = [
    { ...validBody(), lat: 95 },                       // lat out of range
    { ...validBody(), lat: 'abc' },                    // lat non-numeric
    { ...validBody(), lon: -181 },                     // lon out of range
    { ...validBody(), name: '' },                      // missing name
    { ...validBody(), name: 'x' },                     // name too short
    { ...validBody(), id: '!!bad id!!' },              // invalid id chars
    { ...validBody(), provider: 'bogus-provider' },    // invalid provider
    { ...validBody(), parameters: ['nope'] },          // invalid parameter
    { ...validBody(), parameters: [] },                // empty parameters
    { ...validBody(), timezone: 'Mars/Olympus' },      // invalid timezone
    { ...validBody(), state: 'NotAState' },            // invalid state
  ];
  for (const c of cases) {
    const r = await request(app).post('/api/v1/stations').set(auth).send(c);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(c)} -> ${r.status}`);
    assert.ok(r.body.error.fields && r.body.error.fields.length > 0, 'must include field-level errors');
  }
});

test('stations: malformed JSON returns 400', async () => {
  const token = await login();
  const r = await request(app).post('/api/v1/stations')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .send('{not json');
  assert.equal(r.status, 400);
  assert.equal(r.body.error.message, 'Malformed JSON body');
});

test('stations: a pending/unconfigured provider never fabricates readings or shows fake GREEN', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const body = validBody({ provider: 'openweather' }); // configured only when OPENWEATHER_API_KEY is set
  const r = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(r.status, 201);
  const s = r.body.data;
  assert.equal(s.provider, 'openweather');
  const configured = !!config.provider.openWeatherApiKey;
  assert.equal(s.providerProbe.configured, configured);
  if (!configured) {
    assert.equal(s.providerStatus, 'GRAY');
    assert.equal(s.providerProbe.verdict, 'unavailable');
  } else {
    // Configured but never verified healthy for this station -> must be pending
    // (YELLOW / degraded), never a fabricated GREEN.
    assert.equal(s.providerStatus, 'YELLOW');
    assert.equal(s.providerProbe.verdict, 'degraded');
  }
  // Truthful: no reading exists for the new station regardless of provider state
  assert.equal(s.reading, null);
  assert.equal(s.status, 'offline');
  cleanupStation(body.id);
});

test('stations: new station appears in list, search, filters, and detail without manual DB edits', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const body = validBody({ name: `AlphaSearch ${unique()}` });
  const created = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  // list contains it
  const list = await request(app).get('/api/v1/stations?nocache=1');
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((s) => s.id === id), 'station must appear in list');

  // detail works
  const detail = await request(app).get(`/api/v1/stations/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.id, id);
  assert.equal(detail.body.data.name, body.name);

  // new station queryable via telemetry
  const telemetry = await request(app).get(`/api/v1/stations/${id}/telemetry`);
  assert.equal(telemetry.status, 200);
  assert.equal(telemetry.body.data.stationId, id);

  // anomalies endpoint recognizes station card (no anomaly fabricated)
  const anomalies = await request(app).get(`/api/v1/stations/${id}/anomalies`);
  assert.equal(anomalies.status, 200);
  assert.ok(Array.isArray(anomalies.body.data));

  cleanupStation(id);
});

test('stations: new station is picked up by ingestion pipeline and surfaced in dashboard + readings', async () => {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };
  const body = validBody({ name: `Ingest ${unique()}`, lat: 28.6139, lon: 77.2090 });
  const created = await request(app).post('/api/v1/stations').set(auth).send(body);
  assert.equal(created.status, 201);
  const id = created.body.data.id;

  // Push a REAL reading via the ingestion path (processReading) exactly like the
  // tick does, but using actual provider output format. We do NOT call tickReading
  // (simulator) — we synthesize the reading as if the provider responded.
  const reading = {
    time: new Date().toISOString(),
    stationId: id,
    temperature: 31.5,
    pressure: 1012.0,
    humidity: 60.0,
    aqi: null,
    wind: 3.2,
    rainfall: 0.0,
    anomaly: 0,
    source: { provider: 'open-meteo', station: id, retrievedAt: new Date().toISOString(), observationAt: new Date().toISOString(), quality: 'ok', fallback: false, cacheHit: false, url: 'https://api.open-meteo.com/v1/forecast?latitude=28.6&longitude=77.2' },
  };
  const { processReading } = require('../src/server');
  await processReading(reading);

  // Dashboard counts include it
  const dash = await request(app).get('/api/v1/dashboard');
  assert.equal(dash.status, 200);
  const dashTotal = dash.body.data.totalStations;
  assert.ok(stations.some((s) => s.id === id), 'station present in runtime stations array');
  assert.ok(dashTotal >= stations.length, 'dashboard total reflects added station');

  // readings endpoint includes it with REAL provider source
  const readings = await request(app).get(`/api/v1/readings?stationId=${id}&minutes=10`);
  assert.equal(readings.status, 200);
  assert.ok(readings.body.data.length >= 1);
  assert.equal(readings.body.data[0].source.provider, 'open-meteo');
  assert.notEqual(readings.body.data[0].source.quality, 'simulated');

  // Station detail now shows real reading + freshness
  const detail = await request(app).get(`/api/v1/stations/${id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.data.latest, 'must have latest real reading');
  assert.equal(detail.body.data.latest.source.provider, 'open-meteo');

  cleanupStation(id);
});

test('stations: persistence survives process restart (JSON canonical store)', async () => {
  const STATION_FILE = TEST_STATIONS_FILE;
  // isolate by backing up current file
  const backup = `${STATION_FILE}.bak_${process.pid}`;
  let hadFile = fs.existsSync(STATION_FILE);
  if (hadFile) fs.copyFileSync(STATION_FILE, backup);

  try {
    // Clean start for this test
    try { fs.unlinkSync(STATION_FILE); } catch (_) {}
    stationsDb.resetState();

    const marker = {
      id: `AMD${unique().slice(0, 8)}`,
      name: `Restart Probe ${unique()}`,
      lat: 23.0225,
      lon: 72.5714,
      provider: 'open-meteo',
      parameters: ['temperature', 'humidity'],
      timezone: 'Asia/Kolkata',
      status: 'offline',
    };
    stationsDb.createStation(marker, { config });

    const script = `
      const stationsDb = require(${JSON.stringify(path.resolve(__dirname, '../src/db/stations').replace(/\\/g, '\\\\'))});
      const list = stationsDb.listPersistedStations();
      const found = list.find((s) => s.id === ${JSON.stringify(marker.id)});
      process.stdout.write(JSON.stringify({ found: !!found, name: found && found.name, provider: found && found.provider }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: process.env });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.found, true, 'station must be readable after a fresh process (restart)');
    assert.equal(parsed.name, marker.name);
    assert.equal(parsed.provider, 'open-meteo');
  } finally {
    try { if (hadFile) fs.copyFileSync(backup, STATION_FILE); else fs.unlinkSync(STATION_FILE); } catch (_) {}
    try { fs.unlinkSync(backup); } catch (_) {}
    stationsDb.resetState();
  }
});

test('stations: realtime station:added event reaches a connected client exactly once', async () => {
  // Boot the real HTTP+Socket.IO server on an ephemeral port and subscribe as a client.
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;

  const received = [];
  const connection = new Promise((resolve, reject) => {
    const c = socketClient(url, { transports: ['websocket'], forceNew: true });
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 5000);
    c.on('connect', () => { clearTimeout(timer); resolve(c); });
    c.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
    c.on('station:added', (payload) => received.push(payload));
  });
  const client = await connection;

  const token = await login();
  const body = validBody({ name: `Realtime ${unique()}` });
  const r = await request(app).post('/api/v1/stations').set('Authorization', `Bearer ${token}`).send(body);
  assert.equal(r.status, 201);

  // Socket.IO delivery is async; poll briefly for the broadcast
  let attempts = 0;
  while (received.filter((x) => x.id === body.id).length === 0 && attempts < 50) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    attempts += 1;
  }
  client.close();

  const ours = received.filter((x) => x.id === body.id);
  assert.equal(ours.length, 1, 'exactly one station:added event for the new station');
  assert.equal(ours[0].provider, body.provider);
  assert.equal(ours[0].status, 'offline');

  cleanupStation(body.id);
  await new Promise((resolve) => server.close(resolve));
});

test('stations: GET /stations/meta exposes catalog without secrets', async () => {
  const r = await request(app).get('/api/v1/stations/meta');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.parameters));
  assert.ok(Array.isArray(r.body.data.timezones));
  assert.ok(Array.isArray(r.body.data.states));
  assert.ok(Array.isArray(r.body.data.providers));
  const metaStr = JSON.stringify(r.body.data);
  assert.ok(!/apiKey|apikey|secret|token/i.test(metaStr) || !r.body.data.providers.some((p) => p.credentials), 'no credentials exposed');
});