# Core document model and command API

Package: `packages/core`. Everything that changes a project goes through this API, both from the editor UI and from agents over MCP (step A6).

## Document model

- A **project** holds comps and a media list. A media entry records a file's absolute path, kind (video, image or audio), MIME type, duration, display size (after rotation), frame rate and whether it has sound. The file itself stays where it is on disk.
- A **comp** is a timeline with its own size, frame rate, duration and background. It holds tracks, ordered front (index 0) to back.
- A **track** is a lane of layers. Layers on a track are sorted by start time and never overlap.
- A **layer** is text, shape, image, video or audio. Every layer has an id, a name, `startMs`, `durationMs`, `enabled`, `locked`, a transform and `animations`.
  - The transform has `x`, `y`, `z`, `rotation`, `rotationX`, `rotationY`, `scaleX`, `scaleY`, `anchorX`, `anchorY` and `opacity`. `x` and `y` place the pivot; `anchorX` and `anchorY` are fractions of the layer's box (0.5 the centre, 0 the left or top edge).
  - `animations` maps a property path to its keyframes.
- A **keyframe** is `{t, v, ease}`. `t` is in milliseconds, relative to the layer start. The ease shapes the move to the next key. It is `linear`, `hold`, `ease-in`, `ease-out`, `ease-in-out`, `ease-in-back`, `ease-out-back`, or a custom cubic Bézier.

Conventions:
- Comp space has its origin at the comp centre, with +y down.
- All times are milliseconds.
- `z` is depth in pixels; at `z = 0` the picture is pixel-exact.

The schemas in `src/schema.ts` and every command input are strict zod objects: unknown fields are rejected, so typos and misplaced fields are reported instead of dropped. `api.describe` returns any type as JSON Schema.

## Commands

| Command | Kind | What it does |
| --- | --- | --- |
| `doc.overview` | read | The project at a glance. Call this first. |
| `layers.list` | read | A comp's tracks and layers. |
| `layer.get` | read | One layer's full data. |
| `layer.properties` | read | Animatable properties with their values (optionally at a comp time). |
| `media.list` | read | Every media file, with the number of layers that use it. |
| `api.describe` | read | JSON Schema of a document type or a command input. |
| `comp.create`, `comp.update` | write | Make or change comps. |
| `media.add` | write | Register a media file. A file already registered with the same kind is reused (`reused: true`). |
| `media.remove` | write | Remove a media file from the project. It refuses while layers use the file, unless `deleteLayers` is true. |
| `project.update` | write | Rename the project. |
| `track.create`, `track.delete` | write | Add an empty track at a position (0 is the front), or delete an empty track. |
| `track.update` | write | Rename a track, or set `hidden` (not drawn), `muted` (not heard) or `locked` (no edits by hand; commands still apply). |
| `layer.create` | write | Make a text, shape, image, video or audio layer. Pictures larger than the comp start scaled down to fit. |
| `layer.set` | write | Set animatable properties by name (`x`, `scale`, `fill`…). Animated properties take a key at `atMs`. |
| `layer.patch` | write | Set, merge, insert, remove or move any field by path. The whole layer is re-validated. |
| `layers.delete` | write | Delete layers (a group with its members; an embedded comp with its nested layer). |
| `layers.duplicate`, `layers.copy`, `layers.restack` | write | Copy layers in place or into another comp (`toCompId`, `atMs`), or change their stacking order (`front`, `back`, `{above}`, `{below}`). |
| `layers.nest`, `layers.makeUnique` | write | Precompose layers into a nested comp (nothing moves), or give a nested layer its own copy of its comp. `layer.create {kind: "nested", sourceCompId}` shows any comp inside another. |
| `keyframes.set`, `keyframes.remove`, `keyframes.clear` | write | Write keys, remove the keys at given times, or remove all of a property's keys, in layer or comp time. |
| `timeline.move`, `timeline.trim`, `timeline.split` | write | Edit timing. These respect lanes and media bounds. |
| `timeline.close_gaps`, `timeline.compact`, `timeline.cut_ranges` | write | Ripple edits: close the gaps on lanes, drop empty lanes without changing what covers what, and take stretches of time out of a layer with the rest kept in sync. |
| `api.batch` | write | Run up to 50 calls in order. Later inputs can use `$0.id`-style references. |
| `script.run` | write | Run JavaScript (QuickJS sandbox) whose only reach is `ac.*`, every other command, plus `here` and `console`; the run is one step and a failed, timed-out or stopped run leaves no trace. `Math.random` seeded, `Date` frozen. |
| `script.save`, `script.list`, `script.read`, `script.remove` | write/read | Saved scripts in `project.scripts`; a saved script in replace mode removes what its last run made before running again. |
| `media.envelope` | write | Read a voice's loudness into its media item (what talk and nod follow). |
| `media.speech` | write | Keep what a voice take says on its media: script, language, voice, speech span and word times (format 18). |
| `timeline.insert_time` | write | Open room at a comp moment: what follows slides later, what spans it holds on (keys and caption cues after the moment slide too); the inverse of `timeline.cut_ranges`. |
| `media.footage` | write | Keep what footage holds on its media: the speech gate, speech ranges, shots with score and description (format 19; `media.analyze` writes it). |
| `media.describe_shots` | write | A one-line description per shot (`[{index, description}]`), so `media.search` finds shots by what they show. |
| `timeline.markers` | write | Review marks on a comp's ruler (`cut`, `flag`, `note`): add, remove by id, kind or all, or list (comp `markers`, format 19). |

