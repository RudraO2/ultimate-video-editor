# Handoff

Updated 2026-10-31 (after B1). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

## Next task: step B2 (auto-zoom on clicks)

B2 is one chat: it writes its own plan (lettered sub-steps B2a, B2b, … under a new "Plan of B2" here), then does them all, saving a "B2 progress" note here after each and committing and pushing to `main` after each.

Paste this into a new chat:

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY these sections,
never whole files (Grep the heading for its line, then Read with offset/limit): docs/HANDOFF.md
"Next task" and "Last chunk"; docs/PLAN.md "Later phases" (Phase B steps). Search docs/HISTORY.md only
when a detail is needed (B1 for the recorder, the cursor sidecar and its timing; A5/A6 for keyframes).

Do ONE step only: B2, auto-zoom, whole, in this chat. Goal: a screen recording gets zooms on its
clicks and where the cursor dwells, as ordinary editable keyframes on the clip (scale and position,
eased in and out, held while the action lasts, merged when clicks are close), by hand (a button on a
video clip that has a `<video>.cursor.json` beside it, both modes) and as an agent tool; the chat's
"zoom in on my clicks" goes through it. Read the sidecar written by B1 (OpenScreen's layout:
samples with cx/cy fractions, interactionType click/mouseup, surface). Research first: how
getopenscreen/openscreen (MIT) plans its auto-zooms from cursor telemetry (src/ and crates/; its
zoom depth, duration, easing, follow-cursor rules); port the logic with its MIT notice, keep it the
bare minimum (owner's rule). Note from B1: a maximised window's sampler bounds include the 11 px
invisible frame; correct for it. First write the lettered sub-steps (B2a, B2b, ...) under a new
"Plan of B2" in docs/HANDOFF.md, start at once and run through every sub-step without stopping (no
plan mode, no waiting for approval). Build everything first and test once at the end; usage is
limited. After each sub-step: tests and type checks pass, update the "B2 progress" note, commit and
push to main (owner is the only author; no AI attribution). Delegate bounded pieces to Sonnet
subagents on separate files; the main chat verifies. Main-process changes and new files under skill/
need a restart of pnpm dev (start it with SARVAM_API_KEY set from the user environment). At the end,
record a short clip with a few clicks (the Record button or screen_record), auto-zoom it by hand and
once through OpenCode, export it and look at the frames; then follow the end-of-step rule at the top
of docs/HANDOFF.md, update docs/PLAN.md and the Status in CLAUDE.md in one or two lines (details go
to docs/HISTORY.md), commit and push, and end your reply with the prompt for the next step (B3).
```

## Last chunk: B1, screen recording (2026-10-31)

Details in `docs/HISTORY.md` ▸ B1.

### Plan

Source: getopenscreen/openscreen (MIT, commit f789451 of 2026-10-31), where OpenScreen continues (the siddharthvaddem repo is archived). Owner: bare minimum features, the cursor recorded exactly as it looks and moves.

- **B1a helpers:** vendor OpenScreen's `wgc-capture` source (only what `wgc-capture.exe` and `cursor-sampler.exe` need) into `apps/desktop/native/wgc-capture/` with its MIT notice; `scripts/build-wgc.mjs` builds it with VS Build Tools (fresh C++/WinRT headers from the system's own metadata, a small SDK-compat header); prebuilt exes in `apps/desktop/native/bin/win32-x64/`.
- **B1b main process:** `shared/recording.ts` (types, options, file names, cursor sample normalisation ported from OpenScreen, tests); `main/recorder.ts` (sources from `desktopCapturer` and `screen`, start: editor minimised for a display, helper and sampler spawned, a small HUD with time and Stop that is kept out of the capture; stop: `stop` on stdin, sidecar `<video>.cursor.json` written, file granted, editor restored; auto-stop after `durationMs`); preload `window.uve.recorder`.
- **B1c by hand:** a Record button on the right rail under Export (both modes) opens a small dialog: source (displays and windows with thumbnails), system audio, microphone, webcam; the finished recording is imported and placed at the playhead (an empty comp takes its size).
- **B1d agents:** `screen_record` tool (source by name or default the main display, durationMs, audio switches, place), skill note; the chat's "record my screen for 20 seconds" goes through it.
- **B1e check and docs:** tests, type checks, build; record by hand and through OpenCode in the running app; HISTORY, PLAN, CLAUDE.md, README.

### Progress

- B1a done: OpenScreen's helpers vendored in `apps/desktop/native/wgc-capture/` (MIT notice, README), `apps/desktop/scripts/build-wgc.mjs` builds them with VS 2019 Build Tools (C++/WinRT 2.0.210806.1 generated from the system's metadata; newer generators crash cl 14.29; `src/sdk_compat.h` for SDK 19041), prebuilt `wgc-capture.exe` (572 KB) and `cursor-sampler.exe` (300 KB) in `native/bin/win32-x64/`. Smoke test: 1920x1080 30 fps H.264 + AAC system sound, fragmented MP4, cursor drawn by Windows (`cursor-capture applied`).
- B1b done: `shared/recording.ts` (contract, OpenScreen's sample normalisation, `CursorCollector`, helper config; 19 tests), `main/recorder.ts` (`recorder:sources|start|stop|state`, events `recorder:state` and `recorder:finished`; editor minimised for a display; sampler then helper; HUD with timer and Stop kept out of the capture by `setContentProtection`; sidecar on stop; stop on quit), preload `window.uve.recorder`.
- B1c done: Record button under Export on the right rail (both modes; pulses red while recording, click stops), `RecordDialog` (sources with thumbnails, computer sound, microphone, webcam), `recording/recorder.ts` imports each finished recording at the playhead (an empty comp takes its size).
- B1d done: `screen_record` host tool (`durationMs` required, `source` by name or id via `matchSource`, `systemAudio`, `microphone`, `webcam`, `place`, `library`), skill 0.27.0 "Screen recordings". Tests 1425, type checks pass. Next: B1e (live check by hand and through OpenCode, docs).
- B1e done: live checks by hand (14.2 s display, 892 cursor samples, 1 click, cursor in the video where the sidecar says, Stop bar left out), `screen_record` over MCP on a window, and OpenCode in Easy mode ("record my screen for 6 seconds", clip placed). Two fixes found on the way: the fragment index (`mfra`) cut off each recording (mediabunny read the file 5 % long), and the agent relay no longer takes the Stop bar for the editor reloading. Docs: README, PLAN, HISTORY, CLAUDE.md.

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

1. An agent app (Claude Code, Codex, Gemini CLI, OpenCode, Cursor and so on) starts the `uve-mcp.mjs` stdio shim (recommended since M2), which relays to `http://127.0.0.1:7428/mcp` (or the port the editor fell back to) with the bearer token, both read from `~/.uve/mcp.json` on each start. Apps that only take HTTP connect to that URL with the token.
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

