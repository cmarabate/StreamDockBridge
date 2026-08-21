import { extractPageMetadata, PageMetadata } from './metadata';

export function getPageMetadata(): PageMetadata {
  return extractPageMetadata(document);
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.action === 'GET_METADATA') {
      sendResponse(getPageMetadata());
    }
  });
}
