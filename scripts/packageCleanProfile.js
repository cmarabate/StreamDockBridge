const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

function generateActionId() {
  return crypto.randomUUID().toLowerCase();
}

const targetProfileDir = path.join(process.cwd(), 'USEFUL v2.sdProfile');

// Clean target directory completely
if (fs.existsSync(targetProfileDir)) {
  fs.rmSync(targetProfileDir, { recursive: true, force: true });
}
fs.mkdirSync(targetProfileDir, { recursive: true });

const childProfileRelPath = '097635CA-2763-46C3-9426-2624F25805FD.sdProfile';
const targetChildDir = path.join(targetProfileDir, 'profiles', childProfileRelPath);
fs.mkdirSync(targetChildDir, { recursive: true });

const topImagesDir = path.join(targetProfileDir, 'Images');
fs.mkdirSync(topImagesDir, { recursive: true });

const childImagesDir = path.join(targetChildDir, 'Images');
fs.mkdirSync(childImagesDir, { recursive: true });

const topRecordDir = path.join(topImagesDir, 'actions', 'record');
fs.mkdirSync(topRecordDir, { recursive: true });

const childRecordDir = path.join(childImagesDir, 'actions', 'record');
fs.mkdirSync(childRecordDir, { recursive: true });

// Copy distinct key art
const vsdImages = path.join('packages', 'vsd-plugin', 'images');
['useful_audio_fix.png', 'useful_imdb.png', 'useful_cast.png', 'useful_justwatch.png', 'useful_reddit.png'].forEach((name, idx) => {
  const srcNames = ['audio_fix.png', 'imdb_key.png', 'cast_key.png', 'justwatch_key.png', 'reddit_key.png'];
  fs.copyFileSync(path.join(vsdImages, srcNames[idx]), path.join(topImagesDir, name));
  fs.copyFileSync(path.join(vsdImages, srcNames[idx]), path.join(childImagesDir, name));
});

// Copy REAL native OBS record images from installed plugin
const nativeObsDir = 'C:/Program Files (x86)/VSD Craft/plugins/com.hotspot.streamdock.obsstudio.sdPlugin/Images/actions/record';
if (fs.existsSync(nativeObsDir)) {
  fs.copyFileSync(path.join(nativeObsDir, 'on_N4pro.png'), path.join(topRecordDir, 'on.png'));
  fs.copyFileSync(path.join(nativeObsDir, 'off_N4pro.png'), path.join(topRecordDir, 'off.png'));
  fs.copyFileSync(path.join(nativeObsDir, 'on_N4pro.png'), path.join(childRecordDir, 'on.png'));
  fs.copyFileSync(path.join(nativeObsDir, 'off_N4pro.png'), path.join(childRecordDir, 'off.png'));
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

// 2. Child Page Manifest - Contains ONLY the 6 intended actions
const childManifest = {
  Actions: {
    '0,1': {
      ActionID: generateActionId(),
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
          Image: 'Images/useful_audio_fix.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.lizard.switchaudio.toggle'
    },
    '1,1': {
      ActionID: generateActionId(),
      Controller: 'Keypad',
      Name: 'RECORD',
      Settings: {},
      SoftwareSettings: {},
      State: 1,
      States: [
        {
          Image: 'Images/actions/record/on.png',
          Name: 'Start'
        },
        {
          Image: 'Images/actions/record/off.png',
          Name: 'Stop'
        }
      ],
      UUID: 'com.hotspot.streamdock.obsstudio.record'
    },
    '2,1': {
      ActionID: generateActionId(),
      Controller: 'Keypad',
      Name: 'IMDb',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'Images/useful_imdb.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.imdb'
    },
    '3,1': {
      ActionID: generateActionId(),
      Controller: 'Keypad',
      Name: 'CAST',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'Images/useful_cast.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.cast'
    },
    '4,1': {
      ActionID: generateActionId(),
      Controller: 'Keypad',
      Name: 'JUSTWATCH',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'Images/useful_justwatch.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.justwatch'
    },
    '0,2': {
      ActionID: generateActionId(),
      Controller: 'Keypad',
      Name: 'REDDIT',
      Settings: {},
      State: 0,
      States: [
        {
          Image: 'Images/useful_reddit.png',
          ShowTitle: false,
          Title: '',
          TitleAlignment: 'bottom'
        }
      ],
      UUID: 'com.cmarabate.streamdock.streamdockbridge.reddit'
    }
  },
  Name: 'USEFUL v2'
};

fs.writeFileSync(path.join(targetChildDir, 'manifest.json'), JSON.stringify(childManifest, null, 4), 'utf8');

// Package single canonical import artifact USEFUL v2.StreamDockProfile
if (fs.existsSync('USEFUL v2.StreamDockProfile')) fs.unlinkSync('USEFUL v2.StreamDockProfile');
if (fs.existsSync('USEFUL v2.sdProfile.zip')) fs.unlinkSync('USEFUL v2.sdProfile.zip');

execSync('powershell "Compress-Archive -Path \'USEFUL v2.sdProfile\\*\' -DestinationPath \'USEFUL v2.sdProfile.zip\' -Force"', { stdio: 'inherit' });
fs.copyFileSync('USEFUL v2.sdProfile.zip', 'USEFUL v2.StreamDockProfile');
fs.unlinkSync('USEFUL v2.sdProfile.zip');

console.log('Successfully created clean USEFUL v2 profile package & single canonical USEFUL v2.StreamDockProfile import artifact!');
