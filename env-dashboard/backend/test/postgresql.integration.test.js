'use strict';

// PostgreSQL integration suite.
//
// Runs only when the backend was started with PG_ENABLED=true (the same gate
// api.test.js uses for its PG assertions). When PostgreSQL is enabled AND the
// database is reachable, every case runs and asserts against the real schema
// and the app-layer db modules. When disabled or unreachable the cases skip so
// memory-mode test runs stay green.
//
// The harness uses the exact same pool the live server boot path uses
// (src/db/pg.js → config.pg), so a green run proves the end-to-end connection,
// schema, CRUD, parameterization and self-healing behavior the server relies on.

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const config = require('../src/config');
const pg = require('../src/db/pg');
const authDb = require('../src/db/auth');
const alertsDb = require('../src/db/alerts');
const { tickReading } = require('../src/stations');

const ENABLED = config.pg.enabled;
let reachable = false;

test.before(async () => {
  if (!ENABLED) return;
  pg.init(config.pg);
  reachable = await pg.ping();
});

test.after(async () => {
  if (ENABLED && pg.isEnabled()) await pg.close();
});

function pgRequired(t) {
  if (!ENABLED) { t.skip('PostgreSQL is not enabled (PG_ENABLED != true)'); return false; }
  if (!reachable) { t.skip('PostgreSQL is configured but not reachable'); return false; }
  return true;
}

test('postgres: connection round-trip (SELECT 1) succeeds when enabled', async (t) => {
  if (!pgRequired(t)) return;
  assert.equal(pg.isEnabled(), true);
  assert.equal(await pg.ping(), true);
});

test('postgres: schema contains every core relational table (idempotent)', async (t) => {
  if (!pgRequired(t)) return;
  const wanted = ['users', 'stations', 'alerts', 'reports', 'readings',
    'maintenance_records', 'ml_runs', 'data_quality_issues',
    'data_quality_snapshots', 'audit_logs'];
  const r = await pg.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1::text[]) ORDER BY table_name`,
    [wanted]
  );
  const present = r.rows.map((x) => x.table_name);
  for (const table of wanted) {
    assert.ok(present.includes(table), `missing PostgreSQL table: ${table}`);
  }
});

test('postgres: app-layer user lifecycle persists and hashes passwords', async (t) => {
  if (!pgRequired(t)) return;
  const username = `pgit_${Date.now()}`;
  const created = await authDb.createUser({ username, password: 'PgIntegration!2026' });
  assert.equal(created.username, username);
  const stored = await pg.query('SELECT password_hash FROM users WHERE username = $1', [username]);
  assert.equal(stored.rowCount, 1);
  assert.ok(stored.rows[0].password_hash.startsWith('$2'), 'password must be bcrypt-hashed, never stored in plaintext');
  const found = await authDb.findUserByUsername(username);
  assert.equal(found.username, username);
  await pg.query('DELETE FROM users WHERE username = $1', [username]);
  assert.equal(await authDb.findUserByUsername(username), null);
});

test('postgres: alerts CRUD (insert / read / update / acknowledge / resolve)', async (t) => {
  if (!pgRequired(t)) return;
  const id = `PGIT-ALERT-${Date.now()}`;
  const ts = new Date().toISOString();
  await alertsDb.insertAlert({
    id, stationId: 'PGIT', station: 'PG Integration', severity: 'critical',
    title: 'integration alert', description: 'roundtrip', timestamp: ts,
    factors: [{ name: 'temp', value: 48 }], reading: { temperature: 48 },
  });
  const raw = await pg.query('SELECT severity, title, factors FROM alerts WHERE id = $1', [id]);
  assert.equal(raw.rowCount, 1);
  assert.equal(raw.rows[0].severity, 'critical');

  const appRead = await alertsDb.getAlert(id);
  assert.equal(appRead.id, id);

  await alertsDb.updateAlert(id, { title: 'integration alert (updated)' }, 'admin');
  const upd = (await pg.query('SELECT title FROM alerts WHERE id = $1', [id])).rows[0];
  assert.equal(upd.title, 'integration alert (updated)');

  await alertsDb.acknowledgeAlert(id, 'admin');
  assert.equal((await pg.query('SELECT acknowledged FROM alerts WHERE id = $1', [id])).rows[0].acknowledged, true);

  await alertsDb.resolveAlert(id, 'admin');
  const resolved = (await pg.query('SELECT resolved, resolved_by AS "resolvedBy" FROM alerts WHERE id = $1', [id])).rows[0];
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.resolvedBy, 'admin');

  await pg.query('DELETE FROM alerts WHERE id = $1', [id]);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM alerts WHERE id = $1', [id])).rows[0].n, 0);
});

test('postgres: parameterized queries defeat literal SQL injection', async (t) => {
  if (!pgRequired(t)) return;
  const id = `pgit${Date.now() % 1000000}`;
  // A hostile payload is stored as data, never executed.
  const payload = `x'); DROP TABLE stations; DELETE FROM users; --`;
  await pg.query(
    'INSERT INTO stations (id, name, lat, lon) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
    [id, payload, 11, 77]
  );
  const readBack = (await pg.query('SELECT name FROM stations WHERE id = $1', [id])).rows[0];
  assert.equal(readBack.name, payload, 'hostile text must be treated as plain data');

  const injection = await pg.query(`SELECT count(*)::int AS n FROM users WHERE username = $1`, [`admin' OR '1'='1 --`]);
  assert.equal(injection.rows[0].n, 0, 'injected boolean predicate must not match rows');

  const tables = await pg.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'stations'");
  assert.equal(tables.rows[0].n, 1, 'stations must still exist after hostile input');

  await pg.query('DELETE FROM stations WHERE id = $1', [id]);
});

