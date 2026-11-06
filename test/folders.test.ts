import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addDramaFolders,
  addFolder,
  audibleTracks,
  folderGainOf,
  removeFolder,
  setTrackFolder,
  timelineRows,
  updateFolder,
} from '../src/core/folders';
import { Mixer, ReaderCache } from '../src/core/mixer';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { projectFromTemplate, projectToTemplate } from '../src/core/template';
import { createWavePodServer, type WavePodHost } from '../src/core/mcp/tools';
import { writeWavFile } from '../src/core/wav';
import type { Project } from '../src/shared/types';
import { tmpDir } from './helpers';

/** A project with tracks named by the given names. */
function withTracks(...names: string[]): Project {
  return names.reduce((p, name) => addTrack(p, { name }), createProject('Drama', 48000));
}
const names = (p: Project) => p.tracks.map((t) => t.name);
const id = (p: Project, name: string) => p.tracks.find((t) => t.name === name)!.id;
const fid = (p: Project, name: string) => p.folders!.find((f) => f.name === name)!.id;

describe('track folders', () => {
  it('keeps a folder\'s tracks together in the track list', () => {
    let p = withTracks('Anna', 'Rain', 'Ben', 'Door', 'Theme');
    p = addFolder(p, { name: 'Dialogue', trackIds: [id(p, 'Anna'), id(p, 'Ben')] });
    expect(names(p)).toEqual(['Anna', 'Ben', 'Rain', 'Door', 'Theme']);
    p = addFolder(p, { name: 'SFX' });
    p = setTrackFolder(p, id(p, 'Door'), fid(p, 'SFX'));
    // an empty folder takes the track where it is
    expect(names(p)).toEqual(['Anna', 'Ben', 'Rain', 'Door', 'Theme']);
    p = setTrackFolder(p, id(p, 'Theme'), fid(p, 'Dialogue'));
    expect(names(p)).toEqual(['Anna', 'Ben', 'Theme', 'Rain', 'Door']);
    // leaving a folder: right below it
    p = setTrackFolder(p, id(p, 'Anna'), null);
    expect(names(p)).toEqual(['Ben', 'Theme', 'Anna', 'Rain', 'Door']);
    expect(p.tracks.find((t) => t.name === 'Anna')!.folderId).toBeUndefined();
    // a new track made in a folder joins its end
    p = addTrack(p, { name: 'Ben 2', folderId: fid(p, 'Dialogue') });
    expect(names(p)).toEqual(['Ben', 'Theme', 'Ben 2', 'Anna', 'Rain', 'Door']);
  });

  it('builds timeline rows: folder rows above their tracks, folded ones without, empty folders last', () => {
    let p = withTracks('Anna', 'Ben', 'Rain');
    p = addFolder(p, { name: 'Dialogue', trackIds: [id(p, 'Anna'), id(p, 'Ben')] });
    p = addFolder(p, { name: 'Music' });
    const label = (q: Project) => timelineRows(q).map((r) => (r.kind === 'folder' ? `[${r.folder.name} ${r.members.length}]` : r.track.name));
    expect(label(p)).toEqual(['[Dialogue 2]', 'Anna', 'Ben', 'Rain', '[Music 0]']);
    p = updateFolder(p, fid(p, 'Dialogue'), { collapsed: true });
    expect(label(p)).toEqual(['[Dialogue 2]', 'Rain', '[Music 0]']);
    p = removeFolder(p, fid(p, 'Dialogue'));
    expect(label(p)).toEqual(['Anna', 'Ben', 'Rain', '[Music 0]']);
    expect(p.tracks.every((t) => !t.folderId)).toBe(true);
  });

  it('mutes and solos whole groups', () => {
    let p = withTracks('Anna', 'Ben', 'Rain', 'Theme');
    p = addFolder(p, { name: 'Dialogue', trackIds: [id(p, 'Anna'), id(p, 'Ben')] });
    p = addFolder(p, { name: 'Atmo', trackIds: [id(p, 'Rain')] });
    const audible = (q: Project) => names({ ...q, tracks: audibleTracks(q) });
    expect(audible(p)).toEqual(['Anna', 'Ben', 'Rain', 'Theme']);
    p = updateFolder(p, fid(p, 'Dialogue'), { mute: true });
    expect(audible(p)).toEqual(['Rain', 'Theme']);
    // folder solo lets its tracks through; a soloed track elsewhere still plays
    p = updateFolder(p, fid(p, 'Dialogue'), { mute: false, solo: true });
    expect(audible(p)).toEqual(['Anna', 'Ben']);
    p.tracks.find((t) => t.name === 'Theme')!.solo = true;
    expect(audible(p)).toEqual(['Anna', 'Ben', 'Theme']);
    // a track muted on its own stays muted inside a soloed folder
    p.tracks.find((t) => t.name === 'Ben')!.mute = true;
    expect(audible(p)).toEqual(['Anna', 'Theme']);
  });

  it('adds the folder volume to its tracks in the mixer', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    writeWavFile(path.join(dir, 'media/dc.wav'), [new Float32Array(4800).fill(0.25)], 48000);
    let p = withTracks('Rain');
    p.tracks[0].clips.push({ id: 'c', file: 'media/dc.wav', start: 0, offset: 0, length: 4800, gain: 0, fadeIn: 0, fadeOut: 0 });
    const render = (q: Project) => {
      const readers = new ReaderCache(dir);
      const out = new Mixer(q, readers).render(0, 4800, [new Float32Array(4800), new Float32Array(4800)]);
      readers.closeAll();
      return out[0][100];
    };
    const plain = render(p);
    p = addFolder(p, { name: 'Atmo', trackIds: [p.tracks[0].id], gain: -6 });
    expect(folderGainOf(p, p.tracks[0])).toBe(-6);
    expect(render(p) / plain).toBeCloseTo(10 ** (-6 / 20), 4);
    p = updateFolder(p, p.folders![0].id, { gain: 40 });
    expect(p.folders![0].gain).toBe(12);
  });

  it('survives saving: normalises, drops broken links and keeps folders in templates', () => {
    let p = withTracks('Anna', 'Rain', 'Ben');
    p = addDramaFolders(p);
    expect(p.folders!.map((f) => f.name)).toEqual(['Dialogue', 'SFX', 'Atmo', 'Music']);
    expect(addDramaFolders(p).folders!.length).toBe(4);
    p = setTrackFolder(p, id(p, 'Anna'), fid(p, 'Dialogue'));
    p = setTrackFolder(p, id(p, 'Ben'), fid(p, 'Dialogue'));
    const raw = JSON.parse(JSON.stringify(p)) as Project;
    // hand-edited: members apart, a link to a folder that's gone, a folder without defaults
    raw.tracks = [raw.tracks[0], raw.tracks[2], raw.tracks[1]].map((t) => t);
    raw.tracks[1].folderId = 'fld_gone';
    raw.folders!.push({ id: 'fld_x', name: '' } as never);
    const n = normalizeProject(raw);
    expect(names(n)).toEqual(['Anna', 'Ben', 'Rain']);
    expect(n.tracks[2].folderId).toBeUndefined();
    expect(n.folders!.at(-1)).toMatchObject({ id: 'fld_x', name: 'Folder 5', mute: false, solo: false, gain: 0 });

    const solo = updateFolder(p, fid(p, 'Dialogue'), { solo: true, gain: -3 });
    const t = projectToTemplate(solo, 'Drama');
    expect(t.folders!.find((f) => f.name === 'Dialogue')).toMatchObject({ solo: false, gain: -3 });
    const fresh = projectFromTemplate(t, 'Episode 2', 48000);
    expect(fresh.folders!.length).toBe(4);
    expect(fresh.tracks.filter((x) => x.folderId === fid(fresh, 'Dialogue')).map((x) => x.name)).toEqual(['Anna', 'Ben']);
  });
});

