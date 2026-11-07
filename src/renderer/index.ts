// App shell: header with views and transport, view switching, keyboard shortcuts, engine events.
import { FxPanel } from './fxPanel';
import { MASTER, clipTarget } from '../core/fx/stack';
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
  importZencastrSession,
  importChapterFile,
  muteSelection,
  rippleCut,
  newProject,
  saveEpisode,
  saveEpisodeAs,
  openProject,
  prepareForEditing,
  seek,
  splitAtPlayhead,
  stop,
  syncLoop,
  togglePlay,
  toggleRecord,
  dropNamedChapter,
  jumpToRecordPosition,
  restoreBackup,
  checkPreview,
  previewCut,
  stepPlayhead,
  copySelection,
  selectAllClips,
  pasteClipboard,
  toggleRepeat,
  loopRecordSelection,
  cycleTakes,
  setSpeed,
  stepPlaybackSpeed,
} from './actions';
import { ChaptersView } from './chaptersView';
import { resetAllMeters } from './levelMeter';
import { PLAYBACK_SPEEDS, speedLabel } from '../core/timeStretch';
import { selectionSpan } from '../core/navigation';
import { ExportDialog } from './exportDialog';
import { LoudnessDialog, normalizeClips } from './loudnessDialog';
import { iconButton, setIcon } from './icons';
import { MenuBar } from './menuBar';
import { midi } from './midi';
import { SetupView } from './setupView';
import { TemplateDialog } from './templateDialog';
import { Soundboard } from './soundboard';
import { api, store, type View } from './store';
import { showShortcuts } from './shortcuts';
import { openContextHelp } from './help';
import { showAbout } from './aboutDialog';
import { showBetaNotice, showBetaNoticeOnFirstStart } from './betaNotice';
import { remoteHooks, runRemote } from './remote';
import { AuphonicDialog } from './auphonicDialog';
import { TimelineView } from './timelineView';
import { SettingsDialog } from './settingsDialog';
import { TranscriptPanel } from './transcriptPanel';
import { SoundLibraryPanel } from './soundLibraryPanel';
import { CleanupDialog } from './cleanupDialog';
import { transcripts } from './transcripts';
import { RecordingAlertModal } from './recordingAlert';

