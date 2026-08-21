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

export async function getSecret(): Promise<string | null> {
  if (cachedSecret) return cachedSecret;

  const storageData = await new Promise<{ bridgeSecret?: string }>((resolve) => {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get(['bridgeSecret'], (res) => resolve(res || {}));
    } else {
      resolve({});
    }
  });

  if (storageData.bridgeSecret) {
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
          await new Promise<void>((resolve) => chrome.storage.local.set({ bridgeSecret: data.secret }, () => resolve()));
        }
        return cachedSecret;
      }
    }
  } catch (e) {
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

export async function postContextPayload(payload: any) {
  const secret = await getSecret();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['X-Bridge-Secret'] = secret;
  }

  try {
    const res = await fetch(`${SERVICE_URL}/context`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      isServiceOffline = false;
    } else {
      if (res.status === 401) {
        clearCachedSecret();
      }
      isServiceOffline = true;
    }
  } catch (e) {
    isServiceOffline = true;
  }
}

export async function syncActiveContext() {
  const currentSequence = ++latestSequenceId;

  chrome.tabs.query({ active: true }, async (tabs) => {
    let activeTabs = tabs;
    if (!activeTabs || activeTabs.length === 0) {
      activeTabs = await new Promise<chrome.tabs.Tab[]>((resolve) => {
        chrome.tabs.query({}, (res) => resolve(res || []));
      });
    }
    if (!activeTabs || activeTabs.length === 0) return;

    let targetTab: chrome.tabs.Tab | null = null;
    for (const tab of activeTabs) {
      const url = tab.url || tab.pendingUrl || '';
      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        targetTab = tab;
        break;
      }
    }

    if (!targetTab) {
      targetTab = activeTabs[0];
    }

    if (!targetTab || !targetTab.id) return;
    const tabId = targetTab.id;
    const tabUrl: string = targetTab.url || targetTab.pendingUrl || '';
    const tabWindowId = targetTab.windowId;

    if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
      focusedWindowId = tabWindowId;
    }

    if (!isFocusedWindow(tabWindowId)) {
      return;
    }

    let meta: PageMetadata = { documentTitle: targetTab.title || '' };

    if (tabUrl.startsWith('http://') || tabUrl.startsWith('https://')) {
      try {
        meta = await new Promise<PageMetadata>((resolve) => {
          let resolved = false;
          const timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              resolve({ documentTitle: targetTab?.title || '' });
            }
          }, 500);

          chrome.tabs.sendMessage(tabId, { action: 'GET_METADATA' }, (response) => {
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              if (chrome.runtime?.lastError || !response) {
                resolve({ documentTitle: targetTab?.title || '' });
              } else {
                resolve(response);
              }
            }
          });
        });
      } catch (e) {
        meta = { documentTitle: targetTab.title || '' };
      }
    }

    if (currentSequence < latestSequenceId) {
      return;
    }
    if (!isFocusedWindow(tabWindowId)) {
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
      rawTitle: targetTab.title || '',
      documentTitle: meta.documentTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      tabId: tabId,
      windowId: tabWindowId,
      timestamp: Date.now(),
    };

    await postContextPayload(payload);
  });
}

export function initExtension() {
  if (typeof chrome !== 'undefined' && chrome.windows) {
    chrome.windows.getLastFocused({ populate: false }, (win) => {
      if (win && win.id !== undefined && win.id !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = win.id;
      }
      syncActiveContext();
    });

    chrome.windows.onFocusChanged.addListener((windowId) => {
      if (windowId !== chrome.windows.WINDOW_ID_NONE) {
        focusedWindowId = windowId;
        syncActiveContext();
      }
    });
  }

  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.onActivated.addListener((activeInfo) => {
      if (isFocusedWindow(activeInfo.windowId)) {
        syncActiveContext();
      }
    });

    chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
      const u = tab.url || tab.pendingUrl || '';
      if (tab.active || u.startsWith('http://') || u.startsWith('https://')) {
        if (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url) {
          syncActiveContext();
        }
      }
    });

    chrome.tabs.onCreated.addListener(() => syncActiveContext());
    chrome.runtime.onStartup.addListener(() => syncActiveContext());
    chrome.runtime.onInstalled.addListener(() => syncActiveContext());

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.action === 'PAGE_CONTEXT_UPDATE' && message.payload) {
        const payload = message.payload;
        if (sender && sender.tab) {
          payload.tabId = sender.tab.id;
          payload.windowId = sender.tab.windowId;
          if (sender.tab.windowId) {
            focusedWindowId = sender.tab.windowId;
          }
        }
        postContextPayload(payload);
        if (sendResponse) sendResponse({ success: true });
      }
      return true;
    });
  }

  if (typeof chrome !== 'undefined' && chrome.alarms) {
    chrome.alarms.create('service_recovery_alarm', { periodInMinutes: 0.5 });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'service_recovery_alarm') {
        recoveryTick();
      }
    });
  }
}

initExtension();
