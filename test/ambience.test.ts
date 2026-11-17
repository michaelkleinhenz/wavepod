import { describe, expect, it } from 'vitest';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { createScript, parseScript, replaceScript } from '../src/core/script';
import {
  AMBIENCE_TRACK_NAME,
  BED_FADE_SECONDS,
  BED_LEAD_SECONDS,
  BED_TAIL_SECONDS,
  bedClips,
  bedOwners,
  bedSpans,
  bedSummary,
  bedsStale,
  carryBeds,
  layBeds,
  planBeds,
  removeBeds,
  setBedFade,
  setBedGain,
  setSceneBed,
  unplacedBeds,
} from '../src/core/ambience';
import { readClip } from '../src/core/clipSound';
import type { Project, SceneBed } from '../src/shared/types';

const SR = 48000;
const s = (sec: number) => Math.round(sec * SR);

const SCRIPT = `Title: Night Train
# Act One
INT. FOREST - NIGHT
ANNA: Where are we?
BEN: Lost.
INT. TAVERN - NIGHT
ANNA: Two beers.
BEN: Make it three.
INT. STATION - DAWN
ANNA: There it is.`;

const forest: SceneBed = { file: 'media/forest.wav', length: s(10), name: 'Forest night', gain: -12 };
const tavern: SceneBed = { file: 'media/tavern.wav', length: s(8), name: 'Tavern crowd', gain: -10 };

/** A project with the script and the lines ticked at these times (seconds, 2 s each). */
function project(times: number[]): Project {
  let p = createProject('Drama', SR);
  p = addTrack(p, { name: 'Anna' });
  p = addTrack(p, { name: 'Ben' });
  const script = createScript(p, parseScript(SCRIPT, 'night.txt'), 'night.txt');
  let k = 0;
  script.lines = script.lines.map((l) => (l.kind === 'dialogue' && k < times.length ? { ...l, recorded: true, take: { from: s(times[k]), to: s(times[k++] + 2) } } : l));
  return { ...p, script };
}

const heading = (p: Project, text: string) => p.script!.lines.find((l) => l.kind === 'scene' && l.text.startsWith(text))!;

