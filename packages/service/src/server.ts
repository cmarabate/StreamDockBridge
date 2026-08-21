import * as http from 'http';
import { contextStore, ContextRecord } from './contextStore';
import { SecretStore } from './secretStore';
import { deriveCanonicalTitle, MetadataPayload } from './titleCleaner';
import {
  LauncherFn,
  defaultSystemLauncher,
  buildImdbUrl,
  buildCastUrl,
  buildJustWatchUrl,
  buildRedditUrl,
} from './launcher';

export const ALLOWED_EXTENSION_ID = 'ldhiheiinaifckcfjmbmaaigdmknnpgi';
export const ALLOWED_EXTENSION_ORIGIN = `chrome-extension://${ALLOWED_EXTENSION_ID}`;

export interface ServerOptions {
  port?: number;
  host?: string;
  secretStore?: SecretStore;
  launcher?: LauncherFn;
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // No Origin header (Node.js, curl, direct local processes)
  if (origin === ALLOWED_EXTENSION_ORIGIN) return true; // Exact pinned Chrome Extension ID
  return false; // Reject arbitrary extension IDs and web page origins
}

export function createBridgeServer(options: ServerOptions = {}) {
  const port = options.port || 17337;
  const host = options.host || '127.0.0.1';
  const secretStore = options.secretStore || new SecretStore();
  const launcher = options.launcher || defaultSystemLauncher;

  const server = http.createServer(async (req, res) => {
    const origin = req.headers['origin'] as string | undefined;

    const setCorsHeaders = () => {
      if (!origin || isAllowedOrigin(origin)) {
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
      if (origin && !isAllowedOrigin(origin)) {
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

    if (origin && !isAllowedOrigin(origin)) {
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
      const current = contextStore.getContext();
      const title = current?.canonicalTitle;

      if (!title || !title.trim()) {
        sendJson(400, { success: false, error: 'no_usable_context' });
        return;
      }

      let targetUrl = '';
      if (action === 'imdb') {
        targetUrl = buildImdbUrl(title);
      } else if (action === 'cast') {
        targetUrl = buildCastUrl(title);
      } else if (action === 'justwatch') {
        targetUrl = buildJustWatchUrl(title);
      } else if (action === 'reddit') {
        targetUrl = buildRedditUrl(title);
      } else {
        sendJson(404, { success: false, error: 'unknown_action' });
        return;
      }

      const launched = await launcher(targetUrl);
      if (launched) {
        sendJson(200, { success: true, action, query: title, url: targetUrl });
      } else {
        sendJson(500, { success: false, error: 'launch_failed', action, url: targetUrl });
      }
      return;
    }

    if (pathname.startsWith('/lookup/')) {
      sendJson(405, { success: false, error: 'method_not_allowed' });
      return;
    }

    sendJson(404, { success: false, error: 'not_found' });
  });

  return {
    start: () => new Promise<void>((resolve) => {
      server.listen(port, host, () => {
        resolve();
      });
    }),
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
    server,
    secretStore,
  };
}
