// Known podcasting interfaces: channel labels and which channels make good speaker tracks.
import type { ChannelLabel, DeviceProfile } from '../shared/types';

interface ProfileDef extends DeviceProfile {
  match: RegExp;
  /** Minimum input channels the device must expose for the profile to apply. */
  minInputs: number;
}

function mono(index: number, label: string, suggestTrack = false): ChannelLabel {
  return { index, label, suggestTrack };
}

function stereo(index: number, label: string, suggestTrack = false): ChannelLabel[] {
  return [
    { index, label: `${label} L`, stereoLeft: true, suggestTrack },
    { index: index + 1, label: `${label} R` },
  ];
}

const PROFILES: ProfileDef[] = [
  {
    id: 'rodecaster-pro-2',
    name: 'RØDECaster Pro II (multitrack)',
    match: /r(ø|o|0)decaster\s*pro\s*(ii|2)/i,
    minInputs: 16,
    // Channel order per RØDE's "RCPII Multitrack Guidelines".
    inputs: [
      ...stereo(0, 'Main Mix'),
      mono(2, 'Combo 1', true),
      mono(3, 'Combo 2', true),
      mono(4, 'Combo 3', true),
      mono(5, 'Combo 4', true),
      ...stereo(6, 'Bluetooth', true),
      ...stereo(8, 'SMART Pads'),
      ...stereo(10, 'USB Main', true),
      ...stereo(12, 'USB Chat', true),
      ...stereo(14, 'USB 2', true),
    ],
    outputs: [...stereo(0, 'USB Main')],
    note: 'Enable multitrack mode in the RØDECaster USB audio settings so all 16 channels appear.',
  },
  {
    id: 'rodecaster-duo',
    name: 'RØDECaster Duo (multitrack)',
    match: /r(ø|o|0)decaster\s*duo/i,
    minInputs: 14,
    inputs: [
      ...stereo(0, 'Main Mix'),
      mono(2, 'Combo 1', true),
      mono(3, 'Combo 2', true),
      ...stereo(4, 'Bluetooth', true),
      ...stereo(6, 'SMART Pads'),
      ...stereo(8, 'USB Main', true),
      ...stereo(10, 'USB Chat', true),
      ...stereo(12, 'USB 2', true),
    ],
    outputs: [...stereo(0, 'USB Main')],
    note: 'Channel layout assumed to mirror the Pro II without combos 3–4. Check and rename tracks if needed.',
  },
  {
    id: 'rodecaster-pro',
    name: 'RØDECaster Pro (multitrack)',
    match: /r(ø|o|0)decaster/i,
    minInputs: 14,
    inputs: [
      ...stereo(0, 'Main Mix'),
      mono(2, 'Mic 1', true),
      mono(3, 'Mic 2', true),
      mono(4, 'Mic 3', true),
      mono(5, 'Mic 4', true),
      ...stereo(6, 'USB', true),
      ...stereo(8, 'Smartphone', true),
      ...stereo(10, 'Bluetooth', true),
      ...stereo(12, 'Sound Pads'),
    ],
    outputs: [...stereo(0, 'USB')],
  },
  {
    id: 'zoom-podtrak-p8',
    name: 'Zoom PodTrak P8',
    match: /podtrak\s*p8/i,
    minInputs: 10,
    inputs: [
      ...Array.from({ length: 6 }, (_, i) => mono(i, `Mic ${i + 1}`, true)),
      ...stereo(6, 'Sound Pads'),
      ...stereo(8, 'Main Mix'),
    ],
    outputs: [...stereo(0, 'USB')],
  },
  {
    id: 'zoom-podtrak-p4',
    name: 'Zoom PodTrak P4',
    match: /podtrak\s*p4/i,
    minInputs: 2,
    inputs: [...stereo(0, 'Main Mix', true)],
    outputs: [...stereo(0, 'USB')],
  },
];

/** Generic profile: every channel mono, all suggested as tracks. */
export function genericProfile(inputs: number, outputs: number): DeviceProfile {
  return {
    id: 'generic',
    name: 'Generic interface',
    inputs: Array.from({ length: inputs }, (_, i) => mono(i, `Input ${i + 1}`, true)),
    outputs: Array.from({ length: outputs }, (_, i) => mono(i, `Output ${i + 1}`)),
  };
}

export function findProfile(deviceName: string, inputs: number, outputs: number): DeviceProfile {
  const def = PROFILES.find((p) => p.match.test(deviceName) && inputs >= p.minInputs);
  if (!def) return genericProfile(inputs, outputs);
  const { match: _m, minInputs: _n, ...profile } = def;
  // pad labels for channels the profile doesn't know about
  const known = new Set(profile.inputs.map((c) => c.index));
  for (let i = 0; i < inputs; i++) if (!known.has(i)) profile.inputs.push(mono(i, `Input ${i + 1}`));
  profile.inputs = profile.inputs.filter((c) => c.index < inputs).sort((a, b) => a.index - b.index);
  const knownOut = new Set(profile.outputs.map((c) => c.index));
  for (let i = 0; i < outputs; i++) if (!knownOut.has(i)) profile.outputs.push(mono(i, `Output ${i + 1}`));
  profile.outputs = profile.outputs.filter((c) => c.index < outputs).sort((a, b) => a.index - b.index);
  return profile;
}

export interface SuggestedTrack {
  name: string;
  inputChannels: number[];
}

/** Tracks to create in one click from a profile. */
export function suggestTracks(profile: DeviceProfile): SuggestedTrack[] {
  const out: SuggestedTrack[] = [];
  for (const ch of profile.inputs) {
    if (!ch.suggestTrack) continue;
    if (ch.stereoLeft) {
      out.push({ name: ch.label.replace(/ L$/, ''), inputChannels: [ch.index, ch.index + 1] });
    } else {
      out.push({ name: ch.label, inputChannels: [ch.index] });
    }
  }
  return out;
}
