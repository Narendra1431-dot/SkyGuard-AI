import { advancedAnalyticsApi, correlationApi, stationApi } from '../api/index.js';
import { escapeHtml, statusBadge, formatNumber, loadingState, errorState } from '../utils/ui.js';

let charts = {};
function destroyCharts() { for (const c of Object.values(charts)) { try { c.destroy(); } catch {} } charts = {}; }

const TIME_RANGES = [
  { label: '1h', minutes: 60 },
  { label: '6h', minutes: 360 },
  { label: '12h', minutes: 720 },
  { label: '24h', minutes: 1440 },
  { label: '7d', minutes: 10080 },
  { label: '30d', minutes: 43200 },
];
const PARAMS = [
  { value: 'temperature', label: 'Temperature' },
  { value: 'humidity', label: 'Humidity' },
  { value: 'pressure', label: 'Pressure' },
  { value: 'aqi', label: 'AQI' },
  { value: 'wind', label: 'Wind' },
  { value: 'rainfall', label: 'Rainfall' },
];

export const advancedAnalyticsPage = {
  id: 'advanced-analytics', title: 'Advanced Analytics', sub: 'Time-range analysis, trends, statistics, comparison, and export.', group: 'Operations', icon: 'fa-solid fa-chart-line',
  async render(root) {
    destroyCharts();
    root.innerHTML = `
      <div class="card">
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px;" id="aa-controls">
          <label>Station
            <select class="input" id="aa-station"><option value="">All stations</option></select>
          </label>
          <label>Parameter
            <select class="input" id="aa-param">${PARAMS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('')}</select>
          </label>
          <label>Time range
            <select class="input" id="aa-range">${TIME_RANGES.map((r) => `<option value="${r.minutes}">${r.label}</option>`).join('')}</select>
          </label>
          <button class="btn" id="aa-apply"><i class="fa-solid fa-filter"></i> Apply</button>
          <button class="btn secondary" id="aa-export-json"><i class="fa-solid fa-download"></i> JSON</button>
          <button class="btn secondary" id="aa-export-csv"><i class="fa-solid fa-file-csv"></i> CSV</button>
          <button class="btn secondary" id="aa-refresh" style="margin-left:auto;"><i class="fa-solid fa-rotate"></i> Refresh</button>
        </div>
      </div>
      <div class="grid grid-4" id="aa-kpi">${loadingState()}</div>
      <div class="grid grid-2 mt-3">
        <div class="card"><h3>Trend analysis</h3><div id="aa-trend">${loadingState()}</div></div>
        <div class="card"><h3>Statistical summary</h3><div id="aa-stats">${loadingState()}</div></div>
      </div>
      <div class="grid grid-2 mt-3">
        <div class="card"><h3>Top cross-parameter correlations</h3><canvas id="aa-corr" height="180"></canvas></div>
        <div class="card"><h3>Hourly anomaly pattern</h3><canvas id="aa-hourly" height="180"></canvas></div>
      </div>
      <div class="grid grid-2 mt-3">
        <div class="card"><h3>Weekday anomaly pattern</h3><canvas id="aa-weekday" height="180"></canvas></div>
        <div class="card"><h3>Station clusters (k-means)</h3><div id="aa-clusters"></div></div>
      </div>
      <div class="card mt-3"><h3>Per-station baselines (mean ± std)</h3><div id="aa-baselines"></div></div>
      <div class="card mt-3"><h3>Spatial deviations vs fleet</h3><div id="aa-spatial"></div></div>
      <div class="card mt-3"><h3>Environmental risk summary</h3><div id="aa-risk">${loadingState()}</div></div>
      <div class="card mt-3">
        <h3>Station comparison</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
          <label>Compare stations
            <select class="input" id="aa-compare-stations" multiple size="4" style="min-width:220px;"></select>
          </label>
          <label>Field
            <select class="input" id="aa-compare-field">${PARAMS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('')}</select>
          </label>
          <button class="btn secondary" id="aa-compare-go"><i class="fa-solid fa-chart-bar"></i> Compare</button>
        </div>
        <div id="aa-compare-result">Select stations and click Compare.</div>
      </div>
      <div class="card mt-3">
        <h3>Parameter comparison</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
          <label>Parameters
            <select class="input" id="aa-multi-param" multiple size="4" style="min-width:220px;">${PARAMS.map((p) => `<option value="${p.value}" selected>${p.label}</option>`).join('')}</select>
          </label>
          <button class="btn secondary" id="aa-multi-param-go"><i class="fa-solid fa-chart-line"></i> Show</button>
        </div>
        <div id="aa-multi-param-result">Select parameters and click Show.</div>
      </div>
      <div class="card mt-3">
        <h3>Multi-station ranking</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
          <label>Rank by
            <select class="input" id="aa-rank-field">${PARAMS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('')}</select>
          </label>
          <button class="btn secondary" id="aa-rank-go"><i class="fa-solid fa-list-ol"></i> Rank</button>
        </div>
        <div id="aa-rank-result">Click Rank to view station ranking.</div>
      </div>`;
    const stationSelect = document.getElementById('aa-station');
    const compareSelect = document.getElementById('aa-compare-stations');
    try {
      const stations = await stationApi.list();
      for (const s of stations) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.name} (${s.id})`;
        stationSelect.appendChild(opt);
        const cOpt = document.createElement('option');
        cOpt.value = s.id;
        cOpt.textContent = `${s.name} (${s.id})`;
        compareSelect.appendChild(cOpt);
      }
    } catch (_) {}
    document.getElementById('aa-apply').onclick = load;
    document.getElementById('aa-refresh').onclick = load;
    document.getElementById('aa-export-json').onclick = () => exportData('json');
    document.getElementById('aa-export-csv').onclick = () => exportData('csv');
    document.getElementById('aa-compare-go').onclick = runCompare;
    document.getElementById('aa-multi-param-go').onclick = runMultiParam;
    document.getElementById('aa-rank-go').onclick = runRanking;
    await load();
    return () => destroyCharts();
  },
};

async function load() {
  try {
    const minutes = Number(document.getElementById('aa-range').value) || 1440;
    const stationId = document.getElementById('aa-station').value || undefined;
    const field = document.getElementById('aa-param').value || 'temperature';
    const data = await advancedAnalyticsApi.comprehensive({ minutes, stationId });
    const k = document.getElementById('aa-kpi');
    k.innerHTML = `
      <div class="stat-card compact gray"><div class="lbl">Total readings</div><div class="val">${data.counts.total}</div></div>
      <div class="stat-card compact yellow"><div class="lbl">Anomalies</div><div class="val">${data.counts.anomalies}</div></div>
      <div class="stat-card compact red"><div class="lbl">Density</div><div class="val">${data.anomalyDensity.rate}%</div></div>
      <div class="stat-card compact blue"><div class="lbl">Clusters</div><div class="val">${data.clusters.length}</div></div>
    `;

    const corr = data.crossParameter.slice(0, 8);
    charts.corr = new Chart(document.getElementById('aa-corr'), {
      type: 'bar',
      data: { labels: corr.map((c) => `${c.a} ⇄ ${c.b}`), datasets: [{ data: corr.map((c) => c.correlation), backgroundColor: corr.map((c) => c.correlation > 0 ? '#22c55e' : '#ef4444') }] },
      options: chartOpts(),
    });

    charts.hourly = new Chart(document.getElementById('aa-hourly'), {
      type: 'line',
      data: { labels: data.hourly.map((h) => `${h.hour}:00`), datasets: [{ label: 'Anomaly rate (%)', data: data.hourly.map((h) => h.rate), borderColor: '#60a5fa', backgroundColor: '#60a5fa22', tension: 0.3, fill: true, pointRadius: 2 }] },
      options: chartOpts(),
    });

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    charts.weekday = new Chart(document.getElementById('aa-weekday'), {
      type: 'bar',
      data: { labels: data.weekday.map((w) => dayLabels[w.day]), datasets: [{ data: data.weekday.map((w) => w.rate), backgroundColor: '#22c55e' }] },
      options: chartOpts(),
    });

    document.getElementById('aa-clusters').innerHTML = data.clusters.length ? `<table class="dense"><thead><tr><th>Cluster</th><th>Centroid (lat, lon)</th></tr></thead><tbody>${data.clusters.map((c) => `<tr><td>${c.cluster}</td><td>${c.lat.toFixed(3)}, ${c.lon.toFixed(3)}</td></tr>`).join('')}</tbody></table>` : '<div class="state empty">No clusters</div>';

    const bl = document.getElementById('aa-baselines');
    bl.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Temp (μ±σ)</th><th>AQI (μ±σ)</th><th>Humidity (μ±σ)</th><th>Wind (μ±σ)</th></tr></thead><tbody>${Object.values(data.baselines).map((b) => `<tr><td>${escapeHtml(b.station)}</td><td>${formatNumber(b.fields.temperature.baseline.mean, 1)}±${formatNumber(b.fields.temperature.baseline.std, 1)}</td><td>${formatNumber(b.fields.aqi.baseline.mean, 0)}±${formatNumber(b.fields.aqi.baseline.std, 0)}</td><td>${formatNumber(b.fields.humidity.baseline.mean, 1)}±${formatNumber(b.fields.humidity.baseline.std, 1)}</td><td>${formatNumber(b.fields.wind.baseline.mean, 1)}±${formatNumber(b.fields.wind.baseline.std, 1)}</td></tr>`).join('')}</tbody></table>`;

    const sp = document.getElementById('aa-spatial');
    sp.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Temp (Δ)</th><th>AQI (Δ)</th><th>Humidity (Δ)</th><th>Wind (Δ)</th></tr></thead><tbody>${data.spatialDeviations.map((d) => `<tr><td>${escapeHtml(d.station)}</td><td>${formatDelta(d.fields.temperature.deviation)}</td><td>${formatDelta(d.fields.aqi.deviation)}</td><td>${formatDelta(d.fields.humidity.deviation)}</td><td>${formatDelta(d.fields.wind.deviation)}</td></tr>`).join('')}</tbody></table>`;

    const trendEl = document.getElementById('aa-trend');
    const statsEl = document.getElementById('aa-stats');
    const riskEl = document.getElementById('aa-risk');
    if (stationId) {
      try {
        const [trendRes, statsRes, riskRes] = await Promise.all([
          fetch(`/api/v1/analytics/trends?stationId=${encodeURIComponent(stationId)}&field=${encodeURIComponent(field)}&minutes=${minutes}`).then((r) => r.json()).catch((e) => ({ error: e.message })),
          fetch(`/api/v1/analytics/summary?stationId=${encodeURIComponent(stationId)}&field=${encodeURIComponent(field)}&minutes=${minutes}`).then((r) => r.json()).catch((e) => ({ error: e.message })),
          fetch(`/api/v1/analytics/risk?minutes=${minutes}&stationId=${encodeURIComponent(stationId)}`).then((r) => r.json()).catch((e) => ({ error: e.message })),
        ]);
        let trendHtml = '';
        if (statsRes && statsRes.data && statsRes.data.summary && statsRes.data.summary.available) {
          const s = statsRes.data.summary;
          trendHtml = `<table class="dense"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Count</td><td>${s.count}</td></tr><tr><td>Min</td><td>${formatNumber(s.min, 2)}</td></tr><tr><td>Max</td><td>${formatNumber(s.max, 2)}</td></tr><tr><td>Mean</td><td>${formatNumber(s.mean, 2)}</td></tr><tr><td>Median</td><td>${formatNumber(s.median, 2)}</td></tr><tr><td>Std Dev</td><td>${formatNumber(s.std, 2)}</td></tr><tr><td>Latest</td><td>${formatNumber(s.latest, 2)}</td></tr></tbody></table>`;
        } else {
          trendHtml = '<div class="state empty">Insufficient historical data for statistical summary.</div>';
        }
        statsEl.innerHTML = trendHtml;

        let trendInfoHtml = '';
        if (statsRes && statsRes.data && statsRes.data.trend) {
          const t = statsRes.data.trend;
          const cls = t.classification === 'increasing' ? 'yellow' : t.classification === 'decreasing' ? 'blue' : t.classification === 'stable' ? 'green' : 'gray';
          trendInfoHtml = `<div style="margin-bottom:8px;">Classification: <span class="badge ${cls}">${t.classification}</span> • Samples: ${t.sampleCount} • Confidence: ${t.confidence || 'n/a'}</div>`;
          if (t.slope != null) trendInfoHtml += `<div>Slope: ${t.slope > 0 ? '+' : ''}${formatNumber(t.slope, 6)} per ms</div>`;
        } else {
          trendInfoHtml = '<div class="state empty">Insufficient historical data for trend analysis.</div>';
        }
        trendEl.innerHTML = trendInfoHtml;

        if (riskRes && riskRes.data) {
          const risk = riskRes.data;
          const maxBadge = statusBadge(risk.maxSeverity);
          let factorsHtml = (risk.factors || []).map((f) => {
            const fBadge = statusBadge(f.severity);
            const station = f.stationId ? ` @ ${escapeHtml(f.stationId)}` : '';
            return `<li>${fBadge} ${escapeHtml(f.name)}: ${escapeHtml(String(f.value))}${station}</li>`;
          }).join('');
          riskEl.innerHTML = `<div style="margin-bottom:8px;">Overall risk: ${maxBadge} • Anomaly rate: ${risk.anomalyRate}% • Open alerts: ${risk.openAlerts}${risk.qualityScore != null ? ` • Quality: ${formatNumber(risk.qualityScore, 1)}%` : ''}</div><ul style="margin:0;padding-left:18px;">${factorsHtml || '<li>No significant risk factors detected.</li>'}</ul>`;
        } else {
          riskEl.innerHTML = '<div class="state empty">No risk data available.</div>';
        }
      } catch (_) {
        trendEl.innerHTML = '<div class="state empty">Insufficient historical data for trend analysis.</div>';
        statsEl.innerHTML = '<div class="state empty">Insufficient historical data for statistical summary.</div>';
        riskEl.innerHTML = '<div class="state empty">No risk data available.</div>';
      }
    } else {
      trendEl.innerHTML = '<div class="state empty">Select a station to view trend analysis.</div>';
      statsEl.innerHTML = '<div class="state empty">Select a station to view statistical summary.</div>';
      try {
        const riskRes = await fetch(`/api/v1/analytics/risk?minutes=${minutes}`);
        if (riskRes.ok) {
          const risk = await riskRes.json();
          const maxBadge = statusBadge(risk.maxSeverity);
          let factorsHtml = (risk.factors || []).map((f) => {
            const fBadge = statusBadge(f.severity);
            const station = f.stationId ? ` @ ${escapeHtml(f.stationId)}` : '';
            return `<li>${fBadge} ${escapeHtml(f.name)}: ${escapeHtml(String(f.value))}${station}</li>`;
          }).join('');
          riskEl.innerHTML = `<div style="margin-bottom:8px;">Overall risk: ${maxBadge} • Anomaly rate: ${risk.anomalyRate}% • Open alerts: ${risk.openAlerts}${risk.qualityScore != null ? ` • Quality: ${formatNumber(risk.qualityScore, 1)}%` : ''}</div><ul style="margin:0;padding-left:18px;">${factorsHtml || '<li>No significant risk factors detected.</li>'}</ul>`;
        } else {
          riskEl.innerHTML = '<div class="state empty">No risk data available.</div>';
        }
      } catch (_) {
        riskEl.innerHTML = '<div class="state empty">No risk data available.</div>';
      }
    }
  } catch (e) {
    const k = document.getElementById('aa-kpi');
    if (k) k.innerHTML = errorState(e.message);
  }
}

async function runCompare() {
  const minutes = Number(document.getElementById('aa-range').value) || 1440;
  const stationIds = Array.from(document.getElementById('aa-compare-stations').selectedOptions).map((o) => o.value);
  const field = document.getElementById('aa-compare-field').value || 'temperature';
  const host = document.getElementById('aa-compare-result');
  if (stationIds.length < 2) { host.innerHTML = '<div class="state empty">Select at least 2 stations to compare.</div>'; return; }
  host.innerHTML = loadingState();
  try {
    const r = await fetch(`/api/v1/analytics/compare?stationIds=${encodeURIComponent(stationIds.join(','))}&field=${field}&minutes=${minutes}`);
    if (!r.ok) { host.innerHTML = '<div class="state empty">Comparison failed.</div>'; return; }
    const data = await r.json();
    const rows = (data.stations || []).map((s) => `<tr><td>${escapeHtml(s.station)}</td><td>${s.count}</td><td>${formatNumber(s.min, 2)}</td><td>${formatNumber(s.max, 2)}</td><td>${formatNumber(s.mean, 2)}</td><td>${formatNumber(s.median, 2)}</td><td>${formatNumber(s.std, 2)}</td><td>${formatNumber(s.latest, 2)}</td></tr>`).join('');
    host.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Count</th><th>Min</th><th>Max</th><th>Mean</th><th>Median</th><th>Std Dev</th><th>Latest</th></tr></thead><tbody>${rows || '<tr><td colspan="8">No data</td></tr>'}</tbody></table><div style="margin-top:6px;color:#64748b;font-size:11px;">Ranking based on ${escapeHtml(field)} over last ${minutes} minutes</div>`;
  } catch (e) {
    host.innerHTML = `<div class="state empty">${escapeHtml(e.message)}</div>`;
  }
}

