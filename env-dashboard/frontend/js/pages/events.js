import { eventsApi } from '../api/index.js';
import { escapeHtml, statusBadge, formatDateTime, loadingState, errorState, emptyState, openModal } from '../utils/ui.js';
import { socketMgr } from '../api/socket.js';

const PAGE_SIZE = 50;
let _state = { items: [], total: 0, offset: 0, loading: false, error: null, meta: null };
let _filters = { category: '', severity: '', stationId: '', search: '', after: '', before: '' };
let _timer = null;
let _cleanupFns = [];

export const eventsPage = {
  id: 'events', title: 'Event Timeline', sub: 'Unified operational event stream — sensors, anomalies, alerts, health, providers, maintenance, system.', group: 'Operations', icon: 'fa-solid fa-timeline',
  async render(root) {
    _cleanupFns = [];
    _state = { items: [], total: 0, offset: 0, loading: false, error: null, meta: null };
    _filters = { category: '', severity: '', stationId: '', search: '', after: '', before: '' };

    root.innerHTML = `
      <div class="card" style="margin-bottom:12px;">
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-bottom:10px;">
          <input id="ev-search" class="input" placeholder="Search events…" style="max-width:220px;" />
          <select id="ev-category" class="input" style="max-width:150px;">
            <option value="">All categories</option>
          </select>
          <select id="ev-severity" class="input" style="max-width:130px;">
            <option value="">All severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <select id="ev-station" class="input" style="max-width:160px;">
            <option value="">All stations</option>
          </select>
          <input id="ev-after" class="input" type="datetime-local" style="max-width:180px;" title="From time" />
          <input id="ev-before" class="input" type="datetime-local" style="max-width:180px;" title="Until time" />
          <button class="btn compact secondary" id="ev-clear-filters"><i class="fa-solid fa-xmark"></i> Clear</button>
          <span style="margin-left:auto;"></span>
          <button class="btn compact secondary" id="ev-refresh"><i class="fa-solid fa-rotate"></i> Refresh</button>
          <span style="color:#64748b;font-size:11px;align-self:center;" id="ev-count"></span>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;" id="ev-active-filters"></div>
      </div>
      <div class="card">
        <div id="ev-list">${loadingState('Loading events…')}</div>
        <div id="ev-load-more" style="text-align:center;padding:10px;display:none;">
          <button class="btn secondary" id="ev-load-more-btn">Load more</button>
        </div>
      </div>
    `;

    _wireControls();
    await _loadMeta();
    await _load(true);

    const onTimelineNew = (ev) => _onRealtimeEvent(ev);
    const onEventReplay = (ev) => _onRealtimeEvent(ev);
    _cleanupFns.push(socketMgr.on('timeline:new', onTimelineNew));
    _cleanupFns.push(socketMgr.on('event:replay', onEventReplay));

    _timer = setInterval(() => { if (!_state.loading) _load(false); }, 8000);

    return () => {
      _cleanupFns.forEach((fn) => { try { fn(); } catch (_) {} });
      _cleanupFns = [];
      if (_timer) { clearInterval(_timer); _timer = null; }
    };
  },
};

function _wireControls() {
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const reload = debounce(() => _load(true), 300);

  const searchEl = document.getElementById('ev-search');
  if (searchEl) searchEl.addEventListener('input', () => { _filters.search = searchEl.value.trim(); reload(); });

  const catEl = document.getElementById('ev-category');
  if (catEl) catEl.onchange = () => { _filters.category = catEl.value; _load(true); };

  const sevEl = document.getElementById('ev-severity');
  if (sevEl) sevEl.onchange = () => { _filters.severity = sevEl.value; _load(true); };

  const stEl = document.getElementById('ev-station');
  if (stEl) stEl.onchange = () => { _filters.stationId = stEl.value; _load(true); };

  const afterEl = document.getElementById('ev-after');
  if (afterEl) afterEl.onchange = () => { _filters.after = afterEl.value ? new Date(afterEl.value).toISOString() : ''; _load(true); };

  const beforeEl = document.getElementById('ev-before');
  if (beforeEl) beforeEl.onchange = () => { _filters.before = beforeEl.value ? new Date(beforeEl.value).toISOString() : ''; _load(true); };

  const refreshBtn = document.getElementById('ev-refresh');
  if (refreshBtn) refreshBtn.onclick = () => _load(true);

  const clearBtn = document.getElementById('ev-clear-filters');
  if (clearBtn) clearBtn.onclick = () => {
    _filters = { category: '', severity: '', stationId: '', search: '', after: '', before: '' };
    if (searchEl) searchEl.value = '';
    if (catEl) catEl.value = '';
    if (sevEl) sevEl.value = '';
    if (stEl) stEl.value = '';
    if (afterEl) afterEl.value = '';
    if (beforeEl) beforeEl.value = '';
    _load(true);
  };

  const loadMoreBtn = document.getElementById('ev-load-more-btn');
  if (loadMoreBtn) loadMoreBtn.onclick = () => _loadMore();
}

