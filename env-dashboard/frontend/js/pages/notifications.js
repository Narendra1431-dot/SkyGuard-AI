import { notificationApi } from '../api/index.js';
import { escapeHtml, loadingState, errorState, toast, statusBadge, openModal, formatDateTime } from '../utils/ui.js';

const TYPES = ['email','webhook','sms','telegram','slack'];
let channelTypes = [];
let list = [];

export const notificationsPage = {
  id: 'notifications', title: 'Notifications', sub: 'Configure notification channels. Test performs real delivery and persists history.', group: 'Admin', icon: 'fa-solid fa-paper-plane',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
        <select id="nt-type" class="input" style="max-width:160px;">${TYPES.map((c) => `<option value="${c}">${c}</option>`).join('')}</select>
        <button class="btn" id="nt-add"><i class="fa-solid fa-plus"></i> Add channel</button>
        <button class="btn secondary" id="nt-refresh" style="margin-left:auto;"><i class="fa-solid fa-rotate"></i> Refresh</button>
      </div>
      <div id="nt-list">${loadingState()}</div>
    </div>
    <div class="card" style="margin-top:14px;">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <h3 style="margin:0;">Delivery history</h3>
        <button class="btn secondary" id="nt-h-refresh" style="margin-left:auto;"><i class="fa-solid fa-rotate"></i> Refresh history</button>
        <button class="btn ghost" id="nt-dl"><i class="fa-solid fa-skull"></i> Dead-letter</button>
      </div>
      <div id="nt-history">${loadingState()}</div>
    </div>`;
    document.getElementById('nt-add').onclick = () => editChannel(null);
    document.getElementById('nt-refresh').onclick = load;
    document.getElementById('nt-h-refresh').onclick = loadHistory;
    document.getElementById('nt-dl').onclick = async () => {
      try {
        const dl = await notificationApi.deadLetter();
        toast(`Dead-letter: ${dl.deadLetterCount} items`, dl.deadLetterCount ? 'error' : 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
    await load();
    await loadHistory();
    return () => {};
  },
};

async function load() {
  try {
    const data = await notificationApi.channels();
    channelTypes = data.types || [];
    list = data.channels || [];
    render();
  } catch (e) { document.getElementById('nt-list').innerHTML = errorState(e.message); }
}

function render() {
  const host = document.getElementById('nt-list');
  if (!list.length) { host.innerHTML = '<div class="state empty">No channels configured. Add one above.</div>'; return; }
  host.innerHTML = `<table><thead><tr><th>Type</th><th>Name</th><th>Status</th><th>Last test</th><th></th></tr></thead><tbody>${list.map((c) => `<tr data-id="${escapeHtml(c.id)}">
    <td>${escapeHtml(c.type)}</td>
    <td><strong>${escapeHtml(c.name)}</strong><br/><small style="color:#64748b">${escapeHtml(c.target || '—')}</small></td>
    <td>${statusBadge(c.status?.status || c.status)} ${c.enabled ? '<span class="badge green">ENABLED</span>' : '<span class="badge gray">DISABLED</span>'}</td>
    <td>${c.lastTestAt ? `${escapeHtml(c.lastTestAt)} — ${statusBadge(c.lastTestResult || '—')}` : '<span class="badge gray">NEVER</span>'}</td>
    <td>
      <button class="btn ghost" data-act="edit" data-id="${escapeHtml(c.id)}">Edit</button>
      <button class="btn secondary" data-act="test" data-id="${escapeHtml(c.id)}">Test</button>
      <button class="btn ghost" data-act="toggle" data-id="${escapeHtml(c.id)}">${c.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn danger" data-act="del" data-id="${escapeHtml(c.id)}">Delete</button>
    </td>
  </tr>`).join('')}</tbody></table>`;
  host.querySelectorAll('button[data-act]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); onAction(b.dataset.act, b.dataset.id); });
}

async function onAction(act, id) {
  try {
    if (act === 'edit') {
      const ch = list.find((c) => c.id === id);
      editChannel(ch);
      return;
    }
    if (act === 'toggle') {
      const ch = list.find((c) => c.id === id);
      if (ch?.enabled) await notificationApi.disable(id); else await notificationApi.enable(id);
      await load();
      return;
    }
    if (act === 'del') {
      if (!confirm('Delete this channel?')) return;
      await notificationApi.remove(id);
      await load();
      return;
    }
    if (act === 'test') {
      toast('Sending real test delivery…', 'info', 1500);
      const rec = await notificationApi.test(id);
      const color = rec.status === 'GREEN' ? 'success' : rec.status === 'GRAY' ? 'info' : 'error';
      toast(`${rec.channelType}: ${rec.status}${rec.error ? ' — ' + rec.error : ''}${rec.latencyMs ? ` (${rec.latencyMs} ms)` : ''}`, color);
      await load();
      await loadHistory();
    }
  } catch (e) { toast(e.message, 'error'); }
}

function credsForm(type, existing = {}) {
  const e = existing.credentials || {};
  if (type === 'email') {
    return `
      <label>Host<input class="input" name="host" value="${escapeHtml(e.host || '')}" placeholder="smtp.example.com" required /></label>
      <label>Port<input class="input" name="port" type="number" value="${escapeHtml(e.port || 587)}" required /></label>
      <label>Username<input class="input" name="username" value="${escapeHtml(e.username || '')}" required /></label>
      <label>Password<input class="input" name="password" type="password" value="${escapeHtml(e.password || '')}" required /></label>
      <label>TLS<select name="tls" class="input"><option value="true" ${e.tls !== false ? 'selected' : ''}>Enabled (STARTTLS)</option><option value="false" ${e.tls === false ? 'selected' : ''}>Plain</option></select></label>
      <label>Sender<input class="input" name="sender" value="${escapeHtml(e.sender || '')}" placeholder="alerts@example.com" required /></label>
      <label>Recipient<input class="input" name="recipient" value="${escapeHtml(e.recipient || '')}" placeholder="ops@example.com" required /></label>
    `;
  }
  if (type === 'webhook') {
    return `
      <label>URL<input class="input" name="url" value="${escapeHtml(e.url || '')}" placeholder="https://hooks.example.com/path" required /></label>
      <label>Method<select name="method" class="input"><option ${e.method === 'GET' ? 'selected' : ''}>GET</option><option ${(!e.method || e.method === 'POST') ? 'selected' : ''}>POST</option><option ${e.method === 'PUT' ? 'selected' : ''}>PUT</option></select></label>
      <label>Auth header (optional)<input class="input" name="authHeader" value="${escapeHtml(e.authHeader || '')}" placeholder="Bearer xxx" /></label>
      <label>Timeout (ms)<input class="input" name="timeoutMs" type="number" value="${escapeHtml(e.timeoutMs || 8000)}" /></label>
      <label>Extra headers JSON<input class="input" name="headers" value='${escapeHtml(JSON.stringify(e.headers || {}))}' /></label>
    `;
  }
  if (type === 'sms') {
    return `
      <label>Twilio Account SID<input class="input" name="accountSid" value="${escapeHtml(e.accountSid || '')}" required /></label>
      <label>Twilio Auth Token<input class="input" name="authToken" type="password" value="${escapeHtml(e.authToken || '')}" required /></label>
      <label>From (E.164)<input class="input" name="from" value="${escapeHtml(e.from || '')}" placeholder="+15555550123" required /></label>
      <label>To (E.164)<input class="input" name="to" value="${escapeHtml(e.to || '')}" placeholder="+15555550199" required /></label>
    `;
  }
  if (type === 'telegram') {
    return `
      <label>Bot Token<input class="input" name="botToken" value="${escapeHtml(e.botToken || '')}" required /></label>
      <label>Chat ID<input class="input" name="chatId" value="${escapeHtml(e.chatId || '')}" required /></label>
    `;
  }
  if (type === 'slack') {
    return `
      <label>Webhook URL<input class="input" name="webhookUrl" value="${escapeHtml(e.webhookUrl || '')}" placeholder="https://hooks.slack.com/services/…" required /></label>
    `;
  }
  return '';
}

function editChannel(existing) {
  const isNew = !existing;
  const initialType = existing?.type || 'webhook';
  const form = document.createElement('form');
  form.className = 'card';
  form.style.minWidth = '440px';
  form.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <label>Type ${isNew ? '' : '(readonly)'}<select name="type" class="input" ${isNew ? '' : 'disabled'}>${TYPES.map((t) => `<option value="${t}" ${initialType === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Name<input class="input" name="name" value="${escapeHtml(existing?.name || initialType + '-' + Date.now().toString(36).slice(-4))}" required /></label>
      <label>Target / recipient summary<input class="input" name="target" value="${escapeHtml(existing?.target || '')}" /></label>
      <label style="display:flex;align-items:center;gap:6px;margin-top:22px;"><input type="checkbox" name="enabled" ${existing?.enabled !== false ? 'checked' : ''}/> Enabled</label>
    </div>
    <div id="nt-creds" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;"></div>
    <div id="nt-validate" style="margin-top:8px;color:#64748b;font-size:12px;"></div>
  `;
  const credsHost = form.querySelector('#nt-creds');
  credsHost.innerHTML = credsForm(initialType, existing || {});
  form.querySelector('select[name=type]').onchange = (e) => {
    credsHost.innerHTML = credsForm(e.target.value, {});
  };

  const m = openModal({
    title: isNew ? 'Add channel' : `Edit ${existing.name}`,
    body: form,
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => m.close() },
      { label: 'Save', kind: '', onClick: async (btn) => {
        btn.disabled = true;
        try {
          const fd = new FormData(form);
          const creds = {};
          for (const [k, v] of fd.entries()) {
            if (k === 'type' || k === 'name' || k === 'target' || k === 'enabled') continue;
            creds[k] = v;
          }
          if (creds.tls !== undefined) creds.tls = creds.tls === 'true' || creds.tls === true;
          if (creds.headers) { try { creds.headers = JSON.parse(creds.headers); } catch { throw new Error('Headers JSON invalid'); } }
          const body = {
            id: existing?.id,
            type: fd.get('type'),
            name: fd.get('name'),
            target: fd.get('target'),
            enabled: !!fd.get('enabled'),
            credentials: creds,
          };
          if (isNew) await notificationApi.upsert(body); else await notificationApi.update(existing.id, body);
          toast('Saved', 'success');
          m.close(); await load();
        } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
      } },
    ],
  });
}

async function loadHistory() {
  const host = document.getElementById('nt-history');
  if (!host) return;
  host.innerHTML = loadingState();
  try {
    const items = await notificationApi.history({ limit: 50 });
    if (!items.length) { host.innerHTML = '<div class="state empty">No deliveries yet.</div>'; return; }
    host.innerHTML = `<table><thead><tr><th>Time</th><th>Channel</th><th>Kind</th><th>Alert</th><th>Status</th><th>HTTP</th><th>Latency</th><th>Error</th></tr></thead><tbody>${items.map((h) => `<tr>
      <td>${formatDateTime(h.time)}</td>
      <td>${escapeHtml(h.channelType)}<br/><small style="color:#64748b">${escapeHtml(h.channelId)}</small></td>
      <td>${escapeHtml(h.kind || '—')}</td>
      <td>${h.alertId ? escapeHtml(h.alertId) : '<span style="color:#64748b">—</span>'}</td>
      <td>${statusBadge(h.status)}</td>
      <td>${h.statusCode ?? '—'}</td>
      <td>${h.latencyMs != null ? h.latencyMs + ' ms' : '—'}</td>
      <td>${h.error ? escapeHtml(h.error) : '<span style="color:#64748b">—</span>'}</td>
    </tr>`).join('')}</tbody></table>`;
  } catch (e) { host.innerHTML = errorState(e.message); }
}