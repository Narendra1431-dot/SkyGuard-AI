'use strict';

const { randomUUID } = require('crypto');
const dataStore = require('./dataStore');
const proposals = dataStore.getMap('agent_proposals');
const ALLOWED = new Map([
  ['acknowledge_alert', { risk: 'MEDIUM', permission: 'analyst' }],
  ['resolve_alert', { risk: 'HIGH', permission: 'analyst' }],
  ['run_health_check', { risk: 'LOW', permission: 'analyst' }],
  ['generate_report', { risk: 'MEDIUM', permission: 'analyst' }],
  ['test_provider', { risk: 'LOW', permission: 'analyst' }],
  ['update_threshold', { risk: 'HIGH', permission: 'admin' }],
  ['retrain_model', { risk: 'CRITICAL', permission: 'admin' }],
  ['escalate_alert', { risk: 'HIGH', permission: 'analyst' }],
]);

function propose({ action, targetId, reason, evidence = [], expectedImpact = '' }) {
  const policy = ALLOWED.get(action);
  if (!policy) throw new Error('Action is not allowlisted');
  const proposal = { id: `ACT-${randomUUID()}`, action, targetId, reason: reason || 'No reason supplied', evidence, riskLevel: policy.risk, requiredPermission: policy.permission, expectedImpact, status: 'PENDING', createdAt: new Date().toISOString() };
  proposals.set(proposal.id, proposal);
  return { ...proposal };
}

function get(id) { const p = proposals.get(id); return p ? { ...p } : null; }
function list() { return proposals.keys().map((id) => ({ ...proposals.get(id) })); }
function reject(id, actor) {
  const proposal = proposals.get(id);
  if (!proposal || proposal.status !== 'PENDING') return null;
  proposal.status = 'REJECTED'; proposal.decidedAt = new Date().toISOString(); proposal.decidedBy = actor;
  proposals.set(id, proposal);
  return { ...proposal };
}
async function approve(id, actor, handlers) {
  const proposal = proposals.get(id);
  if (!proposal || proposal.status !== 'PENDING') return null;
  const execute = handlers[proposal.action];
  if (!execute) throw new Error('Action handler is not available');
  proposal.status = 'EXECUTING'; proposal.approvedAt = new Date().toISOString(); proposal.approvedBy = actor;
  proposals.set(id, proposal);
  try {
    const execution = await execute(proposal.targetId, actor);
    const verified = await handlers.verify(proposal.action, proposal.targetId, execution);
    proposal.execution = execution;
    proposal.verification = verified;
    proposal.status = verified.success ? 'COMPLETED' : 'FAILED';
    proposal.completedAt = new Date().toISOString();
  } catch (e) {
    proposal.status = 'FAILED';
    proposal.error = e.message;
  }
  proposals.set(id, proposal);
  return { ...proposal };
}

module.exports = { ALLOWED, propose, get, list, reject, approve };
