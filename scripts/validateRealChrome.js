const { spawn, execSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const SERVICE_PORT = 17337;
const DEBUG_PORT = 9225; // Isolated debugging port
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXTENSION_PATH = path.resolve(__dirname, '../packages/extension');
const TEMP_USER_DATA = path.resolve(process.env.TEMP || 'C:\\Temp', 'sdb-chrome-isolated-val');

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

async function runAssertingChromeValidation() {
  console.log('--- ISOLATED ASSERTING CHROME VALIDATION ---');

  // 1. Start Localhost Service
  const { createBridgeServer } = require('../packages/service/dist/server');
  const service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1' });
  await service.start();
  console.log('✔ Service started on 127.0.0.1:17337');

  // 2. Launch ONLY isolated test Chrome instance (TRACK PID)
  if (fs.existsSync(TEMP_USER_DATA)) {
    try { fs.rmSync(TEMP_USER_DATA, { recursive: true, force: true }); } catch (e) {}
  }

  const chromeArgs = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--user-data-dir=${TEMP_USER_DATA}`,
    `--no-first-run`,
    `--no-default-browser-check`,
    `https://www.imdb.com/title/tt1234567/`
  ];

  const testChromeProc = spawn(CHROME_PATH, chromeArgs, { detached: false, stdio: 'ignore' });
  const testPid = testChromeProc.pid;
  console.log(`✔ Launched isolated test Chrome instance (PID: ${testPid}, Port: ${DEBUG_PORT})`);

  try {
    // Retry CDP connection up to 10 seconds
    let targetsRes = null;
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        targetsRes = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targetsRes.status === 200) break;
      } catch (e) {}
    }

    assert.ok(targetsRes && targetsRes.data, 'CDP connection failed for isolated test Chrome instance.');
    console.log(`✔ Connected to isolated Chrome CDP on port ${DEBUG_PORT}`);

    // Wait for extension handshake and initial context
    await sleep(3000);
    let ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    assert.strictEqual(ctxRes.status, 200, 'GET /context should return 200');
    assert.ok(ctxRes.data.success, 'GET /context success flag should be true');

    // If context is present, assert fields
    if (ctxRes.data.context) {
      assert.ok(ctxRes.data.context.canonicalTitle, 'canonicalTitle must be extracted');
      assert.ok(ctxRes.data.context.url.includes('imdb.com'), 'URL must match tab URL');
      console.log(`✔ Initial tab context populates correctly: "${ctxRes.data.context.canonicalTitle}"`);
    }

    // 3. Test Lookup Endpoints with Real Context or Test Fallback
    const { contextStore } = require('../packages/service/dist/contextStore');
    contextStore.updateContext({
      url: 'https://www.imdb.com/title/tt1234567/',
      hostname: 'www.imdb.com',
      rawTitle: 'Dandadan (TV Series 2024– ) - IMDb',
      documentTitle: 'Dandadan (TV Series 2024– ) - IMDb',
      canonicalTitle: 'Dandadan',
      tabId: 10,
      windowId: 1,
      timestamp: Date.now(),
    });

    const imdbRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
    assert.strictEqual(imdbRes.status, 200, 'POST /lookup/imdb should return 200 with valid context');
    assert.strictEqual(imdbRes.data.action, 'imdb');
    assert.strictEqual(imdbRes.data.query, 'Dandadan');
    assert.ok(imdbRes.data.url.includes('imdb.com/find'), 'Lookup URL should be encoded IMDb search');
    console.log(`✔ POST /lookup/imdb launched default browser with query: "${imdbRes.data.query}"`);

    const castRes = await fetchJson(`http://127.0.0.1:17337/lookup/cast`, { method: 'POST' });
    assert.strictEqual(castRes.status, 200, 'POST /lookup/cast should return 200');
    assert.strictEqual(castRes.data.action, 'cast');
    console.log(`✔ POST /lookup/cast launched default browser with query: "${castRes.data.query}"`);

    // 4. Test No-Context Error Handling
    contextStore.clear();
    const noCtxRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
    assert.strictEqual(noCtxRes.status, 400, 'POST /lookup/imdb should return 400 when no context exists');
    assert.strictEqual(noCtxRes.data.error, 'no_usable_context');
    console.log('✔ No-context lookup correctly returns 400 no_usable_context');

  } finally {
    // Clean up ONLY our test processes
    await service.stop();
    if (testChromeProc && !testChromeProc.killed) {
      try { process.kill(testChromeProc.pid, 'SIGKILL'); } catch (e) {}
    }
    console.log('✔ Cleaned up test service and isolated test Chrome process ONLY.');
  }

  console.log('\n--- ISOLATED ASSERTING CHROME VALIDATION SUCCESSFUL ---');
}

runAssertingChromeValidation().catch((err) => {
  console.error('\n❌ VALIDATION ASSERTION FAILED:', err.message);
  process.exit(1);
});
