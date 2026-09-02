import * as fs from 'fs';
import * as path from 'path';
import {
  BrowserMode,
  ContextChannelStore,
  SourceIdentity,
  SOURCE_TTL_MS,
} from './contextChannels';
import { ContextRecord } from './contextStore';
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  buildContextSnapshotV1,
} from './contextBridge';

function source(id: string, mode: BrowserMode, connectionGeneration = 1): SourceIdentity {
  return {
    browserInstanceId: id,
    browserFamily: id.startsWith('brave') ? 'brave' : 'chrome',
    displayName: id,
    mode,
    connectionGeneration,
  };
}

function page(url: string, title = 'Some page'): ContextRecord {
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
    windowId: 2,
    timestamp: 1_000,
  };
}

function publish(
  store: ContextChannelStore,
  identity: SourceIdentity,
  channel: 'media' | 'page',
  record: ContextRecord,
  opts: { sequence: number; observedAt: number; tabId?: number; windowId?: number }
) {
  return store.observe(
    {
      source: identity,
      channel,
      payload: record,
      tabId: opts.tabId ?? record.tabId,
      windowId: opts.windowId ?? record.windowId,
      observationSequence: opts.sequence,
      observedAt: opts.observedAt,
    },
    opts.observedAt
  );
}

describe('ContextSnapshotV1 shape', () => {
  it('projects both channels against one read instant', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    const chrome = source('chrome-work', 'WORK_BROWSER');

    publish(store, brave, 'media', page('https://example.com/watch/1', 'Regular Show'), {
      sequence: 1,
      observedAt: 900,
      tabId: 10,
      windowId: 20,
    });
    publish(store, chrome, 'page', page('https://example.com/docs', 'Docs'), {
      sequence: 7,
      observedAt: 950,
      tabId: 30,
      windowId: 40,
    });

    const snapshot = buildContextSnapshotV1(store, 1_000);

    expect(snapshot.schemaVersion).toBe(CONTEXT_SNAPSHOT_SCHEMA_VERSION);
    expect(snapshot.readAt).toBe(1_000);
    expect(Object.keys(snapshot.channels).sort()).toEqual(['media', 'page']);

    expect(snapshot.channels.media).toEqual({
      source: {
        sourceInstanceId: 'brave-media',
        browserFamily: 'brave',
        displayName: 'brave-media',
        role: 'MEDIA_BROWSER',
        connectionGeneration: 1,
      },
      observation: {
        sequence: 1,
        observedAt: 900,
        ageMs: 100,
        ttlMs: SOURCE_TTL_MS,
        fresh: true,
      },
      page: {
        url: 'https://example.com/watch/1',
        hostname: 'example.com',
        rawTitle: 'Regular Show',
        documentTitle: 'Regular Show',
        tabId: 10,
        windowId: 20,
      },
      providerContext: null,
    });

    expect(snapshot.channels.page).toMatchObject({
      source: { sourceInstanceId: 'chrome-work', role: 'WORK_BROWSER' },
      observation: { sequence: 7, observedAt: 950, ageMs: 50 },
      page: { tabId: 30, windowId: 40 },
    });
  });

  it('uses one readAt for every channel even when they were observed apart', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, brave, 'media', page('https://example.com/a'), { sequence: 1, observedAt: 1_000 });
    publish(store, chrome, 'page', page('https://example.com/b'), { sequence: 1, observedAt: 4_000 });

    const snapshot = buildContextSnapshotV1(store, 5_000);
    const media = snapshot.channels.media!;
    const pageChannel = snapshot.channels.page!;

    expect(media.observation.ageMs).toBe(snapshot.readAt - media.observation.observedAt);
    expect(pageChannel.observation.ageMs).toBe(snapshot.readAt - pageChannel.observation.observedAt);
    expect(media.observation.ageMs).toBe(4_000);
    expect(pageChannel.observation.ageMs).toBe(1_000);
  });

  it('exposes no secret, cookie, history or page-body surface', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, chrome, 'page', page('https://example.com/docs'), {
      sequence: 1,
      observedAt: 1_000,
    });

    const encoded = JSON.stringify(buildContextSnapshotV1(store, 1_000));
    for (const forbidden of ['secret', 'cookie', 'credential', 'token', 'history', 'bodyText']) {
      expect(encoded.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('emits only the allowlisted page fields, never the whole record', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    const record = {
      ...page('https://example.com/docs'),
      documentGeneration: 'doc-gen-should-not-leak',
      canonicalTitle: 'canonical-should-not-leak',
      ogTitle: 'og-should-not-leak',
    };
    publish(store, chrome, 'page', record, { sequence: 1, observedAt: 1_000 });

    const snapshot = buildContextSnapshotV1(store, 1_000);
    expect(Object.keys(snapshot.channels.page!.page).sort()).toEqual([
      'documentTitle',
      'hostname',
      'rawTitle',
      'tabId',
      'url',
      'windowId',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('should-not-leak');
  });
});

describe('freshness, fencing and replay', () => {
  it('omits a channel whose owner aged past the TTL rather than calling it fresh', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    publish(store, brave, 'media', page('https://example.com/a'), {
      sequence: 1,
      observedAt: 1_000,
    });

    expect(buildContextSnapshotV1(store, 1_000 + SOURCE_TTL_MS).channels.media).not.toBeNull();
    expect(buildContextSnapshotV1(store, 1_000 + SOURCE_TTL_MS + 1).channels.media).toBeNull();
  });

  it('keeps a channel alive across a heartbeat that publishes nothing', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    publish(store, brave, 'media', page('https://example.com/a'), {
      sequence: 1,
      observedAt: 1_000,
    });

    const heartbeatAt = 1_000 + SOURCE_TTL_MS - 1;
    store.registerSource(brave, heartbeatAt);

    const snapshot = buildContextSnapshotV1(store, heartbeatAt + SOURCE_TTL_MS - 1);
    expect(snapshot.channels.media).not.toBeNull();
    // Liveness refreshed the owner; the OBSERVATION is still honestly old.
    expect(snapshot.channels.media!.observation.observedAt).toBe(1_000);
    expect(snapshot.channels.media!.observation.ageMs).toBeGreaterThan(SOURCE_TTL_MS);
  });

  it('does not let a replayed observation move the snapshot backwards', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, chrome, 'page', page('https://example.com/first'), {
      sequence: 1,
      observedAt: 1_000,
    });
    publish(store, chrome, 'page', page('https://example.com/second'), {
      sequence: 2,
      observedAt: 2_000,
    });

    const replay = publish(store, chrome, 'page', page('https://example.com/first'), {
      sequence: 1,
      observedAt: 1_000,
    });
    expect(replay).toEqual({ accepted: false, reason: 'stale_observation' });

    const snapshot = buildContextSnapshotV1(store, 2_000);
    expect(snapshot.channels.page!.page.url).toBe('https://example.com/second');
    expect(snapshot.channels.page!.observation.sequence).toBe(2);
  });

  it('fences an observation from a superseded connection generation', () => {
    const store = new ContextChannelStore();
    const first = source('chrome-work', 'WORK_BROWSER', 1);
    publish(store, first, 'page', page('https://example.com/old'), {
      sequence: 5,
      observedAt: 1_000,
    });
    expect(buildContextSnapshotV1(store, 1_000).channels.page).not.toBeNull();

    // The browser restarts: same instance, higher generation.
    const restarted = source('chrome-work', 'WORK_BROWSER', 2);
    store.registerSource(restarted, 1_100);

    const afterRestart = buildContextSnapshotV1(store, 1_100);
    expect(afterRestart.channels.page).toBeNull();

    const stale = publish(store, first, 'page', page('https://example.com/old'), {
      sequence: 99,
      observedAt: 1_200,
    });
    expect(stale).toEqual({ accepted: false, reason: 'stale_connection' });
    expect(buildContextSnapshotV1(store, 1_200).channels.page).toBeNull();
  });

  it('recovers once the restarted connection republishes', () => {
    const store = new ContextChannelStore();
    const first = source('chrome-work', 'WORK_BROWSER', 1);
    publish(store, first, 'page', page('https://example.com/old'), {
      sequence: 5,
      observedAt: 1_000,
    });
    const restarted = source('chrome-work', 'WORK_BROWSER', 2);
    store.registerSource(restarted, 1_100);
    publish(store, restarted, 'page', page('https://example.com/new'), {
      sequence: 1,
      observedAt: 1_200,
    });

    const snapshot = buildContextSnapshotV1(store, 1_200);
    expect(snapshot.channels.page!.page.url).toBe('https://example.com/new');
    expect(snapshot.channels.page!.source.connectionGeneration).toBe(2);
    expect(snapshot.channels.page!.observation.sequence).toBe(1);
  });
});

