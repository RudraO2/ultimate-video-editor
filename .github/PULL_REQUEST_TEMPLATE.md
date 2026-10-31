<!--
Thanks for the PR. Keep it to one idea, and fill in what applies — delete the sections that don't.
Full guide: CONTRIBUTING.md
-->

## What this changes

<!-- One or two sentences. What can someone do after this that they couldn't before? -->

## Why

<!-- The problem behind the change. Link the issue: Fixes #123 -->

Fixes #

## How it works

<!-- The approach, and anything a reviewer would otherwise have to reverse-engineer from the diff. -->

## Screenshots or recording

<!-- Required for anything visual. A before/after pair, or a few seconds of screen recording. -->

## Checks

- [ ] `pnpm test` passes
- [ ] `pnpm typecheck` passes
- [ ] Tried in the running app (`pnpm dev`), not only in tests

**What I verified by hand**

<!-- e.g. "Trimmed a clip past the media end: it clamps, one undo step, undo restores the length." -->

## Acceptance criteria

<!-- Tick what applies to this PR. The full list is in CONTRIBUTING.md ▸ Acceptance criteria. -->

**If it changes or adds an edit**

- [ ] It goes through a command — the UI path and the tool path call the same code
- [ ] One user action, including a whole drag, is exactly one undo step
- [ ] Undo restores the previous state exactly; redo reapplies it
- [ ] A bad input changes nothing and returns `{ok: false, error, hint}` with a hint that names the fix
- [ ] Tests cover the success path and at least one failure path

**If it changes the document schema**

- [ ] Project file format bumped and a converter added in `packages/core/src/projectFile.ts`
- [ ] A project saved by the previous version opens and looks identical (test added)

**If it changes rendering, timing or sound**

- [ ] Preview and a real export agree (frames compared)
- [ ] Export loudness still lands around −16 to −14 LUFS, true peak ≤ −1 dBTP, when the comp has sound
- [ ] Still runs on an integrated GPU

**If it adds or changes an agent tool**

- [ ] `summary`, `details` and the input schema read well alone — that is all an agent sees
- [ ] Tried through a real agent (in-app OpenCode, or Claude Code / Codex over MCP)
- [ ] `skill/` updated and its `version` bumped, if agents need to know
- [ ] `docs/core-api.md` updated

**If it touches the UI**

- [ ] Colours come from theme tokens, icons from `icons.tsx`
- [ ] Checked in both the Cream and the dark theme

**Dependencies**

- [ ] No new dependency, or: it is pinned, at least two weeks old, and not GPL/AGPL (notice added to `THIRD_PARTY_NOTICES.md`)

## Anything you want a second opinion on

<!-- Reviewers will look here first. -->
