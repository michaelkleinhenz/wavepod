import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addClip, addTrack, createProject } from '../src/core/project';
import { ensureSoundboardTrack } from '../src/core/soundboard';
import { normalizeTemplate, projectFromTemplate, projectToTemplate, templateFolderName } from '../src/core/template';
import type { Fx, Project } from '../src/shared/types';
import { loadProject, saveProject } from '../src/main/projectStore';
import { createProjectFromTemplate, deleteTemplate, listTemplates, loadTemplate, saveTemplate } from '../src/main/templateStore';
import { tmpDir } from './helpers';

const vst: Fx = {
  id: 'fx-vst',
  type: 'vst3',
  enabled: true,
  params: { '7': 0.25 },
  plugin: { path: '/plugins/Comp.vst3', cid: '0'.repeat(32), name: 'Comp', vendor: 'Acme' },
  paramInfo: [{ id: 7, title: 'Threshold', units: 'dB', steps: 0, default: 0.5, flags: 0 }],
  state: 'c3RhdGU=',
};

function setup(jingle = '/abs/jingle.wav'): Project {
  let p = createProject('Episode 12', 48000);
  p = addTrack(p, { name: 'Host', inputChannels: [0], armed: true, gain: -2, fx: [{ id: 'fx-hp', type: 'highpass', enabled: true, params: { freq: 80 } }] });
  p = addTrack(p, { name: 'Remote', inputChannels: [4, 5], solo: true, muteRegions: [[10, 20]], envelope: [{ pos: 5, db: -6 }] });
  p = addClip(p, p.tracks[0].id, { id: 'c1', file: 'media/Host-001.wav', start: 0, offset: 0, length: 100, gain: 0, fadeIn: 0, fadeOut: 0 });
  p = ensureSoundboardTrack({ ...p, soundboard: [{ id: 'snd1', name: 'Intro', file: jingle, gain: -3, color: '#fff', loop: true }] });
  p = addClip(p, 'soundboard', { id: 'c2', file: 'media/jingle-snd1-48000.wav', start: 0, offset: 0, length: 50, gain: 0, fadeIn: 0, fadeOut: 0 });
  p.masterFx = [vst];
  p.markers = [{ id: 'm1', kind: 'chapter', position: 10, title: 'Intro' }];
  p.metadata = { ...p.metadata, podcast: 'My Show', author: 'Michael', title: 'Episode 12', episode: '12' };
  return p;
}

describe('project templates', () => {
  it('keeps the setup and leaves out recorded material', () => {
    const t = projectToTemplate(setup(), 'Weekly', 'RØDECaster Pro II');
    expect(t.name).toBe('Weekly');
    expect(t.inputDevice).toBe('RØDECaster Pro II');
    expect(t.tracks.map((x) => [x.name, x.inputChannels, x.armed])).toEqual([
      ['Host', [0], true],
      ['Remote', [4, 5], false],
      ['Soundboard', [], false],
    ]);
    expect(t.tracks[0].gain).toBe(-2);
    expect(t.tracks[0].fx?.[0].params.freq).toBe(80);
    expect(t.masterFx[0]).toMatchObject({ type: 'vst3', params: { '7': 0.25 }, state: 'c3RhdGU=' });
    expect(t.soundboard[0]).toMatchObject({ name: 'Intro', loop: true, gain: -3 });
    expect(t.metadata).toEqual({ podcast: 'My Show', author: 'Michael' });
    expect(t.tracks[1].solo).toBe(false);
    for (const tr of t.tracks) {
      expect(tr).not.toHaveProperty('clips');
      expect(tr).not.toHaveProperty('muteRegions');
      expect(tr).not.toHaveProperty('envelope');
    }
    expect(JSON.stringify(t)).not.toContain('media/');
  });

  it('builds an empty project with fresh filter ids', () => {
    const src = setup();
    const p = projectFromTemplate(projectToTemplate(src, 'Weekly'), 'Episode 13', 44100);
    expect(p.name).toBe('Episode 13');
    expect(p.sampleRate).toBe(44100);
    expect(p.markers).toEqual([]);
    expect(p.tracks.every((t) => t.clips.length === 0 && t.muteRegions?.length === 0 && t.envelope?.length === 0)).toBe(true);
    expect(p.tracks.map((t) => t.id)).toEqual(src.tracks.map((t) => t.id));
    expect(p.tracks.find((t) => t.kind === 'soundboard')?.id).toBe('soundboard');
    expect(p.masterFx?.[0].id).not.toBe('fx-vst');
    expect(p.masterFx?.[0]).toMatchObject({ plugin: vst.plugin, state: vst.state, params: vst.params });
    expect(p.tracks[0].fx?.[0].id).not.toBe('fx-hp');
    expect(p.metadata).toMatchObject({ podcast: 'My Show', author: 'Michael', title: 'Episode 13', episode: '' });
  });

  it('accepts sparse hand-written templates', () => {
    const t = normalizeTemplate({ tracks: [{ name: 'Solo' } as never] }, 'Folder');
    expect(t.name).toBe('Folder');
    expect(t.tracks[0]).toMatchObject({ name: 'Solo', inputChannels: [], fx: [] });
    expect(t.masterFx).toEqual([]);
    expect(t.soundboard).toEqual([]);
  });

  it('makes safe folder names', () => {
    expect(templateFolderName(' Weekly: 3 speakers ')).toBe('Weekly_ 3 speakers');
    expect(templateFolderName('../..')).toBe('_');
    expect(templateFolderName('')).toBe('Template');
  });
});

