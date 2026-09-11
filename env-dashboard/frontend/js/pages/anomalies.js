import { anomalyApi, stationApi } from '../api/index.js';
import { escapeHtml, statusBadge, formatDateTime, loadingState, errorState, toast, openModal } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

const charts = {};
let chartsDisposed = false;

export const anomaliesPage = {
  id: 'anomalies', title: 'Anomalies', sub: 'Detected anomalies with full factor breakdown and decision trace.', group: 'Operations', icon: 'fa-solid fa-triangle-exclamation',
  async render(root) {
    chartsDisposed = false;
    root.innerHTML = `
      <div class="grid grid-3">
        <div class="card"><h3>Trend (24h)</h3><canvas id="anom-trend" height="120"></canvas></div>
        <div class="card"><h3>By parameter</h3><canvas id="anom-dist" height="120"></canvas></div>
        <div class="card"><h3>Severity mix</h3><canvas id="anom-sev" height="120"></canvas></div>
      </div>
      <div class="card" style="margin-top:14px;">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap;">
          <input id="an-search" class="input" placeholder="Search station / reason…" style="max-width:240px;" />
          <select id="an-station" class="input" style="max-width:200px;"><option value="">All stations</option></select>
          <select id="an-min" class="input" style="max-width:140px;">
            <option value="60">Last 1h</option>
            <option value="360">Last 6h</option>
            <option value="1440" selected>Last 24h</option>
            <option value="10080">Last 7d</option>
          </select>
          <button class="btn secondary" id="an-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
        </div>
        <div id="an-list">${loadingState()}</div>
      </div>
    `;
    const stations = await stationApi.list();
    const sel = document.getElementById('an-station');
    if (!sel || !document.getElementById('an-list')) { chartsDisposed = true; return () => { destroyAllCharts(); }; }
    sel.innerHTML = '<option value="">All stations</option>' + stations.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
    const refresh = () => load();
    document.getElementById('an-refresh').onclick = refresh;
    document.getElementById('an-search').oninput = () => renderList();
    document.getElementById('an-station').onchange = refresh;
    document.getElementById('an-min').onchange = refresh;
    const off = socketMgr.on('anomaly:new', refresh);
    await refresh();
    return () => { off(); chartsDisposed = true; destroyAllCharts(); };
  },
};

let lastAnomalies = [];

function destroyAllCharts() {
  for (const id of ['anom-trend', 'anom-dist', 'anom-sev']) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }
  for (const id of ['anom-trend', 'anom-dist', 'anom-sev']) {
    try { const existing = Chart.getChart(id); if (existing) existing.destroy(); } catch {}
  }
}

async function load() {
  if (chartsDisposed) return;
  const minutes = document.getElementById('an-min').value;
  const stationId = document.getElementById('an-station').value;
  try {
    const [anoms, analytics] = await Promise.all([
      anomalyApi.list({ minutes, stationId: stationId || undefined }),
      anomalyApi.analytics({ minutes, stationId: stationId || undefined }),
    ]);
    if (chartsDisposed) return;
    if (!document.getElementById('an-list')) return;
    lastAnomalies = anoms;
    drawCharts(analytics);
    renderList();
  } catch (e) {
    const host = document.getElementById('an-list');
    if (host) host.innerHTML = errorState(e.message);
  }
}

function renderList() {
  const list = document.getElementById('an-list');
  if (!list) return;
  const search = (document.getElementById('an-search').value || '').toLowerCase();
  let rows = lastAnomalies;
  if (search) rows = rows.filter((a) => ((a.station || '') + ' ' + (a.reasons || []).join(' ')).toLowerCase().includes(search));
  if (!rows.length) { list.innerHTML = '<div class="state empty">No anomalies detected in this window.</div>'; return; }
  list.innerHTML = `<table><thead><tr><th>When</th><th>Station</th><th>Severity</th><th>Reasons</th><th>Confidence</th><th></th></tr></thead><tbody>${rows.slice(0, 200).map((a) => `<tr data-time="${escapeHtml(a.time)}" data-station="${escapeHtml(a.stationId)}">
    <td>${formatDateTime(a.time)}</td>
    <td>${escapeHtml(a.station)}</td>
    <td>${statusBadge(a.aqi > 250 || a.temperature > 42 ? 'critical' : 'warning')}</td>
    <td>${(a.reasons || []).slice(0, 2).map(escapeHtml).join('; ')}</td>
    <td>${a.confidence != null ? (a.confidence * 100).toFixed(0) + '%' : '—'}</td>
    <td><button class="btn ghost" data-act="explain">Explain</button></td>
  </tr>`).join('')}</tbody></table>`;
  list.querySelectorAll('tr').forEach((tr) => {
    const button = tr.querySelector('button');
    if (button) button.onclick = () => explain(tr.dataset.time, tr.dataset.station);
  });
}

