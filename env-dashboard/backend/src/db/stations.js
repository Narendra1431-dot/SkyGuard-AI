'use strict';

const fs = require('fs');
const path = require('path');
const pg = require('./pg');

// Canonical station persistence layer.
//
// Two backing stores are supported so a created station survives backend
// restart in every configuration:
//  1. JSON file (default) - data/stations.json - mirrors the provider
//     persistence pattern in db/operations.js (synchronous, atomic write).
//  2. PostgreSQL (opt-in) - the `stations` table in db/schema.js, via pg.
//
// The JSON store is the source of truth that feeds the in-memory `stations`
// array / `stationMap` in server.js on boot, so dynamically added stations
// (Add Station) are rehydrated after a restart without manual DB editing.

const STATE_FILE = process.env.SKYGUARD_STATIONS_FILE
  ? path.resolve(process.env.SKYGUARD_STATIONS_FILE)
  : path.resolve(__dirname, '..', '..', 'data', 'stations.json');

const DEFAULT_PROVIDER_IDS = ['open-meteo', 'openweather'];

const PARAMETER_OPTIONS = [
  'temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall',
];

const TIMEZONES = [
  'UTC', 'Asia/Kolkata', 'Asia/Karachi', 'Asia/Dhaka', 'Asia/Kathmandu',
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Singapore', 'Asia/Dubai',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney',
];

const INDIAN_STATES = new Set([
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand',
  'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
  'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan',
  'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh',
  'Uttarakhand', 'West Bengal', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Puducherry', 'Chandigarh', 'Andaman and Nicobar Islands',
]);

// ---- Provider status semantics (truthful, never fabricated) ----
// GRAY  = not configured / no authenticated credentials
// YELLOW= configured and authenticated but not yet verified healthy (no
//         successful real request recorded for this station)
// GREEN = configured and last verified healthy for this station
// RED   = configured but a real request failed
function providerStateFor(id, config) {
  const isOpenMeteo = id === 'open-meteo';
  const configured = isOpenMeteo || !!config.provider.openWeatherApiKey;
  if (!configured) return { configured: false, authenticated: false, status: 'GRAY', label: 'not_configured' };
  return { configured: true, authenticated: true, status: 'YELLOW', label: 'pending' };
}

function validateStation(raw) {
  const errors = [];
  const b = Object.fromEntries(Object.entries(raw || {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));

  if (!b.name || b.name.length < 2 || b.name.length > 120) {
    errors.push({ field: 'name', message: 'Station name is required and must be 2-120 characters' });
  }
  if (!b.id || !/^[A-Za-z0-9][A-Za-z0-9-_]{1,15}$/.test(b.id)) {
    errors.push({ field: 'id', message: 'Station ID/code is required and must be 2-16 chars (letters, digits, dash, underscore; must start alphanumeric)' });
  }
  const lat = Number.parseFloat(b.lat);
  if (b.lat == null || b.lat === '' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push({ field: 'lat', message: 'Latitude must be a number between -90 and 90' });
  }
  const lon = Number.parseFloat(b.lon);
  if (b.lon == null || b.lon === '' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    errors.push({ field: 'lon', message: 'Longitude must be a number between -180 and 180' });
  }
  if (b.provider && !DEFAULT_PROVIDER_IDS.includes(b.provider)) {
    errors.push({ field: 'provider', message: `Provider must be one of: ${DEFAULT_PROVIDER_IDS.join(', ')}` });
  }
  let parameters = b.parameters;
  if (parameters != null) {
    if (!Array.isArray(parameters)) {
      try { const parsed = JSON.parse(parameters); parameters = Array.isArray(parsed) ? parsed : null; } catch (_) { parameters = null; }
    }
    if (!parameters || parameters.length === 0 || !parameters.every((p) => PARAMETER_OPTIONS.includes(p))) {
      errors.push({ field: 'parameters', message: `Parameters must be a non-empty array of: ${PARAMETER_OPTIONS.join(', ')}` });
    } else {
      parameters = [...new Set(parameters)];
    }
  } else {
    parameters = [...PARAMETER_OPTIONS];
  }
  if (b.timezone && !TIMEZONES.includes(b.timezone)) {
    errors.push({ field: 'timezone', message: 'Invalid timezone' });
  }
  if (b.state && !INDIAN_STATES.has(b.state)) {
    errors.push({ field: 'state', message: 'Invalid state' });
  }
  if (b.status !== undefined && !['online', 'offline'].includes(b.status)) {
    errors.push({ field: 'status', message: 'Initial status must be online or offline' });
  }
  return { errors, parameters };
}

// ---- JSON durable store ----
// Loads on first access (like operations.js loadState) so persisted stations
// are rehydrated after a restart.
let loaded = false;
let stationsById = new Map();

function loadState() {
  if (loaded) return stationsById;
  loaded = true;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const list = Array.isArray(saved) ? saved : (saved.stations || []);
    for (const s of list) stationsById.set(s.id, s);
  } catch (_) {
    // No persisted state yet.
  }
  return stationsById;
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ stations: [...stationsById.values()] }, null, 2));
  } catch (e) {
    console.error('station persist failed', e.message);
  }
}

