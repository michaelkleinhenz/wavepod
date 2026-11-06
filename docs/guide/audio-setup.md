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

If your device has more than one pair of outputs, **Second output** sends a second feed to two more outputs of the same device, for example to a stream, a second headphone amp or a mixer channel for the soundboard.

- **Send to**: which output pair.
- **What it carries**: *Everything (same as your headphones)*, *Soundboard only*, or *Episode playback without live jingles*.

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
