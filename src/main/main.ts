import { BrowserWindow, Menu, app, dialog, ipcMain, shell, type MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { IPC, type InvokeMethod, type MenuCommand, type OpenedProject } from '../shared/api';
import type { DeviceConfig, ExportOptions, ExportResult, Fx, LoudnessReport, McpSettings, Project, RecordedTake, VstPluginRef } from '../shared/types';
import { addClip, prepareForEditing } from '../core/project';
import { SOUNDBOARD_TRACK_ID, ensureSoundboardTrack } from '../core/soundboard';
import { findProfile } from '../core/deviceProfiles';
import { writeWavFile } from '../core/wav';
import { AudioEngine, defaultConfig } from './audio/engine';
import { RtAudioBackend } from './audio/rtaudioBackend';
import { VstHostProcess, vstHostExecutable } from './vst/host';
import { defaultVstDirs, scanVstPlugins } from './vst/scan';
import { decodeState, setVstHost, type VstInstance } from '../core/fx/vst';
import { BACKUP_DIR, backupProject, createProjectDir, importImage, isProjectDir, loadBackup, loadProject, saveProject } from './projectStore';
import { createProjectFromTemplate, deleteTemplate, listTemplates, saveTemplate } from './templateStore';
import { normalizeMidiSettings, type MidiSettings } from '../core/midi';
import { migrateUserData, resolveProjectsRoot } from './legacyPaths';
import { createWavePodServer, type WavePodHost } from '../core/mcp/tools';
import { McpController, normalizeMcpSettings } from './mcp/controller';

// Carry settings over from the SoundPod era before anything reads userData.
migrateUserData(app.getPath('appData'), app.getPath('userData'));

interface Settings {
  device: DeviceConfig;
  lastProject: string | null;
  /** MIDI controller mappings; app-wide so the same controller works in every episode. */
  midi: MidiSettings;
  /** Unarm all tracks when a recording stops (off by default, as in Ultraschall where it is a manual step). */
  prepareForEditingAfterRecording: boolean;
  /** Ask before stopping a recording (Ultraschall's recording safe mode). */
  confirmStopRecording: boolean;
  /** Local MCP server for AI agents; off unless the user switches it on in Setup. */
  mcp: McpSettings;
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Partial<Settings>;
    return {
      device: { ...defaultConfig(), ...(raw.device ?? {}) },
      lastProject: raw.lastProject ?? null,
      midi: normalizeMidiSettings(raw.midi),
      prepareForEditingAfterRecording: raw.prepareForEditingAfterRecording === true,
      confirmStopRecording: raw.confirmStopRecording !== false,
      mcp: normalizeMcpSettings(raw.mcp),
    };
  } catch {
    return { device: defaultConfig(), lastProject: null, midi: normalizeMidiSettings(null), prepareForEditingAfterRecording: false, confirmStopRecording: true, mcp: normalizeMcpSettings(null) };
  }
}

function saveSettings(): void {
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('could not save settings', e);
  }
}

function projectsRoot(): string {
  return process.env.WAVEPOD_PROJECT_ROOT ?? resolveProjectsRoot(app.getPath('documents'), 'WavePod');
}

function templatesRoot(): string {
  return path.join(projectsRoot(), 'Templates');
}

/** Name of the open input device, stored with a template as a hint for its channel mapping. */
function inputDeviceName(): string | undefined {
  const id = engine.config.inputDeviceId;
  return id === null ? undefined : engine.listDevices().find((d) => d.id === id)?.name;
}

let settings: Settings;
let engine: AudioEngine;
let win: BrowserWindow | null = null;
let current: OpenedProject;
let saveTimer: NodeJS.Timeout | null = null;
let mcp: McpController;

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function openProjectDir(dir: string): OpenedProject {
  const project = loadProject(dir);
  current = { project, dir };
  // the project as opened is what a backup would hold; nothing to back up until it changes
  lastBackup = JSON.stringify(project);
  engine.setProject(project, dir);
  settings.lastProject = dir;
  saveSettings();
  win?.setTitle(`${project.name} — WavePod`);
  return current;
}

