# MIDI and remote control

Start and stop recording, drop markers, cough and fire jingles without touching the keyboard: from a MIDI controller, a Stream Deck or any app that sends OSC. Both are set up in **Edit › Settings… › Controllers**. The settings belong to the computer, not to the episode, so they work in every episode.

## MIDI controller

Any class-compliant USB MIDI controller works: a pad controller, a keyboard, a foot switch or a mixer's MIDI out, such as the buttons of a RØDECaster.

1. Tick **Use a MIDI controller**. Connected devices are listed; a new one shows up as soon as you plug it in.
2. Click **Learn** next to a function and press the pad, key or button you want for it. **Esc** cancels.
3. Repeat for every function you want.

| Function | Does |
| --- | --- |
| Start recording / Stop recording / Record on / off | Controls recording. |
| Punch in | Re-records the selected range with pre-roll. See [Punch-in](recording.md#punch-in-re-record-one-line). |
| Play / Pause, Stop | Controls playback. |
| Chapter marker, Edit marker | Drops a marker at the playhead. |
| Prepare for editing | Unarms all tracks. |
| Cough button, speaker 1–6 (hold) | Mutes that speaker while held. |
| Soundboard 1–9, Stop all sounds | Plays jingles. |
| Pre-show on / off | Only the soundboard is heard. |

Notes fire when pressed, controllers when they go above 0 (once per press, so a fader doesn't repeat), program changes always. The last message received is shown, which helps to find out what a button sends.

### Device and button type

Tick **Show device and button type** for two more settings per function:

- **Device**: a mapping listens to the device it was learned from. Choose **Any device** if you use more than one controller.
- **Button type**: **Momentary** for buttons that send "on" when pressed and "off" when released; **Toggle** for latching pads that send "on" and "off" on alternate presses. Learn detects this by itself; fix it here if it guessed wrong.

## Stream Deck and OSC remotes

WavePod can be remote-controlled over OSC, for example from a Stream Deck through Bitfocus Companion (a *Generic OSC* connection), TouchOSC, or anything else that sends OSC over UDP.

1. Tick **Use remote control** under **Stream Deck and OSC remotes**.
2. Point your remote at this computer, port **9000**.

Open **Connection details and addresses** to change the **UDP port**, to tick **Accept from other computers** (by default only programs on this computer can send), and to see the full list of addresses:

| Address | Does |
| --- | --- |
| `/wavepod/record`, `/wavepod/record/start`, `/wavepod/record/stop` | Record on / off, start, stop |
| `/wavepod/punch` | Punch in: re-record the selection with pre-roll |
| `/wavepod/play`, `/wavepod/stop` | Play / pause, stop |
| `/wavepod/marker/chapter`, `/wavepod/marker/edit` | Drop a marker |
| `/wavepod/prepare` | Prepare for editing |
| `/wavepod/cough/1` … `/wavepod/cough/6` | Cough button: argument 1 mutes the speaker, 0 releases |
| `/wavepod/sound/1` … `/wavepod/sound/9`, `/wavepod/sounds/stop` | Play a soundboard slot, stop all sounds |

A button that sends 1 on press and 0 on release fires once; a message without arguments counts as a press.

## Keyboard

Everything above also has a key. See [Keyboard shortcuts](shortcuts.md).
