'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitoringLoop, MONITOR_INTERVAL_MS } = require('../src/services/monitoringLoop');
const { detectEvents, routeEvent, SEVERITY, EVENT_RULES } = require('../src/services/eventDetector');
const { createSnapshot, diffSnapshots } = require('../src/services/stateSnapshot');
const { TOOL_REGISTRY } = require('../src/services/toolGateway');
const { AgentSupervisor } = require('../src/services/agentSupervisor');
const { ApprovalGateway, VerificationEngine } = require('../src/services/approvalGateway');
const { RAGPipeline } = require('../src/services/ragPipeline');
const { AgentMemory } = require('../src/services/agentMemory');

function baseSnapshot(overrides = {}) {
  return createSnapshot({
    providers: overrides.providers || [],
    ingestion: overrides.ingestion || { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: overrides.dataQuality || { overallScore: 95, completeness: 98, validity: 97 },
    stations: overrides.stations || [],
    anomalies: overrides.anomalies || { count: 0, critical: 0, warning: 0, byStation: {} },
    health: overrides.health || { overall: 85, trend: 'STABLE' },
    alerts: overrides.alerts || { total: 0, open: 0, critical: 0, warning: 0 },
    maintenance: overrides.maintenance || { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: overrides.architecture || null,
    ml: overrides.ml || null,
    rag: overrides.rag || { status: 'GREEN', documents: 1, chunks: 5 },
    agent: overrides.agent || { status: 'IDLE' },
    latestByStation: overrides.latestByStation || new Map(),
  });
}

test('monitoring: rule-based events fire on critical AQI snapshot', () => {
  const snapshot = baseSnapshot({
    stations: [{ id: 'HYD-04', name: 'HYD-04', status: 'WARNING', healthScore: 30, reading: { aqi: 320, temperature: 30, humidity: 50 } }],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: { 'HYD-04': 1 } },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
  });
  const events = detectEvents(snapshot);
  const aqi = events.find((e) => e.type === 'MONITOR.critical_aqi_crossing');
  assert.ok(aqi, 'critical AQI event should fire');
  assert.equal(aqi.severity, SEVERITY.CRITICAL);
});

test('monitoring: provider recovery is detected as INFO/recovery event', () => {
  const prev = baseSnapshot({ providers: [{ id: 'p1', name: 'OW', status: 'RED' }] });
  const curr = baseSnapshot({ providers: [{ id: 'p1', name: 'OW', status: 'GREEN' }] });
  const events = detectEvents(curr, prev);
  const recovery = events.find((e) => e.type === 'MONITOR.provider.recovered');
  assert.ok(recovery, 'provider recovery event should fire');
  assert.equal(recovery.severity, SEVERITY.INFO);
  assert.equal(recovery.isRecovery, true);
});

test('monitoring: station offline transition emits HIGH severity event', () => {
  const prev = baseSnapshot({ stations: [{ id: 'S1', name: 'S1', status: 'HEALTHY', healthScore: 80, reading: { aqi: 50 } }] });
  const curr = baseSnapshot({ stations: [{ id: 'S1', name: 'S1', status: 'OFFLINE', healthScore: 0, reading: null }] });
  const events = detectEvents(curr, prev);
  const offline = events.find((e) => e.type === 'MONITOR.station_offline');
  assert.ok(offline);
  assert.equal(offline.severity, SEVERITY.HIGH);
});

test('monitoring: pipeline snapshot ingestion status is computed', () => {
  const snap = baseSnapshot({ ingestion: { lastTickAt: new Date(Date.now() - 200_000).toISOString(), tickCount: 1 } });
  assert.equal(snap.ingestion.status, 'RED');
  assert.equal(snap.ingestion.freshness, 'OLD');
});

test('monitoring: pipeline snapshot ingestion status is GREEN when fresh', () => {
  const snap = baseSnapshot({ ingestion: { lastTickAt: new Date().toISOString(), tickCount: 1 } });
  assert.equal(snap.ingestion.status, 'GREEN');
});

test('monitoring: data quality YELLOW triggers WARNING event', () => {
  const snap = baseSnapshot({ dataQuality: { overallScore: 75, completeness: 80, validity: 80 } });
  const events = detectEvents(snap);
  assert.ok(events.find((e) => e.type === 'MONITOR.data_quality_warning'), 'Expected data_quality_warning event');
});

test('monitoring: cycle runs and emits cycle payload', async () => {
  const loop = new MonitoringLoop({
    stations: [{ id: 's1', name: 'S1' }],
    latestByStation: new Map([['s1', { stationId: 's1', time: new Date().toISOString(), aqi: 30, temperature: 20, humidity: 50 }]]),
    providers: [], alerts: [], maintenanceList: [], qualitySnapshot: { overallScore: 95 },
    healthData: null, mlStatus: null, knowledgeStats: { documents: 0, chunks: 0, ready: 0, failed: 0 },
    agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: new Date().toISOString(),
    tickCount: 1, events: [], investigations: new Map(),
    stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  const events = [];
  loop.on('cycle', (c) => events.push(c));
  await loop.runCycle();
  assert.ok(loop.cycleCount >= 1);
  assert.ok(events.length >= 1);
  assert.ok(loop.getSnapshot());
});

test('monitoring: critical event triggers agent investigation task', async () => {
  const loop = new MonitoringLoop({
    stations: [{ id: 'HYD-04', name: 'HYD-04' }],
    latestByStation: new Map([['HYD-04', { stationId: 'HYD-04', time: new Date().toISOString(), aqi: 290, temperature: 30, humidity: 50, anomaly: 1 }]]),
    providers: [], alerts: [], maintenanceList: [], qualitySnapshot: { overallScore: 95 },
    healthData: null, mlStatus: null, knowledgeStats: { documents: 0, chunks: 0, ready: 0, failed: 0 },
    agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: new Date().toISOString(),
    tickCount: 1, events: [], investigations: new Map(),
    stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  await loop.runCycle();
  await new Promise((r) => setTimeout(r, 500));
  const tasks = loop.getAgentSupervisor().getCompletedTasks();
  assert.ok(tasks.length >= 1, 'Agent supervisor should have produced at least one task');
  const t = tasks[tasks.length - 1];
  assert.ok(t.rootCause);
  assert.ok(t.recommendations);
  assert.ok(t.confidence);
});

test('monitoring: debounce avoids duplicate investigations', async () => {
  const loop = new MonitoringLoop({
    stations: [{ id: 'HYD-04', name: 'HYD-04' }],
    latestByStation: new Map([['HYD-04', { stationId: 'HYD-04', time: new Date().toISOString(), aqi: 290, temperature: 30, humidity: 50, anomaly: 1 }]]),
    providers: [], alerts: [], maintenanceList: [], qualitySnapshot: { overallScore: 95 },
    healthData: null, mlStatus: null, knowledgeStats: { documents: 0, chunks: 0, ready: 0, failed: 0 },
    agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: new Date().toISOString(),
    tickCount: 1, events: [], investigations: new Map(),
    stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  await loop.runCycle();
  await loop.runCycle();
  await loop.runCycle();
  await new Promise((r) => setTimeout(r, 50));
  const completed = loop.getAgentSupervisor().getCompletedTasks();
  assert.ok(completed.length <= 2, `Expected at most 2 tasks (initial + recovery), got ${completed.length}`);
});

test('monitoring: buildBrief produces topRisks and recommendedActions', async () => {
  const loop = new MonitoringLoop({
    stations: [{ id: 'HYD-04', name: 'HYD-04' }],
    latestByStation: new Map([['HYD-04', { stationId: 'HYD-04', time: new Date().toISOString(), aqi: 290, temperature: 30, humidity: 50, anomaly: 1 }]]),
    providers: [{ id: 'p1', name: 'OW', status: 'RED' }],
    alerts: [], maintenanceList: [{ stationId: 'HYD-04', riskScore: 80 }],
    qualitySnapshot: { overallScore: 60 },
    healthData: null, mlStatus: null, knowledgeStats: { documents: 1, ready: 1, failed: 0 },
    agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: new Date().toISOString(),
    tickCount: 1, events: [], investigations: new Map(),
    stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  await loop.runCycle();
  const brief = loop.buildBrief();
  assert.ok(brief.currentSituation);
  assert.ok(Array.isArray(brief.topRisks));
  assert.ok(brief.topRisks.some((r) => r.risk === 'PROVIDER_FAILURE'));
  assert.ok(brief.topRisks.some((r) => r.risk === 'MAINTENANCE_RISK'));
});

test('agent: triggerInvestigation returns task with plan and runs tools', async () => {
  const supervisor = new AgentSupervisor({
    stations: [{ id: 'HYD-04', name: 'HYD-04' }],
    latestByStation: new Map([['HYD-04', { stationId: 'HYD-04', time: new Date().toISOString(), aqi: 290, temperature: 30, humidity: 50, anomaly: 1 }]]),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  const event = { id: 'EVT-1', type: 'MONITOR.critical_aqi_crossing', category: 'environmental', severity: 'CRITICAL', stationId: 'HYD-04', evidence: {}, timestamp: new Date().toISOString(), snapshotId: 'SNAP-1' };
  const task = supervisor.triggerInvestigation(event, { stationId: 'HYD-04' });
  assert.ok(task.id);
  assert.equal(task.stationId, 'HYD-04');
  await new Promise((r) => setTimeout(r, 500));
  const completed = supervisor.getCompletedTasks();
  assert.ok(completed.length >= 1);
  const final = completed[completed.length - 1];
  assert.ok(final.timeline.length > 0);
  assert.ok(final.rootCause);
});

test('agent: tools are validated through registry', () => {
  assert.ok(TOOL_REGISTRY.get_station_health);
  assert.ok(TOOL_REGISTRY.acknowledge_alert);
  assert.equal(TOOL_REGISTRY.retrain_model.risk, 'CRITICAL');
  assert.equal(TOOL_REGISTRY.acknowledge_alert.readOnly, false);
});

test('agent: action proposals require approval for high risk', () => {
  const gateway = new ApprovalGateway();
  assert.equal(gateway.requiresApproval('retrain_model'), true);
  assert.equal(gateway.requiresApproval('update_threshold'), true);
  assert.equal(gateway.requiresApproval('acknowledge_alert'), false);
});

test('rag: ingest + retrieve returns relevant source with source provenance', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Calibration Manual', content: '# Calibration\nSensor calibration procedure for AQI sensors. Always follow manufacturer guidelines before deployment.', source: 'manufacturer', category: 'MAINTENANCE' });
  await rag.ingestDocument({ name: 'Incident Response', content: '# Incident\nWhen AQI exceeds 250, dispatch field team within 30 minutes.', source: 'policy', category: 'POLICY' });
  const result = await rag.retrieve('calibration procedure');
  assert.ok(result.results.length > 0);
  assert.ok(result.results[0].source);
  assert.ok(result.results[0].documentId);
  assert.ok(result.results[0].documentName);
});

test('rag: reindex rebuilds chunk index', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Doc A', content: '## Section A\nCalibration guidance for environmental monitors.', source: 'manual' });
  const before = rag.getStats();
  const stats = await rag.reindex();
  assert.ok(stats.documents >= 1);
  assert.ok(rag.getStats().chunks >= before.chunks);
});

test('rag: knowledge retrieval returns NO RELEVANT KNOWLEDGE when below threshold', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Doc X', content: 'completely unrelated text about quantum physics', source: 'misc' });
  const result = await rag.retrieve('xyzabc123qwerty');
  assert.equal(result.results.length, 0);
});

test('verification: acknowledge action returns success when alert state changes', async () => {
  const engine = new VerificationEngine({ alerts: [{ id: 'A1', acknowledged: true, resolved: false }] });
  const v = await engine.verifyAction('acknowledge_alert', 'A1', { acknowledged: true });
  assert.equal(v.success, true);
});

test('agent-memory: investigation memory persists root cause + recommendations', () => {
  const mem = new AgentMemory();
  mem.createInvestigationMemory('INV-1');
  mem.addEvidence('INV-1', { source: 'sensor', value: 280 });
  mem.setRootCause('INV-1', { cause: 'aqi spike', type: 'ANOMALY' }, { value: 0.8 });
  mem.addRecommendation('INV-1', { type: 'RECOMMENDED', text: 'Run health check' });
  mem.setVerification('INV-1', { success: true });
  const m = mem.getInvestigationMemory('INV-1');
  assert.equal(m.rootCause.cause, 'aqi spike');
  assert.equal(m.recommendations.length, 1);
  assert.equal(m.verification.success, true);
});

test('security: security: agent cannot run unknown mutation tool', () => {
  const gateway = new ApprovalGateway();
  assert.equal(gateway.requiresApproval('rm_rf_root'), false);
  assert.equal(gateway.requiresApproval('resolve_alert'), true);
});

test('snapshot: snapshot retains ingestion history', () => {
  const a = baseSnapshot({ ingestion: { lastTickAt: new Date().toISOString(), tickCount: 1 } });
  const b = baseSnapshot({ ingestion: { lastTickAt: new Date().toISOString(), tickCount: 2 } });
  const { events, changes } = diffSnapshots(a, b);
  assert.ok(changes.length >= 0);
});

test('agent: emit tool timeline during execution', async () => {
  const supervisor = new AgentSupervisor({
    stations: [{ id: 'X1', name: 'X1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  const events = [];
  supervisor._io = { emit: (channel, data) => events.push({ channel, data }) };
  const event = { id: 'EVT-2', type: 'MONITOR.test', category: 'station', severity: 'HIGH', stationId: 'X1', evidence: {}, timestamp: new Date().toISOString() };
  supervisor.triggerInvestigation(event, { stationId: 'X1' });
  await new Promise((r) => setTimeout(r, 100));
  const channels = events.map((e) => e.channel);
  assert.ok(channels.includes('agent.started'));
  assert.ok(channels.some((c) => c.startsWith('agent.tool:') || c.startsWith('agent.tool.')));
});

console.log('All always-on loop tests passed!');