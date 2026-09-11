'use strict';

/**
 * Lightweight forecasting service.
 *
 * Uses linear-regression over the recent window to project forward.
 * Reports confidence as the residual/error of the regression.
 * Includes threshold crossing detection.
 */

const { THRESHOLDS } = require('../ai');

const FIELDS = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'];

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i += 1) {
    sx += i; sy += points[i]; sxy += i * points[i]; sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  let ssRes = 0;
  for (let i = 0; i < n; i += 1) {
    const yhat = slope * i + intercept;
    ssRes += (points[i] - yhat) ** 2;
  }
  const rmse = Math.sqrt(ssRes / n);
  return { slope, intercept, rmse };
}

function forecastField(points, field, minutes = 30) {
  // Points: array of { t: ISO, v: number }
  const filtered = points.filter((p) => p.v != null && !Number.isNaN(p.v));
  if (filtered.length < 4) return null;
  const last = filtered[filtered.length - 1];
  const regression = linearRegression(filtered.map((p) => p.v));
  if (!regression) return null;
  const n = filtered.length;
  const lastTs = new Date(last.t).getTime();
  const horizon = Math.min(minutes, 240); // max 4 hours ahead
  const series = [];
  const stepMs = 60_000;
  const samplesPerMin = (filtered.length) / Math.max(1, (lastTs - new Date(filtered[0].t).getTime()) / 60_000);
  const horizonSamples = horizon * samplesPerMin;
  for (let i = 1; i <= horizon; i += 1) {
    const projIdx = n + i * samplesPerMin;
    const yhat = regression.intercept + regression.slope * projIdx;
    const t = new Date(lastTs + i * stepMs).toISOString();
    series.push({ t, v: +yhat.toFixed(2) });
  }
  // Threshold crossing detection
  const thresholds = THRESHOLDS[field] || {};
  let crossing = null;
  if (typeof thresholds.warning === 'number' || typeof thresholds.danger === 'number') {
    for (let i = 1; i < series.length; i += 1) {
      const prev = filtered[filtered.length - 1].v;
      const cur = series[i].v;
      if (typeof thresholds.danger === 'number' && ((prev <= thresholds.danger && cur > thresholds.danger) || (prev >= thresholds.danger && cur < thresholds.danger))) {
        crossing = { at: series[i].t, threshold: thresholds.danger, direction: cur > prev ? 'up' : 'down' };
        break;
      }
      if (typeof thresholds.warning === 'number' && ((prev <= thresholds.warning && cur > thresholds.warning) || (prev >= thresholds.warning && cur < thresholds.warning))) {
        crossing = crossing || { at: series[i].t, threshold: thresholds.warning, direction: cur > prev ? 'up' : 'down' };
      }
    }
  }
  // Confidence: higher when RMSE is small relative to variance
  const mean = filtered.reduce((s, p) => s + p.v, 0) / filtered.length;
  const variance = filtered.reduce((s, p) => s + (p.v - mean) ** 2, 0) / filtered.length;
  const confidence = variance > 0 ? Math.max(0, Math.min(0.99, 1 - regression.rmse / Math.sqrt(variance + 1e-6))) : 0.5;
  return {
    field,
    model: 'linear-regression',
    samples: filtered.length,
    rmse: +regression.rmse.toFixed(3),
    confidence: +confidence.toFixed(2),
    horizonMinutes: horizon,
    forecast: series,
    thresholdCrossing: crossing,
    lastValue: last.v,
  };
}

function forecastAll(history, minutes = 30) {
  const out = {};
  for (const f of FIELDS) {
    const points = history.map((r) => ({ t: r.time, v: r[f] }));
    const fc = forecastField(points, f, minutes);
    if (fc) out[f] = fc;
  }
  return out;
}

module.exports = { forecastField, forecastAll, FIELDS };