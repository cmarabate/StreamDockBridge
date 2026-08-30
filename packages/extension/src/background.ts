import { PageMetadata } from './metadata';

const SERVICE_URL = 'http://127.0.0.1:17337';
let cachedSecret: string | null = null;
let latestSequenceId = 0;
let focusedWindowId: number | null = null;
let isServiceOffline = false;

export function getFocusedWindowId(): number | null {
  return focusedWindowId;
}

export function setFocusedWindowId(windowId: number | null) {
  focusedWindowId = windowId;
}

export function isFocusedWindow(winId?: number): boolean {
  if (focusedWindowId === null || winId === undefined || (typeof chrome !== 'undefined' && chrome.windows && focusedWindowId === chrome.windows.WINDOW_ID_NONE)) {
    return true;
  }
  return winId === focusedWindowId;
}

export function getIsServiceOffline(): boolean {
  return isServiceOffline;
}

export function setIsServiceOffline(offline: boolean) {
  isServiceOffline = offline;
}

export function clearCachedSecret() {
  cachedSecret = null;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.remove(['bridgeSecret']);
  }
}

export async function getSecret(forceRefresh = false): Promise<string | null> {
  if (forceRefresh) {
    clearCachedSecret();
  } else if (cachedSecret) {
    return cachedSecret;
  }

  const storageData = await new Promise<{ bridgeSecret?: string }>((resolve) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve({});
      }
    }, 300);

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local && !forceRefresh) {
      chrome.storage.local.get(['bridgeSecret'], (res) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(res || {});
        }
      });
    } else {
      clearTimeout(timer);
      resolve({});
    }
  });

  if (storageData.bridgeSecret && !forceRefresh) {
    cachedSecret = storageData.bridgeSecret;
    return cachedSecret;
  }

  try {
    const res = await fetch(`${SERVICE_URL}/auth/handshake`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.secret) {
        cachedSecret = data.secret;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ bridgeSecret: data.secret });
        }
        return cachedSecret;
      }
    }
  } catch (e: any) {
    // Handshake error ignored
  }

  return null;
}

export async function recoveryTick() {
  try {
    const res = await fetch(`${SERVICE_URL}/context`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.context === null) {
        syncActiveContext();
      }
      isServiceOffline = false;
    } else {
      isServiceOffline = true;
    }
  } catch (e) {
    isServiceOffline = true;
  }
}

