import { maintenanceApi, stationApi } from '../api/index.js';
import { escapeHtml, formatNumber, loadingState, errorState, toast, statusBadge } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

export const maintenancePage = {
  id: 'maintenance', title: 'Predictive Maintenance', sub: 'Heuristic risk score and recommended windows per station.', group: 'Operations', icon: 'fa-solid fa-screwdriver-wrench',
  async render(root) {
    root.innerHTML = `<div class="card"><div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
      <span class="badge yellow">HEURISTIC ESTIMATE</span>
      <small style="color:#94a3b8;">Not a trained ML model. Risk score derived from current sensor thresholds + failure history.</small>
      <button class="btn secondary" style="margin-left:auto;" id="mn-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
    </div>
    <div id="mn-list">${loadingState()}</div></div>`;
    document.getElementById('mn-refresh').onclick = load;
    const off = socketMgr.on('maintenance:update', load);
    await load();
    return () => off();
  },
};

async function load() {
  try {
    const [list, stations] = await Promise.all([maintenanceApi.list(), stationApi.list()]);
    const map = new Map(stations.map((s) => [s.id, s]));
    const rows = (list.data || list).map((r) => ({ ...r, name: map.get(r.stationId)?.name || r.stationName || r.stationId }));
    const host = document.getElementById('mn-list');
    if (!rows.length) { host.innerHTML = '<div class="state empty">No maintenance records yet.</div>'; return; }
    host.innerHTML = `<table><thead><tr><th>Station</th><th>Risk</th><th>Failure prob.</th><th>Predicted window</th><th>MTBF</th><th>Estimated cost</th><th>Failures</th><th>Recommendation</th></tr></thead><tbody>${rows.map((r) => `<tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${riskBadge(r.riskScore)} ${formatNumber(r.riskScore,0)}</td>
      <td>${formatNumber(r.failureProbability,1)}%</td>
      <td>${escapeHtml(r.predictedWindow)}</td>
      <td>${formatNumber(r.mtbfHours,0)} h</td>
      <td>$${formatNumber(r.estimatedCost,0)}</td>
      <td>${r.failureCount || 0}</td>
      <td>${escapeHtml(r.recommendation)}</td>
    </tr>`).join('')}</tbody></table>`;
  } catch (e) { document.getElementById('mn-list').innerHTML = errorState(e.message); }
}

function riskBadge(v) { if (v > 70) return '<span class="badge red">HIGH</span>'; if (v > 30) return '<span class="badge yellow">MEDIUM</span>'; return '<span class="badge green">LOW</span>'; }
