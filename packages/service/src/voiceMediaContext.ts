import { execFileSync } from 'child_process';
import path from 'path';

export interface VoiceMediaContextSnapshot {
  source: string;
  playbackState?: 'playing' | 'paused';
  title: string;
  artist?: string;
  albumTitle?: string;
}

interface VoiceMediaContextWireResult {
  kind?: unknown;
  outcome?: unknown;
  source?: unknown;
  playbackState?: unknown;
  title?: unknown;
  artist?: unknown;
  albumTitle?: unknown;
}

export type VoiceMediaContextExecutor = (executable: string, args: string[]) => string;

export const VOICE_MEDIA_CONTEXT_CACHE_MS = 1000;

export function defaultVoiceMediaBridgeHostPath(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  return path.join(
    localAppData,
    'VoiceMediaBridge',
    'NativeHost',
    'VoiceMediaBridge.NativeHost.exe'
  );
}

export function parseVoiceMediaContext(raw: string): VoiceMediaContextSnapshot | null {
  let parsed: VoiceMediaContextWireResult;
  try {
    parsed = JSON.parse(raw) as VoiceMediaContextWireResult;
  } catch (_error) {
    return null;
  }

  if (
    parsed.kind !== 'VMB_MEDIA_CONTEXT_RESULT' ||
    parsed.outcome !== 'Found' ||
    typeof parsed.source !== 'string' ||
    !parsed.source.trim() ||
    typeof parsed.title !== 'string' ||
    !parsed.title.trim()
  ) {
    return null;
  }

  const playbackState =
    parsed.playbackState === 'Playing'
      ? 'playing'
      : parsed.playbackState === 'Paused'
        ? 'paused'
        : undefined;

  return {
    source: parsed.source.trim(),
    title: parsed.title.trim(),
    playbackState,
    artist: typeof parsed.artist === 'string' && parsed.artist.trim() ? parsed.artist.trim() : undefined,
    albumTitle:
      typeof parsed.albumTitle === 'string' && parsed.albumTitle.trim()
        ? parsed.albumTitle.trim()
        : undefined,
  };
}

function defaultExecutor(executable: string, args: string[]): string {
  return execFileSync(executable, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 1500,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Read-only adapter from StreamDockBridge to VoiceMediaBridge's GSMTC authority.
 *
 * StreamDockBridge never issues a media command here. It asks the already-installed
 * VoiceMediaBridge executable for the current media projection and caches the answer
 * briefly so Stream Deck feedback cannot spawn a process storm.
 */
export class VoiceMediaContextReader {
  private cachedAt = 0;
  private cached: VoiceMediaContextSnapshot | null = null;

  constructor(
    private readonly executor: VoiceMediaContextExecutor = defaultExecutor,
    private readonly hostPath: () => string | null = defaultVoiceMediaBridgeHostPath
  ) {}

  read(now = Date.now()): VoiceMediaContextSnapshot | null {
    if (this.cachedAt > 0 && now - this.cachedAt < VOICE_MEDIA_CONTEXT_CACHE_MS) {
      return this.cached;
    }

    this.cachedAt = now;
    const executable = this.hostPath();
    if (!executable) {
      this.cached = null;
      return null;
    }

    try {
      this.cached = parseVoiceMediaContext(
        this.executor(executable, ['--media-context-json'])
      );
    } catch (_error) {
      this.cached = null;
    }

    return this.cached;
  }

  invalidate(): void {
    this.cachedAt = 0;
    this.cached = null;
  }
}

export const voiceMediaContext = new VoiceMediaContextReader();
