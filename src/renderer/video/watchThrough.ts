// Watch through (W): the episode plays in a large program view with every camera below it, and the
// number keys switch cameras as it plays, like a vision mixer. Once a key is pressed, the switches
// from there until playback stops replace the ones that were there (one undo step); before the
// first key nothing changes, so watching alone is safe.
import type { DirectorCut } from '../../shared/types';
import { applyPass, cameraNumber, videoSettings } from '../../core/video';
import { snapToWords } from '../../core/autoDirect';
import { formatTimestamp } from '../../shared/time';
import { seek, stop, togglePlay } from '../actions';
import { h, toast } from '../dom';
import { store } from '../store';
import { transcripts } from '../transcripts';
import { videoPlayer } from './player';
import { switchAtPlayhead } from './videoPanel';

const REACTION_KEY = 'wavepod.video.reactionMs';
const DISSOLVE_SECONDS = 0.5;

export function reactionMs(): number {
  try {
    const v = Number(localStorage.getItem(REACTION_KEY));
    return Number.isFinite(v) && v >= 0 && v <= 1000 && localStorage.getItem(REACTION_KEY) !== null ? v : 250;
  } catch {
    return 250;
  }
}

function saveReaction(ms: number): void {
  try {
    localStorage.setItem(REACTION_KEY, String(ms));
  } catch {
    // this session only
  }
}

export class WatchThrough {
  private el: HTMLElement | null = null;
  private detach: Array<() => void> = [];
  /** The pass being directed: where it started and its switches. */
  private pass: { from: number; cuts: DirectorCut[] } | null = null;
  private dissolveHeld = false;
  private wasPlaying = false;
  /** Where playback last was while it ran (Stop may move the playhead back). */
  private lastPos = 0;
  private label = h('div', { class: 'wt-label' });
  private time = h('div', { class: 'wt-time' });
  private status = h('div', { class: 'wt-status' });

  get isOpen(): boolean {
    return !!this.el;
  }

  toggle(): void {
    if (this.el) this.close();
    else this.open();
  }

  open(): void {
    const p = store.project;
    if (!p.cameras?.length) return toast('Import a camera video first (File › Import Camera Video…)');
    if (store.transport.state === 'recording') return toast('Stop recording first');
    const v = videoSettings(p);
    const program = h('canvas', { class: 'wt-program' });
    program.width = 1280;
    program.height = Math.round((1280 * v.height) / v.width);
    const tiles = p.cameras.map((cam, i) => {
      const c = h('canvas', { class: 'wt-tile-canvas' });
      c.width = 320;
      c.height = Math.round((320 * v.height) / v.width);
      this.detach.push(videoPlayer.attach({ canvas: c, kind: 'camera', cameraId: cam.id }));
      return h(
        'button',
        { class: 'wt-tile', 'data-camera': cam.id, style: `--cam-color: ${cam.color}`, onclick: () => this.take(cam.id) },
        c,
        h('span', { class: 'wt-key' }, String(i + 1)),
        h('span', { class: 'wt-name' }, cam.name),
      );
    });
    this.detach.push(videoPlayer.attach({ canvas: program, kind: 'program' }));
    const reaction = h('input', {
      type: 'number',
      min: '0',
      max: '1000',
      step: '10',
      value: String(reactionMs()),
      title: 'Each switch is placed this much earlier than the key press, to make up for reaction time',
      onchange: (e: Event) => saveReaction(Math.max(0, Math.min(1000, Number((e.target as HTMLInputElement).value) || 0))),
    });
    this.el = h(
      'div',
      { class: 'watch-through', role: 'dialog', 'aria-label': 'Watch through and switch cameras' },
      h(
        'div',
        { class: 'wt-top' },
        h('b', null, 'Watch through'),
        this.time,
        this.status,
        h('div', { class: 'spacer' }),
        h('label', { class: 'wt-reaction' }, 'Reaction time ', reaction, ' ms'),
        h('button', { onclick: () => void togglePlay() }, 'Play / Pause (Space)'),
        h('button', { onclick: () => this.close() }, 'Done (Esc)'),
      ),
      h('div', { class: 'wt-stage' }, program, this.label),
      h('div', { class: 'wt-tiles' }, ...tiles),
      h(
        'div',
        { class: 'wt-help muted' },
        '1–9 switch camera · hold D with a number for a dissolve · ← / → 5 s back / on · Space play / pause · Esc done. Your switches replace the old ones from the first key you press until you stop.',
      ),
    );
    document.body.append(this.el);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    this.detach.push(
      videoPlayer.listen((frame, pos) => {
        const cam = frame.b ?? frame.a;
        const c = cam && store.project.cameras?.find((x) => x.id === cam.camera);
        this.label.textContent = c ? `${cameraNumber(store.project, c.id)} · ${c.name}` : 'No picture';
        this.label.style.borderColor = c?.color ?? 'transparent';
        this.time.textContent = formatTimestamp(pos / store.sampleRate);
        if (videoPlayer.playing) this.lastPos = pos;
        for (const t of tiles) t.classList.toggle('live', !!cam && t.dataset.camera === cam.camera);
      }),
    );
    this.detach.push(
      store.subscribe((kinds) => {
        if (!kinds.has('transport')) return;
        const playing = store.transport.state === 'playing';
        if (this.wasPlaying && !playing) this.finishPass();
        this.wasPlaying = playing;
      }),
    );
    this.wasPlaying = store.transport.state === 'playing';
    this.renderStatus();
  }

