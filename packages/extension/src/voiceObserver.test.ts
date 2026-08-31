/** @jest-environment jsdom */

import { ChatGPTVoiceObserver, VoiceInputLifecycleEvent } from './voiceObserver';

describe('ChatGPTVoiceObserver lifecycle semantics', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    jest.restoreAllMocks();
  });

  it('emits the same START/END lifecycle for Dictate UI activated by click or Ctrl+Shift+D', () => {
    document.body.innerHTML = `
      <main>
        <form>
          <div id="prompt-textarea"></div>
          <button aria-label="Dictate" aria-pressed="false"></button>
        </form>
      </main>
    `;
    const events: VoiceInputLifecycleEvent[] = [];
    const observer = new ChatGPTVoiceObserver((event) => events.push(event));
    observer.start();

    const button = document.querySelector('button')!;
    // Both a mic click and Ctrl+Shift+D are rendered by ChatGPT through this
    // same pressed/listening state, so transport semantics are input-agnostic.
    button.setAttribute('aria-pressed', 'true');
    observer.evaluateState();
    button.setAttribute('aria-pressed', 'false');
    observer.evaluateState();

    expect(events).toEqual(['VOICE_INPUT_STARTED', 'VOICE_INPUT_ENDED']);
    observer.stop();
  });

  it('does not emit duplicate lifecycle events while the UI state is unchanged', () => {
    document.body.innerHTML = `
      <main>
        <div id="prompt-textarea"></div>
        <button data-testid="dictate-stop-button"></button>
      </main>
    `;
    const events: VoiceInputLifecycleEvent[] = [];
    const observer = new ChatGPTVoiceObserver((event) => events.push(event));
    observer.start();
    observer.evaluateState();
    observer.evaluateState();
    expect(events).toEqual(['VOICE_INPUT_STARTED']);
    document.querySelector('button')!.remove();
    observer.evaluateState();
    observer.evaluateState();
    expect(events).toEqual(['VOICE_INPUT_STARTED', 'VOICE_INPUT_ENDED']);
    observer.stop();
  });
});
