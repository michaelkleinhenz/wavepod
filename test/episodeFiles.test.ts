import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { addClip, addTrack, createProject } from '../src/core/project';
import {
  copyProjectDir,
  createProjectDir,
  defaultEpisodeName,
  episodeFolderName,
  isUntouchedProject,
  listProjects,
  loadProject,
  saveProject,
} from '../src/main/projectStore';
import { createProjectFromTemplate, saveTemplate } from '../src/main/templateStore';
import { tmpDir } from './helpers';

const when = new Date(2026, 10, 4, 17, 5);

describe('naming new episodes', () => {
  it('names the episode and its folder as typed', () => {
    const root = tmpDir();
    const { dir, project } = createProjectDir(root, 48000, when, '  Folge 42: Mit Anna  ');
    expect(project.name).toBe('Folge 42: Mit Anna');
    // ":" is not allowed in Windows file names
    expect(path.basename(dir)).toBe('Folge 42_ Mit Anna');
    expect(loadProject(dir).name).toBe('Folge 42: Mit Anna');
  });

  it('falls back to the date and adds a number when the folder exists', () => {
    const root = tmpDir();
    expect(defaultEpisodeName(when)).toBe('Episode 2026-11-04 1705');
    const a = createProjectDir(root, 48000, when);
    const b = createProjectDir(root, 48000, when, 'Episode 2026-11-04 1705');
    expect(path.basename(a.dir)).toBe('Episode 2026-11-04 1705');
    expect(path.basename(b.dir)).toBe('Episode 2026-11-04 1705 (2)');
    expect(b.project.name).toBe('Episode 2026-11-04 1705');
  });

  it('makes safe folder names', () => {
    expect(episodeFolderName('a/b\\c?*<>|"d')).toBe('a_b_c_d');
    expect(episodeFolderName(' .. ')).toBe('Episode');
    expect(episodeFolderName('...hidden.')).toBe('hidden');
  });

  it('names episodes from templates too', () => {
    const root = tmpDir();
    const templates = path.join(root, 'Templates');
    const src = createProjectDir(root, 48000, when, 'Source');
    saveTemplate(templates, addTrack(src.project, { name: 'Host' }), src.dir, 'Weekly');
    const { dir, project } = createProjectFromTemplate(root, templates, 'Weekly', 48000, when, 'Weekly 7');
    expect(path.basename(dir)).toBe('Weekly 7');
    expect(project.name).toBe('Weekly 7');
    expect(project.tracks.map((t) => t.name)).toEqual(['Host']);
  });
});

describe('Save As', () => {
  it('copies the folder with its media next to it under the new name, without the recording journal', async () => {
    const root = tmpDir();
    const { dir } = createProjectDir(root, 48000, when, 'Original');
    let p = addTrack(loadProject(dir), { name: 'Host' });
    p = addClip(p, p.tracks[0].id, { id: 'c1', file: 'media/Host-001.wav', start: 0, offset: 0, length: 10, gain: 0, fadeIn: 0, fadeOut: 0 });
    fs.writeFileSync(path.join(dir, 'media', 'Host-001.wav'), 'RIFF-data');
    fs.writeFileSync(path.join(dir, 'recording-in-progress.json'), '{}');
    fs.writeFileSync(path.join(dir, 'project.json.tmp'), 'half');
    saveProject(dir, p);

    const copy = await copyProjectDir(dir, p, 'Original (long cut)');
    expect(copy.dir).toBe(path.join(root, 'Original (long cut)'));
    expect(copy.project.name).toBe('Original (long cut)');
    expect(fs.readFileSync(path.join(copy.dir, 'media', 'Host-001.wav'), 'utf8')).toBe('RIFF-data');
    expect(fs.existsSync(path.join(copy.dir, 'recording-in-progress.json'))).toBe(false);
    expect(fs.existsSync(path.join(copy.dir, 'project.json.tmp'))).toBe(false);
    expect(loadProject(copy.dir).tracks[0].clips[0].file).toBe('media/Host-001.wav');
    // the original is untouched
    expect(loadProject(dir).name).toBe('Original');
    expect(fs.existsSync(path.join(dir, 'recording-in-progress.json'))).toBe(true);

    const again = await copyProjectDir(dir, p, 'Original (long cut)');
    expect(path.basename(again.dir)).toBe('Original (long cut) (2)');
  });
});

describe('Project tab', () => {
  it('lists episode folders newest first and skips other folders', () => {
    const root = tmpDir();
    const a = createProjectDir(root, 48000, when, 'Older');
    const b = createProjectDir(root, 48000, when, 'Newer');
    fs.mkdirSync(path.join(root, 'Templates'));
    fs.utimesSync(path.join(a.dir, 'project.json'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    expect(listProjects(root).map((r) => r.name)).toEqual(['Newer', 'Older']);
    expect(listProjects(path.join(root, 'missing'))).toEqual([]);
    expect(listProjects(root)[0].dir).toBe(b.dir);
  });

  it('knows an episode nothing was put into yet', () => {
    const p = createProject('x', 48000);
    expect(isUntouchedProject(addTrack(p, { name: 'Host' }))).toBe(true);
    expect(isUntouchedProject({ ...p, markers: [{ id: 'm', kind: 'chapter', position: 0, title: '' }] })).toBe(false);
  });
});
