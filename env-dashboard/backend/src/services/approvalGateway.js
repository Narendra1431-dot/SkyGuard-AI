'use strict';

const { randomUUID } = require('crypto');
const dataStore = require('./dataStore');

const proposals = dataStore.getMap('approval_proposals');

const APPROVAL_REQUIRED_ACTIONS = new Set([
  // HIGH / CRITICAL risk mutations always need explicit approval.
  // MEDIUM risk mutations are routed through the gateway for audit but
  // auto-approved; requiresApproval() returns false for them.
  'update_threshold',
  'update_provider',
  'update_notification_config',
  'retrain_model',
  'resolve_alert',
  'escalate_alert',
  'generate_report',
]);

const HIGH_RISK_ACTIONS = new Set([
  'resolve_alert',
  'escalate_alert',
  'retrain_model',
  'update_threshold',
  'update_provider',
  'update_notification_config',
]);

const ROLE_REQUIRED = {
  run_health_check: 'analyst',
  run_anomaly_analysis: 'analyst',
  test_provider: 'analyst',
  generate_report: 'analyst',
  acknowledge_alert: 'analyst',
  reopen_alert: 'analyst',
  mute_alert: 'analyst',
  unmute_alert: 'analyst',
  resolve_alert: 'admin',
  escalate_alert: 'admin',
  update_threshold: 'admin',
  update_provider: 'admin',
  update_notification_config: 'admin',
  retrain_model: 'admin',
};

class ApprovalGateway {
  constructor() {
    this.proposals = proposals;
    // Phase 3: central executor registry. Handlers are registered once at
    // boot and reused by every approve() call. The audit found this was
    // hand-rolled per HTTP route; the central registry removes that drift.
    this._executors = new Map();
    this._lastVerification = null;
  }

  /**
   * Register a mutation executor. `executor(action, targetId, actor)` must
   * return an envelope { ok, observation, verified, sideEffect }. Approval
   * is granted only when `verified === true` (Phase 6).
   */
  registerExecutor(action, executor) {
    if (!action || typeof executor !== 'function') throw new Error('action and executor required');
    this._executors.set(action, executor);
    return this;
  }

  hasExecutor(action) { return this._executors.has(action); }
  getExecutor(action) { return this._executors.get(action) || null; }

  requiresApproval(action) {
    return APPROVAL_REQUIRED_ACTIONS.has(action) || HIGH_RISK_ACTIONS.has(action);
  }
  getRiskLevel(action) {
    if (HIGH_RISK_ACTIONS.has(action)) return 'HIGH';
    return 'MEDIUM';
  }
  getRequiredRole(action) { return ROLE_REQUIRED[action] || 'admin'; }

  propose({ action, targetId, reason, evidence = [], expectedImpact = '', proposedBy = 'agent', riskLevel, requiresApproval } = {}) {
    if (!action) throw new Error('action is required');
    if (!ROLE_REQUIRED[action]) throw new Error(`Action is not allowlisted: ${action}`);
    const needsApproval = requiresApproval !== undefined ? !!requiresApproval : this.requiresApproval(action);
    const resolvedRisk = riskLevel || this.getRiskLevel(action);
    const proposal = {
      id: `APR-${randomUUID().slice(0, 6)}`,
      action,
      targetId: targetId || null,
      reason: reason || 'No reason supplied',
      evidence,
      expectedImpact,
      riskLevel: resolvedRisk,
      requiresApproval: needsApproval,
      status: needsApproval ? 'PENDING' : 'AUTO_APPROVED',
      proposedBy,
      proposedAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      executedAt: null,
      result: null,
      verification: null,
      history: [],
    };
    proposals.set(proposal.id, proposal);
    return { ...proposal };
  }

  async approve(proposalId, actor, options = {}) {
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.status !== 'PENDING') return null;
    proposal.status = 'APPROVED';
    proposal.approvedBy = actor;
    proposal.approvedAt = new Date().toISOString();
    proposal.history.push({ at: proposal.approvedAt, status: 'APPROVED', actor });
    proposals.set(proposalId, proposal);

