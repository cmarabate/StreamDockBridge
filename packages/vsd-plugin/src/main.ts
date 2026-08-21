import WebSocket from 'ws';
import { handlePluginKeyDown } from './pluginHandler';

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

async function handleMessage(msgStr: string) {
  try {
    const data = JSON.parse(msgStr);
    const { event, context, action } = data;

    if (event === 'keyDown') {
      const actionUuid = action || '';
      await handlePluginKeyDown(context, actionUuid, undefined, sendAlert);
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
