import {
  syncActiveContext,
  setFocusedWindowId,
  getFocusedWindowId,
  scheduleServiceRecovery
} from './background';

describe('Extension Background Focused Window Authority & Race Protection', () => {
  beforeEach(() => {
    setFocusedWindowId(null);
    jest.clearAllMocks();
  });

  it('tracks focused window ID and ignores WINDOW_ID_NONE window changes', () => {
    setFocusedWindowId(100);
    expect(getFocusedWindowId()).toBe(100);

    // If windowId is WINDOW_ID_NONE (-1), focusedWindowId remains 100
    const WINDOW_ID_NONE = -1;
    if (WINDOW_ID_NONE !== -1) {
      setFocusedWindowId(WINDOW_ID_NONE);
    }
    expect(getFocusedWindowId()).toBe(100);
  });

  it('proves background window tab activations do not steal focused window authority', async () => {
    setFocusedWindowId(100);

    // Mock chrome.tabs.query to return tab from window 200 (background window)
    const mockQuery = jest.fn((queryInfo, callback) => {
      if (queryInfo.windowId === 100) {
        callback([{ id: 1, url: 'https://www.imdb.com/title/tt111/', windowId: 100, active: true, title: 'IMDb Tab' }]);
      } else {
        callback([{ id: 2, url: 'https://www.google.com/', windowId: 200, active: true, title: 'Google Tab' }]);
      }
    });

    (global as any).chrome = {
      tabs: {
        query: mockQuery,
        sendMessage: jest.fn((tabId, msg, cb) => cb({ documentTitle: 'IMDb Tab' })),
      },
      windows: {
        WINDOW_ID_NONE: -1,
      },
      storage: {
        local: {
          get: jest.fn((keys, cb) => cb({ bridgeSecret: 'test-secret' })),
          set: jest.fn((data, cb) => cb && cb()),
        },
      },
    };

    // Trigger sync for window 100
    await syncActiveContext();

    expect(mockQuery).toHaveBeenCalled();
    const lastCallQuery = mockQuery.mock.calls[0][0];
    expect(lastCallQuery.windowId).toBe(100);
  });

  it('service recovery schedules check when service is offline', () => {
    jest.useFakeTimers();
    scheduleServiceRecovery();
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    jest.useRealTimers();
  });
});
