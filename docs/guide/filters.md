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
| **Reverb** | Adds room to a dry signal, for example a jingle bed or a voice that sounds too close. **Decay (RT60)** sets how long the tail lasts in seconds (a furnished room is about 0.3–0.5 s, a church 2–4 s); **Room size** sets how dense and spread out it is. |
| **Band-pass** | Keeps only the frequencies between the low and the high cut: telephone, radio and walkie-talkie voices, or a muffled voice behind a wall. |
| **Distortion** | Saturation, clipping or fuzz, optionally with fewer bits and a lower sample rate. |
| **Echo** | Repeats the sound after a delay, each repeat a little duller. |
| **Room & distance** | Puts a voice into a place and moves it closer or further away. See [Audio drama](audio-drama.md#places). |
| **Convolution reverb** | Puts the sound into a real room by convolving it with an impulse response (IR), a WAV recording of that room. See [Impulse responses](audio-drama.md#impulse-responses). |
| **Pitch shift** | Makes a voice higher or lower without changing its speed. |
| **Ring modulator** | Makes a voice metallic: robots, aliens, broken machines. |
| **Chorus / flanger** | Chorus, flanger and vibrato: magic, dreams, teleports, ghosts. |

Hold the mouse over a filter's name in the panel for a fuller description. Filters that need to look ahead (Noise gate, Dynamics, Noise reduction, Pitch shift, Convolution reverb) add a little latency, which WavePod compensates, so tracks stay in sync.

For the voice effects (telephone, robot, giant, …) and places (kitchen, church, forest, …), see [Audio drama](audio-drama.md).

## Presets

Every filter card has a **Presets…** menu.

- Built-in filters come with **factory presets** tuned for speech, for example Compressor *Spoken word*, EQ *Clarity for dynamic mics* or Noise reduction *Computer fan*. Hover one to see what it is for. *Default* goes back to the starting values.
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
