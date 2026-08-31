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
  private activeSession: VoiceSession | null = null;
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
      if (this.activeSession?.active) {
        const sameProducer =
          this.activeSession.sessionId === sessionId &&
          this.activeSession.source.browserInstanceId === source.browserInstanceId &&
          this.activeSession.source.connectionGeneration === source.connectionGeneration &&
          this.activeSession.tabId === tabId;
        return {
          success: true,
          actionTaken: sameProducer ? 'duplicate_start_ignored' : 'overlapping_start_ignored',
        };
      }

      const mediaState = this.contextChannels.get('media');
      const mediaRecord = this.contextChannels.getRecord('media') as ContextRecord | null;

      this.activeSession = {
        sessionId,
        source,
        tabId,
        provider,
        startedAt: now,
        active: true,
      };

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
      if (!this.activeSession || !this.sameVoiceProducer(this.activeSession, source, tabId, sessionId)) {
        return { success: true, actionTaken: 'stale_or_unknown_end_ignored' };
      }

      this.activeSession.active = false;
      this.activeSession.endedAt = now;
      this.activeSession = null;

      const lease = this.activeLease;
      if (!lease || lease.voiceSessionId !== sessionId) {
        this.activeLease = null;
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
            this.cancelUndeliveredCommand(pauseCommand);
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
      return { success: true, actionTaken: `resume_ack_${acknowledgement.outcome.toLowerCase()}` };
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

    if (lease.endRequested) {
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
      expectedMediaTargetId: action === 'RESUME' ? lease.mediaTargetId : undefined,
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
      this.waiters.delete(command.browserInstanceId);
      const commands = this.getPendingCommands(command.browserInstanceId);
      for (const waiter of pendingWaiters) waiter(commands);
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
      if (command.expiresAt < now) {
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
    return this.activeSession;
  }

  public getStatus(): VoiceStatus {
    const now = Date.now();
    this.expireLease(now);
    return {
      voice: {
        active: !!this.activeSession?.active,
        sessionId: this.activeSession?.sessionId,
        sourceBrowser: this.activeSession?.source.displayName,
        tabId: this.activeSession?.tabId,
        provider: this.activeSession?.provider,
        startedAt: this.activeSession?.startedAt,
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
    this.activeSession = null;
    this.activeLease = null;
    this.pendingCommands.clear();
    this.commandsById.clear();
    this.waiters.clear();
  }

  private sameVoiceProducer(
    session: VoiceSession,
    source: VoiceSource,
    tabId: number,
    sessionId: string
  ): boolean {
    return (
      session.sessionId === sessionId &&
      session.source.browserInstanceId === source.browserInstanceId &&
      session.source.connectionGeneration === source.connectionGeneration &&
      session.tabId === tabId
    );
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

    this.enqueueMediaCommand(lease, 'RESUME');
    this.activeLease = null;
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

  private cancelUndeliveredCommand(command: PendingMediaCommand): void {
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
      if (command && !command.deliveredAt) this.cancelUndeliveredCommand(command);
    }
    this.activeLease = null;
  }
}
