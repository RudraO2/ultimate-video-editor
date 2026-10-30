# Benchmark results

## Run of 2026-10-25 (end of A6b)

**Setup.** The seven briefs in `briefs/`, run one after another by `run.mjs` through headless Claude Code (Sonnet, `--strict-mcp-config`, editor tools only, at most 60 turns) against the dev build at the end of A6b. Contact sheets (12 evenly spaced frames of each export) and `results.json` are in `results/2026-10-25/`.

**Comparison.** AtomCut's live tools need AtomCut Pro, so the same briefs could not be rendered in AtomCut. Each result is judged against AtomCut's own recipe for the brief, which is what its agent is taught to build.

| Brief | Turns | Time | Cost | Exported | Result |
| --- | --- | --- | --- | --- | --- |
| 01 Title card | 21 | 63 s | $0.31 | yes | Clean, well-set type (DM Serif Display, tracked amber kicker, rule, subtitle), staggered fades. Flat ground, no glow, whole-layer motion only; left alignment done by measuring each line's width. |
| 02 Lower third | 15 | 56 s | $0.23 | yes | Correct timing (in at 0.5 s, 3.2 s hold, out), inside title-safe, over scaled footage. A plain panel with an accent bar; no grouping or auto layout. |
| 03 Kinetic type | 18 | 62 s | $0.27 | yes | On-beat words with varied entrances and colour flashes on "count". No motion blur, no hits (no sound tools), no per-letter motion. |
| 04 Lyric captions | 17 | 89 s | $0.34 | yes | Lines switch on time, current, next and sung lines styled differently, block scrolls. The gradient is faked with 24 colour strips (visible banding); the highlight is an ellipse; lines were split by hand to fit (no wrap width). |
| 05 Reel | 25 | 77 s | $0.31 | yes | Five even cuts, cover crop, punch-ins on alternate cuts, title card, caption bars. No transcription to pick moments, captions are made up, no nesting or ripple cut. |
| 06 Promo | 28 | 179 s | $0.58 | yes | The strongest: clear hierarchy, numbered feature beats, accent price, CTA pill end card, beat-timed cuts with a flash and zoom punch. Silent (no music or sound tools); transitions faked with a white flash. |
| 07 Logo reveal | 19 | 107 s | $0.38 | yes | Ring and line, fill, a light band, wordmark letter by letter (one layer per letter). No draw-on (no stroke trim, no path layers), and the shine is not clipped to the mark (no masks), so it shows beside it. |

**What works.** Every brief ended in an exported MP4 and a saved project with no human step, in 15 to 28 turns, 1 to 3 minutes and $0.23 to $0.58 each ($2.42 for all seven). The agents read the skill, built in batches, looked at their work with `view_frames` and `view_render`, and reported honestly what they could not do. Layout, type choice and timing are already good.

**The gaps, by how many briefs they cost** (what the agent had to fake or leave out):

| Gap | Briefs | What AtomCut has | Goes to |
| --- | --- | --- | --- |
| Per-letter, word and line animation with stagger (`animation_set`, the 44 presets as commands) | 01, 03, 07 (faked with one layer per word or letter) | Per-unit animators with presets, units, stagger and easing | A9, first |
| Gradient and multiple paints, radial glow | 01, 04 (24 strips), 06 | Linear and radial gradients, several fills and strokes per layer | A8 |
| Text box: left or right anchoring, wrap width, auto width or height | 01 (measured widths), 04 (lines split by hand) | `maxWidth`, auto width, auto height, fixed box | A8 |
| Sound on animation and a sound library | 01, 03, 06 (all silent) | The sounds stack (pops, typing packs) and 4,555 CC0 sounds (section 9), music generation | A9 (sounds stack); pull the CC0 library forward from phase D |
| Effects: blur (unblur entrances), glow, motion blur, shine | 01, 03, 07 | The effect stack and motion blur | A9 |
| Transitions between scenes | 05, 06 (a white flash instead) | 23 transitions (`transition_add`) | A9 |
| Stroke trim (draw-on), path layers, masks and mattes | 07 | Path layers (`d`), stroke trim, masks | A8 |
| Groups and auto layout | 02, 04 (a stack keyed line by line) | Groups, auto layout (column, gap, padding) | A8 |
| Rich text runs (one coloured word) | 01 | `text_style` ranges | A8 |
| Captions with states, transcription | 04, 05 | Caption layers (unread, focus, read), `media_transcribe` | A9 (captions); transcription in phase E |
| Nesting and ripple edits | 05 | Nested comps, `timeline_cut_ranges`, `media_remove_pauses` | A8 |

**Resulting order.**
- **A8:** the text box (anchoring, wrap and auto size), paints (gradients, several fills and strokes, stroke trim), groups with auto layout, path layers and masks, rich text runs, then nesting and ripple edits.
- **A9:** the per-unit animator with the 44 presets, the effect stack (blur, glow, shadow, shine, motion blur), the 23 transitions, the sounds stack with the typing packs, captions with states, and the CC0 sound library (pulled forward from phase D).

