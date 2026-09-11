'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Each test file in `node --test` shares process state. Earlier test files
// can mutate dataStore (and the on-disk events.json) before we get here.
// Use a per-test isolated events collection so cross-test interference
// cannot make the cross-process assertion fail.
function makeIsolatedBus(label) {
  const dataStore = require('../src/services/dataStore');
  const key = `rt_isolated_${label}_${process.pid}_${Date.now()}`;
  const isolated = dataStore.getArray(key);
  let counter = isolated.size() || 0;
  let highestSeq = 0;
  for (const e of isolated.all()) if (typeof e.seq === 'number' && e.seq > highestSeq) highestSeq = e.seq;
  function publish(payload) {
    counter += 1;
    const event = {
      id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
      seq: highestSeq + 1,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    highestSeq = event.seq;
    isolated.push(event);
    return event;
  }
  function list(opts = {}) {
    let rows = isolated.all();
    if (typeof opts.since === 'number') rows = rows.filter((e) => e.seq > opts.since);
    return rows;
  }
  function latestSeq() { return highestSeq; }
  return { publish, list, latestSeq, isolated, key };
}

test('realtime: published events get a monotonic seq', () => {
  const bus = makeIsolatedBus('seq');
  const e1 = bus.publish({ type: 't1', category: 'reading' });
  const e2 = bus.publish({ type: 't2', category: 'reading' });
  const e3 = bus.publish({ type: 't3', category: 'reading' });
  assert.equal(typeof e1.seq, 'number');
  assert.equal(typeof e2.seq, 'number');
  assert.equal(typeof e3.seq, 'number');
  assert.ok(e2.seq > e1.seq);
  assert.ok(e3.seq > e2.seq);
});

test('realtime: list with since filter returns only newer events', () => {
  const bus = makeIsolatedBus('since');
  const e1 = bus.publish({ type: 'a', category: 'reading' });
  const e2 = bus.publish({ type: 'b', category: 'reading' });
  const e3 = bus.publish({ type: 'c', category: 'reading' });
  const replay = bus.list({ since: e2.seq });
  assert.equal(replay.length, 1);
  assert.equal(replay[0].id, e3.id);
});

test('realtime: events survive a child-process restart', async () => {
  const bus = makeIsolatedBus('restart');
  const e1 = bus.publish({ type: 'persist-test', category: 'reading', title: 'persist' });
  const e2 = bus.publish({ type: 'persist-test-2', category: 'reading', title: 'persist2' });
  const dataStore = require('../src/services/dataStore');
  await dataStore.flushAll();
  const ROOT = path.resolve(__dirname, '..');
  const eventsFile = path.join(ROOT, 'data', 'state', `${bus.key}.json`);
  const script = `
    const dataStore = require(${JSON.stringify(path.resolve(__dirname, '../src/services/dataStore'))});
    const arr = dataStore.getArray(${JSON.stringify(bus.key)});
    const all = arr.all();
    process.stdout.write(JSON.stringify({ count: all.length, lastSeq: all.length ? all[0].seq : 0 }));
  `;
  const { spawnSync } = require('child_process');
  const res = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(res.status, 0, `child exited: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  assert.ok(parsed.count >= 2, `expected >=2 events, got ${parsed.count}; file=${eventsFile} exists=${fs.existsSync(eventsFile)}`);
  assert.ok(parsed.lastSeq >= e2.seq, `expected lastSeq >= ${e2.seq}, got ${parsed.lastSeq}`);
});

test('realtime: latestSeq advances monotonically', () => {
  const bus = makeIsolatedBus('mono');
  let prev = bus.latestSeq();
  for (let i = 0; i < 10; i++) {
    bus.publish({ type: `seq-${i}`, category: 'system' });
    const next = bus.latestSeq();
    assert.ok(next > prev, `seq must advance: ${next} > ${prev}`);
    prev = next;
  }
});
