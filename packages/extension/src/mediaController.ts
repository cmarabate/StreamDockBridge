export interface VideoScoringResult {
  video: HTMLVideoElement;
  score: number;
  isActivePlaying: boolean;
}

export type PlaybackState = 'playing' | 'paused' | 'unknown';
export type MediaCommandOutcome =
  | 'CHANGED'
  | 'ALREADY_IN_STATE'
  | 'NOT_FOUND'
  | 'FAILED'
  | 'STALE_TARGET';

export interface MediaCommandRequest {
  commandId: string;
  leaseId: string;
  command: 'PAUSE' | 'RESUME';
  expectedDocumentGeneration?: string;
  expectedMediaTargetId?: string;
  expiresAt?: number;
}

export interface MediaCommandResult {
  commandId: string;
  action: 'PAUSE' | 'RESUME';
  outcome: MediaCommandOutcome;
  initialPlayback: PlaybackState;
  finalPlayback: PlaybackState;
  documentGeneration: string;
  mediaTargetId?: string;
}

export interface MediaOverrideEvidence {
  leaseId: string;
  pauseCommandId: string;
  documentGeneration: string;
  mediaTargetId: string;
}

interface OwnedPause {
  leaseId: string;
  pauseCommandId: string;
  video: HTMLVideoElement;
  mediaTargetId: string;
}

export function getAllVideosInSubtree(root: Document | ShadowRoot | Element): HTMLVideoElement[] {
  const videos: HTMLVideoElement[] = [];
  if (!root || typeof (root as any).querySelectorAll !== 'function') return videos;

  const direct = (root as any).querySelectorAll('video');
  direct.forEach((video: HTMLVideoElement) => videos.push(video));

  if (typeof document !== 'undefined' && document.createTreeWalker) {
    try {
      const walker = document.createTreeWalker(
        root instanceof Document ? root.documentElement : (root as Node),
        NodeFilter.SHOW_ELEMENT,
        null
      );
      let node = walker.currentNode as Element | null;
      while (node) {
        if (node.shadowRoot) videos.push(...getAllVideosInSubtree(node.shadowRoot));
        node = walker.nextNode() as Element | null;
      }
    } catch (_error) {
      // A closed or transient shadow root simply contributes no candidates.
    }
  }

  return Array.from(new Set(videos));
}

export function evaluateVideoCandidate(video: HTMLVideoElement): VideoScoringResult {
  let score = 0;
  if (!video.isConnected) return { video, score: -1, isActivePlaying: false };

  let isVisible = true;
  let rect = { width: 100, height: 100 };
  if (typeof window !== 'undefined' && video.getBoundingClientRect) {
    rect = video.getBoundingClientRect();
    const style = window.getComputedStyle(video);
    isVisible =
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      parseFloat(style.opacity || '1') > 0.05 &&
      rect.width >= 48 &&
      rect.height >= 48;
  }

  if (!isVisible) return { video, score: -1, isActivePlaying: false };

  score += Math.min((rect.width * rect.height) / 1000, 500);
  const isPlaying = !video.paused && !video.ended;
  const hasStarted = video.currentTime > 0;
  const hasBuffer = video.readyState >= 2;
  const hasValidDuration =
    typeof video.duration === 'number' &&
    (video.duration > 0 || video.duration === Infinity || isNaN(video.duration));

  if (isPlaying && hasStarted && hasBuffer && hasValidDuration) score += 1000;
  else if (!video.paused && hasBuffer) score += 500;
  else if (hasStarted && hasBuffer) score += 100;

  if (!video.muted && video.volume > 0.05) score += 300;
  if (video.currentSrc || video.src) score += 50;
  return { video, score, isActivePlaying: isPlaying && isVisible && hasBuffer };
}

export function findActiveMediaVideo(root: Document | ShadowRoot = document): HTMLVideoElement | null {
  const scored = getAllVideosInSubtree(root)
    .map(evaluateVideoCandidate)
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.video ?? null;
}

/**
 * Executes conditional media mutations and records exact causal ownership.
 * The browser event loop makes the pre-state check and pause() call one atomic
 * task: if the user's pause wins first, the result is ALREADY_IN_STATE.
 */
export class MediaPlaybackController {
  private readonly targetIds = new WeakMap<HTMLVideoElement, string>();
  private targetCounter = 0;
  private ownedPause: OwnedPause | null = null;
  private expectedPauseEvent: HTMLVideoElement | null = null;
  private expectedResumeEvent: HTMLVideoElement | null = null;
  private readonly completedCommands = new Map<string, MediaCommandResult>();
  private readonly inFlightCommands = new Map<string, Promise<MediaCommandResult>>();

