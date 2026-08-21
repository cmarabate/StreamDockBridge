// Real-Chrome production validation harness for StreamDockBridge.
//
// This harness observes and drives Chrome through CDP at the browser / tab /
// window level ONLY. It must never take a shortcut through the extension's
// or service's own business logic:
//   - no POST /auth/handshake, no reading the bridge secret
//   - no POST /context, no contextStore.updateContext(...)
//   - no Runtime.evaluate of syncActiveContext() / recoveryTick()
//   - no fabricated fallback context
// Every context value asserted below must have arrived because the real,
// unpacked extension noticed a real Chrome event and posted it itself.
//
// Requires a Chrome-for-Testing binary (branded "Google Chrome" silently
// ignores --load-extension / --disable-extensions-except, so it cannot load
// an unpacked extension at all — see the README note this script prints if
// the binary can't be found). Point CFT_CHROME_PATH at chrome.exe from
// https://googlechromelabs.github.io/chrome-for-testing/.
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn } from 'child_process';
import WebSocket from 'ws';
import { createBridgeServer, PINNED_EXTENSION_ORIGIN } from '../packages/service/dist/server.js';
import { SecretStore } from '../packages/service/dist/secretStore.js';

const SERVICE_PORT = 17337;
const TEST_HTTP_PORT = 8089;
const EXTENSION_PATH = path.resolve('packages/extension');
const RUN_STAMP = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
const TMP_ROOT = path.resolve(`${process.env.TEMP || process.env.TMP || '.'}/sdb-validate-${RUN_STAMP}`);

const CHROME_PATH = process.env.CFT_CHROME_PATH;
if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
  console.error('❌ CFT_CHROME_PATH is not set (or does not exist).');
  console.error('   Branded Google Chrome silently ignores --load-extension, so it cannot');
  console.error('   run this harness. Download a Chrome for Testing build from');
  console.error('   https://googlechromelabs.github.io/chrome-for-testing/ and set');
  console.error('   CFT_CHROME_PATH to its chrome.exe, then re-run.');
  process.exit(1);
}

let nextDebugPort = 9300;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function fetchJson(url, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.end();
  });
}

/** Minimal promise-based CDP client over one WebSocket connection. */
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const cbs = this.listeners.get(msg.method);
        if (cbs) cbs.forEach((cb) => cb(msg.params));
      }
    });
  }

  ready() {
    return new Promise((resolve, reject) => {
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
    });
  }

  send(method, params = {}, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  close() {
    try { this.ws.close(); } catch (e) {}
  }
}

async function connect(wsUrl) {
  const c = new Cdp(wsUrl);
  await c.ready();
  return c;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollUntil(fn, { timeoutMs, intervalMs = 1000 }) {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result) return { result, elapsedMs: Date.now() - start };
    if (Date.now() - start >= timeoutMs) return { result: null, elapsedMs: Date.now() - start };
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// canonical extension ID, derived independently from manifest.key
// ---------------------------------------------------------------------------

function deriveExtensionIdFromManifestKey() {
  const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8'));
  if (!manifest.key) throw new Error('manifest.json has no "key" field');
  const pubDer = Buffer.from(manifest.key, 'base64');
  const hash = crypto.createHash('sha256').update(pubDer).digest();
  const first16 = hash.subarray(0, 16);
  let id = '';
  for (const ch of first16.toString('hex')) id += String.fromCharCode('a'.charCodeAt(0) + parseInt(ch, 16));
  return id;
}

// ---------------------------------------------------------------------------
// test HTTP server (pages the extension will naturally read)
// ---------------------------------------------------------------------------

function mediaPage(title, jsonLdName) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} Watch Page - Crunchyroll</title>
  <meta property="og:title" content="${title} - Watch on Crunchyroll" />
  <meta name="twitter:title" content="${title}" />
  <script type="application/ld+json">
  { "@context": "https://schema.org", "@type": "TVSeries", "name": "${jsonLdName}" }
  </script>