function createNewProject(): OpenedProject {
  const { dir } = createProjectDir(projectsRoot(), engine.config.sampleRate);
  return openProjectDir(dir);
}

function flushSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  try {
    saveProject(current.dir, current.project);
  } catch (e) {
    console.error('save failed', e);
  }
}

/** JSON of the project as last backed up, so unchanged projects aren't backed up again. */
let lastBackup = '';
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;

/** Rolling backup of project.json into the project's backup folder (keeps the newest 20). */
function backupNow(reason = ''): void {
  const json = JSON.stringify(current.project);
  if (!reason && json === lastBackup) return;
  try {
    backupProject(current.dir, current.project, reason);
    lastBackup = json;
  } catch (e) {
    console.error('backup failed', e);
  }
}

/** Takes over a project edited in the renderer (or by an agent) and saves it shortly after. */
function setCurrentProject(project: Project): void {
  current.project = project;
  engine.setProject(project);
  win?.setTitle(`${project.name} — WavePod`);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

/** What the MCP tools may do: read the open project and apply edits that the window turns into undo steps. */
const mcpHost: WavePodHost = {
  project: () => current.project,
  dir: () => current.dir,
  transportState: () => engine.transportState,
  apply: (project, summary) => {
    setCurrentProject(project);
    send(IPC.projectEdited, { project, summary });
  },
  measureLoudness: () => handlers.measureLoudness() as Promise<LoudnessReport[]>,
  get vst() {
    const exe = vstExe;
    if (!exe || !vstHost) return null;
    return {
      scan: () => scanVstPlugins(exe, defaultVstDirs(), path.join(app.getPath('userData'), 'vst3-cache.json'), false),
      describe: describeVst,
      format: formatVst,
    };
  },
};

function runWorker<T>(data: unknown, onProgress?: (p: unknown) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'exportWorker.js'), {
      workerData: { ...(data as object), vstExe, vstBridge: path.join(__dirname, 'vstBridge.js') },
    });
    worker.on('message', (msg: { type: string; result?: T; progress?: unknown; message?: string }) => {
      if (msg.type === 'progress') onProgress?.(msg.progress);
      else if (msg.type === 'done') resolve(msg.result as T);
      else if (msg.type === 'error') reject(new Error(msg.message));
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`export worker exited with ${code}`));
    });
  });
}

type Handler = (...args: never[]) => unknown;

