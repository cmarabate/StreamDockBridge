import { extractPageMetadata, PageMetadata } from './metadata';
import { ChatGPTVoiceObserver } from './voiceObserver';
import { MediaPlaybackController } from './mediaController';

export function getPageMetadata(): PageMetadata {
  return extractPageMetadata(document);
}

let mediaController: MediaPlaybackController | null = null;
let voiceObserver: ChatGPTVoiceObserver | null = null;

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
    // 1. Initialize Media Playback Controller
    if (!mediaController) {
      mediaController = new MediaPlaybackController(() => {
        try {
          chrome.runtime.sendMessage({ action: 'MEDIA_PLAYBACK_OVERRIDDEN' });
        } catch (e) {
          void e;
        }
      });
    }

    // 2. Initialize Voice Observer on ChatGPT pages
    const isChatGPT =
      typeof window !== 'undefined' &&
      /(?:chatgpt\.com|chat\.openai\.com)/i.test(window.location.hostname);

    if (isChatGPT && !voiceObserver) {
      voiceObserver = new ChatGPTVoiceObserver((event, timestamp) => {
        try {
          chrome.runtime.sendMessage({
            action: 'VOICE_LIFECYCLE',
            event,
            timestamp,
          });
        } catch (e) {
          void e;
        }
      });
      voiceObserver.start();
    }

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message && message.action === 'GET_METADATA') {
        sendResponse(getPageMetadata());
        return;
      }

      if (message && message.action === 'EXECUTE_MEDIA_COMMAND') {
        if (message.command === 'PAUSE' && mediaController) {
          mediaController.pause().then((paused) => {
            sendResponse({ success: true, paused });
          });
          return true; // async
        }
        if (message.command === 'RESUME' && mediaController) {
          mediaController.resume().then((resumed) => {
            sendResponse({ success: true, resumed });
          });
          return true; // async
        }
      }
    });

    if (globalWin) {
      globalWin.__STREAM_DOCK_BRIDGE_CONTENT__ = {
        version: '1.1.0',
        installedRuntimeId: currentRuntimeId,
      };
    }
  } catch (e) {
    // Graceful fallback if extension context is unavailable
  }
}

initContentScript();
