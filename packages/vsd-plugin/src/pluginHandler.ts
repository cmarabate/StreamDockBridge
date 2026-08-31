import * as http from 'http';

export interface ActionMap {
  [actionUuid: string]: string; // actionUuid -> route path (e.g. 'imdb')
}

export const ROUTE_MAP: ActionMap = {
  'com.cmarabate.streamdock.streamdockbridge.imdb': 'imdb',
  'com.cmarabate.streamdock.streamdockbridge.cast': 'cast',
  'com.cmarabate.streamdock.streamdockbridge.justwatch': 'justwatch',
  'com.cmarabate.streamdock.streamdockbridge.reddit': 'reddit',
};

export const TRANSCRIBE_ACTION_UUID = 'com.cmarabate.streamdock.streamdockbridge.transcribe';
export const CONTEXT_URL_ACTION_UUID = 'com.cmarabate.streamdock.streamdockbridge.contexturl';
export const LOCAL_PROJECT_ACTION_UUID = 'com.cmarabate.streamdock.streamdockbridge.localproject';

export const BRIDGE_ORIGIN = 'http://127.0.0.1:17337';

/**
 * A bridge that accepts the connection then stalls must not wedge the button.
 *
 * Deliberately longer than the bridge's own worst case (two sequential
 * downstream calls at DOWNSTREAM_TIMEOUT_MS each). If this fired first, the
 * plugin would discard the specific error the bridge was about to send and
 * report a generic failure instead.
 */
export const BRIDGE_TIMEOUT_MS = 25000;

export type HttpRequester = (actionRoute: string) => Promise<{ statusCode: number; success: boolean }>;

export type TranscribeState = 'queued' | 'already_queued';

export interface TranscribeResponse {
  statusCode: number;
  success: boolean;
  state?: TranscribeState;
}

export type TranscribeRequester = () => Promise<TranscribeResponse>;

export interface ContextUrlResponse {
  statusCode: number;
  success: boolean;
  resolvedUrl?: string;
}

export interface LocalProjectResponse {
  statusCode: number;
  success: boolean;
  action?: string;
  targetPath?: string;
  error?: string;
}

export type LocalProjectRequester = (action: string) => Promise<LocalProjectResponse>;

/**
 * Sends the template and which context channel it reads; every value
 * substituted into it still comes from the service.
 */
export type ContextUrlRequester = (
  template: string,
  contextMode?: string
) => Promise<ContextUrlResponse>;

/** The per-key configuration the host hands us at keyDown and willAppear. */
export interface ActionSettings {
  urlTemplate?: unknown;
  /** Absent means ON: the feature is opt-out, so old keys inherit it. */
  autoWebsiteIcon?: unknown;
  /**
   * Which context channel this key reads: media, page, project, or auto.
   * Absent means auto, which infers from the template rather than falling back
   * between channels at run time.
   */
  contextMode?: unknown;
  /** Selected local project action: OPEN_PROJECT_TERMINAL, etc. */
  action?: unknown;
  localAction?: unknown;
}

export interface KeyDownResult {
  route: string | null;
  success: boolean;
  state?: TranscribeState;
  resolvedUrl?: string;
}

/**
 * Match the full action UUID, or a route suffix at a dot boundary.
 *
 * The dot boundary stops a longer word ending in a route name from capturing
 * that route — `...broadcast` would otherwise resolve to `cast` and fire the
 * wrong downstream call. It does not, and need not, stop another vendor's
 * `com.someone.else.cast`: VSD Craft only ever delivers this plugin its own
 * actions, so such a UUID never reaches here.
 */
export function resolveLookupRoute(actionUuid: string): string | null {
  for (const key of Object.keys(ROUTE_MAP)) {
    const route = ROUTE_MAP[key];
    if (actionUuid === key || actionUuid.endsWith(`.${route}`)) {
      return route;
    }
  }
  return null;
}

