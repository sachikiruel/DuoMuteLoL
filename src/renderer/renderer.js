/* global api */
const $ = (id) => document.getElementById(id);

const PTT_LEAD_S = 0.15; // hold the key briefly before the sound so voice chat is open
const PTT_TAIL_MS = 200; // and briefly after, so the end is not clipped

let settings = {};
let muted = false;
let mutedBy = '';
let soundBytes = null;

// ---------- audio pipeline: mic -> gain -> virtual cable, plus the sound effect ----------

let ctx = null;
let micStream = null;
let micGain = null;
let sfxGain = null;
let analyser = null;
let sfxBuffer = null;
let sfxSource = null;
let audioGeneration = 0;

function stopAudio() {
  stopSfx();
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (ctx) ctx.close();
  ctx = micStream = micGain = sfxGain = analyser = sfxBuffer = null;
}

async function startAudio() {
  const gen = ++audioGeneration;
  stopAudio();
  if (!settings.outId) {
    $('audioStatus').textContent = 'Choose a virtual microphone device to start.';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.micId ? { exact: settings.micId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (gen !== audioGeneration) return stream.getTracks().forEach((t) => t.stop());

    const c = new AudioContext({ latencyHint: 'interactive' });
    await c.setSinkId(settings.outId);
    if (gen !== audioGeneration) {
      stream.getTracks().forEach((t) => t.stop());
      return c.close();
    }

    ctx = c;
    micStream = stream;
    micGain = ctx.createGain();
    micGain.gain.value = muted ? 0 : 1;
    sfxGain = ctx.createGain();
    sfxGain.gain.value = settings.sfxVolume;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;

    const src = ctx.createMediaStreamSource(stream);
    src.connect(micGain);
    micGain.connect(analyser);
    micGain.connect(ctx.destination);
    sfxGain.connect(ctx.destination);

    sfxBuffer = await ctx.decodeAudioData(soundBytes.slice(0));
    $('audioStatus').textContent = 'Running: microphone is being sent to the virtual microphone.';
  } catch (err) {
    if (gen !== audioGeneration) return;
    stopAudio();
    $('audioStatus').textContent = 'Audio failed to start: ' + err.message;
  }
}

function stopSfx() {
  if (!sfxSource) return;
  sfxSource.onended = null;
  try {
    sfxSource.stop();
  } catch {
    // not started yet
  }
  sfxSource = null;
  api.sfxEnd();
}

function playSfx() {
  if (!ctx || !sfxBuffer) return;
  stopSfx();
  const source = ctx.createBufferSource();
  source.buffer = sfxBuffer;
  source.connect(sfxGain);
  source.onended = () => {
    if (sfxSource !== source) return;
    sfxSource = null;
    setTimeout(() => {
      // Skip the release if another play started during the tail.
      if (!sfxSource) api.sfxEnd();
    }, PTT_TAIL_MS);
  };
  sfxSource = source;
  api.sfxStart();
  source.start(ctx.currentTime + PTT_LEAD_S);
}

function applyMute() {
  if (micGain) micGain.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.01);
  const banner = $('banner');
  banner.textContent = muted ? `Muted by ${mutedBy || 'your duo'}` : 'Mic live';
  banner.className = 'banner ' + (muted ? 'muted' : 'live');
  $('level').className = muted ? 'muted' : '';
}

const levelData = new Float32Array(512);
function drawLevel() {
  let width = 0;
  if (analyser) {
    analyser.getFloatTimeDomainData(levelData);
    let peak = 0;
    for (const v of levelData) peak = Math.max(peak, Math.abs(v));
    width = Math.min(100, peak * 140);
  }
  $('level').style.width = width + '%';
}
setInterval(drawLevel, 60);

// ---------- devices ----------

function fillSelect(select, devices, selectedId, placeholder) {
  select.replaceChildren();
  if (placeholder) select.append(new Option(placeholder, ''));
  for (const d of devices) select.append(new Option(d.label || d.deviceId, d.deviceId));
  if (selectedId && !devices.some((d) => d.deviceId === selectedId)) {
    select.append(new Option('(saved device not connected)', selectedId));
  }
  select.value = selectedId || '';
}

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  // No "default" output: sending the mic to your own speakers is never what you want here.
  const outs = all.filter(
    (d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
  );
  if (!settings.outId) {
    const cable = outs.find((d) => /cable input|voicemeeter input/i.test(d.label));
    if (cable) settings = await api.setSettings({ outId: cable.deviceId });
  }
  fillSelect($('mic'), mics, settings.micId);
  fillSelect($('out'), outs, settings.outId, 'Choose…');
}

// ---------- push-to-talk binding ----------

const SIDED = { ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5 };
const EXTENDED = new Set([
  'ControlRight', 'AltRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete',
  'Home', 'End', 'PageUp', 'PageDown', 'NumpadEnter', 'NumpadDivide', 'MetaLeft', 'MetaRight',
]);
const MOUSE_BUTTONS = { 1: ['middle', 'Mouse middle'], 3: ['x1', 'Mouse 4'], 4: ['x2', 'Mouse 5'] };

