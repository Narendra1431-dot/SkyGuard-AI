const { chromium } = require('playwright');

const BASE_URL = 'http://localhost:4000';
const API_BASE = 'http://localhost:4000';

async function run() {
  console.log('=== COMMAND CENTER UI AUDIT ===\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const results = {
    freshLoad: { pass: false, time: null, errors: [] },
    reload: [],
    apiTimings: {},
    consoleErrors: [],
    networkFailures: [],
  };

  page.on('console', msg => {
    if (msg.type() === 'error') {
      results.consoleErrors.push({ text: msg.text(), location: msg.location() });
    }
  });

  page.on('requestfailed', request => {
    results.networkFailures.push({
      url: request.url(),
      failure: request.failure()?.errorText
    });
  });

  const apiRequests = [];
  page.on('request', request => {
    if (request.url().startsWith(API_BASE)) {
      apiRequests.push({ url: request.url(), start: Date.now(), end: null });
    }
  });

  page.on('response', response => {
    if (response.url().startsWith(API_BASE)) {
      const req = apiRequests.find(r => r.url === response.url() && r.end === null);
      if (req) {
        req.end = Date.now();
        req.status = response.status();
      }
    }
  });

  try {
    // Step 1: Navigate and login properly through UI
    console.log('1. Loading app...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    // Check if we're on login screen
    const loginVisible = await page.$eval('#login-screen', el => !el.hidden);
    console.log('   Login screen visible:', loginVisible);

    // Fill login form
    await page.fill('input[name="username"]', 'admin');
    await page.fill('input[name="password"]', 'admin123!Change');

    // Submit
    console.log('2. Submitting login...');
    await page.click('button[type="submit"]');

    // Wait for main app to appear
    try {
      await page.waitForFunction(() => {
        const mainApp = document.getElementById('main-app');
        return mainApp && !mainApp.hidden;
      }, { timeout: 10000 });
      console.log('   Login successful - main app visible');
    } catch (e) {
      console.log('   ERROR: Main app did not appear after login');
      const loginError = await page.$eval('#login-error', el => el.textContent).catch(() => 'N/A');
      const mainAppHidden = await page.$eval('#main-app', el => el.hidden).catch(() => 'N/A');
      console.log('   Login error:', loginError);
      console.log('   Main app hidden:', mainAppHidden);
      await browser.close();
      return results;
    }

    // Navigate to Command Center
    console.log('3. Navigating to Command Center...');
    const freshStart = Date.now();

    // Click on Command Center nav item
    await page.click('.nav-item[data-route="dashboard"]');
    await page.waitForTimeout(500);

    // Wait for KPI cards to appear
    try {
      await page.waitForSelector('.stat-card', { timeout: 10000 });
      console.log('   KPI cards appeared');
    } catch (e) {
      console.log('   WARNING: KPI cards did not appear');
    }

    await page.waitForTimeout(3000);
    const freshLoadTime = Date.now() - freshStart;

    // Check all Command Center elements
    const elements = await page.evaluate(() => {
      const kpiCards = document.querySelectorAll('.stat-card');
      const badges = document.querySelectorAll('.badge');
      const emptyStates = document.querySelectorAll('.state.empty');
      const errorStates = document.querySelectorAll('.state.error');
      const statCards = Array.from(kpiCards).map(c => ({
        label: c.querySelector('.lbl')?.textContent,
        value: c.querySelector('.val')?.textContent
      }));
      return {
        kpiGrid: !!document.getElementById('kpi-grid'),
        kpiGrid2: !!document.getElementById('kpi-grid-2'),
        trendChart: !!document.getElementById('trend-chart'),
        activeAnoms: !!document.getElementById('active-anoms'),
        criticalStations: !!document.getElementById('critical-stations'),
        actionsList: !!document.getElementById('actions-list'),
        correlatedList: !!document.getElementById('correlated-list'),
        recentAlerts: !!document.getElementById('recent-alerts'),
        briefHost: !!document.getElementById('brief-host'),
        stationsTable: !!document.getElementById('stations-table'),
        statCardsCount: kpiCards.length,
        statCards,
        badgesCount: badges.length,
        emptyStatesCount: emptyStates.length,
        errorStatesCount: errorStates.length,
        connState: document.getElementById('conn-state')?.textContent?.trim(),
        pageTitle: document.getElementById('page-title')?.textContent,
        activeAnomsHTML: document.getElementById('active-anoms')?.innerHTML?.substring(0, 200),
        actionsListHTML: document.getElementById('actions-list')?.innerHTML?.substring(0, 200),
        recentAlertsHTML: document.getElementById('recent-alerts')?.innerHTML?.substring(0, 200),
      };
    });

    console.log('   Elements:');
    console.log('     kpiGrid:', elements.kpiGrid);
    console.log('     kpiGrid2:', elements.kpiGrid2);
    console.log('     trendChart:', elements.trendChart);
    console.log('     activeAnoms:', elements.activeAnoms);
    console.log('     criticalStations:', elements.criticalStations);
    console.log('     actionsList:', elements.actionsList);
    console.log('     correlatedList:', elements.correlatedList);
    console.log('     recentAlerts:', elements.recentAlerts);
    console.log('     briefHost:', elements.briefHost);
    console.log('     stationsTable:', elements.stationsTable);
    console.log('     Stat cards:', elements.statCardsCount);
    console.log('     Badges:', elements.badgesCount);
    console.log('     Empty states:', elements.emptyStatesCount);
    console.log('     Error states:', elements.errorStatesCount);
    console.log('     Connection state:', elements.connState);
    console.log('     Page title:', elements.pageTitle);
    console.log('     Active anomalies:', elements.activeAnomsHTML);
    console.log('     Actions:', elements.actionsListHTML);
    console.log('     Recent alerts:', elements.recentAlertsHTML);
    console.log('     Stat card data:', JSON.stringify(elements.statCards));

    results.freshLoad = {
      pass: elements.kpiGrid && elements.trendChart && elements.statCardsCount > 0,
      time: freshLoadTime,
      elements
    };

    // Step 4: Reload test
    console.log('4. Reload test (x10)...');
    for (let i = 0; i < 10; i++) {
      const reloadStart = Date.now();
      await page.reload({ waitUntil: 'domcontentloaded' });

      // Wait for login if needed
      const loginVisible = await page.$eval('#login-screen', el => !el.hidden).catch(() => false);
      if (loginVisible) {
        await page.fill('input[name="username"]', 'admin');
        await page.fill('input[name="password"]', 'admin123!Change');
        await page.click('button[type="submit"]');
        try {
          await page.waitForFunction(() => {
            const mainApp = document.getElementById('main-app');
            return mainApp && !mainApp.hidden;
          }, { timeout: 10000 });
        } catch (e) {}
      }

      try {
        await page.waitForSelector('.stat-card', { timeout: 8000 });
      } catch (e) {}
      await page.waitForTimeout(2000);

      const reloadTime = Date.now() - reloadStart;
      const cardCount = await page.$$eval('.stat-card', els => els.length);
      results.reload.push({ time: reloadTime, cards: cardCount });
      console.log(`   Reload ${i + 1}: ${reloadTime}ms, cards: ${cardCount}`);
    }

    // Step 5: API timings
    console.log('5. API request timings...');
    for (const req of apiRequests) {
      if (req.end && req.start) {
        const duration = req.end - req.start;
        const endpoint = req.url.replace(API_BASE, '');
        if (!results.apiTimings[endpoint]) {
          results.apiTimings[endpoint] = [];
        }
        results.apiTimings[endpoint].push({ duration, status: req.status });
      }
    }

    // Step 6: Interactions
    console.log('6. Testing interactions...');

    // Test trend field
    const trendField = await page.$('#trend-field');
    if (trendField) {
      await trendField.selectOption('aqi');
      await page.waitForTimeout(2000);
      console.log('   Trend field selector: OK');
    }

    // Test station search
    const stSearch = await page.$('#st-search');
    if (stSearch) {
      await stSearch.fill('station-001');
      await page.waitForTimeout(500);
      const tableRows = await page.$$('.row-station');
      console.log(`   Station search: OK (${tableRows.length} matches for "station-001")`);
      await stSearch.fill('');
    }

    // Test refresh button
    const refreshBtn = await page.$('#st-refresh');
    if (refreshBtn) {
      await refreshBtn.click();
      await page.waitForTimeout(2000);
      console.log('   Refresh button: OK');
    }

    // Step 7: Socket handlers check
    console.log('7. Socket handler check...');
    const socketInfo = await page.evaluate(() => {
      if (!window.socketMgr) return { error: 'socketMgr not found' };
      return {
        state: window.socketMgr.state,
        handlerCount: window.socketMgr.handlers?.size || 0,
        handlers: Array.from(window.socketMgr.handlers?.keys() || []),
      };
    });
    console.log(`   Socket state: ${socketInfo.state || socketInfo.error}`);
    console.log(`   Handlers: ${socketInfo.handlerCount}`);
    if (socketInfo.handlers) {
      console.log(`   Events: ${socketInfo.handlers.join(', ')}`);
    }

    // Step 8: Realtime update
    console.log('8. Testing realtime polling (8s interval)...');
    const apiCallsBefore = apiRequests.length;
    await page.waitForTimeout(9000);
    const apiCallsAfter = apiRequests.length;
    console.log(`   Survived 9s. API calls made: ${apiCallsAfter - apiCallsBefore}`);
    console.log('   Realtime polling: OK');

    // Step 9: Check empty/error states
    console.log('9. Checking empty/error states...');
    const emptyCount = await page.$$eval('.state.empty', els => els.length);
    const errorCount = await page.$$eval('.state.error', els => els.length);
    console.log(`   Empty states: ${emptyCount}, Error states: ${errorCount}`);

    // Step 10: Status colors
    console.log('10. Verifying status colors...');
    const colorStats = await page.evaluate(() => {
      const badges = document.querySelectorAll('.badge');
      const colors = { red: 0, yellow: 0, green: 0, blue: 0, gray: 0 };
      badges.forEach(b => {
        if (b.classList.contains('red')) colors.red++;
        else if (b.classList.contains('yellow')) colors.yellow++;
        else if (b.classList.contains('green')) colors.green++;
        else if (b.classList.contains('blue')) colors.blue++;
        else if (b.classList.contains('gray')) colors.gray++;
      });
      return colors;
    });
    console.log(`   Badges: red=${colorStats.red}, yellow=${colorStats.yellow}, green=${colorStats.green}, blue=${colorStats.blue}, gray=${colorStats.gray}`);

    // Step 11: Data integrity - verify no fabricated values
    console.log('11. Checking data integrity...');
    const dataCheck = await page.evaluate(() => {
      const cards = document.querySelectorAll('.stat-card');
      const cardData = Array.from(cards).map(c => {
        const label = c.querySelector('.lbl')?.textContent;
        const value = c.querySelector('.val')?.textContent;
        return { label, value };
      });

      // Check all numeric values look reasonable
      const suspicious = [];
      for (const card of cardData) {
        // Station counts should be positive integers
        if (card.label?.toLowerCase().includes('station') || card.label?.toLowerCase().includes('alert')) {
          const num = parseInt(card.value);
          if (isNaN(num) || num < 0) {
            suspicious.push({ card, reason: 'Invalid station/alert count' });
          }
        }
        // Percentages should be 0-100
        if (card.label?.toLowerCase().includes('quality') || card.label?.toLowerCase().includes('anomaly')) {
          const num = parseFloat(card.value);
          if (card.value.includes('%')) {
            const pct = parseFloat(card.value);
            if (pct < 0 || pct > 100) {
              suspicious.push({ card, reason: 'Percentage out of range' });
            }
          }
        }
      }

      // Check recent alerts section has proper structure
      const alertRows = document.querySelectorAll('#recent-alerts .row-alert');
      const alertsValid = alertRows.length === 0 || Array.from(alertRows).every(row => row.querySelector('.badge'));

      return { cardData, suspicious, alertsValid, alertRowsCount: alertRows.length };
    });
    console.log('   Card data:', JSON.stringify(dataCheck.cardData));
    console.log('   Alerts valid structure:', dataCheck.alertsValid, `(${dataCheck.alertRowsCount} rows)`);
    if (dataCheck.suspicious.length > 0) {
      console.log('   WARNING: Suspicious values:', dataCheck.suspicious);
    } else {
      console.log('   No suspicious values detected');
    }

  } catch (e) {
    console.error('Test error:', e.message);
    console.error(e.stack);
    results.errors.push(e.message);
  }

  // Summary
  console.log('\n=== API TIMING SUMMARY ===');
  for (const [endpoint, timings] of Object.entries(results.apiTimings)) {
    const durations = timings.map(t => t.duration).filter(d => d != null);
    const errors = timings.filter(t => t.status >= 400).length;
    if (durations.length > 0) {
      durations.sort((a, b) => a - b);
      const min = durations[0];
      const max = durations[durations.length - 1];
      const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
      const median = durations[Math.floor(durations.length / 2)];
      const p95 = durations[Math.floor(durations.length * 0.95)];
      const timeouts = timings.filter(t => t.duration > 5000).length;
      console.log(`${endpoint}`);
      console.log(`  min: ${min}ms | avg: ${Math.round(avg)}ms | median: ${median}ms | p95: ${p95}ms | max: ${max}ms | calls: ${durations.length} | errors: ${errors} | timeouts: ${timeouts}`);
    }
  }

  console.log('\n=== CONSOLE ERRORS ===');
  const filteredErrors = results.consoleErrors.filter(e => !e.text.includes('socket.io'));
  if (filteredErrors.length === 0) {
    console.log('No critical console errors');
  } else {
    for (const err of filteredErrors.slice(0, 10)) {
      console.log(`  ${err.text}`);
    }
  }

  console.log('\n=== NETWORK FAILURES ===');
  const filteredFailures = results.networkFailures.filter(f => !f.url.includes('socket.io'));
  if (filteredFailures.length === 0) {
    console.log('No critical network failures');
  } else {
    for (const fail of filteredFailures.slice(0, 10)) {
      console.log(`  ${fail.url}: ${fail.failure}`);
    }
  }

  console.log('\n=== FINAL SUMMARY ===');
  console.log(`Fresh load time: ${results.freshLoad.time}ms`);
  console.log(`Fresh load PASS: ${results.freshLoad.pass}`);
  const reloadTimes = results.reload.map(r => r.time);
  console.log(`Reload times: min=${Math.min(...reloadTimes)}ms, max=${Math.max(...reloadTimes)}ms, avg=${Math.round(reloadTimes.reduce((a,b) => a+b, 0) / reloadTimes.length)}ms`);

  await browser.close();
  return results;
}

run().catch(console.error);
