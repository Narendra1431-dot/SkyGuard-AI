import {
  dashboardApi, stationApi, qualityApi, providerApi, alertApi, maintenanceApi,
  intelligenceApi, eventsApi, advancedAnalyticsApi, stationIntelApi, correlationApi,
  monitoringApi,
} from '../api/index.js';
import { socketMgr } from '../api/socket.js';
import {
  escapeHtml, statusBadge, freshnessBadge, formatTime, formatNumber, formatDateTime,
  loadingState, errorState, toast, sparkline, statusClass, globalSearchBox, ageSeconds,
} from '../utils/ui.js';
import { navigate } from '../router.js';

let charts = {};
let situationTimer = null;
let eventStreamTimer = null;
let freshnessTimer = null;
let pageDisposed = false;
let invalidateSizeTimer = null;
let indiaMap = null;
let mapMarkers = {};
let lastStations = [];
let baseTileLayers = {};
let radarLayer = null;
let radarCache = null;
let layersPanelInit = false;
let layersDocHandler = null;
let layersKeyHandler = null;
let refreshLock = false;
let stationTimestamps = new Map();
let stationVersions = new Map();
let currentVersion = 0;
const mapLayers = {
  stationRisk: true,
  weather: false,
  satellite: false,
  rainRadar: false,
  airQuality: false,
  lightning: false,
  flood: false,
  fire: false,
  traffic: false,
};

function destroyCharts() {
  for (const c of Object.values(charts)) { try { c.destroy(); } catch {} }
  charts = {};
}

export const dashboardPage = {
  id: 'dashboard',
  title: 'Command Center',
  sub: 'Real-time environmental intelligence, decision support, and operations overview.',
  group: 'Operations',
  icon: 'fa-solid fa-gauge-high',
  async render(root) {
    pageDisposed = false;
    destroyCharts();
    root.innerHTML = `
      <div class="grid grid-6" id="kpi-grid">${loadingState('Loading situation…')}</div>
      <div class="grid grid-4 mt-3" id="kpi-grid-2">${loadingState()}</div>
      <div class="grid grid-3 mt-3">
        <div class="card">
          <div class="row"><h3 style="margin:0;">Trend (last 60m)</h3>
            <select id="trend-field" class="input compact" style="max-width:140px;margin-left:auto;">
              <option value="temperature">Temperature</option>
              <option value="aqi">AQI</option>
              <option value="humidity">Humidity</option>
              <option value="wind">Wind</option>
              <option value="pressure">Pressure</option>
              <option value="rainfall">Rainfall</option>
            </select>
          </div>
          <canvas id="trend-chart" height="120"></canvas>
        </div>
        <div class="card"><h3>Active anomalies</h3><div id="active-anoms">${loadingState()}</div></div>
        <div class="card"><h3>Critical stations</h3><div id="critical-stations">${loadingState()}</div></div>
      </div>
      <div class="grid grid-3 mt-3">
        <div class="card">
          <h3>What changed (last hour)</h3>
          <div id="event-stream" class="event-log" style="max-height:280px;"></div>
        </div>
        <div class="card">
          <h3>Recommended actions</h3>
          <div id="actions-list"></div>
        </div>
        <div class="card">
          <h3>Correlated events (24h)</h3>
          <div id="correlated-list"></div>
        </div>
      </div>
      <div class="grid mt-3" style="grid-template-columns: 55% 45%; gap: 12px;">
        <div class="card" style="display:flex; flex-direction:column;">
          <div class="row" style="margin-bottom:8px; align-items:center;">
            <div>
              <h3 style="margin:0;">India Live Risk Map</h3>
              <div class="muted" style="font-size:11px;">Real-time station status and critical areas</div>
            </div>
            <span class="muted" id="map-updated" style="font-size:10px; margin-left:auto; white-space:nowrap;"></span>
            <span class="freshness live" style="margin-left:8px;"><i class="fa-solid fa-circle" style="font-size:6px;"></i> Live</span>
            <div class="risk-layers-wrap" style="position:relative; margin-left:8px;">
              <button type="button" class="btn compact ghost" id="risk-layers-btn" style="font-size:9.5px; padding:3px 8px; white-space:nowrap; letter-spacing:0.04em;">
                <i class="fa-solid fa-layer-group" style="font-size:9px;"></i> MAP LAYERS <i class="fa-solid fa-chevron-down" style="font-size:8px; margin-left:3px;"></i>
              </button>
              <div id="risk-layers-panel" class="risk-layers-panel" hidden></div>
            </div>
          </div>
          <div id="india-map" class="risk-map" style="height:320px; border-radius:6px; overflow:hidden;"></div>
          <div class="risk-map-legend">
            <span class="lg-it"><i class="lg-dot" style="background:#ef4444;"></i> Critical</span>
            <span class="lg-it"><i class="lg-dot" style="background:#f59e0b;"></i> Warning</span>
            <span class="lg-it"><i class="lg-dot" style="background:#22c55e;"></i> Normal</span>
            <span class="lg-it"><i class="lg-dot" style="background:#64748b;"></i> Offline</span>
          </div>
          <div class="risk-map-legend" id="risk-map-legend-aq" style="display:none;">
            <span class="lg-it"><i class="lg-dot" style="background:#22c55e;"></i> Good</span>
            <span class="lg-it"><i class="lg-dot" style="background:#eab308;"></i> Moderate</span>
            <span class="lg-it"><i class="lg-dot" style="background:#f97316;"></i> Unhealthy</span>
            <span class="lg-it"><i class="lg-dot" style="background:#ef4444;"></i> Very Unhealthy</span>
            <span class="lg-it"><i class="lg-dot" style="background:#a855f7;"></i> Hazardous</span>
          </div>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:8px;">
            <h3 style="margin:0;">Recent alerts</h3>
            <a class="btn compact secondary" style="margin-left:auto; font-size:10px; padding:3px 8px;" onclick="navigate('alerts')">View All</a>
          </div>
          <div id="recent-alerts" style="max-height:360px; overflow-y:auto;">${loadingState()}</div>
        </div>
      </div>
      <div class="card mt-3">
        <h3>Global intelligence brief</h3>
        <div id="brief-host">${loadingState()}</div>
      </div>

      <div class="card mt-3">
        <div class="row"><h3 style="margin:0;">Stations</h3>
          <input id="st-search" class="input" placeholder="Filter…" style="max-width:220px;margin-left:auto;" />
          <button class="btn compact secondary" id="st-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
        </div>
        <div id="stations-table" style="margin-top:8px;">${loadingState()}</div>
      </div>
    `;

    document.getElementById('trend-field').onchange = () => loadTrend();
    document.getElementById('st-search').oninput = () => renderStations();
    document.getElementById('st-refresh').onclick = refresh;
    let off1, off2, off3, off4, off5, off6, off7, off8;
    try {
      off1 = socketMgr.on('dashboard:update', () => { if (!pageDisposed) refresh(); });
      off2 = socketMgr.on('sensor:update', () => { if (!pageDisposed) refreshLight(); });
      off3 = socketMgr.on('alert:new', () => { if (!pageDisposed) { refresh(); loadActions(); } });
      off4 = socketMgr.on('alert:update', () => { if (!pageDisposed) refresh(); });
      off5 = socketMgr.on('anomaly:new', () => { if (!pageDisposed) refresh(); });
      off6 = socketMgr.on('intelligence:brief', () => { if (!pageDisposed) loadBrief(); });
      off7 = socketMgr.on('agent:investigation:created', () => { if (!pageDisposed) loadBrief(); });
      off8 = socketMgr.on('agent.tool:completed', () => { if (!pageDisposed) loadBrief(); });
    } catch (_) {}

    initLayersPanel();
    await refresh();
    await loadTrend();
    await loadCorrelated();
    await loadActions();
    await loadEventStream();
    await loadBrief();
    if (situationTimer) clearInterval(situationTimer);
    situationTimer = setInterval(refresh, 8000);
    if (eventStreamTimer) clearInterval(eventStreamTimer);
    eventStreamTimer = setInterval(loadEventStream, 5000);
    startFreshnessTimer();

    return () => {
      pageDisposed = true;
      if (invalidateSizeTimer) { clearTimeout(invalidateSizeTimer); invalidateSizeTimer = null; }
      off1?.(); off2?.(); off3?.(); off4?.(); off5?.(); off6?.(); off7?.(); off8?.();
      if (situationTimer) clearInterval(situationTimer);
      if (eventStreamTimer) clearInterval(eventStreamTimer);
      stopFreshnessTimer();
      destroyCharts();
      if (indiaMap) {
        indiaMap.remove();
        indiaMap = null;
        mapMarkers = {};
      }
      unbindLayersOutsideClose();
      layersPanelInit = false;
      radarLayer = null;
      radarCache = null;
      baseTileLayers = {};
      lastStations = [];
      stationTimestamps.clear();
      currentVersion = 0;
      mapLayers.stationRisk = true;
      mapLayers.weather = false;
      mapLayers.satellite = false;
      mapLayers.rainRadar = false;
      mapLayers.airQuality = false;
    };
  },
};

