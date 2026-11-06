// The tools WavePod offers to AI agents over MCP: reading the project and editing filter stacks.
// Every edit goes through the app (one undo step each), so it shows up in the FX panel at once.
import type { FileTranscript, Fx, FxType, LoudnessReport, LoudnessStats, Project, TransportState, VstParamInfo, VstPluginInfo, VstPluginRef } from '../../shared/types';
import { FX_DEFINITIONS, createFx, fxDefinition, normalizeFx, type FxParamSpec } from '../fx/definitions';
import { VOICE_EFFECTS, addVoiceEffect, findVoiceEffect } from '../fx/voiceEffects';
import { MASTER, VOICE_CHAIN, addVoiceChain, fxList, insertFx, moveFx, removeFx, replaceFx, updateFx, type FxTarget } from '../fx/stack';
import { findPresetEntry, presetEdited } from '../fx/presets';
import type { FxPresetLibrary } from '../fx/presetLibrary';
import { createVstFx, visibleVstParams, vstFailures } from '../fx/vst';
import { projectLength, updateTrack } from '../project';
import { AUTOMIX_DEFAULT_DEPTH } from '../automix';
import { paragraphs, timelineWords } from '../transcript';
import { formatTimestamp, uid } from '../../shared/time';
import { McpServer, ToolError, type JsonSchema, type McpTool } from './protocol';

/** What the tools need from the app. The main process implements it; tests use a fake. */
export interface WavePodHost {
  project(): Project;
  /** Folder of the open project. */
  dir(): string;
  transportState(): TransportState;
  /** Applies an edit as one undo step and shows `summary` to the user. */
  apply(next: Project, summary: string): void;
  measureLoudness(): Promise<LoudnessReport[]>;
  /** The episode's transcripts by media file (made with Transcribe in WavePod). */
  transcripts?(): Record<string, FileTranscript>;
  /** Filter presets (factory, plug-in programs and the user's own), or null if not available. */
  presets?: FxPresetLibrary | null;
  /** VST3 support, or null when this build has no plug-in host. */
  vst: {
    scan(): Promise<VstPluginInfo[]> | VstPluginInfo[];
    describe(plugin: VstPluginRef): Promise<VstDescription> | VstDescription;
    /** The plug-in's own text for a normalized value, e.g. "-12.0 dB". */
    format(fx: Fx, paramId: number, value: number): Promise<string> | string;
  } | null;
}

export interface VstDescription {
  params: Array<VstParamInfo & { value: number }>;
  state: string;
}

export const SERVER_INSTRUCTIONS = `WavePod is a multitrack podcast recorder and editor. These tools read the open episode and edit its filter stacks.

Each track and the master bus has a filter stack that runs top to bottom (track stacks run before track gain and pan; the master stack before the master gain). Address a stack with "target": a track id, a track name, or "master". Address a filter with "filter": its id, or its type or plug-in name when that is unique in the stack.

Built-in filter parameters use real units (Hz, dB, ms, LUFS); call list_filter_types for keys and ranges. VST3 parameters are normalized 0..1 and are addressed by parameter id or title; get_filter_stack shows the plug-in's own text for each value.

Every filter can be set from a preset: list_filter_presets shows WavePod's factory presets (or a VST3 plug-in's own programs) and the user's saved presets; apply_filter_preset loads one; save_filter_preset stores a filter's settings for use in every episode.

Every change is one undo step in WavePod (Ctrl+Z), and the user sees it in the FX panel right away. A good starting point for a speech track is apply_voice_chain; check the result with measure_loudness. Speech tracks recorded in one room can be cleaned of crosstalk with set_automix. If the user has transcribed the episode, get_transcript returns it as speaker paragraphs with times. For audio dramas, apply_voice_effect turns a voice into a telephone, radio, megaphone, robot, giant, small creature, ghost or a voice behind a wall, and its place-… effects put a voice into a room (kitchen, car, church, forest…); the Room & distance filter's distance parameter (metres) then moves it closer or further away.`;

// ---------------------------------------------------------------- helpers

const round = (v: number, digits = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : v);

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`"${key}" is required.`);
    return undefined;
  }
  if (typeof v !== 'string' && typeof v !== 'number') throw new ToolError(`"${key}" must be a string.`);
  return String(v);
}

function int(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`"${key}" must be a whole number.`);
  return n;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ToolError(`"${key}" must be true or false.`);
  return v;
}

