'use strict';

const { randomUUID } = require('crypto');
const { TOOL_REGISTRY, executeTool, getToolsByCategory, validateToolCall } = require('./toolGateway');
const { AgentMemory } = require('./agentMemory');
const { routeEvent, SEVERITY } = require('./eventDetector');
const llm = require('./llm');
const config = require('../config');

const MAX_STEPS = 20;
const MAX_TOOL_CALLS = 30;
const TASK_TIMEOUT = 50;
const RETRY_LIMIT = 3;
const BUDGET = 100;

class AgentSupervisor {
  constructor(context) {
    this.context = context;
    this.agentMemory = new AgentMemory();
    this.activeTasks = new Map();
    this.completedTasks = [];
    this.eventQueue = [];
    this.investigations = new Map();
    this._eventBus = null;
    this._approvalGateway = null;
    this._verificationEngine = null;
    this._ragPipeline = null;
    this._defaultRole = 'viewer'; // tools are gated per-call by executeTool
    this.llmProvider = llm.createProvider(config.llm || {});
  }

  setLLMProvider(provider) { this.llmProvider = provider; }
  setLLMBudget(budget) { this.llmBudget = budget; }

  setIO(io) { this._io = io; }
  setEventBus(eventBus) { this._eventBus = eventBus; }
  setAudit(audit) { this._audit = audit; }
  setApprovalGateway(gw) { this._approvalGateway = gw; }
  setVerificationEngine(ve) { this._verificationEngine = ve; }
  setRAGPipeline(pipeline) { this._ragPipeline = pipeline; }
  setDefaultRole(role) { this._defaultRole = role; }

  updateContext(ctx) {
    this.context = ctx;
  }

  receiveEvent(event) {
    const routed = routeEvent(event);
    this.eventQueue.push(routed);
    if (routed.action === 'AGENT_INVESTIGATE' || routed.action === 'AGENT_OPTIONAL') {
      this.triggerInvestigation(event, {});
    }
    return routed;
  }

