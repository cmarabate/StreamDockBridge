import http from 'http';
import { parse as parseUrl } from 'url';
import { SecretStore } from './secretStore';
import { contextStore, ContextRecord } from './contextStore';
import { deriveCanonicalTitle } from './titleCleaner';
import { execFile } from 'child_process';
import {
  enqueueTranscription,
  isSupportedTranscriptionUrl,
  DownstreamRequester,
} from './transcriptForge';
import { resolveUrlTemplate, placeholderValuesFrom } from './urlTemplate';

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  allowAnyExtensionOrigin?: boolean;
  secretStore?: SecretStore;
  launcher?: (url: string) => void;
  transcriptForgeRequester?: DownstreamRequester;
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
  const transcriptForgeRequester = options.transcriptForgeRequester;

  const secretStore = options.secretStore ?? new SecretStore();

  let launcher: (url: string) => void =
    options.launcher ??
    ((urlToLaunch: string) => {
      /**
       * No shell at all.
       *
       * This previously ran `exec('start "" "<url>"')`, which goes through cmd,
       * where a double quote ends the quoted argument and `\"` is NOT an escape
       * — so the backslash escaping that was here did nothing, and a template
       * of `https://example.com/?q="&&calc.exe&&"` parsed as a valid URL and
       * broke out into a command. Context URL is what first let arbitrary
       * template text reach this call.
       *
       * execFile passes the URL as a single argv entry to ShellExecute via
       * rundll32, so there is no command line for it to escape from and no
       * quoting rules to get wrong. The refusal below is belt-and-braces: the
       * URL arrives already normalized by validateResolvedUrl.
       */
      if (urlToLaunch.includes('"')) return;
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', urlToLaunch], () => undefined);
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
            jsonLdSeriesTitle: payload.jsonLdSeriesTitle || '',
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

    /**
     * The built-in lookups are presets: fixed templates run through the same
     * resolver the configurable Context URL action uses, so there is one
     * template authority rather than two. The literal %20 in the cast preset
     * preserves its existing destination byte-for-byte.
     */
    const handleLookup = (action: string, template: string) => {
      const current = contextStore.getContext();
      if (!current || !current.canonicalTitle) {
        sendJson(400, { success: false, error: 'no_usable_context' });
        return;
      }

      const result = resolveUrlTemplate(template, placeholderValuesFrom(current));
      if (!result.ok) {
        sendJson(result.status, { success: false, error: result.error });
        return;
      }

      launcher(result.url);
      sendJson(200, {
        success: true,
        action,
        query: current.canonicalTitle,
        url: result.url,
        launched: true,
      });
    };

    if (req.method === 'POST' && pathname === '/lookup/imdb') {
      handleLookup('imdb', 'https://www.imdb.com/find?q={title}');
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/cast') {
      handleLookup('cast', 'https://www.google.com/search?q={title}%20cast');
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/justwatch') {
      handleLookup('justwatch', 'https://www.justwatch.com/us/search?q={title}');
      return;
    }

    if (req.method === 'POST' && pathname === '/lookup/reddit') {
      handleLookup('reddit', 'https://www.reddit.com/search/?q={title}');
      return;
    }

    /**
     * Context URL: open a user-configured template against the current page.
     *
     * The caller supplies ONLY the template. Every value substituted into it
     * comes from this service's own browser context, so a key cannot carry a
     * stale copy of the media title or name a value the context does not hold.
     *
     * Behind the secret gate because the template is caller-supplied. This is a
     * browser-navigation primitive: nothing here fetches the URL.
     */
    if (req.method === 'POST' && pathname === '/lookup/custom') {
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
        let template: unknown;
        try {
          template = JSON.parse(body)?.template;
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
          return;
        }

        if (typeof template !== 'string') {
          sendJson(400, { success: false, error: 'empty_template' });
          return;
        }

        const current = contextStore.getCurrentRecord();
        if (!current) {
          sendJson(400, { success: false, error: 'no_usable_context' });
          return;
        }

        const result = resolveUrlTemplate(template, placeholderValuesFrom(current));
        if (!result.ok) {
          sendJson(result.status, { success: false, error: result.error });
          return;
        }

        launcher(result.url);
        sendJson(200, { success: true, action: 'custom', resolvedUrl: result.url });
      });
      return;
    }

    /**
     * Transcribe the page the browser is currently on.
     *
     * Unlike /lookup/*, this reaches a downstream system that persists state, so
     * it sits behind the same secret gate as POST /context. The device supplies
     * no URL, path or method — the target comes from this service's own browser
     * context authority, and the adapter's downstream surface is closed.
     */
    if (req.method === 'POST' && pathname === '/actions/transcribe-current') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }

      const clientSecret = req.headers['x-bridge-secret'];
      if (!secretStore.verifySecret(clientSecret as string | undefined)) {
        sendJson(401, { success: false, error: 'unauthorized' });
        return;
      }

      // Only the URL matters here, so read the record directly rather than
      // through getContext(), which also demands a derivable title.
      const current = contextStore.getCurrentRecord();
      if (!current || !current.url) {
        sendJson(400, { success: false, error: 'no_usable_context' });
        return;
      }

      if (!isSupportedTranscriptionUrl(current.url)) {
        sendJson(400, { success: false, error: 'unsupported_context_url' });
        return;
      }

      const title = current.canonicalTitle;

      // This route takes no input, so drain any body rather than leaving the
      // request unconsumed on a keep-alive socket.
      req.resume();

      enqueueTranscription(current.url, transcriptForgeRequester)
        .then((outcome) => {
          if (!outcome.success) {
            sendJson(outcome.status, { success: false, error: outcome.error });
            return;
          }
          // A normalized shape, not TranscriptForge's. jobId is passed through
          // for operator diagnostics; the plugin renders only success + state.
          sendJson(200, {
            success: true,
            action: 'transcribe-current',
            state: outcome.state,
            jobId: outcome.jobId,
            title,
          });
        })
        // Trailing catch, not .then's second argument, so a throw inside the
        // success handler cannot become an unhandled rejection and take down a
        // long-running service. headersSent guards against a double send.
        .catch(() => {
          if (!res.headersSent) {
            sendJson(503, { success: false, error: 'downstream_unavailable' });
          }
        });
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
