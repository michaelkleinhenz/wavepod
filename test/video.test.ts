import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_VIDEO_EXPORT, normalizeExportSettings } from '../src/core/exportSettings';
import { plannedFiles } from '../src/core/exportPlan';
import { addTrack, createProject, insertSilence, normalizeProject, rippleDelete } from '../src/core/project';
import { rippleMove, rippleSet } from '../src/core/rippleMove';
import {
  applyPass,
  cameraSyncAfterStretch,
  cameraTimeAt,
  clipAt,
  directedCameraAt,
  moveCut,
  nextJump,
  normalizeCuts,
  programAt,
  removeCamera,
  rippleDeleteCuts,
  setCut,
  setShotCamera,
  shots,
  sourceRect,
  videoSettings,
} from '../src/core/video';
import type { Camera, Clip, Project } from '../src/shared/types';

const SR = 1000;

const clip = (id: string, file: string, start: number, offset: number, length: number, extra: Partial<Clip> = {}): Clip => ({
  id, file, start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0, ...extra,
});

const camera = (id: string, file: string, offset = 0): Camera => ({
  id, name: id, color: '#fff', file: `${id}.mp4`, width: 1920, height: 1080, fps: 25, duration: 100,
  sync: [{ file, offset, rate: 1 }],
});

/** Two cameras with their sound on two tracks, plus a mic track. */
function project(): Project {
  let p = createProject('V', SR);
  p = addTrack(p, { name: 'Mic' });
  p = addTrack(p, { name: 'Cam A', cameraId: 'A', mute: true });
  p = addTrack(p, { name: 'Cam B', cameraId: 'B', mute: true });
  p.tracks[0].clips.push(clip('m', 'mic.wav', 0, 0, 20_000));
  p.tracks[1].clips.push(clip('a', 'a.wav', 0, 2_000, 20_000));
  p.tracks[2].clips.push(clip('b', 'b.wav', 1_000, 0, 10_000));
  p.cameras = [camera('A', 'a.wav', 0.04), camera('B', 'b.wav')];
  return p;
}

describe('camera picture follows its sound track', () => {
  it('maps a timeline frame through the clip and the sync entry', () => {
    const p = project();
    // clip a plays a.wav from frame 2000 at timeline 0; video 0.04 s at audio frame 0
    expect(cameraTimeAt(p, p.cameras![0], 0)).toBeCloseTo(2.04);
    expect(cameraTimeAt(p, p.cameras![0], 5_000)).toBeCloseTo(7.04);
    expect(cameraTimeAt(p, p.cameras![1], 500)).toBeNull();
    expect(cameraTimeAt(p, p.cameras![1], 1_500)).toBeCloseTo(0.5);
  });

  it('applies a ripple cut to the picture', () => {
    const p = rippleDelete(project(), 3_000, 5_000);
    // after the cut, timeline 3000 shows what was at 5000
    expect(cameraTimeAt(p, p.cameras![0], 3_000)).toBeCloseTo(7.04);
    expect(nextJump(p, p.cameras![0], 0, 10_000)).toBe(3_000);
  });

  it('bridges a gap inside one recording but not a jump', () => {
    const p = project();
    // delete a cough without closing the gap
    p.tracks[1].clips = [clip('a1', 'a.wav', 0, 2_000, 4_000), clip('a2', 'a.wav', 5_000, 7_000, 10_000)];
    expect(cameraTimeAt(p, p.cameras![0], 4_500)).toBeCloseTo(6.54);
    expect(nextJump(p, p.cameras![0], 0, 14_000)).toBeNull();
    expect(nextJump(p, p.cameras![0], 0, 20_000)).toBe(15_000);
    p.tracks[1].clips[1] = clip('a2', 'a.wav', 5_000, 9_000, 10_000);
    expect(cameraTimeAt(p, p.cameras![0], 4_500)).toBeNull();
  });

  it('switches in the middle of a crossfade', () => {
    const t = { clips: [clip('x', 'a.wav', 0, 0, 1_000), clip('y', 'a.wav', 800, 5_000, 1_000)] } as never;
    expect(clipAt(t, 850)!.id).toBe('x');
    expect(clipAt(t, 950)!.id).toBe('y');
  });

  it('freezes on sound-designed clips', () => {
    const p = project();
    p.tracks[1].clips[0].sound = { reverse: true, start: 0, length: 20_000, base: 0 };
    expect(cameraTimeAt(p, p.cameras![0], 5_000)).toBeCloseTo(2.04);
  });

  it('follows the stretched copy after a drift fix', () => {
    const p = cameraSyncAfterStretch(project(), { 'a.wav': 'a-synced.wav' }, 1.001);
    const s = p.cameras![0].sync.find((x) => x.file === 'a-synced.wav')!;
    expect(s.rate).toBeCloseTo(1 / 1.001);
    expect(s.offset).toBeCloseTo(0.04);
  });
});

