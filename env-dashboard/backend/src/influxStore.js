'use strict';

const { InfluxDB, Point } = require('@influxdata/influxdb-client');

class InfluxStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.alerts = [];
    this.maintenanceHistory = [];
    this.client = new InfluxDB({ url: cfg.url, token: cfg.token });
    this.writeApi = this.client.getWriteApi(cfg.org, cfg.bucket, 'ms', {
      batchSize: 200,
      flushInterval: 1000,
    });
    this.queryApi = this.client.getQueryApi(cfg.org);
  }

  async ping() {
    try {
      const r = await fetch(`${this.cfg.url}/health`);
      return r.ok;
    } catch {
      return false;
    }
  }

async writeReading(r) {
    const p = new Point('reading')
      .tag('stationId', r.stationId);
    if (r.source && r.source.provider) p.tag('provider', String(r.source.provider));
    const setField = (name, value, int = false) => {
      if (value === null || value === undefined || value === '') return;
      const num = Number(value);
      if (!Number.isFinite(num)) return;
      if (int) p.intField(name, num);
      else p.floatField(name, num);
    };
    setField('temperature', r.temperature);
    setField('pressure', r.pressure);
    setField('humidity', r.humidity);
    setField('aqi', r.aqi);
    setField('wind', r.wind);
    setField('rainfall', r.rainfall);
    setField('anomaly', r.anomaly, true);
    p.timestamp(new Date(r.time));
    this.writeApi.writePoint(p);
    try { await this.writeApi.flush(); } catch (_) { /* continue; flush is best-effort */ }
  }

  async query(flux) {
    const rows = [];
    return new Promise((resolve, reject) => {
      this.queryApi.queryRows(flux, {
        next(row, tableMeta) {
          const o = tableMeta.toObject(row);
          rows.push(o);
        },
        error: reject,
        complete: () => resolve(rows),
      });
    });
  }

  // ------- High-level helpers -------
  async recentReadings(minutes = 60) {
    const flux = `
      from(bucket: "${this.cfg.bucket}")
        |> range(start: -${minutes}m)
        |> filter(fn: (r) => r._measurement == "reading")
        |> pivot(rowKey: ["_time", "stationId"], columnKey: ["_field"], valueColumn: "_value")
    `;
    const rows = await this.query(flux);
    return rows.map((r) => ({
      time: r._time,
      stationId: r.stationId,
      temperature: +r.temperature,
      pressure: +r.pressure,
      humidity: +r.humidity,
      aqi: r.aqi != null && r.aqi >= 0 ? r.aqi : null,
      wind: r.wind,
      rainfall: r.rainfall,
      anomaly: r.anomaly,
      source: r.provider ? { provider: String(r.provider), quality: 'ok' } : null,
    }));
  }

  async latestPerStation() {
    const rows = await this.recentReadings(24 * 60);
    const byStation = new Map();
    for (const r of rows) {
      const prev = byStation.get(r.stationId);
      if (!prev || new Date(r.time).getTime() > new Date(prev.time).getTime()) byStation.set(r.stationId, r);
    }
    return [...byStation.values()];
  }

  async anomalyCountToday() {
    const flux = `
      from(bucket: "${this.cfg.bucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r._measurement == "reading" and r._field == "anomaly")
        |> sum()
    `;
    const rows = await this.query(flux);
    const total = rows.reduce((acc, r) => acc + (r._value || 0), 0);
    return Math.round(total);
  }

  async readingsPerMinute() {
    // Total readings / minutes-in-range (for the last 5m window)
    const flux = `
      from(bucket: "${this.cfg.bucket}")
        |> range(start: -5m)
        |> filter(fn: (r) => r._measurement == "reading" and r._field == "temperature")
        |> count()
    `;
    const rows = await this.query(flux);
    const total = rows.reduce((a, r) => a + (r._value || 0), 0);
    return Math.round(total / 5);
  }

  async history(stationId, field, minutes = 30) {
    const flux = `
      from(bucket: "${this.cfg.bucket}")
        |> range(start: -${minutes}m)
        |> filter(fn: (r) => r._measurement == "reading" and r._field == "${field}")
        |> filter(fn: (r) => r.stationId == "${stationId}")
        |> keep(columns: ["_time", "_value"])
    `;
    const rows = await this.query(flux);
    return rows.map((r) => ({ t: r._time, v: r._value }));
  }

  pushAlert(a) {
    this.alerts.unshift(a);
    if (this.alerts.length > 200) this.alerts.length = 200;
  }

  getAlerts() { return this.alerts; }

  close() {
    try { this.writeApi.close(); } catch (_) {}
  }
}

module.exports = InfluxStore;