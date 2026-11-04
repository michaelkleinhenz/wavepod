// Integration test for the VST3 host helper, run against the SDK's sample plug-ins.
// Skipped unless native/vsthost was built with -DWAVEPOD_VST3_SAMPLES=ON.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as esbuild from 'esbuild';
import { VstHostProcess, vstHostExecutable } from '../src/main/vst/host';
import { scanVstPlugins } from '../src/main/vst/scan';
import { VstProcessor, createVstFx, loadVstProgram, setVstHost, visibleVstParams, vstFailures, vstProgramParam } from '../src/core/fx/vst';
import { createPresetLibrary } from '../src/core/fx/presetLibrary';
import type { Fx } from '../src/shared/types';

const root = resolve(__dirname, '..');
const exe = vstHostExecutable(root);
const plugins = join(root, 'native/vsthost/build/VST3/Release');
const again = join(plugins, 'again-sample-accurate.vst3');
const ready = !!exe && existsSync(again);

describe.skipIf(!ready)('VST3 host helper', () => {
  let dir: string;
  let bridge: string;
  let host: VstHostProcess;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wavepod-vst-'));
    bridge = join(dir, 'vstBridge.js');
    await esbuild.build({ entryPoints: [join(root, 'src/main/vst/bridgeWorker.ts')], outfile: bridge, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
    host = new VstHostProcess(exe!, bridge);
  });

  afterAll(() => {
    host?.dispose();
    setVstHost(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('scans modules into plug-in entries', async () => {
    const found = await scanVstPlugins(exe!, [plugins], join(dir, 'cache.json'), true);
    const names = found.map((p) => p.name);
    expect(names).toContain('ADelay');
    expect(names).toContain('AGain Sample Accurate');
    expect(found.every((p) => /^[0-9A-F]{32}$/.test(p.cid))).toBe(true);
  });

  it('loads a plug-in, lists parameters, changes gain and formats values', async () => {
    const [plugin] = (await scanVstPlugins(exe!, [plugins], join(dir, 'c2.json'), true)).filter((p) => p.name === 'AGain Sample Accurate');
    const inst = host.create({ plugin }, 48000, 1024);
    expect(inst.params.length).toBeGreaterThan(0);
    const gain = inst.params.find((p) => /gain/i.test(p.title))!;
    expect(gain).toBeTruthy();

    const n = 512;
    const run = () => {
      const L = new Float32Array(n).fill(0.5);
      const R = new Float32Array(n).fill(0.5);
      inst.process(L, R, n);
      return L[n - 1];
    };
    inst.setParams([[gain.id, 0]]);
    run();
    expect(Math.abs(run())).toBeLessThan(0.01);
    inst.setParams([[gain.id, 1]]);
    run();
    expect(run()).toBeGreaterThan(0.1);
    expect(inst.format(gain.id, 0.5).length).toBeGreaterThan(0);
    // typed text back to a normalized value, through the plug-in's own parser
    const shown = inst.format(gain.id, 0.5);
    const parsed = inst.parse!(gain.id, shown);
    expect(parsed).not.toBeNull();
    expect(inst.format(gain.id, parsed!)).toBe(shown);

    // state round trip
    const state = inst.getState();
    expect(state.length).toBeGreaterThan(0);
    inst.setParams([[gain.id, 0]]);
    const restored = inst.setState(state);
    expect(restored.find((p) => p.id === gain.id)?.value).toBeCloseTo(1, 3);
    inst.destroy();
  });

  it('runs a plug-in as a filter in the stack, bypassing it if loading fails', async () => {
    const [plugin] = (await scanVstPlugins(exe!, [plugins], join(dir, 'c3.json'), true)).filter((p) => p.name === 'AGain Sample Accurate');
    setVstHost(host);
    const fx: Fx = { id: 'fx1', type: 'vst3', enabled: true, plugin, params: {} };
    const proc = new VstProcessor(fx, 48000);
    const gainId = 1;
    proc.setParams({ [gainId]: 0.5 });
    // longer than one host block, so it is split into chunks
    const n = 6000;
    const L = new Float32Array(n).fill(0.8);
    const R = new Float32Array(n).fill(0.8);
    proc.process(L, R, n);
    expect(vstFailures().get('fx1')).toBeUndefined();
    expect(L[n - 1]).toBeCloseTo(0.4, 2);
    expect(R[n - 1]).toBeCloseTo(0.4, 2);
    proc.dispose?.();

    const broken = new VstProcessor({ ...fx, id: 'fx2', plugin: { ...plugin, path: join(dir, 'missing.vst3') } }, 48000);
    expect(vstFailures().get('fx2')).toBeTruthy();
    const X = new Float32Array(64).fill(0.25);
    broken.process(X, X.slice(), 64);
    expect(X[10]).toBeCloseTo(0.25);
  });

  it("offers a plug-in's programs as presets and loads one", async () => {
    const [plugin] = (await scanVstPlugins(exe!, [plugins], join(dir, 'c4.json'), true)).filter((p) => p.name === 'Test Program Change');
    expect(plugin).toBeTruthy();
    const probe = host.create({ plugin }, 48000, 1024);
    const state = Buffer.from(probe.getState()).toString('base64');
    const desc = { params: probe.params, state };
    const program = vstProgramParam(probe.params)!;
    expect(program).toBeTruthy();
    const fx = createVstFx(plugin, desc);
    // the program selector gets no slider
    expect(visibleVstParams(fx.paramInfo!).some((p) => p.id === program.id)).toBe(false);

    const library = createPresetLibrary(
      { list: () => [], load: () => Promise.reject(new Error('none')), save: () => Promise.reject(new Error('none')) },
      {
        names: (_fx, id, steps) => Array.from({ length: steps + 1 }, (_, i) => probe.format(id, steps ? i / steps : 0)),
        load: (f, id, value) => loadVstProgram(host, f, 48000, id, value),
      },
    );
    const list = await library.list(fx);
    expect(list.length).toBe(program.steps + 1);
    expect(list[1].name).toBe('Prog 2');
    // the sample uses the program number as its gain
    const next = await library.apply(fx, list[program.steps].id);
    const gain = visibleVstParams(fx.paramInfo!).find((p) => /gain/i.test(p.title))!;
    expect(next.params[String(gain.id)]).toBeCloseTo(1, 3);
    expect(next.state).not.toBe(fx.state);
    expect(next.preset?.name).toBe(list[program.steps].name);
    probe.destroy();
  });

  it('describes the helper on the command line', () => {
    const out = execFileSync(exe!, ['--scan-module', again]).toString();
    expect(JSON.parse(out).length).toBe(2);
  });
});
