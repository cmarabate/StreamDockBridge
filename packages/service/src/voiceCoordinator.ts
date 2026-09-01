import { ContextChannelStore } from './contextChannels';
import { ContextRecord } from './contextStore';

export type VoiceLifecycleEvent = 'VOICE_INPUT_STARTED' | 'VOICE_INPUT_ENDED';
export type PlaybackState = 'playing' | 'paused' | 'unknown';
export type MediaCommandAction = 'PAUSE' | 'RESUME';
export type MediaCommandOutcome =
  | 'CHANGED'
  | 'ALREADY_IN_STATE'
  | 'NOT_FOUND'
  | 'FAILED'
  | 'STALE_TARGET';

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
  voiceConnectionGeneration: number;
  voiceTabId: number;
  mediaBrowserInstanceId: string;
  mediaConnectionGeneration: number;
  mediaObservationSequence: number;
  mediaTabId: number;
  mediaWindowId: number;
  mediaUrl: string;
  mediaTitle: string;
  mediaDocumentGeneration?: string;
  mediaTargetId?: string;
  initialPlayback: PlaybackState;
  didPause: boolean;
  resumeAuthorized: boolean;
  overridden: boolean;
  pauseCommandId?: string;
  resumeCommandId?: string;
  endRequested: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface PendingMediaCommand {
  commandId: string;
  leaseId: string;
  voiceSessionId: string;
  browserInstanceId: string;
  connectionGeneration: number;
  tabId: number;
  windowId: number;
  mediaUrl: string;
  action: MediaCommandAction;
  expectedDocumentGeneration?: string;
  expectedMediaTargetId?: string;
  issuedAt: number;
  expiresAt: number;
  acknowledged: boolean;
  deliveredAt?: number;
  cancelled?: boolean;
}

export interface MediaCommandAcknowledgement {
  commandId: string;
  browserInstanceId: string;
  connectionGeneration: number;
  tabId: number;
  action: MediaCommandAction;
  outcome: MediaCommandOutcome;
  initialPlayback: PlaybackState;
  finalPlayback: PlaybackState;
  documentGeneration?: string;
  mediaTargetId?: string;
}

export interface MediaOverrideEvidence {
  connectionGeneration: number;
  leaseId: string;
  pauseCommandId: string;
  documentGeneration: string;
  mediaTargetId: string;
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
    initialPlayback: PlaybackState;
    didPause: boolean;
    resumeAuthorized: boolean;
    overridden: boolean;
    expiresAt?: number;
  };
}

export const LEASE_TTL_MS = 5 * 60 * 1000;
export const MEDIA_COMMAND_TTL_MS = 10_000;

export class VoiceCoordinator {
  private activeSessions = new Map<string, VoiceSession>();
  private activeLease: PauseLease | null = null;
  private pendingCommands = new Map<string, PendingMediaCommand[]>();
  private commandsById = new Map<string, PendingMediaCommand>();
  private commandCounter = 0;
  private waiters = new Map<string, Array<(cmds: PendingMediaCommand[]) => void>>();

  constructor(private readonly contextChannels: ContextChannelStore) {}

