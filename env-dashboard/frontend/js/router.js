// Simple hash router. Each route is { id, title, sub, group, render(root), navLabel, icon }.

const routes = new Map();
let currentDispose = null;
let currentRoute = null;
let rendering = false;
let pendingRoute = false;

export function registerRoute(route) { routes.set(route.id, route); }
export function getRoute(id) { return routes.get(id); }
export function current() { return currentRoute; }

export function startRouter(defaultId) {
  const apply = async () => {
    if (rendering) {
      pendingRoute = true;
      return;
    }
    rendering = true;
    try {
      const hash = (location.hash || '').replace(/^#/, '');
      const id = hash.split('?')[0] || defaultId;
      const route = routes.get(id) || routes.get(defaultId);
      if (!route) return;
      if (currentDispose) { try { currentDispose(); } catch {} currentDispose = null; }
      currentRoute = route;
      const root = document.getElementById('page-root');
      const title = document.getElementById('page-title');
      const sub = document.getElementById('page-sub');
      const actions = document.getElementById('page-actions');
      if (title) title.textContent = route.title;
      if (sub) sub.textContent = route.sub || '';
      if (actions) actions.innerHTML = '';
      if (root) root.innerHTML = '';
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.route === route.id));
      try {
        const dispose = await route.render(root, { actionsHost: actions });
        if (typeof dispose === 'function') currentDispose = dispose;
      } catch (e) {
        console.error('route render failed', e);
        if (root) root.innerHTML = `<div class="state error">${e.message || 'Render failed'}</div>`;
      }
    } finally {
      rendering = false;
      if (pendingRoute) {
        pendingRoute = false;
        await apply();
      }
    }
  };
  window.addEventListener('hashchange', apply);
  apply();
}

export function navigate(id) { if (location.hash !== `#${id}`) location.hash = `#${id}`; else window.dispatchEvent(new HashChangeEvent('hashchange')); }

export function renderNav() {
  const nav = document.getElementById('primary-nav');
  if (!nav) return;
  nav.innerHTML = '';
  const byGroup = new Map();
  for (const r of routes.values()) {
    const g = r.group || 'Main';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  for (const [groupName, items] of byGroup) {
    const hdr = document.createElement('div');
    hdr.style.cssText = 'padding:10px 18px 4px;color:#475569;font-size:10px;text-transform:uppercase;letter-spacing:0.08em;';
    hdr.textContent = groupName;
    nav.appendChild(hdr);
    for (const r of items) {
      const el = document.createElement('div');
      el.className = 'nav-item';
      el.dataset.route = r.id;
      el.innerHTML = `<i class="${r.icon || 'fa-solid fa-circle'}"></i><span>${r.title}</span>`;
      el.onclick = () => navigate(r.id);
      nav.appendChild(el);
    }
  }
}
