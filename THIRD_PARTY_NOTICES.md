# Third-party notices

WavePod itself is released under the [MIT License](LICENSE). It contains or
links the following third-party work, which stays under its own license.
Full license texts that are not reproduced below are in [LICENSES/](LICENSES).

## Code distributed with WavePod

### Ultraschall Dynamics (LGPL)

`src/core/fx/ultraschallDynamics.ts` is a TypeScript port of the
"Ultraschall Dynamics" JSFX from
[Ultraschall](https://github.com/Ultraschall/ultraschall-portable)
(`Effects/dynamics/Ultraschall_Dynamics`):

    Copyright (C) 2016 Cockos Inc
    License: LGPL - http://www.gnu.org/licenses/lgpl.html
    Dynamics Code derived from Cockos General Dynamics
    Limiter Code from LOSERs "MGA JS Limiter"
    modified by fernsehmuell and rstockm (ultraschall.fm)
    added further options by Meo-Ada Mespotine

As a derivative of that work, this one file is licensed under the GNU Lesser
General Public License (see [LICENSES/LGPL-3.0.txt](LICENSES/LGPL-3.0.txt) and
[LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt)), not under the MIT License. Its
source is the file named above.

### LAME (LGPL-2.0-or-later), via wasm-media-encoders (MIT)

MP3 encoder: [LAME](https://lame.sourceforge.io/) 3.100 compiled to WebAssembly
by [wasm-media-encoders](https://github.com/arseneyr/wasm-media-encoders). The
`.wasm` file is bundled into the export worker (`dist/main/exportWorker.js`).
LAME is licensed under the GNU Library General Public License, version 2 or (at
your option) any later version; WavePod uses it under the LGPL v3.0 (see
[LICENSES/LGPL-3.0.txt](LICENSES/LGPL-3.0.txt) and
[LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt)). LAME's source is at
<https://lame.sourceforge.io/>, the WebAssembly build at the link above. The
complete source of WavePod, including the build script that bundles it, is in
this repository, so it can be rebuilt with a modified encoder.

wasm-media-encoders:

    MIT License

    Copyright (c) 2020-2024 arseneyr

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.

### audify (MIT) and RtAudio (MIT-style)

<https://github.com/almoghamdani/audify>, built from source with the changes in
`patches/`.

    MIT License
    Copyright (c) 2019 Almog Hamdani

audify includes [RtAudio](https://github.com/thestk/rtaudio):

    RtAudio: a set of realtime audio i/o C++ classes
    Copyright (c) 2001-2023 Gary P. Scavone

Both are distributed with their license files in `node_modules/audify`.

### opusscript (MIT) and libopus (BSD-3-Clause)

<https://github.com/abalabahaha/opusscript>, libopus compiled to WebAssembly.

    The MIT License (MIT)
    Copyright (c) 2016-2021 abalabahaha

libopus: Copyright 2001-2011 Xiph.Org, Skype Limited, Octasic, Jean-Marc Valin,
Timothy B. Terriberry, CSIRO, Gregory Maxwell, Mark Borgerding, Erik de Castro
Lopo. BSD-3-Clause; the full notice ships as
`node_modules/opusscript/build/COPYING.libopus`.

### VST 3 SDK (MIT)

The VST3 host helper (`native/vsthost`) is built on Steinberg's
[VST 3 SDK](https://github.com/steinbergmedia/vst3sdk), fetched at build time.

    MIT License
    Copyright (c) 2026, Steinberg Media Technologies GmbH

### Lucide icons (ISC)

Several toolbar icons in `src/renderer/icons.ts` use paths from
[Lucide](https://lucide.dev).

    ISC License

    Copyright (c) 2026 Lucide Icons and Contributors

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted, provided that the above
    copyright notice and this permission notice appear in all copies.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
    WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
    MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
    ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
    WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
    ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
    OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

Some of these Lucide icons (clipboard, zoom-in, zoom-out) are derived from
[Feather](https://feathericons.com):

    The MIT License (MIT)
    Copyright (c) 2013-present Cole Bemis

    Permission is hereby granted, free of charge, to any person obtaining a
    copy of this software and associated documentation files (the
    "Software"), to deal in the Software without restriction, including
    without limitation the rights to use, copy, modify, merge, publish,
    distribute, sublicense, and/or sell copies of the Software, and to permit
    persons to whom the Software is furnished to do so, subject to the
    following conditions:

    The above copyright notice and this permission notice shall be included
    in all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
    OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
    MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
    NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
    DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
    USE OR OTHER DEALINGS IN THE SOFTWARE.

### LiveKit client SDK (Apache-2.0) and its dependencies

The remote guests feature (the app's call window and the guest page in
`site/join/v1/`) bundles [livekit-client](https://github.com/livekit/client-sdk-js),
Copyright LiveKit, Inc., licensed under the Apache License 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>), together with:

| Package | License |
| --- | --- |
| @livekit/protocol, @livekit/mutex | Apache-2.0, Copyright LiveKit, Inc. |
| @bufbuild/protobuf | Apache-2.0 and BSD-3-Clause, Copyright Buf Technologies, Inc. and Google Inc. |
| webrtc-adapter | BSD-3-Clause, Copyright The WebRTC project authors |
| jose | MIT, Copyright Filip Skokan |
| events, loglevel, sdp-transform, sdp, machina, typed-emitter | MIT, Copyright their authors |
| tslib | 0BSD, Copyright Microsoft Corporation |

The full license texts ship with each package in `node_modules`. No LiveKit
server code is part of WavePod; the call runs through a LiveKit server the user
sets up (LiveKit Cloud or their own).

### Mediabunny (MPL-2.0)

Video podcasts (camera import, preview and **Export Video…**) use
[Mediabunny](https://github.com/Vanilagy/mediabunny) 1.x, Copyright Vanilagy,
licensed under the Mozilla Public License 2.0 (full text in
`LICENSES/MPL-2.0.txt`). WavePod uses it unmodified; its source code is
available at <https://github.com/Vanilagy/mediabunny>.

### Electron (MIT)

The app runs on [Electron](https://www.electronjs.org/), which ships its own
license files (`LICENSE` and `LICENSES.chromium.html`) next to the app.

## Trademarks

VST is a registered trademark of Steinberg Media Technologies GmbH.
RØDECaster is a trademark of RØDE Microphones. Auphonic, Ultraschall, REAPER,
Podlove, LiveKit, Zoom PodTrak, Focusrite, Bitfocus Companion, Stream Deck, Claude and
other product names are trademarks of their respective owners. They are used
only to describe compatibility; WavePod is not affiliated with or endorsed by
any of them.

## Web page

The project web page in `site/` uses the Inter, Space Grotesk and JetBrains
Mono fonts, served from the site itself and licensed under the SIL Open Font
License 1.1 (see `site/fonts/LICENSE-*.txt`).
