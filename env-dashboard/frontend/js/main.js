import { apiClient } from './api/client.js';
import { socketMgr } from './api/socket.js';
import { initAuth, requireAuth } from './auth.js';
import { registerRoute, startRouter, renderNav, navigate } from './router.js';
import { toast, globalSearchBox, openCommandPalette } from './utils/ui.js';

import { dashboardPage } from './pages/dashboard.js';
import { stationsPage, stationDetailPage } from './pages/stations.js';
import { alertsPage } from './pages/alerts.js';
import { providersPage } from './pages/providers.js';
import { configPage } from './pages/config.js';
import { anomaliesPage } from './pages/anomalies.js';
import { healthPage } from './pages/health.js';
import { maintenancePage } from './pages/maintenance.js';
import { reportsPage } from './pages/reports.js';
import { qualityPage } from './pages/quality.js';
import { architecturePage } from './pages/architecture.js';
import { mlPage } from './pages/ml.js';
import { assistantPage } from './pages/assistant.js';
import { auditPage } from './pages/audit.js';
import { thresholdsPage } from './pages/thresholds.js';
import { notificationsPage } from './pages/notifications.js';
import { eventsPage } from './pages/events.js';
import { investigationsPage } from './pages/investigations.js';
import { advancedAnalyticsPage } from './pages/advancedAnalytics.js';

[
  dashboardPage, stationsPage, stationDetailPage, anomaliesPage, alertsPage, healthPage, maintenancePage, providersPage, reportsPage, qualityPage,
  architecturePage, mlPage, assistantPage, configPage, thresholdsPage, notificationsPage, auditPage,
  eventsPage, investigationsPage, advancedAnalyticsPage,
].forEach(registerRoute);

function setUserChip() {
  const u = apiClient.getUser();
  const chip = document.getElementById('user-chip');
  if (chip && u) chip.textContent = `${u.username} (${u.role})`;
}

function wireGlobalFeatures() {
  // Global search box mounted in page actions
  const actions = document.getElementById('page-actions');
  if (actions) {
    const search = globalSearchBox();
    actions.insertBefore(search, actions.firstChild);
  }
  // Ctrl/Cmd + K → command palette
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      const routes = [...document.querySelectorAll('.nav-item')].map((el) => ({ id: el.dataset.route, title: el.textContent.trim(), sub: 'Navigate' }));
      openCommandPalette(routes);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '/')) {
      e.preventDefault();
      const el = document.querySelector('.global-search input');
      if (el) el.focus();
    }
  });
}

let chartReady;
function loadChart() {
  if (chartReady) return chartReady;
  chartReady = new Promise((resolve) => {
    if (window.Chart) return resolve();
    const script = document.createElement('script');
    script.src = '/js/chart.umd.js';
    script.onload = resolve;
    script.onerror = resolve;
    document.head.appendChild(script);
  });
  return chartReady;
}

async function showApp() {
  await loadChart();
  document.getElementById('login-screen').hidden = true;
  document.getElementById('main-app').hidden = false;
  setUserChip();
  renderNav();
  startRouter('dashboard');
  socketMgr.connect();
  wireGlobalFeatures();
  window.addEventListener('skyguard:connection', (e) => {
    const el = document.getElementById('conn-state');
    if (!el) return;
    el.classList.remove('connected', 'connecting');
    if (e.detail === 'connected') { el.classList.add('connected'); el.querySelector('.lbl').textContent = 'Connected'; }
    else if (e.detail === 'connecting') { el.classList.add('connecting'); el.querySelector('.lbl').textContent = 'Connecting…'; }
    else { el.querySelector('.lbl').textContent = 'Disconnected'; }
  });
}

window.addEventListener('skyguard:unauthorized', () => { toast('Session expired — please sign in again', 'error'); showLogin(); });
window.addEventListener('skyguard:logout', showLogin);
window.addEventListener('skyguard:login', () => { showApp(); });

function showLogin() {
  document.getElementById('main-app').hidden = true;
  document.getElementById('login-screen').hidden = false;
  socketMgr.disconnect();
}

initAuth();

// DEMO LOGIN BYPASS — LOCAL ONLY
// For demo purposes, skip login and directly show dashboard.
// Triggers when served on localhost:4000 (backend serves SPA) or
// localhost:8080 (separate static server), as long as no valid token exists.
const isLocalDemo = window.location.hostname === 'localhost' && (window.location.port === '4000' || window.location.port === '8080');
if (isLocalDemo && !apiClient.isAuthed()) {
  showApp();
} else if (apiClient.isAuthed()) {
  showApp();
} else {
  showLogin();
}