Layers can be addressed by id or by a name that only one layer has. Tool-style names such as `layer_set` are accepted too.

The desktop app adds four commands to its session's registry (`apps/desktop/src/renderer/src/agent/commands.ts`). They change no project data:

| Command | What it does |
| --- | --- |
| `catalog.list`, `catalog.get` | The preset catalogs: `text-templates` (with a ready `layerCreate` input), `animations`, `transitions`, `easings`. |
| `session.set` | Open a comp, move the playhead, select a layer. |
| `app.console` | The editor's recent console warnings and errors. |
| `script_runs`, `script_logs`, `script_stop` | Watch and stop script runs (`session.scripts`); answered outside the command queue, so they work while a script runs. |

## Guarantees

- **One undo step.** Each `session.call` is one undo step. `session.transact(label, …)` groups several calls, such as an agent's whole request, into one named step.
- **Failures leave no trace.** A failed command leaves the project exactly as it was and returns `{ok: false, error, hint}`. The hint says what to do instead.
- **Grouped steps.** `session.call(name, input, {group, label})` joins the newest undo step when it has the same group. Agents use one group per turn (calls within 45 s of each other), so an agent's turn is one undo step named "Agent · <app>"; an edit by hand in between starts a new step. `session.undoGroup` tells whose the newest step is.
- **Ordered calls.** Calls run one at a time, in order.
- **Patch-based undo.** Undo and redo use immer patches, so history stays small even for large projects.
- **Gestures in the editor.** A drag in the timeline or on an inspector label holds one transaction open while it runs (`beginGesture` in the desktop store). Its edits show live and become one undo step.

## Media in the desktop app

- Importing reads each file with mediabunny (duration, display size, frame rate, sound, and whether this machine can decode it), then calls `media.add` and, when the file is dropped on the picture or the timeline, `layer.create`. One import is one undo step.
- The renderer loads files through `uve-media://file/<percent-encoded absolute path>`. The main process serves only exact paths the user granted, by dropping a file or picking it in the open dialog. It supports HTTP ranges, and its CORS headers keep drawn frames readable.

## Agents over MCP

- The desktop app's main process runs an MCP server (`packages/mcp`) on `http://127.0.0.1:7428/mcp` with a bearer token, and relays tool calls to the renderer, which owns the session.
- Each registry command is a tool named with `_` for `.` (`layer.set` is `layer_set`), described by its summary and details, with its input's JSON Schema.
- Tools that need the editor itself are answered outside the registry: `view_render`, `view_frames`, `history_undo` and `media_import` in the renderer (`agent/host.ts`), `uve_status` and `report_issue` in the main process (`main/agent.ts`).
- Voice and languages are desktop commands (`agent/voiceCommands.ts`, `agent/localizeCommand.ts`) calling Sarvam through the main process (`main/sarvam.ts`, key from user data or `SARVAM_API_KEY`, disk caches, a usage ledger): `voices.list`, `generate.speech`, `media.transcribe`, `text.translate`, `sarvam.usage`, `comp.localize`.
- Raw footage (`agent/footageCommands.ts`, pure rules in `core/src/footage.ts`): `media.analyze` (speech gate calibrated per file, speech ranges, Sarvam words in verbatim mode, shots from a frame-difference scene score; kept on the media), `media.remove_pauses` (the tighten plan: head and tail air, pauses with breathing room, fillers per language, false starts, retakes, reasons and flags; `dryRun`, `markers`, `variant`; one undo step through `timeline.cut_ranges`), `media.search` (words and shot descriptions, with in/out), `timeline.place_broll` (cutaways inside sentences, inset, minimum length, protected beats, relevance). Host tool `media_inspect` (`agent/footageInspect.ts`): a contact sheet of a file's own shots, with the words said in them.
- Results are compact JSON text; failures are `isError` results with the error and its hint.
