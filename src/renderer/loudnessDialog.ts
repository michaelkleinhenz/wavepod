// Loudness analysis (Ultraschall-style summary) and clip normalisation.
import type { Clip, LoudnessReport, LoudnessStats } from '../shared/types';
import { normalizationGain, normalizedClipGain, type LoudnessTarget } from '../core/loudness';
import { findClip, updateClip } from '../core/project';
import { formatTimestamp } from '../shared/time';
import { clear, errorMessage, h, toast } from './dom';
import { api, store } from './store';

export const LOUDNESS_PRESETS = [
  { label: 'Podcast stereo (−16 LUFS)', value: -16 },
  { label: 'Podcast mono / Apple (−19 LUFS)', value: -19 },
  { label: 'EBU R128 broadcast (−23 LUFS)', value: -23 },
];
const CEILINGS = [-0.1, -1, -2, -3];

const TARGET_KEY = 'soundpod.loudnessTarget';

/** The target clips are normalised to (remembered per machine). Ultraschall's default is −16 LUFS / −1 dBTP. */
export function loudnessTarget(): LoudnessTarget {
  try {
    const v = JSON.parse(localStorage.getItem(TARGET_KEY) ?? 'null') as LoudnessTarget | null;
    if (v && Number.isFinite(v.lufs) && Number.isFinite(v.ceiling)) return v;
  } catch {
    // storage unavailable or garbled; use the default
  }
  return { lufs: -16, ceiling: -1 };
}

function saveTarget(t: LoudnessTarget): void {
  try {
    localStorage.setItem(TARGET_KEY, JSON.stringify(t));
  } catch {
    // not remembered, still used for this session
  }
}

