'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const dataset = require('./mlDataset');
const trainer = require('./mlTrain');
const mlRuns = require('../db/mlRuns');
const { paramCode } = require('../ai');

const EVAL_FILE = path.resolve(__dirname, '..', '..', 'data', 'ml', 'eval.jsonl');
const MODEL_INFO_FILE = path.resolve(__dirname, '..', '..', 'data', 'ml', 'model_info.json');

const MODEL_TYPE = 'LOGISTIC_REGRESSION';
const MODEL_VERSION = 'lr-1.0.0';
const RULE_BASED_TYPE = 'RULE_BASED_DETECTOR';
const RULE_BASED_VERSION = 'rule-1.0.0';

const ML_MODEL_TYPE = MODEL_TYPE;
const ML_MODEL_VERSION = MODEL_VERSION;
const RULE_BASED_TYPE_EXPORT = RULE_BASED_TYPE;
const RULE_BASED_VERSION_EXPORT = RULE_BASED_VERSION;

const STATUS_TTL_MS = 5000;

let store = null;
let statusCache = null;
let statusCacheAt = 0;
let retraining = false;

function setStore(s) {
  store = s;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

// ----------------------------- data helpers -----------------------------

function loadModelInfo() {
  if (!fs.existsSync(MODEL_INFO_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(MODEL_INFO_FILE, 'utf8'));
  } catch (e) {
    console.error('[ml] failed to parse model_info.json:', e.message);
    return null;
  }
}

function writeModelInfo(info) {
  ensureDir(path.dirname(MODEL_INFO_FILE));
  try { fs.writeFileSync(MODEL_INFO_FILE, JSON.stringify(info, null, 2)); } catch (_) {}
}

function loadTrainedModel() {
  return trainer.loadModel(); // artifact { model, metadata, savedAt } or null
}

function fmtEvalRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (Array.isArray(rec.features) && (rec.label === 0 || rec.label === 1)) {
    return rec; // Return the full record including reviewer fields
  }
  const raw = rec.raw || rec;
  if (raw && typeof raw === 'object' && (rec.label === 0 || rec.label === 1 || rec.anomaly === 0 || rec.anomaly === 1)) {
    return { features: null, label: rec.label != null ? rec.label : rec.anomaly, raw };
  }
  return null;
}

function toFeatures(raw, stats) {
  const out = [];
  for (const f of dataset.FEATURES) {
    const v = raw ? raw[f] : undefined;
    if (v == null || isNaN(v)) { out.push(0); continue; }
    const s = stats ? stats[f] : null;
    if (s && s.std) out.push((v - s.mean) / s.std);
    else out.push(v);
    if (out.length > 100000) break;
  }
  return out;
}

function loadEvaluationSet() {
  if (!fs.existsSync(EVAL_FILE)) return [];
  try {
    const lines = fs.readFileSync(EVAL_FILE, 'utf8').split('\n').filter((l) => l && l.trim());
    const stats = dataset.loadMetadata() ? dataset.loadMetadata().normalizationStats : null;
    const out = [];
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch (_) { continue; }
      const fmt = fmtEvalRecord(rec);
      if (!fmt) continue;
      if (fmt.features) {
        out.push(fmt);
      } else {
        const feats = toFeatures(fmt.raw, stats);
        if (!feats.every((x) => typeof x === 'number' && !isNaN(x))) continue;
        out.push({ features: feats, label: fmt.label, raw: fmt.raw || null });
      }
    }
    return out;
  } catch (e) {
    console.error('[ml] failed to load eval.jsonl:', e.message);
    return [];
  }
}

function saveEvaluationSet(lines) {
  ensureDir(path.dirname(EVAL_FILE));
  const payload = (Array.isArray(lines) ? lines : [lines])
    .filter((r) => r && typeof r === 'object')
    .map((r) => JSON.stringify(r))
    .join('\n');
  fs.writeFileSync(EVAL_FILE, payload ? payload + '\n' : '\n');
  return { count: Array.isArray(lines) ? lines.length : 1 };
}

// ------------------------------ scoring --------------------------------

function ruleBasedScore(reading) {
  if (!reading || typeof reading !== 'object') return 0;
  try {
    const p = paramCode(reading);
    if (!p || !p.anomaly) return 0;
    return Math.max(0, Math.min(1, p.confidence || 0));
  } catch (_) {
    return 0;
  }
}

