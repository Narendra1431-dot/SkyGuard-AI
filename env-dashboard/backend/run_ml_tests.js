const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert');

const ML_DATASET = require('./src/services/mlDataset');

console.log('Testing ML_DATASET.LABEL_PROVENANCE...');
console.log('Source:', ML_DATASET.LABEL_PROVENANCE.source);
console.log('Expected: rule_engine_legacy');
console.log('Match:', ML_DATASET.LABEL_PROVENANCE.source === 'rule_engine_legacy');

if (ML_DATASET.LABEL_PROVENANCE.source !== 'rule_engine_legacy') {
  console.log('FAILED: Provenance source is not rule_engine_legacy');
  process.exit(1);
}

if (!ML_DATASET.LABEL_PROVENANCE.note.includes('rule-engine-derived anomaly')) {
  console.log('FAILED: Note does not contain rule-engine-derived');
  process.exit(1);
}

console.log('PASSED: All provenance tests');
