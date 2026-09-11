import { alertApi } from '../api/index.js';
import { socketMgr } from '../api/socket.js';
import { escapeHtml, statusBadge, formatDateTime, formatTime, loadingState, errorState, toast } from '../utils/ui.js';
import { navigate } from '../router.js';

export const alertsPage = {
  id: 'alerts', title: 'Alerts', sub: 'Live alert feed with full state machine (acknowledge, resolve, mute, escalate, retry).', group: 'Operations', icon: 'fa-solid fa-bell',
  async render(root) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const focusId = params.get('focus');
    root.innerHTML = `
      <div class="grid grid-4" id="alert-stats">${loadingState('Loading stats…')}</div>
      <div class="card" style="margin-top:14px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
          <input id="al-search" class="input" placeholder="Search title / station…" style="max-width:240px;" />
          <select id="al-sev" class="input" style="max-width:140px;">
            <option value="">All severity</option>
            <option value="critical">Critical</option>
            <option value="warning">Warning</option>
          </select>
          <select id="al-state" class="input" style="max-width:160px;">
            <option value="">All states</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="resolved">Resolved</option>
          </select>
          <button class="btn secondary" id="al-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
        </div>
        <div id="al-list">${loadingState()}</div>
      </div>
    `;
    const refresh = () => { loadStats(); loadList(focusId); };
    document.getElementById('al-refresh').onclick = refresh;
    document.getElementById('al-search').oninput = () => loadList();
    document.getElementById('al-sev').onchange = () => loadList();
    document.getElementById('al-state').onchange = () => loadList();
    const off = socketMgr.on('alert:update', refresh);
    const off2 = socketMgr.on('alert:new', refresh);
    await refresh();
    return () => { off(); off2(); };
  },
};

async function loadStats() {
  try {
    const s = await alertApi.stats();
    const host = document.getElementById('alert-stats');
    host.innerHTML = `
      ${stat('Open', s.open || 0, 'red')}
      ${stat('Acknowledged', s.acknowledged || 0, 'yellow')}
      ${stat('Resolved', s.resolved || 0, 'green')}
      ${stat('Total', s.total || 0, 'gray')}
    `;
  } catch (e) { document.getElementById('alert-stats').innerHTML = errorState(e.message); }
}

function stat(l, v, c) { return `<div class="stat-card ${c}"><div class="lbl">${escapeHtml(l)}</div><div class="val">${escapeHtml(String(v))}</div></div>`; }

