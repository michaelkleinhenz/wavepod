import { describe, expect, it } from 'vitest';
import { addTrack, createProject, normalizeProject, rippleDelete } from '../src/core/project';
import {
  applyLineUp,
  autoCast,
  createScript,
  detectScriptFormat,
  lineAt,
  lineTokens,
  lineUpScript,
  parseScript,
  placedLines,
  removeScript,
  replaceScript,
  sceneStart,
  scriptCharacters,
  scriptProgress,
  scriptScenes,
  setCast,
  setLineRecorded,
  settleTakes,
  takeAt,
  takePosition,
} from '../src/core/script';
import { timelineWords } from '../src/core/transcript';
import type { Clip, FileTranscript, Project } from '../src/shared/types';

const SR = 48000;
const clip = (id: string, file: string, start: number, offset: number, length: number): Clip => ({ id, file, start, offset, length, gain: 0, fadeIn: 0, fadeOut: 0 });

const PLAIN = `Title: The Night Train

# Scene 1: Platform
Rain. A train pulls in.
ANNA: Is this the night train to Vienna?
BEN (whispering): It is. And it is late again.
Anna: Then we wait.
(She sits down.)

Scene 2: Compartment
BEN: Tickets, please.
ANNA:
I lost mine somewhere on the platform.
`;

const FOUNTAIN = `Title: The Night Train
Author: M. K.

INT. PLATFORM - NIGHT

Rain. A train pulls in.

ANNA
Is this the night train to Vienna?

BEN (V.O.)
(whispering)
It is. And it is *late* again.

CUT TO:

EXT. FIELD - NIGHT [[a note]]

ANNA (CONT'D)
Then we wait.
`;

const FDX = `<?xml version="1.0" encoding="UTF-8"?>
<FinalDraft DocumentType="Script" Version="4">
<Content>
<Paragraph Type="Scene Heading"><Text>INT. PLATFORM - NIGHT</Text></Paragraph>
<Paragraph Type="Action"><Text>Rain. A train pulls in.</Text></Paragraph>
<Paragraph Type="Character"><Text>ANNA</Text></Paragraph>
<Paragraph Type="Dialogue"><Text>Is this the night train </Text><Text Style="Italic">to Vienna?</Text></Paragraph>
<Paragraph Type="Character"><Text>BEN</Text></Paragraph>
<Paragraph Type="Parenthetical"><Text>(whispering)</Text></Paragraph>
<Paragraph Type="Dialogue"><Text>It is &amp; it is late.</Text></Paragraph>
</Content>
</FinalDraft>`;

describe('script import', () => {
  it('reads plain "CHARACTER: line" text with scenes, notes and directions', () => {
    const s = parseScript(PLAIN, 'night-train.txt');
    expect(s.format).toBe('plain');
    expect(s.title).toBe('The Night Train');
    expect(s.lines.map((l) => [l.kind, l.character ?? '', l.text])).toEqual([
      ['scene', '', 'Scene 1: Platform'],
      ['action', '', 'Rain. A train pulls in.'],
      ['dialogue', 'ANNA', 'Is this the night train to Vienna?'],
      ['dialogue', 'BEN', 'It is. And it is late again.'],
      // one spelling per character
      ['dialogue', 'ANNA', 'Then we wait.'],
      ['action', '', '(She sits down.)'],
      ['scene', '', 'Scene 2: Compartment'],
      ['dialogue', 'BEN', 'Tickets, please.'],
      ['dialogue', 'ANNA', 'I lost mine somewhere on the platform.'],
    ]);
    expect(s.lines[3].note).toBe('whispering');
  });

  it('does not take sentences or links for characters', () => {
    const s = parseScript('Anna and Ben left. Then: silence.\nSee https://example.com\nNote: record twice\n', 'x.txt');
    expect(s.lines.every((l) => l.kind === 'action')).toBe(true);
  });

  it('reads Fountain', () => {
    const s = parseScript(FOUNTAIN, 'night.fountain');
    expect(s.format).toBe('fountain');
    expect(s.title).toBe('The Night Train');
    expect(s.lines.map((l) => [l.kind, l.character ?? '', l.text, l.note ?? ''])).toEqual([
      ['scene', '', 'INT. PLATFORM - NIGHT', ''],
      ['action', '', 'Rain. A train pulls in.', ''],
      ['dialogue', 'ANNA', 'Is this the night train to Vienna?', ''],
      ['dialogue', 'BEN', 'It is. And it is late again.', 'V.O., whispering'],
      ['scene', '', 'EXT. FIELD - NIGHT', ''],
      ['dialogue', 'ANNA', 'Then we wait.', ''],
    ]);
  });

  it('recognises Fountain in a .txt file', () => {
    expect(detectScriptFormat(FOUNTAIN.replace(/^Title.*\nAuthor.*\n/, ''), 'night.txt')).toBe('fountain');
    expect(detectScriptFormat(PLAIN, 'night.txt')).toBe('plain');
  });

  it('reads Final Draft', () => {
    const s = parseScript(FDX, 'night.fdx');
    expect(s.format).toBe('fdx');
    expect(s.title).toBe('night');
    expect(s.lines.map((l) => [l.kind, l.character ?? '', l.text, l.note ?? ''])).toEqual([
      ['scene', '', 'INT. PLATFORM - NIGHT', ''],
      ['action', '', 'Rain. A train pulls in.', ''],
      ['dialogue', 'ANNA', 'Is this the night train to Vienna?', ''],
      ['dialogue', 'BEN', 'It is & it is late.', 'whispering'],
    ]);
  });

  it('lists characters, scenes and progress', () => {
    const p = createProject('T', SR);
    const script = createScript(p, parseScript(PLAIN, 'x.txt'));
    script.lines[2].recorded = true;
    expect(scriptCharacters(script).map((c) => [c.name, c.lines, c.recorded])).toEqual([
      ['ANNA', 3, 1],
      ['BEN', 2, 0],
    ]);
    expect(scriptScenes(script).map((s) => [s.title, s.lines, s.recorded])).toEqual([
      ['Scene 1: Platform', 3, 1],
      ['Scene 2: Compartment', 2, 0],
    ]);
    expect(scriptProgress(script)).toEqual({ lines: 5, recorded: 1 });
  });
});

