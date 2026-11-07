import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJsonSafely, writeJsonSafely } from '../src/core/safeJson';
import { addTrack, createProject } from '../src/core/project';
import { backupProject, isDamagedProject, listBackups, listProjects, loadProject, restoreNewestBackup, saveProject } from '../src/main/projectStore';
import { tmpDir } from './helpers';

describe('settings file', () => {
  it('keeps the previous version and falls back to it when the file is damaged', () => {
    const file = path.join(tmpDir(), 'sub', 'settings.json');
    expect(readJsonSafely(file)).toEqual({ data: null, from: 'none' });
    writeJsonSafely(file, { n: 1 });
    writeJsonSafely(file, { n: 2 });
    expect(readJsonSafely(file)).toEqual({ data: { n: 2 }, from: 'file' });
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    // a crash cut the file short
    fs.writeFileSync(file, '{"n": 3, "midi": {');
    expect(readJsonSafely(file)).toEqual({ data: { n: 1 }, from: 'backup' });
    // the next save doesn't copy the damaged file over the good backup
    writeJsonSafely(file, { n: 4 });
    expect(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'))).toEqual({ n: 1 });
    expect(readJsonSafely(file).data).toEqual({ n: 4 });
  });
});

describe('damaged episode file', () => {
  const episode = () => {
    const root = tmpDir();
    const dir = path.join(root, 'Show 12');
    let p = createProject('Show 12', 48000);
    saveProject(dir, p);
    backupProject(dir, p, '', new Date(2026, 10, 7, 10, 0, 0));
    p = addTrack(p, { name: 'Host' });
    saveProject(dir, p);
    backupProject(dir, p, '', new Date(2026, 10, 7, 10, 10, 0));
    return { root, dir };
  };

  it('is replaced by the newest readable backup, keeping the damaged file aside', () => {
    const { root, dir } = episode();
    expect(isDamagedProject(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'project.json'), '');
    expect(isDamagedProject(dir)).toBe(true);
    // the newest backup is damaged too: the one before it is used
    const [newest] = listBackups(dir);
    fs.writeFileSync(newest, '{"name": "Show');
    const used = restoreNewestBackup(dir, new Date(2026, 10, 7, 11, 0, 0))!;
    expect(path.basename(used)).toBe('project-2026-11-07_100000.json');
    expect(loadProject(dir).name).toBe('Show 12');
    expect(isDamagedProject(dir)).toBe(false);
    // the damaged file is kept, and isn't taken for a backup
    expect(fs.existsSync(path.join(dir, 'backup', 'damaged-project-2026-11-07_110000.json'))).toBe(true);
    expect(listBackups(dir).map((f) => path.basename(f))).not.toContain('damaged-project-2026-11-07_110000.json');
    // still listed among the recent episodes while damaged
    fs.writeFileSync(path.join(dir, 'project.json'), 'garbage');
    expect(listProjects(root).map((p) => p.name)).toEqual(['Show 12']);
  });

  it('is left alone when there is no backup to restore', () => {
    const dir = path.join(tmpDir(), 'New');
    saveProject(dir, createProject('New', 48000));
    fs.writeFileSync(path.join(dir, 'project.json'), '{');
    expect(restoreNewestBackup(dir)).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).toBe('{');
  });
});