async function refresh() {
  if (pageDisposed) return;
  try {
    // Core dashboard data: fetch essential info without waiting for optional/laggy services
    const [situation, quality, alerts, adv, maintenance] = await Promise.all([
      intelligenceApi.situation(),
      qualityApi.snapshot(),
      alertApi.list({ limit: 50 }),
      advancedAnalyticsApi.comprehensive({ minutes: 60 }),
      maintenanceApi.list(),
    ]);

    // V2 KPI grid
    const env = situation.environment || {};
    const kpi = document.getElementById('kpi-grid');
    if (kpi) {
      kpi.innerHTML = '';
      const cards = [
        card('Total Stations', env.stationCount, 'gray', situation.when, () => navigate('stations')),
        card('Critical', env.criticalCount, 'red', situation.when, () => navigate('stations?status=critical')),
        card('Warning', env.warningCount, 'yellow', situation.when, () => navigate('stations?status=warning')),
        card('Offline', env.offlineCount, 'gray', situation.when, () => navigate('stations?status=offline')),
        card('Open Alerts', situation.openAlerts, 'red', situation.when, () => navigate('alerts')),
        card('Data Quality', formatNumber(quality.overallScore, 1) + '%', statusClass(quality.overallScore), quality.computedAt, () => navigate('quality')),
      ];
      for (const c of cards) kpi.appendChild(c);
    }

    // Optional: live provider stats - fetch with timeout but don't block
    const kpi2 = document.getElementById('kpi-grid-2');
    let providers = [];
    let liveProvidersCount = 0;
    let failingProvidersCount = 0;
    let highRiskMaintCount = maintenance.filter((m) => m.riskScore > 70).length;
    
    try {
      const providerPromise = providerApi.list();
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Providers timeout')), 3000));
      const fetchedProviders = await Promise.race([providerPromise, timeoutPromise]);
      providers = Array.isArray(fetchedProviders) ? fetchedProviders : [];
    } catch (e) {
      console.warn('Provider list failed or timed out:', e.message);
      providers = [];
    }
    
    liveProvidersCount = providers.filter((p) => p.enabled && p.configurationState === 'CONFIGURED').length;
    failingProvidersCount = providers.filter((p) => p.status === 'RED').length;
    
    kpi2.innerHTML = '';
    const cards = [
      card('Live Providers', `${liveProvidersCount}/${providers.length || 1}`, 'blue', situation.when, () => navigate('providers')),
      card('Failing Providers', failingProvidersCount, 'red', situation.when, () => navigate('providers')),
      card('High-Risk Stations', highRiskMaintCount, highRiskMaintCount > 0 ? 'red' : 'green', situation.when, () => navigate('maintenance')),
      card('System Health', situation.systemHealth, statusClass(situation.systemHealth), situation.when, () => navigate('architecture')),
      card('Ingestion /min', adv.counts?.total ? Math.round(adv.counts.total / 60) : 0, 'blue', situation.when, null),
      card('Anomaly Density', adv.anomalyDensity?.rate + '%', adv.anomalyDensity?.rate > 15 ? 'red' : adv.anomalyDensity?.rate > 5 ? 'yellow' : 'green', situation.when, () => navigate('anomalies')),
    ];
    for (const c of cards) kpi2.appendChild(c);

    // Active anomalies
    const recentAlerts = document.getElementById('recent-alerts');
    if (recentAlerts) {
      const rows = (Array.isArray(alerts) ? alerts : alerts?.items || []).slice(0, 8);
      recentAlerts.innerHTML = rows.length
        ? rows.map((alert) => `<div class="row-alert row" data-id="${escapeHtml(alert.id)}" style="padding:6px 0;border-bottom:1px solid #1e293b;cursor:pointer;">
            <span class="badge ${statusClass(alert.severity)}">${escapeHtml(alert.severity || 'INFO')}</span>
            <div style="flex:1;"><strong>${escapeHtml(alert.title || alert.description || 'Alert')}</strong><div class="muted" style="font-size:11px;">${escapeHtml(alert.station || alert.stationId || '')}</div></div>
          </div>`).join('')
        : '<div class="state empty">No recent alerts.</div>';
      recentAlerts.querySelectorAll('.row-alert').forEach((row) => {
        row.onclick = () => navigate(`alerts?focus=${encodeURIComponent(row.dataset.id)}`);
      });
    }

    // Active anomalies
    const aHost = document.getElementById('active-anoms');
    if (aHost) {
      const acts = (situation.activeAnomalies || []).slice(0, 6);
      aHost.innerHTML = acts.length
        ? acts.map((a) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;cursor:pointer;" data-station="${escapeHtml(a.stationId)}">
            <span class="badge red">${escapeHtml(a.stationId)}</span>
            <div style="flex:1;"><div><strong>${escapeHtml(a.station)}</strong></div><div class="muted" style="font-size:11px;">${escapeHtml((a.reasons || []).join('; '))}</div></div>
          </div>`).join('')
        : '<div class="state empty">No active anomalies.</div>';
      aHost.querySelectorAll('[data-station]').forEach((el) => el.onclick = () => navigate(`station-detail?${encodeURIComponent(el.dataset.station)}`));
    }

    // Critical stations
    const cHost = document.getElementById('critical-stations');
    if (cHost) {
      const crit = (situation.criticalStations || []).slice(0, 6);
      cHost.innerHTML = crit.length
        ? crit.map((s) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;cursor:pointer;" data-station="${escapeHtml(s.id)}">
            <span class="badge red">CRITICAL</span>
            <strong style="flex:1;">${escapeHtml(s.name)}</strong>
            <small class="muted">${escapeHtml(s.id)}</small>
          </div>`).join('')
        : '<div class="state empty">No critical stations.</div>';
      cHost.querySelectorAll('[data-station]').forEach((el) => el.onclick = () => navigate(`station-detail?${encodeURIComponent(el.dataset.station)}`));
    }

    await renderStations();
    await loadActions();
  } catch (e) {
    const k = document.getElementById('kpi-grid');
    if (k) k.innerHTML = errorState(e.message);
  }
  try { await updateIndiaMap(); } catch (_) {}
}