Re-run the briefs at the end of A8 and of A9, and add a column here for each run.

## Run of 2026-10-25 (end of A8)

**Setup.** As before (Sonnet, editor tools only, at most 60 turns), against the dev build at the end of A8 (text box, paints, groups and auto layout, paths and masks, styled ranges, duplicate, copy, restack, nesting and ripple edits). Contact sheets and `results.json` are in `results/2026-10-25-a8/`. Briefs 05 to 07 were run a second time: in the first attempt an earlier runner was still driving the same editor, and then the account's usage limit stopped 06 and 07. Only the clean runs are recorded.

| Brief | A6b: turns, cost | A8: turns, time, cost | Exported | What changed |
| --- | --- | --- | --- | --- |
| 01 Title card | 21, $0.31 | 13, 40 s, $0.27 | yes | A real radial glow (a gradient fill) instead of a flat ground; the left-aligned stack uses `anchorX: 0` instead of measured widths. Still whole-layer fades. |
| 02 Lower third | 15, $0.23 | 18, 44 s, $0.29 | yes | Same quality: a dark card with an accent bar, right timing, inside title-safe. The agent still keyed the card and its text separately rather than grouping them. |
| 03 Kinetic type | 18, $0.27 | 16, 69 s, $0.34 | yes | Same approach: one layer per word with varied entrances and colour flashes on the beat. No per-letter motion, motion blur or hits yet (A9). |
| 04 Lyric captions | 17, $0.34 | 15, 66 s, $0.31 | yes | Clearly better: a smooth two-stop gradient instead of 24 strips, lines wrap at a box width (`maxWidth`) instead of being split by hand, and current, next and sung lines are styled. |
| 05 Reel | 25, $0.31 | 21, 66 s, $0.30 | yes | Four cuts scaled to cover, push-ins, caption pills (`style.highlight`) and a title card. Captions are still made up (no transcription). |
| 06 Promo | 28, $0.58 | 23, 147 s, $0.57 | yes | As strong as before: gradient grounds, bold hierarchy, accent rules, the price beat and an end card. Still silent and the cuts still use a white flash. |
| 07 Logo reveal | 19, $0.38 | 15, 73 s, $0.38 | yes | Clearly better: the ring and the slash draw on (stroke trim), the disc fills with a radial glow, the shine is clipped to the mark (a mask group), and "STUDIO" is a styled range in the accent colour. The wordmark fades letter by letter through 15 range opacity tracks, one per letter: the per-unit animator will replace them with one preset. |

**What A8 fixed.** Gradients and glows (01, 04, 07), the text box (01, 04), draw-on and masks (07) and styled ranges (07) are now used by the agents without being asked, and the faked versions (colour strips, hand-split lines, an unclipped shine) are gone. All seven briefs again ended in an exported MP4 with no human step, in 13 to 23 turns and $2.46 in all.

**Still missing, in order** (all A9): per-letter, word and line animation (01, 03, 07 still animate whole layers or key letter layers one by one), sound (01, 03, 06 are silent), transitions (05, 06 use a white flash), effects (blur entrances, motion blur, a real shine on 03, 06, 07), and captions with states (04, 05).

## Run of 2026-10-25 (end of A9, partial)

**Setup.** As before (Sonnet, editor tools only, at most 60 turns), against the dev build at the end of A9 (the per-unit animator, 38 effect cards, motion blur on by default, the 23 transitions, the sounds stack with the six packs and the CC0 library, captions with states). Contact sheets and `results.json` are in `results/2026-10-25-a9/`. Briefs 05 to 07 did not run: the account's session limit was reached after 04. Run them with `node docs/benchmarks/run.mjs --out <folder> --only 05-reel,06-promo,07-logo-reveal` and add them here.

| Brief | A8: turns, cost | A9: turns, time, cost | Exported | What changed |
| --- | --- | --- | --- | --- |
| 01 Title card | 13, $0.27 | 11, 65 s, $0.31 | yes | Per-word entrances now: the title's words unblur upward in turn (`unblur-up`), the kicker and subtitle fade up, the rule draws out. Still silent and no effect beyond the glow fill. |
| 02 Lower third | 18, $0.29 | 27, 71 s, $0.45 | yes | Used whole-layer entrance and exit presets instead of hand keys; it grouped the card and its text, then ungrouped them again. Same layout quality. |
| 03 Kinetic type | 16, $0.34 | 17, 69 s, $0.38 | yes | Each word gets a preset entrance (letters sliding up, a whip, a drop, a punch-in) instead of hand keys; motion blur is on by default for the fast moves (not inspected frame by frame in this run). Still no hits on the beat. |
| 04 Lyric captions | 15, $0.31 | 12, 62 s, $0.34 | yes | Same line-by-line approach with keyed opacities and a scroll; the agent did not use `caption_set` and said it could not sweep word by word. |

