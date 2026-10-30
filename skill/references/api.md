# The API: results, errors and patterns

## Results and errors

- Results are compact JSON. A failed call changes nothing and returns the error with a `Hint:` line that says what to do instead.
- Input errors name the field (`Unrecognized key: "fill"`, `shape.width: Too small`). Fix it and retry. `api_describe {"command": "<name>"}` shows the exact input.
- A request that is valid but cannot apply says why (`No layer "Title"`), and the hint names the alternatives.

## Reading, cheapest first

| Need | Call |
| --- | --- |
| Comps, sizes, where the user is | `doc_overview` |
| A comp's tracks and layers with times | `layers_list {compId?}` |
| One layer's data | `layer_get {id}` |
| A layer's animatable properties, values and ranges | `layer_properties {id, atMs?}` |
| The exact shape of a type or command | `api_describe {type}` or `{command}` |
| Presets | `catalog_list {catalog, query?}`, then `catalog_get {catalog, id}` |

## Batches

`api_batch {calls: [{command, input}], continueOnError?}` runs up to 50 calls in order, as one step. A string that is exactly `$N` or `$N.path` (`"$0.id"`, `"$2.tracks[0].id"`) is replaced by that part of call N's result.

```json
{ "calls": [
  { "command": "layer.create", "input": { "kind": "shape", "name": "Card", "shape": { "width": 900, "height": 260, "cornerRadius": 40, "fill": "#15151c" } } },
  { "command": "layer.create", "input": { "kind": "text", "name": "Title", "text": "New drop", "style": { "fontSize": 96, "fontWeight": 800 } } },
  { "command": "keyframes.set", "input": { "id": "$1.id", "path": "y", "keys": [ { "t": 0, "v": 60, "ease": "ease-out" }, { "t": 500, "v": 0 } ] } },
  { "command": "keyframes.set", "input": { "id": "$1.id", "path": "opacity", "keys": [ { "t": 0, "v": 0, "ease": "ease-out" }, { "t": 400, "v": 1 } ] } }
] }
```

- The batch stops at the first failure and lists what it skipped, unless `continueOnError` is true. **Read every item's `ok`**: the batch itself succeeds even when a call inside it fails.
- Batches do not nest.
- `keyframes.set` replaces a property's keys by default, so write each property's keys in one call.

## Patches (`layer_patch`)

`{id, ops: [...]}` with ops `set` (replace), `merge` (shallow-merge an object), `insert` (into a list, at `index` or the end), `remove` and `move` (to index `to`). Paths are dotted (`style.fontFamily`, `transform.x`). The whole layer is checked against the schema; nothing lands unless all of it is valid. Timing (`startMs`, `durationMs`), keys (`animations`), `id` and `kind` belong to other commands and are refused with a hint.

```json
{ "id": "Title", "ops": [ { "op": "merge", "path": "style", "value": { "fontFamily": "Archivo Black", "align": "left" } } ] }
```

## Timing rules

- `layer_create` places a layer at `startMs` (default 0). Text and shapes run to the end of the comp; media runs for its own length.
- `timeline_move`, `timeline_trim` and `timeline_split` keep a track's layers from overlapping and media inside its source.
- Key times are layer-relative. A key may sit before 0 or after the end; it still shapes the curve. To line up keys across layers that start at different times, pass `clock: "comp"` on each of them.

## Files

`media_import {localPath, place?}` takes an **absolute** path (the stdio server also resolves paths relative to your working folder). The file stays where it is; the project stores its path. With `place: {startMs?, x?, y?}` it also goes on the timeline and returns the new layer id.