describe('cast', () => {
  it('puts characters on the tracks named like them', () => {
    let p = createProject('T', SR);
    p = addTrack(p, { name: 'Anna' });
    p = addTrack(p, { name: 'Ben (Thomas)' });
    p = addTrack(p, { name: 'Music' });
    const script = createScript(p, parseScript(PLAIN, 'x.txt'));
    expect(script.cast).toEqual({ ANNA: p.tracks[0].id, BEN: p.tracks[1].id });
    const q = setCast({ ...p, script }, 'ben', p.tracks[2].id);
    expect(q.script!.cast.BEN).toBe(p.tracks[2].id);
    // a chosen track stays
    expect(autoCast(q.script!, q.tracks).BEN).toBe(p.tracks[2].id);
    expect(setCast(q, 'BEN', null).script!.cast.BEN).toBeUndefined();
  });
});

function recorded(): { p: Project; transcripts: Record<string, FileTranscript> } {
  let p = createProject('T', SR);
  p = addTrack(p, { name: 'Anna' });
  p = addTrack(p, { name: 'Ben' });
  p.tracks[0].clips.push(clip('a', 'media/anna.wav', 0, 0, 30 * SR));
  p.tracks[1].clips.push(clip('b', 'media/ben.wav', 0, 0, 30 * SR));
  p = { ...p, script: createScript(p, parseScript(PLAIN, 'x.txt')) };
  const words = (list: string, at: number, step = 0.4) =>
    list.split(' ').map((text, i) => ({ text, start: Math.round((at + i * step) * SR), end: Math.round((at + i * step + 0.3) * SR) }));
  const tr = (file: string, w: Array<{ text: string; start: number; end: number }>): FileTranscript => ({ version: 1, file, sampleRate: SR, language: 'en', model: 'scribe_v2', created: '', words: w });
  return {
    p,
    transcripts: {
      // Anna fluffs the first line, then says it again; "Then we wait." is short
      'media/anna.wav': tr('media/anna.wav', [
        ...words('Is this the night train to Venice?', 1),
        ...words('Is this the night train to Vienna?', 5),
        ...words('Then we wait.', 14),
        ...words('I lost mine somewhere on the platform.', 22),
      ]),
      'media/ben.wav': tr('media/ben.wav', [...words('It is, and it is late again.', 9), ...words('Tickets please.', 18), ...words('Then we wait.', 26)]),
    },
  };
}

