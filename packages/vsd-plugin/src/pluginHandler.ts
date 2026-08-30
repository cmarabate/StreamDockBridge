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

export interface KeyDownResult {
  route: string | null;
  success: boolean;
  state?: TranscribeState;
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
  headers: Record<string, string>
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.request(
      `${BRIDGE_ORIGIN}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
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

export async function handlePluginKeyDown(
  context: string,
  actionUuid: string,
  requester: HttpRequester = defaultHttpRequester,
  sendAlert?: (context: string) => void,
  transcribeRequester: TranscribeRequester = defaultTranscribeRequester
): Promise<KeyDownResult> {
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
