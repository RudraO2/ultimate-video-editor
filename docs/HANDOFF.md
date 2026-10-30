# Handoff

Updated 2026-10-30 (after F1). Read only "Next task" at the start of a chat. A chat does one whole plan step (Q1, Q2 and so on), never split across chats. Each chat first plans its step itself: it writes the step's lettered sub-steps (Q2a, Q2b, Q2c) in order, then starts work at once and does all of them without stopping (no plan mode, no waiting for approval). During a step, keep a short "<step> progress" note under "Next task" after each sub-step. At the end of a step, put its progress in a short "Last chunk" note here (move the previous one to `docs/handoff-archive.md`) and replace "Next task" with the next step's paste-ready prompt. History: `docs/HISTORY.md` (what each step built) and `docs/handoff-archive.md` (progress logs, old plans, notes from past chats: testing recipes, CDP driving, facts per chunk).

## Next task: step H1 (hackathon: Sarvam everywhere, one purposeful demo, the pitch)

Owner's call (2026-10-30): no new features before Ship Happens (2026-10-31). The track is "04. Culture Coded | Sarvam: Multilingual AI, voice tech, regional languages, accessibility, and technology built around culture and communities." B1 (screen recording) is deferred; its prompt is in `docs/handoff-archive.md` ▸ "B1 prompt (deferred)".

Purpose (agreed): a voice-first video studio for people who speak but do not type English. They talk to it in their own language; it cuts their footage, captions it in their script and releases it in other Indian languages in their own voice. Hearing (Saaras), the agent's model (on Sarvam's API) and the voice (Bulbul, cloning) are all Sarvam.

Checked live on 2026-10-30 (session scratchpad `f1/probe.py`):
- `POST https://api.sarvam.ai/v2/chat/completions` serves `glm5.3-flash`, the model OpenCode already uses. It accepts `Authorization: Bearer <key>` and tool calls work. (`/v1` takes only `sarvam-105b`, which spent 400 reasoning tokens to answer "ready": too slow for the agent.)
- `saaras:v4` speech to text works, including `mode: codemix` (Hinglish). Timestamps are still per phrase.
- `bulbul:v4-flash` text to speech works (default speaker; 200+ persona voices per the docs).
- Instant voice cloning (beta) works: `POST /voices/clone` (multipart: text, language_code, `ref_audio` up to 15 s and 10 MB, or a saved `voice_id` from `POST /voices/create`), answer `{audio_b64, audio_duration}`. It clones across languages. A 14-word Hindi line came back 2.7 s long: listen before relying on it.
- Batch speech to text (up to 2 h, diarization up to 20 speakers, ₹0.59 a minute) was not tried.

Paste this into a new chat:

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY these sections,
never whole files (Grep the heading for its line, then Read with offset/limit): docs/HANDOFF.md
"Next task" and "Last chunk". Search docs/HISTORY.md only when a detail is needed (S1 for Sarvam,
O1 for OpenCode, M1 for Easy mode and the chat, F1 for footage cutting).

Do ONE step only: H1, the hackathon step, whole, in this chat. Ship Happens is on 2026-10-31,
track "Culture Coded | Sarvam" (multilingual AI, voice tech, regional languages, accessibility,
technology built around culture and communities). No features beyond these. Sub-steps:
- H1a: OpenCode on Sarvam. A provider "Sarvam" in main/opencode.ts (OpenAI-compatible, base URL
  https://api.sarvam.ai/v2, model glm5.3-flash, Bearer key from main/sarvam.ts, never sent to the
  renderer). Default when a Sarvam key is set; OpenCode Zen stays as the fallback. Pick it in the
  chat options. Show the spend in the Voice tab ledger if Sarvam reports usage.
- H1b: Saaras v4 for speech to text (codemix mode for mixed speech in media_analyze and the chat
  mic; verbatim stays for cutting) and Bulbul v4 Flash voices in voices_list and generate_speech
  (speakers from the docs; v3 kept as a fallback).
- H1c: your own voice. generate_speech {voice: "clone", reference} and comp_localize {ownVoice:
  true}: a 10–15 s clean stretch of the speaker's own take (from media.footage speech spans) is the
  reference; a consent line in the tool details and the Voice tab. Check the clone's length against
  the text (the 2.7 s probe); split long lines under 1,000 characters.
- H1d: the demo, rehearsed. The owner records a real 1–2 minute Hinglish talking head. Run in Easy
  mode by voice in Hindi: cut (media_remove_pauses), captions in Devanagari, B-roll if given, a
  music bed and the sound pass, then a Tamil (or Bengali) version in the owner's own voice. Fix
  only bugs on this path. Polish the look so it reads as a real creator video (caption style, a
  lower third, the bed). Run it 3 times; time each; record one clean run as the backup video.
- H1e: the pitch. docs/pitch.md: a 3-minute talk track (one person and the problem in the first
  20 seconds, the live demo, the numbers: seconds, ₹ per video, against Sarvam Dubbing from
  docs/benchmarks/results.md ▸ S1, everything on Sarvam and Indian infrastructure, then why an
  editor with assets beats video-as-code), likely judge questions with answers, and the run sheet.
First write the lettered sub-steps under a new "Plan of H1" in docs/HANDOFF.md, then start at once
and run through every sub-step without stopping (no plan mode). Ask the owner only for the recording
in H1d. After each sub-step: tests and type checks pass, update the "H1 progress" note, commit and
push to main (owner is the only author; no AI attribution). Delegate bounded pieces to Sonnet
subagents on separate files; the main chat verifies. Main-process changes need a restart of
pnpm dev (start it with SARVAM_API_KEY set from the user environment). Then follow the end-of-step
rule at the top of docs/HANDOFF.md, update docs/PLAN.md and the Status in CLAUDE.md in one or two
lines, commit and push, and end your reply with the prompt for the next step (B1, from the archive).
```

## Last chunk: F1, footage understanding and auto-cutting (2026-10-30)

- Done as six sub-steps (plan and progress log in `docs/handoff-archive.md` ▸ "M1 last chunk, F1 plan and progress"); files and names in `docs/HISTORY.md` ▸ F1.
- Built: format 19 (`media.footage`, comp `markers`); `core/src/footage.ts` (gate, speech spans, shots, fillers per language, tighten plan, word fitting, search, B-roll placement); commands `media.analyze`, `media.remove_pauses`, `media.search`, `timeline.place_broll`, `media.footage`, `media.describe_shots`, `timeline.markers`, host tool `media_inspect`; Sarvam STT verbatim mode; Inspector ▸ Footage; markers on the ruler; skill 0.25.0 (recipe 12).
- Test: 79 s talking head (pauses, um/uh/hmm, false starts, a retake) cut to 59.3 s in 185 ms after a 3–7 s analysis; OpenCode in Easy mode with the chat example did analyse, inspect, plan, cut, two cutaways, frames check in 101 s (cut visible after about 45 s); undo restores.
- Loose ends: word times are estimates (a word can drift across a pause, so a retake cut may leave a stray word); Saaras wrote one English piece in Devanagari; long files decoded whole; no by-hand B-roll or search UI; markers do not ripple; `media_import` does not lengthen the comp.

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

