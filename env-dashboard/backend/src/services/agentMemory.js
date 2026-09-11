'use strict';

const { randomUUID } = require('crypto');
const dataStore = require('./dataStore');

/**
 * Four memory classes — Phase 5 cleanup:
 *   - SESSION:      ephemeral, in-process Map (audit §4: dead code; kept
 *                   because /api/v1/agent/memory returns getSessionStats and
 *                   a regression test exercises it).
 *   - INVESTIGATION: PERSISTENT via dataStore (the audit's main gap).
 *   - HISTORICAL:   ephemeral ring buffer capped at 1000.
 *   - KNOWLEDGE:    ephemeral Map cache; also exposed via RAG pipeline.
 *
 * Each class is honest about its storage backend so the audit can verify
 * persistence guarantees instead of guessing.
 */

const MEMORY_TYPES = {
  SESSION: 'SESSION',
  INVESTIGATION: 'INVESTIGATION',
  HISTORICAL: 'HISTORICAL',
  KNOWLEDGE: 'KNOWLEDGE',
};

const PERSISTENT_MAP_NAME = 'agent_investigations';

class AgentMemory {
  constructor(opts = {}) {
    this.sessions = new Map();
    this.historical = [];
    this.knowledge = new Map();
    this.maxHistorical = opts.maxHistorical || 1000;
    this.maxKnowledge = opts.maxKnowledge || 500;
    // Phase 5: investigations are durable. dataStore gives us file-backed
    // JSON that survives process restarts (the SQLite-architecture fallback
    // the audit called for). We expose the Map directly so callers can do
    // .get/.set without learning the dataStore API.
    this._investigationStore = dataStore.getMap(PERSISTENT_MAP_NAME);
    this.investigations = {
      get: (id) => this._investigationStore.get(id),
      set: (id, value) => this._investigationStore.set(id, value),
      has: (id) => this._investigationStore.has(id),
      delete: (id) => this._investigationStore.delete(id),
      keys: () => this._investigationStore.keys(),
      values: () => {
        const out = {};
        for (const k of this._investigationStore.keys()) {
          const v = this._investigationStore.get(k);
          if (v) out[k] = v;
        }
        return out;
      },
      forEach: (cb) => {
        for (const k of this._investigationStore.keys()) {
          const v = this._investigationStore.get(k);
          if (v) cb(v, k);
        }
      },
      size: () => this._investigationStore.size(),
      // Phase 5 diagnostic — exposes the persistence backend so callers and
      // tests can confirm "this is durable".
      persistence: () => ({ backend: 'dataStore:file-backed', mapName: PERSISTENT_MAP_NAME, file: require('path').join(dataStore.ROOT, `${PERSISTENT_MAP_NAME}.json`) }),
    };
  }

  // ---------------- SESSION (ephemeral) ----------------
  createSession(sessionId, metadata = {}) {
    const session = {
      id: sessionId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      metadata, events: [], toolCalls: [], investigations: [], status: 'ACTIVE',
    };
    this.sessions.set(sessionId, session);
    return session;
  }
  getSession(sessionId) { const s = this.sessions.get(sessionId); return s ? { ...s } : null; }
  addSessionEvent(sessionId, event) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const evt = { id: `SEVT-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...event };
    session.events.push(evt); session.updatedAt = new Date().toISOString();
    return evt;
  }
  addSessionToolCall(sessionId, toolCall) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const call = { id: `STC-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...toolCall };
    session.toolCalls.push(call); session.updatedAt = new Date().toISOString();
    return call;
  }
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.status = 'CLOSED'; session.closedAt = new Date().toISOString();
    session.updatedAt = session.closedAt;
    return { ...session };
  }

  // ---------------- INVESTIGATION (PERSISTENT) ----------------
  createInvestigationMemory(investigationId, data) {
    const mem = {
      id: investigationId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'OPEN',
      evidence: [],
      findings: [],
      rootCause: null,
      confidence: null,
      recommendations: [],
      actions: [],
      verification: null,
      resolution: null,
      ...data,
    };
    this.investigations.set(investigationId, mem);
    return mem;
  }

  getInvestigationMemory(investigationId) {
    const mem = this.investigations.get(investigationId);
    return mem ? { ...mem } : null;
  }

  addEvidence(investigationId, evidence) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.evidence.push({ id: `EV-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...evidence });
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return mem.evidence[mem.evidence.length - 1];
  }

  addFinding(investigationId, finding) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.findings.push({ id: `FN-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...finding });
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return mem.findings[mem.findings.length - 1];
  }

  setRootCause(investigationId, rootCause, confidence) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.rootCause = rootCause; mem.confidence = confidence;
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return { rootCause, confidence };
  }

  addRecommendation(investigationId, recommendation) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.recommendations.push({ id: `RC-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...recommendation });
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return mem.recommendations[mem.recommendations.length - 1];
  }

  addAction(investigationId, action) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.actions.push({ id: `AC-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...action });
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return mem.actions[mem.actions.length - 1];
  }

  setVerification(investigationId, verification) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.verification = verification;
    mem.updatedAt = new Date().toISOString();
    this.investigations.set(investigationId, mem);
    return verification;
  }

  resolveInvestigation(investigationId, resolution) {
    const mem = this.investigations.get(investigationId);
    if (!mem) return null;
    mem.state = 'RESOLVED'; mem.resolution = resolution;
    mem.resolvedAt = new Date().toISOString();
    mem.updatedAt = mem.resolvedAt;
    this.investigations.set(investigationId, mem);
    return { ...mem };
  }

  // ---------------- HISTORICAL (ephemeral ring) ----------------
  addHistorical(event) {
    this.historical.push({ id: `HIST-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...event });
    if (this.historical.length > this.maxHistorical) {
      this.historical = this.historical.slice(-this.maxHistorical);
    }
    return this.historical[this.historical.length - 1];
  }

  // ---------------- KNOWLEDGE (ephemeral cache) ----------------
  addKnowledge(key, knowledge) {
    this.knowledge.set(key, { id: `KNW-${randomUUID().slice(0, 6)}`, timestamp: new Date().toISOString(), ...knowledge });
    if (this.knowledge.size > this.maxKnowledge) {
      const firstKey = this.knowledge.keys().next().value;
      this.knowledge.delete(firstKey);
    }
    return this.knowledge.get(key);
  }

  getKnowledge(key) { return this.knowledge.get(key) || null; }

  getSessionStats() {
    try {
      return {
        activeSessions: [...this.sessions.values()].filter((s) => s.status === 'ACTIVE').length,
        totalSessions: this.sessions.size,
        totalInvestigations: this.investigations.size(),
        openInvestigations: (() => {
          let n = 0;
          try {
            this.investigations.forEach((i) => { if (i && i.state === 'OPEN') n++; });
          } catch (_) {}
          return n;
        })(),
        historicalEvents: this.historical.length,
        knowledgeEntries: this.knowledge.size,
        persistence: this.investigations.persistence(),
      };
    } catch (e) {
      return {
        activeSessions: 0,
        totalSessions: this.sessions.size,
        totalInvestigations: 0,
        openInvestigations: 0,
        historicalEvents: this.historical.length,
        knowledgeEntries: this.knowledge.size,
        error: e.message,
      };
    }
  }
}

module.exports = { AgentMemory, MEMORY_TYPES, PERSISTENT_MAP_NAME };
