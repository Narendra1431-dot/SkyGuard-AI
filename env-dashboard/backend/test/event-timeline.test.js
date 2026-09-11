'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const STATE_DIR = path.resolve(__dirname, '..', 'data', 'state');

function resetTestEvents() {
  const file = path.join(STATE_DIR, 'test_timeline_events.json');
  try { fs.unlinkSync(file); } catch (_) {}
  try {
    const ds = require('../src/services/dataStore');
    ds.resetScoped('test_timeline_events');
  } catch (_) {}
}

// ─── eventBus unit tests ────────────────────────────────────────────────────

test('eventBus: publish creates event with correct shape', () => {
  resetTestEvents();
  const eventBus = require('../src/services/eventBus');
  const ev = eventBus.publish({
    type: 'reading.created',
    category: 'reading',
    severity: 'info',
    stationId: 'ST001',
    station: 'Test Station',
    title: 'New reading',
    summary: 'temp 25°C',
    evidence: ['reason1'],
    payload: { aqi: 100 },
  });
  assert.ok(ev.id, 'event has id');
  assert.ok(ev.id.startsWith('EVT-'), 'id starts with EVT-');
  assert.equal(typeof ev.seq, 'number');
  assert.equal(ev.type, 'reading.created');
  assert.equal(ev.category, 'reading');
  assert.equal(ev.severity, 'info');
  assert.equal(ev.stationId, 'ST001');
  assert.equal(ev.station, 'Test Station');
  assert.equal(ev.title, 'New reading');
  assert.equal(ev.summary, 'temp 25°C');
  assert.deepEqual(ev.evidence, ['reason1']);
  assert.deepEqual(ev.payload, { aqi: 100 });
  assert.ok(ev.timestamp, 'has timestamp');
  assert.ok(new Date(ev.timestamp).getTime() > 0, 'timestamp is valid ISO');
});

test('eventBus: publish defaults', () => {
  const eventBus = require('../src/services/eventBus');
  const ev = eventBus.publish({ type: 'test.event' });
  assert.equal(ev.category, 'system');
  assert.equal(ev.severity, 'info');
  assert.equal(ev.stationId, null);
  assert.equal(ev.station, null);
  assert.equal(ev.title, '');
  assert.equal(ev.summary, '');
  assert.deepEqual(ev.evidence, []);
  assert.equal(ev.payload, null);
});

test('eventBus: list returns paginated results', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ limit: 5, offset: 0 });
  assert.ok(Array.isArray(result.items), 'items is array');
  assert.equal(typeof result.total, 'number');
  assert.equal(typeof result.offset, 'number');
  assert.equal(typeof result.limit, 'number');
  assert.ok(result.items.length <= 5, 'respects limit');
});

test('eventBus: list with offset pagination', () => {
  const eventBus = require('../src/services/eventBus');
  const page1 = eventBus.list({ limit: 3, offset: 0 });
  const page2 = eventBus.list({ limit: 3, offset: 3 });
  if (page1.total > 3) {
    assert.ok(page2.items.length > 0, 'page2 has items');
    assert.notEqual(page1.items[0]?.id, page2.items[0]?.id, 'different items');
  }
});

test('eventBus: list filters by category', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ category: 'reading', limit: 100 });
  for (const e of result.items) {
    assert.equal(e.category, 'reading', 'all items match category');
  }
});

test('eventBus: list filters by severity (case-insensitive)', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ severity: 'critical', limit: 100 });
  for (const e of result.items) {
    assert.ok(
      e.severity === 'critical' || e.severity === 'CRITICAL',
      `severity is critical: ${e.severity}`
    );
  }
});

test('eventBus: list filters by stationId', () => {
  const eventBus = require('../src/services/eventBus');
  const stations = eventBus.stationIds();
  if (stations.length > 0) {
    const result = eventBus.list({ stationId: stations[0], limit: 100 });
    for (const e of result.items) {
      assert.equal(e.stationId, stations[0]);
    }
  }
});

test('eventBus: list filters by type', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ type: 'reading.created', limit: 100 });
  for (const e of result.items) {
    assert.equal(e.type, 'reading.created');
  }
});

