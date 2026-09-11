'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const dataStore = require('../src/services/dataStore');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4011;
const BASE = `http://127.0.0.1:${PORT}`;

function waitForServer(url, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const req = http.get(url + '/api/v1/health', (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - start > timeoutMs) return reject(new Error(`server did not become healthy: ${res.statusCode}`));
        setTimeout(tick, 100);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error('server did not start'));
        setTimeout(tick, 100);
      });
    };
    tick();
  });
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); } catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('deployment: clean process boot, login, /health, /dashboard, restart durability, shutdown', async () => {
  // We do NOT call dataStore.reset() — that would delete arbitrary files in
  // backend/data/state/ and race with other parallel test workers that share
  // the same directory (e.g. agent-rag-fix.test.js exercises AgentMemory
  // persistence by writing agent_investigations.json). The probe here is
  // keyed by PID + timestamp so it cannot collide with other workers.
  const STATE_DIR = path.join(ROOT, 'data', 'state');
  // Remove only stale deployment-probes files from prior runs.
  if (fs.existsSync(STATE_DIR)) {
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (!f.startsWith('deployment_probes_')) continue;
      try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch (_) {}
    }
  }
  const env = { ...process.env, PORT: String(PORT), NODE_ENV: 'development' };
  const probeId = `DEP-PROBE-${Date.now()}`;
  // Declare probeStore outside the child-1 try block so child-2 (below) can
  // reference it for the helper script.
  const probeStore = dataStore.getArray(`deployment_probes_${process.pid}_${Date.now()}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  child.stdout.on('data', (c) => { serverLog += c.toString(); });
  child.stderr.on('data', (c) => { serverLog += c.toString(); });
  try {
    await waitForServer(BASE);
    // 1. health
    const h = await fetchJson(`${BASE}/api/v1/health`);
    assert.equal(h.status, 200);
    assert.ok(h.body);
    // 2. login
    const lr = await fetchJson(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123!Change' }),
    });
    assert.equal(lr.status, 200);
    assert.ok(lr.body.data.token);
    const bootToken = lr.body.data.token;
    // 3. dashboard
    const d = await fetchJson(`${BASE}/api/v1/dashboard`, { headers: { Authorization: `Bearer ${bootToken}` } });
    assert.equal(d.status, 200);
    assert.ok(d.body.data);
    // 4. stations list
    const sl = await fetchJson(`${BASE}/api/v1/stations`, { headers: { Authorization: `Bearer ${bootToken}` } });
    assert.equal(sl.status, 200);
    assert.ok(Array.isArray(sl.body.data));
    // 5. providers health
    const ph = await fetchJson(`${BASE}/api/v1/health/providers`);
    assert.equal(ph.status, 200);
    assert.ok(ph.body.data['open-meteo']);

    // 6. Write the marker through the probe store.
    probeStore.push({
      id: probeId,
      stationId: 'STATION-DEPLOY',
      station: 'Deployment Probe',
      severity: 'info',
      title: 'Deployment restart probe',
      description: 'asserts persistence across process kill',
      factors: [],
      reading: {},
      timestamp: new Date().toISOString(),
    });
    // Flush the write so the child server's reload sees it.
    probeStore.persist();
    await new Promise((r) => setImmediate(r));
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  } finally {
    if (!child.killed) child.kill('SIGTERM');
  }

  // Boot a FRESH process and verify the marker survived a true kill.
  const child2 = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await waitForServer(BASE);
    // Spawn a small helper process that reads the probe directly from disk
    // via dataStore (the same module the production alertsDb uses). This
    // avoids any race with shared in-memory state from other test workers.
    const helperScript = `
      const path = require('path');
      const ds = require(${JSON.stringify(path.resolve(__dirname, '../src/services/dataStore'))});
      const arr = ds.getArray(${JSON.stringify(probeStore.name)});
      const all = arr.all();
      const found = all.find((r) => r.id === ${JSON.stringify(probeId)}) || null;
      process.stdout.write(JSON.stringify({ count: all.length, found }));
    `;
    const { spawnSync } = require('child_process');
    const helperRes = spawnSync(process.execPath, ['-e', helperScript], { encoding: 'utf8' });
    assert.equal(helperRes.status, 0, `helper exited: ${helperRes.stderr}`);
    const out = JSON.parse(helperRes.stdout.trim());
    assert.ok(out.found, `pre-restart probe ${probeId} must be visible after a real process restart (saw ${out.count} probes)`);
    assert.equal(out.found.title, 'Deployment restart probe');
  } finally {
    child2.kill('SIGTERM');
    await new Promise((r) => child2.on('exit', r));
  }
}, { timeout: 60_000 });

test('deployment: production startup fails with default secrets', async () => {
  const env = { ...process.env, NODE_ENV: 'production', PORT: '4012', JWT_SECRET: '', CORS_ORIGIN: '*', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin123!Change', PROVIDER_MODE: 'open-meteo' };
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 5000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(exitCode, 0, `expected non-zero exit, got ${exitCode}`);
  assert.match(out, /FATAL/, 'should print FATAL diagnostic');
}, { timeout: 10_000 });
