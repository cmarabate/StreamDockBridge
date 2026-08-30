import { handlePluginKeyDown, resolveLookupRoute, HttpRequester } from './pluginHandler';

describe('VSD Plugin Transport Handler', () => {
  it('triggers POST for IMDb action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx1', 'com.cmarabate.streamdock.streamdockbridge.imdb', mockRequester);
    expect(res.route).toBe('imdb');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['imdb']);
  });

  it('triggers POST for Cast action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx2', 'com.cmarabate.streamdock.streamdockbridge.cast', mockRequester);
    expect(res.route).toBe('cast');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['cast']);
  });

  it('triggers POST for JustWatch action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx3', 'com.cmarabate.streamdock.streamdockbridge.justwatch', mockRequester);
    expect(res.route).toBe('justwatch');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['justwatch']);
  });

  it('triggers POST for Reddit action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx4', 'com.cmarabate.streamdock.streamdockbridge.reddit', mockRequester);
    expect(res.route).toBe('reddit');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['reddit']);
  });

  it('triggers alert on requester failure or unknown route', async () => {
    let alertContext: string | null = null;
    const mockSendAlert = (ctx: string) => {
      alertContext = ctx;
    };

    const failRequester = async () => ({ statusCode: 500, success: false });

    const res = await handlePluginKeyDown('ctx5', 'com.cmarabate.streamdock.streamdockbridge.imdb', failRequester, mockSendAlert);
    expect(res.success).toBe(false);
    expect(alertContext).toBe('ctx5');
  });
});

describe('Transcribe Current Video action', () => {
  const TRANSCRIBE = 'com.cmarabate.streamdock.streamdockbridge.transcribe';

  const lookupShouldNotRun: HttpRequester = async () => {
    throw new Error('lookup requester must not be used for the transcribe action');
  };

  it('dispatches the transcribe action to the transcribe requester, not the lookup one', async () => {
    let called = 0;
    const res = await handlePluginKeyDown('ctx', TRANSCRIBE, lookupShouldNotRun, undefined, async () => {
      called++;
      return { statusCode: 200, success: true, state: 'queued' as const };
    });

    expect(called).toBe(1);
    expect(res).toEqual({ route: 'transcribe', success: true, state: 'queued' });
  });

  it('reports a deduplicated enqueue as success so the button shows OK', async () => {
    const alerted: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx',
      TRANSCRIBE,
      lookupShouldNotRun,
      (c) => alerted.push(c),
      async () => ({ statusCode: 200, success: true, state: 'already_queued' as const })
    );

    expect(res.success).toBe(true);
    expect(res.state).toBe('already_queued');
    expect(alerted).toEqual([]);
  });

  it('alerts the button when the transcribe action fails', async () => {
    const alerted: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx-9',
      TRANSCRIBE,
      lookupShouldNotRun,
      (c) => alerted.push(c),
      async () => ({ statusCode: 503, success: false })
    );

    expect(res.success).toBe(false);
    expect(alerted).toEqual(['ctx-9']);
  });

  // The real handshake/retry path in defaultTranscribeRequester is not covered
  // here: it is hardcoded to the live bridge origin, so exercising it would hit
  // the running service. This covers only how a 401 is surfaced to the button.
  it('alerts the button when the bridge answers 401', async () => {
    const alerted: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx-1',
      TRANSCRIBE,
      lookupShouldNotRun,
      (c) => alerted.push(c),
      async () => ({ statusCode: 401, success: false })
    );

    expect(res.success).toBe(false);
    expect(alerted).toEqual(['ctx-1']);
  });
});

describe('action routing cannot be widened by UUID suffix', () => {
  it('resolves each known lookup action exactly', () => {
    expect(resolveLookupRoute('com.cmarabate.streamdock.streamdockbridge.imdb')).toBe('imdb');
    expect(resolveLookupRoute('com.cmarabate.streamdock.streamdockbridge.cast')).toBe('cast');
  });

  it('does not let a longer word ending in a route name capture that route', () => {
    // A bare endsWith('cast') would have matched this and fired the cast lookup.
    expect(resolveLookupRoute('com.example.plugin.broadcast')).toBeNull();
    expect(resolveLookupRoute('com.example.plugin.podcast')).toBeNull();
    expect(resolveLookupRoute('com.example.plugin.telecast')).toBeNull();
  });

  it('returns null for unknown actions', () => {
    expect(resolveLookupRoute('com.someone.else.action')).toBeNull();
    expect(resolveLookupRoute('')).toBeNull();
  });

  it('alerts and routes nowhere for an unknown action', async () => {
    const alerted: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx-u',
      'com.example.plugin.broadcast',
      async () => { throw new Error('must not dispatch'); },
      (c) => alerted.push(c)
    );

    expect(res).toEqual({ route: null, success: false });
    expect(alerted).toEqual(['ctx-u']);
  });
});
