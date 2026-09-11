import { investigationApi, stationApi, socketMgr } from '../api/index.js';
import { escapeHtml, statusBadge, loadingState, errorState, formatDateTime, formatTime, toast } from '../utils/ui.js';

export const investigationsPage = {
  id: 'investigations', title: 'Investigations', sub: 'Anomaly investigation workflow: detected → triaged → investigating → confirmed → dismissed → resolved → closed.', group: 'Operations', icon: 'fa-solid fa-magnifying-glass-chart',
  async render(root) {
    root.innerHTML = `
      <div class="card">
        <div class="row" style="margin-bottom:8px;flex-wrap:wrap;gap:8px;align-items:center;">
          <input id="iv-search" class="input" placeholder="Search title / ID / station…" style="max-width:220px;" />
          <select id="iv-state" class="input" style="max-width:150px;">
            <option value="">All states</option>
            <option value="detected">Detected</option>
            <option value="triaged">Triaged</option>
            <option value="investigating">Investigating</option>
            <option value="confirmed">Confirmed</option>
            <option value="dismissed">Dismissed</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select id="iv-sort" class="input" style="max-width:150px;">
            <option value="updatedAt:desc">Newest first</option>
            <option value="createdAt:desc">Created first</option>
            <option value="createdAt:asc">Created oldest</option>
          </select>
          <button class="btn compact secondary" id="iv-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <button class="btn compact" id="iv-create"><i class="fa-solid fa-plus"></i> New Investigation</button>
          <span style="margin-left:auto;color:#64748b;font-size:11px;" id="iv-count"></span>
        </div>
        <div id="iv-list">${loadingState()}</div>
        <div id="iv-pager" class="row" style="margin-top:8px;gap:8px;"></div>
      </div>
      <div id="iv-detail-host"></div>
    `;
    let offset = 0;
    const PAGE = 20;
    let totalItems = 0;

    const load = async (resetOffset = true) => {
      if (resetOffset) offset = 0;
      const host = document.getElementById('iv-list');
      if (!host) return;
      host.innerHTML = loadingState();
      const state = document.getElementById('iv-state').value;
      const search = document.getElementById('iv-search').value.trim();
      const sortVal = (document.getElementById('iv-sort').value || 'updatedAt:desc').split(':');
      const sort = sortVal[0] || 'updatedAt';
      const order = sortVal[1] || 'desc';
      try {
        const items = await investigationApi.list({ state: state || undefined, search: search || undefined, sort, order, limit: PAGE, offset });
        totalItems = items.total || items.length || 0;
        document.getElementById('iv-count').textContent = `${totalItems} investigations`;
        if (!items.length) { host.innerHTML = '<div class="state empty">No investigations.</div>'; document.getElementById('iv-pager').innerHTML = ''; return; }
        host.innerHTML = items.map((inv) => renderInvestigationCard(inv)).join('');
        attachCardListeners(host);
        renderPager(offset, PAGE, totalItems);
      } catch (e) {
        host.innerHTML = errorState(e.message);
      }
    };

    const renderPager = (off, page, total) => {
      const ph = document.getElementById('iv-pager');
      if (!ph) return;
      const pages = Math.max(1, Math.ceil(total / page));
      const cur = Math.floor(off / page) + 1;
      let btns = '';
      if (cur > 1) btns += `<button class="btn compact secondary" id="iv-prev">Prev</button>`;
      btns += `<span style="color:#64748b;font-size:11px;">Page ${cur} / ${pages} (${total} total)</span>`;
      if (cur < pages) btns += `<button class="btn compact secondary" id="iv-next">Next</button>`;
      ph.innerHTML = btns;
      const prev = ph.querySelector('#iv-prev');
      const next = ph.querySelector('#iv-next');
      if (prev) prev.onclick = () => { offset = Math.max(0, off - page); load(false); };
      if (next) next.onclick = () => { offset = Math.min(total - page, off + page); load(false); };
    };

    document.getElementById('iv-state').onchange = () => load();
    document.getElementById('iv-search').oninput = () => load();
    document.getElementById('iv-sort').onchange = () => load();
    document.getElementById('iv-refresh').onclick = () => load();
    document.getElementById('iv-create').onclick = async () => {
      const title = prompt('Investigation title:');
      if (!title) return;
      try {
        const stations = await stationApi.list();
        const stationId = stations.length ? stations[0].id : null;
        const rec = await investigationApi.create({ title, stationId: stationId || undefined });
        toast('Investigation created', 'success');
        await load();
        showDetail(rec.data?.id || rec.id);
      } catch (e) { toast(e.message || 'Create failed', 'error'); }
    };
    const off = socketMgr.on('investigation:updated', () => load(false));
    await load();
    return () => { off(); };
  },
};

