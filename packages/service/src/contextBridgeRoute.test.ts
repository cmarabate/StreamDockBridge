import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { createBridgeServer, ALLOWED_EXTENSION_ORIGIN } from './server';
import { SecretStore } from './secretStore';
import { contextChannels } from './contextChannels';

/**
 * The ContextBridge read route, proved over real loopback HTTP rather than
 * against the builder: it is the boundary a consumer actually touches.
 */

const PORT = 17443;
const ROUTE = '/contextbridge/v1/snapshot';

let server: ReturnType<typeof createBridgeServer>;
let secret: string;
let tempDir: string;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-cb-'));
  const secretStore = new SecretStore(path.join(tempDir, 'secret.key'));
  secret = secretStore.getSecret();
  server = createBridgeServer({
    port: PORT,
    host: '127.0.0.1',
    secretStore,
    launcher: () => undefined,
    iconService: { resolve: async () => ({ status: 'local_host' }) } as never,
  });
  await server.start();
});

afterAll(async () => {
  await server.stop();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  contextChannels.clear();
});

function request(
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: unknown
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
          } catch (e) {
            reject(new Error(`unparseable response: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const WORK_SOURCE = {
  browserInstanceId: 'chrome-work',
  browserFamily: 'chrome',
  displayName: 'Chrome (work)',
  mode: 'WORK_BROWSER',
  connectionGeneration: 1,
};

async function publishPage(url: string, title: string, sequence = 1, source = WORK_SOURCE) {
  return request(
    'POST',
    '/context',
    { 'X-Bridge-Secret': secret },
    {
      channel: 'page',
      observationSequence: sequence,
      source,
      payload: {
        url,
        documentTitle: title,
        rawTitle: title,
        tabId: 31,
        windowId: 41,
        timestamp: Date.now(),
      },
    }
  );
}

describe('GET /contextbridge/v1/snapshot', () => {
  it('is authenticated: the bridge secret is required', async () => {
    const anonymous = await request('GET', ROUTE);
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toEqual({ success: false, error: 'unauthorized' });

    const wrong = await request('GET', ROUTE, { 'X-Bridge-Secret': 'not-the-secret' });
    expect(wrong.status).toBe(401);
  });

  it('refuses a foreign extension origin', async () => {
    const forbidden = await request('GET', ROUTE, {
      Origin: 'chrome-extension://someotherextensionidaaaaaaaaaaaaa',
      'X-Bridge-Secret': secret,
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json).toEqual({ success: false, error: 'origin_forbidden' });

    const allowed = await request('GET', ROUTE, {
      Origin: ALLOWED_EXTENSION_ORIGIN,
      'X-Bridge-Secret': secret,
    });
    expect(allowed.status).toBe(200);
  });

  it('returns an empty versioned snapshot when nothing has been observed', async () => {
    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(res.status).toBe(200);
    expect(res.json.success).toBe(true);
    expect(res.json.snapshot.schemaVersion).toBe('contextbridge.snapshot.v1');
    expect(typeof res.json.snapshot.readAt).toBe('number');
    expect(res.json.snapshot.sources).toEqual([]);
    expect(res.json.snapshot.channels).toEqual({ media: null, page: null });
  });

  it('never carries the bridge secret in its own response', async () => {
    await publishPage('https://example.com/docs', 'Docs');
    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(JSON.stringify(res.json)).not.toContain(secret);
  });

  it('publishes a ChatGPT project page as exact provider evidence', async () => {
    await publishPage(
      'https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-streamdockbridge/project',
      'StreamDockBridge — roadmap'
    );

    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    const channel = res.json.snapshot.channels.page;
    expect(channel.source).toMatchObject({
      sourceInstanceId: 'chrome-work',
      role: 'WORK_BROWSER',
      connectionGeneration: 1,
    });
    expect(channel.page).toMatchObject({ hostname: 'chatgpt.com', tabId: 31, windowId: 41 });
    expect(channel.observation.fresh).toBe(true);
    expect(channel.providerContext).toMatchObject({
      provider: 'chatgpt',
      scope: 'project',
      externalProjectId: 'g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-streamdockbridge',
      projectDisplayLabel: 'streamdockbridge',
    });
    expect(JSON.stringify(res.json)).not.toContain('registryKey');
  });

  it('publishes an ordinary ChatGPT conversation as non-project', async () => {
    await publishPage(
      'https://chatgpt.com/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      'StreamDockBridge - Reconcile roadmap'
    );

    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(res.json.snapshot.channels.page.providerContext).toMatchObject({
      provider: 'chatgpt',
      scope: 'conversation',
    });
    expect(JSON.stringify(res.json.snapshot)).not.toContain('externalProjectId');
  });

  it('follows the active tab as the work browser navigates', async () => {
    await publishPage('https://chatgpt.com/g/g-p-abcd1234-first/project', 'First', 1);
    const first = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(first.json.snapshot.channels.page.providerContext.externalProjectId).toBe(
      'g-p-abcd1234-first'
    );

    await publishPage('https://chatgpt.com/g/g-p-abcd1234-second/project', 'Second', 2);
    const second = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(second.json.snapshot.channels.page.providerContext.externalProjectId).toBe(
      'g-p-abcd1234-second'
    );
    expect(second.json.snapshot.channels.page.observation.sequence).toBe(2);
  });

  it('drops the channel when the owning browser disconnects', async () => {
    await publishPage('https://example.com/docs', 'Docs');
    const disconnect = await request(
      'POST',
      '/sources/disconnect',
      { 'X-Bridge-Secret': secret },
      { browserInstanceId: 'chrome-work' }
    );
    expect(disconnect.status).toBe(200);

    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(res.json.snapshot.channels.page).toBeNull();
  });

  it('reports a bounded, non-throwing snapshot for hostile page input', async () => {
    await publishPage(
      `https://chatgpt.com/g/g-p-abcd1234-${'z'.repeat(4_000)}/project`,
      '<script>alert(1)</script>'
    );

    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(res.status).toBe(200);
    // Too long to be accepted as proof of project scope; still not an error.
    expect(res.json.snapshot.channels.page.providerContext).toMatchObject({
      provider: 'chatgpt',
      scope: 'none',
    });
    expect(
      res.json.snapshot.channels.page.providerContext.evidence.observedPath.length
    ).toBeLessThanOrEqual(512);
  });

  it('does not answer on the legacy context routes', async () => {
    const legacy = await request('GET', '/contexts');
    expect(legacy.status).toBe(200);
    expect(legacy.json.snapshot).toBeUndefined();
    expect(legacy.json.contexts).toBeDefined();
  });

  it('rejects a write to the read-only boundary', async () => {
    const post = await request('POST', ROUTE, { 'X-Bridge-Secret': secret }, { snapshot: {} });
    expect(post.status).toBe(404);
  });
});

