// Audio drama scripts: import (plain "CHARACTER: line" text, Fountain, Final Draft .fdx, PlotGod
// audioplay JSON), the cast
// (which track each character is recorded on), ticking lines off as recorded and finding each
// line in the recording from the transcript ("Line up"). A recorded line is kept as a frame range
// of its media file, like transcript words, so it stays found through every cut and move.
import type { Frames, Project, Script, ScriptLine, ScriptTake, TimelineWord, Track } from '../shared/types';
import { uid } from '../shared/time';
import { bareWord } from './transcript';

export type ScriptFormat = 'plain' | 'fountain' | 'fdx' | 'plotgod';

/** File types the import dialog offers. */
export const SCRIPT_EXTENSIONS = ['txt', 'fountain', 'spmd', 'fdx', 'md', 'json'];

export interface ParsedScript {
  title: string;
  format: ScriptFormat;
  lines: ScriptLine[];
}

// ---------------------------------------------------------------- parsing

/** Scene headings: INT./EXT. (and German INNEN/AUSSEN), "Scene 3", "Szene 3:", "# …". */
const SCENE_PREFIX = /^(?:(?:INT|EXT|EST|INNEN|AUSSEN|AUẞEN|AUßEN)\b\.?|INT\.?\s*\/\s*EXT\.?|I\/E\b)/i;
const SCENE_WORD = /^(?:scene|szene|sc\.|act|akt|chapter|kapitel)\s*[\dIVXLC]*\b\s*[:.\-–—]?/i;
/** Headings that start an act rather than a scene. */
const ACT_WORD = /^(?:act|akt|aufzug|chapter|kapitel|part|teil)\b/i;
/** Level of a plain scene heading: below every act and section. */
const SCENE_LEVEL = 9;
/** Fountain character extensions that are no direction for the actor. */
const CONTD = /^(cont'?d|continued|cont\.|forts\.?)$/i;

function cleanText(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/(^|\W)[*_]{1,3}(?=\S)|(?<=\S)[*_]{1,3}(?=\W|$)/g, '$1')
    .trim();
}

function line(kind: ScriptLine['kind'], text: string, extra: Partial<ScriptLine> = {}): ScriptLine {
  return { id: uid('scl'), kind, text: cleanText(text), ...extra };
}

/** Upper-case key of a character name: what the cast and filters compare. */
export function characterKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Splits "ANNA (V.O.)" into the name and a note. */
function splitExtension(cue: string): { name: string; note?: string } {
  const notes: string[] = [];
  const name = cue
    .replace(/\(([^)]*)\)/g, (_, n: string) => {
      const t = n.trim();
      if (t && !CONTD.test(t)) notes.push(t);
      return ' ';
    })
    .replace(/\^\s*$/, '')
    .replace(/^@/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return notes.length ? { name, note: notes.join(', ') } : { name };
}

