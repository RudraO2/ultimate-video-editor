# Handoff

Updated 2026-10-30 (after M1). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

## Next task: step F1 (footage understanding and auto-cutting)

Owner's call (2026-10-30), before phase B: a person adds their own videos (talking head, screen recordings, B-roll) and the agent understands them and cuts: silences, filler words in any language, false starts and retakes, then places B-roll and screen recordings where the words call for them, fast and live on the timeline. Research done: `docs/research/atomcut-inspiration.md` ▸ "Footage understanding and auto-cutting (step F1 research)" (DaVinci Resolve MCP). After F1 comes B1 (screen recording); its prompt is kept in `docs/handoff-archive.md` ▸ "B1 prompt (deferred)".

Paste this into a new chat:

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY these sections,
never whole files (Grep the heading for its line, then Read with offset/limit): docs/HANDOFF.md
"Next task" and "Last chunk"; docs/research/atomcut-inspiration.md "Footage understanding and
auto-cutting (step F1 research)". Search docs/HISTORY.md only when a detail is needed (S1 for
media_transcribe and Sarvam STT; Q2 for media.envelope; M1 for the chat context; A4 for media).

Do ONE step only: F1, footage understanding and auto-cutting, whole, in this chat. Goal: a person
drops their own videos (talking head, screen recordings, B-roll) and asks in the chat, in any
language, "cut this" or "make a 60-second edit with B-roll"; the agent understands the footage and
the edit appears on the timeline within seconds, as one undo step, by hand and as MCP tools.
Build, as commands (registry, so they become tools; AtomCut-style names):
- analysis per media, cached and reused: word times (Sarvam STT, long files in 30 s pieces, any
  Indian language or English), speech/silence with a gate calibrated per clip
  (trough + 0.6 x (peak - trough), clamp -60..-24 dB, refuse below 12 dB range), shot changes
  (ffmpeg scene score, threshold mean + 2.5 sd clamped 0.15..0.40), and a contact sheet per shot
  range that the agent looks at with its own vision (text-only fallback when it can't see); the
  agent can store a one-line description per shot.
- media_remove_pauses / a transcript-tighten plan: silences, fillers per language (English and
  Hindi/Hinglish at least: um, uh, matlab, toh, haan, accha, basically, you know...), false starts
  (adjacent 1-4 word repeats within 0.6 s, first copy goes), long pauses with the breathing-room
  rule (x2.5 after . ? !, x1.5 after , ; :), handles, sliver merge, a reason per removal, swallowed
  retakes flagged; tightness generous (default) / balanced / tight. Plan, optional review markers,
  apply: applied in ONE transaction that cuts the clips in place (or into a new comp with
  `variant: true`), so the timeline updates at once and undo restores it.
- footage search (spoken words with in/out selects; shot descriptions) and B-roll placement:
  cutaways inside a sentence's span, inset 0.15 s, at least 0.8 s, never over protected beats,
  placed on the track above, picked by the agent from the search.
- the skill: a recipe "rough cut from raw footage" (analyse, plan, review, apply, B-roll, captions,
  sound pass), and a short Easy-mode example in the chat panel's suggestions.
Research more only if needed (how AtomCut's media_remove_pauses and media_transcribe take input:
its MCP tool schemas via ToolSearch). First write the lettered sub-steps (F1a, F1b, ...) under a new
"Plan of F1" in docs/HANDOFF.md, start at once and run through every sub-step without stopping (no
plan mode, no waiting for approval). Owner's rule: build everything first and test once at the end;
usage is limited. After each sub-step: tests and type checks pass, update the "F1 progress" note,
commit and push to main (owner is the only author; no AI attribution). Delegate bounded pieces to
Sonnet subagents on separate files; the main chat verifies. Main-process changes and new files under
skill/ need a restart of pnpm dev (start it with SARVAM_API_KEY set from the user environment). At
the end, in the running app: make a 1-2 minute talking-head test file with pauses, fillers and a
retake (Sarvam TTS lines joined with ffmpeg silences, in the session scratchpad) plus a
screen-recording-like clip, and ask OpenCode in Easy mode to cut it and add the recording as B-roll;
time it. Then follow the end-of-step rule at the top of docs/HANDOFF.md, update docs/PLAN.md and the
Status in CLAUDE.md in one or two lines (details go to docs/HISTORY.md), commit and push, and end
your reply with the prompt for the next step (B1, from the archive).
```

## Plan of F1 (written 2026-10-30)

Times: analysis is in media time; a layer maps it to comp time by `startMs + (mediaMs - sourceStartMs) / playbackRate`.

- **F1a, core.** Format 19: `media.footage` (gate, speech ranges, shots with descriptions, scene threshold) and comp `markers` (review marks). Pure module `packages/core/src/footage.ts`: gate calibration (trough + 0.6 × (peak − trough), clamp −60…−24 dB, refuse under 12 dB), speech ranges from 20 ms loudness, scene threshold (mean + 2.5 sd, 0.15…0.40) and shots, filler lists per language (English, Hindi in Devanagari and Latin, a few more Indian languages), tighten plan (head/tail air, long pauses with breathing room ×2.5 / ×1.5, fillers, false starts, retakes, handles, slivers, reasons, swallowed-retake flags; generous/balanced/tight), sentences, footage search (words with in/out selects, shot descriptions), B-roll placement (inside a sentence, inset 0.15 s, ≥ 0.8 s, never over protected beats, relevance ≥ 0.35), media↔comp time. Core commands `media.footage` (store), `media.describe_shots`, `timeline.markers`. Tests.
- **F1b, analysis (desktop).** `media.analyze` (loudness gate and speech ranges from the decoded sound; Sarvam STT in verbatim mode, ≤ 30 s pieces, words aligned; shots from a frame-difference scene score over small frames via mediabunny; cached on the media, reused); host tool `media_inspect` (contact sheet of a shot or range of a media file, with the words spoken in it; text-only answer with `frames: 0`). Sarvam STT `mode`.
- **F1c, cutting (desktop).** `media.remove_pauses` (AtomCut's shape plus `tightness`, `fillers`, `falseStarts`, `retakes`, `markers`, `variant`): dryRun gives the plan with reasons; apply cuts in one step (in place via `timeline.cut_ranges`, or into a duplicated frame with `variant`). `media.search`, `timeline.place_broll`.
- **F1d, by hand.** Inspector ▸ Footage section on video/audio layers (Analyse, transcript and shots, tightness, Mark, Cut, as new comp); timeline draws markers; chat example in Easy mode.
- **F1e, skill and docs.** Skill 0.25.0: "Footage" section and recipe "Rough cut from raw footage" (analyse, plan, review, apply, B-roll, captions, sound pass); `docs/core-api.md` rows.
- **F1f, live test.** Talking-head test file (Sarvam TTS lines, pauses, fillers, a retake) and a screen-recording-like clip; OpenCode in Easy mode cuts and adds B-roll; timed. End-of-step docs.

### F1 progress

- F1a, F1b, F1c done (code; live check at F1f): format 19 (`media.footage`, comp `markers`), `core/src/footage.ts` (+ tests), core commands `media.footage`, `media.describe_shots`, `timeline.markers` (`commands/footage.ts`); desktop `agent/footageCommands.ts` (`media.analyze`, `media.remove_pauses`, `media.search`, `timeline.place_broll`), `agent/footageInspect.ts` (host tool `media_inspect`), `media/footageFrames.ts` (scene scores, stills); Sarvam STT `mode: verbatim` (main change: restart `pnpm dev`), `media.transcribe {mode}`.

## Last chunk: M1, Easy and Advanced modes, speaking to the chat (2026-10-30)

- Done as six sub-steps (plan and progress log in `docs/handoff-archive.md` ▸ "O1 last chunk, M1 plan and progress"); files and names in `docs/HISTORY.md` ▸ M1; AtomCut findings in `docs/research/atomcut-inspiration.md` ▸ "Easy and Advanced modes (step M1 research)".
- Built: `uiMode.ts` and store `uiMode` (Easy on first launch, remembered in `uve.uiMode`), the Easy/Advanced switch in the left rail and Main menu ▸ View, the Easy layout (Chat, Media, Library tabs; chat 380 px; preview; `Timeline simple`; Export only on the right rail), `agent/chatContext.ts` (editor context sent ahead of every prompt, unseen in the transcript), `agent/micRecorder.ts` and the chat's mic button (Sarvam STT, any language).
- Test: "इसे लाल कर दो" with a title selected turned it red in about 8 s and OpenCode answered in Hindi; the mic recorded, Sarvam transcribed and the chat sent it; Advanced showed the same project with every panel; the mode survived a reload.
- Git (owner's rule from 2026-10-30): commit and push to `main` of `github.com/RudraO2/ultimate-video-editor` (private) after every sub-step, without asking; the owner is the only author.
- Loose ends: the owner has not yet spoken a real sentence to it (only room sound was tested); no push-to-talk key; panel sizes per mode are not remembered; the Advanced Agents tab holds the same chat as Easy's Chat tab.

## Plan of Phase Q

Rule for every sound step (Q2 to Q4): the mix is computed once, as data (gains per segment, per cue and per bus over time), by pure code in `packages/engine`; the export mix and the preview's Web Audio graph both apply that data, so they sound the same. Compressors (speech, limiter) run as our own DSP in the export; the preview runs the same code in an AudioWorklet, so preview and export match.

**Q2, the mix: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q1 last chunk, Q2 plan and progress".

**Q3, the sounds: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q2 last chunk, Q3 plan and progress".

**Q4, the sound pass in the skill: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q3 last chunk, Q4 plan and progress".
**Q5, stickers and images: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q4 last chunk, Q5 plan and progress".

**Q6, physics: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q5 last chunk, Q6 plan and progress".

**Q7, characters: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q6 last chunk, Q7 plan and progress".

**Q8, scripts: done 2026-10-29.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q7 last chunk, Q8 plan and progress".

**Q9, craft and proof: done 2026-10-30.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q8 last chunk, Q9 plan and progress". **Phase Q is complete.**

**Q10, sound choice, seamless 2D↔3D, one continuous film: done 2026-10-30.** Plan and progress log in `docs/handoff-archive.md` ▸ "Phase Q: Q9 last chunk, Q10 plan and progress".

Deferred until after phase Q and the Sarvam work: Phase B chunk B1 (its prompt) and the A7 follow-ups ("A7o": WebGL context loss hangs an export, glass transmission, AgX washing neon, flat fields on `layer.set`), in `docs/handoff-archive.md` ▸ "Deferred".

## How the MCP works, end to end

1. An agent app (Claude Code, Codex, Gemini CLI, OpenCode, Cursor and so on) connects to `http://127.0.0.1:7428/mcp` with the bearer token from `~/.uve/mcp.json`. Apps limited to stdio run the `uve-mcp.mjs` shim instead.
2. At connect, the app lists the tools and reads the skill (`uve://skill/SKILL.md`, from `skill/`). The skill teaches the loop: orient, plan, build in batches, look at renders, refine, report.
3. Each tool call goes from the main process (`apps/desktop/src/main/agent.ts`) over IPC to the renderer (`renderer/src/agent/host.ts`). The renderer runs it through `session.call`, the same commands the UI uses, so the user sees every change live.
4. Results come back as JSON text, or as images for `view_render` and `view_frames`. Those images are drawn exactly as the export draws.
5. The conversation lives in the agent app. Each user message becomes a run of tool calls, and calls made within 45 s of each other are one undo step ("Agent · <app>").
6. Checked: headless Claude Code (Sonnet) made all seven benchmark videos, from brief to MP4, in 15 to 28 turns each.
7. Not possible yet: voiceover, captions, transitions and effects. Saving (`project_save`) and exporting (`export_video`) work, so a brief can end in an MP4.

## The bar (set by the owner)

Full AtomCut parity, at AtomCut's quality:
- every AtomCut feature, robust, by hand and as a command;
- every MCP tool working properly, accepting AtomCut's input shapes too;
- agent-made videos as good as AtomCut's;
- all of AtomCut's assets.

The foundation is fixed first. See "The bar" and sections 0 and 9 in `docs/atomcut-parity.md`, and A6b in `docs/PLAN.md`.

## Big picture: what AtomCut's shell still has that we lack

From the owner's 4.17.0 screenshot (2026-10-26), recorded in `docs/atomcut-parity.md` ("UI that goes with these"): the right rail's vertical tabs are Design, Effects, Animate, Physics, Sound (we have all but Physics, which arrives with physics in phase E); the left rail has Scripts (with the scripts group, not done) and, at its foot, layout, report-issue and Settings buttons; the inspector has an Align row and header actions (key all, to 3D, duplicate, delete); the toolbar has a Frame tool and drawing tools (flipbooks, phase E); the viewport has a quality pill ("Full"). The Align row and header actions are small and can come before A7; the order is set when A10 ends.

