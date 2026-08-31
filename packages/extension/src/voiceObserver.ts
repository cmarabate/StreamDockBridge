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
  private unloadHandler: (() => void) | null = null;

  constructor(private readonly onStateChange: VoiceObserverCallback) {}

  public getDiagnosticInfo(): { isVoiceActive: boolean; attached: boolean } {
    return {
      isVoiceActive: this.isVoiceActive,
      attached: !!this.composerForm,
    };
  }

  public start(): void {
    this.attach();
    if (typeof window !== 'undefined') {
      this.pollTimer = window.setInterval(() => {
        if (!this.composerForm || !document.contains(this.composerForm)) {
          this.attach();
        } else {
          this.evaluateState();
        }
      }, 500);

      this.unloadHandler = () => {
        this.stop();
      };

      window.addEventListener('pagehide', this.unloadHandler);
      window.addEventListener('beforeunload', this.unloadHandler);
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
    if (this.isVoiceActive) {
      this.emitState(false);
    }
  }

  private findComposerContainer(): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const promptInput = document.getElementById('prompt-textarea');
    if (promptInput) {
      return (
        promptInput.closest('main') ||
        (document.querySelector('main') as HTMLElement) ||
        promptInput.closest('form') ||
        promptInput.parentElement
      );
    }
    return (document.querySelector('main') as HTMLElement) || document.querySelector('form') || document.body;
  }

  private checkIsActive(root: HTMLElement): boolean {
    const doc = root.ownerDocument || document;

    // 1. Explicit stop / cancel dictation buttons anywhere in active view
    const stopButton = doc.querySelector(
      'button[aria-label*="stop dictat" i], button[aria-label*="stop record" i], button[aria-label*="stop listen" i], button[data-testid="dictate-stop-button"], button[data-testid="speech-stop-button"]'
    );
    if (stopButton) return true;

    // 2. Microphone button aria-label or attribute state
    const speechBtns = doc.querySelectorAll(
      'button[data-testid*="speech"], button[data-testid*="dictat"], button[aria-label*="dictat" i], button[aria-label*="voice" i], button[aria-label*="speech" i], button[aria-label*="microphone" i]'
    );
    for (let i = 0; i < speechBtns.length; i++) {
      const btn = speechBtns[i];
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      const testId = (btn.getAttribute('data-testid') || '').toLowerCase();
      const ariaPressed = btn.getAttribute('aria-pressed');

      if (
        ariaPressed === 'true' ||
        /stop|cancel|listening|recording|done/i.test(ariaLabel) ||
        /stop|recording|listening/i.test(testId)
      ) {
        return true;
      }
    }

    // 3. Waveform, visualizer, or active speech indicators inside composer or thread bottom
    const waveform = doc.querySelector(
      '[data-testid*="waveform"], [data-testid*="speech-indicator"], [data-testid*="dictat-anim"], [class*="waveform"], [data-is-recording="true"], [data-recording="true"]'
    );
    if (waveform) return true;

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