describe('sources, roles and ownership', () => {
  it('keeps two browsers isolated and attributes each channel to its own owner', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, brave, 'media', page('https://example.com/watch'), {
      sequence: 1,
      observedAt: 1_000,
    });
    publish(store, chrome, 'page', page('https://example.com/docs'), {
      sequence: 1,
      observedAt: 1_000,
    });

    const snapshot = buildContextSnapshotV1(store, 1_000);
    expect(snapshot.channels.media!.source.sourceInstanceId).toBe('brave-media');
    expect(snapshot.channels.media!.source.role).toBe('MEDIA_BROWSER');
    expect(snapshot.channels.page!.source.sourceInstanceId).toBe('chrome-work');
    expect(snapshot.channels.page!.source.role).toBe('WORK_BROWSER');
  });

  it('refuses a role that is not allowed to publish the channel', () => {
    const store = new ContextChannelStore();
    const media = source('brave-media', 'MEDIA_BROWSER');
    const refused = publish(store, media, 'page', page('https://example.com/docs'), {
      sequence: 1,
      observedAt: 1_000,
    });
    expect(refused).toEqual({ accepted: false, reason: 'mode_forbids_channel' });
    expect(buildContextSnapshotV1(store, 1_000).channels.page).toBeNull();
  });

  it('lets only the owner release a channel', () => {
    const store = new ContextChannelStore();
    const brave = source('brave-media', 'MEDIA_BROWSER');
    const otherBrave = source('brave-second', 'MEDIA_BROWSER');
    publish(store, brave, 'media', page('https://example.com/watch'), {
      sequence: 1,
      observedAt: 1_000,
    });

    const notOwner = store.observe(
      {
        source: otherBrave,
        channel: 'media',
        payload: null,
        tabId: 1,
        windowId: 1,
        observationSequence: 2,
        observedAt: 1_100,
      },
      1_100
    );
    expect(notOwner).toEqual({ accepted: false, reason: 'not_owner' });
    expect(buildContextSnapshotV1(store, 1_100).channels.media).not.toBeNull();

    const owner = store.observe(
      {
        source: brave,
        channel: 'media',
        payload: null,
        tabId: 1,
        windowId: 1,
        observationSequence: 2,
        observedAt: 1_100,
      },
      1_100
    );
    expect(owner).toEqual({ accepted: true, channel: 'media', released: true });
    expect(buildContextSnapshotV1(store, 1_100).channels.media).toBeNull();
  });

  it('drops everything a disconnecting browser owned', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, chrome, 'page', page('https://example.com/docs'), {
      sequence: 1,
      observedAt: 1_000,
    });
    store.disconnect('chrome-work');
    expect(buildContextSnapshotV1(store, 1_000).channels.page).toBeNull();
  });
});

