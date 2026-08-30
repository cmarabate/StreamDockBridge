import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import { handlePluginKeyDown } from './pluginHandler';
import { createTitleFeedback } from './titleFeedback';
import { IconController, IconOutcome } from './iconController';

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

/**
 * Assert an image on a key.
 *
 * The image belongs at payload.image with target 0 — the shape shipped plugins
 * on this host use. It is a volatile overlay: nothing here is persisted, and
 * the host discards it whenever it rebuilds the key.
 */
function setImage(context: string, dataUri: string) {
  send({
    event: 'setImage',
    context,
    payload: { target: 0, image: dataUri },
  });
}

/**
 * Ask the host to repaint the key from its own art.
 *
 * A shipped plugin on this host carries the comment "Update icon AFTER setState
 * to override manifest icons", which says setState repaints and setImage must
 * follow to win. That makes this the closest thing the host offers to handing a
 * key back — there is no clearImage, resetImage or restoreImage event anywhere
 * in VSD Craft.exe.
 */
function setState(context: string, state: number) {
  send({
    event: 'setState',
    context,
    payload: { state },
  });
}

/**
 * This plugin's own Context URL image, as a data URI.
 *
 * Read from the plugin folder once and kept, because giving up a favicon
 * overlay means asserting SOMETHING — the host has no per-key command that
 * restores the image it was showing before.
 */
let defaultImageUri: string | null | undefined;

function loadDefaultImage(): string | null {
  if (defaultImageUri !== undefined) return defaultImageUri;
  /**
   * Both of these are correct on this host, and both are tried because being
   * wrong here is silent. dist/main.js sits one level below the plugin root,
   * and a Node plugin's cwd is proven to BE that root — a shipped plugin logs
   * ENOENT for `../static/image/01.png` resolving above it, which pins cwd
   * exactly.
   */
  const candidates = [
    path.join(__dirname, '..', 'images', 'icon.png'),
    path.join(process.cwd(), 'images', 'icon.png'),
  ];
  for (const candidate of candidates) {
    try {
      const bytes = fs.readFileSync(candidate);
      defaultImageUri = `data:image/png;base64,${bytes.toString('base64')}`;
      return defaultImageUri;
    } catch (e) {
      // Try the next candidate.
    }
  }
  defaultImageUri = null;
  return null;
}

function setDefaultImage(context: string) {
  // Repaint first, then assert. setState alone is not enough to be sure the
  // overlay is gone, and setImage alone leaves the host's own state stale.
  setState(context, 0);
  const uri = loadDefaultImage();
  // With no readable default there is nothing safe to assert, so leave the key
  // alone rather than blanking it. The overlay still goes on the next rebuild.
  if (uri) setImage(context, uri);
}

/** Only Context URL keys carry an icon template. */
function isContextUrl(actionUuid: unknown): boolean {
  return typeof actionUuid === 'string' && actionUuid.endsWith('.contexturl');
}

/**
 * The open Property Inspector, if any.
 *
 * sendToPropertyInspector needs both the action and the context, and the host
 * only tells us which panel is open via propertyInspectorDidAppear — the same
 * latch shipped plugins on this host use.
 */
let openInspector: { action: string; context: string } | null = null;

function sendToPropertyInspector(context: string, payload: unknown) {
  if (!openInspector || openInspector.context !== context) return;
  send({
    event: 'sendToPropertyInspector',
    action: openInspector.action,
    context,
    payload,
  });
}

const iconController = new IconController({ setImage, setDefaultImage });

/** Tell the open panel what the key is showing and why. */
function reportIcon(context: string, outcome: IconOutcome) {
  // A superseded answer is about a template the panel has already moved on
  // from. Reporting it would flash a stale status during a fast retype.
  if (outcome.status === 'superseded') return;
  sendToPropertyInspector(context, {
    command: 'iconStatus',
    status: outcome.status,
    hostname: outcome.hostname,
    origin: outcome.origin,
    dataUri: outcome.dataUri,
  });
}

const titleFeedback = createTitleFeedback(setTitle);

async function handleMessage(msgStr: string) {
  try {
    const data = JSON.parse(msgStr);
    const { event, context, action } = data;

    /**
     * Icon lifecycle.
     *
     * The host rebuilds a key from the profile on every page entry, restart and
     * reconnect, which discards any overlay — so willAppear is where the icon is
     * (re)applied, not a one-time setup event. The controller answers from its
     * own memo when it can, so a re-appearance normally costs no request at all.
     */
    if (event === 'willAppear' && isContextUrl(action)) {
      const settings = data && data.payload ? data.payload.settings : undefined;
      reportIcon(context, await iconController.onWillAppear(context, settings));
      return;
    }

    if (event === 'willDisappear' && isContextUrl(action)) {
      iconController.onWillDisappear(context);
      return;
    }

    if (event === 'didReceiveSettings' && isContextUrl(action)) {
      const settings = data && data.payload ? data.payload.settings : undefined;
      reportIcon(context, await iconController.onDidReceiveSettings(context, settings));
      return;
    }

    if (event === 'propertyInspectorDidAppear' && isContextUrl(action)) {
      openInspector = { action, context };
      return;
    }

    if (event === 'propertyInspectorDidDisappear' && isContextUrl(action)) {
      if (openInspector && openInspector.context === context) openInspector = null;
      return;
    }

    /**
     * The panel's own requests.
     *
     * A Property Inspector is a file:// page with an opaque origin and no
     * bridge secret, so it cannot call the service itself. It asks the plugin,
     * which already holds both.
     */
    if (event === 'sendToPlugin' && isContextUrl(action)) {
      const payload = data && data.payload ? data.payload : {};
      // The panel is the authority on its own identity; the host does not
      // always tell us a panel appeared before it starts talking.
      openInspector = { action, context };
      if (payload.command === 'refreshIcon') {
        reportIcon(context, await iconController.refresh(context, payload.settings));
      } else if (payload.command === 'iconStatus') {
        reportIcon(context, await iconController.onDidReceiveSettings(context, payload.settings));
      }
      return;
    }

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
    // Every key will be replayed to us on reconnect, and no overlay survives
    // the gap, so held ownership and in-flight generations are dropped here.
    iconController.onDisconnect();
    // The panel does not survive the socket either; a stale latch would aim
    // sendToPropertyInspector at a panel that is no longer open.
    openInspector = null;
    setTimeout(() => connect(args), 3000);
  });

  ws.on('error', () => {});
}

if (require.main === module) {
  connect();
}
