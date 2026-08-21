import { PageMetadata } from './metadata';

const SERVICE_URL = 'http://127.0.0.1:17337';
let cachedSecret: string | null = null;

async function getSecret(): Promise<string | null> {
  if (cachedSecret) return cachedSecret;
  return new Promise((resolve) => {
    chrome.storage.local.get(['bridgeSecret'], (result) => {
      if (result.bridgeSecret) {
        cachedSecret = result.bridgeSecret;
        resolve(cachedSecret);
      } else {
        resolve(null);
      }
    });
  });
}

export async function setSecret(secret: string): Promise<void> {
  cachedSecret = secret;
  return new Promise((resolve) => {
    chrome.storage.local.set({ bridgeSecret: secret }, resolve);
  });
}

export async function syncActiveContext() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (!tabs || tabs.length === 0) return;
    const tab = tabs[0];
    if (!tab.id || !tab.url) return;

    let meta: PageMetadata = { documentTitle: tab.title || '' };

    if (tab.url.startsWith('http://') || tab.url.startsWith('https://')) {
      try {
        meta = await new Promise<PageMetadata>((resolve) => {
          chrome.tabs.sendMessage(tab.id!, { action: 'GET_METADATA' }, (response) => {
            if (chrome.runtime.lastError || !response) {
              resolve({ documentTitle: tab.title || '' });
            } else {
              resolve(response);
            }
          });
        });
      } catch (e) {
        meta = { documentTitle: tab.title || '' };
      }
    }

    const hostname = new URL(tab.url).hostname || '';
    const payload = {
      url: tab.url,
      hostname,
      rawTitle: tab.title || '',
      documentTitle: meta.documentTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      tabId: tab.id,
      windowId: tab.windowId,
      timestamp: Date.now(),
    };

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

      if (res.status === 401) {
        // If unauthorized, secret might need setup
        console.warn('[StreamDockBridge Extension] Context update unauthorized (401). Check secret.');
      }
    } catch (e) {
      // Service may be offline temporarily
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs) {
  chrome.tabs.onActivated.addListener(() => syncActiveContext());
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (tab.active && (changeInfo.status === 'complete' || changeInfo.title || changeInfo.url)) {
      syncActiveContext();
    }
  });
  chrome.windows.onFocusChanged.addListener(() => syncActiveContext());
  chrome.runtime.onStartup.addListener(() => syncActiveContext());
  chrome.runtime.onInstalled.addListener(() => syncActiveContext());
}
