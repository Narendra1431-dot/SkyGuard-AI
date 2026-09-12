const http = require('http');

// Function to make login request
function testLogin(username, password, callback) {
  const data = JSON.stringify({ username, password });
  const options = {
    hostname: 'localhost',
    port: 4000,
    path: '/api/v1/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        callback(null, { statusCode: res.statusCode, success: json.success, message: json.error ? json.error.message : null, json });
      } catch (e) {
        callback(null, { statusCode: res.statusCode, success: false, message: 'Invalid JSON response', body });
      }
    });
  });

  req.on('error', error => callback(error));
  req.write(data);
  req.end();
}

console.log('=== TESTING INVALID LOGIN RATE LIMIT ===');

// Test 1: Successful login first
testLogin('admin', 'admin123!Change', (err, result) => {
  if (err) {
    console.log('Error:', err.message);
    return;
  }
  console.log('Test 1 - Successful login:');
  console.log('Status:', result.statusCode);
  console.log('Success:', result.success);
  if (!result.success) console.log('Message:', result.message);
  console.log('---');
  
  // Test 2: Invalid login (wrong password)
  testLogin('admin', 'wrongpassword123', (err2, result2) => {
    if (err2) {
      console.log('Error:', err2.message);
      return;
    }
    console.log('Test 2 - Invalid login (wrong password):');
    console.log('Status:', result2.statusCode);
    console.log('Success:', result2.success);
    if (!result2.success) console.log('Message:', result2.message);
    console.log('---');
    
    // Test 3: Check rate limit stats
    const auth = require('./src/middleware/auth');
    const stats = auth.getRateLimitStoreStats();
    console.log('Test 3 - Rate limit stats:');
    console.log('Total buckets:', stats.totalBuckets);
    console.log('Buckets:');
    stats.buckets.forEach((bucket, idx) => {
      console.log('  Bucket', idx + 1, ':');
      console.log('    Key:', bucket.key);
      console.log('    Count:', bucket.count);
      console.log('    Reset At:', bucket.resetAt);
      console.log('    Remaining Window:', bucket.remainingWindowMs, 'ms');
    });
    console.log('---');
    
    // Test 4: More invalid attempts to trigger rate limit
    console.log('Test 4 - Making 29 more invalid attempts...');
    let attempts = 0;
    const maxAttempts = 29;
    
    function makeMoreAttempts() {
      if (attempts >= maxAttempts) {
        // Check final stats
        const finalStats = auth.getRateLimitStoreStats();
        console.log('Test 4 Complete - Final stats:');
        console.log('Total buckets:', finalStats.totalBuckets);
        finalStats.buckets.forEach((bucket, idx) => {
          console.log('  Bucket', idx + 1, ': Key=', bucket.key, ', Count=', bucket.count, ', ResetAt=', bucket.resetAt);
        });
        return;
      }
      
      attempts++;
      testLogin('admin', 'wrongpassword123', (err3, result3) => {
        console.log('  Attempt', attempts, ': Status=', result3.statusCode, ', Success=', result3.success);
        if (result3.statusCode === 429) {
          console.log('  ⚠️  RATE LIMITED!');
        }
        makeMoreAttempts();
      });
    }
    
    makeMoreAttempts();
  });
});
