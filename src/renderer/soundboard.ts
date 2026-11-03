// Soundboard: jingle slots played through the output device. Keys 1–9 trigger slots.
import type { PlayingJingle, SoundboardSlot } from '../shared/types';
import { TRACK_COLORS } from '../core/project';
import { ensureSoundboardTrack } from '../core/soundboard';
import { formatTimestamp, uid } from '../shared/time';
import { baseName, decodeFile } from './audioFiles';
import { clear, errorMessage, h, toast } from './dom';
import { api, store } from './store';

const MAX_SLOTS = 12;

export class Soundboard {
  readonly el = h('div', { class: 'soundboard' });
  private loaded = new Set<string>();
  private loading = new Set<string>();

  /** Decodes and sends slot audio to the engine (after project load or rate change). */
  async ensureLoaded(): Promise<void> {
    for (const slot of store.project.soundboard) {
      const key = `${store.dir}|${slot.id}|${store.sampleRate}`;
      if (this.loaded.has(key) || this.loading.has(key)) continue;
      this.loading.add(key);
      try {
        const data = await decodeFile(slot.file, store.sampleRate);
        await api().loadSound(slot.id, data);
        this.loaded.add(key);
      } catch (e) {
        toast(`Jingle "${slot.name}" could not be loaded: ${errorMessage(e)}`, 'error');
      } finally {
        this.loading.delete(key);
      }
    }
    this.render();
  }

  private isLoaded(slot: SoundboardSlot): boolean {
    return this.loaded.has(`${store.dir}|${slot.id}|${store.sampleRate}`);
  }

  async trigger(index: number): Promise<void> {
    const slot = store.project.soundboard[index];
    if (!slot) return;
    try {
      await api().playSound(slot.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  }

  private async addSlots(): Promise<void> {
    const paths = await api().pickAudioFiles();
    const free = MAX_SLOTS - store.project.soundboard.length;
    const slots = paths.slice(0, free).map((file, i) => ({
      id: uid('snd'),
      name: baseName(file).replace(/\.[^.]+$/, ''),
      file,
      gain: 0,
      color: TRACK_COLORS[(store.project.soundboard.length + i) % TRACK_COLORS.length],
    }));
    if (!slots.length) return;
    store.edit((p) => ensureSoundboardTrack({ ...p, soundboard: [...p.soundboard, ...slots] }));
    await this.ensureLoaded();
  }

  private slotEls = new Map<string, { root: HTMLElement; time: HTMLElement }>();

  /** Shows which jingles play and their remaining time (called on every transport update). */
  updatePlaying(jingles: PlayingJingle[] = []): void {
    const sr = store.sampleRate;
    for (const [id, el] of this.slotEls) {
      const j = jingles.find((x) => x.slotId === id);
      el.root.classList.toggle('playing', !!j && !j.stopping);
      el.root.classList.toggle('stopping', !!j?.stopping);
      el.time.textContent = j ? `−${formatTimestamp(Math.ceil(j.remaining / sr), false).replace(/^00:/, '')}` : '';
    }
  }

  private toggleOption(slot: SoundboardSlot, key: 'loop' | 'fadeIn'): void {
    store.edit((p) => ({ ...p, soundboard: p.soundboard.map((s) => (s.id === slot.id ? { ...s, [key]: !s[key] } : s)) }));
  }

  render(): void {
    clear(this.el);
    this.slotEls.clear();
    this.el.append(h('span', { class: 'sb-title', title: 'Jingles triggered while recording are recorded onto the Soundboard track' }, 'Soundboard'));
    store.project.soundboard.forEach((slot, i) => {
      const time = h('span', { class: 'sb-time' });
      const root = h(
          'div',
          { class: `sb-slot${this.isLoaded(slot) ? '' : ' loading'}`, style: { borderColor: slot.color } },
          h(
            'button',
            { class: 'sb-play', title: `Play, or fade out while playing (key ${i + 1})`, onclick: () => void this.trigger(i) },
            h('kbd', null, i < 9 ? String(i + 1) : ''),
            ` ${slot.name}`,
            time,
          ),
          h('button', { class: `sb-opt${slot.fadeIn ? ' on' : ''}`, title: 'Soft fade-in', onclick: () => this.toggleOption(slot, 'fadeIn') }, '◢'),
          h('button', { class: `sb-opt${slot.loop ? ' on' : ''}`, title: 'Loop until stopped', onclick: () => this.toggleOption(slot, 'loop') }, '⟲'),
          h(
            'button',
            {
              class: 'sb-remove',
              title: 'Remove jingle',
              onclick: () => store.edit((p) => ({ ...p, soundboard: p.soundboard.filter((s) => s.id !== slot.id) })),
            },
            '×',
          ),
        );
      this.slotEls.set(slot.id, { root, time });
      this.el.append(root);
    });
    this.updatePlaying(store.transport.jingles);
    if (store.project.soundboard.length < MAX_SLOTS) {
      this.el.append(h('button', { class: 'small', onclick: () => void this.addSlots() }, '+ Jingle'));
    }
    if (store.project.soundboard.length) {
      this.el.append(h('button', { class: 'small', title: 'Stop all jingles (Esc)', onclick: () => void api().stopSounds() }, '■ Stop'));
    }
  }
}
