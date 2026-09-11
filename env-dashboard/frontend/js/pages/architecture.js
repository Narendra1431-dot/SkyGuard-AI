import { healthApi } from '../api/index.js';
import { escapeHtml, statusBadge, loadingState, errorState, formatDateTime, statusClass } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

let chart;

export const architecturePage = {
  id: 'architecture', title: 'Architecture / Data Flow', sub: 'Pipeline components, data flow, status, latency, and dependencies.', group: 'System', icon: 'fa-solid fa-diagram-project',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
        <span id="ar-rollup"></span>
        <button class="btn secondary" style="margin-left:auto;" id="ar-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
      </div>
      <div class="pipeline" id="ar-pipe">${loadingState('Loading pipeline…')}</div>
    </div>
    <div class="card mt-3"><h3>Data flow</h3><div id="ar-flow">${loadingState()}</div></div>
    <div class="grid grid-2" style="margin-top:14px;">
      <div class="card"><h3>Metrics</h3><div id="ar-metrics">${loadingState()}</div></div>
      <div class="card"><h3>Component detail</h3><div id="ar-detail">Click a node above to inspect.</div></div>
    </div>
    <div class="card" style="margin-top:14px;">
      <h3>Storage technologies</h3>
      <div id="ar-storage">${loadingState()}</div>
    </div>
    <div class="card" style="margin-top:14px;">
      <h3>Providers</h3>
      <div id="ar-providers">${loadingState()}</div>
    </div>`;
    document.getElementById('ar-refresh').onclick = load;
    const off = socketMgr.on('system:update', load);
    await load();
    return () => { off(); if (chart) chart.destroy(); };
  },
};

async function load() {
  try {
    const [arch, flow] = await Promise.all([healthApi.architecture(), healthApi.dataFlow ? healthApi.dataFlow() : Promise.resolve(null)]);
    const rollup = arch.status;
    const core = arch.core || [];
    const optional = arch.optional || [];
    const all = [...core, ...optional];
    document.getElementById('ar-rollup').innerHTML = `Pipeline rollup: ${statusBadge(rollup)} • last update ${formatDateTime(arch.computedAt || arch.metrics?.measuredAt || '')}`;

    const labels = {
      api:'API', websocket:'WebSocket', memoryStore:'MemoryStore', sqlite:'SQLite',
      influxdb:'InfluxDB', postgres:'PostgreSQL', ingestion:'Ingestion',
      analytics:'Analytics', anomalyEngine:'Anomaly Engine', assistant:'AI Assistant',
      reportService:'Reports', ml:'ML', notifications:'Notifications',
      'providers.openweather':'OpenWeather', 'providers.open-meteo':'Open-Meteo',
    };
    const host = document.getElementById('ar-pipe');
    host.innerHTML = all.map((c) => {
      const cls = statusClass(c.color || c.status);
      return `<div class="pipe-node ${cls}" data-key="${escapeHtml(c.key)}"><div class="name">${escapeHtml(labels[c.key] || c.key)}</div><div class="meta">${escapeHtml(c.status || '—')}</div></div>`;
    }).join('');
    host.querySelectorAll('.pipe-node').forEach((n) => n.onclick = () => showDetail(n.dataset.key, all.find((c) => c.key === n.dataset.key)));

    const m = arch;
    document.getElementById('ar-metrics').innerHTML = `
      <table><tbody>
        <tr><td>Overall status</td><td>${statusBadge(m.status)}</td></tr>
        <tr><td>Uptime</td><td>${m.uptimeSeconds != null ? Math.round(m.uptimeSeconds / 3600) + ' h' : '—'}</td></tr>
        <tr><td>Tick count</td><td>${m.tickCount ?? '—'}</td></tr>
        <tr><td>Last ingestion</td><td>${formatDateTime(m.lastIngestionAt || m.metrics?.lastTickAt)}</td></tr>
        <tr><td>Measured at</td><td>${formatDateTime(m.computedAt || m.metrics?.measuredAt)}</td></tr>
      </tbody></table>`;

    const flowHost = document.getElementById('ar-flow');
    if (flow && flow.connections) {
      const providerFailover = flow.providerFailover || {};
      flowHost.innerHTML = `
        <div style="margin-bottom:8px;">
          <strong>Active provider:</strong> ${providerFailover.active ? escapeHtml(providerFailover.active.name) + ' (' + statusBadge(providerFailover.active.runtime) + ')' : 'None'}
          ${providerFailover.fallback ? `<br/><strong>Fallback:</strong> ${escapeHtml(providerFailover.fallback.name)} (${statusBadge(providerFailover.fallback.runtime)})` : ''}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          ${flow.connections.map((c) => `<div class="pipe-node ${statusClass(c.status)}" style="min-width:120px;" title="${escapeHtml(c.description || '')}"><div class="name">${escapeHtml(c.name)}</div><div class="meta">${escapeHtml(c.status)}</div></div>`).join('<div style="color:#64748b;">→</div>')}
        </div>
      `;
    } else {
      flowHost.innerHTML = '<div class="state empty">Data flow details unavailable.</div>';
    }

    const storage = arch.components?.storage || {};
    const storeRows = ['memoryStore','sqlite','influxdb','postgres'].map((k) => {
      const s = storage[k] || { status: 'DISABLED', latencyMs: 0, error: null };
      const configured = s.status !== 'DISABLED';
      const color = !configured ? 'GRAY' : s.status === 'UP' ? 'GREEN' : s.status === 'DEGRADED' ? 'YELLOW' : s.status === 'DOWN' ? 'RED' : 'GRAY';
      return `<tr>
        <td>${escapeHtml(labels[k] || k)}</td>
        <td>${statusBadge(color)}</td>
        <td>${configured ? 'YES' : 'NO'}</td>
        <td>${s.latencyMs != null ? s.latencyMs + ' ms' : '—'}</td>
        <td>${s.error ? escapeHtml(s.error) : '—'}</td>
      </tr>`;
    }).join('');
    document.getElementById('ar-storage').innerHTML = `<table><thead><tr><th>Component</th><th>Status</th><th>Configured</th><th>Latency</th><th>Diagnostic</th></tr></thead><tbody>${storeRows}</tbody></table>`;

    const provs = arch.components?.providers || {};
    const provRows = Object.entries(provs).map(([id, p]) => {
      const color = p.runtime === 'ACTIVE' ? 'GREEN' : p.runtime === 'PENDING' || p.runtime === 'STANDBY' ? 'YELLOW' : p.runtime === 'FAILED' ? 'RED' : 'GRAY';
      return `<tr>
        <td>${escapeHtml(p.name)}<br/><small style="color:#64748b">${escapeHtml(id)}</small></td>
        <td>${statusBadge(p.runtime)} (${statusBadge(color)})</td>
        <td>${p.configured ? statusBadge('CONFIGURED') : statusBadge('NOT_CONFIGURED')}</td>
        <td>${p.enabled ? statusBadge('ENABLED') : statusBadge('DISABLED')}</td>
        <td>${p.latencyMs != null ? p.latencyMs + ' ms' : '—'}</td>
        <td>${p.lastSuccess ? 'OK ' + formatDateTime(p.lastSuccess) : ''}${p.lastFailure ? `<br/>FAIL ${formatDateTime(p.lastFailure)}` : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:#64748b">No providers</td></tr>';
    document.getElementById('ar-providers').innerHTML = `<table><thead><tr><th>Provider</th><th>Runtime</th><th>Config</th><th>State</th><th>Latency</th><th>Last</th></tr></thead><tbody>${provRows}</tbody></table>`;
  } catch (e) { document.getElementById('ar-pipe').innerHTML = errorState(e.message); }
}

