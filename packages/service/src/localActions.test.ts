import * as path from 'path';
import * as child_process from 'child_process';
import {
  executeLocalProjectAction,
  LOCAL_PROJECT_ACTIONS,
  findVsCodePath,
} from './localActions';

jest.mock('child_process', () => {
  const original = jest.requireActual('child_process');
  return {
    ...original,
    spawn: jest.fn(() => ({
      unref: jest.fn(),
      on: jest.fn((event, cb) => {
        if (event === 'close') cb(0);
      }),
      stdin: { end: jest.fn() },
    })),
  };
});

describe('Local Project Actions', () => {
  const testDir = path.resolve(__dirname, '../../..');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defines the approved closed actions enum', () => {
    expect(LOCAL_PROJECT_ACTIONS).toEqual([
      'OPEN_PROJECT_TERMINAL',
      'OPEN_PROJECT_FOLDER',
      'OPEN_PROJECT_IN_VSCODE',
      'COPY_PROJECT_PATH',
    ]);
  });

  it('rejects unapproved action intents', async () => {
    const res = await executeLocalProjectAction('RUN_COMMAND' as any, testDir);
    expect(res.success).toBe(false);
    expect(res.error).toBe('invalid_action');
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it('rejects missing or empty canonical path', async () => {
    const res = await executeLocalProjectAction('OPEN_PROJECT_TERMINAL', '');
    expect(res.success).toBe(false);
    expect(res.error).toBe('missing_project_path');
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it('rejects non-existent directory path', async () => {
    const res = await executeLocalProjectAction(
      'OPEN_PROJECT_TERMINAL',
      'D:\\_Dev\\NonExistentPathXYZ123'
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe('path_not_found');
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it('rejects file paths that are not directories', async () => {
    const filePath = path.resolve(__dirname, 'server.ts');
    const res = await executeLocalProjectAction('OPEN_PROJECT_TERMINAL', filePath);
    expect(res.success).toBe(false);
    expect(res.error).toBe('not_a_directory');
    expect(child_process.spawn).not.toHaveBeenCalled();
  });

  it('launches Windows Terminal for OPEN_PROJECT_TERMINAL with shell-free arguments', async () => {
    const res = await executeLocalProjectAction('OPEN_PROJECT_TERMINAL', testDir);
    expect(res.success).toBe(true);
    expect(child_process.spawn).toHaveBeenCalledWith(
      'wt.exe',
      ['-d', path.normalize(testDir)],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('launches explorer for OPEN_PROJECT_FOLDER', async () => {
    const res = await executeLocalProjectAction('OPEN_PROJECT_FOLDER', testDir);
    expect(res.success).toBe(true);
    expect(child_process.spawn).toHaveBeenCalledWith(
      'explorer.exe',
      [path.normalize(testDir)],
      expect.objectContaining({ detached: true, stdio: 'ignore' })
    );
  });

  it('launches VS Code for OPEN_PROJECT_IN_VSCODE', async () => {
    const res = await executeLocalProjectAction('OPEN_PROJECT_IN_VSCODE', testDir);
    expect(res.success).toBe(true);
    const vscodePath = findVsCodePath();
    expect(child_process.spawn).toHaveBeenCalledWith(
      vscodePath,
      [path.normalize(testDir)],
      expect.objectContaining({ detached: true })
    );
  });

  it('executes COPY_PROJECT_PATH via Set-Clipboard', async () => {
    const res = await executeLocalProjectAction('COPY_PROJECT_PATH', testDir);
    expect(res.success).toBe(true);
    expect(child_process.spawn).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-Command', '$input | Set-Clipboard'],
      expect.objectContaining({ windowsHide: true })
    );
  });
});
