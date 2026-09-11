import { auditApi } from '../api/index.js';
import { escapeHtml, statusBadge, formatDateTime, loadingState, errorState } from '../utils/ui.js';

export const auditPage = {
  id: 'audit', title: 'Audit Log', sub: 'Every configuration change is recorded here.', group: 'Admin', icon: 'fa-solid fa-clipboard-list',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <input id="au-search" class="input" placeholder="Search actor / action / resource…" style="max-width:280px;" />
        <select id="au-action" class="input" style="max-width:160px;"><option value="">All actions</option></select>
        <select id="au-resource" class="input" style="max-width:160px;"><option value="">All resources</option></select>
        <button class="btn secondary" id="au-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
      </div>
      <div id="au-list">${loadingState()}</div>
    </div>`;
    const [data] = await Promise.all([auditApi.list({ limit: 200 }).catch(() => [])]);
    window.__skyguardAudit = data;
    fillSelect('au-action', [...new Set(data.map((d) => d.action).filter(Boolean))]);
    fillSelect('au-resource', [...new Set(data.map((d) => d.resource).filter(Boolean))]);
    const refresh = render;
    document.getElementById('au-refresh').onclick = async () => { window.__skyguardAudit = await auditApi.list({ limit: 200 }); render(); };
    document.getElementById('au-search').oninput = render;
    document.getElementById('au-action').onchange = render;
    document.getElementById('au-resource').onchange = render;
    render();
    return () => {};
  },
};

function fillSelect(id, values) {
  const el = document.getElementById(id);
  el.innerHTML = '<option value="">' + el.firstChild?.textContent + '</option>' + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}

function render() {
  const data = window.__skyguardAudit || [];
  const search = (document.getElementById('au-search').value || '').toLowerCase();
  const action = document.getElementById('au-action').value;
  const resource = document.getElementById('au-resource').value;
  let rows = data;
  if (action) rows = rows.filter((r) => r.action === action);
  if (resource) rows = rows.filter((r) => r.resource === resource);
  if (search) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(search));
  const host = document.getElementById('au-list');
  if (!rows.length) { host.innerHTML = '<div class="state empty">No audit entries match.</div>'; return; }
  host.innerHTML = `<table><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>Result</th><th>Detail</th></tr></thead><tbody>${rows.map((r) => `<tr>
    <td>${formatDateTime(r.timestamp)}</td>
    <td>${escapeHtml(r.actor)}</td>
    <td>${escapeHtml(r.action)}</td>
    <td>${escapeHtml(r.resource)}${r.resourceId ? ` <small>(${escapeHtml(r.resourceId)})</small>` : ''}</td>
    <td>${statusBadge(r.result || 'SUCCESS')}</td>
    <td><pre style="white-space:pre-wrap;color:#94a3b8;margin:0;font-size:11px;">${escapeHtml(truncate(JSON.stringify({ old: r.oldValue, new: r.newValue, error: r.error }, null, 2), 220))}</pre></td>
  </tr>`).join('')}</tbody></table>`;
}

function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
