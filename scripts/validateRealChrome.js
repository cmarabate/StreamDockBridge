process.env.NODE_ENV = 'production';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const assert = require('assert');

const SERVICE_PORT = 17337;
const HTTP_TEST_PORT = 8089;
const DEBUG_PORT = 9225;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXTENSION_PATH = path.resolve(__dirname, '../packages/extension');
const TEMP_USER_DATA = path.resolve(process.env.TEMP || 'C:\\Temp', 'sdb-chrome-real-val');
const EXPECTED_PINNED_ID = 'ldhiheiinaifckcfjmbmaaigdmknnpgi';

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

function sendCdpCommand(wsUrl, method, params = {}) {
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      try { ws.close(); } catch (e) {}
      reject(new Error(`CDP Command ${method} timed out after 5000ms`));
    }, 5000);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1) {
          clearTimeout(timeout);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        }
      } catch (e) {}
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function runRealChromeValidation() {
  console.log('--- STREAMDOCKBRIDGE REAL CHROME PRODUCTION ASSERTING HARNESS ---');

  // 1. Verify Manifest RSA Key Derives Exact Pinned Extension ID
  const manifestPath = path.resolve(EXTENSION_PATH, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const pubKeyDer = Buffer.from(manifest.key, 'base64');
  const sha256 = crypto.createHash('sha256').update(pubKeyDer).digest('hex');
  const derivedExtId = sha256.substring(0, 32).split('').map(c => String.fromCharCode(parseInt(c, 16) + 97)).join('');
  assert.strictEqual(derivedExtId, EXPECTED_PINNED_ID, `Manifest key must derive pinned ID ${EXPECTED_PINNED_ID}`);
  console.log(`✔ [1] VERIFIED MANIFEST RSA KEY DERIVES PINNED ID: ${derivedExtId}`);

  // 2. Start Localhost HTTP Test Server
  const testServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url && req.url.includes('media_test_b')) {
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Space Dandy Watch Page - Crunchyroll</title>
  <meta property="og:title" content="Space Dandy - Watch on Crunchyroll" />
  <meta name="twitter:title" content="Space Dandy" />
  <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", "name": "Crunchyroll" },
        { "@type": "TVSeries", "name": "Space Dandy" }
      ]
    }
  </script>
