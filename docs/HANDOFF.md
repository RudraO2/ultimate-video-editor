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

### H1 progress (2026-10-30, night)

- H1a done, checked live: OpenCode's Sarvam provider (`sarvam/glm5.3-flash`, base `https://api.sarvam.ai/v2`, key in env `UVE_SARVAM_CHAT_KEY` only for OpenCode). It is the default when a Sarvam key is set and no model was picked before, and a new chat keeps the picked model. A Hindi request made a real edit in 9 s, and the footer reads "Sarvam (India)/GLM 5.3 Flash on Sarvam". The owner's saved model is now Sarvam's.
- H1b done: Saaras v4 for all speech to text (codemix for the chat mic; verbatim for footage); `BULBUL_V4_FLASH_SPEAKERS` (224, taken from the API's own error message) and `v4SpeakerFor` (a narrator of the language); `voices_list` gives `v4Voices`.
- H1c done, checked live: `generate_speech {voice: "clone", reference, referenceStartMs?}` and `comp_localize {ownVoice}`. The main process calls `POST /voices/clone` (≤ 1,000 characters, a 12 s reference picked from the take's richest speech window, cached, ₹2 per 1,000). A Hindi line in the cloned voice came back 6.8 s long; the 2.7 s probe was a shell encoding problem. Skill 0.26.0 has two lines (own voice, v4 voices).
- H1e done: `docs/pitch.md` (one line, the 3-minute talk track, numbers, judge questions, run sheet).
- H1d done (2026-10-31, the owner's 41.7 s Hinglish clip, request typed): fixed on the path (each commit pushed) the comp taking a phone clip's shape, captions and `comp_localize` over a cut talking head (all pieces, cloned voice on its own track, video muted, phrase captions remade in the same look), cloned voice pace (sent and cached), Devanagari captions for Hinglish heard as English, string flags from the model, the agent asking to read its own long tool results, caption line height and shadow; clean runs took 47 s cold and 28 s cached, ₹3.40; backup pair in `~/Videos/UVE demo/`. After a Gemini review of the backup: the cut keeps "so"/"right" where they are grammar (so much, all right, right now), and filmed speech is translated modern-colloquial ("இன்னைக்கு இவ்ளோதான்"); backup re-exported from run 11 (38 s). Left: the cloned voice's flat delivery (Sarvam's beta cloning). Not tried: the mic itself. Not built: a consent line in the Voice tab and a by-hand "my voice" button.

Paste this into a new chat (the morning of 2026-10-31):

```
Continue the Ultimate Video Editor project. CLAUDE.md is already loaded. Read ONLY docs/HANDOFF.md
"Next task" (with "H1 progress") and docs/pitch.md. H1a-c and H1e are done; do H1d only: the demo
rehearsal. Start pnpm dev with SARVAM_API_KEY set from the user environment (and
UVE_REMOTE_DEBUG_PORT=9222 so you can watch over CDP). The owner gives a real Hinglish talking-head
clip. Run the pitch's demo in Easy mode exactly as docs/pitch.md says (mic, Hindi request: cut,
Devanagari captions, a Tamil version in the owner's own voice), time each run, and fix only bugs on
this path, small and safe (the hackathon is today). After each fix: tests and type checks pass,
commit and push to main (owner is the only author). Put the real numbers into docs/pitch.md. Help
the owner export the best run as the backup video. Then update "H1 progress", PLAN.md and the
CLAUDE.md Status in one line each, commit and push.
```

## Side task T1: Cream light theme in the app (2026-10-31)

Owner approved `docs/design/theme-proposals/theme-f-cream.html` as the app's light theme ("apply this as light theme"). The dark theme stays as a choice. Sub-steps:

- T1a: theme switch (`uve.theme`, light by default, View menu ▸ Light theme / Dark theme, `html[data-theme]`), Cream tokens and the light finish (radii, 12 % tint, sentence-case headers, solid red Play and Export, red rail and tool icons) in `styles.css`.
- T1b: wire the new tokens: `accent-ink` (text on solid red), `danger`/`warn` (red-*/amber-* classes), `clip-caption` (caption clips), kind tag at 75 %, canvas colours read from CSS variables instead of hard-coded dark ones.
- T1c: Phosphor icons (MIT) in place of lucide-react, through one adapter module, both themes.
- T1d: tests, type checks, build, check light and dark in the running app, docs (README, PLAN, CLAUDE.md), push.

### T1 progress

- T1a done: `theme.ts` (`readTheme`, `applyTheme`, `cssColor`), store `theme`/`setTheme`, applied before first paint in `main.tsx`, View menu ▸ Light theme / Dark theme, Cream tokens and finish under `html[data-theme="light"]` in `styles.css`, new tokens `accent-ink`, `danger`, `warn`, `clip-caption` in both themes, `tool-palette` class on the viewport tools.
- T1b done: red-*/amber-*/emerald-* classes now `danger`/`warn`/`ok`, text on solid red `text-accent-ink`, caption layers (text with `caption`) get `clip-caption` in `TimelineClip.tsx`, kind tag `text-ink/75`, viewport selection and pen outline read `cssColor('accent')`, Keyframes and Curves take deeper curve colours in light (`LIGHT_COLORS`), selected keys and node wires use `var(--color-accent)`.
- T1c done: `@phosphor-icons/react` 2.1.10 (MIT) replaces lucide-react (removed); `icons.tsx` exports the 116 icons under their old names (`fill` set → fill weight), `IconComponent` replaces `LucideIcon`; notice in `THIRD_PARTY_NOTICES.md`. Tests (1401), type checks and build pass.

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

