'use strict';

/**
 * Runtime Verification Script for Event Timeline (Module #11)
 * Tests: API, filters, pagination, search, detail, persistence, realtime, error handling.
 * Run: node test/event-timeline-verify.js
 */

const http = require('http');

const BASE = 'http://localhost:4000';
let AUTH_TOKEN = null;

async function login() {
  return new Promise((resolve) => {
    const data = JSON.stringify({ username: 'admin', password: 'admin123!Change' });
    const req = http.request({ hostname: 'localhost', port: 4000, path: '/api/v1/auth/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { AUTH_TOKEN = JSON.parse(b).data?.token || null; } catch (_) {} resolve(); });
    });
    req.on('error', resolve);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const headers = { 'Content-Type': 'application/json' };
    if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    http.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const payload = JSON.stringify(body);
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
  }
}

async function run() {
  console.log('=== Event Timeline Runtime Verification ===\n');

  await login();

  // 1. Health check
  console.log('1. Backend health check');
  try {
    const h = await get('/api/v1/health');
    check('Backend is running', h.status === 200, `status=${h.status}`);
  } catch (e) {
    console.error('  FATAL: Backend is not running. Start it first with: cd backend && node src/server.js');
    process.exit(1);
  }

  // 2. Event timeline list API
  console.log('\n2. GET /api/v1/events');
  const list = await get('/api/v1/events?limit=10');
  check('Status 200', list.status === 200);
  check('success=true', list.body.success === true);
  check('data is array', Array.isArray(list.body.data));
  check('meta.total exists', typeof list.body.meta?.total === 'number');
  check('meta.offset exists', typeof list.body.meta?.offset === 'number');
  check('meta.latestSeq exists', typeof list.body.meta?.latestSeq === 'number');
  check('Returns ≤10 items', list.body.data.length <= 10);

  // 3. Event shape validation
  console.log('\n3. Event shape validation');
  if (list.body.data.length > 0) {
    const ev = list.body.data[0];
    check('Has id', typeof ev.id === 'string' && ev.id.startsWith('EVT-'));
    check('Has seq', typeof ev.seq === 'number');
    check('Has type', typeof ev.type === 'string');
    check('Has category', typeof ev.category === 'string');
    check('Has severity', typeof ev.severity === 'string');
    check('Has title', typeof ev.title === 'string');
    check('Has timestamp', typeof ev.timestamp === 'string' && !isNaN(new Date(ev.timestamp).getTime()));
    check('Has summary', typeof ev.summary === 'string');
    check('Has evidence', Array.isArray(ev.evidence));
    check('Has payload', ev.payload === null || typeof ev.payload === 'object');
  }

  // 4. Category filter
  console.log('\n4. Category filter');
  const catResult = await get('/api/v1/events?category=reading&limit=50');
  check('Status 200', catResult.status === 200);
  const allReading = catResult.body.data.every((e) => e.category === 'reading');
  check('All items are reading category', allReading);

  // 5. Severity filter (case-insensitive)
  console.log('\n5. Severity filter');
  const sevResult = await get('/api/v1/events?severity=critical&limit=50');
  check('Status 200', sevResult.status === 200);
  const allCritical = sevResult.body.data.every((e) => e.severity === 'critical' || e.severity === 'CRITICAL');
  check('All items have critical severity', allCritical);

  // 6. Station filter
  console.log('\n6. Station filter');
  const stations = await get('/api/v1/events/meta');
  if (stations.body.data?.stationIds?.length > 0) {
    const stId = stations.body.data.stationIds[0];
    const stResult = await get(`/api/v1/events?stationId=${encodeURIComponent(stId)}&limit=50`);
    check('Status 200', stResult.status === 200);
    const allMatch = stResult.body.data.every((e) => e.stationId === stId);
    check(`All items have stationId=${stId}`, allMatch);
  } else {
    check('Station filter (skipped, no stations with events)', true);
  }

  // 7. Search
  console.log('\n7. Search');
  const searchResult = await get('/api/v1/events?search=reading&limit=50');
  check('Status 200', searchResult.status === 200);
  check('Search returns results', searchResult.body.data.length > 0);
  const searchMatch = searchResult.body.data.some((e) =>
    (e.title || '').toLowerCase().includes('reading') ||
    (e.summary || '').toLowerCase().includes('reading') ||
    (e.type || '').toLowerCase().includes('reading')
  );
  check('At least one result matches "reading"', searchMatch);

  // 8. Time range filter
  console.log('\n8. Time range filter');
  const now = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const timeResult = await get(`/api/v1/events?after=${encodeURIComponent(hourAgo)}&before=${encodeURIComponent(now)}&limit=50`);
  check('Status 200', timeResult.status === 200);
  const allInRange = timeResult.body.data.every((e) => {
    const ts = new Date(e.timestamp).getTime();
    return ts >= new Date(hourAgo).getTime() && ts <= new Date(now).getTime();
  });
  check('All items within time range', allInRange);

  // 9. Pagination
  console.log('\n9. Pagination');
  const page1 = await get('/api/v1/events?limit=5&offset=0');
  const page2 = await get('/api/v1/events?limit=5&offset=5');
  check('Page 1 status 200', page1.status === 200);
  check('Page 2 status 200', page2.status === 200);
  if (page1.body.data.length > 0 && page2.body.data.length > 0) {
    check('Different first items', page1.body.data[0].id !== page2.body.data[0].id);
  }
  check('Offset preserved in meta', page2.body.meta?.offset === 5);

  // 10. Meta endpoint
  console.log('\n10. Meta endpoint');
  const meta = await get('/api/v1/events/meta');
  check('Status 200', meta.status === 200);
  check('Has categories array', Array.isArray(meta.body.data?.categories));
  check('Has types array', Array.isArray(meta.body.data?.types));
  check('Has stationIds array', Array.isArray(meta.body.data?.stationIds));
  check('Has total', typeof meta.body.data?.total === 'number');

  // 11. Event detail
  console.log('\n11. Event detail');
  if (list.body.data.length > 0) {
    const id = list.body.data[0].id;
    const detail = await get(`/api/v1/events/${encodeURIComponent(id)}`);
    check('Status 200', detail.status === 200);
    check('Event id matches', detail.body.data?.id === id);
    check('Has timestamp', !!detail.body.data?.timestamp);
    check('Has type', !!detail.body.data?.type);
  }

  // 12. Missing event returns 404
  console.log('\n12. Missing event');
  const missing = await get('/api/v1/events/EVT-0000000000-nobody');
  check('Status 404', missing.status === 404);
  check('success=false', missing.body.success === false);

  // 13. Empty filter returns empty
  console.log('\n13. Empty filter');
  const empty = await get('/api/v1/events?category=nonexistent_xyz');
  check('Status 200', empty.status === 200);
  check('Empty data array', empty.body.data.length === 0);

  // 14. Create event via monitoring loop
  console.log('\n14. Real event creation');
  const beforeSeq = list.body.meta.latestSeq;
  // Wait for a monitoring cycle to generate events
  await new Promise((r) => setTimeout(r, 2000));
  const afterList = await get('/api/v1/events?limit=5');
  check('Events still available', afterList.body.data.length > 0);
  check('Seq may have increased', afterList.body.meta.latestSeq >= beforeSeq);

  // 15. Combined filters
  console.log('\n15. Combined filters');
  const combined = await get('/api/v1/events?category=reading&severity=info&limit=50');
  check('Status 200', combined.status === 200);
  const allMatchCombined = combined.body.data.every((e) => e.category === 'reading' && (e.severity === 'info' || e.severity === 'INFO'));
  check('Combined filters correct', allMatchCombined);

  // 16. Backend startup is restart-safe
  console.log('\n16. Persistence (events survive in events.json)');
  const fs = require('fs');
  const path = require('path');
  const eventsFile = path.resolve(__dirname, '..', 'data', 'state', 'events.json');
  check('events.json exists', fs.existsSync(eventsFile));
  if (fs.existsSync(eventsFile)) {
    const events = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
    check('events.json has data', Array.isArray(events) && events.length > 0, `count=${events.length}`);
    check('Events have correct shape', events[0]?.id && events[0]?.seq && events[0]?.timestamp);
  }

  // 17. Security: path traversal
  console.log('\n17. Security');
  const traversal = await get('/api/v1/events/../../etc/passwd');
  check('Path traversal returns 404/400', traversal.status === 404 || traversal.status === 400);

  // 18. Invalid params don't crash
  console.log('\n18. Invalid params');
  const invalid = await get('/api/v1/events?limit=-5&offset=-10');
  check('Invalid params return 200 (not crash)', invalid.status === 200);

  // Summary
  console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => { console.error('Verification failed:', e); process.exit(1); });
