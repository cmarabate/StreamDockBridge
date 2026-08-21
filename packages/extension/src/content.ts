import { extractPageMetadata } from './metadata';

if (typeof window !== 'undefined') {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'GET_METADATA') {
      const meta = extractPageMetadata(document);
      sendResponse(meta);
    }
    return true;
  });
}
