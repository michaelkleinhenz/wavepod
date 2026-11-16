# Filters and effects

Every track, every clip and the master bus can have a stack of filters: EQ, compressor, noise reduction, voice effects and your installed VST3 plug-ins. Filters work live while you play, so you hear every change at once, and the export uses exactly the same settings.

## The FX panel

Open it with **FX** in a track header, **FX** on a clip, or **Master FX** in the header. The panel opens at the side of **Record & Edit** and stays open while you move between tracks; click another track's **FX** to switch to it. It hides outside **Record & Edit** and comes back when you return.

- **+ Add filter…** adds a built-in filter, a voice effect, a place, or a VST3 plug-in.
- **Voice chain** (on a track without filters) adds High-pass, De-esser and Dynamics: a good start for any voice.
- Filters run **top to bottom**, before the track gain and pan. Drag a card by its grip to reorder it, or use the up and down arrows.
- The checkbox on a card bypasses the filter; **×** removes it.
- Click the arrow on a card, or double-click its title, to fold its settings away. Folded cards stay folded.
- While playing, each card shows the level going in and out and how much the filter is turning the sound up or down.

Every slider's value can be clicked to type an exact number, such as `-3,5 dB`, `1.2 kHz` or `250 ms`.

## Built-in filters

| Filter | What it is for |
| --- | --- |
| **High-pass** | Removes rumble, handling noise and plosive thumps below the voice. |
| **Equalizer** | Parametric EQ: low shelf, two bell bands and a high shelf. |
| **Noise gate** | Turns the track down while nobody speaks into it (room noise, other speakers bleeding in). Pre-open looks ahead so the gate is already open when a word starts. |
| **Compressor** | Evens out loud and quiet passages of a voice. |
| **De-esser** | Tames sharp "s" and "sh" sounds by turning down only the highs when they get loud. |
| **Limiter** | Keeps peaks below the ceiling. |
| **Dynamics** | Brings a voice to an even target loudness: quiet speech is raised, loud speech is held back, and everything below the noise gate is muted. A port of Ultraschall's Dynamics. |
| **Noise reduction** | Turns down steady background noise (hiss, hum, fans, air conditioning) between and under the words. It learns the noise by itself from the quiet moments. |
| **AI voice cleanup** | Separates the voice from background noise and from the room's echo with a neural network, and gives each part its own level: Voice, Ambience and Reverb. See [AI voice cleanup](#ai-voice-cleanup). |
| **Mouth de-click** | Removes lip smacks, tongue clicks and the sticky clicks of a dry mouth, and fills each one in from the voice around it. See [Repair filters](#repair-filters). |
| **Breath control** | Finds the breaths between phrases and turns them down, without cutting them out. See [Repair filters](#repair-filters). |
| **Reverb** | Adds room to a dry signal, for example a jingle bed or a voice that sounds too close. **Decay (RT60)** sets how long the tail lasts in seconds (a furnished room is about 0.3–0.5 s, a church 2–4 s); **Room size** sets how dense and spread out it is. |
| **Band-pass** | Keeps only the frequencies between the low and the high cut: telephone, radio and walkie-talkie voices, or a muffled voice behind a wall. |
| **Distortion** | Saturation, clipping or fuzz, optionally with fewer bits and a lower sample rate. |
| **Echo** | Repeats the sound after a delay, each repeat a little duller. |
| **Room & distance** | Puts a voice into a place and moves it closer or further away. See [Audio drama](audio-drama.md#places). |
| **Convolution reverb** | Puts the sound into a real room by convolving it with an impulse response (IR), a WAV recording of that room. See [Impulse responses](audio-drama.md#impulse-responses). |
| **Pitch shift** | Makes a voice higher or lower without changing its speed. |
| **Ring modulator** | Makes a voice metallic: robots, aliens, broken machines. |
| **Chorus / flanger** | Chorus, flanger and vibrato: magic, dreams, teleports, ghosts. |

Hold the mouse over a filter's name in the panel for a fuller description. Filters that need to look ahead (Noise gate, Dynamics, Noise reduction, AI voice cleanup, Mouth de-click, Breath control, Pitch shift, Convolution reverb) add a little latency, which WavePod compensates, so tracks stay in sync.

For the voice effects (telephone, robot, giant, …) and places (kitchen, church, forest, …), see [Audio drama](audio-drama.md).

## AI voice cleanup

**AI voice cleanup** takes a recording apart into three parts and lets you mix them back at the level you want:

| Control | What it sets |
| --- | --- |
| **Voice** | The dry voice. Leave it at 0 dB, or raise it a little to bring a speaker forward. |
| **Ambience** | Everything that is not the voice and not the room's echo: fan and air-conditioning noise, hum, traffic, wind, a café, music playing in the background. |
| **Reverb** | The echo of the room on the voice: the hollow sound of a kitchen, an office or a large hall. |

All the way down (**Off**, −60 dB) a part is gone; 0 dB leaves it as it was recorded. With all three at 0 dB you hear the original. By default the filter removes the background completely and leaves a little room (−15 dB), which sounds natural; the presets cover the common cases:

- *Studio voice* removes all noise and room, as if recorded in a booth.
- *Natural room* and *Street interview* keep a hint of the place.
- *Noise only* and *Room only* touch just one of the two.
- *Remote guest* is made for laptop and phone recordings.
- *Atmo only (no voice)* keeps only the background, for room tone and atmos in an audio drama.

How it works: a neural network ([DeepFilterNet 3](https://github.com/Rikorose/DeepFilterNet)) separates speech from everything else, and a room model predicts the echo of each sound from what was said a moment before, using the room's reverberation time. WavePod measures that time by itself from how fast the sound dies away after words, so the Reverb control gets better over the first 10–20 seconds of a recording; a jump in the timeline keeps what it has learned.

Good to know:

- It runs **on your computer**, on the processor (no graphics card needed), and nothing is uploaded. Each mono track takes roughly a tenth of one processor core; a stereo track twice that.
- It is meant for **voices**. On music, singing or sound effects it takes away much of what you want to keep. Put it on the voice tracks, not on the master.
- It adds about **40 ms of latency**, which WavePod compensates during playback and export. Your recordings stay untouched: the filter works live while you play and edit, and in the export. WavePod does not send inputs through filters while recording, so what you hear on headphones while recording is not cleaned.
- Very strong settings on a very noisy or very echoey recording can make a voice sound thin or slightly processed. Turning **Ambience** or **Reverb** up a few dB from Off usually sounds more natural than removing everything.
- The simpler **Noise reduction** filter needs far less processing power and is enough for steady hiss.

## Repair filters

The repair filters fix small faults in a voice recording that the listener notices more than you would think. Like everything else in WavePod they run on your computer and work live while you play, so you hear every change at once.

### Mouth de-click

**Mouth de-click** removes the small noises a mouth makes between and inside words: lip smacks, tongue clicks, and the sticky saliva clicks of a dry mouth. Each of these lasts only a few thousandths of a second and is much sharper than the voice around it. The filter finds them and fills each one in with what the voice just before and just after it predicts, so the words themselves stay as they were.

| Control | What it sets |
| --- | --- |
| **Sensitivity** | How far a sound has to stand out from the voice around it to count as a click. Higher catches quieter clicks. |
| **Click length** | The longest sound that still counts as a click (0.5–10 ms). Raise it for long, wet lip smacks; lower it if sharp consonants lose their edge. |
| **Listen to** | *Clicks only* plays just what the filter takes out. Turn up Sensitivity until you hear the clicks, and stop before you hear bits of words. |

Start with the default or the *Dry mouth* preset. If a sharp *t*, *k* or *p* sounds dull afterwards, lower Sensitivity or Click length. Put the filter first on the track, before compressor and Dynamics, because those make clicks louder. It adds about 27 ms of latency, which WavePod compensates.

### Breath control

**Breath control** finds the breaths between phrases and turns them down instead of cutting them out. A podcast without any breaths sounds unnatural, but loud gasps, especially after a compressor, are tiring to listen to. The filter recognises a breath as soft, unvoiced sound that sits well below the speaking level and above the room noise, and lasts at least **Shortest breath**. It learns both levels by itself in the first seconds.

| Control | What it sets |
| --- | --- |
| **Reduction** | How far breaths are turned down. −9 to −12 dB keeps them natural; −30 dB or more almost removes them. |
| **Sensitivity** | Higher also catches softer and shorter breaths, and breaths closer to the speaking level. |
| **Shortest breath** | Shorter unvoiced sounds are left alone, so soft word endings stay. |
| **Listen to** | *Breaths only* plays just what the filter turns down. If you hear bits of words, lower Sensitivity. |

Put Breath control before the compressor and Dynamics, which would otherwise raise the breaths again. The filter needs to hear a whole breath before it acts, so it adds about 160 ms of latency, which WavePod compensates.

## Presets

Every filter card has a **Presets…** menu.

- Built-in filters come with **factory presets** tuned for speech, for example Compressor *Spoken word*, EQ *Clarity for dynamic mics*, Noise reduction *Computer fan*, AI voice cleanup *Studio voice* or Mouth de-click *Dry mouth*. Hover one to see what it is for. *Default* goes back to the starting values.
- VST3 plug-ins offer their own programs (factory presets) there.
- **Save as preset…** stores the current settings (for VST3 plug-ins including the plug-in's state) as your own preset, available in every episode. Rename (✎) or delete (🗑) the preset that is loaded.
- The menu shows *(edited)* once you change a value after loading a preset.

Your presets are JSON files in `Documents/WavePod/Presets/`, one folder per filter or plug-in, so you can copy them to another computer.

## Copy and paste filters

- **Copy all** in the panel copies a track's whole filter stack; the copy button on a card copies just that filter.
- Open another track (or Master FX) and use **Paste…** to add the filters at the end or at the top, or to replace the stack.
- When the copied filter is the same kind as a card (the same built-in filter or the same VST3 plug-in), that card offers **Paste settings**, which keeps its place and bypass.

Copies include VST3 state and the preset name, work across episodes, and each paste is one undo step.

## Clip filters

Hover a clip and click **FX** on it to give just that clip filters of its own. They run after the track's filters. Use them when one part of a track needs different treatment, for example a phone voice for one line, or one clip further away than the next.

## Master FX

**Master FX** in the header holds the filters on the whole mix. A **Limiter** at the end keeps peaks below a ceiling. The master filters are applied to the export but not to stems.

## VST3 plug-ins

Installed VST3 effects appear under **+ Add filter… › VST3 plug-in…**. They work in the same stack as the built-in filters, with plain sliders for their parameters instead of the plug-in's own window.

VST3 plug-ins run in a separate process, so a crashing plug-in can't take a recording down. Their settings are saved with the episode, in templates and in presets.

## Let an AI agent set up your filters

With **AI agents** switched on in the settings, an AI app such as Claude can build and tweak filter stacks for you: "give every speaker the voice chain and put a limiter at −1 dB on the master". See [AI agents (MCP)](ai-agents.md).
