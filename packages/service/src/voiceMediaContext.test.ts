import {
  parseVoiceMediaContext,
  VoiceMediaContextReader,
  VOICE_MEDIA_CONTEXT_CACHE_MS,
} from './voiceMediaContext';

describe('VoiceMediaBridge media context reader', () => {
  it('accepts only a Found GSMTC media context result', () => {
    expect(
      parseVoiceMediaContext(
        JSON.stringify({
          kind: 'VMB_MEDIA_CONTEXT_RESULT',
          event: 'MEDIA_CONTEXT',
          outcome: 'Found',
          source: 'Brave',
          playbackState: 'Playing',
          title: 'Regular Show | Disney+',
          artist: null,
          albumTitle: null,
        })
      )
    ).toEqual({
      source: 'Brave',
      playbackState: 'playing',
      title: 'Regular Show | Disney+',
      artist: undefined,
      albumTitle: undefined,
    });

    expect(
      parseVoiceMediaContext(
        JSON.stringify({
          kind: 'VMB_MEDIA_CONTEXT_RESULT',
          outcome: 'Ambiguous',
          source: 'Brave',
          title: 'Wrongly tempting title',
        })
      )
    ).toBeNull();
  });

  it('fails closed on malformed or titleless responses', () => {
    expect(parseVoiceMediaContext('not json')).toBeNull();
    expect(
      parseVoiceMediaContext(
        JSON.stringify({
          kind: 'VMB_MEDIA_CONTEXT_RESULT',
          outcome: 'Found',
          source: 'Brave',
          title: '   ',
        })
      )
    ).toBeNull();
  });

  it('caches briefly so repeated feedback reads cannot spawn a process storm', () => {
    const execute = jest.fn(() =>
      JSON.stringify({
        kind: 'VMB_MEDIA_CONTEXT_RESULT',
        outcome: 'Found',
        source: 'Brave',
        playbackState: 'Paused',
        title: 'Samsara',
      })
    );
    const reader = new VoiceMediaContextReader(execute, () => 'C:\\VoiceMediaBridge.NativeHost.exe');

    expect(reader.read(10_000)?.title).toBe('Samsara');
    expect(reader.read(10_000 + VOICE_MEDIA_CONTEXT_CACHE_MS - 1)?.title).toBe('Samsara');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('C:\\VoiceMediaBridge.NativeHost.exe', [
      '--media-context-json',
    ]);

    expect(reader.read(10_000 + VOICE_MEDIA_CONTEXT_CACHE_MS + 1)?.title).toBe('Samsara');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('returns null without launching anything when VoiceMediaBridge is not installed', () => {
    const execute = jest.fn(() => '');
    const reader = new VoiceMediaContextReader(execute, () => null);

    expect(reader.read(5_000)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });
});