function renderInvestigationCard(inv) {
  const hasEvidence = inv.evidence && inv.evidence.length > 0;
  const hasFindings = inv.findings && inv.findings.length > 0;
  const hasSources = inv.sources && inv.sources.length > 0;
  const hasRecommendations = inv.recommendations && inv.recommendations.length > 0;
  const hasActions = inv.actions && inv.actions.length > 0;
  const hasVerification = inv.verification !== null;
  const hasConfidence = inv.confidence !== null;

  return `<div class="card mt-2" data-investigation-id="${escapeHtml(inv.id)}" style="cursor:pointer;">
    <div class="row"><span class="inv-state ${escapeHtml(inv.state)}">${escapeHtml(inv.state.toUpperCase())}</span><strong>${escapeHtml(inv.title)}</strong><small class="muted" style="margin-left:auto;">${escapeHtml(inv.id)} • ${escapeHtml(inv.stationId || '—')}</small></div>
    <div class="muted" style="font-size:11px;margin-top:4px;">Created ${formatDateTime(inv.createdAt)} • Updated ${formatDateTime(inv.updatedAt)}</div>
    ${inv.anomalyId ? `<div class="muted" style="font-size:11px;margin-top:2px;">Anomaly: ${escapeHtml(inv.anomalyId)}</div>` : ''}
    ${hasConfidence ? `<div class="mt-2"><span class="label">Confidence:</span> <span>${escapeHtml(inv.confidence.label || inv.confidence.value || '—')}</span></div>` : ''}
    ${hasEvidence ? `<div class="mt-2"><div class="label">Evidence (${inv.evidence.length})</div><div class="inv-evidence">${inv.evidence.slice(0, 5).map((ev) => `<div class="evidence-item"><span class="evidence-source">${escapeHtml(ev.source)}</span>${ev.stationId ? `<span class="muted">@ ${escapeHtml(ev.stationId)}</span>` : ''}<span class="muted">${formatTime(ev.collectedAt || ev.timestamp)}</span>${ev.verified !== undefined ? `<span class="badge ${ev.verified ? 'success' : 'warning'}">${ev.verified ? 'verified' : 'unverified'}</span>` : ''}</div>`).join('')}${inv.evidence.length > 5 ? `<div class="muted">+${inv.evidence.length - 5} more</div>` : ''}</div></div>` : ''}
    ${hasFindings ? `<div class="mt-2"><div class="label">Findings</div><div class="inv-findings">${inv.findings.slice(0, 3).map((fg) => `<div class="finding-item"><span class="badge ${fg.type === 'ROOT_CAUSE' ? 'error' : 'info'}">${escapeHtml(fg.type)}</span><span>${escapeHtml(fg.cause)}</span>${fg.confidence ? `<span class="muted">${(fg.confidence * 100).toFixed(0)}%</span>` : ''}</div>`).join('')}${inv.findings.length > 3 ? `<div class="muted">+${inv.findings.length - 3} more</div>` : ''}</div></div>` : ''}
    ${hasSources ? `<div class="mt-2"><div class="label">RAG / Knowledge Sources</div><div class="inv-sources">${inv.sources.slice(0, 5).map((src) => `<div class="source-item"><span>${escapeHtml(src.documentName || src.section || src.id || 'Unknown')}</span>${src.relevance ? `<span class="muted">${(src.relevance * 100).toFixed(0)}%</span>` : ''}</div>`).join('')}${inv.sources.length > 5 ? `<div class="muted">+${inv.sources.length - 5} more</div>` : ''}</div></div>` : ''}
    ${hasRecommendations ? `<div class="mt-2"><div class="label">Recommendations</div><div class="inv-recommendations">${inv.recommendations.slice(0, 5).map((r) => `<div class="recommendation-item"><span class="badge ${r.type === 'RECOMMENDED' ? 'primary' : r.type === 'MONITOR' ? 'secondary' : 'info'}">${escapeHtml(r.type)}</span><span>${escapeHtml(r.text || r)}</span></div>`).join('')}${inv.recommendations.length > 5 ? `<div class="muted">+${inv.recommendations.length - 5} more</div>` : ''}</div></div>` : ''}
    ${hasActions ? `<div class="mt-2"><div class="label">Actions</div><div class="inv-actions">${inv.actions.slice(0, 5).map((ac) => `<div class="action-item"><span class="badge ${ac.status === 'COMPLETED' ? 'success' : ac.status === 'FAILED' ? 'error' : ac.status === 'PENDING_APPROVAL' || ac.status === 'PENDING' ? 'warning' : 'secondary'}">${escapeHtml(ac.status)}</span><span>${escapeHtml(ac.action)}</span>${ac.targetId ? `<span class="muted">→ ${escapeHtml(ac.targetId)}</span>` : ''}${ac.approvalProposalId ? `<span class="muted">(${escapeHtml(ac.approvalProposalId)})</span>` : ''}</div>`).join('')}${inv.actions.length > 5 ? `<div class="muted">+${inv.actions.length - 5} more</div>` : ''}</div></div>` : ''}
    ${hasVerification ? `<div class="mt-2"><div class="label">Verification</div><div class="inv-verification"><span class="badge ${inv.verification?.success ? 'success' : 'error'}">${inv.verification?.success ? 'VERIFIED' : 'FAILED'}</span><span class="muted">${formatDateTime(inv.verification?.verifiedAt)}</span>${inv.verification?.verifiedBy ? `<span>by ${escapeHtml(inv.verification.verifiedBy)}</span>` : ''}</div></div>` : ''}
    <div class="inv-history mt-2">${(inv.history || []).slice(-3).reverse().map((h) => `<div class="h">${escapeHtml(h.state)} • ${formatTime(h.at)} • ${escapeHtml(h.actor)}${h.notes ? ' — ' + escapeHtml(h.notes) : ''}</div>`).join('') || '<div class="muted">No history</div>'}</div>
    ${(inv.notes && inv.notes.length > 0) ? `<div class="mt-2"><div class="label">Notes</div><div class="inv-notes">${inv.notes.slice(-3).map((n) => `<div class="muted">${escapeHtml(n.notes || n.text || '')} ${formatTime(n.timestamp || n.createdAt || n.at)}</div>`).join('')}</div></div>` : ''}
    <div class="row mt-2" style="gap:4px;flex-wrap:wrap;">
      <input class="input" placeholder="Add a note…" data-note style="flex:1;" />
      <button class="btn compact" data-note-add>Add note</button>
    </div>
      ${['triaged', 'investigating', 'confirmed', 'dismissed'].filter((s) => s !== inv.state).map((s) => `<button class="btn compact secondary" data-trans="${escapeHtml(inv.id)}:${escapeHtml(s)}">→ ${escapeHtml(s)}</button>`).join('')}
      ${inv.state === 'investigating' || inv.state === 'confirmed' ? `<button class="btn compact" data-verify="${escapeHtml(inv.id)}">Verify</button>` : ''}
      ${inv.state !== 'resolved' && inv.state !== 'closed' && inv.state !== 'dismissed' ? `<button class="btn compact secondary" data-resolve="${escapeHtml(inv.id)}">Resolve</button>` : ''}
      ${inv.state === 'resolved' || inv.state === 'dismissed' ? `<button class="btn compact" data-reopen="${escapeHtml(inv.id)}">Reopen</button>` : ''}
      ${inv.state !== 'closed' ? `<button class="btn compact secondary" data-close="${escapeHtml(inv.id)}">Close</button>` : ''}
    </div>
  </div>`;
}

