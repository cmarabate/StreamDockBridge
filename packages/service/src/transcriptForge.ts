import * as http from 'http';

/**
 * Narrow adapter for the one TranscriptForge capability the N4 Pro may reach.
 *
 * This is deliberately not a proxy. ALLOWED_PATHS below is the entire downstream
 * surface and is enforced at runtime, not only by the type; the method is fixed
 * per path; and the only caller-supplied value anywhere is the URL, which the
 * service reads from its own browser-context authority rather than accepting
 * from the device.
 *
 * TranscriptForge's destructive routes (/api/jobs/[id]/delete,
 * /api/media/[id]/delete, the cancel/revoke family) are unauthenticated on
 * loopback, so keeping this surface closed is the boundary.
 */

export const TRANSCRIPTFORGE_HOST = '127.0.0.1';
export const TRANSCRIPTFORGE_PORT = 4317;

/**
 * Per-call inactivity budget for a downstream request.
 *
 * enqueueTranscription makes two sequential calls, so the bridge's worst case
 * is 2x this. It must stay comfortably under the plugin's own request timeout
 * (BRIDGE_TIMEOUT_MS), or the plugin gives up first and discards the specific
 * error the bridge was about to return. Note this is an inactivity timeout:
 * a downstream that drips bytes slowly is not covered.
 */
export const DOWNSTREAM_TIMEOUT_MS = 8000;

/** The complete set of downstream endpoints this adapter may ever call. */
export type DownstreamPath = '/api/runtime/identity' | '/api/jobs';

/** The method is fixed per path here, not inferred from whether a body was passed. */
export const ALLOWED_PATHS: Record<DownstreamPath, 'GET' | 'POST'> = {
  '/api/runtime/identity': 'GET',
  '/api/jobs': 'POST',
};

export interface DownstreamResponse {
  statusCode: number;
  body: string;
}

export type DownstreamRequester = (
  path: DownstreamPath,
  jsonBody?: unknown
) => Promise<DownstreamResponse>;

export type TranscribeState = 'queued' | 'already_queued';

export interface TranscribeSuccess {
  success: true;
  state: TranscribeState;
  jobId: string;
}

export interface TranscribeFailure {
  success: false;
  error: string;
  /** HTTP status the bridge service should surface for this failure. */
  status: number;
}

export type TranscribeOutcome = TranscribeSuccess | TranscribeFailure;

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus'];

function isBlockedIpv4(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 0 || a === 10) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * `::ffff:127.0.0.1` is loopback wearing an IPv6 costume, and WHATWG URL
 * rewrites it to the hex form `::ffff:7f00:1`, which matches no dotted-quad
 * check. Decode it back so the v4 rules apply.
 */
function ipv4FromMappedIpv6(host: string): string | null {
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (!mapped) return null;
  const rest = mapped[1];
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

/**
 * Hosts a media downloader must never be pointed at.
 *
 * TranscriptForge fetches whatever URL it is given, so an attacker who can
 * reach this service on loopback could otherwise use it to make TranscriptForge
 * issue requests to loopback or LAN addresses on their behalf. Nothing
 * legitimately transcribable lives at those hosts.
 *
 * Known residual: a public DNS name that resolves to loopback (localtest.me,
 * 127.0.0.1.nip.io) cannot be caught by string matching. Closing that would
 * require resolving the name here, which introduces its own rebinding window.
 * The exposure is bounded — the URL must reach contextStore through the
 * secret-gated POST /context, so the user has to actually browse to it.
 */
export function isBlockedTranscriptionHost(hostname: string): boolean {
  // A single trailing dot is a valid FQDN form that defeats naive equality.
  // URL() strips it from IP literals but preserves it on DNS names.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  // The unspecified address connects to loopback.
  if (host === '::' || host === '0:0:0:0:0:0:0:0') return true;
  // IPv6 unique-local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10)
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^fe[c-f][0-9a-f]:/.test(host)) return true;

  const mapped = ipv4FromMappedIpv6(host);
  if (mapped) return isBlockedIpv4(mapped);

  return isBlockedIpv4(host);
}

/**
 * Whether TranscriptForge has a provider that can actually acquire this URL.
 *
 * This deliberately mirrors TranscriptForge's own `detectPlatform`, narrowed to
 * the platforms its pipeline registry has providers for. It has to live here
 * because TranscriptForge accepts *any* syntactically valid URL — its
 * "Unrecognized URL" branch is unreachable, since its PLATFORMS list contains
 * "unknown". An unsupported URL is therefore accepted with a 200, then fails in
 * the worker with `no_provider`, leaving a dead job row behind. Rejecting here
 * is what keeps the button safe to press on an arbitrary page.
 *
 * instagram/x/facebook are excluded on purpose: TranscriptForge recognizes them
 * but lists them in RECOGNIZED_UNSUPPORTED_PLATFORMS.
 *
 * If TranscriptForge gains providers, this list must be widened to match.
 */
