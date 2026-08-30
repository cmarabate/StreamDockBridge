import * as http from 'http';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createBridgeServer } from './server';
import { contextStore, ContextRecord } from './contextStore';
import { SecretStore } from './secretStore';
import { DownstreamPath, DownstreamResponse } from './transcriptForge';

const HEALTHY = JSON.stringify({ worker: { status: 'healthy' } });

const enqueued = (jobId: string) =>
  JSON.stringify({ results: [{ url: 'u', jobId, skippedReason: null }] });

describe('POST /actions/transcribe-current', () => {
  let tmpSecretFile: string;
  let secretStore: SecretStore;
  let bridgeServer: ReturnType<typeof createBridgeServer>;
  let downstreamCalls: Array<{ path: DownstreamPath; body: unknown }> = [];
  let downstream: Partial<Record<DownstreamPath, DownstreamResponse | 'throw'>> = {};
  const testPort = 17346;

  beforeAll(async () => {
    tmpSecretFile = path.join(os.tmpdir(), `sdb-tf-sec-${Date.now()}.key`);
    secretStore = new SecretStore(tmpSecretFile);

    bridgeServer = createBridgeServer({
      port: testPort,
      host: '127.0.0.1',
      secretStore,
      launcher: () => undefined,
      transcriptForgeRequester: async (p, body) => {
        downstreamCalls.push({ path: p, body });
        const entry = downstream[p];
        if (entry === 'throw') throw new Error('ECONNREFUSED');
        if (!entry) throw new Error(`unexpected path ${p}`);
        return entry;
      },
    });

    await bridgeServer.start();
  });

  afterAll(async () => {
    await bridgeServer.stop();
    if (fs.existsSync(tmpSecretFile)) fs.unlinkSync(tmpSecretFile);
  });

  beforeEach(() => {
    contextStore.clear();
    downstreamCalls = [];
    downstream = {
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': { statusCode: 200, body: enqueued('job-1') },
    };
  });

  const request = (
    method: string,
    pathname: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ statusCode: number; data: any }> =>
    new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${testPort}${pathname}`, { method, headers }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ statusCode: res.statusCode || 500, data: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode || 500, data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

  const seedContext = (over: Partial<ContextRecord> = {}) => {
    contextStore.updateContext({
      url: 'https://www.youtube.com/watch?v=abc',
      hostname: 'www.youtube.com',
      rawTitle: 'A Video',
      documentTitle: 'A Video',
      ogTitle: '',
      twitterTitle: '',
      jsonLdTitle: '',
      canonicalTitle: 'A Video',
      tabId: 1,
      windowId: 1,
      timestamp: 1000,
      ...over,
    });
  };

  const authed = () => ({ 'X-Bridge-Secret': secretStore.getSecret() });

  it('rejects an unauthenticated request and never touches the downstream', async () => {
    seedContext();
    const res = await request('POST', '/actions/transcribe-current');
    expect(res.statusCode).toBe(401);
    expect(res.data.error).toBe('unauthorized');
    expect(downstreamCalls).toEqual([]);
  });

  it('rejects a wrong secret', async () => {
    seedContext();
    const res = await request('POST', '/actions/transcribe-current', {
      'X-Bridge-Secret': 'x'.repeat(64),
    });
    expect(res.statusCode).toBe(401);
    expect(downstreamCalls).toEqual([]);
  });

  it('rejects a disallowed origin before authentication', async () => {
    seedContext();
    const res = await request('POST', '/actions/transcribe-current', {
      Origin: 'https://evil-site.com',
      ...authed(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.data.error).toBe('origin_forbidden');
    expect(downstreamCalls).toEqual([]);
  });

  it('rejects when there is no browser context', async () => {
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('no_usable_context');
    expect(downstreamCalls).toEqual([]);
  });

  it('rejects an unusable context URL scheme', async () => {
    seedContext({ url: 'file:///C:/secret.txt' });
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('unsupported_context_url');
    expect(downstreamCalls).toEqual([]);
  });

  it('refuses to enqueue when the downstream worker is unhealthy', async () => {
    seedContext();
    downstream['/api/runtime/identity'] = {
      statusCode: 200,
      body: JSON.stringify({ worker: { status: 'stale' } }),
    };
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(503);
    expect(res.data.error).toBe('downstream_unhealthy');
    expect(downstreamCalls.map((c) => c.path)).toEqual(['/api/runtime/identity']);
  });

  it('reports downstream_unavailable when TranscriptForge is down', async () => {
    seedContext();
    downstream['/api/runtime/identity'] = 'throw';
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(503);
    expect(res.data.error).toBe('downstream_unavailable');
  });

  it('enqueues the current context URL and returns only button-facing state', async () => {
    seedContext();
    const res = await request('POST', '/actions/transcribe-current', authed());

    expect(res.statusCode).toBe(200);
    expect(res.data).toEqual({
      success: true,
      action: 'transcribe-current',
      state: 'queued',
      jobId: 'job-1',
      title: 'A Video',
    });
    // The URL came from the service's own context authority.
    expect(downstreamCalls[1].body).toEqual({ urls: ['https://www.youtube.com/watch?v=abc'] });
  });

  it('surfaces a deduplicated enqueue as success', async () => {
    seedContext();
    downstream['/api/jobs'] = {
      statusCode: 200,
      body: JSON.stringify({
        results: [{ url: 'u', jobId: 'job-7', skippedReason: 'Already queued (status: complete)' }],
      }),
    };
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.state).toBe('already_queued');
    expect(res.data.jobId).toBe('job-7');
  });

  it('normalizes a downstream failure without leaking its response shape', async () => {
    seedContext();
    downstream['/api/jobs'] = {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid request', details: { fieldErrors: { urls: ['x'] } } }),
    };
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(502);
    expect(res.data).toEqual({ success: false, error: 'downstream_error' });
  });

  it('ignores a caller-supplied url, path or method in the request body', async () => {
    seedContext();
    const res = await request('POST', '/actions/transcribe-current', authed(), {
      url: 'https://attacker.example/evil',
      urls: ['https://attacker.example/evil'],
      path: '/api/jobs/job-1/delete',
      method: 'DELETE',
    });

    expect(res.statusCode).toBe(200);
    // Only the context URL reached the downstream, on the fixed enqueue path.
    expect(downstreamCalls.map((c) => c.path)).toEqual(['/api/runtime/identity', '/api/jobs']);
    expect(downstreamCalls[1].body).toEqual({ urls: ['https://www.youtube.com/watch?v=abc'] });
  });

  it('exposes no other /actions/* route', async () => {
    seedContext();
    for (const p of ['/actions/', '/actions/delete', '/actions/transcribe']) {
      const res = await request('POST', p, authed());
      expect(res.statusCode).toBe(404);
    }
    expect(downstreamCalls).toEqual([]);
  });

  /**
   * Sent over a raw socket on purpose. Node's http *client* normalizes dot
   * segments before writing the request line, so an ordinary http.request for
   * `/actions/transcribe-current/../jobs` actually sends `/actions/jobs` and
   * proves nothing. url.parse does not normalize, and the route match is exact
   * string equality — this asserts that directly.
   */
  const rawRequest = (requestLine: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const socket = net.connect(testPort, '127.0.0.1', () => {
        const CRLF = '\r\n';
        socket.write(
          `${requestLine} HTTP/1.1${CRLF}` +
            `Host: 127.0.0.1:${testPort}${CRLF}` +
            `X-Bridge-Secret: ${secretStore.getSecret()}${CRLF}` +
            `Connection: close${CRLF}${CRLF}`
        );
      });
      let data = '';
      socket.on('data', (c) => { data += c.toString(); });
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });

  it('does not match a traversal-encoded path (raw socket, unnormalized)', async () => {
    seedContext();
    for (const line of [
      'POST /actions/transcribe-current/../jobs',
      'POST /actions/../actions/transcribe-current/../../api/jobs',
      'POST /%61ctions/transcribe-current',
      'POST /actions/transcribe-current/',
    ]) {
      const raw = await rawRequest(line);
      expect(raw).toMatch(/^HTTP\/1\.1 404 /);
    }
    expect(downstreamCalls).toEqual([]);
  });

  /**
   * Regression for a title requirement this action never had: getContext()
   * returns null without a derivable canonicalTitle, but transcription needs
   * only the URL. A direct .mp4, a bare player, or a title the cleaner strips
   * to empty must still work.
   */
  it('works on a page with no derivable title', async () => {
    seedContext({
      url: 'https://example.com/audio/ep1.mp3',
      documentTitle: '',
      rawTitle: '',
      canonicalTitle: '',
    });

    const res = await request('POST', '/actions/transcribe-current', authed());

    expect(res.statusCode).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.title).toBe('');
    expect(downstreamCalls[1].body).toEqual({ urls: ['https://example.com/audio/ep1.mp3'] });
  });

  it('still rejects when there is a title but no URL', async () => {
    seedContext({ url: '' });
    const res = await request('POST', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(400);
    expect(res.data.error).toBe('no_usable_context');
    expect(downstreamCalls).toEqual([]);
  });

  it('does not accept GET on the action route', async () => {
    seedContext();
    const res = await request('GET', '/actions/transcribe-current', authed());
    expect(res.statusCode).toBe(404);
    expect(downstreamCalls).toEqual([]);
  });
});
