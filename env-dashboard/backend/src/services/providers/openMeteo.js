'use strict';

const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

class OpenMeteoProvider {
  constructor() {
    this.id = 'open-meteo';
    this.name = 'Open-Meteo';
    this.enabled = true;
    this.requiresKey = false;
    this.hasKey = true;
    this.priority = 1;
    this.baseUrl = 'https://api.open-meteo.com/v1/forecast';
    this._aqiCache = new Map();
    this._aqiCacheTtlMs = 60_000;
  }

  buildRequest(station) {
    const url = `${this.baseUrl}?latitude=${encodeURIComponent(station.lat)}&longitude=${encodeURIComponent(station.lon)}&current=temperature_2m,relative_humidity_2m,surface_pressure,wind_speed_10m,precipitation&timezone=UTC`;
    return { url, headers: { 'User-Agent': 'SkyGuard-AI/1.0', 'Accept': 'application/json' } };
  }

  parse(station, body) {
    if (!body || !body.current) return { ok: false, error: 'no_current_block' };
    const c = body.current;
    const t = Number(c.temperature_2m);
    const h = Number(c.relative_humidity_2m);
    const p = Number(c.surface_pressure);
    const w = Number(c.wind_speed_10m);
    // Open-Meteo returns `precipitation: null` when no precipitation has been
    // recorded in the current hour. Treat null/missing as 0 rather than
    // rejecting the whole response — this avoids discarding otherwise valid
    // readings during dry periods.
    const r = Number.isFinite(Number(c.precipitation)) ? Number(c.precipitation) : 0;
    if (![t, h, p, w].every((v) => Number.isFinite(v))) {
      return { ok: false, error: 'missing_numeric_field' };
    }

    return {
      ok: true,
      observationTime: c.time ? new Date(c.time.endsWith('Z') || c.time.endsWith('+00:00') ? c.time : c.time + 'Z').toISOString() : new Date().toISOString(),
      fields: {
        temperature: +t.toFixed(2),
        humidity: +h.toFixed(2),
        pressure: +p.toFixed(2),
        wind: +w.toFixed(2),
        rainfall: +r.toFixed(2),
        aqi: null,
      },
      raw: {},
    };
  }

  async fetchAirQuality(station) {
    const cacheKey = `${station.lat},${station.lon}`;
    const cached = this._aqiCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._aqiCacheTtlMs) return cached.value;

    const url = `${AIR_QUALITY_URL}?latitude=${encodeURIComponent(station.lat)}&longitude=${encodeURIComponent(station.lon)}&current=us_aqi&timezone=UTC`;
    let aqi = null;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SkyGuard-AI/1.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const raw = data?.current?.us_aqi;
        if (raw != null) {
          const num = Number(raw);
          if (Number.isFinite(num) && num >= 0 && num <= 500) aqi = num;
        }
      }
    } catch (_) {}
    this._aqiCache.set(cacheKey, { value: aqi, ts: Date.now() });
    return aqi;
  }
}

module.exports = OpenMeteoProvider;