export function isSupportedTranscriptionUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  // Credentials would be forwarded to whatever the downloader contacts.
  if (parsed.username || parsed.password) return false;

  if (isBlockedTranscriptionHost(parsed.hostname)) return false;

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = parsed.pathname.toLowerCase();

  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') return true;
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return true;
  if (host === 'pca.st' || host === 'pocketcasts.com' || host.endsWith('.pocketcasts.com')) return true;

  // podcast provider: feeds and direct audio files
  if (
    pathname.endsWith('.xml') ||
    pathname.endsWith('.rss') ||
    pathname.includes('/feed') ||
    pathname.includes('/rss') ||
    AUDIO_EXTENSIONS.some((ext) => pathname.endsWith(ext))
  ) {
    return true;
  }

  return false;
}

/**
 * GET /api/runtime/identity asserts a loopback Host header, so the request must
 * name 127.0.0.1 exactly — "localhost" is rejected with 403 by that route.
 */
export const defaultDownstreamRequester: DownstreamRequester = (path, jsonBody) => {
  return new Promise((resolve, reject) => {
    // Runtime allowlist: the type alone is erased, and this function is exported.
    // hasOwnProperty, not truthiness — plain-object lookup would resolve
    // 'constructor' and friends to inherited functions and pass the check.
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_PATHS, path)) {
      reject(new Error(`downstream path not allowed: ${path}`));
      return;
    }
    const method = ALLOWED_PATHS[path];

    const payload = method === 'POST' ? JSON.stringify(jsonBody ?? {}) : undefined;
    const req = http.request(
      {
        host: TRANSCRIPTFORGE_HOST,
        port: TRANSCRIPTFORGE_PORT,
        path,
        method,
        headers: {
          Host: `${TRANSCRIPTFORGE_HOST}:${TRANSCRIPTFORGE_PORT}`,
          ...(payload === undefined
            ? {}
            : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        // Without this, a mid-body socket reset settles the promise neither way:
        // Node suppresses the error when nothing is listening for it.
        res.on('error', reject);
        res.on('end', () => resolve({ statusCode: res.statusCode || 500, body }));
      }
    );

    req.setTimeout(DOWNSTREAM_TIMEOUT_MS, () => {
      req.destroy(new Error('downstream timeout'));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
};

/**
 * "healthy" means TranscriptForge holds an unexpired worker lease (20s TTL).
 * "stale" and "none" both mean an enqueued job would sit at progress 0
 * forever, because the Next.js process never transcribes anything itself.
 *
 * Returns null when the response was received but could not be understood, so
 * the caller can distinguish that from TranscriptForge being unreachable.
 */
function readWorkerHealth(res: DownstreamResponse): boolean | null {
  if (res.statusCode !== 200) return null;
  try {
    return JSON.parse(res.body)?.worker?.status === 'healthy';
  } catch (e) {
    return null;
  }
}

/**
 * Enqueue exactly one URL, refusing when the downstream worker could not act on it.
 *
 * TranscriptForge answers 200 for enqueued, deduplicated and rejected alike, so
 * the discriminator is `skippedReason`, not `jobId` — a duplicate carries a
 * non-null jobId alongside a non-null skippedReason.
 */
export async function enqueueTranscription(
  url: string,
  request: DownstreamRequester = defaultDownstreamRequester
): Promise<TranscribeOutcome> {
  let healthRes: DownstreamResponse;
  try {
    healthRes = await request('/api/runtime/identity');
  } catch (e) {
    return { success: false, error: 'downstream_unavailable', status: 503 };
  }

  const healthy = readWorkerHealth(healthRes);
  if (healthy === null) {
    // It answered, but not with something we understand — that is not "down".
    return { success: false, error: 'downstream_error', status: 502 };
  }
  if (!healthy) {
    return { success: false, error: 'downstream_unhealthy', status: 503 };
  }

  let res: DownstreamResponse;
  try {
    res = await request('/api/jobs', { urls: [url] });
  } catch (e) {
    return { success: false, error: 'downstream_unavailable', status: 503 };
  }

  if (res.statusCode !== 200) {
    return { success: false, error: 'downstream_error', status: 502 };
  }

  let entry: { jobId?: unknown; skippedReason?: unknown } | undefined;
  try {
    entry = JSON.parse(res.body)?.results?.[0];
  } catch (e) {
    return { success: false, error: 'downstream_error', status: 502 };
  }

  if (!entry) {
    return { success: false, error: 'downstream_error', status: 502 };
  }

  const jobId = typeof entry.jobId === 'string' && entry.jobId ? entry.jobId : null;

  if (entry.skippedReason == null) {
    if (!jobId) {
      return { success: false, error: 'downstream_error', status: 502 };
    }
    return { success: true, state: 'queued', jobId };
  }

  // Skipped with a jobId is a deduplicated success; skipped without one is a refusal.
  if (jobId) {
    return { success: true, state: 'already_queued', jobId };
  }

  return { success: false, error: 'rejected_by_downstream', status: 502 };
}