  triggerInvestigation(event, opts = {}) {
    const stationId = opts.stationId || event.stationId || (event.evidence && event.evidence.stations && event.evidence.stations[0] && event.evidence.stations[0].id) || null;
    const investigationId = opts.investigationId || null;
    const taskId = `TASK-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const startedAt = new Date().toISOString();
    const task = {
      id: taskId,
      eventId: event.id,
      eventType: event.type,
      severity: event.severity,
      category: event.category,
      stationId,
      investigationId,
      state: 'PLANNING',
      plan: null,
      evidence: [],
      sources: [],
      findings: [],
      rootCause: null,
      confidence: null,
      recommendations: [],
      actions: [],
      actionProposals: [],
      verification: null,
      status: 'ACTIVE',
      startedAt,
      updatedAt: startedAt,
      steps: 0,
      toolCalls: 0,
      retries: 0,
      budgetRemaining: BUDGET,
      timeline: [{ stage: 'EVENT_DETECTED', at: startedAt, status: 'completed', detail: { type: event.type, severity: event.severity } }],
    };
    this.activeTasks.set(taskId, task);
    this.agentMemory.createInvestigationMemory(taskId, { eventId: event.id, severity: event.severity, stationId, investigationId });

    this._emit('agent:started', { taskId, eventId: event.id, severity: event.severity, stationId, investigationId });

    setImmediate(() => {
      this.executeTask(task).catch((e) => {
        task.state = 'FAILED';
        task.error = e.message;
        task.completedAt = new Date().toISOString();
        try { this.agentMemory.resolveInvestigation(task.id, 'FAILED'); } catch (_) {}
      });
    });
    return task;
  }

  _emit(event, data) {
    const channel = event.startsWith('agent:')
      ? event.replace(/:/g, '.')
      : `agent.${event.replace(/:/g, '.')}`;
    try {
      if (this._io) this._io.emit(channel, data);
    } catch (_) {}
    try {
      if (this._eventBus && this._eventBus.publish) {
        this._eventBus.publish({ type: channel, category: 'agent', severity: 'info', title: channel, payload: data });
      }
    } catch (_) {}
    try {
      if (this._audit) {
        const action = channel.replace(/[^a-z0-9]+/gi, '.');
        this._audit.record({
          actor: 'agent-supervisor',
          action: action.slice(0, 64),
          resource: 'agent_task',
          resourceId: data?.taskId || data?.id || null,
          result: data?.status === 'failed' ? 'FAILED' : 'SUCCESS',
          severity: data?.severity || 'INFO',
          newValue: data,
        });
      }
    } catch (_) {}
  }

  async executeTask(task) {
    task.state = 'INVESTIGATING';
    task.updatedAt = new Date().toISOString();
    task.timeline.push({ stage: 'STATION_DATA_COLLECTED', at: new Date().toISOString(), status: 'completed' });

    const ctx = this._buildContext();

    const plan = this.createInvestigationPlan(task, task.stationId);
    task.plan = plan;
    task.state = 'RUNNING';
    task.timeline.push({ stage: 'PLAN_CREATED', at: new Date().toISOString(), status: 'completed', detail: { stepCount: plan.steps.length } });

    for (const step of plan.steps) {
      if (task.budgetRemaining <= 0 || task.steps >= MAX_STEPS || task.toolCalls >= MAX_TOOL_CALLS) break;
      task.steps++;
      task.timeline.push({ stage: 'TOOL_STARTED', at: new Date().toISOString(), status: 'running', detail: { tool: step.tool } });
      this._emit('tool:started', { taskId: task.id, tool: step.tool });
      try {
        // ---- Phase 2 / 6: every tool call is gated + verified via executeTool ----
        const env = await Promise.race([
          executeTool(step.tool, step.parameters || {}, ctx, this._defaultRole, { timeoutMs: TASK_TIMEOUT }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('tool timeout')), TASK_TIMEOUT)),
        ]);
        task.toolCalls++;
        if (env.status === 'completed') {
          task.budgetRemaining--;
          if (step.tool === 'search_knowledge') {
            task.sources = (env.result && env.result.results) || [];
            this.agentMemory.addKnowledge(`rag:${task.eventId}`, { sources: task.sources.length, query: step.parameters?.query, mode: env.result && env.result.mode });
          } else {
            task.evidence.push({ kind: 'OBSERVED', tool: step.tool, data: env.result, verified: !!env.verified });
            this.agentMemory.addEvidence(task.id, { source: step.tool, data: env.result, verified: !!env.verified });
          }
          task.timeline.push({ stage: 'TOOL_COMPLETED', at: new Date().toISOString(), status: 'completed', detail: { tool: step.tool, latencyMs: env.latency, verified: !!env.verified } });
          this._emit('tool:completed', { taskId: task.id, tool: step.tool, status: 'completed', latency: env.latency, verified: !!env.verified });
        } else if (env.status === 'denied') {
          // Phase 2: a denied call is recorded as a finding but never re-attempted.
          task.budgetRemaining--;
          task.findings.push({ type: 'PERMISSION_DENIED', tool: step.tool, code: env.code, error: env.error });
          this.agentMemory.addFinding(task.id, { type: 'PERMISSION_DENIED', tool: step.tool, code: env.code, error: env.error });
          task.timeline.push({ stage: 'TOOL_DENIED', at: new Date().toISOString(), status: 'failed', detail: { tool: step.tool, code: env.code, error: env.error } });
          this._emit('tool:completed', { taskId: task.id, tool: step.tool, status: 'denied', error: env.error, code: env.code });
        } else {
          // failed
          task.budgetRemaining--;
          task.retries++;
          task.findings.push({ type: 'TOOL_FAILURE', tool: step.tool, error: env.error || 'unknown' });
          this.agentMemory.addFinding(task.id, { type: 'TOOL_FAILURE', tool: step.tool, error: env.error || 'unknown' });
          task.timeline.push({ stage: 'TOOL_FAILED', at: new Date().toISOString(), status: 'failed', detail: { tool: step.tool, error: env.error } });
          this._emit('tool:completed', { taskId: task.id, tool: step.tool, status: 'failed', error: env.error });
          if (task.retries > RETRY_LIMIT) break;
        }
      } catch (e) {
        task.findings.push({ type: 'EXCEPTION', tool: step.tool, error: e.message });
        task.retries++;
        task.timeline.push({ stage: 'TOOL_FAILED', at: new Date().toISOString(), status: 'failed', detail: { tool: step.tool, error: e.message } });
        this._emit('tool:completed', { taskId: task.id, tool: step.tool, status: 'failed', error: e.message });
      }
      task.updatedAt = new Date().toISOString();
    }

    task.timeline.push({ stage: 'KNOWLEDGE_RETRIEVED', at: new Date().toISOString(), status: 'completed', detail: { sourceCount: task.sources.length } });
    task.timeline.push({ stage: 'ROOT_CAUSE_ASSESSED', at: new Date().toISOString(), status: 'completed' });

    task.state = 'ASSESSING';
    task.confidence = this.calculateConfidence(task);
    task.rootCause = this.assessRootCause(task);
    task.recommendations = this.generateRecommendations(task);
    task.state = 'RECOMMENDING';

    await this.runLLMReasoning(task);

    try {
      // ---- Phase 3: every supervisor-built proposal goes through ApprovalGateway ----
      const proposals = this.buildActionProposals(task);
      for (const proposal of proposals) {
        task.actions.push({ type: 'PROPOSAL', proposal });
        task.actionProposals.push(proposal);
        if (this._approvalGateway) {
          try {
            const gwProposal = this._approvalGateway.propose({
              action: proposal.action,
              targetId: proposal.targetId,
              reason: proposal.reason,
              evidence: proposal.evidence || [],
              expectedImpact: proposal.expectedImpact || '',
              proposedBy: 'agent-supervisor',
            });
            task.actionProposals[task.actionProposals.length - 1] = { ...proposal, approvalProposalId: gwProposal.id, approvalStatus: gwProposal.status, riskLevel: gwProposal.riskLevel };
            proposal.approvalProposalId = gwProposal.id;
            proposal.approvalStatus = gwProposal.status;
            proposal.riskLevel = gwProposal.riskLevel;
          } catch (e) {
            // ApprovalGateway.propose is synchronous and only throws for unknown actions.
            proposal.approvalStatus = 'UNREGISTERED';
          }
        }
        this._emit('action:proposed', { taskId: task.id, proposal });
      }
    } catch (_) {}

    task.state = 'COMPLETED';
    task.completedAt = new Date().toISOString();
    task.updatedAt = task.completedAt;
    task.timeline.push({ stage: 'COMPLETED', at: task.completedAt, status: 'completed' });

    this.completedTasks.push(task);
    if (this.completedTasks.length > 100) this.completedTasks = this.completedTasks.slice(-100);
    this.activeTasks.delete(task.id);
    try { this.agentMemory.resolveInvestigation(task.id, 'COMPLETED'); } catch (_) {}

    if (task.investigationId) {
      try {
        const investigationSvc = require('./investigation');
        const updated = investigationSvc.syncFromAgentTask(task.investigationId, task);
        if (updated) {
          investigationSvc.advanceStage(task.investigationId, 'analysis', 'agent-supervisor', { taskId: task.id });
          this._emit('investigation:synced', { investigationId: task.investigationId, taskId: task.id });
        }
      } catch (e) {
        console.error('Failed to sync task to investigation:', e.message);
      }
    }

    return task;
  }

  /**
   * Backwards-compatible: returns a `name → handler` map. New code should
   * call toolGateway.executeTool() directly so validation and verification
   * run. Kept for the existing regression suite (Phase 1 backward compat).
   */
  buildToolContext(ctx) {
    const { READ_ONLY_HANDLERS, MUTATION_HANDLERS } = require('./toolGateway');
    const out = {};
    for (const name of Object.keys(READ_ONLY_HANDLERS)) out[name] = READ_ONLY_HANDLERS[name];
    for (const name of Object.keys(MUTATION_HANDLERS)) out[name] = MUTATION_HANDLERS[name];
    return out;
  }

  /**
   * Build the per-task context handed to each tool handler. We inject the
   * RAG pipeline and any verification engine so the handler can prefer the
   * richer code path (Phase 4).
   */
  _buildContext() {
    const ctx = { ...(this.context || {}) };
    if (this._ragPipeline) ctx.ragPipeline = this._ragPipeline;
    if (this._verificationEngine) ctx.verificationEngine = this._verificationEngine;
    if (this._approvalGateway) ctx.approvalGateway = this._approvalGateway;
    return ctx;
  }

  createInvestigationPlan(task, stationId) {
    const baseSteps = [
      { tool: 'get_current_readings', parameters: {}, status: 'pending' },
      { tool: 'get_provider_status', parameters: {}, status: 'pending' },
    ];
    if (stationId) {
      baseSteps.push(
        { tool: 'get_station', parameters: { stationId }, status: 'pending' },
        { tool: 'get_station_health', parameters: { stationId }, status: 'pending' },
        { tool: 'get_anomalies', parameters: { stationId }, status: 'pending' },
        { tool: 'get_station_history', parameters: { stationId, field: 'aqi', minutes: 60 }, status: 'pending' },
        { tool: 'get_nearby_stations', parameters: { stationId }, status: 'pending' },
        { tool: 'get_maintenance_risk', parameters: { stationId }, status: 'pending' },
        { tool: 'search_knowledge', parameters: { query: `${task.category || 'station'} procedure troubleshooting ${stationId}`, stationId, topK: 5 }, status: 'pending' },
      );
    } else {
      baseSteps.push(
        { tool: 'get_alerts', parameters: {}, status: 'pending' },
        { tool: 'get_maintenance_risk', parameters: {}, status: 'pending' },
        { tool: 'search_knowledge', parameters: { query: `${task.category || 'system'} investigation`, topK: 5 }, status: 'pending' },
      );
    }
    return { taskId: task.id, eventId: task.eventId, steps: baseSteps.map((s) => ({ ...s })), status: 'PLANNED' };
  }

  calculateConfidence(task) {
    const liveEvidence = task.evidence.filter((e) => e.kind === 'OBSERVED').length;
    const retrievedSources = task.sources.filter((s) => (s.relevance || 0) >= 0.3).length;
    const mlConfidence = task.evidence.find((e) => e.tool === 'get_station_health')?.data?.overall || 0;
    const spatialAgreement = task.evidence.find((e) => e.tool === 'get_nearby_stations')?.data?.neighbours?.length || 0;
    if (!liveEvidence && !retrievedSources) return { value: null, label: 'INSUFFICIENT EVIDENCE', basis: [] };
    const value = Math.min(0.98, +(0.35 + Math.min(liveEvidence, 5) * 0.08 + Math.min(retrievedSources, 3) * 0.08 + (mlConfidence / 100) * 0.15 + Math.min(spatialAgreement, 4) * 0.02).toFixed(2));
    return { value, label: `${Math.round(value * 100)}%`, basis: [`${liveEvidence} live evidence item(s)`, `${retrievedSources} relevant knowledge source(s)`, `ML health ${mlConfidence}`, `${spatialAgreement} neighbouring station(s) consulted`] };
  }

  assessRootCause(task) {
    const anomalyEvidence = task.evidence.find((e) => e.tool === 'get_anomalies');
    const healthEvidence = task.evidence.find((e) => e.tool === 'get_station_health');
    const spatialEvidence = task.evidence.find((e) => e.tool === 'get_nearby_stations');
    const maintenanceEvidence = task.evidence.find((e) => e.tool === 'get_maintenance_risk');
    const providerEvidence = task.evidence.find((e) => e.tool === 'get_provider_status');
    const readingEvidence = task.evidence.find((e) => e.tool === 'get_station');

    if (anomalyEvidence?.data?.length > 0 && healthEvidence?.data?.overall < 50) {
      return { cause: 'Localized sensor/environmental anomaly with degraded station health', confidence: 0.85, type: 'ANOMALY_HEALTH', evidenceRefs: { anomaly: anomalyEvidence.data, health: healthEvidence.data } };
    }
    if (anomalyEvidence?.data?.length > 0) {
      return { cause: 'Anomaly detected in station readings', confidence: 0.8, type: 'ANOMALY', evidenceRefs: anomalyEvidence.data };
    }
    if (healthEvidence?.data?.status === 'critical' || healthEvidence?.data?.overall < 30) {
      return { cause: 'Station health critical - likely sensor or environmental issue', confidence: 0.85, type: 'HEALTH', evidenceRefs: healthEvidence.data };
    }
    if (maintenanceEvidence?.data?.some((m) => m.riskScore > 70)) {
      return { cause: 'High maintenance risk detected', confidence: 0.75, type: 'MAINTENANCE', evidenceRefs: maintenanceEvidence.data };
    }
    if (spatialEvidence?.data?.neighbours?.some((n) => n.correlatedAnomaly)) {
      return { cause: 'Correlated anomaly detected across nearby stations', confidence: 0.7, type: 'SPATIAL', evidenceRefs: spatialEvidence.data };
    }
    if (providerEvidence?.data?.some((p) => p.status === 'RED')) {
      return { cause: 'Provider failure affecting data quality', confidence: 0.7, type: 'PROVIDER', evidenceRefs: providerEvidence.data };
    }
    if (readingEvidence?.data) {
      return { cause: 'Threshold breach observed in latest station reading', confidence: 0.6, type: 'THRESHOLD', evidenceRefs: readingEvidence.data };
    }
    return { cause: 'Insufficient evidence to determine root cause', confidence: 0.3, type: 'UNKNOWN' };
  }

  generateRecommendations(task) {
    const recs = [];
    const rootCause = task.rootCause;
    if (rootCause.type === 'ANOMALY_HEALTH') {
      recs.push({ type: 'RECOMMENDED', text: 'Run station health check, review calibration procedure, and inspect sensor.' });
    } else if (rootCause.type === 'ANOMALY') {
      recs.push({ type: 'RECOMMENDED', text: 'Run health check on affected station and review calibration procedures.' });
    } else if (rootCause.type === 'HEALTH') {
      recs.push({ type: 'RECOMMENDED', text: 'Dispatch field team for sensor inspection and calibration.' });
    } else if (rootCause.type === 'MAINTENANCE') {
      recs.push({ type: 'RECOMMENDED', text: 'Schedule maintenance within 24 hours for high-risk station.' });
    } else if (rootCause.type === 'SPATIAL') {
      recs.push({ type: 'RECOMMENDED', text: 'Investigate localized environmental factor affecting multiple stations.' });
    } else if (rootCause.type === 'PROVIDER') {
      recs.push({ type: 'RECOMMENDED', text: 'Test provider and validate fallback data path.' });
    } else if (rootCause.type === 'THRESHOLD') {
      recs.push({ type: 'RECOMMENDED', text: 'Confirm reading via neighbouring stations and recent history.' });
    } else {
      recs.push({ type: 'MONITOR', text: 'Continue monitoring. No immediate action required.' });
    }
    if (task.sources.length > 0) recs.push({ type: 'KNOWLEDGE', text: `Retrieved ${task.sources.length} relevant knowledge source(s) from RAG.` });
    if (task.confidence?.label === 'INSUFFICIENT EVIDENCE') recs.push({ type: 'CAUTION', text: 'Confidence is INSUFFICIENT EVIDENCE - escalate for human review.' });
    return { items: recs, summary: recs.map((r) => r.text).join(' ') };
  }

  buildActionProposals(task) {
    const proposals = [];
    const rootCause = task.rootCause;
    const targetStation = task.stationId;
    if (rootCause.type === 'ANOMALY' || rootCause.type === 'ANOMALY_HEALTH' || rootCause.type === 'HEALTH') {
      proposals.push({ id: `PROP-${Date.now()}-${randomUUID().slice(0,4)}`, action: 'run_health_check', targetId: targetStation, reason: `Health degradation on ${targetStation}: ${rootCause.cause}`, requiresApproval: false, status: 'PROPOSED', proposedBy: 'agent-supervisor' });
    }
    if (rootCause.type === 'MAINTENANCE' && targetStation) {
      proposals.push({ id: `PROP-${Date.now()}-${randomUUID().slice(0,4)}-2`, action: 'generate_report', targetId: targetStation, reason: `High maintenance risk on ${targetStation}; generate incident report`, requiresApproval: true, status: 'PROPOSED', proposedBy: 'agent-supervisor' });
    }
    if (rootCause.type === 'PROVIDER') {
      proposals.push({ id: `PROP-${Date.now()}-${randomUUID().slice(0,4)}-3`, action: 'test_provider', targetId: 'all', reason: 'Provider failure detected; test configured providers', requiresApproval: false, status: 'PROPOSED', proposedBy: 'agent-supervisor' });
    }
    return proposals;
  }

  async runLLMReasoning(task) {
    const contextPayload = {
      situation: `Station ${task.stationId || 'fleet'}: ${task.eventType || task.category || 'event'}`,
      evidence: (task.evidence || []).slice(0, 8).map((e) => ({ tool: e.tool, data: e.data })),
      hypotheses: [],
      confidence: task.confidence?.value || 0,
      recommendation: (task.recommendations?.items || []).map((r) => r.text).join(' | '),
      requiredAction: (task.actionProposals || []).map((p) => p.action).join(',') || 'none',
      approvalRequirement: (task.actionProposals || []).some((p) => p.requiresApproval) ? 'admin' : 'none',
      auditRef: task.id,
    };
    const system = 'You are a grounded operational reasoning assistant. Use ONLY the structured evidence provided. Never invent facts. Refuse if evidence is insufficient. Output strict JSON matching the schema.';
    try {
      const r = await Promise.race([
        llm.chatWithBudget(
          this.llmProvider,
          { system, user: JSON.stringify(contextPayload), schema: llm.AGENT_RESPONSE_SCHEMA, maxTokens: 800 },
          this.llmBudget || { daily: (config.llm && config.llm.dailyTokenBudget) || 200000 },
        ),
        new Promise((_, rej) => setTimeout(() => rej(new Error('LLM timeout')), TASK_TIMEOUT)),
      ]);
      task.llm = { provider: r.provider, model: r.model || null, tokens: r.tokens || null, fallback: !!r.fallback, ok: !!r.ok, error: r.error || null };
      const parsed = r.content ? llm.tryParseJson(r.content) : null;
      if (parsed && typeof parsed === 'object') {
        task.llmResponse = parsed;
        if (Array.isArray(parsed.hypotheses) && parsed.hypotheses.length && (!task.rootCause || task.rootCause.confidence < (parsed.confidence || 1))) {
          task.rootCause = { ...task.rootCause, llmRefined: true, llmHypotheses: parsed.hypotheses };
        }
      } else {
        task.llmResponse = { error: 'parse_failed', raw: r.content ? String(r.content).slice(0, 200) : null };
      }
      task.timeline.push({ stage: 'LLM_REASONED', at: new Date().toISOString(), status: r.ok ? 'completed' : 'failed', detail: { provider: r.provider, fallback: !!r.fallback, tokens: r.tokens?.total || 0 } });
      this._emit('agent:llm:completed', { taskId: task.id, provider: r.provider, ok: r.ok, tokens: r.tokens?.total || 0 });
    } catch (e) {
      task.llm = { provider: this.llmProvider.id, ok: false, error: e.message };
      task.timeline.push({ stage: 'LLM_REASONED', at: new Date().toISOString(), status: 'failed', detail: { error: e.message } });
    }
  }

  proposeAction(task, action, targetId, reason, evidence) {
    if (!this._approvalGateway) throw new Error('ApprovalGateway not wired');
    const proposal = this._approvalGateway.propose({ action, targetId, reason, evidence, expectedImpact: task.rootCause?.cause, proposedBy: 'agent-supervisor' });
    task.actions.push({ type: 'PROPOSAL', proposal });
    return proposal;
  }

  getTask(taskId) {
    return this.activeTasks.get(taskId) || this.completedTasks.find((t) => t.id === taskId) || null;
  }
  getActiveTasks() { return [...this.activeTasks.values()].filter((t) => t.status === 'ACTIVE'); }
  getCompletedTasks() { return this.completedTasks.slice(-20); }

  getAgentStatus() {
    const active = this.getActiveTasks();
    return {
      status: active.length > 0 ? 'ACTIVE' : 'IDLE',
      activeInvestigations: active.length,
      completedTasks: this.completedTasks.length,
      eventQueueSize: this.eventQueue.length,
      memoryStats: this.agentMemory.getSessionStats(),
    };
  }
}

module.exports = { AgentSupervisor, MAX_STEPS, MAX_TOOL_CALLS, TASK_TIMEOUT, RETRY_LIMIT, BUDGET };