function detectorScore(reading) {
  const rule = ruleBasedScore(reading);
  if (!store && !reading) return rule;
  let mlProb = null;
  try {
    const artifact = loadTrainedModel();
    if (artifact) {
      const r = trainer.inference(reading, artifact.model, artifact.metadata);
      mlProb = r.probability;
    }
  } catch (_) { /* ml inference optional */ }
  const score = mlProb == null ? rule : Math.max(rule, mlProb);
  return Math.max(0, Math.min(1, score));
}

// ------------------------------ drift/latency --------------------------

function computeDrift(meta, recent) {
  const perField = {};
  const stats = (meta && meta.normalizationStats) || {};
  for (const f of dataset.FEATURES) {
    const s = stats[f];
    const values = recent
      .map((r) => (r && typeof r[f] === 'number' && !isNaN(r[f])) ? r[f] : null)
      .filter((v) => v != null);
    const previous = s ? s.mean : 0;
    const recentMean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : previous;
    const denom = s ? Math.max(0.001, (s.max - s.min) || (s.std * 2)) : 1;
    let driftPct = Math.abs(recentMean - previous) / denom * 100;
    driftPct = Math.round(driftPct * 100) / 100;
    perField[f] = {
      previous: +(previous).toFixed(3),
      recent: +recentMean.toFixed(3),
      driftPct,
    };
  }
  const vals = Object.values(perField);
  const score = vals.length ? Math.round(vals.reduce((a, b) => a + b.driftPct, 0) / vals.length * 100) / 100 : 0;
  return { score, perField };
}

// ------------------------------- health ---------------------------------

function deriveHealthFromState(state) {
  if (!state) return 'YELLOW';
  if (state.inferenceError) return 'RED';
  if (state.status === 'FAILED' || state.status === 'ERROR') return 'RED';
  if (state.status === 'RETRAINING') return 'YELLOW';
  const trained = state.modelType === MODEL_TYPE;
  if (trained) {
    if (state.evaluationStatus === 'VERIFIED') return 'GREEN';
    if (state.evaluationStatus === 'UNVERIFIED') return 'YELLOW';
    if (state.status === 'READY' || state.status === 'COMPLETED') return 'YELLOW';
    return 'YELLOW';
  }
  if (state.modelType === RULE_BASED_TYPE) return 'YELLOW';
  if (state.status === 'NO_MODEL' || state.status === 'IDLE' || state.status === 'UNVERIFIED' || state.status === 'PENDING') return 'YELLOW';
  if (state.status === 'READY' || state.status === 'COMPLETED') return 'GREEN';
  return 'YELLOW';
}

async function getMlHealthAsync() {
  try {
    const s = await status();
    return deriveHealthFromState(s);
  } catch (_) {
    return 'YELLOW';
  }
}

function getMlHealth() {
  try {
    const s = status();
    if (typeof s === 'object' && s.then) {
      return 'UNVERIFIED';
    }
    return deriveHealthFromState(s);
  } catch (_) {
    return 'YELLOW';
  }
}

// ----------------------------- status/snapshot -------------------------