**What A9 changed.** Every agent now reaches for `animation_set` (per word, per letter, whole layer) without being asked, and motion blur is on by default. All four briefs ended in an exported MP4 with no human step.

**What it did not change, and why.** None of the four used effects, transitions, sounds or captions, although the skill documented them: the briefs do not ask for them by name and the skill's loop only described layout and timing. The skill now plans that craft in its loop and checks it in the review checklist (`skill/SKILL.md` step 2, `references/review.md`). The next run (05 to 07, then all seven again) shows whether that is enough.

## Run of 2026-10-26 (end of A9, briefs 05 to 07)

**Setup.** As before (Sonnet, editor tools only, at most 60 turns), against the same dev build as the 01 to 04 run, with the updated skill (the loop now plans per-unit entrances, hits, transitions, effects and captions). One runner, no code edits while it ran. Contact sheets and `results.json` are in `results/2026-10-26-a9-05-07/`; the first four briefs are in `results/2026-10-25-a9/`.

| Brief | A8: turns, cost | A9: turns, time, cost | Exported | What changed |
| --- | --- | --- | --- | --- |
| 05 Reel | 21, $0.30 | 21, 72 s, $0.37 | yes | The caption is now a real `caption_set` caption (word-synced, the gliding pill) instead of made-up pills; the title card unblurs word by word (`unblur-up`); the five cuts used `timeline_cut_ranges`. Still hard cuts (no transition), no hits. Captions are still invented: the source is a test pattern with no speech. |
| 06 Promo | 23, $0.57 | 41, 198 s, $0.77 | yes | The white flash is gone: five `transition_add` calls (whip pan, zoom, dip to white, cross dissolve) on the cuts, 27 entrance presets (per line, word and letter: punch, pop-in, fade-up), two CC0 hits from the library (`impacts-risers/impact-deep`, `motion-essentials/whoosh-pass-fast`), accent words through `text_style`. Costs more turns and money than the A8 run because it does more. The agent says what is missing: no music bed (there is no music source until phase D), and the test "photos" are gradients. |
| 07 Logo reveal | 15, $0.38 | 19, 55 s, $0.36 | yes | The wordmark rises letter by letter with one `animation_set` (per-letter `fade-up`) instead of 15 range opacity tracks; the light band is a `shine` effect card. Still silent. |

**Did the skill change what agents reach for?** Yes, in each brief the part the brief invites: captions in the reel (05), transitions and sounds in the promo (06, which has the beats and cuts to dress), an effect in the logo reveal (07). Across all seven briefs of the A9 build:

| Craft | Used by |
| --- | --- |
| Per-unit and whole-layer entrances (`animation_set`) | 01, 02, 03, 05, 06, 07 (not 04: still keyed line by line) |
| Transitions (`transition_add`) | 06 (not 05, which kept hard cuts) |
| Hits from the sound library or packs (`sounds_*`) | 06 only |
| Effects (`effects_add`) | 05 (a soft shadow on the caption), 07 (shine) |
| Captions with states (`caption_set`) | 05 (not 04, the lyric brief, which still keyed lines by hand) |

**Still missing.** Hits on the kinetic type (03), the lyric caption states (04), transitions in the reel (05) and any sound at all in 01, 05 and 07 were left out by the agents, not blocked by the editor: the briefs do not ask for them. A music source is the one real gap (phase D). Next benchmark run: after A7 or when the skill changes, all seven again, so the 01 to 04 rows are comparable.

## Run of 2026-10-26 (end of A10.9, motion paths: brief 08)

**Setup.** A new brief, `08-hopping-logo` (a ball bouncing to rest above a wordmark, a paper plane flying a looping route through three points), written so it never names `arc`, handles or smoothing. Sonnet, editor tools only, at most 60 turns, skill 0.14.0 (the new "Motion paths" section), the dev build of A10.9f2. Contact sheet and `results.json` in `results/2026-10-26-a10-9g/`.

| Brief | Turns | Time | Cost | Exported | Tool errors |
| --- | --- | --- | --- | --- | --- |
| 08 Hopping logo | 17 | 120 s | $0.52 | yes | none at the tool level; two calls inside batches failed and were fixed on the next turn (below) |

**Did the agent reach for motion paths unprompted?** Yes, both.
- **`arc`:** the ball's `position` is one key per contact with an `arc` on each take-off: 230, 100 and 32 px over flights of 640, 440 and 275 ms (heights 0.43 then 0.32 of the last, flight times 0.69 then 0.63: h/T² falls from 560 to 420, so gravity weakens a little at the end), a rest of 35 to 40 ms at each contact, and `arc: 0` on the opening drop (a horizontal launch that falls to the first contact: an idea the skill does not teach). Squash at each contact with `scale` `[sx, sy]` keys (four per contact, decaying), and a floor shadow whose x follows the ball linearly and whose scale shrinks at each apex.
- **`keyframes_smooth`:** the plane's 11 `position` keys (a loop through the sky, then a landing) and its `rotation` keys were written as plain keys and then smoothed together with `keyframes_smooth {properties: ["position", "rotation"]}`, so it never stops at a waypoint. Its heading was keyed by hand (there is no auto-orient, as the skill says).
- The wordmark: `fade-up` per letter (45 ms stagger, `ease-out-expo`). Three `view_frames` checks (contacts and the loop), one scale fix on the plane, then the export.