describe('director', () => {
  it('shows the chosen camera, falls back where it has no picture', () => {
    let p = project();
    p = setCut(setCut(p, 0, 'B'), 4_000, 'A');
    expect(programAt(p, 2_000).a).toEqual({ camera: 'B', time: 1 });
    // B has no picture before 1000: the other camera fills in
    expect(programAt(p, 500).a!.camera).toBe('A');
    expect(programAt(p, 5_000).a!.camera).toBe('A');
    // without switches the first camera is shown
    expect(directedCameraAt(project(), 100)).toBe('A');
  });

  it('dissolves between two cameras', () => {
    let p = setCut(setCut(project(), 0, 'A'), 4_000, 'B', 1_000);
    const f = programAt(p, 4_250);
    expect(f.a!.camera).toBe('A');
    expect(f.b!.camera).toBe('B');
    expect(f.mix).toBeCloseTo(0.25);
    p = setCut(p, 4_000, 'B');
    expect(programAt(p, 4_250).b).toBeUndefined();
  });

  it('keeps switches tidy', () => {
    expect(normalizeCuts([{ at: 10, camera: 'A' }, { at: 0, camera: 'A' }, { at: 20, camera: 'B' }, { at: 20, camera: 'A' }])).toEqual([{ at: 0, camera: 'A' }]);
    const p = setShotCamera(setCut(setCut(project(), 0, 'A'), 1_000, 'B'), 1_500, 'A');
    expect(p.director!.cuts).toEqual([{ at: 0, camera: 'A' }]);
    const q = moveCut(setCut(setCut(setCut(project(), 0, 'A'), 1_000, 'B'), 2_000, 'A'), 1_000, 5_000);
    expect(q.director!.cuts.map((c) => c.at)).toEqual([0, 1_999, 2_000]);
  });

  it('ripples with cuts, inserts and ripple drags', () => {
    let p = setCut(setCut(setCut(project(), 0, 'A'), 3_500, 'B'), 6_000, 'A');
    expect(rippleDeleteCuts(p.director!.cuts, 3_000, 5_000)).toEqual([
      { at: 0, camera: 'A' },
      { at: 3_000, camera: 'B' },
      { at: 4_000, camera: 'A' },
    ]);
    p = rippleDelete(p, 3_000, 5_000);
    expect(p.director!.cuts.map((c) => c.at)).toEqual([0, 3_000, 4_000]);
    p = insertSilence(p, 1_000, 500);
    expect(p.director!.cuts.map((c) => c.at)).toEqual([0, 3_500, 4_500]);
    const set = rippleSet(p, ['m'], 'all');
    p = rippleMove(p, set, 100);
    expect(p.director!.cuts.map((c) => c.at)).toEqual([100, 3_600, 4_600]);
  });

  it('a watch-through pass replaces what it covered and keeps the shot after it', () => {
    let p = setCut(setCut(project(), 0, 'A'), 8_000, 'B');
    p = applyPass(p, 2_000, 6_000, [{ at: 3_000, camera: 'B' }, { at: 5_000, camera: 'A' }]);
    expect(p.director!.cuts).toEqual([
      { at: 0, camera: 'A' },
      { at: 3_000, camera: 'B' },
      { at: 5_000, camera: 'A' },
      { at: 8_000, camera: 'B' },
    ]);
    p = applyPass(p, 4_000, 9_000, [{ at: 4_000, camera: 'A' }]);
    expect(p.director!.cuts).toEqual([
      { at: 0, camera: 'A' },
      { at: 3_000, camera: 'B' },
      { at: 4_000, camera: 'A' },
      { at: 9_000, camera: 'B' },
    ]);
  });

  it('lists shots', () => {
    const p = setCut(setCut(project(), 0, 'A'), 3_000, 'B');
    expect(shots(p, 10_000)).toEqual([
      { start: 0, end: 3_000, camera: 'A', index: 0 },
      { start: 3_000, end: 10_000, camera: 'B', index: 1 },
    ]);
  });
});

