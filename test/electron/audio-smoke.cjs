// Opens real RtAudio input and output streams inside the Electron main process
// and checks that audio callbacks keep arriving. Guards against native-module
// crashes that only show up under Electron's allocator (see scripts/build-audify.mjs).
// Run: electron --no-sandbox test/electron/audio-smoke.cjs  (needs an audio device,
// e.g. a PulseAudio null sink on CI).
const { app } = require('electron');
const { RtAudio } = require('audify');

const FLOAT32 = 0x10;
const FRAMES = 512;

app.whenReady().then(() => {
  const probe = new RtAudio();
  const devices = probe.getDevices();
  const input = devices.find((d) => d.inputChannels > 0);
  const output = devices.find((d) => d.outputChannels > 0);
  if (!input || !output) {
    console.error('audio-smoke: no input/output device found', devices);
    app.exit(1);
    return;
  }

  let inputCallbacks = 0;
  let outputCallbacks = 0;
  const inStream = new RtAudio();
  inStream.openStream(null, { deviceId: input.id, nChannels: 1, firstChannel: 0 }, FLOAT32, 48000, FRAMES, 'smoke-in',
    () => inputCallbacks++, null, 0, (_t, msg) => console.error('input error:', msg));
  inStream.start();

  const outStream = new RtAudio();
  let frames = FRAMES;
  const write = () => outStream.write(Buffer.alloc(frames * 2 * 4));
  frames = outStream.openStream({ deviceId: output.id, nChannels: 2, firstChannel: 0 }, null, FLOAT32, 48000, FRAMES, 'smoke-out',
    null, () => { outputCallbacks++; write(); }, 0, (_t, msg) => console.error('output error:', msg)) || FRAMES;
  outStream.start();
  for (let i = 0; i < 3; i++) write();

  setTimeout(() => {
    console.log(`audio-smoke: ${inputCallbacks} input and ${outputCallbacks} output callbacks`);
    inStream.stop(); inStream.closeStream();
    outStream.stop(); outStream.closeStream();
    app.exit(inputCallbacks > 0 && outputCallbacks > 0 ? 0 : 1);
  }, 3000);
});
