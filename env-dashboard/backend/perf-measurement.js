'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const RUN_DIR = path.join(os.tmpdir(), `skyguard-perf-${process.pid}-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });
process.env.SKYGUARD_DATA_DIR = RUN_DIR;
process.env.SKYGUARD_STATE_DIR = RUN_DIR;

const endpoints = [
  '/api/v1/history/batch',
  '/api/v1/intelligence/situation',
  '/api/v1/providers',
  '/api/v1/quality',
  '/api/v1/alerts',
  '/api/v1/analytics/advanced',
  '/api/v1/stations',
  '/api/v1/intelligence/what-to-do',
  '/api/v1/monitoring/brief',
  '/api/v1/events',
  '/api/v1/alerts/correlated'
];

async function measureUrl(baseUrl, endpoint, runs = 5) {
  const times = [];
  const errors = [];
  const timeouts = [];
  for (let i = 0; i < runs; i++) {
    const start = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`${baseUrl}${endpoint}`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve());
        }).on('error', (e) => reject(e));
        req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
      times.push(Date.now() - start);
    } catch (e) {
      if (e.message === 'Timeout') timeouts.push(e.message);
      else errors.push(e.message);
    }
  }
  return { times, errors, timeouts };
}

function computeStats(times) {
  if (times.length === 0) return { min: 0, avg: 0, median: 0, p95: 0, max: 0 };
  const sorted = [...times].sort((a, b) => a - b);
  return {
    min: sorted[0],
    avg: times.reduce((a, b) => a + b, 0) / times.length,
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1],
    max: sorted[sorted.length - 1]
  };
}

async function run() {
  console.log('Starting SkyGuard Performance Measurement...\n');
  console.log(`State dir: ${RUN_DIR}\n`);

  const { server } = require('./src/server');
  const { initFromEnv } = require('./src/db/auth');
  const config = require('./src/config');
  await initFromEnv(config.auth);
  await new Promise((resolve) => server.listen(0, resolve));
  const baseURL = `http://127.0.0.1:${server.address().port}`;

  console.log(`Server running at ${baseURL}\n`);
  console.log('Measuring endpoints...\n');

  const results = [];
  for (const endpoint of endpoints) {
    process.stdout.write(`  ${endpoint}...`);
    const result = await measureUrl(baseURL, endpoint, 5);
    const stats = computeStats(result.times);
    results.push({ endpoint, ...stats, errors: result.errors, timeouts: result.timeouts });
    console.log(` min=${stats.min}ms avg=${stats.avg.toFixed(1)}ms median=${stats.median}ms p95=${stats.p95}ms max=${stats.max}ms errors=${result.errors.length} timeouts=${result.timeouts.length}`);
  }

  console.log('\n=== SUMMARY ===');
  let totalMin = 0, totalAvg = 0, totalMax = 0;
  for (const r of results) {
    console.log(`${r.endpoint.padEnd(45)} min=${r.min.toString().padStart(5)} avg=${r.avg.toFixed(1).padStart(7)} median=${r.median.toString().padStart(5)} p95=${r.p95.toString().padStart(5)} max=${r.max.toString().padStart(5)} errors=${r.errors.length} timeouts=${r.timeouts.length}`);
    totalMin += r.min;
    totalAvg += r.avg;
    totalMax += r.max;
  }

  console.log(`\nAggregate: avg total=${totalAvg.toFixed(1)}ms across ${endpoints.length} endpoints`);

  server.close();
  try { fs.rmSync(RUN_DIR, { recursive: true, force: true }); } catch (_) {}
}

run().catch(console.error);
