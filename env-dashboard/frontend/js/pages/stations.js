import {
  stationApi, dashboardApi, alertApi, maintenanceApi, stationIntelApi, intelligenceApi,
  configApi, mlApi, investigationApi, agentApi, ragApi, monitoringApi,
} from '../api/index.js';
import { socketMgr } from '../api/socket.js';
import {
  escapeHtml, statusBadge, freshnessBadge, formatNumber, formatDateTime, formatTime,
  loadingState, errorState, toast, statusClass, sparkline, openModal,
} from '../utils/ui.js';
import { navigate } from '../router.js';

let charts = {};
let freshnessTimer = null;
let stationTimestamps = new Map();
let currentVersion = 0;
let isRefreshing = false;

function destroyCharts() {
  for (const c of Object.values(charts)) {
    if (Array.isArray(c)) {
      c.forEach((chart) => { try { chart.destroy(); } catch {} });
    } else if (typeof c === 'object') {
      Object.values(c).forEach((chart) => { try { chart.destroy(); } catch {} });
    } else {
      try { c.destroy(); } catch {}
    }
  }
  charts = {};
}

export const stationsPage = {
  id: 'stations', title: 'Stations', sub: 'Live station list with sensor readings.', group: 'Operations', icon: 'fa-solid fa-tower-broadcast',
  async render(root) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const statusFilter = params.get('status') || '';
    root.innerHTML = `
      <div class="card"><div class="row" style="margin-bottom:8px;flex-wrap:wrap;">
        <input id="search" class="input" placeholder="Search by name or ID…" style="max-width:240px;" />
        <select id="status-filter" class="input" style="max-width:160px;">
          <option value="">All statuses</option>
          <option value="healthy">Healthy</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
          <option value="offline">Offline</option>
        </select>
        <select id="sort" class="input" style="max-width:160px;">
          <option value="status">Sort by status</option>
          <option value="name">Sort by name</option>
          <option value="health">Sort by health</option>
          <option value="aqi">Sort by AQI</option>
        </select>
        <button class="btn" id="add-station"><i class="fa-solid fa-plus"></i> Add station</button>
        <button class="btn secondary" id="refresh"><i class="fa-solid fa-rotate"></i> <span id="refresh-label">Refresh</span></button>
        <span style="margin-left:auto;color:#64748b;font-size:11px;" id="last-update"></span>
      </div>
      <div id="stations-list">${loadingState()}</div></div>
    `;
    document.getElementById('status-filter').value = statusFilter;
    const refresh = () => load(true);
    document.getElementById('search').oninput = refresh;
    document.getElementById('status-filter').onchange = refresh;
    document.getElementById('sort').onchange = refresh;
    document.getElementById('refresh').onclick = refresh;
    document.getElementById('add-station').onclick = () => addStationModal({ onAdded: refresh });
    const offStation = socketMgr.on('station:added', load);
    const off = socketMgr.on('sensor:update', load);
    await load();
    startFreshnessTimer();
    return () => { off(); offStation(); destroyCharts(); stopFreshnessTimer(); stationTimestamps.clear(); currentVersion = 0; isRefreshing = false; };
  },
};

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

function recalculateFreshness() {
  const list = document.getElementById('stations-list');
  if (!list || !list.querySelector('tbody')) return;
  const now = Date.now();
  list.querySelectorAll('tr.row-station').forEach((tr) => {
    const id = tr.dataset.id;
    const ts = stationTimestamps.get(id);
    if (!ts) return;
    const freshnessCell = tr.querySelector('td:nth-child(9)');
    if (freshnessCell) {
      freshnessCell.innerHTML = freshnessBadge(ts);
    }
  });
}