  public handleVoiceLifecycle(
    event: VoiceLifecycleEvent,
    source: VoiceSource,
    tabId: number,
    sessionId: string,
    provider = 'chatgpt'
  ): { success: boolean; actionTaken?: string } {
    const now = Date.now();
    this.expireLease(now);

    if (event === 'VOICE_INPUT_STARTED') {
      const producerKey = this.voiceProducerKey(source, tabId, sessionId);
      if (this.activeSessions.has(producerKey)) {
        return { success: true, actionTaken: 'duplicate_start_ignored' };
      }

      const hadActiveVoice = this.activeSessions.size > 0;
      this.activeSessions.set(producerKey, {
        sessionId,
        source,
        tabId,
        provider,
        startedAt: now,
        active: true,
      });

      // One pause lease spans the complete interval during which at least one
      // producer is active. A second producer joins that interval rather than
      // replacing the lease that owns the causal PAUSE.
      if (hadActiveVoice) {
        return { success: true, actionTaken: 'overlapping_start_joined' };
      }

      // A new voice interval can begin while the prior RESUME is still queued
      // or delivered. Revoke that command and retain the exact pause ownership.
      if (this.activeLease) {
        this.activeLease.endRequested = false;
        if (this.activeLease.resumeCommandId) {
          const resume = this.commandsById.get(this.activeLease.resumeCommandId);
          if (resume && !resume.acknowledged) {
            this.cancelCommand(resume);
            if (!resume.deliveredAt) this.activeLease.resumeCommandId = undefined;
          } else {
            this.activeLease.resumeCommandId = undefined;
          }
        }
        return { success: true, actionTaken: 'voice_started_existing_pause_retained' };
      }

      const mediaState = this.contextChannels.get('media');
      const mediaRecord = this.contextChannels.getRecord('media') as ContextRecord | null;

      if (!mediaState || !mediaRecord || !mediaState.browserInstanceId) {
        this.activeLease = null;
        return { success: true, actionTaken: 'voice_started_no_media' };
      }

      const initialPlayback = mediaRecord.playbackState ?? 'unknown';
      const lease: PauseLease = {
        leaseId: `lease-${now}-${Math.random().toString(36).slice(2, 8)}`,
        voiceSessionId: sessionId,
        voiceBrowserInstanceId: source.browserInstanceId,
        voiceConnectionGeneration: source.connectionGeneration,
        voiceTabId: tabId,
        mediaBrowserInstanceId: mediaState.browserInstanceId,
        mediaConnectionGeneration: mediaState.connectionGeneration,
        mediaObservationSequence: mediaState.observationSequence,
        mediaTabId: mediaState.tabId,
        mediaWindowId: mediaState.windowId,
        mediaUrl: mediaRecord.url,
        mediaTitle: mediaRecord.canonicalTitle || mediaRecord.rawTitle,
        mediaDocumentGeneration: mediaRecord.documentGeneration,
        initialPlayback,
        didPause: false,
        resumeAuthorized: false,
        overridden: false,
        endRequested: false,
        createdAt: now,
        expiresAt: now + LEASE_TTL_MS,
      };
      this.activeLease = lease;

      // A fresh paused observation suppresses mutation but never grants ownership.
      // Unknown/playing observations use a conditional PAUSE; only its exact
      // CHANGED acknowledgement can promote this lease.
      if (initialPlayback === 'paused') {
        return { success: true, actionTaken: 'voice_started_media_already_paused' };
      }

      const command = this.enqueueMediaCommand(lease, 'PAUSE');
      lease.pauseCommandId = command.commandId;
      return { success: true, actionTaken: 'voice_started_pause_pending' };
    }

    if (event === 'VOICE_INPUT_ENDED') {
      const producerKey = this.voiceProducerKey(source, tabId, sessionId);
      const session = this.activeSessions.get(producerKey);
      if (!session) {
        return { success: true, actionTaken: 'stale_or_unknown_end_ignored' };
      }

      session.active = false;
      session.endedAt = now;
      this.activeSessions.delete(producerKey);

      if (this.activeSessions.size > 0) {
        return { success: true, actionTaken: 'voice_ended_other_producers_active' };
      }

      const lease = this.activeLease;
      if (!lease) {
        return { success: true, actionTaken: 'voice_ended_no_lease' };
      }

      lease.endRequested = true;
      if (now > lease.expiresAt) {
        this.activeLease = null;
        return { success: true, actionTaken: 'lease_expired_no_resume' };
      }

      if (lease.pauseCommandId) {
        const pauseCommand = this.commandsById.get(lease.pauseCommandId);
        if (pauseCommand && !pauseCommand.acknowledged) {
          if (!pauseCommand.deliveredAt) {
            this.cancelCommand(pauseCommand);
            this.activeLease = null;
            return { success: true, actionTaken: 'voice_ended_pause_cancelled' };
          }
          return { success: true, actionTaken: 'voice_ended_waiting_for_pause_ack' };
        }
      }

      return this.finishEndedLease(lease, now);
    }

    return { success: false, actionTaken: 'unknown_event' };
  }

