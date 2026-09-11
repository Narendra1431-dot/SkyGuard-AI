'use strict';

const fs = require('fs');
const path = require('path');
const { loadDataset, loadMetadata, FEATURES } = require('./mlDataset');

const MODEL_DIR = path.resolve(__dirname, '..', '..', 'data', 'ml', 'models');
const MODEL_FILE = path.resolve(MODEL_DIR, 'anomaly_classifier.json');

function ensureDir() {
  try { fs.mkdirSync(MODEL_DIR, { recursive: true }); } catch (_) {}
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, z))));
}

function dot(a, b) {
  return a.reduce((s, v, i) => s + v * (b[i] || 0), 0);
}

function addVectors(a, b) {
  return a.map((v, i) => v + (b[i] || 0));
}

function scaleVector(v, s) {
  return v.map(x => x * s);
}

function predict(x, weights, bias) {
  const z = dot(x, weights) + bias;
  return sigmoid(z);
}

function predictBatch(samples, weights, bias) {
  return samples.map(s => ({
    prediction: predict(s.features, weights, bias),
    actual: s.label,
  }));
}

function computeMetrics(predictions, threshold = 0.5) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const p of predictions) {
    const pred = p.prediction >= threshold ? 1 : 0;
    if (pred === 1 && p.actual === 1) tp++;
    else if (pred === 1 && p.actual === 0) fp++;
    else if (pred === 0 && p.actual === 1) fn++;
    else tn++;
  }
  const total = tp + fp + fn + tn;
  const accuracy = total > 0 ? (tp + tn) / total : 0;
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
  return { tp, fp, fn, tn, accuracy, precision, recall, f1 };
}

function computeAuc(predictions) {
  const sorted = [...predictions].sort((a, b) => b.prediction - a.prediction);
  let auc = 0;
  let posCount = predictions.filter(p => p.actual === 1).length;
  let negCount = predictions.length - posCount;
  if (posCount === 0 || negCount === 0) return 0;
  
  let prevFpr = 0;
  let prevTpr = 0;
  for (let i = 0; i <= predictions.length; i++) {
    const threshold = i / predictions.length;
    const above = sorted.filter(p => p.prediction >= threshold);
    const tp = above.filter(p => p.actual === 1).length;
    const fp = above.filter(p => p.actual === 0).length;
    const fpr = fp / negCount;
    const tpr = tp / posCount;
    auc += (fpr - prevFpr) * (prevTpr + tpr) / 2;
    prevFpr = fpr;
    prevTpr = tpr;
  }
  return Math.max(0, Math.min(1, auc));
}

function computeRocPoints(predictions, steps = 21) {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const threshold = i / (steps - 1);
    const sorted = [...predictions].sort((a, b) => b.prediction - a.prediction);
    let posCount = predictions.filter(p => p.actual === 1).length;
    let negCount = predictions.length - posCount;
    const above = sorted.filter(p => p.prediction >= threshold);
    const tp = above.filter(p => p.actual === 1).length;
    const fp = above.filter(p => p.actual === 0).length;
    const fpr = negCount > 0 ? fp / negCount : 0;
    const tpr = posCount > 0 ? tp / posCount : 0;
    points.push({ threshold, fpr: +fpr.toFixed(4), tpr: +tpr.toFixed(4) });
  }
  return points;
}

