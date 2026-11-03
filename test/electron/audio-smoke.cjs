// Opens real RtAudio streams inside the Electron main process and checks that
// audio callbacks keep arriving. Guards against native-module bugs that only
// show up under Electron's allocator (see scripts/build-audify.mjs).
//
// Run: electron --no-sandbox test/electron/audio-smoke.cjs
// Needs audio devices; CI uses PulseAudio null sinks, one of them 16 channels
// wide so the multichannel (RØDECaster-style) path is covered too.
const { app } = require('electron');
const { RtAudio } = require('audify');

const FLOAT32 = 0x10;
const FRAMES = 512;
const RATE = 48000;
const PULSE = 4;

function openInput(api, device, channels, onError) {
  const rt = new RtAudio(api);
  const stats = { callbacks: 0, rt };
  rt.openStream(null, { deviceId: device.id, nChannels: channels, firstChannel: 0 }, FLOAT32, RATE, FRAMES, 'smoke-in',
    () => stats.callbacks++, null, 0, (_t, msg) => onError(`input: ${msg}`));
  rt.start();
  return stats;
}

function openOutput(api, device, channels, onError) {
  const rt = new RtAudio(api);
  const stats = { callbacks: 0, rt };
  let frames = FRAMES;
  // Frame callbacks can still arrive while the stream closes; a JS exception
  // escaping one aborts the process (see guard() in rtaudioBackend.ts).
  const write = () => {
    try {
      rt.write(Buffer.alloc(frames * channels * 4));
    } catch {
      /* closing */
    }
  };
  frames = rt.openStream({ deviceId: device.id, nChannels: channels, firstChannel: 0 }, null, FLOAT32, RATE, FRAMES, 'smoke-out',
    null, () => { stats.callbacks++; write(); }, 0, (_t, msg) => onError(`output: ${msg}`)) || FRAMES;
  rt.start();
  for (let i = 0; i < 3; i++) write();
  return stats;
}

function close(stats) {
  try {
    if (stats.rt.isStreamRunning()) stats.rt.stop();
    stats.rt.closeStream();
  } catch {
    /* already closed */
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const failures = [];
  const log = (m) => console.log(`audio-smoke: ${m}`);
  const onError = (m) => log(`stream error: ${m}`);

  const devices = new RtAudio().getDevices();
  const input = devices.find((d) => d.inputChannels > 0);
  const output = devices.find((d) => d.outputChannels > 0);
  if (!input || !output) throw new Error(`no input/output device found: ${JSON.stringify(devices)}`);

  // 1. Default API, mono in and stereo out, like a simple setup.
  let i = openInput(0, input, 1, onError);
  let o = openOutput(0, output, 2, onError);
  await wait(2000);
  log(`default API: ${i.callbacks} input and ${o.callbacks} output callbacks`);
  if (!i.callbacks || !o.callbacks) failures.push('default API streams got no callbacks');

  // 2. Reopen repeatedly, the way changing devices in Setup does.
  for (let n = 0; n < 5; n++) {
    close(i);
    close(o);
    i = openInput(0, input, 1, onError);
    o = openOutput(0, output, 2, onError);
    await wait(100);
  }
  close(i);
  close(o);

  // 3. PulseAudio with every channel of the widest input (16 on CI).
  const pulseDevices = new RtAudio(PULSE).getDevices();
  const wide = pulseDevices.filter((d) => d.inputChannels > 2).sort((a, b) => b.inputChannels - a.inputChannels)[0];
  if (wide) {
    let p;
    try {
      p = openInput(PULSE, wide, wide.inputChannels, onError);
      await wait(3000);
      log(`pulse "${wide.name}": ${wide.inputChannels} channels, ${p.callbacks} callbacks`);
      if (!p.callbacks) failures.push(`pulse ${wide.inputChannels}-channel input got no callbacks`);
    } catch (e) {
      failures.push(`pulse ${wide.inputChannels}-channel input failed to open: ${e.message}`);
    } finally {
      if (p) close(p);
    }
  } else {
    log('no PulseAudio input wider than 2 channels; skipping the multichannel check');
  }

  // 4. PulseAudio playback keeps up. With PulseAudio's default ~2 s buffer the
  // callbacks came in bursts and most of them found audify's queue empty, so
  // playback ran slow and crackled (see the audify patch). Count how much of the
  // audio the device played was actually supplied.
  const pulseOut = pulseDevices.find((d) => d.outputChannels > 0);
  if (pulseOut) {
    const rt = new RtAudio(PULSE);
    let frames = FRAMES;
    let written = 0;
    const write = () => {
      try {
        rt.write(Buffer.alloc(frames * 2 * 4));
        written += frames;
      } catch {
        /* closing */
      }
    };
    frames = rt.openStream({ deviceId: pulseOut.id, nChannels: 2, firstChannel: 0 }, null, FLOAT32, RATE, FRAMES, 'smoke-play',
      null, write, 0, (_t, msg) => onError(`playback: ${msg}`)) || FRAMES;
    rt.start();
    for (let n = 0; n < 3; n++) write();
    await wait(3000);
    const played = rt.streamTime * RATE;
    const supplied = Math.min(1, written / played);
    close({ rt });
    log(`pulse playback on "${pulseOut.name}": supplied ${(supplied * 100).toFixed(1)}% of ${Math.round(played)} played frames`);
    if (supplied < 0.95) failures.push(`pulse playback underran: only ${(supplied * 100).toFixed(1)}% of played audio was supplied`);
  }

  if (failures.length) throw new Error(failures.join('; '));
}

app.whenReady().then(() =>
  main().then(
    () => app.exit(0),
    (e) => {
      console.error(`audio-smoke: FAILED: ${e.message}`);
      app.exit(1);
    },
  ),
);
