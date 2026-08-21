import * as http from 'http';
import { URL } from 'url';
import { contextStore, ContextRecord } from './contextStore';
import { deriveCanonicalTitle, MetadataPayload } from './titleCleaner';
import { SecretStore } from './secretStore';
import { LauncherFn, defaultSystemLauncher } from './launcher';

export const ALLOWED_EXTENSION_ID = 'ldhiheiinaifckcfjmbmaaigdmknnpgi';
export const ALLOWED_EXTENSION_ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_ID}`;

export interface ServerOptions {
  port?: number;
  host?: string;
  secretStore?: SecretStore;
  launcher?: LauncherFn;
  allowAnyExtensionOrigin?: boolean;
}

export function isAllowedOrigin(origin: string | undefined, allowAnyExtension = false): boolean {
  if (!origin) return true;
  if (origin === ALLOWED_EXTENSION_ORIGIN) return true;
  if (allowAnyExtension && origin.startsWith('chrome-extension://')) {
    return true;
  }
  return false;
}

export function createBridgeServer(options: ServerOptions = {}) {
  const port = options.port || 17337;
  const host = options.host || '127.0.0.1';
  const secretStore = options.secretStore || new SecretStore();
  const launcher = options.launcher || defaultSystemLauncher;
  const allowAnyExt = options.allowAnyExtensionOrigin || false;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers['origin'] as string | undefined;

    const setCorsHeaders = () => {
      if (!origin || isAllowedOrigin(origin, allowAnyExt)) {
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Secret, Authorization, Access-Control-Request-Private-Network');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    };

    const sendJson = (statusCode: number, data: any) => {
      setCorsHeaders();
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = statusCode;
      res.end(JSON.stringify(data));
    };

    if (req.method === 'OPTIONS') {
      if (origin && !isAllowedOrigin(origin, allowAnyExt)) {
        res.statusCode = 403;
        res.end();
        return;
      }
      setCorsHeaders();
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;

    if (origin && !isAllowedOrigin(origin, allowAnyExt)) {
      sendJson(403, { success: false, error: 'origin_forbidden' });
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(200, { status: 'ok', service: 'StreamDockBridge' });
      return;
    }

    if (req.method === 'GET' && pathname === '/context') {
      sendJson(200, { success: true, context: contextStore.getContext() });
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/handshake') {
      sendJson(200, { success: true, secret: secretStore.getSecret() });
      return;
    }

    if (req.method === 'POST' && pathname === '/context') {
      const authHeader = req.headers['x-bridge-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
      if (!secretStore.verifySecret(authHeader as string | undefined)) {
        sendJson(401, { success: false, error: 'unauthorized' });
        return;
      }

      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const meta: MetadataPayload = {
            rawTitle: payload.rawTitle,
            documentTitle: payload.documentTitle,
            ogTitle: payload.ogTitle,
            twitterTitle: payload.twitterTitle,
            jsonLdTitle: payload.jsonLdTitle,
          };
          const canonicalTitle = deriveCanonicalTitle(meta);

          const record: ContextRecord = {
            url: payload.url || '',
            hostname: payload.hostname || '',
            rawTitle: payload.rawTitle || '',
            documentTitle: payload.documentTitle,
            ogTitle: payload.ogTitle,
            twitterTitle: payload.twitterTitle,
            jsonLdTitle: payload.jsonLdTitle,
            canonicalTitle,
            tabId: payload.tabId || 0,
            windowId: payload.windowId || 0,
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

    if (req.method === 'POST' && pathname.startsWith('/lookup/')) {
      const action = pathname.replace('/lookup/', '').toLowerCase();
      const validActions = ['imdb', 'cast', 'justwatch', 'reddit'];
      if (!validActions.includes(action)) {
        sendJson(400, { success: false, error: 'invalid_action' });
        return;
      }

      const activeContext = contextStore.getContext();
      if (!activeContext || !activeContext.canonicalTitle) {
        sendJson(400, { success: false, error: 'no_usable_context' });
        return;
      }

      const query = activeContext.canonicalTitle;
      const encodedQuery = encodeURIComponent(query);
      let targetUrl = '';

      switch (action) {
        case 'imdb':
          targetUrl = `https://www.imdb.com/find?q=${encodedQuery}`;
          break;
        case 'cast':
          targetUrl = `https://www.google.com/search?q=${encodedQuery}+cast`;
          break;
        case 'justwatch':
          targetUrl = `https://www.justwatch.com/us/search?q=${encodedQuery}`;
          break;
        case 'reddit':
          targetUrl = `https://www.reddit.com/search/?q=${encodedQuery}`;
          break;
      }

      const launched = await launcher(targetUrl);
      sendJson(200, { success: true, action, query, url: targetUrl, launched });
      return;
    }

    sendJson(404, { success: false, error: 'not_found' });
  });

  return {
    start: () => new Promise<void>((resolve) => server.listen(port, host, () => resolve())),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    server,
    secretStore,
  };
}
