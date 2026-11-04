// Setup: tabs for the episode (open, new, save), the audio interface, microphones (meters and track creation), controllers (MIDI, OSC)
// and AI agents (MCP). Technical settings sit in collapsed "Advanced" sections.
import type { BitDepth, DeviceConfig, DeviceProfile, EngineStatus, OutputSource } from '../shared/types';
import { addTrack } from '../core/project';
import { suggestTracks } from '../core/deviceProfiles';
import { LevelMeter } from './levelMeter';
import { append, clear, disclosure, errorMessage, h, keepScroll, toast } from './dom';
import { isMcpOn, renderMcpCard } from './mcpCard';
import { midi } from './midi';
import { renderMidiCard } from './midiCard';
import { isOscOn, renderOscCard } from './oscCard';
import { api, store } from './store';
import type { RecentProject } from '../shared/api';
import type { TemplateSummary } from '../core/template';
import { newProject, openProject, openProjectAt, saveEpisode, saveEpisodeAs } from './actions';
import { newFromTemplate } from './templateDialog';

const SAMPLE_RATES = [44100, 48000, 96000];
const BUFFER_SIZES = [128, 256, 512, 1024, 2048];

export type SetupTab = 'project' | 'audio' | 'inputs' | 'controllers' | 'agents';
const TABS: Array<{ id: SetupTab; label: string; blurb: string }> = [
  { id: 'project', label: 'Project', blurb: 'Continue an episode, open another one or start a new one, empty or from a template.' },
  { id: 'audio', label: 'Audio', blurb: 'Choose the device you record from and the one you listen on.' },
  { id: 'inputs', label: 'Microphones', blurb: 'Check your levels and create a track for every speaker.' },
  { id: 'controllers', label: 'Controllers', blurb: 'Start recording, drop markers and fire jingles from a MIDI controller or Stream Deck.' },
  { id: 'agents', label: 'AI agents', blurb: 'Let AI apps on this computer help with filters and loudness.' },
];
const TAB_KEY = 'wavepod.setupTab';

function savedTab(): SetupTab {
  try {
    const t = localStorage.getItem(TAB_KEY);
    if (TABS.some((x) => x.id === t)) return t as SetupTab;
  } catch {
    /* storage unavailable */
  }
  return 'audio';
}

export class SetupView {
  readonly el = h('div', { class: 'view setup-view' });
  private meterEls: LevelMeter[] = [];
  private tab: SetupTab = savedTab();
  /** Opens the template dialogs (set by the app shell). */
  onTemplates?: { start: () => void; save: () => void };
  /** Called after the Project tab opened or created an episode, with what happened. */
  onEpisodeChosen?: (how: 'opened' | 'blank' | 'template') => void;
  /** Project tab: the name typed for a new episode, the templates and the recent episodes. */
  private newName = '';
  private newNameDefault = '';
  private templates: TemplateSummary[] = [];
  private recent: RecentProject[] = [];
  private busy = false;