async function runMultiParam() {
  const minutes = Number(document.getElementById('aa-range').value) || 1440;
  const params = Array.from(document.getElementById('aa-multi-param').selectedOptions).map((o) => o.value);
  const host = document.getElementById('aa-multi-param-result');
  if (params.length < 2) { host.innerHTML = '<div class="state empty">Select at least 2 parameters to compare.</div>'; return; }
  host.innerHTML = loadingState();
  try {
    const r = await fetch(`/api/v1/analytics/correlation?minutes=${minutes}`);
    if (!r.ok) { host.innerHTML = '<div class="state empty">Correlation fetch failed.</div>'; return; }
    const allCorr = await r.json();
    const filtered = allCorr.filter((c) => params.includes(c.a) && params.includes(c.b));
    if (!filtered.length) { host.innerHTML = '<div class="state empty">No correlation data for selected parameters.</div>'; return; }
    const rows = filtered.map((c) => `<tr><td>${escapeHtml(c.a)}</td><td>${escapeHtml(c.b)}</td><td>${formatNumber(c.correlation, 3)}</td></tr>`).join('');
    host.innerHTML = `<table class="dense"><thead><tr><th>Parameter A</th><th>Parameter B</th><th>Correlation</th></tr></thead><tbody>${rows}</tbody></table><div style="margin-top:6px;color:#64748b;font-size:11px;">Pearson correlation over last ${minutes} minutes. Correlation does not imply causation.</div>`;
  } catch (e) {
    host.innerHTML = `<div class="state empty">${escapeHtml(e.message)}</div>`;
  }
}