describe('GET /contextbridge/v1/snapshot — connected source inventory', () => {
  const heartbeat = (source: typeof WORK_SOURCE) =>
    request('POST', '/sources/heartbeat', { 'X-Bridge-Secret': secret }, { source });

  it('returns the inventory only through the authenticated route', async () => {
    await publishPage('https://example.com/docs', 'Docs');

    const anonymous = await request('GET', ROUTE);
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(anonymous.json)).not.toContain('chrome-work');

    const authed = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(authed.status).toBe(200);
    expect(authed.json.snapshot.schemaVersion).toBe('contextbridge.snapshot.v1');
    expect(authed.json.snapshot.sources).toEqual([
      {
        sourceInstanceId: 'chrome-work',
        browserFamily: 'chrome',
        displayName: 'Chrome (work)',
        role: 'WORK_BROWSER',
        connectionGeneration: 1,
      },
    ]);
  });

  it('lists two same-family profiles while PAGE names only its owner', async () => {
    const profileB = {
      ...WORK_SOURCE,
      browserInstanceId: 'chrome-work-b',
      displayName: 'Chrome (work, profile B)',
      mode: 'HYBRID',
    };
    await publishPage('https://chatgpt.com/g/g-p-abcd1234-first/project', 'First');
    const hb = await heartbeat(profileB);
    expect(hb.status).toBe(200);

    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    const snapshot = res.json.snapshot;
    expect(snapshot.sources.map((s: any) => [s.sourceInstanceId, s.browserFamily, s.role])).toEqual([
      ['chrome-work', 'chrome', 'WORK_BROWSER'],
      ['chrome-work-b', 'chrome', 'HYBRID'],
    ]);
    expect(snapshot.channels.page.source.sourceInstanceId).toBe('chrome-work');
    expect(snapshot.channels.page.providerContext.externalProjectId).toBe('g-p-abcd1234-first');
    expect(snapshot.sources).toContainEqual(snapshot.channels.page.source);
  });

  it('drops a disconnected source from the inventory', async () => {
    await publishPage('https://example.com/docs', 'Docs');
    await heartbeat({ ...WORK_SOURCE, browserInstanceId: 'chrome-other', mode: 'DISABLED' });

    const before = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(before.json.snapshot.sources.map((s: any) => s.sourceInstanceId)).toEqual([
      'chrome-other',
      'chrome-work',
    ]);

    await request(
      'POST',
      '/sources/disconnect',
      { 'X-Bridge-Secret': secret },
      { browserInstanceId: 'chrome-work' }
    );

    const after = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    expect(after.json.snapshot.sources.map((s: any) => s.sourceInstanceId)).toEqual([
      'chrome-other',
    ]);
    expect(after.json.snapshot.channels.page).toBeNull();
  });

  it('carries no liveness clock, secret, registry key or foreground claim in the inventory', async () => {
    await publishPage('https://chatgpt.com/g/g-p-abcd1234-first/project', 'First');
    const res = await request('GET', ROUTE, { 'X-Bridge-Secret': secret });
    const encoded = JSON.stringify(res.json.snapshot.sources);
    expect(encoded).not.toContain(secret);
    for (const forbidden of ['lastSeen', 'connected', 'registryKey', 'projectKey', 'hwnd', 'foreground']) {
      expect(encoded.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(Object.keys(res.json.snapshot).sort()).toEqual([
      'channels',
      'readAt',
      'schemaVersion',
      'sources',
    ]);
  });
});