async function renderStations() {
  const host = document.getElementById('stations-table');
  if (!host) return;
  try {
    const search = (document.getElementById('st-search')?.value || '').toLowerCase();
    const stations = await stationApi.list();
    let rows = stations;
    if (search) rows = rows.filter((s) => s.name.toLowerCase().includes(search) || s.id.toLowerCase().includes(search));
    if (!rows.length) { host.innerHTML = emptyState('No stations match your filter.'); return; }
    host.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Status</th><th>Health</th><th>Temp</th><th>AQI</th><th>Humidity</th><th>Wind</th><th>Pressure</th><th>Freshness</th><th>Trend</th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`;
    host.querySelectorAll('.row-station').forEach((tr) => tr.onclick = () => navigate(`station-detail?${encodeURIComponent(tr.dataset.id)}`));
  } catch (e) { host.innerHTML = errorState(e.message); }
}

function rowHtml(s) {
  const r = s.reading || {};
  const series = (s._history || []);
  return `<tr class="row-station" data-id="${escapeHtml(s.id)}" style="cursor:pointer;">
    <td><strong>${escapeHtml(s.name)}</strong><br/><small class="muted">${escapeHtml(s.id)}</small></td>
    <td>${statusBadge(s.status)}</td>
    <td>${formatNumber(s.healthScore, 0)}</td>
    <td>${formatNumber(r.temperature, 1)} °C</td>
    <td>${formatNumber(r.aqi, 0)}</td>
    <td>${formatNumber(r.humidity, 1)}%</td>
    <td>${formatNumber(r.wind, 1)} m/s</td>
    <td>${formatNumber(r.pressure, 1)} hPa</td>
    <td>${freshnessBadge(r.time)}</td>
    <td>${sparkline(series, { width: 80, color: statusClass(s.status) === 'red' ? '#ef4444' : statusClass(s.status) === 'yellow' ? '#eab308' : '#60a5fa' })}</td>
  </tr>`;
}

async function refreshLight() {
  if (refreshLock || pageDisposed) return;
  const callVersion = ++currentVersion;
  refreshLock = true;
  try {
    const stations = await stationApi.list();
    if (callVersion !== currentVersion || pageDisposed) return;
    const stationIds = stations.map((s) => s.id);
    for (const s of stations) {
      if (s.reading?.time) {
        stationTimestamps.set(s.id, s.reading.time);
      }
    }
    const batch = await dashboardApi.historyBatch({ stationIds, field: 'temperature', minutes: 30 });
    const enriched = stations.map((s) => ({ ...s, _history: batch[s.id] || [] }));
    const host = document.getElementById('stations-table');
    if (host && host.querySelector('tbody') && callVersion === currentVersion) {
      host.querySelector('tbody').innerHTML = enriched.map(rowHtml).join('');
      host.querySelectorAll('.row-station').forEach((tr) => tr.onclick = () => navigate(`station-detail?${encodeURIComponent(tr.dataset.id)}`));
    }
    await updateIndiaMap();
  } catch (_) {} finally {
    refreshLock = false;
  }
}

function recalculateFreshness() {
  const host = document.getElementById('stations-table');
  if (!host || !host.querySelector('tbody')) return;
  const now = Date.now();
  host.querySelectorAll('tr.row-station').forEach((tr) => {
    const id = tr.dataset.id;
    const ts = stationTimestamps.get(id);
    if (!ts) return;
    const age = Math.max(0, Math.round((now - new Date(ts).getTime()) / 1000));
    const freshnessCell = tr.querySelector('td:nth-child(9)');
    if (freshnessCell) {
      freshnessCell.innerHTML = freshnessBadge(ts);
    }
  });
}

function startFreshnessTimer() {
  if (freshnessTimer) return;
  freshnessTimer = setInterval(recalculateFreshness, 1000);
}

function stopFreshnessTimer() {
  if (freshnessTimer) {
    clearInterval(freshnessTimer);
    freshnessTimer = null;
  }
}

async function loadTrend() {
  const field = document.getElementById('trend-field')?.value || 'temperature';
  const ctx = document.getElementById('trend-chart');
  if (!ctx) return;
  try {
    const response = await stationApi.list();
    const stations = Array.isArray(response) ? response : (response?.data ?? []);
    const topStations = stations.slice(0, 6);
    const stationIds = topStations.map((s) => s.id);
    const batch = await dashboardApi.historyBatch({ stationIds, field, minutes: 60 });
    const series = topStations.map((s) => {
      const data = (batch[s.id] || []).map((p) => ({ x: new Date(p.t).toLocaleTimeString(), y: p.v }));
      return { label: s.name, data };
    });
    if (charts.trend) charts.trend.destroy();
    charts.trend = new Chart(ctx, {
      type: 'line', data: { datasets: series.map((s, i) => ({
        label: s.label, data: s.data, borderColor: palette(i), backgroundColor: palette(i) + '22', tension: 0.3, pointRadius: 0, borderWidth: 1.5,
      })) },
      options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } }, scales: { x: { type: 'category', ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } } } },
    });
  } catch (e) { console.error(e); }
}

async function loadCorrelated() {
  try {
    const groups = await correlationApi.correlated({ minutes: 1440 });
    const host = document.getElementById('correlated-list');
    if (!host) return;
    if (!groups.length) { host.innerHTML = '<div class="state empty">No correlated events detected.</div>'; return; }
    host.innerHTML = groups.slice(0, 8).map((g) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;">
      <span class="badge ${statusClass(g.severity)}">${escapeHtml(g.severity.toUpperCase())}</span>
      <div style="flex:1;"><div><strong>${escapeHtml(g.stationCount)} stations, ${g.alertIds.length} alerts</strong></div><div class="muted" style="font-size:11px;">${escapeHtml(g.summary)}</div></div>
      <small class="muted">${formatTime(g.bucket)}</small>
    </div>`).join('');
  } catch (e) { document.getElementById('correlated-list').innerHTML = errorState(e.message); }
}