function train(dataset, options = {}) {
  const {
    learningRate = 0.1,
    iterations = 1000,
    seed = 42,
    verbose = true,
  } = options;
  
  if (dataset.length === 0) {
    throw new Error('Cannot train on empty dataset');
  }
  
  const featureCount = FEATURES.length;
  let weights = new Array(featureCount).fill(0);
  let bias = 0;
  
  const posCount = dataset.filter(s => s.label === 1).length;
  const negCount = dataset.length - posCount;
  const scale = { pos: dataset.length / (2 * posCount), neg: dataset.length / (2 * negCount) };
  
  let bestWeights = [...weights];
  let bestBias = bias;
  let bestF1 = 0;
  
  for (let iter = 0; iter < iterations; iter++) {
    let gradients_w = new Array(featureCount).fill(0);
    let gradients_b = 0;
    
    for (const sample of dataset) {
      const pred = predict(sample.features, weights, bias);
      const label = sample.label;
      const scaledLabel = label === 1 ? scale.pos : -scale.neg;
      const error = (pred - label) * scaledLabel;
      for (let j = 0; j < featureCount; j++) {
        gradients_w[j] += error * sample.features[j];
      }
      gradients_b += error;
    }
    
    gradients_w = scaleVector(gradients_w, learningRate / dataset.length);
    gradients_b *= learningRate / dataset.length;
    
    weights = weights.map((w, j) => w - gradients_w[j]);
    bias -= gradients_b;
    
    if (iter % 100 === 0 && verbose) {
      const predictions = predictBatch(dataset, weights, bias);
      const metrics = computeMetrics(predictions);
      console.log(`[ml-train] Iter ${iter}: accuracy=${metrics.accuracy.toFixed(3)}, precision=${metrics.precision.toFixed(3)}, recall=${metrics.recall.toFixed(3)}, f1=${metrics.f1.toFixed(3)}`);
      if (metrics.f1 > bestF1) {
        bestF1 = metrics.f1;
        bestWeights = [...weights];
        bestBias = bias;
      }
    }
  }
  
  weights = bestWeights;
  bias = bestBias;
  
  const predictions = predictBatch(dataset, weights, bias);
  const trainMetrics = computeMetrics(predictions);
  const auc = computeAuc(predictions);
  
  if (verbose) {
    console.log('[ml-train] Final training metrics:');
    console.log(`[ml-train]   accuracy=${trainMetrics.accuracy.toFixed(4)}`);
    console.log(`[ml-train]   precision=${trainMetrics.precision.toFixed(4)}`);
    console.log(`[ml-train]   recall=${trainMetrics.recall.toFixed(4)}`);
    console.log(`[ml-train]   f1=${trainMetrics.f1.toFixed(4)}`);
    console.log(`[ml-train]   auc=${auc.toFixed(4)}`);
  }
  
  const featureImportance = weights.map((w, i) => ({
    name: FEATURES[i],
    weight: w,
    importance: Math.abs(w),
  })).sort((a, b) => b.importance - a.importance);
  
  return {
    weights,
    bias,
    metrics: { ...trainMetrics, auc },
    featureImportance,
    featureCount,
    modelType: 'LOGISTIC_REGRESSION',
    version: '1.0.0',
    trainedAt: new Date().toISOString(),
  };
}

function evaluate(model, testSet) {
  const predictions = predictBatch(testSet, model.weights, model.bias);
  const metrics = computeMetrics(predictions);
  const auc = computeAuc(predictions);
  const roc = computeRocPoints(predictions);
  const confusionMatrix = {
    matrix: [
      [metrics.tn, metrics.fp],
      [metrics.fn, metrics.tp],
    ],
    labels: ['negative', 'positive'],
  };
  
  return {
    samples: testSet.length,
    accuracy: +metrics.accuracy.toFixed(4),
    precision: +metrics.precision.toFixed(4),
    recall: +metrics.recall.toFixed(4),
    f1: +metrics.f1.toFixed(4),
    auc: +auc.toFixed(4),
    tp: metrics.tp,
    fp: metrics.fp,
    fn: metrics.fn,
    tn: metrics.tn,
    confusionMatrix,
    roc,
  };
}

function inference(reading, model, metadata) {
  if (!model || !model.weights) {
    throw new Error('Model not loaded');
  }
  
  const stats = metadata?.normalizationStats;
  const normalizedFeatures = [];
  
  for (const f of FEATURES) {
    const val = reading[f];
    if (val == null || isNaN(val)) {
      normalizedFeatures.push(0);
      continue;
    }
    if (stats && stats[f]) {
      const s = stats[f];
      normalizedFeatures.push((val - s.mean) / s.std);
    } else {
      normalizedFeatures.push(val);
    }
  }
  
  const probability = predict(normalizedFeatures, model.weights, model.bias);
  const prediction = probability >= 0.5 ? 1 : 0;
  
  return {
    prediction,
    probability: +probability.toFixed(4),
    features: normalizedFeatures,
  };
}

function saveModel(model, metadata) {
  ensureDir();
  const artifact = {
    model,
    metadata,
    savedAt: new Date().toISOString(),
  };
  fs.writeFileSync(MODEL_FILE, JSON.stringify(artifact));
  console.log(`[ml-train] Model saved to ${MODEL_FILE}`);
  return MODEL_FILE;
}

function loadModel() {
  if (!fs.existsSync(MODEL_FILE)) {
    return null;
  }
  try {
    const artifact = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
    return artifact;
  } catch (e) {
    console.error('[ml-train] Failed to load model:', e.message);
    return null;
  }
}

function modelExists() {
  return fs.existsSync(MODEL_FILE);
}

function getModelInfo() {
  const artifact = loadModel();
  if (!artifact) return null;
  return {
    modelType: artifact.model.modelType,
    version: artifact.model.version,
    trainedAt: artifact.model.trainedAt,
    metrics: artifact.model.metrics,
    featureCount: artifact.model.featureCount,
  };
}

module.exports = {
  train,
  evaluate,
  inference,
  saveModel,
  loadModel,
  modelExists,
  getModelInfo,
  MODEL_FILE,
  predict,
  computeMetrics,
};
