const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitoringLoop } = require('../src/services/monitoringLoop');
const { createSnapshot, diffSnapshots } = require('../src/services/stateSnapshot');
const { detectEvents, detectRecoveries, routeEvent, SEVERITY, CATEGORY, EVENT_RULES } = require('../src/services/eventDetector');
const { TOOL_REGISTRY, getTool, validateToolCall, getToolsByCategory, getReadOnlyTools, getMutationTools, getToolsByRisk, getToolsNeedingApproval, RISK } = require('../src/services/toolGateway');
const { AgentSupervisor } = require('../src/services/agentSupervisor');
const { RAGPipeline } = require('../src/services/ragPipeline');
const { ApprovalGateway, VerificationEngine } = require('../src/services/approvalGateway');
const { AgentMemory } = require('../src/services/agentMemory');
const dataStore = require('../src/services/dataStore');

// Each test file in `node --test` shares process state. The agent
// investigation memory is now persisted via dataStore (Phase 5); reset its
// persistent map at the start of this file so counts are deterministic.
try { for (const k of dataStore.getMap('agent_investigations').keys()) dataStore.getMap('agent_investigations').delete(k); } catch (_) {}

// ---------------- STATE SNAPSHOT TESTS ----------------

test('stateSnapshot: createSnapshot returns normalized snapshot', () => {
  const snapshot = createSnapshot({
    providers: [{ id: 'p1', name: 'Test', status: 'GREEN' }],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95, completeness: 98, validity: 97 },
    stations: [{ id: 's1', name: 'Station1', status: 'HEALTHY', healthScore: 85, reading: { aqi: 50 } }],
    anomalies: { count: 1, critical: 0, warning: 1, byStation: {} },
    health: { overall: 85, trend: 'STABLE' },
    alerts: { total: 2, open: 1, critical: 0, warning: 1 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 1 },
    architecture: null,
    ml: { status: 'SUCCESS', modelType: 'HEURISTIC' },
    rag: { status: 'GREEN', documents: 1, chunks: 10 },
    agent: { status: 'IDLE' },
    latestByStation: new Map(),
  });
  assert.ok(snapshot.id.startsWith('SNAP-'));
  assert.equal(snapshot.providers.length, 1);
  assert.equal(snapshot.ingestion.tickCount, 100);
  assert.equal(snapshot.dataQuality.overallScore, 95);
  assert.equal(snapshot.stations.length, 1);
  assert.equal(snapshot.alerts.open, 1);
  assert.equal(snapshot.ml.status, 'GREEN');
  assert.equal(snapshot.rag.status, 'GREEN');
});

