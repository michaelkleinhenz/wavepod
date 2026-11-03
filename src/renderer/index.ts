// App shell: header with views and transport, view switching, keyboard shortcuts, engine events.
import { FxPanel } from './fxPanel';
import { MASTER } from '../core/fx/stack';
import { formatTimestamp } from '../shared/time';
import { toDb } from '../core/dsp';
import { projectLength } from '../core/project';
import { append, h, isTyping, toast } from './dom';
import {
  coughDown,
  coughTrackForKey,
  coughUp,
  deleteSelection,
  releaseAllCoughs,
  dropMarker,
  importAudioFiles,
  importChapterFile,
  muteSelection,
  rippleCut,
  newProject,
  openProject,
  prepareForEditing,
  seek,
  splitAtPlayhead,
  stop,
  syncLoop,
  togglePlay,
  toggleRecord,
  toggleRepeat,
} from './actions';
import { ChaptersView } from './chaptersView';
import { ExportDialog } from './exportDialog';
import { LoudnessDialog, normalizeClips } from './loudnessDialog';
import { iconButton } from './icons';
import { midi } from './midi';
import { SetupView } from './setupView';
import { TemplateDialog } from './templateDialog';
import { Soundboard } from './soundboard';
import { api, store, type View } from './store';
import { TimelineView } from './timelineView';

const METER_DECAY = 0.85;

/** When Ctrl+X/Y was last handled by the keydown handler, so the menu accelerator doesn't repeat it. */
let editKeyAt = 0;

/** True if a text field has focus or a dialog is open, so Ctrl+X/Y keep their usual meaning. */
function typingInField(): boolean {
  if (document.querySelector('.overlay')) return true;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'color'].includes((el as HTMLInputElement).type);
}

