import {
  MediaCommandOutcome,
  PendingMediaCommand,
  VoiceCoordinator,
  VoiceSource,
} from './voiceCoordinator';
import { ContextChannelStore, SourceIdentity } from './contextChannels';

describe('VoiceCoordinator pause ownership', () => {
  let channels: ContextChannelStore;
  let coordinator: VoiceCoordinator;

  const chromeSource: VoiceSource = {
    browserInstanceId: 'chrome-work',
    browserFamily: 'chrome',
    displayName: 'Chrome',
    mode: 'WORK_BROWSER',
    connectionGeneration: 7,
  };
  const braveSource: SourceIdentity = {
    browserInstanceId: 'brave-media',
    browserFamily: 'brave',
    displayName: 'Brave',
    mode: 'MEDIA_BROWSER',
    connectionGeneration: 4,
  };

  beforeEach(() => {
    channels = new ContextChannelStore();
    coordinator = new VoiceCoordinator(channels);
  });

  function seedMedia(options: {
    source?: SourceIdentity;
    tabId?: number;
    windowId?: number;
    sequence?: number;
    url?: string;
    documentGeneration?: string;
    playbackState?: 'playing' | 'paused';
    title?: string;
  } = {}): void {
    const source = options.source ?? braveSource;
    const tabId = options.tabId ?? 5;
    const windowId = options.windowId ?? 1;
    const url = options.url ?? 'https://disneyplus.com/play/regular-show';
    const title = options.title ?? 'Regular Show';
    channels.observe({
      source,
      channel: 'media',
      payload: {
        url,
        hostname: new URL(url).hostname,
        rawTitle: `${title} | Disney+`,
        canonicalTitle: title,
        documentTitle: `${title} | Disney+`,
        ogTitle: '',
        twitterTitle: '',
        jsonLdTitle: '',
        jsonLdSeriesTitle: '',
        playbackState: options.playbackState ?? 'playing',
        documentGeneration: options.documentGeneration ?? 'doc-a',
        tabId,
        windowId,
        timestamp: Date.now(),
      },
      tabId,
      windowId,
      observationSequence: options.sequence ?? 1,
      observedAt: Date.now(),
    });
  }

  function startAndDeliver(sessionId = 'sess-1'): PendingMediaCommand {
    const result = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_STARTED',
      chromeSource,
      10,
      sessionId
    );
    expect(result.actionTaken).toBe('voice_started_pause_pending');
    const commands = coordinator.getPendingCommands('brave-media');
    expect(commands).toHaveLength(1);
    return commands[0];
  }

  function acknowledge(
    command: PendingMediaCommand,
    outcome: MediaCommandOutcome,
    initialPlayback: 'playing' | 'paused' | 'unknown',
    finalPlayback: 'playing' | 'paused' | 'unknown',
    documentGeneration = 'doc-a',
    mediaTargetId = 'media-1'
  ) {
    return coordinator.acknowledgeMediaCommand({
      commandId: command.commandId,
      browserInstanceId: command.browserInstanceId,
      connectionGeneration: command.connectionGeneration,
      tabId: command.tabId,
      action: command.action,
      outcome,
      initialPlayback,
      finalPlayback,
      documentGeneration,
      mediaTargetId,
    });
  }

  it('authorizes normal resume only after a confirmed playing-to-paused transition', () => {
    seedMedia();
    const pause = startAndDeliver();
    expect(coordinator.getActiveLease()?.didPause).toBe(false);
    expect(coordinator.getActiveLease()?.resumeAuthorized).toBe(false);

    expect(acknowledge(pause, 'CHANGED', 'playing', 'paused').actionTaken).toBe(
      'pause_ack_changed_resume_authorized'
    );
    expect(coordinator.getStatus().mediaAutoPause).toMatchObject({
      initialPlayback: 'playing',
      didPause: true,
      resumeAuthorized: true,
      overridden: false,
    });

    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('voice_ended_media_resume_queued');
    const resume = coordinator.getPendingCommands('brave-media');
    expect(resume).toHaveLength(1);
    expect(resume[0]).toMatchObject({
      action: 'RESUME',
      expectedDocumentGeneration: 'doc-a',
      expectedMediaTargetId: 'media-1',
      connectionGeneration: 4,
    });
  });

  it('suppresses PAUSE and never resumes media already paused at START', () => {
    seedMedia({ playbackState: 'paused' });
    const start = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_STARTED',
      chromeSource,
      10,
      'sess-prepaused'
    );
    expect(start.actionTaken).toBe('voice_started_media_already_paused');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
    expect(coordinator.getStatus().mediaAutoPause).toMatchObject({
      initialPlayback: 'paused',
      didPause: false,
      resumeAuthorized: false,
    });

    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-prepaused'
    );
    expect(end.actionTaken).toBe('pre_paused_or_unconfirmed_media_not_resumed');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });

  it.each(['ALREADY_IN_STATE', 'NOT_FOUND', 'FAILED', 'STALE_TARGET'] as MediaCommandOutcome[])(
    'does not acquire ownership from %s',
    (outcome) => {
      seedMedia({ playbackState: undefined });
      const pause = startAndDeliver();
      const initial = outcome === 'ALREADY_IN_STATE' ? 'paused' : 'unknown';
      acknowledge(pause, outcome, initial, initial);
      expect(coordinator.getActiveLease()).toMatchObject({
        didPause: false,
        resumeAuthorized: false,
      });
      coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1');
      expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
    }
  );

  it('invalidates ownership when the user resumes during Dictate, even before ACK arrives', () => {
    seedMedia();
    const pause = startAndDeliver();
    const lease = coordinator.getActiveLease()!;
    expect(
      coordinator.handleUserOverride('brave-media', 5, {
        connectionGeneration: 4,
        leaseId: lease.leaseId,
        pauseCommandId: pause.commandId,
        documentGeneration: 'doc-a',
        mediaTargetId: 'media-1',
      })
    ).toBe(true);
    acknowledge(pause, 'CHANGED', 'playing', 'paused');
    expect(coordinator.getActiveLease()).toMatchObject({
      didPause: true,
      resumeAuthorized: false,
      overridden: true,
    });
    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('user_override_prevented_resume');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });

  it('never resumes a different media owner', () => {
    seedMedia();
    const pause = startAndDeliver();
    acknowledge(pause, 'CHANGED', 'playing', 'paused');
    seedMedia({ tabId: 6, sequence: 2, url: 'https://hulu.com/watch/futurama', title: 'Futurama', documentGeneration: 'doc-b' });

    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('media_owner_or_generation_changed_no_resume');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });

  it('fails closed on same-tab navigation or document replacement', () => {
    seedMedia();
    const pause = startAndDeliver();
    acknowledge(pause, 'CHANGED', 'playing', 'paused');
    seedMedia({ sequence: 2, documentGeneration: 'doc-replaced' });
    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('media_owner_or_generation_changed_no_resume');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });

  it('fails closed after the media browser worker generation changes', () => {
    seedMedia();
    const pause = startAndDeliver();
    acknowledge(pause, 'CHANGED', 'playing', 'paused');
    seedMedia({ source: { ...braveSource, connectionGeneration: 5 }, sequence: 1 });
    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('media_owner_or_generation_changed_no_resume');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });

  it('ignores distinct duplicate START, wrong-producer END, and duplicate END', () => {
    seedMedia();
    const pause = startAndDeliver();
    expect(
      coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-2')
        .actionTaken
    ).toBe('overlapping_start_ignored');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
    expect(
      coordinator.handleVoiceLifecycle(
        'VOICE_INPUT_ENDED',
        { ...chromeSource, connectionGeneration: 8 },
        10,
        'sess-1'
      ).actionTaken
    ).toBe('stale_or_unknown_end_ignored');

    acknowledge(pause, 'CHANGED', 'playing', 'paused');
    expect(
      coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1')
        .actionTaken
    ).toBe('voice_ended_media_resume_queued');
    expect(
      coordinator.handleVoiceLifecycle('VOICE_INPUT_ENDED', chromeSource, 10, 'sess-1')
        .actionTaken
    ).toBe('stale_or_unknown_end_ignored');
  });

  it('waits for an in-flight PAUSE ACK after END and resumes only if it proves ownership', () => {
    seedMedia();
    const pause = startAndDeliver();
    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('voice_ended_waiting_for_pause_ack');
    expect(acknowledge(pause, 'CHANGED', 'playing', 'paused').actionTaken).toBe(
      'voice_ended_media_resume_queued'
    );
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(1);
  });

  it('cancels an undelivered PAUSE when END arrives first', () => {
    seedMedia();
    coordinator.handleVoiceLifecycle('VOICE_INPUT_STARTED', chromeSource, 10, 'sess-1');
    const end = coordinator.handleVoiceLifecycle(
      'VOICE_INPUT_ENDED',
      chromeSource,
      10,
      'sess-1'
    );
    expect(end.actionTaken).toBe('voice_ended_pause_cancelled');
    expect(coordinator.getPendingCommands('brave-media')).toHaveLength(0);
  });
});