describe('provider evidence inside the snapshot', () => {
  it('carries exact ChatGPT project evidence for a project page', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(
      store,
      chrome,
      'page',
      page(
        'https://chatgpt.com/g/g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-streamdockbridge/project',
        'StreamDockBridge — roadmap'
      ),
      { sequence: 1, observedAt: 1_000 }
    );

    const snapshot = buildContextSnapshotV1(store, 1_000);
    expect(snapshot.channels.page!.providerContext).toMatchObject({
      provider: 'chatgpt',
      scope: 'project',
      externalProjectId: 'g-p-68f0a1b2c3d4e5f60718293a4b5c6d7e-streamdockbridge',
    });
  });

  it('does not promote a project-shaped TITLE on an ordinary conversation', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(
      store,
      chrome,
      'page',
      page(
        'https://chatgpt.com/c/3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        'StreamDockBridge - Reconcile roadmap'
      ),
      { sequence: 1, observedAt: 1_000 }
    );

    const providerContext = buildContextSnapshotV1(store, 1_000).channels.page!.providerContext;
    expect(providerContext).toMatchObject({ provider: 'chatgpt', scope: 'conversation' });
    expect(JSON.stringify(providerContext)).not.toContain('externalProjectId');
  });

  it('reports null provider evidence for a page no provider rule covers', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(store, chrome, 'page', page('https://github.com/cmarabate/StreamDockBridge'), {
      sequence: 1,
      observedAt: 1_000,
    });
    expect(buildContextSnapshotV1(store, 1_000).channels.page!.providerContext).toBeNull();
  });
});

describe('identity and action authority', () => {
  it('has no project channel, registry key, or action surface', () => {
    const store = new ContextChannelStore();
    const chrome = source('chrome-work', 'WORK_BROWSER');
    publish(
      store,
      chrome,
      'page',
      page('https://chatgpt.com/g/g-p-abcd1234-streamdockbridge/project'),
      { sequence: 1, observedAt: 1_000 }
    );

    const snapshot = buildContextSnapshotV1(store, 1_000);
    expect((snapshot.channels as Record<string, unknown>).project).toBeUndefined();

    const encoded = JSON.stringify(snapshot);
    for (const forbidden of [
      'registryKey',
      'projectKey',
      'projectName',
      'localRepoPath',
      'githubRepo',
      'vercelProject',
      'supabaseProjectRef',
      'launch',
      'action',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  /**
   * The boundary claim that a runtime assertion cannot make: ContextBridge does
   * not depend on the AgentOS project registry. Checked against the source of
   * the two modules that make up the boundary, so a future import that quietly
   * reintroduced the dependency fails here rather than in review.
   */
  it('does not import the AgentOS project registry on any ContextBridge path', () => {
    const seen = new Set<string>();
    const queue = ['contextBridge'];

    while (queue.length) {
      const moduleName = queue.shift()!;
      if (seen.has(moduleName)) continue;
      seen.add(moduleName);

      const src = fs.readFileSync(path.join(__dirname, `${moduleName}.ts`), 'utf8');
      for (const match of src.matchAll(/(?:from|require\()\s*'\.\/([^']+)'/g)) {
        queue.push(match[1]);
      }
    }

    expect(seen).toContain('contextBridgeProviders');
    expect(seen).not.toContain('projectRegistry');
    expect(seen).not.toContain('localActions');
    expect(seen).not.toContain('launcher');
  });
});
