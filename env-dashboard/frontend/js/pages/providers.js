import { providerApi } from '../api/index.js';
import { escapeHtml, statusBadge, loadingState, errorState, toast, openModal } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

export const providersPage = {
  id: 'providers', title: 'Providers', sub: 'Configure and test weather data providers.', group: 'Operations', icon: 'fa-solid fa-cloud',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <button class="btn" id="pv-add"><i class="fa-solid fa-plus"></i> Add provider</button>
        <button class="btn secondary" id="pv-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
        <span style="margin-left:auto;color:#64748b;font-size:12px;" id="pv-meta"></span>
      </div>
      <div id="pv-list">${loadingState()}</div>
    </div>`;
    document.getElementById('pv-refresh').onclick = load;
    document.getElementById('pv-add').onclick = () => editProvider(null);
    await load();
    return () => {};
  },
};

async function load() {
  const list = document.getElementById('pv-list');
  list.innerHTML = loadingState();
  try {
    const items = await providerApi.list();
    document.getElementById('pv-meta').textContent = `${items.length} providers`;
    list.innerHTML = `<table><thead><tr><th>Name</th><th>Status</th><th>Priority</th><th>Config</th><th>Latency</th><th>Success / Failure</th><th>Last</th><th>Actions</th></tr></thead><tbody>${items.map(row).join('')}</tbody></table>`;
    list.querySelectorAll('button[data-act]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); onAction(b.dataset.act, b.dataset.id); });
  } catch (e) { list.innerHTML = errorState(e.message); }
}

function row(p) {
  return `<tr data-id="${escapeHtml(p.id)}">
    <td><strong>${escapeHtml(p.name)}</strong><br/><small style="color:#64748b">${escapeHtml(p.id)}</small></td>
    <td>${statusBadge(p.status)} ${p.enabled ? '<span class="badge blue">ENABLED</span>' : '<span class="badge gray">DISABLED</span>'}</td>
    <td>${p.priority}</td>
    <td>${statusBadge(p.configurationState)}</td>
    <td>${p.latencyMs != null ? `${p.latencyMs} ms` : '—'}</td>
    <td>${p.successCount} / ${p.failureCount}</td>
    <td><small>${p.lastSuccess ? `OK ${escapeHtml(p.lastSuccess)}` : ''}${p.lastFailure ? `<br/>Fail ${escapeHtml(p.lastFailure)}` : ''}</small></td>
    <td>
      <button class="btn ghost" data-act="edit" data-id="${escapeHtml(p.id)}">Edit</button>
      <button class="btn secondary" data-act="test" data-id="${escapeHtml(p.id)}">Test</button>
      ${p.enabled ? `<button class="btn ghost" data-act="disable" data-id="${escapeHtml(p.id)}">Disable</button>` : `<button class="btn" data-act="enable" data-id="${escapeHtml(p.id)}">Enable</button>`}
      <button class="btn danger" data-act="delete" data-id="${escapeHtml(p.id)}">Delete</button>
    </td>
  </tr>`;
}

async function onAction(act, id) {
  try {
    if (act === 'edit') { const p = await providerApi.get(id); editProvider(p); return; }
    if (act === 'test') { const p = await providerApi.test(id); toast(`${p.name}: ${p.status} (${p.latencyMs} ms)`, p.status === 'GREEN' ? 'success' : 'error'); await load(); return; }
    if (act === 'enable') { await providerApi.enable(id); toast('Enabled', 'success'); await load(); return; }
    if (act === 'disable') { await providerApi.disable(id); toast('Disabled', 'info'); await load(); return; }
    if (act === 'delete') {
      if (!confirm('Delete this provider?')) return;
      await providerApi.remove(id); toast('Deleted', 'success'); await load();
    }
  } catch (e) { toast(e.message, 'error'); }
}

function editProvider(p) {
  const isNew = !p;
  const form = document.createElement('form');
  form.className = 'card';
  form.style.minWidth = '420px';
  form.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <label>ID ${isNew ? '' : '(readonly)'}<input class="input" name="id" value="${escapeHtml(p?.id || '')}" ${isNew ? '' : 'readonly'} required /></label>
      <label>Name<input class="input" name="name" value="${escapeHtml(p?.name || '')}" required /></label>
      <label>Priority<input class="input" type="number" name="priority" value="${p?.priority ?? 50}" /></label>
      <label style="display:flex;align-items:center;gap:6px;margin-top:22px;"><input type="checkbox" name="enabled" ${p?.enabled ? 'checked' : ''}/> Enabled</label>
      <label>API Key<input class="input" name="apiKey" placeholder="optional" /></label>
      <label>Base URL<input class="input" name="baseUrl" placeholder="optional" /></label>
    </div>
  `;
  const m = openModal({
    title: isNew ? 'Add provider' : `Edit ${p.name}`,
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => m.close() },
      { label: 'Save', kind: '', onClick: async (btn) => {
        btn.disabled = true;
        try {
          const fd = new FormData(form);
          const body = {
            id: fd.get('id') || undefined,
            name: fd.get('name'),
            priority: Number(fd.get('priority') || 0),
            enabled: !!fd.get('enabled'),
            credentials: { apiKey: fd.get('apiKey') || undefined, baseUrl: fd.get('baseUrl') || undefined },
          };
          if (isNew) await providerApi.create(body); else await providerApi.save(p.id, body);
          toast('Saved', 'success');
          m.close(); await load();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } },
    ],
  });
}
