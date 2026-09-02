import { ActionSettings, SiteIconRequester, defaultSiteIconRequester } from './pluginHandler';

/**
 * Who owns a Context URL key's picture, and when.
 *
 * Two facts from host archaeology shape all of this:
 *
 *  1. setImage is a volatile RUNTIME OVERLAY. Nothing about it persists; the
 *     host rebuilds the key from the profile on every page entry and restart.
 *     So the icon must be re-applied on every willAppear, not set once.
 *
 *  2. There is no proven per-key operation that hands a key back to the exact
 *     image the owner chose in VSD Craft. Asserting an overlay is therefore a
 *     one-way door within a session, which is why this module never asserts an
 *     image it does not already own.
 */

/** Icons already seen this process, so a re-appearance costs nothing at all. */
export const MAX_MEMO_ENTRIES = 32;
/**
 * And a byte ceiling, not just a count.
 *
 * 32 entries of near-maximum base64 would retain around 11 MB in the plugin
 * process — several times what the service itself keeps. Both bounds apply.
 */
export const MAX_MEMO_BYTES = 2 * 1024 * 1024;

/**
 * What the key is showing and why. The first seven come straight from the
 * service; the rest are decided here, without asking it anything.
 */
export type IconStatus =
  | 'loaded'
  | 'cached'
  | 'unavailable'
  | 'dynamic_host'
  | 'local_host'
  | 'invalid_template'
  | 'unsupported_scheme'
  | 'disabled'
  | 'empty'
  | 'error'
  | 'superseded';

export interface IconOutcome {
  status: IconStatus;
  hostname?: string;
  origin?: string;
  dataUri?: string;
}

export interface IconControllerDeps {
  request?: SiteIconRequester;
  /** Assert a favicon overlay on the key. */
  setImage: (context: string, dataUri: string) => void;
  /**
   * Put the key back to this plugin's own default image, which is the only
   * mechanism the host is proven to honour for giving up an overlay.
   */
  setDefaultImage: (context: string) => void;
}

interface ContextState {
  /**
   * Bumped by every event that changes what the key should show. A response
   * carrying a stale generation is discarded rather than applied, which is
   * what stops an old template's icon landing on a newly retargeted key.
   */
  generation: number;
  /** True only while a favicon overlay asserted by us is on the key. */
  owned: boolean;
}

/** Absent means enabled: the setting is opt-out so existing keys inherit it. */
export function autoIconEnabled(settings: ActionSettings | undefined): boolean {
  if (!settings) return true;
  return settings.autoWebsiteIcon !== false;
}

export function templateOf(settings: ActionSettings | undefined): string {
  return settings && typeof settings.urlTemplate === 'string' ? settings.urlTemplate : '';
}

export class IconController {
  private states = new Map<string, ContextState>();
  private memo = new Map<string, IconOutcome>();
  private readonly request: SiteIconRequester;
  private readonly deps: IconControllerDeps;

  constructor(deps: IconControllerDeps) {
    this.deps = deps;
    this.request = deps.request ?? defaultSiteIconRequester;
  }

  private stateFor(context: string): ContextState {
    let state = this.states.get(context);
    if (!state) {
      state = { generation: 0, owned: false };
      this.states.set(context, state);
    }
    return state;
  }

  /**
   * Give up the overlay, but only if we put one there.
   *
   * Asserting the default unconditionally would overwrite an icon the owner
   * chose in VSD Craft on a key this plugin had never touched.
   */
  private release(context: string, state: ContextState): void {
    if (!state.owned) return;
    state.owned = false;
    this.deps.setDefaultImage(context);
  }

  private memoBytes(): number {
    let total = 0;
    for (const entry of this.memo.values()) total += entry.dataUri ? entry.dataUri.length : 0;
    return total;
  }

