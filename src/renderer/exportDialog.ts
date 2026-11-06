// Export dialog: formats, loudness target, stems, chapter files, range, progress.
// While the mix renders, the progress bar is its waveform and the loudness so far runs beside it.
import type { ExportOptions, ExportProgress, ExportResult, LiveLoudness, LoudnessReport } from '../shared/types';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { LOUDNESS_PRESETS, loudnessTiles } from './loudnessDialog';
import { api, store } from './store';
import { regionOutputBase } from '../core/regions';
import { chapterWarningList } from './chaptersView';
import { audibleTracks, updateTrack } from '../core/project';
import { STEM_CHOICES, STEM_GROUPS, trackStem } from '../core/stems';
import type { StemGroup } from '../shared/types';

const PRESETS = LOUDNESS_PRESETS;

const checkbox = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) =>
  h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, disabled, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label);
const WAVE_HEIGHT = 72;

const fmtLive = (v: number, unit = 'LUFS') => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : '—');

/** Waveform progress bar: columns arrive in stretches while the mix renders. */
class WaveProgress {
  readonly el = h('canvas', { class: 'export-wave' }) as HTMLCanvasElement;
  private peaks = new Float32Array(0);
  private fraction = 0;
  private pending = false;

  reset(): void {
    this.peaks = new Float32Array(0);
    this.fraction = 0;
    this.schedule();
  }

