// Tiny UI helpers: toasts, modals, status colors, formatting, sparkline.

export function toast(message, kind = 'info', ttl = 3500) {
  const host = document.getElementById('toast-host');
  if (!host) return;
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => { node.style.opacity = '0'; setTimeout(() => node.remove(), 200); }, ttl);
}

export function openModal({ title, body, actions, width }) {
  const host = document.getElementById('modal-host');
  if (!host) return;
  host.innerHTML = '';
  const back = document.createElement('div');
  back.className = 'modal-back';
  const modal = document.createElement('div');
  modal.className = 'modal';
  if (width) modal.style.minWidth = width;
  modal.innerHTML = `<header><h2>${escapeHtml(title)}</h2><button class="close">&times;</button></header><div class="body"></div>`;
  const bodyEl = modal.querySelector('.body');
  if (body instanceof Node) bodyEl.appendChild(body); else bodyEl.innerHTML = body || '';
  if (actions) {
    const a = document.createElement('div');
    a.className = 'actions';
    for (const act of actions) {
      const b = document.createElement('button');
      b.className = `btn ${act.kind || 'secondary'}`;
      b.textContent = act.label;
      b.onclick = async () => { try { await act.onClick(b); } catch (e) { console.error(e); } };
      a.appendChild(b);
    }
    modal.appendChild(a);
  }
  const close = () => { host.innerHTML = ''; };
  modal.querySelector('.close').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  back.appendChild(modal);
  host.appendChild(back);
  return { close };
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function statusClass(s) {
  if (!s) return 'gray';
  const v = String(s).toUpperCase();
  if (v === 'UP' || v === 'GREEN' || v === 'HEALTHY' || v === 'ENABLED' || v === 'SUCCESS' || v === 'COMPLETED' || v === 'CONNECTED' || v === 'ACTIVE' || v === 'NOMINAL' || v === 'IMPROVING' || v === 'OK') return 'green';
  if (v === 'DEGRADED' || v === 'YELLOW' || v === 'WARNING' || v === 'STARTING' || v === 'CONNECTING' || v === 'PENDING' || v === 'RUNNING' || v === 'ELEVATED' || v === 'STABLE' || v === 'NORMAL' || v === 'MEDIUM' || v === 'UNVERIFIED' || v === 'CONFIGURED') return 'yellow';
  if (v === 'DOWN' || v === 'RED' || v === 'CRITICAL' || v === 'FAILED' || v === 'DISABLED' || v === 'DISCONNECTED' || v === 'ERROR' || v === 'HIGH' || v === 'DECLINING' || v === 'DEGRADED') return 'red';
  if (v === 'NOT_CONFIGURED' || v === 'NOT_TRAINED' || v === 'IDLE' || v === 'UNKNOWN' || v === 'GRAY' || v === 'DISABLED' || v === 'STANDBY' || v === 'RESOLVED' || v === 'DISMISSED' || v === 'ACKNOWLEDGED' || v === 'OPEN' || v === 'TRIAGED' || v === 'INVESTIGATING' || v === 'CONFIRMED' || v === 'DETECTED') return 'gray';
  return 'gray';
}

export function statusBadge(s) {
  return `<span class="badge ${statusClass(s)}">${escapeHtml((s || 'unknown').toString().toUpperCase())}</span>`;
}

export function formatNumber(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  return Number.isInteger(n) ? n.toString() : n.toFixed(digits);
}

export function formatTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleTimeString(); } catch { return '—'; }
}
export function formatDateTime(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(); } catch { return '—'; }
}
export function ageSeconds(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}
export function freshnessBadge(iso) {
  const age = ageSeconds(iso);
  if (age == null) return '';
  if (age < 30) return `<span class="freshness live">LIVE ${age}s ago</span>`;
  if (age < 180) return `<span class="freshness stale">${age}s ago</span>`;
  return `<span class="freshness dead">STALE ${age}s ago</span>`;
}

export function loadingState(msg = 'Loading…') { return `<div class="state"><div class="spinner"></div><div>${escapeHtml(msg)}</div></div>`; }
export function errorState(msg) { return `<div class="state error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(msg || 'Failed to load')}</div>`; }
export function emptyState(msg = 'No data') { return `<div class="state empty">${escapeHtml(msg)}</div>`; }

