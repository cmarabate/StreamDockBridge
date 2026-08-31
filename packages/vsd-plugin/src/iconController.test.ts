import { IconController, autoIconEnabled, templateOf, MAX_MEMO_ENTRIES } from './iconController';
import { SiteIconResponse } from './pluginHandler';

const YOUTUBE = 'https://www.youtube.com/results?search_query={title}+trailer';
const YOUTUBE_OTHER_QUERY = 'https://www.youtube.com/results?search_query={title}+review';
const ROTTEN = 'https://www.rottentomatoes.com/search?search={title}';

const YT_ICON = 'data:image/png;base64,WU9VVFVCRQ==';
const RT_ICON = 'data:image/jpeg;base64,Uk9UVEVO';

/** A stand-in for the service that records what was asked and can be held open. */
function fakeService() {
  const asked: Array<{ template: string; refresh: boolean }> = [];
  const pending: Array<(response: SiteIconResponse | null) => void> = [];
  let auto = true;

  const responses: Record<string, SiteIconResponse> = {
    [YOUTUBE]: { status: 'loaded', hostname: 'www.youtube.com', origin: 'https://www.youtube.com', dataUri: YT_ICON },
    [YOUTUBE_OTHER_QUERY]: { status: 'cached', hostname: 'www.youtube.com', origin: 'https://www.youtube.com', dataUri: YT_ICON },
    [ROTTEN]: { status: 'loaded', hostname: 'www.rottentomatoes.com', origin: 'https://www.rottentomatoes.com', dataUri: RT_ICON },
  };

  const request = (template: string, refresh = false): Promise<SiteIconResponse | null> => {
    asked.push({ template, refresh });
    if (auto) return Promise.resolve(responses[template] ?? { status: 'unavailable' });
    return new Promise((resolve) => pending.push(resolve));
  };

  return {
    request,
    asked,
    set(template: string, response: SiteIconResponse) {
      responses[template] = response;
    },
    /** Stop answering immediately, so a response can be held mid-flight. */
    hold() {
      auto = false;
    },
    releaseAll(response?: SiteIconResponse | null) {
      const waiting = pending.splice(0, pending.length);
      for (const resolve of waiting) resolve(response === undefined ? { status: 'loaded', dataUri: YT_ICON } : response);
    },
    release(index: number, response: SiteIconResponse | null) {
      pending[index](response);
    },
    get pendingCount() {
      return pending.length;
    },
  };
}

function harness(service = fakeService()) {
  const images: Array<{ context: string; dataUri: string }> = [];
  const defaults: string[] = [];
  const controller = new IconController({
    request: service.request,
    setImage: (context, dataUri) => images.push({ context, dataUri }),
    setDefaultImage: (context) => defaults.push(context),
  });
  return { controller, images, defaults, service };
}

const settings = (urlTemplate: string, autoWebsiteIcon?: boolean) =>
  autoWebsiteIcon === undefined ? { urlTemplate } : { urlTemplate, autoWebsiteIcon };

describe('the setting itself', () => {
  /** Absent means ON, so keys configured before the feature existed inherit it. */
  it('defaults to on', () => {
    expect(autoIconEnabled(undefined)).toBe(true);
    expect(autoIconEnabled({})).toBe(true);
    expect(autoIconEnabled({ urlTemplate: YOUTUBE })).toBe(true);
    expect(autoIconEnabled({ autoWebsiteIcon: true })).toBe(true);
  });

  it('is off only when explicitly false', () => {
    expect(autoIconEnabled({ autoWebsiteIcon: false })).toBe(false);
    // Anything else is not a considered "off".
    expect(autoIconEnabled({ autoWebsiteIcon: 'no' })).toBe(true);
    expect(autoIconEnabled({ autoWebsiteIcon: 0 })).toBe(true);
  });

  it('reads only a string template', () => {
    expect(templateOf({ urlTemplate: YOUTUBE })).toBe(YOUTUBE);
    expect(templateOf({ urlTemplate: 42 })).toBe('');
    expect(templateOf(undefined)).toBe('');
  });
});