async function loadBrief() {
  try {
    const brief = await monitoringApi.brief();
    const host = document.getElementById('brief-host');
    if (!host) return;
    const cs = brief.currentSituation || {};
    const rows = [
      { lbl: 'Critical stations', val: cs.criticalStations, color: (cs.criticalStations || 0) > 0 ? 'red' : 'green' },
      { lbl: 'Open alerts', val: cs.openAlerts, color: (cs.openAlerts || 0) > 0 ? 'red' : 'green' },
      { lbl: 'Provider failures', val: cs.providerFailures, color: (cs.providerFailures || 0) > 0 ? 'red' : 'green' },
      { lbl: 'Maintenance HIGH', val: cs.maintenanceHigh, color: (cs.maintenanceHigh || 0) > 0 ? 'red' : 'green' },
      { lbl: 'Data quality', val: cs.qualityScore != null ? `${formatNumber(cs.qualityScore, 1)}%` : '—', color: cs.qualityScore == null ? 'gray' : cs.qualityScore >= 90 ? 'green' : cs.qualityScore >= 70 ? 'yellow' : 'red' },
      { lbl: 'Agent', val: brief.agentStatus?.status || 'IDLE', color: brief.agentStatus?.status === 'ACTIVE' ? 'blue' : 'gray' },
      { lbl: 'RAG', val: cs.ragStatus || 'GRAY', color: cs.ragStatus === 'GREEN' ? 'green' : cs.ragStatus === 'RED' ? 'red' : 'gray' },
      { lbl: 'ML', val: cs.mlStatus || 'GRAY', color: cs.mlStatus === 'GREEN' ? 'green' : cs.mlStatus === 'YELLOW' ? 'yellow' : cs.mlStatus === 'RED' ? 'red' : 'gray' },
    ];
    const incidents = brief.activeIncidents || [];
    const topRisks = brief.topRisks || [];
    host.innerHTML = `
      <div class="grid grid-4">${rows.map((r) => `<div class="card" style="padding:8px;"><div class="muted" style="font-size:11px;">${escapeHtml(r.lbl)}</div><div style="font-size:18px;font-weight:600;color:var(--${r.color},#94a3b8);">${escapeHtml(String(r.val))}</div></div>`).join('')}</div>
      <div class="mt-3"><strong>Top risks</strong>${topRisks.length === 0 ? '<div class="state empty">No top risks.</div>' : `<ul style="margin:6px 0 0 16px;font-size:12px;">${topRisks.map((r) => `<li><span class="badge ${escapeHtml(r.risk.toLowerCase().includes('critical') ? 'red' : r.risk.toLowerCase().includes('provider') ? 'red' : 'yellow')}">${escapeHtml(r.risk)}</span> ${escapeHtml(r.station || 'fleet')} — ${escapeHtml(r.detail || '')}</li>`).join('')}</ul>`}</div>
      <div class="mt-2"><strong>Active incidents</strong>${incidents.length === 0 ? '<div class="state empty">No active incidents.</div>' : incidents.map((t) => `<div class="row" style="padding:4px 0;"><span class="badge ${escapeHtml((t.severity || 'info').toLowerCase())}">${escapeHtml(t.severity)}</span><strong>${escapeHtml(t.eventType)}</strong><small class="muted" style="margin-left:auto;">${escapeHtml(t.id)}</small></div>`).join('')}</div>
    `;
  } catch (e) { const host = document.getElementById('brief-host'); if (host) host.innerHTML = errorState(e.message); }
}

