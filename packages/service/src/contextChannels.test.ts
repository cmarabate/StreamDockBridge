import {
  ContextChannelStore,
  SourceIdentity,
  Observation,
  ContextChannel,
  BrowserMode,
  channelsFor,
  mayPublish,
  isDedicatedTo,
  SOURCE_TTL_MS,
  ProjectContext,
} from './contextChannels';
import { ContextRecord } from './contextStore';

const BRAVE = 'brave-personal-0001';
const CHROME = 'chrome-personal-0002';

function source(
  browserInstanceId: string,
  mode: BrowserMode,
  connectionGeneration = 1
): SourceIdentity {
  return {
    browserInstanceId,
    browserFamily: browserInstanceId.startsWith('brave') ? 'brave' : 'chrome',
    displayName: browserInstanceId.startsWith('brave') ? 'Brave Personal' : 'Chrome Personal',
    mode,
    connectionGeneration,
  };
}

function record(title: string, url = `https://example.com/${title}`): ContextRecord {
  return {
    url,
    hostname: new URL(url).hostname,
    rawTitle: title,
    documentTitle: title,
    ogTitle: '',
    twitterTitle: '',
    jsonLdTitle: '',
    jsonLdSeriesTitle: '',
    canonicalTitle: title,
    tabId: 1,
    windowId: 1,
    timestamp: 1000,
  };
}

let sequence = 0;
function observation(
  identity: SourceIdentity,
  channel: ContextChannel,
  payload: ContextRecord | ProjectContext | null,
  overrides: Partial<Observation> = {}
): Observation {
  return {
    source: identity,
    channel,
    payload,
    tabId: 1,
    windowId: 1,
    observationSequence: ++sequence,
    observedAt: 1000 + sequence,
    ...overrides,
  };
}

beforeEach(() => {
  sequence = 0;
});

describe('what each mode may publish', () => {
  it('gives each mode exactly its channels', () => {
    expect(channelsFor('MEDIA_BROWSER')).toEqual(['media']);
    expect(channelsFor('WORK_BROWSER')).toEqual(['page', 'project']);
    expect(channelsFor('HYBRID')).toEqual(['media', 'page', 'project']);
    expect(channelsFor('DISABLED')).toEqual([]);
  });

  it('refuses a channel the mode does not cover', () => {
    expect(mayPublish('MEDIA_BROWSER', 'page')).toBe(false);
    expect(mayPublish('MEDIA_BROWSER', 'project')).toBe(false);
    expect(mayPublish('WORK_BROWSER', 'media')).toBe(false);
    expect(mayPublish('DISABLED', 'media')).toBe(false);
    expect(mayPublish('HYBRID', 'media')).toBe(true);
  });
});

describe('two browsers, two channels', () => {
  /** The whole point: Brave's media and Chrome's page must not collide. */
  it('lets Brave own media while Chrome owns page, simultaneously', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const chrome = source(CHROME, 'WORK_BROWSER');

    expect(store.observe(observation(brave, 'media', record('Brickleberry')))).toMatchObject({
      accepted: true,
    });
    expect(
      store.observe(observation(chrome, 'page', record('GitHub', 'https://github.com/x')))
    ).toMatchObject({ accepted: true });

    expect(store.getRecord('media')!.canonicalTitle).toBe('Brickleberry');
    expect(store.getRecord('page')!.canonicalTitle).toBe('GitHub');
    expect(store.get('media')!.browserInstanceId).toBe(BRAVE);
    expect(store.get('page')!.browserInstanceId).toBe(CHROME);
  });

  it('does not let Chrome traffic disturb the media channel', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const chrome = source(CHROME, 'WORK_BROWSER');

    store.observe(observation(brave, 'media', record('Brickleberry')));

    // Chrome browses all over the place.
    for (let i = 0; i < 10; i++) {
      store.observe(observation(chrome, 'page', record(`Page ${i}`)));
    }
    // And even tries to claim media, which its mode forbids.
    const refused = store.observe(observation(chrome, 'media', record('Shopping')));
    expect(refused).toEqual({ accepted: false, reason: 'mode_forbids_channel' });

    expect(store.getRecord('media')!.canonicalTitle).toBe('Brickleberry');
    expect(store.get('media')!.browserInstanceId).toBe(BRAVE);
  });

  it('does not let Brave traffic disturb the page or project channels', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const chrome = source(CHROME, 'WORK_BROWSER');

    store.observe(observation(chrome, 'page', record('Work')));
    store.observe(
      observation(chrome, 'project', {
        projectKey: 'streamdockbridge',
        projectName: 'StreamDockBridge',
        evidence: 'chatgpt-project',
      })
    );

    expect(store.observe(observation(brave, 'page', record('Movie')))).toEqual({
      accepted: false,
      reason: 'mode_forbids_channel',
    });
    expect(store.observe(observation(brave, 'project', null))).toEqual({
      accepted: false,
      reason: 'mode_forbids_channel',
    });

    expect(store.getRecord('page')!.canonicalTitle).toBe('Work');
    expect(store.getProject()!.projectName).toBe('StreamDockBridge');
  });

  it('keeps the two installations distinct in the source list', () => {
    const store = new ContextChannelStore();
    store.registerSource(source(BRAVE, 'MEDIA_BROWSER'));
    store.registerSource(source(CHROME, 'WORK_BROWSER'));

    const sources = store.listSources();
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.browserInstanceId).sort()).toEqual([BRAVE, CHROME].sort());
    expect(sources.find((s) => s.browserInstanceId === BRAVE)!.mode).toBe('MEDIA_BROWSER');
    expect(sources.find((s) => s.browserInstanceId === CHROME)!.mode).toBe('WORK_BROWSER');
  });
});

