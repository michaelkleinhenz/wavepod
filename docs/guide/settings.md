# Settings

WavePod keeps two kinds of settings apart:

- **Episode settings** belong to one episode and travel with its folder: tracks, recording quality, filters, metadata, stems. Most of them are in **Setup** and the **Chapters** view.
- **App settings** belong to this computer and apply to every episode: devices, controllers, AI agents, the sound library, transcription. They are in **Edit › Settings…** (`Ctrl+,`) and in a few menu checkboxes. Your [favourite sounds](audio-drama.md#favourites) are app settings too: you manage them in the sound library.

## Edit › Settings…

The settings dialog has five tabs. A dot on a tab means something there is switched on.

### General

- **Recording alerts**: **Test emergency notification** shows the alarm WavePod raises when a recording loses its input. See [Recording](recording.md#recording-alerts).
- **Punch-in recording**: the **Pre-roll** and **Post-roll** in seconds around a punch-in. See [Recording](recording.md#punch-in-re-record-one-line).
- **Sound library**: the folder with your sound effects. See [Audio drama](audio-drama.md#sound-library).
- **Transcription**: the ElevenLabs API key, model, language, the names and terms to get right, and how crosstalk is left out. See [Transcript and text editing](transcript.md#set-up-transcription) and [Crosstalk](transcript.md#crosstalk).

### Controllers

- **MIDI controller**: map pads and buttons to recording, markers, cough buttons and jingles.
- **Stream Deck and OSC remotes**: remote control over the network.

See [MIDI and remote control](controllers.md).

### Cameras

The [CamPod](video.md#campod) camera recorder: its address and API key, and whether its cameras start and stop with the recording. **Test Connection** shows its cameras, and **Record H.264** sets a camera that sends MJPEG to a format WavePod can import.

### AI agents

**Allow AI agents to control WavePod** switches the local MCP server on. See [AI agents (MCP)](ai-agents.md).

### Remote guests

The LiveKit server that carries the call with remote guests, the guest page and whether video is allowed. See [Remote guests](remote-guests.md#livekit-server).

## Menu settings

These options are checkboxes in the menus and are remembered:

| Menu item | Does |
| --- | --- |
| **Edit › Prepare for Editing When Recording Stops** | Unarms all tracks after every take. Off by default. |
| **Edit › Confirm Before Stopping a Recording** | Asks before a take stops. On by default. |
| **Edit › Beep When a New Take Starts** | Beeps on the headphones at the start of each loop-recording pass and at the punch-in point. Not recorded, not in the mix-minus feed. On by default. |
| **View › Ping at Markers During Playback** | Beeps when playback passes a marker. Off by default. |

The playback speed, Repeat, the open Setup and Settings tab, which filter cards are folded, the loudness target of **Loudness analysis**, the open sound library tab and the export settings of your last export (the start for episodes that were never exported, see [Exporting](export.md#your-export-settings-are-remembered)) are remembered too.

## Setup

- **Setup › Project**: open, create and save episodes. See [Episodes and saving](episodes.md).
- **Setup › Audio**: the audio interface, recording quality, inputs and the second output, including a mix-minus for remote guests. See [Audio setup](audio-setup.md).

## The View menu

Besides switching views and the playback options, the **View** menu has:

- **Reload**: reloads the window (your episode and any recording are not affected).
- **Remote Guests** (`Shift+Ctrl+G`): the panel for guests who join from their browser. See [Remote guests](remote-guests.md).
- **Toggle Developer Tools**: for troubleshooting.
- **Toggle Full Screen**.

## Where settings are stored

App settings are stored in WavePod's settings folder for your user (on Linux `~/.config/WavePod`, on macOS `~/Library/Application Support/WavePod`, on Windows `%APPDATA%\WavePod`). API keys are kept encrypted with the system keychain where there is one. `settings.json` is saved safely: the previous version is kept as `settings.json.bak`, and WavePod reads that one if the file is ever damaged, for example by a power cut. Your own filter presets and templates are in `Documents/WavePod/`.
