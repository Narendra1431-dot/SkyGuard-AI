const http = require('http');

const endpoints = [
  '/api/v1/intelligence/situation',
  '/api/v1/providers',
  '/api/v1/quality/snapshot',
  '/api/v1/alerts',
  '/api/v1/advanced-analytics/comprehensive?minutes=60',
  '/api/v1/maintenance',
  '/api/v1/correlation/correlated?minutes=1440',
  '/api/v1/intelligence/actions',
  '/api/v1/monitoring/brief',
  '/api/v1/events?limit=60'
];

async function measure(endpoint, runs = 10) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = Date.now();
    await new Promise((resolve, reject) => {
      const req = http.get(`http://localhost:4000${endpoint}`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve());
      }).on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
    times.push(Date.now() - start);
  }
  
  times.sort((a, b) => a - b);
  const min = times[0];
  const max = times[times.length - 1];
  const avg = times.reduce((a, b) => a + b, 0) / runs;
  const median = times[Math.floor(runs / 2)];
  const p95 = times[Math.floor(runs * 0.95)];
  
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Min: ${min}ms | Avg: ${avg}ms | Median: ${median}ms | P95: ${p95}ms | Max: ${max}ms`);
  console.log('--------------------------------------------------');
}

async function run() {
  console.log('Starting Benchmark...');
  for (const endpoint of endpoints) {
    try {
      await measure(endpoint, 3); // 3 runs to get an initial idea quickly
    } catch (e) {
      console.error(`Error testing ${endpoint}: ${e.message}`);
    }
  }
}

run();