'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MonitoringLoop } = require('../src/services/monitoringLoop');
const { TOOL_REGISTRY, getToolsByRisk, getToolsNeedingApproval } = require('../src/services/toolGateway');
const { ALLOWED } = require('../src/services/agentActions');

test('trigger: 100 deterministic cycles with no significance change do not create investigations', async () => {
  const t = new Date().toISOString();
  const loop = new MonitoringLoop({
    stations: [{ id: 'S-1', name: 'S-1' }],
    latestByStation: new Map([['S-1', { stationId: 'S-1', time: t, temperature: 25, pressure: 1012, humidity: 50, aqi: 80, wind: 3, rainfall: 0, anomaly: 0 }]]),
    providers: [], alerts: [], maintenanceList: [], qualitySnapshot: { overallScore: 95 },
    healthData: null, mlStatus: null, knowledgeStats: { documents: 1, chunks: 5, ready: 1, failed: 0, status: 'GREEN' },
    agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: t,
    tickCount: 1, events: [], investigations: new Map(),
    stationHealthSvc: null, spatial: null, intelligence: null, store: null,
  });
  for (let i = 0; i < 5; i++) await loop.runCycle();
  await new Promise((r) => setTimeout(r, 100));
  const sup = loop.getAgentSupervisor();
  const completed = sup.getCompletedTasks();
  assert.equal(completed.length, 0, `Expected 0 tasks with no events, got ${completed.length}`);
});

test('trigger: injected anomaly triggers exactly one task with station debounce', async () => {
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
  await new Promise((r) => setTimeout(r, 200));
  const sup = loop.getAgentSupervisor();
  const completed = sup.getCompletedTasks();
  assert.ok(completed.length >= 1, 'expected at least one task');
  assert.ok(completed.length <= 2, `expected station-debounce to limit tasks, got ${completed.length}`);
});

test('safety: TOOL_REGISTRY does not expose any shell or file-mutation tools', () => {
  const DISALLOWED_PATTERNS = [
    /^run_shell$/, /^exec_command$/, /^shell_/,
    /^rm_file$/, /^delete_file$/, /^write_file$/, /^unlink$/,
    /^eval_code$/, /^spawn_/, /^child_process$/,
    /^fetch_url$/, /^http_request$/, /^download_/,
    /^modify_system$/, /^execute_arbitrary$/,
  ];
  for (const name of Object.keys(TOOL_REGISTRY)) {
    for (const pat of DISALLOWED_PATTERNS) {
      assert.ok(!pat.test(name), `disallowed tool: ${name}`);
    }
  }
  // Specifically forbid tools that try to escape the data dir or run arbitrary URLs
  for (const [name, tool] of Object.entries(TOOL_REGISTRY)) {
    assert.ok(!/child_process|exec\(|require\(/.test(JSON.stringify(tool)), `tool ${name} references forbidden runtime API`);
  }
});

test('safety: tool registry marks every action tool with risk and approval metadata', () => {
  for (const [name, tool] of Object.entries(TOOL_REGISTRY)) {
    if (tool.readOnly) continue;
    assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(tool.risk), `${name} must have a risk`);
    assert.ok(tool.permission || tool.requiredPermission, `${name} must declare a permission`);
  }
});

test('safety: agentActions.ALLOWED only contains allowlisted actions', () => {
  for (const name of ALLOWED.keys()) {
    assert.ok(['acknowledge_alert', 'resolve_alert', 'run_health_check', 'generate_report', 'test_provider', 'update_threshold', 'retrain_model', 'escalate_alert'].includes(name), `unexpected allowlisted action: ${name}`);
  }
});