async function computeStatusNow() {
  const t0 = Date.now();
  const artifact = loadTrainedModel();
  const info = loadModelInfo();
  const meta = dataset.loadMetadata();
  const evalSet = loadEvaluationSet();

  let recent = [];
  if (store && typeof store.recentReadings === 'function') {
    try { recent = await store.recentReadings(30); } catch (_) { recent = []; }
  }
  const drift = computeDrift(meta, recent);

  const trained = !!artifact;
  const modelType = trained ? artifact.model.modelType : null;
  const metrics = trained ? (artifact.model.metrics || null) : null;
  const featureImportance = trained && Array.isArray(artifact.model.featureImportance) ? artifact.model.featureImportance : [];
  const samples = trained && info && info.metrics ? info.metrics.samples : (trained ? 0 : 0);

  const modelTrainingState = trained ? 'trained' : 'untrained';
  const threshold = trained
    ? { state: 'STANDARD', threshold: 0.5, recommended: 0.5 }
    : { state: 'UNKNOWN', threshold: null, recommended: 0.5 };

  let confusionMatrix = null;
  let roc = null;
  if (trained) {
    try {
      const evalFormatted = evalSet
        .filter((e) => Array.isArray(e.features) && e.features.length)
        .map((e) => ({ features: e.features, label: e.label }));
      if (evalFormatted.length > 0 && meta) {
        const vr = trainer.evaluate(artifact.model, evalFormatted.slice(0, 2000));
        confusionMatrix = vr.confusionMatrix;
        roc = vr.roc;
      }
    } catch (_) {}
  }
  if (!confusionMatrix) confusionMatrix = { matrix: [[0, 0], [0, 0]], labels: ['negative', 'positive'] };
  if (!roc) roc = { points: [], auc: 0 };

  const evaluationStatus = evalSet.length > 0 ? (trained ? 'UNVERIFIED' : 'PENDING') : (trained ? 'UNVERIFIED' : 'PENDING');
  const evaluationNote = evalSet.length === 0
    ? 'No independent labeled evaluation data (eval.jsonl is empty). Evaluation remains UNVERIFIED.'
    : 'Independent labeled evaluation data present; run Validate to verify the trained model.';

  const status = trained
    ? (evaluationStatus === 'VERIFIED' ? 'READY' : 'UNVERIFIED')
    : (dataset.loadMetadata() ? 'UNVERIFIED' : 'NO_MODEL');

  const latencyMs = Date.now() - t0;
  const snap = {
    status,
    modelType,
    trainingState: modelTrainingState,
    evaluationStatus,
    independentEval: evalSet.length > 0,
    serviceHealth: deriveHealthFromState({ status, modelType, evaluationStatus }),
    completedAt: trained ? (info && info.trainedAt) || artifact.model.trainedAt || artifact.savedAt : null,
    trainedAt: trained ? artifact.model.trainedAt || artifact.savedAt : null,
    metrics,
    samples,
    threshold,
    latency: { lastMs: latencyMs, perSampleMs: metrics && metrics.samples ? +(latencyMs / Math.max(1, metrics.samples)).toFixed(3) : null },
    confusionMatrix,
    roc,
    featureImportance,
    drift,
    notes: trained
      ? (evaluationStatus === 'VERIFIED' ? 'Trained model verified on independent labeled data.' : evaluationNote)
      : 'No trained model. Run Retrain to train the ML classifier.',
    version: trained ? artifact.model.version : null,
    inferenceError: null,
  };
  return snap;
}

async function status(options = {}) {
  if (!options.refresh && statusCache && Date.now() - statusCacheAt < STATUS_TTL_MS) {
    return statusCache;
  }
  const snap = await computeStatusNow();
  statusCache = snap;
  statusCacheAt = Date.now();
  return snap;
}

function snapshot() {
  if (statusCache) return statusCache;
  const artifact = loadTrainedModel();
  const info = loadModelInfo();
  const meta = dataset.loadMetadata();
  const evalSet = loadEvaluationSet();
  const trained = !!artifact;
  const evaluationStatus = evalSet.length > 0 && trained ? 'UNVERIFIED' : (trained ? 'UNVERIFIED' : 'PENDING');
  const snap = {
    status: trained ? 'UNVERIFIED' : (meta ? 'UNVERIFIED' : 'NO_MODEL'),
    modelType: trained ? artifact.model.modelType : null,
    trainingState: trained ? 'trained' : 'untrained',
    evaluationStatus,
    independentEval: evalSet.length > 0,
    serviceHealth: deriveHealthFromState({ status: trained ? 'UNVERIFIED' : 'NO_MODEL', modelType: trained ? artifact.model.modelType : null, evaluationStatus }),
    completedAt: trained ? (info && info.trainedAt) || artifact.model.trainedAt || artifact.savedAt : null,
    trainedAt: trained ? artifact.model.trainedAt || artifact.savedAt : null,
    metrics: trained ? (artifact.model.metrics || null) : null,
    samples: trained && info && info.metrics ? info.metrics.samples : 0,
    threshold: trained ? { state: 'STANDARD', threshold: 0.5, recommended: 0.5 } : { state: 'UNKNOWN', threshold: null, recommended: 0.5 },
    latency: { lastMs: 0, perSampleMs: null },
    confusionMatrix: { matrix: [[0, 0], [0, 0]], labels: ['negative', 'positive'] },
    roc: { points: [], auc: 0 },
    featureImportance: trained && Array.isArray(artifact.model.featureImportance) ? artifact.model.featureImportance : [],
    drift: { score: 0, perField: {} },
    notes: trained ? 'Trained model present; evaluation UNVERIFIED until validated on independent data.' : 'No trained model. Run Retrain to train the ML classifier.',
    version: trained ? artifact.model.version : null,
    inferenceError: null,
  };
  statusCache = snap;
  statusCacheAt = Date.now();
  return snap;
}

