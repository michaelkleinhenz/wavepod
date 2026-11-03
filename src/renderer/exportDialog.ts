// Export dialog: formats, loudness target, stems, chapter files, range, progress.
import type { ExportOptions, LoudnessReport } from '../shared/types';
import { clear, errorMessage, h, toast } from './dom';
import { LOUDNESS_PRESETS, loudnessTable } from './loudnessDialog';
import { api, store } from './store';

const PRESETS = LOUDNESS_PRESETS;

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
  private busy = false;
  private progressEl = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  private progressLabel = h('span', { class: 'muted' });
  private loudness: LoudnessReport[] | null = null;

  constructor() {
    api().onExportProgress((p) => {
      (this.progressEl.firstChild as HTMLElement).style.width = `${Math.round(p.fraction * 100)}%`;
      this.progressLabel.textContent = `${p.phase} ${Math.round(p.fraction * 100)}%`;
    });
    this.overlay.addEventListener('mousedown', (e) => {
      if (e.target === this.overlay && !this.busy) this.close();
    });
  }

  open(): void {
    this.loudness = null;
    this.render();
    document.body.append(this.overlay);
  }

  close(): void {
    this.overlay.remove();
  }

  private render(): void {
    clear(this.overlay);
    const o = this.opts;
    const range = store.selection.range;
    const check = (label: string, checked: boolean, onChange: (v: boolean) => void, disabled = false) =>
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked, disabled, onchange: (e: Event) => onChange((e.target as HTMLInputElement).checked) }), label);
    const fmt = (f: 'mp3' | 'wav', label: string) =>
      check(label, o.formats.includes(f), (v) => {
        o.formats = v ? [...new Set([...o.formats, f])] : o.formats.filter((x) => x !== f);
        this.render();
      });

    const loudnessRows = this.loudness ? loudnessTable(this.loudness, { lufs: o.targetLufs, ceiling: o.peakCeiling }) : null;

    const dialog = h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Export episode'),
      h('div', { class: 'grid' },
        h('div', null, h('h3', null, 'Formats'), fmt('mp3', 'MP3 with ID3 chapters'), fmt('wav', 'WAV 24-bit'),
          h('label', { class: 'field' }, h('span', null, 'MP3 bitrate'),
            h('select', { disabled: !o.formats.includes('mp3'), onchange: (e: Event) => (o.mp3Bitrate = Number((e.target as HTMLSelectElement).value)) },
              ...[64, 96, 128, 160, 192, 256].map((b) => h('option', { value: String(b), selected: b === o.mp3Bitrate }, `${b} kbps`)))),
          check('Chapter files (PSC, JSON, mp4chaps, Audacity)', o.chapterFiles, (v) => (o.chapterFiles = v)),
          check('Stems (one WAV per track)', o.stems, (v) => (o.stems = v)),
          check(range ? `Only the selected range` : 'Only the selected range (none selected)', this.useRange && !!range, (v) => (this.useRange = v), !range),
        ),
        h('div', null, h('h3', null, 'Loudness'),
          check('Normalise loudness', o.normalize, (v) => { o.normalize = v; this.render(); }),
          h('label', { class: 'field' }, h('span', null, 'Target'),
            h('select', { disabled: !o.normalize, onchange: (e: Event) => (o.targetLufs = Number((e.target as HTMLSelectElement).value)) },
              ...PRESETS.map((p) => h('option', { value: String(p.value), selected: p.value === o.targetLufs }, p.label)))),
          h('label', { class: 'field' }, h('span', null, 'Peak ceiling'),
            h('select', { disabled: !o.normalize, onchange: (e: Event) => (o.peakCeiling = Number((e.target as HTMLSelectElement).value)) },
              ...[-0.1, -1, -2, -3].map((p) => h('option', { value: String(p), selected: p === o.peakCeiling }, `${p} dBFS`)))),
          h('button', { class: 'small', disabled: this.busy, onclick: () => void this.analyse() }, 'Analyse loudness'),
          loudnessRows,
        ),
      ),
      h('div', { class: 'row' }, this.progressEl, this.progressLabel),
      h('div', { class: 'row end' },
        h('button', { disabled: this.busy, onclick: () => this.close() }, 'Close'),
        h('button', { class: 'primary', disabled: this.busy || o.formats.length === 0, onclick: () => void this.run() }, this.busy ? 'Exporting…' : 'Export…'),
      ),
    );
    this.overlay.append(dialog);
  }

  private async analyse(): Promise<void> {
    this.busy = true;
    this.progressLabel.textContent = 'Analysing…';
    this.render();
    try {
      this.loudness = await api().measureLoudness();
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
    this.busy = true;
    this.render();
    try {
      const res = await api().exportProject({ ...this.opts, outputBase: base, ...(range ? { start: range[0], end: range[1] } : {}) });
      this.progressLabel.textContent = `Done: ${res.files.length} files · ${Number.isFinite(res.loudness) ? `${res.loudness.toFixed(1)} LUFS → ${(res.loudness + res.appliedGainDb).toFixed(1)} LUFS` : 'silent'}`;
      toast('Export finished');
      if (res.files[0]) void api().revealFile(res.files[0]);
    } catch (e) {
      toast(`Export failed: ${errorMessage(e)}`, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }
}
