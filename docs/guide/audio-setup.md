# Audio setup

The **Audio** tab in **Setup** (`Ctrl+1`) is where you tell WavePod what to record from and where to listen. A dot on the tab means something needs attention, for example no device is open.

WavePod records every input of a multichannel USB interface on its own, such as all 16 multitrack channels of a RØDECaster Pro II, the RØDECaster Duo, Zoom PodTrak P4 and P8, Focusrite interfaces and other class-compliant devices.

## Audio interface

- **Record from**: your microphone, mixer or audio interface. The list shows how many inputs each device has.
- **Listen on**: headphones or speakers for playback and the soundboard.
- **Headphones / speakers on**: when the output device has more than two outputs, which pair you listen on.
- **Recording quality**: Standard (16-bit WAV), High (24-bit WAV, recommended) or Maximum (32-bit float WAV). Higher leaves more headroom for editing. This is saved with the episode.
- **Look for devices again**: after plugging in a device or switching it on.

### Advanced audio settings

Open **Advanced audio settings** for the technical options. You rarely need them.

- **Audio driver**: how WavePod talks to your sound hardware. Change it only if your device is missing. On Windows, pick **ASIO** for multitrack interfaces such as the RØDECaster.
- **Sample rate**: 48 kHz is the podcast and video standard. Use what your interface is set to.
- **Latency (buffer size)**: lower reacts faster when you listen live; raise it if you hear clicks or dropouts.

The line at the bottom shows the engine's state: which driver runs, how many input and output channels are open and the episode's sample rate.

## Microphones and inputs

Below the interface you see every input of the device with a live meter. Speak into each microphone to see which input it is on.

When WavePod recognises the device (RØDECaster Pro II, RØDECaster Duo, RØDECaster Pro, Zoom PodTrak P4 and P8) its inputs are named for you, such as *Combo 1*, *USB Chat* or *Bluetooth*. Rows in green already have a track.

- **Create speaker tracks** creates one armed track for every microphone and remote source that doesn't have one yet, and takes you to **Record & Edit**.
- **+ track** next to an input adds a mono track for that input; **+ stereo track** on the left input of a pair adds a stereo track for both.

You can change a track's input later in the track header on the timeline. See [Tracks and mixing](tracks-mixing.md#the-track-header).

## Second output

**Second output** sends a second feed to two more outputs of the device you listen on, or to another output device such as a USB headset, a second sound card or a virtual cable into a call app. Use it for a stream, a second headphone amp, a mixer channel for the soundboard or a remote guest.

- **Send to**: *Off*, a free pair of the device you listen on (*Outputs 3 and 4*), or another device (with its pair, if it has more than one).
- **What it carries**: *Everything (same as your headphones)*, *Soundboard only*, *Episode playback without live jingles*, or *Mix-minus for a remote guest*.

Another device runs on its own clock, so WavePod passes the feed to it through a small buffer: it is a few milliseconds later than your headphones, and it keeps itself in step when the two clocks drift apart. If the device you listen on has only one pair of outputs and no other output device is connected, the card says so: connect one and click **Look for devices again**.

On Linux, **System default** (PulseAudio / PipeWire) has just two outputs. Other devices show up in the list if the audio driver can reach them (see [No audio devices](troubleshooting.md#no-audio-devices)).

## Mix-minus for remote guests

A guest on Zoom, Teams or the phone needs to hear you, but not themselves: if their own voice comes back to them through the call, they hear an echo with the call's delay, and the call can feed back. A mix-minus is the feed that carries everything except the guest.

1. Record the guest on their own track, from the input where the call computer or phone hybrid comes in.
2. On **Setup › Audio › Second output**, choose where the call gets its audio under **Send to**, and *Mix-minus for a remote guest* under **What it carries**.
3. Tick **Leave out** next to the guest's track.
4. Connect those outputs to the line input of the call computer or phone hybrid, and pick that input as the microphone in the call app. If the call runs on the same computer, send the feed to a virtual audio cable (for example VB-CABLE on Windows, BlackHole on macOS, or a PipeWire null sink on Linux) and pick the cable as the microphone in the call app.

The guest then hears every microphone that has a track, the soundboard and episode playback. Inputs no track records from are not sent, so a device's own stereo mix (which already contains the guest) never ends up in the feed. In pre-show only the microphones and the soundboard are sent. You can tick more than one track if several guests share one call, and you can change who is left out during a recording without interrupting it.

The microphones in the feed come straight from the inputs, before any filters, and are a few milliseconds late (about two audio buffers; see **Buffer size** under **Advanced**), which the guest won't notice on top of the call's own delay. Your own headphones are not changed: listen to your microphones through your interface's direct monitoring as before.

> **Tip:** Many podcast mixers, such as the RØDECaster, already make a mix-minus for their USB chat, Bluetooth and phone inputs. You only need WavePod's when your interface doesn't.

## Using a RØDECaster Pro II

1. Turn on multitrack mode in the RØDECaster's USB audio settings and connect it over USB.
2. On **Setup › Audio**, pick the RØDECaster under **Record from**.
3. Its channels appear under **Microphones and inputs** with their names and meters. Click **Create speaker tracks**.
4. Switch to **Record & Edit** and press `R`.
5. When you are done, use **Edit › Prepare All Tracks for Editing**. See [Recording](recording.md#after-recording).

On Windows the multitrack channels are only available through RØDE's ASIO driver: pick **ASIO** under **Advanced audio settings › Audio driver**.

## Linux: which driver to use

On a desktop with PipeWire or PulseAudio running, the sound server keeps the sound cards to itself. **System default** then uses PulseAudio / PipeWire, which reaches every device with all its inputs (a RØDECaster Pro II in its multitrack profile, for example). Over ALSA only the sound server's shared "Default ALSA Device" is left, with two channels and no separate inputs; Setup says so and offers **Use PulseAudio / PipeWire**. Pick ALSA only when no sound server runs.

## No devices?

If WavePod finds no devices it says so on the Audio tab. Plug in the interface, click **Look for devices again**, or try another driver under **Advanced audio settings**. If the audio system can't be started at all, WavePod uses virtual devices so you can still edit. See [Troubleshooting](troubleshooting.md#no-audio-devices).