function attachCardListeners(host) {
  host.querySelectorAll('[data-trans]').forEach((b) => b.onclick = async () => {
    const [id, st] = b.dataset.trans.split(':');
    try { await investigationApi.transition(id, st, ''); toast(`Moved to ${st}`, 'success'); } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-resolve]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.resolve;
    try { await investigationApi.transition(id, 'resolved', 'Resolved by operator'); toast('Resolved', 'success'); } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-close]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.close;
    try { await investigationApi.close(id, ''); toast('Closed', 'success'); } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-reopen]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.reopen;
    try { await investigationApi.reopen(id, ''); toast('Reopened', 'success'); } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-verify]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.verify;
    try { const r = await investigationApi.verify(id); toast(r.data?.success ? 'Verified' : 'Verification completed', r.data?.success ? 'success' : 'info'); } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-note-add]').forEach((b) => b.onclick = async () => {
    const card = b.closest('[data-investigation-id]');
    if (!card) return;
    const id = card.dataset.investigationId;
    const input = card.querySelector('[data-note]');
    if (!input || !input.value.trim()) return;
    try { await investigationApi.addNote(id, input.value.trim()); toast('Note added', 'success'); input.value = ''; } catch (e) { toast(e.message, 'error'); }
  });
  host.querySelectorAll('[data-investigation-id]').forEach((card) => {
    card.onclick = async (e) => {
      if (e.target.closest('button')) return;
      const id = card.dataset.investigationId;
      showDetail(id);
    };
  });
}