  async refreshDevices(): Promise<void> {
    try {
      store.devices = await api().listDevices();
      const id = store.status?.config.inputDeviceId;
      store.profile = id !== null && id !== undefined ? await api().getProfile(id) : null;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    store.notify('devices');
  }

  private async apply(patch: Partial<DeviceConfig>): Promise<void> {
    try {
      store.status = await api().applyConfig(patch);
      if (store.status.error) toast(store.status.error, 'error');
      // An empty project follows the device rate.
      const s = store.status;
      if (s && !store.project.tracks.some((t) => t.clips.length) && store.project.sampleRate !== s.config.sampleRate) {
        store.patch((p) => ({ ...p, sampleRate: s.config.sampleRate }));
      }
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    await this.refreshDevices();
  }

  /** Switches to a Setup tab (also used by the app shell, e.g. to point at the MIDI settings). */
  showTab(tab: SetupTab): void {
    if (tab === this.tab) return;
    this.tab = tab;
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* storage unavailable: the tab just isn't remembered */
    }
    // A new tab starts at its top; keepScroll would carry over the old tab's position.
    this.build();
    this.el.scrollTop = 0;
    if (tab === 'project') void this.refreshProjects();
  }

  render(): void {
    // A status update must not take the cursor out of the name field while typing.
    const focused = document.activeElement as HTMLInputElement | null;
    const keepFocus = focused?.classList.contains('new-episode-name') ? [focused.selectionStart, focused.selectionEnd] : null;
    // Rebuilding empties the view, which would jump it back to the top (e.g. on Learn).
    keepScroll(this.el, () => this.build());
    if (keepFocus) {
      const input = this.el.querySelector<HTMLInputElement>('input.new-episode-name');
      input?.focus();
      input?.setSelectionRange(keepFocus[0], keepFocus[1]);
    }
  }

  /** Reloads what the Project tab lists: templates, recent episodes and the default name for a new one. */
  async refreshProjects(): Promise<void> {
    try {
      const [templates, recent, name] = await Promise.all([api().listTemplates(), api().listRecentProjects(), api().defaultEpisodeName()]);
      this.templates = templates;
      this.recent = recent;
      // keep what the user typed; only follow the clock while the field still shows the default
      if (!this.newName || this.newName === this.newNameDefault) this.newName = name;
      this.newNameDefault = name;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
    if (this.tab === 'project') this.render();
  }

  private async choose(how: 'opened' | 'blank' | 'template', fn: () => Promise<boolean>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    let ok = false;
    try {
      ok = await fn();
    } finally {
      this.busy = false;
    }
    if (ok) {
      this.newName = '';
      this.onEpisodeChosen?.(how);
    }
    void this.refreshProjects();
  }

  private build(): void {
    clear(this.el);
    const s = store.status;
    if (!s) {
      this.el.append(h('p', null, 'Starting audio engine…'));
      return;
    }
    const audioProblem = !!(s.error || s.backendError || !store.devices.length || !s.inputOpen || !s.outputOpen);
    const badge: Record<SetupTab, 'warn' | 'on' | null> = {
      project: store.saveState.state === 'error' ? 'warn' : null,
      audio: audioProblem ? 'warn' : null,
      inputs: null,
      controllers: midi.settings.enabled || isOscOn() ? 'on' : null,
      agents: isMcpOn() ? 'on' : null,
    };
    const tabs = h(
      'div',
      { class: 'setup-tabs', role: 'tablist' },
      ...TABS.map((t) =>
        h(
          'button',
          {
            class: `setup-tab${t.id === this.tab ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': String(t.id === this.tab),
            title: t.blurb,
            onclick: () => this.showTab(t.id),
          },
          t.label,
          badge[t.id] ? h('span', { class: `tab-dot ${badge[t.id]}`, title: badge[t.id] === 'warn' ? 'Needs attention' : 'Switched on' }) : null,
        ),
      ),
    );
    const blurb = TABS.find((t) => t.id === this.tab)!.blurb;
    const page = h('div', { class: 'setup-page', role: 'tabpanel' }, h('p', { class: 'setup-blurb muted' }, blurb));
    switch (this.tab) {
      case 'project':
        append(page, [this.renderCurrentEpisode(), this.renderNewEpisode(), this.renderOpenEpisode()]);
        break;
      case 'audio':
        append(page, [this.renderAudio(s), this.renderSecondOutput(s)]);
        break;
      case 'inputs':
        append(page, [this.renderChannels(store.profile, s.inputChannelCount), this.renderTemplates()]);
        break;
      case 'controllers':
        append(page, [renderMidiCard(), renderOscCard()]);
        break;
      case 'agents':
        page.append(renderMcpCard());
        break;
    }
    // Meters only exist on the Microphones tab.
    if (this.tab !== 'inputs') this.meterEls = [];
    this.el.append(tabs, page);
  }

  private select<T extends string | number>(
    label: string,
    value: T | null,
    options: Array<{ value: T; label: string }>,
    onChange: (v: string) => void,
    emptyLabel?: string,
    help?: string,
  ): HTMLElement {
    return h(
      'label',
      { class: 'field' },
      h('span', null, label),
      h(
        'select',
        { onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
        emptyLabel ? h('option', { value: '', selected: value === null }, emptyLabel) : null,
        ...options.map((o) => h('option', { value: String(o.value), selected: o.value === value }, o.label)),
      ),
      help ? h('small', { class: 'field-help' }, help) : null,
    );
  }

  /** Output channel pairs of the chosen output device (value = first channel, 0-based). */
  private outputPairs(s: EngineStatus): Array<{ value: number; label: string }> {
    const outDev = store.devices.find((d) => d.outputChannels > 0 && d.id === s.config.outputDeviceId);
    if (!outDev) return [];
    return Array.from({ length: Math.max(1, Math.floor(outDev.outputChannels / 2)) }, (_, i) => ({
      value: i * 2,
      label: outDev.outputChannels === 1 ? 'Output 1' : `Outputs ${i * 2 + 1} and ${i * 2 + 2}`,
    }));
  }

  private renderAudio(s: EngineStatus): HTMLElement {
    const cfg = s.config;
    const inputs = store.devices.filter((d) => d.inputChannels > 0);
    const outputs = store.devices.filter((d) => d.outputChannels > 0);
    const outDev = outputs.find((d) => d.id === cfg.outputDeviceId);
    const inDev = inputs.find((d) => d.id === cfg.inputDeviceId);
    const pairs = this.outputPairs(s);
    const noDevices = !store.devices.length;

    // One plain sentence on whether WavePod can record and play right now.
    const summary = s.error
      ? h('p', { class: 'setup-status error-text' }, s.error)
      : noDevices
        ? h('p', { class: 'setup-status warning' }, 'No audio devices found. Plug in your audio interface and click "Look for devices again", or try another audio driver under Advanced.')
        : !s.inputOpen || !s.outputOpen
          ? h(
              'p',
              { class: 'setup-status warning' },
              !s.inputOpen && !s.outputOpen
                ? 'Pick a device to record from and one to listen on.'
                : !s.inputOpen
                  ? 'Pick a device to record from.'
                  : 'Pick a device to listen on.',
            )
          : h(
              'p',
              { class: 'setup-status ok' },
              `Ready. Recording ${s.inputChannelCount === 1 ? '1 input' : `${s.inputChannelCount} inputs`} from ${inDev?.name ?? 'the input device'}, listening on ${outDev?.name ?? 'the output device'}.`,
            );

    const sampleRates = SAMPLE_RATES.filter((r) => !inDev || !inDev.sampleRates.length || inDev.sampleRates.includes(r));
    const advanced = disclosure(
      'setup-audio-advanced',
      'Advanced audio settings',
      [
        h(
          'div',
          { class: 'grid' },
          this.select(
            'Audio driver',
            cfg.api,
            s.apis.map((a) => ({ value: a.id, label: a.label })),
            (v) => this.apply({ api: v, inputDeviceId: null, outputDeviceId: null }),
            undefined,
            'How WavePod talks to your sound hardware. Change it only if your device is missing; on Windows pick ASIO for multitrack interfaces.',
          ),
          this.select(
            'Sample rate',
            cfg.sampleRate,
            sampleRates.map((r) => ({ value: r, label: `${r / 1000} kHz${r === 48000 ? ' (recommended)' : ''}` })),
            (v) => this.apply({ sampleRate: Number(v) }),
            undefined,
            '48 kHz is the podcast and video standard. Use what your interface is set to.',
          ),
          this.select(
            'Latency (buffer size)',
            cfg.bufferSize,
            BUFFER_SIZES.map((b) => ({ value: b, label: `${((b / cfg.sampleRate) * 1000).toFixed(1)} ms (${b} samples)` })),
            (v) => this.apply({ bufferSize: Number(v) }),
            undefined,
            'Lower reacts faster when you listen live; raise it if you hear clicks or dropouts.',
          ),
        ),
        h(
          'p',
          { class: 'muted engine-line' },
          `Engine: ${s.backend} · input ${s.inputOpen ? `open, ${s.inputChannelCount} ch` : 'closed'} · output ${s.outputOpen ? `open, ${s.outputChannelCount} ch` : 'closed'} · project ${store.project.sampleRate / 1000} kHz`,
        ),
      ],
      noDevices,
    );

    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Audio interface'),
      s.backendError ? h('p', { class: 'warning' }, `${s.backendError}. Using virtual devices.`) : null,
      summary,
      h(
        'div',
        { class: 'grid' },
        this.select(
          'Record from',
          cfg.inputDeviceId,
          inputs.map((d) => ({ value: d.id, label: `${d.name} (${d.inputChannels === 1 ? '1 input' : `${d.inputChannels} inputs`})` })),
          (v) => this.apply({ inputDeviceId: v === '' ? null : Number(v) }),
          inputs.length ? undefined : 'No input devices',
          'Your microphone, mixer or audio interface.',
        ),
        this.select(
          'Listen on',
          cfg.outputDeviceId,
          outputs.map((d) => ({ value: d.id, label: d.name })),
          (v) => this.apply({ outputDeviceId: v === '' ? null : Number(v) }),
          outputs.length ? undefined : 'No output devices',
          'Headphones or speakers for playback and the soundboard.',
        ),
        pairs.length > 1
          ? this.select('Headphones / speakers on', cfg.outputFirstChannel, pairs, (v) => this.apply({ outputFirstChannel: Number(v) }), undefined, 'Which outputs of the device you listen on.')
          : null,
        this.select(
          'Recording quality',
          store.project.bitDepth,
          [
            { value: 16, label: 'Standard (16-bit WAV)' },
            { value: 24, label: 'High (24-bit WAV, recommended)' },
            { value: 32, label: 'Maximum (32-bit float WAV)' },
          ],
          (v) => store.patch((p) => ({ ...p, bitDepth: Number(v) as BitDepth })),
          undefined,
          'Higher leaves more headroom for editing. Saved with this episode.',
        ),
      ),
      h('div', { class: 'row' }, h('button', { onclick: () => this.apply({}) }, 'Look for devices again')),
      advanced,
    );
  }

  /** The optional second output pair (stream mix, a second headphone amp, …). */
  private renderSecondOutput(s: EngineStatus): HTMLElement | null {
    const cfg = s.config;
    const pairs = this.outputPairs(s);
    if (pairs.length < 2) return null;
    const on = cfg.output2FirstChannel !== null && cfg.output2FirstChannel !== undefined;
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Second output'),
      h('p', { class: 'muted' }, 'Send a second feed to two more outputs of the same device, for example to a stream, a second headphone amp or a mixer channel for the soundboard.'),
      h(
        'div',
        { class: 'grid' },
        this.select(
          'Send to',
          cfg.output2FirstChannel ?? null,
          pairs.filter((p) => p.value !== cfg.outputFirstChannel),
          (v) => this.apply({ output2FirstChannel: v === '' ? null : Number(v) }),
          'Off',
        ),
        on
          ? this.select<OutputSource>(
              'What it carries',
              cfg.output2Source ?? 'master',
              [
                { value: 'master', label: 'Everything (same as your headphones)' },
                { value: 'soundboard', label: 'Soundboard only' },
                { value: 'episode', label: 'Episode playback without live jingles' },
              ],
              (v) => this.apply({ output2Source: v as OutputSource }),
            )
          : null,
      ),
    );
  }

  private renderChannels(profile: DeviceProfile | null, channelCount: number): HTMLElement {
    this.meterEls = [];
    const card = h('section', { class: 'card' }, h('h2', null, 'Microphones and inputs'));
    if (!channelCount) {
      card.append(h('p', { class: 'muted' }, 'Nothing to show yet: choose a device to record from on the Audio tab.'));
      return card;
    }
    const labels = profile?.inputs ?? Array.from({ length: channelCount }, (_, i) => ({ index: i, label: `Input ${i + 1}` }));
    append(card, [
      h('p', { class: 'muted' }, profile ? `Recognised: ${profile.name}. Inputs are named for you.` : 'Speak into each microphone to see which input it is on. Green rows already have a track.'),
      profile?.note ? h('p', { class: 'hint' }, profile.note) : null,
    ]);
    const used = new Set(store.project.tracks.flatMap((t) => t.inputChannels));
    const suggestions = profile ? suggestTracks(profile) : [];
    const missing = suggestions.filter((sug) => !sug.inputChannels.every((c) => used.has(c)));
    card.append(
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'primary',
            disabled: missing.length === 0,
            onclick: () => {
              store.edit((p) => missing.reduce((q, sug) => addTrack(q, { name: sug.name, inputChannels: sug.inputChannels, armed: true }), p));
              toast(`Created ${missing.length} tracks`);
              store.setView('edit');
            },
          },
          missing.length ? `Create ${missing.length} speaker tracks` : 'All sources have tracks',
        ),
        h('span', { class: 'muted' }, 'One track per microphone or remote guest, armed and ready to record.'),
      ),
    );
    const list = h('div', { class: 'channel-list' });
    for (const ch of labels) {
      if (ch.index >= channelCount) continue;
      const meter = new LevelMeter(`in:${ch.index}`, 'large');
      this.meterEls[ch.index] = meter;
      const stereoLeft = 'stereoLeft' in ch && ch.stereoLeft;
      const isRight = labels.some((x) => 'stereoLeft' in x && x.stereoLeft && x.index === ch.index - 1);
      list.append(
        h(
          'div',
          { class: `channel-row${used.has(ch.index) ? ' used' : ''}` },
          h('span', { class: 'ch-num' }, String(ch.index + 1)),
          h('span', { class: 'ch-label' }, ch.label),
          meter.el,
          isRight
            ? h('span', { class: 'ch-action' })
            : h(
                'button',
                {
                  class: 'small ch-action',
                  title: stereoLeft ? 'Add a stereo track for this pair' : 'Add a mono track for this input',
                  onclick: () => {
                    const name = ch.label.replace(/ L$/, '');
                    store.edit((p) => addTrack(p, { name, inputChannels: stereoLeft ? [ch.index, ch.index + 1] : [ch.index], armed: true }));
                    toast(`Track "${name}" added`);
                  },
                },
                stereoLeft ? '+ stereo track' : '+ track',
              ),
        ),
      );
    }
    card.append(list);
    return card;
  }

  private renderCurrentEpisode(): HTMLElement {
    const p = store.project;
    const clips = p.tracks.reduce((n, t) => n + t.clips.length, 0);
    const save = store.saveState;
    const status =
      save.state === 'error'
        ? h('p', { class: 'error-text' }, `Could not save: ${save.error ?? 'unknown error'}. WavePod keeps trying; File › Save tries again now.`)
        : h('p', { class: 'muted' }, save.state === 'saved' ? 'All changes are saved. WavePod saves every change by itself.' : 'Saving…');
    return h(
      'section',
      { class: 'card project-current' },
      h('div', { class: 'card-head' }, h('h2', null, p.name), h('span', { class: 'muted' }, `${p.tracks.length} track${p.tracks.length === 1 ? '' : 's'} · ${clips} clip${clips === 1 ? '' : 's'}`)),
      h('p', { class: 'muted project-path', title: store.dir }, store.dir),
      status,
      h(
        'div',
        { class: 'row' },
        h('button', { title: 'Save (Ctrl+S)', onclick: () => void saveEpisode() }, 'Save'),
        h('button', { title: 'Save a copy under a new name (Shift+Ctrl+S)', disabled: this.busy, onclick: () => void saveEpisodeAs().then(() => this.refreshProjects()) }, 'Save As…'),
        h('button', { onclick: () => void api().showProjectFolder() }, 'Show folder'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'primary', onclick: () => store.setView('edit') }, 'Continue with this episode'),
      ),
    );
  }

  private renderNewEpisode(): HTMLElement {
    const name = () => this.newName.trim();
    const blank = h(
      'button',
      { class: 'primary', disabled: this.busy || !name(), onclick: () => void this.choose('blank', () => newProject(name())) },
      'Create empty episode',
    ) as HTMLButtonElement;
    const templateBtns: HTMLButtonElement[] = [];
    const input = h('input', {
      class: 'new-episode-name',
      type: 'text',
      value: this.newName,
      spellcheck: false,
      placeholder: 'e.g. Episode 42 – Interview with Anna',
      oninput: (e: Event) => {
        this.newName = (e.target as HTMLInputElement).value;
        blank.disabled = this.busy || !name();
        for (const b of templateBtns) b.disabled = this.busy || !name();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' && name()) void this.choose('blank', () => newProject(name()));
      },
    });
    const list = this.templates.length
      ? h(
          'div',
          { class: 'template-list' },
          ...this.templates.map((t) => {
            const b = h(
              'button',
              {
                class: 'template-use',
                disabled: this.busy || !name(),
                title: 'New episode with this setup',
                onclick: () => void this.choose('template', () => newFromTemplate(t, name())),
              },
              h('span', { class: 'template-title' }, t.name),
              h('span', { class: 'muted' }, `${t.trackCount} track${t.trackCount === 1 ? '' : 's'} · ${t.filterCount} filter${t.filterCount === 1 ? '' : 's'}${t.inputDevice ? ` · ${t.inputDevice}` : ''}`),
            ) as HTMLButtonElement;
            templateBtns.push(b);
            return h('div', { class: 'template-item' }, b);
          }),
        )
      : h('p', { class: 'muted' }, 'No templates yet. Set up an episode the way you like it, then use File › Save as Template….');
    return h(
      'section',
      { class: 'card project-new' },
      h('h2', null, 'Start a new episode'),
      h('label', { class: 'field' }, h('span', null, 'Name (also the name of the episode’s folder)'), input),
      h('div', { class: 'row' }, blank, h('span', { class: 'muted' }, 'or start from a template:')),
      list,
    );
  }

  private renderOpenEpisode(): HTMLElement {
    const others = this.recent.filter((r) => r.dir !== store.dir);
    const fmt = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    return h(
      'section',
      { class: 'card project-open' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, 'Open an episode'),
        h('button', { disabled: this.busy, onclick: () => void this.choose('opened', () => openProject()) }, 'Open folder…'),
      ),
      others.length
        ? h(
            'div',
            { class: 'recent-list' },
            ...others.map((r) =>
              h(
                'button',
                { class: 'recent-item', disabled: this.busy, title: r.dir, onclick: () => void this.choose('opened', () => openProjectAt(r.dir)) },
                h('span', { class: 'template-title' }, r.name),
                h('span', { class: 'muted' }, `Saved ${fmt(r.modified)}`),
              ),
            ),
          )
        : h('p', { class: 'muted' }, 'No other episodes in the WavePod folder yet.'),
    );
  }

  private renderTemplates(): HTMLElement {
    return h(
      'section',
      { class: 'card' },
      h('h2', null, 'Episode templates'),
      h('p', { class: 'muted' }, 'Reuse the same tracks, input channels, filters and soundboard for every episode. Recordings are not included.'),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => this.onTemplates?.start() }, 'New episode from template…'),
        h('button', { disabled: !store.project.tracks.length, onclick: () => this.onTemplates?.save() }, 'Save this setup as a template…'),
      ),
    );
  }

  updateMeters(): void {
    const peaks = store.meterHold;
    const raw = store.transport.inputPeaks;
    this.meterEls.forEach((m, i) => m?.update(peaks[i] ?? 0, raw[i] ?? 0));
  }
}
