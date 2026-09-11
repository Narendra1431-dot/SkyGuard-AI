const http = require('http');
async function test() {
  console.log('Testing architecture endpoint...');
  const t0 = Date.now();
  http.get('http://localhost:4000/api/v1/architecture', (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('Done in', Date.now() - t0, 'ms');
      const json = JSON.parse(data);
      console.log('Architecture status:', json.status);
      console.log('Components count:', Object.keys(json.components || {}).length);
      console.log('Core components:', (json.core || []).map(c => c.key));
      console.log('Optional components:', (json.optional || []).map(c => c.key));
      
      // Check that all expected nodes exist
      const coreKeys = json.core?.map(c => c.key) || [];
      const expectedCoreKeys = ['api', 'websocket', 'ingestion', 'analytics', 'anomalyEngine', 'assistant', 'reportService', 'ml', 'notifications'];
      
      for (const key of expectedCoreKeys) {
        if (!coreKeys.includes(key)) {
          console.error(`Missing core component: ${key}`);
        }
      }
      
      // Check ML node uses canonical ML health (should be GREEN if evaluation VERIFIED)
      const mlComponent = json.core?.find(c => c.key === 'ml');
      if (mlComponent) {
        console.log('ML component status:', mlComponent.status);
        console.log('ML component color:', mlComponent.color);
        
        // ML node should reflect actual ML health
        // According to the issue, current ML truth:
        // - Logistic Regression model exists
        // - Model trained
        // - Inference works
        // - Independent human-reviewed evaluation exists
        // - Evaluation = VERIFIED
        // - ML Health should be GREEN when verified
        
        if (mlComponent.color !== 'GREEN') {
          console.warn('ML node is not GREEN:', mlComponent.color, 'should be GREEN if evaluation is VERIFIED');
        } else {
          console.log('✓ ML node correctly shows GREEN (evaluated and verified)');
        }
      }
      
      // Check that assistant reflects actual LLM configuration (not hardcoded GREEN)
      const assistantComponent = json.core?.find(c => c.key === 'assistant');
      if (assistantComponent) {
        console.log('Assistant component status:', assistantComponent.status);
        console.log('Assistant component color:', assistantComponent.color);
        
        // Current known state may be DEGRADED / NOT CONFIGURED
        // because no real LLM provider is configured
        if (assistantComponent.status === 'UP' && assistantComponent.color === 'GREEN') {
          console.warn('Assistant node shows GREEN but may not have real LLM configured');
        }
      }
      
    });
  }).on('error', (e) => {
    console.error('Error:', e.message);
  });
}

// Test architecture data flow endpoint as well
async function testDataFlow() {
  console.log('\nTesting architecture data flow endpoint...');
  const t0 = Date.now();
  http.get('http://localhost:4000/api/v1/architecture/data-flow', (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('Data flow Done in', Date.now() - t0, 'ms');
      const json = JSON.parse(data);
      console.log('Data flow connections:', json.connections?.length);
      console.log('Active provider:', json.providerFailover?.active?.name || 'None');
    });
  }).on('error', (e) => {
    console.error('Data flow Error:', e.message);
  });
}

async function runAllTests() {
  await test();
  await testDataFlow();
  console.log('\nAll tests completed!');
}

runAllTests();
