'use strict';

/**
 * Real-Time Event Bus
 *
 * Central, structured event model. Each event has a normalized shape:
 *   { id, type, category, severity, stationId, station, title, summary, evidence, payload, timestamp, seq }
 *
 * Events are persisted to `data/state/events.json` (bounded by MAX_EVENTS) so
 * that reconnects and the historical feed survive restart.
 */

const { randomUUID } = require('crypto');
const dataStore = require('./dataStore');

const MAX_EVENTS = 500;
const events = dataStore.getArray('events');
let counter = events.size() || 0;
let highestSeq = 0;
for (const e of events.all()) if (typeof e.seq === 'number' && e.seq > highestSeq) highestSeq = e.seq;

let _io = null;
function setIO(io) { _io = io; }

function publish({ type, category = 'system', severity = 'info', stationId = null, station = null, title = '', summary = '', evidence = [], payload = null }) {
  counter += 1;
  const event = {
    id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
    seq: highestSeq + 1,
    type,
    category,
    severity,
    stationId,
    station,
    title,
    summary,
    evidence,
    payload,
    timestamp: new Date().toISOString(),
  };
  highestSeq = event.seq;
  events.push(event);
  if (_io) {
    try { _io.emit('timeline:new', event); } catch (_) {}
  }
  return event;
}

function get(id) {
  if (!id) return null;
  return events.all().find((e) => e.id === id) || null;
}

function normalizeSeverity(s) {
  return String(s || '').toLowerCase();
}

function matchesSearch(e, q) {
  if (!q) return true;
  const lower = q.toLowerCase();
  if (e.title && e.title.toLowerCase().includes(lower)) return true;
  if (e.summary && e.summary.toLowerCase().includes(lower)) return true;
  if (e.type && e.type.toLowerCase().includes(lower)) return true;
  if (e.station && e.station.toLowerCase().includes(lower)) return true;
  if (e.stationId && e.stationId.toLowerCase().includes(lower)) return true;
  return false;
}

function list({ limit = 200, offset = 0, category, severity, stationId, type, since, search, after, before, sort } = {}) {
  let rows = events.all();
  if (category) rows = rows.filter((e) => e.category === category);
  if (severity) {
    const target = normalizeSeverity(severity);
    rows = rows.filter((e) => normalizeSeverity(e.severity) === target);
  }
  if (stationId) rows = rows.filter((e) => e.stationId === stationId);
  if (type) rows = rows.filter((e) => e.type === type);
  if (typeof since === 'number') rows = rows.filter((e) => e.seq > since);
  if (search) rows = rows.filter((e) => matchesSearch(e, search));
  if (after) {
    const afterTs = new Date(after).getTime();
    if (!Number.isNaN(afterTs)) rows = rows.filter((e) => new Date(e.timestamp).getTime() >= afterTs);
  }
  if (before) {
    const beforeTs = new Date(before).getTime();
    if (!Number.isNaN(beforeTs)) rows = rows.filter((e) => new Date(e.timestamp).getTime() <= beforeTs);
  }
  if (sort === 'asc') {
    rows = rows.slice().sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  } else {
    rows = rows.slice().sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  }
  const total = rows.length;
  const safeOffset = Math.max(0, Math.min(offset, total));
  const page = rows.slice(safeOffset, safeOffset + Math.min(limit, MAX_EVENTS));
  return { items: page, total, offset: safeOffset, limit: Math.min(limit, MAX_EVENTS) };
}

function categories() {
  const set = new Set();
  for (const e of events.all()) set.add(e.category);
  return [...set].sort();
}

function types() {
  const set = new Set();
  for (const e of events.all()) set.add(e.type);
  return [...set].sort();
}

function stationIds() {
  const set = new Set();
  for (const e of events.all()) { if (e.stationId) set.add(e.stationId); }
  return [...set].sort();
}

function clear() { /* not exposed in production */ }

function latestSeq() { return highestSeq; }

function count() { return events.size(); }

module.exports = { publish, list, get, clear, latestSeq, count, categories, types, stationIds, MAX_EVENTS, normalizeSeverity, setIO };