describe('lining up with the transcript', () => {
  it('ignores directions in the line', () => {
    expect(lineTokens('Hello (laughs) there [door slams] — you!')).toEqual(['hello', 'there', 'you']);
  });

  it('finds each line on its character track, the last of the best takes', () => {
    const { p, transcripts } = recorded();
    const words = timelineWords(p, transcripts);
    const r = lineUpScript(p, words);
    const lines = p.script!.lines;
    const anna1 = r.found.get(lines[2].id)!;
    expect(anna1.start / SR).toBeCloseTo(5, 1);
    expect(anna1.file).toBe('media/anna.wav');
    expect(anna1.takes).toBe(2);
    expect(r.found.get(lines[3].id)!.start / SR).toBeCloseTo(9, 1);
    // short line found between its neighbours, on Anna's track (Ben says it too, later)
    const wait = r.found.get(lines[4].id)!;
    expect(wait.start / SR).toBeCloseTo(14, 1);
    expect(wait.file).toBe('media/anna.wav');
    expect(r.found.get(lines[7].id)!.start / SR).toBeCloseTo(18, 1);
    expect(r.found.get(lines[8].id)!.start / SR).toBeCloseTo(22, 1);
    expect(r.searched).toBe(5);

    const q = applyLineUp(p, r);
    expect(scriptProgress(q.script!)).toEqual({ lines: 5, recorded: 5 });
    const placed = placedLines(q);
    expect(placed.map((x) => x.index)).toEqual([2, 3, 4, 7, 8]);
    expect(lineAt(placed, 10 * SR, SR)).toBe(3);
    expect(sceneStart(q, 6, placed)! / SR).toBeCloseTo(18, 1);
  });

  it('keeps lines found through cuts, and loses the ones cut out', () => {
    const { p, transcripts } = recorded();
    const q = applyLineUp(p, lineUpScript(p, timelineWords(p, transcripts)));
    const cut = rippleDelete(q, 0, 4 * SR);
    const placed = placedLines(cut);
    expect(placed[0].start / SR).toBeCloseTo(1, 1);
    const gone = rippleDelete(q, 4.5 * SR, 8 * SR);
    expect(placedLines(gone).some((x) => x.index === 2)).toBe(false);
  });

  it('does not overwrite lines ticked by hand', () => {
    const { p, transcripts } = recorded();
    const id = p.script!.lines[2].id;
    const hand = setLineRecorded(p, id, true, takeAt(p, 1 * SR, undefined, p.tracks[0].id));
    const q = applyLineUp(hand, lineUpScript(hand, timelineWords(hand, transcripts)));
    expect(q.script!.lines[2].take!.from).toBe(SR);
    expect(q.script!.lines[2].take!.auto).toBeUndefined();
  });
});

describe('ticking lines', () => {
  it('keeps a take as file frames, or as a timeline position before the clip exists', () => {
    let p = createProject('T', SR);
    p = addTrack(p, { name: 'Anna' });
    p = { ...p, script: createScript(p, parseScript(PLAIN, 'x.txt')) };
    const id = p.script!.lines[2].id;
    // ticked while recording: no clip yet
    p = setLineRecorded(p, id, true, takeAt(p, 3 * SR, undefined, p.tracks[0].id));
    expect(p.script!.lines[2].take).toEqual({ from: 3 * SR });
    // the take's clip arrives (recorded from 2 s)
    p.tracks[0].clips.push(clip('c', 'media/take1.wav', 2 * SR, 0, 10 * SR));
    p = settleTakes(p);
    expect(p.script!.lines[2].take).toEqual({ file: 'media/take1.wav', from: SR });
    expect(takePosition(p, p.script!.lines[2].take!, p.tracks[0].id)!.start).toBe(3 * SR);
    p = setLineRecorded(p, id, false);
    expect(p.script!.lines[2].recorded).toBeUndefined();
    expect(p.script!.lines[2].take).toBeUndefined();
  });

  it('survives saving and loading, and a revised draft keeps what is recorded', () => {
    const { p, transcripts } = recorded();
    const q = applyLineUp(p, lineUpScript(p, timelineWords(p, transcripts)));
    const loaded = normalizeProject(JSON.parse(JSON.stringify(q)));
    expect(loaded.script).toEqual(q.script);
    const revised = parseScript(PLAIN.replace('Tickets, please.', 'Your tickets, please.'), 'x.txt');
    const r = replaceScript(loaded, createScript(loaded, revised));
    expect(scriptProgress(r.script!)).toEqual({ lines: 5, recorded: 4 });
    expect(removeScript(r).script).toBeUndefined();
    expect(normalizeProject(JSON.parse(JSON.stringify(removeScript(r)))).script).toBeUndefined();
  });
});
