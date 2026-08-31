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

  constructor(
    private readonly documentGeneration: string,
    private readonly onUserOverride?: (evidence: MediaOverrideEvidence) => void
  ) {
    this.attachEventListeners();
  }

  public async execute(request: MediaCommandRequest): Promise<MediaCommandResult> {
    if (
      request.expectedDocumentGeneration &&
      request.expectedDocumentGeneration !== this.documentGeneration
    ) {
      return this.result(request, 'STALE_TARGET', 'unknown', 'unknown');
    }
    return request.command === 'PAUSE' ? this.pause(request) : this.resume(request);
  }

  private async pause(request: MediaCommandRequest): Promise<MediaCommandResult> {
    const video = findActiveMediaVideo();
    if (!video) return this.result(request, 'NOT_FOUND', 'unknown', 'unknown');

    const mediaTargetId = this.targetId(video);
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
      return;
    }

    const owned = this.ownedPause;
    if (!owned || owned.video !== target) return;
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
    if (target === this.expectedPauseEvent) this.expectedPauseEvent = null;
  };

  private readonly onVideoTerminated = (event: Event): void => {
    const target = event.target as HTMLVideoElement;
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
}
