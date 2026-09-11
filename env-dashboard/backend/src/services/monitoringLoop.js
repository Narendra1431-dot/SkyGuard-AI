'use strict';

const { randomUUID } = require('crypto');
const { createSnapshot, diffSnapshots } = require('./stateSnapshot');
const { detectEvents, routeEvent, SEVERITY } = require('./eventDetector');
const { AgentSupervisor } = require('./agentSupervisor');
const { RAGPipeline } = require('./ragPipeline');
const { ApprovalGateway, VerificationEngine } = require('./approvalGateway');
const { AgentMemory } = require('./agentMemory');
const eventBus = require('./eventBus');
const decisions = require('./decisionTrace');

const MONITOR_INTERVAL_MS = 1000;
const SNAPSHOT_HISTORY_SIZE = 60;
const MAX_EVENTS_KEPT = 500;
const DEBOUNCE_WINDOW_MS = 30_000;

let _ragConfig = {};

function configureRAG(cfg) { _ragConfig = cfg || {}; }

class MonitoringLoop {
  constructor(context, io = null) {
    this.context = context;
    this.io = io || null;
    this.agentSupervisor = new AgentSupervisor(context);
    this.ragPipeline = new RAGPipeline(_ragConfig);
    this.approvalGateway = new ApprovalGateway();
    this.verificationEngine = new VerificationEngine(context);
    this.agentMemory = new AgentMemory();

    this.previousSnapshot = null;
    this.snapshotHistory = [];
    this.currentSnapshot = null;
    this.events = context.events || [];
    this.isRunning = false;
    this.interval = null;
    this.lastCycleAt = null;
    this.cycleCount = 0;
    this.lastCycleDuration = 0;
    this.listeners = new Map();

    this._cooldowns = new Map();
    this._recentTasksBySignature = new Map();
  }

  setIO(io) {
    this.io = io;
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    for (const cb of callbacks) {
      try { cb(data); } catch (_) {}
    }
    if (this.io) {
      try {
        if (event === 'cycle') this.io.emit('monitor:cycle', data);
        else if (event.startsWith('event:')) this.io.emit('agent:event', { type: event, data });
        else if (event === 'error') this.io.emit('monitor:error', data);
        else if (event === 'agent:started') this.io.emit('agent:started', data);
        else if (event === 'agent:tool:completed') this.io.emit('agent:tool:completed', data);
        else if (event === 'agent:investigation:created') this.io.emit('agent:investigation:created', data);
        else if (event === 'agent:action:proposed') this.io.emit('agent:action:proposed', data);
        else if (event === 'agent:action:approved') this.io.emit('agent:action:approved', data);
        else if (event === 'agent:action:completed') this.io.emit('agent:action:completed', data);
        else if (event === 'agent:action:failed') this.io.emit('agent:action:failed', data);
        else if (event === 'brief:updated') this.io.emit('intelligence:brief', data);
      } catch (_) {}
    }
  }

  updateContext(ctx) {
    this.context = ctx;
    this.agentSupervisor.updateContext(ctx);
    const veCtx = this.verificationEngine.context || {};
    this.verificationEngine.updateContext({ ...veCtx, ...ctx });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.interval = setInterval(() => {
      this.runCycle().catch((e) => console.error('[MonitoringLoop] cycle failed:', e.message));
    }, MONITOR_INTERVAL_MS);
    this.runCycle().catch((e) => console.error('[MonitoringLoop] initial cycle failed:', e.message));
  }

  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runCycle() {
    const cycleStart = Date.now();
    this.lastCycleAt = new Date().toISOString();
    this.cycleCount++;

    try {
      const snapshot = this.captureSnapshot();
      const { events: newEvents, changes } = this.detectChanges(snapshot);
      this.currentSnapshot = snapshot;
      this.snapshotHistory.push(snapshot);
      if (this.snapshotHistory.length > SNAPSHOT_HISTORY_SIZE) {
        this.snapshotHistory = this.snapshotHistory.slice(-SNAPSHOT_HISTORY_SIZE);
      }

      for (const event of newEvents) {
        this.events.push(event);
        if (this.events.length > MAX_EVENTS_KEPT) this.events = this.events.slice(-MAX_EVENTS_KEPT);
        this.handleEvent(event);
        try {
          eventBus.publish({
            type: event.type,
            category: event.category,
            severity: event.severity,
            stationId: event.stationId || null,
            title: event.title,
            summary: event.summary,
            evidence: event.evidence,
            payload: { eventId: event.id, snapshotId: event.snapshotId },
          });
        } catch (_) {}
      }

      const cyclePayload = {
        cycleCount: this.cycleCount,
        snapshot,
        newEvents: newEvents.length,
        changes: changes.length,
        cycleDurationMs: Date.now() - cycleStart,
      };
      this.emit('cycle', cyclePayload);
      if (this.cycleCount % 10 === 0) {
        try { this.emit('brief:updated', this.buildBrief()); } catch (_) {}
      }
    } catch (e) {
      console.error('[MonitoringLoop] cycle failed:', e.message);
      this.emit('error', { error: e.message, cycle: this.cycleCount });
    }

    this.lastCycleDuration = Date.now() - cycleStart;
  }