  public acknowledgeMediaCommand(
    acknowledgement: MediaCommandAcknowledgement
  ): { success: boolean; actionTaken: string } {
    const command = this.commandsById.get(acknowledgement.commandId);
    if (!command || command.acknowledged) {
      return { success: true, actionTaken: 'unknown_or_duplicate_ack_ignored' };
    }

    if (
      command.browserInstanceId !== acknowledgement.browserInstanceId ||
      command.connectionGeneration !== acknowledgement.connectionGeneration ||
      command.tabId !== acknowledgement.tabId ||
      command.action !== acknowledgement.action
    ) {
      return { success: true, actionTaken: 'mismatched_ack_ignored' };
    }

    command.acknowledged = true;
    this.commandsById.delete(command.commandId);

    if (command.action === 'RESUME') {
      const lease = this.activeLease;
      if (!lease || lease.leaseId !== command.leaseId || lease.resumeCommandId !== command.commandId) {
        return { success: true, actionTaken: 'stale_resume_ack_ignored' };
      }

      lease.resumeCommandId = undefined;
      if (this.activeSessions.size === 0) {
        this.activeLease = null;
        return { success: true, actionTaken: `resume_ack_${acknowledgement.outcome.toLowerCase()}` };
      }

      // A START revoked this RESUME after it was delivered. If it nevertheless
      // changed playback, immediately reacquire the exact target with a new
      // conditional PAUSE. A validation call in the browser prevents this path
      // in the normal case; this is the fail-closed race fallback.
      if (
        acknowledgement.finalPlayback === 'playing' &&
        (acknowledgement.outcome === 'CHANGED' || acknowledgement.outcome === 'ALREADY_IN_STATE')
      ) {
        lease.didPause = false;
        lease.resumeAuthorized = false;
        lease.initialPlayback = 'playing';
        const pause = this.enqueueMediaCommand(lease, 'PAUSE');
        lease.pauseCommandId = pause.commandId;
        return { success: true, actionTaken: 'revoked_resume_repause_pending' };
      }

      return { success: true, actionTaken: 'revoked_resume_did_not_change_playback' };
    }

    const lease = this.activeLease;
    if (!lease || lease.leaseId !== command.leaseId || lease.pauseCommandId !== command.commandId) {
      return { success: true, actionTaken: 'stale_pause_ack_ignored' };
    }

    const exactChangedTransition =
      acknowledgement.outcome === 'CHANGED' &&
      acknowledgement.initialPlayback === 'playing' &&
      acknowledgement.finalPlayback === 'paused' &&
      !!acknowledgement.documentGeneration &&
      !!acknowledgement.mediaTargetId &&
      (!command.expectedDocumentGeneration ||
        command.expectedDocumentGeneration === acknowledgement.documentGeneration) &&
      (!command.expectedMediaTargetId ||
        command.expectedMediaTargetId === acknowledgement.mediaTargetId) &&
      (!lease.mediaDocumentGeneration ||
        lease.mediaDocumentGeneration === acknowledgement.documentGeneration);

    if (exactChangedTransition) {
      lease.initialPlayback = 'playing';
      lease.didPause = true;
      lease.mediaDocumentGeneration = acknowledgement.documentGeneration;
      lease.mediaTargetId = acknowledgement.mediaTargetId;
      lease.resumeAuthorized = !lease.overridden;
    } else {
      if (acknowledgement.outcome === 'ALREADY_IN_STATE') {
        lease.initialPlayback = 'paused';
      }
      lease.didPause = false;
      lease.resumeAuthorized = false;
    }

    if (lease.endRequested && this.activeSessions.size === 0) {
      return this.finishEndedLease(lease, Date.now());
    }

    return {
      success: true,
      actionTaken: exactChangedTransition
        ? 'pause_ack_changed_resume_authorized'
        : `pause_ack_${acknowledgement.outcome.toLowerCase()}_no_ownership`,
    };
  }

  public handleUserOverride(
    browserInstanceId: string,
    tabId: number,
    evidence?: MediaOverrideEvidence
  ): boolean {
    const lease = this.activeLease;
    if (
      !lease ||
      !evidence ||
      lease.mediaBrowserInstanceId !== browserInstanceId ||
      lease.mediaTabId !== tabId ||
      lease.mediaConnectionGeneration !== evidence.connectionGeneration ||
      lease.leaseId !== evidence.leaseId ||
      lease.pauseCommandId !== evidence.pauseCommandId ||
      lease.mediaDocumentGeneration !== evidence.documentGeneration ||
      (lease.mediaTargetId && lease.mediaTargetId !== evidence.mediaTargetId)
    ) {
      return false;
    }

    lease.overridden = true;
    lease.resumeAuthorized = false;
    return true;
  }