**What went wrong.**
- The first `keyframes.set` used our key shape with AtomCut's `arc` (`{t, v, arc}`) and was refused ("Unrecognized key: arc"); the agent rewrote it in AtomCut's shape. Fixed in this chunk: our `{t, v}` keys now take `arc`, `in` and `out` too (`KeyInputSchema` in `core/src/compat.ts`; `spatial` and `in`/`out` together are refused).
- `layer.set {id, x, y}` (flat fields) was refused; `layer.set {id, values: {x, y}}` worked. Left as it is (the error names the fields).
- No sound on the contacts (the recipe has a soft `pop`); the brief does not ask for one, as in earlier runs.

## Run of 2026-10-27 (A7f, 3D worlds part 1: brief 09)

**Setup.** A new brief, `09-title-in-space` (a podcast title hanging in space, a camera gliding round it and settling square to the viewer, the kicker in front of the title, a sheen as the camera passes), written so it never names worlds, cameras or materials. Sonnet, editor tools only, at most 60 turns, skill 0.15.0 (the new "3D worlds" section), the dev build of A7f. Contact sheet and `results.json` in `results/2026-10-27-a7f/`.

| Brief | Turns | Time | Cost | Exported | Tool errors |
| --- | --- | --- | --- | --- | --- |
| 09 Title in space | 51 | 157 s | $0.82 | yes | none at the tool level; one call inside a batch failed (below) |

**Did the agent build it in a world unprompted?** Yes.
- It laid the two lines and ten faint "stars" out flat, then moved all twelve into a world with `world_move_into` (no visual jump), and read the default camera with `world_inspect`.
- `world_add` made a camera at [750, −1500, −330] aimed with `lookAt`. Its `x`, `y`, `z`, `rotation` and `rotationX` were keyed by hand, with the skill's aim formulas: `rotationX` 101.1 at the start is 90 + atan2(330, hypot(750, 1500)). The move ends exactly on the default pose ([0, −2666.7, 0], [90, 0, 0]) at 4.1 s, so the last second is the flat picture. `keyframes_smooth` up to 4.1 s made the move flow.
- The kicker was pushed in front of the title (`y` −260), so the two separate in parallax. Stars at several depths add to it.
- The sheen: `world_material` `pearl` plus clearcoat and a little emission on the title, an `environment` light and a point light keyed across the front. The agent saw no highlight, so it tried a `shine` card on the title picture and saw nothing there either. In the end it put the `shine` on the nested world layer in the flat comp, so the band crosses the whole picture, stars included.
- 9 `view_frames`/`view_render` checks, then the export.

**What went wrong.**
- `layer.set {id, z, mode}` with a flat field was refused, as in 08; `layer.set {id, values: {y}}` worked on the next try.
- `world_inspect` ran once, before the camera existed. The skill asks for it at the start, middle and end of the move; the agent checked with frames instead.
- The sheen. A matte-ish plane under a point light shows a specular highlight only near the mirror angle, which a camera arc rarely crosses. White text also cannot be brightened by a `lighter` shine. So both failures may be expected behaviour, not bugs; the cause was not checked in this chunk. A real "light catches the letters" look needs bloom and thickness (A7i, A7j). Until then the skill could suggest a keyed `emissionStrength` or a shine in a contrasting tint.
- Cost and turns are higher than 08 (51 turns against 17), spent on type and sheen experiments rather than on the 3D work.

## Run of 2026-10-28 (A7n, closing A7: briefs 10 and 11)

**Setup.** Two new briefs that never name worlds, cameras or materials: `10-product-turntable` (a perfume bottle built from simple shapes on a studio floor, a camera circling it while it turns the other way, studio light, the name "AURA") and `11-neon-logo` (NOVA in a ring as a neon sign: tubes with depth, a flicker-on, glow that bleeds, a dark wall, a camera drift). Sonnet, editor tools only, at most 60 turns, skill 0.16.0, the dev build of A7n on the GTX 1650. Contact sheets and `results.json` in `results/2026-10-28-a7n/`.

| Brief | Turns | Time | Cost | Exported | Tool errors |
| --- | --- | --- | --- | --- | --- |
| 10 Product turntable | 41 | 132 s | $0.71 | yes | none from the editor; inside batches, `layer.set` refused `properties` and `{property, value}` before `values` worked |
| 11 Neon logo | 40 | 127 s | $0.79 | yes | none from the editor; inside a batch, `layer.set {fontSize}` refused before `values` worked |

