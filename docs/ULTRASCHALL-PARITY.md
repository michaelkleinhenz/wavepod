# WavePod – Ultraschall feature parity plan

This document compares WavePod with [Ultraschall](https://ultraschall.fm/)
5.1.1 and lays out, in priority order, which missing features WavePod should
add. The guiding rule from [PLAN.md](PLAN.md) still holds: WavePod is a
standalone app with no Reaper, no screensets, no action lists and no plugin
installation. Where Ultraschall solves something with Reaper's generic
machinery (routing matrix, docks, layouts, action editor), WavePod should
solve the podcaster's actual problem with one focused feature, or leave it to
the audio interface.

Sources: the [Ultraschall feature page](https://ultraschall.fm/) and the
[Ultraschall manual](https://ultraschall.github.io/ultraschall-manual/)
(GUI overview, recording, editing, export, navigation & settings chapters).

## 1. What WavePod already covers

| Ultraschall | WavePod today |
| --- | --- |
| Multitrack recording, one track per speaker | ✅ Native multichannel via RtAudio, device profiles, "Create speaker tracks" |
| Automatic track colours | ✅ |
| Chapter markers while recording (`M`) | ✅ (`M`), chapter list with title + URL |
| Edit markers (`E`) | ✅ |
| Soundboard for jingles | ✅ 12 slots, keys `1`–`9` (but not recorded, see below) |
| Non-destructive editing, undo | ✅ |
| Split (`S`), fades by dragging, ripple cut across all tracks | ✅ split, trim, fades by dragging clip corners, ripple cut (`Ctrl+X`), resizable time selection, snapping to clip edges |
| Volume envelope, mute a selection (`Ctrl+Y`) | ✅ volume line per clip with points, `Ctrl+Y` bends it to silence the selected range |
| Mute/solo per track | ✅ |
| Loudness normalisation | ✅ EBU R128 to −16 / −19 / −23 LUFS (Ultraschall: ~−18 LUFS), at export and per clip |
| Loudness analysis (integrated, LRA, short-term / momentary max, true peak) | ✅ Loudness analysis of the mix, each track or selected clips, with a short-term curve |
| MP3 export with metadata and chapters | ✅ ID3v2 + CHAP/CTOC |
| Chapter export for Podlove / Auphonic | ✅ PSC, Podcasting 2.0 JSON, mp4chaps, Audacity labels |
| Multitrack / stems export (e.g. for Auphonic) | ✅ stems |
| Export a time selection | ✅ |
| WAV recording | ✅ crash-safe, 16/24/32-bit |
| Auto-follow during playback/recording | ✅ |

## 2. Gaps

Grouped by the Ultraschall workflow phases. "Plan" says what WavePod does
about it; the priority is explained in section 3.

### Recording

| Ultraschall feature | Gap in WavePod | Plan |
| --- | --- | --- |
| Soundboard is a track: jingles end up in the recording; fade-in, loop, stop, per-clip volume, remaining time | Jingles play out of the output device only and are not part of the project, so they are missing from the edit and the export (unless the interface happens to loop them back) | **P1** Record each trigger as a clip on a "Soundboard" track; per slot fade-in, loop, remaining-time display |
| Throat-clearing buttons (Räuspertasten): per-speaker mute while recording; audio is still recorded and the mute can be edited later | Missing | **P1** Hold-to-mute "cough" key per track that writes mute regions (non-destructive), editable on the timeline |
| Big level meters with numeric peak and the −18…−6 dB target zone highlighted | ✅ Larger meters in Setup and on every track with the −18…−6 dBFS zone, peak-hold mark, highest peak as a number and a clip light (click to reset) | Done |
| Soundcheck before recording (48 kHz, unsaved project, internal mic, duplicate inputs, block size, recording in the middle of a project, unknown interface) | ✅ Before each recording: no input, no armed track, sample rate ≠ 48 kHz, two tracks on one input, built-in mic, disk space for less than 2 h, recording before the end of the episode. Warnings can be ignored per episode | Done |
| "Prepare all tracks for editing": unarm all tracks after recording, reminded by the soundcheck | ✅ Edit menu, toolbar and MIDI action; optional "Prepare for Editing When Recording Stops"; reminder after a take while tracks stay armed | Done |
| Recording safe mode (confirm accidental stop) | ✅ Edit › Confirm Before Stopping a Recording (on by default) | Done |
| Jump back to the recording position (`Y`) | ✅ `Y`: to where the last take stopped, or to the take being recorded | Done |
| Named chapter marker while recording (`Shift+M`) | ✅ `Shift+M` drops a chapter and opens a title field that doesn't interrupt the recording | Done |
| Soundboard ducking / ducking track (jingles duck under speech) | ✅ Any track (Soundboard, music bed) can duck under the other tracks: its FX panel has "Duck under the other tracks" and a depth (−6…−24 dB). Playback and export; jingles played live while recording are not ducked (the interface can do that) | Done |
| Remote control via MIDI and OSC (cough buttons, markers, soundboard, transport); iOS / Wiimote / Stream Deck via Bitfocus Companion | Missing | **P3** MIDI (Web MIDI) and OSC (UDP in main) mapping to WavePod actions |
| FLAC recording | WAV only | Not planned for recording (WAV is what makes recording crash-safe); FLAC in export and "compact project", see P2 |
| StudioLink remote guests, Skype/Mumble N‑1, HUB sound driver, routing matrix with pre-show/live/post-show presets | Out of scope per PLAN.md | **P3, small**: simple output routing presets (which tracks and the soundboard go to which output pair). Mix-minus stays in the hardware (RØDECaster USB Chat) |
| StudioLink OnAir live streaming | Missing | Not planned |

### Editing / production

| Ultraschall feature | Gap in WavePod | Plan |
| --- | --- | --- |
| Check cuts: jump to next/previous clip edge or edit marker and play with preroll | ✅ `Alt+←/→` clip edges, `Shift+Alt+←/→` markers, `P` plays 2 s before to 2 s after the playhead and returns | Done (pre/postroll fixed at 2 s) |
| Zoom to selection and back (`Shift+Z`), zoom whole project | ✅ `Shift+Z` zooms to the selected range or clips and back; "Zoom to fit" shows the whole episode | Done |
| Copy/cut/paste of clips and ranges; ripple cut on `Ctrl+X` | Delete and ripple delete only, no clipboard | **P2** Clipboard for clips and time ranges (paste at playhead, ripple insert) |
| Ripple editing modes when moving clips (off / per track / all tracks) | Moving a clip never shifts others | **P2** Modifier-drag: move clip plus everything after it on the track or on all tracks, markers follow in all-tracks mode |
| Automatic crossfade when clips overlap, fade curve shapes | ✅ Overlapping clips on a track crossfade with equal-power curves (drawn in yellow); double-click a fade handle to switch linear / equal power / S-curve | Done |
| Variable playback speed with constant pitch for listening through | ✅ Speed selector next to the clock: 1×, 1.25×, 1.5×, 1.75×, 2× (WSOLA, pitch kept; recording and export stay at 1×) | Done |
| Per-track podcast effects: expander/gate, compressor, limiter, parametric EQ, De-esser, Ultraschall Dynamics; optional noise filter | ✅ Done: filter stacks on every track and the master | **P1, done** Filter stack per track and on the master (add, bypass, edit, reorder by drag or arrows): high-pass, EQ, noise gate, compressor, de-esser, limiter and a port of Ultraschall Dynamics; live and in export. VST3 plug-ins in the same stack (generated sliders, no plug-in editors). Noise reduction and reverb later |
| Normalise selected clips (`Alt+Shift+N`) | ✅ Done | **P2, done** Clip loudness normalisation via clip gain (`Alt+Shift+N`), to the target chosen in the loudness analysis |
| Mute envelopes (`Ctrl+Y`) for removing noises without cutting | Missing | Comes with the P1 cough mute regions, which are editable on any track |
| Drag-and-drop media import, drop on empty space creates a track | Import via menu | **P2** |
| Marker ping when the playhead passes a marker | Missing | **P3** Optional |
| Project backups every 10 minutes | ✅ `backup/` in the project folder: every 10 minutes when something changed and before each recording, newest 20 kept, File › Restore Backup… (undoable) | Done |
| Distraction-free editing mode, customisable shortcuts, shortcut list | Fixed shortcuts | **P3** Shortcut overlay (`?`); customisable keymap later |
| Storyboard: keyword tags on clip sections, colours, comments, regions, free text notes, navigator | Missing | **P3, reduced**: clip colours/notes and a project overview strip (navigator). Tag search across projects is not planned |
| Double-ender: guest's local backup recording replaces the remote track | Missing | **P2** Import a guest's local file and auto-align it to the remote track by cross-correlation |

### Export

| Ultraschall feature | Gap in WavePod | Plan |
| --- | --- | --- |
| Episode artwork (JPG/PNG) in the MP3, recently used images | ✅ Episode cover in the Episode card, embedded as ID3 `APIC`, kept by templates | Done (no "recently used" list) |
| Chapter images and URLs per chapter; warn on unnamed markers; marker at 00:00 | ✅ Image per chapter, embedded as `APIC` inside `CHAP`, copied next to the chapter files and referenced from PSC (`image`) and JSON (`img`); warnings in the Chapters view and export dialog with "Add chapter at 0:00" | Done |
| Formats FLAC, OGG Vorbis, AIFF in addition to WAV/MP3 | ✅ FLAC 24-bit with Vorbis-comment chapters and the cover (own pure-TypeScript encoder, `core/flac.ts`). Opus/Ogg still open (needs a WASM encoder) | FLAC done; Opus open; AIFF not planned |
| Export regions (split a long recording into several files) | One range at a time | **P3** Regions as a third marker kind, "export each region" |
| Export presets, file name patterns | Fixed naming | **P3** Remember last settings per project (presets only if asked for) |
| Podcast categories in metadata | Missing | **P3** Optional `TCON`/genre field |
| Auphonic hand-off | Stems + chapter files only | **P3** Direct upload to Auphonic multitrack (API key in settings) — already listed under "Later" in PLAN.md |

### Deliberately not adopted

These exist in Ultraschall because it lives inside Reaper or because of a
specific era of remote recording; they would make WavePod more complex
without a matching benefit:

- Reaper screensets, workflow layouts, the multifunction dock and the
  "Podcast" menu (WavePod's four fixed views are the equivalent).
- The generic routing matrix and magic routing. Of "prepare all tracks for
  editing" only the unarming applies (WavePod has no routing, StudioLink or
  automation state to reset), see the table above.
- StudioLink, StudioLink OnAir streaming, Skype/Mumble N‑1 and the HUB
  sound driver (remote guests come in through the interface or OS tools).
- Wiimote support, Reaper action editor, embedding `.rpp` projects.
- Cross-project keyword database of the storyboard.

## 3. Prioritised roadmap

Priorities weigh how often a podcaster hits the gap against implementation
cost. Each numbered item is sized to be one pull request.

### Filters (moved up to P1) ✅

Every track and the master bus has a filter stack: filters can be added,
bypassed, tweaked live while playing, reordered (drag or ↑/↓) and removed.
Available: High-pass (12/24 dB/oct), Equalizer (low shelf, two bells, high
shelf), Noise gate, Compressor (soft knee), De-esser (split-band with a
dynamic high shelf), Limiter, and **Dynamics** (shown as "Ultraschall
Dynamics" until it was renamed), ported from the
JSFX in `ultraschall-portable/Effects/dynamics/Ultraschall_Dynamics`: 188 ms
RMS detector, 5/250 ms envelope, a 250-point gain curve built from Target,
Noise floor and Noise gate (S-curve above the noise floor, linear expander
below it, muted under the gate, 3-tap smoothing), 100 ms lookahead and the
MGA peak limiter at −0.1 dBFS. The mixer compensates filter latency so audio
stays in place on the timeline. "Voice chain" adds High-pass, De-esser and
Dynamics, mirroring Ultraschall's default track chain without
its noise reduction and reverb.

**Live filter meters ✅**: while playing, every filter card shows its input
and output level, and the dynamic filters (gate, compressor, de-esser,
limiter, Dynamics) show the gain they apply right now, as
Ultraschall's plug-in windows do. Dynamics also shows the
current operating point moving on its curve.

**VST3 plug-ins ✅** can go into the same stacks ("VST3 plug-in…" in the add
menu, with search and rescan). WavePod never opens a plug-in's own editor;
it builds sliders from the plug-in's parameter list (switches for on/off
parameters, the plug-in's own value text, "Show all" for long lists) and
stores the plug-in state in the project. Plug-ins run in a separate helper
process (`native/vsthost`, built on Steinberg's VST3 SDK), so a crashing or
hanging plug-in is bypassed with a message instead of stopping playback or a
recording. Scanning also happens in throwaway processes, one per module.
Plug-in folders: the platform's standard VST3 folders plus
`WAVEPOD_VST3_PATH`.

### Phase 5 — Recording essentials (P1)

Things that make a live recording session complete and safe.

Status: item 1 (soundboard on the timeline) and item 2 (cough buttons) are
done, along with a live waveform on tracks while recording (a request that
came up during testing).

1. ✅ **Soundboard on the timeline.** A dedicated "Soundboard" track (created on
   first use, not armed, no input). Every trigger during recording inserts a
   clip referencing the jingle file at the trigger position; stopping a
   jingle trims the clip. Per slot: fade-in, loop, gain; the button shows
   remaining time. The mixer already plays clips, so the edit and the export
   pick this up for free. *Files:* `engine.ts`, `soundboard.ts`,
   `core/project.ts`.
2. ✅ **Cough buttons / mute regions.** New `Track.muteRegions: [start, end][]`.
   Holding the track's cough key (default `Shift+1`…`Shift+8`, also a button
   in the track header) records a region; the mixer applies short ramps. The
   timeline draws regions over the waveform and lets you drag/delete them, so
   the same mechanism doubles as Ultraschall's mute envelope in editing.
   Monitoring is unaffected because the interface does that.
3. ✅ **Soundcheck and safe recording.** Before `R`: warn on sample rate ≠ 48 kHz,
   no armed tracks, two tracks on the same input, a built-in microphone
   selected, low disk space, a missing/changed device, or playhead before the
   end of existing material. "Record anyway" and "don't ask again for this
   project". Confirm before stopping a recording (setting).
4. ✅ **Meters.** Larger per-track meters with the −18…−6 dBFS zone, numeric peak
   hold and a clip indicator that stays until clicked.
5. ✅ **Markers while recording.** `Shift+M` named chapter marker (non-blocking
   title field), `Y` jump to the recording position, optional chapter at 0:00.
6. ✅ **Rolling backups** of `project.json` every 10 minutes and before each
   recording into `backup/`, keep the last 20, "Restore backup…" menu item.

### Phase 6 — Editing speed (P1/P2)

7. ✅ **Navigation (P1).** (The project overview strip is still open; the scrollbar under the timeline does that job for now.) Next/previous edit marker, chapter marker and clip edge
   (`Alt+←/→`, `Ctrl+Alt+←/→`), "preview cut" plays from preroll to
   postroll around the playhead, `Shift+Z` zoom to selection / back, zoom to
   project, project overview strip.
8. **Clipboard and ripple moves (P2).** Copy/cut/paste for clips and time
   ranges across all tracks, `Ctrl+X` = ripple cut. Modifier-drag to move a
   clip with everything after it (track or all tracks, markers follow).
9. ✅ **Crossfades (P2).** Overlapping clips on a track crossfade automatically;
   fade shape per fade. *Files:* `core/mixer.ts`, `core/dsp.ts`, timeline.
10. ✅ **Playback speed (P2).** 1×, 1.25×, 1.5×, 2× in the transport, pitch kept
    with WSOLA in `core/dsp.ts`; recording and export ignore it.
11. **Drag-and-drop import and double-ender alignment (P2).** Drop files on a
    track or empty space; "Align to track…" cross-correlates the first
    minutes against a reference track and sets the clip offset.

### Phase 7 — Sound and export (P1/P2)

12. ✅ **Artwork and chapter images (P1).** Episode cover and per-chapter image
    and URL in the Chapters view; ID3 `APIC`, `CHAP` with `APIC` and `WXXX`
    subframes; image references in PSC and Podcasting 2.0 JSON; validation
    of unnamed chapters before export.
13. ✅ **Track effects.** Done as filter stacks, see "Filters" above.
14. ✅ **Ducking (P2).** Soundboard track ducks under speaker tracks (sidechain
    envelope from the sum of speaker tracks), on/off and depth.
15. **More formats (P2).** ✅ FLAC done. Opus export still open: (WASM encoders in the export
    worker). Clip loudness normalisation (`Alt+Shift+N`) is done.

### Phase 8 — Studio comfort (P3)

16. **Remote control.** MIDI learn via Web MIDI and an OSC server (UDP, off by
    default) for transport, markers, cough buttons and soundboard slots, so
    Stream Deck / Bitfocus Companion and MIDI controllers work.
17. **Output presets.** Choose per output pair what it carries (master,
    soundboard only, selected tracks); presets "Pre-show" (soundboard only)
    and "Show". No full routing matrix.
18. **Regions and export per region; Auphonic upload; podcast category.**
19. **Shortcut overlay, marker ping, clip colours and notes.**

## 4. Suggested order

Phase 5 first, item 1 and 2 before anything else: a jingle that is missing
from the recording and a cough that cannot be removed without cutting are
the two gaps a user hits in their very first session. Then item 12 (artwork
and chapter images), because the MP3 export is otherwise feature-complete
and podcatchers display both. Phases 6 and 7 can run in parallel since they
touch different code (timeline vs. `core/` DSP). Phase 8 only on demand.

Hardware verification on a real RØDECaster Pro II (see PLAN.md, Known risks)
remains a prerequisite for calling any recording feature done.