  public enqueueMediaCommand(lease: PauseLease, action: MediaCommandAction): PendingMediaCommand {
    const now = Date.now();
    const command: PendingMediaCommand = {
      commandId: `cmd-${now}-${++this.commandCounter}`,
      leaseId: lease.leaseId,
      voiceSessionId: lease.voiceSessionId,
      browserInstanceId: lease.mediaBrowserInstanceId,
      connectionGeneration: lease.mediaConnectionGeneration,
      tabId: lease.mediaTabId,
      windowId: lease.mediaWindowId,
      mediaUrl: lease.mediaUrl,
      action,
      expectedDocumentGeneration: lease.mediaDocumentGeneration,
      expectedMediaTargetId: lease.mediaTargetId,
      issuedAt: now,
      expiresAt: now + MEDIA_COMMAND_TTL_MS,
      acknowledged: false,
    };

    const queue = this.pendingCommands.get(command.browserInstanceId) || [];
    queue.push(command);
    this.pendingCommands.set(command.browserInstanceId, queue);
    this.commandsById.set(command.commandId, command);

    const pendingWaiters = this.waiters.get(command.browserInstanceId);
    if (pendingWaiters?.length) {
      const waiter = pendingWaiters.shift();
      if (pendingWaiters.length === 0) this.waiters.delete(command.browserInstanceId);
      else this.waiters.set(command.browserInstanceId, pendingWaiters);
      if (waiter) waiter(this.getPendingCommands(command.browserInstanceId));
    }

    return command;
  }

  public async waitForCommands(
    browserInstanceId: string,
    timeoutMs = 20_000
  ): Promise<PendingMediaCommand[]> {
    const existing = this.getPendingCommands(browserInstanceId);
    if (existing.length > 0) return existing;

    return new Promise<PendingMediaCommand[]>((resolve) => {
      let settled = false;
      const onCommand = (commands: PendingMediaCommand[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(commands);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const waiters = this.waiters.get(browserInstanceId) || [];
        this.waiters.set(
          browserInstanceId,
          waiters.filter((waiter) => waiter !== onCommand)
        );
        resolve([]);
      }, timeoutMs);

      const waiters = this.waiters.get(browserInstanceId) || [];
      waiters.push(onCommand);
      this.waiters.set(browserInstanceId, waiters);
    });
  }

  public getPendingCommands(browserInstanceId: string): PendingMediaCommand[] {
    const now = Date.now();
    const queue = this.pendingCommands.get(browserInstanceId) || [];
    this.pendingCommands.delete(browserInstanceId);
    const deliverable: PendingMediaCommand[] = [];

    for (const command of queue) {
      if (command.cancelled || command.expiresAt < now) {
        this.acknowledgeMediaCommand({
          commandId: command.commandId,
          browserInstanceId: command.browserInstanceId,
          connectionGeneration: command.connectionGeneration,
          tabId: command.tabId,
          action: command.action,
          outcome: 'STALE_TARGET',
          initialPlayback: 'unknown',
          finalPlayback: 'unknown',
        });
        continue;
      }
      command.deliveredAt = now;
      deliverable.push(command);
    }

    return deliverable;
  }

  public getActiveLease(): PauseLease | null {
    this.expireLease(Date.now());
    return this.activeLease;
  }

  public getActiveSession(): VoiceSession | null {
    return this.activeSessions.values().next().value ?? null;
  }

  public getStatus(): VoiceStatus {
    const now = Date.now();
    this.expireLease(now);
    return {
      voice: {
        active: this.activeSessions.size > 0,
        sessionId: this.getActiveSession()?.sessionId,
        sourceBrowser: this.getActiveSession()?.source.displayName,
        tabId: this.getActiveSession()?.tabId,
        provider: this.getActiveSession()?.provider,
        startedAt: this.getActiveSession()?.startedAt,
      },
      mediaAutoPause: {
        leaseActive: !!this.activeLease,
        targetBrowser: this.activeLease?.mediaBrowserInstanceId,
        targetTabId: this.activeLease?.mediaTabId,
        mediaTitle: this.activeLease?.mediaTitle,
        initialPlayback: this.activeLease?.initialPlayback ?? 'unknown',
        didPause: this.activeLease?.didPause ?? false,
        resumeAuthorized: this.activeLease?.resumeAuthorized ?? false,
        overridden: this.activeLease?.overridden ?? false,
        expiresAt: this.activeLease?.expiresAt,
      },
    };
  }

