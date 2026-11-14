const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const input = require('./input');
const { Net, generateCode, normalizeCode } = require('./net');

const DEFAULT_BROKER = 'mqtts://broker.hivemq.com:8883';
const PEER_TIMEOUT_MS = 12000;
const PTT_FAILSAFE_MS = 60000;

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const soundPath = () =>
  app.isPackaged
    ? path.join(process.resourcesPath, 'soundeffect.mp3')
    : path.join(__dirname, '..', 'soundeffect.mp3');

let settings = {
  micId: 'default',
  outId: '',
  sfxVolume: 1,
  ptt: null,
  name: os.hostname(),
  code: '',
  broker: DEFAULT_BROKER,
  allowRemote: false,
};

let win = null;
let muted = false;
let mutedBy = '';
let connStatus = 'off';
let pttTimer = null;
const net = new Net();
const peers = new Map(); // id -> { id, name, muted, allowRemote, lastSeen }

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    // first run or unreadable file: keep defaults
  }
}

function saveSettings() {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function peerList() {
  return [...peers.values()].map(({ id, name, muted, allowRemote }) => ({ id, name, muted, allowRemote }));
}

function publicState() {
  return { name: settings.name, muted, allowRemote: settings.allowRemote };
}

function startNet() {
  peers.clear();
  send('peers', peerList());
  net.start({ code: settings.code, broker: settings.broker || DEFAULT_BROKER, getState: publicState });
}

function pttUp() {
  clearTimeout(pttTimer);
  pttTimer = null;
  input.up();
}

function pttDown() {
  input.down(settings.ptt);
  // Never leave a key stuck down if the renderer fails to report the sound ending.
  clearTimeout(pttTimer);
  pttTimer = setTimeout(pttUp, PTT_FAILSAFE_MS);
}

function setMuted(next, by = '') {
  muted = next;
  mutedBy = next ? by : '';
  // A mute always (re)plays the sound effect, even if already muted.
  send('mute-state', { muted, mutedBy, play: next });
  net.sendState();
}

net.on('status', (s) => {
  connStatus = s;
  send('conn', s);
});

net.on('peer', (msg) => {
  peers.set(msg.from, {
    id: msg.from,
    name: String(msg.name || 'Duo').slice(0, 40),
    muted: !!msg.muted,
    allowRemote: !!msg.allowRemote,
    lastSeen: Date.now(),
  });
  send('peers', peerList());
});

net.on('bye', (id) => {
  if (peers.delete(id)) send('peers', peerList());
});

net.on('cmd', (msg) => {
  if (!settings.allowRemote) return;
  const by = peers.get(msg.from)?.name || 'your duo';
  if (msg.action === 'mute') setMuted(true, by);
  else if (msg.action === 'unmute') setMuted(false);
});

setInterval(() => {
  const cutoff = Date.now() - PEER_TIMEOUT_MS;
  let changed = false;
  for (const [id, p] of peers) {
    if (p.lastSeen < cutoff) {
      peers.delete(id);
      changed = true;
    }
  }
  if (changed) send('peers', peerList());
}, 3000);

ipcMain.handle('init', () => ({
  settings,
  muted,
  mutedBy,
  conn: connStatus,
  peers: peerList(),
  defaultBroker: DEFAULT_BROKER,
}));

ipcMain.handle('sound', () => {
  const buf = fs.readFileSync(soundPath());
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

ipcMain.handle('generate-code', () => generateCode());

ipcMain.handle('set-settings', (_e, patch) => {
  const before = settings;
  const next = { ...settings };
  for (const k of Object.keys(settings)) if (Object.hasOwn(patch, k)) next[k] = patch[k];
  next.code = normalizeCode(next.code);
  next.name = String(next.name || '').slice(0, 40) || os.hostname();
  next.broker = String(next.broker || '').trim() || DEFAULT_BROKER;
  if (next.ptt && !input.isValid(next.ptt)) next.ptt = null;
  settings = next;
  saveSettings();
  if (before.code !== next.code || before.broker !== next.broker) startNet();
  else net.sendState();
  return settings;
});

ipcMain.on('local-mute', (_e, on) => setMuted(!!on, on ? 'you (test)' : ''));
ipcMain.on('remote-cmd', (_e, { to, action }) => {
  if (action === 'mute' || action === 'unmute') net.sendCommand(String(to), action);
});
ipcMain.on('sfx-start', pttDown);
ipcMain.on('sfx-end', pttUp);

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 860,
    minWidth: 460,
    minHeight: 500,
    autoHideMenuBar: true,
    backgroundColor: '#10141c',
    title: 'DuoMuteLoL',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // Audio has to keep flowing while the window is minimised behind the game.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.DUOMUTE_DEBUG) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message));
  }
  win.on('closed', () => {
    win = null;
  });
}

if (!app.requestSingleInstanceLock() && !process.env.DUOMUTE_DEBUG) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    loadSettings();
    createWindow();
    startNet();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    pttUp();
    net.stop();
  });
}