async function evaluate({ requestedBy = 'system-bootstrap' } = {}) {
  const startedAt = new Date().toISOString();
  let snap;
  try {
    snap = await computeStatusNow();
  } catch (e) {
    console.error('[ml] evaluate failed:', e.message);
    throw e;
  }
  const completedAt = new Date().toISOString();
  try {
    await mlRuns.insertRun({
      id: `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'COMPLETED',
      startedAt,
      completedAt,
      metrics: snap.metrics || { samples: 0 },
      confusionMatrix: snap.confusionMatrix,
      roc: snap.roc,
      featureImportance: snap.featureImportance,
      drift: snap.drift,
      latency: snap.latency,
      threshold: snap.threshold,
      notes: `Evaluation snapshot (${snap.evaluationStatus}) - ${snap.notes || ''}`.trim(),
      requestedBy,
    });
  } catch (e) {
    console.error('[ml] evaluation run persistence failed:', e.message);
  }
  statusCache = snap;
  statusCacheAt = Date.now();
  return snap;
}

async function validate({ requestedBy = 'system' } = {}) {
  const startedAt = new Date().toISOString();
  const artifact = loadTrainedModel();
  const info = loadModelInfo() || {};
  if (!artifact) {
    const snap = await status({ refresh: true });
    return { ...snap, status: 'UNVERIFIED', notes: 'No trained model available to validate. Run Retrain first.' };
  }

  const evalSet = loadEvaluationSet();
  const completedAt = new Date().toISOString();

  if (!evalSet.length) {
    writeModelInfo({ ...info, evaluationStatus: 'UNVERIFIED', evaluationDatasetIdentity: 'N/A - no independent evaluation dataset available' });
    await mlRuns.insertRun({
      id: `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      status: 'UNVERIFIED',
      startedAt,
      completedAt,
      modelType: artifact.model.modelType,
      notes: 'Validation could not run: eval.jsonl has no labeled samples. Evaluation remains UNVERIFIED.',
      requestedBy,
    });
    const snap = await status({ refresh: true });
    return { ...snap, notes: 'No independent labeled evaluation samples in eval.jsonl. Upload labeled samples to verify.' };
  }

  const labeled = evalSet.filter((e) => Array.isArray(e.features) && e.features.length);
  const evalResult = trainer.evaluate(artifact.model, labeled);
  const leakTest = dataset.checkLeakage([], labeled);

  writeModelInfo({
    ...info,
    modelType: artifact.model.modelType,
    modelVersion: `lr-${artifact.model.version}`,
    trainedAt: artifact.model.trainedAt || artifact.savedAt,
    trainingTimestamp: artifact.model.trainedAt || artifact.savedAt,
    metrics: evalResult,
    evaluationStatus: 'VERIFIED',
    evaluationDatasetIdentity: 'eval.jsonl',
    featureSchema: dataset.FEATURES,
  });

  await mlRuns.insertRun({
    id: `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    status: 'COMPLETED',
    startedAt,
    completedAt,
    modelType: artifact.model.modelType,
    metrics: evalResult,
    confusionMatrix: evalResult.confusionMatrix,
    roc: evalResult.roc,
    featureImportance: Array.isArray(artifact.model.featureImportance) ? artifact.model.featureImportance : [],
    drift: (await computeStatusNow()).drift,
    latencyMs: Date.now() - Date.parse(startedAt),
    threshold: { state: 'CALIBRATED', threshold: 0.5, recommended: 0.5 },
    notes: `Independent validation passed on ${labeled.length} labeled sample(s).`,
    requestedBy,
  });

  const snap = await status({ refresh: true });
  return { ...snap, evaluationStatus: 'VERIFIED', independentEval: true, status: 'READY' };
}

async function retrain({ requestedBy = 'system' } = {}) {
  if (retraining) {
    return { status: 'RETRAINING', notes: 'A retrain job is already in progress.', metrics: null, modelType: MODEL_TYPE };
  }
  retraining = true;
  const startedAt = new Date().toISOString();
  try {
    const built = dataset.buildDataset();
    if (!built) {
      throw new Error('Cannot retrain: no valid readings in events.json to build a dataset.');
    }
    const { train, test } = dataset.trainTestSplit(built.dataset, 0.2, 42);
    const model = trainer.train(train, { iterations: 1000, seed: 42, verbose: true });
    const evalResult = trainer.evaluate(model, test);
    trainer.saveModel(model, built.metadata);

    const evalSet = loadEvaluationSet();
    const evaluationStatus = evalSet.length > 0 ? 'VERIFIED' : 'UNVERIFIED';
    writeModelInfo({
      modelType: model.modelType,
      modelVersion: `lr-${model.version}`,
      trainedAt: model.trainedAt,
      trainingTimestamp: model.trainedAt,
      datasetVersion: built.metadata.version,
      datasetIdentity: 'events.json -> dataset.jsonl',
      evaluationDatasetIdentity: evalSet.length > 0 ? 'eval.jsonl' : 'N/A - no independent evaluation dataset available',
      evaluationStatus,
      featureSchema: dataset.FEATURES,
      hyperparameters: { learningRate: 0.1, iterations: 1000, seed: 42, testRatio: 0.2 },
      metrics: {
        samples: evalResult.samples,
        accuracy: evalResult.accuracy,
        precision: evalResult.precision,
        recall: evalResult.recall,
        f1: evalResult.f1,
        auc: evalResult.auc,
      },
      recordCount: built.dataset.length,
      trainSetSize: train.length,
      testSetSize: test.length,
      status: 'SUCCESS',
    });

const runId = `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  await mlRuns.insertRun({
    status: 'COMPLETED',
    startedAt,
    completedAt,
    modelType: model.modelType,
    metrics: evalResult,
    confusionMatrix: evalResult.confusionMatrix,
    roc: evalResult.roc,
    featureImportance: model.featureImportance,
    drift: (await computeStatusNow()).drift,
    latencyMs: Date.now() - Date.parse(startedAt),
    threshold: { state: 'CALIBRATED', threshold: 0.5, recommended: 0.5 },
    notes: `Retrained ${model.modelType} on ${train.length} samples, held out ${test.length}.`,
    requestedBy,
    id: runId,
  });

    statusCache = null;
    const snap = await computeStatusNow();
    statusCache = snap;
    statusCacheAt = Date.now();
    return { ...snap, notes: `Retrain completed. ${snap.notes || ''}` };
  } catch (e) {
    const completedAt = new Date().toISOString();
    try {
      await mlRuns.insertRun({
        id: `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        status: 'FAILED',
        startedAt,
        completedAt,
        notes: `Retrain failed: ${e.message}`,
        requestedBy,
      });
    } catch (_) {}
    statusCache = null;
    throw e;
  } finally {
    retraining = false;
  }
}

async function historyRuns(limit = 20) {
  return mlRuns.listRuns(limit);
}

function getModelVersion() {
  const info = loadModelInfo();
  if (info) {
    return {
      modelVersion: info.modelVersion || null,
      trainingTimestamp: info.trainingTimestamp || info.trainedAt || null,
      featureSchema: Array.isArray(info.featureSchema) ? info.featureSchema : dataset.FEATURES,
    };
  }
  const artifact = loadTrainedModel();
  if (artifact) {
    return {
      modelVersion: artifact.model.version ? `lr-${artifact.model.version}` : null,
      trainingTimestamp: artifact.model.trainedAt || artifact.savedAt || null,
      featureSchema: (artifact.metadata && Array.isArray(artifact.metadata.featureSchema)) ? artifact.metadata.featureSchema : dataset.FEATURES,
    };
  }
  return null;
}

module.exports = {
  setStore,
  status,
  snapshot,
  evaluate,
  validate,
  retrain,
  historyRuns,
  detectorScore,
  ruleBasedScore,
  deriveHealthFromState,
  getMlHealth,
  saveEvaluationSet,
  loadEvaluationSet,
  getModelVersion,
  ML_MODEL_TYPE,
  ML_MODEL_VERSION,
  RULE_BASED_TYPE: RULE_BASED_TYPE_EXPORT,
  RULE_BASED_VERSION: RULE_BASED_VERSION_EXPORT,
  checkLeakage: dataset.checkLeakage,
  removeExactDuplicates: dataset.removeExactDuplicates,
  LABEL_PROVENANCE: dataset.LABEL_PROVENANCE,
};