describe('template folders', () => {
  it('saves, lists, uses and deletes templates with their jingles', () => {
    const root = tmpDir();
    const templates = path.join(root, 'Templates');
    const projectDir = path.join(root, 'Old episode');
    fs.mkdirSync(path.join(projectDir, 'media'), { recursive: true });
    const jingle = path.join(root, 'outside', 'intro.wav');
    fs.mkdirSync(path.dirname(jingle));
    fs.writeFileSync(jingle, 'RIFF-intro');
    const project = setup(jingle);
    saveProject(projectDir, project);

    const summary = saveTemplate(templates, project, projectDir, 'Weekly show', 'Interface');
    expect(summary).toMatchObject({ id: 'Weekly show', trackCount: 3, filterCount: 2, slotCount: 1, inputDevice: 'Interface' });
    expect(listTemplates(templates).map((t) => t.name)).toEqual(['Weekly show']);
    const stored = loadTemplate(templates, 'Weekly show');
    expect(stored.soundboard[0].file).toBe('sounds/intro.wav');
    expect(fs.readFileSync(path.join(templates, 'Weekly show', 'sounds', 'intro.wav'), 'utf8')).toBe('RIFF-intro');

    // The original jingle may go away; the new episode uses the template's copy.
    fs.rmSync(jingle);
    const { dir } = createProjectFromTemplate(root, templates, 'Weekly show', 48000, new Date(2026, 10, 3, 9, 5));
    expect(path.basename(dir)).toBe('Episode 2026-11-03 0905');
    const created = loadProject(dir);
    expect(created.tracks.map((t) => t.name)).toEqual(['Host', 'Remote', 'Soundboard']);
    expect(created.tracks.flatMap((t) => t.clips)).toEqual([]);
    expect(created.soundboard[0].file).toBe('sounds/intro.wav');
    expect(fs.readFileSync(path.join(dir, 'sounds', 'intro.wav'), 'utf8')).toBe('RIFF-intro');

    // Saving under the same name replaces it.
    saveTemplate(templates, { ...project, soundboard: [] }, projectDir, 'Weekly show');
    expect(loadTemplate(templates, 'Weekly show').soundboard).toEqual([]);
    expect(fs.existsSync(path.join(templates, 'Weekly show', 'sounds'))).toBe(false);

    deleteTemplate(templates, 'Weekly show');
    expect(listTemplates(templates)).toEqual([]);
  });

  it('copies project-relative jingles and refuses paths outside the templates folder', () => {
    const root = tmpDir();
    const templates = path.join(root, 'Templates');
    const projectDir = path.join(root, 'Ep');
    fs.mkdirSync(path.join(projectDir, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'sounds', 'outro.mp3'), 'ID3');
    saveTemplate(templates, setup('sounds/outro.mp3'), projectDir, 'Rel');
    expect(loadTemplate(templates, 'Rel').soundboard[0].file).toBe('sounds/outro.mp3');
    expect(() => loadTemplate(templates, '../Ep')).toThrow(/Invalid template/);
    expect(() => deleteTemplate(templates, '..')).toThrow(/Invalid template/);
  });
});
