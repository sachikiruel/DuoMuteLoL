// Checks the remote link end to end against the real relay server:
// two clients sharing a code see each other and deliver a command; a client
// with a different code sees and delivers nothing.

const assert = require('node:assert');
const { Net, generateCode, seal, open, deriveKeys } = require('../src/net');

const BROKER = 'mqtts://broker.hivemq.com:8883';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Crypto round trip, and rejection under the wrong key or tampering.
  const a = deriveKeys('abc-def');
  const b = deriveKeys(' ABC-DEF ');
  const other = deriveKeys('zzz');
  assert.strictEqual(a.topic, b.topic, 'code is normalised');
  const sealed = seal(a.key, { hello: 1 });
  assert.deepStrictEqual(open(b.key, sealed), { hello: 1 });
  assert.strictEqual(open(other.key, sealed), null);
  sealed[sealed.length - 1] ^= 1;
  assert.strictEqual(open(a.key, sealed), null);
  console.log('ok  crypto');

  const code = generateCode();
  const host = new Net();
  const remote = new Net();
  const stranger = new Net();
  const got = { hostCmds: [], remotePeers: new Map(), strangerPeers: 0 };

  host.on('cmd', (m) => got.hostCmds.push(m.action));
  remote.on('peer', (m) => got.remotePeers.set(m.from, m));
  stranger.on('peer', () => got.strangerPeers++);

  host.start({ code, broker: BROKER, getState: () => ({ name: 'host', muted: false, allowRemote: true }) });
  remote.start({ code, broker: BROKER, getState: () => ({ name: 'remote', muted: false, allowRemote: false }) });
  stranger.start({ code: generateCode(), broker: BROKER, getState: () => ({ name: 'x' }) });

  for (let i = 0; i < 40 && !got.remotePeers.has(host.id); i++) await wait(500);
  assert.ok(got.remotePeers.has(host.id), 'remote sees host');
  assert.strictEqual(got.remotePeers.get(host.id).name, 'host');
  console.log('ok  peers discover each other');

  remote.sendCommand(host.id, 'mute');
  stranger.sendCommand(host.id, 'mute');
  for (let i = 0; i < 20 && got.hostCmds.length === 0; i++) await wait(250);
  await wait(1000);
  assert.deepStrictEqual(got.hostCmds, ['mute'], 'exactly one command, from the paired remote only');
  assert.strictEqual(got.strangerPeers, 0, 'stranger sees nobody');
  console.log('ok  command delivered; other room isolated');

  host.stop();
  remote.stop();
  stranger.stop();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FAIL', err);
    process.exit(1);
  }
);