async function loadActions() {
  try {
    const recs = await intelligenceApi.whatToDo();
    const host = document.getElementById('actions-list');
    if (!host) return;
    if (!recs.length) { host.innerHTML = '<div class="state empty">No actions recommended.</div>'; return; }
    host.innerHTML = recs.slice(0, 8).map((r) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;">
      <span class="badge ${statusClass(r.priority)}">${escapeHtml(r.priority)}</span>
      <div style="flex:1;"><div><strong>${escapeHtml(r.action)}</strong></div><div class="muted" style="font-size:11px;">${escapeHtml(r.reason || '')}${r.station ? ' • ' + escapeHtml(r.station) : ''}</div></div>
    </div>`).join('');
  } catch (e) { document.getElementById('actions-list').innerHTML = errorState(e.message); }
}

async function loadEventStream() {
  try {
    const events = await eventsApi.list({ limit: 60 });
    const host = document.getElementById('event-stream');
    if (!host) return;
    if (!events.length) { host.innerHTML = '<div class="state empty">No events yet.</div>'; return; }
    host.innerHTML = events.slice(0, 24).map((e) => `<div class="event">
      <span class="time">${formatTime(e.timestamp)}</span>
      <span class="badge ${statusClass(e.severity)}" style="min-width:60px;justify-content:center;">${escapeHtml(e.category)}</span>
      <span><strong>${escapeHtml(e.title)}</strong>${e.station ? ' — ' + escapeHtml(e.station) : ''}</span>
    </div>`).join('');
  } catch (e) { /* ignore */ }
}

function card(label, value, color, fresh, onClick) {
  const node = document.createElement('div');
  node.className = `stat-card compact ${color}`;
  node.setAttribute('data-clickable', onClick ? '1' : '0');
  if (onClick) { node.style.cursor = 'pointer'; node._fn = onClick; node.onclick = onClick; }
  node.innerHTML = `<div class="lbl">${escapeHtml(label)}</div><div class="val">${escapeHtml(String(value))}</div><div class="sub">${freshnessBadge(fresh)}</div>`;
  return node;
}

function palette(i) { const c = ['#60a5fa','#22c55e','#eab308','#ef4444','#a78bfa','#14b8a6','#f97316','#facc15']; return c[i % c.length]; }

const RISK_META = {
  critical: { color: '#ef4444', glow: 'rgba(239,68,68,0.55)', label: 'CRITICAL', pulse: true },
  warning:  { color: '#f59e0b', glow: 'rgba(245,158,11,0.45)', label: 'WARNING', pulse: true },
  healthy:  { color: '#22c55e', glow: 'rgba(34,197,94,0.45)',  label: 'NORMAL',  pulse: false },
  offline:  { color: '#64748b', glow: 'rgba(100,116,139,0.35)', label: 'OFFLINE', pulse: false },
};

function getMarkerColor(status) {
  return (RISK_META[status] || RISK_META.offline).color;
}

const MAP_LAYER_DEFS = [
  { id: 'stationRisk', label: 'Station Risk', available: true },
  { id: 'weather', label: 'Weather', available: true, desc: 'Live temperature, wind & humidity at each station (from station telemetry).' },
  { id: 'satellite', label: 'Satellite', available: true, desc: 'High-resolution satellite imagery (Esri World Imagery).' },
  { id: 'rainRadar', label: 'Rain Radar', available: true, desc: 'Live precipitation radar (RainViewer). Stitched from the latest available frame.' },
  { id: 'airQuality', label: 'Air Quality', available: true, desc: 'Air Quality Index (AQI) at each station (from station telemetry).' },
  { id: 'lightning', label: 'Lightning', available: false, unavailableMsg: 'No lightning data source configured' },
  { id: 'flood', label: 'Flood Risk', available: false, unavailableMsg: 'No flood risk data source configured' },
  { id: 'fire', label: 'Fire Risk', available: false, unavailableMsg: 'No fire risk data source configured' },
  { id: 'traffic', label: 'Traffic', available: false, unavailableMsg: 'No traffic data source configured' },
];
const MARKER_LAYER_IDS = ['weather', 'airQuality', 'stationRisk'];

function aqiBand(aqi) {
  if (aqi == null) return null;
  if (aqi <= 50) return { label: 'Good', color: '#22c55e' };
  if (aqi <= 100) return { label: 'Moderate', color: '#eab308' };
  if (aqi <= 150) return { label: 'Unhealthy (Sensitive)', color: '#f97316' };
  if (aqi <= 200) return { label: 'Unhealthy', color: '#ef4444' };
  if (aqi <= 300) return { label: 'Very Unhealthy', color: '#a855f7' };
  return { label: 'Hazardous', color: '#7f1d1d' };
}

function statusKey(status) {
  if (status === 'critical' || status === 'warning' || status === 'healthy' || status === 'offline') return status;
  return 'offline';
}

function createMarkerIcon(station) {
  const key = statusKey(station.status);
  const meta = RISK_META[key];
  const r = station.reading || {};

  const showRisk = mapLayers.stationRisk;
  const pulse = meta.pulse
    ? `<span class="risk-pulse" style="border-color:${meta.glow};"></span>`
    : '';
  const halo = meta.pulse
    ? `<span class="risk-halo" style="background:${meta.glow};"></span>`
    : '';
  const dot = showRisk
    ? `<span class="risk-dot" style="background:${meta.color};box-shadow:0 0 10px ${meta.glow};"></span>`
    : '';
  const label = (showRisk && (key === 'critical' || key === 'warning'))
    ? `<span class="risk-label"><b>${escapeHtml(station.name)}</b><em style="color:${meta.color};">${escapeHtml(meta.label)}</em></span>`
    : '';

  const weather = mapLayers.weather && (r.temperature != null || r.humidity != null || r.wind != null)
    ? `<span class="risk-weather">
        ${r.temperature != null ? `<b>${r.temperature.toFixed(1)}°C</b>` : '<b>—</b>'}
        <em>${r.humidity != null ? 'H' + Math.round(r.humidity) + '%' : ''}${r.humidity != null && r.wind != null ? ' · ' : ''}${r.wind != null ? 'W' + r.wind.toFixed(1) + 'm/s' : ''}</em>
       </span>`
    : '';
  const aq = mapLayers.airQuality ? aqiBand(r.aqi) : null;
  const aqBadge = aq
    ? `<span class="risk-aq" style="color:${aq.color};border-color:${aq.color};" title="${escapeHtml(aq.label)} · AQI ${r.aqi}">AQI&nbsp;${Math.round(r.aqi)}</span>`
    : '';

  return L.divIcon({
    className: showRisk ? 'risk-marker' : 'risk-marker show-map-only',
    html: `<div class="risk-marker-inner">${halo}${pulse}${dot}${label}${weather}${aqBadge}</div>`,
    iconSize: null,
    iconAnchor: [9, 9],
  });
}

function buildPopupHtml(station) {
  const key = statusKey(station.status);
  const meta = RISK_META[key];
  const r = station.reading || {};
  const freshness = r.time != null ? ageSeconds(r.time) + ' sec ago' : '—';
  const riskLevel = key === 'critical' ? 'HIGH' : key === 'warning' ? 'MODERATE' : key === 'healthy' ? 'LOW' : 'OFFLINE';
  const aq = aqiBand(r.aqi);
  const rows = [
    ['Status', `<span class="pp-status" style="color:${meta.color};">${escapeHtml(key.toUpperCase())}</span>`],
    ['Risk Score', (station.healthScore != null ? station.healthScore + '/100' : '—')],
    ['Temperature', (r.temperature != null ? r.temperature.toFixed(1) + ' °C' : '—')],
    ['Humidity', (r.humidity != null ? r.humidity.toFixed(1) + '%' : '—')],
    ['Pressure', (r.pressure != null ? r.pressure.toFixed(1) + ' hPa' : '—')],
    ['Air Quality', aq ? `<span style="color:${aq.color};font-weight:700;">${escapeHtml(aq.label)} &#183; ${Math.round(r.aqi)}</span>` : '—'],
    ['Risk Level', riskLevel],
    ['Last Updated', freshness],
  ];
  return `
    <div class="risk-popup">
      <div class="pp-title">${escapeHtml(station.name)}
        <small>${escapeHtml(station.id)}</small>
      </div>
      <div class="pp-sep" style="background:${meta.color};"></div>
      <table class="pp-table">
        ${rows.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`).join('')}
      </table>
      <button class="btn compact secondary" data-pp-detail="${escapeHtml(station.id)}"><i class="fa-solid fa-arrow-right"></i> View Station Details</button>
    </div>`;
}

function injectRiskMapStyles() {
  if (document.getElementById('risk-map-styles')) return;
  const style = document.createElement('style');
  style.id = 'risk-map-styles';
  style.textContent = `
