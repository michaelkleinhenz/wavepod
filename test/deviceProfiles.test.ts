import { describe, expect, it } from 'vitest';
import { findProfile, suggestTracks } from '../src/core/deviceProfiles';

describe('device profiles', () => {
  it('recognises the RØDECaster Pro II in multitrack mode', () => {
    for (const name of ['RØDECaster Pro II Multitrack', 'RODECaster Pro 2', 'hw:CARD=RODECasterProII']) {
      const p = findProfile(name.replace('ProII', 'Pro II'), 16, 2);
      expect(p.id).toBe('rodecaster-pro-2');
    }
    const p = findProfile('RØDECaster Pro II Multitrack', 16, 2);
    expect(p.inputs).toHaveLength(16);
    expect(p.inputs[2].label).toBe('Combo 1');
    expect(p.inputs[12].label).toBe('USB Chat L');
    const tracks = suggestTracks(p);
    expect(tracks.map((t) => t.name)).toEqual(['Combo 1', 'Combo 2', 'Combo 3', 'Combo 4', 'Bluetooth', 'USB Main', 'USB Chat', 'USB 2']);
    expect(tracks.find((t) => t.name === 'USB Chat')!.inputChannels).toEqual([12, 13]);
  });

  it('falls back to generic when the stereo-only endpoint is used', () => {
    const p = findProfile('RØDECaster Pro II Main', 2, 2);
    expect(p.id).toBe('generic');
    expect(suggestTracks(p)).toHaveLength(2);
  });

  it('labels unknown interfaces generically', () => {
    const p = findProfile('Scarlett 4i4', 4, 4);
    expect(p.inputs.map((c) => c.label)).toEqual(['Input 1', 'Input 2', 'Input 3', 'Input 4']);
  });
});