/** "Anna: Hello" / "ANNA (whispering): Hello" / "Dr. Hill: …" → name, note, text. */
const PLAIN_DIALOGUE = /^\s*([\p{L}][\p{L}\p{N}' .\-]{0,38}?)\s*(\([^)]*\))?\s*:\s*(.*)$/u;
/** Words before a colon that are no character. */
const NOT_A_CHARACTER = /^(title|titel|author|autor|credit|source|draft date|date|contact|notes?|copyright|by|von|http|https|www|tel|mail|e-mail)$/i;

function plainDialogue(text: string): { name: string; note?: string; text: string } | null {
  const m = PLAIN_DIALOGUE.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (m[3].startsWith('//')) return null;
  if (NOT_A_CHARACTER.test(name) || name.split(/\s+/).length > 4) return null;
  // "Anna and Ben went out. Then: …" is a sentence, not a name
  if (/[.!?]\s/.test(name) && !/^(dr|mr|mrs|ms|prof|st|hr|fr)\.\s/i.test(name)) return null;
  const note = m[2]?.slice(1, -1).trim();
  return { name, ...(note ? { note } : {}), text: m[3] };
}

/** Plain text: "CHARACTER: line" per line, scene headings, everything else is stage directions. */
export function parsePlainScript(text: string): { title: string; lines: ScriptLine[] } {
  const out: ScriptLine[] = [];
  let title = '';
  let last: ScriptLine | null = null;
  let blank = true;
  const rows = text.replace(/^﻿/, '').split(/\r?\n/);
  for (const raw of rows) {
    const t = raw.trim();
    if (!t) {
      blank = true;
      last = null;
      continue;
    }
    const titleLine = /^(title|titel)\s*:\s*(.+)$/i.exec(t);
    if (titleLine && !out.length && !title) {
      title = cleanText(titleLine[2]);
      blank = false;
      continue;
    }
    const md = /^#{1,6}\s+(.+)$/.exec(t);
    if (md || SCENE_PREFIX.test(t) || (SCENE_WORD.test(t) && t.length < 120 && !plainDialogue(t)?.text.trim().includes(' '))) {
      const heading = line('scene', md ? md[1] : t.replace(/^\.(?=\S)/, ''));
      if (ACT_WORD.test(heading.text)) heading.level = 1;
      out.push(heading);
      last = null;
      blank = false;
      continue;
    }
    const d = plainDialogue(t);
    // "ANNA: (whispering)" with the words on the next lines: the brackets are the direction
    const lone = d && /^\(([^()]*)\)$/.exec(d.text.trim());
    if (d && lone) {
      d.note = [d.note, lone[1].trim()].filter(Boolean).join(', ');
      d.text = '';
    }
    if (d && d.text.trim()) {
      last = line('dialogue', d.text, { character: d.name, ...(d.note ? { note: d.note } : {}) });
      out.push(last);
    } else if (d && !d.text.trim()) {
      // "ANNA:" on its own line, the words follow on the next lines
      last = line('dialogue', '', { character: d.name, ...(d.note ? { note: d.note } : {}) });
      out.push(last);
    } else if (last && last.kind === 'dialogue' && !blank) {
      const paren = /^\((.*)\)$/.exec(t);
      if (paren && !last.text) last.note = [last.note, paren[1].trim()].filter(Boolean).join(', ');
      else if (/^(\(.*\)|\[.*\])$/.test(t)) {
        // a direction on its own line after the words: what happens next, not part of the line
        last = line('action', t.replace(/^\[(.*)\]$/, '$1'));
        out.push(last);
      } else last.text = cleanText(`${last.text} ${t}`);
    } else {
      last = line('action', t.replace(/^\[(.*)\]$/, '$1'));
      out.push(last);
    }
    blank = false;
  }
  return { title, lines: out.filter((l) => l.text || l.kind !== 'dialogue') };
}

/** Fountain (fountain.io): the plain-text screenplay format most writing apps export. */
export function parseFountain(text: string): { title: string; lines: ScriptLine[] } {
  let src = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\[\[[\s\S]*?\]\]/g, '');
  let title = '';
  // title page: "Key: value" lines up to the first blank line
  const firstBlock = src.split(/\n\s*\n/)[0] ?? '';
  if (/^\s*(title|credit|author|authors|source|draft date|contact|copyright|notes)\s*:/i.test(firstBlock)) {
    const m = /^\s*title\s*:[ \t]*(.*)((?:\n[ \t]+.+)*)/im.exec(firstBlock);
    if (m) title = cleanText(`${m[1]} ${m[2]}`.replace(/<[^>]+>/g, ''));
    src = src.slice(firstBlock.length);
  }
  const rows = src.split('\n');
  const out: ScriptLine[] = [];
  const isBlank = (i: number) => i < 0 || i >= rows.length || !rows[i].trim();
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const t = raw.trim();
    if (!t) continue;
    const after = isBlank(i - 1);
    // section (# Act One) and scene heading (INT. … / .FORCED)
    if (/^#+\s*\S/.test(t)) {
      out.push(line('scene', t.replace(/^#+\s*/, ''), { level: Math.min(6, /^#+/.exec(t)![0].length) }));
      continue;
    }
    if (after && (SCENE_PREFIX.test(t) || /^\.[^.]/.test(t))) {
      out.push(line('scene', t.replace(/^\./, '').replace(/\s*#[^#]*#\s*$/, '')));
      continue;
    }
    // synopsis, page break
    if (/^=/.test(t)) continue;
    // character cue: upper case (or @forced), after a blank line, with dialogue under it
    const forced = t.startsWith('@');
    const cue = splitExtension(t);
    const upper = cue.name === cue.name.toUpperCase() && /\p{L}/u.test(cue.name);
    if (after && !isBlank(i + 1) && (forced || (upper && !/TO:$/.test(t) && !t.startsWith('>') && !t.startsWith('!')))) {
      const notes: string[] = cue.note ? [cue.note] : [];
      const words: string[] = [];
      let j = i + 1;
      for (; j < rows.length && rows[j].trim(); j++) {
        const d = rows[j].trim();
        const paren = /^\((.*)\)$/.exec(d);
        if (paren) {
          // a direction before the first words is the line's note; later ones stay in the text
          if (!words.length) notes.push(paren[1].trim());
          else words.push(d);
        } else words.push(d.replace(/^~\s*/, ''));
      }
      i = j - 1;
      if (words.length) out.push(line('dialogue', words.join(' '), { character: cue.name, ...(notes.length ? { note: notes.join(', ') } : {}) }));
      continue;
    }
    // transitions (CUT TO:) carry nothing to record
    if ((/^[^a-z]*TO:$/.test(t) && after) || /^>[^<]*$/.test(t)) continue;
    // action (centred >text< too); consecutive action lines make one paragraph
    const action = t.replace(/^!/, '').replace(/^>\s*(.*?)\s*<$/, '$1');
    const prev = out[out.length - 1];
    if (prev?.kind === 'action' && !after) prev.text = cleanText(`${prev.text} ${action}`);
    else out.push(line('action', action));
  }
  return { title, lines: out };
}

function decodeXml(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** Final Draft (.fdx): paragraphs typed Scene Heading, Character, Parenthetical, Dialogue, Action. */
export function parseFdx(xml: string): { title: string; lines: ScriptLine[] } {
  const out: ScriptLine[] = [];
  const content = /<Content>([\s\S]*?)<\/Content>/i.exec(xml)?.[1] ?? xml;
  let speaker: { name: string; note?: string } | null = null;
  let notes: string[] = [];
  let lastDialogue: ScriptLine | null = null;
  for (const m of content.matchAll(/<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/gi)) {
    const type = /\bType="([^"]*)"/i.exec(m[1])?.[1] ?? '';
    const text = [...m[2].matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/gi)].map((t) => decodeXml(t[1])).join('');
    if (!text.trim()) continue;
    switch (type.toLowerCase()) {
      case 'scene heading':
        out.push(line('scene', text));
        speaker = null;
        break;
      case 'new act':
        out.push(line('scene', text, { level: 1 }));
        speaker = null;
        break;
      case 'character':
        speaker = splitExtension(text);
        notes = speaker.note ? [speaker.note] : [];
        lastDialogue = null;
        break;
      case 'parenthetical': {
        const t = text.trim().replace(/^\((.*)\)$/, '$1');
        if (lastDialogue) lastDialogue.text = cleanText(`${lastDialogue.text} (${t})`);
        else notes.push(t);
        break;
      }
      case 'dialogue':
        if (!speaker) {
          out.push(line('action', text));
          break;
        }
        if (lastDialogue) lastDialogue.text = cleanText(`${lastDialogue.text} ${text}`);
        else {
          lastDialogue = line('dialogue', text, { character: speaker.name, ...(notes.length ? { note: notes.join(', ') } : {}) });
          out.push(lastDialogue);
        }
        break;
      case 'transition':
      case 'shot':
      case 'general':
      case 'action':
      default:
        speaker = null;
        lastDialogue = null;
        out.push(line('action', text));
    }
  }
  const title = decodeXml(/<TitlePage>[\s\S]*?<Text\b[^>]*>([\s\S]*?)<\/Text>/i.exec(xml)?.[1] ?? '').trim();
  return { title, lines: out };
}

// PlotGod project export: { project, chapters: [{ Chapter, Scenes: [{ Meta, Content }] }],
// characters }. Each scene's Content is a screenplay in plain text ("# Scene title", "SZENE 1 - …"
// slug line, "[SFX: …]" cues, "NAME: (direction)" above the words).

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const field = (o: Json | null, ...keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (k in o) return o[k];
  return undefined;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

/** The parsed JSON when the text is a PlotGod export, else null. */
function plotGodData(text: string): Json | null {
  const t = text.replace(/^\uFEFF/, '').trimStart();
  if (!t.startsWith('{')) return null;
  let data: Json | null;
  try {
    data = obj(JSON.parse(t));
  } catch {
    return null;
  }
  const chapters = field(data, 'chapters', 'Chapters');
  if (!Array.isArray(chapters)) return null;
  return chapters.some((c) => Array.isArray(field(obj(c), 'Scenes', 'scenes'))) ? data : null;
}

/** Scene text that came out of a rich-text editor as HTML: paragraphs to lines. */
function htmlToText(s: string): string {
  if (!/<(p|br|div|h\d)\b/i.test(s)) return s;
  return decodeXml(s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h\d)>/gi, '\n\n'));
}

/** PlotGod audioplay export: chapters become scene headings, each scene is read like a plain script. */
export function parsePlotGod(text: string): { title: string; lines: ScriptLine[] } {
  const data = plotGodData(text);
  if (!data) return { title: '', lines: [] };
  const project = obj(field(data, 'project', 'Project'));
  const title = cleanText(str(field(project, 'name', 'title')));
  const chapters = (field(data, 'chapters', 'Chapters') as unknown[])
    .map((c, i) => {
      const o = obj(c);
      const meta = obj(field(o, 'Chapter', 'chapter'));
      const order = Number(field(meta, 'order'));
      const scenes = field(o, 'Scenes', 'scenes');
      return { title: str(field(meta, 'title')), order: Number.isFinite(order) ? order : i, scenes: Array.isArray(scenes) ? scenes : [] };
    })
    .sort(byOrder);
  const out: ScriptLine[] = [];
  for (const ch of chapters) {
    if (ch.title.trim() && chapters.length > 1) out.push(line('scene', ch.title, { level: 1 }));
    const scenes = ch.scenes
      .map((s, i) => {
        const o = obj(s);
        const meta = obj(field(o, 'Meta', 'meta'));
        const order = Number(field(meta, 'order'));
        return { title: str(field(meta, 'title')), order: Number.isFinite(order) ? order : i, content: htmlToText(str(field(o, 'Content', 'content'))) };
      })
      .sort(byOrder);
    for (const sc of scenes) {
      // "**SARAH:**" / "**SARAH**:" from the editor's bold: a plain cue
      const rows = sc.content.split(/\r?\n/).map((r) => r.replace(/^(\s*)([*_]{1,3})([^*_\n]+?)(:?)\2(:?)/, (m, sp: string, _e, name: string, c1: string, c2: string) => (c1 || c2 ? `${sp}${name}:` : m)));
      const first = rows.findIndex((r) => r.trim());
      // "# Scene 1 - title" right above the slug line "SCENE 1 - OFFICE - NIGHT": one heading is enough
      if (first >= 0 && /^#{1,6}\s/.test(rows[first].trim())) {
        const next = rows.slice(first + 1).find((r) => r.trim())?.trim() ?? '';
        if (SCENE_PREFIX.test(next) || SCENE_WORD.test(next)) rows.splice(first, 1);
      }
      const body = parsePlainScript(rows.join('\n')).lines;
      if (sc.title.trim() && body[0]?.kind !== 'scene') out.push(line('scene', sc.title));
      out.push(...body);
    }
  }
  return { title, lines: out };
}

/** Which format a script file is in, from its name and its text. */
export function detectScriptFormat(text: string, fileName = ''): ScriptFormat {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  if (ext === 'fdx' || /<FinalDraft\b/i.test(text.slice(0, 2000))) return 'fdx';
  if (ext === 'fountain' || ext === 'spmd') return 'fountain';
  if (plotGodData(text)) return 'plotgod';
  // plain text with "NAME: line" rows, or Fountain-like upper-case cues above the words?
  const rows = text.split(/\r?\n/);
  let colon = 0;
  let cues = 0;
  for (let i = 0; i < rows.length; i++) {
    const t = rows[i].trim();
    if (!t) continue;
    if (plainDialogue(t)?.text.trim()) colon++;
    const prevBlank = i === 0 || !rows[i - 1].trim();
    const next = rows[i + 1]?.trim();
    const name = splitExtension(t).name;
    if (prevBlank && next && name.length < 40 && name === name.toUpperCase() && /\p{L}/u.test(name) && !/[.!?:]$/.test(name)) cues++;
  }
  return cues > colon ? 'fountain' : 'plain';
}

/** Reads a script file: the format is picked from the file name and the text. */
export function parseScript(text: string, fileName = ''): ParsedScript {
  const format = detectScriptFormat(text, fileName);
  const r =
    format === 'fdx' ? parseFdx(text) : format === 'plotgod' ? parsePlotGod(text) : format === 'fountain' ? parseFountain(text) : parsePlainScript(text);
  // one spelling per character: the first one used
  const spelling = new Map<string, string>();
  for (const l of r.lines) {
    if (l.kind !== 'dialogue' || !l.character) continue;
    const key = characterKey(l.character);
    if (!spelling.has(key)) spelling.set(key, l.character.trim().replace(/\s+/g, ' '));
    l.character = spelling.get(key);
  }
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return { title: r.title || base || 'Script', format, lines: r.lines };
}

/** A new script for the project from a parsed file; characters go to tracks of the same name. */
export function createScript(project: Project, parsed: ParsedScript, source?: string): Script {
  const script: Script = { title: parsed.title, ...(source ? { source } : {}), lines: parsed.lines, cast: {} };
  script.cast = autoCast(script, project.tracks);
  return script;
}

/** Keeps a script read from project.json usable; drops it when it holds nothing. */
export function normalizeScript(raw: unknown): Script | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as Partial<Script>;
  if (!Array.isArray(s.lines)) return undefined;
  const lines: ScriptLine[] = [];
  for (const l of s.lines) {
    if (!l || typeof l !== 'object' || typeof l.text !== 'string') continue;
    const kind = l.kind === 'scene' || l.kind === 'action' ? l.kind : 'dialogue';
    const take = l.take && Number.isFinite(l.take.from) ? l.take : undefined;
    lines.push({
      id: typeof l.id === 'string' && l.id ? l.id : uid('scl'),
      kind,
      text: l.text,
      ...(kind === 'dialogue' && typeof l.character === 'string' ? { character: l.character } : {}),
      ...(typeof l.note === 'string' && l.note ? { note: l.note } : {}),
      ...(kind === 'scene' && Number.isInteger(l.level) && l.level! >= 1 && l.level! <= 6 ? { level: l.level } : {}),
      ...(l.recorded ? { recorded: true } : {}),
      ...(take
        ? {
            take: {
              ...(typeof take.file === 'string' && take.file ? { file: take.file } : {}),
              from: Math.max(0, Math.round(take.from)),
              ...(Number.isFinite(take.to) ? { to: Math.round(take.to!) } : {}),
              ...(take.auto ? { auto: true } : {}),
              ...(Number.isFinite(take.takes) && take.takes! > 1 ? { takes: Math.round(take.takes!) } : {}),
            },
          }
        : {}),
    });
  }
  const cast: Record<string, string> = {};
  if (s.cast && typeof s.cast === 'object') for (const [k, v] of Object.entries(s.cast)) if (typeof v === 'string' && v) cast[characterKey(k)] = v;
  return { title: typeof s.title === 'string' ? s.title : 'Script', ...(typeof s.source === 'string' ? { source: s.source } : {}), lines, cast };
}

// ---------------------------------------------------------------- characters and cast

export interface ScriptCharacter {
  key: string;
  /** The name as the script spells it. */
  name: string;
  lines: number;
  recorded: number;
}

/** The characters in order of their first line, with how many of their lines are recorded. */
export function scriptCharacters(script: Script): ScriptCharacter[] {
  const map = new Map<string, ScriptCharacter>();
  for (const l of script.lines) {
    if (l.kind !== 'dialogue' || !l.character) continue;
    const key = characterKey(l.character);
    let c = map.get(key);
    if (!c) map.set(key, (c = { key, name: l.character, lines: 0, recorded: 0 }));
    c.lines++;
    if (l.recorded) c.recorded++;
  }
  return [...map.values()];
}

function nameWords(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Character → track by name: a track named like the character ("Anna", "ANNA", "Anna (Maria)",
 * "Dr. Hill" for "HILL"). Characters that are already cast keep their track while it exists.
 */
export function autoCast(script: Script, tracks: Track[], current: Record<string, string> = script.cast ?? {}): Record<string, string> {
  const speech = tracks.filter((t) => t.kind !== 'soundboard');
  const out: Record<string, string> = {};
  for (const c of scriptCharacters(script)) {
    const kept = current[c.key];
    if (kept && speech.some((t) => t.id === kept)) {
      out[c.key] = kept;
      continue;
    }
    const want = nameWords(c.name).join(' ');
    const exact = speech.find((t) => nameWords(t.name).join(' ') === want);
    const loose = exact ?? speech.find((t) => {
      const words = nameWords(t.name);
      const cw = nameWords(c.name);
      return cw.length > 0 && cw.every((w) => words.includes(w));
    });
    if (loose) out[c.key] = loose.id;
  }
  return out;
}

/** The track a line is recorded on, if its character is cast. */
export function lineTrack(script: Script, l: ScriptLine): string | undefined {
  return l.character ? script.cast[characterKey(l.character)] : undefined;
}

export interface ScriptProgress {
  lines: number;
  recorded: number;
}

export function scriptProgress(script: Script): ScriptProgress {
  let lines = 0;
  let recorded = 0;
  for (const l of script.lines) {
    if (l.kind !== 'dialogue') continue;
    lines++;
    if (l.recorded) recorded++;
  }
  return { lines, recorded };
}

// ---------------------------------------------------------------- where lines are

/** Where a take is on the timeline now, or null if its audio was cut out. */
export function takePosition(project: Project, take: ScriptTake, trackId?: string): { start: Frames; end?: Frames; trackId?: string } | null {
  if (!take.file) return { start: take.from, ...(take.to !== undefined ? { end: take.to } : {}), ...(trackId ? { trackId } : {}) };
  const tracks = trackId ? [...project.tracks.filter((t) => t.id === trackId), ...project.tracks.filter((t) => t.id !== trackId)] : project.tracks;
  for (const t of tracks) {
    for (const c of t.clips) {
      // reversed, sped up or looped clips no longer play the file's frames in order
      if (c.file !== take.file || c.sound || take.from < c.offset || take.from >= c.offset + c.length) continue;
      const start = c.start + take.from - c.offset;
      let end: number | undefined;
      if (take.to !== undefined) {
        if (take.to <= c.offset + c.length) end = c.start + take.to - c.offset;
        else {
          // the line goes on in another clip of the same file (a cut inside the line)
          const tail = t.clips.find((d) => d.file === take.file && !d.sound && take.to! > d.offset && take.to! <= d.offset + d.length && d.start >= c.start);
          end = tail ? tail.start + take.to - tail.offset : c.start + c.length;
        }
      }
      return { start, ...(end !== undefined && end > start ? { end } : {}), trackId: t.id };
    }
  }
  return null;
}

/**
 * A take for a timeline range: kept as frames of the clip under it (on the line's track if it has
 * one there, else any track), or as plain timeline positions when no clip is there yet (ticked
 * while recording).
 */
export function takeAt(project: Project, start: Frames, end?: Frames, trackId?: string): ScriptTake {
  const pos = Math.max(0, Math.round(start));
  const ordered = trackId ? [...project.tracks.filter((t) => t.id === trackId), ...project.tracks.filter((t) => t.id !== trackId && t.kind !== 'soundboard')] : project.tracks.filter((t) => t.kind !== 'soundboard');
  for (const t of ordered) {
    const c = t.clips.find((x) => !x.sound && pos >= x.start && pos < x.start + x.length);
    if (!c) continue;
    const take: ScriptTake = { file: c.file, from: c.offset + pos - c.start };
    if (end !== undefined && end > pos && end <= c.start + c.length) take.to = c.offset + Math.round(end) - c.start;
    return take;
  }
  return { from: pos, ...(end !== undefined && end > pos ? { to: Math.round(end) } : {}) };
}

/** Takes ticked while recording (timeline positions) moved onto the clips recorded there. */
export function settleTakes(project: Project): Project {
  const script = project.script;
  if (!script?.lines.some((l) => l.take && !l.take.file)) return project;
  let changed = false;
  const lines = script.lines.map((l) => {
    if (!l.take || l.take.file) return l;
    const take = takeAt(project, l.take.from, l.take.to, lineTrack(script, l));
    if (!take.file) return l;
    changed = true;
    return { ...l, take: { ...take, ...(l.take.auto ? { auto: true } : {}) } };
  });
  return changed ? { ...project, script: { ...script, lines } } : project;
}

export interface PlacedLine {
  /** Index into script.lines. */
  index: number;
  start: Frames;
  end?: Frames;
}

/** Every line with a take still on the timeline, by time. */
export function placedLines(project: Project): PlacedLine[] {
  const script = project.script;
  if (!script) return [];
  const out: PlacedLine[] = [];
  script.lines.forEach((l, index) => {
    if (!l.take) return;
    const p = takePosition(project, l.take, lineTrack(script, l));
    if (p) out.push({ index, start: p.start, ...(p.end !== undefined ? { end: p.end } : {}) });
  });
  return out.sort((a, b) => a.start - b.start);
}

/** The line playing at `pos`: the last one that started, while it lasts (plus a second). */
export function lineAt(placed: PlacedLine[], pos: Frames, sampleRate: number): number {
  let best = -1;
  for (const p of placed) {
    if (p.start > pos) break;
    const end = (p.end ?? p.start + 3 * sampleRate) + sampleRate;
    if (pos <= end) best = p.index;
  }
  return best;
}

export interface ScriptScene {
  /** Index into script.lines of the heading (-1: lines before the first heading). */
  index: number;
  title: string;
  /** 1 for an act, 2… for parts of one, undefined for a scene. */
  level?: number;
  /** Index just after the heading's last line: an act runs to the next act, a scene to the next heading. */
  end: number;
  /** Dialogue lines in it (an act counts those of its scenes). */
  lines: number;
  recorded: number;
}

/** How deep a heading sits: acts (1) hold parts (2…), which hold scenes. Not a heading: 0. */
export function headingLevel(l: ScriptLine | undefined): number {
  if (!l || l.kind !== 'scene') return 0;
  return l.level ?? (ACT_WORD.test(l.text) ? 1 : SCENE_LEVEL);
}

/** Index just after the last line under the heading at index i (the script's end for the last one). */
export function sectionEnd(lines: readonly ScriptLine[], i: number): number {
  const level = headingLevel(lines[i]);
  if (!level) return i + 1;
  for (let j = i + 1; j < lines.length; j++) {
    const l = headingLevel(lines[j]);
    if (l && l <= level) return j;
  }
  return lines.length;
}

/** For every line, whether a folded heading above it hides it (the folded headings themselves stay). */
export function foldedLines(lines: readonly ScriptLine[], folded: ReadonlySet<string>): boolean[] {
  const hidden = new Array<boolean>(lines.length).fill(false);
  if (!folded.size) return hidden;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== 'scene' || !folded.has(lines[i].id)) continue;
    const end = sectionEnd(lines, i);
    for (let j = i + 1; j < end; j++) hidden[j] = true;
    i = end - 1;
  }
  return hidden;
}

/** Indexes of the headings a line sits under, outermost first (the act, then the scene). */
export function headingsAbove(lines: readonly ScriptLine[], index: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= index && i < lines.length; i++) if (lines[i].kind === 'scene' && i !== index && sectionEnd(lines, i) > index) out.push(i);
  return out;
}

