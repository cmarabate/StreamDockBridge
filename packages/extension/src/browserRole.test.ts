import {
  loadBrowserRole,
  detectBrowserFamily,
  channelsFor,
  isBrowserMode,
  defaultDisplayName,
  generateInstanceId,
  DEFAULT_MODE,
  STORAGE_KEYS,
  RoleStorage,
} from './browserRole';

/** An in-memory stand-in for chrome.storage.local. */
function fakeStorage(initial: Record<string, unknown> = {}): RoleStorage & {
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    async get(keys: string[]) {
      const out: Record<string, unknown> = {};
      for (const key of keys) if (key in data) out[key] = data[key];
      return out;
    },
    async set(items: Record<string, unknown>) {
      Object.assign(data, items);
    },
  };
}

describe('installation identity', () => {
  it('creates and persists an id the first time', async () => {
    const storage = fakeStorage();
    const role = await loadBrowserRole(storage, { family: 'brave' });

    expect(role.browserInstanceId).toBeTruthy();
    expect(storage.data[STORAGE_KEYS.instanceId]).toBe(role.browserInstanceId);
  });

  /**
   * The id must survive the MV3 service worker being killed, or a browser would
   * lose and reclaim its own channel every time Chrome recycled the worker.
   */
  it('keeps the same id across restarts', async () => {
    const storage = fakeStorage();
    const first = await loadBrowserRole(storage, { family: 'brave' });
    const second = await loadBrowserRole(storage, { family: 'brave' });
    const third = await loadBrowserRole(storage, { family: 'brave' });

    expect(second.browserInstanceId).toBe(first.browserInstanceId);
    expect(third.browserInstanceId).toBe(first.browserInstanceId);
  });

  /** Two installations must never collide, or they would share a channel. */
  it('gives two separate installations different ids', async () => {
    const brave = await loadBrowserRole(fakeStorage(), { family: 'brave' });
    const chrome = await loadBrowserRole(fakeStorage(), { family: 'chrome' });
    expect(brave.browserInstanceId).not.toBe(chrome.browserInstanceId);
  });

  it('generates ids that do not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateInstanceId()));
    expect(ids.size).toBe(200);
  });

  /** A dead worker's messages must not outrank a live one's. */
  it('advances the connection generation on every start', async () => {
    const storage = fakeStorage();
    const first = await loadBrowserRole(storage, { family: 'chrome' });
    const second = await loadBrowserRole(storage, { family: 'chrome' });
    expect(second.connectionGeneration).toBe(first.connectionGeneration + 1);
  });

  it('can read the role without advancing the generation', async () => {
    const storage = fakeStorage();
    const first = await loadBrowserRole(storage, { family: 'chrome' });
    const peek = await loadBrowserRole(storage, { family: 'chrome', bumpGeneration: false });
    expect(peek.connectionGeneration).toBe(first.connectionGeneration);
  });
});

describe('mode', () => {
  /**
   * A single-browser user must keep working without ever opening settings, so
   * a fresh installation publishes everything.
   */
  it('defaults to HYBRID', async () => {
    const role = await loadBrowserRole(fakeStorage(), { family: 'chrome' });
    expect(role.mode).toBe(DEFAULT_MODE);
    expect(role.mode).toBe('HYBRID');
  });

  it('keeps a stored mode', async () => {
    const storage = fakeStorage({ [STORAGE_KEYS.mode]: 'MEDIA_BROWSER' });
    const role = await loadBrowserRole(storage, { family: 'brave' });
    expect(role.mode).toBe('MEDIA_BROWSER');
  });

  /** Two installations hold their own modes; nothing is shared between them. */
  it('keeps modes independent per installation', async () => {
    const braveStore = fakeStorage({ [STORAGE_KEYS.mode]: 'MEDIA_BROWSER' });
    const chromeStore = fakeStorage({ [STORAGE_KEYS.mode]: 'WORK_BROWSER' });

    const brave = await loadBrowserRole(braveStore, { family: 'brave' });
    const chrome = await loadBrowserRole(chromeStore, { family: 'chrome' });

    expect(brave.mode).toBe('MEDIA_BROWSER');
    expect(chrome.mode).toBe('WORK_BROWSER');
    expect(braveStore.data[STORAGE_KEYS.mode]).toBe('MEDIA_BROWSER');
    expect(chromeStore.data[STORAGE_KEYS.mode]).toBe('WORK_BROWSER');
  });

  it('falls back to the default when the stored mode is nonsense', async () => {
    const role = await loadBrowserRole(fakeStorage({ [STORAGE_KEYS.mode]: 'BANANA' }), {
      family: 'chrome',
    });
    expect(role.mode).toBe(DEFAULT_MODE);
  });

  it('recognises only the four real modes', () => {
    expect(isBrowserMode('MEDIA_BROWSER')).toBe(true);
    expect(isBrowserMode('WORK_BROWSER')).toBe(true);
    expect(isBrowserMode('HYBRID')).toBe(true);
    expect(isBrowserMode('DISABLED')).toBe(true);
    expect(isBrowserMode('media')).toBe(false);
    expect(isBrowserMode(undefined)).toBe(false);
  });

  it('maps each mode to the channels it may publish', () => {
    expect(channelsFor('MEDIA_BROWSER')).toEqual(['media']);
    expect(channelsFor('WORK_BROWSER')).toEqual(['page', 'project']);
    expect(channelsFor('HYBRID')).toEqual(['media', 'page', 'project']);
    expect(channelsFor('DISABLED')).toEqual([]);
  });
});

describe('browser family', () => {
  it('detects Brave through its own api', async () => {
    const nav = { brave: { isBrave: async () => true } };
    expect(await detectBrowserFamily(nav)).toBe('brave');
  });

  it('falls back to the brand list', async () => {
    expect(
      await detectBrowserFamily({ userAgentData: { brands: [{ brand: 'Microsoft Edge' }] } })
    ).toBe('edge');
    expect(
      await detectBrowserFamily({ userAgentData: { brands: [{ brand: 'Google Chrome' }] } })
    ).toBe('chrome');
  });

  it('assumes chrome when it cannot tell', async () => {
    expect(await detectBrowserFamily(undefined)).toBe('chrome');
    expect(await detectBrowserFamily({})).toBe('chrome');
  });

  it('survives a Brave check that throws', async () => {
    const nav = {
      brave: {
        isBrave: async () => {
          throw new Error('nope');
        },
      },
    };
    expect(await detectBrowserFamily(nav)).toBe('chrome');
  });

  it('names an installation recognisably by default', () => {
    expect(defaultDisplayName('brave')).toBe('Brave (this profile)');
    expect(defaultDisplayName('chrome')).toBe('Chrome (this profile)');
  });
});