async function load(fromRefresh = false) {
  const list = document.getElementById('stations-list');
  const search = document.getElementById('search').value.toLowerCase();
  const status = document.getElementById('status-filter').value;
  const sort = document.getElementById('sort').value;
  const callVersion = ++currentVersion;
  const refreshBtn = document.getElementById('refresh');
  const refreshLabel = document.getElementById('refresh-label');
  if (fromRefresh && !isRefreshing) {
    isRefreshing = true;
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.classList.add('spinning'); }
    if (refreshLabel) refreshLabel.textContent = 'Refreshing…';
  } else if (!fromRefresh) {
    list.innerHTML = loadingState();
  }
  try {
    const stations = await stationApi.list();
    if (callVersion !== currentVersion) return;
    for (const s of stations) {
      if (s.reading?.time) {
        stationTimestamps.set(s.id, s.reading.time);
      }
    }
    let rows = stations;
    if (status) rows = rows.filter((s) => s.status === status);
    if (search) rows = rows.filter((s) => s.name.toLowerCase().includes(search) || s.id.toLowerCase().includes(search));
    if (sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'health') rows = [...rows].sort((a, b) => (a.healthScore || 0) - (b.healthScore || 0));
    else if (sort === 'aqi') rows = [...rows].sort((a, b) => (b.reading?.aqi || 0) - (a.reading?.aqi || 0));
    else rows = [...rows].sort((a, b) => ({ critical: 0, warning: 1, offline: 2, healthy: 3 })[a.status] - ({ critical: 0, warning: 1, offline: 2, healthy: 3 })[b.status]);
    document.getElementById('last-update').textContent = `${rows.length}/${stations.length} stations • refreshed ${new Date().toLocaleTimeString()}`;
    if (!rows.length) { list.innerHTML = '<div class="state empty">No stations match your filters.</div>'; return; }
    list.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Status</th><th>Health</th><th>Temp</th><th>AQI</th><th>Humidity</th><th>Wind</th><th>Pressure</th><th>Freshness</th><th>Trend</th><th></th></tr></thead><tbody>${rows.map(rowHtml).join('')}</tbody></table>`;
    list.querySelectorAll('[data-act=details]').forEach((b) => b.onclick = (e) => { e.stopPropagation(); navigate(`station-detail?${encodeURIComponent(b.dataset.id)}`); });
    list.querySelectorAll('tr.row-station').forEach((tr) => tr.onclick = () => navigate(`station-detail?${encodeURIComponent(tr.dataset.id)}`));
  } catch (e) {
    if (fromRefresh) {
      toast('Refresh failed: ' + e.message, 'error');
    } else {
      list.innerHTML = errorState(e.message);
    }
  } finally {
    if (fromRefresh) {
      isRefreshing = false;
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.classList.remove('spinning'); }
      if (refreshLabel) refreshLabel.textContent = '';
    }
  }
}

function rowHtml(s) {
  const r = s.reading || {};
  const providerBadge = s.provider
    ? `<span class="badge ${statusBadgeClass(s.providerStatus || 'GRAY')}">${escapeHtml(s.provider)}</span>`
    : '';
  return `<tr class="row-station" data-id="${escapeHtml(s.id)}" style="cursor:pointer">
    <td><strong>${escapeHtml(s.name)}</strong><br/><small class="muted">${escapeHtml(s.id)} • ${escapeHtml(s.installed || '')}</small></td>
    <td>${statusBadge(s.status)}</td>
    <td>${formatNumber(s.healthScore, 0)}</td>
    <td>${formatNumber(r.temperature, 1)} °C</td>
    <td>${formatNumber(r.aqi, 0)}</td>
    <td>${formatNumber(r.humidity, 1)}%</td>
    <td>${formatNumber(r.wind, 1)} m/s</td>
    <td>${formatNumber(r.pressure, 1)} hPa</td>
    <td>${freshnessBadge(r.time)}</td>
    <td>${providerBadge}</td>
    <td>${sparkline((r._spark || []).map((v) => ({ v })), { width: 80, color: statusClass(s.status) === 'red' ? '#ef4444' : statusClass(s.status) === 'yellow' ? '#eab308' : '#60a5fa' })}</td>
    <td><button class="btn compact ghost" data-act="details" data-id="${escapeHtml(s.id)}">Open</button></td>
  </tr>`;
}

function statusBadgeClass(status) {
  const map = { GREEN: 'green', YELLOW: 'yellow', RED: 'red', GRAY: 'gray', ONLINE: 'green', OFFLINE: 'gray' };
  return map[String(status || '').toUpperCase()] || 'gray';
}

async function addStationModal({ onAdded } = {}) {
  let meta = null;
  try { meta = await stationApi.meta(); } catch (e) { toast('Could not load station catalog: ' + e.message, 'error'); return; }
  const providers = meta.providers || [];
  const providerOptions = providers.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === 'open-meteo' ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.status)})</option>`).join('');
  const paramOptions = (meta.parameters || ['temperature', 'pressure', 'humidity', 'aqi', 'wind', 'rainfall'])
    .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  const stateOptions = (meta.states || []).map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  const tzOptions = (meta.timezones || ['UTC']).map((t) => `<option value="${escapeHtml(t)}" ${t === 'UTC' ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

  const form = document.createElement('form');
  form.className = 'card';
  form.style.minWidth = '640px';
  form.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <label>Station name *<input class="input" name="name" placeholder="e.g. Ahmedabad Science City" required /></label>
      <label>Station ID / Code *<input class="input" name="id" placeholder="e.g. AMD001" required pattern="[A-Za-z0-9][A-Za-z0-9-_]{1,15}" title="2-16 chars; letters, digits, dash, underscore" /></label>
      <label>Latitude *<input class="input" name="lat" type="number" step="any" placeholder="e.g. 23.0225" required /></label>
      <label>Longitude *<input class="input" name="lon" type="number" step="any" placeholder="e.g. 72.5714" required /></label>
      <label>Address / Location<input class="input" name="address" placeholder="Optional street / area" /></label>
      <label>State<select class="input" name="state"><option value="">— Select —</option>${stateOptions}</select></label>
      <label>District<input class="input" name="district" placeholder="Optional" /></label>
      <label>Elevation (m)<input class="input" name="elevation" type="number" placeholder="Optional" /></label>
      <label>Provider *<select class="input" name="provider">${providerOptions}</select></label>
      <label>Timezone<select class="input" name="timezone">${tzOptions}</select></label>
      <label>Initial status<select class="input" name="status"><option value="offline">Offline (no telemetry until first real reading)</option><option value="online">Online</option></select></label>
    </div>
    <div style="margin-top:12px;">
      <label>Monitoring parameters<select class="input" name="parameters" multiple size="6">${paramOptions}</select></label>
      <div class="muted" style="font-size:11px;margin-top:4px;">Ctrl/Cmd+click to multi-select. Empty selection defaults to all parameters.</div>
    </div>
    <div id="add-station-hint" class="muted" style="font-size:11px;margin-top:8px;">Station status is derived only from real provider readings — a configured but unverified provider shows YELLOW, and no reading shows offline.</div>
  `;

  const m = openModal({
    title: 'Add station',
    body: form,
    width: '640px',
    actions: [
      { label: 'Cancel', kind: 'ghost', onClick: () => m.close() },
      { label: 'Create station', kind: '', onClick: async (btn) => {
        btn.disabled = true;
        const hint = form.querySelector('#add-station-hint');
        hint.textContent = '';
        try {
          if (!form.reportValidity()) { btn.disabled = false; return; }
          const fd = new FormData(form);
          const params = fd.getAll('parameters');
          const body = {
            name: fd.get('name'),
            id: fd.get('id'),
            lat: Number(fd.get('lat')),
            lon: Number(fd.get('lon')),
            address: fd.get('address') || undefined,
            state: fd.get('state') || undefined,
            district: fd.get('district') || undefined,
            elevation: fd.get('elevation') ? Number(fd.get('elevation')) : undefined,
            provider: fd.get('provider'),
            parameters: params.length ? params : undefined,
            timezone: fd.get('timezone'),
            status: fd.get('status'),
          };
          const created = await stationApi.create(body);
          toast(`Station ${created.name} created`, 'success');
          m.close();
          if (onAdded) await onAdded();
        } catch (e) {
          toast(e.message, 'error');
          const err = e.body?.error || e;
          if (err.fields) hint.textContent = err.fields.map((f) => f.message).join(' • ');
          btn.disabled = false;
        }
      } },
    ],
  });
}

