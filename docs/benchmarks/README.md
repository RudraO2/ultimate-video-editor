# Quality benchmark

**Why.** The bar for agent-made videos is AtomCut's quality. These briefs turn AtomCut's own skill recipes (`references/recipes.md` in `@atomcut/mcp` 3.6.0) into requests a user would type. Each brief is run through a headless Claude Code session that drives the editor over MCP, and the result is compared with what AtomCut's recipe achieves. The gaps found order the work in A8 and A9.

**The briefs** (`briefs/`): each has the text sent to the agent, AtomCut's recipe for it (the bar), and the media the runner puts in the project first.

| Brief | Format | Tests |
| --- | --- | --- |
| 01 Title card | 1920×1080, 5 s | type hierarchy, left-aligned stack, staggered per-unit entrances, glow, sound |
| 02 Lower third | 1920×1080, 6 s, over footage | grouped pill and texts, layout, in and out motion, safe area |
| 03 Kinetic type | 1080×1920, 6 s | one word at a time, varied entrances on a beat, colour flash, motion blur, hits |
| 04 Lyric captions | 1080×1920, 12 s, a song | caption states (unread, focus, read), scrolling stack, timing to lines |
| 05 Reel | 1080×1920 from a 20 s landscape video | nesting, cover fit, cuts, punch-ins, captions, title card |
| 06 Promo | 1080×1920, 15 s, 3 photos and a logo | beats, transitions, price emphasis, end card, pacing, sound |
| 07 Logo reveal | 1920×1080, 4 s | path layers, draw-on strokes, fills, shine, per-letter wordmark |
| 08 Hopping logo | 1920×1080, 4 s | bounces as arcs (gravity), squash at contacts, a flowing route through waypoints, per-letter wordmark |
| 09 Title in space | 1920×1080, 5 s | a 3D world with no jump on the way in, a camera move that ends square, parallax between lines, a lit sheen |
| 10 Product turntable | 1920×1080, 6 s | a product built from meshes with materials, a floor, a camera orbiting on a controller (`world_track`), studio lights, a counter-turn |
| 11 Neon logo | 1920×1080, 5 s | text and a ring extruded, neon materials, bloom from emission only, a dark lit wall, a flicker-on, a camera push |

**Running them.** With the editor running (`pnpm dev`), and `claude` and `ffmpeg` on the PATH:

```
node docs/benchmarks/run.mjs --out <a folder outside the repo> [--only 01,03] [--model sonnet] [--max-turns 60]
```

For each brief the runner saves whatever is open (to the output folder), starts a new project, imports the brief's test media (made with ffmpeg on the first run), and runs `claude -p` with only the editor's MCP tools allowed (`--strict-mcp-config`). The agent is asked to export the video with `export_video` and save the project with `project_save`. The runner then makes a 4×3 contact sheet of the export and writes `results.json` (time, turns, cost, whether it exported, the tool calls that failed with their errors, and the agent's own report). The full transcript is kept as `<brief>.agent.jsonl`.

**Media.** Test media the runner generates with ffmpeg is the default; real files (CC0 music and the six voice lines of brief 06) live outside the repository in `~/uve-assets/benchmark-media/` (with a README on sources and licences) and are copied in when a brief names them. After each export the runner measures its sound (audio stream, integrated LUFS, true peak) into `results.json` as `sound`.

**Side by side.** `compare.mjs` judges two videos (a reference and ours): one contact sheet pairing their frames (at the same fraction of each, or at given shot times) and a sound table (integrated loudness, true peak, loudness range, and with word times from `transcribe.py` the median loudness while speaking against pauses: how far the voice stands over the bed).

```
py -3 -P docs/benchmarks/transcribe.py <video> <words.json>
node docs/benchmarks/compare.mjs --a <reference> --b <ours> --out <folder> --labels "AtomCut,Ours" --a-words a.json --b-words b.json
```

**The launch film (16a to 16d).** AtomCut's launch video rebuilt shot by shot in four acts, one run each, with the same story and its claims made true for this editor; the narration is generated (`vo-16-*.wav`, see the media README). The acts are joined with ffmpeg and compared with the original by `compare.mjs`.

**Judging.** Compare each contact sheet and video with the recipe, on type, layout, motion, effects, sound and pacing. Record what is missing, and why (a missing feature, a missing tool, or the agent's choice), in `results.md`.

**Results:** see `results.md`.
