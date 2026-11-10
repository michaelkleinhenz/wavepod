# Loudness

Podcast apps and platforms expect episodes at a certain loudness, measured in LUFS. WavePod measures loudness the way broadcasters do (EBU R128) and brings your episode to the target on export.

## Targets

| Target | Use it for |
| --- | --- |
| **−14 LUFS** (Spotify / YouTube) | Episodes mainly heard on Spotify or YouTube, which play at −14 LUFS. |
| **−16 LUFS** (Podcast stereo) | Most podcasts. The default. |
| **−19 LUFS** (Podcast mono / Apple) | Mono podcasts, Apple's recommendation. |
| **−23 LUFS** (EBU R128 broadcast) | Radio and TV delivery. |
| **Custom…** | Any target from −30 to −9 LUFS, for a delivery spec that asks for something else. |

For a mono export, use −19 LUFS: the export dialog switches to it when you choose **Mono** under **Channels**. See [Exporting](export.md#formats).

Together with the target you set a **true-peak ceiling**, by default −1 dBTP: the highest any peak may reach, including peaks between samples that appear after MP3 or Opus encoding.

## Loudness analysis

**Edit › Loudness Analysis…** (`Shift+Ctrl+L`, or **Loudness…** in the toolbar) measures:

- the selected clips, or
- with no clip selected, the mix and every track, as they will be exported (after filters, before normalisation).

For each source it shows the figures Ultraschall shows:

| Figure | Means |
| --- | --- |
| **Integrated** | The loudness of the whole source. This is the number targets refer to. |
| **Loudness range (LRA)** | How much the loudness varies (from quiet to loud passages). |
| **Short-term max** | The loudest 3-second stretch. |
| **Momentary max** | The loudest 400-millisecond stretch. |
| **True peak** | The highest peak, measured 4× oversampled. |
| **Sample peak** | The highest sample value. |
| **To target** | The gain that would bring it to the target without the true peak going over the ceiling. |

A **short-term loudness curve** shows how the loudness moves over time, against the target line. Pick the target and ceiling at the top; they are remembered. **Analyse again** measures once more after you changed something.

## Normalise clips

**Edit › Normalize Clip Loudness** (`Alt+Shift+N`, **Normalise** in the toolbar, or right-click a clip › **Normalise to −16 LUFS**) sets the clip gain of each selected clip so it reaches the target on its own, without its true peak going over the ceiling. Use it to bring speakers, a jingle or an imported interview to the same level before you mix. It is one undo step.

## Loudness on export

The export dialog normalises the mix to the target (tick **Normalise loudness**, pick the **Target** and the **Peak ceiling**). Where the peaks would go over the ceiling, a look-ahead true-peak limiter holds them, so the target is still reached and the peaks stay below the ceiling.

**Analyse loudness** in the export dialog measures the mix before you export. While exporting, the dialog shows the momentary, short-term, integrated and true-peak figures live. See [Exporting](export.md).

## Keep voices even with filters

Normalising sets one gain per clip. To even out loud and quiet moments within a clip, use the **Dynamics** filter (it brings a voice to an even target loudness), or a **Compressor**. See [Filters and effects](filters.md).
