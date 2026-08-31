import { VoiceCoordinator, VoiceSource } from './voiceCoordinator';
import { ContextChannelStore, SourceIdentity } from './contextChannels';

describe('VoiceCoordinator & Pause Lease State Machine', () => {
  let channelStore: ContextChannelStore;
  let coordinator: VoiceCoordinator;

  const chromeSource: VoiceSource = {
    browserInstanceId: 'chrome-work',
    browserFamily: 'chrome',
    displayName: 'Chrome',
    mode: 'WORK_BROWSER',
    connectionGeneration: 1,
  };

  const braveSource: SourceIdentity = {
    browserInstanceId: 'brave-media',
    browserFamily: 'brave',
    displayName: 'Brave',
    mode: 'MEDIA_BROWSER',
    connectionGeneration: 1,
  };

  beforeEach(() => {
    channelStore = new ContextChannelStore();
    coordinator = new VoiceCoordinator(channelStore);
  });

  it('handles voice start with no active media', () => {
    const res = coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    expect(res.success).toBe(true);
    expect(res.actionTaken).toBe('voice_started_no_media');
    expect(coordinator.getActiveLease()).toBeNull();
    expect(coordinator.getStatus().voice.active).toBe(true);
  });

  it('pauses active playing media on voice start and resumes on voice end', () => {
    // Populate active media
    channelStore.observe({
      source: braveSource,
      channel: 'media',
      payload: {
        url: 'https://disneyplus.com/play/regular-show',
        hostname: 'disneyplus.com',
        rawTitle: 'Regular Show | Disney+',
        canonicalTitle: 'Regular Show',
        tabId: 5,
        windowId: 1,
        documentTitle: 'Regular Show | Disney+',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        timestamp: Date.now(),
      },
      tabId: 5,
      windowId: 1,
      observationSequence: 1,
      observedAt: Date.now(),
    });

    const startRes = coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    expect(startRes.success).toBe(true);
    expect(startRes.actionTaken).toBe('voice_started_media_paused');

    const lease = coordinator.getActiveLease();
    expect(lease).toBeDefined();
    expect(lease?.mediaBrowserInstanceId).toBe('brave-media');
    expect(lease?.mediaTabId).toBe(5);
    expect(lease?.mediaTitle).toBe('Regular Show');
    expect(lease?.didPause).toBe(true);
    expect(lease?.overridden).toBe(false);

    // Verify pending command for brave
    const cmds = coordinator.getPendingCommands('brave-media');
    expect(cmds).toHaveLength(1);
    expect(cmds[0].action).toBe('PAUSE');
    expect(cmds[0].tabId).toBe(5);

    // End voice session
    const endRes = coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1');
    expect(endRes.success).toBe(true);
    expect(endRes.actionTaken).toBe('voice_ended_media_resumed');

    const resumeCmds = coordinator.getPendingCommands('brave-media');
    expect(resumeCmds).toHaveLength(1);
    expect(resumeCmds[0].action).toBe('RESUME');
    expect(resumeCmds[0].tabId).toBe(5);

    expect(coordinator.getActiveLease()).toBeNull();
  });

  it('does not resume if user manually overrode playback during voice session', () => {
    channelStore.observe({
      source: braveSource,
      channel: 'media',
      payload: {
        url: 'https://disneyplus.com/play/regular-show',
        hostname: 'disneyplus.com',
        rawTitle: 'Regular Show | Disney+',
        canonicalTitle: 'Regular Show',
        tabId: 5,
        windowId: 1,
        documentTitle: 'Regular Show | Disney+',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        timestamp: Date.now(),
      },
      tabId: 5,
      windowId: 1,
      observationSequence: 1,
      observedAt: Date.now(),
    });

    coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    expect(coordinator.getActiveLease()?.didPause).toBe(true);
    coordinator.getPendingCommands('brave-media'); // drain initial pause command

    // User manual override occurs
    coordinator.handleUserOverride('brave-media', 5);
    expect(coordinator.getActiveLease()?.overridden).toBe(true);

    // End voice session
    const endRes = coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1');
    expect(endRes.success).toBe(true);
    expect(endRes.actionTaken).toBe('user_override_prevented_resume');

    // No resume command queued
    const resumeCmds = coordinator.getPendingCommands('brave-media');
    expect(resumeCmds).toHaveLength(0);
  });

  it('does not resume if media owner changed to a different tab or browser', () => {
    channelStore.observe({
      source: braveSource,
      channel: 'media',
      payload: {
        url: 'https://disneyplus.com/play/regular-show',
        hostname: 'disneyplus.com',
        rawTitle: 'Regular Show | Disney+',
        canonicalTitle: 'Regular Show',
        tabId: 5,
        windowId: 1,
        documentTitle: 'Regular Show | Disney+',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        timestamp: Date.now(),
      },
      tabId: 5,
      windowId: 1,
      observationSequence: 1,
      observedAt: Date.now(),
    });

    coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    coordinator.getPendingCommands('brave-media'); // drain initial pause command

    // Media changes to Futurama in tab 6
    channelStore.observe({
      source: braveSource,
      channel: 'media',
      payload: {
        url: 'https://hulu.com/watch/futurama',
        hostname: 'hulu.com',
        rawTitle: 'Futurama | Hulu',
        canonicalTitle: 'Futurama',
        tabId: 6,
        windowId: 1,
        documentTitle: 'Futurama | Hulu',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        timestamp: Date.now() + 100,
      },
      tabId: 6,
      windowId: 1,
      observationSequence: 2,
      observedAt: Date.now() + 100,
    });

    const endRes = coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1');
    expect(endRes.success).toBe(true);
    expect(endRes.actionTaken).toBe('media_owner_changed_no_resume');

    const resumeCmds = coordinator.getPendingCommands('brave-media');
    expect(resumeCmds).toHaveLength(0);
  });

  it('ignores duplicate START and stale END events idempotently', () => {
    channelStore.observe({
      source: braveSource,
      channel: 'media',
      payload: {
        url: 'https://disneyplus.com/play/regular-show',
        hostname: 'disneyplus.com',
        rawTitle: 'Regular Show | Disney+',
        canonicalTitle: 'Regular Show',
        tabId: 5,
        windowId: 1,
        documentTitle: 'Regular Show | Disney+',
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        timestamp: Date.now(),
      },
      tabId: 5,
      windowId: 1,
      observationSequence: 1,
      observedAt: Date.now(),
    });

    // Start session 1
    coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    coordinator.getPendingCommands('brave-media'); // drain

    // Duplicate start
    const dupRes = coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    expect(dupRes.actionTaken).toBe('duplicate_start_ignored');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);

    // Stale end from unknown session
    const staleEnd = coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-old');
    expect(staleEnd.actionTaken).toBe('stale_or_unknown_end_ignored');

    // Honest end
    const realEnd = coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1');
    expect(realEnd.actionTaken).toBe('voice_ended_media_resumed');
  });
});
