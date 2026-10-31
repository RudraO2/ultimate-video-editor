# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/RudraO2/ultimate-video-editor/security/advisories/new).
It goes only to the maintainers.

Tell us what you can:

- what an attacker can do, and what they need first (a file the user opens? a page they visit? code
  already running on the machine?),
- the smallest reproduction you have — a project file, a tool call, a crafted media file,
- the version or commit, the OS, and whether the editor was running with an agent connected.

We will acknowledge a report within a few days, tell you what we think the impact is, and credit you
in the advisory unless you ask us not to.

This is a pre-1.0 project with no release channel yet: fixes land on `main`, and only `main` is
supported.

| Version | Supported |
| --- | --- |
| `main` | ✅ |
| Anything else | ❌ |

## What this app actually exposes

Useful context if you are looking for something to break.

- **The agent server.** While the editor is open it serves MCP on `http://127.0.0.1:7428/mcp`
  (`UVE_MCP_PORT` to change it). It binds to loopback only and every request needs the bearer token
  written to `~/.uve/mcp.json`. Anything that lets a remote origin, another user on the machine, or
  a page in a browser reach it — or that leaks the token — is a vulnerability.
- **Agent tools are real edits.** A connected agent can create layers, import media by path, run
  scripts, export files and save projects. The interesting question is whether a tool can be made to
  touch a path, a file or a process outside what the user granted.
- **File grants.** The renderer can only load media through `uve-media://` for paths the main
  process has granted, because the user dropped the file or picked it in a dialog. A path traversal,
  a grant that is wider than the file, or a way to make the main process grant a path on its own is
  a vulnerability.
- **The script sandbox.** `script_run` executes JavaScript in QuickJS with no files, no network and
  no timers, with seeded `Math.random` and a frozen `Date`, reaching only `ac.*` commands. Any
  escape — host objects, the real clock, I/O, unbounded time or memory — is a vulnerability.
- **The in-app OpenCode agent.** It runs with video-only permissions: editor tools, reading files
  and the web are free, it cannot edit files, and the shell is limited to media commands
  (`ffprobe`, `ffmpeg`, listing, copying and moving files, making folders), asking first for
  anything else. A way around those limits is a vulnerability.
- **Secrets.** Provider keys entered in the app are stored with Electron `safeStorage`. The Sarvam
  key may also come from the `SARVAM_API_KEY` environment variable. A key that ends up in a log, a
  project file, a crash report or an exported file is a vulnerability.
- **Untrusted input.** Project files (`.uve`), imported media, glTF/GLB/OBJ/STL/PLY models, SVG and
  font files are all parsed by the app. Treat them as attacker-controlled.
- **Network calls.** Google Fonts and the Iconify API (cached to disk), Sarvam for speech and
  translation, and whatever model provider the in-app agent is configured with. Nothing else should
  leave the machine.

## Out of scope

- Anything that requires the attacker to already run code as the user.
- Reports that depend on the user deliberately connecting a malicious agent and approving its
  actions.
- Missing hardening with no exploit path (we still want to hear about it — open a normal issue).
- Vulnerabilities in third-party dependencies with no exploit path through this app; report those
  upstream, and tell us so we can pin a fixed version.
