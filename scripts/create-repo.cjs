const { execSync } = require('child_process');
const https = require('https');

// Get token from Windows Credential Manager
const creds = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n'
}).toString();
const token = creds.split('\n')
  .find(l => l.startsWith('password='))
  ?.replace('password=', '').trim();

if (!token) {
  console.error('ERROR: No GitHub token found in credential manager');
  process.exit(1);
}

// Create the repo via API
const body = JSON.stringify({
  name: 'honeycomb-trial',
  description: 'Honeycomb Trial — endless needle-tracing survival game for Android',
  private: false,
  has_issues: true,
  has_projects: false,
  has_wiki: false,
  auto_init: false
});

const options = {
  hostname: 'api.github.com',
  path: '/user/repos',
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
      console.log('SUCCESS: Repo created:', json.html_url);
      console.log('CLONE_URL:', json.clone_url);
    } else if (res.statusCode === 422) {
      console.log('ALREADY_EXISTS: Repo already exists');
      console.log('CLONE_URL: https://github.com/Sajawal07/honeycomb-trial.git');
    } else {
      console.error('FAILED:', res.statusCode, JSON.stringify(json));
      process.exit(1);
    }
  });
});

req.on('error', e => { console.error('REQUEST_ERROR:', e.message); process.exit(1); });
req.write(body);
req.end();