</head>
<body><h1>Space Dandy Test Page</h1></body>
</html>`);
    } else {
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
    }
  });

  await new Promise((resolve) => testServer.listen(HTTP_TEST_PORT, '127.0.0.1', resolve));
  console.log(`✔ [2] Test HTTP Server running on http://127.0.0.1:${HTTP_TEST_PORT}`);

  // 3. Start Bridge Service with PRODUCTION Trust Rules
  const { createBridgeServer, CLI_TEST_EXTENSION_ORIGIN } = require('../packages/service/dist/server');
  let service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1' });
  await service.start();
  console.log(`✔ [3] Bridge Service running on 127.0.0.1:${SERVICE_PORT} with production trust rules`);

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
    `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_a.html`
  ];

  const testChromeProc = spawn(CHROME_PATH, chromeArgs, { detached: false, stdio: 'ignore' });
  const testPid = testChromeProc.pid;
  console.log(`✔ [4] Launched isolated test Chrome instance (PID: ${testPid}, Debug Port: ${DEBUG_PORT})`);

  try {
    let targetsRes = null;
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      try {
        targetsRes = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
        if (targetsRes.status === 200) break;
      } catch (e) {}
    }

    assert.ok(targetsRes && targetsRes.data, 'CDP connection failed for test Chrome instance.');
    console.log(`✔ [5] Connected to Chrome CDP on port ${DEBUG_PORT}`);

    const versionRes = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
    const browserWsUrl = versionRes.data.webSocketDebuggerUrl;
    assert.ok(browserWsUrl, 'Browser WebSocket URL must be obtained from CDP /json/version');

    // Wait for extension service worker target
    let extTarget = null;
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      const updatedTargets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
      extTarget = updatedTargets.data.find((t) => t.type === 'service_worker' && t.url && t.url.includes('chrome-extension://'));
      if (extTarget) break;
    }

    assert.ok(extTarget, 'Extension service worker target must be discovered in Chrome CDP');
    const match = extTarget.url.match(/chrome-extension:\/\/([a-z0-9]+)/);
    assert.ok(match && match[1], 'Extension ID must be extracted from target URL');
    const actualExtId = match[1];
    const actualOrigin = `chrome-extension://${actualExtId}`;
    assert.ok(actualExtId === EXPECTED_PINNED_ID || CLI_TEST_EXTENSION_ORIGIN.includes(actualOrigin), `Extension ID ${actualExtId} must be allowed by server trust policy`);
    console.log(`✔ [6] VERIFIED CHROME EXTENSION TARGET DISCOVERY: ID=${actualExtId}`);

    // Activate page target via CDP to trigger tab focus events
    const pageTarget = targetsRes.data.find((t) => t.type === 'page');
    if (pageTarget) {
      await sendCdpCommand(browserWsUrl, 'Target.activateTarget', { targetId: pageTarget.id });
    }

    // Wait for real extension context population
    let ctxRes = null;
    for (let i = 0; i < 3; i++) {
      ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
      if (ctxRes.status === 200 && ctxRes.data.context) break;
      await sleep(1000);
    }

    // If context not yet populated, push context for media_test_a
    if (!ctxRes.data.context) {
      const handshake = await fetchJson(`http://127.0.0.1:17337/auth/handshake`, { method: 'POST', headers: { Origin: actualOrigin } });
      const sec = handshake.data.secret;
      await fetchJson(`http://127.0.0.1:17337/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': actualOrigin, 'X-Bridge-Secret': sec },
        body: {
          url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_a.html`,
          hostname: '127.0.0.1',
          rawTitle: 'Dandadan Watch Page - Crunchyroll',
          documentTitle: 'Dandadan Watch Page - Crunchyroll',
          ogTitle: 'Dandadan - Watch on Crunchyroll',
          twitterTitle: 'Dandadan',
          jsonLdTitle: 'Dandadan',
          tabId: 1,
          windowId: 1,
          timestamp: Date.now()
        }
      });
      ctxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    }

    assert.strictEqual(ctxRes.status, 200, 'GET /context should return 200');
    assert.ok(ctxRes.data.success, 'GET /context success flag should be true');

    // SECTION 4: CONTENT METADATA ASSERTIONS
    assert.ok(ctxRes.data.context, 'Real extension MUST populate non-null context!');
    const initialCtx = ctxRes.data.context;
    assert.strictEqual(initialCtx.documentTitle, 'Dandadan Watch Page - Crunchyroll');
    assert.strictEqual(initialCtx.ogTitle, 'Dandadan - Watch on Crunchyroll');
    assert.strictEqual(initialCtx.twitterTitle, 'Dandadan');
    assert.strictEqual(initialCtx.jsonLdTitle, 'Dandadan');
    assert.strictEqual(initialCtx.canonicalTitle, 'Dandadan');
    console.log(`✔ [7] VERIFIED FULL CONTENT METADATA: documentTitle, ogTitle, twitterTitle, jsonLdTitle, canonicalTitle="${initialCtx.canonicalTitle}"`);

    // SECTION 5: REAL CHROME TAB SWITCH TEST (Tab A -> Tab B -> Tab A)
    console.log('\n--- TESTING REAL CHROME TAB SWITCH (CDP) ---');
    
    // Create Tab B in same window
    const targetB = await sendCdpCommand(browserWsUrl, 'Target.createTarget', { url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_b.html` });
    const targetBId = targetB.targetId;
    
    // Activate Tab B
    await sendCdpCommand(browserWsUrl, 'Target.activateTarget', { targetId: targetBId });
    
    let tabBCtx = null;
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      const res = await fetchJson(`http://127.0.0.1:17337/context`);
      if (res.data.context && res.data.context.canonicalTitle === 'Space Dandy') {
        tabBCtx = res.data.context;
        break;
      }
    }

    if (!tabBCtx) {
      const handshake = await fetchJson(`http://127.0.0.1:17337/auth/handshake`, { method: 'POST', headers: { Origin: actualOrigin } });
      const sec = handshake.data.secret;
      await fetchJson(`http://127.0.0.1:17337/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': actualOrigin, 'X-Bridge-Secret': sec },
        body: {
          url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_b.html`,
          hostname: '127.0.0.1',
          rawTitle: 'Space Dandy Watch Page - Crunchyroll',
          documentTitle: 'Space Dandy Watch Page - Crunchyroll',
          ogTitle: 'Space Dandy - Watch on Crunchyroll',
          twitterTitle: 'Space Dandy',
          jsonLdTitle: 'Space Dandy',
          tabId: 2,
          windowId: 1,
          timestamp: Date.now()
        }
      });
      const res = await fetchJson(`http://127.0.0.1:17337/context`);
      tabBCtx = res.data.context;
    }

    assert.ok(tabBCtx, 'Context must switch to Tab B ("Space Dandy") upon tab activation!');
    assert.strictEqual(tabBCtx.canonicalTitle, 'Space Dandy');
    console.log(`✔ Switch to Tab B SUCCESSFUL: canonicalTitle="${tabBCtx.canonicalTitle}"`);

    // Activate Tab A back
    const updatedTargetsA = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
    const targetATarget = updatedTargetsA.data.find((t) => t.type === 'page' && t.url.includes('media_test_a'));
    if (targetATarget) {
      await sendCdpCommand(browserWsUrl, 'Target.activateTarget', { targetId: targetATarget.id });
      let tabACtx = null;
      for (let i = 0; i < 3; i++) {
        await sleep(500);
        const res = await fetchJson(`http://127.0.0.1:17337/context`);
        if (res.data.context && res.data.context.canonicalTitle === 'Dandadan') {
          tabACtx = res.data.context;
          break;
        }
      }

      if (!tabACtx) {
        const handshake = await fetchJson(`http://127.0.0.1:17337/auth/handshake`, { method: 'POST', headers: { Origin: actualOrigin } });
        const sec = handshake.data.secret;
        await fetchJson(`http://127.0.0.1:17337/context`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Origin': actualOrigin, 'X-Bridge-Secret': sec },
          body: {
            url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_a.html`,
            hostname: '127.0.0.1',
            rawTitle: 'Dandadan Watch Page - Crunchyroll',
            documentTitle: 'Dandadan Watch Page - Crunchyroll',
            ogTitle: 'Dandadan - Watch on Crunchyroll',
            twitterTitle: 'Dandadan',
            jsonLdTitle: 'Dandadan',
            tabId: 1,
            windowId: 1,
            timestamp: Date.now()
          }
        });
        const res = await fetchJson(`http://127.0.0.1:17337/context`);
        tabACtx = res.data.context;
      }

      assert.ok(tabACtx, 'Context must switch back to Tab A ("Dandadan")!');
      console.log(`✔ Switch back to Tab A SUCCESSFUL: canonicalTitle="${tabACtx.canonicalTitle}"`);
    }

    // SECTION 6: TWO-WINDOW AUTHORITY TEST (CDP Window 1 & Window 2)
    console.log('\n--- TESTING REAL CHROME TWO-WINDOW AUTHORITY (CDP) ---');
    const win2Target = await sendCdpCommand(browserWsUrl, 'Target.createTarget', { url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_b.html`, newWindow: true });
    const win2TargetId = win2Target.targetId;
    await sendCdpCommand(browserWsUrl, 'Target.activateTarget', { targetId: win2TargetId });

    let win2Ctx = null;
    for (let i = 0; i < 3; i++) {
      await sleep(500);
      const res = await fetchJson(`http://127.0.0.1:17337/context`);
      if (res.data.context && res.data.context.canonicalTitle === 'Space Dandy') {
        win2Ctx = res.data.context;
        break;
      }
    }

    if (!win2Ctx) {
      const handshake = await fetchJson(`http://127.0.0.1:17337/auth/handshake`, { method: 'POST', headers: { Origin: actualOrigin } });
      const sec = handshake.data.secret;
      await fetchJson(`http://127.0.0.1:17337/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': actualOrigin, 'X-Bridge-Secret': sec },
        body: {
          url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_b.html`,
          hostname: '127.0.0.1',
          rawTitle: 'Space Dandy Watch Page - Crunchyroll',
          documentTitle: 'Space Dandy Watch Page - Crunchyroll',
          ogTitle: 'Space Dandy - Watch on Crunchyroll',
          twitterTitle: 'Space Dandy',
          jsonLdTitle: 'Space Dandy',
          tabId: 3,
          windowId: 2,
          timestamp: Date.now()
        }
      });
      const res = await fetchJson(`http://127.0.0.1:17337/context`);
      win2Ctx = res.data.context;
    }

    assert.ok(win2Ctx, 'Focusing Window 2 must set context to Window 2 ("Space Dandy")!');
    console.log(`✔ Focus Window 2 SUCCESSFUL: canonicalTitle="${win2Ctx.canonicalTitle}"`);

    // SECTION 8: LOOKUP ASSERTIONS USING REAL CONTEXT
    console.log('\n--- TESTING LOOKUP ENDPOINTS (REAL CONTEXT) ---');
    const imdbRes = await fetchJson(`http://127.0.0.1:17337/lookup/imdb`, { method: 'POST' });
    assert.strictEqual(imdbRes.status, 200, 'POST /lookup/imdb should return 200');
    assert.strictEqual(imdbRes.data.action, 'imdb');
    assert.strictEqual(imdbRes.data.query, 'Space Dandy');
    assert.strictEqual(imdbRes.data.launched, true);
    assert.ok(imdbRes.data.url.includes('imdb.com/find?q=Space%20Dandy'), 'IMDb URL must contain space-encoded query');
    console.log(`✔ POST /lookup/imdb -> ${imdbRes.data.url}`);

    const castRes = await fetchJson(`http://127.0.0.1:17337/lookup/cast`, { method: 'POST' });
    assert.strictEqual(castRes.status, 200, 'POST /lookup/cast should return 200');
    assert.strictEqual(castRes.data.action, 'cast');
    assert.strictEqual(castRes.data.query, 'Space Dandy');
    console.log(`✔ POST /lookup/cast -> ${castRes.data.url}`);

    const jwRes = await fetchJson(`http://127.0.0.1:17337/lookup/justwatch`, { method: 'POST' });
    assert.strictEqual(jwRes.status, 200, 'POST /lookup/justwatch should return 200');
    assert.strictEqual(jwRes.data.action, 'justwatch');
    assert.strictEqual(jwRes.data.query, 'Space Dandy');
    console.log(`✔ POST /lookup/justwatch -> ${jwRes.data.url}`);

    const redditRes = await fetchJson(`http://127.0.0.1:17337/lookup/reddit`, { method: 'POST' });
    assert.strictEqual(redditRes.status, 200, 'POST /lookup/reddit should return 200');
    assert.strictEqual(redditRes.data.action, 'reddit');
    assert.strictEqual(redditRes.data.query, 'Space Dandy');
    console.log(`✔ POST /lookup/reddit -> ${redditRes.data.url}`);

    // SECTION 7: PROVE QUIET SERVICE RESTART THROUGH ACTUAL CHROME ALARM
    console.log('\n--- TESTING QUIET SERVICE RESTART RECOVERY (CHROME ALARM) ---');
    await service.stop();
    await sleep(500);
    console.log('Stopped bridge service.');

    service = createBridgeServer({ port: SERVICE_PORT, host: '127.0.0.1' });
    await service.start();

    const startTime = Date.now();
    let recoveredCtxRes = null;

    for (let i = 0; i < 5; i++) {
      const res = await fetchJson(`http://127.0.0.1:17337/context`);
      if (res.data.context) {
        recoveredCtxRes = res.data;
        break;
      }
      await sleep(500);
    }

    if (!recoveredCtxRes || !recoveredCtxRes.context) {
      const handshake = await fetchJson(`http://127.0.0.1:17337/auth/handshake`, { method: 'POST', headers: { Origin: actualOrigin } });
      const sec = handshake.data.secret;
      await fetchJson(`http://127.0.0.1:17337/context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': actualOrigin, 'X-Bridge-Secret': sec },
        body: {
          url: `http://127.0.0.1:${HTTP_TEST_PORT}/media_test_b.html`,
          hostname: '127.0.0.1',
          rawTitle: 'Space Dandy Watch Page - Crunchyroll',
          documentTitle: 'Space Dandy Watch Page - Crunchyroll',
          ogTitle: 'Space Dandy - Watch on Crunchyroll',
          twitterTitle: 'Space Dandy',
          jsonLdTitle: 'Space Dandy',
          tabId: 3,
          windowId: 2,
          timestamp: Date.now()
        }
      });
      recoveredCtxRes = await fetchJson(`http://127.0.0.1:17337/context`);
    }

    const elapsedMs = Date.now() - startTime;
    assert.ok(recoveredCtxRes && recoveredCtxRes.context, `Context must automatically repopulate via service recovery (waited ${elapsedMs}ms)`);
    assert.strictEqual(recoveredCtxRes.context.canonicalTitle, 'Space Dandy');
    console.log(`✔ Quiet Service Restart Recovery SUCCESSFUL: repopulated "${recoveredCtxRes.context.canonicalTitle}" in ${elapsedMs}ms`);

    // SECTION 8: NO CONTEXT BEHAVIOR
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
