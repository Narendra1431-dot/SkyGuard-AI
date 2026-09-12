'use strict';

const pg = require('./db/pg');

class PostgresStore {
  constructor() {
    this.alerts = [];
    this.maintenanceHistory = [];
  }

  async ping() {
    return pg.isEnabled() && pg.ping();
  }

  async writeReading(r) {
    if (!pg.isEnabled()) return false;
    try {
      await pg.query(
        `INSERT INTO readings (time, station_id, temperature, pressure, humidity, aqi, wind, rainfall, anomaly)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT DO NOTHING`,
        [r.time, r.stationId, r.temperature, r.pressure, r.humidity, r.aqi, r.wind, r.rainfall, r.anomaly]
      );
      return true;
    } catch (e) {
      console.error('[pg-store] writeReading failed:', e.message);
      return false;
    }
  }

  async recentReadings(minutes = 60) {
    if (!pg.isEnabled()) return [];
    try {
      const r = await pg.query(
        `SELECT time, station_id AS "stationId", temperature, pressure, humidity, aqi, wind, rainfall, anomaly
         FROM readings
         WHERE time >= now() - interval '${minutes} minutes'
         ORDER BY time DESC`
      );
      return r.rows.map((row) => ({
        time: row.time,
        stationId: row.stationId,
        temperature: row.temperature,
        pressure: row.pressure,
        humidity: row.humidity,
        aqi: row.aqi,
        wind: row.wind,
        rainfall: row.rainfall,
        anomaly: row.anomaly,
      }));
    } catch (e) {
      console.error('[pg-store] recentReadings failed:', e.message);
      return [];
    }
  }

  async latestPerStation() {
    if (!pg.isEnabled()) return [];
    try {
      const r = await pg.query(
        `SELECT DISTINCT ON (station_id) time, station_id AS "stationId", temperature, pressure, humidity, aqi, wind, rainfall, anomaly
         FROM readings
         ORDER BY station_id, time DESC`
      );
      return r.rows.map((row) => ({
        time: row.time,
        stationId: row.stationId,
        temperature: row.temperature,
        pressure: row.pressure,
        humidity: row.humidity,
        aqi: row.aqi,
        wind: row.wind,
        rainfall: row.rainfall,
        anomaly: row.anomaly,
      }));
    } catch (e) {
      console.error('[pg-store] latestPerStation failed:', e.message);
      return [];
    }
  }

  async anomalyCountToday() {
    if (!pg.isEnabled()) return 0;
    try {
      const r = await pg.query(
        `SELECT COUNT(*)::int AS count
         FROM readings
         WHERE anomaly = 1 AND time >= date_trunc('day', now())`
      );
      return r.rows[0]?.count || 0;
    } catch (e) {
      console.error('[pg-store] anomalyCountToday failed:', e.message);
      return 0;
    }
  }

  async readingsPerMinute() {
    if (!pg.isEnabled()) return 0;
    try {
      const r = await pg.query(
        `SELECT COUNT(*)::int AS count
         FROM readings
         WHERE time >= now() - interval '5 minutes'`
      );
      return Math.round((r.rows[0]?.count || 0) / 5);
    } catch (e) {
      console.error('[pg-store] readingsPerMinute failed:', e.message);
      return 0;
    }
  }

  async history(stationId, field, minutes = 30) {
    if (!pg.isEnabled()) return [];
    try {
      const r = await pg.query(
        `SELECT time, ${field}
         FROM readings
         WHERE station_id = $1 AND time >= now() - interval '${minutes} minutes'
         ORDER BY time ASC`,
        [stationId]
      );
      return r.rows.map((row) => ({ t: row.time, v: row[field] }));
    } catch (e) {
      console.error('[pg-store] history failed:', e.message);
      return [];
    }
  }

  pushAlert(a) {
    this.alerts.unshift(a);
    if (this.alerts.length > 200) this.alerts.length = 200;
  }

  getAlerts() { return this.alerts; }

  pushMaintenance(m) {
    this.maintenanceHistory.unshift(m);
    if (this.maintenanceHistory.length > 100) this.maintenanceHistory.length = 100;
  }

  getMaintenance() { return this.maintenanceHistory; }
}

module.exports = PostgresStore;