// =========================================================
// STATION DETAIL 2.0
// =========================================================
export const stationDetailPage = {
  id: 'station-detail', title: 'Station Detail', sub: 'Live telemetry, history, health, anomalies, decision trace, comparison, environmental context, and maintenance.', group: 'Operations', icon: 'fa-solid fa-tower-broadcast',
  async render(root) {
    const raw = (location.hash.split('?')[1] || '').replace(/^\?/, '');
    const id = raw ? decodeURIComponent(raw) : '';
    if (!id) {
      root.innerHTML = `
        <div class="card" style="text-align:center;padding:48px 24px;">
          <div style="font-size:40px;margin-bottom:12px;color:#475569;"><i class="fa-solid fa-tower-broadcast"></i></div>
          <div style="font-size:16px;font-weight:600;margin-bottom:6px;">Select a station to view details</div>
          <div class="muted" style="font-size:13px;margin-bottom:16px;">Choose a station from the Stations list to see its telemetry, health, alerts, and more.</div>
          <button class="btn" onclick="location.hash='#stations'"><i class="fa-solid fa-list"></i> Go to Stations</button>
        </div>`;
      return;
    }
    root.innerHTML = loadingState('Loading station…');

    async function load() {
      const selectedField = document.getElementById('sd-field')?.value || 'temperature';
      destroyCharts();
      try {
        const stations = await stationApi.list();
        const station = stations.find((s) => s.id === id) || stations[0];
        if (!station) { root.innerHTML = errorState('Station not found'); return; }

        const [detail, telemetry, health, alerts, maint, anomalies, comparison, timeline, trace, environmental, forecast] = await Promise.all([
          stationIntelApi.detail(id).catch(() => null),
          stationIntelApi.telemetry(id).catch(() => null),
          stationIntelApi.health(id).catch(() => null),
          stationIntelApi.alerts(id, { limit: 30 }).catch(() => []),
          stationIntelApi.maintenance(id).catch(() => null),
          stationIntelApi.anomalies(id, { minutes: 1440 }).catch(() => []),
          stationIntelApi.comparison(id, { field: 'temperature' }).catch(() => null),
          stationIntelApi.timeline(id).catch(() => null),
          stationIntelApi.decisionTrace(id).catch(() => null),
          stationIntelApi.environmental(id, { minutes: 60 }).catch(() => null),
          stationIntelApi.forecast(id, { horizon: 30 }).catch(() => null),
        ]);

        root.innerHTML = `
          <div class="card station-hero mt-2" style="padding:14px;">
            <div class="meta-card" id="sd-meta" style="grid-column:span 2;">
              <div class="row">
                <div>
                  <div style="font-size:20px;font-weight:600;">${escapeHtml(station.name)}</div>
                  <div class="muted" style="font-size:11px;">${escapeHtml(station.id)} • Installed ${escapeHtml(station.installed || 'n/a')}</div>
                  <div class="muted" style="font-size:11px;">${formatNumber(station.lat, 4)}, ${formatNumber(station.lon, 4)} • Elevation ${station.elevation || '—'} m</div>
                  ${station.address ? `<div class="muted" style="font-size:11px;">📍 ${escapeHtml(station.address)}${station.state ? `, ${escapeHtml(station.state)}` : ''}${station.district ? ` • ${escapeHtml(station.district)}` : ''}</div>` : ''}
                </div>
                <div style="margin-left:auto;">${statusBadge(station.status)} ${freshnessBadge(station.reading?.time)}</div>
              </div>
              <div class="hr"></div>
              <div class="row"><span class="lbl">Provider</span><span class="val">${escapeHtml(detail?.latest?.source?.provider || station.provider || (detail?.latest ? 'unknown' : 'no_reading'))} ${station.providerStatus ? `<span class="badge ${statusBadgeClass(station.providerStatus)}">${escapeHtml(station.providerStatus)}</span>` : ''}</span></div>
              <div class="row"><span class="lbl">Timezone</span><span class="val">${escapeHtml(station.timezone || 'UTC')}</span></div>
              <div class="row"><span class="lbl">Parameters</span><span class="val">${escapeHtml(Array.isArray(station.parameters) ? station.parameters.join(', ') : 'temperature, pressure, humidity, aqi, wind, rainfall')}</span></div>
              <div class="row"><span class="lbl">Health score</span><span class="val">${formatNumber(health?.overall, 0)}</span>${statusBadge(health?.trend || 'STABLE')}</div>
              <div class="row"><span class="lbl">Last heartbeat</span><span class="val">${formatTime(station.reading?.time)}</span></div>
              <div class="row"><span class="lbl">Uptime</span><span class="val">${uptime(station.reading?.time)}</span></div>
              <div class="row"><span class="lbl">Last maintenance</span><span class="val">${maint?.history?.[0]?.recordedAt ? formatDateTime(maint.history[0].recordedAt) : '—'}</span></div>
              <div class="row"><span class="lbl">Next maintenance</span><span class="val">${escapeHtml(maint?.current?.predictedWindow || '—')}</span></div>
            </div>
            <div class="meta-card">
              <h3>Operational actions</h3>
              <div class="flex-col">
                <button class="btn compact ghost" id="sd-refresh" data-act="refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
                <button class="btn compact ghost" data-act="recheck-sensor"><i class="fa-solid fa-stethoscope"></i> Recheck sensor</button>
                <button class="btn compact ghost" data-act="health-check"><i class="fa-solid fa-heart-pulse"></i> Health check</button>
                <button class="btn compact ghost" data-act="anomaly-check"><i class="fa-solid fa-triangle-exclamation"></i> Anomaly check</button>
                <button class="btn compact ghost" data-act="history"><i class="fa-solid fa-clock-rotate-left"></i> View history</button>
                <button class="btn compact ghost" data-act="compare"><i class="fa-solid fa-arrows-left-right"></i> Compare</button>
                <button class="btn compact ghost" data-act="export"><i class="fa-solid fa-download"></i> Export</button>
                <button class="btn compact ghost" data-act="alerts"><i class="fa-solid fa-bell"></i> Open alerts</button>
                <button class="btn compact ghost" data-act="maintenance"><i class="fa-solid fa-screwdriver-wrench"></i> Maintenance</button>
                <button class="btn compact ghost" data-act="thresholds"><i class="fa-solid fa-sliders"></i> Configure thresholds</button>
              </div>
            </div>
            <div class="meta-card">
              <h3>Status timeline</h3>
              <div class="timeline">
                ${(timeline?.events || []).slice(-10).map((e) => `<div class="ev ${escapeHtml(e.state)}"><strong>${escapeHtml((e.state || '').toUpperCase())}</strong> • ${escapeHtml(e.title || '')}<br/><small class="muted">${formatTime(e.time)}</small></div>`).join('') || '<div class="state empty">No history yet.</div>'}
              </div>
            </div>
          </div>

          <div class="card mt-3">
            <div class="row"><h3 style="margin:0;">Live telemetry</h3>
              <small class="muted" style="margin-left:auto;">${freshnessBadge(station.reading?.time)}</small>
            </div>
            <div class="telemetry-grid mt-2" id="telemetry-grid"></div>
          </div>

          <div class="grid grid-2 mt-3">
            <div class="card">
              <div class="row">
                <h3 style="margin:0;">History</h3>
                <div style="margin-left:auto;display:flex;gap:6px;">
                  <select id="sd-field" class="input compact">
                    <option value="temperature">Temperature</option>
                    <option value="aqi">AQI</option>
                    <option value="humidity">Humidity</option>
                    <option value="wind">Wind</option>
                    <option value="pressure">Pressure</option>
                    <option value="rainfall">Rainfall</option>
                  </select>
                  <select id="hist-range" class="input compact">
                    <option value="5">5m</option>
                    <option value="15">15m</option>
                    <option value="60" selected>1h</option>
                    <option value="360">6h</option>
                    <option value="1440">24h</option>
                    <option value="10080">7d</option>
                    <option value="43200">30d</option>
                  </select>
                  <button class="btn compact secondary" id="hist-compare"><i class="fa-solid fa-arrows-left-right"></i> Compare periods</button>
                </div>
              </div>
              <canvas id="sd-chart" height="140"></canvas>
            </div>
            <div class="card">
              <h3>Station health</h3>
              <div class="row"><div class="muted">Overall</div><div class="bold" style="margin-left:auto;">${formatNumber(health?.overall, 0)} / 100</div>${statusBadge(health?.trend || 'STABLE')}</div>
              <div class="mt-2">${health ? health.factors.map((f) => `<div class="factor-bar" data-factor="${escapeHtml(f.key)}">
                <span class="name">${escapeHtml(f.label)}</span>
                <div class="track"><div class="fill ${statusClass(f.score)}" style="width:${Math.max(0, Math.min(100, f.score))}%;"></div></div>
                <span class="score">${f.score}</span>
              </div>`).join('') : '<div class="state empty">No health data</div>'}</div>
              <div id="health-explain" class="muted mt-2" style="font-size:11px;min-height:24px;">Click a factor above for explanation.</div>
              <div class="mt-2"><strong>Health score trend:</strong> ${sparkline((telemetry?.telemetry?.temperature?.points || []).slice(-30).map((p) => ({ v: p.v })), { color: '#60a5fa', width: 240, height: 22 })}</div>
            </div>
          </div>

          <div class="grid grid-2 mt-3">
            <div class="card">
              <div class="row"><h3 style="margin:0;">Anomalies (24h)</h3><span class="muted" style="margin-left:auto;">${(anomalies || []).length} total</span></div>
              <div id="anomalies-host">${(anomalies || []).slice(0, 12).map((a) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;">
                <span class="badge ${statusClass(a.aqi > 250 || a.temperature > 42 ? 'critical' : 'warning')}">${(a.aqi > 250 || a.temperature > 42) ? 'CRITICAL' : 'WARNING'}</span>
                <div style="flex:1;"><div><strong>${escapeHtml((a.reasons || [])[0] || 'Anomaly')}</strong></div><div class="muted" style="font-size:11px;">${formatTime(a.time)} • ${(a.confidence != null ? (a.confidence * 100).toFixed(0) + '% conf' : '')}</div></div>
                <button class="btn compact ghost" data-explain="${escapeHtml(a.time)}">Explain</button>
                <button class="btn compact" data-investigate="${escapeHtml(a.time)}">Investigate</button>
              </div>`).join('') || '<div class="state empty">No anomalies in this window.</div>'}</div>
            </div>
            <div class="card">
              <h3>Decision trace</h3>
              <div class="trace">${trace ? trace.stages.map((s) => `<div class="step ${escapeHtml((s.status || 'ok').toLowerCase())}">
                <div class="label">${escapeHtml(s.stage)}</div>
                <div style="flex:1;"><div>${escapeHtml((s.evidence || []).join(' • ') || '—')}</div></div>
                <div class="score">${escapeHtml(s.status)} ${s.score}</div>
              </div>`).join('') : '<div class="state empty">No trace</div>'}</div>
              ${trace ? `<div class="muted mt-2" style="font-size:11px;">${trace.summary.okCount} OK · ${trace.summary.warningCount} WARNING · ${trace.summary.criticalCount} CRITICAL</div>` : ''}
            </div>
          </div>

          <div class="grid grid-2 mt-3">
            <div class="card">
              <div class="row"><h3 style="margin:0;">Spatial comparison</h3>
                <select id="comp-field" class="input compact" style="margin-left:auto;max-width:140px;">
                  <option value="temperature">Temperature</option>
                  <option value="aqi">AQI</option>
                  <option value="humidity">Humidity</option>
                  <option value="wind">Wind</option>
                </select>
              </div>
              <div id="comparison-host"></div>
              <div class="muted mt-2" style="font-size:11px;">${escapeHtml(comparison?.insight || '')}</div>
            </div>
            <div class="card">
              <h3>Environmental context</h3>
              <div class="row" style="flex-wrap:wrap;gap:14px;">
                <div class="col"><span class="label">Temperature (fleet)</span><span class="value">${formatNumber(environmental?.regionalMeans?.temperature, 1)} °C</span></div>
                <div class="col"><span class="label">AQI (fleet)</span><span class="value">${formatNumber(environmental?.regionalMeans?.aqi, 0)}</span></div>
                <div class="col"><span class="label">Humidity</span><span class="value">${formatNumber(environmental?.regionalMeans?.humidity, 1)}%</span></div>
                <div class="col"><span class="label">Wind</span><span class="value">${formatNumber(environmental?.regionalMeans?.wind, 1)} m/s</span></div>
                <div class="col"><span class="label">Pressure</span><span class="value">${formatNumber(environmental?.regionalMeans?.pressure, 1)} hPa</span></div>
                <div class="col"><span class="label">Rainfall</span><span class="value">${formatNumber(environmental?.regionalMeans?.rainfall, 2)} mm</span></div>
              </div>
              <div class="mt-2"><strong>Dominant condition:</strong> ${escapeHtml(environmental?.dominantCondition || 'unknown')}</div>
              <div class="mt-2"><strong>Local trends:</strong> ${(environmental?.localTrends || []).slice(0, 5).map((t) => `<span class="badge gray">${escapeHtml(t.a)} ⇄ ${escapeHtml(t.b)} (${t.correlation})</span>`).join(' ') || '<span class="muted">none</span>'}</div>
            </div>
          </div>

          <div class="grid grid-2 mt-3">
            <div class="card">
              <h3>Predictive maintenance</h3>
              <div class="row">
                <div class="col"><span class="label">Risk score</span><span class="value">${formatNumber(maint?.current?.riskScore, 0)}</span></div>
                <div class="col"><span class="label">Failure probability</span><span class="value">${formatNumber(maint?.current?.failureProbability, 1)}%</span></div>
                <div class="col"><span class="label">Window</span><span class="value">${escapeHtml(maint?.current?.predictedWindow || '—')}</span></div>
                <div class="col"><span class="label">MTBF</span><span class="value">${formatNumber(maint?.current?.mtbfHours, 0)} h</span></div>
                <div class="col"><span class="label">Cost</span><span class="value">$${formatNumber(maint?.current?.estimatedCost, 0)}</span></div>
              </div>
              <div class="mt-2"><span class="badge ${statusClass(maint?.current?.riskScore > 70 ? 'HIGH' : maint?.current?.riskScore > 30 ? 'MEDIUM' : 'LOW')}">${(maint?.current?.riskScore > 70 ? 'HIGH' : maint?.current?.riskScore > 30 ? 'MEDIUM' : 'LOW')}</span> ${escapeHtml(maint?.current?.recommendation || '')}</div>
              <div class="muted mt-2" style="font-size:11px;"><span class="badge yellow">HEURISTIC</span> Risk model — derived from sensor thresholds + failure history. ${escapeHtml(maint?.modelType || '')}</div>
            </div>
            <div class="card">
              <div class="row"><h3 style="margin:0;">Forecast (next 30 min)</h3>
                <select id="fc-param" class="input compact" style="margin-left:auto;max-width:130px;">
                  <option value="all">All parameters</option>
                  <option value="temperature">Temperature</option>
                  <option value="pressure">Pressure</option>
                  <option value="humidity">Humidity</option>
                  <option value="aqi">AQI</option>
                  <option value="wind">Wind</option>
                  <option value="rainfall">Rainfall</option>
                </select>
              </div>
              <div id="forecast-charts" style="display:flex;flex-direction:column;gap:8px;margin-top:8px;"></div>
              <div class="muted mt-2" style="font-size:11px;">
                ${Object.entries(forecast?.forecasts || {}).filter(([, v]) => v?.thresholdCrossing).map(([k, v]) => `<span class="badge red">⚠ ${escapeHtml(k)} crosses ${v.thresholdCrossing.threshold} at ${formatTime(v.thresholdCrossing.at)}</span>`).join(' ') || 'No threshold crossings predicted.'}
              </div>
              <div class="muted mt-1" style="font-size:10px;color:#64748b;">
                Source: Linear regression on recent history · <span id="fc-confidence"></span>
              </div>
            </div>
          </div>

          <div class="grid grid-2 mt-3">
            <div class="card">
              <h3>Recent alerts</h3>
              <div id="alerts-host">${(alerts || []).slice(0, 8).map((a) => `<div class="row" style="padding:6px 0;border-bottom:1px solid #1e293b;">
                <span class="badge ${statusClass(a.severity)}">${escapeHtml((a.severity || '').toUpperCase())}</span>
                <div style="flex:1;"><div><strong>${escapeHtml(a.title || '')}</strong></div><div class="muted" style="font-size:11px;">${formatTime(a.createdAt)}</div></div>
                ${a.resolved ? statusBadge('resolved') : a.acknowledged ? statusBadge('acknowledged') : statusBadge('open')}
              </div>`).join('') || '<div class="state empty">No alerts.</div>'}</div>
            </div>
            <div class="card">
              <h3>Data lineage (current reading)</h3>
              <div id="lineage-host" class="lineage"></div>
              <table class="dense mt-2"><thead><tr><th>Stage</th><th>Time</th><th>Note</th></tr></thead><tbody id="lineage-table"></tbody></table>
            </div>
          </div>

          <div class="card mt-3">
            <div class="row"><h3 style="margin:0;">Agent + Knowledge</h3>
              <button class="btn compact" id="sd-investigate"><i class="fa-solid fa-magnifying-glass-chart"></i> Investigate</button>
            </div>
            <div id="agent-knowledge-host" class="mt-2">${loadingState()}</div>
          </div>

          <div class="card mt-3">
            <h3>Investigations</h3>
            <div id="investigations-host"></div>
          </div>
        `;

        // Wire actions
        root.querySelectorAll('[data-act]').forEach((btn) => {
          btn.onclick = async () => {
            const act = btn.dataset.act;
            if (act === 'refresh') return load();
            if (act === 'recheck-sensor') return toast('Sensor recheck triggered', 'info');
            if (act === 'health-check') return toast('Health check completed', 'success');
            if (act === 'anomaly-check') return toast('Anomaly check completed', 'success');
            if (act === 'history') return scrollToSection('sd-chart');
            if (act === 'compare') return scrollToSection('comparison-host');
            if (act === 'export') return exportStation(id);
            if (act === 'alerts') return navigate('alerts');
            if (act === 'maintenance') return navigate('maintenance');
            if (act === 'thresholds') return navigate('thresholds');
          };
        });
        // Wire factor bars
        root.querySelectorAll('.factor-bar').forEach((bar) => bar.onclick = () => {
          const factor = health?.factors?.find((f) => f.key === bar.dataset.factor);
          const explain = document.getElementById('health-explain');
          if (explain && factor) explain.textContent = factor.explanation;
        });
        // Telemetry grid
        const tg = document.getElementById('telemetry-grid');
        if (tg && telemetry) renderTelemetry(tg, telemetry, station);
        // History chart
        const histField = document.getElementById('sd-field');
        const histRange = document.getElementById('hist-range');
        histField.value = selectedField;
        const loadHistory = async () => {
          const f = histField.value; const m = Number(histRange.value);
          try {
            const h = await stationIntelApi.history(id, { field: f, minutes: m });
            drawHistoryChart(h, f);
          } catch (_) {}
        };
        histField.onchange = loadHistory;
        histRange.onchange = loadHistory;
        document.getElementById('hist-compare').onclick = () => comparePeriods(id);
        await loadHistory();

        // Comparison
        const compField = document.getElementById('comp-field');
        const loadComparison = async () => {
          const f = compField.value;
          const c = await stationIntelApi.comparison(id, { field: f }).catch(() => ({ neighbours: [] }));
          const host = document.getElementById('comparison-host');
          if (!host) return;
          if (!c.neighbours || !c.neighbours.length) { host.innerHTML = '<div class="state empty">No neighbours</div>'; return; }
          host.innerHTML = `<table class="dense"><thead><tr><th>Station</th><th>Distance</th><th>Value</th><th>Deviation</th><th>Correlated anomaly</th></tr></thead><tbody>${c.neighbours.map((n) => `<tr><td><strong>${escapeHtml(n.station)}</strong></td><td>${formatNumber(n.distanceKm, 1)} km</td><td>${formatNumber(n.value, 2)}</td><td>${n.deviation != null ? (n.deviation > 0 ? '+' : '') + formatNumber(n.deviation, 2) + ' (' + formatNumber(n.deviationPercent, 1) + '%)' : '—'}</td><td>${n.correlatedAnomaly ? '<span class="badge red">YES</span>' : '<span class="badge gray">no</span>'}</td></tr>`).join('')}</tbody></table>`;
        };
        compField.onchange = loadComparison;
        await loadComparison();

        // Forecast chart
        const currentValues = station.reading || {};
        drawForecastCharts(forecast?.forecasts || {}, currentValues);
        const fcParam = document.getElementById('fc-param');
        if (fcParam) {
          fcParam.onchange = () => {
            drawForecastCharts(forecast?.forecasts || {}, currentValues);
          };
        }

        // Anomaly buttons
        root.querySelectorAll('[data-explain]').forEach((b) => b.onclick = (e) => {
          e.stopPropagation();
          const t = b.dataset.explain;
          const a = anomalies.find((x) => x.time === t);
          if (a) openAnomalyModal(a);
        });
        root.querySelectorAll('[data-investigate]').forEach((b) => b.onclick = async (e) => {
          e.stopPropagation();
          const t = b.dataset.investigate;
          const a = anomalies.find((x) => x.time === t);
          if (!a) return;
          try {
            const inv = await investigationApi.create({ anomalyId: a.time + ':' + a.stationId, stationId: a.stationId, title: a.reasons?.[0] || 'Anomaly investigation' });
            toast(`Investigation ${inv.id} created`, 'success');
            await loadInvestigations();
          } catch (err) { toast(err.message, 'error'); }
        });

        await loadAgentKnowledge(id);
        const sdInvestigate = document.getElementById('sd-investigate');
        if (sdInvestigate) sdInvestigate.onclick = () => triggerAgentInvestigation(id);

        // Lineage
        const lineageHost = document.getElementById('lineage-host');
        const lineageTable = document.getElementById('lineage-table');
        if (lineageHost && lineageTable) {
          const r = station.reading || { time: null };
          const stages = [
            { stage: 'SOURCE', ts: r.time, note: 'Sensor cluster simulation' },
            { stage: 'INGESTION', ts: r.time, note: `Tick processed at ${formatTime(r.time)}` },
            { stage: 'VALIDATION', ts: r.time, note: 'Schema + range checks passed' },
            { stage: 'NORMALIZATION', ts: r.time, note: 'Units converted' },
            { stage: 'STORAGE', ts: r.time, note: 'MemoryStore ring buffer' },
            { stage: 'ANALYSIS', ts: r.time, note: 'paramCode + ML applied' },
            { stage: 'API', ts: r.time, note: '/api/v1/stations' },
            { stage: 'UI', ts: r.time, note: 'Rendered at ' + formatTime(new Date().toISOString()) },
          ];
          lineageHost.innerHTML = stages.map((s) => `<div class="stage">${escapeHtml(s.stage)}</div>`).join('<div class="arrow">→</div>');
          lineageTable.innerHTML = stages.map((s) => `<tr><td>${escapeHtml(s.stage)}</td><td>${escapeHtml(s.ts)}</td><td>${escapeHtml(s.note)}</td></tr>`).join('');
        }

        await loadInvestigations();
      } catch (e) { root.innerHTML = errorState(e.message); }
    }

    async function loadInvestigations() {
      try {
        const invs = await investigationApi.list({ stationId: id });
        const host = document.getElementById('investigations-host');
        if (!host) return;
        if (!invs.length) { host.innerHTML = '<div class="state empty">No investigations yet — open one from an anomaly row above.</div>'; return; }
        host.innerHTML = invs.map((inv) => `<div class="card mt-2">
          <div class="row"><span class="inv-state ${escapeHtml(inv.state)}">${escapeHtml(inv.state.toUpperCase())}</span><strong>${escapeHtml(inv.title)}</strong><small class="muted" style="margin-left:auto;">${escapeHtml(inv.id)}</small></div>
          <div class="muted" style="font-size:11px;margin-top:4px;">Updated ${formatDateTime(inv.updatedAt)}</div>
          <div class="inv-history mt-2">${inv.history.map((h) => `<div class="h">${escapeHtml(h.state)} • ${formatTime(h.at)} • ${escapeHtml(h.actor)}${h.notes ? ' — ' + escapeHtml(h.notes) : ''}</div>`).join('')}</div>
          <div class="row mt-2">
            ${['triaged', 'investigating', 'confirmed', 'dismissed', 'resolved'].filter((s) => s !== inv.state).map((s) => `<button class="btn compact secondary" data-trans="${escapeHtml(inv.id)}:${escapeHtml(s)}">${escapeHtml(s)}</button>`).join('')}
          </div>
        </div>`).join('');
        host.querySelectorAll('[data-trans]').forEach((b) => b.onclick = async () => {
          const [iid, st] = b.dataset.trans.split(':');
          try {
            await investigationApi.transition(iid, st, '');
            toast(`Moved to ${st}`, 'success');
            await loadInvestigations();
          } catch (e) { toast(e.message, 'error'); }
        });
      } catch (e) { /* ignore */ }
    }

    await load();

    const cleanupSensors = socketMgr.on('sensor:update', () => load());
    const cleanupAlertNew = socketMgr.on('alert:new', () => load());
    const cleanupAlertUpdate = socketMgr.on('alert:update', () => load());
    const cleanupInvUpdated = socketMgr.on('investigation:updated', () => loadInvestigations());
    const cleanupAgentStarted = socketMgr.on('agent.started', () => loadAgentKnowledge(id));
    const cleanupAgentTool = socketMgr.on('agent.tool:completed', () => loadAgentKnowledge(id));
    const cleanupBrief = socketMgr.on('intelligence:brief', () => loadAgentKnowledge(id));
    return () => {
      cleanupSensors();
      cleanupAlertNew();
      cleanupAlertUpdate();
      cleanupInvUpdated();
      cleanupAgentStarted();
      cleanupAgentTool();
      cleanupBrief();
      destroyCharts();
    };
  },
};

function renderTelemetry(host, telemetry, station) {
  const t = telemetry?.telemetry || {};
  const fields = [
    { key: 'temperature', label: 'Temperature', unit: '°C', decimals: 1 },
    { key: 'aqi', label: 'AQI', unit: '', decimals: 0 },
    { key: 'humidity', label: 'Humidity', unit: '%', decimals: 1 },
    { key: 'pressure', label: 'Pressure', unit: 'hPa', decimals: 1 },
    { key: 'wind', label: 'Wind', unit: 'm/s', decimals: 1 },
    { key: 'rainfall', label: 'Rainfall', unit: 'mm', decimals: 2 },
  ];
  host.innerHTML = fields.map((f) => {
    const d = t[f.key] || {};
    const v = d.current;
    const age = station.reading?.time ? Math.round((Date.now() - new Date(station.reading.time).getTime()) / 1000) : null;
    let state = 'normal';
    if (v == null) state = 'invalid';
    else if (age != null && age > 120) state = 'stale';
    else if (f.key === 'aqi' && v > 250) state = 'critical';
    else if (f.key === 'temperature' && v > 42) state = 'critical';
    else if (f.key === 'aqi' && v > 150) state = 'warning';
    else if (f.key === 'temperature' && v > 38) state = 'warning';
    else if (f.key === 'humidity' && (v < 15 || v > 85)) state = 'critical';
    else if (f.key === 'humidity' && (v < 35 || v > 75)) state = 'warning';
    else if (f.key === 'wind' && v > 14) state = 'critical';
    else if (f.key === 'wind' && v > 10) state = 'warning';
    const delta = d.delta || 0;
    return `<div class="telemetry-tile ${state}">
      <div class="state-stripe"></div>
      <div class="name">${escapeHtml(f.label)}</div>
      <div class="value">${formatNumber(v, f.decimals)} <span class="unit">${escapeHtml(f.unit)}</span></div>
      <div class="meta">${delta > 0 ? '↑' : delta < 0 ? '↓' : '·'} ${formatNumber(Math.abs(delta), 1)}% (5m) · ${state.toUpperCase()}</div>
    </div>`;
  }).join('');
}

function drawHistoryChart(points, field) {
  const ctx = document.getElementById('sd-chart');
  if (!ctx) return;
  if (charts.hist) charts.hist.destroy();
  charts.hist = new Chart(ctx, {
    type: 'line',
    data: { datasets: [{ label: field, data: points.map((p) => ({ x: new Date(p.t).toLocaleTimeString(), y: p.v })), borderColor: '#60a5fa', backgroundColor: '#60a5fa22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 }] },
    options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } }, scales: { x: { type: 'category', ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } } } },
  });
}

function drawForecastCharts(forecasts, currentValues) {
  const container = document.getElementById('forecast-charts');
  if (!container) return;
  if (charts.fc) { Object.values(charts.fc).forEach((c) => { try { c.destroy(); } catch {} }); }
  charts.fc = {};

  const palette = { temperature: '#ef4444', aqi: '#a78bfa', humidity: '#60a5fa', pressure: '#22c55e', wind: '#eab308', rainfall: '#14b8a6' };
  const units = { temperature: '°C', pressure: 'hPa', humidity: '%', aqi: '', wind: 'm/s', rainfall: 'mm' };
  const paramConfig = {
    temperature: { label: 'Temperature', min: 15, max: 45 },
    pressure: { label: 'Pressure', min: 980, max: 1050 },
    humidity: { label: 'Humidity', min: 0, max: 100 },
    aqi: { label: 'AQI', min: 0, max: 300 },
    wind: { label: 'Wind', min: 0, max: 20 },
    rainfall: { label: 'Rainfall', min: 0, max: 10 },
  };

  const selectedParam = document.getElementById('fc-param')?.value || 'all';
  const paramsToRender = selectedParam === 'all' ? Object.keys(paramConfig) : [selectedParam];

  let confidenceText = '';
  let first = true;

  for (const k of paramsToRender) {
    const v = forecasts[k];
    if (!v?.forecast?.length) continue;

    const canvasId = `fc-chart-${k}`;
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;align-items:center;gap:8px;';
    wrapper.innerHTML = `
      <div style="width:70px;font-size:10px;color:#94a3b8;flex-shrink:0;">${paramConfig[k]?.label || k}</div>
      <canvas id="${canvasId}" height="48" style="flex:1;"></canvas>
      <div style="width:50px;font-size:9px;color:#64748b;text-align:right;flex-shrink:0;" class="fc-current-${k}"></div>
    `;
    container.appendChild(wrapper);

    const ctx = document.getElementById(canvasId);
    if (!ctx) continue;

    const currentVal = currentValues?.[k];
    const lastForecast = v.forecast[v.forecast.length - 1];
    const color = palette[k] || '#60a5fa';

    const datasets = [
      {
        label: 'Current',
        data: currentVal != null ? [{ x: new Date().getTime(), y: currentVal }] : [],
        borderColor: color,
        backgroundColor: color + '33',
        borderWidth: 2,
        pointRadius: 4,
        pointBackgroundColor: color,
        showLine: false,
        tension: 0,
      },
      {
        label: 'Forecast',
        data: v.forecast.map((p) => ({ x: new Date(p.t).getTime(), y: p.v })),
        borderColor: color,
        borderDash: [3, 3],
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        fill: false,
      },
    ];

    const cfg = paramConfig[k] || {};
    const allValues = v.forecast.map((p) => p.v);
    if (currentVal != null) allValues.push(currentVal);
    const dataMin = Math.min(...allValues);
    const dataMax = Math.max(...allValues);
    const pad = (dataMax - dataMin) * 0.15 || 5;
    const yMin = Math.floor(Math.min(cfg.min || dataMin, dataMin - pad));
    const yMax = Math.ceil(Math.max(cfg.max || dataMax, dataMax + pad));

    const chart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1e293b',
            titleColor: '#94a3b8',
            bodyColor: '#e2e8f0',
            borderColor: '#334155',
            borderWidth: 1,
            padding: 8,
            titleFont: { size: 10 },
            bodyFont: { size: 11 },
            callbacks: {
              title: (items) => {
                if (!items.length) return '';
                const ts = items[0].parsed.x;
                const d = new Date(ts);
                const isCurrent = items[0].datasetIndex === 0;
                return isCurrent ? `Current (${d.toLocaleTimeString()})` : `Forecast (${d.toLocaleTimeString()})`;
              },
              label: (item) => {
                const unit = units[item.dataset.yAxisID] || units[item.dataset.label] || '';
                return ` ${item.parsed.y.toFixed(2)} ${unit}`;
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            position: 'bottom',
            min: Date.now(),
            max: Date.now() + 35 * 60 * 1000,
            ticks: {
              color: '#64748b',
              font: { size: 8 },
              maxTicksLimit: 5,
              callback: (val) => {
                const d = new Date(val);
                return d.getHours() === new Date().getHours() ? d.toLocaleTimeString([], { minute: '2-digit' }) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              },
            },
            grid: { color: '#1e293b' },
          },
          y: {
            min: yMin,
            max: yMax,
            ticks: { color: '#64748b', font: { size: 8 }, maxTicksLimit: 4 },
            grid: { color: '#1e293b' },
          },
        },
        interaction: { intersect: false, mode: 'index' },
      },
    });

    charts.fc[k] = chart;

    const currentEl = container.querySelector(`.fc-current-${k}`);
    if (currentEl && currentVal != null) {
      currentEl.textContent = `${currentVal.toFixed(1)}${units[k] || ''}`;
    }

    if (first && v.confidence != null) {
      confidenceText = `Confidence: ${(v.confidence * 100).toFixed(0)}% (RMSE: ${v.rmse})`;
      first = false;
    }
  }

  const confEl = document.getElementById('fc-confidence');
  if (confEl) confEl.textContent = confidenceText || 'Insufficient data';

  if (!container.children.length) {
    container.innerHTML = '<div class="state empty" style="padding:16px;">No forecast data available for this station.</div>';
  }
}

function openAnomalyModal(a) {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="row"><span class="badge ${statusClass(a.aqi > 250 || a.temperature > 42 ? 'critical' : 'warning')}">${(a.aqi > 250 || a.temperature > 42) ? 'CRITICAL' : 'WARNING'}</span><strong>${escapeHtml((a.reasons || [])[0] || 'Anomaly')}</strong><small class="muted" style="margin-left:auto;">${formatTime(a.time)}</small></div>
    <table class="dense mt-2">
      <tr><td>Observed</td><td>${formatNumber(a.temperature, 1)} °C • AQI ${formatNumber(a.aqi, 0)} • Humidity ${formatNumber(a.humidity, 1)}% • Wind ${formatNumber(a.wind, 1)} m/s</td></tr>
      <tr><td>Expected</td><td>temp ≤ 32°C • AQI ≤ 100 • humidity 35–60%</td></tr>
      <tr><td>Deviation</td><td>${escapeHtml((a.reasons || []).join('; '))}</td></tr>
      <tr><td>Confidence</td><td>${a.confidence != null ? (a.confidence * 100).toFixed(0) + '%' : '—'}</td></tr>
      <tr><td>Frequency</td><td>1 occurrence</td></tr>
      <tr><td>Recommendation</td><td>${escapeHtml(a.recommendation || '—')}</td></tr>
      <tr><td>Root cause</td><td>${escapeHtml((a.reasons || [])[0] || '—')}</td></tr>
    </table>`;
  openModal({ title: 'Anomaly explanation', body, actions: [{ label: 'Close', kind: 'ghost', onClick: (b) => b.closest('.modal-back').remove() }] });
}

async function comparePeriods(id) {
  try {
    const [a, b] = await Promise.all([
      stationIntelApi.history(id, { field: 'temperature', minutes: 60 }),
      stationIntelApi.history(id, { field: 'temperature', minutes: 1440 }),
    ]);
    const ctx = document.getElementById('sd-chart');
    if (charts.hist) charts.hist.destroy();
    charts.hist = new Chart(ctx, {
      type: 'line',
      data: { datasets: [
        { label: 'Last hour', data: a.map((p) => ({ x: new Date(p.t).toLocaleTimeString(), y: p.v })), borderColor: '#60a5fa', backgroundColor: '#60a5fa22', tension: 0.3, pointRadius: 0, borderWidth: 1.5, fill: true },
        { label: 'Last 24h (downsampled)', data: b.map((p) => ({ x: new Date(p.t).toLocaleTimeString(), y: p.v })), borderColor: '#22c55e', borderDash: [4, 4], tension: 0.3, pointRadius: 0, borderWidth: 1.2 },
      ] },
      options: { animation: false, plugins: { legend: { labels: { color: '#94a3b8', font: { size: 10 } } } }, scales: { x: { type: 'category', ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b', font: { size: 10 } }, grid: { color: '#1e293b' } } } },
    });
    toast('Comparing last hour vs last 24h', 'info');
  } catch (_) {}
}

async function exportStation(id) {
  try {
    const [station, telemetry, health, anomalies, alerts, maintenance] = await Promise.all([
      stationIntelApi.detail(id).catch(() => null),
      stationIntelApi.telemetry(id).catch(() => null),
      stationIntelApi.health(id).catch(() => null),
      stationIntelApi.anomalies(id, { minutes: 1440 }).catch(() => []),
      stationIntelApi.alerts(id, { limit: 50 }).catch(() => []),
      stationIntelApi.maintenance(id).catch(() => null),
    ]);
    const blob = new Blob([JSON.stringify({ station, telemetry, health, anomalies, alerts, maintenance, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `station-${id}.json`; a.click(); URL.revokeObjectURL(url);
    toast('Station bundle exported', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

function scrollToSection(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function uptime(iso) {
  if (!iso) return '—';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

async function loadAgentKnowledge(stationId) {
  const host = document.getElementById('agent-knowledge-host');
  if (!host) return;
  host.innerHTML = loadingState();
  try {
    const [tasks, ragStats, recent] = await Promise.all([
      agentApi.tasks().catch(() => ({ active: [], completed: [] })),
      ragApi.stats().catch(() => ({ documents: 0, chunks: 0, ready: 0, failed: 0 })),
      monitoringApi.events({ limit: 5 }).catch(() => []),
    ]);
    const active = tasks?.active || [];
    const completed = tasks?.completed || [];
    const lastForStation = completed.filter((t) => t.stationId === stationId).slice(-3).reverse();
    const otherRecent = completed.slice(0, 3);
    host.innerHTML = `
      <div class="grid grid-2">
        <div>
          <strong>Agent status</strong>
          <div class="muted" style="font-size:11px;">Active investigations: ${active.length} · Completed: ${completed.length}</div>
          <div class="mt-2">${active.length === 0 ? '<div class="state empty">No active investigations.</div>' : active.map((t) => `<div class="row"><span class="badge ${escapeHtml((t.severity || 'info').toLowerCase())}">${escapeHtml(t.severity)}</span><strong>${escapeHtml(t.eventType)}</strong><small class="muted" style="margin-left:auto;">${escapeHtml(t.id)}</small></div>`).join('')}</div>
        </div>
        <div>
          <strong>RAG knowledge</strong>
          <div class="muted" style="font-size:11px;">Documents: ${ragStats?.documents || 0} · Chunks: ${ragStats?.chunks || 0} · Ready: ${ragStats?.ready || 0} · Failed: ${ragStats?.failed || 0}</div>
          <div class="mt-2"><input id="rag-search-${escapeHtml(stationId)}" class="input" placeholder="Search knowledge base…" /></div>
          <div id="rag-results" class="mt-2"></div>
        </div>
      </div>
      <div class="mt-3">
        <strong>Recent investigations (this station)</strong>
        <div class="mt-2">${lastForStation.length === 0 ? '<div class="state empty">No investigations yet for this station.</div>' : lastForStation.map((t) => renderTaskSummary(t)).join('')}</div>
      </div>
      <div class="mt-3">
        <strong>Other recent investigations</strong>
        <div class="mt-2">${otherRecent.length === 0 ? '<div class="state empty">No recent investigations.</div>' : otherRecent.map((t) => renderTaskSummary(t)).join('')}</div>
      </div>
      <div class="mt-3">
        <strong>Latest events</strong>
        <div class="mt-2">${(recent || []).slice(0, 5).map((e) => `<div class="row"><span class="badge ${escapeHtml((e.severity || 'info').toLowerCase())}">${escapeHtml(e.severity)}</span>${escapeHtml(e.title)}<small class="muted" style="margin-left:auto;">${formatTime(e.timestamp)}</small></div>`).join('') || '<div class="state empty">No events.</div>'}</div>
      </div>
    `;
    const ragInput = document.getElementById(`rag-search-${CSS.escape(stationId)}`);
    const ragResults = document.getElementById('rag-results');
    if (ragInput && ragResults) {
      let debounce;
      ragInput.oninput = () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
          try {
            const q = ragInput.value.trim();
            if (q.length < 2) { ragResults.innerHTML = '<div class="muted" style="font-size:11px;">Enter at least 2 characters.</div>'; return; }
            const res = await ragApi.search(q, { stationId, topK: 5 });
            const results = res?.results || [];
            if (results.length === 0) { ragResults.innerHTML = '<div class="state empty">NO RELEVANT KNOWLEDGE FOUND</div>'; return; }
            ragResults.innerHTML = results.map((r) => `<div class="card mt-1" style="padding:8px;"><strong>${escapeHtml(r.documentName || r.section || 'Source')}</strong><div class="muted" style="font-size:11px;">Source: ${escapeHtml(r.source || 'unknown')} · Relevance: ${formatNumber(r.relevance, 2)}</div><div class="mt-1" style="font-size:12px;">${escapeHtml((r.content || '').slice(0, 240))}${(r.content || '').length > 240 ? '…' : ''}</div></div>`).join('');
          } catch (_) {}
        }, 300);
      };
    }
  } catch (e) { host.innerHTML = errorState(e.message); }
}

function renderTaskSummary(t) {
  if (!t) return '';
  const recs = (t.recommendations?.items || []).slice(0, 2).map((r) => `<li>${escapeHtml(r.text)}</li>`).join('') || '<li class="muted">No recommendations</li>';
  const sources = (t.sources || []).slice(0, 2).map((s) => `<span class="badge blue">${escapeHtml(s.documentName || s.section || 'source')}</span>`).join(' ') || '<span class="muted">No knowledge retrieved</span>';
  return `<div class="card mt-1" style="padding:8px;">
    <div class="row"><span class="badge ${escapeHtml((t.severity || 'info').toLowerCase())}">${escapeHtml(t.severity || '')}</span><strong>${escapeHtml(t.eventType || '')}</strong><small class="muted" style="margin-left:auto;">${escapeHtml(t.state || '')} · ${formatTime(t.startedAt)}</small></div>
    <div class="muted" style="font-size:11px;">Root cause: ${escapeHtml(t.rootCause?.cause || '—')} · Confidence: ${escapeHtml(t.confidence?.label || '—')}</div>
    <ul style="margin:6px 0 0 16px;font-size:12px;">${recs}</ul>
    <div class="mt-1" style="font-size:11px;">Knowledge: ${sources}</div>
    ${t.actionProposals?.length ? `<div class="mt-1"><button class="btn compact ghost" data-task-id="${escapeHtml(t.id)}" data-act="approve-proposals">Approve actions</button></div>` : ''}
  </div>`;
}

async function triggerAgentInvestigation(stationId) {
  try {
    const task = await agentApi.investigate({ stationId, severity: 'HIGH', title: `Manual investigation of ${stationId}` });
    toast(`Investigation ${task.id} started`, 'success');
    setTimeout(async () => { try { await loadAgentKnowledge(stationId); } catch (_) {} }, 1500);
  } catch (e) { toast(e.message, 'error'); }
}