  update(p: ExportProgress): void {
    const w = p.wave;
    if (w) {
      if (this.peaks.length !== w.columns * 2) this.peaks = new Float32Array(w.columns * 2);
      this.peaks.set(w.peaks.slice(0, this.peaks.length - w.start * 2), w.start * 2);
      this.fraction = p.fraction;
    } else {
      // stems and chapter files: keep the finished mix waveform, or show a plain bar
      this.fraction = this.peaks.length ? 1 : p.fraction;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  draw(): void {
    const c = this.el;
    const dpr = window.devicePixelRatio || 1;
    const width = c.clientWidth || 700;
    c.width = Math.round(width * dpr);
    c.height = Math.round(WAVE_HEIGHT * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue('--accent').trim() || '#5c8dff';
    const mid = WAVE_HEIGHT / 2;
    ctx.clearRect(0, 0, width, WAVE_HEIGHT);
    // centre line across the whole range
    ctx.fillStyle = '#2e333e';
    ctx.fillRect(0, mid, width, 1);
    const cols = this.peaks.length / 2;
    const done = Math.min(width, Math.round(this.fraction * width));
    if (cols > 0) {
      ctx.fillStyle = accent;
      for (let x = 0; x < done; x++) {
        // the columns that fall on this pixel
        const a = Math.floor((x / width) * cols);
        const b = Math.max(a + 1, Math.floor(((x + 1) / width) * cols));
        let lo = 0;
        let hi = 0;
        for (let k = a; k < b && k < cols; k++) {
          if (this.peaks[k * 2] < lo) lo = this.peaks[k * 2];
          if (this.peaks[k * 2 + 1] > hi) hi = this.peaks[k * 2 + 1];
        }
        const top = mid - Math.min(1, hi) * (mid - 1);
        const bottom = mid - Math.max(-1, lo) * (mid - 1);
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    } else if (done > 0) {
      // no waveform for this phase (stems, chapter files): a plain bar
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.35;
      ctx.fillRect(0, 0, done, WAVE_HEIGHT);
      ctx.globalAlpha = 1;
    }
    if (this.fraction > 0 && this.fraction < 1) {
      ctx.fillStyle = '#e3e6ec';
      ctx.fillRect(done, 0, 1, WAVE_HEIGHT);
    }
  }
}

/** "−18.9 LUFS → −16.0 LUFS, peaks limited by up to 3.2 dB": what normalisation did to the mix. */
export function exportSummary(res: ExportResult): string {
  if (!Number.isFinite(res.loudness)) return 'silent';
  const out = res.outputLoudness !== undefined && Number.isFinite(res.outputLoudness) ? res.outputLoudness : res.loudness + res.appliedGainDb;
  const limited = (res.limiterReductionDb ?? 0) < -0.05 ? `, peaks limited by up to ${(-res.limiterReductionDb!).toFixed(1)} dB` : '';
  return `${res.loudness.toFixed(1)} LUFS → ${out.toFixed(1)} LUFS${limited}`;
}

export class ExportDialog {
  private overlay = h('div', { class: 'overlay' });
  private opts: Omit<ExportOptions, 'outputBase'> = {
    formats: ['mp3', 'wav'],
    mp3Bitrate: 128,
    normalize: true,
    targetLufs: -16,
    peakCeiling: -1,
    stems: false,
    chapterFiles: true,
  };
  private useRange = false;
  /** Export each region as its own file instead of the whole episode. */
  private perRegion = false;
  private regionLabel = '';
  private busy = false;
  private wave = new WaveProgress();
  private progressLabel = h('span', { class: 'muted' });
  /** Running loudness tiles, updated in place while exporting. */
  private liveValues = {
    momentary: h('div', { class: 'lu-value' }, '—'),
    shortTerm: h('div', { class: 'lu-value' }, '—'),
    integrated: h('div', { class: 'lu-value' }, '—'),
    truePeak: h('div', { class: 'lu-value' }, '—'),
  };
  private liveTiles: Record<keyof LiveLoudness, HTMLElement>;
  private liveEl: HTMLElement;
  /** An export ran (or runs) since the dialog opened: show the waveform and live figures. */
  private exported = false;
  private phase = '';
  private mix: LoudnessReport | null = null;

  constructor() {
    const tile = (key: keyof LiveLoudness, label: string, hint: string) =>
      h('div', { class: 'lu-tile', title: hint }, h('div', { class: 'lu-label' }, label), this.liveValues[key]);
    this.liveTiles = {
      momentary: tile('momentary', 'Momentary', 'Loudness of the last 400 ms'),
      shortTerm: tile('shortTerm', 'Short-term', 'Loudness of the last 3 s'),
      integrated: tile('integrated', 'Integrated so far', 'Programme loudness from the start up to here'),
      truePeak: tile('truePeak', 'True peak so far', 'Highest peak between samples up to here'),
    };
    this.liveEl = h('div', { class: 'lu-tiles export-live' }, ...Object.values(this.liveTiles));
    api().onExportProgress((p) => this.progress(p));
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
  }

  open(): void {
    this.mix = null;
    this.exported = false;
    this.render();
    document.body.append(this.overlay);
  }

  close(): void {
    this.overlay.remove();
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  private build(): void {
    clear(this.overlay);
    const o = this.opts;
    const range = store.selection.range;
    const regions = store.project.regions ?? [];
    const check = checkbox;
    const fmt = (f: 'mp3' | 'wav' | 'flac' | 'opus', label: string) =>
      check(label, o.formats.includes(f), (v) => {
        o.formats = v ? [...new Set([...o.formats, f])] : o.formats.filter((x) => x !== f);
        this.render();
      });

    const target = { lufs: o.targetLufs, ceiling: o.peakCeiling };

    const dialog = h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Export episode'),
      h('div', { class: 'grid' },
        h('div', null, h('h3', null, 'Formats'), fmt('mp3', 'MP3 with ID3 chapters'), fmt('wav', 'WAV 24-bit'), fmt('flac', 'FLAC 24-bit (lossless, with chapters)'), fmt('opus', 'Opus (small files, with chapters)'),
          h('label', { class: 'field' }, h('span', null, 'MP3 bitrate'),
            h('select', { disabled: !o.formats.includes('mp3'), onchange: (e: Event) => (o.mp3Bitrate = Number((e.target as HTMLSelectElement).value)) },
              ...[64, 96, 128, 160, 192, 256].map((b) => h('option', { value: String(b), selected: b === o.mp3Bitrate }, `${b} kbps`)))),
          o.formats.includes('opus')
            ? h('label', { class: 'field' }, h('span', null, 'Opus bitrate'),
                h('select', { onchange: (e: Event) => (o.opusBitrate = Number((e.target as HTMLSelectElement).value)) },
                  ...[32, 48, 64, 96, 128].map((b) => h('option', { value: String(b), selected: b === (o.opusBitrate ?? 64) }, `${b} kbps${b === 64 ? ' (like MP3 at 128)' : ''}`))))
            : null,
          check('Chapter files (PSC, JSON, mp4chaps, Audacity)', o.chapterFiles, (v) => { o.chapterFiles = v; this.render(); }),
          check('Stems (separate files for editing or delivery)', o.stems, (v) => { o.stems = v; this.render(); }),
          check(range ? `Only the selected range` : 'Only the selected range (none selected)', this.useRange && !!range && !this.perRegion, (v) => { this.useRange = v; this.render(); }, !range || this.perRegion),
          check(regions.length ? `Each region as its own file (${regions.length})` : 'Each region as its own file (no regions)', this.perRegion && regions.length > 0, (v) => { this.perRegion = v; this.render(); }, !regions.length),
        ),
        h('div', null, h('h3', null, 'Loudness'),
          check('Normalise loudness', o.normalize, (v) => { o.normalize = v; this.render(); }),
          h('label', { class: 'field' }, h('span', null, 'Target'),
            h('select', { disabled: !o.normalize, onchange: (e: Event) => (o.targetLufs = Number((e.target as HTMLSelectElement).value)) },
              ...PRESETS.map((p) => h('option', { value: String(p.value), selected: p.value === o.targetLufs }, p.label)))),
          h('label', { class: 'field' }, h('span', null, 'Peak ceiling'),
            h('select', { disabled: !o.normalize, onchange: (e: Event) => (o.peakCeiling = Number((e.target as HTMLSelectElement).value)) },
              ...[-0.1, -1, -2, -3].map((p) => h('option', { value: String(p), selected: p === o.peakCeiling }, `${p} dBTP`)))),
          h('button', { class: 'small', disabled: this.busy, onclick: () => void this.analyse() }, this.mix ? 'Analyse again' : 'Analyse loudness'),
        ),
      ),
      this.stemSection(),
      this.chapterNotes(range),
      // only the mix matters for the export; per-track figures are in the Loudness dialog
      this.mix ? h('div', { class: 'export-loudness' }, h('h3', null, 'Loudness of the mix'), loudnessTiles(this.mix.stats, target, o.normalize)) : null,
      this.exported ? h('div', { class: 'export-progress' }, this.wave.el, this.liveEl) : null,
      h('div', { class: 'row' }, this.progressLabel),
      h('div', { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        h('button', { class: 'primary', disabled: this.busy || (o.formats.length === 0 && !o.stems), onclick: () => void this.run() }, this.busy ? 'Exporting…' : 'Export…'),
      ),
    );
    this.overlay.append(dialog);
    if (this.exported) this.wave.draw();
  }

  /** Stem options; for dialogue / music / effects, the stem each track goes to (saved with the episode). */
  private stemSection(): HTMLElement | null {
    const o = this.opts;
    if (!o.stems) return null;
    const dme = o.stemMode === 'dme';
    const select = <T extends string>(value: T, options: ReadonlyArray<{ id: T; label: string }>, onChange: (v: T) => void) =>
      h('select', { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
        ...options.map((x) => h('option', { value: x.id, selected: x.id === value }, x.label)));
    const head = h('div', { class: 'stem-options' },
      h('label', { class: 'field' }, h('span', null, 'Split'),
        select(o.stemMode ?? 'tracks', [{ id: 'tracks', label: 'One file per track' }, { id: 'dme', label: 'Dialogue, music and effects' }], (v) => { o.stemMode = v; this.render(); })),
      h('label', { class: 'field' }, h('span', null, 'Stem format'),
        select(o.stemFormat ?? 'wav', [{ id: 'wav', label: 'WAV 24-bit' }, { id: 'flac', label: 'FLAC 24-bit' }], (v) => (o.stemFormat = v))),
    );
    if (!dme) return h('div', { class: 'export-stems' }, h('h3', null, 'Stems'), head, h('p', { class: 'muted' }, 'Every track with clips on its own, at the same gain as the mix.'));
    const tracks = audibleTracks(store.project).filter((t) => t.clips.length > 0);
    const counts = new Map<StemGroup, number>();
    for (const t of tracks) counts.set(trackStem(t), (counts.get(trackStem(t)) ?? 0) + 1);
    const empty = STEM_GROUPS.filter((g) => !counts.get(g.id)).map((g) => g.label.toLowerCase());
    const masterFx = (store.project.masterFx ?? []).some((f) => f.enabled);
    return h('div', { class: 'export-stems' },
      h('h3', null, 'Stems'),
      head,
      h('p', { class: 'muted' },
        'One file each for dialogue, music and effects, at the same gain as the mix and with ducking and automix as you hear them, so together they add up to the mix. Muted tracks stay out. Your choices are saved with the episode.'),
      h('div', { class: 'stem-tracks' },
        ...tracks.map((t) =>
          h('div', { class: 'stem-track' },
            h('span', { class: 'stem-swatch', style: `background:${t.color}` }),
            h('span', { class: 'stem-name', title: t.name }, t.name),
            t.stem ? null : h('span', { class: 'muted stem-guess', title: 'Guessed from the track name and settings; pick one to keep it' }, 'guessed'),
            select(trackStem(t), STEM_CHOICES, (v) => {
              store.edit((p) => updateTrack(p, t.id, { stem: v }));
              this.render();
            }),
          ),
        ),
      ),
      checkbox('Also a music & effects mix (M&E, for versions in other languages)', !!o.stemMe, (v) => (o.stemMe = v)),
      empty.length ? h('p', { class: 'muted' }, `No tracks for ${empty.join(' and ')}: ${empty.length > 1 ? 'those files stay' : 'that file stays'} silent.`) : null,
      masterFx ? h('p', { class: 'muted' }, 'The master filters are not applied to stems, so they add up to the mix before the master filters.') : null,
    );
  }

  /** Chapter problems and a missing cover, checked before the MP3 is written (Ultraschall warns about these too). */
  private chapterNotes(range: [number, number] | null): HTMLElement | null {
    if (!this.opts.formats.includes('mp3') && !this.opts.chapterFiles) return null;
    const r = this.useRange && range && !this.perRegion ? range : null;
    // per region, each file gets its own chapter list, so each is checked on its own
    const list = this.perRegion
      ? (() => {
          const parts = (store.project.regions ?? []).flatMap((g) => {
            const l = chapterWarningList(g.start, g.end, () => this.render());
            return l ? [h('div', null, h('strong', null, g.title || 'Region'), l)] : [];
          });
          return parts.length ? h('div', null, ...parts) : null;
        })()
      : chapterWarningList(r ? r[0] : 0, r ? r[1] : Infinity, () => this.render());
    const noCover = this.opts.formats.includes('mp3') && !store.project.metadata.artwork;
    if (!list && !noCover) return null;
    return h(
      'div',
      { class: 'export-notes' },
      h('h3', null, 'Before you export'),
      list,
      noCover ? h('p', { class: 'muted' }, 'No episode cover set. Add one under Chapters › Episode to embed it in the MP3.') : null,
    );
  }

  private progress(p: ExportProgress): void {
    if (p.phase !== this.phase) {
      this.phase = p.phase;
      // each pass over the mix draws its waveform from the start
      if (p.wave) this.wave.reset();
    }
    this.wave.update(p);
    this.progressLabel.textContent = p.phase === 'Done' ? '' : `${this.regionLabel}${p.phase} ${Math.round(p.fraction * 100)}%`;
    const live = p.live;
    if (!live) return;
    const o = this.opts;
    for (const key of Object.keys(this.liveValues) as Array<keyof LiveLoudness>) {
      this.liveValues[key].textContent = fmtLive(live[key], key === 'truePeak' ? 'dBTP' : 'LUFS');
    }
    // colour against the target only for the normalised render, where it applies
    const judged = o.normalize && p.phase === 'Rendering mix';
    const off = Math.abs(live.integrated - o.targetLufs);
    this.liveTiles.integrated.className = `lu-tile ${judged && Number.isFinite(live.integrated) ? (off <= 1 ? 'ok' : off <= 2 ? 'warn' : 'bad') : ''}`;
    this.liveTiles.truePeak.className = `lu-tile ${judged && Number.isFinite(live.truePeak) ? (live.truePeak <= o.peakCeiling ? 'ok' : 'bad') : ''}`;
  }

  private async analyse(): Promise<void> {
    this.busy = true;
    this.progressLabel.textContent = 'Analysing…';
    this.render();
    try {
      this.mix = (await api().measureLoudness(true)).find((r) => r.kind === 'mix') ?? null;
      this.progressLabel.textContent = '';
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  private async run(): Promise<void> {
    const name = (store.project.metadata.title || store.project.name).replace(/[\\/:*?"<>|]+/g, '_');
    const base = await api().chooseExportBase(name);
    if (!base) return;
    const range = this.useRange ? store.selection.range : null;
    const regions = this.perRegion ? (store.project.regions ?? []) : [];
    this.busy = true;
    this.exported = true;
    this.phase = '';
    for (const v of Object.values(this.liveValues)) v.textContent = '—';
    for (const t of Object.values(this.liveTiles)) t.className = 'lu-tile';
    this.wave.reset();
    this.render();
    try {
      if (regions.length) {
        // one export per region, each normalised on its own
        const files: string[] = [];
        for (const [i, r] of regions.entries()) {
          this.regionLabel = `Region ${i + 1}/${regions.length} “${r.title}”: `;
          this.wave.reset();
          const res = await api().exportProject({ ...this.opts, outputBase: regionOutputBase(base, i, r.title), start: r.start, end: r.end });
          files.push(...res.files);
        }
        this.regionLabel = '';
        this.progressLabel.textContent = `Done: ${regions.length} regions, ${files.length} files`;
        toast('Export finished');
        if (files[0]) void api().revealFile(files[0]);
      } else {
        const res = await api().exportProject({ ...this.opts, outputBase: base, ...(range ? { start: range[0], end: range[1] } : {}) });
        this.progressLabel.textContent = `Done: ${res.files.length} files · ${exportSummary(res)}`;
        toast('Export finished');
        if (res.files[0]) void api().revealFile(res.files[0]);
      }
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