async function _loadMeta() {
  try {
    const meta = await eventsApi.meta();
    _state.meta = meta;
    const catEl = document.getElementById('ev-category');
    if (catEl && meta.categories) {
      const current = catEl.value;
      catEl.innerHTML = '<option value="">All categories</option>' +
        meta.categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      catEl.value = current;
    }
    const stEl = document.getElementById('ev-station');
    if (stEl && meta.stationIds) {
      const current = stEl.value;
      stEl.innerHTML = '<option value="">All stations</option>' +
        meta.stationIds.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
      stEl.value = current;
    }
  } catch (_) {}
}

async function _load(reset) {
  if (_state.loading) return;
  const host = document.getElementById('ev-list');
  if (!host) return;
  _state.loading = true;
  if (reset) { _state.offset = 0; _state.items = []; }

  try {
    const query = { limit: PAGE_SIZE, offset: _state.offset, sort: 'desc' };
    if (_filters.category) query.category = _filters.category;
    if (_filters.severity) query.severity = _filters.severity;
    if (_filters.stationId) query.stationId = _filters.stationId;
    if (_filters.search) query.search = _filters.search;
    if (_filters.after) query.after = _filters.after;
    if (_filters.before) query.before = _filters.before;

    const result = await eventsApi.list(query);

    if (reset) {
      _state.items = result || [];
    } else {
      const existingIds = new Set(_state.items.map((e) => e.id));
      const newItems = (result || []).filter((e) => !existingIds.has(e.id));
      _state.items = _state.items.concat(newItems);
    }

    _state.total = result.total || _state.items.length;
    _state.offset = _state.items.length;
    _state.error = null;

    _renderList();
    _renderActiveFilters();
    _updateLoadMore();
  } catch (e) {
    _state.error = e.message || 'Failed to load events';
    _renderError();
  } finally {
    _state.loading = false;
  }
}

