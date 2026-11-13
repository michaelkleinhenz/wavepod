// The tools WavePod offers to AI agents over MCP: reading the project and editing filter stacks.
// Every edit goes through the app (one undo step each), so it shows up in the FX panel at once.
import type { FileTranscript, Fx, FxType, LoudnessReport, LoudnessStats, Project, DirectorCut, TransportState, VstParamInfo, VstPluginInfo, VstPluginRef } from '../../shared/types';
import { FX_DEFINITIONS, createFx, fxDefinition, normalizeFx, type FxParamSpec } from '../fx/definitions';
import { VOICE_EFFECTS, addVoiceEffect, findVoiceEffect } from '../fx/voiceEffects';
import { MASTER, VOICE_CHAIN, addVoiceChain, fxList, insertFx, moveFx, removeFx, replaceFx, updateFx, type FxTarget } from '../fx/stack';
import { findPresetEntry, presetEdited } from '../fx/presets';
import type { FxPresetLibrary } from '../fx/presetLibrary';
import type { ImpulseFile } from '../../shared/api';
import { createVstFx, visibleVstParams, vstFailures } from '../fx/vst';
import { clipsEnd, projectLength, updateTrack } from '../project';
import { applyPass, cameraSyncAfterStretch, cameraTrack, normalizeCuts, shots } from '../video';
import { AUTOMIX_DEFAULT_DEPTH } from '../automix';
import { STEM_CHOICES, trackStem } from '../stems';
import { setTrackAutomation, showTrackAutomation } from '../automation';
import { compTake, pickTake, takeSpan, takeUsage } from '../takes';
import { FOLDER_GAIN_MAX, FOLDER_GAIN_MIN, addFolder, folderOf, removeFolder, setTrackFolder, updateFolder } from '../folders';
import { paragraphs, timelineWords } from '../transcript';
import { scriptCharacters, scriptProgress, scriptSummary } from '../script';
import type { WordFilter } from '../wordLevels';
import { formatTimestamp, uid } from '../../shared/time';
import { WEAK_CONFIDENCE, alignedPosition, applyAlignment, type AlignOutcome } from '../alignEdit';
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
  /** Measures how clips have to move to line up with a reference track (and makes drift-corrected copies). */
  alignClips?(clipIds: string[], refTrackId: string): Promise<AlignOutcome>;
  /** The episode's transcripts by media file (made with Transcribe in WavePod). */
  transcripts?(): Record<string, FileTranscript>;
  /** Which quiet words (crosstalk) to leave out of the transcript, from Settings › Transcription. */
  transcriptFilter?(): WordFilter | null;
  /** Filter presets (factory, plug-in programs and the user's own), or null if not available. */
  presets?: FxPresetLibrary | null;
  /** The impulse responses in the user's folder, for the convolution reverb. */
  impulses?(): ImpulseFile[];
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

