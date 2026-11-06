import { describe, expect, it } from 'vitest';
import { clampVirtualAlsaDevices, friendlyStreamError, isVirtualAlsaDevice, throttleErrors, USE_PULSE_HINT } from '../src/main/audio/linuxAudio';
import type { AudioDevice } from '../src/shared/types';

const dev = (name: string, inputChannels: number, outputChannels: number): AudioDevice => ({
  id: 1,
  name,
  inputChannels,
  outputChannels,
  sampleRates: [48000],
  preferredSampleRate: 48000,
  isDefaultInput: false,
  isDefaultOutput: false,
});

describe('ALSA plug-in devices', () => {
  it('recognises the sound server plug-ins, not hardware', () => {
    expect(isVirtualAlsaDevice('Default ALSA Device')).toBe(true);
    expect(isVirtualAlsaDevice('PulseAudio Sound Server')).toBe(true);
    expect(isVirtualAlsaDevice('RODECaster Pro II (USB Audio)')).toBe(false);
  });

  it('uses the sound server default channel counts instead of the plug-in maximum', () => {
    const [d, hw] = clampVirtualAlsaDevices([dev('Default ALSA Device', 64, 64), dev('RODECaster Pro II (USB Audio)', 20, 4)], {
      inputChannels: 16,
      outputChannels: 2,
    });
    expect([d.inputChannels, d.outputChannels]).toEqual([16, 2]);
    expect([hw.inputChannels, hw.outputChannels]).toEqual([20, 4]);
  });

  it('falls back to stereo without a server, never adding channels', () => {
    const [d, mono] = clampVirtualAlsaDevices([dev('PulseAudio Sound Server', 32, 32), dev('Default ALSA Device', 1, 0)], null);
    expect([d.inputChannels, d.outputChannels]).toEqual([2, 2]);
    expect([mono.inputChannels, mono.outputChannels]).toEqual([1, 0]);
  });
});

describe('friendlyStreamError', () => {
  const readError = 'RtApiAlsa::callbackEvent: audio read error, Eingabe-/Ausgabefehler.';

  it('explains ALSA read errors and suggests PulseAudio when a server runs', () => {
    const msg = friendlyStreamError(readError, { api: 'alsa', serverRunning: true });
    expect(msg).toMatch(/^The input device stopped delivering audio\./);
    expect(msg).toContain(USE_PULSE_HINT);
    expect(msg).toContain(readError);
  });

  it('gives a general hint without a sound server', () => {
    expect(friendlyStreamError(readError, { api: 'alsa', serverRunning: false })).not.toContain(USE_PULSE_HINT);
  });

  it('leaves other messages alone', () => {
    expect(friendlyStreamError('RtApiPulse::callbackEvent: audio write error, x.', { api: 'pulse', serverRunning: true })).toBe(
      'RtApiPulse::callbackEvent: audio write error, x.',
    );
  });
});

describe('throttleErrors', () => {
  it('passes the same message on at most once per window', () => {
    let t = 0;
    const seen: string[] = [];
    const report = throttleErrors((m) => seen.push(m), 5000, () => t);
    report('a');
    report('a');
    report('b');
    t = 4999;
    report('a');
    t = 5000;
    report('a');
    expect(seen).toEqual(['a', 'b', 'a']);
  });
});