**A bug found first.** The first try of brief 10 hung at frame 36 of the export (and again at frame 40 when repeated by hand). The console showed `GL_OUT_OF_MEMORY` then `CONTEXT_LOST_WEBGL`. Cause: the world renderer made a new three.js camera every frame and every motion-blur sub-frame, and three keeps one half-float render target per camera id for the transmission pass of glass materials, never freed. Fixed in engine `world/stage.ts` (`steadyCamera`: one camera per view). The same project (glass, mirror floor, AO, bloom, high shadows, world motion blur) then exported 180 frames at 1080p in 9.8 s on the GTX 1650 and in 67 s on the integrated Intel UHD with the NVIDIA card disabled (before: hung at frame 36 after 10 minutes). The app also ran on the integrated Intel GPU; main now sets `force_high_performance_gpu` (opt out with `UVE_LOW_POWER_GPU=1`) and every WebGL context asks for `high-performance`. A lost context during an export still hangs the export instead of failing it (the hardware encoder dies with the GPU process); that is a follow-up.

**Brief 10: did the agent build it the AtomCut way?** Yes.
- `world_create {starter: false}`, then the bottle from primitives in `api_batch`: a filleted cube body (`glass`), a cylinder neck, a cylinder cap and ring (`gold`), an amber "liquid" inside.
- Two controllers: the bottle's parts tied to "Bottle rig" with `world_track {childOf}`, the camera tied to "Camera rig" the same way, and the two rigs' `rotation` keyed in opposite directions (about 80° for the orbit, −120° for the bottle, eased to a calm stop).
- Lights: a studio `environment`, a `spot` key softened through `layer_patch` (`light.spotBlend`, `light.spotAngle`, `light.shadowSoftness`), area rims. `world_look {floor: mirror}` with AO; `world_inspect` once at the start; 10 `view_*` checks.
- The world nested in a flat frame with the name as a small text with `fade-up`.

**Brief 10 gaps.**
- Glass does not show what is inside it. The agent saw no liquid through the `glass` body and made the liquid opaque and the glass frosted; the result reads as a milky bottle with a solid block inside. Check three's transmission pass in our pipeline (the half-float target, the order of transmissive meshes, the mirror floor's scene).
- The name is a flat overlay (its choice), so it sits on the floor's reflection.

**Brief 11: did the agent build it the AtomCut way?** Yes.
- `world_create {starter: false}`, the word with `world_add {kind: "text"}` and the ring as a `torus` mesh (not an extruded stroke), `world_extrude {depth: 26, bevel: 5}` on the word, `neon` materials with `emission` in each colour, `world_look {bloom: {source: "emission"}}`, a dark wall mesh lit by coloured point lights near the sign.
- The flicker-on as `hold` keys on `material.emissionStrength` (the ring first, then the word), and a slow camera push. 8 `view_render` and 2 `view_frames` checks.

**Brief 11 gaps.**
- The hot pink washes to pale pink in the core of the letters: AgX tone mapping pulls bright saturated emission towards white. The skill's neon recipe could suggest `toneMapping: "neutral"` or a lower `emissionStrength` with more bloom; to try.
- Tubes: extruded type with a bevel reads as neon, but not as bent glass tube (a rounded profile along a stroke would need a sweep, phase E).

**Across both.** The flat-field mistake on `layer.set` appeared again (`properties`, `{property, value}`, `{fontSize}`): the third brief in a row. `layer.set` could accept AtomCut-like `{property, value}` and known style fields as aliases into `values`. Both agents tried Bash, Python or a missing tool once (refused by the runner); harmless.

## Run of 2026-10-29 (Q4, the sound pass: briefs 01, 03 and 06)

**Setup.** Skill 0.17.0 (sound is a required step of the loop; "The mix" section). Each brief now has a music bed in its media (CC0 tracks from OpenGameArt) and brief 06 six voiceover lines (edge-tts, `en-US-AndrewNeural`); files and sources in `~/uve-assets/benchmark-media/README.md`, copied in by `run.mjs`, which now records each export's ebur128 numbers. Sonnet, editor tools only, at most 90 turns. Contact sheets and `results.json` in `results/2026-10-29-q4/`.

| Brief | Turns | Time | Cost | Exported | Sound (ffmpeg, after the limiter fix) |
| --- | --- | --- | --- | --- | --- |
| 01 Title card | 19 | 60 s | $0.53 | yes | −14.5 LUFS, −1.5 dBTP; bed only, faded in and out |
| 03 Kinetic type | 20 | 80 s | $0.45 | yes | −14.1 LUFS, −1.5 dBTP; bed cut to 6 s, a pop on each word's entrance |
| 06 Promo | 44 | 237 s | $0.89 | yes | −15.2 LUFS, −1.3 dBTP; six voice lines tagged `voice`, bed tagged `music`, a library whoosh on each transition |

Before Q4 the exports of 01 and 03 had no sound stream at all, and 06 was −18.6 LUFS.

