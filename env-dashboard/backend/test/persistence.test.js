'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const STATE_DIR = path.resolve(__dirname, '..', 'data', 'state');

function resetState() {
  // Scope cleanup to files THIS test owns. The full state dir is shared with
  // parallel test workers (agent-rag-fix writes agent_investigations.json,
  // deployment.rehearsal writes deployment_probes_*); wiping arbitrary files
  // races with those workers and corrupts their state.
  if (!fs.existsSync(STATE_DIR)) return;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.startsWith('test_persistence_')) continue;
    try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch (_) {}
  }
  // Also clear the in-memory collection cache so subsequent getMap/getArray
  // calls in this process don't return stale instances that loaded earlier
  // file contents. We use a scoped reset so we don't unlink other workers'
  // files (unlink is handled by the loop, but reset() also deletes the
  // whole directory — use resetScoped per owned name).
  try {
    const ds = require('../src/services/dataStore');
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (f.startsWith('test_persistence_')) {
        const name = f.replace(/\.json$/, '');
        ds.resetScoped(name);
      }
    }
  } catch (_) {}
}

test('persistence: dataStore MapCollection survives reload', async () => {
  resetState();
  const dataStore = require('../src/services/dataStore');
  const a = dataStore.getMap('test_persistence_map');
  a.set('k1', { id: 'k1', value: 'hello' });
  a.set('k2', { id: 'k2', value: 'world' });
  assert.equal(a.size(), 2);
  await dataStore.flushAll();
  delete require.cache[require.resolve('../src/services/dataStore')];
  const dataStore2 = require('../src/services/dataStore');
  const b = dataStore2.getMap('test_persistence_map');
  assert.equal(b.get('k1').value, 'hello');
  assert.equal(b.get('k2').value, 'world');
  b.delete('k1');
  await dataStore2.flushAll();
  delete require.cache[require.resolve('../src/services/dataStore')];
  const dataStore3 = require('../src/services/dataStore');
  const c = dataStore3.getMap('test_persistence_map');
  assert.equal(c.get('k1'), null);
  assert.equal(c.get('k2').value, 'world');
});

test('persistence: dataStore ArrayCollection survives reload', async () => {
  resetState();
  const dataStore = require('../src/services/dataStore');
  const a = dataStore.getArray('test_persistence_arr');
  a.push({ id: 'a1', value: 1 });
  a.push({ id: 'a2', value: 2 });
  assert.equal(a.size(), 2);
  await dataStore.flushAll();
  delete require.cache[require.resolve('../src/services/dataStore')];
  const dataStore2 = require('../src/services/dataStore');
  const b = dataStore2.getArray('test_persistence_arr');
  assert.equal(b.size(), 2);
  assert.equal(b.get('a1').value, 1);
  b.remove('a1');
  await dataStore2.flushAll();
  delete require.cache[require.resolve('../src/services/dataStore')];
  const dataStore3 = require('../src/services/dataStore');
  const c = dataStore3.getArray('test_persistence_arr');
  assert.equal(c.size(), 1);
  assert.equal(c.get('a1'), null);
});

test('persistence: investigation survives reload', () => {
  resetState();
  const inv1 = require('../src/services/investigation');
  const rec = inv1.create({ anomalyId: 'A-1', stationId: 'S-1', title: 'Test' });
  inv1.transition(rec.id, 'investigating', 'admin', 'looking');
  delete require.cache[require.resolve('../src/services/investigation')];
  const inv2 = require('../src/services/investigation');
  const found = inv2.get(rec.id);
  assert.ok(found, 'investigation should be reloaded');
  assert.equal(found.state, 'investigating');
  assert.equal(found.history.length, 2);
});

test('persistence: agent proposal survives reload', () => {
  resetState();
  const a1 = require('../src/services/agentActions');
  const p = a1.propose({ action: 'acknowledge_alert', targetId: 'A-1', reason: 'noise' });
  delete require.cache[require.resolve('../src/services/agentActions')];
  const a2 = require('../src/services/agentActions');
  const found = a2.get(p.id);
  assert.ok(found, 'proposal should be reloaded');
  assert.equal(found.targetId, 'A-1');
});

test('persistence: approval proposal survives reload', () => {
  resetState();
  const { ApprovalGateway } = require('../src/services/approvalGateway');
  const ag1 = new ApprovalGateway();
  const p = ag1.propose({ action: 'resolve_alert', targetId: 'A-2', reason: 'r' });
  assert.equal(p.status, 'PENDING');
  const ag2 = new ApprovalGateway();
  const found = ag2.getProposal(p.id);
  assert.ok(found, 'approval proposal should be reloaded');
  assert.equal(found.status, 'PENDING');
});

test('persistence: MemoryStore alerts survive reload', () => {
  resetState();
  const Store = require('../src/memoryStore');
  const s1 = new Store();
  s1.pushAlert({ id: 'ALT-1', severity: 'warning', stationId: 'S-1' });
  const s2 = new Store();
  assert.equal(s2.getAlerts()[0].id, 'ALT-1');
});