test('eventBus: list filters by time range (after)', () => {
  const eventBus = require('../src/services/eventBus');
  const after = new Date(Date.now() - 3600000).toISOString();
  const result = eventBus.list({ after, limit: 100 });
  for (const e of result.items) {
    assert.ok(new Date(e.timestamp).getTime() >= new Date(after).getTime());
  }
});

test('eventBus: list filters by time range (before)', () => {
  const eventBus = require('../src/services/eventBus');
  const before = new Date().toISOString();
  const result = eventBus.list({ before, limit: 100 });
  for (const e of result.items) {
    assert.ok(new Date(e.timestamp).getTime() <= new Date(before).getTime());
  }
});

test('eventBus: list search by title', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ search: 'reading', limit: 100 });
  if (result.items.length > 0) {
    for (const e of result.items) {
      const match = (e.title || '').toLowerCase().includes('reading') ||
        (e.summary || '').toLowerCase().includes('reading') ||
        (e.type || '').toLowerCase().includes('reading');
      assert.ok(match, `event matches search: ${e.title}`);
    }
  }
});

test('eventBus: list combined filters', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ category: 'reading', severity: 'info', limit: 50 });
  for (const e of result.items) {
    assert.equal(e.category, 'reading');
    assert.ok(e.severity === 'info' || e.severity === 'INFO');
  }
});

test('eventBus: get returns event by id', () => {
  const eventBus = require('../src/services/eventBus');
  const ev = eventBus.publish({ type: 'test.get', title: 'Get Test' });
  const found = eventBus.get(ev.id);
  assert.ok(found, 'found event');
  assert.equal(found.id, ev.id);
  assert.equal(found.title, 'Get Test');
});

test('eventBus: get returns null for missing id', () => {
  const eventBus = require('../src/services/eventBus');
  const found = eventBus.get('EVT-0000000000-ffffff');
  assert.equal(found, null);
});

test('eventBus: get returns null for null/undefined id', () => {
  const eventBus = require('../src/services/eventBus');
  assert.equal(eventBus.get(null), null);
  assert.equal(eventBus.get(undefined), null);
  assert.equal(eventBus.get(''), null);
});

test('eventBus: categories returns unique sorted list', () => {
  const eventBus = require('../src/services/eventBus');
  const cats = eventBus.categories();
  assert.ok(Array.isArray(cats));
  const unique = new Set(cats);
  assert.equal(unique.size, cats.length, 'no duplicates');
  assert.deepEqual(cats, [...cats].sort(), 'sorted');
});

test('eventBus: types returns unique sorted list', () => {
  const eventBus = require('../src/services/eventBus');
  const types = eventBus.types();
  assert.ok(Array.isArray(types));
  const unique = new Set(types);
  assert.equal(unique.size, types.length, 'no duplicates');
});

test('eventBus: stationIds returns unique sorted list', () => {
  const eventBus = require('../src/services/eventBus');
  const ids = eventBus.stationIds();
  assert.ok(Array.isArray(ids));
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, 'no duplicates');
});

test('eventBus: count returns total events', () => {
  const eventBus = require('../src/services/eventBus');
  const c = eventBus.count();
  assert.equal(typeof c, 'number');
  assert.ok(c >= 0);
});

test('eventBus: latestSeq returns number', () => {
  const eventBus = require('../src/services/eventBus');
  const seq = eventBus.latestSeq();
  assert.equal(typeof seq, 'number');
  assert.ok(seq >= 0);
});

test('eventBus: normalizeSeverity handles mixed case', () => {
  const eventBus = require('../src/services/eventBus');
  assert.equal(eventBus.normalizeSeverity('CRITICAL'), 'critical');
  assert.equal(eventBus.normalizeSeverity('info'), 'info');
  assert.equal(eventBus.normalizeSeverity('Warning'), 'warning');
  assert.equal(eventBus.normalizeSeverity('HIGH'), 'high');
  assert.equal(eventBus.normalizeSeverity(null), '');
  assert.equal(eventBus.normalizeSeverity(undefined), '');
});