  constructor(
    private readonly documentGeneration: string,
    private readonly onUserOverride?: (evidence: MediaOverrideEvidence) => void,
    private readonly onPlaybackChange?: (isPlaying: boolean) => void
  ) {
    this.attachEventListeners();
  }

  public execute(request: MediaCommandRequest): Promise<MediaCommandResult> {
    const completed = this.completedCommands.get(request.commandId);
    if (completed) return Promise.resolve(completed);

    const inFlight = this.inFlightCommands.get(request.commandId);
    if (inFlight) return inFlight;

    // Register before beginning the mutation. Deferring execution by one
    // microtask makes two same-turn deliveries share this exact promise rather
    // than both entering pause()/play() before a result can be cached.
    const execution = Promise.resolve().then(() => this.executeOnce(request));
    this.inFlightCommands.set(request.commandId, execution);
    const clearInFlight = () => {
      if (this.inFlightCommands.get(request.commandId) === execution) {
        this.inFlightCommands.delete(request.commandId);
      }
    };
    void execution.then(clearInFlight, clearInFlight);
    return execution;
  }

  private async executeOnce(request: MediaCommandRequest): Promise<MediaCommandResult> {
    if (request.expiresAt !== undefined && request.expiresAt < Date.now()) {
      return this.remember(this.result(request, 'STALE_TARGET', 'unknown', 'unknown'));
    }
    if (
      request.expectedDocumentGeneration &&
      request.expectedDocumentGeneration !== this.documentGeneration
    ) {
      return this.remember(this.result(request, 'STALE_TARGET', 'unknown', 'unknown'));
    }
    const result = request.command === 'PAUSE' ? await this.pause(request) : await this.resume(request);
    return this.remember(result);
  }

  private async pause(request: MediaCommandRequest): Promise<MediaCommandResult> {
    const video = findActiveMediaVideo();
    if (!video) return this.result(request, 'NOT_FOUND', 'unknown', 'unknown');

    const mediaTargetId = this.targetId(video);
    if (request.expectedMediaTargetId && request.expectedMediaTargetId !== mediaTargetId) {
      return this.result(request, 'STALE_TARGET', this.stateOf(video), this.stateOf(video), mediaTargetId);
    }
    if (video.paused || video.ended) {
      return this.result(request, 'ALREADY_IN_STATE', 'paused', 'paused', mediaTargetId);
    }

    this.expectedPauseEvent = video;
    try {
      video.pause();
    } catch (_error) {
      this.expectedPauseEvent = null;
      return this.result(request, 'FAILED', 'playing', this.stateOf(video), mediaTargetId);
    }

    if (!video.paused) {
      this.expectedPauseEvent = null;
      return this.result(request, 'FAILED', 'playing', this.stateOf(video), mediaTargetId);
    }

    // Do not depend on a non-bubbling media event reaching the document-level
    // listener. The verified state transition is the authoritative boundary.
    this.expectedPauseEvent = null;
    this.ownedPause = {
      leaseId: request.leaseId,
      pauseCommandId: request.commandId,
      video,
      mediaTargetId,
    };
    return this.result(request, 'CHANGED', 'playing', 'paused', mediaTargetId);
  }

  private async resume(request: MediaCommandRequest): Promise<MediaCommandResult> {
    const owned = this.ownedPause;
    if (
      !owned ||
      owned.leaseId !== request.leaseId ||
      !request.expectedMediaTargetId ||
      owned.mediaTargetId !== request.expectedMediaTargetId ||
      !owned.video.isConnected
    ) {
      return this.result(request, 'STALE_TARGET', 'unknown', 'unknown');
    }

    const video = owned.video;
    if (!video.paused && !video.ended) {
      this.ownedPause = null;
      return this.result(request, 'ALREADY_IN_STATE', 'playing', 'playing', owned.mediaTargetId);
    }

    this.expectedResumeEvent = video;
    try {
      const playPromise = video.play();
      if (playPromise !== undefined) await playPromise;
    } catch (_error) {
      this.expectedResumeEvent = null;
      return this.result(request, 'FAILED', 'paused', this.stateOf(video), owned.mediaTargetId);
    }

    if (video.paused || video.ended) {
      this.expectedResumeEvent = null;
      return this.result(request, 'FAILED', 'paused', this.stateOf(video), owned.mediaTargetId);
    }

    // Some players do not expose their play event outside the media element.
    // Leaving this marker set would swallow the next genuine user Play as if
    // it were the bridge's already-completed resume.
    this.expectedResumeEvent = null;
    this.ownedPause = null;
    return this.result(request, 'CHANGED', 'paused', 'playing', owned.mediaTargetId);
  }

