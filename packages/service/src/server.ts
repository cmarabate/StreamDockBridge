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
import { IconService } from './iconService';
import { CONTEXT_URL_PRESETS } from './contextUrlPresets';
import {
  contextChannels,
  ContextChannel,
  CONTEXT_CHANNELS,
  BROWSER_MODES,
  BrowserMode,
  SourceIdentity,
  ProjectContext,
  ChannelPayload,
} from './contextChannels';

/**
 * Which channel a Context URL key reads.
 *
 * `auto` infers the channel from the key's CONFIGURATION. It emphatically does
 * not mean "try channels until one has data" — that is what made a media key
 * search a Supabase admin page when Brave had nothing to say.
 */
export type ContextMode = 'auto' | 'media' | 'page' | 'project';

export const CONTEXT_MODES: ContextMode[] = ['auto', 'media', 'page', 'project'];

export function readContextMode(value: unknown): ContextMode {
  return typeof value === 'string' && (CONTEXT_MODES as string[]).includes(value)
    ? (value as ContextMode)
    : 'auto';
}

/**
 * The one channel a key resolves against, decided before any context is read.
 *
 * An explicit mode always wins. `auto` looks at the template: a preset from the
 * "This page" group is about the page in front of you, and everything else is a
 * media search. Media is the default for an unrecognised template because every
 * Context URL key that existed before channels did was a media search — that is
 * the documented compatibility choice, and it fails closed rather than reaching
 * for another channel's data.
 */
export function resolveContextChannel(
  mode: ContextMode,
  urlTemplate: string
): ContextChannel {
  if (mode !== 'auto') return mode;

  const preset = CONTEXT_URL_PRESETS.find((p) => p.urlTemplate === urlTemplate);
  if (preset && preset.group === 'This page') return 'page';

  return 'media';
}

/** Named per channel so a key that fails says which context it needed. */
export const NO_CONTEXT_ERROR: Record<ContextChannel, string> = {
  media: 'no_media_context',
  page: 'no_page_context',
  project: 'no_project_context',
};

/** Trusted only for routing, never for authorization — the secret does that. */
export function readSourceIdentity(value: unknown): SourceIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.browserInstanceId === 'string' ? raw.browserInstanceId.trim() : '';
  if (!id || id.length > 128) return null;

  const mode = typeof raw.mode === 'string' && (BROWSER_MODES as string[]).includes(raw.mode)
    ? (raw.mode as BrowserMode)
    : 'DISABLED';

  const generation =
    typeof raw.connectionGeneration === 'number' && Number.isFinite(raw.connectionGeneration)
      ? Math.max(0, Math.floor(raw.connectionGeneration))
      : 0;

  const text = (input: unknown, fallback: string) =>
    typeof input === 'string' && input.trim() ? input.trim().slice(0, 64) : fallback;

  return {
    browserInstanceId: id,
    browserFamily: text(raw.browserFamily, 'unknown'),
    displayName: text(raw.displayName, 'Browser'),
    mode,
    connectionGeneration: generation,
  };
}

export function readChannel(value: unknown): ContextChannel | null {
  return typeof value === 'string' && (CONTEXT_CHANNELS as string[]).includes(value)
    ? (value as ContextChannel)
    : null;
}

/**
 * Project identity as observed by a work browser.
 *
 * Deliberately a narrow projection: only navigation-relevant identifiers are
 * accepted, so no token, key or connection string can ride along even if a
 * future extension were to send one.
 */
export function readProjectContext(value: unknown): ProjectContext | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.projectName === 'string' ? raw.projectName.trim().slice(0, 200) : '';
  if (!name) return null;

  const text = (input: unknown) =>
    typeof input === 'string' && input.trim() ? input.trim().slice(0, 200) : undefined;

  return {
    projectKey: typeof raw.projectKey === 'string' && raw.projectKey.trim()
      ? raw.projectKey.trim().slice(0, 200)
      : null,
    projectName: name,
    evidence: text(raw.evidence) || 'unknown',
    githubOwner: text(raw.githubOwner),
    githubRepo: text(raw.githubRepo),
  };
}

export interface BridgeServerOptions {
  port?: number;
  host?: string;
  allowAnyExtensionOrigin?: boolean;
  secretStore?: SecretStore;
  launcher?: (url: string) => void;
  transcriptForgeRequester?: DownstreamRequester;
  iconService?: IconService;
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
  const iconService = options.iconService ?? new IconService();

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

