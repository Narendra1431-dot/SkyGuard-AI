'use strict';

/**
 * Threshold-based "AI" helpers. Pure functions, no external dependencies.
 * Thresholds are loaded from configuration via setThresholds().
 */

let THRESHOLDS = {
  aqi:         { good: 100, warning: 150, danger: 250 },
  temperature: { good: 32,  warning: 38,  danger: 42 },
  humidity:    { good: 60,  warning: 35,  danger: 15, tooHigh: 85 },
  wind:        { good: 6,   warning: 10,  danger: 14 },
  pressure:    { good: [1005, 1020], warningDelta: 8 },
};

function setThresholds(cfg = {}) {
  const out = {
    aqi:         { good: 100, warning: cfg.aqi_warning ?? 150, danger: cfg.aqi_critical ?? 250 },
    temperature: { good: 32,  warning: cfg.temperature_warning ?? 38,  danger: cfg.temperature_critical ?? 42 },
    humidity:    { good: 60,  warning: cfg.humidity_min ?? 35,  danger: cfg.humidity_min ?? 15, tooHigh: cfg.humidity_max ?? 85 },
    wind:        { good: 6,   warning: cfg.wind_warning ?? 10,  danger: cfg.wind_critical ?? 14 },
    pressure:    { good: [cfg.pressure_min ?? 1005, cfg.pressure_max ?? 1020], warningDelta: 8 },
  };
  if (cfg.pressure_min != null || cfg.pressure_max != null) {
    out.pressure.good = [cfg.pressure_min ?? 1005, cfg.pressure_max ?? 1020];
  }
  THRESHOLDS = out;
}

function getThresholds() {
  return THRESHOLDS;
}

function paramCode(r) {
  const reasons = [];
  let original = null;
  let estimated = null;

  // AQI
  if (r.aqi > THRESHOLDS.aqi.danger) {
    reasons.push(`AQI ${r.aqi} is severe (>${THRESHOLDS.aqi.danger})`);
    original = r.aqi;
    estimated = Math.round(THRESHOLDS.aqi.warning * 0.9);
  } else if (r.aqi > THRESHOLDS.aqi.warning) {
    reasons.push(`AQI ${r.aqi} is unhealthy`);
    original = r.aqi;
    estimated = Math.round(THRESHOLDS.aqi.good * 1.1);
  }

  // Temperature
  if (r.temperature > THRESHOLDS.temperature.danger) {
    reasons.push(`Temperature ${r.temperature}°C exceeds critical limit`);
    if (original == null) { original = r.temperature; estimated = THRESHOLDS.temperature.warning; }
  } else if (r.temperature > THRESHOLDS.temperature.warning) {
    reasons.push(`Temperature ${r.temperature}°C is unusually high`);
  }

  // Humidity
  if (r.humidity < THRESHOLDS.humidity.danger) {
    reasons.push(`Humidity ${r.humidity}% is critically low`);
  } else if (r.humidity > THRESHOLDS.humidity.tooHigh) {
    reasons.push(`Humidity ${r.humidity}% is very high`);
  }

  // Wind
  if (r.wind > THRESHOLDS.wind.danger) {
    reasons.push(`Wind ${r.wind} m/s is dangerous`);
  }

  // Rainfall surge
  if (r.rainfall > 5) {
    reasons.push(`Rainfall ${r.rainfall} mm in last reading`);
  }

  // Pressure drift
  const pRange = THRESHOLDS.pressure.good;
  if (r.pressure < pRange[0] - THRESHOLDS.pressure.warningDelta ||
      r.pressure > pRange[1] + THRESHOLDS.pressure.warningDelta) {
    reasons.push(`Pressure ${r.pressure} hPa drifted from normal band`);
  }

  if (!reasons.length) {
    return {
      anomaly: false,
      reasons: ['All parameters within normal thresholds'],
      confidence: 0.97,
      original: null,
      estimated: null,
      factors: [],
      recommendation: 'Continue normal operations.',
    };
  }

  // Confidence: more reasons + higher extremity => higher confidence
  const extremity = (original != null && estimated != null)
    ? Math.min(1, Math.abs(original - estimated) / estimated)
    : 0.3;
  const confidence = +(0.7 + Math.min(0.29, reasons.length * 0.05 + extremity)).toFixed(2);

  const factors = [];
  if (r.aqi > THRESHOLDS.aqi.warning)  factors.push({ name: 'AQI',          weight: 0.42 });
  if (r.temperature > THRESHOLDS.temperature.warning) factors.push({ name: 'Temperature', weight: 0.28 });
  if (r.humidity < THRESHOLDS.humidity.warning) factors.push({ name: 'Humidity', weight: 0.12 });
  if (r.wind > THRESHOLDS.wind.warning)  factors.push({ name: 'Wind',         weight: 0.10 });
  if (r.rainfall > 3)                    factors.push({ name: 'Rainfall',     weight: 0.08 });
  // Normalise
  const sum = factors.reduce((a, f) => a + f.weight, 0) || 1;
  factors.forEach((f) => { f.weight = +(f.weight / sum).toFixed(2); });

  const recommendation = buildRecommendation(r, reasons);

  return {
    anomaly: true,
    reasons,
    confidence,
    original,
    estimated,
    factors,
    recommendation,
  };
}

function buildRecommendation(r, reasons) {
  const recs = [];
  if (r.aqi > THRESHOLDS.aqi.warning) recs.push('Deploy mobile air-quality unit; advise vulnerable groups.');
  if (r.temperature > THRESHOLDS.temperature.warning) recs.push('Activate heat-stress protocol; check coolant at station.');
  if (r.humidity < THRESHOLDS.humidity.danger) recs.push('Reduce humidity-controlled loads; inspect dehumidifier.');
  if (r.wind > THRESHOLDS.wind.warning) recs.push('Inspect mast/anchors; pause outdoor calibration.');
  if (r.rainfall > 5) recs.push('Verify enclosure sealing and drainage.');
  if (!recs.length) recs.push('Investigate sensor drift; run calibration sweep.');
  return recs;
}

function healthScore(r) {
  let score = 100;
  if (r.aqi != null) score -= Math.max(0, r.aqi - THRESHOLDS.aqi.good) * 0.25;
  if (r.temperature != null) score -= Math.max(0, r.temperature - THRESHOLDS.temperature.good) * 3;
  if (r.humidity != null) score -= Math.max(0, THRESHOLDS.humidity.good - r.humidity) * 0.8;
  if (r.wind != null) score -= Math.max(0, r.wind - THRESHOLDS.wind.good) * 4;
  if (r.rainfall != null) score -= Math.max(0, r.rainfall - 3) * 5;
  return Math.max(0, Math.min(100, +score.toFixed(1)));
}

function maintenanceRisk(r, recentFailures) {
  // Heuristic: more readings outside thresholds + recent failures => higher risk.
  let risk = 0;
  if (r.aqi > THRESHOLDS.aqi.warning) risk += 25;
  if (r.temperature > THRESHOLDS.temperature.warning) risk += 20;
  if (r.humidity < THRESHOLDS.humidity.warning) risk += 15;
  if (r.wind > THRESHOLDS.wind.warning) risk += 10;
  if (r.rainfall > 3) risk += 10;
  risk += (recentFailures || 0) * 6;
  return Math.min(100, risk);
}

module.exports = { paramCode, healthScore, maintenanceRisk, THRESHOLDS, setThresholds, getThresholds };