  captureSnapshot() {
    const ctx = this.context;
    const latest = ctx.latestByStation || [];
    const latestByStation = latest instanceof Map
      ? latest
      : new Map(Array.isArray(latest) ? latest.map((r) => [r.stationId, r]) : Object.entries(latest));

    return createSnapshot({
      providers: ctx.providers || [],
      ingestion: { lastTickAt: ctx.lastTickAt, tickCount: ctx.tickCount },
      dataQuality: ctx.qualitySnapshot,
      stations: ctx.stations || [],
      anomalies: ctx.anomalies || [],
      health: ctx.healthData,
      alerts: ctx.alerts || [],
      maintenanceList: ctx.maintenanceList || [],
      architecture: ctx.architecture || null,
      ml: ctx.mlStatus,
      rag: this.ragPipeline.getStats(),
      agent: this.agentSupervisor.getAgentStatus(),
      latestByStation,
    });
  }

  detectChanges(snapshot) {
    if (!this.previousSnapshot) {
      const initialEvents = detectEvents(snapshot, null) || [];
      return {
        events: [{
          id: `EVT-${Date.now()}-${randomUUID().slice(0, 6)}`,
          type: 'MONITOR.INITIAL',
          category: 'system',
          severity: SEVERITY.INFO,
          title: 'Monitoring initialized',
          summary: 'First snapshot captured by always-on monitoring loop',
          evidence: {},
          timestamp: snapshot.timestamp,
          snapshotId: snapshot.id,
        }, ...initialEvents],
        changes: [{ section: 'all', change: 'NEW' }],
      };
    }

    const ruleEvents = detectEvents(snapshot, this.previousSnapshot) || [];
    const { changes } = diffSnapshots(this.previousSnapshot, snapshot);

    const meaningfulEvents = ruleEvents.filter((e) => {
      if (e.severity === SEVERITY.CRITICAL) return true;
      if (e.severity === SEVERITY.HIGH) return true;
      if (e.isRecovery) return true;
      if (e.severity === SEVERITY.WARNING && (e.category === 'quality' || e.category === 'ingestion' || e.category === 'ml')) return true;
      return false;
    });

    this.previousSnapshot = snapshot;
    return { events: meaningfulEvents, changes };
  }

  handleEvent(event) {
    const stationKey = event.stationId || event.evidence?.stations?.[0]?.id || 'fleet';
    const signature = `${event.category}:${event.type}:${stationKey}`;
    const now = Date.now();
    const last = this._cooldowns.get(signature);
    if (last && now - last < DEBOUNCE_WINDOW_MS) return;
    this._cooldowns.set(signature, now);

    const stationCooldownKey = `__station__:${stationKey}`;
    const stationLast = this._cooldowns.get(stationCooldownKey);
    if (stationLast && now - stationLast < DEBOUNCE_WINDOW_MS) {
      try { this.emit(`event:${event.category}`, event); } catch (_) {}
      return;
    }
    this._cooldowns.set(stationCooldownKey, now);

    const routed = routeEvent(event);
    if (routed.action === 'AGENT_INVESTIGATE' || routed.action === 'AGENT_OPTIONAL') {
      this.triggerInvestigationForEvent(event);
    }
    try { this.emit(`event:${event.category}`, event); } catch (_) {}
  }

  triggerInvestigationForEvent(event) {
    const stationId = event.stationId || (event.evidence?.stations && event.evidence.stations[0]?.id) || null;
    const signature = `${event.category}:${event.type}:${stationId || 'fleet'}`;
    const existing = this._recentTasksBySignature.get(signature);
    if (existing && Date.now() - existing < DEBOUNCE_WINDOW_MS) return existing;
    const task = this.agentSupervisor.triggerInvestigation(event, { stationId });
    if (task && task.id) this._recentTasksBySignature.set(signature, Date.now());
    this.emit('agent:investigation:created', { taskId: task.id, eventId: event.id, severity: event.severity, stationId });
    return task;
  }

