import { describe, expect, it } from 'vitest';
import { ACTIVITY_STEP, activityFromLevels, activityFromWords, autoDirect, closeUpOf, snapToWords, wideOf } from '../src/core/autoDirect';
import { createWavePodServer, type WavePodHost } from '../src/core/mcp/tools';
import { addTrack, createProject } from '../src/core/project';
import { oscCommand } from '../src/core/osc';
import { MIDI_ACTIONS } from '../src/core/midi';
import type { Camera, Project, TimelineWord } from '../src/shared/types';

const SR = 1000;

const cam = (id: string, speakers: string[]): Camera => ({ id, name: id, color: '#fff', file: `${id}.mp4`, width: 1920, height: 1080, fps: 25, duration: 600, sync: [], speakers });

function project(): Project {
  let p = createProject('V', SR);
  p = addTrack(p, { id: 'h', name: 'Host' });
  p = addTrack(p, { id: 'g', name: 'Guest' });
  p.cameras = [cam('wide', ['h', 'g']), cam('hostCam', ['h']), cam('guestCam', ['g'])];
  p.director = { cuts: [] };
  return p;
}

const word = (trackId: string, start: number, end: number): TimelineWord => ({ text: 'w', start, end, trackId, clipId: 'c', filler: false });

/** Words every 0.3 s from `a` to `b` seconds. */
function talk(trackId: string, a: number, b: number): TimelineWord[] {
  const out: TimelineWord[] = [];
  for (let t = a; t < b; t += 0.3) out.push(word(trackId, Math.round(t * SR), Math.round((t + 0.25) * SR)));
  return out;
}

describe('auto-direct', () => {
  it('picks close-ups and the wide shot', () => {
    const p = project();
    expect(closeUpOf(p.cameras!, 'g')!.id).toBe('guestCam');
    expect(wideOf(p.cameras!)!.id).toBe('wide');
  });

  it('cuts to whoever talks, wide for crosstalk, ignores a short reply', () => {
    const p = project();
    const words = [...talk('h', 1, 10), ...talk('g', 5, 5.4), ...talk('g', 11, 20), ...talk('h', 15, 18)];
    const act = activityFromWords(words, ['h', 'g'], SR, 30 * SR);
    const cuts = autoDirect(p, act, 0, 30 * SR, { minShot: 2, minTurn: 0.8, maxCloseUp: 0, cutaway: 4, pauseWide: 3 });
    const seq = cuts.map((c) => [Math.round(c.at / SR), c.camera]);
    expect(seq[0]).toEqual([0, 'hostCam']); // the host starts within the shortest shot, so the episode opens on them
    expect(seq).toContainEqual([11, 'guestCam']);
    // the guest's "mhm" at 5 s doesn't switch
    expect(seq.some(([t]) => (t as number) >= 4 && (t as number) <= 6)).toBe(false);
    // both talk from 15 s: a 3 s pause rule doesn't apply, but the guest stays until the host talks alone
    for (let i = 1; i < cuts.length; i++) expect(cuts[i].at - cuts[i - 1].at).toBeGreaterThanOrEqual(2 * SR);
  });

  it('goes wide in long pauses and breaks up long close-ups', () => {
    const p = project();
    const act = activityFromWords([...talk('h', 0, 60)], ['h', 'g'], SR, 80 * SR);
    const cuts = autoDirect(p, act, 0, 80 * SR, { minShot: 2, minTurn: 0.8, maxCloseUp: 20, cutaway: 4, pauseWide: 3 });
    const seq = cuts.map((c) => [Math.round(c.at / SR), c.camera]);
    expect(seq).toContainEqual([20, 'wide']);
    expect(seq).toContainEqual([24, 'hostCam']);
    // 3 s after the talk ends (60 s)
    expect(seq[seq.length - 1][1]).toBe('wide');
    expect(seq[seq.length - 1][0]).toBeGreaterThanOrEqual(60);
  });

  it('reads speech from levels, ignoring the other person’s bleed', () => {
    const n = 100;
    const host = new Float32Array(n).fill(-80);
    const guest = new Float32Array(n).fill(-80);
    for (let i = 10; i < 40; i++) {
      host[i] = -20;
      guest[i] = -40; // bleed
    }
    for (let i = 60; i < 90; i++) guest[i] = -22;
    const act = activityFromLevels(new Map([['h', host], ['g', guest]]));
    expect(act.get('h')![20]).toBe(1);
    expect(act.get('g')![20]).toBe(0);
    expect(act.get('g')![70]).toBe(1);
    expect(ACTIVITY_STEP).toBe(0.1);
  });

  it('snaps a switch to the nearest word start', () => {
    const words = [word('h', 1000, 1200), word('g', 1500, 1700)];
    expect(snapToWords(1450, words, 100)).toBe(1500);
    expect(snapToWords(1300, words, 100)).toBe(1300);
  });
});

describe('camera remote control', () => {
  it('has MIDI actions and OSC addresses for cameras', () => {
    expect(MIDI_ACTIONS.some((a) => a.action === 'camera-3')).toBe(true);
    expect(oscCommand({ address: '/wavepod/camera/3', args: [1] })).toEqual({ action: 'camera-3', pressed: true });
    expect(oscCommand({ address: '/wavepod/camera/3', args: [0] })).toBeNull();
  });
});

describe('MCP video tools', () => {
  function host() {
    let p = project();
    p.tracks.push({ ...p.tracks[0], id: 'camtrack', name: 'wide', cameraId: 'wide', clips: [] });
    const h: WavePodHost = {
      project: () => p,
      dir: () => '/tmp/x',
      transportState: () => 'stopped',
      apply: (next) => {
        p = next;
      },
      measureLoudness: async () => [],
      vst: null,
    };
    return { h, get p() { return p; } };
  }
  async function call(server: ReturnType<typeof createWavePodServer>, name: string, args: Record<string, unknown> = {}) {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const r = res!.result as { content: Array<{ text: string }>; isError: boolean };
    return { isError: r.isError, data: JSON.parse(r.content[0].text) };
  }

  it('lists cameras and sets switches', async () => {
    const x = host();
    const server = createWavePodServer(x.h, '1');
    const list = await call(server, 'list_cameras');
    expect(list.data.cameras[0]).toMatchObject({ number: 1, name: 'wide', soundTrack: 'wide', shows: ['Host', 'Guest'] });
    const set = await call(server, 'set_director_cuts', { switches: [{ seconds: 0, camera: 1 }, { seconds: 5, camera: 'guestCam', dissolveSeconds: 0.5 }] });
    expect(set.isError).toBe(false);
    expect(x.p.director!.cuts).toEqual([{ at: 0, camera: 'wide' }, { at: 5000, camera: 'guestCam', dissolve: 500 }]);
    const bad = await call(server, 'set_director_cuts', { switches: [{ seconds: 1, camera: 7 }] }).catch(() => null);
    expect(bad === null || bad.isError).toBe(true);
  });
});