function explain(time, stationId) {
  const a = lastAnomalies.find((x) => x.time === time && x.stationId === stationId);
  if (!a) return;
  const body = document.createElement('div');
  const factors = (a.factors || []).map((f) => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.weight)}</td></tr>`).join('') || '<tr><td colspan="2" style="color:#64748b;">No factors</td></tr>';
  body.innerHTML = `
    <div style="margin-bottom:8px;">${statusBadge(a.aqi > 250 || a.temperature > 42 ? 'critical' : 'warning')} <strong>${escapeHtml(a.station || a.stationId)}</strong> at ${formatDateTime(a.time)}</div>
    <p style="margin-bottom:8px;"><strong>Observed:</strong> ${formatReading(a)}</p>
    <p style="margin-bottom:8px;"><strong>Expected (baseline):</strong> temp ≤ 32 °C • aqi ≤ 100 • humidity 35–60%</p>
    <p style="margin-bottom:8px;"><strong>Deviation:</strong> ${(a.reasons || []).map(escapeHtml).join('; ') || '—'}</p>
    <p style="margin-bottom:8px;"><strong>Confidence:</strong> ${a.confidence != null ? (a.confidence * 100).toFixed(0) + '%' : '—'}</p>
    <h4 style="margin-top:10px;">Decision trace</h4>
    <table><thead><tr><th>Factor</th><th>Weight</th></tr></thead><tbody>${factors}</tbody></table>
    <p style="margin-top:8px;"><strong>Recommendation:</strong> ${escapeHtml(a.recommendation || '—')}</p>
  `;
  openModal({ title: 'Anomaly explanation', body, actions: [{ label: 'Close', kind: 'ghost', onClick: (b) => b.closest('.modal-back').remove() }] });
}

function formatReading(a) {
  return `temp ${a.temperature != null ? a.temperature.toFixed(1) : '—'} °C • aqi ${a.aqi} • humidity ${a.humidity != null ? a.humidity.toFixed(1) : '—'}% • wind ${a.wind != null ? a.wind.toFixed(1) : '—'} m/s • rainfall ${a.rainfall != null ? a.rainfall.toFixed(2) : '—'} mm`;
}

function drawCharts(a) {
  const canvasIds = ['anom-trend', 'anom-dist', 'anom-sev'];
  for (const id of canvasIds) {
    if (charts[id]) { charts[id].destroy(); delete charts[id]; }
  }
  const trendCtx = document.getElementById('anom-trend');
  if (trendCtx && a.anomalyTrend && a.anomalyTrend.length) {
    charts['anom-trend'] = new Chart(trendCtx, { type: 'bar', data: { labels: a.anomalyTrend.map((x) => new Date(x.t).toLocaleTimeString()), datasets: [{ label: 'Anomalies', data: a.anomalyTrend.map((x) => x.count), backgroundColor: '#60a5fa' }] }, options: chartOpts() });
  }
  const distCtx = document.getElementById('anom-dist');
  if (distCtx && a.anomalyDistribution && a.anomalyDistribution.length) {
    charts['anom-dist'] = new Chart(distCtx, { type: 'doughnut', data: { labels: a.anomalyDistribution.map((x) => x.type), datasets: [{ data: a.anomalyDistribution.map((x) => x.count), backgroundColor: ['#60a5fa','#22c55e','#eab308','#ef4444','#a78bfa','#14b8a6'] }] }, options: chartOpts() });
  }
  const sevCtx = document.getElementById('anom-sev');
  if (sevCtx && a.severityDistribution && a.severityDistribution.length) {
    charts['anom-sev'] = new Chart(sevCtx, { type: 'pie', data: { labels: a.severityDistribution.map((x) => x.severity), datasets: [{ data: a.severityDistribution.map((x) => x.count), backgroundColor: ['#ef4444','#eab308','#94a3b8'] }] }, options: chartOpts() });
  }
}
function chartOpts() { return { animation: false, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } } } }; }
