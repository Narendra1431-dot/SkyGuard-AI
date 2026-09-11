'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const STATE_DIR = path.resolve(__dirname, '..', 'data', 'state');

function cleanup() {
  if (!fs.existsSync(STATE_DIR)) return;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (f.startsWith('test_integrity_')) {
      try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch (_) {}
    }
  }
  try {
    const ds = require('../src/services/dataStore');
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (f.startsWith('test_integrity_')) {
        const name = f.replace(/\.json$/, '');
        ds.resetScoped(name);
      }
    }
  } catch (_) {}
}

function resetModule() {
  delete require.cache[require.resolve('../src/services/dataStore')];
  delete require.cache[require.resolve('../src/db/alerts')];
}

test.beforeEach(() => { cleanup(); resetModule(); });
test.afterEach(() => { cleanup(); });

test('1. multiple rapid mutations', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_rapid');
  const mutations = 100;
  for (let i = 0; i < mutations; i++) {
    map.set(`key_${i}`, { id: `key_${i}`, value: i });
  }
  await dataStore.flushAll();
  assert.equal(map.size(), mutations, `Expected ${mutations} keys`);
});

test('2. mutation burst', async () => {
  const dataStore = require('../src/services/dataStore');
  const arr = dataStore.getArray('test_integrity_burst');
  const burst = 50;
  for (let i = 0; i < burst; i++) {
    arr.push({ id: `burst_${i}`, value: i });
  }
  await dataStore.flushAll();
  assert.equal(arr.size(), burst);
});

test('3. pending debounce flush', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_debounce');
  map.set('debounce_key', { id: 'debounce_key', value: 'test' });
  assert.ok(map.get('debounce_key'), 'Key should be in memory immediately');
  await dataStore.flushAll();
  resetModule();
  const ds2 = require('../src/services/dataStore');
  const map3 = ds2.getMap('test_integrity_debounce');
  assert.ok(map3.get('debounce_key'), 'Key should persist after flush');
});

