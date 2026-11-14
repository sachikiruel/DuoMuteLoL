// Remote link between the two apps.
//
// Both apps connect to a public MQTT broker and meet on a topic derived from the
// shared room code. Every message is encrypted and authenticated (AES-256-GCM)
// with a key derived from the same code, so the broker and anyone else on it
// see only opaque bytes and cannot forge a command.

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const mqtt = require('mqtt');

const MAX_SKEW_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 4000;

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 5 === 4 && i < bytes.length - 1) out += '-';
  }
  return out;
}

function deriveKeys(code) {
  const c = normalizeCode(code);
  return {
    key: crypto.scryptSync(c, 'duomute-v1-key', 32),
    topic: 'duomute/v1/' + crypto.createHash('sha256').update('topic:' + c).digest('hex').slice(0, 32),
  };
}

function seal(key, obj) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

function open(key, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 29) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    return null;
  }
}

class Net extends EventEmitter {
  constructor() {
    super();
    this.id = crypto.randomBytes(8).toString('hex');
    this.client = null;
    this.key = null;
    this.topic = null;
    this.timer = null;
    this.getState = () => ({});
    this.seen = new Map(); // nonce hex -> expiry, to reject replayed messages
  }

  // getState() returns this app's current public state for heartbeats.
  start({ code, broker, getState }) {
    this.stop();
    if (!normalizeCode(code)) {
      this.emit('status', 'off');
      return;
    }
    ({ key: this.key, topic: this.topic } = deriveKeys(code));
    this.getState = getState;
    this.emit('status', 'connecting');

    const client = mqtt.connect(broker, {
      clientId: 'duomute-' + this.id,
      reconnectPeriod: 3000,
      connectTimeout: 10000,
      clean: true,
    });
    this.client = client;

    client.on('connect', () => {
      client.subscribe(this.topic, { qos: 0 }, (err) => {
        if (this.client !== client) return;
        if (err) return this.emit('status', 'error');
        this.emit('status', 'connected');
        this.sendState();
      });
    });
    client.on('close', () => this.client === client && this.emit('status', 'connecting'));
    client.on('error', () => this.client === client && this.emit('status', 'error'));
    client.on('message', (_topic, payload) => this.client === client && this.onMessage(payload));

    this.timer = setInterval(() => this.sendState(), HEARTBEAT_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.client) {
      const client = this.client;
      if (client.connected) this.publish({ t: 'bye' });
      this.client = null;
      client.end();
    }
  }

  publish(obj) {
    if (!this.client || !this.client.connected) return false;
    this.client.publish(this.topic, seal(this.key, { ...obj, from: this.id, ts: Date.now() }), { qos: 0 });
    return true;
  }

  sendState() {
    this.publish({ t: 'state', ...this.getState() });
  }

  sendCommand(to, action) {
    return this.publish({ t: 'cmd', to, action });
  }

  onMessage(payload) {
    const msg = open(this.key, payload);
    if (!msg || typeof msg !== 'object' || msg.from === this.id || typeof msg.from !== 'string') return;
    const now = Date.now();
    if (typeof msg.ts !== 'number' || Math.abs(now - msg.ts) > MAX_SKEW_MS) return;

    const nonce = payload.subarray(0, 12).toString('hex');
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return;
    this.seen.set(nonce, now + 2 * MAX_SKEW_MS);

    if (msg.t === 'state') this.emit('peer', msg);
    else if (msg.t === 'bye') this.emit('bye', msg.from);
    else if (msg.t === 'cmd' && msg.to === this.id) this.emit('cmd', msg);
  }
}

module.exports = { Net, generateCode, normalizeCode, deriveKeys, seal, open };
