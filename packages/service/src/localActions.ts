import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

export type LocalProjectAction =
  | 'OPEN_PROJECT_TERMINAL'
  | 'OPEN_PROJECT_FOLDER'
  | 'OPEN_PROJECT_IN_VSCODE'
  | 'COPY_PROJECT_PATH';

export const LOCAL_PROJECT_ACTIONS: LocalProjectAction[] = [
  'OPEN_PROJECT_TERMINAL',
  'OPEN_PROJECT_FOLDER',
  'OPEN_PROJECT_IN_VSCODE',
  'COPY_PROJECT_PATH',
];

export interface LocalActionResult {
  success: boolean;
  action: LocalProjectAction;
  targetPath: string;
  error?: string;
}

export function findVsCodePath(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'),
    path.join(localAppData, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd',
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'code.cmd'; // Fallback to PATH lookup
}

export async function executeLocalProjectAction(
  action: LocalProjectAction,
  canonicalPath: string | null | undefined
): Promise<LocalActionResult> {
  if (!action || !LOCAL_PROJECT_ACTIONS.includes(action)) {
    return { success: false, action, targetPath: '', error: 'invalid_action' };
  }

  if (!canonicalPath || typeof canonicalPath !== 'string') {
    return { success: false, action, targetPath: '', error: 'missing_project_path' };
  }

  const normalized = path.normalize(canonicalPath);
  if (!fs.existsSync(normalized)) {
    return { success: false, action, targetPath: normalized, error: 'path_not_found' };
  }

  try {
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return { success: false, action, targetPath: normalized, error: 'not_a_directory' };
    }
  } catch (e) {
    return { success: false, action, targetPath: normalized, error: 'unreadable_path' };
  }

  try {
    switch (action) {
      case 'OPEN_PROJECT_TERMINAL': {
        const proc = spawn('wt.exe', ['-d', normalized], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        proc.unref();
        return { success: true, action, targetPath: normalized };
      }

      case 'OPEN_PROJECT_FOLDER': {
        const proc = spawn('explorer.exe', [normalized], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        proc.unref();
        return { success: true, action, targetPath: normalized };
      }

      case 'OPEN_PROJECT_IN_VSCODE': {
        const vscodeBin = findVsCodePath();
        if (!vscodeBin) {
          return { success: false, action, targetPath: normalized, error: 'vscode_not_found' };
        }
        const proc = spawn(vscodeBin, [normalized], {
          detached: true,
          stdio: 'ignore',
          shell: vscodeBin.endsWith('.cmd'),
        });
        proc.unref();
        return { success: true, action, targetPath: normalized };
      }

      case 'COPY_PROJECT_PATH': {
        await setClipboardText(normalized);
        return { success: true, action, targetPath: normalized };
      }

      default:
        return { success: false, action, targetPath: normalized, error: 'unsupported_action' };
    }
  } catch (e: any) {
    return { success: false, action, targetPath: normalized, error: e?.message || 'execution_failed' };
  }
}

function setClipboardText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('powershell.exe', ['-NoProfile', '-Command', '$input | Set-Clipboard'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Set-Clipboard exited with ${code}`));
    });
    proc.on('error', reject);
    try {
      proc.stdin?.write(text);
      proc.stdin?.end();
    } catch (e) {
      reject(e);
    }
  });
}