describe('stale observations', () => {
  it('refuses a replayed or reordered sequence from the same source', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');

    store.observe(observation(brave, 'media', record('First'), { observationSequence: 5 }));
    const late = store.observe(
      observation(brave, 'media', record('Stale'), { observationSequence: 4 })
    );

    expect(late).toEqual({ accepted: false, reason: 'stale_observation' });
    expect(store.getRecord('media')!.canonicalTitle).toBe('First');
  });

  /**
   * An MV3 service worker is killed aggressively and its in-memory sequence
   * restarts at zero. The generation is what stops a fresh low sequence being
   * mistaken for a replay — and what stops a message from the DEAD worker
   * landing after the new one has spoken.
   */
  it('accepts a restarted worker whose sequence resets, via the generation', () => {
    const store = new ContextChannelStore();
    store.observe(
      observation(source(BRAVE, 'MEDIA_BROWSER', 1), 'media', record('Before'), {
        observationSequence: 99,
      })
    );

    const afterRestart = store.observe(
      observation(source(BRAVE, 'MEDIA_BROWSER', 2), 'media', record('After'), {
        observationSequence: 1,
      })
    );

    expect(afterRestart).toMatchObject({ accepted: true });
    expect(store.getRecord('media')!.canonicalTitle).toBe('After');
  });

  it('refuses an observation from a superseded connection generation', () => {
    const store = new ContextChannelStore();
    store.observe(observation(source(BRAVE, 'MEDIA_BROWSER', 2), 'media', record('New')));

    const fromDeadWorker = store.observe(
      observation(source(BRAVE, 'MEDIA_BROWSER', 1), 'media', record('Ghost'), {
        observationSequence: 500,
      })
    );

    expect(fromDeadWorker).toEqual({ accepted: false, reason: 'stale_connection' });
    expect(store.getRecord('media')!.canonicalTitle).toBe('New');
  });
});

describe('releasing a channel', () => {
  it('lets the owner clear its own channel', () => {
    const store = new ContextChannelStore();
    const chrome = source(CHROME, 'WORK_BROWSER');
    store.observe(
      observation(chrome, 'project', {
        projectKey: 'ideaforge',
        projectName: 'IdeaForge',
        evidence: 'chatgpt-project',
      })
    );
    expect(store.getProject()).not.toBeNull();

    const cleared = store.observe(observation(chrome, 'project', null));
    expect(cleared).toMatchObject({ accepted: true, released: true });
    expect(store.getProject()).toBeNull();
  });

  it('does not let a non-owner clear a channel', () => {
    const store = new ContextChannelStore();
    const a = source('aaa', 'HYBRID');
    const b = source('bbb', 'HYBRID');
    store.observe(observation(a, 'media', record('Owned')));

    expect(store.observe(observation(b, 'media', null))).toEqual({
      accepted: false,
      reason: 'not_owner',
    });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Owned');
  });
});

