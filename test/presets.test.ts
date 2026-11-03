import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FX_DEFINITIONS, createFx, normalizeFx } from '../src/core/fx/definitions';
import { applyPreset, factoryPresets, normalizePreset, paramSignature, presetEdited, presetFromFx, presetKey } from '../src/core/fx/presets';
import { createPresetLibrary, type ProgramHost } from '../src/core/fx/presetLibrary';
import { createVstFx, loadVstProgram, visibleVstParams, type VstHost, type VstInstance } from '../src/core/fx/vst';
import { deleteUserPreset, listUserPresets, loadUserPreset, renameUserPreset, saveUserPreset } from '../src/main/presetStore';
import { createWavePodServer, type WavePodHost } from '../src/core/mcp/tools';
import { addTrack, createProject, normalizeProject } from '../src/core/project';
import { fxList, insertFx } from '../src/core/fx/stack';
import type { Fx, Project, VstParamInfo } from '../src/shared/types';
import { VST_PARAM_BYPASS, VST_PARAM_PROGRAM_CHANGE } from '../src/shared/types';
import { tmpDir } from './helpers';

const PLUGIN = { path: '/vst3/Clean.vst3', cid: 'ABCDEF0123456789ABCDEF0123456789', name: 'Clean EQ', vendor: 'Acme' };
const VST_PARAMS: Array<VstParamInfo & { value: number }> = [
  { id: 1, title: 'Gain', units: 'dB', steps: 0, default: 0.5, flags: 0, value: 0.5 },
  { id: 2, title: 'Mode', units: '', steps: 2, default: 0, flags: 0, value: 0 },
  { id: 7, title: 'Program', units: '', steps: 3, default: 0, flags: VST_PARAM_PROGRAM_CHANGE | (1 << 3), value: 0 },
  { id: 99, title: 'Bypass', units: '', steps: 1, default: 0, flags: VST_PARAM_BYPASS, value: 0 },
];
const vstFx = () => createVstFx(PLUGIN, { params: VST_PARAMS, state: 'c3RhdGU=' });

/** Programs of the fake plug-in: program n sets Gain to n/3. */
const programs: ProgramHost = {
  names: (_fx, _id, steps) => Array.from({ length: steps + 1 }, (_, i) => ['Clean', 'Warm', 'Radio', ''][i]),
  load: (_fx, _id, value) => ({ state: btoa(`program ${value}`), values: [{ id: 1, value }, { id: 2, value: 1 }, { id: 7, value }] }),
};

