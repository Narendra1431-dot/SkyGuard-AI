'use strict';

const http = require('http');
const path = require('path');

const BASE_URL = 'http://localhost:4000';
const REQUEST_COUNT = 20;
const RUNS = 2;

const ENDPOINTS = [
  '/api/v1/health',
  '/api/v1/dashboard',
  '/api/v1/stations',
  '/api/v1/alerts',
  '/api/v1/reports',
  '/api/v1/agent/tools',
  '/api/v1/rag/stats',
  '/api/v1/monitoring/status',
];

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(arr) { return percentile(arr, 50); }

function calcStats(latencies) {
  if (!latencies.length) return { min: 0, avg: 0, median: 0, p95: 0, max: 0 };
  return {
    min: Math.min(...latencies),
    avg: +((latencies.reduce((a, b) => a + b, 0)) / latencies.length).toFixed(2),
    median: +median(latencies).toFixed(2),
    p95: +percentile(latencies, 95).toFixed(2),
    max: Math.max(...latencies),
  };
}

async function httpRequest(method, urlPath, body = null, headers = {}) {
  return new Promise((resolve) => {
    const url = new URL(urlPath, BASE_URL);
    const start = Date.now();
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const latency = Date.now() - start;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) {}
        resolve({
          status: res.statusCode,
          latency,
          data: parsed,
          error: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : null,
        });
      });
    });
    req.on('error', (e) => {
      resolve({ status: 0, latency: Date.now() - start, data: null, error: e.message });
    });
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, latency: Date.now() - start, data: null, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function measureEndpoint(endpoint, count) {
  const latencies = [];
  const errors = [];
  const httpErrors = [];
  let success = 0;

  for (let i = 0; i < count; i++) {
    const res = await httpRequest('GET', endpoint);
    latencies.push(res.latency);
    if (res.error) {
      errors.push(res.error);
      if (res.status >= 400) httpErrors.push(res.status);
    } else {
      success++;
    }
  }

  const stats = calcStats(latencies);
  return {
    endpoint,
    requests: count,
    success,
    errors: errors.length,
    httpErrors: httpErrors.length,
    ...stats,
  };
}

function getMemoryUsage() {
  const mem = process.memoryUsage();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
  };
}

function getResourceSnapshot() {
  const mem = getMemoryUsage();
  return {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    uptime: process.uptime(),
    memory: {
      rss_mb: +(mem.rss / 1024 / 1024).toFixed(2),
      heapUsed_mb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
      heapTotal_mb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      external_mb: +(mem.external / 1024 / 1024).toFixed(2),
      arrayBuffers_mb: +(mem.arrayBuffers / 1024 / 1024).toFixed(2),
    },
  };
}

async function measureAgentToolExecution(toolGateway, context, toolName, params, count) {
  const latencies = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const start = Date.now();
      const result = await toolGateway.executeTool(toolName, params, context, 'viewer', { timeoutMs: 10000 });
      latencies.push(Date.now() - start);
      if (result.status === 'failed' || result.status === 'denied') errors.push(result.error || result.status);
    } catch (e) {
      errors.push(e.message);
    }
  }

  const stats = calcStats(latencies);
  return {
    tool: toolName,
    params: JSON.stringify(params),
    samples: count,
    errors: errors.length,
    ...stats,
  };
}

async function measureRAGRetrieval(ragPipeline, query, options, count) {
  const latencies = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    try {
      const start = Date.now();
      const result = await ragPipeline.retrieve(query, options);
      latencies.push(Date.now() - start);
      if (!result || result.error) errors.push(result.error || 'no result');
    } catch (e) {
      errors.push(e.message);
    }
  }

  const stats = calcStats(latencies);
  return {
    query: query.substring(0, 50),
    mode: 'hybrid',
    samples: count,
    errors: errors.length,
    ...stats,
  };
}

