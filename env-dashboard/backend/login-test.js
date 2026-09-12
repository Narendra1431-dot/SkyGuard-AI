const http = require('http');

const data = JSON.stringify({
  username: 'admin',
  password: 'admin123!Change'
});

const options = {
  hostname: 'localhost',
  port: 4000,
  path: '/api/v1/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = http.request(options, (res) => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', JSON.stringify(res.headers, null, 2));
  
  let body = '';
  res.on('data', chunk => {
    body += chunk;
    process.stdout.write(chunk.toString()); // Show response as it comes
  });
  res.on('end', () => {
    try {
      const jsonBody = JSON.parse(body);
      console.log('\n\nParsed response:', JSON.stringify(jsonBody, null, 2));
    } catch (e) {
      console.log('\n\nRaw response:', body);
    }
  });
});

req.on('error', e => console.error('Error:', e));
req.on('timeout', () => {
  console.error('Request timeout');
  req.destroy();
});

req.setTimeout(30000);
req.write(data);
req.end();
