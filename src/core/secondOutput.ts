// Where the second output can go: another pair of the device you listen on, or any pair of another
// output device (a USB headset, a second sound card, a virtual cable into a call app).

import type { AudioDevice, DeviceConfig } from '../shared/types';

/** "Send to" choices, as "main:<first channel>" (the listening device) or "<device id>:<first channel>". */
export function secondOutputChoices(devices: AudioDevice[], cfg: DeviceConfig): Array<{ value: string; label: string }> {
  const pairs = (n: number) => Array.from({ length: Math.max(1, Math.floor(n / 2)) }, (_, i) => i * 2);
  const pairLabel = (ch: number) => `Outputs ${ch + 1} and ${ch + 2}`;
  const main = devices.find((d) => d.outputChannels > 0 && d.id === cfg.outputDeviceId);
  const out: Array<{ value: string; label: string }> = [];
  if (main) {
    for (const ch of pairs(main.outputChannels)) {
      if (ch !== cfg.outputFirstChannel && ch + 1 < main.outputChannels) out.push({ value: `main:${ch}`, label: pairLabel(ch) });
    }
  }
  for (const d of devices) {
    if (d.outputChannels <= 0 || d.id === main?.id) continue;
    for (const ch of pairs(d.outputChannels)) {
      out.push({ value: `${d.id}:${ch}`, label: d.outputChannels > 2 ? `${d.name}: ${pairLabel(ch)}` : d.name });
    }
  }
  return out;
}

/** The "Send to" value of the current second output. */
export function secondOutputValue(cfg: DeviceConfig): string {
  const dev = cfg.output2DeviceId;
  return `${dev === null || dev === undefined || dev === cfg.outputDeviceId ? 'main' : dev}:${cfg.output2FirstChannel ?? 0}`;
}
