# AI agents (MCP)

WavePod can let an AI app on your computer, such as Claude Desktop or Claude Code, work on the open episode through the Model Context Protocol (MCP). Ask it in plain words, for example:

> "Give every speaker the voice chain, put a gentle compressor after the de-esser on the guest and a limiter at −1 dB on the master, then check the loudness."

The agent mainly works with filter stacks, and can also read tracks, markers, loudness and the transcript, set up folders, automation, stems and automix.

## Switch it on

Open **Edit › Settings… › AI agents** and tick **Allow AI agents to control WavePod**. It is off by default.

The server listens on `http://127.0.0.1:47474/mcp` and only accepts connections from this computer; requests from web pages are refused. Any program on your computer can connect while it is on, so switch it off when you don't use it. The port can be changed under **Connection details**.

## Connect your AI app

**Claude Code:** run this once in a terminal (the settings show the command with a copy button):

```
claude mcp add --transport http wavepod http://127.0.0.1:47474/mcp
```

**Claude Desktop** and other apps that only start local commands: add this to `claude_desktop_config.json` (Settings › Developer › Edit Config) and restart the app. It needs Node.js for `npx`.

```
{
  "mcpServers": {
    "wavepod": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:47474/mcp"]
    }
  }
}
```

**Cursor, VS Code and others** that speak Streamable HTTP directly just need the URL.

WavePod has to be running, with the server switched on, when the app connects.

## What an agent can do

Every change an agent makes is one undo step (`Ctrl+Z`), shows up in the FX panel at once and is announced with a short message at the bottom of the window.

| Tool | What it does |
| --- | --- |
| `get_project` | Episode name, folder, sample rate, length, metadata, transport state |
| `list_tracks` | Tracks and the master with gain, pan, mute/solo, clips and filter names |
| `list_markers` | Chapter and edit markers with times |
| `get_transcript` | The episode's transcript as text |
| `get_script` | The imported audio drama script: every line, whether it is recorded and where its take is |
| `measure_loudness` | Loudness figures of the mix and every track, after the filters |
| `list_filter_types` | Built-in filters with their parameters, units, ranges and defaults |
| `list_vst_plugins` | Installed VST3 effects |
| `get_filter_stack` | One stack with all values |
| `add_filter`, `update_filter`, `remove_filter`, `move_filter` | Change filters one by one |
| `apply_voice_chain` | High-pass, De-esser and Dynamics |
| `apply_voice_effect` | A voice effect or place (telephone, robot, church, …) |
| `set_filter_stack`, `copy_filter_stack` | Replace a whole stack, or copy one to another track |
| `list_filter_presets`, `apply_filter_preset`, `save_filter_preset` | Presets |
| `set_automix` | Crosstalk removal on a track |
| `set_track_automation` | Volume and pan automation |
| `set_track_stem` | Which stem a track goes to |
| `create_folder`, `move_tracks_to_folder`, `update_folder`, `remove_folder` | Track folders |

Agents never open VST3 plug-in windows; they set the same parameters you see as sliders.