function record(args: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ToolError(`"${key}" must be an object.`);
  return v as Record<string, unknown>;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Resolves a track id, track name or "master" to a stack target. */
export function resolveTarget(project: Project, target: string): { target: FxTarget; name: string } {
  const t = norm(target);
  if (t === MASTER || t === 'master bus') return { target: MASTER, name: 'Master' };
  const byId = project.tracks.find((tr) => tr.id === target);
  if (byId) return { target: byId.id, name: byId.name };
  const byName = project.tracks.filter((tr) => norm(tr.name) === t);
  if (byName.length === 1) return { target: byName[0].id, name: byName[0].name };
  const names = project.tracks.map((tr) => `"${tr.name}" (${tr.id})`).join(', ');
  if (byName.length > 1) throw new ToolError(`Several tracks are called "${target}"; use the track id: ${names}.`);
  throw new ToolError(`No track "${target}". Use "master" or one of: ${names || 'no tracks yet'}.`);
}

function filterName(fx: Fx): string {
  return fx.type === 'vst3' ? (fx.plugin?.name ?? 'VST3 plug-in') : fxDefinition(fx.type).name;
}

/** Finds a filter by id, or by type / name when that is unique in the stack. */
export function resolveFilter(list: Fx[], ref: string): Fx {
  const byId = list.find((f) => f.id === ref);
  if (byId) return byId;
  const r = norm(ref);
  const matches = list.filter((f) => f.type === r || norm(filterName(f)) === r || (f.type !== 'vst3' && (fxDefinition(f.type).aliases ?? []).some((a) => norm(a) === r)));
  if (matches.length === 1) return matches[0];
  const ids = list.map((f) => `${filterName(f)} (${f.id})`).join(', ');
  if (matches.length > 1) throw new ToolError(`The stack has several "${ref}" filters; use the filter id: ${ids}.`);
  throw new ToolError(`No filter "${ref}" in this stack. Filters: ${ids || 'none'}.`);
}

function describeSpec(spec: FxParamSpec) {
  return {
    key: spec.key,
    label: spec.label,
    unit: spec.unit ?? '',
    min: spec.min,
    max: spec.max,
    step: spec.step,
    default: spec.default,
    ...(spec.options ? { options: spec.options.map((o) => o.value) } : {}),
  };
}

async function describeFx(host: WavePodHost, fx: Fx, position: number) {
  const base = { id: fx.id, position, type: fx.type, name: filterName(fx), enabled: fx.enabled, ...(fx.preset ? { preset: { name: fx.preset.name, edited: presetEdited(fx) } } : {}) };
  if (fx.type !== 'vst3') {
    const def = fxDefinition(fx.type);
    return { ...base, params: def.params.map((spec) => ({ key: spec.key, label: spec.label, value: fx.params[spec.key] ?? spec.default, unit: spec.unit ?? '' })) };
  }
  const params = [];
  for (const info of visibleVstParams(fx.paramInfo ?? [])) {
    const value = fx.params[String(info.id)] ?? info.default;
    let text: string | undefined;
    if (host.vst) {
      try {
        text = (await host.vst.format(fx, info.id, value)) || undefined;
      } catch {
        text = undefined;
      }
    }
    params.push({ id: info.id, title: info.title, units: info.units, steps: info.steps, value: round(value, 4), ...(text ? { text } : {}) });
  }
  const failure = vstFailures().get(fx.id);
  return { ...base, vendor: fx.plugin?.vendor ?? '', plugin: fx.plugin ? { path: fx.plugin.path, cid: fx.plugin.cid } : null, params, ...(failure ? { error: failure } : {}) };
}

/** Validates parameter changes for a built-in filter. Returns the clamped values and notes. */
function builtinParams(type: Exclude<FxType, 'vst3'>, changes: Record<string, unknown>): { params: Record<string, number>; notes: string[] } {
  const def = fxDefinition(type);
  const params: Record<string, number> = {};
  const notes: string[] = [];
  for (const [k, raw] of Object.entries(changes)) {
    const spec = def.params.find((p) => p.key === k) ?? def.params.find((p) => norm(p.label) === norm(k));
    if (!spec) throw new ToolError(`${def.name} has no parameter "${k}". Parameters: ${def.params.map((p) => p.key).join(', ')}.`);
    const v = Number(raw);
    if (typeof raw === 'boolean' || !Number.isFinite(v)) throw new ToolError(`"${k}" must be a number${spec.unit ? ` in ${spec.unit}` : ''}.`);
    let value = Math.min(spec.max, Math.max(spec.min, v));
    if (spec.options) value = spec.options.reduce((best, o) => (Math.abs(o.value - v) < Math.abs(best - v) ? o.value : best), spec.options[0].value);
    if (value !== v) notes.push(`${spec.key} set to ${value} instead of ${v} (range ${spec.options ? spec.options.map((o) => o.value).join(' / ') : `${spec.min}..${spec.max}`}).`);
    params[spec.key] = value;
  }
  return { params, notes };
}

/** Validates parameter changes for a VST3 filter (normalized 0..1, by id or title). */
function vstParams(fx: Fx, changes: Record<string, unknown>): { params: Record<string, number>; notes: string[] } {
  const infos = visibleVstParams(fx.paramInfo ?? []);
  const params: Record<string, number> = {};
  const notes: string[] = [];
  for (const [k, raw] of Object.entries(changes)) {
    const info = infos.find((p) => String(p.id) === k) ?? infos.find((p) => norm(p.title) === norm(k));
    if (!info) throw new ToolError(`${filterName(fx)} has no adjustable parameter "${k}". Use an id or title from get_filter_stack.`);
    const v = typeof raw === 'boolean' ? (raw ? 1 : 0) : Number(raw);
    if (!Number.isFinite(v)) throw new ToolError(`"${k}" must be a normalized number between 0 and 1.`);
    let value = Math.min(1, Math.max(0, v));
    if (info.steps > 0) value = Math.round(value * info.steps) / info.steps;
    if (value !== v) notes.push(`${info.title} set to ${round(value, 4)} instead of ${v} (normalized 0..1${info.steps > 0 ? `, ${info.steps + 1} steps` : ''}).`);
    params[String(info.id)] = value;
  }
  return { params, notes };
}

function changeParams(fx: Fx, changes: Record<string, unknown>) {
  return fx.type === 'vst3' ? vstParams(fx, changes) : builtinParams(fx.type, changes);
}

const BUILTIN_TYPES = FX_DEFINITIONS.map((d) => d.type);

async function findPlugin(host: WavePodHost, query: string): Promise<VstPluginRef> {
  if (!host.vst) throw new ToolError('VST3 support is not included in this WavePod build.');
  const plugins = await host.vst.scan();
  const q = norm(query);
  const exact = plugins.filter((p) => p.cid === query || p.path === query || norm(p.name) === q);
  const found = exact.length ? exact : plugins.filter((p) => norm(p.name).includes(q));
  if (found.length === 1) return found[0];
  if (found.length > 1) throw new ToolError(`Several plug-ins match "${query}": ${found.map((p) => `${p.name} (${p.vendor}, cid ${p.cid})`).join('; ')}. Use the cid.`);
  throw new ToolError(`No installed VST3 plug-in matches "${query}". Call list_vst_plugins to see what is installed.`);
}

/** Builds a new filter from a tool's arguments (built-in type or VST3 plug-in), with parameters applied. */
async function buildFilter(host: WavePodHost, spec: Record<string, unknown>): Promise<{ fx: Fx; notes: string[] }> {
  const type = str(spec, 'type', true) as FxType;
  const changes = record(spec, 'params') ?? {};
  const enabled = bool(spec, 'enabled');
  let fx: Fx;
  if (type === 'vst3') {
    const ref = await findPlugin(host, str(spec, 'plugin', true));
    fx = createVstFx(ref, await host.vst!.describe(ref));
  } else if (BUILTIN_TYPES.includes(type)) {
    fx = createFx(type);
  } else {
    throw new ToolError(`Unknown filter type "${type}". Types: ${[...BUILTIN_TYPES, 'vst3'].join(', ')}.`);
  }
  const { params, notes } = changeParams(fx, changes);
  return { fx: { ...fx, params: { ...fx.params, ...params }, enabled: enabled ?? true }, notes };
}

/** Copies a filter with a fresh id (VST3 state and settings are kept). */
function copyFx(fx: Fx): Fx {
  return { ...(normalizeFx(JSON.parse(JSON.stringify(fx)) as Fx) ?? fx), id: uid('fx') };
}

function loudness(stats: LoudnessStats) {
  return {
    integratedLufs: round(stats.integrated, 1),
    rangeLu: round(stats.range, 1),
    shortTermMaxLufs: round(stats.shortTermMax, 1),
    momentaryMaxLufs: round(stats.momentaryMax, 1),
    truePeakDbtp: round(stats.truePeak, 1),
    samplePeakDbfs: round(stats.samplePeak, 1),
    durationSeconds: round(stats.duration, 1),
  };
}

// ---------------------------------------------------------------- schemas

const TARGET: JsonSchema = { type: 'string', description: 'Track id, track name, or "master".' };
const FILTER: JsonSchema = { type: 'string', description: 'Filter id, or its type / plug-in name when unique in the stack.' };
const PARAMS: JsonSchema = {
  type: 'object',
  description: 'Parameter values. Built-in filters: by key (see list_filter_types), in the parameter\'s unit. VST3: by parameter id or title, normalized 0..1.',
  additionalProperties: { type: 'number' },
};
const FILTER_SPEC: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: [...BUILTIN_TYPES, 'vst3'], description: 'Filter type.' },
    plugin: { type: 'string', description: 'For type "vst3": plug-in name, cid or path (see list_vst_plugins).' },
    params: PARAMS,
    enabled: { type: 'boolean', description: 'false adds it bypassed. Default true.' },
  },
  required: ['type'],
};

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false });