async function measureSocketIOConnections(count) {
  return new Promise((resolve) => {
    const { io: socketIO } = require('socket.io-client');
    const connectLatencies = [];
    const connectionErrors = [];
    let completed = 0;
    let receivedEvent = false;

    function tryFinish() {
      completed++;
      if (completed >= count) {
        const stats = calcStats(connectLatencies);
        resolve({
          connections: count,
          connectionErrors: connectionErrors.length,
          eventReceived: receivedEvent,
          ...stats,
        });
      }
    }

    for (let i = 0; i < count; i++) {
      const start = Date.now();
      const socket = socketIO(BASE_URL, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });

      socket.on('connect', () => {
        connectLatencies.push(Date.now() - start);
        socket.emit('client:hello', { since: 0 });
        socket.disconnect();
      });

      socket.on('system:update', () => { receivedEvent = true; });

      socket.on('connect_error', (e) => {
        connectionErrors.push(e.message);
        connectLatencies.push(Date.now() - start);
        tryFinish();
      });

      socket.on('disconnect', () => { tryFinish(); });

      setTimeout(() => {
        if (connectLatencies.length < i + 1) {
          connectionErrors.push('timeout');
          tryFinish();
        }
      }, 5000);
    }
  });
}

async function measureReportGeneration(reports, store, stations, stationMap, context, count) {
  const latencies = [];
  const errors = [];
  const categories = ['environmental_summary', 'anomaly', 'station_health', 'historical_analytics'];

  for (let i = 0; i < count; i++) {
    try {
      const start = Date.now();
      const result = await reports.generate({
        category: categories[i % categories.length],
        format: 'json',
      }, store, stations, stationMap, context);
      latencies.push(Date.now() - start);
      if (!result || !result.id) errors.push('no report id');
    } catch (e) {
      errors.push(e.message);
    }
  }

  const stats = calcStats(latencies);
  return {
    operation: 'report_generation',
    samples: count,
    errors: errors.length,
    ...stats,
  };
}