function showDetail(key, c) {
  const host = document.getElementById('ar-detail');
  if (!c) { host.innerHTML = '<div class="state empty">No data</div>'; return; }
  const labels = {
    api:'API', websocket:'WebSocket', memoryStore:'MemoryStore', sqlite:'SQLite',
    influxdb:'InfluxDB', postgres:'PostgreSQL', ingestion:'Ingestion',
    analytics:'Analytics', anomalyEngine:'Anomaly Engine', assistant:'AI Assistant',
    reportService:'Reports', ml:'ML', notifications:'Notifications',
    'providers.openweather':'OpenWeather', 'providers.open-meteo':'Open-Meteo',
  };
  const rows = [
    ['Key', escapeHtml(c.key)],
    ['Label', escapeHtml(labels[c.key] || c.key)],
    ['Status', statusBadge(c.color || c.status) + ' ' + escapeHtml(c.status || '—')],
    ['Latency', c.latencyMs != null ? c.latencyMs + ' ms' : '—'],
    ['Error', c.error ? escapeHtml(c.error) : '—'],
  ];
  if (c.key.startsWith('providers.')) {
    rows.push(['Runtime', escapeHtml(c.status)]);
    rows.push(['Configured', c.error === 'not configured' ? 'No' : 'Yes']);
  }
  host.innerHTML = `<h3 style="margin-bottom:6px;">${escapeHtml(key)}</h3><table><tbody>${rows.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table>`;
}
