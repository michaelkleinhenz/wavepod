// Soundboard: jingle slots played through the output device. Keys 1–9 trigger slots.
import type { SoundboardSlot } from '../shared/types';
import { TRACK_COLORS } from '../core/project';
import { uid } from '../shared/time';
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
    store.edit((p) => ({ ...p, soundboard: [...p.soundboard, ...slots] }));
    await this.ensureLoaded();
  }

  render(): void {
    clear(this.el);
    this.el.append(h('span', { class: 'sb-title' }, 'Soundboard'));
    store.project.soundboard.forEach((slot, i) => {
      this.el.append(
        h(
          'div',
          { class: `sb-slot${this.isLoaded(slot) ? '' : ' loading'}`, style: { borderColor: slot.color } },
          h('button', { class: 'sb-play', title: `Play (key ${i + 1})`, onclick: () => void this.trigger(i) }, h('kbd', null, i < 9 ? String(i + 1) : ''), ` ${slot.name}`),
          h(
            'button',
            {
              class: 'sb-remove',
              title: 'Remove jingle',
              onclick: () => store.edit((p) => ({ ...p, soundboard: p.soundboard.filter((s) => s.id !== slot.id) })),
            },
            '×',
          ),
        ),
      );
    });
    if (store.project.soundboard.length < MAX_SLOTS) {
      this.el.append(h('button', { class: 'small', onclick: () => void this.addSlots() }, '+ Jingle'));
    }
    if (store.project.soundboard.length) {
      this.el.append(h('button', { class: 'small', title: 'Stop all jingles (Esc)', onclick: () => void api().stopSounds() }, '■ Stop'));
    }
  }
}
