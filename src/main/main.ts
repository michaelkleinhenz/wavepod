import { BrowserWindow, Menu, MenuItem, app, dialog, ipcMain, shell, type MenuItemConstructorOptions } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { IPC, type InvokeMethod, type MenuCommand, type MenuModelItem, type MenuModelTop, type OpenedProject } from '../shared/api';
import { acceleratorLabel, menuLabel } from '../core/menuText';
import type { DeviceConfig, ExportOptions, ExportResult, Fx, AuphonicSettingsInput, LoudnessReport, McpSettings, OscSettings, Project, RecordedTake, VstPluginRef } from '../shared/types';
import { addClip, prepareForEditing } from '../core/project';
import { SOUNDBOARD_TRACK_ID, ensureSoundboardTrack } from '../core/soundboard';
import { findProfile } from '../core/deviceProfiles';
import { writeWavFile } from '../core/wav';
import { AudioEngine, defaultConfig } from './audio/engine';
import { RtAudioBackend } from './audio/rtaudioBackend';
import { VstHostProcess, vstHostExecutable } from './vst/host';
import { defaultVstDirs, scanVstPlugins } from './vst/scan';
import { decodeState, loadVstProgram, setVstHost, type VstInstance } from '../core/fx/vst';
import { leadingNumber, searchNormalized } from '../core/numberInput';
import { BACKUP_DIR, backupProject, createProjectDir, importImage, isProjectDir, loadBackup, loadProject, saveProject } from './projectStore';
import { createProjectFromTemplate, deleteTemplate, listTemplates, saveTemplate } from './templateStore';
import { deleteUserPreset, listUserPresets, loadUserPreset, renameUserPreset, saveUserPreset } from './presetStore';
import { createPresetLibrary } from '../core/fx/presetLibrary';
import { normalizeMidiSettings, type MidiSettings } from '../core/midi';
import { migrateUserData, resolveProjectsRoot } from './legacyPaths';
import { exportDialogDir } from './exportPaths';
import { createWavePodServer, type WavePodHost } from '../core/mcp/tools';
import { McpController, normalizeMcpSettings } from './mcp/controller';
import { OscServer } from './oscServer';
import { auphonicInfo, auphonicPresets, normalizeAuphonic, sendToAuphonic, updateAuphonic, type StoredAuphonic } from './auphonic';
import { normalizeOscSettings } from '../core/osc';

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
  /** Beep when playback passes a marker. */
  markerPing: boolean;
  /** Local MCP server for AI agents; off unless the user switches it on in Setup. */
  mcp: McpSettings;
  /** OSC remote control; off unless switched on in Setup. */
  osc: OscSettings;
  auphonic: StoredAuphonic;
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
      markerPing: raw.markerPing === true,
      mcp: normalizeMcpSettings(raw.mcp),
      osc: normalizeOscSettings(raw.osc),
      auphonic: normalizeAuphonic(raw.auphonic),
    };
  } catch {
    return { device: defaultConfig(), lastProject: null, midi: normalizeMidiSettings(null), prepareForEditingAfterRecording: false, confirmStopRecording: true, markerPing: false, mcp: normalizeMcpSettings(null), osc: normalizeOscSettings(null), auphonic: normalizeAuphonic(null) };
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

/** app.getPath throws for some names on systems without that folder configured. */
function safeGetPath(name: 'music' | 'documents'): string {
  try {
    return app.getPath(name);
  } catch {
    return '';
  }
}

function templatesRoot(): string {
  return path.join(projectsRoot(), 'Templates');
}

/** The user's filter presets, shared by all episodes. */
function presetsRoot(): string {
  return path.join(projectsRoot(), 'Presets');
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
let osc: OscServer;

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
  get presets() {
    return presetLibrary;
  },
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

  getAuphonicSettings: () => auphonicInfo(settings.auphonic),
  setAuphonicSettings: (input: AuphonicSettingsInput) => {
    settings.auphonic = updateAuphonic(settings.auphonic, input);
    saveSettings();
    return auphonicInfo(settings.auphonic);
  },
  auphonicPresets: () => auphonicPresets(settings.auphonic),
  sendToAuphonic: () => {
    flushSave();
    const send2 = (p: unknown) => send(IPC.exportProgress, p);
    return sendToAuphonic(
      settings.auphonic,
      current.project,
      current.dir,
      (opts) => runWorker<ExportResult>({ kind: 'export', project: current.project, dir: current.dir, opts }, send2),
      send2,
    );
  },
  openAuphonic: async (url: string) => {
    if (!/^https:\/\/auphonic\.com\//.test(url)) throw new Error('Not an Auphonic link');
    await shell.openExternal(url);
  },
  getOscStatus: () => osc.status(),
  setOscSettings: async (next: OscSettings) => {
    settings.osc = normalizeOscSettings(next);
    saveSettings();
    return osc.apply(settings.osc);
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
  setPreShow: (on: boolean) => engine.setPreShow(on),
  setLoop: (range: [number, number] | null) => engine.setLoop(range),

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
  getMenu: () => menuModel(),
  menuClick: (id: string) => {
    const item = menuItems.get(id);
    if (item?.enabled && win && !win.isDestroyed()) item.click(undefined, win, win.webContents);
  },

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
      defaultPath: path.join(exportDialogDir(current.dir, [safeGetPath('music'), app.getPath('home')]), defaultName),
      buttonLabel: 'Export',
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath.replace(/\.(wav|mp3|flac|opus)$/i, '');
  },
  exportProject: (opts: ExportOptions) => {
    flushSave();
    return runWorker<ExportResult>({ kind: 'export', project: current.project, dir: current.dir, opts }, (p) => send(IPC.exportProgress, p));
  },
  measureLoudness: (mixOnly?: boolean) => runWorker<LoudnessReport[]>({ kind: 'loudness', project: current.project, dir: current.dir, mixOnly: !!mixOnly }),
  measureClips: (clipIds: string[]) => runWorker<LoudnessReport[]>({ kind: 'clips', project: current.project, dir: current.dir, clipIds }),
  revealFile: (p: string) => shell.showItemInFolder(p),
  alignClip: (clipId: string, refTrackId: string) =>
    runWorker({ kind: 'align', project: current.project, dir: current.dir, clipIds: [clipId], refTrackId }),

  vstStatus: () => ({ available: !!vstExe, dirs: defaultVstDirs() }),
  vstScan: (force?: boolean) => {
    if (!vstExe) throw new Error('VST3 support is not included in this build.');
    return scanVstPlugins(vstExe, defaultVstDirs(), path.join(app.getPath('userData'), 'vst3-cache.json'), !!force);
  },
  vstDescribe: (plugin: VstPluginRef) => describeVst(plugin),
  vstFormat: (fx: Fx, paramId: number, value: number) => formatVst(fx, paramId, value),
  vstParse: (fx: Fx, paramId: number, text: string) => parseVst(fx, paramId, text),

  listFxPresets: (fx: Fx) => presetLibrary.list(fx),
  applyFxPreset: (fx: Fx, id: string) => presetLibrary.apply(fx, id),
  saveFxPreset: (fx: Fx, name: string) => presetLibrary.save(fx, name),
  renameFxPreset: (id: string, name: string) => renameUserPreset(presetsRoot(), id, name),
  deleteFxPreset: (id: string) => deleteUserPreset(presetsRoot(), id),
  showPresetsFolder: () => {
    fs.mkdirSync(presetsRoot(), { recursive: true });
    return shell.openPath(presetsRoot()).then(() => undefined);
  },
};

const presetLibrary = createPresetLibrary(
  {
    list: (fx) => listUserPresets(presetsRoot(), fx),
    load: (id) => loadUserPreset(presetsRoot(), id),
    save: (preset) => saveUserPreset(presetsRoot(), preset),
  },
  {
    names: (fx, paramId, steps) => {
      const inst = vstShadow(fx);
      if (!inst) return [];
      return Array.from({ length: steps + 1 }, (_, i) => inst.format(paramId, steps ? i / steps : 0));
    },
    load: (fx, paramId, value) => {
      if (!vstHost) throw new Error('VST3 support is not included in this build.');
      return loadVstProgram(vstHost, fx, current.project.sampleRate, paramId, value);
    },
  },
);

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
  const inst = vstShadow(fx);
  return inst ? inst.format(paramId, value) : '';
}

/** Typed text to a normalized value: the plug-in's own parser, else a search over its display text. */
function parseVst(fx: Fx, paramId: number, text: string): number | null {
  const inst = vstShadow(fx);
  if (!inst) return null;
  const own = inst.parse?.(paramId, text) ?? null;
  if (own !== null && Number.isFinite(own)) return Math.min(1, Math.max(0, own));
  const target = leadingNumber(text);
  if (target === null) return null;
  return searchNormalized(target, (v) => leadingNumber(inst.format(paramId, v)));
}

/** A plug-in instance used only to format and parse parameter text, per filter id. */
function vstShadow(fx: Fx): VstInstance | null {
  if (!vstHost || !fx.plugin) return null;
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
  return shadow.inst;
}

// Instances used only to turn parameter values into the plug-in's own text, per filter id.
const vstShadows = new Map<string, { key: string; inst: VstInstance }>();
let vstExe: string | null = null;
let vstHost: VstHostProcess | null = null;

function registerIpc(): void {
  ipcMain.handle(IPC.invoke, async (_e, method: InvokeMethod, ...args: unknown[]) => {
    const h = handlers[method];
    if (!h) throw new Error(`Unknown method ${method}`);
    try {
      return await (h as (...a: unknown[]) => unknown)(...args);
    } catch (e) {
      console.error(`[ipc] ${method} failed:`, e);
      throw e;
    }
  });
}

function menuSend(cmd: MenuCommand) {
  return () => send(IPC.menu, cmd);
}

/** On Linux and Windows the renderer draws the menu bar itself, so it matches the app's dark theme and font. */
const inAppMenuBar = process.platform !== 'darwin';
let appMenu: Menu | null = null;
/** Menu items by the ids handed to the renderer. */
const menuItems = new Map<string, MenuItem>();

function menuModel(): MenuModelTop[] {
  menuItems.clear();
  if (!inAppMenuBar || !appMenu) return [];
  let n = 0;
  const top: MenuModelTop[] = [];
  for (const t of appMenu.items) {
    if (!t.visible || !t.submenu) continue;
    const items: MenuModelItem[] = [];
    for (const item of t.submenu.items) {
      // "Zoom" only does something on macOS.
      if (!item.visible || item.role === 'zoom') continue;
      if (item.type === 'separator') {
        if (items.length && items[items.length - 1].type !== 'separator') items.push({ id: '', type: 'separator', label: '', enabled: true });
        continue;
      }
      const id = String(n++);
      menuItems.set(id, item);
      items.push({
        id,
        type: item.type === 'checkbox' ? 'checkbox' : 'normal',
        label: menuLabel(item.label),
        accelerator: acceleratorLabel(item.accelerator as string | undefined),
        checked: item.type === 'checkbox' ? item.checked : undefined,
        enabled: item.enabled,
      });
    }
    if (items[items.length - 1]?.type === 'separator') items.pop();
    top.push({ label: menuLabel(t.label), items });
  }
  return top;
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
        { label: 'Send to Auphonic…', click: menuSend('auphonic') },
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
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: menuSend('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: menuSend('paste') },
        { label: 'Paste and Move Later Material', accelerator: 'Shift+CmdOrCtrl+V', click: menuSend('paste-ripple') },
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
        { label: 'Select All Clips', accelerator: 'CmdOrCtrl+A', click: menuSend('select-all') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Setup', accelerator: 'CmdOrCtrl+1', click: menuSend('view-setup') },
        { label: 'Record && Edit', accelerator: 'CmdOrCtrl+2', click: menuSend('view-edit') },
        { label: 'Chapters', accelerator: 'CmdOrCtrl+3', click: menuSend('view-chapters') },
        { type: 'separator' },
        {
          label: 'Ping at Markers During Playback',
          type: 'checkbox',
          checked: settings.markerPing,
          click: (item) => {
            settings.markerPing = item.checked;
            engine.setMarkerPing(item.checked);
            saveSettings();
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Keyboard Shortcuts', click: menuSend('shortcuts') }],
    },
  ];
  appMenu = Menu.buildFromTemplate(template);
  // Still set on Linux and Windows (hidden there), so its accelerators and roles keep working.
  Menu.setApplicationMenu(appMenu);
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
  // Mirror renderer warnings and errors (including error toasts) to the terminal.
  if (inAppMenuBar) win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      const where = event.sourceId ? ` (${path.basename(event.sourceId)}:${event.lineNumber})` : '';
      console.error(`[renderer ${event.level}] ${event.message}${where}`);
    }
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
  engine.setMarkerPing(settings.markerPing);
  vstExe = vstHostExecutable(app.getAppPath(), process.resourcesPath);
  if (vstExe) {
    vstHost = new VstHostProcess(vstExe, path.join(__dirname, 'vstBridge.js'));
    setVstHost(vstHost, (_id, message) => engine.reportError(message));
  }
  engine.on('transport', (u) => send(IPC.transport, u));
  let loggedEngineError: string | null = null;
  engine.on('status', (s) => {
    // Every audio engine error also goes to the terminal, once per change.
    if (s.error && s.error !== loggedEngineError) console.error(`[audio] ${s.error}`);
    loggedEngineError = s.error;
    send(IPC.status, s);
  });
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

  osc = new OscServer((cmd) => send(IPC.remote, cmd));
  void osc.apply(settings.osc);
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
  void osc?.close();
  if (engine) {
    engine.stop();
    flushSave();
    engine.dispose();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