describe('filter presets', () => {
  it('keeps the program selector out of the sliders but remembers it', () => {
    const fx = vstFx();
    expect(visibleVstParams(fx.paramInfo!).map((p) => p.id)).toEqual([1, 2]);
    expect(fx.paramInfo!.some((p) => p.id === 7)).toBe(true);
    expect(Object.keys(fx.params)).toEqual(['1', '2']);
  });

  it('has valid factory presets for every built-in filter, starting with Default', () => {
    for (const d of FX_DEFINITIONS) {
      const list = factoryPresets(d.type);
      expect(list[0].preset.name).toBe('Default');
      expect(list[0].preset.params).toEqual(createFx(d.type).params);
      for (const { preset } of list) {
        // nothing was clamped: every value is inside its range
        const raw = normalizePreset({ ...preset });
        expect(raw!.params).toEqual(preset.params);
        for (const spec of d.params) expect(preset.params[spec.key]).toBeGreaterThanOrEqual(spec.min);
      }
    }
  });

  it('applies a preset, marks the filter with it and notices later edits', () => {
    const fx = { ...createFx('compressor'), enabled: false };
    const preset = factoryPresets('compressor').find((p) => p.preset.name === 'Broadcast')!;
    const next = applyPreset(fx, preset.preset, { id: preset.id, name: 'Broadcast' });
    expect(next.id).toBe(fx.id);
    expect(next.enabled).toBe(false);
    expect(next.params.ratio).toBe(4);
    expect(next.preset).toMatchObject({ id: preset.id, name: 'Broadcast' });
    expect(presetEdited(next)).toBe(false);
    expect(presetEdited({ ...next, params: { ...next.params, ratio: 5 } })).toBe(true);
    // order of keys does not matter
    expect(paramSignature({ a: 1, b: 2 })).toBe(paramSignature({ b: 2, a: 1 }));
    // presets for another filter type are refused
    expect(() => applyPreset(createFx('gate'), preset.preset, { id: preset.id, name: 'x' })).toThrow(/different filter/);
    // and the reference survives saving and loading a project
    const project = insertFx(addTrack(createProject('E'), { name: 'Host' }), 'x', next);
    const loaded = normalizeProject(JSON.parse(JSON.stringify({ ...project, masterFx: [next] })) as Project);
    expect(loaded.masterFx![0].preset).toEqual(next.preset);
  });

  it('stores a VST3 preset with the state and restores only the slider values plus the state', () => {
    const fx = { ...vstFx(), params: { '1': 0.8, '2': 0.5, '7': 0.33 }, state: 'bXlzdGF0ZQ==' };
    const preset = presetFromFx(fx, '  Loud ');
    expect(preset).toMatchObject({ name: 'Loud', type: 'vst3', plugin: { cid: PLUGIN.cid }, state: 'bXlzdGF0ZQ==' });
    const other = { ...vstFx(), params: { '1': 0.1, '2': 0, '7': 1 } };
    const next = applyPreset(other, preset, { id: 'user:x/Loud', name: 'Loud' });
    expect(next.params).toEqual({ '1': 0.8, '2': 0.5 });
    expect(next.state).toBe('bXlzdGF0ZQ==');
    // another plug-in's preset does not fit
    expect(presetKey({ ...other, plugin: { ...PLUGIN, cid: '00000000000000000000000000000000' } })).not.toBe(presetKey(other));
  });
});

describe('preset files', () => {
  it('saves, lists per filter, replaces by name, renames and deletes', () => {
    const root = tmpDir('wavepod-presets-');
    const comp = createFx('compressor', { ratio: 6 });
    const saved = saveUserPreset(root, presetFromFx(comp, 'My voice'));
    expect(saved).toMatchObject({ name: 'My voice', source: 'user', replaced: false });
    expect(fs.existsSync(path.join(root, 'Compressor', 'My voice.json'))).toBe(true);
    saveUserPreset(root, presetFromFx(createFx('gate'), 'My voice'));
    saveUserPreset(root, presetFromFx(vstFx(), 'My voice'));

    expect(listUserPresets(root, comp).map((p) => p.name)).toEqual(['My voice']);
    expect(listUserPresets(root, vstFx())).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'Clean EQ', 'My voice.json'))).toBe(true);

    // same name (any case) for the same filter replaces it
    const again = saveUserPreset(root, presetFromFx(createFx('compressor', { ratio: 8 }), 'my VOICE'));
    expect(again).toMatchObject({ id: saved.id, replaced: true });
    expect(loadUserPreset(root, saved.id).params.ratio).toBe(8);

    // a name that is not a valid file name still works
    const odd = saveUserPreset(root, presetFromFx(comp, 'A/B: test?'));
    expect(listUserPresets(root, comp).map((p) => p.name)).toEqual(['A/B: test?', 'my VOICE']);

    const renamed = renameUserPreset(root, odd.id, 'Radio');
    expect(listUserPresets(root, comp).map((p) => p.name)).toEqual(['my VOICE', 'Radio']);
    expect(() => renameUserPreset(root, renamed.id, 'My Voice')).toThrow(/already/);
    // a case-only rename keeps the preset
    const cased = renameUserPreset(root, renamed.id, 'RADIO');
    expect(loadUserPreset(root, cased.id).name).toBe('RADIO');

    deleteUserPreset(root, cased.id);
    deleteUserPreset(root, saved.id);
    expect(listUserPresets(root, comp)).toEqual([]);
    expect(fs.existsSync(path.join(root, 'Compressor'))).toBe(false);
    expect(() => loadUserPreset(root, 'user:../../etc/passwd')).toThrow(/Invalid/);
    expect(() => deleteUserPreset(root, 'factory:gate/Default')).toThrow(/not one of your presets/);
  });

  it('skips files that are not presets', () => {
    const root = tmpDir('wavepod-presets-');
    fs.mkdirSync(path.join(root, 'Gate'));
    fs.writeFileSync(path.join(root, 'Gate', 'broken.json'), '{nope');
    fs.writeFileSync(path.join(root, 'Gate', 'other.json'), JSON.stringify({ type: 'reverb', params: {} }));
    fs.writeFileSync(path.join(root, 'Gate', 'hand made.json'), JSON.stringify({ type: 'gate', params: { threshold: -200 } }));
    const list = listUserPresets(root, createFx('gate'));
    expect(list.map((p) => p.name)).toEqual(['hand made']);
    expect(loadUserPreset(root, list[0].id).params.threshold).toBe(-80);
  });
});

