'use strict';

const fs = require('fs');
const path = require('path');
const dataStore = require('./dataStore');

const EVENTS_FILE = path.resolve(__dirname, '..', '..', 'data', 'state', 'events.json');
const DATASET_FILE = path.resolve(__dirname, '..', '..', 'data', 'ml', 'dataset.jsonl');
const DATASET_META_FILE = path.resolve(__dirname, '..', '..', 'data', 'ml', 'dataset_meta.json');

const FEATURES = ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'];

const LABEL_PROVENANCE = {
  source: 'rule_engine_legacy',
  engine: 'ai.paramCode',
  note: 'Legacy model trained from rule-engine-derived anomaly labels via events.json → payload.anomaly → ai.paramCode(). Independent human labeling not available.',
};

function ensureDir() {
  try { fs.mkdirSync(path.dirname(DATASET_FILE), { recursive: true }); } catch (_) {}
}

function parseEvents() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  try {
    const content = fs.readFileSync(EVENTS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.error('[ml-dataset] Failed to parse events.json:', e.message);
    return [];
  }
}

function extractReadings(events) {
  const readings = [];
  for (const event of events) {
    if (event.type !== 'reading.created') continue;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    
    const reading = {
      time: payload.time || event.timestamp,
      stationId: payload.stationId || event.stationId,
      temperature: payload.temperature,
      pressure: payload.pressure,
      humidity: payload.humidity,
      aqi: payload.aqi,
      wind: payload.wind,
      rainfall: payload.rainfall,
      anomaly: payload.anomaly,
    };
    
    if (!isValidReading(reading)) continue;
    readings.push(reading);
  }
  return readings;
}

function isValidReading(r) {
  if (r.temperature == null || r.pressure == null || r.humidity == null) return false;
  if (typeof r.temperature !== 'number' || typeof r.pressure !== 'number' || typeof r.humidity !== 'number') return false;
  if (isNaN(r.temperature) || isNaN(r.pressure) || isNaN(r.humidity)) return false;
  if (r.anomaly !== 0 && r.anomaly !== 1) return false;
  return true;
}

function normalizeFeatures(readings) {
  const stats = {};
  for (const f of FEATURES) {
    const vals = readings.map(r => r[f]).filter(v => v != null && !isNaN(v));
    if (vals.length === 0) {
      stats[f] = { min: 0, max: 1, mean: 0, std: 1 };
      continue;
    }
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1;
    stats[f] = { min, max, mean, std };
  }
  return stats;
}

function normalizeReading(reading, stats) {
  const normalized = [];
  for (const f of FEATURES) {
    const s = stats[f];
    const val = reading[f];
    if (val == null || isNaN(val)) {
      normalized.push(0);
    } else {
      normalized.push((val - s.mean) / s.std);
    }
  }
  return normalized;
}

function buildDataset() {
  console.log('[ml-dataset] Building dataset from events.json...');
  const events = parseEvents();
  console.log(`[ml-dataset] Parsed ${events.length} events`);
  
  const readings = extractReadings(events);
  console.log(`[ml-dataset] Extracted ${readings.length} valid readings`);
  
  if (readings.length === 0) {
    console.error('[ml-dataset] No valid readings found');
    return null;
  }
  
  const beforeDedupe = readings.length;
  const uniqueReadings = removeExactDuplicates(readings);
    const duplicateCount = beforeDedupe - uniqueReadings.length;
  console.log(`[ml-dataset] Removed ${duplicateCount} exact duplicate readings (${uniqueReadings.length} unique)`);
  
  // NOTE: Labels currently come from sensor anomaly field - THIS IS LEAKED DATA
  // DO NOT use these as supervised training labels. These are raw observations only.
  const positiveCount = uniqueReadings.filter(r => r.anomaly === 1).length;
  const negativeCount = uniqueReadings.filter(r => r.anomaly === 0).length;
  console.log(`[ml-dataset] WARNING: Class distribution from sensor anomaly (LEAKED): positive=${positiveCount}, negative=${negativeCount}`);
  console.log(`[ml-dataset] ERROR: These sensor anomaly labels MUST NOT be used as supervised training targets.`);
  console.log(`[ml-dataset] FATAL: No genuine human-labeled training data available. Cannot proceed with supervised training.`);
  throw new Error('ML dataset validation failed: sensor anomaly labels are leaked data. No independent human-labeled training data available.');
  
  // const stats = normalizeFeatures(uniqueReadings);
  // 
  // const dataset = uniqueReadings.map(r => ({
  //   features: normalizeReading(r, stats),
  //   label: r.anomaly,  // Use anomaly field from raw data - independent ground truth
  //   raw: {
  //     temperature: r.temperature,
  //     pressure: r.pressure,
  //     humidity: r.humidity,
  //     aqi: r.aqi,
  //     wind: r.wind,
  //     rainfall: r.rainfall,
  //   },
  //   time: r.time,
  //   stationId: r.stationId,
  // }));
  
  const metadata = {
    version: '1.0.0',
    createdAt: new Date().toISOString(),
    source: 'events.json',
    recordCount: dataset.length,
    classDistribution: {
      positive: positiveCount,
      negative: negativeCount,
      positiveRate: positiveCount / dataset.length,
    },
    featureSchema: FEATURES,
    normalizationStats: stats,
    featureCount: FEATURES.length,
    labelProvenance: LABEL_PROVENANCE,
    duplicateCountRemoved: duplicateCount,
  };
  
  ensureDir();
  
  const datasetText = dataset.map(r => JSON.stringify(r)).join('\n');
  fs.writeFileSync(DATASET_FILE, datasetText);
  fs.writeFileSync(DATASET_META_FILE, JSON.stringify(metadata, null, 2));
  
  console.log(`[ml-dataset] Dataset saved: ${dataset.length} records`);
  console.log(`[ml-dataset] Metadata saved to ${DATASET_META_FILE}`);
  
  return { dataset, metadata };
}

