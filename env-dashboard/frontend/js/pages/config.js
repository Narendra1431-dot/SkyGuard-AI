import { configApi } from '../api/index.js';
import { escapeHtml, loadingState, errorState, toast } from '../utils/ui.js';

const SECTIONS = [
  { id: 'thresholds', title: 'Thresholds', adminOnly: false },
  { id: 'system', title: 'System', adminOnly: false },
  { id: 'anomaly', title: 'Anomaly', adminOnly: false },
  { id: 'health', title: 'Health', adminOnly: false },
  { id: 'maintenance', title: 'Maintenance', adminOnly: false },
  { id: 'ml', title: 'ML', adminOnly: false },
  { id: 'monitoring', title: 'Monitoring', adminOnly: true },
  { id: 'alerts', title: 'Alerts', adminOnly: true },
  { id: 'agent', title: 'Agent', adminOnly: true },
  { id: 'rag', title: 'RAG', adminOnly: true },
  { id: 'realtime', title: 'Realtime', adminOnly: true },
  { id: 'storage', title: 'Storage', adminOnly: true },
  { id: 'security', title: 'Security', adminOnly: true },
  { id: 'performance', title: 'Performance', adminOnly: true },
];

export const configPage = {
  id: 'config', title: 'Configuration', sub: 'Edit system sections; each save creates an audit entry.', group: 'Admin', icon: 'fa-solid fa-sliders',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;" id="cfg-tabs"></div>
      <div id="cfg-body">${loadingState()}</div>
    </div>`;
    const tabs = document.getElementById('cfg-tabs');
    let active = SECTIONS[0].id;
    const user = window.SkyGuardAPI.getUser();
    const isAdmin = user && user.role === 'admin';
    const renderTabs = () => {
      tabs.innerHTML = SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => `<button class="btn ${s.id===active?'':'secondary'}" data-tab="${s.id}">${escapeHtml(s.title)}${s.adminOnly ? ' <small>(admin)</small>' : ''}</button>`).join('');
      tabs.querySelectorAll('button').forEach((b) => b.onclick = () => { active = b.dataset.tab; renderTabs(); load(); });
    };
    const load = async () => {
      const body = document.getElementById('cfg-body');
      body.innerHTML = loadingState();
      try {
        const value = await configApi.get(active);
        if (document.getElementById('cfg-body') !== body) return;
        const form = document.createElement('form');
        form.innerHTML = `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;">${Object.entries(value).map(([k, v]) => field(k, v)).join('')}</div>
          <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end;">
            <button type="button" class="btn ghost" id="cfg-cancel">Cancel</button>
            ${isAdmin ? `<button type="button" class="btn secondary" id="cfg-test"><i class="fa-solid fa-vial"></i> Test</button>` : ''}
            ${isAdmin ? `<button type="button" class="btn secondary" id="cfg-reset"><i class="fa-solid fa-rotate-left"></i> Reset</button>` : ''}
            ${isAdmin ? `<button type="submit" class="btn">Save</button>` : '<span class="badge gray">Read-only</span>'}
          </div>`;
        form.onsubmit = async (e) => {
          e.preventDefault();
          if (!isAdmin) { toast('Insufficient permissions', 'error'); return; }
          const body = {};
          new FormData(form).forEach((v, k) => { body[k] = coerce(v); });
          try { await configApi.save(active, body); toast('Saved', 'success'); } catch (e2) { toast(e2.message, 'error'); }
        };
        const cancel = form.querySelector('#cfg-cancel');
        if (cancel) cancel.onclick = () => { form.reset(); load(); };
        const testBtn = form.querySelector('#cfg-test');
        if (testBtn) testBtn.onclick = async () => {
          try {
            const result = await configApi.test(active);
            toast(`Test: ${result.status} - ${result.message}`, result.status === 'UP' || result.status === 'SKIPPED' ? 'success' : 'warning');
          } catch (e2) { toast(e2.message, 'error'); }
        };
        const resetBtn = form.querySelector('#cfg-reset');
        if (resetBtn) resetBtn.onclick = async () => {
          if (!confirm('Reset this section to defaults?')) return;
          try { await configApi.reset(active); toast('Reset to defaults', 'success'); load(); } catch (e2) { toast(e2.message, 'error'); }
        };
        body.innerHTML = ''; body.appendChild(form);
      } catch (e) { body.innerHTML = errorState(e.message); }
    };
    renderTabs(); await load();
    return () => {};
  },
};

function field(k, v) {
  const id = `cfg-${k}`;
  if (typeof v === 'boolean') return `<label>${escapeHtml(k)}<select class="input" name="${k}" ${v ? '' : ''}><option value="true" ${v?'selected':''}>true</option><option value="false" ${!v?'selected':''}>false</option></select></label>`;
  if (typeof v === 'number') return `<label>${escapeHtml(k)}<input class="input" type="number" step="any" name="${k}" value="${v}" /></label>`;
  if (Array.isArray(v)) return `<label>${escapeHtml(k)}<textarea class="input" name="${k}" rows="2">${escapeHtml(JSON.stringify(v))}</textarea></label>`;
  return `<label>${escapeHtml(k)}<input class="input" name="${k}" value="${escapeHtml(v)}" /></label>`;
}
function coerce(v) {
  if (v === 'true') return true; if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  try { return JSON.parse(v); } catch (_) { return v; }
}
