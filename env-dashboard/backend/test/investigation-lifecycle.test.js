'use strict';

const path = require('path');
const fs = require('fs');

const STATE_DIR = path.resolve(__dirname, '..', 'data', 'state');
function resetState() {
  if (!fs.existsSync(STATE_DIR)) return;
  for (const f of fs.readdirSync(STATE_DIR)) {
    if (!f.startsWith('test_investigation_')) continue;
    try { fs.unlinkSync(path.join(STATE_DIR, f)); } catch (_) {}
  }
  try {
    const ds = require('./dataStore');
    for (const f of fs.readdirSync(STATE_DIR)) {
      if (f.startsWith('test_investigation_')) {
        const name = f.replace(/\.json$/, '');
        ds.resetScoped(name);
      }
    }
  } catch (_) {}
}

function log(msg) { console.log(`[TEST] ${msg}`); }
async function runTest() {
  console.log('Starting integration test...');
  resetState();
  
  // Import services
  const investigationService = require('./services/investigation');
  const agentSupervisor = require('./services/agentSupervisor');
  const monitoringLoop = require('./services/monitoringLoop');
  const { MonitoringLoop, configureRAG } = monitoringLoop;
  
  // Create a minimal context
  const context = {
    providers: [],
    stations: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 0 },
    qualitySnapshot: { status: 'GREEN', overallScore: 100 },
    anomalies: [],
    healthData: [],
    alerts: { open: [], acknowledged: [], resolved: [] },
    maintenanceList: [],
    architecture: null,
    mlStatus: {
      status: 'IDLE',
      trainingState: 'not_trained',
      modelType: 'RULE_BASED_DETECTOR',
      modelReady: false,
      inference: 'DOWN',
      evaluationStatus: 'UNVERIFIED',
      independentEval: false,
    },
    ragPipeline: null,
    events: [],
    latestByStation: new Map(),
  };
  
  log('Context created');
  
  // Test investigation creation and persistence
  log('Test 1: Creating investigation...');
  const investigation1 = investigationService.create({
    stationId: 'S-1',
    title: 'Test Investigation 1',
    evidence: [{
      source: 'get_station_health',
      data: { overall: 85, status: 'healthy' },
      type: 'OBSERVED',
    }],
  });
  
  log(`Created investigation: ${investigation1.id}, state: ${investigation1.state}`);
  assert.ok(investigation1.id, 'Investigation should have an ID');
  assert.equal(investigation1.state, 'detected', 'Initial state should be detected');
  assert.equal(investigation1.evidence.length, 1, 'Should have 1 evidence item');
  
  // Test adding evidence
  log('Test 2: Adding evidence...');
  const investigationWithEvidence = investigationService.addEvidence(investigation1.id, {
    source: 'get_anomalies',
    data: [{ id: 'A1', severity: 'medium' }],
    type: 'OBSERVED',
  });
  
  log(`Added evidence, total evidence: ${investigationWithEvidence.evidence.length}`);
  assert.equal(investigationWithEvidence.evidence.length, 2, 'Should have 2 evidence items');
  assert.equal(investigationWithEvidence.evidence[1].source, 'get_anomalies');
  
  // Test investigation listing
  log('Test 3: Listing investigations...');
  const listResult = investigationService.list();
  log(`Found ${listResult.items.length} investigations`);
  assert.equal(listResult.items.length, 1, 'Should have 1 investigation in list');
  assert.equal(listResult.items[0].id, investigation1.id);
  
  // Test investigation details
  log('Test 4: Getting investigation details...');
  const investigationDetails = investigationService.get(investigation1.id);
  log(`Retrieved investigation: ${investigationDetails.title}`);
  assert.ok(investigationDetails, 'Investigation should be retrievable');
  assert.equal(investigationDetails.title, 'Test Investigation 1');
  
  // Test adding finding
  log('Test 5: Adding finding...');
  const investigationWithFinding = investigationService.addFinding(investigation1.id, {
    type: 'ROOT_CAUSE',
    cause: 'Test root cause',
    confidence: 0.85,
  });
  
  log(`Added finding, total findings: ${investigationWithFinding.findings.length}`);
  assert.equal(investigationWithFinding.findings.length, 1, 'Should have 1 finding');
  assert.equal(investigationWithFinding.findings[0].cause, 'Test root cause');
  
  // Test state transition
  log('Test 6: Testing state transition...');
  const investigationStarted = investigationService.start(investigation1.id, 'tester', 'Investigation started');
  log(`Investigation state: ${investigationStarted.state}`);
  assert.equal(investigationStarted.state, 'investigating', 'Investigation should be investigating');
  assert.equal(investigationStarted.history.length, 2, 'Should have 2 history entries');
  
  // Test adding note
  log('Test 7: Adding note...');
  const investigationWithNote = investigationService.addNote(investigation1.id, 'tester', 'Test note for investigation');
  log(`Added note, total notes: ${investigationWithNote.notes.length}`);
  assert.equal(investigationWithNote.notes.length, 1, 'Should have 1 note');
  assert.equal(investigationWithNote.notes[0].notes, 'Test note for investigation');
  
  // Test listing with filters
  log('Test 8: Testing listing with filters...');
  const stationFiltered = investigationService.list({ stationId: 'S-1' });
  log(`Investigations for station S-1: ${stationFiltered.items.length}`);
  assert.equal(stationFiltered.items.length, 1, 'Should have 1 investigation for station S-1');
  
  // Test investigation persistence across module reload
  log('Test 9: Testing persistence across reload...');
  delete require.cache[require.resolve('./services/investigation')];
  const investigationServiceReloaded = require('./services/investigation');
  const investigationPersisted = investigationServiceReloaded.get(investigation1.id);
  log(`Retrieved investigation after reload: ${investigationPersisted?.id}`);
  assert.ok(investigationPersisted, 'Investigation should persist across reload');
  assert.equal(investigationPersisted.title, 'Test Investigation 1');
  assert.equal(investigationPersisted.evidence.length, 2, 'Evidence should persist');
  
  // Test creating second investigation
  log('Test 10: Creating second investigation...');
  const investigation2 = investigationService.create({
    stationId: 'S-2',
    title: 'Test Investigation 2',
    evidence: [{
      source: 'get_alerts',
      data: { count: 3 },
      type: 'OBSERVED',
    }],
  });
  
  log(`Created second investigation: ${investigation2.id}`);
  
  // Test listing all investigations
  log('Test 11: Listing all investigations...');
  const allInvestigations = investigationService.list();
  log(`Total investigations: ${allInvestigations.items.length}`);
  assert.equal(allInvestigations.items.length, 2, 'Should have 2 total investigations');
  
  // Test search functionality
  log('Test 12: Testing search functionality...');
  const searchResult = investigationService.list({ search: 'Test Investigation 1' });
  log(`Search results for "Test Investigation 1": ${searchResult.items.length}`);
  assert.equal(searchResult.items.length, 1, 'Should find 1 investigation with title "Test Investigation 1"');
  assert.equal(searchResult.items[0].id, investigation1.id);
  
  console.log('\n✅ All investigation tests passed!');
  return true;
}

// Simple assertion function for Node test environment
function assert(condition, message) {
  if (!condition) {
    console.error(`❌ Assertion failed: ${message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  runTest().then(() => {
    console.log('\n🎉 All integration tests completed successfully!');
    process.exit(0);
  }).catch((error) => {
    console.error('❌ Integration test failed:', error.message);
    process.exit(1);
  });
}

module.exports = { runTest };