**What the agents did.** All three placed the bed with `soundBus: "music"` and volume-key fades, left the leveler on and read `loudness` from `export_video`. 06 tagged every voice line `voice`, found a whoosh with `sounds_list {query: "whoosh"}` and `sounds_use`, and put it on the transitions (`trigger: transition`, `anchor: "peak"`). 03 fired a quiet `pop` per word. 01 added no sounds on its motion (the recipe has a soft pop per title word): the skill's "a sound on each beat that matters" did not move it.

**Found and fixed.** The first exports of 06 read −0.8 dBTP (the app's meter −0.9): the limiter aimed at the ceiling itself, its cubic estimate of peaks between samples reads a little low, and AAC adds a tenth. The limiter now aims 0.5 dB under its ceiling (`LIMITER_HEADROOM_DB`, the final clamp stays at the ceiling), the same in preview and export; the numbers above are re-exports of the agents' saved projects. The 06 agent had also lowered the loudness target to −15 trying to fix the peak.

**Ducking.** 06's music bus alone, exported with and without its duck rule (loudness match off): 10.0 dB lower under every voice line. WAVs in `~/Videos/UVE benchmarks/q4-sound-pass/`.

**Gaps.** No transcription or beat detection, so 06's hook text ("FREE YOUR SOUND") does not match the spoken line ("Hear everything. Nothing else.") and cuts are not on the music's beat (AtomCut has `audio_analyze` and `media_transcribe`). The 06 agent needed three tries at `report_issue` (it sent a different set of fields each time). Product photos are gradient squares, so no earbuds are seen.

## Run of 2026-10-29 (Q5, stickers: brief 12)

- New brief `briefs/12-sticker-reactions.md` (a 6 s vertical "We shipped v2!" with stickers reacting one beat at a time; it never names tools). `run.mjs --only 12` (Sonnet): 26 turns, 62 s, $0.46, exported.
- The agent used `stickers_list` and `stickers_use` four times each: party popper, rocket, fire, thumbs up, all 3D at 280 px, each on its own beat with `pop-in` and a pop; the headline rises word by word and stays the focal point. Two tool errors (a `shadow` field name, `api_batch` unavailable once).
- Sound: −20.4 LUFS, −1.5 dBTP: pops only (the brief gives no bed), as the agent reported.
- Weak: the stickers stay to the end (no exits), the layout is loose (the four sit at the corners of a large empty area). Craft is Q9's.
- Files: `~/Videos/UVE benchmarks/q5-stickers/` (mp4, contact sheet).

## Run of 2026-10-29 (Q6, physics: brief 13)

- New brief `briefs/13-sticker-rain.md` (a 6 s 1920×1080 "WE'RE LIVE" with a sticker rain piling on the words and the floor, a gust halfway, a settle). `run.mjs --only 13` (Sonnet, skill 0.19.0): 42 turns, 193 s, $0.73, exported. A first try was cut off by the usage limit.
- The agent built it in five `api_batch` calls: 20 3D party stickers as active bodies, the headline passive, `physics.scene {walls: true, startMs: 700}`, a wind carrier keyed on `force.<id>.strength` for a gust at 3 s; it checked with `physics_inspect` and `view_frames`. The stickers pile on the letters and the floor, the gust shoves the pile right, all settled by about 5.5 s.
- Weak: it also added two invisible wall layers just outside the frame (redundant with `walls`); no impact sounds although the brief asks for a few (it read "no music file" as "no sound"), so the export is silent.
- Files: `~/Videos/UVE benchmarks/q6-physics/` (mp4, contact sheet, project, transcript).

## Run of 2026-10-29 (Q7, characters: brief 14)

- **Run 1** (Sonnet, 33 turns, 111 s, $0.80): placed an Open Peeps person as layers and brought it to life (blink, breathe, nod, talk; music bed under the voice), then stopped to ask for the words of the voice line, which it could not hear (no transcription tool), so nothing was exported. The brief now quotes the line ("Hear everything. Nothing else."). Kept in `~/Videos/UVE benchmarks/q7-characters/run1/`.
- **Run 2** (Sonnet): exported `14-talking-character.mp4` (6 s, −14.2 LUFS) and saved the project; the run was then stopped by the machine running low on memory, so `results.json` (turns, cost) and the contact sheet were not written (sheets made by hand: `14-sheet.png`, `14-sheet-talk.png`). The person (peep with an eyepatch) talks with the line (closed, round and open mouths in time), blinks and breathes; the caption builds word by word with a highlight on the word being said. Gaps against the recipe: the character is small in the frame (about a quarter of its height); no check that the eyes shut in a sampled frame.

## Run of 2026-10-29 (Q8, scripts: brief 15)

- Brief 15 (scripted chart, Sonnet): run 1 was cut by the account's usage limit after 7 turns; run 2 (23 turns, 117 s, $0.60) built the whole chart with one `script_save` and one `script_run` (`charts/signups-bar-chart.js`, data and timings as constants), checked it with `view_frames` and exported it, but silent: it skipped the beat sounds the skill requires (no bed available, and it added no ticks).
- Picture: six bars grow in turn from one baseline, values above and months below, June in the accent with an overshoot and a larger label, a 2.4 s hold; the scripted build is correct and readable. Gap: no sound at all, so the Q9 skill rewrite must make the beat sounds as unmissable in a script as in tool calls (the scene recipe should place `sounds` on each bar).

## Run of 2026-10-29/30 (Q9, craft and proof: the launch film 16a–16d, and brief 06 against HyperFrames)

**The launch film.** AtomCut's 130.6 s launch video rebuilt shot by shot in four acts (briefs `16a`…`16d`, one Sonnet run each through `run.mjs`, skill 0.22.0), same story and script with its claims made true for this editor (desktop, 400,000 icons, 38 effects, MP4 and GIF), narration generated with edge-tts. Acts joined with ffmpeg into `16-launch-film.mp4` (117.2 s) and judged with `compare.mjs` at 16 matched shot times (`~/Videos/UVE benchmarks/q9-launch/compare/`).

| Act | Turns | Time | Cost | Loudness |
| --- | --- | --- | --- | --- |
| 16a hook and problem (23.4 s) | 46 | 609 s | $1.90 | −14.2 LUFS, −1.5 dBTP |
| 16b the studio, the build begins (32.2 s) | 77 | 808 s | $2.37 | −16.0 LUFS, −1.1 dBTP |
| 16c physics, 3D, a character (22.6 s) | 96 | 687 s | $2.85 | −14.5 LUFS, −1.3 dBTP |
| 16d sound, effects, export, reveal (39.0 s) | 88 | 608 s | $2.31 | −14.7 LUFS, −1.4 dBTP |

| Sound, whole film | AtomCut | Ours |
| --- | --- | --- |
| Integrated loudness | −13.2 LUFS | −14.9 LUFS |
| True peak | −0.3 dBTP | −0.8 dBTP |
| Loudness range | 3.6 LU | 3.4 LU |
| Voice over bed (median speaking against pauses) | 9.6 dB | 8.4 dB |

- **Matches:** every one of the 16 beats is there and lands on its word: the mascot with editor selection boxes and name tags, the cream "video?" problem shot with three app tiles, the editor window with Free and No account pills, the notification that tips on "Groundbreaking", the typed word with a caret, a row of real cloud icons labelled by set that stops on one, draw-on and rain, drops landing on the letter outlines and the letters tumbling, the extruded word on a mirror floor with glowing spheres and a pink light, the cloud getting orange bones then a face that blinks by itself, the 4,555 counter over real library names, the pixelate "3 of 38", the file chips and the WATERMARK stamp, the end title, the tool calls typing in on cream, "Your turn." Word-by-word captions throughout, the voice clear over a ducked bed.
- **Still short of AtomCut, and why:**
  - *Character finish:* AtomCut's mascot is glossy with soft shading and a highlight; ours is a flat lavender cloud with a face. Missing: a "soft 3D" shading look for vector art (inner gradient plus highlight), and the agent kept the mascot small (about half AtomCut's size).
  - *Type:* act 1 set the wordmark in a thin geometric sans instead of a rounded heavy one, and our captions are about 70 % of AtomCut's size. Agent's choice (no fallback warning was raised), so the review line "measured, not guessed" did not catch it: the checklist needs "the type is the face the brief named" checked with `view_render {detail: "inspect"}`.
  - *3D depth:* our extrusion is shallower, the camera less dramatic (AtomCut starts inside the letters). Agent's choice; the tools allow it.
  - *End title:* AtomCut's is the real 3D word with depth of field; ours is 2D text with an extrude effect. The agent rebuilt it in 2D rather than reuse act 3's world (separate projects per act).
  - *Loudness:* 1.7 dB quieter overall and peaks 0.5 dB lower: our loudness match aims at −14 with a −1 dB ceiling by design.
  - *Lottie export* is not ours yet (said truthfully: "MP4. GIF.").
