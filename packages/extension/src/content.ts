import { extractPageMetadata, PageMetadata } from './metadata';

export function getPageMetadata(): PageMetadata {
  return extractPageMetadata(document);
}

export function sendContextToBackground(attempt = 0) {
  if (typeof chrome !== 'undefined' && chrome.runtime) {
    const meta = getPageMetadata();
    const payload = {
      url: window.location.href,
      hostname: window.location.hostname,
      rawTitle: document.title,
      documentTitle: meta.documentTitle,
      ogTitle: meta.ogTitle,
      twitterTitle: meta.twitterTitle,
      jsonLdTitle: meta.jsonLdTitle,
      timestamp: Date.now(),
    };
    try {
      chrome.runtime.sendMessage({ action: 'PAGE_CONTEXT_UPDATE', payload }, () => {
        if (chrome.runtime.lastError && attempt < 5) {
          setTimeout(() => sendContextToBackground(attempt + 1), 500);
        }
      });
    } catch (e) {
      if (attempt < 5) {
        setTimeout(() => sendContextToBackground(attempt + 1), 500);
      }
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.action === 'GET_METADATA') {
      sendResponse(getPageMetadata());
    }
    return true;
  });

  sendContextToBackground();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => sendContextToBackground());
  }
  window.addEventListener('load', () => sendContextToBackground());

  try {
    const observer = new MutationObserver(() => sendContextToBackground());
    observer.observe(document.head || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (e) {
    // Observer error ignored
  }
}