describe('scene ambience beds', () => {
  it('finds the bed of each line: the scene’s own, else its act’s', () => {
    let p = project([]);
    const act = heading(p, 'Act One');
    const tav = heading(p, 'INT. TAVERN');
    p = { ...p, script: { ...p.script!, beds: { [act.id]: forest, [tav.id]: tavern } } };
    const owners = bedOwners(p.script!);
    const lines = p.script!.lines;
    const ownerOf = (text: string) => lines[owners[lines.findIndex((l) => l.text === text)]]?.text;
    expect(ownerOf('Where are we?')).toBe('Act One');
    expect(ownerOf('Two beers.')).toBe('INT. TAVERN - NIGHT');
    expect(ownerOf('There it is.')).toBe('Act One');
  });

  it('loops one clip under each scene and crossfades into the next', () => {
    // forest lines at 10 s and 14 s, tavern at 30 s and 33 s, station at 50 s
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. FOREST').id, forest);
    p = setSceneBed(p, heading(p, 'INT. TAVERN').id, tavern);
    const beds = bedClips(p);
    expect(beds).toHaveLength(2);
    const track = p.tracks.find((t) => t.name === AMBIENCE_TRACK_NAME)!;
    expect(track.stem).toBe('effects');
    expect(beds.every((b) => b.track.id === track.id)).toBe(true);
    const [a, b] = beds.map((x) => x.clip).sort((x, y) => x.start - y.start);
    const xf = s(BED_FADE_SECONDS);
    // forest: from a second before its first line to the tavern, overlapping it by half the crossfade
    expect(a.start).toBe(s(10 - BED_LEAD_SECONDS));
    const boundary = s(30 - BED_LEAD_SECONDS);
    expect(a.start + a.length).toBe(boundary + xf - Math.floor(xf / 2));
    expect(b.start).toBe(boundary - Math.floor(xf / 2));
    // the overlap is exactly one crossfade, faded with equal power on both sides
    expect(a.start + a.length - b.start).toBe(xf);
    expect([a.fadeOut, b.fadeIn, a.fadeOutShape, b.fadeInShape]).toEqual([xf, xf, 'equalPower', 'equalPower']);
    // tavern ends where the station scene begins (no bed there), fading out across it
    expect(b.start + b.length).toBe(s(50 - BED_LEAD_SECONDS) + xf - Math.floor(xf / 2));
    // the sound loops to fill the scene and the clips carry its name and volume
    expect(a.sound).toEqual({ loop: true, start: 0, length: forest.length, base: 0 });
    expect(a.length).toBeGreaterThan(forest.length);
    expect([a.name, a.gain, b.name, b.gain]).toEqual(['Forest night', -12, 'Tavern crowd', -10]);
  });

  it('runs the last scene’s bed on after its last line', () => {
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. STATION').id, forest);
    const [c] = bedClips(p).map((b) => b.clip);
    expect(c.start).toBe(s(50 - BED_LEAD_SECONDS) - Math.floor(s(BED_FADE_SECONDS) / 2));
    expect(c.start + c.length).toBe(s(52 + BED_TAIL_SECONDS));
  });

  it('plays a looped bed from the loop: the file repeats under the clip', () => {
    const n = s(1);
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. FOREST').id, { ...forest, length: n });
    const c = bedClips(p)[0].clip;
    const reader = {
      info: { channels: 1, frames: n },
      read: (start: number, count: number) => [Float32Array.from({ length: count }, (_, i) => (start + i >= 0 && start + i < n ? (start + i) / n : 0))],
    };
    const out = readClip(reader, c, 0, 3 * n)[0];
    expect(out[n / 2]).toBeCloseTo(0.5, 3);
    expect(out[2 * n + n / 2]).toBeCloseTo(0.5, 3);
  });

  it('follows the lines when the beds are laid again, and says when they are stale', () => {
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. FOREST').id, forest);
    expect(bedsStale(p)).toBe(false);
    expect(layBeds(p)).toBe(p);
    // the forest lines moved 20 s later
    const lines = p.script!.lines.map((l) => (l.text === 'Where are we?' ? { ...l, take: { from: s(5), to: s(7) } } : l));
    p = { ...p, script: { ...p.script!, lines } };
    expect(bedsStale(p)).toBe(true);
    p = layBeds(p);
    expect(bedClips(p)[0].clip.start).toBe(s(5 - BED_LEAD_SECONDS));
    expect(bedsStale(p)).toBe(false);
  });

  it('keeps a bed’s volume changed on the timeline, and sets it from the menu', () => {
    let p = project([10, 14, 30, 33, 50]);
    const id = heading(p, 'INT. FOREST').id;
    p = setSceneBed(p, id, forest);
    const clip = bedClips(p)[0];
    p = { ...p, tracks: p.tracks.map((t) => (t.id === clip.track.id ? { ...t, clips: t.clips.map((c) => ({ ...c, gain: -20 })) } : t)) };
    p = setBedFade(p, 6);
    expect(p.script!.beds![id].gain).toBe(-20);
    expect(bedClips(p)[0].clip.gain).toBe(-20);
    expect(bedClips(p)[0].clip.fadeOut).toBe(s(6));
    p = setBedGain(p, id, -6);
    expect(p.script!.beds![id].gain).toBe(-6);
    expect(bedClips(p)[0].clip.gain).toBe(-6);
  });

  it('puts the beds on an existing Ambience track or into the Atmo folder', () => {
    let p = project([10, 14]);
    p = { ...p, folders: [{ id: 'fld_atmo', name: 'Atmo', color: '#888', mute: false, solo: false, gain: 0 }] };
    const id = heading(p, 'INT. FOREST').id;
    const inFolder = setSceneBed(p, id, forest);
    expect(bedClips(inFolder)[0].track.folderId).toBe('fld_atmo');
    const named = addTrack(p, { id: 'trk_amb', name: 'ambience' });
    const onNamed = setSceneBed(named, id, forest);
    expect(bedClips(onNamed)[0].track.id).toBe('trk_amb');
    expect(onNamed.tracks).toHaveLength(named.tracks.length);
  });

  it('waits for a scene’s lines before placing its bed', () => {
    let p = project([10, 14]);
    const tav = heading(p, 'INT. TAVERN').id;
    p = setSceneBed(p, tav, tavern);
    expect(bedClips(p)).toHaveLength(0);
    expect(unplacedBeds(p)).toEqual(new Set([tav]));
    expect(p.tracks.some((t) => t.name === AMBIENCE_TRACK_NAME)).toBe(false);
  });

  it('removes one bed or all of them, with their clips', () => {
    let p = project([10, 14, 30, 33, 50]);
    const f = heading(p, 'INT. FOREST').id;
    p = setSceneBed(p, f, forest);
    p = setSceneBed(p, heading(p, 'INT. TAVERN').id, tavern);
    const one = setSceneBed(p, f, null);
    expect(bedClips(one).map((b) => b.clip.name)).toEqual(['Tavern crowd']);
    // without the forest bed the tavern's bed fades in at the start of its scene
    expect(bedClips(one)[0].clip.start).toBe(s(30 - BED_LEAD_SECONDS) - Math.floor(s(BED_FADE_SECONDS) / 2));
    const none = removeBeds(p);
    expect(bedClips(none)).toHaveLength(0);
    expect(none.script!.beds).toBeUndefined();
  });

  it('keeps beds through a new draft with the same headings, and through saving', () => {
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. FOREST').id, forest);
    const draft = createScript(p, parseScript(SCRIPT.replace('Lost.', 'We are lost.'), 'night2.txt'), 'night2.txt');
    const next = carryBeds(p.script, replaceScript(p, draft));
    const newId = heading(next, 'INT. FOREST').id;
    expect(newId).not.toBe(heading(p, 'INT. FOREST').id);
    expect(next.script!.beds).toEqual({ [newId]: forest });
    expect(bedClips(next).map((b) => b.clip.bed)).toEqual([newId]);

    const loaded = normalizeProject(JSON.parse(JSON.stringify(next)));
    expect(loaded.script!.beds).toEqual(next.script!.beds);
    expect(bedClips(loaded)[0].clip.bed).toBe(newId);
    expect(bedsStale(loaded)).toBe(false);
    // beds of headings that are gone, or broken entries, are dropped on load
    const broken = normalizeProject({ ...JSON.parse(JSON.stringify(next)), script: { ...next.script, beds: { nope: forest, [newId]: { file: '' } } } });
    expect(broken.script!.beds).toBeUndefined();
  });

  it('cuts the recording into stretches by bed', () => {
    let p = project([10, 14, 30, 33, 50]);
    p = { ...p, script: { ...p.script!, beds: { [heading(p, 'INT. TAVERN').id]: tavern } } };
    const spans = bedSpans(p);
    expect(spans.map((x) => x.owner >= 0)).toEqual([false, true, false]);
    expect(spans[0].end).toBe(spans[1].start);
    expect(planBeds(p)).toHaveLength(1);
  });

  it('describes the beds for AI agents', () => {
    let p = project([10, 14, 30, 33, 50]);
    p = setSceneBed(p, heading(p, 'INT. FOREST').id, forest);
    expect(bedSummary(p)).toEqual([{ heading: 'INT. FOREST - NIGHT', sound: 'Forest night', gain: -12, placed: [{ start: 9, end: 30.5 }] }]);
  });
});
