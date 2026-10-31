const https = require('https');
const { execSync } = require('child_process');

const creds = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n'
}).toString();
const token = creds.split('\n')
  .find(l => l.startsWith('password='))
  ?.replace('password=', '').trim();

const body = JSON.stringify({
  source: { branch: 'main', path: '/docs' }
});

const options = {
  hostname: 'api.github.com',
  path: '/repos/Sajawal07/honeycomb-trial/pages',
  method: 'POST',
  headers: {
    'Authorization': `token ${token}`,
    'User-Agent': 'Node.js',
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept': 'application/vnd.github.v3+json'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    const json = JSON.parse(data);
    if (res.statusCode === 201) {
      console.log('SUCCESS: GitHub Pages enabled!');
      console.log('Pages URL:', json.html_url);
    } else if (res.statusCode === 409) {
      console.log('ALREADY_ENABLED: GitHub Pages was already set up');
    } else {
      console.log('STATUS:', res.statusCode);
      console.log('RESPONSE:', JSON.stringify(json, null, 2));
    }
  });
});

req.on('error', e => console.error('ERROR:', e.message));
req.write(body);
req.end();
