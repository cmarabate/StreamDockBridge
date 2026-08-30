const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const targetProfileDir = path.join(process.cwd(), 'USEFUL v2.sdProfile');

// Clean target directory completely
if (fs.existsSync(targetProfileDir)) {
  fs.rmSync(targetProfileDir, { recursive: true, force: true });
}
fs.mkdirSync(targetProfileDir, { recursive: true });

// This page UUID must never collide with a page UUID VSD Craft already has
// cached locally under %APPDATA%\HotSpot\StreamDock\profiles\<UUID>.sdProfile
// — the previous UUID (097635CA-2763-46C3-9426-2624F25805FD) collided with a
// stale local profile still holding the old generic Website/localhost
// actions, and VSD Craft appears to key its local profile store by that page
// UUID: importing a package whose UUID it already has locally reveals the
// stale cached content instead of the newly imported one. Regenerate a fresh
// UUID (rather than reusing this one) if this ever collides again.
const childProfileRelPath = 'F06684D5-1B0A-4D3B-8806-C74ED23C3C11.sdProfile';
const targetChildDir = path.join(targetProfileDir, 'profiles', childProfileRelPath);
fs.mkdirSync(targetChildDir, { recursive: true });

const topImagesDir = path.join(targetProfileDir, 'Images');
fs.mkdirSync(topImagesDir, { recursive: true });

const childImagesDir = path.join(targetChildDir, 'Images');
fs.mkdirSync(childImagesDir, { recursive: true });

// Copy distinct key art
const vsdImages = path.join('packages', 'vsd-plugin', 'images');
// useful_transcribe uses the plugin's own icon: there is no dedicated key art
// for this action yet, and inventing one is not this change's job.
['useful_audio_fix.png', 'useful_imdb.png', 'useful_cast.png', 'useful_justwatch.png', 'useful_reddit.png', 'useful_transcribe.png'].forEach((name, idx) => {
  const srcNames = ['audio_fix.png', 'imdb_key.png', 'cast_key.png', 'justwatch_key.png', 'reddit_key.png', 'icon.png'];
  fs.copyFileSync(path.join(vsdImages, srcNames[idx]), path.join(topImagesDir, name));
  fs.copyFileSync(path.join(vsdImages, srcNames[idx]), path.join(childImagesDir, name));
});

// Copy REAL native OBS record images from installed plugin
const nativeObsDir = 'C:/Program Files (x86)/VSD Craft/plugins/com.hotspot.streamdock.obsstudio.sdPlugin/Images/actions/record';
// Flat, one level under Images/ — matching the host. Across the 153 profile
// packages VSD Craft ships, the root Images/ directory holds 1074 files and
// ZERO subdirectories, and no States[].Image value nests deeper than one
// segment. The previous Images/actions/record/ layout had no host precedent.
if (fs.existsSync(nativeObsDir)) {
  [['on_N4pro.png', 'useful_record_on.png'], ['off_N4pro.png', 'useful_record_off.png']].forEach(([src, dest]) => {
    fs.copyFileSync(path.join(nativeObsDir, src), path.join(topImagesDir, dest));
    fs.copyFileSync(path.join(nativeObsDir, src), path.join(childImagesDir, dest));
  });
}

// 1. Top-level Manifest - Actions MUST BE EMPTY!
const topManifest = {
  Actions: {},
  DeviceModel: '20GBA9901',
  DeviceSerialNumber: '01E2D2782F04',
  DeviceUUID: 'VSDN4Pro',
  Name: 'USEFUL v2',
  Pages: {
    Current: childProfileRelPath,
    Pages: [childProfileRelPath]
  },
  Version: '1.0'
};
fs.writeFileSync(path.join(targetProfileDir, 'manifest.json'), JSON.stringify(topManifest, null, 4), 'utf8');