/** Ids of the headings to fold so that only the part holding the line stays open. */
export function foldAllBut(lines: readonly ScriptLine[], index: number): Set<string> {
  const keep = new Set(headingsAbove(lines, index));
  if (lines[index]?.kind === 'scene') keep.add(index);
  const out = new Set<string>();
  lines.forEach((l, i) => {
    if (l.kind === 'scene' && !keep.has(i)) out.add(l.id);
  });
  return out;
}

export function scriptScenes(script: Script): ScriptScene[] {
  const lines = script.lines;
  const out: ScriptScene[] = [];
  const first = lines.findIndex((l) => l.kind === 'scene');
  const count = (from: number, to: number) => {
    let n = 0;
    let rec = 0;
    for (let i = from; i < to; i++) {
      if (lines[i].kind !== 'dialogue') continue;
      n++;
      if (lines[i].recorded) rec++;
    }
    return { lines: n, recorded: rec };
  };
  const opening = count(0, first < 0 ? lines.length : first);
  if (opening.lines) out.push({ index: -1, title: 'Opening', end: first < 0 ? lines.length : first, ...opening });
  lines.forEach((l, i) => {
    if (l.kind !== 'scene') return;
    const end = sectionEnd(lines, i);
    const level = headingLevel(l);
    out.push({ index: i, title: l.text, ...(level < SCENE_LEVEL ? { level } : {}), end, ...count(i + 1, end) });
  });
  return out;
}

