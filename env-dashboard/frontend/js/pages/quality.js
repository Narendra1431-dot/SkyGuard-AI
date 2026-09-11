import { qualityApi } from '../api/index.js';
import { escapeHtml, formatNumber, loadingState, errorState, statusBadge } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

let scoreChart, paramChart;

export const qualityPage = {
  id: 'quality', title: 'Data Quality', sub: 'Live completeness, validity, accuracy and per-parameter breakdown.', group: 'Operations', icon: 'fa-solid fa-broom',
  async render(root) {
    root.innerHTML = `<div class="grid grid-4" id="q-kpis">${loadingState()}</div>
      <div class="grid grid-2" style="margin-top:14px;">
        <div class="card"><h3>Score composition</h3><canvas id="q-score" height="160"></canvas></div>
        <div class="card"><h3>Per-parameter validity</h3><canvas id="q-params" height="160"></canvas></div>
      </div>
      <div class="card" style="margin-top:14px;"><h3>Recent issues</h3><div id="q-issues">${loadingState()}</div></div>`;
    const off = socketMgr.on('quality:update', load);
    await load();
    return () => { off(); destroy(); };
  },
};

function destroy() { for (const c of [scoreChart, paramChart]) { try { c?.destroy(); } catch {} } scoreChart = paramChart = null; }

async function load() {
  try {
    const snap = await qualityApi.snapshot();
    const issues = await qualityApi.issues();
    const k = document.getElementById('q-kpis');
    k.innerHTML = `
      ${card('Overall', formatNumber(snap.overallScore,1)+'%', snap.overallScore >= 90 ? 'green' : snap.overallScore >= 70 ? 'yellow' : 'red')}
      ${card('Completeness', formatNumber(snap.completeness,1)+'%', snap.completeness >= 90 ? 'green' : 'yellow')}
      ${card('Validity', formatNumber(snap.validity,1)+'%', snap.validity >= 90 ? 'green' : 'yellow')}
      ${card('Ingestion /min', formatNumber(snap.ingestionRate,1), 'blue')}
    `;
    destroy();
    const sctx = document.getElementById('q-score');
    scoreChart = new Chart(sctx, { type: 'bar', data: { labels: ['Completeness', 'Validity', 'Accuracy'], datasets: [{ data: [snap.completeness, snap.validity, snap.accuracy], backgroundColor: ['#60a5fa','#22c55e','#eab308'] }] }, options: { animation: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } } } } });
    const pctx = document.getElementById('q-params');
    const per = snap.perParameter || {};
    paramChart = new Chart(pctx, { type: 'bar', data: { labels: Object.keys(per), datasets: [{ label: 'Validity %', data: Object.values(per).map((v) => v.validity), backgroundColor: '#22c55e' }, { label: 'Range compliance %', data: Object.values(per).map((v) => v.rangeCompliance), backgroundColor: '#60a5fa' }] }, options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8' } } }, scales: { y: { min: 0, max: 100, ticks: { color: '#64748b' }, grid: { color: '#1e293b' } }, x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } } } } });
    const ih = document.getElementById('q-issues');
    if (!issues.length) ih.innerHTML = '<div class="state empty">No quality issues detected.</div>';
    else ih.innerHTML = `<table><thead><tr><th>When</th><th>Parameter</th><th>Type</th><th>Severity</th><th>Detail</th></tr></thead><tbody>${issues.slice(0, 50).map((i) => `<tr><td>${escapeHtml(i.detectedAt || '')}</td><td>${escapeHtml(i.parameter)}</td><td>${escapeHtml(i.issueType)}</td><td>${statusBadge(i.severity)}</td><td>${escapeHtml(i.detail)}</td></tr>`).join('')}</tbody></table>`;
  } catch (e) {
    document.getElementById('q-kpis').innerHTML = errorState(e.message);
  }
}
function card(l, v, c) { return `<div class="stat-card ${c}"><div class="lbl">${escapeHtml(l)}</div><div class="val">${escapeHtml(v)}</div></div>`; }