async function runBenchmarks() {
  console.log('=== SKYGUARD AI PERFORMANCE VERIFICATION ===\n');
  console.log(`Started at: ${new Date().toISOString()}`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Requests per endpoint: ${REQUEST_COUNT}`);
  console.log(`Runs: ${RUNS}\n`);

  console.log('--- Waiting for server to be ready... ---');
  let serverReady = false;
  let retries = 10;
  while (!serverReady && retries > 0) {
    try {
      const res = await httpRequest('GET', '/api/v1/health');
      if (res.status === 200) { serverReady = true; }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
    retries--;
  }

  if (!serverReady) {
    console.error('Server not ready');
    process.exit(1);
  }
  console.log('Server is ready!\n');

  const results = { timestamp: new Date().toISOString(), runs: [] };

  for (let run = 1; run <= RUNS; run++) {
    console.log(`\n========== RUN ${run} of ${RUNS} ==========\n`);
    const runResult = { run, timestamp: new Date().toISOString(), sections: {} };

    const beforeResources = getResourceSnapshot();
    console.log(`[Run ${run}] Resources BEFORE: PID=${beforeResources.pid}, Uptime=${beforeResources.uptime.toFixed(1)}s, RSS=${beforeResources.memory.rss_mb}MB\n`);

    console.log(`[Run ${run}] === ENDPOINT BENCHMARKS ===`);
    const endpointResults = [];
    for (const endpoint of ENDPOINTS) {
      process.stdout.write(`  ${endpoint}... `);
      const result = await measureEndpoint(endpoint, REQUEST_COUNT);
      endpointResults.push(result);
      console.log(`${result.success}/${result.requests} ok, avg=${result.avg}ms`);
    }
    runResult.sections.endpoints = endpointResults;

    console.log(`\n[Run ${run}] === REAL AGENT TOOL EXECUTION ===`);
    const toolGateway = require('./src/services/toolGateway');
    const toolContext = {
      stations: [{ id: 'STATION-001', name: 'Test Station' }],
      latestByStation: new Map([['STATION-001', { stationId: 'STATION-001', temperature: 25, aqi: 50 }]]),
      store: require('./src/memoryStore')(),
      alerts: [],
      providers: [],
      architecture: {},
      quality: {},
      mlStatus: {},
      systemMetrics: {},
      ragPipeline: null,
      knowledge: null,
      alertsDb: { list: () => [], get: () => null },
    };
    const toolResult = await measureAgentToolExecution(toolGateway, toolContext, 'get_current_readings', {}, 10);
    console.log(`  get_current_readings: ${toolResult.samples} samples, avg=${toolResult.avg}ms, errors=${toolResult.errors}`);
    runResult.sections.agentTool = toolResult;

    console.log(`\n[Run ${run}] === REAL RAG RETRIEVAL ===`);
    const ragPipeline = require('./src/services/ragPipeline');
    const rag = new ragPipeline.RAGPipeline();
    await rag.ingestDocument({ name: 'Test Doc', content: '# Test\n\nThis is a test document about air quality monitoring and environmental data.', category: 'SYSTEM' });
    const ragResult = await measureRAGRetrieval(rag, 'air quality monitoring', { topK: 5 }, 10);
    console.log(`  hybrid retrieval: ${ragResult.samples} samples, avg=${ragResult.avg}ms, errors=${ragResult.errors}`);
    runResult.sections.ragRetrieval = ragResult;

    console.log(`\n[Run ${run}] === REAL SOCKET.IO CONNECTION ===`);
    const socketResult = await measureSocketIOConnections(10);
    console.log(`  connections: ${socketResult.connections}, errors: ${socketResult.connectionErrors}, event: ${socketResult.eventReceived}`);
    console.log(`  latency: avg=${socketResult.avg}ms, p95=${socketResult.p95}ms`);
    runResult.sections.socketIO = socketResult;

    console.log(`\n[Run ${run}] === MONITORING CYCLE ===`);
    const monitoringLoop = require('./src/services/monitoringLoop');
    const { MonitoringLoop } = monitoringLoop;
    const ml = new MonitoringLoop({
      stations: [], store: require('./src/memoryStore')(), latestByStation: new Map(),
      providers: [], alerts: [], maintenanceList: [], qualitySnapshot: null, healthData: null, mlStatus: null,
      knowledgeStats: { documents: 0, chunks: 0, ready: 0, failed: 0 },
      agentStatus: { status: 'IDLE' }, systemMetrics: {}, lastTickAt: null, tickCount: 0, events: [], investigations: new Map(),
    }, null);
    const cycleStart = Date.now();
    ml.start();
    await new Promise(r => setTimeout(r, 3000));
    const cycleDurations = [];
    ml.on('cycle', (data) => { if (data && data.cycleDurationMs !== undefined) cycleDurations.push(data.cycleDurationMs); });
    await new Promise(r => setTimeout(r, 5000));
    ml.stop();
    const cycleStats = calcStats(cycleDurations);
    console.log(`  captured ${cycleDurations.length} cycles, avg=${cycleStats.avg}ms`);
    runResult.sections.monitoringCycle = { samples: cycleDurations.length, ...cycleStats, note: 'via monitoring.on(cycle)' };

    console.log(`\n[Run ${run}] === REPORT GENERATION ===`);
    const reports = require('./src/services/reports');
    const reportsContext = { maintenance: [], quality: { overallScore: 85, completeness: 90, validity: 88 } };
    const reportResult = await measureReportGeneration(reports, require('./src/memoryStore')(), [{ id: 'S1', name: 'Station 1' }], new Map([['S1', { id: 'S1', name: 'Station 1' }]]), reportsContext, 5);
    console.log(`  report generation: ${reportResult.samples} samples, avg=${reportResult.avg}ms, errors=${reportResult.errors}`);
    runResult.sections.reportGeneration = reportResult;

    const afterResources = getResourceSnapshot();
    console.log(`\n[Run ${run}] Resources AFTER: RSS=${afterResources.memory.rss_mb}MB, HeapUsed=${afterResources.memory.heapUsed_mb}MB`);
    const memDelta = { rss_mb: +(afterResources.memory.rss_mb - beforeResources.memory.rss_mb).toFixed(2), heapUsed_mb: +(afterResources.memory.heapUsed_mb - beforeResources.memory.heapUsed_mb).toFixed(2) };
    console.log(`  Memory change: RSS=${memDelta.rss_mb}MB, HeapUsed=${memDelta.heapUsed_mb}MB`);
    runResult.sections.resources = { before: beforeResources, after: afterResources, delta: memDelta };

    const error5xx = endpointResults.reduce((sum, r) => sum + (r.httpErrors || 0), 0);
    const latencySpikes = endpointResults.reduce((sum, r) => sum + (r.max > r.avg * 3 ? 1 : 0), 0);
    console.log(`\n[Run ${run}] Stability: 5xx errors=${error5xx}, Latency spikes=${latencySpikes}`);
    runResult.sections.stability = { errors5xx: error5xx, latencySpikes };

    results.runs.push(runResult);
    console.log(`\n========== RUN ${run} COMPLETE ==========\n`);
  }

  console.log('\n========== LATENCY COMPARISON ==========');
  if (results.runs.length >= 2) {
    const r1 = results.runs[0];
    const r2 = results.runs[1];
    console.log('\nEndpoint avg latency (Run1 vs Run2):');
    for (const ep of r1.sections.endpoints) {
      const ep2 = r2.sections.endpoints.find(e => e.endpoint === ep.endpoint);
      if (ep2) {
        const diff = +(ep2.avg - ep.avg).toFixed(2);
        console.log(`  ${ep.endpoint}: ${ep.avg}ms -> ${ep2.avg}ms (${diff >= 0 ? '+' : ''}${diff}ms)`);
      }
    }
    console.log(`\nAgent tool avg: ${r1.sections.agentTool.avg}ms -> ${r2.sections.agentTool.avg}ms`);
    console.log(`RAG retrieval avg: ${r1.sections.ragRetrieval.avg}ms -> ${r2.sections.ragRetrieval.avg}ms`);
    console.log(`Socket.IO avg: ${r1.sections.socketIO.avg}ms -> ${r2.sections.socketIO.avg}ms`);
  }

  results.summary = {
    performance_measured: true,
    local_benchmark: true,
    formal_sla: false,
    endpoint_summary: results.runs[0].sections.endpoints.map(ep => ({
      endpoint: ep.endpoint, requests: ep.requests, success: ep.success, errors: ep.errors,
      min: ep.min, avg: ep.avg, median: ep.median, p95: ep.p95, max: ep.max,
    })),
  };

  return results;
}

async function main() {
  try {
    const results = await runBenchmarks();
    const fs = require('fs');
    const jsonPath = path.join(__dirname, 'performance-verification-report.json');
    const mdPath = path.join(__dirname, 'performance-verification-report.md');

    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

    let md = `# SKYGUARD AI — PERFORMANCE VERIFICATION REPORT\n\n**Generated:** ${results.timestamp}\n\n---\n\n## PERFORMANCE STATUS\n\n| Metric | Value |\n|--------|-------|\n| performance_measured | YES |\n| local_benchmark | YES |\n| formal_sla | NO |\n\n---\n\n## ENDPOINT TABLE (Run 1)\n\n| endpoint | requests | success | errors | min | avg | median | p95 | max |\n|----------|----------|---------|--------|-----|-----|--------|-----|-----|\n`;
    for (const ep of results.summary.endpoint_summary) {
      md += `| ${ep.endpoint} | ${ep.requests} | ${ep.success} | ${ep.errors} | ${ep.min} | ${ep.avg} | ${ep.median} | ${ep.p95} | ${ep.max} |\n`;
    }

    md += `\n## CORE OPERATIONS (Run 1)\n\n`;
    const tool = results.runs[0].sections.agentTool;
    md += `| tool | samples | errors | min | avg | median | p95 | max |\n|------|---------|--------|-----|-----|--------|-----|-----|\n`;
    md += `| get_current_readings | ${tool.samples} | ${tool.errors} | ${tool.min} | ${tool.avg} | ${tool.median} | ${tool.p95} | ${tool.max} |\n\n`;

    const rag = results.runs[0].sections.ragRetrieval;
    md += `| query | mode | samples | errors | min | avg | median | p95 | max |\n|-------|------|---------|--------|-----|-----|--------|-----|-----|\n`;
    md += `| ${rag.query} | ${rag.mode} | ${rag.samples} | ${rag.errors} | ${rag.min} | ${rag.avg} | ${rag.median} | ${rag.p95} | ${rag.max} |\n\n`;

    const sock = results.runs[0].sections.socketIO;
    md += `| connections | errors | min | avg | median | p95 | max |\n|-------------|--------|-----|-----|--------|-----|-----|\n`;
    md += `| ${sock.connections} | ${sock.connectionErrors} | ${sock.min} | ${sock.avg} | ${sock.median} | ${sock.p95} | ${sock.max} |\n\n`;

    const mc = results.runs[0].sections.monitoringCycle;
    md += `| samples | min | avg | median | p95 | max |\n|---------|-----|-----|--------|-----|-----|\n`;
    md += `| ${mc.samples} | ${mc.min} | ${mc.avg} | ${mc.median} | ${mc.p95} | ${mc.max} |\n\n`;

    const rep = results.runs[0].sections.reportGeneration;
    md += `| operation | samples | errors | min | avg | median | p95 | max |\n|----------|---------|--------|-----|-----|--------|-----|-----|\n`;
    md += `| ${rep.operation} | ${rep.samples} | ${rep.errors} | ${rep.min} | ${rep.avg} | ${rep.median} | ${rep.p95} | ${rep.max} |\n\n`;

    md += `---\n\n## RESOURCE USAGE\n\n`;
    for (let i = 0; i < results.runs.length; i++) {
      const r = results.runs[i];
      md += `### Run ${i + 1}\n\n`;
      md += `| metric | before | after | change |\n|--------|--------|-------|--------|\n`;
      md += `| RSS (MB) | ${r.sections.resources.before.memory.rss_mb} | ${r.sections.resources.after.memory.rss_mb} | ${r.sections.resources.delta.rss_mb} |\n`;
      md += `| HeapUsed (MB) | ${r.sections.resources.before.memory.heapUsed_mb} | ${r.sections.resources.after.memory.heapUsed_mb} | ${r.sections.resources.delta.heapUsed_mb} |\n`;
      md += `| PID | ${r.sections.resources.before.pid} | ${r.sections.resources.after.pid} | - |\n`;
      md += `| Uptime (s) | ${r.sections.resources.before.uptime.toFixed(1)} | ${r.sections.resources.after.uptime.toFixed(1)} | +${(r.sections.resources.after.uptime - r.sections.resources.before.uptime).toFixed(1)} |\n\n`;
    }

    md += `---\n\n## LATENCY COMPARISON: Run 1 vs Run 2\n\n`;
    if (results.runs.length >= 2) {
      const r1 = results.runs[0];
      const r2 = results.runs[1];
      md += `| Endpoint | Run 1 avg | Run 2 avg | Delta |\n|---------|-----------|-----------|-------|\n`;
      for (const ep of r1.sections.endpoints) {
        const ep2 = r2.sections.endpoints.find(e => e.endpoint === ep.endpoint);
        if (ep2) {
          const diff = +(ep2.avg - ep.avg).toFixed(2);
          md += `| ${ep.endpoint} | ${ep.avg}ms | ${ep2.avg}ms | ${diff >= 0 ? '+' : ''}${diff}ms |\n`;
        }
      }
      const toolDiff = +(r2.sections.agentTool.avg - r1.sections.agentTool.avg).toFixed(2);
      const ragDiff = +(r2.sections.ragRetrieval.avg - r1.sections.ragRetrieval.avg).toFixed(2);
      const sockDiff = +(r2.sections.socketIO.avg - r1.sections.socketIO.avg).toFixed(2);
      md += `\n| Agent Tool | ${r1.sections.agentTool.avg}ms | ${r2.sections.agentTool.avg}ms | ${toolDiff >= 0 ? '+' : ''}${toolDiff}ms |\n`;
      md += `| RAG | ${r1.sections.ragRetrieval.avg}ms | ${r2.sections.ragRetrieval.avg}ms | ${ragDiff >= 0 ? '+' : ''}${ragDiff}ms |\n`;
      md += `| Socket.IO | ${r1.sections.socketIO.avg}ms | ${r2.sections.socketIO.avg}ms | ${sockDiff >= 0 ? '+' : ''}${sockDiff}ms |\n`;
    }

    md += `\n---\n\n## REQUEST STABILITY\n\n`;
    for (let i = 0; i < results.runs.length; i++) {
      const s = results.runs[i].sections.stability;
      md += `Run ${i + 1}: 5xx errors=${s.errors5xx}, Latency spikes=${s.latencySpikes}\n`;
    }

    md += `\n---\n\n**Note:** Performance measured locally; no formal SLA defined.\n`;
    md += `**Note:** Monitoring cycle latency captured via monitoring.on('cycle') listener.\n`;

    fs.writeFileSync(mdPath, md);

    console.log('\n========== FINAL OUTPUT ==========\n');
    console.log('PERFORMANCE:');
    console.log('  measured = YES');
    console.log('  local benchmark = YES');
    console.log('  formal SLA = NO\n');

    console.log('ENDPOINT TABLE:');
    console.log('endpoint | requests | success | errors | min | avg | median | p95 | max');
    for (const ep of results.summary.endpoint_summary) {
      console.log(`${ep.endpoint} | ${ep.requests} | ${ep.success} | ${ep.errors} | ${ep.min} | ${ep.avg} | ${ep.median} | ${ep.p95} | ${ep.max}`);
    }

    console.log('\nCORE OPERATIONS:');
    const toolData = results.runs[0].sections.agentTool;
    console.log(`agent_tool | ${toolData.samples} | ${toolData.errors} | ${toolData.min} | ${toolData.avg} | ${toolData.median} | ${toolData.p95} | ${toolData.max}`);
    const ragData = results.runs[0].sections.ragRetrieval;
    console.log(`rag_retrieval | ${ragData.samples} | ${ragData.errors} | ${ragData.min} | ${ragData.avg} | ${ragData.median} | ${ragData.p95} | ${ragData.max}`);
    const repData = results.runs[0].sections.reportGeneration;
    console.log(`report_generation | ${repData.samples} | ${repData.errors} | ${repData.min} | ${repData.avg} | ${repData.median} | ${repData.p95} | ${repData.max}`);

    console.log('\nSOCKET.IO:');
    const sockData = results.runs[0].sections.socketIO;
    console.log(`connections=${sockData.connections} | errors=${sockData.connectionErrors} | min=${sockData.min} | avg=${sockData.avg} | median=${sockData.median} | p95=${sockData.p95} | max=${sockData.max}`);

    console.log('\nMONITORING CYCLE:');
    const mcData = results.runs[0].sections.monitoringCycle;
    console.log(`samples=${mcData.samples} | min=${mcData.min}ms | avg=${mcData.avg}ms | median=${mcData.median}ms | p95=${mcData.p95}ms | max=${mcData.max}ms`);

    console.log('\nRESOURCE USAGE:');
    const res = results.runs[0].sections.resources;
    console.log('metric | before | after | change');
    console.log(`RSS_MB | ${res.before.memory.rss_mb} | ${res.after.memory.rss_mb} | ${res.delta.rss_mb}`);
    console.log(`HeapUsed_MB | ${res.before.memory.heapUsed_mb} | ${res.after.memory.heapUsed_mb} | ${res.delta.heapUsed_mb}`);

    console.log('\nFINAL STATUS:');
    console.log('  MEASURED\n');

    console.log(`\nReports saved to:`);
    console.log(`  ${jsonPath}`);
    console.log(`  ${mdPath}`);

    process.exit(0);
  } catch (e) {
    console.error('Benchmark failed:', e);
    process.exit(1);
  }
}

main();