#india-map .leaflet-container { background:#0b1220; font-family:'Inter',sans-serif; }
#india-map .leaflet-tile { filter: none; }
#india-map .leaflet-attribution { background:rgba(10,14,23,0.7) !important; color:#64748b; font-size:9px; }
#india-map .leaflet-attribution a { color:#7d8aa0; }

#india-map .leaflet-control-zoom { border:none !important; box-shadow:0 2px 10px rgba(0,0,0,0.5) !important; border-radius:6px !important; overflow:hidden; background:#111827 !important; }
#india-map .leaflet-control-zoom a { background:#111827 !important; color:#94a3b8 !important; border:1px solid #1e293b !important; font-size:15px !important; line-height:26px !important; width:28px !important; height:28px !important; }
#india-map .leaflet-control-zoom a:hover { background:#1f2937 !important; color:#e2e8f0 !important; }
#india-map .leaflet-control-zoom .leaflet-control-zoom-in { border-radius:6px 6px 0 0 !important; }
#india-map .leaflet-control-zoom .leaflet-control-zoom-out { border-radius:0 0 6px 6px !important; }

#india-map .risk-fit-btn { width:28px; height:28px; background:#111827; border:1px solid #1e293b; border-radius:6px; color:#94a3b8; display:flex; align-items:center; justify-content:center; cursor:pointer; margin-top:6px; box-shadow:0 2px 10px rgba(0,0,0,0.5); }
#india-map .risk-fit-btn:hover { background:#1f2937; color:#e2e8f0; }

