// Filter stack editor for a track or the master bus: add, bypass, tweak, reorder and remove filters.
import type { Fx, FxMeter, FxType, VstParamInfo, VstPluginInfo } from '../shared/types';
import { FX_DEFINITIONS, fxDefinition, type FxParamSpec } from '../core/fx/definitions';
import { MASTER, addFx, addVoiceChain, fxList, insertFx, moveFx, removeFx, updateFx, type FxTarget } from '../core/fx/stack';
import { createVstFx, visibleVstParams } from '../core/fx/vst';
import { dynamicsCurve } from '../core/fx/ultraschallDynamics';
import { clear, errorMessage, h, toast } from './dom';
import { api, store } from './store';
import { updateTrack } from '../core/project';
import { DUCK_DEFAULT_DEPTH } from '../core/ducking';
import { editableNumber, editableValue, isEditingValue } from './valueEdit';
import { leadingNumber, parseNumberInput, precisionForStep } from '../core/numberInput';

const VST_OPTION = '__vst3';
/** Plug-ins with many parameters show this many sliders until "Show all" is clicked. */
const VST_COLLAPSED_PARAMS = 12;

function formatValue(spec: FxParamSpec, v: number): string {
  if (spec.options) return spec.options.find((o) => o.value === v)?.label ?? String(v);
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
  return v >= 1000 ? Math.round(v / 10) * 10 : Math.round(v);
};

export class FxPanel {
  readonly el = h('aside', { class: 'fx-panel' });
  target: FxTarget | null = null;
  private dragId: string | null = null;
  private structure = '';
  private vstAvailable: boolean | null = null;
  private picker: { plugins: VstPluginInfo[] | null; query: string; busy: string | null } | null = null;
  private expanded = new Set<string>();
  private meters = new Map<string, LiveMeter>();

  open(target: FxTarget): void {
    this.target = target;
    this.structure = '';
    this.picker = null;
    if (this.vstAvailable === null) {
      this.vstAvailable = false;
      api()
        .vstStatus()
        .then((s) => {
          this.vstAvailable = s.available;
          if (s.available && this.target) this.render();
        })
        .catch(() => {});
    }
    this.render();
    document.getElementById('app')!.append(this.el);
  }

  close(): void {
    this.target = null;
    this.el.remove();
    store.notify('project');
  }

  toggle(target: FxTarget): void {
    if (this.target === target) this.close();
    else this.open(target);
  }

  /** Re-renders when the stack changed from outside (undo, other edits), but not during slider drags. */
  refresh(): void {
    if (!this.target || store.liveEditing || isEditingValue(this.el)) return;
    if (this.target !== MASTER && !store.project.tracks.some((t) => t.id === this.target)) return this.close();
    const key = JSON.stringify(fxList(store.project, this.target)) + this.title();
    if (key !== this.structure) this.render();
  }

  private title(): string {
    if (this.target === MASTER) return 'Master';
    return store.project.tracks.find((t) => t.id === this.target)?.name ?? '';
  }

  private edit(fn: Parameters<typeof store.edit>[0]): void {
    store.edit(fn);
    this.render();
  }

