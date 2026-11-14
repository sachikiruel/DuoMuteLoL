// Holds / releases the configured push-to-talk binding by injecting input via user32.
//
// Binding shapes:
//   { type: 'key',   vk: <Windows virtual-key code>, extended: bool, label }
//   { type: 'mouse', button: 'middle' | 'x1' | 'x2', label }

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const keybd_event = user32.func(
  'void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)'
);
const mouse_event = user32.func(
  'void __stdcall mouse_event(uint32_t dwFlags, uint32_t dx, uint32_t dy, uint32_t dwData, uintptr_t dwExtraInfo)'
);
const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t uCode, uint32_t uMapType)');
const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)');

const KEYEVENTF_EXTENDEDKEY = 0x1;
const KEYEVENTF_KEYUP = 0x2;

const MOUSE = {
  middle: { vk: 0x04, down: 0x0020, up: 0x0040, data: 0 },
  x1: { vk: 0x05, down: 0x0080, up: 0x0100, data: 1 },
  x2: { vk: 0x06, down: 0x0080, up: 0x0100, data: 2 },
};

function isValid(binding) {
  if (!binding) return false;
  if (binding.type === 'key') return Number.isInteger(binding.vk) && binding.vk > 0 && binding.vk < 256;
  if (binding.type === 'mouse') return Object.hasOwn(MOUSE, binding.button);
  return false;
}

function physicallyDown(binding) {
  const vk = binding.type === 'key' ? binding.vk : MOUSE[binding.button].vk;
  return (GetAsyncKeyState(vk) & 0x8000) !== 0;
}

function inject(binding, down) {
  if (binding.type === 'key') {
    const scan = MapVirtualKeyW(binding.vk, 0) & 0xff;
    let flags = binding.extended ? KEYEVENTF_EXTENDEDKEY : 0;
    if (!down) flags |= KEYEVENTF_KEYUP;
    keybd_event(binding.vk, scan, flags, 0);
  } else {
    const m = MOUSE[binding.button];
    mouse_event(down ? m.down : m.up, 0, 0, m.data, 0);
  }
}

// The binding we are currently holding down ourselves, if any.
let held = null;

function down(binding) {
  if (held || !isValid(binding)) return;
  // If the person is already holding the key, leave it alone: injecting our own
  // key-up afterwards would cut off their real key press.
  if (physicallyDown(binding)) return;
  inject(binding, true);
  held = binding;
}

function up() {
  if (!held) return;
  inject(held, false);
  held = null;
}

module.exports = { down, up, isValid };
