# Handoff

Updated 2026-10-30 (after O1). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

## Next task: step M1 (Easy and Advanced modes)

M1 is one chat: it writes its own plan (lettered sub-steps M1a, M1b, … under a new "Plan of M1 (modes)" here), then does them all, saving an "M1 progress" note here after each.

Paste this into a new chat:

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY these sections,
never whole files (Grep the heading for its line, then Read with offset/limit): docs/HANDOFF.md
"Next task" and "Last chunk"; docs/PLAN.md "Phase Q" status lines (the ones naming Easy and
Advanced modes) and "Order of work"; docs/research/atomcut-inspiration.md "OpenCode inside the app
(step O1 research)". Search docs/HISTORY.md only when a detail is needed (O1 for the chat panel).

Do ONE step only: M1, Easy and Advanced modes, whole, in this chat. Goal: the editor opens in an
Easy mode for people who just want a video (the OpenCode chat front and centre, the preview, a
simple timeline, export; the agent does the work, the person nudges it), and an Advanced mode with
every panel as now (inspector, keyframes, curves, nodes, colour, mixer, all rail tabs). One switch,
remembered across launches; both modes edit the same project through the same commands, so work
moves freely between them. Research first: how AtomCut presents its simple and pro surfaces (study
the live app over CDP if REA is up; else its bundled web-out), and what a first-time person needs to
see. Decide which panels and controls each mode shows; match AtomCut's look. First write the lettered
sub-steps (M1a, M1b, ...) under a new "Plan of M1 (modes)" in docs/HANDOFF.md, start at once and run
through every sub-step without stopping (no plan mode, no waiting for approval). Owner's rule
(2026-10-30): build everything first and test once at the end; usage is limited. After each
sub-step: tests and type checks pass, then update the "M1 progress" note. Delegate bounded pieces to
Sonnet subagents on separate files; the main chat verifies. Main-process changes and new files under
skill/ need a restart of pnpm dev (start it with SARVAM_API_KEY set from the user environment; dev
does not rebuild the main process on edits). At the end, check both modes in the running app, with
one short request to OpenCode in Easy mode; then follow the end-of-step rule at the top of
docs/HANDOFF.md, update docs/PLAN.md and the Status in CLAUDE.md in one or two lines (details go to
docs/HISTORY.md), and end your reply with the prompt for the next step (phase B, per docs/PLAN.md).
Commit only when I ask; no AI attribution.
```

## Last chunk: O1, OpenCode as the only harness in the app (2026-10-30)

- Done as six sub-steps (plan and progress log in `docs/handoff-archive.md` ▸ "S1 last chunk, O1 plan and progress"); files and names in `docs/HISTORY.md` ▸ O1; ACP facts in `docs/research/atomcut-inspiration.md` ▸ "OpenCode inside the app (step O1 research)".
- Built: `main/opencode.ts` (finds or installs OpenCode 1.18.32, writes its own config folder and work folder with `AGENTS.md` and the skill, runs `opencode acp`, ACP client, permission questions relayed, Stop, model and effort, provider key with `safeStorage`), `shared/opencode.ts` (status, events, transcript reducer), preload `window.uve.opencode`, `components/ChatPanel.tsx` in the Agents tab (OpenCode / Other apps).
- Permissions (owner's call): video work only, no questions: editor tools, read, search, web; file edits denied; shell runs media commands (`ffprobe`, `ffmpeg`, list, copy, move, mkdir) and asks for anything else.
- Test: brief 01 (The Quiet Coast) made by OpenCode in the app on `opencode/glm-5.3-flash-free` (free, $0): 27 tool calls, none failed, own `view_frames`/`view_render` check, exported at −14 LUFS / −3.3 dBTP. In `~/Videos/UVE benchmarks/o1-opencode/` (`01-title-card-opencode.mp4`, `frames.png`).
- Key: a new OpenCode Zen key saved by the owner in the panel (encrypted in `<user data>/opencode/key.bin`); OpenCode's own `auth.json` Zen key is expired.
- Loose ends: chats are not kept across restarts (OpenCode can list and resume sessions: not wired); OpenCode is found on the machine, not bundled in a packaged build (no packaging config yet); the free GLM once claimed a tool result without calling the tool; the panel shows two titles (Agents, OpenCode); CDP `fill` does not reach React's textarea state (a real key press does); the OpenCode child is not killed if Electron is killed hard; the sound library has no composed music, so "music bed" briefs get an ambient loop.

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