async function main(): Promise<void> {
  const root = document.getElementById('app')!;
  const setup = new SetupView();
  const soundboard = new Soundboard();
  const timeline = new TimelineView(soundboard.el);
  const chapters = new ChaptersView();
  const exportDialog = new ExportDialog();
  const loudnessDialog = new LoudnessDialog();
  const fxPanel = new FxPanel();
  const templates = new TemplateDialog();
  setup.onTemplates = { start: () => void templates.openNew(), save: () => void templates.openSave() };
  timeline.onOpenFx = (trackId) => fxPanel.toggle(trackId);
  timeline.onOpenLoudness = () => loudnessDialog.open();

  // ---------------------------------------------------------------- header
  const tabs: Record<View, HTMLButtonElement> = {
    setup: h('button', { class: 'tab', onclick: () => store.setView('setup') }, 'Setup'),
    edit: h('button', { class: 'tab', onclick: () => store.setView('edit') }, 'Record & Edit'),
    chapters: h('button', { class: 'tab', onclick: () => store.setView('chapters') }, 'Chapters'),
  };
  const timeEl = h('div', { class: 'time-display' }, '00:00:00.000');
  const recBtn = h('button', { class: 'transport rec', title: 'Record (R)', onclick: () => void toggleRecord() }, '●');
  const playBtn = h('button', { class: 'transport play', title: 'Play / Stop (Space)', onclick: () => void togglePlay() }, '▶');
  const stopBtn = h('button', { class: 'transport', title: 'Stop', onclick: () => void stop() }, '■');
  const repeatBtn = iconButton('repeat', { label: 'Repeat', shortcut: 'L', detail: 'Loop playback of the selected time range' }, toggleRepeat, 'transport repeat');
  const homeBtn = h('button', { class: 'transport', title: 'To start (Home)', onclick: () => seek(0) }, '⏮');
  const masterL = h('div', { class: 'meter-fill' });
  const masterR = h('div', { class: 'meter-fill' });
  const projectName = h('div', { class: 'project-name', title: 'Project folder' });
  const masterFxBtn = h('button', { class: 'fx-btn', title: 'Filters on the master bus', onclick: () => fxPanel.toggle(MASTER) }, 'Master FX');
  const header = h(
    'header',
    null,
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◉'), ' WavePod'),
    h('nav', null, tabs.setup, tabs.edit, tabs.chapters),
    h('div', { class: 'transport-group' }, homeBtn, stopBtn, playBtn, recBtn, repeatBtn, timeEl),
    h('div', { class: 'master-meter', title: 'Output level' }, h('div', { class: 'meter' }, masterL), h('div', { class: 'meter' }, masterR)),
    masterFxBtn,
    h('div', { class: 'spacer' }),
    projectName,
    h('button', { class: 'primary', title: 'Export (Ctrl+E)', onclick: () => exportDialog.open() }, 'Export…'),
  );
  const statusBar = h('footer', { class: 'statusbar' });
  const main = h('main');
  root.append(header, main, statusBar);

  // ---------------------------------------------------------------- render
  const renderView = () => {
    for (const [k, b] of Object.entries(tabs)) b.classList.toggle('active', k === store.view);
    main.replaceChildren(store.view === 'setup' ? setup.el : store.view === 'chapters' ? chapters.el : timeline.el);
    if (store.view === 'setup') setup.render();
    if (store.view === 'chapters') chapters.render();
    if (store.view === 'edit') timeline.renderHeaders();
  };

  const renderStatus = () => {
    const s = store.status;
    const t = store.transport;
    const len = projectLength(store.project) / store.sampleRate;
    statusBar.replaceChildren();
    append(statusBar, [
      h('span', null, s ? `${s.backend}${s.backendError ? ' (virtual)' : ''}` : '…'),
      h('span', null, s ? `${s.config.sampleRate / 1000} kHz · ${s.config.bufferSize} buf` : ''),
      h('span', null, s?.inputOpen ? `${s.inputChannelCount} inputs` : 'no input'),
      h('span', null, `${store.project.tracks.filter((x) => x.armed).length} armed`),
      h('span', null, `Length ${formatTimestamp(len, false)}`),
      t.state === 'recording' ? h('span', { class: 'rec-indicator' }, `● REC ${formatTimestamp(t.recordedFrames / store.sampleRate, false)}`) : null,
      s?.error ? h('span', { class: 'error-text' }, s.error.split('\n')[0]) : null,
    ]);
    projectName.textContent = store.project.name;
    projectName.title = store.dir;
  };

  const renderTransport = () => {
    const t = store.transport;
    timeEl.textContent = formatTimestamp(t.position / store.sampleRate);
    recBtn.classList.toggle('on', t.state === 'recording');
    playBtn.classList.toggle('on', t.state === 'playing');
    playBtn.textContent = t.state === 'playing' ? '❚❚' : '▶';
    repeatBtn.classList.toggle('on', store.repeat);
    repeatBtn.setAttribute('aria-pressed', String(store.repeat));
    for (const [el, v] of [
      [masterL, t.outputPeaks[0] ?? 0],
      [masterR, t.outputPeaks[1] ?? 0],
    ] as const) {
      const db = toDb(v, -60);
      el.style.width = `${((db + 60) / 60) * 100}%`;
      el.classList.toggle('hot', db > -6);
      el.classList.toggle('clip', db > -0.5);
    }
  };

  store.subscribe((kinds) => {
    if (kinds.has('view')) renderView();
    if (kinds.has('project')) {
      fxPanel.refresh();
      const n = (store.project.masterFx ?? []).filter((f) => f.enabled).length;
      masterFxBtn.textContent = n ? `Master FX ${n}` : 'Master FX';
      masterFxBtn.classList.toggle('active', n > 0);
      masterFxBtn.classList.toggle('open', fxPanel.target === MASTER);
      if (store.view === 'edit') timeline.renderHeaders();
      if (store.view === 'chapters') chapters.render();
      if (store.view === 'setup') setup.render();
      soundboard.render();
      void soundboard.ensureLoaded();
    }
    if (kinds.has('devices') || kinds.has('status') || kinds.has('midi') || kinds.has('mcp')) {
      if (store.view === 'setup') setup.render();
      if (store.view === 'edit') timeline.renderHeaders();
    }
    if (kinds.has('selection') || kinds.has('project')) syncLoop();
    if (kinds.has('selection') && store.view === 'chapters') chapters.render();
    if (kinds.has('transport')) {
      renderTransport();
      timeline.follow();
      if (store.view === 'edit') timeline.updateMeters();
      soundboard.updatePlaying(store.transport.jingles);
      fxPanel.updateMeters(store.transport.fxMeters);
      if (store.view === 'setup') setup.updateMeters();
    }
    if (store.view === 'edit') timeline.draw();
    renderStatus();
  });

  // ---------------------------------------------------------------- engine events
  api().onTransport((u) => {
    const hold = store.meterHold;
    for (let i = 0; i < u.inputPeaks.length; i++) hold[i] = Math.max(u.inputPeaks[i], (hold[i] ?? 0) * METER_DECAY);
    hold.length = u.inputPeaks.length;
    const trackHold = store.trackMeterHold;
    for (const t of store.project?.tracks ?? []) {
      const v = Math.max(u.trackPeaks?.[t.id] ?? 0, (trackHold.get(t.id) ?? 0) * METER_DECAY);
      if (v > 1e-4) trackHold.set(t.id, v);
      else trackHold.delete(t.id);
    }
    if (u.state === 'recording' && store.transport.state !== 'recording') {
      store.recordStart = u.position;
      store.livePeaks.clear();
    }
    if (u.recordingPeaks) store.addLivePeaks(u.recordingPeaks);
    store.transport = u;
    store.notify('transport');
  });
  api().onStatus((s) => {
    store.status = s;
    store.notify('status');
  });
  api().onRecordingFinished(({ takes, project, preparedForEditing }) => {
    store.history.push(store.project);
    store.setProject(project);
    const recorded = `Recorded ${takes.length} take${takes.length === 1 ? '' : 's'}`;
    if (preparedForEditing) toast(`${recorded} · tracks unarmed for editing`);
    // Ultraschall's soundcheck reminds you of this too: armed tracks make R start a new take mid-edit.
    else if (project.tracks.some((t) => t.armed)) toast(`${recorded} · tracks are still armed, use Prepare for editing before you cut`);
    else toast(recorded);
  });
  api().onProjectEdited(({ project, summary }) => {
    store.applyExternal(project);
    toast(`AI agent: ${summary}`);
  });
  api().onMenu((cmd) => {
    switch (cmd) {
      case 'new-project': return void newProject();
      case 'open-project': return void openProject();
      case 'new-from-template': return void templates.openNew();
      case 'save-template': return void templates.openSave();
      case 'show-templates-folder': return void api().showTemplatesFolder();
      case 'import-audio': return void importAudioFiles();
      case 'import-chapters': return void importChapterFile();
      case 'export': return exportDialog.open();
      case 'undo': return store.undo();
      case 'ripple-cut':
        if (typingInField()) return void document.execCommand('cut');
        return void (Date.now() - editKeyAt > 500 && rippleCut());
      case 'mute-selection':
        return void (!typingInField() && Date.now() - editKeyAt > 500 && muteSelection());
      case 'normalize-clips':
        return void (!document.querySelector('.overlay') && normalizeClips([...store.selection.clipIds]));
      case 'loudness-analysis':
        return void (!document.querySelector('.overlay') && loudnessDialog.open());
      case 'prepare-for-editing': return prepareForEditing();
      case 'redo': return store.redo();
      case 'view-setup': return store.setView('setup');
      case 'view-edit': return store.setView('edit');
      case 'view-chapters': return store.setView('chapters');
      case 'show-project-folder': return void api().showProjectFolder();
    }
  });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || document.querySelector('.overlay')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.code === 'KeyX' || e.code === 'KeyY')) {
      // handled here as well as in the Edit menu, whichever sees the key first
      e.preventDefault();
      editKeyAt = Date.now();
      if (e.code === 'KeyX') rippleCut();
      else muteSelection();
      return;
    }
    if (mod) return; // menu accelerators
    const cough = /^Digit([1-9])$/.exec(e.code);
    if (cough && e.shiftKey) {
      e.preventDefault();
      const id = coughTrackForKey(Number(cough[1]));
      if (id && !e.repeat) coughDown(id);
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        void togglePlay();
        break;
      case 'r':
      case 'R':
        void toggleRecord();
        break;
      case 'l':
      case 'L':
        toggleRepeat();
        break;
      case 'm':
      case 'M':
        dropMarker('chapter');
        break;
      case 'e':
      case 'E':
        dropMarker('edit');
        break;
      case 's':
      case 'S':
        splitAtPlayhead();
        break;
      case 'f':
      case 'F':
        timeline.fadeSelected();
        break;
      case 'Delete':
      case 'Backspace':
        deleteSelection(e.shiftKey);
        break;
      case 'Home':
        seek(0);
        break;
      case 'End':
        seek(projectLength(store.project));
        break;
      case 'ArrowLeft':
        seek(store.transport.position - store.sampleRate * (e.shiftKey ? 10 : 1));
        break;
      case 'ArrowRight':
        seek(store.transport.position + store.sampleRate * (e.shiftKey ? 10 : 1));
        break;
      case '+':
      case '=':
        timeline.zoomAtPlayhead(1.5);
        break;
      case '-':
        timeline.zoomAtPlayhead(1 / 1.5);
        break;
      case 'Escape':
        if (midi.learning) return midi.learn(null);
        void api().stopSounds();
        store.select({ clipIds: new Set(), range: null, rangeTracks: null, markerId: null });
        break;
      default:
        if (/^[1-9]$/.test(e.key)) void soundboard.trigger(Number(e.key) - 1);
        return;
    }
  });

  window.addEventListener('keyup', (e) => {
    const cough = /^Digit([1-9])$/.exec(e.code);
    if (!cough) return;
    const id = coughTrackForKey(Number(cough[1]));
    if (id) coughUp(id);
  });
  window.addEventListener('blur', releaseAllCoughs);

  // ---------------------------------------------------------------- boot
  const opened = await api().currentProject();
  store.setProject(opened.project, opened.dir);
  store.status = await api().getStatus();
  await setup.refreshDevices();
  if (!store.project.tracks.length) store.view = 'setup';
  renderView();
  renderTransport();
  soundboard.render();
  void soundboard.ensureLoaded();
  await midi.init();
}

window.addEventListener('error', (e) => toast(e.message, 'error'));
window.addEventListener('unhandledrejection', (e) => toast(String((e.reason as Error)?.message ?? e.reason), 'error'));
void main();