async function runRanking() {
  const minutes = Number(document.getElementById('aa-range').value) || 1440;
  const field = document.getElementById('aa-rank-field').value || 'temperature';
  const host = document.getElementById('aa-rank-result');
  host.innerHTML = loadingState();
  try {
    const r = await fetch(`/api/v1/analytics/ranking?field=${field}&minutes=${minutes}`);
    if (!r.ok) { host.innerHTML = '<div class="state empty">Ranking fetch failed.</div>'; return; }
    const data = await r.json();
    const rows = (data.ranking || []).map((s) => `<tr><td>${s.rank}</td><td>${escapeHtml(s.station)}</td><td>${s.count}</td><td>${formatNumber(s.min, 2)}</td><td>${formatNumber(s.max, 2)}</td><td>${formatNumber(s.mean, 2)}</td><td>${formatNumber(s.median, 2)}</td><td>${formatNumber(s.std, 2)}</td><td>${formatNumber(s.latest, 2)}</td></tr>`).join('');
    host.innerHTML = `<table class="dense"><thead><tr><th>Rank</th><th>Station</th><th>Count</th><th>Min</th><th>Max</th><th>Mean</th><th>Median</th><th>Std Dev</th><th>Latest</th></tr></thead><tbody>${rows || '<tr><td colspan="9">No data</td></tr>'}</tbody></table><div style="margin-top:6px;color:#64748b;font-size:11px;">${escapeHtml(data.note || '')}</div>`;
  } catch (e) {
    host.innerHTML = `<div class="state empty">${escapeHtml(e.message)}</div>`;
  }
}

async function exportData(format) {
  const minutes = Number(document.getElementById('aa-range').value) || 1440;
  const stationId = document.getElementById('aa-station').value || undefined;
  const field = document.getElementById('aa-param').value || 'temperature';
  const url = `/api/v1/analytics/export?minutes=${minutes}${stationId ? `&stationId=${encodeURIComponent(stationId)}` : ''}&field=${encodeURIComponent(field)}&format=${format}`;
  window.open(url, '_blank');
}

function formatDelta(v) {
  if (v == null) return '—';
  return `${v > 0 ? '+' : ''}${formatNumber(v, 2)}`;
}
function chartOpts() { return { animation: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } }, scales: { x: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } } } }; }
