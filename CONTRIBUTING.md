# Contributing to Ultimate Video Editor

Thanks for wanting to work on this. UVE is a desktop motion editor where **every edit is a command**
and **every command is automatically an agent tool over MCP**. That one rule shapes almost
everything below: a feature that only exists as a button is only half a feature here.

- [Ways to contribute](#ways-to-contribute)
- [Getting set up](#getting-set-up)
- [How the repository is laid out](#how-the-repository-is-laid-out)
- [The rules that keep the editor coherent](#the-rules-that-keep-the-editor-coherent)
- [Adding a command (and therefore an agent tool)](#adding-a-command-and-therefore-an-agent-tool)
- [Changing the document schema](#changing-the-document-schema)
- [Touching the UI](#touching-the-ui)
- [Tests](#tests)
- [Acceptance criteria — the definition of done](#acceptance-criteria--the-definition-of-done)
- [Commits and pull requests](#commits-and-pull-requests)
- [Dependencies and licences](#dependencies-and-licences)
- [Clean-room rule](#clean-room-rule)
- [Getting help](#getting-help)

## Ways to contribute

| | |
|---|---|
| **Report a bug** | [Open an issue](https://github.com/RudraO2/ultimate-video-editor/issues/new/choose). Say what you did, what you expected, what happened, and your OS + GPU. |
| **Report an agent problem** | A tool that returns a confusing error, a hint that doesn't help, a skill section that misled the agent — these matter as much as crashes. Use the *Agent / MCP tool* template and paste the call and the reply. |
| **Suggest a feature** | Describe the edit a person is trying to make and why it is hard today. Features land as both a panel and a tool, so say what the tool call would look like. |
| **Improve the skill** | `skill/` teaches agents how to make good video. Better recipes, clearer rules, a missing craft step — all welcome, and benchmarkable. |
| **Code** | Small fixes: open a PR. Anything larger: open an issue first so we can agree on the shape before you build it. |
| **Docs** | `README.md`, `docs/core-api.md`, `assets/README.md`, this file. |

## Getting set up

You need **Node.js 22.12 or newer** and **pnpm 10**.

```sh
git clone https://github.com/RudraO2/ultimate-video-editor.git
cd ultimate-video-editor
pnpm install
pnpm dev        # the Electron app, with hot reload
```

| Command | What it does |
| --- | --- |
| `pnpm dev` | Runs the desktop app in development. |
| `pnpm test` | Unit tests (Vitest). No network, seconds to run. |
| `pnpm typecheck` | Type-checks every package. |
| `pnpm build` | Builds the app into `apps/desktop/out`. |

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `SARVAM_API_KEY` | Enables the Voice tab, transcription, translation and localization. |
| `UVE_MCP_PORT` | Serve the agent API on another port (a busy port already falls back to a free one). |
| `UVE_REMOTE_DEBUG_PORT=9222` | Lets DevTools-based tools attach to the window. |
| `UVE_LOW_POWER_GPU=1` | Keep rendering on the integrated GPU. |
| `UVE_OPENCODE_PATH` | Use an existing OpenCode binary. |

Gotchas worth knowing before you lose an hour:

- Missing Electron binary after install → `pnpm rebuild electron`.
- Changes to `src/main` or new files under `skill/` need a **restart** of `pnpm dev`; changes to
  `packages/core`, `packages/engine` or `apps/desktop/src/shared` fully reload the renderer, which
  clears the in-memory project.
- A few files are CRLF (`store.ts`, `Viewport.tsx`). Edit them in place; don't run them through
  tools that rewrite line endings, or the diff becomes the whole file.
- Everything must still run on an integrated Intel GPU. Don't make a feature depend on a discrete
  card.

## How the repository is laid out

| Path | What lives there |
| --- | --- |
| `packages/core` | The document model (zod), the command registry, undo transactions, time, physics and footage rules, the script sandbox. **No DOM and no Node APIs** — it must run anywhere. |
| `packages/engine` | The renderer: Canvas2D compositor, WebGL2 card projector, three.js worlds, the audio mix, export planning. |
| `packages/mcp` | The MCP server (node `http` only) and the `uve-mcp` stdio shim. |
| `apps/desktop` | Electron 45 + React 19 + Tailwind 4. `src/main` (window, MCP relay, media grants, export files, projects, fonts, Sarvam, recorder), `src/preload` (the small typed `window.uve` bridge), `src/renderer/src` (UI, zustand store, panels). |
| `skill/` | What agents are taught — the loop, recipes, storytelling, sound, voice, review, design system. Served as MCP resources. |
| `docs/` | `PLAN.md` (roadmap), `core-api.md` (the command API), `HISTORY.md` (what each step built), `benchmarks/` (briefs, runner, results). |
| `assets/` | The logo and every generated icon size. |

## The rules that keep the editor coherent

These are not style preferences; breaking one breaks agents, undo, or both.

1. **Every edit goes through a command.** The UI calls `session.call(name, input)` or
   `session.transact(label, fn)` — the same API agents use. Never mutate the document directly from
   a component.
2. **One call or one transaction is one undo step.** A drag is one step: open a gesture with
   `beginGesture(label)` and always end it, including on pointer cancel and lost capture.
3. **A failed command leaves no trace.** Validate everything *before* the first write, then throw
   `CommandError(message, hint)`. The hint should say what to do instead — an agent will read it and
   retry from it.
4. **Schemas are strict.** `z.strictObject`, nested defaults with `.prefault({})`. Unknown fields are
   rejected so a typo is an error, not silent data loss. Merge inputs use `optionalFields` from
   `schema.ts`, never zod's `.partial()` (it drops defaults).
5. **Preview and export must agree.** Anything time-based (physics, behaviours, the mix, motion
   blur) is computed, deterministic and frame-exact — not baked in one path and approximated in the
   other.
6. **Media files are referenced, never copied.** The project stores absolute paths; the renderer
   loads them only through `mediaUrl(path)` after the main process has granted the path.
7. **Coordinates and time.** Comp space origin at the centre, +y down, +z away from the viewer. All
   times in milliseconds; keyframe `t` is relative to the layer start. Tracks are ordered front
   (index 0) to back, and layers on one track never overlap.
8. **Everything must also work by hand.** A new tool needs its panel, and a new panel needs its
   command.

## Adding a command (and therefore an agent tool)

1. Define it with `defineCommand({name, summary, details, effect, input, run})` and register it in
   `packages/core/src/commands/index.ts`. The name is dotted (`layer.set`); the MCP tool name is the
   same with underscores (`layer_set`), generated automatically.
2. Write through `ctx.write(label, draft => …)`. The label names the undo step.
3. `summary` and `details` are the agent's documentation — they become the tool description. Write
   them for someone who cannot see the screen.
4. Accept the shapes agents already send: field aliases live in `packages/core/src/compat.ts`.
5. Add tests next to the source (`myThing.test.ts`), including the failure paths and their hints.
6. If an agent should know when to use it, add it to `skill/SKILL.md` (and the right file in
   `skill/references/`), and bump the skill `version` in the front matter.
7. Document it in `docs/core-api.md` if it is part of the core API.

## Changing the document schema

Any change to the project schema **must** bump the project file format and convert older files in
`packages/core/src/projectFile.ts`. A project saved by an earlier version has to open in yours, with
the same picture. There is a test for every conversion — add yours.

## Touching the UI

- Colours come from theme tokens in `styles.css`. No hard-coded colours; canvas code reads tokens
  with `cssColor`. **Check both themes** — Cream (default) and dark.
- Icons come from `icons.tsx` (Phosphor) only.
- UI state lives in the zustand store, and selectors must return stable values (a `.filter` inside a
  selector re-renders forever).
- The viewport redraws on store changes, at most once per animation frame.
- Add a rail tab, tool or timeline tab only when the feature behind it actually works.

## Tests

```sh
pnpm test        # ~1,400 unit tests across 141 files
pnpm typecheck
```

- Tests sit next to the code they test, as `*.test.ts`.
- They run with no editor window, no network and no GPU — model, commands, motion, physics, mixing,
  loudness, export planning, world matrices, speech alignment and the MCP server all run against
  fakes. Keep it that way: a test that needs a network or a window belongs in the by-hand checklist
  of your PR instead.
- Bug fixes come with a test that fails before the fix.
- Anything with a documented numeric behaviour (loudness targets, easing, time conversion, format
  conversion) gets an exact-value test, not a snapshot.

## Acceptance criteria — the definition of done

A change is done when all of these are true. The PR template repeats them as a checklist.

**Always**

- [ ] `pnpm test` passes.
- [ ] `pnpm typecheck` passes.
- [ ] The change was tried in the running app (`pnpm dev`), not only in tests.
- [ ] No new hard-coded colours, no icons from outside `icons.tsx`, both themes checked if the UI
      changed.
- [ ] No new dependency without a reason in the PR description (see [Dependencies](#dependencies-and-licences)).

**If it changes or adds an edit**

- [ ] It goes through a command; the UI path and the tool path call the same code.
- [ ] One user action — including a whole drag — is exactly one undo step.
- [ ] Undo restores the previous state exactly; redo reapplies it.
- [ ] A failing input leaves the project untouched and returns `{ok: false, error, hint}` with a
      hint that names the fix.
- [ ] Tests cover the success path and at least one failure path.

**If it changes the schema**

- [ ] Project file format bumped, converter written in `projectFile.ts`, conversion test added.
- [ ] A project saved by the previous version opens and looks identical.

**If it changes rendering, timing or sound**

- [ ] The preview and an actual export agree (export a few seconds and compare frames).
- [ ] Export loudness still lands around −16 to −14 LUFS with true peak at or below −1 dBTP when the
      comp has sound.
- [ ] It still runs on an integrated GPU.

**If it adds or changes an agent tool**

- [ ] `summary`, `details` and the input schema read well on their own — an agent only sees those.
- [ ] Tried through a real agent (the in-app OpenCode chat, or Claude Code / Codex over MCP), not
      only by calling the function.
- [ ] `skill/` updated and its `version` bumped if agents need to know about it.
- [ ] If it changes what agents can make, consider running a benchmark brief
      (`node docs/benchmarks/run.mjs --only <n>`) and quoting the result.

**If it changes docs or the skill**

- [ ] `README.md`, `docs/core-api.md` and `skill/` agree with each other and with the code.

## Commits and pull requests

- Branch off `main`. Keep a PR to one idea; a 2,000-line PR that does five things will sit unmerged.
- Commit subjects are short and imperative, with a scope when it helps:
  `core: clamp trim to media bounds`, `docs: rewrite README`, `engine: fix mirror floor on Intel`.
  Explain *why* in the body, not *what* — the diff already says what.
- **No AI attribution in commits or PR descriptions.** No `Co-Authored-By` for an assistant, no
  "generated with" footers. If a tool helped you, that's fine; it just doesn't get a byline.
- Fill in the PR template, including the checks you ran and what you verified by hand.
- Screenshots or a short screen recording for anything visual. A before/after pair is worth a
  paragraph.
- Draft PRs are welcome early — mark them draft and say what you want feedback on.
- Review is by a maintainer (see `.github/CODEOWNERS`). Expect questions about undo behaviour, the
  tool surface and both themes; they are the usual places things break.

## Dependencies and licences

- Our code is MIT. **No GPL or AGPL** anywhere, and nothing copyleft in `packages/core`.
- Anything ported from another project keeps its notice — add it to `THIRD_PARTY_NOTICES.md` in the
  same PR.
- Pin new dependencies to an exact version that is at least two weeks old.
- `packages/core` must not pull in DOM or Node types.
- Bundled assets (sounds, stickers, icons, fonts) must be CC0, MIT or similarly free, and their
  credit must flow into the project's Credits panel.

## Clean-room rule

The notes in `docs/research/` describe AtomCut's *behaviour* in our own words. No AtomCut code,
shaders, prompts or assets are copied into this repository, and contributions must not introduce
any. Preset **data** (names, parameters, palettes) is used with attribution; the implementation is
written from observed behaviour.

## Getting help

- [Open an issue](https://github.com/RudraO2/ultimate-video-editor/issues/new/choose) — questions
  are fine, not just bugs.
- `docs/core-api.md` for the command API, `skill/SKILL.md` for how agents are meant to use it, and
  `docs/benchmarks/results.md` for what the editor can and cannot do today.
- By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
