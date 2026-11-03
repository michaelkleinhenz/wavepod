import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '../src/core/mcp/protocol';
import { createWavePodServer, type WavePodHost } from '../src/core/mcp/tools';
import { addTrack, createProject } from '../src/core/project';
import { fxList } from '../src/core/fx/stack';
import { startMcpHttpServer, type McpHttpServer } from '../src/main/mcp/httpServer';
import type { Fx, Project, VstParamInfo, VstPluginInfo } from '../src/shared/types';
import { VST_PARAM_BYPASS } from '../src/shared/types';

const PLUGIN: VstPluginInfo = { path: '/vst3/Clean.vst3', cid: 'ABCDEF0123456789ABCDEF0123456789', name: 'Clean EQ', vendor: 'Acme', version: '1.0', categories: 'Fx|EQ' };

function fakeHost(withVst = true) {
  let project: Project = addTrack(addTrack(createProject('Episode 1'), { name: 'Host' }), { name: 'Guest' });
  const summaries: string[] = [];
  const params: Array<VstParamInfo & { value: number }> = [
    { id: 1, title: 'Gain', units: 'dB', steps: 0, default: 0.5, flags: 0, value: 0.5 },
    { id: 2, title: 'Mode', units: '', steps: 2, default: 0, flags: 0, value: 0 },
    { id: 99, title: 'Bypass', units: '', steps: 1, default: 0, flags: VST_PARAM_BYPASS, value: 0 },
  ];
  const host: WavePodHost = {
    project: () => project,
    dir: () => '/tmp/episode-1',
    transportState: () => 'stopped',
    apply: (next, summary) => {
      project = next;
      summaries.push(summary);
    },
    measureLoudness: async () => [
      { kind: 'mix', id: 'mix', name: 'Mix', stats: { integrated: -16.04, range: 4.2, shortTermMax: -12, momentaryMax: -10, truePeak: -1.03, samplePeak: -1.2, duration: 61, history: [1, 2], historyStep: 1 } },
    ],
    vst: withVst
      ? {
          scan: () => [PLUGIN],
          describe: () => ({ params, state: 'c3RhdGU=' }),
          format: (_fx: Fx, id: number, value: number) => (id === 1 ? `${((value - 0.5) * 24).toFixed(1)} dB` : ''),
        }
      : null,
  };
  return { host, summaries, get project() { return project; } };
}

async function call(server: McpServer, name: string, args: Record<string, unknown> = {}) {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const result = res!.result as { content: Array<{ text: string }>; isError: boolean };
  const text = result.content[0].text;
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* plain text error */
  }
  return { isError: result.isError, text, data: data as any };
}

