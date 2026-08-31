import { extractPageMetadata, PageMetadata } from './metadata';

export function getPageMetadata(): PageMetadata {
  return extractPageMetadata(document);
}

export function initContentScript(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  const currentRuntimeId = chrome.runtime.id;
  const globalWin = typeof window !== 'undefined' ? (window as any) : (globalThis as any);

  if (globalWin && globalWin.__STREAM_DOCK_BRIDGE_CONTENT__) {
    if (globalWin.__STREAM_DOCK_BRIDGE_CONTENT__.installedRuntimeId === currentRuntimeId) {
      return;
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.action === 'GET_METADATA') {
        sendResponse(getPageMetadata());
      }
    });

    if (globalWin) {
      globalWin.__STREAM_DOCK_BRIDGE_CONTENT__ = {
        version: '1.0.0',
        installedRuntimeId: currentRuntimeId,
      };
    }
  } catch (e) {
    // Graceful fallback if extension context is unavailable
  }
}

initContentScript();
