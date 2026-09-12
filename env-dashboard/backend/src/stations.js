'use strict';

const stationsData = [
  { id: 'HYD001', name: 'Hyderabad Tech Park', lat: 17.3850, lon: 78.4867, elevation: 500, installed: '2023-04' },
  { id: 'DEL003', name: 'Delhi Central', lat: 28.6139, lon: 77.2090, elevation: 50, installed: '2023-01' },
  { id: 'MUM002', name: 'Mumbai Coast', lat: 19.0760, lon: 72.8777, elevation: 10, installed: '2023-02' },
  { id: 'BLR004', name: 'Bengaluru Whitefield', lat: 12.9716, lon: 77.5946, elevation: 800, installed: '2023-03' },
  { id: 'PNQ005', name: 'Pune Hilltop', lat: 18.5204, lon: 73.8567, elevation: 600, installed: '2023-05' },
  { id: 'KOL006', name: 'Kolkata Riverside', lat: 22.5726, lon: 88.3639, elevation: 7, installed: '2023-06' },
  { id: 'JAI007', name: 'Jaipur Heritage', lat: 26.9124, lon: 75.7873, elevation: 300, installed: '2023-07' },
  { id: 'HYD002', name: 'Hyderabad South', lat: 17.3643, lon: 78.4744, elevation: 550, installed: '2023-08' },
];

function buildStations(n) {
  return stationsData.slice(0, n);
}

function tickReading(station, t) {
  const slow = Math.sin(t / 30) * 0.5 + Math.cos(t / 17) * 0.3;
  const tempC = 28 + slow * 5 + (station.elevation > 500 ? -3 : 0) + (Math.random() - 0.5) * 2;
  const pressure = 1012 + slow * 4 + (Math.random() - 0.5) * 3;
  const humidity = Math.max(0, Math.min(100, 55 + slow * 10 + (Math.random() - 0.5) * 8));
  const aqi = Math.max(10, Math.round(95 + slow * 60 + (Math.random() - 0.5) * 20));
  const wind = Math.max(0, (4 + slow * 3) + (Math.random() - 0.5) * 4);
  const rainfall = Math.max(0, ((Math.random() * 0.3) + Math.max(0, slow) * 0.3).toFixed(2));

  const analysis = paramCode({ temperature: tempC, pressure, humidity, aqi, wind, rainfall });
  const anomaly = analysis.anomaly ? 1 : 0;

  return {
    time: new Date().toISOString(),
    stationId: station.id,
    temperature: +tempC.toFixed(2),
    pressure: +pressure.toFixed(2),
    humidity: +humidity.toFixed(2),
    aqi,
    wind: +wind.toFixed(2),
    rainfall,
    anomaly,
    source: {
      provider: 'sim',
      station: station.id,
      retrievedAt: new Date().toISOString(),
      observationAt: new Date().toISOString(),
      quality: 'simulated',
      fallback: false,
      cacheHit: false,
      url: null,
    },
    stationAnalysis: analysis,
  };
}

function classify(reading) {
  if (reading.aqi > 250 || reading.temperature > 42 || reading.humidity < 15) return 'critical';
  if (reading.aqi > 150 || reading.temperature > 38 || reading.wind > 10) return 'warning';
  return 'healthy';
}

function paramCode(r) {
  const reasons = [];
  let original = null;
  let estimated = null;

  if (r.aqi > 250) {
    reasons.push(`AQI ${r.aqi} is severe (>${250})`);
    original = r.aqi;
    estimated = Math.round(150 * 0.9);
  } else if (r.aqi > 150) {
    reasons.push(`AQI ${r.aqi} is unhealthy`);
    original = r.aqi;
    estimated = Math.round(100 * 1.1);
  }

  if (r.temperature > 42) {
    reasons.push(`Temperature ${r.temperature}\\u00b0C exceeds critical limit`);
    if (original == null) { original = r.temperature; estimated = 38; }
  } else if (r.temperature > 38) {
    reasons.push(`Temperature ${r.temperature}\\u00b0C is unusually high`);
  }

  if (r.humidity < 15) {
    reasons.push(`Humidity ${r.humidity}% is critically low`);
  } else if (r.humidity > 85) {
    reasons.push(`Humidity ${r.humidity}% is very high`);
  }

  if (r.wind > 14) {
    reasons.push(`Wind ${r.wind} m/s is dangerous`);
  }

  if (r.rainfall > 5) {
    reasons.push(`Rainfall ${r.rainfall} mm in last reading`);
  }

  const pressureMin = 1005, pressureMax = 1020, warningDelta = 8;
  if (r.pressure < pressureMin - warningDelta || r.pressure > pressureMax + warningDelta) {
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

  const extremity = (original != null && estimated != null)
    ? Math.min(1, Math.abs(original - estimated) / estimated)
    : 0.3;
  const confidence = +(0.7 + Math.min(0.29, reasons.length * 0.05 + extremity)).toFixed(2);

  const factors = [];
  if (r.aqi > 150) factors.push({ name: 'AQI', weight: 0.42 });
  if (r.temperature > 38) factors.push({ name: 'Temperature', weight: 0.28 });
  if (r.humidity < 15) factors.push({ name: 'Humidity', weight: 0.12 });
  if (r.wind > 10) factors.push({ name: 'Wind', weight: 0.10 });
  if (r.rainfall > 3) factors.push({ name: 'Rainfall', weight: 0.08 });
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
  if (r.aqi > 150) recs.push('Deploy mobile air-quality unit; advise vulnerable groups.');
  if (r.temperature > 38) recs.push('Activate heat-stress protocol; check coolant at station.');
  if (r.humidity < 15) recs.push('Reduce humidity-controlled loads; inspect dehumidifier.');
  if (r.wind > 10) recs.push('Inspect mast/anchors; pause outdoor calibration.');
  if (r.rainfall > 5) recs.push('Verify enclosure sealing and drainage.');
  if (!recs.length) recs.push('Investigate sensor drift; run calibration sweep.');
  return recs;
}

function healthScore(r) {
  let score = 100;
  score -= Math.max(0, r.aqi - 100) * 0.25;
  score -= Math.max(0, r.temperature - 32) * 3;
  score -= Math.max(0, 60 - r.humidity) * 0.8;
  score -= Math.max(0, r.wind - 6) * 4;
  score -= Math.max(0, r.rainfall - 3) * 5;
  return Math.max(0, Math.min(100, +score.toFixed(1)));
}

function maintenanceRisk(r, recentFailures) {
  let risk = 0;
  if (r.aqi > 150) risk += 25;
  if (r.temperature > 38) risk += 20;
  if (r.humidity < 15) risk += 15;
  if (r.wind > 10) risk += 10;
  if (r.rainfall > 3) risk += 10;
  risk += (recentFailures || 0) * 6;
  return Math.min(100, risk);
}

module.exports = {
  buildStations,
  tickReading,
  classify,
  STATION_IDS: stationsData.map(s => s.id),
  STATION_NAMES: stationsData.map(s => s.name),
  paramCode,
  healthScore,
  maintenanceRisk,
};