  public clear(): void {
    this.activeSessions.clear();
    this.activeLease = null;
    this.pendingCommands.clear();
    this.commandsById.clear();
    this.waiters.clear();
  }

  public isMediaCommandExecutable(
    commandId: string,
    browserInstanceId: string,
    connectionGeneration: number
  ): boolean {
    const command = this.commandsById.get(commandId);
    if (
      !command ||
      command.acknowledged ||
      command.cancelled ||
      command.expiresAt < Date.now() ||
      command.browserInstanceId !== browserInstanceId ||
      command.connectionGeneration !== connectionGeneration
    ) {
      return false;
    }

    // A command minted from a superseded media publication cannot become
    // executable again, even if an old worker is still finishing an in-flight
    // poll. The fresh worker must first publish a fresh channel generation.
    const media = this.contextChannels.get('media');
    if (
      !media ||
      media.browserInstanceId !== command.browserInstanceId ||
      media.connectionGeneration !== command.connectionGeneration ||
      media.tabId !== command.tabId
    ) {
      return false;
    }
    if (command.action === 'RESUME') {
      return !!(
        this.activeSessions.size === 0 &&
        this.activeLease?.endRequested &&
        this.activeLease.resumeCommandId === command.commandId
      );
    }
    return this.activeLease?.pauseCommandId === command.commandId;
  }

  private voiceProducerKey(
    source: VoiceSource,
    tabId: number,
    sessionId: string
  ): string {
    return `${source.browserInstanceId}:${source.connectionGeneration}:${tabId}:${sessionId}`;
  }

  private finishEndedLease(
    lease: PauseLease,
    now: number
  ): { success: boolean; actionTaken: string } {
    if (now > lease.expiresAt) {
      this.activeLease = null;
      return { success: true, actionTaken: 'lease_expired_no_resume' };
    }
    if (lease.overridden) {
      this.activeLease = null;
      return { success: true, actionTaken: 'user_override_prevented_resume' };
    }
    if (!lease.didPause || !lease.resumeAuthorized) {
      this.activeLease = null;
      return { success: true, actionTaken: 'pre_paused_or_unconfirmed_media_not_resumed' };
    }
    if (!this.isCurrentMediaTarget(lease)) {
      this.activeLease = null;
      return { success: true, actionTaken: 'media_owner_or_generation_changed_no_resume' };
    }

    const resume = this.enqueueMediaCommand(lease, 'RESUME');
    lease.resumeCommandId = resume.commandId;
    return { success: true, actionTaken: 'voice_ended_media_resume_queued' };
  }

  private isCurrentMediaTarget(lease: PauseLease): boolean {
    const current = this.contextChannels.get('media');
    const record = this.contextChannels.getRecord('media') as ContextRecord | null;
    return !!(
      current &&
      record &&
      current.browserInstanceId === lease.mediaBrowserInstanceId &&
      current.connectionGeneration === lease.mediaConnectionGeneration &&
      current.tabId === lease.mediaTabId &&
      current.windowId === lease.mediaWindowId &&
      record.url === lease.mediaUrl &&
      lease.mediaDocumentGeneration &&
      record.documentGeneration === lease.mediaDocumentGeneration &&
      lease.mediaTargetId
    );
  }

  private cancelCommand(command: PendingMediaCommand): void {
    command.cancelled = true;
    if (command.deliveredAt) return;
    const queue = this.pendingCommands.get(command.browserInstanceId) || [];
    this.pendingCommands.set(
      command.browserInstanceId,
      queue.filter((queued) => queued.commandId !== command.commandId)
    );
    this.commandsById.delete(command.commandId);
  }

  private expireLease(now: number): void {
    if (!this.activeLease || now <= this.activeLease.expiresAt) return;
    if (this.activeLease.pauseCommandId) {
      const command = this.commandsById.get(this.activeLease.pauseCommandId);
      if (command) this.cancelCommand(command);
    }
    if (this.activeLease.resumeCommandId) {
      const command = this.commandsById.get(this.activeLease.resumeCommandId);
      if (command) this.cancelCommand(command);
    }
    this.activeLease = null;
  }
}
