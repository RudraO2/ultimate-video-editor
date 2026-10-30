# Handoff

Updated 2026-10-30 (after M1). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

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