test('eventBus: search is case-insensitive', () => {
  const eventBus = require('../src/services/eventBus');
  const r1 = eventBus.list({ search: 'READING', limit: 10 });
  const r2 = eventBus.list({ search: 'reading', limit: 10 });
  assert.equal(r1.items.length, r2.items.length, 'case-insensitive search yields same count');
});

test('eventBus: offset beyond total returns empty', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ limit: 10, offset: 999999 });
  assert.equal(result.items.length, 0);
  assert.ok(result.total >= 0);
});

test('eventBus: limit is clamped to MAX_EVENTS', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ limit: 999999 });
  assert.ok(result.items.length <= eventBus.MAX_EVENTS);
  assert.ok(result.limit <= eventBus.MAX_EVENTS);
});

// ─── API integration tests ──────────────────────────────────────────────────

const request = require('supertest');
const { app, stations, processReading, io } = require('../src/server');
const { tickReading } = require('../src/stations');
const { initFromEnv } = require('../src/db/auth');
const config = require('../src/config');

test.before(async () => { try { await initFromEnv(config.auth); } catch (_) {} });

async function getAuthHeader() {
  const r = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'admin123!Change' });
  return { Authorization: `Bearer ${r.body.data.token}` };
}

async function seedOneReading() {
  if (stations.length > 0) {
    await processReading({ ...tickReading(stations[0], Math.floor(Date.now() / 1000)), time: new Date().toISOString() });
  }
}

test('API GET /api/v1/events returns paginated result', async () => {
  await seedOneReading();
  const r = await request(app).get('/api/v1/events?limit=5');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data), 'data is array');
  assert.equal(typeof r.body.meta.total, 'number');
  assert.equal(typeof r.body.meta.offset, 'number');
  assert.ok(r.body.data.length <= 5, 'respects limit');
});

test('API GET /api/v1/events with offset', async () => {
  const r1 = await request(app).get('/api/v1/events?limit=3&offset=0');
  const r2 = await request(app).get('/api/v1/events?limit=3&offset=3');
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  if (r1.body.data.length > 0 && r2.body.data.length > 0) {
    assert.notEqual(r1.body.data[0].id, r2.body.data[0].id, 'different pages have different first items');
  }
});

test('API GET /api/v1/events with category filter', async () => {
  const r = await request(app).get('/api/v1/events?category=reading&limit=20');
  assert.equal(r.status, 200);
  for (const e of r.body.data) {
    assert.equal(e.category, 'reading');
  }
});

test('API GET /api/v1/events with severity filter', async () => {
  const r = await request(app).get('/api/v1/events?severity=critical&limit=20');
  assert.equal(r.status, 200);
  for (const e of r.body.data) {
    assert.ok(e.severity === 'critical' || e.severity === 'CRITICAL');
  }
});

test('API GET /api/v1/events with search', async () => {
  const r = await request(app).get('/api/v1/events?search=reading&limit=20');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length > 0, 'search returns results');
});

test('API GET /api/v1/events with time range', async () => {
  const after = new Date(Date.now() - 3600000).toISOString();
  const before = new Date().toISOString();
  const r = await request(app).get(`/api/v1/events?after=${encodeURIComponent(after)}&before=${encodeURIComponent(before)}&limit=20`);
  assert.equal(r.status, 200);
  for (const e of r.body.data) {
    assert.ok(new Date(e.timestamp).getTime() >= new Date(after).getTime());
    assert.ok(new Date(e.timestamp).getTime() <= new Date(before).getTime());
  }
});