describe('a source going away', () => {
  it('releases its channels on explicit disconnect', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const chrome = source(CHROME, 'WORK_BROWSER');
    store.observe(observation(brave, 'media', record('Brickleberry')));
    store.observe(observation(chrome, 'page', record('Work')));

    store.disconnect(BRAVE);

    expect(store.getRecord('media')).toBeNull();
    // The other browser is untouched.
    expect(store.getRecord('page')!.canonicalTitle).toBe('Work');
  });

  /** An exited browser must not own a channel forever. */
  it('expires a channel whose owner has gone silent', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const t0 = 1_000_000;
    store.observe(observation(brave, 'media', record('Brickleberry')), t0);

    expect(store.getRecord('media', t0 + SOURCE_TTL_MS - 1)).not.toBeNull();
    expect(store.getRecord('media', t0 + SOURCE_TTL_MS + 1)).toBeNull();
  });

  it('keeps a channel alive while its owner keeps checking in', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    let now = 1_000_000;
    store.observe(observation(brave, 'media', record('Brickleberry')), now);

    for (let i = 0; i < 5; i++) {
      now += SOURCE_TTL_MS - 1000;
      store.registerSource(brave, now);
      expect(store.getRecord('media', now)).not.toBeNull();
    }
  });
});

describe('connection generation handoff', () => {
  it('invalidates old channel claims when a higher worker generation registers', () => {
    const store = new ContextChannelStore();
    const generationN = source(BRAVE, 'MEDIA_BROWSER', 7);
    store.observe(observation(generationN, 'media', record('Regular Show')));
    expect(store.get('media')).toMatchObject({
      browserInstanceId: BRAVE,
      connectionGeneration: 7,
    });

    expect(store.registerSource(source(BRAVE, 'MEDIA_BROWSER', 8))).toBe(true);
    expect(store.get('media')).toBeNull();
    expect(store.listSources().find((entry) => entry.browserInstanceId === BRAVE))
      .toMatchObject({ connectionGeneration: 8, connected: true });
  });

  it('keeps ownership during a same-generation heartbeat', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER', 7);
    store.observe(observation(brave, 'media', record('Regular Show')));

    expect(store.registerSource(brave)).toBe(true);
    expect(store.get('media')).toMatchObject({
      browserInstanceId: BRAVE,
      connectionGeneration: 7,
    });
  });

  it('does not let an older generation reclaim a freshly published channel', () => {
    const store = new ContextChannelStore();
    const current = source(BRAVE, 'MEDIA_BROWSER', 8);
    store.observe(observation(current, 'media', record('Episode B')));

    const old = source(BRAVE, 'MEDIA_BROWSER', 7);
    expect(store.registerSource(old)).toBe(false);
    expect(store.observe(observation(old, 'media', record('Episode A')))).toEqual({
      accepted: false,
      reason: 'stale_connection',
    });
    expect(store.get('media')).toMatchObject({
      connectionGeneration: 8,
      payload: expect.objectContaining({ canonicalTitle: 'Episode B' }),
    });
  });

  it('recovers Brave media and Chrome work channels independently', () => {
    const store = new ContextChannelStore();
    const braveN = source(BRAVE, 'MEDIA_BROWSER', 3);
    const chromeN = source(CHROME, 'WORK_BROWSER', 11);
    store.observe(observation(braveN, 'media', record('Regular Show')));
    store.observe(observation(chromeN, 'page', record('ChatGPT')));
    store.observe(
      observation(chromeN, 'project', {
        projectKey: 'streamdockbridge',
        projectName: 'StreamDockBridge',
        evidence: 'test',
      })
    );

    const braveNext = source(BRAVE, 'MEDIA_BROWSER', 4);
    store.registerSource(braveNext);
    expect(store.get('media')).toBeNull();
    expect(store.get('page')).toMatchObject({ connectionGeneration: 11 });
    expect(store.get('project')).toMatchObject({ connectionGeneration: 11 });
    store.observe(observation(braveNext, 'media', record('Regular Show')));

    const chromeNext = source(CHROME, 'WORK_BROWSER', 12);
    store.registerSource(chromeNext);
    expect(store.get('media')).toMatchObject({ connectionGeneration: 4 });
    expect(store.get('page')).toBeNull();
    expect(store.get('project')).toBeNull();
    store.observe(observation(chromeNext, 'page', record('ChatGPT')));
    expect(store.get('page')).toMatchObject({ connectionGeneration: 12 });
  });
});

