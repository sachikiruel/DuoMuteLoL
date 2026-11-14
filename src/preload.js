const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, payload) => cb(payload));

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  sound: () => ipcRenderer.invoke('sound'),
  generateCode: () => ipcRenderer.invoke('generate-code'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  localMute: (muted) => ipcRenderer.send('local-mute', muted),
  remoteCmd: (to, action) => ipcRenderer.send('remote-cmd', { to, action }),
  sfxStart: () => ipcRenderer.send('sfx-start'),
  sfxEnd: () => ipcRenderer.send('sfx-end'),
  onMuteState: on('mute-state'),
  onPeers: on('peers'),
  onConn: on('conn'),
});