const fmtLufs = (v: number, unit = 'LUFS') => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : '—');
const fmtGain = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)} dB`;

/** ok: within 1 LU of the target, warn: within 2 LU, bad: further off. */
function integratedState(s: LoudnessStats, t: LoudnessTarget): 'ok' | 'warn' | 'bad' | '' {
  if (!Number.isFinite(s.integrated)) return '';
  const off = Math.abs(s.integrated - t.lufs);
  return off <= 1 ? 'ok' : off <= 2 ? 'warn' : 'bad';
}

function peakState(s: LoudnessStats, t: LoudnessTarget): 'ok' | 'bad' | '' {
  if (!Number.isFinite(s.truePeak)) return '';
  return s.truePeak <= t.ceiling ? 'ok' : 'bad';
}

/** Gain that would bring this audio to the target (limited by the true-peak ceiling). */
function gainToTarget(s: LoudnessStats, t: LoudnessTarget): number | null {
  return Number.isFinite(s.integrated) ? normalizationGain(s.integrated, s.truePeak, t.lufs, t.ceiling) : null;
}

/** Table of reports, one row per source. Shared with the export dialog. */
export function loudnessTable(reports: LoudnessReport[], target: LoudnessTarget, selected: string | null = null, onSelect?: (id: string) => void): HTMLElement {
  return h(
    'table',
    { class: 'loudness' },
    h(
      'thead',
      null,
      h(
        'tr',
        null,
        h('th', null, 'Source'),
        h('th', { title: 'Integrated loudness of the whole source' }, 'Integrated'),
        h('th', { title: 'Loudness range (LRA)' }, 'Range'),
        h('th', { title: 'Highest short-term loudness (3 s)' }, 'Short-term max'),
        h('th', { title: 'Highest momentary loudness (400 ms)' }, 'Momentary max'),
        h('th', { title: 'True peak (4× oversampled)' }, 'True peak'),
        h('th', { title: `Gain to reach ${target.lufs} LUFS without the true peak going over ${target.ceiling} dBTP` }, 'To target'),
      ),
    ),
    h(
      'tbody',
      null,
      ...reports.map((r) => {
        const s = r.stats;
        const g = gainToTarget(s, target);
        return h(
          'tr',
          { class: `${onSelect ? 'pick' : ''}${r.id === selected ? ' selected' : ''}`, onclick: onSelect ? () => onSelect(r.id) : undefined },
          h('td', null, r.name),
          h('td', { class: `lu ${integratedState(s, target)}` }, fmtLufs(s.integrated)),
          h('td', null, s.duration >= 3 ? `${s.range.toFixed(1)} LU` : '—'),
          h('td', null, fmtLufs(s.shortTermMax)),
          h('td', null, fmtLufs(s.momentaryMax)),
          h('td', { class: `lu ${peakState(s, target)}` }, fmtLufs(s.truePeak, 'dBTP')),
          h('td', null, g === null ? '—' : fmtGain(g)),
        );
      }),
    ),
  );
}

/**
 * Normalises clips to the loudness target by setting their clip gain (one undo step).
 * Each clip is measured on its own, with its fades, before the track's filters and gain.
 */
export async function normalizeClips(clipIds: string[], target = loudnessTarget(), reports?: LoudnessReport[]): Promise<void> {
  if (!clipIds.length) return toast('Select one or more clips first');
  // the gains the measurement is based on
  const measured = new Map<string, Clip>();
  for (const id of clipIds) {
    const f = findClip(store.project, id);
    if (f) measured.set(id, f.clip);
  }
  try {
    if (!reports) {
      toast(`Measuring ${measured.size} clip${measured.size === 1 ? '' : 's'}…`);
      reports = await api().measureClips([...measured.keys()]);
    }
  } catch (e) {
    return toast(`Loudness analysis failed: ${errorMessage(e)}`, 'error');
  }
  const gains = new Map<string, number>();
  let silent = 0;
  let limited = 0;
  for (const r of reports) {
    const clip = measured.get(r.id);
    if (!clip) continue;
    const gain = normalizedClipGain(clip, r.stats, target);
    if (gain === null) silent++;
    else {
      gains.set(r.id, gain);
      if (r.stats.integrated + gain - clip.gain < target.lufs - 0.15) limited++;
    }
  }
  if (gains.size) {
    store.edit((p) => {
      let q = p;
      for (const [id, gain] of gains) if (findClip(q, id)) q = updateClip(q, id, { gain });
      return q;
    });
  }
  const notes = [
    limited ? `${limited} held back by the ${target.ceiling} dBTP ceiling` : '',
    silent ? `${silent} silent clip${silent === 1 ? '' : 's'} left as is` : '',
  ].filter(Boolean);
  toast(`Normalised ${gains.size} clip${gains.size === 1 ? '' : 's'} to ${target.lufs} LUFS${notes.length ? `; ${notes.join(', ')}` : ''}`);
}

/**
 * Loudness analysis dialog: the Ultraschall categories (integrated, range, short-term and
 * momentary maximum, true peak) for the selected clips or for the mix and every track,
 * a short-term loudness curve, and how far each source is from the target.
 */
export class LoudnessDialog {
  private overlay = h('div', { class: 'overlay' });
  private reports: LoudnessReport[] | null = null;
  private clipIds: string[] = [];
  private selected: string | null = null;
  private busy = false;
  private error: string | null = null;
  private target = loudnessTarget();
  private run = 0;

  constructor() {
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay) this.close();
    });
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  /** Analyses the selected clips, or the mix and its tracks when no clip is selected. */
  open(clipIds: string[] = [...store.selection.clipIds]): void {
    this.clipIds = clipIds.filter((id) => findClip(store.project, id));
    this.target = loudnessTarget();
    document.body.append(this.overlay);
    void this.analyse();
  }

  close(): void {
    this.run++;
    this.overlay.remove();
  }

  private async analyse(): Promise<void> {
    const run = ++this.run;
    this.busy = true;
    this.error = null;
    this.reports = null;
    this.render();
    try {
      const reports = this.clipIds.length ? await api().measureClips(this.clipIds) : await api().measureLoudness();
      if (run !== this.run) return;
      this.reports = reports;
      if (!reports.some((r) => r.id === this.selected)) this.selected = reports[0]?.id ?? null;
    } catch (e) {
      if (run !== this.run) return;
      this.error = errorMessage(e);
    }
    this.busy = false;
    this.render();
  }

  private setTarget(patch: Partial<LoudnessTarget>): void {
    this.target = { ...this.target, ...patch };
    saveTarget(this.target);
    this.render();
  }

  private render(): void {
    clear(this.overlay);
    const t = this.target;
    const clips = this.clipIds.length > 0;
    const report = this.reports?.find((r) => r.id === this.selected) ?? null;
    const subtitle = clips
      ? `${this.clipIds.length} selected clip${this.clipIds.length === 1 ? '' : 's'} · with fades and clip gain, before track filters`
      : 'Mix and every track · as exported, before normalisation';

    const targetRow = h(
      'div',
      { class: 'row loudness-target' },
      h('label', { class: 'field' }, h('span', null, 'Target'),
        h('select', { onchange: (e: Event) => this.setTarget({ lufs: Number((e.target as HTMLSelectElement).value) }) },
          ...LOUDNESS_PRESETS.map((p) => h('option', { value: String(p.value), selected: p.value === t.lufs }, p.label)))),
      h('label', { class: 'field' }, h('span', null, 'True-peak ceiling'),
        h('select', { onchange: (e: Event) => this.setTarget({ ceiling: Number((e.target as HTMLSelectElement).value) }) },
          ...CEILINGS.map((c) => h('option', { value: String(c), selected: c === t.ceiling }, `${c} dBTP`)))),
    );

    let body: HTMLElement;
    if (this.busy) body = h('div', { class: 'loudness-empty muted' }, 'Analysing…');
    else if (this.error) body = h('div', { class: 'loudness-empty error' }, this.error);
    else if (!this.reports?.length) body = h('div', { class: 'loudness-empty muted' }, 'Nothing to analyse: the episode has no clips yet.');
    else {
      body = h(
        'div',
        null,
        report ? this.summary(report) : null,
        report ? this.curve(report.stats) : null,
        this.reports.length > 1 ? loudnessTable(this.reports, t, this.selected, (id) => { this.selected = id; this.render(); }) : null,
      );
    }

    const normalizable = clips && !!this.reports?.some((r) => Number.isFinite(r.stats.integrated));
    const dialog = h(
      'div',
      { class: 'dialog loudness-dialog' },
      h('h2', null, 'Loudness analysis'),
      h('p', { class: 'muted' }, subtitle),
      targetRow,
      body,
      h('div', { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => void this.analyse() }, 'Analyse again'),
        clips
          ? h('button', {
              class: 'primary',
              disabled: this.busy || !normalizable,
              title: `Set the clip gain so each clip reads ${t.lufs} LUFS, with true peaks at or below ${t.ceiling} dBTP`,
              onclick: () => void this.normalize(),
            }, `Normalise to ${t.lufs} LUFS`)
          : null,
        h('button', { onclick: () => this.close() }, 'Close'),
      ),
    );
    this.overlay.append(dialog);
  }

  private async normalize(): Promise<void> {
    if (!this.reports) return;
    await normalizeClips(this.clipIds, this.target, this.reports);
    await this.analyse();
  }

  /** The figures of one source as tiles, the way Ultraschall's loudness summary lists them. */
  private summary(r: LoudnessReport): HTMLElement {
    const s = r.stats;
    const t = this.target;
    const g = gainToTarget(s, t);
    const tile = (label: string, value: string, hint: string, state = '', note: string | null = null) =>
      h('div', { class: `lu-tile ${state}`, title: hint }, h('div', { class: 'lu-label' }, label), h('div', { class: 'lu-value' }, value), note ? h('div', { class: 'lu-note' }, note) : null);
    // the true-peak ceiling keeps the gain from reaching the target
    const limited = g !== null && s.integrated + g < t.lufs - 0.05;
    return h(
      'div',
      null,
      h('h3', null, r.name, h('span', { class: 'muted' }, `  ${formatTimestamp(s.duration, false)}`)),
      h(
        'div',
        { class: 'lu-tiles' },
        tile('Integrated', fmtLufs(s.integrated), `Programme loudness; target ${t.lufs} LUFS (green within 1 LU)`, integratedState(s, t)),
        tile('Loudness range', s.duration >= 3 ? `${s.range.toFixed(1)} LU` : '—', 'LRA: how much the loudness varies (10th to 95th percentile of short-term loudness)'),
        tile('Short-term max', fmtLufs(s.shortTermMax), 'Loudest 3-second stretch'),
        tile('Momentary max', fmtLufs(s.momentaryMax), 'Loudest 400-millisecond stretch'),
        tile('True peak', fmtLufs(s.truePeak, 'dBTP'), `Highest peak between samples; ceiling ${t.ceiling} dBTP`, peakState(s, t)),
        tile('Sample peak', fmtLufs(s.samplePeak, 'dBFS'), 'Highest sample value'),
        tile('To target', g === null ? '—' : fmtGain(g), `Gain to reach ${t.lufs} LUFS without the true peak going over ${t.ceiling} dBTP`, '', limited ? `held back by the true-peak ceiling (reaches ${(s.integrated + g).toFixed(1)} LUFS)` : null),
      ),
    );
  }

  /** Short-term loudness over time with the target band. */
  private curve(s: LoudnessStats): HTMLElement | null {
    if (s.history.length < 2) return null;
    const w = 700;
    const hgt = 140;
    const c = h('canvas', { class: 'lu-curve', width: w, height: hgt });
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = hgt * dpr;
    c.style.width = '100%';
    c.style.height = `${hgt}px`;
    const ctx = c.getContext('2d');
    if (!ctx) return c;
    ctx.scale(dpr, dpr);
    const top = 0;
    const bottom = -50;
    const y = (lufs: number) => ((top - Math.max(bottom, Math.min(top, lufs))) / (top - bottom)) * hgt;
    const t = this.target.lufs;
    ctx.fillStyle = '#121419';
    ctx.fillRect(0, 0, w, hgt);
    // grid every 10 LU
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    for (let l = -10; l > bottom; l -= 10) {
      ctx.fillStyle = '#22262f';
      ctx.fillRect(0, Math.round(y(l)), w, 1);
      ctx.fillStyle = '#5b6170';
      ctx.fillText(`${l}`, 3, y(l) + 2);
    }
    // target ±1 LU
    ctx.fillStyle = 'rgba(67,160,71,0.18)';
    ctx.fillRect(0, y(t + 1), w, y(t - 1) - y(t + 1));
    ctx.fillStyle = 'rgba(129,199,132,0.9)';
    ctx.fillRect(0, Math.round(y(t)), w, 1);
    ctx.fillText(`target ${t} LUFS`, w - 90, y(t) + 3);
    if (Number.isFinite(s.integrated)) {
      ctx.fillStyle = 'rgba(92,141,255,0.8)';
      ctx.fillRect(0, Math.round(y(s.integrated)), w, 1);
      ctx.fillText(`integrated ${s.integrated.toFixed(1)}`, 30, y(s.integrated) + 3);
    }
    // the short-term curve; silent stretches break the line
    ctx.strokeStyle = '#ffca28';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    const n = s.history.length;
    s.history.forEach((v, i) => {
      if (!Number.isFinite(v) || v < bottom) {
        pen = false;
        return;
      }
      const x = (i / (n - 1)) * w;
      if (pen) ctx.lineTo(x, y(v));
      else ctx.moveTo(x, y(v));
      pen = true;
    });
    ctx.stroke();
    return h('div', { class: 'lu-curve-wrap' }, h('div', { class: 'muted lu-curve-label' }, 'Short-term loudness'), c);
  }
}