describe('folder MCP tools', () => {
  function host() {
    let project = withTracks('Anna', 'Rain', 'Ben');
    const summaries: string[] = [];
    const h: WavePodHost = {
      project: () => project,
      dir: () => '/tmp/x',
      transportState: () => 'stopped',
      apply: (next, summary) => {
        project = next;
        summaries.push(summary);
      },
      measureLoudness: async () => [],
      vst: null,
    };
    return { h, summaries, get project() { return project; } };
  }
  async function call(fake: ReturnType<typeof host>, name: string, args: Record<string, unknown>) {
    const res = await createWavePodServer(fake.h, '1').handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const r = res!.result as { content: Array<{ text: string }>; isError: boolean };
    let data: any = r.content[0].text;
    try {
      data = JSON.parse(data);
    } catch {
      /* error text */
    }
    return { isError: r.isError, data };
  }

  it('creates, fills, changes and removes folders', async () => {
    const fake = host();
    let r = await call(fake, 'create_folder', { name: 'Dialogue', tracks: ['Anna', 'Ben'] });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ name: 'Dialogue', tracks: ['Anna', 'Ben'] });
    expect((await call(fake, 'create_folder', { name: 'dialogue' })).isError).toBe(true);
    r = await call(fake, 'update_folder', { folder: 'Dialogue', mute: true, gainDb: -4.5 });
    expect(r.data).toMatchObject({ mute: true, gainDb: -4.5 });
    expect(audibleTracks(fake.project).map((t) => t.name)).toEqual(['Rain']);
    r = await call(fake, 'create_folder', { name: 'Atmo' });
    r = await call(fake, 'move_tracks_to_folder', { tracks: ['Rain'], folder: 'Atmo' });
    expect(r.data.tracks.find((t: { name: string }) => t.name === 'Rain').folder).toBe('Atmo');
    r = await call(fake, 'list_tracks', {});
    expect(r.data.folders.map((f: { name: string }) => f.name)).toEqual(['Dialogue', 'Atmo']);
    expect(r.data.tracks[0].folder).toBe('Dialogue');
    r = await call(fake, 'move_tracks_to_folder', { tracks: ['Rain'], folder: null });
    expect(fake.project.tracks.find((t) => t.name === 'Rain')!.folderId).toBeUndefined();
    expect((await call(fake, 'update_folder', { folder: 'Nope', mute: true })).isError).toBe(true);
    r = await call(fake, 'remove_folder', { folder: 'Dialogue' });
    expect(r.data.removed).toBe('Dialogue');
    expect(fake.project.folders!.map((f) => f.name)).toEqual(['Atmo']);
    expect(fake.summaries.at(-1)).toBe('Removed folder Dialogue');
  });
});