  private remember(template: string, outcome: IconOutcome): void {
    this.memo.delete(template);
    this.memo.set(template, outcome);
    // Oldest-first eviction against both ceilings; insertion order is recency
    // order because every write reinserts.
    while (this.memo.size > MAX_MEMO_ENTRIES || this.memoBytes() > MAX_MEMO_BYTES) {
      const oldest = this.memo.keys().next();
      if (oldest.done) break;
      this.memo.delete(oldest.value);
    }
  }

  /**
   * The host has just rebuilt this key, so any overlay we had is gone and the
   * host's own image is showing. Ownership resets before we decide again.
   */
  async onWillAppear(context: string, settings: ActionSettings | undefined): Promise<IconOutcome> {
    this.stateFor(context).owned = false;
    return this.apply(context, settings);
  }

  async onDidReceiveSettings(
    context: string,
    settings: ActionSettings | undefined
  ): Promise<IconOutcome> {
    return this.apply(context, settings);
  }

  /** Bounded state: a key that goes away takes its entry with it. */
  onWillDisappear(context: string): void {
    const state = this.states.get(context);
    // Bump first: an in-flight response for this context must not act on a key
    // that is no longer on screen.
    if (state) state.generation += 1;
    this.states.delete(context);
  }

  /** The socket dropped; the host will replay willAppear for every live key. */
  onDisconnect(): void {
    for (const state of this.states.values()) state.generation += 1;
    this.states.clear();
  }

  /** Re-resolve this key's origin, bypassing both caches for it alone. */
  async refresh(context: string, settings: ActionSettings | undefined): Promise<IconOutcome> {
    const template = templateOf(settings);
    if (template) this.memo.delete(template);
    return this.apply(context, settings, true);
  }

  /** How many templates are memoized. Exposed so the bound can be asserted. */
  memoSize(): number {
    return this.memo.size;
  }

  /** How many keys hold state. Exposed so cleanup can be asserted. */
  trackedContexts(): number {
    return this.states.size;
  }

  private async apply(
    context: string,
    settings: ActionSettings | undefined,
    refresh = false
  ): Promise<IconOutcome> {
    const state = this.stateFor(context);
    // Every entry point invalidates whatever was in flight for this key.
    const generation = (state.generation += 1);

    if (!autoIconEnabled(settings)) {
      this.release(context, state);
      return { status: 'disabled' };
    }

    const template = templateOf(settings);
    if (!template.trim()) {
      this.release(context, state);
      return { status: 'empty' };
    }

    if (!refresh) {
      const memoized = this.memo.get(template);
      if (memoized) {
        if (memoized.dataUri) {
          this.deps.setImage(context, memoized.dataUri);
          state.owned = true;
        } else {
          this.release(context, state);
        }
        return { ...memoized, status: memoized.dataUri ? 'cached' : memoized.status };
      }
    }

    let response;
    let failed = false;
    try {
      response = await this.request(template, refresh);
    } catch (e) {
      // A favicon failure must never be able to disturb the key.
      failed = true;
    }

    /**
     * The key was retargeted, toggled off, or removed while this was in the
     * air. Its answer is about a question nobody is asking any more.
     *
     * Checked BEFORE reporting the failure too: a stale request that fails
     * during a fast retype would otherwise flash "Unavailable" in the panel
     * over the newer query that is still running.
     */
    const current = this.states.get(context);
    if (!current || current !== state || current.generation !== generation) {
      return { status: 'superseded' };
    }

    if (failed || !response) return { status: 'error' };

    const outcome: IconOutcome = {
      status: (response.status as IconStatus) || 'unavailable',
      hostname: response.hostname,
      origin: response.origin,
      dataUri: response.dataUri,
    };

    // Only a definite answer is worth remembering; a transient error is not.
    if (outcome.dataUri || outcome.status !== 'error') this.remember(template, outcome);

    if (outcome.dataUri) {
      this.deps.setImage(context, outcome.dataUri);
      state.owned = true;
      return outcome;
    }

    // Eligible but with nothing usable to show: stop asserting, if we were.
    this.release(context, state);
    return outcome;
  }
}
