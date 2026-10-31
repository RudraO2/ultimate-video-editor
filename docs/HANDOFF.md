# Handoff

Updated 2026-10-31 (after M2). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

## Next task: step B1 (phase B starts: screen recording)

B1 is one chat: it writes phase B's numbered steps into `docs/PLAN.md` (if missing), then its own plan (lettered sub-steps B1a, B1b, … under a new "Plan of B1" here), then does them all, saving a "B1 progress" note here after each and committing and pushing to `main` after each.

Paste this into a new chat:

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY these sections,
never whole files (Grep the heading for its line, then Read with offset/limit): docs/HANDOFF.md
"Next task" and "Last chunk"; docs/PLAN.md "Later phases" (Phase B) and key decision 5 (OpenScreen
is reused in Phase B). Search docs/HISTORY.md only when a detail is needed (M1 for the modes and
chat; A4 for media import).

Phase B (OpenScreen features) starts now. First, if docs/PLAN.md has no numbered phase B steps, write
them there (B1, B2, … each one chat: recorder and capture helpers, cursor telemetry and auto-zoom as
editable zoom keyframes, background/padding/rounded corners/shadow as layer properties, agent tools
and skill). Then do ONE step only: B1, screen recording, whole, in this chat. Goal: record the screen
(a display or a window, with system audio and the mic, optional webcam) from inside the editor, by
hand and as an agent tool; the recording lands in the project as a clip (the file stays on disk, as
every media file), with its cursor positions and clicks kept beside it for B2's auto-zoom. Research
first: OpenScreen (MIT) on GitHub, its native capture helpers (Windows Graphics Capture), cursor
telemetry and file layout; what Electron's desktopCapturer gives on Windows 11 with the Intel GPU
only; keep OpenScreen's MIT notice for anything ported. It must work in both Easy and Advanced modes
and from the chat ("record my screen for 20 seconds"). First write the lettered sub-steps (B1a, B1b,
...) under a new "Plan of B1" in docs/HANDOFF.md, start at once and run through every sub-step
without stopping (no plan mode, no waiting for approval). Owner's rule: build everything first and
test once at the end; usage is limited. After each sub-step: tests and type checks pass, update the
"B1 progress" note, commit and push to main (owner is the only author; no AI attribution). Delegate
bounded pieces to Sonnet subagents on separate files; the main chat verifies. Main-process changes
and new files under skill/ need a restart of pnpm dev (start it with SARVAM_API_KEY set from the user
environment). At the end, record a short clip in the running app by hand and once through OpenCode;
then follow the end-of-step rule at the top of docs/HANDOFF.md, update docs/PLAN.md and the Status in
CLAUDE.md in one or two lines (details go to docs/HISTORY.md), commit and push, and end your reply
with the prompt for the next step (B2).
```


### Plan of B1

Source: getopenscreen/openscreen (MIT, commit f789451 of 2026-10-31), where OpenScreen continues (the siddharthvaddem repo is archived). Owner: bare minimum features, the cursor recorded exactly as it looks and moves.

- **B1a helpers:** vendor OpenScreen's `wgc-capture` source (only what `wgc-capture.exe` and `cursor-sampler.exe` need) into `apps/desktop/native/wgc-capture/` with its MIT notice; `scripts/build-wgc.mjs` builds it with VS Build Tools (fresh C++/WinRT headers from the system's own metadata, a small SDK-compat header); prebuilt exes in `apps/desktop/native/bin/win32-x64/`.
- **B1b main process:** `shared/recording.ts` (types, options, file names, cursor sample normalisation ported from OpenScreen, tests); `main/recorder.ts` (sources from `desktopCapturer` and `screen`, start: editor minimised for a display, helper and sampler spawned, a small HUD with time and Stop that is kept out of the capture; stop: `stop` on stdin, sidecar `<video>.cursor.json` written, file granted, editor restored; auto-stop after `durationMs`); preload `window.uve.recorder`.
- **B1c by hand:** a Record button on the right rail under Export (both modes) opens a small dialog: source (displays and windows with thumbnails), system audio, microphone, webcam; the finished recording is imported and placed at the playhead (an empty comp takes its size).
- **B1d agents:** `screen_record` tool (source by name or default the main display, durationMs, audio switches, place), skill note; the chat's "record my screen for 20 seconds" goes through it.
- **B1e check and docs:** tests, type checks, build; record by hand and through OpenCode in the running app; HISTORY, PLAN, CLAUDE.md, README.

### B1 progress

- B1a done: OpenScreen's helpers vendored in `apps/desktop/native/wgc-capture/` (MIT notice, README), `apps/desktop/scripts/build-wgc.mjs` builds them with VS 2019 Build Tools (C++/WinRT 2.0.210806.1 generated from the system's metadata; newer generators crash cl 14.29; `src/sdk_compat.h` for SDK 19041), prebuilt `wgc-capture.exe` (572 KB) and `cursor-sampler.exe` (300 KB) in `native/bin/win32-x64/`. Smoke test: 1920x1080 30 fps H.264 + AAC system sound, fragmented MP4, cursor drawn by Windows (`cursor-capture applied`).
- B1b done: `shared/recording.ts` (contract, OpenScreen's sample normalisation, `CursorCollector`, helper config; 19 tests), `main/recorder.ts` (`recorder:sources|start|stop|state`, events `recorder:state` and `recorder:finished`; editor minimised for a display; sampler then helper; HUD with timer and Stop kept out of the capture by `setContentProtection`; sidecar on stop; stop on quit), preload `window.uve.recorder`.
- B1c done: Record button under Export on the right rail (both modes; pulses red while recording, click stops), `RecordDialog` (sources with thumbnails, computer sound, microphone, webcam), `recording/recorder.ts` imports each finished recording at the playhead (an empty comp takes its size).
- B1d done: `screen_record` host tool (`durationMs` required, `source` by name or id via `matchSource`, `systemAudio`, `microphone`, `webcam`, `place`, `library`), skill 0.27.0 "Screen recordings". Tests 1425, type checks pass. Next: B1e (live check by hand and through OpenCode, docs).

## Last chunk: M2, outside agents drive the editor over MCP (2026-10-31)

Plan: M2a port and recommended setup, M2b Claude Code, M2c Codex, M2d checks (undo across agents, AtomCut shapes, errors, editor closed), M2e docs. Details in `docs/HISTORY.md` ▸ M2. Progress log:

- M2a done: why 7428 was busy: the editor has no single-instance lock, so a second copy (a second `pnpm dev`, or an Electron that outlived a stopped `pnpm dev`, see CLAUDE.md) holds 7428; the newer copy falls back to a free port and rewrites `~/.uve/mcp.json`. HTTP entries saved with :7428 then point at the other copy or at nothing. Fix: the Connect dialog and README now recommend the stdio shim for every app that starts programs (Claude Code, Codex, Gemini CLI, OpenCode `type: local`, Cursor, VS Code, Claude Desktop); it reads url and token from `~/.uve/mcp.json` each start. HTTP stays under "Any other". No single-instance lock added (an orphaned dev Electron would then swallow new launches).
- M2b done: `claude mcp add -s user uve -- node "%APPDATA%\@uve\desktop\uve-mcp.mjs"` (the dialog's command; dev builds' user data is `@uve\desktop`), `claude mcp get uve` shows Connected. Headless `claude -p ... --allowedTools "mcp__uve__*" --model sonnet` (Claude Code 2.1.316): imported the 41.7 s clip into a 1080x1920 comp, title "AI Slop on LinkedIn", pauses cut (balanced) to 36.6 s, in 51 s and 30 turns, no fix needed. Seen live over CDP; one undo ("Agent · claude-code") put the empty project back.
- M2c done: Codex CLI 0.164.0. `codex mcp add uve -- node "<shim>"` adds it, but Codex then asks before every MCP call, and `codex exec` refuses them all ("MCP tool call requires approval, but approval policy is never"). Fix: `default_tools_approval_mode = "approve"` in `[mcp_servers.uve]` (Codex's `AppToolApproval`: auto, prompt, writes, approve); the dialog's Codex entry and README now give the whole `config.toml` table. The owner's configured model `gpt-6.1-sol` is refused for a ChatGPT login, so runs used `-m gpt-5.6-terra` (config untouched; backup of config.toml in the session scratchpad). `codex exec` did the same task in 100 s: 480x854 comp, title "LinkedIn's AI Slop", pauses cut to 29.4 s; seen live; one undo step "Agent · codex-mcp-client". On the way it guessed shapes (`media_import {path}`, `media_analyze {mediaId}`, `catalog_list {category}`, `layer_set {fontSize}`, `view_frames {startMs, endMs}`); each error named the right field or pointed at `api_describe`, and it recovered at once.
- M2d done, nothing broke: (1) Undo across agents, both ways, real apps: OpenCode in the app added a layer (7 s, step "Agent · opencode"); headless Claude Code's `history_undo` answered "The newest undo step is "Agent · opencode", which is not yours, so it stays. Fix forward instead."; then Claude Code added a layer and OpenCode's `history_undo` got the same refusal; both layers stayed. (2) AtomCut shapes through the shim (scratchpad `m2/shim-check.mjs`): `keyframes_set {property, keys: [{at, value, easing}]}`, position `arc`, `layer_set {ids: [..] | id, values, mode, atMs}`, `timeline_trim {endMs}`, `view_frames {frameId, fromMs, toMs, count, detail}`, `view_render {frameId, atMs}` all OK. (3) Errors read well: unknown layer, unknown property (lists the animatable ones), bad enum, missing file (shim resolves a relative `localPath` against the agent's folder), unknown tool. (4) Editor closed (scratchpad `m2/offline-check.mjs`, `UVE_MCP_CONNECTION` at a dead port): initialize answers with the offline instructions, `tools/list` is `uve_status` only, other calls fail with "open the editor"; when the file names a live server the shim connects, sends `tools/list_changed` and lists 135 tools. Headless Claude Code with the editor "closed" told the user to open it. Note: editing `apps/desktop/src/shared/*` fully reloads the renderer (clears the in-memory project), like core edits.
- M2e done: tests (1401), type checks and build pass; the Connect dialog checked in the app (Codex tab shows the `config.toml` table); docs updated (README, PLAN, HISTORY, CLAUDE.md).

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