describe('MCP protocol', () => {
  it('initializes, negotiates the protocol version and lists tools', async () => {
    const { host } = fakeHost();
    const server = createWavePodServer(host, '1.2.3');
    const init = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wavepod', version: '1.2.3' } });
    const old = await server.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((old!.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    const list = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (list!.result as { tools: Array<{ name: string; inputSchema: { type: string } }> }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_filter_stack', 'add_filter', 'update_filter', 'remove_filter', 'move_filter', 'apply_voice_chain', 'set_filter_stack', 'copy_filter_stack', 'list_tracks', 'measure_loudness']));
    const unknown = await server.handle({ jsonrpc: '2.0', id: 3, method: 'nope' });
    expect(unknown!.error!.code).toBe(-32601);
  });
});

describe('WavePod MCP tools', () => {
  it('lists tracks and the master bus', async () => {
    const { host } = fakeHost();
    const r = await call(createWavePodServer(host, '1'), 'list_tracks');
    expect(r.data.tracks.map((t: { name: string }) => t.name)).toEqual(['Host', 'Guest']);
    expect(r.data.master.id).toBe('master');
  });

  it('applies the voice chain, then edits, moves and removes filters by type or id', async () => {
    const h = fakeHost();
    const server = createWavePodServer(h.host, '1');
    let r = await call(server, 'apply_voice_chain', { target: 'host' });
    expect(r.isError).toBe(false);
    expect(r.data.filters.map((f: { type: string }) => f.type)).toEqual(['highpass', 'deesser', 'dynamics']);
    expect(h.summaries).toEqual(['Applied the voice chain to Host']);

    r = await call(server, 'update_filter', { target: 'Host', filter: 'highpass', params: { freq: 100, slope: 20 } });
    expect(r.isError).toBe(false);
    const hostId = h.project.tracks[0].id;
    expect(fxList(h.project, hostId)[0].params).toEqual({ freq: 100, slope: 24 });
    expect(r.data.notes[0]).toMatch(/slope set to 24/);

    r = await call(server, 'update_filter', { target: hostId, filter: 'Ultraschall Dynamics', params: { target: -30 }, enabled: false });
    const dyn = fxList(h.project, hostId)[2];
    expect(dyn.params.target).toBe(-25);
    expect(dyn.enabled).toBe(false);

    r = await call(server, 'move_filter', { target: 'Host', filter: dyn.id, position: 0 });
    expect(r.data.filters[0].id).toBe(dyn.id);

    r = await call(server, 'remove_filter', { target: 'Host', filter: 'deesser' });
    expect(r.data.filters.map((f: { type: string }) => f.type)).toEqual(['dynamics', 'highpass']);
  });

  it('reports helpful errors the agent can act on', async () => {
    const { host } = fakeHost();
    const server = createWavePodServer(host, '1');
    let r = await call(server, 'get_filter_stack', { target: 'Nobody' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/"Host"/);
    r = await call(server, 'add_filter', { target: 'Host', type: 'reverb' });
    expect(r.text).toMatch(/Unknown filter type/);
    r = await call(server, 'add_filter', { target: 'Host', type: 'compressor', params: { nonsense: 1 } });
    expect(r.text).toMatch(/no parameter "nonsense"/);
    await call(server, 'add_filter', { target: 'Host', type: 'compressor' });
    await call(server, 'add_filter', { target: 'Host', type: 'compressor' });
    r = await call(server, 'update_filter', { target: 'Host', filter: 'compressor', params: { ratio: 4 } });
    expect(r.text).toMatch(/several "compressor"/);
  });

  it('adds VST3 plug-ins and sets normalized parameters by title', async () => {
    const h = fakeHost();
    const server = createWavePodServer(h.host, '1');
    let r = await call(server, 'add_filter', { target: 'master', type: 'vst3', plugin: 'clean', params: { Gain: 0.75 } });
    expect(r.isError).toBe(false);
    const fx = h.project.masterFx![0];
    expect(fx.plugin?.cid).toBe(PLUGIN.cid);
    expect(fx.state).toBe('c3RhdGU=');
    expect(fx.params).toEqual({ '1': 0.75, '2': 0 });
    expect(r.data.filters[0].params[0]).toMatchObject({ id: 1, title: 'Gain', value: 0.75, text: '6.0 dB' });
    // stepped parameters snap; the bypass parameter is not offered
    r = await call(server, 'update_filter', { target: 'master', filter: 'Clean EQ', params: { '2': 0.4 } });
    expect(h.project.masterFx![0].params['2']).toBe(0.5);
    r = await call(server, 'update_filter', { target: 'master', filter: fx.id, params: { Bypass: 1 } });
    expect(r.isError).toBe(true);
  });

  it('says so when VST3 is not available', async () => {
    const { host } = fakeHost(false);
    const r = await call(createWavePodServer(host, '1'), 'add_filter', { target: 'Host', type: 'vst3', plugin: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not included/);
  });

  it('builds a stack in one step and copies it to another track', async () => {
    const h = fakeHost();
    const server = createWavePodServer(h.host, '1');
    let r = await call(server, 'set_filter_stack', {
      target: 'Host',
      filters: [{ type: 'highpass', params: { freq: 90 } }, { type: 'compressor', params: { ratio: 2.5 }, enabled: false }, { type: 'vst3', plugin: PLUGIN.cid }],
    });
    expect(r.isError).toBe(false);
    expect(h.summaries).toHaveLength(1);
    r = await call(server, 'copy_filter_stack', { from: 'Host', to: 'Guest' });
    const [host, guest] = h.project.tracks;
    expect(guest.fx!.map((f) => f.type)).toEqual(['highpass', 'compressor', 'vst3']);
    expect(guest.fx![1].enabled).toBe(false);
    expect(guest.fx!.map((f) => f.id)).not.toEqual(host.fx!.map((f) => f.id));
    // a bad entry leaves the stack untouched
    r = await call(server, 'set_filter_stack', { target: 'Guest', filters: [{ type: 'gate' }, { type: 'bogus' }] });
    expect(r.text).toMatch(/filters\[1\]/);
    expect(h.project.tracks[1].fx).toHaveLength(3);
    r = await call(server, 'set_filter_stack', { target: 'Guest', filters: [] });
    expect(h.project.tracks[1].fx).toEqual([]);
  });

  it('measures loudness without the curve and with finite numbers', async () => {
    const { host } = fakeHost();
    const r = await call(createWavePodServer(host, '1'), 'measure_loudness');
    expect(r.data.reports[0]).toEqual({ kind: 'mix', id: 'mix', name: 'Mix', integratedLufs: -16, rangeLu: 4.2, shortTermMaxLufs: -12, momentaryMaxLufs: -10, truePeakDbtp: -1, samplePeakDbfs: -1.2, durationSeconds: 61 });
  });
});

describe('MCP over HTTP', () => {
  let http: McpHttpServer | null = null;
  afterEach(async () => {
    await http?.close();
    http = null;
  });

  it('answers JSON-RPC on 127.0.0.1 and rejects browsers from other origins', async () => {
    http = await startMcpHttpServer(createWavePodServer(fakeHost().host, '1'), 0);
    expect(http.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(http!.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) });

    let res = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe('wavepod');

    res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);

    res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_filter_stack', arguments: { target: 'master' } } });
    expect(((await res.json()) as { result: { isError: boolean } }).result.isError).toBe(false);

    res = await post({ jsonrpc: '2.0', id: 3, method: 'ping' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);

    expect((await fetch(http.url)).status).toBe(405);
    expect((await fetch(http.url.replace('/mcp', '/other'), { method: 'POST', body: '{}' })).status).toBe(404);
    res = await fetch(http.url, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('fails clearly when the port is taken', async () => {
    http = await startMcpHttpServer(new McpServer({ name: 'a', version: '1' }), 0);
    await expect(startMcpHttpServer(new McpServer({ name: 'b', version: '1' }), http.port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