test('postgres: readings written through the app ingestion path are persisted', async (t) => {
  if (!pgRequired(t)) return;
  const { stations, processReading } = require('../src/server');
  const s = stations[0];
  const reading = { ...tickReading(s, Math.floor(Date.now() / 1000)), time: new Date().toISOString() };
  reading.stationId = s.id;
  await processReading(reading);
  const r = await pg.query(
    'SELECT count(*)::int AS n FROM readings WHERE station_id = $1 AND time = $2',
    [s.id, reading.time]
  );
  assert.equal(r.rows[0].n, 1, 'ingested reading must be present in the readings table');
  await pg.query('DELETE FROM readings WHERE station_id = $1 AND time = $2', [s.id, reading.time]);
});

test('postgres: /api/v1/system/health and /api/v1/architecture report GREEN/UP', async (t) => {
  if (!pgRequired(t)) return;
  const { app } = require('../src/server');
  const health = await request(app).get('/api/v1/system/health');
  assert.equal(health.status, 200);
  const pgComp = health.body.data.components.find((c) => c.key === 'postgres');
  assert.ok(pgComp, 'postgres component must exist in system health');
  assert.equal(pgComp.color, 'GREEN', 'reachable PostgreSQL must be GREEN, not GRAY');
  const arch = await request(app).get('/api/v1/architecture');
  assert.equal(arch.status, 200);
  assert.equal(arch.body.data.components.storage.postgres.status, 'UP');
  assert.equal(arch.body.data.components.storage.postgres.configured, true);
});

test('postgres: credentials never appear in health/architecture responses or auth payloads', async (t) => {
  if (!pgRequired(t)) return;
  const { app } = require('../src/server');
  const [health, arch, login] = await Promise.all([
    request(app).get('/api/v1/system/health'),
    request(app).get('/api/v1/architecture'),
    request(app).post('/api/v1/auth/login').send({ username: config.auth.adminUsername, password: config.auth.adminPassword }),
  ]);
  for (const body of [health.body, arch.body]) {
    const json = JSON.stringify(body);
    assert.ok(!json.includes(config.pg.password), 'DB password must not be returned by public endpoints');
  }
  assert.equal(login.status, 200);
  const meRes = await request(app)
    .get('/api/v1/auth/me')
    .set('Authorization', `Bearer ${login.body.data.token}`);
  assert.ok(!JSON.stringify(meRes.body).includes('password'), 'auth responses must not expose password material');
});

test('postgres: outage at the pool layer degrades cleanly and self-heals on recovery', async (t) => {
  if (!pgRequired(t)) return;
  let recovered = false;
  pg.onRecovered(() => { recovered = true; });

  // Simulate outage: re-init the pool against a closed port with a short timeout.
  pg.init({ ...config.pg, port: 1, connectionTimeoutMillis: 300 });
  assert.equal(await pg.ping(), false, 'outage must report down');
  // A rapid follow-up ping must still report down (and is throttled so a
  // reconnect storm cannot form while PostgreSQL is down).
  assert.equal(await pg.ping(), false);
  assert.equal(recovered, false, 'no recovery callback while still down');

  // Simulate recovery: restore the real configuration and reconnect.
  pg.init(config.pg);
  assert.equal(await pg.ping(), true, 'recovery must reconnect and report up');
  assert.equal(recovered, true, 'recovery callback must fire after the pool reconnects');
  assert.equal(await pg.query('SELECT 1 AS ok').then((r) => r.rows[0].ok), 1);
});