# AtomCut: what we learned and what we take from it

Date: 2026-10-24. Author: project team (clean-room notes).

## Ground rules

AtomCut's README states that the source is not open and all rights are reserved. Our professor gave written permission to reverse engineer it for this assignment. We still treat it as a clean-room reference: we study behavior, architecture and API design and describe them in our own words. We never copy AtomCut code, shaders, prompts or assets into this project. The npm package `@atomcut/mcp` is MIT-licensed, so its bridge design may be reused with attribution.

## Sources

- The shipped desktop app, AtomCut 4.9.0, analyzed with the REA tools. REA evidence IDs: app.asar analysis `ev_b9cf9b1b…`, web bundle analysis `ev_1c1e1d27…`, Electron fuses `ev_10d583ce…`.
- The MIT npm package `@atomcut/mcp` 3.6.0 (`src/cli.mjs`, `src/protocol.ts`).
- AtomCut's agent skill docs (SKILL.md version 2.28.0 and `references/3d.md`), read as MCP resources from the linked editor.
- AtomCut's agent bridge package and Agents tab, studied again for A6 (see "Agent bridge and the Agents tab" below).
- The live editor tools are gated: every tool call returns "driving AtomCut from an agent needs AtomCut Pro" (a free 7-day trial exists). The docs were enough for this study.

## Architecture (observed)

- **Thin Electron shell.** The main process registers a privileged `app://` scheme and loads the core web app "remote-first" from app.atomcut.net, falling back to a bundled copy. The shell only adds native helpers: clipboard file reads, linked media folders, a native menu driven by a serializable spec from the renderer, deep links (`atomcut://`) and auto-update from GitHub releases. It grants every permission request.
- **The core is a web app.** It is a Next.js static export that runs unchanged in a browser and in Electron. Native features sit behind a "platform" layer of ports and adapters (`window.__ATOMCUT_DESKTOP__` in Electron, web fallbacks otherwise).
- **Rendering.** A static scan found three.js and WebGL2 in the bundle, and no WebGPU strings.
- **Export.** WebCodecs (`VideoEncoder`, `AudioEncoder`) with `mp4-muxer`. The docs also mention SVG, Lottie, glTF/GLB, USDZ, OBJ and STL export.
- **Storage.** The browser holds the data in IndexedDB and OPFS. Projects save as a `.motion` file.
- **State.** The bundle contains zustand and immer. Audio uses AudioWorklet.
- **AI features.** The bundle mentions Gemini, ElevenLabs, OpenAI and fal endpoints, plus "whisper" for transcription. Whether keys are bring-your-own or proxied was not established.
- **Assets.** Iconify icons and Google Fonts are referenced. A bounded string search found no stock-media API (Pexels, Pixabay, Freesound, Openverse, Unsplash, Poly Haven). The rest of the library looks like built-in presets and generated content, such as synthesized keyboard sound packs.
  - A file inventory of the shipped web export (2026-10-24) confirms this. It bundles almost no media: 16 web-font files, four short voice lines used by two templates (`templates/playground`, `templates/talking-characters`), and logos. There is no stock library to reuse, and its files are not licensed for reuse anyway. Our library (Phase D) comes from open sources with known licences.

## The agent bridge (observed, MIT package)

- An MCP server runs as a stdio process (`npx @atomcut/mcp`). It hosts a WebSocket hub on `127.0.0.1:7317`.
- The editor tab connects out to the hub, because a web page cannot listen. It sends `hello {token, app, tools, knowledge}`, and the hub relays MCP `tools/call` requests as `call {id, name, input, session}`. The editor answers with `result {id, content, isError}`, where content may include PNG images.
- Tools and skill docs both come from the running editor build, so an agent is never taught verbs the app lacks. The docs are served as MCP resources (`atomcut://skill/...`).
- Several agent sessions share one link. The first bridge to take the port becomes the hub, and later bridges relay through it.
- Pairing: the user clicks Agents ▸ Use your agent app ▸ Link. An untrusted tab must also present a token that the bridge prints.

## Product and API model (from the docs)

- **Canvas and comps.** An infinite canvas holds pages of comps (artboards). Each comp is a timeline, a frame-by-frame flipbook, or a static design.
- **Units.** Comp space has its origin at the comp's centre, with +y down. Times are in milliseconds. Keyframe times are relative to the layer's start, unless the caller asks for comp time.
- **Three levels of writing.**
  1. Verbs that keep invariants (create layer, animation preset, add effect, group).
  2. `layer_set` by property path, for any animatable value.
  3. `layer_patch` with set/merge/insert/remove/move operations, re-validated against the schema.
- **Self-describing API.** `api_describe` returns any type's live schema, `layer_properties` lists a layer's animatable paths, and `catalog_list` lists presets (effects, animations, text templates, transitions, easings, blend modes, 3D primitives, materials, lights).
- **Batching and scripting.** `api_batch` runs many commands as one, and `$0.id` refers to earlier results. `script_run` handles computed or repetitive work.
- **Verification.** `view_render` and `view_frames` return images at several detail levels (glance, look, inspect). The skill tells agents to look after every visible change.
- **Undo and reporting.** An agent's whole turn is one undo step. `report_issue` files honest failure reports.
- **The loop the docs teach.** Orient, plan once, build in batches, look, refine, report. The docs also stress design craft: hierarchy, type scale, safe areas, easing rules and restraint.

## Command system internals (REA plus prettified reading of chunk 459)

These notes cover AtomCut 4.9.0's bundled web core, the chunk that contains the command registry. Our implementation is written independently.

- **Libraries.** The vendor chunk contains zod and immer with its patches plugin (`produceWithPatches`, `applyPatches`). AtomCut's undo is therefore patch-based.
- **Command shape.** A command is a plain object: a dotted id (`layer.patch`, `keyframes.set`, `api.batch`), a one-line summary, a longer `details` text written for agents, an `effect` flag (read or write), a zod input schema, and a `run(input, context)` function.
- **Registration and results.** Commands are registered in one registry. Calls return either a success value or a failure with an error message and a hint.
- **Writes.** Every write goes through a context method that takes a human label ("Edit layer", "Edit text") and an immer recipe. The label becomes the undo entry's name.
- **Patching a layer.** The patch command applies its operations to a copy of the layer and re-validates the whole layer against the schema, so an invalid patch changes nothing. It refuses fields that have dedicated commands (id, kind, timing, text content) and explains which command to use instead.
- **Storage.** A comp holds tracks (lanes), and each track holds clips (the layers).
- **Batches.** The batch command runs up to 40 calls in order. A later call can refer to an earlier result with `$N.path`. Batches cannot nest, and the batch stops at the first failure unless told to continue.
- **Project file.** The project package has a format version, `manifest.json`, `document.json`, `media/` and `fonts/`.

## Renderer internals (REA plus prettified reading of chunks 5009, 459 and the three.js chunks)

- **REA coverage.** The whole-app graph could not expand the two largest chunks: its result budget ran out, so only file-level facts were kept. A focused REA analysis of chunk 5009 failed to parse it (evidence `ev_7e505b7e…`). The findings below therefore come from string fingerprints and reading the prettified code.
- **Flat comps use Canvas2D.** The compositor chunk (5009) makes about 110 2D contexts and about 180 `drawImage` calls, plus `setTransform`, `fillText` and `Path2D`.
- **WebGL2 is only for pixel effects.** Its shaders cover chroma key, matte, the colour grade (white balance, lift, gamma, gain) and a separable blur.
- **Video.** Frames come from video elements paced with `requestVideoFrameCallback`.
- **three.js is only for 3D worlds.** It lives in separate chunks that load on demand: the core in `cb8e12c4`, cameras in `a55e8ffc` and `7481`, post-processing such as bloom in `6877`.
- **Camera math.** The core chunk (459) has its own 4×4 matrix helpers: a perspective matrix built from `1/tan(fov/2)`, an orthographic one, and a camera schema whose focal length defaults to 50 mm.

What this means for our design: flat comps render with Canvas2D. Layers that have depth or tilt are drawn by a small WebGL2 card projector, so they appear in true perspective while keeping their stacking order. three.js arrives with 3D worlds in step A7.

## Media import and video playback (step A4 research)

Sources: a new REA summary analysis of the shell (`app.asar`, evidence `ev_4810ad37…`) and a bounded REA analysis of web chunks 8083, 8995 and 4399 (`ev_0e7f2b08…`). REA feature traces on the seeds `media`, `loadedmetadata` found no graph entities, because the graph does not index these string literals; that is a limit of the graph, not evidence of absence. The findings below come from reading the shell's `electron/main.js` and `electron/preload.js` and prettified regions of chunks 8083, 5009 (the import module and the video playback code) and 459 (the byte store).

Observed:
- **No file protocol for media.** The shell's privileged `app://` scheme only serves the static web export. Media reaches the web app as bytes: dropped `File` objects, clipboard files that the main process reads (up to 1 GB each), and files from a "linked folder" that the main process scans (metadata only) and reads lazily, with a containment check on the relative path. The `app://` handler itself joins the decoded request path onto the export folder without such a check (a static reading, not tested).
- **Copy-in storage.** Every imported file is copied into browser storage: an OPFS directory named `assets`, keyed by asset id, with IndexedDB as the fallback. When the bytes are missing, the app asks the user to relink the file.
- **Kind detection.** The MIME type decides first (`image/`, `video/`, `audio/`), then the extension. The supported set is png, jpg, webp, gif, svg, avif (images), mp4, webm, mov, m4v (video) and mp3, wav, ogg, m4a, aac, flac (audio). Anything else is skipped. An SVG without a width and height gets them from its viewBox.
- **Metadata probe.** Images are measured with an `Image` element. Video and audio use a media element with `preload = "metadata"`, which gives the duration and the video size. Audio duration is then corrected from the decoded audio buffer. There is no container parser.
- **Placement.** A drop on the canvas places the clip at the drop point (comp coordinates, centre origin), starting at the playhead. Several dropped files are placed one after another, each starting where the previous one ends. Numbered image files become one image-sequence asset. The new clips are selected, and a toast reports the count. An agent-facing `media.import` command takes an attachment or a URL, an optional media folder, and an optional place on the timeline. It returns the asset id, kind, duration, size and the new clip id. `media.inspect` returns a contact sheet of video frames, an image, or audio loudness with silent ranges.
- **Preview playback.** Each video clip gets its own hidden, muted `<video>` element (`playsInline`, `preload = "auto"`, `crossOrigin = "anonymous"`, pitch correction off), parked in a 1×1 transparent host element so Chromium keeps decoding it. The comp clock is the master, and each element follows it:
  - While paused or scrubbing, the element seeks. Seeks are coalesced: while one is running, only the newest target is kept. The current frame is copied to an `ImageBitmap` before a seek, so the picture does not flash.
  - While playing, the element plays at the clip's speed. If it drifts more than about 0.3 s, it re-seeks, aiming ahead by the measured seek latency. Smaller drift is corrected by nudging `playbackRate` (at most ±25 %, at most every 250 ms, with a dead band of about 15 ms).
  - For exact frames (export), it seeks, waits for `seeked`, then waits for `requestVideoFrameCallback` so the frame is really decoded. A stalled seek is retried once after 2 s.
  - When the window is hidden, elements pause, and after 30 s they are released.

What we take, and what we do differently:
- We take: MIME-then-extension kind detection, probing before adding, the placement rules for drops, one hidden element per clip with the comp clock as master (seek when far, nudge the rate when near, coalesce seeks), waiting for a decoded frame before exact renders, and pausing when hidden.
- We do differently:
  - **Files stay where they are.** A desktop editor with limited disk should not copy every clip. A project stores absolute paths.
  - **A safe custom protocol.** The main process serves `uve-media://` URLs only for exact paths the user has granted, by dropping a file or picking it in the open dialog. It supports HTTP ranges (for seeking) and CORS headers (so frames stay readable for export).
  - **mediabunny for metadata.** It reads the container, so we get the duration, display size (rotation included), frame rate and codec, and whether this machine can decode the codec, before the file is added.

## How 2D and 3D connect (from the docs) — the key idea

1. **Depth in a flat comp.** Any layer can take `z`, `rotationX` and `rotationY`. A front camera draws flat comps in perspective, placed so that depth 0 maps exactly 1:1 to comp pixels. Layers keep their stacking order, so depth does not re-sort them.
2. **Worlds.** A world is a comp whose layers form a 3D scene. It uses Blender conventions: Z is up and 1 unit = 1 px = 1 cm. It nests into a flat comp as one layer, like a precomp, optionally with a transparent background.
3. **Moving into a world.** `world_move_into` moves selected layers, or a whole frame, into a new world nested in their place. The picture does not change, because a world without a camera renders through the same default front camera. Coordinates are remapped, keyframes included: 2D y becomes world −z, and 2D z becomes world y (depth). Adding a camera layer then lets the camera move through the scene.
4. **Cameras are timeline layers.** The live camera is the topmost visible camera layer covering the current instant, so camera cuts are just clips placed end to end on one lane.
5. **2D layers in a world.** Text, images, video, shapes and nested comps stand in the world as unlit "picture planes" with their exact colours. Each can be given thickness (extrude), a material and geometry modifiers.
6. **One physics system** serves both flat comps and worlds.

Our own way to build this: use one three.js renderer for every comp.
- **Flat comps.** Draw layers in stacking order with depth testing off, through a perspective camera at distance d = (H / 2) / tan(fov / 2). At that distance the z = 0 plane is pixel-exact.
- **Worlds.** Switch on depth testing, lights and materials, and use camera layers.
- **Nested comps.** Render them to targets and composite them as textured layers. Moving into a world then really changes only the coordinate convention and the render flags, which is why the switch can look seamless.

## What we adopt and what we do better

Adopt:
- A schema-first, self-describing command API.
- The three write levels.
- Batches with result references.
- Render-to-verify tools.
- Skill docs served as MCP resources from the same build.
- One undo step per agent turn.
- An issue-reporting tool.
- The 2D↔3D model above.

Improve:
- **No paywall on agent control.** Agent control is our core feature.
- **No stdio-to-WebSocket hop.** Our MCP server runs inside the Electron main process, over Streamable HTTP on localhost with a token, plus a tiny stdio shim for stdio-only clients.
- **A built-in agent.** We host OpenCode (and other ACP agents) inside the app; AtomCut relies on external agent apps.
- **Screen recording with auto-edit.** AtomCut has none; this is our differentiator, built on OpenScreen.
- **Gemini TTS** that picks the newest free-tier model automatically.
- **Real free stock sources** with license tracking and automatic attribution.

## Export to MP4 (step A5 research)

Sources: a REA analysis of chunk 7492 (summary view `ev_19ee80e5…`, parent `ev_78c8129a…`; one module, no parse failures) and prettified regions of chunk 5009 (the MP4 export, the audio encode and the offline mix). Chunk 5009 still does not graph on its own, so the findings below come from reading the code. Elah's export design notes (`packages/core/src/export/Architecture.md`, Apache-2.0) were read for comparison; no Elah code was copied.

Observed in AtomCut 4.9.0:
- **Muxer.** Chunk 7492 is the MIT library `mp4-muxer`, used unmodified (it exports `Muxer` and `ArrayBufferTarget`). It is loaded on demand when an export starts. The file is built in memory (`fastStart: "in-memory"`) and handed over as a Blob download.
- **Encoder choice.** The exporter tries H.264 configurations until `VideoEncoder.isConfigSupported` accepts one: constant-quantizer mode first, then variable bitrate; for each, software encoding first, then any encoder; for each, a ladder of AVC codec strings (profile and level) that fit the size and frame rate. It asks for `latencyMode: "quality"` and drops alpha. The picture size is made even, and the encoder's colour description is patched into the `avcC` box so players show the right colours.
- **Frame loop.** Frame n is drawn at comp time `start + n / fps`. Before each frame, it waits until every media element shows the exact frame for that time (seek, `seeked`, then `requestVideoFrameCallback`). The canvas becomes a `VideoFrame` with timestamp `n / fps` (in µs) and is encoded with a key frame every two seconds. When more than four frames wait in the encoder, it yields; it also yields every ten frames so the page stays responsive.
- **Audio first.** The whole audio track is mixed and encoded before the first video frame, and it takes the first 8 % of the progress bar. After muxing, the finished file is parsed again and its audio is decoded to measure the peak level, as a self-check reported in the console.
- **The offline mix.** One `OfflineAudioContext` (stereo, 48 kHz by default) renders the whole range. Each clip's file is decoded with `decodeAudioData` and played by an `AudioBufferSourceNode` at the clip's speed (`playbackRate`, so pitch follows speed, matching its preview, which turns pitch correction off). A clip that starts before the range is trimmed in by the overlap times its speed. A gain node per clip takes the static volume, or a curve sampled every 20 ms when volume is keyframed (or when crossfades or ducking apply). A second gain node fades each clip in over about 4 ms and out over about 8 ms, so cuts do not click. Gains above 1 pass through unclamped.
- **Fallbacks.** When the offline mix comes out silent, it is tried again at the live audio context's sample rate. When AAC encoding fails, Opus is tried, and as a last resort the mix is recorded live with `MediaRecorder`.

Elah (for comparison): a separate worker renders and encodes frame by frame, with one mediabunny `CanvasSink` per source video (`getCanvas(time)`), a `CanvasSource` for the encoder and an `AudioSampleSource` fed with one-second chunks of a mix made in an `OfflineAudioContext`.

What we take, and what we do differently:
- We take: an exact frame clock (frame n at `n / fps`, never a real-time clock), key frames every two seconds, encoder back-pressure, an even picture size, short fades at clip edges, gains above 1, pitch that follows speed, and checking the finished file.
- We do differently:
  - **Frames from mediabunny, not media elements.** Each video layer gets its own `CanvasSink` iterator that decodes forward in order, so no seek waits are needed and every frame is exact. Rotation metadata is applied by the sink.
  - **Our own audio mix.** Sources are decoded with mediabunny, only over the range each layer plays, and mixed in plain TypeScript with a windowed-sinc resampler for speed and sample-rate changes. The mix is deterministic and unit-tested, and it avoids the offline-context quirks AtomCut works around. It runs in windows interleaved with the video, so memory stays bounded and the muxer receives interleaved data.
  - **Straight to disk.** mediabunny writes the MP4 through a `StreamTarget` to a file the user picked in a save dialog, with the index reserved at the start of the file (fast start without holding the file in memory).

## Editor shell and visual design (step A5b research)

Sources: the running app, observed with REA on 2026-10-24. AtomCut was started with `--remote-debugging-port`, and the editor was opened by clicking the project's tab. The shell loads remote-first, so what runs is the web build **4.17.0** from app.atomcut.net, not the bundled 4.9.0.
- REA `capture_web_screenshot`: home `ev_4f4501cb…`, editor `ev_dd7df5fc…`.
- REA `inspect_web_page` with the accessibility tree: home `ev_b38eef7f…`, editor `ev_dc39fa6e…`.
- Box sizes and computed styles were measured with a read-only script over CDP. Window: 1266 × 657 CSS px, at 150 % scaling.

We take the layout and the visual language, described in our own words. No CSS or markup is copied.

**Layout.** The window is a dark stage. On it float rounded panels, 12 px radius, separated by 6 px gaps.
- **Left rail (64 px).** The app mark and a "Main menu" button. Then tabs with an icon over a 9 px label: Library, Media, Layers, Plugins, Agents, Scripts. At the bottom: Undo, Redo, Workspace, Report a bug, Settings. The active tab is tinted with the brand colour.
- **Library panel.** Search, "Starred only", "View and filters" and "Publish". Under them, a row of category icons. Then sections of horizontally scrolling cards (Text looks 103, Animations 44, Transitions 23, Sounds 6). Each card has a preview, a name, a star and a "+" (sounds have a play button).
- **Stage panel.**
  - A vertical tool palette on its left: Move, Hand, Frame, Text, Rectangle, Pen, Bone, Pixel brush, Vector brush, Eraser, Paint bucket.
  - A floating glass pill at the top right: a zoom percentage you drag to zoom (double-click resets), Preview quality ("Full") and Stage settings.
  - Each artboard is labelled above its top-left corner ("Frame 1  1080 × 1920").
- **Inspector.** With nothing selected it shows PROJECT (Name, and Canvas as a colour with an opacity) and VARIABLES. Section titles are small upper-case muted labels.
- **Right rail.** An Export button (brand colour, top) and a vertical "Project" tab.
- **Timeline panel (full width, bottom).**
  - A transport row: Jump to start, Play (a round brand-tinted button), Record keyframes, Cache, the timecode (mono, brand colour), "/ duration s", Frame loop, Split, Snapping, Linked selection, Markers, Working range, Lasso, "+ Track", "+ Clip" and a zoom slider.
  - Track headers: the name, then Toggle visibility, Toggle mute and Toggle lock.
  - A mono ruler ("0:01.0"). A mixer at the right (Level, Master meter).
  - A bottom tab bar: Timeline, Keyframes, Curves, Color, Nodes.

**Tokens (dark theme, measured).**

| Token | Value |
| --- | --- |
| Stage background | `#08060a` |
| Panel | `#100c11` |
| Viewport stage | `#060406` |
| Track lane | `#140f14` |
| Card | `#161016` |
| Popover | `#1b141b` |
| Brand / primary | `#ff4e6a` |
| Text | `#f1eaee` |
| Muted text | `#8c818a` |
| Border | white at 7 % |
| Input | white at 4 % |
| Hover | white at 8 % |
| Radius | 12 px |
| Shell gap | 6 px |
| Control height | 28 px |

- **Active states.** A tool or tab is "on" when it is filled with the brand colour at about 25 % and its icon or text is in the brand colour.
- **Type.** Inter. Mostly 11 px: labels, track names, toolbar text. Rail labels are 9 px. JetBrains Mono for timecodes and the ruler.
- **Glass.** The floating pill and the toasts are translucent popovers with `blur(24px) saturate(1.9)` and a 1 px inner highlight.
- **Panels.** They cast only a faint shadow (0 1px 2px at 40 % black). There are no visible borders between regions; the gaps do that work.

What we take, and what we do differently:
- We take the floating-panel layout, the left rail, the tool palette, the zoom pill, the artboard label, the transport row, the track header toggles, the brand-tinted active states and the type scale.
- We show only what works. Rail tabs, tools and timeline tabs appear when their feature exists. Agents arrives in A6; Keyframes and Curves come later.
- Track visibility, mute and lock become real track properties, edited through a `track.update` command, so agents can use them too.

## Timeline views, inspector and the preset library (step A5c research)

Sources: the live AtomCut 4.17.0, with a text look ("Arcade") and an animation ("Blur In") added to the empty Untitled project, and transform keys made through the UI.
- REA `capture_web_screenshot` of each view:
  - Timeline with a layer selected: `ev_b893b70f…`;
  - Keyframes: `ev_9bd254f0…`;
  - Curves: `ev_d2fc810f…`.
- Color and Nodes were captured over CDP.
- REA `analyze_javascript_application` on the agent bridge chunks `1b1a7b14` and `8509`: summary `ev_29af6ec1…`, 2 modules, no parse failures. That is input for A6.
- The preset catalogs were parsed out of the prettified chunk 459 with acorn, as data only (functions dropped). They are saved as `packages/core/src/looks.json`. The owner reports that the professor's permission covers AtomCut's presets and assets.