const handlers: Record<InvokeMethod, Handler> = {
  getStatus: () => engine.status(),
  listDevices: () => engine.listDevices(),
  applyConfig: (config: Partial<DeviceConfig>) => {
    const status = engine.applyConfig(config);
    settings.device = status.config;
    saveSettings();
    return status;
  },
  getProfile: (deviceId: number) => {
    const dev = engine.listDevices().find((d) => d.id === deviceId);
    return dev ? findProfile(dev.name, dev.inputChannels, dev.outputChannels) : null;
  },

  getMcpStatus: () => mcp.status(),
  setMcpSettings: async (next: McpSettings) => {
    settings.mcp = normalizeMcpSettings(next);
    saveSettings();
    return mcp.apply(settings.mcp);
  },

  getMidiSettings: () => settings.midi,
  setMidiSettings: (midi: MidiSettings) => {
    settings.midi = normalizeMidiSettings(midi);
    saveSettings();
    return settings.midi;
  },

  soundcheckInfo: () => {
    let freeBytes: number | null = null;
    try {
      const st = fs.statfsSync(current.dir);
      freeBytes = st.bavail * st.bsize;
    } catch {
      // unknown: the soundcheck skips the disk space check
    }
    return { inputDeviceName: inputDeviceName(), freeBytes };
  },
  confirmStopRecording: () => settings.confirmStopRecording,
  restoreBackup: async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Restore backup',
      defaultPath: path.join(current.dir, BACKUP_DIR),
      properties: ['openFile'],
      filters: [{ name: 'WavePod backups', extensions: ['json'] }],
    });
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    // keep the state we are leaving, so restoring is never a one-way door
    backupNow('before-restore');
    return loadBackup(file);
  },

  play: (from?: number) => engine.play(from),
  stop: () => engine.stop(),
  record: () => {
    backupNow('before-recording');
    return engine.record();
  },
  seek: (pos: number) => engine.seek(pos),
  setPlaybackSpeed: (speed: number) => engine.setPlaybackSpeed(speed),

  currentProject: () => current,
  newProject: () => {
    if (engine.transportState !== 'stopped') engine.stop();
    flushSave();
    return createNewProject();
  },
  openProject: async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Open WavePod project folder',
      defaultPath: projectsRoot(),
      properties: ['openDirectory'],
    });
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return null;
    if (!isProjectDir(dir)) throw new Error('That folder does not contain a WavePod project (project.json).');
    if (engine.transportState !== 'stopped') engine.stop();
    flushSave();
    return openProjectDir(dir);
  },
  updateProject: (project: Project) => setCurrentProject(project),
  listTemplates: () => listTemplates(templatesRoot()),
  saveTemplate: (name: string) => {
    flushSave();
    return saveTemplate(templatesRoot(), current.project, current.dir, name, inputDeviceName());
  },
  deleteTemplate: (id: string) => deleteTemplate(templatesRoot(), id),
  newProjectFromTemplate: (id: string) => {
    if (engine.transportState !== 'stopped') engine.stop();
    flushSave();
    const { dir } = createProjectFromTemplate(projectsRoot(), templatesRoot(), id, engine.config.sampleRate);
    return openProjectDir(dir);
  },
  showTemplatesFolder: () => {
    fs.mkdirSync(templatesRoot(), { recursive: true });
    return shell.openPath(templatesRoot()).then(() => undefined);
  },
  getPeaks: (file: string) => engine.getPeaks(file),
  getPeakTile: (file: string, samplesPerPeak: number, tile: number) => engine.getPeakTile(file, samplesPerPeak, tile),
  getSampleTile: (file: string, tile: number) => engine.getSampleTile(file, tile),
  showProjectFolder: () => shell.openPath(current.dir).then(() => undefined),

  pickAudioFiles: async () => {
    const res = await dialog.showOpenDialog(win!, {
      title: 'Choose audio files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'webm'] }],
    });
    return res.canceled ? [] : res.filePaths;
  },
  // Relative paths (e.g. soundboard jingles copied from a template) are inside the project folder.
  readFile: (p: string) => new Uint8Array(fs.readFileSync(path.resolve(current.dir, p))),
  importAudio: (name: string, channels: Float32Array[], sampleRate: number) => {
    const media = path.join(current.dir, 'media');
    fs.mkdirSync(media, { recursive: true });
    const base = name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}_ -]+/gu, '_') || 'import';
    let rel = `media/${base}.wav`;
    for (let i = 2; fs.existsSync(path.join(current.dir, rel)); i++) rel = `media/${base}-${i}.wav`;
    writeWavFile(path.join(current.dir, rel), channels, sampleRate, 24);
    return { file: rel, length: channels[0]?.length ?? 0 };
  },
  openTextFile: async (title: string, extensions: string[]) => {
    const res = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: [{ name: title, extensions }] });
    const p = res.filePaths[0];
    if (res.canceled || !p) return null;
    return { path: p, text: fs.readFileSync(p, 'utf8') };
  },
  saveTextFile: async (defaultName: string, text: string) => {
    const res = await dialog.showSaveDialog(win!, { defaultPath: path.join(current.dir, defaultName) });
    if (res.canceled || !res.filePath) return null;
    fs.writeFileSync(res.filePath, text);
    return res.filePath;
  },

  pickImage: async (title: string) => {
    const res = await dialog.showOpenDialog(win!, {
      title,
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    const src = res.filePaths[0];
    if (res.canceled || !src) return null;
    return importImage(current.dir, src);
  },

  loadSound: (id: string, channels: Float32Array[]) => engine.loadSound(id, channels),
  playSound: (id: string) => engine.playSound(id),
  stopSounds: () => engine.stopSounds(),

  chooseExportBase: async (defaultName: string) => {
    const res = await dialog.showSaveDialog(win!, {
      title: 'Export episode',
      defaultPath: path.join(current.dir, 'export', defaultName),
      buttonLabel: 'Export',
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath.replace(/\.(wav|mp3|flac)$/i, '');
  },
  exportProject: (opts: ExportOptions) => {
    flushSave();
    return runWorker<ExportResult>({ kind: 'export', project: current.project, dir: current.dir, opts }, (p) => send(IPC.exportProgress, p));
  },
  measureLoudness: (mixOnly?: boolean) => runWorker<LoudnessReport[]>({ kind: 'loudness', project: current.project, dir: current.dir, mixOnly: !!mixOnly }),
  measureClips: (clipIds: string[]) => runWorker<LoudnessReport[]>({ kind: 'clips', project: current.project, dir: current.dir, clipIds }),
  revealFile: (p: string) => shell.showItemInFolder(p),

  vstStatus: () => ({ available: !!vstExe, dirs: defaultVstDirs() }),
  vstScan: (force?: boolean) => {
    if (!vstExe) throw new Error('VST3 support is not included in this build.');
    return scanVstPlugins(vstExe, defaultVstDirs(), path.join(app.getPath('userData'), 'vst3-cache.json'), !!force);
  },
  vstDescribe: (plugin: VstPluginRef) => describeVst(plugin),
  vstFormat: (fx: Fx, paramId: number, value: number) => formatVst(fx, paramId, value),
};

function describeVst(plugin: VstPluginRef) {
  if (!vstHost) throw new Error('VST3 support is not included in this build.');
  const inst = vstHost.create({ plugin }, current.project.sampleRate, 4096);
  try {
    const state = Buffer.from(inst.getState()).toString('base64');
    return { params: inst.params, state, latency: inst.latency };
  } finally {
    inst.destroy();
  }
}

function formatVst(fx: Fx, paramId: number, value: number): string {
  if (!vstHost || !fx.plugin) return '';
  const key = `${fx.plugin.path}|${fx.plugin.cid}|${fx.state ?? ''}`;
  let shadow = vstShadows.get(fx.id);
  if (!shadow || shadow.key !== key || !shadow.inst.alive) {
    shadow?.inst.destroy();
    const inst = vstHost.create(fx, current.project.sampleRate, 4096);
    const state = decodeState(fx.state);
    if (state?.length) inst.setState(state);
    shadow = { key, inst };
    vstShadows.set(fx.id, shadow);
  }
  return shadow.inst.format(paramId, value);
}

// Instances used only to turn parameter values into the plug-in's own text, per filter id.
const vstShadows = new Map<string, { key: string; inst: VstInstance }>();
let vstExe: string | null = null;
let vstHost: VstHostProcess | null = null;

function registerIpc(): void {
  ipcMain.handle(IPC.invoke, async (_e, method: InvokeMethod, ...args: unknown[]) => {
    const h = handlers[method];
    if (!h) throw new Error(`Unknown method ${method}`);
    return (h as (...a: unknown[]) => unknown)(...args);
  });
}

function menuSend(cmd: MenuCommand) {
  return () => send(IPC.menu, cmd);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Episode', accelerator: 'CmdOrCtrl+N', click: menuSend('new-project') },
        { label: 'New Episode from Template…', accelerator: 'Shift+CmdOrCtrl+N', click: menuSend('new-from-template') },
        { label: 'Open Episode…', accelerator: 'CmdOrCtrl+O', click: menuSend('open-project') },
        { type: 'separator' },
        { label: 'Save as Template…', click: menuSend('save-template') },
        { label: 'Show Templates Folder', click: menuSend('show-templates-folder') },
        { type: 'separator' },
        { label: 'Import Audio…', accelerator: 'CmdOrCtrl+I', click: menuSend('import-audio') },
        { label: 'Import Chapters…', click: menuSend('import-chapters') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: menuSend('export') },
        { label: 'Show Project Folder', click: menuSend('show-project-folder') },
        { label: 'Restore Backup…', click: menuSend('restore-backup') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: menuSend('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: menuSend('redo') },
        { type: 'separator' },
        { label: 'Ripple Cut', accelerator: 'CmdOrCtrl+X', click: menuSend('ripple-cut') },
        { label: 'Mute Selection', accelerator: 'CmdOrCtrl+Y', click: menuSend('mute-selection') },
        { type: 'separator' },
        { label: 'Normalize Clip Loudness', accelerator: 'Alt+Shift+N', click: menuSend('normalize-clips') },
        { label: 'Loudness Analysis…', accelerator: 'Shift+CmdOrCtrl+L', click: menuSend('loudness-analysis') },
        { type: 'separator' },
        { label: 'Prepare All Tracks for Editing', click: menuSend('prepare-for-editing') },
        {
          label: 'Prepare for Editing When Recording Stops',
          type: 'checkbox',
          checked: settings.prepareForEditingAfterRecording,
          click: (item) => {
            settings.prepareForEditingAfterRecording = item.checked;
            saveSettings();
          },
        },
        {
          label: 'Confirm Before Stopping a Recording',
          type: 'checkbox',
          checked: settings.confirmStopRecording,
          click: (item) => {
            settings.confirmStopRecording = item.checked;
            saveSettings();
          },
        },
        { type: 'separator' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Setup', accelerator: 'CmdOrCtrl+1', click: menuSend('view-setup') },
        { label: 'Record && Edit', accelerator: 'CmdOrCtrl+2', click: menuSend('view-edit') },
        { label: 'Chapters', accelerator: 'CmdOrCtrl+3', click: menuSend('view-chapters') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: 'WavePod',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.whenReady().then(() => {
  settings = loadSettings();
  const useNative = process.env.WAVEPOD_SIMULATED !== '1';
  engine = new AudioEngine(useNative ? () => new RtAudioBackend() : null);
  vstExe = vstHostExecutable(app.getAppPath(), process.resourcesPath);
  if (vstExe) {
    vstHost = new VstHostProcess(vstExe, path.join(__dirname, 'vstBridge.js'));
    setVstHost(vstHost, (_id, message) => engine.reportError(message));
  }
  engine.on('transport', (u) => send(IPC.transport, u));
  engine.on('status', (s) => send(IPC.status, s));
  engine.on('recordingFinished', (takes: RecordedTake[]) => {
    // Merge takes here so they are saved even if the window is gone (e.g. quitting mid-take).
    let project = current.project;
    if (takes.some((t) => t.trackId === SOUNDBOARD_TRACK_ID)) project = ensureSoundboardTrack(project);
    for (const t of takes) project = addClip(project, t.trackId, t.clip);
    const prepared = settings.prepareForEditingAfterRecording ? prepareForEditing(project) : project;
    const preparedForEditing = prepared !== project;
    project = prepared;
    current.project = project;
    engine.setProject(project);
    flushSave();
    send(IPC.recordingFinished, { takes, project, preparedForEditing });
  });

  try {
    if (settings.lastProject && isProjectDir(settings.lastProject)) openProjectDir(settings.lastProject);
    else createNewProject();
  } catch (e) {
    console.error('could not open last project', e);
    createNewProject();
  }
  engine.applyConfig(settings.device);
  settings.device = engine.config;
  saveSettings();

  mcp = new McpController(createWavePodServer(mcpHost, app.getVersion()));
  void mcp.apply(settings.mcp).then((s) => {
    if (s.error) console.error('MCP server:', s.error);
  });

  registerIpc();
  buildMenu();
  createWindow();
  setInterval(() => backupNow(), BACKUP_INTERVAL_MS);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  void mcp?.dispose();
  if (engine) {
    engine.stop();
    flushSave();
    engine.dispose();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