function loadDataset() {
  if (!fs.existsSync(DATASET_FILE)) return null;
  try {
    const lines = fs.readFileSync(DATASET_FILE, 'utf8').split('\n').filter(l => l.trim());
    const dataset = lines.map(l => JSON.parse(l));
    const before = dataset.length;
    const seen = new Set();
    const uniqueDataset = [];
    for (const r of dataset) {
      const raw = r.raw || {};
      const k = [raw.time, raw.stationId, raw.temperature, raw.pressure, raw.humidity, raw.aqi, raw.wind, raw.rainfall, r.label].join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      uniqueDataset.push(r);
    }
    if (uniqueDataset.length < before) {
      console.log(`[ml-dataset] Deduplicated loaded dataset: ${before} -> ${uniqueDataset.length} records`);
    }
    return uniqueDataset;
  } catch (e) {
    console.error('[ml-dataset] Failed to load dataset:', e.message);
    return null;
  }
}

function loadMetadata() {
  if (!fs.existsSync(DATASET_META_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATASET_META_FILE, 'utf8'));
  } catch (e) {
    console.error('[ml-dataset] Failed to load metadata:', e.message);
    return null;
  }
}

function getDatasetInfo() {
  const meta = loadMetadata();
  if (!meta) return null;
  return {
    version: meta.version,
    recordCount: meta.recordCount,
    classDistribution: meta.classDistribution,
    featureSchema: meta.featureSchema,
    createdAt: meta.createdAt,
  };
}

function trainTestSplit(dataset, testRatio = 0.2, seed = 42) {
  const shuffled = [...dataset];
  let m = shuffled.length;
  let t;
  while (m) {
    t = Math.floor(random() * m--);
    [shuffled[m], shuffled[t]] = [shuffled[t], shuffled[m]];
  }
  const splitIdx = Math.floor(dataset.length * (1 - testRatio));
  return {
    train: shuffled.slice(0, splitIdx),
    test: shuffled.slice(splitIdx),
  };
}

function random(seed) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

function readingKey(r) {
  return [r.time, r.stationId, r.temperature, r.pressure, r.humidity, r.aqi, r.wind, r.rainfall, r.anomaly].join('|');
}

function removeExactDuplicates(readings) {
  const seen = new Set();
  const out = [];
  for (const r of readings) {
    const k = readingKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function checkLeakage(trainSet, evalSet) {
  if (!Array.isArray(trainSet) || !Array.isArray(evalSet)) return { leaked: false, reason: 'invalid_input' };
  if (trainSet.length === 0 || evalSet.length === 0) return { leaked: false, reason: 'empty_sets' };

  const trainKeys = new Set(trainSet.map(r => readingKey(r.raw || r)));
  let overlap = 0;
  for (const r of evalSet) {
    if (trainKeys.has(readingKey(r.raw || r))) overlap++;
  }
  const leaked = overlap > 0;
  return {
    leaked,
    overlapCount: overlap,
    evalSetSize: evalSet.length,
    reason: leaked ? 'exact_duplicate_rows_found_between_train_and_eval' : 'no_overlap_detected',
  };
}

module.exports = {
  buildDataset,
  loadDataset,
  loadMetadata,
  getDatasetInfo,
  trainTestSplit,
  FEATURES,
  DATASET_FILE,
  DATASET_META_FILE,
  removeExactDuplicates,
  checkLeakage,
  readingKey,
  LABEL_PROVENANCE,
};
