// Export dialog, laid out like the export dialogs of other audio apps, in two columns: what to
// export (whole episode, selection, one region, every region) and the file name and folder on
// the left (stems and the checks below them), format and loudness on the right, with the
// loudness of the mix once analysed. The progress and the buttons span both columns.
// While the mix renders, the progress bar is its waveform and the loudness so far runs beside it.
import type { ExportProgress, ExportResult, ExportSettings, LiveLoudness, LoudnessReport } from '../shared/types';
import { clear, errorMessage, h, keepScroll, toast } from './dom';
import { loudnessTiles, targetPicker } from './loudnessDialog';
import { api, store } from './store';
import { seek } from './actions';
import { DEFAULT_EXPORT_SETTINGS, DEFAULT_VIDEO_EXPORT, MP3_BITRATES, VIDEO_RATES, VIDEO_SIZES, OPUS_BITRATES, PEAK_CEILINGS, normalizeExportSettings, targetForMono } from '../core/exportSettings';
import { exportChecks, imageSize, type ImageSize } from '../core/exportChecks';
import { formatTimestamp } from '../shared/time';
import { baseName, cleanFileName, defaultExportName, exportJobs, joinExportPath, plannedFiles, rangeAvailable, rangeSpan, type ExportJob, type ExportRange } from '../core/exportPlan';
import { chapterWarningList } from './chaptersView';
import { audibleTracks, updateTrack } from '../core/project';
import { STEM_CHOICES, STEM_GROUPS, trackStem } from '../core/stems';
import { folderOf } from '../core/folders';
import type { Frames, Region, StemGroup, Track, VideoExportSettings } from '../shared/types';
import { clipsEnd } from '../core/project';
import { videoSettings } from '../core/video';
import { VideoCancelled, renderVideo, videoFrameSize } from './video/videoExport';

const LAST_KEY = 'wavepod.exportSettings';
const REVEAL_KEY = 'wavepod.exportReveal';

/** How the last export on this computer was set up, for episodes that were never exported. */
function lastSettings(): ExportSettings | undefined {
  try {
    return normalizeExportSettings(JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null'));
  } catch {
    return undefined;
  }
}

function rememberSettings(s: ExportSettings): void {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(s));
  } catch {
    // not remembered on this computer; the episode still keeps them
  }
}

