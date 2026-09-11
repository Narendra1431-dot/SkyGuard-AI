'use strict';

const STATION_NAMES = [
  'Delhi Central',
  'Mumbai Coast',
  'Hyderabad Tech Park',
  'Chennai Port',
  'Bengaluru Whitefield',
  'Kolkata Riverside',
  'Pune Hilltop',
  'Jaipur Heritage',
];

const BASE_POINTS = [
  { lat: 28.6139, lon: 77.2090 },
  { lat: 19.0760, lon: 72.8777 },
  { lat: 17.3850, lon: 78.4867 },
  { lat: 13.0827, lon: 80.2707 },
  { lat: 12.9716, lon: 77.5946 },
  { lat: 22.5726, lon: 88.3639 },
  { lat: 18.5204, lon: 73.8567 },
  { lat: 26.9124, lon: 75.7873 },
];
const STATION_IDS = ['HYD001', 'MUM002', 'DEL003', 'BLR004', 'PNQ005', 'KOL006', 'JAI007', 'HYD002'];

function makeStation(i) {
  const base = BASE_POINTS[i % BASE_POINTS.length];
  return {
    id: STATION_IDS[i % STATION_IDS.length],
    name: STATION_NAMES[i % STATION_NAMES.length],
    lat: base.lat,
    lon: base.lon,
    elevation: 50 + (i * 37) % 700,
    installed: '2023-0' + (1 + (i % 6)),
  };
}

function buildStations(n) {
  return Array.from({ length: n }, (_, i) => makeStation(i));
}

function rand(minV, maxV) { return Math.random() * (maxV - minV) + minV; }
function jitter(v, amp) { return v + rand(-amp, amp); }

function tickReading(station, t) {
  const slow = Math.sin(t / 30) * 0.5 + Math.cos(t / 17) * 0.3;
  const tempC = jitter(28 + slow * 5 + (station.elevation > 500 ? -3 : 0), 1.2);
  const pressure = jitter(1012 + slow * 4, 1.5);
  const humidity = Math.max(0, Math.min(100, jitter(55 + slow * 10, 6)));
  const aqi = Math.max(10, Math.round(jitter(95 + slow * 60, 18)));
  const wind = Math.max(0, jitter(4 + slow * 3, 1.8));
  const rainfall = Math.max(0, +(jitter(0.2 + Math.max(0, slow) * 0.6, 0.4)).toFixed(2));
  let anomalyFlag = 0;
  if (Math.random() < 0.08) anomalyFlag = 1;
  return {
    time: new Date().toISOString(),
    stationId: station.id,
    temperature: +tempC.toFixed(2),
    pressure: +pressure.toFixed(2),
    humidity: +humidity.toFixed(2),
    aqi,
    wind: +wind.toFixed(2),
    rainfall,
    anomaly: anomalyFlag,
    source: { provider: 'sim', station: station.id, retrievedAt: new Date().toISOString(), observationAt: new Date().toISOString(), quality: 'simulated', fallback: false, cacheHit: false, url: null },
  };
}

function classify(reading) {
  if (reading.aqi > 250 || reading.temperature > 42 || reading.humidity < 15) return 'critical';
  if (reading.aqi > 150 || reading.temperature > 38 || reading.wind > 10) return 'warning';
  return 'healthy';
}

module.exports = { buildStations, tickReading, classify, STATION_IDS, STATION_NAMES, BASE_POINTS };
