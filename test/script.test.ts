import { describe, expect, it } from 'vitest';
import { addTrack, createProject, normalizeProject, rippleDelete } from '../src/core/project';
import {
  applyLineUp,
  autoCast,
  createScript,
  cutAroundTakes,
  detectScriptFormat,
  foldAllBut,
  foldedLines,
  headingLevel,
  headingsAbove,
  lineAt,
  lineTokens,
  lineUpScript,
  nameScriptClips,
  parseScript,
  placedLines,
  removeScript,
  replaceScript,
  sceneStart,
  scriptCharacters,
  scriptClipName,
  scriptProgress,
  scriptScenes,
  scriptSummary,
  sectionEnd,
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

  it('reads a PlotGod audioplay export', () => {
    const scene = (title: string, order: number, content: string) => ({ Meta: { id: `s${order}`, title, order }, Content: content });
    const json = JSON.stringify({
      version: 1,
      project: { name: 'Das Echo', type: 'audioplay' },
      chapters: [
        {
          Chapter: { title: 'Akt 2 - Fetzen', order: 1 },
          Scenes: [scene('Szene 3', 0, '# Szene 3\n\n**SARAH:**\nIch bin hier.')],
        },
        {
          Chapter: { title: 'Akt 1 - Der Anruf', order: 0 },
          Scenes: [
            scene('Szene 2 - Rat', 1, 'HARTMANN: (warm)\nSarah! Komm herein.'),
            scene(
              'Szene 1 - Abend',
              0,
              '# Szene 1 - Abend\n\nSZENE 1 - PRAXIS - ABEND\n\n[SFX: Telefon klingelt]\n\nSARAH: (professionell)\nPraxis Dr. Meyer.\nGuten Abend.\n\n[Pause]\n\nDIE STIMME:\nSarah...',
            ),
          ],
        },
      ],
      characters: [{ name: 'DR. SARAH MEYER' }],
    });
    expect(detectScriptFormat(json, 'Das_Echo.json')).toBe('plotgod');
    const s = parseScript(json, 'Das_Echo.json');
    expect(s.format).toBe('plotgod');
    expect(s.title).toBe('Das Echo');
    expect(s.lines.map((l) => [l.kind, l.character ?? '', l.text, l.note ?? ''])).toEqual([
      ['scene', '', 'Akt 1 - Der Anruf', ''],
      ['scene', '', 'SZENE 1 - PRAXIS - ABEND', ''],
      ['action', '', 'SFX: Telefon klingelt', ''],
      ['dialogue', 'SARAH', 'Praxis Dr. Meyer. Guten Abend.', 'professionell'],
      ['action', '', 'Pause', ''],
      ['dialogue', 'DIE STIMME', 'Sarah...', ''],
      ['scene', '', 'Szene 2 - Rat', ''],
      ['dialogue', 'HARTMANN', 'Sarah! Komm herein.', 'warm'],
      ['scene', '', 'Akt 2 - Fetzen', ''],
      ['scene', '', 'Szene 3', ''],
      ['dialogue', 'SARAH', 'Ich bin hier.', ''],
    ]);
  });

  it('leaves other JSON alone', () => {
    expect(detectScriptFormat('{"chapters": "none"}', 'x.json')).not.toBe('plotgod');
    expect(parseScript('{"a": 1}', 'x.json').lines.filter((l) => l.kind === 'dialogue')).toEqual([]);
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

  it('finds every take of a line recorded one after another', () => {
    const { p, transcripts } = recorded();
    const r = lineUpScript(p, timelineWords(p, transcripts));
    const lines = p.script!.lines;
    const takes = r.occurrences.get(lines[2].id)!;
    expect(takes.map((o) => Math.round(o.start / SR))).toEqual([1, 5]);
    expect(takes.every((o) => o.trackId === p.tracks[0].id)).toBe(true);
    // the fluffed take ends on its misheard last word ("Venice"), not before it
    expect(takes[0].end / SR).toBeCloseTo(3.7, 2);
    // a little room around each take, but never into the words of the take next to it
    const [a, b] = takes;
    expect(a.cutStart).toBe(Math.round(0.75 * SR));
    expect(a.cutEnd).toBeGreaterThan(a.end);
    expect(a.cutEnd).toBeLessThanOrEqual(b.cutStart);
    expect(b.cutStart).toBeLessThan(b.start);
    expect(b.cutEnd).toBe(b.end + Math.round(0.35 * SR));
    expect(r.occurrences.get(lines[3].id)).toHaveLength(1);
  });

  it('cuts before and after each take, removing nothing', () => {
    const { p, transcripts } = recorded();
    const r = lineUpScript(p, timelineWords(p, transcripts));
    const takes = r.occurrences.get(p.script!.lines[2].id)!;
    const res = cutAroundTakes(p, takes);
    const anna = res.project.tracks[0].clips;
    expect(res.cuts).toBe(4);
    expect(anna).toHaveLength(5);
    // the pieces still play the same audio, end to end, without gaps or fades
    for (let k = 1; k < anna.length; k++) {
      expect(anna[k].start).toBe(anna[k - 1].start + anna[k - 1].length);
      expect(anna[k].offset - anna[k].start).toBe(anna[0].offset - anna[0].start);
    }
    expect(anna.reduce((n, c) => n + c.length, 0)).toBe(30 * SR);
    expect(anna.map((c) => c.start)).toEqual([0, takes[0].cutStart, takes[0].cutEnd, takes[1].cutStart, takes[1].cutEnd].sort((x, y) => x - y));
    // Ben's track is left alone; the clips holding the takes come back to select
    expect(res.project.tracks[1].clips).toEqual(p.tracks[1].clips);
    expect(res.clipIds).toEqual([anna[1].id, anna[3].id]);
    // a second time there's nothing left to cut
    const again = cutAroundTakes(res.project, takes);
    expect(again.cuts).toBe(0);
    expect(again.project).toBe(res.project);
    expect(again.clipIds).toEqual(res.clipIds);
  });

  it('leaves no slivers at clip edges', () => {
    const { p, transcripts } = recorded();
    const takes = lineUpScript(p, timelineWords(p, transcripts)).occurrences.get(p.script!.lines[2].id)!;
    const edge = { ...takes[0], cutStart: 5, cutEnd: takes[0].cutEnd };
    expect(cutAroundTakes(p, [edge]).cuts).toBe(1);
  });

  it('splits contractions and leaves out hesitations and laughing', () => {
    expect(lineTokens("Ähm, don't you think we'll make it? Haha!")).toEqual(['do', 'not', 'you', 'think', 'we', "'ll", 'make', 'it']);
    expect(lineTokens('I cannot – it’s gone, umm, gone.')).toEqual(['i', 'can', 'not', 'it', "'s", 'gone', 'gone']);
  });

  it('finds lines said a bit differently: hesitations, laughing, contractions, other words', () => {
    const { p } = recorded();
    const words = (list: string, at: number) =>
      list.split(' ').map((text, i) => ({ text, start: Math.round((at + i * 0.4) * SR), end: Math.round((at + i * 0.4 + 0.3) * SR) }));
    const tr = (file: string, w: Array<{ text: string; start: number; end: number }>): FileTranscript => ({ version: 1, file, sampleRate: SR, language: 'en', model: 'scribe_v2', created: '', words: w });
    const transcripts = {
      'media/anna.wav': tr('media/anna.wav', [
        ...words('(laughs) Haha, umm, is this the night train to Vienna?', 1),
        ...words("Then we'll just wait.", 14),
        ...words('I lost my ticket somewhere on the platforms.', 22),
      ]),
      'media/ben.wav': tr('media/ben.wav', [...words("It's, uh, it's late again.", 9), ...words('Umm, tickets, uh, please.', 18)]),
    };
    const r = lineUpScript(p, timelineWords(p, transcripts));
    const lines = p.script!.lines;
    // the take starts at the first word of the line, after the laugh and the "umm"
    expect(r.found.get(lines[2].id)!.start / SR).toBeCloseTo(1 + 3 * 0.4, 1);
    expect(r.found.get(lines[3].id)!.start / SR).toBeCloseTo(9, 1);
    expect(r.found.get(lines[4].id)!.start / SR).toBeCloseTo(14, 1);
    expect(r.found.get(lines[7].id)!.start / SR).toBeCloseTo(18 + 0.4, 1);
    expect(r.found.get(lines[8].id)!.start / SR).toBeCloseTo(22, 1);
    // the cut before a take keeps clear of the hesitation in front of it
    const take = r.occurrences.get(lines[7].id)![0];
    expect(take.cutStart).toBeGreaterThan(Math.round((18 + 0.3) * SR));
  });

  it('still does not match lines that were not said', () => {
    const { p } = recorded();
    const tr = (file: string, text: string): FileTranscript => ({
      version: 1,
      file,
      sampleRate: SR,
      language: 'en',
      model: 'scribe_v2',
      created: '',
      words: text.split(' ').map((t, i) => ({ text: t, start: Math.round((1 + i * 0.4) * SR), end: Math.round((1 + i * 0.4 + 0.3) * SR) })),
    });
    const r = lineUpScript(p, timelineWords(p, { 'media/anna.wav': tr('media/anna.wav', 'Is that the late bus to Berlin, umm, again?') }));
    expect(r.found.size).toBe(0);
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

describe('acts and folding', () => {
  const ACTS = `Title: Two Acts

Act 1: Departure
Scene 1: Platform
ANNA: Is this the night train?
Scene 2: Compartment
BEN: Tickets, please.
ANNA: Here.

Act 2: Arrival
Scene 3: Vienna
BEN: We are here.
`;

  it('tells acts from scenes in every format', () => {
    const plain = parseScript(ACTS, 'x.txt').lines.filter((l) => l.kind === 'scene');
    expect(plain.map((l) => [l.text, headingLevel(l)])).toEqual([
      ['Act 1: Departure', 1],
      ['Scene 1: Platform', 9],
      ['Scene 2: Compartment', 9],
      ['Act 2: Arrival', 1],
      ['Scene 3: Vienna', 9],
    ]);
    const fountain = parseScript('# Act One\n\n## Sequence\n\nINT. TRAIN - NIGHT\n\nANNA\nHello.\n', 'x.fountain').lines.filter((l) => l.kind === 'scene');
    expect(fountain.map((l) => headingLevel(l))).toEqual([1, 2, 9]);
    const fdx = parseScript('<FinalDraft><Content><Paragraph Type="New Act"><Text>ACT ONE</Text></Paragraph><Paragraph Type="Scene Heading"><Text>INT. TRAIN</Text></Paragraph><Paragraph Type="Character"><Text>ANNA</Text></Paragraph><Paragraph Type="Dialogue"><Text>Hi.</Text></Paragraph></Content></FinalDraft>', 'x.fdx').lines;
    expect(fdx.map((l) => [l.kind, headingLevel(l)])).toEqual([
      ['scene', 1],
      ['scene', 9],
      ['dialogue', 0],
    ]);
    // PlotGod chapters are acts, whatever they are called
    const json = JSON.stringify({
      project: { name: 'P' },
      chapters: [
        { Chapter: { title: 'Der Anfang', order: 0 }, Scenes: [{ Meta: { title: 'Szene 1', order: 0 }, Content: 'SARAH: Hallo.' }] },
        { Chapter: { title: 'Das Ende', order: 1 }, Scenes: [{ Meta: { title: 'Szene 2', order: 0 }, Content: 'SARAH: Tschüss.' }] },
      ],
    });
    expect(parseScript(json, 'p.json').lines.filter((l) => l.kind === 'scene').map((l) => [l.text, headingLevel(l)])).toEqual([
      ['Der Anfang', 1],
      ['Szene 1', 9],
      ['Das Ende', 1],
      ['Szene 2', 9],
    ]);
  });

  it('counts an act over its scenes and jumps to its first take', () => {
    const p = createProject('T', SR);
    const script = createScript(p, parseScript(ACTS, 'x.txt'));
    script.lines[4].recorded = true;
    expect(scriptScenes(script).map((s) => [s.title, s.level ?? 0, s.lines, s.recorded])).toEqual([
      ['Act 1: Departure', 1, 3, 1],
      ['Scene 1: Platform', 0, 1, 0],
      ['Scene 2: Compartment', 0, 2, 1],
      ['Act 2: Arrival', 1, 1, 0],
      ['Scene 3: Vienna', 0, 1, 0],
    ]);
    const lines = script.lines;
    expect(sectionEnd(lines, 0)).toBe(6); // act 1 runs to act 2
    expect(sectionEnd(lines, 1)).toBe(3); // scene 1 to scene 2
    expect(sectionEnd(lines, 7)).toBe(lines.length);
    const q = { ...p, script };
    expect(sceneStart(q, 0, [{ index: 4, start: 5 * SR }, { index: 2, start: 9 * SR }])).toBe(5 * SR);
    expect(scriptSummary(q).filter((l) => l.act).map((l) => l.text)).toEqual(['Act 1: Departure', 'Act 2: Arrival']);
  });

  it('folds an act with its scenes, or everything but the current scene', () => {
    const p = createProject('T', SR);
    const lines = createScript(p, parseScript(ACTS, 'x.txt')).lines;
    const shown = (folded: Set<string>) =>
      foldedLines(lines, folded)
        .map((hidden, i) => (hidden ? null : lines[i].text))
        .filter(Boolean);
    expect(shown(new Set([lines[0].id]))).toEqual(['Act 1: Departure', 'Act 2: Arrival', 'Scene 3: Vienna', 'We are here.']);
    expect(shown(new Set([lines[3].id]))).toEqual(['Act 1: Departure', 'Scene 1: Platform', 'Is this the night train?', 'Scene 2: Compartment', 'Act 2: Arrival', 'Scene 3: Vienna', 'We are here.']);
    expect(headingsAbove(lines, 4)).toEqual([0, 3]);
    const focus = foldAllBut(lines, 4);
    expect(shown(focus)).toEqual(['Act 1: Departure', 'Scene 1: Platform', 'Scene 2: Compartment', 'Tickets, please.', 'Here.', 'Act 2: Arrival']);
  });

  it('keeps act levels through saving and loading', () => {
    const p = createProject('T', SR);
    const q = { ...p, script: createScript(p, parseScript('# Act One\n\nINT. TRAIN\n\nANNA\nHello.\n', 'x.fountain')) };
    const loaded = normalizeProject(JSON.parse(JSON.stringify(q)));
    expect(loaded.script).toEqual(q.script);
    expect(loaded.script!.lines[0].level).toBe(1);
  });
});

describe('clip names from the script', () => {
  it('names a clip by role and first words, cut at a word', () => {
    expect(scriptClipName({ character: 'ANNA', text: 'Is this the night train to Vienna?' })).toBe('ANNA: Is this the night train…');
    expect(scriptClipName({ character: 'BEN', text: 'Tickets, please.' })).toBe('BEN: Tickets, please.');
    expect(scriptClipName({ character: 'ANNA', text: 'Is this the night train to Vienna?' }, 16)).toBe('ANNA: Is this…');
    expect(scriptClipName({ character: 'BEN', text: 'Donaudampfschifffahrtsgesellschaft' }, 16)).toBe('BEN: Donaudampf…');
    // never longer than the limit
    for (const max of [10, 20, 32]) expect(scriptClipName({ character: 'DR. SARAH MEYER', text: 'Well, well, well. Look who finally decided to show up.' }, max).length).toBeLessThanOrEqual(max);
  });

  it('names the pieces holding each take when cutting around takes', () => {
    const { p, transcripts } = recorded();
    const r = lineUpScript(p, timelineWords(p, transcripts));
    const takes = r.occurrences.get(p.script!.lines[2].id)!;
    const res = cutAroundTakes(p, takes);
    const anna = res.project.tracks[0].clips;
    expect(anna.map((c) => c.name)).toEqual([undefined, 'ANNA: Is this the night train…', undefined, 'ANNA: Is this the night train…', undefined]);
    // a name the user gives a take stays when cutting again
    const renamed = { ...res.project, tracks: res.project.tracks.map((t, i) => (i ? t : { ...t, clips: t.clips.map((c, k) => (k === 3 ? { ...c, name: 'Keep this one' } : c)) })) };
    expect(cutAroundTakes(renamed, takes).project.tracks[0].clips[3].name).toBe('Keep this one');
  });

  it('names a clip that holds exactly one found line, not one with several', () => {
    const { p, transcripts } = recorded();
    // Ben's line is a clip of its own; Anna's track is one long clip with every line
    p.tracks[1].clips = [
      { id: 'b1', file: 'media/ben.wav', start: 8 * SR, offset: 8 * SR, length: 4 * SR, gain: 0, fadeIn: 0, fadeOut: 0 },
      { id: 'b2', file: 'media/ben.wav', start: 17 * SR, offset: 17 * SR, length: 13 * SR, gain: 0, fadeIn: 0, fadeOut: 0 },
    ];
    const q = applyLineUp(p, lineUpScript(p, timelineWords(p, transcripts)));
    expect(q.tracks[0].clips[0].name).toBeUndefined();
    expect(q.tracks[1].clips[0].name).toBe('BEN: It is. And it is late…');
    // Tickets, please. is short and the clip is long
    expect(q.tracks[1].clips[1].name).toBeUndefined();
    // a name already there is kept
    const named = { ...p, tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, clips: t.clips.map((c) => ({ ...c, name: 'Mine' })) } : t)) };
    expect(nameScriptClips(applyLineUp(named, lineUpScript(named, timelineWords(named, transcripts)))).tracks[1].clips[0].name).toBe('Mine');
  });
});
