import WebSocket from 'ws';
import { handlePluginKeyDown } from './pluginHandler';
import { createTitleFeedback } from './titleFeedback';

let ws: WebSocket | null = null;

function send(data: any) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function sendAlert(context: string) {
  send({
    event: 'showAlert',
    context,
  });
}

function showOk(context: string) {
  send({
    event: 'showOk',
    context,
  });
}

function setTitle(context: string, title: string) {
  // target 0 = hardware and software.
  send({
    event: 'setTitle',
    context,
    payload: { title, target: 0 },
  });
}

const titleFeedback = createTitleFeedback(setTitle);

async function handleMessage(msgStr: string) {
  try {
    const data = JSON.parse(msgStr);
    const { event, context, action } = data;

    if (event === 'keyDown') {
      const actionUuid = action || '';
      /**
       * The host sends this key instance's own configuration in
       * payload.settings, keyed by slot in the profile, so no local cache is
       * needed and two keys with the same action never share configuration.
       * Note the asymmetry with setSettings, which puts settings at payload root.
       */
      const settings = data && data.payload ? data.payload.settings : undefined;
      const result = await handlePluginKeyDown(
        context,
        actionUuid,
        undefined,
        sendAlert,
        undefined,
        settings
      );

      // handlePluginKeyDown already alerts on failure; success feedback is ours.
      if (result.route === 'contexturl' && result.success) {
        // The browser navigating is the visible outcome; keep feedback minimal.
        showOk(context);
      }

      if (result.route === 'transcribe') {
        if (result.success) {
          showOk(context);
          titleFeedback.flash(context, result.state === 'already_queued' ? 'Already\nqueued' : 'Queued');
        } else {
          titleFeedback.clearHeld(context);
        }
      }
    }
  } catch (e) {
    // Ignore invalid message JSON
  }
}

export function connect(args: string[] = process.argv) {
  let port: string | null = null;
  let pluginUUID: string | null = null;
  let registerEvent: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-port') port = args[i + 1];
    if (args[i] === '-pluginUUID') pluginUUID = args[i + 1];
    if (args[i] === '-registerEvent') registerEvent = args[i + 1];
  }

  if (!port) {
    return;
  }

  ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.on('open', () => {
    send({
      event: registerEvent,
      uuid: pluginUUID,
    });
  });

  ws.on('message', (data) => {
    handleMessage(data.toString());
  });

  ws.on('close', () => {
    setTimeout(() => connect(args), 3000);
  });

  ws.on('error', () => {});
}

if (require.main === module) {
  connect();
}
