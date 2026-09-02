import { extractPageMetadata, PageMetadata } from './metadata';

const documentGeneration = `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function getPageMetadata(): PageMetadata {
  return { ...extractPageMetadata(document), documentGeneration };
}

/**
 * StreamDockBridge content script after the VoiceMediaBridge authority cutover.
 *
 * This surface is intentionally read-only. StreamDockBridge may observe page and
 * media metadata for Stream Deck/context features, but it no longer detects
 * voice-input lifecycle, issues media transport commands, or owns pause/resume
 * leases. VoiceMediaBridge is the sole voice/media transport authority.
 */
export function initContentScript(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  const currentRuntimeId = chrome.runtime.id;
  const globalWin = typeof window !== 'undefined' ? (window as any) : (globalThis as any);

  if (
    globalWin &&
    globalWin.__STREAM_DOCK_BRIDGE_CONTENT__?.installedRuntimeId === currentRuntimeId
  ) {
    return;
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.action === 'GET_METADATA') {
        sendResponse(getPageMetadata());
      }
    });

    if (globalWin) {
      globalWin.__STREAM_DOCK_BRIDGE_CONTENT__ = {
        version: '2.0.0',
        installedRuntimeId: currentRuntimeId,
        authority: 'context-only',
      };
    }
  } catch (_error) {
    // Graceful fallback if the extension context is unavailable.
  }
}

initContentScript();