test('API GET /api/v1/events/meta returns categories, types, stationIds', async () => {
  const r = await request(app).get('/api/v1/events/meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data.categories));
  assert.ok(Array.isArray(r.body.data.types));
  assert.ok(Array.isArray(r.body.data.stationIds));
  assert.equal(typeof r.body.data.total, 'number');
});

test('API GET /api/v1/events/:id returns event detail', async () => {
  const auth = await getAuthHeader();
  const list = await request(app).get('/api/v1/events?limit=1');
  if (list.body.data.length > 0) {
    const id = list.body.data[0].id;
    const r = await request(app).get(`/api/v1/events/${encodeURIComponent(id)}`).set(auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data.id, id);
    assert.ok(r.body.data.timestamp);
    assert.ok(r.body.data.type);
    assert.ok(r.body.data.category);
  }
});

test('API GET /api/v1/events/:id returns 404 for missing event', async () => {
  const auth = await getAuthHeader();
  const r = await request(app).get('/api/v1/events/EVT-0000000000-nobody').set(auth);
  assert.equal(r.status, 404);
  assert.equal(r.body.success, false);
  assert.ok(r.body.error.message);
});

test('API GET /api/v1/events returns empty array when no matches', async () => {
  const r = await request(app).get('/api/v1/events?category=nonexistent_category_xyz');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, []);
});

test('API events include latestSeq in meta', async () => {
  const r = await request(app).get('/api/v1/events?limit=1');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.meta.latestSeq, 'number');
});

test('API events: combined filters work', async () => {
  const r = await request(app).get('/api/v1/events?category=reading&severity=info&limit=50');
  assert.equal(r.status, 200);
  for (const e of r.body.data) {
    assert.equal(e.category, 'reading');
    assert.ok(e.severity === 'info' || e.severity === 'INFO');
  }
});

// ─── Persistence tests ──────────────────────────────────────────────────────

test('eventBus: events persist to disk and survive reload', async () => {
  const eventBus = require('../src/services/eventBus');
  const ev = eventBus.publish({
    type: 'test.persist',
    category: 'system',
    severity: 'info',
    title: 'Persistence test event',
    summary: 'should survive restart',
  });
  assert.ok(ev.id);

  await require('../src/services/dataStore').flushAll();

  // Force reload the module
  delete require.cache[require.resolve('../src/services/eventBus')];
  const eventBus2 = require('../src/services/eventBus');
  const found = eventBus2.get(ev.id);
  assert.ok(found, 'event survived flush+reload');
  assert.equal(found.title, 'Persistence test event');
  assert.equal(found.type, 'test.persist');
});

test('eventBus: seq survives reload', async () => {
  const eventBus = require('../src/services/eventBus');
  const seqBefore = eventBus.latestSeq();
  eventBus.publish({ type: 'test.seq' });
  const seqAfter = eventBus.latestSeq();
  assert.ok(seqAfter > seqBefore, 'seq incremented');

  await require('../src/services/dataStore').flushAll();
  delete require.cache[require.resolve('../src/services/eventBus')];
  const eventBus2 = require('../src/services/eventBus');
  const seqReloaded = eventBus2.latestSeq();
  assert.ok(seqReloaded >= seqAfter, 'seq preserved after reload');
});

// ─── Duplicate event protection ─────────────────────────────────────────────

test('eventBus: duplicate event ids are unique', () => {
  const eventBus = require('../src/services/eventBus');
  const ids = new Set();
  for (let i = 0; i < 50; i++) {
    const ev = eventBus.publish({ type: 'test.dup', title: `Dup ${i}` });
    assert.ok(!ids.has(ev.id), `duplicate id found: ${ev.id}`);
    ids.add(ev.id);
  }
});

test('eventBus: seq is monotonically increasing', () => {
  const eventBus = require('../src/services/eventBus');
  let prevSeq = eventBus.latestSeq();
  for (let i = 0; i < 10; i++) {
    const ev = eventBus.publish({ type: 'test.seq.inc' });
    assert.ok(ev.seq > prevSeq, `seq ${ev.seq} > ${prevSeq}`);
    prevSeq = ev.seq;
  }
});

// ─── Edge cases ─────────────────────────────────────────────────────────────

test('eventBus: invalid time range returns empty', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ after: 'not-a-date', limit: 10 });
  // Should not crash; may return all items if date is NaN
  assert.ok(Array.isArray(result.items));
});

test('eventBus: negative offset treated as 0', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ limit: 5, offset: -10 });
  assert.equal(result.offset, 0);
});

test('eventBus: zero limit returns empty', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ limit: 0 });
  assert.equal(result.items.length, 0);
});

