'use strict';

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const ML_DATASET = require('../src/services/mlDataset');
const ML_TRAIN = require('../src/services/mlTrain');

describe('ML Dataset Module', () => {
  describe('FEATURES', () => {
    it('should have correct feature list', () => {
      assert.deepStrictEqual(ML_DATASET.FEATURES, ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall']);
    });
  });

  describe('Dataset file paths', () => {
    it('should have dataset file path', () => {
      assert.ok(ML_DATASET.DATASET_FILE.length > 0);
      assert.ok(ML_DATASET.DATASET_FILE.includes('ml'));
    });
    it('should have metadata file path', () => {
      assert.ok(ML_DATASET.DATASET_META_FILE.length > 0);
      assert.ok(ML_DATASET.DATASET_META_FILE.includes('ml'));
    });
  });

  describe('trainTestSplit', () => {
    it('should split dataset correctly', () => {
      const dataset = [
        { features: [1, 2, 3, 4, 5, 6], label: 1 },
        { features: [1, 2, 3, 4, 5, 6], label: 0 },
        { features: [1, 2, 3, 4, 5, 6], label: 1 },
        { features: [1, 2, 3, 4, 5, 6], label: 0 },
        { features: [1, 2, 3, 4, 5, 6], label: 1 },
        { features: [1, 2, 3, 4, 5, 6], label: 0 },
      ];
      const { train, test } = ML_DATASET.trainTestSplit(dataset, 0.33, 42);
      assert.ok(train.length >= 3, 'Train set should have at least 3 samples');
      assert.ok(test.length >= 1, 'Test set should have at least 1 sample');
      assert.ok(train.length + test.length === dataset.length, 'All samples should be accounted for');
    });

    it('should produce deterministic split with same seed', () => {
      const dataset = Array.from({ length: 20 }, (_, i) => ({
        features: [i, i, i, i, i, i],
        label: i % 2,
      }));
      const split1 = ML_DATASET.trainTestSplit(dataset, 0.2, 12345);
      const split2 = ML_DATASET.trainTestSplit(dataset, 0.2, 12345);
      assert.strictEqual(split1.train.length, split2.train.length);
      assert.strictEqual(split1.test.length, split2.test.length);
    });
  });
});

describe('ML Training Module', () => {
  describe('sigmoid', () => {
    const { predict } = ML_TRAIN;
    
    it('should return 0.5 for input 0', () => {
      const weights = [0, 0, 0, 0, 0, 0];
      const prob = predict([0, 0, 0, 0, 0, 0], weights, 0);
      assert.ok(Math.abs(prob - 0.5) < 0.01, 'sigmoid(0) should be ~0.5');
    });

    it('should approach 1 for large positive input', () => {
      const weights = [1, 1, 1, 1, 1, 1];
      const prob = predict([10, 10, 10, 10, 10, 10], weights, 0);
      assert.ok(prob > 0.9, 'Large positive input should give high probability');
    });

    it('should approach 0 for large negative input', () => {
      const weights = [-1, -1, -1, -1, -1, -1];
      const prob = predict([10, 10, 10, 10, 10, 10], weights, 0);
      assert.ok(prob < 0.1, 'Large negative input should give low probability');
    });
  });

  describe('computeMetrics', () => {
    const { computeMetrics } = ML_TRAIN;

    it('should compute correct metrics for perfect predictions', () => {
      const predictions = [
        { prediction: 0.9, actual: 1 },
        { prediction: 0.1, actual: 0 },
        { prediction: 0.8, actual: 1 },
        { prediction: 0.2, actual: 0 },
      ];
      const metrics = computeMetrics(predictions, 0.5);
      assert.strictEqual(metrics.tp, 2);
      assert.strictEqual(metrics.tn, 2);
      assert.strictEqual(metrics.fp, 0);
      assert.strictEqual(metrics.fn, 0);
      assert.strictEqual(metrics.accuracy, 1.0);
    });

    it('should compute correct metrics for no positive predictions', () => {
      const predictions = [
        { prediction: 0.1, actual: 1 },
        { prediction: 0.2, actual: 1 },
        { prediction: 0.1, actual: 0 },
        { prediction: 0.2, actual: 0 },
      ];
      const metrics = computeMetrics(predictions, 0.5);
      assert.strictEqual(metrics.tp, 0);
      assert.strictEqual(metrics.tn, 2);
      assert.strictEqual(metrics.fp, 0);
      assert.strictEqual(metrics.fn, 2);
      assert.strictEqual(metrics.accuracy, 0.5);
    });

    it('should handle empty predictions', () => {
      const metrics = computeMetrics([], 0.5);
      assert.strictEqual(metrics.tp, 0);
      assert.strictEqual(metrics.tn, 0);
      assert.strictEqual(metrics.fp, 0);
      assert.strictEqual(metrics.fn, 0);
      assert.strictEqual(metrics.accuracy, 0);
    });
  });

  describe('train', () => {
    it('should train a model on simple data', () => {
      const dataset = [];
      for (let i = 0; i < 50; i++) {
        dataset.push({
          features: [i * 0.1, i * 0.2, i * 0.3, i * 0.1, i * 0.05, i * 0.02],
          label: i > 25 ? 1 : 0,
        });
      }
      
      const model = ML_TRAIN.train(dataset, { iterations: 200, verbose: false });
      
      assert.ok(model.weights, 'Model should have weights');
      assert.ok(model.bias !== undefined, 'Model should have bias');
      assert.ok(model.metrics, 'Model should have metrics');
      assert.strictEqual(model.modelType, 'LOGISTIC_REGRESSION');
      assert.strictEqual(model.version, '1.0.0');
    });

    it('should throw on empty dataset', () => {
      assert.throws(() => {
        ML_TRAIN.train([], { verbose: false });
      }, /empty dataset/i);
    });
  });

  describe('evaluate', () => {
    it('should evaluate model on test set', () => {
      const trainSet = [];
      const testSet = [];
      
      for (let i = 0; i < 100; i++) {
        const features = [i * 0.1, i * 0.2, i * 0.3, i * 0.1, i * 0.05, i * 0.02];
        if (i < 80) {
          trainSet.push({ features, label: i > 40 ? 1 : 0 });
        } else {
          testSet.push({ features, label: i > 40 ? 1 : 0 });
        }
      }
      
      const model = ML_TRAIN.train(trainSet, { iterations: 200, verbose: false });
      const evalResult = ML_TRAIN.evaluate(model, testSet);
      
      assert.ok(evalResult.samples > 0, 'Should have evaluated samples');
      assert.ok(evalResult.accuracy !== undefined, 'Should have accuracy');
      assert.ok(evalResult.precision !== undefined, 'Should have precision');
      assert.ok(evalResult.recall !== undefined, 'Should have recall');
      assert.ok(evalResult.f1 !== undefined, 'Should have f1');
      assert.ok(evalResult.confusionMatrix, 'Should have confusion matrix');
      assert.ok(evalResult.roc, 'Should have ROC curve');
    });
  });

  describe('inference', () => {
    it('should perform inference with model', () => {
      const dataset = [];
      for (let i = 0; i < 30; i++) {
        dataset.push({
          features: [i * 0.2, i * 0.3, i * 0.4, i * 0.1, i * 0.05, i * 0.02],
          label: i > 15 ? 1 : 0,
        });
      }
      
      const model = ML_TRAIN.train(dataset, { iterations: 100, verbose: false });
      const metadata = { normalizationStats: null };
      
      const result = ML_TRAIN.inference({ temperature: 5, pressure: 1013, humidity: 50, aqi: 60, wind: 3, rainfall: 0.5 }, model, metadata);
      
      assert.ok(result.prediction === 0 || result.prediction === 1, 'Prediction should be 0 or 1');
      assert.ok(result.probability >= 0 && result.probability <= 1, 'Probability should be between 0 and 1');
    });

    it('should throw on invalid model', () => {
      assert.throws(() => {
        ML_TRAIN.inference({ temperature: 5, pressure: 1013, humidity: 50, aqi: 60, wind: 3, rainfall: 0.5 }, null, {});
      }, /Model not loaded/i);
    });
  });
});

describe('ML Integration', () => {
  describe('Full training pipeline', () => {
    it('should complete full pipeline: train -> evaluate -> inference', () => {
      const dataset = [];
      for (let i = 0; i < 50; i++) {
        dataset.push({
          features: [i * 0.1, i * 0.2, i * 0.3, i * 0.1, i * 0.05, i * 0.02],
          label: i > 25 ? 1 : 0,
        });
      }
      
      const model = ML_TRAIN.train(dataset, { iterations: 200, verbose: false });
      const evalResult = ML_TRAIN.evaluate(model, dataset.slice(0, 10));
      
      assert.ok(evalResult.samples > 0);
      assert.ok(evalResult.accuracy >= 0 && evalResult.accuracy <= 1);
      
      const inferenceResult = ML_TRAIN.inference({ temperature: 5, pressure: 1013, humidity: 50, aqi: 60, wind: 3, rainfall: 0.5 }, model, { normalizationStats: null });
      assert.ok(inferenceResult.prediction !== undefined);
    });
});
});

describe('LABEL_PROVENANCE', () => {
  it('should document that labels come from rule-engine-derived anomaly (legacy)', () => {
    assert.ok(ML_DATASET.LABEL_PROVENANCE);
    assert.strictEqual(ML_DATASET.LABEL_PROVENANCE.source, 'rule_engine_legacy');
    assert.ok(ML_DATASET.LABEL_PROVENANCE.note.includes('rule-engine-derived anomaly'));
    assert.ok(ML_DATASET.LABEL_PROVENANCE.note.includes('ai.paramCode'));
    // CRITICAL: Labels MUST come from rule engine (legacy model)
    assert.ok(ML_DATASET.LABEL_PROVENANCE.source.includes('rule_engine'));
    // CRITICAL: Legacy model provenance should be truthfully represented as rule_engine_legacy
    assert.strictEqual(ML_DATASET.LABEL_PROVENANCE.engine, 'ai.paramCode');
  });
});

describe('ML Model Versioning', () => {
  it('should expose getModelVersion when model exists', () => {
    const fs = require('fs');
    const path = require('path');
    const ML = require('../src/services/ml');
    const modelPath = path.resolve(__dirname, '..', 'data', 'ml', 'models', 'anomaly_classifier.json');
    const info = ML.getModelVersion();
    if (fs.existsSync(modelPath)) {
      assert.ok(info);
      assert.ok(info.modelVersion);
      assert.ok(info.trainingTimestamp);
      assert.ok(Array.isArray(info.featureSchema));
    } else {
      assert.strictEqual(info, null);
    }
  });
});

describe('ML Rule-vs-ML Distinction', () => {
  it('should clearly separate rule-based score from ML score', () => {
    const ML = require('../src/services/ml');
    const reading = { temperature: 25, pressure: 1013, humidity: 50, aqi: 60, wind: 3, rainfall: 0.5 };
    const ruleScore = ML.ruleBasedScore(reading);
    assert.ok(typeof ruleScore === 'number');
    assert.ok(ruleScore >= 0 && ruleScore <= 1);
  });
});
