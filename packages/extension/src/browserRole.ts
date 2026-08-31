/**
 * What this browser installation is, and what it is for.
 *
 * The same extension package runs in Brave and in Chrome. Everything here is
 * LOCAL to one browser profile — deliberately `chrome.storage.local` and never
 * `sync`, because syncing an installation's identity across profiles would
 * hand two browsers the same id and recreate the problem this exists to solve.
 */

export type BrowserMode = 'MEDIA_BROWSER' | 'WORK_BROWSER' | 'HYBRID' | 'DISABLED';

export const BROWSER_MODES: BrowserMode[] = [
  'MEDIA_BROWSER',
  'WORK_BROWSER',
  'HYBRID',
  'DISABLED',
];

export interface BrowserRole {
  /** Stable routing identity for this installation. Not authentication. */
  browserInstanceId: string;
  browserFamily: string;
  displayName: string;
  mode: BrowserMode;
  /** Bumped on every service-worker start, so a dead worker cannot outrank a live one. */
  connectionGeneration: number;
}

export const STORAGE_KEYS = {
  instanceId: 'browserInstanceId',
  mode: 'browserMode',
  displayName: 'browserDisplayName',
  generation: 'connectionGeneration',
} as const;

/** A default a person can recognise in the settings page without editing it. */
export function defaultDisplayName(family: string): string {
  const pretty = family.charAt(0).toUpperCase() + family.slice(1);
  return `${pretty} (this profile)`;
}

/**
 * A browser's family is descriptive only.
 *
 * Brave exposes `navigator.brave.isBrave()`; everything else is Chromium as far
 * as we can tell from an extension. This never routes anything — two Chrome
 * profiles are different sources despite sharing a family, which is exactly why
 * the instance id and not the family is the identity.
 */
export async function detectBrowserFamily(nav: any = typeof navigator !== 'undefined' ? navigator : undefined): Promise<string> {
  try {
    if (nav && nav.brave && typeof nav.brave.isBrave === 'function') {
      const isBrave = await nav.brave.isBrave();
      if (isBrave) return 'brave';
    }
  } catch (e) {
    // Not Brave, or the check is unavailable.
  }

  try {
    const brands = nav && nav.userAgentData && nav.userAgentData.brands;
    if (Array.isArray(brands)) {
      const names = brands.map((b: any) => String(b.brand || '').toLowerCase());
      if (names.some((n: string) => n.includes('edge'))) return 'edge';
      if (names.some((n: string) => n.includes('opera'))) return 'opera';
      if (names.some((n: string) => n.includes('chrome'))) return 'chrome';
    }
  } catch (e) {
    // Fall through.
  }

  return 'chrome';
}

export function isBrowserMode(value: unknown): value is BrowserMode {
  return typeof value === 'string' && (BROWSER_MODES as string[]).includes(value);
}

/**
 * The default mode for a fresh installation.
 *
 * HYBRID, because a single-browser user must keep working exactly as before
 * without ever opening the settings page. Splitting roles is opt-in.
 */
export const DEFAULT_MODE: BrowserMode = 'HYBRID';

/** Minimal storage surface, so this is testable without a browser. */
export interface RoleStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/**
 * Read this installation's role, creating and persisting an id the first time.
 *
 * The id must survive extension restarts — it is what keeps a browser's channel
 * ownership continuous across the MV3 service worker being killed.
 */
export async function loadBrowserRole(
  storage: RoleStorage,
  options: {
    family?: string;
    newId?: () => string;
    bumpGeneration?: boolean;
  } = {}
): Promise<BrowserRole> {
  const stored = await storage.get([
    STORAGE_KEYS.instanceId,
    STORAGE_KEYS.mode,
    STORAGE_KEYS.displayName,
    STORAGE_KEYS.generation,
  ]);

  const family = options.family || 'chrome';
  const writes: Record<string, unknown> = {};

  let instanceId = stored[STORAGE_KEYS.instanceId];
  if (typeof instanceId !== 'string' || !instanceId) {
    instanceId = (options.newId || generateInstanceId)();
    writes[STORAGE_KEYS.instanceId] = instanceId;
  }

  const mode = isBrowserMode(stored[STORAGE_KEYS.mode]) ? stored[STORAGE_KEYS.mode] : DEFAULT_MODE;
  if (!isBrowserMode(stored[STORAGE_KEYS.mode])) writes[STORAGE_KEYS.mode] = mode;

  let displayName = stored[STORAGE_KEYS.displayName];
  if (typeof displayName !== 'string' || !displayName.trim()) {
    displayName = defaultDisplayName(family);
    writes[STORAGE_KEYS.displayName] = displayName;
  }

  const previous =
    typeof stored[STORAGE_KEYS.generation] === 'number'
      ? (stored[STORAGE_KEYS.generation] as number)
      : 0;
  const connectionGeneration = options.bumpGeneration === false ? previous : previous + 1;
  if (connectionGeneration !== previous) writes[STORAGE_KEYS.generation] = connectionGeneration;

  if (Object.keys(writes).length > 0) await storage.set(writes);

  return {
    browserInstanceId: instanceId as string,
    browserFamily: family,
    displayName: displayName as string,
    mode: mode as BrowserMode,
    connectionGeneration,
  };
}

export function generateInstanceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (e) {
    // Fall through to the manual path.
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Which channels this installation is allowed to publish. */
export function channelsFor(mode: BrowserMode): Array<'media' | 'page' | 'project'> {
  switch (mode) {
    case 'MEDIA_BROWSER':
      return ['media'];
    case 'WORK_BROWSER':
      return ['page', 'project'];
    case 'HYBRID':
      return ['media', 'page', 'project'];
    case 'DISABLED':
    default:
      return [];
  }
}