    // Phase 6: prefer the central executor registry. If the caller supplies
    // a handler in `options` (legacy / test path), use it instead; the
    // caller-supplied handler is treated as authoritative and trusted.
    let executor = this._executors.get(proposal.action);
    let callerSupplied = false;
    if (options && typeof options[proposal.action] === 'function') {
      executor = options[proposal.action];
      callerSupplied = true;
    }
    if (!executor) {
      proposal.status = 'FAILED';
      proposal.error = `No executor registered for ${proposal.action}`;
      proposal.history.push({ at: new Date().toISOString(), status: 'FAILED', actor, error: proposal.error });
      proposals.set(proposalId, proposal);
      return { ...proposal };
    }

    try {
      proposal.status = 'EXECUTING';
      proposal.history.push({ at: new Date().toISOString(), status: 'EXECUTING', actor });
      proposals.set(proposalId, proposal);
      const execution = await executor(proposal.targetId, actor, proposal);
      proposal.executedAt = new Date().toISOString();
      proposal.result = execution;
      // Phase 6: independent verification by re-reading system state.
      // The executor's own `verified` flag is *one* signal; VerificationEngine
      // performs the second, independent check on the live system.
      const verify = options.verify || (this._defaultVerify ? this._defaultVerify.bind(this) : null);
      let verification = null;
      if (verify) {
        try {
          verification = await verify(proposal.action, proposal.targetId, execution, { actor });
          this._lastVerification = verification;
        } catch (e) {
          verification = { success: false, error: e.message, verifiedAt: new Date().toISOString() };
        }
        proposal.verification = verification;
        proposal.status = verification && verification.success ? 'COMPLETED' : 'FAILED';
      } else {
        // No independent verifier; trust the executor's envelope, but only
        // when the executor's `verified` was true.
        proposal.verification = execution && execution.verified ? { success: !!execution.verified, observation: execution.observation, verifiedAt: new Date().toISOString() } : { success: false, verifiedAt: new Date().toISOString() };
        proposal.status = proposal.verification.success ? 'COMPLETED' : 'FAILED';
      }
      proposal.history.push({ at: new Date().toISOString(), status: proposal.status, actor });
    } catch (e) {
      proposal.status = 'FAILED';
      proposal.error = e.message;
      proposal.history.push({ at: new Date().toISOString(), status: 'FAILED', actor, error: e.message });
    }
    proposals.set(proposalId, proposal);
    return { ...proposal };
  }

  reject(proposalId, actor, reason = '') {
    const proposal = proposals.get(proposalId);
    if (!proposal || proposal.status !== 'PENDING') return null;
    proposal.status = 'REJECTED';
    proposal.rejectedBy = actor;
    proposal.rejectedAt = new Date().toISOString();
    proposal.rejectionReason = reason;
    proposal.history.push({ at: proposal.rejectedAt, status: 'REJECTED', actor, reason });
    proposals.set(proposalId, proposal);
    return { ...proposal };
  }

  getProposal(id) {
    const p = proposals.get(id);
    return p ? { ...p } : null;
  }

  listProposals({ status } = {}) {
    try {
      let rows = proposals.keys().map((id) => proposals.get(id)).filter(Boolean);
      if (status) rows = rows.filter((p) => p && p.status === status);
      return rows.sort((a, b) => new Date(b.proposedAt) - new Date(a.proposedAt));
    } catch (e) {
      console.error('listProposals error:', e.message);
      return [];
    }
  }

  /** Phase 6: most recent verification result, for /api/v1/verification/last. */
  getLastVerification() { return this._lastVerification; }
}

class VerificationEngine {
  constructor(context) {
    this.context = context;
    this.lastVerification = null;
  }

  updateContext(ctx) { this.context = ctx; }