          /**
           * The timestamp is client-supplied, and the legacy store compares it
           * to decide staleness. A poster claiming the year 30000 would wedge
           * the store permanently, since every later honest post looks older.
           * Never trust it beyond the server's own clock.
           */
          const now = Date.now();
          const claimed = typeof payload.timestamp === 'number' ? payload.timestamp : now;
          const timestamp = claimed > now ? now : claimed;

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
            timestamp,
          };

          const source = readSourceIdentity(payload.source);

          /**
           * No source identity means an extension built before channels
           * existed. It keeps the old single-context behaviour exactly.
           */
          if (!source) {
            const updated = contextStore.updateContext(record);
            sendJson(200, { success: true, updated, record: contextStore.getContext() });
            return;
          }

          const channel = readChannel(payload.channel);
          if (!channel) {
            sendJson(400, { success: false, error: 'unknown_channel' });
            return;
          }

          /**
           * A release says "I no longer have anything for this channel" and is
           * how Chrome clears PROJECT when the current page proves nothing.
           * It must not be confusable with an empty page record.
           */
          const releasing = payload.release === true;
          let observed: ChannelPayload | null = null;
          if (!releasing) {
            observed =
              channel === 'project' ? readProjectContext(payload.project) : record;
            if (!observed) {
              sendJson(400, { success: false, error: 'invalid_payload' });
              return;
            }
          }

          const result = contextChannels.observe(
            {
              source,
              channel,
              payload: observed,
              tabId: record.tabId,
              windowId: record.windowId,
              observationSequence:
                typeof payload.observationSequence === 'number' ? payload.observationSequence : 0,
              observedAt: timestamp,
            },
            now
          );

          sendJson(200, {
            success: true,
            updated: result.accepted,
            channel,
            reason: result.accepted ? undefined : result.reason,
          });
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
        }
      });
      return;
    }

    /**
     * Everything the service currently believes, and who told it.
     *
     * Read-only and deliberately verbose: with two browsers publishing
     * different channels, "why is this key using that title" is otherwise very
     * hard to answer. Carries no secret — the bridge secret, the extension id
     * and the page's own content are all absent.
     */
    if (req.method === 'GET' && pathname === '/contexts') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }

      const describe = (channel: ContextChannel) => {
        const state = contextChannels.get(channel);
        if (!state) return null;
        const owner = contextChannels
          .listSources()
          .find((s) => s.browserInstanceId === state.browserInstanceId);
        return {
          owner: {
            browserInstanceId: state.browserInstanceId,
            displayName: owner ? owner.displayName : 'unknown',
            browserFamily: owner ? owner.browserFamily : 'unknown',
            mode: owner ? owner.mode : 'unknown',
          },
          tabId: state.tabId,
          windowId: state.windowId,
          observedAt: state.observedAt,
          value: state.payload,
        };
      };

      sendJson(200, {
        success: true,
        contexts: {
          media: describe('media'),
          page: describe('page'),
          project: describe('project'),
        },
      });
      return;
    }

    /**
     * "I am still here."
     *
     * Liveness and content are different things. A browser playing one episode
     * for an hour publishes nothing new, and without this its source would age
     * out and its media channel would be released mid-playback — the owner
     * would press a media key and get nothing. This refreshes lastSeen without
     * touching any channel.
     */
    if (req.method === 'POST' && pathname === '/sources/heartbeat') {
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
          const raw = JSON.parse(body)?.source;
          const source = readSourceIdentity(raw);
          if (!source) {
            sendJson(400, { success: false, error: 'missing_source' });
            return;
          }

          /**
           * A heartbeat must ASSERT its mode, never default it.
           *
           * readSourceIdentity falls back to DISABLED for an absent or invalid
           * mode, and registering as DISABLED releases every channel this
           * browser owns. A ping that says "still here" must not be able to
           * destroy the state it is keeping alive, so an unstated mode is a
           * bad request rather than a silent shutdown.
           */
          const statedMode = raw && typeof raw === 'object' ? (raw as any).mode : undefined;
          if (!BROWSER_MODES.includes(statedMode)) {
            sendJson(400, { success: false, error: 'missing_mode' });
            return;
          }

          const accepted = contextChannels.registerSource(source);
          // Tell the browser whether the service still holds its channels, so a
          // restart is noticed without a second round trip.
          const owned = CONTEXT_CHANNELS.filter((c) => {
            const state = contextChannels.get(c);
            return state ? state.browserInstanceId === source.browserInstanceId : false;
          });
          sendJson(200, { success: true, accepted, owned });
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
        }
      });
      return;
    }

    /** Which browser installations the service has heard from. */
    if (req.method === 'GET' && pathname === '/sources') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }
      sendJson(200, { success: true, sources: contextChannels.listSources() });
      return;
    }

    /**
     * A browser saying goodbye.
     *
     * HTTP has no connection whose loss we could notice, so a browser that
     * exits cleanly says so and its channels are released at once. The TTL in
     * the channel store is the backstop for the times it cannot.
     */
    if (req.method === 'POST' && pathname === '/sources/disconnect') {
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
          const parsed = JSON.parse(body);
          const id = typeof parsed?.browserInstanceId === 'string' ? parsed.browserInstanceId : '';
          if (!id) {
            sendJson(400, { success: false, error: 'missing_browser_instance_id' });
            return;
          }
          contextChannels.disconnect(id);
          sendJson(200, { success: true });
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
        let contextMode: ContextMode = 'auto';
        try {
          const parsed = JSON.parse(body);
          template = parsed?.template;
          contextMode = readContextMode(parsed?.contextMode);
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
          return;
        }

        if (typeof template !== 'string') {
          sendJson(400, { success: false, error: 'empty_template' });
          return;
        }

        /**
         * The channel is chosen from configuration, then read. There is no
         * second attempt: if the chosen channel is empty the key fails, and
         * says which context it wanted.
         */
        const channel = resolveContextChannel(contextMode, template);

        if (channel === 'project') {
          // Project templates need project placeholders, which do not exist
          // yet. Failing loudly beats opening some other project's page.
          sendJson(400, { success: false, error: 'project_context_unsupported' });
          return;
        }

        const current = contextChannels.getRecord(channel);
        if (!current || !current.canonicalTitle) {
          sendJson(400, { success: false, error: NO_CONTEXT_ERROR[channel] });
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
     * The icon for a Context URL key's configured site.
     *
     * Takes only the template, and answers from the template's ORIGIN alone —
     * so a title change, or an edit to the query, is answered from cache with
     * no network at all. Secret-gated for the same reason /lookup/custom is:
     * the template is caller-supplied.
     *
     * This route DOES fetch, which /lookup/custom deliberately does not, so it
     * runs under the stricter policy in ipPolicy: public HTTP(S) destinations
     * only, revalidated at every redirect hop.
     */
    if (req.method === 'POST' && pathname === '/icon/site') {
      if (!isAllowedOrigin(origin, allowAnyExtension)) {
        sendJson(403, { success: false, error: 'origin_forbidden' });
        return;
      }

      const clientSecret = req.headers['x-bridge-secret'];
      if (!secretStore.verifySecret(clientSecret as string | undefined)) {
        sendJson(401, { success: false, error: 'unauthorized' });
        return;
      }

      /**
       * A template has a 2000-character ceiling, so anything approaching this
       * is not a real request. Bounded because the body is buffered in memory
       * and this service is long-running.
       */
      const MAX_BODY_BYTES = 16 * 1024;
      let body = '';
      let aborted = false;
      req.on('data', (chunk) => {
        if (aborted) return;
        body += chunk;
        if (body.length > MAX_BODY_BYTES) {
          aborted = true;
          // Answer, then stop accumulating. Destroying the socket here would
          // race the response and the caller would see a connection error
          // rather than the refusal; the rest of the body is simply dropped,
          // so memory stays bounded either way.
          body = '';
          sendJson(413, { success: false, error: 'body_too_large' });
        }
      });

      req.on('end', () => {
        if (aborted) return;
        let template: unknown;
        let refresh = false;
        try {
          const payload = JSON.parse(body);
          template = payload?.template;
          refresh = payload?.refresh === true;
        } catch (e) {
          sendJson(400, { success: false, error: 'invalid_json' });
          return;
        }

        if (typeof template !== 'string') {
          sendJson(400, { success: false, error: 'empty_template' });
          return;
        }

        iconService
          .resolve(template, { refresh })
          .then((outcome) => {
            sendJson(200, {
              // `success` reports that the question was answered, not that an
              // icon exists: a site with no usable icon is a normal outcome,
              // and the caller distinguishes it by `status`.
              success: true,
              status: outcome.status,
              hostname: outcome.hostname,
              origin: outcome.origin,
              dataUri: outcome.icon?.dataUri,
              mime: outcome.icon?.mime,
              bytes: outcome.icon?.bytes,
              sourceUrl: outcome.icon?.sourceUrl,
            });
          })
          .catch(() => {
            if (!res.headersSent) {
              sendJson(200, { success: true, status: 'unavailable' });
            }
          });
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

      /**
       * Media first, then the page — and this is the one action where looking
       * at a second channel is right rather than dangerous.
       *
       * A media SEARCH must never fall back, because any page title is a
       * plausible-looking search term and the owner gets a silently wrong
       * result. Transcription cannot fail that way: the URL has to pass
       * isSupportedTranscriptionUrl, so a Supabase admin page is refused
       * outright rather than transcribed. That guard is what makes the second
       * look safe, and without it a video open in the work browser would not
       * be transcribable at all.
       *
       * Only the URL matters, so the record is read directly rather than
       * through getContext(), which also demands a derivable title.
       */
      const current =
        contextChannels.getRecord('media') ?? contextChannels.getRecord('page');
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
