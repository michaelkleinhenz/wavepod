import { describe, expect, it } from "vitest";
import { addTrack, createProject, normalizeProject } from "../src/core/project";
import { addFolder } from "../src/core/folders";
import {
  applyLineUp,
  createScript,
  cutAroundTakes,
  lineUpScript,
  parseScript,
  placedLines,
  scriptSummary,
} from "../src/core/script";
import {
  characterRole,
  characterTrack,
  characterTrackName,
  ensureCharacterTrack,
  ensureCharacterTracks,
  routeLines,
  rolesSummary,
  setCharacterRoom,
  setCharacterTrack,
  setCharacterVoice,
} from "../src/core/characterRouting";
import { createFx } from "../src/core/fx/definitions";
import { timelineWords } from "../src/core/transcript";
import type { Clip, FileTranscript, Project } from "../src/shared/types";

const SR = 48000;
const clip = (
  id: string,
  file: string,
  start: number,
  offset: number,
  length: number,
): Clip => ({
  id,
  file,
  start,
  offset,
  length,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
});

const SCRIPT = `Title: Night Train

INT. COMPARTMENT - NIGHT

ANNA: Is this the night train to Vienna?
CONDUCTOR: It is, and it is late again.
ANNA: Where is the dining car tonight?
`;

const words = (list: string, at: number, step = 0.4) =>
  list
    .split(" ")
    .map((text, i) => ({
      text,
      start: Math.round((at + i * step) * SR),
      end: Math.round((at + i * step + 0.3) * SR),
    }));
const tr = (
  file: string,
  w: Array<{ text: string; start: number; end: number }>,
): FileTranscript => ({
  version: 1,
  file,
  sampleRate: SR,
  language: "en",
  model: "scribe_v2",
  created: "",
  words: w,
});

/** One microphone, one long recording with both characters' lines, plus a separately recorded pickup of Anna. */
function session(): {
  p: Project;
  transcripts: Record<string, FileTranscript>;
} {
  let p = createProject("T", SR);
  p = addTrack(p, {
    id: "mic",
    name: "Mic 1",
    fx: [createFx("highpass"), createFx("deesser")],
  });
  p.tracks[0].clips.push(
    clip("long", "media/scene.wav", 0, 0, 20 * SR),
    clip("pickup", "media/pickup.wav", 30 * SR, 0, 4 * SR),
  );
  p = { ...p, script: createScript(p, parseScript(SCRIPT, "x.txt")) };
  // both characters are recorded on the microphone
  p = {
    ...p,
    script: { ...p.script!, cast: { ANNA: "mic", CONDUCTOR: "mic" } },
  };
  return {
    p,
    transcripts: {
      "media/scene.wav": tr("media/scene.wav", [
        ...words("Is this the night train to Vienna?", 1),
        ...words("It is, and it is late again.", 6),
      ]),
      "media/pickup.wav": tr(
        "media/pickup.wav",
        words("Where is the dining car tonight?", 0.5),
      ),
    },
  };
}

describe("character tracks", () => {
  it("names tracks after the character", () => {
    expect(characterTrackName("DR. SARAH MEYER")).toBe("Dr. Sarah Meyer");
    expect(characterTrackName("ANNA-LENA")).toBe("Anna-Lena");
    expect(characterTrackName("McGuffin")).toBe("McGuffin");
  });

  it("makes a track per character with a copy of the recording track filters, in its folder", () => {
    let { p } = session();
    p = addFolder(p, { name: "Dialogue", trackIds: ["mic"] });
    const r = ensureCharacterTracks(p);
    expect(r.created).toBe(2);
    const anna = characterTrack(r.project, "Anna")!;
    expect(anna.name).toBe("Anna");
    expect(anna.stem).toBe("dialogue");
    expect(anna.folderId).toBe(p.folders![0].id);
    expect(anna.fx!.map((f) => f.type)).toEqual(["highpass", "deesser"]);
    expect(anna.fx![0].id).not.toBe(p.tracks[0].fx![0].id);
    expect(characterTrack(r.project, "CONDUCTOR")!.name).toBe("Conductor");
    // a second time nothing new is made
    expect(ensureCharacterTracks(r.project).created).toBe(0);
  });

  it("uses a track already named after the character", () => {
    let { p } = session();
    p = addTrack(p, { id: "annamic", name: "Anna" });
    const r = ensureCharacterTrack(p, "ANNA");
    expect(r.created).toBe(false);
    expect(r.trackId).toBe("annamic");
    expect(r.project.tracks).toHaveLength(2);
  });

  it("sets a voice before the room and swaps only what it added", () => {
    let { p } = session();
    p = setCharacterRoom(p, "Anna", "living-room");
    // the room made the track
    let t = characterTrack(p, "ANNA")!;
    expect(t.fx!.map((f) => f.type)).toEqual(["highpass", "deesser", "space"]);
    p = setCharacterVoice(p, "ANNA", "telephone");
    t = characterTrack(p, "ANNA")!;
    expect(t.fx!.map((f) => f.type)).toEqual([
      "highpass",
      "deesser",
      "bandpass",
      "distortion",
      "compressor",
      "space",
    ]);
    p = setCharacterVoice(p, "ANNA", "robot");
    t = characterTrack(p, "ANNA")!;
    expect(t.fx!.map((f) => f.type)).toEqual([
      "highpass",
      "deesser",
      "ringmod",
      "bandpass",
      "compressor",
      "space",
    ]);
    p = setCharacterRoom(p, "ANNA", "place-car");
    t = characterTrack(p, "ANNA")!;
    expect(t.fx!.at(-1)!.preset?.name).toBe("Car");
    expect(t.fx!.filter((f) => f.type === "space")).toHaveLength(1);
    expect(characterRole(p, "Anna")).toMatchObject({
      voice: "robot",
      room: "place-car",
    });
    p = setCharacterVoice(p, "ANNA", null);
    p = setCharacterRoom(p, "ANNA", null);
    expect(characterTrack(p, "ANNA")!.fx!.map((f) => f.type)).toEqual([
      "highpass",
      "deesser",
    ]);
    expect(() => setCharacterVoice(p, "ANNA", "place-car")).toThrow();
    expect(() => setCharacterRoom(p, "ANNA", "telephone")).toThrow();
  });

  it("survives saving and loading", () => {
    let { p } = session();
    p = setCharacterVoice(p, "ANNA", "giant");
    const back = normalizeProject(JSON.parse(JSON.stringify(p)));
    expect(back.script!.roles).toEqual(p.script!.roles);
    expect(rolesSummary(back)[0]).toMatchObject({
      name: "ANNA",
      track: "Mic 1",
      characterTrack: "Anna",
      voice: "giant",
    });
  });

  it("a removed character track is no longer used", () => {
    let { p } = session();
    p = ensureCharacterTrack(p, "ANNA").project;
    const id = characterTrack(p, "ANNA")!.id;
    p = { ...p, tracks: p.tracks.filter((t) => t.id !== id) };
    expect(characterTrack(p, "ANNA")).toBeUndefined();
    expect(characterRole(p, "ANNA").trackId).toBeUndefined();
    expect(setCharacterTrack(p, "ANNA", null).script!.roles).toBeUndefined();
  });
});

