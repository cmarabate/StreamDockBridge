import * as http from 'http';

export interface ActionMap {
  [actionUuid: string]: string; // actionUuid -> route path (e.g. 'imdb')
}

export const ROUTE_MAP: ActionMap = {
  'com.cmarabate.streamdock.streamdockbridge.imdb': 'imdb',
  'com.cmarabate.streamdock.streamdockbridge.cast': 'cast',
  'com.cmarabate.streamdock.streamdockbridge.justwatch': 'justwatch',
  'com.cmarabate.streamdock.streamdockbridge.reddit': 'reddit',
};

export type HttpRequester = (actionRoute: string) => Promise<{ statusCode: number; success: boolean }>;

export const defaultHttpRequester: HttpRequester = (actionRoute: string) => {
  return new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:17337/lookup/${actionRoute}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          let success = res.statusCode === 200;
          try {
            const parsed = JSON.parse(body);
            if (parsed && typeof parsed.success === 'boolean') {
              success = parsed.success;
            }
          } catch (e) {
            // Use statusCode
          }
          resolve({ statusCode: res.statusCode || 500, success });
        });
      }
    );

    req.on('error', () => {
      resolve({ statusCode: 500, success: false });
    });

    req.end();
  });
};

export async function handlePluginKeyDown(
  context: string,
  actionUuid: string,
  requester: HttpRequester = defaultHttpRequester,
  sendAlert?: (context: string) => void
): Promise<{ route: string | null; success: boolean }> {
  // Extract route suffix if full UUID or suffix is passed
  let route: string | null = null;

  for (const key of Object.keys(ROUTE_MAP)) {
    if (actionUuid === key || actionUuid.endsWith(ROUTE_MAP[key])) {
      route = ROUTE_MAP[key];
      break;
    }
  }

  if (!route) {
    if (sendAlert) sendAlert(context);
    return { route: null, success: false };
  }

  const result = await requester(route);
  if (!result.success && sendAlert) {
    sendAlert(context);
  }

  return { route, success: result.success };
}
