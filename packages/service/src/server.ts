import http from 'http';
import { parse as parseUrl } from 'url';
import { SecretStore } from './secretStore';
import { contextStore, ContextRecord } from './contextStore';
import { deriveCanonicalTitle } from './titleCleaner';
import { exec } from 'child_process';

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  allowAnyExtensionOrigin?: boolean;
  secretStore?: SecretStore;
  launcher?: (url: string) => void;
}

export const PINNED_EXTENSION_ORIGIN = 'chrome-extension://ldhiheiinaifckcfjmbmaaigdmknnpgi';
export const ALLOWED_EXTENSION_ORIGIN = PINNED_EXTENSION_ORIGIN;

export function isAllowedOrigin(origin: string | undefined, allowAnyExtension = false): boolean {
  if (!origin) return true;
  if (allowAnyExtension) {
    if (origin.startsWith('chrome-extension://')) return true;
  }
  return origin === PINNED_EXTENSION_ORIGIN;
}

export interface BridgeServerInstance {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getPort: () => number;
  secretStore: SecretStore;
  contextStore: typeof contextStore;
  launcher: (url: string) => void;
}

export function createBridgeServer(options: BridgeServerOptions = {}): BridgeServerInstance {
  const port = options.port ?? 17337;
  const host = options.host ?? '127.0.0.1';
  const allowAnyExtension = options.allowAnyExtensionOrigin ?? false;

  const secretStore = options.secretStore ?? new SecretStore();

  let launcher: (url: string) => void =
    options.launcher ??
    ((urlToLaunch: string) => {
      const safeUrl = urlToLaunch.replace(/"/g, '\\"');
      exec(`start "" "${safeUrl}"`);
    });

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;

    const setCorsHeaders = () => {
      if (origin && isAllowedOrigin(origin, allowAnyExtension)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      } else {
        res.setHeader('Access-Control-Allow-Origin', PINNED_EXTENSION_ORIGIN);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret');
    };

    setCorsHeaders();

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsed = parseUrl(req.url || '', true);
    const pathname = parsed.pathname;

    const sendJson = (statusCode: number, data: any) => {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(200, { status: 'ok', service: 'StreamDockBridge' });
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/handshake') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }
      const secret = secretStore.getSecret();
      sendJson(200, { success: true, secret });
      return;
    }

    if (req.method === 'GET' && pathname === '/context') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }
      sendJson(200, { success: true, context: contextStore.getContext() });
      return;
    }

    if (req.method === 'POST' && pathname === '/context') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }

      const clientSecret = req.headers['x-bridge-secret'];
      if (!secretStore.verifySecret(clientSecret as string | undefined)) {
        sendJson(401, { success: false, error: 'unauthorized' });
        return;
      }

      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });

      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const rawTitle = payload.documentTitle || payload.rawTitle || '';
          const cleanedTitle = deriveCanonicalTitle(payload);

          const record: ContextRecord = {
            url: payload.url || '',
            hostname: payload.hostname || '',
            rawTitle,
            documentTitle: payload.documentTitle || '',
            ogTitle: payload.ogTitle || '',
            twitterTitle: payload.twitterTitle || '',
            jsonLdTitle: payload.jsonLdTitle || '',
            canonicalTitle: cleanedTitle,
            tabId: payload.tabId ?? 0,
            windowId: payload.windowId ?? 0,
            timestamp: payload.timestamp || Date.now(),
          };

          const updated = contextStore.updateContext(record);
          sendJson(200, { success: true, updated, record: contextStore.getContext() });
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
        }
      });
      return;
    }

    const handleLookup = (action: string, urlBuilder: (q: string) => string) => {
      const current = contextStore.getContext();
      if (!current || !current.canonicalTitle) {
        sendJson(400, { success: false, error: 'no_usable_context' });
        return;
      }

      const query = current.canonicalTitle;
      const targetUrl = urlBuilder(encodeURIComponent(query));
      launcher(targetUrl);
      sendJson(200, { success: true, action, query, url: targetUrl, launched: true });
    };

    if (req.method === 'POST' && pathname === '/lookup/imdb') {
      handleLookup('imdb', (q) => `https://www.imdb.com/find?q=${q}`);
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/cast') {
      handleLookup('cast', (q) => `https://www.google.com/search?q=${q}%20cast`);
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/justwatch') {
      handleLookup('justwatch', (q) => `https://www.justwatch.com/us/search?q=${q}`);
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/reddit') {
      handleLookup('reddit', (q) => `https://www.reddit.com/search/?q=${q}`);
      return;
    }

    sendJson(404, { error: 'not_found' });
  });

  return {
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    getPort: () => port,
    secretStore,
    contextStore,
    get launcher() {
      return launcher;
    },
    set launcher(fn: (url: string) => void) {
      launcher = fn;
    },
  };
}
