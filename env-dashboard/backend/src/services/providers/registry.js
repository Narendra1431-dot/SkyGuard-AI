'use strict';

const fs = require('fs');
const path = require('path');

const RANGES = {
  temperature: { min: -50, max: 65 },
  pressure: { min: 870, max: 1085 },
  humidity: { min: 0, max: 100 },
  aqi: { min: 0, max: 1000 },
  wind: { min: 0, max: 80 },
  rainfall: { min: 0, max: 500 },
};

function validateValue(field, value) {
  if (value == null || !Number.isFinite(value)) return { ok: false, reason: 'not_numeric' };
  const r = RANGES[field];
  if (!r) return { ok: true };
  if (value < r.min || value > r.max) return { ok: false, reason: 'out_of_range' };
  return { ok: true };
}

function safeIso(input) {
  if (!input) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function freshnessOk(observationIso, nowMs, maxAgeMs) {
  if (!observationIso) return false;
  const t = new Date(observationIso).getTime();
  if (isNaN(t)) return false;
  return nowMs - t <= maxAgeMs;
}

function normalizeBase({ station, observationTime, provider, providerStationId, quality, fallback = false, cacheHit = false, url, extra = {} }) {
  return {
    time: observationTime,
    stationId: station.id,
    temperature: extra.temperature ?? null,
    pressure: extra.pressure ?? null,
    humidity: extra.humidity ?? null,
    aqi: extra.aqi ?? null,
    wind: extra.wind ?? null,
    rainfall: extra.rainfall ?? null,
    anomaly: 0,
    source: {
      provider,
      station: providerStationId || station.id,
      retrievedAt: new Date().toISOString(),
      observationAt: observationTime,
      quality,
      fallback,
      cacheHit,
      url: url ? url.replace(/apiKey=[^&]+/g, 'apiKey=***') : null,
    },
  };
}

class ProviderError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || 'PROVIDER_ERROR';
  }
}

class ProviderCircuit {
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold || 3;
    this.cooldownMs = opts.cooldownMs || 30_000;
    this.state = new Map();
  }
  recordSuccess(id) {
    this.state.set(id, { failures: 0, openedAt: 0 });
  }
  recordFailure(id) {
    const s = this.state.get(id) || { failures: 0, openedAt: 0 };
    s.failures += 1;
    if (s.failures >= this.failureThreshold) s.openedAt = Date.now();
    this.state.set(id, s);
  }
  isOpen(id) {
    const s = this.state.get(id);
    if (!s || !s.openedAt) return false;
    if (Date.now() - s.openedAt > this.cooldownMs) {
      this.state.set(id, { failures: 0, openedAt: 0 });
      return false;
    }
    return true;
  }
  snapshot() {
    return Object.fromEntries([...this.state.entries()].map(([k, v]) => [k, v]));
  }
}

class ProviderRegistry {
  constructor({ timeoutMs = 4000, retry = 1, maxStaleSeconds = 30 * 60, mode = 'open-meteo', circuit } = {}) {
    this.timeoutMs = timeoutMs;
    this.retry = Math.max(0, retry);
    this.maxStaleMs = maxStaleSeconds * 1000;
    this.mode = mode;
    this.circuit = circuit || new ProviderCircuit();
    this.providers = new Map();
    this.cache = new Map();
    this.cacheTtlMs = 30_000;
    this.lastResults = new Map();
    this._computingStation = new Map(); // Track concurrent station requests
  }

  register(provider) {
    this.providers.set(provider.id, provider);
  }

  getProvider(id) {
    return this.providers.get(id) || null;
  }