describe('preset library', () => {
  const library = (root: string, withPrograms = true) =>
    createPresetLibrary(
      { list: (fx) => listUserPresets(root, fx), load: (id) => loadUserPreset(root, id), save: (p) => saveUserPreset(root, p) },
      withPrograms ? programs : null,
    );

  it('offers factory presets, then user presets, and saves the current settings', async () => {
    const root = tmpDir('wavepod-presets-');
    const lib = library(root);
    const fx = createFx('deesser', { freq: 9000 });
    const saved = await lib.save(fx, 'Sibilant guest');
    expect(saved.fx.preset).toMatchObject({ id: saved.entry.id, name: 'Sibilant guest' });
    expect(presetEdited(saved.fx)).toBe(false);
    const list = await lib.list(createFx('deesser'));
    expect(list[0]).toMatchObject({ name: 'Default', source: 'factory' });
    expect(list.at(-1)).toMatchObject({ name: 'Sibilant guest', source: 'user' });
    const loaded = await lib.apply(createFx('deesser'), saved.entry.id);
    expect(loaded.params.freq).toBe(9000);
    const reset = await lib.apply(loaded, list[0].id);
    expect(reset.params).toEqual(createFx('deesser').params);
  });

  it("lists a plug-in's programs and loads one through the host", async () => {
    const lib = library(tmpDir('wavepod-presets-'));
    const fx = vstFx();
    const list = await lib.list(fx);
    expect(list.map((p) => [p.name, p.source])).toEqual([
      ['Clean', 'program'],
      ['Warm', 'program'],
      ['Radio', 'program'],
      ['Program 4', 'program'],
    ]);
    const next = await lib.apply(fx, list[2].id);
    expect(next.params).toEqual({ '1': 2 / 3, '2': 1 });
    expect(next.state).toBe(btoa(`program ${2 / 3}`));
    expect(next.preset?.name).toBe('Radio');
    await expect(lib.apply(fx, 'program:9')).rejects.toThrow(/no program 10/);
    // without a host there are no programs
    expect(await library(tmpDir('wavepod-presets-'), false).list(fx)).toEqual([]);
  });

  it('loads a program on a scratch instance: state first, then the program, then reads back', () => {
    const calls: string[] = [];
    const inst: VstInstance = {
      latency: 0,
      params: VST_PARAMS,
      alive: true,
      setParams: (c) => void calls.push(`params ${JSON.stringify(c)}`),
      process: () => void calls.push('process'),
      reset: () => {},
      setState: (s) => (calls.push(`setState ${s.length}`), [{ id: 1, value: 0.1 }]),
      getState: () => (calls.push('getState'), new Uint8Array([1, 2, 3])),
      values: () => (calls.push('values'), [{ id: 1, value: 0.9 }]),
      format: () => '',
      destroy: () => void calls.push('destroy'),
    };
    const host: VstHost = { create: () => inst };
    const r = loadVstProgram(host, vstFx(), 48000, 7, 1 / 3);
    expect(r).toEqual({ state: 'AQID', values: [{ id: 1, value: 0.9 }] });
    expect(calls).toEqual(['setState 5', 'params [[7,0.3333333333333333]]', 'process', 'process', 'values', 'getState', 'destroy']);
    // an older host without VALUES: reload the state to read the values
    const old = loadVstProgram({ create: () => ({ ...inst, values: () => null }) }, vstFx(), 48000, 7, 0);
    expect(old.values).toEqual([{ id: 1, value: 0.1 }]);
  });
});

