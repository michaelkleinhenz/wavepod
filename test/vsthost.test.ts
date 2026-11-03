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
import { VstProcessor, setVstHost, vstFailures } from '../src/core/fx/vst';
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

  it('describes the helper on the command line', () => {
    const out = execFileSync(exe!, ['--scan-module', again]).toString();
    expect(JSON.parse(out).length).toBe(2);
  });
});