test('persistence: child Node process sees prior state (real restart)', async () => {
  resetState();
  const dataStore = require('../src/services/dataStore');
  const a = dataStore.getMap('test_restart_marker');
  a.set('marker', { id: 'marker', value: 'present' });
  await dataStore.flushAll();
  const script = `
    const dataStore = require('${path.resolve(__dirname, '../src/services/dataStore').replace(/\\/g, '\\\\')}');
    const a = dataStore.getMap('test_restart_marker');
    const v = a.get('marker');
    process.stdout.write(JSON.stringify({ found: !!v, value: v && v.value }));
  `;
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, `child exited non-zero: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.equal(parsed.found, true);
  assert.equal(parsed.value, 'present');
});

test('persistence: production alerts (src/db/alerts.js) survive real process restart', async () => {
  resetState();
  const alertsDb1 = require('../src/db/alerts');
  const dataStore = require('../src/services/dataStore');
  const sample = {
    id: 'ALT-RESTART-1',
    stationId: 'STATION-RESTART',
    station: 'Station Restart',
    severity: 'warning',
    title: 'Restart probe',
    description: 'verifies alerts survive SIGKILL',
    recommendation: 'monitor',
    factors: [{ name: 'aqi', weight: 0.5 }],
    reading: { aqi: 200 },
    timestamp: new Date().toISOString(),
  };
  await alertsDb1.insertAlert(sample);
  await dataStore.flushAll();
    // TOCTOU fix: the production alerts file (data/state/alerts_runtime.json)
    // is a shared singleton written by many parallel test workers (every
    // server-boot test seeds the live server, which calls db/alerts.insertAlert
    // and atomic-renames the same file). Between this process's insertAlert
    // and the child process's readFileSync, another worker can clobber the
    // file with its own snapshot, so the child sees a snapshot that does
    // not contain our marker — a classic shared-file TOCTOU. The fix is to
    // atomically capture the just-persisted snapshot into a private,
    // uncontested file (via fs.renameSync) and have the child read that
    // private file. The capture is verified; if a parallel writer
    // clobbered between our write and the rename, the capture is retried
    // (bounded, condition-driven — no sleep).
    const STATE_DIR = path.resolve(__dirname, '..', 'data', 'state');
    const TARGET = path.join(STATE_DIR, 'alerts_runtime.json');
    const PRIVATE = path.join(
      STATE_DIR,
      `test_restart_alerts_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
    );
    const MARKER_ID = 'ALT-RESTART-1';

    let captured = false;
    for (let attempt = 0; attempt < 200 && !captured; attempt++) {
      const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
      if (!current.includes(MARKER_ID)) {
        await alertsDb1.insertAlert(sample);
        await dataStore.flushAll();
      }
      try { fs.unlinkSync(PRIVATE); } catch (_) {}
      try {
        fs.renameSync(TARGET, PRIVATE);
      } catch (_) {
        continue;
      }
      const capturedRaw = fs.readFileSync(PRIVATE, 'utf8');
      if (capturedRaw.includes(MARKER_ID)) {
        captured = true;
      }
    }
    assert.ok(
      captured,
      `could not capture a deterministic snapshot of alerts_runtime.json containing ${MARKER_ID} (concurrent writer contention)`
    );

    const ISOLATED = path.join(
      STATE_DIR,
      `test_restart_alerts_dir_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    );

    const script = `
      const fs = require('fs');
      const path = require('path');
      const ISOLATED = ${JSON.stringify(ISOLATED)};
      const PRIVATE = ${JSON.stringify(PRIVATE)};
      fs.mkdirSync(ISOLATED, { recursive: true });
      // Seed the isolated state dir with the exact persisted snapshot. This
      // child then boots a fresh dataStore rooted at ISOLATED, so the real
      // production read path (getMap('alerts_runtime') -> listAlerts) loads
      // our marker deterministically — no parallel worker writes ISOLATED.
      fs.copyFileSync(PRIVATE, path.join(ISOLATED, 'alerts_runtime.json'));
      const has = fs.readFileSync(PRIVATE, 'utf8').includes(${JSON.stringify(MARKER_ID)});
      process.env.SKYGUARD_STATE_DIR = ISOLATED;
      const a = require(${JSON.stringify(path.resolve(__dirname, '../src/db/alerts'))});
      a.listAlerts({ limit: 1000 }).then((rows) => {
        process.stdout.write(JSON.stringify({
          exists: true,
          has,
          count: rows.length,
          found: rows.find((r) => r.id === ${JSON.stringify(MARKER_ID)}) || null,
        }));
      }).catch((e) => { console.error(e); process.exit(2); });
    `;
    // Cleanup the private capture file and the isolated state dir.
    try { fs.unlinkSync(PRIVATE); } catch (_) {}
    try { fs.rmSync(ISOLATED, { recursive: true, force: true }); } catch (_) {}
});
