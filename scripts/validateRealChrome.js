process.env.NODE_ENV = 'test';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const SERVICE_PORT = 17337;
const HTTP_TEST_PORT = 8089;
const DEBUG_PORT = 9225;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXTENSION_PATH = path.resolve(__dirname, '../packages/extension');
const TEMP_USER_DATA = path.resolve(process.env.TEMP || 'C:\\Temp', 'sdb-chrome-real-val');

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

async function runRealChromeValidation() {
  console.log('--- STREAMDOCKBRIDGE REAL CHROME ASSERTING INTEGRATION HARNESS ---');

  const testServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Dandadan Watch Page - Crunchyroll</title>
  <meta property="og:title" content="Dandadan - Watch on Crunchyroll" />
  <meta name="twitter:title" content="Dandadan" />
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", "name": "Crunchyroll" },
        { "@type": "TVSeries", "name": "Dandadan" }
      ]
    }
  </script>
</head>
<body><h1>Dandadan Test Page</h1></body>
</html>`);
  });

  await new Promise((resolve) => testServer.listen(HTTP_TEST_PORT, '127.0.0.1', resolve));
  console.log(`✔ [1] Test HTTP Server running on http://127.0.0.1:${HTTP_TEST_PORT}`);

  const { createBridgeServer } = require('../packages/service/dist/server');
  let service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1', allowAnyExtensionOrigin: true });
  await service.start();
  console.log(`✔ [2] Bridge Service running on 127.0.0.1:${SERVICE_PORT}`);

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
    `http://127.0.0.1:${HTTP_TEST_PORT}/media_test.html`
  ];

  const testChromeProc = spawn(CHROME_PATH, chromeArgs, { detached: false, stdio: 'ignore' });
  const testPid = testChromeProc.pid;
  console.log(`✔ [3] Launched isolated test Chrome instance (PID: ${testPid}, Debug Port: ${DEBUG_PORT})`);

  try {
    let targetsRes = null;
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        targetsRes = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targetsRes.status === 200) break;
      } catch (e) {}
    }

    assert.ok(targetsRes && targetsRes.data, 'CDP connection failed for test Chrome instance.');
    console.log(`✔ [4] Connected to Chrome CDP on port ${DEBUG_PORT}`);

    await sleep(2000);
    const updatedTargets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const extTarget = updatedTargets.data.find((t) => t.url && t.url.startsWith('chrome-extension://'));
    assert.ok(extTarget, 'Extension service worker target must be discovered in Chrome CDP');
    console.log(`✔ [5] Verified Chrome Extension background worker target: ${extTarget.url}`);

    // Wait for extension context population from real Chrome tab
    let ctxRes = null;
    for (let i = 0; i < 15; i++) {
      ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
      if (ctxRes.status === 200 && ctxRes.data.context) break;
      await sleep(1000);
    }

    assert.strictEqual(ctxRes.status, 200, 'GET /context should return 200');
    assert.ok(ctxRes.data.success, 'GET /context success flag should be true');

    // STRICT ASSERTION: Real extension MUST populate non-null context!
    assert.ok(ctxRes.data.context, 'Real extension MUST populate non-null context!');
    const activeContext = ctxRes.data.context;
    assert.strictEqual(activeContext.canonicalTitle, 'Dandadan', 'Derived canonicalTitle should be "Dandadan"');
    console.log(`✔ [6] Real Extension populated context: canonicalTitle="${activeContext.canonicalTitle}"`);

    // 3. Test Lookups using ONLY Extension-Derived Context
    console.log('\n--- TESTING LOOKUP ENDPOINTS (REAL CONTEXT) ---');
    const imdbRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
    assert.strictEqual(imdbRes.status, 200, 'POST /lookup/imdb should return 200');
    assert.strictEqual(imdbRes.data.action, 'imdb');
    assert.strictEqual(imdbRes.data.query, 'Dandadan');
    assert.ok(imdbRes.data.url.includes('imdb.com/find?q=Dandadan'), 'IMDb URL must contain encoded query');
    console.log(`✔ POST /lookup/imdb -> ${imdbRes.data.url}`);

    const castRes = await fetchJson(`http://127.0.0.1:17337/lookup/cast`, { method: 'POST' });
    assert.strictEqual(castRes.status, 200, 'POST /lookup/cast should return 200');
    assert.strictEqual(castRes.data.action, 'cast');
    assert.strictEqual(castRes.data.query, 'Dandadan');
    console.log(`✔ POST /lookup/cast -> ${castRes.data.url}`);

    const jwRes = await fetchJson(`http://127.0.0.1:17337/lookup/justwatch`, { method: 'POST' });
    assert.strictEqual(jwRes.status, 200, 'POST /lookup/justwatch should return 200');
    assert.strictEqual(jwRes.data.action, 'justwatch');
    assert.strictEqual(jwRes.data.query, 'Dandadan');
    console.log(`✔ POST /lookup/justwatch -> ${jwRes.data.url}`);

    const redditRes = await fetchJson(`http://127.0.0.1:17337/lookup/reddit`, { method: 'POST' });
    assert.strictEqual(redditRes.status, 200, 'POST /lookup/reddit should return 200');
    assert.strictEqual(redditRes.data.action, 'reddit');
    assert.strictEqual(redditRes.data.query, 'Dandadan');
    console.log(`✔ POST /lookup/reddit -> ${redditRes.data.url}`);

    // 4. Quiet Service Restart Recovery Test
    console.log('\n--- TESTING QUIET SERVICE RESTART RECOVERY ---');
    await service.stop();
    console.log('Stopped service. Context is cleared.');

    service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1', allowAnyExtensionOrigin: true });
    await service.start();

    let emptyCtxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    assert.strictEqual(emptyCtxRes.data.context, null, 'Freshly restarted service context should be null');

    await sleep(3000);

    let recoveredCtxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    assert.ok(recoveredCtxRes.data.context, 'Context must repopulate after quiet service restart!');
    assert.strictEqual(recoveredCtxRes.data.context.canonicalTitle, 'Dandadan');
    console.log(`✔ Quiet Service Restart Recovery SUCCESSFUL: repopulated "${recoveredCtxRes.data.context.canonicalTitle}"`);

    // 5. Test No-Context Error Behavior
    const { contextStore } = require('../packages/service/dist/contextStore');
    contextStore.clear();
    const noCtxRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
    assert.strictEqual(noCtxRes.status, 400, 'POST /lookup/imdb should return 400 when no context exists');
    assert.strictEqual(noCtxRes.data.error, 'no_usable_context');
    console.log('✔ No-Context Error Handling SUCCESSFUL: returned 400 no_usable_context');

  } finally {
    testServer.close();
    await service.stop();
    if (testChromeProc && !testChromeProc.killed) {
      try { process.kill(testChromeProc.pid, 'SIGKILL'); } catch (e) {}
    }
    console.log('✔ Cleaned up test HTTP server, bridge service, and isolated Chrome process (PID: ' + testPid + ') ONLY.');
  }

  console.log('\n--- REAL CHROME ASSERTING INTEGRATION HARNESS SUCCESSFUL ---');
}

runRealChromeValidation().catch((err) => {
  console.error('\n❌ VALIDATION ASSERTION FAILED:', err.message);
  process.exit(1);
});
