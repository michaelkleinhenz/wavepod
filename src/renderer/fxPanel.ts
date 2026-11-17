// Filter stack editor for a track or the master bus: add, bypass, tweak, reorder and remove filters.
import type { Fx, FxMeter, FxType, ImpulseRef, VstParamInfo, VstPluginInfo } from '../shared/types';
import type { ImpulseFile } from '../shared/api';
import { FX_DEFINITIONS, fxDefinition, type FxParamSpec } from '../core/fx/definitions';
import { MASTER, addFx, addVoiceChain, clipTarget, fxList, insertFx, moveFx, removeFx, replaceFx, targetClipId, updateFx, type FxTarget } from '../core/fx/stack';
import { clipGroup, findGroup, groupClips, groupMembers, groupTarget, targetGroupId, ungroupClips } from '../core/fx/clipGroups';
import { presetEdited, presetKey, type FxPresetEntry } from '../core/fx/presets';
import { createVstFx, visibleVstParams } from '../core/fx/vst';
import { dynamicsCurve } from '../core/fx/ultraschallDynamics';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { api, store } from './store';
import { sidebar } from './sidebar';
import { findClip, updateTrack } from '../core/project';
import { DUCK_DEFAULT_DEPTH } from '../core/ducking';
import { AUTOMIX_DEFAULT_DEPTH, AUTOMIX_DEPTHS } from '../core/automix';
import { editableNumber, editableValue, isEditingValue } from './valueEdit';
import { leadingNumber, parseNumberInput, precisionForStep } from '../core/numberInput';
import { clipboardLabel, copyFilter, copyStack, pasteFilters, pasteSettings, settingsSource, type FxClipboard } from '../core/fx/fxClipboard';
import { iconButton } from './icons';
import { MATCH_BANDS, MATCH_MAX_DB } from '../core/fx/matchEq';
import { VOICE_EFFECTS, addVoiceEffect, findVoiceEffect, type VoiceEffect } from '../core/fx/voiceEffects';

const EFFECT_PREFIX = 'effect:';
const effectOption = (e: VoiceEffect) =>
  h('option', { value: EFFECT_PREFIX + e.id, title: `${e.description}\n${e.chain.map(([t, n]) => `${fxDefinition(t).name} "${n}"`).join(' → ')}` }, e.name);

const VST_OPTION = '__vst3';
const SAVE_PRESET = '__save';
const PRESETS_FOLDER = '__folder';
/** Plug-ins with many parameters show this many sliders until "Show all" is clicked. */
const VST_COLLAPSED_PARAMS = 12;
const PASTE_END = 'end';
const PASTE_TOP = 'top';
const PASTE_REPLACE = 'replace';

/** Copied filters; kept for the whole session, so they can go onto tracks of another episode too. */
let fxClipboard: FxClipboard | null = null;

/** "2.1 s · stereo · 48 kHz" for an impulse response. */
function impulseInfo(f: ImpulseFile): string {
  return `${f.seconds.toFixed(f.seconds < 10 ? 2 : 1)} s · ${f.channels === 1 ? 'mono' : 'stereo'} · ${f.sampleRate / 1000} kHz`;
}

/** Display name of a filter. */
/** A clip's name as the timeline shows it (its file name when it has none). */
function clipLabel(clip: { name?: string; file: string }): string {
  return clip.name || clip.file.split('/').pop() || 'Clip';
}

function fxName(fx: Fx): string {
  return fx.type === 'vst3' ? (fx.plugin?.name ?? 'VST3 plug-in') : fxDefinition(fx.type).name;
}

/** Filters whose settings are folded away, by filter id, kept across restarts. */
const COLLAPSED_KEY = 'wavepod.fxCollapsed';
const COLLAPSED_MAX = 500;

function loadCollapsed(): Set<string> {
  try {
    const ids = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(ids: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids].slice(-COLLAPSED_MAX)));
  } catch {
    // storage unavailable: the state just isn't remembered
  }
}

