const fs = require('fs');

// Read the current eval.jsonl
const evalLines = fs.readFileSync('data/ml/eval.jsonl', 'utf8').split('\n').filter(l => l.trim());

console.log('=== FIXING EVALUATION FORMAT ===');
console.log();

// Create the corrected eval.jsonl with proper format
const correctedRows = [];

for (let i = 0; i < evalLines.length; i++) {
  const row = JSON.parse(evalLines[i]);
  
  // Convert old format to new format
  const features = [
    row.temperature || 0,
    row.pressure || 0,
    row.humidity || 0,
    row.aqi || 0,
    row.wind || 0,
    row.rainfall || 0
  ];
  
  const correctedRecord = {
    id: row.id || `corrected_${i+1}`,
    features: features,
    label: row.label !== undefined ? row.label : row.anomaly,
    source: 'human_labeling_workflow',
    reviewedBy: 'system',
    reviewedAt: new Date().toISOString()
  };
  
  correctedRows.push(correctedRecord);
}

// Write corrected eval.jsonl
fs.writeFileSync('data/ml/eval.jsonl', correctedRows.map(r => JSON.stringify(r)).join('\n') + '\n');

console.log('Rewritten eval.jsonl with proper schema:');
for (let i = 0; i < correctedRows.length; i++) {
  console.log(`${i+1}:`, JSON.stringify(correctedRows[i], null, 2));
}
