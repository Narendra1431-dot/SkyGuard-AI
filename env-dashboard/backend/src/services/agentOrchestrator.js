'use strict';

const { randomUUID } = require('crypto');
const assistant2 = require('./assistant2');
const toolGateway = require('./toolGateway');

const RISK = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' };

const REGISTRY = Object.fromEntries(
  Object.entries(toolGateway.TOOL_REGISTRY).map(([name, tool]) => [
    name,
    {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      readOnly: tool.readOnly,
      requiresApproval: tool.risk === 'HIGH' || tool.risk === 'CRITICAL',
      permissions: tool.readOnly ? ['viewer', 'analyst', 'admin'] : ['analyst', 'admin'],
      requiredPermission: tool.readOnly ? 'viewer' : 'analyst',
      riskLevel: tool.risk,
      inputSchema: tool.schema || { type: 'object' },
      outputSchema: { type: 'object' },
      timeout: tool.timeout || 5000,
      auditAction: tool.auditAction || `agent.${name}`,
    },
  ])
);

function intentFor(query) {
  const text = String(query || '').toLowerCase();
  if (/why is .* unhealthy|why is .* critical/.test(text)) return 'investigate_first';
  return assistant2.classify(query || '');
}

function stationIdFor(query, stations) {
  const text = String(query || '').toLowerCase();
  return stations.find((station) => text.includes(String(station.id).toLowerCase()) || text.includes(String(station.name).toLowerCase()))?.id || null;
}

function confidenceFor(evidence, sources) {
  const live = evidence.filter((item) => item.kind === 'OBSERVED').length;
  const retrieved = sources.filter((source) => source.relevance >= 0.5).length;
  if (!live && !retrieved) return { value: null, label: 'Not available', basis: [] };
  const value = Math.min(0.98, +(0.35 + Math.min(live, 5) * 0.08 + Math.min(retrieved, 3) * 0.08).toFixed(2));
  return { value, label: `${Math.round(value * 100)}%`, basis: [`${live} live evidence item(s)`, `${retrieved} relevant knowledge source(s)`] };
}

function createPlan(requestId, userId, query, stationId) {
  const intent = intentFor(query);
  const names = stationId || intent === 'investigate_first'
    ? ['get_station', 'get_station_health', 'get_anomalies', 'get_station_history', 'get_nearby_stations', 'get_provider_status', 'get_maintenance_risk', 'search_knowledge']
    : intent === 'help' ? [] : ['get_current_readings', 'get_provider_status', 'get_maintenance_risk'];
  return { requestId, userId: userId || null, intent, goal: query, steps: names.map((tool) => ({ tool, parameters: { stationId }, status: 'pending' })), evidence: [], sources: [], confidence: null, recommendations: [], actions: [], approvalRequired: false, status: 'planned' };
}

async function executeTool(step, context) {
  const metadata = REGISTRY[step.tool];
  if (!metadata) throw new Error(`Tool is not registered: ${step.tool}`);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const result = await context.tools[step.tool](step.parameters || {});
    return { ...step, startedAt, finishedAt: new Date().toISOString(), latency: Date.now() - started, status: 'completed', result };
  } catch (error) {
    return { ...step, startedAt, finishedAt: new Date().toISOString(), latency: Date.now() - started, status: 'failed', error: error.message };
  }
}

async function run({ query, userId, context, requestId = `REQ-${randomUUID()}` }) {
  const stationId = stationIdFor(query, context.stations);
  const plan = createPlan(requestId, userId, query, stationId);
  plan.status = 'running';
  const toolCalls = [];
  for (const step of plan.steps) {
    const call = await executeTool(step, context);
    toolCalls.push(call);
    if (call.status === 'completed') {
      if (call.tool === 'search_knowledge') plan.sources = call.result.results || [];
      else plan.evidence.push({ kind: 'OBSERVED', tool: call.tool, data: call.result });
    }
  }
  plan.steps = toolCalls;
  plan.status = 'completed';
  plan.confidence = confidenceFor(plan.evidence, plan.sources);
  const stationEvidence = plan.evidence.find((item) => item.tool === 'get_station');
  const healthEvidence = plan.evidence.find((item) => item.tool === 'get_station_health');
  if (stationId && healthEvidence?.data) {
    plan.recommendations = [{ type: 'RECOMMENDED', text: healthEvidence.data.status === 'critical' ? 'Review critical station evidence and run a verified health check.' : 'Continue monitoring the station and review the cited operating guidance.' }];
  }
  const knowledgeUnavailable = plan.steps.some((step) => step.tool === 'search_knowledge' && step.status === 'completed' && !step.result.available);
  const answer = stationId && healthEvidence?.data
    ? `Assessment for ${stationEvidence?.data?.name || stationId}: health is ${healthEvidence.data.status || 'NOT AVAILABLE'}. ${plan.sources.length ? `Retrieved ${plan.sources.length} relevant knowledge source(s).` : knowledgeUnavailable ? 'Knowledge retrieval unavailable.' : 'No relevant knowledge source was found.'}`
    : plan.evidence.length ? `Collected ${plan.evidence.length} live evidence set(s) for ${plan.intent.toLowerCase()}.` : 'INSUFFICIENT EVIDENCE';
  return {
    requestId, intent: plan.intent, answer, liveEvidence: plan.evidence, knowledgeSources: plan.sources,
    reasoning: plan.evidence.map((item) => ({ type: 'OBSERVED', tool: item.tool, summary: 'Backend result collected.' })),
    confidence: plan.confidence, recommendations: plan.recommendations, proposedActions: [], approvalRequired: false,
    plan, toolCalls,
  };
}

module.exports = { REGISTRY, RISK, intentFor, createPlan, run };
