// Auto-direct…: says which speakers each camera shows, then writes a first pass of switches that
// follows whoever is talking (from the transcript when there is one, else from the audio levels).
import type { Project } from '../../shared/types';
import { ACTIVITY_STEP, AUTO_DIRECT_DEFAULTS, activityFromLevels, activityFromWords, autoDirect, type Activity, type AutoDirectOptions } from '../../core/autoDirect';
import { applyPass, updateCamera } from '../../core/video';
import { clipsEnd } from '../../core/project';
import { errorMessage, h, toast } from '../dom';
import { api, store } from '../store';
import { transcripts } from '../transcripts';

const OPTS_KEY = 'wavepod.video.autoDirect';

function loadOpts(): AutoDirectOptions {
  try {
    return { ...AUTO_DIRECT_DEFAULTS, ...(JSON.parse(localStorage.getItem(OPTS_KEY) ?? '{}') as Partial<AutoDirectOptions>) };
  } catch {
    return { ...AUTO_DIRECT_DEFAULTS };
  }
}

function saveOpts(o: AutoDirectOptions): void {
  try {
    localStorage.setItem(OPTS_KEY, JSON.stringify(o));
  } catch {
    // this session only
  }
}

function speakerTracks(p: Project) {
  return p.tracks.filter((t) => !t.cameraId && t.kind !== 'soundboard' && t.clips.length);
}

export function openAutoDirect(): void {
  const p = store.project;
  const cams = p.cameras ?? [];
  if (!cams.length) return toast('Import a camera video first (File › Import Camera Video…)');
  const speakers = speakerTracks(p);
  if (!speakers.length) return toast('Auto-direct needs the microphone tracks of the speakers');
  const opts = loadOpts();
  const sel = store.selection.range;
  const hasSel = !!sel && sel[1] > sel[0];
  let onlySelection = hasSel;
  const grid = h(
    'table',
    { class: 'auto-direct-grid' },
    h('tr', null, h('th', null, 'Camera'), ...speakers.map((t) => h('th', { title: t.name }, h('span', { class: 'dot', style: { background: t.color } }), t.name))),
    ...cams.map((c, i) =>
      h(
        'tr',
        null,
        h('td', null, `${i + 1} ${c.name}`),
        ...speakers.map((t) =>
          h(
            'td',
            null,
            h('input', {
              type: 'checkbox',
              checked: !!store.project.cameras?.find((x) => x.id === c.id)?.speakers?.includes(t.id),
              onchange: (e: Event) => {
                const on = (e.target as HTMLInputElement).checked;
                store.edit((q) => {
                  const cam = q.cameras!.find((x) => x.id === c.id)!;
                  const set = new Set(cam.speakers ?? []);
                  if (on) set.add(t.id);
                  else set.delete(t.id);
                  return updateCamera(q, c.id, { speakers: [...set] });
                });
              },
            }),
          ),
        ),
      ),
    ),
  );
  const num = (label: string, key: keyof AutoDirectOptions, min: number, max: number, hint: string) =>
    h(
      'label',
      { class: 'video-export-row', title: hint },
      h('span', null, label),
      h('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        step: '0.5',
        value: String(opts[key]),
        onchange: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) opts[key] = Math.max(min, Math.min(max, v));
        },
      }),
    );
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener('keydown', onKey, true);
  const source = transcripts().count ? 'the transcript' : 'the audio levels (transcribe the episode for more precise switches)';
  const overlay = h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog' },
      h('h2', null, 'Auto-direct'),
      h('p', { class: 'muted' }, 'Tick who each camera shows. While one person talks, their close-up is shown; when several talk at once or nobody does, the camera showing the most people (the wide shot).'),
      grid,
      num('Shortest shot (s)', 'minShot', 0.5, 10, 'No shot is shorter than this'),
      num('Talk this long before the switch (s)', 'minTurn', 0.2, 5, 'A short “mhm” from the other person does not switch'),
      num('Wide shot after a close-up of (s)', 'maxCloseUp', 0, 120, 'A long close-up gets a short wide shot in between; 0 = never'),
      num('Wide shot after a pause of (s)', 'pauseWide', 0.5, 20, 'Nobody talking this long shows the wide shot'),
      hasSel
        ? h(
            'label',
            { class: 'row' },
            h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => (onlySelection = (e.target as HTMLInputElement).checked) }),
            ' Only the selected range',
          )
        : null,
      h('p', { class: 'muted' }, `Who is speaking comes from ${source}. The switches replace the ones in the range (Ctrl+Z undoes it).`),
      h(
        'div',
        { class: 'row end' },
        h('button', { onclick: close }, 'Cancel'),
        h(
          'button',
          {
            class: 'primary',
            onclick: () => {
              saveOpts(opts);
              close();
              void runAutoDirect(opts, onlySelection && sel ? [Math.round(sel[0]), Math.round(sel[1])] : null);
            },
          },
          'Direct',
        ),
      ),
    ),
  );
  document.body.append(overlay);
}