/** Where a scene (or act) starts on the timeline: its earliest recorded line, or null if none is. */
export function sceneStart(project: Project, sceneIndex: number, placed = placedLines(project)): Frames | null {
  const script = project.script;
  if (!script) return null;
  const lines = script.lines;
  const first = lines.findIndex((l) => l.kind === 'scene');
  const end = sceneIndex >= 0 ? sectionEnd(lines, sceneIndex) : first < 0 ? lines.length : first;
  let best: number | null = null;
  for (const p of placed) if (p.index > sceneIndex && p.index < end && (best === null || p.start < best)) best = p.start;
  return best;
}

// ---------------------------------------------------------------- matching the transcript

/** The words of a line that should be heard: directions in (…) and […] are left out. */
export function lineTokens(text: string): string[] {
  return text
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[\s—–/]+|-{2,}/)
    .map(bareWord)
    .filter(Boolean);
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  // one letter off: "colour"/"color", a misheard ending
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return a.length - i - j <= 1 && b.length - i - j <= 1;
}

interface Match {
  /** Indices into the word list of the first and last matched word. */
  first: number;
  last: number;
  score: number;
}

/** Longest common subsequence of the line and a window of words; score = share of the line found. */
function alignWindow(line: string[], tokens: string[], from: number, to: number): Match | null {
  const n = line.length;
  const m = to - from;
  if (m <= 0) return null;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = sameWord(line[i - 1], tokens[from + j - 1]) ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matched = dp[n][m];
  if (!matched) return null;
  // walk back for the first and last matched word
  let i = n;
  let j = m;
  let first = -1;
  let last = -1;
  while (i > 0 && j > 0) {
    if (sameWord(line[i - 1], tokens[from + j - 1]) && dp[i][j] === dp[i - 1][j - 1] + 1) {
      if (last < 0) last = from + j - 1;
      first = from + j - 1;
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  // words of the take that aren't in the line (a fluffed restart) lower the score a little
  const spread = last - first + 1;
  const extra = Math.max(0, spread - matched);
  return { first, last, score: matched / n - Math.min(0.2, extra / (4 * n)) };
}

export interface LineUpResult {
  /** lineId → where the line was found. */
  found: Map<string, ScriptTake & { start: Frames; end: Frames; score: number }>;
  /** Dialogue lines with words to look for. */
  searched: number;
}

/** Needed share of a line's words for it to count as found. */
function threshold(n: number): number {
  if (n <= 2) return 1;
  if (n <= 4) return 0.75;
  return 0.6;
}

/**
 * Finds the script's lines in the transcript: each line is looked for on its character's track
 * (or on all tracks for characters without one), allowing for misheard and missing words. When
 * a line was recorded several times, the best take wins, and of equally good ones the last
 * (the take that was kept). Very short lines ("Yes.") are only looked for between the lines
 * around them, so they aren't matched just anywhere.
 */
export function lineUpScript(project: Project, words: TimelineWord[]): LineUpResult {
  const script = project.script;
  const found: LineUpResult['found'] = new Map();
  if (!script || !words.length) return { found, searched: 0 };
  const tokens = words.map((w) => bareWord(w.text));
  // word indices per track, and per word on that track (for seeding candidates)
  const byTrack = new Map<string, number[]>();
  for (let i = 0; i < words.length; i++) {
    if (!tokens[i]) continue;
    let list = byTrack.get(words[i].trackId);
    if (!list) byTrack.set(words[i].trackId, (list = []));
    list.push(i);
  }
  const all = words.map((_, i) => i).filter((i) => tokens[i]);
  const indexCache = new Map<string, { list: number[]; toks: string[]; pos: Map<string, number[]> }>();
  const indexFor = (trackId: string | undefined) => {
    const key = trackId && byTrack.has(trackId) ? trackId : '*';
    let idx = indexCache.get(key);
    if (!idx) {
      const list = key === '*' ? all : byTrack.get(key)!;
      const toks = list.map((i) => tokens[i]);
      const pos = new Map<string, number[]>();
      toks.forEach((t, k) => {
        let a = pos.get(t);
        if (!a) pos.set(t, (a = []));
        a.push(k);
      });
      idx = { list, toks, pos };
      indexCache.set(key, idx);
    }
    return idx;
  };

  type Hit = { first: number; last: number; score: number };
  const search = (lineToks: string[], trackId: string | undefined, within?: [Frames, Frames]): { best: Hit; takes: number } | null => {
    const { list, toks, pos } = indexFor(trackId);
    const n = lineToks.length;
    // seed from the line's rarest words (common ones like "the" would try everything)
    const seeds = lineToks
      .map((t, k) => ({ k, hits: pos.get(t) ?? [] }))
      .filter((s) => s.hits.length)
      .sort((a, b) => a.hits.length - b.hits.length)
      .slice(0, 3);
    const starts = new Set<number>();
    for (const s of seeds) for (const h of s.hits) starts.add(Math.max(0, h - s.k));
    const hits: Hit[] = [];
    const slack = Math.max(3, Math.ceil(n / 3));
    for (const s of [...starts].sort((a, b) => a - b)) {
      const from = Math.max(0, s - 2);
      const to = Math.min(toks.length, s + n + slack);
      const m = alignWindow(lineToks, toks, from, to);
      if (!m || m.score < threshold(n)) continue;
      const first = list[m.first];
      const last = list[m.last];
      if (within && (words[first].start < within[0] || words[first].start > within[1])) continue;
      hits.push({ first, last, score: m.score });
    }
    if (!hits.length) return null;
    // distinct takes: overlapping hits are the same take
    hits.sort((a, b) => b.score - a.score || words[b.first].start - words[a.first].start);
    const takes: Hit[] = [];
    for (const h of hits) if (!takes.some((t) => words[h.first].start <= words[t.last].end && words[h.last].end >= words[t.first].start)) takes.push(h);
    const top = takes[0].score;
    const best = takes.filter((t) => t.score >= top - 0.05).sort((a, b) => words[b.first].start - words[a.first].start)[0];
    return { best, takes: takes.length };
  };

  const record = (l: ScriptLine, r: { best: Hit; takes: number }) => {
    const a = words[r.best.first];
    const b = words[r.best.last];
    const take = takeAt(project, a.start, b.end, a.trackId);
    found.set(l.id, { ...take, auto: true, ...(r.takes > 1 ? { takes: r.takes } : {}), start: a.start, end: b.end, score: r.best.score });
  };

  const dialogue = script.lines.filter((l) => l.kind === 'dialogue');
  const toks = new Map(dialogue.map((l) => [l.id, lineTokens(l.text)]));
  let searched = 0;
  // long lines first: they are unmistakable
  for (const l of dialogue) {
    const t = toks.get(l.id)!;
    if (!t.length) continue;
    searched++;
    if (t.length < 3) continue;
    const r = search(t, lineTrack(script, l));
    if (r) record(l, r);
  }
  // short lines: only between the found lines around them
  dialogue.forEach((l, i) => {
    const t = toks.get(l.id)!;
    if (!t.length || t.length >= 3) return;
    let lo = 0;
    let hi = Infinity;
    for (let k = i - 1; k >= 0; k--) {
      const f = found.get(dialogue[k].id);
      if (f) {
        lo = f.start;
        break;
      }
    }
    for (let k = i + 1; k < dialogue.length; k++) {
      const f = found.get(dialogue[k].id);
      if (f) {
        hi = f.start;
        break;
      }
    }
    if (lo === 0 && hi === Infinity) return;
    const r = search(t, lineTrack(script, l), [lo, hi]);
    if (r) record(l, r);
  });
  return { found, searched };
}

/**
 * Applies a line-up: found lines are ticked and get their take. Lines ticked by hand keep their
 * take; nothing is ever unticked.
 */
export function applyLineUp(project: Project, result: LineUpResult): Project {
  const script = project.script;
  if (!script || !result.found.size) return project;
  const lines = script.lines.map((l) => {
    const f = result.found.get(l.id);
    if (!f) return l;
    if (l.take && !l.take.auto && l.recorded) return l;
    const { start: _s, end: _e, score: _score, ...take } = f;
    return { ...l, recorded: true, take };
  });
  return { ...project, script: { ...script, lines } };
}

// ---------------------------------------------------------------- edits

function withScript(project: Project, fn: (s: Script) => Script): Project {
  if (!project.script) return project;
  return { ...project, script: fn(project.script) };
}

/** Ticks a line as recorded (at `take`, if given) or unticks it (its take is forgotten). */
export function setLineRecorded(project: Project, lineId: string, recorded: boolean, take?: ScriptTake): Project {
  return withScript(project, (s) => ({
    ...s,
    lines: s.lines.map((l) => {
      if (l.id !== lineId) return l;
      if (!recorded) {
        const { recorded: _r, take: _t, ...rest } = l;
        return rest;
      }
      return { ...l, recorded: true, ...(take ? { take } : {}) };
    }),
  }));
}

export function setCast(project: Project, character: string, trackId: string | null): Project {
  return withScript(project, (s) => {
    const cast = { ...s.cast };
    if (trackId) cast[characterKey(character)] = trackId;
    else delete cast[characterKey(character)];
    return { ...s, cast };
  });
}

/** Imports a script, keeping what is recorded of lines that stay the same (a revised draft). */
export function replaceScript(project: Project, next: Script): Project {
  const old = project.script;
  if (!old) return { ...project, script: next };
  const done = new Map<string, ScriptLine>();
  for (const l of old.lines) if (l.kind === 'dialogue' && l.recorded) done.set(`${characterKey(l.character ?? '')}|${lineTokens(l.text).join(' ')}`, l);
  const lines = next.lines.map((l) => {
    if (l.kind !== 'dialogue') return l;
    const prev = done.get(`${characterKey(l.character ?? '')}|${lineTokens(l.text).join(' ')}`);
    return prev ? { ...l, recorded: true, ...(prev.take ? { take: prev.take } : {}) } : l;
  });
  return { ...project, script: { ...next, lines, cast: autoCast({ ...next, lines }, project.tracks, { ...old.cast, ...next.cast }) } };
}

export function removeScript(project: Project): Project {
  if (!project.script) return project;
  const { script: _s, ...rest } = project;
  return rest as Project;
}

/** The script as text for an AI agent or a printout: scenes, lines with status and times. */
export function scriptSummary(project: Project): Array<Record<string, unknown>> {
  const script = project.script;
  if (!script) return [];
  const sr = project.sampleRate;
  const placed = new Map(placedLines(project).map((p) => [p.index, p]));
  const names = new Map(project.tracks.map((t) => [t.id, t.name]));
  return script.lines.map((l, i) => {
    const p = placed.get(i);
    const track = lineTrack(script, l);
    return {
      kind: l.kind,
      ...(l.kind === 'scene' && headingLevel(l) < SCENE_LEVEL ? { act: true } : {}),
      ...(l.character ? { character: l.character } : {}),
      ...(track && names.has(track) ? { track: names.get(track) } : {}),
      ...(l.note ? { note: l.note } : {}),
      text: l.text,
      ...(l.kind === 'dialogue' ? { recorded: !!l.recorded } : {}),
      ...(p ? { start: Math.round((p.start / sr) * 100) / 100, ...(p.end !== undefined ? { end: Math.round((p.end / sr) * 100) / 100 } : {}) } : {}),
      ...(l.take?.takes ? { takes: l.take.takes } : {}),
    };
  });
}
