# WavePod – Plan

WavePod is a desktop DAW built for podcasting. It takes the ideas that make
[Ultraschall](https://ultraschall.fm/) great — one track per speaker, chapter
markers set live while recording, simple editing, loudness-correct export with
chapters — and packages them as a standalone Electron app. There is no Reaper
underneath and no theme/plugin installation: install, plug in your interface,
press record.

## Goals

1. **Hardware first.** Talk directly to multichannel USB interfaces such as the
   RØDECaster Pro II (16 channel multitrack), RØDECaster Duo, Zoom PodTrak,
   Focusrite, etc. Read all input channels at once, write to any output
   channels. Bypass the browser audio stack, which caps capture at 2 channels.
2. **Record each speaker to its own track**, sample-accurate, crash-safe
   (WAV header patched continuously so a crash never loses the take).
3. **Edit like a podcaster, not a musician**: split, move, delete, ripple
   delete, mute/solo, gain, fades. Non-destructive.
4. **Podcast-specific features**: chapter markers (set live via hotkey),
   edit markers, a soundboard for jingles, loudness metering (EBU R128) and
   normalisation, export to WAV/MP3 with embedded ID3 chapters, plus chapter
   files (Podlove Simple Chapters, mp4chaps, Podcasting 2.0 JSON).
5. **Simple**: three views — Setup, Record & Edit (timeline), Chapters —
   plus the Export dialog.
6. **Shipping**: CI on every pull request, tag-triggered release builds for
   Linux (AppImage and .deb), Windows (NSIS installer) and macOS (DMG); one
   `Makefile`.

## Non-goals (for now)

- Music-production features (MIDI sequencing, instruments, AU/LV2 hosting).
  VST3 effects are hosted, but only with generated sliders, never the
  plug-in's own editor. MIDI is used for remote control only.
- A full routing matrix and per-track output routing.
- Live streaming.

Two former non-goals are now planned, each with its own plan document
outside the repository: **remote guests** (a LiveKit call with the user's own
key plus WavePod's own raw recorder on the guest side, start planned for
2026-11-13) and **multi-camera video** (video follows the audio edit, director
track, live camera switching; plan only).

## Architecture

```
┌──────────────── Renderer (UI, TypeScript, canvas) ────────────────┐
│ Setup view · Timeline · Chapters · Soundboard · Export dialog      │
│ Project state + undo stack live here                               │
└───────────────▲───────────────────────────────┬────────────────────┘
                │ IPC (meters, transport, events)│ IPC (commands, project)
┌───────────────┴───────────────────────────────▼────────────────────┐
│ Main process                                                        │
│  AudioEngine ── transport, recording writers, mixer, soundboard     │
│     │                                                               │
│  AudioBackend interface                                             │
│     ├─ RtAudioBackend (audify → RtAudio: CoreAudio/WASAPI/ASIO*/    │
│     │                   ALSA/JACK/Pulse; N-API prebuilt binaries)   │
│     └─ SimulatedBackend (virtual 16-in RØDECaster + 4-ch device)    │
│  ProjectStore (project folder: project.json + media/*.wav + peaks)  │
│  Exporter (offline mixdown, loudness, WAV/MP3, ID3 chapters)        │
└─────────────────────────────────────────────────────────────────────┘
          core/  ← pure TypeScript, no Electron; unit-tested with vitest
```

\* ASIO availability depends on the RtAudio prebuild.

### Why RtAudio via `audify`

Chromium's `getUserMedia` delivers at most stereo on most platforms, which
makes 16-channel multitrack capture impossible from the renderer. `audify`
wraps RtAudio, supports arbitrary channel counts in both directions, exposes
device enumeration, and ships N-API prebuilt binaries for Linux, macOS and
Windows, so packaging does not need a compiler. If the native module fails to
load, WavePod falls back to the simulated device so the UI keeps working and
the error is shown in the Setup view.

### Data model (`project.json`)

The full types live in `src/shared/types.ts`; the main shape is:

- `Project { name, sampleRate, bitDepth, masterGain, masterFx[], tracks[], folders[], markers[], regions[], soundboard[], metadata, script?, exportSettings?, soundcheckIgnored[] }`
- `Track { id, kind?, name, color, inputChannels: number[] (1 = mono, 2 = stereo), armed, mute, solo, gain (dB), pan, automation? (volume/pan lanes), clips[], muteRegions[], fx[], duck?, automix?, voice?, stem?, folderId?, takes[] }`
- `Clip { id, file, start (samples, timeline), offset (samples into file), length, gain, fadeIn, fadeOut, fade shapes, envelope[] (volume line), name?, color?, note?, fx[], sound? (reverse/varispeed/loop), takeId? }`
- `Marker { id, kind: 'chapter' | 'edit', position (samples), title, url?, image? }` (images are JPEG/PNG under `images/`, as is `metadata.artwork`)
- `Region { id, start, end, title }`, `TrackFolder { id, name, color, mute, solo, gain }`, `Script { title, lines[] }`

Transcripts live next to the media in `transcripts/*.json`, in source frames.
`normalizeProject` drops unknown fields, so every new field has to be added
there.

Positions are integer sample frames at the project sample rate; seconds are a
UI concern only.

## Phases

### Phase 1 — Hardware audio device management ✅
- `AudioBackend` abstraction; RtAudio + simulated implementations.
- Enumerate devices with input/output channel counts and sample rates; hot
  refresh.
- Open a multichannel input stream (all channels of the device) and an output
  stream (any channel count) independently, so input and output can be
  different devices.
- Live per-channel peak/RMS meters at 30 Hz.
- **Device profiles**: recognise known interfaces by name and pre-label
  channels (RØDECaster Pro II: Main L/R, Combo 1-4, Bluetooth, SMART Pads,
  USB Main, USB Chat, USB 2; RØDECaster Duo; Zoom PodTrak P4/P8; generic).
- "Create tracks from device" — one track per mic channel in one click.
- Output routing: choose the output channel pair for playback.

### Phase 2 — Timeline and recording ✅
- Streaming WAV writer per armed track (24-bit or 32-bit float), header
  patched every second for crash safety.
- Record arms; punch-in at playhead; takes appended as clips.
- Playback mixer: per-track gain/pan/mute/solo, clip gain, fades, master
  gain, block-based reading from disk.
- Canvas timeline: ruler, waveform peaks (precomputed, cached `.peaks`),
  zoom/scroll, playhead, click-to-seek, clip selection, drag-move, split at
  playhead, delete, ripple delete of a time range, undo/redo.
- Transport: play/pause/stop/record, keyboard shortcuts.

### Phase 3 — Podcast features ✅
- Chapter markers (hotkey `M` while recording or playing), edit markers
  (`E`), chapter list editing (title, URL), jump to marker.
- Import/export chapters: Podlove Simple Chapters (PSC XML), mp4chaps text,
  Podcasting 2.0 JSON chapters, Audacity labels.
- Soundboard: up to 12 jingle slots, triggered by click or keys `1`–`9`,
  played through the output device.
- Loudness: EBU R128 integrated loudness and sample peak per track and
  master; export normalises to a target (default −16 LUFS stereo).
- Export: mixdown to WAV and MP3 (lame, pure JS) with ID3v2 metadata and
  ID3 `CHAP`/`CTOC` chapter frames; optional per-track stems; chapter files
  written alongside.

### Phase 4 — Build, CI/CD ✅
- `Makefile`: `install`, `dev`, `build`, `test`, `lint`, `dist`,
  `dist-linux`, `dist-win`, `dist-mac`, `clean`.
- GitHub Actions `ci.yml`: typecheck + tests + build on Linux for pull
  requests (Windows and macOS only run on release tags, to save CI minutes).
- GitHub Actions `release.yml`: on tag `v*`, build AppImage + .deb / NSIS /
  DMG with electron-builder and attach them to a GitHub Release. The version
  comes from the tag; `make release VERSION=x.y.z` sets it, commits, tags and
  pushes.

### Phases 5–8 — Ultraschall parity ✅
All items of the parity roadmap are done; see
[ULTRASCHALL-PARITY.md](ULTRASCHALL-PARITY.md).

### Beyond the plan ✅
Features that were not in either plan and shipped since (PR numbers in
brackets):

- **Recording safety**: crash-safe writer thread with journal recovery, live
  problem monitor, loud alerts (modal, alarm, system notification) when an
  input is lost or a take can't be written (#36, #72, #84); input devices
  reconnect mid-take; one WavePod at a time, ask before quitting while
  recording (#105).
- **Transcript and text editing** (ElevenLabs Scribe, user's own key): cut by
  deleting words, pause/hesitation/retake clean-up, automix against
  crosstalk, crosstalk filtering in transcripts, speech synthesis to replace
  or insert words (experimental) (#63, #74, #75, #87, #108).
- **Audio drama**: script import (txt, Fountain, FDX, PlotGod JSON), tick off
  lines while recording, fold acts/scenes, pop-out script window, Cut Around
  Every Take (#100, #114, #116, #117); takes and comping with take lanes,
  loop recording and punch-in with pre/post-roll (#99, #101, #111); voice
  effects, band-pass/distortion/echo, room & distance, pitch, ring mod,
  chorus, RT60 room decay and convolution reverb (#62, #67, #112); sound
  effects library with favourites (#67, #104).
- **Mixing**: per-track volume/pan automation lanes (#79), track folders with
  group mute/solo/volume (#82), dialogue/music/effects stems and M&E export
  (#80), clip reverse/varispeed/loop (#81), FX presets incl. VST3 programs and
  copy/paste of filters (#33, #45), declicked clip edges (#88).
- **Remote guests in the room**: mix-minus feed on the second output, also on
  another device (#98, #121).
- **Editing comfort**: clip menu, rubber-band selection, draggable playhead
  and tape-style scrubbing, editable clip and region names, drag a clip below
  the last track for a new track, align separately recorded tracks over the
  full length with clock-drift correction (#35, #39, #42, #103, #110, #120,
  #123).
- **Export**: reworked export dialog (range, file, format, loudness; one
  region or each region; replace prompt), settings remembered per episode and
  template, mono, −14/−16/−19/−23/custom LUFS with a true-peak limiter, export
  checks (#71, #108, #124).
- **Episodes**: named new episodes, Save / Save As over autosave (#60),
  Zencastr ZIP import (#55).
- **Help and app**: in-app user guide (`docs/guide/`, F1 context help) (#86),
  About dialog (#83), beta notice (#96), in-app menu bar on Linux/Windows
  (#31), MCP server for AI agents (#13), app icon and desktop entry (#57).

### Still open
- **Remote recording** (LiveKit call + own guest recorder), phases 1–4 per
  the implementation plan, start planned 2026-11-13.
- **Multi-camera video**: plan written, nothing built.
- **Release blockers**: code signing for Windows; signing, notarisation and
  a hardened runtime with the audio-input entitlement for macOS (otherwise
  recordings are silent); a macOS Intel build; the name's closeness to NCH
  WavePad.
- **Real-world tests**: RØDECaster Pro II on all three OSes (channel map, ASIO
  on Windows), MIDI controllers, VST3 on real Windows/macOS machines,
  Auphonic and ElevenLabs with real accounts (only tested against mocks),
  field-recorder files for track alignment, PipeWire's own ALSA plug-in.
- **Podcast workflow** gaps from the 2026-11-07 list: episode numbering, show
  structure, a "finish episode" flow; podcast feed publishing.
- **App hygiene**: log file / crash reports, auto-update, fsync of takes, an
  auth token for the MCP server.
- Customisable keymap (P3 in the parity plan).

## Status

Phases 1–8 and everything under "Beyond the plan" are implemented and covered
by the repository's tests (WAV I/O, mixer, loudness against the EBU reference
level, chapter formats, ID3 chapters, project editing, the engine recording
16 virtual channels, export and many more) and by driving the packaged app
with virtual devices. The current release is v0.9.0 (beta). Not yet verified
on real hardware: see "Still open".

## Known risks

- **Driver behaviour differs by OS.** On Linux, PipeWire/PulseAudio holds the
  ALSA hardware devices, so "System default" uses Pulse when a server answers
  and ALSA plug-in devices are clamped to the server's channel count. The
  Setup view lets the user pick the host API and explains the switch.
- **Clock drift** between separate input/output devices is not compensated;
  recording is input-only so takes are unaffected. A second output on another
  device is fed through a bounded buffer. Drift between separate recorders is
  corrected by "Align to other track" (resampled `-synced.wav` copies).
- **Windows multitrack**: the RØDECaster Pro II exposes its 16-channel
  multitrack interface through its ASIO driver; WASAPI only shows the stereo
  endpoints. Whether the audify prebuild includes ASIO needs to be checked on
  Windows hardware.
- **macOS builds** are produced for the runner's architecture (Apple
  silicon); an Intel build needs an extra runner.
- **Unsigned builds** trigger Gatekeeper/SmartScreen warnings until signing
  secrets are configured. On macOS, an unsigned build without the
  audio-input entitlement may record silence.
- **Licences**: the app is MIT, but the Dynamics filter is a port of
  Ultraschall's LGPL JSFX and the MP3 encoder (LAME) is LGPL; see
  `THIRD_PARTY_NOTICES.md`.