describe("routing lines to character tracks", () => {
  it("moves a clip with one character’s line after Line up, leaves a mixed recording alone", () => {
    const { p: base, transcripts } = session();
    const p = ensureCharacterTracks(base).project;
    const r = lineUpScript(p, timelineWords(p, transcripts));
    expect(r.found.size).toBe(3);
    const res = routeLines(
      applyLineUp(p, r),
      [...r.occurrences.values()].flat(),
    );
    expect(res.moved).toBe(1);
    expect(res.clipIds).toEqual(["pickup"]);
    const anna = characterTrack(res.project, "ANNA")!;
    expect(anna.clips.map((c) => [c.id, c.start])).toEqual([
      ["pickup", 30 * SR],
    ]);
    expect(
      res.project.tracks.find((t) => t.id === "mic")!.clips.map((c) => c.id),
    ).toEqual(["long"]);
    // the line is still found where it went
    const lines = res.project.script!.lines;
    const placed = placedLines(res.project);
    expect(
      placed.find((x) => lines[x.index].text.startsWith("Where"))!.start,
    ).toBe(Math.round(30.5 * SR));
    expect(
      scriptSummary(res.project).find((l) =>
        String(l.text).startsWith("Where"),
      ),
    ).toMatchObject({ track: "Mic 1", characterTrack: "Anna" });
  });

  it("moves every take after Cut Around, at the same time", () => {
    const { p: base, transcripts } = session();
    const p = ensureCharacterTracks(base).project;
    const r = lineUpScript(p, timelineWords(p, transcripts));
    const takes = [...r.occurrences.values()].flat();
    const cut = cutAroundTakes(applyLineUp(p, r), takes);
    const res = routeLines(cut.project, takes);
    const anna = characterTrack(res.project, "ANNA")!;
    const conductor = characterTrack(res.project, "CONDUCTOR")!;
    expect(anna.clips).toHaveLength(2);
    expect(conductor.clips).toHaveLength(1);
    expect(anna.clips[0].start).toBeLessThan(1 * SR);
    expect(conductor.clips[0].start).toBeGreaterThan(5 * SR);
    expect(conductor.clips[0].start).toBeLessThan(6 * SR);
    // what was between and after the lines stays on the microphone track
    const mic = res.project.tracks.find((t) => t.id === "mic")!;
    expect(mic.clips.length).toBeGreaterThan(0);
    const total = (ps: Project) =>
      ps.tracks.reduce(
        (n, t) => n + t.clips.reduce((m, c) => m + c.length, 0),
        0,
      );
    expect(total(res.project)).toBe(total(cut.project));

    // lining up again finds the lines on the character tracks, and there's nothing left to move
    const again = lineUpScript(
      res.project,
      timelineWords(res.project, transcripts),
    );
    expect(again.found.size).toBe(3);
    expect(
      routeLines(
        applyLineUp(res.project, again),
        [...again.occurrences.values()].flat(),
      ).moved,
    ).toBe(0);
  });

  it("moves the lines found so far when asked, and nothing without character tracks", () => {
    const { p, transcripts } = session();
    const found = applyLineUp(
      p,
      lineUpScript(p, timelineWords(p, transcripts)),
    );
    expect(routeLines(found).moved).toBe(0);
    const withTracks = ensureCharacterTracks(found).project;
    const res = routeLines(withTracks);
    expect(res.moved).toBe(1);
    expect(characterTrack(res.project, "ANNA")!.clips.map((c) => c.id)).toEqual(
      ["pickup"],
    );
  });

  it("leaves a clip much longer than its line where it is", () => {
    let { p, transcripts } = session();
    p = {
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.id === "pickup" ? { ...c, length: 40 * SR } : c,
        ),
      })),
    };
    p = ensureCharacterTracks(p).project;
    const r = lineUpScript(p, timelineWords(p, transcripts));
    expect(
      routeLines(applyLineUp(p, r), [...r.occurrences.values()].flat()).moved,
    ).toBe(0);
  });
});
