# What leaves your machine

Ultimate Video Editor is a desktop app you run yourself. There is **no account, no telemetry, no
analytics and no crash reporting**. Nobody operates a service on your behalf.

Your media files are never uploaded or copied: a project stores absolute paths and the editor reads
the files where they sit on disk.

Network calls happen only in these cases.

| When | Where it goes | What is sent |
| --- | --- | --- |
| You use a Google font, or the editor pre-fetches the fonts used by the text looks at startup | Google Fonts | The font file request. Cached on disk, so it happens once. |
| You browse or insert an icon | The Iconify API | The icon set and name. Cached on disk. |
| You speak to the chat, transcribe a clip, generate or clone a voice, translate text, or localize a comp | Sarvam AI, with **your** API key | The audio or text for that operation. Takes and translations are cached on disk, so a repeat costs nothing and sends nothing. |
| You chat with the in-app OpenCode agent | The model provider configured in the chat (by default OpenCode's own endpoint; optionally Sarvam, or another provider with your key) | Your message, the editor context it is given (which comp is open, the playhead, the selection), and the tool calls and results of that conversation. |
| An outside agent app drives the editor over MCP | Wherever *that* app sends its prompts — Anthropic, OpenAI, Google, whoever you configured | Whatever the agent app chooses to send. That is its policy, not ours. |
| You import a 3D model from an `https://` address | That address | The request for the file. |

Nothing else is contacted. The editor's own agent server listens on `127.0.0.1` only and requires a
bearer token, so it is not reachable from outside the machine.

## Where things are stored

| | |
| --- | --- |
| Projects | Wherever you save the `.uve` file |
| Recordings | `Videos\UVE recordings` (Windows) |
| MCP URL and token | `~/.uve/mcp.json` |
| Provider API keys entered in the app | Encrypted with Electron `safeStorage`, in the app's user-data folder |
| Font, icon, speech and translation caches | The app's user-data folder, and `~/uve-assets` for the bundled libraries |
| The in-app agent's config and working folder | `<user data>/opencode/` |

## Voice cloning

Instant voice cloning is meant for your own voice, with your agreement, from about 12 seconds of
your own take. Don't clone someone else's voice without their consent — and in many places, you
legally cannot.

## Your key, your bill

Sarvam and model-provider calls are billed to the key you entered. The Voice tab shows what has been
spent in the session. Remove a key any time; the editor keeps working without one, minus the
features that need it.