// 2. Child Page Manifest - Contains ONLY the 7 intended actions.
// Shape must match what VSD Craft itself emits; see the key notes below.
const childManifest = {
  Actions: {
    '0,1': {
      ActionID: '47541a7c-2d7d-4339-937e-d91908473a0a',
      Controller: 'Keypad',
      Name: 'AUDIO FIX',
      Settings: {
        deviceType: 'output',
        mode: 'selected',
        device1: 'Speakers',
        device1Name: 'Speakers (Realtek High Definition Audio)'
      },
      State: 0,
      States: [
        {
          Image: 'useful_audio_fix.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.lizard.switchaudio.toggle'
    },
    '1,1': {
      ActionID: '7eae3711-18bf-4745-a5a0-279a93cbb09d',
      Controller: 'Keypad',
      Name: 'RECORD',
      Settings: {},
      State: 1,
      States: [
        {
          Image: 'useful_record_on.png',
          Name: 'Start'
        },
        {
          Image: 'useful_record_off.png',
          Name: 'Stop'
        }
      ],
      UUID: 'com.hotspot.streamdock.obsstudio.record'
    },
    '2,1': {
      ActionID: '99f7511a-35c1-444a-9b02-7a243af7eb49',
      Controller: 'Keypad',
      Name: 'IMDb',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'useful_imdb.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.imdb'
    },
    '3,1': {
      ActionID: '71394053-f83d-47a6-9161-e4b09122774c',
      Controller: 'Keypad',
      Name: 'CAST',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'useful_cast.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.cast'
    },
    '4,1': {
      ActionID: '4481faca-8655-4b9e-bcb7-77d1a3b4dcab',
      Controller: 'Keypad',
      Name: 'JUSTWATCH',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'useful_justwatch.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.justwatch'
    },
    '0,2': {
      ActionID: '438af019-6283-4406-a55c-1d27ee7210ff',
      Controller: 'Keypad',
      Name: 'REDDIT',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'useful_reddit.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.reddit'
    },
    '1,2': {
      ActionID: '5c2f9d41-7a63-4b18-9e50-2b8d6f04a7c3',
      Controller: 'Keypad',
      Name: 'TRANSCRIBE',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'useful_transcribe.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.transcribe'
    }
  },
  // VSD Craft carries these on a PAGE manifest, not just the top-level one.
  // Surveyed across every profile package shipped with VSD Craft 3.10.202.0702
  // (153 packages, 341 page manifests): the page key set is invariably
  // Actions/DeviceModel/DeviceUUID/Name/Version, and page Name is always "".
  // A page that does not name its device cannot be bound to one, so emitting
  // them is required for conformance — but this is NOT established as the cause
  // of the silent import. No log line records our import at all.
  DeviceModel: '20GBA9901',
  DeviceUUID: 'VSDN4Pro',
  Name: '',
  Version: '1.0'
};

fs.writeFileSync(path.join(targetChildDir, 'manifest.json'), JSON.stringify(childManifest, null, 4), 'utf8');

// Package single canonical import artifact USEFUL v2.streamDockProfile
//
// PowerShell's Compress-Archive was used here previously and is the reason
// VSD Craft could not read the package: it (a) mixes backslash and forward-
// slash separators in entry names for top-level wildcard-matched items, and
// (b) omits explicit directory entries for nested folders. A genuine VSD
// Craft export (see defaultData/defaultProfiles/*.streamDockProfile) always
// writes an explicit forward-slash entry for every directory level. Windows'
// built-in bsdtar (System32\tar.exe, libarchive) reproduces that exactly, so
// use it instead of Compress-Archive — no new dependency required.
// Use the spelling the host itself uses: `.streamDockProfile` (lowercase s,
// capital D, capital P), as on all 153 packages the app ships.
//
// CANDIDATE CAUSE, not proven. VSD Craft.exe carries an accepted-suffix table
// for SDProfileManager::importProfile holding "streamDockProfile",
// "mkeyprofile", "SDProfile", "sdprofile", "monstardeckProfile" — and the
// SDProfile/sdprofile pair hints at a case-sensitive compare, which would make
// `.StreamDockProfile` match nothing and return silently. Counter-evidence:
// the Qt dialog filter offers `*.mKeyProfile`, which would never match the
// lowercase-only `mkeyprofile` entry under a case-sensitive compare. So the
// table is consistent with a case-INSENSITIVE match too, and the silent no-op
// has other untested explanations (page-UUID or profile-name collision with the
// local store, current-device scoping). Matching the host spelling is correct
// regardless; do not treat it as the established root cause until an import
// actually succeeds.
const targetArtifact = 'USEFUL v2.streamDockProfile';
const staleVariants = [
  'USEFUL v2.StreamDockProfile', // wrong-cased name that VSD Craft silently ignored
  'USEFUL v2.sdProfile.zip', // obsolete Compress-Archive intermediate; never write one again
];
if (fs.existsSync(targetArtifact)) fs.unlinkSync(targetArtifact);
for (const stale of staleVariants) {
  if (fs.existsSync(stale) && stale !== targetArtifact) fs.unlinkSync(stale);
}

const bsdtar = 'C:\\Windows\\System32\\tar.exe';
if (!fs.existsSync(bsdtar)) {
  throw new Error(`bsdtar not found at ${bsdtar} — required to package a VSD-Craft-compatible archive.`);
}
execSync(
  `"${bsdtar}" --format=zip -c -f "${targetArtifact}" -C "USEFUL v2.sdProfile" Images manifest.json profiles`,
  { stdio: 'inherit' }
);

console.log('Successfully created clean USEFUL v2 profile package & single canonical USEFUL v2.streamDockProfile import artifact!');