async function showDetail(id) {
  const host = document.getElementById('iv-detail-host');
  if (!host) return;
  host.innerHTML = loadingState('Loading investigation…');
  try {
    const inv = await investigationApi.get(id);
    const rec = inv.data || inv;
    if (!rec || !rec.id) { host.innerHTML = errorState('Investigation not found'); return; }
    const hasEvidence = rec.evidence && rec.evidence.length > 0;
    const hasFindings = rec.findings && rec.findings.length > 0;
    const hasSources = rec.sources && rec.sources.length > 0;
    const hasRecommendations = rec.recommendations && rec.recommendations.length > 0;
    const hasActions = rec.actions && rec.actions.length > 0;
    const hasVerification = rec.verification !== null;
    const hasConfidence = rec.confidence !== null;

    host.innerHTML = `
      <div class="card mt-2">
        <div class="row" style="flex-wrap:wrap;gap:8px;align-items:center;">
          <span class="inv-state ${escapeHtml(rec.state)}">${escapeHtml(rec.state.toUpperCase())}</span>
          <strong>${escapeHtml(rec.title)}</strong>
          <small class="muted">${escapeHtml(rec.id)} • ${escapeHtml(rec.stationId || '—')}</small>
          <button class="btn compact secondary" id="iv-detail-close">Close</button>
        </div>
        <div class="muted" style="font-size:11px;margin-top:4px;">Created ${formatDateTime(rec.createdAt)} • Updated ${formatDateTime(rec.updatedAt)}</div>
        ${rec.anomalyId ? `<div class="muted" style="font-size:11px;margin-top:2px;">Triggered by anomaly/alert: ${escapeHtml(rec.anomalyId)}</div>` : ''}
        <div class="row mt-2" style="gap:8px;flex-wrap:wrap;">
          <button class="btn compact secondary" id="iv-detail-trans-triaged" ${rec.state === 'triaged' ? 'disabled' : ''}>Triaged</button>
          <button class="btn compact secondary" id="iv-detail-trans-investigating" ${rec.state === 'investigating' ? 'disabled' : ''}>Investigating</button>
          <button class="btn compact secondary" id="iv-detail-trans-confirmed" ${rec.state === 'confirmed' ? 'disabled' : ''}>Confirmed</button>
          <button class="btn compact secondary" id="iv-detail-trans-dismissed" ${rec.state === 'dismissed' ? 'disabled' : ''}>Dismissed</button>
          <button class="btn compact" id="iv-detail-resolve" ${rec.state === 'resolved' || rec.state === 'closed' ? 'disabled' : ''}>Resolve</button>
          <button class="btn compact secondary" id="iv-detail-reopen" ${!(rec.state === 'resolved' || rec.state === 'dismissed' || rec.state === 'closed') ? 'disabled' : ''}>Reopen</button>
          <button class="btn compact secondary" id="iv-detail-close2" ${rec.state === 'closed' ? 'disabled' : ''}>Close</button>
          <button class="btn compact" id="iv-detail-verify" ${!(rec.state === 'investigating' || rec.state === 'confirmed') ? 'disabled' : ''}>Verify</button>
        </div>

        <div class="mt-2">
          <div class="label">Evidence (OBSERVED FACTS)</div>
          ${hasEvidence ? `<div class="inv-evidence">${rec.evidence.map((ev) => `<div class="evidence-item"><span class="evidence-source">${escapeHtml(ev.source)}</span>${ev.stationId ? `<span class="muted">@ ${escapeHtml(ev.stationId)}</span>` : ''}<span class="muted">${formatTime(ev.collectedAt || ev.timestamp)}</span>${ev.verified !== undefined ? `<span class="badge ${ev.verified ? 'success' : 'warning'}">${ev.verified ? 'verified' : 'unverified'}</span>` : ''}<span class="muted" style="font-size:10px;">${escapeHtml(JSON.stringify(ev.data || {}).slice(0, 120))}</span></div>`).join('')}</div>` : '<div class="muted">No evidence collected.</div>'}
        </div>

        <div class="mt-2">
          <div class="label">RAG / Knowledge Sources</div>
          ${hasSources ? `<div class="inv-sources">${rec.sources.map((src) => `<div class="source-item"><span>${escapeHtml(src.documentName || src.section || src.id || 'Unknown')}</span>${src.relevance ? `<span class="muted">${(src.relevance * 100).toFixed(0)}%</span>` : ''}</div>`).join('')}</div>` : '<div class="muted">No sources.</div>'}
        </div>

        <div class="mt-2">
          <div class="label">Findings (INFERRED / HYPOTHESIS)</div>
          ${hasFindings ? `<div class="inv-findings">${rec.findings.map((fg) => `<div class="finding-item"><span class="badge ${fg.type === 'ROOT_CAUSE' ? 'error' : 'info'}">${escapeHtml(fg.type)}</span><span>${escapeHtml(fg.cause)}</span>${fg.confidence ? `<span class="muted">${(fg.confidence * 100).toFixed(0)}% confidence</span>` : ''}<div class="muted" style="font-size:10px;">${escapeHtml(fg.notes || '')}</div></div>`).join('')}</div>` : '<div class="muted">No findings.</div>'}
        </div>

        <div class="mt-2">
          <div class="label">Recommendations</div>
          ${hasRecommendations ? `<div class="inv-recommendations">${rec.recommendations.map((r) => `<div class="recommendation-item"><span class="badge ${r.type === 'RECOMMENDED' ? 'primary' : r.type === 'MONITOR' ? 'secondary' : 'info'}">${escapeHtml(r.type)}</span><span>${escapeHtml(r.text || r)}</span></div>`).join('')}</div>` : '<div class="muted">No recommendations.</div>'}
        </div>

        <div class="mt-2">
          <div class="label">Actions</div>
          ${hasActions ? `<div class="inv-actions">${rec.actions.map((ac) => `<div class="action-item"><span class="badge ${ac.status === 'COMPLETED' ? 'success' : ac.status === 'FAILED' ? 'error' : ac.status === 'PENDING_APPROVAL' || ac.status === 'PENDING' ? 'warning' : 'secondary'}">${escapeHtml(ac.status)}</span><span>${escapeHtml(ac.action)}</span>${ac.targetId ? `<span class="muted">→ ${escapeHtml(ac.targetId)}</span>` : ''}${ac.approvalProposalId ? `<span class="muted">(${escapeHtml(ac.approvalProposalId)})</span>` : ''}</div>`).join('')}</div>` : '<div class="muted">No actions proposed.</div>'}
        </div>

        ${hasVerification ? `<div class="mt-2"><div class="label">Verification</div><div class="inv-verification"><span class="badge ${rec.verification?.success ? 'success' : 'error'}">${rec.verification?.success ? 'VERIFIED' : 'FAILED'}</span><span class="muted">${formatDateTime(rec.verification?.verifiedAt)}</span>${rec.verification?.verifiedBy ? `<span>by ${escapeHtml(rec.verification.verifiedBy)}</span>` : ''}${rec.verification?.actionVerifications && rec.verification.actionVerifications.length > 0 ? `<div class="muted" style="font-size:10px;">${rec.verification.actionVerifications.length} action(s) verified</div>` : ''}</div></div>` : ''}
        ${hasConfidence ? `<div class="mt-2"><span class="label">Confidence:</span> <span>${escapeHtml(rec.confidence.label || String(rec.confidence.value || '—'))}</span>${rec.confidence.basis ? `<div class="muted" style="font-size:10px;">${rec.confidence.basis.map((b) => escapeHtml(b)).join(' • ')}</div>` : ''}</div>` : ''}

        <div class="mt-2">
          <div class="label">History</div>
          <div class="inv-history">${(rec.history || []).slice().reverse().map((h) => `<div class="h">${escapeHtml(h.state)} • ${formatTime(h.at)} • ${escapeHtml(h.actor)}${h.notes ? ' — ' + escapeHtml(h.notes) : ''}</div>`).join('') || '<div class="muted">No history</div>'}</div>
        </div>

        <div class="row mt-2" style="gap:8px;">
          <input class="input" placeholder="Add a note…" id="iv-detail-note" data-note style="flex:1;" />
          <button class="btn compact" id="iv-detail-note-add" data-note-add>Add note</button>
        </div>
      </div>
    `;

    const transMap = { 'iv-detail-trans-triaged': 'triaged', 'iv-detail-trans-investigating': 'investigating', 'iv-detail-trans-confirmed': 'confirmed', 'iv-detail-trans-dismissed': 'dismissed' };
    for (const [btnId, state] of Object.entries(transMap)) {
      const btn = document.getElementById(btnId);
      if (btn) btn.onclick = async () => { try { await investigationApi.transition(rec.id, state, ''); toast(`Moved to ${state}`, 'success'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    }
    const resolveBtn = document.getElementById('iv-detail-resolve');
    if (resolveBtn) resolveBtn.onclick = async () => { try { await investigationApi.transition(rec.id, 'resolved', 'Resolved by operator'); toast('Resolved', 'success'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    const reopenBtn = document.getElementById('iv-detail-reopen');
    if (reopenBtn) reopenBtn.onclick = async () => { try { await investigationApi.reopen(rec.id, ''); toast('Reopened', 'success'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    const closeBtn = document.getElementById('iv-detail-close');
    if (closeBtn) closeBtn.onclick = async () => { try { await investigationApi.close(rec.id, ''); toast('Closed', 'success'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    const closeBtn2 = document.getElementById('iv-detail-close2');
    if (closeBtn2) closeBtn2.onclick = async () => { try { await investigationApi.close(rec.id, ''); toast('Closed', 'success'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    const verifyBtn = document.getElementById('iv-detail-verify');
    if (verifyBtn) verifyBtn.onclick = async () => { try { const r = await investigationApi.verify(rec.id); toast(r.data?.success ? 'Verified' : 'Verification completed', r.data?.success ? 'success' : 'info'); await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
    const noteAdd = document.getElementById('iv-detail-note-add');
    const noteInput = document.getElementById('iv-detail-note');
    if (noteAdd && noteInput) noteAdd.onclick = async () => { if (!noteInput.value.trim()) return; try { await investigationApi.addNote(rec.id, noteInput.value.trim()); toast('Note added', 'success'); noteInput.value = ''; await showDetail(rec.id); } catch (e) { toast(e.message, 'error'); } };
  } catch (e) {
    host.innerHTML = errorState(e.message);
  }
}
