import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFx } from '../src/core/fx/definitions';
import { addFx, fxList, updateFx } from '../src/core/fx/stack';
import { effectiveClipFx, groupClips, groupMembers, groupTarget, pruneClipFxGroups, resolveClipFxGroups, targetGroupId, ungroupClips } from '../src/core/fx/clipGroups';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { applyRenderedFuse, clipsToRender, fusePlan, isSeamlessFuse } from '../src/core/fuse';
import { writeWavFile } from '../src/core/wav';
import type { Clip, Project } from '../src/shared/types';
import { sine, tmpDir } from './helpers';

const SR = 48000;
const clip = (id: string, start: number, extra: Partial<Clip> = {}): Clip => ({ id, file: 'media/t.wav', start, offset: 0, length: SR, gain: 0, fadeIn: 0, fadeOut: 0, ...extra });
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Two tracks: a, b on the first, c on the second. */
function project(): Project {
  let p = addTrack(createProject('G', SR), { name: 'Host' });
  p = addTrack(p, { name: 'Guest' });
  p.tracks[0].clips.push(clip('a', 0), clip('b', SR * 2));
  p.tracks[1].clips.push(clip('c', SR));
  return p;
}

const clipOf = (p: Project, id: string) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id)!;

describe('group FX chains', () => {
  it('makes one chain for the selected clips, across tracks, and edits it as a filter target', () => {
    const r = groupClips(project(), ['a', 'c'])!;
    expect(r.action).toBe('created');
    expect(groupMembers(r.project, r.groupId).map((m) => m.clip.id)).toEqual(['a', 'c']);
    const target = groupTarget(r.groupId);
    expect(targetGroupId(target)).toBe(r.groupId);
    let p = addFx(r.project, target, 'highpass').project;
    const fx = fxList(p, target)[0];
    p = updateFx(p, target, fx.id, { params: { freq: 200 } });
    expect(fxList(p, target)[0].params.freq).toBe(200);
    // both clips play through it, the third one doesn't
    expect(effectiveClipFx(p, clipOf(p, 'a'))).toEqual([fxList(p, target)[0]]);
    expect(effectiveClipFx(p, clipOf(p, 'c'))).toEqual([fxList(p, target)[0]]);
    expect(effectiveClipFx(p, clipOf(p, 'b'))).toBeUndefined();
  });

  it('opens the shared group, adds ungrouped clips to it, and makes a new one across groups', () => {
    const first = groupClips(project(), ['a', 'c'])!;
    expect(groupClips(first.project, ['c', 'a'])).toMatchObject({ action: 'open', groupId: first.groupId, project: first.project });
    const added = groupClips(first.project, ['a', 'b'])!;
    expect(added.action).toBe('added');
    expect(added.groupId).toBe(first.groupId);
    expect(groupMembers(added.project, first.groupId)).toHaveLength(3);
    // a (first group) and b (second group) leave their groups for a new one
    const second = groupClips(ungroupClips(added.project, ['b', 'c']), ['b', 'c'])!;
    expect(second.action).toBe('created');
    const third = groupClips(second.project, ['a', 'b'])!;
    expect(third.action).toBe('created');
    expect(groupMembers(third.project, third.groupId).map((m) => m.clip.id)).toEqual(['a', 'b']);
    expect(groupMembers(third.project, second.groupId).map((m) => m.clip.id)).toEqual(['c']);
    // the first group has no clips left and is gone
    expect(third.project.clipFxGroups!.map((g) => g.id)).toEqual([second.groupId, third.groupId]);
    expect(groupClips(project(), ['a'])).toBeNull();
  });

  it('moves identical own clip filters into a new group so nothing sounds different', () => {
    const p = project();
    p.tracks[0].clips[0].fx = [createFx('highpass', { freq: 150 })];
    p.tracks[1].clips[0].fx = [createFx('highpass', { freq: 150 })];
    const r = groupClips(p, ['a', 'c'])!;
    expect(clipOf(r.project, 'a').fx).toBeUndefined();
    expect(fxList(r.project, groupTarget(r.groupId)).map((f) => f.params.freq)).toEqual([150]);
    // different own filters stay on the clips and run before the group's
    p.tracks[1].clips[0].fx = [createFx('deesser')];
    const r2 = groupClips(p, ['a', 'c'])!;
    expect(clipOf(r2.project, 'c').fx).toHaveLength(1);
    const withGroup = addFx(r2.project, groupTarget(r2.groupId), 'limiter').project;
    expect(effectiveClipFx(withGroup, clipOf(withGroup, 'c'))!.map((f) => f.type)).toEqual(['deesser', 'limiter']);
  });

  it('removes a clip from its group, and drops a group left without clips', () => {
    const r = groupClips(project(), ['a', 'c'])!;
    const one = ungroupClips(r.project, ['a']);
    expect(clipOf(one, 'a').fxGroup).toBeUndefined();
    expect(one.clipFxGroups).toHaveLength(1);
    const none = ungroupClips(one, ['c']);
    expect(none.clipFxGroups).toBeUndefined();
    expect(clipOf(none, 'c').fxGroup).toBeUndefined();
  });

  it('is saved with the episode and cleaned up when loading', () => {
    const r = groupClips(project(), ['a', 'c'])!;
    const p = addFx(r.project, groupTarget(r.groupId), 'highpass').project;
    const loaded = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(loaded.clipFxGroups).toEqual(p.clipFxGroups);
    expect(clipOf(loaded, 'a').fxGroup).toBe(r.groupId);
    // a clip pointing to a missing group, and a group no clip uses
    const broken = JSON.parse(JSON.stringify(p)) as Project;
    broken.tracks[0].clips[1].fxGroup = 'gone';
    broken.clipFxGroups!.push({ id: 'unused', fx: [] });
    const fixed = normalizeProject(broken);
    expect(clipOf(fixed, 'b').fxGroup).toBeUndefined();
    expect(fixed.clipFxGroups!.map((g) => g.id)).toEqual([r.groupId]);
    expect(pruneClipFxGroups(fixed)).toEqual(fixed);
  });

  it('renders the group chain on every member, and only on them', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/t.wav'), [sine(100, 1, SR, 0.3)], SR);
    // one clip per track, so each block shows one clip's sound
    let p = addTrack(addTrack(createProject('R', SR), { name: 'A' }), { name: 'B' });
    p.tracks[0].clips.push(clip('a', 0));
    p.tracks[1].clips.push(clip('b', SR * 2));
    p = addTrack(p, { name: 'C' });
    p.tracks[2].clips.push(clip('c', SR * 4));
    const r = groupClips(p, ['a', 'b'])!;
    // a steep high-pass far above the 100 Hz tone takes it nearly out
    p = addFx(r.project, groupTarget(r.groupId), 'highpass').project;
    const hp = fxList(p, groupTarget(r.groupId))[0];
    p = updateFx(p, groupTarget(r.groupId), hp.id, { params: { freq: 400, slope: 24 } });
    const level = (at: number) => {
      const mixer = new Mixer(p, new ReaderCache(dir));
      const out = [new Float32Array(4096), new Float32Array(4096)];
      mixer.render(at + SR / 2, 4096, out);
      mixer.readers.closeAll();
      return rms(out[0]);
    };
    const grouped = [level(0), level(SR * 2)];
    const plain = level(SR * 4);
    expect(plain).toBeGreaterThan(0.05);
    for (const g of grouped) expect(g).toBeLessThan(plain / 4);
    // the mixer sees the edited group without being rebuilt
    const mixer = new Mixer(p, new ReaderCache(dir));
    mixer.project = ungroupClips(p, ['a']);
    const out = [new Float32Array(4096), new Float32Array(4096)];
    mixer.render(SR / 2, 4096, out);
    mixer.readers.closeAll();
    expect(rms(out[0])).toBeGreaterThan(0.05);
    // the project itself is left alone
    expect(clipOf(p, 'a').fx).toBeUndefined();
    expect(clipOf(resolveClipFxGroups(p), 'a').fx).toHaveLength(1);
  });

  it('fusing clips of one group keeps the group instead of baking it in', () => {
    const r = groupClips(project(), ['a', 'b'])!;
    const [a, b] = r.project.tracks[0].clips;
    expect(fusePlan([a, b]).keepGroup).toBe(r.groupId);
    expect(clipsToRender([a, b], 0, SR * 3).every((c) => c.fxGroup === undefined)).toBe(true);
    const fused = applyRenderedFuse(r.project, ['a', 'b'], 'media/f.wav')!;
    expect(clipOf(fused.project, fused.clipId).fxGroup).toBe(r.groupId);
    // a grouped clip and an ungrouped one are no seamless continuation
    const next = { ...b, start: SR, offset: SR, fxGroup: undefined };
    expect(isSeamlessFuse([{ ...a }, next])).toBe(false);
    expect(isSeamlessFuse([{ ...a }, { ...next, fxGroup: a.fxGroup }])).toBe(true);
  });
});