async function loadList(focusId) {
  const list = document.getElementById('al-list');
  list.innerHTML = loadingState();
  const search = (document.getElementById('al-search').value || '').toLowerCase();
  const sev = document.getElementById('al-sev').value;
  const state = document.getElementById('al-state').value;
  try {
    const items = await alertApi.list({ limit: 200, severity: sev || undefined });
    let rows = items;
    if (state === 'open') rows = rows.filter((a) => !a.resolved && !a.acknowledged);
    else if (state === 'acknowledged') rows = rows.filter((a) => a.acknowledged && !a.resolved);
    else if (state === 'resolved') rows = rows.filter((a) => a.resolved);
    if (search) rows = rows.filter((a) => (a.title || '').toLowerCase().includes(search) || (a.station || '').toLowerCase().includes(search));
    if (!rows.length) { list.innerHTML = '<div class="state empty">No alerts match the current filters.</div>'; return; }
    list.innerHTML = `<table><thead><tr><th>Severity</th><th>Station</th><th>Title</th><th>When</th><th>State</th><th>Actions</th></tr></thead><tbody>${rows.map((a) => `
      <tr data-id="${escapeHtml(a.id)}">
        <td>${statusBadge(a.severity)}</td>
        <td>${escapeHtml(a.station)}</td>
        <td>${escapeHtml(a.title)}</td>
        <td>${formatDateTime(a.createdAt)}</td>
        <td>${a.resolved ? statusBadge('resolved') : a.acknowledged ? statusBadge('acknowledged') : statusBadge('open')}</td>
        <td>
          <button class="btn ghost" data-act="view" data-id="${escapeHtml(a.id)}">View</button>
          ${!a.acknowledged ? `<button class="btn" data-act="ack" data-id="${escapeHtml(a.id)}">Ack</button>` : ''}
          ${!a.resolved ? `<button class="btn secondary" data-act="resolve" data-id="${escapeHtml(a.id)}">Resolve</button>` : ''}
          ${a.resolved ? `<button class="btn ghost" data-act="reopen" data-id="${escapeHtml(a.id)}">Reopen</button>` : ''}
          <button class="btn ghost" data-act="${a.muted ? 'unmute' : 'mute'}" data-id="${escapeHtml(a.id)}">${a.muted ? 'Unmute' : 'Mute'}</button>
          ${a.severity !== 'critical' ? `<button class="btn danger" data-act="esc" data-id="${escapeHtml(a.id)}">Escalate</button>` : ''}
        </td>
      </tr>`).join('')}</tbody></table>`;
    list.querySelectorAll('button[data-act]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); act(b.dataset.act, b.dataset.id, focusId); });
    list.querySelectorAll('tr[data-id]').forEach((tr) => tr.ondblclick = () => openAlert(tr.dataset.id));
    if (focusId) {
      const target = list.querySelector(`tr[data-id="${CSS.escape(focusId)}"]`);
      if (target) { target.scrollIntoView({ block: 'center' }); target.style.background = 'rgba(59,130,246,.12)'; }
    }
  } catch (e) { list.innerHTML = errorState(e.message); }
}

async function act(kind, id, focusId) {
  try {
    if (kind === 'view') return openAlert(id);
    if (kind === 'ack') await alertApi.acknowledge(id);
    if (kind === 'resolve') await alertApi.resolve(id);
    if (kind === 'reopen') await alertApi.reopen(id);
    if (kind === 'mute') await alertApi.mute(id);
    if (kind === 'unmute') await alertApi.unmute(id);
    if (kind === 'esc') await alertApi.escalate(id);
    toast('Alert updated', 'success');
    await loadList(focusId);
    await loadStats();
  } catch (e) { toast(e.message, 'error'); }
}

export async function openAlert(id) {
  const { openModal, escapeHtml, statusBadge, formatDateTime } = await import('../utils/ui.js');
  const body = document.createElement('div');
  body.innerHTML = loadingState('Loading alert…');
  const m = openModal({ title: 'Alert Detail', body, actions: [{ label: 'Retry delivery', kind: 'secondary', onClick: async (btn) => { btn.disabled = true; try { const r = await alertApi.retry(id); toast('Re-queued for delivery', 'success'); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; } } }, { label: 'Close', kind: 'ghost', onClick: (b) => m.close() }] });
  try {
    const a = await alertApi.get(id);
    const factors = (a.factors || []).map((f) => `<li>${escapeHtml(f.name)} <small style="color:#64748b">weight ${escapeHtml(f.weight)}</small></li>`).join('') || '<li>None</li>';
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        ${statusBadge(a.severity)} ${a.resolved ? statusBadge('resolved') : a.acknowledged ? statusBadge('acknowledged') : statusBadge('open')}
        <span style="margin-left:auto;color:#94a3b8;font-size:12px;">${escapeHtml(a.id)}</span>
      </div>
      <h3 style="margin-bottom:4px;">${escapeHtml(a.title)}</h3>
      <div style="color:#94a3b8;font-size:12px;margin-bottom:10px;">${escapeHtml(a.station)} (${escapeHtml(a.stationId)}) • ${formatDateTime(a.createdAt)}</div>
      <p style="margin-bottom:10px;">${escapeHtml(a.description || '—')}</p>
      <div style="margin-bottom:8px;"><strong>Recommendation:</strong> ${escapeHtml(a.recommendation || '—')}</div>
      <div style="margin-bottom:8px;"><strong>Trigger factors:</strong><ul style="margin-left:18px;margin-top:4px;">${factors}</ul></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px;color:#94a3b8;">
        <div>Acknowledged: ${a.acknowledged ? 'yes' : 'no'}</div>
        <div>Resolved: ${a.resolved ? `yes (${formatDateTime(a.resolvedAt)} by ${escapeHtml(a.resolvedBy || 'system')})` : 'no'}</div>
        <div>Created: ${formatDateTime(a.createdAt)}</div>
        <div>Updated: ${formatDateTime(a.updatedAt)}</div>
      </div>
    `;
  } catch (e) { body.innerHTML = `<div class="state error">${escapeHtml(e.message)}</div>`; }
}
