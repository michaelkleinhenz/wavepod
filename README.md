# SoundPod

A simple multitrack DAW for podcasting, built with Electron. It covers what
[Ultraschall](https://ultraschall.fm/) is loved for, without needing Reaper:

- **Multichannel USB interfaces** such as the RØDECaster Pro II (all 16
  multitrack channels), RØDECaster Duo, Zoom PodTrak, Focusrite and other
  class-compliant devices, through RtAudio (Core Audio, WASAPI/ASIO,
  ALSA/PulseAudio/JACK).
- **One track per speaker** in one click: known devices are recognised and
  their channels labelled (Combo 1–4, USB Chat, Bluetooth, …).
- **Crash-safe recording** to 16/24/32-bit WAV, one file per track, with
  the waveform drawn live while recording.
- **Cough buttons**: hold `Shift`+`1`–`9` (or a track's `C` button) to mute
  a speaker; the audio is still recorded and the muted region can be
  adjusted or removed later.
- **Editing for podcasters**: split, move, trim, fade, ripple delete across
  all tracks, mute/solo, gain, undo/redo.
- **Chapter markers** while recording (`M`), edit markers for later fixes (`E`).
- **Soundboard** for jingles (keys `1`–`9`) with loop and soft fade-in.
  Jingles played while recording land on a Soundboard track, so they are
  part of the edit and the export.
- **Filters** on every track and the master: high-pass, EQ, noise gate,
  compressor, de-esser, limiter and Ultraschall Dynamics (target-loudness
  leveler with noise gate). Add, bypass, tweak while playing and reorder
  them in the FX panel; they apply live and in the export. Installed
  **VST3 plug-ins** work in the same stack, with plain sliders instead of
  the plug-in's own window; they run in a separate process, so a crashing
  plug-in can't take a recording down.
- **Loudness**: EBU R128 analysis per track and mix, normalisation to −16 /
  −19 / −23 LUFS with a peak ceiling.
- **Export**: MP3 with ID3 chapters (CHAP/CTOC), WAV, stems, and chapter
  files (Podlove Simple Chapters, Podcasting 2.0 JSON, mp4chaps, Audacity
  labels).

See [docs/PLAN.md](docs/PLAN.md) for the architecture and roadmap.

## Getting started

```sh
make install   # npm ci
make start     # build and run
make demo      # run with virtual devices only, no audio hardware needed
make test      # unit + engine tests
make help      # all targets
```

Requires Node.js 22. VST3 support needs the helper in `native/vsthost`:
`make vsthost` builds it (CMake 3.25+ and a C++17 compiler; it downloads
Steinberg's VST3 SDK), and `make dist*` builds it automatically. Without it
SoundPod runs fine, just without the VST3 entry. On Linux the app needs `libasound2` and `libpulse0`
(present on normal desktop installs).

### Using a RØDECaster Pro II

1. Enable multitrack mode in the RØDECaster's USB audio settings
   and connect it over USB.
2. In SoundPod's **Setup** view pick the RØDECaster as input device. The
   16 channels appear with their names and live meters.
3. Click **Create speaker tracks**. Each mic and remote source gets its own
   armed track.
4. Switch to **Record & Edit** and press `R`.

On Windows the multitrack channels are only exposed through RØDE's ASIO
driver; pick **ASIO** as audio system if it is offered.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / stop |
| `R` | Record / stop recording |
| `M` | Chapter marker at playhead |
| `E` | Edit marker at playhead |
| `S` | Split clips at playhead (selected clips' tracks, or all) |
| `F` | Fade in/out on selected clips |
| `Delete` / `Shift+Delete` | Delete selection / ripple delete range |
| `1`–`9`, `Esc` | Soundboard slots (again: fade out), stop all jingles |
| `Shift`+`1`–`9` (hold) | Cough button for speaker track 1–9 |
| `←` `→` (with `Shift`) | Move playhead 1 s (10 s) |
| `+` `-` | Zoom |
| `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z` | Undo / redo |

Drag across the ruler to select a time range; drag clips to move them
(also to another track), drag clip edges to trim. Muted (cough) regions
sit in the strip at the bottom of each track: drag there to add one, drag
its edges to adjust it, double-click or `Delete` to remove it.

## Projects

Each episode is a folder (default `~/Documents/SoundPod/Episode …`) with
`project.json` and a `media/` folder of WAV files. Changes are saved
automatically.

## Releases

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`, which
builds a Linux AppImage, a Windows NSIS installer and a macOS DMG and
attaches them to a GitHub release. Builds are unsigned until signing
certificates are configured as repository secrets.

## Third-party components

- [audify](https://github.com/almoghamdani/audify) (RtAudio bindings, MIT)
- [@breezystack/lamejs](https://github.com/breezystack/lamejs) (MP3 encoder,
  LGPL-3.0), bundled into the export worker
