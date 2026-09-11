'use strict';

/**
 * Investigation workflow
 *
 * Anomaly lifecycle states:
 *   detected → triaged → investigating → confirmed → dismissed → resolved
 *
 * State is persisted in `data/state/investigations.json` so it survives restart.
 *
 * Evidence collection:
 *   - Evidence is gathered from station readings, anomalies, alerts, health, RAG
 *   - Each evidence item preserves provenance: source, timestamp, station, data ID
 *
 * Investigation lifecycle (target):
 *   trigger → investigation creation → evidence collection → analysis
 *   → Agent/RAG when applicable → finding → recommendation
 *   → approval where required → action where applicable
 *   → verification → audit → resolution
 */

const dataStore = require('./dataStore');
const investigations = dataStore.getMap('investigations');

function nextId() {
  return `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextEvidenceId() {
  return `EV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextFindingId() {
  return `FG-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function nextActionId() {
  return `AC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function create({ anomalyId, stationId, title, evidence = [], sources = [], recommendations = [], confidence = null, agent = 'supervisor' }) {
  const id = nextId();
  const rec = {
    id,
    anomalyId,
    stationId,
    title: title || 'Anomaly investigation',
    state: 'detected',
    history: [{ state: 'detected', at: new Date().toISOString(), actor: 'system', notes: 'Automatically created from anomaly detection.' }],
    notes: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    agent,
    evidence: [],
    findings: [],
    sources: [],
    recommendations: [],
    actions: [],
    approvals: [],
    verification: null,
    confidence,
    timeline: [{ stage: 'DETECTED', at: new Date().toISOString(), status: 'completed' }],
    resolution: null,
  };
  if (evidence && evidence.length) {
    for (const ev of evidence) {
      rec.evidence.push({ id: nextEvidenceId(), ...ev });
    }
  }
  if (sources && sources.length) {
    rec.sources = sources;
  }
  if (recommendations && recommendations.length) {
    rec.recommendations = recommendations;
  }
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Add evidence to an investigation with full provenance
 * @param {string} id - Investigation ID
 * @param {Object} evidenceItem - Evidence item with source, data, and provenance
 * @returns {Object|null} Updated investigation or null if not found
 */
function addEvidence(id, { source, sourceId, stationId: evStationId, timestamp, data, type = 'OBSERVED', relatedAlertId = null, relatedAnomalyId = null }) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const evidenceEntry = {
    id: nextEvidenceId(),
    source,
    sourceId: sourceId || null,
    stationId: evStationId || rec.stationId,
    timestamp: timestamp || new Date().toISOString(),
    type,
    data,
    relatedAlertId,
    relatedAnomalyId,
    verified: false,
    collectedAt: new Date().toISOString(),
  };
  rec.evidence.push(evidenceEntry);
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Add a finding to an investigation
 * @param {string} id - Investigation ID
 * @param {Object} finding - Finding with type, cause, confidence, evidenceRefs
 * @returns {Object|null} Updated investigation or null if not found
 */
function addFinding(id, { type, cause, confidence = null, evidenceRefs = [], notes = '' }) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const findingEntry = {
    id: nextFindingId(),
    type,
    cause,
    confidence,
    evidenceRefs,
    notes,
    at: new Date().toISOString(),
  };
  rec.findings.push(findingEntry);
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Add an action proposal to an investigation
 * Actions that require approval go through ApprovalGateway before execution
 * @param {string} id - Investigation ID
 * @param {Object} action - Action with type, targetId, reason, requiresApproval, approvalProposalId
 * @returns {Object|null} Updated investigation or null if not found
 */
function addAction(id, { action, targetId, reason, requiresApproval = false, approvalProposalId = null, status = 'PROPOSED' }) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const actionEntry = {
    id: nextActionId(),
    action,
    targetId,
    reason,
    requiresApproval,
    approvalProposalId,
    status,
    proposedAt: new Date().toISOString(),
    executedAt: null,
    verifiedAt: null,
    verification: null,
    result: null,
  };
  rec.actions.push(actionEntry);
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Update an action's status in an investigation
 * @param {string} id - Investigation ID
 * @param {string} actionId - Action ID
 * @param {Object} updates - Status updates (status, executedAt, verifiedAt, verification, result)
 * @returns {Object|null} Updated investigation or null if not found
 */
function updateAction(id, actionId, updates) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const actionIdx = rec.actions.findIndex((a) => a.id === actionId);
  if (actionIdx === -1) return null;
  rec.actions[actionIdx] = { ...rec.actions[actionIdx], ...updates };
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Set investigation verification result
 * @param {string} id - Investigation ID
 * @param {Object} verification - Verification result with success, observed, verifiedAt
 * @returns {Object|null} Updated investigation or null if not found
 */
function setVerification(id, verification) {
  const rec = investigations.get(id);
  if (!rec) return null;
  rec.verification = {
    ...verification,
    verifiedAt: new Date().toISOString(),
  };
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Set RAG sources for an investigation
 * @param {string} id - Investigation ID
 * @param {Array} sources - RAG retrieval results
 * @returns {Object|null} Updated investigation or null if not found
 */
function setSources(id, sources) {
  const rec = investigations.get(id);
  if (!rec) return null;
  rec.sources = sources.map((s, idx) => ({
    id: s.id || `SRC-${idx}`,
    documentId: s.documentId || null,
    documentName: s.documentName || null,
    section: s.section || null,
    content: s.content || null,
    relevance: s.relevance || null,
    score: s.score || null,
    category: s.category || null,
    retrievedAt: s.retrievedAt || new Date().toISOString(),
  }));
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Set recommendations for an investigation
 * @param {string} id - Investigation ID
 * @param {Array} recommendations - Recommendation items
 * @returns {Object|null} Updated investigation or null if not found
 */
function setRecommendations(id, recommendations) {
  const rec = investigations.get(id);
  if (!rec) return null;
  rec.recommendations = recommendations;
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Set confidence for an investigation
 * @param {string} id - Investigation ID
 * @param {Object} confidence - Confidence value and label
 * @returns {Object|null} Updated investigation or null if not found
 */
function setConfidence(id, confidence) {
  const rec = investigations.get(id);
  if (!rec) return null;
  rec.confidence = confidence;
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

function transition(id, nextState, actor = 'system', notes = '') {
  const rec = investigations.get(id);
  if (!rec) return null;
  const allowed = ['detected', 'triaged', 'investigating', 'confirmed', 'dismissed', 'resolved', 'closed'];
  if (!allowed.includes(nextState)) return null;
  const prev = rec.state;
  if (prev === nextState) return { ...rec };
  rec.state = nextState;
  rec.updatedAt = new Date().toISOString();
  rec.history.push({ state: nextState, at: rec.updatedAt, actor, notes, previousState: prev });
  if (notes) rec.notes.push({ at: rec.updatedAt, actor, notes });
  investigations.set(id, rec);
  return { ...rec };
}

function addNote(id, actor, notes) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const note = { at: new Date().toISOString(), actor, notes };
  rec.notes.push(note);
  rec.updatedAt = note.at;
  investigations.set(id, rec);
  return { ...rec };
}

function start(id, actor = 'system', notes = 'Investigation started') {
  return transition(id, 'investigating', actor, notes);
}

function close(id, actor = 'system', notes = 'Investigation closed') {
  return transition(id, 'closed', actor, notes);
}

function reopen(id, actor = 'system', notes = 'Investigation reopened') {
  const rec = investigations.get(id);
  if (!rec) return null;
  if (rec.state !== 'closed' && rec.state !== 'resolved' && rec.state !== 'dismissed') return null;
  return transition(id, 'investigating', actor, notes);
}

function get(id) { const r = investigations.get(id); return r ? { ...r } : null; }

function list({ stationId, state, search, severity, startTime, endTime, sort = 'updatedAt', order = 'desc', limit, offset } = {}) {
  let rows = investigations.keys().map((id) => investigations.get(id));
  if (stationId) rows = rows.filter((r) => r.stationId === stationId);
  if (state) rows = rows.filter((r) => r.state === state);
  if (severity) {
    const sev = String(severity).toLowerCase();
    rows = rows.filter((r) => {
      if (!r.confidence) return false;
      const label = String(r.confidence.label || '').toLowerCase();
      return label.includes(sev) || String(r.state).toLowerCase().includes(sev);
    });
  }
  if (search) {
    const q = String(search).toLowerCase();
    rows = rows.filter((r) => (r.title || '').toLowerCase().includes(q) || (r.id || '').toLowerCase().includes(q) || (r.stationId || '').toLowerCase().includes(q));
  }
  if (startTime) {
    const t = new Date(startTime).getTime();
    if (!Number.isNaN(t)) rows = rows.filter((r) => new Date(r.createdAt).getTime() >= t);
  }
  if (endTime) {
    const t = new Date(endTime).getTime();
    if (!Number.isNaN(t)) rows = rows.filter((r) => new Date(r.createdAt).getTime() <= t);
  }
  const sortKey = ['updatedAt', 'createdAt', 'state', 'title'].includes(sort) ? sort : 'updatedAt';
  rows.sort((a, b) => {
    const av = a[sortKey] || '';
    const bv = b[sortKey] || '';
    const cmp = String(av).localeCompare(String(bv));
    return order === 'asc' ? cmp : -cmp;
  });
  const total = rows.length;
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeLimit = Math.min(Math.max(Number(limit) || total, 0), total);
  const paged = rows.slice(safeOffset, safeOffset + (limit ? safeLimit : total));
  return { items: paged.map((r) => ({ ...r })), total, offset: safeOffset, limit: limit || total };
}

/**
 * Get evidence collection sources available for an investigation
 * Returns the actual evidence sources based on what data is available
 */
function getEvidenceSources(id) {
  const rec = investigations.get(id);
  if (!rec) return { available: false, sources: [], reason: 'Investigation not found' };

  const sources = [];
  const now = Date.now();

  if (rec.stationId) {
    sources.push({
      type: 'station_readings',
      label: 'Current station readings',
      available: true,
      parameters: { stationId: rec.stationId },
    });
    sources.push({
      type: 'station_history',
      label: 'Historical station readings',
      available: true,
      parameters: { stationId: rec.stationId, minutes: 60 },
    });
    sources.push({
      type: 'station_health',
      label: 'Station health assessment',
      available: true,
      parameters: { stationId: rec.stationId },
    });
    sources.push({
      type: 'anomalies',
      label: 'Station anomalies',
      available: true,
      parameters: { stationId: rec.stationId },
    });
    sources.push({
      type: 'nearby_stations',
      label: 'Nearby stations comparison',
      available: true,
      parameters: { stationId: rec.stationId },
    });
    sources.push({
      type: 'maintenance_risk',
      label: 'Maintenance risk assessment',
      available: true,
      parameters: { stationId: rec.stationId },
    });
  }

  if (rec.anomalyId) {
    sources.push({
      type: 'anomaly_details',
      label: 'Anomaly details',
      available: true,
      parameters: { anomalyId: rec.anomalyId },
    });
  }

  sources.push({
    type: 'alerts',
    label: 'Current alerts',
    available: true,
    parameters: { stationId: rec.stationId || undefined },
  });
  sources.push({
    type: 'provider_status',
    label: 'Provider status',
    available: true,
    parameters: {},
  });
  sources.push({
    type: 'quality',
    label: 'Data quality metrics',
    available: true,
    parameters: {},
  });

  return { available: true, sources, investigationId: rec.id, stationId: rec.stationId };
}

/**
 * Advance investigation to a specific stage
 */
function advanceStage(id, stage, actor = 'system', detail = {}) {
  const rec = investigations.get(id);
  if (!rec) return null;
  const stageEntry = {
    stage: stage.toUpperCase(),
    at: new Date().toISOString(),
    status: 'completed',
    actor,
    detail,
  };
  const existingIdx = rec.timeline.findIndex((t) => t.stage === stage.toUpperCase());
  if (existingIdx >= 0) {
    rec.timeline[existingIdx] = stageEntry;
  } else {
    rec.timeline.push(stageEntry);
  }
  rec.updatedAt = new Date().toISOString();
  investigations.set(id, rec);
  return { ...rec };
}

/**
 * Sync agent task results to investigation
 * Called by agent supervisor after task completion to update investigation with findings
 * @param {string} investigationId - Investigation ID
 * @param {Object} task - Agent task with evidence, sources, findings, recommendations, confidence, actions
 * @returns {Object|null} Updated investigation or null if not found
 */
function syncFromAgentTask(investigationId, task) {
  const rec = investigations.get(investigationId);
  if (!rec) return null;

  const evidenceDataSeen = new Set(rec.evidence.map((e) => `${e.source}:${JSON.stringify(e.data)}`));

  if (task.evidence && task.evidence.length) {
    for (const ev of task.evidence) {
      if (ev.kind === 'OBSERVED' && ev.data) {
        const evidenceKey = `${ev.tool}:${JSON.stringify(ev.data)}`;
        if (!evidenceDataSeen.has(evidenceKey)) {
          evidenceDataSeen.add(evidenceKey);
          rec.evidence.push({
            id: nextEvidenceId(),
            source: ev.tool,
            sourceId: null,
            stationId: task.stationId || null,
            timestamp: new Date().toISOString(),
            type: 'OBSERVED',
            data: ev.data,
            verified: !!ev.verified,
            collectedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  if (task.sources && task.sources.length) {
    for (const src of task.sources) {
      const exists = rec.sources.some((s) => s.id === src.id || (s.documentId === src.documentId && s.section === src.section));
      if (!exists) {
        rec.sources.push({
          id: src.id || `SRC-${rec.sources.length + 1}`,
          documentId: src.documentId || null,
          documentName: src.documentName || null,
          section: src.section || null,
          content: src.content || null,
          relevance: src.relevance || null,
          score: src.score || null,
          category: src.category || null,
          retrievedAt: new Date().toISOString(),
        });
      }
    }
  }

  if (task.findings && task.findings.length) {
    for (const fg of task.findings) {
      if (fg.type !== 'PERMISSION_DENIED' && fg.type !== 'TOOL_FAILURE' && fg.type !== 'EXCEPTION') {
        const exists = rec.findings.some((f) => f.cause === fg.cause);
        if (!exists) {
          rec.findings.push({
            id: nextFindingId(),
            type: fg.type || 'AGENT_FINDING',
            cause: fg.cause || fg.error || 'Unknown',
            confidence: fg.confidence || null,
            evidenceRefs: fg.evidenceRefs || [],
            notes: fg.error || '',
            at: new Date().toISOString(),
          });
        }
      }
    }
  }

  if (task.recommendations && task.recommendations.items) {
    for (const recItem of task.recommendations.items) {
      const exists = rec.recommendations.some((r) => r.text === recItem.text);
      if (!exists) {
        rec.recommendations.push(recItem);
      }
    }
  }

  if (task.confidence) {
    rec.confidence = task.confidence;
  }

  if (task.actionProposals) {
    for (const prop of task.actionProposals) {
      const exists = rec.actions.some((a) => a.action === prop.action && a.targetId === prop.targetId);
      if (!exists) {
        rec.actions.push({
          id: nextActionId(),
          action: prop.action,
          targetId: prop.targetId,
          reason: prop.reason || '',
          requiresApproval: !!prop.requiresApproval,
          approvalProposalId: prop.approvalProposalId || null,
          status: prop.approvalStatus || prop.status || 'PROPOSED',
          proposedAt: new Date().toISOString(),
          executedAt: null,
          verifiedAt: null,
          verification: null,
          result: null,
        });
      }
    }
  }

  rec.updatedAt = new Date().toISOString();
  investigations.set(investigationId, rec);
  return { ...rec };
}

module.exports = {
  create,
  transition,
  addNote,
  addEvidence,
  addFinding,
  addAction,
  updateAction,
  setVerification,
  setSources,
  setRecommendations,
  setConfidence,
  getEvidenceSources,
  advanceStage,
  syncFromAgentTask,
  start,
  close,
  reopen,
  get,
  list,
};