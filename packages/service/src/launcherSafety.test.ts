import * as childProcess from 'child_process';
import { createBridgeServer } from './server';
import { SecretStore } from './secretStore';

jest.mock('child_process');

/**
 * The browser launcher must never involve a shell.
 *
 * This previously ran `exec('start "" "<url>"')`, which goes through cmd, where
 * a double quote ends the quoted argument and `\"` is NOT an escape — so a
 * template of `https://example.com/?q="&&calc.exe&&"` parsed as a valid URL and
 * broke out into a command. Context URL is what first let arbitrary template
 * text reach that call, and these assertions are what keep it closed.
 */

const mockedExecFile = childProcess.execFile as unknown as jest.Mock;
const mockedExec = childProcess.exec as unknown as jest.Mock;
const mockedSpawn = childProcess.spawn as unknown as jest.Mock;

function defaultLauncher() {
  // No launcher option, so the server builds its real one.
  const server = createBridgeServer({
    port: 0,
    secretStore: { getSecret: () => 'x', verifySecret: () => true } as unknown as SecretStore,
    iconService: { resolve: async () => ({ status: 'local_host' }) } as never,
  });
  return server.launcher;
}

beforeEach(() => {
  mockedExecFile.mockReset();
  mockedExec.mockReset();
  mockedSpawn.mockReset();
});

describe('the default browser launcher', () => {
  it('passes the URL as its own argument, with no shell anywhere', () => {
    defaultLauncher()('https://www.imdb.com/find?q=Gary%20and%20His%20Demons');

    expect(mockedExec).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
    expect(mockedExecFile).toHaveBeenCalledTimes(1);

    const [file, args] = mockedExecFile.mock.calls[0];
    expect(file).toBe('rundll32.exe');
    // The URL is one argv entry, so there is no command line to escape from.
    expect(args).toEqual([
      'url.dll,FileProtocolHandler',
      'https://www.imdb.com/find?q=Gary%20and%20His%20Demons',
    ]);
  });

  it('refuses a URL containing a double quote outright', () => {
    defaultLauncher()('https://example.com/?q="&&calc.exe&&"');
    expect(mockedExecFile).not.toHaveBeenCalled();
    expect(mockedExec).not.toHaveBeenCalled();
  });

  it('passes shell metacharacters through inertly as data', () => {
    const hostile = 'https://example.com/?q=%26%26calc.exe%26%26|;$(whoami)`id`';
    defaultLauncher()(hostile);

    const [file, args] = mockedExecFile.mock.calls[0];
    expect(file).toBe('rundll32.exe');
    // Verbatim in its own slot: nothing interprets it.
    expect(args[1]).toBe(hostile);
  });
});
