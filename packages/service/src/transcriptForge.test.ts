import {
  enqueueTranscription,
  isSupportedTranscriptionUrl,
  isBlockedTranscriptionHost,
  defaultDownstreamRequester,
  ALLOWED_PATHS,
  DownstreamPath,
  DownstreamResponse,
} from './transcriptForge';

const HEALTHY = JSON.stringify({
  app: 'transcriptforge',
  protocolVersion: 1,
  appVersion: '0.1.0',
  worker: { status: 'healthy' },
});

/**
 * Records every downstream call so tests can assert the adapter never widens
 * its surface beyond the two paths it is allowed to touch.
 */
function makeRequester(
  responses: Partial<Record<DownstreamPath, DownstreamResponse | (() => never)>>
) {
  const calls: Array<{ path: DownstreamPath; body: unknown }> = [];
  const requester = async (path: DownstreamPath, jsonBody?: unknown): Promise<DownstreamResponse> => {
    calls.push({ path, body: jsonBody });
    const entry = responses[path];
    if (typeof entry === 'function') entry();
    if (!entry) throw new Error(`unexpected path ${path}`);
    return entry as DownstreamResponse;
  };
  return { requester, calls };
}

describe('isSupportedTranscriptionUrl', () => {
  it('accepts platforms TranscriptForge has providers for', () => {
    expect(isSupportedTranscriptionUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://youtu.be/abc')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://m.youtube.com/watch?v=abc')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://www.tiktok.com/t/ZTD7FGqYd/')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://pca.st/episode/abc')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://example.com/feed/show.xml')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://example.com/audio/ep1.mp3')).toBe(true);
  });

  it('rejects non-http schemes and unparseable input', () => {
    expect(isSupportedTranscriptionUrl('file:///C:/secret.txt')).toBe(false);
    expect(isSupportedTranscriptionUrl('chrome://extensions')).toBe(false);
    expect(isSupportedTranscriptionUrl('javascript:alert(1)')).toBe(false);
    expect(isSupportedTranscriptionUrl('tf-local://abc/x.mp4')).toBe(false);
    expect(isSupportedTranscriptionUrl('not a url')).toBe(false);
    expect(isSupportedTranscriptionUrl('')).toBe(false);
  });

  /**
   * Regression: this exact URL was enqueued during runtime validation and died
   * in the worker with `No provider registered for platform "unknown"`,
   * leaving a dead job row. An ordinary web page must never be submitted.
   */
  it('rejects pages TranscriptForge has no provider for', () => {
    expect(
      isSupportedTranscriptionUrl('https://fawesome.tv/movies/10691989/i-see-you?utm_source=Reelgood')
    ).toBe(false);
    expect(isSupportedTranscriptionUrl('https://news.ycombinator.com/item?id=1')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://example.com/a')).toBe(false);
  });

  it('rejects platforms TranscriptForge recognizes but does not support', () => {
    expect(isSupportedTranscriptionUrl('https://www.instagram.com/reel/abc/')).toBe(false);
    expect(isSupportedTranscriptionUrl('https://x.com/someone/status/1')).toBe(false);
    expect(isSupportedTranscriptionUrl('https://www.facebook.com/watch/?v=1')).toBe(false);
  });
});

describe('enqueueTranscription', () => {
  it('enqueues and reports queued when the downstream accepts a new URL', async () => {
    const { requester, calls } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': {
        statusCode: 200,
        body: JSON.stringify({ results: [{ url: 'u', jobId: 'job-1', skippedReason: null }] }),
      },
    });

    const outcome = await enqueueTranscription('https://youtu.be/abc', requester);

    expect(outcome).toEqual({ success: true, state: 'queued', jobId: 'job-1' });
    expect(calls.map((c) => c.path)).toEqual(['/api/runtime/identity', '/api/jobs']);
    expect(calls[1].body).toEqual({ urls: ['https://youtu.be/abc'] });
  });

  it('treats a deduplicated result as success, not failure', async () => {
    // TranscriptForge answers 200 with a non-null jobId AND a skippedReason.
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': {
        statusCode: 200,
        body: JSON.stringify({
          results: [{ url: 'u', jobId: 'job-9', skippedReason: 'Already queued (status: complete)' }],
        }),
      },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: true,
      state: 'already_queued',
      jobId: 'job-9',
    });
  });

  it('refuses to enqueue when the worker lease is stale or absent', async () => {
    for (const status of ['stale', 'none']) {
      const { requester, calls } = makeRequester({
        '/api/runtime/identity': {
          statusCode: 200,
          body: JSON.stringify({ worker: { status } }),
        },
      });

      expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
        success: false,
        error: 'downstream_unhealthy',
        status: 503,
      });
      // Nothing was enqueued — a job would have sat at progress 0 forever.
      expect(calls.map((c) => c.path)).toEqual(['/api/runtime/identity']);
    }
  });

  it('reports downstream_unavailable when TranscriptForge is not reachable', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': () => {
        throw new Error('ECONNREFUSED');
      },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_unavailable',
      status: 503,
    });
  });

  it('normalizes a downstream error status into downstream_error', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': { statusCode: 400, body: JSON.stringify({ error: 'Invalid request' }) },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_error',
      status: 502,
    });
  });

  it('normalizes an unparseable downstream body into downstream_error', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': { statusCode: 200, body: '<html>not json</html>' },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_error',
      status: 502,
    });
  });

  it('treats a skip without a jobId as a downstream refusal', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': {
        statusCode: 200,
        body: JSON.stringify({ results: [{ url: 'u', jobId: null, skippedReason: 'Not a valid URL' }] }),
      },
    });

    expect(await enqueueTranscription('nonsense', requester)).toEqual({
      success: false,
      error: 'rejected_by_downstream',
      status: 502,
    });
  });

  it('sends only the single supplied URL and never a destructive path', async () => {
    const { requester, calls } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': {
        statusCode: 200,
        body: JSON.stringify({ results: [{ url: 'u', jobId: 'j', skippedReason: null }] }),
      },
    });

    await enqueueTranscription('https://youtu.be/abc', requester);

    const paths = calls.map((c) => c.path);
    expect(paths).toEqual(['/api/runtime/identity', '/api/jobs']);
    for (const path of paths) {
      expect(path).not.toMatch(/delete|cancel|revoke|rotate|uninstall/);
    }
    expect(calls[1].body).toEqual({ urls: ['https://youtu.be/abc'] });
  });
});

