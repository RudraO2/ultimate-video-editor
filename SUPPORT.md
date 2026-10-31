# Support

## Read first

| Question | Where it is answered |
| --- | --- |
| What can this thing do? | [`README.md`](README.md) |
| How do I connect Claude Code / Codex / Cursor? | README ▸ [Drive it from an agent](README.md#drive-it-from-an-agent), or the **Agents ▸ Connect your agent** dialog in the app |
| What does a given command or tool take? | [`docs/core-api.md`](docs/core-api.md), or call `api_describe` with no arguments |
| How should an agent use the editor? | [`skill/SKILL.md`](skill/SKILL.md) and `skill/references/` |
| Can it do *X* well yet? | [`docs/benchmarks/results.md`](docs/benchmarks/results.md) — every agent run with its honest gaps |
| What is being built next? | [`docs/PLAN.md`](docs/PLAN.md) |
| How do I contribute? | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## Still stuck

[Open an issue](https://github.com/RudraO2/ultimate-video-editor/issues/new/choose). Questions are
welcome — "how do I…" is a valid issue, and a question that needed asking is usually a docs bug.

Include:

- what you were trying to make,
- what you did (the clicks, or the tool call and its reply),
- what happened instead,
- OS, GPU, Node version, and the commit you are on.

## Known limits today

- **Windows only** for screen recording — the capture helpers are Windows Graphics Capture.
- **Installers** are on the [Releases page](https://github.com/RudraO2/ultimate-video-editor/releases/latest)
  (Windows `.exe`, macOS `.dmg`, Linux `.AppImage` / `.deb`). They are **unsigned** — macOS needs
  right-click ▸ Open on the first launch, and Windows SmartScreen asks for *More info ▸ Run anyway*.
  Running from source with `pnpm dev` works too.
- **A Sarvam API key** is needed for voice, transcription, translation and localization. Without it
  the rest of the editor works normally.
- Colour grading, flipbook frames and Lottie export are not built yet.

## Security

Don't use issues for vulnerabilities — see [`SECURITY.md`](SECURITY.md).
