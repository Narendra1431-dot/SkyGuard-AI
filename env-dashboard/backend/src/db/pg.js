'use strict';

const { Pool } = require('pg');

let pool = null;
let usePg = false;          // true when PostgreSQL is configured AND enabled
let ready = false;          // true when the pool last verified connectivity
let recoveredCallbacks = [];
let lastAttemptAt = 0;
const MIN_PING_INTERVAL_MS = 200;

function markReady() {
  if (ready) return;
  ready = true;
  const cbs = recoveredCallbacks;
  recoveredCallbacks = [];
  for (const cb of cbs) {
    try { cb(); } catch (_) {}
  }
}

function init(cfg) {
  usePg = false;
  ready = false;
  lastAttemptAt = 0;
  if (pool) { try { pool.end().catch(() => {}); } catch (_) {} }
  pool = null;
  if (!cfg || !cfg.enabled) return;
  pool = new Pool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // The pool bounds connection attempts to `max` clients at a time, and ping()
  // throttles retries while PostgreSQL is known to be down, so an outage cannot
  // turn into an unbounded reconnect storm.
  pool.on('error', (e) => {
    ready = false;
    // Routine connection-termination notices during a server restart.
    if (e.code !== '57P01' && e.code !== '57P02') console.error('pg pool error', e.message);
  });
  pool.on('connect', markReady);
  usePg = true;
}

async function query(text, params) {
  if (!usePg) throw new Error('PostgreSQL is not enabled');
  return pool.query(text, params);
}

async function ping() {
  if (!usePg || !pool) return false;
  // While PostgreSQL is known to be down, throttle actual connection attempts
  // so health polls cannot hammer the pool during an outage.
  const now = Date.now();
  if (!ready && now - lastAttemptAt < MIN_PING_INTERVAL_MS) return false;
  lastAttemptAt = now;
  try {
    const r = await pool.query('SELECT 1 AS ok');
    markReady();
    return r.rows[0].ok === 1;
  } catch (e) {
    ready = false;
    return false;
  }
}

function isEnabled() { return usePg; }

// PostgreSQL is "configured" when the server was started with PG_ENABLED=true,
// even if it is currently unreachable. This lets the architecture view report
// an outage as RED instead of silently showing GRAY.
function isConfigured() { return usePg; }

function onRecovered(cb) {
  if (typeof cb !== 'function') return;
  recoveredCallbacks.push(cb);
}

function disable() {
  usePg = false;
  ready = false;
  recoveredCallbacks = [];
  if (pool) { try { pool.end().catch(() => {}); } catch (_) {} }
  pool = null;
}

async function close() {
  if (pool) await pool.end();
}

module.exports = { init, query, ping, isEnabled, isConfigured, onRecovered, disable, close };