.risk-map { position:relative; touch-action:none; }
.risk-map::after { content:''; position:absolute; inset:0; pointer-events:none; border:1px solid #1e293b; border-radius:6px; z-index:500; }

.risk-marker .risk-marker-inner { position:relative; width:18px; height:18px; }
.risk-marker .risk-dot { position:absolute; top:3px; left:3px; width:12px; height:12px; border-radius:50%; border:2px solid #0b1220; z-index:3; }
.risk-marker .risk-halo { position:absolute; top:6px; left:6px; width:6px; height:6px; border-radius:50%; z-index:1; }
.risk-marker .risk-pulse { position:absolute; top:0; left:0; width:18px; height:18px; border-radius:50%; border:2px solid; animation:riskPulse 2.2s ease-out infinite; z-index:2; }
.risk-marker .risk-label { position:absolute; top:-4px; left:22px; white-space:nowrap; display:flex; flex-direction:column; line-height:1.15; pointer-events:none; filter:drop-shadow(0 1px 2px rgba(0,0,0,0.8)); }
.risk-marker .risk-label b { font-size:10px; font-weight:600; color:#e2e8f0; }
.risk-marker .risk-label em { font-size:8px; font-style:normal; font-weight:700; letter-spacing:0.06em; }
@keyframes riskPulse { 0% { transform:scale(0.55); opacity:0.9; } 70% { transform:scale(1.6); opacity:0; } 100% { transform:scale(1.6); opacity:0; } }

.risk-map-legend { display:flex; gap:14px; margin-top:8px; font-size:10.5px; color:#94a3b8; }
.risk-map-legend .lg-it { display:inline-flex; align-items:center; gap:5px; }
.risk-map-legend .lg-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }

.risk-map-legend#risk-map-legend-aq { margin-top:6px; font-size:9.5px; color:#7d8aa0; }

.risk-layers-wrap { z-index:600; }
.risk-layers-wrap .btn.ghost { background:transparent; border:1px solid #1e293b; }
.risk-layers-wrap .btn.ghost:hover { background:#1f2937; color:#e2e8f0; }
.risk-layers-panel { position:absolute; top:calc(100% + 6px); right:0; z-index:1200; width:216px; background:#0f172a; border:1px solid #1e293b; border-radius:8px; box-shadow:0 12px 32px rgba(0,0,0,0.55); overflow:hidden; pointer-events:auto; }
.risk-layers-panel[hidden] { display:none; }
.risk-layers-head { padding:7px 12px; font-size:9px; font-weight:700; letter-spacing:0.1em; color:#94a3b8; border-bottom:1px solid #1e293b; }
.risk-layer-row { display:flex; align-items:center; gap:8px; padding:7px 12px; cursor:pointer; font-size:11.5px; color:#e2e8f0; }
.risk-layer-row:hover { background:#1a2333; }
.risk-layer-row.is-unavail { color:#64748b; cursor:not-allowed; }
.risk-layer-row.is-unavail:hover { background:transparent; }
.risk-layer-row input[type=checkbox] { accent-color:#60a5fa; width:13px; height:13px; cursor:pointer; margin:0; }
.risk-layer-row.is-unavail input[type=checkbox] { cursor:not-allowed; }
.risk-layer-unavail { margin-left:auto; font-style:normal; font-size:9px; color:#475569; }

.risk-marker.show-map-only .risk-dot,
.risk-marker.show-map-only .risk-halo,
.risk-marker.show-map-only .risk-pulse,
.risk-marker.show-map-only .risk-label { display:none; }
.risk-marker.show-map-only .risk-marker-inner { width:0; height:0; }
.risk-marker .risk-weather { position:absolute; top:20px; left:-8px; background:rgba(15,23,42,0.92); border:1px solid #1e293b; border-radius:4px; padding:2px 5px; font-size:8.5px; line-height:1.35; color:#cbd5e1; white-space:nowrap; display:flex; flex-direction:column; align-items:center; pointer-events:none; z-index:4; }
.risk-marker .risk-weather b { font-weight:600; color:#f8fafc; font-size:9.5px; }
.risk-marker .risk-weather em { font-style:normal; color:#94a3b8; font-size:8px; }
.risk-marker .risk-aq { position:absolute; top:-10px; right:-12px; min-width:18px; height:16px; padding:0 5px; background:rgba(10,14,23,0.9); border:1.5px solid; border-radius:8px; font-size:8.5px; font-weight:700; display:flex; align-items:center; justify-content:center; pointer-events:none; z-index:5; white-space:nowrap; }
.risk-marker.show-map-only .risk-aq { top:8px; left:2px; right:auto; }

.leaflet-popup.risk-popup-wrap .leaflet-popup-content-wrapper { background:#111827 !important; color:#e2e8f0; border:1px solid #1e293b; border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,0.6); }
.leaflet-popup.risk-popup-wrap .leaflet-popup-tip { background:#111827 !important; border:1px solid #1e293b; }
.leaflet-popup.risk-popup-wrap .leaflet-popup-content { margin:12px 14px; font-size:12px; }
.risk-popup .pp-title { font-size:13px; font-weight:600; display:flex; justify-content:space-between; align-items:baseline; gap:10px; }
.risk-popup .pp-title small { font-size:10px; color:#64748b; }
.risk-popup .pp-sep { height:2px; border-radius:2px; margin:6px 0 8px; }
.risk-popup .pp-table { width:100%; border-collapse:collapse; font-size:11.5px; margin-bottom:8px; }
.risk-popup .pp-table td { padding:2.5px 0; }
.risk-popup .pp-table td:first-child { color:#64748b; width:88px; }
.risk-popup .pp-table td:last-child { text-align:right; color:#e2e8f0; }
.risk-popup .pp-status { font-weight:700; }
`;
  document.head.appendChild(style);
}

function updateMapStamp(stations) {
  const el = document.getElementById('map-updated');
  if (!el) return;
  const times = stations
    .map((s) => s.reading && s.reading.time)
    .filter(Boolean)
    .map((t) => new Date(t).getTime());
  const newest = times.length ? Math.max.apply(null, times) : Date.now();
  const sec = Math.max(0, Math.round((Date.now() - newest) / 1000));
  el.textContent = sec < 60 ? `Updated ${sec}s ago` : `Updated ${Math.floor(sec / 60)}m ${sec % 60}s ago`;
}

function syncAqLegend() {
  const el = document.getElementById('risk-map-legend-aq');
  if (el) el.style.display = mapLayers.airQuality ? '' : 'none';
}

function initLayersPanel() {
  const btn = document.getElementById('risk-layers-btn');
  const panel = document.getElementById('risk-layers-panel');
  if (!btn || !panel || layersPanelInit) return;
  layersPanelInit = true;

  panel.innerHTML = `
    <div class="risk-layers-head">MAP LAYERS</div>
    ${MAP_LAYER_DEFS.map((def) => `
      <label class="risk-layer-row${def.available ? '' : ' is-unavail'}" data-layer="${def.id}" title="${def.available && def.desc ? escapeHtml(def.desc) : def.available ? '' : escapeHtml(def.unavailableMsg)}">
        <span class="risk-switch"><input type="checkbox" ${mapLayers[def.id] ? 'checked' : ''} ${def.available ? '' : 'disabled'} /></span>
        <span class="risk-layer-name">${escapeHtml(def.label)}</span>
        ${def.available ? '' : '<em class="risk-layer-unavail">N/A</em>'}
      </label>`).join('')}
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleRiskLayersPanel();
  });

  panel.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.onchange = () => {
      const row = cb.closest('.risk-layer-row');
      const id = row ? row.dataset.layer : null;
      if (id) setRiskLayer(id, cb.checked);
    };
  });
}

function syncLayerCheckboxes() {
  const panel = document.getElementById('risk-layers-panel');
  if (!panel) return;
  panel.querySelectorAll('.risk-layer-row').forEach((row) => {
    const id = row.dataset.layer;
    const cb = row.querySelector('input[type=checkbox]');
    if (cb) cb.checked = !!mapLayers[id];
  });
}

function toggleRiskLayersPanel() {
  const panel = document.getElementById('risk-layers-panel');
  const btn = document.getElementById('risk-layers-btn');
  if (!panel) return;
  if (panel.hidden) {
    panel.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    bindLayersOutsideClose();
  } else {
    panel.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
    unbindLayersOutsideClose();
  }
}

function bindLayersOutsideClose() {
  unbindLayersOutsideClose();
  layersDocHandler = (e) => {
    const wrap = document.querySelector('.risk-layers-wrap');
    if (wrap && wrap.contains(e.target)) return;
    const panel = document.getElementById('risk-layers-panel');
    if (panel) panel.hidden = true;
    const btn = document.getElementById('risk-layers-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    unbindLayersOutsideClose();
  };
  document.addEventListener('mousedown', layersDocHandler);
  layersKeyHandler = (e) => {
    if (e.key === 'Escape') {
      const panel = document.getElementById('risk-layers-panel');
      const btn = document.getElementById('risk-layers-btn');
      if (panel) panel.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
      unbindLayersOutsideClose();
    }
  };
  document.addEventListener('keydown', layersKeyHandler);
}

function unbindLayersOutsideClose() {
  if (layersDocHandler) {
    document.removeEventListener('mousedown', layersDocHandler);
    layersDocHandler = null;
  }
  if (layersKeyHandler) {
    document.removeEventListener('keydown', layersKeyHandler);
    layersKeyHandler = null;
  }
}

function setRiskLayer(id, on) {
  const def = MAP_LAYER_DEFS.find((d) => d.id === id);
  if (!def) return;
  if (!def.available) {
    toast(def.unavailableMsg || 'Layer unavailable', 'info');
    syncLayerCheckboxes();
    return;
  }
  mapLayers[id] = on;
  if (id === 'satellite') applySatellite(on);
  else if (id === 'rainRadar') applyRainRadar(on);
  else if (MARKER_LAYER_IDS.includes(id)) {
    renderLayerMarkers();
    syncAqLegend();
  }
}

function renderLayerMarkers() {
  if (!indiaMap) return;
  lastStations.forEach((station) => {
    const marker = mapMarkers[station.id];
    if (!marker) return;
    marker.setIcon(createMarkerIcon(station));
    marker.setPopupContent(buildPopupHtml(station));
  });
}

function applySatellite(on) {
  if (!indiaMap) return;
  if (on) {
    if (!baseTileLayers.satellite) {
      baseTileLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 12,
      });
    }
    baseTileLayers.satellite.addTo(indiaMap);
    indiaMap.removeLayer(baseTileLayers.dark);
    indiaMap.removeLayer(baseTileLayers.darkRef);
  } else {
    if (baseTileLayers.satellite) indiaMap.removeLayer(baseTileLayers.satellite);
    if (baseTileLayers.dark) baseTileLayers.dark.addTo(indiaMap);
    if (baseTileLayers.darkRef) baseTileLayers.darkRef.addTo(indiaMap);
    if (mapLayers.rainRadar && radarLayer && indiaMap.hasLayer(radarLayer)) {
      indiaMap.removeLayer(radarLayer);
      radarLayer.addTo(indiaMap);
    }
  }
}

const RADAR_FREQ = 10;
const RADAR_MAXF = 6;
const RADAR_CACHE_MS = 5 * 60 * 1000;

function getRadarFrame() {
  if (radarCache && Date.now() - radarCache.t < RADAR_CACHE_MS) return Promise.resolve(radarCache);
  return fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then((r) => {
      if (!r.ok) throw new Error('RainViewer ' + r.status);
      return r.json();
    })
    .then((data) => {
      const past = Array.isArray(data && data.radar && data.radar.past) ? data.radar.past : [];
      const host = data.host || '';
      let nowPath = null;
      if (data.radar && Array.isArray(data.radar.nowcast) && data.radar.nowcast.length && data.radar.nowcast[0].path) nowPath = data.radar.nowcast[0].path;
      else if (past.length) nowPath = past[past.length - 1].path;
      radarCache = {
        t: Date.now(),
        host,
        nowPath,
        frames: past.map((f) => ({ time: f.time, path: f.path })),
      };
      return radarCache;
    });
}

function buildRadarLayer(host, frames) {
  if (!host || !frames || !frames.length) return null;
  const now = Date.now();
  const vis = [];
  for (let i = frames.length - 1; i >= 0; i--) {
    const minutesOld = (now - frames[i].time * 1000) / 60000;
    if (minutesOld > RADAR_FREQ * RADAR_MAXF) break;
    if (minutesOld < -1) continue;
    vis.push(frames[i]);
  }
  if (!vis.length) return null;
  const grp = L.layerGroup();
  const latest = vis[vis.length - 1];
  vis.forEach((f) => {
    grp.addLayer(L.tileLayer(`${host}${f.path}/256/{z}/{x}/{y}/2/0_0.png`, {
      opacity: f.time === latest.time ? 0.62 : 0.3,
      attribution: 'Radar &copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
      maxZoom: 10,
    }));
  });
  return grp;
}

function applyRainRadar(on) {
  if (!indiaMap) return;
  if (on) {
    getRadarFrame()
      .then((cache) => {
        if (!mapLayers.rainRadar || !indiaMap) return;
        if (!radarLayer) radarLayer = buildRadarLayer(cache.host, cache.frames);
        if (radarLayer) {
          if (!indiaMap.hasLayer(radarLayer)) radarLayer.addTo(indiaMap);
        } else {
          mapLayers.rainRadar = false;
          syncLayerCheckboxes();
          toast('Rain radar has no current frames right now.', 'info');
        }
      })
      .catch(() => {
        if (!mapLayers.rainRadar) return;
        mapLayers.rainRadar = false;
        syncLayerCheckboxes();
        toast('Rain radar could not be reached. Please try again.', 'info');
      });
  } else if (radarLayer && indiaMap.hasLayer(radarLayer)) {
    indiaMap.removeLayer(radarLayer);
  }
}

function initIndiaMap() {
  const mapContainer = document.getElementById('india-map');
  if (!mapContainer || indiaMap) return;

  injectRiskMapStyles();

  indiaMap = L.map('india-map', {
    center: [22.5, 79.5],
    zoom: 5,
    minZoom: 4,
    maxZoom: 10,
    zoomControl: false,
    attributionControl: true,
    worldCopyJump: true,
    dragging: true,
    scrollWheelZoom: true,
    doubleClickZoom: true,
    touchZoom: true,
    zoomAnimation: false,
  });

  baseTileLayers.dark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 12,
  });
  baseTileLayers.darkRef = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxZoom: 12,
  });
  baseTileLayers.dark.addTo(indiaMap);
  baseTileLayers.darkRef.addTo(indiaMap);

  L.control.zoom({ position: 'bottomright' }).addTo(indiaMap);

  const indiaBounds = L.latLngBounds(L.latLng(6, 68), L.latLng(37.1, 97.5));
  const fitBtn = L.control({ position: 'bottomright' });
  fitBtn.onAdd = () => {
    const btn = L.DomUtil.create('div', 'risk-fit-btn');
    btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i>';
    btn.title = 'Fit to India';
    btn.onclick = () => { if (!pageDisposed && indiaMap) indiaMap.fitBounds(indiaBounds, { padding: [30, 30] }); };
    return btn;
  };
  fitBtn.addTo(indiaMap);

  initLayersPanel();
  syncAqLegend();

  indiaMap.fitBounds(indiaBounds, { padding: [28, 28], animate: false });
  invalidateSizeTimer = setTimeout(() => { if (indiaMap) indiaMap.invalidateSize(); }, 200);
}

async function updateIndiaMap() {
  const mapContainer = document.getElementById('india-map');
  if (!mapContainer || pageDisposed) return;

  if (!indiaMap) {
    initIndiaMap();
  }

  try {
    const stations = await stationApi.list();
    lastStations = stations;
    updateMapStamp(stations);
    const currentIds = new Set(stations.map(s => s.id));

    for (const id of Object.keys(mapMarkers)) {
      if (!currentIds.has(id)) {
        indiaMap.removeLayer(mapMarkers[id]);
        delete mapMarkers[id];
      }
    }

    stations.forEach((station) => {
      if (station.lat == null || station.lon == null) return;

      const icon = createMarkerIcon(station);

      if (mapMarkers[station.id]) {
        mapMarkers[station.id].setLatLng([station.lat, station.lon]);
        mapMarkers[station.id].setIcon(icon);
        mapMarkers[station.id].setPopupContent(buildPopupHtml(station));
      } else {
        const marker = L.marker([station.lat, station.lon], { icon }).addTo(indiaMap);
        marker.bindPopup(buildPopupHtml(station), { closeButton: false, autoClose: true, className: 'risk-popup-wrap', minWidth: 190, maxWidth: 240 });
        marker.on('popupopen', (ev) => {
          const btn = ev.popup.getElement()?.querySelector('[data-pp-detail]');
          if (btn) btn.onclick = (e) => {
            e.stopPropagation();
            indiaMap.closePopup();
            navigate(`station-detail?${encodeURIComponent(btn.dataset.ppDetail)}`);
          };
        });
        mapMarkers[station.id] = marker;
      }
    });
  } catch (e) {
    console.error('Failed to update India map:', e);
  }
}