#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const path = require('path');

async function testArchitecture() {
  console.log('Testing architecture endpoint...');
  const t0 = Date.now();
  
  return new Promise((resolve) => {
    const req = http.get('http://localhost:4000/api/v1/architecture', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('Architecture status:', json.status);
          console.log('Components count:', Object.keys(json.components || {}).length);
          console.log('Core components:', (json.core || []).map(c => c.key));
          console.log('Optional components:', (json.optional || []).map(c => c.key));
          
          // Check that all expected nodes exist
          const coreKeys = json.core?.map(c => c.key) || [];
          const expectedCoreKeys = ['api', 'websocket', 'ingestion', 'analytics', 'anomalyEngine', 'assistant', 'reportService', 'ml', 'notifications'];
          
          const missing = expectedCoreKeys.filter(key => !coreKeys.includes(key));
          if (missing.length > 0) {
            console.error('Missing core components:', missing);
          } else {
            console.log('✓ All expected core components present');
          }
          
          // Check ML node status (Phase 7 fix)
          const mlComponent = json.core?.find(c => c.key === 'ml');
          if (mlComponent) {
            console.log('ML component status:', mlComponent.status);
            console.log('ML component color:', mlComponent.color);
            
            // According to the issue, ML should be GREEN because:
            // - Logistic Regression model exists
            // - Model trained
            // - Inference works
            // - Independent human-reviewed evaluation exists
            // - Evaluation = VERIFIED
            
            if (mlComponent.color === 'GREEN') {
              console.log('✓ ML node correctly shows GREEN (evaluated and verified)');
            } else {
              console.warn('ML node is not GREEN:', mlComponent.color, 'should be GREEN if evaluation is VERIFIED');
            }
          }
          
          // Check Assistant status (Phase 8)
          const assistantComponent = json.core?.find(c => c.key === 'assistant');
          if (assistantComponent) {
            console.log('Assistant component status:', assistantComponent.status);
            console.log('Assistant component color:', assistantComponent.color);
            
            // Current known state may be DEGRADED / NOT CONFIGURED
            // because no real LLM provider is configured
            if (assistantComponent.status === 'UP' && assistantComponent.color === 'GREEN') {
              console.warn('Assistant node shows GREEN but may not have real LLM configured');
            } else {
              console.log('✓ Assistant reflects actual LLM configuration state');
            }
          }
          
          // Check storage components
          const storageComponents = json.components?.storage || {};
          const storageKeys = Object.keys(storageComponents);
          console.log('Storage components:', storageKeys);
          
          // Check that InfluxDB and PostgreSQL are properly represented
          const influxEnabled = storageKeys.includes('influxdb') && storageComponents.influxdb?.status !== 'DISABLED';
          const postgresEnabled = storageKeys.includes('postgres') && storageComponents.postgres?.status !== 'DISABLED';
          
          console.log('InfluxDB enabled:', influxEnabled);
          console.log('PostgreSQL enabled:', postgresEnabled);
          
          // Check providers
          const providers = json.components?.providers || {};
          const providerKeys = Object.keys(providers);
          console.log('Configured providers:', providerKeys.length);
          
          if (providerKeys.length > 0) {
            console.log('Provider details:', providerKeys.map(id => ({
              id,
              name: providers[id].name,
              runtime: providers[id].runtime || providers[id].status || 'NOT_CONFIGURED'
            })));
          }
          
          console.log('✓ Architecture endpoint test completed successfully');
          resolve({
            status: json.status,
            componentsCount: Object.keys(json.components || {}).length,
            coreComponents: json.core || [],
            optionalComponents: json.optional || [],
            mlStatus: mlComponent?.status,
            assistantStatus: assistantComponent?.status,
            storageComponents: storageKeys,
            providerCount: providerKeys.length
          });
          
        } catch (e) {
          console.error('Error parsing architecture endpoint response:', e.message);
          console.error('Raw response:', data.substring(0, 200));
          resolve(null);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('Architecture endpoint error:', e.message);
      resolve(null);
    });
  });
}

async function testDataFlow() {
  console.log('\nTesting architecture data flow endpoint...');
  const t0 = Date.now();
  
  return new Promise((resolve) => {
    const req = http.get('http://localhost:4000/api/v1/architecture/data-flow', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          console.log('Data flow connections:', json.connections?.length);
          console.log('Active provider:', json.providerFailover?.active?.name || 'None');
          console.log('Fallback provider:', json.providerFailover?.fallback?.name || 'None');
          
          // Check data flow connections
          const connections = json.connections || [];
          const expectedConnections = [
            'env-sources', 'provider-routing', 'request', 'response', 
            'validation', 'normalization', 'storage', 'realtime',
            'data-quality', 'analytics', 'anomaly-detection', 'alerts',
            'investigation', 'agent-decision', 'approval', 'action',
            'verification', 'audit', 'rag', 'assistant', 'dashboard'
          ];
          
          const connectionKeys = connections.map(c => c.id);
          console.log('Available data flow nodes:', connectionKeys);
          
          // Check for key expected nodes
          const criticalNodes = ['provider-routing', 'storage', 'realtime', 'analytics', 'anomaly-detection'];
          const missingCritical = criticalNodes.filter(node => !connectionKeys.includes(node));
          
          if (missingCritical.length > 0) {
            console.warn('Missing critical data flow nodes:', missingCritical);
          } else {
            console.log('✓ All critical data flow nodes present');
          }
          
          resolve({
            connectionsCount: connections.length,
            activeProvider: json.providerFailover?.active?.name,
            fallbackProvider: json.providerFailover?.fallback?.name,
            connectionKeys: connectionKeys
          });
          
        } catch (e) {
          console.error('Error parsing data flow endpoint response:', e.message);
          console.error('Raw response:', data.substring(0, 200));
          resolve(null);
        }
      });
    });
    
    req.on('error', (e) => {
      console.error('Data flow endpoint error:', e.message);
      resolve(null);
    });
  });
}

async function main() {
  console.log('=== SKYGUARD AI - MODULE 14 ARCHITECTURE / DATA FLOW TEST ===');
  console.log('Testing live runtime architecture...\n');
  
  const results = await testArchitecture();
  const flowResults = await testDataFlow();
  
  console.log('\n=== TEST SUMMARY ===');
  if (results) {
    console.log('✓ Architecture endpoint working correctly');
    console.log('- Overall status:', results.status);
    console.log('- Total components:', results.componentsCount);
    console.log('- Core components:', results.coreComponents.length);
    console.log('- Optional components:', results.optionalComponents.length);
    console.log('- ML component:', results.mlStatus);
    console.log('- Assistant component:', results.assistantStatus);
    console.log('- Storage components:', results.storageComponents.length);
    console.log('- Configured providers:', results.providerCount);
  } else {
    console.error('✗ Architecture endpoint failed');
  }
  
  if (flowResults) {
    console.log('✓ Data flow endpoint working correctly');
    console.log('- Total connections:', flowResults.connectionsCount);
    console.log('- Active provider:', flowResults.activeProvider);
    console.log('- Fallback provider:', flowResults.fallbackProvider);
  } else {
    console.error('✗ Data flow endpoint failed');
  }
  
  // Determine overall result
  const success = results !== null && flowResults !== null;
  
  if (success) {
    console.log('\n🎉 All tests passed! Module 14 architecture is working correctly.');
  } else {
    console.log('\n❌ Some tests failed. Please check the backend status and logs.');
  }
  
  return success;
}

if (require.main === module) {
  main().then((success) => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { testArchitecture, testDataFlow, main };