export function relativeWindow(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

// ===== V2/V3 Sparkline =====
export function sparkline(points, opts = {}) {
  const color = opts.color || '#60a5fa';
  const w = opts.width || 100;
  const h = opts.height || 28;
  if (!points || !points.length) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>`;
  const values = points.map((p) => (typeof p === 'number' ? p : p.v)).filter((v) => v != null && !Number.isNaN(v));
  if (!values.length) return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"></svg>`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = w / Math.max(1, values.length - 1);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${h - ((v - min) / span) * (h - 4) - 2}`).join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${path}" fill="none" stroke="${color}" stroke-width="1.4" /></svg>`;
}

// ===== V10 Data lineage rendering =====
export function lineageHtml(stages, highlight = null) {
  if (!stages || !stages.length) return '';
  return `<div class="lineage">${stages.map((s) => `<div class="stage ${highlight === s.stage ? 'highlighted' : ''}" title="${escapeHtml(s.detail || '')}">${escapeHtml(s.stage)}</div>`).join('<div class="arrow">→</div>')}</div>`;
}

// ===== V9 Global search box & palette =====
export function globalSearchBox(onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'global-search';
  wrap.innerHTML = `<i class="fa-solid fa-magnifying-glass"></i><input placeholder="Search stations, alerts, anomalies… (Ctrl+K)" />`;
  const input = wrap.querySelector('input');
  let timer = null;
  let dropdown = null;
  input.addEventListener('focus', (e) => { e.stopPropagation(); });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q || q.length < 2) { dropdown?.remove(); dropdown = null; return; }
      try {
        const results = await window.SkyGuardAPI.get('/api/v1/search', { query: { q } });
        renderResults(results);
      } catch (_) { dropdown?.remove(); dropdown = null; }
    }, 250);
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) dropdown?.remove();
  });

  function renderResults(items) {
    dropdown?.remove();
    if (!items.length) return;
    const dd = document.createElement('div');
    dd.className = 'search-results';
    dd.innerHTML = items.slice(0, 12).map((r) => `
      <div class="row" data-href="${escapeHtml(r.href)}">
        <div class="row"><span class="type badge gray">${escapeHtml(r.type)}</span><strong class="t">${escapeHtml(r.title)}</strong></div>
        <div class="s">${escapeHtml(r.subtitle || '')}</div>
      </div>`).join('');
    dd.querySelectorAll('.row[data-href]').forEach((el) => el.onclick = () => {
      window.location.hash = el.dataset.href.replace(/^#/, '');
      input.value = '';
      dd.remove(); dropdown = null;
      onPick?.();
    });
    wrap.appendChild(dd);
    dropdown = dd;
  }
  return wrap;
}

// ===== V9 Command palette =====
export function openCommandPalette(routes) {
  const back = document.createElement('div');
  back.className = 'palette-overlay';
  back.innerHTML = `<div class="palette"><input placeholder="Type a command or search…" autofocus /><div class="list"></div></div>`;
  document.body.appendChild(back);
  const input = back.querySelector('input');
  const list = back.querySelector('.list');
  let selected = 0;
  let items = routes.map((r) => ({ ...r, type: 'route' }));
  let active = items.slice();
  function render() {
    if (!active.length) { list.innerHTML = '<div class="empty">No results.</div>'; return; }
    list.innerHTML = active.map((it, i) => `<div class="item ${i === selected ? 'selected' : ''}" data-id="${escapeHtml(it.id)}"><div class="title">${escapeHtml(it.title)}</div><div class="sub">${escapeHtml(it.sub || it.type)}</div></div>`).join('');
    list.querySelectorAll('.item').forEach((el) => el.onclick = () => { pick(el.dataset.id); });
  }
  function pick(id) {
    const it = items.find((x) => x.id === id);
    if (it) { it.action?.() || (window.location.hash = `#${id}`); back.remove(); }
  }
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase();
    active = items.filter((it) => !q || it.title.toLowerCase().includes(q) || (it.sub || '').toLowerCase().includes(q));
    selected = 0; render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') back.remove();
    else if (e.key === 'ArrowDown') { selected = Math.min(active.length - 1, selected + 1); render(); }
    else if (e.key === 'ArrowUp') { selected = Math.max(0, selected - 1); render(); }
    else if (e.key === 'Enter') pick(active[selected]?.id);
  });
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  render();
  input.focus();
}

// ===== V3 Connection indicator =====
export function connectionStatus(state) {
  if (state === 'connected') return { cls: 'connected', label: 'Connected', dot: 'green' };
  if (state === 'connecting') return { cls: 'connecting', label: 'Connecting…', dot: 'yellow' };
  return { cls: 'disconnected', label: 'Disconnected', dot: 'red' };
}