function formatDuration(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.max(0, Math.floor(seconds / 60))} min`;
}

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
  const auphonic = new AuphonicDialog();
  const settingsDialog = new SettingsDialog();
  new RecordingAlertModal();
  const transcriptPanel = new TranscriptPanel();
  const cleanupDialog = new CleanupDialog();
  transcriptPanel.onCleanup = () => cleanupDialog.open();
  const libraryPanel = new SoundLibraryPanel();
  // the library and the transcript share the right side: one at a time
  libraryPanel.onOpen = () => transcriptPanel.isOpen && transcriptPanel.close();
  const openLibrary = () => {
    if (store.view !== 'edit') {
      if (!libraryPanel.isOpen) libraryPanel.toggle();
      store.setView('edit');
    } else libraryPanel.toggle();
  };
  window.addEventListener('wavepod:open-settings', () => void settingsDialog.open());
  // the transcript panel only shows in the edit view; from another view its button takes the user there
  const openTranscript = () => {
    if (!transcriptPanel.isOpen && libraryPanel.isOpen) libraryPanel.close();
    if (store.view !== 'edit') {
      if (!transcriptPanel.isOpen) transcriptPanel.toggle();
      store.setView('edit');
    } else transcriptPanel.toggle();
  };
  // An empty episode needs its speakers set up next; an opened one or a template is ready to record.
  setup.onEpisodeChosen = (how) => (how === 'blank' ? setup.showTab('audio') : store.setView('edit'));
  timeline.onOpenFx = (trackId) => fxPanel.toggle(trackId);
  timeline.onOpenClipFx = (clipId) => fxPanel.toggle(clipTarget(clipId));
  timeline.isClipFxOpen = (clipId) => fxPanel.target === clipTarget(clipId);
  timeline.onOpenLoudness = () => loudnessDialog.open();

  // ---------------------------------------------------------------- header
  const tabs: Record<View, HTMLButtonElement> = {
    setup: h('button', { class: 'tab', onclick: () => store.setView('setup') }, 'Setup'),
    edit: h('button', { class: 'tab', onclick: () => store.setView('edit') }, 'Record & Edit'),
    chapters: h('button', { class: 'tab', onclick: () => store.setView('chapters') }, 'Chapters'),
  };
  const timeEl = h('span', null, '00:00:00.000');
  const recBtn = iconButton('record', { label: 'Record', shortcut: 'R' }, () => void toggleRecord(), 'transport rec');
  const playBtn = iconButton('play', { label: 'Play / Pause', shortcut: 'Space' }, () => void togglePlay(), 'transport play');
  const stopBtn = iconButton('stop', { label: 'Stop' }, () => void stop(), 'transport');
  const repeatBtn = iconButton('repeat', { label: 'Repeat', shortcut: 'L', detail: 'Loop playback of the selected time range' }, toggleRepeat, 'transport repeat');
  const homeBtn = iconButton('toStart', { label: 'To start', shortcut: 'Home' }, () => seek(0), 'transport');
  // listening speed (pitch kept); playback only, remembered on this computer
  const speedSel = h(
    'select',
    {
      class: 'speed-select',
      title: 'Playback speed, to check a recording faster (pitch kept). Faster / slower: > and <. Recording and export always run at 1×.',
      'aria-label': 'Playback speed',
      onchange: (e: Event) => setSpeed(Number((e.target as HTMLSelectElement).value)),
    },
    ...PLAYBACK_SPEEDS.map((v) => h('option', { value: String(v), selected: v === store.speed }, speedLabel(v))),
  ) as HTMLSelectElement;
  void api().setPlaybackSpeed(store.speed);
  const masterL = h('div', { class: 'meter-fill' });
  const masterR = h('div', { class: 'meter-fill' });
  const projectName = h('div', { class: 'project-name', title: 'Project folder' });
  // Saved status: green when project.json holds every change, amber while a change waits for the autosave, red if saving failed.
  const saveDot = h('button', { class: 'save-dot saved', 'aria-label': 'All changes saved', onclick: () => void saveEpisode() });
  const renderSaveDot = () => {
    const s = store.saveState;
    saveDot.className = `save-dot ${s.state}`;
    const text =
      s.state === 'saved'
        ? 'All changes saved'
        : s.state === 'unsaved'
          ? 'Saving…'
          : `Could not save: ${s.error ?? 'unknown error'}. Click to try again.`;
    saveDot.title = `${text}\n${store.dir}`;
    saveDot.setAttribute('aria-label', text);
  };
  const masterFxBtn = h(
    'button',
    {
      class: 'fx-btn',
      title: 'Filters on the master bus',
      onclick: () => {
        // The panel only shows in the edit view; from another view the button takes the user there.
        if (store.view === 'edit') return fxPanel.toggle(MASTER);
        fxPanel.open(MASTER);
        store.setView('edit');
      },
    },
    'Master FX',
  );
  const transcriptBtn = h('button', { class: 'fx-btn transcript-btn', title: 'Transcript: the episode as text; cut by deleting words (Shift+Ctrl+T)', onclick: () => openTranscript() }, 'Transcript');
  // transcribing goes on with the panel closed: the button spins meanwhile
  transcripts().subscribe(() => {
    transcriptBtn.classList.toggle('busy', transcripts().busy);
    transcriptBtn.title = transcripts().busy ? 'Transcribing… (it goes on with the transcript closed)' : 'Transcript: the episode as text; cut by deleting words (Shift+Ctrl+T)';
  });
  const libraryBtn = h('button', { class: 'fx-btn library-btn', title: 'Sound library: search your sound effects, listen and insert them (Shift+Ctrl+B)', onclick: () => openLibrary() }, 'Sounds');
  const preShowBtn = h(
    'button',
    {
      class: 'fx-btn preshow-btn',
      title: 'Pre-show: only the soundboard is heard (waiting music before the show); the episode playback is silent. Click again for Show.',
      onclick: () => void api().setPreShow(!store.status?.preShow),
    },
    'Pre-show',
  );
  const header = h(
    'header',
    null,
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, '◉'), ' WavePod'),
    h('nav', null, tabs.setup, tabs.edit, tabs.chapters),
    h(
      'div',
      { class: 'transport-group' },
      homeBtn,
      stopBtn,
      playBtn,
      recBtn,
      repeatBtn,
      // The output meter sits inside the time display, so the header has no empty strip while it is silent.
      h(
        'div',
        { class: 'time-display' },
        timeEl,
        h('div', { class: 'master-meter', title: 'Output level' }, h('div', { class: 'meter' }, masterL), h('div', { class: 'meter' }, masterR)),
      ),
      speedSel,
    ),
    masterFxBtn,
    transcriptBtn,
    libraryBtn,
    preShowBtn,
    h('div', { class: 'spacer' }),
    projectName,
    h('button', { class: 'primary', title: 'Export (Ctrl+E)', onclick: () => exportDialog.open() }, 'Export…'),
    saveDot,
  );
  const statusBar = h('footer', { class: 'statusbar' });
  // Live problems of the running take (dropouts, crackle, clipping, a stalled input, disk).
  const healthBar = h('div', { class: 'rec-health', role: 'status', 'aria-live': 'polite' });
  const main = h('main');
  root.append(new MenuBar().el, header, healthBar, main, statusBar);
  // side panels (FX, transcript, sound library) start below the menu bar and header, whatever their height
  const placePanels = () => document.documentElement.style.setProperty('--panel-top', `${Math.round(main.getBoundingClientRect().top)}px`);
  new ResizeObserver(placePanels).observe(header);
  new ResizeObserver(placePanels).observe(healthBar);
  window.addEventListener('resize', placePanels);
  placePanels();
  let healthShown = '';
  const renderHealth = () => {
    const t = store.transport;
    const warnings = t.state === 'recording' ? t.health?.warnings ?? [] : [];
    const key = warnings.map((w) => `${w.level}:${w.text}`).join('|');
    if (key === healthShown) return;
    healthShown = key;
    healthBar.classList.toggle('show', warnings.length > 0);
    healthBar.classList.toggle('critical', warnings.some((w) => w.level === 'critical'));
    healthBar.replaceChildren(...warnings.map((w) => h('div', { class: `rec-warning ${w.level}` }, h('span', { class: 'rec-warning-icon' }, w.level === 'critical' ? '⛔' : '⚠'), ` ${w.text}`)));
  };

  // ---------------------------------------------------------------- render
  const renderView = () => {
    for (const [k, b] of Object.entries(tabs)) b.classList.toggle('active', k === store.view);
    main.replaceChildren(store.view === 'setup' ? setup.el : store.view === 'chapters' ? chapters.el : timeline.el);
    if (store.view === 'setup') {
      setup.render();
      void setup.refreshProjects();
    }
    if (store.view === 'chapters') chapters.render();
    if (store.view === 'edit') timeline.renderHeaders();
    fxPanel.setHidden(store.view !== 'edit');
    transcriptPanel.setHidden(store.view !== 'edit');
    libraryPanel.setHidden(store.view !== 'edit');
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
      t.state === 'recording' && t.health?.diskSecondsLeft != null
        ? h('span', { class: t.health.diskSecondsLeft < 1800 ? 'warning' : '', title: 'Recording time the disk still has room for' }, `Disk: ${formatDuration(t.health.diskSecondsLeft)} left`)
        : null,
      t.state === 'recording' && t.health?.problems
        ? h('span', { class: 'warning', title: 'Marked with edit markers when the take stops' }, `${t.health.problems} problem${t.health.problems === 1 ? '' : 's'} found`)
        : null,
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
    setIcon(playBtn, t.state === 'playing' ? 'pause' : 'play');
    repeatBtn.classList.toggle('on', store.repeat);
    repeatBtn.setAttribute('aria-pressed', String(store.repeat));
    if (speedSel.value !== String(store.speed)) speedSel.value = String(store.speed);
    speedSel.classList.toggle('fast', store.speed !== 1);
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
    if (kinds.has('save') || kinds.has('project')) renderSaveDot();
    if (kinds.has('save') && store.view === 'setup') setup.render();
    if (kinds.has('project') || kinds.has('selection')) transcriptPanel.refresh();
    if (kinds.has('project')) libraryPanel.refresh();
    if (kinds.has('project')) {
      void transcripts().ensureLoaded();
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
    if (kinds.has('devices') || kinds.has('status') || kinds.has('midi') || kinds.has('mcp') || kinds.has('osc')) {
      if (store.view === 'setup') setup.render();
      if (store.view === 'edit') timeline.renderHeaders();
    }
    if (kinds.has('selection') || kinds.has('project')) syncLoop();
    if (kinds.has('selection') && store.view === 'chapters') chapters.render();
    if (kinds.has('transport')) {
      renderTransport();
      renderHealth();
      timeline.follow();
      if (store.view === 'edit') timeline.updateMeters();
      soundboard.updatePlaying(store.transport.jingles);
      fxPanel.updateMeters(store.transport.fxMeters);
      transcriptPanel.updatePosition();
      libraryPanel.updatePreview();
      if (store.view === 'setup') setup.updateMeters();
    }
    if (store.view === 'edit') timeline.draw();
    renderStatus();
  });

  // ---------------------------------------------------------------- engine events
  api().onTransport((u) => {
    // updates can arrive before the episode has loaded at startup
    if (!store.project) return;
    const hold = store.meterHold;
    for (let i = 0; i < u.inputPeaks.length; i++) hold[i] = Math.max(u.inputPeaks[i], (hold[i] ?? 0) * METER_DECAY);
    hold.length = u.inputPeaks.length;
    const trackHold = store.trackMeterHold;
    for (const t of store.project?.tracks ?? []) {
      const v = Math.max(u.trackPeaks?.[t.id] ?? 0, (trackHold.get(t.id) ?? 0) * METER_DECAY);
      if (v > 1e-4) trackHold.set(t.id, v);
      else trackHold.delete(t.id);
    }
    if (u.state === 'recording') store.recordPosition = u.position;
    if (u.state === 'recording' && store.transport.state !== 'recording') {
      // a new take starts with clean peak numbers and clip lights
      resetAllMeters();
      store.recordStart = u.position;
      store.livePeaks.clear();
    }
    if (u.recordingPeaks) store.addLivePeaks(u.recordingPeaks);
    store.transport = u;
    checkPreview();
    store.notify('transport');
  });
  api().onStatus((s) => {
    store.status = s;
    if (store.project) store.notify('status');
  });
  store.subscribe((kinds) => {
    if (kinds.has('status')) preShowBtn.classList.toggle('on', !!store.status?.preShow);
  });
  api().onRecordingFinished(({ takes, project, preparedForEditing, problems }) => {
    store.history.push(store.project);
    store.setProject(project);
    if (problems) {
      toast(`Recorded ${takes.length} take${takes.length === 1 ? '' : 's'} · ${problems} recording problem${problems === 1 ? '' : 's'} marked with ⚠ edit markers: listen to those spots`, 'error');
      return;
    }
    const recorded = `Recorded ${takes.length} take${takes.length === 1 ? '' : 's'}`;
    if (preparedForEditing) toast(`${recorded} · tracks unarmed for editing`);
    // Ultraschall's soundcheck reminds you of this too: armed tracks make R start a new take mid-edit.
    else if (project.tracks.some((t) => t.armed)) toast(`${recorded} · tracks are still armed, use Prepare for editing before you cut`);
    else toast(recorded);
  });
  api().onSaveState((s) => {
    store.saveState = s;
    store.notify('save');
  });
  api().onProjectEdited(({ project, summary }) => {
    store.applyExternal(project);
    toast(`AI agent: ${summary}`);
  });
  remoteHooks.playSound = (i) => void soundboard.trigger(i);
  api().onRemote(runRemote);

  api().onMenu((cmd) => {
    switch (cmd) {
      case 'new-project': return void newProject();
      case 'open-project': return void openProject().then((ok) => ok && store.setView('edit'));
      case 'save': return void saveEpisode();
      case 'save-as': return void saveEpisodeAs();
      case 'new-from-template': return void templates.openNew();
      case 'save-template': return void templates.openSave();
      case 'show-templates-folder': return void api().showTemplatesFolder();
      case 'import-audio': return void importAudioFiles();
      case 'import-chapters': return void importChapterFile();
      case 'import-zencastr': return void importZencastrSession();
      case 'export': return exportDialog.open();
      case 'undo': return store.undo();
      case 'ripple-cut':
        if (typingInField()) return void document.execCommand('cut');
        return void (Date.now() - editKeyAt > 500 && rippleCut());
      case 'copy':
        if (typingInField()) return void document.execCommand('copy');
        return void (Date.now() - editKeyAt > 500 && copySelection());
      case 'paste':
      case 'paste-ripple':
        if (typingInField()) return void document.execCommand('paste');
        return void (Date.now() - editKeyAt > 500 && pasteClipboard(cmd === 'paste-ripple'));
      case 'select-all':
        if (typingInField()) return void document.execCommand('selectAll');
        return void (Date.now() - editKeyAt > 500 && selectAllClips());
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
      case 'restore-backup': return void restoreBackup();
      case 'shortcuts': return showShortcuts();
      case 'help': return openContextHelp();
      case 'about': return void showAbout();
      case 'beta-notice': return void showBetaNotice();
      case 'speed-up': return stepPlaybackSpeed(1);
      case 'speed-down': return stepPlaybackSpeed(-1);
      case 'speed-normal': return setSpeed(1, true);
      case 'auphonic': return void auphonic.open();
      case 'settings': return void settingsDialog.open();
      case 'transcript': return openTranscript();
      case 'sound-library': return openLibrary();
      case 'transcribe':
        if (!transcriptPanel.isOpen) openTranscript();
        return void transcripts().transcribe();
      case 'cleanup': return void (!document.querySelector('.overlay') && cleanupDialog.open());
      case 'loop-record': return void loopRecordSelection();
      case 'next-take': return cycleTakes(1);
      case 'previous-take': return cycleTakes(-1);
    }
  });

  // ---------------------------------------------------------------- keyboard
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || document.querySelector('.overlay')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && (e.code === 'KeyX' || e.code === 'KeyY' || e.code === 'KeyC' || e.code === 'KeyV')) {
      // handled here as well as in the Edit menu, whichever sees the key first
      e.preventDefault();
      editKeyAt = Date.now();
      if (e.code === 'KeyX') rippleCut();
      else if (e.code === 'KeyY') muteSelection();
      else if (e.code === 'KeyC') copySelection();
      else pasteClipboard(false);
      return;
    }
    if (mod && e.shiftKey && !e.altKey && e.code === 'KeyV') {
      e.preventDefault();
      editKeyAt = Date.now();
      pasteClipboard(true);
      return;
    }
    if (mod && !e.shiftKey && !e.altKey && e.code === 'KeyA') {
      e.preventDefault();
      editKeyAt = Date.now();
      selectAllClips();
      return;
    }
    if (mod) return; // menu accelerators
    if (e.key === '?') {
      e.preventDefault();
      showShortcuts();
      return;
    }
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
        void (e.shiftKey && store.transport.state !== 'recording' ? loopRecordSelection() : toggleRecord());
        break;
      case 't':
      case 'T':
        cycleTakes(e.shiftKey ? -1 : 1);
        break;
      case 'l':
      case 'L':
        toggleRepeat();
        break;
      case 'm':
      case 'M':
        if (e.shiftKey) {
          e.preventDefault(); // keep the M out of the title field that opens
          dropNamedChapter();
        } else dropMarker('chapter');
        break;
      case 'y':
      case 'Y':
        jumpToRecordPosition((pos) => {
          store.setView('edit');
          timeline.reveal(pos);
        });
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
      case 'ArrowRight': {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        e.preventDefault();
        if (e.altKey) {
          // Alt: clip edges; Shift+Alt: markers
          const pos = stepPlayhead(e.shiftKey ? 'marker' : 'edge', dir);
          if (pos !== null) timeline.ensureVisible(pos);
        } else seek(store.transport.position + dir * store.sampleRate * (e.shiftKey ? 10 : 1));
        break;
      }
      case '>':
        stepPlaybackSpeed(1);
        break;
      case '<':
        stepPlaybackSpeed(-1);
        break;
      case 'p':
      case 'P':
        void previewCut();
        break;
      case 'z':
      case 'Z':
        if (e.shiftKey && !timeline.toggleZoomToSelection(selectionSpan(store.project, store.selection.range, store.selection.clipIds))) {
          toast('Select a range or clips to zoom to');
        }
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
  store.saveState = await api().getSaveState();
  store.status = await api().getStatus();
  await setup.refreshDevices();
  // The app starts on Setup › Project: continue the last episode, open another or start a new one.
  store.view = 'setup';
  setup.showTab('project');
  void setup.refreshProjects();
  renderView();
  renderSaveDot();
  renderTransport();
  soundboard.render();
  void soundboard.ensureLoaded();
  // first start: the beta warning (backup recording!) before anything else
  void showBetaNoticeOnFirstStart();
  await midi.init();
}

window.addEventListener('error', (e) => toast(e.message, 'error'));
window.addEventListener('unhandledrejection', (e) => toast(String((e.reason as Error)?.message ?? e.reason), 'error'));
void main();