- **Cost of building:** 307 turns, 45 min of agent time and $9.43 for the film; the export itself is about real time (23 to 38 s per act). Tool errors were shape mistakes: `opacity` top-level on `layer_create` and `layer_set` (it is a property name to key, not a create field), `layers_restack {above}` instead of `to: {above}`, `keyframes_set` keys mixing `ease` into the `{at, value}` shape, a `glow` field `blur` (the card's field is `size`). Each was fixed by the agent from the hint in one more call.
- **SKILL.md is now about 36k tokens:** too big for one resource read, so every agent read it in parts (two or three calls). Splitting it into references is the next craft task.

**Brief 06 against HyperFrames** (`~/Videos/UVE benchmarks/q9-hyperframes/`). The same brief, media and model (Sonnet): HyperFrames 0.8.216 driven by its own skills (about 15 min, 42 calls), ours through `run.mjs` (59 turns, 700 s, $1.44).

| | HyperFrames | Ours (Q4, skill 0.17) | Ours (Q9, skill 0.22) |
| --- | --- | --- | --- |
| Integrated loudness | −14.1 LUFS | −15.2 LUFS | −14.4 LUFS |
| True peak | −1.9 dBTP | −1.3 dBTP | −1.4 dBTP |
| Voice over bed | 20.2 dB | 2.0 dB | 1.0 dB |

- **Picture:** HyperFrames' piece has more graphic ideas per beat (a big "30 HOURS" with a battery icon, waveform bars, the offer on a coloured field). Ours at skill 0.22 is fuller than at 0.17 (full-bleed photos, numbered beats "01 / 03", a glow behind the price) but plainer. HyperFrames adds no sound effects; ours pops on each entrance.
- **Sound:** the real gap. With a loud, dense bed (`music-promo.mp3`, −12.8 LUFS) and quiet voice lines (−19.5), the leveler (strength 0.8) leaves bed and voice about 2 dB apart before ducking, and ducking releases between the short lines, so the voice barely stands out. HyperFrames' "carve" ducks hard all through (the bed sits about 20 dB down, arguably too far). Skill 0.22.0 now tells the agent to pull the music fader to 0.6 in narrated pieces (added after this run started, so untested here; the launch film's documentary bed, quieter at source, landed at 8.4 dB without it). Next: test the fader rule, and consider the leveler at full strength on the music bus when a voice bus is present.
- **Found and fixed:** 271 s of the run went to `script_run` calls that stalled: Chromium throttles timers in a hidden or minimized window and the script host yields with `setTimeout(0)`. `backgroundThrottling: false` on the editor window; a 200-call script with the window minimized went from never finishing in 60 s to 8.2 s.

