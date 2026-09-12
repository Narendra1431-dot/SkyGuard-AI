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
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => console.log(body));
});

req.on('error', e => console.error('Error:', e));
req.write(data);
req.end();