  list() {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      enabled: p.enabled,
      requiresKey: !!p.requiresKey,
      hasKey: !!p.hasKey,
      status: this.circuit.isOpen(p.id) ? 'CIRCUIT_OPEN' : 'OK',
      lastResult: this.lastResults.get(p.id) || null,
    }));
  }

  health() {
    const out = {};
    for (const p of this.providers.values()) {
      const r = this.lastResults.get(p.id);
      out[p.id] = {
        id: p.id,
        name: p.name,
        enabled: p.enabled,
        configured: p.id === 'open-meteo' || !!p.hasKey,
        status: !p.enabled ? 'DISABLED' : (r?.status || 'IDLE'),
        lastSuccessAt: r?.ok ? r.timestamp : null,
        lastError: r?.ok ? null : (r?.error || null),
        latencyMs: r?.latencyMs ?? null,
        consecutiveFailures: this.circuit.state.get(p.id)?.failures || 0,
        circuitOpen: this.circuit.isOpen(p.id),
      };
    }
    return out;
  }

  setMode(mode) { this.mode = mode; }

  async fetchForStation(station) {
    if (this.mode === 'disabled') {
      return {
        ok: false,
        unavailable: true,
        error: 'providers_disabled',
        observationTime: new Date().toISOString(),
      };
    }
    if (this.mode === 'sim' || this.mode === 'fixture') {
      return this._localSource(station);
    }
    const modeProvider = this.providers.get(this.mode);
    // When in a specific provider mode, only try that provider first
    // Only include fallback providers if the mode provider is not configured
    let ordered;
    if (modeProvider && modeProvider.enabled) {
      ordered = [modeProvider];
    } else {
      // Fallback to all enabled providers sorted by priority
      ordered = [...this.providers.values()]
        .filter((p) => p.enabled && (p.id === 'open-meteo' || p.hasKey))
        .sort((a, b) => a.priority - b.priority);
    }

    if (ordered.length === 0) {
      return {
        ok: false,
        unavailable: true,
        error: 'no_provider_available',
        observationTime: new Date().toISOString(),
      };
    }

    const cacheKey = `${station.id}:${Math.floor(Date.now() / this.cacheTtlMs)}`;
    if (this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey);
      return { ...cached, cached: true };
    }
    
    // If we're already computing for this station, wait for result
    if (this._computingStation.has(station.id)) {
      try {
        const result = await this._computingStation.get(station.id);
        return { ...result, cached: false };
      } catch (err) {
        // Failed computation, cache error and rethrow
        this.cache.set(cacheKey, { ok: false, error: err.message || 'all_providers_failed' });
        throw err;
      }
    }
    
    // Create promise that will resolve with the actual result
    const computePromise = (async () => {
      const cacheKey = `${station.id}:${Math.floor(Date.now() / this.cacheTtlMs)}`;
      let lastError = null;
      
      // Try all providers in parallel, preserving order for error reporting
      const providerPromises = ordered
        .filter(p => !this.circuit.isOpen(p.id))
        .map(async (provider) => {
          try {
            const result = await this._callWithRetry(provider, station);
            this.lastResults.set(provider.id, { ...result, timestamp: new Date().toISOString() });
            if (result.ok) {
              this.circuit.recordSuccess(provider.id);
              this.cache.set(cacheKey, result);
              return { success: true, result, provider };
            }
            this.circuit.recordFailure(provider.id);
            return { success: false, error: result.error, provider };
          } catch (error) {
            return { success: false, error: error.message || 'provider_error', provider };
          }
        });
      
      const results = await Promise.allSettled(providerPromises);
      
      // Check for first successful result in original order
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value?.success) {
          return result.value.result;
        } else if (result.status === 'fulfilled' && !result.value?.success) {
          lastError = result.value;
        }
      }
      
      // All providers failed
      const errorMsg = lastError ? `all_providers_failed: ${lastError.provider}/${lastError.error}` : 'no_provider';
      const failureResult = { 
        ok: false, 
        unavailable: true, 
        error: errorMsg,
        observationTime: new Date().toISOString() 
      };
      
      // Do not cache failures; let circuit breaker track repeated failures
      return failureResult;
    })();
    
    // Store the promise to handle concurrent requests for same station
    this._computingStation.set(station.id, computePromise);
    
    // Add cleanup for completed computations to prevent memory leaks
    computePromise.finally(() => {
      this._computingStation.delete(station.id);
    });
    
    return await computePromise;
  }

  async _callWithRetry(provider, station) {
    let last = null;
    for (let attempt = 0; attempt <= this.retry; attempt++) {
      const r = await this._callOnce(provider, station);
      if (r.ok) return r;
      last = r;
    }
    return last || { ok: false, error: 'unknown' };
  }

  async _callOnce(provider, station) {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const built = provider.buildRequest(station);
      const res = await fetch(built.url, { method: 'GET', headers: built.headers, signal: controller.signal });
      clearTimeout(timer);
      const latencyMs = Date.now() - start;
      if (res.status < 200 || res.status >= 300) {
        return { ok: false, error: `HTTP_${res.status}`, statusCode: res.status, latencyMs };
      }
      let body = null;
      try { body = await res.json(); } catch (_) {
        return { ok: false, error: 'malformed_json', statusCode: res.status, latencyMs };
      }
      const parsed = provider.parse(station, body);
      if (!parsed.ok) return { ok: false, error: parsed.error || 'parse_error', statusCode: res.status, latencyMs };
      const observation = safeIso(parsed.observationTime);
      if (!observation) return { ok: false, error: 'invalid_observation_time', statusCode: res.status, latencyMs };
      if (!freshnessOk(observation, Date.now(), this.maxStaleMs)) {
        return { ok: false, error: 'stale_observation', statusCode: res.status, latencyMs, observationTime: observation };
      }
      const validations = {};
      for (const f of ['temperature', 'pressure', 'humidity', 'wind', 'rainfall']) {
        const v = validateValue(f, parsed.fields[f]);
        if (!v.ok) return { ok: false, error: `invalid_${f}_${v.reason}`, statusCode: res.status, latencyMs };
        validations[f] = v;
      }
      return {
        ok: true,
        provider: provider.id,
        station: station.id,
        observationTime: observation,
        fields: parsed.fields,
        raw: parsed.raw || null,
        statusCode: res.status,
        latencyMs,
        url: built.url,
      };
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - start };
    }
  }

  _localSource(station) {
    if (this.mode === 'fixture') {
      const path_ = path.resolve(__dirname, '../../../data/fixtures/weather.json');
      try {
        const raw = JSON.parse(fs.readFileSync(path_, 'utf8'));
        const entry = (raw.stations || []).find((s) => s.id === station.id) || (raw.stations || [])[0];
        if (!entry) return { ok: false, unavailable: true, error: 'no_fixture_for_station' };
        return {
          ok: true,
          provider: 'fixture',
          station: station.id,
          observationTime: entry.observationTime || new Date().toISOString(),
          fields: entry.fields,
          url: 'file://data/fixtures/weather.json',
          provenance: { source: 'fixture' },
        };
      } catch (e) {
        return { ok: false, unavailable: true, error: 'fixture_missing' };
      }
    }
    return { ok: false, unavailable: true, error: 'sim_disabled_in_production' };
  }
}

module.exports = {
  ProviderRegistry,
  ProviderCircuit,
  ProviderError,
  validateValue,
  freshnessOk,
  safeIso,
  normalizeBase,
  RANGES,
};