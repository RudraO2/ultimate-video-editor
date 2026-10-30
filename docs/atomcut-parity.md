# AtomCut parity: every agent tool, and the editor feature behind it

Date: 2026-10-24.

**Goal.** Our MCP server must offer every tool that AtomCut's MCP server offers. Each tool is only a thin caller of an editor command, so **the editor itself needs every feature behind those tools**, usable by hand as well. This file is the checklist for that.

**Sources.**
- The tool list comes from AtomCut's own MCP server, registered in Claude Code as `atomcut`: about 190 tools, from `@atomcut/mcp` 3.6.0 with the live app 4.17.0.
- Tool behaviour is described in its skill docs (`atomcut://skill/SKILL.md` and `atomcut://skill/references/*.md`). Read them as MCP resources before building each group.
- The library presets are extracted as data into `packages/core/src/looks.json`: 103 text looks, 44 animations and 23 transitions.

**The bar (set by the owner, 2026-10-24).** Parity means more than a tool with the right name:
- **Every AtomCut feature, robust.** Each one works by hand and as a command, handles bad input with a clear error and a hint, survives undo and redo, and has tests. No half-features: a tool is exposed only when the feature behind it is complete.
- **Every MCP tool works properly.** Same name, the same inputs accepted (AtomCut's shapes as well as ours), results that tell the agent what happened, and no silent drops.
- **AtomCut-level videos.** An agent given the same brief makes a video as good as AtomCut's: type, layout, motion, effects, sound and pacing. This is checked against benchmark briefs (AtomCut's skill recipes: title card, lower third, kinetic type, lyric captions, reel, promo, logo reveal) by rendering both and comparing them.
- **All the assets.** Everything AtomCut ships or serves (section 9), with the owner's reported permission, attributed, stored in the project and usable offline.
- **The foundation first.** Gaps in what exists today (section 0) are fixed before new tool groups are added.

**Rules.**
- Same names in our style. AtomCut's `layer_set` is our `layer.set` command, exposed to MCP as `layer_set`. One undo step per agent turn.
- **Every tool needs:** a command in `packages/core`, a UI that does the same by hand, a test, and a check in the running app.
- AtomCut's `track_*` tools are **motion tracking**, not timeline lanes. Our lane commands are `track.create`, `track.update` and so on. The MCP names for motion tracking will be `motion_track_*`, so they don't clash.

**Exposed over MCP (A6, 2026-10-24).** Every command in the registry is a tool, so each feature step that adds a command also adds its tool. Input shapes are ours (see `api_describe`); where AtomCut's differ (`keyframes_set` takes `property` and `{at, value, easing}` there), accepting AtomCut's shape too is a follow-up.

**Status key.**
- **have**: the command exists.
- **partial**: some of it exists.
- **todo**: not started.

The "Step" column is the planned step (see `docs/PLAN.md`).

## 0. Foundation gaps (fix first)

Found at the end of A6 (2026-10-24). Each of these blocks "script in, finished video out" or AtomCut-level quality:

| Gap | Why it matters | Status |
| --- | --- | --- |
| Project save and open | A reload loses the project; nothing is written to disk | done (A6b.1): `.uve` files, Main menu ▸ File, Ctrl+S/O/N, recent projects, close warning; `project_save`, `project_open`, `project_new` tools |
| Export as a command and tool (`export_video`) | An agent cannot finish a video; only the Export button writes the MP4 | done (A6b.2): `export_video {compId?, path?, overwrite?}`, progress in the export dialog, user can cancel; the working range limits it (A10.7); `format` takes AtomCut's export ids (A10.8a); MP4, WebM (VP9/VP8 + Opus) and audio (WAV) are written, with AtomCut's options `quality`, `videoBitrate`, `audioBitrate`, `scale`, `fps`, `includeAudio`, `motionBlur`, `range` (A10.8b); the lossless MOV master (PNG frames + 16-bit PCM, our own muxer) and `transparent` for MOV and WebM (A10.8c); GIF (our own writer: a palette per frame, loops forever, transparency under half alpha with dispose 2, delays in hundredths that add up exactly, at most 50 fps), PNG sequence (a folder `<name>-png-seq/frame-NN.png`) and stills (`png`, `jpg`, `webp` at `atMs`; `png` is the default for a static frame), `transparent` for all but MP4, audio and JPG (A10.8d); by hand, the export settings dialog before the save dialog (Ctrl+E, the rail's Export button, Main menu ▸ Export…), modelled on AtomCut's: Image / Video, format, Full / Working range, resolution and scale presets, frame rate presets, sound, transparent, motion blur, a still's time, Advanced quality and audio bitrate, refusals shown before any file opens, a folder dialog for PNG sequences (A10.8e). Not yet: Lottie, PDF, SVG, a selected layer's export, Level sound |
| AtomCut's input shapes | `keyframes_set` takes `property` and `{at, value, easing}` there; `layer_set` takes `ids` and `mode`; comps are `frameId` | done (A6b.3): those, plus `cubic-bezier()` and `{kind}` easings, AtomCut's 8 easing curves, `position: [x, y]`, `layer_create` `kind: media` + `assetId`, top-level `x`, `y`, shape fields and `set`, `keyframes_clear` `properties` + freeze at `atMs`, `openFrameId`; defaults to the playhead and open comp. Refused with a reason at the time: `arc`/`in`/`out`, `range`, polygon/star, `template`; all four are accepted now (`range` A8.5, polygon/star A8.4, `template` A10.2, `arc`/`in`/`out` on position A10.9c; the whole motion-path feature A10.9). |
| `keyframes_inspect` | Agents cannot read keys cheaply or find baked tracks | done (A6b.3); a curved motion key prints `↷(out dx,dy in dx,dy)` after its x value, and the comp audit counts `curvedKeys` (A10.9c) |
| Layer kinds | No path, group, nested comp, adjustment, raster or waveform layers; shapes are only rectangles and ellipses | partial: groups with auto layout and modes (A8.3, A8.4), path layers with morphs, polygon and star (A8.4), nested comps (A8.6); adjustment, raster and waveform still todo |
| Paints and strokes | One flat fill per shape; no gradients, multiple fills, stroke alignment, dashes or trim (draw-on) | done (A8.2) for shapes and text: ordered fills and strokes, solid, linear, radial and angular paints, blend modes, stroke align, cap, join, dash, trim, AtomCut's paint property paths. Later: media, pattern and variable paints, the stroke pipeline (profile, wave, roughness, scatter, nib, markers), paints on media layers |
| Text | One style per layer; no rich runs, highlight, text effects, auto width or wrap box, captions | partial: the text box, justify and the pivot as a box fraction (A8.1); styled ranges, highlight and range keys (A8.5); text effects (A9.2); captions with states (A9.6); decoration, case and faux bold (A10.1). Still todo: right-to-left shaping (`direction`), vertical columns (`orientation`), text on a path |
| Motion | Whole-layer keys only; no per-unit animator, motion paths (`arc`, handles), more easings (quart, expo, elastic), or motion blur | done (A9.1, A9.2, A10.9): the per-unit animator with the 44 presets (A9.1); motion blur (A9.2: comp master and per-layer shutter, AtomCut's 7 presets, fast/exact/full sampling, `mblur.*` keys); motion paths (A10.9): `spatial {in, out}` handles on position keys, `arc`/`in`/`out` on `keyframes_set`, the viewport overlay and hand editing (points, handles, segments), `motion_edit`, `keyframes_smooth`; the engine and motion blur follow the curve. Not yet: 3D path display (waits for A7), the dashed leader during a drag, Shift axis lock on a point drag. AtomCut has no auto-orient or constant speed either |
| Effects and transitions | None yet; the catalogs only list them | done (A9.2, A9.3): 38 of AtomCut's 39 layer cards (all but the `grade` node graph) and the 4 text effects, keyable, with the Effects tab; motion blur; the 23 transitions |
| Fonts | The 68 Google families load from the web each time; not cached or embedded | done (A6b.4): cached on disk, prefetched at startup, and every text layer's font loads whichever panel is open |
| Agent quality | No benchmark yet comparing our agent's videos with AtomCut's | benchmark in place (A6b.5): 7 briefs from AtomCut's recipes, all exported with no human step; the gaps are in `docs/benchmarks/results.md` and order A8 and A9 |

## 1. API, session and verification

| AtomCut tool | What it does | Ours | Status | Step |
| --- | --- | --- | --- | --- |
| `api_describe` | Live schema of any type or command | `api.describe` | have (exposed) | A6 |
| `api_batch` | Many calls as one, with `$N` refs | `api.batch` | have (exposed) | A6 |
| `doc_overview` | Project summary for orienting | `doc.overview` (+ where the user is) | have (exposed) | A6 |
| `history_undo` | Undo agent turns | `history_undo` (the caller's own newest step only) | have | A6 |
| `session_set` | Active comp, playhead, selection, working range | `session.set` with `workRange {compId\|frameId, startMs, endMs} \| null` (limits preview, which loops inside it, `export_video` and `view_frames`' default span). By hand: the transport's Working range toggle, in and out buttons, `[` and `]`, ruler handles | have (A10.7) | A6 / A10.7 |
| `atomcut_status` | Link and app status | `uve_status` | have | A6 |
| `app_console` | Read the app console | `app.console` | have | A6 |
| `report_issue` | Honest failure reports | `report_issue` (saved locally) | have | A6 |
| `view_render` | One frame as an image (glance, look, inspect) | `view_render` (export sources) | have | A6 |
| `view_frames` | Contact sheet of frames | `view_frames` (export sources) | have | A6 |
| `catalog_list`, `catalog_get` | Presets: effects, animations, text looks, transitions, easings, blend modes, 3D | `catalog.list`, `catalog.get`: text-templates, animations, layer-effects, text-effects (fields with ranges), transitions, easings, lights, materials, primitives | partial | A6 (data) + feature steps |

## 2. Layers, text and layout

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `layer_create`, `layer_get`, `layer_set`, `layer_patch`, `layer_properties` | `layer.*` (A8.1: `maxWidth`, `maxHeight` on text, keyable; `anchor.x`, `anchor.y`, `anchor` as AtomCut's box fractions) | have (exposed) | A6 |
| `layers_list`, `layers_delete` | `layers.list` (with each layer's measured bounds, A8.1), `layers.delete` | have (exposed) | A6 |
| `layers_copy`, `layers_duplicate` | `layers.copy` (`toFrameId` or `toCompId`, `atMs`; groups with their members), `layers.duplicate` (just in front of the source); Ctrl+C, Ctrl+V, Ctrl+D | have (A8.6) | A8 |
| `layers_group`, `layers_ungroup` | `layers.group` (with `layout`; a rect behind becomes the container), `layers.ungroup` (bakes) | have (A8.3) | A8 |
| `layers_restack` | `layers.restack` (front, back, above, below; joins the target's group); Ctrl+Shift+] and [ | have (A8.6) | A8 |
| `layers_nest`, `layers_makeUnique` | `layers.nest` (hugs the layers, or `fullFrame`), `layers.makeUnique`; `nested` layers (`layer_create {kind: "comp", sourceFrameId}`) with speed, loop, pingpong, `trimInMs`, auto/crop/spill; by hand: Nest button, double-click to enter, breadcrumb, inspector Nested comp section. Not yet: `reverse`, keys on `playback.speed`, components | have (A8.6) | A8 |
| `text_set`, `text_style` | `text.set` (ranges follow their words), `text.style` (match, occurrence, indices, clear; highlight); `keyframes_set {range}` | have (A8.5) | A8 |
| `font_install` | `font_install {localPath | url}` (host tool; TTF, OTF, TTC, WOFF, WOFF2: family, weight, italic and the variable range read from the file; `Project.fonts`, `fonts.add`, `fonts.remove`); `fonts.list` searches the 1,946 Google families and the installed ones; the Fonts window. Not yet: `attachmentId` (no attachments here) | have (A10.4) | A10 |
| `layout_set` | `layout.set`: row, column, wrap, grid, gap, padding, align, hug or fixed, clip; `null` bakes | have (A8.3) | A8 |
| `component_inputs` | Component instances with inputs | todo | E |
| `frame_create`, `frame_update`, `frame_delete`, `frame_duplicate` | `frame.create`, `frame.update`, `frame.duplicate`, `frame.delete` (`comp.create` and `comp.update` are aliases): timeline or static frames (`mode`, `stillMs`, `overflow`, `pageId`); a static frame shows its still at any time, is silent, and `export_video` writes it as a still (PNG by default, also JPG and WebP; A10.8d) and refuses video formats with a hint. By hand: Layers tab Pages section, inspector Mode, Still at, Overflow, Page. Not yet: flipbook mode (refused) | have (A10.6) | A10 |
| `page_create`, `page_update`, `page_delete` | `page.create {name, frameIds?}`, `page.update {id, name?, index?}`, `page.delete {id, moveTo?, comps}`; the last page stays | have (A10.6) | A10 |
| `link_set`, `link_list`, `link_follow`, `link_remove` | Property links between layers | todo | E |
| `switch_create`, `switch_show` | Switch layers (pick one child) | done (Q7: switch.create, switch.show; keys hold) | Q7 |

## 3. Animation and time

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `keyframes_set`, `keyframes_clear`, `keyframes_inspect` | `keyframes.*`; keys on `transform.x` carry `spatial {in, out}` (px relative to the key; an x key with a y partner). `keyframes_set` on `position` takes `arc` (a parabola, linear easing by default, so gravity), `in` and `out` (`null` clears), in AtomCut's `{at, value, easing}` keys and in our `{t, v, ease}` keys (which also take `spatial`, but not with `in`/`out`); arc wins over out, a missing axis is added at its evaluated value, the result has `curved`; AtomCut's two refusals ("`arc`, `in` and `out` shape a motion path." on other properties; "One curve per segment: keep the arc or the handle."). `keyframes_inspect` prints `↷(out dx,dy in dx,dy)` after the x value and counts `curvedKeys` (AtomCut prints only `↷`, which loses the curve). `keyframes_clear` drops handles with their keys | have (A6b.3, A10.9) | A6 / A10.9 |
| `keyframes_simplify` | `keyframes.simplify {id?, frameId?, properties?, tolerance?}`: fewest eased keys within tolerance, x and y together, baked tracks of a comp. Curved position is skipped (`skipped`). By hand: Simplify in the Keyframes tab | have (A10.7, A10.9) | A10.7 |
| (ours) `motion_edit` | `motion.edit {id, atMs (comp time), op: move, insert, delete, smooth, corner, bend, handle}`: edit a motion path's points and handles. Not an AtomCut MCP tool: AtomCut has these as viewport gestures only. By hand: the viewport overlay (drag points with snapping, Ctrl free; Alt pulls out handles; handle drags keep mirrored or collinear pairs, Alt breaks or mirrors, Shift snaps to 15°, drop on the key clears; drag the curve to bend; double-click to insert or toggle smooth and corner; context menu), Main menu ▸ View ▸ Motion paths | have (A10.9) | A10.9 |
| (ours) `keyframes_smooth` | `keyframes.smooth {id, properties?, fromMs?, toMs?}`: monotone (PCHIP) easings on every numeric track, Catmull-Rom handles on position paths, with path speed continuous through keys. Not an AtomCut MCP tool: AtomCut's Smooth is a timeline button only. By hand: Smooth in the Keyframes and Curves tabs | have (A10.9) | A10.9 |
| `animation_set` | `animation.set`: the 44 presets as entrances and exits, per letter, word or line on text (`textIn`, `textOut`) or the whole layer (`animIn`, `animOut`), stagger, delay, jitter, scatter, easing, knobs; `draw` on shapes and paths. By hand: the Animate tab and Library ▸ Animations. Not yet: per-range animations, the typing cursor, `draw` on text | have (A9.1) | A9 |
| `template_apply` | `template.apply {ids, templateId, keepSize}`: the 103 text looks (type, text effects, layer effects, entrance, typing sound, and on a caption layer the spoken-word look) on text layers that exist, keeping words, ranges, position, box, alignment, line height and an exit; `layer.create {template}` makes a layer in a look; the Library applies a look to the selected text | have (A10.2) | A10 |
| `expression_set`, `expression_reference` | Property expressions | todo | E |
| `behaviors_add`, `behaviors_update`, `behaviors_remove`, `behaviors_override`, `behaviors_inspect` | Procedural behaviours (wiggle, follow, and so on) | partial (Q7: add, update, remove, inspect; blink, breathe, sway, nod, glance, talk; no overrides, cycle or machine) | Q7 |
| `machine_create`, `machine_state`, `machine_transition`, `machine_evaluate`, `machine_inspect`, `machine_remove` | State machines | todo | E |
| `timeline_move`, `timeline_trim`, `timeline_split` | `timeline.*` | have (exposed) | A6 |
| `timeline_close_gaps`, `timeline_compact`, `timeline_cut_ranges` | `timeline.close_gaps`, `timeline.compact` (`frameId` too), `timeline.cut_ranges` (sync, lane, none); by hand: Shift+Delete ripple delete, Close gaps button. Not yet: linked a/v pairs (no `audio_detach` yet) | have (A8.6) | A8 |
| `transition_add`, `transition_remove` | `transition.add` (AtomCut's input: ids, preset, edge in/out/any, durationMs, easing, params, color; one per shared cut, replacing; fitted to the layers), `transition.remove`; the 23 presets in core with AtomCut's ids, knobs and defaults; seams centred on the cut with the sides held past their spans, lone heads and tails; wipes, veils and tears drawn on the pair; sound crossfades in the export mix; timeline markers with remove; Library ▸ Transitions applies to the selected layer | have (A9.3) | A9 |
| `flipbook_cells`, `flipbook_edit` | Frame-by-frame comps | todo | E |

## 4. Effects, colour and audio

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `effects_add`, `effects_update` | `effects.add`, `effects.update` (A9.2): layer stack (shadow, innerShadow, glow, longShadow, blur, directional, zoom and spin blur, sharpen, adjust, vignette, stroke, rgbSplit, shine) and text effects (shadow, glow, extrude, echo), keyed at `lfx.`/`tfx.<id>.<field>`; the analog cards (grain, noise, scanlines, filmDamage) on a seeded clock; the distortions (bulge, wave, twirl, lensDistort, goo, roughenEdges, boil, glitch); colour and stylize (colorGrade, gradientMap, posterize, overlay, chromaKey, halftone, pixelate, bevel); light and material (lightRays, lensFlare, lightning, glass with the backdrop); loose cards in `layer_create` and `layer_patch`; by hand: the Effects tab. Not yet: the `grade` node graph (phase E), Looks, the audio and geometry domains | partial | A9 |
| `grade_effect`, `grade_node`, `grade_read` | Colour grading: the **Color** and **Nodes** tabs | todo | E |
| `audio_analyze`, `audio_detach`, `audio_rejoin`, `audio_isolate` | Audio tools | todo | D |
| `sounds_list`, `sounds_use`, `sound_category` | The sounds stack is in (A9.4: `sounds` on layers, AtomCut's voice shape, the 6 synthesised packs and custom media sounds, fired by text units, layer animations and transitions, heard in the preview and the export; the Sound tab); `sounds.list` / `sounds.use` search and fetch the CC0 library (A9.5); `sound_category` (buses, leveler, ducking, limiter) done in Q2 | done | A9 / Q2 |
| `voices_list`, `generate_speech` | TTS (ours: Gemini) | todo | D |
| `speech_analyze`, `speech_bake`, `speech_bind`, `speech_fix`, `speech_inspect` | Lip sync and speech timing | todo | E |

## 5. Media and generation

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `media_import`, `media_list`, `media_remove` | `media_import` (by path; no URL yet), `media.list`, `media.remove` | have / partial (URL) | A6 |
| `media_inspect` | Contact sheet, loudness | todo | A9 |
| `media_transcribe`, `media_remove_pauses` | Whisper captions, cut silences (the caption model is in: `caption.set` with cues, states and the gliding pill, A9.6) | todo (transcription) | E |
| `media_remove_background` | Flat-ground colour key (Q5; no AI model: a real backdrop is refused) | partial | Q5 |
| `media_upscale` | Permissively licensed models | todo | E |
| `generate_image`, `generate_video`, `generate_music`, `generate_sound` | Provider plugins (user keys) | todo | D |

## 6. 3D worlds

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `world_create` | `world.create`: a world frame (size, fps, length, `starter`, `transparent`, `pageId`); the starter camera, point light, Studio environment and cube | have | A7b, A7h |
| `world_move_into` | `world.move_into {ids \| compId, name}`: full-frame nest into a world, positions, turns and keys converted by the change of axes (proved to 1e-6 px) | have; `approximate` for keyed turns where both rotation and rotationY turn, and groups that move; curved motion paths straighten; by hand: the inspector 3D button, Layer ▸ Move into 3D world | A7c, A7e |
| `world_add` | `world.add`: mesh (13 primitives with AtomCut's params and defaults, keyable `geometry.<param>`, `shading`, `smoothAngle`, colour from the fill), camera, light (6 types), controller, text, with `lookAt`; inspector Mesh section; the other light fields (`range`, `spotAngle`, `spotBlend`, `width`, `height`, `groundColor`, `castShadow`, `shadowSoftness`, `environment`, `showBackground`) through `layer.patch` and the inspector Light section | have; `head` is phase E (refused); editable meshes later (E); models through `world_import_model` (A7l); meshes take no entrance or exit poses yet (the Animate tab) | A7c, A7e, A7h |
| `world_camera` | `world.camera {activate, fromDefault, atMs}`; the live camera is the topmost visible camera clip; keyable focal length | have | A7c |
| `world_inspect` | `world.inspect`: output size, live camera and fovY, environment, every object's world position, rotation and size, the look (bloom, ao, floor), a camera's `dof`, constraints already applied, a model's clips | have | A7b, A7j, A7k, A7l |
| `world_look` | `world.look`: tone mapping, exposure, shadows, shadow quality, mist; bloom (bright or emission, the finish screens the glow and raises alpha), ambient occlusion (GTAO), the floor (shadow, solid, mirror), depth of field per camera (`cameraId`, `dof {focusOn, focusDistance, fStop}`, keyable); motion blur in worlds (sub-frame renders through the live camera's shutter); the three.js renderer; inspector World and Camera rows | have | A7d, A7g, A7g2, A7j |
| `world_material` | `world.material {ids, preset, values}`: 17 presets, pbr, toon and unlit models, keyable roughness, metalness, emission, transmission; inspector Material section | have (pictures and meshes; a model's file materials with `source`) | A7g, A7g2, A7h, A7l |
| `world_extrude` | `world.extrude {ids, depth, bevel, bevelSegments, sideColor, fit}`: pictures given thickness | have: text (glyph outlines via opentype.js), shapes, closed paths, images (alpha trace), video and nested frames (box); keyable `extrude.depth`/`extrude.bevel`; inspector Thickness section | A7i |
| `world_track` | Cameras and objects that follow, aim and constrain: `world.track` with lookAt, follow (offset, `followRotation`), childOf (stored inverse, so the layer stays put; loops refused), `influence` and `enabled` (through `layer.patch`); evaluated in core `worldObjects`, so the render, `world_inspect`, 3D motion paths, `focusOn` and world motion blur follow; inspector Track section (Child of, Look at, Follow, Turn with it) | have; IK (`ik`) is phase E | A7k |
| `world_import_model` | Model import into a world: `.glb`, `.gltf` (sibling `.bin` and textures granted), `.obj`, `.stl`, `.ply` from `localPath` or an https `url` (cached in user data); a `model` media asset (path kept, never copied) and a mesh with `geometry {type: asset}`; AtomCut's sizing (glTF × 100 in a Z-up wrapper, others fitted to 200 px on z = 0); Draco and meshopt; `material.source file|custom`; ours: the file's clips play on the layer's time (`animation {clip, speed, loop}`, deterministic); drop or Import into an open world; inspector Model section | have; fbx, `attachmentId` and a flat comp target (AtomCut nests a world) refused; shape keys and face pose sets are phase E; OBJ `.mtl` materials not read | A7l |
| `world_apply_modifier`, `world_face`, `world_lattice`, `world_sculpt`, `world_line_art` | Modelling | todo | E |
| `mesh_edit` | Mesh editing | todo | E |

## 7. Characters, rigs and physics

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `rig_create`, `rig_bone`, `rig_bind`, `rig_paint`, `rig_pose`, `rig_constrain`, `rig_mirror`, `rig_symmetrize`, `rig_inspect` | 2D bones | partial (Q7: create, bone with IK and limits, pose, bind rigid/auto, inspect; pieces ride bones whole; no paint, constrain, mirror, symmetrize, bending art) | Q7 |
| `poses_create`, `poses_add`, `poses_key`, `poses_block`, `poses_bake`, `poses_drawing`, `poses_update`, `poses_remove`, `poses_inspect` | Pose libraries | todo | E |
| `shapekey_create`, `shapekey_edit`, `shapekey_set`, `shapekey_remove`, `shapekey_inspect` | Shape keys | todo | E |
| `character_detect`, `character_bringToLife` | Auto-rig from art | done (Q7: names in ~20 languages, switch members, geometry; one-path faces split) | Q7 |
| `perform_take` | Performance capture takes | todo | E |
| `physics_scene`, `physics_body`, `physics_joint`, `physics_force`, `physics_inspect` | One physics system for 2D and worlds | done in flat comps (Q6: planck.js, no baking, plus our `physics_bake`); worlds and rig bones later | Q6 |
| `track_create`, `track_analyze`, `track_correct`, `track_follow`, `track_inspect`, `track_remove`, `track_scene`, `track_update` | Motion tracking (as `motion_track_*`) | todo | E |

## 8. Scripts

| AtomCut tool | Ours | Status | Step |
| --- | --- | --- | --- |
| `script_run`, `script_save`, `script_read`, `script_list`, `script_runs`, `script_logs`, `script_stop`, `script_reify` | Sandboxed scripts calling the command API (the **Scripts** rail tab) | todo | A9 |

## 9. Assets

Everything AtomCut offers as content, ported as data or files with the owner's reported permission, attributed, and stored so it works offline.

**Inventory (A6b.4, 2026-10-25).** Taken from the live 4.17.0 app over CDP: every network request was recorded while browsing each Library section (scrolled to the end, every sound pack played), the Library filters, the Media tab and each plugin in the Plugins tab. The full list (every sound pack and icon set with its count, size and licence) is in `docs/research/atomcut-asset-inventory.json`; the method is in the research notes.

| Asset | Where it is in AtomCut | Size and licence | Ours | Status |
| --- | --- | --- | --- | --- |
| 103 text looks, 44 animations, 23 transitions | Library (built in; the data ships in the app, no network) | Preset data | `packages/core/src/looks.json` (looks); the animations and transitions in `packages/core/src/animationPresets.ts` and `transitions.ts` | have; the 44 animations apply (A9.1, looks get their entrance too); looks get their text effects and all their layer cards (stroke, long shadow, RGB split, grain, scanlines, noise; A9.2); the 23 transitions apply (A9.3) |
| 6 typing-sound packs (Digital, Mechanical, Pop, Soft, Thock, Vintage) | Library ▸ Sounds | Synthesised in the app; no files are fetched | Our own synthesis (engine `soundSynth.ts`), the same in the preview and the export | have: they fire from animation (A9.4) |
| Easing presets (8) | Chunk 459 | Curve data | `packages/core/src/easing.ts` | have (A6b.3) |
| Fonts used by the looks: 68 Google families | Google Fonts, fetched on use | OFL-1.1 or Apache-2.0 | Cached on disk by the main process (`main/fonts.ts`): every Google font fetched is kept, and the looks' fonts (Latin and Latin-ext) are fetched ahead at startup: 141 stylesheets and 202 files, 4.9 MB | have (A6b.4) |
| The Fonts plugin: all 1,944 Google families (with categories and mood tags) and the fonts on this device | Plugins ▸ Fonts; metadata bundled in a chunk, files from Google Fonts | OFL / Apache / UFL per family | The Fonts window: 1,946 families (category, feelings, styles, designers, weights, variable ranges; `library/google-fonts.json`), the fonts installed in the project, the fonts on this computer (Local Font Access API), previews in each face, starred and recent, upload and drop; `fonts.list`, `font_install`. Google fonts are cached on disk (A6b.4). Not yet: collections | have (A10.4) |
| Sound effects library: 91 packs, 4,555 sounds, 80.3 MB (Kenney, OpenGameArt authors, AtomCut's own 38) | Plugins ▸ Sound Effects; `library.atomcut.net/v1/index.json`, `packs/<id>.json`, content-addressed `blobs/<sha256>` | **All CC0-1.0** | `sounds.list` (search by pack terms, then names, tags and blurbs), `sounds.use` (fetch once into user data `sound-library/`, SHA-256 checked, imported as media with `credit`, hit measured from the peaks); by hand: Sound tab ▸ Find a sound (hear, use) | have (A9.5) |
| Icons: 243 open-source sets, 416,940 icons | Plugins ▸ Icons; `icons.atomcut.net` (an Iconify API mirror, falling back to `api.iconify.design`) | Per set: MIT 112, CC-BY-4.0 52, Apache-2.0 31, OFL 13, CC0 10 and others; 6 GPL sets and 2 non-commercial sets are excluded | 235 sets (413,167 icons): set listings, searches and icons cached on disk (`main/icons.ts`), SVG read by `svgImport.ts` and placed by `svg.place` as path layers (strokes, fills, gradients, several layers grouped) with `origin` (set, licence, author) on each; the Icons window (sets by group, search every set, Line/Solid/Colour, colour, size, pen, Draw on and Out), `icons.list`, `icons.use`, `svg.place`; project Credits (`doc.overview.credits`). Offline for what was seen | have (A10.5) |
| Waveform Visualizer | Plugins ▸ Audio | A feature, not an asset | Waveform layers (A8) | todo |
| Templates (`template_apply`) | The text looks are the templates (`catalog_list text-templates`); `web-out/templates/` in 4.9.0 holds a playground and talking characters with 4 voice lines | Preset data | `template.apply` and `layer.create {template}` (A10.2); the looks live in `packages/core/src/looks.json`. The playground and talking characters need generation and rigs (phase E) | have (text looks) |
| Design system | `@atomcut/mcp` `skill/design-systems/atomcut-default/DESIGN.md` | MIT (the package) | `skill/design-systems/default/DESIGN.md`, adapted to this editor (px column, easings, tools), linked from the skill | have (A10.3) |
| Characters, stickers, stock media | Not served: AtomCut makes them with AI generation (`generate_image`, `character_*`) | — | Stickers: free libraries in `~/uve-assets` (Fluent Emoji 3D and flat, Open Peeps, Open Doodles), `stickers_list`, `stickers_use`, Library ▸ Stickers (Q5); characters and stock media: generation tools (phase D) | partial |
| Shared library ("Library" source, "Publish to the library") | Library ▸ View and filters ▸ Source | Empty in this account | — | nothing to port |

## UI that goes with these

The live UI was studied with REA on 2026-10-24 (see the research notes):
- **Left rail:** Library, Media, Layers, Plugins (done in A10.4), Agents (done in A6), Scripts (todo: it came with the scripts group, section 8, which is not done yet). The rail's foot in AtomCut also has a layout button, a report-issue (bug) button and Settings: todo.
- **Right rail** (vertical tabs, label written sideways): Design, Effects (done in A9.2), Animate (done in A9.1), Sound (the sounds stack, done in A9.4; Output and Mix in phase D) and Physics (E: the tab arrives with physics, as the rule is no tab before its feature works).
- **Bottom tabs:** Timeline, Keyframes and Curves (done in A5c); Color and Nodes (E: grading).
- **Orbit view** (3D worlds): done in A7m. The viewport's Camera/Orbit pill, Solid, Material and Rendered shading, grid, gizmos, click select and 3D motion paths. Still missing: Wireframe, X-ray, orthographic and animated views, the navigation gizmo, the ghost camera, box select and move gizmos (phase E).
- **Library categories:** Text looks, Animations, Transitions and Sounds, filled from `packages/core/src/looks.json` as each feature lands.
- **Seen in a 4.17.0 screenshot on 2026-10-26, still missing here:** the inspector's Align row (left, centre, right, top, middle, bottom, distribute horizontally and vertically) and its header actions (key every property, send to 3D, duplicate, delete); the toolbar's Frame tool and the drawing tools (brush, curve, eraser, fill: they belong to flipbooks, phase E); the viewport's quality pill ("Full") and its view settings. Order to be set when A10 ends; the Align row and header actions are small and fit before A7.

## Claims in AtomCut's launch video (checked 2026-10-26)

What the launch video shows, against this file. Items new to this file are marked **new**.

| Claim | Ours | Status | Step |
| --- | --- | --- | --- |
| Runs in a browser tab | Electron desktop app by design (files stay on disk, see PLAN › Media) | not a goal | — |
| Real vector layers, a scene of 328 editable layers | Every scene is layers; **new:** a performance check with a 300+ layer comp (preview frame rate, export speed) on this machine | todo (check) | A10 end |
| 300,000+ open-source icons | 235 sets, 413,167 icons (AtomCut serves 243 sets, 416,940; the 8 GPL and non-commercial sets are left out) | have (A10.5) | — |
| Paths and strokes draw themselves on | Stroke trim, `animIn: draw`, Draw on in the Icons window | have (A8.2, A9.1) | — |
| Physics: particles bounce off letter outlines, bodies fall and settle | `physics_*` (section above); **new:** particle emitters colliding with outlines (the rain in the video) | partly (Q6: bodies fall, pile and settle on letter ink and sticker silhouettes; no particle emitters yet) | Q6 |
| 2D shapes and text extruded to 3D (depth, bevel, lights) on the same timeline and keys | Worlds with lights and materials (A7g), extruded pictures (`world_extrude`, A7i) | have | A7 |
| Floor reflections, mist, depth of field | `world_look` (mirror floor, mist, depth of field, bloom, AO) | have | A7 |
| Bones on vector shapes, procedural blinks | `rig_*`, `behaviors_*`, `character_bringToLife` | partial (Q7: pieces ride bones, blinks, breath, nods, talking mouths; no bending art) | Q7 |
| 4,500+ CC0 sounds | 91 packs, 4,555 CC0 sounds | have (A9.5) | — |
| Mixer with Voice, Music and Effects sliders, auto-ducking under speech | The frame's Sound tab: leveler, master, limiter, categories with solo, mute, level and ducking (Q2); per-bus audio effects wait for phase D | done (no bus effects) | Q2 / D |
| 36 visual effects (morph, lightning, glitch, long shadow, glow, particle emitters) | 38 of 39 layer cards and 4 text effects (lightning, glitch, long shadow, glow); path morphs between same-command paths; **new:** particle emitters | have / todo (particles) | A9.2 / E |
| Export MP4, GIF and **Lottie** (vector JSON), no watermark | MP4 and GIF with no watermark (GIF A10.8d); **new:** Lottie export (vector JSON of the layers and keys: decide which layer kinds and effects can map, the rest refused with a reason) | partial | A10.8 (GIF) / later (Lottie) |
| The video was built by Claude through the API, every layer editable | Benchmarks: headless Claude Code builds and exports through MCP, every layer editable by hand | have (A6b.5) | — |