</head>
<body><h1>${title}</h1></body>
</html>`;
}

const PAGES = {
  '/dandadan.html': mediaPage('Dandadan', 'Dandadan'),
  '/space_dandy.html': mediaPage('Space Dandy', 'Space Dandy'),
  '/chainsaw_man.html': mediaPage('Chainsaw Man', 'Chainsaw Man'),
};

function startTestServer() {
  const server = http.createServer((req, res) => {
    const body = PAGES[req.url];
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body || 'not found');
  });
  return new Promise((resolve) => server.listen(TEST_HTTP_PORT, '127.0.0.1', () => resolve(server)));
}

// ---------------------------------------------------------------------------
// Chrome lifecycle
// ---------------------------------------------------------------------------

function freshUserDataDir(label) {
  const dir = path.join(TMP_ROOT, `profile-${label}-${crypto.randomBytes(3).toString('hex')}`);
  if (fs.existsSync(dir)) throw new Error(`user-data dir already exists: ${dir}`);
  return dir;
}

function launchChrome(userDataDir, initialUrl) {
  const debugPort = nextDebugPort++;
  const proc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${EXTENSION_PATH}`,
    `--load-extension=${EXTENSION_PATH}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-fre',
    '--no-default-browser-check',
    initialUrl,
  ], { stdio: 'ignore', detached: false });
  return { proc, debugPort };
}

async function waitForOurServiceWorker(debugPort, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    if (Array.isArray(res.data)) {
      const workers = res.data.filter((t) => t.type === 'service_worker');
      for (const w of workers) {
        // Identify OUR worker by evaluating its own manifest, rather than
        // trusting "the first service_worker target" — Chrome also runs its
        // own internal component-extension service workers on this same
        // debug port, and picking blindly picks the wrong one.
        try {
          const c = await connect(w.webSocketDebuggerUrl);
          await c.send('Runtime.enable');
          await c.send('Runtime.runIfWaitingForDebugger');
          const evalRes = await c.send('Runtime.evaluate', {
            expression: 'JSON.stringify({name: chrome.runtime.getManifest().name, id: chrome.runtime.id})',
            returnByValue: true,
          });
          c.close();
          const info = JSON.parse(evalRes.result.value);
          if (info.name === 'StreamDockBridge Context Provider') {
            return { target: w, id: info.id };
          }
        } catch (e) {
          // not ours / not ready yet, keep looking
        }
      }
    }
    await sleep(400);
  }
  return null;
}

async function waitForPageTarget(debugPort, urlSuffix, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
    if (Array.isArray(res.data)) {
      const t = res.data.find((x) => x.type === 'page' && x.url.includes(urlSuffix));
      if (t) return t;
    }
    await sleep(300);
  }
  return null;
}

function contextMatchesUrl(ctx, urlSuffix) {
  return !!(ctx && ctx.context && ctx.context.url && ctx.context.url.includes(urlSuffix));
}

async function pollContextForUrl(urlSuffix, timeoutMs) {
  return pollUntil(async () => {
    const res = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/context`);
    return contextMatchesUrl(res.data, urlSuffix) ? res.data.context : null;
  }, { timeoutMs, intervalMs: 800 });
}

// ---------------------------------------------------------------------------
// evidence + assertion bookkeeping
// ---------------------------------------------------------------------------

const evidence = {};
let failed = false;

