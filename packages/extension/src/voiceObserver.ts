export type VoiceInputLifecycleEvent = 'VOICE_INPUT_STARTED' | 'VOICE_INPUT_ENDED';

export interface VoiceObserverCallback {
  (event: VoiceInputLifecycleEvent, timestamp: number): void;
}

/**
 * Bounded ChatGPT Voice / Dictate observer.
 *
 * Observes ONLY the chat composer form subtree where the microphone / speech
 * button lives.
 *
 * PRIVACY GUARANTEE:
 * - ZERO audio recording / media stream interception.
 * - ZERO text / transcript character inspection.
 * - Emits discrete boolean lifecycle events only.
 */
export class ChatGPTVoiceObserver {
  private observer: MutationObserver | null = null;
  private isVoiceActive = false;
  private composerForm: HTMLElement | null = null;
  private pollTimer: number | null = null;

  constructor(private readonly onStateChange: VoiceObserverCallback) {}

  private unloadHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;

  public start(): void {
    this.attach();
    if (typeof window !== 'undefined') {
      this.pollTimer = window.setInterval(() => {
        if (!this.composerForm || !document.contains(this.composerForm)) {
          this.attach();
        }
      }, 2000);

      this.unloadHandler = () => {
        this.stop();
      };
      this.visibilityHandler = () => {
        if (typeof document !== 'undefined' && document.hidden) {
          this.evaluateState();
        }
      };

      window.addEventListener('pagehide', this.unloadHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
      document.addEventListener('visibilitychange', this.visibilityHandler);
    }
  }

  public stop(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (typeof window !== 'undefined' && this.unloadHandler) {
      window.removeEventListener('pagehide', this.unloadHandler);
      window.removeEventListener('beforeunload', this.unloadHandler);
      this.unloadHandler = null;
    }
    if (typeof document !== 'undefined' && this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.isVoiceActive) {
      this.emitState(false);
    }
  }

  private findComposerContainer(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const promptInput = document.getElementById('prompt-textarea');
    if (promptInput) {
      return promptInput.closest('form') || promptInput.parentElement;
    }
    return document.querySelector('form');
  }

  private checkIsActive(root: HTMLElement): boolean {
    // 1. Check for explicit stop / cancel dictation buttons
    const hasStopDictateButton = root.querySelector(
      'button[aria-label*="stop dictat" i], button[aria-label*="stop record" i], button[data-testid="dictate-stop-button"]'
    );
    if (hasStopDictateButton) return true;

    // 2. Check microphone button aria-label state
    const speechBtn = root.querySelector(
      'button[data-testid="composer-speech-button"], button[data-testid="dictate-button"]'
    );
    if (speechBtn) {
      const ariaLabel = speechBtn.getAttribute('aria-label') || '';
      if (/stop|cancel|listening|recording|done/i.test(ariaLabel)) {
        return true;
      }
    }

    // 3. Check for waveform / listening indicators inside composer
    const hasWaveform = root.querySelector(
      '[data-testid*="waveform"], [data-testid*="speech-indicator"], [class*="listening"]'
    );
    if (hasWaveform) return true;

    return false;
  }

  public evaluateState(): void {
    if (!this.composerForm) return;
    const active = this.checkIsActive(this.composerForm);
    if (active !== this.isVoiceActive) {
      this.emitState(active);
    }
  }

  private emitState(active: boolean): void {
    this.isVoiceActive = active;
    const event: VoiceInputLifecycleEvent = active ? 'VOICE_INPUT_STARTED' : 'VOICE_INPUT_ENDED';
    this.onStateChange(event, Date.now());
  }

  private attach(): void {
    const container = this.findComposerContainer();
    if (!container || container === this.composerForm) return;

    if (this.observer) {
      this.observer.disconnect();
    }

    this.composerForm = container;
    if (typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => {
        this.evaluateState();
      });

      this.observer.observe(this.composerForm, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-label', 'data-testid', 'class', 'disabled'],
        characterData: false, // ZERO transcript/text capture
      });
    }

    this.evaluateState();
  }
}