  private attachEventListeners(): void {
    if (typeof document === 'undefined') return;
    document.addEventListener('play', this.onVideoPlay, true);
    document.addEventListener('pause', this.onVideoPause, true);
    document.addEventListener('ended', this.onVideoTerminated, true);
    document.addEventListener('emptied', this.onVideoTerminated, true);
    document.addEventListener('error', this.onVideoTerminated, true);
  }

  private readonly onVideoPlay = (event: Event): void => {
    const target = event.target as HTMLVideoElement;
    if (!target || target.tagName !== 'VIDEO') return;
    if (target === this.expectedResumeEvent) {
      this.expectedResumeEvent = null;
      this.emitPlaybackChange(target);
      return;
    }

    this.emitPlaybackChange(target);
    const owned = this.ownedPause;
    if (!owned) return;
    // Starting any other video in the document changes media authority. The
    // original paused element must never be resumed underneath it.
    if (owned.video !== target) {
      this.ownedPause = null;
      this.expectedPauseEvent = null;
      this.onUserOverride?.({
        leaseId: owned.leaseId,
        pauseCommandId: owned.pauseCommandId,
        documentGeneration: this.documentGeneration,
        mediaTargetId: owned.mediaTargetId,
      });
      return;
    }
    this.ownedPause = null;
    this.expectedPauseEvent = null;
    this.onUserOverride?.({
      leaseId: owned.leaseId,
      pauseCommandId: owned.pauseCommandId,
      documentGeneration: this.documentGeneration,
      mediaTargetId: owned.mediaTargetId,
    });
  };

  private readonly onVideoPause = (event: Event): void => {
    const target = event.target as HTMLVideoElement;
    if (!target || target.tagName !== 'VIDEO') return;
    this.emitPlaybackChange(target);
    if (target === this.expectedPauseEvent) this.expectedPauseEvent = null;
  };

  private readonly onVideoTerminated = (event: Event): void => {
    const target = event.target as HTMLVideoElement;
    this.emitPlaybackChange(target);
    const owned = this.ownedPause;
    if (!target || target.tagName !== 'VIDEO' || !owned || owned.video !== target) return;
    this.ownedPause = null;
    this.onUserOverride?.({
      leaseId: owned.leaseId,
      pauseCommandId: owned.pauseCommandId,
      documentGeneration: this.documentGeneration,
      mediaTargetId: owned.mediaTargetId,
    });
  };

  /**
   * Report a real media transition to the surrounding extension so the Media
   * context can be republished while the tab sits still.
   *
   * A streaming page pressing Play does not navigate, change its title data or
   * switch tabs, so nothing else wakes the background. Without this the service
   * keeps the last-published playbackState (often 'paused' from page load) and
   * the voice coordinator, trusting that authoritative snapshot, treats an
   * actually-playing tab as pre-paused and never pauses or later resumes it.
   *
   * The bridge's own PAUSE/RESUME is included on purpose: republishing the
   * resulting paused/playing state keeps /contexts authoritative, and it cannot
   * loop because a publication never queues a command.
   */
  private emitPlaybackChange(target: HTMLVideoElement | null): void {
    if (!target || target.tagName !== 'VIDEO' || typeof this.onPlaybackChange !== 'function') return;
    this.onPlaybackChange(!target.paused && !target.ended);
  }

  private targetId(video: HTMLVideoElement): string {
    const existing = this.targetIds.get(video);
    if (existing) return existing;
    const id = `media-${++this.targetCounter}`;
    this.targetIds.set(video, id);
    return id;
  }

  private stateOf(video: HTMLVideoElement): PlaybackState {
    return video.paused || video.ended ? 'paused' : 'playing';
  }

  private result(
    request: MediaCommandRequest,
    outcome: MediaCommandOutcome,
    initialPlayback: PlaybackState,
    finalPlayback: PlaybackState,
    mediaTargetId?: string
  ): MediaCommandResult {
    return {
      commandId: request.commandId,
      action: request.command,
      outcome,
      initialPlayback,
      finalPlayback,
      documentGeneration: this.documentGeneration,
      mediaTargetId,
    };
  }

  private remember(result: MediaCommandResult): MediaCommandResult {
    this.completedCommands.set(result.commandId, result);
    // A document cannot accumulate an unbounded replay cache during a long session.
    if (this.completedCommands.size > 256) {
      const oldest = this.completedCommands.keys().next().value;
      if (oldest) this.completedCommands.delete(oldest);
    }
    return result;
  }
}
