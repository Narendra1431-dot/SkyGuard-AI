import { stationApi, dashboardApi } from '../api/index.js';
import { escapeHtml, statusBadge, loadingState, errorState, formatNumber } from '../utils/ui.js';

export const healthPage = {
  id: 'health', title: 'Health Monitor', sub: 'Per-station sensor health and trend.', group: 'Operations', icon: 'fa-solid fa-heart-pulse',
  async render(root) {
    root.innerHTML = `<div class="card"><div id="hl-grid">${loadingState()}</div></div>
      <div class="grid grid-2" style="margin-top:14px;">
        <div class="card"><h3>Reference station</h3><div id="sp-ref">${loadingState()}</div></div>
        <div class="card"><h3>Spatial comparison</h3><div id="sp-comp">${loadingState()}</div></div>
      </div>`;
    await load();
    return () => {};
  },
};

async function load() {
  try {
    const stations = await stationApi.list();
    const grid = document.getElementById('hl-grid');
    grid.innerHTML = `<div class="grid grid-3">${stations.map((s) => {
      const score = s.healthScore || 0;
      const cls = score >= 80 ? 'green' : score >= 50 ? 'yellow' : 'red';
      return `<div class="stat-card ${cls}"><div class="lbl">${escapeHtml(s.name)}</div><div class="val">${formatNumber(score,0)}</div><div class="sub">${statusBadge(s.status)} • ${escapeHtml(s.id)}</div></div>`;
    }).join('')}</div>`;
    // Spatial comparison defaults to first two stations
    const refId = stations[0]?.id; const nearId = stations[1]?.id;
    const ref = document.getElementById('sp-ref');
    if (!refId) { ref.innerHTML = '<div class="state empty">No stations</div>'; return; }
    const [refData, nearData] = await Promise.all([
      dashboardApi.history({ stationId: refId, field: 'temperature', minutes: 60 }),
      nearId ? dashboardApi.history({ stationId: nearId, field: 'temperature', minutes: 60 }) : Promise.resolve([]),
    ]);
    const refStation = stations.find((s) => s.id === refId);
    ref.innerHTML = `<div style="margin-bottom:6px;"><strong>${escapeHtml(refStation?.name || refId)}</strong></div>
      <div>Latest: ${formatNumber(refStation?.reading?.temperature, 1)} °C</div>
      <div>60m avg: ${formatNumber(avg(refData.map((p) => p.v)), 1)} °C</div>
      <div>60m min/max: ${formatNumber(Math.min(...refData.map((p) => p.v)), 1)} / ${formatNumber(Math.max(...refData.map((p) => p.v)), 1)} °C</div>`;
    const comp = document.getElementById('sp-comp');
    if (!nearId) { comp.innerHTML = '<div class="state empty">Add at least 2 stations to compare.</div>'; return; }
    const nearStation = stations.find((s) => s.id === nearId);
    const refAvg = avg(refData.map((p) => p.v));
    const nearAvg = avg(nearData.map((p) => p.v));
    const dev = refAvg != null && nearAvg != null ? +(refAvg - nearAvg).toFixed(2) : null;
    comp.innerHTML = `<table><thead><tr><th>Station</th><th>Avg temp (60m)</th><th>Deviation vs ref</th></tr></thead><tbody>
      <tr><td>${escapeHtml(refStation?.name)}</td><td>${formatNumber(refAvg, 1)} °C</td><td>—</td></tr>
      <tr><td>${escapeHtml(nearStation?.name)}</td><td>${formatNumber(nearAvg, 1)} °C</td><td>${dev != null ? `${dev > 0 ? '+' : ''}${dev} °C (${((dev/Math.max(0.1,refAvg))*100).toFixed(1)}%)` : '—'}</td></tr>
    </tbody></table>`;
  } catch (e) {
    document.getElementById('hl-grid').innerHTML = errorState(e.message);
  }
}

function avg(arr) { if (!arr || !arr.length) return null; return arr.reduce((a, b) => a + b, 0) / arr.length; }
