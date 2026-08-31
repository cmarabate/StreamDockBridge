import { ContextChannelStore } from './contextChannels';

export type VoiceLifecycleEvent = 'VOICE_INPUT_STARTED' | 'VOICE_INPUT_ENDED';

export interface VoiceSource {
  browserInstanceId: string;
  browserFamily: string;
  displayName: string;
  mode: string;
  connectionGeneration: number;
}

export interface VoiceSession {
  sessionId: string;
  source: VoiceSource;
  tabId: number;
  provider: string;
  startedAt: number;
  endedAt?: number;
  active: boolean;
}

export interface PauseLease {
  leaseId: string;
  voiceSessionId: string;
  voiceBrowserInstanceId: string;
  voiceTabId: number;

  mediaBrowserInstanceId: string;
  mediaTabId: number;
  mediaWindowId: number;
  mediaTitle: string;

  wasPlayingAtStart: boolean;
  didPause: boolean;
  overridden: boolean;

  createdAt: number;
  expiresAt: number;
}

export interface PendingMediaCommand {
  commandId: string;
  browserInstanceId: string;
  tabId: number;
  action: 'PAUSE' | 'RESUME';
  issuedAt: number;
  acknowledged: boolean;
}

export interface VoiceStatus {
  voice: {
    active: boolean;
    sessionId?: string;
    sourceBrowser?: string;
    tabId?: number;
    provider?: string;
    startedAt?: number;
  };
  mediaAutoPause: {
    leaseActive: boolean;
    targetBrowser?: string;
    targetTabId?: number;
    mediaTitle?: string;
    didPause: boolean;
    overridden: boolean;
    expiresAt?: number;
  };
}

export const LEASE_TTL_MS = 5 * 60 * 1000; // 5 minutes safety floor

export class VoiceCoordinator {
  private activeSession: VoiceSession | null = null;
  private activeLease: PauseLease | null = null;
  private pendingCommands = new Map<string, PendingMediaCommand[]>(); // browserInstanceId -> commands
  private commandCounter = 0;

  constructor(private readonly contextChannels: ContextChannelStore) {}

  public handleVoiceLifecycle(
    event: VoiceLifecycleEvent,
    source: VoiceSource,
    tabId: number,
    sessionId: string,
    provider = 'chatgpt'
  ): { success: boolean; actionTaken?: string } {
    const now = Date.now();

    if (event === 'VOICE_INPUT_STARTED') {
      // If same session is already active, ignore duplicate
      if (this.activeSession && this.activeSession.active && this.activeSession.sessionId === sessionId) {
        return { success: true, actionTaken: 'duplicate_start_ignored' };
      }

      // Check current media channel
      const mediaState = this.contextChannels.get('media');
      const mediaRecord = this.contextChannels.getRecord('media');

      this.activeSession = {
        sessionId,
        source,
        tabId,
        provider,
        startedAt: now,
        active: true,
      };

      if (!mediaState || !mediaRecord || !mediaState.browserInstanceId) {
        // No media context active; start voice session with no media lease
        this.activeLease = null;
        return { success: true, actionTaken: 'voice_started_no_media' };
      }

      // Media exists; queue a PAUSE command for the media browser
      const leaseId = `lease-${now}-${Math.random().toString(36).slice(2, 8)}`;
      this.activeLease = {
        leaseId,
        voiceSessionId: sessionId,
        voiceBrowserInstanceId: source.browserInstanceId,
        voiceTabId: tabId,

        mediaBrowserInstanceId: mediaState.browserInstanceId,
        mediaTabId: mediaState.tabId,
        mediaWindowId: mediaState.windowId,
        mediaTitle: mediaRecord.canonicalTitle || mediaRecord.rawTitle,

        wasPlayingAtStart: true,
        didPause: true,
        overridden: false,

        createdAt: now,
        expiresAt: now + LEASE_TTL_MS,
      };

      this.enqueueMediaCommand(mediaState.browserInstanceId, mediaState.tabId, 'PAUSE');
      return { success: true, actionTaken: 'voice_started_media_paused' };
    }

    if (event === 'VOICE_INPUT_ENDED') {
      // If no active session or sessionId does not match active session, ignore
      if (!this.activeSession || this.activeSession.sessionId !== sessionId) {
        return { success: true, actionTaken: 'stale_or_unknown_end_ignored' };
      }

      this.activeSession.active = false;
      this.activeSession.endedAt = now;

      // Inspect lease
      const lease = this.activeLease;
      this.activeSession = null;

      if (!lease) {
        return { success: true, actionTaken: 'voice_ended_no_lease' };
      }

      this.activeLease = null;

      // Resume only if we paused it, it has not expired, was not overridden, and media continuity holds
      if (now > lease.expiresAt) {
        return { success: true, actionTaken: 'lease_expired_no_resume' };
      }

      if (lease.overridden) {
        return { success: true, actionTaken: 'user_override_prevented_resume' };
      }

      if (!lease.didPause) {
        return { success: true, actionTaken: 'pre_paused_media_not_resumed' };
      }

      // Verify current media channel owner matches lease
      const currentMedia = this.contextChannels.get('media');

      if (
        !currentMedia ||
        currentMedia.browserInstanceId !== lease.mediaBrowserInstanceId ||
        currentMedia.tabId !== lease.mediaTabId
      ) {
        return { success: true, actionTaken: 'media_owner_changed_no_resume' };
      }

      // Resume playback
      this.enqueueMediaCommand(lease.mediaBrowserInstanceId, lease.mediaTabId, 'RESUME');
      return { success: true, actionTaken: 'voice_ended_media_resumed' };
    }

    return { success: false, actionTaken: 'unknown_event' };
  }