export const defaultHttpRequester: HttpRequester = (actionRoute: string) => {
  return new Promise((resolve) => {
    const req = http.request(
      `${BRIDGE_ORIGIN}/lookup/${actionRoute}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('error', () => resolve({ statusCode: 500, success: false }));
        res.on('end', () => {
          let success = res.statusCode === 200;
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.success === 'boolean') {
              success = parsed.success;
            }
          } catch (e) {
            // Use statusCode
          }
          resolve({ statusCode: res.statusCode || 500, success });
        });
      }
    );

    req.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      req.destroy(new Error('bridge timeout'));
    });

    req.on('error', () => {
      resolve({ statusCode: 500, success: false });
    });

    req.end();
  });
};

/** Cached bridge secret. The service mints it once and persists it to disk. */
let cachedSecret: string | null = null;

function postJson(
  path: string,
  headers: Record<string, string>,
  payload?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      `${BRIDGE_ORIGIN}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        // Without this, a mid-body reset settles the promise neither way and the
        // keyDown never completes — no OK, no alert, and a leaked socket.
        res.on('error', () => resolve({ statusCode: 0, body: '' }));
        res.on('end', () => resolve({ statusCode: res.statusCode || 500, body }));
      }
    );
    req.setTimeout(BRIDGE_TIMEOUT_MS, () => {
      req.destroy(new Error('bridge timeout'));
    });
    req.on('error', () => resolve({ statusCode: 0, body: '' }));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * The plugin sends no Origin header, which the service's origin gate permits,
 * so the handshake is how it obtains the secret that guards state-changing
 * actions. Cached because the secret is stable for the service's lifetime.
 */
async function getSecret(forceRefresh = false): Promise<string | null> {
  if (cachedSecret && !forceRefresh) return cachedSecret;
  // A refresh was requested because the cached value was rejected; do not keep
  // it, or every later press burns two round trips rediscovering that.
  if (forceRefresh) cachedSecret = null;
  const res = await postJson('/auth/handshake', {});
  if (res.statusCode !== 200) return null;
  try {
    const parsed = JSON.parse(res.body);
    cachedSecret = typeof parsed?.secret === 'string' ? parsed.secret : null;
  } catch (e) {
    cachedSecret = null;
  }
  return cachedSecret;
}

export const defaultTranscribeRequester: TranscribeRequester = async () => {
  const attempt = async (secret: string): Promise<{ statusCode: number; body: string }> =>
    postJson('/actions/transcribe-current', { 'X-Bridge-Secret': secret });

  let secret = await getSecret();
  if (!secret) return { statusCode: 401, success: false };

  let res = await attempt(secret);
  if (res.statusCode === 401) {
    // The service may have restarted with a regenerated secret.
    secret = await getSecret(true);
    if (!secret) return { statusCode: 401, success: false };
    res = await attempt(secret);
  }

  if (res.statusCode !== 200) return { statusCode: res.statusCode, success: false };

  try {
    const parsed = JSON.parse(res.body);
    return {
      statusCode: res.statusCode,
      success: parsed?.success === true,
      state: parsed?.state,
    };
  } catch (e) {
    return { statusCode: res.statusCode, success: false };
  }
};

export const defaultContextUrlRequester: ContextUrlRequester = async (
  template: string,
  contextMode?: string
) => {
  const attempt = async (secret: string) =>
    postJson(
      '/lookup/custom',
      { 'X-Bridge-Secret': secret },
      JSON.stringify(contextMode ? { template, contextMode } : { template })
    );

  let secret = await getSecret();
  if (!secret) return { statusCode: 401, success: false };

  let res = await attempt(secret);
  if (res.statusCode === 401) {
    secret = await getSecret(true);
    if (!secret) return { statusCode: 401, success: false };
    res = await attempt(secret);
  }

  if (res.statusCode !== 200) return { statusCode: res.statusCode, success: false };

  try {
    const parsed = JSON.parse(res.body);
    return {
      statusCode: res.statusCode,
      success: parsed?.success === true,
      resolvedUrl: typeof parsed?.resolvedUrl === 'string' ? parsed.resolvedUrl : undefined,
    };
  } catch (e) {
    return { statusCode: res.statusCode, success: false };
  }
};

export interface SiteIconResponse {
  /** loaded | cached | unavailable | dynamic_host | local_host | invalid_template | unsupported_scheme */
  status: string;
  hostname?: string;
  origin?: string;
  dataUri?: string;
}

/** Asks the service for the icon of the site a template points at. */
export type SiteIconRequester = (template: string, refresh?: boolean) => Promise<SiteIconResponse | null>;

/**
 * The plugin sends only the template; the service decides the origin, applies
 * the fetch policy, and owns the cache. Nothing about the current page is sent.
 */
export const defaultSiteIconRequester: SiteIconRequester = async (template, refresh = false) => {
  const attempt = async (secret: string) =>
    postJson('/icon/site', { 'X-Bridge-Secret': secret }, JSON.stringify({ template, refresh }));

  let secret = await getSecret();
  if (!secret) return null;

  let res = await attempt(secret);
  if (res.statusCode === 401) {
    secret = await getSecret(true);
    if (!secret) return null;
    res = await attempt(secret);
  }

  if (res.statusCode !== 200) return null;

  try {
    const parsed = JSON.parse(res.body);
    if (!parsed || typeof parsed.status !== 'string') return null;
    return {
      status: parsed.status,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : undefined,
      origin: typeof parsed.origin === 'string' ? parsed.origin : undefined,
      dataUri: typeof parsed.dataUri === 'string' ? parsed.dataUri : undefined,
    };
  } catch (e) {
    return null;
  }
};

export const defaultLocalProjectRequester: LocalProjectRequester = async (action: string) => {
  const attempt = async (secret: string) =>
    postJson('/actions/local', { 'X-Bridge-Secret': secret }, JSON.stringify({ action }));

  let secret = await getSecret();
  if (!secret) return { statusCode: 401, success: false, error: 'unauthorized' };

  let res = await attempt(secret);
  if (res.statusCode === 401) {
    secret = await getSecret(true);
    if (!secret) return { statusCode: 401, success: false, error: 'unauthorized' };
    res = await attempt(secret);
  }

  if (res.statusCode !== 200) {
    try {
      const parsed = JSON.parse(res.body);
      return { statusCode: res.statusCode, success: false, error: parsed?.error || 'failed' };
    } catch (e) {
      return { statusCode: res.statusCode, success: false, error: 'failed' };
    }
  }

  try {
    const parsed = JSON.parse(res.body);
    return {
      statusCode: res.statusCode,
      success: parsed?.success === true,
      action: parsed?.action,
      targetPath: parsed?.targetPath,
      error: parsed?.error,
    };
  } catch (e) {
    return { statusCode: res.statusCode, success: false, error: 'invalid_response' };
  }
};

export async function handlePluginKeyDown(
  context: string,
  actionUuid: string,
  requester: HttpRequester = defaultHttpRequester,
  sendAlert?: (context: string) => void,
  transcribeRequester: TranscribeRequester = defaultTranscribeRequester,
  settings: ActionSettings | undefined = undefined,
  contextUrlRequester: ContextUrlRequester = defaultContextUrlRequester,
  localProjectRequester: LocalProjectRequester = defaultLocalProjectRequester
): Promise<KeyDownResult> {
  if (actionUuid === LOCAL_PROJECT_ACTION_UUID || actionUuid.endsWith('.localproject')) {
    const action =
      (settings && typeof settings.action === 'string' && settings.action) ||
      (settings && typeof settings.localAction === 'string' && settings.localAction) ||
      'OPEN_PROJECT_TERMINAL';

    const result = await localProjectRequester(action);
    if (!result.success && sendAlert) {
      sendAlert(context);
    }
    return { route: 'localproject', success: result.success };
  }

  if (actionUuid === CONTEXT_URL_ACTION_UUID || actionUuid.endsWith('.contexturl')) {
    /**
     * The key owns only the template. Everything substituted into it is read
     * by the service from its own browser context, so a key can never carry a
     * stale copy of the media title.
     */
    const template = settings && typeof settings.urlTemplate === 'string' ? settings.urlTemplate : '';
    if (!template.trim()) {
      if (sendAlert) sendAlert(context);
      return { route: 'contexturl', success: false };
    }

    const contextMode =
      settings && typeof settings.contextMode === 'string' ? settings.contextMode : undefined;

    const result = await contextUrlRequester(template, contextMode);
    if (!result.success && sendAlert) {
      sendAlert(context);
    }
    return { route: 'contexturl', success: result.success, resolvedUrl: result.resolvedUrl };
  }

  if (actionUuid === TRANSCRIBE_ACTION_UUID || actionUuid.endsWith('.transcribe')) {
    const result = await transcribeRequester();
    if (!result.success && sendAlert) {
      sendAlert(context);
    }
    return { route: 'transcribe', success: result.success, state: result.state };
  }

  const route = resolveLookupRoute(actionUuid);

  if (!route) {
    if (sendAlert) sendAlert(context);
    return { route: null, success: false };
  }

  const result = await requester(route);
  if (!result.success && sendAlert) {
    sendAlert(context);
  }

  return { route, success: result.success };
}
