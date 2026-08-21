import { handlePluginKeyDown } from './pluginHandler';

describe('VSD Plugin Transport Handler', () => {
  it('triggers POST for IMDb action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx1', 'com.cmarabate.streamdock.streamdockbridge.imdb', mockRequester);
    expect(res.route).toBe('imdb');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['imdb']);
  });

  it('triggers POST for Cast action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx2', 'com.cmarabate.streamdock.streamdockbridge.cast', mockRequester);
    expect(res.route).toBe('cast');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['cast']);
  });

  it('triggers POST for JustWatch action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx3', 'com.cmarabate.streamdock.streamdockbridge.justwatch', mockRequester);
    expect(res.route).toBe('justwatch');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['justwatch']);
  });

  it('triggers POST for Reddit action', async () => {
    const requestedRoutes: string[] = [];
    const mockRequester = async (route: string) => {
      requestedRoutes.push(route);
      return { statusCode: 200, success: true };
    };

    const res = await handlePluginKeyDown('ctx4', 'com.cmarabate.streamdock.streamdockbridge.reddit', mockRequester);
    expect(res.route).toBe('reddit');
    expect(res.success).toBe(true);
    expect(requestedRoutes).toEqual(['reddit']);
  });

  it('triggers alert on requester failure or unknown route', async () => {
    let alertContext: string | null = null;
    const mockSendAlert = (ctx: string) => {
      alertContext = ctx;
    };

    const failRequester = async () => ({ statusCode: 500, success: false });

    const res = await handlePluginKeyDown('ctx5', 'com.cmarabate.streamdock.streamdockbridge.imdb', failRequester, mockSendAlert);
    expect(res.success).toBe(false);
    expect(alertContext).toBe('ctx5');
  });
});
