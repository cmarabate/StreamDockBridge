import {
  initExtension,
  syncActiveContext,
  getSecret,
  clearCachedSecret,
  recoveryTick,
  setFocusedWindowId,
  getFocusedWindowId,
  isFocusedWindow,
} from './background';

describe('Extension Background Unit Tests (A-F)', () => {
  let mockFetch: jest.Mock;
  let tabQueryCallback: (tabs: any[]) => void;
  let lastFocusedCallback: (win: any) => void;
  let onFocusChangedCallback: (winId: number) => void;
  let onActivatedCallback: (activeInfo: any) => void;
  let _onUpdatedCallback: (tabId: number, changeInfo: any, tab: any) => void;
  let _alarmCallback: (alarm: any) => void;

  const flushPromises = () => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    jest.clearAllMocks();
    clearCachedSecret();
    setFocusedWindowId(null);

    mockFetch = jest.fn();
    (global as any).fetch = mockFetch;

    (global as any).chrome = {
      windows: {
        WINDOW_ID_NONE: -1,
        getLastFocused: jest.fn((opts, cb) => {
          lastFocusedCallback = cb;
        }),
        onFocusChanged: {
          addListener: jest.fn((cb) => {
            onFocusChangedCallback = cb;
          }),
        },
      },
      tabs: {
        query: jest.fn((queryInfo, cb) => {
          tabQueryCallback = cb;
        }),
        sendMessage: jest.fn((tabId, msg, cb) => {
          cb({ documentTitle: 'Test Page Title' });
        }),
        onActivated: {
          addListener: jest.fn((cb) => {
            onActivatedCallback = cb;
          }),
        },
        onUpdated: {
          addListener: jest.fn((cb) => {
            _onUpdatedCallback = cb;
          }),
        },
        onCreated: {
          addListener: jest.fn(),
        },
      },
      runtime: {
        lastError: undefined,
        sendMessage: jest.fn(),
        onStartup: {
          addListener: jest.fn(),
        },
        onInstalled: {
          addListener: jest.fn(),
        },
        onMessage: {
          addListener: jest.fn(),
        },
      },
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({})),
          set: jest.fn((data, cb) => cb && cb()),
          remove: jest.fn((keys, cb) => cb && cb()),
        },
      },
      alarms: {
        create: jest.fn(),
        onAlarm: {
          addListener: jest.fn((cb) => {
            _alarmCallback = cb;
          }),
        },
      },
    };
  });

  // TEST A: window 200 activation produces ZERO POSTs while window 100 is focused
  it('TEST A — background window event: activation from window 200 produces ZERO POSTs while window 100 is focused', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    initExtension();
    lastFocusedCallback({ id: 100 });

    tabQueryCallback([
      { id: 1, windowId: 100, active: true, title: 'Window 100 Page', url: 'http://example.com/page1' },
    ]);

    await flushPromises();
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:17337/auth/handshake', expect.any(Object));
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({ method: 'POST' })
    );

    mockFetch.mockClear();

    onActivatedCallback({ tabId: 2, windowId: 200 });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(getFocusedWindowId()).toBe(100);
  });

  // TEST B: switching focused window to window 200 authorizes window 200
  it('TEST B — window focus switch: window 200 becomes authorized window upon window focus change', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    initExtension();
    lastFocusedCallback({ id: 100 });

    tabQueryCallback([
      { id: 1, windowId: 100, active: true, title: 'Window 100 Page', url: 'http://example.com/page1' },
    ]);

    await flushPromises();
    await flushPromises();

    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    onFocusChangedCallback(200);

    tabQueryCallback([
      { id: 2, windowId: 200, active: true, title: 'Window 200 Page', url: 'http://example.com/page2' },
    ]);

    await flushPromises();
    await flushPromises();

    expect(getFocusedWindowId()).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Window 200 Page'),
      })
    );
  });

  // TEST C: WINDOW_ID_NONE (-1) preserves previous focused window authority
  it('TEST C — WINDOW_ID_NONE: focus change event with -1 preserves previous focused window authority', async () => {
    initExtension();
    lastFocusedCallback({ id: 100 });
    expect(getFocusedWindowId()).toBe(100);

    onFocusChangedCallback(-1);

    expect(getFocusedWindowId()).toBe(100);
    expect(isFocusedWindow(100)).toBe(true);
  });

  // TEST D: secret caching across multiple context updates
  it('TEST D — secret caching: /auth/handshake is called ONCE; subsequent updates reuse cached secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'cached-secret-456' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    setFocusedWindowId(100);

    syncActiveContext();
    tabQueryCallback([
      { id: 1, windowId: 100, active: true, title: 'Page One', url: 'http://example.com/1' },
    ]);

    await flushPromises();
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:17337/auth/handshake', expect.any(Object));
    expect(await getSecret()).toBe('cached-secret-456');

    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    syncActiveContext();
    tabQueryCallback([
      { id: 1, windowId: 100, active: true, title: 'Page Two', url: 'http://example.com/2' },
    ]);

    await flushPromises();
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalledWith('http://127.0.0.1:17337/auth/handshake', expect.any(Object));
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Bridge-Secret': 'cached-secret-456' }),
      })
    );
  });

  // TEST E: out-of-order execution sequence guard
  it('TEST E — out-of-order guard: stale older async metadata payload does NOT overwrite newer payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'test-secret' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    setFocusedWindowId(100);

    let resolveSlowSendMessage: (val: any) => void;
    (global as any).chrome.tabs.sendMessage = jest.fn((tabId, msg, cb) => {
      if (tabId === 1) {
        resolveSlowSendMessage = cb;
      } else {
        cb({ documentTitle: 'Fast Page Title' });
      }
    });

    syncActiveContext();
    const slowTabQueryCb = tabQueryCallback;

    syncActiveContext();
    const fastTabQueryCb = tabQueryCallback;

    fastTabQueryCb([
      { id: 2, windowId: 100, active: true, title: 'Fast Tab', url: 'http://example.com/fast' },
    ]);

    await flushPromises();
    await flushPromises();

    mockFetch.mockClear();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    slowTabQueryCb([
      { id: 1, windowId: 100, active: true, title: 'Slow Tab', url: 'http://example.com/slow' },
    ]);

    resolveSlowSendMessage!({ documentTitle: 'Slow Page Title' });

    await flushPromises();
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        body: expect.stringContaining('Slow Tab'),
      })
    );
  });

  // TEST F: service recovery alarm polls GET /context and triggers sync when context is null
  it('TEST F — recovery tick: alarm polling detects null context and triggers active context sync', async () => {
    initExtension();

    setFocusedWindowId(100);

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, context: null }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, secret: 'recovery-secret' }),
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    await recoveryTick();

    tabQueryCallback([
      { id: 1, windowId: 100, active: true, title: 'Recovered Tab', url: 'http://example.com/recovered' },
    ]);

    await flushPromises();
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:17337/context');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:17337/context',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Recovered Tab'),
      })
    );
  });
});
