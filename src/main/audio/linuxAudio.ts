// Linux specifics of RtAudio's ALSA and PulseAudio back ends.
//
// On a desktop with PipeWire or PulseAudio running, the sound server keeps the
// sound cards' hardware PCMs (hw:X,Y) open. RtAudio's ALSA probe skips busy
// devices, so the only ALSA devices left are the server's own plug-in PCMs
// ("default" and "pulse"). Those report a meaningless channel range (up to 32
// or 64 channels); opening a capture stream with that many channels makes the
// plug-in fail every read with EIO. The sound server's own API (PulseAudio,
// which PipeWire also speaks) reaches every device with its real channels.
import type { AudioDevice } from '../../shared/types';

/** RtAudio's names for the ALSA plug-in PCMs that route to the sound server. */
const VIRTUAL_ALSA_NAMES = new Set(['Default ALSA Device', 'PulseAudio Sound Server']);

export function isVirtualAlsaDevice(name: string): boolean {
  return VIRTUAL_ALSA_NAMES.has(name);
}

/** Most channels we ask of a plug-in PCM when the sound server can't tell us the real count. */
export const VIRTUAL_FALLBACK_CHANNELS = 2;

/**
 * Gives ALSA's plug-in PCMs ("default", "pulse") the channel count of the sound
 * server's default devices (or stereo) instead of the plug-in's maximum.
 */
export function clampVirtualAlsaDevices(
  devices: AudioDevice[],
  serverDefaults: { inputChannels: number; outputChannels: number } | null,
): AudioDevice[] {
  return devices.map((d) => {
    if (!isVirtualAlsaDevice(d.name)) return d;
    const cap = (have: number, want: number | undefined) => (have > 0 ? Math.min(have, want && want > 0 ? want : VIRTUAL_FALLBACK_CHANNELS) : 0);
    return {
      ...d,
      inputChannels: cap(d.inputChannels, serverDefaults?.inputChannels),
      outputChannels: cap(d.outputChannels, serverDefaults?.outputChannels),
    };
  });
}

export const USE_PULSE_HINT =
  'PipeWire/PulseAudio is running and keeps your sound cards to itself, so over ALSA they can only be reached through "Default ALSA Device" (no separate inputs). Choose "PulseAudio / PipeWire" as the audio driver to record every input of your interface.';

/**
 * Turns RtAudio's stream errors into a sentence a user can act on. RtAudio's
 * own text stays at the end (its OS part is localized, e.g. German), so it can
 * still be looked up.
 */
export function friendlyStreamError(message: string, opts: { api: string; serverRunning: boolean }): string {
  const alsaHint = opts.api === 'alsa' && opts.serverRunning ? ` ${USE_PULSE_HINT}` : '';
  if (/RtApiAlsa::callbackEvent: audio read error/.test(message)) {
    return `The input device stopped delivering audio.${alsaHint || ' Try another sample rate or buffer size, or another audio driver under Advanced.'} (${message})`;
  }
  if (/RtApiAlsa::callbackEvent: audio write error/.test(message) && !/underrun/.test(message)) {
    return `The output device stopped taking audio.${alsaHint || ' Try another sample rate or buffer size, or another audio driver under Advanced.'} (${message})`;
  }
  if (/RtApiAlsa::probeDeviceOpen/.test(message)) {
    return `${message}${alsaHint || ' The device may be in use by another program.'}`;
  }
  return message;
}

/**
 * Passes errors on, but the same message at most once per `windowMs`: a stream
 * in trouble reports the same error on every buffer.
 */
export function throttleErrors(onError: ((message: string) => void) | undefined, windowMs = 5000, now = () => Date.now()): (message: string) => void {
  const last = new Map<string, number>();
  return (message: string) => {
    if (!onError) return;
    const t = now();
    const prev = last.get(message);
    if (prev !== undefined && t - prev < windowMs) return;
    last.set(message, t);
    if (last.size > 50) last.clear();
    onError(message);
  };
}