const READ = { readOnlyHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

// ---------------------------------------------------------------- tools

export function createWavePodTools(host: WavePodHost): McpTool[] {
  const stackResult = async (target: FxTarget, name: string, extra: Record<string, unknown> = {}) => {
    const list = fxList(host.project(), target);
    return { target: target === MASTER ? MASTER : target, name, ...extra, filters: await Promise.all(list.map((fx, i) => describeFx(host, fx, i))) };
  };

  return [
    {
      name: 'get_project',
      description: 'Overview of the open episode: name, folder, sample rate, length, track and marker counts, episode metadata and transport state.',
      inputSchema: obj({}),
      annotations: { title: 'Get project', ...READ },
      run: () => {
        const p = host.project();
        return {
          name: p.name,
          folder: host.dir(),
          sampleRate: p.sampleRate,
          bitDepth: p.bitDepth,
          lengthSeconds: round(projectLength(p) / p.sampleRate, 3),
          masterGainDb: p.masterGain,
          tracks: p.tracks.length,
          chapterMarkers: p.markers.filter((m) => m.kind === 'chapter').length,
          editMarkers: p.markers.filter((m) => m.kind === 'edit').length,
          metadata: p.metadata,
          transport: host.transportState(),
        };
      },
    },
    {
      name: 'list_tracks',
      description: 'Lists the tracks and the master bus with their settings and filter stacks (names only; use get_filter_stack for parameters).',
      inputSchema: obj({}),
      annotations: { title: 'List tracks', ...READ },
      run: () => {
        const p = host.project();
        return {
          tracks: p.tracks.map((t, i) => ({
            id: t.id,
            number: i + 1,
            name: t.name,
            ...(t.kind ? { kind: t.kind } : {}),
            inputChannels: t.inputChannels.map((c) => c + 1),
            armed: t.armed,
            mute: t.mute,
            solo: t.solo,
            gainDb: t.gain,
            pan: t.pan,
            clips: t.clips.length,
            audioSeconds: round(t.clips.reduce((s, c) => s + c.length, 0) / p.sampleRate, 1),
            filters: (t.fx ?? []).map((f) => `${filterName(f)}${f.enabled ? '' : ' (bypassed)'}`),
            ...(t.automix?.enabled ? { automix: { depthDb: t.automix.depth } } : {}),
            ...(t.duck?.enabled ? { duck: { depthDb: t.duck.depth } } : {}),
          })),
          master: { id: MASTER, name: 'Master', gainDb: p.masterGain, filters: (p.masterFx ?? []).map((f) => `${filterName(f)}${f.enabled ? '' : ' (bypassed)'}`) },
        };
      },
    },
    {
      name: 'set_automix',
      description:
        'Turns crosstalk removal (automix) on or off for speech tracks. For people recorded in one room, where every mic also picks up the others: ' +
        'among the automixed tracks, whoever is loudest stays up and the others are turned down by up to depthDb. It needs at least two automixed tracks and works in playback and export.',
      inputSchema: obj(
        {
          tracks: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Track ids or names.' },
          enabled: { type: 'boolean', description: 'true = take part in the automix.' },
          depthDb: { type: 'number', minimum: 1, maximum: 60, description: 'How far a track is turned down at most while someone else speaks. Default 18.' },
        },
        ['tracks', 'enabled'],
      ),
      annotations: { title: 'Set automix', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const refs = args.tracks;
        if (!Array.isArray(refs) || !refs.length) throw new ToolError('"tracks" must list at least one track.');
        const enabled = bool(args, 'enabled')!;
        const depthArg = args.depthDb === undefined ? undefined : Number(args.depthDb);
        if (depthArg !== undefined && !(depthArg >= 1 && depthArg <= 60)) throw new ToolError('"depthDb" must be between 1 and 60.');
        const names: string[] = [];
        for (const ref of refs) {
          const { target, name } = resolveTarget(project, String(ref));
          if (target === MASTER) throw new ToolError('The master bus can\'t be automixed.');
          const track = project.tracks.find((t) => t.id === target)!;
          const automix = { enabled, depth: depthArg ?? track.automix?.depth ?? AUTOMIX_DEFAULT_DEPTH };
          project = updateTrack(project, target, { automix });
          names.push(name);
        }
        host.apply(project, `${enabled ? 'Automix on' : 'Automix off'} for ${names.join(', ')}`);
        const on = host.project().tracks.filter((t) => t.automix?.enabled && !t.duck?.enabled);
        return {
          automixed: on.map((t) => ({ id: t.id, name: t.name, depthDb: t.automix!.depth })),
          ...(on.length === 1 ? { note: 'Only one track is automixed; it has no effect until a second track takes part.' } : {}),
        };
      },
    },
    {
      name: 'get_transcript',
      description:
        'The episode transcript as speaker paragraphs with start times (seconds, timeline positions after all edits), if the user has transcribed it in WavePod. ' +
        'Useful for show notes, chapter titles and summaries. Hesitations are marked with "filler" counts.',
      inputSchema: obj({
        from: { type: 'number', minimum: 0, description: 'Start (seconds); default the beginning.' },
        to: { type: 'number', minimum: 0, description: 'End (seconds); default the end.' },
      }),
      annotations: { title: 'Get transcript', ...READ },
      run: (args) => {
        const p = host.project();
        const sr = p.sampleRate;
        const words = timelineWords(p, host.transcripts?.() ?? {});
        if (!words.length) return { transcribed: false, note: 'No transcript yet. The user can make one in WavePod: View › Transcript › Transcribe.' };
        const from = Number(args.from ?? 0) * sr;
        const to = args.to === undefined ? Infinity : Number(args.to) * sr;
        const inRange = words.filter((w) => w.start >= from && w.start < to);
        const names = new Map(p.tracks.map((t) => [t.id, t.name]));
        return {
          transcribed: true,
          paragraphs: paragraphs(inRange, sr).map((para) => ({
            speaker: names.get(para.trackId) ?? '',
            start: round(para.start / sr, 2),
            text: para.words.map((i) => inRange[i].text).join(' '),
          })),
          fillers: inRange.filter((w) => w.filler).length,
        };
      },
    },
    {
      name: 'list_markers',
      description: 'Lists chapter and edit markers with their positions.',
      inputSchema: obj({ kind: { type: 'string', enum: ['chapter', 'edit'], description: 'Only this kind.' } }),
      annotations: { title: 'List markers', ...READ },
      run: (args) => {
        const p = host.project();
        const kind = str(args, 'kind');
        return {
          markers: [...p.markers]
            .filter((m) => !kind || m.kind === kind)
            .sort((a, b) => a.position - b.position)
            .map((m) => ({ id: m.id, kind: m.kind, title: m.title, ...(m.url ? { url: m.url } : {}), seconds: round(m.position / p.sampleRate, 3), timestamp: formatTimestamp(m.position / p.sampleRate) })),
        };
      },
    },
    {
      name: 'measure_loudness',
      description: 'EBU R128 loudness of the mix and of every track with audio, after all filters (integrated LUFS, loudness range, short-term and momentary max, true and sample peak). Takes a few seconds for long episodes.',
      inputSchema: obj({}),
      annotations: { title: 'Measure loudness', ...READ },
      run: async () => {
        const reports = await host.measureLoudness();
        return { reports: reports.map((r) => ({ kind: r.kind, id: r.id, name: r.name, ...loudness(r.stats) })) };
      },
    },
    {
      name: 'list_filter_types',
      description: 'The built-in filters with their parameters (keys, units, ranges, defaults), plus whether VST3 plug-ins can be used.',
      inputSchema: obj({}),
      annotations: { title: 'List filter types', ...READ },
      run: () => ({
        filters: FX_DEFINITIONS.map((d) => ({ type: d.type, name: d.name, description: d.description, params: d.params.map(describeSpec) })),
        voiceChain: VOICE_CHAIN,
        vst3: host.vst ? 'available: use type "vst3" with a plug-in from list_vst_plugins' : 'not available in this build',
      }),
    },
    {
      name: 'list_vst_plugins',
      description: 'Lists the installed VST3 effect plug-ins that can be added with add_filter (type "vst3").',
      inputSchema: obj({ query: { type: 'string', description: 'Only plug-ins whose name or vendor contains this.' } }),
      annotations: { title: 'List VST3 plug-ins', ...READ },
      run: async (args) => {
        if (!host.vst) throw new ToolError('VST3 support is not included in this WavePod build.');
        const q = norm(str(args, 'query') ?? '');
        const plugins = (await host.vst.scan()).filter((p) => !q || norm(p.name).includes(q) || norm(p.vendor).includes(q));
        return { plugins: plugins.map((p) => ({ name: p.name, vendor: p.vendor, version: p.version, categories: p.categories, cid: p.cid, path: p.path })) };
      },
    },
    {
      name: 'get_filter_stack',
      description: 'The filter stack of a track or the master bus, top to bottom, with every parameter value. VST3 parameters include the plug-in\'s own text for the value.',
      inputSchema: obj({ target: TARGET }, ['target']),
      annotations: { title: 'Get filter stack', ...READ },
      run: (args) => {
        const { target, name } = resolveTarget(host.project(), str(args, 'target', true));
        return stackResult(target, name);
      },
    },
    {
      name: 'add_filter',
      description: 'Adds a filter to a stack, optionally at a position and with parameter values. Built-in types are listed by list_filter_types; for a VST3 plug-in use type "vst3" and name it in "plugin".',
      inputSchema: {
        ...FILTER_SPEC,
        properties: { target: TARGET, ...(FILTER_SPEC.properties as object), position: { type: 'integer', minimum: 0, description: '0-based position; default is the end of the stack.' } },
        required: ['target', 'type'],
        additionalProperties: false,
      },
      annotations: { title: 'Add filter', ...EDIT },
      run: async (args) => {
        const { target, name } = resolveTarget(host.project(), str(args, 'target', true));
        const { fx, notes } = await buildFilter(host, args);
        const position = int(args, 'position');
        // Re-read the project: describing a plug-in can take a moment.
        host.apply(insertFx(host.project(), target, fx, position), `Added ${filterName(fx)} to ${name}`);
        return stackResult(target, name, { added: fx.id, ...(notes.length ? { notes } : {}) });
      },
    },
    {
      name: 'update_filter',
      description: 'Changes parameters of a filter and/or bypasses or enables it. Only the given parameters change.',
      inputSchema: obj({ target: TARGET, filter: FILTER, params: PARAMS, enabled: { type: 'boolean', description: 'false = bypass, true = on.' } }, ['target', 'filter']),
      annotations: { title: 'Update filter', ...EDIT, idempotentHint: true },
      run: async (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        const enabled = bool(args, 'enabled');
        const changes = record(args, 'params') ?? {};
        if (enabled === undefined && !Object.keys(changes).length) throw new ToolError('Nothing to change: give "params" and/or "enabled".');
        const { params, notes } = changeParams(fx, changes);
        host.apply(updateFx(project, target, fx.id, { params, ...(enabled !== undefined ? { enabled } : {}) }), `Changed ${filterName(fx)} on ${name}`);
        const list = fxList(host.project(), target);
        const i = list.findIndex((f) => f.id === fx.id);
        return { target, name, filter: await describeFx(host, list[i], i), ...(notes.length ? { notes } : {}) };
      },
    },
    {
      name: 'remove_filter',
      description: 'Removes a filter from a stack.',
      inputSchema: obj({ target: TARGET, filter: FILTER }, ['target', 'filter']),
      annotations: { title: 'Remove filter', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        host.apply(removeFx(project, target, fx.id), `Removed ${filterName(fx)} from ${name}`);
        return stackResult(target, name, { removed: fx.id });
      },
    },
    {
      name: 'move_filter',
      description: 'Moves a filter to another position in its stack (filters run top to bottom, position 0 first).',
      inputSchema: obj({ target: TARGET, filter: FILTER, position: { type: 'integer', minimum: 0, description: 'New 0-based position.' } }, ['target', 'filter', 'position']),
      annotations: { title: 'Move filter', ...EDIT, idempotentHint: true },
      run: (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        const position = int(args, 'position');
        if (position === undefined || position < 0) throw new ToolError('"position" must be 0 or more.');
        host.apply(moveFx(project, target, fx.id, position), `Moved ${filterName(fx)} on ${name}`);
        return stackResult(target, name);
      },
    },
    {
      name: 'apply_voice_chain',
      description: `Adds WavePod's voice chain (${VOICE_CHAIN.map((t) => fxDefinition(t).name).join(', ')}), modelled on Ultraschall's, to a track. By default it is appended; replace=true replaces the existing stack.`,
      inputSchema: obj({ target: TARGET, replace: { type: 'boolean', description: 'Remove the existing filters first. Default false.' } }, ['target']),
      annotations: { title: 'Apply voice chain', ...EDIT },
      run: (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const base = bool(args, 'replace') ? fxList(project, target).reduce((p, f) => removeFx(p, target, f.id), project) : project;
        host.apply(addVoiceChain(base, target), `Applied the voice chain to ${name}`);
        return stackResult(target, name);
      },
    },
    {
      name: 'apply_voice_effect',
      description: `Adds a ready-made audio drama voice effect to a track: a few filters set from factory presets, appended to the stack (replace=true replaces the stack). Effects: ${VOICE_EFFECTS.map((e) => `${e.id} (${e.description})`).join('; ')}`,
      inputSchema: obj(
        {
          target: TARGET,
          effect: { type: 'string', enum: VOICE_EFFECTS.map((e) => e.id), description: 'The effect.' },
          replace: { type: 'boolean', description: 'Remove the existing filters first. Default false.' },
        },
        ['target', 'effect'],
      ),
      annotations: { title: 'Apply voice effect', ...EDIT },
      run: (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const ref = str(args, 'effect', true);
        const effect = findVoiceEffect(ref);
        if (!effect) throw new ToolError(`Unknown voice effect "${ref}". Effects: ${VOICE_EFFECTS.map((e) => e.id).join(', ')}.`);
        const base = bool(args, 'replace') ? fxList(project, target).reduce((p, f) => removeFx(p, target, f.id), project) : project;
        host.apply(addVoiceEffect(base, target, effect).project, `Applied ${effect.name} to ${name}`);
        return stackResult(target, name);
      },
    },
    {
      name: 'set_filter_stack',
      description: 'Replaces a whole stack with the given filters, top to bottom. Use it to build a stack in one step; an empty list clears the stack.',
      inputSchema: obj({ target: TARGET, filters: { type: 'array', items: FILTER_SPEC, description: 'The new stack, top to bottom.' } }, ['target', 'filters']),
      annotations: { title: 'Set filter stack', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: async (args) => {
        const { target, name } = resolveTarget(host.project(), str(args, 'target', true));
        if (!Array.isArray(args.filters)) throw new ToolError('"filters" must be a list.');
        const built: Fx[] = [];
        const notes: string[] = [];
        for (const [i, spec] of (args.filters as unknown[]).entries()) {
          if (!spec || typeof spec !== 'object') throw new ToolError(`filters[${i}] must be an object.`);
          try {
            const r = await buildFilter(host, spec as Record<string, unknown>);
            built.push(r.fx);
            notes.push(...r.notes.map((n) => `filters[${i}]: ${n}`));
          } catch (e) {
            throw new ToolError(`filters[${i}]: ${(e as Error).message}`);
          }
        }
        const project = host.project();
        const cleared = fxList(project, target).reduce((p, f) => removeFx(p, target, f.id), project);
        host.apply(built.reduce((p, fx) => insertFx(p, target, fx), cleared), `Set the filters of ${name}`);
        return stackResult(target, name, notes.length ? { notes } : {});
      },
    },
    {
      name: 'copy_filter_stack',
      description: 'Copies the filters of one track (or the master) to another, e.g. to give every speaker the same chain. Replaces the destination stack unless append=true.',
      inputSchema: obj({ from: TARGET, to: { ...TARGET, description: 'Destination: track id, track name, or "master".' }, append: { type: 'boolean', description: 'Add after the existing filters instead of replacing them.' } }, ['from', 'to']),
      annotations: { title: 'Copy filter stack', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: (args) => {
        const project = host.project();
        const from = resolveTarget(project, str(args, 'from', true));
        const to = resolveTarget(project, str(args, 'to', true));
        if (from.target === to.target) throw new ToolError('"from" and "to" are the same stack.');
        const base = bool(args, 'append') ? project : fxList(project, to.target).reduce((p, f) => removeFx(p, to.target, f.id), project);
        const next = fxList(project, from.target).reduce((p, f) => insertFx(p, to.target, copyFx(f)), base);
        host.apply(next, `Copied the filters of ${from.name} to ${to.name}`);
        return stackResult(to.target, to.name);
      },
    },
    {
      name: 'list_filter_presets',
      description: "Presets for one filter: WavePod's factory presets (built-in filters) or the plug-in's own programs (VST3), then the user's saved presets. User presets are shared by all episodes.",
      inputSchema: obj({ target: TARGET, filter: FILTER }, ['target', 'filter']),
      annotations: { title: 'List filter presets', ...READ },
      run: async (args) => {
        const library = needPresets(host);
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        const presets = await library.list(fx);
        return {
          target,
          name,
          filter: { id: fx.id, name: filterName(fx), ...(fx.preset ? { preset: { name: fx.preset.name, edited: presetEdited(fx) } } : {}) },
          presets: presets.map((p) => ({ id: p.id, name: p.name, source: p.source, ...(p.description ? { description: p.description } : {}) })),
        };
      },
    },
    {
      name: 'apply_filter_preset',
      description: 'Sets a filter to a preset from list_filter_presets (by id or name). All of its parameters change; one undo step.',
      inputSchema: obj({ target: TARGET, filter: FILTER, preset: { type: 'string', description: 'Preset id or name from list_filter_presets.' } }, ['target', 'filter', 'preset']),
      annotations: { title: 'Apply filter preset', ...EDIT, idempotentHint: true },
      run: async (args) => {
        const library = needPresets(host);
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        const ref = str(args, 'preset', true);
        const entries = await library.list(fx);
        const entry = findPresetEntry(entries, ref);
        if (!entry) throw new ToolError(`No preset "${ref}" for ${filterName(fx)}. Presets: ${entries.map((p) => `"${p.name}"`).join(', ') || 'none'}.`);
        let next: Fx;
        try {
          next = await library.apply(fx, entry.id);
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
        // Re-read the project: loading a plug-in program can take a moment.
        host.apply(replaceFx(host.project(), target, next), `Loaded preset "${entry.name}" into ${filterName(fx)} on ${name}`);
        const list = fxList(host.project(), target);
        const i = list.findIndex((f) => f.id === fx.id);
        return { target, name, filter: await describeFx(host, list[i], i) };
      },
    },
    {
      name: 'save_filter_preset',
      description: "Saves a filter's current settings as a user preset, available in every episode. A preset with the same name for the same filter is replaced.",
      inputSchema: obj({ target: TARGET, filter: FILTER, name: { type: 'string', description: 'Preset name.' } }, ['target', 'filter', 'name']),
      annotations: { title: 'Save filter preset', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      run: async (args) => {
        const library = needPresets(host);
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        let saved: Awaited<ReturnType<FxPresetLibrary['save']>>;
        try {
          saved = await library.save(fx, str(args, 'name', true));
        } catch (e) {
          throw new ToolError((e as Error).message);
        }
        host.apply(replaceFx(host.project(), target, saved.fx), `Saved ${filterName(fx)} on ${name} as preset "${saved.entry.name}"`);
        return { saved: { id: saved.entry.id, name: saved.entry.name }, replaced: saved.replaced };
      },
    },
  ];
}

function needPresets(host: WavePodHost): FxPresetLibrary {
  if (!host.presets) throw new ToolError('Filter presets are not available.');
  return host.presets;
}

export function createWavePodServer(host: WavePodHost, version: string): McpServer {
  const server = new McpServer({ name: 'wavepod', title: 'WavePod', version, instructions: SERVER_INSTRUCTIONS });
  for (const tool of createWavePodTools(host)) server.addTool(tool);
  return server;
}
