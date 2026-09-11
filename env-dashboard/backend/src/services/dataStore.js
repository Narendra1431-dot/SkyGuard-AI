'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = process.env.SKYGUARD_STATE_DIR
  ? path.resolve(process.env.SKYGUARD_STATE_DIR)
  : path.resolve(__dirname, '..', '..', 'data', 'state');
try { fs.mkdirSync(ROOT, { recursive: true }); } catch (_) {}

function fileFor(name) {
  return path.join(ROOT, `${name}.json`);
}

function quarantine(path) {
  try {
    fs.renameSync(path, `${path}.corrupt-${Date.now()}`);
    return true;
  } catch (_) {
    return false;
  }
}

function load(name) {
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  let raw = null;
  let mainExists = false;
  try {
    raw = fs.readFileSync(file, 'utf8');
    mainExists = true;
  } catch (_) {
    raw = null;
  }
  if (raw != null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return parsed;
      return null;
    } catch (_) {
      // Main file failed to parse. Try the pending .tmp snapshot: it may hold a
      // complete document from an interrupted atomic rename.
      let tmpRaw = null;
      try { tmpRaw = fs.readFileSync(tmp, 'utf8'); } catch (_) { tmpRaw = null; }
      if (tmpRaw != null) {
        try {
          const parsed = JSON.parse(tmpRaw);
          if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) {
            quarantine(file);
            try { fs.renameSync(tmp, file); } catch (_) {}
            return parsed;
          }
        } catch (_) { /* tmp file is corrupt too */ }
      }
    }
  }
  // Quarantine a non-empty corrupt file so the damage is visible and never
  // silently treated as "no data". Empty/whitespace files stay untouched.
  if (mainExists && raw != null && raw.trim().length > 0) {
    quarantine(file);
  } else if (mainExists && raw != null && raw.trim().length === 0) {
    try { fs.unlinkSync(file); } catch (_) {}
  }
  return null;
}

const _writeQueue = Promise.resolve();
let _flushPending = false;
const _flushCallbacks = [];

function enqueueWrite(fn) {
  return _writeQueue.then(fn);
}

function save(name, payload) {
  const file = fileFor(name);
  const tmp = `${file}.tmp`;
  return enqueueWrite(async () => {
    try {
      const data = JSON.stringify(payload, null, 2);
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, file);
    } catch (e) {
      try { await fs.promises.unlink(tmp); } catch (_) {}
    }
  });
}

async function flushAll() {
  const collectionsSnapshot = [...collections.entries()];
  await Promise.all(
    collectionsSnapshot.map(([, col]) => col._flush())
  );
}

function onFlush(callback) {
  _flushCallbacks.push(callback);
}

class Collection {
  constructor(name) {
    this.name = name;
    this._dirty = false;
    this._flushTimer = null;
    this._pendingWrite = null;
    const loaded = load(name);
    if (loaded) {
      this.data = loaded;
    } else {
      this.data = name.endsWith('s') ? [] : {};
    }
  }

  _markDirty() {
    this._dirty = true;
    if (this._flushTimer) clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      this._schedulePersist();
    }, 500);
  }

  _schedulePersist() {
    if (this._pendingWrite) return;
    this._pendingWrite = save(this.name, this.data).finally(() => {
      this._pendingWrite = null;
      this._dirty = false;
    });
  }

  _flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pendingWrite) {
      return this._pendingWrite.then(() => {
        this._dirty = false;
      });
    }
    if (!this._dirty) return Promise.resolve();
    this._pendingWrite = save(this.name, this.data).finally(() => {
      this._pendingWrite = null;
      this._dirty = false;
    });
    return this._pendingWrite;
  }

  persist() {
    this._markDirty();
  }

  all() {
    if (Array.isArray(this.data)) return [...this.data];
    return { ...this.data };
  }
}

class ArrayCollection extends Collection {
  constructor(name) { super(name); this.data = Array.isArray(this.data) ? this.data : []; }
  upsert(record) {
    const idx = this.data.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.data[idx] = { ...this.data[idx], ...record };
    else this.data.unshift(record);
    this.persist();
    return record;
  }
  push(record) {
    this.data.unshift(record);
    this.persist();
    return record;
  }
  get(id) { return this.data.find((r) => r.id === id) || null; }
  filter(fn) { return this.data.filter(fn); }
  remove(id) {
    const idx = this.data.findIndex((r) => r.id === id);
    if (idx >= 0) { this.data.splice(idx, 1); this.persist(); return true; }
    return false;
  }
  size() { return this.data.length; }
}

class MapCollection extends Collection {
  constructor(name) { super(name); this.data = (this.data && typeof this.data === 'object' && !Array.isArray(this.data)) ? this.data : {}; }
  get(key) { return this.data[key] || null; }
  set(key, value) {
    this.data[key] = value;
    this.persist();
    if (process.env.SKYGUARD_DEBUG_MAPSET) {
      const f = path.join(ROOT, `${this.name}.json`);
      if (fs.existsSync(f)) {
        const c = fs.readFileSync(f, 'utf8');
        console.log('[debug mapset]', this.name, 'key=', key, 'fileSize=', c.length, 'hasKeyInFile=', c.includes(JSON.stringify(key)));
      } else {
        console.log('[debug mapset]', this.name, 'key=', key, 'file does not exist after set');
      }
    }
    return value;
  }
  has(key) { return Object.prototype.hasOwnProperty.call(this.data, key); }
  delete(key) { delete this.data[key]; this.persist(); }
  keys() { return Object.keys(this.data); }
  size() { return Object.keys(this.data).length; }
}

const collections = new Map();

function getArray(name) {
  if (!collections.has(name)) collections.set(name, new ArrayCollection(name));
  return collections.get(name);
}

function getMap(name) {
  if (!collections.has(name)) collections.set(name, new MapCollection(name));
  return collections.get(name);
}

function reset() {
  for (const f of fs.readdirSync(ROOT)) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch (_) {}
  }
  collections.clear();
}

function resetScoped(name) {
  const file = fileFor(name);
  try { fs.unlinkSync(file); } catch (_) {}
  collections.delete(name);
}

let _shutdownHandlersRegistered = false;

function registerShutdownHandlers() {
  if (_shutdownHandlersRegistered) return;
  _shutdownHandlersRegistered = true;

  const shutdown = async (signal) => {
    console.log(`[dataStore] Received ${signal}, flushing all pending writes...`);
    try {
      await flushAll();
      console.log('[dataStore] Flush complete, invoking callbacks...');
      for (const cb of _flushCallbacks) {
        try { cb(); } catch (_) {}
      }
      console.log('[dataStore] Shutdown flush complete');
    } catch (e) {
      console.error('[dataStore] Flush error during shutdown:', e.message);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

registerShutdownHandlers();

module.exports = { getArray, getMap, load, save, reset, resetScoped, ROOT, flushAll, onFlush };