let capturing = false;

function setCapturing(on) {
  capturing = on;
  $('pttSet').textContent = on ? 'Press a key… (Esc cancels)' : 'Set key';
}

async function savePtt(ptt) {
  setCapturing(false);
  settings = await api.setSettings({ ptt });
  $('pttLabel').textContent = settings.ptt ? settings.ptt.label : 'Not set';
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') return setCapturing(false);
    const vk = SIDED[e.code] || e.keyCode;
    if (!vk || vk === 229) return;
    const label = e.code.replace(/^Key|^Digit/, '') || e.key;
    savePtt({ type: 'key', vk, extended: EXTENDED.has(e.code), label });
  },
  true
);

window.addEventListener(
  'mousedown',
  (e) => {
    if (!capturing || !MOUSE_BUTTONS[e.button]) return;
    e.preventDefault();
    const [button, label] = MOUSE_BUTTONS[e.button];
    savePtt({ type: 'mouse', button, label });
  },
  true
);

// ---------- room / peers ----------

const CONN_TEXT = {
  off: 'off (enter a room code)',
  connecting: 'connecting…',
  connected: 'connected',
  error: 'cannot reach the relay server, retrying…',
};

function renderConn(status) {
  $('conn').textContent = CONN_TEXT[status] || status;
}

function renderPeers(peers) {
  $('peersEmpty').hidden = peers.length > 0;
  $('peers').replaceChildren(
    ...peers.map((p) => {
      const row = document.createElement('div');
      row.className = 'peer';

      const who = document.createElement('div');
      who.className = 'who';
      const name = document.createElement('b');
      name.textContent = p.name;
      const status = document.createElement('small');
      status.textContent = !p.allowRemote ? 'Remote control not enabled' : p.muted ? 'Muted' : 'Mic live';
      if (p.muted) status.className = 'muted';
      who.append(name, status);

      const mute = document.createElement('button');
      mute.className = 'danger';
      mute.textContent = p.muted ? 'Play sound again' : 'Mute + play sound';
      mute.disabled = !p.allowRemote;
      mute.onclick = () => api.remoteCmd(p.id, 'mute');

      const unmute = document.createElement('button');
      unmute.textContent = 'Unmute';
      unmute.disabled = !p.allowRemote || !p.muted;
      unmute.onclick = () => api.remoteCmd(p.id, 'unmute');

      row.append(who, mute, unmute);
      return row;
    })
  );
}

// ---------- wiring ----------

async function saveText(id, key) {
  settings = await api.setSettings({ [key]: $(id).value });
  $(id).value = settings[key];
}

async function main() {
  const init = await api.init();
  settings = init.settings;
  muted = init.muted;
  mutedBy = init.mutedBy;
  soundBytes = await api.sound();

  $('code').value = settings.code;
  $('name').value = settings.name;
  $('broker').value = settings.broker;
  $('broker').placeholder = init.defaultBroker;
  $('allowRemote').checked = settings.allowRemote;
  $('sfxVolume').value = settings.sfxVolume;
  $('pttLabel').textContent = settings.ptt ? settings.ptt.label : 'Not set';
  renderConn(init.conn);
  renderPeers(init.peers);
  applyMute();

  // Ask for the mic once so device names are visible, then list devices.
  try {
    (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach((t) => t.stop());
  } catch (err) {
    $('audioStatus').textContent = 'No microphone access: ' + err.message;
  }
  await refreshDevices();
  await startAudio();

  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await refreshDevices();
    await startAudio();
  });

  $('mic').onchange = async () => {
    settings = await api.setSettings({ micId: $('mic').value });
    startAudio();
  };
  $('out').onchange = async () => {
    settings = await api.setSettings({ outId: $('out').value });
    startAudio();
  };
  $('sfxVolume').oninput = () => {
    if (sfxGain) sfxGain.gain.value = Number($('sfxVolume').value);
  };
  $('sfxVolume').onchange = async () => {
    settings = await api.setSettings({ sfxVolume: Number($('sfxVolume').value) });
  };

  $('code').onchange = () => saveText('code', 'code');
  $('name').onchange = () => saveText('name', 'name');
  $('broker').onchange = () => saveText('broker', 'broker');
  $('codeGen').onclick = async () => {
    $('code').value = await api.generateCode();
    saveText('code', 'code');
  };
  $('codeCopy').onclick = () => navigator.clipboard.writeText($('code').value);
  $('allowRemote').onchange = async () => {
    settings = await api.setSettings({ allowRemote: $('allowRemote').checked });
  };

  $('pttSet').onclick = () => setCapturing(!capturing);
  $('pttClear').onclick = () => savePtt(null);

  $('testMute').onclick = () => api.localMute(true);
  $('testUnmute').onclick = () => api.localMute(false);

  api.onConn(renderConn);
  api.onPeers(renderPeers);
  api.onMuteState((s) => {
    muted = s.muted;
    mutedBy = s.mutedBy;
    applyMute();
    if (s.play) playSfx();
    else stopSfx();
  });
}

main();