  close(): void {
    if (!this.el) return;
    if (store.transport.state === 'playing') void stop();
    this.finishPass();
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    for (const d of this.detach) d();
    this.detach = [];
    this.el.remove();
    this.el = null;
  }

  private renderStatus(): void {
    if (this.pass) {
      this.status.textContent = `● Directing since ${formatTimestamp(this.pass.from / store.sampleRate)}`;
      this.status.className = 'wt-status rec';
    } else {
      this.status.textContent = store.transport.state === 'playing' ? 'Watching: press 1–9 to start directing' : 'Paused';
      this.status.className = 'wt-status';
    }
  }

  /** A camera key: while playing it records a switch, paused it switches at the playhead. */
  take(cameraId: string): void {
    if (store.transport.state !== 'playing') {
      switchAtPlayhead(cameraId, store.transport.position);
      return;
    }
    const sr = store.sampleRate;
    let at = Math.max(0, Math.round(videoPlayer.position() - (reactionMs() / 1000) * sr));
    const words = transcripts()
      .words()
      .filter((w) => !store.project.tracks.find((t) => t.id === w.trackId)?.cameraId);
    at = snapToWords(at, words, Math.round(0.4 * sr));
    if (!this.pass) {
      this.pass = { from: at, cuts: [] };
      // until the first key, the stored switches play; from there the pass decides
      videoPlayer.override = (pos) => {
        const pass = this.pass;
        if (!pass || pos < pass.from) return null;
        let cam: string | null = null;
        for (const c of pass.cuts) if (c.at <= pos) cam = c.camera;
        return cam;
      };
    }
    const cuts = this.pass.cuts.filter((c) => c.at < at);
    cuts.push({ at, camera: cameraId, ...(this.dissolveHeld ? { dissolve: Math.round(DISSOLVE_SECONDS * sr) } : {}) });
    this.pass.cuts = cuts;
    this.renderStatus();
  }

  /** Stores the pass (from its first switch to where playback stopped) as one undo step. */
  private finishPass(): void {
    const pass = this.pass;
    this.pass = null;
    videoPlayer.override = null;
    if (pass?.cuts.length) {
      const to = Math.max(pass.from + 1, Math.round(this.lastPos));
      store.edit((p) => applyPass(p, pass.from, to, pass.cuts));
      toast(`Stored ${pass.cuts.length} switch${pass.cuts.length === 1 ? '' : 'es'} from ${formatTimestamp(pass.from / store.sampleRate)} to ${formatTimestamp(to / store.sampleRate)} (Ctrl+Z undoes the pass)`);
    }
    if (this.el) this.renderStatus();
  }

  private onKey = (e: KeyboardEvent) => {
    if (!this.el || document.querySelector('.overlay')) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (digit && !e.ctrlKey && !e.metaKey) {
      handled();
      if (e.repeat) return;
      const cam = store.project.cameras?.[Number(digit[1]) - 1];
      if (cam) this.take(cam.id);
      return;
    }
    switch (e.code) {
      case 'KeyD':
        handled();
        this.dissolveHeld = true;
        return;
      case 'Escape':
        handled();
        this.close();
        return;
      case 'KeyW':
        handled();
        this.close();
        return;
      case 'Space':
        handled();
        if (!e.repeat) void togglePlay();
        return;
      case 'ArrowLeft':
      case 'ArrowRight': {
        handled();
        // a jump ends the pass at the spot it left
        this.lastPos = videoPlayer.position();
        this.finishPass();
        const dir = e.code === 'ArrowLeft' ? -1 : 1;
        seek(store.transport.position + dir * 5 * store.sampleRate);
        return;
      }
    }
    // everything else (Ctrl+Z, zoom, …) is left alone; single-letter edits are not meant for here
    if (!e.ctrlKey && !e.metaKey && e.key.length === 1) handled();
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'KeyD') this.dissolveHeld = false;
  };
}