async function runAutoDirect(opts: AutoDirectOptions, range: [number, number] | null): Promise<void> {
  const p = store.project;
  const cams = p.cameras ?? [];
  if (!cams.some((c) => c.speakers?.length)) return toast('Tick at least one speaker for a camera first', 'error');
  const from = range?.[0] ?? 0;
  const to = range?.[1] ?? clipsEnd(p);
  const ids = speakerTracks(p).map((t) => t.id);
  try {
    const words = transcripts().words().filter((w) => ids.includes(w.trackId));
    const activity: Activity = words.length ? activityFromWords(words, ids, p.sampleRate, to) : await levelActivity(p, ids, to);
    const cuts = autoDirect(p, activity, from, to, opts);
    if (!cuts.length) return toast('Nobody seems to speak in that range');
    store.edit((q) => applyPass(q, from, to, cuts));
    toast(`Auto-direct: ${cuts.length} shot${cuts.length === 1 ? '' : 's'}. Watch it through (W) and press 1–9 where you want it different.`);
  } catch (e) {
    toast(errorMessage(e), 'error');
  }
}

/** Loudness per ACTIVITY_STEP for each track, from the waveform overview of its clips. */
async function levelActivity(p: Project, trackIds: string[], length: number): Promise<Activity> {
  const sr = p.sampleRate;
  const step = Math.round(ACTIVITY_STEP * sr);
  const n = Math.ceil(length / step) + 1;
  const levels = new Map<string, Float32Array>();
  for (const id of trackIds) {
    const track = p.tracks.find((t) => t.id === id)!;
    const out = new Float32Array(n).fill(-Infinity);
    for (const clip of track.clips) {
      const peaks = await api().getPeaks(clip.file);
      if (!peaks?.levels.length) continue;
      // the finest overview no coarser than one step
      const level = [...peaks.levels].reverse().find((l) => l.samplesPerPeak <= step) ?? peaks.levels[0];
      const spp = level.samplesPerPeak;
      const data = level.data;
      for (let k = Math.floor(clip.start / step); k * step < clip.start + clip.length && k < n; k++) {
        const t0 = Math.max(clip.start, k * step);
        const t1 = Math.min(clip.start + clip.length, (k + 1) * step);
        if (t1 <= t0) continue;
        const a = Math.floor((clip.offset + t0 - clip.start) / spp);
        const b = Math.ceil((clip.offset + t1 - clip.start) / spp);
        let peak = 0;
        for (let i = Math.max(0, a); i < b && i * 2 + 1 < data.length; i++) peak = Math.max(peak, Math.abs(data[i * 2]), Math.abs(data[i * 2 + 1]));
        const db = peak > 0 ? 20 * Math.log10(peak / 127) + track.gain + clip.gain : -Infinity;
        out[k] = Math.max(out[k], db);
      }
    }
    levels.set(id, out);
  }
  return activityFromLevels(levels);
}