**Bottom tab bar.** It is centred under the timeline panel and holds Timeline, Keyframes, Curves | Color, Nodes. Timeline stays tinted while Keyframes or Curves is open: those two replace the lanes with a key editor for the selected layer.
- **Keyframes (dope sheet).**
  - A tree on the left: the layer name, a collapsible "Transform" group, then one row per animated property with a colour dot (X orange, Y cyan, Scale X violet, Scale Y pink, Rotation green, then "Other").
  - The group row sums its children's keys. Keys are diamonds, and a selected key is filled.
  - A small easing glyph sits between two keys. The layer's time range is shaded.
  - The tooltip reads "Dope sheet — every keyframe as a grid". With no keys it says "No keyframes yet".
- **Curves.**
  - The same property list, grouped (TRANSFORM, OTHER), with an eye per property to show or hide its curve.
  - The curves are drawn over each other, each normalised to its own range, with keys as small circles in the property's colour.
  - The layer's range shows as a bar along the top, and a vertical zoom sits on the right.
- **Color.** An empty state: "No grade on "HIGH SCORE" yet." and a brand button, "Start grading".
- **Nodes.**
  - A dot-grid canvas with the layer as a node graph: a Layer node feeding Transform and Typography nodes. Each node lists its properties with sockets.
  - A "Layer HIGH SCORE" chip at the top left, a minimap at the bottom left, and a settings button.
- **Mixer.** "MIX", with Level and settings buttons and a close button. One strip per sound category ("Effects", with M and S buttons) and a Master strip. Each strip has a dB readout (0.0) and a meter.

**Transport, complete.** Jump to start, Play, Record keyframes (a red dot; on, it keys every edit), Cache, the timecode, "/ duration s", Frame loop, Split, Snapping, Linked selection, Markers, Global markers, Add marker, Working range, Lasso, Clear, "+ Track", "+ Clip", and the zoom slider. Shift+Arrow moves the playhead 10 frames.

**Clips.** A clip shows its name with the kind icon and a sound icon, and a second mono line naming the animation ("TYPEWRITER · LETTER"). An animation is a band at the clip's start ("Blur…"). Keys show as small diamonds.

**Inspector, with a layer selected.**
- A header: kind icon and name, then Create component, Make 3D, Duplicate and Delete.
- Collapsible sections: ALIGN (8 align and distribute buttons), TRANSFORM, APPEARANCE, SIZING, CONTENT.
- TRANSFORM has a key diamond, plus previous and next key arrows, on its header. Its rows are:
  - Position (X, Y), Scale (X, Y, linked);
  - Rotate, Depth (Z);
  - Tilt (X, Y), Skew (X, Y), Pivot (X %, Y %).
- Each axis field is a scrub field with a small axis letter. A property with keys shows a red diamond at the row's end.
- A vertical tab rail on the right: Design, Effects, Animate, Physics, Sound.

**Preset system (from the catalog).**
- **Animations (44).** These are text and layer *animators*, not keyframes. Each has:
  - an id, a category (type, fade, slide, scale, bounce, spin, stylize, draw) and a scope (text, layer or both);
  - a default unit (letter, word or line), a duration, a stagger, sometimes jitter, and an easing;
  - numeric params with ranges;
  - in and out functions that map progress to offsets: opacity, dx, dy, scale, rotate, blur and so on.
- **Transitions (23).** An id, a category, an audio crossfade mode ("equal-power"), a duration, an easing, params, and a mix function (wipe, iris, barn and so on).
- **Text looks (103).** 14 categories: Titles, Captions, Kinetic, Minimal, Editorial, Cinematic, Impact, Luxury, Handwritten, Playful, Retro, Neon, Glitch, Terminal. Each look has:
  - a name, tags, a tagline and sample text;
  - a palette (ink, accent, shade);
  - a style: font family (68 Google Fonts in all), size, weight, letter spacing, colour as `@ink` or `@accent`;
  - text effects (shadow, glow, extrude, stroke) and an optional highlight box;
  - in and out animator references, and an optional typing-sound pack.
- **Sounds (6).** Synthesised typing packs: Mechanical, Soft, Vintage, Thock, Digital, Pop. Projects can also reference "This project", "All my projects" and "Media library" sources.

What we built from this in A5c, and what waits: see `docs/atomcut-parity.md` and `docs/PLAN.md`.

## Agent bridge and the Agents tab (step A6 research)

Sources: `@atomcut/mcp` 3.6.0 unpacked with `npm pack` (MIT: `src/cli.mjs`, `src/protocol.ts`, and the skill docs it bundles), the input schemas of AtomCut's own MCP tools (read from its server registered in Claude Code), and the live 4.17.0 Agents tab, read over CDP on port 9333 and captured with REA `capture_web_screenshot`.

**The bridge (3.6.0).**
- A stdio MCP server written by hand as newline-delimited JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`, `resources/read`. It declares `listChanged` for tools and resources and sends the notifications when the linked editor's list changes.
- The editor tab connects out to a WebSocket on `127.0.0.1:7317` and sends its tools and its own skill files (`hello`), so the docs always match the build. A tab from AtomCut's own origins is trusted by its Origin header; any other must send the token kept in `~/.atomcut-mcp`.
- **One link for every session (new in 3.5).** The first bridge to bind the port is the hub; every other agent session's bridge joins it over the same port and relays its calls, tagged with the session. When the hub exits, the others race to bind and one becomes the new hub. This replaced a "port as lock" design in which sessions kept asking to take the link over.
- The last editor's tool list and skill are cached on disk, so a new session lists the real tools at once, and a call made before the tab answers waits up to 17 s.
- A `localPath` argument is read by the bridge (the agent's machine and folder) and handed to the tab as base64, up to 48 MB.

**Undo and turns.** Their docs say an agent's writes in one user request are one undo step, labelled "AI · <request>", and that an edit by the user in between starts a new one. `history_undo` refuses to undo the user's steps.

**Tool inputs worth noting** (from the schemas): `layer_set {ids, values, atMs, mode: auto|base|keyframe}`; `keyframes_set {id, property, keys: [{at, value, easing, arc, in, out}], clock, replace, range}`; `view_render {atMs, detail: glance|look|inspect, frameId, layers}`; `view_frames {fromMs, toMs, count 2–12, times, detail}`; `session_set {openFrameId, playheadMs, select, workRange}`; `report_issue {category, fault, severity 1–5, title, tried, happened, expected, suggestion, command, error}`. Comps are "frames" there (`frameId`).

**The live Agents tab (4.17.0).** The left panel shows a chat header (Chats, New chat, Agent options), then the linked agent app as a card ("Claude Code · 2 sessions", with Setup and Unlink buttons), a hint ("Ask in Claude Code; its steps appear below") with an example request to copy, and an empty state until steps arrive. **Setup** opens "Use your agent app": a 512 px dialog (12 px radius, `#161016`, 24 px padding) with an intro, "1. Add AtomCut to your agent app" (chips for Claude Code, Codex, Gemini CLI, Cursor, VS Code, Claude Desktop and Any other, each with its command or JSON and a copy button), "2. Link this tab" (Unlink, and a green "Linked to claude-code · 0 calls" pill), and a collapsible "Pair with a token".

**What we did differently.**
- No bridge process and no WebSocket hop: the MCP server runs inside our main process over Streamable HTTP, so any number of agent sessions connect directly; a session is an `Mcp-Session-Id`. Only apps limited to stdio use our shim, which is a plain relay.
- The token is required on every request (no trusted origins), and the Host and Origin headers must be loopback.
- Undo turns are inferred from timing (calls within 45 s), since MCP has no notion of a user request.
- Our Agents tab follows their layout (app card with sessions and calls, example request, step list, and a setup dialog with per-app chips), with our own setup texts and an OpenCode chip.

## OpenCode inside the app (step O1 research)

Sources: OpenCode 1.18.32 on the owner's machine (`opencode acp --help`, and a probe script in the session scratchpad that spoke ACP to it), the npm registry entry for `opencode-ai`, and AtomCut 4.9.0's shell (`app.asar` extracted: `electron/main.js`, `preload.js`).

**AtomCut hosts no local agent.** Its shell has only deep links, updates, the menu, clipboard files and folder access over IPC: no `spawn`, no ACP. Its in-app chat (Chats, New chat, Agent options) runs on its own cloud service (Pro). So our host follows the Agent Client Protocol instead and keeps AtomCut's look for the panel only.

**OpenCode.** MIT; npm package `opencode-ai` (1.19.5 latest on 2026-10-30), whose `bin/opencode.exe` is the whole program (180 MB, no Node needed). Logins live in its data folder (`~/.local/share/opencode/auth.json`), config in `~/.config/opencode/`.

