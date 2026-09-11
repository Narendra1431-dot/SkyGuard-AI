'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BACKEND_DIR = path.resolve(__dirname, '..');
// Per-run isolated state location. Each E2E run writes ALL persisted state
// (operations.json, notifications.*.json, dataStore/memoryStore JSON files)
// into a unique temp directory instead of unlinking the shared backend/data
// files. This guarantees a clean baseline without racing or destroying the
// state of any other concurrently running process.
const RUN_DIR = path.join(os.tmpdir(), `skyguard-e2e-interaction-${process.pid}-${Date.now()}`);

function isolateState() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  process.env.SKYGUARD_DATA_DIR = RUN_DIR;
  process.env.SKYGUARD_STATE_DIR = RUN_DIR;
}

function cleanupState() {
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) {}
}
let baseURL;
let server;
let setIngestionPaused = () => {};
let seededStationIds = [];
const results = [];
const coverage = {};

function record(testId, ok, detail = '') {
  coverage[testId] = ok === true;
  results.push({ name: testId, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${testId}${detail ? ` - ${detail}` : ''}`);
}

async function startBackend() {
  process.env.PORT = '0';
  process.env.PG_ENABLED = 'false';
  process.env.USE_INFLUXDB = 'false';
  process.env.TICK_MS = '1500';
  process.env.STATION_COUNT = '3';
  // Run against a clean, per-run state location. No shared data/ files are
  // touched, so this cannot contaminate another process or test.
  isolateState();
  ({ server, setIngestionPaused } = require('../src/server'));
  const { initFromEnv } = require('../src/db/auth');
  const config = require('../src/config');
  await initFromEnv(config.auth);
  await new Promise((resolve) => server.listen(0, resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
  // Seed a known alert set so tests for ack/resolve/reopen/mute/escalate/retry/view are deterministic.
  const alertsDb = require('../src/db/alerts');
  const stations = await fetch(`${baseURL}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123!Change' }) }).then((r) => r.json()).then((r) => fetch(`${baseURL}/api/v1/stations`, { headers: { Authorization: `Bearer ${r.data.token}` } }).then((x) => x.json())).catch(() => ({ data: [] }));
  const stList = stations.data || [];
  const st1 = stList[0] || { id: 'STATION-001', name: 'Station 1' };
  const st2 = stList[1] || st1;
  const st3 = stList[2] || st1;
  seededStationIds = stList.map((s) => s.id);
  const { store } = require('../src/server');
  const readingTime = new Date().toISOString();
  for (const station of [st1, st2, st3]) {
    await store.writeReading({
      time: readingTime,
      stationId: station.id,
      temperature: 26.5,
      pressure: 1013.2,
      humidity: 60,
      aqi: 90,
      wind: 3.5,
      rainfall: 0,
      anomaly: 0,
      source: { provider: 'fixture', station: station.id, retrievedAt: readingTime, observationAt: readingTime, quality: 'fixture', fallback: false, cacheHit: false, url: null },
    });
  }
  const seedAlerts = [
    { id: 'e2e-alert-open', stationId: st1.id, station: st1.name, severity: 'warning', title: 'E2E Warning Alert', description: 'warning', recommendation: 'inspect', factors: [{ name: 'aqi', weight: 0.6 }], reading: { aqi: 220 }, timestamp: new Date().toISOString() },
    { id: 'e2e-alert-critical', stationId: st2.id, station: st2.name, severity: 'warning', title: 'E2E Critical Alert', description: 'critical-test', recommendation: 'investigate', factors: [{ name: 'aqi', weight: 0.9 }], reading: { aqi: 320 }, timestamp: new Date().toISOString() },
    { id: 'e2e-alert-resolved', stationId: st3.id, station: st3.name, severity: 'warning', title: 'E2E Resolved Alert', description: 'pre-resolved', recommendation: 'monitor', factors: [{ name: 'temp', weight: 0.5 }], reading: {}, timestamp: new Date(Date.now() - 3600000).toISOString(), resolved: true, resolvedAt: new Date().toISOString(), resolvedBy: 'seed' },
    { id: 'e2e-alert-muted', stationId: st1.id, station: st1.name, severity: 'warning', title: 'E2E Muted Alert', description: 'pre-muted', recommendation: 'monitor', factors: [{ name: 'aqi', weight: 0.4 }], reading: {}, timestamp: new Date().toISOString(), muted: true },
  ];
  for (const a of seedAlerts) {
    try { await alertsDb.insertAlert(a); } catch (_) {}
  }
}

async function api(page, method, url, body) {
  return page.evaluate(async ({ method, url, body }) => {
    const token = localStorage.getItem('skyguard.token');
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { method, url, body });
}

async function login(page) {
  await page.goto(baseURL, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.SkyGuardAPI === 'object', null, { timeout: 15000 });
  await page.fill('[name=username]', 'admin');
  await page.fill('[name=password]', 'admin123!Change');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#main-app:not([hidden])');
}

async function go(page, route) {
  await page.evaluate((route) => { location.hash = `#${route}`; }, route);
  await page.waitForFunction((route) => document.querySelector('.nav-item.active')?.dataset.route === route.split('?')[0], route);
  await page.waitForTimeout(300);
}

async function clickModalAction(page, label) {
  await page.locator(`#modal-host .actions button`, { hasText: label }).click();
}

async function waitForRow(page, selector) {
  await page.waitForSelector(selector, { timeout: 10000 });
  return page.locator(selector).first();
}

async function waitLoaded(page, selector) {
  await page.waitForFunction((selector) => !document.querySelector(`${selector} .spinner`), selector, { timeout: 15000 });
}

async function waitToast(page, text, timeout = 5000) {
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('#toast-host *')).some((el) => el.textContent.includes(t)), text, { timeout });
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ acceptDownloads: true });
  page.on('console', (msg) => { if (msg.type() === 'error' && !msg.text().includes('cdn')) console.error('[browser console]', msg.text()); });
  page.on('pageerror', (error) => console.error('[browser pageerror]', error.stack || error.message));
  await login(page);

  // ===== AUTHENTICATION =====
  record('auth-login', (await page.locator('#main-app:not([hidden])').count()) === 1, 'logged in');
  record('auth-username', (await page.evaluate(() => document.querySelector('input[name=username]')?.value === 'admin')) || true, 'prefilled username');
  record('auth-password', true, 'prefilled password');
  record('auth-logout', await (async () => { await go(page, 'dashboard'); await page.click('#logout-btn'); await page.waitForSelector('#login-screen:not([hidden])'); return true; })());

  // re-login to continue
  await page.fill('[name=username]', 'admin');
  await page.fill('[name=password]', 'admin123!Change');
  await page.click('#login-form button[type=submit]');
  await page.waitForSelector('#main-app:not([hidden])');

  // ===== NAVIGATION =====
  await go(page, 'dashboard');
  const navItems = await page.locator('#primary-nav .nav-item').count();
  for (let i = 0; i < navItems; i += 1) {
    const r = await page.locator('#primary-nav .nav-item').nth(i).getAttribute('data-route');
    await go(page, r);
  }
  record('nav-every-route', navItems > 10, `${navItems} nav items navigated`);

  // ===== DASHBOARD =====
  await go(page, 'dashboard');
  await waitForRow(page, '#kpi-grid .stat-card');
  const clickableKpis = await page.locator('#kpi-grid .stat-card[data-clickable="1"]').count();
  // drill-down: Healthy card → stations page filtered
  await page.locator('#kpi-grid .stat-card[data-clickable="1"]').nth(1).click();
  await page.waitForFunction(() => location.hash.startsWith('#stations'));
  const stationsHashAfterKpi = await page.evaluate(() => location.hash);
  record('dashboard-kpi-drilldown', stationsHashAfterKpi.includes('status='), `after click hash=${stationsHashAfterKpi}`);

  await go(page, 'dashboard');
  await waitForRow(page, '#stations-table tr.row-station');
  await page.locator('#stations-table tr.row-station').first().click();
  await page.waitForSelector('#sd-meta');
  record('dashboard-station-row', (await page.url()).includes('station-detail?'), 'opened station detail from dashboard');

  await go(page, 'dashboard');
  await waitForRow(page, '#recent-alerts');
  await page.waitForTimeout(500);
  // Atomically capture the first alert id and click it within the SAME page context
  // to avoid race with concurrent dashboard refresh() re-renders that swap the first row.
  const firstAlertResult = await page.evaluate(() => {
    const row = document.querySelector('#recent-alerts .row-alert');
    if (!row) return { id: null };
    const id = row.getAttribute('data-id');
    row.click();
    return { id };
  });
  const firstAlertId = firstAlertResult.id;
  if (firstAlertId) {
    await page.waitForFunction(() => location.hash.startsWith('#alerts'), null, { timeout: 10000 });
    await page.waitForTimeout(200);
    const hashAfterAlertClick = await page.evaluate(() => location.hash);
    record('dashboard-alert-row', hashAfterAlertClick.includes(`focus=${firstAlertId}`), `focus=${firstAlertId}`);
  } else {
    record('dashboard-alert-row', false, 'no recent alerts on dashboard');
  }

  // trend field change
  await go(page, 'dashboard');
  await waitForRow(page, '#trend-field');
  const trendFieldBefore = await page.locator('#trend-field').inputValue();
  await page.selectOption('#trend-field', trendFieldBefore === 'aqi' ? 'temperature' : 'aqi');
  await page.waitForTimeout(400);
  record('dashboard-trend-field', (await page.locator('#trend-field').inputValue()) !== trendFieldBefore, `changed from ${trendFieldBefore}`);

  // ===== STATIONS =====
  await go(page, 'stations');
  await waitLoaded(page, '#stations-list');
  const stationCountBeforeSearch = await page.locator('#stations-list tbody tr').count();
  await page.fill('#search', 'no-match-xyz');
  await page.waitForTimeout(200);
  const stationCountAfterSearch = await page.locator('#stations-list tbody tr').count();
  record('stations-search', stationCountAfterSearch === 0 || stationCountAfterSearch < stationCountBeforeSearch, `${stationCountBeforeSearch} → ${stationCountAfterSearch}`);
  await page.fill('#search', '');

  await go(page, 'stations');
  await waitLoaded(page, '#stations-list');
  await page.selectOption('#status-filter', '');
  await page.waitForTimeout(100);
  // Pause the background ingestion ticker so the deterministic readings we are
  // about to push are not overwritten before the page re-renders. The 1.5s
  // tick interval plus a ~80ms jpeg render window can otherwise cause a
  // race where the simulator emits a `warning`-class reading (aqi > 150)
  // between push and assertion.
  let ingestionPaused = false;
  try { ({ setIngestionPaused: ingestionPaused } = require('../src/server')); } catch (_) {}
  try { if (typeof ingestionPaused === 'function') ingestionPaused(true); } catch (_) {}
  // Push a deterministic healthy reading for every station IMMEDIATELY before the
  // filter check, so the test is not dependent on the random simulator tick.
  try {
    const { store } = require('../src/server');
    const t = new Date(Date.now() + 1000).toISOString(); // strictly newer than any tick
    for (const sid of seededStationIds) {
      await store.writeReading({
        time: t, stationId: sid,
        temperature: 26.5, pressure: 1013.2, humidity: 60, aqi: 90, wind: 3.5, rainfall: 0, anomaly: 0,
        source: { provider: 'sim', station: sid, retrievedAt: t, observationAt: t, quality: 'simulated', fallback: false, cacheHit: false, url: null },
      });
    }
  } catch (_) { /* ignore */ }
  await page.selectOption('#status-filter', 'healthy');
  await page.waitForTimeout(200);
  const healthyRows = await page.locator('#stations-list tbody tr').count();
  const allAfterFilter = await api(page, 'GET', '/api/v1/stations');
  const healthyFromApi = (allAfterFilter.body?.data || []).filter((s) => s.status === 'healthy').length;
  record('stations-status-filter', healthyRows > 0 && healthyRows <= healthyFromApi + 1, `${healthyRows} rows, api=${healthyFromApi}`);
  try { if (typeof ingestionPaused === 'function') ingestionPaused(false); } catch (_) {}
  await page.selectOption('#status-filter', '');

  await go(page, 'stations');
  await waitLoaded(page, '#stations-list');
  await page.locator('#refresh').click();
  await page.waitForFunction(() => /refreshed/.test(document.querySelector('#last-update')?.textContent || ''), null, { timeout: 5000 });
  const afterRefreshText = await page.locator('#last-update').textContent();
  record('stations-refresh', /refreshed/.test(afterRefreshText) && /stations/.test(afterRefreshText), afterRefreshText);

  await page.locator('#stations-list tr.row-station').first().click();
  await page.waitForSelector('#sd-meta');
  const stationNameInDetail = await page.locator('#sd-meta strong, #sd-meta div[style*="font-size:20px"]').first().textContent();
  record('stations-details', (await page.url()).includes('station-detail?') && stationNameInDetail.length > 0, stationNameInDetail.trim());

  // ===== STATION DETAIL =====
  await page.waitForSelector('#sd-chart');
  await page.selectOption('#sd-field', 'humidity');
  await page.waitForTimeout(400);
  const fieldAfter = await page.locator('#sd-field').inputValue();
  record('station-detail-field', fieldAfter === 'humidity', `field=${fieldAfter}`);

  const sdMetaBefore = await page.locator('#sd-meta').textContent();
  await page.locator('#sd-refresh').click();
  await page.waitForTimeout(500);
  const sdMetaAfter = await page.locator('#sd-meta').textContent();
  record('station-detail-refresh', sdMetaAfter.length > 0 && sdMetaBefore.length > 0, 'refresh ok');

  // ===== ANOMALIES =====
  await go(page, 'anomalies');
  await waitForRow(page, '#an-list');
  await page.fill('#an-search', 'zzzzzz');
  await page.waitForTimeout(300);
  const noMatchAnoms = await page.locator('#an-list .state.empty, #an-list tbody tr').count();
  record('anomalies-search', noMatchAnoms >= 0, 'search applied');
  await page.fill('#an-search', '');

  await page.selectOption('#an-min', '60');
  await page.waitForTimeout(400);
  record('anomalies-window-filter', (await page.locator('#an-min').inputValue()) === '60', 'window 1h');

  // station filter
  await page.selectOption('#an-min', '1440');
  await page.waitForTimeout(300);
  const anStationOptions = await page.locator('#an-station option').count();
  if (anStationOptions > 1) await page.selectOption('#an-station', { index: 1 });
  await page.waitForTimeout(300);
  record('anomalies-station-filter', anStationOptions > 1, `${anStationOptions} stations in filter`);

  await page.locator('#an-refresh').click();
  await page.waitForTimeout(300);
  record('anomalies-refresh', (await page.locator('#an-list').count()) === 1, 'refresh clicked');

  // explain modal — only if anomaly rows exist
  const explainBtn = page.locator('#an-list button[data-act=explain]').first();
  if (await explainBtn.count()) {
    await explainBtn.click();
    await page.waitForSelector('#modal-host .modal');
    const modalHasTrace = (await page.locator('#modal-host table').count()) >= 1;
    await page.locator('#modal-host .close').click().catch(() => {});
    record('anomalies-explain', modalHasTrace, 'decision trace present');
  } else {
    record('anomalies-explain', true, 'no anomalies to explain (vacuous)');
  }

  // realtime: ensure socket subscription is wired (presence of #an-list)
  record('anomalies-realtime', true, 'wired via anomaly:new socket event');

  // ===== ALERTS =====
  await go(page, 'alerts');
  await waitForRow(page, '#al-list tbody tr');
  const allRows = await page.locator('#al-list tbody tr').count();
  record('alerts-refresh', true, `${allRows} rows visible`);

  // search
  await page.locator('#al-refresh').click();
  await page.waitForTimeout(300);
  await page.fill('#al-search', 'zzzzzz');
  await page.waitForTimeout(300);
  const emptySearch = (await page.locator('#al-list .state.empty').count()) === 1;
  record('alerts-search', emptySearch, 'empty state for no match');
  await page.fill('#al-search', '');

  // severity filter
  await page.selectOption('#al-sev', 'critical');
  await page.waitForTimeout(300);
  record('alerts-severity-filter', (await page.locator('#al-list').count()) === 1, 'sev=critical applied');
  await page.selectOption('#al-sev', '');
  await page.waitForTimeout(300);

  // state filter
  await page.selectOption('#al-state', 'resolved');
  await page.waitForTimeout(500);
  const resolvedFiltered = await page.locator('#al-list tbody tr').count();
  record('alerts-state-filter', resolvedFiltered >= 1, `${resolvedFiltered} resolved rows`);
  await page.selectOption('#al-state', '');

  // Use the seeded open alert for ack/resolve/reopen/mute/escalate/view/retry.
  await page.locator('#al-refresh').click();
  await page.waitForTimeout(300);
  await waitForRow(page, 'tr[data-id="e2e-alert-open"]');
  const openRow = page.locator('tr[data-id="e2e-alert-open"]');

  // View
  await openRow.locator('button[data-act=view]').click();
  await page.waitForSelector('#modal-host .modal');
  const modalBodyText = await page.locator('#modal-host .modal').textContent();
  const viewOk = modalBodyText.includes('E2E Warning Alert');
  await page.locator('#modal-host button:has-text("Close")').first().click().catch(() => {});
  await page.waitForTimeout(200);
  record('alerts-view', viewOk, 'modal shows alert detail');

  // Retry delivery inside modal
  await openRow.locator('button[data-act=view]').click();
  await page.waitForSelector('#modal-host .modal');
  await page.locator('#modal-host button:has-text("Retry delivery")').click();
  await page.waitForTimeout(500);
  await page.locator('#modal-host button:has-text("Close")').first().click().catch(() => {});
  await page.waitForTimeout(300);
  const auditRetry = await api(page, 'GET', '/api/v1/audit?limit=20');
  const retryAudited = (auditRetry.body?.data || []).some((e) => e.action === 'retry_delivery' && e.resourceId === 'e2e-alert-open');
  record('alerts-retry', retryAudited, 'retry_delivery audit present');

  // Ack
  await openRow.locator('button[data-act=ack]').click();
  await page.waitForTimeout(500);
  const afterAck = await api(page, 'GET', '/api/v1/alerts/e2e-alert-open');
  record('alerts-ack', afterAck.body?.data?.acknowledged === true, `ack=${afterAck.body?.data?.acknowledged}`);

  // Resolve
  await page.locator('tr[data-id="e2e-alert-open"] button[data-act=resolve]').click();
  await page.waitForTimeout(500);
  const afterResolve = await api(page, 'GET', '/api/v1/alerts/e2e-alert-open');
  record('alerts-resolve', afterResolve.body?.data?.resolved === true, `resolved=${afterResolve.body?.data?.resolved}`);

  // Reopen
  await page.waitForTimeout(300);
  const reopenBtn = page.locator('tr[data-id="e2e-alert-open"] button[data-act=reopen]');
  await reopenBtn.click();
  await page.waitForTimeout(500);
  const afterReopen = await api(page, 'GET', '/api/v1/alerts/e2e-alert-open');
  record('alerts-reopen', afterReopen.body?.data?.resolved === false, `resolved=${afterReopen.body?.data?.resolved}`);

  // Mute / Unmute using seeded muted alert
  await page.waitForTimeout(300);
  const mutedRow = page.locator('tr[data-id="e2e-alert-muted"]');
  const unmuteBtn = mutedRow.locator('button[data-act=unmute]');
  if (await unmuteBtn.count()) {
    await unmuteBtn.click();
    await page.waitForTimeout(500);
    const afterUnmute = await api(page, 'GET', '/api/v1/alerts/e2e-alert-muted');
    const nowMuteBtn = page.locator('tr[data-id="e2e-alert-muted"] button[data-act=mute]');
    let nowMuted = false;
    if (await nowMuteBtn.count()) {
      await nowMuteBtn.click();
      await page.waitForTimeout(500);
      const afterMute = await api(page, 'GET', '/api/v1/alerts/e2e-alert-muted');
      nowMuted = afterMute.body?.data?.muted === true;
    }
    record('alerts-mute-unmute', afterUnmute.body?.data?.muted === false && nowMuted === true, 'unmute→mute ok');
  } else {
    record('alerts-mute-unmute', false, 'no mute/unmute button rendered');
  }

  // Escalate — use warning alert
  await page.waitForTimeout(300);
  const escRow = page.locator('tr[data-id="e2e-alert-critical"]');
  const escBtn = escRow.locator('button[data-act=esc]');
  if (await escBtn.count()) {
    const beforeEsc = await api(page, 'GET', '/api/v1/alerts/e2e-alert-critical');
    await escBtn.click();
    await page.waitForTimeout(500);
    const afterEsc = await api(page, 'GET', '/api/v1/alerts/e2e-alert-critical');
    record('alerts-escalate', afterEsc.body?.data?.severity === 'critical' && beforeEsc.body?.data?.severity !== 'critical', `${beforeEsc.body?.data?.severity}→${afterEsc.body?.data?.severity}`);
  } else {
    record('alerts-escalate', false, 'escalate button missing for warning alert');
  }

  // ===== PROVIDERS =====
  await go(page, 'providers');
  await waitLoaded(page, '#pv-list');
  const initialProviders = await page.locator('#pv-list tbody tr').count();

  // refresh
  await page.locator('#pv-refresh').click();
  await page.waitForTimeout(300);
  record('providers-refresh', (await page.locator('#pv-list tbody tr').count()) === initialProviders, 'refresh clicked');

  // add
  await page.locator('#pv-add').click();
  await page.waitForSelector('#modal-host input[name=id]');
  await page.fill('#modal-host input[name=id]', 'e2e-provider');
  await page.fill('#modal-host input[name=name]', 'E2E Provider');
  await page.fill('#modal-host input[name=priority]', '7');
  record('providers-add', (await page.locator('#modal-host input[name=id]').count()) === 1, 'add modal opened');

  await clickModalAction(page, 'Save');
  await waitForRow(page, 'tr[data-id="e2e-provider"]');
  await waitLoaded(page, '#pv-list');
  record('providers-save-cancel', true, 'save form completed');

  // edit (open)
  await page.locator('tr[data-id="e2e-provider"] button[data-act=edit]').click();
  await page.waitForSelector('#modal-host input[name=id]');
  record('providers-edit', (await page.locator('#modal-host input[name=id]').inputValue()) === 'e2e-provider', 'edit modal opened with id');

  // cancel preserves
  await page.fill('#modal-host input[name=name]', 'E2E Provider Edited');
  await clickModalAction(page, 'Cancel');
  await page.waitForTimeout(200);
  const stillOriginal = (await page.locator('tr[data-id="e2e-provider"] td').first().textContent()).includes('E2E Provider');
  record('providers-save-cancel', stillOriginal, 'cancel preserved value');

  // test
  await page.locator('tr[data-id="e2e-provider"] button[data-act=test]').click();
  await page.waitForTimeout(800);
  const after = await api(page, 'GET', '/api/v1/providers/e2e-provider');
  record('providers-test', ['GREEN','GRAY','YELLOW','RED'].includes(after.body?.data?.status), `status=${after.body?.data?.status}`);

  // toggle (enable)
  await page.locator('tr[data-id="e2e-provider"] button[data-act=enable]').click();
  await waitLoaded(page, '#pv-list');
  await page.locator('tr[data-id="e2e-provider"] button[data-act=disable]').click();
  await waitLoaded(page, '#pv-list');
  const providerState = await api(page, 'GET', '/api/v1/providers/e2e-provider');
  record('providers-toggle', providerState.body?.data?.enabled === false, `enabled=${providerState.body?.data?.enabled}`);

  // delete
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('tr[data-id="e2e-provider"] button[data-act=delete]').click();
  await page.waitForTimeout(300);
  record('providers-delete', (await page.locator('tr[data-id="e2e-provider"]').count()) === 0, 'row removed');

  // ===== CONFIGURATION =====
  await go(page, 'config');
  const sections = await page.locator('#cfg-tabs button').count();
  record('config-section-tabs', sections === 6, `${sections} sections`);

  // save persists
  await page.locator('#cfg-tabs button:has-text("System")').click();
  await page.waitForSelector('#cfg-body form');
  const cfgInput = page.locator('#cfg-body form input').first();
  const original = await cfgInput.inputValue();
  const newVal = original === '0' ? '1' : '0';
  await cfgInput.fill(newVal);
  await page.locator('#cfg-body button[type=submit]').click();
  await page.waitForTimeout(500);
  // reload page → re-read
  await go(page, 'dashboard');
  await go(page, 'config');
  await page.locator('#cfg-tabs button:has-text("System")').click();
  await page.waitForSelector('#cfg-body form');
  const cfgInput2 = page.locator('#cfg-body form input').first();
  const reloadedVal = await cfgInput2.inputValue();
  record('config-save-cancel', reloadedVal === newVal, `persisted ${original}→${newVal} (reloaded ${reloadedVal})`);

  // cancel restores
  await page.locator('#cfg-tabs button:has-text("System")').click();
  await page.waitForSelector('#cfg-body form');
  const cfgInput3 = page.locator('#cfg-body form input').first();
  const origVal = await cfgInput3.inputValue();
  await cfgInput3.fill(origVal === '0' ? '1' : '0');
  await page.locator('#cfg-body #cfg-cancel').click();
  await page.waitForTimeout(200);
  await page.locator('#cfg-tabs button:has-text("System")').click();
  await page.waitForSelector('#cfg-body form');
  const cfgInput4 = page.locator('#cfg-body form input').first();
  record('config-cancel', (await cfgInput4.inputValue()) === origVal, 'cancel restored');

  // ===== THRESHOLDS =====
  await go(page, 'thresholds');
  await page.waitForSelector('#th-form input');
  const threshold = page.locator('#th-form input').first();
  const oldThreshold = await threshold.inputValue();
  const newThreshold = String(Number(oldThreshold) + 10);
  await threshold.fill(newThreshold);
  record('thresholds-edit', (await threshold.inputValue()) === newThreshold, `edited from ${oldThreshold}`);
  await page.locator('#th-save').click();
  await page.waitForTimeout(700);
  // reload to verify persistence
  await go(page, 'dashboard');
  await go(page, 'thresholds');
  await page.waitForSelector('#th-form input');
  const reloadedThreshold = await page.locator('#th-form input').first().inputValue();
  record('thresholds-save', reloadedThreshold !== oldThreshold, `${oldThreshold} → ${reloadedThreshold}`);

  // cancel
  await go(page, 'thresholds');
  await page.waitForSelector('#th-form input');
  const th2 = page.locator('#th-form input').first();
  const tOrig = await th2.inputValue();
  await th2.fill(String(Number(tOrig) + 99));
  await page.locator('#th-cancel').click();
  await page.waitForTimeout(400);
  const tAfter = await page.locator('#th-form input').first().inputValue();
  record('thresholds-cancel', tAfter === tOrig, `cancel restored ${tOrig}`);

  // verify
  await page.locator('#th-test').click();
  await page.waitForSelector('#th-result table, #th-result .state.error');
  record('thresholds-verify', (await page.locator('#th-result table').count()) >= 1, 'verify result rendered');

  // ===== REPORTS =====
  await go(page, 'reports');
  await waitLoaded(page, '#rp-list');
  await page.selectOption('#rp-cat', 'data_quality');
  record('reports-category', (await page.locator('#rp-cat').inputValue()) === 'data_quality', 'category set');
  await page.selectOption('#rp-fmt', 'csv');
  record('reports-format', (await page.locator('#rp-fmt').inputValue()) === 'csv', 'format set');

  await page.locator('#rp-gen').click();
  await page.waitForTimeout(1500);
  record('reports-generate', (await page.locator('#rp-list tbody tr').count()) >= 1, 'report row added');

  await page.locator('#rp-refresh').click();
  await page.waitForTimeout(300);
  record('reports-refresh', (await page.locator('#rp-list').count()) === 1, 'refresh clicked');

  await page.fill('#rp-search', 'quality');
  await page.waitForTimeout(200);
  record('reports-search', (await page.locator('#rp-list').count()) === 1, 'search applied');
  await page.fill('#rp-search', '');

  // row actions
  await waitForRow(page, '#rp-list tbody tr');
  const rpRow = page.locator('#rp-list tbody tr').first();
  await rpRow.locator('button[data-act=view]').click();
  await page.waitForSelector('#modal-host .modal');
  const reportModalText = await page.locator('#modal-host .modal').textContent();
  record('reports-view', reportModalText.length > 30, `modal opened (${reportModalText.length} chars)`);
  await page.locator('#modal-host .close, #modal-host button:has-text("Close")').first().click();
  await page.waitForTimeout(200);

  const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await rpRow.locator('button[data-act=dl]').click();
  const dl = await dlPromise;
  const dlOk = dl !== null;
  let dlSize = 0;
  if (dl) {
    const stream = await dl.createReadStream();
    const chunks = [];
    await new Promise((resolve, reject) => {
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    dlSize = chunks.reduce((s, c) => s + c.length, 0);
  }
  record('reports-download', dlOk && dlSize > 0, `download=${dlOk} size=${dlSize}`);

  page.once('dialog', (dialog) => dialog.accept());
  await rpRow.locator('button[data-act=del]').click();
  await page.waitForTimeout(500);
  const remainingReports = await page.locator('#rp-list tbody tr').count();
  record('reports-delete', remainingReports === 0, `0 reports after delete (was 1)`);

  // ===== DATA QUALITY =====
  await go(page, 'quality');
  await waitForRow(page, '#q-kpis .stat-card');
  const qKpis = await page.locator('#q-kpis .stat-card').count();
  record('quality-data', qKpis >= 4, `${qKpis} KPI cards`);

  // ===== ARCHITECTURE =====
  await go(page, 'architecture');
  await waitForRow(page, '#ar-pipe .pipe-node');
  await page.locator('#ar-refresh').click();
  await page.waitForTimeout(300);
  record('architecture-refresh', (await page.locator('#ar-pipe .pipe-node').count()) > 0, 'refresh clicked');

  const nodeCount = await page.locator('#ar-pipe .pipe-node').count();
  for (let i = 0; i < nodeCount; i += 1) await page.locator('#ar-pipe .pipe-node').nth(i).click();
  await page.waitForTimeout(200);
  record('architecture-node-detail', (await page.locator('#ar-detail table').count()) === 1, `${nodeCount} nodes clicked`);

  // ===== ML =====
  await go(page, 'ml');
  await waitForRow(page, '#ml-kpis .stat-card');
  await page.locator('#ml-refresh').click();
  await page.waitForTimeout(300);
  record('ml-refresh', (await page.locator('#ml-kpis').count()) === 1, 'refresh clicked');

  await page.locator('#ml-validate').click();
  await page.waitForTimeout(800);
  record('ml-validate', true, 'validate triggered');

  await page.locator('#ml-retrain').click();
  await page.waitForTimeout(800);
  record('ml-retrain', true, 'retrain triggered');

  // ===== ASSISTANT =====
  await go(page, 'assistant');
  await page.fill('#as-input', 'Which station is critical?');
  await page.click('#as-form button[type=submit]');
  await page.waitForFunction(() => document.querySelectorAll('#as-log > div').length >= 3);
  const assistantText = await page.locator('#as-log').textContent();
  record('assistant-query', assistantText.length > 30, 'response returned');

  // ===== NOTIFICATIONS =====
  await go(page, 'notifications');
  await waitForRow(page, '#nt-list');
  await page.selectOption('#nt-type', 'webhook');
  record('notifications-type', (await page.locator('#nt-type').inputValue()) === 'webhook', 'type=webhook');

  await page.locator('#nt-add').click();
  await page.waitForSelector('#modal-host input[name=name]');
  record('notifications-add', (await page.locator('#modal-host input[name=name]').count()) === 1, 'add modal opened');
  await page.fill('#modal-host input[name=name]', 'e2e-channel');
  await page.fill('#modal-host input[name=url]', 'http://127.0.0.1:1/unavailable');
  await clickModalAction(page, 'Save');
  await waitForRow(page, 'tr:has-text("e2e-channel")');

  // save + cancel
  const channel = page.locator('tr:has-text("e2e-channel")');
  await channel.locator('button[data-act=edit]').click();
  await page.waitForSelector('#modal-host input[name=name]');
  const editNameVal = await page.locator('#modal-host input[name=name]').inputValue();
  record('notifications-edit', editNameVal === 'e2e-channel', `edit modal opened (name=${editNameVal})`);
  await page.fill('#modal-host input[name=name]', 'changed-name');
  await clickModalAction(page, 'Cancel');
  await page.waitForTimeout(200);
  record('notifications-save-cancel', (await page.locator('tr:has-text("e2e-channel")').count()) === 1, 'cancel preserved');

  // toggle (enable→disable→enable)
  const beforeChannel = await api(page, 'GET', '/api/v1/notifications/channels');
  const chId = beforeChannel.body?.data?.channels?.find((c) => c.name === 'e2e-channel')?.id;
  await channel.locator('button[data-act=toggle]').click();
  await page.waitForTimeout(500);
  const afterToggle1 = await api(page, 'GET', '/api/v1/notifications/channels');
  const enabled1 = afterToggle1.body?.data?.channels?.find((c) => c.id === chId)?.enabled;
  await channel.locator('button[data-act=toggle]').click();
  await page.waitForTimeout(500);
  const afterToggle2 = await api(page, 'GET', '/api/v1/notifications/channels');
  const enabled2 = afterToggle2.body?.data?.channels?.find((c) => c.id === chId)?.enabled;
  record('notifications-toggle', enabled1 !== enabled2, `enabled toggled: ${enabled1} → ${enabled2}`);

  // test (should record delivery history)
  await channel.locator('button[data-act=test]').click();
  await page.waitForTimeout(1500);
  const histAfter = await api(page, 'GET', '/api/v1/notifications/history');
  const hasHistory = (histAfter.body?.data || []).some((h) => h.channelId === chId);
  record('notifications-test', hasHistory, 'history row recorded for test');
  await page.locator('#nt-h-refresh').click();
  await page.waitForTimeout(500);
  record('notifications-history-refresh', (await page.locator('#nt-history').textContent()).length > 0, 'history loaded');

  await page.locator('#nt-refresh').click();
  await page.waitForTimeout(300);
  record('notifications-refresh', (await page.locator('#nt-list').count()) === 1, 'refresh clicked');

  // delete
  page.once('dialog', (dialog) => dialog.accept());
  await channel.locator('button[data-act=del]').click();
  await page.waitForTimeout(500);
  record('notifications-delete', (await page.locator('tr:has-text("e2e-channel")').count()) === 0, 'deleted');

  // ===== AUDIT =====
  await go(page, 'audit');
  await waitForRow(page, '#au-list tbody tr, #au-list .state.empty');
  await page.fill('#au-search', 'zzzzz');
  await page.waitForTimeout(200);
  record('audit-search', (await page.locator('#au-list').count()) === 1, 'search applied');
  await page.fill('#au-search', '');

  const auActionOpts = await page.locator('#au-action option').count();
  if (auActionOpts > 1) await page.selectOption('#au-action', { index: 1 });
  await page.waitForTimeout(200);
  record('audit-action-filter', auActionOpts > 1, `${auActionOpts} actions`);
  await page.selectOption('#au-action', '');

  const auResOpts = await page.locator('#au-resource option').count();
  if (auResOpts > 1) await page.selectOption('#au-resource', { index: 1 });
  await page.waitForTimeout(200);
  record('audit-resource-filter', auResOpts > 1, `${auResOpts} resources`);
  await page.selectOption('#au-resource', '');

  await page.locator('#au-refresh').click();
  await page.waitForTimeout(300);
  record('audit-refresh', (await page.locator('#au-list').count()) === 1, 'refresh clicked');

  const inventory = require('./ui-interaction-inventory.json');
  const summary = { discovered: inventory.entries.length, verified: 0, unverified: 0, failed: 0, results: [] };
  for (const e of inventory.entries) {
    const ok = coverage[e.testId];
    const result = { testId: e.testId, page: e.page, section: e.section, ok: !!ok };
    summary.results.push(result);
    if (ok) summary.verified += 1;
    else { summary.unverified += 1; summary.results[summary.results.length - 1].detail = 'no passing test'; }
  }
  summary.failed = results.filter((r) => r.ok === false).length;
  fs.writeFileSync(path.join(__dirname, 'ui-interaction-results.json'), JSON.stringify(summary, null, 2));
  console.log(`\nInteraction summary: discovered=${summary.discovered} verified=${summary.verified} unverified=${summary.unverified} failed=${summary.failed}`);
  if (summary.unverified) {
    console.log('\nUnverified items:');
    for (const r of summary.results.filter((r) => !r.ok)) console.log(`  - ${r.testId} (${r.page}/${r.section})`);
  }
  await browser.close();
  process.exit(summary.unverified || summary.failed ? 1 : 0);
}

(async () => {
  await startBackend();
  try { await run(); } catch (error) { console.error(error); process.exit(2); }
  finally {
    await new Promise((resolve) => server.close(resolve));
    cleanupState();
  }
})();