Every change is one undo step in WavePod (Ctrl+Z), and the user sees it in the FX panel right away. A good starting point for a speech track is apply_voice_chain; check the result with measure_loudness. Speech tracks recorded in one room can be cleaned of crosstalk with set_automix. If the user has transcribed the episode, get_transcript returns it as speaker paragraphs with times; for audio dramas, get_script shows the imported script with which lines are recorded and where. For audio dramas, apply_voice_effect turns a voice into a telephone, radio, megaphone, robot, giant, small creature, ghost or a voice behind a wall, and its place-… effects put a voice into a room (kitchen, car, church, forest…); the Room & distance filter's distance parameter (metres) then moves it closer or further away. set_track_automation moves a voice across the stereo stage (pan) or rides a track's level (volume) over time. Big productions group their tracks in folders (e.g. Dialogue, SFX, Atmo, Music) with create_folder and move_tracks_to_folder; update_folder mutes, solos or turns a whole group up or down. set_track_stem sorts tracks into the dialogue, music and effects stems the user can export for broadcasters and festivals. Recordings from separate recorders (one per speaker) are put in sync with align_track. Lines recorded several times are kept as takes: list_takes shows them, use_take plays a whole take or splices part of one into the comp. Video podcasts have cameras (list_cameras) whose pictures follow the audio edits; set_director_cuts chooses which camera is seen when (get_director shows the current switches), e.g. a close-up of whoever speaks in the transcript and the wide shot when several talk at once.`;

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

/** Resolves a folder id or name. */
export function resolveFolder(project: Project, ref: string): string {
  const folders = project.folders ?? [];
  const f = folders.find((x) => x.id === ref) ?? folders.find((x) => norm(x.name) === norm(ref));
  if (!f) throw new ToolError(`No folder "${ref}". Folders: ${folders.map((x) => x.name).join(', ') || 'none'}.`);
  return f.id;
}

/** A list of track ids or names as track ids (tracks only, not the master). */
function trackRefs(project: Project, refs: unknown, required: boolean): string[] {
  if (refs === undefined || refs === null) {
    if (required) throw new ToolError('"tracks" must list at least one track.');
    return [];
  }
  if (!Array.isArray(refs) || (required && !refs.length)) throw new ToolError('"tracks" must list at least one track.');
  return refs.map((ref) => {
    const { target } = resolveTarget(project, String(ref));
    if (target === MASTER) throw new ToolError('The master bus can\'t go into a folder.');
    return target;
  });
}

function describeFolder(p: Project, id: string): Record<string, unknown> {
  const f = p.folders!.find((x) => x.id === id)!;
  return {
    id: f.id,
    name: f.name,
    mute: f.mute,
    solo: f.solo,
    gainDb: f.gain,
    ...(f.collapsed ? { collapsed: true } : {}),
    tracks: p.tracks.filter((t) => t.folderId === f.id).map((t) => t.name),
  };
}

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
  const base = {
    id: fx.id,
    position,
    type: fx.type,
    name: filterName(fx),
    enabled: fx.enabled,
    ...(fx.preset ? { preset: { name: fx.preset.name, edited: presetEdited(fx) } } : {}),
    ...(fx.type === 'convolution' ? { impulseResponse: fx.ir?.name ?? null } : {}),
  };
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
            ...(folderOf(p, t) ? { folder: folderOf(p, t)!.name } : {}),
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
            stem: trackStem(t, folderOf(p, t)?.name),
            ...(t.stem ? {} : { stemGuessed: true }),
            ...(t.automation?.volume?.length || t.automation?.pan?.length
              ? {
                  automation: Object.fromEntries(
                    (['volume', 'pan'] as const)
                      .filter((lane) => t.automation?.[lane]?.length)
                      .map((lane) => [lane, t.automation![lane]!.map((q) => ({ seconds: round(q.pos / p.sampleRate, 3), value: round(q.value, 2) }))]),
                  ),
                }
              : {}),
          })),
          ...(p.folders?.length ? { folders: p.folders.map((f) => describeFolder(p, f.id)) } : {}),
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
      name: 'create_folder',
      description:
        'Makes a track folder: a named group of tracks (e.g. Dialogue, SFX, Atmo, Music) with one mute, solo and volume for all of them. ' +
        'Folders don\'t change the sound by themselves; the tracks still go straight to the master. Optionally moves tracks into it right away.',
      inputSchema: obj(
        {
          name: { type: 'string' },
          tracks: { type: 'array', items: { type: 'string' }, description: 'Track ids or names to put into the folder.' },
        },
        ['name'],
      ),
      annotations: { title: 'Create folder', ...EDIT },
      run: (args) => {
        let project = host.project();
        const name = str(args, 'name', true).trim();
        if ((project.folders ?? []).some((f) => norm(f.name) === norm(name))) throw new ToolError(`There already is a folder "${name}".`);
        const ids = trackRefs(project, args.tracks, false);
        project = addFolder(project, { name, trackIds: ids });
        host.apply(project, `New folder ${name}`);
        const p = host.project();
        return describeFolder(p, p.folders![p.folders!.length - 1].id);
      },
    },
    {
      name: 'move_tracks_to_folder',
      description: 'Moves tracks into a folder (they go to the end of it) or, with folder null, out of their folder.',
      inputSchema: obj(
        {
          tracks: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Track ids or names.' },
          folder: { type: ['string', 'null'], description: 'Folder id or name; null takes the tracks out of their folder.' },
        },
        ['tracks', 'folder'],
      ),
      annotations: { title: 'Move tracks to folder', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const folderId = args.folder === null ? null : resolveFolder(project, str(args, 'folder', true));
        const ids = trackRefs(project, args.tracks, true);
        for (const id of ids) project = setTrackFolder(project, id, folderId);
        const names = ids.map((id) => project.tracks.find((t) => t.id === id)!.name);
        const fname = folderId ? project.folders!.find((f) => f.id === folderId)!.name : '';
        host.apply(project, folderId ? `Moved ${names.join(', ')} to ${fname}` : `Took ${names.join(', ')} out of their folder`);
        const p = host.project();
        return { tracks: p.tracks.map((t) => ({ id: t.id, name: t.name, folder: folderOf(p, t)?.name ?? null })) };
      },
    },
    {
      name: 'update_folder',
      description:
        'Changes a track folder: rename it, mute or solo the whole group, set its group volume (dB added to every track in it), or fold it in the timeline. ' +
        'Muting a folder mutes all its tracks; soloing it lets all its tracks play while anything is soloed.',
      inputSchema: obj(
        {
          folder: { type: 'string', description: 'Folder id or name.' },
          name: { type: 'string' },
          mute: { type: 'boolean' },
          solo: { type: 'boolean' },
          gainDb: { type: 'number', minimum: FOLDER_GAIN_MIN, maximum: FOLDER_GAIN_MAX },
          collapsed: { type: 'boolean', description: 'Fold the folder in the timeline (hides its tracks).' },
        },
        ['folder'],
      ),
      annotations: { title: 'Update folder', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const id = resolveFolder(project, str(args, 'folder', true));
        const patch: Parameters<typeof updateFolder>[2] = {};
        const name = str(args, 'name');
        if (name !== undefined) patch.name = name.trim() || undefined;
        if (!patch.name) delete patch.name;
        for (const key of ['mute', 'solo', 'collapsed'] as const) {
          const v = bool(args, key);
          if (v !== undefined) patch[key] = v;
        }
        if (args.gainDb !== undefined) {
          const g = Number(args.gainDb);
          if (!(g >= FOLDER_GAIN_MIN && g <= FOLDER_GAIN_MAX)) throw new ToolError(`"gainDb" must be between ${FOLDER_GAIN_MIN} and ${FOLDER_GAIN_MAX}.`);
          patch.gain = g;
        }
        if (!Object.keys(patch).length) throw new ToolError('Nothing to change: give name, mute, solo, gainDb or collapsed.');
        project = updateFolder(project, id, patch);
        host.apply(project, `Folder ${project.folders!.find((f) => f.id === id)!.name} changed`);
        return describeFolder(host.project(), id);
      },
    },
    {
      name: 'remove_folder',
      description: 'Removes a track folder. Its tracks stay, outside any folder.',
      inputSchema: obj({ folder: { type: 'string', description: 'Folder id or name.' } }, ['folder']),
      annotations: { title: 'Remove folder', ...EDIT },
      run: (args) => {
        const project = host.project();
        const id = resolveFolder(project, str(args, 'folder', true));
        const name = project.folders!.find((f) => f.id === id)!.name;
        host.apply(removeFolder(project, id), `Removed folder ${name}`);
        return { removed: name };
      },
    },
    {
      name: 'align_track',
      description:
        'Moves a whole track into sync with another track by their content, e.g. two field recorders (one per speaker, started at different times) or a guest\'s own recording against the call recording. ' +
        'Searches the full length, so the recordings may be minutes apart, and corrects clock drift between recorders by switching the track to a resampled copy of its files (transcripts are carried over). Takes a while for long recordings.',
      inputSchema: obj(
        {
          track: { type: 'string', description: 'Track id or name: the track that moves.' },
          to: { type: 'string', description: 'Track id or name: the reference that stays where it is.' },
        },
        ['track', 'to'],
      ),
      annotations: { title: 'Align track', ...EDIT },
      run: async (args) => {
        if (!host.alignClips) throw new ToolError('Aligning is not available here.');
        if (host.transportState() === 'recording') throw new ToolError('WavePod is recording; align after the recording.');
        const p = host.project();
        const moving = resolveTarget(p, str(args, 'track', true));
        const ref = resolveTarget(p, str(args, 'to', true));
        if (moving.target === MASTER || ref.target === MASTER) throw new ToolError('Align works on tracks, not the master bus.');
        if (moving.target === ref.target) throw new ToolError('Pick two different tracks.');
        const track = p.tracks.find((t) => t.id === moving.target)!;
        if (!track.clips.length) throw new ToolError(`${moving.name} has no audio.`);
        const ids = track.clips.map((c) => c.id);
        const r = await host.alignClips(ids, ref.target);
        if (r.confidence <= 0) throw new ToolError(`No clear match between ${moving.name} and ${ref.name}; they don't seem to hear the same conversation.`);
        const now = host.project();
        const first = Math.min(...track.clips.map((c) => c.start));
        host.apply(cameraSyncAfterStretch(applyAlignment(now, ids, r, r.files), r.files, 1 + r.drift), `Aligned ${moving.name} to ${ref.name}`);
        return {
          track: moving.name,
          to: ref.name,
          movedSeconds: round((alignedPosition(r, first) - first) / p.sampleRate, 4),
          driftPpm: round(r.drift * 1e6, 1),
          driftCorrectedMs: round(Math.abs(r.drift) * r.overlapSeconds * 1000, 1),
          confidence: round(r.confidence, 2),
          weak: r.confidence < WEAK_CONFIDENCE,
          newFiles: Object.values(r.files),
        };
      },
    },
    {
      name: 'set_track_stem',
      description:
        'Sets which stem tracks go to when the user exports dialogue, music and effects stems (DME, as broadcasters and festivals ask for): ' +
        '"dialogue", "music", "effects", or "none" to leave a track out. Tracks without a choice are guessed from their name and settings (list_tracks shows stem and stemGuessed).',
      inputSchema: obj(
        {
          tracks: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Track ids or names.' },
          stem: { type: 'string', enum: STEM_CHOICES.map((c) => c.id) },
        },
        ['tracks', 'stem'],
      ),
      annotations: { title: 'Set track stem', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const refs = args.tracks;
        if (!Array.isArray(refs) || !refs.length) throw new ToolError('"tracks" must list at least one track.');
        const stem = str(args, 'stem', true);
        const choice = STEM_CHOICES.find((c) => c.id === stem);
        if (!choice) throw new ToolError(`"stem" must be one of ${STEM_CHOICES.map((c) => c.id).join(', ')}.`);
        const names: string[] = [];
        for (const ref of refs) {
          const { target, name } = resolveTarget(project, String(ref));
          if (target === MASTER) throw new ToolError('The master bus is not a track; stems are made of tracks.');
          project = updateTrack(project, target, { stem: choice.id });
          names.push(name);
        }
        host.apply(project, `${names.join(', ')} → ${choice.label} stem`);
        const p = host.project();
        return { stems: p.tracks.map((t) => ({ id: t.id, name: t.name, stem: trackStem(t, folderOf(p, t)?.name), ...(t.stem ? {} : { guessed: true }) })) };
      },
    },
    {
      name: 'set_track_automation',
      description:
        'Sets a track\'s volume or pan automation: breakpoints over the timeline that the track follows in playback and export, e.g. to move a voice across the stage or fade music under a scene. ' +
        'Volume values are dB relative to the track gain (-60 = silent, 0 = unchanged, up to +6); pan values are -1 (left) .. 1 (right) and replace the track\'s fixed pan while there are points. ' +
        'Between points the value moves smoothly; before the first and after the last point it holds. Two points at the same time make a jump. An empty list clears the lane.',
      inputSchema: obj(
        {
          track: { type: 'string', description: 'Track id or name.' },
          lane: { type: 'string', enum: ['volume', 'pan'] },
          points: {
            type: 'array',
            items: obj({ seconds: { type: 'number', minimum: 0 }, value: { type: 'number' } }, ['seconds', 'value']),
            description: 'Breakpoints, by time from the start of the episode.',
          },
          show: { type: 'boolean', description: 'Also show this lane on the track in the timeline (default true).' },
        },
        ['track', 'lane', 'points'],
      ),
      annotations: { title: 'Set track automation', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'track', true));
        if (target === MASTER) throw new ToolError('The master bus has no automation; use a track.');
        const lane = str(args, 'lane', true);
        if (lane !== 'volume' && lane !== 'pan') throw new ToolError('"lane" must be "volume" or "pan".');
        if (!Array.isArray(args.points)) throw new ToolError('"points" must be a list.');
        const points = (args.points as Array<Record<string, unknown>>).map((q, i) => {
          const sec = Number(q?.seconds);
          const value = Number(q?.value);
          if (!(sec >= 0) || !Number.isFinite(value)) throw new ToolError(`Point ${i + 1} needs "seconds" (0 or more) and a numeric "value".`);
          return { pos: Math.round(sec * project.sampleRate), value };
        });
        project = setTrackAutomation(project, target, lane, points);
        if (bool(args, 'show') !== false && points.length) project = showTrackAutomation(project, target, lane);
        host.apply(project, points.length ? `${lane === 'volume' ? 'Volume' : 'Pan'} automation on ${name}` : `Cleared ${lane} automation on ${name}`);
        const t = host.project().tracks.find((x) => x.id === target);
        return { track: name, lane, points: (t?.automation?.[lane] ?? []).map((q) => ({ seconds: round(q.pos / project.sampleRate, 3), value: round(q.value, 2) })) };
      },
    },
    {
      name: 'list_takes',
      description:
        'Lists the takes of a track: every pass recorded over the same lines (loop recording, retakes), with where each one is on the timeline and which parts of it the comp plays now. ' +
        'Takes exist when a line was recorded more than once; use_take picks one, or splices part of one into the comp.',
      inputSchema: obj({ track: { type: 'string', description: 'Track id or name.' } }, ['track']),
      annotations: { title: 'List takes', ...READ },
      run: (args) => {
        const p = host.project();
        const { target, name } = resolveTarget(p, str(args, 'track', true));
        if (target === MASTER) throw new ToolError('The master bus has no takes; use a track.');
        const t = p.tracks.find((x) => x.id === target)!;
        const sec = (f: number) => round(f / p.sampleRate, 3);
        return {
          track: name,
          takes: (t.takes ?? []).map((k) => {
            const [a, b] = takeSpan(k);
            return { take: k.n, id: k.id, startSeconds: sec(a), endSeconds: sec(b), playing: takeUsage(t, k.id).map(([x, y]) => ({ startSeconds: sec(x), endSeconds: sec(y) })) };
          }),
        };
      },
    },
    {
      name: 'use_take',
      description:
        'Makes a take play (comping). Without times the whole take replaces what plays over its stretch; with startSeconds and endSeconds only that part of the take is spliced into the comp, e.g. take 2 for the first sentence and take 3 for the rest. ' +
        'Nothing is deleted: the other takes stay and can be picked again.',
      inputSchema: obj(
        {
          track: { type: 'string', description: 'Track id or name.' },
          take: { type: 'number', description: 'Take number, as list_takes shows it.' },
          startSeconds: { type: 'number', minimum: 0 },
          endSeconds: { type: 'number', minimum: 0 },
        },
        ['track', 'take'],
      ),
      annotations: { title: 'Use take', ...EDIT, idempotentHint: true },
      run: (args) => {
        let project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'track', true));
        if (target === MASTER) throw new ToolError('The master bus has no takes; use a track.');
        const t = project.tracks.find((x) => x.id === target)!;
        const n = Number(args.take);
        const take = t.takes?.find((k) => k.n === n);
        if (!take) throw new ToolError(`${name} has no take ${args.take}${t.takes?.length ? ` (takes: ${t.takes.map((k) => k.n).join(', ')})` : ' (it has no takes)'}.`);
        const hasRange = args.startSeconds !== undefined || args.endSeconds !== undefined;
        if (hasRange) {
          const a = Number(args.startSeconds);
          const b = Number(args.endSeconds);
          if (!(a >= 0) || !(b > a)) throw new ToolError('Give both startSeconds and endSeconds, with endSeconds after startSeconds.');
          const next = compTake(project, target, take.id, Math.round(a * project.sampleRate), Math.round(b * project.sampleRate));
          if (next === project) throw new ToolError(`Take ${n} has no audio between ${a} s and ${b} s.`);
          project = next;
        } else project = pickTake(project, target, take.id);
        host.apply(project, `${name}: take ${n}${hasRange ? ' (part)' : ''}`);
        const after = host.project().tracks.find((x) => x.id === target)!;
        return { track: name, take: n, playing: takeUsage(after, take.id).map(([x, y]) => ({ startSeconds: round(x / project.sampleRate, 3), endSeconds: round(y / project.sampleRate, 3) })) };
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
        const words = timelineWords(p, host.transcripts?.() ?? {}, host.transcriptFilter?.());
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
      name: 'get_script',
      description:
        'The audio drama script the user imported in WavePod (View › Script): scenes, stage directions and every line with its character, ' +
        'whether it is recorded yet, and where its take is on the timeline (seconds). Useful to see what is still to record, or to check a scene.',
      inputSchema: obj({ open: { type: 'boolean', description: 'Only lines that are not recorded yet (and their scene headings).' } }),
      annotations: { title: 'Get script', ...READ },
      run: (args) => {
        const p = host.project();
        const script = p.script;
        if (!script) return { imported: false, note: 'No script yet. The user can import one in WavePod: File › Import Script… (plain text, Fountain, Final Draft or PlotGod).' };
        let lines = scriptSummary(p);
        if (bool(args, 'open')) lines = lines.filter((l) => l.kind === 'scene' || (l.kind === 'dialogue' && !l.recorded));
        const names = new Map(p.tracks.map((t) => [t.id, t.name]));
        return {
          imported: true,
          title: script.title,
          progress: scriptProgress(script),
          characters: scriptCharacters(script).map((c) => ({ name: c.name, lines: c.lines, recorded: c.recorded, ...(script.cast[c.key] && names.has(script.cast[c.key]) ? { track: names.get(script.cast[c.key]) } : {}) })),
          lines,
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
      name: 'list_cameras',
      description:
        'The cameras of a video podcast: number (the key that switches to it), name, size, frame rate, the track holding its sound (its picture follows the clips there) and the speaker tracks it shows. ' +
        'Empty when the episode has no video (File › Import Camera Video… in WavePod).',
      inputSchema: obj({}),
      annotations: { title: 'List cameras', ...READ },
      run: () => {
        const p = host.project();
        const names = new Map(p.tracks.map((t) => [t.id, t.name]));
        return {
          cameras: (p.cameras ?? []).map((c, i) => ({
            number: i + 1,
            id: c.id,
            name: c.name,
            width: c.width,
            height: c.height,
            fps: c.fps,
            soundTrack: cameraTrack(p, c.id)?.name ?? null,
            shows: (c.speakers ?? []).map((id) => names.get(id)).filter(Boolean),
          })),
        };
      },
    },
    {
      name: 'get_director',
      description: 'Which camera the video shows when: the director switches (seconds, camera number and name, dissolve length), as shots with their start and end.',
      inputSchema: obj({}),
      annotations: { title: 'Get director switches', ...READ },
      run: () => {
        const p = host.project();
        const sr = p.sampleRate;
        const cams = p.cameras ?? [];
        if (!cams.length) return { cameras: 0, note: 'The episode has no cameras.' };
        return {
          shots: shots(p, clipsEnd(p)).map((s) => {
            const n = cams.findIndex((c) => c.id === s.camera);
            const cut = p.director!.cuts[s.index];
            return {
              startSeconds: round(s.start / sr, 3),
              endSeconds: round(s.end / sr, 3),
              camera: n + 1,
              name: cams[n]?.name,
              ...(cut.dissolve ? { dissolveSeconds: round(cut.dissolve / sr, 2) } : {}),
            };
          }),
        };
      },
    },
    {
      name: 'set_director_cuts',
      description:
        'Sets camera switches for the video: each switch shows a camera from its time on (until the next switch). With fromSeconds/toSeconds only that stretch is replaced and what showed after it carries on; without, all switches are replaced. ' +
        'Use the transcript (get_transcript) to cut to whoever speaks. Cameras by number (list_cameras) or name.',
      inputSchema: obj(
        {
          switches: {
            type: 'array',
            items: obj(
              {
                seconds: { type: 'number', minimum: 0 },
                camera: { type: ['number', 'string'], description: 'Camera number (1…) or name.' },
                dissolveSeconds: { type: 'number', minimum: 0, maximum: 5 },
              },
              ['seconds', 'camera'],
            ),
          },
          fromSeconds: { type: 'number', minimum: 0 },
          toSeconds: { type: 'number', minimum: 0 },
        },
        ['switches'],
      ),
      annotations: { title: 'Set director switches', ...EDIT },
      run: (args) => {
        let project = host.project();
        const cams = project.cameras ?? [];
        if (!cams.length) throw new ToolError('The episode has no cameras. The user imports them in WavePod: File › Import Camera Video….');
        const sr = project.sampleRate;
        const list = Array.isArray(args.switches) ? (args.switches as Array<Record<string, unknown>>) : [];
        const cuts: DirectorCut[] = list.map((sw, i) => {
          const sec = Number(sw.seconds);
          const ref = sw.camera;
          const cam = typeof ref === 'number' ? cams[ref - 1] : cams.find((c) => c.id === ref || c.name.toLowerCase() === String(ref).toLowerCase()) ?? cams[Number(ref) - 1];
          if (!(sec >= 0) || !cam) throw new ToolError(`Switch ${i + 1} needs "seconds" and a camera (1…${cams.length} or a name).`);
          const d = Number(sw.dissolveSeconds);
          return { at: Math.round(sec * sr), camera: cam.id, ...(d > 0 ? { dissolve: Math.round(d * sr) } : {}) };
        });
        const hasRange = args.fromSeconds !== undefined || args.toSeconds !== undefined;
        if (hasRange) {
          const a = Math.round(Number(args.fromSeconds ?? 0) * sr);
          const b = args.toSeconds === undefined ? clipsEnd(project) : Math.round(Number(args.toSeconds) * sr);
          if (!(b > a)) throw new ToolError('toSeconds must be after fromSeconds.');
          project = applyPass(project, a, b, cuts);
        } else project = { ...project, director: { cuts: normalizeCuts(cuts) } };
        host.apply(project, `Camera switches (${cuts.length})`);
        return { switches: host.project().director?.cuts.length ?? 0 };
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
      name: 'list_impulse_responses',
      description: "The impulse responses (WAV recordings of rooms) in the user's Impulse responses folder, for the convolution reverb filter. Use set_impulse_response to give a convolution filter one.",
      inputSchema: obj({}, []),
      annotations: { title: 'List impulse responses', ...READ },
      run: () => ({ impulseResponses: (host.impulses?.() ?? []).map((f) => ({ name: f.name, seconds: Math.round(f.seconds * 100) / 100, channels: f.channels })) }),
    },
    {
      name: 'set_impulse_response',
      description: 'Sets which impulse response (by name, from list_impulse_responses) a convolution reverb filter uses. One undo step.',
      inputSchema: obj({ target: TARGET, filter: FILTER, impulse: { type: 'string', description: 'Name from list_impulse_responses.' } }, ['target', 'filter', 'impulse']),
      annotations: { title: 'Set impulse response', ...EDIT, idempotentHint: true },
      run: async (args) => {
        const project = host.project();
        const { target, name } = resolveTarget(project, str(args, 'target', true));
        const fx = resolveFilter(fxList(project, target), str(args, 'filter', true));
        if (fx.type !== 'convolution') throw new ToolError(`${filterName(fx)} is not a convolution reverb.`);
        const want = str(args, 'impulse', true)!.trim().toLowerCase();
        const list = host.impulses?.() ?? [];
        const ir = list.find((f) => f.name.toLowerCase() === want || f.file.toLowerCase() === want) ?? list.find((f) => f.name.toLowerCase().includes(want));
        if (!ir) throw new ToolError(`No impulse response "${want}". Available: ${list.map((f) => f.name).join(', ') || 'none (the folder is empty)'}.`);
        host.apply(updateFx(project, target, fx.id, { ir: { file: ir.file, name: ir.name } }), `${filterName(fx)} on ${name} now uses "${ir.name}"`);
        const list2 = fxList(host.project(), target);
        const i = list2.findIndex((f) => f.id === fx.id);
        return { target, name, filter: await describeFx(host, list2[i], i) };
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
