import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as os from 'os';

const repoRoot = process.cwd();
const sourceProfileDir = path.resolve(repoRoot, 'USEFUL v2.sdProfile');
const artifactPath = path.resolve(repoRoot, 'USEFUL v2.StreamDockProfile');
const bsdtar = 'C:\\Windows\\System32\\tar.exe';

function getAllJsonFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      results = results.concat(getAllJsonFiles(fullPath));
    } else if (file.endsWith('.json')) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * The same structural assertions apply to the loose .sdProfile source
 * directory AND to a fresh extraction of the packaged .StreamDockProfile
 * archive — a stale/malformed archive is exactly the regression that
 * previously shipped an old Website-action scene even though the source
 * directory itself was correct, so both must be checked independently.
 */
function validateProfileDirectory(profileDir: string) {
  const topManifestPath = path.join(profileDir, 'manifest.json');
  expect(fs.existsSync(topManifestPath)).toBe(true);

  const jsonFiles = getAllJsonFiles(profileDir);
  expect(jsonFiles.length).toBeGreaterThan(0);

  for (const jsonFile of jsonFiles) {
    const content = fs.readFileSync(jsonFile, 'utf8');
    expect(content).not.toContain('com.hotspot.streamdock.system.website');
    expect(content).not.toContain('com.mirabox.streamdock.emoji');
    expect(content).not.toContain('touchbar');
    expect(content).not.toContain('127.0.0.1');
    expect(content).not.toContain('secret');
  }

  const topManifest = JSON.parse(fs.readFileSync(topManifestPath, 'utf8'));

  expect(topManifest.Name).toBe('USEFUL v2');
  expect(topManifest.DeviceModel).toBe('20GBA9901');
  expect(topManifest.DeviceUUID).toBe('VSDN4Pro');
  expect(topManifest.Pages).toBeDefined();

  // Top-level (root) Actions MUST BE EMPTY!
  expect(Object.keys(topManifest.Actions || {}).length).toBe(0);

  const currentRel = topManifest.Pages.Current;
  expect(currentRel).toBeDefined();

  const childPageDir = path.join(profileDir, 'profiles', currentRel);
  const childManifestPath = path.join(childPageDir, 'manifest.json');
  expect(fs.existsSync(childPageDir)).toBe(true);
  expect(fs.existsSync(childManifestPath)).toBe(true);

  const childManifest = JSON.parse(fs.readFileSync(childManifestPath, 'utf8'));
  const actions = childManifest.Actions;
  expect(actions).toBeDefined();

  // TOP ROW
  expect(actions['0,1']?.UUID).toBe('com.lizard.switchaudio.toggle');
  expect(actions['0,1']?.Name).toBe('AUDIO FIX');
  expect(actions['1,1']?.UUID).toBe('com.hotspot.streamdock.obsstudio.record');
  expect(actions['1,1']?.Name).toBe('RECORD');
  expect(actions['2,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.imdb');
  expect(actions['2,1']?.Name).toBe('IMDb');
  expect(actions['3,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.cast');
  expect(actions['3,1']?.Name).toBe('CAST');
  expect(actions['4,1']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.justwatch');
  expect(actions['4,1']?.Name).toBe('JUSTWATCH');

  // BOTTOM ROW
  expect(actions['0,2']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.reddit');
  expect(actions['0,2']?.Name).toBe('REDDIT');
  expect(actions['1,2']?.UUID).toBe('com.cmarabate.streamdock.streamdockbridge.transcribe');
  expect(actions['1,2']?.Name).toBe('TRANSCRIBE');

  // Exactly seven actions total — no other buttons, no knobs, no touch bar
  expect(Object.keys(actions).sort()).toEqual(['0,1', '0,2', '1,1', '1,2', '2,1', '3,1', '4,1'].sort());
  expect(actions['2,2']).toBeUndefined();
  expect(actions['3,2']).toBeUndefined();
  expect(actions['4,2']).toBeUndefined();
  expect(actions['0,0']).toBeUndefined();
  expect(actions['1,0']).toBeUndefined();
  expect(actions['2,0']).toBeUndefined();
  expect(actions['3,0']).toBeUndefined();
  expect(actions['touchbar']).toBeUndefined();

  const actionIds = new Set<string>();
  for (const key of Object.keys(actions)) {
    const act = actions[key];

    if (act.ActionID) {
      expect(actionIds.has(act.ActionID)).toBe(false);
      actionIds.add(act.ActionID);
    }

    if (act.States && Array.isArray(act.States)) {
      for (const state of act.States) {
        if (state.Image) {
          const imgPathChild = path.join(childPageDir, state.Image);
          const imgPathTop = path.join(profileDir, state.Image);
          const exists = fs.existsSync(imgPathChild) || fs.existsSync(imgPathTop);
          expect(exists).toBe(true);
        }
      }
    }
  }
}

describe('USEFUL v2 Strict Recursive Profile Validation', () => {
  it('profile directory, top-level manifest.json, and canonical import package exist', () => {
    expect(fs.existsSync(sourceProfileDir)).toBe(true);
    expect(fs.existsSync(path.join(sourceProfileDir, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(artifactPath)).toBe(true);
  });

  it('validates the loose .sdProfile source directory', () => {
    validateProfileDirectory(sourceProfileDir);
  });
});

describe('USEFUL v2.StreamDockProfile packaged artifact', () => {
  let extractedDir: string;

  beforeAll(() => {
    // Regenerate the artifact from the canonical source so this test also
    // catches a committed artifact going stale relative to the source.
    execFileSync('node', [path.resolve(repoRoot, 'scripts/packageCleanProfile.js')], { cwd: repoRoot, stdio: 'ignore' });

    extractedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-profile-pkg-test-'));
    execFileSync(bsdtar, ['-xf', artifactPath, '-C', extractedDir], { stdio: 'ignore' });
  });

  afterAll(() => {
    if (extractedDir) fs.rmSync(extractedDir, { recursive: true, force: true });
  });

  it('is a real zip archive with no backslash-separated entries', () => {
    const listing = execFileSync(bsdtar, ['-tf', artifactPath]).toString('utf8');
    const entries = listing.split(/\r?\n/).filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry).not.toContain('\\');
    }
  });

  it('extracts to the exact same six-action structure as the canonical source', () => {
    validateProfileDirectory(extractedDir);
  });
});