describe('applying an icon', () => {
  it('asserts the favicon when a key appears', async () => {
    const { controller, images } = harness();
    const outcome = await controller.onWillAppear('key-1', settings(YOUTUBE));
    expect(outcome.status).toBe('loaded');
    expect(images).toEqual([{ context: 'key-1', dataUri: YT_ICON }]);
  });

  /**
   * setImage is a volatile overlay: the host rebuilds the key from the profile
   * on every page entry and restart, so this has to happen every time.
   */
  it('re-applies on every appearance without asking again', async () => {
    const { controller, images, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    expect(images).toHaveLength(3);
    expect(images.every((i) => i.dataUri === YT_ICON)).toBe(true);
    expect(service.asked).toHaveLength(1);
  });

  it('asks again when the template names a different site', async () => {
    const { controller, images, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onDidReceiveSettings('key-1', settings(ROTTEN));
    expect(service.asked.map((a) => a.template)).toEqual([YOUTUBE, ROTTEN]);
    expect(images[images.length - 1]).toEqual({ context: 'key-1', dataUri: RT_ICON });
  });

  it('keeps two keys on different sites independent', async () => {
    const { controller, images } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-2', settings(ROTTEN));
    expect(images).toEqual([
      { context: 'key-1', dataUri: YT_ICON },
      { context: 'key-2', dataUri: RT_ICON },
    ]);
  });

  it('does not ask again for a template it has already resolved', async () => {
    const { controller, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-2', settings(YOUTUBE));
    expect(service.asked).toHaveLength(1);
  });

  it('does nothing at all for an empty template', async () => {
    const { controller, images, defaults, service } = harness();
    const outcome = await controller.onWillAppear('key-1', settings('   '));
    expect(outcome.status).toBe('empty');
    expect(service.asked).toHaveLength(0);
    expect(images).toHaveLength(0);
    expect(defaults).toHaveLength(0);
  });
});

describe('giving up the overlay', () => {
  /**
   * Only an overlay this plugin asserted is ever taken back. Asserting the
   * default on a key we never touched would overwrite an icon the owner chose
   * in VSD Craft.
   */
  it('never asserts the default on a key it has not painted', async () => {
    const { controller, defaults, service } = harness();
    service.set(ROTTEN, { status: 'unavailable' });
    await controller.onWillAppear('key-1', settings(ROTTEN));
    expect(defaults).toHaveLength(0);
  });

  it('restores the default when auto icon is switched off', async () => {
    const { controller, defaults } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    const outcome = await controller.onDidReceiveSettings('key-1', settings(YOUTUBE, false));
    expect(outcome.status).toBe('disabled');
    expect(defaults).toEqual(['key-1']);
  });

  it('does no icon work at all while switched off', async () => {
    const { controller, service, images } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE, false));
    await controller.onDidReceiveSettings('key-1', settings(ROTTEN, false));
    expect(service.asked).toHaveLength(0);
    expect(images).toHaveLength(0);
  });

  it('restores the favicon when switched back on', async () => {
    const { controller, images, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onDidReceiveSettings('key-1', settings(YOUTUBE, false));
    const outcome = await controller.onDidReceiveSettings('key-1', settings(YOUTUBE, true));
    expect(outcome.dataUri).toBe(YT_ICON);
    expect(images[images.length - 1]).toEqual({ context: 'key-1', dataUri: YT_ICON });
    // Answered from the memo, so switching back on costs nothing.
    expect(service.asked).toHaveLength(1);
  });

  it('gives up the overlay when the template is cleared', async () => {
    const { controller, defaults } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onDidReceiveSettings('key-1', settings(''));
    expect(defaults).toEqual(['key-1']);
  });

  it('gives up the overlay when a new site has no icon', async () => {
    const { controller, defaults, service } = harness();
    service.set(ROTTEN, { status: 'unavailable', hostname: 'www.rottentomatoes.com' });
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onDidReceiveSettings('key-1', settings(ROTTEN));
    expect(defaults).toEqual(['key-1']);
  });
});

describe('generation ownership', () => {
  /**
   * The central race. Generation 7 is YouTube, the template changes to Rotten
   * Tomatoes as generation 8, then YouTube's response finally arrives. It must
   * be discarded, or the key shows the wrong site's icon.
   */
  it('discards an old template response that lands after a newer one', async () => {
    const { controller, images, service } = harness();
    service.hold();

    const first = controller.onWillAppear('key-1', settings(YOUTUBE));
    const second = controller.onDidReceiveSettings('key-1', settings(ROTTEN));

    // Rotten Tomatoes answers first, then the stale YouTube response arrives.
    service.release(1, { status: 'loaded', hostname: 'www.rottentomatoes.com', dataUri: RT_ICON });
    service.release(0, { status: 'loaded', hostname: 'www.youtube.com', dataUri: YT_ICON });

    expect(await second).toMatchObject({ dataUri: RT_ICON });
    expect(await first).toMatchObject({ status: 'superseded' });
    expect(images).toEqual([{ context: 'key-1', dataUri: RT_ICON }]);
  });

  it('discards a response that arrives after auto icon was switched off', async () => {
    const { controller, images, defaults, service } = harness();
    service.hold();

    const pending = controller.onWillAppear('key-1', settings(YOUTUBE));
    const off = controller.onDidReceiveSettings('key-1', settings(YOUTUBE, false));

    service.releaseAll({ status: 'loaded', dataUri: YT_ICON });

    expect(await off).toMatchObject({ status: 'disabled' });
    expect(await pending).toMatchObject({ status: 'superseded' });
    // Nothing was ever painted, so nothing had to be taken back.
    expect(images).toHaveLength(0);
    expect(defaults).toHaveLength(0);
  });

  it('discards a response for a key that has since disappeared', async () => {
    const { controller, images, service } = harness();
    service.hold();

    const pending = controller.onWillAppear('key-1', settings(YOUTUBE));
    controller.onWillDisappear('key-1');
    service.releaseAll({ status: 'loaded', dataUri: YT_ICON });

    expect(await pending).toMatchObject({ status: 'superseded' });
    expect(images).toHaveLength(0);
  });

  it('discards a response that arrives after the socket dropped', async () => {
    const { controller, images, service } = harness();
    service.hold();

    const pending = controller.onWillAppear('key-1', settings(YOUTUBE));
    controller.onDisconnect();
    service.releaseAll({ status: 'loaded', dataUri: YT_ICON });

    expect(await pending).toMatchObject({ status: 'superseded' });
    expect(images).toHaveLength(0);
  });

  it("keeps one key's in-flight work from landing on another", async () => {
    const { controller, images, service } = harness();
    service.hold();

    const one = controller.onWillAppear('key-1', settings(YOUTUBE));
    const two = controller.onWillAppear('key-2', settings(ROTTEN));

    service.release(1, { status: 'loaded', dataUri: RT_ICON });
    service.release(0, { status: 'loaded', dataUri: YT_ICON });

    await Promise.all([one, two]);
    expect(images).toEqual([
      { context: 'key-2', dataUri: RT_ICON },
      { context: 'key-1', dataUri: YT_ICON },
    ]);
  });

  it('survives the service answering with nothing', async () => {
    const { controller, images, defaults } = harness();
    const controllerWithNull = new IconController({
      request: async () => null,
      setImage: (context, dataUri) => images.push({ context, dataUri }),
      setDefaultImage: (context) => defaults.push(context),
    });
    const outcome = await controllerWithNull.onWillAppear('key-1', settings(YOUTUBE));
    expect(outcome.status).toBe('error');
    expect(images).toHaveLength(0);
    void controller;
  });

  /**
   * A failed request for an old template must be discarded like a successful
   * one. Otherwise a stale failure during a fast retype reports 'error', which
   * the panel renders as "Unavailable" over the newer query still in flight.
   */
  it('discards a FAILED response for a superseded template', async () => {
    const images: Array<{ context: string; dataUri: string }> = [];
    let failNext = true;
    let release: (() => void) | null = null;

    const controller = new IconController({
      request: async (_template) => {
        if (failNext) {
          failNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new Error('bridge down');
        }
        return { status: 'loaded', hostname: 'www.rottentomatoes.com', dataUri: RT_ICON };
      },
      setImage: (context, dataUri) => images.push({ context, dataUri }),
      setDefaultImage: () => undefined,
    });

    const stale = controller.onWillAppear('key-1', settings(YOUTUBE));
    const fresh = controller.onDidReceiveSettings('key-1', settings(ROTTEN));
    if (release) (release as () => void)();

    expect(await fresh).toMatchObject({ dataUri: RT_ICON });
    expect(await stale).toMatchObject({ status: 'superseded' });
    expect(images).toEqual([{ context: 'key-1', dataUri: RT_ICON }]);
  });

  it('survives the request throwing', async () => {
    const images: Array<{ context: string; dataUri: string }> = [];
    const controller = new IconController({
      request: async () => {
        throw new Error('bridge down');
      },
      setImage: (context, dataUri) => images.push({ context, dataUri }),
      setDefaultImage: () => undefined,
    });
    await expect(controller.onWillAppear('key-1', settings(YOUTUBE))).resolves.toEqual({
      status: 'error',
    });
    expect(images).toHaveLength(0);
  });
});

describe('refresh', () => {
  it('asks the service again, bypassing the memo', async () => {
    const { controller, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    expect(service.asked).toHaveLength(1);

    await controller.refresh('key-1', settings(YOUTUBE));
    expect(service.asked).toHaveLength(2);
    expect(service.asked[1]).toEqual({ template: YOUTUBE, refresh: true });
  });

  it('leaves other templates memoized', async () => {
    const { controller, service } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-2', settings(ROTTEN));
    await controller.refresh('key-1', settings(YOUTUBE));

    const before = service.asked.length;
    await controller.onWillAppear('key-2', settings(ROTTEN));
    expect(service.asked).toHaveLength(before);
  });
});

describe('bounded state', () => {
  it('forgets a key once it disappears', async () => {
    const { controller } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-2', settings(ROTTEN));
    expect(controller.trackedContexts()).toBe(2);

    controller.onWillDisappear('key-1');
    expect(controller.trackedContexts()).toBe(1);
    controller.onWillDisappear('key-2');
    expect(controller.trackedContexts()).toBe(0);
  });

  it('drops every key when the socket goes', async () => {
    const { controller } = harness();
    await controller.onWillAppear('key-1', settings(YOUTUBE));
    await controller.onWillAppear('key-2', settings(ROTTEN));
    controller.onDisconnect();
    expect(controller.trackedContexts()).toBe(0);
  });

  it('caps the memo however many templates it sees', async () => {
    const { controller } = harness();
    for (let i = 0; i < MAX_MEMO_ENTRIES * 3; i++) {
      await controller.onWillAppear('key-1', settings(`https://site${i}.example.com/{title}`));
    }
    expect(controller.memoSize()).toBeLessThanOrEqual(MAX_MEMO_ENTRIES);
  });

  it('tolerates a disappearance for a key it never saw', () => {
    const { controller } = harness();
    expect(() => controller.onWillDisappear('never-seen')).not.toThrow();
    expect(controller.trackedContexts()).toBe(0);
  });
});
