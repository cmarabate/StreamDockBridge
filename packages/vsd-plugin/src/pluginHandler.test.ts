import { handlePluginKeyDown, resolveLookupRoute, HttpRequester, TranscribeRequester } from './pluginHandler';

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

describe('Context URL action', () => {
  const CONTEXT_URL = 'com.cmarabate.streamdock.streamdockbridge.contexturl';

  const lookupShouldNotRun: HttpRequester = async () => {
    throw new Error('lookup requester must not be used for the context url action');
  };
  const transcribeShouldNotRun: TranscribeRequester = async () => {
    throw new Error('transcribe requester must not be used for the context url action');
  };

  it('sends the key instance template and nothing else', async () => {
    const sent: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx',
      CONTEXT_URL,
      lookupShouldNotRun,
      undefined,
      transcribeShouldNotRun,
      { urlTemplate: 'https://www.youtube.com/results?search_query={title}+trailer' },
      async (template) => {
        sent.push(template);
        return { statusCode: 200, success: true, resolvedUrl: 'https://example.com/resolved' };
      }
    );

    expect(sent).toEqual(['https://www.youtube.com/results?search_query={title}+trailer']);
    expect(res).toEqual({
      route: 'contexturl',
      success: true,
      resolvedUrl: 'https://example.com/resolved',
    });
  });

  /**
   * The critical product requirement: the host hands each key its own
   * payload.settings, so two keys carrying the same action UUID never share
   * configuration and one cannot be changed by editing the other.
   */
  it('keeps two instances of the same action independent', async () => {
    const sent: Array<{ context: string; template: string }> = [];
    const requester = (context: string) => async (template: string) => {
      sent.push({ context, template });
      return { statusCode: 200, success: true, resolvedUrl: 'https://example.com/x' };
    };

    await handlePluginKeyDown('key-A', CONTEXT_URL, lookupShouldNotRun, undefined,
      transcribeShouldNotRun,
      { urlTemplate: 'https://www.rottentomatoes.com/search?search={title}' },
      requester('key-A'));

    await handlePluginKeyDown('key-B', CONTEXT_URL, lookupShouldNotRun, undefined,
      transcribeShouldNotRun,
      { urlTemplate: 'https://www.youtube.com/results?search_query={title}+trailer' },
      requester('key-B'));

    expect(sent).toEqual([
      { context: 'key-A', template: 'https://www.rottentomatoes.com/search?search={title}' },
      { context: 'key-B', template: 'https://www.youtube.com/results?search_query={title}+trailer' },
    ]);

    // Pressing A again still sends A's template — B did not leak into it.
    await handlePluginKeyDown('key-A', CONTEXT_URL, lookupShouldNotRun, undefined,
      transcribeShouldNotRun,
      { urlTemplate: 'https://www.rottentomatoes.com/search?search={title}' },
      requester('key-A'));
    expect(sent[2].template).toBe('https://www.rottentomatoes.com/search?search={title}');
  });

  it('alerts without calling the service when no template is configured', async () => {
    const alerted: string[] = [];
    const requester = async () => {
      throw new Error('must not reach the service');
    };

    for (const settings of [undefined, {}, { urlTemplate: '' }, { urlTemplate: '   ' }, { urlTemplate: 42 }]) {
      const res = await handlePluginKeyDown(
        'ctx-empty',
        CONTEXT_URL,
        lookupShouldNotRun,
        (c) => alerted.push(c),
        transcribeShouldNotRun,
        settings as any,
        requester
      );
      expect(res).toEqual({ route: 'contexturl', success: false });
    }
    expect(alerted).toHaveLength(5);
  });

  it('alerts when the service rejects the template', async () => {
    const alerted: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx-bad',
      CONTEXT_URL,
      lookupShouldNotRun,
      (c) => alerted.push(c),
      transcribeShouldNotRun,
      { urlTemplate: 'javascript:alert(1)' },
      async () => ({ statusCode: 400, success: false })
    );

    expect(res.success).toBe(false);
    expect(alerted).toEqual(['ctx-bad']);
  });

  it('does not collide with the other actions', async () => {
    expect(resolveLookupRoute(CONTEXT_URL)).toBeNull();

    // The lookup actions still dispatch to the lookup requester.
    const routes: string[] = [];
    const res = await handlePluginKeyDown(
      'ctx',
      'com.cmarabate.streamdock.streamdockbridge.imdb',
      async (route) => {
        routes.push(route);
        return { statusCode: 200, success: true };
      },
      undefined,
      transcribeShouldNotRun,
      { urlTemplate: 'https://example.com/should-be-ignored' },
      async () => {
        throw new Error('context url requester must not run for imdb');
      }
    );
    expect(routes).toEqual(['imdb']);
    expect(res.route).toBe('imdb');
  });
});

describe('Local Project Action', () => {
  const LOCAL_PROJECT = 'com.cmarabate.streamdock.streamdockbridge.localproject';

  it('dispatches the configured local action to the localProject requester', async () => {
    const executed: string[] = [];
    const mockRequester = async (action: string) => {
      executed.push(action);
      return { statusCode: 200, success: true, action, targetPath: 'D:\\_Dev\\Apps\\adhdeploy' };
    };

    const res = await handlePluginKeyDown(
      'ctx-local',
      LOCAL_PROJECT,
      undefined,
      undefined,
      undefined,
      { action: 'OPEN_PROJECT_TERMINAL' },
      undefined,
      mockRequester
    );

    expect(executed).toEqual(['OPEN_PROJECT_TERMINAL']);
    expect(res).toEqual({ route: 'localproject', success: true });
  });

  it('defaults to OPEN_PROJECT_TERMINAL when no settings configured', async () => {
    const executed: string[] = [];
    const mockRequester = async (action: string) => {
      executed.push(action);
      return { statusCode: 200, success: true, action };
    };

    const res = await handlePluginKeyDown(
      'ctx-default',
      LOCAL_PROJECT,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      mockRequester
    );

    expect(executed).toEqual(['OPEN_PROJECT_TERMINAL']);
    expect(res.success).toBe(true);
  });

  it('alerts when the service refuses the action (e.g. no project context)', async () => {
    const alerted: string[] = [];
    const mockRequester = async (_action: string) => {
      return { statusCode: 400, success: false, error: 'no_project_context' };
    };

    const res = await handlePluginKeyDown(
      'ctx-fail',
      LOCAL_PROJECT,
      undefined,
      (c) => alerted.push(c),
      undefined,
      { action: 'OPEN_PROJECT_FOLDER' },
      undefined,
      mockRequester
    );

    expect(res.success).toBe(false);
    expect(alerted).toEqual(['ctx-fail']);
  });
});