  buildBrief() {
    try {
      const snapshot = this.currentSnapshot || this.captureSnapshot();
      const agentStatus = this.agentSupervisor.getAgentStatus();
      const events = this.events.slice(-20).reverse();
      const activeTasks = this.agentSupervisor.getActiveTasks();
      const criticalStations = snapshot?.stations?.filter((s) => s.status === 'WARNING' || (s.reading && s.reading.aqi > 250)) || [];
      const openAlerts = snapshot?.alerts?.open || 0;
      const providerFailures = snapshot?.providers?.filter((p) => p.status === 'RED') || [];
      const maintenanceHigh = snapshot?.maintenance?.highRiskCount || 0;
      return {
        when: new Date().toISOString(),
        currentSituation: {
          stations: snapshot?.stations?.length || 0,
          criticalStations: criticalStations.length,
          criticalStationDetails: criticalStations.slice(0, 8).map((s) => ({ id: s.id, name: s.name, aqi: s.reading?.aqi, status: s.status })),
          openAlerts,
          providerFailures: providerFailures.length,
          maintenanceHigh,
          systemHealth: snapshot?.agent?.status || 'UNKNOWN',
          ingestionStatus: snapshot?.ingestion?.status || 'UNKNOWN',
          qualityScore: snapshot?.dataQuality?.overallScore ?? null,
          ragStatus: snapshot?.rag?.status || 'UNKNOWN',
          mlStatus: snapshot?.ml?.status || 'UNKNOWN',
        },
        whatChanged: events.slice(0, 10).map((e) => ({ type: e.type, severity: e.severity, title: e.title, station: e.station || e.evidence?.stations?.[0]?.name, timestamp: e.timestamp })),
        topRisks: [
          ...criticalStations.map((s) => ({ risk: 'CRITICAL_STATION', station: s.name, detail: `AQI ${s.reading?.aqi}` })),
          ...providerFailures.map((p) => ({ risk: 'PROVIDER_FAILURE', station: p.name, detail: p.lastError })),
          ...(maintenanceHigh > 0 ? [{ risk: 'MAINTENANCE_RISK', station: null, detail: `${maintenanceHigh} stations at HIGH risk` }] : []),
        ].slice(0, 8),
        activeIncidents: activeTasks.map((t) => ({ id: t.id, eventType: t.eventType, severity: t.severity, stationId: t.stationId, state: t.state, startedAt: t.startedAt })),
        recommendedActions: activeTasks.length > 0
          ? activeTasks.map((t) => ({ action: 'Investigate', reason: t.rootCause?.cause, confidence: t.confidence?.value }))
          : [{ action: 'Continue monitoring', reason: 'No active investigations' }],
        agentStatus,
      };
    } catch (e) {
      console.error('buildBrief error:', e.message);
      return {
        when: new Date().toISOString(),
        currentSituation: { stations: 0, criticalStations: 0, openAlerts: 0, providerFailures: 0, maintenanceHigh: 0, systemHealth: 'ERROR', ingestionStatus: 'ERROR', qualityScore: null, ragStatus: 'ERROR', mlStatus: 'ERROR' },
        whatChanged: [],
        topRisks: [],
        activeIncidents: [],
        recommendedActions: [{ action: 'Continue monitoring', reason: 'Brief generation failed: ' + e.message }],
        agentStatus: { status: 'ERROR', error: e.message },
      };
    }
  }

  getSnapshot() { return this.currentSnapshot; }
  getSnapshotHistory() { return this.snapshotHistory; }
  getEvents({ limit = 100, category, severity } = {}) {
    let rows = this.events.slice().reverse();
    if (category) rows = rows.filter((e) => e.category === category);
    if (severity) rows = rows.filter((e) => e.severity === severity);
    return rows.slice(0, limit);
  }
  getAgentSupervisor() { return this.agentSupervisor; }
  getApprovalGateway() { return this.approvalGateway; }
  getVerificationEngine() { return this.verificationEngine; }
  getRAGPipeline() { return this.ragPipeline; }
  getAgentMemory() { return this.agentMemory; }

  getStatus() {
    try {
      const agentStatus = this.agentSupervisor.getAgentStatus();
      const ragStats = this.ragPipeline.getStats();
      return {
        running: this.isRunning,
        cycleCount: this.cycleCount,
        lastCycleAt: this.lastCycleAt,
        lastCycleDurationMs: this.lastCycleDuration,
        snapshotHistorySize: this.snapshotHistory.length,
        eventCount: this.events.length,
        activeInvestigations: this.agentSupervisor.getActiveTasks().length,
        agentStatus,
        ragStatus: ragStats,
      };
    } catch (e) {
      console.error('getStatus error:', e.message);
      return {
        running: this.isRunning,
        cycleCount: this.cycleCount,
        lastCycleAt: this.lastCycleAt,
        lastCycleDurationMs: this.lastCycleDuration,
        snapshotHistorySize: this.snapshotHistory.length,
        eventCount: this.events.length,
        activeInvestigations: 0,
        agentStatus: { status: 'ERROR', error: e.message },
        ragStatus: { status: 'ERROR', error: e.message },
      };
    }
  }

  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }
}

module.exports = { MonitoringLoop, MONITOR_INTERVAL_MS, configureRAG };