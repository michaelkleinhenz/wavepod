# SoundPod – Plan

SoundPod is a desktop DAW built for podcasting. It takes the ideas that make
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
5. **Simple**: four views — Setup, Record/Edit (timeline), Chapters, Export.
6. **Shipping**: CI on every push, tag-triggered release builds for Linux
   (AppImage), Windows (NSIS installer) and macOS (DMG); one `Makefile`.

## Non-goals (for now)

- Plugin hosting (VST/AU/LV2), MIDI, music-production features.
- Studio Link / remote guests over network (OS-level tools like the
  RØDECaster's USB Chat channel cover this).
- Video.

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
load, SoundPod falls back to the simulated device so the UI keeps working and
the error is shown in the Setup view.

### Data model (`project.json`)

- `Project { name, sampleRate, bitDepth, tracks[], markers[], soundboard[], metadata }`
- `Track { id, name, color, inputChannels: number[] (1 = mono, 2 = stereo), armed, mute, solo, gain (dB), pan, clips[] }`
- `Clip { id, file, start (samples, timeline), offset (samples into file), length, gain, fadeIn, fadeOut }`
- `Marker { id, kind: 'chapter' | 'edit', position (samples), title, url?, image? }`

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
- GitHub Actions `ci.yml`: typecheck + tests + build on Linux/Windows/macOS
  for every push and PR.
- GitHub Actions `release.yml`: on tag `v*`, build AppImage / NSIS / DMG with
  electron-builder and attach them to a GitHub Release.

### Later
See [ULTRASCHALL-PARITY.md](ULTRASCHALL-PARITY.md) for the prioritised
roadmap of Ultraschall features (phases 5–8). Remaining items:
- Ripple editing across all tracks with marker shifting (partly done via
  ripple delete).
- Auto-ducking / noise gate / leveler per track.
- Auphonic upload, transcription, podcast feed publishing.
- Code signing and notarisation for macOS/Windows releases (needs
  certificates as repository secrets).
- Real-hardware test matrix (RØDECaster Pro II on all three OSes).

## Status

Phases 1–4 are implemented. Verified in this repository's tests (WAV I/O,
mixer, loudness against the EBU reference level, chapter formats, ID3
chapters, project editing, the engine recording 16 virtual channels, export)
and by driving the packaged app with virtual devices. Not yet verified on
real hardware: the RØDECaster Pro II channel map and RtAudio behaviour per OS
need a test on an actual device.

## Known risks

- **Driver behaviour differs by OS.** On Linux, ALSA hardware devices may be
  exclusive; PulseAudio/PipeWire exposes multichannel devices differently.
  The Setup view lets the user pick the host API.
- **Clock drift** between separate input/output devices is not compensated;
  recording is input-only so takes are unaffected.
- **Windows multitrack**: the RØDECaster Pro II exposes its 16-channel
  multitrack interface through its ASIO driver; WASAPI only shows the stereo
  endpoints. Whether the audify prebuild includes ASIO needs to be checked on
  Windows hardware.
- **macOS builds** are produced for the runner's architecture (Apple
  silicon); an Intel build needs an extra runner.
- **Unsigned builds** trigger Gatekeeper/SmartScreen warnings until signing
  secrets are configured.