function assert(cond, label, detail) {
  if (cond) {
    console.log(`  ✔ ${label}`);
  } else {
    failed = true;
    console.error(`  ❌ ${label}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
  }
  return cond;
}

async function cleanupAndExit(code, procs, servers) {
  for (const p of procs) { try { p.kill(); } catch (e) {} }
  for (const s of servers) { try { await s.close(); } catch (e) { try { await s.stop(); } catch (e2) {} } }
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (e) {}
  console.log('\n=== EVIDENCE ===');
  console.log(JSON.stringify(evidence, null, 2));
  process.exit(code);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

(async () => {
  console.log('--- STREAMDOCKBRIDGE REAL CHROME-FOR-TESTING VALIDATION HARNESS ---');
  console.log(`Chrome-for-Testing binary: ${CHROME_PATH}`);

  const manifestRaw = fs.readFileSync(path.join(EXTENSION_PATH, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert(!(manifest.permissions || []).includes('activeTab'), 'manifest permissions do not include activeTab');

  const derivedId = deriveExtensionIdFromManifestKey();
  const pinnedId = PINNED_EXTENSION_ORIGIN.replace('chrome-extension://', '');
  evidence.derivedIdFromManifestKey = derivedId;
  evidence.pinnedExtensionOrigin = PINNED_EXTENSION_ORIGIN;
  assert(derivedId === pinnedId, 'ID derived from manifest.key matches PINNED_EXTENSION_ORIGIN', { derivedId, pinnedId });

  // -------------------------------------------------------------------
  // Section 3: two fresh, isolated launches proving the canonical ID
  // -------------------------------------------------------------------
  evidence.idProofRuns = [];
  for (let run = 1; run <= 2; run++) {
    console.log(`\n--- ID proof run ${run}/2 (fresh isolated user-data-dir) ---`);
    const userDataDir = freshUserDataDir(`idproof${run}`);
    const { proc, debugPort } = launchChrome(userDataDir, 'about:blank');
    const found = await waitForOurServiceWorker(debugPort);
    proc.kill();
    const ok = !!found && found.id === pinnedId && found.id === derivedId;
    evidence.idProofRuns.push({ run, discoveredId: found ? found.id : null, ok });
    assert(ok, `run ${run}: discovered extension ID matches derived/pinned ID`, found);
    if (!found) {
      console.error('  (service worker for StreamDockBridge never appeared — extension failed to load)');
    }
  }

  if (failed) {
    console.error('\n❌ Extension-ID proof failed — aborting before the browser matrix.');
    await cleanupAndExit(1, [], []);
    return;
  }

  // -------------------------------------------------------------------
  // Matrix setup: one persistent Chrome + one persistent service instance
  // -------------------------------------------------------------------
  const testServer = await startTestServer();
  console.log(`\n✔ Test HTTP server running on http://127.0.0.1:${TEST_HTTP_PORT}`);

  const isolatedSecretPath = path.join(TMP_ROOT, 'secret.key');
  let capturedLaunches = [];
  let service = createBridgeServer({
    port: SERVICE_PORT,
    host: '127.0.0.1',
    allowAnyExtensionOrigin: false,
    secretStore: new SecretStore(isolatedSecretPath),
    launcher: (url) => capturedLaunches.push(url),
  });
  await service.start();
  console.log(`✔ Bridge service running on 127.0.0.1:${SERVICE_PORT} (isolated secret store, strict production trust)`);

  const userDataDir = freshUserDataDir('matrix');
  const { proc: chromeProc, debugPort } = launchChrome(userDataDir, `http://127.0.0.1:${TEST_HTTP_PORT}/dandadan.html`);
  const swInfo = await waitForOurServiceWorker(debugPort);
  if (!assert(!!swInfo, 'matrix run: StreamDockBridge service worker discovered')) {
    await cleanupAndExit(1, [chromeProc], [service, testServer]);
    return;
  }

  const versionRes = await fetchJson(`http://127.0.0.1:${debugPort}/json/version`);
  const browserCdp = await connect(versionRes.data.webSocketDebuggerUrl);
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });

  // ---- A: fresh start, natural non-null context ----------------------
  console.log('\n--- A: fresh start ---');
  const { result: ctxA } = await pollContextForUrl('dandadan.html', 20000);
  evidence.freshStart = ctxA;
  if (assert(!!ctxA, 'A: /context naturally became non-null for the Dandadan page')) {
    assert(typeof ctxA.url === 'string' && ctxA.url.includes('dandadan.html'), 'A: url present', ctxA.url);
    assert(typeof ctxA.tabId === 'number', 'A: tabId present', ctxA.tabId);
    assert(typeof ctxA.windowId === 'number', 'A: windowId present', ctxA.windowId);
    assert(!!ctxA.documentTitle, 'A: documentTitle present', ctxA.documentTitle);
    assert(ctxA.ogTitle === 'Dandadan - Watch on Crunchyroll', 'A: ogTitle correct', ctxA.ogTitle);
    assert(ctxA.twitterTitle === 'Dandadan', 'A: twitterTitle correct', ctxA.twitterTitle);
    assert(ctxA.jsonLdTitle === 'Dandadan', 'A: jsonLdTitle correct', ctxA.jsonLdTitle);
    assert(ctxA.canonicalTitle === 'Dandadan', 'A: canonicalTitle correct', ctxA.canonicalTitle);
  }

  const tabAInfo = await waitForPageTarget(debugPort, 'dandadan.html');
  const tabA = await connect(tabAInfo.webSocketDebuggerUrl);
  await tabA.send('Page.enable');

  // ---- B: same-window A -> B -> A -------------------------------------
  console.log('\n--- B: same-window A -> B -> A ---');
  const createdB = await browserCdp.send('Target.createTarget', {
    url: `http://127.0.0.1:${TEST_HTTP_PORT}/space_dandy.html`,
    newWindow: false,
  });
  const tabBInfoRaw = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const tabBEntry = tabBInfoRaw.data.find((t) => t.id === createdB.targetId);
  const tabB = await connect(tabBEntry.webSocketDebuggerUrl);
  await tabB.send('Page.enable');

  await tabB.send('Page.bringToFront');
  const { result: ctxB1 } = await pollContextForUrl('space_dandy.html', 15000);
  assert(contextMatchesUrl({ context: ctxB1 }, 'space_dandy.html'), 'B: activating tab B -> context follows to Space Dandy', ctxB1 && ctxB1.url);

  await tabA.send('Page.bringToFront');
  const { result: ctxA2 } = await pollContextForUrl('dandadan.html', 15000);
  assert(contextMatchesUrl({ context: ctxA2 }, 'dandadan.html'), 'B: re-activating tab A -> context follows back to Dandadan', ctxA2 && ctxA2.url);
  evidence.sameWindowABA = { toB: ctxB1 && ctxB1.url, backToA: ctxA2 && ctxA2.url };

  // ---- C: two-window authority -----------------------------------------
  console.log('\n--- C: two-window authority ---');
  const createdWin2 = await browserCdp.send('Target.createTarget', {
    url: `http://127.0.0.1:${TEST_HTTP_PORT}/space_dandy.html`,
    newWindow: true,
  });
  const win2ListRaw = await fetchJson(`http://127.0.0.1:${debugPort}/json/list`);
  const win2Entry = win2ListRaw.data.find((t) => t.id === createdWin2.targetId);
  const win2 = await connect(win2Entry.webSocketDebuggerUrl);
  await win2.send('Page.enable');

  await tabA.send('Page.bringToFront');
  const { result: ctxWin1 } = await pollContextForUrl('dandadan.html', 15000);
  assert(contextMatchesUrl({ context: ctxWin1 }, 'dandadan.html'), 'C: focusing window 1 -> context is window 1 (Dandadan)', ctxWin1 && ctxWin1.url);

  await win2.send('Page.bringToFront');
  const { result: ctxWin2 } = await pollContextForUrl('space_dandy.html', 15000);
  assert(contextMatchesUrl({ context: ctxWin2 }, 'space_dandy.html'), 'C: focusing window 2 -> context is window 2 (Space Dandy)', ctxWin2 && ctxWin2.url);

  // Background update in window 1 while window 2 stays focused.
  await tabA.send('Page.navigate', { url: `http://127.0.0.1:${TEST_HTTP_PORT}/chainsaw_man.html` });
  await sleep(3000);
  const afterBgUpdate = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/context`);
  assert(
    contextMatchesUrl(afterBgUpdate.data, 'space_dandy.html'),
    'C: background update in unfocused window 1 does NOT change context (still Space Dandy)',
    afterBgUpdate.data && afterBgUpdate.data.context && afterBgUpdate.data.context.url
  );

  await tabA.send('Page.bringToFront');
  const { result: ctxWin1After } = await pollContextForUrl('chainsaw_man.html', 15000);
  assert(
    contextMatchesUrl({ context: ctxWin1After }, 'chainsaw_man.html'),
    'C: focusing window 1 again -> context switches to window 1\'s CURRENT page (Chainsaw Man)',
    ctxWin1After && ctxWin1After.url
  );
  evidence.twoWindowAuthority = {
    window1: ctxWin1 && ctxWin1.url,
    window2: ctxWin2 && ctxWin2.url,
    unchangedDuringBackgroundUpdate: afterBgUpdate.data && afterBgUpdate.data.context && afterBgUpdate.data.context.url,
    window1AfterRefocus: ctxWin1After && ctxWin1After.url,
  };

  // Leave a known, natural context (Space Dandy) in place for the lookup tests.
  await win2.send('Page.bringToFront');
  await pollContextForUrl('space_dandy.html', 15000);

  // ---- E: lookups (in-process launcher capture, no real browser popped) --
  console.log('\n--- E: lookups ---');
  const expectedLookups = {
    imdb: `https://www.imdb.com/find?q=${encodeURIComponent('Space Dandy')}`,
    cast: `https://www.google.com/search?q=${encodeURIComponent('Space Dandy cast')}`,
    justwatch: `https://www.justwatch.com/us/search?q=${encodeURIComponent('Space Dandy')}`,
    reddit: `https://www.reddit.com/search/?q=${encodeURIComponent('Space Dandy')}`,
  };
  evidence.lookups = {};
  for (const [action, expectedUrl] of Object.entries(expectedLookups)) {
    capturedLaunches = [];
    service.launcher = (url) => capturedLaunches.push(url);
    const res = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/lookup/${action}`, 'POST');
    const d = res.data || {};
    evidence.lookups[action] = { status: res.status, body: d, launched: capturedLaunches.slice() };
    assert(res.status === 200, `E: ${action} lookup returns 200`, res.status);
    assert(d.success === true, `E: ${action} lookup success=true`, d.success);
    assert(d.action === action, `E: ${action} lookup action correct`, d.action);
    assert(d.query === 'Space Dandy', `E: ${action} lookup query == "Space Dandy"`, d.query);
    assert(d.launched === true, `E: ${action} lookup launched=true`, d.launched);
    assert(d.url === expectedUrl, `E: ${action} lookup exact URL correct`, { got: d.url, expected: expectedUrl });
    assert(capturedLaunches.length === 1 && capturedLaunches[0] === expectedUrl, `E: ${action} launcher invoked with exact URL (captured, not a real browser)`, capturedLaunches);
  }

  // ---- D + F: quiet service restart / no-context lookups -----------------
  console.log('\n--- D: quiet service restart ---');
  await service.stop();
  service.contextStore.clear(); // faithful stand-in for a fresh process's empty in-memory store
  service = createBridgeServer({
    port: SERVICE_PORT,
    host: '127.0.0.1',
    allowAnyExtensionOrigin: false,
    secretStore: new SecretStore(isolatedSecretPath),
    launcher: (url) => capturedLaunches.push(url),
  });
  await service.start();

  // The new listener can take a beat to actually accept connections on
  // Windows even after start()'s callback fires (prior socket teardown is
  // not instant) — poll briefly for the first successful response, then
  // assert on that response's content, not on exact bind timing.
  const { result: nullCheck } = await pollUntil(async () => {
    const r = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/context`);
    return r.data ? r : null;
  }, { timeoutMs: 5000, intervalMs: 250 });
  assert(nullCheck && nullCheck.data.success === true && nullCheck.data.context === null, 'D: /context is null immediately after restart', nullCheck && nullCheck.data);

  console.log('\n--- F: no-context lookups (during the null window) ---');
  capturedLaunches = [];
  const fRes = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/lookup/imdb`, 'POST');
  evidence.noContextLookup = { status: fRes.status, body: fRes.data, launched: capturedLaunches.slice() };
  assert(fRes.status === 400, 'F: lookup with no context returns 400', fRes.status);
  assert(fRes.data && fRes.data.error === 'no_usable_context', 'F: error is no_usable_context', fRes.data);
  assert(capturedLaunches.length === 0, 'F: launcher was NOT invoked', capturedLaunches);

  console.log('\n--- D: waiting up to 45s for natural alarm-driven recovery (nothing done to Chrome) ---');
  const recovery = await pollUntil(async () => {
    const r = await fetchJson(`http://127.0.0.1:${SERVICE_PORT}/context`);
    return r.data && r.data.context && r.data.context.canonicalTitle ? r.data.context : null;
  }, { timeoutMs: 45000, intervalMs: 1000 });
  evidence.quietRestartRecovery = { recovered: !!recovery.result, elapsedMs: recovery.elapsedMs, context: recovery.result };
  assert(!!recovery.result, `D: context naturally recovered within 45s (took ${recovery.elapsedMs}ms)`, recovery.result);

  console.log('\n=== ALL PHASES COMPLETE ===');
  await cleanupAndExit(failed ? 1 : 0, [chromeProc], [service, testServer]);
})().catch(async (e) => {
  console.error('❌ HARNESS CRASHED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
