'use strict';

const AIR_POLLUTION_URL = 'https://api.openweathermap.org/data/2.5/air_pollution';

class OpenWeatherProvider {
  constructor({ apiKey = null } = {}) {
    this.id = 'openweather';
    this.name = 'OpenWeather';
    this.enabled = true;
    this.requiresKey = true;
    this.hasKey = false;
    this.apiKey = apiKey;
    this.priority = 2;
    this.baseUrl = 'https://api.openweathermap.org/data/2.5/weather';
    this.airPollutionUrl = AIR_POLLUTION_URL;
    this._aqiCache = new Map();
    this._aqiCacheTtlMs = 60_000;
    if (apiKey) {
      this.hasKey = true;
      this.enabled = true;
    }
  }

  setApiKey(key) {
    this.apiKey = key || null;
    this.hasKey = !!key;
    this.enabled = this.hasKey;
  }

  buildRequest(station) {
    if (!this.apiKey) throw new Error('OpenWeather apiKey not configured');
    const url = `${this.baseUrl}?lat=${encodeURIComponent(station.lat)}&lon=${encodeURIComponent(station.lon)}&appid=${encodeURIComponent(this.apiKey)}&units=metric&exclude=minutely,hourly,daily,alerts`;
    return { url, headers: { 'User-Agent': 'SkyGuard-AI/1.0', 'Accept': 'application/json' } };
  }

  async fetchAirQuality(station) {
    if (!this.apiKey) return null;
    const cacheKey = `${station.lat},${station.lon}`;
    const cached = this._aqiCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._aqiCacheTtlMs) return cached.value;
    const url = `${this.airPollutionUrl}?lat=${encodeURIComponent(station.lat)}&lon=${encodeURIComponent(station.lon)}&appid=${encodeURIComponent(this.apiKey)}`;
    let aqi = null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        // CORRECTED: Use the actual AQI response structure - list[0].main.aqi
        // This is the Air Pollution API response, not the standard weather endpoint
        aqi = (data?.list?.[0]?.main?.aqi != null) ? Number(data.list[0].main.aqi) : null;
      }
    } catch (_) {}
    this._aqiCache.set(cacheKey, { value: aqi, ts: Date.now() });
    return aqi;
  }

  async fetchAirPollution(station) {
    return this.fetchAirQuality(station);
  }

  parse(station, body) {
    if (!body || !body.main) return { ok: false, error: 'no_main_block' };
    const t = Number(body.main.temp);
    const p = Number(body.main.pressure);
    const h = Number(body.main.humidity);
    const w = body.wind ? Number(body.wind.speed) : 0;
    const r = body.rain && body.rain['1h'] != null ? Number(body.rain['1h']) : 0;
    if (![t, p, h, w].every((v) => Number.isFinite(v))) {
      return { ok: false, error: 'missing_numeric_field' };
    }
    return {
      ok: true,
      observationTime: body.dt ? new Date(body.dt * 1000).toISOString() : new Date().toISOString(),
      fields: {
        temperature: +t.toFixed(2),
        pressure: +p.toFixed(2),
        humidity: +h.toFixed(2),
        wind: +w.toFixed(2),
        rainfall: +r.toFixed(2),
        aqi: null,
      },
      raw: { aqi_proxy: null, dt: body.dt },
    };
  }

  parseAirQuality(station, body) {
    // CORRECTED: Use the actual AQI response structure - list[0].main.aqi
    // This is the Air Pollution API response, not the standard weather endpoint
    if (!body || !Array.isArray(body.list) || !body.list[0]) return null;
    const aqi = Number(body.list[0].main.aqi);
    return Number.isFinite(aqi) ? aqi : null;
  }
}

module.exports = OpenWeatherProvider;