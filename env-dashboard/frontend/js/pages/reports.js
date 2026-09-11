import { reportApi } from '../api/index.js';
import { escapeHtml, statusBadge, formatDateTime, loadingState, errorState, toast } from '../utils/ui.js';

const CATEGORIES = [
  { id: 'environmental_summary', label: 'Environmental Summary' },
  { id: 'anomaly', label: 'Anomaly Report' },
  { id: 'station_health', label: 'Station Health' },
  { id: 'predictive_maintenance', label: 'Predictive Maintenance' },
  { id: 'historical_analytics', label: 'Historical Analytics' },
  { id: 'data_quality', label: 'Data Quality' },
];

export const reportsPage = {
  id: 'reports', title: 'Reports', sub: 'Generate, browse, and download operational reports.', group: 'Operations', icon: 'fa-solid fa-file-lines',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px;">
        <select id="rp-cat" class="input" style="max-width:200px;">${CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join('')}</select>
        <select id="rp-fmt" class="input" style="max-width:120px;"><option value="json">JSON</option><option value="csv">CSV</option></select>
        <button class="btn" id="rp-gen"><i class="fa-solid fa-play"></i> Generate</button>
        <input id="rp-search" class="input" placeholder="Search…" style="max-width:240px;margin-left:auto;" />
        <button class="btn secondary" id="rp-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
      </div>
      <div id="rp-list">${loadingState()}</div>
    </div>`;
    document.getElementById('rp-gen').onclick = generate;
    document.getElementById('rp-refresh').onclick = load;
    document.getElementById('rp-search').oninput = render;
    await load();
    return () => {};
  },
};

async function load() {
  try {
    const list = await reportApi.list({ limit: 200 });
    window.__skyguardReports = list;
    render();
  } catch (e) { document.getElementById('rp-list').innerHTML = errorState(e.message); }
}

function render() {
  const list = window.__skyguardReports || [];
  const search = (document.getElementById('rp-search').value || '').toLowerCase();
  const rows = list.filter((r) => !search || (r.title || '').toLowerCase().includes(search) || (r.category || '').toLowerCase().includes(search) || (r.id || '').toLowerCase().includes(search));
  const host = document.getElementById('rp-list');
  if (!rows.length) { host.innerHTML = '<div class="state empty">No reports yet. Generate one to begin.</div>'; return; }
  host.innerHTML = `<table><thead><tr><th>ID</th><th>Title</th><th>Category</th><th>Status</th><th>Rows</th><th>Created</th><th>Actions</th></tr></thead><tbody>${rows.map((r) => `<tr data-id="${escapeHtml(r.id)}">
    <td><small>${escapeHtml(r.id)}</small></td>
    <td>${escapeHtml(r.title)}</td>
    <td>${escapeHtml(r.category)}</td>
    <td>${statusBadge(r.status)}</td>
    <td>${r.rowCount ?? '—'}</td>
    <td>${formatDateTime(r.createdAt)}</td>
    <td>
      <button class="btn ghost" data-act="view">View</button>
      <button class="btn ghost" data-act="dl">Download</button>
      <button class="btn danger" data-act="del">Delete</button>
    </td>
  </tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('tbody tr').forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector('[data-act=view]').onclick = () => viewReport(id);
    tr.querySelector('[data-act=dl]').onclick = () => downloadReport(id);
    tr.querySelector('[data-act=del]').onclick = async () => { if (!confirm('Delete this report?')) return; try { await reportApi.remove(id); toast('Deleted', 'success'); await load(); } catch (e) { toast(e.message, 'error'); } };
  });
}

async function generate() {
  const category = document.getElementById('rp-cat').value;
  const format = document.getElementById('rp-fmt').value;
  try {
    const r = await reportApi.generate({ category, format });
    toast(`Report ${r.status}`, r.status === 'completed' ? 'success' : 'info');
    await load();
  } catch (e) { toast(e.message, 'error'); }
}

async function viewReport(id) {
  const { openModal, escapeHtml, formatDateTime, statusBadge } = await import('../utils/ui.js');
  const body = document.createElement('div');
  body.innerHTML = loadingState('Loading…');
  const m = openModal({ title: 'Report', body, actions: [{ label: 'Close', kind: 'ghost', onClick: (b) => b.closest('.modal-back').remove() }] });
  try {
    const r = await reportApi.get(id);
    const summary = r.summary ? Object.entries(r.summary).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(typeof v === 'object' ? JSON.stringify(v) : String(v))}</td></tr>`).join('') : '';
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">${statusBadge(r.status)} <strong>${escapeHtml(r.title)}</strong><small style="color:#64748b;margin-left:auto;">${escapeHtml(r.id)}</small></div>
      <div style="color:#94a3b8;font-size:12px;margin-bottom:10px;">${escapeHtml(r.category)} • ${formatDateTime(r.createdAt)} • ${r.fileSize || 0} bytes</div>
      ${summary ? `<table><thead><tr><th>Summary key</th><th>Value</th></tr></thead><tbody>${summary}</tbody></table>` : '<div class="state empty">No summary</div>'}
    `;
  } catch (e) { body.innerHTML = `<div class="state error">${escapeHtml(e.message)}</div>`; }
}

function downloadReport(id) {
  // Stream via fetch to avoid losing the auth header on plain navigation.
  window.SkyGuardAPI.request('GET', `/api/v1/reports/${encodeURIComponent(id)}/download`).then((res) => {
    const blob = res.raw ? new Blob([res.raw], { type: 'application/octet-stream' }) : new Blob([JSON.stringify(res, null, 2)], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${id}`; a.click(); URL.revokeObjectURL(url);
  }).catch((e) => toast(e.message, 'error'));
}