  public handleUserOverride(browserInstanceId: string, tabId: number): void {
    if (
      this.activeLease &&
      this.activeLease.mediaBrowserInstanceId === browserInstanceId &&
      this.activeLease.mediaTabId === tabId
    ) {
      this.activeLease.overridden = true;
    }
  }

  private waiters = new Map<string, Array<(cmds: PendingMediaCommand[]) => void>>();

  public enqueueMediaCommand(
    browserInstanceId: string,
    tabId: number,
    action: 'PAUSE' | 'RESUME'
  ): PendingMediaCommand {
    const cmd: PendingMediaCommand = {
      commandId: `cmd-${Date.now()}-${++this.commandCounter}`,
      browserInstanceId,
      tabId,
      action,
      issuedAt: Date.now(),
      acknowledged: false,
    };

    const queue = this.pendingCommands.get(browserInstanceId) || [];
    queue.push(cmd);
    this.pendingCommands.set(browserInstanceId, queue);

    // If a long-poll request is waiting for this browser instance, fulfill it immediately
    const pendingWaiters = this.waiters.get(browserInstanceId);
    if (pendingWaiters && pendingWaiters.length > 0) {
      this.waiters.delete(browserInstanceId);
      const cmds = this.getPendingCommands(browserInstanceId);
      for (const waiter of pendingWaiters) {
        try {
          waiter(cmds);
        } catch (e) {
          void e;
        }
      }
    }

    return cmd;
  }

  public async waitForCommands(browserInstanceId: string, timeoutMs = 20000): Promise<PendingMediaCommand[]> {
    const existing = this.getPendingCommands(browserInstanceId);
    if (existing.length > 0) {
      return existing;
    }

    return new Promise<PendingMediaCommand[]>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          const list = this.waiters.get(browserInstanceId) || [];
          this.waiters.set(
            browserInstanceId,
            list.filter((w) => w !== onCommand)
          );
          resolve([]);
        }
      }, timeoutMs);

      const onCommand = (cmds: PendingMediaCommand[]) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(cmds);
        }
      };

      const list = this.waiters.get(browserInstanceId) || [];
      list.push(onCommand);
      this.waiters.set(browserInstanceId, list);
    });
  }

  public getPendingCommands(browserInstanceId: string): PendingMediaCommand[] {
    const queue = this.pendingCommands.get(browserInstanceId) || [];
    // Clean queue
    this.pendingCommands.delete(browserInstanceId);
    return queue;
  }

  public getActiveLease(): PauseLease | null {
    return this.activeLease;
  }

  public getActiveSession(): VoiceSession | null {
    return this.activeSession;
  }

  public getStatus(): VoiceStatus {
    const now = Date.now();
    const sessionActive = !!(this.activeSession && this.activeSession.active);
    const leaseActive = !!(this.activeLease && now <= this.activeLease.expiresAt);

    return {
      voice: {
        active: sessionActive,
        sessionId: this.activeSession?.sessionId,
        sourceBrowser: this.activeSession?.source.displayName,
        tabId: this.activeSession?.tabId,
        provider: this.activeSession?.provider,
        startedAt: this.activeSession?.startedAt,
      },
      mediaAutoPause: {
        leaseActive,
        targetBrowser: this.activeLease?.mediaBrowserInstanceId,
        targetTabId: this.activeLease?.mediaTabId,
        mediaTitle: this.activeLease?.mediaTitle,
        didPause: this.activeLease?.didPause ?? false,
        overridden: this.activeLease?.overridden ?? false,
        expiresAt: this.activeLease?.expiresAt,
      },
    };
  }

  public clear(): void {
    this.activeSession = null;
    this.activeLease = null;
    this.pendingCommands.clear();
  }
}
