import { BROWSER_MODES, BrowserMode, STORAGE_KEYS, loadBrowserRole, detectBrowserFamily } from './browserRole';

/**
 * The settings page for one browser profile.
 *
 * Deliberately small: a mode, a name, and enough status to answer "why is my
 * key showing that". Everything it writes goes to chrome.storage.local, which
 * is per-profile — syncing any of this would hand two browsers the same
 * identity and undo the separation it exists to create.
 */

const SERVICE_URL = 'http://127.0.0.1:17337';

const MODE_COPY: Record<BrowserMode, { name: string; why: string }> = {
  MEDIA_BROWSER: {
    name: 'Media browser',
    why: 'Publishes what you are watching. Your media keys keep working while this browser is in the background.',
  },
  WORK_BROWSER: {
    name: 'Work browser',
    why: 'Publishes the page you are on, and the project it belongs to. Does not touch media.',
  },
  HYBRID: {
    name: 'Both',
    why: 'Publishes media and work. Right for a single-browser setup.',
  },
  DISABLED: {
    name: 'Off',
    why: 'Publishes nothing from this browser.',
  },
};

const CHANNELS_BY_MODE: Record<BrowserMode, string> = {
  MEDIA_BROWSER: 'Media',
  WORK_BROWSER: 'Page, Project',
  HYBRID: 'Media, Page, Project',
  DISABLED: 'nothing',
};

function storage() {
  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      return new Promise((resolve) => chrome.storage.local.get(keys, (r) => resolve(r || {})));
    },
    async set(items: Record<string, unknown>): Promise<void> {
      return new Promise((resolve) => chrome.storage.local.set(items, () => resolve()));
    },
  };
}

function text(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function describeOwner(entry: any, instanceId: string): string {
  if (!entry) return 'none';
  const owner = entry.owner || {};
  const mine = owner.browserInstanceId === instanceId ? ' (this browser)' : '';
  const who = `${owner.displayName || 'unknown'}${mine}`;
  const value = entry.value || {};
  const what = value.projectName || value.canonicalTitle || value.rawTitle || value.url || '';
  return what ? `${who} — ${what}` : who;
}

async function refreshStatus(instanceId: string): Promise<void> {
  try {
    const res = await fetch(`${SERVICE_URL}/contexts`);
    if (!res.ok) throw new Error('bad status');
    const data = await res.json();
    text('service', 'connected');
    const contexts = data.contexts || {};
    text('chMedia', describeOwner(contexts.media, instanceId));
    text('chPage', describeOwner(contexts.page, instanceId));
    text('chProject', describeOwner(contexts.project, instanceId));
  } catch (e) {
    // Not running is a normal state, not an error to shout about.
    text('service', 'not reachable');
    text('chMedia', '—');
    text('chPage', '—');
    text('chProject', '—');
  }
}

async function main(): Promise<void> {
  const store = storage();
  const family = await detectBrowserFamily();
  // Reading settings must not look like a new connection to the service.
  const role = await loadBrowserRole(store, { family, bumpGeneration: false });

  text('instanceId', role.browserInstanceId);
  text('publishing', CHANNELS_BY_MODE[role.mode]);

  const modes = document.getElementById('modes');
  if (modes) {
    for (const mode of BROWSER_MODES) {
      const copy = MODE_COPY[mode];
      const label = document.createElement('label');
      label.className = 'mode';

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'mode';
      input.value = mode;
      input.checked = mode === role.mode;
      input.addEventListener('change', async () => {
        if (!input.checked) return;
        await store.set({ [STORAGE_KEYS.mode]: mode });
        text('publishing', CHANNELS_BY_MODE[mode]);
        text('saved', 'Saved.');
        /**
         * Tell the worker at once. Without this the change only takes effect on
         * the next browser event, and a browser switched to Off would keep
         * owning a channel until something happened to make it publish again.
         */
        try {
          chrome.runtime.sendMessage({ action: 'ROLE_CHANGED' });
        } catch (e) {
          // The worker will pick it up from storage on its next wake.
        }
        setTimeout(() => refreshStatus(role.browserInstanceId), 400);
      });

      const wrap = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'mode-name';
      name.textContent = copy.name;
      const why = document.createElement('div');
      why.className = 'mode-why';
      why.textContent = copy.why;
      wrap.appendChild(name);
      wrap.appendChild(why);

      label.appendChild(input);
      label.appendChild(wrap);
      modes.appendChild(label);
    }
  }

  const nameInput = document.getElementById('displayName') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.value = role.displayName;
    let timer: ReturnType<typeof setTimeout> | null = null;
    nameInput.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        const value = nameInput.value.trim().slice(0, 64);
        if (!value) return;
        await store.set({ [STORAGE_KEYS.displayName]: value });
        text('saved', 'Saved.');
        try {
          chrome.runtime.sendMessage({ action: 'ROLE_CHANGED' });
        } catch (e) {
          // Picked up on the next wake.
        }
      }, 300);
    });
  }

  await refreshStatus(role.browserInstanceId);
  setInterval(() => refreshStatus(role.browserInstanceId), 3000);
}

if (typeof document !== 'undefined') {
  void main();
}
