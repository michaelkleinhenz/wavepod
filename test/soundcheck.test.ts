import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addTrack, createProject } from '../src/core/project';
import { MIN_RECORDING_MINUTES, recordingBytesPerMinute, runSoundcheck, type SoundcheckContext } from '../src/core/soundcheck';
import { BACKUP_KEEP, backupProject, listBackups, loadBackup } from '../src/main/projectStore';
import type { Project } from '../src/shared/types';
import { tmpDir } from './helpers';

function ready(): Project {
  let p = createProject('S', 48000);
  p = addTrack(p, { name: 'Host', inputChannels: [0], armed: true });
  p = addTrack(p, { name: 'Guest', inputChannels: [1], armed: true });
  return p;
}

const ctx = (over: Partial<SoundcheckContext> = {}): SoundcheckContext => ({
  project: ready(),
  deviceSampleRate: 48000,
  inputOpen: true,
  inputDeviceName: 'RODECaster Pro II',
  freeBytes: 500e9,
  position: 0,
  ...over,
});

const ids = (c: SoundcheckContext) => runSoundcheck(c).map((i) => i.id);

describe('soundcheck', () => {
  it('passes a ready setup', () => {
    expect(runSoundcheck(ctx())).toEqual([]);
  });

  it('blocks without an input or armed tracks', () => {
    const p = ready();
    p.tracks.forEach((t) => (t.armed = false));
    const issues = runSoundcheck(ctx({ project: p, inputOpen: false }));
    expect(issues.map((i) => [i.id, i.level])).toEqual([
      ['no-input', 'error'],
      ['no-armed', 'error'],
    ]);
  });

  it('warns about sample rate, shared inputs, built-in mics and disk space', () => {
    const p = ready();
    p.tracks[1].inputChannels = [0];
    expect(ids(ctx({ project: p, deviceSampleRate: 44100, inputDeviceName: 'MacBook Pro Microphone', freeBytes: 1e9 }))).toEqual([
      'sample-rate',
      'shared-input',
      'builtin-mic',
      'disk-space',
    ]);
  });

  it('measures disk space against two hours of the armed channels', () => {
    const p = ready();
    const perMinute = recordingBytesPerMinute(p, 48000);
    expect(perMinute).toBe(2 * 48000 * 3 * 60);
    expect(ids(ctx({ freeBytes: perMinute * MIN_RECORDING_MINUTES + 1 }))).toEqual([]);
    const issue = runSoundcheck(ctx({ freeBytes: perMinute * 30 }))[0];
    expect(issue.message).toContain('about 30 minutes');
  });

  it('warns when recording would start before the end of the episode', () => {
    const p = ready();
    p.tracks[0].clips.push({ id: 'c', file: 'a.wav', start: 0, offset: 0, length: 60 * 48000, gain: 0, fadeIn: 0, fadeOut: 0 });
    expect(ids(ctx({ project: p, position: 10 * 48000 }))).toEqual(['mid-project']);
    expect(runSoundcheck(ctx({ project: p, position: 10 * 48000 }))[0].message).toContain('at 0:10, before the end of the episode (1:00)');
    expect(ids(ctx({ project: p, position: 60 * 48000 }))).toEqual([]);
  });

  it('skips warnings ignored for this episode, never errors', () => {
    const p = ready();
    p.tracks.forEach((t) => (t.armed = false));
    expect(ids(ctx({ project: p, deviceSampleRate: 44100, ignored: ['sample-rate', 'no-armed'] }))).toEqual(['no-armed']);
  });
});

describe('rolling backups', () => {
  it('writes timestamped backups, keeps the newest 20 and reads them back', () => {
    const dir = tmpDir();
    const p = ready();
    const t0 = new Date(2026, 10, 3, 18, 0, 0);
    for (let i = 0; i < BACKUP_KEEP + 5; i++) {
      p.name = `v${i}`;
      backupProject(dir, p, i === 3 ? 'before-recording' : '', new Date(t0.getTime() + i * 600_000));
    }
    const list = listBackups(dir);
    expect(list).toHaveLength(BACKUP_KEEP);
    expect(path.basename(list[0])).toBe('project-2026-11-03_220000.json');
    expect(loadBackup(list[0]).name).toBe(`v${BACKUP_KEEP + 4}`);
    // the oldest five are gone
    expect(list.some((f) => f.includes('180000'))).toBe(false);
  });

  it('never overwrites a backup made in the same second', () => {
    const dir = tmpDir();
    const t0 = new Date(2026, 10, 3, 18, 0, 0);
    const a = backupProject(dir, ready(), 'before-recording', t0);
    const b = backupProject(dir, ready(), 'before-recording', t0);
    expect(a).not.toBe(b);
    expect(fs.readdirSync(path.join(dir, 'backup'))).toHaveLength(2);
  });
});
