import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import { isBlockedAddress, isBlockedHostname, ALLOWED_PORTS } from './ipPolicy';

/**
 * Fetching a website's icon, safely.
 *
 * The owner may configure Context URL to OPEN a local address in their browser.
 * They may not cause this service to make server-side requests to one. Every
 * connection here is pinned to an address this module resolved and approved.
 */

export const MAX_RESPONSE_BYTES = 256 * 1024;
export const CONNECT_TIMEOUT_MS = 5000;
export const TOTAL_TIMEOUT_MS = 10000;
export const MAX_REDIRECTS = 3;

export type FetchFailure =
  | 'blocked_host'
  | 'blocked_address'
  | 'blocked_port'
  | 'too_many_redirects'
  | 'response_too_large'
  | 'timeout'
  | 'network_error'
  | 'bad_status';

export class IconFetchError extends Error {
  constructor(public readonly reason: FetchFailure) {
    super(reason);
    this.name = 'IconFetchError';
  }
}

export interface FetchedResource {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The URL actually retrieved, after redirects. */
  finalUrl: string;
  /** True when the ceiling stopped the read early. */
  truncated: boolean;
}

/** Performs one hop. Injectable so the redirect policy can be tested directly. */
export type HopTransport = (
  target: URL,
  deadline: number,
  options: GetOptions
) => Promise<FetchedResource>;

export interface GetOptions {
  /** Byte ceiling for the response body. */
  maxBytes?: number;
  /**
   * Stop reading at the ceiling and keep the prefix instead of failing. Correct
   * for HTML, whose <head> is at the start; wrong for an image, where a partial
   * body is useless.
   */
  allowTruncation?: boolean;
  redirectsLeft?: number;
  /** Whole-operation budget, redirects included. Defaults to TOTAL_TIMEOUT_MS. */
  totalTimeoutMs?: number;
  /**
   * Test seam only. The policy gate below runs on every hop BEFORE this is
   * called, so substituting it cannot reach a destination the policy refuses.
   */
  transport?: HopTransport;
}

/**
 * Whether a single hop may be attempted at all, judged only on this URL.
 *
 * Every hop is judged here independently: the origin the owner configured earns
 * a redirect target nothing at all, which is what closes redirect-to-private.
 */
export function hopPolicyFailure(target: URL): FetchFailure | null {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'blocked_host';
  // Credentials would be sent to the destination, and are never needed for an icon.
  if (target.username || target.password) return 'blocked_host';
  if (isBlockedHostname(target.hostname)) return 'blocked_host';

  const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
  if (!ALLOWED_PORTS.includes(port)) return 'blocked_port';

  return null;
}

/**
 * Collects a response body against a ceiling.
 *
 * Counted rather than trusting Content-Length, which may lie or be absent.
 * Split out as a small state machine so the ceiling behaviour is testable
 * without a network at all.
 */
export function createBodyCollector(maxBytes: number, allowTruncation: boolean) {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  let overflowed = false;

  return {
    /** Returns true when the caller should stop reading. */
    push(chunk: Buffer): boolean {
      if (truncated || overflowed) return true;
      if (total + chunk.length > maxBytes) {
        if (allowTruncation) {
          chunks.push(chunk.subarray(0, Math.max(0, maxBytes - total)));
          total = maxBytes;
          truncated = true;
          return true;
        }
        overflowed = true;
        return true;
      }
      total += chunk.length;
      chunks.push(chunk);
      return false;
    },
    get overflowed() {
      return overflowed;
    },
    get truncated() {
      return truncated;
    },
    get bytes() {
      return total;
    },
    body(): Buffer {
      return Buffer.concat(chunks);
    },
  };
}

/**
 * A DNS lookup that validates before it resolves, and hands back exactly one
 * approved address.
 *
 * Node calls this once per connection and connects to precisely what it
 * returns, which is what closes the check-then-connect rebinding window: the
 * name is never resolved a second time behind our back. Returning a single
 * address also matters, because with autoSelectFamily (the default since Node
 * 20) every address returned becomes a connection candidate, so validating
 * only the first of several would leave a hole.
 *
 * The hostname stays in `host` on the request, so TLS SNI and certificate
 * validation continue to use the name rather than the pinned address.
 */