async function _loadMore() {
  const btn = document.getElementById('ev-load-more-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  await _load(false);
  if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
}

function _onRealtimeEvent(ev) {
  if (!ev || !ev.id) return;
  const existingIdx = _state.items.findIndex((e) => e.id === ev.id);
  if (existingIdx >= 0) {
    _state.items[existingIdx] = ev;
  } else {
    _state.items.unshift(ev);
    if (_state.items.length > 500) _state.items = _state.items.slice(0, 500);
  }
  _state.total = _state.items.length;
  _renderList();
}

function _renderList() {
  const host = document.getElementById('ev-list');
  if (!host) return;
  const countEl = document.getElementById('ev-count');

  const filtered = _applyClientFilters(_state.items);

  if (countEl) countEl.textContent = `${filtered.length} event${filtered.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    if (_state.error) {
      host.innerHTML = errorState(_state.error);
    } else {
      host.innerHTML = emptyState('No events match the current filters.');
    }
    return;
  }

  host.innerHTML = '<div class="event-log" style="max-height:none;">' + filtered.map((e) => {
    const sev = _normSev(e.severity);
    const catBadge = _catBadge(e.category);
    const sevBadge = _sevBadge(sev);
    const time = formatDateTime(e.timestamp);
    const stationInfo = e.station ? ` — ${escapeHtml(e.station)}` : '';
    const summary = e.summary ? `<br/><small class="muted" style="font-size:11px;">${escapeHtml(String(e.summary).slice(0, 200))}</small>` : '';
    return `<div class="event" style="cursor:pointer;padding:8px 0;border-bottom:1px solid #1e293b;display:flex;gap:8px;align-items:flex-start;" data-event-id="${escapeHtml(e.id)}">
      <span class="time" style="color:#64748b;min-width:130px;font-size:11.5px;white-space:nowrap;">${escapeHtml(time)}</span>
      <span style="min-width:70px;">${catBadge}</span>
      <span style="min-width:60px;">${sevBadge}</span>
      <span style="flex:1;font-size:12px;"><strong>${escapeHtml(e.title || e.type || 'Event')}</strong>${stationInfo}${summary}</span>
    </div>`;
  }).join('') + '</div>';

  host.querySelectorAll('.event[data-event-id]').forEach((el) => {
    el.addEventListener('click', () => _openDetail(el.dataset.eventId));
  });
}

function _applyClientFilters(items) {
  return items;
}

function _renderActiveFilters() {
  const host = document.getElementById('ev-active-filters');
  if (!host) return;
  const chips = [];
  if (_filters.category) chips.push(`Category: ${_filters.category}`);
  if (_filters.severity) chips.push(`Severity: ${_filters.severity}`);
  if (_filters.stationId) chips.push(`Station: ${_filters.stationId}`);
  if (_filters.search) chips.push(`Search: "${_filters.search}"`);
  if (_filters.after) chips.push(`From: ${_filters.after.slice(0, 16).replace('T', ' ')}`);
  if (_filters.before) chips.push(`Until: ${_filters.before.slice(0, 16).replace('T', ' ')}`);
  if (!chips.length) { host.innerHTML = ''; return; }
  host.innerHTML = chips.map((c) => `<span class="badge blue" style="font-size:10px;">${escapeHtml(c)}</span>`).join('');
}

function _updateLoadMore() {
  const el = document.getElementById('ev-load-more');
  if (!el) return;
  el.style.display = (_state.total != null && _state.items.length < _state.total) ? 'block' : 'none';
}

function _renderError() {
  const host = document.getElementById('ev-list');
  if (!host) return;
  host.innerHTML = `<div class="state error">
    <i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(_state.error || 'Failed to load')}
    <br/><button class="btn secondary" style="margin-top:10px;" id="ev-retry-btn"><i class="fa-solid fa-rotate"></i> Retry</button>
  </div>`;
  const retryBtn = document.getElementById('ev-retry-btn');
  if (retryBtn) retryBtn.onclick = () => _load(true);
}

async function _openDetail(eventId) {
  const host = document.getElementById('ev-list');
  let ev = _state.items.find((e) => e.id === eventId);
  if (!ev) {
    try { ev = await eventsApi.get(eventId); } catch (_) {}
  }
  if (!ev) return;

  const sev = _normSev(ev.severity);
  const body = document.createElement('div');
  body.innerHTML = _buildDetailHtml(ev, sev);
  openModal({ title: ev.title || ev.type || 'Event Detail', body, width: '600px' });
}

function _buildDetailHtml(ev, sev) {
  const rows = [
    _detailRow('Event ID', `<code style="font-size:11px;">${escapeHtml(ev.id)}</code>`),
    _detailRow('Sequence', ev.seq != null ? String(ev.seq) : '—'),
    _detailRow('Timestamp', escapeHtml(formatDateTime(ev.timestamp))),
    _detailRow('Type', escapeHtml(ev.type || '—')),
    _detailRow('Category', _catBadge(ev.category)),
    _detailRow('Severity', _sevBadge(sev)),
  ];
  if (ev.stationId) rows.push(_detailRow('Station ID', escapeHtml(ev.stationId)));
  if (ev.station) rows.push(_detailRow('Station', escapeHtml(ev.station)));
  rows.push(_detailRow('Title', escapeHtml(ev.title || '—')));
  if (ev.summary) rows.push(_detailRow('Summary', escapeHtml(ev.summary)));
  if (ev.evidence && ev.evidence.length) {
    const evHtml = Array.isArray(ev.evidence)
      ? ev.evidence.map((e) => typeof e === 'string' ? escapeHtml(e) : escapeHtml(JSON.stringify(e))).join('<br/>')
      : escapeHtml(JSON.stringify(ev.evidence));
    rows.push(_detailRow('Evidence', `<span style="font-size:11.5px;">${evHtml}</span>`));
  }
  if (ev.payload && typeof ev.payload === 'object' && Object.keys(ev.payload).length > 0) {
    let payloadStr;
    try { payloadStr = JSON.stringify(ev.payload, null, 2); } catch { payloadStr = String(ev.payload); }
    rows.push(_detailRow('Payload', `<pre style="background:#0b1220;border:1px solid #1e293b;border-radius:6px;padding:8px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;">${escapeHtml(payloadStr)}</pre>`));
  }

  return `<table style="width:100%;font-size:12px;">${rows.join('')}</table>`;
}

function _detailRow(label, value) {
  return `<tr><td style="padding:6px 10px;color:#64748b;white-space:nowrap;vertical-align:top;width:120px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;">${label}</td><td style="padding:6px 10px;border-bottom:1px solid #1e293b;">${value}</td></tr>`;
}

function _normSev(s) {
  return String(s || '').toLowerCase();
}

function _catBadge(cat) {
  const c = String(cat || 'system').toLowerCase();
  const colorMap = {
    reading: 'blue', anomaly: 'yellow', alert: 'red', quality: 'yellow',
    maintenance: 'purple', provider: 'yellow', system: 'gray', station: 'blue',
    environmental: 'green', rag: 'purple', correlation: 'red', ingestion: 'yellow',
    ml: 'purple', agent: 'purple', fleet: 'gray',
  };
  const color = colorMap[c] || 'gray';
  return `<span class="badge ${color}" style="font-size:10px;min-width:60px;justify-content:center;">${escapeHtml(c)}</span>`;
}

function _sevBadge(sev) {
  const s = String(sev || 'info').toLowerCase();
  if (s === 'critical') return '<span class="badge red" style="font-size:10px;min-width:60px;justify-content:center;">CRITICAL</span>';
  if (s === 'high') return '<span class="badge red" style="font-size:10px;min-width:60px;justify-content:center;">HIGH</span>';
  if (s === 'warning') return '<span class="badge yellow" style="font-size:10px;min-width:60px;justify-content:center;">WARNING</span>';
  return '<span class="badge blue" style="font-size:10px;min-width:60px;justify-content:center;">INFO</span>';
}