/**
 * TranscriptForge fetches whatever URL it is handed. Any local process can mint
 * the bridge secret (the origin gate permits a missing Origin, which is how the
 * plugin authenticates), so without a host policy this action would be an SSRF
 * primitive: attacker sets the context URL, TranscriptForge does the fetching.
 * The podcast-feed branch is the one that would otherwise let it through, since
 * it matches on path rather than host.
 */
describe('downstream host policy', () => {
  it('blocks loopback, private, link-local and localhost hosts', () => {
    for (const host of [
      'localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '0.0.0.0',
      '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.1',
      '169.254.169.254', '::1', '[::1]', 'fe80::1', 'fd00::1',
    ]) {
      expect(isBlockedTranscriptionHost(host)).toBe(true);
    }
  });

  it('allows ordinary public hosts', () => {
    for (const host of ['youtube.com', 'www.tiktok.com', 'pca.st', 'example.com', '8.8.8.8', '172.32.0.1']) {
      expect(isBlockedTranscriptionHost(host)).toBe(false);
    }
  });

  it('rejects a feed-shaped URL pointed at loopback or the LAN', () => {
    // These satisfy the podcast path heuristic and would otherwise be accepted.
    expect(isSupportedTranscriptionUrl('http://127.0.0.1:4317/api/feed')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://localhost:4317/rss')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://192.168.1.1/feed/x.xml')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://169.254.169.254/latest/meta-data/feed')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://[::1]:4317/feed')).toBe(false);
  });

  /**
   * These reached the host-agnostic podcast-path branch, so the host blocklist
   * was the only thing standing between them and a downstream fetch.
   */
  it('blocks IPv4-mapped IPv6, the unspecified address, and a trailing dot', () => {
    expect(isBlockedTranscriptionHost('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedTranscriptionHost('::ffff:7f00:1')).toBe(true);
    expect(isBlockedTranscriptionHost('[::ffff:7f00:1]')).toBe(true);
    expect(isBlockedTranscriptionHost('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedTranscriptionHost('::')).toBe(true);
    expect(isBlockedTranscriptionHost('localhost.')).toBe(true);
    expect(isBlockedTranscriptionHost('fec0::1')).toBe(true);

    expect(isSupportedTranscriptionUrl('http://[::ffff:127.0.0.1]/feed')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://[::ffff:7f00:1]/feed')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://[::]/feed')).toBe(false);
    expect(isSupportedTranscriptionUrl('http://localhost./rss')).toBe(false);
  });

  it('blocks numeric-format loopback spellings', () => {
    for (const u of [
      'http://2130706433/feed',
      'http://0177.0.0.1/feed',
      'http://0x7f000001/feed',
      'http://127.1/feed',
      'http://0/feed',
      'http://127.0.0.1./feed',
    ]) {
      expect(isSupportedTranscriptionUrl(u)).toBe(false);
    }
  });

  it('still allows a legitimate public podcast feed', () => {
    expect(isSupportedTranscriptionUrl('https://feeds.example.com/show/rss')).toBe(true);
    expect(isSupportedTranscriptionUrl('https://cdn.example.org/ep/12.mp3')).toBe(true);
  });

  it('rejects embedded credentials, which would be forwarded downstream', () => {
    expect(isSupportedTranscriptionUrl('https://user:pass@www.youtube.com/watch?v=abc')).toBe(false);
    expect(isSupportedTranscriptionUrl('https://user@www.youtube.com/watch?v=abc')).toBe(false);
  });
});

describe('defaultDownstreamRequester surface', () => {
  it('pins one method per allowed path', () => {
    expect(ALLOWED_PATHS).toEqual({
      '/api/runtime/identity': 'GET',
      '/api/jobs': 'POST',
    });
  });

  it('does not treat inherited Object properties as allowed paths', async () => {
    for (const bad of ['constructor', 'toString', 'valueOf', '__proto__']) {
      await expect(
        defaultDownstreamRequester(bad as unknown as DownstreamPath, {})
      ).rejects.toThrow(/not allowed/);
    }
  });

  it('refuses a path outside the allowlist at runtime, not just in the type', async () => {
    // The union is erased at runtime and this function is exported, so a cast
    // must not be enough to reach a destructive route.
    for (const bad of [
      '/api/jobs/387c3566/delete',
      '/api/media/1/delete',
      '/api/launcher/uninstall',
    ]) {
      await expect(
        defaultDownstreamRequester(bad as unknown as DownstreamPath, {})
      ).rejects.toThrow(/not allowed/);
    }
  });
});

describe('downstream failure normalization', () => {
  it('treats an unparseable health body as a downstream error, not as unreachable', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: '<html>gateway</html>' },
    });

    // It answered, so reporting "unavailable" would be wrong.
    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_error',
      status: 502,
    });
  });

  it('treats a non-200 health response as a downstream error', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 403, body: JSON.stringify({ error: 'forbidden' }) },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_error',
      status: 502,
    });
  });

  it('ignores a non-string jobId rather than echoing it', async () => {
    const { requester } = makeRequester({
      '/api/runtime/identity': { statusCode: 200, body: HEALTHY },
      '/api/jobs': {
        statusCode: 200,
        body: JSON.stringify({ results: [{ url: 'u', jobId: 12345, skippedReason: null }] }),
      },
    });

    expect(await enqueueTranscription('https://youtu.be/abc', requester)).toEqual({
      success: false,
      error: 'downstream_error',
      status: 502,
    });
  });
});
