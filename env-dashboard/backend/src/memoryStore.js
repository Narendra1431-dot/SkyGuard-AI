'use strict';

const fs = require('fs');
const path = require('path');

/**
 * In-memory fallback store with optional on-disk durability for alerts and
 * maintenance history. Readings stay in a bounded ring buffer; alerts and
 * maintenance entries are mirrored to JSON files so they survive restart.
 */

const STATE_DIR = process.env.SKYGUARD_STATE_DIR
  ? path.resolve(process.env.SKYGUARD_STATE_DIR)
  : path.resolve(__dirname, '..', 'data', 'state');
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, payload) {
  try { fs.writeFileSync(file, JSON.stringify(payload, null, 2)); } catch (_) {}
}

class MemoryStore {
  constructor() {
    this.readings = [];
    this.max = 5000;
    this.alerts = readJson(path.join(STATE_DIR, 'alerts.json'), []);
    this.maintenanceHistory = readJson(path.join(STATE_DIR, 'maintenance.json'), []);
  }

  async ping() { return true; }

  async writeReading(r) {
    this.readings.push(r);
    if (this.readings.length > this.max) this.readings.splice(0, this.readings.length - this.max);
    return true;
  }

  async recentReadings(minutes = 60) {
    const cutoff = Date.now() - minutes * 60_000;
    return this.readings.filter((r) => new Date(r.time).getTime() >= cutoff);
  }

  async latestPerStation() {
    const map = new Map();
    for (const r of [...this.readings].reverse()) {
      if (!map.has(r.stationId)) map.set(r.stationId, r);
    }
    return [...map.values()];
  }

  async anomalyCountToday() {
    const cutoff = Date.now() - 24 * 3600_000;
    return this.readings.filter((r) => new Date(r.time).getTime() >= cutoff && r.anomaly === 1).length;
  }

  async readingsPerMinute() {
    const cutoff = Date.now() - 5 * 60_000;
    const recent = this.readings.filter((r) => new Date(r.time).getTime() >= cutoff);
    return Math.round(recent.length / 5);
  }

  async history(stationId, field, minutes = 30) {
    const cutoff = Date.now() - minutes * 60_000;
    return this.readings
      .filter((r) => r.stationId === stationId && new Date(r.time).getTime() >= cutoff)
      .map((r) => ({ t: r.time, v: r[field] }));
  }

  pushAlert(a) {
    this.alerts.unshift(a);
    if (this.alerts.length > 200) this.alerts.length = 200;
    writeJson(path.join(STATE_DIR, 'alerts.json'), this.alerts);
  }

  getAlerts() { return this.alerts; }

  pushMaintenance(m) {
    this.maintenanceHistory.unshift(m);
    if (this.maintenanceHistory.length > 100) this.maintenanceHistory.length = 100;
    writeJson(path.join(STATE_DIR, 'maintenance.json'), this.maintenanceHistory);
  }

  getMaintenance() { return this.maintenanceHistory; }
}

module.exports = MemoryStore;