**ACP as OpenCode speaks it** (newline-delimited JSON-RPC 2.0 on stdio):
- `initialize {protocolVersion: 1, clientCapabilities}` returns `agentCapabilities` (`loadSession`, `mcpCapabilities {http, sse}`, `promptCapabilities {image, embeddedContext}`, `sessionCapabilities {list, resume, fork, close}`), one auth method ("Run `opencode auth login`"), `agentInfo`.
- `session/new {cwd, mcpServers}` returns `sessionId` and `configOptions`: `model` (select, about 106 choices from the logged-in providers), `effort` (`thought_level`: low, high, max, default) and `mode` (build, plan). `session/set_config_option {sessionId, configId, value}` changes one and answers with all of them (also sent as a `config_option_update`).
- `session/update` notifications: `available_commands_update` (its skills and commands), `usage_update {used, size, cost {amount, currency}}`, then the transcript (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`).
- `session/prompt {sessionId, prompt: [{type: 'text', text}]}` answers when the turn ends, with `stopReason`; provider errors come back as JSON-RPC errors (an expired key: "This API key has expired…").
- Asks the client `session/request_permission {toolCall, options [{optionId, name, kind}]}` for tools its config marks `ask`.

**Keeping the owner's own setup out.** With `XDG_CONFIG_HOME` pointed at a folder of ours, `OPENCODE_DISABLE_CLAUDE_CODE=1` and `OPENCODE_DISABLE_EXTERNAL_SKILLS=1`, the session lists only OpenCode's built-in commands and our `uve` skill (copied into `<XDG_CONFIG_HOME>/opencode/skills/uve/`): none of the owner's skills, plugins or MCP servers. Logins are untouched, as they live in the data folder.

## Footage understanding and auto-cutting (step F1 research)

Source: `github.com/samuelgursky/davinci-resolve-mcp` (MIT), read on 2026-10-30 (shallow clone in a session scratchpad; behaviour only, no code copied). It drives Resolve Studio's scripting API; all editing sits in one `edit_engine(action, params)` tool, logic in `src/utils/`.

- **Transcription.** Local Whisper (CLI `base`, whisper.cpp, or `mlx_whisper` large-v3-turbo) with word times, normalised to `{word, start, end, confidence}`, stored per project in SQLite and as a sidecar JSON. About 4–7× realtime.
- **Silence** (`silence_ripple.py`). ffmpeg `silencedetect` with a threshold **calibrated per clip** from `astats`: gate = trough + 0.6 × (peak − trough), clamped to −60…−24 dB; under 12 dB of range the clip is left whole ("refuse when unsure"). Minimum silence 10 frames; each silence shrinks inward by 2 frames after the last word and 4 before the next (soft onsets cross the gate late). Tightness presets: generous (default, ×1.5 guards), balanced, tight.
- **Transcript tightening** (`transcript_edit.py`). Fillers: a fixed English set (uh, um, er, erm, hmm, mm, mhm, ah, eh), cut with half a handle of pad. False starts: an adjacent repeat of 4 down to 1 words within 0.6 s; the first copy goes. Pauses over 0.6 s collapse to 0.15 s handles, but the limit is ×2.5 after `. ? !` and ×1.5 after `, ; :` (breathing room after sentences). Cuts merge; slivers under 0.15 s are absorbed; every removal has a reason. Words of 1.2 s or more are flagged as a swallowed retake, not cut.
- **Takes.** `rank_takes` scores fluency only (100 − fillers/min × 5 − false starts × 6 − missed script × 30), never "the best take".
- **Applying cuts.** Resolve's API has no razor, so it builds a **new variant timeline** in one `AppendToTimeline` call from the keep ranges (packed end to end), archives the original, then re-reads it to check counts. Fast because it is one call; nothing updates live while it works.
- **Plan, review, execute.** Every plan is saved with an id, reasons and a fingerprint; execution needs the plan id (and a confirm token, 300 s); review markers can be dropped first (lifts over about 15 s flagged for a human).
- **B-roll** (`plan_broll`). Mechanical: beats come from the agent, a cutaway sits inside a beat inset 0.15 s each end, needs ≥ 0.8 s, never covers a `protected` beat, rejects relevance under 0.35 (relevance is the agent's).
- **Seeing footage.** Scene changes by ffmpeg `select='gt(scene,…)'` with a threshold of mean + 2.5 sd clamped to 0.15–0.40; up to 80 frames per clip. **The host agent's own vision** describes them (contact sheets to save tokens; `commit_vision` stores the descriptions). Search over spoken words (`search_spoken_content`, with in/out selects) and embeddings (CLIP, CLAP, text).

**What we take for F1.** Our edits are commands, so we can do better than a variant timeline: one transaction cuts the clips in place, the timeline shows it at once, and it is one undo step (or a new comp, for a non-destructive variant). Sarvam gives word times in Indian languages, so filler lists per language (Hindi: matlab, toh, haan, accha, umm…) beat Resolve MCP's English-only set. Plan, review markers, apply, with reasons; calibrated silence gate; breathing-room rule; generous by default; the agent's own vision on contact sheets, text-only fallback when its model cannot see.

## Easy and Advanced modes (step M1 research)

Source: AtomCut 4.9.0's bundled `web-out`, chunk 5009 (the shell's panel store and View menu), read for behaviour only.

- **AtomCut has no simple or pro mode.** One editor; panels come and go instead.
- **Panel store.** `left`, `inspector`, `timeline` and `mixer` are each shown or hidden. What is shown is remembered per **workspace** in localStorage. The workspace is picked from the open frame: `flipbook`, `drawing` (a flipbook in context), `static` or `default`.
- **Focus mode** (View ▸ Focus mode, with a shortcut) hides every panel and leaves the canvas. **Density** `wide` or `compact`: compact shows the side panels as overlays, one at a time.
- Asking for a panel shows it again: opening an inspector tab, for example, leaves Focus mode and shows the inspector.
- **Its chat** is a cloud panel (Pro), not a layout of its own.

**What we did.** Easy and Advanced are two layouts over the same store, project and commands, switched at the top of the left rail and remembered in localStorage.
- Easy: the OpenCode chat on the left, the preview, a simple timeline (no key views, mixer or range buttons), Export. Its rail tabs are Chat, Media and Library.
- Advanced: today's full editor, unchanged.
- The chat adds what AtomCut's lacks: each prompt carries where the person is (comp, playhead, selection), and a mic button sends speech in any language through Sarvam's speech to text.

## Project save and open (step A6b.1 research)

Sources: the prettified chunk 459 (the project package and preset-bundle code, read for behaviour only) and the live 4.17.0 main menu, read over CDP on port 9333 on 2026-10-24.

**AtomCut's project file.** A `.motion` package holds `manifest.json`, `document.json`, `media/` and `fonts/`. The manifest has `format: "atomcut-motion"`, `formatVersion` (1), `documentVersion` (98 in 4.9.0, so the document is migrated on load), `savedAt`, a project summary (`id`, `name`, and the first frame's `width` and `height`), `mediaIncluded`, `assets` (`id`, `kind`, `name`, `mime`, `bytes`), `fonts` (`family`, `fileName`, `weight`, `italic`) and `totalMediaBytes`. Media are copied into the package. Imported documents get fresh ids, and frames remember their origin so a second import can be deduplicated.

**How it refuses a bad file** (seen in their preset-bundle reader, the same pattern): "not valid JSON", "not an AtomCut … file" (wrong `format`), "damaged and could not be read" (schema fails), and "written by a newer version" (`formatVersion` too high).

**The live main menu.** The rail's "Main menu" button opens Back to Home, File, Edit, View, Plugins, Window, Command palette (Ctrl+K), Settings…, Report a bug…, and the version. File holds New project…, Import project…, Save project (Ctrl+S), Save project as…, Import media…, Export selection (.atomcut), Export document (.json), Export presets…, and Export video / sequence…. Recent projects live on the Home screen.

**What we did.**
- One `.uve` JSON file: `{format: "uve-project", formatVersion: 1, manifest, document}`. The manifest lists the comps, the media (by absolute path) and the font families, so a file can be checked without reading the document. Media are never copied (our rule), so a project stays small; missing files are reported on open.
- The same four refusals with our own wording, plus link checks (duplicate ids, a layer whose media is not in the project). A damaged manifest is rebuilt from the document.
- Writes go to a temporary file that then replaces the old one, so a crash mid-save never leaves half a project.
- A Main menu button in the rail with File (New, Open, Open recent, Save, Save as, Import media, Export video) and Edit (Undo, Redo). Recent projects are an "Open recent" submenu, since we have no Home screen.
- The close warning is native (Save, Don't save, Cancel), as in desktop editors; the window title shows "•" while there are unsaved changes.
- AtomCut has no project tools for agents. We add `project_save`, `project_open` and `project_new`; the last two refuse while there are unsaved changes, so an agent can never throw away the user's work.

## Export as a tool (step A6b.2 research)

Sources: chunk 5009 (the export panel and encoders, read for behaviour) and AtomCut's MCP tool list.

- AtomCut has **no export tool**: an agent there cannot write a video file; the user exports from File ▸ Export video / sequence….
- Its export panel offers MP4, "Master — lossless MOV" (for Resolve, Premiere and After Effects), WebM, GIF, a PNG sequence and audio only; a range (the whole comp or the work range); a quality that sets the bitrate (`qualityBitrate(quality, width, height, fps)`) or an explicit video bitrate in Advanced; include audio; transparent (GIF, PNG sequence, MOV); and motion blur.
- **What we did.** `export_video {compId?, path?, overwrite?}` renders through the same `renderComp` as the Export button and waits for the file, so a brief can end in an MP4 with no human step. The user sees the progress in the export dialog and can cancel it (the agent is told). Without `path` it writes the comp's name to the Videos folder, numbered when taken; an existing file is replaced only with `overwrite`. Formats other than MP4, the work range, quality and transparency come with later steps.

## AtomCut's input shapes and keyframes_inspect (step A6b.3 research)

Sources: the input schemas of AtomCut's own MCP tools (`keyframes_set`, `layer_set`, `keyframes_inspect`, `keyframes_clear`, `layer_create`, `layer_patch`, read through ToolSearch from its registered server) and the easing tables in chunk 459.

- **`keyframes_set {id, property, keys: [{at, value, easing, arc, in, out}], clock, replace = true, range}`.** `at` is from the layer start (or comp time with `clock: comp`); easing shapes the segment leaving a key; `position` keys x and y together as `[x, y]`; `arc` throws the segment leaving a key into a parabola, and `in`/`out` are curve handles; `range` keys a slice of text in graphemes.
- **`layer_set {ids (one or a list), values, atMs = playhead, mode: auto | base | keyframe}`.** auto keys a keyed property and sets the resting value otherwise.
- **`keyframes_clear {id, properties?, atMs = playhead}`** freezes each property at its value at `atMs`, so nothing jumps.
- **`keyframes_inspect {id?, frameId?, properties?, limit = 20}`.** With `id`: every track as `time value easing` per key, in comp ms, the last key without easing, pasteable back. Without: the comp's totals and its heaviest tracks, with tracks keyed on nearly every frame flagged as baked.
- **`layer_create`** takes `frameId`, `kind: text | shape | path | media | adjustment`, `assetId`, top-level `x`, `y`, `width`, `height`, `cornerRadius`, `fill`, `stroke`, `shape: rect | ellipse | polygon | star`, `set` (property values in the same step), `template`, `placement`, `maxWidth`, `caption`, and `startMs` defaulting to the playhead.
- **Easings.** Eight presets, each a cubic Bézier: ease-out (0.25, 0.46, 0.45, 0.94), ease-in (0.55, 0.06, 0.68, 0.19), ease-in-out (0.65, 0, 0.35, 1), ease-out-quart (0.25, 1, 0.5, 1), ease-out-expo (0.16, 1, 0.3, 1), ease-out-back (0.34, 1.56, 0.64, 1), ease-in-out-back (0.68, −0.6, 0.32, 1.6) and ease-out-elastic (0.5, 1.75, 0.4, 0.95). In the document an easing is `{kind: linear}`, `{kind: preset, name}` or `{kind: bezier, values: [4]}`; tools also take `"cubic-bezier(…)"`.

**What we did.**
- Our schemas list both shapes as alternatives (so `api_describe` and the JSON Schema show them), and `compat.ts` turns AtomCut's into ours before anything is written. Contradictions (`path` and `property` differ, `mode` and `replace` disagree, `id` and `ids` both) are errors.
- We adopted AtomCut's curve values for the shared presets and added its four others, so motion moves the same; `ease-in-back` stays as ours.
- `frameId` and `openFrameId` are renamed to `compId` by the registry (and for host tools), when the command has `compId`.
- The playhead and open comp reach commands through `Session.view`, so `layer_set` keys at the playhead and `layer_create` lands in the open comp, as in AtomCut. One difference kept on purpose: `layer_create` still starts at 0 ms, not the playhead, because an agent seldom knows where the user left it.
- Features we lack are refused with a reason and the step that brings them: `arc`/`in`/`out` and `range` (A9), polygon and star (A8). `template`, `placement`, `maxWidth`, `caption` and path layers stay unknown fields until their features land.

## Asset inventory (step A6b.4 research)

Sources: the live 4.17.0 app on CDP port 9333, 2026-10-25. Small node scripts in the session scratchpad drove the UI (read-only clicks: tabs, section scroll buttons, Play buttons, the filter popover, the plugins) while `Network.enable` recorded every request; the list endpoints the app called were then fetched once to count and tally licences. The result is `docs/research/atomcut-asset-inventory.json`.

- **Library tab.** Four sections only: Text looks 103, Animations 44, Transitions 23 and Sounds 6. Browsing all of them to the end fetched nothing but Google Fonts (58 stylesheets, 64 `woff2` files): the looks' previews. Playing the six typing-sound packs fetched nothing, so they are synthesised. **View and filters** has View (grid, list), Size, Sort (most used here, best match, name, newest), Source (yours, this project, built in, downloaded, library) and tags (text 103, kinetic 10, editorial 9, titles 9, captions 8, impact 8, …). Source "Library" (the shared library people publish to) is empty.
- **Media tab.** The project's own media only; no stock.
- **Plugins tab.** Library plugins: **Icons** ("every open-source icon set"), **Fonts** ("every font") and **Sound Effects** ("a whole SFX archive"); Audio: **Waveform Visualizer**.
  - Icons call `icons.atomcut.net/collections` and `<prefix>.json?icons=…`: an Iconify API mirror, falling back to `api.iconify.design`. 243 sets, 416,940 icons, each set with its author and licence. Six sets are GPL and two non-commercial; we leave those out.
  - Fonts list Google Fonts (1,944 families: sans 720, serif 349, display 468, handwriting 358, mono 51), mood collections (Calm, Business, Playful, …) and 199 fonts on this device (the Local Font Access API). The catalogue ships in a chunk; files come from Google.
  - Sound Effects read `library.atomcut.net/v1/index.json` (91 packs), then `packs/<id>.json` (entries with name, tags, blurb, waveform peaks and a blob) and content-addressed `blobs/<sha256>.wav`. 4,555 sounds, 80.3 MB, and every pack is CC0-1.0 (Kenney, rubberduck, phoenix1291, subspaceaudio and other OpenGameArt authors, plus 38 of AtomCut's own).
- **Not served at all:** characters, stickers and stock footage. AtomCut makes those with AI generation.

**What we did in this step.** Fonts: every request to the Google Fonts hosts goes through a disk cache in the main process (an `https` protocol handler that passes all other hosts straight through), and the looks' fonts are fetched ahead at startup. We also fixed a gap the inventory exposed: fonts only loaded when the Library panel drew a look's preview, so a project opened with another panel showing (or built by an agent) rendered and exported in a fallback font. Every text layer's font now loads with the project, and `view_render`, `view_frames` and the export wait for them. Sounds and icons are listed with their sources and licences; their browsers and tools come with phase D and A8.

## Quality benchmark (step A6b.5 research)

Source: `references/recipes.md` in `@atomcut/mcp` 3.6.0 (MIT): worked builds for a title card, lower third, social captions, Spotify-style lyrics, kinetic type, logo reveal, path morph, product promo, reel from a long video, and physics and character pieces. Sizes are in `U` (short side / 100).

- The recipes lean on features we lack: per-unit animators (`fade-up` per letter, `unblur-up` per word with stagger and delay), gradients and radial glows, auto layout, caption states, stroke `draw`, `shine`, transitions (`push`), motion blur, and sounds on animation (`pop` per word).
- We turned seven of them into user-style briefs (`docs/benchmarks/briefs/`), each quoting the recipe as the bar. AtomCut's own tools need Pro, so the comparison is against the recipe, not a render from AtomCut.
- Results and gaps: `docs/benchmarks/results.md`.

## The text box and the pivot (step A8.1 research)

Sources: the `@atomcut/mcp` 3.6.0 skill references (`type-and-captions.md`, `layers-and-layout.md`), the live `layer_create` and `text_style` schemas, and REA-guided reading of chunks 459 (model) and 5009 (inspector and text layout) of 4.9.0. Observed behaviour, reimplemented in our own code.

- **The model.** A text layer has `maxWidth` (positive or null), `maxHeight` (positive or null), `verticalAlign` (`top`, `middle`, `bottom`; default `top`) and `clipContent` (default false). Both box fields are keyframable ("Box width", "Box height"); keying `maxWidth` re-wraps the lines, which a scale cannot do. `style.align` has `left`, `center`, `right` and `justify`.
- **Three resizing modes** in the inspector's Sizing section, derived from the fields: Auto width ("grow on one line": both null), Auto height ("wrap at a fixed width": `maxWidth` only) and Fixed size ("a fixed box": both). Switching to Auto height or Fixed fills in 800 × 400 when the fields were empty. The section also has Box width (and height), Vertical (fixed only) and a Clip content toggle ("off keeps overflow visible").
- **Layout.** Lines break only between words, greedily; a word longer than the box overflows on its own line. The box is `maxWidth` wide (else the widest line) and `maxHeight` tall (else the lines' height). Lines align inside the box width; in a fixed box the block of lines sits at the top, middle or bottom. The measured box (not the ink) is the layer's bounds, and `layers_list` reports it.
- **The pivot** is `transform.anchor {x, y}`, a fraction of the layer's own box: 0.5 centre, 0 left or top, 1 right or bottom, and it may go past 0–1. The inspector shows it as Pivot X % and Y %. AtomCut's recipe for a left-aligned stack is `anchor.x: 0` and the same `x` on every line.
- **What we do.** The same fields, modes and layout, with our pivot changed from pixels to AtomCut's fraction (project file format 2 converts older files). We also trim trailing spaces from a line's width, so right-aligned and justified lines end exactly at the box edge. `layers_list` gets each layer's measured bounds from the editor, since the core package cannot measure text.

## Paints: fills and strokes (step A8.2 research)

Sources: `references/fills-strokes-vectors.md` and `references/api.md` in `@atomcut/mcp` 3.6.0, the live `layer_create` schema, and chunks 459 (model and property paths) and 5009 (paint rendering and the inspector) of 4.9.0. Observed behaviour, reimplemented.

- **Model.** Every visual layer has ordered `fills` and `strokes` (bottom to top). A paint has `id`, `enabled`, `opacity`, `blendMode` (16 modes: normal, darken, multiply, color-burn, lighten, screen, color-dodge, overlay, soft-light, hard-light, difference, exclusion, hue, saturation, color, luminosity) and a type: `solid` (`color`), `linear`, `radial`, `angular` (`stops [{id, offset, color}]` (at least 2), `start` and `end` as box fractions; linear defaults to (0, 0.5)→(1, 0.5), radial and angular to a (0.5, 0.5) centre), plus `media`, `pattern` and `variable`. A stroke has its own `id`, `enabled`, `opacity`, `blendMode`, then `paint`, `width`, `align` (center, inside, outside), `cap`, `join`, `dash`, `dashOffset`, `trim {start, end, offset}` and a pipeline (`offset`, `profile`, `wave`, `roughness`, `scatter`, `nib`, `markers`).
- **Rendering.** Gradient points are measured in the layer's box. Radial: a circle centred on `start` whose radius is the distance to `end`. Angular: a conic gradient around `start`, starting in the direction of `end`.
- **Property paths** (keyframable): `fill.<id>` (a solid fill's colour), `fill.<id>.opacity`, `fill.<id>.stop.<stopId>.color` and `.offset`; `stroke.<id>.color`, `.width`, `.opacity`, `.dashLength`, `.dashGap`, `.dashOffset`, `.trim.start`, `.trim.end`, `.trim.offset`. Removing a paint removes its keys.
- **Inspector.** A Fill section and a Stroke section, each with a count, a list of rows (drag to reorder, eye, remove) and an "Add fill" / "Add stroke" button (dashed when the list is empty). A new fill is solid #B0B4BB; a new stroke is solid #1E1E1E, 2 px.
- **`layer_create`** takes `fill` (a colour, a paint object or null) and `stroke` (a colour, which is 4 px centred; `{color, width}`; or a full stroke); ids and stops are minted.
- **What we do.** The same model for solid, linear, radial and angular paints and for strokes with alignment, caps, joins, dashes and trim, the same paths, and the same inspector sections. Not yet: media, pattern and variable paints, the stroke pipeline (taper, wave, roughness, scatter, nib, markers), drag to reorder, and paints on media layers. Our own choices: a rectangle's outline starts at its top-left corner and an ellipse's at the top, both clockwise; text strokes cannot be trimmed (they have no outline to follow yet); inside and outside strokes on text are drawn on a scratch canvas with the glyphs cut away or kept.

## Groups and auto layout (step A8.3 research)

Sources: `references/layers-and-layout.md` and `recipes.md` in `@atomcut/mcp` 3.6.0, and chunk 459 of 4.9.0 (the group schema, `layers.group`, `layers.ungroup`, `layout.set` and the layout solver). Observed behaviour, reimplemented.

- **Model.** A `group` layer kind with `mode` (pass, union, mask, subtract, intersect, exclude), `layout` (nullable) and, like every layer, `fills`, `strokes` and `borderRadius`. Membership is not a list on the group: lanes carry a `groupId`, and a group's member lanes are inserted right after the group's own lane. Every layer has a `layoutItem` (`fillX`, `fillY`, `absolute`, min and max sizes).
- **Layout spec** (`api_describe layout`): `flow` row, column, wrap or grid (`columns`), `gap`, `lineGap`, `spaceBetween`, `padding {top, right, bottom, left}`, `alignX`, `alignY` (start, center, end), `width` and `height` (null hugs), min and max sizes, `x` and `y` (the box's top-left corner in comp space), `clipContent`.
- **Behaviour.** `layers.group {ids, name, layout, mode}` groups visual layers of one comp; `layout: {}` infers the layout from how the members sit. Adding a layout clears text members' `maxHeight`, orders members along the flow, and marks members of equal size to fill. The layout overrides members' positions (and stretched sizes). Turning it off (`layout.set {layout: null}`) writes each member's laid-out position and size back into it and turns a container's paints into a rectangle. A group's transform is a delta over its members; its span is a window on them. In the recipes, a rect plus two texts grouped with a column layout makes a lower third whose pill hugs the text.
- **What we do.** The same model (lanes with `groupId`, the group's lane first), the same layout fields and commands, the container drawn from the group's fills and strokes with `cornerRadius`, and a rectangle behind the others becoming the container (its padding inferred). Our own choices: a group's lane holds only the group; members are ordered front-most first; layouts are solved at render time by the engine (text is measured there), and commands that bake or infer a layout ask the editor to measure through an injected `Measure`. Not yet: the boolean and mask modes (step A8.4), reordering by dragging inside a layout, min and max on a member's own size being respected by stretching, and baking a group's turn into a nested group's own turn.

## Paths, polygons, stars and masks (step A8.4 research)

Sources: `references/fills-strokes-vectors.md` and `layers-and-layout.md` in `@atomcut/mcp` 3.6.0, the live `layer_create` schema (`d`, `shape: polygon | star`, `pointCount`, `innerRatio`) and chunk 459 of 4.9.0 (the path layer, group modes). Observed behaviour, reimplemented.

- **Path layers.** Created from SVG path data (`d`) and stored as editable subpaths with a `fillRule`, "recentred on its outline's box": a path drawn from 0,0 to 200,100 lands centred on the layer's x, y. A bare path gets a 4 px light line; a filled one has no stroke. Morphs key `geometry` with `d` strings of the same command sequence, and the layer keeps the box of its original outline so the pivot does not drift.
- **Shapes** add `polygon` and `star` (`pointCount`, `innerRatio`; the inner radius is animatable).
- **Group modes:** pass, union (one silhouette; effects apply once), mask (content only inside the stencil), subtract, intersect, exclude (vector booleans: content minus, and, xor the stencil). Cutters are members with `isStencil: true`, several stencils combining first; for subtract, "the topmost cuts the rest".
- **What we do.** The same fields and behaviour. Our own choices: paths are stored as normalised `d` strings (absolute M, L, C, Q, Z; arcs become cubic curves) rather than node lists, so same-command keys blend number by number; the box is that of the resting `geometry`; boolean modes are drawn by compositing (destination-in, destination-out, xor) on a scratch surface rather than as vector booleans, so the result looks the same but is not a new outline; when no member is marked, the front-most member is the stencil for every cutting mode; trim treats each piece of a compound path on its own. A Pen tool (P) draws paths by hand: click for corners, drag for curves, click the first point to close, Enter to keep an open path. Not yet: editing a path's nodes by hand after drawing it, text on a path, luma mattes, feather.

## Rich text ranges (step A8.5 research)

Sources: `references/type-and-captions.md` in `@atomcut/mcp` 3.6.0, the live `text_set` and `text_style` schemas, and chunk 459 of 4.9.0 (`text.set`, `text.style`, the range schema). Observed behaviour, reimplemented.

- **Model.** A text layer has `ranges`: `{id, start, end}` in grapheme indices with an `overlay` of property overrides, plus its own animation and sounds. `style.highlight` is a pill behind text, on the layer or on a range.
- **`text.style {id, match, occurrence, start, end, style}`** finds the first match (or the nth, or "all"; a match is mapped to grapheme indices) or uses the indices, refuses an empty or missing match with a reason, and adds the style to the ranges over those characters (splitting them).
- **`text.set {id, text}`** finds the changed stretch from the common start and end of the old and new graphemes and moves ranges (and caption cues) with their words.
- **Keys:** `keyframes_set` takes `range` to key part of a text.
- **What we do.** Ranges `{id, start, end, style}` whose style holds font family, size, weight, italic, colour, letter spacing, opacity and highlight; `text.style` (plus `clear`), `text.set`, and `layer.patch` on `text` keep ranges on their words the same way; touching pieces with equal style are joined, and keys of a joined or cleared range are dropped and reported. `keyframes_set {range}` keys colour, opacity or size through a range of its own (`range.<id>.color`, `.opacity`, `.fontSize`). Layout cuts lines into fragments where the style changes; a line is as tall as its largest font. Not yet: decoration, text case, text effects and per-range animation and sound (with the A9 animator).

## Duplicate, copy, restack, nesting and ripple edits (step A8.6 research)

Sources: the live tool schemas (`layers_duplicate`, `layers_copy`, `layers_restack`, `layers_nest`, `layers_makeUnique`, `timeline_close_gaps`, `timeline_compact`, `timeline_cut_ranges`), `references/layers-and-layout.md` and `editing.md` in `@atomcut/mcp` 3.6.0, chunk 459 of 4.9.0 (the commands and their lane helpers) and the live 4.17.0 app over CDP (its shortcut registry and selection toolbar). Observed behaviour, reimplemented.

- **Duplicate** (`layers.duplicate {ids}`): each copy goes on a new lane ("<lane> copy") just above its source's lane, in the same group; audio copies go to the back. A group copies with everything in it, and the copies' lanes point at the copied group. Copies get new ids for the layer, its ranges, keys and paints (key paths follow the paint ids). Returns the copies of the named layers. By hand: Ctrl+D and a Duplicate button on the selection toolbar.
- **Copy** (`layers.copy {ids, toFrameId, atMs?}`): into another comp or the same one, timing and positions kept (shifted when the comps sit apart on the canvas); `atMs` moves the earliest start there. A group comes with everything in it. By hand: Ctrl+C, Ctrl+X, Ctrl+V.
- **Restack** (`layers.restack {ids, to: "front" | "back" | {above} | {below}}`): each layer leaves its lane for a new lane at the target, the named layers keeping their order. `front` and `back` stay inside the first layer's group; `above` and `below` place them next to a layer and into that layer's group. No shortcut in the live app.
- **Nesting.** A `nested` layer kind (`sourceFrameId`, `trimInMs`, `playback {speed, loop: none | loop | pingpong, reverse, loopLengthMs}`, `clipContent` true, false or null for auto, an audio mix). `layers.nest {ids, name, fullFrame}` makes a comp that hugs the layers' box (transparent background, spills past its box), moves the layers into it (positions less the box centre, starts less the earliest start; a group with its members), and leaves one nested layer, centred on the box, on the lane of the front-most layer. `fullFrame` uses the parent's size and centre. The nested comp is "embedded" (off any page, used by this one layer); a comp placed with `layer_create {kind: "comp", sourceFrameId}` is "linked"; `layers.makeUnique` copies a linked source into an embedded one for that layer (detach). Time inside: elapsed time × speed from `trimInMs`, wrapped by the loop mode over `loopLengthMs` × speed (or the source's length); past the end of a play-once source the layer shows nothing (the skill warns that an instance must never outlive its source). By hand: the inspector's "Make unique" button and Clip (auto, crop, spill) setting.
- **Close gaps** (`timeline.close_gaps {ids}`): per lane of the named layers, every layer moves back to the end of the one before it (the first to 0); locked layers stay and still block; moving a group moves its members. By hand: Shift+Backspace, "Ripple delete (close the gap)", deletes the selection and closes its lanes.
- **Compact** (`timeline.compact {frameId}`): per level (the top level, then each group), runs of lanes that are not locked, hidden, muted or looping; from the back lane forward, each layer drops to the lowest lane above everything it overlaps in time, so what covers what never changes; then empty lanes go. Returns `{lanesBefore, lanesAfter, moved}`.
- **Cut ranges** (`timeline.cut_ranges {id, ranges, ripple: sync | lane | none}`): ranges are clipped to the layer and merged, then cut from the last to the first: the layer is split at both ends and the middle deleted. `sync` also applies each cut to every unlocked lane at the same level: layers inside it are deleted, layers across it shortened by its length, layers over one edge trimmed to it; then every touched lane ripples back by the cut's length (unless a layer to move is locked). `lane` ripples only the layer's lane, `none` leaves the hole. Returns `{removedMs, cuts, pieces}`.
- **What we do.** The same commands, names and input shapes (`toFrameId`, `sourceFrameId`, `frameId` and `kind: "comp"` accepted). Our own choices: a duplicate keeps its paint and range ids (they are per layer); copies into a comp land in front of everything at the top level, and members copied without their group leave it; restack moves whole lanes when a layer is alone on its lane. Nested layers are `kind: "nested"` with `sourceCompId`, and an `embedded` flag on the comp stands for AtomCut's off-page comps (they go when their layer is deleted); a nested comp is drawn as part of the scene (its inside built at the layer's own clock and placed through its transform, so it stays sharp), and the media inside are placed in the outer comp's time for the preview, export and sound mix. `layers.nest` needs the editor to measure, unless `fullFrame`. Splitting or trimming the start of a looping nested layer is refused, since its loop starts at its start. `cut_ranges` refuses groups. By hand: Ctrl+D, Ctrl+C, Ctrl+V, Ctrl+Shift+] and [, the Layers tab buttons (duplicate, front, back, nest), double-click to enter a nested comp with a breadcrumb back, the inspector's Nested comp section, Shift+Delete (ripple delete) and a Close gaps button. Not yet: `reverse` playback, keys on a nested layer's speed or volume, components and linked a/v pairs, Ctrl+X.

## The per-unit animator (step A9.1 research)

Sources: the live `animation_set` schema, `references/motion.md` in `@atomcut/mcp` 3.6.0, chunk 459 of 4.9.0 (the preset list, unit timing and the per-glyph pose stack), chunk 5009 (how a glyph's pose is drawn) and the live 4.17.0 Animate tab over CDP (a text look added to an empty project). Observed behaviour, reimplemented; the preset data (ids, labels, defaults, knobs) is ported.

- **Model.** A layer has whole-layer slots (`animIn`, `animOut`: preset, duration, easing, params) and a text layer also has per-unit slots (`animations.in`, `animations.out`: preset, unit, duration, stagger, delay, easing, jitter, scatter px and degrees, params). A styled range can carry its own entrance. The live Animate tab shows them as cards: "Layer animate in", "Layer animate out", "Typing cursor", "Text animate in", "Text animate out".
- **Presets.** 44, each with a category, a scope (text, layer or both), default unit, duration, stagger, easing and knobs, and a pose function of eased progress returning opacity, dx, dy, scale, rotation and blur. An exit without its own pose plays the entrance backwards (the pose of the easing applied to 1 − u). `draw` is a reveal, not a pose: it trims outlines (order together, one by one or staggered; direction forward, backward or both ways from an origin; the fill kept, fading along or fading late; a pen width for layers without a stroke). 4.17.0 renames some labels (unblur-up shows as "Lift").
- **Units.** Graphemes; a word starts at the first non-space after a space; a line is a paragraph (between line breaks), not a wrapped line. Letter units count spaces.
- **Timing.** Unit i of n enters at delay + i · stagger (+ a seeded random jitter); on exit it starts at end − delay − ((n − 1) · stagger + duration) + i · stagger (− jitter), so the last unit is gone `delay` before the end. Progress is clamped per unit; poses of the in and out slots combine (opacity and scale multiply, offsets, rotation and blur add). Scatter adds a seeded offset and turn that shrinks as the unit lands.
- **Drawing.** Each glyph is drawn at its own pose: moved by dx, dy (text-local px), turned and scaled around its unit's centre on the baseline, with a blur filter scaled to the render. Glyphs of a word with equal poses are drawn together.
- **What we do.** The same slots under our names (`animIn`, `animOut` on every visual layer; `textIn`, `textOut` on text, since `animations` holds our keyframe tracks), the same command and input shape (`target: auto | text | layer`, AtomCut easing shapes, swapping keeps timing and shared knobs), and our own pose formulas for all 44 presets (`core/src/animationPresets.ts`), unit timing (`core/src/animation.ts`) and drawing (`engine/src/content.ts` cuts fragments into posed runs; `renderer.ts` blurs whole layers and groups through an isolated composite). `draw` works on shape and path layers through per-piece stroke trims. Our own choices: clear refusals (a text-only preset on a shape, a delay on a whole-layer slot, `draw` on text), a warning when the units outlast the layer, a pill shows as much as its most visible character. Not yet: per-range animations, the typing cursor, `draw` on text (needs glyph outlines).

## The effect stack (step A9.2 research)

Sources: the live `effects_add` and `effects_update` schemas, `references/effects.md` in `@atomcut/mcp` 3.6.0, chunk 459 of 4.9.0 (the card schemas: types, fields, ranges and defaults; the shine sweep timing), chunk 5009 (how cards become render passes, and the CSS approximation the Library preview uses), and the live 4.17.0 Effects tab over CDP (a text layer, the add-effect pickers, a text glow card and its settings window).

- **Model.** Three stacks, first card applied first: layer effects (`effects` on the layer, keyed at `lfx.<id>.<field>`), text effects (`style.textEffects`, `tfx.…`, drawn per glyph) and audio effects (`audioEffects`, `afx.…`). A card is `{id, enabled, type, ...fields}`. Inside `layer_patch` a card's fields are flat on it. Every numeric field keys.
- **Layer card types (4.9.0, 39).** Shadow and glow (shadow, innerShadow, glow with auto or solid colour and an inner switch, longShadow), blur (blur, directionalBlur, zoomBlur, spinBlur, sharpen), colour (adjust, vignette, colorGrade, grade, gradientMap, posterize, overlay, chromaKey), stylize (stroke with outside, center or inside placement and softness; halftone, pixelate, bevel), distort (rgbSplit, bulge, wave, twirl, lensDistort, goo, roughenEdges, boil, glitch), light (shine, lightRays, lensFlare, lightning), material (glass) and film (grain, filmDamage, scanlines, noise). Cards that move on their own share a seeded clock (`seed`, `rate`, `jitter`, `stutter`). The live picker adds fog, lens blur, fill and gradient, and "Behind".
- **Text card types (4).** shadow (x, y, blur), glow (radius, intensity), extrude (angle, length), echo (count, distance, angle, fade), each with `source` (text colour or custom), `color` and `opacity`. The live tab adds a text glow in the text's own colour (radius 14).
- **Shine timing.** With `duration` 0 the band sits at `position`; otherwise, after `delay` seconds, `position` plus the pass's progress (0 to 1); looping passes repeat every duration plus delay, with the band parked past the layer in between. 0 is before the layer, 1 past it.
- **The live Effects tab.** "Looks" (saved stacks), a dashed "Add layer effect" button, then a TEXT EFFECTS section (count, Looks, +). Each card is a row: icon, name, a key diamond for all its fields, "Effect settings", an eye ("Disable") and a bin ("Remove effect"); its menu has settings, duplicate, move to top or bottom, copy, cut and paste. Settings open a floating window: a before/after preview (split, layer only) and one row per field (a slider bar and a number with its unit; colour as a source pick such as "Text colour"). The picker is a searchable list grouped by family (Material; Film & Video; Shadow & Glow; Light & Optics; Blur & Sharpen; Color; Stylize; Distort), each entry a name and a one-line tagline.
- **What we do.** The same stacks, paths and input shapes for layer and text effects (`effects.add`, `effects.update`; loose cards in `layer.create` and `layer.patch`); types, fields, ranges, defaults, labels and taglines are ported as data. The drawing is ours: the layer (or group, or nested comp) is drawn on a canvas just big enough for it and its cards' reach, the cards run on those pixels (Canvas 2D composites and filters on the GPU; distance fields in JS for the outline; directional, zoom and spin blur as halving averages, 2^k copies in k draws; per-pixel work only for RGB split and sharpen), and the result is composited with the layer's opacity. Offsets and sizes are layer px through the layer's own scale and turn. Text effects are drawn under each glyph run at its animation pose. Not yet: the other 25 layer cards (each named with its step when asked for), Looks (saved stacks), the floating settings window with its before/after preview, copy and paste of cards, and audio effects.

## Motion blur (step A9.2 research)

Sources: chunk 459 of 4.9.0 (the settings schema and the shutter presets), `references/motion.md` and `api.md` in `@atomcut/mcp` 3.6.0, and the live 4.17.0 Design tab over CDP.

- **Model.** Settings: `shutterAngle` (0–720, 180), `shutterPhase` (−360–360, −90), `weighting` (box, ease, trail, lead, curve), `sampling` (velocity, transform, content), `combine` (average, add, screen, max), `strength` (0–1), `amount` (0–4), `maxSamples` (2–64, 16). A comp has them plus `enabled` (on by default); a layer has `{enabled: true, override: null}`. The layer's shutter keys at `mblur.*`.
- **Presets (7).** Film 180° (the defaults), Crisp 90° (90°, −45°), Long exposure (360°, −180°, add, ease), Comet trail (540°, −540°, trail, screen, 0.85), Anticipation (360°, 0°, lead, 0.8), Whip pan (720°, −360°, amount 2, ease, 32 samples), Ghosting (360°, −180°, 5 samples, screen, 0.9).
- **The live section.** Design ▸ MOTION BLUR: a preset dropdown ("Film 180°"), a switch (on), a shutter dial (180°), Shutter and Phase numbers with keys, Quality Fast ("A straight smear along the measured motion. One extra pass."), Exact ("Renders once, re-composites per sample. Arcs and spins are exact.", the default) and Full ("Re-renders per sample — blurs animating content too. Costly."), and Advanced (4 more fields).
- **What we do.** The same settings, defaults, presets and `mblur.*` paths. The sampling is ours: the moments of a frame's shutter are spread evenly (about 1.5 output px of travel apart, at most `maxSamples`), weighted by the weighting, and a node that moves (any corner travels more than half a pixel between the shutter's ends) is drawn at each of them (placed there for Exact, rebuilt there for Full) and mixed by weight in pairs on the GPU; Fast smears the frame once along the line from the shutter's opening to its closing. A layer with an override is sampled with its own shutter. Groups' members blur on their own; a nested comp is blurred as one piece with the outer comp's settings. Not yet: the `curve` weighting, the Advanced panel and the shutter dial, motion blur as an export switch.
- **Analog cards (A9.2).** grain (amount, size, aspect, softness, chroma, blend), noise (shape value, fractal, turbulence or ridged; scale, aspect, octaves, roughness, lacunarity, contrast, brightness, evolve, drift, amount, blend, chroma, low and high colours, displace, inside), scanlines (shape line, dot, slot or grille; angle, pitch, thickness, softness, offset, aspect, amount, colour, blend, bleed, boost, roll, flicker, interlace, curvature) and filmDamage (dust, scratches, hairs, flicker, gate weave, splices with jump odds), all with the shared clock (`seed`, `rate`, `jitter`, `stutter`) and the live `animate` switch (grain and noise arrive still). Ours: a hashed clock (the step's boundary moved by jitter, held over with stutter odds), seeded per-step noise so preview and export match, value noise with smooth lattice interpolation in three dimensions (time is the third), CSS-free masks drawn as canvas patterns stuck to the layer's box, and per-pixel warps only for displacement and tube curvature.
- **Distortion cards (A9.2).** bulge (centre, radius, strength ±, softness, aspect, refract), wave (shape sine, triangle, square or noise; angle, wavelength, amplitude, phase, speed, cross, anchor), twirl (centre, radius, angle, softness), lensDistort (amount, cubic, chroma, scale, centre), goo (blur, threshold, softness, mix), roughenEdges (style rough, spiky, torn, melt or rusty; amount, scale, complexity, sharpness, evolve, colour, tint, the clock), boil (style boil, wobble or jitter; amount, scale, complexity, variants, shake, rotate, mix, the clock) and glitch (amount, blocks, displace, chroma, scramble, colorShift, direction, inside, the clock). Live labels: Bulge, Wave warp, Twirl, Lens distortion, Goo, Line boil, Roughen edges, Glitch. Ours: every warp looks each output pixel up in the layer's picture (bilinear, premultiplied; red and blue at their own points for fringing); goo thresholds the blurred silhouette with an edge as wide as the local alpha slope; roughen edges moves only alpha (colour stays put) from a fractal field; boil picks one of `variants` seeded fields per clock step; glitch tears bands of the picture with canvas copies.
- **Colour and stylize cards (A9.2).** colorGrade (temperature, tint, exposure, contrast, saturation, vibrance, hue, intensity, lift, gamma and gain for R, G, B and master), gradientMap (shadow, mid and high colours, midpoint, contrast, brightness, mix, invert), posterize (levels, dither, gamma, mix, luminanceOnly), overlay (labelled "Fill & gradient": solid, linear, radial or conic from colour A to B, angle, scale, offset, midpoint, repeat, mirror, opacity, blend, inside), chromaKey (colour, tolerance, softness, spill, feather, choke, edgesOnly, invert), halftone (dot, line, square, cross or diamond; size, angle, softness, contrast, mono, duotone, colour or CMYK, ink and paper colours, jitter, spread, mix, invert, inside), pixelate (size, aspect, square, dot, diamond or cross, gap, softness, mix) and bevel (inner, outer, pillow or emboss; depth, strength, angle, elevation, softness, highlight and shadow colours, opacities and blends). `grade` is a node graph (the Color and Nodes tabs, phase E). Ours: per-pixel colour maths of our own (YIQ hue turns, CbCr keying with spill taken along the key's chroma, a 4 × 4 Bayer dither), screens drawn as canvas shapes per cell on a grid turned by the angle and anchored to the box, mosaics by downsampling with the cells anchored to the box, and bevels lit from a height made of distance fields.
- **Light and material cards (A9.2).** lightRays (centre, length, intensity, decay, threshold, auto or solid colour, saturation, samples, blend, behind), lensFlare (centre, brightness, size, colour, streak with its colour and angle, halo, ghosts, ghost spread and chroma, blend, inside), lightning (the clock and a sweep; bolt, outline, fill or burst; two box points; count, span, offset, drift, chaos, detail, branches and their length, width, taper, flicker, core and glow colours, glow, intensity, blend, inside) and glass ("Liquid glass": refraction, depth, dispersion, frost, light angle, light, splay and colour, profile squircle, circle, lip or concave, ior, inset, coverage, mix, paint, tint, saturation, brightness, noise, ripple with scale, phase and speed, quality, edgeOnly). Ours: rays are copies of the thresholded bright parts grown about the centre with exponential decay, blurred by their spacing; the flare is drawn from gradients; lightning is midpoint displacement with branches; glass reads the pixels already drawn under the layer's region and bends them by the slope of a rim profile made from a distance field (per-channel bend for dispersion, frost as a blur first).

## Transitions (step A9.3 research)

Sources: the live `transition_add` and `transition_remove` schemas, `references/editing.md` in `@atomcut/mcp` 3.6.0, and chunk 459 of 4.9.0 (the 23 presets with their knobs, and how a transition is placed on a cut).

- **Model.** Transitions belong to a lane: `{id, preset, frameId, aClipId, bClipId, durationMs, splitMs, easing, params, color}`. A seam has both clips (A ends where B starts, within 1 ms); a head only B; a tail only A. The window runs from `splitMs` before the cut to the rest after it (split defaults to half for a seam, 0 for a head, the whole for a tail), clamped so each side has enough of itself. Meanwhile A is held at its last frame past its end and B at its first before its start. Adding on a cut that has one replaces it; clips sharing a cut get one transition.
- **Presets (23).** Dissolve: cross-dissolve, fade, dip-to-color (a colour, split at the cut: a lone side dips into or out of it), blur-dissolve, additive-dissolve, soft-dissolve. Wipe: linear-wipe, iris, clock-wipe, barn-door, iris-close, wedge-wipe. Motion: push, slide, slide-apart, whip-pan, zoom, roll. Stylize: pop, spin, dip-to-white ("Flash"), glitch-cut ("Glitch"), shake-cut ("Shake"). Each has a default duration (340–800 ms) and easing, knobs (direction 0–360 with 180 the default, travel %, softness, blur, bloom, centre, rotation, amount, cycles), and an audio mode (equal-power, or dip for dip-to-color).
- **What we do.** The same model (our names `aLayerId`, `bLayerId`) and the same tool inputs; the presets' data ported, the poses ours: each side gets an opacity, an offset in comp widths and heights, a scale, a turn and a blur; wipes are masks in the box around the pair (B inside, A outside); dips and flashes veil the pair in the colour; the glitch tears bands sideways. Sound: the export mix fades A out and B in by the preset's curve inside the window.

## The sounds stack (step A9.4 research)

Sources: the live `sounds_list`, `sounds_use` and `sound_category` schemas, `references/sound.md` in `@atomcut/mcp` 3.6.0, chunk 459 of 4.9.0 (the text sound schema: pack, custom asset with hit, volume, randomness, pitch) and the live 4.17.0 Sound tab.

- **Model.** A layer's `sounds` is a list of voices: `{pack | custom: {assetId, hitMs}, volume, pitch, randomness, phase in/out, trigger: {kind: text | layer | transition}, anchor start | peak | end, offsetMs, enabled}`. Packs are synthesised (mechanical, soft, vintage, thock, digital, pop). Untagged fired sounds go to the Effects category; the mix has categories (buses) with faders, a leveler, a limiter and ducking rules (phase D for us).
- **The live Sound tab.** OUTPUT (level), MIX (category, "Duck under Dialogue"), then SOUNDS: slots Text animate in and out, Layer animate in and out, Transition in and out, each showing "None" or its sounds; open, a slot shows "Fires: Per word" and "Add sound".
- **What we do.** The same voice shape and slots. Hits are computed from the animator's own unit timing (spaces are silent when letters are the units), a whole-layer animation, or the transition window at the layer's edge, with seeded variation of timing (up to 12 ms), pitch (12 %) and gain. Our own synthesis: band-passed noise clicks and swept sine or square tones per pack, peak-normalised, four takes each, identical in the preview (Web Audio, scheduled 250 ms ahead) and the export mix.

## The CC0 sound library (step A9.5)

Sources: the asset inventory (A6b.4), the live `sounds_list` and `sounds_use` schemas, and the library itself: `https://library.atomcut.net/v1/index.json` (version, generatedAt, 91 packs with id, title, blurb, kind, publisher, itemCount, bytes, tagCounts and search `terms`), `packs/<id>.json` (license, attribution, entries with id, name, tags, blurb, a content-addressed blob `{path: blobs/<sha256>.<ext>, sha256, bytes, mime}` and waveform `preview.peaks`). All CC0-1.0.

- **What we do.** The same two tools and value shapes. The main process asks only that host, only for ids and blob paths of the expected form, keeps everything in user data, and checks each blob's SHA-256 before keeping it. Search narrows the packs by their terms, then matches sounds by word starts in names, tags and blurbs. A used sound becomes a media asset with a `credit` (source, licence, attribution); its hit point is the loudest of its peaks.

## Captions with states (step A9.6 research)

Sources: `references/type-and-captions.md` in `@atomcut/mcp` 3.6.0 and chunk 459 of 4.9.0 (the caption schema, its defaults and how a cue's state is found).

- **Model.** A text layer's `caption`: `cues` `[{id, start, end, startMs, endMs}]` (grapheme spans with times), `states` `{unread, focus, read}` each `{overlay: {props}, animation, scale}` (props such as color, opacity and `highlight.color`), and `motion` `{durationMs: 160, easing: ease-out, travel: false}`. A cue is unread before its start, focus while spoken, read after; a state change blends from the previous state over the motion's duration; with `travel` the highlight pill slides between words. Defaults: unread opacity 0.45; focus ink #0F0E0C on a #F5B843 pill (radius 10, padding 10 by 4) at 1.08 scale; read opacity 1. Captions are made by `media_transcribe {captions: {maxWords}}` (or aligned to given lyrics) and styled with `layer_patch`.
- **What we do.** The same model and defaults, with states stored as `{style: {color, opacity, fontWeight, highlight}, scale}` (AtomCut's overlay shape is converted on input) and `caption.set` to make and time them by hand or by agent, since transcription is phase E. Rendering is ours: the looks become styled ranges over the layer's own, scales become glyph poses around each cue, and the gliding pill is drawn between the boxes of the cue it leaves and the one it reaches.

## Assets: templates, fonts, icons and text style (step A10 research)

Sources, 2026-10-26: the live AtomCut 4.17.0 over CDP (port 9333: the Plugins tab, the Icons and Fonts windows, a text look applied to a selected text), the bundled 4.9.0 chunks (459 core model, 3548 the Google font catalogue, 1876 the Icons plugin, 5009 the compositor), `@atomcut/mcp` 3.6.0 (skill docs, `DESIGN.md`) and the public Iconify API.

- **Plugins tab.** A search field, **Library**: Icons, Fonts, Sound Effects; **Audio**: Waveform Visualizer. A plugin opens in a floating window over the editor with fold and close buttons. We built Icons and Fonts (the sound library already has its browser in the Sound tab).
- **Text style (chunk 459).** `fontFamily`, `fontSize`, `fontWeight` (100 to 1000), `fauxBold` (0 to 0.25, a fraction of the size per edge, "faux bold: thicker, on any weight"), `italic`, `color`, `letterSpacing`, `lineHeight`, `align`, `direction` (`auto`, `ltr`, `rtl`), `orientation` (`horizontal`, `vertical`), `decoration` (`none`, `underline`, `strikethrough`: one value, the inspector toggles each), `textCase` (`none`, `upper`, `lower`, `title`: display only, drawn as CSS `capitalize` for title), `opacity`, `highlight`, `textEffects`; a styled range is the partial of the whole style. The inspector's Style row is four toggles (bold, italic, underline, strikethrough) and Case a four-way switch. We took `fauxBold`, `decoration` and `textCase`, on layers and ranges; `direction` and `orientation` are not built.
- **Templates.** Clicking a text look with a text layer selected applies it to that layer (the status line reads `Arcade → "HIGH SCORE"`); the plus adds a new one. Eight caption looks carry a `focus` ({props, scale}: the spoken word), which we map onto `caption.states.focus`; ten carry a pill (`highlight`), eight a text case, two a decoration, two an opacity. One extracted look (`karaoke-pill`) had a function source stored where its props belong: its `focus` was rebuilt by hand (`highlight.color` accent, radius 12, padding 14 and 6, scale 1.06).
- **The Fonts window.** Left: All fonts (2,143), Starred, Recent, In this project; sources Your fonts, On this device (199, by the Local Font Access API), Google Fonts (1,944); categories Sans 720, Serif 349, Display 468, Handwriting 358, Mono 51; collections. Top: search ("fonts, designers, feelings"), sort (Popular), preview text, size, weight (Auto), feeling chips (Calm, Business, Playful, Sophisticated, Futuristic, Vintage), style and language menus, Variable, Italic. Rows show the family, "Variable", designers, one style tag, the weights as "Aa", and a big preview; the footer says "Applies to <layer>" and has **Upload fonts**. The catalogue is chunk 3548: `GOOGLE_CATALOG_JSON`, rows of [family, category, weights, italic weights, variable min and max, axes, scripts, tags, designer, year added, size in KB] in popularity order, plus lists of scripts, tags (`s:` letterform styles, `f:` feelings), and designers. Our `library/google-fonts.json` is that data in a readable layout (1,946 families, credit in its `source`).
- **The Icons window.** Left: Find a set, Browse (All icons, Starred, Recent), the sets grouped as Interface, Material, Emoji… with counts. Top: breadcrumb, search ("every set" or the open one), chips All, Line, Solid, Colour, a cell size slider. All icons shows each group as set cards (four sample icons, name, count and licence); a set shows a grid. Bottom: the picked icon (name, star, tags such as `#tabler #stroke`, "Tabler Icons · MIT", "· credit <author>" when the licence asks), **Insert**, and the options: colour (default `#F4F2ED`), size (default 128 px, 8 to 2048), **Pen** (line width, `auto` keeps the set's own, 0.5 to 4), **Draw On** (the entrance, on by default: preset `draw`) and **Out** (an exit).
- **How AtomCut inserts an icon (chunk 1876).** It builds an SVG string from the icon data (`iconSvg`: size, colour, stroke width), runs it through its general SVG importer into layers, marks each with `origin: {kind: "icon", id, license: spdx, author}`, groups them when there are several, gives the group the entrance and exit, and inserts at the playhead at x 0, y 0 for 5 s. The icon client asks `icons.atomcut.net` then `api.iconify.design` and keeps every answer in the browser cache. We do the same with our own code: `svgImport.ts` (our reader), `svg.place`, `origin` on layers, answers kept on disk in user data.
- **The Iconify API, as observed.** `/collections` lists every set (name, total, author, licence with SPDX id, category, `palette`, samples, `hidden`); `/collection?prefix=<set>` lists a set's icon names (`uncategorized`, `categories`, `hidden`, `aliases`); `/<prefix>.json?icons=a,b` returns icon bodies with the set's `width` and `height`; `/search?query=…&limit=…&prefix=…` is capped at about 128 results spread across the sets it searched, so a search over a few sets (`prefixes=a,b`) reaches deeper into each. The mirror and the public host answer alike. A body is SVG elements only (no wrapper): stroke icons carry `fill="none" stroke="currentColor"`, solid icons `fill="currentColor"`, colour sets their own hex colours and gradients. Bodies are third-party markup, so we never put one in the page: pictures are data URLs in images, and placement goes through our own reader.
- **Licences.** The 6 GPL sets and 2 non-commercial sets (gridicons, wordpress, cbi, dashicons, gala, icomoon-free, et, ps) are left out; 235 sets remain (MIT, Apache-2.0, ISC, OFL, CC0 and Creative Commons Attribution, whose credit the window shows and `doc.overview.credits` lists).
- **Design system.** `@atomcut/mcp`'s `skill/design-systems/atomcut-default/DESIGN.md` (MIT) holds the type scale in U (short side ÷ 100), colour roles, safe areas, motion and sound tokens; adapted in `skill/design-systems/default/DESIGN.md` with our easings and tools.

## Simplifying keys and the work range (step A10.7 research)

Sources: the `keyframes_simplify`, `session_set` and `keyframes_inspect` tool schemas of AtomCut's MCP server, its skill (`SKILL.md` 2.28.0, `references/keyframing.md` › Repairing baked keys) and the session store and `session.set` in the bundled 4.9.0 web app (chunks 459, 5009, 8083), read as data. Our code is our own.

- **`keyframes_simplify {id?, frameId?, properties?, tolerance?}`** (`tolerance > 0`, in the property's own units: px, degrees, 0 to 1). It samples what plays on every frame and keeps the fewest keys whose *eased* playback stays within the tolerance, written on frames. Position x and y are reduced together from the true path, so they stay motion keys. Defaults: 0.5 px for position and size, 0.25° for rotation, 0.3 % of the track's range otherwise. `id`: one layer, every numeric track with 3 or more keys (or only `properties`). `frameId` alone: every **baked** track in that comp. Colours, shapes and switches are left as they are. The skill: "simplify keeps the timing, not the intent"; it repairs imports and old builds, new motion should be written as poses.
- **Baked**, per `keyframes_inspect`: a track keyed on nearly every frame (ours: 12 or more keys and at least one key per two frames of its span, `isBaked` in `commands/keyframes.ts`).
- **The work range is editor state, not document data.** The session store holds `workRange: {compId, startMs, endMs} | null` and `workRangeEnabled: false`; neither is undoable or saved with the project. It applies only when enabled, on its own comp, and when at least 100 ms long. Turning it on with no range for the comp seeds `0 … comp duration`. The handles keep `start ≤ end − 100` and snap the start to 0 within 50 ms. The transport has a "Working range" toggle, and `range.in` / `range.out` shortcuts set the ends at the playhead.
- **The range in the UI** (4.9.0 bundle, step A10.7b): the transport toggle (tooltip "Working range — loop & export just a section") shows "Set range in" and "Set range out" buttons while on. Default keys are `[` and `]` (the Premiere preset maps them to `i` and `o`). Setting an end within 50 ms of where it already is sends it back to the comp's start or end, and turns the range on. The lanes dim the time outside the range (`bg-background/60`); each end is a full-height line with a small flag at the top (the start's flag to the right, the end's to the left), dragged with `start ≤ end − 100`. Playback with an active range always loops inside it, whatever the comp's loop setting. The export dialog has a "Full" / "Working range" choice; we export the active range directly. AtomCut has no keyframe-simplify button in its UI (the tool is MCP only); our Keyframes tab adds one.
- **`session_set {workRange}`**: `{frameId?, startMs ≥ 0, endMs > 0}` sets the range on that comp (default the open one) and enables it; `null` disables it (the range is kept). The tool says the working range "limits playback and export to a span of a comp". `session_set` also takes `openFrameId`, `playheadMs`, `select`.

## Export formats (step A10.8a research)

Sources: the export module and export panel of the bundled 4.9.0 web app (chunk 5009, prettified), the core's quality tiers (chunk 459), chunk 2223 (gifenc) and chunk 7492 (mp4-muxer), read as data. AtomCut's MCP server has no export tool (see "Export as a tool"). The skill docs were not reachable this session. Our code is our own.

- **No saved settings.** The panel builds one options object per click: `startMs` and `durationMs` (the range: "Full" or "Working range", `full` / `span`), `scale` (default 1, at least 0.05; presets 0.5, 1, 1.5, 2, 3, 4, also shown as 360p to 2160p tiers), `fps` (comp rate by default; clamped to 1…240 and rounded to 3 decimals; presets 8, 12, 15, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120), `quality` (`draft`, `high` (default), `master`; MP4 and WebM only), `videoBitrate` (overrides the quality), `audioBitrate` (default 192 kbps, 64…320), `includeAudio` (default true), `transparent` (GIF, PNG sequence and MOV only), `motionBlur` (default true), plus `region` and `onlyClipIds` for exporting a selection, "Level sound" and a real-time sound capture switch.
- **Format ids** (panel): `mp4` "MP4 video", `mov` "Master — lossless MOV", `webm` "WebM video", `gif` "Animated GIF", `png-seq` "PNG sequence", `audio` "Audio only (WAV)" (listed only when the comp has sound). A separate "Image" kind exports one **PNG** still at the playhead (scale, transparent; static comps open on it), and SVG; there is no JPG or WebP still. The panel also exports Lottie, PDF and 3D models (not in this step).
- **MP4:** H.264 through WebCodecs and mp4-muxer, in memory; even size; High, Main, then Baseline profiles; constant quantizer per tier (draft 26, high 18, master 12), falling back to variable bitrate; key frame every 2 s. Sound AAC (Opus fallback), mixed offline at 48 kHz.
- **Quality as bitrate:** `recommended = clamp(w × h × fps × 0.4, 8 Mbps, 120 Mbps)`, times 0.5 (draft), 1 (high) or 2 (master). 1920×1080 at 30 fps: about 12, 25 and 50 Mbps.
- **MOV "Master":** AtomCut's own QuickTime muxer: every frame a PNG (sample entry `png `, depth 32 when transparent) and 16-bit PCM sound (`sowt`), 48 kHz. Lossless and large; not ProRes ("opens in Resolve/Premiere/AE, not QuickTime").
- **WebM:** recorded in real time from the canvas with `MediaRecorder` (VP9, then VP8, Opus), opaque. The only format that is not frame-exact.
- **GIF:** gifenc (MIT): a 256-colour palette per frame, no dithering, loops forever; transparent pixels are those under half alpha (one palette slot, dispose 2). It passes `round(100 / fps)` where gifenc expects milliseconds, so the frame delay it writes rounds to 0 at 30 fps; ours must write `round(100 / fps)` centiseconds (at least 2).
- **PNG sequence:** an uncompressed zip (fflate) named `<name>-png-seq.zip` holding `frame-NNN.png` from 0, padded to the digits of the frame count; transparent allowed.
- **Audio only:** WAV of the 48 kHz offline mix.
- **Delivery and names:** a Blob downloaded through a hidden link; default name `<project>-<comp>` with runs of other characters turned into `-`. Exports are serialised and cancellable; the free tier caps the long edge at 1280 px (not relevant here).

What mediabunny 1.61.3 (pinned) and Electron 45 (Chrome 156) give us here, checked in the running app:
- **Encoders** (`VideoEncoder` / `AudioEncoder.isConfigSupported`): H.264 at 1080p and 2160p; HEVC at 1080p only; VP8, VP9 and AV1 at both; AAC and Opus. No MP3, FLAC or Vorbis encoder. WebCodecs refuses `alpha: 'keep'` for every codec, but mediabunny keeps alpha for WebM/MKV by encoding a second, alpha-only stream (side data), so transparent VP9 WebM is possible. `OffscreenCanvas.convertToBlob` writes PNG, JPEG and WebP.
- **Containers:** `Mp4OutputFormat` and `MovOutputFormat` (avc, hevc, vp9, av1, vp8, prores; MOV also every PCM), `WebMOutputFormat` (vp8, vp9, av1 with opus, vorbis), `MkvOutputFormat`, `WavOutputFormat` (PCM, encoded by mediabunny itself), `Mp3OutputFormat` (needs a registered encoder), `OggOutputFormat`, `AdtsOutputFormat`, `FlacOutputFormat`. ProRes can be muxed but not encoded; there is no PNG video codec, so a PNG-in-MOV master needs a small muxer of our own. No GIF or image-sequence output; no GIF or zip library is installed.
- `StreamTarget` writes at positions (headers are patched by seeking), which our export IPC already supports for every format.

What we take, and what we do differently:
- We take the format ids and option names as the input shape of `export_video` (`format: 'mp4' | 'mov' | 'webm' | 'gif' | 'png-seq' | 'audio'`, plus `png`), the quality tiers and bitrate formula, the MOV master's design (PNG frames and PCM), GIF loop and transparency rules, the PNG-sequence frame names, WAV at 48 kHz.
- We do differently: every format is frame-exact (WebM is encoded by VP9 through mediabunny, not recorded in real time); files go straight to disk through the save dialog or `export_video`'s path, never through an in-memory Blob; the GIF frame delay is written correctly; stills also as JPG and WebP; a PNG sequence is a folder (an editor can read it directly), not a zip.
- **A10.8a (done):** `export/encode.ts` (`EncodeSpec`: container, codecs, quality, AAC lead-in; `MP4_H264_AAC` is the default) taken by `renderComp` as `options.encode`; `export/formats.ts` (`EXPORT_FORMATS`, `BUILT_FORMATS`, `parseExportFormat` with aliases such as `wav`, `jpeg`, `png_seq`); `export_video {format}` accepts `mp4` and refuses the others with a hint.
- **A10.8b (done), found in the checks:** mediabunny's `Quality({bitrate})` is a target, not a floor: H.264 and VP9 undershoot it on simple pictures (a 1080p test card at the draft and master targets of 12.4 and 49.8 Mbps came out at 3.1 and 4.8 Mbps), so the tiers differ by less than 2× on plain content. VP9 through mediabunny is frame-exact (frame 60 of the WebM against the MP4 master: 63.6 dB; against the next frame: 27.4 dB), and Opus needs no lead-in (its pre-skip is in the header). WAV through `WavOutputFormat` with `pcm-s16` takes the mix with no frame loop (a 10 s comp writes in about 0.15 s; the RMS level equals the source's). `getFirstEncodableVideoCodec(['vp9', 'vp8'], …)` picks VP9 here.
- **A10.8c (done), found in the checks:** our own QuickTime muxer (one PNG per sample and chunk, sound one chunk per mixed second, `co64` offsets, `moov` at the end) is read by ffprobe as `png` (`rgb24`, or `rgba` with depth 32) and `pcm_s16le` (`sowt`); a frame decoded from it equals `view_render`'s PNG of the same instant (PSNR inf), and its sound bytes equal the WAV export's (`clamp(round(v × 32768))`, as mediabunny writes `pcm-s16`). A 23.976 fps file gets the timescale 23976 with 1000 per frame (ffprobe: 2997/125). PNG compression costs about 20 ms a frame at 640×360 (90 frames in 2.2 s with sound). Transparent VP9 WebM through mediabunny `alpha: 'keep'` is flagged `alpha_mode=1`; ffmpeg reads its alpha only with the `libvpx-vp9` decoder (`-c:v libvpx-vp9` before `-i`; the native vp9 decoder drops it). Both transparent files kept alpha exactly at the checked pixels (0 outside, 255 on the clip, 128 on a half-opaque shape).
- **The live export panel (4.17.0, A10.8e research).** Read over CDP on port 9333 (DOM text, roles and screenshots, as data). The top bar's Export button (download icon, top right) opens a menu: "Composition…", "Layer "<name>"…" (the selected layer), "Lottie animation…", "PDF…", "Current frame (PNG)" and "AtomCut file — n layers". "Composition…" opens a modal "Export" (about 490 px wide, a scrolling body, subtitle `Exporting composition "<name>" · 1080×1920`). From the top:
  - a two-way toggle comp name / selected layer's name (only with a selection);
  - a four-way kind toggle **Image / Video / Lottie / PDF**;
  - a preview of the comp at the playhead on a checkerboard;
  - **Format**: Video kind is a select with an icon: "MP4 video", "Master — lossless MOV", "WebM video", "Animated GIF", "PNG sequence", "Audio only (WAV)"; Image kind is a two-way toggle PNG / SVG;
  - **Range** Full / Working range (a two-way toggle, shown only when a working range is on; **Full is selected by default**);
  - **Size**: two selects side by side, a resolution preset (360p, 480p, 720p, 1080p, 1440p, 4K, each with its size; the number is the short side: 720p of a 1080×1920 comp is 720×1280) and a scale (0.5×, 1×, 1.5×, 2×, 3×, 4×, each with its size); the free tier opened at 720p (long side 1280);
  - **Frame rate**: a number field with "fps" and a presets button (8 "Rough / thumbnail", 12 "Hand-drawn animation", 15 "Limited animation", 23.976 "Film (NTSC pulldown)", 24 "Film", 25 "PAL broadcast", 29.97 "NTSC broadcast", 30 "Standard video", 50 "PAL high frame rate", 59.94 "NTSC high frame rate", 60 "Smooth / UI motion", 120 "High frame rate"), with the note "This comp runs at 30.";
  - switches **Include sound** (MP4, MOV, WebM), **Level sound** with a percentage (80 %), the line "Encoder: WebCodecs, or live recording", **Transparent** (MOV, GIF, PNG sequence, PNG still; not MP4 or WebM), **Motion blur** (every video format);
  - a collapsible **Advanced** box (MP4 and WebM only): **Quality** Draft / High / Master, each with its bitrate ("~6", "~11", "~22 Mbps" at 720×1280, 30 fps), **Audio bitrate** (192 kbps), **Record sound** ("Runs in real time. The surest route when an export comes back silent.");
  - a summary line in mono, `720×1280 · 30 fps · 10.0s` (audio only: `10.0s`), and a full-width accent button **Export <comp name>**.
  - Audio only hides size, frame rate and transparent; GIF and PNG sequence hide the sound switches and Advanced; the Image kind shows Format, Size and Transparent only.
- What we take for A10.8e: the modal's order and fields, the presets and their labels, Full / Working range only when a range is on, Advanced holding quality and audio bitrate, the summary line and the "Export <name>" button. Differences: Image offers PNG, JPG and WebP (no SVG yet) and a still's time; Video offers transparency for WebM too; refusals from the same checks as `export_video` show in the dialog before any file opens; the range defaults to the working range when one is on (as Ctrl+E and `export_video` already do), not to Full; no Level sound, Record sound, Lottie, PDF or selected-layer export in this step.
- **A10.8d (done), decided and found:** GIF is our own writer (`export/gif.ts`), not gifenc: no new dependency, and the delay is right by construction. Delays are accumulated (`round(100·(n+1)/fps) − round(100·n/fps)`, at least 2), so 30 fps gives 3, 4, 3 hundredths and 90 frames last exactly 3.000 s (ffprobe), where a fixed `round(100/fps)` would play 10 % fast. Above 50 fps the rate is capped at 50 (a 60 fps ask gave 150 frames over 3.0 s). The palette is a median cut per frame over a 5-bit histogram (exact colours when a frame has 256 or fewer); a worst-case 1080p noise frame takes about 90 ms to quantize and 40 ms to compress, flat graphics far less. A GIF frame of the test card against `view_render`: 67.5 dB. Transparency follows AtomCut's rule exactly: alpha 128 is opaque, its colour the unpremultiplied one. PNG sequence frames and PNG stills equal `view_render`'s PNG (PSNR inf) when motion blur is on in both, as it is by default; a static frame's still is drawn without motion blur (it does not move), equal to a still exported with `motionBlur: false`. JPG at 0.92 against the PNG: 52.9 dB; WebP at quality 1 is lossless and keeps alpha.

## Motion paths (step A10.9a research)

Sources:
- AtomCut's skill (`references/keyframing.md` and `motion.md`, skill 1.31.0) and the live `keyframes_set` schema from its MCP server.
- Chunks 459 and 5009 of the bundled 4.9.0 web app, prettified and read for behaviour.
- The scripts of the live 4.17.0 editor (build `4.17.0-abc5fb7e`), read over CDP on port 9333 with `Debugger.getScriptSource`.

All of it was read as data. The overlay's look was read from the code and has not been seen on screen yet; that check is in A10.9e. Our code is our own.

- **Document shape.**
  - Position stays two tracks, `x` and `y`, plus `z` for 3D.
  - A key is `{id, timeMs, value, easing, spatial?}`. The curve lives in `spatial: {in: {x, y} | null, out: {x, y} | null}`, on the **x key only**, in px relative to the key. `z` has no handles.
  - Nothing else is stored. Neither 4.9.0 nor 4.17.0 has an `arc` field, a mirrored or linked flag, auto-orient (orient along the path) or a constant-speed option.
  - A layer has a motion path when x and y together give at least two **motion keys** (`motionKeysOf`). These are the union of the two tracks' key times, merged within 0.5 ms; each row is `{timeMs, x, y, in, out, easing}`.
- **Evaluation.**
  - It applies only when some x key has a non-null `spatial`.
  - A segment from key A to key B is the cubic Bézier A, A + A.out, B + B.in, B. Its parameter is the **eased time**: the easing of A's x key, or its y key if there is none.
  - It is not reparametrised by arc length, so speed varies along a curve even under linear easing. Easing changes the speed; the handles change the shape.
  - On a curved segment, a missing handle defaults to a third of the chord toward the other key.
  - A segment with neither handle uses the usual per-axis interpolation, which is a straight line.
  - A curved segment never counts as a hold, even when its two ends are equal (a loop out and back to the same point).
  - z is not touched.
- **`arc` is an input shape: `keyframes_set` turns it into handles.**
  - `arc: h` on a key curves the segment leaving it into a parabola, with x linear in time.
  - That parabola is a quadratic Bézier whose control point C sits at the mid x of the two keys. It is written as cubic handles `A.out = ⅔(C − A)` and `B.in = ⅔(C − B)`, so the x parts are a third of the chord and x moves at constant speed.
  - In screen terms (+y down), `h > 0` peaks at `p = min(yA, yB) − h`: h px above the higher end.
  - `h < 0` sags to `p = max(yA, yB) + |h|`.
  - C's y is the value whose quadratic has that extremum: `p − √((yA − p)(yB − p))` for `h > 0`, and `p + √(…)` for `h < 0`.
  - The peak's height is exact. It falls at mid-time only when the ends are level.
  - Example: A (0, 0), B (300, 0), arc 100 gives C (150, −200), out (100, −133.3), in (−100, −133.3) and a peak at y −100.
  - With `arc`, the key's easing defaults to **linear**. That is real gravity: constant sideways speed and constant downward acceleration.
  - Reading the layer back gives only `in` and `out`.
- **`keyframes_set` rules.**
  - `arc`, `in` and `out` work on `position` only. Anything else is refused: "`arc`, `in` and `out` shape a motion path."
  - An `arc` on a key followed by a key with its own `in` is refused: "One curve per segment: keep the arc or the handle."
  - With both `out` and `arc` on one key, the arc wins.
  - Setting a handle creates the x and y keys at that time if one is missing.
  - `in` and `out` take `[dx, dy]` or `null`.
- **`keyframes_inspect`.**
  - Position prints as separate `x` and `y` tracks, `time value easing` per key.
  - `↷` follows the value of a key that has `in` or `out`.
  - Handles and arcs are not printed, so a round trip through inspect loses the curve.
- **Editing operations.** These are UI only; there are no MCP tools for them.
  - *Move a point* (`setMotionAnchor`): writes the x and y keys. Handles are relative, so they travel with the point. It snaps to guides; Ctrl or Cmd turns snapping off.
  - *Insert a point* (double-click a segment, `insertMotionKey`): adds x and y keys at the eased time of the click and splits the easing so the timing is kept. On a curved segment, a de Casteljau split rewrites the handles of the new point and its neighbours, so the shape is unchanged.
  - *Delete a point* (`deleteMotionKey`): removes the x and y keys at that time, with its handles. The neighbours keep theirs.
  - *Smooth or corner* (double-click a point, `toggleMotionSmooth`; the context menu has "Make smooth (curved)", "Make corner (straight)" and "Delete motion point"):
    - A point with handles loses them (a corner).
    - Otherwise it gets Catmull-Rom tangents: `out = (next − prev) / 6` and `in = −out`.
    - The first key gets no `in` and the last no `out`.
  - *Bend a segment* (drag the curve, `bendMotionSegment`): sets both handles so the curve passes through the grabbed point. The grab parameter is clamped to 0.1…0.9.
  - *Drag a handle* (`setMotionTangent`):
    - A pair that is equal and opposite, within 1 %, stays mirrored.
    - A collinear pair of unequal lengths stays collinear and keeps the partner's length.
    - Alt breaks a mirrored pair, or mirrors a broken one.
    - Shift snaps the angle to 15°.
    - A drag that ends within 4 px of the key removes the handle.
  - Alt-drag on a point pulls out fresh symmetric handles.
  - Every drag is one undo step.
  - The timeline's **Smooth** button (`smoothKeyframes`, tooltip "Continuous motion across the selection — removes the pause at every keyframe"):
    - It gives the selected x/y keys Catmull-Rom handles.
    - It rewrites each segment's easing as a cubic-bezier from monotone slopes over the cumulative path length, so speed is continuous through the keys.
    - Other numeric tracks get the same monotone easing.
- **The overlay.** It is View menu ▸ "Motion paths" (hint "on selection"; store `motionPaths`, on by default, kept in localStorage).
  - It is drawn only with the Select tool and nothing being edited, for selected, visible clips with two or more motion keys. Locked clips are drawn but cannot be edited.
  - Points are in the layer's parent space and are mapped through the group chain to the screen.
  - Curve: a 1.5 px stroke in `#8B5CF6` over a dark halo, `rgba(10,10,14,0.62)`, 1.5 px wider.
  - Chevrons point along the motion at sampled times: one per frame, at most about 240 over the path, at 60 % alpha, skipped at the keys.
  - Keys are diamonds of radius 4 (5.5 on hover or drag). Idle ones are white with a purple outline; selected or smooth ones are purple with a white outline.
  - Handles: a 1 px line at 55 % alpha to a 3.5 px dot (4.75 on hover).
  - The playhead's position is a purple dot of radius 4 with a 1.5 px white ring.
  - Hovering a segment shows a 9 px round badge with "+" on the curve.
  - Hit radii are 8 for a handle, 9 for a key, 7 for a segment and 4 for the drag latch. Handles are tested first, then keys, then segments.
  - **Seen on screen (A10.9e, 2026-10-26).** A rectangle with three position keys, one segment curved, was shown in the live 4.17.0 over CDP: idle, hovering a segment, a key and a handle. The keys were written through the document store, which is reachable from the React fiber tree (an object with `getState` and `update`). The stage chunk's drawing code gave these measurements (all CSS px):
    - The curve's halo is 3 px wide, drawn first; caps are round.
    - A chevron is an open V with round caps: its arms reach 5.1 px back along the travel and 2.9 px to each side, in a 1.5 px line at 60 % alpha. Chevrons sit one per max(frame, span/240) at the sampled points, so they crowd where the motion is slow (near eased keys). The direction is the chord between the neighbouring samples.
    - Diamonds and handle dots sit on a dark disc 1.2 px larger. Their line is 1.5 px.
    - A hovered key or handle is drawn "on" (purple fill, white line) at the hover size, inside a soft ring of radius 11: purple at 16 % fill and a 1 px line at 50 %.
    - A handle's line has a 2.5 px dark line under it; its alpha is 0.9 while hovered.
    - The playhead dot is drawn after each path's keys, so it covers a key at the playhead.
    - The "+" badge is a purple disc of radius 9 with a 1.5 px white ring, on a dark disc of radius 10.5. The "+" is two 2 px white strokes of half-length 4.1. During a drag, when the pointer is more than 15 px from it, a dashed purple leader (3/3, 55 %) joins them.
    - The cursor does not change over the path. We show a pointer there (a deliberate difference).
    - Open question: in the capture, a middle key with only an `in` handle drew idle (white) while a key with only an `out` handle drew smooth. We draw any key with a handle as smooth; check this when A10.9f edits handles.
    - Settled in A10.9f: we keep "any handle is smooth" for both the drawing and the toggle. AtomCut's toggle takes the handles off any point that has one, so a filled diamond always means "double-click makes this a corner"; drawing an in-only point idle would hide that. Its idle in-only diamond looks like a drawing detail, not a rule, and we do not copy it.
- **3D** (for A7).
  - A 3D layer's path is a sampled polyline of its world position: up to 160 points, about 48 a second, with a dot at each x, y or z key.
  - It shows in object mode only and cannot be edited.
  - It also counts parent motion, modulators and follow constraints.
- **Not in AtomCut:** auto-orient, constant speed along the path, handles on z, and spatial handles on any property other than position.

**What we take:**
- the document shape (handles on the x key of the pair, in relative px, nullable);
- the evaluation (a Bézier at the eased time, the ⅓-chord default, and curved segments never hold);
- `arc` as an input converted to handles, with linear easing;
- AtomCut's errors and the `↷` mark;
- the editing operations and their modifiers, and the Smooth button;
- the overlay's look.

**What we do differently:**
- Handles are stored as `[dx, dy]` tuples under `spatial` on our `{t, v, ease}` keys, the shape `keyframes_set` already takes.
- A curved segment needs x and y keys at both its ends. AtomCut builds rows from the union of times; we refuse handles at a time where only one axis is keyed. `keyframes_set` with `position` always writes both.
- `keyframes_inspect` prints the handles after `↷`, as `↷(out dx,dy in dx,dy)`, so a round trip keeps the curve.
- `keyframes.simplify` leaves curved position tracks alone, and keeps straight paths straight.
- Splitting and ripple edits need nothing new. `timeline.split` and the ripple commands keep every key and only shift times (`shiftKeys` in `doc.ts`), so the handles travel with their keys and the motion is unchanged.

**What AtomCut's skill teaches about paths (A10.9g, read as data from `references/keyframing.md` and `motion.md`).**
- Poses, not samples: one `position` key per contact, a rest as the same point keyed twice, `hold` for a cut, and a budget (a 60 s piece around 1–4k keys, no baked tracks).
- "Thrown or bouncing things: `linear` under an `arc`"; `arc < 0` for a swing or dip; `in`/`out` for any other shape.
- Tracing a drawn line: key the path's anchor points with its own Bézier handles, `linear`, each segment timed by its length.
- Moves that should flow through a middle key: one continuous curve (two keys), or the keyframe **Smooth** action (UI only there).
- Squash and stretch at contacts (pivot on the floor, about four `scaleY` keys per contact, `scale` the other way).
- Our skill (0.14.0) writes its own text for the same ideas and adds what our tools add: the printed handles of `↷(…)` paste back, `motion_edit` with comp-time `atMs`, `keyframes_smooth` as a tool, a bounce decay rule (each arc about half the last, each flight about 70 % as long, which keeps one gravity since height goes with the square of the flight time), and the box-centre offset of a path layer when tracing it.

**Found in the A10.9g checks.**
- `keyframes_smooth` over a curved segment rewrites its easing from the path's arc length, so a two-key range keeps its handles but loses the `linear` of an `arc`: the throw no longer has constant sideways speed. The skill warns to leave hops out of the range. From the A10.9a reading, AtomCut's Smooth button rewrites the same easing, so it should do the same to an arc segment (not checked live).
- The key that lands an `arc` (with no arc of its own) keeps the default easing (`ease-in-out`); it only matters when the next segment moves, so a bounce chain without rests should put an `arc` (and so `linear`) on every take-off key.

## 3D worlds (step A7a research)

Sources:
- AtomCut's skill 1.31.0. `references/3d.md` was read live over MCP; `references/3d-faces.md` came from the `@atomcut/mcp` 3.6.0 package.
- The live schemas of its 16 world tools (`world_*`, `mesh_edit`). Only the schemas were read, because the tools need Pro.
- The bundled 4.9.0 web app, prettified and read for behaviour:
  - chunk 459: the model and commands;
  - chunk 5009: extrusion and the plane pictures;
  - the render chunks in the corrected map below.

The live 4.17.0 was not opened, because the live skill agrees with the 4.9.0 code on every point checked. All of it was read as data. Our code is our own.

**Chunk map, corrected.**
- `cb8e12c4` and `a55e8ffc` are both stock three.js **r186**.
- `7481` is three's `USDZExporter`, not cameras.
- `6877` holds stock addons:
  - `EffectComposer`, `UnrealBloomPass`, `GTAOPass`, `TexturePass` and the Bokeh shader;
  - `Line2`/`LineMaterial` (fat lines);
  - three-bvh-csg (booleans).
- `6224` is `GLTFLoader`.
- AtomCut's own world renderer is in two chunks:
  - `8127`: scene sync, materials, lights, floor, line art, the post stack and motion blur;
  - `2961`: `createWorldEngine`, the environments and tone mapping.
- The editor's orbit viewport, with its 3D motion paths, is in `1859`.

**The document.**
- A comp is a world when it has a `world` object. AtomCut calls comps "frames" and layers "clips".
  - `world` holds `render` and `fog`, plus an editor-only `view` (orbit target, distance, yaw, pitch, shading and grid).
  - There are no units or up-axis fields. Space is fixed:
    - Z is up, X points right and Y points away from the front view;
    - 1 unit = 1 px = 1 cm.
  - The background is the comp's own: `#16171b`, or clear with no fills when `transparent`.
- `render` fields:
  - `toneMapping`: `agx` (default), `aces`, `neutral` or `none`.
  - `exposure`: in stops, −10…10, default 0.
  - `shadows`: true.
  - `shadowQuality`: `low`, `medium` (default) or `high`, which give shadow maps of 512, 1024 and 2048.
  - `bloom`: `{enabled false, strength 0.8 (0…3), radius 0.5 (0…1), threshold 0.75, source bright|emission}`.
  - `ao`: `{enabled false, radius 60 (1…5000 px), strength 1 (0…2)}`.
  - `floor`: `{mode none|shadow|solid|mirror, color #202024, opacity 0.45, z 0}`.
- `fog`: `{enabled false, color #9aa3ad, start 1000, end 20000}`, linear. The tool calls it `mist`.
- **A world nests like any comp.** It is an ordinary nested layer whose source is the world, drawn through the world's live camera.
  - Inside another world, a nested world adds only its objects: no cameras or lights.
  - Nesting goes up to depth 4, and the ids become `<nested>/<inner>`.
- **Layer kinds that only worlds have:** `mesh`, `camera`, `light` and `empty` (shown as "Controller").
  - Every 2D kind (text, shape, path, image, video, nested) can stand in a world as a **picture plane**.
  - 2D layers in flat comps keep `z`, `rotationX` and `rotationY`.
- **Transform.**
  - The fields are `x, y, z, rotationX, rotationY, rotation (Z), scale, scaleY, scaleZ`. `scaleY` and `scaleZ` default to `scale`.
  - The matrix is T·Rz·Ry·Rx·S in degrees. This is the same order as our flat `layerMatrix`.
  - A spatial layer scales by `[scale, scaleY, scaleZ]`.
  - A 2D layer in a world scales by `[scale, scaleZ, scaleY]`, because its picture lies in the XZ plane, so its height is world Z.
  - Cameras and lights look down their local −Z. Other objects aim with their −Y.
- **Camera** (`camera` field):
  - `projection perspective|orthographic`, `focalLength 50` (mm, 1…5000), `sensorWidth 36` (mm, 1…200), `orthoScale 1000`, `clipStart 1`, `clipEnd 1e5` (px), `shiftX`, `shiftY`.
  - `dof {enabled false, focusDistance 1000, fStop 2.8 (0.1…128), focusObjectId null}`.
  - No field of view is stored. The sensor spans the **longer** side: the field of view on that axis is 2·atan(sensor / 2 / focal), and the other axis follows from the aspect.
  - Keys: `camera.focalLength`, `camera.dof.fStop`, `camera.dof.focusDistance`.
- **Light** (`light` field):
  - `type point|sun|spot|area|environment|hemisphere`, `color #ffffff`, `intensity 1000`, `range 0`, `spotAngle 45`, `spotBlend 0.15`, `width` and `height` 100 (area), `groundColor #2b2a28` (hemisphere), `castShadow true`, `shadowSoftness 2` (0…20).
  - `environment studio|soft|sunset|dawn|night|overcast` and `showBackground false`.
  - The intensity given when a light is added:
    - point 1000, spot 1500 and area 800 (watts);
    - sun 3, environment 1 and hemisphere 0.6 (strength).
  - Only the first environment light counts.
- **Controller** (`empty`): `display axes|cube|sphere|arrows`, `size 80`. It never renders.
- **Constraints** (`constraints[]`):
  - `lookAt`;
  - `follow {rotation}`: its own position becomes an offset from the target;
  - `childOf {inverse}`: it stays put when it is parented;
  - `ik {chainLength 2, poleId}`.

  Each has `targetId`, `enabled` and `influence 0…1`, and they are blended by matrix lerp.
  - A7k (chunk 459, read 2026-10-28): they are solved on the objects' world matrices in passes: childOf first, in dependency order (`Target · inverse · M`), then IK, then follow (targets as childOf left them; `Target · M` with `rotation`, else only the target's position added), then lookAt (live targets; the object's position and column scales kept, cameras and lights aim −Z, others −Y). The live camera is chosen after that. `world.track` and the inspector store childOf's inverse from the target's matrix at the parked playhead (time 0 from the tool), and each given field replaces that type's constraint with influence 1. The inspector's "Track" section has Child of, Look at and Follow pickers (layers of the frame, "Nothing" clears), "Turn with it" while following, and Reach (IK), Chain and Pole for IK; no influence row.
- **Mesh.**
  - `geometry` is one of:
    - a `primitive {primitive, params}`;
    - an editable `mesh {positions, faces (n-gons), faceParts, marks, sharp, uv}`;
    - an `asset {assetId}` (an imported model).
  - Other fields: `uv box|planar|cylinder|sphere`, `texture {frameId, repeat}`, `parts[]`, `shading smooth|flat|auto` with `smoothAngle 30`, `castShadow` and `receiveShadow`, and the `lines` flags.
  - The default colour is `#c9cbd1`. A mesh's colour is the layer's fill.
  - There are 13 primitives. Sizes default to 200 px, or a radius of 100. The params key at `geometry.<param>`:
    - `cube {sizeX, sizeY, sizeZ, fillet, filletSegments 4, segments 1}`;
    - `plane`, `grid {segments 10}`, `circle {radius, vertices 32}`;
    - `uvSphere {radius, segments 32, rings 16, arc}`, `icoSphere {subdivisions 2}`;
    - `cylinder {radius, depth, vertices}`, `cone {radius1, radius2, depth}`, `pyramid {base, height, sides 4}`;
    - `torus {majorRadius 100, minorRadius 25, 48×12}`, `capsule {radius 50, length}`, `tube {outerRadius 100, innerRadius 70}`, `torusKnot {radius 100, tube 20, p 2, q 3}`.
- **Material** (`material`, on meshes and on 2D layers in a world):
  - Fields: `model pbr|toon|unlit`, `roughness 0.5`, `metalness 0`, `emission #000000`, `emissionStrength 1` (0…100), `transmission 0`, `ior 1.45`, `thickness 0` (px), `clearcoat 0`, `clearcoatRoughness 0.1`, `sheen 0`, `iridescence 0`, `toonSteps 3`, `doubleSided false`, `source file|custom`, `preset`.
  - A preset is merged over the defaults, and its colour tints the fill.
  - The 17 presets. "r" is roughness, "m" is metalness, and a value in brackets is the clearcoat roughness:

    | Preset | Values |
    | --- | --- |
    | plastic | r .25, clearcoat .3 (.1) |
    | matte | r .85 |
    | clay | #c9a48a, r .95, sheen .2 |
    | ceramic | #f2f0ea, r .15, clearcoat 1 (.05) |
    | rubber | #2a2a2c, r .75, sheen .4 |
    | metal | #b8bcc4, r .35, m 1 |
    | chrome | #e8ebf0, r .04, m 1 |
    | gold | #f5c46b, r .18, m 1 |
    | copper | #e0916b, r .25, m 1 |
    | carpaint | #c4202f, r .45, m .6, clearcoat 1 (.03) |
    | glass | r .02, transmission 1, ior 1.5, thickness 20 |
    | frosted | r .4, transmission 1, ior 1.5, thickness 20 |
    | velvet | #5b2a86, r .9, sheen 1 |
    | pearl | #f4efe8, r .2, m .1, iridescence 1, clearcoat .6 |
    | neon | #ff2fb1, r .4, emission #ff2fb1 × 4 |
    | toon | steps 3 |
    | flat | unlit |

- **Thickness** (`extrude` on a 2D layer in a world):
  - A7i decision: use MIT-licensed opentype.js for glyph outlines, covering TrueType and CFF, instead of maintaining our own font outline parser alongside `shared/fontFile.ts`. Place glyphs using the existing text layout.
  - Fields: `{depth 40, bevel 0, bevelSegments 3 (1…8), sideColor null, fit outline|box}`.
  - Keys: `extrude.depth` and `extrude.bevel`. `depth: 0` makes the layer flat again.
  - `outline` follows the real shape: glyph outlines, contours, or an image's alpha silhouette. It is the default for vectors and images.
  - `box` is a bevelled slab the size of the picture. It is the default for video and nested comps.
  - An open path cannot be extruded.
- **Phase E for us.** The same schema also holds modifiers (27 types, `mdf.<id>.<field>`), sculpting, lattices, `mesh_edit`, physics, rigs and faces. Line art is there too: `lineArt {color #111111, width 2, opacity 1}`, plus silhouette, creases at 40°, boundaries and marked edges.
- **Commands.** Each one refuses a flat comp: `"<name>" is a flat comp, not a 3D world.`
  - `world.create {name?, width 1920, height 1080, starter true, transparent false, pageId?}` returns `{frameId, objects}`. The starter world holds:
    - a cube;
    - a point light at [408, 100, 590], intensity 1500;
    - an environment light, "Studio", at 0.3;
    - a camera at [736, −693, 496] aimed at the origin.

    All of them fill the comp.
  - `world.add {frameId?, kind mesh|camera|light|text|controller|head, primitive cube, params?, light point, position [0,0,0], rotation?, scale?, lookAt? [x,y,z]|id, color?, material?, intensity?, focalLength?, text?, name?, startMs?, durationMs?}` returns `{id}`.
    - `lookAt` sets the rotation (−Z forward) unless a rotation is given.
    - A camera with neither gets [90, 0, 0], which faces +Y.
    - With no start and no duration, the layer fills the comp.
  - `world.camera {frameId?, activate?, atMs?, fromDefault?}` returns `{cameraId?, activeAt, active}`.
    - `activate` un-hides that camera and restacks it at the live camera's lane position. It refuses a camera that is not on the timeline at `atMs`.
    - `fromDefault` adds a camera at the default pose, below every other camera, so the picture does not change.
  - `world.inspect {frameId?, atMs?}` returns:
    - `output [w, h]`;
    - the live camera's `{id | "default", position, rotation, fovY}`;
    - the environment;
    - `objects [{id, name, kind (mesh|camera|light|empty|"plane (<kind>)"), position, rotation, size, opacity}]`;
    - `liveCameraAtMs`.

    Values are rounded to 0.1.
  - `world.look {frameId, toneMapping?, exposure?, shadows?, mist?, bloom?, ao?, floor?, cameraId?, dof?: {enabled, focusOn, focusDistance, fStop}}` changes only the fields it is given. `dof` needs `cameraId`.
  - `world.material {ids, preset}`.
  - `world.extrude {ids, depth, bevel?, bevelSegments?, sideColor?, fit?}`.
  - `world.track {id, lookAt?, follow?, followRotation?, childOf?, ik?}`. A null clears that constraint.
  - `world_import_model` is a host tool. It takes `.glb`, `.gltf`, obj, fbx, stl or ply, from an attachment or a URL.
- **The live camera.**
  - It is the topmost visible camera layer whose span covers the instant. The front lane comes first, and hidden lanes and clips are skipped.
  - Cuts are camera clips laid end to end on one lane.
  - With no live camera, the **default front camera** is used:
    - at (0, −D, 0), with rotation [90, 0, 0] (it looks along +Y, Z up);
    - with a 50 mm lens on a 36 mm sensor;
    - where D = max(w, h) · focal / sensor, which is 2666.67 for 1920×1080.

    This D is exactly our `frontCamera` distance, so the plane y = 0 maps 1 unit to 1 px.

**Move into a world (`world.move_into {ids?, frameId?, name?}` → `{nestedId, frameId}`).**
1. It keeps the given layers that are not audio, adjustment or spatial. It refuses when none is left, or when their comp is already a world: "Nothing to move: pick 2D layers in a flat comp (audio, adjustments and 3D objects stay)."
2. It runs the ordinary nest, full frame. The new comp has the source's size and fps and a clear background. A nested layer goes in the first layer's lane and spans the moved layers.
3. The new comp gets `world` with all its defaults and **no camera**, so the default camera sees exactly the flat picture. The UI's toast says "In 3D — the same picture, now with depth".
4. Each moved layer is converted by the change of axes P(x, y, z) = (x, z, −y):
   - world x = x;
   - world y (depth) = 2D z;
   - world z (up) = −2D y.

   P is a −90° turn about X, with no unit scale. It is applied in one of two ways:
   - **No rotation keyed:** the whole matrix is conjugated, P·M·P⁻¹, then decomposed back to XYZ Euler (rounded to 1e-6).
   - **Some rotation keyed:** the values are swapped directly: `y ← z`, `z ← −y`, `rotationY ← rotation`, `rotation ← −rotationY`, and `rotationX` is kept.

   The rest of the conversion:
   - **Key tracks are renamed the same way:** y→z (negated), z→y, rotation→rotationY, rotationY→rotation (negated).
   - x keys lose their `spatial` handles.
   - Modulators and expression drivers are retargeted. A flipped expression becomes `-(expr)`.
   - Scale and the pivot are not converted. The world reads a plane's scale as `[scale, scaleZ, scaleY]`.
   - The direct swap is exact only when `rotation` or `rotationY` is zero: P·Rz(a)·Ry(b)·Rx(c)·P⁻¹ = Ry(a)·Rz(−b)·Rx(c), which is not in XYZ order.
5. `{frameId}` makes a whole frame 3D ("Make 3D"). Its top-level 2D layers move into a world nested full-frame inside it, and the frame stays as the wrapper. An empty frame gets an empty world named "<name> · 3D".

**The renderer** (chunks 8127 and 2961, three r186).
- **Scene.**
  - A root group is scaled by 0.01: 1 px is 1 cm, so three works in metres for lights, shadows and depth of field.
  - Each object's matrix comes from a pure `evaluateWorld(doc, comp, t)` and is set with `matrixAutoUpdate = false`.
- **Picture planes.**
  - The texture is the layer's own 2D render, drawn alone with its transform, opacity and whole-layer animation zeroed (the plane carries those).
  - The texture's canvas:
    - covers the layer's bounds plus its effects' reach;
    - uses `density = clamp(1.5 · output scale, 0.5, 3)`, capped at 2048 px;
    - is redrawn only when the content or its local time changes;
    - is sRGB and premultiplied, with anisotropy 4.
  - The quad sits at (x, 0, −y), with normal −Y.
  - The material is `MeshBasicMaterial`: unlit, `toneMapped: false`, double-sided, `alphaTest 0.004`, with premultiplied custom blending.
  - Stacking: `polygonOffsetUnits = −2 · layerOrder` keeps coplanar layers in their stack order, and transparent objects sort by depth, then by layer order.
- **Bodies.**
  - Outlines:
    - text and shapes use their vector outlines, with holes found by even–odd containment;
    - images use an alpha ≥ 128 trace of a ≤ 320 px bitmap, simplified by RDP at 0.75 px.
  - The outline goes into three's `ExtrudeGeometry` with `curveSegments 10`.
    - The bevel's thickness and size both equal `bevel`, and its offset is −bevel, so the silhouette stays the outline.
    - The geometry is shifted by the bevel and turned −90° about X, so depth runs away from the camera.
  - The face wears the picture. The side colour is `sideColor`, or the fill × 0.62.
- **Materials.**
  - `pbr` becomes `MeshPhysicalMaterial`, with thickness × 0.01.
  - `toon` becomes `MeshToonMaterial` with a stepped gradient map.
  - `unlit` becomes `MeshBasicMaterial`.
  - Gradient fills are painted into a 512² texture.
- **Lights.**
  - Point and spot: intensity / 4π (watts to candela), distance = range × 0.01, decay 2. A spot's angle is `spotAngle / 2`, and its penumbra is `spotBlend`.
  - Sun: a directional light at its raw strength. Its shadow camera fits the scene's bounding sphere.
  - Area: a `RectAreaLight` at I / (π · area) / 4.
  - Hemisphere: one shared light.
  - An ambient light at 0.03 is always added.
  - Shadows: PCF, bias −4e-4, normalBias 0.02, radius = softness.
- **Environment.**
  - The environment light becomes `scene.environment` through PMREM, at the light's intensity, turned by the light's rotation. With no environment light, it is 0.
  - `studio` is three's `RoomEnvironment`.
  - The other five presets are gradient skies (top, horizon, bottom) with a sun sphere:

    | Preset | Top / horizon / bottom | Sun |
    | --- | --- | --- |
    | soft | #ffffff / #e2e5ea / #7d8088 | #fff × 3 |
    | sunset | #28335e / #ff9452 / #2c2230 | #ffb36b × 14 |
    | dawn | #8db6e9 / #ffd8b2 / #62656e | × 8 |
    | night | #03050c / #141c34 / #010103 | #bcd0ff × 2.5 |
    | overcast | #c8cdd5 / #b0b5bd / #5d6168 | none |

- **Tone mapping:** AgX, ACES, Neutral or none. Exposure is 2^stops, and the output is three's default sRGB.
- **Camera:** fovY follows the sensor-fit rule. near = clipStart × 0.01 and far = clipEnd × 0.01. The lens shift goes into the projection matrix.
- **Post-processing,** run over a copy of the frame:
  1. GTAO.
  2. Bokeh, with maxblur 0.03 and aperture = f² / (N · (s − f) · s · sensor) in metres. Its shader is patched to keep alpha.
  3. Unreal bloom at 256². With `source: emission`, the scene is first re-rendered with each material reduced to its emission.
  4. A finish pass screens the glow over the image and lets the glow raise alpha, so a transparent world still glows.

  There is no vignette or grain here. Those come from the 2D effect stack.

  A7j (ours, 2026-10-28): every pass is our own shader (no `EffectComposer`, `UnrealBloomPass`, `GTAOPass` or `BokehShader`). The depth of field keeps the linear circle of confusion behind the focus plane and uses the thin lens's (× s/d) in front, so near things blur too; a nearer tap only counts as far as its own blur reaches (no halos round sharp edges). The bloom tail is dithered (a fixed per-pixel pattern) so 8-bit output shows no rings. AO is depth-based, not GTAO.
- **Floor:** a 2e5 plane at `floor.z`, in one of three modes:
  - `shadow`: a `ShadowMaterial`;
  - `solid`: a standard material, roughness 0.85;
  - `mirror`: the scene is rendered once more, mirrored in z with a clipping plane, behind a glossy floor at roughness 0.25 (no Reflector, no SSR).
- **Compositing.**
  - There is one shared `WebGLRenderer`: antialias, alpha, premultiplied, `preserveDrawingBuffer: false`, pixel ratio 1, cleared to transparent.
  - The 2D compositor calls `drawImage` on the GL canvas right after the render, in the same task.
  - The world renders at the comp's size × the current 2D scale, with an 8-frame cache.
  - A layer with 2D effects is rendered alone and drawn through the 2D effect path.
  - Export is deterministic, because everything derives from `evaluateWorld` at the frame's time.
  - Motion blur adds sub-frame renders into a half-float target. It takes one sample per 6 px of travel, from 2 to 24, within a time budget.
- **glTF.**
  - A bare `GLTFLoader.parseAsync`, with no Draco, KTX2 or meshopt decoders, so compressed files fail.
  - There is **no `AnimationMixer`**, so a file's animations are ignored. Only morph weights are driven, by keys.
  - Sizing:
    - glTF is scaled × 100 (1 m = 100 px), in a wrapper that turns Y-up into Z-up;
    - obj, fbx, stl and ply are fitted to a 200 px longest side, standing on z = 0.
  - `material.source: file` keeps the file's materials.
- **The 3D motion path** is an overlay in the orbit viewport only. It is never drawn through the camera and never exported.
  - It is a `THREE.Line` (opacity 0.85, no depth test) through the evaluated world positions:
    - ⌈s × 48⌉ samples, where s is the duration in seconds, clamped to 2…160;
    - plus every x, y and z key time.
  - Keys are drawn as 7 px points that do not scale with distance.
  - It is skipped when the path moves less than 0.5 px.
  - There are no handles in 3D.
  - The core's `objectMotionPath` samples at most 240 points, one every 33 ms.

**What we take.**
- The document model:
  - `world` on the comp and the spatial kinds;
  - the camera, light, material and extrude fields, with AtomCut's defaults and presets;
  - the key paths.
- The move-into mapping, the live camera pick, the default camera, and the command names and shapes.
- From the renderer:
  - the 0.01 scene scale;
  - unlit picture planes;
  - the light unit conversions;
  - the environment presets;
  - the post order;
  - the floor modes.
- Libraries: three.js (MIT) and its addons (MIT). Later, three-bvh-csg (MIT) for booleans.

**What we do differently.**
- **Pixel-exact pictures.** A plane's texture is drawn at the output scale, with its bounds snapped to whole output pixels. A world with no camera then gives the flat picture to within texture filtering. AtomCut supersamples at density 2 and lets mipmaps soften the picture. We check the move with a pixel diff against the flat render, not by eye.
- **The move into a world is proved in tests.** For random transforms, a plane's corners projected through our flat front camera must land where the same corners land through the world's default camera. When both `rotation` and `rotationY` are keyed, the conversion cannot be exact, so `world.move_into` lists those layers in its result (`approximate`).
- **glTF animations play.** An `AnimationMixer` is set to the layer's local time each frame (`mixer.setTime`), so it stays deterministic. Draco (decoder Apache-2.0, notice kept) and meshopt (MIT) files load.
- **The 3D motion path is also shown through the camera.** The sampled world positions are projected with the live camera and drawn in the 2D overlay look we already have (`motionPaths.ts`). The orbit viewport comes later.
- **three.js loads only when needed.** The world renderer is a separate engine module behind a dynamic import, so flat projects never load it.
- **Licences.**
  - three.js is MIT, and its notice goes in the licence file.
  - The Draco decoder is Apache-2.0. meshopt and three-bvh-csg are MIT.
  - Extruded text needs a font outline reader: opentype.js (MIT), or our own `glyf`/`CFF` reader next to `shared/fontFile.ts`. That chunk decides.
  - Nothing is GPL.

## The orbit viewport (step A7m research)

Sources: static reading of AtomCut 4.9.0's chunks `1859` (the orbit viewport), `8127` and `2961` (the world renderer), the keymap in `5009` and the `world.view` schema in `459`. The live 4.17 app was not launched for this step, so menu icons and the full Overlays popover are not known. Observed behaviour and constants only; no code was taken.

- **Entering.** AtomCut has no orbit toggle: the orbit viewport *is* its world editor, opened by double-clicking a world frame ("“name” is a 3D world — double-click it to open") or from the "3D worlds" list, and left with "Back to the canvas" (or Esc). Inside it, "Look through the camera" (`Numpad0` or `0`) shows the live camera; "Lock camera to view" appears only then.
- **Stored state.** `world.view` is optional on the world comp, written when the viewport closes: `target` [x, y, z], `distance`, `yaw`, `pitch`, `ortho` false, `shading` "solid", `xray` false, `gridSize` 100, `gridDivisions` 10 (1 to 100), `showGrid` true, `showOverlays` true. `motionPaths` and `overlays` (both on) are editor state. **Ours keeps all of it as editor state** (store `worldView` per comp), never in the document.
- **Camera.** Z up. Eye = target + distance · (sin yaw · cos pitch, −cos yaw · cos pitch, sin pitch). Vertical fov 30°. Near max(0.001, distance · 0.002) and far max(2000, distance · 200), in scene units (px × 0.01). Pitch clamped to ±90° (the up vector is adjusted past ±89.9°). Default target (0, 0, 0), distance 1500, yaw 35°, pitch 25°; with no saved view the first draw frames everything and doubles the distance. Framing: target = the bounds' centre, distance = max(10, diagonal / 2) / sin(min(fovY, fovX) / 2) × 1.08. The orbit view does not start from the live camera ("Camera to view" copies the orbit pose onto it).
- **Navigation** (immediate, no damping).
  - Orbit: middle-drag or Alt+left-drag; yaw −0.35° and pitch +0.35° per px.
  - Pan: Shift+middle-drag; the target moves 2 · distance · tan(fov / 2) / viewport height per px, so the scene follows the cursor.
  - Zoom: Ctrl+middle-drag, distance × exp(0.01 · dy). Mouse wheel: × 1.15 per notch (÷ on the way up), distance clamped to 1…1e7.
  - Trackpad (deltaMode 0 with deltaX ≠ 0, or a non-integer or small deltaY): plain scroll orbits at 0.6 × the delta, Shift pans, Ctrl (pinch) dollies by exp(0.01 · deltaY) toward the point under the cursor.
  - Keys (Blender keymap): `Numpad1/3/7` front, right, top (Ctrl: back, left, bottom; `Numpad9` the opposite), animated over 220 ms with smoothstep and switching to ortho; `Numpad5` perspective/ortho; `Numpad4/6/8/2` orbit 15°; `Numpad+`/`−` zoom × 1/1.2 and × 1.2; `Numpad.` frames the selection, `Home` frames all; `Z` a shading menu, Alt+Z X-ray.
  - A navigation gizmo (drag orbits 0.5°/px; a click snaps to the axis view) with "Drag to zoom" and "Drag to pan" buttons. Double-click opens the object's editor; right-click a context menu.
- **Shading.** Wireframe, Solid (default), Material preview, Rendered, plus X-ray.
  - Solid: the fill colour on a standard material (roughness 0.7, metalness 0), lit only by three's room environment at 0.9; scene lights, shadows, fog and post off; cleared to the theme's void colour.
  - Material preview: the real materials under the same room environment at 1.0; scene lights off; cleared to the comp background.
  - Rendered: scene lights, the world environment and background, shadows, fog, floor and post (bloom, AO), but no depth of field from the orbit view.
  - Wireframe: meshes hidden, dark wire overlays (`#1d1d1f`, 0.85). X-ray: meshes × 0.35 opacity, pictures × 0.5, no depth write (ignored in Rendered).
- **Grid.** A shader quad on z = 0: minor lines every `gridSize / gridDivisions` (10 px), major every `gridSize` (100 px). Major lines white at alpha 0.16 (the theme ink at 0.14 dark), minor × 0.55 and faded out before they alias. X axis `#ff3352`, Y axis `#8bdc00`, both at 0.75 (Z is `#2890ff`). It fades from 35 % to 100 % of max(2000, 12 · distance) from its centre. Hidden through the camera.
- **Gizmos** (lines, theme wire colour `#8a8a94`; selected `#ffaa40`, other selected `#f15800`).
  - Camera: a frustum from the eye to a rectangle 100 px out (half-width 100 · tan(fov / 2)), with an "up" triangle above it. A dashed ghost camera when the world has no camera clip.
  - Point light: three circles of radius 18. Sun: a circle of 18 with 8 rays and a 400 px line along its direction. Spot: a circle 150 out of radius 150 · tan(angle / 2) with 4 spokes to the apex. Area: a rectangle with a 120 px normal. Environment: three circles of 28.8. Hemisphere: a circle of 27 with six spokes.
  - Empties as cube, sphere, axes or arrows. Dashed aim lines from selected cameras to their lookAt target.
  - Pictures and text are their real textured planes.
- **Picking.** Meshes, models (child meshes), picture planes; a picture counts only where it has ink within 6 px (alpha above 24). Camera, light and empty gizmos are picked in screen space (16 px from the origin, or 10 px from a gizmo line) and win over geometry. Click selects one; Shift or Ctrl+click toggles; an empty click clears. A drag over 4 px grabs the object; from empty space it box-selects.
- **Selection look.** Closed meshes: a 1.5 px inverted-hull outline; open meshes: crease edges (30°); pictures: a ~2 px ring along their alpha; models: a box. `#ffaa40` for the last selected.
- **The 3D motion path.** A `THREE.Line` in the wire colour, opacity 0.85, transparent, no depth test, render order 4; key points as `THREE.Points` `#ffaa40`, size 7, no size attenuation, no depth test, render order 5. Selected layers only, with Overlays and Motion paths on, not through the camera. Samples ⌈span s × 48⌉ clamped to 2…160 from start to end − 1 ms, plus every x, y and z key time (each key time gets a point). Skipped when it moves less than 0.5 px. Rebuilt only when the document or selection changes.

**What we take.** The orbit maths and constants, the navigation (buttons, modifiers, wheel, the numpad keys with `0` for the camera), Solid / Material preview / Rendered, the grid, the gizmo shapes and colours, the picking rules and the 3D path look.

**What we do differently.** Our viewport keeps its 2D camera view and adds the orbit view as a toggle on the viewport (and `0`), since worlds are comps we already open. The orbit view is editor state only (store `worldView`), never saved in the project. A7m leaves out Wireframe, X-ray, ortho and animated preset views, the navigation gizmo, the ghost camera, box selection and move gizmos (phase E). Pictures get their plane outline when selected rather than an alpha ring.

## Timing visuals to speech (2026-10-29, for the Ship Happens hackathon)

**Sources.** The live skill 1.31.0 (`sound.md` "Voiceover", `lip-sync.md` "How it is heard", `media-and-generation.md`) and the 4.9.0 provider chunk `2045.7620b256e78040c0.js`.

**How AtomCut knows when each word is spoken.** It never predicts timing from the text. It gets timing after the audio exists, in this order (lip sync's "Auto"):

1. Its offline Test Voice: the synthesiser itself knows every phoneme, so timing is exact.
2. A TTS that returns timing: ElevenLabs is called at `/text-to-speech/<voice>/with-timestamps`; the response's `alignment.characters`, `character_start_times_seconds` and `character_end_times_seconds` are stored with the asset in ms.
3. A known script aligned to the audio: ElevenLabs `/forced-alignment` (form fields `file`, `text`) returns `words` with `start`/`end`. The skill says to always give the script: alignment ≈ 96 % against listening ≈ 37 %.
4. A word-timed transcription (`scribe_v2`), paid once per recording and cached.
5. Listening offline (`spectral`).

Gemini (`gemini-2.5-*-preview-tts`) and GPT (`gpt-4o-mini-tts`) TTS return audio only, so their clips go through 3 or 4.

**How the agent is told to build with it.** Write the script for the ear, generate the voice, caption it with `media_transcribe {captions}`, then time visuals to the words. "Never split one take to make a pause": timestamps are approximate (consonants start before the stamp). Each phrase that needs its own timing is generated as its own clip, with the neighbouring lines as context, and clips are placed whole. A forced cut goes inside a measured silence (20 ms RMS below −45 dBFS for at least 80 ms).

**Sarvam (checked 2026-10-29).** Bulbul TTS (REST) returns only `audios` (base64), with no timing; it has `pace` 0.5 to 2.0. Saaras STT REST takes up to 30 s and returns only `transcript`; the Batch API returns chunk-level (sentence or phrase) timestamps and says "Word-level timestamps are not supported". No forced-alignment endpoint. So with Sarvam, timing comes from per-phrase clips (exact boundaries, measured after generation) plus our own alignment inside a phrase.

**Sarvam, measured (S1a, 2026-10-30).** API facts as of today are in `docs/HANDOFF.md` ▸ "Plan of S1" (moved to `docs/handoff-archive.md` at the end of S1). STT `with_timestamps` still returns phrase chunks only. A Bulbul v3 take (`shubh`, `hi-IN`, 48 kHz asked) is mono 16-bit PCM WAV at 48 kHz; "बैटरी के तीस घंटे।" lasts 1.28 s with ~190 ms of silence before the voice and ~80 ms after (below −45 dBFS), so a take's speech span must be measured, not assumed to fill the file. Translate (`sarvam-translate:v1`) turned "Thirty hours of battery." into "बैटरी के तीस घंटे।" (word order changes, so on-screen words cannot be mapped one to one across languages: re-time from the new take's own words).

## Sound that feels finished: the mix, the packs and library search (step Q1 research, 2026-10-29)

**Sources.** Chunks 459 and 5009 of 4.9.0 (prettified; line numbers below are in those copies), chunk `8083.0a1370d1e6f5da1e.js` (`sounds.list`), the live app's Sound tab (CDP on port 9333; the app offered an update to 4.18.0, not installed), and the skill's `references/sound.md`. The live defaults matched the 4.9.0 code exactly.

### The mix

**Categories (buses).** Schema at 459:10917-10962: `{id, name, character: voice|music|sfx|ambience, color, volume 0..4 (1), muted, solo, audioEffects: [], ducking: [], targetLufs: −40..−6 | null, builtIn}`. Four built-in buses (459:10963-11020), which cannot be deleted:

| id | name | character ("Kind" in the UI) | colour | target when `targetLufs` is null |
| --- | --- | --- | --- | --- |
| `voice` | Dialogue | voice (shown "Speech") | #7aa2ff | −16 LUFS |
| `music` | Music | music | #c792ea | −20 LUFS |
| `sfx` | Effects | sfx | #ffb86c | −19 LUFS |
| `ambience` | Ambience | ambience | #5fd3a6 | −28 LUFS |

A custom bus defaults to character sfx, takes the next palette colour and has `builtIn: false`; deleting it strips its `soundBus` tags and duck rules (459:88855-88876).

**Duck rule.** `{id, enabled: true, under: {kind: "bus" | "clip", id}, depthDb 0..60 (12), attackMs 0..5000 (150), releaseMs 0..10000 (500)}`. New projects (459:44093-44111): music ducks under `voice` by 10 dB, 150 ms in, 500 ms out; no other bus ducks. A clip can carry its own `ducking[]`.

**The comp's `soundMix`.** `{volume 0..4 (1), leveler: {enabled: true, mode: "category" | "all" ("category"), strength 0..1 (0.8), tameLoud: true, liftQuiet: false, evenSpeech: true}, limiter: {enabled: true, ceilingDb −12..0 (−1)}}`. Projects migrated from before the mix get leveler and limiter off (459:110190-110200).

**Routing** (459:59527-59610, 72423). A clip's bus is `clip.soundBus ?? inherited`; a nested clip passes its own tag down, so the innermost tag wins. Fired cues (packs, text/layer/transition triggers) without a tag go to `sfx`; untagged media goes straight to master ("unrouted"). An unknown bus id counts as unrouted. Import tags by file name: voice/vo/narrat/speech/dialog, music/song/bgm/beat, ambien/atmos/rain, sfx/whoosh/click/hit/impact. Bus gain is `muted || (anySolo && !solo) ? 0 : volume`; with any solo, the unrouted input is silent too.

**Loudness measurement** (459:88318-88420). ITU BS.1770 K-weighting (high shelf near 1682 Hz, then a 38 Hz high-pass), mean square summed over channels, `L = −0.691 + 10·log10(energy)`, 100 ms blocks, 400 ms momentary window, floor −70.
- **Integrated** (voice, music, ambience buses): 400 ms windows every 100 ms, absolute gate −70, relative gate −10 LU, mean of the rest.
- **"Peak"** (sfx bus): the loudest 400 ms momentary loudness in the trimmed range, not a sample peak.
- Measured over the trimmed source range (a looping clip: the whole asset), plus the clip's own gain in dB. Runs on idle callbacks over the decoded asset; pack sounds measured on channel 0.

**Leveler trim** (459:88458-88471). Target: mode "all" (or an unrouted clip) is −18 LUFS; mode "category" is the bus's `targetLufs` or the table above. `dB = target − measured`, skipped when the leveler is off or measured is below −60; `tameLoud: false` clamps to ≥ 0, `liftQuiet: false` clamps to ≤ 0; then clamp to [−30, +12] and multiply by `strength`. The result is a per-segment gain.

**Rapid-fire cues** (459:88608-88650). Cues group by clip and sound (`clipId|assetId-or-pack`). `n` is the most cues inside any 400 ms window. Measured level is the sound's max momentary loudness `+ 20·log10(rms of cue volumes) + 10·log10(max(1, n))`; the target is the bus target, minus 7 dB when `n ≥ 2` (typing sits as texture under one-shots). Same trim rule as above, applied per cue.

**Ducking** (459:88473-88492, 88636). The sidechain is the activity of the `under` source: per clip, 100 ms blocks above −45 LUFS, merged across gaps up to 350 ms (looping or unanalysed clips count whole); each cue is an 80 ms range; the ducked bus never ducks itself; `kind: "clip"` matches the clip or any ancestor on its nest path. Envelope on 10 ms steps: each range starts `attackMs` early (this is the look-ahead), the state ramps linearly up over `attackMs` and down over `releaseMs`, gain `10^(−depthDb·u/20)`; several rules multiply.

**Signal path** (5009:3030-3145).
- Segment: `gain × leveler trim × crossfade × clip duck`, edge fades 4 ms in, 8 ms out in export.
- Bus: `input → its audioEffects chain → speech compressor (voice-character bus, leveler on and evenSpeech) → duck gain → fader → master`. The speech compressor: threshold −26 dB, knee 18, ratio 3, attack 12 ms, release 300 ms, then +4 dB makeup.
- Master: `fader (soundMix.volume) → limiter → out`. The limiter is a compressor at `ceilingDb − 1`, knee 0, ratio 20, attack 1 ms, release 80 ms, no look-ahead (so not a true brickwall).
- Preview uses Web Audio with `setTargetAtTime` (τ 20 ms) for faders and duck; export renders an OfflineAudioContext, the duck as a value curve from the 10 ms table, per-clip curves sampled every 20 ms (5009:101867-101930, 112150-112330).

**The live Sound tab of a frame** (no layer selected): LEVELER (switch; Level "By category" | "All"; Strength 80 %; Tame loud sounds on; Lift quiet sounds off; Even out speech on), MASTER (Level 100 %; Limiter switch; Ceiling −1 dB), CATEGORIES 4 (each row: colour dot, name, layer count, solo headphones, mute speaker; then "New category"). Opening a category: back arrow, name, colour swatch; CATEGORY (solo, mute, Level 100 %, Kind Speech | Music | Effects | Ambience, Target in LUFS); SOUND EFFECTS (the twelve audio effect cards and "Search sound effects…"); DUCKING (count; per rule: Under, Depth "−10.0 dB", Timing IN 150 ms / OUT 500 ms; "Another rule"); LAYERS (the layers routed there).

**What we have.** `packages/engine/src/audio.ts` sums every layer into one stereo mix and hard-clamps it (`limitMix`). No buses, routing, measurement, leveler, ducking, speech compressor, master volume or limiter ceiling.

### How the library is searched

- **`sounds_list` in 4.9.0** (`8083.0a1370d1e6f5da1e.js`, `sounds.list`; catalog at 459:87045) only filters a local catalog: synth packs, project `customSounds`, device sounds, project audio assets, each with `group` packs | project | device | library; match is `name` or `group` containing the whole query; first 80; `{id: "pack:<name>" | "asset:<id>", name, group, durationMs?}`. The live 4.17 tool description adds "the online library … searched by name and tag", which fits the library search below, but no 4.9.0 code ties the two.
- **Library search** (459:89560-89690). Lower-case the query; each `#word` is a required tag; the rest splits on spaces into terms. A pack is fetched only if every `#tag` is in its `tagCounts` and every term is a substring of one of its `terms`. An item needs every `#tag` among its tags, and every term must score, else it is dropped. Per term: name equals 100, name starts with 60, name contains 40, a tag equals 30, a tag contains 18, anywhere in name, tags and blurb 8; summed. Sort by score, then source (built-in, project, user, online), then name. No stemming, synonyms or limit; pack titles are not searched.
- **Against ours** (`renderer/src/library/soundLibrary.ts`): we match word starts and count hits, so several words act as OR; no weights, no `#tag`, 30 results. On the mirror, "click soft" gives AtomCut's rule one result (Soft Tap) against our 163.

### The synthesised packs against ours

**AtomCut's voice** (5009:6552-6660; randomness at 459:59507; text cue defaults volume 0.32, randomness 0.6 at 459:43145-43180). Each hit is one oscillator plus an optional noise burst, rendered live in Web Audio (the preview pre-renders each pack at 44.1 kHz mono, 5009:6805):
- Tone: frequency sweeps exponentially from `freq` to `endFreq` over `duration`; gain falls exponentially from `volume` to 1e-4 (−80 dB) over the same time, with no separate attack. Optional `toneLowpass`.
- Noise: one 50 ms white-noise buffer, made once per sample rate and reused for every hit, filtered (default high-pass 2 kHz) and gated by its own exponential decay.
- No takes and no normalisation: each pack's level is its own `volume`.
- Per hit, with `seed` in [0, 1): volume `× (1 − 0.65·randomness·seed)`, pitch `× (1 + 0.35·randomness·(frac(7919·seed) − 0.5))`. No timing jitter.

| Pack | AtomCut (tone; noise) | Ours (`packages/engine/src/soundSynth.ts`) |
| --- | --- | --- |
| mechanical | triangle 520→240 Hz, 30 ms, vol 0.32, low-pass 2.4 kHz; noise 0.9, band-pass 2.6 kHz Q 1.1, 16 ms | band-pass noise 3.2 kHz Q 1.2 (12 ms decay) plus a release click at 28 ms; sine 180→110 Hz; 90 ms |
| soft | sine 620→400 Hz, 50 ms, vol 0.4; noise 0.15, 30 ms | band-pass noise 1.4 kHz only, no tone; 70 ms |
| vintage | triangle 1000→500 Hz, 60 ms, vol 0.55; noise 0.5, 45 ms | band-pass noise 2.2 kHz Q 2.5, ring sine 1850 Hz, knock sine 130→90 Hz; 160 ms |
| thock | sine 220→90 Hz, 80 ms, vol 0.9; noise 0.25, 20 ms | band-pass noise 700 Hz, sine 110→70 Hz; 100 ms |
| digital | square 1800 Hz flat, 18 ms, vol 0.22, low-pass 3.2 kHz; no noise | tanh-saturated sine 1800→1500 Hz; 60 ms |
| pop | sine 320→900 Hz, 90 ms, vol 0.7; no noise | sine 420→950 Hz plus a 4 kHz tick; 110 ms |

Ours: four takes per pack, peak-normalised to 0.8; per hit pitch ±12 %, gain −25 %, timing ±12 ms, scaled by randomness.

**Rendered and measured** (scratch reimplementation of both; WAVs for listening in `~/Videos/UVE benchmarks/q1-typing-packs/`, single hits and 2 s bursts of 12 hits at volume 0.32, randomness 0.6). Single hit, ours / AtomCut:

| Pack | to −60 dB (ms) | peak (dBFS) | RMS (dBFS) | centroid (Hz) |
| --- | --- | --- | --- | --- |
| mechanical | 90 / 26 | −1.9 / −11.4 | −20.5 / −25.8 | 5600 / 2400 |
| soft | 70 / 41 | −1.9 / −7.6 | −16.7 / −22.2 | 5590 / 5760 |
| vintage | 160 / 47 | −1.9 / −3.3 | −19.7 / −20.4 | 4310 / 9120 |
| thock | 100 / 58 | −1.9 / −0.9 | −14.7 / −15.1 | 2590 / 2070 |
| digital | 60 / 17 | −1.9 / −13.1 | −11.1 / −25.8 | 3730 / 2350 |
| pop | 110 / 71 | −1.9 / −3.7 | −13.6 / −17.5 | 750 / 430 |

**What differs to the ear.**
1. Our hits are two to four times longer, and our buffers end while the tail is still near −39 dB (a faint click at the end).
2. Ours are all peak-normalised to the same level. AtomCut's mechanical and digital sit 10 to 20 dB under thock and pop, so a stream of typing stays quiet by design.
3. Our mechanical and digital are brighter and fuller; theirs are a thin tick (digital an 18 ms filtered square).
4. Their soft and vintage have a pitched body under the noise and a 0.2 ms attack; ours are slower noise bursts (3 to 5 ms).
5. They vary volume more (up to −39 % at 0.6) and never jitter timing; we jitter timing and vary gain less.

**Recorded typing in the mirror.** `opengameart-keyboard-soundpack-1-typing-and-single-keystrokes` (unicaegames, CC0, a Cherry KC 1000 keyboard) holds 32 single keypresses of 256 ms ("Keypress 1" to "Keypress 32"), 10 human and 7 generated typing runs. Also "Keys 1" to "Keys 7" (`opengameart-100-cc0-metal-and-wood-sfx`), "Type Tick" (`motion-essentials`) and "Thock" (`ui-clicks`). No typewriter strikes; a 2026-10-29 web search found no CC0 typewriter or mechanical-switch single-strike set with a clear licence (eklee's "Single key press sounds" on OpenGameArt is labelled CC-BY 3.0).

**After Q3 (2026-10-29).** Our six packs now render AtomCut's recipes: single hits within 1 dB peak with the same RMS and −60 dB length; 2 s bursts within 1 dB; search follows AtomCut's rule ("click soft" gives Soft Tap only). Plus a recorded `keys` pack from the 32 keypresses above. Numbers in `docs/HISTORY.md` ▸ Q3.

### Why the Q9 launch film's effects sounded cheap (Q10a, 2026-10-30)

Listening material: `~/Videos/UVE benchmarks/q10-sound/beats/`, 16 matched beats, 6 s each, AtomCut's film then ours (`NN-name.AB.wav`, and each side alone).

**What the four agents searched and picked** (`q9-launch/*.agent.jsonl`, `.uve`). Queries were good single words (`whoosh`, `pop`, `water drop`, `drop`, `thud`, `click`, `zap`, `thunder`, `bell`, `chime`…); the picks went wrong after the search:

- *Act 2 rain:* "Water Drop 2" (a real foley drip from the fantasy "tinysized" pack) placed as nine clips of the same file at volume 1: the same sample nine times is a machine gun.
- *Act 3 drops on the letters:* Kenney Interface Sounds "Drop 1–3", which are UI drag-and-drop release clicks, not water: `drop` matched the name. Four "Impact Soft" clips for letters landing, two whooshes and a pop, clip volumes 0.35 to 0.8.
- *Act 4:* "Zap1" (Kenney Digital Audio, a game laser) for the lightning, a Kenney "Impact Soft Heavy", nine "Pop" clips at 0.55 to 0.9 (AtomCut's skill says UI sounds 0.15–0.35).
- *Act 1:* a pop at `pitch: 1.35` (a recorded pop sped up 35 %) and a "Water Drop 1".
- The search showed only ~100 sounds with a `use` note; most results were names alone, and the first hit for a word is whatever name equals it, from any pack.

**The library** (4,555 sounds, 91 packs; every file measured 2026-10-30: attack, tail, centroid, roll-off, bandwidth). Only 38 sounds are AtomCut's own motion packs (`motion-essentials`, `ui-clicks`, `impacts-risers`). About 1,100 are chiptune or 8/16-bit game packs (`512-sound-effects-8-bit-style`, `sfx-the-ultimate-2017-8-bit` and `16-bit`, the NES packs, `sound-effects-pack-2`, `mini-pack15`, `8-bit-jump`, coins, `retro-synth`), about 500 are voices, grunts and creatures, and several hundred are game-designed (fantasy, RPG, sci-fi lasers, jingles). Bandwidth does not separate chiptune (square waves fill the spectrum); several packs are band-limited (Kenney Impact ≈ 10 kHz, Kenney Digital ≈ 15 kHz, `interface-beeps` ≈ 3 kHz).

**AtomCut's skill** (package 3.6.0, skill 2.22.0) says little about choosing: synth packs first for clicks and pops, then the library by a plain word, `generate_sound` last (with a physical prompt: source, material, size, distance, room, attack, tail); one family per piece; silence; whooshes lead the cut; impacts on contact; risers end on the downbeat; pitch down for heavy things. No avoid-list, no per-event mapping. Its films sound finished because its own motion packs and generated sounds carry them, not because its search ranks well.

**The causes, in order:** (1) ranking with no sense of quality or of what a name means (a UI "drop" outranks a water drip; chiptune ranks with foley); (2) too few usage notes for the families motion needs; (3) no vocabulary in the skill per event; (4) clip volumes far above the 0.15–0.35 rule, and one file repeated with no variation; (5) pitch moved far on a recorded file. In the mix, ours sits at the limiter's −1.5 dBTP mark in 12 of 16 beats (AtomCut's peaks vary from −0.3 to −2.8): loud hits are clamped (checked in Q10d).

## Stickers, images and background removal (Q5, 2026-10-29)

**Sources.** Tool schemas of the `atomcut` MCP server (read, not called; the server instructions say live skill version may be newer) and the skill docs shipped in `@atomcut/mcp` 3.6.0 (`skill/skills/atomcut`, skill version 2.22.0: `SKILL.md`, `references/media-and-generation.md`, `effects.md`, `physics.md`, `recipes.md`, `motion.md`, `sound.md`, `review.md`, `fills-strokes-vectors.md`). The resource tool was not available in this session, so the docs came from the npm package.

**What AtomCut does NOT have**
- No sticker, emoji or illustration catalog. `catalog_list` kinds are only: `layer-effects`, `text-effects`, `audio-effects`, `animations`, `text-templates`, `transitions`, `easings`, `blend-modes`, `primitives`, `modifiers`, `materials`, `lights`, `forces`. Input is `{catalog, query?}`; no paging, no tags field. `catalog_get {catalog, id}` returns one entry.
- Stickers are meant to be made: `generate_image {prompt, aspect, count, place?, transparent: true}` ("transparent for stickers and cut-out objects"). Icons come from the Library's Icons plugin (Iconify mirror); the skill only says "for real icons ask the user or use the Library", and to draw simple marks from primitives or SVG `path` layers.
- The skill never mentions emoji at all. Sticker use appears only in motion (`pop-in` is the pairing for "badges/stickers"), in physics (sticker rain) and in effects (`boil` makes a drawing, logo or sticker feel alive; `roughenEdges` for paper looks).

**From an item to a layer**
- Media library first: `media_import {localPath | attachmentId | url, name?, folder?, place?}` (give exactly one source; `localPath` up to 48 MB, read by the bridge; folders such as Footage, Music, SFX, Logos; check `media_list` before importing twice). `place` is `{startMs?, durationMs?, x?, y?, above?, frameId?}`; omitted means library only.
- `media_list {kind?: image|video|audio|svg|any (default any), query?}` returns assets with kind, size, duration, folder; `query` is a case-insensitive name filter.
- `layer_create {kind: "media", assetId, startMs?, durationMs?, x?, y?, name?, frameId?, placement?: {above|below|groupId}, set?: {path: value}}`. Image and video both use `kind: "media"`; there is no separate sticker kind. `set` applies property paths (opacity, rotation, scale) in the same call. Default lands on top of what plays at that time, reusing a free lane.
- Cropped media: `transform` moves the window, `content.*` pans and zooms the picture inside it.
- Entrance motion: `animation_set {id, slot: "in"|"out", preset}` with `pop-in` for stickers; "pop, sticker, badge" take `ease-out-back` (overshoot once, because it means something). Any visual layer animates as a whole (`target: "layer"`).
- Sound on entrance: put it on the layer's own `sounds` stack (pack `pop` is the "best general choice"; or `custom: {assetId, hitMs}`), not as a loose clip; align `hitMs`, the file's transient, to the frame of impact. Sounds per element, not per letter.

**`media_remove_background`**
- Input: `{id (required: image/video layer, asset or attachment), model?: string (a model id instead of the routed default), replace?: boolean (default true), place?: {startMs?, durationMs?, x?, y?, above?, frameId?}}`.
- Does: cuts the subject out; image becomes a PNG with alpha, video a WebM with alpha. "A layer updates in place; the original stays in Media" (so per layer when given a layer, per asset when given an asset; the result is a new asset, and with `replace: true` the layer swaps to it, transform, timing, effects and keys kept). With an asset id and no `place` it only adds the result to Media; `place` also puts it on the timeline. The original is never destroyed (edits point back via `parentAssetId`).
- It is an AI job on whichever connection the user routed; with none connected it fails with a hint, and the skill says to tell the user, not work around it.
- Cheaper alternative: the live `chromaKey` effect for a FLAT backdrop (green screen, studio white); `media_remove_background` for a real-world background. Companion `media_upscale {id, factor: 2}` before punching in on small images.
- Everything AI-made lands in the Media folder "AI generated" with provider, model and prompt on the asset.

**Craft and checks**
- Prompt images like an art director (subject, composition and empty space for type, light, palette, style, mood); say "no text" when type is set in AtomCut. One version unless asked; check a still with `view_render` before animating or generating more; never loop regenerating.
- Match `aspect` to the destination; for a sticker, ask for an isolated subject on transparent ground (or cut out afterwards).
- Physics: a picture collides on its silhouette ("a sticker lands on its edge"); `shape` overrides `hull` (fast) or `outline` (exact). Sticker rain recipe: about 20 transparent PNGs above the frame, small random `spin` (plus or minus 90) and `velocity` x (plus or minus 150), `walls: true`, a wind gust keyed on a beat.
- Review checklist (generic, no sticker-specific item): nothing outside title-safe or under platform UI; one focal point; nothing pops at the first or last frame of a layer; order of arrival deliberate with 30 to 80 ms stagger; `keyframes_inspect {}` shows no baked tracks; exits quicker than entrances. Check the resting frame, not frame 0, and use `view_frames` with `times` around a landing.
- No guidance anywhere on sticker sizes or on style consistency across a set, beyond `references` in `generate_image` (a style or subject to keep consistent).

## Physics (Q6, 2026-10-29)

Sources: the skill 2.31 (`references/physics.md`, the "Falling title" and "Sticker rain" recipes), the five tool schemas, and REA on the 4.9.0 chunk 459 (prettified in a session scratchpad) where the docs say nothing. Everything below is data, in our words.

**What the user sees.**
- Any layer can be a body: `active` (falls, collides, tumbles), `passive` (fixed collider), `animated` (moves by its keys and pushes). A group is one body. Hidden layers are not in the simulation; an invisible collider is a body at opacity 0.
- A body lives on the timeline: it enters at its clip's start (where its keys put it then, with the speed its keys had) and leaves at its clip's end; what rested on it falls.
- Before the comp's `startMs` bodies sit where their keys put them; from then on the simulation owns them. `velocity` (units/s, +y down in a flat comp) and `spin` (deg/s, z clockwise) push on top of the keyed motion.
- Shapes: `auto` (rectangle and picture as boxes in the tool text, but the reference says a picture collides on its silhouette and a star, path or word on its real outline cut into convex pieces), `box`, `sphere`, `hull` (convex outline), `outline` (exact, convex pieces).
- `follow` 0..1 pulls an active body back to its own animation (0 free, 0.2 jiggle, 1 stiff).
- Forces are a stack on any layer (like effects): wind (blows along the layer's +X), point (attract, negative repels), vortex, turbulence, drag (% of speed lost per second). `strength` is an acceleration (gravity 981); `radius` limits reach (0 everywhere), `falloff` none, linear or smooth. Fields key at `force.<forceId>.<field>`; cards edited through `effects_update {id, effectId: forceId}`. A gust is two keys on strength.
- Joints: pin (hinge), weld, rope (slack until taut), spring (stiffness, damping, length). Anchors in each body's own px; a null target is the comp.
- Comp settings: gravity, startMs, floor (a flat comp's bottom edge, or `floorAt`), walls (left, right and top edges), timeScale (slow motion).
- Inspector: a Physics tab with Body (Off / Falls / Collider / Pushes), Joints and Simulation sections; the context menu has a Physics submenu ("Make it fall", "Make it a collider", "Pushes — moves by its keys", "No physics").
- **No baking**: the simulation is exact per frame, re-run only when what it starts from changes; scrubbed, looped or exported frames read the same result.

**Defaults (4.9.0 schema).** Body: type active, mass 1, bounce 0.3, friction 0.5, shape auto, velocity and spin [0, 0, 0], damping 0.01, follow 0. Force: type wind, strength 600, radius 0, falloff smooth, scale 240 (turbulence cell, px), seed 0, enabled true. Joint: type pin, target null, anchor [0, 0, 0], targetAnchor null (where the anchor is at the start), stiffness 40, damping 2, length null (the distance at the start), enabled true. Scene: gravity 981, startMs 0, floor true, floorAt null, walls false, timeScale 0.05 to 4, default 1.

**How 4.9.0 does it (REA).**
- Engine: cannon-es (a 3D engine) for flat comps and worlds alike. Flat bodies are locked to the plane (moves in x, y, turns about z only). Units scaled 0.01 (1 px = 1 cm, so metres inside the engine).
- Fixed step 120 Hz, at most 14,400 steps (120 s). Solver 12 iterations, sleeping off, a sweep-and-prune broadphase above 12 bodies. A frame at comp time t reads step round((t − startMs) / 1000 × timeScale × 120).
- The simulation is built once per input key and kept in a small cache (4 entries); its steps are stored as they are computed, so scrubbing back reads stored steps and only new frames step further.
- Bodies get their colliders from the scene built at the physics start with physics off (the same code that draws). Flat outlines become convex prisms (each convex piece extruded by a depth); a polyline is simplified (Douglas–Peucker, at most 64 points) and cut into convex pieces by its own decomposition. An active body that starts straddling a floor or wall is pushed out along its normal before the first step.
- Animated bodies are kinematic, moved each step to the pose their keys give at the next step. `follow` is a spring-damper force and torque toward the keyed pose. Joints: pin as a point-to-point constraint, weld as a lock, spring and rope as springs (rope only pulls when stretched past its length); spring stiffness and damping scale with the two bodies' mean mass.

**Our choices (Q6).**
- Engine: **planck.js 1.5.1** (MIT, a pure-JS port of Box2D, no dependencies, published 2026-10-12). Box2D stacks piles of pictures far better than a 3D engine locked to a plane; it runs in plain JS (no WASM to initialise, no GPU, so it runs the same on Intel UHD), and the same calls in the same order give the same numbers, so preview and export agree. Rapier was set aside (WASM start-up is async and its 2D and 3D builds are separate packages); cannon-es (AtomCut's) because 2D stacking jitters. Physics in 3D worlds is deferred.
- Like AtomCut, no baking by default: the simulation runs from the document (120 Hz fixed steps, cached by its inputs, stepped lazily) and the scene reads each body's pose at the frame's time. We add `physics_bake` to turn the result into keys (simplified, not one per frame) for people who want to hand-edit it.
- A picture's silhouette is traced from its alpha once and kept on the media item, so the simulation never depends on whether a picture has loaded yet.

## Characters (Q7, 2026-10-29)

Sources: AtomCut's skill references (`characters.md`, `rigging.md`, `poses.md`, `behaviors.md`), the input shapes of `character_detect`, `character_bringToLife`, `rig_create`, `rig_bone`, `rig_pose`, `rig_bind`, `behaviors_*` (read as schemas, never called), and REA on the 4.9.0 bundle (chunk 459: behaviour definitions and runtime, detection, bring-to-life, rig binding; chunk 8751: the offline listener). Numbers below are data; the code we write is our own.

**The model.** A character is a group. Its parts are layers under it. A *switch* is a group that shows one member at a time (eye states, mouth shapes); its choice is a discrete keyable value. A *rig* is a group with bones (head and tail in the group's space, a parent chain, controls with `deform: false`, limits per channel, IK reaching for a control bone). A bone's pose is a change from rest on keyable channels `bone.<id>.rotation|x|y|scale`. *Pose sets* (named states made of values on any paths) sit on top; *behaviours* are a stack on the character that drive pose sets or channels live, writing no keys (later ones win; your keys show where none acts). 4.9.0 already builds the behaviour stack; the newer skill text still speaks of a `blink(4)` expression and two wave modulators, and 4.9.0 carries a migration that turns those into behaviours with the same numbers.

**How art follows bones.** Every member of a rig follows automatically. A bone *passes through* a layer when at least max(25 % of its length, 2 grid cells) of it lies inside the layer's box (grid cell = 1/40 of the layer's larger side). One passing bone: the layer *rides* it whole (crisp). Two or more: the layer *bends* with smooth weights (grid diffusion over the nearest bones, joints softened by the rig's blend 0.35, top four bones kept). None: it rides the bone whose tip lies inside it, else the parent of a bone that only starts in it, else the nearest bone. Groups never bend: a switch, a sub-rig or a head group rides one bone whole.

**Behaviours, per frame (all pure functions of time and a seed, so replays match).**
- *Blink:* period 4 s, shut 120 ms, unevenness 40 %, doubles 17 %. The first blink falls 30 to 100 % into the first period; each next gap is uniform in period × [0.6, 1.4] with a floor of 3.5 × the shut time; a double starts 2.2 × the shut time after the first. With a Half pose, the first quarter and last fifth of a shut show Half. One behaviour drives both eyes, so they shut together. The seed hashes the clip, the behaviour and its seed field.
- *Breathe:* a raised cosine 0.5 − 0.5·cos(2π·(rate/60·t + phase)), starting exhaled; bring-to-life uses 1.2 % at 16 breaths a minute on a torso bone's stretch, else the torso layer's (or whole character's) scaleY, with the bottom edge held still.
- *Sway:* three octaves of 1-D value noise (weights 0.57, 0.29, 0.14; frequencies ×1, ×2.03, ×4.01) at 0.25 Hz, ±2° by default.
- *Nod:* loudness (0..1) × 1.5° on the head (or neck) bone, else the head group; nothing when silent; only with a voice.
- *Glance:* a new look every hold × [0.5, 1.5] (hold 1.6 s), 40 % of them back to centre, otherwise ±24 px across and ±10 px down; each move eases out (cubic) over 90 ms. The seed leaves out the behaviour id, so two eyes with one seed look together.
- *Loudness:* RMS in 20 ms windows every 10 ms, normalised to the 98th percentile, mapped −42 dB → 0 to 0 dB → 1, smoothed with a 12 ms attack and 70 ms release, read with linear interpolation.
- *Lip sync without a transcript:* a spectral listener (bands, zero crossings, two formant centroids) picks visemes `X MBP S E AI O U FV L`; then a gate (quiet cues show rest), short rests bridged, rounding ahead of O and U, a minimum hold (drawings max(60 ms, 2 frames)), and a lead (drawings start 60 ms early). The mouth for a drawing set snaps to the frame grid.

**Detection.** Names are normalised (accents dropped, camelCase split, copy markers ignored) and matched as whole words against word lists per role in about twenty languages, plus the side words (`L` is the character's left, the screen's right). Evidence scores combine: name 0.9, a plural parent 0.7, a viseme tag 0.85, a switch whose members are visemes 0.88, eye-state or hand-pose switches 0.75, geometry 0.4 to 0.5; candidates under 0.3 are dropped. Geometry (flat comps): a *pair* is two non-nested pieces of similar size (ratios 0.6 to 1.67) at about one height, apart by at least 0.6 of their width; the head is the piece holding a pair high in it; eyes are a pair inside the head above its centre (a pair inside them is pupils); brows a wide pair just above the eyes; the mouth the lowest single piece near the eye midline below the eyes; the torso the largest piece below the head.

**Bring to life (one undo step).** Order: make the group (and rig) if needed; talk (mouth set from a switch of visemes, lip sync hearing whichever voice plays); eyes (an eye switch with Open/Closed, else a lid's opacity, else the eye squashed to 0.1 of its height) and one blink; brows and hands from switches; breathe; nod (only with talk; refuses with "Group the head with its face to nod" when the head is not a group); look (off by default: pupil pads and a Look control). It reports what it could not do ("No eyes found", "No mouth found"); a second run plans nothing; turning a behaviour off removes what it added; `dryRun` returns the plan as a script.

**Our choices (Q7).** The smallest set that brings a sticker or an Open Peeps person to life: switches, rigs whose pieces ride bones whole (FK, two-bone IK, limits), a behaviour stack computed per frame from the document (blink, breathe, sway, nod, glance, talk), a loudness envelope stored on the voice's media item (like Q6's silhouettes, so frames never depend on audio decoding), and the two character verbs. Talk maps loudness to mouth shapes rather than running a spectral listener (the mouth set is ours: rest, small, medium, wide, round), keeping AtomCut's gate, hold and lead. Open Peeps faces are one ink path, so bring-to-life splits it into its outlines and finds the eyes and mouth by the geometry rules above. Later: bending art with weights, pose sets, constraints, mirroring, cycles and state machines, transcript lip sync, overrides, physics on rigged pieces, rigs in worlds.

## Scripts (Q8, 2026-10-29)

Sources: AtomCut skill 2.31.0 (`SKILL.md`, `references/scripting.md`, `references/code-bridge.md`), the input schemas of the eight `script_*` tools, and the 4.9.0 chunk `4399.8757f9ad691cccd6.js` (script host and worker; read as data, nothing copied).

**What a script is.** JavaScript run against the open project, from a Scripts panel or by an agent. It speaks the same verbs as the tools: tool `layer_create` is `await ac.layer.create({...})`, same input, same result. The file is the body of an async function (top-level `await`, `return value` shows in Output). Globals: `ac`, `here` and `console`; no DOM, no `import`. `ac.help()` lists namespaces, `ac.help("layer")` the verbs, `ac.help("layer.create")` one verb's input shape. A failed call throws `CommandError: layer.create: …` with a hint; the run stops at that line unless the script catches it. `console.log` lines carry the script line that logged them. Unawaited calls still run but are flagged.

**`here`.** The comp the person was on when they pressed Run (`{frameId, name, width, height, fps, durationMs}`), frozen for the whole run; every call without `frameId` lands in it. The skill tells agents to size and time from `here`, never hard-code a comp id.

**Tool shapes.**
- `script_run {code? | script? (saved path or id), frameId?, timeoutMs? (1,000 to 3,600,000; default 300,000, 900,000 in the background), background?}`: returns logs, the returned value, errors with line numbers and what changed; `background` returns `{runId}` at once.
- `script_save {path ("intro/title.js", .js added), source, onRun: replace (default) | append}`; `script_list {}` (path, id, size, run mode); `script_read {script}` (path, file name or id).
- `script_runs {}` (one line per live or just-finished run: id, file, status, age, calls made, what it awaits, last log); `script_logs {runId, since?, tail? (default 20, max 200)}` with a `next` cursor; `script_stop {runId}` (running or queued; "what it already made stays and is listed").
- `script_reify {layers? | comp? | machine?, save?}`: prints layers, a comp or a state machine as the `ac.*` script that rebuilds it, measured on a copy (`exact`, `warnings`); with `save` the script owns those layers, so its first replace run swaps the originals for the rebuild in place.

**Replace and append.** A saved script records what its last run created (layer and comp ids). In replace mode (default) a run first removes that output, so edit and re-run rebuilds and never stacks; append adds every time. `script_run {code}` and the console own nothing. The skill's rule follows: a script is the whole recipe for its output, sets values rather than incrementing them.

**How 4.9.0 runs it.** In a dedicated Web Worker made from a blob URL (named "atomcut-scripts"). The worker builds the guest function with the AsyncFunction constructor over `(ac, console, here)`; `ac` is built from the registry's list of script-callable commands (a tree split on the dots, plus `ac.call(id, input)` and `ac.help`). Each verb call is a message to the page, which runs the registry command and posts the result back. Runs queue one at a time. Every call of one run shares one history key (`script:<runId>`) and the label "Run <file>", so the run is one undo step. `script.run` and `api.batch` are not callable inside a script ("a script is already a batch"). Stop terminates the worker; the run is marked stopped. Errors carry the guest line, found by offsetting the worker's stack line by a probe of the wrapper's own line count. Logs are batched to the panel per animation frame. A failed or stopped run keeps what it made (`leftBehind`) and `history_undo` takes the run back; the skill's docs also say standard JS including `fetch` is available.

**Our choices (differences on purpose).**
- **Sandbox:** QuickJS (compiled to WebAssembly, `quickjs-emscripten`, MIT) instead of a worker: the guest gets only `ac`, `here` and `console` and plain JavaScript, no `fetch`, timers, files or processes; it runs in `packages/core` (so tests and every host share it); an interrupt handler enforces the time limit inside tight loops; a memory and stack limit stop runaway allocation.
- **No trace on failure:** a run is one `script.run` command inside one transaction; a failed, timed-out or stopped run is rolled back whole (AtomCut keeps the left-behind work).
- **Deterministic:** `Math.random` is seeded per run (`seed`, default fixed) and `Date` is frozen, so the same script on the same document writes the same document (ids aside).
- **Foreground only for now:** the run holds the editor's command queue while it runs (default limit 30 s, up to 5 min); `script_runs`, `script_logs` and `script_stop` answer outside the queue so a run can be watched and stopped. Background runs, `script_reify` and owning reified layers are later.

## Craft (Q9, 2026-10-29)

Read as data from AtomCut's skill (`atomcut://skill/references/storytelling-and-hooks.md`, `review.md`, `recipes.md`, skill 2.28); summarised here in our words, no text copied.

**Storytelling and hooks.** Teaches the story before the layers: who watches and what they feel now, the one thing they should feel or do at the end, a true detail only the author has (ask for one, never invent it), and the turn (the unexpected reveal). A beat sheet, one line per beat (seen, heard, felt, hand-over), beats linked by cause ("but", "so") rather than sequence. Shape: hook in the first 3 s with picture, voice and text on one idea, frame 0 already moving; a promise by 5 s; something given every few seconds; open loops whose object stays on screen; a turn; a close that pays the loop off (a Short's last frame flows into its first); visible progress. A table of twenty hook kinds, each with how to build it in AtomCut. Plain words; a ban list of machine-sounding phrases; every claim true. Voice: one clip per scene with neighbouring lines as context, no whispers, splice in word gaps, transcribe and diff against the script, the author's lines untouched. Captions 1 to 4 words, absent in silences. Sound: one real sound per thing with mass, silence before the big line, music arranged to the acts. The brand as a quiet beat (no zoom punch onto a logo). Packaging (title, thumbnail). Five tests: mute, blind (sound only), thumb (any random second), truth, cut once more.

**Review.** The same look table as ours plus a file section (export, loudness target), and a checklist with lines we lack: type measured, not guessed (pills fit their words with equal padding, labels optically centred, equal ink-to-ink gaps, checked at `inspect` on the first and the most crowded frame); contrast checked at the exact frames a text crosses a new ground; keys a person can edit (no baked tracks); no dead frames (a frame sweep, not a few stills: no blank or blinking frames, nested comps not outliving their source); an Edit section (cuts on sentence or action boundaries, no dead air, the hook first).

**Recipes.** Short worked builds in units of the short side (`U` = short side / 100): title card, lower third, social captions, lyric stack, kinetic type, logo reveal, path morph, 15 s product promo (hook 0 to 1.5 s, three 3 s feature beats, offer, end card), reel from a long video, falling title and sticker rain (physics), blinking mascot and waving arm (characters). Each names its presets, timings and sound.

**What our skill 0.21.0 lacks.** No storytelling reference at all (the loop starts at layout); review has no story tests, no type measuring, no frame sweep, no Edit section; no recipes reference (brief files hold some recipes, the skill does not); the "scene in one run" script recipe exists but no recipe is written as one. Our tools cover every recipe except: transcription (`media_transcribe`, `media_remove_pauses`), speech generation, expressions (`expression_set`; our blink is a behaviour instead). Q9b and Q9c write `storytelling.md`, a new `review.md` and `recipes.md` for our tools.
