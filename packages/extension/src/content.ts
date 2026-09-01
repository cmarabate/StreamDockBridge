import { extractPageMetadata, PageMetadata } from './metadata';
import { ChatGPTVoiceObserver } from './voiceObserver';
import { MediaPlaybackController, MediaCommandRequest } from './mediaController';
import { MediaPlaybackReconciler } from './mediaReconciler';

const documentGeneration = `document-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export function getPageMetadata(): PageMetadata {
  return { ...extractPageMetadata(document), documentGeneration };
}

let mediaController: MediaPlaybackController | null = null;
let mediaReconciler: MediaPlaybackReconciler | null = null;
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
    const publishPlaybackChange = (isPlaying: boolean) => {
      try {
        chrome.runtime.sendMessage({
          action: 'MEDIA_PLAYBACK_CHANGED',
          isPlaying,
          documentGeneration,
        });
      } catch (e) {
        void e;
      }
    };

    // 1. Initialize Media Playback Controller
    if (!mediaController) {
      mediaController = new MediaPlaybackController(documentGeneration, (evidence) => {
        try {
          chrome.runtime.sendMessage({ action: 'MEDIA_PLAYBACK_OVERRIDDEN', evidence });
        } catch (e) {
          void e;
        }
      }, publishPlaybackChange);
    }

    // Edge-triggered media events are not enough for streaming SPAs: a replacement
    // player may already be playing before its initial `play` edge is observable.
    // Reconcile newly discovered/current media state without polling or mutation.
    if (!mediaReconciler) {
      mediaReconciler = new MediaPlaybackReconciler(publishPlaybackChange);
      mediaReconciler.start();
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
        if ((message.command === 'PAUSE' || message.command === 'RESUME') && mediaController) {
          const request: MediaCommandRequest = {
            commandId: String(message.commandId || ''),
            leaseId: String(message.leaseId || ''),
            command: message.command,
            expectedDocumentGeneration:
              typeof message.expectedDocumentGeneration === 'string'
                ? message.expectedDocumentGeneration
                : undefined,
            expectedMediaTargetId:
              typeof message.expectedMediaTargetId === 'string'
                ? message.expectedMediaTargetId
                : undefined,
            expiresAt: typeof message.expiresAt === 'number' ? message.expiresAt : undefined,
          };
          mediaController
            .execute(request)
            .then(sendResponse)
            .catch(() =>
              sendResponse({
                commandId: request.commandId,
                action: request.command,
                outcome: 'FAILED',
                initialPlayback: 'unknown',
                finalPlayback: 'unknown',
                documentGeneration,
              })
            );
          return true;
        }
      }
    });

    if (globalWin) {
      globalWin.__STREAM_DOCK_BRIDGE_CONTENT__ = {
        version: '1.2.0',
        installedRuntimeId: currentRuntimeId,
      };
    }
  } catch (e) {
    // Graceful fallback if extension context is unavailable
  }
}

initContentScript();