function formatValue(spec: FxParamSpec, v: number): string {
  if (spec.options) return spec.options.find((o) => o.value === v)?.label ?? String(v);
  if (spec.offAt !== undefined && v <= spec.offAt) return 'Off';
  if (spec.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  const digits = spec.step < 0.1 ? 2 : spec.step < 1 ? 1 : 0;
  const s = v.toFixed(digits);
  return spec.unit === ':1' ? `${s}:1` : `${spec.unit === 'dB' && v > 0 ? '+' : ''}${s}${spec.unit ? ` ${spec.unit}` : ''}`;
}

// sliders for frequencies move on a log scale
const toSlider = (spec: FxParamSpec, v: number) => (spec.log ? (Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * 1000 : v);
const fromSlider = (spec: FxParamSpec, s: number) => {
  if (!spec.log) return s;
  const v = spec.min * Math.pow(spec.max / spec.min, s / 1000);
  if (v >= 1000) return Math.round(v / 10) * 10;
  if (spec.step >= 1 || v >= 100) return Math.round(v);
  // fine steps (metres, LFO speeds): two significant digits below 10, the step's precision above
  const q = v < 10 ? Math.max(spec.step, v < 1 ? 0.01 : 0.1) : 1;
  return Math.round(v / q) * q;
};

export class FxPanel {
  readonly el = h('aside', { class: 'fx-panel' });
  target: FxTarget | null = null;
  private dragId: string | null = null;
  private structure = '';
  private vstAvailable: boolean | null = null;
  private picker: { plugins: VstPluginInfo[] | null; query: string; busy: string | null } | null = null;
  private expanded = new Set<string>();
  private collapsed = loadCollapsed();
  private meters = new Map<string, LiveMeter>();
  /** Preset lists by preset key (filter type or plug-in), loaded when a card first shows them. */
  private presets = new Map<string, FxPresetEntry[] | Promise<FxPresetEntry[]>>();
  /** The impulse responses in the user's folder (loaded when a convolution filter is shown). */
  private impulses: ImpulseFile[] | Promise<ImpulseFile[]> | null = null;
  /** The card whose preset row is a name field: saving a new preset or renaming the current one. */
  private naming: { fxId: string; mode: 'save' | 'rename' } | null = null;
  /** On screen in the sidebar. The target stays while another tab shows, for when FX comes back. */
  private visible = false;

  /** Shows the filters of a track, a clip or the master bus in the sidebar's FX tab. */
  open(target: FxTarget): void {
    this.target = target;
    this.structure = '';
    this.picker = null;
    this.checkVst();
    if (this.visible) this.render();
    sidebar().show('fx');
    store.notify('project');
  }

  private checkVst(): void {
    if (this.vstAvailable !== null) return;
    this.vstAvailable = false;
    api()
      .vstStatus()
      .then((s) => {
        this.vstAvailable = s.available;
        if (s.available && this.target && this.visible) this.render();
      })
      .catch(() => {});
  }

  /** The target whose filters are showing in the sidebar now (null with the FX tab not chosen). */
  get shownTarget(): FxTarget | null {
    return sidebar().isOpen('fx') ? this.target : null;
  }

  /** The sidebar put the FX tab on screen. */
  enterSidebar(): void {
    this.visible = true;
    this.checkVst();
    this.structure = '';
    this.render();
    store.notify('project');
  }

  /** The FX tab went off screen; it keeps its target for when it comes back. */
  leaveSidebar(): void {
    this.visible = false;
    store.notify('project');
  }

  /** Folds the sidebar if it shows the filters. */
  close(): void {
    sidebar().close('fx');
  }

  /** The FX button of a track or clip: shows its filters, or folds the sidebar if they are showing. */
  toggle(target: FxTarget): void {
    if (this.shownTarget === target) this.close();
    else this.open(target);
  }

  /** What a clip's FX button opens: its group FX chain when it is in one, else its own filters. */
  clipFxTarget(clipId: string): FxTarget {
    const clip = findClip(store.project, clipId)?.clip;
    const group = clip ? clipGroup(store.project, clip) : undefined;
    return group ? groupTarget(group.id) : clipTarget(clipId);
  }

  /** True while the filters the clip's FX button opens are showing. */
  isClipShown(clipId: string): boolean {
    const shown = this.shownTarget;
    return shown !== null && shown === this.clipFxTarget(clipId);
  }

  /**
   * The FX button of a clip. With several clips selected (this one among them) it opens the group
   * FX chain they share, making one or adding the others to it when needed (see groupClips).
   */
  clipButton(clipId: string): void {
    const sel = store.selection.clipIds;
    if (sel.size > 1 && sel.has(clipId)) {
      const res = groupClips(store.project, sel);
      if (res) {
        if (res.action === 'open') return this.toggle(groupTarget(res.groupId));
        store.edit(() => res.project);
        const n = groupMembers(res.project, res.groupId).length;
        toast(res.action === 'added' ? `Added to the group FX chain (${n} clips)` : `New group FX chain for ${n} clips`);
        return this.open(groupTarget(res.groupId));
      }
    }
    this.toggle(this.clipFxTarget(clipId));
  }

  /** Re-renders when the stack changed from outside (undo, other edits), but not during slider drags. */
  refresh(): void {
    if (!this.visible || store.liveEditing || isEditingValue(this.el) || this.naming) return;
    if (!this.target) {
      // the list of tracks to choose from
      const key = this.chooserKey();
      if (key !== this.structure) this.render();
      return;
    }
    const clipId = targetClipId(this.target);
    const groupId = targetGroupId(this.target);
    const gone =
      groupId !== null
        ? !findGroup(store.project, groupId)
        : clipId !== null
          ? !findClip(store.project, clipId)
          : this.target !== MASTER && !store.project.tracks.some((t) => t.id === this.target);
    if (gone) {
      // its track or clip is gone: back to the list of tracks
      this.target = null;
      this.render();
      return;
    }
    if (this.structureKey(this.target) !== this.structure) this.render();
  }

  /** What the panel shows for a target; a change re-renders it. */
  private structureKey(target: FxTarget): string {
    const p = store.project;
    const groupId = targetGroupId(target);
    const clipId = targetClipId(target);
    const members =
      groupId !== null
        ? groupMembers(p, groupId).map(({ clip }) => `${clip.id}:${clip.name ?? clip.file}:${clip.fx?.length ?? 0}`).join('|') + `|sel:${[...store.selection.clipIds].join(',')}`
        : clipId !== null
          ? (findClip(p, clipId)?.clip.fxGroup ?? '')
          : '';
    return JSON.stringify(fxList(p, target)) + this.title() + members;
  }

  private title(): string {
    if (this.target === MASTER) return 'Master';
    const groupId = this.target ? targetGroupId(this.target) : null;
    if (groupId !== null) {
      const n = groupMembers(store.project, groupId).length;
      return `Group FX · ${n} clip${n === 1 ? '' : 's'}`;
    }
    const clipId = this.target ? targetClipId(this.target) : null;
    if (clipId !== null) {
      const hit = findClip(store.project, clipId);
      return hit ? `${hit.track.name}: ${clipLabel(hit.clip)}` : '';
    }
    return store.project.tracks.find((t) => t.id === this.target)?.name ?? '';
  }

  private edit(fn: Parameters<typeof store.edit>[0]): void {
    store.edit(fn);
    this.render();
  }

  private render(): void {
    keepScroll(this.el, () => this.build());
  }

  /** Back to the list of tracks. */
  private choose(): void {
    this.target = null;
    this.picker = null;
    this.render();
    store.notify('project');
  }

  private chooserKey(): string {
    return 'choose:' + store.project.tracks.map((t) => `${t.id}:${t.name}:${t.color}:${t.fx?.length ?? 0}`).join('|') + `|${store.project.masterFx?.length ?? 0}`;
  }

  /** With nothing chosen yet: the master bus and every track, to pick whose filters to show. */
  private buildChooser(): void {
    this.structure = this.chooserKey();
    clear(this.el);
    this.meters.clear();
    const row = (label: string, count: number, target: FxTarget, color?: string) =>
      h(
        'button',
        { class: 'fx-choose-row', onclick: () => this.open(target) },
        h('span', { class: 'fx-choose-dot', style: color ? `background:${color}` : '' }),
        h('span', { class: 'fx-choose-name' }, label),
        h('span', { class: 'fx-choose-count muted' }, count ? `${count} filter${count === 1 ? '' : 's'}` : 'none'),
      );
    this.el.append(
      h('div', { class: 'fx-head' }, h('div', null, h('div', { class: 'fx-kicker' }, 'Filters'), h('h2', null, 'Choose a track'))),
      h('p', { class: 'muted fx-empty' }, 'Pick the master bus or a track to see its filters. The FX button on a track or a clip opens its filters here too.'),
      h(
        'div',
        { class: 'fx-choose' },
        row('Master', store.project.masterFx?.length ?? 0, MASTER),
        ...store.project.tracks.map((t) => row(t.name, t.fx?.length ?? 0, t.id, t.color)),
      ),
    );
  }

  private build(): void {
    const target = this.target;
    if (!target) return this.buildChooser();
    const list = fxList(store.project, target);
    this.structure = this.structureKey(target);
    const groupId = targetGroupId(target);
    const isTrack = target !== MASTER && targetClipId(target) === null && groupId === null;
    clear(this.el);
    this.meters.clear();
    const add = h(
      'select',
      {
        class: 'fx-add',
        onchange: (e: Event) => {
          const type = (e.target as HTMLSelectElement).value;
          if (type === VST_OPTION) return this.openPicker();
          if (type.startsWith(EFFECT_PREFIX)) return this.addEffect(target, type.slice(EFFECT_PREFIX.length));
          if (type) this.edit((p) => addFx(p, target, type as FxType).project);
        },
      },
      h('option', { value: '' }, '+ Add filter…'),
      h(
        'optgroup',
        { label: 'Filters' },
        ...FX_DEFINITIONS.map((d) => h('option', { value: d.type, title: d.description }, d.name)),
        this.vstAvailable ? h('option', { value: VST_OPTION, title: 'Add an installed VST3 effect' }, 'VST3 plug-in…') : null,
      ),
      h(
        'optgroup',
        { label: 'Voice effects (audio drama)' },
        ...VOICE_EFFECTS.filter((e) => e.group !== 'place').map(effectOption),
      ),
      h('optgroup', { label: 'Places: room & distance' }, ...VOICE_EFFECTS.filter((e) => e.group === 'place').map(effectOption)),
    );
    this.el.append(
      h(
        'div',
        { class: 'fx-head' },
        h('div', null, h('div', { class: 'fx-kicker' }, groupId !== null ? 'Group filters' : targetClipId(target) !== null ? 'Clip filters' : 'Filters'), h('h2', null, this.title())),
        h('button', { class: 'small fx-choose-btn', title: 'Show the filters of another track or the master bus', onclick: () => this.choose() }, 'All tracks'),
      ),
      h(
        'div',
        { class: 'fx-toolbar' },
        add,
        list.length === 0 && target !== MASTER ? h('button', { class: 'small', title: 'High-pass, De-esser and Dynamics', onclick: () => this.addVoiceChain() }, 'Voice chain') : null,
        list.length ? h('button', { class: 'small fx-copy-all', title: 'Copy the whole filter stack with all settings, to paste on another track', onclick: () => this.copyAll(target) }, 'Copy all') : null,
        this.pasteMenu(target, list.length),
      ),
    );
    if (isTrack) this.el.append(this.renderDuck(target), this.renderAutomix(target));
    if (groupId !== null) this.el.append(this.renderGroupMembers(groupId));
    const ownClip = targetClipId(target);
    if (ownClip !== null) {
      const note = this.renderClipGroupNote(ownClip);
      if (note) this.el.append(note);
    }
    if (this.picker) this.el.append(this.renderPicker(target));
    const cards = h('div', { class: 'fx-list' });
    if (!list.length) {
      cards.append(h('p', { class: 'muted fx-empty' }, target === MASTER
            ? 'No filters on the master bus. A limiter here keeps the mix below a ceiling.'
            : groupId !== null
              ? 'No group filters yet. They run on every clip of the group, each on its own, after the clip\'s own filters. Change them once and every clip follows.'
              : targetClipId(target) !== null
              ? 'No filters on this clip yet. They run top to bottom on this clip only, after the track\'s filters.'
              : 'No filters yet. Filters run top to bottom, before the track gain and pan.'));
    }
    list.forEach((fx, i) => cards.append(this.card(target, fx, i, list.length)));
    this.el.append(cards);
  }

  /** The clips of a group FX chain, each with a button to take it out (and to open its own filters). */
  private renderGroupMembers(groupId: string): HTMLElement {
    const p = store.project;
    const members = groupMembers(p, groupId);
    const sel = store.selection.clipIds;
    const joinable = [...sel].filter((id) => {
      const c = findClip(p, id)?.clip;
      return c && c.fxGroup !== groupId;
    });
    const remove = (ids: string[]) => {
      this.edit((q) => ungroupClips(q, ids));
      toast(ids.length === members.length ? 'Group FX chain removed' : ids.length === 1 ? 'Clip removed from the group FX chain' : `${ids.length} clips removed from the group FX chain`);
    };
    const row = ({ trackId, clip }: { trackId: string; clip: (typeof members)[number]['clip'] }) => {
      const track = p.tracks.find((t) => t.id === trackId);
      const own = clip.fx?.length ?? 0;
      return h(
        'div',
        { class: 'fx-group-member' },
        h('span', { class: 'fx-choose-dot', style: track ? `background:${track.color}` : '' }),
        h(
          'button',
          {
            class: 'link fx-group-name',
            title: 'Select this clip on the timeline',
            onclick: () => store.select({ clipIds: new Set([clip.id]), markerId: null }),
          },
          `${track?.name ?? ''}: ${clipLabel(clip)}`,
        ),
        own
          ? h(
              'button',
              { class: 'small', title: 'This clip also has filters of its own, which run before the group\'s. Show them.', onclick: () => this.open(clipTarget(clip.id)) },
              `Own FX ${own}`,
            )
          : null,
        h('button', { class: 'small fx-group-remove', title: 'Take this clip out of the group FX chain: the group filters no longer apply to it', onclick: () => remove([clip.id]) }, 'Remove'),
      );
    };
    return h(
      'div',
      { class: 'fx-group' },
      h(
        'div',
        { class: 'fx-group-head' },
        h('span', { class: 'muted' }, 'Clips in this group'),
        joinable.length
          ? h(
              'button',
              {
                class: 'small',
                title: 'Add the selected clips to this group FX chain',
                onclick: () => this.edit((q) => ({ ...q, tracks: q.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (joinable.includes(c.id) ? { ...c, fxGroup: groupId } : c)) })) })),
              },
              `Add selected (${joinable.length})`,
            )
          : null,
        members.length > 1
          ? h('button', { class: 'small', title: 'Take every clip out and delete this group FX chain', onclick: () => remove(members.map((m) => m.clip.id)) }, 'Ungroup all')
          : null,
      ),
      h('div', { class: 'fx-group-list' }, ...members.map(row)),
    );
  }

  /** On a grouped clip's own filters: which group it is in, with a way there and out. */
  private renderClipGroupNote(clipId: string): HTMLElement | null {
    const clip = findClip(store.project, clipId)?.clip;
    const group = clip ? clipGroup(store.project, clip) : undefined;
    if (!clip || !group) return null;
    const n = groupMembers(store.project, group.id).length;
    return h(
      'div',
      { class: 'fx-group-note' },
      h('span', null, `In a group FX chain with ${n - 1} other clip${n === 2 ? '' : 's'}; its filters run after these.`),
      h('button', { class: 'small', onclick: () => this.open(groupTarget(group.id)) }, 'Group FX'),
      h('button', { class: 'small', title: 'Take this clip out of the group FX chain', onclick: () => this.edit((q) => ungroupClips(q, [clipId])) }, 'Remove'),
    );
  }

  /** Ducking for this track: quieter while the other tracks play (for the soundboard and music beds). */
  private renderDuck(trackId: string): HTMLElement {
    const track = store.project.tracks.find((t) => t.id === trackId);
    const duck = track?.duck ?? { enabled: false, depth: DUCK_DEFAULT_DEPTH };
    const set = (patch: Partial<typeof duck>) => this.edit((p) => updateTrack(p, trackId, { duck: { ...duck, ...patch } }));
    return h(
      'div',
      { class: 'fx-duck' },
      h(
        'label',
        { class: 'check', title: 'This track gets quieter while the other tracks play, and comes back up in the pauses. Playback and export.' },
        h('input', { type: 'checkbox', checked: duck.enabled, onchange: (e: Event) => set({ enabled: (e.target as HTMLInputElement).checked }) }),
        'Duck under the other tracks',
      ),
      h(
        'select',
        { disabled: !duck.enabled, title: 'How much quieter', onchange: (e: Event) => set({ depth: Number((e.target as HTMLSelectElement).value) }) },
        ...[6, 9, 12, 18, 24].map((d) => h('option', { value: String(d), selected: d === duck.depth }, `−${d} dB`)),
      ),
    );
  }

  /** Automix for this track: turned down while another automixed track is louder (crosstalk removal). */
  private renderAutomix(trackId: string): HTMLElement {
    const track = store.project.tracks.find((t) => t.id === trackId);
    const am = track?.automix ?? { enabled: false, depth: AUTOMIX_DEFAULT_DEPTH };
    const set = (patch: Partial<typeof am>) => this.edit((p) => updateTrack(p, trackId, { automix: { ...am, ...patch } }));
    const others = store.project.tracks.filter((t) => t.id !== trackId && t.automix?.enabled && !t.duck?.enabled).length;
    return h(
      'div',
      { class: 'fx-duck fx-automix' },
      h(
        'label',
        {
          class: 'check',
          title:
            'Removes crosstalk: when several people share a room, every mic also picks up the others. Tick this on each speaker track; ' +
            'whoever is loudest stays up and the other automixed tracks are turned down. Two people talking at once both stay up. Playback and export.',
        },
        h('input', { type: 'checkbox', checked: am.enabled, disabled: !!track?.duck?.enabled, onchange: (e: Event) => set({ enabled: (e.target as HTMLInputElement).checked }) }),
        'Automix (remove crosstalk)',
      ),
      h(
        'select',
        { disabled: !am.enabled, title: 'How far this track is turned down at most while someone else speaks', onchange: (e: Event) => set({ depth: Number((e.target as HTMLSelectElement).value) }) },
        ...AUTOMIX_DEPTHS.map((d) => h('option', { value: String(d), selected: d === am.depth }, `−${d} dB`)),
      ),
      am.enabled && others === 0 ? h('span', { class: 'muted fx-automix-hint' }, 'Tick it on another speaker track too') : null,
    );
  }

  /** Appends a voice effect (a ready-made stack, e.g. Telephone) to the stack. */
  private addEffect(target: FxTarget, id: string): void {
    const effect = findVoiceEffect(id);
    if (!effect) return;
    this.edit((p) => addVoiceEffect(p, target, effect).project);
    toast(`Added ${effect.name}: ${effect.chain.map(([t]) => fxDefinition(t).name).join(', ')}`);
  }

  private copyAll(target: FxTarget): void {
    fxClipboard = copyStack(store.project, target, this.title());
    if (fxClipboard) toast(`Copied ${clipboardLabel(fxClipboard, fxName)}`);
    this.render();
  }

  private copyOne(fx: Fx): void {
    fxClipboard = copyFilter(fx, this.title());
    toast(`Copied ${fxName(fx)}`);
    this.render();
  }

  /** "Paste…" menu of the toolbar: add the copied filters at the end or top, or replace the stack. */
  private pasteMenu(target: FxTarget, count: number): HTMLElement | null {
    const clip = fxClipboard;
    if (!clip) return null;
    const what = clipboardLabel(clip, fxName);
    const many = clip.items.length > 1;
    return h(
      'select',
      {
        class: 'fx-paste',
        title: `Paste ${what}`,
        onchange: (e: Event) => {
          const el = e.target as HTMLSelectElement;
          const mode = el.value;
          el.value = '';
          if (!mode || !fxClipboard) return;
          const c = fxClipboard;
          this.edit((p) => pasteFilters(p, target, c, mode === PASTE_REPLACE ? 'replace' : mode === PASTE_TOP ? { index: 0 } : 'append'));
          toast(mode === PASTE_REPLACE ? `Replaced the filters with ${what}` : `Pasted ${what}`);
        },
      },
      h('option', { value: '' }, 'Paste…'),
      h('option', { value: PASTE_END }, count ? `Add ${many ? 'them' : 'it'} at the end` : `Add ${what}`),
      count ? h('option', { value: PASTE_TOP }, `Add ${many ? 'them' : 'it'} at the top`) : null,
      count ? h('option', { value: PASTE_REPLACE }, `Replace all ${count} filter${count === 1 ? '' : 's'}`) : null,
    );
  }

  private addVoiceChain(): void {
    const target = this.target!;
    this.edit((p) => addVoiceChain(p, target));
  }

  private card(target: FxTarget, fx: Fx, index: number, count: number): HTMLElement {
    const vst = fx.type === 'vst3';
    const def = vst ? null : fxDefinition(fx.type);
    const name = vst ? (fx.plugin?.name ?? 'VST3 plug-in') : def!.name;
    const description = vst ? `VST3 · ${fx.plugin?.vendor ?? ''}`.trim() : def!.description;
    const folded = this.collapsed.has(fx.id);
    const toggleFold = () => {
      if (folded) this.collapsed.delete(fx.id);
      else this.collapsed.add(fx.id);
      saveCollapsed(this.collapsed);
      this.render();
    };
    const curve = !folded && fx.type === 'dynamics' ? h('canvas', { class: 'fx-curve', width: 240, height: 160 }) : null;
    const meter = fx.enabled && !folded ? new LiveMeter(fx, curve) : null;
    if (meter) this.meters.set(fx.id, meter);
    const drawCurve = () => (meter ? meter.drawCurve() : curve && drawDynamicsCurve(curve, fx.params));
    const card = h(
      'section',
      { class: `fx-card${fx.enabled ? '' : ' bypassed'}${folded ? ' collapsed' : ''}`, draggable: 'true' },
      h(
        'div',
        { class: 'fx-card-head' },
        h('span', { class: 'fx-grip', title: 'Drag to reorder' }, '⋮⋮'),
        h(
          'button',
          { class: 'fx-fold', title: folded ? 'Show settings' : 'Hide settings', 'aria-expanded': String(!folded), onclick: toggleFold },
          folded ? '▸' : '▾',
        ),
        h('input', {
          type: 'checkbox',
          checked: fx.enabled,
          title: fx.enabled ? 'On (uncheck to bypass)' : 'Bypassed',
          onchange: (e: Event) => this.edit((p) => updateFx(p, target, fx.id, { enabled: (e.target as HTMLInputElement).checked })),
        }),
        h(
          'span',
          { class: 'fx-name', title: `${description}\nDouble-click to ${folded ? 'show' : 'hide'} the settings`, ondblclick: toggleFold },
          name,
          vst ? h('span', { class: 'fx-tag' }, 'VST3') : null,
          folded && fx.preset ? h('span', { class: 'fx-folded-preset' }, `${fx.preset.name}${presetEdited(fx) ? ' (edited)' : ''}`) : null,
        ),
        h('button', { class: 'toggle', title: 'Move up', disabled: index === 0, onclick: () => this.edit((p) => moveFx(p, target, fx.id, index - 1)) }, '↑'),
        h('button', { class: 'toggle', title: 'Move down', disabled: index === count - 1, onclick: () => this.edit((p) => moveFx(p, target, fx.id, index + 1)) }, '↓'),
        h('button', { class: 'toggle remove', title: 'Remove filter', onclick: () => this.edit((p) => removeFx(p, target, fx.id)) }, '×'),
      ),
      ...(folded
        ? []
        : [
            this.presetRow(target, fx),
            fx.type === 'convolution' ? this.impulseRow(target, fx) : null,
            fx.type === 'matcheq' ? this.matchRow(target, fx) : null,
            meter?.el ?? null,
            curve,
            ...(vst ? this.vstParamRows(target, fx) : def!.params.map((spec) => this.paramRow(target, fx, spec, drawCurve))),
          ]),
    );
    drawCurve();
    card.addEventListener('dragstart', (e) => {
      this.dragId = fx.id;
      e.dataTransfer?.setData('text/plain', fx.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      this.dragId = null;
      card.classList.remove('dragging');
    });
    card.addEventListener('dragover', (e) => {
      if (!this.dragId || this.dragId === fx.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      card.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      card.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = this.dragId;
      card.classList.remove('drop-before', 'drop-after');
      if (!id || id === fx.id) return;
      const r = card.getBoundingClientRect();
      const list = fxList(store.project, target);
      const from = list.findIndex((f) => f.id === id);
      let to = index + (e.clientY >= r.top + r.height / 2 ? 1 : 0);
      if (from < to) to--;
      this.edit((p) => moveFx(p, target, id, to));
    });
    // only the grip starts a drag, so sliders keep working
    card.addEventListener('mousedown', (e) => {
      card.draggable = (e.target as HTMLElement).classList.contains('fx-grip');
    });
    return card;
  }

  /** Shown when the copied filter is the same kind as this one: takes over its settings. */
  private pasteSettingsButton(target: FxTarget, fx: Fx, name: string): HTMLElement | null {
    const src = settingsSource(fxClipboard, fx);
    if (!src || !fxClipboard) return null;
    const c = fxClipboard;
    const from = src.preset ? `"${src.preset.name}"` : `the ${name} copied from ${c.from}`;
    return iconButton(
      'paste',
      { label: 'Paste settings', detail: `Sets this ${name} to the settings of ${from}.` },
      () => {
        this.edit((p) => pasteSettings(p, target, fx.id, c));
        toast(`Pasted the settings onto ${name}`);
      },
      'toggle fx-paste-settings',
    );
  }

  /** The preset menu of a card: load a factory/plug-in/user preset, save, rename or delete one. */
  private presetRow(target: FxTarget, fx: Fx): HTMLElement {
    if (this.naming?.fxId === fx.id) return this.presetNameRow(target, fx, this.naming.mode);
    const key = presetKey(fx);
    const label = fx.preset ? `${fx.preset.name}${presetEdited(fx) ? ' (edited)' : ''}` : 'Presets…';
    const select = h(
      'select',
      {
        class: 'fx-preset-select',
        title: fx.preset ? `Preset: ${label}` : 'Load or save a preset for this filter',
        onchange: (e: Event) => {
          const el = e.target as HTMLSelectElement;
          const id = el.value;
          el.value = '';
          if (id === SAVE_PRESET) {
            this.naming = { fxId: fx.id, mode: 'save' };
            this.render();
          } else if (id === PRESETS_FOLDER) {
            api().showPresetsFolder().catch((err) => toast(errorMessage(err), 'error'));
          } else if (id) {
            void this.loadPreset(target, fx, id);
          }
        },
      },
      h('option', { value: '' }, label),
    );
    const fill = (list: FxPresetEntry[]) => {
      // keep the first (label) option, replace the rest
      while (select.options.length > 1) select.remove(1);
      const group = (title: string, entries: FxPresetEntry[]) =>
        entries.length ? select.append(h('optgroup', { label: title }, ...entries.map((p) => h('option', { value: p.id, title: p.description }, p.name)))) : undefined;
      group(fx.type === 'vst3' ? 'Plug-in programs' : 'Factory', list.filter((p) => p.source !== 'user'));
      group('My presets', list.filter((p) => p.source === 'user'));
      select.append(h('optgroup', { label: '──────' }, h('option', { value: SAVE_PRESET }, 'Save as preset…'), h('option', { value: PRESETS_FOLDER }, 'Show presets folder')));
    };
    const cached = this.presets.get(key);
    if (Array.isArray(cached)) fill(cached);
    else {
      fill([]);
      this.presetList(fx).then(fill, () => {});
    }
    const user = fx.preset?.id.startsWith('user:') ? fx.preset : null;
    return h(
      'div',
      { class: 'fx-presets' },
      select,
      iconButton('copy', { label: `Copy ${fxName(fx)}`, detail: 'Copies this filter with its settings, to paste on another track.' }, () => this.copyOne(fx), 'toggle fx-copy'),
      this.pasteSettingsButton(target, fx, fxName(fx)),
      user ? h('button', { class: 'toggle', title: `Rename "${user.name}"`, onclick: () => ((this.naming = { fxId: fx.id, mode: 'rename' }), this.render()) }, '✎') : null,
      user ? h('button', { class: 'toggle remove', title: `Delete the preset "${user.name}"`, onclick: () => void this.deletePreset(target, fx) }, '🗑') : null,
    );
  }

  /** Voice match: the chosen reference per filter, and filters that are learning right now. */
  private matchChoice = new Map<string, string>();
  private matchBusy = new Set<string>();

  /** Voice match: pick the reference voice and learn the curve from it. */
  private matchRow(target: FxTarget, fx: Fx): HTMLElement {
    const REST = '__rest';
    const project = store.project;
    const clipId = targetClipId(target);
    const own = clipId !== null ? findClip(project, clipId)?.track : project.tracks.find((t) => t.id === target);
    if (!own) return h('div', { class: 'fx-ir-info warn' }, 'Voice match works on a track or a clip, not on the master bus.');
    const sourceIds = clipId !== null ? [clipId] : own.clips.map((c) => c.id);
    const options: Array<{ value: string; label: string; ids: string[] }> = [];
    if (clipId !== null) {
      const rest = own.clips.filter((c) => c.id !== clipId).map((c) => c.id);
      if (rest.length) options.push({ value: REST, label: `The rest of ${own.name}`, ids: rest });
    }
    for (const t of project.tracks) if (t.id !== own.id && t.clips.length) options.push({ value: t.id, label: t.name, ids: t.clips.map((c) => c.id) });
    const chosen = options.find((o) => o.value === this.matchChoice.get(fx.id)) ?? options[0];
    const busy = this.matchBusy.has(fx.id);
    const learn = () => {
      if (!chosen) return;
      this.matchBusy.add(fx.id);
      this.render();
      api()
        .learnMatch(sourceIds, chosen.ids)
        .then((r) => {
          this.edit((p) => updateFx(p, target, fx.id, { match: { gains: r.gains, reference: chosen.label } }));
          toast(`Learned how ${clipId !== null ? 'this clip' : own.name} differs from ${chosen.label} (${Math.round(r.sourceSeconds)} s and ${Math.round(r.referenceSeconds)} s of speech)`);
        })
        .catch((err) => toast(errorMessage(err), 'error'))
        .finally(() => {
          this.matchBusy.delete(fx.id);
          this.render();
        });
    };
    const select = h(
      'select',
      {
        class: 'fx-ir-select',
        title: 'The voice this one should sound like',
        disabled: busy || !options.length,
        onchange: (e: Event) => {
          this.matchChoice.set(fx.id, (e.target as HTMLSelectElement).value);
        },
      },
      ...(options.length ? options.map((o) => h('option', { value: o.value }, o.label)) : [h('option', { value: '' }, 'No other recording to match')]),
    ) as HTMLSelectElement;
    if (chosen) select.value = chosen.value;
    return h(
      'div',
      { class: 'fx-ir fx-match' },
      h(
        'div',
        { class: 'fx-presets' },
        h('span', { class: 'fx-match-label' }, 'Sound like'),
        select,
        h(
          'button',
          { class: 'toggle fx-ir-load', disabled: busy || !chosen, title: 'Compare the speech in both and set the EQ', onclick: learn },
          busy ? 'Learning…' : fx.match ? 'Learn again' : 'Learn',
        ),
      ),
      fx.match ? matchCurveSvg(fx.match.gains) : null,
      h(
        'div',
        { class: `fx-ir-info${fx.match ? '' : ' warn'}` },
        fx.match
          ? `Matched to ${fx.match.reference || 'a reference'}. Learn again after editing or recording more.`
          : 'Not learned yet: choose the voice to sound like and press Learn. Until then the filter does nothing.',
      ),
    );
  }

  /** Convolution reverb: which impulse response it uses, from the user's folder or a new file. */
  private impulseRow(target: FxTarget, fx: Fx): HTMLElement {
    const LOAD = '__load';
    const FOLDER = '__irfolder';
    const REFRESH = '__refresh';
    const list = Array.isArray(this.impulses) ? this.impulses : null;
    if (!this.impulses) this.refreshImpulses();
    const current = fx.ir ? list?.find((f) => f.file === fx.ir!.file) : undefined;
    const missing = !!fx.ir && !!list && !current;
    const setIr = (ir: ImpulseRef) => this.edit((p) => updateFx(p, target, fx.id, { ir }));
    const load = (file?: string) =>
      api()
        .importImpulseResponse(file)
        .then((ir) => {
          if (!ir) return;
          this.impulses = null;
          setIr(ir);
          toast(`Loaded the impulse response "${ir.name}"`);
        })
        .catch((err) => toast(errorMessage(err), 'error'));
    const select = h(
      'select',
      {
        class: 'fx-ir-select',
        title: 'The impulse response: a recording of the room this filter puts the sound into',
        onchange: (e: Event) => {
          const el = e.target as HTMLSelectElement;
          const v = el.value;
          el.value = fx.ir?.file ?? '';
          if (v === LOAD) void load();
          else if (v === FOLDER) api().showImpulseResponsesFolder().catch((err) => toast(errorMessage(err), 'error'));
          else if (v === REFRESH) this.refreshImpulses();
          else {
            const f = list?.find((x) => x.file === v);
            if (f) setIr({ file: f.file, name: f.name });
          }
        },
      },
      fx.ir ? null : h('option', { value: '' }, 'Choose an impulse response…'),
      missing ? h('option', { value: fx.ir!.file }, `${fx.ir!.name} (file not found)`) : null,
      ...(list ?? []).map((f) => h('option', { value: f.file, title: impulseInfo(f) }, f.name)),
      h(
        'optgroup',
        { label: '──────' },
        h('option', { value: LOAD }, 'Load a WAV or AIFF file…'),
        h('option', { value: FOLDER }, 'Show impulse responses folder'),
        h('option', { value: REFRESH }, 'Look for new files'),
      ),
    ) as HTMLSelectElement;
    select.value = fx.ir?.file ?? '';
    const row = h(
      'div',
      { class: 'fx-ir' },
      h('div', { class: 'fx-presets' }, select, h('button', { class: 'toggle fx-ir-load', title: 'Load a WAV or AIFF impulse response file', onclick: () => void load() }, 'Load…')),
      h(
        'div',
        { class: `fx-ir-info${missing || !fx.ir ? ' warn' : ''}` },
        !fx.ir
          ? 'No impulse response yet: load a WAV file of a room, or drop one here. Until then only the dry sound plays.'
          : missing
            ? `"${fx.ir.file}" is not in your Impulse responses folder. Load it again, or copy it there.`
            : current
              ? impulseInfo(current)
              : '',
      ),
    );
    row.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop');
      const file = e.dataTransfer?.files[0];
      const filePath = file ? api().pathForFile(file) : undefined;
      if (!filePath) return;
      e.preventDefault();
      e.stopPropagation();
      void load(filePath);
    });
    return row;
  }

  private refreshImpulses(): void {
    const pending = api()
      .listImpulseResponses()
      .then((list) => {
        this.impulses = list;
        this.render();
        return list;
      })
      .catch((err) => {
        this.impulses = [];
        toast(errorMessage(err), 'error');
        return [];
      });
    this.impulses = pending;
  }

  private presetList(fx: Fx): Promise<FxPresetEntry[]> {
    const key = presetKey(fx);
    const cached = this.presets.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = api()
      .listFxPresets(fx)
      .then((list) => {
        this.presets.set(key, list);
        return list;
      })
      .catch((e) => {
        this.presets.delete(key);
        throw e;
      });
    this.presets.set(key, pending);
    return pending;
  }

  /** Name field for saving or renaming; Enter confirms, Escape cancels. */
  private presetNameRow(target: FxTarget, fx: Fx, mode: 'save' | 'rename'): HTMLElement {
    const cancel = () => {
      this.naming = null;
      this.render();
    };
    const input = h('input', {
      type: 'text',
      class: 'fx-preset-name',
      placeholder: 'Preset name',
      value: fx.preset && (mode === 'rename' || fx.preset.id.startsWith('user:')) ? fx.preset.name : '',
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') void confirm();
        if (e.key === 'Escape') cancel();
      },
    });
    const confirm = async () => {
      const name = input.value.trim();
      if (!name) return input.focus();
      try {
        if (mode === 'save') {
          const res = await api().saveFxPreset(fx, name);
          this.naming = null;
          this.presets.delete(presetKey(fx));
          this.edit((p) => replaceFx(p, target, res.fx));
          toast(res.replaced ? `Replaced the preset "${res.entry.name}"` : `Saved the preset "${res.entry.name}"`);
        } else if (fx.preset) {
          const entry = await api().renameFxPreset(fx.preset.id, name);
          this.naming = null;
          this.presets.delete(presetKey(fx));
          this.edit((p) => replaceFx(p, target, { ...fx, preset: { ...fx.preset!, id: entry.id, name: entry.name } }));
        }
      } catch (e) {
        toast(errorMessage(e), 'error');
      }
    };
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return h(
      'div',
      { class: 'fx-presets' },
      input,
      h('button', { class: 'small', onclick: () => void confirm() }, mode === 'save' ? 'Save' : 'Rename'),
      h('button', { class: 'small', onclick: cancel }, 'Cancel'),
    );
  }

  private async loadPreset(target: FxTarget, fx: Fx, id: string): Promise<void> {
    try {
      const next = await api().applyFxPreset(fx, id);
      // the filter may have been removed while a plug-in program loaded
      if (!fxList(store.project, target).some((f) => f.id === fx.id)) return;
      this.edit((p) => replaceFx(p, target, { ...next, enabled: fxList(p, target).find((f) => f.id === fx.id)?.enabled ?? next.enabled }));
    } catch (e) {
      toast(errorMessage(e), 'error');
      this.render();
    }
  }

  private async deletePreset(target: FxTarget, fx: Fx): Promise<void> {
    const ref = fx.preset;
    if (!ref || !window.confirm(`Delete the preset "${ref.name}"? It is removed for all episodes.`)) return;
    try {
      await api().deleteFxPreset(ref.id);
      this.presets.delete(presetKey(fx));
      const { preset: _gone, ...rest } = fx;
      this.edit((p) => replaceFx(p, target, rest));
      toast(`Deleted the preset "${ref.name}"`);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  /** Feeds live filter activity from a transport update into the cards' meters. */
  updateMeters(meters: Record<string, FxMeter> | undefined): void {
    if (!this.target || !this.visible) return;
    for (const [id, m] of this.meters) m.update(meters?.[id]);
  }

  private openPicker(): void {
    this.picker = { plugins: null, query: '', busy: 'Looking for plug-ins…' };
    this.render();
    this.scan(false);
  }

  private scan(force: boolean): void {
    if (!this.picker) return;
    this.picker.busy = force ? 'Rescanning plug-ins…' : 'Looking for plug-ins…';
    this.render();
    api()
      .vstScan(force)
      .then((plugins) => {
        if (!this.picker) return;
        this.picker.plugins = plugins;
        this.picker.busy = null;
        this.render();
      })
      .catch((e) => {
        if (this.picker) this.picker.busy = null;
        toast(errorMessage(e), 'error');
        this.render();
      });
  }

  private renderPicker(target: FxTarget): HTMLElement {
    const picker = this.picker!;
    const q = picker.query.trim().toLowerCase();
    const plugins = (picker.plugins ?? []).filter((p) => !q || `${p.name} ${p.vendor} ${p.categories}`.toLowerCase().includes(q));
    const list = h('div', { class: 'vst-list' });
    if (picker.busy) list.append(h('p', { class: 'muted' }, picker.busy));
    else if (!picker.plugins?.length) list.append(h('p', { class: 'muted' }, 'No VST3 effects found in the standard plug-in folders.'));
    else if (!plugins.length) list.append(h('p', { class: 'muted' }, 'No plug-in matches.'));
    for (const p of plugins) {
      list.append(
        h(
          'button',
          { class: 'vst-item', title: p.path, onclick: () => this.addVst(target, p) },
          h('span', { class: 'vst-name' }, p.name),
          h('span', { class: 'vst-vendor' }, [p.vendor, p.categories.replace(/^Fx\|?/, '')].filter(Boolean).join(' · ')),
        ),
      );
    }
    const search = h('input', {
      type: 'search',
      placeholder: 'Search plug-ins',
      value: picker.query,
      oninput: (e: Event) => {
        picker.query = (e.target as HTMLInputElement).value;
        const next = this.renderPicker(target);
        this.el.querySelector('.vst-picker')?.replaceWith(next);
        (next.querySelector('input[type=search]') as HTMLInputElement | null)?.focus();
      },
    });
    return h(
      'div',
      { class: 'vst-picker' },
      h('div', { class: 'vst-picker-head' }, search, h('button', { class: 'small', disabled: !!picker.busy, title: 'Scan the plug-in folders again', onclick: () => this.scan(true) }, 'Rescan'), h('button', { class: 'small', onclick: () => ((this.picker = null), this.render()) }, 'Cancel')),
      list,
    );
  }

  private async addVst(target: FxTarget, plugin: VstPluginInfo): Promise<void> {
    if (!this.picker) return;
    this.picker.busy = `Loading ${plugin.name}…`;
    this.render();
    try {
      const ref = { path: plugin.path, cid: plugin.cid, name: plugin.name, vendor: plugin.vendor };
      const desc = await api().vstDescribe(ref);
      const fx = createVstFx(ref, desc);
      this.picker = null;
      this.edit((p) => insertFx(p, target, fx));
    } catch (e) {
      if (this.picker) this.picker.busy = null;
      toast(`${plugin.name}: ${errorMessage(e)}`, 'error');
      this.render();
    }
  }

  /** Sliders generated from the plug-in's parameter list (0..1 normalized values). */
  private vstParamRows(target: FxTarget, fx: Fx): HTMLElement[] {
    const params = visibleVstParams(fx.paramInfo ?? []);
    if (!params.length) return [h('p', { class: 'muted fx-note' }, 'This plug-in has no adjustable parameters.')];
    const all = this.expanded.has(fx.id) || params.length <= VST_COLLAPSED_PARAMS + 2;
    const rows = (all ? params : params.slice(0, VST_COLLAPSED_PARAMS)).map((info) => this.vstParamRow(target, fx, info));
    if (params.length > VST_COLLAPSED_PARAMS + 2) {
      rows.push(
        h(
          'button',
          {
            class: 'small fx-more',
            onclick: () => {
              if (all) this.expanded.delete(fx.id);
              else this.expanded.add(fx.id);
              this.render();
            },
          },
          all ? 'Show fewer' : `Show all ${params.length} parameters`,
        ),
      );
    }
    return rows;
  }

  private vstParamRow(target: FxTarget, fx: Fx, info: VstParamInfo): HTMLElement {
    const key = String(info.id);
    const current = () => fx.params[key] ?? info.default;
    const fallback = (v: number) => (info.steps === 1 ? (v >= 0.5 ? 'On' : 'Off') : `${Math.round(v * 100)}%`);
    const value = h('span', { class: 'fx-value' }, fallback(current()));
    let seq = 0;
    /** True while the value shows WavePod's 0..100 % stand-in rather than the plug-in's own text. */
    let generic = true;
    const label = (v: number) => {
      const mine = ++seq;
      generic = true;
      api()
        .vstFormat(fx, info.id, v)
        .then((text) => {
          if (mine === seq && text) {
            value.textContent = info.units && !text.includes(info.units) ? `${text} ${info.units}` : text;
            generic = false;
          }
        })
        .catch(() => {});
    };
    const snap = (v: number) => (info.steps > 0 ? Math.round(v * info.steps) / info.steps : v);
    const set = (v: number, commit: boolean) => {
      v = snap(v);
      fx.params = { ...fx.params, [key]: v };
      value.textContent = fallback(v);
      label(v);
      store.editLive((p) => updateFx(p, target, fx.id, { params: { [key]: v } }));
      if (commit) store.commitLive();
    };
    label(current());
    let control: HTMLInputElement;
    if (info.steps !== 1)
      editableValue(value, {
        initial: () => {
          const shown = value.textContent ?? '';
          const n = leadingNumber(shown);
          return n === null ? shown : String(n);
        },
        parse: async (text) => {
          const v = generic ? null : await api().vstParse(fx, info.id, text);
          if (v !== null) return v;
          // the 0..100 % stand-in (plug-ins that format nothing), or a percentage typed on purpose
          if (!generic && !/%\s*$/.test(text)) return null;
          const pct = parseNumberInput(text, { min: 0, max: 100, unit: '%' });
          return pct === null ? null : pct / 100;
        },
        commit: (v) => {
          set(v, true);
          control.value = String(current());
        },
        onClose: () => this.refresh(),
      });
    control =
      info.steps === 1
        ? h('input', { type: 'checkbox', checked: current() >= 0.5, onchange: (e: Event) => set((e.target as HTMLInputElement).checked ? 1 : 0, true) })
        : h('input', {
            type: 'range',
            min: '0',
            max: '1',
            step: info.steps > 0 ? String(1 / info.steps) : '0.001',
            value: String(current()),
            title: 'Double-click to reset',
            oninput: (e: Event) => set(Number((e.target as HTMLInputElement).value), false),
            onchange: () => store.commitLive(),
            ondblclick: (e: Event) => {
              (e.target as HTMLInputElement).value = String(info.default);
              set(info.default, true);
            },
          });
    return h('label', { class: 'fx-param' }, h('span', { class: 'fx-label', title: info.title }, info.title), control, value);
  }

  private paramRow(target: FxTarget, fx: Fx, spec: FxParamSpec, onChange: () => void): HTMLElement {
    const value = h('span', { class: 'fx-value' }, formatValue(spec, fx.params[spec.key]));
    const set = (v: number, commit: boolean) => {
      fx.params = { ...fx.params, [spec.key]: v };
      value.textContent = formatValue(spec, v);
      store.editLive((p) => updateFx(p, target, fx.id, { params: { [spec.key]: v } }));
      onChange();
      if (commit) store.commitLive();
    };
    let control: HTMLInputElement | HTMLSelectElement;
    if (!spec.options)
      editableNumber(value, {
        min: spec.min,
        max: spec.max,
        unit: spec.unit,
        precision: spec.unit === 'Hz' ? 1 : precisionForStep(spec.step),
        get: () => fx.params[spec.key],
        commit: (v) => {
          set(v, true);
          control.value = String(toSlider(spec, v));
        },
        onClose: () => this.refresh(),
      });
    control = spec.options
      ? h(
          'select',
          { onchange: (e: Event) => set(Number((e.target as HTMLSelectElement).value), true) },
          ...spec.options.map((o) => h('option', { value: String(o.value), selected: o.value === fx.params[spec.key] }, o.label)),
        )
      : h('input', {
          type: 'range',
          min: String(spec.log ? 0 : spec.min),
          max: String(spec.log ? 1000 : spec.max),
          step: String(spec.log ? 1 : spec.step),
          value: String(toSlider(spec, fx.params[spec.key])),
          title: 'Double-click to reset',
          oninput: (e: Event) => set(fromSlider(spec, Number((e.target as HTMLInputElement).value)), false),
          onchange: () => store.commitLive(),
          ondblclick: (e: Event) => {
            (e.target as HTMLInputElement).value = String(toSlider(spec, spec.default));
            set(spec.default, true);
          },
        });
    return h('label', { class: 'fx-param' }, h('span', { class: 'fx-label' }, spec.label), control, spec.options ? h('span') : value);
  }
}

const METER_FLOOR = -60;
/** Scale of the gain meter: ±GAIN_RANGE dB. */
const GAIN_RANGE = 24;
const PEAK_DECAY = 0.8;
const toDb = (v: number) => (v > 1e-6 ? Math.max(METER_FLOOR, 20 * Math.log10(v)) : METER_FLOOR);
/** Filters that change gain dynamically show a gain meter; the others show in/out levels only. */
const GAIN_TYPES = new Set(['gate', 'compressor', 'deesser', 'limiter', 'dynamics', 'denoise', 'voiceclean', 'breath', 'smartdeess', 'dehum', 'leveler', 'restore']);

/**
 * Live meters of one filter card: input and output level, and for dynamic filters the gain they
 * apply right now (reduction in orange, boost in green). Dynamics also gets a moving
 * point on its curve.
 */
class LiveMeter {
  readonly el: HTMLElement;
  private inBar = h('div', { class: 'fxm-fill' });
  private outBar = h('div', { class: 'fxm-fill' });
  private gainBar = h('div', { class: 'fxm-gain-fill' });
  private gainText = h('span', { class: 'fxm-num' }, '0.0 dB');
  private inDb = METER_FLOOR;
  private outDb = METER_FLOOR;
  private gain = 0;
  private level: number | null = null;
  private hasGain: boolean;
  /** Dynamics boosts as well as cuts, so its gain meter is centred. */
  private centred: boolean;

  constructor(
    private fx: Fx,
    private curve: HTMLCanvasElement | null,
  ) {
    this.hasGain = GAIN_TYPES.has(fx.type);
    this.centred = fx.type === 'dynamics';
    const row = (label: string, bar: HTMLElement) => h('div', { class: 'fxm-row' }, h('span', { class: 'fxm-label' }, label), h('div', { class: 'fxm-track' }, bar));
    this.el = h(
      'div',
      { class: 'fx-meter', title: 'Live while playing' },
      row('In', this.inBar),
      row('Out', this.outBar),
      this.hasGain
        ? h(
            'div',
            { class: 'fxm-row' },
            h('span', { class: 'fxm-label' }, fx.type === 'dynamics' ? 'Gain' : 'GR'),
            h('div', { class: `fxm-track fxm-gain${this.centred ? ' centred' : ''}` }, this.gainBar),
            this.gainText,
          )
        : null,
    );
    this.paint();
  }

  update(m: FxMeter | undefined): void {
    // peaks fall back smoothly; gain releases towards the new value
    this.inDb = Math.max(m ? toDb(m.in) : METER_FLOOR, this.inDb + 20 * Math.log10(PEAK_DECAY));
    this.outDb = Math.max(m ? toDb(m.out) : METER_FLOOR, this.outDb + 20 * Math.log10(PEAK_DECAY));
    const g = m?.gain ?? 0;
    this.gain = Math.abs(g) >= Math.abs(this.gain) ? g : this.gain * 0.7 + g * 0.3;
    if (Math.abs(this.gain) < 0.05) this.gain = 0;
    this.level = m?.level ?? (m ? this.level : null);
    this.paint();
    if (this.curve) this.drawCurve();
  }

  drawCurve(): void {
    if (!this.curve) return;
    const live = this.level !== null && this.level > METER_FLOOR - 20 ? { in: this.level, gain: this.gain } : null;
    drawDynamicsCurve(this.curve, this.fx.params, live);
  }

  private paint(): void {
    const pct = (db: number) => `${((Math.max(METER_FLOOR, Math.min(0, db)) - METER_FLOOR) / -METER_FLOOR) * 100}%`;
    this.inBar.style.width = pct(this.inDb);
    this.outBar.style.width = pct(this.outDb);
    this.inBar.classList.toggle('hot', this.inDb > -1);
    this.outBar.classList.toggle('hot', this.outDb > -1);
    if (!this.hasGain) return;
    const g = Math.max(-GAIN_RANGE, Math.min(GAIN_RANGE, this.gain));
    const width = (Math.abs(g) / GAIN_RANGE) * (this.centred ? 50 : 100);
    this.gainBar.style.width = `${width}%`;
    // reduction grows leftwards from the right edge (or from the centre); boost grows rightwards
    this.gainBar.style.left = g < 0 ? `${(this.centred ? 50 : 100) - width}%` : this.centred ? '50%' : '0';
    this.gainBar.classList.toggle('boost', g > 0);
    this.gainText.textContent = `${g > 0 ? '+' : ''}${(Math.abs(g) < 0.05 ? 0 : g).toFixed(1)} dB`;
  }
}

/** Input→output curve of Dynamics with target, noise floor and gate marked; `live` adds the current operating point. */
function drawDynamicsCurve(c: HTMLCanvasElement, p: Record<string, number>, live: { in: number; gain: number } | null = null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = 240;
  const hgt = 160;
  c.width = w * dpr;
  c.height = hgt * dpr;
  c.style.width = `${w}px`;
  c.style.height = `${hgt}px`;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const lo = -80;
  const x = (db: number) => ((db - lo) / -lo) * (w - 1);
  const y = (db: number) => hgt - 1 - ((db - lo) / -lo) * (hgt - 1);
  ctx.fillStyle = '#121419';
  ctx.fillRect(0, 0, w, hgt);
  ctx.strokeStyle = '#262a33';
  ctx.lineWidth = 1;
  for (let d = lo; d <= 0; d += 10) {
    ctx.beginPath();
    ctx.moveTo(x(d) + 0.5, 0);
    ctx.lineTo(x(d) + 0.5, hgt);
    ctx.moveTo(0, y(d) + 0.5);
    ctx.lineTo(w, y(d) + 0.5);
    ctx.stroke();
  }
  ctx.strokeStyle = '#3a404d';
  ctx.beginPath();
  ctx.moveTo(x(lo), y(lo));
  ctx.lineTo(x(0), y(0));
  ctx.stroke();
  // markers: noise gate, noise floor (input axis), target (output axis)
  const mark = (db: number, color: string, vertical: boolean) => {
    ctx.strokeStyle = color;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x(db) + 0.5, 0);
      ctx.lineTo(x(db) + 0.5, hgt);
    } else {
      ctx.moveTo(0, y(db) + 0.5);
      ctx.lineTo(w, y(db) + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  mark(p.noiseFloor - p.noiseGate, 'rgba(229,115,115,0.6)', true);
  mark(p.noiseFloor, 'rgba(255,202,40,0.6)', true);
  mark(p.target, 'rgba(129,199,132,0.7)', false);
  ctx.strokeStyle = '#5c8dff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  let first = true;
  for (const [i, o] of dynamicsCurve({ target: p.target, noiseFloor: p.noiseFloor, noiseGate: p.noiseGate }, 217)) {
    if (i < lo) continue;
    const yy = y(Math.max(lo, o));
    if (first) ctx.moveTo(x(i), yy);
    else ctx.lineTo(x(i), yy);
    first = false;
  }
  ctx.stroke();
  ctx.fillStyle = '#8d94a3';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('in → out (dB)', 4, 4);
  ctx.fillStyle = 'rgba(129,199,132,0.9)';
  ctx.fillText(`target ${p.target} LUFS`, w - 92, Math.max(2, y(p.target) - 13));
  if (live) {
    const xi = Math.max(lo, Math.min(0, live.in));
    const yo = Math.max(lo, Math.min(0, live.in + live.gain));
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x(xi) + 0.5, hgt);
    ctx.lineTo(x(xi) + 0.5, y(yo));
    ctx.lineTo(0, y(yo) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x(xi), y(yo), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A small picture of a learned voice match curve (0 dB in the middle). */
function matchCurveSvg(gains: number[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 200;
  const H = 40;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'fx-match-curve');
  const x = (i: number) => (i / (MATCH_BANDS.length - 1)) * W;
  const y = (g: number) => H / 2 - (Math.max(-MATCH_MAX_DB, Math.min(MATCH_MAX_DB, g)) / MATCH_MAX_DB) * (H / 2 - 2);
  const zero = document.createElementNS(NS, 'line');
  zero.setAttribute('x1', '0');
  zero.setAttribute('x2', String(W));
  zero.setAttribute('y1', String(H / 2));
  zero.setAttribute('y2', String(H / 2));
  zero.setAttribute('class', 'zero');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', gains.map((g, i) => `${x(i).toFixed(1)},${y(g).toFixed(1)}`).join(' '));
  svg.append(zero, line);
  const title = document.createElementNS(NS, 'title');
  title.textContent = MATCH_BANDS.map((f, i) => `${f < 1000 ? Math.round(f) + ' Hz' : (f / 1000).toFixed(1) + ' kHz'}: ${gains[i] > 0 ? '+' : ''}${gains[i].toFixed(1)} dB`).join('\n');
  svg.append(title);
  return svg;
}
