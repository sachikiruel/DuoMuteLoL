# DuoMuteLoL

Remotely mute your duo's League Voice microphone

Both of you run the same app. Each app passes the real microphone through to a
virtual microphone that League uses. When someone in your room presses
**Mute + play sound** on you, your app silences your microphone, holds your
push-to-talk key, plays the sound effect into voice chat, releases the key, and
keeps you muted until you are unmuted.

## Setup (on each PC)

1. Install a virtual audio cable, e.g. [VB-CABLE](https://vb-audio.com/Cable/), and reboot if it asks.
2. Start DuoMuteLoL.
3. **Audio**: pick your real microphone, and pick the cable's playback side
   ("CABLE Input") as the virtual microphone. The level bar should move when you talk.
4. In League's voice settings, choose the cable's recording side ("CABLE Output") as your input device.
5. **Push-to-talk**: click *Set key* and press the same key you use for push-to-talk
   in League (keyboard keys, middle mouse, Mouse 4 and Mouse 5 work). Skip this if you use open mic.
6. **Room**: one of you clicks *Generate* and sends the code to the other, who pastes it in.
7. Tick **Let people in this room mute my mic** on the PC that should be mutable.

Your duo then appears under **Your duo** with the mute and unmute buttons.
*Test on this PC* runs the same mute locally so you can check the sound and key hold.

Keep the app running (minimised is fine) while you play. If it is closed, the
virtual microphone goes silent.

## How the remote link works

The apps meet on a public MQTT relay (`broker.hivemq.com` by default, changeable
under *Advanced*). The room code never leaves your PC: it derives both the
meeting topic and an AES-256-GCM key, so the relay only sees encrypted bytes and
only someone with the code can send a command. Treat the code like a password.

## Development

```
npm install
npm start        # run the app
npm test         # remote-link self-test against the relay
npm run dist     # build dist/DuoMuteLoL <version>.exe (portable) to send to your duo
```