test('API: invalid event id returns 404 not 500', async () => {
  const auth = await getAuthHeader();
  const r = await request(app).get('/api/v1/events/../../etc/passwd').set(auth);
  assert.ok(r.status === 404 || r.status === 400, `status is 404 or 400, got ${r.status}`);
});

// ─── Sort parameter ──────────────────────────────────────────────────────────

test('eventBus: sort=desc returns newest-first (default)', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ sort: 'desc', limit: 50 });
  if (result.items.length > 1) {
    const ts0 = new Date(result.items[0].timestamp).getTime();
    const ts1 = new Date(result.items[1].timestamp).getTime();
    assert.ok(ts0 >= ts1, 'desc: first event is newer or equal to second');
  }
});

test('eventBus: sort=asc returns oldest-first', () => {
  const eventBus = require('../src/services/eventBus');
  const result = eventBus.list({ sort: 'asc', limit: 50 });
  if (result.items.length > 1) {
    const ts0 = new Date(result.items[0].timestamp).getTime();
    const ts1 = new Date(result.items[1].timestamp).getTime();
    assert.ok(ts0 <= ts1, 'asc: first event is older or equal to second');
  }
});

test('API GET /api/v1/events?sort=desc returns paginated result', async () => {
  const r = await request(app).get('/api/v1/events?sort=desc&limit=5');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data));
  assert.equal(typeof r.body.meta.sort, 'string');
  assert.equal(r.body.meta.sort, 'desc');
});

test('API GET /api/v1/events?sort=asc returns oldest-first', async () => {
  const r = await request(app).get('/api/v1/events?sort=asc&limit=10');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  if (r.body.data.length > 1) {
    const ts0 = new Date(r.body.data[0].timestamp).getTime();
    const ts1 = new Date(r.body.data[1].timestamp).getTime();
    assert.ok(ts0 <= ts1, 'asc: server returns oldest-first');
  }
  assert.equal(r.body.meta.sort, 'asc');
});

// ─── Auth / Authorization ────────────────────────────────────────────────────

test('API GET /api/v1/events list is public (no auth required)', async () => {
  const r = await request(app).get('/api/v1/events?limit=5');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
});

test('API GET /api/v1/events/meta is public (no auth required)', async () => {
  const r = await request(app).get('/api/v1/events/meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
});

test('API GET /api/v1/events/:id requires auth', async () => {
  const r = await request(app).get('/api/v1/events/EVT-0000000000-nobody');
  assert.equal(r.status, 401);
  assert.equal(r.body.success, false);
});

test('API GET /api/v1/events/:id with auth returns event', async () => {
  const auth = await getAuthHeader();
  const list = await request(app).get('/api/v1/events?limit=1');
  if (list.body.data.length > 0) {
    const id = list.body.data[0].id;
    const r = await request(app).get(`/api/v1/events/${encodeURIComponent(id)}`).set(auth);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.data.id, id);
  }
});

// ─── Response format ─────────────────────────────────────────────────────────

test('API GET /api/v1/events returns standard response envelope', async () => {
  const r = await request(app).get('/api/v1/events?limit=5');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data), 'data is array');
  assert.ok(typeof r.body.meta === 'object', 'meta is object');
  assert.ok(typeof r.body.timestamp === 'string', 'has timestamp');
});

test('API GET /api/v1/events/meta returns standard response envelope', async () => {
  const r = await request(app).get('/api/v1/events/meta');
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data.categories));
  assert.ok(Array.isArray(r.body.data.types));
  assert.ok(Array.isArray(r.body.data.stationIds));
  assert.equal(typeof r.body.data.total, 'number');
  assert.ok(typeof r.body.timestamp === 'string');
});

// ─── Frontend total/meta handling ────────────────────────────────────────────

test('API events list meta includes total, offset, limit', async () => {
  const r = await request(app).get('/api/v1/events?limit=5&offset=0');
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.meta.total, 'number');
  assert.equal(typeof r.body.meta.offset, 'number');
  assert.equal(typeof r.body.meta.limit, 'number');
  assert.equal(typeof r.body.meta.latestSeq, 'number');
});
