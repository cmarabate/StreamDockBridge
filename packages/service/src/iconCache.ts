import * as fs from 'fs';
import * as path from 'path';

/**
 * The one icon cache.
 *
 * A key's icon is a property of the configured SITE, so the cache is keyed by
 * origin: every key pointing at the same site shares one entry, and editing a
 * template's query or watching something else never touches it.
 *
 * Bounds are explicit and enforced on every write, because the entries hold
 * downloaded bytes and the process is long-running.
 */

/** Cache holds at most this many origins, evicted least-recently-used first. */
export const MAX_ENTRIES = 64;
/** Refuse to cache anything larger; the fetcher's own ceiling is the same. */
export const MAX_ENTRY_BYTES = 256 * 1024;
/** Total decoded bytes across all entries. */
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/**
 * Ceiling on the data URI STRING. Base64 is 4/3 of the payload, plus a short
 * scheme prefix; the slack covers both without admitting anything absurd.
 */
export const MAX_DATA_URI_LENGTH = Math.ceil(MAX_ENTRY_BYTES * 1.4) + 64;
/** A cached icon is reused for this long before it is re-resolved. */
export const SUCCESS_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Failures are remembered too, briefly. Without this, a site with no usable
 * icon is re-fetched on every willAppear — which is exactly the redundant
 * network the feature is supposed to avoid.
 */
export const FAILURE_TTL_MS = 60 * 60 * 1000;

export interface IconCacheHit {
  dataUri: string;
  mime: string;
  bytes: number;
  sourceUrl: string;
}

interface Entry {
  /** Absent on a negative entry. */
  icon?: IconCacheHit;
  /** Present on a negative entry. */
  failure?: string;
  fetchedAt: number;
  lastUsedAt: number;
}

export type CacheLookup =
  | { state: 'miss' }
  | { state: 'hit'; icon: IconCacheHit }
  | { state: 'failed'; failure: string };

function defaultCacheFile(): string {
  const dir = path.join(process.env.APPDATA || process.cwd(), 'StreamDockBridge');
  return path.join(dir, 'iconCache.json');
}

export class IconCache {
  private entries = new Map<string, Entry>();
  private readonly file: string | null;
  private writeCounter = 0;

  /** Pass null for an in-memory-only cache; tests use that. */
  constructor(file?: string | null) {
    this.file = file === null ? null : file || defaultCacheFile();
    this.load();
  }

  get(origin: string, now = Date.now()): CacheLookup {
    const entry = this.entries.get(origin);
    if (!entry) return { state: 'miss' };

    const ttl = entry.icon ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (now - entry.fetchedAt > ttl) {
      this.entries.delete(origin);
      return { state: 'miss' };
    }

    // Reinsert so Map iteration order tracks recency; eviction relies on it.
    entry.lastUsedAt = now;
    this.entries.delete(origin);
    this.entries.set(origin, entry);

    if (entry.icon) return { state: 'hit', icon: entry.icon };
    return { state: 'failed', failure: entry.failure || 'unavailable' };
  }

  set(origin: string, icon: IconCacheHit, now = Date.now()): boolean {
    if (icon.bytes > MAX_ENTRY_BYTES) return false;
    this.entries.delete(origin);
    this.entries.set(origin, { icon, fetchedAt: now, lastUsedAt: now });
    this.enforceBounds();
    this.persist();
    return true;
  }

  setFailure(origin: string, failure: string, now = Date.now()): void {
    this.entries.delete(origin);
    this.entries.set(origin, { failure, fetchedAt: now, lastUsedAt: now });
    this.enforceBounds();
    // Deliberately no persist(): negative entries are never written, so a
    // synchronous multi-megabyte rewrite here would change nothing on disk.
  }

  /** Drop one origin so it is re-resolved. Refresh does this, not a flush. */
  invalidate(origin: string): void {
    if (this.entries.delete(origin)) this.persist();
  }

  size(): number {
    return this.entries.size;
  }

  totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.icon ? entry.icon.bytes : 0;
    return total;
  }

  /**
   * Evict oldest-used first until both ceilings hold. Insertion order is
   * recency order because every read and write reinserts.
   */
  private enforceBounds(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    while (this.totalBytes() > MAX_TOTAL_BYTES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  private load(): void {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.entries)) return;
      const now = Date.now();
      for (const raw of parsed.entries) {
        // Anything malformed on disk is dropped rather than trusted: this file
        // feeds data URIs onward to the host's image decoder.
        if (!raw || typeof raw.origin !== 'string') continue;
        const fetchedAt = typeof raw.fetchedAt === 'number' ? raw.fetchedAt : 0;
        if (raw.icon) {
          const icon = raw.icon;
          if (typeof icon.dataUri !== 'string' || typeof icon.mime !== 'string') continue;
          if (typeof icon.bytes !== 'number' || icon.bytes > MAX_ENTRY_BYTES) continue;
          /**
           * The STRING length, not the self-declared `bytes`. An entry claiming
           * `bytes: 1` alongside a 500 MB data URI otherwise passes every other
           * guard and is handed to the host's decoder.
           */
          if (icon.dataUri.length > MAX_DATA_URI_LENGTH) continue;
          // `$` also matches before a trailing newline, so reject those explicitly.
          if (/[\r\n]/.test(icon.dataUri)) continue;
          if (!/^data:image\/(png|jpeg|x-icon|webp);base64,[A-Za-z0-9+/=]*$/.test(icon.dataUri)) continue;
          if (now - fetchedAt > SUCCESS_TTL_MS) continue;
          this.entries.set(raw.origin, {
            icon: {
              dataUri: icon.dataUri,
              mime: icon.mime,
              bytes: icon.bytes,
              sourceUrl: typeof icon.sourceUrl === 'string' ? icon.sourceUrl : '',
            },
            fetchedAt,
            lastUsedAt: typeof raw.lastUsedAt === 'number' ? raw.lastUsedAt : fetchedAt,
          });
        }
        // Negative entries are deliberately not persisted, so a restart always
        // gives a site that was failing another chance.
      }
      this.enforceBounds();
    } catch (e) {
      // A corrupt cache is not worth failing the service over; start empty.
      this.entries.clear();
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const entries = [];
      for (const [origin, entry] of this.entries) {
        if (!entry.icon) continue;
        entries.push({ origin, icon: entry.icon, fetchedAt: entry.fetchedAt, lastUsedAt: entry.lastUsedAt });
      }
      // Unique per process and per write, so two instances cannot clobber one
      // another's temporary file and rename a half-written one into place.
      const tmp = `${this.file}.${process.pid}.${(this.writeCounter += 1)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }), 'utf8');
      // Atomic-ish: a crash mid-write leaves the previous file intact.
      fs.renameSync(tmp, this.file);
    } catch (e) {
      // Losing persistence degrades to an in-memory cache. Never fatal.
    }
  }
}