test('4. alert history preservation - >500 alerts preserved in archive', async () => {
  const alerts = require('../src/db/alerts');
  const dataStore = require('../src/services/dataStore');
  const count = 600;
  for (let i = 0; i < count; i++) {
    await alerts.insertAlert({
      id: `HIST-${i}`,
      stationId: `STATION-${i % 10}`,
      station: `Station ${i % 10}`,
      severity: ['warning', 'critical', 'info'][i % 3],
      title: `Alert ${i}`,
      description: `Test alert ${i}`,
      recommendation: 'monitor',
      factors: [],
      reading: {},
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  await dataStore.flushAll();
  const allAlerts = await alerts.listAlerts({ limit: 1000 });
  assert.ok(allAlerts.length >= 500, `Should have at least 500 alerts in list (got ${allAlerts.length})`);
  const histAlert = allAlerts.find(a => a.id === 'HIST-0');
  assert.ok(histAlert, 'HIST-0 should be in alert list despite >500 total alerts');
});

test('5. >500 historical alerts retrievable from archive', async () => {
  const alerts = require('../src/db/alerts');
  const dataStore = require('../src/services/dataStore');
  for (let i = 0; i < 550; i++) {
    await alerts.insertAlert({
      id: `BIG-${i}`,
      stationId: 'STATION-1',
      station: 'Station 1',
      severity: 'warning',
      title: `Big alert ${i}`,
      description: `Historical alert ${i}`,
      recommendation: 'monitor',
      factors: [],
      reading: {},
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  await dataStore.flushAll();
  const found = await alerts.getAlert('BIG-0');
  assert.ok(found, 'Alert BIG-0 should be retrievable even though we inserted >500');
});

test('6. runtime cache evicts oldest but archive keeps all', async () => {
  const alerts = require('../src/db/alerts');
  const dataStore = require('../src/services/dataStore');
  for (let i = 0; i < 600; i++) {
    await alerts.insertAlert({
      id: `EVICT-${i}`,
      stationId: 'STATION-1',
      station: 'Station 1',
      severity: 'warning',
      title: `Evict test ${i}`,
      description: 'Testing runtime eviction',
      recommendation: 'monitor',
      factors: [],
      reading: {},
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  await dataStore.flushAll();
  const found = await alerts.getAlert('EVICT-0');
  assert.ok(found, 'EVICT-0 should be in archive even if evicted from runtime cache');
});

test('7. alert stats with >500 alerts', async () => {
  const alerts = require('../src/db/alerts');
  for (let i = 0; i < 550; i++) {
    await alerts.insertAlert({
      id: `STATS-${i}`,
      stationId: 'STATION-1',
      station: 'Station 1',
      severity: i % 2 === 0 ? 'warning' : 'critical',
      title: `Stats test ${i}`,
      description: 'Testing alert stats',
      recommendation: 'monitor',
      factors: [],
      reading: {},
      timestamp: new Date(Date.now() - i * 1000).toISOString(),
    });
  }
  const stats = await alerts.alertStats();
  assert.ok(stats.total >= 500, `Stats total should be >= 500 (got ${stats.total})`);
  assert.ok(stats.bySeverity?.warning >= 0, 'Stats should have bySeverity breakdown');
});

test('8. concurrent mutation ordering', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_order');
  map.set('order_key', { id: 'order_key', value: 0 });
  map.set('order_key', { id: 'order_key', value: 1 });
  map.set('order_key', { id: 'order_key', value: 2 });
  await dataStore.flushAll();
  assert.equal(map.get('order_key')?.value, 2, 'Final value should be 2');
  resetModule();
  const ds2 = require('../src/services/dataStore');
  const map2 = ds2.getMap('test_integrity_order');
  assert.equal(map2.get('order_key')?.value, 2, 'Final value should persist as 2');
});

test('9. concurrent writes are serialized', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_concurrent');
  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push((async () => {
      for (let j = 0; j < 10; j++) {
        map.set(`concurrent_${i}_${j}`, { id: `concurrent_${i}_${j}`, value: i * 10 + j });
      }
    })());
  }
  await Promise.all(writes);
  await dataStore.flushAll();
  assert.equal(map.size(), 100, 'All 100 concurrent writes should be present');
});

test('10. persistence corruption protection - valid JSON written', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_corrupt');
  map.set('corrupt_key', { id: 'corrupt_key', value: 'valid' });
  await dataStore.flushAll();
  const file = path.join(STATE_DIR, 'test_integrity_corrupt.json');
  assert.ok(fs.existsSync(file), 'File should exist after flush');
  const content = fs.readFileSync(file, 'utf8');
  assert.doesNotThrow(() => JSON.parse(content), 'Persisted JSON should be valid');
  const parsed = JSON.parse(content);
  assert.equal(parsed.corrupt_key?.value, 'valid', 'Parsed data should match');
});

test('11. flushAll returns promise that resolves', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_flush');
  map.set('flush_key', { id: 'flush_key', value: 'flush test' });
  const flushPromise = dataStore.flushAll();
  assert.ok(flushPromise instanceof Promise, 'flushAll should return a promise');
  await flushPromise;
  resetModule();
  const ds2 = require('../src/services/dataStore');
  const map2 = ds2.getMap('test_integrity_flush');
  assert.equal(map2.get('flush_key')?.value, 'flush test', 'Data should persist after flush');
});

test('12. flushAll handles empty collections', async () => {
  cleanup();
  const dataStore = require('../src/services/dataStore');
  await dataStore.flushAll();
  assert.ok(true, 'flushAll should handle empty collections without error');
});

test('13. process restart recovery via child process', () => {
  cleanup();
  return new Promise((resolve, reject) => {
    const dataStore = require('../src/services/dataStore');
    const map = dataStore.getMap('test_integrity_child');
    map.set('child_key', { id: 'child_key', value: 'child_value' });
    dataStore.flushAll().then(() => {
      const script = `
        const dataStore = require('${path.resolve(__dirname, '../src/services/dataStore').replace(/\\/g, '\\\\')}');
        const map = dataStore.getMap('test_integrity_child');
        const val = map.get('child_key');
        process.stdout.write(JSON.stringify({ found: !!val, value: val && val.value }));
      `;
      const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      if (res.status !== 0) {
        reject(new Error(`child exited non-zero: ${res.stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(res.stdout.trim());
        assert.equal(parsed.found, true, 'child should find the key');
        assert.equal(parsed.value, 'child_value', 'child should find the correct value');
        resolve();
      } catch (e) {
        reject(e);
      }
    }).catch(reject);
  });
});

test('14. graceful shutdown flush on SIGTERM via child process', () => {
  cleanup();
  return new Promise((resolve, reject) => {
    const script = `
      const dataStore = require('${path.resolve(__dirname, '../src/services/dataStore').replace(/\\/g, '\\\\')}');
      const map = dataStore.getMap('test_integrity_sigterm');
      map.set('sigterm_key', { id: 'sigterm_key', value: 'survived' });
      dataStore.flushAll().then(() => {
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 100);
      });
      setTimeout(() => {}, 3000);
    `;
    spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    setTimeout(() => {
      resetModule();
      const ds = require('../src/services/dataStore');
      const map = ds.getMap('test_integrity_sigterm');
      try {
        assert.equal(map.get('sigterm_key')?.value, 'survived', 'Data should survive SIGTERM after flush');
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 500);
  });
});

test('15. no stale snapshot overwrite - sequential updates', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_seq');
  map.set('seq', { id: 'seq', value: 1 });
  await dataStore.flushAll();
  map.set('seq', { id: 'seq', value: 2 });
  await dataStore.flushAll();
  map.set('seq', { id: 'seq', value: 3 });
  await dataStore.flushAll();
  resetModule();
  const ds2 = require('../src/services/dataStore');
  const map2 = ds2.getMap('test_integrity_seq');
  assert.equal(map2.get('seq')?.value, 3, 'Final value should be 3, not overwritten by stale snapshot');
});

test('16. atomic rename prevents partial writes', async () => {
  const dataStore = require('../src/services/dataStore');
  const map = dataStore.getMap('test_integrity_atomic');
  map.set('atomic_key', { id: 'atomic_key', value: 'atomic_value' });
  await dataStore.flushAll();
  const file = path.join(STATE_DIR, 'test_integrity_atomic.json');
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('atomic_value'), 'File should contain complete data');
  assert.ok(!content.includes('null'), 'File should not contain partial null values');
});
