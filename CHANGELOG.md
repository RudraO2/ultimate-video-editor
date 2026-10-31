# Changelog

Notable changes to Ultimate Video Editor. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project will follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from its first release.

There is no tagged release yet — the app runs from source. For the full build log, step by step,
see [`docs/HISTORY.md`](docs/HISTORY.md); for what agents could make at each stage, see
[`docs/benchmarks/results.md`](docs/benchmarks/results.md).

One more thing worth knowing: the **project file format** is versioned separately from the app
(format 19 today). Every schema change bumps it and ships a converter, so an older `.uve` file keeps
opening.

## [0.1.0] - 2026-10-31

First packaged build. Installers for Windows, macOS and Linux are attached to the release; they are
unsigned, so macOS needs right-click ▸ Open the first time.

### Added

- Packaging with electron-builder (`pnpm dist`) and a release workflow that builds all three
  platforms on a version tag.
- Community files: contributing guide with acceptance criteria, code of conduct, security policy,
  support and privacy notes, issue and pull-request templates, CODEOWNERS, Dependabot and CI.
- The project logo and every generated icon size in `assets/` (app icons, favicons, Apple and
  maskable variants), with a generator script.
- Screen recording with auto-zoom on clicks and the framed look (phase B).
- Claude Code and Codex driving the editor over MCP through the stdio shim.
- The Cream light theme, now the default, and Phosphor icons throughout.
- Raw-footage editing: one analysis pass, then pause, filler, false-start and retake removal with a
  reason on every cut, B-roll placement and shot search.
- Easy and Advanced modes, and the in-app OpenCode chat.
- The Sarvam voice path: speech in eleven languages, own-voice cloning, transcription with word
  times, translation and whole-comp localization.
- Scripts in a QuickJS sandbox, characters that blink, breathe and talk, deterministic physics,
  the sticker library, and the sound mix with loudness matching.
- 3D worlds, the motion system, the layer and text stack, and the editor foundation with its
  command API and MCP server.

[0.1.0]: https://github.com/RudraO2/ultimate-video-editor/releases/tag/v0.1.0