  private render(): void {
    const target = this.target;
    if (!target) return;
    const list = fxList(store.project, target);
    this.structure = JSON.stringify(list) + this.title();
    clear(this.el);
    this.meters.clear();
    const add = h(
      'select',
      {
        class: 'fx-add',
        onchange: (e: Event) => {
          const type = (e.target as HTMLSelectElement).value;
          if (type === VST_OPTION) return this.openPicker();
          if (type) this.edit((p) => addFx(p, target, type as FxType).project);
        },
      },
      h('option', { value: '' }, '+ Add filter…'),
      ...FX_DEFINITIONS.map((d) => h('option', { value: d.type, title: d.description }, d.name)),
      this.vstAvailable ? h('option', { value: VST_OPTION, title: 'Add an installed VST3 effect' }, 'VST3 plug-in…') : null,
    );
    this.el.append(
      h(
        'div',
        { class: 'fx-head' },
        h('div', null, h('div', { class: 'fx-kicker' }, 'Filters'), h('h2', null, this.title())),
        h('button', { class: 'fx-close', title: 'Close', onclick: () => this.close() }, '×'),
      ),
      h('div', { class: 'fx-toolbar' }, add, list.length === 0 && target !== MASTER ? h('button', { class: 'small', title: 'High-pass, De-esser and Dynamics', onclick: () => this.addVoiceChain() }, 'Voice chain') : null),
    );
    if (target !== MASTER) this.el.append(this.renderDuck(target));
    if (this.picker) this.el.append(this.renderPicker(target));
    const cards = h('div', { class: 'fx-list' });
    if (!list.length) {
      cards.append(h('p', { class: 'muted fx-empty' }, target === MASTER ? 'No filters on the master bus. A limiter here keeps the mix below a ceiling.' : 'No filters yet. Filters run top to bottom, before the track gain and pan.'));
    }
    list.forEach((fx, i) => cards.append(this.card(target, fx, i, list.length)));
    this.el.append(cards);
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

  private addVoiceChain(): void {
    const target = this.target!;
    this.edit((p) => addVoiceChain(p, target));
  }

  private card(target: FxTarget, fx: Fx, index: number, count: number): HTMLElement {
    const vst = fx.type === 'vst3';
    const def = vst ? null : fxDefinition(fx.type);
    const name = vst ? (fx.plugin?.name ?? 'VST3 plug-in') : def!.name;
    const description = vst ? `VST3 · ${fx.plugin?.vendor ?? ''}`.trim() : def!.description;
    const curve = fx.type === 'dynamics' ? h('canvas', { class: 'fx-curve', width: 240, height: 160 }) : null;
    const meter = fx.enabled ? new LiveMeter(fx, curve) : null;
    if (meter) this.meters.set(fx.id, meter);
    const drawCurve = () => (meter ? meter.drawCurve() : curve && drawDynamicsCurve(curve, fx.params));
    const card = h(
      'section',
      { class: `fx-card${fx.enabled ? '' : ' bypassed'}`, draggable: 'true' },
      h(
        'div',
        { class: 'fx-card-head' },
        h('span', { class: 'fx-grip', title: 'Drag to reorder' }, '⋮⋮'),
        h('input', {
          type: 'checkbox',
          checked: fx.enabled,
          title: fx.enabled ? 'On (uncheck to bypass)' : 'Bypassed',
          onchange: (e: Event) => this.edit((p) => updateFx(p, target, fx.id, { enabled: (e.target as HTMLInputElement).checked })),
        }),
        h('span', { class: 'fx-name', title: description }, name, vst ? h('span', { class: 'fx-tag' }, 'VST3') : null),
        h('button', { class: 'toggle', title: 'Move up', disabled: index === 0, onclick: () => this.edit((p) => moveFx(p, target, fx.id, index - 1)) }, '↑'),
        h('button', { class: 'toggle', title: 'Move down', disabled: index === count - 1, onclick: () => this.edit((p) => moveFx(p, target, fx.id, index + 1)) }, '↓'),
        h('button', { class: 'toggle remove', title: 'Remove filter', onclick: () => this.edit((p) => removeFx(p, target, fx.id)) }, '×'),
      ),
      meter?.el ?? null,
      curve,
      ...(vst ? this.vstParamRows(target, fx) : def!.params.map((spec) => this.paramRow(target, fx, spec, drawCurve))),
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

  /** Feeds live filter activity from a transport update into the cards' meters. */
  updateMeters(meters: Record<string, FxMeter> | undefined): void {
    if (!this.target) return;
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
const GAIN_TYPES = new Set(['gate', 'compressor', 'deesser', 'limiter', 'dynamics', 'denoise']);

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
