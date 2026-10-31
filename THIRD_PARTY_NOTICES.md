# Third-party notices

Ultimate Video Editor is MIT-licensed. It also uses the following code under its own licence.

## three.js 0.186.1

Used by `packages/engine/src/world/` (the 3D world renderer), loaded on demand.

    The MIT License

    Copyright © 2010-2026 three.js authors

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.
## opentype.js

Used by `packages/engine/src/world/textOutlines.ts` for glyph contours.

The MIT License (MIT)

Copyright (c) 2020 Frederik De Bleser

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## three.js model loaders

`GLTFLoader`, `DRACOLoader`, `OBJLoader`, `STLLoader`, `PLYLoader` and `SkeletonUtils` come from three.js 0.186.1 (`three/addons/`), under the MIT licence above. They are used by `packages/engine/src/world/models.ts` to read 3D models, and are loaded with the 3D world renderer.

## Draco decoder

The glTF build of the Draco decoder (`draco_decoder.js`, `draco_decoder.wasm`, `draco_wasm_wrapper.js`), copied unmodified from `three/examples/jsm/libs/draco/gltf/` into `apps/desktop/src/renderer/public/draco/`. It decodes Draco-compressed glTF models.

Draco is Copyright Google Inc. and licensed under the Apache License, Version 2.0, available at <https://www.apache.org/licenses/LICENSE-2.0>. Source: <https://github.com/google/draco>. The files are distributed "AS IS", without warranties or conditions of any kind.

## meshoptimizer decoder

`MeshoptDecoder` (`three/addons/libs/meshopt_decoder.module.js`, meshoptimizer 1.1) decodes meshopt-compressed glTF models. Copyright (C) 2016-2026, Arseny Kapoulkine, under the MIT licence (text above, with that copyright holder).

## QuickJS (script sandbox)

Scripts (`script.run`, `packages/core/src/script/runtime.ts`) run in QuickJS compiled to WebAssembly: `quickjs-emscripten-core` 0.32.0 and `@jitl/quickjs-singlefile-mjs-release-sync` 0.32.0, unmodified. quickjs-emscripten is Copyright (c) 2019-2024 Jake Teton-Landis; QuickJS is Copyright (c) 2017-2021 Fabrice Bellard and Charlie Gordon. Both under the MIT licence (text above, with those copyright holders). Source: <https://github.com/justjake/quickjs-emscripten>.

## Sounds and sound recipes

- **Keyboard Soundpack #1** (single keystrokes) by unicaegames, from opengameart.org, dedicated to the public domain under CC0 1.0 (<https://creativecommons.org/publicdomain/zero/1.0/>). Its 32 single keypresses, trimmed and levelled, are `apps/desktop/src/renderer/src/library/keys.wav` (index in `keys.json`): the recorded `keys` sound pack.
- **AtomCut's typing packs.** The six synthesised packs (`mechanical`, `soft`, `vintage`, `thock`, `digital`, `pop`) in `packages/engine/src/soundSynth.ts` use AtomCut's recipe data (waveforms, frequencies, lengths, levels, filters), ported with permission of AtomCut's author; the synthesis code is our own.
- **AtomCut's CC0 sound library** (library.atomcut.net) is not shipped: sounds are fetched (or read from a local mirror) on use, and each keeps its own licence and credit in the project. The usage notes in `apps/desktop/src/shared/soundNotes.json` are our own words.

## Stickers

Not shipped: the sticker library reads local copies in `~/uve-assets` (see `apps/desktop/src/shared/stickers.ts`), and each sticker placed keeps its licence and credit in the project.

- **Fluent Emoji** by Microsoft (<https://github.com/microsoft/fluentui-emoji>), MIT License, Copyright (c) Microsoft Corporation. The 3D PNGs and colour SVGs, with their metadata (names, groups, keywords) used as search tags.
- **Open Peeps** and **Open Doodles** by Pablo Stanley (<https://www.openpeeps.com/>, <https://www.opendoodles.com/>), dedicated to the public domain under CC0 1.0.

## Phosphor Icons

The editor's interface icons are **Phosphor Icons** (`@phosphor-icons/react` 2.1.10, <https://phosphoricons.com>), MIT License, Copyright (c) 2023 Phosphor Icons. They are used unmodified through `apps/desktop/src/renderer/src/icons.tsx`.

## Website

The landing page in `website/` inlines 23 **Phosphor Icons** (`@phosphor-icons/core` 2.1.1, MIT, as above) unmodified, and loads the rest at run time without shipping it:

- **GSAP** 3.15.0 with **ScrollTrigger** (<https://gsap.com>), from cdnjs, under GreenSock's standard no-charge licence.
- **Lenis** 1.3.26 (<https://github.com/darkroomengineering/lenis>), from jsDelivr, MIT License, Copyright (c) darkroom.engineering.
- **Bricolage Grotesque**, **Anybody**, **JetBrains Mono**, **Noto Sans Devanagari** and **Noto Sans Tamil**, from Google Fonts, under the SIL Open Font License 1.1.
