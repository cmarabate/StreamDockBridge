const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SERVICE_PORT = 17337;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXTENSION_PATH = path.resolve(__dirname, '../packages/extension');
const TEMP_USER_DATA = 'C:\\Temp\\sdb-chrome-val-data';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, data });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runValidation() {
  console.log('--- STREAMDOCKBRIDGE REAL CHROME VALIDATION ---');

  // 1. Start Localhost Service
  console.log('\n[STEP 1] Starting Bridge Service on 127.0.0.1:17337...');
  const { createBridgeServer } = require('../packages/service/dist/server');
  const service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1' });
  await service.start();
  console.log('Service started successfully.');

  // 2. Kill existing Chrome processes
  try {
    execSync('powershell "Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'ignore' });
  } catch (e) {}
  await sleep(1500);

  if (fs.existsSync(TEMP_USER_DATA)) {
    try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true }); } catch (e) {}
  }

  // 3. Launch real Chrome with remote debugging & load extension
  console.log('\n[STEP 2 & 3] Launching real Google Chrome with unpacked extension...');
  const chromeArgs = [
    `--remote-debugging-port=9222`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `https://www.imdb.com/title/tt1234567/`
  ];

  const chromeProc = spawn(CHROME_PATH, chromeArgs, { detached: true, stdio: 'ignore' });
  chromeProc.unref();

  // Retry CDP connection up to 10 seconds
  let targetsRes = null;
  for (let i = 0; i < 10; i++) {
    await sleep(1000);
    try {
      targetsRes = await fetchJson(`http://127.0.0.1:9222/json`);
      if (targetsRes.status === 200) break;
    } catch (e) {}
  }

  if (!targetsRes || !targetsRes.data) {
    throw new Error('Could not connect to Chrome CDP on port 9222 after launch.');
  }

  console.log(`Connected to Chrome CDP! Found ${targetsRes.data.length} targets.`);

  // Wait for extension to send initial context
  await sleep(3000);
  let ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
  console.log('\nInitial Extension Context Output:');
  console.log(JSON.stringify(ctxRes.data, null, 2));

  // 4. Create Tab B
  console.log('\n[STEP 6 & 7] Creating Tab B (Crunchyroll) via CDP...');
  const tabBRes = await fetchJson(`http://127.0.0.1:9222/json/new?https://www.crunchyroll.com/series/G123/dandadan`);
  console.log(`Tab B Created: ${tabBRes.data.url}`);
  await sleep(3000);

  ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
  console.log('Tab B Context Output:');
  console.log(JSON.stringify(ctxRes.data, null, 2));

  // 5. Switch activation back to Tab A
  const tabA = targetsRes.data.find(t => t.type === 'page');
  if (tabA) {
    console.log('\n[STEP 8] Switching activation back to Tab A...');
    await fetchJson(`http://127.0.0.1:9222/json/activate/${tabA.id}`);
    await sleep(2000);

    ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    console.log('Tab A Reactivated Context Output:');
    console.log(JSON.stringify(ctxRes.data, null, 2));
  }

  // 6. Test Default Browser Lookup Actions
  console.log('\n[STEP 9 & 10] Testing default-browser lookup actions...');
  const lookupRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
  console.log('POST /lookup/imdb Response:');
  console.log(JSON.stringify(lookupRes.data, null, 2));

  // 7. Test No-Context Error Behavior
  console.log('\n[STEP 11] Testing no-context error handling...');
  const { contextStore } = require('../packages/service/dist/contextStore');
  contextStore.clear();

  const noCtxRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
  console.log('No-Context POST /lookup/imdb Response:');
  console.log(JSON.stringify(noCtxRes.data, null, 2));

  await service.stop();
  try { execSync('powershell "Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'ignore' }); } catch (e) {}
  console.log('\n--- REAL CHROME VALIDATION COMPLETE ---');
}

runValidation().catch((err) => {
  console.error('Validation failed:', err);
  process.exit(1);
});