export async function syncActiveContext(retryCount = 0) {
  const currentSequence = ++latestSequenceId;

  if (typeof chrome === 'undefined' || !chrome.windows || !chrome.tabs) {
    return;
  }

  chrome.windows.getAll({ populate: true }, async (windows) => {
    const err = chrome.runtime.lastError;
    if (err) { void err.message; }

    if (!windows || windows.length === 0) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    let targetWin: chrome.windows.Window | undefined;
    if (focusedWindowId !== null && focusedWindowId !== chrome.windows.WINDOW_ID_NONE) {
      targetWin = windows.find((w) => w.id === focusedWindowId);
    }
    if (!targetWin) {
      targetWin = windows.find((w) => w.focused) || windows[0];
    }

    if (!targetWin || !targetWin.tabs || targetWin.tabs.length === 0) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    const targetTab = targetWin.tabs.find((t) => t.active) || targetWin.tabs[0];
    if (!targetTab || !targetTab.id) return;
    const tabId = targetTab.id;
    const tabUrl: string = targetTab.url || targetTab.pendingUrl || '';
    const tabWindowId = targetWin.id || targetTab.windowId;

    if (!tabUrl) {
      if (retryCount < 3) {
        setTimeout(() => syncActiveContext(retryCount + 1), 200);
      }
      return;
    }

    let meta: PageMetadata = { url: tabUrl, documentTitle: targetTab.title || '' };

    try {
      meta = await new Promise<PageMetadata>((resolve) => {
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
          }
        }, 150);

        try {
          chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
            const sendErr = chrome.runtime.lastError;
            if (sendErr) { void sendErr.message; }
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              if (sendErr || !response) {
                resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
              } else {
                resolve(response);
              }
            }
          });
        } catch (e) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve({ url: tabUrl, documentTitle: targetTab?.title || '' });
          }
        }
      });
    } catch (e) {
      // Message error fallback
    }

    const docTitle = meta.documentTitle || targetTab.title || tabUrl;
    const hasRichMetadata = meta.ogTitle || meta.twitterTitle || meta.jsonLdTitle;
    const hasValidDocTitle = docTitle && !docTitle.startsWith('http://') && !docTitle.startsWith('https://');

    if (!hasRichMetadata && !hasValidDocTitle && retryCount < 3) {
      setTimeout(() => syncActiveContext(retryCount + 1), 300);
      return;
    }

    if (currentSequence !== latestSequenceId) {
      return;
    }

    let hostname = '';
    try {
      if (tabUrl) {
        hostname = new URL(tabUrl).hostname || '';
      }
    } catch (e) {
      // Invalid URL scheme
    }

    const payload = {
      url: tabUrl,
      hostname,
      rawTitle: targetTab.title || tabUrl,
      documentTitle: docTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      jsonLdSeriesTitle: meta.jsonLdSeriesTitle,
      tabId: tabId,
      windowId: tabWindowId,
      timestamp: Date.now(),
    };

    let secret = await getSecret();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (secret) {
      headers['X-Bridge-Secret'] = secret;
    }

    try {
      let res = await fetch(`${SERVICE_URL}/context`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        secret = await getSecret(true);
        if (secret) {
          headers['X-Bridge-Secret'] = secret;
          res = await fetch(`${SERVICE_URL}/context`, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          });
        }
      }

      if (res.ok) {
        isServiceOffline = false;
      } else {
        isServiceOffline = true;
      }
    } catch (e: any) {
      isServiceOffline = true;
    }
  });
}

export function initExtension() {
  try {
    if (typeof chrome !== 'undefined' && chrome.windows) {
      chrome.windows.getLastFocused({ populate: false }, (win) => {
        const err = chrome.runtime.lastError;
        if (err) { void err.message; }
        if (win && win.id !== undefined && win.id !== chrome.windows.WINDOW_ID_NONE) {
          focusedWindowId = win.id;
        }
        syncActiveContext();
      });
    } else {
      syncActiveContext();
    }
  } catch (e) {
    syncActiveContext();
  }
}

// Global scope exports on globalThis & self
try {
  (globalThis as any)['syncActiveContext'] = syncActiveContext;
  (globalThis as any)['initExtension'] = initExtension;
  if (typeof self !== 'undefined') {
    (self as any)['syncActiveContext'] = syncActiveContext;
    (self as any)['initExtension'] = initExtension;
  }
} catch (e) {
  // Global scope may be locked down in some environments; safe to ignore.
}

// Synchronous top-level MV3 event listener registrations
if (typeof chrome !== 'undefined') {
  if (chrome.runtime) {
    chrome.runtime.onStartup?.addListener(() => syncActiveContext());
    chrome.runtime.onInstalled?.addListener(() => syncActiveContext());
  }

  if (chrome.windows) {
    chrome.windows.onFocusChanged?.addListener((windowId) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = windowId;
        syncActiveContext();
      }
    });
  }

  if (chrome.tabs) {
    chrome.tabs.onActivated?.addListener((activeInfo) => {
      if (focusedWindowId === null || activeInfo.windowId === focusedWindowId) {
        syncActiveContext();
      }
    });

    chrome.tabs.onUpdated?.addListener((_tabId, changeInfo, tab) => {
      if (tab.active && isFocusedWindow(tab.windowId)) {
        if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
          syncActiveContext();
        }
      }
    });

    chrome.tabs.onCreated?.addListener((tab) => {
      if (isFocusedWindow(tab.windowId)) {
        syncActiveContext();
      }
    });
  }

  if (chrome.alarms) {
    chrome.alarms.create('service_recovery_alarm', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm?.addListener((alarm) => {
      if (alarm.name === 'service_recovery_alarm') {
        recoveryTick();
      }
    });
  }
}

// Immediate synchronous top-level execution
initExtension();