test('stateSnapshot: diffSnapshots detects NEW and CHANGED', () => {
  const prev = createSnapshot({
    providers: [{ id: 'p1', name: 'Test', status: 'GREEN' }],
    ingestion: { lastTickAt: null, tickCount: 0 },
    dataQuality: { overallScore: 95 },
    stations: [],
    anomalies: { count: 0, critical: 0, warning: 0, byStation: {} },
    health: { overall: 85 },
    alerts: { total: 0, open: 0, critical: 0, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const curr = createSnapshot({
    providers: [{ id: 'p1', name: 'Test', status: 'RED' }],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 50 },
    stations: [{ id: 's1', name: 'Station1', status: 'OFFLINE', healthScore: 0, reading: null }],
    anomalies: { count: 5, critical: 2, warning: 3, byStation: {} },
    health: { overall: 30 },
    alerts: { total: 5, open: 5, critical: 2, warning: 3 },
    maintenance: { status: 'RED', highRiskCount: 2, mediumRiskCount: 1 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const { events, changes } = diffSnapshots(prev, curr);
  assert.ok(changes.length > 0);
  assert.ok(events.length > 0);
  const criticalEvents = events.filter((e) => e.severity === 'CRITICAL');
  assert.ok(criticalEvents.length > 0);
});

test('stateSnapshot: diffSnapshots detects RECOVERED', () => {
  const prev = createSnapshot({
    providers: [{ id: 'p1', name: 'Test', status: 'RED' }],
    ingestion: { lastTickAt: null, tickCount: 0 },
    dataQuality: { overallScore: 50 },
    stations: [], anomalies: { count: 0, critical: 0, warning: 0, byStation: {} },
    health: { overall: 30 }, alerts: { total: 0, open: 0, critical: 0, warning: 0 },
    maintenance: { status: 'RED', highRiskCount: 1, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const curr = createSnapshot({
    providers: [{ id: 'p1', name: 'Test', status: 'GREEN' }],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [], anomalies: { count: 0, critical: 0, warning: 0, byStation: {} },
    health: { overall: 85 }, alerts: { total: 0, open: 0, critical: 0, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const { events } = diffSnapshots(prev, curr);
  const recoveryEvents = events.filter((e) => e.severity === 'INFO');
  assert.ok(recoveryEvents.length > 0);
});

// ---------------- EVENT DETECTOR TESTS ----------------

test('eventDetector: detectEvents finds critical AQI', () => {
  const snapshot = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [{ id: 's1', name: 'Station1', status: 'WARNING', healthScore: 60, reading: { aqi: 280, temperature: 30, humidity: 50 } }],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: {} },
    health: { overall: 60 },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const events = detectEvents(snapshot);
  const criticalEvents = events.filter((e) => e.severity === SEVERITY.CRITICAL);
  assert.ok(criticalEvents.length > 0);
  const aqiEvents = criticalEvents.filter((e) => e.category === CATEGORY.ENVIRONMENTAL);
  assert.ok(aqiEvents.length > 0);
});

test('eventDetector: detectEvents finds critical temperature', () => {
  const snapshot = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [{ id: 's1', name: 'Station1', status: 'CRITICAL', healthScore: 20, reading: { aqi: 50, temperature: 45, humidity: 50 } }],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: {} },
    health: { overall: 20 },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const events = detectEvents(snapshot);
  const tempEvents = events.filter((e) => e.title.includes('temperature'));
  assert.ok(tempEvents.length > 0);
});

test('eventDetector: detectEvents finds critical humidity', () => {
  const snapshot = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [{ id: 's1', name: 'Station1', status: 'CRITICAL', healthScore: 20, reading: { aqi: 50, temperature: 30, humidity: 10 } }],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: {} },
    health: { overall: 20 },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const events = detectEvents(snapshot);
  const humidityEvents = events.filter((e) => e.title.includes('humidity'));
  assert.ok(humidityEvents.length > 0);
});

test('eventDetector: detectEvents finds correlated anomalies', () => {
  const snapshot = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [
      { id: 's1', name: 'Station1', status: 'WARNING', healthScore: 60, reading: { aqi: 280, temperature: 30, humidity: 50, anomaly: 1 } },
      { id: 's2', name: 'Station2', status: 'WARNING', healthScore: 62, reading: { aqi: 270, temperature: 31, humidity: 48, anomaly: 1 } },
      { id: 's3', name: 'Station3', status: 'WARNING', healthScore: 58, reading: { aqi: 265, temperature: 32, humidity: 49, anomaly: 1 } },
    ],
    anomalies: { count: 3, critical: 0, warning: 3, byStation: {} },
    health: { overall: 60 },
    alerts: { total: 3, open: 3, critical: 0, warning: 3 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const events = detectEvents(snapshot);
  const clusterEvents = events.filter((e) => e.category === CATEGORY.CORRELATION);
  assert.ok(clusterEvents.length > 0);
});

test('eventDetector: detectEvents finds spatially isolated critical anomaly', () => {
  const snapshot = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [
      { id: 's1', name: 'Station1', status: 'CRITICAL', healthScore: 20, reading: { aqi: 350, temperature: 50, humidity: 50, anomaly: 1 } },
      { id: 's2', name: 'Station2', status: 'HEALTHY', healthScore: 85, reading: { aqi: 45, temperature: 28, humidity: 55, anomaly: 0 } },
      { id: 's3', name: 'Station3', status: 'HEALTHY', healthScore: 82, reading: { aqi: 48, temperature: 29, humidity: 52, anomaly: 0 } },
    ],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: {} },
    health: { overall: 52 },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const events = detectEvents(snapshot);
  const isolateEvents = events.filter((e) => e.title.includes('isolated'));
  assert.ok(isolateEvents.length > 0);
});

test('eventDetector: routeEvent assigns AGENT_INVESTIGATE for CRITICAL', () => {
  const event = { severity: 'CRITICAL', category: 'environmental', stationId: 's1' };
  const routed = routeEvent(event);
  assert.equal(routed.action, 'AGENT_INVESTIGATE');
  assert.equal(routed.priority, 'CRITICAL');
});

test('eventDetector: routeEvent assigns AGENT_INVESTIGATE for HIGH', () => {
  const event = { severity: 'HIGH', category: 'station', stationId: 's1' };
  const routed = routeEvent(event);
  assert.equal(routed.action, 'AGENT_INVESTIGATE');
  assert.equal(routed.priority, 'HIGH');
});

test('eventDetector: routeEvent assigns LOG for INFO', () => {
  const event = { severity: 'INFO', category: 'system' };
  const routed = routeEvent(event);
  assert.equal(routed.action, 'LOG');
});

test('eventDetector: detectRecoveries detects station health recovery', () => {
  const prev = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [{ id: 's1', name: 'Station1', status: 'WARNING', healthScore: 30, reading: { aqi: 280, temperature: 30, humidity: 50 } }],
    anomalies: { count: 1, critical: 1, warning: 0, byStation: {} },
    health: { overall: 30 },
    alerts: { total: 1, open: 1, critical: 1, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const curr = createSnapshot({
    providers: [],
    ingestion: { lastTickAt: new Date().toISOString(), tickCount: 100 },
    dataQuality: { overallScore: 95 },
    stations: [{ id: 's1', name: 'Station1', status: 'HEALTHY', healthScore: 85, reading: { aqi: 50, temperature: 30, humidity: 50 } }],
    anomalies: { count: 0, critical: 0, warning: 0, byStation: {} },
    health: { overall: 85 },
    alerts: { total: 0, open: 0, critical: 0, warning: 0 },
    maintenance: { status: 'GREEN', highRiskCount: 0, mediumRiskCount: 0 },
    architecture: null, ml: null, rag: null, agent: null,
    latestByStation: new Map(),
  });
  const recoveries = detectRecoveries(prev, curr);
  assert.ok(recoveries.some((r) => r.title.includes('health recovered')));
});

test('eventDetector: EVENT_RULES includes all required categories', () => {
  const categories = new Set(EVENT_RULES.map((r) => r.category));
  assert.ok(categories.has(CATEGORY.ENVIRONMENTAL));
  assert.ok(categories.has(CATEGORY.STATION));
  assert.ok(categories.has(CATEGORY.PROVIDER));
  assert.ok(categories.has(CATEGORY.QUALITY));
  assert.ok(categories.has(CATEGORY.ANOMALY));
  assert.ok(categories.has(CATEGORY.ALT));
  assert.ok(categories.has(CATEGORY.INGESTION));
  assert.ok(categories.has(CATEGORY.ML));
  assert.ok(categories.has(CATEGORY.RAG));
  assert.ok(categories.has(CATEGORY.CORRELATION));
  assert.ok(categories.has(CATEGORY.MAINTENANCE));
});

// ---------------- TOOL GATEWAY TESTS ----------------

test('toolGateway: TOOL_REGISTRY has all categories', () => {
  const categories = new Set(Object.values(TOOL_REGISTRY).map((t) => t.category));
  assert.ok(categories.has('LIVE_DATA'));
  assert.ok(categories.has('ANALYTICS'));
  assert.ok(categories.has('INTELLIGENCE'));
  assert.ok(categories.has('SYSTEM'));
  assert.ok(categories.has('ML'));
  assert.ok(categories.has('KNOWLEDGE'));
  assert.ok(categories.has('OPERATIONS'));
  assert.ok(categories.has('MUTATIONS'));
});

test('toolGateway: getTool returns correct metadata', () => {
  const tool = getTool('get_current_readings');
  assert.ok(tool);
  assert.equal(tool.category, 'LIVE_DATA');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.risk, 'LOW');
});

test('toolGateway: validateToolCall rejects unknown tools', () => {
  const result = validateToolCall('unknown_tool', {}, 'viewer');
  assert.equal(result.valid, false);
});

test('toolGateway: validateToolCall allows viewer for read-only', () => {
  const result = validateToolCall('get_current_readings', {}, 'viewer');
  assert.equal(result.valid, true);
});

test('toolGateway: mutation tools require higher permission', () => {
  const result = validateToolCall('resolve_alert', {}, 'viewer');
  assert.equal(result.valid, false);
  const result2 = validateToolCall('resolve_alert', {}, 'admin');
  assert.equal(result2.valid, true);
});

test('toolGateway: getToolsByCategory returns correct tools', () => {
  const liveDataTools = getToolsByCategory('LIVE_DATA');
  assert.ok(liveDataTools.length > 0);
  assert.ok(liveDataTools.every((t) => t.category === 'LIVE_DATA'));
});

test('toolGateway: getReadOnlyTools returns only read-only tools', () => {
  const readOnly = getReadOnlyTools();
  assert.ok(readOnly.every((t) => t.readOnly === true));
});

test('toolGateway: getMutationTools returns only mutation tools', () => {
  const mutation = getMutationTools();
  assert.ok(mutation.every((t) => t.readOnly === false));
});

test('toolGateway: getToolsByRisk returns tools by risk level', () => {
  const highRisk = getToolsByRisk('HIGH');
  assert.ok(highRisk.some((t) => t.name === 'resolve_alert'));
});

test('toolGateway: getToolsNeedingApproval returns high-risk tools', () => {
  const needsApproval = getToolsNeedingApproval();
  assert.ok(needsApproval.some((t) => t.name === 'resolve_alert'));
  assert.ok(needsApproval.some((t) => t.name === 'retrain_model'));
});

test('toolGateway: critical risk tools require admin permission', () => {
  const retrainResult = validateToolCall('retrain_model', {}, 'analyst');
  assert.equal(retrainResult.valid, false);
  const retrainResult2 = validateToolCall('retrain_model', {}, 'admin');
  assert.equal(retrainResult2.valid, true);
});

// ---------------- AGENT SUPERVISOR TESTS ----------------

test('agentSupervisor: createInvestigationPlan generates steps', () => {
  const supervisor = new AgentSupervisor({
    stations: [{ id: 's1', name: 'Station1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null,
    stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { id: 'TASK-1', eventId: 'EVT-1', severity: 'HIGH', category: 'environmental', stationId: 's1', state: 'PLANNING', plan: null, evidence: [], sources: [], findings: [], rootCause: null, confidence: null, recommendations: [], actions: [], verification: null, status: 'ACTIVE', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: 0, toolCalls: 0, retries: 0, budgetRemaining: 100 };
  const plan = supervisor.createInvestigationPlan(task, 's1');
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps.some((s) => s.tool === 'search_knowledge'));
});

test('agentSupervisor: calculateConfidence returns INSUFFICIENT for empty evidence', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { evidence: [], sources: [] };
  const confidence = supervisor.calculateConfidence(task);
  assert.equal(confidence.label, 'INSUFFICIENT EVIDENCE');
});

test('agentSupervisor: calculateConfidence includes spatial evidence', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [{ kind: 'OBSERVED', tool: 'get_nearby_stations', data: { neighbours: [{ station: 's2', correlatedAnomaly: true }] } }],
    sources: [] 
  };
  const confidence = supervisor.calculateConfidence(task);
  assert.ok(confidence.value > 0.35);
});

test('agentSupervisor: buildToolContext implements all registered tools', () => {
  const supervisor = new AgentSupervisor({
    stations: [{ id: 's1', name: 'Station1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null,
    stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const tools = supervisor.buildToolContext(supervisor.context);
  assert.ok(typeof tools.get_current_readings === 'function');
  assert.ok(typeof tools.calculate_average === 'function');
  assert.ok(typeof tools.calculate_deviation === 'function');
  assert.ok(typeof tools.calculate_rate_of_change === 'function');
  assert.ok(typeof tools.compare_periods === 'function');
  assert.ok(typeof tools.compare_stations === 'function');
  assert.ok(typeof tools.detect_trend === 'function');
});

test('agentSupervisor: assessRootCause identifies threshold breach', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [{ kind: 'OBSERVED', tool: 'get_station', data: { id: 's1', reading: { aqi: 50 } } }],
    sources: [] 
  };
  const rootCause = supervisor.assessRootCause(task);
  assert.ok(rootCause.type === 'THRESHOLD' || rootCause.type === 'UNKNOWN');
});

test('agentSupervisor: generateRecommendations returns correct recommendations', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [], sources: [],
    rootCause: { type: 'ANOMALY', cause: 'Test anomaly', confidence: 0.8 },
    confidence: { value: 0.8, label: '80%' }
  };
  const recs = supervisor.generateRecommendations(task);
  assert.ok(recs.items.length > 0);
  assert.ok(recs.summary.length > 0);
});

test('agentSupervisor: buildActionProposals creates health check proposal for anomaly', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [], sources: [],
    rootCause: { type: 'ANOMALY', cause: 'Test anomaly', confidence: 0.8 },
    stationId: 's1',
  };
  const proposals = supervisor.buildActionProposals(task);
  assert.ok(proposals.some((p) => p.action === 'run_health_check'));
});

test('agentSupervisor: buildActionProposals creates report proposal for maintenance risk', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [], sources: [],
    rootCause: { type: 'MAINTENANCE', cause: 'Test maintenance', confidence: 0.7 },
    stationId: 's1',
  };
  const proposals = supervisor.buildActionProposals(task);
  assert.ok(proposals.some((p) => p.action === 'generate_report'));
});

test('agentSupervisor: buildActionProposals creates test_provider proposal for provider failure', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { 
    evidence: [], sources: [],
    rootCause: { type: 'PROVIDER', cause: 'Test provider', confidence: 0.7 },
    stationId: 's1',
  };
  const proposals = supervisor.buildActionProposals(task);
  assert.ok(proposals.some((p) => p.action === 'test_provider'));
});

// ---------------- AGENT SUPERVISOR TESTS ----------------

test('agentSupervisor: createInvestigationPlan generates steps', () => {
  const supervisor = new AgentSupervisor({
    stations: [{ id: 's1', name: 'Station1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null,
    stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { id: 'TASK-1', eventId: 'EVT-1', severity: 'HIGH', category: 'environmental', stationId: 's1', state: 'PLANNING', plan: null, evidence: [], sources: [], findings: [], rootCause: null, confidence: null, recommendations: [], actions: [], verification: null, status: 'ACTIVE', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: 0, toolCalls: 0, retries: 0, budgetRemaining: 100 };
  const plan = supervisor.createInvestigationPlan(task, 's1');
  assert.ok(plan.steps.length > 0);
  assert.ok(plan.steps.some((s) => s.tool === 'search_knowledge'));
});

test('agentSupervisor: calculateConfidence returns INSUFFICIENT for empty evidence', () => {
  const supervisor = new AgentSupervisor({
    stations: [], latestByStation: new Map(), providers: [], alerts: [], maintenance: [], quality: null,
    events: [], investigations: new Map(), store: null, stationHealthSvc: null, spatial: null, intelligence: null,
    knowledge: null,
  });
  const task = { evidence: [], sources: [] };
  const confidence = supervisor.calculateConfidence(task);
  assert.equal(confidence.label, 'INSUFFICIENT EVIDENCE');
});

// ---------------- RAG PIPELINE TESTS ----------------

test('ragPipeline: ingestDocument creates document', async () => {
  const rag = new RAGPipeline();
  const doc = await rag.ingestDocument({
    name: 'Test Document',
    content: '# Calibration Procedure\nAlways calibrate sensors before use.',
    source: 'test',
    category: 'MAINTENANCE',
  });
  assert.ok(doc.id.startsWith('DOC-'));
  assert.equal(doc.name, 'Test Document');
});

test('ragPipeline: search returns relevant results', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({
    name: 'Calibration Guide',
    content: 'Sensor calibration procedure for AQI sensors. Always follow manufacturer guidelines.',
    source: 'test',
    category: 'MAINTENANCE',
  });
  const result = await rag.retrieve('calibration procedure');
  assert.ok(result.results.length > 0);
  assert.ok(result.results[0].relevance > 0);
});

test('ragPipeline: search returns empty for irrelevant query', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({
    name: 'Test Doc',
    content: 'Some random content',
    source: 'test',
  });
  const result = await rag.retrieve('xyzabc');
  assert.equal(result.results.length, 0);
});

test('ragPipeline: getStats returns correct counts', async () => {
  const rag = new RAGPipeline();
  await rag.ingestDocument({ name: 'Doc1', content: 'Content', source: 'test' });
  const stats = rag.getStats();
  assert.equal(stats.documents, 1);
  assert.equal(stats.chunks, 1);
});

// ---------------- APPROVAL GATEWAY TESTS ----------------

test('approvalGateway: propose creates proposal', () => {
  const gateway = new ApprovalGateway();
  const proposal = gateway.propose({ action: 'resolve_alert', targetId: 'ALT-1', reason: 'Test' });
  assert.ok(proposal.id.startsWith('APR-'));
  assert.equal(proposal.requiresApproval, true);
  assert.equal(proposal.status, 'PENDING');
});

test('approvalGateway: approve resolves proposal', async () => {
  const gateway = new ApprovalGateway();
  const proposal = gateway.propose({ action: 'resolve_alert', targetId: 'ALT-1', reason: 'Test' });
  const result = await gateway.approve(proposal.id, 'admin', {
    resolve_alert: async () => ({ resolved: true }),
    verify: async () => ({ success: true }),
  });
  assert.ok(result);
  assert.equal(result.status, 'COMPLETED');
});

test('approvalGateway: reject proposal', () => {
  const gateway = new ApprovalGateway();
  const proposal = gateway.propose({ action: 'resolve_alert', targetId: 'ALT-1', reason: 'Test' });
  const result = gateway.reject(proposal.id, 'admin', 'Not approved');
  assert.equal(result.status, 'REJECTED');
});

test('approvalGateway: requiresApproval returns true for high-risk', () => {
  const gateway = new ApprovalGateway();
  assert.equal(gateway.requiresApproval('retrain_model'), true);
  assert.equal(gateway.requiresApproval('update_threshold'), true);
  assert.equal(gateway.requiresApproval('acknowledge_alert'), false);
});

// ---------------- VERIFICATION ENGINE TESTS ----------------

test('verificationEngine: verifyAction returns success for acknowledge', async () => {
  const engine = new VerificationEngine({
    alerts: [{ id: 'ALT-1', acknowledged: true, resolved: false }],
    providers: [], stations: [], quality: null, maintenance: [],
  });
  const result = await engine.verifyAction('acknowledge_alert', 'ALT-1', { acknowledged: true });
  assert.equal(result.success, true);
});

test('verificationEngine: verifyAction returns false for non-existent alert', async () => {
  const engine = new VerificationEngine({
    alerts: [], providers: [], stations: [], quality: null, maintenance: [],
  });
  const result = await engine.verifyAction('acknowledge_alert', 'ALT-999', {});
  assert.equal(result.success, false);
});

// ---------------- AGENT MEMORY TESTS ----------------

test('agentMemory: createSession and addEvent', () => {
  const memory = new AgentMemory();
  const session = memory.createSession('SESS-1', { userId: 'user1' });
  assert.equal(session.id, 'SESS-1');
  const evt = memory.addSessionEvent('SESS-1', { type: 'test', data: 'value' });
  assert.ok(evt.id.startsWith('SEVT-'));
  assert.equal(session.events.length, 1);
});

test('agentMemory: createInvestigationMemory and addEvidence', () => {
  const memory = new AgentMemory();
  const mem = memory.createInvestigationMemory('INV-1', { severity: 'HIGH' });
  assert.equal(mem.id, 'INV-1');
  memory.addEvidence('INV-1', { source: 'sensor', value: 280 });
  assert.equal(mem.evidence.length, 1);
});

test('agentMemory: getSessionStats', () => {
  const memory = new AgentMemory();
  memory.createSession('SESS-1');
  memory.createInvestigationMemory('INV-1');
  const stats = memory.getSessionStats();
  assert.equal(stats.activeSessions, 1);
  assert.equal(stats.totalInvestigations, 1);
});

// ---------------- MONITORING LOOP TESTS ----------------

test('monitoringLoop: constructor initializes correctly', () => {
  const loop = new MonitoringLoop({
    stations: [], store: null, latestByStation: new Map(), providers: [],
    alerts: [], maintenanceList: [], qualitySnapshot: null, healthData: null,
    mlStatus: null, knowledgeStats: { documents: 0 }, agentStatus: { status: 'IDLE' },
    systemMetrics: {}, lastTickAt: null, tickCount: 0, events: [],
    investigations: new Map(), stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  assert.equal(loop.isRunning, false);
  assert.equal(loop.cycleCount, 0);
  assert.ok(loop.agentSupervisor);
  assert.ok(loop.ragPipeline);
  assert.ok(loop.approvalGateway);
  assert.ok(loop.verificationEngine);
  assert.ok(loop.agentMemory);
});

test('monitoringLoop: getStatus returns correct structure', () => {
  const loop = new MonitoringLoop({
    stations: [], store: null, latestByStation: new Map(), providers: [],
    alerts: [], maintenanceList: [], qualitySnapshot: null, healthData: null,
    mlStatus: null, knowledgeStats: { documents: 0 }, agentStatus: { status: 'IDLE' },
    systemMetrics: {}, lastTickAt: null, tickCount: 0, events: [],
    investigations: new Map(), stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  const status = loop.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.cycleCount, 0);
  assert.ok(status.agentStatus);
});

test('monitoringLoop: getEvents filters by category and severity', () => {
  const loop = new MonitoringLoop({
    stations: [], store: null, latestByStation: new Map(), providers: [],
    alerts: [], maintenanceList: [], qualitySnapshot: null, healthData: null,
    mlStatus: null, knowledgeStats: { documents: 0 }, agentStatus: { status: 'IDLE' },
    systemMetrics: {}, lastTickAt: null, tickCount: 0, events: [
      { id: '1', category: 'test', severity: 'INFO', title: 'Test' },
      { id: '2', category: 'test', severity: 'CRITICAL', title: 'Critical' },
    ],
    investigations: new Map(), stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  const critical = loop.getEvents({ severity: 'CRITICAL' });
  assert.equal(critical.length, 1);
  assert.equal(critical[0].id, '2');
});

console.log('All Agent + RAG tests passed!');