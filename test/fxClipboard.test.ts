import { describe, expect, it } from 'vitest';
import { MASTER, addFx, fxList, updateFx } from '../src/core/fx/stack';
import { copyFilter, copyStack, pasteFilters, pasteSettings, settingsSource } from '../src/core/fx/fxClipboard';
import { addTrack, createProject } from '../src/core/project';
import type { Fx, Project } from '../src/shared/types';

function twoTracks(): { p: Project; a: string; b: string } {
  let p = addTrack(addTrack(createProject('Test')));
  const [a, b] = p.tracks.map((t) => t.id);
  p = addFx(p, a, 'highpass').project;
  p = addFx(p, a, 'compressor').project;
  const comp = fxList(p, a)[1];
  p = updateFx(p, a, comp.id, { params: { threshold: -30 }, enabled: false });
  return { p, a, b };
}

const vst = (id: string, state: string, value: number): Fx => ({
  id,
  type: 'vst3',
  enabled: true,
  params: { '7': value },
  plugin: { path: '/x/Plug.vst3', cid: 'ABCDEF0123456789ABCDEF0123456789', name: 'Plug', vendor: 'V' },
  paramInfo: [{ id: 7, title: 'Gain', units: '', steps: 0, default: 0.5, flags: 1 } as never],
  state,
});

describe('copying filters between tracks', () => {
  it('pastes a whole stack with new ids and the same settings', () => {
    const { p, a, b } = twoTracks();
    const clip = copyStack(p, a, 'Host')!;
    const q = pasteFilters(p, b, clip);
    const src = fxList(q, a);
    const dst = fxList(q, b);
    expect(dst.map((f) => f.type)).toEqual(['highpass', 'compressor']);
    expect(dst[1].params.threshold).toBe(-30);
    expect(dst[1].enabled).toBe(false);
    expect(dst.map((f) => f.id)).not.toEqual(src.map((f) => f.id));
    // pasting twice gives independent filters
    const r = pasteFilters(q, b, clip);
    expect(new Set(fxList(r, b).map((f) => f.id)).size).toBe(4);
  });

  it('the clipboard does not change when the source is edited later', () => {
    const { p, a, b } = twoTracks();
    const clip = copyStack(p, a, 'Host')!;
    const comp = fxList(p, a)[1];
    comp.params.threshold = -10; // mutate in place, as live slider edits do
    expect(fxList(pasteFilters(p, b, clip), b)[1].params.threshold).toBe(-30);
  });

  it('replaces a stack, inserts at the top, and works with the master bus', () => {
    const { p, a, b } = twoTracks();
    let q = addFx(p, b, 'limiter').project;
    const clip = copyStack(q, a, 'Host')!;
    expect(fxList(pasteFilters(q, b, clip, 'replace'), b).map((f) => f.type)).toEqual(['highpass', 'compressor']);
    expect(fxList(pasteFilters(q, b, clip, { index: 0 }), b).map((f) => f.type)).toEqual(['highpass', 'compressor', 'limiter']);
    q = pasteFilters(q, MASTER, copyFilter(fxList(q, b)[0], 'Guest'));
    expect(fxList(q, MASTER).map((f) => f.type)).toEqual(['limiter']);
    expect(copyStack(createProject('x'), MASTER, 'Master')).toBeNull();
  });

  it('pastes settings onto a filter of the same kind only, keeping its id and bypass', () => {
    const { p, a, b } = twoTracks();
    let q = addFx(p, b, 'compressor').project;
    q = addFx(q, b, 'limiter').project;
    const [comp, lim] = fxList(q, b);
    const clip = copyFilter(fxList(q, a)[1], 'Host');
    expect(settingsSource(clip, lim)).toBeNull();
    expect(settingsSource(clip, comp)).not.toBeNull();
    const r = pasteSettings(q, b, comp.id, clip);
    const after = fxList(r, b)[0];
    expect(after.id).toBe(comp.id);
    expect(after.enabled).toBe(true);
    expect(after.params.threshold).toBe(-30);
    expect(pasteSettings(q, b, lim.id, clip)).toBe(q);
  });

  it('keeps a VST3 plug-in state and parameter list', () => {
    let p = addTrack(addTrack(createProject('Test')));
    const [a, b] = p.tracks.map((t) => t.id);
    p = { ...p, tracks: p.tracks.map((t) => (t.id === a ? { ...t, fx: [vst('fx_a', 'U1RBVEU=', 0.8)] } : t.id === b ? { ...t, fx: [vst('fx_b', 'T1RIRVI=', 0.1)] } : t)) };
    const clip = copyFilter(fxList(p, a)[0], 'Host');
    const pasted = fxList(pasteFilters(p, b, clip), b)[1];
    expect(pasted.state).toBe('U1RBVEU=');
    expect(pasted.paramInfo).toHaveLength(1);
    expect(pasted.params['7']).toBe(0.8);
    const set = fxList(pasteSettings(p, b, 'fx_b', clip), b)[0];
    expect(set.id).toBe('fx_b');
    expect(set.state).toBe('U1RBVEU=');
    expect(set.params['7']).toBe(0.8);
    // a different plug-in does not take the settings
    const other = { ...vst('fx_c', 'x', 0), plugin: { ...vst('', '', 0).plugin!, cid: '00000000000000000000000000000000' } };
    expect(settingsSource(clip, other)).toBeNull();
  });
});