describe('mode changes', () => {
  /** Switching a browser to DISABLED must hand back what it owns. */
  it('drops channels a source is no longer entitled to publish', () => {
    const store = new ContextChannelStore();
    store.observe(observation(source(BRAVE, 'HYBRID'), 'media', record('Show')));
    store.observe(observation(source(BRAVE, 'HYBRID'), 'page', record('Page')));
    expect(store.getRecord('media')).not.toBeNull();
    expect(store.getRecord('page')).not.toBeNull();

    // The owner switches this installation to media only.
    store.registerSource(source(BRAVE, 'MEDIA_BROWSER'));

    expect(store.getRecord('media')).not.toBeNull();
    expect(store.getRecord('page')).toBeNull();
  });

  it('drops every channel when a source is disabled', () => {
    const store = new ContextChannelStore();
    store.observe(observation(source(BRAVE, 'HYBRID'), 'media', record('Show')));
    store.registerSource(source(BRAVE, 'DISABLED'));
    expect(store.getRecord('media')).toBeNull();
  });

  it('refuses observations from a disabled source', () => {
    const store = new ContextChannelStore();
    expect(store.observe(observation(source(BRAVE, 'DISABLED'), 'media', record('X')))).toEqual({
      accepted: false,
      reason: 'mode_forbids_channel',
    });
    expect(store.getRecord('media')).toBeNull();
  });
});

describe('a dedicated browser outranks a general one', () => {
  it('knows which modes are dedicated to which channel', () => {
    expect(isDedicatedTo('MEDIA_BROWSER', 'media')).toBe(true);
    expect(isDedicatedTo('MEDIA_BROWSER', 'page')).toBe(false);
    expect(isDedicatedTo('WORK_BROWSER', 'page')).toBe(true);
    expect(isDedicatedTo('WORK_BROWSER', 'project')).toBe(true);
    expect(isDedicatedTo('WORK_BROWSER', 'media')).toBe(false);
    // HYBRID publishes everything and is dedicated to nothing.
    expect(isDedicatedTo('HYBRID', 'media')).toBe(false);
    expect(isDedicatedTo('DISABLED', 'media')).toBe(false);
  });

  /**
   * The owner's real setup: Brave assigned to media, Chrome left on the
   * default HYBRID. Chrome opening a page with a video must not take the media
   * channel from the browser whose whole job is media, however recently that
   * tab was touched.
   */
  it('does not let a HYBRID browser take media from a MEDIA_BROWSER', () => {
    const store = new ContextChannelStore();
    const brave = source(BRAVE, 'MEDIA_BROWSER');
    const chrome = source(CHROME, 'HYBRID');

    store.observe(observation(brave, 'media', record('Regular Show'), { observedAt: 5000 }));

    // Chrome later opens something with a video — more recent, but general.
    const stolen = store.observe(
      observation(chrome, 'media', record('Sharper'), { observedAt: 9000 })
    );

    expect(stolen).toEqual({ accepted: false, reason: 'lost_arbitration' });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Regular Show');
    expect(store.get('media')!.browserInstanceId).toBe(BRAVE);
  });

  it('lets a dedicated browser take media from a general one', () => {
    const store = new ContextChannelStore();
    const chrome = source(CHROME, 'HYBRID');
    const brave = source(BRAVE, 'MEDIA_BROWSER');

    // Chrome got there first and more recently.
    store.observe(observation(chrome, 'media', record('Sharper'), { observedAt: 9000 }));
    const claimed = store.observe(
      observation(brave, 'media', record('Regular Show'), { observedAt: 5000 })
    );

    expect(claimed).toMatchObject({ accepted: true });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Regular Show');
  });

  it('applies the same rule to page and project', () => {
    const store = new ContextChannelStore();
    const chrome = source(CHROME, 'WORK_BROWSER');
    const other = source('zzz-hybrid', 'HYBRID');

    store.observe(observation(chrome, 'page', record('Work'), { observedAt: 5000 }));
    expect(
      store.observe(observation(other, 'page', record('Something else'), { observedAt: 9000 }))
    ).toEqual({ accepted: false, reason: 'lost_arbitration' });
    expect(store.getRecord('page')!.canonicalTitle).toBe('Work');
  });

  /** Two dedicated browsers still fall back to recency. */
  it('falls back to recency between two equally dedicated browsers', () => {
    const store = new ContextChannelStore();
    store.observe(
      observation(source('aaa', 'MEDIA_BROWSER'), 'media', record('Older'), { observedAt: 5000 })
    );
    expect(
      store.observe(
        observation(source('bbb', 'MEDIA_BROWSER'), 'media', record('Newer'), { observedAt: 6000 })
      )
    ).toMatchObject({ accepted: true });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Newer');
  });
});