export function createPinnedLookup(): typeof dns.lookup {
  const lookup = ((hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};

    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err);

      const list = (Array.isArray(addresses) ? addresses : [addresses]) as Array<{
        address: string;
        family: number;
      }>;
      const approved = list.find((entry) => entry && !isBlockedAddress(entry.address, entry.family));
      if (!approved) {
        return cb(new IconFetchError('blocked_address'));
      }

      // Node 22 passes { all: true } by default; the three-argument callback
      // form throws ERR_INVALID_IP_ADDRESS in that mode.
      if (opts.all) return cb(null, [{ address: approved.address, family: approved.family }]);
      return cb(null, approved.address, approved.family);
    });
  }) as unknown as typeof dns.lookup;

  return lookup;
}

const httpTransport: HopTransport = (target, deadline, options) =>
  new Promise((resolve, reject) => {
    // Re-checked here as well as in the loop below: this function is what
    // actually opens a socket, so it does not rely on its caller being careful.
    const refusal = hopPolicyFailure(target);
    if (refusal) return reject(new IconFetchError(refusal));

    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
    const collector = createBodyCollector(maxBytes, options.allowTruncation === true);
    const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80;
    const transport = target.protocol === 'https:' ? https : http;

    // An IPv6 literal arrives bracketed from the URL parser; Node wants it bare.
    // The policy above already judged the bracketed form, and there is no name
    // to rebind, so this only affects whether the request can be made at all.
    const host = target.hostname.replace(/^\[|\]$/g, '');

    const req = transport.request(
      {
        // The hostname, never the pinned IP: SNI and cert validation depend on it.
        host,
        port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        lookup: createPinnedLookup(),
        // No shared pool: a keep-alive socket must not outlive its policy check.
        agent: false,
        headers: {
          Accept: 'text/html,image/*;q=0.9,*/*;q=0.8',
          'User-Agent': 'StreamDockBridge/1.0 (+local site icon)',
          'Accept-Encoding': 'identity',
        },
      },
      (res) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: collector.body(),
            finalUrl: target.toString(),
            truncated: collector.truncated,
          });
        };

        res.on('data', (chunk: Buffer) => {
          if (settled) return;
          if (!collector.push(chunk)) return;
          req.destroy();
          if (collector.overflowed) {
            if (!settled) {
              settled = true;
              reject(new IconFetchError('response_too_large'));
            }
            return;
          }
          finish();
        });
        res.on('error', () => {
          if (!settled) {
            settled = true;
            reject(new IconFetchError('network_error'));
          }
        });
        res.on('end', finish);
      }
    );

    // Inactivity timeout: a peer that stops talking altogether.
    req.setTimeout(Math.max(1, Math.min(CONNECT_TIMEOUT_MS, deadline - Date.now())), () => {
      req.destroy(new IconFetchError('timeout'));
    });

    /**
     * Wall-clock cap for this hop.
     *
     * setTimeout above only fires on INACTIVITY, so a server dripping one byte
     * every four seconds resets it forever and a single hop could run for days
     * before the byte ceiling is reached. This is what actually bounds the hop.
     */
    const hardStop = setTimeout(
      () => req.destroy(new IconFetchError('timeout')),
      Math.max(1, deadline - Date.now())
    );
    // Never hold the process open on this timer alone.
    if (typeof hardStop.unref === 'function') hardStop.unref();
    const clearHardStop = () => clearTimeout(hardStop);
    req.on('close', clearHardStop);

    req.on('error', (err) => {
      clearHardStop();
      reject(err instanceof IconFetchError ? err : new IconFetchError('network_error'));
    });
    req.end();
  });

/**
 * GET a URL, re-running the full policy on every redirect hop.
 *
 * A public host redirecting to a private one is the obvious bypass, so the
 * original hostname earns nothing after the first response: each hop is judged
 * on its own.
 */
export async function safeGet(rawUrl: string, options: GetOptions = {}): Promise<FetchedResource> {
  const redirectsLeft = options.redirectsLeft ?? MAX_REDIRECTS;
  const transport = options.transport ?? httpTransport;
  // One budget for the whole operation, so a chain of individually-fast
  // redirects cannot keep the request alive indefinitely.
  const deadline = Date.now() + (options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch (e) {
    throw new IconFetchError('network_error');
  }

  for (let hop = 0; ; hop++) {
    const refusal = hopPolicyFailure(current);
    if (refusal) throw new IconFetchError(refusal);
    if (Date.now() > deadline) throw new IconFetchError('timeout');

    const response = await transport(current, deadline, options);

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.location;
    if (!isRedirect || typeof location !== 'string' || !location) return response;

    if (hop >= redirectsLeft) throw new IconFetchError('too_many_redirects');

    try {
      current = new URL(location, current);
    } catch (e) {
      throw new IconFetchError('network_error');
    }
  }
}
