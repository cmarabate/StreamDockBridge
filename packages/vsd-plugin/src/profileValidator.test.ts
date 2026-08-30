import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as os from 'os';

const repoRoot = process.cwd();
const sourceProfileDir = path.resolve(repoRoot, 'USEFUL v2.sdProfile');
const artifactPath = path.resolve(repoRoot, 'USEFUL v2.streamDockProfile');
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
          // Package-local art is referenced by bare basename and resolves under
          // Images/. An "Images/<name>" value would instead name an app built-in.
          expect(state.Image).not.toContain('/');
          const imgPathChild = path.join(childPageDir, 'Images', state.Image);
          const imgPathTop = path.join(profileDir, 'Images', state.Image);
          const exists = fs.existsSync(imgPathChild) || fs.existsSync(imgPathTop);
          expect(exists).toBe(true);
        }
      }
    }
  }
}

/**
 * The shape VSD Craft itself emits.
 *
 * Established by surveying every profile package shipped with VSD Craft
 * 3.10.202.0702 under defaultData/defaultProfiles: 153 packages, 341 page
 * manifests, 2473 actions. The page key set below held for 341/341 with no
 * exceptions, page Name was "" in 341/341, and SoftwareSettings appeared on
 * 0/2473 actions.
 *
 * These assertions exist because the previous validator was self-referential:
 * it checked the generator's output against expectations derived from that
 * same generator, so a package that no host would accept still passed.
 *
 * They are deliberately STRICTER than the host corpus, not a description of it.
 * Applying them to the 153 shipped packages, only a minority pass: host
 * packages contain touchbar actions (a non-coordinate slot), multi-action
 * entries carrying an extra `Actions` key, and `Images/<name>` values that
 * reference app built-ins. We ship none of those — every image we reference is
 * a file we package — so the tighter rule is correct for us and would be wrong
 * as a claim about VSD Craft in general.
 */
const HOST_PAGE_MANIFEST_KEYS = ['Actions', 'DeviceModel', 'DeviceUUID', 'Name', 'Version'];
const HOST_ACTION_KEYS = ['ActionID', 'Controller', 'Name', 'Settings', 'State', 'States', 'UUID'];

function validateHostPageContract(profileDir: string) {
  const topManifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'manifest.json'), 'utf8'));
  const currentRel = topManifest.Pages?.Current;
  const pageManifestPath = path.join(profileDir, 'profiles', currentRel, 'manifest.json');
  const page = JSON.parse(fs.readFileSync(pageManifestPath, 'utf8'));

  // Exact key set — extra or missing keys both fail.
  expect(Object.keys(page).sort()).toEqual([...HOST_PAGE_MANIFEST_KEYS].sort());

  // The page must name the same device as the profile, or the host cannot bind it.
  expect(page.DeviceUUID).toBe(topManifest.DeviceUUID);
  expect(page.DeviceModel).toBe(topManifest.DeviceModel);
  expect(page.Version).toBe('1.0');
  expect(page.Name).toBe('');

  for (const [slot, action] of Object.entries<any>(page.Actions)) {
    // Required subset, not exact equality: host multi-action entries legitimately
    // carry an extra `Actions` key (18 of 2473, 16 of them VSDN4Pro touchbar
    // actions), so demanding an exact key set would misdescribe the host.
    for (const required of HOST_ACTION_KEYS) {
      expect(Object.keys(action)).toContain(required);
    }
    // No host action carries this; it is not part of the accepted shape.
    expect(action).not.toHaveProperty('SoftwareSettings');
    expect(typeof action.UUID).toBe('string');
    expect(action.UUID.length).toBeGreaterThan(0);
    // `touchbar` is a valid non-coordinate slot in the host corpus; we use none.
    expect(slot === 'touchbar' || /^-?\d+,-?\d+$/.test(slot)).toBe(true);

    for (const state of action.States || []) {
      if (!state.Image) continue;
      // A package-local image is a bare basename; the host resolves it under
      // Images/. Resolving every States[].Image in the 153 shipped packages
      // against its own zip: 970/970 bare basenames resolve to a packaged file,
      // and 0/845 separator-bearing values do — every one names an app or plugin
      // built-in. Writing "Images/foo.png" therefore points at a built-in that
      // does not exist, and the key renders blank.
      expect(state.Image).not.toContain('/');
    }
  }

  // Same rule expressed against the tree itself, in both image locations.
  for (const imagesDir of [
    path.join(profileDir, 'Images'),
    path.join(profileDir, 'profiles', currentRel, 'Images'),
  ]) {
    if (!fs.existsSync(imagesDir)) continue;
    const subdirs = fs
      .readdirSync(imagesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(subdirs).toEqual([]);
  }
}

describe('VSD Craft host page contract', () => {
  it('the loose source profile matches the shape VSD Craft emits', () => {
    validateHostPageContract(sourceProfileDir);
  });

  it('the packaged artifact matches the shape VSD Craft emits', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-host-contract-'));
    try {
      execFileSync(bsdtar, ['-xf', artifactPath, '-C', dir], { stdio: 'ignore' });
      validateHostPageContract(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Cross-check against a real host package when one is present. Skipped rather
   * than failed off this machine, since it depends on the VSD Craft install.
   */
  it('agrees with a profile package authored by VSD Craft itself', () => {
    const hostPackage = path.join(
      'C:/Program Files (x86)/VSD Craft/defaultData/defaultProfiles/VSDN4Pro/en',
      'one.streamDockProfile'
    );
    if (!fs.existsSync(hostPackage)) {
      // Depends on a local VSD Craft install. Passing silently off-machine would
      // be indistinguishable from a real check, so say so.
      console.warn('skipped: VSD Craft host package not present on this machine');
      return;
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdb-host-sample-'));
    try {
      execFileSync(bsdtar, ['-xf', hostPackage, '-C', dir], { stdio: 'ignore' });
      const top = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const pageDir = path.join(dir, 'profiles', top.Pages.Current);
      const page = JSON.parse(fs.readFileSync(path.join(pageDir, 'manifest.json'), 'utf8'));
      expect(Object.keys(page).sort()).toEqual([...HOST_PAGE_MANIFEST_KEYS].sort());
      expect(page.Name).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

describe('USEFUL v2.streamDockProfile packaged artifact', () => {
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

  /**
   * VSD Craft.exe's accepted-suffix table for SDProfileManager::importProfile
   * lists "SDProfile" and "sdprofile" as separate entries, which is only
   * necessary if the suffix comparison is case-sensitive; all 153 packages it
   * ships are spelled `.streamDockProfile`. A `.StreamDockProfile` file matched
   * nothing and the importer returned silently, with no error dialog.
   */
  it('ships exactly one import artifact, spelled the way the host spells it', () => {
    // Asserting the hardcoded artifactPath against itself would be vacuous, so
    // check the repository root: exactly one profile package must exist, and it
    // must carry the host's spelling. A stale `.StreamDockProfile` left beside
    // it is the specific mistake this guards — the owner would have no way to
    // tell the two apart in a file dialog.
    const packages = fs
      .readdirSync(repoRoot)
      .filter((f) => f.toLowerCase().endsWith('.streamdockprofile'));

    expect(packages).toEqual(['USEFUL v2.streamDockProfile']);
    expect(fs.existsSync(artifactPath)).toBe(true);
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
