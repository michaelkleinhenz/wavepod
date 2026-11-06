# WavePod

A simple multitrack DAW for podcasting, built with Electron. It covers what
[Ultraschall](https://ultraschall.fm/) is loved for, without needing Reaper:

- **Multichannel USB interfaces** such as the RØDECaster Pro II (all 16
  multitrack channels), RØDECaster Duo, Zoom PodTrak, Focusrite and other
  class-compliant devices, through RtAudio (Core Audio, WASAPI/ASIO,
  ALSA/PulseAudio/JACK).
- **One track per speaker** in one click: known devices are recognised and
  their channels labelled (Combo 1–4, USB Chat, Bluetooth, …).
- **Crash-safe recording** to 16/24/32-bit WAV, one file per track, with
  the waveform drawn live while recording. The timeline scrolls with the
  recording, keeping the red cursor in view.
- **Cough buttons**: hold `Shift`+`1`–`9` (or a track's `C` button) to mute
  a speaker; the audio is still recorded and the muted region can be
  adjusted or removed later.
- **Editing for podcasters**: split, move (also to other tracks), trim,
  fades by dragging a clip's top corners, ripple cut across all tracks
  (`Ctrl+X`), mute/solo, gain, undo/redo. Dragged edges snap to clip
  edges on other tracks, markers and the playhead (toolbar `Snap`, hold
  `Alt` to drag freely). Time selections can be resized by dragging their
  edges.
- **Volume line** per clip (hover a clip and click `Vol` at its top left):
  double-click to add points, drag points or the line up and down; the
  waveform shows the result. `Ctrl+Y` silences the selected range on the
  tracks it was dragged across.
- **Tape-style scrubbing**: drag the playhead and you hear the timeline at
  the speed and in the direction you move it, pitch and all, also while
  stopped. Held still, it falls silent; let go and playback (if it was
  running) carries on from there.
- Dragging a clip straight up or down to another track keeps its time
  position, so the tracks stay in sync.
- While dragging a clip, an edge, a selection or a marker, the view
  scrolls when the mouse nears or leaves the edge of the timeline (faster
  the further out), so a clip can be carried anywhere in one drag.
- **Zoom down to single samples**: waveforms use multi-resolution peaks
  (cached in `.peaks` files next to the audio), so long multitrack episodes
  scroll smoothly; past the finest peak level the samples themselves are
  drawn, as a line with a dot per sample at the deepest zoom.
- **Chapter markers** while recording (`M`), edit markers for later fixes (`E`).
- **Soundboard** for jingles (keys `1`–`9`) with loop and soft fade-in.
  Jingles played while recording land on a Soundboard track, so they are
  part of the edit and the export.
- **Filters** on every track and the master: high-pass, EQ, noise gate,
  compressor, de-esser, limiter and Dynamics (a port of Ultraschall's
  Dynamics: target-loudness
  leveler with noise gate). Add, bypass, tweak while playing and reorder
  them in the FX panel; they apply live and in the export. While playing,
  each filter shows live in/out levels and how much gain it is applying. Installed
  **VST3 plug-ins** work in the same stack, with plain sliders instead of
  the plug-in's own window; they run in a separate process, so a crashing
  plug-in can't take a recording down. Every slider's value (filter
  parameters, VST3 parameters, track gain) can be clicked to type an exact
  number, e.g. `-3,5 dB`, `1.2 kHz` or `250 ms`; Enter applies it (kept within
  the slider's range), Escape cancels.
- **Filter presets**: every filter card has a preset menu. Every built-in filter
  comes with factory presets tuned for speech, e.g. Compressor *Spoken word*,
  EQ *Clarity for dynamic mics*, Noise reduction *Computer fan* (hover one to
  see what it is for), plus *Default*; VST3 plug-ins offer their
  own programs (factory presets) there instead of a program slider. *Save as
  preset…* stores the current settings (for VST3 including the plug-in's
  state) as your own preset, available in every episode; rename (✎) or delete
  (🗑) the one that's loaded. The menu shows "(edited)" once you change a value
  after loading. Your presets are JSON files in `Documents/WavePod/Presets/`,
  one folder per filter or plug-in, so they can be copied to another machine.
- **Copy and paste filters**: *Copy all* in a track's filter panel copies its
  whole stack; the copy button on a filter card copies just that filter. Open
  another track (or Master FX) and use *Paste…* to add the filters at the end
  or top, or to replace the stack. When the copied filter is the same kind as
  a card (same built-in filter or the same VST3 plug-in), that card offers
  *Paste settings*, which keeps its place and bypass. Copies include VST3
  state and the preset label, work across episodes, and are one undo step.
- **Templates**: save an episode's setup (tracks and their input channels,
  filter stacks including Master FX and VST3 settings, soundboard jingles)
  with File › Save as Template…, and start the next episode from it with
  File › New Episode from Template… (`Shift+Ctrl+N`) or the Setup view.
  No recordings, markers or volume lines are stored in a template.
- **Loudness**: EBU R128 analysis of the mix, every track or selected clips
  (Loudness… in the toolbar, `Shift+Ctrl+L`) with the figures Ultraschall
  shows: integrated, loudness range (LRA), short-term and momentary maximum,
  true peak and sample peak, plus a short-term loudness curve against the
  target. **Normalise** (`Alt+Shift+N`) sets the clip gain of the selected
  clips so each reaches the target (−16 LUFS by default) without the true
  peak going over the ceiling. The export normalises the mix to −16 / −19 /
  −23 LUFS; where the peaks would go over the ceiling, a look-ahead
  true-peak limiter holds them so the target is still reached.
- **AI agents** (opt-in): a local MCP server lets Claude Desktop, Claude
  Code and other MCP clients build and tweak filter stacks, apply the voice
  chain and read tracks, markers and loudness.
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

Requires Node.js 22, CMake and a C++ compiler: `npm ci` compiles a patched copy
of the `audify` audio module (see `patches/` and `scripts/build-audify.mjs`;
the upstream prebuilt binary crashes under Electron 43+). On Linux this also
needs the ALSA and PulseAudio headers (`sudo apt install libasound2-dev
libpulse-dev pkg-config` on Debian/Ubuntu). VST3 support needs the helper in `native/vsthost`:
`make vsthost` builds it (CMake 3.25+ and a C++17 compiler; it downloads
Steinberg's VST3 SDK), and `make dist*` builds it automatically. Without it
WavePod runs fine, just without the VST3 entry. On Linux the app needs `libasound2` and `libpulse0`
(present on normal desktop installs).

#### Linux: Chromium sandbox

Electron sandboxes its renderer processes. On Linux it does this with
unprivileged user namespaces, or, where those are blocked, with the setuid
helper `node_modules/electron/dist/chrome-sandbox`, which must be owned by
root. Ubuntu 23.10+ blocks user namespaces through AppArmor, and npm installs
the helper as your user, so plain `npx electron .` aborts with
`SIGTRAP` ("The SUID sandbox helper binary was found, but is not configured
correctly"). WavePod itself never needs root. `make start` detects this and
prints the options instead of crashing:

- Keep the sandbox (redo after every `npm ci`):
  ```sh
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  ```
- Keep the sandbox permanently by allowing user namespaces for this Electron
  binary with an AppArmor profile (run from the repo root):
  ```sh
  sudo tee /etc/apparmor.d/wavepod-electron-dev >/dev/null <<EOF
  abi <abi/4.0>,
  include <tunables/global>
  profile wavepod-electron-dev "$PWD/node_modules/electron/dist/electron" flags=(unconfined) {
    userns,
    include if exists <local/wavepod-electron-dev>
  }
  EOF
  sudo apparmor_parser -r /etc/apparmor.d/wavepod-electron-dev
  ```
- Development only, without the sandbox: `WAVEPOD_NO_SANDBOX=1 make start`.

#### Linux: GNOME launcher

The AppImage does not add itself to the app grid. To get WavePod (with its
icon) into GNOME's Activities and dock:

```sh
make desktop-install WAVEPOD_EXEC=$HOME/Applications/WavePod.AppImage
make desktop-uninstall   # to remove it again
```

This copies `build/linux/wavepod.desktop` and the icons into
`~/.local/share`. The entry's `StartupWMClass` and `Icon` are `wavepod`,
matching `desktopName` in `package.json`, so running windows group under the
launcher.

### App icon

`build/icon.svg` is the one source for the app, installer and web page icon.
After editing it, `make icons` re-renders `build/icons/*.png`,
`build/icon.png`, `build/icon.ico`, the favicons in `site/` and copies the SVG
to `site/img/icon.svg` (needs Playwright's Chromium and ImageMagick). A test
checks the web copy matches. The icon has no lettering, so renaming the app
only touches `productName`, `desktopName` and the `.desktop` file.

### Using a RØDECaster Pro II

1. Enable multitrack mode in the RØDECaster's USB audio settings
   and connect it over USB.
2. In WavePod's **Setup** view, on the **Audio** tab, pick the RØDECaster
   under **Record from**.
3. Further down the **Audio** tab the 16 channels appear with their names and
   live meters. Click **Create speaker tracks**: each mic and remote source
   gets its own armed track.
4. Switch to **Record & Edit** and press `R`.
5. When the recording is done, run **Edit › Prepare All Tracks for Editing**
   (or the toolbar button) to unarm all tracks, so `R` can't start a new take
   while you cut. Tick **Prepare for Editing When Recording Stops** in the
   same menu to have this happen automatically.

On Windows the multitrack channels are only exposed through RØDE's ASIO
driver; pick **ASIO** as **Audio driver** (Setup › Audio › Advanced audio
settings) if it is offered.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / stop (playback stops at the end of the last clip) |
| `R` | Record / stop recording |
| `L` | Repeat: loop playback of the selected time range |
| `M` | Chapter marker at playhead |
| `E` | Edit marker at playhead |
| `S` | Split clips at playhead (selected clips' tracks, or all) |
| `F` | Fade in/out on selected clips |
| `Delete` / `Shift+Delete` | Delete selection / ripple delete range |
| `Ctrl/Cmd+X` | Ripple cut: remove the selected range from all tracks and close the gap |
| `Ctrl/Cmd+Y` | Mute the selected range on its tracks via their volume lines |
| `1`–`9`, `Esc` | Soundboard slots (again: fade out), stop all jingles |
| `Shift`+`1`–`9` (hold) | Cough button for speaker track 1–9 |
| `←` `→` (with `Shift`) | Move playhead 1 s (10 s) |
| `+` `-`, `Ctrl/Cmd`+wheel | Zoom (down to single samples) |
| `Ctrl/Cmd+Z`, `Shift+Ctrl/Cmd+Z` | Undo / redo |

Drag across the ruler to select a time range; drag clips to move them
(also to another track), drag clip edges to trim. Muted (cough) regions
sit in the strip at the bottom of each track: drag there to add one, drag
its edges to adjust it, double-click or `Delete` to remove it.

## MIDI controller

Any class-compliant USB MIDI controller (pad controller, keyboard, foot
switch, a mixer's MIDI out) can start and stop recording and drop chapter
and edit markers; play/pause, stop, record on/off, the cough buttons of
speakers 1–6 (muted while held) and soundboard slots 1–9 can be mapped too.
In **Edit → Settings… → Controllers → MIDI controller**, click *Learn* next to a function and press
the pad, key or button. Notes fire on note-on, controllers when they go
to 64 or above (once per press, so a fader doesn't repeat), program
changes always. A mapping listens to the device it was learned from;
switch it to *Any device* (tick *Show device and button type*) if you use
more than one. Mappings are stored in
the app settings, not in the episode, so they work in every project.

## Remote control (OSC)

For a Stream Deck through [Bitfocus Companion](https://bitfocus.io/companion)
(a *Generic OSC* connection), TouchOSC or anything else that sends OSC over
UDP, switch on **Edit → Settings… → Controllers → Stream Deck and OSC remotes**. WavePod
listens on port 9000 (changeable under *Connection details and addresses*), only for this computer unless *Accept from other computers*
is ticked. Addresses:

| Address | Does |
| --- | --- |
| `/wavepod/record`, `/wavepod/record/start`, `/wavepod/record/stop` | Record on/off, start, stop |
| `/wavepod/play`, `/wavepod/stop` | Play/pause, stop |
| `/wavepod/marker/chapter`, `/wavepod/marker/edit` | Drop a marker |
| `/wavepod/prepare` | Prepare for editing |
| `/wavepod/cough/1` … `/6` | Cough button: argument 1 mutes the speaker, 0 releases |
| `/wavepod/sound/1` … `/9`, `/wavepod/sounds/stop` | Soundboard slot, stop all sounds |

A button that sends 1 on press and 0 on release fires once; a message
without arguments counts as a press.

## Auphonic

**File → Send to Auphonic…** creates a multitrack production on
[auphonic.com](https://auphonic.com) with one FLAC per track (track filters
and volume rendered in), the chapters, the episode details and the cover.
Paste the API key from Auphonic's Account Settings once; pick one of your
multitrack presets and whether to start the production right away or review
it on the website first.

## Audio drama

**Voices.** "+ Add filter" in the FX panel has a *Voice effects* group: telephone, mobile phone, old radio, walkie-talkie, megaphone, next room, robot, broken robot, alien, giant, demon, small creature, child-like voice, chipmunk, magic, ghost, time travel, dream and more. Each one adds a few ordinary filters set from factory presets, so every value stays editable. The building blocks are also filters of their own: Band-pass, Distortion, Echo, **Pitch shift** (−24 to +24 semitones, speed kept), **Ring modulator** (robots, aliens) and **Chorus / flanger** (chorus, flanger, vibrato).

**Places.** The *Places* group puts a voice into a room with the **Room & distance** filter: living room, bedroom, small kitchen, bathroom, car, office, classroom, stairwell, basement, garage, church, concert hall, cave, tunnel, forest, open field and street. Its **Distance** (in metres) moves the speaker away: the voice gets quieter, loses highs and bass, and the room takes over; below 1 m it gets the bass of speaking close to the mic. Filters work per track and per clip, so one clip can be further away than the next.

**Sound library.** Set a folder of sound effects in Edit › Settings, then open View › Sound Library (Shift+Ctrl+B, or *Sounds* in the header). Type to search file and folder names ("door creak", "forest wind"); ↑/↓ walk the results and play each one, Enter or a double click inserts the sound at the playhead, and a row can be dragged onto any track. *Insert on* picks the track (by default a "Sound effects" track, created when needed). Right click › *Fill the Selection (Loop)* repeats an atmosphere over the selected time range with crossfades. Inserted sounds are copied into the episode, so it keeps working without the library.

## Crosstalk removal (automix)

When several people share a room, every mic also picks up the others. Tick
**Automix (remove crosstalk)** in the FX panel of each speaker track: whoever is
loudest stays at full level and the other automixed tracks are turned down by up
to the chosen depth (−6 to −40 dB). Two people talking at once both stay up,
and short pauses inside a sentence don't close a track. It runs in playback,
the mix export and stem exports, after each track's filters. AI agents can set
it with the MCP tool `set_automix`.

## Transcript

**View → Transcript** (Shift+Ctrl+T) shows the episode as text, one paragraph
per speaker turn. **Transcribe** sends each speaker track to
[ElevenLabs speech-to-text](https://elevenlabs.io/speech-to-text) (Scribe) as a
16 kHz mono WAV and brings back every word with its time; only files without a
transcript are sent. Put your ElevenLabs API key into **Edit → Settings…**
(Ctrl+,), together with the model, the language and names the model should get
right. The key is kept encrypted with the system keychain where there is one.

Transcripts are stored per recorded file in the episode's `transcripts/`
folder, in that file's own time, so they stay right through every cut, move
and trim. In the panel, click a word to jump there, drag across words to select
their time, and press Delete to cut the selection out of all tracks.
Hesitations are underlined. **Save as…** writes the text with speakers and
times, or WebVTT subtitles. The MCP tool `get_transcript` gives AI agents the
text (for show notes or chapter titles).

### Changing words (experimental)

Double-click a word in the transcript (or click it, or select several, and press
Enter, or use **Change…**) to replace it or to insert new words before or after
it. [ElevenLabs text-to-speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert)
says them in the speaker's voice: either an instant voice clone made from up to
90 seconds of that track's own transcribed speech (you confirm that you have the
speaker's permission; the clone is remembered on the track and can be deleted
from your ElevenLabs account again), or any voice of your account. The speaker's
words around the edit are sent along so the intonation fits.

**Listen** plays the take; **Replace**/**Insert** puts it in: the silence around
it is trimmed, the clip gain matches the speaker's level around the edit, the
range is cut out of (or room made on) every track so they stay in sync, and the
cut edges get short fades. The new clip is in `media/tts-….wav` with a
transcript of its own, so it shows up in the text. Ctrl+Z undoes it. Takes are
24 kHz unless *High quality* (44.1 kHz, ElevenLabs Pro plan) is on, and each one
costs text-to-speech credits.

## Cleanup

**Edit → Clean Up Pauses and Hesitations…** (Shift+Ctrl+K) lists:

- pauses in the mix longer than a set length (1.5 s by default), shortened to a
  set length (0.7 s) by cutting out their middle, so breaths at both ends stay;
- hesitations from the transcript (äh, ähm, öhm, hm; uh, um, erm in English),
  each cut moved onto the quiet points around the sound. If someone else talks at
  that moment, the hesitation is muted on its own track instead of cut.

Listen to each with ▶, untick what should stay, then **Apply** (one undo step)
or **Mark only** (edit markers to decide by hand).

## Zencastr

**File → New Episode from Zencastr ZIP…** turns a session downloaded from
Zencastr (Library → Recordings → Download) into a new episode: one track per
participant (the WAV when the ZIP has both WAV and MP3), the soundboard
recording on the Soundboard track, all starting at 0 as in the session. When
someone left and rejoined, their parts go one after the other on their track,
placed by the time in the file names. Transcripts, video and post-production
mixes are left out.

## AI agents (MCP)

WavePod can run a [Model Context Protocol](https://modelcontextprotocol.io)
server so an AI agent can work on the open episode, mainly its filter
stacks: "give every speaker the voice chain, put a gentle compressor after
the de-esser on the guest and a limiter at −1 dB on the master, then check
the loudness".

It is off by default. Switch it on in **Edit → Settings… → AI agents**. The
server listens on `http://127.0.0.1:47474/mcp` (the port can be changed
under *Connection details*) and only accepts connections from this computer; requests from web
pages are refused. Any program on your computer can connect while it is on,
so switch it off when you don't use it.

Every change an agent makes is one undo step (`Ctrl/Cmd+Z`), shows up in
the FX panel at once and is announced with a short message at the bottom.

**Claude Code**

```sh
claude mcp add --transport http wavepod http://127.0.0.1:47474/mcp
```

**Claude Desktop** (and other clients that only start local commands):
add this to `claude_desktop_config.json` (Settings → Developer → Edit
Config) and restart Claude Desktop. It needs Node.js for `npx`.

```json
{
  "mcpServers": {
    "wavepod": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:47474/mcp"]
    }
  }
}
```

Clients that speak Streamable HTTP directly (Cursor, VS Code, …) just need
the URL. WavePod has to be running, with the server switched on, when the
client connects.

| Tool | What it does |
| --- | --- |
| `get_project` | Episode name, folder, sample rate, length, metadata, transport state |
| `list_tracks` | Tracks and the master with gain, pan, mute/solo, clips and filter names |
| `list_markers` | Chapter and edit markers with timestamps |
| `measure_loudness` | EBU R128 figures of the mix and every track, after the filters |
| `list_filter_types` | Built-in filters with parameter keys, units, ranges and defaults |
| `list_vst_plugins` | Installed VST3 effects |
| `get_filter_stack` | One stack with all values (VST3 values also as the plug-in's own text) |
| `add_filter` | Add a built-in filter or a VST3 plug-in, at a position, with values |
| `update_filter` | Change parameters, bypass or enable |
| `remove_filter`, `move_filter` | Remove or reorder |
| `apply_voice_chain` | High-pass, De-esser and Dynamics, appended or replacing the stack |
| `set_filter_stack` | Replace a whole stack in one step |
| `copy_filter_stack` | Copy a track's filters to another track or the master |
| `list_filter_presets` | Factory presets or the plug-in's own programs, plus the user's presets, for one filter |
| `apply_filter_preset` | Load a preset into a filter (by id or name) |
| `save_filter_preset` | Save a filter's settings as a user preset (same name replaces) |

Stacks are addressed by track name, track id or `master`; filters by id,
or by type or plug-in name when that is unique in the stack. Built-in
parameters use their real units (Hz, dB, ms, LUFS) and are clamped to the
ranges the sliders allow; VST3 parameters are normalized 0–1 and addressed
by id or title, as with the generated sliders (plug-in editors are never
opened).

## Recording safety

Recordings are built to survive crashes, power cuts and full disks:

- A worker thread writes every input buffer to the WAV files as it arrives, so a crash of the app (even `kill -9`) loses at most a few milliseconds. Headers are updated every second and everything is forced to the disk every 2 seconds, so a power cut loses at most about 2 seconds.
- Files over 4 GB become RF64 automatically.
- While a take runs, `recording-in-progress.json` in the project folder lists its files. If WavePod finds it when a project opens, the take was interrupted: the files are repaired and put back on their tracks, and a dialog says so. A backup of the project from before the recovery is kept in `backup/`.
- If the disk fills up, audio is held in memory (up to 1 GB) and written as soon as there is space again. WavePod won't start a take with less than a minute of space left.
- If the audio interface drops out mid-take (a USB reset or a loose cable), the take keeps running with silence, so the tracks stay in time with the clock and with a guest's own recording. WavePod reconnects as soon as the device is back, also under a new device id, and the gap gets a ⚠ edit marker.
- Closing the window mid-take asks first; Ctrl+C, SIGTERM and logout stop the take and save; a crashed window reloads while recording continues.

While recording, a bar under the toolbar warns about dropouts (audio the device never delivered), crackle, clipping, inputs that get no signal, a stalled input device, a slow or nearly full disk and write errors. The status bar shows how much recording time the disk has left. When the take stops, every problem spot gets a ⚠ edit marker so you can listen to it.

## Projects

Each episode is a folder (default `~/Documents/WavePod/Episode …`) with
`project.json` and a `media/` folder of WAV files. Changes are saved
automatically.

WavePod used to be called SoundPod. If you still have a
`~/Documents/SoundPod` folder and no `~/Documents/WavePod`, WavePod keeps
using the old folder, episodes and templates included. Settings (devices,
MIDI mappings, last episode) are copied from the old SoundPod app-data
folder on the first start.

Templates live in `~/Documents/WavePod/Templates/<name>/`: a
`template.json` plus a `sounds/` folder with copies of the jingles, so a
template keeps working when the original jingle files move. A new episode
gets its own copies in its `sounds/` folder. Copy a template folder to share
it with another machine; input channels are matched by number, so it fits
best on the same audio interface.

## Releases

Pushing a tag like `v0.1.0` runs `.github/workflows/release.yml`, which
builds a Linux AppImage, a Windows NSIS installer and a macOS DMG and
attaches them to a GitHub release. Builds are unsigned until signing
certificates are configured as repository secrets.

## Third-party components

- [audify](https://github.com/almoghamdani/audify) (RtAudio bindings, MIT)
- [@breezystack/lamejs](https://github.com/breezystack/lamejs) (MP3 encoder,
  LGPL-3.0), bundled into the export worker
- [opusscript](https://github.com/abalabahaha/opusscript) (libopus 1.4 as
  WebAssembly, MIT; libopus itself is BSD-3-Clause) for the Opus export
- [VST3 SDK](https://github.com/steinbergmedia/vst3sdk) (MIT), used by the
  VST3 host helper
- the Dynamics filter (`src/core/fx/ultraschallDynamics.ts`) is a port of the
  Ultraschall Dynamics JSFX and stays under its original LGPL license
- some toolbar icons come from [Lucide](https://lucide.dev) (ISC)

Copyright notices and license texts are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [LICENSES/](LICENSES);
release builds ship them next to the app.

## License

WavePod is open source under the [MIT License](LICENSE), except for the
third-party parts listed above, which keep their own licenses.

VST is a registered trademark of Steinberg Media Technologies GmbH. RØDECaster,
Auphonic, Zencastr, Ultraschall and the other product names mentioned here are
trademarks of their respective owners, used only to describe compatibility.
WavePod is not affiliated with or endorsed by any of them.