## Run of 2026-10-30 (S1, Sarvam: brief 06 in Hindi and Tamil, ours against Sarvam's Dubbing API)

Files in `~/Videos/UVE benchmarks/s1-sarvam/`: `06-en.mp4` (the Q9 export, the source of everything), `06-dub-{hi,ta}.mp4` (Sarvam Dubbing, voice cloning on, no watermark; job via `sarvam-dub.mjs`, with `dub/*.audio.wav` and `*.srt`), `06-ours-{hi,ta}.mp4` (`comp_localize`, Bulbul v3 `shubh`, formal register, `keep: ["Aurora", "aurora.audio"]`), `06-hybrid-{hi,ta}.mp4` (our translated comp with our sound muted, the dub's audio placed at 0, `media_transcribe {captions: true}` on it: Saaras phrases, our word alignment, one caption per phrase), the project `06-localized.uve` (all five frames), sheets `cmp-<lang>-dub-vs-{ours,hybrid}/compare.png` and `.md`; word times by faster-whisper `base` with the language set.

| | Dub hi | Ours hi | Hybrid hi | Dub ta | Ours ta | Hybrid ta |
| --- | --- | --- | --- | --- | --- | --- |
| Length | 15.0 s | 15.0 s | 15.0 s | 15.0 s | 15.5 s | 15.5 s |
| Integrated | −14.7 LUFS | −14.9 | −14.1 | −14.4 | −14.3 | −14.0 |
| True peak | −1.6 dBTP | −1.0 | −1.4 | −1.5 | −1.4 | −1.4 |
| Speaking / pauses | −14.3 / no pause ≥ 400 ms | −14.5 / −17.3 | −14.2 / −15.4 | −14.3 / −13.0 | −14.2 / −15.6 | −13.8 / −12.5 |

- **Timing:** ours keeps each scene's moment: a take that ran long was read up to 1.25× faster, then given room (Tamil: line 1 at pace 1.14 and +370 ms, line 3 at 1.25 and +100 ms; the film grew 470 ms). Hindi needed no room (one take at 1.02). The dub keeps the video's length exactly and fills it with continuous speech (no pause of 400 ms in Hindi).
- **Picture:** the dub leaves every on-screen word in English ("MUTE THE WORLD", "30-hour battery", "$79 — launch week only"); ours and the hybrid translate them, in Noto Sans Devanagari and Noto Sans Tamil behind the Latin face, and shrink a translated title that would leave its box (Tamil "MUTE THE WORLD" was off the frame before the fit).
- **Words:** Sarvam Translate (formal) said "उनहत्तर" (69) for "seventy-nine" in our Hindi; Tamil got 79 right. Mayura's colloquial register mixed English in and said 78 in Tamil, so the A/B uses formal. Saaras heard "29" in the Tamil dub's price. Numbers need a look in every language (`voice.md` says so).
- **Voice:** the dub clones the original narrator's timbre; ours is a Bulbul voice per language (same voice in both). Voice over bed is small everywhere (the loud promo bed of Q9), ours 2.8 dB in Hindi and 1.4 dB in Tamil, the dub −1.3 dB in Tamil (its pauses are louder than its speech).
- **Cost:** dubbing ₹21.33 (16 s × 2 languages); everything in the editor ₹6.47 (1,291 characters spoken, 1,180 translated, 31 s heard), most of it from re-runs while building; a cached take or translation costs nothing.
- **For the owner to judge by ear and eye:** the three versions per language side by side; the sheets show the on-screen text difference at a glance.