describe('two sources competing for one channel', () => {
  /**
   * The intended setup never competes, but the outcome has to be predictable
   * rather than "whichever packet arrived last" if it ever does.
   */
  it('gives the channel to the more recent user activity', () => {
    const store = new ContextChannelStore();
    // Both dedicated: recency is the tie-break only between equals.
    const a = source('aaa', 'MEDIA_BROWSER');
    const b = source('bbb', 'MEDIA_BROWSER');

    store.observe(observation(a, 'media', record('Older'), { observedAt: 5000 }));
    expect(
      store.observe(observation(b, 'media', record('Newer'), { observedAt: 6000 }))
    ).toMatchObject({ accepted: true });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Newer');

    // And an older claim cannot take it back.
    expect(
      store.observe(observation(a, 'media', record('Stale'), { observedAt: 4000 }))
    ).toEqual({ accepted: false, reason: 'lost_arbitration' });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Newer');
  });

  it('breaks an exact tie deterministically rather than by arrival order', () => {
    const first = new ContextChannelStore();
    first.observe(
      observation(source('aaa', 'MEDIA_BROWSER'), 'media', record('A'), { observedAt: 5000 })
    );
    first.observe(
      observation(source('bbb', 'MEDIA_BROWSER'), 'media', record('B'), { observedAt: 5000 })
    );

    // Same two claims, opposite arrival order.
    const second = new ContextChannelStore();
    second.observe(
      observation(source('bbb', 'MEDIA_BROWSER'), 'media', record('B'), { observedAt: 5000 })
    );
    second.observe(
      observation(source('aaa', 'MEDIA_BROWSER'), 'media', record('A'), { observedAt: 5000 })
    );

    expect(first.get('media')!.browserInstanceId).toBe('bbb');
    expect(second.get('media')!.browserInstanceId).toBe('bbb');
  });

  /**
   * Two browsers on the default HYBRID: neither has been assigned the channel,
   * so whoever claimed it keeps it until they release it or go quiet. Recency
   * here would mean a second browser opening any page with a video seizes media
   * from the one actually playing — the original defect in another guise.
   */
  it('does not let one general browser take a live channel from another', () => {
    const store = new ContextChannelStore();
    store.observe(
      observation(source('aaa', 'HYBRID'), 'media', record('Playing'), { observedAt: 5000 })
    );

    const stolen = store.observe(
      observation(source('bbb', 'HYBRID'), 'media', record('Some video ad'), { observedAt: 9000 })
    );

    expect(stolen).toEqual({ accepted: false, reason: 'lost_arbitration' });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Playing');
  });

  /** But a general browser may still CLAIM a channel nobody holds. */
  it('lets a general browser claim a free channel', () => {
    const store = new ContextChannelStore();
    expect(
      store.observe(observation(source('aaa', 'HYBRID'), 'media', record('Only browser')))
    ).toMatchObject({ accepted: true });
    expect(store.getRecord('media')!.canonicalTitle).toBe('Only browser');
  });

  it('lets a live source take a channel from one that has gone silent', () => {
    const store = new ContextChannelStore();
    const t0 = 1_000_000;
    store.observe(observation(source('aaa', 'HYBRID'), 'media', record('Abandoned')), t0);

    const later = t0 + SOURCE_TTL_MS + 1;
    expect(
      store.observe(
        observation(source('bbb', 'HYBRID'), 'media', record('Live'), { observedAt: later }),
        later
      )
    ).toMatchObject({ accepted: true });
    expect(store.getRecord('media', later)!.canonicalTitle).toBe('Live');
  });
});

describe('project payloads', () => {
  it('carries project identity rather than a page record', () => {
    const store = new ContextChannelStore();
    const chrome = source(CHROME, 'WORK_BROWSER');
    store.observe(
      observation(chrome, 'project', {
        projectKey: 'streamdockbridge',
        projectName: 'StreamDockBridge',
        evidence: 'chatgpt-project',
        githubOwner: 'cmarabate',
        githubRepo: 'StreamDockBridge',
      })
    );

    const project = store.getProject()!;
    expect(project.projectKey).toBe('streamdockbridge');
    expect(project.githubOwner).toBe('cmarabate');
  });

  /** Switching project must replace, never merge. */
  it('replaces the project outright when the owner moves to another', () => {
    const store = new ContextChannelStore();
    const chrome = source(CHROME, 'WORK_BROWSER');
    store.observe(
      observation(chrome, 'project', {
        projectKey: 'streamdockbridge',
        projectName: 'StreamDockBridge',
        evidence: 'chatgpt-project',
        githubOwner: 'cmarabate',
        githubRepo: 'StreamDockBridge',
      })
    );
    store.observe(
      observation(chrome, 'project', {
        projectKey: 'ideaforge',
        projectName: 'IdeaForge',
        evidence: 'chatgpt-project',
      })
    );

    const project = store.getProject()!;
    expect(project.projectName).toBe('IdeaForge');
    // No field from the previous project survives.
    expect(project.githubOwner).toBeUndefined();
  });
});