describe('cameras', () => {
  it('removes a camera with its track and switches', () => {
    const p = removeCamera(setCut(setCut(project(), 0, 'A'), 3_000, 'B'), 'B');
    expect(p.tracks.some((t) => t.cameraId === 'B')).toBe(false);
    expect(p.director!.cuts).toEqual([{ at: 0, camera: 'A' }]);
    const q = removeCamera(p, 'A');
    expect(q.cameras).toBeUndefined();
    expect(q.director).toBeUndefined();
  });

  it('survives loading', () => {
    const raw = setCut(project(), 0, 'Z');
    const p = normalizeProject(JSON.parse(JSON.stringify(raw)));
    expect(p.cameras!.length).toBe(2);
    expect(p.tracks[1].cameraId).toBe('A');
    expect(p.director!.cuts).toEqual([]);
  });

  it('crops the picture to the output', () => {
    expect(sourceRect({ width: 1920, height: 1080 }, 1920, 1080)).toEqual({ sx: 0, sy: 0, sw: 1920, sh: 1080 });
    const r = sourceRect({ width: 1920, height: 1080, framing: { zoom: 2, x: 1, y: 0 } }, 1920, 1080);
    expect(r).toEqual({ sx: 960, sy: 270, sw: 960, sh: 540 });
    // portrait output from a landscape camera
    expect(sourceRect({ width: 1920, height: 1080 }, 1080, 1920).sw).toBeCloseTo(607.5);
    expect(videoSettings(project())).toEqual({ width: 1920, height: 1080, fps: 25 });
  });
});

describe('video in the export', () => {
  it('plans an MP4 next to the audio files only for episodes with cameras', () => {
    const settings = { ...DEFAULT_EXPORT_SETTINGS, chapterFiles: false, video: { ...DEFAULT_VIDEO_EXPORT } };
    const job = { outputBase: '/out/Ep' };
    expect(plannedFiles(createProject('x'), settings, job)).toEqual(['/out/Ep.mp3']);
    const p = { ...createProject('x'), cameras: [{ id: 'c', name: 'A', color: '#fff', file: 'a.mp4', width: 1920, height: 1080, fps: 30, duration: 10, sync: [] }] };
    expect(plannedFiles(p, settings, job)).toEqual(['/out/Ep.mp3', '/out/Ep.mp4']);
  });

  it('keeps the video settings with the export settings and drops bad values', () => {
    const s = normalizeExportSettings({ ...DEFAULT_EXPORT_SETTINGS, video: { size: 999, fps: 25, quality: 'very-high', codec: 'av1' } });
    expect(s?.video).toEqual({ size: 1080, fps: 25, quality: 'very-high', codec: 'av1' });
    expect(normalizeExportSettings({ ...DEFAULT_EXPORT_SETTINGS })?.video).toBeUndefined();
  });
});
