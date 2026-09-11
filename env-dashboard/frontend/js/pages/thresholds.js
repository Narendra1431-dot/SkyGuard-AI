import { configApi, dashboardApi } from '../api/index.js';
import { apiClient } from '../api/client.js';
import { escapeHtml, loadingState, errorState, toast, formatNumber } from '../utils/ui.js';

export const thresholdsPage = {
  id: 'thresholds', title: 'Thresholds', sub: 'Edit detection thresholds. Changes take effect on the next reading.', group: 'Admin', icon: 'fa-solid fa-sliders',
  async render(root) {
    root.innerHTML = `<div class="card">
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <button class="btn" id="th-save">Save</button>
        <button class="btn ghost" id="th-cancel">Cancel</button>
        <button class="btn secondary" id="th-test" style="margin-left:auto;"><i class="fa-solid fa-flask"></i> Apply + verify</button>
      </div>
      <form id="th-form" class="grid grid-2" style="gap:10px;">${loadingState()}</form>
      <div id="th-result" style="margin-top:12px;"></div>
    </div>`;
    await load();
    document.getElementById('th-save').onclick = save;
    document.getElementById('th-cancel').onclick = load;
    document.getElementById('th-test').onclick = verify;
    return () => {};
  },
};

let current = null;
async function load() {
  const form = document.getElementById('th-form');
  form.innerHTML = loadingState();
  try {
    current = await configApi.getThresholds();
    form.innerHTML = Object.entries(current).map(([k, v]) => {
      const id = `th-${k}`;
      return `<label>${escapeHtml(k)}<input id="${id}" class="input" name="${k}" value="${escapeHtml(String(v))}" /></label>`;
    }).join('');
  } catch (e) { form.innerHTML = errorState(e.message); }
}

async function save() {
  try {
    const body = {};
    for (const [k, v] of Object.entries(current)) {
      const el = document.getElementById(`th-${k}`);
      const num = Number(el.value);
      body[k] = Number.isFinite(num) ? num : el.value;
    }
    const next = await configApi.saveThresholds(body);
    current = next; toast('Thresholds saved', 'success'); await load();
  } catch (e) { toast(e.message, 'error'); }
}

async function verify() {
  document.getElementById('th-result').innerHTML = loadingState('Verifying…');
  try {
    await save();
    const [dashboard, stations] = await Promise.all([
      apiClient.get('/api/v1/dashboard'),
      apiClient.get('/api/v1/stations'),
    ]);
    const stationRows = (stations.data || stations || []).slice(0, 8).map((s) => `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(s.status)}</td><td>${formatNumber(s.reading?.aqi, 0)}</td><td>${formatNumber(s.reading?.temperature, 1)} °C</td></tr>`).join('');
    document.getElementById('th-result').innerHTML = `
      <div class="state" style="text-align:left;">Active thresholds applied. Anomalies in the last 24h: <strong>${(dashboard.data || dashboard).anomaliesToday || 0}</strong>. Changes take effect on the next reading.</div>
      <table><thead><tr><th>Station</th><th>Status</th><th>AQI</th><th>Temp</th></tr></thead><tbody>${stationRows}</tbody></table>
    `;
  } catch (e) { document.getElementById('th-result').innerHTML = errorState(e.message); }
}
