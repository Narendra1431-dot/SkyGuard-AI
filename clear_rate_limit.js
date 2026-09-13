const fs = require('fs');
const path = require('path');

function clearRateLimitStore() {
  try {
    const authPath = path.join(__dirname, 'src', 'middleware', 'auth.js');
    const content = fs.readFileSync(authPath, 'utf8');
    
    // Check if rateLimitBuckets is exported or can be reset
    if (content.includes('rateLimitBuckets = new Map()') || 
        content.includes('const rateLimitBuckets = new Map()')) {
      console.log('[DEV] Rate limit store is in-memory (Map)');
      console.log('[DEV] In-memory stores do not persist across backend restarts');
      console.log('[DEV] Clearing the store requires a backend restart or process reload');
      console.log('[DEV] Safe development approach: restart the backend process');
      console.log('[DEV] Backend restart will clear all in-memory rate limits');
      return { cleared: false, method: 'restart_required' };
    }
    
    return { cleared: false, method: 'not_found' };
  } catch (error) {
    console.error('[DEV] Error checking auth.js:', error.message);
    return { cleared: false, method: 'error', error: error.message };
  }
}

function manualClearCommand() {
  console.log('\n=== SKYGUARD AI - RATE LIMIT CLEAR ===');
  console.log('STATUS: In-memory rate limit store');
  console.log('THREAT LEVEL: LOW - only affects development debugging');
  console.log('');
  console.log('CURRENT RATE LIMIT STORE STATE:');
  console.log('- Backend restart clears all in-memory rate limits');
  console.log('- Safe for development: yes');
  console.log('- Safe for production: not applicable (in-memory only)');
  console.log('');
  console.log('MANUAL CLEAR METHOD:');
  console.log('1. Find backend process ID: tasklist | findstr node');
  console.log('2. Kill the backend process: taskkill /F /PID <PID>');
  console.log('3. Restart the backend: npm start or docker-compose up');
  console.log('');
  console.log('ALTERNATIVE (if running in docker-compose):');
  console.log('- Restart the backend service: docker-compose restart backend');
  console.log('- OR rebuild and restart: docker-compose build --no-cache backend');
  console.log('');
  console.log('WARNING: Clearing rate limits temporarily reduces security protection');
  console.log('RESUME SECURITY: Immediately after clearing, test login functionality');
  console.log('');
}

function testLoginCount() {
  console.log('\n=== DEBUGGING TOOL ===');
  console.log('To check current rate limit state in development:');
  console.log('1. Add debug logging to auth.js: middleware/auth.js:66-69');
  console.log('2. Restart backend to load modified code');
  console.log('3. Check console logs for rate limit hits');
  console.log('4. Monitor rateLimitBuckets size');
  console.log('');
  console.log('MODIFICATION NEEDED: Add debug logging to auth.js middleware/auth.js:58-82');
  return { needs_modification: true, file: 'src/middleware/auth.js' };
}

clearRateLimitStore();
manualClearCommand();
testLoginCount();