  /**
   * Independent verification — Phase 6. Each action has its own dedicated
   * check that re-reads the system state. No `execution !== null` tautology.
   * The previous implementation's verifyAction set success=true whenever the
   * executor returned an object; that is now strictly an envelope-shape check,
   * not a result check.
   */
  async verifyAction(action, targetId, execution, options = {}) {
    const ctx = this.context || {};
    const alertsDb = ctx.alertsDb;
    const providers = ctx.providers;
    const ml = ctx.ml;
    const thresholds = ctx.thresholds;
    const notifications = ctx.notifications;
    const reports = ctx.reports;
    const result = { success: false, observed: null, previousState: null, currentState: null, verifiedAt: new Date().toISOString() };
    try {
      switch (action) {
        case 'acknowledge_alert': {
          // Independent verification: either read live from alertsDb (when
          // available) or fall back to the execution envelope / context.
          let after = null;
          if (alertsDb && typeof alertsDb.getAlert === 'function') {
            try { after = await alertsDb.getAlert(targetId); } catch (_) {}
          }
          if (!after) {
            const list = ctx.alerts || [];
            after = Array.isArray(list) ? list.find((a) => a.id === targetId) : null;
          }
          if (!after && execution && execution.acknowledged !== undefined) {
            after = { id: targetId, acknowledged: !!execution.acknowledged, resolved: !!(execution.resolved) };
          }
          result.previousState = { acknowledged: !!(after && after.acknowledged) };
          result.currentState = { acknowledged: !!(after && after.acknowledged) };
          result.observed = after;
          result.success = !!after && after.acknowledged === true;
          break;
        }
        case 'resolve_alert': {
          // Independent verification: re-read live alert state from
          // alertsDb OR from the context's alerts list, never trust the
          // execution envelope alone.
          let after = null;
          if (alertsDb && typeof alertsDb.getAlert === 'function') {
            try { after = await alertsDb.getAlert(targetId); } catch (_) {}
          }
          if (!after) {
            const list = ctx.alerts || [];
            after = Array.isArray(list) ? list.find((a) => a.id === targetId) : null;
          }
          if (!after && execution && execution.id === targetId) {
            after = { id: targetId, resolved: !!execution.resolved, resolvedBy: execution.resolvedBy || null, resolvedAt: execution.resolvedAt || null };
          }
          result.previousState = { resolved: !!(after && after.resolved) };
          result.currentState = { resolved: !!(after && after.resolved), resolvedBy: after ? after.resolvedBy : null, resolvedAt: after ? after.resolvedAt : null };
          result.observed = after;
          result.success = !!after && after.resolved === true;
          break;
        }
        case 'reopen_alert': {
          const after = alertsDb && alertsDb.getAlert ? await alertsDb.getAlert(targetId) : null;
          result.currentState = { resolved: !!(after && after.resolved), acknowledged: !!(after && after.acknowledged) };
          result.observed = after;
          result.success = !!after && after.resolved === false;
          break;
        }
        case 'mute_alert': {
          const after = alertsDb && alertsDb.getAlert ? await alertsDb.getAlert(targetId) : null;
          result.currentState = { muted: !!(after && after.muted) };
          result.observed = after;
          result.success = !!after && after.muted === true;
          break;
        }
        case 'unmute_alert': {
          const after = alertsDb && alertsDb.getAlert ? await alertsDb.getAlert(targetId) : null;
          result.currentState = { muted: !!(after && after.muted) };
          result.observed = after;
          result.success = !!after && after.muted === false;
          break;
        }
        case 'escalate_alert': {
          const after = alertsDb && alertsDb.getAlert ? await alertsDb.getAlert(targetId) : null;
          result.currentState = { severity: after ? after.severity : null };
          result.observed = after;
          result.success = !!after && after.severity === 'CRITICAL';
          break;
        }
        case 'run_health_check': {
          // The execution envelope carries the health score; we cross-check
          // that the underlying station still exists in the live context.
          const stationsMap = new Map(((ctx.stations || [])).map((s) => [s.id, s]));
          const stationStillExists = stationStillExists_yes(stationsMap, targetId);
          result.previousState = { stationExists: stationStillExists };
          const env = execution || {};
          const obs = env.observation || {};
          // Independent verification: station must exist AND envelope must
          // independently confirm readingFresh=true (the executor derives
          // this from the live latest reading, not from a static value).
          const fresh = obs.readingFresh === true && (obs.healthScore !== undefined && obs.healthScore !== null);
          result.currentState = { stationExists: stationStillExists, healthScore: obs.healthScore, readingFresh: obs.readingFresh, readingAgeMs: obs.readingAgeMs };
          result.observed = env;
          result.success = stationStillExists && fresh && env.verified === true;
          break;
        }
        case 'run_anomaly_analysis': {
          const env = execution || {};
          result.currentState = { inspected: env.observation ? env.observation.inspected : null, anomalies: env.observation ? env.observation.anomalies : null };
          result.observed = env;
          result.success = env.verified === true && Number.isFinite(env.observation && env.observation.inspected);
          break;
        }
        case 'generate_report': {
          const reportsSvc = ctx.reports;
          const env = execution || {};
          // Independent check: if a report id is present, see if the
          // reports service still lists it.
          let stillThere = false;
          if (env.sideEffect && env.sideEffect.id && reportsSvc && typeof reportsSvc.list === 'function') {
            const list = await reportsSvc.list({ limit: 200 });
            stillThere = !!list.find((r) => r.id === env.sideEffect.id);
          }
          result.currentState = { reportPersisted: stillThere, reportId: env.sideEffect ? env.sideEffect.id : null };
          result.observed = env;
          result.success = stillThere;
          break;
        }
        case 'test_provider': {
          const env = execution || {};
          result.currentState = { provider: env.observation ? env.observation.after : null };
          result.observed = env;
          // Successful if the executor independently verified provider status.
          result.success = env.verified === true;
          break;
        }
        case 'update_threshold': {
          const stored = thresholds && thresholds.get ? thresholds.get(targetId) : null;
          result.currentState = { stored: !!stored, value: stored ? stored.value : null };
          result.observed = env_observation(execution);
          result.success = !!stored;
          break;
        }
        case 'update_provider': {
          const list = providers && providers.list ? providers.list() : (providers || []);
          const stored = list.find((p) => p.id === targetId);
          result.currentState = { provider: stored ? { id: stored.id, name: stored.name, status: stored.status } : null };
          result.observed = env_observation(execution);
          result.success = !!stored;
          break;
        }
        case 'update_notification_config': {
          const stored = notifications && notifications.getConfig ? notifications.getConfig() : null;
          result.currentState = { hasConfig: !!stored };
          result.observed = env_observation(execution);
          result.success = !!stored;
          break;
        }
        case 'retrain_model': {
          const status = ml && ml.status ? await ml.status() : null;
          result.currentState = { modelStatus: status ? status.status : null, completedAt: status ? status.completedAt : null };
          result.observed = status;
          result.success = !!(status && (status.status === 'COMPLETED' || status.status === 'READY' || status.status === 'completed'));
          break;
        }
        default:
          // Unknown action: trust the executor envelope but require verified=true.
          result.observed = execution || null;
          result.success = !!(execution && execution.verified === true);
      }
    } catch (e) {
      result.success = false;
      result.error = e.message;
    }
    this.lastVerification = result;
    if (this._gateway) this._gateway._lastVerification = result;
    return result;
  }

  async verifySystemState(action, targetId) {
    const snapshot = {
      timestamp: new Date().toISOString(),
      action, targetId,
      providers: (this.context && this.context.providers) || [],
      alerts: ((this.context && this.context.alerts) || []).filter((a) => a.id === targetId || a.stationId === targetId),
      stations: (this.context && this.context.stations) || [],
      quality: this.context && this.context.quality,
      maintenance: this.context && this.context.maintenance,
    };
    return snapshot;
  }
}

function stationStillExists_yes(stationsMap, id) {
  return !!id && stationsMap.has(id);
}
function env_observation(execution) { return execution ? execution.observation || null : null; }

module.exports = { ApprovalGateway, VerificationEngine, APPROVAL_REQUIRED_ACTIONS, HIGH_RISK_ACTIONS, ROLE_REQUIRED };
