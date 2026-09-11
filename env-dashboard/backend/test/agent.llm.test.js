'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentSupervisor } = require('../src/services/agentSupervisor');
const { DeterministicProvider, resetBudget, budgetUsed } = require('../src/services/llm');

test('agent.llm: deterministic provider produces schema-valid output', async () => {
  resetBudget();
  const sup = new AgentSupervisor({
    stations: [{ id: 'S1', name: 'S1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  sup.setLLMProvider(new DeterministicProvider());
  const task = { id: 'T1', eventId: 'E1', eventType: 'MONITOR.test', severity: 'HIGH', category: 'station', stationId: 'S1', state: 'PLANNING', plan: null, evidence: [{ kind: 'OBSERVED', tool: 'get_station_health', data: { overall: 40 } }], sources: [], findings: [], rootCause: null, confidence: null, recommendations: { items: [] }, actions: [], actionProposals: [], verification: null, status: 'ACTIVE', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: 0, toolCalls: 0, retries: 0, budgetRemaining: 100, timeline: [] };
  await sup.runLLMReasoning(task);
  assert.ok(task.llm);
  assert.equal(task.llm.provider, 'deterministic-fallback');
  assert.ok(task.llmResponse);
  assert.equal(typeof task.llmResponse.confidence, 'number');
});

test('agent.llm: schema-violating LLM output is captured, not thrown', async () => {
  resetBudget();
  const sup = new AgentSupervisor({
    stations: [{ id: 'S1' }], latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  const FakeProvider = { id: 'fake', chat: async () => ({ ok: true, provider: 'fake', model: 'fake-1', content: 'not json', tokens: { total: 0 } }) };
  sup.setLLMProvider(FakeProvider);
  const task = { id: 'T2', evidence: [], sources: [], timeline: [] };
  await sup.runLLMReasoning(task);
  assert.ok(task.llm);
  assert.ok(task.llmResponse);
  assert.equal(task.llmResponse.error, 'parse_failed');
});

test('agent.llm: budget exceeded triggers deterministic fallback', async () => {
  resetBudget();
  const sup = new AgentSupervisor({
    stations: [{ id: 'S1' }], latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  sup.setLLMProvider(new DeterministicProvider());
  sup.setLLMBudget({ daily: 0 });
  const task = { id: 'T3', evidence: [{ kind: 'OBSERVED', tool: 'get_station', data: { id: 'S1' } }], sources: [], timeline: [] };
  await sup.runLLMReasoning(task);
  assert.equal(task.llm.fallback, true);
  assert.equal(task.llm.provider, 'deterministic-fallback');
});

test('agent.llm: full investigation end-to-end with deterministic LLM', async () => {
  resetBudget();
  const sup = new AgentSupervisor({
    stations: [{ id: 'S1', name: 'S1' }],
    latestByStation: new Map(),
    providers: [], alerts: [], maintenance: [], quality: null, events: [], investigations: new Map(),
    store: null, stationHealthSvc: null, spatial: null, intelligence: null, knowledge: null,
  });
  sup.setLLMProvider(new DeterministicProvider());
  const event = { id: 'E1', type: 'MONITOR.critical_aqi_crossing', category: 'environmental', severity: 'CRITICAL', stationId: 'S1', evidence: {}, timestamp: new Date().toISOString(), snapshotId: 'SNAP-1' };
  const task = sup.triggerInvestigation(event, { stationId: 'S1' });
  assert.ok(task.id);
  await new Promise((r) => setTimeout(r, 700));
  const completed = sup.getCompletedTasks();
  const last = completed[completed.length - 1];
  assert.ok(last.llm, 'task should record LLM usage');
  assert.ok(last.timeline.some((e) => e.stage === 'LLM_REASONED'));
  assert.ok(last.rootCause);
});