describe('preset MCP tools', () => {
  function setup() {
    const root = tmpDir('wavepod-presets-');
    let project: Project = addTrack(createProject('E'), { name: 'Host' });
    const trackId = project.tracks[0].id;
    project = insertFx(insertFx(project, trackId, createFx('compressor')), trackId, vstFx());
    const summaries: string[] = [];
    const host: WavePodHost = {
      project: () => project,
      dir: () => '/tmp/e',
      transportState: () => 'stopped',
      apply: (next, summary) => {
        project = next;
        summaries.push(summary);
      },
      measureLoudness: async () => [],
      presets: createPresetLibrary({ list: (fx) => listUserPresets(root, fx), load: (id) => loadUserPreset(root, id), save: (p) => saveUserPreset(root, p) }, programs),
      vst: null,
    };
    return { server: createWavePodServer(host, '1'), summaries, trackId, get project() { return project; } };
  }

  async function call(server: ReturnType<typeof createWavePodServer>, name: string, args: Record<string, unknown>) {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const result = res!.result as { content: Array<{ text: string }>; isError: boolean };
    let data: any = result.content[0].text;
    try {
      data = JSON.parse(data);
    } catch {
      /* text */
    }
    return { isError: result.isError, data };
  }

  it('lists, applies by name and saves presets', async () => {
    const s = setup();
    let r = await call(s.server, 'list_filter_presets', { target: 'Host', filter: 'compressor' });
    expect(r.data.presets.map((p: { name: string }) => p.name)).toEqual(['Default', 'Gentle voice', 'Broadcast', 'Leveler']);

    r = await call(s.server, 'apply_filter_preset', { target: 'Host', filter: 'compressor', preset: 'broadcast' });
    expect(r.isError).toBe(false);
    expect(r.data.filter.preset).toEqual({ name: 'Broadcast', edited: false });
    expect(fxList(s.project, s.trackId)[0].params.ratio).toBe(4);
    expect(s.summaries.at(-1)).toBe('Loaded preset "Broadcast" into Compressor on Host');

    await call(s.server, 'update_filter', { target: 'Host', filter: 'compressor', params: { ratio: 5 } });
    r = await call(s.server, 'save_filter_preset', { target: 'Host', filter: 'compressor', name: 'Mine' });
    expect(r.data).toMatchObject({ saved: { name: 'Mine' }, replaced: false });
    r = await call(s.server, 'list_filter_presets', { target: 'Host', filter: 'compressor' });
    expect(r.data.filter.preset).toEqual({ name: 'Mine', edited: false });
    expect(r.data.presets.at(-1)).toMatchObject({ name: 'Mine', source: 'user' });

    r = await call(s.server, 'apply_filter_preset', { target: 'Host', filter: 'Clean EQ', preset: 'Warm' });
    expect(r.isError).toBe(false);
    expect(fxList(s.project, s.trackId)[1].params['1']).toBeCloseTo(1 / 3);

    r = await call(s.server, 'apply_filter_preset', { target: 'Host', filter: 'compressor', preset: 'Nope' });
    expect(r.isError).toBe(true);
    expect(r.data).toMatch(/"Broadcast"/);
  });

  it('keeps old filters whose program selector was a slider working', () => {
    const fx = normalizeFx({ ...vstFx(), params: { '1': 0.5, '2': 0, '7': 0.66 } }) as Fx;
    expect(visibleVstParams(fx.paramInfo!).map((p) => p.id)).toEqual([1, 2]);
  });
});