/** The episode's own settings, else the last ones used on this computer, else one MP3 at −16 LUFS. */
export function initialExportSettings(): ExportSettings {
  return structuredClone(store.project.exportSettings ?? lastSettings() ?? DEFAULT_EXPORT_SETTINGS);
}

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
  /** The step of the mix export running, for the big label over the waveform. */
  private step: ExportProgress['step'] | null = null;
  /** Progress of the step between the passes (fitting the limiter), which has no waveform. */
  private stepFraction = 0;

  reset(): void {
    this.peaks = new Float32Array(0);
    this.fraction = 0;
    this.step = null;
    this.stepFraction = 0;
    this.schedule();
  }

  update(p: ExportProgress): void {
    this.step = p.phase === 'Done' ? null : (p.step ?? null);
    if (p.step === 'preparing') this.stepFraction = p.fraction;
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
    // the analysing pass and the step after it are drawn faded, under their label
    ctx.globalAlpha = this.step === 'analysing' ? 0.45 : this.step === 'preparing' ? 0.2 : 1;
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
    ctx.globalAlpha = 1;
    if (this.fraction > 0 && this.fraction < 1) {
      ctx.fillStyle = '#e3e6ec';
      ctx.fillRect(done, 0, 1, WAVE_HEIGHT);
    }
    if (this.step === 'analysing') {
      // pass 1 only measures: say so in big letters, so it isn't taken for the export itself
      this.label(ctx, 'Analyzing', 'bold 30px system-ui, sans-serif', width / 2, 32);
      this.label(ctx, 'Pass 1 of 2: measuring the loudness, nothing is written yet', '11px system-ui, sans-serif', width / 2, 56);
    } else if (this.step === 'preparing') {
      // between the passes: fitting the limiter takes a while and has no waveform, so a bar
      this.label(ctx, 'Preparing the export', 'bold 20px system-ui, sans-serif', width / 2, 24);
      const barW = Math.min(360, width * 0.6);
      const x0 = (width - barW) / 2;
      ctx.fillStyle = '#2e333e';
      ctx.beginPath();
      ctx.roundRect(x0, 40, barW, 8, 4);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.roundRect(x0, 40, Math.max(8, barW * Math.min(1, this.stepFraction)), 8, 4);
      ctx.fill();
      this.label(ctx, 'Fitting the limiter to the loudness target', '11px system-ui, sans-serif', width / 2, 62);
    }
  }

  /** Centred text over the waveform, with a shadow so it reads on top of it. */
  private label(ctx: CanvasRenderingContext2D, text: string, font: string, x: number, y: number): void {
    ctx.save();
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = '#e3e6ec';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

/** "−18.9 LUFS → −16.0 LUFS, peaks limited by up to 3.2 dB": what normalisation did to the mix. */
export function exportSummary(res: ExportResult): string {
  if (!Number.isFinite(res.loudness)) return 'silent';
  const out = res.outputLoudness !== undefined && Number.isFinite(res.outputLoudness) ? res.outputLoudness : res.loudness + res.appliedGainDb;
  const limited = (res.limiterReductionDb ?? 0) < -0.05 ? `, peaks limited by up to ${(-res.limiterReductionDb!).toFixed(1)} dB` : '';
  return `${res.loudness.toFixed(1)} LUFS → ${out.toFixed(1)} LUFS${limited}`;
}

/** "00:12:04 – 00:30:00 (17:56)": where a part of the episode lies. */
function spanText(span: [Frames, Frames], sr: number): string {
  const len = Math.max(0, span[1] - span[0]) / sr;
  const dur = len >= 3600 ? formatTimestamp(len, false) : formatTimestamp(len, false).slice(3);
  return `${formatTimestamp(span[0] / sr, false)} – ${formatTimestamp(span[1] / sr, false)} (${dur})`;
}

function readReveal(): boolean {
  try {
    return localStorage.getItem(REVEAL_KEY) !== 'no';
  } catch {
    return true;
  }
}

function writeReveal(v: boolean): void {
  try {
    localStorage.setItem(REVEAL_KEY, v ? 'yes' : 'no');
  } catch {
    // not remembered; the box still works for this export
  }
}

/** A labelled row of the form: the label on the left, the controls on the right. */
const formRow = (label: string, ...controls: Array<Node | string | null | false>) =>
  h('div', { class: 'form-row' }, h('div', { class: 'form-label' }, label), h('div', { class: 'form-controls' }, ...controls));

const section = (title: string, ...rows: Array<Node | null | false>) => h('section', { class: 'export-section' }, h('h3', null, title), ...rows);

export class ExportDialog {
  private overlay = h('div', { class: 'overlay' });
  private opts: ExportSettings = { ...DEFAULT_EXPORT_SETTINGS };
  /** The episode folder the options were loaded for; another episode loads its own. */
  private openedFor: string | null = null;
  /** Size of the episode cover (null: unreadable), for the checks; read once per file. */
  private cover: { path: string; size?: ImageSize | null } | null = null;
  /** What to export: the whole episode, the selection, one region or every region. */
  private range: ExportRange = { kind: 'all' };
  /** The region last picked in the list, kept while another range is chosen. */
  private lastRegion = '';
  /** File name without extension; follows the episode (and region) title until typed in. */
  private fileName = '';
  private nameTyped = false;
  private folder = '';
  private reveal = readReveal();
  /** Files the export would replace, waiting for "Replace" or "Cancel". */
  private replacing: { files: string[]; jobs: ExportJob[] } | null = null;
  /** Files of the last finished export, for "Show in Folder". */
  private written: string[] = [];
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
  /** The video of the export is being rendered (it can be cancelled), and its last picture. */
  private videoRunning = false;
  private videoCancel = false;
  private videoPreview = h('canvas', { class: 'video-export-preview export-video-preview' }) as HTMLCanvasElement;

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
    this.overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.busy) {
        e.stopPropagation();
        if (this.replacing) {
          this.replacing = null;
          this.render();
        } else this.close();
      }
    });
  }

  /** Opens the dialog; with a region id, set to export just that region. */
  open(regionId?: string, withVideo = false): void {
    if (this.openedFor !== store.dir) {
      this.opts = initialExportSettings();
      this.openedFor = store.dir;
      this.folder = '';
      this.nameTyped = false;
      this.range = { kind: 'all' };
    }
    if (regionId && store.project.regions?.some((r) => r.id === regionId)) {
      this.range = { kind: 'region', regionId };
      this.lastRegion = regionId;
      this.nameTyped = false;
    } else if (!rangeAvailable(this.range, store.project, store.selection.range)) {
      this.range = { kind: 'all' };
    }
    if (withVideo && store.project.cameras?.length && !this.opts.video) this.opts.video = this.defaultVideo();
    this.mix = null;
    this.exported = false;
    this.replacing = null;
    this.written = [];
    this.progressLabel.textContent = '';
    this.loadCover();
    if (!this.folder) {
      void api()
        .exportFolder()
        .then((dir) => {
          if (this.folder) return;
          this.folder = dir;
          if (this.overlay.isConnected && !this.busy) this.render();
        })
        .catch(() => undefined);
    }
    this.render();
    document.body.append(this.overlay);
  }

  close(): void {
    this.overlay.remove();
  }

  private loadCover(): void {
    const art = store.project.metadata.artwork;
    if (!art) return void (this.cover = null);
    if (this.cover?.path === art) return;
    const cover: { path: string; size?: ImageSize | null } = { path: art };
    this.cover = cover;
    api()
      .readFile(art)
      .then((bytes) => (cover.size = imageSize(bytes)))
      .catch(() => (cover.size = null))
      .finally(() => {
        if (this.cover === cover && this.overlay.isConnected && !this.busy) this.render();
      });
  }

  private render(): void {
    keepScroll(this.overlay, () => this.build());
  }

  /** The file name in the field: typed, or the default for the chosen range. */
  private name(): string {
    return this.nameTyped ? this.fileName : defaultExportName(store.project, this.range);
  }

  private setRange(range: ExportRange): void {
    this.range = range;
    if (range.kind === 'region') this.lastRegion = range.regionId;
    this.replacing = null;
    this.render();
  }

  private jobs(): ExportJob[] {
    const name = cleanFileName(this.name());
    if (!name || !this.folder) return [];
    return exportJobs(this.range, store.project, store.selection.range, joinExportPath(this.folder, name));
  }

  private build(): void {
    clear(this.overlay);
    const o = this.opts;
    const jobs = this.jobs();
    const files = jobs.flatMap((j) => plannedFiles(store.project, o, j));
    const nothing = o.formats.length === 0 && !o.stems && !this.videoOn();
    const canExport = !this.busy && !nothing && jobs.length > 0 && files.length > 0;

    const dialog = h(
      'div',
      { class: 'dialog export-dialog', role: 'dialog', 'aria-label': 'Export episode' },
      h('h2', null, 'Export episode'),
      // two columns, so the settings fit on screen without scrolling: what and where on the left,
      // how on the right
      h('div', { class: 'export-columns' },
        h('div', { class: 'export-column' },
          this.rangeSection(),
          this.fileSection(files),
          this.stemSection(),
          this.checks(),
        ),
        h('div', { class: 'export-column' },
          this.formatSection(),
          this.loudnessSection(),
          // only the mix matters for the export; per-track figures are in the Loudness dialog
          this.mix ? h('div', { class: 'export-loudness' }, h('h3', null, 'Loudness of the mix'), loudnessTiles(this.mix.stats, { lufs: o.targetLufs, ceiling: o.peakCeiling }, o.normalize)) : null,
        ),
      ),
      this.exported ? h('div', { class: 'export-progress' }, this.wave.el, this.videoRunning ? this.videoPreview : this.liveEl) : null,
      // pinned to the bottom of the dialog, so the buttons, the progress and the replace question stay in view
      h('div', { class: 'export-bottom' },
        this.replacing ? this.replaceNotice(this.replacing.files) : null,
        h('div', { class: 'row export-status' }, this.progressLabel),
        h('div', { class: 'export-footer' },
          h('label', { class: 'check', title: 'Open the folder with the new files in your file manager when the export is done' },
            h('input', { type: 'checkbox', checked: this.reveal, onchange: (e: Event) => { this.reveal = (e.target as HTMLInputElement).checked; writeReveal(this.reveal); } }),
            'Show files when done'),
          h('div', { class: 'spacer' }),
          this.written.length && !this.busy ? h('button', { onclick: () => void api().revealFile(this.written[0]) }, 'Show in Folder') : null,
          this.videoRunning
            ? h('button', { disabled: this.videoCancel, title: 'Stop the video; the files written so far stay', onclick: () => { this.videoCancel = true; this.render(); } }, 'Cancel Video')
            : h('button', { disabled: this.busy, onclick: () => this.close() }, this.written.length ? 'Close' : 'Cancel'),
          h('button', {
            class: 'primary',
            disabled: !canExport || !!this.replacing,
            title: nothing ? 'Tick a format or stems first' : !jobs.length ? 'Give the file a name and pick a folder' : '',
            onclick: () => void this.start(),
          }, this.busy ? 'Exporting…' : 'Export'),
        ),
      ),
    );
    this.overlay.append(dialog);
    if (this.exported) this.wave.draw();
  }

  /** Whole episode, the selection, one region (picked from a list) or every region as its own file. */
  private rangeSection(): HTMLElement {
    const p = store.project;
    const sr = store.sampleRate;
    const sel = store.selection.range;
    const regions = p.regions ?? [];
    const kind = this.range.kind;
    const chosenRegion = this.range.kind === 'region' ? this.range.regionId : regions.find((r) => r.id === this.lastRegion)?.id ?? regions[0]?.id;
    const radio = (k: ExportRange['kind'], label: string, detail: string, enabled: boolean, pick: () => ExportRange, extra?: HTMLElement | null) =>
      h('label', { class: `radio export-range${enabled ? '' : ' disabled'}` },
        h('input', { type: 'radio', name: 'export-range', checked: kind === k, disabled: !enabled || this.busy, onchange: () => this.setRange(pick()) }),
        h('span', null, label),
        extra ?? null,
        h('span', { class: 'muted export-range-detail' }, detail),
      );
    const regionSelect = regions.length
      ? (h('select', {
          class: 'export-region-select',
          disabled: this.busy,
          onchange: (e: Event) => this.setRange({ kind: 'region', regionId: (e.target as HTMLSelectElement).value }),
        }, ...regions.map((r: Region, i) => h('option', { value: r.id, selected: r.id === chosenRegion }, `${String(i + 1).padStart(2, '0')} ${r.title || 'Region'}`))) as HTMLSelectElement)
      : null;
    const regionSpan = regions.find((r) => r.id === chosenRegion);
    return section('Range',
      formRow('Export',
        radio('all', 'Whole episode', spanText(rangeSpan({ kind: 'all' }, p, null), sr), true, () => ({ kind: 'all' })),
        radio('selection', 'Selected range', sel && sel[1] > sel[0] ? spanText(sel, sr) : 'nothing selected', !!sel && sel[1] > sel[0], () => ({ kind: 'selection' })),
        radio('region', 'Region', regionSpan ? spanText([regionSpan.start, regionSpan.end], sr) : 'no regions yet', regions.length > 0, () => ({ kind: 'region', regionId: chosenRegion! }), regionSelect),
        radio('regions', 'Each region as its own file', regions.length ? `${regions.length} ${regions.length === 1 ? 'region' : 'regions'}, each normalised on its own` : 'no regions yet', regions.length > 0, () => ({ kind: 'regions' })),
      ),
    );
  }

  /** File name, folder (with Browse…) and the files that will be written. */
  private fileSection(files: string[]): HTMLElement {
    const nameInput = h('input', {
      class: 'export-name',
      value: this.name(),
      spellcheck: false,
      disabled: this.busy,
      placeholder: 'File name',
      oninput: (e: Event) => {
        this.fileName = (e.target as HTMLInputElement).value;
        this.nameTyped = true;
        this.replacing = null;
        this.refreshFiles();
      },
      onchange: () => this.render(),
    }) as HTMLInputElement;
    const folderInput = h('input', {
      class: 'export-folder',
      value: this.folder,
      title: this.folder,
      spellcheck: false,
      disabled: this.busy,
      placeholder: 'Folder',
      onchange: (e: Event) => {
        this.folder = (e.target as HTMLInputElement).value.trim();
        this.replacing = null;
        this.render();
      },
    });
    const many = this.range.kind === 'regions';
    return section('File',
      formRow('File name', h('div', { class: 'export-name-row' }, nameInput,
        h('button', {
          class: 'small',
          title: 'Use the episode (and region) title again',
          disabled: this.busy || !this.nameTyped,
          onclick: () => { this.nameTyped = false; this.render(); },
        }, 'Reset')),
        many ? h('div', { class: 'field-help' }, 'Each region adds its number and title: “Name - 01 Intro”.') : null),
      formRow('Folder', h('div', { class: 'export-name-row' }, folderInput,
        h('button', { class: 'small', disabled: this.busy, onclick: () => void this.browse() }, 'Browse…'))),
      formRow('Writes', this.fileList(files)),
    );
  }

  private fileListEl: HTMLElement | null = null;

  private fileList(files: string[]): HTMLElement {
    const shown = 8;
    const el = h('div', { class: 'export-files' },
      files.length
        ? h('ul', null, ...files.slice(0, shown).map((f) => h('li', { title: f }, baseName(f))), files.length > shown ? h('li', { class: 'muted' }, `and ${files.length - shown} more`) : null)
        : h('span', { class: 'muted' }, this.opts.formats.length || this.opts.stems || this.videoOn() ? 'Give the file a name and pick a folder.' : 'Nothing: tick a format below.'),
    );
    this.fileListEl = el;
    return el;
  }

  /** Updates the file list while typing a name, without rebuilding the field being typed in. */
  private refreshFiles(): void {
    const old = this.fileListEl;
    if (!old) return;
    const files = this.jobs().flatMap((j) => plannedFiles(store.project, this.opts, j));
    old.replaceWith(this.fileList(files));
  }

  private async browse(): Promise<void> {
    const dir = await api().chooseExportFolder(this.folder || undefined);
    if (!dir) return;
    this.folder = dir;
    this.replacing = null;
    this.render();
  }

  /** Formats with their quality next to them, channels, and the extra files. */
  private formatSection(): HTMLElement {
    const o = this.opts;
    const fmt = (f: 'mp3' | 'wav' | 'flac' | 'opus', label: string, hint: string, extra?: HTMLElement | null) =>
      h('div', { class: 'export-format' },
        h('label', { class: 'check', title: hint },
          h('input', {
            type: 'checkbox',
            checked: o.formats.includes(f),
            disabled: this.busy,
            onchange: (e: Event) => {
              const v = (e.target as HTMLInputElement).checked;
              o.formats = v ? [...new Set([...o.formats, f])] : o.formats.filter((x) => x !== f);
              this.render();
            },
          }),
          label),
        o.formats.includes(f) ? extra ?? null : null,
      );
    const mp3Bitrate = h('select', { title: 'MP3 bitrate', onchange: (e: Event) => (o.mp3Bitrate = Number((e.target as HTMLSelectElement).value)) },
      ...MP3_BITRATES.map((b) => h('option', { value: String(b), selected: b === o.mp3Bitrate }, `${b} kbps${o.mono && b === 64 ? ' (like 128 in stereo)' : ''}`)));
    const opusBitrate = h('select', { title: 'Opus bitrate', onchange: (e: Event) => (o.opusBitrate = Number((e.target as HTMLSelectElement).value)) },
      ...OPUS_BITRATES.map((b) => h('option', { value: String(b), selected: b === (o.opusBitrate ?? 64) }, `${b} kbps${b === 64 && !o.mono ? ' (like MP3 at 128)' : ''}`)));
    const channels = h('select', {
      disabled: this.busy,
      title: 'Mono: one channel instead of two, half the size at the same quality. Right for shows that are only voices. Stems stay stereo.',
      onchange: (e: Event) => {
        const mono = (e.target as HTMLSelectElement).value === 'mono';
        if (mono) o.mono = true;
        else delete o.mono;
        // mono is measured as mono, which reads 3 LU lower: −19 is the mono podcast target
        o.targetLufs = targetForMono(o.targetLufs, mono);
        this.mix = null;
        this.render();
      },
    },
    h('option', { value: 'stereo', selected: !o.mono }, 'Stereo'),
    h('option', { value: 'mono', selected: !!o.mono }, 'Mono (half the size, for speech)'));
    return section('Format',
      formRow('Formats',
        fmt('mp3', 'MP3', 'The usual podcast format, with ID3 chapters, tags and cover', mp3Bitrate),
        fmt('flac', 'FLAC 24-bit', 'Lossless, about half the size of WAV, with chapters, tags and cover'),
        fmt('opus', 'Opus', 'Very small files at good quality, with chapters, tags and cover', opusBitrate),
        fmt('wav', 'WAV 24-bit', 'Uncompressed, for archiving or further processing'),
      ),
      formRow('Channels', channels),
      store.project.cameras?.length ? this.videoRow() : null,
      formRow('Also write',
        checkbox('Chapter files (PSC, JSON, mp4chaps, Audacity labels)', o.chapterFiles, (v) => { o.chapterFiles = v; this.render(); }, this.busy),
        checkbox('Stems (separate files for editing or delivery)', o.stems, (v) => { o.stems = v; this.render(); }, this.busy),
      ),
    );
  }

  /** Video export is on (and there are cameras to export). */
  private videoOn(): boolean {
    return !!this.opts.video && !!store.project.cameras?.length;
  }

  /** Full HD (or the cameras' own size when smaller) at the cameras' frame rate. */
  private defaultVideo(): VideoExportSettings {
    const v = videoSettings(store.project);
    const short = Math.min(v.width, v.height);
    const size = [...VIDEO_SIZES].reverse().find((s) => s <= Math.max(720, Math.min(1080, short))) ?? 1080;
    const fps = VIDEO_RATES.reduce((a, b) => (Math.abs(b - v.fps) < Math.abs(a - v.fps) ? b : a), 30 as number);
    return { ...DEFAULT_VIDEO_EXPORT, size, fps };
  }

  /** MP4 video of the cameras, next to the audio files: one file for a video hoster, the others for the podcast hoster. */
  private videoRow(): HTMLElement {
    const o = this.opts;
    const v = o.video;
    const set = (patch: Partial<VideoExportSettings>) => {
      o.video = { ...(o.video ?? this.defaultVideo()), ...patch };
      this.render();
    };
    const select = <T extends string | number>(title: string, value: T, options: ReadonlyArray<[T, string]>, onChange: (v: T) => void) =>
      h('select', { title, disabled: this.busy, onchange: (e: Event) => { const raw = (e.target as HTMLSelectElement).value; onChange((typeof value === 'number' ? Number(raw) : raw) as T); } },
        ...options.map(([val, label]) => h('option', { value: String(val), selected: val === value }, label)));
    const sizeLabel = (s: number) => {
      const f = videoFrameSize(store.project, s);
      return `${s === 2160 ? '4K' : `${s}p`} (${f.width}×${f.height})`;
    };
    const cams = store.project.cameras!.length;
    return formRow('Video',
      h('div', { class: 'export-format' },
        h('label', { class: 'check', title: 'An MP4 of the cameras, switched as in the director lane, with this mix as its sound: for YouTube or another video hoster, next to the audio files for your podcast hoster' },
          h('input', { type: 'checkbox', checked: !!v, disabled: this.busy, onchange: (e: Event) => { o.video = (e.target as HTMLInputElement).checked ? this.defaultVideo() : undefined; if (!o.video) delete o.video; this.render(); } }),
          `MP4 video (${cams} camera${cams === 1 ? '' : 's'})`),
      ),
      v ? h('div', { class: 'export-video-options' },
        select('Size of the video, in the shape of the first camera', v.size, VIDEO_SIZES.map((s) => [s, sizeLabel(s)] as [number, string]), (size) => set({ size })),
        select('Frame rate', v.fps, [...new Set([...VIDEO_RATES, v.fps])].sort((a, b) => a - b).map((r) => [r, `${r} fps`] as [number, string]), (fps) => set({ fps })),
        select('Picture quality', v.quality, [['medium', 'Smaller file'], ['high', 'High (YouTube)'], ['very-high', 'Very high (for further editing)']], (quality) => set({ quality })),
        select('Video format', v.codec, [['avc', 'H.264 (plays everywhere)'], ['av1', 'AV1 (smaller, slower)']], (codec) => set({ codec })),
      ) : null,
      v ? h('div', { class: 'field-help' }, 'Same sound as the audio files. Rendering the picture takes a while; the audio files are written first.') : null,
    );
  }

  private loudnessSection(): HTMLElement {
    const o = this.opts;
    return section('Loudness',
      formRow('Normalise', checkbox('Bring the mix to a loudness target', o.normalize, (v) => { o.normalize = v; this.render(); }, this.busy)),
      formRow('Target', targetPicker(o.targetLufs, (lufs) => { o.targetLufs = lufs; this.render(); }, !o.normalize || this.busy)),
      formRow('Peak ceiling',
        h('div', { class: 'export-name-row' },
          h('select', { disabled: !o.normalize || this.busy, onchange: (e: Event) => { o.peakCeiling = Number((e.target as HTMLSelectElement).value); this.render(); } },
            ...PEAK_CEILINGS.map((p) => h('option', { value: String(p), selected: p === o.peakCeiling }, `${p} dBTP`))),
          h('button', { class: 'small', disabled: this.busy, title: 'Measure the whole mix now, and check it for its level and for silence', onclick: () => void this.analyse() }, this.mix ? 'Analyse Again' : 'Analyse Loudness'))),
      o.mono ? formRow('', h('p', { class: 'muted export-hint' }, 'A mono file is measured as mono, so it reads 3 LU lower than the same audio in stereo: −19 LUFS in mono sounds like −16 LUFS in stereo.')) : null,
    );
  }

  /** Stem options; for dialogue / music / effects, the stem each track goes to (saved with the episode). */
  private stemSection(): HTMLElement | null {
    const o = this.opts;
    if (!o.stems) return null;
    const dme = o.stemMode === 'dme';
    const select = <T extends string>(value: T, options: ReadonlyArray<{ id: T; label: string }>, onChange: (v: T) => void) =>
      h('select', { disabled: this.busy, onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
        ...options.map((x) => h('option', { value: x.id, selected: x.id === value }, x.label)));
    const head = [
      formRow('Split', select(o.stemMode ?? 'tracks', [{ id: 'tracks', label: 'One file per track' }, { id: 'dme', label: 'Dialogue, music and effects' }], (v) => { o.stemMode = v; this.render(); })),
      formRow('Stem format', select(o.stemFormat ?? 'wav', [{ id: 'wav', label: 'WAV 24-bit' }, { id: 'flac', label: 'FLAC 24-bit' }], (v) => { o.stemFormat = v; this.render(); })),
    ];
    if (!dme) return section('Stems', ...head, formRow('', h('p', { class: 'muted' }, 'Every track with clips on its own, at the same gain as the mix.')));
    const tracks = audibleTracks(store.project).filter((t) => t.clips.length > 0);
    const counts = new Map<StemGroup, number>();
    const stemOf = (t: Track) => trackStem(t, folderOf(store.project, t)?.name);
    for (const t of tracks) counts.set(stemOf(t), (counts.get(stemOf(t)) ?? 0) + 1);
    const empty = STEM_GROUPS.filter((g) => !counts.get(g.id)).map((g) => g.label.toLowerCase());
    const masterFx = (store.project.masterFx ?? []).some((f) => f.enabled);
    return section('Stems',
      ...head,
      formRow('Tracks',
        h('p', { class: 'muted' },
          'One file each for dialogue, music and effects, at the same gain as the mix and with ducking and automix as you hear them, so together they add up to the mix. Muted tracks stay out. Your choices are saved with the episode.'),
        h('div', { class: 'stem-tracks' },
          ...tracks.map((t) =>
            h('div', { class: 'stem-track' },
              h('span', { class: 'stem-swatch', style: `background:${t.color}` }),
              h('span', { class: 'stem-name', title: t.name }, t.name),
              t.stem ? null : h('span', { class: 'muted stem-guess', title: 'Guessed from the track and folder names and settings; pick one to keep it' }, 'guessed'),
              select(stemOf(t), STEM_CHOICES, (v) => {
                store.edit((p) => updateTrack(p, t.id, { stem: v }));
                this.render();
              }),
            ),
          ),
        ),
        checkbox('Also a music & effects mix (M&E, for versions in other languages)', !!o.stemMe, (v) => { o.stemMe = v; this.render(); }, this.busy),
        empty.length ? h('p', { class: 'muted' }, `No tracks for ${empty.join(' and ')}: ${empty.length > 1 ? 'those files stay' : 'that file stays'} silent.`) : null,
        masterFx ? h('p', { class: 'muted' }, 'The master filters are not applied to stems, so they add up to the mix before the master filters.') : null,
      ),
    );
  }

  /**
   * What is worth fixing first: chapter problems (Ultraschall warns about these too), the episode
   * details and cover, and once the mix was analysed, its loudness and stretches of dead air.
   */
  private checks(): HTMLElement | null {
    const chapters = this.opts.formats.includes('mp3') || this.opts.chapterFiles ? this.chapterNotes() : null;
    const cover = this.cover?.path === store.project.metadata.artwork ? this.cover?.size : undefined;
    const found = exportChecks(store.project.metadata, this.opts, cover, this.mix?.stats);
    const sr = store.sampleRate;
    const items = found.map((c) =>
      h('li', { class: 'warning' }, c.message,
        ...(c.at ?? []).slice(0, 8).map((t) =>
          h('button', {
            class: 'small link',
            title: 'Close and put the playhead there',
            onclick: () => {
              this.close();
              seek(t * sr);
            },
          }, formatTimestamp(t, false)),
        ),
      ),
    );
    if (!chapters && !items.length) {
      return this.mix ? null : h('div', { class: 'export-notes' }, h('p', { class: 'muted' }, 'Analyse loudness to also check the mix for its level and for silence.'));
    }
    return h(
      'div',
      { class: 'export-notes' },
      h('h3', null, 'Before you export'),
      chapters,
      items.length ? h('ul', { class: 'chapter-warnings' }, ...items) : null,
      this.mix ? null : h('p', { class: 'muted' }, 'Analyse loudness to also check the mix for its level and for silence.'),
    );
  }

  /** Chapter problems of each file: per region, each file gets its own chapter list, so each is checked on its own. */
  private chapterNotes(): HTMLElement | null {
    const jobs = exportJobs(this.range, store.project, store.selection.range, '');
    if (jobs.length > 1) {
      const parts = jobs.flatMap((j) => {
        const l = chapterWarningList(j.start ?? 0, j.end ?? Infinity, () => this.render());
        return l ? [h('div', null, h('strong', null, j.region || 'Region'), l)] : [];
      });
      return parts.length ? h('div', null, ...parts) : null;
    }
    const j = jobs[0];
    return chapterWarningList(j?.start ?? 0, j?.end ?? Infinity, () => this.render());
  }

  /** "These files already exist": Replace goes ahead, Cancel goes back to the settings. */
  private replaceNotice(files: string[]): HTMLElement {
    const one = files.length === 1;
    return h('div', { class: 'export-replace', role: 'alert', title: files.map(baseName).join('\n') },
      h('strong', null, one ? `“${baseName(files[0])}” already exists.` : `${files.length} of these files already exist in the folder.`),
      h('span', null, ` Replace ${one ? 'it' : 'them'}?`),
      h('div', { class: 'row end' },
        h('button', { onclick: () => { this.replacing = null; this.render(); } }, 'Cancel'),
        h('button', { class: 'primary danger', onclick: () => { const r = this.replacing; this.replacing = null; if (r) void this.run(r.jobs); } }, 'Replace'),
      ),
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
      this.mix = (await api().measureLoudness(true, !!this.opts.mono)).find((r) => r.kind === 'mix') ?? null;
      this.progressLabel.textContent = '';
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  /** Export clicked: asks first if files of the same name are there. */
  private async start(): Promise<void> {
    const jobs = this.jobs();
    if (!jobs.length) return;
    const files = jobs.flatMap((j) => plannedFiles(store.project, this.opts, j));
    let existing: string[] = [];
    try {
      existing = await api().existingFiles(files);
    } catch {
      // can't tell: go ahead, as a save dialog that couldn't check would
    }
    if (existing.length) {
      this.replacing = { files: existing, jobs };
      this.render();
      return;
    }
    await this.run(jobs);
  }

  /** The MP4 of one export job; null when it was cancelled. */
  private async exportVideo(job: ExportJob, video: VideoExportSettings, mixWav: string | undefined): Promise<string | null> {
    const p = store.project;
    this.videoRunning = true;
    this.wave.reset();
    this.render();
    const pctx = this.videoPreview.getContext('2d')!;
    try {
      const res = await renderVideo({
        project: p,
        settings: this.opts,
        video,
        start: job.start ?? 0,
        end: job.end ?? clipsEnd(p),
        path: `${job.outputBase}.mp4`,
        mixWav,
        cancelled: () => this.videoCancel,
        onProgress: (fraction, text, picture) => {
          this.wave.update({ phase: text, fraction } as ExportProgress);
          this.progressLabel.textContent = `${this.regionLabel}${text}`;
          if (picture) {
            if (this.videoPreview.width !== 480) {
              this.videoPreview.width = 480;
              this.videoPreview.height = Math.round((480 * picture.height) / picture.width);
            }
            pctx.drawImage(picture, 0, 0, this.videoPreview.width, this.videoPreview.height);
          }
        },
      });
      if (res.audioCodec === 'opus') toast('The video\'s sound is Opus: this computer has no AAC encoder');
      return res.file;
    } catch (e) {
      if (e instanceof VideoCancelled) {
        toast('Video export cancelled; the audio files are written');
        return null;
      }
      throw e;
    } finally {
      this.videoRunning = false;
    }
  }

  private async run(jobs: ExportJob[]): Promise<void> {
    // the episode (and a template saved from it) exports the same way next time
    const settings = structuredClone(this.opts);
    store.patch((p) => ({ ...p, exportSettings: settings }));
    rememberSettings(settings);
    this.busy = true;
    this.exported = true;
    this.written = [];
    this.phase = '';
    for (const v of Object.values(this.liveValues)) v.textContent = '—';
    for (const t of Object.values(this.liveTiles)) t.className = 'lu-tile';
    this.wave.reset();
    this.render();
    try {
      const files: string[] = [];
      let last: ExportResult | null = null;
      const video = this.videoOn() ? this.opts.video! : null;
      const { video: _video, ...audio } = this.opts;
      const audioFiles = audio.formats.length > 0 || audio.stems || audio.chapterFiles;
      this.videoCancel = false;
      for (const [i, job] of jobs.entries()) {
        this.regionLabel = jobs.length > 1 ? `Region ${i + 1}/${jobs.length} “${job.region ?? ''}”: ` : '';
        this.wave.reset();
        // one export per region, each normalised on its own
        let jobFiles: string[] = [];
        if (audioFiles) {
          last = await api().exportProject({ ...audio, outputBase: job.outputBase, ...(job.start !== undefined ? { start: job.start, end: job.end } : {}) });
          jobFiles = last.files;
          files.push(...last.files);
        }
        if (video && !this.videoCancel) {
          const file = await this.exportVideo(job, video, jobFiles.find((f) => f === `${job.outputBase}.wav`));
          if (file) files.push(file);
        }
      }
      this.regionLabel = '';
      this.written = files;
      this.progressLabel.textContent = jobs.length > 1
        ? `Done: ${jobs.length} regions, ${files.length} files`
        : `Done: ${files.length} ${files.length === 1 ? 'file' : 'files'}${last ? ` · ${exportSummary(last)}` : ''}`;
      toast('Export finished');
      if (this.reveal && files[0]) void api().revealFile(files[0]);
    } catch (e) {
      this.regionLabel = '';
      toast(`Export failed: ${errorMessage(e)}`, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
