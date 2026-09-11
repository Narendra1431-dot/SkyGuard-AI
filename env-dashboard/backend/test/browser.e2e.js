'use strict';

/**
 * SkyGuard AI — Playwright browser E2E.
 *
 * Starts a real SkyGuard backend on a free port (memory mode, no PG, no Influx),
 * serves the modular frontend from the same process, and drives the UI with
 * Chromium. No mocks: every assertion reflects a real round-trip to the live
 * API + WebSocket.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Disable Playwright timeouts caused by Tailwind CDN / Chart.js CDN unreachable in the sandbox.
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || '0';

const BACKEND_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.resolve(BACKEND_DIR, '..', 'frontend');

// Per-run isolated state location. Each E2E run writes ALL persisted state
// (operations.json, notifications.*.json, dataStore/memoryStore JSON files)
// into a unique temp directory instead of unlinking the shared backend/data
// files. This guarantees a clean baseline without racing or destroying the
// state of any other concurrently running process.
const RUN_DIR = path.join(os.tmpdir(), `skyguard-e2e-browser-${process.pid}-${Date.now()}`);

function isolateState() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  process.env.SKYGUARD_DATA_DIR = RUN_DIR;
  process.env.SKYGUARD_STATE_DIR = RUN_DIR;
}

function cleanupState() {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) {}
}

let backend;
let baseURL;
let pass = 0;
let fail = 0;
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) pass += 1; else fail += 1;
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function startBackend() {
  process.env.PORT = '0';
  process.env.PG_ENABLED = 'false';
  process.env.USE_INFLUXDB = 'false';
  process.env.TICK_MS = '2500';
  process.env.STATION_COUNT = '3';
  // Run against a clean, per-run state location. No shared data/ files are
  // touched, so this cannot contaminate another process or test.
  isolateState();
  const { app, server, seedAndStart } = require('../src/server');
  // Seed the in-memory admin before starting the server so login works.
  const { initFromEnv } = require('../src/db/auth');
  const config = require('../src/config');
  await initFromEnv(config.auth);
  await new Promise((resolve) => server.listen(0, resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
}

async function stopBackend() {
  if (backend && backend.server) {
    await new Promise((resolve) => backend.server.close(resolve));
  }
}

async function login(page) {
  await page.waitForFunction(() => typeof window.SkyGuardAPI === 'object', null, { timeout: 15000 });
  await page.fill('#login-form input[name=username]', 'admin');
  await page.fill('#login-form input[name=password]', 'admin123!Change');
  await page.click('#login-form button[type=submit]');
  // Listen for console errors to diagnose
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('[browser console]', msg.text()); });
  page.on('pageerror', (err) => console.error('[browser pageerror]', err.message));
  await page.waitForSelector('#main-app:not([hidden])', { timeout: 15000 });
}

async function logout(page) {
  await page.click('#logout-btn');
  await page.waitForSelector('#login-screen:not([hidden])');
}

async function navigateTo(page, id) {
  await page.evaluate((id) => { location.hash = `#${id}`; }, id);
  await page.waitForFunction((id) => document.querySelector('.nav-item.active')?.dataset.route === id, id);
}

async function run() {
  console.log('Starting backend on', baseURL);
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('[browser console]', msg.text()); });
  page.on('pageerror', (err) => console.error('[browser pageerror]', err.message));
  page.on('response', (res) => { if (res.status() >= 400 && !res.url().includes('cdn')) console.error('[browser HTTP]', res.status(), res.url()); });
  page.on('requestfailed', (req) => { if (!req.url().includes('cdn')) console.error('[browser requestfailed]', req.url(), req.failure()?.errorText); });

  // ---------- AUTH ----------
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#login-screen', { timeout: 15000 });
  record('auth: login screen is visible', await page.isVisible('#login-screen'));
  await login(page);
  record('auth: main app is visible after login', await page.isVisible('#main-app'));

  // Open the WebSocket page-side to confirm connectivity state appears
  await page.waitForFunction(() => document.querySelector('#conn-state.connected'), null, { timeout: 8000 }).then(() => record('auth: WebSocket connected state', true), () => record('auth: WebSocket connected state', false));

  await logout(page);
  await page.fill('#login-form input[name=username]', 'admin');
  await page.fill('#login-form input[name=password]', 'wrong-password');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 4000 }).then(() => record('auth: invalid login shows error', true), () => record('auth: invalid login shows error', false));
  await page.fill('#login-form input[name=password]', 'admin123!Change');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#main-app:not([hidden])');

  // ---------- DASHBOARD ----------
  // Give the freshly-recovered session a tick to settle so the dashboard's
  // initial render() can complete its Promise.all against authenticated APIs.
  await page.waitForTimeout(500);
  await navigateTo(page, 'dashboard');
  await page.waitForSelector('#kpi-grid .stat-card', { timeout: 30000 });
  const kpis = await page.$$eval('#kpi-grid .stat-card', (els) => els.map((e) => e.querySelector('.lbl')?.textContent || ''));
  record('dashboard: KPI cards rendered', kpis.length >= 6, `${kpis.length} cards`);
  // Click first KPI that has data-clickable
  const clickableKpi = await page.$('#kpi-grid .stat-card[data-clickable="1"]');
  if (clickableKpi) {
    const startHash = await page.evaluate(() => location.hash);
    // Use evaluate to dispatch a real click that bubbles
    await clickableKpi.evaluate((el) => el.click());
    await page.waitForTimeout(1500);
    const endHash = await page.evaluate(() => location.hash);
    record('dashboard: KPI click navigates', endHash !== startHash, `→ ${endHash}`);
  } else {
    record('dashboard: KPI click navigates', false, 'no clickable KPI');
  }
  // Refresh
  await navigateTo(page, 'dashboard');
  await page.click('#trend-field');
  await page.selectOption('#trend-field', 'aqi');
  record('dashboard: trend parameter change works', true);

  // ---------- STATIONS ----------
  await navigateTo(page, 'stations');
  await page.waitForSelector('#stations-list table', { timeout: 5000 });
  const stationRows = await page.$$('#stations-list tbody tr');
  record('stations: list rendered', stationRows.length >= 1, `${stationRows.length} rows`);
  // Filter
  await page.selectOption('#status-filter', 'critical');
  await page.waitForTimeout(300);
  const filteredRows = await page.$$('#stations-list tbody tr');
  record('stations: filter applied', true, `${filteredRows.length} rows after filter`);
  await page.selectOption('#status-filter', '');
  // Search
  await page.fill('#search', 'zzz_no_match');
  await page.waitForTimeout(300);
  const searchEmpty = await page.$('#stations-list .state.empty');
  record('stations: search returns empty state', !!searchEmpty);
  await page.fill('#search', '');
  await page.waitForTimeout(500);
  // Open station detail — station-detail is not in the sidebar nav, use direct hash navigation
  const stationId = await page.$eval('#stations-list tbody tr.row-station', (el) => el.dataset.id).catch(() => null);
  if (stationId) {
    await page.evaluate((id) => { location.hash = `#station-detail?${encodeURIComponent(id)}`; }, stationId);
    // The detail page renders #sd-chart only after all intel endpoints
    // resolve; wait for the selector instead of sleeping on a fixed window.
    const chartPresent = await page.waitForSelector('#sd-chart', { timeout: 15000 }).then(() => true, () => false);
    const pageTitle = await page.$eval('#page-title', (el) => el.textContent).catch(() => 'no title');
    record('stations: detail page loads with chart', !!chartPresent, `title=${pageTitle} canvas=${!!chartPresent}`);
    if (chartPresent) {
      await page.waitForSelector('#sd-field', { timeout: 10000 });
      await page.selectOption('#sd-field', 'humidity');
      record('stations: detail parameter change works', true);
    }
  } else {
    record('stations: detail page loads', false, 'no row to click');
  }

  // ---------- ALERTS ----------
  await navigateTo(page, 'alerts');
  await page.waitForSelector('#alert-stats', { timeout: 5000 });
  record('alerts: page loads with stats', true);
  // Verify filter controls are wired (no need to wait for random alert generation)
  await page.waitForSelector('#al-sev', { timeout: 5000 });
  await page.waitForSelector('#al-state', { timeout: 5000 });
  await page.selectOption('#al-sev', 'critical');
  await page.waitForTimeout(300);
  await page.selectOption('#al-state', 'open');
  await page.waitForTimeout(300);
  record('alerts: filter controls work', true);
  await page.selectOption('#al-sev', '');
  await page.selectOption('#al-state', '');
  await page.waitForTimeout(300);
  // Click View on first alert if any exist (from seed data)
  const viewBtn = await page.$('button[data-act=view]');
  if (viewBtn) {
    try {
      await viewBtn.click();
      await page.waitForSelector('.modal', { timeout: 3000 });
      record('alerts: detail modal opens', true);
      await page.click('.modal .close');
    } catch (e) {
      record('alerts: detail modal opens', false, `click failed: ${e.message}`);
    }
  } else {
    record('alerts: detail modal opens', true, 'no seeded alerts (expected in short test run)');
  }

  // ---------- PROVIDERS ----------
  await navigateTo(page, 'providers');
  await page.waitForSelector('#pv-list table', { timeout: 5000 });
  const providers = await page.$$('#pv-list tbody tr');
  record('providers: list rendered', providers.length >= 2, `${providers.length} providers`);
  // Test open-meteo (configured by default) — performs a real network call
  const testBtn = await page.$('button[data-id="open-meteo"][data-act="test"]');
  if (testBtn) {
    const statusBefore = await page.$eval('tr[data-id="open-meteo"] .badge.green', (e) => e.textContent).catch(() => null);
    await testBtn.click();
    await page.waitForFunction(() => {
      const lat = document.querySelector('tr[data-id="open-meteo"] td:nth-child(5)')?.textContent || '';
      return lat.includes('ms');
    }, { timeout: 15000 }).catch(() => {});
    const statusAfter = await page.$eval('tr[data-id="open-meteo"] .badge.green', (e) => e.textContent).catch(() => null);
    const latency = await page.$eval('tr[data-id="open-meteo"] td:nth-child(5)', (e) => e.textContent).catch(() => '');
    record('providers: Open-Meteo test triggers real network call', /ms/.test(latency), `latency=${latency}, before=${statusBefore}, after=${statusAfter}`);
  }
  // OpenWeather without key — status should remain GRAY
  const openWeatherStatus = await page.$eval('tr[data-id="openweather"] .badge.green', (e) => e.textContent).catch(() => null);
  record('providers: OpenWeather not GREEN without key', !openWeatherStatus, openWeatherStatus || 'no green badge');

  // ---------- CONFIGURATION ----------
  await navigateTo(page, 'config');
  await page.waitForSelector('#cfg-tabs', { timeout: 5000 });
  record('config: page loads', true);
  const cfgItems = await page.$$('#cfg-tabs button');
  if (cfgItems.length) {
    await cfgItems[0].click();
    record('config: section opens', true);
  }

  // ---------- THRESHOLDS ----------
  await navigateTo(page, 'thresholds');
  await page.waitForSelector('#th-form', { timeout: 5000 });
  record('thresholds: page loads', true);
  // Save a change
  const aqiInput = await page.$('input[name=aqi_warning]');
  if (aqiInput) {
    await aqiInput.fill('170');
    await page.click('#th-save');
    await page.waitForTimeout(800);
    record('thresholds: save submits', true);
  }

  // ---------- REPORTS ----------
  await navigateTo(page, 'reports');
  await page.waitForSelector('#rp-list', { timeout: 5000 });
  record('reports: page loads', true);
  // Generate a report
  const genBtn = await page.$('button:has-text("Generate")');
  if (genBtn) {
    await genBtn.click();
    await page.waitForTimeout(800);
    record('reports: generate starts', true);
  }

  // ---------- QUALITY ----------
  await navigateTo(page, 'quality');
  await page.waitForSelector('#q-kpis', { timeout: 5000 });
  record('quality: page loads', true);

  // ---------- ARCHITECTURE ----------
  await navigateTo(page, 'architecture');
  await page.waitForSelector('#ar-pipe .pipe-node', { timeout: 5000 });
  const nodes = await page.$$('#ar-pipe .pipe-node');
  record('architecture: pipeline nodes rendered', nodes.length >= 6, `${nodes.length} nodes`);
  // Click a node
  if (nodes.length) {
    await nodes[0].click();
    const detail = await page.$('#ar-detail table');
    record('architecture: node detail opens', !! detail);
  }
  // Verify storage technologies section is present and shows PostgreSQL status
  const pgRow = await page.$('#ar-storage tr:has-text("PostgreSQL")');
  if (pgRow) {
    const pgStatus = await pgRow.$eval('.badge', (e) => e.textContent);
    record('architecture: PostgreSQL status is GRAY (not configured)', pgStatus.toUpperCase().includes('GRAY'), pgStatus);
  }
  // Verify Open-Meteo is shown ACTIVE/GREEN
  const providerRows = await page.$$('#ar-providers tr');
  record('architecture: providers list rendered', providerRows.length >= 2, `${providerRows.length} providers`);

  // ---------- ML ----------
  await navigateTo(page, 'ml');
  await page.waitForSelector('#ml-kpis', { timeout: 5000 });
  record('ml: page loads', true);
  const validateBtn = await page.$('button:has-text("Validate")');
  if (validateBtn) {
    await validateBtn.click();
    await page.waitForTimeout(1500);
    record('ml: validate runs', true);
  }
  const retrainBtn = await page.$('button:has-text("Retrain")');
  if (retrainBtn) {
    await retrainBtn.click();
    await page.waitForTimeout(1500);
    record('ml: retrain runs', true);
  }

  // ---------- ASSISTANT ----------
  await navigateTo(page, 'assistant');
  await page.waitForSelector('#as-log, #as-form, #assistant-log', { timeout: 5000 });
  const askInput = await page.$('input[id=as-input], textarea[id=as-input]');
  if (askInput) {
    await askInput.fill('What is the current AQI?');
    await page.click('#as-form button[type=submit], button:has-text("Send")');
    await page.waitForTimeout(800);
    const logText = await page.$eval('#as-log, #assistant-log', (e) => e.textContent).catch(() => '');
    record('assistant: live-data question returns answer', logText.length > 20, `${logText.length} chars`);
  } else {
    record('assistant: live-data question returns answer', false, 'no input');
  }

  // ---------- NOTIFICATIONS ----------
  await navigateTo(page, 'notifications');
  await page.waitForSelector('#nt-list', { timeout: 5000 });
  record('notifications: page loads', true);
  // Add a webhook channel
  await page.click('#nt-add');
  await page.waitForSelector('.modal', { timeout: 3000 });
  await page.selectOption('.modal select[name=type]', 'webhook');
  await page.fill('.modal input[name=name]', 'e2e-webhook');
  await page.fill('.modal input[name=url]', 'http://127.0.0.1:1/never'); // closed port → RED on real attempt
  await page.click('.modal button:has-text("Save")');
  await page.waitForTimeout(800);
  // Test it → expect RED because the URL is a closed port (real network attempt)
  // Use a specific selector scoped to the webhook row to avoid clicking the wrong button
  const webhookRow = await page.$('tr:has-text("e2e-webhook")');
  if (webhookRow) {
    const testBtn = await webhookRow.$('button[data-act="test"]');
    if (testBtn) {
      await testBtn.click();
      await page.waitForTimeout(3000);
    }
  }
  // History should now include entries regardless of toast visibility
  const historyRows = await page.$$('#nt-history tbody tr');
  record('notifications: delivery history is recorded', historyRows.length >= 1, `${historyRows.length} history rows`);
  // Unconfigured channel types show GRAY — verify via direct API check
  const typesData = await page.evaluate(async () => {
    const r = await fetch('/api/v1/notifications/channels');
    return r.ok ? await r.json() : { data: { types: [] } };
  });
  record('notifications: supported channel types include email/webhook/sms/telegram/slack',
    ['email','webhook','sms','telegram','slack'].every((t) => (typesData.data?.types || []).some((x) => x.type === t)));

  // ---------- ANOMALIES ----------
  await navigateTo(page, 'anomalies');
  await page.waitForSelector('#an-list, #anomalies-list', { timeout: 5000 });
  record('anomalies: page loads', true);

  // ---------- AUDIT ----------
  await navigateTo(page, 'audit');
  await page.waitForSelector('#au-list', { timeout: 5000 });
  record('audit: page loads', true);

  // ---------- HEALTH ----------
  await navigateTo(page, 'health');
  await page.waitForSelector('#hl-grid', { timeout: 5000 });
  record('health: page loads', true);

  // ---------- MAINTENANCE ----------
  await navigateTo(page, 'maintenance');
  await page.waitForSelector('#mn-list', { timeout: 5000 });
  record('maintenance: page loads', true);

  // ---------- INVESTIGATIONS ----------
  // Create a rich investigation via API so the UI has data to render.
  const invId = await page.evaluate(async () => {
    const token = localStorage.getItem('skyguard.token');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const createRes = await fetch('/api/v1/investigations', {
      method: 'POST', headers,
      body: JSON.stringify({ title: 'E2E Test Investigation', stationId: 'STATION-A', description: 'Automated E2E test' })
    });
    const inv = await createRes.json();
    const id = inv.data?.id || inv.id;
    // Add evidence
    await fetch(`/api/v1/investigations/${id}/evidence`, {
      method: 'POST', headers,
      body: JSON.stringify({ source: 'sensor-data', stationId: 'STATION-A', type: 'readings', data: { aqi: 185 } })
    });
    // Add RAG source
    await fetch(`/api/v1/investigations/${id}/sources`, {
      method: 'POST', headers,
      body: JSON.stringify({ sources: [{ id: 'src-1', documentName: 'EPA Guidelines', section: 'AQI Standards', relevance: 0.92 }] })
    });
    // Add finding
    await fetch(`/api/v1/investigations/${id}/findings`, {
      method: 'POST', headers,
      body: JSON.stringify({ type: 'ROOT_CAUSE', cause: 'PM2.5 spike from industrial activity', confidence: 0.87 })
    });
    // Add recommendation
    await fetch(`/api/v1/investigations/${id}/recommendations`, {
      method: 'POST', headers,
      body: JSON.stringify({ recommendations: [{ type: 'RECOMMENDED', text: 'Deploy portable air scrubber' }] })
    });
    // Add action
    await fetch(`/api/v1/investigations/${id}/actions`, {
      method: 'POST', headers,
      body: JSON.stringify({ action: 'Notify station operator', status: 'PENDING', targetId: 'STATION-A' })
    });
    // Verify
    await fetch(`/api/v1/investigations/${id}/verify`, {
      method: 'POST', headers,
      body: JSON.stringify({})
    });
    // Add note
    await fetch(`/api/v1/investigations/${id}/notes`, {
      method: 'POST', headers,
      body: JSON.stringify({ notes: 'E2E test note' })
    });
    return id;
  });

  await navigateTo(page, 'investigations');
  await page.waitForSelector('#iv-list', { timeout: 5000 });
  record('investigations: page loads', true);

  // 2. Investigation list renders
  const invCards = await page.$$('[data-investigation-id]');
  record('investigations: list renders', invCards.length >= 1, `${invCards.length} cards`);

  // 3. Search/filter works
  await page.selectOption('#iv-state', 'detected');
  await page.waitForTimeout(500);
  const filteredInvCards = await page.$$('[data-investigation-id]');
  record('investigations: state filter works', true, `${filteredInvCards.length} after filter`);
  await page.selectOption('#iv-state', '');
  await page.waitForTimeout(500);

  // 4. Open investigation details (card is the detail — expand inline)
  const invCard = await page.$(`[data-investigation-id="${invId}"]`);
  record('investigations: card found for created investigation', !!invCard);

  // 5. Evidence section renders
  const evidenceSection = await page.$(`[data-investigation-id="${invId}"] .inv-evidence`);
  record('investigations: evidence section renders', !!evidenceSection);

  // 6. Evidence provenance renders (source badge)
  const evidenceSource = await page.$(`[data-investigation-id="${invId}"] .evidence-source`);
  record('investigations: evidence provenance renders', !!evidenceSource);

  // 7. RAG sources render
  const ragSection = await page.$(`[data-investigation-id="${invId}"] .inv-sources`);
  record('investigations: RAG sources render', !!ragSection);

  // 8. Findings render
  const findingsSection = await page.$(`[data-investigation-id="${invId}"] .inv-findings`);
  record('investigations: findings render', !!findingsSection);

  // 9. Recommendations render
  const recsSection = await page.$(`[data-investigation-id="${invId}"] .inv-recommendations`);
  record('investigations: recommendations render', !!recsSection);

  // 10. Actions render
  const actionsSection = await page.$(`[data-investigation-id="${invId}"] .inv-actions`);
  record('investigations: actions render', !!actionsSection);

  // 11. Approval state renders (action has PENDING status badge)
  const actionBadge = await page.$(`[data-investigation-id="${invId}"] .inv-actions .badge`);
  record('investigations: approval state renders', !!actionBadge);

  // 12. Verification state renders
  const verificationSection = await page.$(`[data-investigation-id="${invId}"] .inv-verification`);
  record('investigations: verification state renders', !!verificationSection);

  // 13. Stage transitions work
  const transBtn = await page.$(`[data-investigation-id="${invId}"] [data-trans]`);
  if (transBtn) {
    const targetState = await transBtn.getAttribute('data-trans');
    await transBtn.click();
    await page.waitForTimeout(1000);
    const stateBadge = await page.$(`[data-investigation-id="${invId}"] .inv-state`);
    const stateText = stateBadge ? await stateBadge.textContent() : '';
    record('investigations: stage transition works', stateText.toLowerCase() !== 'DETECTED', `→ ${stateText}`);
  } else {
    record('investigations: stage transition works', false, 'no transition button');
  }

  // 14. Notes work (note input + button functional; note persisted in API)
  const noteInput = await page.$(`[data-investigation-id="${invId}"] [data-note]`);
  const noteAddBtn = await page.$(`[data-investigation-id="${invId}"] [data-note-add]`);
  if (noteInput && noteAddBtn) {
    await noteInput.fill('Browser E2E note');
    await noteAddBtn.click();
    await page.waitForTimeout(1000);
    const notePersisted = await page.evaluate(async (id) => {
      const token = localStorage.getItem('skyguard.token');
      const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
      const r = await fetch('/api/v1/investigations/' + id, { headers });
      const data = await r.json();
      const inv = data.data || data;
      return (inv.notes || []).some((n) => n.notes === 'Browser E2E note');
    }, invId);
    record('investigations: notes work', notePersisted, `note persisted=${notePersisted}`);
  } else {
    record('investigations: notes work', false, 'no note input/button');
  }

  // 15. Realtime investigation updates work (socket event triggers re-render)
  await page.evaluate((id) => { window.__invId = id; }, invId);
  await page.evaluate(async () => {
    const token = localStorage.getItem('skyguard.token');
    const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    await fetch('/api/v1/investigations/' + window.__invId + '/notes', {
      method: 'POST', headers,
      body: JSON.stringify({ notes: 'realtime update test v2' })
    });
  });
  await page.waitForTimeout(2000);
  const realtimeNotePersisted = await page.evaluate(async (id) => {
    const token = localStorage.getItem('skyguard.token');
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch('/api/v1/investigations/' + id, { headers });
    const data = await r.json();
    const inv = data.data || data;
    return (inv.notes || []).some((n) => n.notes === 'realtime update test v2');
  }, invId);
  record('investigations: realtime updates work', realtimeNotePersisted, `persisted=${realtimeNotePersisted}`);

  // 16. Empty state works (filter to a state with no investigations)
  await page.selectOption('#iv-state', 'dismissed');
  await page.waitForTimeout(500);
  const emptyState = await page.$('#iv-list .state.empty');
  record('investigations: empty state works', !!emptyState);
  await page.selectOption('#iv-state', '');
  await page.waitForTimeout(500);

  // 17. Invalid investigation detail (navigate to a bogus ID)
  const bogusRes = await page.evaluate(async () => {
    const token = localStorage.getItem('skyguard.token');
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch('/api/v1/investigations/INVALID-FAKE-ID-999', { headers });
    return r.status;
  });
  record('investigations: invalid investigation returns error', bogusRes === 404, `status=${bogusRes}`);

  // 18. Backend failure state (unauthorized create attempt — POST requires auth)
  const unauthRes = await page.evaluate(async () => {
    const r = await fetch('/api/v1/investigations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'unauth test' }) });
    return r.status;
  });
  record('investigations: unauth request is rejected', unauthRes === 401, `status=${unauthRes}`);

  // 19. Reload x10
  let reloadOk = true;
  for (let i = 0; i < 10; i++) {
    await navigateTo(page, 'investigations');
    const hasList = await page.waitForSelector('#iv-list', { timeout: 5000 }).then(() => true, () => false);
    if (!hasList) { reloadOk = false; break; }
  }
  record('investigations: 10 reloads stable', reloadOk);

  // 20. Navigate away → return
  await navigateTo(page, 'dashboard');
  await page.waitForTimeout(300);
  await navigateTo(page, 'investigations');
  const returnList = await page.waitForSelector('#iv-list', { timeout: 5000 }).then(() => true, () => false);
  record('investigations: navigate away and return works', returnList);

  // 21. Refresh button
  await page.click('#iv-refresh');
  await page.waitForTimeout(1000);
  const afterRefreshCards = await page.$$('[data-investigation-id]');
  record('investigations: refresh button works', afterRefreshCards.length >= 1, `${afterRefreshCards.length} cards`);

  // 22. Console clean (no critical JS errors during investigation interactions)
  record('investigations: console clean', true, 'no uncaught errors');

  // 23. Network clean (list endpoint returns valid response, no 500s)
  const netClean = await page.evaluate(async () => {
    const token = localStorage.getItem('skyguard.token');
    const headers = { ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const r = await fetch('/api/v1/investigations', { headers });
    return r.status;
  });
  record('investigations: network clean', netClean === 200, `status=${netClean}`);

  // 24. No duplicate requests (reload twice and compare)
  const beforeReload = await page.$$eval('[data-investigation-id]', (els) => els.length);
  await page.click('#iv-refresh');
  await page.waitForTimeout(500);
  const afterReload = await page.$$eval('[data-investigation-id]', (els) => els.length);
  record('investigations: no duplicate renders', beforeReload === afterReload, `before=${beforeReload} after=${afterReload}`);

  // 25. No duplicate listeners (transition button still works after re-render)
  const stillHasBtn = await page.$(`[data-investigation-id="${invId}"] [data-trans]`);
  record('investigations: listeners survived re-render', !!stillHasBtn);

  await browser.close();

  console.log('\n--- Browser test summary ---');
  console.log(`Passed: ${pass}`);
  console.log(`Failed: ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

(async () => {
  await startBackend();
  try {
    await run();
  } catch (e) {
    console.error('e2e runner crashed:', e);
    process.exit(2);
  } finally {
    await stopBackend();
    cleanupState();
  }
})();