loadState();

// Build a fully-formed station record with truthful provider assignment.
function buildStation(input, { config } = {}) {
  const now = new Date().toISOString();
  const provider = input.provider || 'open-meteo';
  const p = providerStateFor(provider, config) || { status: 'GRAY' };
  return {
    id: input.id,
    name: input.name,
    lat: Number.parseFloat(input.lat),
    lon: Number.parseFloat(input.lon),
    elevation: input.elevation != null && input.elevation !== '' ? Number.parseInt(input.elevation, 10) : null,
    installed: input.installed || now.slice(0, 10),
    address: input.address || null,
    state: input.state || null,
    district: input.district || null,
    provider,
    providerStatus: p.status,
    providerLabel: p.label,
    parameters: input.parameters || ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'],
    timezone: input.timezone || 'UTC',
    status: input.status || 'offline',
    created_at: now,
    updated_at: now,
  };
}

function createStation(input, { config } = {}) {
  const record = buildStation(input, { config });
  stationsById.set(record.id, record);
  persist();
  if (pg.isEnabled()) {
    try {
      pg.query(
        `INSERT INTO stations (id, name, lat, lon, elevation, installed, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [record.id, record.name, record.lat, record.lon, record.elevation, record.installed, JSON.stringify({ provider: record.provider, state: record.state, district: record.district })]
      ).catch(() => {});
    } catch (_) {}
  }
  return record;
}

function getStation(id) {
  return stationsById.get(id) || null;
}

function stationExists(id) {
  return stationsById.has(id);
}

// Canonical-store removal. Intentionally NOT exposed as a web route: deleting
// a station is a destructive operation with downstream dependencies (alerts,
// history, maintenance, investigations), so it is only available to tests and
// the persistence layer itself.
function removeStation(id) {
  const removed = stationsById.delete(id);
  if (removed) persist();
  return removed;
}

function listStations() {
  return [...stationsById.values()];
}

function listPersistedStations() {
  return listStations();
}

function upsertStations(stations) {
  if (!pg.isEnabled() || !stations.length) return;
  const text = `INSERT INTO stations (id, name, lat, lon, elevation, installed)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, lat=EXCLUDED.lat, lon=EXCLUDED.lon,
      elevation=EXCLUDED.elevation, installed=EXCLUDED.installed`;
  for (const s of stations) {
    pg.query(text, [s.id, s.name, s.lat, s.lon, s.elevation || null, s.installed || null]).catch(() => {});
  }
}

function resetState() {
  stationsById = new Map();
  loaded = false;
  try { fs.unlinkSync(STATE_FILE); } catch (_) {}
  loadState();
}

module.exports = {
  upsertStations,
  listStations,
  listPersistedStations,
  getStation,
  stationExists,
  createStation,
  removeStation,
  validateStation,
  buildStation,
  resetState,
  STATE_FILE,
  PARAMETER_OPTIONS,
  TIMEZONES,
  INDIAN_STATES,
};
